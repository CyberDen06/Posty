# Posty — your content research agent

Posty helps busy professionals find relevant industry developments or trends in their niche, add their
own perspective, turn them into channel-specific social drafts, and schedule
approved drafts through **Buffer**. 

Principles: Posty is a thoughtful, always-on content assistant. You control your profession, 
interests, point of view, wording, and approval. 
  
## Quick start

Requirements: Node.js 18+ (developed on Node 24). Zero npm dependencies.

```sh
npm start
```

Your browser opens (http://localhost:3000) automatically. 
If the port is taken, the server prints the
exact commands to free it instead of a stack trace.

On Windows, `npm start` also launches the **desktop companion** (sidebar with
global hotkeys - CTRL + SHIFT + Space to toggle on/off): straight away if it's built, otherwise it builds in the
background when Rust is installed. `POSTY_NO_DESKTOP=1` opts out; see 
`desktop/README.md`.

On first run, you pick a profession, select/edit interests, and set tone and
length. Everything else flows from there: Today → story → your take → drafts →
approve → confirm → scheduled. 

## Setup Guide: 

1. Open the app and complete setup (profession + interests + pillars, tone,
   length, channels, routine, optional style samples, never-post topics).
2. In **Today**, press **Find stories** — live stories with genuine links,
   sources, dates, faithful summaries, and a “why this matches you” line.
3. Open a story: drafts generate for your preferred channels, one tab each.
add your take, and press **Refine with my perspective** to get
   a refined draft grounded in your words (the initial version is kept)
   Edit, restore, duplicate, delete, skip, or try an alternative for
   each channel independently.
5. In **Ask**, question anything by text or voice. Briefs with links arrive, each
   openable into the same take → draft → refine flow.
6. In **Ideas**, brain-dump by typing or speaking; filter by origin. In **Sources**, see every
   connector's honest status, pause providers, or load the labelled demo.
   **Routine** runs itself (daily or weekly); **Calendar** shows the week, filters,
   and cadence progress.
7. Press **Approve & add to Buffer queue** on one draft: pick a **Buffer
   channel**, choose queue or a specific time, see the **exact text** you are
   approving, then **Confirm**.
   The result states plainly whether scheduling was **real (Buffer)** or
   **demo (not sent)** — real scheduling needs the Buffer OAuth setup below.

## Buffer OAuth setup (required for real scheduling)

Posty connects through Buffer OAuth and makes real GraphQL calls. Without
this setup, the app runs in clearly labelled **demo scheduling mode**.

1. In Buffer, go to Settings → API and register an OAuth app (confidential
   client). Buffer requires **https** redirect URIs — plain `http://localhost`
   is rejected, which surfaces as a generic error page and no callback.
   Add Posty's redirect URI: https://posty-three.vercel.app/auth/buffer/callback, and your local host's redirect URI,
   e.g., (https:localhost:3000/auth/buffer/callback)if you're running it locally. 
3. Copy `.env.example` to `.env` and set `BUFFER_CLIENT_ID`,
   `BUFFER_CLIENT_SECRET`, and `BUFFER_REDIRECT_URI` (must match the registered
   URI exactly). Set a long random `SESSION_SECRET`.
4. Local TLS: the app serves http on `PORT` plus https on `TLS_PORT`
   (default 3443) when a localhost certificate is configured — either
   `TLS_PFX` (+ `TLS_PASSPHRASE`) or `TLS_KEY`/`TLS_CERT` (PEM files).
   On Windows, mint one with no extra tools:
   `New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable`,
   then export it to `data/certs/localhost.pfx` (git-ignored) and point
   `TLS_PFX` at it. The browser shows one self-signed warning during
   Connect; click through and OAuth completes normally.
5. Restart the server and press **Connect Buffer**. Scheduling a draft now calls
   the real Buffer API against your account and channels.

No key-paste UI exists anywhere: secrets stay server-side in env vars.

## Real vs demo behavior

- **Story search:** always live (Hacker News + GDELT + Reddit inspiration + Exa).
   No fabricated stories. Provider hiccups appear as honest warnings. 
- **Drafts / snapshots / take-questions:** Uses Meta's Muse when it is configured,
  otherwise the built-in template engine. The UI never claims AI it didn't use.
- **Voice:** Muse transcription when configured; otherwise the mic states
  plainly that a key is needed and typing works regardless. 
- **Scheduling:** real Buffer calls when OAuth is configured and you're connected;
  otherwise simulated and labeled “Demo scheduling — NOT sent to Buffer”.
- **Routine:** settings + “Run routine now” + automatic runs (daily/weekly)
  (zero setup — Vercel Cron deployed, hourly ticker locally).

## Story providers

- **Hacker News Search :** keyless, date-ordered, 90-day recency floor
  with fallback. Discussion pages get grounded LLM comment snapshots instead
  of scraped junk.  
- **Exa (paid, keyed):** general web search (`/search`) plus structured
  article briefs (`/contents`: TL;DR + key points ≈80% + conclusion) with
  meta-junk filtering. One batched call per find/ask, cached; failures fall
  back to highlights.
- **GDELT DOC 2.0 `artlist` (experiment):** keyless world-news coverage for
  non-tech professions. GDELT rate-limits aggressively (HTTP 429 observed);
  Posty degrades gracefully with a warning. A `timelinevol` “news attention”
  signal was evaluated and left out of this build to stay within rate limits.
- **Reddit inspiration:** keyless per-subreddit Atom feeds (`sort=new`) mapped
  from your profession, filtered locally by your interests. Links go to the
  real Reddit discussion; post text is shown attributed, never scores or
  “viral” claims (the feed provides none). Reddit’s JSON search needs OAuth,
  so an authenticated upgrade path (Reddit app credentials) is the natural
  follow-up for richer signals.

## Summaries, prompts, and style references

- **Summaries** come from the provider when available, otherwise from the
  linked page itself: the publisher's own description or the opening sentences,
  verbatim and labeled (“Opening excerpt”). Exa stories get structured briefs.
  Bot-guarded pages keep an honest “No summary available” label.
- **Take-questions** are written per story/note about its own specific claims,
  cached 24h, with the generic lists as the instant
  fallback. Clicking one starts the answer in the take box.
- **Style references** are strictly opt-in: paste 1–2 samples of your own
  writing plus style notes, and enable the toggle to let drafts mirror your
  openings and length. Posty never clones your voice automatically.
- **Style learning** (Settings, opt-in) notes only the shape of drafts you
  keep or pass on — typical length, opening style — and tunes new drafts
  after 3 approvals. Inspect or clear it any time; drafts with the
  “Tuned to you” badge used it.

## Capture companions (desktop, extension, mobile)

- **Desktop (Windows, `desktop/`):** Tauri shell with global hotkeys —
  `Ctrl+Shift+Space` brain-dump overlay (speak with review-then-save, or
  type), `Ctrl+Shift+H` highlighted-text capture — plus a sidebar widget
  with the web UI. `npm start` launches it automatically (building in the
  background on first run when Rust is installed); single-instance guarded.
  Rebind live from the overlay's Hotkeys section (validated, instant,
  persisted; per-key active/not-registered status shown), or via
  `POSTY_HOTKEY_DUMP` / `POSTY_HOTKEY_HIGHLIGHT`. The web shortcuts guide
  (`?`) shows the overlay's effective pair live. Point the overlay at a
  deployed server with `POSTY_URL` — captures land in the shared workspace
  the browser sees, with no per-client setup. (Local dev just works:
  same-machine clients already share the local workspace. See HOSTING.md
  for the deployed-workspace tradeoff notes, the optional scheduled
  routine hook, and the full env-var table.)
- **Browser extension (`extension/`, Chrome/Edge):** side panel with
  Today/Ideas/Drafts, a keyboard shortcut or right-click to send a highlight
  to Ideas. Effective bindings are shown in the extension's options page
  (factory defaults `Alt+Shift+S` / `Alt+Shift+P`, rebindable at
  `chrome://extensions/shortcuts` — recommended when another extension owns
  them). Load unpacked in developer mode; localhost works out of the box,
  deployed servers via options-page origin grant.
- **Mobile PWA (Android-first):** installable (`manifest.webmanifest` +
  `sw.js` offline shell); the OS share sheet sends links/text into Ideas
  via `POST /api/share-target`. The Ideas mic uses the same WAV path as
  desktop. iOS share-target support is narrower than Android's.

## Manual test checklist

- [ ] Setup: profession → interests → pillars → tone/length → channels →
      never-post topics → style samples → cadence target → saved.
- [ ] Today: find returns stories with summaries, grounded take-questions,
      initial drafts per preferred channel, loading/empty/error/retry states,
      save/dismiss actions.
- [ ] Story keeps source/date/link visible; clicking a question starts the
      take; perspective saves; refine weaves summary + whole take; previous
      versions restore; duplicate/delete work.
- [ ] Ideas: note/link/voice captures save; captures edit (title + text);
      link captures fetch excerpts; private-source review prompt appears
      before drafting; Develop into drafts opens the draft flow; Delete
      removes with a confirm, and refuses ideas with a queued draft.
- [ ] Ideas mic: record → transcribe (staged, timed out, retried) → saved
      voice note with provenance; origin filter lists each kind.
- [ ] Ask: typed question returns briefed stories with links; voice asks
      transcribe first (words stay editable), then search; history persists;
      each result opens the perspective → draft → refine flow.
- [ ] Desktop: `npm start` launches one companion; CTRL + SHIFT + Space toggles the companion, highlight a text you'd like to capture as a content idea and hit CTRL + SHIFT + h and the highlighted text is copied straight into your ideas (first shown in Posty's sidebar companion for editing/approval), Esc hides the companion; You can also create your own custom hotkeys to trigger the desktop companion. 
- [ ] Extension: options shows effective bindings; rebind path documented.
- [ ] Mobile: manifest + icons + share target (`POST /api/share-target`
      with title/text/url → 303 to Ideas with a saved capture).
- [ ] Drafts view lists everything with status/channel filters.
- [ ] Calendar: planned/unplanned groups, filters, rescheduling, cadence
      progress, routine inbox section.
- [ ] Sources: live/paused/unavailable/disconnected states honest; provider
      pause affects discovery; demo seed/clear labeled. 
- [ ] Routine: interests/cadence/days/time/batch/channels/pause; automatic
      (Vercel cron / local ticker); no duplicates; never auto-schedules.
      (disable via POSTY_NO_SCHEDULER=1; CRON_SECRET locks the hook).
- [ ] Learning: opt-in records approvals/skips; “Tuned to you” drafts after 3
      kept; Settings inspects/clears; “Try alternative” offers new phrasing.
- [ ] Onboarding: Today banner tracks 8 steps; `npm run onboard` reports setup.
- [ ] Approve → confirm (exact channel + text, queue or scheduled a time) → queue; real vs demo labeled; failures preserve
      drafts with retry; no double-scheduling.
- [ ] Never-post topics filter discovery and block drafting with an explanation.
- [ ] Neutral drafts contain no first-person experience claims (`npm test`).

## Limitations

- File-backed store: local/demo + single-instance only; no multi-user auth
  beyond per-session isolation + Buffer OAuth.
- Automatic routines need the server running (local) or a Vercel
  deployment; a stopped local server briefs nothing (see HOSTING.md).
- Desktop companion is Windows-only, needs Rust to build, and needs the
  server running; global hotkeys need the companion running (single instance).
- GDELT and Reddit rate-limit aggressively; Hacker News usually carries the
  results when they throttle. The UI always says which sources answered.
- Notes/calendar/code/reading connectors are unavailable states with labeled
  demos until real credentials and documented APIs are configured.
- Summaries depend on publishers allowing page fetches; bot-guarded pages show
  an honest gap instead of invented text.

## Project structure

```
server.js          Local entry (thin; uses lib/app.js) + desktop auto-launch
api/index.js       Vercel entry (Web/Node adapter onto the same handler)
vercel.json        Rewrites + static bundling for the serverless function
lib/
  app.js           Shared HTTP handler: routes + static (local and Vercel)
  buffer.js        Buffer OAuth + GraphQL client (+ labeled mock)
  providers.js     Story search boundary (HN, GDELT, Reddit, NewsAPI stub)
  exa.js           Exa web search + structured briefs (+ meta-junk filter)
  summaries.js     Faithful excerpts + grounded HN comment snapshots
  prompts.js       Grounded take-question builder + tolerant parser
  drafts.js        Draft engine + opt-in style refs (+ LLM when configured)
  voice.js         Muse Voice Transcribe boundary (WAV → transcript, 1 retry)
  llm.js           Muse boundary (drafts + snapshots + questions; template fallback)
  desktop.js       Desktop companion auto-launch (single-instance guarded)
  routine.js       Routine settings + on-demand runs (neutral drafts)
  learn.js         Opt-in style learning (shape stats, inspectable, clearable)
  cron.js          Scheduled routine hook (secret-guarded, same bounded runs)
  onboard.js       Onboarding checklist derived from workspace state
  professions.js   Professions, interests, tones, channels, pillars
  session.js       Signed-cookie sessions (isolation boundary = session)
  store.js         Per-user store: local files or Vercel KV (REST, no SDK)
  util.js          HTTP/JSON/cookie/crypto/URL helpers
public/            Static frontend (hash-routed, no build step) + PWA shell
desktop/           Tauri Windows shell (hotkeys, overlay, widget)
extension/         MV3 browser companion (side panel, highlight capture)
scripts/           Icon generators (desktop ICO/PNG, PWA PNGs)
test/              Regression tests (node --test, no dependencies)
```
