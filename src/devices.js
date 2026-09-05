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
