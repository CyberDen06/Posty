import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every shippable JS file must parse: a single syntax error in public/app.js
// blanks EVERY page (the module fails to load), and a broken lib file takes
// the server down with it. This caught a real outage (nested quotes in the
// Routine view's scheduler note).
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'public/app.js',
  'public/sw.js',
  'server.js',
  'api/index.js',
  'lib/app.js',
  'lib/buffer.js',
  'lib/cron.js',
  'lib/desktop.js',
  'lib/drafts.js',
  'lib/exa.js',
  'lib/learn.js',
  'lib/llm.js',
  'lib/onboard.js',
  'lib/professions.js',
  'lib/prompts.js',
  'lib/providers.js',
  'lib/routine.js',
  'lib/session.js',
  'lib/store.js',
  'lib/summaries.js',
  'lib/util.js',
  'lib/voice.js',
  'scripts/onboard.mjs',
];

for (const f of FILES) {
  test(`${f} parses`, () => {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
  });
}

test('vercel.json parses', async () => {
  const { readFileSync } = await import('node:fs');
  assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')));
});
