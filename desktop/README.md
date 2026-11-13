# Posty desktop (Windows)

System-wide companion: global hotkeys, a brain-dump overlay (speak or type),
and a narrow sidebar widget showing the Posty web UI. Works from any app —
no need to keep the browser open.

## Run (easiest)

Just run **`npm start`** in the repo root. The server launches the desktop
companion automatically: if the exe exists it starts right away, otherwise
— when Rust is installed — it builds in the background and starts when the
build finishes. The brain-dump window appears on launch — press `Esc` to
hide it; `Ctrl+Shift+Space` summons it back from anywhere.
Opt out of the auto-launch with `POSTY_NO_DESKTOP=1`.
Run only ONE companion: a second instance gets no hotkeys (the launchers
guard this, but don't start the exe twice by hand). Stuck? Kill strays with
`taskkill /F /IM posty-desktop.exe` and start once.

Manual alternative: double-click **`desktop/Start-Posty.bat`** (builds on
first run, starts server + companion), or launch
`desktop/src-tauri/target/debug/posty-desktop.exe` by hand after
`npm run desktop:build`.

If the overlay ever opens blank, note the exact text and report it — that
means the window loaded but its page did not.

## Hotkeys (global, rebindable)

- `Ctrl+Shift+Space` — toggle the brain-dump overlay (speak or type) from any app.
- `Ctrl+Shift+H` — capture the highlighted text: Posty presses `Ctrl+C`
  for you, reads the clipboard, and opens the overlay with the text ready
  to edit and save.
- Closing the overlay’s window (X) hides it instead of quitting, so the
  hotkey always works. Quit from the overlay: Server details → Quit button.

Rebind either hotkey live from the overlay: open the Hotkeys section, type a
new combo (`"ctrl+shift+space"` syntax, e.g. `alt+f9`), Save — it works
immediately and is remembered across restarts (`%APPDATA%/posty/hotkeys.json`).
`POSTY_HOTKEY_DUMP` / `POSTY_HOTKEY_HIGHLIGHT` env vars override both.
Point at another server with `POSTY_URL` (default `http://127.0.0.1:3000`).

## Overlay and sidebar

- **Overlay:** type the idea, or press Record and talk (up to 2 minutes —
  transcribed in-page to WAV and sent to the server, same as the web Ideas
  view). `Esc` hides it.
- **Sidebar:** "Open sidebar" loads Today / Ideas / Drafts in a narrow
  always-on-top-friendly window that follows the app's own narrow CSS.

## Notes and limits

- First build downloads Rust crates (~minutes); needs WebView2 (built into
  Windows 10/11).
- The highlight hotkey simulates `Ctrl+C`: in apps that block simulated keys
  (elevated windows, some games), copy manually first — the overlay still
  picks the clipboard text up.
- Microphone permission is requested by the overlay's web view on first use.
