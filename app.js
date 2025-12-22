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

      // IMPORTANT: do not throw errors from CORS middleware.
      // If origin is not allowed, we simply don't set CORS headers.
      // Browsers will block it, but the server won't return 500.
      return originAllowed(origin) ? cb(null, true) : cb(null, false);
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

function safeMount(prefix, modulePath) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const r = require(modulePath);
    app.use(prefix, r);
  } catch (e) {
    console.error(`[boot] Failed to mount ${modulePath} on ${prefix}:`, e);
    app.use(prefix, (_req, res) => {
      res.status(500).json({ ok: false, error: `Boot error mounting ${modulePath}` });
    });
  }
}

// Rutas bajo /api
safeMount('/api/auth', './routes/auth');
safeMount('/api/settings', './routes/settings');
safeMount('/api/rateplans', './routes/rateplans');
safeMount('/api/tickets', './routes/tickets');
safeMount('/api/payments', './routes/payments');
safeMount('/api/reports', './routes/reports');
safeMount('/api/subscribers', './routes/subscribers');
safeMount('/api/cash-shifts', './routes/cashShift');

// Static público
app.use('/public', express.static('public'));
safeMount('/public', './routes/public');

// Global error handler (loggea en Runtime Logs)
app.use((err, _req, res, _next) => {
  console.error('[express error]', err);
  res.status(500).json({ ok: false, error: String(err?.message || err) });
});

module.exports = app;
