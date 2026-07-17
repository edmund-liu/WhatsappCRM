import jwt from 'jsonwebtoken';
import db, { getSetting, setSetting } from './db.js';
import crypto from 'crypto';

let secret = process.env.JWT_SECRET || getSetting('jwt_secret');
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  setSetting('jwt_secret', secret);
}

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, secret, { expiresIn: '7d' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  // EventSource can't set headers, so SSE connections pass the token as a query param.
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, secret);
    const user = db.prepare('SELECT id, name, email, role, is_active, available FROM users WHERE id = ?').get(payload.id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account disabled' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}
