//! A read-only diagnostics server, spoken as MCP over stdin and stdout.
//!
//! `catalyst-console --mcp` starts this *instead of* opening a window. It connects to NetworkTables
//! exactly as the dashboard does and serves what it finds as tools, so an agent can ask what the
//! robot is publishing, what the alerts say and what the Driver Station logged, rather than a human
//! reading numbers off a screen and typing them somewhere else.
//!
//! **Every tool here reads. None of them writes, and none of them may ever be made to.** That is not
//! an unfinished feature to fill in later — it is the first of the three rules holding. FRC requires
//! the official NI Driver Station and only one DS may hold the robot connection; a tool that could
//! enable, disable or drive would be a second control path to a robot, which is the one thing this
//! product must not have. If you are here to add `drive`, `enable`, `set_tunable` or anything else
//! that changes the robot's behaviour: don't. The dashboard's own `nt_set` is deliberately not
//! reachable from this file.
//!
//! The protocol is implemented directly rather than through an SDK. What is needed is JSON-RPC 2.0
//! with `initialize`, `tools/list` and `tools/call`, one JSON object per line — a few hundred lines,
//! against a dependency that would be more code to audit than the code it replaces in a binary that
//! ships to a driver station laptop.
//!
//! stdout carries protocol frames and nothing else, because anything else on it corrupts the stream.
//! Everything worth saying to a human goes to stderr, which is where the NT client already logs.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};

use crate::dslog;
use crate::nt4::{self, NtValue};

/// Spec revisions whose tool surface is the one implemented here. A client asking for any of them
/// gets that same string back; anything else is answered with the newest we know, which is what the
/// spec asks a server to do when it cannot speak the requested version.
const KNOWN_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";

/// Alert group used when the caller does not name one. Catalyst's `AlertManager` publishes here.
const DEFAULT_ALERT_GROUP: &str = "/Catalyst/Alerts";

const FIELD_MAP_NAME: &str = "field-collision.json";

pub struct Server {
    nt: Arc<nt4::Nt4Client>,
    addresses: Vec<String>,
    team: u16,
    started: Instant,
}

/// Serve until stdin closes.
///
/// The NT client is already spawned by the caller and reconnects on its own forever, so there is
/// nothing to supervise here: a tool called while the robot is unreachable answers with the same
/// honesty the dashboard shows, which is to say it reports the absence instead of a zero.
pub fn serve(nt: Arc<nt4::Nt4Client>, addresses: Vec<String>, team: u16) {
    let server = Server { nt, addresses, team, started: Instant::now() };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[mcp] stdin: {e}");
                break;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Notifications produce nothing. Writing an empty line back would be a protocol error.
        let Some(response) = server.handle(line) else { continue };

        // A client that has gone away is the normal way this ends, not a failure to report loudly.
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

impl Server {
    /// One inbound frame in, at most one outbound frame out.
    fn handle(&self, line: &str) -> Option<String> {
        let message: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            // Nothing parsed, so there is no id to answer under. JSON-RPC says use null.
            Err(e) => return Some(error(Value::Null, -32700, &format!("parse error: {e}"))),
        };

        let method = message.get("method").and_then(|m| m.as_str()).unwrap_or("");
        // An absent id means a notification: acknowledge nothing, answer nothing, not even an error.
        let Some(id) = message.get("id").cloned() else {
            return None;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "initialize" => Some(ok(id, self.initialize(&params))),
            "ping" => Some(ok(id, json!({}))),
            "tools/list" => Some(ok(id, json!({ "tools": tool_definitions() }))),
            "tools/call" => Some(self.call_tool(id, &params)),
            "" => Some(error(id, -32600, "invalid request: no method")),
            other => Some(error(id, -32601, &format!("method not found: {other}"))),
        }
    }

    fn initialize(&self, params: &Value) -> Value {
        let asked = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or("");
        let version = if KNOWN_PROTOCOL_VERSIONS.contains(&asked) {
            asked
        } else {
            DEFAULT_PROTOCOL_VERSION
        };

        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": {
                "name": "catalyst-console",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "instructions": "Read-only diagnostics for a Catalyst Console driver station. \
                Every tool reports what the robot is actually publishing and says so plainly when a \
                topic is absent — an absent value is null with published:false, never a zero. There \
                is no tool that commands the robot and there will not be one: only the official NI \
                Driver Station may hold that connection.",
        })
    }

    fn call_tool(&self, id: Value, params: &Value) -> String {
        let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

        let result = match name {
            "console_status" => Ok(self.console_status()),
            "nt_list" => Ok(self.nt_list(&args)),
            "nt_get" => self.nt_get(&args),
            "alerts" => Ok(self.alerts(&args)),
            "physics" => Ok(self.physics()),
            "match_state" => Ok(self.match_state()),
            "ds_sessions" => Ok(ds_sessions(&args)),
            "ds_events" => ds_events(&args),
            "field_map" => Ok(field_map(&args)),
            "" => return error(id, -32602, "tools/call needs a tool name"),
            other => return error(id, -32602, &format!("unknown tool: {other}")),
        };

        // A tool that could not do its job reports that inside the result, per the MCP spec, so the
        // agent can read the reason and try something else instead of the call blowing up.
        match result {
            Ok(payload) => ok(id, content(&payload, false)),
            Err(message) => ok(id, content(&json!({ "error": message }), true)),
        }
    }

    // ------------------------------------------------------------------------------ the tools

    fn console_status(&self) -> Value {
        let (_, status) = self.nt.snapshot();

        // An RTT measured on a link that has since dropped is a stale number, and a zero one is a
        // link whose first timestamp handshake has not come back yet. Neither is a round trip, so
        // neither is reported as one.
        let rtt = if status.connected && status.rtt_ms > 0.0 {
            json!(round(status.rtt_ms, 2))
        } else {
            Value::Null
        };

        // The address is empty for the first instant of the process, before the connect loop has
        // picked its first candidate. Reporting "" would be a value where there is not one yet.
        let address = if status.address.is_empty() { Value::Null } else { json!(status.address) };
        let (connected_to, attempting) = if status.connected {
            (address, Value::Null)
        } else {
            (Value::Null, address)
        };

        let uptime = self.started.elapsed().as_secs_f64();
        let mut out = json!({
            "version": env!("CARGO_PKG_VERSION"),
            "mode": "mcp",
            "connected": status.connected,
            "address": connected_to,
            "attempting": attempting,
            "team": self.team,
            "addresses": self.addresses,
            "rtt_ms": rtt,
            "topics": status.topics,
            "uptime_s": round(uptime, 1),
        });

        // Distinguish "no robot" from "has not finished looking yet". Each candidate address gets
        // just over a second before the next is tried, so the first few seconds of a fresh server
        // legitimately look like a disconnected one.
        if !status.connected {
            let note = if uptime < self.addresses.len() as f64 * 2.0 {
                "not connected yet — still working through the candidate addresses"
            } else {
                "no robot found on any candidate address"
            };
            out["note"] = json!(note);
        }
        out
    }

    fn nt_list(&self, args: &Value) -> Value {
        let filter = args.get("filter").and_then(|f| f.as_str()).unwrap_or("").to_lowercase();
        let limit = args.get("limit").and_then(|l| l.as_u64()).unwrap_or(200).clamp(1, 5000) as usize;

        let (values, status) = self.nt.snapshot();
        let mut names: Vec<&String> = values
            .keys()
            .filter(|k| filter.is_empty() || k.to_lowercase().contains(&filter))
            .collect();
        names.sort();

        let matched = names.len();
        let shown: Vec<&String> = names.into_iter().take(limit).collect();

        let mut out = json!({
            "connected": status.connected,
            "total": values.len(),
            "matched": matched,
            "shown": shown.len(),
            "truncated": matched > shown.len(),
            "topics": shown,
        });
        if !status.connected {
            out["note"] = json!(
                "not connected — this is the last set of topics seen, which may be empty and may be stale"
            );
        }
        out
    }

    fn nt_get(&self, args: &Value) -> Result<Value, String> {
        let key = args
            .get("key")
            .and_then(|k| k.as_str())
            .ok_or_else(|| "nt_get needs a key".to_string())?;

        let (values, status) = self.nt.snapshot();
        match values.get(key) {
            Some(v) => Ok(json!({
                "key": key,
                "published": true,
                "type": type_name(v),
                "value": value_json(v),
                "connected": status.connected,
            })),
            // Rule 3 lives here. A topic nobody has published has no value, and inventing a zero or
            // an empty string for it would make an agent confidently wrong.
            None => Ok(json!({
                "key": key,
                "published": false,
                "type": Value::Null,
                "value": Value::Null,
                "connected": status.connected,
                "note": "no such topic has been received on this connection — \
                         use nt_list to see what exists",
            })),
        }
    }

    fn alerts(&self, args: &Value) -> Value {
        let group = args
            .get("group")
            .and_then(|g| g.as_str())
            .unwrap_or(DEFAULT_ALERT_GROUP)
            .trim_end_matches('/');

        let (values, _) = self.nt.snapshot();

        // Catalyst's AlertManager publishes Errors / Warnings / Info; WPILib's own Alerts widget
        // uses errors / warnings / infos. Read whichever is there rather than making a team pick,
        // and say which one was found so a mismatch is diagnosable rather than just empty.
        let pick = |suffixes: &[&str]| -> Option<(String, Vec<String>)> {
            for suffix in suffixes {
                let key = format!("{group}/{suffix}");
                if let Some(v) = values.get(&key) {
                    let list = match v {
                        NtValue::Strs(s) => s.clone(),
                        NtValue::Str(s) => vec![s.clone()],
                        _ => continue,
                    };
                    return Some((key, list));
                }
            }
            None
        };

        let errors = pick(&["Errors", "errors"]);
        let warnings = pick(&["Warnings", "warnings"]);
        let info = pick(&["Info", "infos", "Infos"]);
        let present = errors.is_some() || warnings.is_some() || info.is_some();

        // An absent alert group is not a robot with no alerts. Empty arrays would read as "all
        // clear", which is the most dangerous wrong answer this tool could give, so absence stays
        // null and says why.
        let field = |found: &Option<(String, Vec<String>)>| match found {
            Some((_, list)) => json!(list),
            None => Value::Null,
        };
        let source = |found: &Option<(String, Vec<String>)>| match found {
            Some((key, _)) => json!(key),
            None => Value::Null,
        };

        let mut out = json!({
            "group": group,
            "present": present,
            "errors": field(&errors),
            "warnings": field(&warnings),
            "info": field(&info),
            "sources": {
                "errors": source(&errors),
                "warnings": source(&warnings),
                "info": source(&info),
            },
        });
        if !present {
            out["note"] = json!(format!(
                "nothing published under {group} — this means the alert group was not found, \
                 not that the robot has no alerts"
            ));
        }
        out
    }

    fn physics(&self) -> Value {
        let (values, _) = self.nt.snapshot();

        let scalar = |key: &str| -> Value {
            match num_of(&values, key) {
                Some(v) => json!({ "published": true, "value": num_json(v), "topic": key }),
                None => json!({ "published": false, "value": Value::Null, "topic": key }),
            }
        };

        const POSE: &str = "/Catalyst/Physics/PoseArray";
        let pose = match values.get(POSE) {
            Some(NtValue::Nums(a)) if a.len() >= 3 => json!({
                "published": true,
                "topic": POSE,
                "x_m": num_json(a[0]),
                "y_m": num_json(a[1]),
                "theta_rad": num_json(a[2]),
            }),
            // Published but the wrong shape is its own answer: something is writing that topic and
            // it is not the pose we know how to read. Reporting it as absent would hide the bug.
            Some(other) => json!({
                "published": true,
                "topic": POSE,
                "x_m": Value::Null,
                "y_m": Value::Null,
                "theta_rad": Value::Null,
                "note": format!(
                    "expected a double[3] of [x, y, theta]; found {} — not guessing at the layout",
                    type_name(other)
                ),
            }),
            None => json!({ "published": false, "topic": POSE }),
        };

        let slip = scalar("/Catalyst/Physics/Slip/Factor");
        let tipping = scalar("/Catalyst/Physics/TippingUsage");
        let traction = scalar("/Catalyst/Physics/TractionUsage");
        let confidence = scalar("/Catalyst/Physics/Quality/Confidence");

        let any = [&pose, &slip, &tipping, &traction, &confidence]
            .iter()
            .any(|v| v.get("published").and_then(|p| p.as_bool()).unwrap_or(false));

        let mut out = json!({
            "present": any,
            "pose": pose,
            "slip_factor": slip,
            "tipping_usage": tipping,
            "traction_usage": traction,
            "confidence": confidence,
            "reading": "slip, tipping and traction are all the fraction of a limit in use, \
                        so all three read the same way round: higher is worse. Confidence is 0-1, \
                        higher is better.",
            "advisory": "Physics Core has been validated in simulation and has never run on carpet. \
                         These numbers are advisory and must not gate a driver decision.",
        });
        if !any {
            out["note"] = json!(
                "the robot publishes no Physics Core topics — it may not construct a PhysicsCore at all"
            );
        }
        out
    }

    fn match_state(&self) -> Value {
        let (values, _) = self.nt.snapshot();

        // WPILib packs the control word into /FMSInfo/FMSControlData. The bit layout is part of the
        // DS protocol and has been stable for years; we only ever read it.
        const ENABLED: i64 = 1;
        const AUTO: i64 = 2;
        const TEST: i64 = 4;
        const ESTOP: i64 = 8;
        const FMS: i64 = 16;
        const DS: i64 = 32;

        let word = num_of(&values, "/FMSInfo/FMSControlData").map(|w| w as i64);
        let bit = |mask: i64| word.map(|w| (w & mask) != 0);

        // Without the control word there is no mode. "Disabled" would be a plausible answer and a
        // wrong one — a robot nobody is hearing from is not a robot that is disabled.
        let mode = word.map(|w| {
            if (w & ESTOP) != 0 {
                "E-STOP"
            } else if (w & ENABLED) == 0 {
                "Disabled"
            } else if (w & TEST) != 0 {
                "Test"
            } else if (w & AUTO) != 0 {
                "Autonomous"
            } else {
                "Teleop"
            }
        });

        let alliance = match bool_of(&values, "/FMSInfo/IsRedAlliance") {
            Some(true) => json!("red"),
            Some(false) => json!("blue"),
            None => Value::Null,
        };

        // /FMSInfo carries the control word, the alliance and the game data but *not* the clock, so
        // there is nothing to read unless robot code publishes DriverStation.getMatchTime()
        // somewhere. These are the three places it usually lands, in the order the dashboard tries.
        const CLOCKS: &[&str] =
            &["/Catalyst/Match/TimeLeft", "/SmartDashboard/MatchTime", "/FMSInfo/MatchTime"];
        let match_time = CLOCKS
            .iter()
            .find_map(|k| num_of(&values, k).map(|v| (k, v)))
            .map(|(k, v)| json!({ "published": true, "seconds": num_json(v), "topic": k }))
            .unwrap_or_else(|| {
                json!({
                    "published": false,
                    "seconds": Value::Null,
                    "searched": CLOCKS,
                    "note": "WPILib does not put the match clock on NetworkTables; \
                             robot code has to publish it",
                })
            });

        // An empty game-specific message is a real, meaningful state — FMS has not sent it yet — and
        // is not the same as the topic being absent. The hub schedule depends on telling them apart.
        const GSM: &str = "/FMSInfo/GameSpecificMessage";
        let game_specific = match str_of(&values, GSM) {
            Some(s) if s.trim().is_empty() => json!({
                "published": true,
                "value": s,
                "topic": GSM,
                "note": "published but empty — FMS sends this at the start of teleop",
            }),
            Some(s) => json!({ "published": true, "value": s, "topic": GSM }),
            None => json!({ "published": false, "value": Value::Null, "topic": GSM }),
        };

        let control_word = match word {
            Some(w) => json!({ "published": true, "raw": w }),
            None => json!({ "published": false, "raw": Value::Null }),
        };

        let mut out = json!({
            "control_word": control_word,
            "enabled": bit(ENABLED),
            "mode": mode,
            "estop": bit(ESTOP),
            "fms_attached": bit(FMS),
            "ds_attached": bit(DS),
            "alliance": alliance,
            "match_time": match_time,
            "game_specific_message": game_specific,
        });
        if word.is_none() {
            out["note"] = json!(
                "no control word — nothing is known about enable state, and Disabled is not assumed"
            );
        }
        out
    }
}

// ------------------------------------------------------------------- driver station log tools

fn ds_sessions(args: &Value) -> Value {
    let dir = args
        .get("dir")
        .and_then(|d| d.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(dslog::default_log_dir);
    let limit = args.get("limit").and_then(|l| l.as_u64()).unwrap_or(20).clamp(1, 200) as usize;

    let sessions = dslog::list_sessions(&dir, limit);
    let mut out = json!({
        "dir": dir.to_string_lossy(),
        "count": sessions.len(),
        "sessions": sessions,
        "note": "path is the session stem without an extension — pass it straight to ds_events",
    });
    // An empty list is the normal case on a machine the Driver Station has never run on, so it is
    // reported as such rather than as a failure.
    if sessions.is_empty() {
        out["note"] = json!(format!(
            "no Driver Station logs under {} — the DS may never have run on this machine",
            dir.to_string_lossy()
        ));
    }
    out
}

fn ds_events(args: &Value) -> Result<Value, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or_else(|| "ds_events needs a session path, as returned by ds_sessions".to_string())?;
    let limit = args.get("limit").and_then(|l| l.as_u64()).unwrap_or(200).clamp(1, 5000) as usize;
    let level = args.get("level").and_then(|l| l.as_str()).unwrap_or("info");

    let rank = |l: &str| match l {
        "error" => 2,
        "warn" => 1,
        _ => 0,
    };
    let floor = rank(level);

    // ds_sessions hands back a stem; a human reading these tools will sooner or later paste the
    // whole filename. Both work.
    let file = if path.to_ascii_lowercase().ends_with(".dsevents") {
        PathBuf::from(path)
    } else {
        PathBuf::from(format!("{path}.dsevents"))
    };

    if !file.exists() {
        return Err(format!("no such file: {}", file.to_string_lossy()));
    }

    let all = dslog::read_events(&file);
    let total = all.len();
    let matched: Vec<&dslog::DsEvent> =
        all.iter().filter(|e| rank(e.level.as_str()) >= floor).collect();
    let matched_count = matched.len();
    let shown: Vec<&&dslog::DsEvent> = matched.iter().take(limit).collect();

    let mut out = json!({
        "file": file.to_string_lossy(),
        "total": total,
        "matched": matched_count,
        "shown": shown.len(),
        "truncated": matched_count > shown.len(),
        "level": level,
        "events": shown,
        "note": "t is seconds since the start of the session. Levels are inferred from the text \
                 because the file format does not carry one.",
    });
    // The format is community-reverse-engineered, so an empty result may mean a quiet match or a
    // header we could not read. Do not let the two look identical.
    if total == 0 {
        out["note"] = json!(
            "no events decoded — either the session logged none, or the file header is not a \
             version this parser recognises, in which case it refuses to guess"
        );
    }
    Ok(out)
}

// -------------------------------------------------------------------------- the collision map

/// Where a generated collision map might be, in the order worth looking.
///
/// The map is built from the field CAD by `npm run field-collision` and is deliberately not
/// committed — it is FIRST's model rather than ours. An installed console has the frontend embedded
/// in the binary with no `vendor` directory on disk at all, so an absent map is an ordinary outcome
/// here and the tool says which paths it tried rather than just reporting nothing.
fn field_map_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("vendor").join(FIELD_MAP_NAME));
            // cargo leaves the binary in src-tauri/target/<profile>/, three levels under the root
            if let Some(root) = dir.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
                out.push(root.join("src").join("vendor").join(FIELD_MAP_NAME));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("src").join("vendor").join(FIELD_MAP_NAME));
        out.push(cwd.join("vendor").join(FIELD_MAP_NAME));
    }
    out
}

fn field_map(args: &Value) -> Value {
    let explicit = args.get("path").and_then(|p| p.as_str()).map(PathBuf::from);
    let candidates = match &explicit {
        Some(p) => vec![p.clone()],
        None => field_map_candidates(),
    };

    let Some(found) = candidates.iter().find(|p| p.is_file()) else {
        return json!({
            "present": false,
            "searched": candidates.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
            "note": "no collision map found. It is generated from the field CAD by \
                     `npm run field-collision` and is not committed, so a fresh checkout and an \
                     installed build both legitimately lack one.",
        });
    };

    metadata_of(found)
}

/// Read the map's header without reading the map.
///
/// The grids are ~53k numbers each. An agent asking whether a map exists wants its shape, not a
/// hundred thousand millimetre readings, so only the metadata and a consistency check come back.
fn metadata_of(path: &Path) -> Value {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            return json!({
                "present": false,
                "path": path.to_string_lossy(),
                "note": format!("found the file but could not read it: {e}"),
            })
        }
    };
    let size = bytes.len();
    let parsed: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "present": true,
                "readable": false,
                "path": path.to_string_lossy(),
                "bytes": size,
                "note": format!("not valid JSON: {e}"),
            })
        }
    };

    let len_of = |key: &str| parsed.get(key).and_then(|v| v.as_array()).map(|a| a.len());
    let heights = len_of("heightsMillimetres");
    let clearance = len_of("clearanceMillimetres");
    let cols = parsed.get("cols").and_then(|v| v.as_u64());
    let rows = parsed.get("rows").and_then(|v| v.as_u64());
    let cells = match (cols, rows) {
        (Some(c), Some(r)) => Some((c * r) as usize),
        _ => None,
    };

    let layers_match_grid = match (cells, heights, clearance) {
        (Some(c), Some(h), Some(l)) => json!(c == h && c == l),
        _ => Value::Null,
    };

    let mut out = json!({
        "present": true,
        "readable": true,
        "path": path.to_string_lossy(),
        "bytes": size,
        "note": parsed.get("note").cloned().unwrap_or(Value::Null),
        "grid": {
            "cols": cols,
            "rows": rows,
            "cell_meters": parsed.get("cellMeters").cloned().unwrap_or(Value::Null),
            "cells": cells,
        },
        "field": {
            "length_meters": parsed.get("lengthMeters").cloned().unwrap_or(Value::Null),
            "width_meters": parsed.get("widthMeters").cloned().unwrap_or(Value::Null),
        },
        "model_to_field": parsed.get("modelToField").cloned().unwrap_or(Value::Null),
        "layers": {
            "heights_millimetres": heights,
            "clearance_millimetres": clearance,
        },
        "layers_match_grid": layers_match_grid,
    });

    // modelToField is what puts the CAD and the map in one frame. Without it a consumer has to fall
    // back to centring the model's bounding box, which is wrong by however asymmetric the structure
    // standing outside the walls happens to be — worth flagging rather than leaving as a null.
    if parsed.get("modelToField").is_none() {
        out["warning"] = json!(
            "no modelToField — anything drawing the CAD beside this map has no shared frame and \
             will have to guess at the registration"
        );
    }
    out
}

// ----------------------------------------------------------------------------- tool definitions

/// The tools, exactly as `tools/list` returns them.
///
/// **Read-only, all of them, permanently.** There is no tool to enable, disable, drive, or write a
/// NetworkTables value, and adding one would break the first rule this product is built on rather
/// than merely extending this file. Diagnostics are what an agent needs here; control is the Driver
/// Station's and no one else's.
fn tool_definitions() -> Vec<Value> {
    let no_args = json!({ "type": "object", "properties": {}, "additionalProperties": false });

    vec![
        json!({
            "name": "console_status",
            "description": "Console version, whether NetworkTables is connected, which address \
                answered, round-trip time, how many topics are known, and how long this server has \
                been up. Start here: every other tool reads more usefully once you know whether \
                there is a robot on the other end.",
            "inputSchema": no_args,
        }),
        json!({
            "name": "nt_list",
            "description": "List the NetworkTables topics the robot is publishing, optionally \
                filtered by a case-insensitive substring. Use it to find out what exists before \
                reading anything with nt_get.",
            "inputSchema": json!({
                "type": "object",
                "properties": {
                    "filter": { "type": "string", "description": "case-insensitive substring" },
                    "limit": {
                        "type": "integer",
                        "description": "maximum names to return, default 200",
                        "minimum": 1, "maximum": 5000
                    }
                },
                "additionalProperties": false
            }),
        }),
        json!({
            "name": "nt_get",
            "description": "Read one topic's current value and type. A topic that has not been \
                published comes back with published:false and a null value — never a zero.",
            "inputSchema": json!({
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "absolute topic path, for example /Catalyst/Physics/TippingUsage"
                    }
                },
                "required": ["key"],
                "additionalProperties": false
            }),
        }),
        json!({
            "name": "alerts",
            "description": "Current errors, warnings and info from the robot's alert group. Reads \
                Catalyst's Errors/Warnings/Info and WPILib's errors/warnings/infos, whichever is \
                present. If the group is absent the lists are null rather than empty, because \
                'no alert group' and 'no alerts' are different answers.",
            "inputSchema": json!({
                "type": "object",
                "properties": {
                    "group": {
                        "type": "string",
                        "description": "alert group path, default /Catalyst/Alerts"
                    }
                },
                "additionalProperties": false
            }),
        }),
        json!({
            "name": "physics",
            "description": "Physics Core state: pose, slip factor, tipping usage, traction usage \
                and estimator confidence. Each field says whether the robot actually publishes it. \
                Advisory only — Physics Core has been validated in simulation, not on carpet.",
            "inputSchema": no_args,
        }),
        json!({
            "name": "match_state",
            "description": "Driver Station and FMS state: enabled, mode, E-stop, alliance, match \
                time, and the FMS game-specific message. Without a control word the mode is null, \
                not Disabled.",
            "inputSchema": no_args,
        }),
        json!({
            "name": "ds_sessions",
            "description": "List Driver Station log sessions on this machine, most recent first. \
                Each carries the stem path to pass to ds_events.",
            "inputSchema": json!({
                "type": "object",
                "properties": {
                    "dir": {
                        "type": "string",
                        "description": "log directory, default the NI Driver Station's own"
                    },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                },
                "additionalProperties": false
            }),
        }),
        json!({
            "name": "ds_events",
            "description": "Read one session's .dsevents log: radio drops, brownouts, watchdog \
                trips, timestamped from the start of the session. Some of this exists nowhere else \
                — the robot never sees its own packet loss.",
            "inputSchema": json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "session path from ds_sessions, with or without the extension"
                    },
                    "level": {
                        "type": "string",
                        "enum": ["info", "warn", "error"],
                        "description": "minimum severity to return, default info (everything)"
                    },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 5000 }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        }),
        json!({
            "name": "field_map",
            "description": "Whether a field collision map is present, and its metadata: grid size, \
                cell size, field dimensions, and the modelToField transform that puts the map and \
                the CAD in one frame. The grids themselves are tens of thousands of numbers and are \
                not returned.",
            "inputSchema": json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "explicit path to a field-collision.json; otherwise the \
                            usual locations are searched"
                    }
                },
                "additionalProperties": false
            }),
        }),
    ]
}

// ------------------------------------------------------------------------------------- plumbing

fn ok(id: Value, result: Value) -> String {
    frame(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn error(id: Value, code: i64, message: &str) -> String {
    frame(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }))
}

/// Serialise one frame. Serialisation cannot realistically fail on values we built ourselves, but a
/// panic here would take the server down mid-conversation, so it degrades to a protocol error the
/// client can actually read. The reason goes to stderr rather than into the frame, because an error
/// string spliced into hand-written JSON is how you emit something that will not parse.
fn frame(value: Value) -> String {
    serde_json::to_string(&value).unwrap_or_else(|e| {
        eprintln!("[mcp] could not encode a response: {e}");
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"could not encode response"}}"#
            .to_string()
    })
}

/// A tool result in the shape MCP expects: text content carrying the payload as JSON.
///
/// Pretty-printed because these are read by people as often as by agents, and the newlines cost
/// nothing once escaped into the transport frame.
fn content(payload: &Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(payload)
        .unwrap_or_else(|e| format!("could not encode result: {e}"));
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

fn type_name(v: &NtValue) -> &'static str {
    match v {
        NtValue::Bool(_) => "boolean",
        NtValue::Num(_) => "double",
        NtValue::Str(_) => "string",
        NtValue::Bools(_) => "boolean[]",
        NtValue::Nums(_) => "double[]",
        NtValue::Strs(_) => "string[]",
    }
}

/// JSON has no NaN or infinity, and serde turns both into null — which in this server means "not
/// published". A robot with an uninitialised estimator publishes NaN often enough that conflating
/// the two would be a real misreading, so those come back as the strings "NaN", "inf" and "-inf",
/// alongside a type field that still says double.
fn num_json(n: f64) -> Value {
    if n.is_finite() {
        json!(n)
    } else if n.is_nan() {
        json!("NaN")
    } else if n > 0.0 {
        json!("inf")
    } else {
        json!("-inf")
    }
}

fn value_json(v: &NtValue) -> Value {
    match v {
        NtValue::Bool(b) => json!(b),
        NtValue::Num(n) => num_json(*n),
        NtValue::Str(s) => json!(s),
        NtValue::Bools(b) => json!(b),
        NtValue::Nums(n) => Value::Array(n.iter().map(|x| num_json(*x)).collect()),
        NtValue::Strs(s) => json!(s),
    }
}

fn num_of(values: &HashMap<String, NtValue>, key: &str) -> Option<f64> {
    match values.get(key)? {
        NtValue::Num(n) => Some(*n),
        _ => None,
    }
}

fn bool_of(values: &HashMap<String, NtValue>, key: &str) -> Option<bool> {
    match values.get(key)? {
        NtValue::Bool(b) => Some(*b),
        _ => None,
    }
}

fn str_of(values: &HashMap<String, NtValue>, key: &str) -> Option<String> {
    match values.get(key)? {
        NtValue::Str(s) => Some(s.clone()),
        _ => None,
    }
}

fn round(v: f64, places: i32) -> f64 {
    let scale = 10f64.powi(places);
    (v * scale).round() / scale
}
