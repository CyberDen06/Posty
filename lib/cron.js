import crypto from 'node:crypto';
import { LOCAL_SID } from './session.js';
import { readDoc, writeDoc } from './store.js';
import { defaultPreferences } from './professions.js';
import { coerceRoutine, runRoutine } from './routine.js';
import { enrichStories } from './summaries.js';

// Real scheduled routines, zero-setup: the user configures a routine in the
// app and it runs itself. Two drivers, no user wiring:
// - Deployed (Vercel): vercel.json crons call GET /api/cron/routine daily;
//   the due-check gates each user's cadence (daily runs daily, weekly runs
//   after the chosen weekday slots).
// - Local/VM (server.js): startLocalScheduler() ticks hourly while running.
// Both run the same bounded, never-scheduling routine as "Run routine now",
// into the one shared workspace (LOCAL_SID).
//
// Auth: the endpoint is OPEN unless CRON_SECRET is set. Vercel Cron cannot
// send secrets, so requiring one would force every user through technical
// setup for zero benefit — and the harm of an unsigned hit is nil by design:
// it can only add briefing suggestions (never schedule/publish), the 20h
// minimum gap turns repeat hits into no-ops, seen URLs are excluded, and the
// response leaks no data (counts only). Owners who want lockdown set
// CRON_SECRET (strict mode: callers must present it) and run their own
// scheduler — see HOSTING.md.

export const CRON_MIN_GAP_HOURS = 20;

export function cronSecretOk(candidate) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret || !candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lastDeliverySlot(dayName, timeHHMM, nowMs) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const want = Math.max(0, days.indexOf(dayName));
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(timeHHMM || ''));
  const hh = m ? Number(m[1]) : 9;
  const mm = m ? Number(m[2]) : 0;
  const d = new Date(nowMs);
  d.setHours(hh, mm, 0, 0);
  let back = (d.getDay() - want + 7) % 7;
  if (back === 0 && d.getTime() > nowMs) back = 7; // today's slot hasn't passed yet
  d.setDate(d.getDate() - back);
  return d.getTime();
}

// Effective delivery days: daily means every day; legacy docs carry a single
// deliveryDay instead of the deliveryDays array.
const ALL_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function deliveryDaysOf(routine) {
  if (routine?.cadence === 'daily') return ALL_WEEKDAYS;
  if (Array.isArray(routine?.deliveryDays) && routine.deliveryDays.length) return routine.deliveryDays;
  if (typeof routine?.deliveryDay === 'string' && routine.deliveryDay) return [routine.deliveryDay];
  return ['Monday'];
}

// Pure due-check, exported for tests. Due once the most recent delivery slot
// (among the cadence's days, at deliveryTime) has passed since the last run.
// All times are server-local (UTC on Vercel).
export function isDue(routine, nowMs = Date.now()) {
  if (!routine || routine.paused) return { due: false, reason: 'paused' };
  if (!Array.isArray(routine.interests) || !routine.interests.length) return { due: false, reason: 'no-interests' };
  const last = Date.parse(routine.lastRunAt || '');
  if (!Number.isNaN(last) && nowMs - last < CRON_MIN_GAP_HOURS * 3600 * 1000) {
    return { due: false, reason: 'ran-recently' }; // minimum gap guards double-fires
  }
  const slot = Math.max(...deliveryDaysOf(routine).map((d) => lastDeliverySlot(d, routine.deliveryTime, nowMs)));
  if (!Number.isNaN(last) && last >= slot) return { due: false, reason: 'not-due' };
  return { due: true };
}

// Strict mode is opt-in: only when CRON_SECRET is set must callers present it.
export function cronLocked() {
  return Boolean(process.env.CRON_SECRET);
}

// Local automatic runs: tick on an interval and run the saved routine when
// its delivery slot has passed (paused/empty/recent runs refuse inside the
// check, before any provider is touched). server.js starts this; Vercel
// never runs it (api/index.js doesn't import server.js) and uses vercel.json
// crons instead. Returns a stop function. Runs only ever add briefing
// suggestions — they never schedule or publish.
export function startLocalScheduler({ intervalMs = 3600 * 1000, delayMs = 60 * 1000, log = console.log } = {}) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    executeScheduledRun({}).then((r) => {
      if (r.ran || r.reason !== 'not-due') log(`[posty] scheduler tick ran=${r.ran}${r.reason ? ` reason=${r.reason}` : ` added=${r.added}`}`);
    }).catch((e) => log(`[posty] scheduler tick failed (${e.message})`));
  };
  const first = setTimeout(tick, delayMs);
  const every = setInterval(tick, intervalMs);
  if (first.unref) first.unref();
  if (every.unref) every.unref();
  return () => { stopped = true; clearTimeout(first); clearInterval(every); };
}

export async function executeScheduledRun({ sid, nowMs = Date.now() } = {}) {
  const target = sid || LOCAL_SID;
  const prefs = { ...defaultPreferences(), ...(await readDoc('user', target, 'preferences', {})) };
  const routine = coerceRoutine(await readDoc('user', target, 'routine', null));
  const due = isDue(routine, nowMs);
  if (!due.due) return { ran: false, reason: due.reason, at: new Date(nowMs).toISOString() };
  const inbox = await readDoc('user', target, 'inbox', []);
  const exclude = inbox.map((i) => i.story?.canonical || i.story?.url).filter(Boolean);
  const { items, warnings } = await runRoutine({
    prefs, routine, excludeUrls: exclude,
    styleSamples: prefs.useStyleRefs ? prefs.styleSamples : [],
  });
  await enrichStories(items.map((i) => i.story));
  await writeDoc('user', target, 'inbox', [...items, ...inbox].slice(0, 150));
  const updated = {
    ...routine,
    lastRunAt: new Date(nowMs).toISOString(),
    runs: (routine.runs || 0) + 1,
    lastResult: { added: items.length, warnings, via: 'cron' },
  };
  await writeDoc('user', target, 'routine', updated);
  return { ran: true, added: items.length, warnings, at: updated.lastRunAt };
}
