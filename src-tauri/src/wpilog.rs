//! Reading the 2027 FIRST Driver Station's logs.
//!
//! The new Driver Station does not write NI's `.dslog`/`.dsevents` pair. It writes a single
//! `.wpilog` per session into `C:\Users\Public\Documents\FIRSTDriverStation\Logs\`, in WPILib's own
//! DataLog format — which is a documented format with a version number in its header, rather than
//! the community-reverse-engineered pair [`crate::dslog`] has to guess at.
//!
//! That is the whole reason this module is short and [`crate::dslog`] is careful. Here a header that
//! does not say `WPILOG` is simply not one of these files.
//!
//! ## What a session contains
//!
//! Read off a real session recorded on this machine: 64 entries, ~275k records over 13 minutes.
//! The ones worth graphing are plain scalars:
//!
//! | entry | type | meaning |
//! |---|---|---|
//! | `DS:/Dscomm/Status/Battery` | `double` | battery volts |
//! | `DS:/Dscomm/Status/PacketTime` | `int64` | round trip, microseconds |
//! | `DS:/Dscomm/Status/CPU` | `double` | robot processor load |
//! | `DS:/Dscomm/Status/CanBusUtilizations` | `float[]` | per bus, **percent** |
//!
//! The console text and error lines are in there too, as protobuf
//! (`mrc.proto.ProtobufConsoleLineTimestamp`). Decoding those needs the `MrcComm.proto` descriptor,
//! which the log helpfully carries in its own first entry — but that is a bigger job than reading
//! scalars, and half-decoding a protobuf into plausible text is exactly the sort of thing this
//! codebase avoids. Events are left to a later pass and reported as unavailable rather than empty.
//!
//! ## Units
//!
//! `CanBusUtilizations` is a percentage, not a fraction. Confirmed twice: a bench board published
//! `5.285` for `can_s0`, and the agent's own frame counters put that bus at 427 frames/s on a 1 Mbit
//! wire, which is 4.6–5.8% depending on frame size. The robot-side topic
//! (`/diagnostics/canbusutil`) publishes the same figure alongside its fraction as interleaved
//! pairs; this one is percentages only, five of them, one per bus.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::dslog::{DsSamples, DsSession};

/// Where the 2027 Driver Station keeps its logs.
pub fn default_log_dir() -> PathBuf {
    PathBuf::from(r"C:\Users\Public\Documents\FIRSTDriverStation\Logs")
}

/// Sessions, newest first. An empty list when the new DS has never run here, which is normal.
pub fn list_sessions(dir: &Path, limit: usize) -> Vec<DsSession> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<DsSession> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("wpilog") {
                return None;
            }
            let meta = e.metadata().ok()?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some(DsSession {
                name: path.file_stem()?.to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                modified_unix: modified,
                has_events: false, // protobuf; see the module note
                has_log: true,
            })
        })
        .collect();
    out.sort_by(|a, b| b.modified_unix.cmp(&a.modified_unix));
    out.truncate(limit);
    out
}

/// One record's header, decoded from the leading bitfield.
struct Header {
    entry_id: u32,
    payload: (usize, usize),
    timestamp_us: u64,
    next: usize,
}

/// Little-endian unsigned integer of `n` bytes.
fn le(buf: &[u8], at: usize, n: usize) -> Option<u64> {
    if at + n > buf.len() {
        return None;
    }
    let mut v = 0u64;
    for i in (0..n).rev() {
        v = (v << 8) | buf[at + i] as u64;
    }
    Some(v)
}

/// Decode one record header. The bitfield packs the widths of the three fields that follow it:
/// bits 0-1 the entry id, bits 2-3 the payload length, bits 4-6 the timestamp — each stored as
/// length minus one, so a byte of zero means "1, 1, 1".
fn header(buf: &[u8], at: usize) -> Option<Header> {
    let bitfield = *buf.get(at)?;
    let id_len = (bitfield & 0x3) as usize + 1;
    let size_len = ((bitfield >> 2) & 0x3) as usize + 1;
    let ts_len = ((bitfield >> 4) & 0x7) as usize + 1;

    let mut p = at + 1;
    let entry_id = le(buf, p, id_len)? as u32;
    p += id_len;
    let size = le(buf, p, size_len)? as usize;
    p += size_len;
    let timestamp_us = le(buf, p, ts_len)?;
    p += ts_len;

    if p + size > buf.len() {
        return None;
    }
    Some(Header { entry_id, payload: (p, p + size), timestamp_us, next: p + size })
}

/// A length-prefixed UTF-8 string, as the control records use.
fn lstring(buf: &[u8], at: usize) -> Option<(String, usize)> {
    let n = le(buf, at, 4)? as usize;
    let start = at + 4;
    let end = start.checked_add(n)?;
    if end > buf.len() {
        return None;
    }
    Some((String::from_utf8_lossy(&buf[start..end]).into_owned(), end))
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct CanUtilization {
    pub t: Vec<f64>,
    /// Percent per bus, `can_s0` first. Empty when the session never recorded any.
    pub per_bus: Vec<Vec<f64>>,
}

/// Battery, round-trip time and processor load over a session.
pub fn read_samples(path: &Path) -> DsSamples {
    let Ok(buf) = fs::read(path) else {
        return DsSamples {
            parsed: false,
            note: "Could not read the file.".to_string(),
            ..Default::default()
        };
    };
    if buf.len() < 12 || &buf[0..6] != b"WPILOG" {
        return DsSamples {
            parsed: false,
            note: "Not a WPILOG file. The 2027 Driver Station writes .wpilog; NI's older \
                   .dslog/.dsevents pair is read elsewhere."
                .to_string(),
            ..Default::default()
        };
    }
    let extra_len = le(&buf, 8, 4).unwrap_or(0) as usize;
    let mut at = 12 + extra_len;

    // Entry ids are assigned by the control records; only the four below are of interest.
    let mut battery_id = None;
    let mut packet_id = None;
    let mut cpu_id = None;

    let mut out = DsSamples { parsed: true, ..Default::default() };
    let mut first_us: Option<u64> = None;

    while at < buf.len() {
        let Some(h) = header(&buf, at) else { break };
        at = h.next;
        let payload = &buf[h.payload.0..h.payload.1];

        if h.entry_id == 0 {
            // Control record. Kind 0 is "start": id, name, type, metadata.
            if payload.first() != Some(&0) {
                continue;
            }
            let Some(id) = le(payload, 1, 4) else { continue };
            let Some((name, _)) = lstring(payload, 5) else { continue };
            match name.as_str() {
                "DS:/Dscomm/Status/Battery" => battery_id = Some(id as u32),
                "DS:/Dscomm/Status/PacketTime" => packet_id = Some(id as u32),
                "DS:/Dscomm/Status/CPU" => cpu_id = Some(id as u32),
                _ => {}
            }
            continue;
        }

        let start = *first_us.get_or_insert(h.timestamp_us);
        let t = (h.timestamp_us.saturating_sub(start)) as f64 / 1e6;

        if Some(h.entry_id) == battery_id && payload.len() == 8 {
            out.t.push(t);
            out.battery.push(f64::from_le_bytes(payload.try_into().unwrap()));
        } else if Some(h.entry_id) == packet_id && payload.len() == 8 {
            // Microseconds on the wire; the rest of the console speaks milliseconds.
            let us = i64::from_le_bytes(payload.try_into().unwrap());
            out.trip_ms.push(us as f64 / 1000.0);
        } else if Some(h.entry_id) == cpu_id && payload.len() == 8 {
            out.cpu_pct.push(f64::from_le_bytes(payload.try_into().unwrap()));
        }
    }

    // Packet loss has no direct equivalent here. The DS records LostPackets as a running count
    // rather than a rate, and turning one into the other needs a denominator this format does not
    // carry. Left empty rather than derived from an assumption.
    out.note = if out.battery.is_empty() {
        "Read, but this session recorded no battery samples.".to_string()
    } else {
        format!(
            "{} battery samples over {:.0}s. Packet loss is not in this format; console text is \
             protobuf and not decoded yet.",
            out.battery.len(),
            out.t.last().copied().unwrap_or(0.0)
        )
    };
    out
}

#[cfg(test)]
#[path = "wpilog_tests.rs"]
mod tests;
