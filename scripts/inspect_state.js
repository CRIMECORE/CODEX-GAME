import { dbQuery } from '../lib/db.js';

function topPlayers(playersObj, n = 10) {
  const arr = Object.values(playersObj || {});
  arr.sort((a,b) => (b.infection||0) - (a.infection||0));
  return arr.slice(0,n).map(p=>({ id: p.id, username: p.username, infection: p.infection||0, pvp: `${p.pvpWins||0}/${p.pvpLosses||0}` }));
}

async function run() {
  try {
    const [rows] = await dbQuery('SELECT id, state, updated_at FROM bot_state WHERE id = ?', [1]);
    if (!rows || rows.length === 0) {
      console.log('No bot_state row');
      process.exit(0);
    }
    const raw = rows[0].state;
    let parsed;
    if (typeof raw === 'string') parsed = JSON.parse(raw);
    else parsed = raw;
    const players = parsed.players || {};
    console.log('State updated_at =', rows[0].updated_at);
    console.log('Players count =', Object.keys(players).length);
    const tops = topPlayers(players, 20);
    console.log('Top players:');
    tops.forEach((p,i)=> console.log(`${i+1}. ${p.username || p.id} — ${p.infection} (PvP: ${p.pvp})`));

    // Print specific known username if present
    const lookup = 'thisisforgotten';
    const found = Object.values(players).find(p=>p.username===lookup || p.username===`@${lookup}`);
    if (found) console.log('Found', lookup, '=>', { id: found.id, infection: found.infection, pvpWins: found.pvpWins, pvpLosses: found.pvpLosses });
    else console.log('User', lookup, 'not found in DB state');

  } catch (err) {
    console.error('Error inspecting state:', err && err.stack ? err.stack : err);
    process.exit(2);
  }
}

run();
