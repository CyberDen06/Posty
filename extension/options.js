// Options: server URL + connection test + optional https-origin grant.
(async () => {
  const input = document.getElementById('url');
  const status = document.getElementById('status');
  const say = (msg, ok) => {
    status.textContent = msg;
    status.style.color = ok ? '#1d4d2b' : '#9c2b2e';
  };
  const { postyUrl } = await chrome.storage.sync.get('postyUrl');
  input.value = postyUrl || 'http://127.0.0.1:3000';

  // Ground truth for THIS browser: the API reports the effective binding, or
  // nothing when another extension won the conflict.
  try {
    const cmds = await chrome.commands.getAll();
    const want = { 'capture-selection': 'Send selection to Ideas', _execute_side_panel: 'Open side panel' };
    document.getElementById('bindings').innerHTML = Object.entries(want)
      .map(([name, label]) => {
        const c = cmds.find((x) => x.name === name);
        return `${label}: ${c && c.shortcut ? `<code>${c.shortcut}</code>` : '<strong>not set</strong>'}`;
      })
      .join('<br>');
  } catch {
    document.getElementById('bindings').textContent = 'Could not read shortcut bindings.';
  }

  document.getElementById('save').addEventListener('click', async () => {
    const url = input.value.trim().replace(/\/$/, '');
    if (!/^https?:\/\/.+/.test(url)) return say('Enter a full http(s) URL.', false);
    await chrome.storage.sync.set({ postyUrl: url });
    if (url.startsWith('https://')) {
      const origin = `${new URL(url).origin}/*`;
      const granted = await chrome.permissions.contains({ origins: [origin] });
      if (!granted) {
        const ok = await chrome.permissions.request({ origins: [origin] });
        if (!ok) return say('Saved, but the extension cannot reach that origin until you grant access.', false);
      }
    }
    say('Saved.', true);
  });
  document.getElementById('test').addEventListener('click', async () => {
    const url = input.value.trim().replace(/\/$/, '');
    say('Testing…');
    try {
      const res = await fetch(`${url}/healthz`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      say('Connected — the Posty server answered.', true);
    } catch (err) {
      say(`Not reachable (${err.message}). Is the server running and the origin granted?`, false);
    }
  });
})();
