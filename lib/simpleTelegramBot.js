import { EventEmitter } from 'node:events';
import { Blob } from 'buffer';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

function toJSON(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'object' && value !== null && 'toJSON' in value) {
    return value.toJSON();
  }
  return value;
}

const isReadable = (value) => value && typeof value === 'object' && typeof value.pipe === 'function';

function buildFormData(payload) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (Buffer.isBuffer(value)) {
      formData.append(key, new Blob([value]), `${key}.bin`);
      continue;
    }
    if (value instanceof Blob) {
      formData.append(key, value, `${key}.bin`);
      continue;
    }
    if (typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, 'value') && value.value != null) {
        const fileValue = value.value;
        const fileName = value.filename || `${key}.bin`;
        const contentType = value.contentType;
        if (Buffer.isBuffer(fileValue)) {
          const blob = contentType
            ? new Blob([fileValue], { type: contentType })
            : new Blob([fileValue]);
          formData.append(key, blob, fileName);
          continue;
        }
        if (fileValue instanceof Blob) {
          formData.append(key, fileValue, fileName);
          continue;
        }
        if (isReadable(fileValue)) {
          formData.append(key, fileValue, fileName);
          continue;
        }
      }
      if (Object.prototype.hasOwnProperty.call(value, 'source') && value.source != null) {
        const sourceValue = value.source;
        const fileName = value.filename || `${key}.bin`;
        if (Buffer.isBuffer(sourceValue)) {
          formData.append(key, new Blob([sourceValue]), fileName);
          continue;
        }
        if (isReadable(sourceValue)) {
          formData.append(key, sourceValue, fileName);
          continue;
        }
      }
      formData.append(key, JSON.stringify(value));
      continue;
    }
    formData.append(key, value);
  }
  return formData;
}

export default class SimpleTelegramBot extends EventEmitter {
  constructor(token, options = {}) {
    super();
    if (!token) {
      throw new Error('Telegram token is required');
    }
    this.token = token;
    this.options = options;
    this.textHandlers = [];
    this.apiBase = options.apiBase || `https://api.telegram.org/bot${token}`;
    const fetchImpl = options.httpFetch || globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('Fetch implementation is required for SimpleTelegramBot');
    }
    this._fetch = (...args) => fetchImpl(...args);
    this._isPolling = false;
    this._offset = 0;
    this._pollingPromise = null;
    this._pollingController = null;
    this._pollingInterval = Math.max(0, Number(options.polling?.interval ?? 0));
    this._pollingTimeout = Math.max(0, Number(options.polling?.timeout ?? 30));
    this._dropPendingUpdates = options.polling?.dropPendingUpdates ?? true;
    this._allowedUpdates = options.polling?.allowedUpdates;

    if (options.polling) {
      this.startPolling().catch((error) => {
        this.emit('polling_error', error);
        console.error('Failed to start SimpleTelegramBot polling:', error);
      });
    }
  }

  onText(regexp, callback) {
    if (!(regexp instanceof RegExp)) {
      throw new TypeError('regexp must be an instance of RegExp');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('callback must be a function');
    }
    this.textHandlers.push({ regexp, callback });
  }

  async startPolling() {
    if (this._isPolling) {
      return this._pollingPromise;
    }
    this._isPolling = true;
    this._pollingPromise = this._pollingLoop();
    return this._pollingPromise;
  }

  async stopPolling() {
    this._isPolling = false;
    if (this._pollingController) {
      this._pollingController.abort();
      this._pollingController = null;
    }
    if (this._pollingPromise) {
      try {
        await this._pollingPromise;
      } catch (error) {
        // ignore errors caused by aborting the request
        if (error.name !== 'AbortError') {
          throw error;
        }
      } finally {
        this._pollingPromise = null;
      }
    }
  }

  async setMyCommands(commands) {
    return this._call('setMyCommands', { commands });
  }

  sendMessage(chatId, text, options = {}) {
    return this._call('sendMessage', { chat_id: chatId, text, ...options });
  }

  sendPhoto(chatId, photo, options = {}) {
    const payload = { chat_id: chatId, ...options };
    if (Buffer.isBuffer(photo)) {
      payload.photo = photo;
      return this._call('sendPhoto', payload, { useFormData: true });
    }
    return this._call('sendPhoto', { ...payload, photo });
  }

  async sendDocument(chatId, document, options = {}, fileOptions = {}) {
    const payload = { chat_id: chatId, ...options };

    const toFilePayload = async (input, fallbackName) => {
      if (Buffer.isBuffer(input)) {
        return {
          value: input,
          filename: fileOptions.filename || fallbackName,
          contentType: fileOptions.contentType
        };
      }
      if (typeof input === 'string') {
        const buffer = await fsPromises.readFile(input);
        return {
          value: buffer,
          filename: fileOptions.filename || path.basename(input) || fallbackName,
          contentType: fileOptions.contentType
        };
      }
      if (input instanceof Blob || isReadable(input)) {
        return {
          value: input,
          filename: fileOptions.filename || fallbackName,
          contentType: fileOptions.contentType
        };
      }
      if (input && typeof input === 'object') {
        if (Object.prototype.hasOwnProperty.call(input, 'source')) {
          const source = input.source;
          const fileName = input.filename || fallbackName;
          if (typeof source === 'string') {
            const buffer = await fsPromises.readFile(source);
            return {
              value: buffer,
              filename: fileOptions.filename || fileName || path.basename(source) || fallbackName,
              contentType: input.contentType || fileOptions.contentType
            };
          }
          if (Buffer.isBuffer(source) || source instanceof Blob || isReadable(source)) {
            return {
              value: source,
              filename: fileOptions.filename || fileName,
              contentType: input.contentType || fileOptions.contentType
            };
          }
        }
        if (Object.prototype.hasOwnProperty.call(input, 'value')) {
          const result = { ...input };
          if (!result.filename && fileOptions.filename) {
            result.filename = fileOptions.filename;
          }
          if (!result.contentType && fileOptions.contentType) {
            result.contentType = fileOptions.contentType;
          }
          return result;
        }
      }
      return null;
    };

    const fallbackName = 'document';
    const prepared = await toFilePayload(document, fallbackName);
    if (prepared) {
      payload.document = prepared;
      return this._call('sendDocument', payload, { useFormData: true });
    }

    return this._call('sendDocument', { ...payload, document });
  }

  editMessageText(text, options = {}) {
    return this._call('editMessageText', { text, ...options });
  }

  editMessageCaption(caption, options = {}) {
    return this._call('editMessageCaption', { caption, ...options });
  }

  editMessageReplyMarkup(markup, options = {}) {
    return this._call('editMessageReplyMarkup', { reply_markup: markup, ...options });
  }

  deleteMessage(chatId, messageId, options = {}) {
    return this._call('deleteMessage', { chat_id: chatId, message_id: messageId, ...options });
  }

  answerCallbackQuery(callbackQueryId, options = {}) {
    return this._call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...options });
  }

  answerPreCheckoutQuery(preCheckoutQueryId, ok, options = {}) {
    if (typeof ok === 'object') {
      return this._call('answerPreCheckoutQuery', { pre_checkout_query_id: preCheckoutQueryId, ...ok });
    }
    return this._call('answerPreCheckoutQuery', {
      pre_checkout_query_id: preCheckoutQueryId,
      ok,
      ...options
    });
  }

  sendInvoice(
    chatId,
    title,
    description,
    payload,
    providerToken,
    startParameter,
    currency,
    prices,
    options = {}
  ) {
    return this._call('sendInvoice', {
      chat_id: chatId,
      title,
      description,
      payload,
      provider_token: providerToken,
      start_parameter: startParameter,
      currency,
      prices,
      ...options
    });
  }

  getChatMember(chatId, userId) {
    return this._call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  _processTextHandlers(msg) {
    const text = msg && msg.text;
    if (typeof text !== 'string') return;
    for (const handler of this.textHandlers) {
      const match = handler.regexp.exec(text);
      if (match) {
        try {
          handler.callback(msg, match);
        } catch (error) {
          console.error('Error in SimpleTelegramBot onText handler:', error);
        }
      }
      handler.regexp.lastIndex = 0;
    }
  }

  async _pollingLoop() {
    if (this._dropPendingUpdates) {
      try {
        await this._discardPendingUpdates();
      } catch (error) {
        this.emit('polling_error', error);
      }
    }
    while (this._isPolling) {
      try {
        const updates = await this._getUpdates();
        for (const update of updates) {
          this._handleUpdate(update);
          this._offset = update.update_id + 1;
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          break;
        }
        this.emit('polling_error', error);
        await this._sleep(1000);
      }
      if (this._pollingInterval > 0) {
        await this._sleep(this._pollingInterval);
      }
    }
  }

  async _discardPendingUpdates() {
    const updates = await this._call('getUpdates', { offset: -1, limit: 1, timeout: 0 });
    if (Array.isArray(updates) && updates.length > 0) {
      this._offset = updates[updates.length - 1].update_id + 1;
    }
  }

  async _getUpdates() {
    const payload = {
      offset: this._offset,
      timeout: this._pollingTimeout,
      allowed_updates: this._allowedUpdates
    };
    this._pollingController = new AbortController();
    try {
      return await this._call('getUpdates', payload, {
        signal: this._pollingController.signal
      });
    } finally {
      this._pollingController = null;
    }
  }

  async _call(method, payload = {}, options = {}) {
    const url = `${this.apiBase}/${method}`;
    const { useFormData = false, signal } = options;
    let fetchOptions;
    if (useFormData) {
      const formData = buildFormData(payload);
      fetchOptions = { method: 'POST', body: formData, signal };
    } else {
      const sanitized = {};
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined) {
          sanitized[key] = toJSON(value);
        }
      }
      fetchOptions = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sanitized),
        signal
      };
    }
    const response = await this._fetch(url, fetchOptions);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Telegram API HTTP error ${response.status}: ${text}`);
    }
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.description || 'Telegram API responded with an error');
    }
    return data.result;
  }

  _handleUpdate(update) {
    if (!update || typeof update !== 'object') return;
    if (update.message) {
      this.emit('message', update.message);
      this._processTextHandlers(update.message);
    }
    if (update.edited_message) {
      this.emit('edited_message', update.edited_message);
    }
    if (update.callback_query) {
      this.emit('callback_query', update.callback_query);
    }
    if (update.pre_checkout_query) {
      this.emit('pre_checkout_query', update.pre_checkout_query);
    }
    if (update.shipping_query) {
      this.emit('shipping_query', update.shipping_query);
    }
    if (update.my_chat_member) {
      this.emit('my_chat_member', update.my_chat_member);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
