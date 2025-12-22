const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
require('dotenv').config();

const app = express();

// CORS
// - Prod: allow https://parkingpro.app
// - Dev: allow localhost
// - Override via CORS_ORIGINS="https://parkingpro.app,http://localhost:5173"
const defaultCorsOrigins = [
  'https://parkingpro.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : defaultCorsOrigins;

app.use(
  cors({
    origin: (origin, cb) => {
      // allow non-browser clients (curl/postman) with no Origin header
      if (!origin) return cb(null, true);
      return corsOrigins.includes(origin)
        ? cb(null, true)
        : cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true
  })
);
app.use(express.json());
app.use(morgan('dev'));
app.use(helmet());

// Rutas bajo /api
app.use('/api/auth', require('./routes/auth'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/rateplans', require('./routes/rateplans'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/subscribers', require('./routes/subscribers'));
app.use('/api/cash-shifts', require('./routes/cashShift'));

// Static público
app.use('/public', express.static('public'));
app.use('/public', require('./routes/public'));

module.exports = app;
