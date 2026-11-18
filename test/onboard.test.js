import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { stepsOf } from '../lib/onboard.js';

test('fresh workspace starts at step one', () => {
  const ob = stepsOf({ prefs: { setupDone: false }, connected: false, routine: { runs: 0 }, counts: {} });
  assert.equal(ob.done, 0);
  assert.equal(ob.total, 8);
  assert.equal(ob.complete, false);
  assert.equal(ob.next.id, 'profile');
  assert.ok(ob.steps.every((s) => s.id && s.label && s.href));
});

test('progress derives from state, next points at the first gap', () => {
  const ob = stepsOf({
    prefs: { setupDone: true },
    connected: false,
    routine: { runs: 0 },
    counts: { stories: 2, captures: 1, withTake: 1, drafts: 3, scheduled: 0 },
  });
  assert.equal(ob.done, 5);
  assert.equal(ob.next.id, 'schedule');
});

test('complete only when everything is done', () => {
  const full = { prefs: { setupDone: true }, connected: true, routine: { runs: 2 }, counts: { stories: 1, captures: 1, withTake: 1, drafts: 1, scheduled: 1 } };
  const ob = stepsOf(full);
  assert.equal(ob.complete, true);
  assert.equal(ob.next, null);
  assert.equal(stepsOf({ ...full, connected: false }).complete, false);
});

// --- HTTP: derived counts + dismiss flag ---
const tmpData = path.join(os.tmpdir(), `posty-onboard-test-${process.pid}`);
process.env.DATA_DIR = tmpData;
delete process.env.LLM_API_KEY;
delete process.env.LLM_ENDPOINT;
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

test('onboarding endpoint derives progress and honors dismiss', async () => {
  const fresh = await call(jsonReq({ method: 'GET', url: '/api/onboarding' }));
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.done, 0);
  assert.equal(fresh.json.dismissed, false);

  // Demo content must NOT count as progress.
  await call(jsonReq({ method: 'POST', url: '/api/demo/seed' }));
  const seeded = await call(jsonReq({ method: 'GET', url: '/api/onboarding' }));
  assert.equal(seeded.json.done, 0);

  // A real capture counts.
  await call(jsonReq({ method: 'POST', url: '/api/captures', json: { type: 'note', title: 'Real note', text: 'hello' } }));
  const après = await call(jsonReq({ method: 'GET', url: '/api/onboarding' }));
  assert.ok(après.json.done >= 1);
  assert.ok(après.json.steps.find((s) => s.id === 'capture').done);

  const dismiss = await call(jsonReq({ method: 'POST', url: '/api/onboarding/dismiss' }));
  assert.equal(dismiss.status, 200);
  const hidden = await call(jsonReq({ method: 'GET', url: '/api/onboarding' }));
  assert.equal(hidden.json.dismissed, true);
});
