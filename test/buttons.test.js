import { test } from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';
const { mainMenuKeyboard, lootMenuKeyboard } = await import('../index.js');

test('main menu contains all expected buttons', () => {
  const keyboard = mainMenuKeyboard();
  const callbacks = keyboard.inline_keyboard.flat().map(btn => btn.callback_data);
  assert.ok(callbacks.includes('hunt'));
  assert.ok(callbacks.includes('loot_menu'));
  assert.ok(callbacks.includes('inventory'));
  assert.ok(callbacks.includes('leaderboard'));
  assert.ok(callbacks.includes('pvp_request'));
  assert.ok(callbacks.includes('clans_menu'));
});

test('loot menu contains free gift and back buttons', () => {
  const keyboard = lootMenuKeyboard();
  const callbacks = keyboard.inline_keyboard.flat().map(btn => btn.callback_data);
  assert.deepStrictEqual(callbacks, ['free_gift', 'play']);
});
