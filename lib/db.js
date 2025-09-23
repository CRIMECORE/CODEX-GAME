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
    return true;
  } catch (err) {
    console.error('Не удалось инициализировать базу данных:', err);
    return false;
  }
}

export default pool;
