// Live customer-data lookup via a configurable webhook.
//
// When an admin sets a data webhook URL, the CRM POSTs a contact's WhatsApp
// number to it and expects JSON back — typically account/order details pulled
// from Shopify, a billing system, or any custom backend. That data is shown
// in the contact panel and fed to AI agents, so "where's my order?" /
// "what's my balance?" get answered from real data instead of bouncing the
// customer to search or a human.
//
// Expected response shape (all optional): a flat JSON object whose string/
// number values are shown as rows; an optional `summary` string is
// highlighted; an optional `orders`/`items` array of objects is listed
// compactly. Anything else is ignored for display but still given to the AI.
import { getSetting } from '../db.js';

const cache = new Map(); // wa_id -> { data, ts }
const TTL_MS = 60000;

export async function isExternalDataConfigured() {
  return Boolean(await getSetting('data_webhook_url'));
}

export async function fetchExternalData(contact, { force = false } = {}) {
  const url = await getSetting('data_webhook_url');
  if (!url || !contact?.wa_id) return null;

  const cached = cache.get(contact.wa_id);
  if (!force && cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const secret = await getSetting('data_webhook_secret');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Webhook-Secret': secret } : {}) },
      body: JSON.stringify({ wa_id: contact.wa_id, name: contact.name || null }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
    const data = await res.json();
    cache.set(contact.wa_id, { data, ts: Date.now() });
    return data;
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timed out' : err.message;
    return { _error: `Couldn't load live data (${reason})` };
  } finally {
    clearTimeout(timer);
  }
}

// Compact text block for the AI system prompt.
export function externalDataContextBlock(data) {
  if (!data || data._error) return '';
  const lines = [];
  if (data.summary) lines.push(String(data.summary));
  for (const [k, v] of Object.entries(data)) {
    if (k === 'summary' || k.startsWith('_')) continue;
    if (v == null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: ${v.map((it) => (typeof it === 'object' ? JSON.stringify(it) : it)).join('; ')}`);
    } else if (typeof v !== 'object') {
      lines.push(`- ${k}: ${v}`);
    }
  }
  if (!lines.length) return '';
  return `\n\nLive account/order data for this customer (from our systems; use it to answer directly, never invent beyond it):\n${lines.join('\n')}`;
}
