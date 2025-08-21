import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const DATA_FILE = path.join(process.cwd(), 'data.json');
async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error('data.json not found');
    process.exit(1);
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { console.error('Invalid JSON:', e.message); process.exit(1); }

  const pool = await mysql.createPool({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'codex_game',
    port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3306
  });

  await pool.query(`INSERT INTO bot_state (id, state, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = CURRENT_TIMESTAMP`, [1, JSON.stringify(obj)]);
  console.log('State restored to MySQL (bot_state).');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
