import crypto from 'node:crypto';
import { LOCAL_SID } from './session.js';
import { readDoc, writeDoc } from './store.js';
import { defaultPreferences } from './professions.js';
import { defaultRoutine, runRoutine } from './routine.js';
import { enrichStories } from './summaries.js';

// Real scheduled routines. A scheduler the owner controls (GitHub Actions
// workflow, cron-job.org, or local cron) calls GET /api/cron/routine with the
// CRON_SECRET; this module checks due-ness and runs the same bounded,
// never-scheduling routine the "Run routine now" button runs. Single-owner
// design: the run fills the one shared workspace (LOCAL_SID), the same inbox
// the browser and the desktop companion already share.

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

// Pure due-check, exported for tests. All times are server-local; the owner
// aligns the external schedule and deliveryDay/deliveryTime to the same zone.
export function isDue(routine, nowMs = Date.now()) {
  if (!routine || routine.paused) return { due: false, reason: 'paused' };
  if (!Array.isArray(routine.interests) || !routine.interests.length) return { due: false, reason: 'no-interests' };
  const last = Date.parse(routine.lastRunAt || '');
  if (!Number.isNaN(last) && nowMs - last < CRON_MIN_GAP_HOURS * 3600 * 1000) {
    return { due: false, reason: 'ran-recently' }; // minimum gap guards double-fires
  }
  const slot = lastDeliverySlot(routine.deliveryDay, routine.deliveryTime, nowMs);
  if (!Number.isNaN(last) && last >= slot) return { due: false, reason: 'not-due' };
  return { due: true };
}

export async function executeScheduledRun({ sid, nowMs = Date.now() } = {}) {
  const target = sid || LOCAL_SID;
  const prefs = { ...defaultPreferences(), ...(await readDoc('user', target, 'preferences', {})) };
  const routine = { ...defaultRoutine(), ...((await readDoc('user', target, 'routine', null)) || {}) };
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
