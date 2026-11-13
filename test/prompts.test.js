import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  flattenBrief,
  genericPrompts,
  takeQuestionMessages,
  parseQuestions,
} from '../lib/prompts.js';
import { PERSPECTIVE_PROMPTS, CAPTURE_PROMPTS } from '../lib/professions.js';

test('take-question prompt carries the grounding contract and the material', () => {
  const [system, user] = takeQuestionMessages({
    title: 'Four-day week trial results',
    body: 'A 32-hour trial with no pay cut raised output.',
    source: 'Example News',
    profession: 'Founder',
    interest: 'startup operations',
    isStory: true,
  });
  assert.match(system.content, /ONLY about.*explicitly present/i);
  assert.match(system.content, /never introduce new facts/i);
  assert.match(system.content, /exactly 3 questions/i);
  assert.match(system.content, /Founder/);
  assert.match(user.content, /Four-day week trial results/);
  assert.match(user.content, /32-hour trial/);
  assert.match(user.content, /startup operations/);
});

test('parseQuestions handles numbered, bulleted, JSON, and fenced replies', () => {
  assert.deepEqual(
    parseQuestions('1. Would a 32-hour week work for your own engineering team?\n2. Do you buy the claim that output rose?\n3. What would you measure first in such a trial?'),
    [
      'Would a 32-hour week work for your own engineering team?',
      'Do you buy the claim that output rose?',
      'What would you measure first in such a trial?',
    ],
  );
  assert.deepEqual(
    parseQuestions('- How would a four-day week change your hiring plans?\n- Which meetings would you cut first to fund it?'),
    [
      'How would a four-day week change your hiring plans?',
      'Which meetings would you cut first to fund it?',
    ],
  );
  assert.deepEqual(
    parseQuestions('```json\n["Would a 32-hour week work for your own team?", "What breaks first?"]\n```').length,
    1, // "What breaks first?" is too short/generic to keep
  );
  assert.deepEqual(parseQuestions('Here are my thoughts, no questions in here.'), []);
  assert.deepEqual(parseQuestions(''), []);
});

test('flattenBrief joins structured briefs, passes strings through', () => {
  assert.equal(flattenBrief('plain'), 'plain');
  assert.equal(flattenBrief(null), '');
  assert.equal(
    flattenBrief({ tldr: 'Trials expanded.', keyPoints: ['Output held steady.', 'Stress fell.'], conclusion: 'Expect wider adoption.' }),
    'Trials expanded.\nOutput held steady.\nStress fell.\nExpect wider adoption.',
  );
});

test('generic prompts fall back to the profession-agnostic lists', () => {
  assert.deepEqual(genericPrompts(true), PERSPECTIVE_PROMPTS);
  assert.deepEqual(genericPrompts(false), CAPTURE_PROMPTS);
});

// --- endpoint: unconfigured LLM falls back to generic (no key needed) --------
const tmpData = path.join(os.tmpdir(), `posty-prompts-test-${process.pid}`);
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

function req(method, url, json) {
  const base = {
    method,
    url,
    headers: { host: '127.0.0.1:3000', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  if (json === undefined) return base;
  const buf = Buffer.from(JSON.stringify(json));
  const handlers = {};
  return {
    ...base,
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

test('GET /api/inbox/:id/prompts falls back to generic without an LLM key', async () => {
  const savedKey = process.env.LLM_API_KEY;
  const savedEndpoint = process.env.LLM_ENDPOINT;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_ENDPOINT;
  try {
    const seed = mockRes();
    await handleNodeRequest(req('POST', '/api/demo/seed', {}), seed);
    assert.equal(seed.statusCode, 200);
    const items = JSON.parse(seed.body).items;
    const story = items.find((i) => i.kind === 'story');
    const capture = items.find((i) => i.kind === 'capture');

    const r1 = mockRes();
    await handleNodeRequest(req('GET', `/api/inbox/${story.id}/prompts`), r1);
    assert.equal(r1.statusCode, 200);
    assert.deepEqual(JSON.parse(r1.body), { questions: PERSPECTIVE_PROMPTS, grounded: false });

    const r2 = mockRes();
    await handleNodeRequest(req('GET', `/api/inbox/${capture.id}/prompts`), r2);
    assert.equal(r2.statusCode, 200);
    assert.deepEqual(JSON.parse(r2.body), { questions: CAPTURE_PROMPTS, grounded: false });

    const r3 = mockRes();
    await handleNodeRequest(req('GET', '/api/inbox/s_nope1234/prompts'), r3);
    assert.equal(r3.statusCode, 404);
  } finally {
    if (savedKey !== undefined) process.env.LLM_API_KEY = savedKey;
    if (savedEndpoint !== undefined) process.env.LLM_ENDPOINT = savedEndpoint;
  }
});
