import fs from 'node:fs';
import path from 'node:path';

// Per-user store with two backends:
// - Local/single-instance: atomic JSON files under DATA_DIR (default).
// - Vercel: Upstash-compatible Redis over REST when KV_REST_API_URL and
//   KV_REST_API_TOKEN are set (from the Vercel Storage tab).
// Tokens live here server-side only and are never sent to the browser.

function dataDir() {
  return path.resolve(process.cwd(), process.env.DATA_DIR || './data');
}

function dir(...parts) {
  const d = path.join(dataDir(), ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Vercel's filesystem is read-only: file writes there always fail, so say
// exactly what to do instead of leaking a raw ENOENT to the UI.
function needWritable() {
  if (process.env.VERCEL && !useKv()) {
    throw new Error('Posty storage is not configured on this deployment — connect a Vercel KV database in the Storage tab and redeploy.');
  }
}

function safe(name) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(name)) throw new Error('invalid store key');
  return name;
}

// --- KV backend (Upstash REST semantics: GET for reads, POST with the value
// as the body for writes) ------------------------------------------------------
const useKv = () => Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

async function kvFetch(pathSuffix, { method = 'GET', body } = {}) {
  const res = await fetch(`${process.env.KV_REST_API_URL}${pathSuffix}`, {
    method,
    headers: { authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`store request failed with status ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('store returned a non-JSON response');
  }
}

async function kvGet(key) {
  const data = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (data?.error) throw new Error(`store error: ${data.error}`);
  const v = data?.result;
  if (v === null || v === undefined) return undefined;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

async function kvSet(key, value) {
  const data = await kvFetch(`/set/${encodeURIComponent(key)}`, { method: 'POST', body: JSON.stringify(value) });
  if (data?.error) throw new Error(`store error: ${data.error}`);
}

async function kvDel(key) {
  await kvFetch(`/del/${encodeURIComponent(key)}`, { method: 'POST' });
}

// --- file backend ---------------------------------------------------------------
function fileFor(kind, sid, name) {
  if (kind === 'user') return path.join(dir('users', safe(sid)), `${name}.json`);
  if (kind === 'session') return path.join(dir('sessions'), `${safe(sid)}.json`);
  throw new Error('unknown store kind');
}

function fileRead(kind, sid, name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(kind, sid, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function fileWrite(kind, sid, name, value) {
  needWritable();
  const file = fileFor(kind, sid, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
  return value;
}

// --- public API (async; backend chosen per call) ----------------------------------
function docKey(kind, sid, name) {
  return `posty:${kind}:${safe(sid)}:${name}`;
}

export async function readDoc(kind, sid, name, fallback) {
  if (!useKv()) return fileRead(kind, sid, name, fallback);
  try {
    const v = await kvGet(docKey(kind, sid, name));
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export async function writeDoc(kind, sid, name, value) {
  if (!useKv()) return fileWrite(kind, sid, name, value);
  await kvSet(docKey(kind, sid, name), value);
  return value;
}

export async function writePending(state, value) {
  const doc = { ...value, createdAt: new Date().toISOString() };
  if (!useKv()) {
    needWritable();
    fs.writeFileSync(path.join(dir('pending'), `${safe(state)}.json`), JSON.stringify(doc));
    return;
  }
  await kvSet(`posty:pending:${safe(state)}`, doc);
}

export async function readPending(state, ttlMs = 10 * 60 * 1000) {
  const key = `posty:pending:${safe(state)}`;
  try {
    let doc;
    if (!useKv()) {
      doc = JSON.parse(fs.readFileSync(path.join(dir('pending'), `${safe(state)}.json`), 'utf8'));
    } else {
      doc = await kvGet(key);
      if (doc === undefined) return null;
    }
    if (Date.now() - Date.parse(doc.createdAt) > ttlMs) {
      await deletePending(state);
      return null;
    }
    return doc;
  } catch {
    return null;
  }
}

export async function deletePending(state) {
  try {
    if (!useKv()) fs.rmSync(path.join(dir('pending'), `${safe(state)}.json`), { force: true });
    else await kvDel(`posty:pending:${safe(state)}`);
  } catch { /* already gone */ }
}

// --- shared TTL cache (provider responses, excerpts) ---------------------------
// Survives restarts and is shared across users/instances on the KV backend,
// which cuts rate-limit pressure on throttled providers.
import crypto from 'node:crypto';

export async function cacheGet(key, ttlMs) {
  try {
    if (!useKv()) {
      const file = path.join(dir('cache'), `${crypto.createHash('sha1').update(key).digest('hex')}.json`);
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - doc.at > ttlMs) return undefined;
      return doc.value;
    }
    const doc = await kvGet(`posty:cache:${key}`);
    if (!doc || Date.now() - doc.at > ttlMs) return undefined;
    return doc.value;
  } catch {
    return undefined;
  }
}

export async function cacheSet(key, value) {
  const doc = { at: Date.now(), value };
  if (!useKv()) {
    // Cache writes are best-effort: on an unconfigured deployment they would
    // only crash callers, so skip silently (reads already fall through).
    if (process.env.VERCEL) return;
    fs.writeFileSync(path.join(dir('cache'), `${crypto.createHash('sha1').update(key).digest('hex')}.json`), JSON.stringify(doc));
    return;
  }
  await kvSet(`posty:cache:${key}`, doc);
}
