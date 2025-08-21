import fs from 'fs';
import path from 'path';
import { createPool, dbQuery } from '../lib/db.js';
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

  await dbQuery(`INSERT INTO bot_state (id, state, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = CURRENT_TIMESTAMP`, [1, JSON.stringify(obj)]);
  console.log('State restored to MySQL (bot_state).');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
