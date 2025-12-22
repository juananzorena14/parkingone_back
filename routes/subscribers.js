const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../utils/requireAuth');
const { isValidPaymentMethod } = require('../utils/paymentMethod');

// Normaliza patentes (ABC123 / AB123CD)
function normPlate(p){ return (p||'').trim().toUpperCase().replace(/\s+/g,''); }

// LIST
router.get('/', requireAuth(['ADMIN','SUPERVISOR']), async (req, res) => {
  const q    = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page||'1',10));
  const size = Math.min(100, Math.max(1, parseInt(req.query.size||'20',10)));
  const dir  = (String(req.query.dir||'DESC').toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

  // whitelist de columnas ordenables para evitar SQL injection
  const SORTS = { id:'s.id', createdAt:'s.createdAt', plate:'s.plate', fullName:'s.fullName' };
  const sortCol = SORTS[req.query.sort] || 's.createdAt';
  const offset  = (page-1)*size;

  const params = [];
  let where = 'WHERE s.status = "ACTIVE"';

  // ✅ asignar WHERE cuando hay q
  if (q) {
    where = 'WHERE s.plate LIKE ? OR s.fullName LIKE ?';
    params.push(`%${q}%`, `%${q}%`);
  }

  // COUNT con el mismo WHERE
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM Subscriber s ${where}`,
    params
  );

  // SELECT paginado + ordenado
  const sql = `
    SELECT 
      s.id,
      s.fullName,
      s.plate,
      s.vehicleType,
      s.status,
      s.createdAt,

      /* Última suscripción (campos individuales) */
      (SELECT sub.planName
         FROM Subscription sub
        WHERE sub.subscriberId = s.id
        ORDER BY sub.nextDueDate DESC, sub.id DESC
        LIMIT 1) AS planName,

      (SELECT sub.priceMonthly
         FROM Subscription sub
        WHERE sub.subscriberId = s.id
        ORDER BY sub.nextDueDate DESC, sub.id DESC
        LIMIT 1) AS priceMonthly,

      (SELECT sub.nextDueDate
         FROM Subscription sub
        WHERE sub.subscriberId = s.id
        ORDER BY sub.nextDueDate DESC, sub.id DESC
        LIMIT 1) AS nextDueDate,

      /* Vencido: si nextDueDate es NULL o < hoy => Debe */
      CASE 
        WHEN (
          (SELECT sub.nextDueDate
             FROM Subscription sub
            WHERE sub.subscriberId = s.id
            ORDER BY sub.nextDueDate DESC, sub.id DESC
            LIMIT 1
          ) IS NULL
        ) THEN 1
        WHEN (
          (SELECT sub.nextDueDate
             FROM Subscription sub
            WHERE sub.subscriberId = s.id
            ORDER BY sub.nextDueDate DESC, sub.id DESC
            LIMIT 1
          ) < CURDATE()
        ) THEN 1
        ELSE 0
      END AS isDue,

      CASE 
        WHEN (
          (SELECT sub.nextDueDate
             FROM Subscription sub
            WHERE sub.subscriberId = s.id
            ORDER BY sub.nextDueDate DESC, sub.id DESC
            LIMIT 1
          ) IS NULL
          OR
          (SELECT sub.nextDueDate
             FROM Subscription sub
            WHERE sub.subscriberId = s.id
            ORDER BY sub.nextDueDate DESC, sub.id DESC
            LIMIT 1
          ) < CURDATE()
        ) THEN 'Debe'
        ELSE 'Al día'
      END AS statusText

    FROM Subscriber s
    ${where}
    ORDER BY ${sortCol} ${dir}
    LIMIT ? OFFSET ?
  `;

  const [rows] = await pool.query(sql, [...params, size, offset]);

  // 👉 respuesta estándar para paginación
  res.json({ ok:true, data: rows, total, page, size });
});


// LOOKUP por patente (para Check-in)
router.get('/lookup/by-plate', requireAuth(), async (req,res)=>{
  const plate = normPlate(req.query.plate);
  if(!plate) return res.status(400).json({error:'Patente requerida'});

  // Traer el abonado + su última suscripción (determinístico)
  const [[s]] = await pool.query(
    `SELECT
        s.*,
        sub.planName,
        sub.priceMonthly,
        sub.startDate,
        sub.nextDueDate,
        sub.status AS subStatus
     FROM Subscriber s
     LEFT JOIN Subscription sub
       ON sub.id = (
         SELECT id
           FROM Subscription
          WHERE subscriberId = s.id
          ORDER BY nextDueDate DESC, id DESC
          LIMIT 1
       )
     WHERE s.plate=? AND s.status='ACTIVE'
     LIMIT 1`,
    [plate]
  );

  if (!s) return res.status(404).json({error:'No es abonado activo'});

  const [[{ today }]] = await pool.query(`SELECT CURDATE() AS today`);
  const pastDue = (!s.nextDueDate || s.subStatus !== 'ACTIVE' || s.nextDueDate < today) ? true : false;

  res.json({ abonado: s, pastDue });
});

// GET by id
router.get('/:id', requireAuth(['ADMIN','SUPERVISOR']), async (req,res)=>{
  const id = Number(req.params.id);
  const [[s]] = await pool.query(
    `SELECT s.*, sub.planName, sub.priceMonthly, sub.startDate, sub.nextDueDate, sub.status AS subStatus
     FROM Subscriber s LEFT JOIN Subscription sub ON sub.subscriberId=s.id WHERE s.id=?`, [id]);
  if(!s) return res.status(404).json({error:'No encontrado'});
  res.json(s);
});

// CREATE
router.post('/', requireAuth(['ADMIN','SUPERVISOR']), async (req,res)=>{
  const { fullName, plate, vehicleType, phone, email, notes, planName='Mensual', priceMonthly=0, startDate } = req.body||{};
  if(!fullName || !plate || !startDate) return res.status(400).json({error:'Faltan datos'});
  const p = normPlate(plate);

  const conn = await pool.getConnection();
  try{
    await conn.beginTransaction();

    const [r1] = await conn.query(
      `INSERT INTO Subscriber(fullName, plate, vehicleType, phone, email, notes)
       VALUES (?,?,?,?,?,?)`,
      [fullName, p, vehicleType||'CAR', phone||null, email||null, notes||null]
    );
    const subscriberId = r1.insertId;

    // nextDueDate = startDate + 1 mes (día relativo)
    const [[{ nextDueDate }]] = await conn.query(`SELECT DATE_ADD(?, INTERVAL 1 MONTH) AS nextDueDate`, [startDate]);

    await conn.query(
      `INSERT INTO Subscription(subscriberId, planName, priceMonthly, startDate, nextDueDate, renewAuto, status)
       VALUES (?,?,?,?,?,1,'ACTIVE')`,
      [subscriberId, planName, Number(priceMonthly||0), startDate, nextDueDate]
    );

    await conn.commit();
    const [[created]] = await conn.query(
      `SELECT s.*, sub.planName, sub.priceMonthly, sub.startDate, sub.nextDueDate, sub.status AS subStatus
       FROM Subscriber s LEFT JOIN Subscription sub ON sub.subscriberId=s.id WHERE s.id=?`, [subscriberId]
    );
    res.json(created);
  }catch(e){
    await conn.rollback();
    console.error('[subscribers.create]', e);
    res.status(500).json({error:'No se pudo crear'});
  }finally{
    conn.release();
  }
});

// UPDATE
router.put('/:id', requireAuth(['ADMIN','SUPERVISOR']), async (req,res)=>{
  const id = Number(req.params.id);
  const { fullName, plate, vehicleType, phone, email, notes, planName, priceMonthly, startDate, nextDueDate, status, subStatus } = req.body||{};
  const p = plate ? normPlate(plate) : null;

  const conn = await pool.getConnection();
  try{
    await conn.beginTransaction();

    await conn.query(
      `UPDATE Subscriber SET fullName=?, plate=?, vehicleType=?, phone=?, email=?, notes=?, status=?
       WHERE id=?`,
      [fullName, p, vehicleType, phone, email, notes, status||'ACTIVE', id]
    );

    // upsert Subscription (asumimos 1 plan vigente)
    const [[exists]] = await conn.query(`SELECT id FROM Subscription WHERE subscriberId=?`, [id]);
    if (exists) {
      await conn.query(
        `UPDATE Subscription SET planName=?, priceMonthly=?, startDate=?, nextDueDate=?, status=?
         WHERE subscriberId=?`,
        [planName||'Mensual', Number(priceMonthly||0), startDate, nextDueDate, subStatus||'ACTIVE', id]
      );
    } else {
      await conn.query(
        `INSERT INTO Subscription(subscriberId, planName, priceMonthly, startDate, nextDueDate, renewAuto, status)
         VALUES (?,?,?,?,?,1,?)`,
        [id, planName||'Mensual', Number(priceMonthly||0), startDate, nextDueDate, subStatus||'ACTIVE']
      );
    }

    await conn.commit();
    res.json({ok:true});
  }catch(e){
    await conn.rollback();
    console.error('[subscribers.update]', e);
    res.status(500).json({error:'No se pudo actualizar'});
  }finally{ conn.release(); }
});

// (Deprecated) Previously created SubscriptionInvoice rows.
// We are standardizing on Payment rows only.
router.post('/:id/charge', requireAuth(['ADMIN','SUPERVISOR']), async (_req,res)=>{
  return res.status(410).json({
    ok:false,
    error:'DEPRECATED',
    message:'Endpoint deprecated. Use POST /subscribers/:id/pay (records Payment + advances nextDueDate).'
  });
});

// PATCH /subscribers/:id
router.patch('/:id', requireAuth(['ADMIN','SUPERVISOR']), async (req, res) => {
  const id = Number(req.params.id);
  const { fullName, plate, vehicleType, nextDueDate, phone, email } = req.body;
  if (!id) return res.status(400).json({ ok:false, error:'BAD_ID' })

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // actualizar datos base
    await conn.query(
      `UPDATE Subscriber SET
         fullName   = COALESCE(?, fullName),
         plate      = COALESCE(?, plate),
         vehicleType= COALESCE(?, vehicleType),
         phone      = COALESCE(?, phone),
         email      = COALESCE(?, email)
       WHERE id=?`,
      [fullName, plate?.toUpperCase()?.trim(), vehicleType, phone, email, id]
    );

    // actualizar nextDueDate de la última suscripción
    if (nextDueDate) {
      await conn.query(
        `UPDATE Subscription
            SET nextDueDate=?
          WHERE id = (
            SELECT id FROM (
              SELECT id FROM Subscription
              WHERE subscriberId=?
              ORDER BY nextDueDate DESC, id DESC
              LIMIT 1
            ) tmp
          )`,
        [nextDueDate, id]
      );
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ ok: false, error: 'DB_ERROR' });
  } finally {
    conn.release();
  }
});

// DELETE /subscribers/:id
router.delete('/:id', requireAuth(['ADMIN','SUPERVISOR']), async (req,res)=>{
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok:false, error:'Invalid ID' });

  try {
    // Soft-delete si tiene suscripciones
    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) AS count FROM Subscription WHERE subscriberId=?`,
      [id]
    );

    if (count > 0) {
      await pool.query(`UPDATE Subscriber SET status='INACTIVE' WHERE id=?`, [id]);
    } else {
      await pool.query(`DELETE FROM Subscriber WHERE id=?`, [id]);
    }

    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'DB_ERROR' });
  }
});

// POST /subscribers/:id/pay
// Avanza el nextDueDate de la ÚLTIMA suscripción del abonado.
// Body opcional: { months?: number }  (default 1)
// Nota: este endpoint se usa desde caja/operación, por eso lo permitimos a cualquier usuario autenticado.
router.post('/:id/pay', requireAuth(), async (req, res) => {
  const id = Number(req.params.id);
  const months = Math.max(1, Number(req.body?.months) || 1);
  const method = String(req.body?.method || 'CASH').toUpperCase();
  const METHOD_OK = ['CASH','DEBIT','CREDIT','TRANSFER'];
  if (!METHOD_OK.includes(method) || !isValidPaymentMethod(method)) {
    return res.status(400).json({ ok:false, error:'INVALID_METHOD' });
  }
  const userId = req.user?.id || null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Traer última suscripción
    const [[sub]] = await conn.query(
      `SELECT id, subscriberId, planName, priceMonthly, nextDueDate
         FROM Subscription
        WHERE subscriberId = ?
        ORDER BY nextDueDate DESC, id DESC
        LIMIT 1`,
      [id]
    );
    if (!sub) {
      await conn.rollback();
      return res.status(404).json({ ok:false, error:'NO_SUBSCRIPTION' });
    }

    const [[{ today }]] = await conn.query(`SELECT CURDATE() AS today`);
    const base = (!sub.nextDueDate || sub.nextDueDate < today) ? today : sub.nextDueDate;

    // Avanza meses
    const [[{ newDue }]] = await conn.query(
      `SELECT DATE_ADD(?, INTERVAL ? MONTH) AS newDue`,
      [base, months]
    );

    await conn.query(
      `UPDATE Subscription SET nextDueDate = ? WHERE id = ?`,
      [newDue, sub.id]
    );

    // Monto a cobrar
    const amount = Number(sub.priceMonthly || 0) * months;

    // Nota (opcional): período acreditado
    const [[{ fromDate }]] = await conn.query(`SELECT DATE(?) AS fromDate`, [base]);
    const note = `Suscripción ${months} mes(es). Período desde ${fromDate} hasta ${newDue}.`;

    // Insert Payment (ticketId NULL, subscriberId presente en el schema actual)
    const [p] = await conn.query(
      `INSERT INTO Payment (ticketId, subscriberId, method, amount, createdBy, note)
       VALUES (?,?,?,?,?,?)`,
      [null, id, method, amount, userId, note]
    );

    await conn.commit();
    return res.json({
      ok:true,
      subscriberId: id,
      subscriptionId: sub.id,
      months,
      amount,
      method,
      nextDueDate: newDue,
      paymentId: p.insertId
    });
  } catch (e) {
    await conn.rollback();
    console.error('[sub pay]', e);
    return res.status(500).json({ ok:false, error:'DB_ERROR' });
  } finally {
    conn.release();
  }
});



module.exports = router;
