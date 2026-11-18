// Posty onboarding track (CLI): `npm run onboard` prints what is configured
// and what to do next. Reads local env + the local workspace only; starts
// nothing, writes nothing, prints no secret values.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dataDir = path.resolve(root, process.env.DATA_DIR || './data');
const tick = (ok) => (ok ? '[x]' : '[ ]');

function loadDotEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}

function readLocalPrefs() {
  try {
    const users = path.join(dataDir, 'users');
    if (!fs.existsSync(users)) return null;
    for (const sid of fs.readdirSync(users)) {
      const f = path.join(users, sid, 'preferences.json');
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
  } catch { /* fresh workspace */ }
  return null;
}

loadDotEnv();
const buffer = Boolean(process.env.BUFFER_CLIENT_ID && process.env.BUFFER_CLIENT_SECRET && process.env.BUFFER_REDIRECT_URI);
const llm = Boolean(process.env.LLM_API_KEY && process.env.LLM_ENDPOINT);
const prefs = readLocalPrefs();
const setupDone = prefs?.setupDone === true;
const exe = [
  'desktop/src-tauri/target/release/posty-desktop.exe',
  'desktop/src-tauri/target/debug/posty-desktop.exe',
  'desktop/src-tauri/target/release/posty-desktop',
].map((p) => path.join(root, p)).find((p) => fs.existsSync(p));

console.log('Posty onboarding track\n');
console.log(`${tick(setupDone)} Profile: ${setupDone ? `${prefs.profession} · ${(prefs.interests || []).length} interests` : 'run npm start, then set profession + interests in the browser'}`);
console.log(`${tick(buffer)} Buffer OAuth: ${buffer ? 'configured (Connect in the app for real scheduling)' : 'unset — scheduling runs in labeled demo mode (see README)'}`);
console.log(`${tick(llm)} LLM drafting: ${llm ? 'configured (Muse drafts + take-questions)' : 'unset — built-in template engine (no external calls)'}`);
console.log(`${tick(Boolean(process.env.EXA_API_KEY))} Exa web search: ${process.env.EXA_API_KEY ? 'configured (paid general web search)' : 'unset — keyless Hacker News + GDELT + Reddit'}`);
console.log(`${tick(Boolean(process.env.CRON_SECRET))} Routine cron: ${process.env.CRON_SECRET ? 'secret set (add the GitHub Actions secrets to go automatic)' : 'unset — routines run on demand only'}`);
console.log(`${tick(Boolean(exe))} Desktop companion: ${exe ? 'built (npm start launches it)' : 'not built yet (npm start builds it when Rust is installed)'}`);
console.log('\nNext: npm start → finish the in-app checklist (Today view) → npm test');
