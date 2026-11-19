import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRoutine, normalizeRoutine, coerceRoutine, WEEKDAYS } from '../lib/routine.js';

test('defaults stay weekly with a single Monday slot', () => {
  const r = defaultRoutine();
  assert.equal(r.cadence, 'weekly');
  assert.deepEqual(r.deliveryDays, ['Monday']);
  assert.equal(r.deliveryDay, 'Monday');
  assert.deepEqual(WEEKDAYS, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
});

test('normalizeRoutine accepts daily cadence and multiple delivery days', () => {
  const r = normalizeRoutine({ cadence: 'daily', deliveryDays: ['Monday', 'Thursday', 'Monday'] }, []);
  assert.equal(r.cadence, 'daily');
  assert.deepEqual(r.deliveryDays, ['Monday', 'Thursday']);
  assert.equal(r.deliveryDay, 'Monday');
});

test('normalizeRoutine filters unknown days and caps at seven', () => {
  const r = normalizeRoutine({ deliveryDays: ['Friday', 'Funday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Saturday', 'Sunday', 'Friday'] }, []);
  assert.deepEqual(r.deliveryDays, ['Friday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Saturday', 'Sunday']);
});

test('normalizeRoutine migrates the legacy single-day form', () => {
  const r = normalizeRoutine({ deliveryDay: 'Friday' }, []);
  assert.deepEqual(r.deliveryDays, ['Friday']);
  assert.equal(r.deliveryDay, 'Friday');
});

test('normalizeRoutine rejects unknown cadences and keeps prior days on empty input', () => {
  assert.equal(normalizeRoutine({ cadence: 'hourly' }, []).cadence, 'weekly');
  const r = normalizeRoutine({ deliveryDays: [], deliveryDay: 'Tuesday' }, []);
  assert.deepEqual(r.deliveryDays, ['Monday']); // empty array: nothing valid to take
  assert.deepEqual(normalizeRoutine({ deliveryDays: ['Wednesday'] }, []).deliveryDays, ['Wednesday']);
});

test('coerceRoutine migrates stored legacy docs without losing settings', () => {
  const legacy = { interests: ['ai'], cadence: 'weekly', deliveryDay: 'Friday', deliveryTime: '08:30', runs: 4, lastRunAt: '2026-11-01T00:00:00Z' };
  const r = coerceRoutine(legacy);
  assert.deepEqual(r.deliveryDays, ['Friday']);
  assert.equal(r.deliveryDay, 'Friday');
  assert.equal(r.runs, 4);
  assert.equal(r.lastRunAt, '2026-11-01T00:00:00Z');
  assert.equal(r.deliveryTime, '08:30');
  assert.deepEqual(coerceRoutine(null).deliveryDays, ['Monday']);
  assert.equal(coerceRoutine({ cadence: 'minutely' }).cadence, 'weekly');
  assert.deepEqual(coerceRoutine({ deliveryDays: ['Nope'] }).deliveryDays, ['Monday']);
});

test('normalizeRoutine keeps valid delivery times, defaults the rest', () => {
  assert.equal(normalizeRoutine({ deliveryTime: '15:30' }, []).deliveryTime, '15:30');
  assert.equal(normalizeRoutine({ deliveryTime: '7:30' }, []).deliveryTime, '09:00');
  assert.equal(normalizeRoutine({ deliveryTime: '' }, []).deliveryTime, '09:00');
  assert.equal(normalizeRoutine({}, []).deliveryTime, '09:00');
});

// --- HTTP: routine interests mirror Settings (single source of truth) ---
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpData = path.join(os.tmpdir(), `posty-routine-test-${process.pid}`);
process.env.DATA_DIR = tmpData;
test.after(() => { fs.rmSync(tmpData, { recursive: true, force: true }); });

const { handleNodeRequest } = await import('../lib/app.js');

function mockRes() {
  const headers = {};
  const res = {
    headers, statusCode: 0, body: '', writableEnded: false,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    writeHead(status, h = {}) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = v;
    },
    end(b = '') { res.body += b; res.writableEnded = true; },
  };
  return res;
}

function jsonReq({ method, url, json }) {
  const buf = json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json));
  const handlers = {};
  return {
    method, url,
    headers: { host: '127.0.0.1:3000', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
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

test('routine interests sync with saved Settings interests', async () => {
  await call(jsonReq({ method: 'PUT', url: '/api/preferences', json: { interests: ['alpha', 'beta'] } }));
  const one = await call(jsonReq({ method: 'GET', url: '/api/routine' }));
  assert.deepEqual(one.json.interests, ['alpha', 'beta']);
  await call(jsonReq({ method: 'PUT', url: '/api/routine', json: { deliveryTime: '15:30' } }));
  await call(jsonReq({ method: 'PUT', url: '/api/preferences', json: { interests: ['beta', 'gamma'] } }));
  const two = await call(jsonReq({ method: 'GET', url: '/api/routine' }));
  assert.deepEqual(two.json.interests, ['beta', 'gamma']); // synced without re-saving the routine
  assert.equal(two.json.deliveryTime, '15:30'); // other settings untouched
});
