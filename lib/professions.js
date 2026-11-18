// Profession → suggested interest starting points (editable, not claims).
export const PROFESSIONS = {
  'Software Engineer': ['AI coding agents', 'developer tools', 'developer productivity', 'software architecture', 'open source', 'security', 'engineering teams', 'build-in-public'],
  Founder: ['growth metrics', 'product-market fit', 'fundraising', 'bootstrapping', 'startup operations', 'lessons from setbacks'],
  'Product Manager': ['roadmaps', 'prioritization', 'user feedback', 'product strategy', "AI's impact on product work"],
  Designer: ['UI/UX principles', 'design systems', 'Figma workflows', 'accessibility', 'AI-generated design'],
  Marketer: ['campaign breakdowns', 'growth tactics', 'funnels', 'content strategy', 'AI marketing tools'],
  'Data/AI Professional': ['LLMs', 'RAG', 'machine-learning fundamentals', 'AI adoption', 'evaluation', 'ethics'],
  Consultant: ['professional frameworks', 'anonymized case studies', 'industry patterns', 'client problem-solving'],
};

export const PERSPECTIVE_PROMPTS = [
  'What have you noticed in your work?',
  'Where do you agree or disagree?',
  'What would you add from your experience?',
];

export const QUICK_REACTIONS = ['I agree', "I'm skeptical", 'This could be useful'];

export const CAPTURE_PROMPTS = [
  'What did you notice?',
  'Have you tried something similar?',
  'What would you add or challenge?',
  'What practical lesson would you share?',
  'Is there a real example you want to include?',
];

export const TONES = ['Thoughtful', 'Direct', 'Conversational'];
export const LENGTHS = ['Concise', 'Medium'];

// Draft channels: formatting targets for generated drafts. Distinct from the
// user's connected Buffer channels, which are chosen at scheduling time.
export const DRAFT_CHANNELS = [
  { id: 'linkedin', label: 'LinkedIn', hint: 'Professional, generous line breaks, ends with an invitation to discuss.' },
  { id: 'x', label: 'X', hint: 'One punchy post, hook first. Concise ≤ 200 chars, Medium ≤ 280 chars.' },
  { id: 'bluesky', label: 'Bluesky', hint: 'Conversational and plain-spoken. Concise ≤ 200 chars, Medium ≤ 300 chars.' },
  { id: 'mastodon', label: 'Mastodon', hint: 'Friendly, a few topic hashtags. Concise ≤ 300 chars, Medium ≤ 500 chars.' },
  { id: 'threads', label: 'Threads', hint: 'Casual and direct. Concise ≤ 250 chars, Medium ≤ 500 chars.' },
];

export const PILLARS = ['lessons learned', 'practical tips', 'frameworks', 'questions', 'build-in-public updates', 'industry analysis'];

export function defaultPreferences() {
  return {
    profession: '', interests: [], tone: 'Thoughtful', length: 'Medium', setupDone: false,
    pillars: [], preferredChannels: ['linkedin', 'x'], neverPost: [],
    styleSamples: [], styleNotes: '', useStyleRefs: false,
    disabledProviders: [], cadenceTarget: 3, learnFromUse: false,
  };
}

function strList(input, max, len) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((s) => String(s).trim()).filter(Boolean))].slice(0, max).map((s) => s.slice(0, len));
}

export function normalizePreferences(input = {}) {
  const prefs = defaultPreferences();
  if (typeof input.profession === 'string' && PROFESSIONS[input.profession]) prefs.profession = input.profession;
  else if (typeof input.profession === 'string' && input.profession.trim()) prefs.profession = input.profession.trim().slice(0, 80);
  prefs.interests = strList(input.interests, 20, 80);
  if (TONES.includes(input.tone)) prefs.tone = input.tone;
  else if (typeof input.tone === 'string' && input.tone.trim()) prefs.tone = input.tone.trim().slice(0, 40); // extensible
  if (LENGTHS.includes(input.length)) prefs.length = input.length;
  prefs.pillars = strList(input.pillars, 10, 60);
  const ids = new Set(DRAFT_CHANNELS.map((c) => c.id));
  const chans = strList(input.preferredChannels, 5, 20).filter((c) => ids.has(c));
  if (chans.length) prefs.preferredChannels = chans;
  prefs.neverPost = strList(input.neverPost, 10, 80);
  prefs.styleSamples = strList(input.styleSamples, 5, 1000);
  prefs.styleNotes = typeof input.styleNotes === 'string' ? input.styleNotes.slice(0, 1000) : '';
  prefs.useStyleRefs = input.useStyleRefs === true && prefs.styleSamples.length > 0;
  prefs.disabledProviders = strList(input.disabledProviders, 5, 20).filter((p) => ['hn', 'gdelt', 'reddit', 'exa'].includes(p));
  prefs.learnFromUse = input.learnFromUse === true;
  const cad = Number(input.cadenceTarget);
  if (Number.isInteger(cad) && cad >= 0 && cad <= 21) prefs.cadenceTarget = cad;
  prefs.setupDone = prefs.profession !== '' && prefs.interests.length > 0;
  return prefs;
}
