import { EventEmitter } from 'node:events';
import { optionalImport } from './optionalImport.js';

let GrammyBotClass = null;
let grammyLoadError = null;

const { module: grammyModule, error: grammyError } = await optionalImport('grammy');
if (grammyModule) {
  const maybeBot =
    grammyModule?.Bot ||
    grammyModule?.default?.Bot ||
    (typeof grammyModule?.default === 'function' ? grammyModule.default : null);
  if (typeof maybeBot === 'function') {
    GrammyBotClass = maybeBot;
  } else {
    grammyLoadError = new Error('Grammy module did not export a Bot constructor.');
  }
} else if (grammyError) {
  grammyLoadError = grammyError;
}

export function isGrammyAvailable() {
  return Boolean(GrammyBotClass);
}

export function getGrammyLoadError() {
  return grammyLoadError;
}

export default class TelegramBotCompat extends EventEmitter {
  constructor(token, options = {}) {
    super();
    if (!token) {
      throw new Error('Telegram token is required');
    }
    if (!GrammyBotClass) {
      throw new Error('Grammy Bot is not available.');
    }
    this.token = token;
    this.options = options;
    this.textHandlers = [];
    this.bot = new GrammyBotClass(token, options.grammyOptions || {});
    this.bot.catch((err) => {
      this.emit('polling_error', err);
      console.error('Grammy error:', err);
    });
    this._bindEvents();

    if (options.polling) {
      this.startPolling().catch((err) => {
        console.error('Failed to start polling via grammy compatibility layer:', err);
      });
    }
  }

  _bindEvents() {
    this.bot.on('message', (ctx) => {
      const msg = ctx.update.message;
      if (!msg) return;
      this.emit('message', msg);
      this._processTextHandlers(msg);
    });

    this.bot.on('callback_query', (ctx) => {
      const query = ctx.update.callback_query;
      if (!query) return;
      this.emit('callback_query', query);
    });

    this.bot.on('pre_checkout_query', (ctx) => {
      const query = ctx.update.pre_checkout_query;
      if (!query) return;
      this.emit('pre_checkout_query', query);
    });
  }

  _processTextHandlers(msg) {
    const text = msg && msg.text;
    if (typeof text !== 'string') return;
    for (const handler of this.textHandlers) {
      const { regexp, callback } = handler;
      const match = regexp.exec(text);
      if (match) {
        try {
          callback(msg, match);
        } catch (err) {
          console.error('Error in onText handler:', err);
        }
      }
      regexp.lastIndex = 0;
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
    if (this._pollingPromise) return this._pollingPromise;
    const dropPending = (() => {
      if (
        this.options &&
        typeof this.options.polling === 'object' &&
        this.options.polling !== null &&
        Object.prototype.hasOwnProperty.call(this.options.polling, 'dropPendingUpdates')
      ) {
        return this.options.polling.dropPendingUpdates;
      }
      if (Object.prototype.hasOwnProperty.call(this.options || {}, 'dropPendingUpdates')) {
        return this.options.dropPendingUpdates;
      }
      return true;
    })();
    const startOptions = {};
    if (dropPending !== undefined) {
      startOptions.drop_pending_updates = dropPending;
    }
    this._pollingPromise = this.bot
      .start(startOptions)
      .catch((err) => {
        this._pollingPromise = null;
        throw err;
      });
    await this._pollingPromise;
  }

  async stopPolling() {
    if (!this._pollingPromise) return;
    await this.bot.stop();
    this._pollingPromise = null;
  }

  removeAllListeners(event) {
    super.removeAllListeners(event);
    if (!event) {
      this.textHandlers = [];
    }
  }

  setMyCommands(commands) {
    return this.bot.api.setMyCommands(commands);
  }

  sendMessage(chatId, text, options = {}) {
    return this.bot.api.sendMessage(chatId, text, options);
  }

  sendPhoto(chatId, photo, options = {}) {
    return this.bot.api.sendPhoto(chatId, photo, options);
  }

  editMessageText(text, options = {}) {
    return this.bot.api.editMessageText(text, options);
  }

  editMessageCaption(caption, options = {}) {
    return this.bot.api.editMessageCaption(caption, options);
  }

  editMessageReplyMarkup(markup, options = {}) {
    return this.bot.api.editMessageReplyMarkup(markup, options);
  }

  deleteMessage(chatId, messageId, options = {}) {
    return this.bot.api.deleteMessage(chatId, messageId, options);
  }

  answerCallbackQuery(callbackQueryId, options = {}) {
    return this.bot.api.answerCallbackQuery(callbackQueryId, options);
  }

  answerPreCheckoutQuery(preCheckoutQueryId, ok, options = {}) {
    if (typeof ok === 'object') {
      return this.bot.api.answerPreCheckoutQuery(preCheckoutQueryId, ok);
    }
    return this.bot.api.answerPreCheckoutQuery(preCheckoutQueryId, ok, options);
  }

  sendInvoice(chatId, title, description, payload, providerToken, startParameter, currency, prices, options = {}) {
    return this.bot.api.sendInvoice(chatId, title, description, payload, providerToken, startParameter, currency, prices, options);
  }

  getChatMember(chatId, userId) {
    return this.bot.api.getChatMember(chatId, userId);
  }
}

export class TelegramBotNoop extends EventEmitter {
  constructor(token, options = {}) {
    super();
    this.token = token;
    this.options = options;
    this.textHandlers = [];
    this._warn('Telegram functionality is disabled because no bot backend is available.');
  }

  _warn(message) {
    console.warn(`[TelegramBotNoop] ${message}`);
  }

  onText(regexp, callback) {
    if (regexp instanceof RegExp && typeof callback === 'function') {
      this.textHandlers.push({ regexp, callback });
    }
    this._warn('onText called but will not receive updates.');
  }

  _resolve(value) {
    return Promise.resolve(value);
  }

  startPolling() {
    this._warn('startPolling called but no polling will occur.');
    return this._resolve();
  }

  stopPolling() {
    this._warn('stopPolling called but no polling was active.');
    return this._resolve();
  }

  setMyCommands() {
    this._warn('setMyCommands is unavailable.');
    return this._resolve();
  }

  sendMessage() {
    this._warn('sendMessage is unavailable.');
    return this._resolve(null);
  }

  sendPhoto() {
    this._warn('sendPhoto is unavailable.');
    return this._resolve(null);
  }

  editMessageText() {
    this._warn('editMessageText is unavailable.');
    return this._resolve(null);
  }

  editMessageCaption() {
    this._warn('editMessageCaption is unavailable.');
    return this._resolve(null);
  }

  editMessageReplyMarkup() {
    this._warn('editMessageReplyMarkup is unavailable.');
    return this._resolve(null);
  }

  deleteMessage() {
    this._warn('deleteMessage is unavailable.');
    return this._resolve(false);
  }

  answerCallbackQuery() {
    this._warn('answerCallbackQuery is unavailable.');
    return this._resolve();
  }

  answerPreCheckoutQuery() {
    this._warn('answerPreCheckoutQuery is unavailable.');
    return this._resolve();
  }

  sendInvoice() {
    this._warn('sendInvoice is unavailable.');
    return this._resolve();
  }

  getChatMember() {
    this._warn('getChatMember is unavailable.');
    return this._resolve(null);
  }
}
