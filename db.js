const mysql = require('mysql2/promise');
require('dotenv').config();

const uri = process.env.DATABASE_URL;
if (!uri) {
  // En Vercel esto suele ser el motivo #1 de "Function crashed"
  // porque termina intentando conectar a localhost.
  throw new Error('Missing env var: DATABASE_URL');
}

const sslEnabled = String(process.env.DB_SSL || '').toLowerCase() === 'true';

const pool = mysql.createPool({
  uri,
  waitForConnections: true,
  connectionLimit: 10,
  ...(sslEnabled ? { ssl: { rejectUnauthorized: true } } : {}),
});

module.exports = { pool };
