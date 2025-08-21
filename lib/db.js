import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const poolConfig = process.env.MYSQL_URL
  ? { uri: process.env.MYSQL_URL }
  : {
      host: process.env.MYSQL_HOST || '127.0.0.1',
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'codex_game',
      port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3306,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    };

let pool;
export async function createPool() {
  if (!pool) pool = await mysql.createPool(poolConfig);
  return pool;
}

// semaphore
export const DB_CONCURRENCY_LIMIT = Number(process.env.DB_CONCURRENCY_LIMIT) || 25;
let _activeDbOps = 0;
const _dbQueue = [];
function _acquireDbSlot() {
  if (_activeDbOps < DB_CONCURRENCY_LIMIT) {
    _activeDbOps++;
    return Promise.resolve();
  }
  return new Promise((res) => _dbQueue.push(res));
}
function _releaseDbSlot() {
  _activeDbOps = Math.max(0, _activeDbOps - 1);
  if (_dbQueue.length > 0) {
    const next = _dbQueue.shift();
    _activeDbOps++;
    next();
  }
}

export async function dbQuery(sql, params) {
  const p = await createPool();
  await _acquireDbSlot();
  try {
    return await p.query(sql, params);
  } finally {
    _releaseDbSlot();
  }
}
