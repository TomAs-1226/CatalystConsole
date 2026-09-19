// How the board words what it shows: a large figure written short, and a segment of a topic's path
// written as a label.
//
// Its own module so it can be tested. app.js is a browser module that touches the DOM at import time,
// and these are small rules with edges worth pinning down - where a thousand begins once a figure is
// rounded, what a minus sign does, which spellings of a key are left alone. Both are display only:
// nothing here changes a value or a key, only how it reads.

/**
 * A large figure written short, the way Tesla's screen writes one: 2400 reads 2.4k and 2000 reads 2k,
 * with the one decimal kept only where it says something, and past a thousand thousands an M.
 *
 * Anything that rounds to under a thousand is written as it always was, to the places asked for, and
 * the sign is kept. The caller keeps the whole value where it can be read in full.
 *
 * @param {number} v
 * @param {number} [places] decimals for a figure under a thousand
 * @returns {string}
 */
export function compactFigure(v, places = 0) {
  const digits = Math.max(0, places | 0);
  if (Math.abs(Number(v.toFixed(digits))) < 1000) return v.toFixed(digits);
  let scaled = Math.abs(v) / 1000;
  let suffix = "k";
  if (Number(scaled.toFixed(1)) >= 1000) {
    scaled /= 1000;
    suffix = "M";
  }
  return `${v < 0 ? "-" : ""}${scaled.toFixed(1).replace(/\.0$/, "")}${suffix}`;
}

/**
 * A path segment as a person would write it on a label, in the sentence case the rest of the board is
 * set in: FrontLeft and frontLeft read "Front left", CANBus reads "CAN bus".
 *
 * A segment that is not plain letters and digits (shooter_rpm, LL-3) is left exactly as the robot
 * published it, since there is no telling what its author meant by the punctuation.
 *
 * @param {string} segment
 * @returns {string}
 */
export function spacedLabel(segment) {
  const s = String(segment);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(s)) return s;
  const words = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" ");
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1)
      : /^[A-Z][a-z0-9]*$/.test(w) ? w.toLowerCase() : w))
    .join(" ");
}
