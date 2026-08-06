// Catalyst Console — a driver station companion.
//
// It reads and displays. It does not enable the robot, and it never will: FRC requires the official
// NI Driver Station, only one DS may hold the robot connection, and a dashboard that fights for that
// socket is a dashboard that loses a match. Everything here is read-only by construction — there is
// no code path that writes a control packet.
//
// The other rule the whole design answers to: **nothing the console does may impede driving.** No
// modal blocks the view, no check gates anything, no failure of ours stops a driver doing their job.
// If the console cannot reach the robot it says so quietly in a corner and keeps rendering.
//
// The binary has two modes. With no arguments it opens the dashboard. With `--mcp` it opens nothing
// and serves read-only diagnostics over stdio instead, for an agent rather than a driver — see
// `mcp.rs`, and `--help`, which exists because a binary that does something different based on an
// argument owes anyone who finds it an explanation.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dslog;
mod mcp;
mod nt4;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// Owns the NT client for the lifetime of the app, and is how `nt_set` reaches it.
struct AppState {
    nt: Arc<nt4::Nt4Client>,
}

#[derive(Serialize, Clone)]
struct Frame {
    values: std::collections::HashMap<String, nt4::NtValue>,
    status: nt4::NtStatus,
}

/// Candidate robot addresses, tried in order and cycled until one answers.
///
/// Covers every situation the same build has to work in: simulation on this machine, the field's
/// mDNS name, the pit's static IP, and the USB tether.
fn candidate_addresses(team: u16) -> Vec<String> {
    vec![
        "127.0.0.1".to_string(),
        format!("roborio-{team}-frc.local"),
        format!("10.{}.{}.2", team / 100, team % 100),
        "172.22.11.2".to_string(),
    ]
}

/// The team whose robot code Catalyst was first ported onto. It is only a starting value — every
/// other team changes it once, from the console itself, and it is remembered from then on.
const DEFAULT_TEAM: u16 = 5805;

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Settings {
    team: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self { team: DEFAULT_TEAM }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("settings.json"))
}

/// Missing, unreadable, or malformed settings all fall back to the default rather than failing the
/// launch. A corrupt preferences file must never be the reason a driver has no dashboard.
fn load_settings(app: &tauri::AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("no config directory")?;
    let body = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

/// The bundle identifier, which is also the directory Tauri keeps settings in. Must match
/// `identifier` in `tauri.conf.json`.
const IDENTIFIER: &str = "com.frccatalyst.console";

/// The same settings file the dashboard uses, found without a Tauri handle.
///
/// `--mcp` never builds a Tauri app, so there is no `AppHandle` to ask for `app_config_dir()` and
/// the path is rebuilt from the identifier instead. If the two ever drift apart the only consequence
/// is that the MCP server looks for the default team's robot, which `--team` overrides — not a
/// reason to refuse to start.
fn settings_from_disk() -> Settings {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));

    base.map(|b| b.join(IDENTIFIER).join("settings.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn team_number(app: tauri::AppHandle) -> u16 {
    load_settings(&app).team
}

/// Change which robot the console looks for. Takes effect on the next connection attempt, which is at
/// most a second or so away while disconnected.
#[tauri::command]
fn set_team_number(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    team: u16,
) -> Result<(), String> {
    if team == 0 || team > 9999 {
        return Err("team number must be between 1 and 9999".into());
    }
    save_settings(&app, &Settings { team })?;
    state.nt.set_addresses(candidate_addresses(team));
    Ok(())
}

#[tauri::command]
fn ds_sessions(dir: Option<String>) -> Vec<dslog::DsSession> {
    let path = dir.map(PathBuf::from).unwrap_or_else(dslog::default_log_dir);
    dslog::list_sessions(&path, 40)
}

#[tauri::command]
fn ds_events(path: String) -> Vec<dslog::DsEvent> {
    dslog::read_events(&PathBuf::from(format!("{path}.dsevents")))
}

#[tauri::command]
fn ds_samples(path: String) -> dslog::DsSamples {
    dslog::read_samples(&PathBuf::from(format!("{path}.dslog")))
}

#[tauri::command]
fn ds_log_dir() -> String {
    dslog::default_log_dir().to_string_lossy().to_string()
}

/// What an update check found, in the shape the dashboard wants to render.
#[derive(Serialize, Clone, Default)]
struct UpdateInfo {
    available: bool,
    version: String,
    current: String,
    notes: String,
    error: String,
}

/// Look for a newer release, without ever getting in the way.
///
/// Returns rather than throws on failure. A driver station is regularly on a field network with no
/// route to the internet, and "could not reach GitHub" is the normal case there, not an error worth
/// showing anyone. The dashboard shows a chip when there is something to install and nothing at all
/// otherwise — no dialog, no modal, and never a prompt between a driver and their robot.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> UpdateInfo {
    use tauri_plugin_updater::UpdaterExt;

    let current = app.package_info().version.to_string();
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return UpdateInfo { current, error: e.to_string(), ..Default::default() };
        }
    };
    match updater.check().await {
        Ok(Some(update)) => UpdateInfo {
            available: true,
            version: update.version.clone(),
            current,
            notes: update.body.clone().unwrap_or_default(),
            error: String::new(),
        },
        Ok(None) => UpdateInfo { current, ..Default::default() },
        Err(e) => UpdateInfo { current, error: e.to_string(), ..Default::default() },
    }
}

/// Download and install the update, then restart.
///
/// Only ever called from an explicit click. Restarting a dashboard is not something to do to someone
/// who did not ask for it, and least of all mid-match.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "already up to date".to_string())?;

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    app.restart();
}

/// The current values and link status, on demand.
///
/// The push path above is the normal one. This exists because a dashboard that quietly stops updating
/// is worse than one that costs a few extra IPC round trips: if no pushed frame arrives shortly after
/// launch, the frontend falls back to calling this on a timer and the driver still sees live numbers.
#[tauri::command]
fn nt_frame(state: tauri::State<'_, AppState>) -> Frame {
    let (values, status) = state.nt.snapshot();
    Frame { values, status }
}

/// Namespaces the console will not write to, whatever the frontend asks for.
///
/// `/FMSInfo` is the driver station's own view of the match — alliance, station, and the control word
/// that says whether the robot is enabled. Robot code and dashboards read it; only the DS writes it.
/// Nothing in this app has a reason to touch it, so the guard lives here at the boundary rather than
/// relying on the UI to never ask.
const PROTECTED: &[&str] = &["/FMSInfo", "/.schema"];

/// Write a value to NetworkTables.
///
/// This is a plain dashboard write, the same one Shuffleboard and Elastic make: a tunable, an auto
/// chooser selection. It is not, and cannot become, robot control — enabling a robot happens over the
/// DS protocol on a socket this app never opens.
#[tauri::command]
fn nt_set(state: tauri::State<'_, AppState>, key: String, value: serde_json::Value) -> Result<(), String> {
    if !key.starts_with('/') {
        return Err("key must be an absolute NetworkTables path".into());
    }
    if PROTECTED.iter().any(|p| key.starts_with(p)) {
        return Err(format!("{key} is read-only"));
    }

    let set = match value {
        serde_json::Value::Bool(b) => nt4::SetValue::Bool(b),
        serde_json::Value::Number(n) => nt4::SetValue::Num(n.as_f64().ok_or("not a finite number")?),
        serde_json::Value::String(s) => nt4::SetValue::Str(s),
        other => return Err(format!("unsupported value type: {other}")),
    };
    state.nt.set(key, set);
    Ok(())
}

/// What the command line asked for.
enum Mode {
    /// Open the dashboard. The overwhelmingly normal case.
    Gui,
    /// Serve read-only diagnostics over stdio and open nothing.
    Mcp { team: Option<u16> },
    Help,
}

const HELP: &str = "\
Catalyst Console — a read-only driver station companion.

USAGE
  catalyst-console                open the dashboard window (the normal way to run it)
  catalyst-console --mcp          serve read-only diagnostics over stdin/stdout; no window
  catalyst-console --team NUMBER  which robot to look for; only meaningful with --mcp, since the
                                  dashboard keeps its own team number in settings
  catalyst-console --help         this text

THE TWO MODES
  With no arguments the binary opens a window, connects to NetworkTables, and draws a dashboard.

  With --mcp it opens no window at all. It connects to NetworkTables the same way, and instead of
  drawing anything it speaks the Model Context Protocol on stdin and stdout: JSON-RPC 2.0, one
  message per line, with initialize, tools/list and tools/call. The tools report console status,
  NetworkTables topics and values, robot alerts, Physics Core state, match state, Driver Station
  logs, and the field collision map. Nothing is printed to stdout except protocol frames; anything
  else goes to stderr.

  Every tool is read-only, and that is the design rather than an unfinished feature. FRC requires
  the official NI Driver Station and only one DS may hold the robot connection, so a tool that
  could enable or drive would be a second control path to a robot. There is none, and there will
  not be one.

  See docs/mcp.md.
";

/// Read the command line.
///
/// Unrecognised arguments are ignored rather than refused. The console is launched by shortcuts, by
/// the updater, and by a second instance handing off, and none of those is worth failing a launch
/// over — a driver wants their dashboard, not a usage message.
fn parse_args<I: Iterator<Item = String>>(mut args: I) -> Mode {
    let mut mcp = false;
    let mut help = false;
    let mut team = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--mcp" => mcp = true,
            "--help" | "-h" | "/?" => help = true,
            "--team" => team = args.next().and_then(|t| t.parse::<u16>().ok()),
            other => {
                if let Some(value) = other.strip_prefix("--team=") {
                    team = value.parse::<u16>().ok();
                }
            }
        }
    }

    if help {
        Mode::Help
    } else if mcp {
        Mode::Mcp { team }
    } else {
        Mode::Gui
    }
}

/// Release builds link as a GUI application so double-clicking the icon does not flash a console
/// window. That also means a release binary run from a terminal has no console to write to, and
/// `--help` would print into nothing. Borrowing the parent's console costs one call and is the
/// difference between a documented flag and a flag that appears to do nothing.
///
/// Failure is fine and expected: there is no parent console when an agent spawns the server with
/// pipes, and pipes are inherited regardless.
#[cfg(windows)]
fn attach_parent_console() {
    // SAFETY: a call with no arguments to reference and no state of ours to invalidate. It either
    // attaches the parent's console or reports that there was not one.
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(
            windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
        );
    }
}

#[cfg(not(windows))]
fn attach_parent_console() {}

/// Serve diagnostics and never open a window.
fn run_mcp(team_override: Option<u16>) {
    let team = team_override.unwrap_or_else(|| settings_from_disk().team);
    let addresses = candidate_addresses(team);

    let nt = Arc::new(nt4::Nt4Client::new());
    nt.spawn(addresses.clone());

    // stderr, not stdout: stdout is the protocol and nothing else may appear on it.
    eprintln!(
        "[mcp] catalyst-console {} — read-only diagnostics for team {team}",
        env!("CARGO_PKG_VERSION")
    );
    mcp::serve(nt, addresses, team);
}

fn main() {
    match parse_args(std::env::args().skip(1)) {
        Mode::Help => {
            attach_parent_console();
            print!("{HELP}");
        }
        Mode::Mcp { team } => {
            attach_parent_console();
            run_mcp(team);
        }
        Mode::Gui => run_gui(),
    }
}

fn run_gui() {
    tauri::Builder::default()
        // Must be registered first. A second launch never gets as far as opening a window: it hands
        // its arguments to the console that is already running, raises that window, and exits. Two
        // consoles would mean two NT clients on one robot and a driver reading whichever happened to
        // be on top, so double-clicking the icon again brings the real one forward instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ds_sessions,
            ds_events,
            ds_samples,
            ds_log_dir,
            nt_frame,
            nt_set,
            check_update,
            install_update,
            team_number,
            set_team_number
        ])
        .setup(|app| {
            let team = load_settings(app.handle()).team;
            let nt = Arc::new(nt4::Nt4Client::new());
            nt.spawn(candidate_addresses(team));

            let handle = app.handle().clone();
            let pump = Arc::clone(&nt);
            let dirty = pump.dirty();

            // One timer, one event per tick, only when something actually changed. The webview is
            // never asked to do work on a frame where the robot said nothing new.
            std::thread::spawn(move || {
                let mut reported = false;
                loop {
                    std::thread::sleep(nt4::flush_interval());
                    if !dirty.swap(false, Ordering::Relaxed) {
                        continue;
                    }
                    let (values, status) = pump.snapshot();
                    // A failure here means the dashboard is showing stale numbers with no way to know
                    // it. Say so once rather than swallowing it forever.
                    if let Err(e) = handle.emit("nt", Frame { values, status }) {
                        if !reported {
                            reported = true;
                            eprintln!("[console] could not reach the webview: {e}");
                        }
                    }
                }
            });

            app.manage(AppState { nt });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Catalyst Console");
}
