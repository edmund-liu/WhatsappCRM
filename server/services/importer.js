// Bulk contact import from CSV or XLSX.
//
// Parses a file into rows, maps the header row to name/phone/tags columns,
// then upserts each contact (creating new ones, merging tags into existing
// ones by WhatsApp number). Returns a per-file summary.
import db from '../db.js';
import { emit } from './events.js';
import { readXlsx } from './xlsx.js';

// RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, and
// newlines inside quotes.
export function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  text = text.replace(/^﻿/, ''); // strip BOM Excel adds
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* ignore, handled by \n */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

// Detect XLSX by ZIP magic bytes ("PK"), else treat as CSV text.
export function parseFile(buffer) {
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return readXlsx(buffer);
  return parseCsv(buffer.toString('utf8'));
}

function findColumns(header) {
  const norm = header.map((h) => String(h).toLowerCase().trim());
  const find = (re) => norm.findIndex((h) => re.test(h));
  return {
    name: find(/^(name|full ?name|contact ?name)$/),
    phone: find(/phone|mobile|number|wa[_ ]?id|whatsapp/),
    tags: find(/tag/),
  };
}

const splitTags = (cell) => String(cell || '').split(/[;,|]/).map((t) => t.trim()).filter(Boolean);

export async function importContacts(buffer) {
  let rows;
  try {
    rows = parseFile(buffer);
  } catch (err) {
    return { error: `Could not read the file: ${err.message}` };
  }
  rows = rows.filter((r) => r.some((c) => c !== '')); // drop blank lines
  if (rows.length < 2) return { error: 'The file has no data rows. Download the template for the expected format.' };

  const cols = findColumns(rows[0]);
  if (cols.phone < 0) {
    return { error: 'Could not find a phone/number column. Make sure the first row has headers like "name, phone, tags" — download the template for reference.' };
  }

  const result = { imported: 0, updated: 0, skipped: 0, total: rows.length - 1, errors: [] };
  const seen = new Set();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const phone = String(row[cols.phone] || '').replace(/\D/g, '');
    const name = cols.name >= 0 ? (row[cols.name] || '').trim() : '';
    const tags = cols.tags >= 0 ? splitTags(row[cols.tags]) : [];

    if (!phone || phone.length < 6) {
      result.skipped++;
      if (result.errors.length < 20) result.errors.push({ row: i + 1, reason: `Missing or invalid phone number ("${row[cols.phone] || ''}")` });
      continue;
    }
    if (seen.has(phone)) { result.skipped++; continue; } // duplicate within the file
    seen.add(phone);

    try {
      const existing = await db.prepare('SELECT * FROM contacts WHERE wa_id = ?').get(phone);
      if (existing) {
        const merged = [...new Set([...JSON.parse(existing.tags || '[]'), ...tags])];
        await db.prepare('UPDATE contacts SET name = ?, tags = ? WHERE id = ?')
          .run(name || existing.name, JSON.stringify(merged), existing.id);
        result.updated++;
      } else {
        await db.prepare('INSERT INTO contacts (wa_id, name, tags) VALUES (?, ?, ?)')
          .run(phone, name || null, JSON.stringify(tags));
        result.imported++;
      }
    } catch (err) {
      result.skipped++;
      if (result.errors.length < 20) result.errors.push({ row: i + 1, reason: err.message });
    }
  }

  if (result.imported || result.updated) emit('contact_created', {});
  return result;
}
