import { decodeEntities } from './providers.js';
import { llmConfigured, summarizeComments } from './llm.js';
import { cacheGet, cacheSet } from './store.js';
import { exaConfigured, exaSummaries } from './exa.js';

// Faithful summaries, in order of preference:
// 1. Provider-supplied text (passed through by callers).
// 2. The linked page's own description / opening sentences, verbatim.
// 3. For HN discussions: an LLM snapshot grounded ONLY in fetched comments.
// Nothing is paraphrased from thin air; when no text exists, the story keeps
// summary=null for the UI to label honestly.

const EXCERPT_CACHE_MS = 24 * 60 * 60 * 1000;

function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 25);
}

function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

// Discussion shells whose body text would be UI junk (nav, login walls).
// HN item pages are handled via comment extraction instead; Reddit
// permalinks serve an empty shell to bots and are skipped.
export function isDiscussionShell(url) {
  try {
    const u = new URL(String(url));
    if (u.hostname === 'news.ycombinator.com' && u.pathname.startsWith('/item')) return 'hn-comments';
    if ((u.hostname === 'www.reddit.com' || u.hostname === 'reddit.com') && u.pathname.includes('/comments/')) return 'reddit-shell';
    return null;
  } catch { return null; }
}

export function parseHnComments(html) {
  const out = [];
  for (const m of String(html).matchAll(/<div class="commtext[^"]*">([\s\S]*?)<\/div>/g)) {
    const text = decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text.length > 40) out.push(text);
    if (out.length >= 6) break;
  }
  return out;
}

export async function fetchExcerpt(url) {
  if (isDiscussionShell(url)) return null;
  let u;
  try {
    u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  } catch { return null; }
  const key = `excerpt:${u.toString()}`;
  const hit = await cacheGet(key, EXCERPT_CACHE_MS);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(u.toString(), {
      headers: { 'user-agent': 'Posty/0.1 (hackathon demo; excerpt for personal reading)', accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('html')) return null;
    const html = (await res.text()).slice(0, 300_000);
    // Prefer the publisher's own description (verbatim, faithful) when present.
    const og = html.match(/<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]*content=["']([\s\S]*?)["']/i)
      || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]*(?:property=["']og:description["']|name=["']description["'])/i);
    const ogText = og ? decodeEntities(og[1]).replace(/\s+/g, ' ').trim() : '';
    const excerpt = (ogText.length >= 40 ? ogText : sentences(htmlToText(html)).slice(0, 3).join(' ')).slice(0, 600);
    if (!excerpt) return null; // failures are never cached — always retryable
    const value = { excerpt };
    await cacheSet(key, value).catch(() => {});
    return value;
  } catch {
    return null; // failures are never cached; the UI labels the gap
  }
}

function cleanHnText(html) {
  const text = decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length > 40 ? text : null;
}

// HN discussion text via the official keyless Firebase API, falling back to
// page scraping. Returns null when there is nothing to summarize.
async function fetchHnCommentText(url) {
  const id = (String(url).match(/[?&]id=(\d+)/) || [])[1];
  if (id) {
    try {
      const item = await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(8000) })).json();
      const kids = (item?.kids || []).slice(0, 5);
      if (kids.length) {
        const texts = await Promise.all(kids.map((kid) =>
          fetch(`https://hacker-news.firebaseio.com/v0/item/${kid}.json`, { signal: AbortSignal.timeout(8000) })
            .then((r) => r.json()).then((c) => (c && !c.dead && !c.deleted ? cleanHnText(c.text) : null))
            .catch(() => null)
        ));
        const joined = texts.filter(Boolean).join('\n---\n').slice(0, 4000);
        if (joined) return joined;
      }
      // Ask HN posts carry the question as item text — usable context.
      const self = cleanHnText(item?.text);
      if (self) return self.slice(0, 2000);
    } catch { /* fall through to page scrape */ }
  }
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Posty/0.1 (hackathon demo; excerpt for personal reading)', accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const comments = parseHnComments((await res.text()).slice(0, 300_000));
    if (!comments.length) return null;
    return comments.join('\n---\n').slice(0, 4000);
  } catch {
    return null;
  }
}

// Best-effort enrichment: provider summaries win; then page excerpts; then a
// grounded comment snapshot for HN discussions (LLM only). Never blocks story
// retrieval on failure.
export async function enrichStories(stories, { focus = '' } = {}) {
  await Promise.all(stories.map(async (s) => {
    if (s.summary || !s.url) return;
    try {
      const ex = await fetchExcerpt(s.url);
      if (ex) {
        s.summary = ex.excerpt;
        s.summaryLabel = 'Opening excerpt';
        return;
      }
      if (llmConfigured() && isDiscussionShell(s.url) === 'hn-comments') {
        const comments = await fetchHnCommentText(s.url);
        if (comments) {
          s.summary = await summarizeComments({ title: s.title, comments });
          s.summaryLabel = 'Comment snapshot';
        }
      }
    } catch { /* leave the gap to the UI */ }
  }));
  // Exa briefs: one batched /contents call upgrades all shown Exa stories from
  // highlights to structured article summaries. Cached per URL+focus (they're
  // billed); any failure keeps the highlights already present.
  const exaTargets = stories.filter((s) => s?.provider === 'exa' && s.url && !s.brief);
  if (exaTargets.length && exaConfigured()) {
    const need = [];
    for (const s of exaTargets) {
      const hit = await cacheGet(`brief:v2:${focus}:${s.url}`, EXCERPT_CACHE_MS);
      if (hit !== undefined) {
        s.brief = hit;
        s.summaryLabel = 'Article summary';
      } else {
        need.push(s);
      }
    }
    if (need.length) {
      try {
        const briefs = await exaSummaries({ urls: need.map((s) => s.url), focus: focus || need[0].matchedInterest || '' });
        for (const s of need) {
          const b = briefs.get(s.url);
          if (b) {
            s.brief = b;
            s.summaryLabel = 'Article summary';
            await cacheSet(`brief:v2:${focus}:${s.url}`, b).catch(() => {});
          }
        }
      } catch { /* highlights stand in — briefs are an upgrade, not a requirement */ }
    }
  }
  return stories;
}
