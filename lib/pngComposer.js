import { PNG } from 'pngjs';

function blendPixel(base, overlay) {
  const oa = overlay[3] / 255;
  if (oa <= 0) {
    return [base[0], base[1], base[2], base[3]];
  }

  const ba = base[3] / 255;
  const outA = oa + ba * (1 - oa);

  if (outA <= 0) {
    return [0, 0, 0, 0];
  }

  const blendChannel = (oc, bc) => {
    const ocNorm = oc / 255;
    const bcNorm = bc / 255;
    const out = (ocNorm * oa + bcNorm * ba * (1 - oa)) / outA;
    return Math.round(out * 255);
  };

  const r = blendChannel(overlay[0], base[0]);
  const g = blendChannel(overlay[1], base[1]);
  const b = blendChannel(overlay[2], base[2]);
  const a = Math.round(outA * 255);

  return [r, g, b, a];
}

export function composePngBuffers(baseBuffer, overlayBuffers = []) {
  if (!Buffer.isBuffer(baseBuffer)) {
    baseBuffer = Buffer.from(baseBuffer);
  }

  const basePng = PNG.sync.read(baseBuffer);

  if (!overlayBuffers?.length) {
    return PNG.sync.write(basePng);
  }

  for (const buffer of overlayBuffers) {
    if (!buffer) continue;

    const normalizedBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const overlayPng = PNG.sync.read(normalizedBuffer);

    if (
      overlayPng.width !== basePng.width ||
      overlayPng.height !== basePng.height
    ) {
      throw new Error(
        `Overlay dimensions ${overlayPng.width}x${overlayPng.height} do not match base ${basePng.width}x${basePng.height}`
      );
    }

    const { data: baseData } = basePng;
    const { data: overlayData } = overlayPng;

    for (let i = 0; i < baseData.length; i += 4) {
      const blended = blendPixel(
        baseData.subarray(i, i + 4),
        overlayData.subarray(i, i + 4)
      );

      baseData[i] = blended[0];
      baseData[i + 1] = blended[1];
      baseData[i + 2] = blended[2];
      baseData[i + 3] = blended[3];
    }
  }

  return PNG.sync.write(basePng);
}

export default composePngBuffers;
