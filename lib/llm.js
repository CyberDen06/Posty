import { fetchJson } from './util.js';
import { cacheGet, cacheSet } from './store.js';

// Single LLM boundary (Muse via OpenAI-compatible chat completions).
// Used ONLY for: (1) channel drafts from story facts + the user's own take,
// (2) comment snapshots grounded in fetched discussion text,
// (3) take-questions grounded in the story/capture being viewed. The model
// never receives invented material and is instructed never to invent any.

export function llmConfigured() {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_ENDPOINT);
}

// Per-call usage log + daily counters, so quota spend is visible instead of
// silent. Counters live in the shared cache (survive restarts, shared on KV).
async function logUsage(purpose, charsIn, charsOut, ms, engine = 'llm') {
  console.log(`[posty] llm purpose=${purpose} engine=${engine} in=${charsIn}ch out=${charsOut}ch ms=${ms}`);
  try {
    const key = `llm-usage:${new Date().toISOString().slice(0, 10)}`;
    const day = (await cacheGet(key, 48 * 3600 * 1000)) || { calls: 0, byPurpose: {}, charsIn: 0, charsOut: 0 };
    day.calls += 1;
    day.byPurpose[purpose] = (day.byPurpose[purpose] || 0) + 1;
    day.charsIn += charsIn;
    day.charsOut += charsOut;
    await cacheSet(key, day);
  } catch { /* usage logging must never break drafting */ }
}

// The reasoning model is slow (~20s/call) and concurrent calls fail more
// often, so LLM calls flow through a small concurrency gate (2 at a time).
const llmWaiters = [];
let llmActive = 0;
const LLM_CONCURRENCY = 2;

async function withLlmSlot(fn) {
  if (llmActive >= LLM_CONCURRENCY) await new Promise((resolve) => llmWaiters.push(resolve));
  llmActive += 1;
  try {
    return await fn();
  } finally {
    llmActive -= 1;
    llmWaiters.shift()?.();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function llmChat(messages, { maxTokens = 4000, temperature = 0.4, timeoutMs = 90000, purpose = 'draft' } = {}) {
  if (!llmConfigured()) throw new Error('LLM is not configured');
  return withLlmSlot(async () => {
    const t0 = Date.now();
    const charsIn = messages.reduce((n, m) => n + String(m.content || '').length, 0);
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await fetchJson(process.env.LLM_ENDPOINT, {
          method: 'POST',
          timeoutMs,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` },
          body: JSON.stringify({
            model: process.env.LLM_MODEL || 'muse-spark-1.3',
            messages,
            temperature,
            max_tokens: maxTokens, // reasoning models spend tokens before answering — keep headroom
          }),
        });
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error(data?.choices?.[0]?.finish_reason === 'length' ? 'LLM ran out of output tokens' : 'empty LLM response');
        await logUsage(purpose, charsIn, text.length, Date.now() - t0);
        return text;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          console.log(`[posty] llm purpose=${purpose} attempt=${attempt} failed (${err.message}) — retrying once`);
          await sleep(1500);
        }
      }
    }
    throw lastErr;
  });
}

// Grounded 2-sentence snapshot of discussion comments. Comments are real
// fetched text; the model compresses them without adding facts. Input is
// capped so one long thread can't eat the quota.
export async function summarizeComments({ title, comments }) {
  const system = 'Summarize ONLY what the quoted discussion comments say about the topic. Two sentences maximum, plain and factual. Never invent facts, opinions, or details not present in the comments. Never address the user. Output only the summary.';
  return llmChat(
    [{ role: 'system', content: system }, { role: 'user', content: `Topic: ${title}\n\nComments:\n${String(comments).slice(0, 4000)}` }],
    { maxTokens: 2000, temperature: 0.2, purpose: 'snapshot' }
  );
}
