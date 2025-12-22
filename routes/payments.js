const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../utils/requireAuth');
const { isValidPaymentMethod, normalizePaymentMethod, methodToBox } = require('../utils/paymentMethod');

const METHOD_OK = ['CASH', 'DEBIT', 'CREDIT', 'TRANSFER'];

async function reconcileTicket(conn, ticketId, actorUserId) {
  const [[t]] = await conn.query('SELECT * FROM Ticket WHERE id=? FOR UPDATE', [ticketId]);
  if (!t) throw new Error('Ticket no encontrado');

  // Only reconcile tickets with a frozen amount (checked out)
  if (t.amount == null) return { status: t.status, totalPaid: 0, balance: null };

  const [[{ totalPaid }]] = await conn.query(
    `SELECT COALESCE(SUM(amount),0) AS totalPaid FROM Payment WHERE ticketId=?`,
    [ticketId]
  );

  const due = Number(t.amount || 0);
  const paid = Number(totalPaid || 0);

  if (paid >= due) {
    await conn.query(
      `UPDATE Ticket SET status='CLOSED', closedBy=COALESCE(closedBy, ?) WHERE id=?`,
      [actorUserId, ticketId]
    );
    return { status: 'CLOSED', totalPaid: paid, balance: +(due - paid) };
  }

  await conn.query(
    `UPDATE Ticket SET status='PAYMENT_PENDING', closedBy=NULL WHERE id=?`,
    [ticketId]
  );

  return { status: 'PAYMENT_PENDING', totalPaid: paid, balance: +(due - paid) };
}

function validatePaymentInput(input) {
  const method = String(input?.method || '').toUpperCase();
  if (!METHOD_OK.includes(method) || !isValidPaymentMethod(method)) throw new Error('Método de pago inválido');

  const amount = Number(input?.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Importe inválido');

  let amountGiven = null;
  let changeAmt = null;

  if (method === 'CASH') {
    if (input?.amountGiven != null && input.amountGiven !== '') {
      amountGiven = Number(input.amountGiven);
      if (!Number.isFinite(amountGiven) || amountGiven < amount) {
        throw new Error('Importe recibido insuficiente');
      }
      changeAmt = +(amountGiven - amount);
    }
  }

  return {
    method,
    amount,
    amountGiven,
    changeAmt,
    externalId: input?.externalId || null,
    note: input?.note || null,
  };
}

// Create payment (generic). Prefer ticket-specific endpoints for checkout flow.
router.post('/', requireAuth(), async (req,res)=>{
  const { ticketId, subscriberId } = req.body || {};
  const userId = req.user?.id || null;

  let p;
  try {
    p = validatePaymentInput(req.body);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [r] = await conn.query(
      `INSERT INTO Payment (ticketId, subscriberId, method, amount, amountGiven, changeAmt, createdBy, externalId, note)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [ticketId ?? null, subscriberId ?? null, p.method, p.amount, p.amountGiven, p.changeAmt, userId, p.externalId, p.note]
    );

    let reconcile = null;
    if (ticketId) {
      reconcile = await reconcileTicket(conn, Number(ticketId), userId);
    }

    await conn.commit();

    const [[row0]] = await pool.query('SELECT * FROM Payment WHERE id=?', [r.insertId]);
    const row = row0 ? { ...row0, method: normalizePaymentMethod(row0.method) || row0.method } : row0;
    res.json({ ok:true, payment: row, ticket: reconcile });
  } catch (e) {
    await conn.rollback();
    console.error('[payments.create]', e);
    res.status(500).json({ error:'DB_ERROR' });
  } finally {
    conn.release();
  }
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
  if (method && method !== 'ALL') {
    const m = String(method).toUpperCase();
    if (m === 'TRANSFER') whereParts.push("p.method IN ('TRANSFER','MP')");
    else if (m === 'CREDIT') whereParts.push("p.method IN ('CREDIT','STRIPE')");
    else { whereParts.push('p.method = ?'); args.push(m); }
  }

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
      p.createdBy,
      u.name AS userName
    FROM Payment p
    LEFT JOIN Ticket     t ON t.id = p.ticketId
    LEFT JOIN Subscriber s ON s.id = p.subscriberId
    LEFT JOIN User       u ON u.id = p.createdBy
    WHERE ${where}
    ORDER BY p.createdAt DESC, p.id DESC
    LIMIT ? OFFSET ?
  `;

  const [rows] = await pool.query(sql, [...args, size, offset]);

  const data = rows.map(r => ({
    ...r,
    method: normalizePaymentMethod(r.method) || r.method,
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

  if (method && method !== 'ALL') {
    const m = String(method).toUpperCase();
    if (m === 'TRANSFER') whereParts.push("p.method IN ('TRANSFER','MP')");
    else if (m === 'CREDIT') whereParts.push("p.method IN ('CREDIT','STRIPE')");
    else { whereParts.push('p.method = ?'); args.push(m); }
  }

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
router.get('/export', requireAuth(['ADMIN','SUPERVISOR']), async (req, res) => {
  try {
    const { where, args } = buildPaymentsWhere(req);

    // Hard-limit de seguridad (evita dumps gigantes)
    const MAX_ROWS = 10000;

    const sql = `
      SELECT
        p.id, p.createdAt, p.method, p.amount, p.amountGiven, p.changeAmt, p.note,
        p.ticketId, t.plate AS ticketPlate,
        p.subscriberId, s.fullName AS subscriberName, s.plate AS subscriberPlate,
        p.createdBy,
        u.name AS userName
      FROM Payment p
      LEFT JOIN Ticket     t ON t.id = p.ticketId
      LEFT JOIN Subscriber s ON s.id = p.subscriberId
      LEFT JOIN User       u ON u.id = p.createdBy
      WHERE ${where}
      ORDER BY p.createdAt DESC, p.id DESC
      LIMIT ?
    `;

    const [rows] = await pool.query(sql, [...args, MAX_ROWS]);

    const truncated = (rows?.length || 0) >= MAX_ROWS;

    // CSV Excel-friendly
    // - BOM for UTF-8
    // - sep=; so Excel picks semicolon separator correctly
    const headers = [
      'ID','Fecha','Kind','Caja','Método','Monto','EfectivoNeto','Recibido','Vuelto',
      'TicketId','Patente','SubscriberId','Suscriptor','PatenteSub','UsuarioId','Usuario','Nota'
    ];

    const lines = ['sep=;'.trim(), headers.join(';')];

    for (const r of rows) {
      const kind = r.ticketId ? 'TICKET' : (r.subscriberId ? 'SUBSCRIPTION' : 'OTHER');
      const method = normalizePaymentMethod(r.method) || r.method;
      const box = methodToBox(method) || 'TRANSFER';

      const amount = Number(r.amount ?? 0) || 0;
      const amountGiven = r.amountGiven == null ? null : Number(r.amountGiven);
      const changeAmt = r.changeAmt == null ? null : Number(r.changeAmt);
      const cashNet = box === 'CASH'
        ? (Number.isFinite(amountGiven) ? amountGiven : amount) - (Number.isFinite(changeAmt) ? changeAmt : 0)
        : '';

      lines.push([
        csvEscape(r.id),
        csvEscape(r.createdAt?.toISOString?.() ? r.createdAt.toISOString() : r.createdAt),
        csvEscape(kind),
        csvEscape(box),
        csvEscape(method),
        csvEscape(amount),
        csvEscape(cashNet),
        csvEscape(amountGiven ?? ''),
        csvEscape(changeAmt ?? ''),
        csvEscape(r.ticketId ?? ''),
        csvEscape(r.ticketPlate ?? ''),
        csvEscape(r.subscriberId ?? ''),
        csvEscape(r.subscriberName ?? ''),
        csvEscape(r.subscriberPlate ?? ''),
        csvEscape(r.createdBy ?? ''),
        csvEscape(r.userName ?? ''),
        csvEscape(r.note ?? ''),
      ].join(';'));
    }

    const filename = `movimientos_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Max-Rows', String(MAX_ROWS));
    res.setHeader('X-Export-Truncated', truncated ? '1' : '0');

    const csv = '\ufeff' + lines.join('\n');
    res.send(csv);
  } catch (err) {
    console.error('[payments export]', err);
    res.status(500).json({ ok:false, error:'EXPORT_ERROR' });
  }
});

router.get('/by-ticket/:ticketId', requireAuth(), async (req, res) => {
  const ticketId = Number(req.params.ticketId);
  if (!ticketId) return res.status(400).json({ error: 'ticketId inválido' });

  const [rows0] = await pool.query(
    `SELECT
        p.id, p.ticketId, p.method, p.amount, p.amountGiven, p.changeAmt, p.externalId,
        p.createdAt, p.createdBy, p.note,
        u.name AS userName
       FROM Payment p
       LEFT JOIN User u ON u.id = p.createdBy
      WHERE p.ticketId = ?
      ORDER BY p.createdAt ASC, p.id ASC`,
    [ticketId]
  );

  const rows = (rows0 || []).map(r => ({
    ...r,
    method: normalizePaymentMethod(r.method) || r.method,
  }));

  res.json(rows);
});

// Edit a payment (used to fix operator mistakes)
router.put('/:id', requireAuth(), async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.user?.id || null;
  const role = req.user?.role || null;

  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[p0]] = await conn.query('SELECT * FROM Payment WHERE id=? FOR UPDATE', [id]);
    if (!p0) { await conn.rollback(); return res.status(404).json({ error: 'Pago no encontrado' }); }

    const canEdit = role === 'ADMIN' || role === 'SUPERVISOR' || (p0.createdBy != null && Number(p0.createdBy) === Number(userId));
    if (!canEdit) { await conn.rollback(); return res.status(403).json({ error: 'Forbidden' }); }

    let p;
    try {
      p = validatePaymentInput(req.body);
    } catch (e) {
      await conn.rollback();
      return res.status(400).json({ error: String(e.message || e) });
    }

    await conn.query(
      `UPDATE Payment
          SET method=?, amount=?, amountGiven=?, changeAmt=?, externalId=?, note=?
        WHERE id=?`,
      [p.method, p.amount, p.amountGiven, p.changeAmt, p.externalId, p.note, id]
    );

    let ticket = null;
    if (p0.ticketId) {
      ticket = await reconcileTicket(conn, Number(p0.ticketId), userId);
    }

    await conn.commit();

    const [[row0]] = await pool.query(
      `SELECT p.*, u.name AS userName
         FROM Payment p
         LEFT JOIN User u ON u.id = p.createdBy
        WHERE p.id=?`,
      [id]
    );

    const row = row0 ? { ...row0, method: normalizePaymentMethod(row0.method) || row0.method } : row0;

    return res.json({ ok: true, payment: row, ticket });
  } catch (e) {
    await conn.rollback();
    console.error('[payments.update]', e);
    return res.status(500).json({ error: 'DB_ERROR' });
  } finally {
    conn.release();
  }
});

// Delete a payment
router.delete('/:id', requireAuth(), async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.user?.id || null;
  const role = req.user?.role || null;

  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[p0]] = await conn.query('SELECT * FROM Payment WHERE id=? FOR UPDATE', [id]);
    if (!p0) { await conn.rollback(); return res.status(404).json({ error: 'Pago no encontrado' }); }

    const canEdit = role === 'ADMIN' || role === 'SUPERVISOR' || (p0.createdBy != null && Number(p0.createdBy) === Number(userId));
    if (!canEdit) { await conn.rollback(); return res.status(403).json({ error: 'Forbidden' }); }

    await conn.query('DELETE FROM Payment WHERE id=?', [id]);

    let ticket = null;
    if (p0.ticketId) {
      ticket = await reconcileTicket(conn, Number(p0.ticketId), userId);
    }

    await conn.commit();
    return res.json({ ok: true, deletedId: id, ticket });
  } catch (e) {
    await conn.rollback();
    console.error('[payments.delete]', e);
    return res.status(500).json({ error: 'DB_ERROR' });
  } finally {
    conn.release();
  }
});

module.exports = router;
