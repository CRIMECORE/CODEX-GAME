import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const CASE_TYPES = Object.freeze({
  FREE_GIFT: 'free_gift',
  INVITE: 'invite',
  INFECTION: 'infection',
  BASIC: 'basic',
  LEGEND: 'legend',
  SIGN: 'sign'
});

export const GENERAL_CASE_TYPES = [
  CASE_TYPES.FREE_GIFT,
  CASE_TYPES.INVITE,
  CASE_TYPES.INFECTION,
  CASE_TYPES.BASIC
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IMAGE_FILE = path.join(ROOT_DIR, 'броня.txt');

export const normalizeItemName = (str) =>
  String(str || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]/gi, '');

export const loadItemImageMap = () => {
  const map = {};
  if (!fs.existsSync(IMAGE_FILE)) {
    return map;
  }
  const content = fs.readFileSync(IMAGE_FILE, 'utf-8');
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const separatorIndex = raw.indexOf(':');
    if (separatorIndex === -1) continue;
    const name = raw.slice(0, separatorIndex).trim();
    const url = raw.slice(separatorIndex + 1).trim();
    if (!name || !url) continue;
    map[normalizeItemName(name)] = url;
  }
  return map;
};

const ITEM_IMAGE_MAP = loadItemImageMap();

export const getItemImageMap = () => ({ ...ITEM_IMAGE_MAP });

export const ITEM_RARITY = {
  VERY_RARE: { key: 'very_rare', label: 'крайне редкое' },
  RARE: { key: 'rare', label: 'редкое' },
  COMMON: { key: 'common', label: 'обычная редкость' },
  LEGENDARY: { key: 'legendary', label: 'легендарная редкость' }
};

const applyRarity = (item, rarity) => ({
  ...item,
  rarity: rarity.label,
  rarityKey: rarity.key
});

function resolveExplicitRarity(item) {
  if (!item) return null;

  const explicitKey =
    typeof item.rarityKey === 'string' && item.rarityKey.trim().length > 0
      ? item.rarityKey.trim()
      : null;
  const explicitLabel =
    typeof item.rarity === 'string' && item.rarity.trim().length > 0
      ? item.rarity.trim()
      : null;

  if (!explicitKey && !explicitLabel) {
    return null;
  }

  if (explicitKey && ITEM_RARITY[explicitKey.toUpperCase()]) {
    const template = ITEM_RARITY[explicitKey.toUpperCase()];
    return {
      rarityKey: template.key,
      rarity: explicitLabel || template.label
    };
  }

  if (explicitKey && ITEM_RARITY[explicitKey]) {
    return {
      rarityKey: ITEM_RARITY[explicitKey].key,
      rarity: explicitLabel || ITEM_RARITY[explicitKey].label
    };
  }

  if (explicitLabel) {
    return {
      rarityKey: explicitKey || null,
      rarity: explicitLabel
    };
  }

  return null;
}

function assignRarity(items, kind) {
  const enriched = items.map((item) => ({
    ...item,
    ...(kind ? { kind } : {})
  }));

  if (enriched.length === 0) {
    return enriched;
  }

  const autoAssignable = [];

  for (let i = 0; i < enriched.length; i += 1) {
    const item = enriched[i];
    const explicit = resolveExplicitRarity(item);
    if (explicit) {
      enriched[i] = {
        ...item,
        rarity: explicit.rarity,
        rarityKey: explicit.rarityKey
      };
      continue;
    }

    autoAssignable.push({
      index: i,
      chance: Number.isFinite(item.chance) ? item.chance : Number.POSITIVE_INFINITY
    });
  }

  if (autoAssignable.length === 0) {
    return enriched;
  }

  autoAssignable.sort((a, b) => a.chance - b.chance);

  const total = autoAssignable.length;
  const veryRareLimit = Math.max(1, Math.ceil(total / 3));
  const rareLimit = Math.max(veryRareLimit, Math.ceil((total * 2) / 3));

  for (let i = 0; i < autoAssignable.length; i += 1) {
    const { index } = autoAssignable[i];
    const rarity =
      i < veryRareLimit
        ? ITEM_RARITY.VERY_RARE
        : i < rareLimit
          ? ITEM_RARITY.RARE
          : ITEM_RARITY.COMMON;

    enriched[index] = {
      ...enriched[index],
      rarity: rarity.label,
      rarityKey: rarity.key
    };
  }

  return enriched;
}

function ensureCaseProps(item, { defaultCases = GENERAL_CASE_TYPES } = {}) {
  const caseEligible = item.caseEligible !== undefined ? Boolean(item.caseEligible) : true;
  const rawTypes = Array.isArray(item.caseTypes) ? item.caseTypes : defaultCases;
  const caseTypes = Array.from(new Set(rawTypes)).filter(Boolean);
  return { ...item, caseEligible, caseTypes };
}

const armorItemsBase = [
  applyRarity({ name: "Бронежилет химзащита", hp: 20, chance: 25 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Броня бинты", hp: 30, chance: 22 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Бронежилет из жертв", hp: 40, chance: 20 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Бронежилет любительский", hp: 50, chance: 18 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Бронежилет базовый", hp: 100, chance: 15 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Бронежилет полиции", hp: 250, chance: 10 }, ITEM_RARITY.RARE),
  applyRarity(
    { name: "Бронежилет военных", hp: 350, chance: 6, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.RARE
  ),
  applyRarity(
    { name: "Бронежилет CRIMECORE", hp: 500, chance: 4, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.RARE
  ),
  applyRarity(
    { name: "Бронежилет мутации", hp: 550, chance: 2, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Бронежилет хим. вещества", hp: 600, chance: 1.5, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Бронежилет протез", hp: 800, chance: 1, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Броня хай-тек", hp: 1100, chance: 0.5, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Броня скелет", hp: 1400, chance: 0.3, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.LEGENDARY
  )
].map((item) => ensureCaseProps(item));

const weaponItemsBase = [
  applyRarity({ name: "Бита", dmg: 10, chance: 15 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Перочинный нож", dmg: 15, chance: 13 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Кухонный нож", dmg: 15, chance: 13 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Охотничий нож", dmg: 20, chance: 12 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Топор", dmg: 30, chance: 10 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Мачете", dmg: 30, chance: 10 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Бензопила", dmg: 40, chance: 6 }, ITEM_RARITY.COMMON),
  applyRarity(
    { name: "Катана", dmg: 45, chance: 5, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.RARE
  ),
  applyRarity({ name: "Glock-17", dmg: 70, chance: 5 }, ITEM_RARITY.RARE),
  applyRarity({ name: "Tec-9", dmg: 75, chance: 4 }, ITEM_RARITY.RARE),
  applyRarity(
    { name: "MP-7", dmg: 100, chance: 3, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.RARE
  ),
  applyRarity(
    { name: "Uzi", dmg: 100, chance: 3, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.RARE
  ),
  applyRarity(
    { name: "UMP", dmg: 120, chance: 2.5, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.RARE
  ),
  applyRarity(
    { name: "Охотничье ружьё", dmg: 170, chance: 2, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.RARE
  ),
  applyRarity(
    { name: "Дробовик", dmg: 180, chance: 1.5, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Двустволка", dmg: 190, chance: 1.2, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Famas", dmg: 210, chance: 1, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "M4", dmg: 240, chance: 0.7, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Ak-47", dmg: 250, chance: 0.8, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "SCAR-L", dmg: 260, chance: 0.7, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "ВСК-94", dmg: 300, chance: 0.5, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "VSS", dmg: 370, chance: 0.25, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "AWP", dmg: 350, chance: 0.3, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Гранатомет", dmg: 380, chance: 0.2, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Подопытный", dmg: 450, chance: 0.1, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.LEGENDARY
  )
].map((item) => ensureCaseProps(item));

const helmetItemsBase = [
  applyRarity({ name: "Пакет", block: 2, chance: 20 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Шлем шапка", block: 3, chance: 19 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Шлем бинты", block: 3, chance: 19 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Кепка", block: 3, chance: 18 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Балаклава", block: 3, chance: 18 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Кожаный шлем", block: 5, chance: 15 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Шлем Респиратор", block: 5, chance: 14 }, ITEM_RARITY.RARE),
  applyRarity({ name: "Велосипедный шлем", block: 5, chance: 15 }, ITEM_RARITY.RARE),
  applyRarity({ name: "Строительный шлем", block: 10, chance: 10 }, ITEM_RARITY.RARE),
  applyRarity({ name: "Противогаз", block: 20, chance: 6 }, ITEM_RARITY.RARE),
  applyRarity(
    { name: "Шлем пила", block: 20, chance: 4, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.RARE
  ),
  applyRarity({ name: "Боевой шлем", block: 20, chance: 5 }, ITEM_RARITY.VERY_RARE),
  applyRarity(
    { name: "Военный шлем", block: 30, chance: 3, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Шлем ночного видения", block: 25, chance: 2, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Шлем стальной", block: 35, chance: 1.5, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Шлем CRIMECORE", block: 40, chance: 2, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.LEGENDARY
  )
].map((item) => ensureCaseProps(item));

const mutationItemsBase = [
  applyRarity({ name: "Зубной", crit: 0.10, chance: 25 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Кровоточащий", crit: 0.15, chance: 20 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Порезанный", crit: 0.15, chance: 20 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Молчаливый", crit: 0.20, chance: 18 }, ITEM_RARITY.COMMON),
  applyRarity({ name: "Аниме", crit: 0.20, chance: 15 }, ITEM_RARITY.RARE),
  applyRarity({ name: "Момо", crit: 0.20, chance: 15 }, ITEM_RARITY.RARE),
  applyRarity({ name: "Безликий", crit: 0.25, chance: 12 }, ITEM_RARITY.RARE),
  applyRarity(
    { name: "Зубастик", crit: 0.30, chance: 10, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Клешни", crit: 0.30, chance: 6, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Бог", crit: 0.50, chance: 2, caseTypes: [...GENERAL_CASE_TYPES, CASE_TYPES.LEGEND] },
    ITEM_RARITY.LEGENDARY
  )
].map((item) => ensureCaseProps(item));

const extraItemsBase = [
  applyRarity(
    { name: "Фотоаппарат со вспышкой", effect: "stun2", chance: 20, turns: 2 },
    ITEM_RARITY.COMMON
  ),
  applyRarity(
    { name: "Слеповая граната", effect: "stun2", chance: 20, turns: 2 },
    ITEM_RARITY.COMMON
  ),
  applyRarity({ name: "Петарда", effect: "damage50", chance: 20 }, ITEM_RARITY.RARE),
  applyRarity({ name: "Граната", effect: "damage100", chance: 15 }, ITEM_RARITY.RARE),
  applyRarity(
    { name: "Адреналин", effect: "halfDamage1", chance: 12, turns: 1 },
    ITEM_RARITY.VERY_RARE
  ),
  applyRarity(
    { name: "Газовый балон", effect: "doubleDamage1", chance: 6, turns: 1 },
    ITEM_RARITY.LEGENDARY
  )
].map((item) => ensureCaseProps(item));

export const armorItems = assignRarity(armorItemsBase, 'armor');
export const weaponItems = assignRarity(weaponItemsBase, 'weapon');
export const helmetItems = assignRarity(helmetItemsBase, 'helmet');
export const mutationItems = assignRarity(mutationItemsBase, 'mutation');
export const extraItems = assignRarity(extraItemsBase, 'extra');

export const signItems = [
  ensureCaseProps(
    applyRarity(
      {
        name: "Знак внимание",
        kind: "sign",
        vampirism: 0.10,
        caseEligible: true,
        caseTypes: [CASE_TYPES.SIGN]
      },
      ITEM_RARITY.COMMON
    ),
    { defaultCases: [CASE_TYPES.SIGN] }
  ),
  ensureCaseProps(
    applyRarity(
      {
        name: "Знак череп",
        kind: "sign",
        vampirism: 0.15,
        caseEligible: true,
        caseTypes: [CASE_TYPES.SIGN]
      },
      ITEM_RARITY.COMMON
    ),
    { defaultCases: [CASE_TYPES.SIGN] }
  ),
  ensureCaseProps(
    applyRarity(
      {
        name: "Знак 18+",
        kind: "sign",
        vampirism: 0.20,
        caseEligible: true,
        caseTypes: [CASE_TYPES.SIGN]
      },
      ITEM_RARITY.COMMON
    ),
    { defaultCases: [CASE_TYPES.SIGN] }
  ),
  ensureCaseProps(
    applyRarity(
      {
        name: "Знак CRIMECORE",
        kind: "sign",
        vampirism: 0.25,
        caseEligible: true,
        caseTypes: [CASE_TYPES.SIGN]
      },
      ITEM_RARITY.RARE
    ),
    { defaultCases: [CASE_TYPES.SIGN] }
  ),
  ensureCaseProps(
    applyRarity(
      {
        name: "Знак BIOHAZARD",
        kind: "sign",
        vampirism: 0.30,
        caseEligible: true,
        caseTypes: [CASE_TYPES.SIGN]
      },
      ITEM_RARITY.RARE
    ),
    { defaultCases: [CASE_TYPES.SIGN] }
  ),
  ensureCaseProps(
    applyRarity(
      {
        name: "Знак радиации",
        kind: "sign",
        preventLethal: "radiation",
        extraTurn: true,
        caseEligible: true,
        caseTypes: [CASE_TYPES.SIGN]
      },
      ITEM_RARITY.VERY_RARE
    ),
    { defaultCases: [CASE_TYPES.SIGN] }
  ),
  ensureCaseProps(
    applyRarity(
      {
        name: "Знак пустой",
        kind: "sign",
        dodgeChance: 0.20,
        caseEligible: true,
        caseTypes: [CASE_TYPES.SIGN]
      },
      ITEM_RARITY.VERY_RARE
    ),
    { defaultCases: [CASE_TYPES.SIGN] }
  ),
  ensureCaseProps(
    applyRarity(
      {
        name: "Знак final CRIMECORE",
        kind: "sign",
        preventLethal: "final",
        fullHeal: true,
        caseEligible: false,
        caseTypes: []
      },
      ITEM_RARITY.LEGENDARY
    ),
    { defaultCases: [] }
  )
];

const ITEM_DEFINITIONS = {
  armor: armorItems,
  weapon: weaponItems,
  helmet: helmetItems,
  mutation: mutationItems,
  extra: extraItems,
  sign: signItems
};

export function getCaseItems(caseType, { includeSigns = false } = {}) {
  if (!caseType) return [];
  const pools = [
    { items: weaponItems, kind: 'weapon' },
    { items: helmetItems, kind: 'helmet' },
    { items: mutationItems, kind: 'mutation' },
    { items: extraItems, kind: 'extra' },
    { items: armorItems, kind: 'armor' }
  ];

  if (includeSigns || caseType === CASE_TYPES.SIGN) {
    pools.push({ items: signItems, kind: 'sign' });
  }

  const normalized = String(caseType);
  const eligible = [];
  for (const { items, kind } of pools) {
    for (const item of items) {
      if (!item || item.caseEligible === false) continue;
      const caseTypes = Array.isArray(item.caseTypes) ? item.caseTypes : GENERAL_CASE_TYPES;
      if (!caseTypes.includes(normalized)) continue;
      eligible.push({ ...item, kind });
    }
  }

  return eligible;
}

export const getItemNamesByCategory = () => (
  Object.fromEntries(
    Object.entries(ITEM_DEFINITIONS).map(([category, items]) => [
      category,
      items.map((item) => item.name)
    ])
  )
);

export const getAllItemDefinitions = () => ITEM_DEFINITIONS;
