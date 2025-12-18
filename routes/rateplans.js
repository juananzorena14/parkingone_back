const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth } = require('../utils/requireAuth');

// Obtener todas las tarifas
router.get('/', requireAuth(), async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM RatePlan ORDER BY id DESC');
  res.json(rows);
});

// Crear una nueva tarifa
router.post('/', requireAuth(['ADMIN', 'SUPERVISOR']), async (req, res) => {
  const rp = req.body;
  const [r] = await pool.query(
    `INSERT INTO RatePlan (
      name, vehicleType, perHour, per30min, nightFlat, nightStartsAt, nightEndsAt, toleranceMin, currency
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      rp.name,
      rp.vehicleType,
      rp.perHour,
      rp.per30min,
      rp.nightFlat,
      rp.nightStartsAt,
      rp.nightEndsAt,
      rp.toleranceMin,
      rp.currency || 'ARS'
    ]
  );

  const [row] = await pool.query('SELECT * FROM RatePlan WHERE id = ?', [r.insertId]);
  res.json(row[0]);
});

// Actualizar una tarifa existente
router.put('/:id', requireAuth(['ADMIN', 'SUPERVISOR']), async (req, res) => {
  const id = Number(req.params.id);
  const rp = req.body;
  await pool.query(
    `UPDATE RatePlan 
     SET name=?, vehicleType=?, perHour=?, per30min=?, nightFlat=?, nightStartsAt=?, nightEndsAt=?, toleranceMin=?, currency=? 
     WHERE id=?`,
    [
      rp.name,
      rp.vehicleType,
      rp.perHour,
      rp.per30min,
      rp.nightFlat,
      rp.nightStartsAt,
      rp.nightEndsAt,
      rp.toleranceMin,
      rp.currency || 'ARS',
      id
    ]
  );

  const [row] = await pool.query('SELECT * FROM RatePlan WHERE id=?', [id]);
  res.json(row[0]);
});

// Eliminar una tarifa
router.delete('/:id', requireAuth(['ADMIN']), async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('DELETE FROM RatePlan WHERE id=?', [id]);
  res.json({ ok: true });
});

module.exports = router;
