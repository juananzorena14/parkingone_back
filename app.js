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

// Avoid noisy 404s in browser console
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Health (para chequear rápido si la Function levanta)
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    at: new Date().toISOString(),
    dbConfigured: Boolean(process.env.DATABASE_URL),
  });
});

// Rutas bajo /api
// Importante para Vercel: usar require() estático (string literal) para que el bundler incluya los archivos.
try { app.use('/api/auth', require('./routes/auth')); } catch (e) { console.error('[boot] Failed to mount ./routes/auth', e); }
try { app.use('/api/settings', require('./routes/settings')); } catch (e) { console.error('[boot] Failed to mount ./routes/settings', e); }
try { app.use('/api/rateplans', require('./routes/rateplans')); } catch (e) { console.error('[boot] Failed to mount ./routes/rateplans', e); }
try { app.use('/api/tickets', require('./routes/tickets')); } catch (e) { console.error('[boot] Failed to mount ./routes/tickets', e); }
try { app.use('/api/payments', require('./routes/payments')); } catch (e) { console.error('[boot] Failed to mount ./routes/payments', e); }
try { app.use('/api/reports', require('./routes/reports')); } catch (e) { console.error('[boot] Failed to mount ./routes/reports', e); }
try { app.use('/api/subscribers', require('./routes/subscribers')); } catch (e) { console.error('[boot] Failed to mount ./routes/subscribers', e); }
try { app.use('/api/cash-shifts', require('./routes/cashShift')); } catch (e) { console.error('[boot] Failed to mount ./routes/cashShift', e); }

// Static público
app.use('/public', express.static('public'));
try { app.use('/public', require('./routes/public')); } catch (e) { console.error('[boot] Failed to mount ./routes/public', e); }

// Global error handler (loggea en Runtime Logs)
app.use((err, _req, res, _next) => {
  console.error('[express error]', err);
  res.status(500).json({ ok: false, error: String(err?.message || err) });
});

module.exports = app;
