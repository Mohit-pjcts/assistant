// Phase 14 packaging step (STEPS.md 71/72): the Tauri shell owns the
// Python backend's process lifecycle instead of it being started by hand
// in a terminal (the Phase 10 park note's "backend lifecycle" deferred-
// debt item, and Phase 9 step 2's original TODO). Scope, confirmed with
// the user at the Phase 14 packaging checkpoint: manage the EXISTING
// dev-mode `.venv` processes directly — NOT a frozen/portable bundle
// (PyInstaller-style). That's a much larger, separate undertaking
// (mlx-whisper alone makes a fully portable freeze impractical) and isn't
// needed for a single-machine personal app. `PROJECT_ROOT` is therefore
// resolved via `CARGO_MANIFEST_DIR` (stable at compile time regardless of
// how the binary is invoked) rather than the runtime working directory,
// and points at THIS checkout's `.venv` — this will not work from a
// relocated/packaged .app bundle, which is an accepted limitation of the
// chosen scope, not an oversight.

use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const BACKEND_PORT: u16 = 8000;

struct ManagedProcesses {
    backend: Mutex<Option<Child>>,
    voice_daemon: Mutex<Option<Child>>,
}

fn project_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = .../dashboard/src-tauri — walk up two levels to
    // the actual project root (dashboard/ -> PA/), where .venv/ and
    // assistant/ live.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("src-tauri is expected to be nested two levels under the project root")
        .to_path_buf()
}

/// True if `port` is currently free (and leaves it free — the bind is
/// dropped immediately). False if something is already listening.
fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Kill whatever is listening on `port`, if anything. Best-effort: this
/// exists specifically because Tauri's OWN dev-mode auto-rebuild-and-
/// relaunch (on every `src-tauri` change) would otherwise collide with a
/// still-running previous instance's backend — the exact "stale process
/// serving old code" failure mode STEPS.md 70 diagnosed by hand. Argv-only
/// subprocess calls throughout (`lsof` then `kill`, never a shell
/// pipeline), matching this project's own execution-side security
/// philosophy even though this Rust code has no untrusted input to worry
/// about.
fn free_port(port: u16) {
    if port_is_free(port) {
        return;
    }
    let Ok(output) = Command::new("lsof")
        .args(["-ti", &format!(":{port}")])
        .output()
    else {
        eprintln!("[assistant] could not run lsof to free port {port}");
        return;
    };
    for pid in String::from_utf8_lossy(&output.stdout).lines() {
        let pid = pid.trim();
        if pid.is_empty() {
            continue;
        }
        eprintln!("[assistant] port {port} in use by pid {pid}, killing it to start fresh");
        let _ = Command::new("kill").arg(pid).status();
    }
}

/// Spawn `uvicorn assistant.server:app` from this checkout's `.venv`,
/// with the project root as its working directory (assistant/'s own
/// relative paths — workspace/, the SQLite files — are anchored there,
/// same as when a person runs it by hand from that directory).
///
/// `--host 0.0.0.0` (not the default loopback-only bind) as of the
/// iPhone-access feature: lets a phone on the same Tailscale mesh (or LAN)
/// reach this server directly. Safe to widen here specifically because
/// nothing forwards this port from the router to the public internet —
/// only devices that can already route to the Mac (same LAN, or a
/// Tailscale peer) can reach it either way. The Tauri app itself keeps
/// talking to 127.0.0.1 exactly as before (see `wait_for_backend` below
/// and `api.ts`'s Tauri-vs-browser origin detection) — this only ADDS
/// reachability, it doesn't change how the desktop app connects.
///
/// `--reload --reload-dir assistant` (live-dev-app feature): auto-restarts
/// the backend on a Python source change, same "always live" goal as the
/// frontend's `build:watch` (run-oni-dev.sh) — both the desktop window and
/// the phone/PWA path share this ONE backend process, so this single flag
/// covers both. `--reload-dir` is deliberately scoped to `assistant/`
/// ONLY, not the default (the whole current_dir, i.e. the project root) —
/// the project root also contains `conversation_memory.sqlite`/
/// `threads.sqlite`/`board.sqlite`/`long_term_memory.sqlite` (written on
/// nearly every turn), `workspace/`, `node_modules/`, and `.venv/`;
/// watching any of those would mean either constant spurious restarts
/// mid-conversation (the sqlite WAL files) or a pointlessly expensive
/// watch tree (node_modules/.venv). `watchfiles` (uvicorn's reloader
/// backend) confirmed already installed in this project's `.venv` before
/// adding this — the flag silently no-ops without it, per uvicorn's own
/// `--help` text, so this was verified rather than assumed.
fn spawn_backend() -> std::io::Result<Child> {
    let root = project_root();
    let uvicorn = root.join(".venv/bin/uvicorn");
    free_port(BACKEND_PORT);
    eprintln!("[assistant] starting backend: {}", uvicorn.display());
    Command::new(uvicorn)
        .args([
            "assistant.server:app",
            "--host",
            "0.0.0.0",
            "--port",
            &BACKEND_PORT.to_string(),
            "--reload",
            "--reload-dir",
            "assistant",
        ])
        .current_dir(&root)
        .spawn()
}

/// Kill any process whose command line matches `pattern` (via `pgrep -f`).
/// The voice daemon has no port to probe the way `free_port` checks the
/// backend, so this is the equivalent collision-avoidance check for it —
/// same "always start fresh" guarantee, different detection mechanism.
fn free_process_matching(pattern: &str) {
    let Ok(output) = Command::new("pgrep").args(["-f", pattern]).output() else {
        eprintln!("[assistant] could not run pgrep to check for {pattern}");
        return;
    };
    for pid in String::from_utf8_lossy(&output.stdout).lines() {
        let pid = pid.trim();
        if pid.is_empty() {
            continue;
        }
        eprintln!("[assistant] {pattern} already running as pid {pid}, killing it to start fresh");
        let _ = Command::new("kill").arg(pid).status();
    }
}

/// Spawn the voice daemon (`assistant-voice`, the console-script entry
/// point — `assistant/voice_daemon.py`'s rumps menu-bar app) the same way
/// the backend is spawned. Phase 14 packaging checkpoint: Tauri is now the
/// SOLE owner of this process's lifecycle — the prior launchd LaunchAgent
/// (`launchd/com.mohitvuyyuru.assistant-voice.plist`) was unloaded and its
/// installed copy removed from `~/Library/LaunchAgents` in this same pass,
/// specifically to avoid two independent mechanisms fighting over one
/// process (the exact dual-ownership confusion STEPS.md 70 diagnosed for
/// the backend). The daemon's own behavior — hotkey, mic, STT/TTS, TCC
/// permissions (pinned to this same `.venv/bin/assistant-voice` path,
/// STEPS.md 42) — is completely untouched; only WHO starts/stops the
/// process changed. The repo's `launchd/*.plist` is kept as-is for
/// reference/rollback, not deleted.
fn spawn_voice_daemon() -> std::io::Result<Child> {
    let root = project_root();
    let binary = root.join(".venv/bin/assistant-voice");
    free_process_matching(".venv/bin/assistant-voice");
    eprintln!("[assistant] starting voice daemon: {}", binary.display());
    Command::new(binary).current_dir(&root).spawn()
}

/// Block `setup()` (and therefore the main window's appearance — Tauri
/// creates the configured window right after `setup()` returns) until the
/// backend accepts a TCP connection, or `timeout` elapses. PLAN.md Phase 19:
/// belt-and-suspenders for `api.ts`'s own `fetchWithRetry` — the frontend
/// already retries past whatever this waits, so this doesn't need to be
/// bulletproof, just enough to avoid the window flashing an empty chat
/// during the ~1-2s uvicorn + langgraph import normally takes.
fn wait_for_backend(port: u16, timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    eprintln!("[assistant] backend not ready after {timeout:?}, showing window anyway");
}

fn kill_managed_processes(app_handle: &tauri::AppHandle) {
    let Some(state) = app_handle.try_state::<ManagedProcesses>() else {
        return;
    };
    if let Some(mut child) = state.backend.lock().unwrap().take() {
        eprintln!("[assistant] stopping backend");
        let _ = child.kill();
        let _ = child.wait();
    };
    if let Some(mut child) = state.voice_daemon.lock().unwrap().take() {
        eprintln!("[assistant] stopping voice daemon");
        let _ = child.kill();
        let _ = child.wait();
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let backend = match spawn_backend() {
                Ok(child) => {
                    wait_for_backend(BACKEND_PORT, Duration::from_secs(10));
                    Some(child)
                }
                Err(err) => {
                    // Don't crash the app over a failed spawn — the
                    // dashboard's own panels already show a clear
                    // connection error if the backend isn't reachable,
                    // which is no worse than today's "started by hand"
                    // baseline.
                    eprintln!("[assistant] failed to start backend: {err}");
                    None
                }
            };
            let voice_daemon = match spawn_voice_daemon() {
                Ok(child) => Some(child),
                Err(err) => {
                    eprintln!("[assistant] failed to start voice daemon: {err}");
                    None
                }
            };
            app.manage(ManagedProcesses {
                backend: Mutex::new(backend),
                voice_daemon: Mutex::new(voice_daemon),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Found live: relying on ExitRequested alone left both children
            // orphaned after a Quit-menu/Apple-Event-driven quit (confirmed
            // twice) — ExitRequested is cancelable and fires BEFORE
            // teardown starts, but isn't guaranteed to be the event this
            // particular quit path emits before the process is gone.
            // `Exit` is the final, non-cancelable event right before the
            // process actually terminates — matching on both is safe
            // (kill_managed_processes is idempotent via Option::take(), so
            // whichever fires first does the real work and the second is a
            // no-op) and catches whichever one this quit path actually
            // sends.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                kill_managed_processes(app_handle);
            }
        });
}
