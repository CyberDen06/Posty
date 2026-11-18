// Onboarding track: a first-run checklist DERIVED from live workspace state
// (nothing stored except the dismiss flag), so it can never go stale or
// contradict the app. Demo and dismissed items never count as progress.

export function stepsOf({ prefs, connected, routine, counts = {} } = {}) {
  const steps = [
    { id: 'profile', label: 'Set your profession and interests', href: '#/settings', done: prefs?.setupDone === true },
    { id: 'find', label: 'Find your first stories', href: '#/today', done: (counts.stories || 0) > 0 },
    { id: 'capture', label: 'Save an idea or brain dump', href: '#/ideas', done: (counts.captures || 0) > 0 },
    { id: 'take', label: 'Add your take to a story or idea', href: '#/today', done: (counts.withTake || 0) > 0 },
    { id: 'drafts', label: 'Review and refine channel drafts', href: '#/drafts', done: (counts.drafts || 0) > 0 },
    { id: 'schedule', label: 'Approve and schedule a post', href: '#/drafts', done: (counts.scheduled || 0) > 0 },
    { id: 'routine', label: 'Set up and run your content routine', href: '#/routine', done: (routine?.runs || 0) > 0 },
    { id: 'buffer', label: 'Connect Buffer for real scheduling', href: '#/sources', done: connected === true },
  ];
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, next: steps.find((s) => !s.done) || null, complete: done === steps.length };
}
