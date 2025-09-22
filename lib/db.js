try {
  const dotenvModule = await import('dotenv');
  const dotenv = dotenvModule.default || dotenvModule;
  if (typeof dotenv.config === 'function') {
    dotenv.config();
  }
} catch (err) {
  if (process.env.NODE_ENV !== 'production') {
    console.warn('Не удалось загрузить dotenv:', err.message);
  }
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
  if (process.env.DATABASE_URL) {
    try {
      const pgModule = await import('pg');
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
    } catch (err) {
      console.error('Ошибка инициализации PostgreSQL:', err);
    }
  } else {
    try {
      const mysqlModule = await import('mysql2/promise');
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
    } catch (err) {
      console.error('Ошибка инициализации MySQL:', err);
    }
  }
}

export default pool;
