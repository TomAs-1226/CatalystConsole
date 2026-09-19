/* OVERDRIVE, Tesla Plaid-style: the driver holding /Catalyst/Drive/Overdrive for a higher speed cap.
 *
 * The state that decides whether to show nothing, the one-time warp, or the steady badge is pure and
 * tested on its own, the same way the aim view's flicker is (see mechanisms.js createAimDebounce) -
 * this is its sibling for a boolean instead of an aim state.
 *
 * The robot's flag flickers like any NT topic - a dropped sample, a bounce at the edge of whatever
 * button or paddle holds it - and Plaid's warp is a once-a-launch flourish, not a strobe that replays
 * for every bounce. `next(rawOn, nowMs)` folds both problems into one small machine with three phases
 * a caller ever sees:
 *
 *   "idle"  - nothing to show: the flag is off, or has been on for less than `engageMs` and might
 *             still be a flicker.
 *   "warp"  - the flag has held for `engageMs` and this is a fresh engage: play the warp once.
 *   "badge" - either the warp has run its `warpMs` and settled, or this engage followed the last
 *             release by less than `cooldownMs` and skips the warp entirely.
 *
 * `reducedMotion` skips "warp" altogether, straight to "badge", so a page under prefers-reduced-motion
 * never schedules the animation in the first place rather than trying to cut it short partway through.
 */

/** True must hold this long before anything shows, so a single flickered sample stays silent. */
export const OVERDRIVE_ENGAGE_MS = 100;
/** A re-engage inside this long after the last release shows the badge only - no replayed warp. */
export const OVERDRIVE_COOLDOWN_MS = 2000;
/** How long the warp plays once it starts: Plaid's launch animation, brief and dramatic. */
export const OVERDRIVE_WARP_MS = 1200;

export function createOverdriveDebounce({
  engageMs = OVERDRIVE_ENGAGE_MS,
  cooldownMs = OVERDRIVE_COOLDOWN_MS,
  warpMs = OVERDRIVE_WARP_MS,
  reducedMotion = false,
} = {}) {
  let phase = "idle";   // idle | arming | warp | badge - "arming" never leaves this function
  let armedAt = null;   // when the raw flag went true, while unconfirmed
  let warpAt = null;    // when the warp phase started
  let endedAt = null;   // when a shown engage (warp or badge) last let go, for the cooldown

  function next(rawOn, nowMs) {
    if (!rawOn) {
      // Only a shown engage counts as an ending: a flicker that never reached engageMs was never
      // shown, and letting it set endedAt would wrongly skip the warp on the engage that follows it.
      if (phase === "warp" || phase === "badge") endedAt = nowMs;
      phase = "idle";
      armedAt = null;
      warpAt = null;
      return "idle";
    }
    if (phase === "idle") {
      phase = "arming";
      armedAt = nowMs;
    }
    if (phase === "arming") {
      if (nowMs - armedAt < engageMs) return "idle";
      const fresh = endedAt === null || nowMs - endedAt > cooldownMs;
      phase = fresh && !reducedMotion ? "warp" : "badge";
      if (phase === "warp") warpAt = nowMs;
    }
    if (phase === "warp" && nowMs - warpAt >= warpMs) phase = "badge";
    return phase;
  }

  return { next };
}
