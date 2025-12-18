// routes/cashShift.js
const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../utils/requireAuth');

// Devuelve el turno abierto del user actual (o null)
router.get('/current', requireAuth(), async (req, res) => {
  const uid = req.user.id;
  const [rows] = await pool.query(
    'SELECT * FROM CashShift WHERE userId=? AND closedAt IS NULL ORDER BY openedAt DESC LIMIT 1',
    [uid]
  );
  res.json(rows[0] || null);
});

// Abrir turno
router.post('/open', requireAuth(), async (req, res) => {
  const uid = req.user.id;
  const { openingCash, note } = req.body;

  const [openRows] = await pool.query(
    'SELECT id FROM CashShift WHERE userId=? AND closedAt IS NULL LIMIT 1',
    [uid]
  );
  if (openRows.length) return res.status(400).json({ error: 'Ya tenés un turno abierto.' });

  const [r] = await pool.query(
    'INSERT INTO CashShift (userId, openingCash, note) VALUES (?,?,?)',
    [uid, Number(openingCash || 0), note || null]
  );
  const [[row]] = await pool.query('SELECT * FROM CashShift WHERE id=?', [r.insertId]);
  res.json(row);
});

// Cerrar turno
router.post('/close', requireAuth(), async (req, res) => {
  const uid = req.user.id;
  const { closingCash, note } = req.body;

  const [[shift]] = await pool.query(
    'SELECT * FROM CashShift WHERE userId=? AND closedAt IS NULL ORDER BY openedAt DESC LIMIT 1',
    [uid]
  );
  if (!shift) return res.status(400).json({ error: 'No tenés turno abierto.' });

  await pool.query(
    'UPDATE CashShift SET closingCash=?, closedAt=NOW(), note=COALESCE(?, note) WHERE id=?',
    [Number(closingCash || 0), note || null, shift.id]
  );
  const [[row]] = await pool.query('SELECT * FROM CashShift WHERE id=?', [shift.id]);
  res.json(row);
});

module.exports = router;
