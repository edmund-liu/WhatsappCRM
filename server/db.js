// Database layer with two interchangeable backends behind one async API:
//
//  - Built-in SQLite (node:sqlite, Node >= 22.5): zero-setup default for
//    local/always-on hosting. File lives in the data dir.
//  - Postgres: used automatically when DATABASE_URL (or POSTGRES_URL) is set.
//    This is the right choice on serverless hosts like Vercel, where local
//    disk is ephemeral and per-instance — a shared Postgres (Neon, Supabase,
//    Vercel Postgres) makes data persistent and consistent across instances.
//
// The API mirrors better-sqlite3 ergonomics but async:
//   await db.prepare(sql).get(...args) / .all(...args) / .run(...args)
//   await db.exec(sql)
// SQL is written in SQLite dialect with '?' placeholders; the Postgres
// backend translates placeholders and returns INSERT ids via RETURNING.
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR
  || (process.env.VERCEL ? '/tmp/whatsappcrm-data' : path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;
export const DIALECT = PG_URL ? 'pg' : 'sqlite';

let db;

if (DIALECT === 'pg') {
  const { default: pg } = await import('pg');
  // COUNT()/SUM() come back as strings by default — parse them.
  pg.types.setTypeParser(20, (v) => parseInt(v, 10));       // int8
  pg.types.setTypeParser(1700, (v) => parseFloat(v));       // numeric
  const pool = new pg.Pool({
    connectionString: PG_URL,
    max: process.env.VERCEL ? 3 : 10,
    ssl: /localhost|127\.0\.0\.1/.test(PG_URL) ? false : { rejectUnauthorized: false },
  });
  const toPg = (sql) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  db = {
    prepare(sql) {
      const pgSql = toPg(sql);
      return {
        async get(...args) { return (await pool.query(pgSql, args)).rows[0]; },
        async all(...args) { return (await pool.query(pgSql, args)).rows; },
        async run(...args) {
          let q = pgSql;
          if (/^\s*insert/i.test(q) && !/returning/i.test(q)) q += ' RETURNING *';
          const r = await pool.query(q, args);
          return { changes: r.rowCount, lastInsertRowid: r.rows?.[0]?.id ?? null };
        },
      };
    },
    async exec(sql) { await pool.query(sql); },
  };
} else {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    console.error('\nThis app needs Node.js 22.5 or newer (built-in SQLite support).');
    console.error(`You are running Node ${process.version}. Please upgrade: https://nodejs.org\n`);
    process.exit(1);
  }
  const sqlite = new DatabaseSync(path.join(DATA_DIR, 'crm.sqlite'));
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  db = {
    prepare(sql) {
      return {
        async get(...args) { return sqlite.prepare(sql).get(...args); },
        async all(...args) { return sqlite.prepare(sql).all(...args); },
        async run(...args) { return sqlite.prepare(sql).run(...args); },
      };
    },
    async exec(sql) { sqlite.exec(sql); },
    _sqlite: sqlite,
  };
}

// Dialect helpers for the few queries that can't be written portably.
export const SQL = {
  // timestamp N units ago, e.g. ago('1 day')
  ago: (interval) => DIALECT === 'pg'
    ? `NOW() - INTERVAL '${interval}'`
    : `datetime('now', '-${interval}')`,
  // YYYY-MM-DD day bucket for a timestamp column
  day: (col) => DIALECT === 'pg' ? `TO_CHAR(${col}::date, 'YYYY-MM-DD')` : `date(${col})`,
  // Unix epoch seconds for a timestamp column (for duration math)
  epoch: (col) => DIALECT === 'pg' ? `EXTRACT(EPOCH FROM ${col})` : `CAST(strftime('%s', ${col}) AS INTEGER)`,
};

// ---------- Schema ----------
const ID_PK = DIALECT === 'pg' ? 'INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const NOW_DEFAULT = DIALECT === 'pg' ? 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' : "TEXT NOT NULL DEFAULT (datetime('now'))";
const TS = DIALECT === 'pg' ? 'TIMESTAMPTZ' : 'TEXT';

await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id ${ID_PK},
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin','agent')),
  is_active INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1,
  skills TEXT NOT NULL DEFAULT '[]',
  created_at ${NOW_DEFAULT}
);

CREATE TABLE IF NOT EXISTS contacts (
  id ${ID_PK},
  wa_id TEXT NOT NULL UNIQUE,      -- WhatsApp number, or a web-chat visitor id
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  name TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  attributes TEXT NOT NULL DEFAULT '{}',
  opted_out INTEGER NOT NULL DEFAULT 0,
  created_at ${NOW_DEFAULT},
  last_message_at ${TS}
);

CREATE TABLE IF NOT EXISTS conversations (
  id ${ID_PK},
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved')),
  assigned_user_id INTEGER REFERENCES users(id),
  ai_agent_id INTEGER,
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  required_skill TEXT,
  away_notified_on TEXT,   -- business-tz date we last sent an out-of-hours reply
  awaiting_since ${TS},              -- when the current unanswered-customer period began (SLA clock)
  first_response_seconds INTEGER,    -- historical: seconds to the first outbound response
  resolved_at ${TS},                 -- when the conversation was marked resolved
  awaiting_csat INTEGER NOT NULL DEFAULT 0,  -- a satisfaction survey was sent, waiting for a rating
  csat_score INTEGER,                -- customer's satisfaction rating
  csat_comment TEXT,                 -- optional free-text left after the rating
  csat_at ${TS},                     -- when the rating was received
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at ${TS},
  last_message_preview TEXT,
  created_at ${NOW_DEFAULT}
);
CREATE INDEX IF NOT EXISTS idx_conv_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conv_assigned ON conversations(assigned_user_id);

CREATE TABLE IF NOT EXISTS messages (
  id ${ID_PK},
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
  media_url TEXT,
  buttons TEXT NOT NULL DEFAULT '[]',
  created_at ${NOW_DEFAULT}
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msg_waid ON messages(wa_message_id);

CREATE TABLE IF NOT EXISTS templates (
  id ${ID_PK},
  name TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL DEFAULT 'en',
  category TEXT NOT NULL DEFAULT 'MARKETING' CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'APPROVED',
  param_map TEXT NOT NULL DEFAULT '[]',
  meta_id TEXT,
  header_image_url TEXT,
  buttons TEXT NOT NULL DEFAULT '[]',
  created_at ${NOW_DEFAULT}
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id ${ID_PK},
  name TEXT NOT NULL,
  template_id INTEGER NOT NULL REFERENCES templates(id),
  variables TEXT NOT NULL DEFAULT '[]',
  audience_tag TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','completed','cancelled')),
  scheduled_at ${TS},
  started_at ${TS},
  completed_at ${TS},
  created_by INTEGER REFERENCES users(id),
  header_image_url TEXT,
  created_at ${NOW_DEFAULT}
);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id ${ID_PK},
  broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','read','failed')),
  wa_message_id TEXT,
  error TEXT,
  sent_at ${TS}
);
CREATE INDEX IF NOT EXISTS idx_br_bcast ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_br_waid ON broadcast_recipients(wa_message_id);

CREATE TABLE IF NOT EXISTS ai_agents (
  id ${ID_PK},
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  is_active INTEGER NOT NULL DEFAULT 1,
  auto_assign_new INTEGER NOT NULL DEFAULT 1,
  handoff_keywords TEXT NOT NULL DEFAULT '["human","agent","representative","person"]',
  skills TEXT NOT NULL DEFAULT '[]',
  created_at ${NOW_DEFAULT}
);

CREATE TABLE IF NOT EXISTS skills (
  id ${ID_PK},
  name TEXT NOT NULL UNIQUE,
  keywords TEXT NOT NULL DEFAULT '[]',
  created_at ${NOW_DEFAULT}
);

CREATE TABLE IF NOT EXISTS holidays (
  id ${ID_PK},
  date TEXT NOT NULL UNIQUE,   -- YYYY-MM-DD in the business timezone
  name TEXT,
  created_at ${NOW_DEFAULT}
);

CREATE TABLE IF NOT EXISTS canned_replies (
  id ${ID_PK},
  shortcut TEXT NOT NULL UNIQUE,  -- typed after "/" in the composer
  title TEXT,
  body TEXT NOT NULL,             -- supports {{name}} personalization
  created_at ${NOW_DEFAULT}
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---------- Column migrations (both dialects) ----------
// Fresh databases get every column from CREATE TABLE above, but an existing
// database (e.g. a live Postgres on Vercel created before a feature shipped)
// needs the new columns added. Postgres supports ADD COLUMN IF NOT EXISTS;
// SQLite needs a PRAGMA check first.
const addColumnIfMissing = async (table, column, ddl) => {
  if (DIALECT === 'pg') {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ddl}`);
  } else {
    const cols = db._sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db._sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
};
await addColumnIfMissing('users', 'skills', "skills TEXT NOT NULL DEFAULT '[]'");
await addColumnIfMissing('ai_agents', 'skills', "skills TEXT NOT NULL DEFAULT '[]'");
await addColumnIfMissing('conversations', 'required_skill', 'required_skill TEXT');
await addColumnIfMissing('templates', 'param_map', "param_map TEXT NOT NULL DEFAULT '[]'");
await addColumnIfMissing('templates', 'meta_id', 'meta_id TEXT');
await addColumnIfMissing('templates', 'header_image_url', 'header_image_url TEXT');
await addColumnIfMissing('templates', 'buttons', "buttons TEXT NOT NULL DEFAULT '[]'");
await addColumnIfMissing('broadcasts', 'header_image_url', 'header_image_url TEXT');
await addColumnIfMissing('messages', 'media_url', 'media_url TEXT');
await addColumnIfMissing('messages', 'buttons', "buttons TEXT NOT NULL DEFAULT '[]'");
await addColumnIfMissing('messages', 'mentions', "mentions TEXT NOT NULL DEFAULT '[]'"); // @mentioned user ids in internal notes
// Multi-channel: which channel a contact reaches us on (whatsapp | webchat | ...)
await addColumnIfMissing('contacts', 'channel', "channel TEXT NOT NULL DEFAULT 'whatsapp'");
await addColumnIfMissing('conversations', 'away_notified_on', 'away_notified_on TEXT');
// SLA tracking
await addColumnIfMissing('conversations', 'awaiting_since', `awaiting_since ${TS}`);
await addColumnIfMissing('conversations', 'first_response_seconds', 'first_response_seconds INTEGER');
await addColumnIfMissing('conversations', 'resolved_at', `resolved_at ${TS}`);
// CSAT (post-resolution satisfaction survey)
await addColumnIfMissing('conversations', 'awaiting_csat', 'awaiting_csat INTEGER NOT NULL DEFAULT 0');
await addColumnIfMissing('conversations', 'csat_score', 'csat_score INTEGER');
await addColumnIfMissing('conversations', 'csat_comment', 'csat_comment TEXT');
await addColumnIfMissing('conversations', 'csat_at', `csat_at ${TS}`);

// Ordered list of placeholder tokens in a template body, e.g.
// "Hi {{name}}, order {{1}} ships {{2}}" -> ["name","1","2"]. Meta templates
// only allow positional {{1}}..{{n}} params, so this map records what each
// position means when sending through the Cloud API.
export function computeParamMap(body) {
  return [...String(body).matchAll(/\{\{(name|\d+)\}\}/g)].map((m) => m[1]);
}

export async function getSetting(key, fallback = null) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

// Keep param_map in sync with bodies (covers seeds and older rows).
for (const t of await db.prepare('SELECT id, body, param_map FROM templates').all()) {
  const map = JSON.stringify(computeParamMap(t.body));
  if (map !== t.param_map) await db.prepare('UPDATE templates SET param_map = ? WHERE id = ?').run(map, t.id);
}

// One conversation per contact: heal any historical splits (databases created
// before this rule could have several conversation rows per number) by merging
// each contact's conversations into the earliest one, then enforce it with a
// unique index so a number's full history always stays in a single thread.
const dupContacts = await db.prepare(
  'SELECT contact_id FROM conversations GROUP BY contact_id HAVING COUNT(*) > 1'
).all();
for (const { contact_id } of dupContacts) {
  const convs = await db.prepare('SELECT * FROM conversations WHERE contact_id = ? ORDER BY id').all(contact_id);
  const keep = convs[0];
  for (const extra of convs.slice(1)) {
    await db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?').run(keep.id, extra.id);
  }
  const anyOpen = convs.some((c) => c.status !== 'resolved');
  const unread = convs.reduce((s, c) => s + (c.unread_count || 0), 0);
  const last = await db.prepare('SELECT body, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(keep.id);
  await db.prepare('UPDATE conversations SET status = ?, unread_count = ?, last_message_at = ?, last_message_preview = ? WHERE id = ?')
    .run(anyOpen ? 'open' : keep.status, unread, last?.created_at ?? keep.last_message_at,
      (last?.body ?? keep.last_message_preview ?? '').slice(0, 120), keep.id);
  await db.prepare('DELETE FROM conversations WHERE contact_id = ? AND id != ?').run(contact_id, keep.id);
}
await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_contact_unique ON conversations(contact_id)');

// ---------- Seed data (first run only) ----------
const userCount = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c;
if (userCount === 0) {
  const hash = (p) => bcrypt.hashSync(p, 10);
  const insertUser = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
  await insertUser.run('Admin', 'admin@example.com', hash('admin123'), 'admin');
  await insertUser.run('Ava Agent', 'ava@example.com', hash('agent123'), 'agent');
  await insertUser.run('Ben Agent', 'ben@example.com', hash('agent123'), 'agent');

  const insertTemplate = db.prepare('INSERT INTO templates (name, language, category, body) VALUES (?, ?, ?, ?)');
  await insertTemplate.run('welcome_offer', 'en', 'MARKETING',
    'Hi {{name}}! 🎉 Welcome to our store. Use code WELCOME10 for 10% off your first order.');
  await insertTemplate.run('order_update', 'en', 'UTILITY',
    'Hi {{name}}, your order {{1}} has been shipped and will arrive by {{2}}.');
  await insertTemplate.run('payment_reminder', 'en', 'UTILITY',
    'Hi {{name}}, this is a friendly reminder that your invoice {{1}} is due on {{2}}.');
  await db.prepare('INSERT INTO templates (name, language, category, body, header_image_url, buttons) VALUES (?, ?, ?, ?, ?, ?)').run(
    'summer_sale', 'en', 'MARKETING',
    'Hi {{name}}! ☀️ Our summer sale is on — up to {{1}} off everything this week only.',
    'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800&q=60',
    JSON.stringify([
      { type: 'URL', text: '🛍 Shop now', url: 'https://example.com/sale' },
      { type: 'QUICK_REPLY', text: 'Tell me more' },
      { type: 'QUICK_REPLY', text: 'Unsubscribe' },
    ]));

  await db.prepare('INSERT INTO ai_agents (name, system_prompt) VALUES (?, ?)').run(
    'Support Bot',
    'You are a friendly customer support assistant for an online store. Answer questions about orders, shipping (3-5 business days, free over $50), returns (30-day policy), and products. Keep replies short and suitable for WhatsApp. If you cannot help or the customer is upset, tell them you will connect them to a human teammate.'
  );

  await setSetting('round_robin_cursor', '0');
  await setSetting('sandbox_mode', '1');
}

// Seed routing skills once (also backfills databases created before
// skill-based routing existed).
if (!(await getSetting('skills_seeded'))) {
  if ((await db.prepare('SELECT COUNT(*) AS c FROM skills').get()).c === 0) {
    const insertSkill = db.prepare('INSERT INTO skills (name, keywords) VALUES (?, ?)');
    await insertSkill.run('billing', JSON.stringify(['invoice', 'payment', 'refund', 'charge', 'billing', 'charged', 'subscription']));
    await insertSkill.run('shipping', JSON.stringify(['shipping', 'delivery', 'deliver', 'track', 'shipment', 'order status', 'where is my order', 'arrived']));
    await insertSkill.run('technical', JSON.stringify(['error', 'bug', 'not working', 'broken', 'crash', 'install', 'login problem', "doesn't work"]));
    await insertSkill.run('sales', JSON.stringify(['price', 'pricing', 'buy', 'purchase', 'discount', 'quote', 'demo', 'upgrade']));
    await db.prepare("UPDATE users SET skills = ? WHERE email = 'ava@example.com'").run(JSON.stringify(['billing', 'sales']));
    await db.prepare("UPDATE users SET skills = ? WHERE email = 'ben@example.com'").run(JSON.stringify(['shipping', 'technical']));
  }
  await setSetting('skills_seeded', '1');
}

// Seed a few canned replies once, so the "/" snippet picker isn't empty.
if (!(await getSetting('canned_seeded'))) {
  if ((await db.prepare('SELECT COUNT(*) AS c FROM canned_replies').get()).c === 0) {
    const ins = db.prepare('INSERT INTO canned_replies (shortcut, title, body) VALUES (?, ?, ?)');
    await ins.run('hi', 'Greeting', 'Hi {{name}}! 👋 Thanks for reaching out. How can I help you today?');
    await ins.run('shipping', 'Shipping info', 'Standard shipping takes 3–5 business days and is free on orders over $50. 🚚');
    await ins.run('returns', 'Return policy', 'We offer a 30-day return policy on all items. Reply with your order number and I can start the process for you.');
    await ins.run('thanks', 'Sign-off', "You're welcome, {{name}}! Is there anything else I can help you with? 😊");
  }
  await setSetting('canned_seeded', '1');
}

export default db;
