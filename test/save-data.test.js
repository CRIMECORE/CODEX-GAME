import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

test('persists player infection through save/load cycle', async (t) => {
  process.env.NODE_ENV = 'test';
  const tempStateFile = path.join(__dirname, 'temp-state.json');
  const tempBackupFile = path.join(__dirname, 'temp-state-backup.json');
  process.env.DATA_FILE = tempStateFile;
  process.env.DATA_BACKUP_FILE = tempBackupFile;

  await Promise.all([
    removeIfExists(tempStateFile),
    removeIfExists(tempBackupFile)
  ]);

  const module = await import('../index.js');
  const { loadData, saveData, ensurePlayer } = module;
  const getPlayers = () => module.players;

  await loadData();
  const player = ensurePlayer({ id: 123456, first_name: 'Tester', username: 'tester' });
  player.infection = 77;
  await saveData();

  player.infection = 0;

  await loadData();
  assert.equal(getPlayers()['123456'].infection, 77);

  const persisted = JSON.parse(await fs.readFile(tempStateFile, 'utf-8'));
  assert.equal(persisted.players['123456'].infection, 77);

  await Promise.all([
    removeIfExists(tempStateFile),
    removeIfExists(tempBackupFile)
  ]);

  delete process.env.DATA_FILE;
  delete process.env.DATA_BACKUP_FILE;
});
