// Style learning: opt-in, inspectable, clearable. Records only aggregate
// SHAPE features of drafts the user kept (approved/scheduled) vs passed on
// (skipped/deleted) — lengths, opener phrases, per-channel keep rates. No
// story facts, no private text, no opinions are ever stored here, and nothing
// is recorded unless prefs.learnFromUse is on. Personalization only nudges
// length + opener style after MIN_SIGNAL kept drafts; it never invents
// experiences, anecdotes, or claims.

export const MIN_SIGNAL = 3;
export const OUTCOMES = ['approved', 'scheduled', 'skipped', 'deleted'];
const MAX_LENGTH_SAMPLES = 30;
const MAX_OPENER_KEYS = 20;

export function defaultProfile() {
  return {
    version: 1,
    counts: { approved: 0, scheduled: 0, skipped: 0, deleted: 0 },
    keptCharsWeighted: 0, // Σ finalChars × weight over kept drafts
    keptWeight: 0, // Σ weights (weight falls as the user rewrites more)
    openers: {}, // opener 4-gram → accumulated weight
    channels: {}, // channel id → { kept, skipped }
    updatedAt: null,
  };
}

function firstLine(text) {
  return String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)[0] || '';
}

// Observable shape features of one draft text. Exported for tests.
export function featuresOf(text) {
  const t = String(text || '');
  const opener = firstLine(t).split(/\s+/).slice(0, 4).join(' ').toLowerCase().slice(0, 60);
  return {
    chars: t.length,
    sentences: t.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length,
    opener,
    hasQuestion: /\?/.test(t),
    hashtags: (t.match(/#[\p{L}\p{N}_]+/gu) || []).length,
  };
}

// Word-set Jaccard similarity 0..1: how much of the generated draft survived
// the user's edits. Heavy rewrites still count, but teach less.
export function similarity(a, b) {
  const words = (t) => new Set(String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

function pruneOpeners(openers) {
  const keys = Object.keys(openers);
  if (keys.length <= MAX_OPENER_KEYS) return;
  keys.sort((a, b) => openers[a] - openers[b]);
  for (const k of keys.slice(0, keys.length - MAX_OPENER_KEYS)) delete openers[k];
}

// Records one outcome. Kept drafts (approved/scheduled) teach length + opener
// style from the FINAL text (the user's approved words); skipped/deleted ones
// only adjust per-channel keep rates. Mutates and returns the profile.
export function recordOutcome(profile, { outcome, generatedText = '', finalText = '', channel = '' } = {}) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`unknown learning outcome: ${outcome}`);
  const p = profile && typeof profile === 'object' ? profile : defaultProfile();
  p.counts = { ...defaultProfile().counts, ...(p.counts || {}) };
  p.openers = p.openers || {};
  p.channels = p.channels || {};
  p.counts[outcome] += 1;
  const kept = outcome === 'approved' || outcome === 'scheduled';
  if (channel) {
    const c = p.channels[channel] || { kept: 0, skipped: 0 };
    if (kept) c.kept += 1;
    else c.skipped += 1;
    p.channels[channel] = c;
  }
  if (kept && finalText) {
    const f = featuresOf(finalText);
    const weight = 0.5 + 0.5 * similarity(generatedText || finalText, finalText);
    p.keptCharsWeighted = (p.keptCharsWeighted || 0) + f.chars * weight;
    p.keptWeight = Math.min(MAX_LENGTH_SAMPLES, (p.keptWeight || 0) + weight);
    if (f.opener) {
      p.openers[f.opener] = Math.round(((p.openers[f.opener] || 0) + weight) * 10) / 10;
      pruneOpeners(p.openers);
    }
  }
  p.updatedAt = new Date().toISOString();
  return p;
}

export function keptCount(profile) {
  return (profile?.counts?.approved || 0) + (profile?.counts?.scheduled || 0);
}

// Personalization stays off until the user has kept enough drafts to teach from.
export function ready(profile) {
  return keptCount(profile) >= MIN_SIGNAL;
}

export function preferredChars(profile) {
  if (!profile?.keptWeight) return null;
  return Math.round(profile.keptCharsWeighted / profile.keptWeight);
}

export function topOpeners(profile, n = 3) {
  return Object.entries(profile?.openers || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([opener, weight]) => ({ opener, weight }));
}

// Extra system-prompt lines for generation. Length + opener nudges only —
// never claims about the user's beliefs or history.
export function personalizeLines(profile) {
  if (!ready(profile)) return [];
  const lines = [];
  const chars = preferredChars(profile);
  if (chars) lines.push(`Length hint: the user usually approves posts near ${chars} characters — aim close to that within the channel limit.`);
  const [top] = topOpeners(profile, 1);
  if (top && top.weight >= 2) {
    lines.push(`Opening hint: the user often approves posts opening like “${top.opener}…” — a similar plain opening is welcome, but never copy it verbatim.`);
  }
  return lines;
}

// Inspectable summary for the Settings panel. Rounded, no raw text beyond
// opener fragments (the user's own approved words).
export function summary(profile) {
  const p = profile && typeof profile === 'object' ? profile : defaultProfile();
  return {
    counts: { ...defaultProfile().counts, ...(p.counts || {}) },
    kept: keptCount(p),
    ready: ready(p),
    needed: Math.max(0, MIN_SIGNAL - keptCount(p)),
    preferredChars: preferredChars(p),
    topOpeners: topOpeners(p),
    channels: p.channels || {},
    updatedAt: p.updatedAt || null,
  };
}
