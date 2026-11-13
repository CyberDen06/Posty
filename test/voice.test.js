import test from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.LLM_API_KEY) process.env.LLM_API_KEY = 'test-key';
const { transcribeWav } = await import('../lib/voice.js');

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

const wav = () => Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt DATA....................');

function stubFetch(responses) {
  let n = 0;
  globalThis.fetch = async () => {
    const r = responses[Math.min(n++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
  };
}

test('transcribe retries a 408 once, then succeeds', async () => {
  stubFetch([
    { status: 408, body: '{}' },
    { status: 200, body: '{"transcript":"hello world"}' },
  ]);
  const { transcript } = await transcribeWav(wav());
  assert.equal(transcript, 'hello world');
});

test('a persistent 408 yields the friendly timeout message', async () => {
  stubFetch([{ status: 408, body: '{}' }]);
  await assert.rejects(() => transcribeWav(wav()), /try a shorter one/);
});

test('a 400 is not retried and keeps its message', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 400, text: async () => '{}' };
  };
  await assert.rejects(() => transcribeWav(wav()), /rejected this audio/);
  assert.equal(calls, 1);
});

test('non-WAV input never reaches the network', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  await assert.rejects(() => transcribeWav(Buffer.from('nope')), /Only WAV audio/);
  assert.equal(calls, 0);
});
