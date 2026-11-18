import test from 'node:test';
import assert from 'node:assert/strict';

// Force the template path: no network, deterministic output.
delete process.env.LLM_API_KEY;
delete process.env.LLM_ENDPOINT;

const { generateDraft, generateVariant, draftMessages, summaryHalf } = await import('../lib/drafts.js');

const story = {
  title: 'Small teams ship faster with written decisions',
  url: 'https://example.com/decisions',
  date: '2026-11-01T00:00:00Z',
  source: 'Example News',
  brief: { tldr: 'Writing decisions down speeds small teams up.', keyPoints: ['Five-minute decision logs cut repeat debates.', 'Written context onboards newcomers faster.'], conclusion: 'Expect wider adoption.' },
};
const perspective = { text: 'We tried this and our standups got shorter.', reaction: 'I agree' };

test('style samples do not crash drafting and mirror a repeated opener', async () => {
  const samples = ['Frankly I prefer written decisions over meetings. They stick around and onboard newcomers.', 'Frankly I prefer written notes to long threads. They force clarity and save review time.'];
  const g = await generateDraft({ story, perspective, channel: 'linkedin', tone: 'Direct', length: 'Medium', matchedInterest: 'teams', styleSamples: samples });
  assert.equal(g.engine, 'template');
  assert.match(g.text, /^Frankly I prefer/);
  assert.ok(g.influences.includes('your style reference(s)'));
});

test('learning target shortens drafts and labels the influence', async () => {
  const base = await generateDraft({ story, perspective, channel: 'linkedin', tone: 'Thoughtful', length: 'Medium', matchedInterest: 'teams' });
  const tuned = await generateDraft({ story, perspective, channel: 'linkedin', tone: 'Thoughtful', length: 'Medium', matchedInterest: 'teams', learning: { lines: ['Length hint: near 200 characters.'], targetChars: 200 } });
  assert.ok(tuned.text.length < base.text.length, `tuned (${tuned.text.length}) should be shorter than base (${base.text.length})`);
  assert.ok(tuned.influences.includes('tuned to your approvals'));
  assert.ok(!base.influences.includes('tuned to your approvals'));
});

test('learning lines reach the LLM prompt without touching the no-invention rules', () => {
  const [system, user] = draftMessages({ story, perspective, channel: 'x', tone: 'Direct', length: 'Concise', learningLines: ['Length hint: near 200 characters.'] });
  assert.match(system.content, /never invent the user's opinions/);
  assert.match(system.content, /near 200 characters/);
  assert.match(user.content, /standups got shorter/); // full take still woven in
  assert.equal(summaryHalf(story).includes('Written context onboards newcomers faster.'), false); // ~half the brief
  assert.match(summaryHalf(story), /Writing decisions down speeds small teams up/);
});

test('variants differ in phrasing but keep the same facts', async () => {
  const input = { story, perspective, channel: 'x', tone: 'Direct', length: 'Medium', matchedInterest: 'teams' };
  const base = await generateDraft(input);
  const alt = await generateVariant(input);
  assert.notEqual(alt.text, base.text);
  assert.ok(alt.influences.includes('alternative phrasing'));
  assert.match(alt.text, /standups got shorter/); // take preserved
  assert.match(alt.text, /Small teams ship faster/); // story preserved
  const [, user] = draftMessages({ ...input, variant: true });
  assert.match(user.content, /standups got shorter/);
});

test('thread variants reorder posts with corrected numbering', async () => {
  const input = { story, perspective, channel: 'x', tone: 'Direct', length: 'Medium', matchedInterest: 'teams', format: 'thread' };
  const base = await generateDraft(input);
  const alt = await generateVariant(input);
  assert.notEqual(alt.text, base.text);
  assert.match(alt.text, /^1\/3 /m);
  assert.match(alt.text, /^2\/3 /m);
  assert.match(alt.text, /^3\/3 /m);
});
