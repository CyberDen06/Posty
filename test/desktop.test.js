import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  desktopExeCandidates,
  findDesktopExe,
  shouldAutoLaunchDesktop,
  splitArgs,
  parseTasklist,
} from '../lib/desktop.js';

test('auto-launch is local-Windows-only with opt-outs', () => {
  assert.equal(shouldAutoLaunchDesktop({ platform: 'win32', env: {} }), true);
  assert.equal(shouldAutoLaunchDesktop({ platform: 'darwin', env: {} }), false);
  assert.equal(shouldAutoLaunchDesktop({ platform: 'linux', env: {} }), false);
  assert.equal(shouldAutoLaunchDesktop({ platform: 'win32', env: { VERCEL: '1' } }), false);
  assert.equal(shouldAutoLaunchDesktop({ platform: 'win32', env: { POSTY_NO_DESKTOP: '1' } }), false);
});

test('exe lookup prefers release, then debug, override wins', () => {
  const [release, debug] = desktopExeCandidates({});
  assert.match(release, /release[\\/]posty-desktop\.exe$/);
  assert.match(debug, /debug[\\/]posty-desktop\.exe$/);
  assert.deepEqual(desktopExeCandidates({ POSTY_DESKTOP_EXE: 'C:\\custom\\app.exe' }), ['C:\\custom\\app.exe']);
});

test('findDesktopExe returns an existing file or null', () => {
  assert.equal(findDesktopExe({ POSTY_DESKTOP_EXE: process.execPath }), process.execPath);
  assert.equal(findDesktopExe({ POSTY_DESKTOP_EXE: 'C:\\definitely\\not\\here.exe' }), null);
});

test('splitArgs respects quotes', () => {
  assert.deepEqual(splitArgs('-e "a b" c'), ['-e', 'a b', 'c']);
  assert.deepEqual(splitArgs("--x '1 2'"), ['--x', '1 2']);
  assert.deepEqual(splitArgs(''), []);
});

test('parseTasklist spots a running companion', () => {
  assert.equal(parseTasklist('Image Name                     PID Session Name\nposty-desktop.exe             1234 Console\n'), true);
  assert.equal(parseTasklist('INFO: No tasks are running which match the specified criteria.\n'), false);
  assert.equal(parseTasklist('Image Name                     PID Session Name\nnode.exe                    1234 Console\n'), false);
  assert.equal(parseTasklist(''), false);
});

// --- /api/desktop/state: overlay → server → web cue bridge -------------------
const tmpData = path.join(os.tmpdir(), `posty-desktop-state-test-${process.pid}`);
process.env.DATA_DIR = tmpData;
test.after(() => { fs.rmSync(tmpData, { recursive: true, force: true }); });

const { handleNodeRequest } = await import('../lib/app.js');

function mockRes() {
  const headers = {};
  const res = {
    headers,
    statusCode: 0,
    body: '',
    writableEnded: false,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    writeHead(status, h = {}) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = v;
    },
    end(b = '') { res.body += b; res.writableEnded = true; },
  };
  return res;
}

function stateReq(method, json) {
  const base = {
    method,
    url: '/api/desktop/state',
    headers: { host: '127.0.0.1:3000', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  if (json === undefined) return base;
  const buf = Buffer.from(JSON.stringify(json));
  const handlers = {};
  return {
    ...base,
    on(ev, fn) {
      (handlers[ev] ||= []).push(fn);
      if (ev === 'end') {
        queueMicrotask(() => {
          (handlers.data || []).forEach((f) => f(buf));
          (handlers.end || []).forEach((f) => f());
        });
      }
      return this;
    },
    destroy() {},
  };
}

test('desktop state reports defaults until the overlay checks in', async () => {
  const before = mockRes();
  await handleNodeRequest(stateReq('GET'), before);
  assert.equal(before.statusCode, 200);
  assert.deepEqual(JSON.parse(before.body), {
    hotkeys: { dump: 'ctrl+shift+space', highlight: 'ctrl+shift+h' },
    live: false,
  });

  const post = mockRes();
  await handleNodeRequest(stateReq('POST', { dump: 'alt+f9', highlight: 'alt+f10' }), post);
  assert.equal(post.statusCode, 200);

  const after = mockRes();
  await handleNodeRequest(stateReq('GET'), after);
  assert.deepEqual(JSON.parse(after.body), {
    hotkeys: { dump: 'alt+f9', highlight: 'alt+f10' },
    live: true,
  });
});

test('desktop state rejects malformed hotkeys', async () => {
  for (const bad of [{}, { dump: 'alt+f9' }, { dump: 'x'.repeat(41), highlight: 'alt+f10' }, { dump: 'no-plus-here', highlight: 'alt+f10' }]) {
    const res = mockRes();
    await handleNodeRequest(stateReq('POST', bad), res);
    assert.equal(res.statusCode, 400);
  }
});
