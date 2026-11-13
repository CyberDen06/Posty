// Posty companion: shared helpers (no modules in service workers — loaded via importScripts where needed).
async function postyServer() {
  const { postyUrl } = await chrome.storage.sync.get('postyUrl');
  return (postyUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
}

async function postyCapture({ title, text, url }) {
  const server = await postyServer();
  const res = await fetch(`${server}/api/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'note', title: (title || '').slice(0, 220), text: (text || '').slice(0, 4000), url: (url || '').slice(0, 2000) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Posty server refused the capture (${res.status})`);
  return data;
}
