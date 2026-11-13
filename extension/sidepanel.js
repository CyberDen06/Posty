// Side panel: the Posty web UI in a narrow frame (the app's own narrow CSS applies).
(async () => {
  const frame = document.getElementById('frame');
  const offline = document.getElementById('offline');
  const buttons = [...document.querySelectorAll('header button[data-route]')];
  let server = 'http://127.0.0.1:3000';

  async function load() {
    const { postyUrl } = await chrome.storage.sync.get('postyUrl');
    server = (postyUrl || server).replace(/\/$/, '');
    offline.hidden = true;
    frame.hidden = false;
    const current = buttons.find((b) => b.getAttribute('aria-current') === 'page') || buttons[0];
    frame.src = `${server}/${current.dataset.route}`;
  }
  frame.addEventListener('load', () => {
    // file:// or error pages surface as unreachable titles; probe honestly instead.
    fetch(`${server}/healthz`).catch(() => {
      frame.hidden = true;
      offline.hidden = false;
    });
  });
  buttons.forEach((b) => b.addEventListener('click', () => {
    buttons.forEach((x) => x.removeAttribute('aria-current'));
    b.setAttribute('aria-current', 'page');
    frame.src = `${server}/${b.dataset.route}`;
  }));
  document.getElementById('open-full').addEventListener('click', () => chrome.tabs.create({ url: `${server}/` }));
  document.getElementById('open-options').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  document.getElementById('retry').addEventListener('click', (e) => { e.preventDefault(); load(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.postyUrl) load();
  });
  load();
})();
