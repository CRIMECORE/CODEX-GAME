import { test } from 'node:test';
import assert from 'node:assert';

import { PNG } from 'pngjs';

function createPngBuffer(width, height, fill) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const color = fill({ x, y, idx });
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = color[3];
    }
  }
  return PNG.sync.write(png);
}

test('built-in PNG composer blends overlays when pngjs is unavailable', async (t) => {
  process.env.FORCE_SIMPLE_PNG_COMPOSER = '1';
  const modulePath = `../lib/pngComposer.js?force=${Date.now()}`;
  const pngComposerModule = await import(modulePath);
  t.after(() => {
    delete process.env.FORCE_SIMPLE_PNG_COMPOSER;
  });

  assert.ok(
    pngComposerModule.isPngComposerAvailable(),
    'Expected built-in PNG composer to be available'
  );
  assert.strictEqual(
    pngComposerModule.getPngComposerImplementation(),
    'builtin-simple'
  );

  const baseBuffer = createPngBuffer(2, 2, () => [0, 0, 0, 0]);
  const overlayBuffer = createPngBuffer(2, 2, ({ x, y }) =>
    x === 1 && y === 0 ? [255, 0, 0, 128] : [0, 0, 255, 255]
  );

  const composed = pngComposerModule.composePngBuffers(baseBuffer, [overlayBuffer]);
  const result = PNG.sync.read(composed);

  const topRight = result.data.subarray((2 * 0 + 1) * 4, (2 * 0 + 1) * 4 + 4);
  assert.ok(topRight[3] > 0, 'alpha channel should be non-zero');
  assert.ok(topRight[0] > topRight[2], 'red channel should dominate after blend');

  const bottomLeft = result.data.subarray((2 * 1 + 0) * 4, (2 * 1 + 0) * 4 + 4);
  assert.strictEqual(bottomLeft[2], 255);
  assert.strictEqual(bottomLeft[3], 255);
});
