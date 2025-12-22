const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
require('dotenv').config();

const app = express();

// CORS
// - Prod: allow specific domains
// - Dev: allow localhost
// - Override via CORS_ORIGINS="https://parkingpro.app,http://localhost:5173,https://*.vercel.app"
const defaultCorsOrigins = [
  'https://parkingpro.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : defaultCorsOrigins;

function originAllowed(origin) {
  if (!origin) return true;

  // exact match
  if (corsOrigins.includes(origin)) return true;

  // wildcard patterns like:
  // - https://*.vercel.app
  // - *.vercel.app
  try {
    const u = new URL(origin);
    const host = u.hostname;
    const protoHost = `${u.protocol}//${host}`;

    for (const rule of corsOrigins) {
      if (!rule) continue;

      // e.g. https://*.vercel.app
      if (rule.includes('*')) {
        if (rule.startsWith('http://*.') || rule.startsWith('https://*.')) {
          const suffix = rule.replace('http://*.', '.').replace('https://*.', '.');
          if (protoHost.endsWith(suffix)) return true;
        }
        // e.g. *.vercel.app
        if (rule.startsWith('*.')) {
          const suffix = rule.slice(1); // ".vercel.app"
          if (host.endsWith(suffix)) return true;
        }
      }
    }
  } catch {
    // ignore URL parse errors
  }

  return false;
}

app.use(
  cors({
    origin: (origin, cb) => {
      // allow non-browser clients (curl/postman) with no Origin header
      if (!origin) return cb(null, true);
      return originAllowed(origin)
        ? cb(null, true)
        : cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true
  })
);
app.use(express.json());
app.use(morgan('dev'));
app.use(helmet());

// Health (para chequear rápido si la Function levanta)
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    at: new Date().toISOString(),
    dbConfigured: Boolean(process.env.DATABASE_URL),
  });
});

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
