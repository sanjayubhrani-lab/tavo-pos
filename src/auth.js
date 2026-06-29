// Authentication & role-based access control.
// Staff log in with a numeric PIN (POS-style). PINs are bcrypt-hashed in the DB.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const TOKEN_TTL = '12h';

// What each role is allowed to do (used by both API guards and the UI).
export const ROLE_ROUTES = {
  manager: ['pos', 'floor', 'kds', 'online', 'qr', 'dash', 'analytics', 'menu', 'inventory', 'purchasing', 'stocktake', 'loyalty', 'discounts', 'crm', 'marketing', 'reservations', 'houseaccounts', 'locations', 'ask', 'drawer', 'clock', 'team', 'settings'],
  server:  ['pos', 'floor', 'kds', 'online', 'reservations', 'clock'],
  kitchen: ['kds', 'online', 'clock'],
};

export function hashPin(pin) {
  return bcrypt.hashSync(String(pin), 10);
}

export function verifyPin(pin, hash) {
  return bcrypt.compareSync(String(pin), hash);
}

export function issueToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role, tenantId: user.tenantId || 'default', tenantSlug: user.tenantSlug || 'default', tenantName: user.tenantName || 'Tavo', tenantMode: user.tenantMode || 'restaurant' },
    SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function readToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Middleware: require a valid token.
export function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'login required' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'session expired — please log in again' });
  }
}

// Middleware factory: require one of the given roles.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'login required' });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: `requires role: ${roles.join(' or ')}` });
    next();
  };
}
