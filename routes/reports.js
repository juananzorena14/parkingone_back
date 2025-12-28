const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../utils/requireAuth');

// ---------- helpers de fecha ----------
function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildRange(query) {
  const from = (query.from || ymd()).trim();
  const to = (query.to || from).trim();
  const method = (query.method || 'ALL').toUpperCase();
  // rangos cerrados por día
  const fromStart = `${from} 00:00:00`;
  const toEnd = `${to} 23:59:59`;
  return { from, to, fromStart, toEnd, method };
}

// =========================
//      REPORTES CORE
// =========================

// Ocupación: abierta a cualquier usuario autenticado
router.get('/occupancy', requireAuth(), async (_req, res) => {
  const [[open]] = await pool.query(`SELECT COUNT(*) AS openTickets FROM Ticket WHERE status='OPEN'`);
  const [[cfg]] = await pool.query(`SELECT total_spots FROM Settings WHERE id=1`);
  const occupied = open.openTickets;
  const total = cfg?.total_spots || 0;
  res.json({ total, occupied, free: Math.max(0, total - occupied), rate: total ? occupied / total : 0 });
});

// Ingresos simples (compat) — usa createdAt y roles altos
router.get('/revenue', requireAuth(['ADMIN', 'SUPERVISOR']), async (req, res) => {
  const { fromStart, toEnd } = buildRange(req.query);
  const [rows] = await pool.query(
    `SELECT
        CASE
          WHEN method='MP' THEN 'TRANSFER'
          WHEN method='STRIPE' THEN 'CREDIT'
          ELSE method
        END AS method,
        SUM(amount) AS total
       FROM Payment
      WHERE createdAt BETWEEN ? AND ?
      GROUP BY 1
      ORDER BY total DESC`,
    [fromStart, toEnd]
  );
  res.json(rows);
});

// =========================
//   ENDPOINTS PARA FRONT
// =========================

// 1) Resumen de pagos (total, cantidad, promedios)
router.get('/payments/summary', requireAuth(['ADMIN', 'SUPERVISOR']), async (req, res) => {
  const { fromStart, toEnd, method } = buildRange(req.query);

  // Filtro por método (compat: MP->TRANSFER, STRIPE->CREDIT)
  let methodWhere = '1=1';
  const methodArgs = [];
  if (method !== 'ALL') {
    if (method === 'TRANSFER') methodWhere = "p.method IN ('TRANSFER','MP')";
    else if (method === 'CREDIT') methodWhere = "p.method IN ('CREDIT','STRIPE')";
    else { methodWhere = 'p.method = ?'; methodArgs.push(method); }
  }

  // Totales deben ser netos (incluye reversos), pero los conteos no deben inflarse.
  // - total: SUM(amount) incluyendo reversos
  // - tickets: DISTINCT ticketId solo de pagos NO reverso
  // - avgMinutes: promedio de Ticket.minutes para tickets con al menos 1 pago NO reverso
  const [rows] = await pool.query(
    `
    SELECT
      -- Total neto (incluye reversos)
      (
        SELECT COALESCE(SUM(p.amount),0)
          FROM Payment p
         WHERE p.ticketId IS NOT NULL
           AND p.createdAt BETWEEN ? AND ?
           AND ${methodWhere}
      ) AS total,

      -- Tickets (sin inflar por reversos)
      (
        SELECT COUNT(DISTINCT p.ticketId)
          FROM Payment p
         WHERE p.ticketId IS NOT NULL
           AND p.reversesPaymentId IS NULL
           AND p.createdAt BETWEEN ? AND ?
           AND ${methodWhere}
      ) AS tickets,

      -- Promedio de minutos por ticket (solo tickets con pago no reverso)
      (
        SELECT COALESCE(AVG(t.minutes),0)
          FROM Ticket t
          JOIN (
            SELECT DISTINCT p.ticketId
              FROM Payment p
             WHERE p.ticketId IS NOT NULL
               AND p.reversesPaymentId IS NULL
               AND p.createdAt BETWEEN ? AND ?
               AND ${methodWhere}
          ) x ON x.ticketId = t.id
      ) AS avgMinutes
    `,
    [
      fromStart, toEnd, ...methodArgs,
      fromStart, toEnd, ...methodArgs,
      fromStart, toEnd, ...methodArgs,
    ]
  );

  const r = rows[0] || { total: 0, tickets: 0, avgMinutes: 0 };
  const total = Number(r.total || 0);
  const count = Number(r.tickets || 0);

  res.json({
    total,
    count,
    avgTicket: count ? (total / count) : 0,
    avgMinutes: Number(r.avgMinutes || 0),
  });
});

// 2) Totales por método en el rango
router.get('/payments/by-method', requireAuth(['ADMIN', 'SUPERVISOR']), async (req, res) => {
  const { fromStart, toEnd } = buildRange(req.query);
  const [rows] = await pool.query(
    `
    SELECT
      CASE
        WHEN p.method='MP' THEN 'TRANSFER'
        WHEN p.method='STRIPE' THEN 'CREDIT'
        ELSE p.method
      END AS method,
      COUNT(CASE WHEN p.reversesPaymentId IS NULL THEN 1 END) AS count,
      COALESCE(SUM(p.amount), 0) AS total
    FROM Payment p
    WHERE p.createdAt BETWEEN ? AND ?
    GROUP BY 1
    ORDER BY total DESC
    `,
    [fromStart, toEnd]
  );
  // asegurar números puros
  const data = rows.map(r => ({
    method: r.method,
    count: Number(r.count || 0),
    total: Number(r.total || 0),
  }));
  res.json(data);
});

// 3) Evolución diaria (total por día dentro del rango)
router.get('/payments/daily', requireAuth(['ADMIN', 'SUPERVISOR']), async (req, res) => {
  const { fromStart, toEnd, method } = buildRange(req.query);

  // Filtro por método (compat: MP->TRANSFER, STRIPE->CREDIT)
  let methodWhere = '1=1';
  const methodArgs = [];
  if (method !== 'ALL') {
    if (method === 'TRANSFER') methodWhere = "p.method IN ('TRANSFER','MP')";
    else if (method === 'CREDIT') methodWhere = "p.method IN ('CREDIT','STRIPE')";
    else { methodWhere = 'p.method = ?'; methodArgs.push(method); }
  }

  const [rows] = await pool.query(
    `
    SELECT DATE(p.createdAt) AS date,
           COALESCE(SUM(p.amount), 0) AS total,
           COUNT(CASE WHEN p.reversesPaymentId IS NULL THEN 1 END) AS count
    FROM Payment p
    WHERE p.createdAt BETWEEN ? AND ?
      AND ${methodWhere}
    GROUP BY DATE(p.createdAt)
    ORDER BY DATE(p.createdAt)
    `,
    [fromStart, toEnd, ...methodArgs]
  );
  const data = rows.map(r => ({
    date: r.date,                             // 'YYYY-MM-DD'
    total: Number(r.total || 0),
    count: Number(r.count || 0),
  }));
  res.json(data);
});

module.exports = router;
