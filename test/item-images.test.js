import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getItemNamesByCategory,
  getItemImageMap,
  normalizeItemName
} from '../lib/items.js';

process.env.NODE_ENV = 'test';

test('every configured item has an associated image asset', () => {
  const categories = getItemNamesByCategory();
  const imageMap = getItemImageMap();

  for (const [category, names] of Object.entries(categories)) {
    for (const name of names) {
      const key = normalizeItemName(name);
      assert.ok(
        imageMap[key],
        `Изображение не найдено для категории "${category}" и предмета "${name}"`
      );
    }
  }
});
