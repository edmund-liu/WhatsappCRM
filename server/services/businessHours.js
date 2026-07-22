// Business hours + holiday calendar.
//
// Determines whether "now" (in the configured IANA timezone) falls inside
// the weekly schedule and isn't a holiday, and computes a friendly label for
// when the team will next be open — used to fill the configurable away
// message. Uses only Intl.DateTimeFormat (Node ships full ICU), so no
// timezone library dependency is needed.
import db, { getSetting, setSetting } from '../db.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

function defaultSchedule() {
  const weekday = { open: '09:00', close: '18:00' };
  return { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: null, sun: null };
}

export async function getBusinessHoursConfig() {
  const enabled = (await getSetting('business_hours_enabled', '0')) === '1';
  const timezone = await getSetting('business_hours_timezone', 'UTC');
  let schedule;
  try { schedule = JSON.parse(await getSetting('business_hours_schedule', '')) || defaultSchedule(); }
  catch { schedule = defaultSchedule(); }
  const awayMessage = await getSetting(
    'business_hours_away_message',
    "Hi {{name}}! Thanks for messaging us. We're {{reason}} right now — our team will get back to you when we reopen {{next_open}}. 🙏"
  );
  return { enabled, timezone, schedule, awayMessage };
}

export async function setBusinessHoursConfig({ enabled, timezone, schedule, awayMessage }) {
  if (enabled !== undefined) await setSetting('business_hours_enabled', enabled ? '1' : '0');
  if (timezone !== undefined) await setSetting('business_hours_timezone', timezone);
  if (schedule !== undefined) await setSetting('business_hours_schedule', JSON.stringify(schedule));
  if (awayMessage !== undefined) await setSetting('business_hours_away_message', awayMessage);
}

// Resolve "now" inside `timezone` into the parts we need, without any
// timezone math of our own — Intl does the DST/offset handling.
function zonedParts(timezone, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const dayMap = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
  const hour = parts.hour === '24' ? 0 : parseInt(parts.hour, 10); // some locales report midnight as 24
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: dayMap[parts.weekday],
    minutes: hour * 60 + parseInt(parts.minute, 10),
  };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

function isWithinWindow(minutesNow, open, close) {
  const o = toMinutes(open), c = toMinutes(close);
  if (c > o) return minutesNow >= o && minutesNow < c; // same-day window
  if (c < o) return minutesNow >= o || minutesNow < c; // overnight window (e.g. 22:00-06:00)
  return false; // open === close means never open
}

export async function isHoliday(dateStr) {
  const row = await db.prepare('SELECT name FROM holidays WHERE date = ?').get(dateStr);
  return row ? (row.name || 'a holiday') : null;
}

// { enabled, withinHours, reason, holidayName, dateStr, config }
export async function getBusinessHoursStatus(date = new Date()) {
  const config = await getBusinessHoursConfig();
  if (!config.enabled) return { enabled: false, withinHours: true, config };

  const { dateStr, weekday, minutes } = zonedParts(config.timezone, date);
  const holidayName = await isHoliday(dateStr);
  if (holidayName) {
    return { enabled: true, withinHours: false, reason: `closed for ${holidayName}`, holidayName, dateStr, config };
  }
  const todaySlot = config.schedule[weekday];
  if (!todaySlot) {
    return { enabled: true, withinHours: false, reason: 'outside our business hours', holidayName: null, dateStr, config };
  }
  const within = isWithinWindow(minutes, todaySlot.open, todaySlot.close);
  return {
    enabled: true, withinHours: within,
    reason: within ? null : 'outside our business hours',
    holidayName: null, dateStr, config,
  };
}

// Friendly label for the next opening, e.g. "today at 2:00 PM",
// "tomorrow at 9:00 AM", or "Monday, Jan 6 at 9:00 AM".
export async function computeNextOpenLabel(config, fromDate = new Date()) {
  const { timezone, schedule } = config;
  const nowParts = zonedParts(timezone, fromDate);

  for (let offset = 0; offset <= 13; offset++) {
    const candidate = new Date(fromDate.getTime() + offset * 86400000);
    const parts = zonedParts(timezone, candidate);
    const slot = schedule[parts.weekday];
    if (!slot) continue;
    if (await isHoliday(parts.dateStr)) continue;
    const openMinutes = toMinutes(slot.open);
    // Today only counts if the open time hasn't already passed.
    if (offset === 0 && openMinutes <= nowParts.minutes) continue;

    const hour = Math.floor(openMinutes / 60);
    const minute = openMinutes % 60;
    const timeLabel = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
      .format(new Date(Date.UTC(2000, 0, 1, hour, minute)));

    let dayLabel;
    if (offset === 0) dayLabel = 'today';
    else if (offset === 1) dayLabel = 'tomorrow';
    else {
      const md = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(candidate);
      dayLabel = `${DAY_LABELS[parts.weekday]}, ${md}`;
    }
    return `${dayLabel} at ${timeLabel}`;
  }
  return 'soon'; // schedule is entirely closed / all upcoming days are holidays
}

export function renderAwayMessage(template, { name, reason, nextOpenLabel }) {
  return String(template)
    .replaceAll('{{name}}', name || 'there')
    .replaceAll('{{reason}}', reason || 'outside our business hours')
    .replaceAll('{{next_open}}', nextOpenLabel || 'soon');
}

export { DAY_KEYS, DAY_LABELS, defaultSchedule };
