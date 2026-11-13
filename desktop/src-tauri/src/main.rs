// Posty Windows companion (Tauri v2).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// - Global hotkeys: brain-dump overlay (default Ctrl+Shift+Space) and
//   highlighted-text capture (default Ctrl+Shift+H). Rebindable live from the
//   overlay (Hotkeys section, persisted) or via POSTY_HOTKEY_DUMP /
//   POSTY_HOTKEY_HIGHLIGHT ("ctrl+shift+space" syntax, env wins).
// - Overlay window: Speak/Type brain dump that POSTs to the Posty server.
// - Widget window: the Posty web UI in a narrow always-available sidebar.
// - Server base URL: POSTY_URL env or http://127.0.0.1:3000.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

struct PendingText(Mutex<Option<String>>);

// Live hotkeys: parsed shortcuts for the dispatcher plus the original spec
// strings (for display, rollback, and persistence).
struct Hotkeys {
    dump: Shortcut,
    highlight: Shortcut,
    dump_spec: String,
    highlight_spec: String,
}
struct HotkeyState(Mutex<Hotkeys>);

#[derive(Serialize, Deserialize)]
struct HotkeyFile {
    dump: String,
    highlight: String,
}

fn hotkey_file_path() -> Option<PathBuf> {
    std::env::var("APPDATA")
        .ok()
        .map(|a| Path::new(&a).join("posty").join("hotkeys.json"))
}

fn load_hotkey_file() -> Option<HotkeyFile> {
    let path = hotkey_file_path()?;
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_hotkey_file(dump: &str, highlight: &str) -> Result<(), String> {
    let path = hotkey_file_path().ok_or_else(|| "no APPDATA directory".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&HotkeyFile {
        dump: dump.to_string(),
        highlight: highlight.to_string(),
    })
    .map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| e.to_string())
}

// Env wins, then the overlay-saved file, then the built-in default.
fn hotkey_spec(env_key: &str, file_value: Option<&str>, default: &str) -> String {
    std::env::var(env_key)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| file_value.map(|s| s.to_string()))
        .unwrap_or_else(|| default.to_string())
}

// Strict check for user-supplied specs: every part must be a known modifier
// or key, with exactly one key. Modifier-only ("ctrl+shift") is impossible —
// the OS needs a key to attach the shortcut to.
fn spec_is_valid(spec: &str) -> bool {
    let mut codes = 0;
    for part in spec.split('+') {
        match part.trim().to_lowercase().as_str() {
            "ctrl" | "control" | "shift" | "alt" | "super" | "win" | "meta" | "cmd" => {}
            "space" | "enter" | "tab" | "escape" | "esc" => codes += 1,
            s if s.len() == 1 && s.chars().next().unwrap().is_ascii_alphanumeric() => codes += 1,
            "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12" => codes += 1,
            _ => return false,
        }
    }
    codes == 1
}

fn server_base() -> String {
    std::env::var("POSTY_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3000".to_string())
        .trim_end_matches('/')
        .to_string()
}

#[tauri::command]
fn server_url() -> String {
    server_base()
}

#[tauri::command]
fn get_pending(state: State<PendingText>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[tauri::command]
fn quit_app() {
    std::process::exit(0);
}

#[tauri::command]
fn hide_overlay(app: AppHandle) -> Result<(), String> {
    // Errors propagate (never swallowed): a failed hide must say why
    // instead of looking dead.
    match app.get_webview_window("overlay") {
        Some(w) => w.hide().map_err(|e| e.to_string()),
        None => Err("overlay window not found".to_string()),
    }
}

#[derive(Serialize)]
struct HotkeyStatus {
    dump: String,
    highlight: String,
    dump_registered: bool,
    highlight_registered: bool,
}

#[tauri::command]
fn get_hotkeys(app: AppHandle, state: State<HotkeyState>) -> HotkeyStatus {
    let hk = state.0.lock().unwrap();
    let gs = app.global_shortcut();
    HotkeyStatus {
        dump: hk.dump_spec.clone(),
        highlight: hk.highlight_spec.clone(),
        dump_registered: gs.is_registered(hk.dump),
        highlight_registered: gs.is_registered(hk.highlight),
    }
}

// Rebind both hotkeys live: validate, swap registrations (rolling back to the
// previous pair if the new ones are taken), then persist for next launch.
#[tauri::command]
fn set_hotkeys(
    app: AppHandle,
    state: State<HotkeyState>,
    dump: String,
    highlight: String,
) -> Result<(), String> {
    let dump_spec = dump.trim().to_string();
    let highlight_spec = highlight.trim().to_string();
    if !spec_is_valid(&dump_spec) {
        return Err(format!("{dump_spec:?} is not a valid hotkey — use modifiers plus one key, e.g. ctrl+shift+space"));
    }
    if !spec_is_valid(&highlight_spec) {
        return Err(format!("{highlight_spec:?} is not a valid hotkey — use modifiers plus one key, e.g. ctrl+shift+h"));
    }
    if dump_spec.to_lowercase() == highlight_spec.to_lowercase() {
        return Err("The two hotkeys must be different.".to_string());
    }
    let new_dump = parse_hotkey(
        &dump_spec,
        Shortcut::new(
            Some(Modifiers::CONTROL | Modifiers::SHIFT),
            Code::Space,
        ),
    );
    let new_highlight = parse_hotkey(
        &highlight_spec,
        Shortcut::new(
            Some(Modifiers::CONTROL | Modifiers::SHIFT),
            Code::KeyH,
        ),
    );
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    if let Err(e) = gs.register(new_dump).and(gs.register(new_highlight)) {
        // A half-applied pair (first registered, second taken) must not
        // linger as a ghost: clear everything, then restore the old pair.
        let _ = gs.unregister_all();
        let hk = state.0.lock().map_err(|e| e.to_string())?;
        let old_dump = parse_hotkey(&hk.dump_spec, new_dump);
        let old_highlight = parse_hotkey(&hk.highlight_spec, new_highlight);
        drop(hk);
        let _ = gs.register(old_dump);
        let _ = gs.register(old_highlight);
        return Err(format!("Could not register those hotkeys ({e}) — is another app using them? Previous hotkeys restored."));
    }
    {
        let mut hk = state.0.lock().map_err(|e| e.to_string())?;
        hk.dump = new_dump;
        hk.highlight = new_highlight;
        hk.dump_spec = dump_spec.clone();
        hk.highlight_spec = highlight_spec.clone();
    }
    if let Err(e) = save_hotkey_file(&dump_spec, &highlight_spec) {
        println!("posty-desktop hotkeys: active for this session but NOT saved ({e})");
    }
    Ok(())
}

#[tauri::command]
fn open_widget(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("widget") {
        w.unminimize().map_err(|e| e.to_string())?;
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = format!("{}/#/today", server_base());
    WebviewWindowBuilder::new(
        &app,
        "widget",
        WebviewUrl::External(url.parse::<tauri::Url>().map_err(|e| e.to_string())?),
    )
    .title("Posty")
    .inner_size(400.0, 720.0)
    .min_inner_size(320.0, 480.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

// show() alone does NOT restore a minimized window (and the overlay has no
// taskbar button, so a minimized overlay is unrecoverable without this).
fn show_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// The dump hotkey toggles, so its effect is always visible: summon or dismiss.
// is_visible() stays true for minimized windows, so check minimized too —
// a minimized overlay summons (restores) instead of "hiding" invisibly.
fn toggle_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn read_clipboard() -> Option<String> {
    Clipboard::new()
        .ok()
        .and_then(|mut cb| cb.get_text().ok())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(vkey: i32) -> i16;
}

// The hotkey fires while the user's fingers are still on Ctrl+Shift. Simulating
// Ctrl+C immediately would land as Ctrl+Shift+C in the focused app (in Chrome:
// DevTools Inspect opens instead of copying, so we'd capture stale clipboard
// text). Wait for the modifiers to lift first, bounded — then copy anyway.
fn wait_for_modifiers_release() {
    const MODIFIERS: [i32; 5] = [0x10, 0x11, 0x12, 0x5B, 0x5C]; // shift, ctrl, alt, lwin, rwin
    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_millis(800) {
        let any_down = MODIFIERS.iter().any(|&vk| unsafe { GetAsyncKeyState(vk) } < 0);
        if !any_down {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

// Simulate Ctrl+C so the current highlight lands on the clipboard.
fn press_ctrl_c() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Control, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('c'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Control, Direction::Release)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn capture_highlight(app: &AppHandle) {
    wait_for_modifiers_release();
    let before = read_clipboard();
    if press_ctrl_c().is_ok() {
        // Wait for the copy to land (fast apps: ~30ms) instead of a fixed
        // sleep — quicker AND more reliable than guessing a duration.
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(400) {
            std::thread::sleep(std::time::Duration::from_millis(30));
            if read_clipboard() != before {
                break;
            }
        }
    }
    let found = read_clipboard();
    if std::env::var("POSTY_DEBUG_KEYS").is_ok() {
        println!("posty-desktop capture: clipboard {}", found.as_ref().map(|t| format!("{} chars", t.len())).unwrap_or_else(|| "empty".to_string()));
    }
    if let Some(text) = found {
        if let Some(state) = app.try_state::<PendingText>() {
            *state.0.lock().unwrap() = Some(text.chars().take(4000).collect());
        }
    }
    show_overlay(app);
}

fn parse_hotkey(spec: &str, fallback: Shortcut) -> Shortcut {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;
    for part in spec.split('+') {
        match part.trim().to_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" => mods |= Modifiers::ALT,
            "super" | "win" | "meta" | "cmd" => mods |= Modifiers::SUPER,
            "space" => code = Some(Code::Space),
            "enter" => code = Some(Code::Enter),
            "tab" => code = Some(Code::Tab),
            "escape" | "esc" => code = Some(Code::Escape),
            s if s.len() == 1 => {
                let c = s.chars().next().unwrap();
                code = match c {
                    'a'..='z' => match c {
                        'a' => Some(Code::KeyA), 'b' => Some(Code::KeyB), 'c' => Some(Code::KeyC),
                        'd' => Some(Code::KeyD), 'e' => Some(Code::KeyE), 'f' => Some(Code::KeyF),
                        'g' => Some(Code::KeyG), 'h' => Some(Code::KeyH), 'i' => Some(Code::KeyI),
                        'j' => Some(Code::KeyJ), 'k' => Some(Code::KeyK), 'l' => Some(Code::KeyL),
                        'm' => Some(Code::KeyM), 'n' => Some(Code::KeyN), 'o' => Some(Code::KeyO),
                        'p' => Some(Code::KeyP), 'q' => Some(Code::KeyQ), 'r' => Some(Code::KeyR),
                        's' => Some(Code::KeyS), 't' => Some(Code::KeyT), 'u' => Some(Code::KeyU),
                        'v' => Some(Code::KeyV), 'w' => Some(Code::KeyW), 'x' => Some(Code::KeyX),
                        'y' => Some(Code::KeyY), 'z' => Some(Code::KeyZ), _ => None,
                    },
                    '0'..='9' => match c {
                        '0' => Some(Code::Digit0), '1' => Some(Code::Digit1), '2' => Some(Code::Digit2),
                        '3' => Some(Code::Digit3), '4' => Some(Code::Digit4), '5' => Some(Code::Digit5),
                        '6' => Some(Code::Digit6), '7' => Some(Code::Digit7), '8' => Some(Code::Digit8),
                        '9' => Some(Code::Digit9), _ => None,
                    },
                    _ => None,
                };
            }
            s if s.starts_with('f') => {
                code = match s {
                    "f1" => Some(Code::F1), "f2" => Some(Code::F2), "f3" => Some(Code::F3),
                    "f4" => Some(Code::F4), "f5" => Some(Code::F5), "f6" => Some(Code::F6),
                    "f7" => Some(Code::F7), "f8" => Some(Code::F8), "f9" => Some(Code::F9),
                    "f10" => Some(Code::F10), "f11" => Some(Code::F11), "f12" => Some(Code::F12),
                    _ => None,
                };
            }
            _ => return fallback,
        }
    }
    match code {
        Some(c) => Shortcut::new(Some(mods), c),
        None => fallback,
    }
}

fn main() {
    // Ctrl+Shift+J summons browser DevTools, so the overlay lives on
    // Ctrl+Shift+Space and highlight capture on Ctrl+Shift+H.
    let file = load_hotkey_file();
    let dump_spec = hotkey_spec(
        "POSTY_HOTKEY_DUMP",
        file.as_ref().map(|f| f.dump.as_str()),
        "ctrl+shift+space",
    );
    let highlight_spec = hotkey_spec(
        "POSTY_HOTKEY_HIGHLIGHT",
        file.as_ref().map(|f| f.highlight.as_str()),
        "ctrl+shift+h",
    );
    let dump_default = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::SHIFT),
        Code::Space,
    );
    let highlight_default = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::SHIFT),
        Code::KeyH,
    );
    if !spec_is_valid(&dump_spec) {
        println!("posty-desktop hotkeys: ignoring invalid overlay value {dump_spec:?}, using the default");
    }
    if !spec_is_valid(&highlight_spec) {
        println!("posty-desktop hotkeys: ignoring invalid highlight value {highlight_spec:?}, using the default");
    }
    let initial = Hotkeys {
        dump: parse_hotkey(&dump_spec, dump_default),
        highlight: parse_hotkey(&highlight_spec, highlight_default),
        dump_spec: dump_spec.clone(),
        highlight_spec: highlight_spec.clone(),
    };

    tauri::Builder::default()
        .manage(PendingText(Mutex::new(None)))
        .manage(HotkeyState(Mutex::new(initial)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if std::env::var("POSTY_DEBUG_KEYS").is_ok() {
                        println!("posty-desktop key event: shortcut id={} state={:?}", shortcut.id(), event.state);
                    }
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    // Read live state so overlay-rebound hotkeys work
                    // immediately, with no restart.
                    if let Some(st) = app.try_state::<HotkeyState>() {
                        if let Ok(hk) = st.0.lock() {
                            if *shortcut == hk.dump {
                                toggle_overlay(app);
                            } else if *shortcut == hk.highlight {
                                capture_highlight(app);
                            }
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![server_url, get_pending, open_widget, quit_app, hide_overlay, get_hotkeys, set_hotkeys])
        .on_window_event(|window, event| {
            // X on the overlay hides instead of destroying it — otherwise the
            // hotkey could never summon it back until restart.
            if window.label() == "overlay" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            let (dump_spec, highlight_spec) = {
                let st = app.state::<HotkeyState>();
                let hk = st.0.lock().unwrap();
                (hk.dump_spec.clone(), hk.highlight_spec.clone())
            };
            let dump = parse_hotkey(
                &dump_spec,
                Shortcut::new(
                    Some(Modifiers::CONTROL | Modifiers::SHIFT),
                    Code::Space,
                ),
            );
            let highlight = parse_hotkey(
                &highlight_spec,
                Shortcut::new(
                    Some(Modifiers::CONTROL | Modifiers::SHIFT),
                    Code::KeyH,
                ),
            );
            // Never die on taken hotkeys (second instance, another app): warn
            // and keep the overlay usable from the taskbar instead.
            let dump_ok = match app.global_shortcut().register(dump) {
                Ok(()) => true,
                Err(e) => {
                    println!("posty-desktop hotkeys: could not register {dump_spec} ({e}) — is another Posty running? The overlay still works from the taskbar.");
                    false
                }
            };
            let highlight_ok = match app.global_shortcut().register(highlight) {
                Ok(()) => true,
                Err(e) => {
                    println!("posty-desktop hotkeys: could not register {highlight_spec} ({e}) — is another Posty running? The overlay still works from the taskbar.");
                    false
                }
            };
            println!("posty-desktop hotkeys: overlay={dump_spec} highlight={highlight_spec}");
            // Headless self-check (POSTY_SELFCHECK=1): prove shortcut registration
            // plus clipboard/key-simulation deps, print, and exit. Registration
            // failure surfaces as a non-zero exit via the ? above.
            // Show the overlay on launch so first-run users see Posty immediately
            // (daily users can Esc it away; hotkeys summon it back anytime).
            // POSTY_HIDE_ON_LAUNCH=1 keeps it hidden (used by the hotkey e2e test).
            if std::env::var("POSTY_SELFCHECK").is_err() && std::env::var("POSTY_HIDE_ON_LAUNCH").is_err() {
                show_overlay(app.handle());
            }
            if std::env::var("POSTY_SELFCHECK").is_ok() {
                if !dump_ok || !highlight_ok {
                    println!("posty-desktop selfcheck: FAIL — a hotkey is already taken (another instance running?)");
                    std::process::exit(1);
                }
                println!("posty-desktop selfcheck: hotkeys registered dump={dump_spec} highlight={highlight_spec}");
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    match read_clipboard() {
                        Some(t) => println!("posty-desktop selfcheck: clipboard ok ({} chars staged)", t.len()),
                        None => println!("posty-desktop selfcheck: clipboard empty-or-unreadable"),
                    }
                    match Enigo::new(&Settings::default()) {
                        Ok(_) => println!("posty-desktop selfcheck: key simulation ready"),
                        Err(e) => println!("posty-desktop selfcheck: key simulation UNAVAILABLE ({e})"),
                    }
                    println!("posty-desktop selfcheck: PASS");
                    std::process::exit(0);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Posty desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_accepts_builtin_and_custom_specs() {
        assert!(spec_is_valid("ctrl+shift+space"));
        assert!(spec_is_valid("ctrl+shift+h"));
        assert!(spec_is_valid("alt+f9"));
        assert!(spec_is_valid("CTRL+SHIFT+J"));
        assert!(spec_is_valid("super+alt+t"));
    }

    #[test]
    fn strict_rejects_modifiers_only_and_garbage() {
        assert!(!spec_is_valid("ctrl+shift")); // no key: unregistrable
        assert!(!spec_is_valid("banana"));
        assert!(!spec_is_valid(""));
        assert!(!spec_is_valid("ctrl+shift+a+b")); // two keys
        assert!(!spec_is_valid("ctrl+shift+!"));
    }

    #[test]
    fn parse_matches_shortcut_parts() {
        let expect = Shortcut::new(
            Some(Modifiers::CONTROL | Modifiers::SHIFT),
            Code::Space,
        );
        assert!(parse_hotkey("ctrl+shift+space", expect) == expect);
        let expect_h = Shortcut::new(
            Some(Modifiers::CONTROL | Modifiers::SHIFT),
            Code::KeyH,
        );
        assert!(parse_hotkey("ctrl+shift+h", expect_h) == expect_h);
    }

    #[test]
    fn invalid_specs_fall_back_to_default() {
        let fallback = Shortcut::new(
            Some(Modifiers::CONTROL | Modifiers::SHIFT),
            Code::Space,
        );
        assert!(parse_hotkey("ctrl+shift", fallback) == fallback);
        assert!(parse_hotkey("nonsense", fallback) == fallback);
    }

    #[test]
    fn env_beats_file_beats_default() {
        assert_eq!(
            hotkey_spec("POSTY_HOTKEY_DUMP_DEFINITELY_UNSET", Some("alt+f9"), "ctrl+shift+space"),
            "alt+f9"
        );
        assert_eq!(
            hotkey_spec("POSTY_HOTKEY_DUMP_DEFINITELY_UNSET", None, "ctrl+shift+space"),
            "ctrl+shift+space"
        );
    }
}
