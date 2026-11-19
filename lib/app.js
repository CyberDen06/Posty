import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readBytes, parseMultipart, sendJson, redirect, randId, sha256b64url, esc } from './util.js';
import { readDoc, writeDoc, writePending, readPending, deletePending, cacheGet, cacheSet } from './store.js';
import { getSession, saveSession, publicSession } from './session.js';
import { PROFESSIONS, PERSPECTIVE_PROMPTS, CAPTURE_PROMPTS, QUICK_REACTIONS, TONES, LENGTHS, DRAFT_CHANNELS, PILLARS, defaultPreferences, normalizePreferences } from './professions.js';
import { searchStories, providerHealth } from './providers.js';
import { generateDraft, generateVariant, refineDraft, matchesNeverPost } from './drafts.js';
import { enrichStories, fetchExcerpt } from './summaries.js';
import { transcribeWav, voiceModel, voiceConfigured } from './voice.js';
import { llmChat, llmConfigured } from './llm.js';
import { flattenBrief, genericPrompts, takeQuestionMessages, parseQuestions } from './prompts.js';
import { exaConfigured } from './exa.js';
import { normalizeRoutine, coerceRoutine, makeDraft, pushHistory, runRoutine, WEEKDAYS } from './routine.js';
import { defaultProfile, recordOutcome, ready as learningReady, personalizeLines, preferredChars, summary as learningSummary } from './learn.js';
import { cronSecretOk, cronLocked, executeScheduledRun } from './cron.js';
import { stepsOf } from './onboard.js';
import { BufferError, isConfigured as bufferConfigured, authorizeUrl, connectAccount, ensureFreshToken, getOrganizations, getChannels, createPost, mockChannels, mockSchedule } from './buffer.js';

// Shared request handler: used by the local server (server.js) and the
// Vercel function (api/index.js). PUBLIC resolves from this file so static
// assets load both locally and from the serverless bundle.
const PUBLIC = path.dirname(fileURLToPath(new URL('../public/index.html', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };

// --- per-user docs -----------------------------------------------------------
async function prefsOf(sid) {
  return { ...defaultPreferences(), ...(await readDoc('user', sid, 'preferences', {})) };
}
async function inboxOf(sid) {
  return readDoc('user', sid, 'inbox', []);
}
async function routineOf(sid) {
  const r = coerceRoutine(await readDoc('user', sid, 'routine', null));
  // Single source of truth: the routine always searches the user's saved
  // interests (synced live — editing Settings needs no routine re-save).
  r.interests = [...(await prefsOf(sid)).interests];
  return r;
}
const styleSamplesOf = (prefs) => (prefs.useStyleRefs ? prefs.styleSamples : []);

// Style learning (opt-in): one profile per workspace, recorded only when the
// user enabled it. Recording never breaks the action it observes.
// Where automatic runs come from, for the Routine view's honest label:
// 'external' (owner locked the hook with CRON_SECRET and runs their own
// scheduler), 'vercel' (vercel.json crons fire it), 'local' (server.js ticks
// while the server runs), or 'off' (POSTY_NO_SCHEDULER=1).
function schedulerStatus() {
  if (process.env.CRON_SECRET) return 'external';
  if (process.env.VERCEL) return 'vercel';
  if (process.env.POSTY_NO_SCHEDULER) return 'off';
  return 'local';
}
async function learningOf(sid) {
  return { ...defaultProfile(), ...((await readDoc('user', sid, 'learning', null)) || {}) };
}
function learningInput(profile, prefs) {
  if (!prefs.learnFromUse || !learningReady(profile)) return null;
  return { lines: personalizeLines(profile), targetChars: preferredChars(profile) };
}
async function noteOutcome(sid, prefs, draft, outcome) {
  if (!prefs.learnFromUse) return;
  try {
    const profile = await learningOf(sid);
    recordOutcome(profile, { outcome, generatedText: draft.generatedText || draft.history?.[0]?.text || draft.text, finalText: draft.text, channel: draft.channel });
    await writeDoc('user', sid, 'learning', profile);
  } catch (e) {
    console.log(`[posty] learning record skipped (${e.message})`);
  }
}

// Item status is DERIVED, never stored: nothing reaches Approved/Queued except
// through the draft approve/schedule actions.
function statusOf(item) {
  const drafts = item.drafts || [];
  if (drafts.some((d) => d.status === 'scheduled')) return 'Queued';
  if (drafts.some((d) => d.status === 'approved')) return 'Approved';
  if (drafts.length) return 'Draft ready';
  if (item.perspective?.text || item.perspective?.reaction) return 'Perspective added';
  if (item.kind === 'capture') return 'Captured';
  if (item.saved) return 'Selected';
  return 'Briefing';
}

function withStatus(item) {
  return { ...item, kind: item.kind || (item.story ? 'story' : 'capture'), status: statusOf(item) };
}

async function findDraft(sid, draftId) {
  for (const item of await inboxOf(sid)) {
    const d = (item.drafts || []).find((x) => x.id === draftId);
    if (d) return { item, draft: d };
  }
  return {};
}

async function saveInboxItem(sid, item) {
  const inbox = await inboxOf(sid);
  const i = inbox.findIndex((x) => x.id === item.id);
  if (i >= 0) inbox[i] = item;
  else inbox.unshift(item);
  await writeDoc('user', sid, 'inbox', inbox.slice(0, 150)); // bounded store
}

function storyLikeFor(item) {
  if (item.story) return item.story;
  const c = item.capture || {};
  return {
    title: c.title || 'Untitled capture',
    url: c.url || '',
    date: item.createdAt,
    source: 'Your capture',
    summary: c.text || c.notes || null,
    summaryLabel: 'Your note',
    matchedInterest: '',
    provider: 'capture',
  };
}

const scheduleInflight = new Map(); // draftId -> promise (no double-scheduling)

// --- static ------------------------------------------------------------------
function serveStatic(req, res, pathname) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return true;
  }
  let file = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.normalize(path.join(PUBLIC, file));
  if (!resolved.startsWith(PUBLIC) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return false;
  const body = fs.readFileSync(resolved);
  res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] || 'application/octet-stream', 'content-length': body.length });
  res.end(body);
  return true;
}

// --- demo content (always flagged demo:true, example.com links) ---------------
function demoSeedItems() {
  const now = new Date().toISOString();
  return [
    {
      id: `s_${randId(8)}`, kind: 'story', origin: 'demo', demo: true, saved: false, dismissed: false, createdAt: now,
      perspective: { text: '', reaction: '' }, drafts: [],
      story: {
        title: 'Demo: Small teams ship faster with written decisions', url: 'https://example.com/demo/decisions',
        date: now, source: 'Demo source', summary: 'A sample story showing how Posty presents headlines, sources, and why-lines. Replace with live discovery.', summaryLabel: 'Demo text',
        provider: 'demo', canonical: 'https://example.com/demo/decisions', matchedInterest: 'engineering teams', why: 'Demo content — shows the briefing card layout.',
      },
    },
    {
      id: `s_${randId(8)}`, kind: 'capture', origin: 'demo', demo: true, saved: true, dismissed: false, createdAt: now,
      perspective: { text: '', reaction: '' }, drafts: [],
      capture: { type: 'note', title: 'Demo: standup insight', text: 'Sample note: deploys got calmer after we added a five-minute pre-merge checklist.', url: '', notes: '' },
    },
  ];
}

// --- routes ------------------------------------------------------------------
async function route(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  // -- CORS: the desktop overlay (Tauri webview origin) POSTs here
  // cross-origin, so browsers send an OPTIONS preflight first. Answer it and
  // label API responses; the same-origin web UI is unaffected.
  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
    res.setHeader('access-control-allow-origin', req.headers.origin || '*');
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '600');
  }
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  const session = await getSession(req, res);
  const sid = session.sid;
  const oauthConfigured = bufferConfigured();

  // -- OAuth -----------------------------------------------------------------
  if (method === 'GET' && pathname === '/auth/buffer/start') {
    if (!oauthConfigured) return sendJson(res, 400, { error: 'Buffer OAuth is not configured on this server (mock scheduling mode).' });
    const state = randId(18);
    const verifier = randId(48);
    await writePending(state, { verifier, sid });
    return redirect(res, authorizeUrl({ state, challenge: sha256b64url(verifier) }));
  }
  if (method === 'GET' && pathname === '/auth/buffer/callback') {
    const err = url.searchParams.get('error');
    if (err) return redirect(res, `/#/connect-error?message=${encodeURIComponent(`Buffer authorization ${err.replace(/_/g, ' ')}`)}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const pending = state && (await readPending(state));
    if (!code || !pending || pending.sid !== sid) {
      return redirect(res, `/#/connect-error?message=${encodeURIComponent('Authorization session expired or mismatched. Please try connecting again.')}`);
    }
    await deletePending(state);
    try {
      // Save-first connect: tokens persist inside the callback (immediately, then
      // with the org); the extra save after is belt-and-braces for the redirect.
      session.buffer = await connectAccount({ code, verifier: pending.verifier }, async (next) => {
        session.buffer = next;
        await saveSession(session);
      });
      await saveSession(session);
      return redirect(res, '/#/today?connected=1');
    } catch (e) {
      const msg = e instanceof BufferError ? e.message : 'Buffer authorization failed unexpectedly';
      return redirect(res, `/#/connect-error?message=${encodeURIComponent(msg)}`);
    }
  }
  if (method === 'POST' && pathname === '/api/auth/disconnect') {
    session.buffer = null;
    await saveSession(session);
    return sendJson(res, 200, { ok: true });
  }

  // -- meta / me ---------------------------------------------------------------
  if (method === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (method === 'GET' && pathname === '/api/meta') {
    return sendJson(res, 200, {
      professions: PROFESSIONS, prompts: PERSPECTIVE_PROMPTS, capturePrompts: CAPTURE_PROMPTS,
      reactions: QUICK_REACTIONS, tones: TONES, lengths: LENGTHS, draftChannels: DRAFT_CHANNELS,
      pillars: PILLARS, weekdays: WEEKDAYS,
    });
  }
  if (method === 'GET' && pathname === '/api/me') {
    return sendJson(res, 200, { ...publicSession(session, oauthConfigured), setupDone: (await prefsOf(sid)).setupDone, mockMode: !oauthConfigured, voiceReady: voiceConfigured() });
  }

  // -- preferences -------------------------------------------------------------
  if (pathname === '/api/preferences' && (method === 'GET' || method === 'PUT')) {
    if (method === 'GET') return sendJson(res, 200, await prefsOf(sid));
    const prefs = normalizePreferences({ ...(await prefsOf(sid)), ...(await readJson(req)) });
    await writeDoc('user', sid, 'preferences', prefs);
    return sendJson(res, 200, prefs);
  }

  // -- story discovery: summaries + an initial draft per preferred channel -----
  if (method === 'POST' && pathname === '/api/stories/find') {
    const body = await readJson(req).catch(() => ({}));
    const prefs = await prefsOf(sid);
    const interests = Array.isArray(body.interests) && body.interests.length ? body.interests : prefs.interests;
    const exclude = (await inboxOf(sid)).map((i) => i.story?.canonical || i.story?.url).filter(Boolean);
    const timings = {};
    let t0 = Date.now();
    const { stories, warnings, totalFresh } = await searchStories({
      interests, profession: prefs.profession, excludeUrls: exclude, maxTotal: 2, disabledProviders: prefs.disabledProviders,
    });
    timings.providers = Date.now() - t0;
    t0 = Date.now();
    await enrichStories(stories);
    timings.enrich = Date.now() - t0;
    // Lazy drafts: stories land with summaries immediately; drafts generate
    // when the user opens the story (quota is spent only on opened stories).
    const items = [];
    let filtered = 0;
    for (const story of stories) {
      const blocked = matchesNeverPost(`${story.title} ${story.summary || ''}`, prefs.neverPost);
      if (blocked) {
        filtered++;
        continue;
      }
      const item = {
        id: `s_${randId(8)}`, kind: 'story', story, origin: 'search',
        perspective: { text: '', reaction: '' }, drafts: [], dismissed: false, saved: false, demo: false,
        createdAt: new Date().toISOString(),
      };
      await saveInboxItem(sid, item);
      items.push(withStatus(item));
    }
    timings.total = timings.providers + timings.enrich;
    console.log(`[posty] find: providers=${timings.providers}ms enrich=${timings.enrich}ms items=${items.length} filtered=${filtered}`);
    return sendJson(res, 200, { items, warnings, totalFresh, filtered, timings });
  }

  // -- ask Posty: ad-hoc internet query (text or transcribed voice) ------------
  // Same pipeline as Find (providers incl. Exa when keyed, enrich, never-post
  // filter), but driven by a free-text question instead of saved interests.
  // No seen-URL exclusion: each ask is an explicit fresh request.
  async function runAsk(query, maxTotal, via) {
    const prefs = await prefsOf(sid);
    const timings = {};
    let t0 = Date.now();
    const { stories, warnings, totalFresh } = await searchStories({
      interests: [query], profession: prefs.profession, excludeUrls: [], maxTotal: maxTotal + 2, disabledProviders: prefs.disabledProviders,
    });
    timings.providers = Date.now() - t0;
    t0 = Date.now();
    await enrichStories(stories, { focus: query });
    timings.enrich = Date.now() - t0;
    // Brief-first: Ask promises a readable summary per result, so stories that
    // actually have one win the final cut (sort is stable — ranking kept within).
    stories.sort((a, b) => Number(Boolean(b.summary)) - Number(Boolean(a.summary)));
    const cut = stories.slice(0, maxTotal);
    const items = [];
    let filtered = 0;
    for (const story of cut) {
      const blocked = matchesNeverPost(`${story.title} ${story.summary || ''}`, prefs.neverPost);
      if (blocked) {
        filtered++;
        continue;
      }
      const item = {
        id: `s_${randId(8)}`, kind: 'story', story, origin: 'ask', query, via,
        perspective: { text: '', reaction: '' }, drafts: [], dismissed: false, saved: false, demo: false,
        createdAt: new Date().toISOString(),
      };
      await saveInboxItem(sid, item);
      items.push(withStatus(item));
    }
    timings.total = timings.providers + timings.enrich;
    console.log(`[posty] ask via=${via} providers=${timings.providers}ms enrich=${timings.enrich}ms items=${items.length} filtered=${filtered}`);
    return { query, items, warnings, totalFresh, filtered, timings, webSearch: exaConfigured() && !prefs.disabledProviders.includes('exa') };
  }
  if (method === 'POST' && pathname === '/api/ask') {
    const body = await readJson(req).catch(() => ({}));
    const query = String(body.query || '').trim().slice(0, 300);
    if (!query) return sendJson(res, 400, { error: 'Ask about a topic, trend, or question.' });
    const maxTotal = Math.min(5, Math.max(1, Number(body.maxTotal) || 3));
    return sendJson(res, 200, await runAsk(query, maxTotal, 'text'));
  }
  // Transcribe-only: the client shows the transcript, then runs a normal
  // text ask as a second staged request — honest progress instead of one
  // "transcribing…" label covering search+enrich too.
  if (method === 'POST' && pathname === '/api/ask/transcribe') {
    const ct = String(req.headers['content-type'] || '');
    if (!/audio\/(wav|x-wav|wave)/i.test(ct)) {
      return sendJson(res, 400, { error: 'Ask-by-voice expects a WAV recording (content-type audio/wav).' });
    }
    const { transcript } = await transcribeWav(await readBytes(req));
    if (!transcript) return sendJson(res, 422, { error: 'No speech was detected in this recording.' });
    return sendJson(res, 200, { transcript: transcript.slice(0, 300) });
  }

  // -- desktop companion state (shared cache, NOT per-user: the overlay and
  // the browser are the same person on one machine but carry different
  // session ids, so a per-user doc would never bridge them).
  if (pathname === '/api/desktop/state' && (method === 'GET' || method === 'POST')) {
    if (method === 'GET') {
      const cached = await cacheGet('desktop:hotkeys', 30 * 24 * 3600 * 1000);
      return sendJson(res, 200, {
        hotkeys: cached || { dump: 'ctrl+shift+space', highlight: 'ctrl+shift+h' },
        live: Boolean(cached),
      });
    }
    const body = await readJson(req).catch(() => ({}));
    const clean = (v) => (typeof v === 'string' && v.trim() && v.trim().length <= 40 ? v.trim() : null);
    const dump = clean(body.dump);
    const highlight = clean(body.highlight);
    if (!dump || !highlight) return sendJson(res, 400, { error: 'Desktop state needs dump and highlight hotkeys.' });
    const shapeOk = (s) => /^[a-z0-9+]+$/i.test(s) && s.includes('+');
    if (!shapeOk(dump) || !shapeOk(highlight)) return sendJson(res, 400, { error: 'Hotkeys look invalid.' });
    await cacheSet('desktop:hotkeys', { dump, highlight });
    return sendJson(res, 200, { ok: true });
  }

  // -- inbox (unified stories + captures) ---------------------------------------
  if (method === 'GET' && pathname === '/api/inbox') {
    return sendJson(res, 200, { items: (await inboxOf(sid)).map(withStatus) });
  }
  const inboxMatch = pathname.match(/^\/api\/inbox\/([A-Za-z0-9_-]+)(\/(dismiss|save|perspective|drafts|prompts))?$/);
  if (inboxMatch) {
    const [, id, , action] = inboxMatch;
    const item = (await inboxOf(sid)).find((x) => x.id === id);
    if (!item) return sendJson(res, 404, { error: 'Item not found in your workspace.' });
    if (method === 'GET' && !action) return sendJson(res, 200, { item: withStatus(item) });
    // Edit a captured note (e.g. fix mistranscribed words). Stories are
    // immutable here — their text belongs to the source.
    if (method === 'PATCH' && !action) {
      const kind = item.kind || (item.story ? 'story' : 'capture');
      if (kind !== 'capture' || !item.capture) {
        return sendJson(res, 400, { error: 'Only captured notes can be edited here.' });
      }
      const body = await readJson(req);
      const c = item.capture;
      if (body.title !== undefined) c.title = String(body.title).slice(0, 220);
      if (body.text !== undefined) c.text = String(body.text).slice(0, 4000);
      if (body.notes !== undefined) c.notes = String(body.notes).slice(0, 2000);
      if (!c.title && !c.text) return sendJson(res, 400, { error: 'Keep a title or some text for your note.' });
      if (!c.title) c.title = 'Untitled note';
      item.updatedAt = new Date().toISOString();
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { item: withStatus(item) });
    }
    if (method === 'POST' && action === 'dismiss') {
      item.dismissed = true;
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { ok: true });
    }
    // Permanent delete (unlike dismiss, which only hides). Always allowed —
    // even with Buffer-queued drafts, which stay queued in Buffer (Posty
    // never unschedules behind the user's back). hadScheduled lets the UI
    // say so honestly.
    if (method === 'DELETE' && !action) {
      const hadScheduled = (item.drafts || []).some((d) => d.status === 'scheduled');
      await writeDoc('user', sid, 'inbox', (await inboxOf(sid)).filter((x) => x.id !== id));
      return sendJson(res, 200, { ok: true, hadScheduled });
    }
    if (method === 'POST' && action === 'save') {
      item.saved = true;
      item.dismissed = false;
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { item: withStatus(item) });
    }
    // Grounded take-questions: specific to this story/capture so answering
    // them yields a substantial perspective. LLM-backed with caching; falls
    // back to the generic lists when unconfigured or on any failure.
    if (method === 'GET' && action === 'prompts') {
      const isStory = (item.kind || (item.story ? 'story' : 'capture')) !== 'capture';
      const generic = genericPrompts(isStory);
      const like = storyLikeFor(item);
      const briefText = item.story && typeof item.story === 'object' ? flattenBrief(item.story.brief) : '';
      const title = like.title || 'Untitled';
      const body = [like.summary || '', briefText].filter(Boolean).join('\n');
      const key = `prompts:${id}:${sha256b64url(`${title}\n${body}`).slice(0, 12)}`;
      const cached = await cacheGet(key, 24 * 3600 * 1000);
      if (Array.isArray(cached) && cached.length >= 2) return sendJson(res, 200, { questions: cached, grounded: true });
      if (!llmConfigured()) return sendJson(res, 200, { questions: generic, grounded: false });
      try {
        const prefs = await prefsOf(sid);
        const text = await llmChat(
          takeQuestionMessages({
            title,
            body,
            source: like.source || '',
            profession: prefs.profession || '',
            interest: like.matchedInterest || '',
            isStory,
          }),
          { maxTokens: 4000, temperature: 0.5, purpose: 'prompts' }
        );
        const questions = parseQuestions(text);
        if (questions.length < 2) throw new Error('unparseable prompt response');
        await cacheSet(key, questions);
        return sendJson(res, 200, { questions, grounded: true });
      } catch (e) {
        console.log(`[posty] take-prompts fallback (${e.message})`);
        return sendJson(res, 200, { questions: generic, grounded: false });
      }
    }
    if (method === 'POST' && action === 'perspective') {
      const body = await readJson(req);
      item.perspective = { text: String(body.text || '').slice(0, 2000), reaction: String(body.reaction || '').slice(0, 60) };
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { item: withStatus(item) });
    }
    if (method === 'POST' && action === 'drafts') {
      const body = await readJson(req);
      const prefs = await prefsOf(sid);
      const storyLike = storyLikeFor(item);
      const blocked = matchesNeverPost(`${storyLike.title} ${storyLike.summary || ''} ${item.perspective.text}`, prefs.neverPost);
      if (blocked) return sendJson(res, 400, { error: `This matches your never-post topic “${blocked}”. Remove the topic in Settings to draft anyway.` });
      const want = [...new Set((body.channels || prefs.preferredChannels).filter((c) => DRAFT_CHANNELS.some((d) => d.id === c)))].slice(0, 5);
      if (!want.length) return sendJson(res, 400, { error: 'Select at least one channel to draft for.' });
      const fresh = want.filter((channel) => !item.drafts.some((d) => d.channel === channel && d.status !== 'skipped'));
      item.drafts = item.drafts.filter((d) => !(fresh.includes(d.channel) && d.status === 'skipped'));
      const createLearning = learningInput(await learningOf(sid), prefs);
      const made = await Promise.all(fresh.map((channel) => makeDraft({
        story: storyLike, channel, tone: prefs.tone, length: prefs.length,
        matchedInterest: storyLike.matchedInterest || '', perspective: item.perspective,
        styleSamples: styleSamplesOf(prefs), pillar: body.pillar || prefs.pillars[0] || '', learning: createLearning,
      })));
      item.drafts.push(...made);
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { item: withStatus(item) });
    }
  }

  // -- voice transcribe-only: powers review-then-save flows (the overlay
  // shows the transcript for correction before anything is saved) --------
  if (method === 'POST' && pathname === '/api/voice/transcribe') {
    const ct = String(req.headers['content-type'] || '');
    if (!/audio\/(wav|x-wav|wave)/i.test(ct)) {
      return sendJson(res, 400, { error: 'Voice transcription expects a WAV recording (content-type audio/wav).' });
    }
    const { transcript } = await transcribeWav(await readBytes(req));
    if (!transcript) return sendJson(res, 422, { error: 'No speech was detected in this recording.' });
    return sendJson(res, 200, { transcript: transcript.slice(0, 4000) });
  }

  // -- voice capture: WAV body → transcript → saved idea with provenance ------
  if (method === 'POST' && pathname === '/api/captures/voice') {
    const ct = String(req.headers['content-type'] || '');
    if (!/audio\/(wav|x-wav|wave)/i.test(ct)) {
      return sendJson(res, 400, { error: 'Voice capture expects a WAV recording (content-type audio/wav).' });
    }
    const audio = await readBytes(req);
    const { transcript } = await transcribeWav(audio);
    const firstLine = transcript.split(/(?<=[.!?])\s+/)[0] || transcript;
    const item = {
      id: `s_${randId(8)}`, kind: 'capture', origin: 'capture',
      capture: {
        type: 'voice',
        title: (firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine) || 'Voice note',
        text: transcript.slice(0, 4000), url: '', notes: '',
        provenance: { engine: voiceModel(), mode: 'spoken brain dump', transcribedAt: new Date().toISOString() },
      },
      perspective: { text: '', reaction: '' }, drafts: [], dismissed: false, saved: true, demo: false,
      createdAt: new Date().toISOString(),
    };
    await saveInboxItem(sid, item);
    return sendJson(res, 200, { item: withStatus(item) });
  }

  // -- PWA share target: OS share sheet → saved idea ---------------------------
  if (method === 'POST' && pathname === '/api/share-target') {
    const raw = await readBytes(req, 1024 * 1024);
    const fields = parseMultipart(raw, req.headers['content-type']);
    const title = String(fields.title || '').slice(0, 220);
    const text = String(fields.text || '').slice(0, 4000);
    const url = String(fields.url || '').slice(0, 2000);
    if (!title && !text && !url) return sendJson(res, 400, { error: 'Nothing to save — the share was empty.' });
    const isLink = /^https?:\/\//i.test(url);
    const item = {
      id: `s_${randId(8)}`, kind: 'capture', origin: 'capture',
      capture: { type: isLink ? 'link' : 'note', title: title || (isLink ? url : 'Shared note'), text, url: isLink ? url : '', notes: '' },
      perspective: { text: '', reaction: '' }, drafts: [], dismissed: false, saved: true, demo: false,
      createdAt: new Date().toISOString(),
    };
    await saveInboxItem(sid, item);
    res.writeHead(303, { location: '/#/ideas?shared=1' });
    res.end();
    return;
  }

  // -- captures (manual notes + pasted links) ------------------------------------
  if (method === 'POST' && pathname === '/api/captures') {
    const body = await readJson(req);
    const type = body.type === 'link' ? 'link' : body.type === 'voice' ? 'voice' : 'note';
    let { title = '', text = '', url = '', notes = '' } = body;
    title = String(title).slice(0, 220);
    text = String(text).slice(0, 4000);
    url = String(url).slice(0, 2000);
    notes = String(notes).slice(0, 2000);
    if (type === 'link') {
      if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: 'Pasted links must start with http(s)://.' });
      if (!text) {
        const ex = await fetchExcerpt(url).catch(() => null);
        if (ex?.excerpt) text = ex.excerpt;
      }
      if (!title) {
        try {
          title = new URL(url).hostname.replace(/^www\./, '');
        } catch { title = 'Saved link'; }
      }
    } else if (!title && !text) {
      return sendJson(res, 400, { error: 'Write a title or some text for your note.' });
    }
    const capture = { type, title: title || (type === 'voice' ? 'Voice note' : 'Untitled note'), text, url, notes };
    if (type === 'voice') {
      capture.url = '';
      capture.notes = '';
      capture.provenance = { engine: voiceModel(), mode: 'spoken brain dump', transcribedAt: new Date().toISOString() };
    }
    const item = {
      id: `s_${randId(8)}`, kind: 'capture', origin: 'capture',
      capture,
      perspective: { text: '', reaction: '' }, drafts: [], dismissed: false, saved: true, demo: false,
      createdAt: new Date().toISOString(),
    };
    await saveInboxItem(sid, item);
    return sendJson(res, 200, { item: withStatus(item) });
  }

  // -- style learning: inspectable profile + clear (recording is opt-in) ---------
  if (method === 'GET' && pathname === '/api/learning') {
    const prefs = await prefsOf(sid);
    return sendJson(res, 200, { enabled: prefs.learnFromUse === true, profile: learningSummary(await learningOf(sid)) });
  }
  if (method === 'DELETE' && pathname === '/api/learning') {
    await writeDoc('user', sid, 'learning', defaultProfile());
    return sendJson(res, 200, { ok: true });
  }

  // -- drafts ----------------------------------------------------------------------
  const draftMatch = pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)(\/(regenerate|refine|skip|approve|schedule|duplicate|restore|variant))?$/);
  if (draftMatch) {
    const [, draftId, , action] = draftMatch;
    const found = await findDraft(sid, draftId);
    if (!found.draft) return sendJson(res, 404, { error: 'Draft not found.' });
    const { item, draft } = found;
    const prefs = await prefsOf(sid);
    const validTone = (t) => typeof t === 'string' && t.trim().length > 0 && t.length <= 40;

    if (method === 'PATCH' && !action) {
      const body = await readJson(req);
      if (typeof body.text === 'string') {
        if (!body.text.trim()) return sendJson(res, 400, { error: 'Draft text must not be empty.' });
        draft.text = body.text.slice(0, 4000);
        if (draft.status === 'suggested') draft.status = 'edited';
      }
      if (typeof body.pillar === 'string') draft.pillar = body.pillar.slice(0, 60);
      if (body.plannedDate === null || /^\d{4}-\d{2}-\d{2}$/.test(String(body.plannedDate || ''))) draft.plannedDate = body.plannedDate || null;
      if (body.feedback && typeof body.feedback === 'object') {
        draft.feedback = {
          reflection: String(body.feedback.reflection || '').slice(0, 1000),
          performance: String(body.feedback.performance || '').slice(0, 1000),
          at: new Date().toISOString(),
        };
      }
      draft.updatedAt = new Date().toISOString();
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { draft });
    }
    if (method === 'DELETE' && !action) {
      // Scheduled drafts delete locally too — the Buffer queue is untouched.
      await noteOutcome(sid, prefs, draft, 'deleted');
      item.drafts = item.drafts.filter((d) => d.id !== draft.id);
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'duplicate') {
      const copy = JSON.parse(JSON.stringify(draft));
      copy.id = `d_${randId(8)}`;
      copy.status = 'suggested';
      copy.schedule = null;
      copy.confirmToken = null;
      copy.history = [];
      copy.createdAt = new Date().toISOString();
      copy.updatedAt = copy.createdAt;
      item.drafts.push(copy);
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { draft: copy });
    }
    if (method === 'POST' && action === 'restore') {
      const body = await readJson(req).catch(() => ({}));
      const idx = (draft.history || []).findIndex((h, i) => i === Number(body.index));
      if (idx < 0) return sendJson(res, 400, { error: 'No saved version at that position.' });
      pushHistory(draft, 'before restore');
      draft.text = draft.history[idx].text;
      draft.status = 'edited';
      draft.updatedAt = new Date().toISOString();
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { draft });
    }
    if (method === 'POST' && action === 'regenerate') {
      if (draft.status === 'scheduled') return sendJson(res, 409, { error: 'This draft is already scheduled.' });
      const body = await readJson(req).catch(() => ({}));
      if (validTone(body.tone)) draft.tone = body.tone.trim();
      if (LENGTHS.includes(body.length)) draft.length = body.length;
      if (draft.channel === 'x' && (body.format === 'thread' || body.format === 'post')) draft.format = body.format;
      if (typeof body.pillar === 'string') draft.pillar = body.pillar.slice(0, 60);
      const storyLike = storyLikeFor(item);
      const blocked = matchesNeverPost(`${storyLike.title} ${storyLike.summary || ''} ${item.perspective.text}`, prefs.neverPost);
      if (blocked) return sendJson(res, 400, { error: `This matches your never-post topic “${blocked}”.` });
      pushHistory(draft, `before refine (${draft.tone}, ${draft.length})`);
      const g = await generateDraft({
        story: storyLike, perspective: item.perspective, channel: draft.channel,
        tone: draft.tone, length: draft.length, matchedInterest: storyLike.matchedInterest || '',
        styleSamples: styleSamplesOf(prefs), format: draft.format || 'post', learning: learningInput(await learningOf(sid), prefs),
      });
      draft.text = g.text;
      draft.influences = g.influences;
      draft.engine = g.engine;
      draft.warning = g.warning || null;
      draft.status = 'edited';
      draft.origin = item.perspective.text || item.perspective.reaction ? 'refined' : 'initial';
      draft.updatedAt = new Date().toISOString();
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { draft });
    }
    if (method === 'POST' && action === 'refine') {
      if (draft.status === 'scheduled') return sendJson(res, 409, { error: 'This draft is already scheduled.' });
      const body = await readJson(req);
      pushHistory(draft, 'before inline refine');
      const r = refineDraft({ text: draft.text, instruction: body.instruction || '', channel: draft.channel, length: draft.length });
      draft.text = r.text;
      draft.warning = r.note;
      draft.status = 'edited';
      draft.updatedAt = new Date().toISOString();
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { draft });
    }
    if (method === 'POST' && action === 'variant') {
      if (draft.status === 'scheduled') return sendJson(res, 409, { error: 'This draft is already scheduled.' });
      const storyLike = storyLikeFor(item);
      pushHistory(draft, 'before alternative phrasing');
      const g = await generateVariant({
        story: storyLike, perspective: item.perspective, channel: draft.channel,
        tone: draft.tone, length: draft.length, matchedInterest: storyLike.matchedInterest || '',
        styleSamples: styleSamplesOf(prefs), format: draft.format || 'post',
        learning: learningInput(await learningOf(sid), prefs),
      });
      draft.text = g.text;
      draft.influences = g.influences;
      draft.engine = g.engine;
      draft.warning = g.warning || null;
      draft.status = 'edited';
      draft.updatedAt = new Date().toISOString();
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { draft });
    }
    if (method === 'POST' && action === 'skip') {
      draft.status = 'skipped';
      await noteOutcome(sid, prefs, draft, 'skipped');
      draft.updatedAt = new Date().toISOString();
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { draft });
    }
    if (method === 'POST' && action === 'approve') {
      if (draft.status === 'scheduled') return sendJson(res, 409, { error: 'This draft is already scheduled.' });
      draft.status = 'approved';
      await noteOutcome(sid, prefs, draft, 'approved');
      draft.confirmToken = randId(12);
      draft.confirmExpiresAt = Date.now() + 15 * 60 * 1000;
      draft.updatedAt = new Date().toISOString();
      await saveInboxItem(sid, item);
      return sendJson(res, 200, { confirmToken: draft.confirmToken, channel: draft.channel, text: draft.text });
    }
    if (method === 'POST' && action === 'schedule') {
      const body = await readJson(req);
      if (draft.status === 'scheduled' && draft.schedule) return sendJson(res, 200, { draft, duplicate: true }); // idempotent
      if (draft.status !== 'approved' || body.confirmToken !== draft.confirmToken || Date.now() > (draft.confirmExpiresAt || 0)) {
        return sendJson(res, 409, { error: 'Approval expired or missing — please approve this draft again, then confirm.' });
      }
      if (scheduleInflight.has(draft.id)) return sendJson(res, 409, { error: 'Scheduling already in progress for this draft.', busy: true });
      const mode = body.mode === 'customScheduled' ? 'customScheduled' : 'addToQueue';
      const job = (async () => {
        if (!oauthConfigured) {
          return { ...mockSchedule({ channelId: body.bufferChannelId || 'mock_linkedin', text: draft.text, mode, dueAt: body.dueAt }), mock: true };
        }
        const token = await ensureFreshToken(session, saveSession);
        const post = await createPost(token, { channelId: body.bufferChannelId, text: draft.text, mode, dueAt: body.dueAt });
        return { mode: 'real', postId: post.id, dueAt: post.dueAt, queuedAt: new Date().toISOString(), label: 'Scheduled with Buffer — check your Buffer queue to confirm.' };
      })();
      scheduleInflight.set(draft.id, job);
      try {
        const result = await job;
        draft.status = 'scheduled';
        await noteOutcome(sid, prefs, draft, 'scheduled');
        draft.idempotencyKey = String(body.idempotencyKey || randId(8));
        draft.schedule = { ...result, channelId: body.bufferChannelId || null, channelLabel: body.bufferChannelLabel || null, at: new Date().toISOString() };
        draft.confirmToken = null;
        draft.updatedAt = new Date().toISOString();
        await saveInboxItem(sid, item);
        return sendJson(res, 200, { draft });
      } catch (e) {
        if (e instanceof BufferError && e.code === 'needs_reauth') return sendJson(res, 409, { error: e.message, needsReauth: true });
        const status = e instanceof BufferError ? e.status : 502;
        return sendJson(res, status, { error: e.message || 'Scheduling failed', simulated: e.code === 'simulated' });
      } finally {
        scheduleInflight.delete(draft.id);
      }
    }
  }

  // -- Buffer channels -----------------------------------------------------------------
  if (method === 'GET' && pathname === '/api/buffer/channels') {
    if (!oauthConfigured) return sendJson(res, 200, { mode: 'mock', channels: mockChannels(), note: 'Demo channels — Buffer OAuth is not configured on this server.' });
    try {
      const token = await ensureFreshToken(session, saveSession);
      let org = session.buffer?.organization;
      if (!org?.id) {
        const orgs = await getOrganizations(token);
        org = orgs[0] ? { id: orgs[0].id, name: orgs[0].name } : null;
        session.buffer.organization = org;
        await saveSession(session);
      }
      if (!org?.id) return sendJson(res, 200, { mode: 'real', channels: [], note: 'No Buffer organization found on this account.' });
      const channels = await getChannels(token, org.id);
      return sendJson(res, 200, { mode: 'real', channels, organization: org });
    } catch (e) {
      if (e instanceof BufferError && e.code === 'needs_reauth') return sendJson(res, 409, { error: e.message, needsReauth: true });
      return sendJson(res, e instanceof BufferError ? e.status : 502, { error: e.message || 'Could not load Buffer channels' });
    }
  }

  // -- routine ---------------------------------------------------------------------------
  if (pathname === '/api/routine' && (method === 'GET' || method === 'PUT')) {
    if (method === 'GET') return sendJson(res, 200, { ...(await routineOf(sid)), cronConfigured: Boolean(process.env.CRON_SECRET), scheduler: schedulerStatus() });
    const prefs = await prefsOf(sid);
    const prev = await routineOf(sid);
    const next = { ...normalizeRoutine({ ...prev, ...(await readJson(req)) }, prefs.interests), lastRunAt: prev.lastRunAt, lastResult: prev.lastResult, runs: prev.runs };
    await writeDoc('user', sid, 'routine', next);
    return sendJson(res, 200, next);
  }
  if (method === 'POST' && pathname === '/api/routine/run') {
    const prefs = await prefsOf(sid);
    const routine = await routineOf(sid);
    const exclude = (await inboxOf(sid)).map((i) => i.story?.canonical || i.story?.url).filter(Boolean);
    const { items, warnings } = await runRoutine({ prefs, routine, excludeUrls: exclude, styleSamples: styleSamplesOf(prefs), learning: learningInput(await learningOf(sid), prefs) });
    await enrichStories(items.map((i) => i.story));
    for (const item of items) await saveInboxItem(sid, item);
    routine.lastRunAt = new Date().toISOString();
    routine.runs += 1;
    routine.lastResult = { added: items.length, warnings };
    await writeDoc('user', sid, 'routine', routine);
    return sendJson(res, 200, { items: items.map(withStatus), warnings, routine });
  }

  // -- scheduled routine: Vercel Cron / local ticker / external schedulers ---
  if (method === 'GET' && pathname === '/api/cron/routine') {
    // Open by default (Vercel Cron sends no secret); strict when CRON_SECRET is set.
    const candidate = url.searchParams.get('secret') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if ((candidate && !cronSecretOk(candidate)) || (!candidate && cronLocked())) return sendJson(res, 401, { error: 'Invalid cron secret.' });
    const result = await executeScheduledRun({});
    console.log(`[posty] cron routine ran=${result.ran}${result.reason ? ` reason=${result.reason}` : ` added=${result.added}`}`);
    return sendJson(res, 200, result);
  }

  // -- sources & connectors ---------------------------------------------------------------
  if (method === 'GET' && pathname === '/api/sources') {
    const prefs = await prefsOf(sid);
    const off = new Set(prefs.disabledProviders);
    const health = providerHealth();
    const provider = (id, name, reads) => ({
      id, name, kind: 'stories', reads,
      status: off.has(id) ? 'paused' : health[id]?.cooling ? 'cooling' : 'live',
      note: off.has(id)
        ? 'Paused by you — enable to include in discovery.'
        : health[id]?.cooling
          ? 'Cooling down after repeated failures — skipped automatically for a few minutes.'
          : 'Keyless live source. No account needed.',
    });
    return sendJson(res, 200, {
      sources: [
        provider('hn', 'Hacker News', 'Public story search: title, link, date.'),
        provider('gdelt', 'GDELT', 'World-news article list: title, link, date, outlet.'),
        provider('reddit', 'Reddit inspiration', 'Profession-community feeds: post title, discussion link, date, post text.'),
        exaConfigured()
          ? provider('exa', 'Exa web search', 'General web search: title, link, date, highlights. Paid per search (~$0.007).')
          : { id: 'exa', name: 'Exa web search', kind: 'stories', reads: 'Would search the general web. Not connected.', status: 'unavailable', note: 'Needs an EXA_API_KEY on the server. Discovery uses the keyless built-ins until then.' },
        { id: 'manual', name: 'Manual notes', kind: 'capture', reads: 'Only what you type into Posty.', status: 'built-in', note: 'Always available. Nothing leaves your workspace except on scheduling.' },
        { id: 'links', name: 'Pasted links', kind: 'capture', reads: 'URLs you paste; Posty fetches the page title and opening excerpt.', status: 'built-in', note: 'Always available.' },
        { id: 'notes', name: 'Notes app', kind: 'capture', reads: 'Would read notes you select. Not connected.', status: 'unavailable', note: 'No credentials configured. Use the labeled demo or manual capture.' },
        { id: 'calendar', name: 'Calendar & meetings', kind: 'capture', reads: 'Would read meeting titles you select. Not connected.', status: 'unavailable', note: 'No credentials configured. Use the labeled demo or manual capture.' },
        { id: 'code', name: 'Code & project updates', kind: 'capture', reads: 'Would read repo activity you select. Not connected.', status: 'unavailable', note: 'No credentials configured. Use the labeled demo or manual capture.' },
        { id: 'reading', name: 'Reading list', kind: 'capture', reads: 'Would read saved articles you select. Not connected.', status: 'unavailable', note: 'No credentials configured. Use the labeled demo or manual capture.' },
        {
          id: 'buffer', name: 'Buffer', kind: 'scheduling', reads: 'Organizations and channels (to schedule); posts only on your approval.',
          status: !oauthConfigured ? 'unconfigured' : session.buffer?.accessToken ? 'connected' : 'disconnected',
          note: !oauthConfigured ? 'No OAuth app configured — scheduling is demo-only.' : session.buffer?.accessToken ? `Connected${session.buffer.organization ? ` to ${session.buffer.organization.name}` : ''}.` : 'OAuth is configured. Connect to schedule for real.',
        },
      ],
    });
  }
  const sourceDemoMatch = pathname.match(/^\/api\/sources\/([a-z]+)\/(demo|clear-demo)$/);
  if (method === 'POST' && sourceDemoMatch) {
    const [, connector, op] = sourceDemoMatch;
    if (!['notes', 'calendar', 'code', 'reading'].includes(connector)) return sendJson(res, 400, { error: 'Demo data is only offered for unavailable connectors.' });
    if (op === 'clear-demo') {
      await writeDoc('user', sid, 'inbox', (await inboxOf(sid)).filter((i) => !(i.demo && i.connectorDemo === connector)));
      return sendJson(res, 200, { ok: true });
    }
    const labels = { notes: 'Demo note import', calendar: 'Demo meeting import', code: 'Demo commit import', reading: 'Demo saved article' };
    const item = {
      id: `s_${randId(8)}`, kind: 'capture', origin: 'demo', demo: true, connectorDemo: connector,
      capture: { type: 'note', title: `${labels[connector]} (DEMO)`, text: 'Clearly labeled sample content showing what an import from this connector would look like. No real account is connected.', url: '', notes: '' },
      perspective: { text: '', reaction: '' }, drafts: [], dismissed: false, saved: true,
      createdAt: new Date().toISOString(),
    };
    await saveInboxItem(sid, item);
    return sendJson(res, 200, { item: withStatus(item) });
  }

  // -- guided demo workspace ---------------------------------------------------------------
  // -- onboarding track: derived checklist + dismiss ------------------------------
  if (method === 'GET' && pathname === '/api/onboarding') {
    const prefs = await prefsOf(sid);
    const routine = await routineOf(sid);
    const counts = { stories: 0, captures: 0, withTake: 0, drafts: 0, scheduled: 0 };
    for (const i of await inboxOf(sid)) {
      if (i.demo || i.dismissed) continue;
      if (i.kind === 'capture') counts.captures++;
      else counts.stories++;
      if (i.perspective?.text || i.perspective?.reaction) counts.withTake++;
      counts.drafts += (i.drafts || []).filter((d) => d.status !== 'skipped').length;
      counts.scheduled += (i.drafts || []).filter((d) => d.status === 'scheduled').length;
    }
    const dismissed = await readDoc('user', sid, 'onboard-dismissed', false);
    return sendJson(res, 200, { ...stepsOf({ prefs, connected: Boolean(session.buffer?.accessToken), routine, counts }), dismissed: dismissed === true });
  }
  if (method === 'POST' && pathname === '/api/onboarding/dismiss') {
    await writeDoc('user', sid, 'onboard-dismissed', true);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/demo/seed') {
    const items = demoSeedItems();
    const prefs = await prefsOf(sid);
    for (const channel of prefs.preferredChannels.slice(0, 2)) {
      items[0].drafts.push(await makeDraft({
        story: items[0].story, channel, tone: prefs.tone, length: prefs.length,
        matchedInterest: items[0].story.matchedInterest, perspective: {}, styleSamples: [], learning: learningInput(await learningOf(sid), prefs),
      }));
    }
    for (const item of items) await saveInboxItem(sid, item);
    return sendJson(res, 200, { items: items.map(withStatus) });
  }
  if (method === 'POST' && pathname === '/api/demo/clear') {
    await writeDoc('user', sid, 'inbox', (await inboxOf(sid)).filter((i) => !i.demo));
    return sendJson(res, 200, { ok: true });
  }

  return null; // no route matched
}

export async function handleNodeRequest(req, res) {
  const start = Date.now();
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && serveStatic(req, res, url.pathname)) {
      console.log(`${req.method} ${url.pathname} 200 ${Date.now() - start}ms (static)`);
      return;
    }
    const handled = await route(req, res, url).catch((e) => {
      if (res.writableEnded) return true;
      const status = e.status || 500;
      sendJson(res, status, { error: e.message || 'Unexpected server error' });
      return true;
    });
    if (!handled && !res.writableEnded) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) sendJson(res, 404, { error: 'Not found' });
      else {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end(`<h1>Not found</h1><p>No page at ${esc(url.pathname)}. <a href="/">Back to Posty</a></p>`);
      }
    }
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - start}ms`);
  } catch (e) {
    console.error('request failed:', e);
    if (!res.writableEnded) sendJson(res, 500, { error: 'Unexpected server error' });
  }
}
