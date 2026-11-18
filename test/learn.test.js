import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SIGNAL,
  defaultProfile,
  featuresOf,
  similarity,
  recordOutcome,
  keptCount,
  ready,
  preferredChars,
  topOpeners,
  personalizeLines,
  summary,
} from '../lib/learn.js';

test('featuresOf extracts shape, not content', () => {
  const f = featuresOf('Been thinking about this one:\n\nSome body text here. Is it good? #ai #tools');
  assert.equal(f.sentences, 3);
  assert.equal(f.opener, 'been thinking about this');
  assert.equal(f.hasQuestion, true);
  assert.equal(f.hashtags, 2);
  assert.ok(f.chars > 50);
});

test('similarity rewards surviving words, 0 on empty', () => {
  assert.equal(similarity('', ''), 0);
  assert.equal(similarity('same words here', 'same words here'), 1);
  const partial = similarity('the quick brown fox jumps', 'the quick red fox sleeps');
  assert.ok(partial > 0.2 && partial < 0.8, `expected partial overlap, got ${partial}`);
  assert.equal(similarity('alpha beta gamma', 'delta epsilon zeta'), 0);
});

test('kept drafts teach length and openers; skipped ones only count', () => {
  const p = defaultProfile();
  recordOutcome(p, { outcome: 'approved', generatedText: 'Hello world, this is a test post.', finalText: 'Hello world, this is a test post!', channel: 'x' });
  recordOutcome(p, { outcome: 'scheduled', generatedText: 'Hello world, another approved post here.', finalText: 'Hello world, another approved post here.', channel: 'x' });
  recordOutcome(p, { outcome: 'skipped', generatedText: 'Something the user passed on.', finalText: '', channel: 'linkedin' });
  assert.deepEqual(p.counts, { approved: 1, scheduled: 1, skipped: 1, deleted: 0 });
  assert.equal(keptCount(p), 2);
  assert.equal(ready(p), false);
  assert.ok(preferredChars(p) > 20);
  assert.equal(p.channels.x.kept, 2);
  assert.equal(p.channels.linkedin.skipped, 1);
  assert.ok(Object.keys(p.openers).length >= 1);
});

test('heavy rewrites teach less than clean approvals', () => {
  const clean = defaultProfile();
  recordOutcome(clean, { outcome: 'approved', generatedText: 'Hello world this is neat', finalText: 'Hello world this is neat', channel: 'x' });
  const rewritten = defaultProfile();
  recordOutcome(rewritten, { outcome: 'approved', generatedText: 'Hello world this is neat', finalText: 'Completely different zebra thoughts arrived', channel: 'x' });
  assert.ok(clean.keptWeight > rewritten.keptWeight);
});

test('unknown outcomes throw instead of corrupting the profile', () => {
  assert.throws(() => recordOutcome(defaultProfile(), { outcome: 'published' }), /unknown learning outcome/);
});

test('personalizeLines stays silent until MIN_SIGNAL, then nudges length + opener only', () => {
  const p = defaultProfile();
  assert.deepEqual(personalizeLines(p), []);
  for (let i = 0; i < MIN_SIGNAL; i++) {
    recordOutcome(p, { outcome: 'approved', generatedText: `Worth noting development number ${i} for the team`, finalText: `Worth noting development number ${i} for the team`, channel: 'linkedin' });
  }
  assert.equal(ready(p), true);
  const lines = personalizeLines(p);
  assert.ok(lines.some((l) => /usually approves posts near \d+ characters/.test(l)), 'length hint present');
  assert.ok(lines.some((l) => /opening like/.test(l) && /never copy it verbatim/.test(l)), 'opener hint present with no-copy guard');
  assert.ok(lines.every((l) => !/believe|opinion|experience|believes/i.test(l)), 'no belief/opinion claims');
});

test('summary is inspectable and never leaks full draft text', () => {
  const p = defaultProfile();
  recordOutcome(p, { outcome: 'scheduled', generatedText: 'Secret project details inside this draft text', finalText: 'Secret project details inside this draft text', channel: 'x' });
  const s = summary(p);
  assert.equal(s.kept, 1);
  assert.equal(s.ready, false);
  assert.equal(s.needed, MIN_SIGNAL - 1);
  assert.deepEqual(s.counts, { approved: 0, scheduled: 1, skipped: 0, deleted: 0 });
  assert.ok(!JSON.stringify(s).includes('Secret project details inside this draft text'), 'full text must not leak');
});

test('opener table stays bounded', () => {
  const p = defaultProfile();
  for (let i = 0; i < 40; i++) {
    recordOutcome(p, { outcome: 'approved', generatedText: `Opener number ${i} leads this draft along`, finalText: `Opener number ${i} leads this draft along`, channel: 'x' });
  }
  assert.ok(Object.keys(p.openers).length <= 20);
});

// --- HTTP loop: opt-in → approve/skip recorded → variant → inspect → clear ---
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpLearn = path.join(os.tmpdir(), `posty-learn-test-${process.pid}`);
process.env.DATA_DIR = tmpLearn;
delete process.env.LLM_API_KEY;
delete process.env.LLM_ENDPOINT;
test.after(() => { fs.rmSync(tmpLearn, { recursive: true, force: true }); });

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

test('approvals and skips are recorded only when opted in, then inspectable and clearable', async () => {
  const seed = await call(jsonReq({ method: 'POST', url: '/api/demo/seed' }));
  assert.equal(seed.status, 200);
  const drafts = seed.json.items[0].drafts;
  assert.ok(drafts.length >= 2);
  assert.ok(drafts[0].generatedText, 'drafts track their as-generated text');

  // Opted out by default: approving records nothing.
  const before = await call(jsonReq({ method: 'GET', url: '/api/learning' }));
  assert.equal(before.json.enabled, false);
  await call(jsonReq({ method: 'POST', url: `/api/drafts/${drafts[0].id}/approve` }));
  const stillEmpty = await call(jsonReq({ method: 'GET', url: '/api/learning' }));
  assert.equal(stillEmpty.json.profile.kept, 0);

  // Opt in: approve + skip both land in the profile.
  const prefs = await call(jsonReq({ method: 'PUT', url: '/api/preferences', json: { learnFromUse: true } }));
  assert.equal(prefs.json.learnFromUse, true);
  await call(jsonReq({ method: 'POST', url: `/api/drafts/${drafts[0].id}/approve` }));
  await call(jsonReq({ method: 'POST', url: `/api/drafts/${drafts[1].id}/skip` }));
  const after = await call(jsonReq({ method: 'GET', url: '/api/learning' }));
  assert.equal(after.json.enabled, true);
  assert.equal(after.json.profile.counts.approved, 1);
  assert.equal(after.json.profile.counts.skipped, 1);

  // Clearing wipes the profile.
  const cleared = await call(jsonReq({ method: 'DELETE', url: '/api/learning' }));
  assert.equal(cleared.status, 200);
  const empty = await call(jsonReq({ method: 'GET', url: '/api/learning' }));
  assert.equal(empty.json.profile.kept, 0);
});

test('variant endpoint returns alternative phrasing with history preserved', async () => {
  const inbox = await call(jsonReq({ method: 'GET', url: '/api/inbox' }));
  const item = inbox.json.items.find((i) => (i.drafts || []).some((d) => d.status !== 'skipped' && d.status !== 'scheduled'));
  assert.ok(item, 'a variant-eligible draft exists');
  const d = item.drafts.find((x) => x.status !== 'skipped' && x.status !== 'scheduled');
  const res = await call(jsonReq({ method: 'POST', url: `/api/drafts/${d.id}/variant` }));
  assert.equal(res.status, 200);
  assert.notEqual(res.json.draft.text, d.text);
  assert.ok(res.json.draft.influences.includes('alternative phrasing'));
  assert.equal(res.json.draft.history.length, 1);
  assert.equal(res.json.draft.history[0].text, d.text);
});
