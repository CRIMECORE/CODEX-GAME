import { dbQuery } from '../lib/db.js';

async function run() {
  try {
    console.log('Using env:', {
      MYSQL_HOST: process.env.MYSQL_HOST,
      MYSQL_USER: process.env.MYSQL_USER,
      MYSQL_DATABASE: process.env.MYSQL_DATABASE,
      MYSQL_PORT: process.env.MYSQL_PORT
    });
    const [rows] = await dbQuery('SELECT id, state, updated_at FROM bot_state');
    if (!rows || rows.length === 0) {
      console.log('bot_state is empty');
      process.exit(0);
    }
    for (const r of rows) {
      console.log('id=', r.id, 'updated_at=', r.updated_at);
      try {
        const parsed = typeof r.state === 'string' ? JSON.parse(r.state) : r.state;
        console.log('state keys:', Object.keys(parsed));
      } catch (e) {
        console.log('state (raw):', r.state);
      }
    }
  } catch (err) {
    console.error('DB query failed:', err && err.stack ? err.stack : err);
    process.exit(2);
  }
}

run();
