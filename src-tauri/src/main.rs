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

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dslog;
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ds_sessions,
            ds_events,
            ds_samples,
            ds_log_dir,
            nt_set,
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
            std::thread::spawn(move || loop {
                std::thread::sleep(nt4::flush_interval());
                if !dirty.swap(false, Ordering::Relaxed) {
                    continue;
                }
                let (values, status) = pump.snapshot();
                let _ = handle.emit("nt", Frame { values, status });
            });

            app.manage(AppState { nt });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Catalyst Console");
}
