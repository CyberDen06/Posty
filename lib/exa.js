// Exa web search boundary (https://api.exa.ai/search).
// Shapes follow the canonical build-with-exa skill + OpenAPI spec:
// recommended request {query, type:'auto', contents:{highlights:true}},
// plus `objective` (this search is one step of the story→draft pipeline)
// and a bounded `numResults` (intentional product decision: Posty shows a
// few stories, never ten). Highlights are verbatim page excerpts, so they
// become faithful summaries. Raw HTTP keeps the repo dependency-free.

import { cacheGet, cacheSet } from './store.js';

const SEARCH_URL = 'https://api.exa.ai/search';

export function exaConfigured() {
  return Boolean(process.env.EXA_API_KEY);
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Pure mapping, exported for tests: Exa result → Posty story shape.
export function mapExaResults(results) {
  return (results || [])
    .filter((r) => r?.title && r?.url)
    .map((r) => {
      const highlights = (Array.isArray(r.highlights) ? r.highlights : [])
        .filter((h) => typeof h === 'string' && h.trim().length > 25)
        .slice(0, 2)
        .join(' ')
        .slice(0, 1200);
      return {
        title: String(r.title),
        url: String(r.url),
        date: r.publishedDate || null,
        source: hostOf(r.url) || 'Web',
        author: r.author || null,
        summary: highlights.length ? highlights : null,
        summaryLabel: 'Search highlights',
        provider: 'exa',
      };
    });
}

function fail(message, status) {
  throw Object.assign(new Error(message), { status, provider: 'exa' });
}

function costTotal(costDollars) {
  if (typeof costDollars === 'number') return costDollars;
  return Number(costDollars?.total) || 0;
}

async function logCost(kind, costDollars, results) {
  const total = costTotal(costDollars);
  console.log(`[posty] exa kind=${kind} results=${results} cost=$${total.toFixed(4)}`);
  try {
    const key = `exa-usage:${new Date().toISOString().slice(0, 10)}`;
    const day = (await cacheGet(key, 48 * 3600 * 1000)) || { calls: 0, dollars: 0 };
    day.calls += 1;
    day.dollars += total;
    await cacheSet(key, day);
  } catch { /* usage logging must never break search */ }
}

export async function exaSearch({ query, numResults = 3, objective, timeoutMs = 20000 }) {
  if (!exaConfigured()) fail('Exa web search needs an API key — add EXA_API_KEY to search the general web.', 503);
  const q = String(query || '').trim();
  if (!q) fail('Exa search needs a query.', 400);
  const body = {
    query: q.slice(0, 500),
    type: 'auto',
    numResults: Math.min(10, Math.max(1, numResults)),
    contents: { highlights: true },
    objective: objective || 'Find recent substantive articles about the topic that the user could read and write a social post about. Rank reporting and analysis first; pull the key facts and figures into the highlights.',
  };
  let res;
  try {
    res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.EXA_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    fail(`Exa search unreachable (${err.message})`, 502);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* fall through */ }
  if (res.status === 401) fail('Exa rejected the API key — check EXA_API_KEY.', 401);
  if (res.status === 402) fail('Exa credits are exhausted — top up at dashboard.exa.ai.', 402);
  if (res.status === 429) fail('Exa rate-limited this request — try again shortly.', 429);
  if (!res.ok || !data) fail(data?.error || `Exa search failed with status ${res.status}.`, 502);
  const stories = mapExaResults(data.results);
  await logCost('search', data?.costDollars, stories.length);
  return stories;
}

// Structured per-article briefs via POST /contents with a summary schema.
// Observed shape: result.summary is a STRING of JSON {tldr, keyPoints[], conclusion}.
// Returns Map(url -> brief); URLs that errored are absent (caller keeps highlights).
export function mapContentsBriefs(results, statuses) {
  const ok = new Set((statuses || []).filter((s) => s?.status === 'success').map((s) => s.id));
  const out = new Map();
  for (const r of results || []) {
    if (!r?.url || (ok.size && !ok.has(r.url))) continue;
    const brief = parseBrief(r.summary);
    if (brief) out.set(r.url, brief);
  }
  return out;
}

function cleanLine(s) {
  const t = String(s || '').trim();
  return !t || /^(null|n\/a|none)$/i.test(t) ? '' : t.slice(0, 600);
}

// Meta-field junk the summarizer sometimes leaks as content ("evidence/examples
// mentioned in text:", "conclusion_patientNotes", ...). Lines framed this way
// are dropped wholesale from key points/conclusion; the TL;DR is delabeled but
// kept, since a brief needs its gist.
const META_WORDS = new Set(['evidence', 'examples', 'example', 'mentioned', 'in', 'text', 'conclusion', 'conclusions', 'patient', 'patientnotes', 'notes', 'note', 'tldr', 'key', 'points', 'summary']);
const META_LABELED = /^(evidence(\/examples?)?|examples?(\s+mentioned\s+in\s+text)?|conclusions?|patient\s*notes?|patientnotes|tldr|key\s*points?|summary|notes?)\b\s*[:_\-]/i;
const META_SELFREF = /patient\s*notes?|patientnotes|mentioned\s+in\s+text|long[\s-]?form\s+summar|\bkey\s*points\b|\btldr\b/i;

export function isMetaJunk(line) {
  const t = String(line || '').trim();
  return Boolean(t) && (META_LABELED.test(t) || META_SELFREF.test(t));
}

export function stripMetaPrefix(line) {
  let out = String(line || '').trim().replace(/^(tl;?dr)\s*:\s*/i, '');
  for (let i = 0; i < 6; i++) {
    const m = out.match(/^([A-Za-z][A-Za-z\s/\-_]*?)\s*[:_\-]+\s*([\s\S]*)$/);
    if (!m) break;
    const words = m[1].toLowerCase().replace(/[/\-_]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length || !words.every((w) => META_WORDS.has(w))) break;
    out = m[2].trim();
    if (!out) break;
  }
  return out;
}

export function parseBrief(summary) {
  let obj = null;
  if (typeof summary === 'string') {
    try {
      obj = JSON.parse(summary);
    } catch {
      const tldr = cleanLine(stripMetaPrefix(summary)).slice(0, 1200);
      return tldr ? { tldr, keyPoints: [], conclusion: '' } : null;
    }
  } else if (summary && typeof summary === 'object') {
    obj = summary;
  }
  if (!obj) return null;
  const tldr = cleanLine(stripMetaPrefix(obj.tldr)).slice(0, 1200);
  const keyPoints = (Array.isArray(obj.keyPoints) ? obj.keyPoints : [])
    .filter((p) => !isMetaJunk(p))
    .map((p) => cleanLine(stripMetaPrefix(p)))
    .filter((p) => p.length > 3)
    .slice(0, 10);
  const conclusion = isMetaJunk(obj.conclusion) ? '' : cleanLine(stripMetaPrefix(obj.conclusion));
  if (!tldr && !keyPoints.length) return null;
  return { tldr, keyPoints, conclusion };
}

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    tldr: { type: 'string', description: 'Two-sentence gist of the article, plain prose, no labels' },
    keyPoints: { type: 'array', items: { type: 'string' }, description: 'Substantive points covering ~80% of the article: claims, evidence, examples, conclusions. Plain prose only — never prefixes, field names, or labels like "evidence:" or "conclusion:", and no meta-commentary about the summary itself' },
    conclusion: { type: 'string', description: "The article's bottom line or takeaway, plain prose, no labels" },
  },
  required: ['tldr', 'keyPoints'],
};

export async function exaSummaries({ urls, focus = '', timeoutMs = 30000 }) {
  if (!exaConfigured()) fail('Exa web search needs an API key — add EXA_API_KEY.', 503);
  const list = [...new Set((urls || []).filter((u) => /^https?:\/\//.test(u || '')))].slice(0, 5);
  if (!list.length) return new Map();
  const focusLine = focus ? ` The reader asked about "${String(focus).slice(0, 200)}" — weight relevant angles first.` : '';
  let res;
  try {
    res = await fetch('https://api.exa.ai/contents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.EXA_API_KEY },
      body: JSON.stringify({
        urls: list,
        summary: { query: `Summarize the article's key points, supporting evidence or examples, and conclusions — enough that a reader grasps ~80% of it without opening the page. Write every field in plain prose: no field names, no labels, no meta-commentary about the summary.${focusLine}`, schema: BRIEF_SCHEMA },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    fail(`Exa contents unreachable (${err.message})`, 502);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* fall through */ }
  if (res.status === 401) fail('Exa rejected the API key — check EXA_API_KEY.', 401);
  if (res.status === 402) fail('Exa credits are exhausted — top up at dashboard.exa.ai.', 402);
  if (res.status === 429) fail('Exa rate-limited this request — try again shortly.', 429);
  if (!res.ok || !data) fail(data?.error || `Exa contents failed with status ${res.status}.`, 502);
  const briefs = mapContentsBriefs(data.results, data.statuses);
  await logCost('contents', data?.costDollars, briefs.size);
  return briefs;
}
