// Stage (Bun server + Swift overlay) is owned the same way, added 2026-10-13
// at the user's request ("make stage run on oni instead of ... always running
// in the bg"): it starts with the app and stops with it — see `spawn_stage`.
//
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

use std::fs::OpenOptions;
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const BACKEND_PORT: u16 = 8000;

struct ManagedProcesses {
    backend: Mutex<Option<Child>>,
    /// `bash stage/scripts/start.sh` — Stage's Bun server + Swift overlay,
    /// which live and die with this app (see `spawn_stage`).
    stage: Mutex<Option<Child>>,
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
    let mut command = Command::new(uvicorn);
    command.args([
        "assistant.server:app",
        "--host",
        "0.0.0.0",
        "--port",
        &BACKEND_PORT.to_string(),
    ]);
    // `--reload --reload-dir assistant` ONLY in debug builds (`npm run
    // tauri dev`) — a real, twice-reproduced incident (STEPS.md, 2026-09-23
    // and 2026-09-24) found this is not just a dev convenience but a real
    // reliability hazard: uvicorn's `--reload` supervisor spawns its actual
    // worker via Python's own `multiprocessing` (`spawn_main`), and when
    // that SUPERVISOR process dies (observed twice, root cause not fully
    // pinned down — the watcher itself, not the worker, is what disappears),
    // its worker is orphaned (reparented to launchd) holding the listening
    // socket, un-killable by a plain SIGTERM (`free_port` above), and unable
    // to ever reload or restart again — silently serving stale code for
    // hours/weeks, or in the second incident, simply hanging every request.
    // A packaged release build has no reason to carry this risk at all: its
    // own `assistant/` source never changes between runs the way a live dev
    // session's does, so there is nothing for `--reload` to usefully watch
    // for in the first place. `cfg!(debug_assertions)` is Tauri/Cargo's own
    // standard dev-vs-release switch — true for `tauri dev`, false for
    // `tauri build` — so this needs no separate build flag of its own.
    if cfg!(debug_assertions) {
        command.args(["--reload", "--reload-dir", "assistant"]);
    }
    command.current_dir(&root).spawn()
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

/// Start Stage (Backstage's agents + Onstage's hotkey/overlay) with the app,
/// so it no longer has to be left running by hand in the background.
///
/// This runs `stage/scripts/start.sh` rather than re-implementing it: that
/// script already stops any older Stage (found via the pid in Stage's
/// `server.json`, which also cleans up after an Oni crash that never got to
/// stop its own Stage), rebuilds the overlay only when its source is newer,
/// puts Bun on PATH, starts the server from `stage/` (where Bun finds
/// `.env`), then opens the overlay. It is NOT waited on: a stale overlay
/// triggers a few-second `swiftc` build, and nothing in the dashboard needs
/// Stage up to appear (`assistant/stage.py` reports "not running" cleanly).
///
/// Its output goes to `~/Library/Logs/PersonalAssistant/stage.log` (mode
/// 0600, truncated each launch) — it prints the panel URL including this
/// launch's token, which must not land in a world-readable file.
/// `ONI_NO_STAGE=1` skips this entirely (tests, a second dev instance).
fn spawn_stage() -> std::io::Result<Option<Child>> {
    if std::env::var_os("ONI_NO_STAGE").is_some() {
        eprintln!("[assistant] ONI_NO_STAGE set, not starting Stage");
        return Ok(None);
    }
    let root = project_root();
    let script = root.join("stage/scripts/start.sh");
    if !script.exists() {
        eprintln!("[assistant] {} not found, not starting Stage", script.display());
        return Ok(None);
    }
    let mut stdio = (Stdio::null(), Stdio::null());
    if let Some(home) = std::env::var_os("HOME") {
        let dir = PathBuf::from(home).join("Library/Logs/PersonalAssistant");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(log) = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(dir.join("stage.log"))
        {
            if let Ok(err) = log.try_clone() {
                stdio = (Stdio::from(log), Stdio::from(err));
            }
        }
    }
    eprintln!("[assistant] starting Stage: {}", script.display());
    Command::new("bash")
        .arg(&script)
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(stdio.0)
        .stderr(stdio.1)
        .spawn()
        .map(Some)
}

/// Stop Stage cleanly. `Child::kill()` is SIGKILL, which would skip
/// `start.sh`'s own `trap` (the thing that stops the Bun server and the
/// overlay) and leave both orphaned — so send SIGTERM first and let the
/// script clean up, give it a moment, and only then force it. The overlay is
/// then swept by name either way (the same match `start.sh` uses), since it
/// is launched through `open` and is not a child of the script.
fn stop_stage(mut child: Child) {
    let pid = child.id().to_string();
    let _ = Command::new("kill").args(["-TERM", &pid]).status();
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if matches!(child.try_wait(), Ok(None)) {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = Command::new("pkill")
        .args(["-f", "Stage Overlay.app/Contents/MacOS/StageOverlay"])
        .status();
}

fn kill_managed_processes(app_handle: &tauri::AppHandle) {
    let Some(state) = app_handle.try_state::<ManagedProcesses>() else {
        return;
    };
    // Stage first: it talks to nothing in the backend, but it is the slower
    // of the two to stop (SIGTERM + the script's own cleanup).
    if let Some(child) = state.stage.lock().unwrap().take() {
        eprintln!("[assistant] stopping Stage");
        stop_stage(child);
    }
    if let Some(mut child) = state.backend.lock().unwrap().take() {
        eprintln!("[assistant] stopping backend");
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
            let stage = match spawn_stage() {
                Ok(child) => child,
                Err(err) => {
                    // Same stance as the backend: a failed spawn must not
                    // stop Oni opening; Backstage/Onstage just report that
                    // Stage isn't running.
                    eprintln!("[assistant] failed to start Stage: {err}");
                    None
                }
            };
            app.manage(ManagedProcesses {
                backend: Mutex::new(backend),
                stage: Mutex::new(stage),
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
