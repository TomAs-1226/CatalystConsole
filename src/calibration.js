/* What a robot's calibration routines say about themselves, read the way Tesla's own camera
 * calibration notice works: quiet while it runs, a result when it finishes, a plain reason when it
 * does not. Every calibration publishes under /Catalyst/Calibration/<Name>/ - see FrcCatalyst's
 * WheelRadiusCalibration.java, under .../WheelRadius/, the only one that exists today. Status is
 * common to any of them ("running", "done", "interrupted", "stopped: <reason>", "no motion
 * measured"); the progress and result fields differ per calibration - WheelRadius's AccumRotations
 * while running and CorrectedRadiusInches/CorrectedRadiusMeters/PercentChange once done, X1's
 * SlipCurrentMeasurement publishing Volts/PeakAmps while running and a ready-made Result sentence
 * once done (see X1.java's slipCurrentCalibration) - so which fields make the text is chosen by what
 * is actually published, not by the calibration's name. A calibration with none of those still shows
 * the same running / interrupted / stopped / no-motion capsule from its Status alone, and nothing
 * here invents a field it does not have.
 *
 * `read` is the read-only NetworkTables view the rest of the console takes: num/str/keys. Pure, so
 * every state below is tested without a robot.
 */

const BASE = "/Catalyst/Calibration/";

/** How far a corrected radius may drift from the constant in code before tread wear alone stops
 *  explaining it - a season of wear costs a swerve wheel a few percent, not fifteen. */
export const SUSPECT_PERCENT = 15;

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "WheelRadius" -> "Wheel radius": split on capitals, lowercase every word after the first. */
function displayName(name) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().split(/\s+/);
  return words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(" ");
}

/** The running capsule's headline: whichever progress figures this calibration actually publishes.
 *  AccumRotations reads as turns (WheelRadius); Volts+PeakAmps reads as the ramp so far (X1's
 *  SlipCurrentMeasurement); a calibration with neither just names itself. */
function runningText(read, base, label) {
  const turns = finite(read.num(`${base}AccumRotations`, null));
  if (turns !== null) return `${label} calibration · ${turns.toFixed(1)} turns`;
  const volts = finite(read.num(`${base}Volts`, null));
  const amps = finite(read.num(`${base}PeakAmps`, null));
  if (volts !== null && amps !== null) return `${label} · ${volts.toFixed(1)} V · ${amps.toFixed(0)} A`;
  return `${label} calibration`;
}

/** Every calibration name with a Status published under /Catalyst/Calibration/, from a view with
 *  keys() - the same trick devices.js's systemChecks uses for /Catalyst/SystemCheck/. */
function calibrationNames(read) {
  const names = new Set();
  for (const key of read.keys?.() ?? []) {
    if (!key.startsWith(BASE)) continue;
    const rest = key.slice(BASE.length);
    const slash = rest.indexOf("/");
    if (slash > 0 && rest.slice(slash + 1) === "Status") names.add(rest.slice(0, slash));
  }
  return [...names].sort();
}

/**
 * One calibration's capsule right now, or null if it has published no Status: `{ key, level: "info",
 * text, detail, snippet, metresText, hint }`. Always grey (level "info") - a calibration finishing is
 * not a robot fault, so it gets no telltale colour. `snippet` is set for any finished run that
 * published one; `metresText` and `hint` are WheelRadius-specific and only set when its own fields are.
 */
function calibrationNotice(read, name) {
  const base = `${BASE}${name}/`;
  const status = read.str(`${base}Status`, null);
  if (!status) return null;
  const label = displayName(name);

  if (status === "running") {
    return { key: `cal:${name}:running`, level: "info", text: runningText(read, base, label), detail: "Calibrating" };
  }
  if (status === "interrupted") {
    return { key: `cal:${name}:interrupted`, level: "info", text: `${label} calibration`, detail: "Interrupted" };
  }
  if (status === "no motion measured") {
    return { key: `cal:${name}:no-motion`, level: "info", text: `${label} calibration`, detail: "No motion measured" };
  }
  if (status.startsWith("stopped:")) {
    // The reason after the colon is the robot's own sentence (WheelRadiusCalibration.java composes
    // it) - shown verbatim rather than reworded, the way a stack trace is quoted rather than summarised.
    return {
      key: `cal:${name}:stopped`,
      level: "info",
      text: `${label} calibration`,
      detail: status.slice("stopped:".length).trim() || "Stopped",
    };
  }
  if (status === "done") {
    // A calibration may just say its result outright (X1's SlipCurrentMeasurement does: "Wheels slip
    // at 48 A (FrontLeft first): set 45 A") rather than leaving Console to build a sentence out of
    // separate fields. Take that verbatim when it is there; WheelRadius's own inches/percent wording
    // is the fallback for the one calibration that does not.
    const result = read.str(`${base}Result`, null) || null;
    const inches = finite(read.num(`${base}CorrectedRadiusInches`, null));
    const metres = finite(read.num(`${base}CorrectedRadiusMeters`, null));
    const pct = finite(read.num(`${base}PercentChange`, null));
    const snippet = read.str(`${base}Snippet`, null) || null;

    const parts = [];
    if (inches !== null) parts.push(`${inches.toFixed(3)} in`);
    if (pct !== null) parts.push(`${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(1)}%`);

    return {
      key: `cal:${name}:done`,
      level: "info",
      text: result ?? (parts.length ? `${label} ${parts.join(" · ")}` : `${label} calibration done`),
      detail: "Calibration done",
      snippet: snippet ?? undefined,
      metresText: metres !== null ? `${metres.toFixed(5)} m` : undefined,
      // A season of tread wear costs a few percent; a swing bigger than that is more likely the gear
      // ratio or wheel size constant being wrong than the tread, so the driver is pointed there.
      hint: pct !== null && Math.abs(pct) > SUSPECT_PERCENT
        ? "More than a worn tread explains: check the drive gear ratio and wheel size in the constants."
        : undefined,
    };
  }
  // A status this does not recognise is still shown, plainly, rather than dropped - a future
  // calibration state should not go silently invisible just because this was written before it existed.
  return { key: `cal:${name}:${status}`, level: "info", text: `${label} calibration`, detail: status };
}

/** Every calibration's capsule right now, in name order. */
export function calibrationNotices(read) {
  return calibrationNames(read).map((name) => calibrationNotice(read, name)).filter(Boolean);
}
