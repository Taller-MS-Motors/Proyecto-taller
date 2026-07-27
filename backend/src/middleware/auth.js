const jwt = require('jsonwebtoken');

module.exports = function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // El token debe ser de PERSONAL: los del portal de clientes se firman con el
    // mismo secreto pero llevan tipo:'cliente' y no tienen rol. Sin este chequeo,
    // un cliente autenticado podría usar su token en las rutas de staff.
    if (payload.tipo === 'cliente' || !payload.rol) {
      return res.status(403).json({ error: 'Token no válido para esta sección' });
    }
    // Token parcial de 2FA (contraseña correcta pero falta el segundo factor): solo
    // vale para canjearlo en /auth/2fa/verificar, nunca como sesión. Hoy además no
    // lleva `rol` (ya lo cortaría el chequeo de arriba); esto lo deja explícito para
    // que siga bloqueado aunque el payload cambie más adelante.
    if (payload.pend2fa) {
      return res.status(403).json({ error: 'Falta completar la verificación en dos pasos' });
    }
    req.usuario = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
