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

const { cronSecretOk, isDue, CRON_MIN_GAP_HOURS } = await import('../lib/cron.js');
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

test('cron endpoint requires the secret', async () => {
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

test('routine settings expose whether the cron hook is configured', async () => {
  const data = await call(jsonReq({ method: 'GET', url: '/api/routine' }));
  assert.equal(data.status, 200);
  assert.equal(data.json.cronConfigured, true);
});
