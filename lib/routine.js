import { DRAFT_CHANNELS } from './professions.js';
import { searchStories } from './providers.js';
import { generateDraft } from './drafts.js';
import { randId } from './util.js';

// User-configured content routine. Settings + "Run routine now" only: there is
// no background scheduler in this build, and the UI says so. A run finds a
// small bounded set of fresh stories and prepares NEUTRAL draft suggestions
// (the user has expressed no take at routine time, so no opinion is implied).
// Runs never schedule or publish anything.

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function defaultRoutine() {
  return { interests: [], cadence: 'weekly', paused: false, channels: ['linkedin', 'x'], deliveryDay: 'Monday', deliveryTime: '09:00', batchSize: 2, lastRunAt: null, lastResult: null, runs: 0 };
}

export function normalizeRoutine(input = {}, savedInterests = []) {
  const r = defaultRoutine();
  const ids = new Set(DRAFT_CHANNELS.map((c) => c.id));
  if (Array.isArray(input.interests)) {
    const saved = new Set(savedInterests);
    r.interests = [...new Set(input.interests.map((s) => String(s).trim()).filter(Boolean))]
      .filter((s) => saved.size === 0 || saved.has(s))
      .slice(0, 10);
  }
  if (input.cadence === 'weekly') r.cadence = 'weekly';
  r.paused = input.paused === true;
  if (Array.isArray(input.channels)) {
    const chans = [...new Set(input.channels)].filter((c) => ids.has(c)).slice(0, 3);
    if (chans.length) r.channels = chans;
  }
  if (WEEKDAYS.includes(input.deliveryDay)) r.deliveryDay = input.deliveryDay;
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.deliveryTime || ''))) r.deliveryTime = input.deliveryTime;
  const batch = Number(input.batchSize);
  if (Number.isInteger(batch) && batch >= 1 && batch <= 4) r.batchSize = batch;
  return r;
}

export function makeDraft({ story, channel, tone, length, matchedInterest, perspective = {}, styleSamples = [], format = 'post', pillar = '', learning = null }) {
  return generateDraft({ story, perspective, channel, tone, length, matchedInterest, styleSamples, format, learning }).then((g) => ({
    id: `d_${randId(8)}`,
    channel,
    tone,
    length,
    format: channel === 'x' ? format : 'post',
    pillar: String(pillar || '').slice(0, 60),
    text: g.text,
    generatedText: g.text, // as-generated snapshot: learning compares it with the approved text
    influences: g.influences,
    engine: g.engine,
    warning: g.warning || null,
    status: 'suggested',
    origin: perspective.text || perspective.reaction ? 'refined' : 'initial',
    perspective: { text: perspective.text || '', reaction: perspective.reaction || '' },
    history: [],
    plannedDate: null,
    feedback: null,
    schedule: null,
    confirmToken: null,
    idempotencyKey: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

// Push the current text before replacing it so user work is never silently lost.
export function pushHistory(draft, label) {
  draft.history = draft.history || [];
  draft.history.push({ text: draft.text, at: new Date().toISOString(), label: String(label || 'previous version').slice(0, 80) });
  draft.history = draft.history.slice(-5);
}

export async function runRoutine({ prefs, routine, excludeUrls, styleSamples, learning = null }) {
  if (routine.paused) {
    const err = new Error('Routine is paused — resume it to run');
    err.status = 409;
    throw err;
  }
  if (!routine.interests.length) {
    const err = new Error('Select at least one interest for the routine first');
    err.status = 400;
    throw err;
  }
  const { stories, warnings } = await searchStories({
    interests: routine.interests, profession: prefs.profession, excludeUrls,
    maxTotal: routine.batchSize, disabledProviders: prefs.disabledProviders,
  });
  const items = [];
  for (const story of stories) {
    // Routine keeps pre-generation (explicit briefing runs): channels in parallel.
    const drafts = await Promise.all(routine.channels.map((channel) => makeDraft({
      story, channel, tone: prefs.tone, length: prefs.length,
      matchedInterest: story.matchedInterest, perspective: {}, styleSamples, learning,
    })));
    items.push({
      id: `s_${randId(8)}`,
      kind: 'story',
      story,
      origin: 'routine',
      perspective: { text: '', reaction: '' },
      drafts,
      dismissed: false,
      saved: false,
      demo: false,
      createdAt: new Date().toISOString(),
    });
  }
  return { items, warnings };
}
