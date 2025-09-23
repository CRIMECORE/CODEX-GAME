import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureEnvConfig } from './env.js';
import { ensureRenderDatabaseDefaults } from './renderDefaults.js';

const envResult = await ensureEnvConfig({ quiet: true });
if (!envResult.loaded && envResult.error && process.env.NODE_ENV !== 'production') {
  console.warn('Не удалось загрузить dotenv:', envResult.error.message);
}

ensureRenderDatabaseDefaults();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sqliteModule = await import('sqlite3');
let sqlite3 = sqliteModule.default || sqliteModule;
if (sqlite3 && typeof sqlite3.verbose === 'function') {
  sqlite3 = sqlite3.verbose();
}

const defaultDbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'database.db');
const resolvedDbFile = path.isAbsolute(defaultDbFile)
  ? defaultDbFile
  : path.resolve(process.cwd(), defaultDbFile);

await fs.mkdir(path.dirname(resolvedDbFile), { recursive: true });

function createDatabaseConnection(filePath) {
  return new sqlite3.Database(filePath);
}

const rawDb = createDatabaseConnection(resolvedDbFile);

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function dbRunCallback(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

const pool = {
  dialect: 'sqlite',
  dbFilePath: resolvedDbFile,
  async execute(sql, params = []) {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) {
      const rows = await all(rawDb, sql, params);
      return [rows, { rows }];
    }
    const result = await run(rawDb, sql, params);
    return [result, result];
  },
  async query(sql, params = []) {
    const rows = await all(rawDb, sql, params);
    return { rows };
  },
  async getConnection() {
    return {
      async execute(sql, params = []) {
        return pool.execute(sql, params);
      },
      async query(sql, params = []) {
        return pool.query(sql, params);
      },
      release() {}
    };
  },
  async end() {
    return new Promise((resolve, reject) => {
      rawDb.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
};

export async function initializeDatabase() {
  try {
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS bot_state (
        id INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`
    );
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY,
        username TEXT,
        name TEXT,
        hp INTEGER,
        maxHp INTEGER,
        infection INTEGER,
        survivalDays INTEGER,
        bestSurvivalDays INTEGER,
        clanId INTEGER,
        inventory TEXT,
        monster TEXT,
        monsterStun INTEGER,
        damageBoostTurns INTEGER,
        damageReductionTurns INTEGER,
        radiationBoost INTEGER,
        firstAttack INTEGER,
        lastHunt INTEGER,
        pendingDrop TEXT,
        pvpWins INTEGER,
        pvpLosses INTEGER,
        lastGiftTime INTEGER,
        huntCooldownWarned INTEGER,
        currentDanger TEXT,
        currentDangerMsgId INTEGER,
        baseUrl TEXT,
        pvp TEXT,
        extra TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`
    );
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS clans (
        id INTEGER PRIMARY KEY,
        name TEXT,
        points INTEGER,
        members TEXT,
        extra TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`
    );
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS clan_battles (
        id INTEGER PRIMARY KEY,
        clanId INTEGER,
        opponentClanId INTEGER,
        status TEXT,
        createdAt INTEGER,
        acceptedBy INTEGER,
        data TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`
    );
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS clan_invites (
        playerId TEXT PRIMARY KEY,
        clanId INTEGER,
        fromId INTEGER,
        expires INTEGER,
        extra TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`
    );
    return true;
  } catch (err) {
    console.error('Не удалось инициализировать базу данных:', err);
    return false;
  }
}

export default pool;
