import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createPool, dbQuery } from '../lib/db.js';

dotenv.config();

const DATA_FILE = path.join(process.cwd(), 'data.json');

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error('data.json not found');
    process.exit(1);
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  const parsed = JSON.parse(raw);
  const players = parsed.players || {};
  const clans = parsed.clans || {};

  // ensure pool is created
  await createPool();

  // Ensure schema exists. split statements and run sequentially.
  const schemaSql = fs.readFileSync(path.join(process.cwd(), 'migrations', 'create_mysql_schema.sql'), 'utf-8');
  const statements = schemaSql
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    try {
      await dbQuery(stmt);
    } catch (err) {
      console.warn('Schema statement failed (continuing):', err.message);
    }
  }

  // Insert clans
  for (const [cid, c] of Object.entries(clans)) {
    await dbQuery(
      'INSERT INTO clans (id, name, points) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), points = VALUES(points)',
      [Number(cid), c.name || null, c.points || 0]
    );
    if (Array.isArray(c.members)) {
      for (const pid of c.members) {
        await dbQuery('INSERT IGNORE INTO clan_members (clan_id, player_id) VALUES (?, ?)', [Number(cid), Number(pid)]);
      }
    }
  }

  // Insert players
  for (const [pid, p] of Object.entries(players)) {
    const id = Number(pid);
    const username = p.username || null;
    const name = p.name || null;
    const hp = typeof p.hp === 'number' ? p.hp : 100;
    const maxHp = typeof p.maxHp === 'number' ? p.maxHp : (p.maxHp || 100);
    const infection = typeof p.infection === 'number' ? p.infection : (p.infection || 0);
    const clanId = p.clanId != null ? p.clanId : null;
    const inventory = p.inventory ? JSON.stringify(p.inventory) : null;
    const monster = p.monster ? JSON.stringify(p.monster) : null;
    const pendingDrop = p.pendingDrop ? JSON.stringify(p.pendingDrop) : null;
    const pvp = p.pvp ? JSON.stringify(p.pvp) : null;
    const pvpWins = p.pvpWins || 0;
    const pvpLosses = p.pvpLosses || 0;
    const lastHunt = p.lastHunt || null;
    const lastGiftTime = p.lastGiftTime || null;

    await dbQuery(
      `INSERT INTO players (id, username, name, hp, max_hp, infection, clan_id, inventory, monster, pending_drop, pvp, pvp_wins, pvp_losses, last_hunt_ms, last_gift_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE username=VALUES(username), name=VALUES(name), hp=VALUES(hp), max_hp=VALUES(max_hp), infection=VALUES(infection), clan_id=VALUES(clan_id), inventory=VALUES(inventory), monster=VALUES(monster), pending_drop=VALUES(pending_drop), pvp=VALUES(pvp), pvp_wins=VALUES(pvp_wins), pvp_losses=VALUES(pvp_losses), last_hunt_ms=VALUES(last_hunt_ms), last_gift_time_ms=VALUES(last_gift_time_ms)`,
      [id, username, name, hp, maxHp, infection, clanId, inventory, monster, pendingDrop, pvp, pvpWins, pvpLosses, lastHunt, lastGiftTime]
    );
  }

  console.log('Import finished');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
