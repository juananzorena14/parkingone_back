// routes/cashShift.js
const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../utils/requireAuth');
const { normalizePaymentMethod, methodToBox } = require('../utils/paymentMethod');

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  const needsQuotes = /[",;\n]/.test(s);
  const body = s.replace(/"/g, '""');
  return needsQuotes ? `"${body}"` : body;
}

// Devuelve el turno abierto del user actual (o null)
router.get('/current', requireAuth(), async (req, res) => {
  const uid = req.user.id;
  const [rows] = await pool.query(
    'SELECT * FROM CashShift WHERE userId=? AND closedAt IS NULL ORDER BY openedAt DESC LIMIT 1',
    [uid]
  );
  res.json(rows[0] || null);
});

// Resumen del turno actual (caja estimada en este momento)
// - cash.paymentsCashNet: suma neta de pagos en efectivo del usuario durante el turno
// - cash.expectedNow: openingCash + cashNet + manualIn - manualOut
// - transfer.paymentsTransferIn: suma de pagos no-efectivo durante el turno (TRANSFER/DEBIT/CREDIT)
// - transfer.expectedNow: openingTransfer + transferIn + manualIn - manualOut
router.get('/current/summary', requireAuth(), async (req, res) => {
  const uid = req.user.id;

  const [[shift]] = await pool.query(
    'SELECT * FROM CashShift WHERE userId=? AND closedAt IS NULL ORDER BY openedAt DESC LIMIT 1',
    [uid]
  );

  if (!shift) {
    return res.json({
      ok: true,
      shift: null,
      cash: { paymentsCashNet: 0, manualIn: 0, manualOut: 0, expectedNow: 0 },
      transfer: { paymentsTransferIn: 0, manualIn: 0, manualOut: 0, expectedNow: 0 },
    });
  }

  const [[pay]] = await pool.query(
    `SELECT
      COALESCE(SUM(CASE
        WHEN p.method = 'CASH' THEN (COALESCE(p.amountGiven, p.amount) - COALESCE(p.changeAmt, 0))
        ELSE 0 END), 0) AS paymentsCashNet,
      COALESCE(SUM(CASE
        WHEN p.method IS NOT NULL AND p.method <> 'CASH' THEN COALESCE(p.amount,0)
        ELSE 0 END), 0) AS paymentsTransferIn
     FROM Payment p
     WHERE p.createdBy = ?
       AND p.createdAt >= ?
       AND p.createdAt <= NOW()`,
    [uid, shift.openedAt]
  );

  const [[mov]] = await pool.query(
    `SELECT
      COALESCE(SUM(CASE WHEN m.direction='IN'  AND m.method='CASH'     THEN m.amount ELSE 0 END),0) AS cashManualIn,
      COALESCE(SUM(CASE WHEN m.direction='OUT' AND m.method='CASH'     THEN m.amount ELSE 0 END),0) AS cashManualOut,
      COALESCE(SUM(CASE WHEN m.direction='IN'  AND m.method='TRANSFER' THEN m.amount ELSE 0 END),0) AS transferManualIn,
      COALESCE(SUM(CASE WHEN m.direction='OUT' AND m.method='TRANSFER' THEN m.amount ELSE 0 END),0) AS transferManualOut
     FROM CashShiftMovement m
     WHERE m.shiftId = ?`,
    [shift.id]
  );

  const paymentsCashNet = Number(pay?.paymentsCashNet || 0);
  const paymentsTransferIn = Number(pay?.paymentsTransferIn || 0);

  const cashManualIn = Number(mov?.cashManualIn || 0);
  const cashManualOut = Number(mov?.cashManualOut || 0);
  const transferManualIn = Number(mov?.transferManualIn || 0);
  const transferManualOut = Number(mov?.transferManualOut || 0);

  const openingCash = Number(shift.openingCash || 0);
  const openingTransfer = Number(shift.openingTransfer || 0);

  return res.json({
    ok: true,
    shift,
    cash: {
      paymentsCashNet,
      manualIn: cashManualIn,
      manualOut: cashManualOut,
      expectedNow: openingCash + paymentsCashNet + cashManualIn - cashManualOut,
    },
    transfer: {
      paymentsTransferIn,
      manualIn: transferManualIn,
      manualOut: transferManualOut,
      expectedNow: openingTransfer + paymentsTransferIn + transferManualIn - transferManualOut,
    },
  });
});

// Resumen de turnos (para dueño/supervisor)
// Incluye caja por método (CASH/TRANSFER) y movimientos manuales.
router.get('/summary', requireAuth(['ADMIN', 'SUPERVISOR']), async (req, res) => {
  const { from, to } = req.query;

  const where = [];
  const args = [];
  if (from) {
    where.push('cs.openedAt >= ?');
    args.push(from + ' 00:00:00');
  }
  if (to) {
    where.push('cs.openedAt < DATE_ADD(?, INTERVAL 1 DAY)');
    args.push(to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT
      cs.id,
      cs.userId,
      u.name  AS userName,
      u.email AS userEmail,
      u.role  AS userRole,
      cs.openedAt,
      cs.closedAt,
      cs.openingCash,
      cs.openingTransfer,
      cs.closingCash,
      cs.closingTransfer,
      cs.note,
      COALESCE(pay.paymentsCashNet, 0) AS paymentsCashNet,
      COALESCE(pay.paymentsTransferIn, 0) AS paymentsTransferIn,
      COALESCE(mov.cashManualIn, 0) AS cashManualIn,
      COALESCE(mov.cashManualOut, 0) AS cashManualOut,
      COALESCE(mov.transferManualIn, 0) AS transferManualIn,
      COALESCE(mov.transferManualOut, 0) AS transferManualOut
    FROM CashShift cs
    JOIN User u ON u.id = cs.userId
    LEFT JOIN (
      SELECT
        cs2.id AS shiftId,
        COALESCE(SUM(CASE
          WHEN p.method = 'CASH' THEN (COALESCE(p.amountGiven, p.amount) - COALESCE(p.changeAmt, 0))
          ELSE 0 END), 0) AS paymentsCashNet,
        COALESCE(SUM(CASE
          WHEN p.method IS NOT NULL AND p.method <> 'CASH' THEN COALESCE(p.amount,0)
          ELSE 0 END), 0) AS paymentsTransferIn
      FROM CashShift cs2
      LEFT JOIN Payment p
        ON p.createdBy = cs2.userId
       AND p.createdAt >= cs2.openedAt
       AND p.createdAt <= COALESCE(cs2.closedAt, NOW())
      GROUP BY cs2.id
    ) pay ON pay.shiftId = cs.id
    LEFT JOIN (
      SELECT
        m.shiftId,
        COALESCE(SUM(CASE WHEN m.direction='IN'  AND m.method='CASH'     THEN m.amount ELSE 0 END),0) AS cashManualIn,
        COALESCE(SUM(CASE WHEN m.direction='OUT' AND m.method='CASH'     THEN m.amount ELSE 0 END),0) AS cashManualOut,
        COALESCE(SUM(CASE WHEN m.direction='IN'  AND m.method='TRANSFER' THEN m.amount ELSE 0 END),0) AS transferManualIn,
        COALESCE(SUM(CASE WHEN m.direction='OUT' AND m.method='TRANSFER' THEN m.amount ELSE 0 END),0) AS transferManualOut
      FROM CashShiftMovement m
      GROUP BY m.shiftId
    ) mov ON mov.shiftId = cs.id
    ${clause}
    ORDER BY cs.openedAt DESC
    LIMIT 200`,
    args
  );

  const data = rows.map(r => {
    const openingCash = Number(r.openingCash || 0);
    const openingTransfer = Number(r.openingTransfer || 0);

    const paymentsCashNet = Number(r.paymentsCashNet || 0);
    const paymentsTransferIn = Number(r.paymentsTransferIn || 0);

    const cashManualIn = Number(r.cashManualIn || 0);
    const cashManualOut = Number(r.cashManualOut || 0);
    const transferManualIn = Number(r.transferManualIn || 0);
    const transferManualOut = Number(r.transferManualOut || 0);

    const expectedCashAtClose = openingCash + paymentsCashNet + cashManualIn - cashManualOut;
    const expectedTransferAtClose = openingTransfer + paymentsTransferIn + transferManualIn - transferManualOut;

    const isClosed = Boolean(r.closedAt);

    const closingCash = r.closingCash == null ? null : Number(r.closingCash);
    const closingTransfer = r.closingTransfer == null ? null : Number(r.closingTransfer);

    const cashDiff = isClosed && closingCash != null ? (closingCash - expectedCashAtClose) : null;
    const transferDiff = isClosed && closingTransfer != null ? (closingTransfer - expectedTransferAtClose) : null;

    const okCash = cashDiff == null ? null : Math.abs(cashDiff) < 0.01;
    const okTransfer = transferDiff == null ? null : Math.abs(transferDiff) < 0.01;

    // Back-compat fields (cash)
    const expectedAtClose = expectedCashAtClose;
    const diff = cashDiff;
    const ok = okCash;

    return {
      ...r,
      openingCash,
      openingTransfer,
      closingCash,
      closingTransfer,
      paymentsCashNet,
      paymentsTransferIn,
      cashManualIn,
      cashManualOut,
      transferManualIn,
      transferManualOut,
      expectedCashAtClose,
      expectedTransferAtClose,
      cashDiff,
      transferDiff,
      okCash,
      okTransfer,
      // legacy
      expectedAtClose,
      diff,
      ok,
    };
  });

  res.json({ ok: true, data });
});

// Export CSV de resumen de turnos
// GET /cash-shifts/summary/export?from&to
router.get('/summary/export', requireAuth(['ADMIN', 'SUPERVISOR']), async (req, res) => {
  const { from, to } = req.query;

  const where = [];
  const args = [];
  if (from) { where.push('cs.openedAt >= ?'); args.push(from + ' 00:00:00'); }
  if (to) { where.push('cs.openedAt < DATE_ADD(?, INTERVAL 1 DAY)'); args.push(to); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const MAX_ROWS = 10000;

  const [rows] = await pool.query(
    `SELECT
      cs.id,
      cs.userId,
      u.name  AS userName,
      u.email AS userEmail,
      u.role  AS userRole,
      cs.openedAt,
      cs.closedAt,
      cs.openingCash,
      cs.openingTransfer,
      cs.closingCash,
      cs.closingTransfer,
      cs.note,
      COALESCE(pay.paymentsCashNet, 0) AS paymentsCashNet,
      COALESCE(pay.paymentsTransferIn, 0) AS paymentsTransferIn,
      COALESCE(mov.cashManualIn, 0) AS cashManualIn,
      COALESCE(mov.cashManualOut, 0) AS cashManualOut,
      COALESCE(mov.transferManualIn, 0) AS transferManualIn,
      COALESCE(mov.transferManualOut, 0) AS transferManualOut
    FROM CashShift cs
    JOIN User u ON u.id = cs.userId
    LEFT JOIN (
      SELECT
        cs2.id AS shiftId,
        COALESCE(SUM(CASE
          WHEN p.method = 'CASH' THEN (COALESCE(p.amountGiven, p.amount) - COALESCE(p.changeAmt, 0))
          ELSE 0 END), 0) AS paymentsCashNet,
        COALESCE(SUM(CASE
          WHEN p.method IS NOT NULL AND p.method <> 'CASH' THEN COALESCE(p.amount,0)
          ELSE 0 END), 0) AS paymentsTransferIn
      FROM CashShift cs2
      LEFT JOIN Payment p
        ON p.createdBy = cs2.userId
       AND p.createdAt >= cs2.openedAt
       AND p.createdAt <= COALESCE(cs2.closedAt, NOW())
      GROUP BY cs2.id
    ) pay ON pay.shiftId = cs.id
    LEFT JOIN (
      SELECT
        m.shiftId,
        COALESCE(SUM(CASE WHEN m.direction='IN'  AND m.method='CASH'     THEN m.amount ELSE 0 END),0) AS cashManualIn,
        COALESCE(SUM(CASE WHEN m.direction='OUT' AND m.method='CASH'     THEN m.amount ELSE 0 END),0) AS cashManualOut,
        COALESCE(SUM(CASE WHEN m.direction='IN'  AND m.method='TRANSFER' THEN m.amount ELSE 0 END),0) AS transferManualIn,
        COALESCE(SUM(CASE WHEN m.direction='OUT' AND m.method='TRANSFER' THEN m.amount ELSE 0 END),0) AS transferManualOut
      FROM CashShiftMovement m
      GROUP BY m.shiftId
    ) mov ON mov.shiftId = cs.id
    ${clause}
    ORDER BY cs.openedAt DESC
    LIMIT ?`,
    [...args, MAX_ROWS]
  );

  const truncated = (rows?.length || 0) >= MAX_ROWS;

  const headers = [
    'ShiftId','UserId','User','Role','OpenedAt','ClosedAt',
    'OpeningCash','OpeningTransfer',
    'PaymentsCashNet','PaymentsTransferIn',
    'CashManualIn','CashManualOut','TransferManualIn','TransferManualOut',
    'ExpectedCashAtClose','ExpectedTransferAtClose',
    'ClosingCash','ClosingTransfer',
    'CashDiff','TransferDiff','OkCash','OkTransfer',
    'Note'
  ];

  const lines = ['sep=;'.trim(), headers.join(';')];

  for (const r of rows) {
    const openingCash = Number(r.openingCash || 0);
    const openingTransfer = Number(r.openingTransfer || 0);
    const paymentsCashNet = Number(r.paymentsCashNet || 0);
    const paymentsTransferIn = Number(r.paymentsTransferIn || 0);
    const cashManualIn = Number(r.cashManualIn || 0);
    const cashManualOut = Number(r.cashManualOut || 0);
    const transferManualIn = Number(r.transferManualIn || 0);
    const transferManualOut = Number(r.transferManualOut || 0);

    const expectedCashAtClose = openingCash + paymentsCashNet + cashManualIn - cashManualOut;
    const expectedTransferAtClose = openingTransfer + paymentsTransferIn + transferManualIn - transferManualOut;

    const isClosed = Boolean(r.closedAt);
    const closingCash = r.closingCash == null ? null : Number(r.closingCash);
    const closingTransfer = r.closingTransfer == null ? null : Number(r.closingTransfer);

    const cashDiff = isClosed && closingCash != null ? (closingCash - expectedCashAtClose) : null;
    const transferDiff = isClosed && closingTransfer != null ? (closingTransfer - expectedTransferAtClose) : null;

    const okCash = cashDiff == null ? null : Math.abs(cashDiff) < 0.01;
    const okTransfer = transferDiff == null ? null : Math.abs(transferDiff) < 0.01;

    lines.push([
      csvEscape(r.id),
      csvEscape(r.userId),
      csvEscape(r.userName),
      csvEscape(r.userRole),
      csvEscape(r.openedAt?.toISOString?.() ? r.openedAt.toISOString() : r.openedAt),
      csvEscape(r.closedAt?.toISOString?.() ? r.closedAt.toISOString() : r.closedAt),
      csvEscape(openingCash),
      csvEscape(openingTransfer),
      csvEscape(paymentsCashNet),
      csvEscape(paymentsTransferIn),
      csvEscape(cashManualIn),
      csvEscape(cashManualOut),
      csvEscape(transferManualIn),
      csvEscape(transferManualOut),
      csvEscape(expectedCashAtClose),
      csvEscape(expectedTransferAtClose),
      csvEscape(closingCash ?? ''),
      csvEscape(closingTransfer ?? ''),
      csvEscape(cashDiff ?? ''),
      csvEscape(transferDiff ?? ''),
      csvEscape(okCash == null ? '' : (okCash ? 1 : 0)),
      csvEscape(okTransfer == null ? '' : (okTransfer ? 1 : 0)),
      csvEscape(r.note ?? ''),
    ].join(';'));
  }

  const filename = `turnos_${Date.now()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Export-Max-Rows', String(MAX_ROWS));
  res.setHeader('X-Export-Truncated', truncated ? '1' : '0');

  const csv = '\ufeff' + lines.join('\n');
  res.send(csv);
});

// Export CSV de detalle de un turno (pagos + manuales)
// GET /cash-shifts/:id/export
router.get('/:id/export', requireAuth(['ADMIN', 'SUPERVISOR']), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });

  const [[shift]] = await pool.query(
    `SELECT
      cs.id,
      cs.userId,
      u.name  AS userName,
      u.role  AS userRole,
      cs.openedAt,
      cs.closedAt
     FROM CashShift cs
     JOIN User u ON u.id = cs.userId
     WHERE cs.id = ?
     LIMIT 1`,
    [id]
  );

  if (!shift) return res.status(404).json({ ok: false, error: 'Turno no encontrado' });

  const from = shift.openedAt;
  const to = shift.closedAt || new Date();

  const MAX_ROWS = 20000;

  const [payments] = await pool.query(
    `SELECT
      p.id,
      p.createdAt,
      p.method,
      p.amount,
      p.amountGiven,
      p.changeAmt,
      p.note,
      p.ticketId,
      t.plate AS ticketPlate,
      p.subscriberId,
      s.fullName AS subscriberName,
      s.plate AS subscriberPlate,
      p.createdBy,
      u.name AS createdByName
     FROM Payment p
     LEFT JOIN Ticket t ON t.id = p.ticketId
     LEFT JOIN Subscriber s ON s.id = p.subscriberId
     LEFT JOIN User u ON u.id = p.createdBy
     WHERE p.createdBy = ?
       AND p.createdAt >= ?
       AND p.createdAt <= ?
     ORDER BY p.createdAt ASC, p.id ASC
     LIMIT ?`,
    [shift.userId, from, to, MAX_ROWS]
  );

  const [manual] = await pool.query(
    `SELECT id, createdAt, createdBy, direction, method, amount, category, note
       FROM CashShiftMovement
      WHERE shiftId = ?
      ORDER BY createdAt ASC, id ASC`,
    [shift.id]
  );

  const headers = [
    'ShiftId','ShiftUser','OpenedAt','ClosedAt',
    'RowKind','RefKind','CreatedAt','Direction','Box','Method','Amount','CashNet',
    'TicketId','TicketPlate','SubscriberId','Subscriber','SubscriberPlate',
    'Category','Note'
  ];

  const lines = ['sep=;'.trim(), headers.join(';')];

  let rowCount = 0;

  for (const p of payments) {
    const refKind = p.ticketId ? 'TICKET' : (p.subscriberId ? 'SUBSCRIPTION' : 'OTHER');
    const method = normalizePaymentMethod(p.method) || p.method;
    const box = methodToBox(method) || 'TRANSFER';

    const amount = Number(p.amount ?? 0) || 0;
    const amountGiven = p.amountGiven == null ? null : Number(p.amountGiven);
    const changeAmt = p.changeAmt == null ? null : Number(p.changeAmt);
    const cashNet = box === 'CASH'
      ? (Number.isFinite(amountGiven) ? amountGiven : amount) - (Number.isFinite(changeAmt) ? changeAmt : 0)
      : '';

    lines.push([
      csvEscape(shift.id),
      csvEscape(shift.userName),
      csvEscape(shift.openedAt?.toISOString?.() ? shift.openedAt.toISOString() : shift.openedAt),
      csvEscape(shift.closedAt?.toISOString?.() ? shift.closedAt.toISOString() : shift.closedAt),
      csvEscape('PAYMENT'),
      csvEscape(refKind),
      csvEscape(p.createdAt?.toISOString?.() ? p.createdAt.toISOString() : p.createdAt),
      csvEscape('IN'),
      csvEscape(box),
      csvEscape(method),
      csvEscape(amount),
      csvEscape(cashNet),
      csvEscape(p.ticketId ?? ''),
      csvEscape(p.ticketPlate ?? ''),
      csvEscape(p.subscriberId ?? ''),
      csvEscape(p.subscriberName ?? ''),
      csvEscape(p.subscriberPlate ?? ''),
      csvEscape(''),
      csvEscape(p.note ?? ''),
    ].join(';'));

    rowCount++;
    if (rowCount >= MAX_ROWS) break;
  }

  for (const m of manual) {
    if (rowCount >= MAX_ROWS) break;

    lines.push([
      csvEscape(shift.id),
      csvEscape(shift.userName),
      csvEscape(shift.openedAt?.toISOString?.() ? shift.openedAt.toISOString() : shift.openedAt),
      csvEscape(shift.closedAt?.toISOString?.() ? shift.closedAt.toISOString() : shift.closedAt),
      csvEscape('MANUAL'),
      csvEscape(''),
      csvEscape(m.createdAt?.toISOString?.() ? m.createdAt.toISOString() : m.createdAt),
      csvEscape(String(m.direction || '').toUpperCase()),
      csvEscape(String(m.method || '').toUpperCase()),
      csvEscape(String(m.method || '').toUpperCase()),
      csvEscape(Number(m.amount ?? 0) || 0),
      csvEscape(''),
      csvEscape(''),
      csvEscape(''),
      csvEscape(''),
      csvEscape(''),
      csvEscape(''),
      csvEscape(m.category ?? ''),
      csvEscape(m.note ?? ''),
    ].join(';'));

    rowCount++;
  }

  const truncated = rowCount >= MAX_ROWS;

  const filename = `turno_${shift.id}_${Date.now()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Export-Max-Rows', String(MAX_ROWS));
  res.setHeader('X-Export-Truncated', truncated ? '1' : '0');

  const csv = '\ufeff' + lines.join('\n');
  res.send(csv);
});

// Detalle de un turno (para dueño/supervisor)
// Devuelve:
// - shift: datos del turno + usuario
// - payments: lista de pagos realizados durante el turno (por el usuario del turno)
// - totals: totales por método y total general
router.get('/:id/details', requireAuth(['ADMIN', 'SUPERVISOR']), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });

  try {
    const [[shift]] = await pool.query(
      `SELECT
        cs.id,
        cs.userId,
        u.name  AS userName,
        u.email AS userEmail,
        u.role  AS userRole,
        cs.openedAt,
        cs.closedAt,
        cs.openingCash,
        cs.openingTransfer,
        cs.closingCash,
        cs.closingTransfer,
        cs.note
       FROM CashShift cs
       JOIN User u ON u.id = cs.userId
       WHERE cs.id = ?
       LIMIT 1`,
      [id]
    );

    if (!shift) return res.status(404).json({ ok: false, error: 'Turno no encontrado' });

    const from = shift.openedAt;
    const to = shift.closedAt || new Date();

    // Hard-limit de seguridad por turno (evita respuestas gigantes)
    const MAX_ROWS = 5000;

    const [payments] = await pool.query(
      `SELECT
        p.id,
        p.createdAt,
        p.method,
        p.amount,
        p.amountGiven,
        p.changeAmt,
        p.externalId,
        p.note,
        p.ticketId,
        t.plate AS ticketPlate,
        p.subscriberId,
        s.fullName AS subscriberName,
        s.plate AS subscriberPlate,
        p.createdBy,
        u.name AS userName
       FROM Payment p
       LEFT JOIN Ticket t ON t.id = p.ticketId
       LEFT JOIN Subscriber s ON s.id = p.subscriberId
       LEFT JOIN User u ON u.id = p.createdBy
       WHERE p.createdBy = ?
         AND p.createdAt >= ?
         AND p.createdAt <= ?
       ORDER BY p.createdAt ASC, p.id ASC
       LIMIT ?`,
      [shift.userId, from, to, MAX_ROWS]
    );

    const [manual] = await pool.query(
      `SELECT id, createdAt, createdBy, direction, method, amount, category, note
         FROM CashShiftMovement
        WHERE shiftId = ?
        ORDER BY createdAt ASC, id ASC`,
      [shift.id]
    );

    const totals = payments.reduce(
      (acc, p) => {
        const method = normalizePaymentMethod(p.method) || 'UNKNOWN';
        const amount = Number(p.amount || 0);
        acc.total += amount;
        acc.byMethod[method] = (acc.byMethod[method] || 0) + amount;

        if (method === 'CASH') {
          const net = Number(p.amountGiven != null ? p.amountGiven : p.amount) - Number(p.changeAmt || 0);
          acc.cashNet += net;
        } else if (method) {
          // Caja no-efectivo (TRANSFER/DEBIT/CREDIT)
          acc.transferIn += amount;
        }

        return acc;
      },
      { total: 0, cashNet: 0, transferIn: 0, byMethod: {} }
    );

    const manualAgg = manual.reduce(
      (acc, m) => {
        const method = String(m.method || 'UNKNOWN');
        const dir = String(m.direction || '');
        const amt = Number(m.amount || 0);

        if (method === 'CASH') {
          if (dir === 'IN') acc.cashIn += amt;
          if (dir === 'OUT') acc.cashOut += amt;
        }
        if (method === 'TRANSFER') {
          if (dir === 'IN') acc.transferIn += amt;
          if (dir === 'OUT') acc.transferOut += amt;
        }
        return acc;
      },
      { cashIn: 0, cashOut: 0, transferIn: 0, transferOut: 0 }
    );

    const openingCash = Number(shift.openingCash || 0);
    const openingTransfer = Number(shift.openingTransfer || 0);

    const expectedCashAtClose = openingCash + Number(totals.cashNet || 0) + Number(manualAgg.cashIn || 0) - Number(manualAgg.cashOut || 0);
    const expectedTransferAtClose = openingTransfer + Number(totals.transferIn || 0) + Number(manualAgg.transferIn || 0) - Number(manualAgg.transferOut || 0);

    const closingCash = shift.closingCash == null ? null : Number(shift.closingCash);
    const closingTransfer = shift.closingTransfer == null ? null : Number(shift.closingTransfer);

    const cashDiff = closingCash == null ? null : closingCash - expectedCashAtClose;
    const transferDiff = closingTransfer == null ? null : closingTransfer - expectedTransferAtClose;

    // legacy fields (cash only)
    const expectedAtClose = expectedCashAtClose;
    const diff = cashDiff;

    const paymentsNorm = (payments || []).map(p => ({
      ...p,
      method: normalizePaymentMethod(p.method) || p.method,
    }));

    return res.json({
      ok: true,
      shift: {
        ...shift,
        openingCash,
        openingTransfer,
        closingCash,
        closingTransfer,
        expectedCashAtClose,
        expectedTransferAtClose,
        cashDiff,
        transferDiff,
        // legacy
        expectedAtClose,
        diff,
      },
      totals,
      manual,
      payments: paymentsNorm,
    });
  } catch (e) {
    console.error('[cash-shifts details]', e);
    return res.status(500).json({ ok: false, error: 'DB_ERROR' });
  }
});

// Ledger del turno actual (para operador)
// Devuelve turno + cajas (cash/transfer) + movimientos unificados (pagos + manuales).
router.get('/current/ledger', requireAuth(), async (req, res) => {
  const uid = req.user.id;

  const [[shift]] = await pool.query(
    'SELECT * FROM CashShift WHERE userId=? AND closedAt IS NULL ORDER BY openedAt DESC LIMIT 1',
    [uid]
  );

  if (!shift) return res.json({ ok: true, shift: null, boxes: null, movements: [] });

  const from = shift.openedAt;
  const to = new Date();

  // Hard-limit de seguridad
  const MAX_PAYMENTS = 5000;

  const [payments] = await pool.query(
    `SELECT
      p.id,
      p.createdAt,
      p.method,
      p.amount,
      p.amountGiven,
      p.changeAmt,
      p.note,
      p.ticketId,
      t.plate AS ticketPlate,
      p.subscriberId,
      s.fullName AS subscriberName,
      s.plate AS subscriberPlate
     FROM Payment p
     LEFT JOIN Ticket t ON t.id = p.ticketId
     LEFT JOIN Subscriber s ON s.id = p.subscriberId
     WHERE p.createdBy = ?
       AND p.createdAt >= ?
       AND p.createdAt <= ?
     ORDER BY p.createdAt ASC, p.id ASC
     LIMIT ?`,
    [uid, from, to, MAX_PAYMENTS]
  );

  const [manual] = await pool.query(
    `SELECT id, createdAt, createdBy, direction, method, amount, category, note
       FROM CashShiftMovement
      WHERE shiftId = ?
      ORDER BY createdAt ASC, id ASC`,
    [shift.id]
  );

  function payMethodToBox(method) {
    const box = methodToBox(method);
    return box || 'OTHER';
  }

  const boxes = {
    CASH: {
      opening: Number(shift.openingCash || 0),
      inPayments: 0,
      inManual: 0,
      outManual: 0,
    },
    TRANSFER: {
      opening: Number(shift.openingTransfer || 0),
      inPayments: 0,
      inManual: 0,
      outManual: 0,
    },
  };

  const movements = [];

  for (const p of payments) {
    const box = payMethodToBox(p.method);
    if (box === 'OTHER') continue;

    const method = normalizePaymentMethod(p.method) || p.method;

    let amount = Number(p.amount || 0);
    if (box === 'CASH') {
      amount = Number(p.amountGiven != null ? p.amountGiven : p.amount) - Number(p.changeAmt || 0);
    }

    if (!Number.isFinite(amount)) amount = 0;
    boxes[box].inPayments += amount;

    const ref = p.ticketId
      ? `#${p.ticketId} ${p.ticketPlate || ''}`.trim()
      : (p.subscriberId
          ? `${p.subscriberName || ''} (${p.subscriberPlate || ''})`.trim()
          : (p.note || '-'));

    const paymentRefKind = p.ticketId ? 'TICKET' : (p.subscriberId ? 'SUBSCRIPTION' : 'OTHER');

    movements.push({
      kind: 'PAYMENT',
      refKind: paymentRefKind,
      id: p.id,
      createdAt: p.createdAt,
      direction: 'IN',
      method,
      box,
      amount,
      ref,
      note: p.note || null,
    });
  }

  for (const m of manual) {
    const method = String(m.method || '').toUpperCase();
    if (method !== 'CASH' && method !== 'TRANSFER') continue;

    const dir = String(m.direction || '').toUpperCase();
    const amt = Number(m.amount || 0);

    if (dir === 'IN') boxes[method].inManual += amt;
    else if (dir === 'OUT') boxes[method].outManual += amt;

    movements.push({
      kind: 'MANUAL',
      id: m.id,
      createdAt: m.createdAt,
      direction: dir,
      method,
      box: method,
      amount: amt,
      category: m.category || null,
      note: m.note || null,
    });
  }

  movements.sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    if (ta !== tb) return ta - tb;
    return Number(a.id) - Number(b.id);
  });

  for (const k of ['CASH', 'TRANSFER']) {
    const b = boxes[k];
    b.net = Number(b.inPayments || 0) + Number(b.inManual || 0) - Number(b.outManual || 0);
    b.expectedNow = Number(b.opening || 0) + b.net;
  }

  return res.json({ ok: true, shift, boxes, movements });
});

// Crear movimiento manual en el turno actual (operador)
router.post('/current/movements', requireAuth(), async (req, res) => {
  const uid = req.user.id;
  const { direction, method, amount, category, note } = req.body || {};

  const dir = String(direction || '').toUpperCase();
  const meth = String(method || '').toUpperCase();
  const amt = Number(amount);

  if (!['IN', 'OUT'].includes(dir)) return res.status(400).json({ ok: false, error: 'direction inválido' });
  if (!['CASH', 'TRANSFER'].includes(meth)) return res.status(400).json({ ok: false, error: 'method inválido' });
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ ok: false, error: 'amount inválido' });

  const [[shift]] = await pool.query(
    'SELECT * FROM CashShift WHERE userId=? AND closedAt IS NULL ORDER BY openedAt DESC LIMIT 1',
    [uid]
  );
  if (!shift) return res.status(400).json({ ok: false, error: 'No tenés turno abierto.' });

  const [r] = await pool.query(
    `INSERT INTO CashShiftMovement (shiftId, createdBy, direction, method, amount, category, note)
     VALUES (?,?,?,?,?,?,?)`,
    [shift.id, uid, dir, meth, amt, category || null, note || null]
  );

  const [[row]] = await pool.query('SELECT * FROM CashShiftMovement WHERE id=?', [r.insertId]);
  return res.json({ ok: true, movement: row });
});

// Abrir turno
// Nota: la caja TRANSFER arranca siempre en 0 por turno.
router.post('/open', requireAuth(), async (req, res) => {
  const uid = req.user.id;
  const { openingCash, note } = req.body;

  const [openRows] = await pool.query(
    'SELECT id FROM CashShift WHERE userId=? AND closedAt IS NULL LIMIT 1',
    [uid]
  );
  if (openRows.length) return res.status(400).json({ error: 'Ya tenés un turno abierto.' });

  const [r] = await pool.query(
    'INSERT INTO CashShift (userId, openingCash, openingTransfer, note) VALUES (?,?,?,?)',
    [uid, Number(openingCash || 0), 0, note || null]
  );
  const [[row]] = await pool.query('SELECT * FROM CashShift WHERE id=?', [r.insertId]);
  res.json(row);
});

// Cerrar turno
// Nota: en este modo, el cierre se calcula automáticamente desde movimientos (pagos + manuales).
// No se solicita al operario ingresar montos contados.
router.post('/close', requireAuth(), async (req, res) => {
  const uid = req.user.id;
  const { note } = req.body || {};

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[shift]] = await conn.query(
      'SELECT * FROM CashShift WHERE userId=? AND closedAt IS NULL ORDER BY openedAt DESC LIMIT 1 FOR UPDATE',
      [uid]
    );
    if (!shift) {
      await conn.rollback();
      return res.status(400).json({ error: 'No tenés turno abierto.' });
    }

    const [[pay]] = await conn.query(
      `SELECT
        COALESCE(SUM(CASE
          WHEN p.method = 'CASH' THEN (COALESCE(p.amountGiven, p.amount) - COALESCE(p.changeAmt, 0))
          ELSE 0 END), 0) AS paymentsCashNet,
        COALESCE(SUM(CASE
          WHEN p.method IS NOT NULL AND p.method <> 'CASH' THEN COALESCE(p.amount,0)
          ELSE 0 END), 0) AS paymentsTransferIn
       FROM Payment p
       WHERE p.createdBy = ?
         AND p.createdAt >= ?
         AND p.createdAt <= NOW()`,
      [uid, shift.openedAt]
    );

    const [[mov]] = await conn.query(
      `SELECT
        COALESCE(SUM(CASE WHEN m.direction='IN'  AND m.method='CASH'     THEN m.amount ELSE 0 END),0) AS cashManualIn,
        COALESCE(SUM(CASE WHEN m.direction='OUT' AND m.method='CASH'     THEN m.amount ELSE 0 END),0) AS cashManualOut,
        COALESCE(SUM(CASE WHEN m.direction='IN'  AND m.method='TRANSFER' THEN m.amount ELSE 0 END),0) AS transferManualIn,
        COALESCE(SUM(CASE WHEN m.direction='OUT' AND m.method='TRANSFER' THEN m.amount ELSE 0 END),0) AS transferManualOut
       FROM CashShiftMovement m
       WHERE m.shiftId = ?`,
      [shift.id]
    );

    const openingCash = Number(shift.openingCash || 0);
    const openingTransfer = Number(shift.openingTransfer || 0);

    const paymentsCashNet = Number(pay?.paymentsCashNet || 0);
    const paymentsTransferIn = Number(pay?.paymentsTransferIn || 0);

    const cashManualIn = Number(mov?.cashManualIn || 0);
    const cashManualOut = Number(mov?.cashManualOut || 0);
    const transferManualIn = Number(mov?.transferManualIn || 0);
    const transferManualOut = Number(mov?.transferManualOut || 0);

    const closingCash = openingCash + paymentsCashNet + cashManualIn - cashManualOut;
    const closingTransfer = openingTransfer + paymentsTransferIn + transferManualIn - transferManualOut;

    await conn.query(
      'UPDATE CashShift SET closingCash=?, closingTransfer=?, closedAt=NOW(), note=COALESCE(?, note) WHERE id=?',
      [closingCash, closingTransfer, note || null, shift.id]
    );

    await conn.commit();

    const [[row]] = await pool.query('SELECT * FROM CashShift WHERE id=?', [shift.id]);
    return res.json(row);
  } catch (e) {
    await conn.rollback();
    console.error('[cash-shifts close]', e);
    return res.status(500).json({ error: 'DB_ERROR' });
  } finally {
    conn.release();
  }
});

module.exports = router;
