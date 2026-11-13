@echo off
rem Posty desktop launcher: starts the server, which launches the companion
rem itself. The companion is started directly only if it still isn't running
rem afterwards — a second instance would have no hotkeys.
cd /d "%~dp0.."
echo [Posty] Starting the server in a new window (keep it open)...
start "Posty server - keep this window open" cmd /k "npm start"
echo [Posty] Waiting for the server (it launches the companion itself)...
timeout /t 10 /nobreak >nul
tasklist /FI "IMAGENAME eq posty-desktop.exe" 2>nul | find /i "posty-desktop.exe" >nul
if not errorlevel 1 goto :already
if not exist "desktop\src-tauri\target\debug\posty-desktop.exe" (
  echo [Posty] First run: building the desktop app, this takes a few minutes...
  cargo build --manifest-path desktop\src-tauri\Cargo.toml
  if errorlevel 1 (
    echo [Posty] Build failed. Is Rust installed? See https://rustup.rs
    pause
    exit /b 1
  )
)
tasklist /FI "IMAGENAME eq posty-desktop.exe" 2>nul | find /i "posty-desktop.exe" >nul
if not errorlevel 1 goto :already
echo [Posty] Starting the desktop companion...
start "" "desktop\src-tauri\target\debug\posty-desktop.exe"
goto :done
:already
echo [Posty] Companion already running.
:done
echo.
echo [Posty] Done. The brain-dump window should be visible.
echo Press Ctrl+Shift+Space anywhere to summon it, Ctrl+Shift+H to capture a highlight.
echo If the window hides and the hotkey stops working, run: taskkill /F /IM posty-desktop.exe
echo and then start just ONE of: npm start, or this file.
pause
