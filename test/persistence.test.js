import { test } from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';

const pool = (await import('../lib/db.js')).default;

let storedState = null;

pool.execute = async (query, params = []) => {
  if (query.includes('SELECT state FROM bot_state')) {
    if (!storedState) {
      return [[], []];
    }
    return [[{ state: storedState }], []];
  }
  if (query.includes('INSERT INTO bot_state')) {
    storedState = params[0];
    return [{ affectedRows: 1 }, undefined];
  }
  throw new Error(`Unexpected query in test stub: ${query}`);
};

const {
  saveData,
  loadData,
  __setStateForTests,
  __getStateForTests
} = await import('../index.js');

test('player state persists across save and load cycle', async () => {
  storedState = null;

  await loadData();

  __setStateForTests({
    players: {
      '42': {
        id: 42,
        username: 'tester',
        infection: 1234,
        inventory: {
          weapon: { name: 'Бита', dmg: 10 },
          armor: null,
          helmet: null,
          mutation: null,
          extra: null
        }
      }
    },
    clans: {},
    clanBattles: [],
    clanInvites: {}
  });

  await saveData();

  __setStateForTests({ players: {}, clans: {}, clanBattles: [], clanInvites: {} });

  await loadData();

  const state = __getStateForTests();
  assert.ok(state.players['42'], 'player should exist after load');
  assert.strictEqual(state.players['42'].infection, 1234);
  assert.strictEqual(state.players['42'].inventory.weapon.name, 'Бита');
});
