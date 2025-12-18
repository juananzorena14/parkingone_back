const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../utils/requireAuth');

router.post('/', async (req,res)=>{
  const { ticketId, method, amount, createdBy, externalId } = req.body;
  const [r] = await pool.query(
    `INSERT INTO Payment (ticketId, method, amount, createdBy, externalId) VALUES (?,?,?,?,?)`,
    [ticketId, method, amount, createdBy||null, externalId||null]
  );
  const [row] = await pool.query('SELECT * FROM Payment WHERE id=?',[r.insertId]);
  res.json(row[0]);
});

router.get('/', requireAuth(['ADMIN','SUPERVISOR']), async (req, res) => {
  const {
    from,
    to,
    method = 'ALL',
    type = 'ALL',
    subscriberId = null,
  } = req.query;

  const page   = Math.max(1, parseInt(req.query.page || '1', 10));
  const size   = Math.min(100, Math.max(1, parseInt(req.query.size || '20', 10)));
  const offset = (page - 1) * size;

  const args = [];
  const whereParts = [];

  // Fechas (día completo)
  if (from) { whereParts.push('p.createdAt >= ?'); args.push(from + ' 00:00:00'); }
  if (to)   { whereParts.push('p.createdAt < DATE_ADD(?, INTERVAL 1 DAY)'); args.push(to); }

  // Método
  if (method && method !== 'ALL') { whereParts.push('p.method = ?'); args.push(method.toUpperCase()); }

  // Tipo
  if (type && type !== 'ALL') {
    if (type === 'TICKET')        whereParts.push('p.ticketId IS NOT NULL');
    else if (type === 'SUBSCRIPTION') whereParts.push('p.ticketId IS NULL AND p.subscriberId IS NOT NULL');
    else if (type === 'OTHER')    whereParts.push('p.ticketId IS NULL AND p.subscriberId IS NULL');
  }

  // Por abonado
  if (subscriberId) { whereParts.push('p.subscriberId = ?'); args.push(Number(subscriberId)); }

  // Si no hay filtros → 1=1
  const where = whereParts.length ? whereParts.join(' AND ') : '1=1';

  // COUNT
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM Payment p
      WHERE ${where}`,
    args
  );

  // SELECT
  const sql = `
    SELECT
      p.id, p.createdAt, p.method, p.amount, p.amountGiven, p.changeAmt, p.note,
      p.ticketId, t.plate AS ticketPlate,
      p.subscriberId, s.fullName AS subscriberName, s.plate AS subscriberPlate,
      p.createdBy
    FROM Payment p
    LEFT JOIN Ticket     t ON t.id = p.ticketId
    LEFT JOIN Subscriber s ON s.id = p.subscriberId
    -- ⚠️ si tu tabla User no tiene la columna que querés mostrar, no la traigas
    -- LEFT JOIN User u ON u.id = p.createdBy
    WHERE ${where}
    ORDER BY p.createdAt DESC, p.id DESC
    LIMIT ? OFFSET ?
  `;

  const [rows] = await pool.query(sql, [...args, size, offset]);

  const data = rows.map(r => ({
    ...r,
    kind: r.ticketId ? 'TICKET' : (r.subscriberId ? 'SUBSCRIPTION' : 'OTHER'),
    ref:  r.ticketId
          ? `#${r.ticketId} ${r.ticketPlate || ''}`.trim()
          : (r.subscriberId
              ? `${r.subscriberName || ''} (${r.subscriberPlate || ''})`.trim()
              : (r.note || '-')),
  }));

  res.json({ ok: true, data, total, page, size });
});

// utils locales (mismo archivo o en un helper)
function buildPaymentsWhere(req) {
  const { from, to, method = 'ALL', type = 'ALL', subscriberId = null } = req.query;
  const whereParts = [];
  const args = [];

  if (from) { whereParts.push('p.createdAt >= ?'); args.push(from + ' 00:00:00'); }
  if (to)   { whereParts.push('p.createdAt < DATE_ADD(?, INTERVAL 1 DAY)'); args.push(to); }

  if (method && method !== 'ALL') { whereParts.push('p.method = ?'); args.push(method.toUpperCase()); }

  if (type && type !== 'ALL') {
    if (type === 'TICKET')          whereParts.push('p.ticketId IS NOT NULL');
    else if (type === 'SUBSCRIPTION') whereParts.push('p.ticketId IS NULL AND p.subscriberId IS NOT NULL');
    else if (type === 'OTHER')      whereParts.push('p.ticketId IS NULL AND p.subscriberId IS NULL');
  }

  if (subscriberId) { whereParts.push('p.subscriberId = ?'); args.push(Number(subscriberId)); }

  return { where: whereParts.length ? whereParts.join(' AND ') : '1=1', args };
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  const needsQuotes = /[",;\n]/.test(s);
  const body = s.replace(/"/g, '""');
  return needsQuotes ? `"${body}"` : body;
}

// GET /payments/export?from&to&method&type&subscriberId
router.get('/export', requireAuth.optional(['ADMIN','SUPERVISOR']), async (req, res) => {
  try {
    const { where, args } = buildPaymentsWhere(req);

    // Hard-limit de seguridad (evita dumps gigantes)
    const MAX_ROWS = 10000;

    const sql = `
      SELECT
        p.id, p.createdAt, p.method, p.amount, p.amountGiven, p.changeAmt, p.note,
        p.ticketId, t.plate AS ticketPlate,
        p.subscriberId, s.fullName AS subscriberName, s.plate AS subscriberPlate,
        p.createdBy
      FROM Payment p
      LEFT JOIN Ticket     t ON t.id = p.ticketId
      LEFT JOIN Subscriber s ON s.id = p.subscriberId
      WHERE ${where}
      ORDER BY p.createdAt DESC, p.id DESC
      LIMIT ?
    `;

    const [rows] = await pool.query(sql, [...args, MAX_ROWS]);

    // Armar CSV
    const headers = [
      'ID','Fecha','Tipo','Método','Monto','Recibido','Vuelto','TicketId','Patente','SubscriberId','Suscriptor','PatenteSub','Usuario','Nota'
    ];
    const lines = [headers.join(';')];

    for (const r of rows) {
      const kind = r.ticketId ? 'TICKET' : (r.subscriberId ? 'SUBSCRIPTION' : 'OTHER');
      lines.push([
        csvEscape(r.id),
        csvEscape(r.createdAt?.toISOString?.() ? r.createdAt.toISOString() : r.createdAt),
        csvEscape(kind),
        csvEscape(r.method),
        csvEscape(r.amount ?? 0),
        csvEscape(r.amountGiven ?? ''),
        csvEscape(r.changeAmt ?? ''),
        csvEscape(r.ticketId ?? ''),
        csvEscape(r.ticketPlate ?? ''),
        csvEscape(r.subscriberId ?? ''),
        csvEscape(r.subscriberName ?? ''),
        csvEscape(r.subscriberPlate ?? ''),
        csvEscape(r.createdBy ?? ''),
        csvEscape(r.note ?? ''),
      ].join(';'));
    }

    const filename = `movimientos_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[payments export]', err);
    res.status(500).json({ ok:false, error:'EXPORT_ERROR' });
  }
});

router.get('/by-ticket/:ticketId', requireAuth(), async (req, res) => {
  const ticketId = Number(req.params.ticketId);
  if (!ticketId) return res.status(400).json({ error: 'ticketId inválido' });

  const [rows] = await pool.query(
    `SELECT id, ticketId, method, amount, amountGiven, changeAmt, createdAt, createdBy, note
       FROM Payment
      WHERE ticketId = ?
      ORDER BY createdAt ASC, id ASC`,
    [ticketId]
  );
  res.json(rows);
});


module.exports = router;
