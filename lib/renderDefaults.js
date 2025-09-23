const DEFAULT_RENDER_POSTGRES = {
  DATABASE_URL:
    'postgresql://crimecore_base_user:jlBNlmK7gPOlXnYQWxjzwF05qOPGjOSh@dpg-d38odlp5pdvs738opae0-a.frankfurt-postgres.render.com/crimecore_base?sslmode=require',
  PGHOST: 'dpg-d38odlp5pdvs738opae0-a',
  PGPORT: '5432',
  PGUSER: 'crimecore_base_user',
  PGPASSWORD: 'jlBNlmK7gPOlXnYQWxjzwF05qOPGjOSh',
  PGDATABASE: 'crimecore_base',
  PGSSLMODE: 'require',
  DB_SSL: 'true'
};

function hasCustomDatabaseConfig(env) {
  if (env.DATABASE_URL) return true;
  const requiredKeys = ['PGHOST', 'PGUSER', 'PGDATABASE'];
  return requiredKeys.every((key) => typeof env[key] === 'string' && env[key].trim() !== '');
}

export function ensureRenderDatabaseDefaults(env = process.env) {
  if (!env || hasCustomDatabaseConfig(env)) {
    return false;
  }

  let applied = false;
  for (const [key, value] of Object.entries(DEFAULT_RENDER_POSTGRES)) {
    if (typeof env[key] === 'undefined' || env[key] === '') {
      env[key] = value;
      applied = true;
    }
  }
  return applied;
}

export function getRenderDatabaseDefaults() {
  return { ...DEFAULT_RENDER_POSTGRES };
}
