import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db, { getSetting, setSetting } from './db.js';

let secret = process.env.JWT_SECRET || await getSetting('jwt_secret');
if (!secret) {
  if (process.env.VERCEL) {
    // The DB may be ephemeral/per-instance on serverless, so a random secret
    // would invalidate logins on every cold start / across instances. Use a
    // fixed demo secret and tell the operator to set a real one.
    secret = 'demo-only-secret-set-JWT_SECRET-env-var';
    console.warn('WARNING: JWT_SECRET env var not set — using an insecure demo secret. Set JWT_SECRET in your Vercel project settings.');
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    await setSetting('jwt_secret', secret);
  }
}

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, secret, { expiresIn: '7d' });
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  // EventSource can't set headers, so SSE connections pass the token as a query param.
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, secret);
    const user = await db.prepare('SELECT id, name, email, role, is_active, available, status FROM users WHERE id = ?').get(payload.id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account disabled' });
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}
