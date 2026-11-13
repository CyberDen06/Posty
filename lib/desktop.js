import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Desktop companion (Tauri sidebar) auto-launch for `npm start`.
// Local Windows only: finds the built exe and starts it detached, or kicks
// off a background debug build when Rust is present but no exe exists yet.
// Opt out with POSTY_NO_DESKTOP=1. Never runs on Vercel (api/index.js does
// not import this module).

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TAURI_DIR = path.join(HERE, '..', 'desktop', 'src-tauri');

export function desktopExeCandidates(env = process.env) {
  if (env.POSTY_DESKTOP_EXE) return [env.POSTY_DESKTOP_EXE];
  return [
    path.join(TAURI_DIR, 'target', 'release', 'posty-desktop.exe'),
    path.join(TAURI_DIR, 'target', 'debug', 'posty-desktop.exe'),
  ];
}

export function findDesktopExe(env = process.env) {
  return (
    desktopExeCandidates(env).find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }) || null
  );
}

export function shouldAutoLaunchDesktop({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return false;
  if (env.VERCEL || env.POSTY_NO_DESKTOP) return false;
  return true;
}

// Only the first companion instance holds the hotkeys, so launching a
// second one strands the user with a dead-looking overlay. Guard both the
// direct launch and the background-build finish with a tasklist check.
export function parseTasklist(out) {
  return String(out || '')
    .split('\n')
    .some((l) => l.trim().toLowerCase().startsWith('posty-desktop.exe'));
}

export function isDesktopRunning() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq posty-desktop.exe'], { encoding: 'utf8' });
    return r.status === 0 && parseTasklist(r.stdout);
  } catch {
    return false;
  }
}

export function cargoPath() {
  try {
    const r = spawnSync('where', ['cargo'], { encoding: 'utf8' });
    const line = String(r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return r.status === 0 && line ? line : null;
  } catch {
    return null;
  }
}

// Minimal quote-aware split for POSTY_DESKTOP_ARGS (dev/test override).
export function splitArgs(s) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of String(s || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function launchDesktop(exe, { env = process.env, log = () => {} } = {}) {
  const args = env.POSTY_DESKTOP_ARGS ? splitArgs(env.POSTY_DESKTOP_ARGS) : [];
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    child.on('error', (e) => log(`[posty] desktop companion failed to start (${e.message})`));
    log('[posty] desktop companion launched — press Ctrl+Shift+Space anywhere to summon it, Esc to hide');
    return true;
  } catch (e) {
    log(`[posty] desktop companion failed to start (${e.message})`);
    return false;
  }
}

export function ensureDesktop({ env = process.env, log = console.log } = {}) {
  // Dev override launches exactly what was asked — the dupe guard applies to
  // the real companion only.
  if (!env.POSTY_DESKTOP_EXE && isDesktopRunning()) {
    log('[posty] desktop companion already running — not starting a second one');
    return 'running';
  }
  const exe = findDesktopExe(env);
  if (exe) {
    launchDesktop(exe, { env, log });
    return 'launched';
  }
  const cargo = cargoPath();
  if (!cargo) {
    log('[posty] desktop companion not built — run: npm run desktop:build (needs Rust: https://rustup.rs)');
    return 'missing';
  }
  log('[posty] building the desktop companion in the background (first run takes a few minutes)…');
  const build = spawn(
    cargo,
    ['build', '--manifest-path', path.join(TAURI_DIR, 'Cargo.toml')],
    { stdio: 'ignore', windowsHide: true },
  );
  build.on('error', () => log('[posty] desktop build failed to start — run npm run desktop:build to see errors'));
  build.on('exit', (code) => {
    if (code !== 0) {
      log('[posty] desktop build failed — run npm run desktop:build to see errors');
      return;
    }
    if (!env.POSTY_DESKTOP_EXE && isDesktopRunning()) return; // someone got there first
    const built = findDesktopExe(env);
    if (built) launchDesktop(built, { env, log });
  });
  return 'building';
}
