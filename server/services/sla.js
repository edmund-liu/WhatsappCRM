// Response-time SLA tracking.
//
// The metric is customer wait time: a conversation starts "awaiting" the
// moment a customer message arrives with nothing sent back yet, and stops the
// instant any outbound message (agent, AI, template, or auto-reply) goes out.
// A configurable target turns that into a live countdown and a breach signal;
// the first wait per conversation is also recorded for average-first-response
// reporting.
import db, { getSetting, setSetting } from '../db.js';

const DEFAULT_RESPONSE_MINUTES = 30;

export async function getSlaConfig() {
  return {
    enabled: (await getSetting('sla_enabled', '0')) === '1',
    responseMinutes: parseInt(await getSetting('sla_response_minutes', String(DEFAULT_RESPONSE_MINUTES)), 10) || DEFAULT_RESPONSE_MINUTES,
  };
}

export async function setSlaConfig({ enabled, responseMinutes }) {
  if (enabled !== undefined) await setSetting('sla_enabled', enabled ? '1' : '0');
  if (responseMinutes !== undefined) await setSetting('sla_response_minutes', String(Math.max(1, parseInt(responseMinutes, 10) || DEFAULT_RESPONSE_MINUTES)));
}

// Postgres returns TIMESTAMPTZ as Date; SQLite returns TEXT (UTC, no zone).
export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  return new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
}

// Compact status attached to conversation payloads. `dueAt` is deterministic
// from awaiting_since + target (stable across polls, so it won't cause UI
// churn); the client derives the live countdown and breach color from it.
export function slaStatusFor(conv, config, now = new Date()) {
  if (!config.enabled || !conv.awaiting_since) return { active: false };
  const since = toDate(conv.awaiting_since);
  const dueAt = new Date(since.getTime() + config.responseMinutes * 60000);
  return {
    active: true,
    dueAt: dueAt.toISOString(),
    breached: now.getTime() >= dueAt.getTime(),
    targetMinutes: config.responseMinutes,
  };
}

// Called when a customer message arrives: begin the clock if it isn't already
// running (earliest unanswered message is what "waiting since" should mean).
export async function markAwaiting(conversationId) {
  await db.prepare(
    'UPDATE conversations SET awaiting_since = COALESCE(awaiting_since, CURRENT_TIMESTAMP) WHERE id = ?'
  ).run(conversationId);
}

// Called after any outbound message: the customer is no longer waiting. For a
// real reply (agent/AI), record the first-ever response time for reporting;
// automated acknowledgements (after-hours away message, STOP/START
// confirmation) clear the clock but are excluded from the metric so they
// don't make average first-response look artificially instant.
export async function recordResponse(conversationId, { countAsFirstResponse = true } = {}) {
  const conv = await db.prepare('SELECT awaiting_since, first_response_seconds FROM conversations WHERE id = ?').get(conversationId);
  if (!conv || !conv.awaiting_since) return;
  if (countAsFirstResponse && conv.first_response_seconds == null) {
    const since = toDate(conv.awaiting_since);
    const seconds = Math.max(0, Math.round((Date.now() - since.getTime()) / 1000));
    await db.prepare('UPDATE conversations SET first_response_seconds = ?, awaiting_since = NULL WHERE id = ?').run(seconds, conversationId);
  } else {
    await db.prepare('UPDATE conversations SET awaiting_since = NULL WHERE id = ?').run(conversationId);
  }
}
