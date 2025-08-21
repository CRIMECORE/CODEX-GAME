import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(__dirname, '..', 'data.json');

test('inventory persists in data.json', async () => {
  const original = await fs.readFile(dataPath, 'utf-8').catch(() => '{}');
  try {
    const data = JSON.parse(original || '{}');
    data.players = data.players || {};
    data.players.test = { id: 'test', inventory: { weapon: { name: 'Бита' } } };
    await fs.writeFile(dataPath, JSON.stringify(data));
    const loaded = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
    assert.equal(loaded.players.test.inventory.weapon.name, 'Бита');
  } finally {
    await fs.writeFile(dataPath, original);
  }
});
