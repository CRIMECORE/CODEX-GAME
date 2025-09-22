import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

function isModuleNotFoundError(error) {
  if (!error) return false;
  if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
    return true;
  }
  if (typeof error.message === 'string') {
    return /Cannot find module|Cannot find package/.test(error.message);
  }
  return false;
}

export async function optionalImport(specifier) {
  try {
    const imported = await import(specifier);
    return { module: imported };
  } catch (importError) {
    if (!isModuleNotFoundError(importError)) {
      throw importError;
    }
    try {
      const required = nodeRequire(specifier);
      return { module: required, error: importError };
    } catch (requireError) {
      if (isModuleNotFoundError(requireError)) {
        return { module: null, error: importError };
      }
      throw requireError;
    }
  }
}
