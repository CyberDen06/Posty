import { fetchJson, randId } from './util.js';

// Buffer integration: OAuth (Authorization Code + PKCE, confidential client)
// and the GraphQL API at api.buffer.com. Shapes follow Buffer's documented
// examples; every GraphQL response is checked for body-level `errors` plus
// payload presence — HTTP status alone is never trusted.

const AUTH_BASE = 'https://auth.buffer.com';
const API_BASE = 'https://api.buffer.com';
export const BUFFER_SCOPES = 'posts:write posts:read account:read offline_access';

export class BufferError extends Error {
  constructor(message, code = 'api', status = 502) {
    super(message);
    this.code = code; // api | needs_reauth | config | simulated
    this.status = status;
  }
}

export function isConfigured() {
  return Boolean(process.env.BUFFER_CLIENT_ID && process.env.BUFFER_CLIENT_SECRET && process.env.BUFFER_REDIRECT_URI);
}

export function authorizeUrl({ state, challenge }) {
  const p = new URLSearchParams({
    client_id: process.env.BUFFER_CLIENT_ID,
    redirect_uri: process.env.BUFFER_REDIRECT_URI,
    response_type: 'code',
    scope: BUFFER_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  });
  return `${AUTH_BASE}/auth?${p.toString()}`;
}

async function tokenRequest(params) {
  const body = new URLSearchParams({
    client_id: process.env.BUFFER_CLIENT_ID,
    client_secret: process.env.BUFFER_CLIENT_SECRET,
    redirect_uri: process.env.BUFFER_REDIRECT_URI,
    ...params,
  });
  let res;
  try {
    res = await fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new BufferError(`Buffer authorization server unreachable (${err.message})`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* fall through */ }
  if (!res.ok || !data?.access_token) {
    const msg = data?.error_description || data?.error || `token request failed with status ${res.status}`;
    const needsReauth = /invalid_grant|revoked|expired/i.test(msg);
    throw new BufferError(msg, needsReauth ? 'needs_reauth' : 'api', res.status === 400 ? 400 : 502);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    scope: data.scope || '',
  };
}

export function exchangeCode({ code, verifier }) {
  return tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier });
}

export function refreshTokens(refreshToken) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

// --- GraphQL ---------------------------------------------------------------
// Buffer refresh tokens are SINGLE-USE: concurrent refreshes would revoke the
// whole grant. Refreshes are serialized per session id via this in-flight map.
const refreshInflight = new Map();

export async function ensureFreshToken(session, save) {
  const b = session.buffer;
  if (!b?.accessToken) throw new BufferError('Buffer account not connected', 'needs_reauth', 409);
  if (b.expiresAt && b.expiresAt - Date.now() > 60_000) return b.accessToken;
  if (!b.refreshToken) throw new BufferError('Buffer session expired — please reconnect', 'needs_reauth', 409);
  if (!refreshInflight.has(session.sid)) {
    refreshInflight.set(session.sid, (async () => {
      try {
        const pair = await refreshTokens(b.refreshToken);
        // Persist the NEW pair immediately; the old refresh token is dead.
        session.buffer = { ...b, ...pair, needsReauth: false };
        await save(session);
        return pair.accessToken;
      } catch (err) {
        if (err.code === 'needs_reauth') {
          session.buffer = { ...b, accessToken: null, refreshToken: null, needsReauth: true };
          await save(session);
        }
        throw err;
      } finally {
        refreshInflight.delete(session.sid);
      }
    })());
  }
  return refreshInflight.get(session.sid);
}

export async function graphql(token, query, variables = {}) {
  let res;
  try {
    res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new BufferError(`Buffer API unreachable (${err.message})`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* fall through */ }
  if (res.status === 401) throw new BufferError('Buffer rejected the access token — please reconnect', 'needs_reauth', 409);
  if (!res.ok || !data) throw new BufferError(`Buffer API request failed with status ${res.status}`, 'api', 502);
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const msg = data.errors.map((e) => e.message).filter(Boolean).join(' / ') || 'Buffer API returned errors';
    throw new BufferError(msg, 'api', 502);
  }
  return data.data || {};
}

export async function getOrganizations(token) {
  const data = await graphql(token, 'query GetOrganizations { account { organizations { id name ownerEmail } } }');
  const orgs = data?.account?.organizations;
  if (!Array.isArray(orgs)) throw new BufferError('Buffer returned an unexpected organizations payload', 'api', 502);
  return orgs;
}

export async function getChannels(token, organizationId) {
  const data = await graphql(token,
    'query GetChannels($orgId: OrganizationId!) { channels(input: { organizationId: $orgId }) { id name displayName service avatar isQueuePaused } }',
    { orgId: organizationId });
  const list = data?.channels;
  if (Array.isArray(list)) return list;
  if (Array.isArray(list?.edges)) return list.edges.map((e) => e.node);
  throw new BufferError('Buffer returned an unexpected channels payload', 'api', 502);
}

// Documented shape: createPost returns a union — success and typed errors arrive
// via inline fragments, never as direct field selections.
const CREATE_POST = 'mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id text } } ... on MutationError { message } } }';

// Scheduling modes per docs: addToQueue (next free slot) or customScheduled
// with an ISO-8601 UTC dueAt. One channel per call.
export async function createPost(token, { channelId, text, mode = 'addToQueue', dueAt = null }) {
  if (!channelId || !text?.trim()) throw new BufferError('channel and text are required', 'api', 400);
  const input = { text: text.trim(), channelId, schedulingType: 'automatic', mode };
  if (mode === 'customScheduled') {
    const t = Date.parse(dueAt);
    if (Number.isNaN(t) || t < Date.now()) throw new BufferError('scheduled time must be in the future', 'api', 400);
    input.dueAt = new Date(t).toISOString();
  }
  const data = await graphql(token, CREATE_POST, { input });
  const result = data?.createPost;
  if (result?.post?.id) return { id: result.post.id, dueAt: input.dueAt || null };
  throw new BufferError(result?.message || 'Buffer did not return a scheduled post', 'api', 502);
}

// --- Clearly labeled mock (dev only: active iff OAuth is NOT configured) ----
export function mockChannels() {
  return [
    { id: 'mock_linkedin', name: 'Mock LinkedIn', displayName: 'Mock LinkedIn', service: 'linkedin', avatar: null, isQueuePaused: false, mock: true },
    { id: 'mock_x', name: 'Mock X', displayName: 'Mock X', service: 'twitter', avatar: null, isQueuePaused: false, mock: true },
    { id: 'mock_bluesky', name: 'Mock Bluesky', displayName: 'Mock Bluesky', service: 'bluesky', avatar: null, isQueuePaused: false, mock: true },
  ];
}

export function mockSchedule({ channelId, text, mode, dueAt }) {
  if (process.env.MOCK_FAIL === '1') {
    throw new BufferError('Simulated scheduling failure (mock mode test switch — not a real API failure)', 'simulated', 502);
  }
  return {
    mode: 'mock',
    postId: `mock_${randId(8)}`,
    channelId,
    chars: text.length,
    dueAt: mode === 'customScheduled' ? new Date(Date.parse(dueAt)).toISOString() : null,
    queuedAt: new Date().toISOString(),
    label: 'Demo scheduling — this post was NOT sent to Buffer. Connect Buffer to schedule for real.',
  };
}
