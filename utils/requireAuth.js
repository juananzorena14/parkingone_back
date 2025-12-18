const jwt = require('jsonwebtoken');

function requireAuth(roles = []) {
  return (req, res, next) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'No token' });
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.user = payload; // { id, role, email }
      if (roles.length && !roles.includes(payload.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

/**
 * ✅ Versión opcional:
 * - Si hay token, lo valida igual que la versión normal.
 * - Si no hay token, deja continuar con req.user = null.
 * - Si hay roles definidos, los aplica solo si existe usuario.
 */
requireAuth.optional = (roles = []) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      if (!token) {
        req.user = null;
        return next(); // sin token → acceso permitido pero sin user
      }

      const decoded = jwt.verify(token, SECRET);
      req.user = decoded;

      if (roles.length && !roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'unauthorized' });
      }

      next();
    } catch (err) {
      console.warn('[requireAuth.optional]', err.message);
      req.user = null; // token inválido o expirado
      next(); // deja pasar igual
    }
  };
};

module.exports = { requireAuth };
