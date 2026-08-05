//! Driver Station log reading.
//!
//! The NI Driver Station writes two files per session into
//! `C:\Users\Public\Documents\FRC\Log Files\`:
//!
//! * `.dsevents` — timestamped text. Radio drops, brownouts, watchdog trips, the messages that
//!   scroll past in the DS window and are gone by the time anyone thinks to look.
//! * `.dslog` — a fixed-rate binary record of trip time, packet loss, battery, and CPU.
//!
//! These are the only place some of that data exists. The robot never sees its own packet loss,
//! because the packets that would have told it are the ones that went missing.
//!
//! **The formats are community-reverse-engineered, not documented by NI.** Everything here is
//! written to fail closed: a file whose header does not match a version we understand is reported as
//! unparsed rather than decoded into plausible nonsense. A dashboard that invents a battery voltage
//! is worse than one that admits it cannot read the file.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Seconds between the LabVIEW epoch (1904-01-01) and the Unix epoch (1970-01-01).
const LABVIEW_EPOCH_OFFSET: i64 = 2_082_844_800;

#[derive(Debug, Serialize, Clone)]
pub struct DsSession {
    pub name: String,
    pub path: String,
    pub modified_unix: i64,
    pub has_events: bool,
    pub has_log: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct DsEvent {
    /// Seconds since the start of the session.
    pub t: f64,
    pub text: String,
    /// `info` | `warn` | `error`, inferred from the text since the format carries no level.
    pub level: String,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct DsSamples {
    pub t: Vec<f64>,
    pub battery: Vec<f64>,
    pub trip_ms: Vec<f64>,
    pub loss_pct: Vec<f64>,
    pub cpu_pct: Vec<f64>,
    /// False when the header was not a version we understand — the vectors will be empty.
    pub parsed: bool,
    pub note: String,
}

/// Where the Driver Station keeps its logs. Overridable because teams do move it.
pub fn default_log_dir() -> PathBuf {
    PathBuf::from(r"C:\Users\Public\Documents\FRC\Log Files")
}

/// Most recent sessions first. Returns an empty list rather than an error when the DS has never run
/// on this machine, which is the normal case on a development box.
pub fn list_sessions(dir: &Path, limit: usize) -> Vec<DsSession> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut stems: std::collections::HashMap<String, (bool, bool, i64, PathBuf)> =
        std::collections::HashMap::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else { continue };
        let is_events = ext.eq_ignore_ascii_case("dsevents");
        let is_log = ext.eq_ignore_ascii_case("dslog");
        if !is_events && !is_log {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let slot = stems
            .entry(stem.to_string())
            .or_insert((false, false, modified, path.clone()));
        slot.0 |= is_events;
        slot.1 |= is_log;
        slot.2 = slot.2.max(modified);
    }

    let mut sessions: Vec<DsSession> = stems
        .into_iter()
        .map(|(name, (has_events, has_log, modified, path))| DsSession {
            name,
            path: path.with_extension("").to_string_lossy().to_string(),
            modified_unix: modified,
            has_events,
            has_log,
        })
        .collect();

    sessions.sort_by(|a, b| b.modified_unix.cmp(&a.modified_unix));
    sessions.truncate(limit);
    sessions
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    bytes
        .get(at..at + 4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn read_i64(bytes: &[u8], at: usize) -> Option<i64> {
    bytes.get(at..at + 8).map(|s| {
        i64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]])
    })
}

/// LabVIEW timestamps are 16 bytes: signed seconds since 1904, then an unsigned fraction.
fn labview_seconds(bytes: &[u8], at: usize) -> Option<f64> {
    let secs = read_i64(bytes, at)?;
    let frac = read_i64(bytes, at + 8).unwrap_or(0) as u64;
    Some((secs - LABVIEW_EPOCH_OFFSET) as f64 + (frac as f64 / (u64::MAX as f64)))
}

fn classify(text: &str) -> &'static str {
    let lower = text.to_ascii_lowercase();
    if lower.contains("error") || lower.contains("estop") || lower.contains("brownout") {
        "error"
    } else if lower.contains("warning")
        || lower.contains("lost")
        || lower.contains("dropped")
        || lower.contains("watchdog")
    {
        "warn"
    } else {
        "info"
    }
}

/// Parse a `.dsevents` file into timestamped messages relative to the session start.
pub fn read_events(path: &Path) -> Vec<DsEvent> {
    let Ok(bytes) = fs::read(path) else { return Vec::new() };
    if bytes.len() < 20 {
        return Vec::new();
    }

    // 4-byte version, then a 16-byte session-start timestamp.
    let version = read_u32(&bytes, 0).unwrap_or(0);
    if version == 0 || version > 8 {
        return Vec::new();
    }
    let Some(start) = labview_seconds(&bytes, 4) else { return Vec::new() };

    let mut out = Vec::new();
    let mut at = 20usize;

    // Records: 16-byte timestamp, 4-byte length, then UTF-8 text.
    while at + 20 <= bytes.len() {
        let Some(stamp) = labview_seconds(&bytes, at) else { break };
        let Some(len) = read_u32(&bytes, at + 16) else { break };
        let len = len as usize;
        let text_at = at + 20;
        if len > bytes.len().saturating_sub(text_at) || len > 8192 {
            break; // length ran off the end: the format is not what we assumed, so stop cleanly
        }
        let text = String::from_utf8_lossy(&bytes[text_at..text_at + len])
            .trim()
            .to_string();
        if !text.is_empty() {
            out.push(DsEvent {
                t: (stamp - start).max(0.0),
                level: classify(&text).to_string(),
                text,
            });
        }
        at = text_at + len;
    }
    out
}

/// Parse a `.dslog` into sampled telemetry.
///
/// Version 3 and 4 records are 10 bytes of fixed fields followed by PDP data whose width differs
/// between versions. Only the fixed part is decoded, and the PDP block is skipped by length, so a
/// version whose trailer we do not know still yields correct battery and packet statistics.
pub fn read_samples(path: &Path) -> DsSamples {
    let Ok(bytes) = fs::read(path) else {
        return DsSamples {
            parsed: false,
            note: "could not read file".into(),
            ..Default::default()
        };
    };
    if bytes.len() < 20 {
        return DsSamples {
            parsed: false,
            note: "file too short".into(),
            ..Default::default()
        };
    }

    let version = read_u32(&bytes, 0).unwrap_or(0);
    let pdp_len = match version {
        3 => 25usize,
        4 => 25usize,
        other => {
            return DsSamples {
                parsed: false,
                note: format!("unrecognised .dslog version {other} — not guessing at the layout"),
                ..Default::default()
            }
        }
    };

    let record = 10 + pdp_len;
    let mut out = DsSamples {
        parsed: true,
        note: format!("version {version}"),
        ..Default::default()
    };

    let mut at = 20usize;
    let mut index = 0usize;
    while at + record <= bytes.len() {
        let r = &bytes[at..at + record];

        // trip time is stored in half-milliseconds; loss is a straight percentage
        out.trip_ms.push(r[0] as f64 * 0.5);
        out.loss_pct.push(r[1] as f64);
        // battery is a fixed-point pair: whole volts, then 1/256ths
        out.battery.push(r[2] as f64 + (r[3] as f64 / 256.0));
        out.cpu_pct.push(r[4] as f64 * 0.5);
        // the DS samples at 50 Hz
        out.t.push(index as f64 * 0.02);

        at += record;
        index += 1;
    }

    if out.battery.is_empty() {
        out.parsed = false;
        out.note = "no records decoded".into();
    }
    out
}
