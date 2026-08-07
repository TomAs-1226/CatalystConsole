/* Catalyst Console — frontend.
 *
 * Three rules run through everything in this file:
 *
 *  1. **Nothing here can impede driving.** No modal blocks the dashboard, no check gates anything, no
 *     "you must acknowledge this first". If the console breaks, the driver is still driving. Every
 *     failure path degrades to a dimmed number and a quiet chip, never to a dialog.
 *  2. **The console never writes robot control.** It reads. The only writes it makes are ordinary
 *     dashboard writes — a tunable, an auto chooser selection — the same ones Shuffleboard and Elastic
 *     make, and the Rust side refuses anything under the control namespaces regardless.
 *  3. **Never invent a number.** When the robot has not published a key, the tile shows a dash, not a
 *     plausible value. Demo data exists but has to be switched on deliberately and says so on screen.
 *
 * Components are data-driven: each declares a config schema, the user fills it in, and the layout is
 * persisted locally. Nothing is hard-coded to one robot or one season.
 */

const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ------------------------------------------------------------------ NT store */

const nt = {
  v: Object.create(null),
  status: { connected: false, address: "", rtt_ms: 0, topics: 0 },
  keys: [],
  keysDirty: true,
};

/** Values we keep a rolling history for. Components opt in; we do not buffer 500 topics nobody plots. */
const tracked = new Set();
const hist = new Map();
const HIST_LEN = 240;

function track(key) {
  if (key) tracked.add(key);
}

function history(key) {
  return hist.get(key) || [];
}

function raw(key) {
  return nt.v[key];
}
function num(key, fallback = null) {
  const x = nt.v[key];
  if (!x) return fallback;
  if (x.t === "num") return x.v;
  if (x.t === "bool") return x.v ? 1 : 0;
  return fallback;
}
function bool(key, fallback = null) {
  const x = nt.v[key];
  if (!x) return fallback;
  if (x.t === "bool") return x.v;
  if (x.t === "num") return x.v !== 0;
  return fallback;
}
function str(key, fallback = null) {
  const x = nt.v[key];
  if (!x) return fallback;
  if (x.t === "str") return x.v;
  if (x.t === "num") return String(x.v);
  return fallback;
}
function arr(key) {
  const x = nt.v[key];
  if (!x) return null;
  if (x.t === "nums" || x.t === "strs" || x.t === "bools") return x.v;
  return null;
}
function has(key) {
  return nt.v[key] !== undefined;
}

/* --------------------------------------------------------- driver station state */

/* WPILib packs the control word into /FMSInfo/FMSControlData. The bit layout is part of the DS
 * protocol and has been stable for years, but we only ever read it. */
const BIT = { enabled: 1, auto: 2, test: 4, estop: 8, fms: 16, ds: 32 };

const ds = {
  word: 0,
  get enabled() { return (this.word & BIT.enabled) !== 0; },
  get auto() { return (this.word & BIT.auto) !== 0; },
  get test() { return (this.word & BIT.test) !== 0; },
  get estop() { return (this.word & BIT.estop) !== 0; },
  get fms() { return (this.word & BIT.fms) !== 0; },
  get dsAttached() { return (this.word & BIT.ds) !== 0; },
  get mode() {
    if (this.estop) return "E-STOP";
    if (!this.enabled) return "Disabled";
    if (this.test) return "Test";
    if (this.auto) return "Autonomous";
    return "Teleop";
  },
};

function alliance() {
  const red = bool("/FMSInfo/IsRedAlliance", null);
  if (red === null) return null;
  return red ? "red" : "blue";
}

/**
 * Seconds left in the current period.
 *
 * The robot has to publish this. WPILib's `/FMSInfo` table carries the control word, the alliance, the
 * event and the game-specific message — but **not** the match clock, so there is nothing to read
 * unless robot code puts `DriverStation.getMatchTime()` somewhere. One line in `robotPeriodic`; see
 * README. Everything here degrades to a dash without it rather than inventing a countdown.
 */
function matchTime() {
  const candidates = ["/Catalyst/Match/TimeLeft", "/SmartDashboard/MatchTime", "/FMSInfo/MatchTime"];
  for (const k of candidates) {
    const v = num(k, null);
    if (v !== null) return v;
  }
  return null;
}

/* ------------------------------------------------------------------- demo data */

/* A synthetic robot, for looking at the dashboard without one. It is off by default and the dock
 * button stays lit while it runs, because a dashboard that quietly makes up telemetry is a hazard. */
const demo = { on: false, t0: performance.now(), timer: null };

function demoTick() {
  const t = (performance.now() - demo.t0) / 1000;
  /* A REBUILT match on repeat: 20 s auto, then teleop counting 140 down to 0. */
  const cycle = t % 175;
  const auto = cycle < 20;
  const matchT = auto ? 20 - cycle : Math.max(0, 160 - cycle);
  const set = (k, tag, v) => { nt.v[k] = { t: tag, v }; };

  set("/FMSInfo/FMSControlData", "num", BIT.enabled | BIT.ds | BIT.fms | (auto ? BIT.auto : 0));
  set("/FMSInfo/IsRedAlliance", "bool", true);
  set("/FMSInfo/EventName", "str", "Demo");
  set("/FMSInfo/MatchNumber", "num", 7);
  // The match clock is not in /FMSInfo on a real robot either — robot code publishes it. Demo does
  // the same thing so the tiles are exercised through the path they will really use.
  set("/Catalyst/Match/TimeLeft", "num", matchT);
  // A single character naming the alliance whose hub goes inactive first, and empty until a few
  // seconds after auto — exactly as FMS sends it. Red here, so the red hub sits out shifts 1 and 3.
  set("/FMSInfo/GameSpecificMessage", "str", auto || cycle < 23 ? "" : "R");

  const drive = 2400 + 900 * Math.sin(t * 1.7) + 180 * Math.sin(t * 11);
  set("/Catalyst/Drive/FrontLeft/Velocity", "num", drive / 60);
  set("/Catalyst/Drive/FrontRight/Velocity", "num", (drive + 120) / 60);
  set("/Catalyst/Drive/BackLeft/Velocity", "num", (drive - 90) / 60);
  set("/Catalyst/Drive/BackRight/Velocity", "num", (drive + 40) / 60);
  set("/Catalyst/Shooter/Velocity", "num", (4900 + 700 * Math.sin(t * 0.6)) / 60);
  set("/Catalyst/Loop/Robot/AverageMs", "num", 6.4 + 1.6 * Math.abs(Math.sin(t * 3)));
  set("/Catalyst/Status/CanUtilization", "num", 0.42 + 0.09 * Math.sin(t * 0.9));
  set("/Catalyst/Brownout/MeasuredVoltage", "num", 12.7 - 0.85 * Math.abs(Math.sin(t * 1.3)) - t * 0.002);

  set("/Catalyst/Physics/Slip/Factor", "num", Math.max(0, 0.42 * Math.sin(t * 2.1)));
  set("/Catalyst/Physics/TippingUsage", "num", 0.29 + 0.16 * Math.sin(t * 0.8));
  set("/Catalyst/Physics/TractionUsage", "num", 0.5 + 0.35 * Math.abs(Math.sin(t * 1.9)));
  set("/Catalyst/Physics/Quality/Confidence", "num", 0.86 + 0.09 * Math.sin(t * 0.4));

  const radius = 2.4;
  set("/Catalyst/Physics/PoseArray", "nums", [
    8.2 + radius * Math.cos(t * 0.42),
    4.1 + radius * Math.sin(t * 0.42) * 0.7,
    (t * 0.42 + Math.PI / 2) % (Math.PI * 2),
  ]);

  /* Deliberately no /Catalyst/Game/Tower* here: the hub tile should be seen deriving the schedule
   * from the rules and the FMS game data, which is what it does on a real field. */

  /* The demo robot's spec sheet, in the shape FrcCatalyst 1.10 publishes. Named so nobody mistakes
   * it for their own: a team looking at the garage before they have adopted the library should be
   * able to see what it will show them, and should be in no doubt that this is not their robot.
   * Deliberately an incomplete sheet — no camera list, no drive ratio — because that is the ordinary
   * case, and the panel leaving those lines out is the behaviour worth demonstrating. */
  set("/Catalyst/Robot/Identity/Name", "str", "Demo robot");
  set("/Catalyst/Robot/Identity/TeamNumber", "num", 0);
  set("/Catalyst/Robot/Identity/Season", "num", 2026);
  set("/Catalyst/Robot/Software/CatalystVersion", "str", "1.10.0");
  set("/Catalyst/Robot/Software/WPILibVersion", "str", "2026.1.1");
  set("/Catalyst/Robot/Drivetrain/Type", "str", "Swerve");
  set("/Catalyst/Robot/Drivetrain/Modules", "num", 4);
  set("/Catalyst/Robot/Drivetrain/MaxSpeedMps", "num", 4.73);
  set("/Catalyst/Robot/Drivetrain/TrackWidthMeters", "num", 0.591);
  set("/Catalyst/Robot/Drivetrain/WheelBaseMeters", "num", 0.591);
  set("/Catalyst/Robot/Drivetrain/WheelRadiusMeters", "num", 0.0508);
  set("/Catalyst/Robot/Drivetrain/OdometryHz", "num", 250);
  set("/Catalyst/Robot/Drivetrain/ModuleLocations", "nums",
    [0.2955, 0.2955, 0.2955, -0.2955, -0.2955, 0.2955, -0.2955, -0.2955]);
  set("/Catalyst/Robot/Chassis/MassKg", "num", 54.4);
  set("/Catalyst/Robot/Chassis/MoiKgM2", "num", 6.88);
  set("/Catalyst/Robot/Chassis/FrameLengthMeters", "num", 0.74);
  set("/Catalyst/Robot/Chassis/FrameWidthMeters", "num", 0.74);
  set("/Catalyst/Robot/Chassis/BumperThicknessMeters", "num", 0.0762);
  set("/Catalyst/Robot/Chassis/BumperLengthMeters", "num", 0.8924);
  set("/Catalyst/Robot/Chassis/BumperWidthMeters", "num", 0.8924);
  set("/Catalyst/Robot/Chassis/HeightMeters", "num", 0.52);
  set("/Catalyst/Robot/Power/Battery", "str", "MK ES17-12");
  set("/Catalyst/Robot/Power/Module", "str", "PDH");
  set("/Catalyst/Robot/Power/Channels", "num", 24);
  set("/Catalyst/Robot/Power/ChannelsInUse", "strs",
    ["0|Front left drive", "1|Front left steer", "2|Front right drive", "3|Front right steer", "8|Shooter"]);
  set("/Catalyst/Robot/Power/BrownoutVolts", "num", 6.8);
  set("/Catalyst/Robot/Hardware/CanDevices", "num", 11);
  set("/Catalyst/Robot/Hardware/Inventory", "strs", ["Kraken X60|8", "CANcoder|4", "Pigeon 2|1"]);
  set("/Catalyst/Robot/Hardware/Gyro", "str", "Pigeon 2");

  set("/Catalyst/Alerts/Errors", "strs", []);
  set("/Catalyst/Alerts/Warnings", "strs",
    num("/Catalyst/Brownout/MeasuredVoltage") < 11.8 ? ["[Power] Battery sagging under load"] : []);
  set("/Catalyst/Alerts/Info", "strs", ["Demo data — not a real robot"]);

  if (!has(TUNABLE_MANIFEST)) {
    set(TUNABLE_MANIFEST, "str", JSON.stringify([
      { key: "/Catalyst/Tunables/shooter.kP", name: "Shooter kP", group: "Shooter", min: 0, max: 2, step: 0.001 },
      { key: "/Catalyst/Tunables/shooter.target", name: "Target speed", group: "Shooter", min: 0, max: 6000, step: 25, unit: "RPM" },
      { key: "/Catalyst/Tunables/drive.slew", name: "Slew limit", group: "Drivetrain", min: 0.5, max: 12, step: 0.1, unit: "m/s²" },
      { key: "/Catalyst/Tunables/physics.enabled", name: "Physics advisories", group: "Physics Core" },
    ]));
    set("/Catalyst/Tunables/shooter.kP", "num", 0.34);
    set("/Catalyst/Tunables/shooter.target", "num", 4900);
    set("/Catalyst/Tunables/drive.slew", "num", 6.5);
    set("/Catalyst/Tunables/physics.enabled", "bool", true);
  }

  set("/SmartDashboard/Auto Chooser/options", "strs",
    ["Do nothing", "Leave line", "Two piece centre", "Three piece amp side"]);
  if (!has("/SmartDashboard/Auto Chooser/selected")) {
    set("/SmartDashboard/Auto Chooser/selected", "str", "Two piece centre");
    set("/SmartDashboard/Auto Chooser/active", "str", "Two piece centre");
  }

  /* The address and the topic count are true of the demo — that is where these values came from and
   * that is how many of them there are. A round trip is not: there is no link to time, and the figure
   * would be printed on the dock chip and under About's "Round trip" as a fact about the console's own
   * connection. Same line the NT-frames cell draws (see `paintSettings`) — demo telemetry may fabricate
   * robot state, because that is what it is for, and may never fabricate the state of the link. Zero is
   * what every reader here dashes on. */
  nt.status = { connected: false, address: "demo", rtt_ms: 0, topics: Object.keys(nt.v).length };
  nt.keysDirty = true;
  onFrame();
}

function setDemo(on) {
  demo.on = on;
  $("#demoBtn").setAttribute("aria-pressed", String(on));
  /* Two controls, one state. The dock button is the one that has to be visible while it runs; the
   * Settings row is where the explanation lives. Neither may ever disagree with the other. */
  $("#setDemoTog").setAttribute("aria-checked", String(on));
  if (on) {
    demo.t0 = performance.now();
    /* The mirror of the branch below, and it was missing. Everything in the store belonged to the link
     * that was there a moment ago, status included, and switching to demo did not disown any of it —
     * so the first paint could print the real robot's round trip beside "demo data — not a robot", and
     * `demoTick` counted the dead robot's leftover keys into the topic figure it publishes about
     * itself. Weaker than the breach the branch below fixes, because the number was stale rather than
     * invented, but it is the same class and rule three does not grade on that.
     *
     * Seeded in the same turn rather than on the first interval tick, which is 50 ms and five paints
     * away. Clearing without seeding would only trade a stale number for a dash; `demoTick` ends by
     * writing the status the demo is entitled to claim, so after this line the store is the demo's and
     * nothing in it is left over. */
    nt.v = Object.create(null);
    demoTick();
    demo.timer = setInterval(demoTick, 50);
  } else {
    clearInterval(demo.timer);
    nt.v = Object.create(null);
    /* The status has to go back too, and forgetting it was a straight breach of rule three. Demo mode
     * writes a plausible-looking status — 3.1 ms round trip, an address of "demo", a topic count —
     * and clearing only the values left all of that on screen afterwards. The dock then reported a
     * round trip to a robot that does not exist and said it was "looking for demo", and the About
     * page printed those numbers directly beneath the rule promising it never invents one. */
    nt.status = { connected: false, address: "", rtt_ms: 0, topics: 0 };
    nt.keysDirty = true;
    onFrame();
  }
}

/* --------------------------------------------------------------- tunable writes */

/* The robot declares what it will let a dashboard change, in a JSON manifest on one topic. The console
 * shows exactly that and nothing more — it never guesses that a topic looks tunable. The schema is in
 * README.md under "The contract with the robot". */
const TUNABLE_MANIFEST = "/Catalyst/Tunables/.manifest";

function tunables() {
  const src = str(TUNABLE_MANIFEST, null);
  if (!src) return [];
  try {
    const parsed = JSON.parse(src);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function ntSet(key, value) {
  /* Demo mode has no robot to write to, so the write lands in the local store instead. Otherwise a
   * slider would snap back and the demo would look broken rather than convincing. */
  if (demo.on) {
    nt.v[key] = typeof value === "boolean" ? { t: "bool", v: value }
      : typeof value === "number" ? { t: "num", v: value }
      : { t: "str", v: String(value) };
    if (key.endsWith("/selected")) nt.v[key.replace(/\/selected$/, "/active")] = nt.v[key];
    schedulePaint();
    return;
  }
  if (!invoke) return;
  try {
    await invoke("nt_set", { key, value });
  } catch (e) {
    console.warn("nt_set failed", key, e);
  }
}

/* ------------------------------------------------------------------- utilities */

function fmt(v, decimals = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(decimals);
}

function clock(seconds) {
  if (seconds === null || seconds === undefined) return "—:—";
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Wall clock, because link history is compared against what someone remembers happening. */
function clockOfDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** An elapsed span, in the largest unit that still reads at a glance. */
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function leaf(key) {
  const parts = String(key).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : key;
}

/* Label a set of topics with the shortest thing that actually tells them apart. Four swerve modules
 * all end in `/Velocity`, so the leaf alone would print "Velocity" four times; walking one segment
 * further left gives FrontLeft / FrontRight / BackLeft / BackRight, which is what you wanted to read. */
function distinctLabels(keys) {
  const parts = keys.map((k) => String(k).split("/").filter(Boolean));
  const deepest = Math.max(1, ...parts.map((p) => p.length));
  for (let depth = 1; depth <= deepest; depth++) {
    const probe = parts.map((p) => p.slice(-depth).join("/"));
    if (new Set(probe).size === probe.length) {
      return parts.map((p) => p[Math.max(0, p.length - depth)] ?? p[0] ?? "");
    }
  }
  return keys.map((k) => leaf(k));
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Fill a slider's track up to its thumb.
 *
 * A range input's value is invisible to CSS, so the filled portion is a gradient stop driven by a
 * custom property and this is the only thing that keeps it true. Call it wherever the value is set or
 * changed — an unpainted slider reads as empty, which is a lie about the number beside it.
 */
function paintRange(input) {
  const lo = Number(input.min || 0);
  const hi = Number(input.max || 100);
  const at = hi > lo ? clamp((Number(input.value) - lo) / (hi - lo), 0, 1) : 0;
  input.style.setProperty("--fill", `${(at * 100).toFixed(2)}%`);
}

/**
 * Arrow-key movement inside a tablist, with the roving tabindex the pattern requires.
 *
 * A tablist is one stop in the tab order with arrows moving inside it, not six stops in a row that
 * a keyboard user has to walk past to reach the panel. Both the view tabs and the settings rail are
 * tablists, so this is written once and handed the function that actually changes the selection —
 * `aria-selected` and `tabIndex` are set there, by the code that knows which one won.
 *
 * Selection follows focus: every panel on both lists is already built and switching costs nothing, so
 * asking for a second key to confirm what you arrowed to would be ceremony.
 */
function wireTablist(list) {
  list.addEventListener("keydown", (e) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const from = tabs.indexOf(document.activeElement);
    if (from < 0) return;
    const vertical = list.getAttribute("aria-orientation") === "vertical";
    let to = -1;
    if (e.key === (vertical ? "ArrowUp" : "ArrowLeft")) to = (from - 1 + tabs.length) % tabs.length;
    else if (e.key === (vertical ? "ArrowDown" : "ArrowRight")) to = (from + 1) % tabs.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = tabs.length - 1;
    if (to < 0) return;
    e.preventDefault();
    tabs[to].click();
    tabs[to].focus();
  });
}

function sparkline(values, w, h, color) {
  if (values.length < 2) return "";
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 1e-9) { hi = lo + 1; }
  const step = w / (values.length - 1);
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;
  let d = `M0 ${y(values[0]).toFixed(1)}`;
  for (let i = 1; i < values.length; i++) d += `L${(i * step).toFixed(1)} ${y(values[i]).toFixed(1)}`;
  const fill = `${d}L${w} ${h}L0 ${h}Z`;
  return `<path d="${fill}" fill="${color}" opacity="0.13"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`;
}

function arcPath(cx, cy, r, a0, a1) {
  const pt = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = pt(a0);
  const [x1, y1] = pt(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/* =================================================================== settings */

/* What the console lets you change about itself, kept in one object and persisted alongside the
 * layout. Nothing in here needs applying: the value is the truth the moment it changes, and the
 * surface that changed it is responsible for making the board agree.
 *
 * Per-tile configuration stays on the tile. These are the settings that belong to the machine rather
 * than to a component — which camera this driver wants, how much this laptop's graphics can afford,
 * how long this team wants an alert held. */
const SETTINGS_KEY = "catalyst.console.settings.v1";

const CAMERAS = ["chase", "top", "free"];
const TRAIL_MAX = 400;
const ALERT_HOLD_MAX = 8000;

const SETTINGS_DEFAULTS = {
  fieldCamera: "chase",
  fieldTrail: 220,
  fieldModel: true,
  alertHoldMs: 2500,
};

/* Read one key at a time and check every one. Storage can hold anything — an older build wrote it,
 * someone edited it by hand, a quota error truncated it — and a bad number out of here lands in a
 * component that has no business validating a setting. A number outside its range is pulled back into
 * it; anything else keeps the default. */
function loadSettings() {
  const s = { ...SETTINGS_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return s;
    if (CAMERAS.includes(saved.fieldCamera)) s.fieldCamera = saved.fieldCamera;
    if (typeof saved.fieldModel === "boolean") s.fieldModel = saved.fieldModel;
    if (Number.isFinite(saved.fieldTrail)) s.fieldTrail = Math.round(clamp(saved.fieldTrail, 0, TRAIL_MAX));
    if (Number.isFinite(saved.alertHoldMs)) s.alertHoldMs = Math.round(clamp(saved.alertHoldMs, 0, ALERT_HOLD_MAX));
  } catch { /* corrupt storage is not worth a dialog; the defaults are a working console */ }
  return s;
}

const settings = loadSettings();

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private mode or quota — the setting still applies, it just will not persist */ }
}

/* The baked field model is switched on and off from here, and the answer travels to field3d.js as an
 * argument to `createField` — see the `model` option there. It used to travel as a `window.fetch`
 * shim that answered 404 for vendor/field.glb, which worked and was a trap: code that lies to its own
 * module leaves the next reader debugging a missing file that is sitting on disk. A preference is an
 * argument. */

/* ================================================================== components */

/* Every component is: a config schema, a one-time `render` that builds DOM, and an `update` called on
 * each frame. `update` must be cheap and must never throw — one bad tile cannot take out the board. */

/* Null prototype, for the same reason the keyboard map has one: every lookup in here is keyed by a
 * string that came off a layout file or out of local storage, and on a plain object `REGISTRY["__proto__"]`
 * answers with Object.prototype. That is a truthy spec with no `config` and no `render`, so both the
 * storage check and the importer would have waved a tile through that then threw halfway into building
 * it. Nothing can reach past the components that were actually defined. */
const REGISTRY = Object.create(null);

function define(type, spec) {
  REGISTRY[type] = spec;
}

/* --- match timer ------------------------------------------------------------- */

define("match", {
  name: "Match timer",
  group: "Match",
  desc: "Phase, time remaining, and where you are in the match",
  w: 3, h: 2,
  config: [],
  render(body) {
    body.innerHTML = `
      <div class="fill">
        <div class="phase" data-x="phase">No match</div>
        <div><span class="n" data-x="time" style="font-size:52px">—:—</span></div>
        <div class="segs">
          <div class="seg auto"><i data-x="s0"></i></div>
          <div class="seg"><i data-x="s1"></i></div>
          <div class="seg end"><i data-x="s2"></i></div>
        </div>
        <div class="seglab"><span>Auto</span><span>Teleop</span><span>End</span></div>
      </div>`;
  },
  update(body, _cfg, x) {
    const t = matchTime();
    /* Name the shift rather than just the period — during teleop "Shift 3" is the thing a driver
     * actually needs, because it decides whether their hub is scoring. */
    const shift = t !== null && ds.enabled && !ds.auto
      ? (SHIFTS.find((s) => t > s.endsAt) || SHIFTS[SHIFTS.length - 1]).name
      : null;
    x.phase.textContent = shift ? `${ds.mode} · ${shift}` : ds.mode;
    x.time.textContent = clock(t);
    x.time.className = `n ${t !== null && t <= 30 && !ds.auto && ds.enabled ? "warn" : ""}`;

    /* Segment fill is derived from the period we are actually in — we never assume a match length the
     * FMS has not told us about. With no match time at all, the bars stay empty.
     *
     * The lengths match REBUILT as the Catalyst example models it: 20 s auto, 140 s teleop, with the
     * last 30 s of teleop called endgame. */
    const auto = ds.auto;
    const inMatch = t !== null;
    const autoLen = 20, teleLen = 110, endLen = 30;
    let a = 0, b = 0, c = 0;
    if (inMatch && auto) {
      a = clamp01(1 - t / autoLen);
    } else if (inMatch) {
      a = 1;
      const elapsed = teleLen + endLen - t;
      b = clamp01(elapsed / teleLen);
      c = clamp01((elapsed - teleLen) / endLen);
    }
    x.s0.style.width = `${a * 100}%`;
    x.s1.style.width = `${b * 100}%`;
    x.s2.style.width = `${c * 100}%`;
  },
});

/* --- fuel tower -------------------------------------------------------------- */

/* REBUILT teleop, from the 2026 game manual (Table 6-2). Teleop runs 140 s and the match clock counts
 * down, so each segment is expressed as the time remaining when it ends.
 *
 * Both HUBS are active during AUTO, the TRANSITION SHIFT and END GAME. Through shifts 1-4 they
 * alternate: the alliance that scored more FUEL in AUTO is inactive for shift 1, and FMS relays which
 * alliance that was in the game-specific message at the start of teleop. */
const SHIFTS = [
  { name: "Transition", endsAt: 130, always: true },
  { name: "Shift 1", endsAt: 105, index: 0 },
  { name: "Shift 2", endsAt: 80, index: 1 },
  { name: "Shift 3", endsAt: 55, index: 2 },
  { name: "Shift 4", endsAt: 30, index: 3 },
  { name: "End game", endsAt: 0, always: true },
];

/**
 * Which alliance's hub goes inactive first, from the FMS game-specific message.
 *
 * WPILib documents the 2026 message as a single character — `R` or `B` — naming the alliance whose
 * goal goes inactive first, which is the alliance that scored more FUEL in auto. It is an empty string
 * until roughly three seconds after auto ends, once scoring has been assessed, so null here is the
 * normal state for the first part of a match rather than a fault.
 */
function inactiveFirstAlliance() {
  const text = (str("/FMSInfo/GameSpecificMessage", "") || "").trim().toLowerCase();
  if (text.startsWith("r")) return "red";
  if (text.startsWith("b")) return "blue";
  return null;
}

define("tower", {
  name: "Hub activation",
  group: "Match",
  desc: "Whether your alliance HUB is scoring this shift, and how long until that changes",
  w: 3, h: 2,
  tileClass: "tower",
  config: [
    { key: "activeKey", label: "Active topic", type: "topic", def: "/Catalyst/Game/TowerActive",
      hint: "Optional override. A boolean the robot publishes: true while YOUR hub is active. Leave it and the console works the schedule out from FMS." },
    { key: "countdownKey", label: "Countdown topic", type: "topic", def: "/Catalyst/Game/TowerSeconds",
      hint: "Optional override: seconds until the state flips." },
    { key: "warn", label: "Warn at", type: "number", def: 5,
      hint: "Seconds before a change when the tile turns amber." },
  ],
  render(body) {
    body.innerHTML = `
      <div class="fill">
        <div>
          <div class="who" data-x="who">Alliance unknown</div>
          <div class="status" data-x="status">No data</div>
        </div>
        <div>
          <span class="n" data-x="count">—</span>
          <span class="u" data-x="unit">s</span>
        </div>
        <div>
          <div class="bars"><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <div class="cap" data-x="src" style="margin-top:6px">waiting for robot</div>
        </div>
      </div>`;
  },
  update(body, cfg, x, tile) {
    const side = alliance();
    x.who.textContent = side ? `${side === "red" ? "Red" : "Blue"} hub` : "Alliance unknown";
    x.who.className = `who ${side || ""}`;

    /* A robot that publishes its own answer wins — it may know something we do not. Otherwise the
     * schedule comes straight out of the rules plus the FMS game data, which is exact rather than
     * estimated. */
    let active = bool(cfg.activeKey, null);
    let left = cfg.countdownKey ? num(cfg.countdownKey, null) : null;
    let source = active !== null || left !== null ? "robot" : null;
    let segment = null;

    if (active === null || left === null) {
      const t = matchTime();
      if (t !== null && !ds.auto && ds.enabled) {
        segment = SHIFTS.find((s) => t > s.endsAt) || SHIFTS[SHIFTS.length - 1];
        if (left === null) left = Math.max(0, t - segment.endsAt);

        if (active === null) {
          if (segment.always) {
            active = true;                       // both hubs are active here, no game data needed
            source = "rule — both hubs active";
          } else {
            const inactiveFirst = inactiveFirstAlliance();
            if (inactiveFirst && side) {
              // Named alliance sits out shift 1, then the two alternate every shift.
              const weSitOutFirst = inactiveFirst === side;
              active = weSitOutFirst ? segment.index % 2 === 1 : segment.index % 2 === 0;
              source = `FMS · ${segment.name}`;
            } else {
              source = side ? "waiting for FMS game data" : "waiting for alliance";
            }
          }
        }
      } else if (t !== null && ds.auto) {
        active = true;
        left = null;
        source = "rule — both hubs active in auto";
      }
    }

    const soon = active !== null && left !== null && left <= cfg.warn;
    tile.dataset.active = active === true && !soon ? "true" : "false";
    tile.dataset.soon = soon ? "true" : "false";

    if (active === null) {
      x.status.textContent = segment ? segment.name : "No data";
      x.count.textContent = left === null ? "—" : left.toFixed(1);
      x.unit.textContent = left === null ? "" : "s";
      x.src.textContent = source || "no match in progress";
      return;
    }

    x.status.textContent = soon
      ? (active ? "CLOSING" : "OPENING")
      : (active ? "HUB ACTIVE" : "HUB INACTIVE");
    x.count.textContent = left === null ? "—" : left.toFixed(1);
    x.unit.textContent = left === null ? "" : "s";
    x.src.textContent = source || "robot";
  },
});

/* --- gauges ------------------------------------------------------------------ */

/* One tile, one or more numeric topics, four ways of drawing them. This is the component the driver
 * team actually customises: pick the device, pick the signal, pick the face. */
define("gauge", {
  name: "Gauge",
  group: "Telemetry",
  desc: "Any numeric topic as an arc, dial, bar, or plain number",
  w: 4, h: 2,
  config: [
    { key: "topic", label: "Topic(s)", type: "topic", def: "/Catalyst/Shooter/Velocity",
      hint: "One key, or several separated by commas to show them side by side." },
    { key: "title", label: "Title", type: "text", def: "Shooter" },
    { key: "style", label: "Face", type: "select", def: "arc",
      options: [["arc", "Arc"], ["dial", "Dial + needle"], ["bar", "Bar"], ["number", "Number only"]] },
    { key: "unit", label: "Unit", type: "text", def: "RPM" },
    { key: "scale", label: "Multiply by", type: "number", def: 60,
      hint: "Phoenix reports rotations per second; ×60 gives RPM. Use 1 to show the raw value." },
    { key: "min", label: "Minimum", type: "number", def: 0 },
    { key: "max", label: "Maximum", type: "number", def: 6000 },
    { key: "redline", label: "Redline", type: "number", def: 5500,
      hint: "Value at which the gauge turns red. Set above the maximum to disable." },
    { key: "decimals", label: "Decimals", type: "number", def: 0 },
  ],
  render(body, cfg) {
    body.innerHTML = `<div class="gaugewrap" data-x="wrap"></div>`;
    for (const key of String(cfg.topic).split(",").map((s) => s.trim()).filter(Boolean)) track(key);
  },
  update(body, cfg, x) {
    const keys = String(cfg.topic).split(",").map((s) => s.trim()).filter(Boolean);
    const wrap = x.wrap;

    if (wrap.childElementCount !== keys.length) {
      wrap.innerHTML = "";
      for (const k of keys) {
        const g = el("div", "gauge");
        g.dataset.key = k;
        wrap.appendChild(g);
      }
    }

    const span = Math.max(1e-6, cfg.max - cfg.min);
    const single = keys.length === 1;
    const labels = single ? [cfg.unit || ""] : distinctLabels(keys);

    keys.forEach((key, i) => {
      const g = wrap.children[i];
      const rawVal = num(key, null);
      const value = rawVal === null ? null : rawVal * (cfg.scale || 1);
      const frac = value === null ? 0 : clamp01((value - cfg.min) / span);
      const hot = value !== null && value >= cfg.redline;
      const color = hot ? "var(--crit)" : "var(--blue)";
      const label = labels[i];
      const text = value === null ? "—" : value.toFixed(Math.max(0, cfg.decimals | 0));

      if (cfg.style === "number") {
        g.innerHTML =
          `<div class="gv ${hot ? "crit" : ""}" style="font-size:${single ? 46 : 26}px">${text}</div>` +
          `<div class="gl">${label}</div>`;
        return;
      }

      if (cfg.style === "bar") {
        g.innerHTML =
          `<div class="gv ${hot ? "crit" : ""}" style="font-size:${single ? 32 : 20}px">${text}</div>` +
          `<div class="track" style="width:100%;margin:9px 0 4px"><i style="width:${frac * 100}%;background:${color}"></i></div>` +
          `<div class="gl">${label}</div>`;
        return;
      }

      const size = single ? 128 : 92;
      const r = size / 2 - 10;
      const a0 = 135, sweep = 270;
      const a1 = a0 + sweep * frac;
      const cx = size / 2, cy = size / 2;
      const needle = cfg.style === "dial"
        ? (() => {
            const a = ((a0 + sweep * frac) * Math.PI) / 180;
            return `<line x1="${cx}" y1="${cy}" x2="${(cx + (r - 6) * Math.cos(a)).toFixed(1)}" y2="${(cy + (r - 6) * Math.sin(a)).toFixed(1)}" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="3.5" fill="${color}"/>`;
          })()
        : "";

      g.innerHTML =
        `<svg width="${size}" height="${size * 0.82}" viewBox="0 0 ${size} ${size * 0.82}">` +
        `<path d="${arcPath(cx, cy, r, a0, a0 + sweep)}" fill="none" stroke="var(--tile-3)" stroke-width="8" stroke-linecap="round"/>` +
        (frac > 0.002 && cfg.style === "arc"
          ? `<path d="${arcPath(cx, cy, r, a0, a1)}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"/>`
          : "") +
        needle +
        `<text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="currentColor" font-family="var(--mono)" font-weight="700" font-size="${single ? 22 : 16}" ${hot ? 'class="crit"' : ""}>${text}</text>` +
        `</svg><div class="gl">${label}</div>`;
    });
  },
});

/* --- battery ----------------------------------------------------------------- */

define("battery", {
  name: "Battery",
  group: "Health",
  desc: "Bus voltage with its recent history and sag under load",
  w: 3, h: 2,
  config: [
    { key: "topic", label: "Topic", type: "topic", def: "/Catalyst/Status/BatteryVolts",
      hint: "Falls back to /Catalyst/Brownout/MeasuredVoltage when this key is absent, so a BrownoutMonitor works with no configuration. WPILib does not put battery voltage on NetworkTables by itself." },
    { key: "low", label: "Warn below", type: "number", def: 11.5 },
    { key: "crit", label: "Critical below", type: "number", def: 10.5 },
  ],
  render(body, cfg) {
    track(cfg.topic);
    track("/Catalyst/Brownout/MeasuredVoltage");
    body.innerHTML = `
      <div class="fill">
        <div><span class="n" data-x="v" style="font-size:40px">—</span><span class="u">V</span></div>
        <svg class="spark" data-x="spark" preserveAspectRatio="none"></svg>
        <div class="cap" data-x="cap">no history yet</div>
      </div>`;
  },
  update(body, cfg, x) {
    const key = has(cfg.topic) ? cfg.topic : "/Catalyst/Brownout/MeasuredVoltage";
    const v = num(key, null);
    x.v.textContent = fmt(v, 2);
    x.v.className = `n ${v === null ? "" : v < cfg.crit ? "crit" : v < cfg.low ? "warn" : "ok"}`;

    const h = history(key);
    const box = x.spark.getBoundingClientRect();
    const w = Math.max(40, box.width), ht = Math.max(20, box.height);
    x.spark.setAttribute("viewBox", `0 0 ${w} ${ht}`);
    const color = v !== null && v < cfg.low ? "#ff9f0a" : "#30d158";
    x.spark.innerHTML = sparkline(h.slice(-160), w, ht, color);

    if (h.length > 3) {
      const recent = h.slice(-160);
      const lo = Math.min(...recent), hi = Math.max(...recent);
      x.cap.innerHTML = `sag <b>${(hi - lo).toFixed(2)} V</b> · low <b>${lo.toFixed(2)} V</b>`;
    }
  },
});

/* --- power / loop ------------------------------------------------------------ */

define("health", {
  name: "Loop & bus",
  group: "Health",
  desc: "Loop time, CAN utilisation, and round-trip time in one tile",
  w: 3, h: 2,
  config: [
    { key: "loopKey", label: "Loop time topic", type: "topic", def: "/Catalyst/Loop/Robot/AverageMs",
      hint: "Catalyst's LoopMonitor publishes this once you construct one." },
    { key: "canKey", label: "CAN utilisation topic", type: "topic", def: "/Catalyst/Status/CanUtilization",
      hint: "Nothing publishes this by default. One line in robotPeriodic: CatalystLog.log(\"Status/CanUtilization\", RobotController.getCANStatus().percentBusUtilization)." },
    { key: "budget", label: "Loop budget (ms)", type: "number", def: 20 },
  ],
  render(body, cfg) {
    track(cfg.loopKey);
    body.innerHTML = `
      <div class="fill">
        <div class="m3">
          <div><div class="mv" data-x="loop">—</div><div class="ml">Loop ms</div></div>
          <div><div class="mv" data-x="can">—</div><div class="ml">CAN %</div></div>
          <div><div class="mv" data-x="rtt">—</div><div class="ml">RTT ms</div></div>
        </div>
        <div class="track"><i data-x="bar"></i></div>
        <div class="cap" data-x="cap">—</div>
      </div>`;
  },
  update(body, cfg, x) {
    const loop = num(cfg.loopKey, null);
    const can = num(cfg.canKey, null);
    x.loop.textContent = fmt(loop, 1);
    x.loop.className = `mv ${loop === null ? "" : loop > cfg.budget ? "crit" : loop > cfg.budget * 0.75 ? "warn" : "ok"}`;
    x.can.textContent = can === null ? "—" : (can * 100).toFixed(0);
    x.can.className = `mv ${can === null ? "" : can > 0.85 ? "crit" : can > 0.7 ? "warn" : ""}`;
    x.rtt.textContent = nt.status.rtt_ms ? nt.status.rtt_ms.toFixed(1) : "—";

    const frac = loop === null ? 0 : clamp01(loop / cfg.budget);
    x.bar.style.width = `${frac * 100}%`;
    x.bar.style.background = frac > 1 ? "var(--crit)" : frac > 0.75 ? "var(--warn)" : "var(--ok)";
    x.cap.innerHTML = loop === null
      ? "waiting for the robot to publish loop time"
      : `<b>${((1 - frac) * 100).toFixed(0)}%</b> of the ${cfg.budget} ms budget spare`;
  },
});

/* --- physics core ------------------------------------------------------------ */

define("physics", {
  name: "Physics Core",
  group: "Catalyst",
  desc: "Slip, tip margin, and traction headroom from the physics layer",
  w: 3, h: 2,
  config: [
    { key: "slipKey", label: "Slip topic", type: "topic", def: "/Catalyst/Physics/Slip/Factor" },
    { key: "tipKey", label: "Tipping usage topic", type: "topic", def: "/Catalyst/Physics/TippingUsage" },
    { key: "tracKey", label: "Traction usage topic", type: "topic", def: "/Catalyst/Physics/TractionUsage" },
    { key: "confKey", label: "Confidence topic", type: "topic", def: "/Catalyst/Physics/Quality/Confidence" },
  ],
  render(body) {
    body.innerHTML = `
      <div class="fill">
        <div class="m3">
          <div><div class="mv" data-x="slip">—</div><div class="ml">Slip</div></div>
          <div><div class="mv" data-x="tip">—</div><div class="ml">Tipping</div></div>
          <div><div class="mv" data-x="trac">—</div><div class="ml">Traction</div></div>
        </div>
        <div class="track"><i data-x="bar"></i></div>
        <div class="cap" data-x="cap">advisory only — never gates control</div>
      </div>`;
  },
  update(body, cfg, x) {
    const slip = num(cfg.slipKey, null);
    const tip = num(cfg.tipKey, null);
    const trac = num(cfg.tracKey, null);
    const conf = num(cfg.confKey, null);

    /* Slip, tipping and traction are all "fraction of the limit in use", so higher is worse for all
     * three. They read the same way round, which is the point. */
    x.slip.textContent = slip === null ? "—" : slip.toFixed(2);
    x.slip.className = `mv ${slip === null ? "" : slip > 0.4 ? "crit" : slip > 0.2 ? "warn" : "ok"}`;
    x.tip.textContent = tip === null ? "—" : `${(tip * 100).toFixed(0)}%`;
    x.tip.className = `mv ${tip === null ? "" : tip > 0.9 ? "crit" : tip > 0.75 ? "warn" : "ok"}`;
    x.trac.textContent = trac === null ? "—" : `${(trac * 100).toFixed(0)}%`;
    x.trac.className = `mv ${trac === null ? "" : trac > 0.95 ? "warn" : ""}`;

    const frac = trac === null ? 0 : clamp01(trac);
    x.bar.style.width = `${frac * 100}%`;
    x.bar.style.background = frac > 0.95 ? "var(--warn)" : "var(--brand)";
    x.cap.innerHTML = conf === null
      ? "advisory only — never gates control"
      : `estimator confidence <b>${(conf * 100).toFixed(0)}%</b> · advisory only`;
  },
});

/* --- impacts ----------------------------------------------------------------- */

/* Physics Core records collisions it could not explain any other way. Nothing surfaced them, which
 * made the most interesting thing the physics layer knows invisible during a match. */
define("impacts", {
  name: "Impacts",
  group: "Catalyst",
  desc: "Contacts Physics Core detected, with how hard and how long ago",
  w: 3, h: 2,
  config: [
    { key: "base", label: "Collision group", type: "topic", def: "/Catalyst/Physics/Collision" },
    { key: "hard", label: "Hard hit (m/s²)", type: "number", def: 25,
      hint: "Above this the tile goes red. A firm push is a few m/s²; a real collision is tens." },
  ],
  render(body, cfg, state) {
    state.log = [];
    state.lastStamp = null;
    body.innerHTML = `
      <div class="fill">
        <div><span class="n" data-x="mag" style="font-size:30px">—</span><span class="u">m/s²</span></div>
        <div class="cap" data-x="when">no contact recorded</div>
        <div class="cap" data-x="hist" style="margin-top:8px"></div>
      </div>`;
  },
  update(body, cfg, x, tile, state) {
    const stamp = num(`${cfg.base}/Timestamp`, null);
    const magnitude = num(`${cfg.base}/MpsSq`, null);
    const newtons = num(`${cfg.base}/Newtons`, null);

    if (stamp === null || magnitude === null) {
      x.mag.textContent = "—";
      x.when.textContent = has(`${cfg.base}/Timestamp`) ? "no contact recorded" : `nothing at ${cfg.base}`;
      return;
    }

    // A new timestamp means a new hit rather than the same one still being reported.
    if (stamp !== state.lastStamp) {
      state.lastStamp = stamp;
      state.log.unshift({ stamp, magnitude, newtons, at: performance.now() });
      state.log.length = Math.min(state.log.length, 4);
    }

    const age = (performance.now() - state.log[0].at) / 1000;
    x.mag.textContent = magnitude.toFixed(1);
    x.mag.className = `n ${magnitude >= cfg.hard ? "crit" : magnitude >= cfg.hard / 2 ? "warn" : ""}`;
    x.when.innerHTML = `<b>${age < 1 ? "just now" : `${age.toFixed(0)} s ago`}</b>`
      + (newtons ? ` · peak <b>${newtons.toFixed(0)} N</b>` : "");
    x.hist.innerHTML = state.log.length > 1
      ? `${state.log.length} contacts · worst ${Math.max(...state.log.map((h) => h.magnitude)).toFixed(1)} m/s²`
      : "";
  },
});

/* --- swerve ------------------------------------------------------------------ */

define("swerve", {
  name: "Swerve modules",
  group: "Telemetry",
  desc: "Four module angles and speeds, drawn as they are actually pointing",
  w: 3, h: 2,
  config: [
    { key: "topic", label: "Module states topic", type: "topic", def: "/Catalyst/Drive/ModuleStates",
      hint: "The WPILib convention: a number array of [angleRad, speedMps] per module, four modules." },
    { key: "max", label: "Max speed (m/s)", type: "number", def: 5.0 },
  ],
  render(body) {
    body.innerHTML = `<div class="fill"><svg data-x="svg" viewBox="0 0 120 120" style="width:100%;height:100%;max-height:none"></svg></div>`;
  },
  update(body, cfg, x) {
    const states = arr(cfg.topic);
    const spots = [[34, 34], [86, 34], [34, 86], [86, 86]];

    if (!Array.isArray(states) || states.length < 8) {
      x.svg.innerHTML = `<text x="60" y="62" text-anchor="middle" fill="#63656b" font-size="8" font-family="var(--sans)">no module states</text>`;
      return;
    }

    let out = "";
    for (let i = 0; i < 4; i++) {
      const angle = states[i * 2];
      const speed = states[i * 2 + 1];
      const [cx, cy] = spots[i];
      const frac = clamp01(Math.abs(speed) / Math.max(0.1, cfg.max));
      // Screen y grows downward and the field's +y is to the left, so the angle is negated.
      const dx = Math.cos(-angle) * 16 * (speed < 0 ? -1 : 1);
      const dy = Math.sin(-angle) * 16 * (speed < 0 ? -1 : 1);
      const colour = frac > 0.92 ? "#ff453a" : frac > 0.7 ? "#ff9f0a" : "#4d90fe";
      out +=
        `<circle cx="${cx}" cy="${cy}" r="18" fill="none" stroke="#2c2e34" stroke-width="3"/>` +
        `<line x1="${cx}" y1="${cy}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + dy).toFixed(1)}" stroke="${colour}" stroke-width="3.5" stroke-linecap="round"/>` +
        `<text x="${cx}" y="${cy + 30}" text-anchor="middle" fill="#9a9ba1" font-size="7.5" font-family="var(--mono)">${speed.toFixed(1)}</text>`;
    }
    x.svg.innerHTML = out;
  },
});

/* --- alerts ------------------------------------------------------------------ */

define("alerts", {
  name: "Alerts",
  group: "Catalyst",
  desc: "Everything the robot's alert manager is currently raising",
  w: 4, h: 2,
  config: [
    { key: "base", label: "Alert group", type: "topic", def: "/Catalyst/Alerts",
      hint: "Reads Errors / Warnings / Info under this path, in either capitalisation." },
  ],
  render(body, cfg, state) {
    state.seen = new Map();
    body.innerHTML = `<div class="fill" style="justify-content:flex-start;overflow:auto" data-x="list"></div>`;
  },
  update(body, cfg, x, tile, state) {
    /* Catalyst's AlertManager publishes Errors/Warnings/Info; WPILib's own Alerts widget uses
     * errors/warnings/infos. Read whichever is there rather than making teams pick. */
    const pick = (...names) => {
      for (const n of names) {
        const v = arr(`${cfg.base}/${n}`);
        if (v) return v;
      }
      return [];
    };
    const groups = [
      ["error", pick("Errors", "errors")],
      ["warn", pick("Warnings", "warnings")],
      ["info", pick("Info", "infos", "Infos")],
    ];
    /* Alerts are edge-triggered on the robot, and anything driven by a measurement that sits near its
     * threshold will raise and clear repeatedly. Rendering that verbatim gives a tile that strobes,
     * which is worse than useless next to a driver. So an alert that goes away is held on screen for a
     * moment, dimmed, and only removed once it has genuinely stayed gone. Nothing is hidden and nothing
     * is invented — a flapping alert reads as one steady, slightly faded line. */
    const now = performance.now();
    for (const [level, items] of groups) {
      for (const text of items) state.seen.set(`${level}\u0000${text}`, { level, text, at: now });
    }
    for (const [key, entry] of state.seen) {
      if (now - entry.at > settings.alertHoldMs) state.seen.delete(key);
    }

    const flat = [...state.seen.values()].map((e) => ({ ...e, stale: e.at !== now }));
    const signature = flat.map((a) => `${a.level}:${a.text}:${a.stale}`).join("|");
    if (x.list.dataset.sig === signature) return;
    x.list.dataset.sig = signature;

    if (!flat.length) {
      const present = has(`${cfg.base}/Errors`) || has(`${cfg.base}/errors`)
        || has(`${cfg.base}/Warnings`) || has(`${cfg.base}/warnings`);
      x.list.innerHTML = present
        ? `<div class="cap" style="padding-top:10px">Nothing raised.</div>`
        : `<div class="cap" style="padding-top:10px">No alert group at <b>${escapeHtml(cfg.base)}</b>.</div>`;
      return;
    }
    x.list.innerHTML = flat
      .map((a) => `<div class="al ${a.level}"${a.stale ? ' style="opacity:.45"' : ""}><i class="b"></i><div>${escapeHtml(a.text)}</div></div>`)
      .join("");
  },
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* --- auto chooser ------------------------------------------------------------ */

define("auto", {
  name: "Auto chooser",
  group: "Match",
  desc: "Pick the autonomous routine — writes the same key SendableChooser reads",
  w: 3, h: 1,
  config: [
    { key: "base", label: "Chooser path", type: "topic", def: "/SmartDashboard/Auto Chooser" },
    { key: "style", label: "Style", type: "select", def: "compact",
      options: [["compact", "Dropdown (1 row)"], ["list", "Full list"]],
      hint: "The dropdown fits in a single row, which is usually worth more board space than seeing every option at once." },
  ],
  render(body) {
    body.innerHTML = `<div class="fill" style="justify-content:center;gap:3px;overflow:auto" data-x="list"></div>`;
  },
  update(body, cfg, x) {
    const options = arr(`${cfg.base}/options`) || [];
    const selected = str(`${cfg.base}/selected`, null);
    const active = str(`${cfg.base}/active`, null);
    const chosen = selected ?? active;
    const signature = `${cfg.style}::${options.join("|")}::${chosen}`;
    if (x.list.dataset.sig === signature) return;
    x.list.dataset.sig = signature;

    if (!options.length) {
      x.list.innerHTML = `<div class="cap">No chooser published at <b>${escapeHtml(cfg.base)}</b>.</div>`;
      return;
    }

    x.list.innerHTML = "";
    if (cfg.style === "compact") {
      const picker = el("select");
      picker.style.width = "100%";
      for (const option of options) {
        const o = el("option", null, option);
        o.value = option;
        picker.appendChild(o);
      }
      picker.value = chosen ?? options[0];
      picker.onchange = () => ntSet(`${cfg.base}/selected`, picker.value);
      x.list.appendChild(picker);
      return;
    }

    for (const option of options) {
      const row = el("div", "opt");
      row.setAttribute("aria-checked", String(option === chosen));
      row.appendChild(el("i"));
      row.appendChild(el("span", null, option));
      row.onclick = () => ntSet(`${cfg.base}/selected`, option);
      x.list.appendChild(row);
    }
  },
});

/* --- topic readout ----------------------------------------------------------- */

define("value", {
  name: "Value",
  group: "Telemetry",
  desc: "One topic, large, whatever its type",
  w: 2, h: 1,
  config: [
    { key: "topic", label: "Topic", type: "topic", def: "/Catalyst/Brownout/MeasuredVoltage" },
    { key: "title", label: "Title", type: "text", def: "" },
    { key: "unit", label: "Unit", type: "text", def: "" },
    { key: "decimals", label: "Decimals", type: "number", def: 2 },
  ],
  render(body) {
    body.innerHTML = `<div class="fill"><div><span class="n" data-x="v" style="font-size:30px">—</span><span class="u" data-x="u"></span></div></div>`;
  },
  update(body, cfg, x) {
    const value = raw(cfg.topic);
    x.u.textContent = cfg.unit || "";
    if (!value) { x.v.textContent = "—"; x.v.className = "n"; return; }
    if (value.t === "num") { x.v.textContent = value.v.toFixed(Math.max(0, cfg.decimals | 0)); x.v.className = "n"; }
    else if (value.t === "bool") { x.v.textContent = value.v ? "YES" : "NO"; x.v.className = `n ${value.v ? "ok" : "dim"}`; }
    else if (value.t === "str") { x.v.textContent = value.v; x.v.className = "n"; }
    else { x.v.textContent = `${value.v.length} items`; x.v.className = "n dim"; }
  },
});

/* --- boolean lamps ----------------------------------------------------------- */

define("lamps", {
  name: "Indicators",
  group: "Telemetry",
  desc: "A row of boolean topics as lamps — sensors, limits, has-game-piece",
  w: 3, h: 1,
  config: [
    { key: "topics", label: "Topics", type: "topic", def: "",
      hint: "Comma separated. Each becomes a lamp labelled with the last part of its key." },
  ],
  render(body) {
    body.innerHTML = `<div class="fill"><div class="m3" data-x="grid" style="grid-template-columns:repeat(auto-fit,minmax(58px,1fr))"></div></div>`;
  },
  update(body, cfg, x) {
    const keys = String(cfg.topics || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!keys.length) {
      x.grid.innerHTML = `<div class="cap">Add topics in the tile settings.</div>`;
      return;
    }
    if (x.grid.dataset.sig !== keys.join("|")) {
      x.grid.dataset.sig = keys.join("|");
      x.grid.innerHTML = keys
        .map((k) => `<div><div class="mv" data-lamp="${escapeHtml(k)}" style="font-size:15px">—</div><div class="ml">${escapeHtml(leaf(k))}</div></div>`)
        .join("");
    }
    for (const k of keys) {
      const node = x.grid.querySelector(`[data-lamp="${CSS.escape(k)}"]`);
      if (!node) continue;
      const v = bool(k, null);
      node.textContent = v === null ? "—" : v ? "ON" : "OFF";
      node.className = `mv ${v === null ? "dim" : v ? "ok" : "dim"}`;
    }
  },
});

/* --- graph ------------------------------------------------------------------- */

define("graph", {
  name: "Graph",
  group: "Telemetry",
  desc: "Rolling plot of one numeric topic",
  w: 4, h: 2,
  config: [
    { key: "topic", label: "Topic", type: "topic", def: "/Catalyst/Loop/Robot/AverageMs" },
    { key: "title", label: "Title", type: "text", def: "" },
    { key: "decimals", label: "Decimals", type: "number", def: 2 },
  ],
  render(body, cfg) {
    track(cfg.topic);
    body.innerHTML = `
      <div class="fill">
        <div><span class="n" data-x="v" style="font-size:26px">—</span></div>
        <svg class="spark" data-x="spark" preserveAspectRatio="none"></svg>
        <div class="cap" data-x="cap"></div>
      </div>`;
  },
  update(body, cfg, x) {
    const v = num(cfg.topic, null);
    x.v.textContent = fmt(v, Math.max(0, cfg.decimals | 0));
    const h = history(cfg.topic).slice(-220);
    const box = x.spark.getBoundingClientRect();
    const w = Math.max(40, box.width), ht = Math.max(20, box.height);
    x.spark.setAttribute("viewBox", `0 0 ${w} ${ht}`);
    x.spark.innerHTML = sparkline(h, w, ht, "#4d90fe");
    if (h.length > 2) {
      x.cap.innerHTML = `min <b>${Math.min(...h).toFixed(2)}</b> · max <b>${Math.max(...h).toFixed(2)}</b> · ${h.length} samples`;
    }
  },
});

/* --- stopwatch --------------------------------------------------------------- */

define("stopwatch", {
  name: "Stopwatch",
  group: "Pit",
  desc: "A timer you start yourself — cycle times, climb practice, pit work",
  w: 2, h: 2,
  config: [
    { key: "autoStart", label: "Start on enable", type: "select", def: "no",
      options: [["no", "No"], ["yes", "Yes"]],
      hint: "Convenience only. It reads the enable state; it never affects it." },
  ],
  render(body, cfg, state) {
    state.running = false;
    state.base = 0;
    state.acc = 0;
    state.wasEnabled = false;
    body.innerHTML = `
      <div class="fill">
        <div><span class="n" data-x="v" style="font-size:36px">0.00</span><span class="u">s</span></div>
        <div style="display:flex;gap:6px;margin-top:10px">
          <button class="dk" data-x="go" style="height:34px;flex:1;background:var(--tile-2);justify-content:center">Start</button>
          <button class="dk" data-x="rst" style="height:34px;background:var(--tile-2)">Reset</button>
        </div>
      </div>`;
    const toggle = () => {
      if (state.running) { state.acc += performance.now() - state.base; state.running = false; }
      else { state.base = performance.now(); state.running = true; }
      body.querySelector("[data-x=go]").textContent = state.running ? "Stop" : "Start";
    };
    body.querySelector("[data-x=go]").onclick = toggle;
    body.querySelector("[data-x=rst]").onclick = () => {
      state.running = false; state.acc = 0;
      body.querySelector("[data-x=go]").textContent = "Start";
    };
    state.toggle = toggle;
  },
  update(body, cfg, x, tile, state) {
    if (cfg.autoStart === "yes") {
      if (ds.enabled && !state.wasEnabled && !state.running) { state.acc = 0; state.toggle(); }
      state.wasEnabled = ds.enabled;
    }
    const ms = state.acc + (state.running ? performance.now() - state.base : 0);
    x.v.textContent = (ms / 1000).toFixed(2);
  },
});

/* --- note -------------------------------------------------------------------- */

define("note", {
  name: "Note",
  group: "Pit",
  desc: "Free text that stays with the layout — setup reminders, a checklist",
  w: 3, h: 2,
  config: [
    { key: "text", label: "Text", type: "text", def: "Check bumper numbers\nRadio power\nBattery > 12.4 V" },
  ],
  render(body) {
    body.innerHTML = `<div class="fill" style="justify-content:flex-start"><div class="cap" data-x="t" style="white-space:pre-wrap;font-size:13px;line-height:1.6"></div></div>`;
  },
  update(body, cfg, x) {
    if (x.t.dataset.sig !== cfg.text) { x.t.dataset.sig = cfg.text; x.t.textContent = cfg.text; }
  },
});

/* --- 3D field ---------------------------------------------------------------- */

define("field", {
  name: "Field view",
  group: "Catalyst",
  desc: "The robot on the field in 3D, drawn from the pose estimator",
  w: 5, h: 4,
  tileClass: "pad0",
  config: [
    { key: "poseKey", label: "Pose topic", type: "topic", def: "/Catalyst/Physics/PoseArray",
      hint: "Number array [x, y, theta] in metres and radians. Physics Core publishes this alongside the Pose2d struct, which dashboards cannot all read." },
    { key: "length", label: "Field length (m)", type: "number", def: 16.54,
      hint: "REBUILT carpet is 651.2 in × 317.7 in, from the 2026 field drawings." },
    { key: "width", label: "Field width (m)", type: "number", def: 8.07 },
  ],
  render(body, cfg, state) {
    track(cfg.poseKey);
    body.innerHTML = `
      <canvas class="fieldcanvas" data-x="canvas"></canvas>
      <div class="fieldlab">Field</div>
      <div class="fieldchips">
        <div class="fc">x <b data-x="fx">—</b> m</div>
        <div class="fc">y <b data-x="fy">—</b> m</div>
        <div class="fc">θ <b data-x="ft">—</b>°</div>
      </div>
      <div class="fieldbtns">
        <button class="fbtn" data-mode="chase">Chase</button>
        <button class="fbtn" data-mode="top">Overhead</button>
        <button class="fbtn" data-mode="free">Free</button>
      </div>`;

    const canvas = body.querySelector("[data-x=canvas]");
    state.scene = null;

    /* Camera, trail and the baked model come from Settings rather than from this tile's configuration:
     * they describe what this driver wants to look at and what this laptop can afford to draw, not
     * what the tile is showing.
     *
     * The buttons in the corner are the quick way to swing the camera during a match, and they set the
     * same value the Settings control sets — one state, two surfaces, exactly as the demo toggle works.
     * They used to override the mode locally with no way back, so pressing Free here left Settings
     * reading Chase for the rest of the session. `applyCamera` moves this tile and nothing else;
     * `setCamera` is the thing that decides. */
    const applyCamera = (mode) => {
      state.mode = mode;
      state.scene?.setMode(mode);
      for (const b of body.querySelectorAll(".fbtn")) {
        b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
      }
    };
    state.applyCamera = applyCamera;
    for (const b of body.querySelectorAll(".fbtn")) b.onclick = () => setCamera(b.dataset.mode);
    applyCamera(settings.fieldCamera);

    /* three.js is ~675 KB. It is only fetched when a field tile actually exists, so a layout without
     * one never pays for it. */
    import("./field3d.js")
      .then((mod) => {
        state.scene = mod.createField(canvas, {
          length: cfg.length,
          width: cfg.width,
          trail: settings.fieldTrail,
          model: settings.fieldModel,
          onModel: () => { body.querySelector(".fieldlab").textContent = "Field · REBUILT"; },
        });
        state.scene.setMode(state.mode);
      })
      .catch((err) => {
        console.warn("field view unavailable", err);
        body.querySelector(".fieldlab").textContent = "Field view unavailable";
      });
  },
  update(body, cfg, x, tile, state) {
    const pose = arr(cfg.poseKey);
    const valid = Array.isArray(pose) && pose.length >= 3 && pose.every((n) => Number.isFinite(n));
    x.fx.textContent = valid ? pose[0].toFixed(2) : "—";
    x.fy.textContent = valid ? pose[1].toFixed(2) : "—";
    x.ft.textContent = valid ? ((pose[2] * 180) / Math.PI).toFixed(0) : "—";
    state.scene?.update({
      pose: valid ? pose : null,
      alliance: alliance(),
      enabled: ds.enabled,
    });
  },
  onShow(state) {
    state.scene?.redraw();
  },
  dispose(state) {
    state.scene?.dispose();
    state.scene = null;
  },
});

/* ==================================================================== the board */

const GRID_COLS = 12;
/* Eight rows rather than six. The row height is what decides how small a tile is allowed to be, and at
 * six rows the shortest possible tile was a third of the board — so a one-line control like an auto
 * chooser had to waste the space of a graph. Eight rows buys real estate back without making anything
 * fiddly to drag. */
const GRID_ROWS = 8;
const STORE_KEY = "catalyst.console.layout.v2";

const DEFAULT_LAYOUT = [
  { type: "match", x: 0, y: 0, w: 3, h: 2 },
  { type: "tower", x: 3, y: 0, w: 3, h: 2 },
  { type: "health", x: 6, y: 0, w: 3, h: 2 },
  { type: "battery", x: 9, y: 0, w: 3, h: 2 },
  { type: "field", x: 0, y: 2, w: 5, h: 6 },
  { type: "gauge", x: 5, y: 2, w: 4, h: 3,
    cfg: { topic: "/Catalyst/Drive/FrontLeft/Velocity,/Catalyst/Drive/FrontRight/Velocity,/Catalyst/Drive/BackLeft/Velocity,/Catalyst/Drive/BackRight/Velocity",
           title: "Drive", style: "arc", unit: "RPM", scale: 60, min: 0, max: 6000, redline: 5800, decimals: 0 } },
  { type: "physics", x: 9, y: 2, w: 3, h: 3 },
  { type: "alerts", x: 5, y: 5, w: 4, h: 3 },
  { type: "auto", x: 9, y: 5, w: 3, h: 1 },
  { type: "graph", x: 9, y: 6, w: 3, h: 2,
    cfg: { topic: "/Catalyst/Loop/Robot/AverageMs", title: "Loop time", decimals: 1 } },
];

let layout = [];
const live = new Map(); // id -> {spec, tile, body, cfg, refs, state}
let nextId = 1;

function defaults(spec) {
  const cfg = {};
  for (const field of spec.config) cfg[field.key] = field.def;
  return cfg;
}

/**
 * Is this a tile the rest of the program can be handed?
 *
 * The boundary is the right place for this, and it is the only place that should need it. Everything
 * downstream treats a layout item as a given: `buildBoard` indexes REGISTRY with `item.type`, the grid
 * arithmetic assumes whole numbers, dragging swaps geometry between two items, `saveLayout` writes
 * whatever it is given straight back out. One check here is what lets all of that stay as plain as it
 * reads — and a value that was never let in cannot cost anything later.
 *
 * A guard at the call site instead would only catch the bad item after it had already reached code
 * that had no business validating it, and at module scope it would be catching a fire, not preventing
 * one: `buildBoard` runs during evaluation of this file.
 */
function usableLayoutItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (typeof item.type !== "string" || !REGISTRY[item.type]) return false;
  if (![item.x, item.y, item.w, item.h].every(Number.isInteger)) return false;
  if (item.w < 1 || item.h < 1) return false;
  if (item.x < 0 || item.y < 0 || item.x + item.w > GRID_COLS || item.y + item.h > GRID_ROWS) return false;
  return item.cfg === undefined
    || (item.cfg !== null && typeof item.cfg === "object" && !Array.isArray(item.cfg));
}

/* Unreadable tiles are dropped here, where the importer (`readLayoutDocument`) refuses the whole
 * document and names every reason. The two are answering different questions on purpose: an import is
 * someone handing over a file and wanting to be told what is wrong with it, this is a driver opening
 * the console and wanting their board. Silence and nine of ten tiles beats a dialog and none. */
function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (Array.isArray(saved)) {
      const clean = [];
      /* Two different things happen to a saved tile, and the warning has to tell them apart. Past the
       * cap a tile is not read at all — it is perfectly good and there was no room — so counting the
       * shortfall against `saved` blamed the truncation on the reader: a stored board of 5000 valid
       * tiles used to report 4936 of them unreadable, which is a false accusation and sends whoever
       * reads it looking for corruption that is not there. `read` is what was actually looked at. */
      const read = saved.slice(0, LAYOUT_MAX_TILES);
      /* Rebuilt field by field rather than copied. Ids are per-session handles into `live` and
       * `buildBoard` issues fresh ones, and anything else that found its way into storage has no
       * business travelling any further than this line. */
      for (const item of read) {
        if (!usableLayoutItem(item)) continue;
        clean.push({
          type: item.type, x: item.x, y: item.y, w: item.w, h: item.h, cfg: { ...(item.cfg || {}) },
        });
      }
      if (clean.length !== read.length) {
        console.warn(`layout: dropped ${read.length - clean.length} unreadable tile(s) from storage`);
      }
      if (saved.length > read.length) {
        console.warn(`layout: ${saved.length - read.length} tile(s) past the ${LAYOUT_MAX_TILES}-tile cap were not read`);
      }
      if (clean.length) return clean;
    }
  } catch { /* corrupt storage is not worth a dialog; fall through to defaults */ }
  return DEFAULT_LAYOUT.map((c) => ({ ...c }));
}

function saveLayout() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(layout));
  } catch { /* private mode or quota — the board still works, it just will not persist */ }
}

function buildBoard() {
  for (const entry of live.values()) entry.spec.dispose?.(entry.state);
  live.clear();
  const board = $("#board");
  board.innerHTML = "";
  board.style.gridTemplateColumns = `repeat(${GRID_COLS}, 1fr)`;
  board.style.gridTemplateRows = `repeat(${GRID_ROWS}, 1fr)`;

  for (const item of layout) {
    const spec = REGISTRY[item.type];
    if (!spec) continue;
    if (!item.id) item.id = `c${nextId++}`;
    item.cfg = { ...defaults(spec), ...(item.cfg || {}) };

    const tile = el("div", `t ${spec.tileClass || ""}`);
    tile.dataset.id = item.id;
    tile.style.gridColumn = `${item.x + 1} / span ${item.w}`;
    tile.style.gridRow = `${item.y + 1} / span ${item.h}`;

    const head = el("div", "h");
    head.appendChild(el("span", null, item.cfg.title || spec.name));
    const sub = el("span", "s");
    head.appendChild(sub);
    if (!spec.tileClass?.includes("pad0")) tile.appendChild(head);

    const tools = el("div", "tools");
    const cfgBtn = el("button", "tbtn cfg", "⚙");
    cfgBtn.title = "Configure";
    cfgBtn.onclick = (e) => { e.stopPropagation(); openConfig(item); };
    const delBtn = el("button", "tbtn del", "×");
    delBtn.title = "Remove";
    delBtn.onclick = (e) => {
      e.stopPropagation();
      layout = layout.filter((i) => i !== item);
      saveLayout();
      buildBoard();
    };
    tools.append(cfgBtn, delBtn);
    tile.appendChild(tools);

    const body = el("div", spec.tileClass?.includes("pad0") ? "" : "fillhost");
    body.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column";
    tile.appendChild(body);

    const state = {};
    try {
      spec.render(body, item.cfg, state);
    } catch (err) {
      console.warn(`component ${item.type} failed to render`, err);
      body.innerHTML = `<div class="cap" style="padding-top:10px">This tile failed to load.</div>`;
    }

    const refs = {};
    for (const node of body.querySelectorAll("[data-x]")) refs[node.dataset.x] = node;

    board.appendChild(tile);
    live.set(item.id, { item, spec, tile, body, refs, state, sub });
    installDrag(tile, item);
  }
  paint();
}

/**
 * Build one kind of tile again in place, for a setting a component only reads once.
 *
 * The field view allocates its trail buffer and decides about the baked model when the scene is
 * created, so those two settings cannot be pushed into a running tile — it has to be made again. Only
 * the tiles that care are touched: rebuilding the whole board would drop the alert tile's hold state
 * and every graph's history to change a camera setting.
 */
function rebuildTilesOfType(type) {
  for (const entry of live.values()) {
    if (entry.item.type !== type) continue;
    entry.spec.dispose?.(entry.state);
    entry.state = {};
    entry.body.innerHTML = "";
    try {
      entry.spec.render(entry.body, entry.item.cfg, entry.state);
    } catch (err) {
      console.warn(`component ${type} failed to render`, err);
      entry.body.innerHTML = `<div class="cap" style="padding-top:10px">This tile failed to load.</div>`;
    }
    entry.refs = {};
    for (const node of entry.body.querySelectorAll("[data-x]")) entry.refs[node.dataset.x] = node;
  }
  paint();
}

/* Drag to rearrange: tiles swap places. Simpler than free placement and impossible to get into a
 * broken layout with, which matters more than pixel-perfect packing five minutes before a match. */
let dragging = null;

function installDrag(tile, item) {
  tile.draggable = true;
  tile.addEventListener("dragstart", (e) => {
    if (app.dataset.edit !== "true") { e.preventDefault(); return; }
    dragging = item;
    tile.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  tile.addEventListener("dragend", () => {
    dragging = null;
    tile.classList.remove("dragging");
    for (const t of document.querySelectorAll(".dropTarget")) t.classList.remove("dropTarget");
  });
  tile.addEventListener("dragover", (e) => {
    if (!dragging || dragging === item) return;
    e.preventDefault();
    tile.classList.add("dropTarget");
  });
  tile.addEventListener("dragleave", () => tile.classList.remove("dropTarget"));
  tile.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragging || dragging === item) return;
    const a = dragging, b = item;
    [a.x, b.x] = [b.x, a.x];
    [a.y, b.y] = [b.y, a.y];
    [a.w, b.w] = [b.w, a.w];
    [a.h, b.h] = [b.h, a.h];
    saveLayout();
    buildBoard();
  });
}

/* ---------------------------------------------------------------- config modal */

let configTarget = null;

function openConfig(item) {
  const spec = REGISTRY[item.type];
  configTarget = item;
  $("#cfgTitle").textContent = spec.name;
  $("#cfgDesc").textContent = spec.desc;
  const bodyEl = $("#cfgBody");
  bodyEl.innerHTML = "";

  const add = (label, control, hint) => {
    const row = el("div", "cfgrow");
    const wrap = el("div");
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el("div", "hint", hint));
    row.append(el("label", null, label), wrap);
    bodyEl.appendChild(row);
  };

  for (const field of spec.config) {
    let control;
    if (field.type === "select") {
      control = el("select");
      for (const [value, text] of field.options) {
        const o = el("option", null, text);
        o.value = value;
        control.appendChild(o);
      }
      control.value = item.cfg[field.key];
    } else if (field.type === "number") {
      control = el("input");
      control.type = "number";
      control.step = "any";
      control.value = item.cfg[field.key];
    } else {
      control = el("input");
      control.type = "text";
      control.value = item.cfg[field.key] ?? "";
      if (field.type === "topic") control.setAttribute("list", "ntkeys");
    }
    control.oninput = () => {
      item.cfg[field.key] = field.type === "number" ? Number(control.value) : control.value;
    };
    add(field.label, control, field.hint);
  }

  const size = el("div");
  size.style.cssText = "display:flex;gap:8px";
  const mk = (label, value, max, apply) => {
    const s = el("select");
    for (let i = 1; i <= max; i++) {
      const o = el("option", null, `${label} ${i}`);
      o.value = String(i);
      s.appendChild(o);
    }
    s.value = String(value);
    s.onchange = () => apply(Number(s.value));
    size.appendChild(s);
  };
  mk("Width", item.w, GRID_COLS, (v) => { item.w = v; });
  mk("Height", item.h, GRID_ROWS, (v) => { item.h = v; });
  add("Tile size", size, "Columns and rows out of the 12 × 8 board.");

  $("#cfgModal").dataset.open = "true";
}

$("#cfgClose").onclick = () => {
  $("#cfgModal").dataset.open = "false";
  if (configTarget) { saveLayout(); buildBoard(); configTarget = null; }
};

/* ---------------------------------------------------------------- picker modal */

function openPicker() {
  const bodyEl = $("#pickBody");
  bodyEl.innerHTML = "";
  const groups = new Map();
  for (const [type, spec] of Object.entries(REGISTRY)) {
    if (!groups.has(spec.group)) groups.set(spec.group, []);
    groups.get(spec.group).push([type, spec]);
  }
  for (const [group, items] of groups) {
    bodyEl.appendChild(el("div", "pg", group));
    const grid = el("div", "cat");
    for (const [type, spec] of items) {
      const btn = el("button", `item ${group === "Catalyst" ? "own" : ""}`);
      btn.innerHTML = `<div class="n2">${spec.name}</div><div class="d2">${spec.desc}</div>`;
      btn.onclick = () => {
        const spot = findSpace(spec.w, spec.h);
        layout.push({ type, x: spot.x, y: spot.y, w: spec.w, h: spec.h, cfg: defaults(spec) });
        saveLayout();
        buildBoard();
      };
      grid.appendChild(btn);
    }
    bodyEl.appendChild(grid);
  }
  $("#pickModal").dataset.open = "true";
}

/* First free rectangle, scanning row-major. If the board is genuinely full we drop the tile in the
 * bottom-left rather than refusing — the user can move it, and refusing is a worse answer. */
function findSpace(w, h) {
  const occupied = Array.from({ length: GRID_ROWS }, () => new Array(GRID_COLS).fill(false));
  for (const item of layout) {
    for (let y = item.y; y < Math.min(GRID_ROWS, item.y + item.h); y++)
      for (let x = item.x; x < Math.min(GRID_COLS, item.x + item.w); x++) occupied[y][x] = true;
  }
  for (let y = 0; y + h <= GRID_ROWS; y++) {
    for (let x = 0; x + w <= GRID_COLS; x++) {
      let free = true;
      for (let dy = 0; dy < h && free; dy++)
        for (let dx = 0; dx < w; dx++) if (occupied[y + dy][x + dx]) { free = false; break; }
      if (free) return { x, y };
    }
  }
  return { x: 0, y: Math.max(0, GRID_ROWS - h) };
}

$("#pickClose").onclick = () => { $("#pickModal").dataset.open = "false"; };
$("#addBtn").onclick = openPicker;

/* ------------------------------------------------------- layout export / import */

/* A team sets a board up once and wants it on the other five driver stations, and on the spare laptop
 * that comes out of the crate when one dies. The file is plain JSON so it can live in the robot repo
 * next to the code it is reading. */
const LAYOUT_KIND = "catalyst-console-layout";
const LAYOUT_DOC_VERSION = 1;
/* Well past any sane board, but a number: a file claiming a hundred thousand tiles should be refused
 * before it is walked, not after it has locked the window building them. */
const LAYOUT_MAX_TILES = 64;

function layoutDocument() {
  return {
    kind: LAYOUT_KIND,
    version: LAYOUT_DOC_VERSION,
    app: "Catalyst Console",
    savedAt: new Date().toISOString(),
    grid: { cols: GRID_COLS, rows: GRID_ROWS },
    /* Ids are per-session handles into the live map, not part of the layout. Dropping them here means
     * an imported board gets fresh ones instead of colliding with tiles already on screen. */
    tiles: layout.map(({ type, x, y, w, h, cfg }) => ({ type, x, y, w, h, cfg: { ...cfg } })),
  };
}

/**
 * Parse and check a layout file, whole.
 *
 * Refuse, never repair. A half-applied import leaves a board the driver did not ask for and cannot
 * undo five minutes before a match; saying no and naming every reason is the smaller failure. Nothing
 * in here mutates anything — the caller applies the result only if `tiles` came back.
 */
/* Written by every export and, until this was noticed, never read by any import: a version constant
   that only ever travels outward tells you nothing. A newer format reaching an older build would have
   been half-applied rather than refused, which is the opposite of what the importer promises. */
function layoutVersionIsReadable(v) {
  return v === undefined || (Number.isInteger(v) && v <= LAYOUT_DOC_VERSION);
}

function readLayoutDocument(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { problems: [`That is not JSON — ${e.message || e}`] };
  }

  const bare = Array.isArray(doc);
  const wrapped = !bare && doc !== null && typeof doc === "object";
  if (!bare && !wrapped) return { problems: ["That file is a single value, not a layout."] };
  if (wrapped && doc.kind && doc.kind !== LAYOUT_KIND) {
    return { problems: [`That file says it is "${doc.kind}", not a Catalyst Console layout.`] };
  }

  /* A bare array is exactly what the console keeps in local storage, so it is a layout even without
   * the wrapper. Anything else has to identify itself. */
  const tiles = bare ? doc : doc.tiles;
  if (!Array.isArray(tiles)) {
    return { problems: ["No list of tiles in that file — it does not look like a Catalyst Console layout."] };
  }
  if (!tiles.length) return { problems: ["That layout has no tiles in it."] };
  if (tiles.length > LAYOUT_MAX_TILES) {
    return { problems: [`That layout has ${tiles.length} tiles; the board holds at most ${LAYOUT_MAX_TILES}.`] };
  }

  const problems = [];
  const clean = [];
  const savedGrid = wrapped && doc.grid && Number.isInteger(doc.grid.cols) && Number.isInteger(doc.grid.rows)
    ? doc.grid : null;

  tiles.forEach((t, i) => {
    const at = `Tile ${i + 1}`;
    if (!t || typeof t !== "object" || Array.isArray(t)) { problems.push(`${at} is not a tile.`); return; }
    if (typeof t.type !== "string" || !REGISTRY[t.type]) {
      problems.push(`${at}: no component called "${t.type}" in this version.`);
      return;
    }
    if (![t.x, t.y, t.w, t.h].every(Number.isInteger)) {
      problems.push(`${at} (${t.type}): position and size must be whole numbers.`);
      return;
    }
    if (t.w < 1 || t.h < 1) { problems.push(`${at} (${t.type}): must be at least 1 × 1.`); return; }
    if (t.x < 0 || t.y < 0 || t.x + t.w > GRID_COLS || t.y + t.h > GRID_ROWS) {
      problems.push(`${at} (${t.type}): falls outside the ${GRID_COLS} × ${GRID_ROWS} board.`);
      return;
    }
    if (t.cfg !== undefined && (t.cfg === null || typeof t.cfg !== "object" || Array.isArray(t.cfg))) {
      problems.push(`${at} (${t.type}): its settings are not an object.`);
      return;
    }
    clean.push({ type: t.type, x: t.x, y: t.y, w: t.w, h: t.h, cfg: { ...(t.cfg || {}) } });
  });

  if (problems.length) {
    /* If the board it was saved on was a different shape, say so first — it explains every
     * out-of-bounds line under it at once. */
    if (savedGrid && (savedGrid.cols !== GRID_COLS || savedGrid.rows !== GRID_ROWS)) {
      problems.unshift(`Saved from a ${savedGrid.cols} × ${savedGrid.rows} board; this one is ${GRID_COLS} × ${GRID_ROWS}.`);
    }
    return { problems };
  }
  return { tiles: clean };
}

function setLayoutStatus(text, tone, list) {
  const node = $("#layoutStatus");
  node.dataset.tone = tone || "";
  node.textContent = text || "";
  if (list && list.length) {
    const ul = el("ul");
    for (const line of list.slice(0, 8)) ul.appendChild(el("li", null, line));
    if (list.length > 8) ul.appendChild(el("li", null, `…and ${list.length - 8} more.`));
    node.appendChild(ul);
  }
}

function applyLayoutText(text, whence) {
  const result = readLayoutDocument(String(text || ""));
  if (result.problems) {
    setLayoutStatus("Not imported. The board is untouched.", "bad", result.problems);
    return false;
  }
  layout = result.tiles;
  saveLayout();
  buildBoard();
  const n = result.tiles.length;
  setLayoutStatus(`Imported ${n} tile${n === 1 ? "" : "s"}${whence ? ` from ${whence}` : ""}. The board is live.`, "ok");
  return true;
}

/* The dialog and fs plugins can each be missing at runtime even when they are compiled in — a Tauri v2
 * plugin command that no capability grants throws when it is called. So every path here probes, and
 * every failure falls through to something that still works rather than reporting an error. */
const inTauri = !!window.__TAURI__;
const plugin = (name) => window.__TAURI__?.[name];

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* not a secure context, or permission refused */ }
  try {
    const box = el("textarea");
    box.value = text;
    box.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand("copy");
    box.remove();
    return ok;
  } catch {
    return false;
  }
}

function downloadText(name, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = el("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  } catch (e) {
    console.warn("download unavailable", e);
    return false;
  }
}

function layoutJson() {
  return JSON.stringify(layoutDocument(), null, 2);
}

function layoutFilename() {
  return `catalyst-layout-${new Date().toISOString().slice(0, 10)}.json`;
}

async function exportLayoutToFile() {
  const text = layoutJson();
  const name = layoutFilename();
  const dlg = plugin("dialog");
  const fs = plugin("fs");

  if (dlg?.save && fs?.writeTextFile) {
    try {
      const path = await dlg.save({
        defaultPath: name,
        filters: [{ name: "Layout", extensions: ["json"] }],
      });
      if (!path) { setLayoutStatus("", null); return; }   // cancelling is not a failure
      await fs.writeTextFile(path, text);
      setLayoutStatus(`Saved to ${path}`, "ok");
      return;
    } catch (e) {
      console.warn("save dialog unavailable", e);
    }
  }

  /* In the desktop app without file access, a blob download can be swallowed silently by the content
   * security policy, and claiming a save that did not happen is worse than not offering one. The
   * clipboard is the honest answer there; a browser gets the download. */
  if (!inTauri && downloadText(name, text)) {
    setLayoutStatus(`Exported ${name}.`, "ok");
    return;
  }
  if (await copyText(text)) {
    setLayoutStatus("No file access here, so the layout is on your clipboard instead.", "ok");
    return;
  }
  $("#impText").value = text;
  /* Named rather than pointed at. These messages used to say "the box above", which stopped being true
   * the moment the paste box became a row of its own. */
  setLayoutStatus("Could not save or copy. The layout is in the paste box — select it and copy.", "bad");
}

async function importLayoutFromFile() {
  const dlg = plugin("dialog");
  const fs = plugin("fs");
  if (dlg?.open && fs?.readTextFile) {
    try {
      const picked = await dlg.open({ multiple: false, filters: [{ name: "Layout", extensions: ["json"] }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) { setLayoutStatus("", null); return; }
      applyLayoutText(await fs.readTextFile(path), leaf(String(path)));
      return;
    } catch (e) {
      console.warn("open dialog unavailable", e);
    }
  }
  /* A file input is not a plugin and needs no capability, so it is the floor under every build. */
  $("#impPicker").click();
}

$("#impPicker").onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    applyLayoutText(await file.text(), file.name);
  } catch (err) {
    setLayoutStatus(`Could not read that file — ${err}`, "bad");
  }
};

$("#expFile").onclick = exportLayoutToFile;
$("#expClip").onclick = async () => {
  if (await copyText(layoutJson())) { setLayoutStatus("Layout copied to the clipboard.", "ok"); return; }
  $("#impText").value = layoutJson();
  setLayoutStatus("The clipboard refused. The layout is in the paste box — select it and copy.", "bad");
};
$("#impFile").onclick = importLayoutFromFile;
$("#impClip").onclick = async () => {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    setLayoutStatus("Cannot read the clipboard here. Use the paste box instead.", "bad");
    return;
  }
  applyLayoutText(text, "the clipboard");
};
$("#impPaste").onclick = () => applyLayoutText($("#impText").value, null);

/* ------------------------------------------------------------------ tabs/sheets */

const app = $("#app");

/* Order is load-bearing: the number keys index into this. */
const VIEWS = ["board", "tune", "logs", "topics"];

function activeView() {
  return document.querySelector('.view[data-active="true"]')?.dataset.view || "board";
}

function showView(name) {
  if (!VIEWS.includes(name)) return;
  for (const t of document.querySelectorAll(".tab")) {
    const on = t.dataset.view === name;
    t.setAttribute("aria-selected", String(on));
    /* The roving half of the tablist: only the selected tab is in the tab order. */
    t.tabIndex = on ? 0 : -1;
  }
  for (const v of document.querySelectorAll(".view")) {
    v.dataset.active = String(v.dataset.view === name);
  }
  if (name === "logs") paintLogs();
  if (name === "tune") paintTune();
  if (name === "topics") paintTopics();
  if (name === "board") {
    paint();
    for (const entry of live.values()) entry.spec.onShow?.(entry.state);
  }
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => showView(tab.dataset.view);
}
wireTablist($(".tabs"));

$("#editBtn").onclick = () => {
  const on = app.dataset.edit !== "true";
  app.dataset.edit = String(on);
  $("#editBtn").setAttribute("aria-pressed", String(on));
};

function resetBoard() {
  layout = DEFAULT_LAYOUT.map((c) => ({ ...c }));
  saveLayout();
  buildBoard();
}

$("#demoBtn").onclick = () => setDemo(!demo.on);

/* ---------------------------------------------------------------------- updates */

/* Checked once, quietly, a few seconds after launch. If there is nothing to install nothing appears;
 * if the network is unreachable — which on a field is the normal case — nothing appears either. The
 * only visible outcome is a chip in the dock, and installing is always a deliberate click. An update
 * prompt is exactly the sort of thing rule two exists to keep away from a driver. */
/* One check, shared. The dock wants to know whether there is a release; Settings wants the version
 * out of the same answer. Checking twice would be two requests to GitHub from a laptop that is
 * usually on a field network with no route there. */
let updatePromise = null;

/** `force` is the Settings button: the shared answer is thrown away and GitHub is asked again. */
function updateCheck(force) {
  if (force) updatePromise = null;
  if (!updatePromise) {
    updatePromise = invoke
      /* No `current` in here on purpose. A rejected invoke means the check did not happen; it does not
       * mean the installed version is empty, and saying so erased a version already on screen. */
      ? invoke("check_update").catch((e) => ({ available: false, error: String(e) }))
      : Promise.resolve(null);
  }
  return updatePromise;
}

if (invoke) {
  setTimeout(async () => {
    const info = await updateCheck();
    if (!info || !info.available) return;

    const chip = el("button", "dk");
    chip.style.cssText = "background:var(--brand);color:#fff";
    chip.textContent = `Update to ${info.version}`;
    chip.title = info.notes ? info.notes.slice(0, 300) : `You are on ${info.current}`;
    chip.onclick = async () => {
      chip.disabled = true;
      chip.textContent = "Installing…";
      const failed = await invoke("install_update").catch((e) => String(e));
      if (failed) {
        chip.disabled = false;
        chip.textContent = "Update failed";
        chip.title = failed;
      }
    };
    $("#rttChip").insertAdjacentElement("beforebegin", chip);
  }, 6000);
}

/* ------------------------------------------------------------------- tune sheet */

function paintTune() {
  const sheet = $("#tuneSheet");
  const items = tunables();

  if (!items.length) {
    sheet.innerHTML = `
      <div class="sh">Live tuning</div>
      <div class="empty">The robot has not published a tunable manifest.</div>
      <div class="note">
        <b>How the robot declares what is tunable.</b> Publish a JSON string on
        <code>${TUNABLE_MANIFEST}</code> — an array of
        <code>{ "key", "name", "group", "min", "max", "step", "unit" }</code>. The console shows exactly
        what is in that list and writes back to each entry's <code>key</code>. Nothing is inferred, so a
        topic you did not declare can never be changed from here.
      </div>`;
    return;
  }

  const groups = new Map();
  for (const t of items) {
    const g = t.group || "General";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }

  sheet.innerHTML = "";
  for (const [group, entries] of groups) {
    sheet.appendChild(el("div", "sh", group));
    for (const t of entries) {
      const row = el("div", "tr");
      const name = el("div", "nm");
      name.appendChild(el("span", null, t.name || leaf(t.key)));
      name.appendChild(el("small", null, t.key));
      row.appendChild(name);

      const current = num(t.key, null);
      const isBool = raw(t.key)?.t === "bool";

      if (isBool) {
        const btn = el("button", "dk");
        btn.style.cssText = "height:34px;background:var(--tile-2)";
        btn.textContent = bool(t.key) ? "On" : "Off";
        btn.onclick = () => ntSet(t.key, !bool(t.key));
        row.appendChild(btn);
        row.appendChild(el("div", "v", bool(t.key) ? "ON" : "OFF"));
      } else {
        const slider = el("input");
        slider.type = "range";
        slider.min = String(t.min ?? 0);
        slider.max = String(t.max ?? 1);
        slider.step = String(t.step ?? 0.01);
        slider.value = String(current ?? t.min ?? 0);
        paintRange(slider);
        /* Show exactly as many decimals as the step can resolve: a 25 RPM step printed to three
         * places is noise, and a 0.001 gain printed to one is unusable. */
        const step = Number(t.step ?? 0.01);
        const places = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
        const readout = el("div", "v", `${fmt(current, places)}${t.unit ? ` ${t.unit}` : ""}`);
        slider.oninput = () => {
          paintRange(slider);
          readout.textContent = `${Number(slider.value).toFixed(places)}${t.unit ? ` ${t.unit}` : ""}`;
        };
        slider.onchange = () => ntSet(t.key, Number(slider.value));
        row.append(slider, readout);
      }
      sheet.appendChild(row);
    }
  }
  sheet.appendChild(
    Object.assign(el("div", "note"), {
      innerHTML:
        "Values are written straight to NetworkTables, exactly as Shuffleboard or Elastic would. " +
        "Persist anything you like on the robot — the console does not, and a reboot returns to code defaults.",
    })
  );
}

/* ------------------------------------------------------------------- logs sheet */

/* Two halves, in this order deliberately: what the link has done since this console started, and then
 * what the NI Driver Station recorded in earlier sessions. A driver who has just lost comms is asking
 * about the last ten minutes, not about last weekend. */
function paintLogs() {
  const sheet = $("#logSheet");
  sheet.innerHTML = "";
  const session = el("div");
  session.id = "linkSession";
  sheet.appendChild(session);
  paintLinkHistory();

  const host = el("div");
  host.id = "dsLogs";
  host.style.marginTop = "26px";
  sheet.appendChild(host);
  refreshSessions(host);
}

function paintLinkHistory() {
  const host = $("#linkSession");
  if (!host) return;
  host.dataset.v = String(linkLogVersion);

  const now = linkSource();
  const since = linkLog.length ? linkLog[linkLog.length - 1].t : BOOT;
  const drops = linkDrops();
  const state = !now ? "No link" : now.key === "demo" ? "Demo data" : `Linked · ${now.label}`;

  host.innerHTML = `
    <div class="lh">
      <div class="sh">This session</div>
      <div class="sum">${escapeHtml(state)} for <span data-x="lhFor">${duration(performance.now() - since)}</span>${
        drops ? ` · ${drops} drop${drops === 1 ? "" : "s"}` : ""
      }</div>
    </div>`;

  if (!linkLog.length) {
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="empty">Nothing has changed since the console started ${escapeHtml(duration(performance.now() - BOOT))} ago.<br>Connects, drops and address changes land here as they happen.</div>`
    );
    return;
  }

  const grid = el("div", "lg");
  /* Newest first: the entry you opened this tab to read is the one at the top. */
  for (let i = linkLog.length - 1; i >= 0; i--) {
    const e = linkLog[i];
    const held = e.kind === "down" || e.kind === "demoOff"
      ? ` <span class="held">held ${escapeHtml(duration(e.t - (linkLog[i - 1]?.t ?? BOOT)))}</span>`
      : "";
    grid.insertAdjacentHTML(
      "beforeend",
      `<div class="lt">${clockOfDay(e.at)}</div><div class="rl ${LINK_RAIL[e.kind] || "info"}"><i></i></div>` +
        `<div class="le">${escapeHtml(linkText(e))}${held}</div>`
    );
  }
  host.appendChild(grid);
}

/* Rebuilding the timeline ten times a second would drop any text the user was midway through
 * selecting, so the list is only redrawn when there is a new entry; the running total is a single
 * text node that costs nothing to keep current. */
function tickLinkHistory() {
  const host = $("#linkSession");
  if (!host) return;
  if (host.dataset.v !== String(linkLogVersion)) { paintLinkHistory(); return; }
  const span = host.querySelector("[data-x=lhFor]");
  if (span) {
    const since = linkLog.length ? linkLog[linkLog.length - 1].t : BOOT;
    span.textContent = duration(performance.now() - since);
  }
}

let sessions = [];

async function refreshSessions(host) {
  if (!host) return;
  if (!invoke) {
    host.innerHTML = `<div class="sh">Driver Station logs</div><div class="empty">These are read from disk, so they need the desktop app.</div>`;
    return;
  }

  try {
    sessions = await invoke("ds_sessions", { dir: null });
  } catch (e) {
    console.warn(e);
    sessions = [];
  }

  const dir = await invoke("ds_log_dir").catch(() => "");
  host.innerHTML = `<div class="sh">Driver Station logs</div>`;

  if (!sessions.length) {
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="empty">No sessions in <code>${escapeHtml(dir)}</code>.<br>The NI Driver Station writes these itself — once it has run a match on this machine they show up here.</div>`
    );
    return;
  }

  const row = el("div", "pickrow");
  const picker = el("select");
  sessions.forEach((s, i) => {
    const o = el("option", null, `${s.name}${s.has_log ? "" : " (events only)"}`);
    o.value = String(i);
    picker.appendChild(o);
  });
  picker.onchange = () => openSession(sessions[Number(picker.value)]);
  row.append(picker);
  host.appendChild(row);
  host.appendChild(el("div", null)).id = "sessionBody";
  openSession(sessions[0]);
}

async function openSession(session) {
  const host = $("#sessionBody");
  if (!host || !session) return;
  host.innerHTML = `<div class="empty">Reading…</div>`;

  const [events, samples] = await Promise.all([
    invoke("ds_events", { path: session.path }).catch(() => []),
    invoke("ds_samples", { path: session.path }).catch(() => ({ parsed: false, note: "read failed" })),
  ]);

  host.innerHTML = "";

  if (samples.parsed && samples.battery.length) {
    const w = 900, h = 90;
    const stat = (v) => `${Math.min(...v).toFixed(2)} – ${Math.max(...v).toFixed(2)}`;
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="sh" style="margin-top:6px">Link quality · ${samples.battery.length} samples</div>
       <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
         <div><div class="ml">Battery ${stat(samples.battery)} V</div>
           <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:70px">${sparkline(samples.battery, w, h, "#30d158")}</svg></div>
         <div><div class="ml">Trip ${stat(samples.trip_ms)} ms</div>
           <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:70px">${sparkline(samples.trip_ms, w, h, "#4d90fe")}</svg></div>
         <div><div class="ml">Packet loss ${stat(samples.loss_pct)} %</div>
           <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:70px">${sparkline(samples.loss_pct, w, h, "#ff9f0a")}</svg></div>
       </div>`
    );
  } else if (!samples.parsed) {
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="note">No telemetry from this session: <b>${escapeHtml(samples.note || "unreadable")}</b>. The event log below is unaffected.</div>`
    );
  }

  host.insertAdjacentHTML("beforeend", `<div class="sh" style="margin-top:20px">Events</div>`);
  if (!events.length) {
    host.insertAdjacentHTML("beforeend", `<div class="empty">No events recorded.</div>`);
    return;
  }

  const grid = el("div", "lg");
  for (const e of events) {
    grid.insertAdjacentHTML(
      "beforeend",
      `<div class="lt">${clock(e.t)}</div><div class="rl ${e.level}"><i></i></div><div class="le">${escapeHtml(e.text)}</div>`
    );
  }
  host.appendChild(grid);
}

/* ----------------------------------------------------------------- topics sheet */

let topicFilter = "";

function paintTopics() {
  const sheet = $("#topicSheet");
  if (!sheet.dataset.built) {
    sheet.dataset.built = "1";
    sheet.innerHTML = `
      <div class="sh">NetworkTables</div>
      <div class="pickrow"><input type="text" id="topicSearch" placeholder="filter topics…" style="min-width:280px"></div>
      <div id="topicList"></div>`;
    $("#topicSearch").oninput = (e) => { topicFilter = e.target.value.toLowerCase(); paintTopics(); };
  }
  const list = $("#topicList");
  const keys = Object.keys(nt.v).filter((k) => k.toLowerCase().includes(topicFilter)).sort();
  if (!keys.length) {
    list.innerHTML = `<div class="empty">${Object.keys(nt.v).length ? "Nothing matches that filter." : "No topics — the console is not connected to a robot."}</div>`;
    return;
  }
  list.innerHTML = keys
    .slice(0, 400)
    .map((k) => {
      const v = nt.v[k];
      const shown = v.t === "num" ? v.v.toFixed(4)
        : v.t === "bool" ? (v.v ? "true" : "false")
        : Array.isArray(v.v) ? `[${v.v.map((n) => (typeof n === "number" ? n.toFixed(2) : n)).join(", ").slice(0, 90)}]`
        : String(v.v).slice(0, 90);
      return `<div class="tr" style="grid-template-columns:1fr 70px 200px"><div class="nm"><small style="font-size:11.5px">${escapeHtml(k)}</small></div><div class="cap">${v.t}</div><div class="v" style="font-size:12px">${escapeHtml(shown)}</div></div>`;
    })
    .join("");
  if (keys.length > 400) {
    list.insertAdjacentHTML("beforeend", `<div class="empty">…and ${keys.length - 400} more. Narrow the filter.</div>`);
  }
}

/* ----------------------------------------------------------- connection history */

/* The link chip says what is true now. It says nothing about the last ten minutes, and that is the
 * question a driver who has just lost comms is actually asking — one drop at the wrong moment reads
 * very differently from the fourth in five minutes. In memory only: this is a session log, not a
 * record, and writing it to disk would make it something the console has to defend. */
const BOOT = performance.now();
const LINK_LOG_MAX = 240;
const LINK_RAIL = { up: "up", down: "down", moved: "info", demoOn: "info", demoOff: "info" };

const linkLog = [];
let linkLast = null;     // the source we last saw, or null for none
let linkLogVersion = 0;  // bumped on every entry so painters know when to rebuild

/** What the console is reading from right now, or null. */
function linkSource() {
  if (demo.on) return { key: "demo", label: "Demo data" };
  if (nt.status.connected) return { key: "robot", label: nt.status.address || "robot" };
  return null;
}

function pushLink(kind, label) {
  linkLog.push({ at: Date.now(), t: performance.now(), kind, label });
  if (linkLog.length > LINK_LOG_MAX) linkLog.shift();
  linkLogVersion++;
}

function linkText(e) {
  switch (e.kind) {
    case "up": return `Linked · ${e.label}`;
    case "down": return `Link lost · ${e.label}`;
    case "moved": return `Moved to ${e.label}`;
    case "demoOn": return "Demo data switched on";
    case "demoOff": return "Demo data switched off";
    default: return e.label || e.kind;
  }
}

/** Drops only. Switching demo data off is deliberate and is not a comms failure. */
function linkDrops() {
  let n = 0;
  for (const e of linkLog) if (e.kind === "down") n++;
  return n;
}

/* Called every paint. Edge-triggered, so the search cycling through candidate addresses while nothing
 * answers produces no entries at all — only a link that actually came up or went away does. */
function observeLink() {
  const now = linkSource();
  const prev = linkLast;
  const same = prev === now || (prev && now && prev.key === now.key && prev.label === now.label);
  if (same) return;
  linkLast = now;

  /* Same robot, new address — the console cycled from the tether to mDNS, or the other way. Worth a
   * line, because it is the difference between a flaky radio and a laptop that changed route. */
  if (prev && now && prev.key === "robot" && now.key === "robot") { pushLink("moved", now.label); return; }

  if (prev) pushLink(prev.key === "demo" ? "demoOff" : "down", prev.label);
  if (now) pushLink(now.key === "demo" ? "demoOn" : "up", now.label);
}

/* -------------------------------------------------------------------- top strip */

function paintHeader() {
  const linked = nt.status.connected || demo.on;
  app.dataset.linked = String(linked);
  /* Both gated on the link, for the same reason `stateName` below is. The lamp is a statement about
   * the robot, and with nothing on the other end there is no robot to make one about — an ungated
   * lamp went on glowing green from the last control word it saw beside the words "No robot". */
  app.dataset.live = String(linked && ds.enabled && !ds.estop);
  app.dataset.estop = String(linked && ds.estop);

  const side = alliance();
  const event = str("/FMSInfo/EventName", "");
  const match = num("/FMSInfo/MatchNumber", null);
  const where = event ? `${event}${match ? ` · Match ${match}` : ""}` : "no match";
  $("#ident").innerHTML = `Catalyst<span> · ${side ? (side === "red" ? "Red" : "Blue") : "no"} alliance · ${escapeHtml(where)}</span>`;

  $("#dLink").className = `d ${linked ? "ok" : "bad"}`;
  $("#linkText").textContent = demo.on ? "Demo" : nt.status.connected ? (nt.status.address || "Robot") : "Searching";
  $("#dDs").className = `d ${ds.dsAttached ? "ok" : ""}`;
  $("#dFms").className = `d ${ds.fms ? "ok" : ""}`;

  const loop = num("/Catalyst/Loop/Robot/AverageMs", null);
  $("#dLoop").className = `d ${loop === null ? "" : loop > 20 ? "bad" : loop > 15 ? "warn" : "ok"}`;
  $("#loopText").textContent = loop === null ? "— ms" : `${loop.toFixed(1)} ms`;
  $("#rttChip").textContent = nt.status.rtt_ms ? `RTT ${nt.status.rtt_ms.toFixed(1)} ms` : "RTT —";

  $("#stateName").textContent = linked ? ds.mode : "No robot";
  $("#stateSrc").textContent = demo.on
    ? "demo data — not a robot"
    : nt.status.connected
      ? `${ds.fms ? "FMS" : ds.dsAttached ? "Driver Station" : "no DS"} · ${nt.status.topics} topics`
      : `looking for ${nt.status.address || "a robot"}…`;

  observeLink();

  /* Quiet until it is not: no chip at all until the link has actually dropped, and then a count
   * rather than an alarm. Clicking it goes to where the whole session is written down. */
  const drops = linkDrops();
  const chip = $("#dropChip");
  chip.hidden = drops === 0;
  if (drops) chip.textContent = `${drops} link drop${drops === 1 ? "" : "s"}`;
}

/* --------------------------------------------------------------------- settings */

/* The one surface where the console can be changed, and the one where it states what it is.
 *
 * A full page rather than a dialog, because it is a mode of the instrument: you step into it, and the
 * instant anything goes live it stands down and you are back on the board. Everything that used to be
 * a modal hanging off a chip lives in here — one place to look, one place to change.
 *
 * The About section is the last one on purpose. Everything on it is either fixed prose or read live;
 * the version comes from the backend, because a number typed into the frontend is a number that will
 * eventually be wrong. */

const ABOUT_LINKS = [
  ["Repository", "github.com/TomAs-1226/CatalystConsole", "https://github.com/TomAs-1226/CatalystConsole"],
  ["Documentation", "the docs folder", "https://github.com/TomAs-1226/CatalystConsole/tree/main/docs"],
  ["FrcCatalyst", "github.com/TomAs-1226/FrcCatalyst", "https://github.com/TomAs-1226/FrcCatalyst"],
];

const SHORTCUTS = [
  [["1"], "Dashboard"],
  [["2"], "Tune"],
  [["3"], "Logs"],
  [["4"], "Topics"],
  [["S"], "Settings"],
  [["D"], "Demo data on or off"],
  [["E"], "Edit layout"],
  [["A"], "Add a component"],
  [["L"], "Settings, on the layout"],
  [["?"], "Settings, on this page"],
  [["Esc"], "Close whatever is open"],
];

let settingsRefs = null;
let currentSection = "robot";
let ntFrames = 0;
/* Probed once, on first open. Both files are optional: without them the field view falls back to a
 * drawn outline, so this is a statement of fact rather than a warning. */
const bakedAssets = { model: { state: "checking" }, map: { state: "checking" }, probed: false };

async function openExternal(url, feedback) {
  try {
    const opened = window.__TAURI__?.opener?.openUrl?.(url);
    if (opened) { await opened; return; }
  } catch { /* plugin absent, or no capability grants it */ }
  try {
    if (window.open(url, "_blank", "noopener")) return;
  } catch { /* blocked */ }
  /* Never a dead end. If nothing here can reach a browser — which is the normal case inside a webview
   * with no opener permission — hand the address over instead of doing nothing at all. */
  feedback?.((await copyText(url)) ? "address copied" : "could not open");
}

async function probeAssets() {
  if (bakedAssets.probed) return;
  bakedAssets.probed = true;
  for (const [slot, url] of [["model", "./vendor/field.glb"], ["map", "./vendor/field-collision.json"]]) {
    try {
      /* What the build actually ships, which is not the same question as what the field tile is
       * currently drawing — `paintSettings` is where the two are told apart on screen. */
      const r = await fetch(url, { method: "HEAD" });
      const size = Number(r.headers.get("content-length"));
      bakedAssets[slot] = r.ok
        ? { state: "present", size: Number.isFinite(size) && size > 0 ? size : null }
        : { state: "absent" };
    } catch {
      bakedAssets[slot] = { state: "absent" };
    }
  }
  paintSettings();
}

/* Which robot to look for.
 *
 * The team number is the one setting that is not in local storage with the rest: the backend owns it,
 * it is what the MCP server reads, and it has to outlive anything the browser side forgets. So there
 * is exactly one place to set it, and this is it. */
let teamNumber = null;

/* Mirrors candidate_addresses() in src-tauri/src/main.rs. Two copies exist because the console has to
 * be able to say what it is about to try before anything has answered — but they are the same list in
 * the same order, and the second column is why each one is in it. */
function candidateAddresses(team) {
  const known = Number.isInteger(team) && team > 0;
  return [
    ["127.0.0.1", "this machine, for simulation"],
    [`roborio-${known ? team : "TEAM"}-frc.local`, "the field's mDNS name"],
    [known ? `10.${Math.floor(team / 100)}.${team % 100}.2` : "10.TE.AM.2", "the pit's static IP"],
    ["172.22.11.2", "the USB tether"],
  ];
}

/* Rebuilt only when something in it changed: this runs on every paint, and four list items ten times
 * a second is four list items nobody asked for. */
function paintAddresses() {
  const list = $("#addrList");
  const answered = !demo.on && nt.status.connected ? nt.status.address || "" : "";
  const sig = `${teamNumber}|${answered}`;
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;

  list.innerHTML = "";
  for (const [addr, why] of candidateAddresses(teamNumber)) {
    const li = el("li");
    const hit = addr === answered;
    li.dataset.answered = String(hit);
    li.append(el("span", null, addr), el("span", "what", hit ? "answered" : why));
    list.appendChild(li);
  }
}

function setNote(id, text, tone) {
  const node = $(id);
  node.textContent = text;
  node.dataset.tone = tone || "";
}

/* The line under the team field, as the markup wrote it. Kept so a red error from last time can be
 * cleared back to it without the sentence existing twice. */
let teamNoteDefault = "";

async function refreshTeam() {
  const input = $("#setTeam");
  if (!invoke) {
    input.disabled = true;
    input.placeholder = "—";
    setNote("#teamNote", "The team number belongs to the desktop app, so it can only be set there.");
    paintAddresses();
    return;
  }
  setNote("#teamNote", teamNoteDefault);
  const n = await invoke("team_number").catch(() => null);
  if (Number.isInteger(n) && n > 0) {
    teamNumber = n;
    input.value = String(n);
  }
  paintAddresses();
}

async function applyTeam() {
  const team = Number($("#setTeam").value);
  if (!Number.isInteger(team) || team < 1 || team > 9999) {
    setNote("#teamNote", "A team number is a whole number between 1 and 9999.", "bad");
    return;
  }
  if (!invoke) return;
  try {
    await invoke("set_team_number", { team });
  } catch (e) {
    setNote("#teamNote", String(e), "bad");
    return;
  }
  teamNumber = team;
  setNote("#teamNote", `Looking for team ${team}. It applies on the next connection attempt, about a second away.`, "ok");
  paintAddresses();
}

function trailLabel(v) {
  return v === 0 ? "off" : `${v} pts`;
}

function holdLabel(ms) {
  return ms === 0 ? "no hold" : `${(ms / 1000).toFixed(1)} s`;
}

/* The moving pill, positioned by index rather than by measuring: each segment is exactly one slot
 * wide, so one slot of travel is one hundred per cent of its own width. */
function paintCamera() {
  const choice = $("#setCamera");
  const buttons = [...choice.querySelectorAll("button")];
  const i = Math.max(0, buttons.findIndex((b) => b.dataset.v === settings.fieldCamera));
  buttons.forEach((b, n) => b.setAttribute("aria-checked", String(n === i)));
  choice.querySelector(".choicesel").style.transform = `translateX(${i * 100}%)`;
}

/** Push the camera setting into every field tile that is already on the board. */
function applyFieldCamera() {
  for (const entry of live.values()) entry.state.applyCamera?.(settings.fieldCamera);
}

/**
 * Move the camera, from wherever the request came from.
 *
 * There is one camera and there are two ways to reach it — the buttons in the field tile's corner and
 * the control in Settings — so there is one function that changes it and both go through here. The
 * tile's own `applyCamera` only moves that tile; it is deliberately not what its buttons call, because
 * a tile that quietly held a camera of its own is how the two surfaces came to disagree.
 */
function setCamera(mode) {
  if (!CAMERAS.includes(mode) || mode === settings.fieldCamera) return;
  settings.fieldCamera = mode;
  saveSettings();
  paintCamera();
  applyFieldCamera();
}

function setUpdateNote(text, tone) {
  setNote("#updateNote", text, tone);
}

/* The version this build is, once the backend has said so.
 *
 * Held rather than re-read out of each answer, because a failed check is not news about the installed
 * version. `check_update` fills `current` in on every path it takes, including its own network errors;
 * only the invoke itself rejecting leaves us without one, and that says nothing about which build is
 * running. Blanking the cell there had the console reporting a local fact it already knew as unknown. */
let installedVersion = "";

/* Says what happened, in the words that are true. A check that fails on a field network is the normal
 * case and must not read as an error, because it is not one. */
function applyUpdateInfo(info) {
  const x = settingsRefs;
  if (info && info.current) installedVersion = info.current;
  const current = installedVersion;
  const label = current ? `v${current}` : "—";
  if (x) { x.version.textContent = label; x.version2.textContent = label; }

  const install = $("#installUpdate");
  install.hidden = !(info && info.available);
  if (info && info.available) install.textContent = `Install v${info.version}`;

  if (!invoke) {
    if (x) x.versionSrc.textContent = "no backend — version unknown";
    setUpdateNote("There is no backend here. The version and the update check both come from the desktop app.");
    return;
  }
  if (!info || info.error) {
    if (x) x.versionSrc.textContent = current ? "installed build" : "version unavailable";
    setUpdateNote("No answer from GitHub. On a field network that is the normal case rather than a fault — nothing about the console needs the internet.");
    return;
  }
  if (info.available) {
    if (x) x.versionSrc.textContent = `v${info.version} available`;
    setUpdateNote(`Version ${info.version} is available. Nothing installs until you press the button.`, "ok");
    return;
  }
  if (x) x.versionSrc.textContent = "installed build";
  setUpdateNote("No newer release. This is the current build.");
}

/* Wiring, done once on first open. A settings panel nobody has opened has no business asking the
 * backend anything, and the update check behind it can sit for a while on a field network. */
function buildSettings() {
  const root = $("#settings");
  settingsRefs = {};
  for (const node of root.querySelectorAll("[data-x]")) settingsRefs[node.dataset.x] = node;

  for (const nav of root.querySelectorAll(".snav")) {
    nav.onclick = () => showSection(nav.dataset.sec);
  }
  wireTablist(root.querySelector(".snavlist"));

  /* --- robot --- */
  teamNoteDefault = $("#teamNote").textContent.trim();
  $("#setTeam").onchange = applyTeam;

  /* --- field view --- */
  for (const b of $("#setCamera").querySelectorAll("button")) {
    b.onclick = () => setCamera(b.dataset.v);
  }
  /* No `paintCamera()` here. It runs once at boot instead — see the lifecycle section — so the markup
   * agrees with storage from the first frame rather than from the first time someone opens the panel. */

  const trail = $("#setTrail");
  trail.value = String(settings.fieldTrail);
  paintRange(trail);
  $("#setTrailVal").textContent = trailLabel(settings.fieldTrail);
  trail.oninput = () => {
    paintRange(trail);
    $("#setTrailVal").textContent = trailLabel(Number(trail.value));
  };
  /* On release rather than on every pixel of the drag: the trail buffer is allocated when the scene is
   * built, so this length is a rebuild, and rebuilding a three.js scene sixty times across one drag
   * would stutter the board for no gain. */
  trail.onchange = () => {
    settings.fieldTrail = clamp(Math.round(Number(trail.value)) || 0, 0, TRAIL_MAX);
    saveSettings();
    rebuildTilesOfType("field");
  };

  const model = $("#setModel");
  model.setAttribute("aria-checked", String(settings.fieldModel));
  model.onclick = () => {
    settings.fieldModel = !settings.fieldModel;
    saveSettings();
    model.setAttribute("aria-checked", String(settings.fieldModel));
    rebuildTilesOfType("field");
    paintSettings();
  };

  /* --- dashboard --- */
  const hold = $("#setAlertHold");
  hold.value = String(settings.alertHoldMs);
  paintRange(hold);
  $("#setAlertHoldVal").textContent = holdLabel(settings.alertHoldMs);
  /* Live on the drag, because nothing has to be rebuilt for it — the alert tile reads the number on
   * the next frame either way. Only the writing to storage waits for the release. */
  hold.oninput = () => {
    settings.alertHoldMs = clamp(Math.round(Number(hold.value)) || 0, 0, ALERT_HOLD_MAX);
    paintRange(hold);
    $("#setAlertHoldVal").textContent = holdLabel(settings.alertHoldMs);
  };
  hold.onchange = saveSettings;

  /* Two presses rather than a confirmation dialog. Rule two says nothing blocks the board, and a
   * button that arms itself asks the question without putting anything in front of anything. */
  const reset = $("#resetBoard");
  let armed = 0;
  const disarm = () => {
    clearTimeout(armed);
    armed = 0;
    reset.classList.remove("armed");
    reset.textContent = "Reset";
  };
  reset.onclick = () => {
    if (!armed) {
      reset.classList.add("armed");
      reset.textContent = "Press again";
      armed = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    resetBoard();
    setLayoutStatus("The board is back to the layout the console ships with.", "ok");
  };

  /* --- data --- */
  $("#setDemoTog").onclick = () => setDemo(!demo.on);

  /* --- updates --- */
  $("#checkUpdate").onclick = async () => {
    const button = $("#checkUpdate");
    button.disabled = true;
    setUpdateNote("Checking…");
    const info = await updateCheck(true);
    button.disabled = false;
    applyUpdateInfo(info);
  };

  $("#installUpdate").onclick = async () => {
    const button = $("#installUpdate");
    button.disabled = true;
    button.textContent = "Installing…";
    const failed = await invoke("install_update").catch((e) => String(e));
    if (failed) {
      button.disabled = false;
      button.textContent = "Install failed";
      setUpdateNote(String(failed), "bad");
    }
  };

  /* --- about --- */
  const keys = $("#keyList");
  keys.innerHTML = "";
  for (const [combo, what] of SHORTCUTS) {
    const dt = el("dt");
    for (const k of combo) dt.appendChild(el("kbd", null, k));
    keys.append(dt, el("dd", null, what));
  }

  const links = $("#aboutLinks");
  links.innerHTML = "";
  for (const [name, where, url] of ABOUT_LINKS) {
    const b = el("button", "alink");
    const note = el("small", null, where);
    b.append(el("span", null, name), note);
    b.onclick = () => openExternal(url, (msg) => {
      note.textContent = msg;
      setTimeout(() => { note.textContent = where; }, 2200);
    });
    links.appendChild(b);
  }

  updateCheck().then(applyUpdateInfo);
}

function showSection(name) {
  const root = $("#settings");
  if (!root.querySelector(`.ssec[data-sec="${name}"]`)) name = "robot";
  currentSection = name;
  for (const nav of root.querySelectorAll(".snav")) {
    const on = nav.dataset.sec === name;
    nav.setAttribute("aria-selected", String(on));
    nav.tabIndex = on ? 0 : -1;
  }
  for (const sec of root.querySelectorAll(".ssec")) {
    if (sec.dataset.sec === name) sec.dataset.active = "true";
    else delete sec.dataset.active;
  }
  $("#spane").scrollTop = 0;
  paintSettings();
}

function setSettings(open, section) {
  const root = $("#settings");
  if (!open) { root.dataset.open = "false"; return; }

  if (!settingsRefs) buildSettings();
  if (section) showSection(section);
  probeAssets();
  refreshTeam();
  /* A fresh open starts with an empty import box and nothing claimed about the last one. */
  setLayoutStatus("", null);
  $("#impText").value = "";
  root.dataset.open = "true";
  paintSettings();
  $("#settingsClose").focus();
}

function assetLabel(a) {
  if (a.state === "checking") return "checking…";
  if (a.state === "absent") return "not bundled";
  return a.size ? `${(a.size / 1048576).toFixed(1)} MB` : "present";
}

/* ------------------------------------------------------------------- the garage */

/* Everything the robot says about itself lands here. FrcCatalyst publishes it once at boot and
 * refreshes it on request, so a console that connects mid-match still gets the sheet. */
const SPEC_ROOT = "/Catalyst/Robot/";

const metres = (v) => `${v.toFixed(v < 1 ? 3 : 2)} m`;

/* Composite rows arrive pipe-delimited — "8|Kraken X60", "3|Climber" — because that is how the
 * library already serialises a device list. Split rather than parsed: a value containing a pipe is
 * the library's problem to prevent, not something to guess at here. */
const pairs = (key, fmt) => {
  const rows = arr(`${SPEC_ROOT}${key}`);
  return rows && rows.length ? rows.map((r) => fmt(...String(r).split("|"))).join(", ") : null;
};

/* Declarative on purpose. A spec sheet grows every season, and a table is the difference between
 * adding a line and editing a render function. Each entry returns a formatted string or null, and
 * null means the robot did not publish it — so it is left out rather than dashed. A dash would say
 * "this robot has no gyro"; absence says "it did not mention one", and only the second is true. */
const SPEC_GROUPS = [
  ["Software", [
    ["Catalyst", () => str(`${SPEC_ROOT}Software/CatalystVersion`)],
    ["Robot code", () => str(`${SPEC_ROOT}Software/RobotCodeVersion`)],
    ["WPILib", () => str(`${SPEC_ROOT}Software/WPILibVersion`)],
    ["roboRIO image", () => str(`${SPEC_ROOT}Software/RioImage`)],
  ]],
  ["Drivetrain", [
    ["Type", () => str(`${SPEC_ROOT}Drivetrain/Type`)],
    ["Modules", () => { const n = num(`${SPEC_ROOT}Drivetrain/Modules`); return n ? String(n) : null; }],
    ["Top speed", () => { const v = num(`${SPEC_ROOT}Drivetrain/MaxSpeedMps`); return v ? `${v.toFixed(2)} m/s` : null; }],
    ["Track width", () => { const v = num(`${SPEC_ROOT}Drivetrain/TrackWidthMeters`); return v ? metres(v) : null; }],
    ["Wheelbase", () => { const v = num(`${SPEC_ROOT}Drivetrain/WheelBaseMeters`); return v ? metres(v) : null; }],
    ["Wheel radius", () => { const v = num(`${SPEC_ROOT}Drivetrain/WheelRadiusMeters`); return v ? `${(v * 1000).toFixed(0)} mm` : null; }],
    ["Drive ratio", () => { const v = num(`${SPEC_ROOT}Drivetrain/DriveGearRatio`); return v ? `${v.toFixed(2)}:1` : null; }],
    ["Odometry", () => { const v = num(`${SPEC_ROOT}Drivetrain/OdometryHz`); return v ? `${v.toFixed(0)} Hz` : null; }],
  ]],
  ["Chassis", [
    ["Mass", () => { const v = num(`${SPEC_ROOT}Chassis/MassKg`); return v ? `${v.toFixed(1)} kg` : null; }],
    ["Moment", () => { const v = num(`${SPEC_ROOT}Chassis/MoiKgM2`); return v ? `${v.toFixed(2)} kg·m²` : null; }],
    ["Frame", () => {
      const l = num(`${SPEC_ROOT}Chassis/FrameLengthMeters`), w = num(`${SPEC_ROOT}Chassis/FrameWidthMeters`);
      return l && w ? `${(l * 1000).toFixed(0)} × ${(w * 1000).toFixed(0)} mm` : null;
    }],
    ["Bumper to bumper", () => {
      const l = num(`${SPEC_ROOT}Chassis/BumperLengthMeters`), w = num(`${SPEC_ROOT}Chassis/BumperWidthMeters`);
      return l && w ? `${(l * 1000).toFixed(0)} × ${(w * 1000).toFixed(0)} mm` : null;
    }],
    ["Height", () => { const v = num(`${SPEC_ROOT}Chassis/HeightMeters`); return v ? metres(v) : null; }],
  ]],
  ["Power", [
    ["Battery", () => str(`${SPEC_ROOT}Power/Battery`)],
    ["Distribution", () => str(`${SPEC_ROOT}Power/Module`)],
    ["Channels used", () => {
      const used = arr(`${SPEC_ROOT}Power/ChannelsInUse`), total = num(`${SPEC_ROOT}Power/Channels`);
      if (!used || !used.length) return null;
      return total ? `${used.length} of ${total}` : String(used.length);
    }],
    ["Brownout", () => { const v = num(`${SPEC_ROOT}Power/BrownoutVolts`); return v ? `${v.toFixed(2)} V` : null; }],
  ]],
  ["Hardware", [
    ["CAN devices", () => { const n = num(`${SPEC_ROOT}Hardware/CanDevices`); return n ? String(n) : null; }],
    ["Inventory", () => pairs("Hardware/Inventory", (type, count) => `${count} × ${type}`)],
    ["Gyro", () => str(`${SPEC_ROOT}Hardware/Gyro`)],
    ["Cameras", () => { const c = arr(`${SPEC_ROOT}Hardware/Cameras`); return c && c.length ? c.join(", ") : null; }],
  ]],
];

/* A plan of this robot, to scale, from the figures on the wire. Bumpers, frame and module positions
 * are each drawn only if the robot published them, so a partial sheet gives a partial drawing rather
 * than a confident wrong one. Nose points up, which is +x in WPILib's frame. */
function drawPlan(canvas) {
  const frameL = num(`${SPEC_ROOT}Chassis/FrameLengthMeters`);
  const frameW = num(`${SPEC_ROOT}Chassis/FrameWidthMeters`);
  const bumpL = num(`${SPEC_ROOT}Chassis/BumperLengthMeters`);
  const bumpW = num(`${SPEC_ROOT}Chassis/BumperWidthMeters`);
  const mods = arr(`${SPEC_ROOT}Drivetrain/ModuleLocations`);

  /* The module ring alone is enough to draw something true, so a team that declared no frame size
   * still gets their own wheel layout rather than nothing. */
  const span = mods && mods.length >= 2
    ? [Math.max(...mods.filter((_, i) => i % 2 === 0).map(Math.abs)) * 2,
       Math.max(...mods.filter((_, i) => i % 2 === 1).map(Math.abs)) * 2]
    : null;
  const outerL = bumpL || frameL || (span && span[0]);
  const outerW = bumpW || frameW || (span && span[1]);
  if (!outerL || !outerW) return false;

  const dpr = Math.min(devicePixelRatio || 1, 3);
  const cw = canvas.clientWidth || 300, ch = canvas.clientHeight || 210;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);

  const pad = 26;
  const scale = Math.min((cw - pad * 2) / outerW, (ch - pad * 2) / outerL);
  const cx = cw / 2, cy = ch / 2;
  /* Robot +x is forward and +y is to the left; screen y grows downward. */
  const px = (x, y) => [cx - y * scale, cy - x * scale];

  const rect = (lengthM, widthM, stroke, width, dash) => {
    const w = widthM * scale, h = lengthM * scale;
    g.save();
    g.strokeStyle = stroke; g.lineWidth = width; g.setLineDash(dash || []);
    g.beginPath();
    const r = Math.min(9, w / 6, h / 6);
    g.roundRect(cx - w / 2, cy - h / 2, w, h, r);
    g.stroke();
    g.restore();
  };

  if (bumpL && bumpW) rect(bumpL, bumpW, "rgba(233,69,96,0.5)", 2);
  if (frameL && frameW) rect(frameL, frameW, "rgba(255,255,255,0.34)", 1.5, bumpL ? [] : [5, 4]);

  if (mods && mods.length >= 2) {
    g.fillStyle = "rgba(255,255,255,0.82)";
    for (let i = 0; i + 1 < mods.length; i += 2) {
      const [sx, sy] = px(mods[i], mods[i + 1]);
      g.beginPath(); g.arc(sx, sy, 5, 0, Math.PI * 2); g.fill();
    }
  }

  /* Which way is forward, so the plan cannot be read upside down. */
  const nose = (outerL / 2) * scale;
  g.strokeStyle = "rgba(255,255,255,0.45)"; g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(cx - 7, cy - nose - 9); g.lineTo(cx, cy - nose - 16); g.lineTo(cx + 7, cy - nose - 9);
  g.stroke();
  return true;
}

function paintGarage() {
  const root = $("#garage");
  const name = str(`${SPEC_ROOT}Identity/Name`);
  root.dataset.known = String(!!name);
  if (!name) return;

  $("#gName").textContent = name;
  const team = num(`${SPEC_ROOT}Identity/TeamNumber`);
  const season = num(`${SPEC_ROOT}Identity/Season`);
  const rio = str(`${SPEC_ROOT}Identity/Controller`);
  $("#gSub").textContent = [team && `Team ${team}`, season && String(season), rio].filter(Boolean).join("  ·  ") || "";

  const plan = $("#garagePlan");
  const drew = drawPlan(plan);
  plan.parentElement.style.display = drew ? "" : "none";
  $("#gPlanNote").textContent = drew
    ? (num(`${SPEC_ROOT}Chassis/BumperLengthMeters`) ? "Bumpers, frame and modules to scale" : "Frame and modules to scale")
    : "";

  const html = [];
  for (const [title, rows] of SPEC_GROUPS) {
    const got = rows.map(([label, read]) => [label, read()]).filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (!got.length) continue;
    html.push(`<div class="ggroup"><h4>${title}</h4>${
      got.map(([label, v]) => `<div class="grow"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(v))}</b></div>`).join("")
    }</div>`);
  }
  $("#gSpecs").innerHTML = html.join("");
}

function paintSettings() {
  if (!settingsRefs || $("#settings").dataset.open !== "true") return;
  const x = settingsRefs;

  if (currentSection === "robot") { paintAddresses(); paintGarage(); }
  if (currentSection !== "about") return;

  x.dSource.textContent = demo.on
    ? "Demo data"
    : nt.status.connected
      ? nt.status.address || "robot"
      : "—";
  x.dRtt.textContent = nt.status.rtt_ms ? `${nt.status.rtt_ms.toFixed(1)} ms` : "—";
  x.dTopics.textContent = nt.status.topics ? String(nt.status.topics) : "—";
  x.dUptime.textContent = duration(performance.now() - BOOT);
  /* Real frames only. Demo ticks are not NetworkTables frames and counting them here would be the
   * console inventing a number about itself. */
  x.dFrames.textContent = ntFrames.toLocaleString();
  x.dDrops.textContent = String(linkDrops());

  for (const [slot, dot, label] of [["model", "dModelDot", "dModel"], ["map", "dMapDot", "dMap"]]) {
    const a = bakedAssets[slot];
    /* A bundled model that the setting has switched off is still bundled. Saying "not bundled" there
     * would be the diagnostics reporting a preference as a fact about the build. */
    const off = slot === "model" && !settings.fieldModel;
    x[dot].className = `d ${a.state === "checking" ? "warn" : a.state === "present" && !off ? "ok" : ""}`;
    x[label].textContent = off && a.state === "present" ? "bundled, switched off" : assetLabel(a);
  }
}

$("#settingsBtn").onclick = () => setSettings(true);
$("#settingsClose").onclick = () => setSettings(false);
/* The wordmark still goes where it always went, which is now a section rather than a page. */
$("#aboutBtn").onclick = () => setSettings(true, "about");
$("#linkChip").onclick = () => {
  setSettings(true, "robot");
  const input = $("#setTeam");
  if (!input.disabled) input.focus();
};

/* --------------------------------------------------------------------- painting */

let pendingFrame = 0;

/* The control word as of the last paint, so a transition can be spotted rather than a level. */
let lastControlWord = null;

/* Anything covering the board gets out of the way the moment the robot is enabled.
 *
 * Rule two says no modal blocks the dashboard. Opening one is a deliberate act and that is fine —
 * but a driver who opens Settings in the pit and then gets called to the field would otherwise find
 * the state lamp, the match timer and the E-stop indicator hidden behind it. Nothing the console has
 * to say about itself is worth reading at the moment a robot goes live, so everything stands down —
 * Settings included, which is what `overlayOpen` and `closeOverlays` below are for. */
/* An e-stop counts as much as an enable. Keying on the enabled bit alone meant an e-stopped robot only
 * cleared the board if the console had watched it be enabled first — and a word can arrive already
 * e-stopped, from a console started mid-match or one whose link came back into a stopped robot. The
 * E-stop indicator is named above as one of the things a panel must not be sitting on top of, so the
 * moment it has something to say is exactly the wrong moment to be covering it. */
function isLive(word) {
  return (word & BIT.enabled) !== 0 || (word & BIT.estop) !== 0;
}

function standDownOverlaysOnEnable() {
  const word = num("/FMSInfo/FMSControlData", null);
  if (word === null) { lastControlWord = null; return; }

  const wasLive = lastControlWord !== null && isLive(lastControlWord);
  const nowLive = isLive(word);
  lastControlWord = word;

  if (nowLive && !wasLive && overlayOpen()) closeOverlays();
}

function paint() {
  if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
  standDownOverlaysOnEnable();
  paintHeader();

  for (const entry of live.values()) {
    try {
      entry.spec.update(entry.body, entry.item.cfg, entry.refs, entry.tile, entry.state);
    } catch (err) {
      /* One misbehaving tile must not stop the rest of the board painting. */
      console.warn(`component ${entry.item.type} update failed`, err);
    }
  }

  const active = activeView();
  if (active === "topics") paintTopics();
  if (active === "logs") tickLinkHistory();
  paintSettings();
}

/* Coalesce bursts of NT frames into one paint. `paint` clears the handle itself, so the heartbeat
 * below can pre-empt a pending frame rather than waiting on it. */
function schedulePaint() {
  if (pendingFrame) return;
  pendingFrame = requestAnimationFrame(() => { pendingFrame = 0; paint(); });
}

function onFrame() {
  for (const key of tracked) {
    const v = num(key, null);
    if (v === null) continue;
    let buf = hist.get(key);
    if (!buf) { buf = []; hist.set(key, buf); }
    buf.push(v);
    if (buf.length > HIST_LEN) buf.shift();
  }
  ds.word = num("/FMSInfo/FMSControlData", 0) | 0;
  if (nt.keysDirty) {
    nt.keysDirty = false;
    refreshTopicList();
  }
  schedulePaint();
}

/* The datalist behind every topic field in the config modal, so picking a motor is a matter of typing
 * three letters rather than remembering a path. */
function refreshTopicList() {
  let list = $("#ntkeys");
  if (!list) {
    list = el("datalist");
    list.id = "ntkeys";
    document.body.appendChild(list);
  }
  const keys = Object.keys(nt.v).sort();
  if (list.childElementCount === keys.length) return;
  list.innerHTML = keys.map((k) => `<option value="${escapeHtml(k)}"></option>`).join("");
}

/* -------------------------------------------------------------------- lifecycle */

/* The camera control is markup with a default baked into it — Chase checked, the pill at zero — and
 * `settings.fieldCamera` comes out of storage, so the two start out able to disagree. Painting it here
 * makes them agree from the first frame.
 *
 * It used to be painted by `buildSettings`, which is only reached the first time the panel is opened.
 * That was never visible, but only because `setSettings` happens to build before it sets `data-open`,
 * and a panel nobody has opened is a panel nobody is looking at. Both of those are true today and
 * neither is a property anyone is holding on purpose: the first is the order of two statements, the
 * second stops being true the moment something reads the tree without a person in front of it. What
 * makes the markup right is that the setting was established, and that is here.
 *
 * `setCamera` keeps it right afterwards, from either surface. */
paintCamera();

layout = loadLayout();

/* Braces as well as belt. `loadLayout` is where a bad tile is supposed to stop and it is the check
 * that matters — but this call sits at module scope, so anything that ever did get past it would not
 * merely lose a tile, it would abort the rest of this file. The heartbeat below would never start, the
 * keydown listener would never be installed, `MODALS` would stay in its temporal dead zone so the
 * stand-down throws on the first paint, and the driver would be left with an empty board that still
 * opens Settings and looks perfectly healthy. Nothing a component can do to itself is worth that, so
 * the first build is allowed to fail and the console comes up on the layout it ships with.
 *
 * Storage is left exactly as it was: the board that could not be built is still the board someone
 * arranged, and overwriting it here would take away their only chance of getting it back. */
try {
  buildBoard();
} catch (err) {
  console.error("the saved board could not be built; falling back to the default layout", err);
  layout = DEFAULT_LAYOUT.map((c) => ({ ...c }));
  try {
    buildBoard();
  } catch (fatal) {
    console.error("the default layout failed too; the board is empty, the console is not", fatal);
  }
}

let pushedFrames = 0;
/* Whether the last frame came in over a live link, so the moment one goes away can be spotted. */
let wasConnected = false;

function applyFrame(frame) {
  if (!frame || demo.on) return; // an explicit demo must not be overwritten by a real robot mid-look
  ntFrames++;
  const before = Object.keys(nt.v).length;
  const connected = !!frame.status?.connected;

  /* The link went away, so everything it published went with it. The backend keeps its last values on
   * a dropped socket — it only clears `connected` — so a frame from a dead link still arrives full of
   * the robot that was there, and merging it forward left the store holding an enabled control word, a
   * battery voltage and a pose, every one of them read as current. That is rule three by the back
   * door: a stale number presented as a live one. Dropped rather than dimmed, so each tile falls back
   * to the dash it already has for absent data. The rolling history is left alone — what a graph
   * recorded did happen. */
  if (connected) Object.assign(nt.v, frame.values);
  else if (wasConnected) nt.v = Object.create(null);
  wasConnected = connected;

  nt.status = frame.status;
  if (Object.keys(nt.v).length !== before) nt.keysDirty = true;
  onFrame();
}

if (listen) {
  listen("nt", (event) => {
    pushedFrames++;
    applyFrame(event.payload);
  });
}

if (invoke) {
  /* The backend pushes frames; this is the safety net. If nothing has arrived a couple of seconds
   * after launch then the push path is not working, so we pull instead. A dashboard that silently
   * stops updating is the one failure this app cannot have — cheap insurance against it. */
  setTimeout(() => {
    if (pushedFrames > 0) return;
    console.warn("no pushed frames arrived; falling back to polling");
    setInterval(() => {
      if (demo.on) return;
      invoke("nt_frame").then(applyFrame).catch(() => {});
    }, 50);
  }, 2000);
} else if (!listen) {
  /* Opened in a plain browser rather than the app: everything still renders, nothing connects. */
  $("#stateSrc").textContent = "no backend — open the desktop app";
}

/* A 10 Hz heartbeat, so clocks and the stopwatch move while the robot is quiet.
 *
 * It calls `paint` directly rather than going through `requestAnimationFrame`, and that is the point:
 * Chromium stops firing rAF for a window it considers hidden, and it considers a *fully occluded*
 * window hidden. Park the Driver Station on top of the console and an rAF-only dashboard freezes with
 * stale numbers on screen — which is precisely the failure this app must not have. Ten small DOM
 * updates a second cost nothing; the expensive part is the 3D view, and that keeps its own guard. */
setInterval(paint, 100);

/* -------------------------------------------------------------------- keyboard */

/* A driver station is operated under pressure, often one-handed, often without looking down. So every
 * binding is a single unmodified key — and that is exactly why the typing guard is not optional: a
 * bare "d" must never toggle demo data while someone is halfway through typing a topic path. */

const MODALS = ["#pickModal", "#cfgModal"];

function typingInField(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}

function settingsOpen() {
  return $("#settings").dataset.open === "true";
}

function overlayOpen() {
  if (settingsOpen()) return true;
  return MODALS.some((id) => $(id).dataset.open === "true");
}

function closeOverlays() {
  if (settingsOpen()) setSettings(false);
  /* Through its own close button, not by hiding the element: that button is what saves the edited
   * config and rebuilds the board, and skipping it left the board out of step with the settings. */
  if ($("#cfgModal").dataset.open === "true") $("#cfgClose").click();
  $("#pickModal").dataset.open = "false";
}

/* Null prototype: a lookup by key name must never find `constructor` or `toString` and call it. */
const KEYS = Object.assign(Object.create(null), {
  1: () => showView("board"),
  2: () => showView("tune"),
  3: () => showView("logs"),
  4: () => showView("topics"),
  d: () => setDemo(!demo.on),
  e: () => $("#editBtn").click(),
  a: () => openPicker(),
  s: () => setSettings(true),
  /* Both of these used to open a modal of their own. They still land where they always did — the
   * layout on one, the product on the other — which is now a section rather than a destination. */
  l: () => setSettings(true, "dashboard"),
  "?": () => setSettings(true, "about"),
  F1: () => setSettings(true, "about"),
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    /* Escape inside a field means "abandon what I am typing", not "throw the dialog away". Closing
     * the layout modal blanks the paste box, so a stray Escape after pasting a board someone sent you
     * used to destroy it. Blur first; a second Escape then closes, because by then the field is no
     * longer focused. */
    if (typingInField(e.target)) { e.target.blur(); e.preventDefault(); return; }
    if (overlayOpen()) { closeOverlays(); e.preventDefault(); }
    return;
  }
  /* Leave the browser's and the window manager's own combinations alone. */
  if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
  if (typingInField(e.target)) return;

  /* With something open, the only useful keys are the ones that close it or toggle it. Switching the
   * view behind a panel you cannot see is not a shortcut, it is a surprise. */
  if (overlayOpen()) {
    const toggle = e.key === "?" || e.key === "F1" || (settingsOpen() && e.key.toLowerCase() === "s");
    if (toggle) { closeOverlays(); e.preventDefault(); }
    return;
  }

  const action = KEYS[e.key] || (e.key.length === 1 ? KEYS[e.key.toLowerCase()] : null);
  if (!action) return;
  e.preventDefault();
  action();
});

$("#dropChip").onclick = () => showView("logs");

window.addEventListener("resize", schedulePaint);
