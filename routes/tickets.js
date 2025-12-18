const router = require('express').Router();
const { nanoid } = require('nanoid');
const { pool } = require('../db');
const { calcAmount } = require('../utils/calcAmount');
const { requireAuth } = require('../utils/requireAuth');
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

  // ¿Es abonado activo?
  const [[sub]] = await pool.query(`
  SELECT 
    s.id AS subscriberId,
    s.status,
    s.vehicleType AS subVehicleType,
    (
      SELECT MAX(x.nextDueDate)
      FROM Subscription x
      WHERE x.subscriberId = s.id
    ) AS nextDueDate
  FROM Subscriber s
  WHERE s.plate = ? AND s.status = 'ACTIVE'
  LIMIT 1
  `, [p]);

  if (sub) {
  const vtype = vehicleType || sub.subVehicleType || 'CAR'; // nunca null

  const [r] = await pool.query(
    `INSERT INTO Ticket (plate, vehicleType, ratePlanId, subscriberId, isSubscription, createdBy, checkInAt, entryCode, status)
     VALUES (?,?,?,?,?,?,?,?,'OPEN')`,
    [p, vtype, null, sub.subscriberId, 1, createdBy||null, checkInAt, entryCode]
  );

  // (opcional) calcular si está vencido
  const [[{ today }]] = await pool.query(`SELECT CURDATE() AS today`);
  const pastDue = sub.nextDueDate && sub.nextDueDate < today;

  const [[row]] = await pool.query(`SELECT * FROM Ticket WHERE id=?`, [r.insertId]);
  return res.json({ ok:true, data:{ ...row, isSubscription:1, subscriptionWarning: pastDue ? 'PAST_DUE' : null } });
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

router.post('/:id/checkout',requireAuth(), async (req,res)=>{
  const id = Number(req.params.id);               
  const {method, amountGiven} = req.body || {};
  const userId = req.user?.id || null;

  // Validación mínima
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const METHOD_OK = ['CASH', 'DEBIT', 'CREDIT', 'MP'];
  if (!METHOD_OK.includes(method)) {
    return res.status(400).json({ error: 'Método de pago inválido' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Ticket con lock
    const [[t]] = await conn.query('SELECT * FROM Ticket WHERE id=? FOR UPDATE',[id]);
    if (!t) { await conn.rollback(); return res.status(404).json({ error:'Ticket no encontrado' }); }
    if (t.status === 'CLOSED') { await conn.rollback(); return res.status(400).json({ error:'Ticket ya cerrado' }); }

    // después de leer Ticket t y validar status...
    if (t.isSubscription) {
      // cierra ticket con monto 0
      const now = new Date();
      const minutes = Math.max(1, Math.ceil((now - new Date(t.checkInAt))/60000));
      
      await conn.query(
        `UPDATE Ticket SET checkOutAt=?, minutes=?, amount=?, status='CLOSED' WHERE id=?`,
        [now, minutes, 0, userId, t.id]
      );
      // registra pago 0 para estadística (método SUBSCRIPTION)
      await conn.query(
        `INSERT INTO Payment (ticketId, method, amount, createdBy) VALUES (?,?,?,?)`,
        [t.id, 'SUBSCRIPTION', 0, userId]
      );

      await conn.commit();

      return res.json({
        ok:true,
        ticketId: t.id,
        amount: 0,
        minutes,
        method: 'SUBSCRIPTION',
        amountGiven: null,
        change: 0,
        closedAt: now.toISOString(),
        receiptCode: null
      });
    }

    // a2) Rate plan
    const [[rp]] = await conn.query('SELECT * FROM RatePlan WHERE id=?',[t.ratePlanId]);
    if (!rp) { await conn.rollback(); return res.status(400).json({ error:'RatePlan inválido' }); }

    // a3) Calcular monto
    const checkIn = dayjs(t.checkInAt);
    const checkOut = dayjs();
    const minutes = Math.max(1, checkOut.diff(checkIn,'minute'));
    const amount = calcAmount(minutes, rp, checkOut.toDate());

    // a4) Validar efectivo
    let given = null, changeAmt = null;
    if (method === 'CASH') {
      given = Number(amountGiven ?? 0);
      if (!Number.isFinite(given) || given < amount) {
        await conn.rollback();
        return res.status(400).json({ error:'Importe recibido insuficiente' });
      }
      changeAmt = +(given - amount);
    }

    // a5) Actualizar ticket
    await conn.query(
      `UPDATE Ticket
         SET checkOutAt=?, minutes=?, amount=?, status='CLOSED', closedBy=?
       WHERE id=?`,
      [checkOut.format('YYYY-MM-DD HH:mm:ss'), minutes, amount, userId, id]
    );

    // a6) Registrar pago (ahora con amountGiven y changeAmt)
    const [p] = await conn.query(
      `INSERT INTO Payment (ticketId, method, amount, amountGiven, changeAmt, createdBy)
       VALUES (?,?,?,?,?,?)`,
      [id, method, amount, given, changeAmt, userId]
    );

    await conn.commit();

    return res.json({
      ok: true,
      ticketId: id,
      amount,
      minutes,
      method,
      amountGiven: given,
      change: changeAmt ?? 0,
      paymentId: p.insertId,
      closedAt: checkOut.toISOString(),
    });
  }catch(e){
    await conn.rollback();
    console.error('[checkout error]', e);
    return res.status(500).json({ error:'Error en checkout' });
  }finally{
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

  const [payments] = await pool.query(
    `SELECT id, ticketId, method, amount, createdAt, createdBy, note
     FROM Payment
     WHERE ticketId=?
     ORDER BY createdAt ASC, id ASC`,
    [id]
  );

  res.json({ ticket, payments });
});

module.exports = router;
