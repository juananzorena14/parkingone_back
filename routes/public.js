const router = require('express').Router();
const { pool } = require('../db');
const { calcAmount } = require('../utils/calcAmount'); // tu misma función de backend
const dayjs = require('dayjs');
const QRCode = require('qrcode');

// GET /public/tickets/:code/qr
// Devuelve PNG QR del código (para que el operador lo escanee)
router.get('/tickets/:code/qr', async (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).send('BAD_CODE');

  try {
    // Optionally validate ticket exists (avoid generating random codes)
    const [[t]] = await pool.query('SELECT id FROM Ticket WHERE entryCode=? LIMIT 1', [code]);
    if (!t) return res.status(404).send('NOT_FOUND');

    const png = await QRCode.toBuffer(code, { type: 'png', margin: 1, width: 320, errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(png);
  } catch (e) {
    console.error('[public qr]', e);
    return res.status(500).send('QR_ERROR');
  }
});

// GET /public/tickets/:code/summary
// Devuelve ticket + rateplan + settings + cálculo en vivo (amount/minutes)
router.get('/tickets/:code/summary', async (req, res) => {
  const code = req.params.code;

  // Traemos ticket + rateplan + settings (nombre, timezone opcional)
  const [[row]] = await pool.query(
    `SELECT 
        t.id, t.plate, t.vehicleType, t.checkInAt, t.status, t.entryCode,
        rp.id AS ratePlanId, rp.name AS rateName, rp.perHour, rp.per30min,
        rp.toleranceMin, rp.nightFlat, rp.nightStartsAt, rp.nightEndsAt, rp.currency
     FROM Ticket t
     JOIN RatePlan rp ON rp.id = t.ratePlanId
     WHERE t.entryCode = ?`,
    [code]
  );

  if (!row) return res.status(404).json({ error: 'Ticket no encontrado' });

  let parkingName = 'Estacionamiento';
  let tz = null;
  let phone = null;
  let direction = null;
  try {
    // DB schema uses Settings.parking_name
    const [[cfg]] = await pool.query(
      `SELECT parking_name AS name, timezone, phone, direction FROM Settings WHERE id=1`
    );
    if (cfg) {
      parkingName = cfg.name || parkingName;
      tz = cfg.timezone || tz;
      phone = cfg.phone || null;
      direction = cfg.direction || null;
    }
  } catch (_) {
    // Si las columnas no existen, ignoramos silenciosamente
  }

  // 3) Cálculo en vivo
  const now = new Date();

  // Igual que en checkout: diff('minute') es floor, usamos float + ceil
  const minutes = Math.max(1, Math.ceil(dayjs(now).diff(dayjs(row.checkInAt), 'minute', true)));
  const amount = calcAmount(minutes, row, now);

  res.json({
    ok: true,
    parking: { name: parkingName, timezone: tz, phone, direction },
    ticket: {
      id: row.id,
      plate: row.plate,
      vehicleType: row.vehicleType,
      checkInAt: row.checkInAt,
      status: row.status,
      entryCode: row.entryCode,
    },
    rateplan: {
      id: row.ratePlanId,
      name: row.rateName,
      perHour: row.perHour != null ? Number(row.perHour) : null,
      per30min: row.per30min != null ? Number(row.per30min) : null,
      toleranceMin: row.toleranceMin != null ? Number(row.toleranceMin) : 0,
      nightFlat: row.nightFlat != null ? Number(row.nightFlat) : null,
      nightStartsAt: row.nightStartsAt != null ? Number(row.nightStartsAt) : null,
      nightEndsAt: row.nightEndsAt != null ? Number(row.nightEndsAt) : null,
      currency: row.currency || 'ARS',
    },
    live: { minutes, amount: Number(amount || 0), at: now.toISOString() },
  });
});

module.exports = router;