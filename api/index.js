import { loadEnv } from '../lib/util.js';
import { handleNodeRequest } from '../lib/app.js';

loadEnv();

// Vercel entry point. Accepts both the Web-standard fetch form
// (handler(request) -> Response) and the classic Node (req, res) form,
// adapting the former onto the same handler the local server uses.
export default async function handler(req, res) {
  if (req && typeof req.arrayBuffer === 'function' && res === undefined) {
    const body = Buffer.from(await req.arrayBuffer());
    const headers = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const url = new URL(req.url);
    const listeners = {};
    let flushed = false;
    const flush = () => {
      if (flushed) return;
      flushed = true;
      if (body.length) for (const cb of listeners.data || []) cb(body);
      for (const cb of listeners.end || []) cb();
    };
    const nodeReq = {
      method: req.method,
      url: url.pathname + url.search,
      headers,
      on(evt, cb) {
        (listeners[evt] = listeners[evt] || []).push(cb);
        if (evt === 'end') queueMicrotask(flush);
        return this;
      },
      destroy() {},
    };
    const resHeaders = {};
    let status = 200;
    let ended = false;
    const chunks = [];
    const nodeRes = {
      get statusCode() { return status; },
      set statusCode(s) { status = s; },
      get writableEnded() { return ended; },
      setHeader(k, v) { resHeaders[String(k).toLowerCase()] = v; },
      writeHead(s, h) {
        status = s;
        for (const [k, v] of Object.entries(h || {})) resHeaders[String(k).toLowerCase()] = v;
      },
      end(b) {
        if (b !== undefined) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b)));
        ended = true;
      },
    };
    await handleNodeRequest(nodeReq, nodeRes);
    return new Response(Buffer.concat(chunks), { status, headers: resHeaders });
  }
  return handleNodeRequest(req, res);
}
