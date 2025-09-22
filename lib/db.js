import { ensureEnvConfig } from './env.js';
import { optionalImport } from './optionalImport.js';

const envResult = await ensureEnvConfig({ quiet: true });
if (!envResult.loaded && envResult.error && process.env.NODE_ENV !== 'production') {
  console.warn('Не удалось загрузить dotenv:', envResult.error.message);
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

if (process.env.NODE_ENV !== 'test') {
  const hasPostgresConfig = Boolean(process.env.DATABASE_URL);
  const requiredMysqlEnv = ['DB_HOST', 'DB_USER', 'DB_NAME'];
  const hasAllMysqlEnv = requiredMysqlEnv.every((key) => process.env[key]);
  const hasAnyMysqlEnv = requiredMysqlEnv.some((key) => process.env[key]);

  if (hasPostgresConfig) {
    const { module: pgModule, error } = await optionalImport('pg');
    if (pgModule?.Pool) {
      const { Pool } = pgModule;
      const pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
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

export default pool;
