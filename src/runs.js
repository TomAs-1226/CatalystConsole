/* Every stretch the robot is enabled, written up.
 *
 * Tesla writes up every drive. Console writes up every run - each stretch from an enable to the disable
 * after it - so a test session is judged by numbers rather than by feel: how long, how far, how fast,
 * how low the battery went, and, when the robot says what it is aiming at, how steadily it held the
 * target and how hard its wheels worked to do it. A day of testing buys a limited number of runs, and
 * each one should leave numbers that can be set beside the one before it.
 *
 * The recorder is fed the frames the page already gets, while the robot is being driven, so a frame has
 * to cost next to nothing: a dozen topic reads, a few running sums, and every SAMPLE_S one row written
 * into columns allocated once, up front. The columns hold `capacity` rows. A run longer than that keeps
 * every other row and samples half as often from then on, so an hour of practice costs the same memory
 * as a match and still covers all of it. Anything that sorts or scans - the 95th percentile, the median
 * time to lock - waits for the disable, when nobody is driving.
 *
 * Nothing is invented. A metric whose inputs the robot never published is null, and the page shows a
 * dash for it. A NaN on the wire arrives as null and is treated as absent, never as zero.
 *
 * Pure: `read` is the same read-only view of NetworkTables devices.js takes (`num`, `str`, `arr`,
 * `has`, `keys`, and `raw` for a key's `{ t, v }`), and time is whatever clock the caller passes, in
 * milliseconds.
 */

import { readTunables } from "./drivers.js";

/** How many runs the page keeps, with their traces, and how many summaries it stores. */
export const RUNS_KEPT = 20;
/** An enable shorter than this is a slip of the finger, not a run. */
export const MIN_RUN_S = 1;
/** Where the summaries are stored between sessions. Traces are not: they are the heavy part, and a run
 *  worth keeping in detail is exported. */
export const RUNS_STORE_KEY = "catalyst.console.runs.v1";

/* The topics a run is measured from. Each is read only if the robot publishes it. The pose is Physics
   Core's, or the swerve subsystem's own when there is no Physics Core; the battery is read from the same
   keys, in the same order, as the header's cell and the battery tile, so the run never disagrees with
   what was on screen while it happened. */
export const POSE_KEYS = ["/Catalyst/Physics/PoseArray", "/Catalyst/Swerve/Pose"];
export const BATTERY_KEYS = ["/Catalyst/Status/BatteryVolts", "/Catalyst/Brownout/MeasuredVoltage", "/Catalyst/Systemcore/BatteryVolts"];
export const AIM_STATE = "/Catalyst/Aim/State";
export const AIM_ERROR = "/Catalyst/Aim/HeadingErrorDeg";
export const AIM_TARGET = "/Catalyst/Aim/Target";
/* SwerveModuleState[] as the backend decodes it: [speed m/s, angle rad] per module (mechanisms.js). */
export const MODULE_STATES = "/Catalyst/Swerve/ModuleStates";
export const POSE_CONFIDENCE = "/Catalyst/Physics/Quality/Confidence";
export const VISION_ACCEPTED = "/Catalyst/Vision/TotalAccepted";
export const VISION_REJECTED = "/Catalyst/Vision/TotalRejected";
const CAMERA_NAMES = "/Catalyst/Vision/Health/Names";
const TAG_COUNT = /^\/Catalyst\/Vision\/([^/]+)\/TagCount$/;
const ROBOT_NAME = "/Catalyst/Robot/Identity/Name";
const OP_MODE = "/FMSInfo/OpMode";
/* 2027's control word; a robot that publishes it calls test mode utility (see ds.mode in app.js). */
const CONTROL_WORD_2027 = "/FMSInfo/ControlWord";

/* The control word's bits, as app.js decodes them. */
const ENABLED = 1;
const AUTONOMOUS = 2;
const TEST = 4;
const ESTOP = 8;

/** A row every 50 ms, twenty a second. Frames arrive at up to thirty, and only when something changed, so
 *  a faster schedule would mostly write the same frame twice. */
export const SAMPLE_S = 0.05;
/** Rows a run holds before it thins itself: 204 s at the full rate, longer than a match. */
export const SAMPLE_CAPACITY = 4096;

/* A frame's values are taken to hold until the next frame - frames only come when something changed -
   but a value averaged over time is weighted by no more than this, so one stall in the page does not
   hand a single reading seconds of weight. */
const HOLD_CAP_S = 0.5;
/* A pose that moves faster than any FRC robot drives was reset, not driven. Steps are judged over at
   least MIN_STEP_S, so two frames that happen to land a few milliseconds apart are not a teleport. */
const RESET_MPS = 8;
const MIN_STEP_S = 0.05;
/* Distance is counted in steps of at least this much, so the few millimetres a pose estimate wanders
   while the robot stands still never add up to metres over a long run. */
const DISTANCE_STEP_M = 0.05;
/* Speed is the pose's travel over at least this long: over one frame, a centimetre of estimator noise
   is half a metre a second. */
const SPEED_WINDOW_S = 0.25;
const POSE_RING = 32;
/* An aim that drops to idle for less than this is the same attempt (see createAimDebounce in
   mechanisms.js, whose dropMs this is), and a target that jumps further than this is a new one. */
const AIM_GAP_S = 0.6;
const NEW_TARGET_M = 0.5;
/* The heading error is binned for its percentile: 0.05 degree bins from 0 to 180 degrees. */
const ERROR_BIN_DEG = 0.05;
const ERROR_BINS = 3600;
const MAX_MODULES = 8;
const MAX_CAMERAS = 8;
const MAX_LOCKS = 512;
/** Tunables recorded per run. X1 declares 34; the cap keeps a strange manifest from filling storage. */
const TUNABLES_MAX = 64;

const AIM_CODE = Object.freeze({ IDLE: 0, ALIGNING: 1, ALIGNED: 2, SOTF: 3 });
export const AIM_NAMES = Object.freeze(["IDLE", "ALIGNING", "ALIGNED", "SOTF"]);

/** The columns a run's samples are kept in, in the order a CSV writes them. */
export const COLUMNS = Object.freeze(["t", "x", "y", "heading", "speed", "volts", "aim", "error", "steer", "tags", "confidence", "mode"]);

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const numOf = (read, key) => {
  const v = read.num(key, null);
  return finite(v) ? v : null;
};
const textOf = (read, key) => {
  const v = read.str(key, null);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
/** The shortest signed turn from `a` to `b`, radians. */
const turn = (a, b) => {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

function readPose(read) {
  for (const key of POSE_KEYS) {
    const p = read.arr(key);
    if (Array.isArray(p) && p.length >= 3 && finite(p[0]) && finite(p[1]) && finite(p[2])) return p;
  }
  return null;
}

function readBattery(read) {
  for (const key of BATTERY_KEYS) if (read.has(key)) return numOf(read, key);
  return null;
}

/** The cameras a run watches: the ones vision health names, and any publishing a tag count. Read once,
 *  at the enable, so a frame never walks the whole store. */
function cameraKeys(read) {
  const names = new Set();
  const listed = read.arr(CAMERA_NAMES);
  if (Array.isArray(listed)) {
    for (const name of listed) {
      const clean = typeof name === "string" ? name.trim().replace(/^\/+/, "") : "";
      if (clean && !clean.includes("/")) names.add(clean);
    }
  }
  for (const key of typeof read.keys === "function" ? read.keys() : []) {
    const match = TAG_COUNT.exec(key);
    if (match && match[1] !== "Health") names.add(match[1]);
  }
  return [...names].sort().slice(0, MAX_CAMERAS).map((name) => ({
    name,
    state: `/Catalyst/Vision/Health/${name}/State`,
    tags: `/Catalyst/Vision/${name}/TagCount`,
  }));
}

/**
 * The robot's declared tunables and their values as the run began, as `[[key, name, value], ...]`, or
 * null when it declares none. Numbers and switches only: those are what a tuning change is made of.
 */
export function snapshotTunables(read) {
  let entries;
  try {
    entries = readTunables(read);
  } catch {
    return null;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry.key !== "string" || !entry.key) continue;
    let value = null;
    if (typeof read.raw === "function") {
      const raw = read.raw(entry.key);
      if (raw?.t === "num" && finite(raw.v)) value = raw.v;
      else if (raw?.t === "bool" && typeof raw.v === "boolean") value = raw.v;
    } else {
      value = numOf(read, entry.key);
    }
    if (value === null) continue;
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.key;
    out.push([entry.key, name, value]);
    if (out.length >= TUNABLES_MAX) break;
  }
  return out.length ? out : null;
}

/** What changed between two runs' tunables: `[{ key, name, from, to }]` for every key both declare whose
 *  value differs. A key only one of them has is a different robot program, not a tuning change. */
export function tunableChanges(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const was = new Map();
  for (const entry of before) if (Array.isArray(entry)) was.set(entry[0], entry[2]);
  const out = [];
  for (const entry of after) {
    if (!Array.isArray(entry) || !was.has(entry[0])) continue;
    const [key, name, to] = entry;
    const from = was.get(key);
    const same = finite(from) && finite(to) ? Math.abs(from - to) <= 1e-9 : from === to;
    if (!same) out.push({ key, name, from, to });
  }
  return out;
}

/** The value `p` of the way through a histogram of weights in bins `width` wide, interpolated inside the
 *  bin it lands in. */
function histogramPercentile(bins, width, total, p) {
  const goal = total * p;
  let below = 0;
  for (let i = 0; i < bins.length; i++) {
    const w = bins[i];
    if (w <= 0) continue;
    if (below + w >= goal) return (i + Math.min(1, Math.max(0, (goal - below) / w))) * width;
    below += w;
  }
  return bins.length * width;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* One frame's worth of what is held until the next: what the time between two frames is credited to. */
function frameState() {
  return {
    mode: 1,            // 0 auto, 1 teleop, 2 test
    aim: -1,            // -1 unpublished, else an index into AIM_NAMES
    error: NaN,         // the signed heading error while aiming, degrees
    holding: false,     // aiming, and locked on at least once since this attempt began
    seeing: -1,         // -1 no camera's health published, 0 none seeing tags, 1 at least one
    tags: NaN,          // the most tags any camera that is seeing them sees
    confidence: NaN,
    modules: new Float64Array(MAX_MODULES),
    moduleCount: 0,
  };
}

/**
 * A recorder for runs. Call `frame(timeMs, read, { word, linked, wall, shots })` on every frame:
 *
 *   word    the control word (app.js controlWord), or null when the robot publishes none
 *   linked  false while there is no robot on the other end (a dropped link ends a run)
 *   wall    wall-clock milliseconds, to stamp the run with when it began
 *   shots   the FUEL-shot estimate's running count (mechanisms.js), or null for a robot with no shooter
 *
 * It returns the finished run on the frame that ends one, and null otherwise. A run is its summary -
 * see `finish` below for every field - plus `samples`, the rows it recorded.
 */
export function createRunRecorder({ sampleS = SAMPLE_S, capacity = SAMPLE_CAPACITY } = {}) {
  const rowsCap = Math.max(16, capacity & ~1);
  const columns = Object.fromEntries(COLUMNS.map((c) => [c, new Float32Array(rowsCap)]));
  const bins = new Float64Array(ERROR_BINS);
  const ring = { t: new Float64Array(POSE_RING), x: new Float64Array(POSE_RING), y: new Float64Array(POSE_RING), n: 0, head: 0 };
  let prev = frameState();
  let next = frameState();
  /* Whether this link has shown the robot disabled, so an enable is the start of a run rather than the
     middle of one that began before the console was watching. */
  let armed = false;
  let run = null;
  let serial = 0;

  function ringPush(t, x, y) {
    ring.head = (ring.head + 1) % POSE_RING;
    ring.t[ring.head] = t;
    ring.x[ring.head] = x;
    ring.y[ring.head] = y;
    ring.n = Math.min(POSE_RING, ring.n + 1);
  }

  /* How fast the pose travelled over the last SPEED_WINDOW_S or so, or NaN without that much history. */
  function ringSpeed(t, x, y) {
    for (let k = 1; k < ring.n; k++) {
      const i = (ring.head - k + POSE_RING) % POSE_RING;
      const dt = t - ring.t[i];
      if (dt >= SPEED_WINDOW_S) return Math.hypot(x - ring.x[i], y - ring.y[i]) / dt;
    }
    return NaN;
  }

  function start(t, read, word, wall, shots) {
    serial += 1;
    run = {
      serial,
      t0: t,
      last: t,
      wall: finite(wall) ? wall : null,
      partial: !armed,
      robot: textOf(read, ROBOT_NAME),
      opMode: textOf(read, OP_MODE),
      testName: read.has(CONTROL_WORD_2027) ? "Utility" : "Test",
      tunables: snapshotTunables(read),
      cameras: cameraKeys(read),
      modes: [0, 0, 0],
      // where it went
      posed: false, distance: 0, anchorX: 0, anchorY: 0, poseX: 0, poseY: 0, poseHeading: 0, poseT: 0, havePose: false,
      speed: NaN, topSpeed: null,
      // the battery
      voltsStart: null, voltsMin: null, volts: NaN,
      // the aim
      aimSeen: false, aimedS: 0, lockedS: 0, sotfS: 0,
      attempt: null, idleSince: null, attempts: 0, locks: 0, lockTimes: [],
      errorW: 0, errorSq: 0, steerDeg: 0, steerS: 0,
      // vision
      visionS: 0, seeingS: 0, tagsW: 0, tagsSum: 0,
      confW: 0, confSum: 0, confMin: null,
      accepted: null, acceptedLast: null, rejected: null, rejectedLast: null,
      // the samples
      rows: 0, interval: sampleS, due: t, sampleTravel: 0, sampleTravelS: 0,
      seen: { pose: false, volts: false, aim: false, error: false, steer: false, tags: false, confidence: false },
      shotsFirst: finite(shots) ? shots : null, shotsLast: finite(shots) ? shots : null,
    };
    bins.fill(0);
    ring.n = 0;
    observe(t, read, word, prev);
    sample(t);
  }

  /* Credit the time since the last frame to what that frame showed. */
  function credit(state, dt) {
    if (!(dt > 0)) return;
    const w = Math.min(dt, HOLD_CAP_S);
    run.modes[state.mode] += dt;
    if (state.aim >= 1) {
      run.aimedS += dt;
      if (state.aim >= 2) run.lockedS += dt;
      if (state.aim === 3) run.sotfS += dt;
    }
    if (state.holding && Number.isFinite(state.error)) {
      const e = Math.abs(state.error);
      run.errorW += w;
      run.errorSq += e * e * w;
      bins[Math.min(ERROR_BINS - 1, Math.floor(e / ERROR_BIN_DEG))] += w;
    }
    if (state.seeing >= 0) {
      run.visionS += dt;
      if (state.seeing === 1) {
        run.seeingS += dt;
        if (Number.isFinite(state.tags)) {
          run.tagsW += w;
          run.tagsSum += state.tags * w;
        }
      }
    }
    if (Number.isFinite(state.confidence)) {
      run.confW += w;
      run.confSum += state.confidence * w;
    }
  }

  function closeAttempt() {
    if (!run.attempt) return;
    run.attempts += 1;
    if (run.attempt.locked) run.locks += 1;
    run.attempt = null;
    run.idleSince = null;
  }

  /* Read this frame into `state`, and take in what happens at an instant rather than over time: the
     pose moving, the battery's lowest, an aim starting or locking, the vision counters. */
  function observe(t, read, word, state) {
    state.mode = word & AUTONOMOUS ? 0 : word & TEST ? 2 : 1;

    const pose = readPose(read);
    if (pose) {
      const [x, y] = pose;
      run.posed = true;
      if (!run.havePose) {
        run.anchorX = x;
        run.anchorY = y;
      } else {
        const step = Math.hypot(x - run.poseX, y - run.poseY);
        if (step / Math.max(t - run.poseT, MIN_STEP_S) > RESET_MPS) {
          /* A reset: the robot was put somewhere else, it did not drive there. */
          run.anchorX = x;
          run.anchorY = y;
          ring.n = 0;
        } else {
          const moved = Math.hypot(x - run.anchorX, y - run.anchorY);
          if (moved >= DISTANCE_STEP_M) {
            run.distance += moved;
            run.anchorX = x;
            run.anchorY = y;
          }
        }
      }
      run.havePose = true;
      run.poseX = x;
      run.poseY = y;
      run.poseHeading = pose[2];
      run.poseT = t;
      ringPush(t, x, y);
      run.speed = ringSpeed(t, x, y);
      if (Number.isFinite(run.speed)) run.topSpeed = Math.max(run.topSpeed ?? 0, run.speed);
    } else {
      run.speed = NaN;
    }

    const volts = readBattery(read);
    run.volts = volts ?? NaN;
    if (volts !== null) {
      if (run.voltsStart === null) run.voltsStart = volts;
      run.voltsMin = run.voltsMin === null ? volts : Math.min(run.voltsMin, volts);
    }

    const stateText = read.str(AIM_STATE, null);
    if (typeof stateText === "string") {
      run.aimSeen = true;
      state.aim = AIM_CODE[stateText.trim().toUpperCase()] ?? 0;
    } else {
      state.aim = -1;
    }
    const error = numOf(read, AIM_ERROR);
    state.error = state.aim >= 1 && error !== null ? error : NaN;
    trackAttempt(t, read, state);

    const modules = read.arr(MODULE_STATES);
    if (Array.isArray(modules) && modules.length >= 2 && modules.length % 2 === 0 && modules.length <= MAX_MODULES * 2
      && modules.every(finite)) {
      state.moduleCount = modules.length / 2;
      for (let i = 0; i < state.moduleCount; i++) state.modules[i] = modules[i * 2 + 1];
    } else {
      state.moduleCount = 0;
    }

    let seeing = -1;
    let tags = NaN;
    for (const camera of run.cameras) {
      const health = read.str(camera.state, null);
      if (typeof health !== "string") continue;
      if (seeing < 0) seeing = 0;
      /* A camera's tag count is written only when it has an estimate, so it holds its last value while
         the camera sees nothing: X1's capture shows one tag on a camera that had seen none for four
         minutes. Health says OK only while estimates are arriving and being accepted, so that is what
         decides whether the count is current. */
      if (health.trim().toUpperCase() !== "OK") continue;
      seeing = 1;
      const n = numOf(read, camera.tags);
      if (n !== null && n >= 0) tags = Number.isFinite(tags) ? Math.max(tags, n) : n;
    }
    state.seeing = seeing;
    state.tags = seeing === 1 ? tags : seeing === 0 ? 0 : NaN;

    const confidence = numOf(read, POSE_CONFIDENCE);
    state.confidence = confidence ?? NaN;
    if (confidence !== null) run.confMin = run.confMin === null ? confidence : Math.min(run.confMin, confidence);

    /* The vision counters only ever count up; a robot program restarted mid-run starts them again from
       nothing, and that drop is not negative fixes. */
    const accepted = numOf(read, VISION_ACCEPTED);
    if (accepted !== null) {
      if (run.accepted === null) run.accepted = 0;
      else if (run.acceptedLast !== null && accepted > run.acceptedLast) run.accepted += accepted - run.acceptedLast;
      run.acceptedLast = accepted;
    }
    const rejected = numOf(read, VISION_REJECTED);
    if (rejected !== null) {
      if (run.rejected === null) run.rejected = 0;
      else if (run.rejectedLast !== null && rejected > run.rejectedLast) run.rejected += rejected - run.rejectedLast;
      run.rejectedLast = rejected;
    }
  }

  /* An attempt is one go at a target: it begins when the robot starts aiming, locks the first time it
     says ALIGNED or SOTF, and ends when it has stopped aiming for AIM_GAP_S or the target jumps. The
     heading error counts from the first lock to the end of the attempt, dropouts included: the swing
     onto a target depends on where the driver started it, and is measured by the time to lock instead;
     losing the target once it is held is exactly the unsteadiness a tuning change is trying to cure. */
  function trackAttempt(t, read, state) {
    const aiming = state.aim >= 1;
    if (aiming) {
      run.idleSince = null;
      const target = read.arr(AIM_TARGET);
      const at = Array.isArray(target) && finite(target[0]) && finite(target[1]) ? target : null;
      const jumped = run.attempt && at && run.attempt.target
        && Math.hypot(at[0] - run.attempt.target[0], at[1] - run.attempt.target[1]) > NEW_TARGET_M;
      if (!run.attempt || jumped) {
        closeAttempt();
        run.attempt = { start: t, locked: false, target: null };
      }
      if (at) run.attempt.target = [at[0], at[1]];
      if (state.aim >= 2 && !run.attempt.locked) {
        run.attempt.locked = true;
        if (run.lockTimes.length < MAX_LOCKS) run.lockTimes.push(t - run.attempt.start);
      }
    } else if (run.attempt) {
      run.idleSince ??= t;
      if (t - run.idleSince >= AIM_GAP_S) closeAttempt();
    }
    state.holding = aiming && Boolean(run.attempt?.locked);
  }

  /* The wheels' steering between two frames: how far each module turned, averaged over the modules, in
     degrees. A module that flips its drive direction instead of turning past a quarter turn reports the
     angle it actually points at, so the shortest turn between two readings is what it travelled. */
  function steering(from, to) {
    if (!from.moduleCount || from.moduleCount !== to.moduleCount) return NaN;
    let sum = 0;
    for (let i = 0; i < to.moduleCount; i++) sum += Math.abs(turn(from.modules[i], to.modules[i]));
    return ((sum / to.moduleCount) * 180) / Math.PI;
  }

  function thin() {
    /* Full: keep every other row and sample half as often from here on. */
    const half = run.rows >> 1;
    for (const name of COLUMNS) {
      const col = columns[name];
      for (let i = 0; i < half; i++) col[i] = col[i * 2];
    }
    run.rows = half;
    run.interval *= 2;
  }

  function sample(t) {
    if (t < run.due) return;
    if (run.rows >= rowsCap) thin();
    const i = run.rows;
    const s = prev;
    /* The pose as of this row's frame; a frame that carried none leaves the row's pose empty. */
    const posed = run.havePose && run.poseT === t;
    columns.t[i] = t - run.t0;
    columns.x[i] = posed ? run.poseX : NaN;
    columns.y[i] = posed ? run.poseY : NaN;
    columns.heading[i] = posed ? (run.poseHeading * 180) / Math.PI : NaN;
    columns.speed[i] = run.speed;
    columns.volts[i] = run.volts;
    columns.aim[i] = s.aim >= 0 ? s.aim : NaN;
    columns.error[i] = s.error;
    columns.steer[i] = run.sampleTravelS > 0 ? run.sampleTravel / run.sampleTravelS : NaN;
    columns.tags[i] = s.tags;
    columns.confidence[i] = s.confidence;
    columns.mode[i] = s.mode;
    run.sampleTravel = 0;
    run.sampleTravelS = 0;
    if (Number.isFinite(columns.x[i])) run.seen.pose = true;
    if (Number.isFinite(run.volts)) run.seen.volts = true;
    if (s.aim >= 0) run.seen.aim = true;
    if (Number.isFinite(s.error)) run.seen.error = true;
    if (Number.isFinite(columns.steer[i])) run.seen.steer = true;
    if (Number.isFinite(s.tags)) run.seen.tags = true;
    if (Number.isFinite(s.confidence)) run.seen.confidence = true;
    run.rows += 1;
    run.due += run.interval;
    /* After a stall the schedule starts again from now rather than writing a burst of rows to catch up. */
    if (run.due <= t) run.due = t + run.interval;
  }

  function step(t, read, word, shots) {
    const dt = t - run.last;
    credit(prev, dt);
    observe(t, read, word, next);
    const travel = steering(prev, next);
    if (Number.isFinite(travel) && dt > 0 && dt <= HOLD_CAP_S) {
      run.sampleTravel += travel;
      run.sampleTravelS += dt;
      if (prev.holding) {
        run.steerDeg += travel;
        run.steerS += dt;
      }
    }
    if (finite(shots)) {
      run.shotsFirst ??= shots;
      run.shotsLast = shots;
    }
    [prev, next] = [next, prev];
    run.last = t;
    sample(t);
  }

  function finish(t, ended, shots) {
    credit(prev, t - run.last);
    closeAttempt();
    /* The estimate stops counting when the robot is disabled, so the frame that says so has the whole run's. */
    if (finite(shots)) {
      run.shotsFirst ??= shots;
      run.shotsLast = shots;
    }
    const r = run;
    run = null;
    const seconds = t - r.t0;
    if (seconds < MIN_RUN_S) return null;

    const aim = r.aimSeen ? {
      aimedS: r.aimedS,
      lockedS: r.lockedS,
      sotfS: r.sotfS,
      holdS: r.errorW,
      onTarget: r.aimedS > 0 ? r.lockedS / r.aimedS : null,
      rmsDeg: r.errorW > 0 ? Math.sqrt(r.errorSq / r.errorW) : null,
      p95Deg: r.errorW > 0 ? histogramPercentile(bins, ERROR_BIN_DEG, r.errorW, 0.95) : null,
      attempts: r.attempts,
      locks: r.locks,
      toLockS: median(r.lockTimes),
      steerDegS: r.steerS > 0 ? r.steerDeg / r.steerS : null,
    } : null;

    const vision = {
      cameras: r.cameras.length || null,
      seeing: r.visionS > 0 ? r.seeingS / r.visionS : null,
      meanTags: r.tagsW > 0 ? r.tagsSum / r.tagsW : null,
      accepted: r.accepted,
      rejected: r.rejected,
      confidenceMean: r.confW > 0 ? r.confSum / r.confW : null,
      confidenceMin: r.confMin,
    };
    const anyVision = ["seeing", "meanTags", "accepted", "rejected", "confidenceMean"].some((k) => vision[k] !== null);

    /* Only the columns something was published for: a CSV of empty columns says nothing, and a column
       of zeros would say something false. */
    const present = COLUMNS.filter((name) => {
      if (name === "t" || name === "mode") return true;
      if (name === "x" || name === "y" || name === "heading" || name === "speed") return r.seen.pose;
      return r.seen[name];
    });
    const kept = {};
    for (const name of present) kept[name] = columns[name].slice(0, r.rows);

    return {
      id: r.wall !== null ? `run-${r.wall}` : `run-${r.serial}`,
      started: r.wall,
      seconds,
      ended,
      partial: r.partial,
      modes: { auto: r.modes[0], teleop: r.modes[1], test: r.modes[2] },
      testName: r.testName,
      opMode: r.opMode,
      robot: r.robot,
      distance: r.posed ? r.distance : null,
      topSpeed: r.topSpeed,
      voltsStart: r.voltsStart,
      voltsMin: r.voltsMin,
      shots: r.shotsFirst !== null && r.shotsLast !== null ? Math.max(0, r.shotsLast - r.shotsFirst) : null,
      aim,
      vision: anyVision ? vision : null,
      tunables: r.tunables,
      samples: { rows: r.rows, interval: r.interval, columns: kept },
    };
  }

  return {
    /** True while a run is being recorded. */
    get recording() {
      return run !== null;
    },
    frame(timeMs, read, { word = null, linked = true, wall = null, shots = null } = {}) {
      const t = timeMs / 1000;
      const known = linked && finite(word);
      const enabled = known && (word & ENABLED) !== 0;
      if (!run) {
        if (!linked) armed = false;
        else if (known && !enabled) armed = true;
        if (enabled) start(t, read, word, wall, shots);
        return null;
      }
      if (!enabled) {
        const ended = !linked ? "link" : known && (word & ESTOP) !== 0 ? "estop" : "disabled";
        armed = known;
        return finish(t, ended, shots);
      }
      step(t, read, word, shots);
      return null;
    },
  };
}

/* ---------------------------------------------------------------- keeping them */

/** A run without its samples: what is stored, and all a run read back from storage has. */
export function runSummary(run) {
  const { samples, ...summary } = run;
  return summary;
}

/** The list with `run` at its newest end, at most `keep` long. */
export function addRun(runs, run, keep = RUNS_KEPT) {
  return [run, ...runs.filter((r) => r.id !== run.id)].slice(0, keep);
}

/** The runs as text for storage: the real ones only - a demo run is nobody's robot - newest first,
 *  without their samples, every fraction to four places. */
export function storeRuns(runs) {
  const kept = runs.filter((r) => r && !r.demo).slice(0, RUNS_KEPT).map(runSummary);
  return JSON.stringify(kept, (key, value) =>
    typeof value === "number" && !Number.isInteger(value) ? Math.round(value * 1e4) / 1e4 : value);
}

const AIM_FIELDS = ["aimedS", "lockedS", "sotfS", "holdS", "onTarget", "rmsDeg", "p95Deg", "attempts", "locks", "toLockS", "steerDegS"];
const VISION_FIELDS = ["cameras", "seeing", "meanTags", "accepted", "rejected", "confidenceMean", "confidenceMin"];
const ENDINGS = ["disabled", "estop", "link"];

const numberOrNull = (v) => (finite(v) ? v : null);
const textOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
const fields = (o, names) => (o && typeof o === "object" && !Array.isArray(o)
  ? Object.fromEntries(names.map((k) => [k, numberOrNull(o[k])]))
  : null);

/* One stored run, checked field by field. Storage can hold anything - an older build wrote it, a quota
   error cut it short, someone edited it - and a bad value out of here would be printed as a measurement. */
function reviveRun(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const seconds = numberOrNull(x.seconds);
  if (typeof x.id !== "string" || !x.id || seconds === null || seconds < 0) return null;
  const modes = x.modes && typeof x.modes === "object" ? x.modes : {};
  const tunables = Array.isArray(x.tunables)
    ? x.tunables
      .filter((e) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string"
        && (finite(e[2]) || typeof e[2] === "boolean"))
      .slice(0, TUNABLES_MAX)
      .map((e) => [e[0], e[1], e[2]])
    : null;
  return {
    id: x.id.slice(0, 64),
    started: numberOrNull(x.started),
    seconds,
    ended: ENDINGS.includes(x.ended) ? x.ended : null,
    partial: x.partial === true,
    modes: { auto: numberOrNull(modes.auto) ?? 0, teleop: numberOrNull(modes.teleop) ?? 0, test: numberOrNull(modes.test) ?? 0 },
    testName: x.testName === "Test" ? "Test" : "Utility",
    opMode: textOrNull(x.opMode),
    robot: textOrNull(x.robot),
    distance: numberOrNull(x.distance),
    topSpeed: numberOrNull(x.topSpeed),
    voltsStart: numberOrNull(x.voltsStart),
    voltsMin: numberOrNull(x.voltsMin),
    shots: numberOrNull(x.shots),
    aim: fields(x.aim, AIM_FIELDS),
    vision: fields(x.vision, VISION_FIELDS),
    tunables: tunables && tunables.length ? tunables : null,
    samples: null,
  };
}

/** The stored runs, newest first, from whatever storage held; an empty list for anything unreadable. */
export function loadRuns(text) {
  let parsed;
  try {
    parsed = JSON.parse(text || "null");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const ids = new Set();
  for (const item of parsed) {
    const run = reviveRun(item);
    if (!run || ids.has(run.id)) continue;
    ids.add(run.id);
    out.push(run);
    if (out.length >= RUNS_KEPT) break;
  }
  return out;
}

/* ---------------------------------------------------------------- the CSV */

const CSV = Object.freeze({
  t: ["t_s", 3],
  x: ["x_m", 3],
  y: ["y_m", 3],
  heading: ["heading_deg", 2],
  speed: ["speed_mps", 3],
  volts: ["battery_v", 3],
  aim: ["aim_state", null],
  error: ["heading_error_deg", 2],
  steer: ["steer_deg_per_s", 1],
  tags: ["tags_in_view", 0],
  confidence: ["pose_confidence", 3],
  mode: ["mode", null],
});

/**
 * A run's samples as CSV, one row per sample, with a column only for what the robot published. An empty
 * cell is a value the robot did not have at that moment - a heading error while it was not aiming - never
 * a zero. Null for a run without samples: one read back from storage keeps only its summary.
 */
export function runCsv(run) {
  const cols = run?.samples?.columns;
  if (!cols || !cols.t) return null;
  const names = COLUMNS.filter((name) => cols[name]);
  const modeName = ["auto", "teleop", run.testName === "Test" ? "test" : "utility"];
  const cell = (name, v) => {
    if (!Number.isFinite(v)) return "";
    if (name === "aim") return AIM_NAMES[v] ?? "";
    if (name === "mode") return modeName[v] ?? "";
    return v.toFixed(CSV[name][1]);
  };
  const lines = [names.map((name) => CSV[name][0]).join(",")];
  for (let i = 0; i < cols.t.length; i++) lines.push(names.map((name) => cell(name, cols[name][i])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** A file name for a run's CSV: the robot, and when the run began, in local time. */
export function runFileName(run) {
  const robot = String(run?.robot || "robot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "robot";
  if (!finite(run?.started)) return `${robot}-${String(run?.id || "run").replace(/[^a-z0-9-]+/gi, "")}.csv`;
  const d = new Date(run.started);
  const p = (n) => String(n).padStart(2, "0");
  return `${robot}-run-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.csv`;
}

/* ---------------------------------------------------------------- drawing a trace */

/** The smallest and largest finite value in `values` - their sizes, with `magnitude` - or null. */
export function valueRange(values, { magnitude = false } = {}) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < (values?.length ?? 0); i++) {
    let v = values[i];
    if (!Number.isFinite(v)) continue;
    if (magnitude) v = Math.abs(v);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? { lo, hi } : null;
}

/**
 * A trace's line in a `w` × `h` box, as runs of [x, y] points. Time runs from 0 to `span` seconds across
 * the box and values from `lo` at the bottom to `hi` at the top; anything past `hi` is drawn at the top
 * edge rather than off it.
 *
 * Samples are pooled `step` pixels at a time, a match's three thousand rows into a few hundred points: by
 * `pool`, the mean of each, or the largest or smallest, so a spike in the heading error or a dip in the
 * battery survives being drawn small. A pool whose samples were all absent breaks the line - a gap in what
 * the robot published is a gap in the trace, not a straight line across it - and a pool that simply holds
 * no samples, on a short run drawn wide, does not.
 */
export function traceSegments(times, values, { w, h, span, lo, hi, step = 2, pool = "mean", magnitude = false, top = 4, bottom = 2 } = {}) {
  const n = Math.min(times?.length ?? 0, values?.length ?? 0);
  const segments = [];
  if (!n || !(w > 0) || !(h > 0) || !(hi > lo)) return segments;
  const total = span > 0 ? span : times[n - 1] || 1;
  const pools = Math.max(1, Math.floor(w / Math.max(0.5, step)));
  const room = Math.max(1, h - top - bottom);
  let line = null;
  let i = 0;
  for (let c = 0; c < pools; c++) {
    const end = c === pools - 1 ? Infinity : ((c + 1) / pools) * total;
    let count = 0;
    let absent = 0;
    let sum = 0;
    let most = -Infinity;
    let least = Infinity;
    let tSum = 0;
    for (; i < n && times[i] < end; i++) {
      let v = values[i];
      if (!Number.isFinite(v)) {
        absent += 1;
        continue;
      }
      if (magnitude) v = Math.abs(v);
      count += 1;
      sum += v;
      tSum += times[i];
      if (v > most) most = v;
      if (v < least) least = v;
    }
    if (!count) {
      if (absent) line = null;
      continue;
    }
    const v = pool === "max" ? most : pool === "min" ? least : sum / count;
    const x = Math.min(w, Math.max(0, (tSum / count / total) * w));
    const y = top + (1 - Math.min(1, Math.max(0, (v - lo) / (hi - lo)))) * room;
    if (!line) {
      line = [];
      segments.push(line);
    }
    line.push([x, y]);
  }
  return segments;
}

/* ---------------------------------------------------------------- the words */

const DASH = "—";

/** A run's length the way the match clock reads, m:ss. */
export function runClock(seconds) {
  if (!finite(seconds)) return DASH;
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What the robot was doing: the mode it spent the run in, or both when a run crossed from one to the
 *  other without a disable between them, as the demo's match does. `short` says Auto, for a list. */
export function modeLabel(run, { short = false } = {}) {
  const m = run?.modes;
  if (!m) return DASH;
  const names = { auto: short ? "Auto" : "Autonomous", teleop: "Teleop", test: run.testName === "Test" ? "Test" : "Utility" };
  const order = ["auto", "teleop", "test"];
  const used = order.filter((k) => m[k] >= 0.5);
  if (!used.length) {
    const most = order.reduce((a, b) => ((m[b] ?? 0) > (m[a] ?? 0) ? b : a));
    return names[most];
  }
  return used.map((k, i) => (i ? names[k].toLowerCase() : names[k])).join(" + ");
}

/** When a run began: the time today, "Yesterday", or the date, in local time. */
export function runWhen(started, now = Date.now()) {
  if (!finite(started)) return DASH;
  const d = new Date(started);
  const p = (n) => String(n).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86400000);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${month} ${d.getDate()} ${time}`;
}

/** A tunable's value as it would be typed: a switch on or off, a number without trailing zeros. */
const tunableText = (v) => (typeof v === "boolean" ? (v ? "on" : "off") : finite(v) ? String(Number(v.toFixed(4))) : DASH);

/** Tunable changes in a line: the first `max` named, then how many more. */
export function describeChanges(changes, max = 2) {
  if (!Array.isArray(changes) || !changes.length) return "";
  const named = changes.slice(0, max).map((c) => `${c.name} ${tunableText(c.from)} → ${tunableText(c.to)}`);
  return named.join(" · ") + (changes.length > max ? ` · ${changes.length - max} more` : "");
}

const fixed = (v, digits, unit = "") => (finite(v) ? `${v.toFixed(digits)}${unit}` : DASH);
const percent = (v) => (finite(v) ? `${Math.round(v * 100)}%` : DASH);
const metres = (v) => (finite(v) ? `${v < 100 ? v.toFixed(1) : v.toFixed(0)} m` : DASH);

/**
 * The figures the run review prints, in three groups: `drive`, always; `aim` and `vision`, or null for a
 * robot that published nothing of either. Each figure is `[label, value, sub, note]`: the number, a line
 * under it that puts it in context, and a note saying what the number is when its label cannot. An
 * unpublished number is a dash, and a sub with nothing to say is empty.
 */
export function runFigures(run) {
  const drive = [
    ["Time", runClock(run.seconds), run.partial ? "joined partway" : "",
      run.partial ? "The console started watching after this run had begun, so it ran longer than this."
        : "From the enable to the disable."],
    ["Distance", metres(run.distance), "", "From the robot's pose. Steps under 5 cm, and pose resets, are not counted."],
    ["Top speed", fixed(run.topSpeed, 1, " m/s"), "", "The pose's travel over a quarter of a second at a time."],
    ["Lowest battery", fixed(run.voltsMin, 1, " V"), finite(run.voltsStart) ? `from ${run.voltsStart.toFixed(2)} V` : "",
      "The lowest reading while it was enabled, and the reading it began at."],
  ];
  const a = run.aim;
  const aim = a ? [
    ["On target", percent(a.onTarget), finite(a.aimedS) && a.aimedS > 0 ? `of ${runClock(a.aimedS)} aimed` : "never aimed",
      "Of the time it was aiming - ALIGNING, ALIGNED or SOTF - the share it reported ALIGNED or SOTF."],
    ["Heading error", fixed(a.rmsDeg, 1, "° RMS"), "",
      "Root mean square, from each attempt's first lock until the aim ended, dropouts included."],
    ["95th percentile", fixed(a.p95Deg, 1, "°"), "", "The error was inside this 95% of the time, over the same stretch."],
    ["Time to lock", fixed(a.toLockS, 2, " s"), finite(a.attempts) && a.attempts > 0 ? `${a.locks ?? 0} of ${a.attempts} locked` : "",
      "From starting to aim to the first lock: the median over the run's attempts."],
    ["Wheel steering", fixed(a.steerDegS, 0, "°/s"), "",
      "How far the swerve modules turned each second while it held the target, averaged over the modules. "
        + "Dithering at the target shows here."],
  ] : null;
  const v = run.vision;
  const vision = v ? [
    ["Tags in view", percent(v.seeing), "", "The share of the run a camera was delivering estimates that were accepted."],
    ["Tags at once", fixed(v.meanTags, 1), "", "The most tags one camera saw, averaged over the time any did."],
    ["Fixes accepted", finite(v.accepted) ? String(Math.round(v.accepted)) : DASH,
      finite(v.rejected) ? `${Math.round(v.rejected)} rejected` : "", "Vision estimates the pose estimator took in during the run."],
    ["Pose confidence", percent(v.confidenceMean), finite(v.confidenceMin) ? `lowest ${Math.round(v.confidenceMin * 100)}%` : "",
      "Physics Core's confidence in the pose, averaged over the run."],
  ] : null;
  return { drive, aim, vision };
}

/** The two lines on Park's Last drive card: how far and how long, then what matters most about it - the
 *  aim when the robot aimed, otherwise the drive. */
export function runCard(run) {
  if (!run) return { title: DASH, sub: "No drive yet" };
  const time = runClock(run.seconds);
  const title = finite(run.distance) ? `${metres(run.distance)} · ${time}` : time;
  const a = run.aim;
  const parts = a && finite(a.onTarget)
    ? [`On target ${percent(a.onTarget)}`, finite(a.rmsDeg) && `${a.rmsDeg.toFixed(1)}° RMS`]
    : [run.shots >= 1 && `~${Math.round(run.shots)} FUEL shot`, finite(run.topSpeed) && `top ${run.topSpeed.toFixed(1)} m/s`,
      finite(run.voltsMin) && `lowest ${run.voltsMin.toFixed(1)} V`];
  const sub = parts.filter(Boolean).join(" · ");
  return { title, sub: sub ? sub.replace(/^./, (c) => c.toUpperCase()) : "Nothing published to measure" };
}
