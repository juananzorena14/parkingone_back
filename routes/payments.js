const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../utils/requireAuth');
const { isValidPaymentMethod, normalizePaymentMethod, methodToBox } = require('../utils/paymentMethod');

const METHOD_OK = ['CASH', 'DEBIT', 'CREDIT', 'TRANSFER'];

const REVERSE_WINDOW_MIN = 5;

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

  // Pagos de tickets se registran exclusivamente en /tickets/:id/checkout.
  if (ticketId != null) {
    return res.status(400).json({ error: 'Los pagos de tickets se registran en el checkout del ticket.' });
  }

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

    await conn.commit();

    const [[row0]] = await pool.query('SELECT * FROM Payment WHERE id=?', [r.insertId]);
    const row = row0 ? { ...row0, method: normalizePaymentMethod(row0.method) || row0.method } : row0;
    res.json({ ok:true, payment: row });
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
      p.id, p.createdAt, p.method, p.amount, p.amountGiven, p.changeAmt, p.externalId, p.note,
      p.ticketId, t.plate AS ticketPlate,
      p.subscriberId, s.fullName AS subscriberName, s.plate AS subscriberPlate,
      p.createdBy,
      u.name AS userName,
      p.reversesPaymentId,
      p.reverseReason,
      rev.id AS reversalId
    FROM Payment p
    LEFT JOIN Payment    rev ON rev.reversesPaymentId = p.id
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
    isReversal: r.reversesPaymentId != null,
    isReversed: r.reversalId != null,
    reversalId: r.reversalId ?? null,
    reversesPaymentId: r.reversesPaymentId ?? null,
    reverseReason: r.reverseReason ?? null,
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
        p.id, p.createdAt, p.method, p.amount, p.amountGiven, p.changeAmt, p.externalId, p.note,
        p.ticketId, t.plate AS ticketPlate,
        p.subscriberId, s.fullName AS subscriberName, s.plate AS subscriberPlate,
        p.createdBy,
        u.name AS userName,
        p.reversesPaymentId,
        p.reverseReason,
        rev.id AS reversalId
      FROM Payment p
      LEFT JOIN Payment    rev ON rev.reversesPaymentId = p.id
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
      'EsReverso','ReversaPagoId','Reversado','ReversalId','MotivoReverso',
      'TicketId','Patente','SubscriberId','Suscriptor','PatenteSub','UsuarioId','Usuario','ExternalId','Nota'
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

      const isReversal = r.reversesPaymentId != null;
      const isReversed = r.reversalId != null;

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
        csvEscape(isReversal ? 1 : 0),
        csvEscape(r.reversesPaymentId ?? ''),
        csvEscape(isReversed ? 1 : 0),
        csvEscape(r.reversalId ?? ''),
        csvEscape(r.reverseReason ?? ''),
        csvEscape(r.ticketId ?? ''),
        csvEscape(r.ticketPlate ?? ''),
        csvEscape(r.subscriberId ?? ''),
        csvEscape(r.subscriberName ?? ''),
        csvEscape(r.subscriberPlate ?? ''),
        csvEscape(r.createdBy ?? ''),
        csvEscape(r.userName ?? ''),
        csvEscape(r.externalId ?? ''),
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
        p.reversesPaymentId, p.reverseReason,
        rev.id AS reversalId,
        u.name AS userName
       FROM Payment p
       LEFT JOIN Payment rev ON rev.reversesPaymentId = p.id
       LEFT JOIN User u ON u.id = p.createdBy
      WHERE p.ticketId = ?
      ORDER BY p.createdAt ASC, p.id ASC`,
    [ticketId]
  );

  const rows = (rows0 || []).map(r => ({
    ...r,
    method: normalizePaymentMethod(r.method) || r.method,
    isReversal: r.reversesPaymentId != null,
    isReversed: r.reversalId != null,
    reversalId: r.reversalId ?? null,
    reversesPaymentId: r.reversesPaymentId ?? null,
    reverseReason: r.reverseReason ?? null,
  }));

  res.json(rows);
});

// Reverse a payment (auditable: creates a new negative row linked to the original)
router.post('/:id/reverse', requireAuth(), async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.user?.id || null;
  const role = String(req.user?.role || '').toUpperCase();
  const reason = String(req.body?.reason || '').trim();

  if (!id) return res.status(400).json({ error: 'ID inválido' });
  if (!reason) return res.status(400).json({ error: 'Motivo requerido' });

  const isPrivileged = role === 'ADMIN' || role === 'SUPERVISOR';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[p0]] = await conn.query('SELECT * FROM Payment WHERE id=? FOR UPDATE', [id]);
    if (!p0) { await conn.rollback(); return res.status(404).json({ error: 'Pago no encontrado' }); }

    // No permitir reversar un reverso
    if (p0.reversesPaymentId != null) {
      await conn.rollback();
      return res.status(400).json({ error: 'Este pago ya es un reverso.' });
    }

    // Evitar doble reverso
    const [[rev0]] = await conn.query('SELECT id FROM Payment WHERE reversesPaymentId=? LIMIT 1 FOR UPDATE', [id]);
    if (rev0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Este pago ya fue reversado.' });
    }

    if (!isPrivileged) {
      // Operario: sólo si lo creó él
      if (p0.createdBy == null || Number(p0.createdBy) !== Number(userId)) {
        await conn.rollback();
        return res.status(403).json({ error: 'No podés reversar pagos de otro usuario.' });
      }

      // Debe existir turno abierto y el pago debe pertenecer a ese turno
      const [[shift]] = await conn.query(
        'SELECT id, openedAt FROM CashShift WHERE userId=? AND closedAt IS NULL ORDER BY openedAt DESC LIMIT 1',
        [userId]
      );
      if (!shift) {
        await conn.rollback();
        return res.status(403).json({ error: 'No tenés turno abierto.' });
      }

      const payAt = new Date(p0.createdAt).getTime();
      const shiftAt = new Date(shift.openedAt).getTime();
      if (!Number.isFinite(payAt) || payAt < shiftAt) {
        await conn.rollback();
        return res.status(403).json({ error: 'El pago no pertenece al turno actual.' });
      }

      // Ventana corta
      const ageMin = (Date.now() - payAt) / 60000;
      if (!Number.isFinite(ageMin) || ageMin > REVERSE_WINDOW_MIN) {
        await conn.rollback();
        return res.status(403).json({ error: `Solo podés reversar dentro de los ${REVERSE_WINDOW_MIN} minutos.` });
      }
    }

    const method = normalizePaymentMethod(p0.method) || String(p0.method || '').toUpperCase();
    if (!METHOD_OK.includes(method) || !isValidPaymentMethod(method)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Método de pago inválido' });
    }

    const originalAmount = Number(p0.amount);
    if (!Number.isFinite(originalAmount) || originalAmount <= 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'No se puede reversar este pago.' });
    }

    const note = `REVERSO de pago #${p0.id}: ${reason}`;

    const [r] = await conn.query(
      `INSERT INTO Payment (
        ticketId, subscriberId,
        reversesPaymentId, reverseReason,
        method, amount,
        amountGiven, changeAmt,
        createdBy, externalId, note
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        p0.ticketId ?? null,
        p0.subscriberId ?? null,
        p0.id,
        reason,
        method,
        -originalAmount,
        null,
        null,
        userId,
        p0.externalId ?? null,
        note,
      ]
    );

    await conn.commit();

    const [[orig]] = await pool.query('SELECT * FROM Payment WHERE id=?', [p0.id]);
    const [[rev]] = await pool.query('SELECT * FROM Payment WHERE id=?', [r.insertId]);

    return res.json({ ok: true, original: orig, reversal: rev });
  } catch (e) {
    await conn.rollback();
    console.error('[payments.reverse]', e);
    return res.status(500).json({ error: 'DB_ERROR' });
  } finally {
    conn.release();
  }
});

// Edit a payment (admin/supervisor: metadata only)
router.put('/:id', requireAuth(['ADMIN','SUPERVISOR']), async (req, res) => {
  const id = Number(req.params.id);

  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[p0]] = await conn.query('SELECT * FROM Payment WHERE id=? FOR UPDATE', [id]);
    if (!p0) { await conn.rollback(); return res.status(404).json({ error: 'Pago no encontrado' }); }

    // No editar reversos
    if (p0.reversesPaymentId != null) {
      await conn.rollback();
      return res.status(400).json({ error: 'No se puede editar un reverso.' });
    }

    // No permitir cambiar el monto via edit. (Para corregir monto: reverso + nuevo pago.)
    if (req.body?.amount != null && Number(req.body.amount) !== Number(p0.amount)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Para corregir el monto: reversar y registrar el pago correcto.' });
    }

    const method = String(req.body?.method || p0.method || '').toUpperCase();
    if (!METHOD_OK.includes(method) || !isValidPaymentMethod(method)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Método de pago inválido' });
    }

    const externalId = req.body?.externalId === '' ? null : (req.body?.externalId ?? p0.externalId ?? null);
    const note = req.body?.note === '' ? null : (req.body?.note ?? p0.note ?? null);

    // Si el método pasa a CASH, aseguramos campos consistentes
    let amountGiven = p0.amountGiven;
    let changeAmt = p0.changeAmt;
    if (method !== 'CASH') {
      amountGiven = null;
      changeAmt = null;
    } else {
      if (amountGiven == null) amountGiven = Number(p0.amount);
      if (changeAmt == null) changeAmt = 0;
    }

    await conn.query(
      `UPDATE Payment
          SET method=?, amountGiven=?, changeAmt=?, externalId=?, note=?
        WHERE id=?`,
      [method, amountGiven, changeAmt, externalId, note, id]
    );

    await conn.commit();

    const [[row0]] = await pool.query(
      `SELECT p.*, u.name AS userName
         FROM Payment p
         LEFT JOIN User u ON u.id = p.createdBy
        WHERE p.id=?`,
      [id]
    );

    const row = row0 ? { ...row0, method: normalizePaymentMethod(row0.method) || row0.method } : row0;

    return res.json({ ok: true, payment: row });
  } catch (e) {
    await conn.rollback();
    console.error('[payments.update]', e);
    return res.status(500).json({ error: 'DB_ERROR' });
  } finally {
    conn.release();
  }
});

// Delete disabled: keep audit trail (use reverse instead)
router.delete('/:id', requireAuth(['ADMIN','SUPERVISOR']), async (_req, res) => {
  return res.status(405).json({ error: 'No se permite eliminar pagos. Usá reversar.' });
});

module.exports = router;
