const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = { pool };
