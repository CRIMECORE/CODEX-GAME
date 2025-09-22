import fs from 'fs';
import path from 'path';
import { optionalImport } from './optionalImport.js';

let cachedResult = null;

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const exportPrefix = 'export ';
  const normalized = trimmed.startsWith(exportPrefix)
    ? trimmed.slice(exportPrefix.length)
    : trimmed;
  const match = normalized.match(/^[^=]+=/);
  if (!match) {
    return null;
  }
  const key = match[0].slice(0, -1).trim();
  let value = normalized.slice(match[0].length);
  const commentIndex = (() => {
    let escaped = false;
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i];
      if (char === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (char === '#' && !escaped) {
        return i;
      }
      escaped = false;
    }
    return -1;
  })();
  if (commentIndex !== -1) {
    value = value.slice(0, commentIndex);
  }
  value = value.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  return { key, value };
}

function parseEnv(content) {
  const envMap = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    envMap[parsed.key] = parsed.value;
  }
  return envMap;
}

async function loadFromFile(options = {}) {
  const envPath = options.path
    ? path.resolve(options.path)
    : path.join(process.cwd(), '.env');
  try {
    const content = await fs.promises.readFile(envPath, 'utf8');
    const parsed = parseEnv(content);
    const override = Boolean(options.override);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || override) {
        process.env[key] = value;
      }
    }
    return { loaded: true, source: 'fallback', path: envPath };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { loaded: false, source: null, path: envPath, error };
    }
    throw error;
  }
}

export async function ensureEnvConfig(options = {}) {
  if (cachedResult && !options.force) {
    return cachedResult;
  }

  const dotenvAttempt = await optionalImport('dotenv');
  if (dotenvAttempt.module && typeof dotenvAttempt.module.config === 'function') {
    const dotenv = dotenvAttempt.module.default || dotenvAttempt.module;
    const result = dotenv.config(options);
    cachedResult = { loaded: true, source: 'dotenv', result };
    return cachedResult;
  }

  const fallback = await loadFromFile(options);
  if (!fallback.loaded && dotenvAttempt.error && !options.quiet) {
    const message = dotenvAttempt.error?.message || 'dotenv package not found.';
    console.warn(`Failed to load dotenv package (${message}); falling back to manual parser.`);
  }
  cachedResult = fallback;
  return cachedResult;
}

export function resetEnvCache() {
  cachedResult = null;
}
