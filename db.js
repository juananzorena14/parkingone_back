const mysql = require('mysql2/promise');
require('dotenv').config();

const uri = process.env.DATABASE_URL;

const sslEnabled = String(process.env.DB_SSL || '').toLowerCase() === 'true';
const rejectUnauthorized = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false';

// Importante para Vercel:
// - Si DATABASE_URL falta, NO tiramos error al require (así /api/health puede responder)
// - Los endpoints que usan DB van a fallar con un error claro.
const pool = uri
  ? mysql.createPool({
      uri,
      waitForConnections: true,
      connectionLimit: 10,
      ...(sslEnabled ? { ssl: { rejectUnauthorized } } : {}),
    })
  : {
      query: async () => { throw new Error('Missing env var: DATABASE_URL'); },
      getConnection: async () => { throw new Error('Missing env var: DATABASE_URL'); },
    };

module.exports = { pool };
