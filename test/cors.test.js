import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Hermetic store: the handler may mint sessions, so point DATA_DIR at a
// temp dir (read lazily per call, so setting it here works).
const tmpData = path.join(os.tmpdir(), `posty-cors-test-${process.pid}`);
process.env.DATA_DIR = tmpData;
test.after(() => { fs.rmSync(tmpData, { recursive: true, force: true }); });

const { handleNodeRequest } = await import('../lib/app.js');

function mockReq({ method = 'GET', url = '/', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return { method, url, headers: { host: '127.0.0.1:3000', ...headers }, socket: { remoteAddress } };
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

test('preflight from the desktop overlay succeeds with CORS headers', async () => {
  const req = mockReq({
    method: 'OPTIONS',
    url: '/api/captures/voice',
    headers: { origin: 'http://tauri.localhost', 'access-control-request-method': 'POST' },
  });
  const res = mockRes();
  await handleNodeRequest(req, res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], 'http://tauri.localhost');
  assert.match(res.headers['access-control-allow-methods'] || '', /POST/);
  assert.match(res.headers['access-control-allow-methods'] || '', /PATCH/);
});

test('API responses carry CORS headers for cross-origin clients', async () => {
  const req = mockReq({ method: 'GET', url: '/api/me', headers: { origin: 'http://tauri.localhost' } });
  const res = mockRes();
  await handleNodeRequest(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'http://tauri.localhost');
});

test('cookieless loopback requests share the local workspace, others do not', async () => {
  const local = mockRes();
  await handleNodeRequest(mockReq({ method: 'GET', url: '/healthz' }), local);
  assert.match(local.headers['set-cookie'] || '', /local-single-user-workspace/);

  const remote = mockRes();
  await handleNodeRequest(
    mockReq({ method: 'GET', url: '/healthz', remoteAddress: '203.0.113.9' }),
    remote,
  );
  assert.doesNotMatch(remote.headers['set-cookie'] || '', /local-single-user-workspace/);
});
