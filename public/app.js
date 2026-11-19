const view = document.getElementById('view');
const connectSlot = document.getElementById('connect-slot');
const noticeSlot = document.getElementById('notice-slot');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body, timeoutMs } = {}) {
  let res;
  try {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error('The server took too long to respond — try again.');
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.needsReauth = Boolean(data.needsReauth);
    err.simulated = Boolean(data.simulated);
    throw err;
  }
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

function openModal(html) {
  modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const backdrop = modalRoot.firstElementChild;
  const close = () => { modalRoot.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  const first = modalRoot.querySelector('button, select, input, textarea');
  if (first) first.focus();
  return close;
}

function shortcutsModal() {
  const close = openModal(`<h2>Keyboard shortcuts</h2>
    <h3>In Posty</h3>
    <dl class="keys">
      <div><dt><kbd>?</kbd></dt><dd>Show this list</dd></div>
      <div><dt><kbd>Esc</kbd></dt><dd>Close dialogs</dd></div>
      <div><dt><kbd>Enter</kbd></dt><dd>Ask (when typing in the Ask box)</dd></div>
    </dl>
    <h3>Browser extension</h3>
    <p class="draft-meta">Bindings differ per browser and can lose to other extensions, so they are shown in the extension's options page instead of here. Set your own at chrome://extensions/shortcuts (Edge: edge://extensions/shortcuts).</p>
    <h3>Desktop app</h3>
    <dl class="keys">
      <div><dt><kbd data-hk="dump">ctrl+shift+space</kbd></dt><dd>Brain-dump overlay, from any app</dd></div>
      <div><dt><kbd data-hk="highlight">ctrl+shift+h</kbd></dt><dd>Capture highlighted text to Ideas</dd></div>
      <div><dt><kbd>Esc</kbd></dt><dd>Hide the overlay</dd></div>
    </dl>
    <p class="draft-meta" id="keys-desktop-note">Desktop hotkeys need the desktop app running; rebind them in the overlay's Hotkeys section.</p>
    <div class="btn-row"><button class="btn" data-close>Done</button></div>`);
  modalRoot.querySelector('[data-close]').addEventListener('click', close);
  // Swap in the effective pair (built-in or the user's rebind) when known.
  (async () => {
    try {
      const data = await api('/api/desktop/state');
      if (!data.hotkeys) return;
      const d = modalRoot.querySelector('[data-hk="dump"]');
      const h = modalRoot.querySelector('[data-hk="highlight"]');
      if (!d || !h) return; // modal already closed
      d.textContent = data.hotkeys.dump;
      h.textContent = data.hotkeys.highlight;
      if (data.live) {
        const note = modalRoot.querySelector('#keys-desktop-note');
        if (note) note.textContent = 'Live from your running desktop app; rebind them in the overlay’s Hotkeys section.';
      }
    } catch { /* static defaults stand */ }
  })();
}

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ago(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

const PROVIDER_LABEL = { hn: 'Hacker News', gdelt: 'GDELT', reddit: 'Reddit', exa: 'Exa web search', newsapi: 'NewsAPI (local dev)', capture: 'Your capture', demo: 'Demo' };

let me = null;
let meta = null;
let prefsCache = null;
async function prefs() {
  if (!prefsCache) prefsCache = await api('/api/preferences');
  return prefsCache;
}

async function refreshMe() {
  me = await api('/api/me');
  renderChrome();
}

function renderChrome() {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = location.hash.startsWith(`#/${a.dataset.nav}`);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (!me) return;
  if (me.connected) {
    connectSlot.innerHTML = `<span class="connect-state">Connected${me.organization ? ` · ${esc(me.organization.name)}` : ''}</span>
      <button class="btn small secondary" id="disconnect-btn">Disconnect</button>`;
    document.getElementById('disconnect-btn').addEventListener('click', async () => {
      await api('/api/auth/disconnect', { method: 'POST' });
      await refreshMe();
      toast('Buffer disconnected.');
      route();
    });
  } else if (!me.oauthConfigured) {
    connectSlot.innerHTML = `<span class="connect-state">Demo scheduling mode</span>`;
  } else {
    connectSlot.innerHTML = `<a class="btn small" href="/auth/buffer/start">Connect Buffer</a>`;
  }
  const notices = [];
  if (!me.oauthConfigured) {
    notices.push(`<div class="notice"><div class="notice-inner mock"><strong>Demo scheduling mode:</strong> Buffer isn't connected here yet, so scheduling is simulated and clearly labeled. Stories and drafts use live data.</div></div>`);
  }
  if (me.needsReauth) {
    notices.push(`<div class="notice"><div class="notice-inner mock"><strong>Buffer reconnect needed:</strong> your authorization expired or was revoked. <a href="/auth/buffer/start">Reconnect Buffer</a> to keep scheduling.</div></div>`);
  }
  noticeSlot.innerHTML = notices.join('');
}

function chipRow(id, label, items, selected) {
  return `<span class="label" style="font-weight:650" id="${id}-label">${esc(label)}</span>
    <div class="chip-row" id="${id}" role="group" aria-labelledby="${id}-label">
    ${items.map((n) => `<button type="button" class="chip" data-v="${esc(n)}" aria-pressed="${selected.has(n)}">${esc(n)}</button>`).join('') || '<span class="missing">None yet.</span>'}
    </div>`;
}
function bindChips(root, id, set) {
  root.querySelectorAll(`#${id} [data-v]`).forEach((b) => b.addEventListener('click', () => {
    set.has(b.dataset.v) ? set.delete(b.dataset.v) : set.add(b.dataset.v);
    b.setAttribute('aria-pressed', set.has(b.dataset.v));
  }));
}

function statusBadge(item) {
  const map = { Briefing: '', Captured: '', Selected: 'status-approved', 'Perspective added': 'status-approved', 'Draft ready': 'status-approved', Approved: 'status-approved', Queued: 'status-scheduled' };
  return `<span class="badge ${map[item.status] || ''}">${esc(item.status || 'Briefing')}</span>`;
}

function briefHtml(b, source) {
  return `<p class="summary">${esc(b.tldr)}</p>`
    + (b.keyPoints?.length ? `<details class="brief-points"><summary>Key points (${b.keyPoints.length}) — about 80% of the article</summary><ul>${b.keyPoints.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>` : '')
    + (b.conclusion ? `<p class="why">Bottom line: ${esc(b.conclusion)}</p>` : '')
    + `<p class="draft-meta">Article summary via ${esc(source || 'provider')}.</p>`;
}

function itemCard(item) {
  const isStory = item.kind !== 'capture';
  const s = isStory ? item.story : null;
  const c = isStory ? null : item.capture;
  const date = fmtDate(isStory ? s.date : item.createdAt);
  return `<article class="card" data-item="${esc(item.id)}">
    <div class="byline" style="margin-bottom:0.3rem">
      ${item.demo ? '<span class="badge mock">DEMO</span>' : ''}
      <span class="badge provider">${esc(isStory ? (PROVIDER_LABEL[s.provider] || 'story') : (c.type === 'voice' ? 'Voice note' : c.type === 'link' ? 'Saved link' : 'Note'))}</span>
      <span class="badge">${esc(item.origin === 'routine' ? 'Routine' : item.origin === 'capture' ? 'Capture' : item.origin === 'demo' ? 'Demo' : item.origin === 'ask' ? 'Ask' : 'Search')}</span>
      ${statusBadge(item)}
      ${isStory && s.localDevOnly ? '<span class="badge mock">Local-dev source</span>' : ''}
    </div>
    <h3 class="story-title"><a href="#/story/${esc(item.id)}">${esc(isStory ? s.title : (c.title || 'Untitled'))}</a></h3>
    <div class="byline">
      <span>${esc(isStory ? (s.source || 'Unknown source') : 'Your workspace')}</span>
      ${date ? `<span>${esc(date)}</span>` : '<span class="missing">Date unavailable</span>'}
      ${isStory ? (s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">Original link</a>` : '<span class="missing">Link unavailable</span>') : (c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">Saved link</a>` : '')}
    </div>
    ${isStory
      ? (s.brief ? briefHtml(s.brief, s.source) : s.summary ? `<p class="summary">${esc(s.summary)}</p><p class="draft-meta">${esc(s.summaryLabel || 'Summary')} via ${esc(s.source || 'provider')}.</p>` : '<p class="missing">No summary available for this source.</p>')
      : (c.text ? `<p class="summary">${esc(c.text.slice(0, 300))}${c.text.length > 300 ? '…' : ''}</p>` : '<p class="missing">No text yet.</p>')}
    ${!isStory && c.type === 'voice' ? '<p class="draft-meta">Spoken brain dump · transcribed with Muse Voice, in your words.</p>' : ''}
    ${isStory && s.why ? `<p class="why">${esc(s.why)}</p>` : ''}
    ${item.drafts?.length ? `<p class="draft-meta">${item.drafts.length} draft${item.drafts.length > 1 ? 's' : ''} · ${item.drafts.filter((d) => d.status === 'scheduled').length} scheduled</p>` : ''}
    <div class="btn-row">
      ${!isStory ? `<button class="btn small secondary" data-cap-edit="${esc(item.id)}">Edit</button>` : ''}
      ${!item.drafts?.length ? `<a class="btn small" href="#/story/${esc(item.id)}">Develop into drafts</a>` : ''}
      <button class="btn small ghost" data-del-item="${esc(item.id)}">Delete</button>
    </div>
    ${!isStory ? `<div data-cap-editor="${esc(item.id)}" hidden>
      <label class="field"><span class="label">Title</span><input type="text" data-cap-title maxlength="220" value="${esc(c.title || '')}"></label>
      <label class="field"><span class="label">Text</span><textarea data-cap-text maxlength="4000" style="min-height:80px">${esc(c.text || '')}</textarea></label>
      <div class="btn-row"><button class="btn small" data-cap-save="${esc(item.id)}">Save changes</button><button class="btn small ghost" data-cap-cancel="${esc(item.id)}">Cancel</button></div>
    </div>` : ''}
  </article>`;
}

// --- onboarding / settings editor --------------------------------------------
async function viewSetup(p, root, options = {}) {
  const R = root || view;
  const professions = Object.keys(meta.professions);
  R.innerHTML = `${options.heading === '' ? '' : `<h1>Set up Posty</h1><p class="lede">Tell Posty who you are and what you follow. Suggestions are editable starting points — change anything.</p>`}
    <form id="setup-form" class="card">
      <label class="field"><span class="label">Profession</span>
        <select id="f-profession" required>
          <option value="">Choose…</option>
          ${professions.map((x) => `<option ${p.profession === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}
        </select>
      </label>
      <div class="field"><span class="label" id="int-label">Interests</span>
        <div class="chip-row" id="interest-chips" role="group" aria-labelledby="int-label"></div>
        <div style="display:flex;gap:0.5rem">
          <input type="text" id="new-interest" maxlength="80" placeholder="Add your own interest" aria-label="Add your own interest">
          <button type="button" class="btn secondary" id="add-interest">Add</button>
        </div>
        <p class="hint">Select all that apply. Remove a suggestion with × — it is just a starting point.</p>
      </div>
      <div class="field" id="pillar-wrap"></div>
      <div class="grid-2">
        <div class="field"><span class="label">Tone</span>
          <select id="f-tone">${[...new Set([...meta.tones, p.tone])].map((t) => `<option ${p.tone === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
          <input type="text" id="f-tone-custom" maxlength="40" placeholder="Or type a custom tone" aria-label="Custom tone" style="margin-top:0.4rem">
        </div>
        <label class="field"><span class="label">Length</span>
          <select id="f-length">${meta.lengths.map((t) => `<option ${p.length === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        </label>
      </div>
      <div class="field" id="channels-wrap"></div>
      <div class="field"><span class="label" id="never-label">Topics you never want to post about</span>
        <div class="chip-row" id="never-chips" role="group" aria-labelledby="never-label"></div>
        <div style="display:flex;gap:0.5rem">
          <input type="text" id="new-never" maxlength="80" placeholder="e.g. client names, politics" aria-label="Add a never-post topic">
          <button type="button" class="btn secondary" id="add-never">Add</button>
        </div>
        <p class="hint">Stories matching these are filtered from discovery, and drafting on them is blocked.</p>
      </div>
      <div class="field"><span class="label">Writing samples (optional style references)</span>
        <p class="hint">Paste 1–2 posts you wrote and like. Posty may mirror their openings and length <em>only</em> when you enable the toggle below. Nothing is cloned automatically.</p>
        <div id="samples-wrap"></div>
        <label class="field" style="display:flex;gap:0.6rem;align-items:center;margin-top:0.6rem"><input type="checkbox" id="f-use-samples" ${p.useStyleRefs ? 'checked' : ''}> <span>Use my samples as style references</span></label>
        <label class="field"><span class="label">Style notes (optional)</span>
          <textarea id="f-style-notes" maxlength="1000" style="min-height:70px" placeholder="e.g. short sentences, no hashtags, dry humor">${esc(p.styleNotes || '')}</textarea>
        </label>
      </div>
      <label class="field"><span class="label">Weekly posting target</span>
        <input type="text" id="f-cadence" inputmode="numeric" value="${esc(String(p.cadenceTarget ?? 3))}" aria-label="Weekly posting target">
        <p class="hint">Posts per week you aim for. Progress shows in Calendar — no streaks, no pressure.</p>
      </label>
      <div class="btn-row"><button class="btn" type="submit">${options.submitLabel || 'Save and open Today'}</button></div>
    </form>`;

  const selected = new Set(p.interests);
  const pillars = new Set(p.pillars || []);
  const channels = new Set(p.preferredChannels?.length ? p.preferredChannels : ['linkedin', 'x']);
  const never = new Set(p.neverPost || []);
  let suggestions = p.profession && meta.professions[p.profession] ? [...meta.professions[p.profession]] : [];
  const chips = R.querySelector('#interest-chips');
  function drawInterests() {
    const all = [...new Set([...suggestions, ...selected])];
    chips.innerHTML = '';
    for (const name of all) {
      const on = selected.has(name);
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.innerHTML = `${esc(name)} <button type="button" aria-label="Remove ${esc(name)}">×</button>`;
      const toggle = () => { on ? selected.delete(name) : selected.add(name); drawInterests(); };
      chip.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') toggle(); });
      chip.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
      chip.querySelector('button').addEventListener('click', () => { selected.delete(name); suggestions = suggestions.filter((s) => s !== name); drawInterests(); });
      chips.appendChild(chip);
    }
    if (!all.length) chips.innerHTML = '<span class="missing">Choose a profession to see suggestions, or add your own below.</span>';
  }
  R.querySelector('#pillar-wrap').innerHTML = chipRow('pillar-chips', 'Content pillars', meta.pillars, pillars);
  bindChips(R, 'pillar-chips', pillars);
  R.querySelector('#channels-wrap').innerHTML = chipRow('channel-chips', 'Preferred social channels', meta.draftChannels.map((c) => c.label), new Set(meta.draftChannels.filter((c) => channels.has(c.id)).map((c) => c.label)));
  R.querySelectorAll('#channel-chips [data-v]').forEach((b) => b.addEventListener('click', () => {
    const id = meta.draftChannels.find((c) => c.label === b.dataset.v)?.id;
    if (!id) return;
    channels.has(id) ? channels.delete(id) : channels.add(id);
    b.setAttribute('aria-pressed', channels.has(id));
  }));
  const neverChips = R.querySelector('#never-chips');
  function drawNever() {
    neverChips.innerHTML = [...never].map((n) => `<span class="chip" aria-pressed="true">${esc(n)} <button type="button" data-rm="${esc(n)}" aria-label="Remove ${esc(n)}">×</button></span>`).join('') || '<span class="missing">None — Posty will draft on anything it finds.</span>';
    neverChips.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { never.delete(b.dataset.rm); drawNever(); }));
  }
  const samplesWrap = R.querySelector('#samples-wrap');
  let samples = [...(p.styleSamples || [])];
  function drawSamples() {
    samplesWrap.innerHTML = '';
    samples.forEach((s, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:0.5rem;margin-bottom:0.5rem';
      row.innerHTML = `<textarea maxlength="1000" style="min-height:64px" aria-label="Writing sample ${i + 1}">${esc(s)}</textarea>`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn small ghost';
      del.textContent = 'Remove';
      del.setAttribute('aria-label', `Remove sample ${i + 1}`);
      del.addEventListener('click', () => { samples.splice(i, 1); drawSamples(); });
      row.appendChild(del);
      row.querySelector('textarea').addEventListener('input', (e) => { samples[i] = e.target.value; });
      samplesWrap.appendChild(row);
    });
    if (samples.length < 5) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn small secondary';
      add.textContent = samples.length ? 'Add another sample' : 'Add a sample';
      add.addEventListener('click', () => { samples.push(''); drawSamples(); });
      samplesWrap.appendChild(add);
    }
  }
  R.querySelector('#f-profession').addEventListener('change', (e) => { suggestions = meta.professions[e.target.value] || []; drawInterests(); });
  R.querySelector('#add-interest').addEventListener('click', () => {
    const input = R.querySelector('#new-interest');
    const v = input.value.trim();
    if (v) { selected.add(v.slice(0, 80)); input.value = ''; drawInterests(); }
  });
  R.querySelector('#add-never').addEventListener('click', () => {
    const input = R.querySelector('#new-never');
    const v = input.value.trim();
    if (v) { never.add(v.slice(0, 80)); input.value = ''; drawNever(); }
  });
  drawInterests();
  drawNever();
  drawSamples();

  R.querySelector('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const profession = R.querySelector('#f-profession').value;
    if (!profession) return toast('Choose a profession first.', 'error');
    if (!selected.size) return toast('Select or add at least one interest.', 'error');
    if (!channels.size) return toast('Pick at least one preferred channel.', 'error');
    const customTone = R.querySelector('#f-tone-custom').value.trim();
    try {
      const data = await api('/api/preferences', { method: 'PUT', body: {
        profession, interests: [...selected], pillars: [...pillars],
        tone: customTone || R.querySelector('#f-tone').value, length: R.querySelector('#f-length').value,
        preferredChannels: [...channels], neverPost: [...never],
        styleSamples: samples.map((s) => s.trim()).filter(Boolean),
        styleNotes: R.querySelector('#f-style-notes').value,
        useStyleRefs: R.querySelector('#f-use-samples').checked,
        cadenceTarget: Number(R.querySelector('#f-cadence').value) || 0,
      } });
      prefsCache = data;
      await refreshMe();
      if (!options.stay) location.hash = '#/today';
      toast(options.toast || 'Preferences saved.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Today / briefing ----------------------------------------------------------
let todayState = { loading: false, error: null, warnings: [], items: [], findInterests: null, filtered: 0 };

async function viewToday(params) {
  if (params.get('connected')) toast('Buffer connected — real scheduling is on.', 'success');
  const p = await prefs();
  if (todayState.findInterests === null) todayState.findInterests = new Set(p.interests);
  try {
    const data = await api('/api/inbox');
    todayState.items = data.items.filter((i) => i.kind !== 'capture');
    todayState.error = null;
  } catch (err) { todayState.error = err.message; }
  draw();
  function draw() {
    const visible = todayState.items.filter((i) => !i.dismissed);
    const dismissed = todayState.items.length - visible.length;
    view.innerHTML = `<h1>Today</h1>
      <p class="lede">Your briefing: recent stories matched to your interests. Every story arrives with an initial draft — open it, add your take, and refine.</p>
      <div id="onboard-slot"></div>
      <div class="card">
        ${chipRow('find-chips', 'Search these interests', p.interests, todayState.findInterests)}
        <div class="btn-row">
          <button class="btn" id="find-btn" ${todayState.loading ? 'disabled' : ''}>${todayState.loading ? 'Searching…' : 'Find stories'}</button>
          ${todayState.loading ? '<span class="loading"><span class="spinner" aria-hidden="true"></span>Searching live sources and drafting…</span>' : ''}
        </div>
        <p class="draft-meta">Looking for something specific? <a href="#/ask">Ask Posty anything</a>.</p>
        ${todayState.filtered ? `<p class="draft-meta">${todayState.filtered} result${todayState.filtered > 1 ? 's' : ''} filtered by your never-post topics.</p>` : ''}
        ${todayState.warnings.map((w) => `<p class="draft-meta">Note: ${esc(w.provider)} — ${esc(w.message)}</p>`).join('')}
      </div>
      ${todayState.error ? `<div class="error-box" role="alert"><h3>Something failed</h3><p>${esc(todayState.error)}</p><button class="btn secondary small" id="retry-load">Retry</button></div>` : ''}
      ${!todayState.error && !visible.length ? `<div class="card empty"><h2>No stories yet</h2><p>Use “Find stories” above, run your <a href="#/routine">routine</a>, or <a href="#/sources">load the labeled demo</a>.</p></div>` : ''}
      <div id="story-list">${visible.map((i) => itemCard(i)).join('')}</div>
      ${dismissed ? `<p class="draft-meta">${dismissed} dismissed stor${dismissed > 1 ? 'ies' : 'y'} hidden.</p>` : ''}`;

    api('/api/onboarding').then((ob) => {
      const slot = document.getElementById('onboard-slot');
      if (!slot || ob.dismissed || ob.complete || !ob.next) return;
      slot.innerHTML = `<div class="card"><p><strong>Getting started · ${ob.done} of ${ob.total}</strong></p><p>Next up: <a href="${esc(ob.next.href)}">${esc(ob.next.label)}</a></p><div class="btn-row"><button class="btn small ghost" id="onboard-hide">Hide this</button></div></div>`;
      document.getElementById('onboard-hide').addEventListener('click', async () => {
        await api('/api/onboarding/dismiss', { method: 'POST' }).catch(() => {});
        slot.innerHTML = '';
      });
    }).catch(() => {});
    bindChips(view, 'find-chips', todayState.findInterests);
    document.getElementById('find-btn')?.addEventListener('click', async () => {
      if (!todayState.findInterests.size) return toast('Select at least one interest to search.', 'error');
      todayState.loading = true;
      todayState.error = null;
      draw();
      try {
        const data = await api('/api/stories/find', { method: 'POST', body: { interests: [...todayState.findInterests] } });
        todayState.warnings = data.warnings || [];
        todayState.filtered = data.filtered || 0;
        todayState.loading = false;
        const fresh = await api('/api/inbox');
        todayState.items = fresh.items.filter((i) => i.kind !== 'capture');
        draw();
        toast(data.items.length ? `Found ${data.items.length} fresh stor${data.items.length > 1 ? 'ies' : 'y'} with summaries — open one to draft.` : 'No fresh stories — everything found is already here.', 'success');
      } catch (err) {
        todayState.loading = false;
        todayState.error = err.message;
        draw();
      }
    });
    document.getElementById('retry-load')?.addEventListener('click', () => viewToday(params));
    view.querySelectorAll('[data-item]').forEach((card) => {
      const id = card.dataset.item;
      const row = document.createElement('div');
      row.className = 'btn-row';
      row.innerHTML = `<a class="btn small" href="#/story/${esc(id)}">Develop into idea</a><button class="btn small secondary" data-save>Save</button><button class="btn small ghost" data-dismiss>Dismiss</button>`;
      card.appendChild(row);
      row.querySelector('[data-save]').addEventListener('click', async () => {
        await api(`/api/inbox/${id}/save`, { method: 'POST' });
        toast('Saved to Ideas.', 'success');
        viewToday(params);
      });
      row.querySelector('[data-dismiss]').addEventListener('click', async () => {
        await api(`/api/inbox/${id}/dismiss`, { method: 'POST' });
        todayState.items = todayState.items.filter((i) => i.id !== id);
        draw();
      });
    });
  }
}

// --- story / capture workspace ---------------------------------------------------
async function viewStory(id) {
  let item;
  try {
    ({ item } = await api(`/api/inbox/${id}`));
  } catch (err) {
    view.innerHTML = `<div class="error-box" role="alert"><h3>Item unavailable</h3><p>${esc(err.message)}</p><p><a href="#/today">Back to Today</a></p></div>`;
    return;
  }
  const p = await prefs();
  const isStory = item.kind !== 'capture';
  const channelLabel = (cid) => meta.draftChannels.find((c) => c.id === cid)?.label || cid;
  let activeTab = item.drafts.find((d) => d.status !== 'skipped')?.channel || (p.preferredChannels[0] || 'linkedin');
  let editing = null;
  let refining = null;
  let autoTried = item.drafts.length > 0;

  function sourceBlock() {
    if (!isStory) {
      const c = item.capture;
      return `<article class="card">
        <div class="byline" style="margin-bottom:0.3rem">
          ${item.demo ? '<span class="badge mock">DEMO</span>' : ''}
          <span class="badge provider">${esc(c.type === 'link' ? 'Saved link' : 'Your note')}</span>${statusBadge(item)}
        </div>
        <h1 style="font-size:1.6rem">${esc(c.title || 'Untitled')}</h1>
        <div class="byline"><span>Captured ${esc(ago(item.createdAt))}</span>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">Saved link</a>` : ''}</div>
        ${c.text ? `<p class="summary">${esc(c.text)}</p><p class="draft-meta">Your note — only you supplied this.</p>` : ''}
        ${c.notes ? `<p class="draft-meta">Reading notes: ${esc(c.notes)}</p>` : ''}
        <p class="draft-meta"><strong>Private-source check:</strong> review names, clients, and identifying details before drafting. Nothing here leaves your workspace until you approve scheduling.</p>
      </article>`;
    }
    const s = item.story;
    const date = fmtDate(s.date);
    return `<article class="card">
      <div class="byline" style="margin-bottom:0.3rem">
        ${item.demo ? '<span class="badge mock">DEMO</span>' : ''}
        <span class="badge provider">${esc(PROVIDER_LABEL[s.provider] || 'story')}</span>${statusBadge(item)}
        ${s.localDevOnly ? '<span class="badge mock">Local-dev source</span>' : ''}
      </div>
      <h1 style="font-size:1.6rem">${esc(s.title)}</h1>
      <div class="byline">
        <span>${esc(s.source || 'Unknown source')}</span>
        ${date ? `<span>${esc(date)}${s.date ? ` (${esc(ago(s.date))})` : ''}</span>` : '<span class="missing">Date unavailable</span>'}
        ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">Original link</a>` : '<span class="missing">Link unavailable</span>'}
      </div>
      ${s.brief ? briefHtml(s.brief, s.source) : s.summary ? `<p class="summary">${esc(s.summary)}</p><p class="draft-meta">${esc(s.summaryLabel || 'Summary')} via ${esc(s.source || 'provider')} — sourced fact, not Posty’s opinion.</p>` : '<p class="missing">No summary available for this source.</p>'}
      ${s.why ? `<p class="why">${esc(s.why)}</p>` : ''}
    </article>`;
  }

  function draw() {
    const prompts = isStory ? meta.prompts : meta.capturePrompts;
    const selectedChannels = new Set(item.drafts.filter((d) => d.status !== 'skipped').map((d) => d.channel));
    view.innerHTML = `<p><a href="#/${isStory ? 'today' : 'ideas'}">← Back</a></p>
      ${sourceBlock()}
      <section class="card" aria-labelledby="take-h">
        <h2 id="take-h" style="margin-top:0">What’s your take?</h2>
        <ul id="take-prompts" class="take-prompts">${prompts.map((x) => `<li class="draft-meta">${esc(x)}</li>`).join('')}</ul>
        <p class="draft-meta" id="prompts-note" hidden></p>
        <div class="chip-row" role="group" aria-label="Quick reactions">
          ${meta.reactions.map((r) => `<button type="button" class="chip" data-reaction="${esc(r)}" aria-pressed="${item.perspective.reaction === r}">${esc(r)}</button>`).join('')}
          <button type="button" class="chip" data-reaction="" aria-pressed="${!item.perspective.reaction}">Neutral / no reaction</button>
        </div>
        <label class="field"><span class="label">Your perspective (optional — drafts without one stay neutral)</span>
          <textarea id="take-text" maxlength="2000" placeholder="Add your perspective in your own words…">${esc(item.perspective.text)}</textarea>
        </label>
        ${!isStory ? `<label class="field" style="display:flex;gap:0.6rem;align-items:center"><input type="checkbox" id="privacy-check"> <span>I’ve reviewed this for private details (names, clients, confidential info).</span></label>` : ''}
        <div class="btn-row"><button class="btn secondary" id="save-take">Save perspective</button></div>
      </section>
      <section aria-labelledby="drafts-h">
        <h2 id="drafts-h">Channel drafts</h2>
        <div class="card">
          ${chipRow('draft-ch-chips', 'Draft for', meta.draftChannels.map((c) => c.label), new Set(meta.draftChannels.filter((c) => selectedChannels.has(c.id)).map((c) => c.label)))}
          <div class="btn-row"><button class="btn" id="draft-btn">Draft my posts</button></div>
          <p class="hint">Each channel gets its own distinct draft, starting neutral. Add your perspective above, then refine — nothing is scheduled without your explicit approval.</p>
        </div>
        <div id="draft-list"></div>
      </section>`;

    let reaction = item.perspective.reaction || '';
    view.querySelectorAll('[data-reaction]').forEach((b) => b.addEventListener('click', () => {
      reaction = b.dataset.reaction;
      view.querySelectorAll('[data-reaction]').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    }));
    document.getElementById('save-take').addEventListener('click', async () => {
      try {
        const data = await api(`/api/inbox/${item.id}/perspective`, { method: 'POST', body: { text: document.getElementById('take-text').value, reaction } });
        item = data.item;
        draw();
        toast('Perspective saved. Use “Refine with my perspective” on a draft to weave it in.', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });

    // Swap the generic prompts for grounded ones when ready; click a
    // question to start answering it in the take box.
    (async () => {
      try {
        const data = await api(`/api/inbox/${item.id}/prompts`);
        if (!data.grounded || !data.questions?.length) return;
        const list = document.getElementById('take-prompts');
        if (!list) return;
        list.innerHTML = data.questions.map((q) => `<li><button type="button" class="prompt-q" data-prompt="${esc(q)}">${esc(q)}</button></li>`).join('');
        const note = document.getElementById('prompts-note');
        if (note) {
          note.hidden = false;
          note.textContent = `Questions grounded in this ${isStory ? 'story' : 'note'} — click one to start answering it.`;
        }
        list.querySelectorAll('[data-prompt]').forEach((b) => b.addEventListener('click', () => {
          const box = document.getElementById('take-text');
          const q = b.dataset.prompt;
          box.value = box.value.trim() ? `${box.value.trim()}\n\n${q}\n` : `${q}\n`;
          box.focus();
        }));
      } catch { /* generic prompts stay — never block the take box */ }
    })();

    const chosen = new Set(selectedChannels.size ? selectedChannels : [p.preferredChannels[0] || 'linkedin']);
    view.querySelectorAll('#draft-ch-chips [data-v]').forEach((b) => {
      const cid = meta.draftChannels.find((c) => c.label === b.dataset.v)?.id;
      b.setAttribute('aria-pressed', chosen.has(cid));
      b.addEventListener('click', () => {
        if (!cid) return;
        chosen.has(cid) ? chosen.delete(cid) : chosen.add(cid);
        b.setAttribute('aria-pressed', chosen.has(cid));
      });
    });
    document.getElementById('draft-btn').addEventListener('click', async (e) => {
      if (!chosen.size) return toast('Select at least one channel.', 'error');
      if (!isStory) {
        const checked = document.getElementById('privacy-check');
        if (checked && !checked.checked) return toast('Please confirm you reviewed this capture for private details first.', 'error');
      }
      e.target.disabled = true;
      e.target.textContent = 'Drafting…';
      try {
        const data = await api(`/api/inbox/${item.id}/drafts`, { method: 'POST', body: { channels: [...chosen] } });
        item = data.item;
        activeTab = [...chosen][0];
        draw();
        toast('Drafts ready for review.', 'success');
      } catch (err) { toast(err.message, 'error'); e.target.disabled = false; e.target.textContent = 'Draft my posts'; }
    });

    drawDrafts();
    // Lazy drafts: opening a draft-less story generates them for preferred channels.
    if (!autoTried && !item.drafts.some((d) => d.status !== 'skipped')) {
      autoTried = true;
      (async () => {
        document.getElementById('draft-list').innerHTML = '<p class="loading"><span class="spinner" aria-hidden="true"></span>Drafting for your preferred channels…</p>';
        try {
          const data = await api(`/api/inbox/${item.id}/drafts`, { method: 'POST', body: { channels: p.preferredChannels } });
          item = data.item;
          draw();
        } catch (err) {
          toast(err.message, 'error');
          drawDrafts();
        }
      })();
    }
  }

  function draftSourceLine() {
    if (!isStory) return `<div class="byline"><span>Based on your capture: ${esc(item.capture.title || 'Untitled')}</span></div>`;
    const s = item.story;
    return `<div class="byline"><span>Based on: ${esc(s.title)}</span><span>${esc(s.source || '')}</span>${s.date ? `<span>${esc(fmtDate(s.date))}</span>` : ''}</div>`;
  }

  function drawDrafts() {
    const list = document.getElementById('draft-list');
    const drafts = item.drafts.filter((d) => d.status !== 'skipped');
    if (!drafts.length) { list.innerHTML = '<div class="card empty"><p>No drafts yet — choose channels above and select “Draft my posts”.</p></div>'; return; }
    if (!drafts.some((d) => d.channel === activeTab)) activeTab = drafts[0].channel;
    list.innerHTML = `<div class="tabs" role="tablist" aria-label="Channel drafts">
        ${drafts.map((d) => `<button role="tab" data-tab="${d.channel}" aria-selected="${d.channel === activeTab}">${esc(channelLabel(d.channel))} ${d.status === 'scheduled' ? '· scheduled' : ''}</button>`).join('')}
      </div>
      <div id="draft-body"></div>`;
    list.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { activeTab = b.dataset.tab; editing = null; drawDrafts(); }));
    const d = drafts.find((x) => x.channel === activeTab);
    const body = document.getElementById('draft-body');
    const toneOptions = [...new Set([...meta.tones, d.tone])];
    body.innerHTML = `<div class="draft-card">
      <div class="draft-head">
        <h3>${esc(channelLabel(d.channel))} draft</h3>
        <span class="badge status-${d.status}">${esc(d.status)}</span>
        <span class="badge">${esc(d.origin === 'refined' ? 'refined with your take' : 'initial draft')}</span>
        ${d.engine === 'llm' ? '<span class="badge">LLM-assisted</span>' : '<span class="badge">Suggested wording</span>'}
        ${(d.influences || []).includes('tuned to your approvals') ? '<span class="badge">Tuned to you</span>' : ''}
        ${d.pillar ? `<span class="badge">${esc(d.pillar)}</span>` : ''}
      </div>
      ${draftSourceLine()}
      ${editing === d.id
        ? `<label class="field"><span class="label">Edit draft (your words)</span><textarea id="edit-text">${esc(d.text)}</textarea></label>
           <div class="btn-row"><button class="btn small" data-act="save-edit">Save edit</button><button class="btn small ghost" data-act="cancel-edit">Cancel</button></div>`
        : `<p class="draft-text">${esc(d.text)}</p>`}
      ${d.warning ? `<p class="draft-meta">${esc(d.warning)}</p>` : ''}
      <p class="draft-meta">Shaped by: ${d.influences.map(esc).join(' · ')}</p>
      ${d.schedule ? `<p class="draft-meta">Scheduled ${d.schedule.mode === 'real' ? 'with Buffer' : '(demo — not sent)'}${d.schedule.channelLabel ? ` · ${esc(d.schedule.channelLabel)}` : ''}${d.schedule.dueAt ? ` · ${esc(fmtDate(d.schedule.dueAt))}` : ' · next queue slot'}.</p>` : ''}
      ${d.feedback && (d.feedback.reflection || d.feedback.performance) ? `<p class="draft-meta">Your notes: ${esc(d.feedback.reflection || '')} ${esc(d.feedback.performance || '')}</p>` : ''}
      ${d.status !== 'scheduled' ? `
      <div class="draft-controls">
        <label>Tone <select data-field="tone">${toneOptions.map((t) => `<option ${d.tone === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label>Length <select data-field="length">${meta.lengths.map((t) => `<option ${d.length === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        ${d.channel === 'x' ? `<label>Format <select data-field="format"><option value="post" ${d.format !== 'thread' ? 'selected' : ''}>Single post</option><option value="thread" ${d.format === 'thread' ? 'selected' : ''}>Thread</option></select></label>` : ''}
        <label>Pillar <select data-field="pillar"><option value="">—</option>${p.pillars.map((t) => `<option ${d.pillar === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label>Planned date <input type="date" data-field="planned" value="${esc(d.plannedDate || '')}"></label>
        <button class="btn small secondary" data-act="regen">Refine with my perspective</button>
      </div>
      ${refining === d.id ? `<div style="display:flex;gap:0.5rem;margin-top:0.7rem">
          <input type="text" id="refine-input" placeholder="e.g. make it shorter, punchier opening" aria-label="How should Posty refine this draft">
          <button class="btn small" data-act="refine-go">Apply</button></div>` : ''}
      ${(d.history || []).length ? `<div class="draft-meta" style="margin-top:0.6rem">Previous versions:
        <select id="hist-select" aria-label="Previous versions">${d.history.map((h, i) => `<option value="${i}">${esc(h.label || `version ${i + 1}`)} · ${esc(ago(h.at))}</option>`).join('')}</select>
        <button class="btn small ghost" data-act="restore">Restore</button></div>` : ''}
      <div class="btn-row">
        ${editing !== d.id ? `<button class="btn small secondary" data-act="edit">Edit</button>` : ''}
        <button class="btn small secondary" data-act="refine">${refining === d.id ? 'Close refine' : 'Refine'}</button>
        <button class="btn small secondary" data-act="variant">Try alternative</button>
        <button class="btn small secondary" data-act="duplicate">Duplicate</button>
        <button class="btn small secondary" data-act="feedback">Add notes</button>
        <button class="btn small ghost" data-act="skip">Skip</button>
        <button class="btn small ghost" data-act="delete">Delete</button>
        <button class="btn small" data-act="approve">Approve &amp; add to Buffer queue…</button>
      </div>` : `
      <div class="btn-row"><button class="btn small secondary" data-act="feedback">${d.feedback ? 'Edit notes' : 'Add notes'}</button></div>
      <p class="draft-meta">Record what resonated or any performance summary — your notes only; Posty does not pull analytics.</p>`}
    </div>`;

    const refresh = async (fn) => {
      try {
        const data = await fn();
        if (data.draft) Object.assign(d, data.draft);
        editing = null;
        drawDrafts();
        return data;
      } catch (err) { toast(err.message, 'error'); return null; }
    };
    body.querySelector('[data-act="edit"]')?.addEventListener('click', () => { editing = d.id; drawDrafts(); });
    body.querySelector('[data-act="cancel-edit"]')?.addEventListener('click', () => { editing = null; drawDrafts(); });
    body.querySelector('[data-act="save-edit"]')?.addEventListener('click', async () => {
      const r = await refresh(() => api(`/api/drafts/${d.id}`, { method: 'PATCH', body: { text: document.getElementById('edit-text').value } }));
      if (r) toast('Edit saved — your words are kept.', 'success');
    });
    body.querySelector('[data-act="regen"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const payload = { tone: body.querySelector('[data-field="tone"]').value, length: body.querySelector('[data-field="length"]').value, pillar: body.querySelector('[data-field="pillar"]').value };
      const fmt = body.querySelector('[data-field="format"]');
      if (fmt) payload.format = fmt.value;
      const planned = body.querySelector('[data-field="planned"]').value;
      if (planned) await api(`/api/drafts/${d.id}`, { method: 'PATCH', body: { plannedDate: planned } }).catch((err) => toast(err.message, 'error'));
      const r = await refresh(() => api(`/api/drafts/${d.id}/regenerate`, { method: 'POST', body: payload }));
      if (r) toast(item.perspective.text || item.perspective.reaction ? 'Refined with your perspective. Previous version kept.' : 'Regenerated (still neutral — add a take to ground it).', 'success');
      else e.target.disabled = false;
    });
    body.querySelector('[data-act="variant"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const r = await refresh(() => api(`/api/drafts/${d.id}/variant`, { method: 'POST' }));
      if (r) toast('Alternative phrasing ready — previous version kept in history.', 'success');
      else e.target.disabled = false;
    });
    body.querySelector('[data-act="refine"]')?.addEventListener('click', () => { refining = refining === d.id ? null : d.id; drawDrafts(); });
    body.querySelector('[data-act="refine-go"]')?.addEventListener('click', async () => {
      const r = await refresh(() => api(`/api/drafts/${d.id}/refine`, { method: 'POST', body: { instruction: document.getElementById('refine-input').value } }));
      if (r) { refining = null; toast(r.draft.warning || 'Draft refined.', 'success'); }
    });
    body.querySelector('[data-act="restore"]')?.addEventListener('click', async () => {
      const r = await refresh(() => api(`/api/drafts/${d.id}/restore`, { method: 'POST', body: { index: Number(document.getElementById('hist-select').value) } }));
      if (r) toast('Previous version restored.', 'success');
    });
    body.querySelector('[data-act="duplicate"]')?.addEventListener('click', async () => {
      await api(`/api/drafts/${d.id}/duplicate`, { method: 'POST' });
      ({ item } = await api(`/api/inbox/${item.id}`));
      draw();
      toast('Draft duplicated.', 'success');
    });
    body.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      try {
        await api(`/api/drafts/${d.id}`, { method: 'DELETE' });
        ({ item } = await api(`/api/inbox/${item.id}`));
        draw();
        toast('Draft deleted.');
      } catch (err) { toast(err.message, 'error'); }
    });
    body.querySelector('[data-act="skip"]')?.addEventListener('click', async () => {
      await api(`/api/drafts/${d.id}/skip`, { method: 'POST' });
      item.drafts = item.drafts.filter((x) => x.id !== d.id);
      toast('Draft skipped.');
      draw();
    });
    body.querySelector('[data-act="feedback"]')?.addEventListener('click', () => {
      const close = openModal(`<h2>Notes on this draft</h2>
        <p class="draft-meta">Your private learning log. Posty does not fetch analytics — write what you observed.</p>
        <label class="field"><span class="label">What resonated?</span><textarea id="fb-r" style="min-height:70px">${esc(d.feedback?.reflection || '')}</textarea></label>
        <label class="field"><span class="label">Performance summary (optional, your words)</span><textarea id="fb-p" style="min-height:70px">${esc(d.feedback?.performance || '')}</textarea></label>
        <div class="btn-row"><button class="btn ghost" data-x>Cancel</button><button class="btn" data-savefb>Save notes</button></div>`);
      modalRoot.querySelector('[data-x]').addEventListener('click', close);
      modalRoot.querySelector('[data-savefb]').addEventListener('click', async () => {
        await api(`/api/drafts/${d.id}`, { method: 'PATCH', body: { feedback: { reflection: modalRoot.querySelector('#fb-r').value, performance: modalRoot.querySelector('#fb-p').value } } });
        close();
        ({ item } = await api(`/api/inbox/${item.id}`));
        draw();
        toast('Notes saved.', 'success');
      });
    });
    body.querySelector('[data-act="approve"]')?.addEventListener('click', () => approveFlow(d));
  }

  async function approveFlow(d) {
    let approval;
    try {
      approval = await api(`/api/drafts/${d.id}/approve`, { method: 'POST' });
      d.status = 'approved';
    } catch (err) { return toast(err.message, 'error'); }
    const close = openModal(`<h2>Approve &amp; add to Buffer queue</h2>
      <p>You are approving <strong>only this ${esc(d.channel)} draft</strong>. Review the exact text and channel:</p>
      <pre class="confirm-text">${esc(approval.text)}</pre>
      <div id="sched-fields"><p class="loading"><span class="spinner" aria-hidden="true"></span>Loading your Buffer channels…</p></div>
      <div class="modal-foot"><button class="btn ghost" data-close>Cancel</button></div>`);
    modalRoot.querySelector('[data-close]').addEventListener('click', () => { close(); drawDrafts(); });

    let channels = [];
    let mode = 'mock';
    try {
      const data = await api('/api/buffer/channels');
      channels = data.channels;
      mode = data.mode;
    } catch (err) {
      modalRoot.querySelector('#sched-fields').innerHTML = `<div class="error-box" role="alert"><h3>Couldn’t load channels</h3><p>${esc(err.message)}</p>
        ${err.needsReauth && me.oauthConfigured ? '<p><a href="/auth/buffer/start">Reconnect Buffer</a>, then approve again.</p>' : '<div class="btn-row"><button class="btn secondary small" id="retry-channels">Retry</button></div>'}</div>`;
      modalRoot.querySelector('#retry-channels')?.addEventListener('click', () => { close(); approveFlow(d); });
      return;
    }
    if (!channels.length) {
      modalRoot.querySelector('#sched-fields').innerHTML = `<div class="error-box"><h3>No channels available</h3><p>Your Buffer account has no connected channels${mode === 'real' ? ' — connect one in Buffer first' : ''}.</p></div>`;
      return;
    }
    const idempotencyKey = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));
    modalRoot.querySelector('#sched-fields').innerHTML = `
      <p>${mode === 'real'
        ? '<span class="badge real">Real Buffer scheduling</span>'
        : '<span class="badge mock">Demo scheduling</span> <span class="draft-meta">Not sent to Buffer.</span>'}</p>
      <label class="field"><span class="label">Buffer channel</span>
        <select id="sched-channel">${channels.map((c) => `<option value="${esc(c.id)}" data-label="${esc(c.displayName || c.name)}">${esc(c.displayName || c.name)} (${esc(c.service || '')})</option>`).join('')}</select>
      </label>
      <label class="field"><span class="label">When</span>
        <select id="sched-mode"><option value="addToQueue">Add to queue (next free slot)</option><option value="customScheduled">Schedule for a specific time</option></select>
      </label>
      <label class="field" id="due-wrap" hidden><span class="label">Date and time</span><input type="datetime-local" id="sched-due"></label>
      <div id="sched-result"></div>`;
    modalRoot.querySelector('.modal-foot').insertAdjacentHTML('beforeend', '<button class="btn" id="confirm-schedule">Confirm and schedule</button>');
    modalRoot.querySelector('#sched-mode').addEventListener('change', (e) => {
      modalRoot.querySelector('#due-wrap').hidden = e.target.value !== 'customScheduled';
    });
    modalRoot.querySelector('#confirm-schedule').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const sel = modalRoot.querySelector('#sched-channel');
      const schedMode = modalRoot.querySelector('#sched-mode').value;
      const dueRaw = modalRoot.querySelector('#sched-due').value;
      if (schedMode === 'customScheduled' && !dueRaw) {
        e.target.disabled = false;
        return toast('Pick a date and time for scheduled posting.', 'error');
      }
      try {
        const data = await api(`/api/drafts/${d.id}/schedule`, { method: 'POST', body: { bufferChannelId: sel.value, bufferChannelLabel: sel.selectedOptions[0].dataset.label, confirmToken: approval.confirmToken, idempotencyKey, mode: schedMode, dueAt: dueRaw ? new Date(dueRaw).toISOString() : undefined } });
        Object.assign(d, data.draft);
        const sch = d.schedule;
        modalRoot.querySelector('#sched-result').innerHTML = `<div class="notice-inner info" style="margin-top:1rem" role="status">
          <strong>${sch.mode === 'real' ? 'Scheduled with Buffer.' : 'Demo scheduled (not sent).'}</strong><br>${esc(sch.label || '')}</div>`;
        modalRoot.querySelector('#confirm-schedule').remove();
        modalRoot.querySelector('.modal-foot').insertAdjacentHTML('beforeend', '<button class="btn" id="sched-done">Done</button>');
        modalRoot.querySelector('#sched-done').addEventListener('click', () => { close(); drawDrafts(); });
      } catch (err) {
        e.target.disabled = false;
        modalRoot.querySelector('#sched-result').innerHTML = `<div class="error-box" role="alert"><h3>Scheduling failed — your draft is safe</h3><p>${esc(err.message)}${err.simulated ? ' (simulated failure)' : ''}</p>
          ${err.needsReauth && me.oauthConfigured ? '<p><a href="/auth/buffer/start">Reconnect Buffer</a>, then approve again.</p>' : '<p>Nothing was scheduled. You can retry.</p>'}</div>`;
      }
    });
  }

  draw();
}

// --- Ideas / captures ----------------------------------------------------------
// 16-bit PCM mono WAV encoder: the transcription API accepts WAV only, so the
// mic path encodes in-page (no server-side ffmpeg, no extra dependency).
function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); wstr(8, 'WAVE'); wstr(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wstr(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function viewIdeas() {
  const data = await api('/api/inbox');
  const items = data.items.filter((i) => !i.dismissed && (i.kind === 'capture' || i.saved || (i.perspective.text || i.perspective.reaction || i.drafts.length)));
  let fOrigin = '';
  let dumpTab = 'type';
  const matchOrigin = (i) => {
    if (fOrigin === 'voice') return i.kind === 'capture' && i.capture.type === 'voice';
    if (fOrigin === 'note') return i.kind === 'capture' && i.capture.type === 'note';
    if (fOrigin === 'link') return i.kind === 'capture' && i.capture.type === 'link';
    if (fOrigin === 'saved') return i.kind !== 'capture' && i.saved;
    if (fOrigin === 'routine') return i.origin === 'routine';
    if (fOrigin === 'asked') return i.origin === 'ask';
    return true;
  };
  function draw() {
    const list = items.filter(matchOrigin);
    view.innerHTML = `<h1>Ideas</h1>
    <p class="lede">Everything you’re developing: captured notes and links, saved stories, and anything with a perspective or draft.</p>
    <div class="card">
      <h2 style="margin-top:0">Brain dump</h2>
      <div class="tabs" role="tablist" aria-label="Capture mode" style="margin-bottom:1rem">
        <button type="button" class="tab" role="tab" aria-selected="${dumpTab === 'type'}" data-tab="type">Type it</button>
        <button type="button" class="tab" role="tab" aria-selected="${dumpTab === 'speak'}" data-tab="speak">Speak it</button>
      </div>
      ${dumpTab === 'type' ? `
      <div class="grid-2">
        <label class="field"><span class="label">Note title</span><input type="text" id="cap-title" maxlength="220" placeholder="What did you notice or ship?"></label>
        <label class="field"><span class="label">Link (optional)</span><input type="text" id="cap-url" placeholder="https://…"></label>
      </div>
      <label class="field"><span class="label">Note</span><textarea id="cap-text" maxlength="4000" style="min-height:80px" placeholder="The details, in your own words…"></textarea></label>
      <div class="btn-row"><button class="btn" id="cap-save">Save capture</button></div>`
      : `
      <div id="voice-box">
        ${me.voiceReady === false
          ? '<p class="missing">Voice transcription is not available right now — typing works regardless.</p>'
          : `<p class="hint">Press record, talk through the idea (up to 2 minutes), then stop. Your words are transcribed and saved as an idea.</p>
             <div class="btn-row"><button class="btn" id="voice-rec">Record</button><span class="draft-meta" id="voice-status" role="status"></span></div>
             <div id="voice-result"></div>`}
      </div>`}
      <p class="hint">Captures stay private in your workspace. Develop one into an idea to draft from it.</p>
    </div>
    <div class="card tight"><div class="draft-controls" style="margin-top:0">
      <label>Origin <select id="f-origin">
        <option value="">All</option>
        <option value="voice" ${fOrigin === 'voice' ? 'selected' : ''}>Voice notes</option>
        <option value="note" ${fOrigin === 'note' ? 'selected' : ''}>Typed notes</option>
        <option value="link" ${fOrigin === 'link' ? 'selected' : ''}>Saved links</option>
        <option value="saved" ${fOrigin === 'saved' ? 'selected' : ''}>Saved stories</option>
        <option value="routine" ${fOrigin === 'routine' ? 'selected' : ''}>Routine</option>
        <option value="asked" ${fOrigin === 'asked' ? 'selected' : ''}>Asked</option>
      </select></label>
    </div></div>
    ${list.length ? list.map((i) => itemCard(i)).join('') : '<div class="card empty"><p>No ideas match this filter yet.</p></div>'}`;
    view.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { dumpTab = b.dataset.tab; stopVoice(); draw(); }));
    document.getElementById('f-origin').addEventListener('change', (e) => { fOrigin = e.target.value; draw(); });
    document.getElementById('cap-save')?.addEventListener('click', async () => {
      const url = document.getElementById('cap-url').value.trim();
      try {
        await api('/api/captures', { method: 'POST', body: {
          type: url ? 'link' : 'note',
          title: document.getElementById('cap-title').value.trim(),
          text: document.getElementById('cap-text').value.trim(),
          url,
        } });
        toast('Capture saved.', 'success');
        viewIdeas();
      } catch (err) { toast(err.message, 'error'); }
    });
    document.getElementById('voice-rec')?.addEventListener('click', toggleVoice);
  }

  let rec = null; // { ctx, stream, proc, chunks, startedAt, timer }
  function stopVoice() {
    if (!rec) return;
    clearInterval(rec.timer);
    try { rec.proc.disconnect(); } catch { /* already stopped */ }
    try { rec.stream.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
    rec.ctx.close().catch(() => {});
    rec = null;
  }
  async function toggleVoice() {
    const btn = document.getElementById('voice-rec');
    const status = document.getElementById('voice-status');
    if (rec) {
      btn.disabled = true;
      status.textContent = 'Encoding…';
      const chunks = rec.chunks;
      const rate = rec.ctx.sampleRate;
      stopVoice();
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const flat = new Float32Array(total);
      let o = 0;
      for (const c of chunks) { flat.set(c, o); o += c.length; }
      status.textContent = 'Transcribing…';
      try {
        const wav = encodeWav(flat, rate);
        const res = await fetch('/api/captures/voice', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav, signal: AbortSignal.timeout(150000) });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || `Voice capture failed (${res.status})`);
        toast('Voice note saved to Ideas.', 'success');
        viewIdeas();
      } catch (err) {
        toast(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'Transcription took too long — try a shorter recording.' : err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Record';
        status.textContent = '';
      }
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('This browser does not expose a microphone to this page — type your idea instead.', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      proc.onaudioprocess = (e) => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      src.connect(proc);
      proc.connect(ctx.destination);
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        status.textContent = `Recording… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} (max 2:00)`;
        if (s >= 120) toggleVoice();
      }, 500);
      rec = { ctx, stream, proc, chunks, timer };
      btn.textContent = 'Stop & save';
      status.textContent = 'Recording… 0:00 (max 2:00)';
    } catch (err) {
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      toast(denied ? 'Microphone access was denied — allow it in the browser address bar, or type instead.' : `Could not start recording (${err.message}).`, 'error');
    }
  }
  draw();
}

// --- Drafts overview -------------------------------------------------------------
async function viewDrafts() {
  const data = await api('/api/inbox');
  const rows = [];
  for (const item of data.items) {
    if (item.dismissed) continue;
    const title = item.kind === 'capture' ? (item.capture.title || 'Untitled') : item.story.title;
    for (const d of (item.drafts || []).filter((x) => x.status !== 'skipped')) {
      rows.push({ item, draft: d, title });
    }
  }
  let fStatus = '';
  let fChannel = '';
  function draw() {
    const list = rows.filter((r) => (!fStatus || r.draft.status === fStatus) && (!fChannel || r.draft.channel === fChannel));
    view.innerHTML = `<h1>Drafts</h1>
      <p class="lede">Every draft in one place, newest first. Open the parent idea to edit, refine, or approve.</p>
      <div class="card tight"><div class="draft-controls" style="margin-top:0">
        <label>Status <select id="f-status"><option value="">All</option>${['suggested', 'edited', 'approved', 'scheduled'].map((s) => `<option value="${s}" ${fStatus === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label>Channel <select id="f-channel"><option value="">All</option>${meta.draftChannels.map((c) => `<option value="${c.id}" ${fChannel === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
      </div></div>
      ${list.length ? list.map((r) => `<div class="card tight">
          <div class="draft-head"><strong>${esc(meta.draftChannels.find((c) => c.id === r.draft.channel)?.label || r.draft.channel)}</strong>
          <span class="badge status-${r.draft.status}">${esc(r.draft.status)}</span>
          ${r.draft.pillar ? `<span class="badge">${esc(r.draft.pillar)}</span>` : ''}
          ${r.item.demo ? '<span class="badge mock">DEMO</span>' : ''}</div>
          <p class="draft-meta">From: <a href="#/story/${esc(r.item.id)}">${esc(r.title.slice(0, 90))}</a></p>
          <p class="draft-text">${esc(r.draft.text.slice(0, 220))}${r.draft.text.length > 220 ? '…' : ''}</p>
        </div>`).join('') : '<div class="card empty"><p>No drafts yet — develop a story or capture first.</p></div>'}`;
    document.getElementById('f-status').addEventListener('change', (e) => { fStatus = e.target.value; draw(); });
    document.getElementById('f-channel').addEventListener('change', (e) => { fChannel = e.target.value; draw(); });
  }
  draw();
}

// --- Calendar / queue ----------------------------------------------------------
async function viewCalendar() {
  const p = await prefs();
  const data = await api('/api/inbox');
  const items = data.items.filter((i) => !i.dismissed);
  const rows = [];
  for (const item of items) {
    const title = item.kind === 'capture' ? (item.capture.title || 'Untitled') : item.story.title;
    const topic = item.kind === 'capture' ? 'capture' : (item.story.matchedInterest || item.story.provider);
    const source = item.kind === 'capture' ? 'capture' : (item.origin === 'routine' ? 'routine' : item.story.provider);
    for (const d of (item.drafts || []).filter((x) => x.status !== 'skipped')) {
      rows.push({ item, draft: d, title, topic, source });
    }
  }
  let fStatus = '';
  let fChannel = '';
  let fSource = '';
  const monday = new Date();
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);
  const doneThisWeek = rows.filter((r) => ['approved', 'scheduled'].includes(r.draft.status) && (r.draft.updatedAt || '').slice(0, 10) >= weekStart).length;
  function draw() {
    const list = rows.filter((r) => (!fStatus || r.draft.status === fStatus) && (!fChannel || r.draft.channel === fChannel) && (!fSource || r.source === fSource));
    const planned = list.filter((r) => r.draft.plannedDate).sort((a, b) => a.draft.plannedDate.localeCompare(b.draft.plannedDate));
    const unplanned = list.filter((r) => !r.draft.plannedDate);
    const routineInbox = items.filter((i) => i.origin === 'routine' && i.status === 'Briefing');
    const sources = [...new Set(rows.map((r) => r.source))];
    view.innerHTML = `<h1>Calendar</h1>
      <p class="lede">Your week at a glance: ideas, drafts, approvals, and Buffer-queued posts.</p>
      <div class="card"><div class="draft-controls" style="margin-top:0">
        <label>Status <select id="c-status"><option value="">All</option>${['suggested', 'edited', 'approved', 'scheduled'].map((s) => `<option value="${s}" ${fStatus === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label>Channel <select id="c-channel"><option value="">All</option>${meta.draftChannels.map((c) => `<option value="${c.id}" ${fChannel === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
        <label>Source <select id="c-source"><option value="">All</option>${sources.map((s) => `<option ${fSource === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      </div></div>
      <div class="card"><h2 style="margin-top:0">This week</h2>
        <p>Your target is <strong>${p.cadenceTarget}</strong> post${p.cadenceTarget === 1 ? '' : 's'} per week — <strong>${doneThisWeek}</strong> approved or scheduled so far. Change the target in <a href="#/settings">Settings</a>.</p>
      </div>
      <h2>Planned</h2>
      ${planned.length ? planned.map((r) => calRow(r)).join('') : '<div class="card empty"><p>Nothing planned yet — set a planned date on any draft.</p></div>'}
      <h2>Unplanned</h2>
      ${unplanned.length ? unplanned.map((r) => calRow(r)).join('') : '<div class="card empty"><p>Everything is planned. Nice.</p></div>'}
      <h2>Routine inbox</h2>
      ${routineInbox.length ? routineInbox.map((i) => itemCard(i)).join('') : '<div class="card empty"><p>No unreviewed routine suggestions. Run your <a href="#/routine">routine</a> to fill this.</p></div>'}`;
    document.getElementById('c-status').addEventListener('change', (e) => { fStatus = e.target.value; draw(); });
    document.getElementById('c-channel').addEventListener('change', (e) => { fChannel = e.target.value; draw(); });
    document.getElementById('c-source').addEventListener('change', (e) => { fSource = e.target.value; draw(); });
    view.querySelectorAll('[data-planned]').forEach((input) => input.addEventListener('change', async () => {
      try {
        await api(`/api/drafts/${input.dataset.planned}`, { method: 'PATCH', body: { plannedDate: input.value || null } });
        toast('Rescheduled.', 'success');
        viewCalendar();
      } catch (err) { toast(err.message, 'error'); }
    }));
  }
  function calRow(r) {
    return `<div class="card tight"><div class="draft-head">
        <strong>${esc(meta.draftChannels.find((c) => c.id === r.draft.channel)?.label || r.draft.channel)}</strong>
        <span class="badge status-${r.draft.status}">${esc(r.draft.status)}</span>
        ${r.item.demo ? '<span class="badge mock">DEMO</span>' : ''}</div>
      <p class="draft-meta"><a href="#/story/${esc(r.item.id)}">${esc(r.title.slice(0, 90))}</a> · ${esc(r.topic)} · ${esc(r.source)}</p>
      <label class="draft-meta">Planned date <input type="date" data-planned="${r.draft.id}" value="${esc(r.draft.plannedDate || '')}"></label>
    </div>`;
  }
  draw();
}

// --- Routine -------------------------------------------------------------------
async function viewRoutine() {
  const p = await prefs();
  const routine = await api('/api/routine');
  let running = false;
  let runMsg = null;
  let runErr = null;
  function draw() {
    const cadenceWord = routine.cadence === 'daily' ? 'every day' : 'every week';
    view.innerHTML = `<h1>Content routine</h1>
      <p class="lede">Have story-and-draft suggestions delivered to your Inbox. A routine never schedules or publishes — it only suggests.</p>
      ${{ vercel: '<div class="notice-inner" style="margin-bottom:1rem"><strong>Runs automatically:</strong> this deployment briefs you ${cadenceWord} after your delivery slot — no setup needed. “Run routine now” still works any time. The routine only suggests; it never schedules or publishes.</div>', local: '<div class="notice-inner" style="margin-bottom:1rem"><strong>Runs automatically while the server is on:</strong> leave Posty running and your briefing lands after your delivery slot. “Run routine now” works any time. The routine only suggests; it never schedules or publishes.</div>', external: '<div class="notice-inner" style="margin-bottom:1rem"><strong>External scheduler mode:</strong> the routine hook is locked with CRON_SECRET, so automatic runs come from your own scheduler (see HOSTING.md). “Run routine now” still works any time.</div>', off: '<div class="notice-inner" style="margin-bottom:1rem"><strong>On-demand:</strong> automatic runs are disabled on this server (POSTY_NO_SCHEDULER). “Run routine now” still works any time.</div>' }[routine.scheduler || 'off']}
      <form id="routine-form" class="card">
        ${chipRow('r-int-chips', 'Use these interests', p.interests, new Set(routine.interests))}
        <div class="grid-2">
          <label class="field"><span class="label">Cadence</span><select id="r-cadence"><option value="weekly" ${routine.cadence !== 'daily' ? 'selected' : ''}>Weekly</option><option value="daily" ${routine.cadence === 'daily' ? 'selected' : ''}>Daily</option></select></label>
          <div class="field">${chipRow('r-day-chips', 'Delivery days', meta.weekdays, new Set(routine.deliveryDays))}<p class="hint">Weekly: a briefing after each selected day's slot. Daily: every day.</p></div>
          <label class="field"><span class="label">Delivery time</span><input type="text" id="r-time" value="${esc(routine.deliveryTime || '09:00')}" aria-label="Delivery time HH:MM"></label>
          <label class="field"><span class="label">Batch size (stories per run)</span><select id="r-batch">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${routine.batchSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        </div>
        ${chipRow('r-ch-chips', 'Draft suggestions for', meta.draftChannels.map((c) => c.label), new Set(meta.draftChannels.filter((c) => routine.channels.includes(c.id)).map((c) => c.label)))}
        <label class="field" style="display:flex;gap:0.6rem;align-items:center"><input type="checkbox" id="r-paused" ${routine.paused ? 'checked' : ''}> <span>Pause this routine</span></label>
        <div class="btn-row"><button class="btn secondary" type="submit">Save routine</button></div>
      </form>
      <div class="card">
        <h2 style="margin-top:0">Run status</h2>
        ${routine.lastRunAt ? `<p>Last run: ${esc(fmtDate(routine.lastRunAt))} (${esc(ago(routine.lastRunAt))}) · added ${routine.lastResult?.added ?? 0} · ${routine.runs} total run${routine.runs === 1 ? '' : 's'}.</p>` : '<p>No runs yet.</p>'}
        ${routine.paused ? '<p><span class="badge">Paused</span></p>' : ''}
        ${runMsg ? `<p role="status">${esc(runMsg)}</p>` : ''}
        ${runErr ? `<div class="error-box" role="alert"><h3>Run failed</h3><p>${esc(runErr)}</p></div>` : ''}
        <div class="btn-row"><button class="btn" id="run-btn" ${running ? 'disabled' : ''}>${running ? 'Running…' : 'Run routine now'}</button></div>
      </div>`;
    const rInterests = new Set(routine.interests);
    bindChips(view, 'r-int-chips', rInterests);
    const rDays = new Set(routine.deliveryDays);
    bindChips(view, 'r-day-chips', rDays);
    const rChannels = new Set(routine.channels);
    view.querySelectorAll('#r-ch-chips [data-v]').forEach((b) => b.addEventListener('click', () => {
      const id = meta.draftChannels.find((c) => c.label === b.dataset.v)?.id;
      if (!id) return;
      rChannels.has(id) ? rChannels.delete(id) : rChannels.add(id);
      b.setAttribute('aria-pressed', rChannels.has(id));
    }));
    document.getElementById('routine-form').addEventListener('submit', async (e) => {
      if (!rDays.size) { e.preventDefault(); return toast('Pick at least one delivery day.', 'error'); }
      e.preventDefault();
      try {
        const data = await api('/api/routine', { method: 'PUT', body: { interests: [...rInterests], cadence: document.getElementById('r-cadence').value, deliveryDays: [...rDays], deliveryTime: document.getElementById('r-time').value, batchSize: Number(document.getElementById('r-batch').value), paused: document.getElementById('r-paused').checked, channels: [...rChannels] } });
        Object.assign(routine, data);
        draw();
        toast('Routine saved.', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
    document.getElementById('run-btn').addEventListener('click', async () => {
      running = true;
      runMsg = null;
      runErr = null;
      draw();
      try {
        const data = await api('/api/routine/run', { method: 'POST' });
        Object.assign(routine, data.routine);
        runMsg = `Added ${data.items.length} stor${data.items.length === 1 ? 'y' : 'ies'} with initial draft suggestions to your briefing.${data.warnings?.length ? ` Note: ${data.warnings.map((w) => w.message).join(' / ')}` : ''}`;
      } catch (err) { runErr = err.message; }
      running = false;
      draw();
    });
  }
  draw();
}

// --- Sources -------------------------------------------------------------------
async function viewSources() {
  const p = await prefs();
  const { sources } = await api('/api/sources');
  const statusBadgeFor = (s) => {
    const map = { live: 'real', 'built-in': 'provider', connected: 'real', paused: 'mock', unavailable: '', unconfigured: 'mock', disconnected: 'mock' };
    return `<span class="badge ${map[s.status] || ''}">${esc(s.status)}</span>`;
  };
  view.innerHTML = `<h1>Sources &amp; integrations</h1>
    <p class="lede">Everything Posty can read from — and exactly what each source provides. Nothing is ingested silently.</p>
    ${sources.map((s) => `<div class="card" data-source="${esc(s.id)}">
      <div class="draft-head"><h3>${esc(s.name)}</h3>${statusBadgeFor(s)}<span class="badge">${esc(s.kind)}</span></div>
      <p class="draft-meta">${esc(s.reads)}</p>
      <p class="draft-meta">${esc(s.note || '')}</p>
      <div class="btn-row" data-actions></div>
    </div>`).join('')}
    <div class="card"><h2 style="margin-top:0">Guided demo</h2>
      <p>Explore the full flow with clearly labeled sample content (DEMO badges, example links).</p>
      <div class="btn-row"><button class="btn secondary" id="demo-seed">Load demo workspace</button><button class="btn ghost" id="demo-clear">Clear demo content</button></div>
    </div>`;

  const off = new Set(p.disabledProviders);
  view.querySelectorAll('[data-source]').forEach((card) => {
    const id = card.dataset.source;
    const row = card.querySelector('[data-actions]');
    const s = sources.find((x) => x.id === id);
    if (['hn', 'gdelt', 'reddit'].includes(id)) {
      row.innerHTML = `<button class="btn small secondary">${off.has(id) ? 'Enable' : 'Pause'}</button>`;
      row.querySelector('button').addEventListener('click', async () => {
        off.has(id) ? off.delete(id) : off.add(id);
        prefsCache = await api('/api/preferences', { method: 'PUT', body: { disabledProviders: [...off] } });
        toast(off.has(id) ? 'Source paused — discovery will skip it.' : 'Source enabled.', 'success');
        viewSources();
      });
    } else if (['notes', 'calendar', 'code', 'reading'].includes(id)) {
      row.innerHTML = `<button class="btn small secondary" data-demo>Load labeled demo</button><button class="btn small ghost" data-clear>Clear demo</button>`;
      row.querySelector('[data-demo]').addEventListener('click', async () => {
        await api(`/api/sources/${id}/demo`, { method: 'POST' });
        toast('Labeled demo content added to Ideas.', 'success');
      });
      row.querySelector('[data-clear]').addEventListener('click', async () => {
        await api(`/api/sources/${id}/clear-demo`, { method: 'POST' });
        toast('Demo content for this source cleared.');
      });
    } else if (id === 'buffer') {
      if (s.status === 'connected') row.innerHTML = `<button class="btn small danger" data-dc>Disconnect Buffer</button>`;
      else if (s.status === 'disconnected') row.innerHTML = `<a class="btn small" href="/auth/buffer/start">Connect Buffer</a>`;
      else row.innerHTML = `<span class="draft-meta">Configure BUFFER_CLIENT_ID / BUFFER_CLIENT_SECRET / BUFFER_REDIRECT_URI on the server to enable.</span>`;
      row.querySelector('[data-dc]')?.addEventListener('click', async () => {
        await api('/api/auth/disconnect', { method: 'POST' });
        await refreshMe();
        viewSources();
      });
    }
  });
  document.getElementById('demo-seed').addEventListener('click', async () => {
    await api('/api/demo/seed', { method: 'POST' });
    toast('Demo workspace loaded — look for DEMO badges.', 'success');
  });
  document.getElementById('demo-clear').addEventListener('click', async () => {
    await api('/api/demo/clear', { method: 'POST' });
    toast('Demo content cleared.');
  });
}

// --- Style learning panel (Settings) ---------------------------------------------
async function drawLearnPanel() {
  const slot = document.getElementById('learn-panel');
  if (!slot) return;
  let data;
  try {
    data = await api('/api/learning');
  } catch (err) {
    slot.innerHTML = `<div class="card"><h2 style="margin-top:0">Style learning</h2><p class="missing">Couldn’t load learning state (${esc(err.message)}).</p></div>`;
    return;
  }
  const s = data.profile;
  slot.innerHTML = `<div class="card">
    <h2 style="margin-top:0">Style learning</h2>
    <p class="hint">When on, Posty notes only the <em>shape</em> of drafts you approve, schedule, skip, or delete — typical length, opening style, per-channel keep rates. No story facts or private text are stored, and drafts never claim experience you didn’t give.</p>
    <label class="field" style="display:flex;gap:0.6rem;align-items:center"><input type="checkbox" id="learn-toggle" ${data.enabled ? 'checked' : ''}> <span>Learn from my approvals and skips</span></label>
    <p class="draft-meta">Signal: ${s.kept} kept · ${s.counts.skipped} skipped · ${s.counts.deleted} deleted.${s.ready ? ` Personalizing new drafts (near ${s.preferredChars} chars).` : ` ${s.needed} more kept draft${s.needed === 1 ? '' : 's'} before personalizing.`}</p>
    ${s.topOpeners.length ? `<p class="draft-meta">Frequent approved openings: ${s.topOpeners.map((o) => `“${esc(o.opener)}…”`).join(', ')}</p>` : ''}
    <div class="btn-row"><button class="btn small ghost" id="learn-clear">Clear learning</button></div>
  </div>`;
  slot.querySelector('#learn-toggle').addEventListener('change', async (e) => {
    try {
      prefsCache = await api('/api/preferences', { method: 'PUT', body: { learnFromUse: e.target.checked } });
      toast(e.target.checked ? 'Style learning on — future drafts tune to your approvals.' : 'Style learning off — nothing new is recorded.', 'success');
      drawLearnPanel();
    } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
  });
  slot.querySelector('#learn-clear').addEventListener('click', async () => {
    try {
      await api('/api/learning', { method: 'DELETE' });
      toast('Learning cleared.');
      drawLearnPanel();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// --- Settings ------------------------------------------------------------------
async function viewSettings() {
  const p = await prefs();
  view.innerHTML = `<h1>Settings</h1>
    <p class="lede">Everything about how Posty works for you. Changes apply to new searches and drafts immediately.</p>
    <div id="prefs-editor"></div>
    <div class="card">
      <h2 style="margin-top:0">Buffer connection</h2>
      ${me.connected
        ? `<p>Connected${me.organization ? ` to <strong>${esc(me.organization.name)}</strong>` : ''}. Scheduling calls the real Buffer API.</p><div class="btn-row"><button class="btn danger" id="prefs-disconnect">Disconnect Buffer</button></div>`
        : me.oauthConfigured
          ? '<p>Not connected. Connect to enable real scheduling.</p><div class="btn-row"><a class="btn" href="/auth/buffer/start">Connect Buffer</a></div>'
          : '<p><span class="badge mock">Demo scheduling mode</span> Buffer is not connected here yet, so scheduling is simulated.</p>'}
    </div>`;
  await viewSetup(p, document.getElementById('prefs-editor'), { heading: '', submitLabel: 'Save settings', stay: true });
  view.insertAdjacentHTML('beforeend', '<div id="learn-panel"></div>');
  drawLearnPanel();
  document.getElementById('prefs-disconnect')?.addEventListener('click', async () => {
    await api('/api/auth/disconnect', { method: 'POST' });
    await refreshMe();
    route();
  });
}

function viewConnectError(params) {
  view.innerHTML = `<div class="error-box" role="alert"><h3>Buffer connection didn’t complete</h3><p>${esc(params.get('message') || 'Authorization failed.')}</p>
    <div class="btn-row"><a class="btn" href="#/today">Back to Today</a>${me?.oauthConfigured ? '<a class="btn secondary" href="/auth/buffer/start">Try again</a>' : ''}</div></div>`;
}

// --- Ask Posty -----------------------------------------------------------------
// Ad-hoc internet questions: type or speak, get article briefs with links,
// open any result to add your take and refine drafts. History persists via
// inbox items (origin 'ask'), newest exchanges at the bottom, chat-style.
async function viewAsk() {
  const data = await api('/api/inbox');
  let groups = [];
  const asked = data.items
    .filter((i) => i.origin === 'ask' && !i.dismissed)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  for (const i of asked) {
    const key = `${i.query || ''} ${(i.createdAt || '').slice(0, 16)}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(i);
    else groups.push({ key, query: i.query || '(question)', via: i.via || 'text', items: [i], at: i.createdAt });
  }
  groups = groups.slice(-12);
  let busy = '';
  let askError = '';
  let lastMeta = null; // {warnings, webSearch} — shown for the freshest ask only
  let rec = null;

  function exchangeHtml(g, fresh) {
    return `<section class="ask-block" aria-label="Question and results">
      <p class="ask-q"><span class="ask-who">You asked</span>${esc(g.query)}${g.via === 'voice' ? ' <span class="badge">Voice</span>' : ''}</p>
      ${g.items.length ? g.items.map((i) => itemCard(i)).join('') : '<p class="missing">No fresh results — try rephrasing the question.</p>'}
      ${fresh && lastMeta ? `<p class="draft-meta">Searched ${lastMeta.webSearch ? 'the web (Exa) plus built-in sources' : 'built-in sources (add an Exa key for general web search)'}.${lastMeta.warnings.map((w) => ` Note: ${esc(w.provider)} — ${esc(w.message)}.`).join('')}</p>` : ''}
      <p class="draft-meta">Open a result to read the summary, add your take, and refine drafts.</p>
    </section>`;
  }
  function draw() {
    view.innerHTML = `<h1>Ask Posty</h1>
      <p class="lede">Question about a development, trend, or topic? Ask in your own words — Posty searches the internet and returns article briefs with links.</p>
      <div id="ask-thread">
        ${groups.length ? groups.map((g, n) => exchangeHtml(g, n === groups.length - 1)).join('') : `<div class="card empty"><p>No questions yet — try one below.</p></div>`}
        ${busy ? `<div class="card"><p class="loading"><span class="spinner" aria-hidden="true"></span>${esc(busy)}</p></div>` : ''}
        ${askError ? `<div class="error-box" role="alert"><h3>Search didn’t complete</h3><p>${esc(askError)}</p></div>` : ''}
      </div>
      <div class="ask-composer">
        <div class="ask-suggest">
          <span class="draft-meta">Try:</span>
          ${['What is new in small language models?', 'How are teams using AI code review?', 'Latest thinking on four-day work weeks'].map((s) => `<button type="button" class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}
        </div>
        <div class="ask-row">
          <input type="text" id="ask-input" maxlength="300" placeholder="Ask about any topic…" aria-label="Ask Posty">
          <button class="btn" id="ask-send" ${busy ? 'disabled' : ''}>Ask</button>
          <button class="btn secondary" id="ask-mic" ${busy ? 'disabled' : ''} title="Ask by voice">${rec ? 'Stop' : 'Mic'}</button>
        </div>
        <p class="draft-meta" id="ask-status" role="status"></p>
      </div>`;
    view.querySelectorAll('[data-suggest]').forEach((b) => b.addEventListener('click', () => {
      document.getElementById('ask-input').value = b.dataset.suggest;
      document.getElementById('ask-input').focus();
    }));
    document.getElementById('ask-send').addEventListener('click', submitText);
    document.getElementById('ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitText(); });
    document.getElementById('ask-mic').addEventListener('click', toggleVoice);
    window.scrollTo(0, document.body.scrollHeight);
  }
  async function submitText() {
    const input = document.getElementById('ask-input');
    const query = input.value.trim();
    if (!query || busy) return;
    busy = 'Searching the internet…';
    askError = '';
    draw();
    try {
      const res = await api('/api/ask', { method: 'POST', body: { query }, timeoutMs: 180000 });
      groups.push({ key: `${res.query} ${new Date().toISOString().slice(0, 16)}`, query: res.query, via: 'text', items: res.items, at: new Date().toISOString() });
      groups = groups.slice(-12);
      lastMeta = { warnings: res.warnings || [], webSearch: res.webSearch };
    } catch (err) {
      askError = err.message;
    }
    busy = '';
    draw();
  }
  function stopRec() {
    if (!rec) return;
    clearInterval(rec.timer);
    try { rec.proc.disconnect(); } catch { /* stopped */ }
    try { rec.stream.getTracks().forEach((t) => t.stop()); } catch { /* stopped */ }
    rec.ctx.close().catch(() => {});
    rec = null;
  }
  async function toggleVoice() {
    if (busy && !rec) return;
    if (rec) {
      const { chunks, rate } = rec;
      stopRec();
      const flat = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of chunks) { flat.set(c, o); o += c.length; }
      busy = 'Transcribing your question…';
      draw();
      let transcript = '';
      try {
        const res2 = await fetch('/api/ask/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encodeWav(flat, rate), signal: AbortSignal.timeout(150000) });
        const t = await res2.json().catch(() => ({}));
        if (!res2.ok) throw new Error(t.error || `Transcription failed (${res2.status})`);
        transcript = t.transcript;
      } catch (err) {
        askError = err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? 'Transcription took too long — try a shorter question.'
          : err.message;
        busy = '';
        draw();
        return;
      }
      busy = 'Searching the internet…';
      askError = '';
      draw();
      try {
        const res = await api('/api/ask', { method: 'POST', body: { query: transcript }, timeoutMs: 180000 });
        groups.push({ key: `${res.query} ${new Date().toISOString().slice(0, 16)}`, query: res.query, via: 'voice', items: res.items, at: new Date().toISOString() });
        groups = groups.slice(-12);
        lastMeta = { warnings: res.warnings || [], webSearch: res.webSearch };
      } catch (err) {
        askError = err.message;
      }
      busy = '';
      draw();
      const heard = document.getElementById('ask-input');
      if (heard && transcript) heard.value = transcript; // heard words stay editable for re-ask
      return;
    }
    if (me.voiceReady === false) { askError = 'Voice is not available right now — typing works regardless.'; draw(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { askError = 'This browser does not expose a microphone here — type instead.'; draw(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      ctx.createMediaStreamSource(stream).connect(proc);
      proc.connect(ctx.destination);
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        const st = document.getElementById('ask-status');
        if (st) st.textContent = `Recording… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} (max 2:00)`;
        if (s >= 120) toggleVoice();
      }, 500);
      rec = { ctx, stream, proc, chunks, rate: ctx.sampleRate, timer };
      draw();
    } catch (err) {
      askError = err?.name === 'NotAllowedError' ? 'Microphone denied — allow it or type instead.' : `Could not record (${err.message}).`;
      draw();
    }
  }
  draw();
}

// --- router ------------------------------------------------------------------
async function route() {
  renderChrome();
  const raw = location.hash.slice(2) || 'today';
  const [pathPart, queryPart] = raw.split('?');
  const params = new URLSearchParams(queryPart || '');
  const [name, arg] = pathPart.split('/');
  try {
    if (name === 'inbox') { location.hash = '#/today'; return; }
    if (name === 'preferences') { location.hash = '#/settings'; return; }
    if (!me.setupDone && name !== 'setup' && name !== 'settings' && name !== 'connect-error') {
      location.hash = '#/setup';
      return;
    }
    if (name === 'setup') {
      await viewSetup(await prefs());
    } else if (name === 'today') {
      await viewToday(params);
    } else if (name === 'ask') {
      await viewAsk();
    } else if (name === 'ideas') {
      await viewIdeas();
    } else if (name === 'drafts') {
      await viewDrafts();
    } else if (name === 'calendar') {
      await viewCalendar();
    } else if (name === 'story' && arg) {
      await viewStory(arg);
    } else if (name === 'routine') {
      await viewRoutine();
    } else if (name === 'sources') {
      await viewSources();
    } else if (name === 'settings') {
      await viewSettings();
    } else if (name === 'connect-error') {
      viewConnectError(params);
    } else {
      location.hash = '#/today';
      return;
    }
    renderChrome();
    document.getElementById('view').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (err) {
    view.innerHTML = `<div class="error-box" role="alert"><h3>Something went wrong</h3><p>${esc(err.message)}</p><div class="btn-row"><a class="btn secondary" href="#/today">Back to Today</a></div></div>`;
  }
}

window.addEventListener('hashchange', route);

// Capture editing (e.g. fixing mistranscribed voice notes), wired once for
// every view that renders item cards.
document.addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-del-item]');
  if (delBtn) {
    const id = delBtn.dataset.delItem;
    const card = delBtn.closest('[data-item]');
    const title = card?.querySelector('.story-title')?.textContent?.trim() || 'this idea';
    const close = openModal(`<h2>Delete this idea?</h2>
      <p><strong>${esc(title.slice(0, 120))}</strong></p>
      <p class="draft-meta">This permanently removes the idea, its perspective, and its drafts. Ideas with a draft queued in Buffer can’t be deleted.</p>
      <div class="btn-row"><button class="btn ghost" data-x>Keep it</button><button class="btn danger" data-confirm-del>Delete idea</button></div>`);
    modalRoot.querySelector('[data-x]').addEventListener('click', close);
    modalRoot.querySelector('[data-confirm-del]').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        await api(`/api/inbox/${id}`, { method: 'DELETE' });
        close();
        toast('Idea deleted.');
        route();
      } catch (err) {
        close();
        toast(err.message, 'error');
      }
    });
    return;
  }
  const editBtn = e.target.closest('[data-cap-edit]');
  const saveBtn = e.target.closest('[data-cap-save]');
  const cancelBtn = e.target.closest('[data-cap-cancel]');
  if (!editBtn && !saveBtn && !cancelBtn) return;
  const btn = editBtn || saveBtn || cancelBtn;
  const id = btn.dataset.capEdit || btn.dataset.capSave || btn.dataset.capCancel;
  const editor = document.querySelector(`[data-cap-editor="${id}"]`);
  if (!editor) return;
  if (editBtn || cancelBtn) {
    const opening = editor.hidden && !cancelBtn;
    editor.hidden = !opening;
    if (editBtn) editBtn.textContent = opening ? 'Close' : 'Edit';
    return;
  }
  saveBtn.disabled = true;
  try {
    await api(`/api/inbox/${id}`, {
      method: 'PATCH',
      body: {
        title: editor.querySelector('[data-cap-title]').value,
        text: editor.querySelector('[data-cap-text]').value,
      },
    });
    toast('Note updated.', 'success');
    route();
  } catch (err) {
    toast(err.message, 'error');
    saveBtn.disabled = false;
  }
});

document.getElementById('shortcuts-link')?.addEventListener('click', (e) => { e.preventDefault(); shortcutsModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (modalRoot.firstElementChild) return;
  e.preventDefault();
  shortcutsModal();
});

(async function boot() {
  try {
    meta = await api('/api/meta');
    await refreshMe();
  } catch (err) {
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    view.innerHTML = `<div class="error-box" role="alert"><h3>Posty server unreachable</h3><p>${esc(err.message)}</p><p>${isLocal ? 'Start the server with <code>npm start</code> and reload.' : 'If you own this deployment, check its configuration (storage, environment variables) and redeploy.'}</p></div>`;
    return;
  }
  if (!location.hash) location.hash = me.setupDone ? '#/today' : '#/setup';
  else await route();
})();

