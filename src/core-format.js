// The rules behind the Systemcore page: what counts as trouble, and how a reading is worded.
//
// Its own module so it can be tested. app.js is a browser module that touches the DOM at import
// time, and these are the decisions worth checking against real inputs rather than by eye — the
// states they describe are the ones nobody can reproduce on a robot without breaking it.
//
// One rule runs through all of them: absent is not zero. A reading the machine did not send comes
// back null and stays null. Storage at 0% and no answer from the storage sensor render identically
// as a number, mean opposite things, and the wrong one of them is reassuring.

/**
 * Severity for a percentage, or null if there is no reading.
 *
 * Thresholds are deliberately loose and shared across the page. These are for noticing, not
 * diagnosing: a processor at 85% during an auto routine is doing its job, and a page that turns red
 * every match gets ignored by the third one.
 *
 * @param {number|null} pct
 * @returns {"ok"|"warn"|"crit"|null}
 */
export function level(pct, warn = 85, crit = 95) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return null;
  return pct >= crit ? "crit" : pct >= warn ? "warn" : "ok";
}

/**
 * A byte count as a person would say it.
 *
 * Binary units, because that is what the kernel counted. Absolute sizes matter next to the ratio:
 * "88% used" is the same number on 8 GiB and on 512 MiB and a different problem, and the ratio
 * alone cannot tell them apart.
 *
 * @param {number|null} bytes
 * @returns {string|null}
 */
export function bytes(b) {
  if (b === null || b === undefined || !Number.isFinite(b)) return null;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = b;
  while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${Math.abs(v) < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * How eMMC wear is worded.
 *
 * The device reports a 10% band, not a percentage — JEDEC gives a code in ten steps and the library
 * turns it into the midpoint of its band. Printing "55%" back would be inventing a digit the flash
 * never provided, so this says the band.
 *
 * @param {number|null} usedFraction 0–1, the midpoint of the reported band
 * @returns {string}
 */
export function wearText(usedFraction) {
  if (usedFraction === null || usedFraction === undefined) return "wear not reported";
  const pct = usedFraction * 100;
  const top = Math.min(100, Math.round(pct / 10) * 10);
  const bottom = Math.max(0, top - 10);
  return `about ${bottom}–${top}% of its rated write life used`;
}

/**
 * The device's own opinion of its flash, from JEDEC PRE_EOL_INFO.
 *
 * Independent of the wear estimate and usually the earlier signal, because it reflects blocks
 * actually retired rather than writes estimated.
 *
 * @param {number|null} code 1 normal, 2 warning, 3 urgent
 * @returns {{text: string, level: string}|null}
 */
export function preEolState(code) {
  const states = {
    1: { text: "healthy", level: "ok" },
    2: { text: "wearing out", level: "warn" },
    3: { text: "replace it", level: "crit" },
  };
  if (code === null || code === undefined) return null;
  return states[Math.round(code)] ?? null;
}
