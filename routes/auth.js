const router = require('express').Router();
const { pool } = require('../db');
const { signUser, verifyPassword } = require('../utils/auth');
const { requireAuth } = require('../utils/requireAuth');
const rateLimit = require('express-rate-limit');

// POST /auth/login
router.post('/login', async (req,res)=>{
  const { email, password } = req.body;
  const [rows] = await pool.query('SELECT * FROM User WHERE email=? AND isActive=1',[email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error:'Credenciales inválidas' });
  const ok = await verifyPassword(password, user.hash);
  if (!ok) return res.status(401).json({ error:'Credenciales inválidas' });
  const token = signUser(user);
  res.json({ token, user:{ id:user.id, name:user.name, role:user.role, email:user.email }});
});

// GET /auth/whoami (protegido)
router.get('/whoami', requireAuth(), (req,res)=>{
  res.json({ user: req.user });
});

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutos
  max: 20,                  // 20 intentos por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Probá más tarde.' }
});
module.exports = router;
