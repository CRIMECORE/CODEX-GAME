import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
    const [name, url] = raw.split(/\s*:\s*/);
    if (!name || !url) continue;
    map[normalizeItemName(name)] = url.trim();
  }
  return map;
};

const ITEM_IMAGE_MAP = loadItemImageMap();

export const getItemImageMap = () => ({ ...ITEM_IMAGE_MAP });

export const armorItems = [
  { name: "Бронежилет химзащита", hp: 20, chance: 25 },
  { name: "Броня бинты", hp: 30, chance: 22 },
  { name: "Бронежилет из жертв", hp: 40, chance: 20 },
  { name: "Бронежилет любительский", hp: 50, chance: 18 },
  { name: "Бронежилет базовый", hp: 100, chance: 15 },
  { name: "Бронежилет полиции", hp: 250, chance: 10 },
  { name: "Бронежилет военных", hp: 350, chance: 6 },
  { name: "Бронежилет CRIMECORE", hp: 500, chance: 4 },
  { name: "Бронежилет мутации", hp: 550, chance: 2 },
  { name: "Бронежилет хим. вещества", hp: 600, chance: 1.5 },
  { name: "Бронежилет протез", hp: 800, chance: 1 },
  { name: "Броня хай-тек", hp: 1100, chance: 0.5 },
  { name: "Броня скелет", hp: 1400, chance: 0.3 }
];

export const weaponItems = [
  { name: "Бита", dmg: 10, chance: 15 },
  { name: "Перочинный нож", dmg: 15, chance: 13 },
  { name: "Кухонный нож", dmg: 15, chance: 13 },
  { name: "Охотничий нож", dmg: 20, chance: 12 },
  { name: "Топор", dmg: 30, chance: 10 },
  { name: "Мачете", dmg: 30, chance: 10 },
  { name: "Бензопила", dmg: 40, chance: 6 },
  { name: "Катана", dmg: 45, chance: 5 },
  { name: "Glock-17", dmg: 70, chance: 5 },
  { name: "Tec-9", dmg: 75, chance: 4 },
  { name: "MP-7", dmg: 100, chance: 3 },
  { name: "Uzi", dmg: 100, chance: 3 },
  { name: "UMP", dmg: 120, chance: 2.5 },
  { name: "Охотничье ружьё", dmg: 170, chance: 2 },
  { name: "Дробовик", dmg: 180, chance: 1.5 },
  { name: "Двустволка", dmg: 190, chance: 1.2 },
  { name: "Famas", dmg: 210, chance: 1 },
  { name: "M4", dmg: 240, chance: 0.7 },
  { name: "Ak-47", dmg: 250, chance: 0.8 },
  { name: "SCAR-L", dmg: 260, chance: 0.7 },
  { name: "ВСК-94", dmg: 300, chance: 0.5 },
  { name: "VSS", dmg: 370, chance: 0.25 },
  { name: "AWP", dmg: 350, chance: 0.3 },
  { name: "Гранатомет", dmg: 380, chance: 0.2 },
  { name: "Подопытный", dmg: 450, chance: 0.1 }
];

export const helmetItems = [
  { name: "Пакет", block: 2, chance: 20 },
  { name: "Шлем шапка", block: 3, chance: 19 },
  { name: "Шлем бинты", block: 3, chance: 19 },
  { name: "Кепка", block: 3, chance: 18 },
  { name: "Балаклава", block: 3, chance: 18 },
  { name: "Кожаный шлем", block: 5, chance: 15 },
  { name: "Шлем Респиратор", block: 5, chance: 14 },
  { name: "Велосипедный шлем", block: 5, chance: 15 },
  { name: "Строительный шлем", block: 10, chance: 10 },
  { name: "Противогаз", block: 20, chance: 6 },
  { name: "Шлем пила", block: 20, chance: 4 },
  { name: "Боевой шлем", block: 20, chance: 5 },
  { name: "Военный шлем", block: 30, chance: 3 },
  { name: "Шлем ночного видения", block: 25, chance: 2 },
  { name: "Шлем стальной", block: 35, chance: 1.5 },
  { name: "Шлем CRIMECORE", block: 40, chance: 2 }
];

export const mutationItems = [
  { name: "Зубной", crit: 0.10, chance: 25 },
  { name: "Кровоточащий", crit: 0.15, chance: 20 },
  { name: "Порезанный", crit: 0.15, chance: 20 },
  { name: "Молчаливый", crit: 0.20, chance: 18 },
  { name: "Аниме", crit: 0.20, chance: 15 },
  { name: "Момо", crit: 0.20, chance: 15 },
  { name: "Безликий", crit: 0.25, chance: 12 },
  { name: "Зубастик", crit: 0.30, chance: 10 },
  { name: "Клешни", crit: 0.30, chance: 6 },
  { name: "Бог", crit: 0.50, chance: 2 }
];

export const extraItems = [
  { name: "Фотоаппарат со вспышкой", effect: "stun2", chance: 20, turns: 2 },
  { name: "Слеповая граната", effect: "stun2", chance: 20, turns: 2 },
  { name: "Петарда", effect: "damage50", chance: 20 },
  { name: "Граната", effect: "damage100", chance: 15 },
  { name: "Адреналин", effect: "halfDamage1", chance: 12, turns: 1 },
  { name: "Газовый балон", effect: "doubleDamage1", chance: 6, turns: 1 },
];

export const signItems = [
  { name: "Знак внимание", kind: "sign", vampirism: 0.10, caseEligible: true },
  { name: "Знак череп", kind: "sign", vampirism: 0.15, caseEligible: true },
  { name: "Знак 18+", kind: "sign", vampirism: 0.20, caseEligible: true },
  { name: "Знак CRIMECORE", kind: "sign", vampirism: 0.25, caseEligible: true },
  { name: "Знак BIOHAZARD", kind: "sign", vampirism: 0.30, caseEligible: true },
  { name: "Знак радиации", kind: "sign", preventLethal: "radiation", extraTurn: true, caseEligible: true },
  { name: "Знак пустой", kind: "sign", dodgeChance: 0.20, caseEligible: true },
  { name: "Знак final CRIMECORE", kind: "sign", preventLethal: "final", fullHeal: true, caseEligible: false }
];

const ITEM_DEFINITIONS = {
  armor: armorItems,
  weapon: weaponItems,
  helmet: helmetItems,
  mutation: mutationItems,
  extra: extraItems,
  sign: signItems
};

export const getItemNamesByCategory = () => (
  Object.fromEntries(
    Object.entries(ITEM_DEFINITIONS).map(([category, items]) => [
      category,
      items.map((item) => item.name)
    ])
  )
);

export const getAllItemDefinitions = () => ITEM_DEFINITIONS;
