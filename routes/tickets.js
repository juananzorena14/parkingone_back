const router = require('express').Router();
const { nanoid } = require('nanoid');
const { pool } = require('../db');
const { calcAmount } = require('../utils/calcAmount');
const { requireAuth } = require('../utils/requireAuth');
const { isValidPaymentMethod, normalizePaymentMethod } = require('../utils/paymentMethod');
const dayjs = require("dayjs");

function normPlate(p){ return (p||'').trim().toUpperCase().replace(/\s+/g,''); }

router.get('/',requireAuth(), async (req,res)=>{
  const { status } = req.query;
  let sql = 'SELECT * FROM Ticket';
  const args = [];
  if (status) { sql += ' WHERE status=?'; args.push(status); }
  sql += ' ORDER BY id DESC LIMIT 200';
  const [rows] = await pool.query(sql, args);
  res.json(rows);
});

router.post('/',requireAuth(), async (req,res)=>{
  const { plate, vehicleType, ratePlanId, createdBy } = req.body;
  const p = normPlate(plate);
  const checkInAt = new Date();
  const entryCode = "T" + nanoid(10); 

  // ¿Es abonado? (traemos última suscripción para decidir si está al día)
  const [[sub]] = await pool.query(
    `SELECT
      s.id AS subscriberId,
      s.status,
      s.vehicleType AS subVehicleType,
      ss.nextDueDate,
      ss.status AS subStatus
     FROM Subscriber s
     LEFT JOIN Subscription ss
       ON ss.id = (
         SELECT id
           FROM Subscription
          WHERE subscriberId = s.id
          ORDER BY nextDueDate DESC, id DESC
          LIMIT 1
       )
     WHERE s.plate = ? AND s.status = 'ACTIVE'
     LIMIT 1`,
    [p]
  );

  if (sub) {
    const vtype = vehicleType || sub.subVehicleType || 'CAR'; // nunca null

    const [[{ today }]] = await pool.query(`SELECT CURDATE() AS today`);
    const pastDue = (!sub.nextDueDate || sub.subStatus !== 'ACTIVE' || sub.nextDueDate < today);

    // Regla: si está vencido, permite ingreso pero cobra normal => ticket NO es suscripción
    const isSubscription = pastDue ? 0 : 1;

    // Si vence, debe venir ratePlanId para cobrar normal
    const rpId = pastDue ? (ratePlanId || null) : null;
    if (pastDue && !rpId) {
      return res.status(400).json({ error: 'Abonado vencido: se requiere ratePlanId para cobrar normal.' });
    }

    const [r] = await pool.query(
      `INSERT INTO Ticket (plate, vehicleType, ratePlanId, subscriberId, isSubscription, createdBy, checkInAt, entryCode, status)
       VALUES (?,?,?,?,?,?,?,?,'OPEN')`,
      [p, vtype, rpId, sub.subscriberId, isSubscription, createdBy||null, checkInAt, entryCode]
    );

    const [[row]] = await pool.query(`SELECT * FROM Ticket WHERE id=?`, [r.insertId]);
    return res.json({
      ok:true,
      data:{
        ...row,
        isSubscription,
        subscriptionWarning: pastDue ? 'PAST_DUE' : null
      }
    });
  }

  // No abonado → flujo normal (usa RatePlan)
  const [r] = await pool.query(
    `INSERT INTO Ticket (plate, vehicleType, ratePlanId, createdBy, checkInAt, entryCode, status) VALUES (?,?,?,?,?,?, "OPEN")`,
    [plate, vehicleType || "CAR", ratePlanId, createdBy||null, checkInAt, entryCode]
  );
  
  const [[ticket]] = await pool.query(
    `SELECT t.*, rp.name AS rateName, rp.perHour, rp.per30min, rp.toleranceMin, rp.nightFlat, rp.nightStartsAt, rp.nightEndsAt
     FROM Ticket t JOIN RatePlan rp ON rp.id=t.ratePlanId WHERE t.id=?`, [r.insertId]
  );

  res.json(ticket);
});

router.post('/:id/checkout', requireAuth(), async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const userId = req.user?.id || null;

  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const METHOD_OK = ['CASH', 'DEBIT', 'CREDIT', 'TRANSFER'];

  function normalizePayments(input, amountDue) {
    // New format: payments: [{ method, amount, amountGiven?, externalId?, note? }]
    if (Array.isArray(input?.payments) && input.payments.length) {
      return input.payments;
    }

    // Back-compat: { method, amountGiven } assumes full payment.
    if (input?.method) {
      const method = String(input.method || '').toUpperCase();
      if (!METHOD_OK.includes(method) || !isValidPaymentMethod(method)) throw new Error('Método de pago inválido');
      const p = { method, amount: Number(amountDue) };
      if (method === 'CASH') p.amountGiven = input.amountGiven;
      return [p];
    }

    throw new Error('Debe enviar payments[] o method');
  }

  function validateAndPreparePayment(p) {
    const method = String(p?.method || '').toUpperCase();
    if (!METHOD_OK.includes(method) || !isValidPaymentMethod(method)) throw new Error('Método de pago inválido');

    const amount = Number(p?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Importe inválido');

    let amountGiven = null;
    let changeAmt = null;

    if (method === 'CASH') {
      if (p?.amountGiven != null && p.amountGiven !== '') {
        amountGiven = Number(p.amountGiven);
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
      externalId: p?.externalId || null,
      note: p?.note || null,
    };
  }

  async function reconcileTicket(conn, ticketId, actorUserId) {
    const [[t2]] = await conn.query('SELECT * FROM Ticket WHERE id=? FOR UPDATE', [ticketId]);
    if (!t2) throw new Error('Ticket no encontrado');

    const [[{ totalPaid }]] = await conn.query(
      `SELECT COALESCE(SUM(amount),0) AS totalPaid FROM Payment WHERE ticketId=?`,
      [ticketId]
    );

    const due = Number(t2.amount || 0);
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

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[t]] = await conn.query('SELECT * FROM Ticket WHERE id=? FOR UPDATE', [id]);
    if (!t) { await conn.rollback(); return res.status(404).json({ error: 'Ticket no encontrado' }); }
    if (t.status === 'CLOSED') { await conn.rollback(); return res.status(400).json({ error: 'Ticket ya cerrado' }); }

    // Subscription tickets: always close with amount 0 (no Payment row)
    if (t.isSubscription) {
      const now = new Date();
      const minutes = Math.max(1, Math.ceil((now - new Date(t.checkInAt)) / 60000));

      await conn.query(
        `UPDATE Ticket
            SET checkOutAt=?, minutes=?, amount=?, status='CLOSED', closedBy=?
          WHERE id=?`,
        [now, minutes, 0, userId, t.id]
      );

      await conn.commit();
      return res.json({
        ok: true,
        ticketId: t.id,
        amount: 0,
        minutes,
        status: 'CLOSED',
        totalPaid: 0,
        balance: 0,
        closedAt: now.toISOString(),
      });
    }

    // Only allow initial checkout from OPEN. Further payments must use POST /tickets/:id/payments.
    if (t.status !== 'OPEN') {
      await conn.rollback();
      return res.status(400).json({ error: 'Ticket ya está en checkout. Usá pagos adicionales para completar.' });
    }

    const [[rp]] = await conn.query('SELECT * FROM RatePlan WHERE id=?', [t.ratePlanId]);
    if (!rp) { await conn.rollback(); return res.status(400).json({ error: 'RatePlan inválido' }); }

    const checkIn = dayjs(t.checkInAt);
    const checkOut = dayjs();

    // Importante: dayjs.diff(..., 'minute') redondea hacia abajo.
    // Para que "pasada la tolerancia" se cobre correctamente, usamos diff en float + ceil.
    const minutes = Math.max(1, Math.ceil(checkOut.diff(checkIn, 'minute', true)));
    const amountDue = Number(calcAmount(minutes, rp, checkOut.toDate()) || 0);

    // Freeze checkout time/amount
    await conn.query(
      `UPDATE Ticket
         SET checkOutAt=?, minutes=?, amount=?
       WHERE id=?`,
      [checkOut.format('YYYY-MM-DD HH:mm:ss'), minutes, amountDue, id]
    );

    // If amountDue is 0, close without payments
    if (amountDue <= 0) {
      await conn.query(
        `UPDATE Ticket SET status='CLOSED', closedBy=? WHERE id=?`,
        [userId, id]
      );
      await conn.commit();
      return res.json({
        ok: true,
        ticketId: id,
        amount: amountDue,
        minutes,
        status: 'CLOSED',
        totalPaid: 0,
        balance: 0,
        closedAt: checkOut.toISOString(),
      });
    }

    let payLines;
    try {
      payLines = normalizePayments(body, amountDue).map(validateAndPreparePayment);
    } catch (e) {
      await conn.rollback();
      return res.status(400).json({ error: String(e.message || e) });
    }

    const totalPayThisRequest = payLines.reduce((s, p) => s + Number(p.amount || 0), 0);
    if (!Number.isFinite(totalPayThisRequest) || totalPayThisRequest <= 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Debe registrar al menos un pago.' });
    }

    // Insert all payments
    const paymentIds = [];
    for (const p of payLines) {
      const [r] = await conn.query(
        `INSERT INTO Payment (ticketId, method, amount, amountGiven, changeAmt, externalId, createdBy, note)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, p.method, p.amount, p.amountGiven, p.changeAmt, p.externalId, userId, p.note]
      );
      paymentIds.push(r.insertId);
    }

    const r = await reconcileTicket(conn, id, userId);

    await conn.commit();

    return res.json({
      ok: true,
      ticketId: id,
      amount: amountDue,
      minutes,
      status: r.status,
      totalPaid: r.totalPaid,
      balance: r.balance,
      paymentIds,
      checkedOutAt: checkOut.toISOString(),
    });
  } catch (e) {
    await conn.rollback();
    console.error('[checkout error]', e);
    return res.status(500).json({ error: 'Error en checkout' });
  } finally {
    conn.release();
  }
});

// Agregar pagos a un ticket ya checkouteado (PAYMENT_PENDING)
router.post('/:id/payments', requireAuth(), async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const userId = req.user?.id || null;

  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const METHOD_OK = ['CASH', 'DEBIT', 'CREDIT', 'TRANSFER'];

  function validateAndPreparePayment(p) {
    const method = String(p?.method || '').toUpperCase();
    if (!METHOD_OK.includes(method) || !isValidPaymentMethod(method)) throw new Error('Método de pago inválido');

    const amount = Number(p?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Importe inválido');

    let amountGiven = null;
    let changeAmt = null;

    if (method === 'CASH') {
      if (p?.amountGiven != null && p.amountGiven !== '') {
        amountGiven = Number(p.amountGiven);
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
      externalId: p?.externalId || null,
      note: p?.note || null,
    };
  }

  async function reconcileTicket(conn, ticketId, actorUserId) {
    const [[t2]] = await conn.query('SELECT * FROM Ticket WHERE id=? FOR UPDATE', [ticketId]);
    if (!t2) throw new Error('Ticket no encontrado');

    const [[{ totalPaid }]] = await conn.query(
      `SELECT COALESCE(SUM(amount),0) AS totalPaid FROM Payment WHERE ticketId=?`,
      [ticketId]
    );

    const due = Number(t2.amount || 0);
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

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[t]] = await conn.query('SELECT * FROM Ticket WHERE id=? FOR UPDATE', [id]);
    if (!t) { await conn.rollback(); return res.status(404).json({ error: 'Ticket no encontrado' }); }
    if (t.status === 'CLOSED') { await conn.rollback(); return res.status(400).json({ error: 'Ticket ya cerrado' }); }
    if (t.status !== 'PAYMENT_PENDING') {
      await conn.rollback();
      return res.status(400).json({ error: 'El ticket no está pendiente de pago.' });
    }

    if (!t.checkOutAt || t.amount == null) {
      await conn.rollback();
      return res.status(400).json({ error: 'El ticket no tiene checkout registrado.' });
    }

    let p;
    try {
      p = validateAndPreparePayment(body);
    } catch (e) {
      await conn.rollback();
      return res.status(400).json({ error: String(e.message || e) });
    }

    const [r] = await conn.query(
      `INSERT INTO Payment (ticketId, method, amount, amountGiven, changeAmt, externalId, createdBy, note)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, p.method, p.amount, p.amountGiven, p.changeAmt, p.externalId, userId, p.note]
    );

    const rr = await reconcileTicket(conn, id, userId);

    await conn.commit();
    return res.json({
      ok: true,
      ticketId: id,
      paymentId: r.insertId,
      status: rr.status,
      totalPaid: rr.totalPaid,
      balance: rr.balance,
    });
  } catch (e) {
    await conn.rollback();
    console.error('[add payment error]', e);
    return res.status(500).json({ error: 'Error agregando pago' });
  } finally {
    conn.release();
  }
});

router.get("/verify/:code", async (req,res) => {
  const code = req.params.code;
  const [[t]] = await pool.query(
    `SELECT t.id, t.plate, t.vehicleType, t.checkInAt, t.status,
      rp.name AS rateName, rp.perHour, rp.per30min, 
      rp.toleranceMin, rp.nightFlat, rp.nightStartsAt, rp.nightEndsAt
      FROM Ticket t 
      LEFT JOIN RatePlan rp ON rp.id=t.ratePlanId
      WHERE t.entryCode=?`, [code]
  );
  if (!t) return res.status(404).json({ error:'Ticket no encontrado' });
  res.json({ ok:true, ticket:t });
})

router.get("/shift", requireAuth(), async (req, res) => {
  const q     = (req.query.q || '').trim();
  const page  = Math.max(1, parseInt(req.query.page||'1',10));
  const size  = Math.min(100, Math.max(1, parseInt(req.query.size||'20',10)));
  const dir   = (String(req.query.dir||'DESC').toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
  const status = (req.query.status || '').trim().toUpperCase(); // OPEN/CLOSED/VOID opcional

  const SORTS = {
    id: 'id',
    checkInAt: 'checkInAt',
    checkOutAt: 'checkOutAt',
    plate: 'plate',
    vehicleType: 'vehicleType',
    balance: 'balance',
    ticketTotal: 'ticketTotal',
    totalPaid: 'totalPaid',
    lastPaymentAt: 'lastPaymentAt'
  };
  const sortCol = SORTS[req.query.sort] || 'checkInAt';
  const offset  = (page-1)*size;

  const where = [];
  const params = [];

  if (q) { where.push('plate LIKE ?'); params.push(`%${q}%`); }
  if (status) { where.push('status = ?'); params.push(status); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT * FROM v_ticket_summary
     ${clause}
     ORDER BY ${sortCol} ${dir}
     LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );

  res.json(rows);
});

router.get('/shift/:id', requireAuth(), async (req, res) => {
  const id = Number(req.params.id);

  const [[ticket]] = await pool.query('SELECT * FROM v_ticket_summary WHERE id=?', [id]);
  if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

  const [payments0] = await pool.query(
    `SELECT
        p.id, p.ticketId, p.method, p.amount, p.amountGiven, p.changeAmt, p.externalId,
        p.createdAt, p.createdBy, p.note,
        u.name AS userName
     FROM Payment p
     LEFT JOIN User u ON u.id = p.createdBy
     WHERE p.ticketId=?
     ORDER BY p.createdAt ASC, p.id ASC`,
    [id]
  );

  const payments = (payments0 || []).map(p => ({
    ...p,
    method: normalizePaymentMethod(p.method) || p.method,
  }));

  res.json({ ticket, payments });
});

module.exports = router;
