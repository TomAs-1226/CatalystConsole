/* REBUILT's hub schedule: whether an alliance's HUB scores at a point in the match, and how long until
 * that changes.
 *
 * From the 2026 game manual (Table 6-2). AUTO runs 20 s and TELEOP 140 s, and the match clock counts
 * down within each period, so every segment is written as the time remaining at its two ends. Both HUBS
 * are active through AUTO, the TRANSITION SHIFT and END GAME. Through shifts 1-4 they alternate: the
 * alliance that scored more FUEL in AUTO is inactive for shift 1, and FMS names that alliance in the
 * game-specific message a few seconds into teleop.
 *
 * Kept apart from app.js so the schedule can be tested without a match: the mistakes it guards against -
 * a countdown to the wrong moment, a warning for a change that never comes - only show on a field. */

export const AUTO_S = 20;
export const TELEOP_S = 140;

export const TELEOP_SEGMENTS = Object.freeze([
  { name: "Transition", from: 140, to: 130, both: true },
  { name: "Shift 1", from: 130, to: 105, shift: 1 },
  { name: "Shift 2", from: 105, to: 80, shift: 2 },
  { name: "Shift 3", from: 80, to: 55, shift: 3 },
  { name: "Shift 4", from: 55, to: 30, shift: 4 },
  { name: "End game", from: 30, to: 0, both: true },
]);

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * The alliance whose hub sits out shift 1, from the FMS game-specific message.
 *
 * WPILib documents the 2026 message as one character, `R` or `B`. It is an empty string until roughly
 * three seconds after auto ends, once scoring has been assessed, so null is the normal answer for the
 * first part of a match rather than a fault.
 */
export function inactiveFirst(message) {
  const text = String(message ?? "").trim().toLowerCase();
  if (text.startsWith("r")) return "red";
  if (text.startsWith("b")) return "blue";
  return null;
}

/** The teleop segment a match clock reading falls in. A boundary belongs to the segment it starts. */
export function segmentAt(t) {
  if (t === null || t === undefined || !Number.isFinite(t) || t < 0) return null;
  return TELEOP_SEGMENTS.find((s) => t > s.to) || TELEOP_SEGMENTS[TELEOP_SEGMENTS.length - 1];
}

/** Whether `side`'s hub is active in `segment`: true, false, or null while the game data is not in. */
export function activeIn(segment, side, first) {
  if (!segment) return null;
  if (segment.both) return true;
  if (!side || !first) return null;
  // The named alliance sits out the odd shifts, and the other alliance the even ones.
  const odd = segment.shift % 2 === 1;
  return first === side ? !odd : odd;
}

/**
 * Everything the Hub activation tile draws, from the match clock and what FMS has sent.
 *
 * `left` counts down to the moment this alliance's hub actually changes, not to the end of the segment
 * it is in: an alliance active in shift 4 stays active through end game, so its hub does not close at
 * 0:30 and nothing may warn that it will. `until` says what `left` counts to:
 *
 * - `"change"`  the hub goes to `next`, which is the opposite of `active`
 * - `"segment"` the segment ends and what follows is not known yet (no game data, or no alliance)
 * - `"end"`     the hub stays as it is until the match is over
 *
 * `plan` is the whole of teleop with each segment's state for this alliance and how much of it has run,
 * 0 to 1, which is what the tile's schedule strip draws.
 */
export function hubPlan({ t = null, auto = false, enabled = false, side = null, first = null } = {}) {
  const clock = typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : null;
  const plan = TELEOP_SEGMENTS.map((s) => ({
    name: s.name, from: s.from, to: s.to, both: Boolean(s.both), active: activeIn(s, side, first), done: 0,
  }));
  const idle = { period: "none", active: null, left: null, until: null, next: null, segment: null, index: -1, plan, autoDone: 0 };
  if (clock === null || !enabled) return idle;

  if (auto) {
    // Both hubs score all through auto. What comes after depends on an auto result that does not exist
    // yet, so there is no honest countdown to give.
    return { ...idle, period: "auto", active: true, autoDone: clamp01(1 - clock / AUTO_S) };
  }

  const at = Math.min(clock, TELEOP_S);
  const segment = segmentAt(at);
  const index = TELEOP_SEGMENTS.indexOf(segment);
  plan.forEach((s, i) => {
    s.done = i < index ? 1 : i > index ? 0 : clamp01((s.from - at) / (s.from - s.to));
  });
  const active = plan[index].active;
  const base = { ...idle, period: "teleop", segment: plan[index], index, autoDone: 1 };
  if (active === null) {
    return { ...base, left: Math.max(0, clock - segment.to), until: "segment", next: plan[index + 1] ?? null };
  }

  let j = index + 1;
  while (j < plan.length && plan[j].active === active) j++;
  if (j >= plan.length) return { ...base, active, left: clock, until: "end" };
  const left = Math.max(0, clock - plan[j].from);
  if (plan[j].active === null) return { ...base, active, left, until: "segment", next: plan[j] };
  return { ...base, active, left, until: "change", next: plan[j] };
}
