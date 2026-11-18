import { llmChat, llmConfigured } from './llm.js';

// Draft engine. Default: built-in templates — no external calls, and nothing
// is ever invented: drafts are composed only from the story (headline, source,
// date, link), the user's own take/reaction, and generic framing phrases.
// Optional: when LLM_* env vars are set, an OpenAI-compatible endpoint may
// generate the draft under a strict no-invention system prompt, with template
// fallback on any failure.

const OPENERS = {
  Thoughtful: ['Something worth sitting with:', 'A development I’m thinking through:', 'Worth a careful read:'],
  Direct: ['Worth your attention:', 'Here’s a development to watch:', 'Don’t miss this:'],
  Conversational: ['Been thinking about this one:', 'This caught my eye today:', 'Sharing something I found interesting:'],
};

const NEUTRAL_FRAMES = [
  'Worth watching for anyone following this space.',
  'One to keep on the radar.',
  'Early days, but the direction is worth noting.',
];

const CLOSERS = {
  Thoughtful: 'Curious how others are thinking about this.',
  Direct: 'Keep an eye on it.',
  Conversational: 'Would love to hear your take.',
};

const LIMITS = {
  x: { Concise: 200, Medium: 280 },
  bluesky: { Concise: 200, Medium: 300 },
  mastodon: { Concise: 300, Medium: 500 },
  threads: { Concise: 250, Medium: 500 },
  linkedin: { Concise: 600, Medium: 1300 },
};

function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function fitTo(text, url, limit) {
  const tail = url ? `\n\n${url}` : '';
  if (text.length + tail.length <= limit) return text + tail;
  const room = Math.max(40, limit - tail.length - 1);
  let cut = text.slice(0, room);
  const lastEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (lastEnd > room * 0.4) cut = cut.slice(0, lastEnd + 1);
  else {
    const lastSpace = cut.lastIndexOf(' ');
    cut = (lastSpace > room * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:!?]+$/, '') + '…';
  }
  return cut + tail;
}

function hashtags(interest, n = 3) {
  return String(interest || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2).slice(0, n).map((w) => `#${w}`).join(' ');
}

// Optional style mirroring from USER-SUPPLIED writing samples only (opt-in,
// user-controlled; never automatic voice cloning). Reuses the user's own
// openings and typical length. Returns { opener, targetChars }.
function mirrorStyle(styleSamples) {
  if (!styleSamples.length) return { opener: null, targetChars: null };
  const openers = styleSamples.map((s) => sentences(s)[0]).filter((s) => s && s.length < 140);
  const counts = new Map();
  for (const o of openers) {
    const key = o.split(/\s+/).slice(0, 4).join(' ').toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let opener = null;
  for (const [key, n] of counts) {
    if (n >= 2) {
      opener = openers.find((o) => o.toLowerCase().startsWith(key));
      break;
    }
  }
  const lens = styleSamples.map((s) => s.length).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)];
  return { opener, targetChars: median || null };
}

function storyLine(story) {
  return `“${story.title}” (via ${story.source || 'unknown source'})`;
}

function composeTemplate({ story, perspective, channel, tone, length, matchedInterest, styleSamples = [], format = 'post', learningTargetChars = null, variant = false }) {
  const take = (perspective?.text || '').trim();
  const reaction = (perspective?.reaction || '').trim();
  const hasTake = Boolean(take || reaction);
  const voice = mirrorStyle(styleSamples);
  const bank = OPENERS[tone] || OPENERS.Thoughtful;
  const closer = CLOSERS[tone] || CLOSERS.Thoughtful;
  if (channel === 'x' && format === 'thread') return composeThread({ story, take, reaction, tone, length, variant });
  const opener = voice.opener || bank[(story.title.length + (variant ? 1 : 0)) % bank.length];

  const takeBlock = [reaction ? `${reaction}.` : '', take].filter(Boolean).join(' ');
  const takeSentence = takeBlock.replace(/[.\s]+$/, '');
  const medium = length === 'Medium';
  const limit = LIMITS[channel]?.[length] || 500;
  let body;

  if (!hasTake) {
    const frame = NEUTRAL_FRAMES[story.title.length % NEUTRAL_FRAMES.length];
    if (channel === 'linkedin') {
      body = medium
        ? `${opener}\n\n${storyLine(story)}.\n\n${frame} ${story.why || ''}`.trim()
        : `${opener} ${storyLine(story)} — ${frame}`;
    } else {
      body = `${storyLine(story)}.\n\n${frame}`;
    }
  } else if (channel === 'linkedin') {
    body = medium
      ? `${opener}\n\n${storyLine(story)}.\n\n${takeBlock}\n\n${closer}`
      : `${opener} ${storyLine(story)}.\n\n${takeBlock}`;
  } else if (channel === 'x' || channel === 'bluesky') {
    body = (variant && takeSentence) ? `${story.title}. ${takeSentence}.` : (medium ? `${takeSentence}. ${story.title}.` : `${takeSentence || story.title}.`);
  } else if (channel === 'mastodon') {
    const tags = hashtags(matchedInterest);
    body = `${takeSentence || 'Noted'}. ${story.title}.${tags ? `\n\n${tags}` : ''}`;
  } else {
    body = `${takeSentence}. ${story.title}.`;
  }

  let target = limit;
  const learnedChars = Number.isInteger(learningTargetChars) && learningTargetChars > 0 ? learningTargetChars : null;
  if (learnedChars && learnedChars < target) target = Math.max(120, Math.min(limit, learnedChars + (story.url?.length || 0) + 4));
  if (voice.targetChars && (!LIMITS[channel] || voice.targetChars < limit)) {
    target = Math.max(120, Math.min(limit, voice.targetChars + (story.url?.length || 0) + 4));
  }
  const text = fitTo(body.replace(/\n{3,}/g, '\n\n').trim(), story.url, target);

  const influences = [`tone: ${tone}`, `length: ${length}`];
  if (reaction) influences.push(`your reaction (“${reaction}”)`);
  if (take) influences.push('your take, in your words');
  if (!hasTake) influences.push('neutral draft — no take given, no opinion implied');
  if (styleSamples.length) influences.push('your style reference(s)');
  if (variant) influences.push('alternative phrasing');
  if (learnedChars) influences.push('tuned to your approvals');
  return { text, influences, engine: 'template' };
}

function truncateWords(text, limit) {
  const t = String(text).trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit - 1);
  const sp = cut.lastIndexOf(' ');
  return `${sp > limit * 0.5 ? cut.slice(0, sp) : cut}…`;
}

// Short X thread: hook → substance → source. Each post fits 280 chars.
function composeThread({ story, take, reaction, tone, length, variant = false }) {
  const clean = [reaction ? `${reaction}.` : '', take].filter(Boolean).join(' ').replace(/[.\s]+$/, '');
  const frame = NEUTRAL_FRAMES[story.title.length % NEUTRAL_FRAMES.length];
  let p1;
  let p2;
  if (clean) {
    p1 = `1/3 ${clean}.`;
    p2 = `2/3 ${story.title}.`;
  } else {
    p1 = `1/3 ${story.title}.`;
    p2 = `2/3 ${frame}`;
  }
  const p3 = fitTo(`3/3 ${storyLine(story)}.`, story.url, 280);
  const influences = ['thread format', `tone: ${tone}`, `length: ${length}`, ...(variant ? ['alternative phrasing'] : [])];
  if (clean) influences.push('your take, in your words');
  else influences.push('neutral draft — no take given, no opinion implied');
  const posts = variant ? [p2.replace(/^2\/3/, '1/3'), p1.replace(/^1\/3/, '2/3'), p3] : [p1, p2, p3];
  return { text: posts.map((t) => truncateWords(t, 280)).join('\n\n'), influences, engine: 'template' };
}

// Topics the user never wants to post about. Returns the matched topic or null.
export function matchesNeverPost(text, neverPost = []) {
  const hay = String(text || '').toLowerCase();
  for (const topic of neverPost) {
    const words = String(topic).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    if (words.length && words.every((w) => hay.includes(w))) return topic;
  }
  return null;
}

// Half the article brief for draft grounding: TL;DR plus the first half of the
// key points (or the first half of a plain summary's sentences). Bounded for quota.
export function summaryHalf(story) {
  const b = story?.brief;
  if (b && (b.tldr || (b.keyPoints || []).length)) {
    const pts = (b.keyPoints || []).filter((p) => p && p.length > 3);
    const half = pts.slice(0, Math.max(1, Math.ceil(pts.length / 2)));
    return [b.tldr, ...half.map((p) => `- ${p}`)].filter(Boolean).join('\n').slice(0, 1200);
  }
  const sents = sentences(story?.summary || '');
  if (!sents.length) return '';
  return sents.slice(0, Math.max(1, Math.ceil(sents.length / 2))).join(' ').slice(0, 1200);
}

// Prompt builder, exported for tests: the draft weaves ~half the article brief
// with the user's FULL take (never truncated), ready for further refinement.
export function draftMessages({ story, perspective, channel, tone, length, learningLines = [], variant = false }) {
  const take = (perspective?.text || '').trim();
  const reaction = (perspective?.reaction || '').trim();
  const limit = LIMITS[channel]?.[length] || 500;
  const half = summaryHalf(story);
  const system = `You draft social media posts. Hard rules: never invent the user's opinions, experiences, anecdotes, dates, sources, or metrics. Reconstruct the draft from the article brief and the user's take below: weave roughly half the brief's facts with the user's FULL take, in their voice. If no take is given, write a neutral factual note drawing on the brief about why the development may be worth watching, implying no opinion. The ENTIRE post including the URL line must fit in ${limit} characters — count carefully and shorten rather than overflow. Output ONLY the post text, ending with the story URL on its own line.${(learningLines.length ? ` ${learningLines.join(' ')}` : '') + (variant ? ' Offer a distinctly different phrasing from the obvious first draft — same facts, fresh structure.' : '')}`;
  const user = `Channel: ${channel}. Tone: ${tone}. Length: ${length}.\nStory: "${story.title}" (via ${story.source || 'unknown source'}${story.date ? `, ${story.date}` : ''}).\nURL: ${story.url}\nArticle brief (ground the draft in these facts):\n${half || '(none — use the headline only)'}\nUser reaction: ${reaction || '(none)'}\nUser take (weave in FULLY, in their voice):\n${take || '(none — write neutrally)'}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

async function composeLlm(input) {
  if (!llmConfigured()) return null;
  return llmChat(draftMessages({ ...input, learningLines: input.learning?.lines || [] }), { maxTokens: 4000, temperature: input.variant ? 0.9 : 0.4, purpose: input.variant ? 'variant' : 'draft' });
}

export function generateVariant(input) {
  return generateDraft({ ...input, variant: true });
}

export async function generateDraft(input) {
  const template = composeTemplate({ styleSamples: [], format: 'post', ...input, learningTargetChars: input.learning?.targetChars ?? null });
  if (!llmConfigured()) return template;
  try {
    const text = await composeLlm(input);
    if (!text) return template;
    const influences = summaryHalf(input.story) ? [...template.influences, 'article brief facts'] : template.influences;
    return { ...template, text, influences, engine: 'llm' };
  } catch (err) {
    return { ...template, warning: `LLM drafting failed (${err.message}); used the built-in template instead.` };
  }
}

// Template refinement: small honest text operations, labeled in `note`.
export function refineDraft({ text, instruction, channel, length }) {
  const want = String(instruction || '').toLowerCase();
  const urlMatch = String(text).match(/https?:\/\/\S+\s*$/);
  const url = urlMatch ? urlMatch[0].trim() : '';
  const core = String(text).replace(/https?:\/\/\S+\s*$/, '').trim();
  const limit = LIMITS[channel]?.[length] || 500;
  let out = core;
  let note = 'Tidied whitespace only.';
  if (/shorter|concise|tighten/.test(want)) {
    out = sentences(core).slice(0, 2).join(' ');
    note = 'Shortened to the first two sentences.';
  } else if (/longer|expand|detail/.test(want)) {
    out = `${core}\n\n${CLOSERS.Thoughtful}`;
    note = 'Expanded with a closing line (no new claims added).';
  } else if (/punch|direct|bold/.test(want)) {
    out = core.replace(/^.+?[.!?\n]/, `${OPENERS.Direct[0]} `).trim();
    if (out === core) out = `${OPENERS.Direct[0]} ${core}`;
    note = 'Swapped in a direct opening line.';
  } else if (/rephrase|reword|hook|opener/.test(want)) {
    const s = sentences(core);
    s[0] = OPENERS.Conversational[core.length % OPENERS.Conversational.length];
    out = s.join(' ');
    note = 'Replaced the opening line.';
  }
  return { text: fitTo(out, url, limit), note, engine: 'template' };
}
