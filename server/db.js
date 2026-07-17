import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'crm.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin','agent')),
  is_active INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT NOT NULL UNIQUE,           -- WhatsApp phone number (E.164, digits only)
  name TEXT,
  tags TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
  attributes TEXT NOT NULL DEFAULT '{}',-- JSON object of custom fields
  opted_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved')),
  assigned_user_id INTEGER REFERENCES users(id),
  ai_agent_id INTEGER,
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  last_message_preview TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conv_assigned ON conversations(assigned_user_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('contact','agent','ai','broadcast','system')),
  sender_user_id INTEGER REFERENCES users(id),
  ai_agent_id INTEGER,
  type TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  wa_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('queued','sent','delivered','read','failed','received')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msg_waid ON messages(wa_message_id);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL DEFAULT 'MARKETING' CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION')),
  body TEXT NOT NULL,                   -- text with {{1}}, {{2}} placeholders
  status TEXT NOT NULL DEFAULT 'APPROVED',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  template_id INTEGER NOT NULL REFERENCES templates(id),
  variables TEXT NOT NULL DEFAULT '[]', -- JSON array; supports {{name}} token per-contact
  audience_tag TEXT,                    -- null = all contacts
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','completed','cancelled')),
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','read','failed')),
  wa_message_id TEXT,
  error TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_br_bcast ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_br_waid ON broadcast_recipients(wa_message_id);

CREATE TABLE IF NOT EXISTS ai_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  is_active INTEGER NOT NULL DEFAULT 1,
  auto_assign_new INTEGER NOT NULL DEFAULT 1, -- pick up brand-new conversations automatically
  handoff_keywords TEXT NOT NULL DEFAULT '["human","agent","representative","person"]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---- Migrations for databases created before template<->Meta sync ----
const templateCols = db.prepare('PRAGMA table_info(templates)').all().map((c) => c.name);
if (!templateCols.includes('param_map')) db.exec("ALTER TABLE templates ADD COLUMN param_map TEXT NOT NULL DEFAULT '[]'");
if (!templateCols.includes('meta_id')) db.exec('ALTER TABLE templates ADD COLUMN meta_id TEXT');

// Ordered list of placeholder tokens in a template body, e.g.
// "Hi {{name}}, order {{1}} ships {{2}}" -> ["name","1","2"]. Meta templates
// only allow positional {{1}}..{{n}} params, so this map records what each
// position means when sending through the Cloud API.
export function computeParamMap(body) {
  return [...String(body).matchAll(/\{\{(name|\d+)\}\}/g)].map((m) => m[1]);
}

// Keep param_map in sync with bodies (covers seeds and older rows).
for (const t of db.prepare('SELECT id, body, param_map FROM templates').all()) {
  const map = JSON.stringify(computeParamMap(t.body));
  if (map !== t.param_map) db.prepare('UPDATE templates SET param_map = ? WHERE id = ?').run(map, t.id);
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

// ---- Seed data (first run only) ----
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const hash = (p) => bcrypt.hashSync(p, 10);
  const insertUser = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
  insertUser.run('Admin', 'admin@example.com', hash('admin123'), 'admin');
  insertUser.run('Ava Agent', 'ava@example.com', hash('agent123'), 'agent');
  insertUser.run('Ben Agent', 'ben@example.com', hash('agent123'), 'agent');

  const insertTemplate = db.prepare('INSERT INTO templates (name, language, category, body) VALUES (?, ?, ?, ?)');
  insertTemplate.run('welcome_offer', 'en', 'MARKETING',
    'Hi {{name}}! 🎉 Welcome to our store. Use code WELCOME10 for 10% off your first order.');
  insertTemplate.run('order_update', 'en', 'UTILITY',
    'Hi {{name}}, your order {{1}} has been shipped and will arrive by {{2}}.');
  insertTemplate.run('payment_reminder', 'en', 'UTILITY',
    'Hi {{name}}, this is a friendly reminder that your invoice {{1}} is due on {{2}}.');

  db.prepare(`INSERT INTO ai_agents (name, system_prompt) VALUES (?, ?)`).run(
    'Support Bot',
    'You are a friendly customer support assistant for an online store. Answer questions about orders, shipping (3-5 business days, free over $50), returns (30-day policy), and products. Keep replies short and suitable for WhatsApp. If you cannot help or the customer is upset, tell them you will connect them to a human teammate.'
  );

  setSetting('round_robin_cursor', '0');
  setSetting('sandbox_mode', '1');
}

export default db;
