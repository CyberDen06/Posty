// Muse Voice Transcribe boundary (Meta Model API).
// Contract (dev.meta.ai/docs/api-reference/voice/transcribe): multipart POST
// with a `request` JSON part ({model, audioEncoding, mode}) and an `audio`
// WAV part. WAV only, ≤10 minutes of audio, ≤32 MB body.

const TRANSCRIBE_URL = 'https://api.meta.ai/v1/asr/transcribe';
const MODEL = process.env.LLM_VOICE_MODEL || 'muse-voice-transcribe-1.0';
const MAX_BYTES = 32 * 1024 * 1024;

export function voiceConfigured() {
  return Boolean(process.env.LLM_API_KEY);
}

export function voiceModel() {
  return MODEL;
}

function isWav(buf) {
  return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

function fail(message, status) {
  throw Object.assign(new Error(message), { status });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryableStatus = (status) => status === 408 || (status >= 502 && status <= 504);

// Transcribe a WAV buffer (16-bit PCM). Returns { transcript, model }.
// Transient failures (408/5xx, network blips) retry once; anything else
// fails fast with an actionable message — never a raw status code.
export async function transcribeWav(buffer, { timeoutMs = 60000 } = {}) {
  if (!voiceConfigured()) fail('Voice transcription is not configured on this server — add an LLM API key to enable it.', 503);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) fail('No audio was received.', 400);
  if (buffer.length > MAX_BYTES) fail('Audio exceeds the 32 MB transcription limit.', 413);
  if (!isWav(buffer)) fail('Only WAV audio can be transcribed — record from the in-app mic, which encodes WAV.', 400);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const form = new FormData();
    form.append('request', new Blob(
      [JSON.stringify({ model: MODEL, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' })],
      { type: 'application/json' }
    ));
    form.append('audio', new Blob([new Uint8Array(buffer)], { type: 'audio/wav' }), 'recording.wav');

    let res;
    try {
      res = await fetch(TRANSCRIBE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.LLM_API_KEY}`, accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt === 2) fail(`Transcription service unreachable (${err.message})`, 502);
      console.log(`[posty] voice transcribe attempt=${attempt} unreachable (${err.message}) — retrying once`);
      await sleep(2000);
      continue;
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* fall through */ }
    if (res.status === 429) fail('Transcription is rate-limited right now — wait a minute and try again.', 429);
    if (res.status === 413) fail('Audio exceeds the transcription size limit.', 413);
    if (res.status === 400) fail('The transcription service rejected this audio (it must be WAV, under 10 minutes).', 400);
    if (retryableStatus(res.status)) {
      if (attempt === 2) fail('The transcription service timed out on this recording — try a shorter one (under a minute works best).', 504);
      console.log(`[posty] voice transcribe attempt=${attempt} status=${res.status} — retrying once`);
      await sleep(2000);
      continue;
    }
    if (!res.ok || !data) fail(`Transcription failed with status ${res.status}.`, 502);
    const transcript = data.transcript
      || (Array.isArray(data.turns) ? data.turns.map((t) => t.transcript).filter(Boolean).join(' ') : '')
      || data.text
      || '';
    if (!transcript.trim()) fail('No speech was detected in this recording.', 422);
    console.log(`[posty] voice model=${MODEL} audio=${buffer.length}b transcript=${transcript.length}ch`);
    return { transcript: transcript.trim(), model: MODEL };
  }
}
