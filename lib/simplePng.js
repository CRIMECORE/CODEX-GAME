import { inflateSync, deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const COLOR_TYPE_RGBA = 6;
const BIT_DEPTH_8 = 8;
const BYTES_PER_PIXEL = 4;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUInt32BE(buffer, offset) {
  return (
    (buffer[offset] << 24) |
    (buffer[offset + 1] << 16) |
    (buffer[offset + 2] << 8) |
    buffer[offset + 3]
  ) >>> 0;
}

function writeUInt32BE(value) {
  const buf = Buffer.alloc(4);
  buf[0] = (value >>> 24) & 0xff;
  buf[1] = (value >>> 16) & 0xff;
  buf[2] = (value >>> 8) & 0xff;
  buf[3] = value & 0xff;
  return buf;
}

function parseChunks(buffer) {
  if (!buffer || buffer.length < PNG_SIGNATURE.length) {
    throw new Error('PNG buffer is too small.');
  }

  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature.');
  }

  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      throw new Error('Unexpected end of PNG buffer.');
    }
    const length = readUInt32BE(buffer, offset);
    offset += 4;
    const type = buffer.subarray(offset, offset + 4).toString('ascii');
    offset += 4;
    if (offset + length + 4 > buffer.length) {
      throw new Error('PNG chunk length exceeds buffer size.');
    }
    const data = buffer.subarray(offset, offset + length);
    offset += length;
    const expectedCrc = readUInt32BE(buffer, offset);
    offset += 4;

    const crcBuffer = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
    const actualCrc = crc32(crcBuffer);
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC mismatch in PNG chunk ${type}.`);
    }

    chunks.push({ type, data: Buffer.from(data) });
    if (type === 'IEND') break;
  }

  return chunks;
}

function unfilter(scanlines, width, height) {
  const stride = width * BYTES_PER_PIXEL;
  const output = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filterType = scanlines[y * (stride + 1)];
    const inOffset = y * (stride + 1) + 1;
    const outOffset = y * stride;
    const prevOffset = y > 0 ? (y - 1) * stride : -1;

    for (let x = 0; x < stride; x++) {
      const raw = scanlines[inOffset + x];
      const left = x >= BYTES_PER_PIXEL ? output[outOffset + x - BYTES_PER_PIXEL] : 0;
      const up = y > 0 ? output[prevOffset + x] : 0;
      const upLeft = y > 0 && x >= BYTES_PER_PIXEL ? output[prevOffset + x - BYTES_PER_PIXEL] : 0;

      let recon;
      switch (filterType) {
        case 0:
          recon = raw;
          break;
        case 1: // Sub
          recon = (raw + left) & 0xff;
          break;
        case 2: // Up
          recon = (raw + up) & 0xff;
          break;
        case 3: // Average
          recon = (raw + Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4: // Paeth
          recon = (raw + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG filter type: ${filterType}`);
      }

      output[outOffset + x] = recon;
    }
  }

  return output;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function filterNone(data, width, height) {
  const stride = width * BYTES_PER_PIXEL;
  const output = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const inOffset = y * stride;
    const outOffset = y * (stride + 1);
    output[outOffset] = 0;
    data.copy(output, outOffset + 1, inOffset, inOffset + stride);
  }
  return output;
}

function createChunk(type, data) {
  const length = writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

export function decodePng(buffer) {
  const chunks = parseChunks(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts = [];

  for (const { type, data } of chunks) {
    if (type === 'IHDR') {
      width = readUInt32BE(data, 0);
      height = readUInt32BE(data, 4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    }
  }

  if (!width || !height) {
    throw new Error('PNG missing IHDR chunk.');
  }

  if (bitDepth !== BIT_DEPTH_8 || colorType !== COLOR_TYPE_RGBA) {
    throw new Error('Only 8-bit RGBA PNG images are supported.');
  }

  const compressed = Buffer.concat(idatParts);
  const decompressed = inflateSync(compressed);
  const expectedLength = height * (width * BYTES_PER_PIXEL + 1);
  if (decompressed.length !== expectedLength) {
    throw new Error('Unexpected decompressed PNG data length.');
  }

  const data = unfilter(decompressed, width, height);
  return { width, height, data };
}

export function encodePng({ width, height, data }) {
  if (!width || !height) {
    throw new Error('PNG width and height must be provided.');
  }
  if (!data || data.length !== width * height * BYTES_PER_PIXEL) {
    throw new Error('PNG data length does not match width and height.');
  }

  const filtered = filterNone(Buffer.isBuffer(data) ? data : Buffer.from(data), width, height);
  const compressed = deflateSync(filtered);

  const ihdrData = Buffer.alloc(13);
  writeUInt32BE(width).copy(ihdrData, 0);
  writeUInt32BE(height).copy(ihdrData, 4);
  ihdrData[8] = BIT_DEPTH_8;
  ihdrData[9] = COLOR_TYPE_RGBA;
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method

  const chunks = [
    PNG_SIGNATURE,
    createChunk('IHDR', ihdrData),
    createChunk('IDAT', compressed),
    createChunk('IEND', Buffer.alloc(0))
  ];

  return Buffer.concat(chunks);
}

export default {
  decodePng,
  encodePng
};
