import { ensureEnvConfig } from './env.js';
import { optionalImport } from './optionalImport.js';
import { ensureRenderDatabaseDefaults } from './renderDefaults.js';

const envResult = await ensureEnvConfig({ quiet: true });
if (!envResult.loaded && envResult.error && process.env.NODE_ENV !== 'production') {
  console.warn('Не удалось загрузить dotenv:', envResult.error.message);
}

const defaultsApplied = ensureRenderDatabaseDefaults();
if (defaultsApplied && process.env.NODE_ENV !== 'test') {
  console.info('Render PostgreSQL defaults applied from renderDefaults.js.');
}

const noopPool = {
  dialect: 'memory',
  async execute() {
    return [[], { rows: [] }];
  },
  async query() {
    return { rows: [] };
  },
  async getConnection() {
    return { release() {} };
  }
};

let pool = noopPool;

function hasExplicitPostgresConfig() {
  if (process.env.DATABASE_URL) return true;

  const pgKeys = ['PGHOST', 'PGUSER', 'PGDATABASE'];
  const hasRequired = pgKeys.every((key) => process.env[key]);
  const hasAny = pgKeys.some((key) => process.env[key]);
  return hasRequired && hasAny;
}

if (process.env.NODE_ENV !== 'test') {
  const hasPostgresConfig = hasExplicitPostgresConfig();
  const requiredMysqlEnv = ['DB_HOST', 'DB_USER', 'DB_NAME'];
  const hasAllMysqlEnv = requiredMysqlEnv.every((key) => process.env[key]);
  const hasAnyMysqlEnv = requiredMysqlEnv.some((key) => process.env[key]);

  if (hasPostgresConfig) {
    const { module: pgModule, error } = await optionalImport('pg');
    if (pgModule?.Pool) {
      const { Pool } = pgModule;
      const baseConfig = process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {
            host: process.env.PGHOST,
            port: process.env.PGPORT ? Number.parseInt(process.env.PGPORT, 10) : undefined,
            user: process.env.PGUSER,
            password: process.env.PGPASSWORD,
            database: process.env.PGDATABASE
          };
      const sslEnabled =
        process.env.DB_SSL === 'true' ||
        process.env.PGSSL === 'true' ||
        (process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable');
      const pgPool = new Pool({
        ...baseConfig,
        ssl: sslEnabled ? { rejectUnauthorized: false } : undefined
      });
      pool = {
        dialect: 'postgres',
        async execute(sql, params = []) {
          const result = await pgPool.query(sql, params);
          return [result.rows, result];
        },
        async query(sql, params = []) {
          return pgPool.query(sql, params);
        },
        async getConnection() {
          const client = await pgPool.connect();
          return {
            async execute(sql, params = []) {
              const result = await client.query(sql, params);
              return [result.rows, result];
            },
            async query(sql, params = []) {
              return client.query(sql, params);
            },
            release() {
              client.release();
            }
          };
        },
        async end() {
          await pgPool.end();
        }
      };
    } else if (error) {
      console.warn(
        'PostgreSQL драйвер pg недоступен; использование базы данных отключено. Падение в режим памяти.'
      );
    }
  } else if (hasAllMysqlEnv) {
    const { module: mysqlModule, error } = await optionalImport('mysql2/promise');
    if (mysqlModule) {
      const mysql = mysqlModule.default || mysqlModule;
      const mysqlPool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
      });
      pool = {
        dialect: 'mysql',
        execute(sql, params = []) {
          return mysqlPool.execute(sql, params);
        },
        query(sql, params = []) {
          return mysqlPool.query(sql, params);
        },
        getConnection() {
          return mysqlPool.getConnection();
        },
        end() {
          return mysqlPool.end();
        }
      };
    } else if (error) {
      console.warn(
        'MySQL драйвер mysql2 недоступен; использование базы данных отключено. Падение в режим памяти.'
      );
    }
  } else if (hasAnyMysqlEnv) {
    console.warn(
      'Переменные окружения MySQL указаны не полностью; падение в режим памяти.'
    );
  }
}

export async function initializeDatabase() {
  if (!pool || pool.dialect === 'memory') {
    return false;
  }

  try {
    if (pool.dialect === 'postgres') {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bot_state (
          id INTEGER PRIMARY KEY,
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    } else if (pool.dialect === 'mysql') {
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS bot_state (
          id INT PRIMARY KEY,
          state JSON NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
    }
    return true;
  } catch (err) {
    console.error('Не удалось инициализировать базу данных:', err);
    return false;
  }
}

export default pool;
