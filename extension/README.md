# Posty companion (browser extension, MV3)

Sends highlighted text to Posty Ideas and shows Today / Ideas / Drafts in a
side panel. Chrome and Edge (Chromium).

## Install (developer mode)

1. Start Posty: `npm start` in the repo root (default `http://127.0.0.1:3000`).
2. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**,
   and select this `extension/` folder.
3. Pin Posty, then open its side panel from the toolbar icon.

## Use

- **Highlight + hotkey:** select text on any page, press the "Send selection
  to Ideas" shortcut shown in the extension's options page (factory default
  `Alt+Shift+S`). If it does nothing, another extension owns that combo —
  set your own at `chrome://extensions/shortcuts`
  (Edge: `edge://extensions/shortcuts`).
  Browser hotkeys only fire while the browser is focused — for system-wide
  capture use the desktop app (`desktop/`).
- **Side panel shortcut:** shown in options too (factory default `Alt+Shift+P`).
- **Right-click:** "Send to Posty Ideas" on any selection.
- **Side panel:** Today / Ideas / Drafts switcher; `↗` opens the full app.

## Pointing at a deployed server

Extension options → set the `https://…` URL → Save. The extension requests
access to that origin only (optional host permission); localhost works with
no extra grant.
