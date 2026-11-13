// In-page helper: Alt+Shift+S sends the current selection straight to Posty,
// and answers background requests for the selected text.
(async () => {
  async function server() {
    const { postyUrl } = await chrome.storage.sync.get('postyUrl');
    return (postyUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
  }
  async function send(text) {
    const base = await server();
    const res = await fetch(`${base}/api/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'note',
        title: (document.title && document.title !== text ? document.title : 'Browser highlight').slice(0, 220),
        text: text.slice(0, 4000),
        url: location.href.slice(0, 2000),
      }),
    });
    if (!res.ok) throw new Error(`Posty server refused the capture (${res.status})`);
  }
  function flash(msg, ok) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;bottom:18px;right:18px;z-index:2147483647;background:${ok ? '#1d4d2b' : '#9c2b2e'};color:#fff;font:600 13px system-ui,sans-serif;padding:10px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  document.addEventListener('keydown', async (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      const text = String(window.getSelection()?.toString() || '').trim();
      if (!text) return flash('Select some text first.', false);
      try {
        await send(text);
        flash('Saved to Posty Ideas.', true);
      } catch (err) {
        flash(`Posty: ${err.message}`, false);
      }
    }
  });
})();
