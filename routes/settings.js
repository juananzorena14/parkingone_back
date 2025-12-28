const router = require('express').Router();
const { pool } = require('../db');

router.get('/', async (_req,res)=>{
  const [rows] = await pool.query('SELECT * FROM Settings WHERE id=1');
  res.json(rows[0]);
});

router.put('/', async (req,res)=>{
  const { parking_name, total_spots, timezone, phone, direction } = req.body;
  await pool.query(
    'UPDATE Settings SET parking_name=?, total_spots=?, timezone=?, phone=?, direction=? WHERE id=1',
    [parking_name, total_spots, timezone || 'America/Argentina/Tucuman', phone || null, direction || null]
  );
  const [rows] = await pool.query('SELECT * FROM Settings WHERE id=1');
  res.json(rows[0]);
});

module.exports = router;
