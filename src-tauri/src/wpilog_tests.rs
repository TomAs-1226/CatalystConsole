//! The 2027 Driver Station's log format, against files built byte by byte.
//!
//! The record header packs three field widths into one leading byte, and getting the shift wrong
//! does not fail — it desynchronises, and the reader walks off into the payload producing entries
//! with plausible names and impossible timestamps. That happened while this was being written: a
//! shift of 3 instead of 4 turned a 13-minute session into one entry spanning 435 million seconds.
//! Every test here exists because that failure is silent.

use super::*;

/// Builds a WPILOG the way the Driver Station does, so the reader is tested against the format
/// rather than against itself.
struct LogBuilder {
    bytes: Vec<u8>,
}

impl LogBuilder {
    fn new() -> Self {
        let mut bytes = b"WPILOG".to_vec();
        bytes.extend_from_slice(&1u16.to_le_bytes()); // version 1.0
        let extra = b"DS Log File";
        bytes.extend_from_slice(&(extra.len() as u32).to_le_bytes());
        bytes.extend_from_slice(extra);
        LogBuilder { bytes }
    }

    /// A record with the widest possible field widths, which is what the DS actually emits once a
    /// session has been running for a while.
    fn record(&mut self, entry_id: u32, timestamp_us: u64, payload: &[u8]) {
        // 4-byte id, 4-byte size, 8-byte timestamp: (4-1) | (4-1)<<2 | (8-1)<<4
        let bitfield = 0x3 | (0x3 << 2) | (0x7 << 4);
        self.bytes.push(bitfield);
        self.bytes.extend_from_slice(&entry_id.to_le_bytes());
        self.bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        self.bytes.extend_from_slice(&timestamp_us.to_le_bytes());
        self.bytes.extend_from_slice(payload);
    }

    fn start_entry(&mut self, id: u32, name: &str, typ: &str, timestamp_us: u64) {
        let mut p = vec![0u8]; // control record kind 0 = start
        p.extend_from_slice(&id.to_le_bytes());
        p.extend_from_slice(&(name.len() as u32).to_le_bytes());
        p.extend_from_slice(name.as_bytes());
        p.extend_from_slice(&(typ.len() as u32).to_le_bytes());
        p.extend_from_slice(typ.as_bytes());
        p.extend_from_slice(&0u32.to_le_bytes()); // empty metadata
        self.record(0, timestamp_us, &p);
    }

    fn write(&self, name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("catalyst-wpilog-{name}.wpilog"));
        std::fs::write(&p, &self.bytes).unwrap();
        p
    }
}

#[test]
fn a_session_yields_its_battery_trace() {
    let mut b = LogBuilder::new();
    b.start_entry(1, "DS:/Dscomm/Status/Battery", "double", 1_000_000);
    b.record(1, 1_000_000, &12.95f64.to_le_bytes());
    b.record(1, 2_000_000, &12.90f64.to_le_bytes());
    b.record(1, 3_000_000, &12.88f64.to_le_bytes());

    let s = read_samples(&b.write("battery"));

    assert!(s.parsed, "{}", s.note);
    assert_eq!(s.battery, vec![12.95, 12.90, 12.88]);
    assert_eq!(s.t, vec![0.0, 1.0, 2.0], "seconds from the first record, not since the epoch");
}

#[test]
fn round_trip_time_arrives_in_milliseconds() {
    // The DS records microseconds; every graph in this console is in milliseconds. A bench session
    // showed ~286 us over USB, which is 0.286 ms - and would read as a catastrophic 286 ms if the
    // unit were carried through unchanged.
    let mut b = LogBuilder::new();
    b.start_entry(7, "DS:/Dscomm/Status/PacketTime", "int64", 0);
    b.record(7, 0, &286i64.to_le_bytes());
    b.record(7, 20_000, &7_040i64.to_le_bytes());

    let s = read_samples(&b.write("rtt"));

    assert_eq!(s.trip_ms.len(), 2);
    assert!((s.trip_ms[0] - 0.286).abs() < 1e-9);
    assert!((s.trip_ms[1] - 7.040).abs() < 1e-9);
}

#[test]
fn every_field_width_decodes_the_same_way() {
    // The header packs three widths into one byte. A session starts with small ids and timestamps
    // and grows into large ones, so a reader that only handles the wide form works for ten minutes
    // and then stops - or worse, keeps going and desynchronises.
    let mut bytes = b"WPILOG".to_vec();
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());

    // Narrow control record: 1-byte id, 1-byte size, 1-byte timestamp.
    let name = "DS:/Dscomm/Status/Battery";
    let mut p = vec![0u8];
    p.extend_from_slice(&9u32.to_le_bytes());
    p.extend_from_slice(&(name.len() as u32).to_le_bytes());
    p.extend_from_slice(name.as_bytes());
    p.extend_from_slice(&(6u32).to_le_bytes());
    p.extend_from_slice(b"double");
    p.extend_from_slice(&0u32.to_le_bytes());
    bytes.push(0x00); // all widths = 1
    bytes.push(0);
    bytes.push(p.len() as u8);
    bytes.push(0);
    bytes.extend_from_slice(&p);

    // Narrow data record for entry 9.
    bytes.push(0x00);
    bytes.push(9);
    bytes.push(8);
    bytes.push(50);
    bytes.extend_from_slice(&12.5f64.to_le_bytes());

    let path = std::env::temp_dir().join("catalyst-wpilog-narrow.wpilog");
    std::fs::write(&path, &bytes).unwrap();

    let s = read_samples(&path);
    assert!(s.parsed, "{}", s.note);
    assert_eq!(s.battery, vec![12.5], "narrow headers decode like wide ones");
}

#[test]
fn a_file_that_is_not_a_wpilog_is_refused_rather_than_decoded() {
    let path = std::env::temp_dir().join("catalyst-wpilog-notone.wpilog");
    std::fs::write(&path, b"this is not a log at all, not even close").unwrap();

    let s = read_samples(&path);

    assert!(!s.parsed);
    assert!(s.battery.is_empty(), "nothing invented from a file we cannot read");
    assert!(s.note.contains("WPILOG"), "the note has to say why: {}", s.note);
}

#[test]
fn a_truncated_record_stops_the_read_instead_of_running_off_the_end() {
    // Logs from a session that was still running when the machine was shut down end mid-record.
    let mut b = LogBuilder::new();
    b.start_entry(1, "DS:/Dscomm/Status/Battery", "double", 0);
    b.record(1, 0, &12.9f64.to_le_bytes());
    let mut bytes = b.bytes.clone();
    bytes.push(0x3 | (0x3 << 2) | (0x7 << 4)); // a header with no body behind it
    bytes.extend_from_slice(&1u32.to_le_bytes());

    let path = std::env::temp_dir().join("catalyst-wpilog-trunc.wpilog");
    std::fs::write(&path, &bytes).unwrap();

    let s = read_samples(&path);
    assert!(s.parsed);
    assert_eq!(s.battery, vec![12.9], "what was complete is kept, the rest is dropped");
}

#[test]
fn sessions_are_listed_newest_first_and_only_wpilogs() {
    let dir = std::env::temp_dir().join("catalyst-wpilog-listing");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("FIRST_DS_20260828_010000.1.wpilog"), b"WPILOG").unwrap();
    std::fs::write(dir.join("FIRST_DS_20260828_020000.2.wpilog"), b"WPILOG").unwrap();
    std::fs::write(dir.join("notes.txt"), b"ignore me").unwrap();

    let sessions = list_sessions(&dir, 10);

    assert_eq!(sessions.len(), 2, "only .wpilog files: {sessions:?}");
    assert!(sessions.iter().all(|s| s.has_log));
    assert!(sessions.iter().all(|s| !s.has_events),
            "console text is protobuf and not decoded yet, so no session claims events");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_real_driver_station_session_reads() {
    // Not a fixture. A session this Driver Station actually recorded, which is the only thing that
    // proves the format was read rather than imagined. Skipped where the DS has never run.
    let dir = default_log_dir();
    let sessions = list_sessions(&dir, 5);
    if sessions.is_empty() {
        println!("REALTEST skipped: no sessions in {}", dir.display());
        return;
    }
    println!("REALTEST {} sessions found", sessions.len());

    let newest = &sessions[0];
    let s = read_samples(std::path::Path::new(&newest.path));

    assert!(s.parsed, "{}: {}", newest.name, s.note);
    assert!(!s.battery.is_empty(), "a DS session records battery: {}", s.note);

    // A robot battery is somewhere between flat and freshly charged. This is a sanity check on the
    // decode, not on the battery: a misread double comes out as 1e-310 or 1e+250, not as 12.
    for v in &s.battery {
        assert!(*v > 4.0 && *v < 20.0, "battery sample out of any plausible range: {v}");
    }

    // Time has to move forwards and cover a real session rather than an epoch's worth of seconds.
    assert!(s.t.windows(2).all(|w| w[1] >= w[0]), "timestamps must not go backwards");
    let span = s.t.last().copied().unwrap_or(0.0);
    assert!(span > 0.0 && span < 86_400.0, "session span of {span}s is not a session");
    println!("REALTEST {} : {} battery samples, span {:.1}s, first {:.2}V",
             newest.name, s.battery.len(), span, s.battery[0]);
}
