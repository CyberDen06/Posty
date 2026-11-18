import crypto from 'node:crypto';
import { hmacSha256, parseCookies, randId } from './util.js';
import { readDoc, writeDoc } from './store.js';

const COOKIE = 'posty_sid';

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!secret.memo) {
    secret.memo = crypto.randomBytes(32).toString('hex');
    console.warn('[posty] SESSION_SECRET not set — using a random secret; sessions will reset on restart. On Vercel this MUST be set (instances do not share memory).');
  }
  return secret.memo;
}

function sign(sid) {
  return hmacSha256(secret(), `sid:${sid}`);
}

function validSid(raw) {
  if (!raw) return null;
  const [sid, sig] = raw.split('.');
  if (!sid || !sig || !/^[A-Za-z0-9_-]{16,64}$/.test(sid)) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(sid));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return sid;
}

function setCookie(res, sid) {
  const secure = process.env.COOKIE_SECURE === '1' || (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0');
  const parts = [`${COOKIE}=${sid}.${sign(sid)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=2592000'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Every visitor gets a session; Buffer tokens attach to it on OAuth connect.
// Data isolation boundary = sid (one browser session = one Posty user).
// Exception: cookieless requests from this machine (desktop overlay, curl)
// share one stable local workspace instead of minting an orphan session per
// request — otherwise overlay captures would never appear in the web UI.
// Note: on hosts whose internal hop presents a loopback address (e.g. Vercel),
// first-visit browsers land here too, so the deployment effectively shares one
// workspace. That is the owner's chosen tradeoff: the companion works by
// pointing it at the app URL, no per-client setup.
export const LOCAL_SID = 'local-single-user-workspace';

function isLoopback(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function localOriginOk(req) {
  const o = req.headers.origin;
  if (!o) return true; // curl, native clients: no Origin to check
  try {
    const host = new URL(o).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === 'tauri.localhost';
  } catch {
    return false;
  }
}

async function loadOrCreate(sid) {
  let session = await readDoc('session', sid, 'session', null);
  if (!session) {
    session = { sid, createdAt: new Date().toISOString(), buffer: null };
    await writeDoc('session', sid, 'session', session);
  }
  return session;
}

export async function getSession(req, res) {
  const cookies = parseCookies(req);
  let sid = validSid(cookies[COOKIE]);
  if (!sid && isLoopback(req) && localOriginOk(req)) sid = LOCAL_SID;
  if (!sid) {
    sid = randId(18);
    setCookie(res, sid);
  } else if (!cookies[COOKIE]) {
    setCookie(res, sid);
  }
  return loadOrCreate(sid);
}

export async function saveSession(session) {
  await writeDoc('session', session.sid, 'session', session);
}

export function publicSession(session, oauthConfigured) {
  const b = session.buffer;
  return {
    connected: Boolean(b?.accessToken),
    needsReauth: Boolean(b?.needsReauth),
    organization: b?.organization || null,
    oauthConfigured,
  };
}
