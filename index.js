import dotenv from 'dotenv';
dotenv.config();

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import fetch from 'node-fetch';
import http from 'http';


import pool from './lib/db.js';

// --- Очистка таблицы bot_state (MySQL) ---
export async function clearBotStateTable() {
  await pool.execute('DELETE FROM bot_state');
  console.log('Таблица bot_state очищена.');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = process.env.TELEGRAM_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN;



function normalizeName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]/gi, '');
}

function loadItemImages() {
  const filePath = path.join(__dirname, 'броня.txt');
  const map = {};
  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const [name, url] = line.split(/\s*: \s*/);
      if (name && url) {
        map[normalizeName(name)] = url.trim();
      }
    }
  }
  return map;
}

async function generateInventoryImage(player) {
  try {
    const baseUrl = (player && player.baseUrl) || 'https://i.postimg.cc/RZbFRZzj/2.png';
    const itemImages = loadItemImages();
    const layers = [];

    const resBase = await fetch(baseUrl);
    if (!resBase.ok) throw new Error(`Ошибка загрузки фона`);
    const baseBuf = await resBase.arrayBuffer();

    const order = ["mutation", "armor", "weapon", "helmet", "extra"];
    for (const key of order) {
      const item = player && player.inventory ? player.inventory[key] : null;
      if (!item || !item.name) continue;
      const url = itemImages[normalizeName(item.name)];
      if (!url) {
        console.warn(`Нет картинки для ${item ? item.name : key}`);
        continue;
      }
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Ошибка загрузки ${url}`);
        const buf = await res.arrayBuffer();
        layers.push({ input: Buffer.from(buf) });
      } catch (e) {
        console.warn(`Слой ${item.name} пропущен: ${e.message}`);
        continue;
      }
    }

    const out = await sharp(Buffer.from(baseBuf)).composite(layers).png().toBuffer();
    return out;
  } catch (err) {
    console.error('Ошибка генерации инвентаря:', err);
    return null;
  }
}


let bot; // глобальная переменная для TelegramBot

// --- saveData определена выше process.on ---
async function saveData() {
  if (global.saving) {
    global.saveAgain = true;
    return;
  }
  global.saving = true;
  try {
    global.data.players = global.players;
    global.data.clans = global.clans;
    global.data.clanBattles = global.clanBattles;
    global.data.clanInvites = global.clanInvites;
    await pool.execute(
      `INSERT INTO bot_state (id, state, updated_at)
       VALUES (1, ?, NOW())
       ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = NOW()`,
      [JSON.stringify(global.data)]
    );
  } catch (e) {
    console.error("Ошибка записи в MySQL:", e);
  }
  global.saving = false;
  if (global.saveAgain) {
    global.saveAgain = false;
    saveData();
  }
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

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🩸 Выйти на охоту", callback_data: "hunt" }],
      [{ text: "🪦 Лутать тело 📦", callback_data: "loot_menu" }],
      [{ text: "🎒 Инвентарь", callback_data: "inventory" }],
      [{ text: "🏆 Таблица лидеров", callback_data: "leaderboard" }],
      [{ text: "⚔️ PvP", callback_data: "pvp_request" }],
      [{ text: "🏰 Кланы", callback_data: "clans_menu" }]
    ]
  };
}

function lootMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🆓 Бесплатный подарок", callback_data: "free_gift" }],
      [{ text: "➕ Бесплатный подарок", callback_data: "invite_friend" }],
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



// data file path (works with "type": "module")
const DATA_FILE = path.join(__dirname, "data.json");

let data = { players: {}, clans: {}, clanBattles: [] }; // canonical structure
let players = data.players;
let clans = data.clans;
let clanInvites = data.clanInvites || {};
let clanBattles = data.clanBattles;

// Prevent concurrent writes under heavy load
let saving = false;
let saveAgain = false;

  // await initPostgres();
  await loadData();
  console.log("Бот запущен ✅");

  bot = new TelegramBot(TOKEN, { polling: true });

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

function escMd(str) {
  return String(str || '').replace(/[\\_\\*\\[\\]\\(\\)~`>#+=|{}.!-]/g, '\\\\$&');
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
      clanId: null,
      inventory: { armor: null, helmet: null, weapon: null, mutation: null, extra: null },
      monster: null,
      monsterStun: 0,
      damageBoostTurns: 0,
      damageReductionTurns: 0,
      radiationBoost: false,
      firstAttack: true,
      lastHunt: 0,
      pendingDrop: null,
      pvpWins: 0,
      pvpLosses: 0,
      lastGiftTime: 0,
      huntCooldownWarned: false
    };
    players[key] = p;
    saveData();
  } else {
    const newUsername = user.username || `id${user.id}`;
    if (p.username !== newUsername) p.username = newUsername;
    const newName = user.first_name || newUsername;
    if (p.name !== newName) p.name = newName;
  }
  return p;
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
    p.id ??= Number(key);
    p.username ??= `id${key}`;
    p.name ??= p.username;
    p.hp ??= 100;
    p.maxHp ??= p.hp;
    p.infection ??= 0;
    p.clanId ??= null;
    p.monster ??= null;
    p.monsterStun ??= 0;
    p.damageBoostTurns ??= 0;
    p.damageReductionTurns ??= 0;
    p.radiationBoost ??= false;
    p.firstAttack ??= false;
    p.lastHunt ??= 0;
    p.pendingDrop ??= null;
    p.pvpWins ??= 0;
    p.pvpLosses ??= 0;
    p.lastGiftTime ??= 0;
    p.huntCooldownWarned ??= false;
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

// --- Config constants ---
const PVP_REQUEST_TTL = 60 * 1000;
const PVP_POINT = 300;
const CLAN_BATTLE_POINT = 500;
const CLAN_BATTLE_MIN_PER_CLAN = 2;
const CLAN_BATTLE_COUNTDOWN_MS = 20000; // 20 seconds

// --- Items (same as before) ---
const armorItems = [
  { name: "Бронежилет химзащита", hp: 20, chance: 25 },
  { name: "Бронежилет из жертв", hp: 40, chance: 20 },
  { name: "Бронежилет любительский", hp: 50, chance: 18 },
  { name: "Бронежилет базовый", hp: 100, chance: 15 },
  { name: "Бронежилет полиции", hp: 250, chance: 10 },
  { name: "Бронежилет военных", hp: 350, chance: 6 },
  { name: "Бронежилет CRIMECORE", hp: 500, chance: 4 },
  { name: "Бронежилет мутации", hp: 550, chance: 2 },
  { name: "Бронежилет хим. вещества", hp: 600, chance: 1.5 },
  { name: "Бронежилет протез", hp: 800, chance: 1 }
];

const weaponItems = [
  { name: "Бита", dmg: 10, chance: 15 },
  { name: "Перочинный нож", dmg: 15, chance: 13 },
  { name: "Кухонный нож", dmg: 15, chance: 13 },
  { name: "Охотничий нож", dmg: 20, chance: 12 },
  { name: "Топор", dmg: 30, chance: 10 },
  { name: "Мачете", dmg: 30, chance: 10 },
  { name: "Бензопила", dmg: 40, chance: 6 },
  { name: "Glock-17", dmg: 70, chance: 5 },
  { name: "Tec-9", dmg: 75, chance: 4 },
  { name: "MP-7", dmg: 100, chance: 3 },
  { name: "Uzi", dmg: 100, chance: 3 },
  { name: "Охотничье ружьё", dmg: 170, chance: 2 },
  { name: "Дробовик", dmg: 180, chance: 1.5 },
  { name: "Двустволка", dmg: 190, chance: 1.2 },
  { name: "Famas", dmg: 210, chance: 1 },
  { name: "Ak-47", dmg: 250, chance: 0.8 },
  { name: "SCAR-L", dmg: 260, chance: 0.7 },
  { name: "ВСК-94", dmg: 300, chance: 0.5 },
  { name: "AWP", dmg: 350, chance: 0.3 }
];

const helmetItems = [
  { name: "Пакет", block: 2, chance: 20 },
  { name: "Кепка", block: 3, chance: 18 },
  { name: "Балаклава", block: 3, chance: 18 },
  { name: "Кожаный шлем", block: 5, chance: 15 },
  { name: "Велосипедный шлем", block: 5, chance: 15 },
  { name: "Строительный шлем", block: 10, chance: 10 },
  { name: "Противогаз", block: 20, chance: 6 },
  { name: "Боевой шлем", block: 20, chance: 5 },
  { name: "Военный шлем", block: 30, chance: 3 },
  { name: "Шлем CRIMECORE", block: 40, chance: 2 }
];

const mutationItems = [
  { name: "Кровоточащий", crit: 0.15, chance: 20 },
  { name: "Порезанный", crit: 0.15, chance: 20 },
  { name: "Аниме", crit: 0.20, chance: 15 },
  { name: "Момо", crit: 0.20, chance: 15 },
  { name: "Безликий", crit: 0.25, chance: 12 },
  { name: "Зубастик", crit: 0.30, chance: 10 },
  { name: "Клешни", crit: 0.30, chance: 6 },
  { name: "Бог", crit: 0.50, chance: 2 }
];

const extraItems = [
  { name: "Фотоаппарат со вспышкой", effect: "stun2", chance: 20, turns: 2 },
  { name: "Слеповая граната", effect: "stun2", chance: 20, turns: 2 },
  { name: "Петарда", effect: "damage50", chance: 20 },
  { name: "Граната", effect: "damage100", chance: 15 },
  { name: "Адреналин", effect: "halfDamage1", chance: 12, turns: 1 },
  { name: "Газовый балон", effect: "doubleDamage1", chance: 6, turns: 1 },
  ];

// ------------------ Loot / Payments config ------------------
const PROVIDER_TOKEN = "444717:AAP7lzPEP4Kw558oCJzmV3yb6S5wqMBfGbi"; // <- твой CryptoPay token (или "" если хочешь)
const FREE_GIFT_CHANNEL = "@SL4VE666"; // канал для бесплатного дропа

// список легендарных предметов (имена — из твоего файла). 
// Мы потом найдём объекты в существующих массивах по имени (поиск нечувствителен к регистру).
const LEGENDARY_NAMES = [
  "Бронежилет военных",
  "Бронежилет CRIMECORE",
  "Бронежилет мутации",
  "Бронежилет хим. вещества",
  "Бронежилет протез",
  "Зубастик",
  "Клешни",
  "Бог",
  "Uzi",
  "Охотничье ружьё",
  "Дробовик",
  "Двустволка",
  "Famas",
  "Ak-47",
  "SCAR-L",
  "ВСК-94",
  "AWP",
  "Военный шлем",
  "Шлем CRIMECORE"
];


const storyEvents = [
  // ... (копируем точно как в старом коде)
  {
    title: "Сирена в темноте",
    text: "Ты слышишь тихий женский голос, зовущий на помощь из подземного перехода.",
    good: "Ты спас девушку — она благодарит тебя и передаёт небольшой подарок.",
    bad: "Это оказалась бракованная аниме-девочка — она напала на тебя, но ты успел сбежать.",
    badEffect: { type: "lose_points", amount: 50 }
  },
  {
    title: "Визитка с розой",
    text: "На тротуаре лежит визитка с золотой розой и адресом.",
    good: "Адрес привёл к тайнику с ценным оружием.",
    bad: "Адрес оказался ловушкой вербовщиков — пришлось срочно убегать.",
    badEffect: { type: "lose_item", slot: "weapon" }
  },
  {
    title: "Запах духов",
    text: "В переулке пахнет сладкими духами, но никого не видно.",
    good: "Девушка пряталась от охотников и подарила тебе редкую вещь.",
    bad: "Монстр, маскирующийся под девушку, внезапно напал — но ты убежал.",
    badEffect: { type: "lose_item", slot: "armor" }
  },
  {
    title: "Серебряный фургон",
    text: "Мимо проезжает фургон с затемнёнными окнами, слышны женские крики.",
    good: "Ты успел заблокировать путь и спасти девушку.",
    bad: "Это была охрана лаборатории — ты едва ушёл живым.",
    badEffect: { type: "lose_points", amount: 100 }
  },
  {
    title: "Стеклянная капсула",
    text: "У стены стоит треснувшая капсула, внутри — полусознанная девушка.",
    good: "Ты помог ей выбраться, она вручила необычный предмет.",
    bad: "Внутри был мутант, но ты успел скрыться.",
    badEffect: { type: "lose_item", slot: "helmet" }
  },
  {
    title: "Старый дневник",
    text: "На лавочке лежит дневник с записями о похищениях.",
    good: "Записи вывели тебя к тайнику с ценным предметом.",
    bad: "Это была приманка — охотники чуть не поймали тебя.",
    badEffect: { type: "lose_points", amount: 30 }
  },
  {
    title: "Шёпот за спиной",
    text: "Кто-то тихо шепчет твоё имя.",
    good: "Это была выжившая девушка, которая поделилась с тобой находкой.",
    bad: "Это были галлюцинации от газа — ты едва выбрался.",
    badEffect: { type: "lose_item", slot: "mutation" }
  },
  {
    title: "Разбитое зеркало",
    text: "В подвале — комната с разбитыми зеркалами и запахом крови.",
    good: "Ты нашёл в щели шлем.",
    bad: "На тебя напала отражённая тень, но ты сбежал.",
    badEffect: { type: "lose_points", amount: 20 }
  },
  {
    title: "Красная метка",
    text: "Кто-то мелом нарисовал красную метку на стене.",
    good: "Это знак выживших — внутри тайник с гранатами.",
    bad: "Метка привлекла охотников, пришлось уходить.",
    badEffect: { type: "lose_item", slot: "extra" }
  },
  {
    title: "Вечеринка с отборами",
    text: "В клубе проходит вечеринка с 'кастингом' девушек.",
    good: "Ты сорвал отбор и спас одну из них.",
    bad: "Тебя узнали и выгнали.",
    badEffect: { type: "lose_points", amount: 10 }
  },
// Универсальная обработка badEffect для storyEvents
];

function applyBadEffect(player, badEffect) {
  if (!player || !badEffect) return;
  if (badEffect.type === "lose_points") {
    player.infection = Math.max(0, (player.infection || 0) - (badEffect.amount || 0));
  } else if (badEffect.type === "lose_item" && badEffect.slot) {
    if (player.inventory && player.inventory[badEffect.slot]) {
      player.inventory[badEffect.slot] = null;
    }
  }
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

async function editOrSend(chatId, messageId, text, options = {}) {
  try {
    if (messageId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: options.reply_markup, parse_mode: "Markdown" });
      return;
    } else {
      await bot.sendMessage(chatId, text, { reply_markup: options.reply_markup, parse_mode: "Markdown" });
      return;
    }
  } catch (e) {
    // fallback send
    await bot.sendMessage(chatId, text, { reply_markup: options.reply_markup, parse_mode: "Markdown" });
    return;
  }
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🩸 Выйти на охоту", callback_data: "hunt" }],
      [{ text: "🪦 Лутать тело 📦", callback_data: "loot_menu" }],
      [{ text: "🎒 Инвентарь", callback_data: "inventory" }],
      [{ text: "🏆 Таблица лидеров", callback_data: "leaderboard" }],
      [{ text: "⚔️ PvP", callback_data: "pvp_request" }],
      [{ text: "🏰 Кланы", callback_data: "clans_menu" }],
      [{ text: "📢 Канал", url: "https://t.me/crimecorebotgame" }]
    ]
  };
}

function lootMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🆓 Бесплатный подарок", callback_data: "free_gift" }],
      [{ text: "➕ Пригласить друга", callback_data: "invite_friend" }],
                  [{ text: "⬅️ Назад", callback_data: "play" }]
    ]
  };
}

function findItemByName(name) {
  if (!name) return null;
  const allPools = [
    ...weaponItems.map(i => ({ ...i, kind: "weapon" })),
    ...armorItems.map(i => ({ ...i, kind: "armor" })),
    ...helmetItems.map(i => ({ ...i, kind: "helmet" })),
    ...mutationItems.map(i => ({ ...i, kind: "mutation" })),
    ...extraItems.map(i => ({ ...i, kind: "extra" }))
  ];
  const lower = String(name).toLowerCase();
  return allPools.find(it => String(it.name).toLowerCase() === lower) || null;
}

async function giveItemToPlayer(chatId, player, item, sourceText = "") {
  if (!player || !item) return;
  player.pendingDrop = { ...item };
  saveData();
  const text = `${sourceText}\n\n🎉 *Поздравляем!* Вы получили: *${escMd(item.name)}*.\nЧто делаем?`;
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "✅ Взять", callback_data: "take_drop" }],[{ text: "🗑️ Выбросить", callback_data: "discard_drop" }],[{ text: "⬅️ В меню", callback_data: "play" }]] }
  });
}

// ---- Data load/save and migration ----

async function saveData() {
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  try {
    data.players = players;
    data.clans = clans;
    data.clanBattles = clanBattles;
    data.clanInvites = clanInvites;
    await pool.execute(
      `INSERT INTO bot_state (id, state, updated_at)
       VALUES (1, ?, NOW())
       ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = NOW()`,
      [JSON.stringify(data)]
    );
  } catch (e) {
    console.error("Ошибка записи в PostgreSQL:", e);
  }
  // ...
  saving = false;
  if (saveAgain) {
    saveAgain = false;
    saveData();
  }
}

async function loadData() {
  try {
  const [rows] = await pool.execute("SELECT state FROM bot_state WHERE id = 1");
    if (rows.length === 0) {
      // Если нет состояния — создаём пустое
      data = { players: {}, clans: {}, clanBattles: [], clanInvites: {} };
      players = data.players;
      clans = data.clans;
      clanBattles = data.clanBattles;
      clanInvites = data.clanInvites;
      await pool.execute(
        "INSERT INTO bot_state (id, state, updated_at) VALUES (1, ?, NOW()) ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = NOW()",
        [JSON.stringify(data)]
      );
      console.log("MySQL: создано новое состояние по умолчанию.");
      return;
    }
  const parsed = rows[0] && (typeof rows[0].state === 'string' ? JSON.parse(rows[0].state) : rows[0].state) || {};
    players = parsed.players || {};
    clans = parsed.clans || {};
    clanBattles = parsed.clanBattles || [];
    clanInvites = parsed.clanInvites || {};

    // Сохраняем обратно ссылки в data
    data.players = players;
    data.clans = clans;
    data.clanBattles = clanBattles;
    data.clanInvites = clanInvites;

  console.log("MySQL: состояние загружено.");
  } catch (e) {
    console.error("Ошибка чтения из MySQL:", e);
  }
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

function initPvpState(challenger, opponent) {
  if (!challenger || !opponent) return false;
  applyArmorHelmetBonuses(challenger);
  applyArmorHelmetBonuses(opponent);

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
    turn: "me"
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
    turn: "opponent"
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

  const helmetBlock = defender.inventory && defender.inventory.helmet ? (defender.inventory.helmet.block || 0) : 0;
  if (helmetBlock > 0) {
    const blocked = Math.ceil(damage * helmetBlock / 100);
    damage -= blocked;
    events.push(`🪖 ${defender.username} шлем блокирует ${blocked} урона (${helmetBlock}%).`);
  }

  if (damage < 0) damage = 0;
  defenderPvpState.myHp -= damage;
  events.push(`⚔️ ${attacker.username} атакует из ${weaponName}: ${damage} урона.`);

  return events;
}

// ---- Clan battle queue/state ----
const clanBattleQueue = {}; // clanId -> array of playerId (strings)
let clanBattleCountdown = null;
let clanBattleCountdownMsg = null;
let pendingCountdownForClans = null; // [clanAId, clanBId]

// helper: ensure clan exists
function ensureClan(name) {
  const ids = Object.keys(clans).map(n => Number(n));
  const nextId = ids.length === 0 ? 1 : (Math.max(...ids) + 1);
  const id = nextId;
  clans[String(id)] = { id, name, points: 0, members: [] };
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
  let stateA = { myHp: fighterA.maxHp, myStun: 0, myDamageBoostTurns: 0, myDamageReductionTurns: 0, myRadiationBoost: false };
  let stateB = { myHp: fighterB.maxHp, myStun: 0, myDamageBoostTurns: 0, myDamageReductionTurns: 0, myRadiationBoost: false };
  let turn = 'A';
    function advanceNextA() {
      idxA++;
      if (idxA >= fightersA.length) return false;
      fighterA = fightersA[idxA];
      applyArmorHelmetBonuses(fighterA);
      stateA = {
        myHp: fighterA.maxHp,
        myStun: 0,
        myDamageBoostTurns: 0,
        myDamageReductionTurns: 0,
        myRadiationBoost: false
      };
      return true;
    }
    function advanceNextB() {
      idxB++;
      if (idxB >= fightersB.length) return false;
      fighterB = fightersB[idxB];
      applyArmorHelmetBonuses(fighterB);
      stateB = {
        myHp: fighterB.maxHp,
        myStun: 0,
        myDamageBoostTurns: 0,
        myDamageReductionTurns: 0,
        myRadiationBoost: false
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
          setTimeout(processRound, 1500);
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
  const clan = ensureClan(name);
  clan.members.push(player.id);
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
    }
  }
  player.clanId = null;
  // also remove from battle queue
  removeClanQueueEntry(cid, player.id);
  saveData();
  bot.sendMessage(chatId, "Вы вышли из клана.");
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

// ---- Callback handlers (PvE, inventory, leaderboard and pvp_request button, clans menu) ----

  const __af = Object.create(null);
bot.on("callback_query", async (q) => {
  const dataCb = q.data;
  const user = q.from;
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;

  await bot.answerCallbackQuery(q.id).catch(()=>{});

  // === Ограничение кнопок в любых группах (group/supergroup): разрешены только PvP и Кланы ===
  try {
    const chat = q.message && q.message.chat ? q.message.chat : null;
    const chatType = chat && chat.type ? chat.type : null;
    const isGroupType = chatType === "group" || chatType === "supergroup";
    const allowedInGroup = new Set(["pvp_request", "clans_menu"]);
    if (isGroupType && !allowedInGroup.has(dataCb)) {
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
// --- Обработчики для кнопок главного меню: PvP и Кланы ---
if (dataCb === "pvp_request") {
  // Поведение как при /pvp_request
  const keyById = String(user.id);
  const reqObj = { challengerId: user.id, username: user.username || null, chatId, ts: Date.now() };
  pvpRequests[keyById] = reqObj;
  if (user.username) {
    pvpRequests[`@${user.username}`] = reqObj;
    pvpRequests[user.username] = reqObj;
  }
  // Обновляем сообщение или отправляем новое
  await editOrSend(chatId, messageId, `🏹 @${user.username || `id${user.id}`} ищет соперника! Чтобы принять — /pvp @${user.username || user.id}\nЗаявка действует ${Math.floor(PVP_REQUEST_TTL/1000)} секунд.`);
  return;
}

if (dataCb === "clans_menu") {
  // Показываем краткое меню по кланам (аналог текста + подсказки по /clan_* командам)
  const text = `🏰 Кланы — команды:
- /clan_create <имя> — создать клан
- /clan_leave — выйти из клана
- /inviteclan @ник|id — пригласить в клан
- /acceptclan — принять приглашение
- /clan_top — топ кланов
- /acceptbattle — принять заявку на клановую битву
- /clan_battle — подать заявку на клановую битву
Нажмите команду в чате или используйте текстовые команды.`;
  await editOrSend(chatId, messageId, text, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] } });
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
    const sent = await bot.sendMessage(chatId, "🏠 Главное меню", { reply_markup: mainMenuKeyboard() });
    player.lastMainMenuMsgId = sent.message_id;
    saveData();
    return;
}

// player уже инициализирован выше


if (dataCb === "loot_menu") {
    await editOrSend(chatId, messageId, "📦 Меню лута — выбери:", { reply_markup: lootMenuKeyboard() });
    return;
}

if (dataCb === "free_gift") {
    const now = Date.now();
    const lastGiftTime = player.lastGiftTime || 0;
    const COOLDOWN = 24 * 60 * 60 * 1000; // 24 часа

    // Проверяем подписку каждый раз при нажатии
    try {
        const member = await bot.getChatMember(FREE_GIFT_CHANNEL, user.id);
        const status = (member && member.status) ? member.status : "left";
        if (status === "left" || status === "kicked") {
            await editOrSend(chatId, messageId,
                `❌ Вы не подписаны на канал ${FREE_GIFT_CHANNEL}. Подпишитесь и нажмите «Проверить подписку» снова.`,
                { reply_markup: {
                    inline_keyboard: [
                        [{ text: "📢 Открыть канал", url: `https://t.me/${String(FREE_GIFT_CHANNEL).replace(/^@/, "")}` }],
                        [{ text: "✅ Проверить подписку", callback_data: "free_gift" }],
                        [{ text: "⬅️ Назад", callback_data: "loot_menu" }]
                    ]
                }});
            return;
        }
    } catch (err) {
        console.error("Ошибка проверки подписки:", err);
        await editOrSend(chatId, messageId,
            `❌ Не удалось проверить подписку. Убедитесь, что канал ${FREE_GIFT_CHANNEL} существует и публичный.`,
            { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "loot_menu" }]] } });
        return;
    }

    // Проверка кулдауна (24 часа)
    if (now - lastGiftTime < COOLDOWN) {
        const timeLeft = COOLDOWN - (now - lastGiftTime);
        const hours = Math.floor(timeLeft / (1000 * 60 * 60));
        const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        await editOrSend(chatId, messageId,
            `⌛ Вы уже забирали бесплатный подарок. Следующий можно получить через ${hours} ч ${minutes} мин.`,
            { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "loot_menu" }]] } });
        return;
    }

    // -------------------------
    // Собираем пул предметов (всё из твоих массивов)
    // -------------------------
    const dropPool = [
        ...weaponItems.map(it => ({ ...it, kind: "weapon" })),
        ...helmetItems.map(it => ({ ...it, kind: "helmet" })),
        ...mutationItems.map(it => ({ ...it, kind: "mutation" })),
        ...extraItems.map(it => ({ ...it, kind: "extra" })),
        ...armorItems.map(it => ({ ...it, kind: "armor" }))
    ];

    // Гарантированное выпадение — используем pickByChance, если тот вернёт null — ставим случайный
    let picked = pickByChance(dropPool);
    if (!picked && dropPool.length > 0) picked = dropPool[Math.floor(Math.random() * dropPool.length)];

    if (!picked) {
        await editOrSend(chatId, messageId, "⚠️ Не удалось сгенерировать предмет. Попробуйте позже.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "loot_menu" }]] } });
        return;
    }

    // Сохраняем время получения и отдаем предмет (используем существующую функцию giveItemToPlayer)
    player.lastGiftTime = now;
    // (не ставим gotFreeLoot — теперь подарок раз в 24 часа)
    giveItemToPlayer(chatId, player, picked, "🎁 Бесплатный подарок за подписку (раз в 24 часа)");
    saveData();

    return;
}

if (dataCb === "basic_box") {
    const title = "Базовая коробка удачи (100⭐)";
    const description = "Одна коробка — один гарантированный предмет. Шансы аналогичны PvE.";
    const payload = "loot_basic_100";
    const startParam = "loot_basic";
    const prices = [{ label: "Базовая коробка", amount: 10000 }]; // 100⭐ × 100
    try {
        await bot.sendInvoice(chatId, title, description, payload, "", startParam, "XTR", prices, {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "loot_menu" }]] }
        });
    } catch (err) {
        console.error("sendInvoice error:", err);
        await bot.sendMessage(chatId, "Не удалось создать счёт. Попробуйте позже или сообщите администратору бота.", {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "loot_menu" }]] }
        });
    }
    return;
}

if (dataCb === "legend_box") {
    const title = "Легендарная коробка удачи (599⭐)";
    const description = "Легендарная коробка — выпадение только из спец. списка сильных предметов (равные шансы).";
    const payload = "loot_legend_599";
    const startParam = "loot_legend";
    const prices = [{ label: "Легендарная коробка", amount: 59900 }];
    try {
        await bot.sendInvoice(chatId, title, description, payload, "", startParam, "XTR", prices, {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "loot_menu" }]] }
        });
    } catch (err) {
        console.error("sendInvoice error:", err);
        await bot.sendMessage(chatId, "Не удалось создать счёт. Попробуйте позже или сообщите администратору бота.", {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "loot_menu" }]] }
        });
    }
    return;
} // ← закрыли legend_box

if (dataCb === "hunt") {
  const now = Date.now();
  let huntCooldown = 15000;
  if (player && (player.id === 7897895019 || player.id === 7026777373)) {
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
    player.monster = spawnMonster();
    player.firstAttack = false;
    player.monsterStun = 0;
    player.pendingDrop = null;
    applyArmorHelmetBonuses(player);
    saveData();

    const monsterImages = {
        weak:  "https://i.postimg.cc/XqWfytS2/IMG-6677.jpg",
        medium: "https://i.postimg.cc/VNyd6ncg/IMG-6678.jpg",
        fat:   "https://i.postimg.cc/nz2z0W9S/IMG-6679.jpg",
        quest: "https://i.postimg.cc/J4Gn5PrK/IMG-6680.jpg"
    };

  if (Math.random() < 0.2) {
    const ev = storyEvents[Math.floor(Math.random() * storyEvents.length)];
    player.currentEvent = ev;
    saveData();
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

    const img = monsterImages[player.monster.type] || monsterImages.weak;
    const sent = await bot.sendPhoto(chatId, img, {
        caption: `🩸 Ты встретил Подопытного №${player.monster.id}\nHP: ${player.monster.hp}/${player.monster.maxHp}\nУрон: ${player.monster.dmg}`,
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

    if (player.monster.hp <= 0) {
        let infGain = (player.monster.type === "medium") ? 35 : (player.monster.type === "fat" ? 60 : 20);
        if (player.radiationBoost) { infGain *= 2; player.radiationBoost = false; }
        player.infection += infGain;
        player.pendingDrop = null;
        const dropChance = (player.monster.type === "weak") ? 0.20 : (player.monster.type === "medium") ? 0.35 : 0.60;
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

        applyArmorHelmetBonuses(player);
        player.hp = player.maxHp;
        player.monster = null;
        player.monsterStun = 0;

        if (player.currentBattleMsgId) {
            await bot.deleteMessage(chatId, player.currentBattleMsgId).catch(()=>{});
            delete player.currentBattleMsgId;
        }

        saveData();
        let winText = `💀 Ты убил Подопытного и получил +${infGain} заражения☣️!\nТекущий уровень заражения: ${player.infection}`;
        if (player.pendingDrop) {
            winText += `\n\n🎁 Выпало: ${player.pendingDrop.name}\nЧто делать?`;
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
        let incoming = player.monster.dmg;
        if (player.damageReductionTurns && player.damageReductionTurns > 0) { 
            incoming = Math.ceil(incoming / 2); 
            player.damageReductionTurns--; 
        }
        const blocked = Math.ceil(incoming * (helmetBlock / 100));
        incoming = Math.max(0, incoming - blocked);
        player.hp -= incoming;
        monsterText = `💥 Монстр ударил тебя на ${incoming} урона. (Шлем заблокировал ${blocked})`;

        if (player.hp <= 0) {
            const loss = Math.floor(Math.random() * 26) + 5;
            player.infection = Math.max(0, player.infection - loss);
            applyArmorHelmetBonuses(player);
            player.hp = player.maxHp;
            player.monster = null;
            player.monsterStun = 0;

            if (player.currentBattleMsgId) {
                await bot.deleteMessage(chatId, player.currentBattleMsgId).catch(()=>{});
                delete player.currentBattleMsgId;
            }

            saveData();
            await bot.sendMessage(chatId, `${events.join("\n")}\n\n☠️ Ты умер и потерял ${loss} уровня заражения☣️. Твой уровень: ${player.infection}`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] } });
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
        text += `\n\n🎁 Выпало: ${escMd(picked.name)}\nЧто делать?`;
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

  if (dataCb === "take_drop") {
    if (!player.pendingDrop) { await bot.answerCallbackQuery(q.id, { text: "Нечего брать.", show_alert: true }).catch(()=>{}); return; }
    const item = player.pendingDrop;
    let slot = "extra";
    if (item.kind === "weapon") slot = "weapon";
    else if (item.kind === "helmet") slot = "helmet";
    else if (item.kind === "armor") slot = "armor";
    else if (item.kind === "mutation") slot = "mutation";
    else if (item.kind === "extra") slot = "extra";

    const prev = player.inventory[slot];
    player.inventory[slot] = item;
    player.pendingDrop = null;
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
    const player = ensurePlayer(q.from);
    let clanName = player.clanId && clans[player.clanId] ? clans[player.clanId].name : "—";
    let inv = player.inventory || {};
    let text = `🎒 Инвентарь:
Клан: ${clanName}
🪖 Шлем: ${inv.helmet?.name || "—"} (${inv.helmet?.block !== undefined ? `блок ${inv.helmet.block}%` : "—"})
🛡 Броня: ${inv.armor?.name || "—"} (${inv.armor?.hp !== undefined ? `HP +${inv.armor.hp}` : "—"})
🔫 Оружие: ${inv.weapon?.name || "—"} (${inv.weapon?.dmg !== undefined ? `+${inv.weapon.dmg} урона` : "—"})
🧬 Мутация: ${inv.mutation?.name || "—"} (${inv.mutation?.crit !== undefined ? `crit ${inv.mutation.crit}%` : "—"})
📦 Доп: ${inv.extra?.name || "—"} (${inv.extra?.effect || "—"})

❤️ HP: ${player.hp}/${player.maxHp}
☣️ Заражение: ${player.infection || 0}
🏆 PvP: ${player.pvpWins || 0} побед / ${player.pvpLosses || 0} поражений`;

    const img = await generateInventoryImage(player);
    const kb = { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] };
    if (img) {
      await bot.sendPhoto(chatId, img, { caption: text, parse_mode: "Markdown", reply_markup: kb });
    } else {
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
    }

    return;
  }

  if (dataCb === "leaderboard") {
    const sorted = Object.values(players).sort((a,b) => (b.infection||0) - (a.infection||0));
    let text = "🏆 Таблица лидеров:\n\n";
    sorted.slice(0,10).forEach((p,i) =>
      text += `${i+1}. ${escMd(p.username)} — ${p.infection||0}☣️ (PvP: ${p.pvpWins||0}/${p.pvpLosses||0})\n`
    );
    const rank = sorted.findIndex(p => p.id === player.id) + 1;
    text += `\nТвой уровень: ${player.infection}\nТвоя позиция: ${rank>0 ? rank : "—"} / ${sorted.length}`;
    await editOrSend(chatId, messageId, text, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "play" }]] } });
    return;
  }
});

// /play
bot.onText(/\/play/, (msg) => {
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(msg.chat.id, "Ошибка регистрации. Попробуйте /start.");
  applyArmorHelmetBonuses(player);
  editOrSend(msg.chat.id, null, `Выберите действие:`, { reply_markup: mainMenuKeyboard() });
});

// /start
bot.onText(/\/start/, (msg) => {
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(msg.chat.id, "Ошибка регистрации. Попробуйте снова.");
  applyArmorHelmetBonuses(player);
  const inv = player.inventory;
  const armorLine = inv.armor ? `${inv.armor.name} (+${inv.armor.hp} HP)` : "—";
  const weaponLine = inv.weapon ? `${inv.weapon.name} (+${inv.weapon.dmg} dmg)` : "—";
  const helmetLine = inv.helmet ? `${inv.helmet.name} (блок ${inv.helmet.block}%)` : "—";
  const mutLine = inv.mutation ? `${inv.mutation.name} (crit ${Math.round((inv.mutation.crit||0)*100)}%)` : "—";
  bot.sendMessage(msg.chat.id,
    `Привет, @${player.username}!\n❤️ HP: ${player.hp}/${player.maxHp}\n🛡 Броня: ${armorLine}\n🔫 Оружие: ${weaponLine}\n🪖 Шлем: ${helmetLine}\n🧬 Мутация: ${mutLine}`,
    { reply_markup: mainMenuKeyboard() });
});

bot.on("pre_checkout_query", async (q) => {
  try {
    await bot.answerPreCheckoutQuery(q.id, true);
  } catch (e) {
    console.error("pre_checkout error:", e);
  }
});

bot.on("message", async (msg) => {
  try {
    if (!msg.successful_payment) return;
    const payload = msg.successful_payment.invoice_payload;
    const chatId = msg.chat.id;
    const user = msg.from;
    const player = ensurePlayer(user);
    if (!player) return;

    if (payload === "loot_basic_100") {
      const dropPool = [
        ...weaponItems.map(it => ({ ...it, kind: "weapon" })),
        ...helmetItems.map(it => ({ ...it, kind: "helmet" })),
        ...mutationItems.map(it => ({ ...it, kind: "mutation" })),
        ...extraItems.map(it => ({ ...it, kind: "extra" })),
        ...armorItems.map(it => ({ ...it, kind: "armor" }))
      ];
      const picked = pickByChance(dropPool);
      if (!picked) {
        await bot.sendMessage(chatId, "Произошла ошибка при генерации предмета. Свяжитесь с админом.");
        return;
      }
      await giveItemToPlayer(chatId, player, picked, "📦 Вы открыли Базовую коробку удачи!");
      saveData();
      return;
    }

    if (payload === "loot_legend_599") {
      const idx = Math.floor(Math.random() * LEGENDARY_NAMES.length);
      const name = LEGENDARY_NAMES[idx];
      const matched = findItemByName(name);
      const item = matched ? matched : { name: name, kind: "extra" };
      await giveItemToPlayer(chatId, player, item, "💎 Вы открыли Легендарную коробку удачи!");
      saveData();
      return;
    }

    console.log("Unknown invoice payload:", payload);
  } catch (e) {
    console.error("successful_payment handling error:", e);
  }
});

bot.on("pre_checkout_query", async (q) => {
  try {
    await bot.answerPreCheckoutQuery(q.id, true);
  } catch (e) {
    console.error("pre_checkout error:", e);
  }
});

bot.on("message", async (msg) => {
  try {
    if (!msg.successful_payment) return;
    const payload = msg.successful_payment.invoice_payload;
    const chatId = msg.chat.id;
    const user = msg.from;
    const player = ensurePlayer(user);
    if (!player) return;

    if (payload === "loot_basic_100") {
      const dropPool = [
        ...weaponItems.map(it => ({ ...it, kind: "weapon" })),
        ...helmetItems.map(it => ({ ...it, kind: "helmet" })),
        ...mutationItems.map(it => ({ ...it, kind: "mutation" })),
        ...extraItems.map(it => ({ ...it, kind: "extra" })),
        ...armorItems.map(it => ({ ...it, kind: "armor" }))
      ];
      const picked = pickByChance(dropPool);
      if (!picked) {
        await bot.sendMessage(chatId, "Произошла ошибка при генерации предмета. Свяжитесь с админом.");
        return;
      }
      await giveItemToPlayer(chatId, player, picked, "📦 Вы открыли Базовую коробку удачи!");
      saveData();
      return;
    }

    if (payload === "loot_legend_599") {
      const idx = Math.floor(Math.random() * LEGENDARY_NAMES.length);
      const name = LEGENDARY_NAMES[idx];
      const matched = findItemByName(name);
      const item = matched ? matched : { name: name, kind: "extra" };
      await giveItemToPlayer(chatId, player, item, "💎 Вы открыли Легендарную коробку удачи!");
      saveData();
      return;
    }

    console.log("Unknown invoice payload:", payload);
  } catch (e) {
    console.error("successful_payment handling error:", e);
  }
});

  // Auto-save every 30s
  setInterval(saveData, 30000);



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
  const clan = ensureClan(name);
  clan.members.push(player.id);
  player.clanId = clan.id;
  saveData();
  bot.sendMessage(chatId, `✅ Клан "${escMd(clan.name)}" создан. Вы вошли в клан.`);
});

bot.onText(/\/clantop/, (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: не найден профиль. Введите /play.");
  const sorted = Object.values(clans).sort((a,b) => (b.points || 0) - (a.points || 0));
  if (sorted.length === 0) return bot.sendMessage(chatId, "Пока нет зарегистрированных кланов.");
  let text = `🏰 Топ кланов:\n\n`;
  sorted.slice(0,10).forEach((c,i) => {
    text += `${i+1}. ${escMd(c.name)} — ${c.points} очков (${(c.members||[]).length} участников)\n`;
  });
  const rankIndex = sorted.findIndex(c => c.id === player.clanId);
  text += `\nТвой клан: ${player.clanId ? (clans[String(player.clanId)] ? clans[String(player.clanId)].name : "—") : "—"}\n`;
  text += `Твоё место: ${rankIndex >= 0 ? rankIndex + 1 : "—"} из ${sorted.length}`;
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
    if (clan.members.length === 0) delete clans[cid];
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

// Start a 1v1 PvP fight (automatic)
function startPvpFight(challenger, opponent, chatId) {
  if (!challenger || !opponent) {
    if (chatId) bot.sendMessage(chatId, "Ошибка: участники не найдены.");
    return;
  }
  // ensure pvp state initialized
  if (!initPvpState(challenger, opponent)) {
    bot.sendMessage(chatId, "Не удалось инициализировать PvP.");
    return;
  }

  bot.sendMessage(chatId, `⚔️ PvP: @${challenger.username} против @${opponent.username}. Бой начинается!`);

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
        // b wins
        b.pvpWins = (b.pvpWins || 0) + 1;
        a.pvpLosses = (a.pvpLosses || 0) + 1;
        await bot.sendMessage(chatId, `🏆 @${b.username} победил в PvP!`);
        delete challenger.pvp;
        delete opponent.pvp;
        saveData();
        return;
      }
      if (bState.myHp <= 0) {
        a.pvpWins = (a.pvpWins || 0) + 1;
        b.pvpLosses = (b.pvpLosses || 0) + 1;
        await bot.sendMessage(chatId, `🏆 @${a.username} победил в PvP!`);
        delete challenger.pvp;
        delete opponent.pvp;
        saveData();
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
        await bot.sendMessage(chatId, `🏆 Победитель: @${a.username} (+${PVP_POINT} очков)`);
        // optional: award points/infection — here we just update wins/losses
        delete challenger.pvp;
        delete opponent.pvp;
        saveData();
        return;
      }

      // switch turn
      turn = (turn === 'A') ? 'B' : 'A';
      saveData();
      setTimeout(processRound, 1500);
    } catch (e) {
      console.error("startPvpFight error:", e);
      try { bot.sendMessage(chatId, "Ошибка в PvP: " + String(e)); } catch {}
      if (challenger.pvp) delete challenger.pvp;
      if (opponent.pvp) delete opponent.pvp;
      saveData();
    }
  }

  // first tick
  setTimeout(processRound, 800);
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
    await bot.sendMessage(chatId, `🏹 @${player.username || `id${player.id}`} ищет соперника!\nЧтобы принять вызов, напишите: /pvp @${player.username || player.id}\nЗаявка действует ${Math.floor(PVP_REQUEST_TTL/1000)} секунд.`);
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
    if (challenger.pvp || player.pvp) return bot.sendMessage(chatId, "Один из игроков уже в PvP.");
    // clear request keys
    clearPvpRequestForPlayer(challenger);
    // start fight
    startPvpFight(challenger, player, chatId);
    return;
  }
});

// /pvp_request (text alias)
bot.onText(/\/pvp_request/, (msg) => {
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
  bot.sendMessage(chatId, `🏹 @${player.username || `id${player.id}`} ищет соперника! Чтобы принять — /pvp @${player.username || player.id}`);
});

// /inventory (text command)
bot.onText(/\/inventory/, async (msg) => {
  const chatId = msg.chat.id;
  const player = ensurePlayer(msg.from);
  if (!player) return bot.sendMessage(chatId, "Ошибка: нет профиля");

  let clanName = player.clanId && clans[player.clanId] ? clans[player.clanId].name : "—";
  let inv = player.inventory || {};
  let text = `🎒 Инвентарь:
Клан: ${clanName}
🪖 Шлем: ${inv.helmet?.name || "—"} (${inv.helmet?.block || "—"})
🛡 Броня: ${inv.armor?.name || "—"} (${inv.armor?.hp || "—"})
🔫 Оружие: ${inv.weapon?.name || "—"} (${inv.weapon?.dmg || "—"})
🧬 Мутация: ${inv.mutation?.name || "—"} (${inv.mutation?.crit || "—"})
📦 Доп: ${inv.extra?.name || "—"} (${inv.extra?.effect || "—"})

❤️ HP: ${player.hp}/${player.maxHp}
☣️ Заражение: ${player.infection || 0}
🏆 PvP: ${player.pvpWins || 0} побед / ${player.pvpLosses || 0} поражений`;

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
  const sorted = Object.values(players).sort((a,b) => (b.infection||0) - (a.infection||0));
  let text = "🏆 Таблица лидеров:\n\n";
  sorted.slice(0,10).forEach((p,i) =>
    text += `${i+1}. ${escMd(p.username)} — ${p.infection||0}☣️ (PvP: ${p.pvpWins||0}/${p.pvpLosses||0})\n`
  );
  const rank = sorted.findIndex(p => p.id === player.id) + 1;
  text += `\nТвой уровень: ${player.infection}\nТвоя позиция: ${rank>0 ? rank : "—"} / ${sorted.length}`;
  bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
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
if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL || "https://crimecore-bot.onrender.com")
      .then(() => console.log("Пинг OK"))
      .catch(err => console.error("Пинг не удался:", err));
  }, 5 * 60 * 1000);
}


// === Мини HTTP-сервер для Render ===
// === PostgreSQL (Render) ===

// DATABASE_URL должен быть задан в переменных окружения Render




if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, {"Content-Type": "text/plain"});
    res.end("Bot is running\n");
  }).listen(PORT, () => console.log(`HTTP server running on port ${PORT}`));
}


// Аккуратное сохранение при завершении процесса
if (process.env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => { saveData().finally(() => process.exit(0)); });
  process.on('SIGINT', () => { saveData().finally(() => process.exit(0)); });
}

export { mainMenuKeyboard, lootMenuKeyboard };