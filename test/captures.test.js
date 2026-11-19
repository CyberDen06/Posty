import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Hermetic store (DATA_DIR is read lazily per call).
const tmpData = path.join(os.tmpdir(), `posty-captures-test-${process.pid}`);
process.env.DATA_DIR = tmpData;
test.after(() => { fs.rmSync(tmpData, { recursive: true, force: true }); });

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

// Fake body-carrying request: emits data+end right after readBody attaches.
function bodyReq({ method, url, json }) {
  const buf = Buffer.from(JSON.stringify(json));
  const handlers = {};
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3000', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
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

function getReq(url) {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

async function postCapture(json) {
  const res = mockRes();
  await handleNodeRequest(bodyReq({ method: 'POST', url: '/api/captures', json }), res);
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body).item;
}

test('PATCH /api/inbox/:id updates a capture and persists it', async () => {
  const created = await postCapture({ type: 'note', title: 'triage this', text: 'teh quick brown fox' });
  const res = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'PATCH', url: `/api/inbox/${created.id}`, json: { text: 'the quick brown fox' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).item.capture.text, 'the quick brown fox');

  const inbox = mockRes();
  await handleNodeRequest(getReq('/api/inbox'), inbox);
  const found = JSON.parse(inbox.body).items.find((i) => i.id === created.id);
  assert.equal(found.capture.text, 'the quick brown fox');
  assert.equal(found.capture.title, 'triage this'); // untouched fields survive
});

test('POST /api/captures accepts reviewed voice transcripts with provenance', async () => {
  const res = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'POST', url: '/api/captures', json: { type: 'voice', title: 'Standup thought', text: 'standups feel flat lately' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  const item = JSON.parse(res.body).item;
  assert.equal(item.capture.type, 'voice');
  assert.equal(item.capture.title, 'Standup thought');
  assert.equal(typeof item.capture.provenance.engine, 'string');
  assert.equal(item.capture.provenance.mode, 'spoken brain dump');

  const empty = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'POST', url: '/api/captures', json: { type: 'voice', title: '', text: '' } }),
    empty,
  );
  assert.equal(empty.statusCode, 400);
});

test('POST /api/voice/transcribe validates audio before touching the network', async () => {
  const res = mockRes();
  await handleNodeRequest(bodyReq({ method: 'POST', url: '/api/voice/transcribe', json: {} }), res);
  assert.equal(res.statusCode, 400); // content-type is JSON, not audio/wav
});

test('unconfigured Vercel deployment fails writes with an actionable message', async () => {
  const savedVercel = process.env.VERCEL;
  const savedUrl = process.env.KV_REST_API_URL;
  const savedToken = process.env.KV_REST_API_TOKEN;
  const savedData = process.env.DATA_DIR;
  process.env.VERCEL = '1';
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  // Fresh store dir: earlier tests in this file already created the shared
  // loopback session, which would skip the write we want to exercise.
  process.env.DATA_DIR = `${tmpData}-vercel`;
  try {
    const res = mockRes();
    await handleNodeRequest(getReq('/api/me'), res); // getSession saves → writeDoc
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /connect a Vercel KV database/);
  } finally {
    if (savedVercel !== undefined) process.env.VERCEL = savedVercel;
    else delete process.env.VERCEL;
    if (savedUrl !== undefined) process.env.KV_REST_API_URL = savedUrl;
    if (savedToken !== undefined) process.env.KV_REST_API_TOKEN = savedToken;
    process.env.DATA_DIR = savedData;
  }
});

test('DELETE /api/inbox/:id removes an idea permanently', async () => {
  const created = await postCapture({ type: 'note', title: 'doomed idea', text: 'bye' });
  const res = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'DELETE', url: `/api/inbox/${created.id}`, json: {} }),
    res,
  );
  assert.equal(res.statusCode, 200);
  const inbox = mockRes();
  await handleNodeRequest(getReq('/api/inbox'), inbox);
  assert.ok(!JSON.parse(inbox.body).items.some((i) => i.id === created.id));

  const missing = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'DELETE', url: '/api/inbox/s_nope1234', json: {} }),
    missing,
  );
  assert.equal(missing.statusCode, 404);
});

test('DELETE /api/inbox/:id removes ideas even with a queued draft (queue untouched)', async () => {
  const created = await postCapture({ type: 'note', title: 'queued idea', text: 'stays put' });
  const gen = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'POST', url: `/api/inbox/${created.id}/drafts`, json: { channels: ['linkedin'] } }),
    gen,
  );
  assert.equal(gen.statusCode, 200);
  const draftId = JSON.parse(gen.body).item.drafts[0].id;
  const appr = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'POST', url: `/api/drafts/${draftId}/approve`, json: {} }),
    appr,
  );
  assert.equal(appr.statusCode, 200);
  const sched = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'POST', url: `/api/drafts/${draftId}/schedule`, json: { confirmToken: JSON.parse(appr.body).confirmToken, idempotencyKey: 'del-guard-1' } }),
    sched,
  );
  assert.equal(sched.statusCode, 200);
  assert.equal(JSON.parse(sched.body).draft.status, 'scheduled');

  const del = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'DELETE', url: `/api/inbox/${created.id}`, json: {} }),
    del,
  );
  assert.equal(del.statusCode, 200);
  assert.equal(JSON.parse(del.body).hadScheduled, true);
  const inbox = mockRes();
  await handleNodeRequest(getReq('/api/inbox'), inbox);
  assert.ok(!JSON.parse(inbox.body).items.some((i) => i.id === created.id)); // gone, queue untouched
});

test('DELETE /api/drafts/:id removes scheduled drafts locally (queue untouched)', async () => {
  const created = await postCapture({ type: 'note', title: 'queued draft', text: 'bye draft' });
  const gen = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'POST', url: `/api/inbox/${created.id}/drafts`, json: { channels: ['x'] } }),
    gen,
  );
  const draftId = JSON.parse(gen.body).item.drafts[0].id;
  const appr = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'POST', url: `/api/drafts/${draftId}/approve`, json: {} }),
    appr,
  );
  const sched = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'POST', url: `/api/drafts/${draftId}/schedule`, json: { confirmToken: JSON.parse(appr.body).confirmToken, idempotencyKey: 'del-draft-1' } }),
    sched,
  );
  assert.equal(JSON.parse(sched.body).draft.status, 'scheduled');
  const del = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'DELETE', url: `/api/drafts/${draftId}`, json: {} }),
    del,
  );
  assert.equal(del.statusCode, 200);
  const inbox = mockRes();
  await handleNodeRequest(getReq('/api/inbox'), inbox);
  const item = JSON.parse(inbox.body).items.find((i) => i.id === created.id);
  assert.ok(item, 'idea survives a single-draft delete');
  assert.ok(!item.drafts.some((d) => d.id === draftId));
});

test('PATCH /api/inbox/:id rejects unknown ids, empties, and stories', async () => {
  const missing = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'PATCH', url: '/api/inbox/s_nope1234', json: { text: 'x' } }),
    missing,
  );
  assert.equal(missing.statusCode, 404);

  const created = await postCapture({ type: 'note', title: 'keep me', text: 'original' });
  const empty = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'PATCH', url: `/api/inbox/${created.id}`, json: { title: '', text: '' } }),
    empty,
  );
  assert.equal(empty.statusCode, 400);

  const seed = mockRes();
  await handleNodeRequest(bodyReq({ method: 'POST', url: '/api/demo/seed', json: {} }), seed);
  const story = JSON.parse(seed.body).items.find((i) => i.kind === 'story');
  const storyRes = mockRes();
  await handleNodeRequest(
    bodyReq({ method: 'PATCH', url: `/api/inbox/${story.id}`, json: { text: 'x' } }),
    storyRes,
  );
  assert.equal(storyRes.statusCode, 400);
});
