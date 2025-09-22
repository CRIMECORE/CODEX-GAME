import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function waitForPlayerPersist(filePath, playerId, attempts = 40, delayMs = 25) {
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

async function withIsolatedBot(label, run) {
  const suffix = `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempStateFile = path.join(__dirname, `${suffix}.json`);
  const tempBackupFile = path.join(__dirname, `${suffix}-backup.json`);

  await Promise.all([
    removeIfExists(tempStateFile),
    removeIfExists(tempBackupFile)
  ]);

  process.env.NODE_ENV = 'test';
  process.env.DATA_FILE = tempStateFile;
  process.env.DATA_BACKUP_FILE = tempBackupFile;

  const module = await import(`../index.js?${suffix}`);

  try {
    await module.loadData();
    await run({ module, tempStateFile, tempBackupFile });
  } finally {
    delete process.env.DATA_FILE;
    delete process.env.DATA_BACKUP_FILE;

    await Promise.all([
      removeIfExists(tempStateFile),
      removeIfExists(tempBackupFile)
    ]);
  }
}

test('persists player infection through save/load cycle', async () => {
  await withIsolatedBot('infection', async ({ module, tempStateFile }) => {
    const { saveData, ensurePlayer } = module;

    const player = ensurePlayer({ id: 123456, first_name: 'Tester', username: 'tester' });
    player.infection = 77;
    await saveData();

    player.infection = 0;

    await module.loadData();
    assert.equal(module.players['123456'].infection, 77);

    const persisted = await waitForPlayerPersist(tempStateFile, '123456');
    assert.equal(persisted.players['123456'].infection, 77);
  });
});

test('newly created players persist to both primary and backup files', async () => {
  await withIsolatedBot('new-player', async ({ module, tempStateFile, tempBackupFile }) => {
    const playerId = '789654';
    const player = module.ensurePlayer({ id: Number(playerId), first_name: 'Newbie', username: 'newbie' });

    const persistedPrimary = await waitForPlayerPersist(tempStateFile, playerId);
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

    const persistedBackup = await waitForPlayerPersist(tempBackupFile, playerId);
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
