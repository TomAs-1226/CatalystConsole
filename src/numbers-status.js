/* What team 5805's robot "Numbers" says about itself for the drive team, read the way the rest of the
 * console reads a robot: only what it publishes, and nothing at all for a key it does not.
 *
 * Numbers publishes these through CatalystLog, so they sit under /Catalyst/: why a shot is being held
 * (RobotManager/BlockedBy) and what the robot is doing (RobotManager/State), how far it trusts its own
 * pose (Numbers/Localization/*), who has the drive and how fast the driver is allowed to go
 * (Numbers/DriveOwner, Numbers/Driver/Governor), who won auto and who said so (HubActivity/WinnerSource,
 * WonAuto), whether its own hub schedule has the HUB on (HubActivity/ActualHubActive,
 * TimeUntilNextShift), which drive assist is steering (Numbers/Assist), which tags vision solves from
 * (Numbers/Vision/TagMode), roughly how many balls it has fired (Numbers/Shots/ThisMatch), and where
 * auto got its starting pose (Numbers/Auto/PoseFrom).
 *
 * Pure, so every wording below is tested without a robot. Another robot, or an older build of this one,
 * publishes none or some of these: every field is then null, and every function here turns a null into
 * nothing to draw rather than a guess.
 */

const ROOT = "/Catalyst/";

export const KEYS = Object.freeze({
  blockedBy: `${ROOT}RobotManager/BlockedBy`,
  state: `${ROOT}RobotManager/State`,
  locLevel: `${ROOT}Numbers/Localization/Level`,
  locWhy: `${ROOT}Numbers/Localization/Why`,
  locSince: `${ROOT}Numbers/Localization/SecondsSinceFix`,
  owner: `${ROOT}Numbers/DriveOwner`,
  governor: `${ROOT}Numbers/Driver/Governor`,
  winnerSource: `${ROOT}HubActivity/WinnerSource`,
  wonAuto: `${ROOT}HubActivity/WonAuto`,
  hubActive: `${ROOT}HubActivity/ActualHubActive`,
  hubLeft: `${ROOT}HubActivity/TimeUntilNextShift`,
  assist: `${ROOT}Numbers/Assist`,
  tagMode: `${ROOT}Numbers/Vision/TagMode`,
  shots: `${ROOT}Numbers/Shots/ThisMatch`,
  poseFrom: `${ROOT}Numbers/Auto/PoseFrom`,
});

/* The blockers a driver can do something about. Every other one - the heading still turning, the
 * flywheel spinning up, the HUB off - clears on its own, and the driver's job is to keep holding. */
export const DRIVER_FIXABLE = Object.freeze(new Set([
  "MOVING TOO FAST", "STEADY THE STICK", "NEAR TRENCH", "OUT OF ZONE", "STOP TO SHOOT (NO POSE)",
]));

const STATE_WORDS = Object.freeze({
  IDLE: "Idle",
  PREPARE_FORCE_SCORE: "Lining up a forced shot",
  FORCE_SCORE: "Forced shot",
  WARMUP_SCORE: "Warming up to score",
  PREPARE_SCORE: "Lining up the shot",
  SCORE: "Shooting",
  WARMUP_FEED: "Warming up to feed",
  PREPARE_FEED: "Lining up to feed",
  FEED: "Feeding",
  PREPARE_FALLBACK_SCORE: "Lining up · no pose",
  FALLBACK_SCORE: "Shooting · no pose",
  PREPARE_FALLBACK_FEED: "Lining up to feed · no pose",
  FALLBACK_FEED: "Feeding · no pose",
  UNJAM: "Unjamming",
});

/* The states in which a ball is actually leaving the robot. */
const FIRING = new Set(["SCORE", "FORCE_SCORE", "FEED", "FALLBACK_SCORE", "FALLBACK_FEED"]);

const LEVELS = ["TRUSTED", "HEALTHY", "DEGRADED", "LOST"];

const OWNER_WORDS = Object.freeze({
  DRIVER: "Driver",
  DRIVER_AIMED: "Driver · auto-aim",
  OPERATOR: "Operator driving",
  OPERATOR_AIMED: "Operator driving · auto-aim",
  AUTO: "Auto driving",
});

const ASSIST_WORDS = Object.freeze({ TRENCH: "Trench assist", BUMP: "Bump assist", GO_SHOOT: "Go-shoot assist" });

const TAG_WORDS = Object.freeze({
  ALL_TAGS: "all tags",
  WAITING_FOR_HUB_TAGS: "waiting for hub tags",
  HUB_TAGS: "hub tags only",
});

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === "string" ? v.trim() : null);

/** IDLE_DEPLOYED -> "Idle deployed": for a state or word this file has no wording for. */
function plain(word) {
  const s = word.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Everything above, out of a read-only NetworkTables view (`str`, `num`, `bool`, `has`, as devices.js
 * takes). A key the robot does not publish is null, and so is one of the wrong type.
 */
export function readNumbersStatus(read) {
  const s = (k) => text(read.str(k, null));
  const n = (k) => finite(read.num(k, null));
  const hubActive = read.has && !read.has(KEYS.hubActive) ? null : read.bool(KEYS.hubActive, null);
  const level = s(KEYS.locLevel)?.toUpperCase() ?? null;
  return {
    blockedBy: s(KEYS.blockedBy),
    state: s(KEYS.state),
    loc: {
      level: level && LEVELS.includes(level) ? level : null,
      why: s(KEYS.locWhy),
      since: n(KEYS.locSince),
    },
    owner: s(KEYS.owner)?.toUpperCase() ?? null,
    governor: n(KEYS.governor),
    winner: { source: s(KEYS.winnerSource)?.toUpperCase() ?? null, won: s(KEYS.wonAuto)?.toUpperCase() ?? null },
    hub: { active: typeof hubActive === "boolean" ? hubActive : null, left: n(KEYS.hubLeft) },
    assist: s(KEYS.assist)?.toUpperCase() ?? null,
    tagMode: s(KEYS.tagMode)?.toUpperCase() ?? null,
    shots: n(KEYS.shots),
    poseFrom: s(KEYS.poseFrom),
  };
}

/** Whether the robot publishes any of this at all: a robot that does not gets no Numbers tile content. */
export function hasNumbersStatus(st) {
  return Boolean(st && (st.blockedBy !== null || st.state !== null || st.loc.level !== null || st.owner !== null));
}

/** The robot's state in words a new driver reads at a glance, or null with no state published. */
export function stateWords(state) {
  const s = text(state);
  if (!s) return null;
  return STATE_WORDS[s.toUpperCase()] ?? plain(s);
}

/**
 * The driver's one line: why the shot is held when something holds it, otherwise what the robot is
 * doing. `{ text, kind, sub }`, where `kind` is
 *
 * - `"act"`   a blocker the driver can fix (slow down, steady the stick, get out of the trench...)
 * - `"hold"`  a blocker that clears on its own: keep holding
 * - `"fire"`  no blocker, and a ball is leaving the robot
 * - `"state"` no blocker, anything else
 *
 * and null when the robot publishes neither key.
 */
export function driverLine(st) {
  const blocked = text(st?.blockedBy);
  const doing = stateWords(st?.state);
  if (blocked) {
    const act = DRIVER_FIXABLE.has(blocked.toUpperCase());
    return {
      text: blocked.toUpperCase(),
      kind: act ? "act" : "hold",
      sub: act ? "Driver: fix this to shoot" : `Holding the shot${doing ? ` · ${doing}` : ""}`,
    };
  }
  if (!doing) return null;
  return { text: doing, kind: FIRING.has(String(st.state).toUpperCase()) ? "fire" : "state", sub: "" };
}

/** Seconds since the last vision fix, the way a person says it. The robot caps the figure at 999. */
export function sinceText(seconds) {
  const s = finite(seconds);
  if (s === null || s < 0) return null;
  if (s >= 999) return "no fix for 16+ min";
  if (s < 10) return `last fix ${s.toFixed(1)} s ago`;
  if (s < 60) return `last fix ${Math.round(s)} s ago`;
  return `last fix ${Math.floor(s / 60)} min ago`;
}

/**
 * The localization badge: `{ level, word, detail }` with `level` the lowercase level for styling
 * ("trusted", "healthy", "degraded", "lost"), or null when the robot publishes no level.
 */
export function locBadge(st) {
  const level = st?.loc?.level;
  if (!level) return null;
  const word = { TRUSTED: "Pose trusted", HEALTHY: "Pose healthy", DEGRADED: "Pose degraded", LOST: "Pose lost" }[level];
  const why = level === "TRUSTED" ? null : text(st.loc.why) || null;
  const since = level === "TRUSTED" ? null : sinceText(st.loc.since);
  return { level: level.toLowerCase(), word, detail: [why, since].filter(Boolean).join(" · ") };
}

/** The vision tag mode in words, or null. */
export function tagModeText(mode) {
  const m = text(mode)?.toUpperCase();
  if (!m) return null;
  return TAG_WORDS[m] ?? plain(m).toLowerCase();
}

/**
 * Who has the drive: `{ text, operator, auto }`, or null with no owner published. `operator` is true
 * whenever the operator has the sticks, which is the one the driver must not miss.
 */
export function ownerText(owner) {
  const o = text(owner)?.toUpperCase();
  if (!o) return null;
  return { text: OWNER_WORDS[o] ?? plain(o), operator: o.startsWith("OPERATOR"), auto: o === "AUTO" };
}

/** "Driver 70%" when the operator has limited the driver's speed, otherwise null (full speed or absent). */
export function governorText(governor) {
  const g = finite(governor);
  if (g === null || g >= 0.995 || g < 0) return null;
  return `Driver ${Math.round(g * 100)}%`;
}

/** The robot's own hub schedule: "HUB ON · 12 s" / "HUB OFF · 12 s", or null without the robot's answer. */
export function hubText(st) {
  const active = st?.hub?.active;
  if (typeof active !== "boolean") return null;
  const left = finite(st.hub.left);
  const word = active ? "HUB ON" : "HUB OFF";
  return left !== null && left > 0 ? `${word} · ${Math.ceil(left)} s` : word;
}

/** Who won auto, and on whose word: "Won auto (FMS)", "Auto winner unknown", or null with nothing published. */
export function winnerText(winner) {
  const source = text(winner?.source)?.toUpperCase();
  if (!source) return null;
  if (source === "UNKNOWN") return "Auto winner unknown";
  const won = text(winner.won)?.toUpperCase();
  const said = { FMS: "FMS", OPERATOR: "operator", SIM_DEFAULT: "sim default" }[source] ?? plain(source).toLowerCase();
  const result = won === "WON" ? "Won auto" : won === "LOST" ? "Lost auto" : "Auto result";
  return `${result} (${said})`;
}

/** The assist that is steering right now in words, or null for none / not published. */
export function assistText(assist) {
  const a = text(assist)?.toUpperCase();
  if (!a || a === "NONE") return null;
  return ASSIST_WORDS[a] ?? `${plain(a)} assist`;
}

/** "~23", the robot's own approximate count of balls fired this match, or null when it publishes none. */
export function shotsText(shots) {
  const n = finite(shots);
  if (n === null || n < 0) return null;
  return `~${Math.round(n)}`;
}

/**
 * The capsules these keys raise, in the shape devices.js's notices() returns: `{ level, key, text, detail }`.
 * Only while the robot is enabled - a pose that is lost in the pit, or no auto winner before a match, is
 * not news. `winnerUnknownHeld` is the caller's say that the robot has reported UNKNOWN for long enough in
 * teleop to be past the few seconds FMS takes to send its message.
 */
export function numbersNotices(st, { enabled = false, auto = false, winnerUnknownHeld = false } = {}) {
  const out = [];
  if (!st || !enabled) return out;
  if (st.loc.level === "LOST") {
    /* The reason only, not the seconds since the last fix: a capsule whose words change every tick is
       rebuilt every tick, and its buttons with it. */
    out.push({ level: "warn", key: "loc:lost", text: "Robot pose lost", detail: text(st.loc.why) || "shots are held until vision sees tags" });
  }
  if (!auto && st.winner.source === "UNKNOWN" && winnerUnknownHeld) {
    out.push({ level: "warn", key: "hub:winner", text: "Auto winner unknown", detail: "Operator: press won or lost" });
  }
  return out;
}

/**
 * Steadies the driver's line for reading at a glance: a new line is shown once it has held for `ms`, so a
 * blocker the robot passes through for a frame or two on its way to shooting does not flash up. The first
 * line, and a line going away entirely, show at once. `next(line, now)` returns the line to draw.
 */
export function createLineHold(ms = 250) {
  let shown = null;
  let pending = null;
  let since = 0;
  const same = (a, b) => (a?.text ?? null) === (b?.text ?? null) && (a?.kind ?? null) === (b?.kind ?? null);
  return {
    next(line, now) {
      if (!line || !shown) {
        shown = line ?? null;
        pending = null;
        return shown;
      }
      if (same(line, shown)) {
        shown = line;
        pending = null;
        return shown;
      }
      if (!same(line, pending)) {
        pending = line;
        since = now;
      }
      if (now - since >= ms) {
        shown = line;
        pending = null;
      }
      return shown;
    },
    reset() {
      shown = null;
      pending = null;
    },
  };
}
