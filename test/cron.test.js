import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Hermetic store + cron secret for this file (node --test isolates files).
const tmpData = path.join(os.tmpdir(), `posty-cron-test-${process.pid}`);
process.env.DATA_DIR = tmpData;
process.env.CRON_SECRET = 'test-cron-secret';
test.after(() => {
  fs.rmSync(tmpData, { recursive: true, force: true });
  delete process.env.CRON_SECRET;
});

const { cronSecretOk, cronLocked, isDue, nextSlotMs, startLocalScheduler, CRON_MIN_GAP_HOURS } = await import('../lib/cron.js');
const { handleNodeRequest } = await import('../lib/app.js');

function mockRes() {
  const headers = {};
  const res = {
    headers,
    statusCode: 0,
    body: '',
    writableEnded: false,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    writeHead(status, h = {}) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = v;
    },
    end(b = '') { res.body += b; res.writableEnded = true; },
  };
  return res;
}

function jsonReq({ method, url, json, headers = {} }) {
  const buf = json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json));
  const handlers = {};
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3000', ...headers },
    socket: { remoteAddress: '127.0.0.1' }, // loopback → shared workspace, like the companion
    on(ev, fn) {
      (handlers[ev] ||= []).push(fn);
      if (ev === 'end') {
        queueMicrotask(() => {
          if (buf.length) (handlers.data || []).forEach((f) => f(buf));
          (handlers.end || []).forEach((f) => f());
        });
      }
      return this;
    },
    destroy() {},
  };
}

async function call(req) {
  const res = mockRes();
  await handleNodeRequest(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body || '{}') };
}

test('cron secret check rejects wrong, missing, and unconfigured secrets', () => {
  assert.equal(cronSecretOk('test-cron-secret'), true);
  assert.equal(cronSecretOk('wrong'), false);
  assert.equal(cronSecretOk(''), false);
  assert.equal(cronSecretOk(undefined), false);
  delete process.env.CRON_SECRET;
  assert.equal(cronSecretOk('test-cron-secret'), false);
  process.env.CRON_SECRET = 'test-cron-secret';
});

test('isDue short-circuits paused, empty, and recently-run routines', () => {
  assert.deepEqual(isDue({ paused: true, interests: ['x'] }).reason, 'paused');
  assert.deepEqual(isDue({ paused: false, interests: [] }).reason, 'no-interests');
  assert.deepEqual(isDue(null).reason, 'paused');
  assert.equal(isDue({ paused: false, interests: ['x'] }).due, true); // never ran → due
  const recent = new Date(Date.now() - 3600 * 1000).toISOString();
  assert.deepEqual(isDue({ paused: false, interests: ['x'], lastRunAt: recent }).reason, 'ran-recently');
  assert.ok(CRON_MIN_GAP_HOURS >= 20);
});

test('isDue fires once per weekly slot, after the delivery moment', () => {
  // Most recent Monday 09:00 server-local.
  const slot = new Date();
  slot.setHours(9, 0, 0, 0);
  slot.setDate(slot.getDate() - ((slot.getDay() + 6) % 7));
  const r = { paused: false, interests: ['x'], deliveryDay: 'Monday', deliveryTime: '09:00' };
  // A run from before the slot, checked after it (plus the min gap) → due.
  const now = slot.getTime() + (CRON_MIN_GAP_HOURS + 1) * 3600 * 1000;
  assert.equal(isDue({ ...r, lastRunAt: new Date(slot.getTime() - 1000).toISOString() }, now).due, true);
  // A run already past this week's slot → not due (gap satisfied, slot not passed again).
  const afterSlot = slot.getTime() + 3600 * 1000;
  const later = afterSlot + (CRON_MIN_GAP_HOURS + 1) * 3600 * 1000;
  const res = isDue({ ...r, lastRunAt: new Date(afterSlot).toISOString() }, later);
  if (new Date(later).getDay() === 1 && later >= slot.getTime() + 7 * 86400 * 1000) {
    assert.equal(res.due, true); // next Monday's slot arrived instead
  } else {
    assert.deepEqual(res.reason, 'not-due');
  }
});

test('strict mode (CRON_SECRET set): wrong or missing secret is rejected', async () => {
  const bad = await call(jsonReq({ method: 'GET', url: '/api/cron/routine?secret=nope' }));
  assert.equal(bad.status, 401);
  const missing = await call(jsonReq({ method: 'GET', url: '/api/cron/routine' }));
  assert.equal(missing.status, 401);
});

test('cron endpoint reports skip reasons without running providers', async () => {
  await call(jsonReq({ method: 'PUT', url: '/api/routine', json: { paused: true, interests: ['ai'] } }));
  const paused = await call(jsonReq({ method: 'GET', url: '/api/cron/routine?secret=test-cron-secret' }));
  assert.equal(paused.status, 200);
  assert.deepEqual(paused.json, { ran: false, reason: 'paused', at: paused.json.at });
  assert.ok(Date.parse(paused.json.at));

  await call(jsonReq({ method: 'PUT', url: '/api/routine', json: { paused: false, interests: [] } }));
  const empty = await call(jsonReq({ method: 'GET', url: '/api/cron/routine?secret=test-cron-secret' }));
  assert.equal(empty.json.ran, false);
  assert.equal(empty.json.reason, 'no-interests');
});

test('routine settings expose the scheduler state', async () => {
  const data = await call(jsonReq({ method: 'GET', url: '/api/routine' }));
  assert.equal(data.status, 200);
  assert.equal(data.json.cronConfigured, true);
  assert.equal(data.json.scheduler, 'external'); // CRON_SECRET set in this file → locked
});

test('open mode (no CRON_SECRET): unsigned calls reach the due-check, wrong secrets still rejected', async () => {
  delete process.env.CRON_SECRET;
  try {
    const open = await call(jsonReq({ method: 'GET', url: '/api/cron/routine' }));
    assert.equal(open.status, 200);
    assert.equal(open.json.ran, false);
    const wrong = await call(jsonReq({ method: 'GET', url: '/api/cron/routine?secret=guessed' }));
    assert.equal(wrong.status, 401);
    const data = await call(jsonReq({ method: 'GET', url: '/api/routine' }));
    assert.equal(data.json.scheduler, 'local'); // no Vercel, no opt-out in tests
  } finally {
    process.env.CRON_SECRET = 'test-cron-secret';
  }
});

test('cronLocked tracks the strict-mode switch only', () => {
  process.env.CRON_SECRET = 'x';
  assert.equal(cronLocked(), true);
  delete process.env.CRON_SECRET;
  assert.equal(cronLocked(), false);
  process.env.CRON_SECRET = 'test-cron-secret';
});

test('local scheduler runs due routines promptly, then stops cleanly', async () => {
  const calls = [];
  const lines = [];
  const stop = startLocalScheduler({
    delayMs: 10, maxWaitMs: 5000,
    log: (m) => lines.push(m),
    readRoutineDoc: async () => ({ interests: ['x'], deliveryDays: ['Monday'], deliveryTime: '09:00' }), // never ran → due
    runOnce: async () => { calls.push(Date.now()); return { ran: true, added: 1 }; },
  });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(calls.length, 1);
  assert.ok(lines.some((l) => /scheduler ran=true added=1/.test(l)));
  stop();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls.length, 1);
});

test('local scheduler stays silent for paused routines but keeps re-checking', async () => {
  let reads = 0;
  const calls = [];
  const stop = startLocalScheduler({
    delayMs: 10, maxWaitMs: 120,
    log: () => {},
    readRoutineDoc: async () => { reads++; return { paused: true, interests: ['x'] }; },
    runOnce: async () => { calls.push(1); return { ran: true }; },
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.length, 0);
  assert.ok(reads >= 2, 're-checks so unpausing takes effect');
  stop();
});

test('nextSlotMs finds the next delivery slot across days and times', () => {
  const mon8 = new Date();
  mon8.setHours(8, 0, 0, 0);
  mon8.setDate(mon8.getDate() - ((mon8.getDay() + 6) % 7));
  const r = { cadence: 'weekly', deliveryDays: ['Monday'], deliveryTime: '09:00' };
  assert.equal(nextSlotMs(r, mon8.getTime()), mon8.getTime() + 3600 * 1000); // today 09:00
  assert.equal(nextSlotMs(r, mon8.getTime() + 2 * 3600 * 1000), mon8.getTime() + 7 * 86400 * 1000 + 3600 * 1000); // next Mon
  const r2 = { ...r, deliveryDays: ['Monday', 'Thursday'] };
  assert.equal(nextSlotMs(r2, mon8.getTime() + 2 * 3600 * 1000), mon8.getTime() + 3 * 86400 * 1000 + 3600 * 1000); // Thu
  const night = mon8.getTime() + 14 * 3600 * 1000; // Monday 22:00
  assert.equal(nextSlotMs({ cadence: 'daily', deliveryTime: '09:00' }, night), mon8.getTime() + 86400 * 1000 + 3600 * 1000); // Tue
  assert.equal(nextSlotMs({ deliveryDays: ['Monday'], deliveryTime: 'nope' }, mon8.getTime()), mon8.getTime() + 3600 * 1000); // 09:00 fallback
});

test('isDue runs daily cadences once per day, after the slot', () => {
  const now = new Date();
  now.setHours(10, 0, 0, 0);
  const base = { cadence: 'daily', interests: ['x'], deliveryTime: '09:00' };
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  assert.equal(isDue({ ...base, lastRunAt: yesterday }, now.getTime()).due, true);
  const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
  assert.equal(isDue({ ...base, lastRunAt: twoHoursAgo }, now.getTime()).due, false);
});

test('isDue honors multiple weekly delivery days', () => {
  const monday = new Date();
  monday.setHours(9, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const r = {
    cadence: 'weekly', interests: ['x'], deliveryDays: ['Monday', 'Thursday'],
    deliveryTime: '09:00', lastRunAt: new Date(monday.getTime() + 3600 * 1000).toISOString(),
  };
  const thu = monday.getTime() + 3 * 86400 * 1000 + 3600 * 1000; // Thu 10:00
  assert.equal(isDue(r, thu).due, true);
  const wed = monday.getTime() + 2 * 86400 * 1000 + 3600 * 1000; // Wed 10:00
  assert.deepEqual(isDue(r, wed).reason, 'not-due');
});

test('isDue still reads legacy single-day routines', () => {
  assert.equal(isDue({ cadence: 'weekly', interests: ['x'], deliveryDay: 'Monday', deliveryTime: '09:00' }).due, true);
});
