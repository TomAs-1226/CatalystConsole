//! Tests for the Driver Station log parser.
//!
//! In a file of their own only because they are long; `#[path]`-included as a child module of
//! `dslog`, so they can reach its private helpers.
//!
//! Everything here is byte-level decoding, which is worth testing precisely because it cannot fail
//! loudly. A wrong offset or a misread scale factor produces numbers that chart perfectly well and
//! are simply not what the robot did — and these charts are what a team looks at after a match to
//! decide what went wrong.

use super::*;
use std::fs;
use std::path::PathBuf;

/// Build a .dslog in memory: a 20-byte header, then fixed-size records.
///
/// The layout is written out independently here rather than derived from the parser, so a change to
/// the parser cannot quietly redefine what a correct file looks like.
fn dslog(version: u32, records: &[[u8; 35]]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&version.to_be_bytes());
    bytes.extend_from_slice(&[0u8; 16]); // timestamp, not read by read_samples
    for r in records {
        bytes.extend_from_slice(r);
    }
    bytes
}

/// One record: trip time in half-ms, loss percent, battery volts and 1/256ths, CPU in half-percent.
fn record(trip_half_ms: u8, loss_pct: u8, volts: u8, volts_256ths: u8, cpu_half: u8) -> [u8; 35] {
    let mut r = [0u8; 35];
    r[0] = trip_half_ms;
    r[1] = loss_pct;
    r[2] = volts;
    r[3] = volts_256ths;
    r[4] = cpu_half;
    r
}

struct TempFile(PathBuf);

impl TempFile {
    fn with(name: &str, bytes: &[u8]) -> Self {
        let p = std::env::temp_dir().join(format!("console-dslog-test-{name}.dslog"));
        fs::write(&p, bytes).unwrap();
        TempFile(p)
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

// --- sample decoding --------------------------------------------------------

#[test]
fn battery_decodes_as_a_fixed_point_pair() {
    // 12 volts and 100/256ths. Reading the second byte as tenths instead — an easy mistake, since
    // voltages are usually written that way — gives 22.0 V, which charts without complaint and is
    // not a voltage any robot has ever had.
    let f = TempFile::with("battery", &dslog(4, &[record(0, 0, 12, 100, 0)]));
    let s = read_samples(&f.0);

    assert!(s.parsed, "{}", s.note);
    assert_eq!(s.battery.len(), 1);
    assert!((s.battery[0] - 12.390_625).abs() < 1e-9, "got {}", s.battery[0]);
}

#[test]
fn trip_time_and_cpu_are_stored_at_half_resolution() {
    let f = TempFile::with("halves", &dslog(4, &[record(40, 7, 12, 0, 60)]));
    let s = read_samples(&f.0);

    assert_eq!(s.trip_ms[0], 20.0, "40 half-milliseconds is 20 ms");
    assert_eq!(s.cpu_pct[0], 30.0, "60 half-percent is 30%");
    assert_eq!(s.loss_pct[0], 7.0, "loss is a straight percentage, not halved");
}

#[test]
fn the_timebase_is_fifty_hertz() {
    let rs: Vec<_> = (0..4).map(|_| record(0, 0, 12, 0, 0)).collect();
    let f = TempFile::with("timebase", &dslog(4, &rs));
    let s = read_samples(&f.0);

    assert_eq!(s.t, vec![0.0, 0.02, 0.04, 0.06]);
}

#[test]
fn every_record_is_decoded() {
    let rs: Vec<_> = (0..50).map(|i| record(0, 0, 12 - (i / 25) as u8, 0, 0)).collect();
    let f = TempFile::with("all", &dslog(3, &rs));
    let s = read_samples(&f.0);

    assert_eq!(s.battery.len(), 50);
    assert_eq!(s.t.len(), 50);
}

#[test]
fn a_truncated_trailing_record_is_dropped_not_decoded_from_padding() {
    // A log from a robot that lost power mid-write. Decoding the partial tail would append a sample
    // built from whatever bytes happen to be there — most likely a 0 V battery, which reads as a
    // brownout that never happened.
    let mut bytes = dslog(4, &[record(0, 0, 12, 0, 0)]);
    bytes.extend_from_slice(&[0u8; 10]); // half a record

    let f = TempFile::with("truncated", &bytes);
    let s = read_samples(&f.0);

    assert_eq!(s.battery.len(), 1, "only the whole record");
}

// --- refusing to guess ------------------------------------------------------

#[test]
fn an_unknown_version_refuses_rather_than_guessing() {
    // The 2027 Driver Station is a different application and its format is not assumed to match.
    // Decoding it with the v3/v4 layout would produce a chart of plausible nonsense, which is worse
    // than an empty one because nothing about it looks wrong.
    let f = TempFile::with("v9", &dslog(9, &[record(0, 0, 12, 0, 0)]));
    let s = read_samples(&f.0);

    assert!(!s.parsed);
    assert!(s.note.contains("9"), "the note should name the version: {}", s.note);
    assert!(s.battery.is_empty());
}

#[test]
fn both_known_versions_parse() {
    for v in [3u32, 4] {
        let f = TempFile::with(&format!("v{v}"), &dslog(v, &[record(0, 0, 12, 0, 0)]));
        assert!(read_samples(&f.0).parsed, "version {v} should parse");
    }
}

#[test]
fn a_short_or_missing_file_says_so_instead_of_panicking() {
    let f = TempFile::with("short", &[1, 2, 3]);
    let s = read_samples(&f.0);
    assert!(!s.parsed);
    assert!(!s.note.is_empty());

    let missing = read_samples(Path::new("no-such-file-anywhere.dslog"));
    assert!(!missing.parsed);
}

#[test]
fn a_header_with_no_records_reports_nothing_decoded() {
    let f = TempFile::with("headeronly", &dslog(4, &[]));
    let s = read_samples(&f.0);
    assert!(!s.parsed, "a file with no samples has not been parsed in any useful sense");
}

// --- event severity, which is what a driver actually reads ------------------

#[test]
fn the_messages_that_lose_matches_are_classified_as_errors() {
    assert_eq!(classify("Robot brownout detected"), "error");
    assert_eq!(classify("EStop pressed"), "error");
    assert_eq!(classify("ERROR: something failed"), "error");
}

#[test]
fn degradation_is_a_warning_not_an_error() {
    assert_eq!(classify("Radio connection lost"), "warn");
    assert_eq!(classify("Dropped packets"), "warn");
    assert_eq!(classify("Watchdog not fed"), "warn");
}

#[test]
fn ordinary_messages_stay_out_of_the_way() {
    assert_eq!(classify("Robot code started"), "info");
    assert_eq!(classify("Teleop enabled"), "info");
}

#[test]
fn classification_ignores_case() {
    // The DS is not consistent about it, and a severity that depended on capitalisation would route
    // the same event two different ways across two matches.
    assert_eq!(classify("BROWNOUT"), "error");
    assert_eq!(classify("brownout"), "error");
    assert_eq!(classify("Brownout"), "error");
}

// --- timestamps -------------------------------------------------------------

#[test]
fn labview_timestamps_are_shifted_off_the_1904_epoch() {
    // LabVIEW counts from 1904 and everything else counts from 1970. Missing the shift puts every
    // event 66 years in the future, which sorts and renders without complaint.
    let mut bytes = vec![0u8; 16];
    bytes[..8].copy_from_slice(&LABVIEW_EPOCH_OFFSET.to_be_bytes());

    let secs = labview_seconds(&bytes, 0).unwrap();
    assert!(secs.abs() < 1e-6, "the LabVIEW epoch itself is Unix time 0, got {secs}");
}

#[test]
fn the_fractional_part_is_unsigned() {
    // Stored as an unsigned fraction of a second but read through an i64. A fraction past the
    // halfway point has its top bit set, and treating that as signed gives a negative fraction —
    // an event timestamped slightly before the one that came earlier.
    let mut bytes = vec![0u8; 16];
    bytes[..8].copy_from_slice(&LABVIEW_EPOCH_OFFSET.to_be_bytes());
    bytes[8] = 0x80; // exactly half a second, with the high bit set

    let secs = labview_seconds(&bytes, 0).unwrap();
    assert!(secs > 0.0, "must not go backwards: {secs}");
    assert!((secs - 0.5).abs() < 1e-6, "expected half a second, got {secs}");
}
