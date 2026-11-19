import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { loadEnv } from './lib/util.js';
import { handleNodeRequest } from './lib/app.js';
import { isConfigured as bufferConfigured } from './lib/buffer.js';
import { ensureDesktop, shouldAutoLaunchDesktop } from './lib/desktop.js';

loadEnv();
const PORT = Number(process.env.PORT || 3000);
const handler = (req, res) => handleNodeRequest(req, res);

function listenWithHelp(server, port, label, onUp) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[posty] ${label} port ${port} is already in use — a stale Posty server is likely still running.`);
      console.error(`[posty] Windows:  netstat -ano | findstr :${port}   then   taskkill /PID <pid> /F`);
      console.error(`[posty] macOS/Linux:  lsof -ti tcp:${port} | xargs kill`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, onUp);
}

listenWithHelp(http.createServer(handler), PORT, 'HTTP', () => {
  console.log(`[posty] listening on http://localhost:${PORT}`);
  console.log(`[posty] Buffer OAuth ${bufferConfigured() ? 'configured (real scheduling available after connect)' : 'NOT configured (demo scheduling mode)'}`);
  // Judges (and users) get the sidebar without hunting for it: launch the
  // desktop companion alongside the server. Opt out: POSTY_NO_DESKTOP=1.
  if (shouldAutoLaunchDesktop()) ensureDesktop();
  // Automatic routines while the server runs (local/VM hosting): the saved
  // routine runs itself after its delivery slot. Vercel never executes this
  // file and uses vercel.json crons instead. Opt out: POSTY_NO_SCHEDULER=1.
  if (!process.env.POSTY_NO_SCHEDULER && !process.env.VERCEL) {
    import('./lib/cron.js').then(({ startLocalScheduler }) => startLocalScheduler({ log: console.log }));
  }
  // Judging convenience: open the app on interactive local boots. Never on
  // Vercel; POSTY_NO_OPEN=1 opts out (scripts, tests).
  if (process.stdout.isTTY && !process.env.VERCEL && !process.env.POSTY_NO_OPEN) {
    const openCmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    import('node:child_process').then(({ exec }) => exec(`${openCmd} http://localhost:${PORT}`, () => {}));
  }
});

// Buffer only accepts https:// redirect URIs, so local OAuth needs a TLS
// listener too. Plain http keeps serving the app + companions; the https
// port exists only so the Buffer callback has an https address to land on.
// A self-signed localhost cert is fine — the browser hops to it once during
// Connect (click through the one warning) and OAuth completes as normal.
function tlsOptions() {
  try {
    if (process.env.TLS_PFX && fs.existsSync(process.env.TLS_PFX)) {
      return { pfx: fs.readFileSync(process.env.TLS_PFX), passphrase: process.env.TLS_PASSPHRASE || '' };
    }
    if (process.env.TLS_KEY && process.env.TLS_CERT && fs.existsSync(process.env.TLS_KEY) && fs.existsSync(process.env.TLS_CERT)) {
      return { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) };
    }
  } catch (err) {
    console.warn(`[posty] TLS disabled — could not load certificate (${err.message})`);
  }
  return null;
}
const tls = tlsOptions();
if (tls) {
  const TLS_PORT = Number(process.env.TLS_PORT || 3443);
  listenWithHelp(https.createServer(tls, handler), TLS_PORT, 'TLS', () => {
    console.log(`[posty] TLS listening on https://localhost:${TLS_PORT} (Buffer callback)`);
  });
} else {
  console.log('[posty] TLS off — set TLS_PFX (or TLS_KEY/TLS_CERT) to enable an https callback for Buffer');
}
