import dotenv from 'dotenv';
dotenv.config();

let pool;

if (process.env.NODE_ENV === 'test') {
  pool = {
    async execute() {
      throw new Error('Test pool.execute stub not configured');
    }
  };
} else {
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
    console.error('Не удалось инициализировать пул MySQL:', err);
    pool = {
      async execute() {
        throw err;
      }
    };
  }
}

export default pool;
