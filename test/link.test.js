import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Hermetic store: token workspaces mint sessions, so point DATA_DIR at a
// temp dir (read lazily per call, so setting it here works).
const tmpData = path.join(os.tmpdir(), `posty-link-test-${process.pid}`);
process.env.DATA_DIR = tmpData;
process.env.OVERLAY_TOKENS = 'test-token-alpha,test-token-beta';
process.env.SESSION_SECRET = 'link-test-secret';
test.after(() => {
  fs.rmSync(tmpData, { recursive: true, force: true });
  delete process.env.OVERLAY_TOKENS;
  delete process.env.SESSION_SECRET;
});

const { handleNodeRequest } = await import('../lib/app.js');
const { writeDoc } = await import('../lib/store.js');
const { hmacSha256 } = await import('../lib/util.js');

function signedCookie(sid) {
  return `posty_sid=${sid}.${hmacSha256('link-test-secret', `sid:${sid}`)}`;
}

function mockReq({ method = 'GET', url = '/', headers = {}, remoteAddress = '203.0.113.9' } = {}) {
  return { method, url, headers: { host: 'posty.example', ...headers }, socket: { remoteAddress } };
}
// Fake body-carrying request: emits data+end right after readBody attaches
// (same pattern as captures.test.js).
function bodyReq({ method, url, headers = {}, json }) {
  const buf = Buffer.from(JSON.stringify(json));
  const handlers = {};
  return {
    method,
    url,
    headers: { host: 'posty.example', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '203.0.113.9' },
    on(ev, fn) {
      (handlers[ev] ||= []).push(fn);
      if (ev === 'end') {
        queueMicrotask(() => {
          (handlers.data || []).forEach((f) => f(buf));
          (handlers.end || []).forEach((f) => f());
        });
      }
      return this;
    },
    destroy() {},
  };
}
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
async function call(opts, jsonBody) {
  const req = jsonBody !== undefined
    ? bodyReq({ method: opts.method || 'GET', url: opts.url, headers: opts.headers, json: jsonBody })
    : mockReq(opts);
  const res = mockRes();
  await handleNodeRequest(req, res);
  let data = {};
  try { data = JSON.parse(res.body); } catch { /* non-JSON (redirects etc.) */ }
  return { status: res.statusCode, headers: res.headers, data };
}

test('adopt accepts a configured token and rejects unknown ones', async () => {
  const ok = await call(
    { method: 'POST', url: '/api/link/adopt', headers: { 'x-posty-token': 'test-token-alpha' } },
    {},
  );
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.data.copied, 'number');

  const wrong = await call(
    { method: 'POST', url: '/api/link/adopt', headers: { 'x-posty-token': 'nope' } },
    {},
  );
  assert.equal(wrong.status, 401);
  assert.match(wrong.data.error || '', /rejected/);

  const missing = await call({ method: 'POST', url: '/api/link/adopt' }, {});
  assert.equal(missing.status, 401);
  assert.match(missing.data.error || '', /token first/);
});

test('adopt reports honestly when linking is not enabled', async () => {
  delete process.env.OVERLAY_TOKENS;
  try {
    const r = await call(
      { method: 'POST', url: '/api/link/adopt', headers: { 'x-posty-token': 'anything' } },
      {},
    );
    assert.equal(r.status, 401);
    assert.match(r.data.error || '', /not enabled/);
  } finally {
    process.env.OVERLAY_TOKENS = 'test-token-alpha,test-token-beta';
  }
});

test('same token shares one workspace; other tokens are isolated', async () => {
  const cap = await call(
    { method: 'POST', url: '/api/captures', headers: { 'x-posty-token': 'test-token-alpha' } },
    { type: 'note', title: 'link probe k7', text: 'marker text' },
  );
  assert.equal(cap.status, 200);

  const same = await call(
    { method: 'GET', url: '/api/inbox', headers: { 'x-posty-token': 'test-token-alpha' } },
  );
  assert.equal(same.status, 200);
  assert.ok((same.data.items || []).some((i) => (i.capture?.title || '').includes('link probe k7')));

  const other = await call(
    { method: 'GET', url: '/api/inbox', headers: { 'x-posty-token': 'test-token-beta' } },
  );
  assert.equal(other.status, 200);
  assert.ok(!(other.data.items || []).some((i) => (i.capture?.title || '').includes('link probe k7')));

  const stranger = await call(
    { method: 'GET', url: '/api/inbox', headers: { 'x-posty-token': 'intruder' } },
  );
  assert.equal(stranger.status, 401);
});

test('adopt carries the Buffer connection without overwriting', async () => {
  const src = 'test-cookie-src-01';
  await writeDoc('session', src, 'session', {
    sid: src,
    createdAt: new Date().toISOString(),
    buffer: { accessToken: 'src-token', refreshToken: 'src-refresh', organization: { id: 'org1', name: 'Org' }, needsReauth: false },
  });
  const r = await call(
    { method: 'POST', url: '/api/link/adopt', headers: { 'x-posty-token': 'test-token-beta', cookie: signedCookie(src) } },
    {},
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.bufferCarried, true);
  const me = await call(
    { method: 'GET', url: '/api/me', headers: { 'x-posty-token': 'test-token-beta' } },
  );
  assert.equal(me.data.connected, true);
  assert.equal(me.data.organization?.id, 'org1');

  // A later adopt from a differently-connected browser must not clobber it.
  const src2 = 'test-cookie-src-02';
  await writeDoc('session', src2, 'session', {
    sid: src2,
    createdAt: new Date().toISOString(),
    buffer: { accessToken: 'other-token', organization: null, needsReauth: false },
  });
  const r2 = await call(
    { method: 'POST', url: '/api/link/adopt', headers: { 'x-posty-token': 'test-token-beta', cookie: signedCookie(src2) } },
    {},
  );
  assert.equal(r2.status, 200);
  assert.equal(r2.data.bufferCarried, false);
  const me2 = await call(
    { method: 'GET', url: '/api/me', headers: { 'x-posty-token': 'test-token-beta' } },
  );
  assert.equal(me2.data.organization?.id, 'org1'); // original kept
});

test('preflight allows the link-token header for the overlay webview', async () => {
  const req = mockReq({
    method: 'OPTIONS',
    url: '/api/captures',
    headers: { origin: 'https://tauri.localhost', 'access-control-request-headers': 'x-posty-token' },
  });
  const res = mockRes();
  await handleNodeRequest(req, res);
  assert.equal(res.statusCode, 204);
  assert.match(res.headers['access-control-allow-headers'] || '', /x-posty-token/);
});

test('on Vercel, loopback requests do not share one workspace', async () => {
  process.env.VERCEL = '1';
  try {
    const res = mockRes();
    await handleNodeRequest(
      mockReq({ method: 'GET', url: '/healthz', remoteAddress: '127.0.0.1' }),
      res,
    );
    assert.doesNotMatch(res.headers['set-cookie'] || '', /local-single-user-workspace/);
  } finally {
    delete process.env.VERCEL;
  }
});
