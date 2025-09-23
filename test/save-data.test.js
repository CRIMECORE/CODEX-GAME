import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';

process.env.NODE_ENV = 'test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DB_FILE = path.join(__dirname, `save-data-tests-${process.pid}.db`);
const TEST_DB_ARTIFACTS = [
  TEST_DB_FILE,
  `${TEST_DB_FILE}-wal`,
  `${TEST_DB_FILE}-shm`,
  `${TEST_DB_FILE}-journal`
];

process.env.DATABASE_FILE = TEST_DB_FILE;

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

await Promise.all(TEST_DB_ARTIFACTS.map((file) => removeIfExists(file)));

async function waitForPlayerPersistInFile(filePath, playerId, attempts = 40, delayMs = 25) {
  let lastData = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      lastData = data;
      if (data.players && data.players[playerId]) {
        return data;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
    await delay(delayMs);
  }

  const error = new Error(`Player ${playerId} was not persisted to ${filePath}`);
  if (lastData) {
    error.lastData = lastData;
  }
  throw error;
}

const sqlite = sqlite3.verbose();

function parseJsonColumn(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function parseNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseNullableNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseBoolean(value, defaultValue = false) {
  if (value == null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true';
  }
  return defaultValue;
}

const EMPTY_INVENTORY = { armor: null, helmet: null, weapon: null, mutation: null, extra: null, sign: null };

function mapPlayerRow(row) {
  const rawInventory = parseJsonColumn(row.inventory, null);

  const player = {
    id: row.id,
    username: row.username ?? undefined,
    name: row.name ?? undefined,
    hp: parseNumber(row.hp),
    maxHp: parseNumber(row.maxHp),
    infection: parseNumber(row.infection),
    survivalDays: parseNumber(row.survivalDays),
    bestSurvivalDays: parseNumber(row.bestSurvivalDays),
    clanId: parseNullableNumber(row.clanId),
    inventory: rawInventory && typeof rawInventory === 'object'
      ? { ...EMPTY_INVENTORY, ...rawInventory }
      : { ...EMPTY_INVENTORY },
    monster: parseJsonColumn(row.monster, null),
    monsterStun: parseNumber(row.monsterStun),
    damageBoostTurns: parseNumber(row.damageBoostTurns),
    damageReductionTurns: parseNumber(row.damageReductionTurns),
    radiationBoost: parseBoolean(row.radiationBoost),
    firstAttack: parseBoolean(row.firstAttack, true),
    lastHunt: parseNumber(row.lastHunt),
    pendingDrop: parseJsonColumn(row.pendingDrop, null),
    pvpWins: parseNumber(row.pvpWins),
    pvpLosses: parseNumber(row.pvpLosses),
    lastGiftTime: parseNumber(row.lastGiftTime),
    huntCooldownWarned: parseBoolean(row.huntCooldownWarned),
    currentDanger: parseJsonColumn(row.currentDanger, null),
    currentDangerMsgId: parseNullableNumber(row.currentDangerMsgId),
    baseUrl: row.baseUrl ?? undefined,
    pvp: parseJsonColumn(row.pvp, null)
  };

  if (!player.inventory || typeof player.inventory !== 'object') {
    player.inventory = { ...EMPTY_INVENTORY };
  }

  const extra = parseJsonColumn(row.extra, null);
  if (extra && typeof extra === 'object') {
    Object.assign(player, extra);
  }

  return player;
}

function mapClanRow(row) {
  const clan = {
    id: row.id,
    name: row.name ?? '',
    points: parseNumber(row.points),
    members: parseJsonColumn(row.members, [])
  };
  if (!Array.isArray(clan.members)) clan.members = [];
  const extra = parseJsonColumn(row.extra, null);
  if (extra && typeof extra === 'object') {
    Object.assign(clan, extra);
  }
  return clan;
}

function mapBattleRow(row) {
  const battle = {
    id: row.id,
    clanId: parseNullableNumber(row.clanId),
    opponentClanId: parseNullableNumber(row.opponentClanId),
    status: row.status ?? null,
    createdAt: parseNullableNumber(row.createdAt),
    acceptedBy: parseNullableNumber(row.acceptedBy)
  };
  const extra = parseJsonColumn(row.data, null);
  if (extra && typeof extra === 'object') {
    Object.assign(battle, extra);
  }
  return battle;
}

function mapInviteRow(row) {
  const invite = {
    clanId: parseNullableNumber(row.clanId),
    fromId: parseNullableNumber(row.fromId),
    expires: parseNullableNumber(row.expires)
  };
  const extra = parseJsonColumn(row.extra, null);
  if (extra && typeof extra === 'object') {
    Object.assign(invite, extra);
  }
  return invite;
}

async function readStateFromDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite.Database(dbPath, sqlite.OPEN_READONLY, (openErr) => {
      if (openErr) {
        if (openErr.code === 'SQLITE_CANTOPEN') {
          resolve(null);
        } else {
          reject(openErr);
        }
        return;
      }

      const state = { players: {}, clans: {}, clanBattles: [], clanInvites: {} };

      db.all('SELECT * FROM players', [], (playersErr, playerRows = []) => {
        if (playersErr && !/no such table/i.test(playersErr.message)) {
          db.close(() => reject(playersErr));
          return;
        }

        for (const row of Array.isArray(playerRows) ? playerRows : []) {
          const player = mapPlayerRow(row);
          state.players[String(player.id)] = player;
        }

        db.all('SELECT * FROM clans', [], (clansErr, clanRows = []) => {
          if (clansErr && !/no such table/i.test(clansErr.message)) {
            db.close(() => reject(clansErr));
            return;
          }

          for (const row of Array.isArray(clanRows) ? clanRows : []) {
            const clan = mapClanRow(row);
            state.clans[String(clan.id)] = clan;
          }

          db.all('SELECT * FROM clan_battles', [], (battlesErr, battleRows = []) => {
            if (battlesErr && !/no such table/i.test(battlesErr.message)) {
              db.close(() => reject(battlesErr));
              return;
            }

            for (const row of Array.isArray(battleRows) ? battleRows : []) {
              state.clanBattles.push(mapBattleRow(row));
            }

            db.all('SELECT * FROM clan_invites', [], (invitesErr, inviteRows = []) => {
              if (invitesErr && !/no such table/i.test(invitesErr.message)) {
                db.close(() => reject(invitesErr));
                return;
              }

              for (const row of Array.isArray(inviteRows) ? inviteRows : []) {
                state.clanInvites[String(row.playerId)] = mapInviteRow(row);
              }

              db.close((closeErr) => {
                if (closeErr) {
                  reject(closeErr);
                } else {
                  const hasData =
                    Object.keys(state.players).length > 0 ||
                    Object.keys(state.clans).length > 0 ||
                    state.clanBattles.length > 0 ||
                    Object.keys(state.clanInvites).length > 0;
                  resolve(hasData ? state : null);
                }
              });
            });
          });
        });
      });
    });
  });
}

async function waitForPlayerPersistInDatabase(dbPath, playerId, attempts = 40, delayMs = 25) {
  let lastState = null;
  for (let i = 0; i < attempts; i += 1) {
    const state = await readStateFromDatabase(dbPath);
    if (state) {
      lastState = state;
      if (state.players && state.players[playerId]) {
        return state;
      }
    }
    await delay(delayMs);
  }

  const error = new Error(`Player ${playerId} was not persisted to ${dbPath}`);
  if (lastState) {
    error.lastState = lastState;
  }
  throw error;
}

async function withIsolatedBot(label, run) {
  const suffix = `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempStateFile = path.join(__dirname, `${suffix}.json`);
  const tempBackupFile = path.join(__dirname, `${suffix}-backup.json`);
  const tempDbFile = TEST_DB_FILE;

  await Promise.all([
    removeIfExists(tempStateFile),
    removeIfExists(tempBackupFile)
  ]);

  process.env.NODE_ENV = 'test';
  process.env.DATA_FILE = tempStateFile;
  process.env.DATA_BACKUP_FILE = tempBackupFile;
  process.env.DATABASE_FILE = tempDbFile;

  const module = await import(`../index.js?${suffix}`);

  try {
    if (typeof module.clearBotStateTable === 'function') {
      await module.clearBotStateTable();
    }
    await module.loadData();
    await run({ module, tempStateFile, tempBackupFile, tempDbFile });
  } finally {
    delete process.env.DATA_FILE;
    delete process.env.DATA_BACKUP_FILE;
    delete process.env.DATABASE_FILE;

    await Promise.all([
      removeIfExists(tempStateFile),
      removeIfExists(tempBackupFile)
    ]);
  }
}

test('persists player infection through save/load cycle', async () => {
  await withIsolatedBot('infection', async ({ module, tempStateFile, tempDbFile }) => {
    const { saveData, ensurePlayer } = module;

    const player = ensurePlayer({ id: 123456, first_name: 'Tester', username: 'tester' });
    player.infection = 77;
    await saveData();

    player.infection = 0;

    await module.loadData();
    assert.equal(module.players['123456'].infection, 77);

    const persistedDb = await waitForPlayerPersistInDatabase(tempDbFile, '123456');
    assert.equal(persistedDb.players['123456'].infection, 77);

    const persistedFile = await waitForPlayerPersistInFile(tempStateFile, '123456');
    assert.equal(persistedFile.players['123456'].infection, 77);
  });
});

test('newly created players persist to both primary and backup files', async () => {
  await withIsolatedBot('new-player', async ({ module, tempStateFile, tempBackupFile, tempDbFile }) => {
    const playerId = '789654';
    const player = module.ensurePlayer({ id: Number(playerId), first_name: 'Newbie', username: 'newbie' });

    const persistedDb = await waitForPlayerPersistInDatabase(tempDbFile, playerId);
    assert.ok(persistedDb.players[playerId], 'player should exist in sqlite database');
    assert.equal(persistedDb.players[playerId].hp, 100);

    const persistedPrimary = await waitForPlayerPersistInFile(tempStateFile, playerId);
    assert.ok(persistedPrimary.players[playerId], 'player should exist in main data file');
    assert.equal(persistedPrimary.players[playerId].hp, 100);
    assert.deepEqual(persistedPrimary.players[playerId].inventory, {
      armor: null,
      helmet: null,
      weapon: null,
      mutation: null,
      extra: null,
      sign: null
    });

    const persistedBackup = await waitForPlayerPersistInFile(tempBackupFile, playerId);
    assert.ok(persistedBackup.players[playerId], 'player should exist in backup file');
    assert.deepEqual(persistedBackup.players[playerId].inventory, persistedPrimary.players[playerId].inventory);

    // Mutate in-memory state and ensure a reload restores persisted values.
    player.hp = 5;
    player.inventory.weapon = { name: 'Test Blade' };

    await module.loadData();
    assert.equal(module.players[playerId].hp, 100);
    assert.equal(module.players[playerId].inventory.weapon, null);
  });
});

test.after(async () => {
  const dbModule = await import('../lib/db.js');
  if (dbModule?.default?.end) {
    await dbModule.default.end();
  }
  await Promise.all(TEST_DB_ARTIFACTS.map((file) => removeIfExists(file)));
});
