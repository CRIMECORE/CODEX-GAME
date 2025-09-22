import dotenv from 'dotenv';
import mysql from 'mysql2/promise.js';
import pg from 'pg';

dotenv.config();

const { Pool: PgPool } = pg;

function buildPostgresConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    return {
      connectionString,
      ssl: connectionString.includes('sslmode=disable')
        ? false
        : { rejectUnauthorized: false }
    };
  }

  const host = process.env.PGHOST;
  if (!host) return null;

  const config = {
    host,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD
  };

  if (process.env.PGSSL === 'true' || process.env.RENDER) {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

function buildMysqlConfig() {
  const host = process.env.DB_HOST;
  if (!host) return null;

  return {
    host,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0
  };
}

class Database {
  constructor() {
    const pgConfig = buildPostgresConfig();
    if (pgConfig) {
      this.dialect = 'postgres';
      this.pool = new PgPool(pgConfig);
      return;
    }

    const mysqlConfig = buildMysqlConfig();
    if (mysqlConfig) {
      this.dialect = 'mysql';
      this.pool = mysql.createPool(mysqlConfig);
      return;
    }

    throw new Error('Database configuration not found. Please define DATABASE_URL or MySQL credentials.');
  }

  formatQuery(text) {
    if (this.dialect !== 'postgres') {
      return text;
    }

    let index = 0;
    return text.replace(/\?/g, () => {
      index += 1;
      return `$${index}`;
    });
  }

  async execute(text, params = []) {
    const sql = this.formatQuery(text);
    if (this.dialect === 'postgres') {
      const result = await this.pool.query(sql, params);
      return [result.rows, result];
    }
    return this.pool.execute(sql, params);
  }

  async query(text, params = []) {
    const sql = this.formatQuery(text);
    if (this.dialect === 'postgres') {
      return this.pool.query(sql, params);
    }
    return this.pool.query(sql, params);
  }

  async end() {
    await this.pool.end();
  }
}

const database = new Database();

export default database;
