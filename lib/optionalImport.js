import path from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

const requireContexts = [];

function pushRequireContext(basePath) {
  try {
    const req = createRequire(basePath);
    if (!requireContexts.includes(req)) {
      requireContexts.push(req);
    }
  } catch (err) {
    if (!isModuleNotFoundError(err) && err.code !== 'ERR_INVALID_MODULE_SPECIFIER') {
      throw err;
    }
  }
}

pushRequireContext(import.meta.url);

try {
  const cwd = process.cwd();
  if (cwd) {
    const pkgJsonPath = path.join(cwd, 'package.json');
    pushRequireContext(pkgJsonPath);
  }
} catch (err) {
  // Ignore errors from process.cwd(); we'll fall back to the default context.
}

function isModuleNotFoundError(error) {
  if (!error) return false;
  if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
    return true;
  }
  if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return true;
  }
  if (typeof error.message === 'string') {
    return /Cannot find module|Cannot find package/.test(error.message);
  }
  return false;
}

export async function optionalImport(specifier) {
  let lastModuleNotFoundError = null;

  for (const req of requireContexts) {
    try {
      const required = req(specifier);
      return { module: required };
    } catch (requireError) {
      if (requireError?.code === 'ERR_REQUIRE_ESM') {
        lastModuleNotFoundError = requireError;
        continue;
      }
      if (isModuleNotFoundError(requireError)) {
        lastModuleNotFoundError = requireError;
        continue;
      }
      throw requireError;
    }
  }

  try {
    const imported = await import(specifier);
    return { module: imported };
  } catch (importError) {
    if (!isModuleNotFoundError(importError)) {
      throw importError;
    }
    lastModuleNotFoundError = importError;
  }

  for (const req of requireContexts) {
    try {
      const resolvedPath = req.resolve(specifier);
      const resolvedUrl = pathToFileURL(resolvedPath).href;
      const imported = await import(resolvedUrl);
      return { module: imported };
    } catch (resolveError) {
      if (resolveError?.code === 'ERR_REQUIRE_ESM') {
        lastModuleNotFoundError = resolveError;
        continue;
      }
      if (isModuleNotFoundError(resolveError)) {
        lastModuleNotFoundError = resolveError;
        continue;
      }
      throw resolveError;
    }
  }

  const fallbackError =
    lastModuleNotFoundError || new Error(`Optional module "${specifier}" could not be resolved.`);
  return { module: null, error: fallbackError };
}
