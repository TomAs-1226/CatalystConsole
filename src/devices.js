/* What the robot is made of and whether it is answering, the notices worth putting in front of a
 * driver, and where a robot may be drawn on the field.
 *
 * Pure functions over a read-only view of NetworkTables, so every rule here runs under node --test
 * with no DOM and no robot. app.js supplies the `read` object:
 *
 *   read.num(key)  read.str(key)  read.arr(key)  read.has(key)  read.keys()  read.linked
 *
 * Nothing in here invents a number. Where the robot publishes a count, the count is shown; where it
 * does not, the fallback is what can be *seen* on the wire, and the result says which it was. */

/* Half the drawn robot, bumper to bumper. field3d.js builds a 28 in frame in 3 in bumpers, 0.86 m
 * square, so a robot whose centre is closer than this to a wall is drawn through it. */
export const ROBOT_HALF_METERS = 0.45;

/* ---------------------------------------------------------------- field bounds */

/** Keep a drawn pose inside the field, and say whether that changed it.
 *
 *  The pose estimator can legitimately answer with a point outside the carpet - a camera-only pose
 *  on a bench, a wrong transform, an estimator that has not converged - and the 3D view used to draw
 *  the robot there, half through a wall or off the slab entirely. The x/y readouts must still show
 *  the real numbers; only the drawing is held to the field. `clamped` is how the tile says so. */
export function clampToField(pose, length, width, half = ROBOT_HALF_METERS) {
  if (!Array.isArray(pose) || pose.length < 3 || !pose.every((n) => Number.isFinite(n))) return null;
  const [x, y, theta] = pose;
  const lo = Math.min(half, length / 2);
  const wlo = Math.min(half, width / 2);
  const cx = Math.min(Math.max(x, lo), length - lo);
  const cy = Math.min(Math.max(y, wlo), width - wlo);
  return { x: cx, y: cy, theta, clamped: cx !== x || cy !== y };
}

/* ---------------------------------------------------------------- where the robot is */

/* Metres inside which an estimator pose has never left the origin it booted at. */
const ORIGIN_METERS = 1e-3;
/* How recently a Limelight pose must have changed to count as a live fix, in milliseconds. A camera
 * that sees tags publishes a slightly different solve every frame; one that has frozen repeats the
 * last one, and would otherwise hold the robot where it stood when it froze. */
export const VISION_FRESH_MS = 500;

/* The Limelight tables to look in: the cameras Catalyst's vision health names, and any table on the
 * wire publishing a blue-origin robot pose. */
function cameraTables(read) {
  const names = new Set();
  const listed = read.arr("/Catalyst/Vision/Health/Names");
  if (Array.isArray(listed)) {
    for (const name of listed) if (typeof name === "string" && name.trim()) names.add(name.trim().replace(/^\/+/, ""));
  }
  for (const key of read.keys()) {
    const match = /^\/([^/]+)\/botpose(?:_orb)?_wpiblue$/.exec(key);
    if (match) names.add(match[1]);
  }
  return [...names];
}

/**
 * The best live robot pose any Limelight is reporting, or null.
 *
 * Read from each camera's classic tables, which is what a Limelight on 2026 firmware publishes and what
 * Catalyst itself reads on this robot: `botpose_orb_wpiblue` (MegaTag2, which uses the robot's own
 * heading) before `botpose_wpiblue` (MegaTag1). Both are blue-origin
 * [x, y, z, roll, pitch, yaw°, latency ms, tag count, tag span, average tag distance, average tag area].
 *
 * A fix counts when it has at least one tag, is not all zeros (nothing seen), lies on the field, has
 * changed within VISION_FRESH_MS, and is not the unplaceable-tag reading: a tag the camera sees but
 * cannot put on the field map comes through as one tag at exactly the field's centre, and the only way
 * to tell it from a real fix is that the centre-origin twin (`botpose_orb`, `botpose`) is all zeros.
 * That is the same test Catalyst's LegacyLimelightReader makes.
 *
 * Returns { camera, megatag, x, y, yaw (radians), tags, distance } for the camera seeing the most tags,
 * then MegaTag2 over MegaTag1, then the nearest tags.
 */
export function limelightFix(read, { length = 16.54, width = 8.07, age = () => Infinity } = {}) {
  let best = null;
  for (const camera of cameraTables(read)) {
    for (const [blue, centre, megatag] of [["botpose_orb_wpiblue", "botpose_orb", 2], ["botpose_wpiblue", "botpose", 1]]) {
      const key = `/${camera}/${blue}`;
      const a = read.arr(key);
      if (!Array.isArray(a) || a.length < 8 || !a.slice(0, 8).every(Number.isFinite)) continue;
      if (!(a[7] >= 1)) continue;
      if (a.slice(0, 6).every((v) => v === 0)) continue;
      const twin = read.arr(`/${camera}/${centre}`);
      if (Array.isArray(twin) && twin.length >= 6 && twin.slice(0, 6).every((v) => v === 0)) continue;
      if (!(age(key) <= VISION_FRESH_MS)) continue;
      const [x, y] = a;
      if (x < -0.5 || y < -0.5 || x > length + 0.5 || y > width + 0.5) continue;
      const candidate = {
        camera,
        megatag,
        x,
        y,
        yaw: (a[5] * Math.PI) / 180,
        tags: a[7],
        distance: a.length > 9 && Number.isFinite(a[9]) ? a[9] : Infinity,
      };
      const better =
        !best ||
        candidate.tags > best.tags ||
        (candidate.tags === best.tags &&
          (candidate.megatag > best.megatag || (candidate.megatag === best.megatag && candidate.distance < best.distance)));
      if (better) best = candidate;
      break;
    }
  }
  return best;
}

/** The swerve subsystem's pose estimate, a Pose2d struct the NT client decodes to [x, y, theta]. */
export const SWERVE_POSE_KEY = "/Catalyst/Swerve/Pose";

/**
 * Where the robot is on the field, and what says so.
 *
 * The drivetrain's pose estimator, which Physics Core republishes on /Catalyst/Physics/PoseArray, boots
 * believing the robot is at the field origin - a corner - and stays there until something moves it:
 * Catalyst's vision seeding it from a good Limelight fix, an autonomous routine resetting it, or the
 * robot driving. Drawn as it stands, every robot sat in the corner until the match began. So:
 *   1. the estimator's pose, once it has left the origin;
 *   2. otherwise a live Limelight fix (see limelightFix), with the estimator's heading, which is the
 *      gyro's, when there is one;
 *   3. otherwise nowhere: `placed` is false, and the view says the robot has not been placed rather
 *      than guessing.
 *
 * A robot that does not run Physics Core has no PoseArray; its swerve subsystem's own estimate, the
 * Pose2d on /Catalyst/Swerve/Pose, stands in for it.
 *
 * `age(key)` is how long ago, in milliseconds, a key's value last changed. Returns
 * { pose: [x, y, theta] | null, source: "estimator" | "vision" | null, camera, tags, placed, heading },
 * where `heading` is the best heading known even when the robot is not placed.
 */
export function robotPlacement(read, { poseKey = "/Catalyst/Physics/PoseArray", length = 16.54, width = 8.07, age = () => Infinity } = {}) {
  const usable = (pose) => Array.isArray(pose) && pose.length >= 3 && pose.slice(0, 3).every(Number.isFinite);
  let fused = read.arr(poseKey);
  if (!usable(fused) && poseKey !== SWERVE_POSE_KEY) fused = read.arr(SWERVE_POSE_KEY);
  const fusedOk = usable(fused);
  const heading = fusedOk ? fused[2] : null;
  const atOrigin = fusedOk && Math.abs(fused[0]) < ORIGIN_METERS && Math.abs(fused[1]) < ORIGIN_METERS;
  if (fusedOk && !atOrigin) {
    return { pose: [fused[0], fused[1], fused[2]], source: "estimator", camera: null, tags: 0, placed: true, heading };
  }
  const fix = limelightFix(read, { length, width, age });
  if (fix) {
    return {
      pose: [fix.x, fix.y, heading ?? fix.yaw],
      source: "vision",
      camera: fix.camera,
      tags: fix.tags,
      placed: true,
      heading: heading ?? fix.yaw,
    };
  }
  return { pose: null, source: null, camera: null, tags: 0, placed: false, heading };
}

/* ---------------------------------------------------------------- the path ahead */

/** Where a team's own planner publishes the path it means to drive. See drivePath. */
export const PLANNED_PATH_KEY = "/Catalyst/Drive/PlannedPath";
/** PathPlanner's path while it follows one: Pose2d[], which the NT client decodes to triples. */
export const PATHPLANNER_PATH_KEY = "/PathPlanner/activePath";

/**
 * The name of a Catalyst Autopilot driving the robot right now, or null.
 *
 * Autopilot publishes its phase to /Catalyst/Behavior/<name>/Phase: the action it is running, "Engaged",
 * "Stalled: ..." or "HandingBack: ..." while it has the robot, and "DriverControl" once the driver has
 * it back.
 */
export function engagedAutopilot(read) {
  for (const key of read.keys()) {
    const match = /^\/Catalyst\/Behavior\/([^/]+)\/Phase$/.exec(key);
    if (!match) continue;
    const phase = read.str(key, "");
    if (phase && phase !== "DriverControl") return match[1];
  }
  return null;
}

/* The last usable [x, y, heading] of a path array: where it ends, and facing which way. */
function pathEnd(raw, length, width) {
  if (!Array.isArray(raw)) return null;
  for (let i = Math.floor(raw.length / 3) * 3 - 3; i >= 0; i -= 3) {
    const [x, y, heading] = [raw[i], raw[i + 1], raw[i + 2]];
    if (![x, y, heading].every(Number.isFinite)) continue;
    if (x < -1 || y < -1 || x > length + 1 || y > width + 1) continue;
    return [x, y, heading];
  }
  return null;
}

/* A path as [x, y, heading] triples, field metres from the blue origin, cleaned: non-numbers and
   points far off the field dropped. */
function pathPoints(raw, length, width) {
  if (!Array.isArray(raw) || raw.length < 6 || raw.length % 3 !== 0) return null;
  const points = [];
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const x = raw[i];
    const y = raw[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < -1 || y < -1 || x > length + 1 || y > width + 1) continue;
    points.push([x, y]);
  }
  return points.length >= 2 ? points : null;
}

/**
 * The path the robot means to drive, and what kind of plan it is.
 *
 * Read from, in order:
 *   1. /Catalyst/Drive/PlannedPath: a team's own planner, as a number array of [x, y, heading] per
 *      point in field metres. /Catalyst/Drive/PlannedPathSource says what made it; "autopilot",
 *      "vision" and "improvised" draw it as an improvised plan, anything else as a planned path.
 *   2. /PathPlanner/activePath: the path PathPlanner is following.
 *
 * `end` is where the path finishes, [x, y, heading], which the field view marks as the destination.
 *
 * A plan counts as improvised when its source says so, or whenever a Catalyst Autopilot is engaged:
 * its actions pathfind on the fly, and PathPlanner publishes that made-up path on the same topic as a
 * drawn one, so the topic alone cannot tell them apart.
 *
 * Returns { points: [[x, y], ...], style: "planned" | "improvised", source, autopilot } or null.
 */
export function drivePath(read, { length = 16.54, width = 8.07 } = {}) {
  const autopilot = engagedAutopilot(read);
  const own = pathPoints(read.arr(PLANNED_PATH_KEY), length, width);
  if (own) {
    const said = String(read.str(`${PLANNED_PATH_KEY}Source`, "") || "").toLowerCase();
    const improvised = autopilot !== null || /autopilot|vision|improvis/.test(said);
    return {
      points: own,
      end: pathEnd(read.arr(PLANNED_PATH_KEY), length, width),
      style: improvised ? "improvised" : "planned",
      source: said || "planner",
      autopilot,
    };
  }
  const followed = pathPoints(read.arr(PATHPLANNER_PATH_KEY), length, width);
  if (followed) {
    return {
      points: followed,
      end: pathEnd(read.arr(PATHPLANNER_PATH_KEY), length, width),
      style: autopilot !== null ? "improvised" : "planned",
      source: "pathplanner",
      autopilot,
    };
  }
  return null;
}

/* ---------------------------------------------------------------- devices */

const MOTOR_TYPE = /talon|kraken|falcon|spark|neo|vortex|venom|motor/i;
const DEVICES = "/Catalyst/Devices/";

function rows(read, key, fields) {
  const raw = read.arr(key);
  if (!Array.isArray(raw)) return null;
  return raw
    .map((r) => String(r).split("|"))
    .filter((p) => p.length >= fields)
    .map((p) => p.map((s) => s.trim()));
}

function parseBool(s) {
  return String(s).toLowerCase() === "true";
}

/** The three counts for the header strip.
 *
 *  Preference order, per count:
 *    1. the robot's device roster (`/Catalyst/Devices/...`), which knows what was declared *and*
 *       what is answering;
 *    2. what can be inferred from other topics - camera tables on the wire, the spec sheet's device
 *       tree, the identity's controller name - which knows what exists but not whether it answers,
 *       so `connected` is null there and the strip shows a count without a fraction.
 *  `source` records which, because a "4" that means "four tables exist" is a different claim from a
 *  "4/4" that means four heartbeats are advancing. */
export function deviceSummary(read) {
  const out = {
    cameras: { expected: 0, connected: null, rows: [], source: "none" },
    motors: { expected: 0, connected: null, rows: [], source: "none" },
    controller: { kind: null, connected: null, source: "none" },
    any: false,
  };

  // 1. roster
  if (read.has(`${DEVICES}Cameras/Expected`)) {
    const r = rows(read, `${DEVICES}Cameras/Rows`, 3) || [];
    out.cameras = {
      expected: read.num(`${DEVICES}Cameras/Expected`, 0),
      connected: read.num(`${DEVICES}Cameras/Connected`, 0),
      rows: r.map(([name, up, detail]) => ({ name, connected: parseBool(up), detail })),
      source: "roster",
    };
  } else {
    // 2. camera tables on the wire: /limelight-left/tv, /limelight/hb ...
    const names = new Set();
    for (const k of read.keys()) {
      const m = /^\/(limelight[^/]*)\//.exec(k);
      if (m) names.add(m[1]);
    }
    if (names.size) {
      out.cameras = {
        expected: names.size,
        connected: null,
        rows: [...names].sort().map((name) => ({ name, connected: null, detail: "publishing" })),
        source: "topics",
      };
    }
  }

  if (read.has(`${DEVICES}Motors/Expected`)) {
    const r = rows(read, `${DEVICES}Motors/Rows`, 4) || [];
    out.motors = {
      expected: read.num(`${DEVICES}Motors/Expected`, 0),
      connected: read.num(`${DEVICES}Motors/Connected`, 0),
      rows: r.map(([name, bus, id, up]) => ({ name, connected: parseBool(up), detail: `${bus} · ${id}` })),
      source: "roster",
    };
  } else {
    const tree = rows(read, "/Catalyst/Robot/Hardware/Devices", 3) || [];
    const motors = tree.filter(([, , type]) => MOTOR_TYPE.test(type));
    if (motors.length) {
      out.motors = {
        expected: motors.length,
        connected: null,
        rows: motors.map(([bus, id, type]) => ({ name: type, connected: null, detail: `${bus} · ${id}` })),
        source: "spec",
      };
    }
  }

  if (read.has(`${DEVICES}Controller/Kind`)) {
    out.controller = {
      kind: read.str(`${DEVICES}Controller/Kind`, "Controller"),
      connected: read.bool ? read.bool(`${DEVICES}Controller/Connected`, null) : null,
      source: "roster",
    };
  } else {
    const kind = read.str("/Catalyst/Robot/Identity/Controller", null)
      || (read.has("/Catalyst/Systemcore/BatteryVolts") ? "Systemcore" : null);
    if (kind) out.controller = { kind, connected: read.linked ? true : null, source: "identity" };
  }

  out.any = out.cameras.expected > 0 || out.motors.expected > 0 || out.controller.kind !== null;
  return out;
}

/** ok / warn / bad / none for one count, the way the strip colours it. */
export function countState(count) {
  if (!count.expected) return "none";
  if (count.connected === null) return "seen";
  if (count.connected === 0) return "bad";
  if (count.connected < count.expected) return "warn";
  return "ok";
}

/* ---------------------------------------------------------------- notices */

const HEALTH = "/Catalyst/Vision/Health/";
const START = "/Catalyst/Auto/StartCheck/";

const STATE_WORDS = {
  DISCONNECTED: "no data from the camera",
  STALE: "frames have stopped",
  HOT: "running hot",
  LOW_FPS: "frame rate is low",
  REJECTING: "most estimates rejected",
};

/** Everything that deserves the bar above the board, most severe first.
 *
 *  Vision faults come from the robot's per-camera health rows rather than from the alert list, so the
 *  bar can say *what* is wrong with a camera (the detail the robot computed) instead of only that it
 *  is. Robot errors of any kind come through too - an error is an error - and the auto start check
 *  gets a line while the robot is disabled, because that is the ninety seconds it is for.
 *
 *  Each notice has a stable `key`, which is what lets the caller hold a vanished notice on screen for
 *  a moment instead of strobing it. */
export function notices(read, { enabled = false } = {}) {
  const out = [];

  for (const text of read.arr("/Catalyst/Alerts/Errors") || []) {
    out.push({ level: "error", key: `alert:${text}`, text: String(text), detail: "" });
  }

  const level = read.num(`${HEALTH}Level`, null);
  if (level !== null) {
    const summary = read.str(`${HEALTH}Summary`, "");
    if (level >= 2) {
      out.push({ level: "error", key: "vision:blind", text: "Vision is blind", detail: summary });
    }
    for (const [name, state, detail] of rows(read, `${HEALTH}Rows`, 3) || []) {
      const words = STATE_WORDS[state];
      if (!words) continue;
      // The robot's detail for a disconnected camera is the same sentence as the state, and a line
      // that says one thing twice reads as a bug. Keep the detail when it adds a number or a reason.
      const extra = detail && detail.trim().toLowerCase() !== words ? detail : "";
      out.push({ level: "warn", key: `vision:${name}`, text: `${name}: ${words}`, detail: extra });
    }
  }

  if (!enabled && read.bool && read.bool(`${START}Available`, false)) {
    const ready = read.bool(`${START}Ready`, false);
    const d = read.num(`${START}DistanceMeters`, null);
    const h = read.num(`${START}HeadingErrorDeg`, null);
    const numbers = d === null || h === null ? "" : `${d.toFixed(2)} m, ${Math.abs(h).toFixed(0)}° off`;
    out.push(ready
      ? { level: "info", key: "auto:start", text: "At the auto's starting pose", detail: numbers }
      : { level: "warn", key: "auto:start", text: "Not at the auto's starting pose", detail: numbers });
  }

  const rank = { error: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level]);
  return out;
}
