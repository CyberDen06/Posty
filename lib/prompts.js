import { PERSPECTIVE_PROMPTS, CAPTURE_PROMPTS } from './professions.js';

// Grounded "what's your take?" questions: specific to the story or capture in
// front of the user, so answering them produces a substantial perspective to
// draft from. Generic lists remain the instant/fallback rendering.

// Flatten a story brief (string or { tldr, keyPoints, conclusion }) to text.
export function flattenBrief(brief) {
  if (!brief) return '';
  if (typeof brief === 'string') return brief;
  if (Array.isArray(brief)) return brief.filter((x) => typeof x === 'string').join('\n');
  const parts = [];
  if (typeof brief.tldr === 'string' && brief.tldr) parts.push(brief.tldr);
  if (Array.isArray(brief.keyPoints)) parts.push(...brief.keyPoints.filter((x) => typeof x === 'string'));
  if (typeof brief.conclusion === 'string' && brief.conclusion) parts.push(brief.conclusion);
  return parts.join('\n');
}

export function genericPrompts(isStory) {
  return isStory ? [...PERSPECTIVE_PROMPTS] : [...CAPTURE_PROMPTS];
}

// Pure message builder (kept separate so tests pin the grounding contract).
export function takeQuestionMessages({ title, body, source, profession, interest, isStory }) {
  const system = [
    'You write discussion questions that help a busy professional articulate their own take on the material below.',
    'Rules: ask ONLY about people, claims, events, or ideas explicitly present in the material — never introduce new facts, names, numbers, or claims.',
    'Each question must name something specific from the material, never "this topic" or "this article".',
    `Aim at drawing out the reader's own experience, agreement or disagreement, and practical implications for their work as a ${profession || 'professional'}.`,
    'Output exactly 3 questions, one per line. No numbering, no bullets, no preamble, no commentary.',
  ].join(' ');
  const user = [
    `${isStory ? 'Headline' : 'Note'}: ${title || 'Untitled'}`,
    source ? `Source: ${source}` : '',
    interest ? `Reader interest: ${interest}` : '',
    '',
    'Material:',
    String(body || '').slice(0, 2500) || '(no further text available)',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Tolerant parse of the 3-question response → string[] (may be short/empty).
export function parseQuestions(text) {
  if (!text || typeof text !== 'string') return [];
  let raw = text.replace(/```(?:json)?/gi, '').trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) raw = parsed.filter((x) => typeof x === 'string').join('\n');
  } catch { /* not JSON — treat as lines */ }
  const seen = new Set();
  const out = [];
  for (let line of raw.split('\n')) {
    line = line
      .trim()
      .replace(/^(\d+[.)\]]|[-*•])\s*/, '')
      .replace(/^["“”]+|["“”]+$/g, '')
      .trim();
    if (line.length < 20 || line.length > 240 || !line.endsWith('?')) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= 3) break;
  }
  return out;
}
