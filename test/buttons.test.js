import { test } from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';
const { mainMenuKeyboard, lootMenuKeyboard, clansMenuKeyboard } = await import('../index.js');

test('main menu contains all expected buttons', () => {
  const keyboard = mainMenuKeyboard();
  const callbacks = keyboard.inline_keyboard.flat().map(btn => btn.callback_data);
  assert.ok(callbacks.includes('hunt'));
  assert.ok(callbacks.includes('cases'));
  assert.ok(callbacks.includes('inventory'));
  assert.ok(callbacks.includes('leaderboard'));
  assert.ok(callbacks.includes('pvp_menu'));
  assert.ok(callbacks.includes('clans_menu'));
});

test('loot menu contains expected reward options', () => {
  const keyboard = lootMenuKeyboard();
  const callbacks = keyboard.inline_keyboard.flat().map(btn => btn.callback_data);
  assert.deepStrictEqual(callbacks, [
    'free_gift',
    'preview_case:free_gift',
    'invite_friend',
    'preview_case:invite',
    'sign_case',
    'preview_case:sign',
    'infection_case',
    'preview_case:infection',
    'basic_box',
    'preview_case:basic',
    'legend_box',
    'preview_case:legend',
    'play'
  ]);
});

test('clan menu has expected sections', () => {
  const keyboard = clansMenuKeyboard();
  const callbacks = keyboard.inline_keyboard.flat().map(btn => btn.callback_data || null);
  assert.ok(callbacks.includes('clans_create_join'));
  assert.ok(callbacks.includes('clans_battle_info'));
  assert.ok(callbacks.includes('clans_assault_info'));
  assert.ok(callbacks.includes('play'));
});
