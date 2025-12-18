const router = require('express').Router();
const { pool } = require('../db');
const { calcAmount } = require('../utils/calcAmount'); // tu misma función de backend
const dayjs = require('dayjs');

// GET /public/tickets/:code/summary
// Devuelve ticket + rateplan + settings + cálculo en vivo (amount/minutes)
router.get('/tickets/:code/summary', async (req, res) => {
  const code = req.params.code;

  // Traemos ticket + rateplan + settings (nombre, timezone opcional)
  const [[row]] = await pool.query(
    `SELECT 
        t.id, t.plate, t.vehicleType, t.checkInAt, t.status, t.entryCode,
        rp.id AS ratePlanId, rp.name AS rateName, rp.base, rp.perHour, rp.per15min,
        rp.toleranceMin, rp.nightFlat, rp.nightStartsAt, rp.nightEndsAt, rp.currency
     FROM Ticket t
     JOIN RatePlan rp ON rp.id = t.ratePlanId
     WHERE t.entryCode = ?`,
    [code]
  );

  if (!row) return res.status(404).json({ error: 'Ticket no encontrado' });

  let parkingName = 'Estacionamiento';
  let tz = null;
  try {
    const [[cfg]] = await pool.query(`SELECT name, timezone FROM Settings WHERE id=1`);
    if (cfg) {
      parkingName = cfg.name || parkingName;
      tz = cfg.timezone || tz;
    }
  } catch (_) {
    // Si las columnas no existen, ignoramos silenciosamente
  }

  // 3) Cálculo en vivo
  const now = new Date();
  const minutes = Math.max(1, dayjs(now).diff(dayjs(row.checkInAt), 'minute'));
  const amount = calcAmount(minutes, row, now);

  res.json({
    ok: true,
    parking: { name: parkingName, timezone: tz },
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
      base: Number(row.base || 0),
      perHour: row.perHour != null ? Number(row.perHour) : null,
      per15min: row.per15min != null ? Number(row.per15min) : null,
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