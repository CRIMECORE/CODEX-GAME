import dotenv from 'dotenv';
dotenv.config();

let pool = {
  execute: async () => [],
  query: async () => [],
  getConnection: async () => ({ release: () => {} })
};

if (process.env.NODE_ENV !== 'test') {
  try {
    const mysqlModule = await import('mysql2/promise');
    const mysql = mysqlModule.default || mysqlModule;
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
  } catch (err) {
    console.error('Ошибка инициализации MySQL:', err);
  }
}

export default pool;
