import { canonicalUrl, fetchJson, normTitle, timeAgo } from './util.js';
import { cacheGet, cacheSet } from './store.js';
import { exaConfigured, exaSearch } from './exa.js';

// Story search lives behind this module boundary: providers can be swapped
// without touching routes or UI. Every returned story carries a genuine URL
// from a real provider response — this module never invents stories, links,
// dates, or summaries. Missing fields stay null for the UI to omit or label.

const PROVIDER_CACHE_MS = 30 * 60 * 1000;
const inflight = new Map(); // same-process dedupe; values persist via cacheGet/cacheSet

async function cached(key, ttlMs, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const hit = await cacheGet(key, ttlMs);
    if (hit !== undefined) return hit;
    const value = await fn();
    // Only successes are cached: failures stay retryable.
    await cacheSet(key, value).catch(() => {});
    return value;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

function providerError(provider, err) {
  const e = new Error(err?.status === 429 ? `${provider} rate-limited this request — try again shortly` : `${provider} search failed (${err?.message || 'unknown error'})`);
  e.provider = provider;
  e.status = err?.status || 502;
  return e;
}

// Circuit breaker: 3 consecutive failures (any error) cools a provider down
// for 10 minutes so one sick source can't slow every find. In-memory per
// instance; providers stay parallel because that is latency-optimal.
const breaker = new Map();

function isCooling(name) {
  const b = breaker.get(name);
  return Boolean(b && Date.now() < b.skipUntil);
}

function recordProvider(name, ok) {
  if (ok) {
    breaker.delete(name);
    return;
  }
  const b = breaker.get(name) || { fails: 0, skipUntil: 0 };
  b.fails += 1;
  if (b.fails >= 3) {
    b.skipUntil = Date.now() + 10 * 60 * 1000;
    b.fails = 0;
  }
  breaker.set(name, b);
}

export function providerHealth() {
  const out = {};
  for (const name of ['hn', 'gdelt', 'reddit', 'exa']) {
    const b = breaker.get(name);
    out[name] = { cooling: Boolean(b && Date.now() < b.skipUntil), fails: b?.fails || 0 };
  }
  return out;
}

// --- Hacker News Search (Algolia): keyless, tech-strong ----------------------
// Date-ordered search with a 90-day recency floor so "recent developments"
// are actually recent; falls back to unfiltered recency for quiet topics.
async function hnSearch(query, limit = 6) {
  return cached(`hn:${query}:${limit}`, PROVIDER_CACHE_MS, async () => {
    const since = Math.floor(Date.now() / 1000) - 90 * 86400;
    const base = `query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
    let data = null;
    let lastErr = null;
    for (const extra of [`&numericFilters=created_at_i>${since}`, '']) {
      try {
        data = await fetchJson(`https://hn.algolia.com/api/v1/search_by_date?${base}${extra}`, { timeoutMs: 12000 });
      } catch (err) {
        lastErr = err;
        continue;
      }
      if (data && Array.isArray(data.hits) && data.hits.length > 0) break;
    }
    if (!data || !Array.isArray(data.hits)) throw providerError('Hacker News', lastErr || new Error('malformed response'));
    return data.hits
      .filter((h) => h && h.title)
      .map((h) => ({
        title: String(h.title),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        date: h.created_at || null,
        source: 'Hacker News',
        author: h.author || null,
        summary: null, // HN provides no summaries — UI labels this honestly.
        provider: 'hn',
        rank: h.points || 0,
      }));
  });
}

// --- GDELT DOC 2.0 artlist: keyless, broad world-news coverage ---------------
function parseGdeltDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || ''));
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

async function gdeltSearch(orQuery, maxrecords = 25) {
  return cached(`gdelt:${orQuery}:${maxrecords}`, PROVIDER_CACHE_MS, async () => {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(orQuery)}&mode=artlist&maxrecords=${maxrecords}&timespan=1week&sort=datedesc&format=json`;
    let data;
    try {
      data = await fetchJson(url, { timeoutMs: 15000 });
    } catch (err) {
      throw providerError('GDELT', err);
    }
    const articles = Array.isArray(data?.articles) ? data.articles : null;
    if (!articles) throw providerError('GDELT', new Error('malformed response'));
    return articles
      .filter((a) => a && (a.url || a.URL) && (a.title || a.Title))
      .map((a) => ({
        title: String(a.title || a.Title),
        url: String(a.url || a.URL),
        date: parseGdeltDate(a.seendate || a.SeenDate || a.date),
        source: String(a.domain || a.Domain || 'GDELT'),
        author: null,
        summary: null, // artlist returns no summaries — UI labels this honestly.
        provider: 'gdelt',
        rank: 0,
      }));
  });
}

// --- Reddit: keyless subreddit RSS (Atom) --------------------------------------
// Reddit's JSON API requires OAuth for search, so Posty reads public
// per-subreddit Atom feeds (sort=new) and filters locally by the user's
// interests. Each item links to the real Reddit discussion. Scores and
// comment counts are not in the feed, so none are shown or implied.
const REDDIT_UA = 'Posty/0.1 (hackathon demo; low-volume personal use)';
const SUBREDDITS = {
  'Software Engineer': ['programming', 'ExperiencedDevs'],
  Founder: ['startups', 'Entrepreneur'],
  'Product Manager': ['ProductManagement'],
  Designer: ['UXDesign', 'Design'],
  Marketer: ['marketing', 'Entrepreneur'],
  'Data/AI Professional': ['MachineLearning', 'datascience'],
  Consultant: ['consulting'],
};
const FALLBACK_SUBS = ['technology'];

export function decodeEntities(s) {
  return String(s)
    .replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e] || m))
    .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : m; })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : m; });
}

// Link-post feed entries carry boilerplate ("submitted by … [link]") instead of
// real post text — surface it as unavailable rather than as post content.
export function cleanRedditContent(raw) {
  const text = stripTags(decodeEntities(raw || '')).replace(/\s+/g, ' ').trim();
  if (!text || /submitted by\s+\S*\s*\[link\]/i.test(text)) return null;
  return text;
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function redditFeed(sub) {
  return cached(`reddit:${sub}`, PROVIDER_CACHE_MS, async () => {
    const url = `https://www.reddit.com/r/${sub}/.rss?sort=new&limit=25`;
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': REDDIT_UA }, signal: AbortSignal.timeout(12000) });
    } catch (err) {
      throw providerError('Reddit', err);
    }
    const xml = await res.text();
    if (res.status === 429 || !res.ok || !xml.includes('<entry')) {
      const err = new Error(res.status === 429 ? 'rate limited' : `feed failed with status ${res.status}`);
      err.status = res.status;
      throw providerError('Reddit', err);
    }
    return parseRedditFeed(xml, sub);
  });
}

export function parseRedditFeed(xml, sub) {
  const entries = [];
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const title = decodeEntities((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const link = ((e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '').trim();
    const updated = ((e.match(/<updated>([^<]+)<\/updated>/) || [])[1] || '').trim();
    const content = cleanRedditContent((e.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '');
    if (!title || !link) continue;
    entries.push({ title, link, updated, content, sub });
  }
  return entries;
}

async function redditSearch({ profession, interests }) {
  const subs = (SUBREDDITS[profession] || FALLBACK_SUBS).slice(0, 2);
  const keywords = new Set(interests.flatMap((i) => normTitle(i).split(' ').filter((w) => w.length > 3)));
  const stories = [];
  let failures = 0;
  for (let i = 0; i < subs.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500)); // Reddit throttles back-to-back hits
    let entries;
    try {
      entries = await redditFeed(subs[i]);
    } catch (err) {
      failures++;
      continue; // one throttled feed must not sink the whole provider
    }
    for (const e of entries) {
      const hay = normTitle(`${e.title} ${(e.content || '').slice(0, 500)}`);
      const hits = [...keywords].filter((k) => hay.includes(k)).length;
      const t = Date.parse(e.updated);
      stories.push({
        title: e.title.length > 220 ? `${e.title.slice(0, 217)}…` : e.title,
        url: e.link,
        date: Number.isNaN(t) ? null : new Date(t).toISOString(),
        source: `r/${e.sub}`,
        author: null,
        summary: e.content ? e.content.slice(0, 320) : null,
        summaryLabel: 'Post text',
        provider: 'reddit',
        rank: hits,
        keywordHits: hits,
      });
    }
  }
  if (failures === subs.length) throw providerError('Reddit', new Error('all feeds throttled or unreachable'));
  // Keyword matches first, then fresh profession-community posts as inspiration.
  stories.sort((a, b) => (b.keywordHits - a.keywordHits) || ((Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)));
  return stories.slice(0, 4);
}

// --- NewsAPI: LOCAL DEVELOPMENT ONLY ----------------------------------------
// Enabled only when NEWS_API_KEY is set. Licensing/freshness/terms are not
// cleared for deployed use; results are labeled local-dev in the UI.
async function newsapiSearch(orQuery, pageSize = 10) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return { skipped: true, stories: [] };
  return cached(`newsapi:${orQuery}:${pageSize}`, PROVIDER_CACHE_MS, async () => {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(orQuery)}&sortBy=publishedAt&language=en&pageSize=${pageSize}`;
    let data;
    try {
      data = await fetchJson(url, { timeoutMs: 12000, headers: { 'X-Api-Key': key } });
    } catch (err) {
      throw providerError('NewsAPI', err);
    }
    if (!data || data.status !== 'ok' || !Array.isArray(data.articles)) {
      throw providerError('NewsAPI', new Error(data?.message || 'malformed response'));
    }
    return {
      skipped: false,
      stories: data.articles
        .filter((a) => a && a.title && a.url && a.title !== '[Removed]')
        .map((a) => ({
          title: String(a.title),
          url: String(a.url),
          date: a.publishedAt || null,
          source: String(a.source?.name || 'NewsAPI'),
          author: a.author || null,
          summary: a.description || null,
          provider: 'newsapi',
          localDevOnly: true,
          rank: 0,
        })),
    };
  });
}

// Score how well a title matches each interest by word overlap, normalized by
// interest length so broad interests ("AI") don't beat specific ones.
// Exported for the test seam; searchStories is the real entry point.
export function interestMatch(title, interests) {
  const words = new Set(normTitle(title).split(' ').filter((w) => w.length > 2));
  let best = interests[0];
  let bestScore = 0;
  for (const interest of interests) {
    const iw = normTitle(interest).split(' ').filter((w) => w.length > 2);
    if (!iw.length) continue;
    const score = iw.filter((w) => words.has(w)).length / iw.length;
    if (score > bestScore) {
      bestScore = score;
      best = interest;
    }
  }
  return { interest: best, score: bestScore };
}

// Bigram Jaccard similarity on normalized titles — catches near-duplicate
// coverage of the same event ("OpenAI ships X" vs "OpenAI has shipped X").
export function titleSimilar(a, b) {
  const grams = (t) => {
    const s = normTitle(t).replace(/\s/g, '');
    const g = new Set();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

// Recency (7-day half-life) blended with interest-match strength, so a very
// fresh weak match doesn't beat an older strong one, and vice versa.
export function storyScore(s) {
  const t = Date.parse(s.date);
  const recency = Number.isNaN(t) ? 0 : Math.pow(0.5, Math.max(0, Date.now() - t) / (24 * 7 * 3600 * 1000));
  return recency * (0.5 + 0.5 * (s.matchScore || 0));
}

// Fan out across interests, merge providers, dedupe repeat coverage of the
// same event (canonical URL, normalized title, near-dupe titles), score by
// recency + match strength, and interleave distinct interests in the top-N.
export async function searchStories({ interests, profession = '', excludeUrls = [], maxTotal = 2, disabledProviders = [] }) {
  const off = new Set(disabledProviders);
  const picks = [...new Set((interests || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 3);
  if (picks.length === 0) {
    const err = new Error('select at least one interest to search');
    err.status = 400;
    throw err;
  }
  const excluded = new Set(excludeUrls.map(canonicalUrl));
  const orQuery = picks.map((p) => `"${p}"`).join(' OR ');
  const warnings = [];

  const jobs = [];
  const guarded = (key, label, fn) => {
    if (off.has(key)) return;
    if (isCooling(key)) {
      warnings.push({ provider: label, message: `${label} is cooling down after repeated failures — skipping for now` });
      return;
    }
    jobs.push(fn().then(
      (r) => { recordProvider(key, true); return r; },
      (err) => { recordProvider(key, false); warnings.push({ provider: label, message: err.message }); return []; }
    ));
  };
  for (const p of picks) guarded('hn', 'Hacker News', () => hnSearch(p));
  guarded('gdelt', 'GDELT', () => gdeltSearch(orQuery));
  guarded('reddit', 'Reddit', () => redditSearch({ profession, interests: picks }));
  // Exa: one paid call per find (cached like the rest), never one per interest.
  // Single-interest/Ask queries go verbatim; multi-interest gets recency phrasing.
  if (exaConfigured()) {
    const exaQuery = picks.length === 1 ? picks[0] : `recent developments in ${picks.join(', ')}`;
    guarded('exa', 'Exa', () => cached(`exa:${exaQuery}:4`, PROVIDER_CACHE_MS, () => exaSearch({ query: exaQuery, numResults: 4 })));
  }
  if (jobs.length === 0 && warnings.length === 0) {
    const err = new Error('All story providers are paused — enable at least one in Sources');
    err.status = 400;
    throw err;
  }
  if (process.env.NEWS_API_KEY) {
    jobs.push(newsapiSearch(orQuery).then((r) => r.stories).catch((err) => {
      warnings.push({ provider: 'NewsAPI', message: err.message });
      return [];
    }));
  }
  // Total provider budget: return partial results rather than hang on a tail.
  const FIND_BUDGET_MS = 25000;
  const completed = [];
  let timedOut = false;
  await Promise.race([
    Promise.all(jobs.map((j) => j.then((r) => { completed.push(...r); }))),
    new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, FIND_BUDGET_MS)),
  ]);
  if (timedOut) warnings.push({ provider: 'Posty', message: 'Search budget exceeded — showing partial results' });
  const merged = completed;

  const seenUrl = new Set();
  const seenTitle = new Set();
  const fresh = [];
  for (const s of merged) {
    const cu = canonicalUrl(s.url);
    const nt = normTitle(s.title);
    if (!cu || !nt || excluded.has(cu) || seenUrl.has(cu) || seenTitle.has(nt)) continue;
    if (fresh.some((k) => titleSimilar(k.title, s.title) >= 0.6)) continue; // near-dupe coverage
    seenUrl.add(cu);
    seenTitle.add(nt);
    const { interest, score } = interestMatch(s.title, picks);
    const ago = s.date ? timeAgo(s.date) : null;
    const why = (s.provider === 'reddit' && !s.keywordHits && profession)
      ? `Fresh in ${s.source}, included for ${profession}s${ago ? ` — posted ${ago}` : ''}.`
      : `Matches your interest in “${interest}”${ago ? ` — published ${ago}` : ''}.`;
    fresh.push({ ...s, canonical: cu, matchedInterest: interest, matchScore: score, why });
  }
  fresh.sort((a, b) => storyScore(b) - storyScore(a));

  if (fresh.length === 0 && warnings.length > 0 && merged.length === 0) {
    const err = new Error(warnings.map((w) => w.message).join(' / '));
    err.status = 502;
    err.warnings = warnings;
    throw err;
  }
  // Diversity-first top-N: cover distinct interests before repeating one, so
  // overlapping interests can't crowd each other out of the short list.
  const picked = [];
  for (const s of fresh) {
    if (picked.length >= maxTotal) break;
    if (!picked.some((p) => p.matchedInterest === s.matchedInterest)) picked.push(s);
  }
  for (const s of fresh) {
    if (picked.length >= maxTotal) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return { stories: picked, warnings, totalFresh: fresh.length };
}
