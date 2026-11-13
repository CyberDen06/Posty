import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, cleanRedditContent, parseRedditFeed, interestMatch, titleSimilar, storyScore } from '../lib/providers.js';
import { generateDraft, matchesNeverPost, summaryHalf, draftMessages } from '../lib/drafts.js';
import { isDiscussionShell, parseHnComments } from '../lib/summaries.js';
import { transcribeWav, voiceConfigured } from '../lib/voice.js';
import { parseMultipart } from '../lib/util.js';
import { mapExaResults, exaConfigured, parseBrief, mapContentsBriefs, isMetaJunk, stripMetaPrefix } from '../lib/exa.js';

// The draft test pins template-engine behavior; never call a real LLM here.
delete process.env.LLM_API_KEY;
delete process.env.LLM_ENDPOINT;

test('decodeEntities handles named, decimal, and hex entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt;'), 'a & b <c>');
  assert.equal(decodeEntities('&#32;spaced&#32;'), ' spaced ');
  assert.equal(decodeEntities('&#x41;&#x42;'), 'AB');
  assert.equal(decodeEntities('&bogus;'), '&bogus;');
});

test('cleanRedditContent strips tags and rejects feed boilerplate', () => {
  assert.equal(cleanRedditContent('<p>Hello <b>world</b></p>'), 'Hello world');
  assert.equal(cleanRedditContent('&#32; submitted by &#32; /u/x [link] &#32; [comments]'), null);
  assert.equal(cleanRedditContent('   '), null);
  assert.equal(cleanRedditContent('Real post text here'), 'Real post text here');
});

test('parseRedditFeed extracts entries and skips incomplete ones', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>First post &amp; more</title><link href="https://www.reddit.com/r/x/comments/1/a/"/><updated>2026-11-10T09:00:00+00:00</updated><content type="html">Some &lt;b&gt;text&lt;/b&gt;</content></entry>
    <entry><title>Link post</title><link href="https://www.reddit.com/r/x/comments/2/b/"/><updated>2026-11-09T09:00:00+00:00</updated><content type="html">&#32; submitted by &#32; /u/y [link] &#32; [comments]</content></entry>
    <entry><title>No link here</title><updated>2026-11-09T09:00:00+00:00</updated></entry>
  </feed>`;
  const entries = parseRedditFeed(xml, 'x');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'First post & more');
  assert.equal(entries[0].content, 'Some text');
  assert.equal(entries[0].sub, 'x');
  assert.equal(entries[1].content, null); // boilerplate → unavailable, not noise
});

test('x-channel draft has no doubled punctuation and respects the limit', async () => {
  const story = { title: 'Example story', source: 'Example', date: null, url: 'https://example.com/s' };
  const d = await generateDraft({
    story, perspective: { text: 'Local-first tooling keeps winning.', reaction: 'I agree' },
    channel: 'x', tone: 'Direct', length: 'Concise', matchedInterest: 'tools', styleSamples: [],
  });
  assert.ok(!d.text.includes('..'), `doubled punctuation in: ${d.text}`);
  assert.ok(d.text.length <= 280, `over limit (${d.text.length}): ${d.text}`);
  assert.match(d.text, /setup cost|Local-first/);
});

test('neutral draft claims no personal experience', async () => {
  const story = { title: 'Example story about databases', source: 'Example', date: null, url: 'https://example.com/s' };
  for (const channel of ['linkedin', 'x', 'bluesky', 'mastodon', 'threads']) {
    const d = await generateDraft({
      story, perspective: { text: '', reaction: '' }, channel,
      tone: 'Thoughtful', length: 'Medium', matchedInterest: 'tools', styleSamples: [],
    });
    assert.ok(!/\b(I|my|me|we|our|I've|my own)\b/.test(d.text), `${channel} draft implies experience: ${d.text}`);
    assert.ok(d.influences.some((i) => i.includes('neutral draft')), `${channel} draft mislabels influences`);
  }
});

test('x thread format produces three bounded posts', async () => {
  const story = { title: 'Example story', source: 'Example', date: null, url: 'https://example.com/s' };
  const d = await generateDraft({
    story, perspective: { text: 'Takes worth sharing widely.', reaction: '' },
    channel: 'x', tone: 'Direct', length: 'Medium', matchedInterest: 'tools', styleSamples: [], format: 'thread',
  });
  assert.match(d.text, /1\/3/);
  assert.match(d.text, /2\/3/);
  assert.match(d.text, /3\/3/);
  for (const part of d.text.split('\n\n')) assert.ok(part.length <= 280, `thread post over limit: ${part}`);
});

test('matchesNeverPost blocks configured topics only', () => {
  assert.equal(matchesNeverPost('Our big client launch wins awards', ['client launch']), 'client launch');
  assert.equal(matchesNeverPost('A story about databases', ['client names']), null);
  assert.equal(matchesNeverPost('Anything', []), null);
});

test('discussion shells are classified for summary routing', () => {
  assert.equal(isDiscussionShell('https://news.ycombinator.com/item?id=123'), 'hn-comments');
  assert.equal(isDiscussionShell('https://www.reddit.com/r/x/comments/abc/title/'), 'reddit-shell');
  assert.equal(isDiscussionShell('https://example.com/article'), null);
  assert.equal(isDiscussionShell('not a url'), null);
});

test('titleSimilar collapses near-duplicate coverage but not distinct stories', () => {
  const base = 'OpenAI ships new coding agent';
  assert.ok(titleSimilar(base, 'OpenAI ships a new coding agent') >= 0.6, 'one-word variant should collapse');
  assert.ok(titleSimilar(base, 'OpenAI has shipped a new coding agent') >= 0.6, 'reworded coverage should collapse');
  assert.ok(titleSimilar(base, 'Garden watering tips for spring') < 0.3, 'distinct story must survive');
});

test('interestMatch prefers the most specific matching interest', () => {
  const m = interestMatch('LLM evaluation frameworks compared', ['LLMs', 'LLM evaluation']);
  assert.equal(m.interest, 'LLM evaluation');
  assert.equal(m.score, 1);
  assert.equal(interestMatch('Garden watering tips for spring', ['LLMs', 'RAG']).score, 0);
});

test('storyScore ranks fresh strong matches above stale ones; dateless scores zero', () => {
  const fresh = storyScore({ date: new Date().toISOString(), matchScore: 1 });
  const stale = storyScore({ date: new Date(Date.now() - 60 * 864e5).toISOString(), matchScore: 1 });
  assert.ok(fresh > 0.9, `fresh strong match should score near 1, got ${fresh}`);
  assert.ok(stale < 0.05, `60-day-old story should decay near 0, got ${stale}`);
  assert.equal(storyScore({ date: null, matchScore: 1 }), 0);
});

test('voice transcription rejects non-WAV audio without calling the network', async () => {
  process.env.LLM_API_KEY = 'test-key';
  try {
    assert.equal(voiceConfigured(), true);
    await assert.rejects(() => transcribeWav(Buffer.from('not audio at all........')), /Only WAV audio/);
    await assert.rejects(() => transcribeWav(Buffer.alloc(0)), /No audio was received/);
  } finally {
    delete process.env.LLM_API_KEY;
  }
});

test('voice transcription reports honest unconfigured state', async () => {
  assert.equal(voiceConfigured(), false);
  const wav = Buffer.concat([Buffer.from('RIFFxxxxWAVE'), Buffer.alloc(100)]);
  await assert.rejects(() => transcribeWav(wav), /not configured/);
});

test('parseMultipart extracts share-target fields and skips files', () => {
  const body = '--abc\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello\r\n'
    + '--abc\r\nContent-Disposition: form-data; name="url"\r\n\r\nhttps://example.com/x\r\n'
    + '--abc\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nBINARY\r\n'
    + '--abc--\r\n';
  const f = parseMultipart(Buffer.from(body), 'multipart/form-data; boundary=abc');
  assert.equal(f.title, 'Hello');
  assert.equal(f.url, 'https://example.com/x');
  assert.equal(f.file, undefined);
  assert.throws(() => parseMultipart(Buffer.from('x'), 'text/plain'), /boundary/);
});

test('mapExaResults shapes stories with highlight summaries, skips incomplete', () => {
  assert.equal(exaConfigured(), false); // no key in test env — provider stays off
  const out = mapExaResults([
    { title: 'Agents ship weekly', url: 'https://www.example.com/agents', publishedDate: '2026-11-10T00:00:00.000Z', author: 'J. Doe', highlights: ['Teams now ship agents weekly with evals.', 'ok'] },
    { title: 'No link here' },
    { title: 'Undated piece', url: 'https://example.com/undated', publishedDate: null, author: null, highlights: [] },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'example.com');
  assert.equal(out[0].author, 'J. Doe');
  assert.equal(out[0].provider, 'exa');
  assert.equal(out[0].summaryLabel, 'Search highlights');
  assert.match(out[0].summary, /ship agents weekly/);
  assert.ok(!out[0].summary.includes('ok'), 'one-word highlight must not leak in');
  assert.equal(out[1].date, null);
  assert.equal(out[1].summary, null); // missing stays missing — never invented
});

test('parseBrief accepts schema JSON, plain text, and drops null-ish lines', () => {
  const b = parseBrief(JSON.stringify({ tldr: 'Gist here.', keyPoints: ['Point one is substantive.', 'ok', 'null'], conclusion: 'null' }));
  assert.equal(b.tldr, 'Gist here.');
  assert.deepEqual(b.keyPoints, ['Point one is substantive.']);
  assert.equal(b.conclusion, '');
  assert.equal(parseBrief('not json but a real sentence here').tldr, 'not json but a real sentence here');
  assert.deepEqual(parseBrief('not json but a real sentence here').keyPoints, []);
  assert.equal(parseBrief(''), null);
  assert.equal(parseBrief(null), null);
});

test('mapContentsBriefs honors per-URL statuses', () => {
  const m = mapContentsBriefs(
    [
      { url: 'https://a.example/x', summary: JSON.stringify({ tldr: 'T.', keyPoints: ['K.'] }) },
      { url: 'https://b.example/y', summary: JSON.stringify({ tldr: 'T.', keyPoints: ['K.'] }) },
    ],
    [{ id: 'https://a.example/x', status: 'success' }, { id: 'https://b.example/y', status: 'error' }]
  );
  assert.equal(m.size, 1);
  assert.ok(m.has('https://a.example/x'));
});

test('meta-junk brief lines are detected and stripped, legit lines survive', () => {
  assert.equal(isMetaJunk('evidence/examples mentioned in text: "32-hour week," "fewer meetings"'), true);
  assert.equal(isMetaJunk('conclusion_patientNotes long form summaries and potential policy implications'), true);
  assert.equal(isMetaJunk('Evidence: teams ship faster with checklists'), true);
  assert.equal(isMetaJunk('Evidence shows teams ship faster with checklists'), false);
  assert.equal(isMetaJunk('Teams adopt four-day weeks for focus'), false);
  assert.equal(stripMetaPrefix('TL;DR: Markets rallied on the news.'), 'Markets rallied on the news.');
  assert.equal(stripMetaPrefix('No labels here at all.'), 'No labels here at all.');
  const b = parseBrief(JSON.stringify({
    tldr: 'Gist here.',
    keyPoints: ['Teams adopt four-day weeks for focus.', 'evidence/examples mentioned in text: "quote one"', 'conclusion_patientNotes filler words here'],
    conclusion: 'Bottom line here.',
  }));
  assert.deepEqual(b.keyPoints, ['Teams adopt four-day weeks for focus.']);
});

test('summaryHalf takes the gist plus half the points, bounded', () => {
  const story = { brief: { tldr: 'Gist.', keyPoints: ['P1 is substantive.', 'P2 is substantive.', 'P3 is substantive.', 'P4 is substantive.'], conclusion: '' } };
  const half = summaryHalf(story);
  assert.ok(half.includes('Gist.'));
  assert.ok(half.includes('P1 is substantive.') && half.includes('P2 is substantive.'));
  assert.ok(!half.includes('P3 is substantive.') && !half.includes('P4 is substantive.'));
  assert.equal(summaryHalf({}), '');
  assert.equal(summaryHalf({ summary: 'First sentence here. Second sentence here.' }), 'First sentence here.');
});

test('draftMessages weaves brief facts with the FULL take, neutrally without one', () => {
  const story = { title: 'T', source: 'S', url: 'https://example.com', brief: { tldr: 'Gist here.', keyPoints: ['Point one is here.', 'Point two is here.'], conclusion: '' } };
  const longTake = `My view: ${'word '.repeat(400)}end.`;
  assert.ok(longTake.length > 2000);
  const [sys, user] = draftMessages({ story, perspective: { text: longTake, reaction: '' }, channel: 'x', tone: 'Direct', length: 'Concise' });
  assert.ok(user.content.includes('Gist here.'), 'brief facts present');
  assert.ok(user.content.includes('end.'), 'full take present, never truncated');
  assert.ok(sys.content.includes('200 characters'), 'channel limit present');
  const [, neutral] = draftMessages({ story, perspective: { text: '', reaction: '' }, channel: 'x', tone: 'Direct', length: 'Concise' });
  assert.ok(neutral.content.includes('write neutrally'));
});

test('parseHnComments extracts substantive comments only', () => {
  const html = '<div class="commtext c00">This is a substantive comment with more than forty characters of text.</div>'
    + '<div class="commtext c00">Too short</div>'
    + '<div class="other">Not a comment but long enough to pass a naive length check here.</div>';
  const out = parseHnComments(html);
  assert.equal(out.length, 1);
  assert.match(out[0], /substantive comment/);
});
