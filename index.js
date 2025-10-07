import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import { exec } from 'child_process';

import { ensureEnvConfig } from './lib/env.js';
import { optionalImport } from './lib/optionalImport.js';

const envLoadResult = await ensureEnvConfig();
if (envLoadResult?.source === 'fallback' && envLoadResult.loaded) {
  console.info('Loaded environment variables using built-in parser.');
}

let sharp;
let JimpLib;
let composePngBuffers;
{
  const { module: sharpModule, error: sharpError } = await optionalImport('sharp');
  if (sharpModule) {
    sharp = sharpModule?.default || sharpModule;
  } else if (sharpError) {
    console.warn('sharp package not found; inventory image generation will be skipped.');
    sharp = null;
  }
}

if (!sharp) {
  try {
    const { module: jimpModule } = await optionalImport('jimp');
    if (jimpModule) {
      JimpLib = jimpModule?.default || jimpModule?.Jimp || jimpModule;
      if (JimpLib) {
        console.info('Using jimp for inventory image composition.');
      }
    }
  } catch (jimpError) {
    console.warn('Failed to load jimp fallback for inventory image composition:', jimpError);
  }
}

if (!sharp && !JimpLib) {
  try {
    const pngComposerModule = await import('./lib/pngComposer.js');
    const isAvailable = pngComposerModule?.isPngComposerAvailable?.();
    composePngBuffers = pngComposerModule?.composePngBuffers;
    if (composePngBuffers && isAvailable) {
      const implementation = pngComposerModule?.getPngComposerImplementation?.();
      if (implementation === 'pngjs') {
        console.info('Using pngjs fallback for inventory image composition.');
      } else if (implementation === 'builtin-simple') {
        console.info('Using built-in PNG compositor for inventory image composition.');
      } else {
        console.info('Using PNG fallback for inventory image composition.');
      }
    } else {
      const reason = pngComposerModule?.getPngComposerLoadError?.();
      if (reason) {
        const message = reason?.message || String(reason);
        console.warn(
          `pngjs is unavailable (${message}); inventory image generation will be skipped.`
        );
      } else if (isAvailable === false) {
        console.warn('pngjs fallback is unavailable; inventory image generation will be skipped.');
      } else {
        console.warn('pngjs fallback could not be initialized; inventory image generation will be skipped.');
      }
    }
  } catch (pngComposerError) {
    console.warn('Failed to load pngjs fallback for inventory image composition:', pngComposerError);
  }
}

let fetchImpl = globalThis.fetch;
if (!fetchImpl) {
  const { module: fetchModule, error: fetchError } = await optionalImport('node-fetch');
  if (fetchModule) {
    fetchImpl = fetchModule?.default || fetchModule;
  } else if (fetchError) {
    console.warn('Neither global fetch nor node-fetch are available; remote requests will fail.');
  }
}
const fetch = fetchImpl
  ? (...args) => fetchImpl(...args)
  : async () => {
      throw new Error('Fetch API is unavailable.');
    };

let TelegramBotCtorCache;

async function loadTelegramBotCtor() {
  if (TelegramBotCtorCache) return TelegramBotCtorCache;
  const { module: telegramModule, error: telegramError } = await optionalImport('node-telegram-bot-api');
  if (telegramModule) {
    TelegramBotCtorCache = telegramModule?.default || telegramModule;
    return TelegramBotCtorCache;
  }

  if (telegramError) {
    console.warn(
      "node-telegram-bot-api not found; falling back to grammy compatibility layer."
    );
  }

  const compatModule = await import('./lib/telegramBotCompat.js');
  if (compatModule?.isGrammyAvailable?.()) {
    TelegramBotCtorCache = compatModule?.default || compatModule.TelegramBotCompat;
    return TelegramBotCtorCache;
  }

  const reason = compatModule?.getGrammyLoadError?.();
  if (reason) {
    console.warn(
      `grammy is unavailable (${reason.message || reason}); using built-in HTTP Telegram client.`
    );
  } else {
    console.warn('grammy is unavailable; using built-in HTTP Telegram client.');
  }

  try {
    const simpleModule = await import('./lib/simpleTelegramBot.js');
    const SimpleTelegramBot = simpleModule?.default;
    if (SimpleTelegramBot) {
      TelegramBotCtorCache = SimpleTelegramBot;
      return TelegramBotCtorCache;
    }
  } catch (simpleError) {
    console.error('Failed to load built-in Telegram client:', simpleError);
  }

  const NoopBotCtor = compatModule?.TelegramBotNoop;
  if (NoopBotCtor) {
    console.warn('Falling back to no-op Telegram bot implementation.');
    TelegramBotCtorCache = NoopBotCtor;
  } else {
    throw new Error('No Telegram bot implementation available.');
  }
  return TelegramBotCtorCache;
}

const TelegramBot = await loadTelegramBotCtor();

import {
  armorItems,
  weaponItems,
  helmetItems,
  mutationItems,
  extraItems,
  signItems,
  getItemImageMap,
  getAllItemDefinitions,
  normalizeItemName,
  CASE_TYPES,
  getCaseItems
} from './lib/items.js';

import pool, { initializeDatabase } from './lib/db.js';
const DB_DIALECT = pool && pool.dialect ? pool.dialect : 'memory';
const DB_LABEL =
  DB_DIALECT === 'postgres'
    ? 'PostgreSQL'
    : DB_DIALECT === 'mysql'
      ? 'MySQL'
      : DB_DIALECT === 'sqlite'
        ? 'SQLite'
        : 'in-memory storage';

let databaseInitialized = false;
try {
  databaseInitialized = await initializeDatabase();
  if (databaseInitialized) {
    console.info(`${DB_LABEL}: таблицы состояния инициализированы.`);
  }
} catch (dbInitErr) {
  console.error('Ошибка инициализации базы данных:', dbInitErr);
}

// --- Очистка таблиц состояния ---
export async function clearBotStateTable() {
  const tables = ['bot_state', 'players', 'clans', 'clan_battles', 'clan_invites'];
  for (const table of tables) {
    try {
      await pool.execute(`DELETE FROM ${table}`);
    } catch (err) {
      if (!/no such table/i.test(String(err.message))) {
        console.error(`Не удалось очистить таблицу ${table}:`, err);
      }
    }
  }
  console.log('Все таблицы состояния очищены.');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.TELEGRAM_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN;
const DONATION_CONTACT =
  typeof process !== 'undefined' && process.env?.DONATION_CONTACT
    ? process.env.DONATION_CONTACT
    : '@imfromcrimecorebitches';

const ITEM_IMAGE_MAP = getItemImageMap();
const ITEM_DEFINITIONS_BY_KIND = getAllItemDefinitions();

const ITEM_RARITY_LOOKUP_BY_KIND = new Map();
const ITEM_RARITY_LOOKUP_BY_NAME = new Map();
const ITEM_RARITY_LABEL_TO_KEY = new Map([
  ['крайне редкое', 'very_rare'],
  ['редкое', 'rare'],
  ['обычная редкость', 'common'],
  ['легендарная редкость', 'legendary']
]);

for (const [kind, definitions] of Object.entries(ITEM_DEFINITIONS_BY_KIND)) {
  for (const def of definitions) {
    if (!def || !def.name) continue;
    const normalized = normalizeItemName(def.name);
    const rarityMeta = {
      label: def.rarity || null,
      key: def.rarityKey || null
    };
    ITEM_RARITY_LOOKUP_BY_KIND.set(`${kind}:${normalized}`, rarityMeta);
    if (!ITEM_RARITY_LOOKUP_BY_NAME.has(normalized)) {
      ITEM_RARITY_LOOKUP_BY_NAME.set(normalized, rarityMeta);
    }
    if (rarityMeta?.label && rarityMeta?.key) {
      const labelKey = rarityMeta.label.trim().toLowerCase();
      if (labelKey && !ITEM_RARITY_LABEL_TO_KEY.has(labelKey)) {
        ITEM_RARITY_LABEL_TO_KEY.set(labelKey, rarityMeta.key);
      }
    }
  }
}

const ITEM_RARITY_EMOJI = {
  very_rare: '💠',
  rare: '🔷',
  common: '⚪️',
  legendary: '⚜️'
};

const ITEM_KIND_LABELS = {
  armor: "броня",
  weapon: "оружие",
  extra: "доп предмет",
  helmet: "шлем",
  mutation: "мутация",
  sign: "знак"
};

function getItemKindLabel(kind) {
  if (!kind) return null;
  return ITEM_KIND_LABELS[String(kind)] || null;
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function buildItemTypeText(item) {
  if (!item) return "";
  const kindLabel = getItemKindLabel(item.kind);
  return kindLabel ? `\n🏷 Тип предмета: ${kindLabel}.` : "";
}

function resolveItemRarity(item) {
  if (!item) return null;
  const label = item.rarity || null;
  const key = item.rarityKey || null;
  if (label) {
    return { label, key };
  }

  if (!item.name) return null;
  const normalizedName = normalizeItemName(item.name);

  if (item.kind) {
    const lookupKey = `${item.kind}:${normalizedName}`;
    if (ITEM_RARITY_LOOKUP_BY_KIND.has(lookupKey)) {
      return ITEM_RARITY_LOOKUP_BY_KIND.get(lookupKey);
    }
  }

  if (ITEM_RARITY_LOOKUP_BY_NAME.has(normalizedName)) {
    return ITEM_RARITY_LOOKUP_BY_NAME.get(normalizedName);
  }

  return null;
}

function buildItemRarityText(item) {
  const rarity = resolveItemRarity(item);
  if (!rarity || !rarity.label) return "";
  const emoji = rarity.key ? ITEM_RARITY_EMOJI[rarity.key] || '⭐️' : '⭐️';
  return `\n${emoji} Редкость: ${rarity.label}.`;
}

function getSignTemplateByName(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  return signItems.find((it) => String(it.name).toLowerCase() === lower) || null;
}

function getSignEffects(sign) {
  if (!sign) {
    return {
      name: null,
      vampirism: 0,
      dodgeChance: 0,
      preventLethal: null,
      extraTurn: false,
      fullHeal: false
    };
  }
  const template = getSignTemplateByName(sign.name);
  const merged = { ...template, ...sign };
  return {
    name: merged?.name || null,
    vampirism: merged?.vampirism || 0,
    dodgeChance: merged?.dodgeChance || 0,
    preventLethal: merged?.preventLethal || null,
    extraTurn: Boolean(merged?.extraTurn),
    fullHeal: Boolean(merged?.fullHeal)
  };
}

function describeSignEffect(sign) {
  if (!sign) return "—";
  const effects = getSignEffects(sign);
  if (!effects) return "—";
  if (effects.preventLethal === "final" && effects.fullHeal) {
    return "при смертельном ударе восстанавливает все HP (1 раз)";
  }
  if (effects.preventLethal === "radiation") {
    return "спасает от летального удара и даёт дополнительный ход (1 раз)";
  }
  if (effects.dodgeChance > 0) {
    return `${Math.round(effects.dodgeChance * 100)}% шанс увернуться`;
  }
  if (effects.vampirism > 0) {
    return `+${Math.round(effects.vampirism * 100)}% к вампиризму`;
  }
  return "—";
}

function formatItemRewardMessage(item) {
  if (!item) return "";
  let text = `🎉 *Поздравляем!* Вы получили: *${escMd(item.name)}*.`;
  text += buildItemTypeText(item);
  text += buildItemRarityText(item);
  if (item.kind === "sign") {
    text += `\n✨ Эффект: ${describeSignEffect(item)}`;
  }
  return text;
}

function formatDropSummary(item) {
  if (!item) return "";
  let text = `🎁 Выпало: ${item.name}`;
  text += buildItemTypeText(item);
  text += buildItemRarityText(item);
  if (item.kind === "sign") {
    text += `\n✨ Эффект: ${describeSignEffect(item)}`;
  }
  return text;
}

async function generateInventoryImage(player) {
  try {
    const baseUrl = (player && player.baseUrl) || 'https://i.postimg.cc/RZbFRZzj/2.png';
    const layers = [];

    const resBase = await fetch(baseUrl);
    if (!resBase.ok) throw new Error(`Ошибка загрузки фона`);
    const baseBuf = await resBase.arrayBuffer();
    const baseBuffer = Buffer.from(baseBuf);

    const order = ["mutation", "armor", "weapon", "helmet", "extra", "sign"];
    const layerBuffers = [];
    for (const key of order) {
      const item = player && player.inventory ? player.inventory[key] : null;
      if (!item || !item.name) continue;
      const url = ITEM_IMAGE_MAP[normalizeItemName(item.name)];
      if (!url) {
        console.warn(`Нет картинки для ${item ? item.name : key}`);
        continue;
      }
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Ошибка загрузки ${url}`);
        const buf = await res.arrayBuffer();
        const layerBuffer = Buffer.from(buf);
        layers.push({ input: layerBuffer });
        layerBuffers.push(layerBuffer);
      } catch (e) {
        console.warn(`Слой ${item.name} пропущен: ${e.message}`);
        continue;
      }
    }

    if (sharp) {
      const out = await sharp(baseBuffer).composite(layers).png().toBuffer();
      return out;
    }

    if (JimpLib) {
      const baseImage = await JimpLib.read(baseBuffer);
      for (const layerBuffer of layerBuffers) {
        const overlay = await JimpLib.read(layerBuffer);
        baseImage.composite(overlay, 0, 0);
      }
      const out = await baseImage.getBufferAsync(JimpLib.MIME_PNG);
      return out;
    }

    if (composePngBuffers) {
      try {
        const out = composePngBuffers(baseBuffer, layerBuffers);
        return out;
      } catch (pngComposeError) {
        console.warn('pngjs composition failed:', pngComposeError);
      }
    }

    console.warn('No image compositor available; returning null inventory image.');
    return null;
  } catch (err) {
    console.error('Ошибка генерации инвентаря:', err);
    return null;
  }
}


let bot; // глобальная переменная для TelegramBot

const KEEPALIVE_BASE_TARGETS = [
  process.env.KEEPALIVE_URL,
  process.env.RENDER_EXTERNAL_URL,
  process.env.PING_URL,
  process.env.KEEPALIVE_SECONDARY_URL,
  process.env.KEEPALIVE_FALLBACK_URL
].filter((url) => typeof url === 'string' && url.trim().length > 0);
const KEEPALIVE_INTERVAL_MS = Number.parseInt(process.env.KEEPALIVE_INTERVAL_MS, 10) || 5 * 60 * 1000;

const DEFAULT_STATE = () => ({
  players: {},
  clans: {},
  clanBattles: [],
  clanInvites: {}
});

let data = DEFAULT_STATE(); // canonical structure
let players = data.players;
let clans = data.clans;
let clanInvites = data.clanInvites;
let clanBattles = data.clanBattles;
const adminBroadcastSessions = new Map();
const ADMIN_BROADCAST_CANCEL = 'admin_broadcast:cancel';
const ADMIN_BROADCAST_CONFIRM = 'admin_broadcast:confirm';

// Prevent concurrent writes under heavy load
let savingPromise = Promise.resolve();

function normalizeState(state = {}) {
  return {
    players: state.players && typeof state.players === 'object' ? state.players : {},
    clans: state.clans && typeof state.clans === 'object' ? state.clans : {},
    clanBattles: Array.isArray(state.clanBattles) ? state.clanBattles : [],
    clanInvites: state.clanInvites && typeof state.clanInvites === 'object' ? state.clanInvites : {}
  };
}

function applyState(state) {
  const normalized = normalizeState(state);
  players = normalized.players;
  clans = normalized.clans;
  clanBattles = normalized.clanBattles;
  clanInvites = normalized.clanInvites;
  Object.assign(data, normalized);
}

function toJsonText(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch (err) {
    console.error('Не удалось сериализовать JSON:', err);
    return null;
  }
}

function parseJsonText(value, fallback = null) {
  if (value == null) return fallback;
  let text = value;
  if (Buffer.isBuffer(text)) {
    text = text.toString('utf-8');
  }
  if (typeof text === 'object') {
    return text;
  }
  const trimmed = String(text).trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    console.error('Не удалось распарсить JSON из базы данных:', err);
    return fallback;
  }
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toNumberOrDefault(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toBooleanInt(value) {
  return value ? 1 : 0;
}

function parseBooleanColumn(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    return lowered === 'true' || lowered === '1' || lowered === 'yes';
  }
  return false;
}

const PLAYER_KNOWN_KEYS = new Set([
  'id',
  'username',
  'name',
  'hp',
  'maxHp',
  'infection',
  'survivalDays',
  'bestSurvivalDays',
  'clanId',
  'inventory',
  'monster',
  'monsterStun',
  'damageBoostTurns',
  'damageReductionTurns',
  'radiationBoost',
  'firstAttack',
  'lastHunt',
  'pendingDrop',
  'pvpWins',
  'pvpLosses',
  'lastGiftTime',
  'huntCooldownWarned',
  'currentDanger',
  'currentDangerMsgId',
  'baseUrl',
  'pvp'
]);

function normalizePlayerId(rawId, fallbackKey) {
  if (rawId == null) {
    const parsed = Number(fallbackKey);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(rawId);
  if (Number.isFinite(parsed)) return parsed;
  const fromKey = Number(fallbackKey);
  return Number.isFinite(fromKey) ? fromKey : null;
}

function extractPlayerRow(key, player) {
  if (!player || typeof player !== 'object') return null;
  const id = normalizePlayerId(player.id, key);
  if (id == null) return null;

  const extra = {};
  for (const [prop, value] of Object.entries(player)) {
    if (!PLAYER_KNOWN_KEYS.has(prop)) {
      extra[prop] = value;
    }
  }

  return {
    id,
    username: player.username ?? null,
    name: player.name ?? null,
    hp: toNumberOrNull(player.hp),
    maxHp: toNumberOrNull(player.maxHp),
    infection: toNumberOrNull(player.infection),
    survivalDays: toNumberOrNull(player.survivalDays),
    bestSurvivalDays: toNumberOrNull(player.bestSurvivalDays),
    clanId: toNumberOrNull(player.clanId),
    inventory: toJsonText(player.inventory),
    monster: toJsonText(player.monster),
    monsterStun: toNumberOrNull(player.monsterStun),
    damageBoostTurns: toNumberOrNull(player.damageBoostTurns),
    damageReductionTurns: toNumberOrNull(player.damageReductionTurns),
    radiationBoost: toBooleanInt(player.radiationBoost),
    firstAttack: toBooleanInt(player.firstAttack),
    lastHunt: toNumberOrNull(player.lastHunt),
    pendingDrop: toJsonText(player.pendingDrop),
    pvpWins: toNumberOrNull(player.pvpWins),
    pvpLosses: toNumberOrNull(player.pvpLosses),
    lastGiftTime: toNumberOrNull(player.lastGiftTime),
    huntCooldownWarned: toBooleanInt(player.huntCooldownWarned),
    currentDanger: toJsonText(player.currentDanger),
    currentDangerMsgId: toNumberOrNull(player.currentDangerMsgId),
    baseUrl: player.baseUrl ?? null,
    pvp: toJsonText(player.pvp),
    extra: Object.keys(extra).length > 0 ? toJsonText(extra) : null
  };
}

function buildPlayerFromRow(row) {
  const player = {
    id: row.id,
    username: row.username ?? undefined,
    name: row.name ?? undefined,
    hp: toNumberOrDefault(row.hp, 0),
    maxHp: toNumberOrDefault(row.maxHp, 0),
    infection: toNumberOrDefault(row.infection, 0),
    survivalDays: toNumberOrDefault(row.survivalDays, 0),
    bestSurvivalDays: toNumberOrDefault(row.bestSurvivalDays, 0),
    clanId: toNumberOrNull(row.clanId),
    inventory: parseJsonText(row.inventory, { armor: null, helmet: null, weapon: null, mutation: null, extra: null, sign: null }),
    monster: parseJsonText(row.monster, null),
    monsterStun: toNumberOrDefault(row.monsterStun, 0),
    damageBoostTurns: toNumberOrDefault(row.damageBoostTurns, 0),
    damageReductionTurns: toNumberOrDefault(row.damageReductionTurns, 0),
    radiationBoost: parseBooleanColumn(row.radiationBoost),
    firstAttack: parseBooleanColumn(row.firstAttack !== undefined ? row.firstAttack : true),
    lastHunt: toNumberOrDefault(row.lastHunt, 0),
    pendingDrop: parseJsonText(row.pendingDrop, null),
    pvpWins: toNumberOrDefault(row.pvpWins, 0),
    pvpLosses: toNumberOrDefault(row.pvpLosses, 0),
    lastGiftTime: toNumberOrDefault(row.lastGiftTime, 0),
    huntCooldownWarned: parseBooleanColumn(row.huntCooldownWarned),
    currentDanger: parseJsonText(row.currentDanger, null),
    currentDangerMsgId: toNumberOrNull(row.currentDangerMsgId),
    baseUrl: row.baseUrl ?? undefined,
    pvp: parseJsonText(row.pvp, null)
  };

  if (!player.inventory || typeof player.inventory !== 'object') {
    player.inventory = { armor: null, helmet: null, weapon: null, mutation: null, extra: null, sign: null };
  }

  const extra = parseJsonText(row.extra, null);
  if (extra && typeof extra === 'object') {
    Object.assign(player, extra);
  }

  return player;
}

const CLAN_KNOWN_KEYS = new Set(['id', 'name', 'points', 'members', 'leaderId']);

function extractClanRow(key, clan) {
  if (!clan || typeof clan !== 'object') return null;
  const id = toNumberOrNull(clan.id ?? key);
  if (id == null) return null;

  const extra = {};
  for (const [prop, value] of Object.entries(clan)) {
    if (!CLAN_KNOWN_KEYS.has(prop)) {
      extra[prop] = value;
    }
  }

  return {
    id,
    name: clan.name ?? null,
    points: toNumberOrNull(clan.points),
    members: toJsonText(clan.members ?? []),
    extra: Object.keys(extra).length > 0 ? toJsonText(extra) : null
  };
}

function buildClanFromRow(row) {
  const clan = {
    id: row.id,
    name: row.name ?? '',
    points: toNumberOrDefault(row.points, 0),
    members: parseJsonText(row.members, [])
  };
  if (!Array.isArray(clan.members)) clan.members = [];
  const extra = parseJsonText(row.extra, null);
  if (extra && typeof extra === 'object') {
    Object.assign(clan, extra);
  }
  return clan;
}

function extractClanBattleRow(battle) {
  if (!battle || typeof battle !== 'object') return null;
  const base = {
    id: toNumberOrNull(battle.id) ?? Date.now(),
    clanId: toNumberOrNull(battle.clanId),
    opponentClanId: toNumberOrNull(battle.opponentClanId),
    status: battle.status ?? null,
    createdAt: toNumberOrNull(battle.createdAt),
    acceptedBy: toNumberOrNull(battle.acceptedBy)
  };

  const extra = {};
  for (const [prop, value] of Object.entries(battle)) {
    if (!(prop in base)) {
      extra[prop] = value;
    }
  }

  return {
    ...base,
    data: Object.keys(extra).length > 0 ? toJsonText(extra) : null
  };
}

function buildClanBattleFromRow(row) {
  const battle = {
    id: row.id,
    clanId: toNumberOrNull(row.clanId),
    opponentClanId: toNumberOrNull(row.opponentClanId),
    status: row.status ?? null,
    createdAt: toNumberOrNull(row.createdAt),
    acceptedBy: toNumberOrNull(row.acceptedBy)
  };
  const extra = parseJsonText(row.data, null);
  if (extra && typeof extra === 'object') {
    Object.assign(battle, extra);
  }
  return battle;
}

function extractClanInviteRow(playerId, invite) {
  if (!invite || typeof invite !== 'object') return null;
  const key = String(playerId);
  const extra = {};
  const knownKeys = new Set(['clanId', 'fromId', 'expires']);
  for (const [prop, value] of Object.entries(invite)) {
    if (!knownKeys.has(prop)) {
      extra[prop] = value;
    }
  }
  return {
    playerId: key,
    clanId: toNumberOrNull(invite.clanId),
    fromId: toNumberOrNull(invite.fromId),
    expires: toNumberOrNull(invite.expires),
    extra: Object.keys(extra).length > 0 ? toJsonText(extra) : null
  };
}

function buildClanInviteFromRow(row) {
  const invite = {
    clanId: toNumberOrNull(row.clanId),
    fromId: toNumberOrNull(row.fromId),
    expires: toNumberOrNull(row.expires)
  };
  const extra = parseJsonText(row.extra, null);
  if (extra && typeof extra === 'object') {
    Object.assign(invite, extra);
  }
  return invite;
}

async function writeStateToDatabaseTables(state) {
  if (!pool || typeof pool.execute !== 'function') return;
  const beginSql = DB_DIALECT === 'mysql' ? 'START TRANSACTION' : 'BEGIN';
  try {
    await pool.execute(beginSql);
  } catch (err) {
    // Если транзакции не поддерживаются, продолжаем без них
  }

  const rollback = async () => {
    try {
      await pool.execute('ROLLBACK');
    } catch (err) {
      if (err && !/no transaction/i.test(String(err.message))) {
        console.error('Ошибка отката транзакции состояния:', err);
      }
    }
  };

  try {
    await pool.execute('DELETE FROM players');
    for (const [key, player] of Object.entries(state.players || {})) {
      const row = extractPlayerRow(key, player);
      if (!row) continue;
      await pool.execute(
        `INSERT INTO players (id, username, name, hp, maxHp, infection, survivalDays, bestSurvivalDays, clanId, inventory, monster, monsterStun, damageBoostTurns, damageReductionTurns, radiationBoost, firstAttack, lastHunt, pendingDrop, pvpWins, pvpLosses, lastGiftTime, huntCooldownWarned, currentDanger, currentDangerMsgId, baseUrl, pvp, extra, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        , [
          row.id,
          row.username,
          row.name,
          row.hp,
          row.maxHp,
          row.infection,
          row.survivalDays,
          row.bestSurvivalDays,
          row.clanId,
          row.inventory,
          row.monster,
          row.monsterStun,
          row.damageBoostTurns,
          row.damageReductionTurns,
          row.radiationBoost,
          row.firstAttack,
          row.lastHunt,
          row.pendingDrop,
          row.pvpWins,
          row.pvpLosses,
          row.lastGiftTime,
          row.huntCooldownWarned,
          row.currentDanger,
          row.currentDangerMsgId,
          row.baseUrl,
          row.pvp,
          row.extra
        ]
      );
    }

    await pool.execute('DELETE FROM clans');
    for (const [key, clan] of Object.entries(state.clans || {})) {
      const row = extractClanRow(key, clan);
      if (!row) continue;
      await pool.execute(
        `INSERT INTO clans (id, name, points, members, extra, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        , [row.id, row.name, row.points, row.members, row.extra]
      );
    }

    await pool.execute('DELETE FROM clan_battles');
    for (const battle of state.clanBattles || []) {
      const row = extractClanBattleRow(battle);
      if (!row) continue;
      await pool.execute(
        `INSERT INTO clan_battles (id, clanId, opponentClanId, status, createdAt, acceptedBy, data, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        , [
          row.id,
          row.clanId,
          row.opponentClanId,
          row.status,
          row.createdAt,
          row.acceptedBy,
          row.data
        ]
      );
    }

    await pool.execute('DELETE FROM clan_invites');
    for (const [playerId, invite] of Object.entries(state.clanInvites || {})) {
      const row = extractClanInviteRow(playerId, invite);
      if (!row) continue;
      await pool.execute(
        `INSERT INTO clan_invites (playerId, clanId, fromId, expires, extra, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        , [row.playerId, row.clanId, row.fromId, row.expires, row.extra]
      );
    }

    try {
      await pool.execute('COMMIT');
    } catch (err) {
      if (err && !/no transaction/i.test(String(err.message))) {
        console.error('Ошибка завершения транзакции состояния:', err);
        throw err;
      }
    }
  } catch (err) {
    await rollback();
    throw err;
  }
}

async function loadStateFromDatabaseTables() {
  if (!pool || typeof pool.execute !== 'function') {
    return { state: DEFAULT_STATE(), hasRows: false, tablesPresent: false };
  }

  const state = DEFAULT_STATE();
  let hasRows = false;

  try {
    const [playerRows] = await pool.execute('SELECT * FROM players');
    for (const row of playerRows || []) {
      hasRows = true;
      const player = buildPlayerFromRow(row);
      state.players[String(player.id)] = player;
    }

    const [clanRows] = await pool.execute('SELECT * FROM clans');
    for (const row of clanRows || []) {
      hasRows = true;
      const clan = buildClanFromRow(row);
      state.clans[String(clan.id)] = clan;
    }

    const [battleRows] = await pool.execute('SELECT * FROM clan_battles');
    for (const row of battleRows || []) {
      hasRows = true;
      state.clanBattles.push(buildClanBattleFromRow(row));
    }

    const [inviteRows] = await pool.execute('SELECT * FROM clan_invites');
    for (const row of inviteRows || []) {
      hasRows = true;
      state.clanInvites[String(row.playerId)] = buildClanInviteFromRow(row);
    }
  } catch (err) {
    if (/no such table/i.test(String(err.message))) {
      return { state: DEFAULT_STATE(), hasRows: false, tablesPresent: false };
    }
    throw err;
  }

  return { state: normalizeState(state), hasRows, tablesPresent: true };
}

async function loadLegacyStateFromDatabase() {
  if (!pool || typeof pool.execute !== 'function') return null;
  try {
    const [rows] = await pool.execute('SELECT state FROM bot_state WHERE id = ?', [1]);
    if (Array.isArray(rows) && rows.length > 0 && rows[0] && rows[0].state) {
      return normalizeState(parseJsonText(rows[0].state, null));
    }
  } catch (err) {
    if (!/no such table/i.test(String(err.message))) {
      throw err;
    }
  }
  return null;
}

async function saveData() {
  const currentState = normalizeState({ players, clans, clanBattles, clanInvites });
  Object.assign(data, currentState);
  savingPromise = savingPromise.then(async () => {
    try {
      await writeStateToDatabaseTables(currentState);
    } catch (dbErr) {
      console.error(`Ошибка записи в ${DB_LABEL}:`, dbErr);
    }
  });
  return savingPromise;
}

async function loadData() {
  let loadedState = null;
  let shouldSyncDb = false;
  let structuredResult = null;

  try {
    structuredResult = await loadStateFromDatabaseTables();
    if (structuredResult?.hasRows) {
      loadedState = structuredResult.state;
      console.log(`${DB_LABEL}: состояние загружено из структурированных таблиц.`);
    }
  } catch (err) {
    console.error(`Ошибка чтения из ${DB_LABEL}:`, err);
  }

  if (!loadedState) {
    try {
      const legacyState = await loadLegacyStateFromDatabase();
      if (legacyState) {
        loadedState = legacyState;
        shouldSyncDb = true;
        console.log(
          `${DB_LABEL}: найдено состояние в таблице bot_state, выполняем миграцию в новые таблицы.`
        );
      }
    } catch (legacyErr) {
      console.error(`${DB_LABEL}: ошибка чтения legacy-таблицы bot_state:`, legacyErr);
    }
  }

  if (!loadedState) {
    loadedState = DEFAULT_STATE();
    console.log('Создаём новое состояние по умолчанию.');
  }

  const normalized = normalizeState(loadedState);
  applyState(normalized);

  if (shouldSyncDb || (structuredResult && !structuredResult.hasRows)) {
    try {
      await writeStateToDatabaseTables(normalized);
    } catch (dbErr) {
      console.error(`Ошибка записи в ${DB_LABEL}:`, dbErr);
    }
  }
}

const RANKED_PVP_RATING_REWARD = 35;

function ensurePvpRatingFields(player) {
  if (!player) return;
  if (!Number.isFinite(player.pvpRating)) player.pvpRating = 0;
  if (!Number.isFinite(player.pvpRatingBest)) player.pvpRatingBest = player.pvpRating;
}

function resetPvpRating(player) {
  if (!player) return;
  ensurePvpRatingFields(player);
  player.pvpRating = 0;
}

function grantRankedPvpPoints(player, amount = RANKED_PVP_RATING_REWARD) {
  if (!player) return { current: 0, best: 0 };
  ensurePvpRatingFields(player);
  const reward = Number.isFinite(amount) ? amount : RANKED_PVP_RATING_REWARD;
  player.pvpRating += reward;
  if (player.pvpRating > player.pvpRatingBest) {
    player.pvpRatingBest = player.pvpRating;
  }
  return { current: player.pvpRating, best: player.pvpRatingBest };
}

function ensurePlayer(user) {
  if (!user || typeof user.id === 'undefined') return null;
  const key = String(user.id);
  let p = players[key];
  if (!p) {
    p = {
      id: user.id,
      username: user.username || `id${user.id}`,
      name: user.first_name || user.username || `id${user.id}`,
      hp: 100,
      maxHp: 100,
      infection: 0,
      crimecoins: 0,
      survivalDays: 0,
      bestSurvivalDays: 0,
      clanId: null,
      inventory: { armor: null, helmet: null, weapon: null, mutation: null, extra: null, sign: null },
      monster: null,
      monsterStun: 0,
      damageBoostTurns: 0,
      damageReductionTurns: 0,
      radiationBoost: false,
      firstAttack: true,
      lastHunt: 0,
      pendingDrop: null,
      pendingHuntRaid: null,
      pvpWins: 0,
      pvpLosses: 0,
      pvpRating: 0,
      pvpRatingBest: 0,
      lastGiftTime: 0,
      huntCooldownWarned: false,
      currentDanger: null,
      currentDangerMsgId: null,
      inviteCasesAvailable: 0,
      inviteCasesOpened: 0,
      invitedUserIds: [],
    };
    players[key] = p;
    saveData();
  } else {
    const newUsername = user.username || `id${user.id}`;
    if (p.username !== newUsername) p.username = newUsername;
    const newName = user.first_name || newUsername;
    if (p.name !== newName) p.name = newName;
    if (!Number.isFinite(p.survivalDays)) p.survivalDays = 0;
    if (!Number.isFinite(p.bestSurvivalDays)) p.bestSurvivalDays = p.survivalDays;
    if (p.bestSurvivalDays < p.survivalDays) p.bestSurvivalDays = p.survivalDays;
    if (!Number.isFinite(p.crimecoins)) p.crimecoins = 0;
    ensurePvpRatingFields(p);
    if (typeof p.inviteCasesAvailable !== 'number' || !Number.isFinite(p.inviteCasesAvailable)) {
      p.inviteCasesAvailable = 0;
    }
    if (!('pendingHuntRaid' in p)) {
      p.pendingHuntRaid = null;
    }
    if (typeof p.inviteCasesOpened !== 'number' || !Number.isFinite(p.inviteCasesOpened)) {
      p.inviteCasesOpened = p.inviteCaseOpened ? 1 : 0;
    }
    if (!Array.isArray(p.invitedUserIds)) {
      p.invitedUserIds = [];
    } else {
      p.invitedUserIds = p.invitedUserIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0);
    }
    if (typeof p.inviteCaseOpened === 'boolean') {
      delete p.inviteCaseOpened;
    }
  }
  return p;
}

function parseReferralPayload(payload) {
  if (!payload) return null;
  const trimmed = String(payload).trim();
  const match = /^ref_(\d{1,20})$/i.exec(trimmed);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Критические ошибки: рестарт только если это не TelegramError, ETELEGRAM, ECONNRESET, 'message is not modified'
    const msg = String(err && err.message || err);
    if (
      !msg.includes('TelegramError') &&
      !msg.includes('ETELEGRAM') &&
      !msg.includes('ECONNRESET') &&
      !msg.includes('message is not modified')
    ) {
        restartBot();
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    // Критические ошибки: рестарт только если это не TelegramError, ETELEGRAM, ECONNRESET, 'message is not modified'
    const msg = String(reason && reason.message || reason);
    if (
      !msg.includes('TelegramError') &&
      !msg.includes('ETELEGRAM') &&
      !msg.includes('ECONNRESET') &&
      !msg.includes('message is not modified')
    ) {
        restartBot();
    }
});

function restartBot() {
    console.log('Перезапуск бота через 3 секунды...');
    setTimeout(() => {
        if (bot) {
        bot.removeAllListeners();
        if (bot.stopPolling) {
            bot.stopPolling().catch(e => console.error('Ошибка при stopPolling:', e.message));
        }
    }
    startBot();
    }, 3000);
}

function escMd(str) {
  if (!str) return '';
  return String(str)
    .replace(/\_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\~/g, '\\~')
    .replace(/\`/g, '\\`')
    .replace(/\>/g, '\\>')
    .replace(/\#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/\=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/\!/g, '\\!');
}

function formatPlayerDisplayName(player) {
  if (!player) return "—";
  if (player.username) return `@${escMd(player.username)}`;
  if (player.name) return escMd(player.name);
  if (player.id) return escMd(player.id);
  return "—";
}

function buildPlayerOverview(player) {
  if (!player) return "";
  ensurePvpRatingFields(player);
  const clanName =
    player.clanId && clans[String(player.clanId)]
      ? escMd(clans[String(player.clanId)].name)
      : "—";
  const hpCurrent = Number.isFinite(player.hp) ? player.hp : 0;
  const hpMax = Number.isFinite(player.maxHp) ? player.maxHp : hpCurrent;
  const infection = Number.isFinite(player.infection) ? player.infection : 0;
  const crimecoins = Number.isFinite(player.crimecoins) ? player.crimecoins : 0;
  const wins = Number.isFinite(player.pvpWins) ? player.pvpWins : 0;
  const losses = Number.isFinite(player.pvpLosses) ? player.pvpLosses : 0;
  const rating = Number.isFinite(player.pvpRating) ? player.pvpRating : 0;
  const ratingBest = Number.isFinite(player.pvpRatingBest) ? player.pvpRatingBest : rating;
  const survivalDays = Number.isFinite(player.survivalDays) ? player.survivalDays : 0;

  return [
    `👤 Игрок: ${formatPlayerDisplayName(player)}`,
    `❤️ Здоровье: ${hpCurrent}/${hpMax}`,
    `☣️ Заражение: ${infection}`,
    `🪙 CRIMECOINS: ${crimecoins}`,
    `🏆 PvP: ${wins} побед / ${losses} поражений`,
    `🥇 Рейтинг PvP: ${rating} (рекорд: ${ratingBest})`,
    `📅 Дней выживания: ${survivalDays}`,
    `🏰 Клан: ${clanName}`
  ].join("\n");
}

function buildMainMenuText(player) {
  const overview = buildPlayerOverview(player);
  return overview
    ? `${overview}\n\n🏠 Главное меню\nВыбери действие ниже.`
    : "🏠 Главное меню\nВыбери действие ниже.";
}

function buildStartMessage(player) {
  const displayName = formatPlayerDisplayName(player);
  const overview = buildPlayerOverview(player);
  const intro = displayName !== "—" ? `Привет, ${displayName}!` : "Привет!";
  return overview
    ? `${intro}\n\n${overview}\n\nИспользуй кнопки ниже, чтобы продолжить игру.`
    : `${intro}\nИспользуй кнопки ниже, чтобы продолжить игру.`;
}

function formatItemLine(label, item, detailBuilder) {
  if (!item) return `${label}: —`;
  const name = escMd(item.name || "—");
  let detailText = "";
  if (typeof detailBuilder === "function") {
    const detail = detailBuilder(item);
    if (detail) {
      detailText = ` (${escMd(detail)})`;
    }
  }
  return `${label}: ${name}${detailText}`;
}

function buildInventoryText(player) {
  if (!player) return "🎒 Инвентарь пуст.";
  const inv = player.inventory || {};
  const overview = buildPlayerOverview(player);
  const lines = [
    "🎒 Инвентарь",
    "",
    overview,
    "",
    formatItemLine("🪖 Шлем", inv.helmet, (item) =>
      typeof item.block !== "undefined" ? `блок ${item.block}%` : null
    ),
    formatItemLine("🛡 Броня", inv.armor, (item) =>
      typeof item.hp !== "undefined" ? `HP +${item.hp}` : null
    ),
    formatItemLine("🔫 Оружие", inv.weapon, (item) =>
      typeof item.dmg !== "undefined" ? `урон +${item.dmg}` : null
    ),
    formatItemLine("🧬 Мутация", inv.mutation, (item) => {
      if (typeof item.crit !== "undefined") {
        const critPercent = item.crit <= 1 ? Math.round(item.crit * 100) : item.crit;
        return `crit ${critPercent}%`;
      }
      return null;
    }),
    formatItemLine("📦 Доп", inv.extra, (item) => item.effect || null),
    formatItemLine("⚠️ Знак", inv.sign, (item) => describeSignEffect(item))
  ];
  return lines.join("\n");
}

function buildCrimecoinsInfoText(player) {
  const balance = player?.crimecoins || 0;
  const contact = DONATION_CONTACT ? escMd(DONATION_CONTACT) : null;
  const lines = [
    "🪙 CRIMECOINS",
    "",
    `Текущий баланс: *${balance}*`,
    "",
    "Эта валюта выдаётся только за добровольные пожертвования.",
    "Её можно обменять на кейсы или другие бонусы в будущем."
  ];
  if (contact) {
    lines.push("", `По вопросам обращайтесь к ${contact}.`);
  }
  return lines.join("\n");
}

function buildInventoryKeyboard(activeTab = "gear") {
  const gearLabel = `${activeTab === "gear" ? "• " : ""}🎒 Снаряжение`;
  const coinLabel = `${activeTab === "coins" ? "• " : ""}🪙 CRIMECOINS`;
  return {
    inline_keyboard: [
      [
        { text: gearLabel, callback_data: "inventory" },
        { text: coinLabel, callback_data: "inventory:crimecoins" }
      ],
      [{ text: "⬅️ Назад", callback_data: "play" }]
    ]
  };
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🩸 Выйти на охоту", callback_data: "hunt" }],
      [{ text: "🎰 Кейсы", callback_data: "cases" }],
      [{ text: "🎒 Инвентарь", callback_data: "inventory" }],
      [{ text: "🏆 Таблица лидеров", callback_data: "leaderboard_menu" }],
      [{ text: "⚔️ PvP", callback_data: "pvp_menu" }],
      [{ text: "🏰 Кланы", callback_data: "clans_menu" }],
      [{ text: "👥 Коммьюнити", callback_data: "community" }]
    ]
  };
}

function lootMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🆓 Бесплатный подарок", callback_data: "case_info:free_gift" }],
      [{ text: "🧟‍♂️ Притащить тело", callback_data: "case_info:invite" }],
      [{ text: "Знаки (5000 очков заражения)", callback_data: "case_info:sign" }],
      [{ text: "☣️ Зараженное тело (3000 очков заражения)", callback_data: "case_info:infection" }],
      [{ text: "📦 Базовая коробка (100 CRIMECOINS)", callback_data: "case_info:basic" }],
      [{ text: "💎 Легендарная коробка (599 CRIMECOINS)", callback_data: "case_info:legend" }],
      [{ text: "⬅️ Назад", callback_data: "play" }]
    ]
  };
}

function leaderboardMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🎯 Лидеры Охоты", callback_data: "leaderboard_survival" }],
      [{ text: "⚔️ Лидеры PvP", callback_data: "pvp_leaderboard" }],
      [{ text: "🏰 Топ кланы", callback_data: "clans_top" }],
      [{ text: "⬅️ Назад", callback_data: "play" }]
    ]
  };
}

function leaderboardResultKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Назад", callback_data: "leaderboard_menu" }]
    ]
  };
}

function clansMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Создать / принять клан", callback_data: "clans_create_join" }],
      [{ text: "❗ Рейд миссия", callback_data: "clans_raid_mission" }],
      [{ text: "🪖 Клановая битва", callback_data: "clans_battle_info" }],
      [{ text: "⚔️ Захват чата", callback_data: "clans_assault_info" }],
      [{ text: "⬅️ Назад", callback_data: "play" }]
    ]
  };
}

function resourcesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📢 Канал", url: "https://t.me/crimecorebotgame" }],
      [{ text: "💬 Чат", url: "https://t.me/+uHiRhUs7EH0xZDVi" }],
      [{ text: "⬅️ Назад", callback_data: "play" }]
    ]
  };
}

async function startBot() {
    if (typeof bot !== 'undefined' && bot) {
        bot.removeAllListeners();
        if (bot.stopPolling) {
            try { bot.stopPolling(); } catch (e) { console.error('Ошибка при stopPolling:', e.message); }
        }
    }



  // await initPostgres();
  await loadData();
  console.log("Бот запущен ✅");

  bot = new TelegramBot(TOKEN, { polling: true, httpFetch: fetch });

  const ALLOWED_USER_ID = 7897895019;

  // === Патч безопасного редактирования сообщений (добавлено) ===
  try {
    const _editText = bot.editMessageText.bind(bot);
    bot.editMessageText = async function (text, opts = {}) {
      try {
        if (!opts || typeof opts.chat_id === "undefined" || typeof opts.message_id === "undefined") {
          throw new Error("missing chat_id/message_id");
        }
        return await _editText(text, opts);
      } catch (e) {
        // Игнорируем ошибку "message is not modified"
        if (e && e.response && e.response.body && typeof e.response.body.description === 'string' && e.response.body.description.includes('message is not modified')) {
          return;
        }
        const chatId = (opts && (opts.chat_id || opts.chatId)) || (this && this.chat && this.chat.id);
        if (typeof chatId === "undefined") return;
        const sendOpts = { reply_markup: opts && opts.reply_markup };
        if (opts && opts.parse_mode) sendOpts.parse_mode = opts.parse_mode;
        try {
          return await bot.sendMessage(chatId, text, sendOpts);
        } catch (e2) {
          try {
            delete sendOpts.parse_mode;
            return await bot.sendMessage(chatId, text, sendOpts);
          } catch (e3) {
            if (process.env.NODE_ENV !== 'production') console.error("safe edit fallback error:", e3.message);
          }
        }
      }
    };

    // Аналогично для editMessageCaption
    const _editCaption = bot.editMessageCaption.bind(bot);
    bot.editMessageCaption = async function (caption, opts = {}) {
      try {
        return await _editCaption(caption, opts);
      } catch (e) {
        if (e && e.response && e.response.body && typeof e.response.body.description === 'string' && e.response.body.description.includes('message is not modified')) {
          return;
        }
        if (process.env.NODE_ENV !== 'production') console.error("editMessageCaption error:", e.message);
      }
    };

    // Аналогично для editMessageReplyMarkup
    const _editReplyMarkup = bot.editMessageReplyMarkup.bind(bot);
    bot.editMessageReplyMarkup = async function (markup, opts = {}) {
      try {
        return await _editReplyMarkup(markup, opts);
      } catch (e) {
        if (e && e.response && e.response.body && typeof e.response.body.description === 'string' && e.response.body.description.includes('message is not modified')) {
          return;
        }
        if (process.env.NODE_ENV !== 'production') console.error("editMessageReplyMarkup error:", e.message);
      }
    };
  } catch (e) {
    console.error("patch editMessageText failed:", e.message);
  }
  // === /Патч безопасного редактирования сообщений ===

function findPlayerByIdentifier(identifier) {
  if (!identifier) return null;
  const raw = String(identifier).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    return players[raw] || null;
  }

  const normalized = raw.startsWith('@') ? raw.slice(1).toLowerCase() : raw.toLowerCase();
  return (
    Object.values(players).find(player => {
      if (!player) return false;
      if (player.username && player.username.toLowerCase() === normalized) return true;
      if (player.name && String(player.name).toLowerCase() === normalized) return true;
      return false;
    }) || null
  );
}

function getPlayerById(id) {
  if (id === null || id === undefined) return null;
  const key = String(id);
  return players[key] || null;
}

function cleanDatabase() {
  for (const [key, p] of Object.entries(players)) {
    if (!p || typeof p !== 'object') {
      delete players[key];
      continue;
    }
    if (!p.inventory) p.inventory = {};
    p.inventory.armor ??= null;
    p.inventory.helmet ??= null;
    p.inventory.weapon ??= null;
    p.inventory.mutation ??= null;
    p.inventory.extra ??= null;
    p.inventory.sign ??= null;
    p.signRadiationUsed ??= false;
    p.signFinalUsed ??= false;
    p.id ??= Number(key);
    p.username ??= `id${key}`;
    p.name ??= p.username;
    p.hp ??= 100;
    p.maxHp ??= p.hp;
    p.infection ??= 0;
    p.survivalDays ??= 0;
    p.bestSurvivalDays ??= p.survivalDays;
    p.clanId ??= null;
    p.monster ??= null;
    p.monsterStun ??= 0;
    p.damageBoostTurns ??= 0;
    p.damageReductionTurns ??= 0;
    p.radiationBoost ??= false;
    p.firstAttack ??= false;
    p.lastHunt ??= 0;
    p.pendingDrop ??= null;
    p.pendingHuntRaid ??= null;
    p.pvpWins ??= 0;
    p.pvpLosses ??= 0;
    p.pvpRating ??= 0;
    p.pvpRatingBest ??= p.pvpRating;
    p.lastGiftTime ??= 0;
    p.huntCooldownWarned ??= false;
    p.currentDanger ??= null;
    p.currentDangerMsgId ??= null;
  }

  for (const [cid, clan] of Object.entries(clans)) {
    if (!clan || typeof clan !== 'object') {
      delete clans[cid];
      continue;
    }
    clan.id ??= Number(cid);
    clan.name ??= `Клан ${cid}`;
    if (!Array.isArray(clan.members)) clan.members = [];
    clan.members = clan.members.filter((id) => id != null);
    clan.points = Number.isFinite(Number(clan.points)) ? Number(clan.points) : 0;
    ensureClanHasLeader(clan);
  }
  saveData();
}

function applyArmorHelmetBonuses(player) {
  if (!player || !player.inventory) return;
  const armorHp = player.inventory.armor && typeof player.inventory.armor.hp === 'number'
    ? player.inventory.armor.hp
    : 0;
  player.maxHp = 100 + armorHp;
  if (typeof player.hp !== 'number') player.hp = player.maxHp;
  if (player.hp > player.maxHp) player.hp = player.maxHp;
}

function formatDaysWord(value) {
  const abs = Math.abs(value) % 100;
  const last = abs % 10;
  if (abs >= 11 && abs <= 14) return "дней";
  if (last === 1) return "день";
  if (last >= 2 && last <= 4) return "дня";
  return "дней";
}

function formatSurvivalTotal(value) {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe} ${formatDaysWord(safe)}`;
}

function grantSurvivalDay(player) {
  if (!player) return "";
  if (!Number.isFinite(player.survivalDays)) player.survivalDays = 0;
  if (!Number.isFinite(player.bestSurvivalDays)) player.bestSurvivalDays = 0;
  player.survivalDays += 1;
  if (player.survivalDays > player.bestSurvivalDays) {
    player.bestSurvivalDays = player.survivalDays;
  }
  return `🗓 Вы получили +1 день выживания, теперь у вас ${formatSurvivalTotal(player.survivalDays)} выживания.`;
}

function resetSurvivalProgress(player) {
  if (!player) return;
  player.survivalDays = 0;
  if (!Number.isFinite(player.bestSurvivalDays)) {
    player.bestSurvivalDays = 0;
  }
}

function compareBySurvival(a, b) {
  const bestA = Number.isFinite(a?.bestSurvivalDays) ? a.bestSurvivalDays : 0;
  const bestB = Number.isFinite(b?.bestSurvivalDays) ? b.bestSurvivalDays : 0;
  if (bestB !== bestA) return bestB - bestA;
  const currentA = Number.isFinite(a?.survivalDays) ? a.survivalDays : 0;
  const currentB = Number.isFinite(b?.survivalDays) ? b.survivalDays : 0;
  if (currentB !== currentA) return currentB - currentA;
  const infectionA = Number.isFinite(a?.infection) ? a.infection : 0;
  const infectionB = Number.isFinite(b?.infection) ? b.infection : 0;
  return infectionB - infectionA;
}

function buildSurvivalLeaderboardText(currentPlayer) {
  const sorted = Object.values(players).sort(compareBySurvival);
  let text = "🏆 Таблица лидеров по дням выживания:\n\n";
  sorted.slice(0, 10).forEach((p, i) => {
    const baseName = p.username ? p.username : (p.name || `id${p.id}`);
    const escapedName = escMd(baseName);
    const displayName = p.username === "bitcoincooking" ? `⚙️ Разработчик | ${escapedName}` : escapedName;
    const best = Number.isFinite(p?.bestSurvivalDays) ? p.bestSurvivalDays : 0;
    const current = Number.isFinite(p?.survivalDays) ? p.survivalDays : 0;
    text += `${i + 1}. ${displayName} — рекорд ${formatSurvivalTotal(best)} выживания (сейчас: ${formatSurvivalTotal(current)})\n`;
  });
  const rank = sorted.findIndex(p => currentPlayer && p.id === currentPlayer.id) + 1;
  const currentDays = Number.isFinite(currentPlayer?.survivalDays) ? currentPlayer.survivalDays : 0;
  const bestDays = Number.isFinite(currentPlayer?.bestSurvivalDays) ? currentPlayer.bestSurvivalDays : 0;
  text += `\nТвой текущий результат: ${formatSurvivalTotal(currentDays)} выживания`;
  text += `\nТвой рекорд: ${formatSurvivalTotal(bestDays)} выживания`;
  text += `\nТвоя позиция: ${rank > 0 ? rank : "—"} / ${sorted.length}`;
  return text;
}

function compareByPvpRating(a, b) {
  const bestA = Number.isFinite(a?.pvpRatingBest) ? a.pvpRatingBest : 0;
  const bestB = Number.isFinite(b?.pvpRatingBest) ? b.pvpRatingBest : 0;
  if (bestB !== bestA) return bestB - bestA;
  const ratingA = Number.isFinite(a?.pvpRating) ? a.pvpRating : 0;
  const ratingB = Number.isFinite(b?.pvpRating) ? b.pvpRating : 0;
  if (ratingB !== ratingA) return ratingB - ratingA;
  const winsA = Number.isFinite(a?.pvpWins) ? a.pvpWins : 0;
  const winsB = Number.isFinite(b?.pvpWins) ? b.pvpWins : 0;
  if (winsB !== winsA) return winsB - winsA;
  const infectionA = Number.isFinite(a?.infection) ? a.infection : 0;
  const infectionB = Number.isFinite(b?.infection) ? b.infection : 0;
  return infectionB - infectionA;
}

function buildPvpRatingLeaderboardText(currentPlayer) {
  const sorted = Object.values(players).sort(compareByPvpRating);
  let text = "🏆 Таблица лидеров PvP рейтинга:\n\n";
  sorted.slice(0, 10).forEach((p, i) => {
    const baseName = p.username ? p.username : (p.name || `id${p.id}`);
    const escapedName = escMd(baseName);
    const displayName = p.username === "bitcoincooking" ? `⚙️ Разработчик | ${escapedName}` : escapedName;
    const rating = Number.isFinite(p?.pvpRating) ? p.pvpRating : 0;
    const best = Number.isFinite(p?.pvpRatingBest) ? p.pvpRatingBest : 0;
    text += `${i + 1}. ${displayName} — рекорд: ${best} (текущий: ${rating})\n`;
  });
  const rank = sorted.findIndex(p => currentPlayer && p.id === currentPlayer.id) + 1;
  const currentRating = Number.isFinite(currentPlayer?.pvpRating) ? currentPlayer.pvpRating : 0;
  const bestRating = Number.isFinite(currentPlayer?.pvpRatingBest) ? currentPlayer.pvpRatingBest : 0;
  text += `\nТвой текущий рейтинг: ${currentRating}`;
  text += `\nТвой рекорд: ${bestRating}`;
  text += `\nТвоя позиция: ${rank > 0 ? rank : "—"} / ${sorted.length}`;
  return text;
}

function buildClanTopText(player) {
  const sorted = Object.values(clans).sort((a, b) => (Number(b?.points) || 0) - (Number(a?.points) || 0));
  if (sorted.length === 0) {
    return null;
  }

  let text = `🏰 Топ кланов:\n\n`;
  sorted.slice(0, 10).forEach((clan, index) => {
    const points = Number(clan?.points) || 0;
    const memberCount = Array.isArray(clan?.members) ? clan.members.length : 0;
    text += `${index + 1}. ${escMd(clan.name)} — ${points} очков (${memberCount} участников)\n`;
  });

  const rankIndex = sorted.findIndex((clan) => player?.clanId && Number(clan.id) === Number(player.clanId));
  const playerClan = player?.clanId ? clans[String(player.clanId)] : null;
  text += `\nТвой клан: ${playerClan ? escMd(playerClan.name) : "—"}\n`;
  text += `Твоё место: ${rankIndex >= 0 ? rankIndex + 1 : "—"} из ${sorted.length}`;
  return text;
}

// --- Config constants ---
const PVP_REQUEST_TTL = 60 * 1000;
const PVP_POINT = 300;
const RANDOM_PVP_SIGN_CHANCE = 0.5;
const PVP_START_COOLDOWN = 20 * 1000;

function getLastPvpStart(player) {
  if (!player || typeof player !== 'object') return 0;
  const raw = player.lastPvpStartAt ?? player.lastPvpStart ?? 0;
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : 0;
}

function getPvpCooldownRemaining(player) {
  const lastStart = getLastPvpStart(player);
  if (!lastStart) return 0;
  const diff = Date.now() - lastStart;
  const remaining = PVP_START_COOLDOWN - diff;
  return remaining > 0 ? remaining : 0;
}

function isPvpStartOnCooldown(player) {
  return getPvpCooldownRemaining(player) > 0;
}

function markPvpStartTimestamp(...participants) {
  const now = Date.now();
  let updated = false;
  for (const participant of participants) {
    if (!participant || typeof participant !== 'object') continue;
    participant.lastPvpStartAt = now;
    updated = true;
  }
  if (updated) saveData();
}
const CLAN_BATTLE_POINT = 500;
const CLAN_BATTLE_MIN_PER_CLAN = 2;
const CLAN_BATTLE_COUNTDOWN_MS = 20000; // 20 seconds

// --- Items (same as before) ---
function pickRandomSignCaseItem() {
  return pickCaseItem(CASE_TYPES.SIGN, { includeSigns: true });
}

function getFinalSignTemplate() {
  return getSignTemplateByName("Знак final CRIMECORE");
}

function resetPlayerSignFlags(player) {
  if (!player) return;
  player.signRadiationUsed = false;
  player.signFinalUsed = false;
}

function tryUseSignProtectionPvp(defender, defenderState, sign, events, attacker, attackerState) {
  if (!defenderState || defenderState.myHp > 0 || !sign) return false;
  if (typeof defenderState.signRadiationUsed !== "boolean") defenderState.signRadiationUsed = false;
  if (typeof defenderState.signFinalUsed !== "boolean") defenderState.signFinalUsed = false;
  const effects = getSignEffects(sign);
  if (!effects.preventLethal) return false;

  if (effects.preventLethal === "radiation" && !defenderState.signRadiationUsed) {
    defenderState.signRadiationUsed = true;
    if (defender) defender.signRadiationUsed = true;
    defenderState.myHp = 1;
    events.push(`☢️ ${defender.username} спасён знаком ${escMd(sign.name)}!`);
    if (effects.extraTurn && attackerState) {
      attackerState.myStun = Math.max(attackerState.myStun || 0, 1);
      if (attacker) {
        events.push(`⏳ ${attacker.username} ошеломлён и пропускает следующий ход.`);
      }
    }
    return true;
  }

  if (effects.preventLethal === "final" && effects.fullHeal && !defenderState.signFinalUsed) {
    defenderState.signFinalUsed = true;
    if (defender) defender.signFinalUsed = true;
    defenderState.myHp = defender.maxHp;
    events.push(`🛡️ ${defender.username} полностью восстановился благодаря ${escMd(sign.name)}!`);
    return true;
  }

  return false;
}

function tryUseSignProtectionPve(player, sign) {
  if (!player || player.hp > 0 || !sign) return null;
  const effects = getSignEffects(sign);
  if (!effects.preventLethal) return null;

  if (effects.preventLethal === "radiation" && !player.signRadiationUsed) {
    player.signRadiationUsed = true;
    player.hp = 1;
    if (effects.extraTurn) {
      player.monsterStun = Math.max(player.monsterStun || 0, 1);
    }
    return `☢️ ${sign.name} спасает тебя от смерти${effects.extraTurn ? ", и монстр пропускает следующий ход!" : "!"}`;
  }

  if (effects.preventLethal === "final" && effects.fullHeal && !player.signFinalUsed) {
    player.signFinalUsed = true;
    applyArmorHelmetBonuses(player);
    player.hp = player.maxHp;
    return `🛡️ ${sign.name} полностью восстанавливает твои HP!`;
  }

  return null;
}

// ------------------ Loot / Payments config ------------------
const FREE_GIFT_CHANNEL = "@SL4VE666"; // канал для бесплатного дропа

const CASE_LABELS = {
  [CASE_TYPES.FREE_GIFT]: "Бесплатный подарок",
  [CASE_TYPES.INVITE]: "Кейс за приглашение друга",
  [CASE_TYPES.INFECTION]: "Зараженное тело",
  [CASE_TYPES.SIGN]: "Знаки",
  [CASE_TYPES.BASIC]: "Базовая коробка удачи",
  [CASE_TYPES.LEGEND]: "Легендарная коробка удачи"
};

const FREE_GIFT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const CASE_COSTS = {
  infection: { amount: 3000, currency: 'infection', label: 'очков заражения', icon: '☣️' },
  sign: { amount: 5000, currency: 'infection', label: 'очков заражения', icon: '☣️' },
  basic: { amount: 100, currency: 'crimecoins', label: 'CRIMECOINS', icon: '🪙' },
  legend: { amount: 599, currency: 'crimecoins', label: 'CRIMECOINS', icon: '🪙' }
};

function getCaseCostConfig(caseId) {
  return CASE_COSTS[caseId] || null;
}

function buildCaseActionKeyboard(caseId, rows = []) {
  const keyboard = [...rows];
  keyboard.push([{ text: "👀 Предметы", callback_data: `preview_case:${caseId}` }]);
  keyboard.push([{ text: "⬅️ Назад", callback_data: "cases" }]);
  return keyboard;
}

function buildCaseInfoView(caseId, player, { notice } = {}) {
  if (!caseId || !player) return null;
  const label = getCaseLabel(caseId);
  const paragraphs = [`📦 *${escMd(label)}*`];
  if (notice) {
    paragraphs.push(notice);
  }

  const keyboardRows = [];

  if (caseId === 'free_gift') {
    const now = Date.now();
    const lastGiftTime = Number(player.lastGiftTime) || 0;
    const elapsed = now - lastGiftTime;
    paragraphs.push(
      `🆓 Забирай один предмет раз в 24 часа. Не забудь подписаться на канал ${FREE_GIFT_CHANNEL}.`
    );
    if (lastGiftTime && elapsed < FREE_GIFT_COOLDOWN_MS) {
      const timeLeft = FREE_GIFT_COOLDOWN_MS - elapsed;
      const hours = Math.floor(timeLeft / (1000 * 60 * 60));
      const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
      paragraphs.push(`⌛ Следующий подарок будет доступен через ${hours} ч ${minutes} мин.`);
    }
    keyboardRows.push([{ text: "🎁 Забрать подарок", callback_data: "case_open:free_gift" }]);
  } else if (caseId === 'invite') {
    const referralLink = `https://t.me/CRIMECOREgameBOT?start=ref_${player.id}`;
    const shareText = encodeURIComponent(
      `заходи в первую РПГ телеграм игру CRIMECORE!!! ${referralLink}`
    );
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${shareText}`;
    const available = Number(player.inviteCasesAvailable) || 0;
    paragraphs.push(
      "👥 Пригласи нового игрока и получи кейс. Игрок должен впервые запустить бота по твоей ссылке.",
      `🎁 Доступно открытий: ${available}.`,
      `🔗 Твоя ссылка: \`${escMd(referralLink)}\``
    );
    keyboardRows.push([{ text: "📤 Отправить приглашение", url: shareUrl }]);
    keyboardRows.push([{ text: "🎁 Открыть кейс", callback_data: "case_open:invite" }]);
  } else if (caseId === 'infection' || caseId === 'sign') {
    const costConfig = getCaseCostConfig(caseId);
    const balance = Number(player.infection) || 0;
    const lines = [];
    if (costConfig) {
      lines.push(
        `${costConfig.icon} Стоимость: ${costConfig.amount} ${costConfig.label}.`,
        `${costConfig.icon} Баланс: ${balance} ${costConfig.label}.`
      );
    }
    if (caseId === 'infection') {
      lines.push('Одна коробка — один гарантированный предмет. Шансы аналогичны PvE.');
    } else {
      lines.push('Все знаки из этого кейса выпадают с одинаковым шансом.');
    }
    paragraphs.push(lines.join('\n'));
    const buttonText =
      caseId === 'infection'
        ? `🎁 Открыть за ${CASE_COSTS.infection.amount} ☣️`
        : `🎁 Открыть за ${CASE_COSTS.sign.amount} ☣️`;
    keyboardRows.push([{ text: buttonText, callback_data: `case_open:${caseId}` }]);
  } else if (caseId === 'basic' || caseId === 'legend') {
    const costConfig = getCaseCostConfig(caseId);
    const balance = Number(player.crimecoins) || 0;
    if (costConfig) {
      paragraphs.push(
        `${costConfig.icon} Стоимость: ${costConfig.amount} ${costConfig.label}.\n${costConfig.icon} Баланс: ${balance} ${costConfig.label}.`
      );
    }
    if (caseId === 'basic') {
      paragraphs.push('Одна коробка — один гарантированный предмет. Шансы аналогичны PvE.');
    } else {
      paragraphs.push('Легендарная коробка содержит только топовые предметы с равными шансами.');
    }
    const buttonText =
      caseId === 'basic'
        ? `🎁 Открыть за ${CASE_COSTS.basic.amount} CRIMECOINS`
        : `🎁 Открыть за ${CASE_COSTS.legend.amount} CRIMECOINS`;
    keyboardRows.push([{ text: buttonText, callback_data: `case_open:${caseId}` }]);
  } else {
    return null;
  }

  const text = paragraphs.filter(Boolean).join('\n\n');
  return {
    text,
    keyboard: buildCaseActionKeyboard(caseId, keyboardRows),
    parseMode: 'Markdown'
  };
}

async function respondWithCaseInfo(chatId, messageId, caseId, player, options = {}) {
  const view = buildCaseInfoView(caseId, player, options);
  if (!view) {
    await editOrSend(chatId, messageId, 'Этот кейс пока недоступен.', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'cases' }]] }
    });
    return;
  }

  const messageOptions = {
    reply_markup: { inline_keyboard: view.keyboard },
    parse_mode: view.parseMode
  };

  await editOrSend(chatId, messageId, view.text, messageOptions);
}

async function handleFreeGiftOpen({ chatId, messageId, player, user }) {
  try {
    const member = await bot.getChatMember(FREE_GIFT_CHANNEL, user.id);
    const status = member && member.status ? member.status : 'left';
    if (status === 'left' || status === 'kicked') {
      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '📢 Открыть канал',
              url: `https://t.me/${String(FREE_GIFT_CHANNEL).replace(/^@/, '')}`
            }
          ],
          [{ text: '✅ Проверить подписку', callback_data: 'case_open:free_gift' }],
          [{ text: '👀 Предметы', callback_data: 'preview_case:free_gift' }],
          [{ text: '⬅️ Назад', callback_data: 'cases' }]
        ]
      };
      await editOrSend(
        chatId,
        messageId,
        `❌ Вы не подписаны на канал ${FREE_GIFT_CHANNEL}. Подпишитесь и нажмите «Проверить подписку» снова.`,
        { reply_markup: keyboard }
      );
      return;
    }
  } catch (err) {
    console.error('Ошибка проверки подписки:', err);
    await respondWithCaseInfo(chatId, messageId, 'free_gift', player, {
      notice: '⚠️ Не удалось проверить подписку. Попробуйте позже.'
    });
    return;
  }

  const now = Date.now();
  const lastGiftTime = Number(player.lastGiftTime) || 0;
  if (now - lastGiftTime < FREE_GIFT_COOLDOWN_MS) {
    await respondWithCaseInfo(chatId, messageId, 'free_gift', player, {
      notice: '⚠️ Вы уже забирали подарок. Загляни позже.'
    });
    return;
  }

  const picked = pickFromSubscriptionPool(CASE_TYPES.FREE_GIFT);
  if (!picked) {
    await respondWithCaseInfo(chatId, messageId, 'free_gift', player, {
      notice: '⚠️ Не удалось сгенерировать предмет. Попробуйте позже.'
    });
    return;
  }

  player.lastGiftTime = now;
  await giveItemToPlayer(chatId, player, picked, '🎁 Бесплатный подарок за подписку (раз в 24 часа)');
  saveData();
}

async function handleInviteCaseOpen({ chatId, messageId, player }) {
  const available = Number(player.inviteCasesAvailable) || 0;
  if (available <= 0) {
    await respondWithCaseInfo(chatId, messageId, 'invite', player, {
      notice: '⚠️ У вас нет доступных кейсов. Пригласите нового игрока по вашей ссылке.'
    });
    return;
  }

  const picked = pickFromSubscriptionPool(CASE_TYPES.INVITE);
  if (!picked) {
    await respondWithCaseInfo(chatId, messageId, 'invite', player, {
      notice: '⚠️ Не удалось сгенерировать предмет. Попробуйте позже.'
    });
    return;
  }

  player.inviteCasesAvailable = Math.max(0, available - 1);
  player.inviteCasesOpened = (Number(player.inviteCasesOpened) || 0) + 1;
  saveData();
  await giveItemToPlayer(chatId, player, picked, '🎁 Кейс за приглашение друга');
}

async function handleInfectionCaseOpen({ chatId, messageId, player }) {
  const cost = CASE_COSTS.infection.amount;
  const current = Number(player.infection) || 0;
  if (current < cost) {
    await respondWithCaseInfo(chatId, messageId, 'infection', player, {
      notice: '⚠️ У вас недостаточно очков заражения.'
    });
    return;
  }

  const picked = pickFromSubscriptionPool(CASE_TYPES.INFECTION);
  if (!picked) {
    await respondWithCaseInfo(chatId, messageId, 'infection', player, {
      notice: '⚠️ Не удалось сгенерировать предмет. Попробуйте позже.'
    });
    return;
  }

  player.infection = current - cost;
  saveData();
  await giveItemToPlayer(chatId, player, picked, '🎁 Кейс за очки заражения');
}

async function handleSignCaseOpen({ chatId, messageId, player }) {
  const cost = CASE_COSTS.sign.amount;
  const current = Number(player.infection) || 0;
  if (current < cost) {
    await respondWithCaseInfo(chatId, messageId, 'sign', player, {
      notice: '⚠️ У вас недостаточно очков заражения.'
    });
    return;
  }

  const picked = pickRandomSignCaseItem();
  if (!picked) {
    await respondWithCaseInfo(chatId, messageId, 'sign', player, {
      notice: '⚠️ Не удалось сгенерировать знак. Попробуйте позже.'
    });
    return;
  }

  player.infection = current - cost;
  saveData();
  await giveItemToPlayer(chatId, player, picked, '🎁 Знаки (5000 очков заражения)');
}

async function handleCrimecoinCaseOpen({ chatId, messageId, player }, caseId) {
  const costConfig = getCaseCostConfig(caseId);
  if (!costConfig) {
    await respondWithCaseInfo(chatId, messageId, caseId, player, {
      notice: '⚠️ Этот кейс временно недоступен.'
    });
    return;
  }

  const balance = Number(player.crimecoins) || 0;
  if (balance < costConfig.amount) {
    await respondWithCaseInfo(chatId, messageId, caseId, player, {
      notice: '⚠️ Недостаточно CRIMECOINS. Обратитесь к администратору за пополнением.'
    });
    return;
  }

  const caseType = caseId === 'legend' ? CASE_TYPES.LEGEND : CASE_TYPES.BASIC;
  const picked = pickCaseItem(caseType);
  if (!picked) {
    await respondWithCaseInfo(chatId, messageId, caseId, player, {
      notice: '⚠️ Не удалось сгенерировать предмет. Попробуйте позже.'
    });
    return;
  }

  player.crimecoins = balance - costConfig.amount;
  saveData();
  const title = caseId === 'legend'
    ? '💎 Вы открыли Легендарную коробку удачи!'
    : '📦 Вы открыли Базовую коробку удачи!';
  await giveItemToPlayer(chatId, player, picked, title);
}

async function handleCaseOpen(caseId, context) {
  switch (caseId) {
    case 'free_gift':
      await handleFreeGiftOpen(context);
      return;
    case 'invite':
      await handleInviteCaseOpen(context);
      return;
    case 'infection':
      await handleInfectionCaseOpen(context);
      return;
    case 'sign':
      await handleSignCaseOpen(context);
      return;
    case 'basic':
    case 'legend':
      await handleCrimecoinCaseOpen(context, caseId);
      return;
    default:
      await respondWithCaseInfo(context.chatId, context.messageId, caseId, context.player, {
        notice: '⚠️ Этот кейс недоступен.'
      });
  }
}

const storyEvents = [
  {
    title: "Старый дневник",
    text: "На лавочке лежит дневник с записями о похищениях.",
    good: "Записи вывели тебя к тайнику с ценным предметом.",
    bad: "Это была приманка — охотники чуть не поймали тебя.",
    badEffect: { type: "lose_points", amount: 50 }
  },
  {
    title: "Серебряный фургон",
    text: "Мимо проезжает фургон с затемнёнными окнами, слышны женские крики.",
    good: "Ты успел заблокировать путь и спасти девушку.",
    bad: "Это была охрана лаборатории — ты едва ушёл живым.",
    badEffect: { type: "lose_points", amount: 120 }
  },
  {
    title: "Разбитое зеркало",
    text: "В подвале — комната с разбитыми зеркалами и запахом крови.",
    good: "Ты нашёл в щели шлем.",
    bad: "На тебя напала отражённая тень, но ты сбежал.",
    badEffect: { type: "lose_points", amount: 15 }
  },
  {
    title: "Сирена в темноте",
    text: "Ты слышишь тихий женский голос, зовущий на помощь из подземного перехода.",
    good: "Ты спас девушку — она благодарит тебя и передаёт небольшой подарок.",
    bad: "Это оказалась бракованная аниме-девочка — она напала на тебя, но ты успел сбежать.",
    badEffect: { type: "lose_points", amount: 60 }
  },
  {
    title: "Красная метка",
    text: "Кто-то мелом нарисовал красную метку на стене.",
    good: "Это знак выживших — внутри тайник с гранатами.",
    bad: "Метка привлекла охотников, пришлось уходить.",
    badEffect: { type: "lose_item", slot: "extra" }
  },
  {
    title: "Шёпот за спиной",
    text: "Кто-то тихо шепчет твоё имя.",
    good: "Это была выжившая девушка, которая поделилась с тобой находкой.",
    bad: "Это были галлюцинации от газа — ты едва выбрался.",
    badEffect: { type: "lose_item", slot: "mutation" }
  },
  {
    title: "Запах духов",
    text: "В переулке пахнет сладкими духами, но никого не видно.",
    good: "Девушка пряталась от охотников и подарила тебе редкую вещь.",
    bad: "Монстр, маскирующийся под девушку, внезапно напал — но ты убежал.",
    badEffect: { type: "lose_item", slot: "armor" }
  },
  {
    title: "Стеклянная капсула",
    text: "У стены стоит треснувшая капсула, внутри — полусознанная девушка.",
    good: "Ты помог ей выбраться, она вручила необычный предмет.",
    bad: "Внутри был мутант, но ты успел скрыться.",
    badEffect: { type: "lose_item", slot: "helmet" }
  },
  {
    title: "Вечеринка с отборами",
    text: "В клубе проходит вечеринка с 'кастингом' девушек.",
    good: "Ты сорвал отбор и спас одну из них.",
    bad: "Тебя узнали и выгнали.",
    badEffect: { type: "lose_item", slot: "weapon" }
  },
  {
    title: "Визитка с розой",
    text: "На тротуаре лежит визитка с золотой розой и адресом.",
    good: "Адрес привёл к тайнику с ценным оружием.",
    bad: "Адрес оказался ловушкой вербовщиков — пришлось срочно убегать.",
    badEffect: { type: "lose_points", amount: 130 }
  }
];

const DANGER_EVENT_IMAGE_URL = "https://i.postimg.cc/nLBcv1NT/image.jpg";
const DANGER_EVENT_CHANCE = 0.1;
const DANGER_EVENT_ITEM_CHANCE = 0.12;

const SUPPLY_DROP_CHANCE = 0.12;
const RESCUE_EVENT_CHANCE = 0.01;
const RESCUE_EVENT_IMAGE_URL = 'https://i.postimg.cc/hjWYNzsW/photo-2025-10-06-02-06-28.jpg';
const HUNT_RARE_RAID_CHANCE = 0.05;
const HUNT_RARE_RAID_IMAGE_URL = 'https://i.postimg.cc/CL0dDqSn/1600ec0e-5e77-4f6f-859f-a8dbbd7e3da6.png';
const MEDKIT_IMAGE_URL = "https://i.postimg.cc/C5qk2Xwx/photo-2025-09-23-22-52-00.jpg";
const FOOD_IMAGE_URL = "https://i.postimg.cc/bN022QJk/photo-2025-09-23-22-49-42.jpg";
const SPECIAL_SUBJECT_CHANCE = 0.01;
const SPECIAL_SUBJECT_IMAGE_URL = "https://i.postimg.cc/9QMxrt0s/photo-2025-10-06-03-03-40.jpg";
const SPECIAL_SUBJECT_HP = 2222;
const SPECIAL_SUBJECT_DMG = 333;
const SPECIAL_SUBJECT_INFECTION_REWARD = 200;
const SPECIAL_SUBJECT_INFECTION_LOSS = 100;
const MEDKIT_HEAL = 100;
const FOOD_HEAL = 30;

const dangerScenarios = [
  {
    id: "metro",
    title: "Метро",
    intro: "Ты приходишь в себя в тёмных коридорах метро. В голове шумит, мысли путаются.\nС каждой секундой, проведённой здесь, тебя начинает поглощать безумие.\nТебе нужно выбраться наружу, пока разум окончательно не помутнел…",
    success: "Ты видишь впереди свет. Сердце замирает, шаги ускоряются.\nС каждым мгновением воздух становится свежее, темнота остаётся позади.\nТы выбираешься наружу. Свежий ветер обжигает лицо — ты выжил.",
    failure: "Тьма вокруг сгущается, дыхание становится рваным.\nСилы покидают тебя, и последние мысли тонут в хаосе.\nМетро забирает тебя навсегда.",
    branches: [
      {
        id: "escalator",
        name: "Эскалатор",
        steps: [
          [
            "К турникетам (ржавые створки, проход узкий)",
            "К служебным дверям (металлические, облупившаяся краска)",
            "Через дыру в стене (тесный пролом, пахнет сыростью)"
          ],
          [
            "В кассовый зал (стойки, мусор под ногами)",
            "В коридор охраны (с потолка свисают кабели)",
            "В техническую нишу (трубы, вентили, запах сырости)"
          ],
          [
            "К вестибюлю (широкий холл, эхо шагов)",
            "На лестницу наружу (крутые ступени, сквозняк)",
            "На чердачную площадку (старые перекрытия, ветер усиливается)"
          ]
        ]
      },
      {
        id: "rails",
        name: "По рельсам",
        steps: [
          [
            "К платформе (края осыпаются, густая темнота)",
            "В обходную галерею (узкий мостик вдоль стены)",
            "К дренажному люку (шум воды, влажные стены)"
          ],
          [
            "В технический тоннель (аварийные огни, кабель-каналы)",
            "В служебную комнату (шкафчики, старые бумаги)",
            "Через перекидной мост (шатающийся настил над ямой)"
          ],
          [
            "К вентшахте (поток холодного воздуха)",
            "К сигнальному посту (пульт с мигающими лампами)",
            "К зоне размыва (грязь, обрушенные шпалы)"
          ]
        ]
      },
      {
        id: "passage",
        name: "Переход",
        steps: [
          [
            "В подземный коридор (длинный, стены в налёте)",
            "К служебной двери (перекошенная, петли скрипят)",
            "В вентиляционный проём (тесный, пахнет пылью)"
          ],
          [
            "К узловой развязке (несколько ответвлений, схемы на стенах)",
            "На склад хлама (ящики, разбросанный инвентарь)",
            "В обходной лаз (низкий, приходится ползти)"
          ],
          [
            "На лестницу к выходу (ступени вверх, слышен шум снаружи)",
            "К двери на улицу (тяжёлая створка, сквозняк)",
            "В аварийный лаз (жёлтая маркировка, резкий ветер)"
          ]
        ]
      }
    ]
  },
  {
    id: "mall",
    title: "Торговый центр",
    intro: "Ты приходишь в себя на холодном кафеле. Над головой мигает лампа, но света от неё почти нет.\nВокруг — разрушенный торговый центр: витрины разбиты, тишину нарушает лишь скрип металлоконструкций.\nС каждой секундой здесь становится всё холоднее и опаснее.\nТебе нужно найти выход, пока ты не сошёл с ума.",
    success: "Ты пробираешься через очередной пролом и видишь впереди яркий свет.\nХолодный воздух и запах улицы наполняют лёгкие.\nТы выбрался из заброшенного центра. Ты спасён.",
    failure: "Пыль и бетонная крошка забивают дыхание.\nСилы покидают тебя, и последние мысли тонут в темноте.",
    branches: [
      {
        id: "escalator_mall",
        name: "Эскалатор",
        steps: [
          [
            "К сломанным турникетам (каркас искорёженный, проход узкий)",
            "К служебным дверям (выбитые, краска облупилась)",
            "Через пролом в стене (дыра ведёт в соседний зал, пахнет гарью)"
          ],
          [
            "В кассовую зону супермаркета (пустые стойки, разбросанные чеки)",
            "В коридор охраны (разбитые камеры, провода торчат из стен)",
            "В техническое помещение (трубы, запах сырости, ржавчина)"
          ],
          [
            "К главному вестибюлю (разбитые витрины, эхо шагов)",
            "На лестницу к верхнему этажу (ступени поломаны, но ведут вверх)",
            "На технический балкон (пыльные конструкции, сквозняк усиливается)"
          ]
        ]
      },
      {
        id: "shops",
        name: "По рядам магазинов",
        steps: [
          [
            "К обувному магазину (выбиты витрины, кучи хлама)",
            "В проход к фуд-корту (разваленные столы и стулья)",
            "В сторону кинотеатра (афиши облезли, темнота густая)"
          ],
          [
            "В склад продуктового (ящики, банки, запах гнили)",
            "В игровую зону (разбитые автоматы, игрушки валяются на полу)",
            "Через аварийный коридор (узкий, мигает аварийная лампа)"
          ],
          [
            "К служебной лестнице (бетон в трещинах, наверху светлее)",
            "В зал с фонтаном (вода застоялась, плитка скользкая)",
            "В боковой коридор (длинный, обрывки рекламы на стенах)"
          ]
        ]
      },
      {
        id: "parking",
        name: "Парковка",
        steps: [
          [
            "В подземный гараж (разрушенные машины, запах бензина)",
            "К грузовым воротам (огромные створки, заржавели)",
            "В вентиляционный проём (узкий ход, пыль и паутина)"
          ],
          [
            "В технический коридор (бетонные стены, капает вода)",
            "В кладовую (старые ящики, металлический запах)",
            "В обходной туннель (низкий, приходится пригибаться)"
          ],
          [
            "На пандус к улице (наклон вверх, чувствуется ветер)",
            "К запасному выходу (дверь перекошена, но из щели свет)",
            "В аварийный лаз (обозначен жёлтой краской, слышен шум снаружи)"
          ]
        ]
      }
    ]
  }
];

function applyBadEffect(player, badEffect) {
  if (!player || !badEffect) return;
  if (badEffect.type === "lose_points") {
    player.infection = Math.max(0, (player.infection || 0) - (badEffect.amount || 0));
  } else if (badEffect.type === "lose_item" && badEffect.slot) {
    if (player.inventory && player.inventory[badEffect.slot]) {
      player.inventory[badEffect.slot] = null;
      if (badEffect.slot === "sign") {
        resetPlayerSignFlags(player);
      }
    }
  }
}

function getDangerScenarioById(id) {
  return dangerScenarios.find((scenario) => scenario.id === id) || dangerScenarios[0];
}

function getDangerBranch(scenario, branchId) {
  if (!scenario) return null;
  return scenario.branches.find((branch) => branch.id === branchId) || scenario.branches[0];
}

function getDangerOptions(branch, step) {
  if (!branch || !Array.isArray(branch.steps) || branch.steps.length === 0) return [];
  if (step <= branch.steps.length) {
    return branch.steps[step - 1];
  }
  return branch.steps[branch.steps.length - 1];
}

function getDangerExitChance(step) {
  if (step <= 1) return 0.10;
  if (step === 2) return 0.30;
  if (step === 3) return 0.60;
  const extra = 0.60 + 0.10 * (step - 3);
  return Math.min(extra, 0.70);
}

function getDangerStepDamage(player) {
  if (!player) return 0;
  const baseMaxHp = typeof player.maxHp === "number" && player.maxHp > 0 ? player.maxHp : 100;
  const damage = Math.max(1, Math.ceil(baseMaxHp * 0.34));
  if (typeof player.hp !== "number") player.hp = baseMaxHp;
  player.hp = Math.max(0, player.hp - damage);
  return damage;
}

function buildDangerKeyboard(options) {
  if (!options || options.length === 0) {
    return { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] };
  }
  return {
    inline_keyboard: options.map((opt, idx) => [{ text: opt, callback_data: `danger_move:${idx}` }])
  };
}

async function startDangerEvent(player, chatId) {
  if (!player) return;
  applyArmorHelmetBonuses(player);
  const scenario = dangerScenarios[Math.floor(Math.random() * dangerScenarios.length)];
  const branch = scenario.branches[Math.floor(Math.random() * scenario.branches.length)];
  player.monster = null;
  player.currentEvent = null;
  player.currentDanger = { scenarioId: scenario.id, branchId: branch.id, step: 1 };
  const options = getDangerOptions(branch, 1);
  const caption = [
    `⚠️ *Опасное событие*: ${escMd(scenario.title)}`,
    "",
    `${escMd(scenario.intro)}`,
    "",
    `❤️ HP: ${player.hp}/${player.maxHp}`,
    "🧭 Шаг 1 — выбери направление:"
  ].join("\n");
  const sent = await bot.sendPhoto(chatId, DANGER_EVENT_IMAGE_URL, {
    caption,
    parse_mode: "Markdown",
    reply_markup: buildDangerKeyboard(options)
  });
  player.currentDangerMsgId = sent.message_id;
  saveData();
}

async function continueDangerEvent(player, chatId, messageId, choiceIndex) {
  if (!player || !player.currentDanger) return;
  const state = player.currentDanger;
  const scenario = getDangerScenarioById(state.scenarioId);
  const branch = getDangerBranch(scenario, state.branchId);
  const currentOptions = getDangerOptions(branch, state.step);
  const targetMessageId = player.currentDangerMsgId || messageId;
  if (!scenario || !branch || currentOptions.length === 0) {
    player.currentDanger = null;
    player.currentDangerMsgId = null;
    saveData();
    await bot.editMessageCaption("⚠️ Сценарий прерван.", {
      chat_id: chatId,
      message_id: targetMessageId,
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] }
    }).catch(()=>{});
    return;
  }

  const idx = Number(choiceIndex);
  const optionText = currentOptions[idx] || currentOptions[0];
  const damage = getDangerStepDamage(player);
  const exitChance = getDangerExitChance(state.step);
  const baseCaption = `⚠️ *Опасное событие*: ${escMd(scenario.title)} — ${escMd(branch.name)}`;

  if (player.hp <= 0) {
    player.infection = Math.max(0, (player.infection || 0) - 100);
    resetSurvivalProgress(player);
    applyArmorHelmetBonuses(player);
    player.hp = player.maxHp;
    player.currentDanger = null;
    player.currentDangerMsgId = null;
    saveData();
    const failureText = [
      baseCaption,
      "",
      `${escMd(scenario.failure)}`,
      "",
      "☣️ Ты потерял 100 заражения.",
      "🗓 Дни выживания обнулились."
    ].filter(Boolean).join("\n");
    await bot.editMessageCaption(failureText, {
      chat_id: chatId,
      message_id: targetMessageId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] }
    }).catch(()=>{});
    return;
  }

  if (Math.random() < exitChance) {
    player.infection = (player.infection || 0) + 100;
    player.currentDanger = null;
    player.currentDangerMsgId = null;
    let successText = [
      baseCaption,
      "",
      `${escMd(scenario.success)}`,
      "",
      "☣️ Ты получил 100 заражения."
    ].join("\n");
    const survivalMessage = grantSurvivalDay(player);
    if (survivalMessage) {
      successText += `\n\n${survivalMessage}`;
    }
    let replyMarkup = { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] };
    if (Math.random() < DANGER_EVENT_ITEM_CHANCE) {
      const dropPool = [
        ...weaponItems.map(it => ({ ...it, kind: "weapon" })),
        ...helmetItems.map(it => ({ ...it, kind: "helmet" })),
        ...mutationItems.map(it => ({ ...it, kind: "mutation" })),
        ...extraItems.map(it => ({ ...it, kind: "extra" })),
        ...armorItems.map(it => ({ ...it, kind: "armor" }))
      ];
      const picked = pickByChance(dropPool);
      if (picked) {
        player.pendingDrop = { ...picked };
        const rewardText = formatItemRewardMessage(picked);
        successText += `\n\n${rewardText}\nЧто делаем?`;
        replyMarkup = {
          inline_keyboard: [
            [{ text: "✅ Взять", callback_data: "take_drop" }],
            [{ text: "🗑️ Выбросить", callback_data: "discard_drop" }]
          ]
        };
      }
    }
    saveData();
    await bot.editMessageCaption(successText, {
      chat_id: chatId,
      message_id: targetMessageId,
      parse_mode: "Markdown",
      reply_markup: replyMarkup
    }).catch(()=>{});
    return;
  }

  state.step += 1;
  const nextOptions = getDangerOptions(branch, state.step);
  const nextChance = Math.round(getDangerExitChance(state.step) * 100);
  const continueText = [
    baseCaption,
    "",
    `Ты выбрал: ${escMd(optionText)}.`,
    `💢 Потеряно HP: ${damage} (осталось ${player.hp}/${player.maxHp}).`,
    `🚪 Выход не найден. Шанс найти выход теперь: ${nextChance}%.`,
    "",
    `🧭 Шаг ${state.step} — выбери направление:`
  ].join("\n");
  saveData();
  await bot.editMessageCaption(continueText, {
    chat_id: chatId,
    message_id: targetMessageId,
    parse_mode: "Markdown",
    reply_markup: buildDangerKeyboard(nextOptions)
  }).catch(()=>{});
}

// ---- Utilities ----
function pickByChance(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const total = arr.reduce((s, it) => s + (it.chance || 0), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const it of arr) {
    r -= (it.chance || 0);
    if (r <= 0) return it;
  }
  return null;
}

function pickRandomItem(items) {
  const picked = pickByChance(items);
  if (!picked) return null;
  const { chance, ...rest } = picked;
  return { ...rest };
}

function pickRandomSign(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const normalized = items.map(({ chance, ...rest }) => ({ ...rest }));
  const randomIndex = Math.floor(Math.random() * normalized.length);
  return { ...normalized[randomIndex] };
}

function pickRankedItem(items, stage) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const normalized = items.map(({ chance, ...rest }) => ({ ...rest }));
  const maxIndex = normalized.length - 1;
  if (maxIndex < 0) return null;

  if (stage <= maxIndex) {
    const minIndex = Math.max(0, stage - 1);
    const maxPick = Math.min(maxIndex, stage + 1);
    const pool = normalized.slice(minIndex, maxPick + 1);
    return { ...pool[Math.floor(Math.random() * pool.length)] };
  }

  const degradeSpan = Math.min(3, maxIndex);
  const start = Math.max(0, maxIndex - degradeSpan);
  const pool = normalized.slice(start);
  return { ...pool[Math.floor(Math.random() * pool.length)] };
}

function pickRankedSign(items, stage) {
  if (!Array.isArray(items) || items.length === 0) return null;
  if (stage <= 1) return null;

  const normalized = items.map(({ chance, ...rest }) => ({ ...rest }));
  const maxIndex = normalized.length - 1;
  if (maxIndex < 0) return null;

  const targetIndex = Math.min(maxIndex, stage - 1);
  const start = Math.max(0, targetIndex - 1);
  const end = Math.min(maxIndex, targetIndex + 1);
  const pool = normalized.slice(start, end + 1);
  if (pool.length === 0) return null;
  return { ...pool[Math.floor(Math.random() * pool.length)] };
}

function generateRandomOpponentPlayer() {
  const randomId = Math.floor(Math.random() * 9_000_000) + 1_000_000;
  const username = `id${randomId}`;

  const inventory = {
    armor: pickRandomItem(armorItems),
    helmet: pickRandomItem(helmetItems),
    weapon: pickRandomItem(weaponItems),
    mutation: pickRandomItem(mutationItems),
    extra: pickRandomItem(extraItems)
  };

  if (Math.random() < RANDOM_PVP_SIGN_CHANCE) {
    inventory.sign = pickRandomSign(signItems);
  } else {
    inventory.sign = null;
  }

  const opponent = {
    id: 7_000_000_000 + randomId,
    username,
    name: username,
    hp: 100,
    maxHp: 100,
    infection: Math.floor(Math.random() * 5000),
    clanId: null,
    inventory,
    monster: null,
    monsterStun: 0,
    damageBoostTurns: 0,
    damageReductionTurns: 0,
    radiationBoost: false,
    firstAttack: true,
    lastHunt: 0,
    pendingDrop: null,
    pvpWins: Math.floor(Math.random() * 50),
    pvpLosses: Math.floor(Math.random() * 50),
    lastGiftTime: 0,
    huntCooldownWarned: false
  };

  applyArmorHelmetBonuses(opponent);
  opponent.hp = opponent.maxHp;
  return opponent;
}

function generateRankedOpponentPlayer(player) {
  const baseRating = Number.isFinite(player?.pvpRating) ? player.pvpRating : 0;
  const stage = Math.max(0, Math.floor(baseRating / RANKED_PVP_RATING_REWARD));
  const randomId = Math.floor(Math.random() * 9_000_000) + 1_000_000;
  const username = `ranked_${stage}_${randomId}`;

  const inventory = {
    armor: pickRankedItem(armorItems, stage),
    helmet: pickRankedItem(helmetItems, stage),
    weapon: pickRankedItem(weaponItems, stage),
    mutation: pickRankedItem(mutationItems, stage),
    extra: pickRankedItem(extraItems, stage),
    sign: pickRankedSign(signItems, stage)
  };

  const opponent = {
    id: 8_000_000_000 + randomId,
    username,
    name: username,
    hp: 100,
    maxHp: 100,
    infection: Math.max(0, stage * 500 + Math.floor(Math.random() * 500)),
    clanId: null,
    inventory,
    monster: null,
    monsterStun: 0,
    damageBoostTurns: 0,
    damageReductionTurns: 0,
    radiationBoost: false,
    firstAttack: true,
    lastHunt: 0,
    pendingDrop: null,
    pvpWins: Math.floor(stage / 2) + Math.floor(Math.random() * (stage + 1)),
    pvpLosses: Math.floor(Math.random() * Math.max(1, stage + 1)),
    lastGiftTime: 0,
    huntCooldownWarned: false,
    isRankedBot: true,
    rankedStage: stage
  };

  applyArmorHelmetBonuses(opponent);
  opponent.hp = opponent.maxHp;
  return opponent;
}

async function editOrSend(chatId, messageId, text, options = {}) {
  const { reply_markup } = options;
  const parseMode = Object.prototype.hasOwnProperty.call(options, 'parse_mode') ? options.parse_mode : 'Markdown';
  const messageOptions = {};
  if (reply_markup) messageOptions.reply_markup = reply_markup;
  if (parseMode) messageOptions.parse_mode = parseMode;

  try {
    if (messageId) {
      const editParams = { chat_id: chatId, message_id: messageId };
      if (reply_markup) editParams.reply_markup = reply_markup;
      if (parseMode) editParams.parse_mode = parseMode;
      await bot.editMessageText(text, editParams);
      return;
    } else {
      await bot.sendMessage(chatId, text, messageOptions);
      return;
    }
  } catch (e) {
    await bot.sendMessage(chatId, text, messageOptions);
    return;
  }
}

function pvpMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "💬 PvP в чате", callback_data: "pvp_chat" }],
      [{ text: "🤖 Поиск противника", callback_data: "pvp_find" }],
      [{ text: "🥇 Рейтинговый PVP", callback_data: "pvp_ranked" }],
      [{ text: "⬅️ Назад", callback_data: "play" }]
    ]
  };
}

function getCaseLabel(caseId) {
  return CASE_LABELS[caseId] || 'кейс';
}

function buildCaseDropPool(caseType, { includeSigns = false } = {}) {
  return getCaseItems(caseType, { includeSigns });
}

function pickCaseItem(caseType, { includeSigns = false } = {}) {
  const dropPool = buildCaseDropPool(caseType, { includeSigns });
  if (!Array.isArray(dropPool) || dropPool.length === 0) {
    return null;
  }

  if (caseType === CASE_TYPES.SIGN || caseType === CASE_TYPES.LEGEND) {
    const idx = Math.floor(Math.random() * dropPool.length);
    const selected = dropPool[idx];
    return selected ? { ...selected } : null;
  }

  let picked = pickByChance(dropPool);
  if (!picked) {
    const fallback = dropPool[Math.floor(Math.random() * dropPool.length)];
    picked = fallback || null;
  }
  return picked ? { ...picked } : null;
}

function pickFromSubscriptionPool(caseType = CASE_TYPES.FREE_GIFT) {
  return pickCaseItem(caseType);
}

const CASE_PREVIEW_KIND_ORDER = ['weapon', 'armor', 'helmet', 'mutation', 'extra', 'sign'];
const CASE_PREVIEW_RARITY_ORDER = ['legendary', 'very_rare', 'rare', 'common'];

function resolveRarityKey(rarity) {
  if (!rarity) return null;
  if (rarity.key && typeof rarity.key === 'string') {
    return rarity.key.trim().toLowerCase();
  }
  if (rarity.label && typeof rarity.label === 'string') {
    const normalizedLabel = rarity.label.trim().toLowerCase();
    if (ITEM_RARITY_LABEL_TO_KEY.has(normalizedLabel)) {
      return ITEM_RARITY_LABEL_TO_KEY.get(normalizedLabel);
    }
  }
  return null;
}

function getCasePreviewSortMeta(item) {
  const rarity = resolveItemRarity(item);
  const rarityKey = resolveRarityKey(rarity);
  const rarityIndex = rarityKey ? CASE_PREVIEW_RARITY_ORDER.indexOf(rarityKey) : -1;
  const rank = rarityIndex === -1 ? CASE_PREVIEW_RARITY_ORDER.length : rarityIndex;
  const chance = Number.isFinite(item?.chance) ? item.chance : Number.POSITIVE_INFINITY;
  return { rank, chance };
}

function formatCasePreviewLine(item) {
  const rarity = resolveItemRarity(item);
  const rarityEmoji = rarity && rarity.key ? ITEM_RARITY_EMOJI[rarity.key] || '' : '';
  const rarityLabel = rarity && rarity.label ? rarity.label : '';
  const emojiPart = rarityEmoji ? `${rarityEmoji} ` : '';
  const namePart = `*${escMd(item.name)}*`;
  const rarityPart = rarityLabel ? ` (${rarityLabel})` : '';
  return `• ${emojiPart}${namePart}${rarityPart}`;
}

function buildCasePreviewText(caseId) {
  const label = getCaseLabel(caseId);
  const includeSigns = caseId === CASE_TYPES.SIGN;
  const items = getCaseItems(caseId, { includeSigns });

  const header = `👀 *Предметы кейса «${escMd(label)}»*`;
  if (!items || items.length === 0) {
    return `${header}\n\nПока список пуст.`;
  }

  const byKind = new Map();
  for (const item of items) {
    const kind = item.kind || 'other';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(item);
  }

  const sections = [];
  for (const kind of CASE_PREVIEW_KIND_ORDER) {
    if (!byKind.has(kind)) continue;
    const list = byKind
      .get(kind)
      .slice()
      .sort((a, b) => {
        const rarityA = getCasePreviewSortMeta(a);
        const rarityB = getCasePreviewSortMeta(b);
        if (rarityA.rank !== rarityB.rank) {
          return rarityA.rank - rarityB.rank;
        }
        if (rarityA.chance !== rarityB.chance) {
          return rarityA.chance - rarityB.chance;
        }
        const nameA = String(a.name || '').toLocaleLowerCase('ru');
        const nameB = String(b.name || '').toLocaleLowerCase('ru');
        return nameA.localeCompare(nameB, 'ru');
      });
    const kindLabel = getItemKindLabel(kind) || kind;
    const lines = list.map((item) => formatCasePreviewLine(item));
    sections.push(`*${escMd(capitalizeFirst(kindLabel))}*\n${lines.join('\n')}`);
  }

  const body = sections.join('\n\n');
  let footer = '';
  if (caseId === CASE_TYPES.LEGEND) {
    footer = '\n\nℹ️ Все предметы из легендарного кейса выпадают с равной вероятностью.';
  } else if (caseId === CASE_TYPES.SIGN) {
    footer = '\n\nℹ️ Все знаки из этого кейса выпадают с одинаковым шансом.';
  } else {
    footer = '\n\nℹ️ Чем выше редкость предмета, тем ниже шанс его получить.';
  }

  return body ? `${header}\n\n${body}${footer}` : `${header}\n\nℹ️ Этот кейс пока не настроен.`;
}

function findItemByName(name) {
  if (!name) return null;
  const allPools = [
    ...weaponItems.map(i => ({ ...i, kind: "weapon" })),
    ...armorItems.map(i => ({ ...i, kind: "armor" })),
    ...helmetItems.map(i => ({ ...i, kind: "helmet" })),
    ...mutationItems.map(i => ({ ...i, kind: "mutation" })),
    ...extraItems.map(i => ({ ...i, kind: "extra" })),
    ...signItems.map(i => ({ ...i, kind: "sign" }))
  ];
  const lower = String(name).toLowerCase();
  return allPools.find(it => String(it.name).toLowerCase() === lower) || null;
}

async function giveItemToPlayer(chatId, player, item, sourceText = "") {
  if (!player || !item) return;
  player.pendingDrop = { ...item };
  saveData();
  const rewardText = formatItemRewardMessage(item);
  const prefix = sourceText ? `${sourceText}\n\n` : "";
  const text = `${prefix}${rewardText}\nЧто делаем?`;
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "✅ Взять", callback_data: "take_drop" }],[{ text: "🗑️ Выбросить", callback_data: "discard_drop" }],[{ text: "⬅️ В меню", callback_data: "play" }]] }
  });
}

// ---- Monsters (PvE) ----
function spawnMonster() {
  const roll = Math.random() * 100;
  let hp, dmg, type;
  if (roll < 80) {
    hp = Math.floor(Math.random() * 81) + 50;
    dmg = Math.floor(Math.random() * 16) + 11;
    type = "weak";
  } else if (roll < 96) {
    hp = Math.floor(Math.random() * 200) + 201;
    dmg = Math.floor(Math.random() * 36) + 51;
    type = "medium";
  } else {
    hp = Math.floor(Math.random() * 200) + 701;
    dmg = Math.floor(Math.random() * 51) + 301;
    type = "fat";
  }
  return { id: Math.floor(Math.random() * 999) + 1, hp, maxHp: hp, dmg, type };
}

// ---- PvP (kept from original, may be reused) ----
const pvpRequests = {};

setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(pvpRequests)) {
    const req = pvpRequests[key];
    if (!req) { delete pvpRequests[key]; continue; }
    if (now - req.ts > PVP_REQUEST_TTL) {
      const delKeys = [String(req.challengerId)];
      if (req.username) delKeys.push(`@${req.username}`, req.username);
      delKeys.forEach(k => { if (pvpRequests[k]) delete pvpRequests[k]; });
    }
  }
}, 15 * 1000);

function clearExistingPvpState(player) {
  if (!player || !player.pvp) return;
  const opponentId = player.pvp?.opponentId;
  if (opponentId != null) {
    const opponentKey = String(opponentId);
    if (players && Object.prototype.hasOwnProperty.call(players, opponentKey)) {
      const opponent = players[opponentKey];
      if (opponent && opponent.pvp && String(opponent.pvp?.opponentId) === String(player.id)) {
        delete opponent.pvp;
      }
    }
  }
  delete player.pvp;
}

function initPvpState(challenger, opponent) {
  if (!challenger || !opponent) return false;
  clearExistingPvpState(challenger);
  clearExistingPvpState(opponent);
  applyArmorHelmetBonuses(challenger);
  applyArmorHelmetBonuses(opponent);
  resetPlayerSignFlags(challenger);
  resetPlayerSignFlags(opponent);

  challenger.pvp = {
    opponentId: opponent.id,
    myHp: challenger.maxHp,
    oppHp: opponent.maxHp,
    myStun: 0,
    oppStun: 0,
    myDamageBoostTurns: 0,
    oppDamageBoostTurns: 0,
    myDamageReductionTurns: 0,
    oppDamageReductionTurns: 0,
    myRadiationBoost: false,
    oppRadiationBoost: false,
    turn: "me",
    signRadiationUsed: false,
    signFinalUsed: false
  };

  opponent.pvp = {
    opponentId: challenger.id,
    myHp: opponent.maxHp,
    oppHp: challenger.maxHp,
    myStun: 0,
    oppStun: 0,
    myDamageBoostTurns: 0,
    oppDamageBoostTurns: 0,
    myDamageReductionTurns: 0,
    oppDamageReductionTurns: 0,
    myRadiationBoost: false,
    oppRadiationBoost: false,
    turn: "opponent",
    signRadiationUsed: false,
    signFinalUsed: false
  };

  saveData();
  return true;
}

function applyExtraEffect(extra, sourcePvpState, targetPvpState, actor, target, events) {
  if (!extra) return;
  if (extra.effect === "stun2") {
    targetPvpState.myStun = (extra.turns || 2);
    events.push(`🧨 ${actor.username} использует ${escMd(extra.name)}: соперник оглушён на ${targetPvpState.myStun} ход(ов).`);
  } else if (extra.effect === "damage50") {
    targetPvpState.myHp -= 50;
    events.push(`💥 ${actor.username} использует ${escMd(extra.name)}: наносит 50 урона сопернику.`);
  } else if (extra.effect === "damage100") {
    targetPvpState.myHp -= 100;
    events.push(`💥 ${actor.username} использует ${escMd(extra.name)}: наносит 100 урона сопернику.`);
  } else if (extra.effect === "halfDamage1") {
    sourcePvpState.myDamageReductionTurns = (extra.turns || 1);
    events.push(`💪 ${actor.username} использует ${escMd(extra.name)}: входящий урон /2 на ${sourcePvpState.myDamageReductionTurns} ход(ов).`);
  } else if (extra.effect === "doubleDamage1") {
    sourcePvpState.myDamageBoostTurns = (extra.turns || 1);
    events.push(`⚡ ${actor.username} использует ${escMd(extra.name)}: урон x2 на ${sourcePvpState.myDamageBoostTurns} ход(ов).`);
  } else if (extra.effect === "doubleInfection") {
    sourcePvpState.myRadiationBoost = true;
    events.push(`☣️ ${actor.username} использует ${escMd(extra.name)}: следующая победа даст двойное заражение.`);
  }
}

function computeAttackForPvp(attacker, defender, attackerPvpState, defenderPvpState) {
  const events = [];
  const attackerSign = attacker.inventory && attacker.inventory.sign ? attacker.inventory.sign : null;
  const defenderSign = defender.inventory && defender.inventory.sign ? defender.inventory.sign : null;
  const attackerSignEffects = getSignEffects(attackerSign);
  const defenderSignEffects = getSignEffects(defenderSign);

  // extra (30% шанс)
  if (attacker.inventory && attacker.inventory.extra && Math.random() < 0.3) {
    applyExtraEffect(attacker.inventory.extra, attackerPvpState, defenderPvpState, attacker, defender, events);
  }

  // weapon + base roll
  const weaponName = attacker.inventory && attacker.inventory.weapon ? attacker.inventory.weapon.name : "кулаки";
  const weaponBonus = attacker.inventory && attacker.inventory.weapon ? (attacker.inventory.weapon.dmg || 0) : 0;
  const baseRoll = Math.floor(Math.random() * 30) + 10;
  let damage = baseRoll + weaponBonus;
  const baseDamage = damage;

  // crit
  if (attacker.inventory && attacker.inventory.mutation && attacker.inventory.mutation.crit) {
    if (Math.random() < attacker.inventory.mutation.crit) {
      damage *= 2;
      events.push(`💥 Крит! ${attacker.username} (${weaponName}) наносит ${damage} урона (x2 от ${baseDamage}).`);
    }
  }

  // damage boosts / reductions
  if (attackerPvpState.myDamageBoostTurns && attackerPvpState.myDamageBoostTurns > 0) {
    damage *= 2;
    attackerPvpState.myDamageBoostTurns--;
    events.push(`⚡ ${attacker.username} имеет бонус x2 урон на этот ход.`);
  }
  if (defenderPvpState.myDamageReductionTurns && defenderPvpState.myDamageReductionTurns > 0) {
    damage = Math.ceil(damage / 2);
    defenderPvpState.myDamageReductionTurns--;
    events.push(`💪 ${defender.username} уменьшает входящий урон вдвое.`);
  }

  let dodgedBySign = false;
  if (defenderSignEffects.dodgeChance > 0 && Math.random() < defenderSignEffects.dodgeChance) {
    dodgedBySign = true;
    damage = 0;
    events.push(`🌀 ${defender.username} увернулся благодаря ${defenderSign ? escMd(defenderSign.name) : "знаку"}!`);
  }

  if (!dodgedBySign) {
    const helmetBlock = defender.inventory && defender.inventory.helmet ? (defender.inventory.helmet.block || 0) : 0;
    if (helmetBlock > 0) {
      const blocked = Math.ceil(damage * helmetBlock / 100);
      damage -= blocked;
      events.push(`🪖 ${defender.username} шлем блокирует ${blocked} урона (${helmetBlock}%).`);
    }
  }

  if (damage < 0) damage = 0;
  defenderPvpState.myHp -= damage;
  events.push(`⚔️ ${attacker.username} атакует из ${weaponName}: ${damage} урона.`);

  if (damage > 0 && attackerSignEffects.vampirism > 0) {
    const healAmount = Math.max(1, Math.ceil(damage * attackerSignEffects.vampirism));
    const beforeHp = attackerPvpState.myHp;
    attackerPvpState.myHp = Math.min(attacker.maxHp, attackerPvpState.myHp + healAmount);
    const actualHeal = attackerPvpState.myHp - beforeHp;
    if (actualHeal > 0) {
      events.push(`🩸 ${attacker.username} восстанавливает ${actualHeal} HP благодаря ${attackerSign ? escMd(attackerSign.name) : "знаку"}.`);
    }
  }

  if (defenderPvpState.myHp <= 0) {
    const revived = tryUseSignProtectionPvp(defender, defenderPvpState, defenderSign, events, attacker, attackerPvpState);
    if (revived && defenderPvpState.myHp > 0) {
      // ensure we don't report defender as dead yet
    }
  }

  return events;
}

// ---- Clan battle queue/state ----
const clanBattleQueue = {}; // clanId -> array of playerId (strings)
let clanBattleCountdown = null;
let clanBattleCountdownMsg = null;
let pendingCountdownForClans = null; // [clanAId, clanBId]

// ---- Raid mission configuration ----
const clanRaidMissions = Object.create(null); // clanId -> state
const RAID_MAX_PLAYERS = 5;
const RAID_LOBBY_DURATION_MS = 130 * 1000;
const RAID_DEFAULT_MEDKIT_CHANCE = 0.2;
const RAID_INTELLECT_MEDKIT_CHANCE = 0.7;
const RAID_MEDKIT_HEAL = 200;
const RAID_STYLE_IMAGE = 'https://i.postimg.cc/9XJpSBNK/photo-2025-10-03-06-43-43.jpg';

const RAID_STYLE_OPTIONS = {
  stealth: { key: 'stealth', label: 'Скрытность', display: 'Скрытность', emoji: '🔵' },
  intellect: { key: 'intellect', label: 'Интелект', display: 'Интелект', emoji: '🟡' },
  aggression: { key: 'aggression', label: 'Агрессия', display: 'Агрссия', emoji: '🔴' }
};
const RAID_AGGRESSION_DAMAGE_REDUCTION_CHANCE = 0.5;
const RAID_AGGRESSION_DAMAGE_REDUCTION_FACTOR = 0.75;
const RAID_MESSAGE_DELAY_MS = 2000;

const RAID_STAGES = [
  {
    index: 1,
    key: 'stage1',
    type: 'battle',
    reward: 100,
    introImage: 'https://i.postimg.cc/qRQ8PkQb/photo-2025-10-03-06-09-45.jpg',
    introText: '1я комната подвала\n🩸 Ты встретил Зараженные крысы\nHP: 370/370\nУрон: 30',
    enemyName: 'Зараженные крысы',
    enemyHp: 370,
    enemyDamage: 30
  },
  {
    index: 2,
    key: 'stage2',
    type: 'battle',
    reward: 350,
    introImage: 'https://i.postimg.cc/PxFCbN2B/photo-2025-10-03-06-09-49.jpg',
    introText: '2я комната подвала\n🩸 Ты встретил Скауты\nHP: 1650/1650\nУрон: 320',
    enemyName: 'Скауты',
    enemyHp: 1650,
    enemyDamage: 320
  },
  {
    index: 3,
    key: 'stage3',
    type: 'choice',
    reward: 700,
    choiceImage: 'https://i.postimg.cc/zD6LVbLB/photo-2025-10-03-06-09-46.jpg',
    choiceText: '3я комната подвала\n🩸 Ты встретил Компьютер',
    battleImage: 'https://i.postimg.cc/vZdctJtg/photo-2025-10-03-06-09-50.jpg',
    battleText: '3я комната подвала\n🩸 Ты встретил Компьютер\nHP: 3000/3000\nУрон: 440',
    enemyName: 'Компьютер',
    enemyHp: 3000,
    enemyDamage: 440,
    stealthChanceDefault: 0.1,
    stealthChanceStealth: 0.7
  },
  {
    index: 4,
    key: 'stage4',
    type: 'battle',
    reward: 1500,
    introImage: 'https://i.postimg.cc/VNfv3XTk/photo-2025-10-03-06-09-44.jpg',
    introText: '4я комната подвала\n🩸 Ты встретил Охрана\nHP: 6300/6300\nУрон: 555',
    enemyName: 'Охрана',
    enemyHp: 6300,
    enemyDamage: 555
  },
  {
    index: 5,
    key: 'stage5',
    type: 'choice',
    reward: 3000,
    choiceImage: 'https://i.postimg.cc/PfPK8R4c/photo-2025-10-03-06-09-47.jpg',
    choiceText: '5я комната подвала\n🩸 Ты встретил Тихие подопытные',
    battleImage: 'https://i.postimg.cc/wjckp8qF/photo-2025-10-03-06-09-50-2.jpg',
    battleText: '5я комната подвала\n🩸 Ты встретил Усиленная охрана\nHP: 8300/8300\nУрон: 710',
    enemyName: 'Усиленная охрана',
    enemyHp: 8300,
    enemyDamage: 710,
    stealthChanceDefault: 0.1,
    stealthChanceStealth: 0.7
  },
  {
    index: 6,
    key: 'stage6',
    type: 'battle',
    reward: 5000,
    introImage: 'https://i.postimg.cc/d1DRrh8y/photo-2025-10-03-06-09-48.jpg',
    introText: '6я комната подвала\n🩸 Ты встретил Обезумевшая\nHP: 9500/9500\nУрон: 800',
    enemyName: 'Обезумевшая',
    enemyHp: 9500,
    enemyDamage: 800
  },
  {
    index: 7,
    key: 'stage7',
    type: 'battle',
    reward: 7500,
    introImage: 'https://i.postimg.cc/bYDHv2Yv/photo-2025-10-03-06-09-54.jpg',
    introText: '7я комната подвала - Лабаратория\n🩸 Ты встретил Спец охрана\nHP: 10000/10000\nУрон: 830',
    enemyName: 'Спец охрана',
    enemyHp: 10000,
    enemyDamage: 830
  },
  {
    index: 8,
    key: 'stage8',
    type: 'battle',
    reward: 15000,
    introImage: 'https://i.postimg.cc/X79ffSCS/photo-2025-10-03-06-09-55.jpg',
    introText: '8я комната подвала - Лабаратория\n🩸 Ты встретил Зубастики\nHP: 12000/12000\nУрон: 900',
    enemyName: 'Зубастики',
    enemyHp: 12000,
    enemyDamage: 900
  },
  {
    index: 9,
    key: 'stage9',
    type: 'battle',
    reward: 25000,
    introImage: 'https://i.postimg.cc/HLvXYTfM/photo-2025-10-03-06-09-55-2.jpg',
    introText: '9я комната подвала - Финал\n🩸 Ты встретил Босс тьма\nHP: 17500/17500\nУрон: 1300',
    enemyName: 'Босс тьма',
    enemyHp: 17500,
    enemyDamage: 1300
  }
];

function getRaidStateKey(clanId) {
  return clanId == null ? null : String(clanId);
}

function findRaidStateByClan(clanId) {
  const key = getRaidStateKey(clanId);
  if (!key) return null;
  return clanRaidMissions[key] || null;
}

function registerRaidState(state) {
  const key = getRaidStateKey(state?.clanId);
  if (!key) return;
  clanRaidMissions[key] = state;
}

function unregisterRaidState(state) {
  const key = getRaidStateKey(state?.clanId);
  if (!key) return;
  if (clanRaidMissions[key] === state) {
    delete clanRaidMissions[key];
  }
}

function getRaidParticipantChatIds(state) {
  if (!state || !Array.isArray(state.members)) return [];
  const ids = new Set();
  for (const member of state.members) {
    if (!member) continue;
    const rawId = member.playerId ?? member.player?.id;
    if (rawId === null || rawId === undefined) continue;
    const numeric = Number(rawId);
    if (Number.isFinite(numeric)) {
      ids.add(numeric);
    } else {
      ids.add(rawId);
    }
  }
  return Array.from(ids);
}

function getRaidParticipantPlayers(state) {
  if (!state || !Array.isArray(state.members)) return [];
  const playersList = [];
  const seen = new Set();
  for (const member of state.members) {
    if (!member) continue;
    const rawId = member.playerId ?? member.player?.id;
    if (rawId === null || rawId === undefined) continue;
    const key = String(rawId);
    if (seen.has(key)) continue;
    seen.add(key);
    if (member.player) {
      playersList.push(member.player);
      continue;
    }
    const resolved = getPlayerById(rawId);
    if (resolved) {
      playersList.push(resolved);
    }
  }
  return playersList;
}

function sanitizeRaidDirectOptions(options) {
  if (!options) return undefined;
  const clone = { ...options };
  if (clone.reply_markup) {
    delete clone.reply_markup;
  }
  return Object.keys(clone).length > 0 ? clone : undefined;
}

async function broadcastToRaidParticipants(state, handler) {
  if (!state || typeof handler !== 'function') return;
  const participantIds = getRaidParticipantChatIds(state);
  const lobbyChatId = state?.chatId;
  const lobbyChatKey =
    lobbyChatId === null || lobbyChatId === undefined ? null : String(lobbyChatId);
  for (const participantId of participantIds) {
    const participantKey =
      participantId === null || participantId === undefined ? null : String(participantId);
    if (lobbyChatKey && participantKey && participantKey === lobbyChatKey) {
      continue;
    }
    try {
      await handler(participantId);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('raid participant notify error:', err?.message || err);
      }
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRaidMessage(state, text, options = undefined) {
  if (!state) return null;
  if (RAID_MESSAGE_DELAY_MS > 0) {
    await delay(RAID_MESSAGE_DELAY_MS);
  }
  let sent = null;
  try {
    sent = await bot.sendMessage(state.chatId, text, options);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('raid message send error:', err?.message || err);
    }
  }
  const sanitized = sanitizeRaidDirectOptions(options);
  await broadcastToRaidParticipants(state, async (participantId) => {
    await bot.sendMessage(participantId, text, sanitized);
  });
  return sent;
}

async function sendRaidPhoto(state, photo, options = undefined) {
  if (!state) return null;
  if (RAID_MESSAGE_DELAY_MS > 0) {
    await delay(RAID_MESSAGE_DELAY_MS);
  }
  let sent = null;
  try {
    sent = await bot.sendPhoto(state.chatId, photo, options);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('raid photo send error:', err?.message || err);
    }
  }
  const sanitized = sanitizeRaidDirectOptions(options);
  await broadcastToRaidParticipants(state, async (participantId) => {
    await bot.sendPhoto(participantId, photo, sanitized);
  });
  return sent;
}

async function notifyClanMembersRaidStart(clan) {
  if (!clan || !Array.isArray(clan.members) || clan.members.length === 0) return;
  const text = 'Ваш клан начал рейд миссию! Отправьте /acceptmission если хотите вступить в лобби!';
  const notified = new Set();
  for (const memberId of clan.members) {
    if (memberId === null || memberId === undefined) continue;
    const key = String(memberId);
    if (notified.has(key)) continue;
    notified.add(key);
    const numeric = Number(memberId);
    const target = Number.isFinite(numeric) ? numeric : memberId;
    try {
      await bot.sendMessage(target, text);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('clan raid notify error:', err?.message || err);
      }
    }
  }
}

async function initiateClanRaidMission(player, chatId, options = {}) {
  const { doubleReward = false } = options;
  if (!player) {
    await bot.sendMessage(chatId, "Ошибка: профиль не найден. Введите /play.");
    return false;
  }
  if (!player.clanId) {
    await bot.sendMessage(chatId, "Вы не состоите в клане.");
    return false;
  }
  const clan = clans[String(player.clanId)];
  if (!clan) {
    await bot.sendMessage(chatId, "Ваш клан не найден.");
    return false;
  }
  const existing = findRaidStateByClan(clan.id);
  if (existing && existing.status !== 'finished') {
    await bot.sendMessage(chatId, "В вашем клане уже запущена рейд миссия.");
    return false;
  }
  if (existing && existing.status === 'finished') {
    cleanupRaidState(existing);
  }
  const state = {
    id: Date.now(),
    chatId,
    clanId: clan.id,
    leaderId: player.id,
    createdAt: Date.now(),
    status: 'lobby',
    members: [],
    memberIds: new Set(),
    style: null,
    stagePointer: 0,
    currentStage: null,
    currentEnemy: null,
    turnIndex: 0,
    countdownTimer: null,
    turnTimeout: null,
    styleMessageId: null,
    styleMessageChatId: null,
    pendingChoice: null,
    lastClearedStageIndex: null,
    lastClearedStageReward: 0,
    rewardGranted: false,
    doubleReward: Boolean(doubleReward)
  };
  const addResult = addPlayerToRaid(state, player);
  if (!addResult.success) {
    await bot.sendMessage(chatId, "Не удалось добавить игрока в рейд.");
    return false;
  }
  registerRaidState(state);
  const introLines = [
    'Вы узнали расположение одной из лабараторий CRIMECORE, где по вашим данным удерживают похищенных жертв. Ваша цель узнать, как можно больше информации и вернуться оттуда живыми.',
    'За каждую добытую вами информацию - вам назначена награда, чем больше - тем лучше.',
    ''
  ];
  if (state.doubleReward) {
    introLines.push('💰 Эта рейд миссия принесёт двойную награду!');
    introLines.push('');
  }
  introLines.push(
    'Для вступления других соклановцев в ваше лобби им нужно отправить команду /acceptmission',
    ' ',
    `Игроков в лобби ${state.members.length}/${RAID_MAX_PLAYERS}`,
    'Старт через 130 секунд...'
  );
  await sendRaidMessage(state, introLines.join('\n')).catch(() => {});
  await notifyClanMembersRaidStart(clan).catch(() => {});
  scheduleRaidStyleSelection(state);
  return true;
}

function createRaidMemberState(player) {
  if (!player) return null;
  applyArmorHelmetBonuses(player);
  return {
    player,
    playerId: player.id,
    hp: player.maxHp || 100,
    maxHp: player.maxHp || 100,
    damageBoostTurns: 0,
    damageReductionTurns: 0,
    stunTurns: 0,
    signRadiationUsed: false,
    signFinalUsed: false,
    dead: false
  };
}

function getRaidAliveMembers(state) {
  if (!state || !Array.isArray(state.members)) return [];
  return state.members.filter((m) => m && !m.dead && m.hp > 0);
}

function formatRaidTeamHp(state) {
  if (!state || !Array.isArray(state.members) || state.members.length === 0) return '—';
  return state.members
    .map((member) => {
      if (!member || !member.player) return '—';
      const hpValue = Math.max(0, Math.round(member.hp || 0));
      return `${formatPlayerTag(member.player)} ${hpValue}/${member.maxHp}`;
    })
    .join(' | ');
}

function getRaidMedkitChance(state) {
  if (!state) return RAID_DEFAULT_MEDKIT_CHANCE;
  return state.style === 'intellect' ? RAID_INTELLECT_MEDKIT_CHANCE : RAID_DEFAULT_MEDKIT_CHANCE;
}

function cleanupRaidTimers(state) {
  if (!state) return;
  if (state.countdownTimer) {
    clearTimeout(state.countdownTimer);
    state.countdownTimer = null;
  }
  if (state.turnTimeout) {
    clearTimeout(state.turnTimeout);
    state.turnTimeout = null;
  }
}

function cleanupRaidState(state, reason = null) {
  if (!state) return;
  cleanupRaidTimers(state);
  unregisterRaidState(state);
  state.status = 'finished';
  if (reason) {
    sendRaidMessage(state, reason).catch(() => {});
  }
}

function buildRaidStyleKeyboard(clanId) {
  const key = getRaidStateKey(clanId) || '';
  return {
    inline_keyboard: Object.values(RAID_STYLE_OPTIONS).map((option) => [
      {
        text: `${option.emoji} ${option.label}`,
        callback_data: `raid_style:${key}:${option.key}`
      }
    ])
  };
}

function raidStyleDisplay(styleKey) {
  const option = RAID_STYLE_OPTIONS[styleKey];
  return option ? option.display : '';
}

function scheduleRaidStyleSelection(state) {
  if (!state) return;
  if (state.countdownTimer) {
    clearTimeout(state.countdownTimer);
    state.countdownTimer = null;
  }
  state.countdownTimer = setTimeout(() => {
    state.countdownTimer = null;
    startRaidStyleSelection(state).catch((err) => console.error('raid style selection error:', err));
  }, RAID_LOBBY_DURATION_MS);
}

async function startRaidStyleSelection(state) {
  if (!state || state.status !== 'lobby') return;
  state.status = 'style_selection';
  const caption = [
    'Вам требуется выбрать один из стилей игры:',
    '"🔵 Скрытность" - повышает ваш шанс прохождения комнат без лишнего шума и потерь',
    '"🟡 Интелект" - повышает ваш шанс на вскрытие безопасных зон.',
    '"🔴 Агрессия" - повышает шанс сделать ваших врагов беспомощнее.'
  ].join('\n');
  try {
    const sent = await sendRaidPhoto(state, RAID_STYLE_IMAGE, {
      caption,
      reply_markup: buildRaidStyleKeyboard(state.clanId)
    });
    state.styleMessageId = sent?.message_id ?? null;
    state.styleMessageChatId = sent?.chat?.id ?? state.chatId;
  } catch (err) {
    console.error('raid style send error:', err);
    const fallback = await sendRaidMessage(state, `${caption}\n(Не удалось отправить изображение)`, {
      reply_markup: buildRaidStyleKeyboard(state.clanId)
    }).catch(() => null);
    state.styleMessageId = fallback?.message_id ?? null;
    state.styleMessageChatId = fallback?.chat?.id ?? state.chatId;
  }
}

function getRaidMemberById(state, playerId) {
  if (!state || !Array.isArray(state.members)) return null;
  return (
    state.members.find((member) => Number(member.playerId) === Number(playerId)) || null
  );
}

function addPlayerToRaid(state, player) {
  if (!state || !player) return { success: false, reason: 'invalid' };
  if (!state.memberIds) state.memberIds = new Set();
  if (state.memberIds.has(player.id)) return { success: false, reason: 'already' };
  if (!Array.isArray(state.members)) state.members = [];
  if (state.members.length >= RAID_MAX_PLAYERS) return { success: false, reason: 'full' };
  const member = createRaidMemberState(player);
  if (!member) return { success: false, reason: 'invalid' };
  state.members.push(member);
  state.memberIds.add(player.id);
  return { success: true, member };
}

async function startRaidStage(state) {
  if (!state || state.status === 'finished') return;
  if (state.stagePointer == null) state.stagePointer = 0;
  if (state.stagePointer >= RAID_STAGES.length) {
    cleanupRaidState(state);
    return;
  }
  const stage = RAID_STAGES[state.stagePointer];
  state.currentStage = stage;
  state.currentEnemy = null;
  state.turnIndex = 0;
  state.pendingChoice = null;
  const alive = getRaidAliveMembers(state);
  if (alive.length === 0) {
    handleRaidFailure(state, '☠️ Все игроки погибли. Миссия провалена.');
    return;
  }
  for (const member of state.members) {
    if (!member) continue;
    if (member.hp <= 0) {
      member.hp = 0;
      member.dead = true;
      continue;
    }
    member.damageBoostTurns = 0;
    member.damageReductionTurns = 0;
  }
  if (stage.type === 'choice') {
    await presentRaidChoice(state, stage);
  } else {
    await startRaidBattle(state, stage);
  }
}

async function presentRaidChoice(state, stage) {
  if (!state || !stage) return;
  state.status = 'choice';
  try {
    const sent = await sendRaidPhoto(state, stage.choiceImage, {
      caption: stage.choiceText,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Атаковать', callback_data: `raid_choice:${getRaidStateKey(state.clanId)}:${stage.index}:attack` }],
          [{ text: 'Скрытно избежать', callback_data: `raid_choice:${getRaidStateKey(state.clanId)}:${stage.index}:stealth` }]
        ]
      }
    });
    state.pendingChoice = {
      stageIndex: stage.index,
      messageId: sent?.message_id ?? null,
      chatId: sent?.chat?.id ?? state.chatId
    };
  } catch (err) {
    console.error('raid choice send error:', err);
    state.pendingChoice = {
      stageIndex: stage.index,
      messageId: null,
      chatId: state.chatId
    };
    await sendRaidMessage(state, stage.choiceText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Атаковать', callback_data: `raid_choice:${getRaidStateKey(state.clanId)}:${stage.index}:attack` }],
          [{ text: 'Скрытно избежать', callback_data: `raid_choice:${getRaidStateKey(state.clanId)}:${stage.index}:stealth` }]
        ]
      }
    }).catch(() => {});
  }
}

async function startRaidBattle(state, stage) {
  if (!state || !stage) return;
  state.status = 'battle';
  const caption = stage.type === 'choice' ? stage.battleText : stage.introText;
  const image = stage.type === 'choice' ? stage.battleImage : stage.introImage;
  try {
    await sendRaidPhoto(state, image, { caption });
  } catch (err) {
    console.error('raid battle intro error:', err);
    await sendRaidMessage(state, caption).catch(() => {});
  }
  let enemyDamage = Number(stage.enemyDamage) || 0;
  let aggressionReduced = false;
  if (
    state.style === 'aggression' &&
    Number.isFinite(enemyDamage) &&
    Math.random() < RAID_AGGRESSION_DAMAGE_REDUCTION_CHANCE
  ) {
    enemyDamage = Math.max(1, Math.ceil(enemyDamage * RAID_AGGRESSION_DAMAGE_REDUCTION_FACTOR));
    aggressionReduced = true;
  }
  state.currentEnemy = {
    name: stage.enemyName,
    hp: stage.enemyHp,
    maxHp: stage.enemyHp,
    damage: enemyDamage,
    baseDamage: stage.enemyDamage,
    stun: 0,
    aggressionReduced
  };
  if (aggressionReduced) {
    await sendRaidMessage(state, 'Стиль Агрессия ослабил противника: его урон снижен на 25%.').catch(() => {});
  }
  if (state.turnTimeout) {
    clearTimeout(state.turnTimeout);
    state.turnTimeout = null;
  }
  state.turnTimeout = setTimeout(() => {
    processRaidTurn(state).catch((err) => console.error('raid turn error:', err));
  }, 2500);
}

function applyRaidExtraEffect(member, enemy, events) {
  const player = member?.player;
  if (!player || !player.inventory || !player.inventory.extra || !enemy) return;
  if (Math.random() >= 0.3) return;
  const extra = player.inventory.extra;
  const name = extra?.name || 'предмет';
  if (extra.effect === 'stun2') {
    const turns = extra.turns || 2;
    enemy.stun = Math.max(enemy.stun || 0, turns);
    events.push(`🧨 ${formatPlayerTag(player)} использует ${name}: враг оглушён на ${turns} ход(ов).`);
  } else if (extra.effect === 'damage50') {
    enemy.hp -= 50;
    events.push(`💥 ${formatPlayerTag(player)} использует ${name}: наносит 50 урона врагу.`);
  } else if (extra.effect === 'damage100') {
    enemy.hp -= 100;
    events.push(`💥 ${formatPlayerTag(player)} использует ${name}: наносит 100 урона врагу.`);
  } else if (extra.effect === 'halfDamage1') {
    member.damageReductionTurns = extra.turns || 1;
    events.push(`💪 ${formatPlayerTag(player)} использует ${name}: входящий урон /2 на ${member.damageReductionTurns} ход(ов).`);
  } else if (extra.effect === 'doubleDamage1') {
    member.damageBoostTurns = extra.turns || 1;
    events.push(`⚡ ${formatPlayerTag(player)} использует ${name}: урон x2 на ${member.damageBoostTurns} ход(ов).`);
  }
  if (enemy.hp < 0) enemy.hp = 0;
}

function raidTryUseSignProtection(member, sign, enemy) {
  if (!member || member.hp > 0 || !sign) return null;
  const player = member.player;
  const effects = getSignEffects(sign);
  if (!effects.preventLethal) return null;
  if (effects.preventLethal === 'radiation' && !member.signRadiationUsed) {
    member.signRadiationUsed = true;
    member.hp = 1;
    member.dead = false;
    if (effects.extraTurn && enemy) {
      enemy.stun = Math.max(enemy.stun || 0, 1);
    }
    return `☢️ ${sign.name} спасает ${formatPlayerTag(player)} от смерти${effects.extraTurn ? ', и враг пропускает следующий ход!' : '!'}`;
  }
  if (effects.preventLethal === 'final' && effects.fullHeal && !member.signFinalUsed) {
    member.signFinalUsed = true;
    member.hp = member.maxHp;
    member.dead = false;
    return `🛡️ ${sign.name} полностью восстанавливает ${formatPlayerTag(player)}!`;
  }
  return null;
}

function performRaidPlayerAttack(state, member, enemy) {
  const events = [];
  const player = member?.player;
  if (!player || !enemy) return events;
  applyRaidExtraEffect(member, enemy, events);
  const weaponName = player.inventory?.weapon?.name || 'кулаки';
  const weaponBonus = player.inventory?.weapon?.dmg || 0;
  const baseRoll = Math.floor(Math.random() * 30) + 10;
  let damage = baseRoll + weaponBonus;
  const mutationCrit = player.inventory?.mutation?.crit || 0;
  if (mutationCrit > 0 && Math.random() < mutationCrit) {
    damage *= 2;
    events.push(`💥 ${formatPlayerTag(player)} наносит критический удар (${weaponName}) на ${damage} урона!`);
  }
  if (member.damageBoostTurns && member.damageBoostTurns > 0) {
    damage *= 2;
    member.damageBoostTurns--;
    events.push(`⚡ ${formatPlayerTag(player)} наносит усиленный удар (x2 урон).`);
  }
  if (damage < 0) damage = 0;
  enemy.hp -= damage;
  if (enemy.hp < 0) enemy.hp = 0;
  events.push(`⚔️ ${formatPlayerTag(player)} атакует ${enemy.name}: ${damage} урона.`);
  const sign = player.inventory?.sign;
  const effects = getSignEffects(sign);
  if (damage > 0 && effects.vampirism > 0) {
    const healAmount = Math.max(1, Math.ceil(damage * effects.vampirism));
    const beforeHp = member.hp;
    member.hp = Math.min(member.maxHp, member.hp + healAmount);
    const healed = member.hp - beforeHp;
    if (healed > 0) {
      events.push(`🩸 ${formatPlayerTag(player)} восстанавливает ${healed} HP благодаря знаку.`);
    }
  }
  return events;
}

function performRaidEnemyAttack(state, member, enemy) {
  const events = [];
  if (!member || !enemy) return { events, playerDied: false };
  const player = member.player;
  if (enemy.stun && enemy.stun > 0) {
    enemy.stun -= 1;
    events.push(`⚠️ ${enemy.name} оглушён и пропускает ход (${enemy.stun} осталось).`);
    return { events, playerDied: false };
  }
  let incoming = enemy.damage;
  if (member.damageReductionTurns && member.damageReductionTurns > 0) {
    incoming = Math.ceil(incoming / 2);
    member.damageReductionTurns--;
    events.push(`💪 ${formatPlayerTag(player)} снижает входящий урон вдвое.`);
  }
  const sign = player.inventory?.sign;
  const signEffects = getSignEffects(sign);
  const helmetBlock = player.inventory?.helmet?.block || 0;
  if (signEffects.dodgeChance > 0 && Math.random() < signEffects.dodgeChance) {
    events.push(`🌀 ${formatPlayerTag(player)} увернулся благодаря ${sign ? sign.name : 'знаку'}!`);
    incoming = 0;
  }
  if (incoming > 0) {
    const blocked = Math.ceil(incoming * (helmetBlock / 100));
    if (blocked > 0) {
      events.push(`🪖 ${formatPlayerTag(player)} шлем блокирует ${blocked} урона.`);
      incoming = Math.max(0, incoming - blocked);
    }
    if (incoming > 0) {
      events.push(`💥 ${enemy.name} атакует ${formatPlayerTag(player)} на ${incoming} урона.`);
    }
  }
  member.hp -= incoming;
  let playerDied = false;
  if (member.hp <= 0) {
    const protectionMessage = raidTryUseSignProtection(member, sign, enemy);
    if (protectionMessage) {
      events.push(protectionMessage);
    }
  }
  if (member.hp <= 0) {
    member.hp = 0;
    member.dead = true;
    playerDied = true;
  }
  return { events, playerDied };
}

async function processRaidTurn(state) {
  if (!state || state.status !== 'battle') return;
  const enemy = state.currentEnemy;
  const stage = state.currentStage;
  if (!enemy || !stage) return;
  const alive = getRaidAliveMembers(state);
  if (alive.length === 0) {
    handleRaidFailure(state, '☠️ Все игроки погибли. Миссия провалена.');
    return;
  }
  if (!Number.isFinite(state.turnIndex) || state.turnIndex >= alive.length) {
    state.turnIndex = 0;
  }
  const member = alive[state.turnIndex];
  const events = performRaidPlayerAttack(state, member, enemy);
  const summaryLines = [];
  summaryLines.push(...events);
  if (enemy.hp <= 0) {
    summaryLines.push('', `🩸 HP врага: 0/${enemy.maxHp}`, `❤️ Состояние команды: ${formatRaidTeamHp(state)}`);
    await sendRaidMessage(state, summaryLines.filter(Boolean).join('\n')).catch(() => {});
    await handleRaidStageClear(state, stage);
    return;
  }
  const counter = performRaidEnemyAttack(state, member, enemy);
  summaryLines.push(...counter.events);
  summaryLines.push('', `🩸 HP врага: ${Math.max(0, Math.round(enemy.hp))}/${enemy.maxHp}`, `❤️ Состояние команды: ${formatRaidTeamHp(state)}`);
  await sendRaidMessage(state, summaryLines.filter(Boolean).join('\n')).catch(() => {});
  if (counter.playerDied) {
    await sendRaidMessage(state, `Игрок ${formatPlayerTag(member.player)} умер`).catch(() => {});
  }
  if (getRaidAliveMembers(state).length === 0) {
    handleRaidFailure(state, '☠️ Все игроки погибли. Миссия провалена.');
    return;
  }
  state.turnIndex += 1;
  if (state.turnTimeout) {
    clearTimeout(state.turnTimeout);
    state.turnTimeout = null;
  }
  state.turnTimeout = setTimeout(() => {
    processRaidTurn(state).catch((err) => console.error('raid turn error:', err));
  }, 2500);
}

function recordRaidStageCompletion(state, stage) {
  if (!state || !stage) return;
  state.lastClearedStageIndex = stage.index;
  state.lastClearedStageReward = stage.reward || 0;
}

function formatRaidStageLabel(stage, stageIndex) {
  if (stage && Number.isFinite(stage.index)) {
    const namePart = stage.enemyName ? ` (${stage.enemyName})` : '';
    return `комнату ${stage.index}${namePart}`;
  }
  if (Number.isFinite(stageIndex)) {
    return `комнату №${stageIndex}`;
  }
  return null;
}

function finalizeRaidReward(state) {
  if (!state || state.rewardGranted) return null;
  state.rewardGranted = true;
  const stageIndex = state.lastClearedStageIndex;
  const baseReward = Number(state.lastClearedStageReward) || 0;
  let reward = baseReward;
  if (state.doubleReward) {
    reward *= 2;
  }
  if (!Number.isFinite(stageIndex) || reward <= 0) {
    return 'Награда не получена, команда не успела добыть информацию.';
  }
  const stage = RAID_STAGES.find((s) => s.index === stageIndex) || null;
  const label = formatRaidStageLabel(stage, stageIndex) || 'последнюю комнату';
  const clan = clans[String(state.clanId)];
  if (clan) {
    clan.points = (clan.points || 0) + reward;
    const participants = getRaidParticipantPlayers(state);
    if (participants.length > 0) {
      for (const participant of participants) {
        if (!participant) continue;
        const current = Number(participant.infection) || 0;
        participant.infection = current + reward;
      }
    }
    saveData();
    const lines = [`🏆 Клан получил ${reward} клановых очков за ${label}.`];
    if (state.doubleReward) {
      lines.push('💰 Бонус рейда из охоты: награда удвоена.');
    }
    if (participants.length > 0) {
      lines.push(`☣️ Каждый игрок получил ${reward} очков заражения.`);
    }
    return lines.join('\n');
  }
  return `Награда ${reward} очков за ${label} не начислена, так как клан не найден.`;
}

function healRaidMembers(state, amount) {
  if (!state || !Array.isArray(state.members)) return;
  for (const member of state.members) {
    if (!member || member.dead) continue;
    member.hp = Math.min(member.maxHp, member.hp + amount);
  }
}

async function handleRaidStageClear(state, stage) {
  if (!state || !stage) return;
  if (state.turnTimeout) {
    clearTimeout(state.turnTimeout);
    state.turnTimeout = null;
  }
  state.currentEnemy = null;
  recordRaidStageCompletion(state, stage);
  const isFinalStage = state.stagePointer >= RAID_STAGES.length - 1;
  if (isFinalStage) {
    const rewardMessage = finalizeRaidReward(state);
    const lines = ['Поздравляем! Вы выполнили миссию на 100%!'];
    if (rewardMessage) {
      lines.push(rewardMessage);
    }
    await sendRaidMessage(state, lines.join('\n')).catch(() => {});
    cleanupRaidState(state);
    return;
  }
  const medkitChance = getRaidMedkitChance(state);
  let medkitText = '';
  if (Math.random() < medkitChance) {
    healRaidMembers(state, RAID_MEDKIT_HEAL);
    medkitText = 'Также вы нашли склад с запасами медикаментов! Все игроки пополнили 300хп';
  }
  const lines = [
    'Поздравляем! Вы получили доступ ко следующей комнате подвала!',
    'Награда будет начислена после завершения миссии.'
  ];
  if (medkitText) {
    lines.push(medkitText);
  }
  await sendRaidMessage(state, lines.join('\n')).catch(() => {});
  state.stagePointer += 1;
  state.status = 'transition';
  state.turnTimeout = setTimeout(() => {
    startRaidStage(state).catch((err) => console.error('raid stage start error:', err));
  }, 3500);
}

function handleRaidFailure(state, message) {
  const rewardMessage = finalizeRaidReward(state);
  const finalMessage = rewardMessage ? `${message}\n${rewardMessage}` : message;
  cleanupRaidState(state, finalMessage);
}

// helper: ensure clan exists
function ensureClan(name, leaderId = null) {
  const ids = Object.keys(clans).map(n => Number(n));
  const nextId = ids.length === 0 ? 1 : (Math.max(...ids) + 1);
  const id = nextId;
  clans[String(id)] = {
    id,
    name,
    points: 0,
    members: [],
    leaderId: leaderId != null ? Number(leaderId) : null
  };
  saveData();
  return clans[String(id)];
}

// find clan by id or name
function findClanByIdentifier(identifier) {
  if (!identifier) return null;
  // numeric id
  if (/^\d+$/.test(String(identifier))) {
    return clans[String(identifier)] || null;
  }
  const name = String(identifier).toLowerCase();
  const found = Object.values(clans).find(c => String(c.name).toLowerCase() === name);
  return found || null;
}

function addClanQueue(clanId, playerId) {
  const key = String(clanId);
  if (!clanBattleQueue[key]) clanBattleQueue[key] = [];
  if (!clanBattleQueue[key].includes(String(playerId))) clanBattleQueue[key].push(String(playerId));
  saveData();
}

function removeClanQueueEntry(clanId, playerId) {
  const key = String(clanId);
  if (!clanBattleQueue[key]) return;
  clanBattleQueue[key] = clanBattleQueue[key].filter(id => String(id) !== String(playerId));
  if (clanBattleQueue[key].length === 0) delete clanBattleQueue[key];
  saveData();
}

function countEligibleClansWithMin(minCount) {
  return Object.entries(clanBattleQueue).filter(([cid, arr]) => Array.isArray(arr) && arr.length >= minCount).map(([cid]) => cid);
}

// ---- Clan leadership helpers ----
function ensureClanHasLeader(clan) {
  if (!clan || typeof clan !== 'object') return null;
  const members = Array.isArray(clan.members) ? clan.members.filter((id) => id != null) : [];
  if (clan.leaderId != null && members.some((id) => Number(id) === Number(clan.leaderId))) {
    clan.leaderId = Number(clan.leaderId);
    return clan.leaderId;
  }
  const nextLeader = members.length > 0 ? Number(members[0]) : null;
  clan.leaderId = nextLeader;
  return clan.leaderId;
}

// ---- Clan assault state ----
const chatAssaults = Object.create(null);

function makeAssaultKey(chatId, clanId) {
  return `${chatId}:${clanId}`;
}

function getActiveAssaultStatesForChat(chatId) {
  const prefix = `${chatId}:`;
  return Object.keys(chatAssaults)
    .filter((key) => key.startsWith(prefix))
    .map((key) => chatAssaults[key])
    .filter(Boolean);
}

function isAssaultStateActive(state) {
  if (!state) return false;
  return chatAssaults[makeAssaultKey(state.chatId, state.clanId)] === state;
}

let assaultExpeditionSeq = 1;
const ASSAULT_INTERVAL_MS = 35 * 60 * 1000; // 35 minutes
const ASSAULT_EXPEDITION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ASSAULT_ATTACK_REWARD_POINTS = 150;
const ASSAULT_POSITIVE_REWARD_POINTS = 300;
const ASSAULT_NEUTRAL_REWARD_POINTS = 100;
const ASSAULT_NEGATIVE_REWARD_POINTS = 30;

const ASSAULT_POSITIVE_OUTCOMES = [
  'В полузаброшенной подворотне ты заметил железную дверь, ведущую в склад. Внутри пахло ржавчиной и старыми медикаментами. Среди ящиков лежали полезные вещи, которые корпорация, похоже, забыла. Никто не помешал тебе забрать их, и ты вернулся с приличной добычей.',
  'Ты проник в разрушенный офисный центр, где когда-то работали учёные корпорации. Кабинеты были завалены бумагами и приборами. Среди мусора оказался ящик с деталями и инструментами. Никаких подопытных поблизости, всё прошло тихо — удачная вылазка.',
  'В переулке ты столкнулся с девушкой-подопытной. Её тело было покрыто шрамами, но она не проявляла агрессии — лишь смотрела сквозь тебя пустым взглядом. Пока она стояла неподвижно, ты заметил тайник рядом и забрал всё, что мог. Девушка так и осталась недвижимой.',
  'Ты нашёл остатки старой мастерской, где ещё работали генераторы. В углу валялись брошенные ящики с электроникой. Никто не мешал — забрал их и ушёл, ощущая редкое спокойствие на этих улицах.',
  'В тёмном дворе ты услышал тихий женский голос. Оказалось, что это девушка-подопытная, изуродованная корпорацией. Она лишь улыбнулась тебе, не делая попыток приблизиться. Ты двинулся дальше и наткнулся на оставленный кем-то схрон.'
];

const ASSAULT_NEUTRAL_OUTCOMES = [
  'В тоннеле ты нашёл старую лабораторную палету с контейнерами. Но стоило коснуться, как из соседней комнаты вышла подопытная. Её лицо было скрыто металлической маской. Она не напала, но и оставаться рядом было рискованно. Удалось прихватить немного ценностей и уйти.',
  'Ты вошёл в здание общежития. На стенах — следы борьбы, обрывки одежды и инструменты корпорации. В одной из комнат сидела девушка с изменённым телом: её руки были металлическими протезами. Она смотрела в пол, и ты тихо прошёл мимо. Взял кое-что по пути, но рисковать больше не стал.',
  'В переулке ты нашёл обгоревший автомобиль. Внутри были сумки с вещами, но внезапный скрежет заставил тебя бросить часть находок. На этот раз удалось уйти живым, но не всё удалось сохранить.',
  'Ты пробрался в склад корпорации, где хранили оборудование. Всё казалось пустым, пока ты не услышал звук шагов. Кто-то или что-то следило за тобой. Ты торопливо собрал немного припасов и покинул место, пока не стало хуже.',
  'На улице раздался крик, и ты замер. Из тени вышла подопытная девушка с изломанными движениями. Она медленно приближалась, но, к счастью, не успела догнать. Пришлось бросить часть находок, спасая себя.'
];

const ASSAULT_NEGATIVE_OUTCOMES = [
  'В старом ангаре пахло химикатами. Ты заметил движение — из темноты вышла девушка-подопытная, у которой кожа была словно пластик. Её крик оглушил тебя, и в панике ты бросил всю добычу, спасая жизнь.',
  'Ты зашёл в подземный коридор, где мерцал аварийный свет. Вдруг оттуда выползла подопытная с удлинёнными конечностями. Она кинулась прямо на тебя, и пришлось вырваться, сбросив всё, что нашёл.',
  'На обочине дороги стоял автобус с выбитыми окнами. Ты зашёл внутрь и сразу пожалел — там были следы экспериментов. Одна из девушек, оставленных корпорацией, сидела в кресле, её глаза светились в темноте. Она двинулась за тобой, и пришлось бежать ни с чем.',
  'Ты наткнулся на лестницу, ведущую вниз. В подвале пахло кровью. Там сидели несколько подопытных женщин, и как только они заметили тебя, начали кричать в унисон. Стены дрожали от звука, и ты бросил всё, лишь бы вырваться наружу.',
  'На обратном пути тебя остановила фигура девушки с бинтами на лице. Её дыхание было неровным, она шагнула к тебе, и вдруг из-за спины выползли другие подопытные. Они окружили тебя. Спасся чудом, но всё, что ты нёс, осталось у них.'
];

function formatPlayerNameNoMention(player) {
  if (!player) return 'Неизвестный сталкер';
  const base = player.username || player.name || (player.id != null ? `ID ${player.id}` : 'Неизвестный сталкер');
  return String(base).replace(/^@+/, '');
}

function formatPlayerTag(player) {
  if (!player) return 'Неизвестный сталкер';
  return player.username ? `@${player.username}` : formatPlayerNameNoMention(player);
}

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const index = Math.floor(Math.random() * arr.length);
  return arr[index];
}

function getChatAssaultState(chatId, clanId) {
  if (clanId == null) return null;
  return chatAssaults[makeAssaultKey(chatId, clanId)] || null;
}

function scheduleNextAssaultExpedition(state, delay = ASSAULT_INTERVAL_MS) {
  if (!isAssaultStateActive(state)) return;
  if (state.nextExpeditionTimer) clearTimeout(state.nextExpeditionTimer);
  state.nextExpeditionTimer = setTimeout(() => {
    state.nextExpeditionTimer = null;
    beginAssaultExpedition(state).catch((err) => console.error('assault expedition error:', err));
  }, delay);
}

async function beginAssaultExpedition(state) {
  if (!isAssaultStateActive(state)) return;
  if (state.pendingExpedition) return;

  const clan = clans[String(state.clanId)];
  if (!clan) {
    await bot.sendMessage(state.chatId, 'База расформирована: клан больше не существует.').catch(() => {});
    await stopChatAssault(state.chatId, state.clanId);
    return;
  }

  const members = Array.isArray(clan.members)
    ? clan.members.filter((id) => players[String(id)])
    : [];

  if (members.length === 0) {
    await bot
      .sendMessage(state.chatId, `База клана "${clan.name}" свернута: в клане не осталось активных участников.`)
      .catch(() => {});
    await stopChatAssault(state.chatId, state.clanId);
    return;
  }

  const memberId = pickRandom(members);
  if (!memberId) {
    scheduleNextAssaultExpedition(state);
    return;
  }
  const member = players[String(memberId)];
  const displayName = formatPlayerNameNoMention(member);
  const expeditionId = `${Date.now()}_${assaultExpeditionSeq++}`;
  const keyboard = {
    inline_keyboard: [[{ text: '⚔️ Атаковать', callback_data: `assault_attack:${state.chatId}:${state.clanId}:${expeditionId}` }]]
  };

  try {
    const sent = await bot.sendMessage(state.chatId, `${displayName} отправился на разведку...`, {
      reply_markup: keyboard
    });
    const timer = setTimeout(() => {
      resolveAssaultExpeditionAutomatic(state.chatId, state.clanId, expeditionId).catch((err) =>
        console.error('assault auto error:', err)
      );
    }, ASSAULT_EXPEDITION_TIMEOUT_MS);
    state.pendingExpedition = {
      id: expeditionId,
      memberId,
      messageId: sent.message_id,
      startedAt: Date.now(),
      timer,
      attackedBy: null
    };
  } catch (err) {
    console.error('failed to start assault expedition:', err);
    await stopChatAssault(state.chatId, state.clanId);
  }
}

async function resolveAssaultExpeditionAutomatic(chatId, clanId, expeditionId) {
  const state = getChatAssaultState(chatId, clanId);
  if (!state || !state.pendingExpedition || state.pendingExpedition.id !== expeditionId) return;
  await finalizeAssaultExpedition(state, { type: 'auto' });
}

async function finalizeAssaultExpedition(state, outcome) {
  if (!isAssaultStateActive(state)) return;
  const expedition = state.pendingExpedition;
  if (!expedition) return;

  if (expedition.timer) clearTimeout(expedition.timer);
  state.pendingExpedition = null;

  if (expedition.messageId) {
    await bot
      .editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: state.chatId, message_id: expedition.messageId })
      .catch(() => {});
  }

  const clan = clans[String(state.clanId)];
  if (!clan) {
    await stopChatAssault(state.chatId, state.clanId);
    return;
  }

  if (outcome.type === 'attack') {
    const defender = outcome.defender || players[String(expedition.memberId)];
    const defenderName = formatPlayerNameNoMention(defender);
    const attacker = outcome.attacker;
    const attackerName = formatPlayerNameNoMention(attacker);
    const attackerClan = outcome.attackerClan;
    const attackerWins = Boolean(outcome.attackerWins);

    if (attackerWins && attackerClan) {
      attackerClan.points = Number(attackerClan.points || 0) + ASSAULT_ATTACK_REWARD_POINTS;
      saveData();
      await bot
        .sendMessage(
          state.chatId,
          `⚔️ ${attackerName} атаковал ${defenderName} и победил! Клан "${attackerClan.name}" получает ${ASSAULT_ATTACK_REWARD_POINTS} очков.`
        )
        .catch(() => {});
    } else {
      clan.points = Number(clan.points || 0) + ASSAULT_ATTACK_REWARD_POINTS;
      saveData();
      await bot
        .sendMessage(
          state.chatId,
          `🛡 ${defenderName} отбился от ${attackerName}! Клан "${clan.name}" получает ${ASSAULT_ATTACK_REWARD_POINTS} очков.`
        )
        .catch(() => {});
    }
  } else {
    const member = players[String(expedition.memberId)];
    const memberName = formatPlayerNameNoMention(member);
    const roll = Math.random();
    let description = '';
    let points = 0;

    if (roll < 0.34) {
      description = pickRandom(ASSAULT_POSITIVE_OUTCOMES) || '';
      points = ASSAULT_POSITIVE_REWARD_POINTS;
    } else if (roll < 0.74) {
      description = pickRandom(ASSAULT_NEUTRAL_OUTCOMES) || '';
      points = ASSAULT_NEUTRAL_REWARD_POINTS;
    } else {
      description = pickRandom(ASSAULT_NEGATIVE_OUTCOMES) || '';
      points = ASSAULT_NEGATIVE_REWARD_POINTS;
    }

    clan.points = Number(clan.points || 0) + points;
    saveData();
    const outcomeText = `🔎 ${memberName} вернулся с разведки.\n\n${description}\n\nКлан "${clan.name}" получает ${points} очков.`;
    await bot.sendMessage(state.chatId, outcomeText).catch(() => {});
  }

  if (isAssaultStateActive(state)) {
    scheduleNextAssaultExpedition(state);
  }
}

async function handleAssaultAttack(chatId, clanId, expeditionId, attackerPlayer) {
  const state = getChatAssaultState(chatId, clanId);
  if (!state || !state.pendingExpedition || state.pendingExpedition.id !== expeditionId) {
    return { status: 'expired' };
  }

  if (state.pendingExpedition.attackedBy && state.pendingExpedition.attackedBy !== attackerPlayer.id) {
    return { status: 'already' };
  }

  const clan = clans[String(state.clanId)];
  if (!clan) {
    await stopChatAssault(chatId, clanId);
    return { status: 'no_clan' };
  }

  const attackerClan = attackerPlayer.clanId ? clans[String(attackerPlayer.clanId)] : null;
  if (!attackerClan) {
    return { status: 'no_attacker_clan' };
  }

  if (Number(attackerClan.id) === Number(clan.id)) {
    return { status: 'same_clan' };
  }

  if (attackerPlayer.pvp) {
    return { status: 'attacker_busy' };
  }

  const defender = players[String(state.pendingExpedition.memberId)];
  if (defender && defender.pvp) {
    return { status: 'defender_busy' };
  }

  if (state.pendingExpedition.timer) {
    clearTimeout(state.pendingExpedition.timer);
    state.pendingExpedition.timer = null;
  }

  state.pendingExpedition.attackedBy = attackerPlayer.id;
  runAssaultSkirmish(state, attackerPlayer, attackerClan).catch((err) => {
    console.error('assault skirmish start error:', err);
    finalizeAssaultExpedition(state, {
      type: 'attack',
      attacker: attackerPlayer,
      attackerClan,
      attackerWins: false,
      defender
    }).catch((error) => console.error('assault skirmish fallback error:', error));
  });
  return { status: 'started' };
}

async function runAssaultSkirmish(state, attackerPlayer, attackerClan) {
  if (!state || !isAssaultStateActive(state) || !state.pendingExpedition) {
    return;
  }

  const expeditionId = state.pendingExpedition.id;
  const defender = players[String(state.pendingExpedition.memberId)];
  const chatId = state.chatId;
  const attackerLabel = formatPlayerTag(attackerPlayer);
  const defenderLabel = formatPlayerTag(defender);

  if (!defender) {
    await finalizeAssaultExpedition(state, {
      type: 'attack',
      attacker: attackerPlayer,
      attackerClan,
      attackerWins: true,
      defender: null
    });
    return;
  }

  await bot.sendMessage(chatId, `⚔️ ${attackerLabel} напал на ${defenderLabel}! Бой начинается!`).catch(() => {});

  if (!initPvpState(attackerPlayer, defender)) {
    await finalizeAssaultExpedition(state, {
      type: 'attack',
      attacker: attackerPlayer,
      attackerClan,
      attackerWins: false,
      defender
    });
    return;
  }

  let finished = false;
  let turn = 'attacker';

  const attackerState = attackerPlayer.pvp;
  const defenderState = defender.pvp;

  const cleanup = async (attackerWon, shouldFinalize = true) => {
    if (finished) return;
    finished = true;

    resetPlayerSignFlags(attackerPlayer);
    resetPlayerSignFlags(defender);
    if (attackerPlayer.pvp) delete attackerPlayer.pvp;
    if (defender.pvp) delete defender.pvp;
    saveData();

    if (shouldFinalize && isAssaultStateActive(state) && state.pendingExpedition && state.pendingExpedition.id === expeditionId) {
      await finalizeAssaultExpedition(state, {
        type: 'attack',
        attacker: attackerPlayer,
        attackerClan,
        attackerWins: attackerWon,
        defender
      });
    } else if (shouldFinalize && isAssaultStateActive(state) && !state.pendingExpedition) {
      // already finalized elsewhere
    } else if (!shouldFinalize) {
      // nothing
    }
  };

  const hpSummary = () => {
    const attackerHp = attackerPlayer.pvp ? Math.max(0, attackerPlayer.pvp.myHp) : 0;
    const defenderHp = defender.pvp ? Math.max(0, defender.pvp.myHp) : 0;
    return `HP: ${formatPlayerTag(attackerPlayer)} ${attackerHp}/${attackerPlayer.maxHp} — ${formatPlayerTag(defender)} ${defenderHp}/${defender.maxHp}`;
  };

  const processRound = async () => {
    if (finished) return;
    if (!isAssaultStateActive(state)) {
      await cleanup(false, false);
      return;
    }
    if (!state.pendingExpedition || state.pendingExpedition.id !== expeditionId) {
      await cleanup(false, false);
      return;
    }
    if (!attackerPlayer.pvp || !defender.pvp) {
      await cleanup(false);
      return;
    }

    const actor = turn === 'attacker' ? attackerPlayer : defender;
    const target = turn === 'attacker' ? defender : attackerPlayer;
    const actorState = turn === 'attacker' ? attackerState : defenderState;
    const targetState = turn === 'attacker' ? defenderState : attackerState;

    if (!actorState || !targetState) {
      await cleanup(false);
      return;
    }

    if (actorState.myHp <= 0) {
      await bot.sendMessage(chatId, `💀 ${formatPlayerTag(actor)} пал в бою (от ${formatPlayerTag(target)}).`).catch(() => {});
      await cleanup(turn !== 'attacker');
      return;
    }

    if (targetState.myHp <= 0) {
      await bot.sendMessage(chatId, `💀 ${formatPlayerTag(target)} пал в бою (от ${formatPlayerTag(actor)}).`).catch(() => {});
      await cleanup(turn === 'attacker');
      return;
    }

    if (actorState.myStun && actorState.myStun > 0) {
      actorState.myStun--;
      await bot
        .sendMessage(chatId, `⏱️ ${formatPlayerTag(actor)} оглушён и пропускает ход (${actorState.myStun} осталось).\n${hpSummary()}`)
        .catch(() => {});
    } else {
      const events = computeAttackForPvp(actor, target, actorState, targetState);
      await bot
        .sendMessage(chatId, `${events.join('\n')}\n\n${hpSummary()}`)
        .catch(() => {});
    }

    if (targetState.myHp <= 0) {
      await bot.sendMessage(chatId, `💀 ${formatPlayerTag(target)} пал в бою (от ${formatPlayerTag(actor)}).`).catch(() => {});
      await cleanup(turn === 'attacker');
      return;
    }

    turn = turn === 'attacker' ? 'defender' : 'attacker';
    saveData();
    setTimeout(() => {
      processRound().catch((err) => {
        console.error('assault skirmish round error:', err);
        cleanup(false).catch(() => {});
      });
    }, 5000);
  };

  setTimeout(() => {
    processRound().catch((err) => {
      console.error('assault skirmish round error:', err);
      cleanup(false).catch(() => {});
    });
  }, 1000);
}

async function stopChatAssault(chatId, clanId) {
  const key = makeAssaultKey(chatId, clanId);
  const state = chatAssaults[key];
  if (!state) return null;

  if (state.nextExpeditionTimer) {
    clearTimeout(state.nextExpeditionTimer);
    state.nextExpeditionTimer = null;
  }

  if (state.pendingExpedition) {
    if (state.pendingExpedition.timer) clearTimeout(state.pendingExpedition.timer);
    if (state.pendingExpedition.messageId) {
      await bot
        .editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: state.chatId,
          message_id: state.pendingExpedition.messageId
        })
        .catch(() => {});
    }
  }

  delete chatAssaults[key];
  return state;
}

// schedule countdown if conditions met (>=2 clans with >=2 players). starts 20s countdown once for the two clans chosen.

async function tryStartClanBattleCountdown(chatId) {
  const eligible = countEligibleClansWithMin(CLAN_BATTLE_MIN_PER_CLAN);
  if (eligible.length < 2) return;
  const clanA = eligible[0];
  const clanB = eligible[1];
  clanBattles.push({
    id: Date.now(),
    clanId: clanA,
    opponentClanId: clanB,
    status: "pending",
    createdAt: Date.now(),
    acceptedBy: null
  });
  saveData();
  await bot.sendMessage(chatId, `⚔️ Найдены кланы для битвы:
— ${clans[clanA].name} (${clanBattleQueue[clanA].length} заявок)
— ${clans[clanB].name} (${clanBattleQueue[clanB].length} заявок)

Ожидаем принятия вызова командой /acceptbattle игроком клана "${clans[clanB].name}".`);
}




  clanBattleCountdown = setTimeout(async () => {
    clanBattleCountdown = null;
    const chosen = pendingCountdownForClans;
    pendingCountdownForClans = null;
    // verify both still have >=min players
    if (!chosen || chosen.length < 2) return;
    if (!clanBattleQueue[chosen[0]] || !clanBattleQueue[chosen[1]] ||
        clanBattleQueue[chosen[0]].length < CLAN_BATTLE_MIN_PER_CLAN || clanBattleQueue[chosen[1]].length < CLAN_BATTLE_MIN_PER_CLAN) {
      try {
        await bot.sendMessage(chatId, "⚠️ Не удалось начать битву — недостаточно заявок (кто-то вышел).");
      } catch {}
      return;
    }
    // start battle
    startClanBattle(chosen[0], chosen[1], chatId);
  }, CLAN_BATTLE_COUNTDOWN_MS);

// run a full clan battle between clanAId and clanBId, chatId for messages
function cleanExpiredInvites() {
  let changed = false;
  for (const key of Object.keys(clanInvites)) {
    if (!clanInvites[key] || clanInvites[key].expires <= Date.now()) {
      delete clanInvites[key];
      changed = true;
    }
  }
  if (changed) saveData();
}

cleanExpiredInvites();
setInterval(cleanExpiredInvites, 60 * 1000);



// /admingive <item name> — admin-only self-give
bot.onText(/^\/sendall(?:@\w+)?$/i, async (msg) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!userId) return;
  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, "❌ Команда доступна только администраторам.");
    return;
  }

  const existing = adminBroadcastSessions.get(userId);
  if (existing && existing.stage === 'broadcasting') {
    await bot.sendMessage(chatId, "⏳ Подождите, текущая рассылка ещё не завершена.");
    return;
  }

  adminBroadcastSessions.set(userId, {
    stage: 'awaiting_text',
    chatId,
    content: null
  });

  await bot.sendMessage(chatId, "✉️ Отправьте текст рассылки одним сообщением. Форматирование будет сохранено.", {
    reply_markup: {
      inline_keyboard: [[{ text: 'Отмена', callback_data: ADMIN_BROADCAST_CANCEL }]]
    }
  });
});

bot.onText(/\/admingive(?:@\w+)?\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  try {
    if (msg.from.id !== ALLOWED_USER_ID) {
      return bot.sendMessage(chatId, "❌ Команда доступна только админу.");
    }
    const player = ensurePlayer(msg.from);
    if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");

    const query = (match && match[1] ? match[1] : "").trim();
    if (!query) {
      return bot.sendMessage(chatId, "Использование: /admingive <точное имя предмета>");
    }

    const item = findItemByName(query);
    if (!item) {
      return bot.sendMessage(chatId, "❌ Предмет не найден. Проверь точное имя (учитывается регистр и пробелы).");
    }

    await giveItemToPlayer(chatId, player, item, "🛠 Админ-выдача");
  } catch (e) {
    console.error("/admingive error:", e);
    bot.sendMessage(chatId, "Произошла ошибка при выдаче предмета.");
  }
});

bot.on('message', async (msg) => {
  const userId = msg.from?.id;
  if (!userId) return;

  const session = adminBroadcastSessions.get(userId);
  if (!session || session.stage !== 'awaiting_text') {
    return;
  }

  if (!isAdmin(userId)) {
    adminBroadcastSessions.delete(userId);
    return;
  }

  const rawText = typeof msg.text === 'string' ? msg.text : null;
  if (!rawText || !rawText.trim()) {
    await bot.sendMessage(msg.chat.id, "❌ Пожалуйста, отправьте текстовое сообщение для рассылки.");
    return;
  }

  if (/^\/sendall(?:@\w+)?$/i.test(rawText.trim())) {
    return;
  }

  const disableWebPreview = Boolean(msg.link_preview_options?.is_disabled);
  const content = {
    text: rawText,
    entities: Array.isArray(msg.entities) ? msg.entities : [],
    disableWebPreview
  };

  adminBroadcastSessions.set(userId, {
    stage: 'awaiting_confirm',
    chatId: msg.chat.id,
    content
  });

  await bot.sendMessage(msg.chat.id, "📣 Предпросмотр рассылки:");
  await bot.sendMessage(msg.chat.id, content.text, {
    entities: content.entities.length > 0 ? content.entities : undefined,
    disable_web_page_preview: content.disableWebPreview || undefined
  });

  await bot.sendMessage(msg.chat.id, "Отправить сообщение всем игрокам?", {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Отправить', callback_data: ADMIN_BROADCAST_CONFIRM },
        { text: 'Отмена', callback_data: ADMIN_BROADCAST_CANCEL }
      ]]
    }
  });
});


// /acceptbattle — принять клановую битву
bot.onText(/\/acceptbattle/, async (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  if (!player.clanId || !clans[String(player.clanId)]) {
    return bot.sendMessage(chatId, "Вы не состоите в клане.");
  }
  const clanId = String(player.clanId);

  // Проверка или создание лобби
  if (!global.clanBattleLobby) global.clanBattleLobby = {};
  if (!global.clanBattleLobby[clanId]) global.clanBattleLobby[clanId] = [];

  // Добавляем игрока, если его ещё нет
  if (!global.clanBattleLobby[clanId].includes(player.id)) {
    global.clanBattleLobby[clanId].push(player.id);
    bot.sendMessage(chatId, `${escMd(player.name)} (${clans[clanId].name}) присоединился к лобби.`);
  } else {
    return bot.sendMessage(chatId, "Вы уже в лобби.");
  }

  // Определяем два клана с игроками в лобби
  const clansInLobby = Object.keys(global.clanBattleLobby).filter(cid => global.clanBattleLobby[cid].length > 0);
  if (clansInLobby.length >= 2) {
    const [c1, c2] = clansInLobby;
    if (global.clanBattleLobby[c1].length >= 2 && global.clanBattleLobby[c2].length >= 2) {
      if (!global.clanBattleLobby.timer) {
        bot.sendMessage(chatId, "Минимальное количество участников собрано. До конца принятия заявок и начала боя осталось 20 секунд.");
        global.clanBattleLobby.timer = setTimeout(() => {
          const fightersA = global.clanBattleLobby[c1];
          const fightersB = global.clanBattleLobby[c2];
          global.clanBattleLobby = {};
          startClanBattle(c1, c2, chatId);
        }, 20000);
      }
    }
  }
});

// /inviteclan @username|id  (robust: accepts numeric id even if target hasn't started)
bot.onText(/\/inviteclan(?:@\w+)?\s+(.+)/i, (msg, match) => {
  const chatId = msg.chat.id;
  const inviter = ensurePlayer(msg.from);
  if (!inviter || !inviter.clanId) return bot.sendMessage(chatId, "Вы должны быть в клане, чтобы приглашать.");
  const raw = match[1] ? String(match[1]).trim() : "";
  if (!raw) return bot.sendMessage(chatId, "Использование: /inviteclan @username или /inviteclan id");
  let targetId = null;
  // numeric id?
  if (/^\d+$/.test(raw)) {
    targetId = String(raw);
  } else {
    // try find player by username
    const target = findPlayerByIdentifier(raw);
    if (target && target.id) targetId = String(target.id);
  }
  if (!targetId) return bot.sendMessage(chatId, "Игрок не найден. Укажите корректный @username или числовой ID.");
  // create invite even if player record doesn't exist yet
  const expires = Date.now() + 5 * 60 * 1000; // 5 minutes
  clanInvites[targetId] = { clanId: inviter.clanId, fromId: inviter.id, expires };
  saveData();
  bot.sendMessage(chatId, `✅ Приглашение сохранено: пользователь ${targetId} приглашён в клан "${clans[String(inviter.clanId)].name}".`);
  // try to notify the user if they have started the bot
  try {
    const maybePlayer = players[String(targetId)];
    if (maybePlayer && maybePlayer.id) {
      bot.sendMessage(Number(targetId), `📩 Вас пригласил в клан "${clans[String(inviter.clanId)].name}" — @${inviter.username}. Примите командой /acceptclan @${inviter.username}`);
    }
  } catch (e) { /* ignore */ }
});

// /acceptclan [@username|id]  (robust: if no arg, accepts any pending invite for this user)
bot.onText(/\/acceptclan(?:@\w+)?(?:\s+(.+))?/i, (msg, match) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  if (player.clanId) return bot.sendMessage(chatId, "Вы уже состоите в клане.");
  const arg = match && match[1] ? String(match[1]).trim() : null;
  const myKey = String(player.id);
  let invite = clanInvites[myKey];
  if (!invite && arg) {
    // try find invite by matching inviter identifier (if user supplied inviter)
    let inviterId = null;
    if (/^\d+$/.test(arg)) inviterId = Number(arg);
    else {
      const inv = findPlayerByIdentifier(arg);
      if (inv && inv.id) inviterId = Number(inv.id);
    }
    if (inviterId && clanInvites[myKey] && Number(clanInvites[myKey].fromId) === inviterId) invite = clanInvites[myKey];
  }
  if (!invite) return bot.sendMessage(chatId, "У вас нет действующего приглашения в клан.");
  if (invite.expires <= Date.now()) {
    delete clanInvites[myKey];
    saveData();
    return bot.sendMessage(chatId, "Приглашение просрочено.");
  }
  const clan = clans[String(invite.clanId)];
  if (!clan) return bot.sendMessage(chatId, "Клан уже не существует.");
  if (!Array.isArray(clan.members)) clan.members = [];
  // prevent double join
  if (!clan.members.includes(player.id)) clan.members.push(player.id);
  ensureClanHasLeader(clan);
  player.clanId = clan.id;
  delete clanInvites[myKey];
  saveData();
  bot.sendMessage(chatId, `✅ Вы вступили в клан "${escMd(clan.name)}".`);
});
// helper to advance next fighter on team
async function startClanBattle(clanAId, clanBId, chatId) {
  const clanA = clans[String(clanAId)];
  const clanB = clans[String(clanBId)];
  if (!clanA || !clanB) {
    bot.sendMessage(chatId, 'Ошибка: один из кланов не найден.');
    return;
  }
  const fightersA = clanA.members.map(id => players[String(id)]).filter(Boolean);
  const fightersB = clanB.members.map(id => players[String(id)]).filter(Boolean);
  if (fightersA.length === 0 || fightersB.length === 0) {
    bot.sendMessage(chatId, 'Ошибка: в одном из кланов нет бойцов.');
    return;
  }
  let idxA = 0, idxB = 0;
  let fighterA = fightersA[idxA];
  let fighterB = fightersB[idxB];
  applyArmorHelmetBonuses(fighterA);
  applyArmorHelmetBonuses(fighterB);
  resetPlayerSignFlags(fighterA);
  resetPlayerSignFlags(fighterB);
  let stateA = { myHp: fighterA.maxHp, myStun: 0, myDamageBoostTurns: 0, myDamageReductionTurns: 0, myRadiationBoost: false, signRadiationUsed: false, signFinalUsed: false };
  let stateB = { myHp: fighterB.maxHp, myStun: 0, myDamageBoostTurns: 0, myDamageReductionTurns: 0, myRadiationBoost: false, signRadiationUsed: false, signFinalUsed: false };
  let turn = 'A';
    function advanceNextA() {
      idxA++;
      if (idxA >= fightersA.length) return false;
      fighterA = fightersA[idxA];
      applyArmorHelmetBonuses(fighterA);
      resetPlayerSignFlags(fighterA);
      stateA = {
        myHp: fighterA.maxHp,
        myStun: 0,
        myDamageBoostTurns: 0,
        myDamageReductionTurns: 0,
        myRadiationBoost: false,
        signRadiationUsed: false,
        signFinalUsed: false
      };
      return true;
    }
    function advanceNextB() {
      idxB++;
      if (idxB >= fightersB.length) return false;
      fighterB = fightersB[idxB];
      applyArmorHelmetBonuses(fighterB);
      resetPlayerSignFlags(fighterB);
      stateB = {
        myHp: fighterB.maxHp,
        myStun: 0,
        myDamageBoostTurns: 0,
        myDamageReductionTurns: 0,
        myRadiationBoost: false,
        signRadiationUsed: false,
        signFinalUsed: false
      };
      return true;
    }
  
    // fight loop using recursive timeouts (to mimic PvP timing)
    async function processRound() {
      // If someone already dead by state check, handle before any action
      if (stateA.myHp <= 0) {
        const hasNext = advanceNextA();
        if (!hasNext) {
          // team A lost
          await bot.sendMessage(chatId, `🏳️ ${escMd(clanA.name)} проиграл бой! Победил: ${escMd(clanB.name)}`);
          clans[String(clanBId)].points = (clans[String(clanBId)].points || 0) + CLAN_BATTLE_POINT;
          clans[String(clanAId)].points = Math.max(0, (clans[String(clanAId)].points || 0) - CLAN_BATTLE_POINT);
          saveData();
          // cleanup queue entries for these clans
          delete clanBattleQueue[String(clanAId)];
          delete clanBattleQueue[String(clanBId)];
          return;
        } else {
          await bot.sendMessage(chatId, `🔁 На поле за ${escMd(clanA.name)} выходит следующий боец: @${fighterA.username}`);
          // continue to next tick without immediate attack (small delay)
          setTimeout(processRound, 1500);
          return;
        }
      }
      if (stateB.myHp <= 0) {
        const hasNext = advanceNextB();
        if (!hasNext) {
          // team B lost
          await bot.sendMessage(chatId, `🏳️ ${escMd(clanB.name)} проиграл бой! Победил: ${escMd(clanA.name)}`);
          clans[String(clanAId)].points = (clans[String(clanAId)].points || 0) + CLAN_BATTLE_POINT;
          clans[String(clanBId)].points = Math.max(0, (clans[String(clanBId)].points || 0) - CLAN_BATTLE_POINT);
          saveData();
          delete clanBattleQueue[String(clanAId)];
          delete clanBattleQueue[String(clanBId)];
          return;
        } else {
          await bot.sendMessage(chatId, `🔁 На поле за ${escMd(clanB.name)} выходит следующий боец: @${fighterB.username}`);
          setTimeout(processRound, 5000);
          return;
        }
      }
  
      // select attacker/defender based on turn
      const attacker = (turn === "A") ? fighterA : fighterB;
      const defender = (turn === "A") ? fighterB : fighterA;
      const attackerState = (turn === "A") ? stateA : stateB;
      const defenderState = (turn === "A") ? stateB : stateA;
  
      if (attackerState.myStun && attackerState.myStun > 0) {
        attackerState.myStun--;
        await bot.sendMessage(chatId, `⏱️ @${attacker.username} оглушён и пропускает ход (${attackerState.myStun} осталось).\nHP: @${fighterA.username} ${Math.max(0, stateA.myHp)}/${fighterA.maxHp} — @${fighterB.username} ${Math.max(0, stateB.myHp)}/${fighterB.maxHp}`);
      } else {
        const events = computeAttackForPvp(attacker, defender, attackerState, defenderState);
        await bot.sendMessage(chatId, `${events.join("\n")}\n\nHP: @${fighterA.username} ${Math.max(0, stateA.myHp)}/${fighterA.maxHp} — @${fighterB.username} ${Math.max(0, stateB.myHp)}/${fighterB.maxHp}`);
      }
  
      // check if defender died
      if (defenderState.myHp <= 0) {
        // credit kill to attacker (update stats)
        attacker.pvpWins = (attacker.pvpWins || 0) + 1;
        defender.pvpLosses = (defender.pvpLosses || 0) + 1;
        // Note: per-spec we change ONLY clan points at the end of entire battle.
        await bot.sendMessage(chatId, `💀 @${defender.username} пал в бою (от @${attacker.username}).`);
        // remove defender and advance next
        if (turn === "A") {
          const hasNext = advanceNextB();
          if (!hasNext) {
            // B lost
            await bot.sendMessage(chatId, `🏆 Клан ${escMd(clanA.name)} одержал победу! (+${CLAN_BATTLE_POINT} очков)\nКлан ${escMd(clanB.name)} теряет ${CLAN_BATTLE_POINT} очков.`);
            clans[String(clanAId)].points = (clans[String(clanAId)].points || 0) + CLAN_BATTLE_POINT;
            clans[String(clanBId)].points = Math.max(0, (clans[String(clanBId)].points || 0) - CLAN_BATTLE_POINT);
            saveData();
            delete clanBattleQueue[String(clanAId)];
            delete clanBattleQueue[String(clanBId)];
            return;
          } else {
            // next B enters, continue
            await bot.sendMessage(chatId, `🔁 На поле за ${escMd(clanB.name)} выходит: @${fighterB.username}`);
          }
        } else {
          const hasNext = advanceNextA();
          if (!hasNext) {
            await bot.sendMessage(chatId, `🏆 Клан ${escMd(clanB.name)} одержал победу! (+${CLAN_BATTLE_POINT} очков)\nКлан ${escMd(clanA.name)} теряет ${CLAN_BATTLE_POINT} очков.`);
            clans[String(clanBId)].points = (clans[String(clanBId)].points || 0) + CLAN_BATTLE_POINT;
            clans[String(clanAId)].points = Math.max(0, (clans[String(clanAId)].points || 0) - CLAN_BATTLE_POINT);
            saveData();
            delete clanBattleQueue[String(clanAId)];
            delete clanBattleQueue[String(clanBId)];
            return;
          } else {
            await bot.sendMessage(chatId, `🔁 На поле за ${escMd(clanA.name)} выходит: @${fighterA.username}`);
          }
        }
      }
  
      // switch turn
      turn = (turn === "A") ? "B" : "A";
      saveData();
  
      // schedule next round if still fighting
      setTimeout(processRound, 2000);
    }
  
    // start the loop
    setTimeout(processRound, 800);
  
}
// ---- Chat handlers / commands ----

// /clan_create <name>
bot.onText(/\/clan_create (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не удалось найти профиль. Введите /play.");
  const name = String(match[1]).trim();
  if (!name || name.length < 2) return bot.sendMessage(chatId, "Укажите корректное название клана (минимум 2 символа).");
  // check if player already in clan
  if (player.clanId) return bot.sendMessage(chatId, "Вы уже в клане — сначала выйдите (/clan_leave).");
  // check name uniqueness
  const exists = Object.values(clans).find(c => String(c.name).toLowerCase() === name.toLowerCase());
  if (exists) return bot.sendMessage(chatId, "Клан с таким названием уже существует. Выберите другое имя.");
  const clan = ensureClan(name, player.id);
  if (!Array.isArray(clan.members)) clan.members = [];
  if (!clan.members.some((id) => Number(id) === Number(player.id))) {
    clan.members.push(player.id);
  }
  ensureClanHasLeader(clan);
  player.clanId = clan.id;
  saveData();
  bot.sendMessage(chatId, `✅ Клан "${escMd(clan.name)}" создан. Вы вошли в клан.`);
});

// /clan_leave
bot.onText(/\/clan_leave/, (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  if (!player.clanId) return bot.sendMessage(chatId, "Вы не состоите в клане.");
  const cid = String(player.clanId);
  const clan = clans[cid];
  if (clan) {
    clan.members = (clan.members || []).filter(id => String(id) !== String(player.id));
    // if empty clan -> delete it
    if (clan.members.length === 0) {
      delete clans[cid];
    } else {
      if (Number(clan.leaderId) === Number(player.id)) {
        ensureClanHasLeader(clan);
      }
    }
  }
  player.clanId = null;
  // also remove from battle queue
  removeClanQueueEntry(cid, player.id);
  saveData();
  bot.sendMessage(chatId, "Вы вышли из клана.");
});

bot.onText(/\/acceptmission(?:@\w+)?/, async (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) {
    await bot.sendMessage(chatId, "Ошибка: профиль не найден. Введите /play.");
    return;
  }
  if (!player.clanId) {
    await bot.sendMessage(chatId, "Вы не состоите в клане.");
    return;
  }
  const state = findRaidStateByClan(player.clanId);
  if (!state || state.status !== 'lobby') {
    await bot.sendMessage(chatId, "Нет активного лобби рейд миссии вашего клана или набор уже завершён.");
    return;
  }
  if (Number(state.chatId) !== Number(chatId)) {
    await bot.sendMessage(chatId, "Присоединиться можно в чате, где открыто лобби рейда.");
    return;
  }
  if (state.memberIds && state.memberIds.has(player.id)) {
    await bot.sendMessage(chatId, "Вы уже участвуете в лобби.");
    return;
  }
  if (Array.isArray(state.members) && state.members.length >= RAID_MAX_PLAYERS) {
    await bot.sendMessage(chatId, "Лобби заполнено.");
    return;
  }
  const result = addPlayerToRaid(state, player);
  if (!result.success) {
    await bot.sendMessage(chatId, "Не удалось вступить в лобби.");
    return;
  }
  await sendRaidMessage(
    state,
    `${formatPlayerTag(player)} вступил в лобби. Игроков в лобби ${state.members.length}/${RAID_MAX_PLAYERS}`
  ).catch(() => {});
});

// /clan_top
bot.onText(/\/clan_top/, (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  const sorted = Object.values(clans).sort((a,b) => (b.points || 0) - (a.points || 0));
  if (sorted.length === 0) return bot.sendMessage(chatId, "Пока нет зарегистрированных кланов.");
  let text = "🏰 Топ кланов:\n\n";
  sorted.slice(0,10).forEach((c,i) => {
    text += `${i+1}. ${escMd(c.name)} — ${c.points} очков (${(c.members||[]).length} участников)\n`;
  });
  const rankIndex = sorted.findIndex(c => c.id === player.clanId);
  text += `\nТвой клан: ${player.clanId ? (clans[String(player.clanId)] ? clans[String(player.clanId)].name : "—") : "—"}\n`;
  text += `Твоё место: ${rankIndex >= 0 ? rankIndex + 1 : "—"} из ${sorted.length}`;
  bot.sendMessage(chatId, text);
});

// /clan_battle
bot.onText(/\/clan_battle/, async (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  if (!player.clanId) return bot.sendMessage(chatId, "Вы не состоите в клане. Вступите в клан или создайте его: /clan_create <имя>.");
  const clan = clans[String(player.clanId)];
  if (!clan) return bot.sendMessage(chatId, "Ошибка: ваш клан не найден.");
  // disallow if player currently in PvP? For safety, require no active pvp state
  if (player.pvp) return bot.sendMessage(chatId, "Вы сейчас в PvP — дождитесь конца боя.");
  // add to queue
  addClanQueue(clan.id, player.id);
  await bot.sendMessage(chatId, `✅ Вы подали заявку на клановую битву за "${escMd(clan.name)}".\nТекущая очередь вашего клана: ${clanBattleQueue[String(clan.id)] ? clanBattleQueue[String(clan.id)].length : 0}`);
  // try starting countdown if conditions ok
  tryStartClanBattleCountdown(chatId);
});

bot.onText(/\/kick(?:@\w+)?\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const initiator = ensurePlayer(msg.from);
  if (!initiator) return bot.sendMessage(chatId, "Ошибка: профиль не найден. Введите /play.");
  if (!initiator.clanId) return bot.sendMessage(chatId, "Вы не состоите в клане.");
  const clan = clans[String(initiator.clanId)];
  if (!clan) return bot.sendMessage(chatId, "Ваш клан не найден.");
  ensureClanHasLeader(clan);
  if (Number(clan.leaderId) !== Number(initiator.id)) {
    return bot.sendMessage(chatId, "Только лидер клана может исключать участников.");
  }

  const raw = match && match[1] ? String(match[1]).trim() : '';
  if (!raw) return bot.sendMessage(chatId, "Использование: /kick @username или /kick id");

  let targetPlayer = findPlayerByIdentifier(raw);
  if (!targetPlayer && /^\d+$/.test(raw)) {
    targetPlayer = players[String(raw)] || null;
  }

  if (!targetPlayer) return bot.sendMessage(chatId, "Игрок не найден. Укажите корректный @username или ID.");
  if (String(targetPlayer.id) === String(initiator.id)) return bot.sendMessage(chatId, "Нельзя исключить себя.");
  if (Number(targetPlayer.clanId) !== Number(clan.id)) {
    return bot.sendMessage(chatId, "Этот игрок не состоит в вашем клане.");
  }

  clan.members = (clan.members || []).filter((id) => Number(id) !== Number(targetPlayer.id));
  targetPlayer.clanId = null;
  if (Number(clan.leaderId) === Number(targetPlayer.id)) {
    ensureClanHasLeader(clan);
  }
  removeClanQueueEntry(clan.id, targetPlayer.id);
  saveData();

  const targetName = formatPlayerNameNoMention(targetPlayer);
  await bot.sendMessage(chatId, `❌ ${targetName} исключён из клана "${clan.name}".`).catch(() => {});
  try {
    await bot.sendMessage(Number(targetPlayer.id), `ℹ️ Вас исключили из клана "${clan.name}".`);
  } catch (err) {
    console.error('failed to notify kicked player:', err.message || err);
  }
});

bot.onText(/\/assault(?:@\w+)?/, async (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat && msg.chat.type ? msg.chat.type : 'private';
  if (chatType === 'private') {
    return bot.sendMessage(chatId, "Команда доступна только в групповых чатах.");
  }

  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: профиль не найден. Введите /play.");
  if (!player.clanId) return bot.sendMessage(chatId, "Вы должны состоять в клане, чтобы устанавливать базу.");

  const clan = clans[String(player.clanId)];
  if (!clan) return bot.sendMessage(chatId, "Ошибка: ваш клан не найден.");

  const existing = getChatAssaultState(chatId, clan.id);
  if (existing) {
    return bot.sendMessage(chatId, "Ваш клан уже контролирует этот чат.");
  }

  let memberCount = null;
  try {
    memberCount = await bot.getChatMemberCount(chatId);
  } catch (err) {
    console.error('getChatMemberCount failed:', err.message || err);
  }
  if (Number.isFinite(memberCount) && memberCount < 4) {
    return bot.sendMessage(chatId, "Для захвата чата требуется минимум 4 участника.");
  }

  const state = {
    chatId,
    clanId: clan.id,
    initiatedBy: player.id,
    pendingExpedition: null,
    nextExpeditionTimer: null
  };
  chatAssaults[makeAssaultKey(chatId, clan.id)] = state;

  const others = getActiveAssaultStatesForChat(chatId).filter((s) => Number(s.clanId) !== Number(clan.id));
  const otherText = others.length > 0
    ? `\n\nВ этом чате также установили базы: ${others
        .map((s) => {
          const otherClan = clans[String(s.clanId)];
          return otherClan ? `"${otherClan.name}"` : 'другие кланы';
        })
        .join(', ')}.`
    : '';

  const introText = `🏴 Клан "${clan.name}" установил базу в этом чате. Теперь разведчики смогут исследовать территорию и приносить очки клану.\nКаждые 35 минут один случайный участник клана будет автоматически отправляться на разведку.\nДругие жители чата могут атаковать разведчиков, чтобы перехватить добычу.\nЧтобы демонтировать базу, отправьте /unassault.${otherText}`;
  await bot.sendMessage(chatId, introText).catch(() => {});
  ensureClanHasLeader(clan);
  await beginAssaultExpedition(state);
});

bot.onText(/\/unassault(?:@\w+)?/, async (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: профиль не найден. Введите /play.");
  if (!player.clanId) return bot.sendMessage(chatId, "Вы не состоите в клане.");

  const state = getChatAssaultState(chatId, player.clanId);
  if (!state) return bot.sendMessage(chatId, "В этом чате нет активной базы вашего клана.");
  if (Number(state.clanId) !== Number(player.clanId)) {
    return bot.sendMessage(chatId, "Только клан, который установил базу, может её убрать.");
  }

  await stopChatAssault(chatId, state.clanId);
  const clan = clans[String(player.clanId)];
  const clanName = clan ? clan.name : 'клан';
  await bot.sendMessage(chatId, `🏳️ База клана "${clanName}" демонтирована.`).catch(() => {});
});

// ---- Callback handlers (PvE, inventory, leaderboard and pvp_request button, clans menu) ----

  const __af = Object.create(null);
bot.on("callback_query", async (q) => {
  const dataCb = q.data;
  const user = q.from;
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;

  await bot.answerCallbackQuery(q.id).catch(()=>{});

  if (dataCb === ADMIN_BROADCAST_CANCEL) {
    if (!isAdmin(user?.id)) {
      return;
    }
    const session = adminBroadcastSessions.get(user.id);
    if (session) {
      adminBroadcastSessions.delete(user.id);
      await bot.sendMessage(chatId, "Рассылка отменена.");
    } else {
      await bot.sendMessage(chatId, "Активных рассылок нет.");
    }
    return;
  }

  if (dataCb === ADMIN_BROADCAST_CONFIRM) {
    if (!isAdmin(user?.id)) {
      await bot.sendMessage(chatId, "❌ У вас нет прав для запуска рассылки.");
      return;
    }

    const session = adminBroadcastSessions.get(user.id);
    if (!session || session.stage !== 'awaiting_confirm' || !session.content) {
      await bot.sendMessage(chatId, "❗️ Нет подготовленной рассылки для отправки.");
      return;
    }

    adminBroadcastSessions.set(user.id, { ...session, stage: 'broadcasting' });

    const { text, entities, disableWebPreview } = session.content;
    const recipientsSet = new Set();

    try {
      const [rows] = await pool.execute('SELECT id FROM players');
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const rawId = row && (row.id ?? row.playerId ?? row.player_id);
          if (rawId === null || rawId === undefined) continue;
          recipientsSet.add(String(rawId));
        }
      }
    } catch (err) {
      console.error('Не удалось получить список игроков для рассылки:', err);
      await bot.sendMessage(chatId, '❌ Ошибка чтения списка игроков. Попробуйте ещё раз позже.');
      adminBroadcastSessions.delete(user.id);
      return;
    }

    for (const key of Object.keys(players || {})) {
      if (key === undefined || key === null) continue;
      recipientsSet.add(String(key));
    }

    const recipients = Array.from(recipientsSet)
      .map((raw) => {
        const numeric = Number(raw);
        return Number.isFinite(numeric) ? numeric : raw;
      })
      .filter((id) => id !== null && id !== undefined && `${id}`.trim() !== '');

    if (recipients.length === 0) {
      await bot.sendMessage(chatId, '⚠️ Не найдено ни одного получателя.');
      adminBroadcastSessions.delete(user.id);
      return;
    }

    await bot.sendMessage(chatId, `📤 Начинаю рассылку (${recipients.length} получателей)...`);

    let successCount = 0;
    let failCount = 0;
    for (const targetId of recipients) {
      try {
        await bot.sendMessage(targetId, text, {
          entities: entities && entities.length > 0 ? entities : undefined,
          disable_web_page_preview: disableWebPreview || undefined
        });
        successCount += 1;
      } catch (err) {
        failCount += 1;
        console.warn(`Не удалось отправить рассылку пользователю ${targetId}:`, err.message || err);
      }
    }

    await bot.sendMessage(
      chatId,
      `✅ Рассылка завершена.\nУспешно: ${successCount}\nОшибок: ${failCount}`
    );

    adminBroadcastSessions.delete(user.id);
    return;
  }

  // === Ограничение кнопок в любых группах (group/supergroup): разрешены только PvP и Кланы ===
  try {
    const chat = q.message && q.message.chat ? q.message.chat : null;
    const chatType = chat && chat.type ? chat.type : null;
    const isGroupType = chatType === "group" || chatType === "supergroup";
    const allowedInGroup = new Set([
      "pvp_request",
      "pvp_menu",
      "pvp_chat",
      "pvp_find",
      "pvp_ranked",
      "pvp_leaderboard",
      "leaderboard_menu",
      "leaderboard_survival",
      "clans_menu",
      "clans_top",
      "clans_create_join",
      "clans_battle_info",
      "clans_assault_info",
      "clans_raid_mission"
    ]);
    const isAssaultAttackAction = typeof dataCb === 'string' && dataCb.startsWith('assault_attack:');
    const isRaidAction =
      typeof dataCb === 'string' &&
      (dataCb.startsWith('raid_style:') || dataCb.startsWith('raid_choice:'));
    if (isGroupType && !allowedInGroup.has(dataCb) && !isAssaultAttackAction && !isRaidAction) {
      const chatIdCurrent = chat.id;
      const warnText = "Эти функции доступны только в личном сообщении бота, нажми на мою аватарку и играй!";
      await bot.answerCallbackQuery(q.id, { show_alert: true, text: warnText }).catch(()=>{});
      await bot.sendMessage(chatIdCurrent, warnText).catch(()=>{});
      return;
    }
  } catch (e) {
    console.error("Group gating error:", e);
  }
  // === /Ограничение кнопок ===
  let player = ensurePlayer(user);
  if (dataCb === "community") {
    const text = "📚 Полезные ресурсы\nВыбери, куда перейти:";
    await editOrSend(chatId, messageId, text, {
      reply_markup: resourcesKeyboard(),
      parse_mode: null
    });
    return;
  }

  if (dataCb === "leaderboard_menu") {
    const text = "🏆 Таблицы лидеров\nВыбери нужный рейтинг:";
    await editOrSend(chatId, messageId, text, {
      reply_markup: leaderboardMenuKeyboard(),
      parse_mode: null
    });
    return;
  }
  // --- Обработчики для кнопок главного меню: PvP и Кланы ---
if (dataCb === "pvp_request" || dataCb === "pvp_menu") {
  await editOrSend(chatId, messageId, "⚔️ Выберите режим PvP:", { reply_markup: pvpMenuKeyboard() });
  return;
}

if (dataCb === "pvp_chat") {
  const keyById = String(user.id);
  const reqObj = { challengerId: user.id, username: user.username || null, chatId, ts: Date.now() };
  pvpRequests[keyById] = reqObj;
  if (user.username) {
    pvpRequests[`@${user.username}`] = reqObj;
    pvpRequests[user.username] = reqObj;
  }

  await sendPvpRequestAnnouncement(chatId, player);
  return;
}

if (dataCb === "pvp_find") {
  if (!player) {
    await bot.sendMessage(chatId, "Ошибка: профиль не найден. Введите /play.");
    return;
  }
  const cooldown = getPvpCooldownRemaining(player);
  if (cooldown > 0) {
    const seconds = Math.ceil(cooldown / 1000);
    await bot.sendMessage(chatId, `⏳ Подождите ${seconds} сек. перед началом нового PvP.`);
    return;
  }

  const searchingMsg = await bot.sendMessage(chatId, "🔍 Поиск соперника...");
  await new Promise((resolve) => setTimeout(resolve, 2000 + Math.floor(Math.random() * 2000)));

  const opponent = generateRandomOpponentPlayer();
  const opponentText = `🤖 Найден соперник: @${opponent.username}\nID: ${opponent.id}\n☣️ Заражение: ${opponent.infection}`;
  const opponentImg = await generateInventoryImage(opponent);
  if (opponentImg) {
    await bot.sendPhoto(chatId, opponentImg, { caption: opponentText, parse_mode: "Markdown" });
  } else {
    await bot.sendMessage(chatId, opponentText, { parse_mode: "Markdown" });
  }

  if (searchingMsg && searchingMsg.message_id) {
    await bot.deleteMessage(chatId, searchingMsg.message_id).catch(() => {});
  }

  startPvpFight(player, opponent, chatId);
  return;
}

if (dataCb === "pvp_ranked") {
  if (!player) {
    await bot.sendMessage(chatId, "Ошибка: профиль не найден. Введите /play.");
    return;
  }
  const cooldown = getPvpCooldownRemaining(player);
  if (cooldown > 0) {
    const seconds = Math.ceil(cooldown / 1000);
    await bot.sendMessage(chatId, `⏳ Подождите ${seconds} сек. перед началом нового PvP.`);
    return;
  }

  ensurePvpRatingFields(player);
  const searchingMsg = await bot.sendMessage(chatId, "🥇 Поиск рейтингового соперника...");
  await new Promise((resolve) => setTimeout(resolve, 2000 + Math.floor(Math.random() * 2000)));

  const opponent = generateRankedOpponentPlayer(player);
  const opponentStage = Number.isFinite(opponent?.rankedStage) ? opponent.rankedStage + 1 : 1;
  const opponentText = `🥇 Найден рейтинговый соперник: @${opponent.username}\nЭтап сложности: ${opponentStage}\n☣️ Заражение: ${opponent.infection}`;
  const opponentImg = await generateInventoryImage(opponent);
  if (opponentImg) {
    await bot.sendPhoto(chatId, opponentImg, { caption: opponentText, parse_mode: "Markdown" });
  } else {
    await bot.sendMessage(chatId, opponentText, { parse_mode: "Markdown" });
  }

  if (searchingMsg && searchingMsg.message_id) {
    await bot.deleteMessage(chatId, searchingMsg.message_id).catch(() => {});
  }

  startPvpFight(player, opponent, chatId, {
    ranked: true,
    ratingReward: RANKED_PVP_RATING_REWARD,
    rankedPlayerIds: [player.id]
  });
  return;
}

if (dataCb === "pvp_leaderboard") {
  const text = buildPvpRatingLeaderboardText(player);
  await editOrSend(chatId, messageId, text, { reply_markup: leaderboardResultKeyboard() });
  return;
}

if (dataCb === "clans_menu") {
  const text = "🏰 Кланы\n\nВыбери раздел, чтобы узнать подробности.";
  await editOrSend(chatId, messageId, text, { reply_markup: clansMenuKeyboard(), parse_mode: null });
  return;
}

if (dataCb === "clans_top") {
  const text = buildClanTopText(player);
  const replyMarkup = leaderboardResultKeyboard();
  if (!text) {
    await editOrSend(chatId, messageId, "Пока нет зарегистрированных кланов.", {
      reply_markup: replyMarkup,
      parse_mode: null
    });
  } else {
    await editOrSend(chatId, messageId, text, { reply_markup: replyMarkup });
  }
  return;
}

if (dataCb === "clans_create_join") {
  const text = [
    "🏗 Управление кланом",
    "",
    "Основные команды:",
    "• `/clan_create <имя>` — создать новый клан.",
    "• `/inviteclan @ник|id` — пригласить игрока.",
    "• `/acceptclan` — принять приглашение в клан.",
    "• `/clan_leave` — покинуть текущий клан.",
    "• `/kick @ник|id` — исключить участника (доступно лидеру).",
    "",
    "Отправь нужную команду в чат, чтобы выполнить действие."
  ].join("\n");
  await editOrSend(chatId, messageId, text, {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "clans_menu" }]] }
  });
  return;
}

if (dataCb === "clans_battle_info") {
  const text = [
    "⚔️ Клановые битвы",
    "",
    "Команды:",
    "• `/clan_battle` — подать заявку на битву.",
    "• `/acceptbattle` — принять вызов на сражение.",
    "",
    "Как это работает:",
    "Кланы отправляют заявки, после чего система подбирает противника. Каждой стороне нужно минимум два готовых бойца. После принятия вызова начинается пошаговая схватка, а победивший клан получает очки рейтинга.",
    "Следите за списком заявок и своевременно принимайте подходящие бои, чтобы не упустить шанс заработать очки!"
  ].join("\n");
  await editOrSend(chatId, messageId, text, {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "clans_menu" }]] }
  });
  return;
}

if (dataCb === "clans_assault_info") {
  const text = [
    "🚩 Захват чата",
    "",
    "• Напишите `/assault` в групповом чате, где находится бот, чтобы установить базу своего клана.",
    "• Каждые 35 минут один случайный участник клана будет автоматически отправляться на разведку и приносить очки.",
    "• Под сообщением разведчика появится кнопка «Атаковать». Любой участник чата может нажать её, чтобы попытаться сорвать добычу и получить очки для своего клана.",
    "• Если за 5 минут нападения не было, бот определяет исход экспедиции и начисляет 300, 100 или 30 очков в зависимости от успеха.",
    "• Команда `/unassault` демонтирует базу и останавливает разведки."
  ].join("\n");
  await editOrSend(chatId, messageId, text, {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "clans_menu" }]] }
  });
  return;
}

if (dataCb === "clans_raid_mission") {
  await initiateClanRaidMission(player, chatId);
  return;
}

if (typeof dataCb === 'string' && dataCb.startsWith('raid_style:')) {
  const [, clanIdRaw, styleKey] = dataCb.split(':');
  const state = findRaidStateByClan(clanIdRaw);
  if (!state) {
    await bot.answerCallbackQuery(q.id, { text: 'Рейд не найден.', show_alert: true }).catch(() => {});
    return;
  }
  if (Number(state.leaderId) !== Number(user.id)) {
    await bot.answerCallbackQuery(q.id, { text: 'Только инициатор рейда может выбрать стиль.', show_alert: true }).catch(() => {});
    return;
  }
  if (state.style) {
    await bot.answerCallbackQuery(q.id, { text: `Стиль уже выбран: ${raidStyleDisplay(state.style)}.`, show_alert: true }).catch(() => {});
    return;
  }
  if (state.status !== 'style_selection') {
    await bot.answerCallbackQuery(q.id, { text: 'Сейчас нельзя выбрать стиль.', show_alert: true }).catch(() => {});
    return;
  }
  const option = RAID_STYLE_OPTIONS[styleKey];
  if (!option) {
    await bot.answerCallbackQuery(q.id, { text: 'Неизвестный стиль.', show_alert: true }).catch(() => {});
    return;
  }
  state.style = option.key;
  if (state.styleMessageId && state.styleMessageChatId) {
    await bot
      .editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: state.styleMessageChatId,
        message_id: state.styleMessageId
      })
      .catch(() => {});
  }
  await sendRaidMessage(state, `Вы выбрали стиль ${option.display}. Желаю вернуться живыми!`).catch(() => {});
  if (state.turnTimeout) {
    clearTimeout(state.turnTimeout);
    state.turnTimeout = null;
  }
  state.status = 'preparing';
  state.stagePointer = 0;
  state.turnIndex = 0;
  state.turnTimeout = setTimeout(() => {
    startRaidStage(state).catch((err) => console.error('raid stage init error:', err));
  }, 2000);
  return;
}

if (typeof dataCb === 'string' && dataCb.startsWith('raid_choice:')) {
  const parts = dataCb.split(':');
  if (parts.length < 4) {
    return;
  }
  const [, clanIdRaw, stageIndexRaw, action] = parts;
  const stageIndex = Number(stageIndexRaw);
  const stage = RAID_STAGES.find((s) => s.index === stageIndex);
  const state = findRaidStateByClan(clanIdRaw);
  if (!state || !stage) {
    await bot.answerCallbackQuery(q.id, { text: 'Рейд недоступен.', show_alert: true }).catch(() => {});
    return;
  }
  if (Number(state.leaderId) !== Number(user.id)) {
    await bot.answerCallbackQuery(q.id, { text: 'Только инициатор рейда может выбрать действие.', show_alert: true }).catch(() => {});
    return;
  }
  if (state.status !== 'choice' || !state.pendingChoice || Number(state.pendingChoice.stageIndex) !== stageIndex) {
    await bot.answerCallbackQuery(q.id, { text: 'Этот выбор уже сделан.', show_alert: true }).catch(() => {});
    return;
  }
  if (state.pendingChoice && state.pendingChoice.messageId) {
    await bot
      .editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: state.pendingChoice.chatId,
        message_id: state.pendingChoice.messageId
      })
      .catch(() => {});
  }
  state.pendingChoice = null;
  if (action === 'stealth') {
    const chance = state.style === 'stealth' ? stage.stealthChanceStealth : stage.stealthChanceDefault;
    const success = Math.random() < chance;
    if (success) {
      await sendRaidMessage(state, 'Поздравляем! Вы смогли прокрасться без лишнего шума ко следующей комнате подвала!').catch(() => {});
      await handleRaidStageClear(state, stage);
    } else {
      await sendRaidMessage(state, 'Вас заметили! Вам п***!').catch(() => {});
      await startRaidBattle(state, stage);
    }
    return;
  }
  if (action === 'attack') {
    await startRaidBattle(state, stage);
  }
  return;
}

if (typeof dataCb === "string" && dataCb.startsWith("assault_attack:")) {
  const [, chatIdStr, clanIdStr, expeditionId] = dataCb.split(":");
  const targetChatId = Number(chatIdStr);
  const targetClanId = Number(clanIdStr);
  if (!Number.isFinite(targetChatId) || !Number.isFinite(targetClanId)) {
    return;
  }
  const attacker = ensurePlayer(user);
  if (!attacker) {
    return;
  }

  const result = await handleAssaultAttack(targetChatId, targetClanId, expeditionId, attacker);
  if (result.status === "no_attacker_clan") {
    await bot.sendMessage(chatId, "Для нападения нужно состоять в клане.").catch(() => {});
    return;
  }
  if (result.status === "same_clan") {
    await bot.sendMessage(chatId, "Вы не можете атаковать разведчика собственного клана.").catch(() => {});
    return;
  }
  if (result.status === "attacker_busy") {
    await bot.sendMessage(chatId, "Вы уже участвуете в PvP и не можете начать ещё один бой.").catch(() => {});
    return;
  }
  if (result.status === "defender_busy") {
    await bot.sendMessage(chatId, "Этот разведчик уже участвует в другом бою.").catch(() => {});
    return;
  }
  if (result.status === "already") {
    await bot.sendMessage(chatId, "Извините, игрок уже был атакован.").catch(() => {});
    return;
  }
  if (result.status === "expired") {
    await bot.sendMessage(chatId, "Экспедиция уже завершена.").catch(() => {});
    return;
  }
  if (result.status === "no_clan") {
    await bot.sendMessage(chatId, "База этого клана уже демонтирована.").catch(() => {});
    return;
  }
  if (result.status === "started") {
    return;
  }
  return;
}

// === Обработка кнопки "Назад" (главное меню) ===
if (dataCb === "play") {
    let player = ensurePlayer(user);

    // Удаляем старое меню
    if (player.lastMainMenuMsgId) {
        await bot.deleteMessage(chatId, player.lastMainMenuMsgId).catch(() => {});
    }

    // Отправляем новое меню и сохраняем его message_id
    const menuText = buildMainMenuText(player);
    const sent = await bot.sendMessage(chatId, menuText, {
      reply_markup: mainMenuKeyboard(),
      parse_mode: "Markdown"
    });
    player.lastMainMenuMsgId = sent.message_id;
    saveData();
    return;
}

// player уже инициализирован выше


if (dataCb === "cases") {
    await editOrSend(chatId, messageId, "📦 Меню кейсов — выбери:", { reply_markup: lootMenuKeyboard() });
    return;
}

if (typeof dataCb === 'string' && dataCb.startsWith('case_info:')) {
    const caseId = dataCb.split(':')[1] || '';
    await respondWithCaseInfo(chatId, messageId, caseId, player);
    return;
}

if (typeof dataCb === 'string' && dataCb.startsWith('case_open:')) {
    const caseId = dataCb.split(':')[1] || '';
    await handleCaseOpen(caseId, { chatId, messageId, player, user });
    return;
}

if (typeof dataCb === 'string' && dataCb.startsWith('preview_case:')) {
    const caseId = dataCb.split(':')[1] || '';
    const previewText = buildCasePreviewText(caseId);
    await editOrSend(chatId, messageId, previewText, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "cases" }]] }
    });
    return;
}

if (dataCb === "invite_friend") {
    await respondWithCaseInfo(chatId, messageId, 'invite', player);
    return;
}

if (dataCb === "invite_case_open") {
    await handleCaseOpen('invite', { chatId, messageId, player, user });
    return;
}

if (dataCb === "infection_case") {
    await handleCaseOpen('infection', { chatId, messageId, player, user });
    return;
}

if (dataCb === "sign_case") {
    await handleCaseOpen('sign', { chatId, messageId, player, user });
    return;
}

if (dataCb === "free_gift") {
    await handleCaseOpen('free_gift', { chatId, messageId, player, user });
    return;
}

if (dataCb === "basic_box") {
    await respondWithCaseInfo(chatId, messageId, 'basic', player);
    return;
}

if (dataCb === "legend_box") {
    await respondWithCaseInfo(chatId, messageId, 'legend', player);
    return;
} // ← legacy legend_box handler

if (dataCb === "hunt") {
  const now = Date.now();
  let huntCooldown = 15000;
  if (player && (player.id === 7897895019 || player.id === 7026777373 || player.id === 169131351 || player.id === 1221763227 || player.id === 6714596963 || player.id === 6732505287)) {
    huntCooldown = 1000;
  }
  // Проверка кулдауна с антиспамом сообщения
  if (now - (player.lastHunt || 0) < huntCooldown) {
    if (!player.huntCooldownWarned) {
      await bot.sendMessage(chatId, `⏳ Пожалуйста, подожди ${huntCooldown / 1000} секунд перед следующей охотой`);
      player.huntCooldownWarned = true;
      saveData();
    }
    return;
  } else {
    player.huntCooldownWarned = false;
  }

    player.lastHunt = now;
    player.firstAttack = false;
    player.monsterStun = 0;
    player.pendingDrop = null;
    player.currentEvent = null;
    player.currentDanger = null;
    player.currentDangerMsgId = null;
    player.monster = null;
    player.pendingRescueGift = null;
    delete player.currentBattleMsgId;
    applyArmorHelmetBonuses(player);
    resetPlayerSignFlags(player);

    player.pendingHuntRaid = null;

    if (Math.random() < RESCUE_EVENT_CHANCE) {
      player.pendingRescueGift = { createdAt: now };
      saveData();
      await bot.sendPhoto(chatId, RESCUE_EVENT_IMAGE_URL, {
        caption:
          'Вы обнаружили укушенную девушку и помогли ей с медикаментами, в знак благодарности она решила отдать вам один из ее предметов, что вы готовы взять?',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Шлем', callback_data: 'rescue_reward:helmet' },
              { text: 'Броня', callback_data: 'rescue_reward:armor' },
              { text: 'Оружие', callback_data: 'rescue_reward:weapon' }
            ],
            [
              { text: 'Мутация', callback_data: 'rescue_reward:mutation' },
              { text: 'Доп. Предмет', callback_data: 'rescue_reward:extra' }
            ]
          ]
        }
      });
      return;
    }

    if (Math.random() < HUNT_RARE_RAID_CHANCE) {
      player.pendingHuntRaid = { doubleReward: true, createdAt: Date.now() };
      saveData();
      const caption = [
        'РЕЙД МИССИЯ!!! 🩸🩸🩸',
        '',
        'Вы заметили фургон ведущий в одну из спрятанных лабораторий CRIMECORE, вы можете устроить рейд лаборатории и получить x2 награду от Рейд миссии.',
        'Чем больше пройденных уровней, тем больше награда, умноженная в два раза от начала из охоты.',
        'Вы можете попытаться пройти ее в одиночку, но лучше взять с собой соклановцев :)'
      ].join('\n');
      await bot.sendPhoto(chatId, HUNT_RARE_RAID_IMAGE_URL, {
        caption,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Начать миссию', callback_data: 'hunt_raid_start' }
            ],
            [
              { text: '❌ Уйти', callback_data: 'hunt_raid_leave' }
            ]
          ]
        }
      });
      return;
    }

    if (Math.random() < SUPPLY_DROP_CHANCE) {
      const foundMedkit = Math.random() < 0.5;
      const healValue = foundMedkit ? MEDKIT_HEAL : FOOD_HEAL;
      const imageUrl = foundMedkit ? MEDKIT_IMAGE_URL : FOOD_IMAGE_URL;
      const itemLabel = foundMedkit ? "аптечку" : "продукты";
      const beforeHp = Number.isFinite(player.hp) ? player.hp : 0;
      const maxHp = Number.isFinite(player.maxHp) ? player.maxHp : beforeHp;
      const newHp = Math.min(maxHp, beforeHp + healValue);
      player.hp = newHp;
      const healed = Math.max(0, newHp - beforeHp);
      const survivalNote = grantSurvivalDay(player);
      saveData();
      const healText = healed > 0 ? `❤️ +${healed} хп` : "❤️ Здоровье уже на максимуме.";
      const captionLines = [
        `📦 Ты наткнулся на заброшенный склад и нашёл ${itemLabel}!`,
        healText,
        "🗓 +1 день выживания."
      ];
      if (survivalNote) {
        captionLines.push("", survivalNote);
      }
      await bot.sendPhoto(chatId, imageUrl, {
        caption: captionLines.join("\n"),
        reply_markup: mainMenuKeyboard()
      });
      return;
    }

    const monsterImages = {
        weak:  "https://i.postimg.cc/XqWfytS2/IMG-6677.jpg",
        medium: "https://i.postimg.cc/VNyd6ncg/IMG-6678.jpg",
        fat:   "https://i.postimg.cc/nz2z0W9S/IMG-6679.jpg",
        quest: "https://i.postimg.cc/J4Gn5PrK/IMG-6680.jpg",
        boss:  "https://i.postimg.cc/TwRBcpGL/image.jpg",
        special: SPECIAL_SUBJECT_IMAGE_URL
    };

  const bossChance = 0.05;
  if (Math.random() < bossChance) {
    player.monster = { id: "Ω", hp: 5300, maxHp: 5300, dmg: 600, type: "boss" };
    saveData();
    const sent = await bot.sendPhoto(chatId, monsterImages.boss, {
      caption: `☠️ Ты наткнулся на босса CRIMECORE!\nHP: ${player.monster.hp}/${player.monster.maxHp}\nУрон: ${player.monster.dmg}`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "⚔️ Атаковать", callback_data: "attack" }],
          [{ text: "🏃 Убежать", callback_data: "run_before_start" }]
        ]
      }
    });
    player.currentBattleMsgId = sent.message_id;
    saveData();
    return;
  }

  if (Math.random() < SPECIAL_SUBJECT_CHANCE) {
    player.monster = {
      id: "***",
      hp: SPECIAL_SUBJECT_HP,
      maxHp: SPECIAL_SUBJECT_HP,
      dmg: SPECIAL_SUBJECT_DMG,
      type: "special"
    };
    saveData();
    const sent = await bot.sendPhoto(chatId, SPECIAL_SUBJECT_IMAGE_URL, {
      caption: `*** ******* ****** *****\n**: ****/****\n****: ***`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "⚔️ Атаковать", callback_data: "attack" }],
          [{ text: "🏃 Убежать", callback_data: "run_before_start" }]
        ]
      }
    });
    player.currentBattleMsgId = sent.message_id;
    saveData();
    return;
  }

  const roll = Math.random();
  if (roll < DANGER_EVENT_CHANCE) {
    await startDangerEvent(player, chatId);
    return;
  }

  if (roll < DANGER_EVENT_CHANCE + 0.075) {
    const ev = storyEvents[Math.floor(Math.random() * storyEvents.length)];
    player.currentEvent = ev;
    const sent = await bot.sendPhoto(chatId, monsterImages.quest, {
      caption: `📜 *${ev.title}*\n\n${ev.text}`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Действовать", callback_data: "event_action" }],
          [{ text: "⬅️ Назад", callback_data: "play" }]
        ]
      }
    });
    player.currentBattleMsgId = sent.message_id;
    saveData();
    return;
  }

    player.monster = spawnMonster();
    saveData();
    const img = monsterImages[player.monster.type] || monsterImages.weak;
    const caption = player.monster.type === "special"
        ? `*** ******* ****** *****\n**: ****/****\n****: ***`
        : `🩸 Ты встретил Подопытного №${player.monster.id}\nHP: ${player.monster.hp}/${player.monster.maxHp}\nУрон: ${player.monster.dmg}`;
    const sent = await bot.sendPhoto(chatId, img, {
        caption,
        reply_markup: {
            inline_keyboard: [
                [{ text: "⚔️ Атаковать", callback_data: "attack" }],
                [{ text: "🏃 Убежать", callback_data: "run_before_start" }]
            ]
        }
    });
    player.currentBattleMsgId = sent.message_id;
    saveData();
    return;
}

if (dataCb === "hunt_raid_start") {
    if (!player?.pendingHuntRaid) {
        await bot.answerCallbackQuery(q.id, { text: "Эта миссия больше не доступна.", show_alert: true }).catch(()=>{});
        return;
    }
    await bot.answerCallbackQuery(q.id).catch(()=>{});
    const doubleReward = Boolean(player.pendingHuntRaid?.doubleReward);
    const started = await initiateClanRaidMission(player, chatId, { doubleReward });
    if (started) {
        player.pendingHuntRaid = null;
        saveData();
    }
    return;
}

if (dataCb === "hunt_raid_leave") {
    await bot.answerCallbackQuery(q.id).catch(()=>{});
    player.pendingHuntRaid = null;
    saveData();
    const menuText = buildMainMenuText(player);
    await bot.sendMessage(chatId, menuText, { reply_markup: mainMenuKeyboard(), parse_mode: "Markdown" });
    return;
}

if (dataCb === "run_before_start") {
    if (player.firstAttack) {
        await bot.answerCallbackQuery(q.id, { text: "Нельзя убежать, бой уже начался!", show_alert: true }).catch(()=>{});
        return;
    }
    player.monster = null;
    player.monsterStun = 0;
    if (player.currentBattleMsgId) {
        await bot.deleteMessage(chatId, player.currentBattleMsgId).catch(()=>{});
        delete player.currentBattleMsgId;
    }
    saveData();
    await bot.sendMessage(chatId, "🏃‍♂️ Ты убежал от Подопытного.", { reply_markup: mainMenuKeyboard() });
    return;
}

if (dataCb === "attack") {
    if (!player.monster) { 
        await bot.answerCallbackQuery(q.id, { text: "Сначала выйди на охоту.", show_alert: true }).catch(()=>{}); 
        return; 
    }

    // chance extra
    if (player.inventory.extra && Math.random() < 0.3) {
        const extra = player.inventory.extra;
        const events = [];
        if (extra.effect === "stun2") { player.monsterStun = (extra.turns || 2); events.push(`🧨 Сработал предмет: ${escMd(extra.name)} — монстр оглушён на ${player.monsterStun} ход(ов).`); }
        else if (extra.effect === "damage50") { player.monster.hp -= 50; events.push(`💥 Сработал предмет: ${escMd(extra.name)} — нанесено 50 урона монстру.`); }
        else if (extra.effect === "damage100") { player.monster.hp -= 100; events.push(`💥 Сработал предмет: ${escMd(extra.name)} — нанесено 100 урона монстру.`); }
        else if (extra.effect === "halfDamage1") { player.damageReductionTurns = (extra.turns || 1); events.push(`💪 Сработал предмет: ${escMd(extra.name)} — входящий урон делится на 2 на ${player.damageReductionTurns} ход(ов).`); }
        else if (extra.effect === "doubleDamage1") { player.damageBoostTurns = (extra.turns || 1); events.push(`⚡ Сработал предмет: ${escMd(extra.name)} — твой урон x2 на ${player.damageBoostTurns} ход(ов).`); }
        else if (extra.effect === "doubleInfection") { player.radiationBoost = true; events.push(`☣️ Сработал предмет: ${escMd(extra.name)} — следующая победа даст двойное заражение.`); }
        applyArmorHelmetBonuses(player);
        saveData();
        await bot.editMessageCaption(`${events.join("\n")}`, {
            chat_id: chatId,
            message_id: player.currentBattleMsgId,
            reply_markup: { inline_keyboard: [[{ text: "⚔️ Атаковать", callback_data: "attack" }]] }
        });
        return;
    }

    // normal attack
    player.firstAttack = true;
    const weaponBonus = player.inventory.weapon ? (player.inventory.weapon.dmg || 0) : 0;
    const weaponName = player.inventory.weapon ? player.inventory.weapon.name : "кулаки";
    const baseRoll = Math.floor(Math.random() * 30) + 10;
    let damage = baseRoll + weaponBonus;
    const events = [];

    if (player.inventory.mutation && player.inventory.mutation.crit) {
        if (Math.random() < player.inventory.mutation.crit) { 
            damage *= 2; 
            events.push(`💥 Критический удар! (${weaponName}) Урон удвоен до ${damage}.`); 
        }
    }
    if (player.damageBoostTurns && player.damageBoostTurns > 0) { 
        damage *= 2; 
        player.damageBoostTurns--; 
        events.push(`⚡ Бонус урона активирован (x2) на этот удар.`); 
    }

    player.monster.hp -= damage;
    events.push(`⚔️ Ты нанёс ${damage} урона (${weaponName})!`);

    if (damage > 0 && player.inventory.sign) {
        const signEffects = getSignEffects(player.inventory.sign);
        if (signEffects.vampirism > 0) {
            const healAmount = Math.max(1, Math.ceil(damage * signEffects.vampirism));
            const beforeHp = player.hp;
            player.hp = Math.min(player.maxHp, player.hp + healAmount);
            const actualHeal = player.hp - beforeHp;
            if (actualHeal > 0) {
                events.push(`🩸 ${player.inventory.sign.name} восстанавливает тебе ${actualHeal} HP.`);
            }
        }
    }

    if (player.monster.hp <= 0) {
        const monsterType = player.monster?.type || "weak";
        let infGain;
        if (monsterType === "boss") {
            infGain = 200;
        } else if (monsterType === "special") {
            infGain = SPECIAL_SUBJECT_INFECTION_REWARD;
        } else {
            infGain = (monsterType === "medium") ? 35 : (monsterType === "fat" ? 60 : 20);
        }
        if (player.radiationBoost) { infGain *= 2; player.radiationBoost = false; }
        player.infection += infGain;
        player.pendingDrop = null;
        if (monsterType === "boss") {
            const finalSign = getFinalSignTemplate();
            if (finalSign) {
                player.pendingDrop = { ...finalSign };
            }
        } else if (monsterType === "special") {
            const dropPool = [
              ...weaponItems.map(it => ({ ...it, kind: "weapon" })),
              ...helmetItems.map(it => ({ ...it, kind: "helmet" })),
              ...mutationItems.map(it => ({ ...it, kind: "mutation" })),
              ...extraItems.map(it => ({ ...it, kind: "extra" })),
              ...armorItems.map(it => ({ ...it, kind: "armor" }))
            ];
            if (dropPool.length > 0) {
              const picked = dropPool[Math.floor(Math.random() * dropPool.length)];
              if (picked) {
                player.pendingDrop = { ...picked };
              }
            }
        } else {
            const dropChance = (monsterType === "weak") ? 0.20 : (monsterType === "medium") ? 0.35 : 0.60;
            if (Math.random() < dropChance) {
                const dropPool = [
                  ...weaponItems.map(it => ({ ...it, kind: "weapon" })),
                  ...helmetItems.map(it => ({ ...it, kind: "helmet" })),
                  ...mutationItems.map(it => ({ ...it, kind: "mutation" })),
                  ...extraItems.map(it => ({ ...it, kind: "extra" })),
                  ...armorItems.map(it => ({ ...it, kind: "armor" }))
                ];
                const picked = pickByChance(dropPool);
                if (picked) player.pendingDrop = { ...picked };
            }
        }

        applyArmorHelmetBonuses(player);
        const survivalMessage = grantSurvivalDay(player);
        player.monster = null;
        player.monsterStun = 0;
        resetPlayerSignFlags(player);

        if (player.currentBattleMsgId) {
            await bot.deleteMessage(chatId, player.currentBattleMsgId).catch(()=>{});
            delete player.currentBattleMsgId;
        }

        saveData();
        let victoryPrefix;
        if (monsterType === "boss") {
            victoryPrefix = "💀 Ты уничтожил босса CRIMECORE";
        } else if (monsterType === "special") {
            victoryPrefix = "💀 Ты обезвредил Подопытную ***";
        } else {
            victoryPrefix = "💀 Ты убил Подопытного";
        }
        let winText = `${victoryPrefix} и получил +${infGain} заражения☣️!\nТекущий уровень заражения: ${player.infection}`;
        if (survivalMessage) {
            winText += `\n${survivalMessage}`;
        }
        if (monsterType === "special") {
            winText += "\n🗓 +1 день выживания.";
        }
        if (player.pendingDrop) {
            const dropSummary = formatDropSummary(player.pendingDrop);
            winText += `\n\n${dropSummary}\nЧто делать?`;
            await bot.sendMessage(chatId, `${events.join("\n")}\n\n${winText}`, {
                reply_markup: { inline_keyboard: [[{ text: "✅ Взять", callback_data: "take_drop" }],[{ text: "🗑️ Выбросить", callback_data: "discard_drop" }]] }
            });
        } else {
            await bot.sendMessage(chatId, `${events.join("\n")}\n\n${winText}`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] } });
        }
        return;
    }

    // monster attacks back
    let monsterText = "";
    if (player.monsterStun && player.monsterStun > 0) {
        player.monsterStun--;
        monsterText = `⚠️ Монстр оглушён и не атакует (${player.monsterStun} ходов осталось).`;
    } else {
        const helmetBlock = player.inventory.helmet ? (player.inventory.helmet.block || 0) : 0;
        const playerSign = player.inventory.sign;
        const signEffects = getSignEffects(playerSign);
        let incoming = player.monster.dmg;
        if (player.damageReductionTurns && player.damageReductionTurns > 0) {
            incoming = Math.ceil(incoming / 2);
            player.damageReductionTurns--;
        }

        let blocked = 0;
        let dodged = false;
        if (signEffects.dodgeChance > 0 && Math.random() < signEffects.dodgeChance) {
            dodged = true;
            incoming = 0;
            const signName = playerSign ? playerSign.name : "знаку";
            monsterText = `🌀 Ты увернулся от удара благодаря ${signName}!`;
        }

        if (!dodged) {
            blocked = Math.ceil(incoming * (helmetBlock / 100));
            incoming = Math.max(0, incoming - blocked);
            monsterText = `💥 Монстр ударил тебя на ${incoming} урона. (Шлем заблокировал ${blocked})`;
        }

        player.hp -= incoming;

        if (player.hp <= 0) {
            const protectionMessage = tryUseSignProtectionPve(player, playerSign);
            if (protectionMessage) {
                monsterText += `\n${protectionMessage}`;
            }
        }

        if (player.hp <= 0) {
            const monsterType = player.monster?.type || "weak";
            const loss = monsterType === "special" ? SPECIAL_SUBJECT_INFECTION_LOSS : Math.floor(Math.random() * 26) + 5;
            player.infection = Math.max(0, player.infection - loss);
            resetSurvivalProgress(player);
            applyArmorHelmetBonuses(player);
            player.hp = player.maxHp;
            player.monster = null;
            player.monsterStun = 0;
            resetPlayerSignFlags(player);

            if (player.currentBattleMsgId) {
                await bot.deleteMessage(chatId, player.currentBattleMsgId).catch(()=>{});
                delete player.currentBattleMsgId;
            }

            saveData();
            const deathLines = [
                `${events.join("\n")}`,
                "",
                monsterType === "special"
                    ? `☠️ Подопытная *** победила тебя и забрала ${loss} заражения☣️. Твой уровень: ${player.infection}`
                    : `☠️ Ты умер и потерял ${loss} уровня заражения☣️. Твой уровень: ${player.infection}`,
                monsterType === "special"
                    ? "🗓 Все дни выживания обнулены."
                    : "🗓 Дни выживания обнулились."
            ].filter(Boolean);
            await bot.sendMessage(chatId, deathLines.join("\n"), { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] } });
            return;
        }
    }

    saveData();
    await bot.editMessageCaption(
        `${events.join("\n")}\n\nHP монстра: ${player.monster.hp}/${player.monster.maxHp}\n${monsterText}\n❤️ Твои HP: ${player.hp}`,
        {
            chat_id: chatId,
            message_id: player.currentBattleMsgId,
            reply_markup: { inline_keyboard: [[{ text: "⚔️ Атаковать", callback_data: "attack" }], ...(player.firstAttack ? [] : [[{ text: "🏃 Убежать", callback_data: "run_before_start" }]])] }
        }
    );
    return;
}

  if (dataCb === "event_action") {
  if (!player.currentEvent) {
    await bot.answerCallbackQuery(q.id, { text: "Событие не найдено.", show_alert: true }).catch(()=>{});
    return;
  }
  const ev = player.currentEvent;
  delete player.currentEvent;

  let text = "";
  if (Math.random() < 0.5) {
    // GOOD эффект
    const infectionGain = Math.floor(Math.random() * 151) + 100; // 100–250
    player.infection = (player.infection || 0) + infectionGain;
    text = `✅ ${ev.good}\n\n☣️ Ты получил ${infectionGain} заражения.`;
    const survivalMessage = grantSurvivalDay(player);
    if (survivalMessage) {
      text += `\n\n${survivalMessage}`;
    }

    // 15% шанс предмета
    if (Math.random() < 0.15) {
      const dropPool = [
        ...weaponItems.map(it => ({ ...it, kind: "weapon" })),
        ...helmetItems.map(it => ({ ...it, kind: "helmet" })),
        ...mutationItems.map(it => ({ ...it, kind: "mutation" })),
        ...extraItems.map(it => ({ ...it, kind: "extra" })),
        ...armorItems.map(it => ({ ...it, kind: "armor" }))
      ];
      const picked = pickByChance(dropPool);
      if (picked) {
        player.pendingDrop = { ...picked };
        const rewardText = formatItemRewardMessage(picked);
        text += `\n\n${rewardText}\nЧто делаем?`;
        saveData();
        await editOrSend(chatId, messageId, text, {
          reply_markup: { inline_keyboard: [[{ text: "✅ Взять", callback_data: "take_drop" }], [{ text: "🗑️ Выбросить", callback_data: "discard_drop" }]] }
        });
        return;
      }
    }
    saveData();
    await editOrSend(chatId, messageId, text, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] } });
    return;
  } else {
    // BAD эффект
    text = `❌ ${ev.bad}`;
    if (ev.badEffect) {
      applyBadEffect(player, ev.badEffect);
      if (ev.badEffect.type === "lose_points") {
        text += `\n\n☣️ Ты потерял ${ev.badEffect.amount} заражения.`;
      } else if (ev.badEffect.type === "lose_item" && ev.badEffect.slot) {
        text += `\n\n🗑️ Ты потерял предмет из слота: ${ev.badEffect.slot}.`;
      }
    }
    saveData();
    await editOrSend(chatId, messageId, text, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] } });
    return;
  }
  }

  if (dataCb.startsWith('rescue_reward:')) {
    if (!player.pendingRescueGift) {
      await bot.answerCallbackQuery(q.id, {
        text: 'Событие больше не активно.',
        show_alert: true
      }).catch(() => {});
      return;
    }

    const [, category] = dataCb.split(':');
    const pools = {
      helmet: helmetItems,
      armor: armorItems,
      weapon: weaponItems,
      mutation: mutationItems,
      extra: extraItems
    };

    const pool = pools[category];
    if (!pool || pool.length === 0) {
      await bot.answerCallbackQuery(q.id, {
        text: 'Не удалось подобрать предмет.',
        show_alert: true
      }).catch(() => {});
      return;
    }

    const reward = pickRandomItem(pool);
    if (!reward) {
      await bot.answerCallbackQuery(q.id, {
        text: 'Предмет не найден.',
        show_alert: true
      }).catch(() => {});
      return;
    }

    player.pendingDrop = { ...reward };
    player.pendingRescueGift = null;
    saveData();

    const dropSummary = formatDropSummary(player.pendingDrop);
    await bot.answerCallbackQuery(q.id).catch(() => {});
    await bot.editMessageCaption(
      `Она достаёт из сумки выбранный предмет и протягивает его тебе.\n\n${dropSummary}\nЧто делать?`,
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Взять', callback_data: 'take_drop' }],
            [{ text: '🗑️ Выбросить', callback_data: 'discard_drop' }]
          ]
        }
      }
    ).catch(async () => {
      await bot.sendMessage(chatId, `${dropSummary}\nЧто делать?`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Взять', callback_data: 'take_drop' }],
            [{ text: '🗑️ Выбросить', callback_data: 'discard_drop' }]
          ]
        }
      });
    });
    return;
  }

  if (dataCb.startsWith("danger_move:")) {
    if (!player.currentDanger) {
      await bot.answerCallbackQuery(q.id, { text: "Опасное событие не активно.", show_alert: true }).catch(()=>{});
      return;
    }
    const idx = dataCb.split(":")[1] || "0";
    await continueDangerEvent(player, chatId, messageId, idx);
    return;
  }

  if (dataCb === "take_drop") {
    if (!player.pendingDrop) { await bot.answerCallbackQuery(q.id, { text: "Нечего брать.", show_alert: true }).catch(()=>{}); return; }
    const item = player.pendingDrop;
    let slot = "extra";
    if (item.kind === "weapon") slot = "weapon";
    else if (item.kind === "helmet") slot = "helmet";
    else if (item.kind === "armor") slot = "armor";
    else if (item.kind === "mutation") slot = "mutation";
    else if (item.kind === "extra") slot = "extra";
    else if (item.kind === "sign") slot = "sign";

    const prev = player.inventory[slot];
    player.inventory[slot] = item;
    player.pendingDrop = null;
    if (slot === "sign") {
      resetPlayerSignFlags(player);
    }
    applyArmorHelmetBonuses(player);
    saveData();

    if (prev) await editOrSend(chatId, messageId, `✅ Предмет заменён: ${escMd(prev.name)} → ${escMd(item.name)}`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] } });
    else await editOrSend(chatId, messageId, `✅ Вы взяли: ${escMd(item.name)}`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] } });

    return;
  }

  if (dataCb === "discard_drop") {
    player.pendingDrop = null;
    saveData();
    await editOrSend(chatId, messageId, `🗑️ Предмет выброшен.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] } });
    return;
  }

  if (dataCb === "inventory") {
    const chatId = q.message.chat.id;
    const messageId = q.message?.message_id;
    const player = ensurePlayer(q.from);
    ensurePvpRatingFields(player);
    const text = buildInventoryText(player);
    const keyboard = buildInventoryKeyboard("gear");
    const img = await generateInventoryImage(player);

    await bot.answerCallbackQuery(q.id).catch(() => {});

    if (img) {
      if (q.message?.photo?.length) {
        try {
          await bot.editMessageMedia(
            { type: "photo", media: { source: img }, caption: text, parse_mode: "Markdown" },
            { chat_id: chatId, message_id: messageId, reply_markup: keyboard }
          );
          return;
        } catch (err) {
          // Fallback to sending a fresh photo below.
        }
      }

      await bot.sendPhoto(chatId, img, { caption: text, parse_mode: "Markdown", reply_markup: keyboard });
      return;
    }

    await editOrSend(chatId, messageId, text, { reply_markup: keyboard, parse_mode: "Markdown" });
    return;
  }

  if (dataCb === "inventory:crimecoins") {
    const chatId = q.message.chat.id;
    const messageId = q.message?.message_id;
    const player = ensurePlayer(q.from);
    ensurePvpRatingFields(player);
    const text = buildCrimecoinsInfoText(player);
    const keyboard = buildInventoryKeyboard("coins");

    await bot.answerCallbackQuery(q.id).catch(() => {});

    if (q.message?.photo?.length) {
      try {
        await bot.editMessageCaption(text, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
          reply_markup: keyboard
        });
        return;
      } catch (err) {
        // Fall through to editing text if caption update fails.
      }
    }

    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: keyboard
      });
    } catch (err) {
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
    }

    return;
  }

  if (dataCb === "leaderboard" || dataCb === "leaderboard_survival") {
    const text = buildSurvivalLeaderboardText(player);
    await editOrSend(chatId, messageId, text, { reply_markup: leaderboardResultKeyboard() });
    return;
  }
});

bot.onText(/^\/reboot$/i, (msg) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;

  // if (fromId !== 169131351) {
  //   return bot.sendMessage(chatId, "⛔ У вас нет прав для выполнения этой команды.");
  // }

  bot.sendMessage(chatId, "♻️ Бот перезапущен");

  // Немного даём времени на отправку сообщения перед перезапуском
  setTimeout(() => {
    // «Тронуть» любой JS-файл, чтобы Nodemon увидел изменение
    const filePath = path.join(__dirname, 'index.js');
    fs.utimesSync(filePath, new Date(), new Date());
    process.exit(0); // Nodemon увидит изменение и перезапустит
  }, 1000);
});


bot.onText(/^\/pull$/i, async (msg) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;

  // if (fromId !== 169131351) {
  //   return bot.sendMessage(chatId, "⛔ У вас нет прав для выполнения этой команды.");
  // }

  bot.sendMessage(chatId, "📡 Обновление из ветки test...");

  exec('git pull origin test', (error, stdout, stderr) => {
    if (error) {
      console.error(error);
      return bot.sendMessage(chatId, `❌ Ошибка при выполнении git pull:\n<code>${error.message}</code>`, { parse_mode: 'HTML' });
    }

    if (stderr) {
      bot.sendMessage(chatId, `⚠️ Предупреждение:\n<code>${stderr}</code>`, { parse_mode: 'HTML' });
    }

    bot.sendMessage(chatId, `✅ Обновление завершено.\n<code>${stdout}</code>`, { parse_mode: 'HTML' });
  });
});

bot.onText(/^\/giveto\s+(\d+)\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  
  // Check if user is admin
  if (!isAdmin(fromId)) {
    return bot.sendMessage(chatId, "⛔ У вас нет прав для выполнения этой команды.");
  }

  const targetId = match[1];
  const itemName = match[2].trim();
  
  const targetPlayer = players[targetId];
  if (!targetPlayer) {
    return bot.sendMessage(chatId, "❌ Игрок не найден.");
  }

  const item = findItemByName(itemName);
  if (!item) {
    return bot.sendMessage(chatId, `❌ Предмет "${itemName}" не найден.`);
  }

  // Add item to player's inventory
  const slot = item.kind || 'weapon'; // Default to weapon if kind not specified
  targetPlayer.inventory = targetPlayer.inventory || {};
  targetPlayer.inventory[slot] = { ...item };
  saveData();
  
  bot.sendMessage(chatId, `✅ Предмет "${item.name}" выдан игроку ${targetPlayer.name || targetPlayer.username || targetId}.`);
  bot.sendMessage(targetId, `🎁 Администратор выдал Вам предмет: ${item.name}`);
});

bot.onText(/^\/pointsto\s+(\d+)\s+(-?\d+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  
  // Check if user is admin
  if (!isAdmin(fromId)) {
    return bot.sendMessage(chatId, "⛔ У вас нет прав для выполнения этой команды.");
  }

  const targetId = match[1];
  const points = parseInt(match[2], 10);
  
  if (isNaN(points)) {
    return bot.sendMessage(chatId, "❌ Некорректное количество очков.");
  }

  const targetPlayer = players[targetId];
  if (!targetPlayer) {
    return bot.sendMessage(chatId, "❌ Игрок не найден.");
  }

  targetPlayer.infection = (targetPlayer.infection || 0) + points;
  saveData();
  
  const action = points >= 0 ? "начислено" : "списано";
  const absPoints = Math.abs(points);
  bot.sendMessage(chatId, `✅ Игроку ${targetPlayer.name || targetPlayer.username || targetId} ${action} ${absPoints} очк(а/ов) заражения.`);
  bot.sendMessage(targetId, points >= 0 
    ? `🎉 Администратор начислил Вам ${absPoints} очк(а/ов) заражения. Текущий баланс: ${targetPlayer.infection}`
    : `⚠️ Администратор списал с Вас ${absPoints} очк(а/ов) заражения. Текущий баланс: ${targetPlayer.infection}`
  );
});

bot.onText(/^\/crimecoins(?:@\w+)?\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;

  if (!isAdmin(fromId)) {
    await bot.sendMessage(chatId, "⛔ У вас нет прав для выполнения этой команды.");
    return;
  }

  const argsText = match && match[1] ? match[1].trim() : '';
  if (!argsText) {
    await bot.sendMessage(chatId, "Использование: /crimecoins <игрок> <количество>");
    return;
  }

  const parts = argsText.split(/\s+/);
  if (parts.length < 2) {
    await bot.sendMessage(chatId, "Укажите игрока и количество CRIMECOINS. Пример: /crimecoins @username 50");
    return;
  }

  const amountRaw = parts.pop();
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount)) {
    await bot.sendMessage(chatId, "❌ Некорректное количество CRIMECOINS.");
    return;
  }

  const targetIdentifier = parts.join(' ');
  const targetPlayer = findPlayerByIdentifier(targetIdentifier);
  if (!targetPlayer) {
    await bot.sendMessage(chatId, "❌ Игрок не найден.");
    return;
  }

  const before = Number.isFinite(targetPlayer.crimecoins) ? targetPlayer.crimecoins : 0;
  const after = before + amount;
  targetPlayer.crimecoins = after;
  saveData();

  const absAmount = Math.abs(amount);
  const action = amount >= 0 ? 'начислено' : 'списано';
  const targetDisplay = targetPlayer.name || targetPlayer.username || targetPlayer.id;
  await bot.sendMessage(
    chatId,
    `✅ Игроку ${targetDisplay} ${action} ${absAmount} 🪙 CRIMECOINS. Текущий баланс: ${after}. По пожертвованиям обращайтесь к ${DONATION_CONTACT}.`
  );

  const contactText = `По вопросам обращайтесь к ${DONATION_CONTACT}.`;
  if (amount >= 0) {
    await bot
      .sendMessage(
        targetPlayer.id,
        `🪙 Вам начислено ${absAmount} CRIMECOINS за благотворительное пожертвование! Спасибо за поддержку проекта. ${contactText}`
      )
      .catch(() => {});
  } else {
    await bot
      .sendMessage(
        targetPlayer.id,
        `⚠️ Администратор скорректировал ваш баланс на ${absAmount} CRIMECOINS. Текущий баланс: ${after}. ${contactText}`
      )
      .catch(() => {});
  }
});

// Add this helper function to check admin rights
function isAdmin(userId) {
  // Add your admin IDs here or load from environment
  const adminIds = process.env.ADMIN_IDS ?
    process.env.ADMIN_IDS.split(',').map(Number) :
    []; // Add default admin IDs if needed
  return adminIds.includes(Number(userId));
}

// /play
bot.onText(/\/play/, (msg) => {
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(msg.chat.id, "Ошибка регистрации. Попробуйте /start.");
  applyArmorHelmetBonuses(player);
  const menuText = buildMainMenuText(player);
  editOrSend(msg.chat.id, null, menuText, { reply_markup: mainMenuKeyboard() });
});

// /report
bot.onText(/\/report/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Опишите проблему, укажите потерянные предметы и прикрепите скриншот. Скриншот и подпись к скриншоту — одно сообщение = одна заявка. Не нужно писать всё разными сообщениями, иначе мы этого не увидим.\n ⚠️ На скриншоте должно быть чётко видно дату сообщения с инвентарём и время.\n\n❗️Скриншоты, сделанные ранее 25 сентября, рассматриваться не будут."
  );

  bot.once("photo", (photoMsg) => {
    const fileId = photoMsg.photo[photoMsg.photo.length - 1].file_id;
    const userText = photoMsg.caption || "— без описания —";
    const caption = 
      `Новая заявка от пользователя @${photoMsg.from.username || "неизвестно"}\n` +
      `ID: ${photoMsg.from.id}\n` +
      `Описание: ${userText}`;

    bot.sendPhoto(7897895019, fileId, { caption }).then((sentMsg) => {
      bot.on("text", (replyMsg) => {
        if (
          replyMsg.chat.id === 7897895019 &&
          replyMsg.reply_to_message &&
          replyMsg.reply_to_message.message_id === sentMsg.message_id
        ) {
          if (replyMsg.text === "/confirm") {
            bot.sendMessage(photoMsg.chat.id, "✅ Ваша заявка была обработана.");
          } else if (replyMsg.text === "/decline") {
            bot.sendMessage(photoMsg.chat.id, "❌ Ваша заявка была отклонена.");
          }
        }
      });
    });
  });
});

// /start
async function playerExistsInPersistentStorage(userId) {
  const numericId = Number(userId);
  if (!Number.isFinite(numericId)) return false;
  if (!pool || typeof pool.execute !== 'function') return false;

  const placeholder = DB_DIALECT === 'postgres' ? '$1' : '?';
  const query = `SELECT 1 FROM players WHERE id = ${placeholder} LIMIT 1`;

  try {
    const [rows] = await pool.execute(query, [numericId]);
    if (Array.isArray(rows)) {
      return rows.length > 0;
    }
    if (rows && Array.isArray(rows.rows)) {
      return rows.rows.length > 0;
    }
    if (rows && typeof rows.rowCount === 'number') {
      return rows.rowCount > 0;
    }
    return Boolean(rows);
  } catch (err) {
    if (!/no such table/i.test(String(err.message))) {
      console.error('Не удалось проверить наличие игрока в базе данных:', err);
    }
  }

  return false;
}

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const playerKey = String(msg.from.id);
  let existedBefore = Boolean(players[playerKey]);
  if (!existedBefore) {
    existedBefore = await playerExistsInPersistentStorage(playerKey);
  }
  const player = ensurePlayer(msg.from);
  if (!player) {
    await bot.sendMessage(msg.chat.id, "Ошибка регистрации. Попробуйте снова.").catch(() => {});
    return;
  }

  let referralUpdated = false;
  const payload = match && match[1] ? match[1].trim() : '';
  const referrerId = !existedBefore ? parseReferralPayload(payload) : null;
  if (referrerId && referrerId !== player.id) {
    const inviter = players[String(referrerId)];
    if (inviter) {
      let inviteeIds = [];
      if (Array.isArray(inviter.invitedUserIds)) {
        inviteeIds = inviter.invitedUserIds
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0);
      }
      if (!inviteeIds.includes(player.id)) {
        inviteeIds.push(player.id);
        inviter.invitedUserIds = inviteeIds;
        const currentAvailable = Number(inviter.inviteCasesAvailable) || 0;
        inviter.inviteCasesAvailable = currentAvailable + 1;
        if (typeof inviter.inviteCasesOpened !== 'number' || !Number.isFinite(inviter.inviteCasesOpened)) {
          inviter.inviteCasesOpened = 0;
        }
        referralUpdated = true;
        bot
          .sendMessage(
            referrerId,
            `@${player.username} впервые запустил бота по твоей ссылке! Кейс уже ждёт тебя в разделе «Притащить тело».`
          )
          .catch(() => {});
      }
    }
  }

  if (referralUpdated) {
    await saveData();
  }

  applyArmorHelmetBonuses(player);
  const startText = buildStartMessage(player);
  await bot
    .sendMessage(msg.chat.id, startText, { reply_markup: mainMenuKeyboard(), parse_mode: "Markdown" })
    .catch(() => {});
});

  // Auto-save every 30s
  if (process.env.NODE_ENV !== 'test') {
    const autosaveInterval = setInterval(saveData, 30000);
    if (typeof autosaveInterval.unref === 'function') {
      autosaveInterval.unref();
    }
  }



// --- Aliases (без подчеркиваний) для удобства: /clancreate, /clantop, /clanleave, /clanbattle ---
bot.onText(/\/clancreate(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не удалось найти профиль. Введите /play.");
  const name = match && match[1] ? String(match[1]).trim() : "";
  if (!name) return bot.sendMessage(chatId, "Использование: /clancreate <название клана>");
  if (name.length < 2) return bot.sendMessage(chatId, "Укажите корректное название клана (минимум 2 символа).");
  if (player.clanId) return bot.sendMessage(chatId, "Вы уже в клане — сначала выйдите (/clan_leave).");
  const exists = Object.values(clans).find(c => String(c.name).toLowerCase() === name.toLowerCase());
  if (exists) return bot.sendMessage(chatId, "Клан с таким названием уже существует. Выберите другое имя.");
  const clan = ensureClan(name, player.id);
  if (!Array.isArray(clan.members)) clan.members = [];
  if (!clan.members.some((id) => Number(id) === Number(player.id))) {
    clan.members.push(player.id);
  }
  ensureClanHasLeader(clan);
  player.clanId = clan.id;
  saveData();
  bot.sendMessage(chatId, `✅ Клан "${escMd(clan.name)}" создан. Вы вошли в клан.`);
});

bot.onText(/\/clantop/, (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  const text = buildClanTopText(player);
  if (!text) return bot.sendMessage(chatId, "Пока нет зарегистрированных кланов.");
  bot.sendMessage(chatId, text);
});

bot.onText(/\/clanleave/, (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  if (!player.clanId) return bot.sendMessage(chatId, "Вы не состоите в клане.");
  const cid = String(player.clanId);
  const clan = clans[cid];
  if (clan) {
    clan.members = (clan.members || []).filter(id => String(id) !== String(player.id));
    if (clan.members.length === 0) {
      delete clans[cid];
    } else if (Number(clan.leaderId) === Number(player.id)) {
      ensureClanHasLeader(clan);
    }
  }
  player.clanId = null;
  removeClanQueueEntry(cid, player.id);
  saveData();
  bot.sendMessage(chatId, "Вы вышли из клана.");
});

bot.onText(/\/clanbattle/, async (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  if (!player.clanId) return bot.sendMessage(chatId, "Вы не состоите в клане. Вступите в клан или создайте его: /clan_create <имя>.");
  const clan = clans[String(player.clanId)];
  if (!clan) return bot.sendMessage(chatId, "Ошибка: ваш клан не найден.");
  if (player.pvp) return bot.sendMessage(chatId, "Вы сейчас в PvP — дождитесь конца боя.");
  addClanQueue(clan.id, player.id);
  await bot.sendMessage(chatId, `✅ Вы подали заявку на клановую битву за \"${escMd(clan.name)}\".\nТекущая очередь вашего клана: ${clanBattleQueue[String(clan.id)] ? clanBattleQueue[String(clan.id)].length : 0}`);
  tryStartClanBattleCountdown(chatId);
});


// --- Text-command wrappers and PvP accept/duel system ---

// Helper: find a pvp request by various identifiers
function findPvpRequestByIdentifier(identifier) {
  if (!identifier) return null;
  const id = String(identifier).trim();
  if (pvpRequests[id]) return pvpRequests[id];
  if (pvpRequests['@' + id]) return pvpRequests['@' + id];
  // try numeric id
  if (/^\d+$/.test(id) && pvpRequests[id]) return pvpRequests[id];
  // fallback: search values by username or challengerId
  for (const k of Object.keys(pvpRequests)) {
    const r = pvpRequests[k];
    if (!r) continue;
    if (String(r.challengerId) === id) return r;
    if (r.username && String(r.username).toLowerCase() === id.toLowerCase()) return r;
    if (('@' + String(r.username)).toLowerCase() === id.toLowerCase()) return r;
  }
  return null;
}

function clearPvpRequestForPlayer(player) {
  if (!player) return;
  const keys = [String(player.id)];
  if (player.username) {
    keys.push(player.username, '@' + player.username);
  }
  keys.forEach(k => { if (pvpRequests[k]) delete pvpRequests[k]; });
}

async function sendPvpRequestAnnouncement(chatId, player) {
  if (!player || !chatId) return;
  const usernameDisplay = player.username || `id${player.id}`;
  const acceptTarget = player.username || player.id;
  const requestText = `🏹 @${usernameDisplay} ищет соперника!\nЧтобы принять вызов, напишите: /pvp @${acceptTarget}\nЗаявка действует ${Math.floor(PVP_REQUEST_TTL/1000)} секунд.`;
  const img = await generateInventoryImage(player);
  if (img) {
    await bot.sendPhoto(chatId, img, { caption: requestText, parse_mode: "Markdown" });
  } else {
    await bot.sendMessage(chatId, requestText, { parse_mode: "Markdown" });
  }
}

// Start a 1v1 PvP fight (automatic)
function startPvpFight(challenger, opponent, chatId, options = {}) {
  if (!challenger || !opponent) {
    if (chatId) bot.sendMessage(chatId, "Ошибка: участники не найдены.");
    return;
  }
  const remainingCooldown = Math.max(
    getPvpCooldownRemaining(challenger),
    getPvpCooldownRemaining(opponent)
  );
  if (remainingCooldown > 0) {
    if (chatId) {
      const seconds = Math.ceil(remainingCooldown / 1000);
      bot.sendMessage(chatId, `⏳ Подождите ${seconds} сек. перед началом нового PvP.`);
    }
    return;
  }
  // ensure pvp state initialized
  if (!initPvpState(challenger, opponent)) {
    bot.sendMessage(chatId, "Не удалось инициализировать PvP.");
    return;
  }
  markPvpStartTimestamp(challenger, opponent);

  const ranked = Boolean(options?.ranked);
  const ratingReward = Number.isFinite(options?.ratingReward)
    ? options.ratingReward
    : RANKED_PVP_RATING_REWARD;
  const rankedIds = new Set(
    (options?.rankedPlayerIds && Array.isArray(options.rankedPlayerIds)
      ? options.rankedPlayerIds
      : ranked
        ? [challenger.id]
        : []
    ).map(id => String(id))
  );

  const isRankedPlayer = (player) => ranked && rankedIds.has(String(player?.id));
  if (isRankedPlayer(challenger)) ensurePvpRatingFields(challenger);
  if (isRankedPlayer(opponent)) ensurePvpRatingFields(opponent);

  const fightLabel = ranked ? "🥇 Рейтинговое PvP" : "⚔️ PvP";
  bot.sendMessage(chatId, `${fightLabel}: @${challenger.username} против @${opponent.username}. Бой начинается!`);

  async function concludeFight(winner, loser) {
    winner.pvpWins = (winner.pvpWins || 0) + 1;
    loser.pvpLosses = (loser.pvpLosses || 0) + 1;

    if (isRankedPlayer(winner)) {
      const { current, best } = grantRankedPvpPoints(winner, ratingReward);
      await bot.sendMessage(
        chatId,
        `🥇 @${winner.username} побеждает в рейтинговом PvP! (+${ratingReward} рейтинга, сейчас: ${current}, рекорд: ${best})`
      );
    } else {
      const currentInfection = Number.isFinite(winner.infection) ? winner.infection : 0;
      winner.infection = currentInfection + PVP_POINT;
      await bot.sendMessage(chatId, `🏆 @${winner.username} победил в PvP! (+${PVP_POINT} очков заражения)`);
    }

    if (isRankedPlayer(loser)) {
      const bestBefore = Number.isFinite(loser.pvpRatingBest) ? loser.pvpRatingBest : 0;
      resetPvpRating(loser);
      await bot.sendMessage(
        chatId,
        `📉 @${loser.username} теряет текущий рейтинг. Текущий рейтинг: ${loser.pvpRating} (рекорд: ${bestBefore}).`
      );
    }

    resetPlayerSignFlags(challenger);
    resetPlayerSignFlags(opponent);
    delete challenger.pvp;
    delete opponent.pvp;
    saveData();
  }

  // turn: 'A' = challenger, 'B' = opponent
  let turn = 'A';

  async function processRound() {
    try {
      const a = (turn === 'A') ? challenger : opponent;
      const b = (turn === 'A') ? opponent : challenger;
      const aState = a.pvp;
      const bState = b.pvp;

      // safety checks
      if (!aState || !bState) {
        bot.sendMessage(chatId, "Ошибка состояния PvP. Бой прерван.");
        if (challenger.pvp) delete challenger.pvp;
        if (opponent.pvp) delete opponent.pvp;
        saveData();
        return;
      }

      // check if someone already dead
      if (aState.myHp <= 0) {
        await bot.sendMessage(chatId, `💀 @${a.username} пал в бою (от @${b.username}).`);
        await concludeFight(b, a);
        return;
      }
      if (bState.myHp <= 0) {
        await bot.sendMessage(chatId, `💀 @${b.username} пал в бою (от @${a.username}).`);
        await concludeFight(a, b);
        return;
      }

      // stun handling
      if (aState.myStun && aState.myStun > 0) {
        aState.myStun--;
        await bot.sendMessage(chatId, `⏱️ @${a.username} оглушён и пропускает ход (${aState.myStun} осталось).\nHP: @${challenger.username} ${Math.max(0, challenger.pvp.myHp)}/${challenger.maxHp} — @${opponent.username} ${Math.max(0, opponent.pvp.myHp)}/${opponent.maxHp}`);
      } else {
        const events = computeAttackForPvp(a, b, aState, bState);
        await bot.sendMessage(chatId, `${events.join("\n")}\n\nHP: @${challenger.username} ${Math.max(0, challenger.pvp.myHp)}/${challenger.maxHp} — @${opponent.username} ${Math.max(0, opponent.pvp.myHp)}/${opponent.maxHp}`);
      }

      // check death after attack
      if (bState.myHp <= 0) {
        a.pvpWins = (a.pvpWins || 0) + 1;
        b.pvpLosses = (b.pvpLosses || 0) + 1;
        await bot.sendMessage(chatId, `💀 @${b.username} пал в бою (от @${a.username}).`);
        await concludeFight(a, b);
        return;
      }

      // switch turn
      turn = (turn === 'A') ? 'B' : 'A';
      saveData();
      setTimeout(processRound, 2500);
    } catch (e) {
      console.error("startPvpFight error:", e);
      try { bot.sendMessage(chatId, "Ошибка в PvP: " + String(e)); } catch {}
      resetPlayerSignFlags(challenger);
      resetPlayerSignFlags(opponent);
      if (challenger.pvp) delete challenger.pvp;
      if (opponent.pvp) delete opponent.pvp;
      saveData();
    }
  }

  // first tick
  setTimeout(processRound, 5000);
}

// /pvp [target] - without args: create a pvp request; with target: accept challenge by that target
bot.onText(/\/pvp(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  const arg = match && match[1] ? String(match[1]).trim() : "";
  if (!arg) {
    // create request (same as pvp_request callback)
    const keyById = String(player.id);
    const reqObj = { challengerId: player.id, username: player.username || null, chatId, ts: Date.now() };
    pvpRequests[keyById] = reqObj;
    if (player.username) {
      pvpRequests[`@${player.username}`] = reqObj;
      pvpRequests[player.username] = reqObj;
    }
    await sendPvpRequestAnnouncement(chatId, player);
    return;
  } else {
    // accept
    const targetIdent = arg.startsWith('@') ? arg.slice(1) : arg;
    const req = findPvpRequestByIdentifier(targetIdent);
    if (!req) return bot.sendMessage(chatId, "Заявка соперника не найдена или истекла. Убедитесь, что вы указали корректный ник/ID и что игрок подавал заявку (через /pvp).");
    if (String(req.challengerId) === String(player.id)) return bot.sendMessage(chatId, "Нельзя принять собственную заявку.");
    // check expiry
    if (Date.now() - req.ts > PVP_REQUEST_TTL) {
      clearPvpRequestForPlayer({ id: req.challengerId, username: req.username });
      return bot.sendMessage(chatId, "Заявка истекла.");
    }
    const challenger = players[String(req.challengerId)];
    if (!challenger) return bot.sendMessage(chatId, "Не удалось найти игрока, подавшего заявку.");
    const cooldown = Math.max(getPvpCooldownRemaining(challenger), getPvpCooldownRemaining(player));
    if (cooldown > 0) {
      const seconds = Math.ceil(cooldown / 1000);
      return bot.sendMessage(chatId, `⏳ Один из игроков недавно начал PvP. Подождите ${seconds} сек.`);
    }
    // clear request keys
    clearPvpRequestForPlayer(challenger);
    // start fight
    startPvpFight(challenger, player, chatId);
    return;
  }
});

// /pvp_request (text alias)
bot.onText(/\/pvp_request/, async (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  const keyById = String(player.id);
  const reqObj = { challengerId: player.id, username: player.username || null, chatId, ts: Date.now() };
  pvpRequests[keyById] = reqObj;
  if (player.username) {
    pvpRequests[`@${player.username}`] = reqObj;
    pvpRequests[player.username] = reqObj;
  }
  await sendPvpRequestAnnouncement(chatId, player);
});

// /inventory (text command)
bot.onText(/\/inventory/, async (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: нет профиля");
  ensurePvpRatingFields(player);
  const text = buildInventoryText(player);
  const img = await generateInventoryImage(player);
  const kb = { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] };
  if (img) {
    await bot.sendPhoto(chatId, img, { caption: text, parse_mode: "Markdown", reply_markup: kb });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
  }

});

// /leaderboard (text command)
bot.onText(/\/leaderboard/, (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  const text = buildSurvivalLeaderboardText(player);
  bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: leaderboardResultKeyboard() });
});


// === КОМАНДЫ ПРИГЛАШЕНИЯ В КЛАН ===


// /acceptbattle — принять клановую битву
bot.onText(/\/acceptbattle/, async (msg) => {
  console.log("DEBUG: /acceptbattle command triggered");
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  if (!player.clanId || !clans[String(player.clanId)]) {
    console.log("DEBUG: Player not in clan");
    return bot.sendMessage(chatId, "Вы не состоите в клане.");
  }
  const clanId = String(player.clanId);
  console.log("DEBUG: Player clanId =", clanId);

  const pending = clanBattles.find(b => b.status === "pending" && String(b.opponentClanId) === clanId);
  if (!pending) {
    console.log("DEBUG: No pending battle for this clan");
    return bot.sendMessage(chatId, "Нет активных заявок на битву против вашего клана.");
  }
  if (clanBattles.find(b => b.status === "active" && (String(b.clanId) === clanId || String(b.opponentClanId) === clanId))) {
    console.log("DEBUG: Clan already in active battle");
    return bot.sendMessage(chatId, "Ваш клан уже участвует в активной битве.");
  }
  if (pending.acceptedBy && String(pending.acceptedBy) !== clanId) {
    console.log("DEBUG: Already accepted by another clan");
    return bot.sendMessage(chatId, "Эта заявка уже принята другим кланом.");
  }

  pending.status = "active";
  pending.acceptedBy = clanId;
  saveData();
  console.log("DEBUG: Battle accepted successfully");
  bot.sendMessage(chatId, `✅ Клановая битва принята! Битва против клана "${clans[String(pending.clanId)].name}" начинается.`);
  startClanBattle(pending.clanId, pending.opponentClanId, chatId);
});

// /inviteclan @username|id
bot.onText(/\/inviteclan(?:@\w+)?\s+(.+)/i, (msg, match) => {
  console.log("DEBUG /inviteclan triggered", match);
  const chatId = msg.chat.id;
  const inviter = ensurePlayer(msg.from);
  if (!inviter || !inviter.clanId) return bot.sendMessage(chatId, "Вы должны быть в клане, чтобы приглашать.");
  const raw = match[1] ? String(match[1]).trim() : "";
  if (!raw) return bot.sendMessage(chatId, "Использование: /inviteclan @username или /inviteclan id");
  let targetId = null;
  if (/^\d+$/.test(raw)) {
    targetId = String(raw);
  } else {
    const target = findPlayerByIdentifier(raw);
    if (target && target.id) targetId = String(target.id);
  }
  if (!targetId) return bot.sendMessage(chatId, "Игрок не найден.");
  const expires = Date.now() + 5 * 60 * 1000;
  clanInvites[targetId] = { clanId: inviter.clanId, fromId: inviter.id, expires };
  saveData();
  console.log("DEBUG invite saved:", clanInvites);
  bot.sendMessage(chatId, `✅ Приглашение сохранено: ${targetId} приглашён в клан "${clans[String(inviter.clanId)].name}".`);
  try {
    const maybePlayer = players[String(targetId)];
    if (maybePlayer && maybePlayer.id) {
      bot.sendMessage(Number(targetId), `📩 Вас пригласил в клан "${clans[String(inviter.clanId)].name}" — @${inviter.username}. Примите командой /acceptclan @${inviter.username}`);
    }
  } catch (e) { console.error(e); }
});

// /acceptclan [@username|id]
bot.onText(/\/acceptclan(?:@\w+)?(?:\s+(.+))?/i, (msg, match) => {
  console.log("DEBUG /acceptclan triggered", match);
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  if (player.clanId) return bot.sendMessage(chatId, "Вы уже состоите в клане.");
  const arg = match && match[1] ? String(match[1]).trim() : null;
  const myKey = String(player.id);
  let invite = clanInvites[myKey];
  if (!invite && arg) {
    let inviterId = null;
    if (/^\d+$/.test(arg)) inviterId = Number(arg);
    else {
      const inv = findPlayerByIdentifier(arg);
      if (inv && inv.id) inviterId = Number(inv.id);
    }
    if (inviterId && clanInvites[myKey] && Number(clanInvites[myKey].fromId) === inviterId) invite = clanInvites[myKey];
  }
  if (!invite) return bot.sendMessage(chatId, "У вас нет действующего приглашения.");
  if (invite.expires <= Date.now()) {
    delete clanInvites[myKey];
    saveData();
    return bot.sendMessage(chatId, "Приглашение просрочено.");
  }
  const clan = clans[String(invite.clanId)];
  if (!clan) return bot.sendMessage(chatId, "Клан уже не существует.");
  if (!Array.isArray(clan.members)) clan.members = [];
  if (!clan.members.includes(player.id)) clan.members.push(player.id);
  player.clanId = clan.id;
  delete clanInvites[myKey];
  saveData();
  console.log("DEBUG accept complete:", clans[String(clan.id)]);
  bot.sendMessage(chatId, `✅ Вы вступили в клан "${escMd(clan.name)}".`);
});




// ====== Упрощённое лобби клановых боёв ======

let clanBattleLobby = [];
let clanBattleActive = false;
let clanBattleTimer = null;

bot.onText(/\/clan_battle/, (msg) => {
    const user = ensurePlayer(msg.from);
    if (!user.clanId) return bot.sendMessage(msg.chat.id, "❌ Вы должны состоять в клане.");
    if (clanBattleActive) return bot.sendMessage(msg.chat.id, "⚔️ Бой уже идёт.");
    if (clanBattleLobby.length === 0) {
        clanBattleLobby.push(user.id);
        bot.sendMessage(msg.chat.id, `🏰 Лобби боя открыто!\n${user.username} (${data.clans[user.clanId]?.name || "Без клана"}) присоединился.\nИспользуйте /acceptbattle для вступления.`);
    } else {
        bot.sendMessage(msg.chat.id, "⏳ Лобби уже открыто, присоединяйтесь командой /acceptbattle.");
    }
});

bot.onText(/\/acceptbattle/, (msg) => {
    const user = ensurePlayer(msg.from);
    if (!user.clanId) return bot.sendMessage(msg.chat.id, "❌ Вы должны состоять в клане.");
    if (clanBattleActive) return bot.sendMessage(msg.chat.id, "⚔️ Бой уже идёт.");
    if (clanBattleLobby.includes(user.id)) return bot.sendMessage(msg.chat.id, "Вы уже в лобби.");
    clanBattleLobby.push(user.id);
    bot.sendMessage(msg.chat.id, `➕ ${user.username} (${data.clans[user.clanId]?.name || "Без клана"}) присоединился к лобби.`);

    const clansInLobby = {};
    clanBattleLobby.forEach(pid => {
        const pl = players[pid];
        if (pl && pl.clanId) {
            clansInLobby[pl.clanId] = (clansInLobby[pl.clanId] || 0) + 1;
        }
    });

    const eligibleClans = Object.keys(clansInLobby).filter(cid => clansInLobby[cid] >= 2);
    if (eligibleClans.length >= 2 && !clanBattleTimer) {
        bot.sendMessage(msg.chat.id, "⏳ До начала боя осталось 20 секунд!");
        clanBattleTimer = setTimeout(() => startClanBattle(eligibleClans), 20000);
    }
});
}

  if (process.env.NODE_ENV !== 'test') {
    startBot().catch(console.error);
  }


// === Anti-idle пинг ===
// Используем встроенный fetch в Node.js 18+
async function pingKeepAlive(url, timeoutMs = 15000) {
  if (!url) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    if (!response.ok && (response.status === 405 || response.status === 501)) {
      response = await fetch(url, { method: 'GET', signal: controller.signal });
    }
    if (response.ok) {
      console.log(`Пинг OK: ${url}`);
    } else {
      console.warn(`Пинг не удался (${url}): статус ${response.status}`);
    }
  } catch (err) {
    const cause = err?.cause;
    if (cause && cause.code === 'UND_ERR_HEADERS_TIMEOUT') {
      console.warn(`Пинг не удался (${url}): таймаут ожидания заголовков`);
    } else if (err?.name === 'AbortError') {
      console.warn(`Пинг не удался (${url}): истек таймаут ожидания ответа`);
    } else {
      console.warn(`Пинг не удался (${url}):`, err?.message || err);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function pingKeepAliveTargets(urls, timeoutMs) {
  for (const target of urls) {
    await pingKeepAlive(target, timeoutMs);
  }
}

function buildKeepAliveTargets(port) {
  const targets = new Set(KEEPALIVE_BASE_TARGETS);
  if (port) {
    targets.add(`http://127.0.0.1:${port}/`);
    targets.add(`http://localhost:${port}/`);
  }
  return Array.from(targets);
}

let keepAliveTimer = null;

function startKeepAliveScheduler(targets) {
  if (!targets || targets.length === 0) {
    console.info('Keep-alive ping disabled: no targets configured.');
    return;
  }

  const uniqueTargets = Array.from(new Set(targets));
  const logTargets = uniqueTargets.join(', ');
  console.info(`Keep-alive ping enabled. Targets: ${logTargets}`);

  const runPingCycle = () => {
    pingKeepAliveTargets(uniqueTargets).catch((err) => {
      console.warn('Пинг keep-alive завершился с ошибкой:', err?.message || err);
    });
  };

  runPingCycle();
  keepAliveTimer = setInterval(runPingCycle, KEEPALIVE_INTERVAL_MS);
  if (typeof keepAliveTimer.unref === 'function') {
    keepAliveTimer.unref();
  }
}


// === Мини HTTP-сервер для Render ===
// === PostgreSQL (Render) ===

// DATABASE_URL должен быть задан в переменных окружения Render




if (process.env.NODE_ENV !== 'test') {
  const PORT = Number.parseInt(process.env.PORT, 10) || 3001;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
  });

  server.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
    const targets = buildKeepAliveTargets(PORT);
    startKeepAliveScheduler(targets);
  });
}



process.on('SIGTERM', () => { saveData().finally(() => process.exit(0)); });
process.on('SIGINT', () => { saveData().finally(() => process.exit(0)); });

export {
  mainMenuKeyboard,
  lootMenuKeyboard,
  leaderboardMenuKeyboard,
  clansMenuKeyboard,
  saveData,
  loadData,
  ensurePlayer,
  players,
  clans,
  clanBattles,
  clanInvites
};
