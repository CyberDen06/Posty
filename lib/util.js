import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Load KEY=VALUE lines from .env into process.env (never overrides real env).
export function loadEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

export function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function readBytes(req, maxBytes = 33 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('audio exceeds the 32 MB limit'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal multipart/form-data text-field parser (share target, form posts).
// Returns { field: value } for text fields; file parts are skipped. Not a
// general parser — values are expected to be small UTF-8 text.
export function parseMultipart(buffer, contentType) {
  const m = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) throw Object.assign(new Error('multipart body is missing its boundary'), { status: 400 });
  const boundary = `--${(m[1] || m[2]).trim()}`;
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const fields = {};
  for (const part of text.split(boundary)) {
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd < 0) continue;
    const head = part.slice(0, headEnd);
    const name = head.match(/name="([^"]+)"/i)?.[1];
    if (!name || /filename=/i.test(head)) continue;
    fields[name] = part.slice(headEnd + 4).replace(/\r\n$/, '');
  }
  return fields;
}

export async function readJson(req, maxBytes) {
  const raw = (await readBody(req, maxBytes)).replace(/^\uFEFF/, '');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randId(bytes = 16) {
  return b64url(crypto.randomBytes(bytes));
}

export function hmacSha256(secret, msg) {
  return b64url(crypto.createHmac('sha256', secret).update(msg).digest());
}

export function sha256b64url(msg) {
  return b64url(crypto.createHash('sha256').update(msg).digest());
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Canonical URL for story dedupe: lowercase host, drop fragment, trailing
// slash, and tracking params. Never throws — falls back to trimmed input.
export function canonicalUrl(u) {
  try {
    const p = new URL(String(u).trim());
    p.hash = '';
    for (const k of [...p.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|igshid)/i.test(k)) p.searchParams.delete(k);
    }
    let s = p.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return String(u ?? '').trim().toLowerCase();
  }
}

export function normTitle(t) {
  return String(t ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function timeAgo(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

// fetch with a timeout that throws errors carrying .status for HTTP failures.
export async function fetchJson(url, { timeoutMs = 12000, headers = {}, method = 'GET', body } = {}) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`request failed with status ${res.status}`);
    err.status = res.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('provider returned a non-JSON response');
    err.status = 502;
    err.body = text.slice(0, 500);
    throw err;
  }
}
