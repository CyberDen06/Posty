# Hosting Posty

This guide is for whoever runs a Posty server — including the hackathon
submitter. End users never need any of this: they open the live app and tap
Connect Buffer. The user-facing guide is [README.md](README.md).

Principles: Posty is a thoughtful assistant. Users control their profession,
interests, point of view, wording, and approval. No key-paste UI exists
anywhere: secrets stay server-side in env vars.

## Submission checklist (Buffer Commit 2026)

- **Works end to end:** setup → discovery → take → drafts → approve → confirm →
  scheduled. (5–10 minutes, zero keys).
- **Buffer OAuth:** Authorization Code + PKCE, confidential client; no
  key-paste UI anywhere, secrets server-side only.
- **Real API calls:** live GraphQL `createPost` (queue + scheduled modes) and
  channel lookup against the connected account; every result is labeled real
  vs demo, and typed mutation errors are surfaced, not just HTTP status.

## Quick start (host)

Requirements: Node.js 18+ (developed on Node 24). Zero npm dependencies.

```sh
npm start
```

The browser opens (http://localhost:3000) automatically. If the port is
taken, the server prints the exact commands to free it instead of a stack
trace.

On Windows, `npm start` also launches the **desktop companion** (sidebar with
global hotkeys): straight away if it's built, otherwise it builds in the
background when Rust is installed. `POSTY_NO_DESKTOP=1` opts out; see
`desktop/README.md`.

## Environment variables

Copy `.env.example` to `.env` (git-ignored; never commit secrets):

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `SESSION_SECRET` | Signs session cookies. **Required on Vercel** (instances don't share memory); generate 32+ random bytes |
| `DATA_DIR` | File store location (local only; default `./data`) |
| `BUFFER_CLIENT_ID` / `BUFFER_CLIENT_SECRET` | OAuth app credentials (register once per deployment, below) |
| `BUFFER_REDIRECT_URI` | Must match a registered redirect URI exactly |
| `TLS_PORT` / `TLS_PFX` / `TLS_PASSPHRASE` (or `TLS_KEY`/`TLS_CERT`) | Local https listener for the Buffer callback |
| `EXA_API_KEY` | General web search + article briefs (paid; unset = keyless built-ins only) |
| `NEWS_API_KEY` | Local-dev comparison only — not cleared for deployed use |
| `LLM_API_KEY` / `LLM_ENDPOINT` / `LLM_MODEL` | Muse drafting + snapshots + take-questions (unset = built-in template engine) |
| `LLM_VOICE_MODEL` | Voice transcription model override |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV store (auto-set when you connect a KV database) |
| `CRON_SECRET` | Optional strict mode for the routine hook (unset = automatic scheduling) |
| `POSTY_NO_SCHEDULER` | Set to 1 to disable the local hourly routine ticker |
| `POSTY_URL` / `POSTY_HOTKEY_*` / `POSTY_NO_DESKTOP` | Desktop companion targeting and hotkey overrides |

## Buffer OAuth setup (required for real scheduling)

Register **one** OAuth app per deployment. Every end user then connects
through it with a click — they never see keys.

1. In Buffer, go to Settings → API and register an OAuth app (confidential
   client). Buffer requires **https** redirect URIs — plain `http://localhost`
   is rejected, which surfaces as a generic error page and no callback.
   Register each URI you serve, e.g. `https://<your-app>.vercel.app/auth/buffer/callback`
   for production plus `https://localhost:3443/auth/buffer/callback` for local.
2. Set `BUFFER_CLIENT_ID`, `BUFFER_CLIENT_SECRET`, and `BUFFER_REDIRECT_URI`
   (must match the registered URI exactly). Set a long random `SESSION_SECRET`.
3. Local TLS: the app serves http on `PORT` plus https on `TLS_PORT`
   (default 3443) when a localhost certificate is configured — either
   `TLS_PFX` (+ `TLS_PASSPHRASE`) or `TLS_KEY`/`TLS_CERT` (PEM files).
   On Windows, mint one with no extra tools:
   `New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable`,
   then export it to `data/certs/localhost.pfx` (git-ignored) and point
   `TLS_PFX` at it. The browser shows one self-signed warning during
   Connect; click through and OAuth completes normally.
4. Restart the server and press **Connect Buffer**. Scheduling a draft now calls
   the real Buffer API against your account and channels.

Without this setup the app runs in clearly labeled **demo scheduling mode**.

## Deployment (Vercel)

1. Import the repo in Vercel.
2. In Storage, connect a **KV database** (auto-sets `KV_REST_API_*`). Without
   it, the deployment fails writes with an actionable error — serverless
   filesystems don't persist.
3. Set env vars: `SESSION_SECRET` (required), `BUFFER_CLIENT_ID`,
   `BUFFER_CLIENT_SECRET`, `BUFFER_REDIRECT_URI` (your production callback
   URL), plus `LLM_*`/`EXA_API_KEY` as wanted.
4. Deploy. Add the production callback URI to your Buffer app's redirect list.

A `Dockerfile` is included for single-instance VM hosting (`/data` volume).

## Scheduled routines (automatic)

No setup: configure a routine in the app and it runs itself.

- **Deployed (Vercel):** `vercel.json` crons call `GET /api/cron/routine`

  daily (~09:00 UTC — Hobby timing is within the hour); the due-check keeps

  weekly routines weekly and daily ones daily, after each delivery slot;
  paused, empty, and recently-run routines refuse. A run only adds briefing
  suggestions — it never schedules or publishes. Keep the batch small
  (≤2 stories): serverless functions have execution time limits, and a run
  that times out simply adds nothing — check the function logs.
  Delivery time is server-local (UTC on Vercel) — convert the owner's local
  hour. Tightest delivery: set vercel.json's cron hour to the delivery
  hour (one line, redeploy once) so the check lands right after the slot.
- **Local/VM (`npm start`):** the server wakes at each delivery slot while
  it runs — briefings land at the picked time sharp. Opt out: `POSTY_NO_SCHEDULER=1`.
Advanced: set `CRON_SECRET` to lock the hook (callers must present it)
and drive it from your own scheduler — the [.github/workflows/routine-cron.yml](.github/workflows/routine-cron.yml)
workflow is kept for that. Note: setting the secret disables the automatic
Vercel calls, which cannot send one.

## Desktop companion with a deployed server

Point the overlay at the app URL — in the overlay Server box or via the `POSTY_URL` env var — and its captures land in the shared workspace the browser sees. No per-client setup.

Note: on hosts whose internal hop presents a loopback address (e.g. Vercel), first-visit browsers join that same shared workspace. That is the accepted tradeoff for URL-only pairing on a personal deployment; a shared/public service would need real user accounts first.

## Real vs demo behavior

- **Story search:** always live (Hacker News + GDELT + Reddit inspiration; Exa
  joins when keyed). No fabricated stories. Provider hiccups appear as honest
  warnings, never invented fill-ins.
- **Drafts / snapshots / take-questions:** uses Meta's Muse when configured,
  otherwise the built-in template engine. The UI never claims AI it didn't use.
- **Voice:** Muse transcription when configured; otherwise the mic states
  plainly that a key is needed and typing works regardless.
- **Scheduling:** real Buffer calls when OAuth is configured and connected;
  otherwise simulated and labeled "Demo scheduling — NOT sent to Buffer".
- **Routine:** synced interests + "Run routine now" + automatic runs (daily/weekly)
  (Vercel Cron deployed, exact-slot wakeups locally). Never auto-schedules.

## Story providers (technical)

- **Hacker News Search:** keyless, date-ordered, 90-day recency floor
  with fallback. Discussion pages get grounded LLM comment snapshots instead
  of scraped junk.
- **Exa (paid, keyed):** general web search (`/search`) plus structured
  article briefs (`/contents`: TL;DR + key points ≈80% + conclusion) with
  meta-junk filtering. One batched call per find/ask, cached; failures fall
  back to highlights.
- **GDELT DOC 2.0 `artlist` (experiment):** keyless world-news coverage for
  non-tech professions. GDELT rate-limits aggressively (HTTP 429 observed);
  Posty degrades gracefully with a warning. A `timelinevol` "news attention"
  signal was evaluated and left out of this build to stay within rate limits.
- **Reddit inspiration:** keyless per-subreddit Atom feeds (`sort=new`) mapped
  from your profession, filtered locally by interests. Links go to the
  real Reddit discussion; post text is shown attributed, never scores or
  "viral" claims (the feed provides none). Reddit's JSON search needs OAuth,
  so an authenticated upgrade path (Reddit app credentials) is the natural
  follow-up for richer signals.

Summaries come from the provider when available, otherwise from the linked
page itself: the publisher's own description or the opening sentences,
verbatim and labeled ("Opening excerpt"). Bot-guarded pages keep an honest
"No summary available" label. Take-questions are written per story/note about
its own specific claims, cached 24h, with generic lists as the instant
fallback. Style references are strictly opt-in.

## Operating cost

List prices at build time (verify on the dashboards before budgeting):

| Action | Price | Notes |
|---|---|---|
| Ask / Find search (Exa, when keyed) | ~$0.007 | One `/search auto` call per find/ask, cached 30 min; $10/mo free credits ≈ 1,400 searches |
| Article brief per Exa story | ~$0.001 | One batched `/contents` summary call per find/ask, cached 24 h; failures fall back to highlights free |
| Keyless providers (HN, GDELT, Reddit) | $0 | Rate-limited, not billed |
| Channel draft (Muse Spark 1.3) | ~$0.003–0.009 | Lazy: only opened stories; reasoning included |
| Take-questions per story | ~$0.003–0.008 | One call per opened story/note, cached 24 h; generic fallback free |
| Comment snapshot | ~$0.002–0.005 | Only for HN discussions without excerpts |
| Voice (transcribe 2-min note) | ~$0.006 | $0.18/hour of audio; one retry on transient failures |

A daily habit (5 asks, a few opened stories with questions, 4 drafts, a couple
of voice notes) lands around **$2–3/month**, inside Exa's free tier. Server
logs print per-call usage (`[posty] llm …`, `[posty] exa …`, `[posty] voice …`)
plus daily counters, so spend stays visible.

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
      removes with a confirm, even with queued drafts (queue untouched).
- [ ] Ideas mic: record → transcribe (staged, timed out, retried) → saved
      voice note with provenance; origin filter lists each kind.
- [ ] Ask: typed question returns briefed stories with links; voice asks
      transcribe first (words stay editable), then search; history persists;
      each result opens the perspective → draft → refine flow.
- [ ] Desktop: `npm start` launches one companion; Space toggles, H captures
      the exact highlight, Esc hides; Hotkeys section rebinds with live
      status; web `?` guide mirrors the effective pair.
- [ ] Extension: options shows effective bindings; rebind path documented.
- [ ] Mobile: manifest + icons + share target (`POST /api/share-target`
      with title/text/url → 303 to Ideas with a saved capture).
- [ ] Drafts view lists everything with status/channel filters.
- [ ] Calendar: planned/unplanned groups, filters, rescheduling, cadence
      progress, routine inbox section.
- [ ] Sources: live/paused/unavailable/disconnected states honest; provider
      pause affects discovery; demo seed/clear labeled.
- [ ] Routine: synced interests + cadence/days/time/batch/channels/pause;
      automatic (Vercel cron / exact-slot wakeups); no duplicates.
      never auto-schedules; POSTY_NO_SCHEDULER=1 disables, CRON_SECRET locks.
- [ ] Learning: opt-in records approvals/skips; “Tuned to you” drafts after 3
      kept; Settings inspects/clears; “Try alternative” offers new phrasing.
- [ ] Onboarding: Today banner tracks 8 steps; `npm run onboard` reports setup.
- [ ] Approve → confirm (exact channel + text, queue or scheduled time,
      sticky buttons) → queue; real vs demo labeled; failures preserve
      drafts with retry; no double-scheduling.
- [ ] Never-post topics filter discovery and block drafting with an explanation.
- [ ] Neutral drafts contain no first-person experience claims (`npm test`).

## Limitations

- File-backed store: local/demo + single-instance only; no multi-user auth
  beyond per-session isolation + Buffer OAuth.
- Automatic routines need the server running (local ticker) or a Vercel
  deployment (weekly cron); a stopped local server briefs nothing.
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
