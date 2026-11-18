import test from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

const { connectAccount, graphql } = await import('../lib/buffer.js');

const tokenOk = { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok123', refresh_token: 'ref123', expires_in: 3600 }) };

test('connectAccount saves tokens before the org lookup, surviving org failure', async () => {
  const saved = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes('/token')) return tokenOk;
    throw new Error('org lookup down');
  };
  const out = await connectAccount({ code: 'c', verifier: 'v' }, async (b) => { saved.push({ ...b }); });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].accessToken, 'tok123');
  assert.equal(saved[0].refreshToken, 'ref123');
  assert.equal(saved[0].organization, null);
  assert.equal(out.accessToken, 'tok123');
});

test('connectAccount attaches the org on the happy path', async () => {
  const saved = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes('/token')) return tokenOk;
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { account: { organizations: [{ id: 'o1', name: 'Acme' }] } } }) };
  };
  const out = await connectAccount({ code: 'c', verifier: 'v' }, async (b) => { saved.push({ ...b }); });
  assert.equal(saved.length, 2);
  assert.deepEqual(out.organization, { id: 'o1', name: 'Acme' });
});

test('graphql surfaces body-level errors, not just HTTP status', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ errors: [{ message: 'bad query shape' }] }) });
  await assert.rejects(() => graphql('tok', 'query { x }'), /bad query shape/);
});
