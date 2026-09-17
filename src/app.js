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

import * as coreFmt from "./core-format.js";
import * as canModel from "./can-model.js";
import { clampToField, countState, deviceSummary, drivePath, notices as computeNotices, robotPlacement } from "./devices.js";
/* The house motion module, copied verbatim from FrcCatalyst's docs and never edited here. CSS covers
   every transition in this program; this is the one thing it cannot do — answer a press at the point
   it was pressed. */
import { stateLayer } from "./motion.js";
/* How the board words a large figure and a topic path's segment; its own module so the rules can be
   tested without a DOM. */
import { compactFigure, spacedLabel } from "./board-format.js";
import { AUTO_S, hubPlan, inactiveFirst, segmentAt, TELEOP_SEGMENTS } from "./hub.js";
import { createHopper, hasMechanisms, readMechanisms } from "./mechanisms.js";

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
/* The demo match and the whole cycle it repeats on, in seconds. */
const DEMO_MATCH_S = 160;
const DEMO_CYCLE_S = 200;

function demoTick() {
  const t = (performance.now() - demo.t0) / 1000;
  /* A REBUILT match on repeat: 20 s auto, then teleop counting 140 down to 0, then forty seconds
   * disabled on the field before the next one, which is long enough to watch the board park and the
   * drive be written up. */
  const cycle = t % DEMO_CYCLE_S;
  const auto = cycle < 20;
  const enabled = cycle < DEMO_MATCH_S;
  const matchT = auto ? 20 - cycle : Math.max(0, DEMO_MATCH_S - cycle);
  /* The clock anything that moves runs on. It stops where the match left the robot. */
  const tm = enabled ? t : t - (cycle - DEMO_MATCH_S);
  const moving = enabled ? 1 : 0;
  /* The battery sags under load and drains through the match, recovers a little once the robot is
   * disabled, and is swapped for a charged one before the next match. */
  const volts = enabled
    ? 12.7 - 0.85 * Math.abs(Math.sin(t * 1.3)) - cycle * 0.002
    : 12.64 - DEMO_MATCH_S * 0.002 + 0.1 * (1 - Math.exp(-(cycle - DEMO_MATCH_S) / 10));
  const set = (k, tag, v) => { nt.v[k] = { t: tag, v }; };

  set("/FMSInfo/FMSControlData", "num", (enabled ? BIT.enabled : 0) | BIT.ds | BIT.fms | (auto ? BIT.auto : 0));
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
  set("/Catalyst/Drive/FrontLeft/Velocity", "num", moving * drive / 60);
  set("/Catalyst/Drive/FrontRight/Velocity", "num", moving * (drive + 120) / 60);
  set("/Catalyst/Drive/BackLeft/Velocity", "num", moving * (drive - 90) / 60);
  set("/Catalyst/Drive/BackRight/Velocity", "num", moving * (drive + 40) / 60);
  set("/Catalyst/Shooter/Velocity", "num", moving * (4900 + 700 * Math.sin(t * 0.6)) / 60);
  set("/Catalyst/Loop/Robot/AverageMs", "num", 6.4 + 1.6 * Math.abs(Math.sin(t * 3)));
  set("/Catalyst/Status/CanUtilization", "num", 0.42 + 0.09 * Math.sin(t * 0.9));
  set("/Catalyst/Brownout/MeasuredVoltage", "num", volts);

  set("/Catalyst/Physics/Slip/Factor", "num", moving * Math.max(0, 0.42 * Math.sin(t * 2.1)));
  set("/Catalyst/Physics/TippingUsage", "num", moving * (0.29 + 0.16 * Math.sin(t * 0.8)));
  set("/Catalyst/Physics/TractionUsage", "num", moving * (0.5 + 0.35 * Math.abs(Math.sin(t * 1.9))));
  set("/Catalyst/Physics/Quality/Confidence", "num", 0.86 + 0.09 * Math.sin(t * 0.4));

  const radius = 2.4;
  set("/Catalyst/Physics/PoseArray", "nums", [
    8.2 + radius * Math.cos(tm * 0.42),
    4.1 + radius * Math.sin(tm * 0.42) * 0.7,
    (tm * 0.42 + Math.PI / 2) % (Math.PI * 2),
  ]);

  /* Systemcore, as a machine in good order under load.
   *
   * Deliberately not a perfect machine. The processor and temperature move with the drivetrain
   * because that is what they do on a robot, the eMMC is a season and a half in rather than fresh,
   * and can_s0 carries the drivetrain while can_s2 carries the mechanisms - a plan the CAN page
   * approves of, so the demo shows the layout worth copying rather than the one worth warning
   * about. Nobody should have to connect a robot to find out whether this page works. */
  const load = enabled ? 0.5 + 0.5 * Math.abs(Math.sin(t * 0.7)) : 0.2;
  set("/Catalyst/Systemcore/CpuPercent", "num", 22 + 34 * load);
  set("/Catalyst/Systemcore/TempCelsius", "num", 46 + 12 * load);
  set("/Catalyst/Systemcore/RamFraction", "num", 0.31 + 0.05 * Math.sin(t * 0.3));
  set("/Catalyst/Systemcore/RamUsedBytes", "num", 2.6e9);
  set("/Catalyst/Systemcore/RamTotalBytes", "num", 8.0e9);
  set("/Catalyst/Systemcore/StorageFraction", "num", 0.47);
  set("/Catalyst/Systemcore/StorageUsedBytes", "num", 15.0e9);
  set("/Catalyst/Systemcore/StorageTotalBytes", "num", 32.0e9);
  set("/Catalyst/Systemcore/BatteryVolts", "num", volts);
  set("/Catalyst/Systemcore/BrownedOut", "bool", false);
  set("/Catalyst/Systemcore/BrownoutVolts", "num", 6.75);
  set("/Catalyst/Systemcore/RecoveryVolts", "num", 7.5);
  set("/Catalyst/Systemcore/Rail3v3Amps", "num", 0.38 + 0.06 * Math.sin(t * 1.1));
  set("/Catalyst/Systemcore/CanUtilization", "nums", [
    0.38 + 0.10 * Math.sin(t * 0.9), 0, 0.14 + 0.04 * Math.sin(t * 1.4), 0, 0,
  ]);
  set("/Catalyst/Systemcore/CanDown", "bool", false);
  set("/Catalyst/Systemcore/CanDownCount", "num", 0);
  set("/Catalyst/Systemcore/CanUnavailCount", "num", 0);
  set("/Catalyst/Systemcore/EmmcLifeUsed", "num", 0.15);
  set("/Catalyst/Systemcore/EmmcPreEol", "num", 1);
  set("/Catalyst/Systemcore/TeamNumber", "num", 5805);
  set("/Catalyst/Systemcore/HardwareSubRev", "num", 2);
  set("/Catalyst/Systemcore/NetworkInterfaces", "strs", ["eth0", "wlan0"]);

  /* What is on each wire, in CANRegistry's own format — bus|canId|type|name. This is the plan the
     paragraph above describes, written out: the drivetrain together on can_s0, the mechanisms on
     can_s2 which shares its controller with nothing, and a CANivore carrying the two devices that
     came with a bought mechanism. Twelve on can_s0 is the most a bus takes before the CAN page
     objects, so the demo sits right against the line rather than comfortably inside it — the point
     of the page is that the line is where it is, and a layout nowhere near it demonstrates nothing. */
  set("/Catalyst/CAN/Devices", "strs", [
    "can_s0|1|Kraken X60|Front left drive", "can_s0|2|Kraken X60|Front left steer",
    "can_s0|3|CANcoder|Front left encoder",
    "can_s0|4|Kraken X60|Front right drive", "can_s0|5|Kraken X60|Front right steer",
    "can_s0|6|CANcoder|Front right encoder",
    "can_s0|7|Kraken X60|Back left drive", "can_s0|8|Kraken X60|Back left steer",
    "can_s0|9|CANcoder|Back left encoder",
    "can_s0|10|Kraken X60|Back right drive", "can_s0|11|Kraken X60|Back right steer",
    "can_s0|12|CANcoder|Back right encoder",
    "can_s2|20|Pigeon 2|Gyro", "can_s2|21|Kraken X60|Shooter left",
    "can_s2|22|Kraken X60|Shooter right", "can_s2|23|Kraken X60|Feeder",
    "canivore|30|Kraken X60|Elevator", "canivore|31|CANcoder|Elevator encoder",
  ]);
  /* Phoenix's view of the CANivore. The OS array cannot reach it — it covers the Systemcore's own
     five buses and nothing else — so this is the one bus on the demo robot whose reading the page
     attributes to Phoenix rather than to the OS, which is the distinction it is there to make. */
  set("/Catalyst/CAN/Health/canivore/OK", "bool", true);
  set("/Catalyst/CAN/Health/canivore/Utilization", "num", 0.11 + 0.03 * Math.sin(t * 1.1));
  set("/Catalyst/CAN/Health/canivore/BusOffCount", "num", 0);
  set("/Catalyst/CAN/Health/canivore/TxFullCount", "num", 0);
  set("/Catalyst/CAN/Health/canivore/REC", "num", 0);
  set("/Catalyst/CAN/Health/canivore/TEC", "num", 0);

  /* The mechanisms, under the names team 5805's REBUILT robot publishes them (see mechanisms.js), and on
   * the same lap the robot drives: it intakes along one side of its loop with the intake slid out, stows
   * and spins up coming round, then shoots across the far side with the hood tracking. Each mechanism
   * answers its goal the way a real one does, with a lag rather than a jump, so the hood swings and the
   * flywheel winds up and down on screen as they would on the robot. */
  {
    const now = performance.now();
    const m = demo.mech ?? (demo.mech = { at: now, hood: 13, shooter: 12.5, deploy: 5 });
    const dt = Math.min(0.25, Math.max(0, (now - m.at) / 1000));
    m.at = now;
    const lap = (((tm * 0.42) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const phase = !enabled ? "idle" : lap < 2.2 ? "intake" : lap < 2.9 ? "prepare" : lap < 4.7 ? "score" : "idle";
    const follow = (value, goal, seconds) => goal + (value - goal) * Math.exp(-dt / seconds);
    const hoodGoal = phase === "prepare" || phase === "score" ? 27 + 7 * Math.sin(tm * 0.9) : 13;
    const shooterGoal = phase === "prepare" || phase === "score" ? 1600 / 60 : enabled ? 750 / 60 : 0;
    const deployGoal = phase === "intake" ? 11.8 : phase === "score" && lap > 3.4 ? 5 : enabled ? 11.8 : 5;
    m.hood = follow(m.hood, hoodGoal, 0.12);
    m.shooter = follow(m.shooter, shooterGoal, 0.35);
    m.deploy = follow(m.deploy, deployGoal, 0.18);
    set("/Catalyst/Hood/AngleDegrees", "num", m.hood);
    set("/Catalyst/Hood/GoalAngle", "num", hoodGoal);
    set("/Catalyst/Deploy/Homed", "bool", true);
    set("/Catalyst/Deploy/LengthInches", "num", m.deploy);
    set("/Catalyst/Deploy/GoalInches", "num", deployGoal);
    set("/Catalyst/Intake/Speed", "num", phase === "intake" ? 1 : phase === "score" ? 5 / 12 : 0);
    set("/Catalyst/Conveyor/Speed", "num", phase === "score" ? 10 / 12 : phase === "intake" ? 1 / 12 : 0);
    set("/Catalyst/Feeder/Speed", "num", phase === "score" ? 10 / 12 : phase === "intake" ? -1 / 12 : 0);
    set("/Catalyst/Shooter/VelocityRPS", "num", m.shooter);
    set("/Catalyst/Shooter/SetpointRPS", "num", shooterGoal);
    set("/Catalyst/Shooter/AtSpeed", "bool", Math.abs(m.shooter - shooterGoal) < 1);
    set("/Catalyst/RobotManager/State", "str",
      phase === "prepare" ? "PREPARE_SCORE" : phase === "score" ? "SCORE" : "IDLE");
    set("/Catalyst/HopperManager/State", "str",
      phase === "intake" ? "INTAKING" : phase === "score" ? "SCORE" : enabled ? "IDLE_DEPLOYED" : "IDLE_STOWED");
    set("/Catalyst/HopperManager/IsFull", "bool", false);
  }

  /* Deliberately no /Catalyst/Game/Tower* here: the hub tile should be seen deriving the schedule
   * from the rules and the FMS game data, which is what it does on a real field. */

  /* The demo robot's spec sheet, in the shape FrcCatalyst 2.x publishes on Systemcore. Named so nobody mistakes
   * it for their own: a team looking at the garage before they have adopted the library should be
   * able to see what it will show them, and should be in no doubt that this is not their robot.
   * Deliberately an incomplete sheet — no camera list, no drive ratio — because that is the ordinary
   * case, and the panel leaving those lines out is the behaviour worth demonstrating. */
  set("/Catalyst/Robot/Identity/Name", "str", "Demo robot");
  set("/Catalyst/Robot/Identity/TeamNumber", "num", 0);
  set("/Catalyst/Robot/Identity/Season", "num", 2027);
  set("/Catalyst/Robot/Identity/Controller", "str", "Systemcore");
  set("/Catalyst/Robot/Software/CatalystVersion", "str", "2.0.0-alpha.2");
  set("/Catalyst/Robot/Software/WPILibVersion", "str", "2027.0.0-alpha-6");
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
  /* Systemcore's own default, not the roboRIO's 6.8 V. The device publishes this and Catalyst
   * reads it rather than carrying a constant. */
  set("/Catalyst/Robot/Power/BrownoutVolts", "num", 6.75);
  set("/Catalyst/Robot/Hardware/CanDevices", "num", 11);
  set("/Catalyst/Robot/Hardware/Inventory", "strs", ["Kraken X60|8", "CANcoder|4", "Pigeon 2|1"]);
  set("/Catalyst/Robot/Hardware/Devices", "strs", [
    "canivore|1|Kraken X60", "canivore|2|Kraken X60", "canivore|3|CANcoder",
    "canivore|4|Kraken X60", "canivore|5|Kraken X60", "canivore|6|CANcoder",
    "canivore|7|Kraken X60", "canivore|8|Kraken X60", "canivore|9|CANcoder",
    "canivore|10|Kraken X60", "canivore|11|Kraken X60", "canivore|12|CANcoder",
    "can_s0|20|Kraken X60", "can_s0|30|Pigeon 2",
  ]);
  set("/Catalyst/Robot/Hardware/Gyro", "str", "Pigeon 2");
  /* What the demo robot is made to do. A real robot's list is written by the library as each piece
   * is constructed, so it is exactly as long as the robot is capable — this one is set out by hand
   * to show a sheet with something in every group. */
  set("/Catalyst/Robot/Catalyst/InUse", "strs",
    ["Autopilot", "Goal Director", "Physics Core", "Sequence", "Strategist"]);
  set("/Catalyst/Robot/Catalyst/Autopilot/Names", "strs", ["Cycle"]);
  set("/Catalyst/Robot/Catalyst/GoalDirector/Names", "strs", ["Stow"]);
  set("/Catalyst/Robot/Catalyst/PhysicsCore/Names", "strs", ["BALANCED"]);
  set("/Catalyst/Robot/Catalyst/Sequence/Names", "strs", ["ThreePiece", "LeaveAndShoot"]);
  set("/Catalyst/Robot/Catalyst/Strategist/Names", "strs", ["CoPilot"]);

  set("/Catalyst/Alerts/Errors", "strs", []);
  set("/Catalyst/Alerts/Warnings", "strs",
    num("/Catalyst/Brownout/MeasuredVoltage") < 11.8 ? ["[Power] Battery sagging under load"] : []);
  set("/Catalyst/Alerts/Info", "strs", ["Demo data — not a real robot"]);

  /* The device roster, vision health and the auto start check, so the corner strip, the notice bar
     and the cameras card have something to show. The left camera drops out for eight seconds in
     every thirty-two, which is what a loose cable looks like from the driver's seat. */
  const leftDown = t % 32 >= 12 && t % 32 < 20;
  set("/Catalyst/Devices/Cameras/Expected", "num", 4);
  set("/Catalyst/Devices/Cameras/Connected", "num", leftDown ? 3 : 4);
  set("/Catalyst/Devices/Cameras/Rows", "strs", [
    "limelight-shooter|true|Limelight", `limelight-left|${!leftDown}|Limelight`,
    "limelight-right|true|Limelight", "limelight-ground|true|Limelight"]);
  set("/Catalyst/Devices/Motors/Expected", "num", 20);
  set("/Catalyst/Devices/Motors/Connected", "num", 20);
  set("/Catalyst/Devices/Motors/Rows", "strs", [
    "frontLeftDrive|can_s0|1|true", "frontLeftSteer|can_s0|2|true", "frontRightDrive|can_s0|3|true",
    "frontRightSteer|can_s0|4|true", "backLeftDrive|can_s0|5|true", "backLeftSteer|can_s0|6|true",
    "backRightDrive|can_s0|7|true", "backRightSteer|can_s0|8|true", "shooterLead|can_s2|11|true",
    "shooterFollower12|can_s2|12|true", "intake|can_s2|13|true", "feeder|can_s2|14|true",
    "elevatorLead|can_s3|21|true", "elevatorFollower22|can_s3|22|true", "arm|can_s3|23|true",
    "wrist|can_s3|24|true", "climberLead|can_s4|31|true", "climberFollower32|can_s4|32|true",
    "hopper|can_s4|33|true", "indexer|can_s4|34|true"]);
  set("/Catalyst/Devices/Controller/Kind", "str", "Systemcore");
  set("/Catalyst/Devices/Controller/Connected", "bool", true);
  set("/Catalyst/Vision/Health/Level", "num", leftDown ? 1 : 0);
  set("/Catalyst/Vision/Health/Summary", "str",
    leftDown ? "3 of 4 cameras healthy: limelight-left disconnected" : "all 4 cameras healthy");
  set("/Catalyst/Vision/Health/Rows", "strs", [
    `limelight-shooter|OK|100% accepted|56.0|${(70 + 3 * Math.sin(t * 0.2)).toFixed(1)}|true`,
    leftDown ? "limelight-left|DISCONNECTED|no data from the camera|||false"
             : "limelight-left|OK|97% accepted|55.0|68.0|true",
    "limelight-right|NO_TARGETS|no usable target|57.0|66.0|true",
    "limelight-ground|OK|91% accepted|54.0|71.0|true"]);
  /* PathPlanner's path while the demo robot follows one: the next few seconds of the loop it drives, in
   * auto as a planned path, and for a stretch of teleop with an Autopilot engaged, so both ways of
   * drawing a plan can be seen. Empty otherwise, as PathPlanner leaves it between paths. */
  const autopiloting = enabled && cycle >= 70 && cycle < 105;
  const pathAhead = [];
  if (enabled && (auto || autopiloting)) {
    const ahead = auto ? 4.5 : 3.2;
    for (let s = 0; s <= ahead + 1e-9; s += 0.1) {
      const u = (tm + s) * 0.42;
      pathAhead.push(8.2 + radius * Math.cos(u), 4.1 + radius * Math.sin(u) * 0.7, (u + Math.PI / 2) % (Math.PI * 2));
    }
  }
  set("/PathPlanner/activePath", "nums", pathAhead);
  set("/Catalyst/Behavior/Cycle/Phase", "str", autopiloting ? (Math.floor(cycle / 12) % 2 ? "Score" : "Acquire") : "DriverControl");

  const demoX = 8.2 + radius * Math.cos(tm * 0.42);
  const demoY = 4.1 + radius * Math.sin(tm * 0.42) * 0.7;
  const fromStart = Math.hypot(demoX - 10.6, demoY - 4.1);
  set("/Catalyst/Auto/StartCheck/Available", "bool", true);
  set("/Catalyst/Auto/StartCheck/Ready", "bool", fromStart < 0.3);
  set("/Catalyst/Auto/StartCheck/DistanceMeters", "num", fromStart);
  set("/Catalyst/Auto/StartCheck/HeadingErrorDeg", "num", 6 * Math.sin(t * 0.3));

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

  set("/Auto Selector/options", "strs",
    ["Do nothing", "Leave line", "Two piece centre", "Three piece amp side"]);
  if (!has("/Auto Selector/selected")) {
    set("/Auto Selector/selected", "str", "Two piece centre");
    set("/Auto Selector/active", "str", "Two piece centre");
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
  // Minus signs in the shape of the reading they stand in for, m:ss, the way a clock that has not been
  // set shows it. A minus is drawn on the figures' centre line, where the colon between them sits.
  // Every other mark tried read wrong at 52px in the light display face: em dashes are long hairlines,
  // hyphens sit at lowercase height below the colon, and the mono em dash that draws a large reading's
  // lone placeholder (see "Catalyst Readout Dash" in styles.css) fuses with its neighbour into a bar.
  if (seconds === null || seconds === undefined) return "−:−−";
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

/**
 * The path a set of topics share, whole segments only: `/Catalyst/Drive` for the four module
 * velocities. Empty when they share nothing but the root, which the caller words around.
 */
function commonPrefix(keys) {
  const parts = keys.map((k) => String(k).split("/").filter(Boolean));
  if (!parts.length) return "";
  const shared = [];
  for (let i = 0; i < parts[0].length; i++) {
    const seg = parts[0][i];
    if (!parts.every((p) => p.length > i + 1 && p[i] === seg)) break;
    shared.push(seg);
  }
  return shared.length ? "/" + shared.join("/") : "";
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

/**
 * The design tokens, for the marks this file draws rather than styles.
 *
 * Everything styled in CSS reads --cat-* directly. These few are SVG presentation attributes built
 * into template strings - sparkline strokes, gauge arcs - and canvas fills in the robot plan, and
 * neither can be a custom property in every renderer.
 *
 * They used to be a hand-copied list of hexes under a comment asking the next person to keep them in
 * step with `:root`. They are read from `:root` now, so there is nothing left to keep in step: this
 * is the same mirror, held up to the stylesheet instead of transcribed from it. Before that they
 * were an older palette entirely (#30d158, #ff9f0a, #ff453a, #4d90fe), which put two different
 * greens on the same dashboard - one meaning "healthy" in a tile heading and another meaning
 * "healthy" in the sparkline right beneath it. A transcription drifts; a reading cannot.
 *
 * Read once, not per use. The stylesheets are render-blocking and in <head>, so the values are there
 * by the time a module in <body> evaluates; the console has one world and never switches theme; and
 * getComputedStyle forces style resolution, which has no business running inside a 10 Hz paint.
 */
function readTokens(props) {
  const style = getComputedStyle(document.documentElement);
  const out = {};
  for (const [name, prop] of Object.entries(props)) out[name] = style.getPropertyValue(prop).trim();
  return out;
}

/** Semantic only - never decorative - plus the three inks a mark is labelled and ruled with. */
const TOK = readTokens({
  ok: "--cat-ok",
  warn: "--cat-warn",
  bad: "--cat-bad",
  info: "--cat-info",
  dim: "--cat-muted",
  faint: "--cat-faint",
  rule: "--cat-hair-str",
  // A magnitude rather than a state: the trace under a reading that is behaving. It has to be
  // neutral, because painting data in --cat-ok spends the colour that is supposed to mean healthy.
  data: "--cat-data",
});

/* The robot plan's materials: the machine Park draws, seen from above, so its shell, deck and tyres
   are named under the garage in styles.css (`--plan-*`) rather than taken from the drawn marks the
   field scene lights its own robot with. `light` and `shade` arrive as bare channels so a ramp can set
   its own alpha without a token per stop. */
const PLAN = readTokens({
  shell: "--plan-shell",
  shellLit: "--plan-shell-lit",
  deck: "--plan-deck",
  deckDark: "--plan-deck-dark",
  tyre: "--draw-tyre",
  tyreLit: "--draw-tyre-lit",
  light: "--draw-light",
  shade: "--draw-shade",
});
const lightAt = (alpha) => `rgb(${PLAN.light} / ${alpha})`;
const shadeAt = (alpha) => `rgb(${PLAN.shade} / ${alpha})`;

/* A rolling trace, drawn the way Tesla draws its energy graph: a thin line, a wash under it that is
 * gone well before the floor, and a light on the newest sample so the eye lands where the reading is.
 *
 * The trace keeps clear of the box's edges - a peak drawn against the top edge had half its stroke cut
 * off, and a graph filled from edge to edge read as the heaviest thing on the board. The stroke does
 * not scale with the box, so a trace stretched across a wide panel is as fine as one in a tile.
 * `dot` is for a box drawn at its own pixel size; stretched, a circle would become an ellipse. */
function sparkline(values, w, h, color, { dot = false } = {}) {
  if (values.length < 2) return "";
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 1e-9) { hi = lo + 1; }
  const top = Math.max(4, h * 0.14);
  const bottom = Math.max(2, h * 0.06);
  const right = dot ? 6 : 0;
  const step = (w - right) / (values.length - 1);
  const y = (v) => top + (1 - (v - lo) / (hi - lo)) * Math.max(1, h - top - bottom);
  let d = `M0 ${y(values[0]).toFixed(1)}`;
  for (let i = 1; i < values.length; i++) d += `L${(i * step).toFixed(1)} ${y(values[i]).toFixed(1)}`;
  const endX = (w - right).toFixed(1);
  const endY = y(values[values.length - 1]).toFixed(1);
  const fill = `${d}L${endX} ${h}L0 ${h}Z`;
  // The wash only says which side of the line is "under". One gradient per colour, named by the
  // colour: it is in the fill's own box, so every sparkline of that colour can share the definition,
  // and a duplicate one is harmless.
  const id = `spark-${String(color).replace(/[^a-z0-9]/gi, "")}`;
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${color}" stop-opacity="0.08"/><stop offset="0.75" stop-color="${color}" stop-opacity="0"/>`
    + `</linearGradient></defs>`
    + `<path d="${fill}" fill="url(#${id})"/>`
    + `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
    + (dot
      ? `<circle cx="${endX}" cy="${endY}" r="5.5" fill="${color}" fill-opacity="0.16"/><circle cx="${endX}" cy="${endY}" r="2.75" fill="${color}"/>`
      : "");
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

/* Order is load-bearing: the number keys index into this. Declared up here rather than beside
 * `showView` because `loadSettings` validates the opening view against it and runs first. */
/* CAN goes on the end rather than beside the dashboard it belongs next to, because the position is
 * the shortcut: 1–4 are keys drivers already have in their hands and renumbering them to make room
 * would be a worse trade than a fifth key in the wrong place. */
const VIEWS = ["board", "tune", "logs", "topics", "can"];
const UNITS = ["metric", "imperial"];

const SETTINGS_DEFAULTS = {
  fieldCamera: "chase",
  fieldTrail: 220,
  fieldModel: true,
  alertHoldMs: 2500,
  /* Metric by default because that is what the robot publishes and what WPILib works in, so it is
   * the only setting here that involves no conversion and therefore no rounding. Teams who measure
   * their frame in inches can say so. */
  units: "metric",
  startView: "board",
  /* Park is on unless someone turns it off: it is what the screen looks like while nothing is moving. */
  parkView: true,
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
    if (UNITS.includes(saved.units)) s.units = saved.units;
    if (VIEWS.includes(saved.startView)) s.startView = saved.startView;
    if (typeof saved.parkView === "boolean") s.parkView = saved.parkView;
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
        <div><span class="n" data-x="time" style="--size:52px;--fit:46cqh">${clock(null)}</span></div>
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
      ? segmentAt(t)?.name ?? null
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

/* --- hub activation ---------------------------------------------------------- */

/* REBUILT switches each alliance's HUB on and off through teleop, and the schedule lives in hub.js: the
 * segments from the game manual, the FMS game data that decides the alternation, and a countdown to the
 * moment this alliance's hub really changes.
 *
 * The tile is read from across a drive station in the middle of a match, so the state is the tile: the
 * whole card turns green while the hub scores and stays dark while it does not, the word says Active or
 * Inactive as large as the tile allows, and the countdown under it names what comes next. Amber is kept
 * for the last few seconds before a change and for nothing else. The strip along the bottom is the rest
 * of the match for this alliance - green where the hub scores - so the next change is visible before it
 * is counted down. */

/* Auto and the six teleop segments, as parts of the strip in proportion to how long each runs. */
const HUB_STRIP = [{ name: "Auto", from: AUTO_S, to: 0 }, ...TELEOP_SEGMENTS];

define("tower", {
  name: "Hub activation",
  group: "Match",
  desc: "Whether your alliance HUB is scoring now, how long until that changes, and the rest of the match",
  w: 3, h: 2,
  tileClass: "tower",
  config: [
    { key: "activeKey", label: "Active topic", type: "topic", def: "/Catalyst/Game/TowerActive",
      hint: "Optional override. A boolean the robot publishes: true while YOUR hub is active. Leave it and the console works the schedule out from FMS." },
    { key: "countdownKey", label: "Countdown topic", type: "topic", def: "/Catalyst/Game/TowerSeconds",
      hint: "Optional override: seconds until the state flips." },
    { key: "warn", label: "Warn at", type: "number", def: 5,
      hint: "Seconds before a change when the countdown turns amber." },
  ],
  render(body) {
    body.innerHTML = `
      <div class="fill hub">
        <div class="hub-now"><i class="hub-lamp" aria-hidden="true"></i><span class="hub-word" data-x="word">No match</span></div>
        <div class="hub-next"><span class="n" data-x="count"></span><span class="u" data-x="unit">s</span><span class="hub-then" data-x="then"></span></div>
        <div class="hub-strip" aria-hidden="true">${HUB_STRIP.map((s) => `<i style="flex-grow:${s.from - s.to}"></i>`).join("")}</div>
        <div class="cap hub-src" data-x="src">waiting for robot</div>
      </div>`;
  },
  update(body, cfg, x, tile, state) {
    const side = alliance();
    const sub = tile.querySelector(":scope > .h > .s");
    if (sub) setText(sub, side ? `${side === "red" ? "Red" : "Blue"} hub` : "No alliance");

    const t = matchTime();
    const plan = hubPlan({
      t, auto: ds.auto, enabled: ds.enabled, side,
      first: inactiveFirst(str("/FMSInfo/GameSpecificMessage", "")),
    });

    /* A robot that publishes its own answer wins - it may know something we do not. Its countdown is
     * taken to run to its own next change; the schedule's is only borrowed when the two agree on now. */
    let { active, left, until } = plan;
    let next = plan.next?.active ?? null;
    let source = null;
    const robotActive = cfg.activeKey ? bool(cfg.activeKey, null) : null;
    const robotLeft = cfg.countdownKey ? num(cfg.countdownKey, null) : null;
    if (robotActive !== null || robotLeft !== null) {
      source = "From the robot";
      if (robotActive !== null && robotActive !== plan.active) {
        active = robotActive;
        left = null;
        until = null;
      }
      if (robotLeft !== null) {
        left = Math.max(0, robotLeft);
        until = active === null ? "segment" : "change";
        next = active === null ? null : !active;
      }
    }

    const hub = active === true ? "on" : active === false ? "off" : "none";
    const soon = until === "change" && left !== null && left <= cfg.warn;
    setFlag(tile, "hub", hub);
    setFlag(tile, "soon", soon);

    /* The moment it changes, the card says so once: a ring of the new state's colour that fades as the
     * countdown starts again. Only for a change during a match - not for the tile being built, and not
     * for a robot coming or going. */
    if (state.hub && state.hub !== hub && state.hub !== "none" && hub !== "none" && !reducedMotion()) {
      const ring = hub === "on" ? "rgba(48, 209, 88, 0.95)" : "rgba(235, 235, 240, 0.7)";
      tile.animate(
        [{ boxShadow: `inset 0 0 0 3px ${ring}` }, { boxShadow: "inset 0 0 0 3px rgba(0, 0, 0, 0)" }],
        { duration: 1400, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
    state.hub = hub;

    setText(x.word, active === true ? "Active" : active === false ? "Inactive"
      : plan.period === "none" && !source ? "No match" : "Waiting");

    /* What comes next, with its countdown. With nothing to count - auto, or no match - the row keeps
     * its height so the card does not jump when the countdown arrives. */
    let then = "";
    if (left !== null) {
      setText(x.count, left.toFixed(1));
      then = until === "end" ? "to the end"
        : until === "change" ? (next ? "until active" : "until inactive")
        : `until ${plan.next?.name ?? "the next shift"}`;
    } else {
      setText(x.count, "");
      then = plan.period === "auto" ? "Both hubs score in auto" : "";
    }
    setFlag(x.unit, "hidden", left === null);
    setText(x.then, then);

    if (source === null) {
      const segment = plan.segment;
      source = plan.period === "auto" ? "Auto"
        : plan.period === "none" ? (t === null ? "No match clock from the robot" : "No match in progress")
        : segment.both ? `${segment.name} · both hubs`
        : active !== null ? `${segment.name} · FMS`
        : side ? `${segment.name} · waiting for FMS` : `${segment.name} · no alliance`;
    }
    setText(x.src, source);

    /* The strip: auto, then teleop, each part green where this alliance's hub scores and dimmed once it
     * has run. The part the match is in shows how far through it is. */
    const parts = body.querySelector(".hub-strip").children;
    const period = plan.period;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const segment = i === 0 ? null : plan.plan[i - 1];
      const on = i === 0 ? true : segment.active;
      const done = period === "none" ? 0 : i === 0 ? plan.autoDone : period === "auto" ? 0 : segment.done;
      const now = period === "auto" ? i === 0 : period === "teleop" && i === plan.index + 1;
      setFlag(part, "state", period === "none" ? "idle" : on === true ? "on" : on === false ? "off" : "unknown");
      setFlag(part, "now", now);
      setFlag(part, "past", !now && done >= 1);
      const fill = now ? `${(done * 100).toFixed(1)}%` : "";
      if (part.style.getPropertyValue("--done") !== fill) {
        if (fill) part.style.setProperty("--done", fill);
        else part.style.removeProperty("--done");
      }
    }
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
    { key: "figures", label: "Large figures", type: "select", def: "short",
      options: [["short", "Short, as 2.4k"], ["full", "In full, as 2400"]],
      hint: "Short writes a figure of a thousand or more with one decimal and a k. The whole value is in the gauge's tooltip either way." },
  ],
  render(body, cfg) {
    body.innerHTML = `<div class="gaugewrap" data-x="wrap"></div><div class="cap gauge-cap" data-x="cap" hidden></div>`;
    for (const key of String(cfg.topic).split(",").map((s) => s.trim()).filter(Boolean)) track(key);
  },
  update(body, cfg, x) {
    const keys = String(cfg.topic).split(",").map((s) => s.trim()).filter(Boolean);
    const wrap = x.wrap;

    if (wrap.childElementCount !== keys.length) {
      wrap.innerHTML = "";
      /* How many rings share the row, which the stylesheet sizes each one by. */
      wrap.style.setProperty("--n", String(Math.max(1, keys.length)));
      for (const k of keys) {
        const g = el("div", "gauge");
        g.dataset.key = k;
        wrap.appendChild(g);
      }
    }

    const span = Math.max(1e-6, cfg.max - cfg.min);
    const single = keys.length === 1;
    const labels = single ? [cfg.unit || ""] : distinctLabels(keys).map(spacedLabel);

    // Rings of dashes say nothing about why. When not one of the topics has a value, the tile says
    // what it is waiting for; as soon as any arrives the caption goes, because a gauge showing three
    // readings and a dash is reporting one missing topic, and the dash says that on its own.
    const waiting = keys.every((k) => num(k, null) === null);
    x.cap.hidden = !waiting;
    if (waiting) {
      x.cap.textContent = keys.length === 1
        ? `waiting for the robot to publish ${keys[0]}`
        : `waiting for the robot to publish ${keys.length} topics under ${commonPrefix(keys) || "these paths"}`;
    }

    keys.forEach((key, i) => {
      const g = wrap.children[i];
      const rawVal = num(key, null);
      const value = rawVal === null ? null : rawVal * (cfg.scale || 1);
      const frac = value === null ? 0 : clamp01((value - cfg.min) / span);
      const hot = value !== null && value >= cfg.redline;
      // A speed is a quantity, so its arc takes the quantity colour, and the redline is the one thing
      // that turns it red.
      const color = hot ? "var(--crit)" : "var(--cat-data)";
      const label = labels[i];
      /* A motor speed reads 2.4k rather than 2400, the way Tesla writes a large figure, unless the tile
       * is set to write figures in full. The whole value, its unit and the topic are in the tooltip. */
      const places = Math.max(0, cfg.decimals | 0);
      const text = value === null ? "—" : cfg.figures === "full" ? value.toFixed(places) : compactFigure(value, places);
      const tip = `${value === null ? "no reading" : `${value.toFixed(places)}${cfg.unit ? ` ${cfg.unit}` : ""}`} · ${key}`;
      if (g.title !== tip) g.title = tip;

      if (cfg.style === "number") {
        g.innerHTML =
          `<div class="gv ${hot ? "crit" : ""}" style="--size:${single ? 46 : 26}px">${text}</div>` +
          `<div class="gl">${label}</div>`;
        return;
      }

      if (cfg.style === "bar") {
        g.innerHTML =
          `<div class="gv ${hot ? "crit" : ""}" style="--size:${single ? 32 : 20}px">${text}</div>` +
          `<div class="track" style="width:100%;margin:9px 0 4px"><i style="width:${frac * 100}%;background:${color}"></i></div>` +
          `<div class="gl">${label}</div>`;
        return;
      }

      /* Drawn in its own units and sized by the stylesheet to the room the tile has (`.gaugewrap
       * .gauge svg`), so everything in it - the ring, the needle, the figure - grows with the tile
       * together. The ring is a little finer than it was at a fixed 92 px, since it is drawn larger. */
      const size = single ? 128 : 92;
      const ring = single ? 8 : 6.5;
      const r = size / 2 - 8;
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
        `<svg viewBox="0 0 ${size} ${size * 0.82}">` +
        `<path d="${arcPath(cx, cy, r, a0, a0 + sweep)}" fill="none" stroke="var(--tile-3)" stroke-width="${ring}" stroke-linecap="round"/>` +
        (frac > 0.002 && cfg.style === "arc"
          ? `<path d="${arcPath(cx, cy, r, a0, a1)}" fill="none" stroke="${color}" stroke-width="${ring}" stroke-linecap="round"/>`
          : "") +
        needle +
        // Styled by class rather than by attributes: a presentation attribute cannot take var(), so
        // `font-family="var(--mono)"` had never applied, and the stylesheet is where the readout face
        // - and its placeholder dash - is defined for every other large reading.
        `<text class="gv${hot ? " crit" : ""}" x="${cx}" y="${cy + (single ? 9 : 7)}" text-anchor="middle" fill="${value === null ? TOK.faint : "currentColor"}" font-size="${single ? 28 : 20}">${text}</text>` +
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
        <div><span class="n" data-x="v" style="--size:40px">—</span><span class="u">V</span></div>
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
    // A reading is white, as every graph on the board is. A low pack is the figure's and the header's
    // to say; a trace that turned amber with it was a second, much larger patch of the same colour.
    x.spark.innerHTML = sparkline(h.slice(-160), w, ht, TOK.data, { dot: true });

    if (h.length > 3) {
      const recent = h.slice(-160);
      const lo = Math.min(...recent), hi = Math.max(...recent);
      // Each figure keeps its unit, and in a narrow tile the two halves take a line each rather than
      // breaking inside one (see `.capgrp` in styles.css).
      x.cap.innerHTML = `<span class="capgrp">sag <b>${(hi - lo).toFixed(2)} V</b></span>`
        + `<span class="capsep"> · </span><span class="capgrp">low <b>${lo.toFixed(2)} V</b></span>`;
    }
  },
});

/* --- systemcore -------------------------------------------------------------- */

define("systemcore", {
  name: "Systemcore",
  group: "Health",
  desc: "What the control system reports about itself: CPU, memory, storage, brownout",
  w: 3, h: 2,
  config: [
    { key: "warn", label: "Warn above (%)", type: "number", def: 80 },
    { key: "crit", label: "Critical above (%)", type: "number", def: 90 },
  ],
  render(body) {
    // Systemcore measures its own CPU, RAM, storage and power and publishes them on its system
    // NetworkTables server; Catalyst mirrors them under /Catalyst/Systemcore/ so they arrive on the
    // same connection as everything else. A roboRIO reported almost none of this, which is why a
    // robot that browned out because logs filled the disk used to fail pointing at nothing.
    ["CpuPercent", "RamFraction", "StorageFraction", "BatteryVolts", "BrownedOut"]
      .forEach((k) => track("/Catalyst/Systemcore/" + k));
    body.innerHTML = `
      <div class="fill">
        <div class="row"><span class="k">CPU</span><span class="n" data-x="cpu">—</span><span class="u">%</span></div>
        <div class="row"><span class="k">RAM</span><span class="n" data-x="ram">—</span><span class="u">%</span></div>
        <div class="row"><span class="k">Disk</span><span class="n" data-x="disk">—</span><span class="u">%</span></div>
        <div class="cap" data-x="cap">waiting for Systemcore</div>
      </div>`;
  },
  update(body, cfg, x) {
    const pct = (key, scale) => {
      const v = num("/Catalyst/Systemcore/" + key, null);
      return v === null ? null : v * scale;
    };
    const paint = (el, v) => {
      el.textContent = v === null ? "—" : v.toFixed(0);
      el.className = `n ${v === null ? "" : v >= cfg.crit ? "crit" : v >= cfg.warn ? "warn" : "ok"}`;
    };

    const cpu = pct("CpuPercent", 1);
    const ram = pct("RamFraction", 100);
    const disk = pct("StorageFraction", 100);
    paint(x.cpu, cpu);
    paint(x.ram, ram);
    paint(x.disk, disk);

    if (cpu === null && ram === null && disk === null) {
      // Absent rather than zero. Off Systemcore there is no system server, and reporting 0% would
      // read as a very healthy machine rather than as no machine.
      x.cap.textContent = "no Systemcore detected — simulation, or a roboRIO";
      return;
    }
    const volts = num("/Catalyst/Systemcore/BatteryVolts", null);
    const brownedOut = bool("/Catalyst/Systemcore/BrownedOut", false);
    x.cap.innerHTML = brownedOut
      ? `<b class="crit">BROWNED OUT</b>${volts === null ? "" : ` at ${volts.toFixed(2)} V`}`
      : (volts === null ? "healthy" : `battery <b>${volts.toFixed(2)} V</b>`);
  },
});

/* --- autonomy 2.0 ------------------------------------------------------------- */

/* The robot's reasoning, as the autonomy layer publishes it. Every one of these keys is a decision
   that used to happen invisibly inside a lambda: which tasks won and which were held and why, what
   the chaser is going after, which limiter is holding the robot back, what was shed to stay inside
   the power budget, and what the intention system guessed. */
define("autonomy", {
  name: "Autonomy 2.0",
  group: "Health",
  desc: "What the robot decided this loop, and why it did not do the other things",
  w: 4, h: 3,
  config: [
    { key: "showIntent", label: "Show intention guess", type: "select", def: "yes",
      options: [["yes", "Yes"], ["no", "No"]] },
  ],
  render(body) {
    ["Situation/Valid", "Situation/Confidence", "Situation/Slip", "Situation/BusVolts",
     "Situation/Headroom", "Situation/Binding",
     "Tasks/Running", "Tasks/Held", "Tasks/Explain",
     "Chase/Target", "Chase/Why",
     "Authority/Scale", "Authority/Binding", "Authority/Explain",
     "Power/Deficit", "Power/Shed", "Power/Short", "Power/Explain",
     "Intent/Guess", "Intent/HitRate", "Intent/Samples", "Intent/Explain",
    ].forEach((k) => track("/Catalyst/Autonomy/" + k));
    body.innerHTML = `
      <div class="fill au-fill">
        <div class="au-authority">
          <div class="au-scale"><span class="n" data-x="scale">—</span><span class="u">%</span></div>
          <div class="au-track"><i data-x="bar"></i></div>
          <div class="cap" data-x="authWhy">waiting for the robot</div>
        </div>
        <div class="au-row"><span class="k">Running</span><span data-x="running">—</span></div>
        <div class="au-row"><span class="k">Held</span><span class="dim" data-x="held">—</span></div>
        <div class="au-row"><span class="k">Chasing</span><span data-x="chase">—</span></div>
        <div class="au-row" data-x="powerRow"><span class="k">Power</span><span data-x="power">—</span></div>
        <div class="au-row" data-x="intentRow"><span class="k">Intent</span><span data-x="intent">—</span></div>
      </div>`;
  },
  update(body, cfg, x) {
    const K = "/Catalyst/Autonomy/";

    /* Authority is the number a driver asks about when the robot "feels slow", so it gets the
       headline and the reason underneath it rather than a bare percentage. */
    const scale = num(K + "Authority/Scale", null);
    if (scale === null) {
      x.scale.textContent = "—";
      x.bar.style.width = "0%";
      x.authWhy.textContent = has(K + "Tasks/Running")
        ? "no authority published"
        : "waiting for the robot \u2014 needs an AutonomyBoard publishing";
    } else {
      const pct = clamp01(scale) * 100;
      x.scale.textContent = pct.toFixed(0);
      x.scale.className = `n ${pct < 50 ? "crit" : pct < 90 ? "warn" : "ok"}`;
      x.bar.style.width = `${pct.toFixed(0)}%`;
      x.bar.style.background = pct < 50 ? "var(--crit)" : pct < 90 ? "var(--warn)" : "var(--cat-data)";
      x.authWhy.textContent = str(K + "Authority/Explain", "no limits");
    }

    x.running.textContent = str(K + "Tasks/Running", "\u2014");
    x.held.textContent = str(K + "Tasks/Held", "\u2014");

    const target = str(K + "Chase/Target", null);
    x.chase.textContent = target === null ? "\u2014"
      : target === "(none)" ? "nothing worth chasing" : `${target} \u00b7 ${str(K + "Chase/Why", "")}`;

    /* Power only appears once something is actually measuring it. An unmeasured robot showing
       "0 A shed" reads as healthy, and that is the exact confusion this schema avoids. */
    const shedExplain = str(K + "Power/Explain", null);
    x.powerRow.hidden = shedExplain === null;
    if (shedExplain !== null) {
      const short = num(K + "Power/Short", 0);
      x.power.textContent = shedExplain;
      x.power.className = short > 0 ? "warn" : "";
    }

    const showIntent = cfg.showIntent !== "no";
    const intentExplain = str(K + "Intent/Explain", null);
    x.intentRow.hidden = !showIntent || intentExplain === null;
    if (showIntent && intentExplain !== null) {
      x.intent.textContent = intentExplain;
    }
  },
});

/* --- motor history ------------------------------------------------------------ */

define("motorhistory", {
  name: "Motor history",
  group: "Health",
  desc: "Every motor's lifetime hours, revolutions, peaks and boots, by serial number",
  w: 6, h: 3,
  config: [
    { key: "sort", label: "Sort by", type: "select", def: "powered",
      options: [["powered", "Powered hours"], ["running", "Turning hours"], ["hot", "Hot time"],
                ["peakTemp", "Peak temperature"], ["peakAmps", "Peak current"], ["revolutions", "Revolutions"],
                ["boots", "Boots"]] },
    { key: "rows", label: "Motors shown", type: "number", def: 12 },
    { key: "hot", label: "Hot from (\u00b0C)", type: "number", def: 70,
      hint: "Peak temperatures at or above this are marked. Falcons protect themselves in the 90s." },
  ],
  render(body) {
    ["Rows", "Summary", "Count", "ClockTrusted", "Discovery"].forEach((k) => track("/Catalyst/MotorHistory/" + k));
    body.innerHTML = `
      <div class="fill mh-fill">
        <div class="cap mh-summary" data-x="summary">waiting for the robot's motor history</div>
        <div class="mhist" data-x="table"></div>
      </div>`;
  },
  update(body, cfg, x) {
    const rows = arr("/Catalyst/MotorHistory/Rows");
    if (!rows.length) {
      const why = str("/Catalyst/MotorHistory/Discovery", "");
      x.summary.textContent = has("/Catalyst/MotorHistory/Count")
        ? (why && why !== "ok" ? `no motors on record yet \u2014 diagnostic server: ${why}` : "no motors on record yet")
        : "waiting for the robot's motor history \u2014 needs FrcCatalyst 2.0.0-alpha.2-a9 or later";
      setHtml(x.table, "");
      return;
    }
    const summary = str("/Catalyst/MotorHistory/Summary", "");
    const clock = bool("/Catalyst/MotorHistory/ClockTrusted", true);
    x.summary.textContent = summary + (clock ? "" : " \u00b7 robot clock not set, dates are relative");
    /* Re-render only when the rows change: this table is text, and NT sends the array again every
       two seconds whether or not anything moved. */
    const sig = rows.join("\n") + cfg.sort + cfg.rows + cfg.hot;
    if (x.table.dataset.sig === sig) return;
    x.table.dataset.sig = sig;
    setHtml(x.table, motorTableHtml(motorRowsFromNt(rows), cfg.sort, Math.max(1, cfg.rows | 0), cfg.hot));
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
    x.bar.style.background = frac > 1 ? "var(--crit)" : frac > 0.75 ? "var(--warn)" : "var(--cat-data)";
    x.cap.innerHTML = loop === null
      ? "waiting for the robot to publish loop time"
      : `<b>${((1 - frac) * 100).toFixed(0)}%</b> of the ${cfg.budget} ms budget spare`;
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
    // Traction in use is a quantity until it is nearly all used. It was the signal colour, which on
    // this board is also the fault colour, so a healthy 60% drew a bar that looked like a fault.
    x.bar.style.background = frac > 0.95 ? "var(--warn)" : "var(--cat-data)";
    // With nothing at all from Physics Core, "advisory only" under three dashes reads as a tile that
    // is working and quiet. It is waiting, and it says for what.
    // "Advisory only" is the part a narrow tile lets go of (`.capopt`): it is true of every reading
    // here and said again in the palette, where the confidence is only said here.
    x.cap.innerHTML = slip === null && tip === null && trac === null && conf === null
      ? "waiting for Physics Core on the robot<span class=\"capopt\"> · advisory only</span>"
      : conf === null
        ? "advisory only — never gates control"
        : `<span class="capgrp">estimator confidence <b>${(conf * 100).toFixed(0)}%</b></span><span class="capopt"> · advisory only</span>`;
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
        <div><span class="n" data-x="mag" style="--size:30px">—</span><span class="u">m/s²</span></div>
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
    // Catalyst 2.x publishes this as ModuleVelocities, following WPILib's rename of
    // SwerveModuleState to SwerveModuleVelocity. It also still publishes ModuleStates as a
    // deprecated alias through the 2027 season, so a saved layout pointing at the old path keeps
    // working - but new layouts should use the accurate name.
    { key: "topic", label: "Module velocities topic", type: "topic", def: "/Catalyst/Drive/ModuleVelocities",
      hint: "A number array of [angleRad, speedMps] per module, four modules. Catalyst 1.x published this at /Catalyst/Drive/ModuleStates." },
    { key: "max", label: "Max speed (m/s)", type: "number", def: 5.0 },
  ],
  render(body) {
    body.innerHTML = `<div class="fill"><svg data-x="svg" viewBox="0 0 120 120" style="width:100%;height:100%;max-height:none"></svg><div class="cap" data-x="cap" hidden></div></div>`;
  },
  update(body, cfg, x) {
    const states = arr(cfg.topic);
    const spots = [[34, 34], [86, 34], [34, 86], [86, 86]];

    // Said in the tile's own caption, like every other tile waiting on a topic. Drawn inside the
    // drawing it was eight units tall in a hundred-and-twenty-unit viewBox, which on a two-row tile
    // came out smaller than any text on the board, and it did not say which topic it was waiting for.
    const waiting = !Array.isArray(states) || states.length < 8;
    x.svg.style.display = waiting ? "none" : "";
    x.cap.hidden = !waiting;
    if (waiting) {
      x.cap.textContent = `waiting for the robot to publish ${cfg.topic}`;
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
      const colour = frac > 0.92 ? TOK.bad : frac > 0.7 ? TOK.warn : TOK.data;
      out +=
        `<circle cx="${cx}" cy="${cy}" r="18" fill="none" stroke="${TOK.rule}" stroke-width="3"/>` +
        `<line x1="${cx}" y1="${cy}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + dy).toFixed(1)}" stroke="${colour}" stroke-width="3.5" stroke-linecap="round"/>` +
        `<text x="${cx}" y="${cy + 30}" text-anchor="middle" fill="${TOK.dim}" font-size="7.5" font-family="var(--mono)">${speed.toFixed(1)}</text>`;
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
    { key: "base", label: "Chooser path", type: "topic", def: "/Auto Selector" },
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
    body.innerHTML = `<div class="fill"><div><span class="n" data-x="v" style="--size:30px;--fit:70cqh">—</span><span class="u" data-x="u"></span></div></div>`;
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
        <div><span class="n" data-x="v" style="--size:26px">—</span></div>
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
    x.spark.innerHTML = sparkline(h, w, ht, TOK.data, { dot: true });
    if (h.length > 2) {
      // The sample count is the first thing a narrow tile lets go of (`.capopt`).
      x.cap.innerHTML = `<span class="capgrp">min <b>${Math.min(...h).toFixed(2)}</b></span> · `
        + `<span class="capgrp">max <b>${Math.max(...h).toFixed(2)}</b></span>`
        + `<span class="capopt"> · ${h.length} samples</span>`;
    } else if (v === null) {
      // An empty plot under a dash is the tile that most looks broken, so it is the one that most
      // needs to say it is only waiting, and for which topic.
      x.cap.textContent = `waiting for the robot to publish ${cfg.topic}`;
    } else {
      x.cap.textContent = "collecting samples…";
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
        <div><span class="n" data-x="v" style="--size:36px">0.00</span><span class="u">s</span></div>
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
    { key: "text", label: "Text", type: "lines", def: "Check bumper numbers\nRadio power\nBattery > 12.4 V" },
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
    /* Tesla's car panel, for a robot: the speed large at the top left with its unit under it, the
     * pose as the small line of figures Tesla sets beneath, the scene filling the panel, and the
     * camera choices as round buttons floating at the right edge the way Tesla floats its map
     * controls. The label goes to the foot of the panel as a quiet credit, where Tesla's map puts
     * its attribution. */
    body.innerHTML = `
      <canvas class="fieldcanvas" data-x="canvas"></canvas>
      <div class="car-head">
        <div class="car-speed-row">
          <div class="car-power" title="Speed against the drivetrain's top speed"><i data-x="power"></i></div>
          <div class="car-speed"><span class="n" data-x="speed">—</span><span class="car-unit">m/s</span></div>
          <div class="car-signs">
            <div class="car-limit" data-x="limit" hidden title="The drivetrain's top speed"><small>Top</small><b data-x="limitN">—</b></div>
            <div class="car-ap" data-x="ap" data-on="false" hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="2.2"/><path d="M3.6 10.6c2.6-.9 5.4-1.2 8.4-1.2s5.8.3 8.4 1.2M10.2 13.8 7 19.6M13.8 13.8 17 19.6"/></svg>
            </div>
          </div>
        </div>
        <div class="car-stats">
          <span>x <b data-x="fx">—</b> m</span>
          <span>y <b data-x="fy">—</b> m</span>
          <span>θ <b data-x="ft">—</b>°</span>
        </div>
        <div class="fc off" data-x="foff" hidden>drawn at the wall</div>
        <div class="fc place" data-x="fplace" hidden></div>
      </div>
      <div class="fieldlab">Field</div>
      <div class="fieldbtns" role="group" aria-label="Camera">
        <button class="fbtn" data-mode="chase" title="Chase" aria-label="Chase camera">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="4" width="8" height="10" rx="2"/><path d="M5 20l3-4h8l3 4"/></svg>
        </button>
        <button class="fbtn" data-mode="top" title="Overhead" aria-label="Overhead camera">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2.5"/><rect x="9.5" y="9" width="5" height="6" rx="1"/></svg>
        </button>
        <button class="fbtn" data-mode="free" title="Free" aria-label="Free camera">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="12" rx="9" ry="3.6"/><path d="M18 7.5l2.2 1.3-1 2.3"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>
        </button>
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
    const linked = nt.status.connected || demo.on;
    /* Where the robot is: the estimator once it has left the corner it boots in, a live Limelight fix
       before that, and not placed at all when there is neither, rather than drawn in that corner. */
    const place = robotPlacement(ntView, { poseKey: cfg.poseKey, length: cfg.length, width: cfg.width, age: poseAge });
    const pose = place.pose;
    const valid = Boolean(pose);
    x.fx.textContent = valid ? pose[0].toFixed(2) : "—";
    x.fy.textContent = valid ? pose[1].toFixed(2) : "—";
    x.ft.textContent = valid ? ((pose[2] * 180) / Math.PI).toFixed(0) : "—";

    /* The speed Tesla puts at the top of its panel, taken from how far the estimated pose moved since
     * the last paint. Smoothed, because a pose estimator's step-to-step noise divided by a 100ms
     * interval would make the figure flicker at rest; a pose that stops arriving reads as the robot
     * stopping, which is also what it is from here. */
    const now = performance.now();
    if (valid) {
      const last = state.lastPose;
      if (last && now > last.t) {
        const step = Math.hypot(pose[0] - last.x, pose[1] - last.y) / ((now - last.t) / 1000);
        // A teleport - a reset pose, an alliance flip - is not a speed.
        const instant = step > 8 ? state.speed ?? 0 : step;
        state.speed = (state.speed ?? instant) * 0.7 + instant * 0.3;
      }
      state.lastPose = { x: pose[0], y: pose[1], t: now };
    } else {
      state.lastPose = null;
      state.speed = null;
    }
    x.speed.textContent = state.speed == null ? "—" : state.speed < 0.05 ? "0.0" : state.speed.toFixed(1);
    x.speed.dataset.empty = String(state.speed == null);
    // Tesla's power meter, the line beside the speed: how much of the drivetrain's top speed is in use.
    const topSpeed = num("/Catalyst/Robot/Drivetrain/MaxSpeedMps", null);
    const top = topSpeed || 4.5;
    x.power.style.height = `${(clamp01((state.speed ?? 0) / top) * 100).toFixed(1)}%`;

    /* Beside the speed, the two signs Tesla keeps there. The speed-limit sign is the drivetrain's own top
     * speed, shown only when the robot publishes one. The wheel is Autopilot's: grey while a routine is
     * chosen and waiting, blue while autonomous is actually driving. */
    const limitText = topSpeed ? topSpeed.toFixed(1) : "";
    if (x.limit.hidden !== !topSpeed) x.limit.hidden = !topSpeed;
    if (x.limitN.textContent !== limitText) x.limitN.textContent = limitText;
    const routines = linked ? (arr("/Auto Selector/options") || []) : [];
    const driving = linked && ds.enabled && ds.auto && !ds.estop;
    const routine = str("/Auto Selector/active", null) ?? str("/Auto Selector/selected", null);
    if (x.ap.hidden !== !(driving || routines.length)) x.ap.hidden = !(driving || routines.length);
    if (x.ap.dataset.on !== String(driving)) x.ap.dataset.on = String(driving);
    const apTitle = `Autonomous ${driving ? "driving" : "ready"}${routine ? `: ${routine}` : ""}`;
    if (x.ap.title !== apTitle) x.ap.title = apTitle;
    /* The readouts are the estimator's numbers wherever they are. The drawing is held inside the
       walls: a robot rendered through a wall, or off the slab entirely, tells the driver nothing
       that the chip does not say better. */
    const drawn = valid ? clampToField(pose, cfg.length, cfg.width) : null;
    x.foff.hidden = !(drawn && drawn.clamped);
    /* Said under the figures whenever the position is not the estimator's own: where a vision fix is
       standing in for it, and when there is nothing to place the robot with at all. */
    const placeText = !linked ? ""
      : !place.placed ? "Not placed yet · waiting for a Limelight fix"
      : place.source === "vision" ? `Placed by ${place.camera} · ${place.tags} tag${place.tags === 1 ? "" : "s"}`
      : "";
    if (x.fplace.textContent !== placeText) x.fplace.textContent = placeText;
    if (x.fplace.hidden !== !placeText) x.fplace.hidden = !placeText;
    state.scene?.update({
      pose: drawn ? [drawn.x, drawn.y, drawn.theta] : null,
      placed: linked ? place.placed : null,
      heading: place.heading,
      alliance: alliance(),
      enabled: linked && ds.enabled,
      /* The path ahead while the robot drives: PathPlanner's or a team planner's, improvised while an
         Autopilot has the robot (see drivePath). The field view adds where its motion is heading. */
      path: linked && ds.enabled ? drivePath(ntView, { length: cfg.length, width: cfg.width }) : null,
      /* The same robot the Park stage draws: its size from the spec sheet, its number on the bumpers. */
      spec: linked ? parkRobotSpec() : {},
      team: parkTeam(linked),
      /* Its mechanisms, and how many balls have left the shooter (see trackMechanisms). */
      mechanisms: linked ? mechanismState.now : null,
      fired: mechanismState.fired,
      hopper: mechanismState.hopper.fill,
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

/* Tesla's arrangement: the car panel down the whole left third, and the cards to its right where
 * Tesla opens its apps over the map. The field is a tile like any other and can still be moved or
 * removed; this is only where a new board starts. */
const DEFAULT_LAYOUT = [
  { type: "field", x: 0, y: 0, w: 4, h: 8 },
  { type: "match", x: 4, y: 0, w: 3, h: 2 },
  { type: "tower", x: 7, y: 0, w: 2, h: 2 },
  { type: "health", x: 9, y: 0, w: 3, h: 2 },
  { type: "gauge", x: 4, y: 2, w: 5, h: 3,
    cfg: { topic: "/Catalyst/Drive/FrontLeft/Velocity,/Catalyst/Drive/FrontRight/Velocity,/Catalyst/Drive/BackLeft/Velocity,/Catalyst/Drive/BackRight/Velocity",
           title: "Drive", style: "arc", unit: "RPM", scale: 60, min: 0, max: 6000, redline: 5800, decimals: 0 } },
  { type: "physics", x: 9, y: 2, w: 3, h: 3 },
  { type: "alerts", x: 4, y: 5, w: 3, h: 3 },
  { type: "graph", x: 7, y: 5, w: 3, h: 2,
    cfg: { topic: "/Catalyst/Loop/Robot/AverageMs", title: "Loop time", decimals: 1 } },
  { type: "auto", x: 7, y: 7, w: 3, h: 1 },
  { type: "battery", x: 10, y: 5, w: 2, h: 3 },
];

let layout = [];
const live = new Map(); // id -> {spec, tile, body, cfg, refs, state}
let nextId = 1;

/* The two controls a tile shows in edit mode: two sliders for Configure, a cross for Remove. */
const TILE_TOOL_ICONS = {
  configure: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7.5h9M18 7.5h2M4 16.5h2M11 16.5h9"/><circle cx="15.5" cy="7.5" r="2.5"/><circle cx="8.5" cy="16.5" r="2.5"/></svg>`,
  remove: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>`,
};

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
    // The stylesheet sizes a one-row tile's anatomy differently, and height is not otherwise visible
    // to CSS: the grid span is an inline style it cannot select on.
    tile.dataset.h = String(item.h);
    tile.style.gridColumn = `${item.x + 1} / span ${item.w}`;
    tile.style.gridRow = `${item.y + 1} / span ${item.h}`;

    const head = el("div", "h");
    head.appendChild(el("span", null, item.cfg.title || spec.name));
    const sub = el("span", "s");
    head.appendChild(sub);
    if (!spec.tileClass?.includes("pad0")) tile.appendChild(head);

    /* Drawn glyphs rather than the ⚙ and × characters, which came from whichever fallback font had
     * them and sat off-centre in their circles. */
    const tools = el("div", "tools");
    const cfgBtn = el("button", "tbtn cfg");
    cfgBtn.innerHTML = TILE_TOOL_ICONS.configure;
    cfgBtn.title = "Configure";
    cfgBtn.setAttribute("aria-label", "Configure");
    cfgBtn.onclick = (e) => { e.stopPropagation(); openConfig(item); };
    const delBtn = el("button", "tbtn del");
    delBtn.innerHTML = TILE_TOOL_ICONS.remove;
    delBtn.title = "Remove";
    delBtn.setAttribute("aria-label", "Remove");
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

  /* A Settings row: the name with its explanation under it, and the control at the right edge. Text
   * that runs long - a topic, a note - takes the full width under its name instead, where a column
   * beside it would cut a path off after its first segment; a title or a unit is a word or two and
   * sits at the edge like a number. The label is tied to its field, so a click on the name lands in
   * the box. */
  const SHORT_TEXT = ["title", "unit"];
  const add = (label, control, hint, wide) => {
    const row = el("div", wide ? "cfgrow wide" : "cfgrow");
    const lab = el("div", "cfglab");
    const name = el("label", null, label);
    if (control.id) name.htmlFor = control.id;
    lab.appendChild(name);
    if (hint) lab.appendChild(el("div", "hint", hint));
    row.append(lab, control);
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
    } else if (field.type === "lines") {
      // A note is written in lines, and a one-line field silently drops every break it is given.
      control = el("textarea");
      control.rows = 4;
      control.value = item.cfg[field.key] ?? "";
    } else {
      control = el("input");
      control.type = "text";
      control.value = item.cfg[field.key] ?? "";
      if (field.type === "topic") {
        control.setAttribute("list", "ntkeys");
        /* A path is typed back into robot code exactly, so it is set in the mono face. */
        control.classList.add("mono");
        control.spellcheck = false;
      }
    }
    control.id = `cfg-${field.key}`;
    control.oninput = () => {
      item.cfg[field.key] = field.type === "number" ? Number(control.value) : control.value;
    };
    add(field.label, control, field.hint,
      field.type === "topic" || field.type === "lines" || (field.type === "text" && !SHORT_TEXT.includes(field.key)));
  }

  const size = el("div", "cfgsize");
  const mk = (label, value, max, apply) => {
    const s = el("select");
    s.setAttribute("aria-label", label);
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

/* A white line drawing for each component on its card in the palette, the way Tesla's launcher draws
 * its apps. Kept here rather than on the component definitions, because a drawing is how the palette
 * presents a component and not part of what the component is; a type with none gets a plain tile. */
const PICK_ICONS = {
  match: `<path d="M5.5 21V4M5.5 4h11l-2.2 4 2.2 4h-11"/>`,
  tower: `<path d="M12 3.5 19.5 7.8v8.4L12 20.5 4.5 16.2V7.8z"/><circle cx="12" cy="12" r="2.6"/>`,
  gauge: `<path d="M4.6 16.5a8 8 0 1 1 14.8 0"/><path d="m12 13 3.6-4"/><circle cx="12" cy="13.5" r="1.3" fill="currentColor"/>`,
  battery: `<rect x="3" y="7" width="16" height="10" rx="2.2"/><path d="M21.2 10.5v3M6.5 10v4M9.8 10v4"/>`,
  systemcore: `<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M10 3v3.5M14 3v3.5M10 17.5V21M14 17.5V21M3 10h3.5M3 14h3.5M17.5 10H21M17.5 14H21"/>`,
  autonomy: `<circle cx="12" cy="12" r="8.5"/><path d="m15.4 8.6-2 4.8-4.8 2 2-4.8z"/>`,
  motorhistory: `<rect x="3" y="8" width="13" height="9" rx="2"/><path d="M16 11h3.5v3H16M8 8V5.5M11 8V5.5M9.5 17v2.5"/>`,
  health: `<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>`,
  physics: `<circle cx="12" cy="10.5" r="6.5"/><circle cx="12" cy="10.5" r="2.2"/><path d="M4 20.5h16"/>`,
  impacts: `<path d="M12 3v4.5M12 16.5V21M3 12h4.5M16.5 12H21M5.6 5.6l3 3M15.4 15.4l3 3M18.4 5.6l-3 3M8.6 15.4l-3 3"/>`,
  swerve: `<rect x="7" y="6" width="10" height="12" rx="2.2"/><path d="M3.5 5v4.5M3.5 14.5V19M20.5 5v4.5M20.5 14.5V19"/>`,
  alerts: `<path d="M12 4.2 20.8 19.5H3.2z"/><path d="M12 10v4.2M12 16.8v.1"/>`,
  auto: `<path d="M4 5.5v6l5-3z"/><path d="M12.5 8.5H20M4 15.5h16M4 19.5h11"/>`,
  value: `<path d="M5 9h14M5 15h14M10 4.5 8.5 19.5M15.5 4.5 14 19.5"/>`,
  lamps: `<circle cx="5.5" cy="12" r="2.6"/><circle cx="12" cy="12" r="2.6"/><circle cx="18.5" cy="12" r="2.6"/>`,
  graph: `<path d="M3.5 15.5 8.5 10l3.5 3.5 7.5-8"/><path d="M3.5 20h17"/>`,
  stopwatch: `<circle cx="12" cy="13.5" r="7"/><path d="M12 13.5V10M9.5 3h5M12 3v3.5M18.3 7.2l1.3-1.3"/>`,
  note: `<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h5M9 12.5h7M9 16h5"/>`,
  field: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/><circle cx="12" cy="12" r="2.4"/>`,
};
const PICK_ICON_PLAIN = `<rect x="4.5" y="4.5" width="15" height="15" rx="3"/>`;

function pickIcon(type) {
  return `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PICK_ICONS[type] || PICK_ICON_PLAIN}</svg>`;
}

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
      /* Catalyst's own tiles used to wear the accent on their cards to mark where they came from. The
       * group heading above them already says so, and blue is kept for what is switched on. */
      const btn = el("button", "item");
      btn.type = "button";
      btn.innerHTML = `${pickIcon(type)}<div class="n2">${spec.name}</div><div class="d2">${spec.desc}</div>`;
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
    const opening = v.dataset.view === name && v.dataset.active !== "true";
    v.dataset.active = String(v.dataset.view === name);
    if (opening) {
      /* The opening animation runs once, for opening, and is then taken off, so the view showing again
         for any other reason - the board coming back from Park - does not replay it. */
      v.dataset.entering = "";
      const done = (e) => {
        /* A tile's own animation ending bubbles up here too; only the view's counts. */
        if (e && e.target !== v) return;
        delete v.dataset.entering;
        v.removeEventListener("animationend", done);
      };
      v.addEventListener("animationend", done);
      setTimeout(done, 700);
    }
  }
  if (name === "logs") paintLogs();
  if (name === "tune") paintTune();
  if (name === "topics") paintTopics();
  if (name === "can") paintCan();
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
    chip.style.cssText = "background:var(--brand);color:var(--cat-on-signal)";
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
      const current = num(t.key, null);
      const isBool = raw(t.key)?.t === "bool";

      /* An on-or-off tunable is a shorter row, name left and switch at the right edge where the other
       * rows keep their values; a slider needs the middle of the row to itself. */
      const row = el("div", isBool ? "tr bool" : "tr");
      const name = el("div", "nm");
      name.appendChild(el("span", null, t.name || leaf(t.key)));
      name.appendChild(el("small", null, t.key));
      row.appendChild(name);

      if (isBool) {
        // A switch, the control Settings already uses for an on-or-off setting, and the one Tesla's
        // Controls screen uses. A button that read "On" had to be read to be understood.
        const tog = el("button", "tog");
        tog.type = "button";
        tog.setAttribute("role", "switch");
        tog.setAttribute("aria-checked", String(bool(t.key)));
        tog.setAttribute("aria-label", t.name || leaf(t.key));
        tog.dataset.key = t.key;
        tog.appendChild(el("i"));
        tog.onclick = () => ntSet(t.key, !bool(t.key));
        const control = el("div", "tswitch");
        control.append(el("div", "v", bool(t.key) ? "On" : "Off"), tog);
        row.appendChild(control);
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

/* A switch on the Tune sheet shows what the robot holds, not what was pressed.
 *
 * `paintTune` builds the sheet once, when it is opened, and a switch's `aria-checked` was only ever
 * written there - so a pressed switch did not move until the sheet was opened again, even though the
 * value had been written. It follows the store now, on every paint while the sheet is up, which also
 * means a write the robot refuses leaves the switch where the robot says it is rather than where the
 * press put it. Written only when it changed. */
function syncTune() {
  for (const tog of $("#tuneSheet").querySelectorAll(".tog[data-key]")) {
    const on = bool(tog.dataset.key, null);
    if (on === null) continue;
    const v = String(on);
    if (tog.getAttribute("aria-checked") === v) continue;
    tog.setAttribute("aria-checked", v);
    const word = tog.parentElement.querySelector(".v");
    if (word) word.textContent = on ? "On" : "Off";
  }
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
    /* Three readings, all white, the way a graph on the board is: packet loss used to be drawn amber
     * whatever it measured, which put a warning colour on a session that lost nothing. */
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="sh">Link quality · ${samples.battery.length} samples</div>
       <div class="lq">
         <div><div class="ml">Battery ${stat(samples.battery)} V</div>
           <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${sparkline(samples.battery, w, h, TOK.data)}</svg></div>
         <div><div class="ml">Trip ${stat(samples.trip_ms)} ms</div>
           <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${sparkline(samples.trip_ms, w, h, TOK.data)}</svg></div>
         <div><div class="ml">Packet loss ${stat(samples.loss_pct)} %</div>
           <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${sparkline(samples.loss_pct, w, h, TOK.data)}</svg></div>
       </div>`
    );
  } else if (!samples.parsed) {
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="note">No telemetry from this session: <b>${escapeHtml(samples.note || "unreadable")}</b>. The event log below is unaffected.</div>`
    );
  }

  host.insertAdjacentHTML("beforeend", `<div class="sh">Events</div>`);
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
    /* The filter sits beside the title as a capsule with a magnifier, the way Settings' search does. A
     * label rather than a div, so a press on the magnifier lands in the field. */
    sheet.innerHTML = `
      <div class="sheethead">
        <div class="sh">NetworkTables</div>
        <label class="sfilter">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="text" id="topicSearch" placeholder="Filter topics" aria-label="Filter topics" autocomplete="off" spellcheck="false">
        </label>
      </div>
      <div id="topicList"></div>`;
    $("#topicSearch").oninput = (e) => { topicFilter = e.target.value.toLowerCase(); paintTopics(); };
  }
  const list = $("#topicList");
  const keys = Object.keys(nt.v).filter((k) => k.toLowerCase().includes(topicFilter)).sort();
  if (!keys.length) {
    list.innerHTML = `<div class="empty">${Object.keys(nt.v).length ? "Nothing matches that filter." : "No topics — the console is not connected to a robot."}</div>`;
    return;
  }
  /* Long values are cut at 90 characters, and say so with an ellipsis: cut bare, an array of device
   * rows ended "CANco]", which reads as a value rather than as the start of one. */
  const cut = (s) => (s.length > 90 ? `${s.slice(0, 89).trimEnd()}…` : s);
  list.innerHTML = keys
    .slice(0, 400)
    .map((k) => {
      const v = nt.v[k];
      const shown = v.t === "num" ? v.v.toFixed(4)
        : v.t === "bool" ? (v.v ? "true" : "false")
        : Array.isArray(v.v) ? `[${cut(v.v.map((n) => (typeof n === "number" ? n.toFixed(2) : n)).join(", "))}]`
        : cut(String(v.v));
      return `<div class="topic"><div class="tk">${escapeHtml(k)}</div><div class="tt"><span>${v.t}</span></div><div class="tv">${escapeHtml(shown)}</div></div>`;
    })
    .join("");
  if (keys.length > 400) {
    list.insertAdjacentHTML("beforeend", `<div class="empty">…and ${keys.length - 400} more. Narrow the filter.</div>`);
  }
}

/* ------------------------------------------------------------------- CAN sheet */

/* Five buses on three SPI controllers, drawn as three controllers.
 *
 * That grouping is the entire reason this is a view rather than another row on the Systemcore page.
 * can_s0 and can_s1 share an SPI host and throttle each other; can_s0 and can_s2 do not. Every other
 * tool in FRC draws all five as equals, so a team moving half a drivetrain off a loaded bus can pick
 * the pair that buys them nothing and find out on a field. The rules — the pairing, the thresholds,
 * the warnings — are in can-model.js where they can be tested without a DOM. This draws what it
 * returns and adds no rule of its own.
 *
 * Four sources feed it, and the page keeps them apart because they are not equally true:
 *
 *   /Catalyst/CAN/Devices                  what is wired where — CANRegistry.republish()
 *   /Catalyst/Systemcore/CanUtilization    the OS's own measurement, all five buses, always
 *   /Catalyst/CAN/Health/<bus>/*           Phoenix's view: reaches CANivores, carries the counters
 *   /Catalyst/Preflight/Findings           what the robot said about its own CAN plan, when it ran
 *
 * The first three are continuous. The fourth is a snapshot from whenever robot code last called
 * Preflight.run(), and nothing republishes it — so it is labelled as the robot's word and kept in its
 * own block, rather than mixed in with what the console is working out live from the wire.
 *
 * The topology is drawn with no robot attached. Five buses on three controllers is a fact about the
 * Systemcore rather than a reading from one, and an empty bus is the most useful thing on this page:
 * it is where the next mechanism should go. Every number stays a dash until something answers. */

const CAN_DEVICES = "/Catalyst/CAN/Devices";
const CAN_HEALTH = "/Catalyst/CAN/Health/";
const PREFLIGHT_FINDINGS = "/Catalyst/Preflight/Findings";

/* Phoenix publishes six keys per bus and can-model.js reads six named fields. The mapping is a table
   rather than six lines of assignment so the per-bus key strings can be built once, at the point the
   set of buses changes, instead of being concatenated afresh ten times a second. */
const CAN_HEALTH_FIELDS = [
  ["ok", "OK", bool],
  ["utilization", "Utilization", num],
  ["busOff", "BusOffCount", num],
  ["txFull", "TxFullCount", num],
  ["rec", "REC", num],
  ["tec", "TEC", num],
];

/* Everything that survives between frames. The structure — which buses exist, what is on them — is
   rebuilt only when the published device roster changes, which is when somebody plugs something in.
   The numbers are written straight to the cached nodes on every frame. */
const canCache = {
  rowsRaw: undefined,   // the last array object seen on CAN_DEVICES, for a free early-out
  rowsSig: null,        // its contents, for when a frame re-sends an unchanged key as a new array
  devices: [],          // parseDevices() of those rows
  health: null,         // bus → the object handed to layout(), fields overwritten in place
  probes: [],           // {row, fields:[{name, key, read}]} — where those fields come from
  shape: null,          // the structure the cached nodes below were built for
  groups: [],           // {el, track, num} per shared controller, in controller order
  buses: [],            // {el, track, num, meta} per bus, in controller order
  preRaw: undefined,    // the last array object seen on PREFLIGHT_FINDINGS
  preHtml: "",          // its rendering, so a snapshot nobody has updated is formatted once
};

function paintCan() {
  const sheet = $("#canSheet");
  if (!sheet.dataset.built) {
    sheet.dataset.built = "1";
    sheet.innerHTML = `
      <div class="sh">CAN buses</div>
      <div class="canhead">
        <div class="canstat"><b id="canDevCount">—</b><small>devices</small></div>
        <div class="canstat"><b id="canBusiest">—</b><small>busiest bus</small></div>
      </div>
      <div class="note" id="canNote" hidden></div>
      <div id="canGroups"></div>
      <div class="canwarn" id="canWarn"></div>
      <div class="canwarn" id="canPre"></div>`;
  }

  /* A frame that did not touch this key hands back the same array object, so the common case costs
     one comparison. When it does hand back a new one the contents are usually identical anyway — the
     roster is written once at robot boot — and re-parsing and re-sorting it to discover that is the
     one piece of per-frame work here worth avoiding. */
  const rows = arr(CAN_DEVICES);
  if (rows !== canCache.rowsRaw) {
    canCache.rowsRaw = rows;
    const sig = rows ? rows.join("\n") : "";
    if (sig !== canCache.rowsSig) {
      canCache.rowsSig = sig;
      canCache.devices = canModel.parseDevices(rows);
      canCache.health = null;   // a new roster can mean a new bus to read health for
    }
  }

  if (!canCache.health) buildCanProbes();
  for (const p of canCache.probes) {
    for (const f of p.fields) p.row[f.name] = f.read(f.key, null);
  }

  /* Called every frame, and deliberately. What it folds in — utilisation per bus, the combined figure
     for a shared pair — changes every frame, and the alternative is to re-implement the pair rule out
     here against the cached nodes, which is the duplication can-model.js exists to prevent. It costs a
     map and a couple of dozen small objects. What is gated is everything that reaches the DOM. */
  const model = canModel.layout({
    devices: canCache.devices,
    osUtilization: arr(CORE + "CanUtilization"),
    health: canCache.health,
  });

  const shape = canShapeOf(model);
  if (shape !== canCache.shape) {
    canCache.shape = shape;
    buildCanGroups(model);
  }

  setText($("#canDevCount"), String(model.deviceCount));
  setText($("#canBusiest"), canModel.utilizationText(model.busiest) ?? "—");

  /* Compared before it is written, like everything else on this page. Assigning `hidden` the value it
     already holds still rewrites the attribute, which is a style invalidation ten times a second for a
     line that changes twice a match. */
  const note = $("#canNote");
  const linked = nt.status.connected || demo.on;
  if (note.hidden !== linked) note.hidden = linked;
  if (!linked) {
    setHtml(note, "No robot. Which buses share a controller is a fact about the Systemcore rather "
      + "than a reading from one, so the layout is drawn — every number stays a dash until "
      + "something answers.");
  }

  let gi = 0;
  let bi = 0;
  for (const c of model.controllers) {
    if (c.shared) writeCanPair(canCache.groups[gi++], c);
    for (const b of c.buses) writeCanBus(canCache.buses[bi++], b);
  }

  paintCanWarnings(model);
  paintCanPreflight();
}

/* The set of buses to read Phoenix health for: Systemcore's own five, always, plus whatever the
   roster puts a device on. Nothing else can reach the page — layout() only raises a non-Systemcore
   group for a bus that has devices — so scanning every NetworkTables key for a CANivore that
   published health and carries nothing would find only buses with nothing to draw. */
function buildCanProbes() {
  const names = new Set();
  for (const c of canModel.CONTROLLERS) for (const b of c.buses) names.add(b);
  for (const d of canCache.devices) names.add(d.bus);

  canCache.health = Object.create(null);
  canCache.probes = [];
  for (const bus of names) {
    const row = {};
    canCache.health[bus] = row;
    canCache.probes.push({
      row,
      fields: CAN_HEALTH_FIELDS.map(([name, key, read]) => ({ name, key: CAN_HEALTH + bus + "/" + key, read })),
    });
  }
}

/* What the markup depends on, and nothing that does not: bus names, the devices on them, and whether
   a group draws a combined bar. Utilisation is absent on purpose — it changes every frame and is
   written to nodes that already exist. */
function canShapeOf(model) {
  let s = "";
  for (const c of model.controllers) {
    s += `${c.group}:${c.shared ? "p" : "-"}:`;
    for (const b of c.buses) {
      s += b.name + "[";
      for (const d of b.devices) s += `${d.id},${d.type},${d.name};`;
      s += "]";
    }
    s += "|";
  }
  return s;
}

function buildCanGroups(model) {
  $("#canGroups").innerHTML = model.controllers.map((c) => `
    <section class="cangroup" data-shared="${c.shared}">
      <header>
        <h4>${escapeHtml(c.name)}</h4>
        <small>${escapeHtml(c.note)}</small>
      </header>
      ${c.shared ? `<div class="canpair">
        <span>together</span>
        <div class="ctrack big"><i></i></div>
        <b>—</b>
      </div>` : ""}
      ${c.buses.map(canBusHtml).join("")}
    </section>`).join("");

  /* One walk of the tree, so a frame never runs a selector. The order below is the order the writers
     step through the model, which is the order the markup was just built in. */
  canCache.groups = [...$("#canGroups").querySelectorAll(".canpair")].map((row) => ({
    el: row,
    track: row.querySelector("i"),
    num: row.querySelector("b"),
  }));
  canCache.buses = [...$("#canGroups").querySelectorAll(".canbus")].map((node) => ({
    el: node,
    track: node.querySelector(".canline i"),
    num: node.querySelector(".canline b"),
    meta: node.querySelector(".canmeta"),
  }));
}

function canBusHtml(b) {
  const devices = b.devices.map((d) =>
    `<div class="candev"><i>${d.id}</i><span>${escapeHtml(d.type)}</span>`
    + `${d.name ? `<small>${escapeHtml(d.name)}</small>` : ""}</div>`).join("");
  return `<div class="canbus" data-bus="${escapeHtml(b.name)}" data-kind="${b.kind}">
      <div class="canline">
        <span>${escapeHtml(b.name)}</span>
        <div class="ctrack"><i></i></div>
        <b>—</b>
      </div>
      <div class="canmeta"></div>
      ${devices ? `<div class="candevs">${devices}</div>` : ""}
    </div>`;
}

/* One bus's live numbers.
 *
 * `absent` and `idle` are the distinction the whole model is careful about and the one the page is
 * most able to blur: a bus nobody measured and a bus carrying nothing both draw an empty track. They
 * are separated in the text — a dash against a zero — and in the styling, because reading "0%" off a
 * bus that was never reported on is how somebody concludes a wire is free and hangs a mechanism on
 * it. */
function writeCanBus(node, b) {
  setText(node.num, canModel.utilizationText(b.utilization) ?? "—");
  setWidth(node.track, canModel.barWidth(b.utilization));
  setLevel(node.track, coreFmt.level(
    b.utilization === null ? null : b.utilization * 100, 70, canModel.UTILIZATION_WARN * 100));

  setFlag(node.el, "absent", b.utilization === null);
  setFlag(node.el, "idle", b.idle);

  /* Device count first: it is the half of the page that is true with the robot disabled, which is
     when somebody is standing in front of it able to move a wire. */
  let meta = b.devices.length
    ? `${b.devices.length} device${b.devices.length === 1 ? "" : "s"}`
    : "nothing registered";
  if (b.utilization === null) meta += " · not measured";
  else if (b.idle) meta += " · idle";
  if (b.source === "phoenix") meta += " · Phoenix";
  if (b.health?.busOff) meta += ` · bus-off ×${b.health.busOff}`;
  if (b.health?.txFull) meta += ` · TX full ×${b.health.txFull}`;
  /* The counters climb before a bus drops. Catching that in the pit is the difference between
     finding a loose connector and finding it during an elimination. */
  if (canModel.hasErrorActivity(b.health)) {
    meta += ` · errors REC ${b.health.rec ?? 0} / TEC ${b.health.tec ?? 0}`;
  }
  setText(node.meta, meta);
}

/* The combined figure for a shared controller, which is the number the grouping exists to show. Drawn
 * against what the pair can carry rather than against two full buses: the ceiling is one SPI host's
 * throughput, not the sum of two free wires. */
function writeCanPair(node, c) {
  setText(node.num, canModel.utilizationText(c.utilization) ?? "—");
  setWidth(node.track, canModel.barWidth(c.utilization, canModel.PAIR_UTILIZATION_LIMIT));
  setLevel(node.track, c.utilization === null ? null
    : c.utilization > canModel.PAIR_UTILIZATION_LIMIT ? "crit"
    : c.utilization > canModel.PAIR_UTILIZATION_LIMIT * 0.8 ? "warn" : "ok");
  /* Marked absent on the same terms as a bus, and drawn the same way. A pair total is null unless
     both its buses were measured, so half a reading shows as no reading — and the one thing this
     page cannot afford is for a missing number to look like a low one in one place and not another. */
  setFlag(node.el, "absent", c.utilization === null);
  /* A pair whose buses are both idle is dimmed with them, rather than printing its 0% in white between
     two dimmed ones. */
  setFlag(node.el, "idle", c.utilization !== null && c.buses.every((b) => b.idle));
}

/* What the console worked out, from what is on the wire right now. */
function paintCanWarnings(model) {
  setHtml($("#canWarn"), canModel.contentionWarnings(model)
    .map((w) => `<div class="canw" data-level="${w.level}">${escapeHtml(w.text)}</div>`).join(""));
}

/* What the robot said, the last time anything asked it. Kept in its own block and labelled, because
 * it is a snapshot from whenever Preflight.run() was called and nothing republishes it — a finding
 * sitting beside a live warning would be read as equally current. */
function paintCanPreflight() {
  const rows = arr(PREFLIGHT_FINDINGS);
  if (rows !== canCache.preRaw) {
    canCache.preRaw = rows;
    const found = canModel.parsePreflightCan(rows);
    canCache.preHtml = found.length
      ? `<div class="sh">From the robot&rsquo;s preflight</div>`
        + found.map((f) => `<div class="canw" data-level="${f.level}">${escapeHtml(f.text)}</div>`).join("")
      : "";
  }
  setHtml($("#canPre"), canCache.preHtml);
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
  const sideText = `${side ? (side === "red" ? "Red" : "Blue") : "No"} alliance`;
  const matchText = event ? (match ? `Match ${match}` : "") : "no match";
  /* The status line carries the match, not the product: Tesla's bar has no wordmark on it, and the mark
   * beside the drive-mode letters already says whose screen this is. The event and the match are their
   * own spans because they are what the line gives up first on a narrow window (`fitStatusBar`), and the
   * whole line stays in the tooltip once they have gone. */
  const ident = $("#ident");
  setHtml(ident, `<span class="idstate">${sideText}`
    + (event ? `<span class="id-event"> · ${escapeHtml(event)}</span>` : "")
    + (matchText ? `<span class="id-match"> · ${matchText}</span>` : "")
    + `</span>`);
  const identTitle = [sideText, event, matchText].filter(Boolean).join(" · ");
  if (ident.title !== identTitle) ident.title = identTitle;

  /* The drive-mode letters. Unlinked lights none of them: with nothing on the other end the robot is
   * in no mode, and a lit D would say it had been disabled. */
  const gears = $("#gears");
  const gear = !linked ? "none"
    : ds.estop ? "estop"
    : !ds.enabled ? "disabled"
    : ds.test ? "test"
    : ds.auto ? "auto"
    : "teleop";
  if (gears.dataset.mode !== gear) {
    gears.dataset.mode = gear;
    gears.setAttribute("aria-label", `Robot mode: ${linked ? ds.mode : "no robot"}`);
  }

  /* The charge. The cell is drawn between 10.5 V, where a robot browns out, and 12.8 V, a pack fresh
   * off the charger; the thresholds are the battery tile's defaults, so the bar and the tile agree
   * about what "low" means. */
  // The same keys, in the same order, the battery tile reads, so the bar and the tile never disagree.
  const voltKey = ["/Catalyst/Status/BatteryVolts", "/Catalyst/Brownout/MeasuredVoltage", "/Catalyst/Systemcore/BatteryVolts"]
    .find((k) => has(k));
  const volts = linked && voltKey ? num(voltKey, null) : null;
  const batt = $("#batt");
  $("#battText").textContent = volts === null ? "— V" : `${volts.toFixed(1)} V`;
  $("#battFill").setAttribute("width", volts === null ? "0" : (19 * clamp01((volts - 10.5) / (12.8 - 10.5))).toFixed(1));
  batt.dataset.level = volts === null ? "none" : volts < 10.5 ? "critical" : volts < 11.5 ? "low" : "ok";

  /* The team, where Tesla shows whose profile is driving. */
  const team = linked ? (num("/Catalyst/Systemcore/TeamNumber", null) || num("/Catalyst/Robot/Identity/TeamNumber", null)) : null;
  $("#profile").hidden = !team;
  if (team && $("#profileName").textContent !== String(team)) $("#profileName").textContent = String(team);

  /* Tesla's clock, in the status line. Written only when the minute changes, not ten times a second. */
  const now = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const clockEl = $("#clock");
  if (clockEl.textContent !== now) clockEl.textContent = now;

  $("#dLink").className = `d ${linked ? "ok" : "bad"}`;
  $("#linkText").textContent = demo.on ? "Demo" : nt.status.connected ? (nt.status.address || "Robot") : "Searching";
  /* Said in the tooltip as well, for when a narrow line has left the chip only its light. */
  const linkTitle = `${$("#linkText").textContent} · Robot settings`;
  if ($("#linkChip").title !== linkTitle) $("#linkChip").title = linkTitle;
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

  paintDeviceStrip();
}

/* The status line gives way a word at a time.
 *
 * At a laptop-width window, with an alert up, the line holds more than it has room for, and a word cut
 * off partway - "De…" for Demo, "1/" for a device count - says nothing at all. So it gives up whole
 * words instead, in the order `BAR_STEPS` lists and the stylesheet hides them (`.top[data-fit]`), and
 * only as many as what is on it right now needs: a short event name keeps its match number where a
 * long one does not, and a second alert costs a word that one alert did not.
 *
 * Measuring costs a layout, so it happens only when something that can change the line's width has
 * changed - the window, the fonts arriving, the words on it, the alert count, the device counts - and
 * not on every paint. Readings are tabular, so a figure that changes without changing length does not
 * count as a change. */
const BAR_STEPS = ["event", "match", "words", "ident", "team"];
let barSig = "";

function barOverflows(line) {
  if (line.scrollWidth > line.clientWidth + 1) return true;
  for (const node of line.querySelectorAll(".idt, .chip > span, .devstrip")) {
    if (node.offsetWidth && node.scrollWidth > node.clientWidth + 1) return true;
  }
  return false;
}

function fitStatusBar() {
  const sig = [
    window.innerWidth, document.fonts?.status,
    $("#ident").textContent, $("#profile").hidden, $("#profileName").textContent,
    $("#linkText").textContent, $("#loopText").textContent.length,
    $("#devStrip").hidden, $("#devStrip").dataset.sig,
    $("#alertInd").hidden, $("#alertCount").textContent.length, $("#clock").textContent.length,
  ].join("|");
  if (sig === barSig) return;
  barSig = sig;

  const top = $(".top");
  const line = $(".sb-map");
  let steps = 0;
  const apply = () => {
    const fit = BAR_STEPS.slice(0, steps).join(" ");
    if (top.dataset.fit !== fit) top.dataset.fit = fit;
  };
  apply();
  while (steps < BAR_STEPS.length && barOverflows(line)) {
    steps++;
    apply();
  }
}

/* ----------------------------------------------------------------- device strip */

/** The read-only NetworkTables view devices.js works over. */
const ntView = {
  get linked() { return nt.status.connected || demo.on; },
  has, num, str, arr, bool,
  keys: () => Object.keys(nt.v),
};

/* How long ago each robot-pose array last changed, so a Limelight that has frozen is not taken for a
 * live fix (see robotPlacement). A camera that sees tags publishes a slightly different solve every
 * frame. */
const poseChanges = new Map();
function poseAge(key) {
  const value = arr(key);
  if (!Array.isArray(value)) return Infinity;
  const now = performance.now();
  const signature = value.join(",");
  const seen = poseChanges.get(key);
  if (!seen || seen.signature !== signature) {
    poseChanges.set(key, { signature, at: now });
    return 0;
  }
  return now - seen.at;
}

const DEV_ICONS = {
  cameras: `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2.5"/><circle cx="9" cy="12.5" r="2.6"/><circle cx="16" cy="12.5" r="2.6"/></svg>`,
  motors: `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="13" height="9" rx="2"/><path d="M16 11h3.5v3H16M8 8V5.5M11 8V5.5M9.5 17v2.5"/></svg>`,
  controller: `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M7 9h10M7 12.5h6M7 16h3"/></svg>`,
};

function fraction(count) {
  if (!count.expected) return "—";
  return count.connected === null ? String(count.expected) : `${count.connected}/${count.expected}`;
}

/* Three counts in the corner: cameras, motors, controller. "4/4" means four heartbeats are
 * advancing; a bare "4" means four exist and nothing on the robot can say whether they answer,
 * and the tooltip says which of those it is. Hidden until a robot is there, because a row of
 * dashes is not information. */
function paintDeviceStrip() {
  const strip = $("#devStrip");
  const s = deviceSummary(ntView);
  const linked = nt.status.connected || demo.on;
  strip.hidden = !linked || !s.any;
  if (strip.hidden) { strip.dataset.sig = ""; return; }

  const controller = {
    expected: s.controller.kind ? 1 : 0,
    connected: s.controller.connected === null ? null : (s.controller.connected ? 1 : 0),
    rows: [],
  };
  const items = [
    ["cameras", "Limelights", s.cameras],
    ["motors", "Motors", s.motors],
    ["controller", s.controller.kind || "Controller", controller],
  ];
  const sig = items.map(([k, , c]) =>
    `${k}:${fraction(c)}:${countState(c)}:${c.rows.map((r) => `${r.name}=${r.connected}`).join(",")}`).join("|");
  if (strip.dataset.sig === sig) return;
  strip.dataset.sig = sig;

  strip.innerHTML = items.map(([key, , count]) =>
    `<button class="dev" data-state="${countState(count)}" data-dev="${key}">${DEV_ICONS[key]}<b>${escapeHtml(fraction(count))}</b></button>`
  ).join("");
  for (const b of strip.querySelectorAll(".dev")) {
    const [, label, count] = items.find(([k]) => k === b.dataset.dev);
    const lines = count.rows.map((r) =>
      `${r.connected === false ? "\u2717" : r.connected ? "\u2713" : "\u00b7"} ${r.name}${r.detail ? ` \u2014 ${r.detail}` : ""}`);
    const how = !count.expected ? "" : count.connected === null ? " seen on the wire" : " answering";
    b.title = [`${label}: ${fraction(count)}${how}`, ...lines].join("\n");
    b.onclick = () => setSettings(true, b.dataset.dev === "controller" ? "core" : "devices");
  }
}

/* --------------------------------------------------------------------- notices */

const noticeSeen = new Map();
/** When each active notice was last put up as a pop-up, and at what level. */
const toastShown = new Map();
/** Notices that have cleared this session, newest first, for the alert list. */
const noticeHistory = [];
const HISTORY_MAX = 20;
/* How long a pop-up stays before it folds into the triangle. Tesla's go in a few seconds; a fault
 * stays longer because it is the one worth being sure was seen. */
const TOAST_MS = { error: 10000, warn: 6000, info: 5000 };
const NOTICE_RANK = { error: 0, warn: 1, info: 2 };

/* Outline symbols in the level's colour, the way Tesla draws its alert icons: a triangle to check, an
 * octagon for a fault, a circle for a note. Shape as well as colour, so the level reads in greyscale. */
const NOTICE_ICONS = {
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6 21.6 20.2H2.4z"/><path d="M12 9.8v4.6" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.05" fill="currentColor" stroke="none"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M8.2 2.8h7.6l5.4 5.4v7.6l-5.4 5.4H8.2l-5.4-5.4V8.2z"/><path d="M12 7.6v5.6" stroke-linecap="round"/><circle cx="12" cy="16.4" r="1.05" fill="currentColor" stroke="none"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.05" fill="currentColor" stroke="none"/></svg>`,
};

const noticeKind = (key) => (key.startsWith("vision") ? "Vision" : key.startsWith("auto") ? "Autonomous" : "Robot");

/* Alerts, the way Tesla shows them. A notice that is new - or has just become more serious - comes up
 * as a pop-up capsule over the board for a few seconds, then goes away on its own and waits in the
 * triangle at the top right, which opens the list of everything active and everything that cleared
 * this session. Fed by devices.js from the robot's vision health rows, its error alerts and the auto
 * start check, and held for the same alertHoldMs the alerts tile uses, so a notice that flaps is one
 * steady alert rather than a pop-up every second. It never blocks anything - rule two. */
function paintNotices() {
  const bar = $("#notices");
  const linked = nt.status.connected || demo.on;
  const now = performance.now();
  if (linked) {
    for (const n of computeNotices(ntView, { enabled: ds.enabled })) {
      const prev = noticeSeen.get(n.key);
      noticeSeen.set(n.key, { ...n, at: now, since: prev?.since ?? Date.now() });
    }
  }
  for (const [key, entry] of noticeSeen) {
    if (!linked || now - entry.at > settings.alertHoldMs) {
      noticeSeen.delete(key);
      toastShown.delete(key);
      noticeHistory.unshift({ ...entry, cleared: Date.now() });
      if (noticeHistory.length > HISTORY_MAX) noticeHistory.length = HISTORY_MAX;
    }
  }
  const active = [...noticeSeen.values()].sort((a, b) => NOTICE_RANK[a.level] - NOTICE_RANK[b.level]);

  // Which are pop-ups right now: new ones, ones that got worse, and ones still inside their time.
  const toasts = [];
  for (const n of active) {
    const shown = toastShown.get(n.key);
    if (!shown || NOTICE_RANK[n.level] < NOTICE_RANK[shown.level]) {
      toastShown.set(n.key, { at: now, level: n.level, dismissed: false });
      toasts.push(n);
    } else if (!shown.dismissed && now - shown.at < (TOAST_MS[n.level] ?? 6000)) {
      toasts.push(n);
    }
  }
  paintToasts(bar, toasts.slice(0, 3));
  paintAlertIndicator(active);
  if (!$("#alertPop").hidden) paintAlertPop(active);
}

/* The pop-ups are kept by key rather than redrawn, so one arriving does not restart the others, and one
 * leaving can slide away instead of vanishing mid-read. */
function paintToasts(bar, toasts) {
  const want = new Map(toasts.map((n) => [n.key, n]));
  for (const node of [...bar.children]) {
    if (!want.has(node.dataset.key) && node.dataset.leaving !== "true") {
      node.dataset.leaving = "true";
      setTimeout(() => node.remove(), 380);
    }
  }
  toasts.forEach((n, i) => {
    let node = [...bar.children].find((c) => c.dataset.key === n.key && c.dataset.leaving !== "true");
    const sig = `${n.level}|${n.text}|${n.detail}`;
    if (!node) {
      node = document.createElement("div");
      node.className = "notice";
      node.dataset.key = n.key;
      node.setAttribute("role", n.level === "error" ? "alert" : "status");
      bar.appendChild(node);
    }
    if (node.dataset.sig !== sig) {
      node.dataset.sig = sig;
      node.className = `notice ${n.level}`;
      node.innerHTML =
        `<span class="nicon">${NOTICE_ICONS[n.level] || NOTICE_ICONS.info}</span>` +
        `<span class="ntext"><span class="nt">${escapeHtml(n.text)}</span>` +
        `<span class="nd">${escapeHtml(n.detail || noticeKind(n.key))}</span></span>` +
        `<button class="nbtn" type="button">Details</button>` +
        `<button class="nclose" type="button" aria-label="Dismiss"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button>`;
      node.querySelector(".nbtn").onclick = () => openAlertPop(true);
      node.querySelector(".nclose").onclick = () => {
        const shown = toastShown.get(n.key);
        if (shown) shown.dismissed = true;
        paintNotices();
      };
    }
    // Keep the order the ranking asked for without rebuilding anything.
    if (bar.children[i] !== node) bar.insertBefore(node, bar.children[i] || null);
  });
  bar.hidden = bar.children.length === 0;
}

function paintAlertIndicator(active) {
  const ind = $("#alertInd");
  ind.hidden = active.length === 0;
  if (!active.length) return;
  const level = active[0].level;
  if (ind.dataset.level !== level) ind.dataset.level = level;
  const count = String(active.length);
  if ($("#alertCount").textContent !== count) $("#alertCount").textContent = count;
  ind.title = `${count} active alert${active.length === 1 ? "" : "s"}`;
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function paintAlertPop(active) {
  const body = $("#alertPopBody");
  const row = (n, when) =>
    `<div class="arow ${n.level}"><span class="nicon">${NOTICE_ICONS[n.level] || NOTICE_ICONS.info}</span>` +
    `<span class="ntext"><span class="nt">${escapeHtml(n.text)}</span>` +
    `<span class="nd">${escapeHtml(n.detail ? `${noticeKind(n.key)} · ${n.detail}` : noticeKind(n.key))}</span></span>` +
    `<span class="awhen">${when}</span></div>`;
  const html =
    (active.length
      ? `<div class="asec">Active</div>` + active.map((n) => row(n, ago(Date.now() - n.since))).join("")
      : `<div class="aempty">Nothing is active.</div>`) +
    (noticeHistory.length
      ? `<div class="asec">Earlier this session</div>` +
        noticeHistory.map((n) => row(n, `cleared ${ago(Date.now() - n.cleared)} ago`)).join("")
      : "");
  if (body.dataset.html !== html) {
    body.dataset.html = html;
    body.innerHTML = html;
  }
}

function openAlertPop(open) {
  const pop = $("#alertPop");
  pop.hidden = !open;
  $("#alertInd").setAttribute("aria-expanded", String(open));
  if (open) paintAlertPop([...noticeSeen.values()].sort((a, b) => NOTICE_RANK[a.level] - NOTICE_RANK[b.level]));
}

$("#alertInd").onclick = () => openAlertPop($("#alertPop").hidden);
$("#alertPopClose").onclick = () => openAlertPop(false);
document.addEventListener("pointerdown", (e) => {
  const pop = $("#alertPop");
  if (pop.hidden || !(e.target instanceof Element)) return;
  if (!e.target.closest("#alertPop, #alertInd, .notice")) openAlertPop(false);
});
// Escape closes the list before anything else it might mean, which is why this listens in the capture
// phase: the list is the thing on top.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#alertPop").hidden) {
    openAlertPop(false);
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

/* ------------------------------------------------------------------ dock: the auto routine */

/* The routine the robot will run, set from the dock with a chevron either side, the way Tesla sets the
 * cabin temperature. Same key the chooser tile writes. Locked while the robot is enabled: a routine is
 * read when auto begins, and a tap mid-match would change nothing but what the screen says. */
const AUTO_BASE = "/Auto Selector";
function paintDockAuto() {
  const box = $("#dockAuto");
  const options = (nt.status.connected || demo.on) ? (arr(`${AUTO_BASE}/options`) || []) : [];
  box.hidden = options.length === 0;
  if (!options.length) return;
  const chosen = str(`${AUTO_BASE}/selected`, null) ?? str(`${AUTO_BASE}/active`, null) ?? options[0];
  const name = $("#autoName");
  if (name.textContent !== chosen) name.textContent = chosen;
  box.title = chosen;
  const locked = ds.enabled;
  $("#autoPrev").disabled = locked;
  $("#autoNext").disabled = locked;
  box.dataset.locked = String(locked);
}
function stepAuto(dir) {
  const options = arr(`${AUTO_BASE}/options`) || [];
  if (!options.length || ds.enabled) return;
  const chosen = str(`${AUTO_BASE}/selected`, null) ?? str(`${AUTO_BASE}/active`, null) ?? options[0];
  const at = Math.max(0, options.indexOf(chosen));
  ntSet(`${AUTO_BASE}/selected`, options[(at + dir + options.length) % options.length]);
  paintDockAuto();
}
$("#autoPrev").onclick = () => stepAuto(-1);
$("#autoNext").onclick = () => stepAuto(1);

/* ------------------------------------------------------------------------------------- park */

/* How long the robot has to stay disabled before the board steps aside for Park. Long enough that a
 * disable to reset something does not throw the view around; longer again with the FMS attached, to
 * ride out the few seconds between auto and teleop, when a real match disables the robot on purpose. */
const PARK_ENTER_MS = 2500;
const PARK_ENTER_FMS_MS = 8000;
/* The fade between Park and the board, matching the CSS below it. */
const PARK_FADE_MS = 520;

const parkState = {
  on: false,
  since: null,          // when the robot was last seen disabled, for the delay above
  dismissed: false,     // "Dashboard" was pressed: stay on the board until the next enable
  scene: null,
  layout: null,         // park3d.js's layoutCallouts, once the module has loaded
  loading: false,
  failed: false,
  offFrame: null,
  hideTimer: null,
  move: 0,              // counts moves between Park and Drive; a newer one cuts an older one short
};

/* The battery from the same keys, in the same order, the header's cell and the battery tile read, so
 * Park never disagrees with either. */
function batteryVolts() {
  const key = ["/Catalyst/Status/BatteryVolts", "/Catalyst/Brownout/MeasuredVoltage", "/Catalyst/Systemcore/BatteryVolts"]
    .find((k) => has(k));
  return key ? num(key, null) : null;
}

/* What a disabled robot's battery says about the next match. Disabled, a robot draws only the couple
 * of amps its controller and radio need, so the reading is close to the battery's resting voltage, and
 * a 12 V lead-acid battery at rest sits near 12.7 V when full and falls steadily as it empties. The bar
 * runs from 11.8 V to 12.8 V. */
function batteryReadiness(volts) {
  if (volts === null || !Number.isFinite(volts)) return null;
  const fill = clamp01((volts - 11.8) / (12.8 - 11.8));
  if (volts >= 12.5) return { level: "ok", fill, text: "Charged" };
  if (volts >= 12.2) return { level: "low", fill, text: "Partly charged · swap before a match" };
  return { level: "bad", fill, text: "Low · swap the battery" };
}

/* ---- the robot Console last saw ----
 *
 * Tesla's screen shows the car whether or not it is awake. Park does the same for the robot: the last
 * real robot Console was connected to is remembered - its name, its number and its size, nothing more -
 * and drawn when nothing is on the other end, with when it was last seen. Demo data is never
 * remembered, because the demo robot is nobody's. */
const LAST_ROBOT_KEY = "catalyst.console.lastRobot.v1";
let lastRobot = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_ROBOT_KEY) || "null");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : null;
  } catch {
    return null;
  }
})();
let lastRobotWritten = -Infinity;

function rememberRobot(now) {
  if (!nt.status.connected || demo.on) return;
  const name = str(`${SPEC_ROOT}Identity/Name`, "");
  const team = parkTeam(true);
  if (!name && !team) return;
  const spec = parkRobotSpec();
  const same = lastRobot && lastRobot.name === name && lastRobot.team === team
    && JSON.stringify(lastRobot.spec) === JSON.stringify(spec);
  /* When it was last seen is written every half minute at most; nothing shows it any finer. */
  if (same && now - lastRobotWritten < 30000) return;
  lastRobot = { name, team, spec, seen: Date.now() };
  lastRobotWritten = now;
  try {
    localStorage.setItem(LAST_ROBOT_KEY, JSON.stringify(lastRobot));
  } catch { /* private mode or quota: the robot is simply not remembered */ }
}

function agoText(ms) {
  const s = Math.max(0, ms / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** The robot's size and module layout from its spec sheet, in the shape park3d.js takes. */
function parkRobotSpec() {
  const n = (k) => num(`${SPEC_ROOT}${k}`, null) ?? undefined;
  const flat = arr(`${SPEC_ROOT}Drivetrain/ModuleLocations`);
  const modules = Array.isArray(flat) && flat.length >= 8 && flat.length % 2 === 0
    ? Array.from({ length: flat.length / 2 }, (_, i) => [flat[i * 2], flat[i * 2 + 1]])
    : undefined;
  return {
    frameLength: n("Chassis/FrameLengthMeters"),
    frameWidth: n("Chassis/FrameWidthMeters"),
    bumperLength: n("Chassis/BumperLengthMeters"),
    bumperWidth: n("Chassis/BumperWidthMeters"),
    bumperThickness: n("Chassis/BumperThicknessMeters"),
    height: n("Chassis/HeightMeters"),
    modules,
  };
}

/** The robot to draw: the connected one, or the remembered one when nothing is connected. */
function parkSpec(linked) {
  return linked ? parkRobotSpec() : (lastRobot?.spec ?? {});
}

/** The number on the bumpers, the same way round: the connected robot's, or the remembered one's. */
function parkTeam(linked) {
  if (!linked) return lastRobot?.team ?? null;
  return num("/Catalyst/Systemcore/TeamNumber", null) || num(`${SPEC_ROOT}Identity/TeamNumber`, null) || null;
}

function parkWanted(now) {
  if (settings.parkView === false) return false;
  if (activeView() !== "board") return false;
  const linked = nt.status.connected || demo.on;
  if (linked && ds.enabled) {
    parkState.since = null;
    parkState.dismissed = false;
    return false;
  }
  if (parkState.dismissed) return false;
  if (parkState.since === null) parkState.since = now;
  const wait = !linked ? 0 : ds.fms ? PARK_ENTER_FMS_MS : PARK_ENTER_MS;
  return now - parkState.since >= wait;
}

function loadParkScene() {
  if (parkState.scene || parkState.loading || parkState.failed) return;
  parkState.loading = true;
  /* three.js is fetched once whichever 3D view asks first. The stage is made as soon as there is a robot
   * to park, not when Park is first shown, so the first move into Park has it ready to take the robot
   * from the field; it draws nothing until it is shown. */
  import("./park3d.js")
    .then((mod) => {
      parkState.loading = false;
      const linked = nt.status.connected || demo.on;
      parkState.layout = mod.layoutCallouts;
      parkState.scene = mod.createPark($("#parkCanvas"), { reducedMotion: reducedMotion() });
      parkState.lastSpec = JSON.stringify(parkSpec(linked));
      parkState.scene.setRobot(JSON.parse(parkState.lastSpec));
      parkState.lastAlliance = linked ? alliance() : null;
      parkState.scene.setAlliance(parkState.lastAlliance);
      parkState.scene.setTeamNumber(parkTeam(linked));
      parkState.offFrame = parkState.scene.onFrame(placeCallouts);
      /* The studio reflections and every shader the stage needs, done while nothing is watching, so the
         first move into Park does not stall on its first frame doing them. */
      const warm = () => parkState.scene?.prepare?.();
      if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 2000 });
      else setTimeout(warm, 300);
      if (parkState.on) {
        /* Park was asked for before the stage existed, and faded in empty. It can draw now. */
        parkState.scene.setActive(true);
        placeCallouts();
      }
    })
    .catch((err) => {
      parkState.loading = false;
      parkState.failed = true;
      console.warn("park view unavailable", err);
      $("#parkHint").textContent = "The robot model could not be drawn on this machine.";
    });
}

/* ---- the moves between Park and Drive ----
 *
 * Tesla's shift out of Park: the parked car shrinks into its driving visualisation and the world comes
 * in round it. Here the robot on the Park stage travels onto the field tile - the stage's camera flies
 * to the exact shot the field view has of the robot, so the robot itself shrinks, turns and settles
 * into place - while the stage's black ground and floor fade and the board comes up behind it, from a
 * touch larger than life to its place, as one piece. The field view takes the robot over in the frame
 * it lands. Going into Park runs the same path backwards: the robot lifts off the field and grows back
 * into the middle as the board recedes into the dark behind it.
 *
 * One thing moves - the robot, on a critically damped spring - and everything else is a fade or a
 * slight scale of a whole layer, so the compositor carries it and nothing is laid out mid-move. There
 * are no edges sweeping across the board, and nothing is revealed piecemeal.
 *
 * Getting to the board is never held up for the show. It is live under the stage from the first frame
 * out, and a move is cut short and reversed from exactly where it is the instant the robot's state
 * changes again. With nothing to hand over - no field tile, no robot on it, reduced motion - Park
 * simply fades. */

const DRIVE_MOVE_MS = 900;     // into Drive
const PARK_MOVE_MS = 1000;     // into Park: a touch longer, a more deliberate lift

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Hermite smoothstep of `x` from `a` to `b`. */
function ramp(a, b, x) {
  const u = clamp01((x - a) / (b - a));
  return u * u * (3 - 2 * u);
}

/**
 * The field tile that can take the robot from Park or give it back: its entry, its scene, and its canvas
 * as a rectangle measured from Park's canvas, as the board lays it out at rest. Null when there is no
 * such tile.
 */
function fieldHandover() {
  const board = $("#board");
  const park = $("#parkCanvas").getBoundingClientRect();
  if (!park.width || !park.height) return null;
  /* Measured with the board at its resting size, even mid-move, so a move cut short lands where the
     robot will really be drawn. */
  const scaled = board.style.transform;
  board.style.transform = "";
  try {
    for (const entry of live.values()) {
      if (entry.item.type !== "field" || !entry.state.scene || !entry.tile?.isConnected) continue;
      const r = entry.body.querySelector("[data-x=canvas]")?.getBoundingClientRect();
      if (!r || r.width < 40 || r.height < 40) continue;
      const b = board.getBoundingClientRect();
      return {
        entry,
        scene: entry.state.scene,
        rect: { x: r.left - park.left, y: r.top - park.top, w: r.width, h: r.height },
        /* The board grows and shrinks about the field tile, so it seems to come out of the car panel
           and to go back into it. */
        origin: `${(r.left + r.width / 2 - b.left).toFixed(1)}px ${(r.top + r.height / 2 - b.top).toFixed(1)}px`,
      };
    }
    return null;
  } finally {
    board.style.transform = scaled;
  }
}

/* The board's own fade and scale during a move, written straight to its style every frame. It is its
   own compositor layer for the length of the move, so a frame of the move is the GPU moving one texture
   rather than the browser repainting every tile on the board. */
function styleBoard(opacity, scale, origin) {
  const board = $("#board");
  if (board.style.willChange !== "opacity, transform") board.style.willChange = "opacity, transform";
  board.style.opacity = opacity >= 0.999 ? "" : Math.max(0, opacity).toFixed(3);
  board.style.transform = Math.abs(scale - 1) < 1e-4 ? "" : `scale(${scale.toFixed(4)})`;
  if (origin !== undefined) board.style.transformOrigin = origin;
}

function restBoard() {
  const board = $("#board");
  board.style.opacity = "";
  board.style.transform = "";
  board.style.transformOrigin = "";
  board.style.willChange = "";
}

/* The stage's black ground, a layer of its own under the robot. A move fades it by opacity, which the
   compositor does alone; fading the stage's background colour instead repainted the whole screen on
   every frame of the move. */
function styleGround(opacity) {
  $("#parkGround").style.opacity = opacity >= 0.999 ? "" : Math.max(0, opacity).toFixed(3);
}

/* Where a move cut short left things, so the next move starts from what is on screen. */
function boardOpacityNow() {
  const set = $("#board").style.opacity;
  if (set !== "") return Number(set);
  return app.dataset.park === "on" ? 0 : 1;
}
function boardScaleNow() {
  const match = /scale\(([\d.]+)\)/.exec($("#board").style.transform);
  return match ? Number(match[1]) : 1;
}
function groundNow(el) {
  if (el.hidden) return 0;
  const set = $("#parkGround").style.opacity;
  return set === "" ? 1 : Number(set);
}

function showPark() {
  const el = $("#park");
  clearTimeout(parkState.hideTimer);
  const move = ++parkState.move;
  loadParkScene();
  const scene = parkState.scene;
  const cutShort = Boolean(scene?.flying) && !el.hidden;
  const onBoard = app.dataset.park !== "on";
  const ground = cutShort ? groundNow(el) : 0;
  const boardFrom = cutShort ? boardOpacityNow() : 1;
  const scaleFrom = cutShort ? boardScaleNow() : 1;
  /* Laid out so it can be measured, and see-through until the move has decided how it starts: every
     style written before this function returns lands in the same frame. */
  el.hidden = false;
  if (!cutShort) styleGround(0);
  const hand = scene && onBoard && !reducedMotion() ? fieldHandover() : null;
  const shot = hand && !cutShort ? hand.scene.shot() : null;

  if (!hand || (!cutShort && !shot)) {
    /* Nothing to lift off the field: fade in. */
    styleGround(1);
    restBoard();
    el.dataset.ui = "on";
    el.dataset.state = "in";
    app.dataset.park = "entering";
    scene?.setActive(true);
    // The board stops drawing once Park covers it, so two scenes are never rendered at once.
    parkState.hideTimer = setTimeout(() => {
      if (parkState.on && move === parkState.move) app.dataset.park = "on";
    }, PARK_FADE_MS);
    return;
  }

  el.dataset.state = "fly";
  el.dataset.ui = "off";
  app.dataset.park = "entering";
  paintParkInfo();
  scene.setActive(true);
  const flight = scene.fly({
    from: cutShort ? "current" : { ...shot, rect: hand.rect },
    to: "stage",
    duration: PARK_MOVE_MS,
    /* The field view under the rising robot draws in step with it. */
    sync: (now) => hand.scene.frame(now),
    onProgress(eased, raw) {
      /* The board recedes first, into the car panel it came out of; the dark comes up behind the robot
         as it lifts; the stage's words come back once it is nearly home. */
      const away = ramp(0, 0.45, eased);
      styleBoard(boardFrom * (1 - away), scaleFrom + (0.965 - scaleFrom) * ramp(0, 0.7, eased), hand.origin);
      styleGround(ground + (1 - ground) * ramp(0.1, 0.6, eased));
      if (raw > 0.7 && el.dataset.ui !== "on") el.dataset.ui = "on";
    },
  });
  /* The stage's first frame is drawn now, with the robot exactly where the field view has it, so the
     field view's own robot can go in the same frame without a flicker of neither or both. */
  scene.renderNow();
  hand.scene.setRobotShown(false);
  hand.entry.tile.dataset.handover = "true";

  flight.then((landed) => {
    if (!landed || move !== parkState.move) return;
    app.dataset.park = "on";
    delete el.dataset.state;
    el.dataset.ui = "on";
    styleGround(1);
    restBoard();
    hand.scene.setRobotShown(true);
    delete hand.entry.tile.dataset.handover;
    placeCallouts();
  });
}

function hidePark() {
  const el = $("#park");
  clearTimeout(parkState.hideTimer);
  const move = ++parkState.move;
  const scene = parkState.scene;
  const ground = groundNow(el);
  const boardFrom = app.dataset.park === "on" ? 0 : boardOpacityNow();
  const scaleFrom = app.dataset.park === "on" ? 1.03 : boardScaleNow();
  /* The board is back under the stage from the first frame, live, drawn but not yet seen. */
  app.dataset.park = "leaving";
  const hand = scene && !el.hidden && !reducedMotion() ? fieldHandover() : null;
  if (hand) {
    styleBoard(boardFrom, scaleFrom, hand.origin);
    /* The field view is told the robot is enabled before it is asked where its camera will be, so the
       stage lands on the driving camera and not on the parked one it is about to leave. */
    hand.entry.spec.update(hand.entry.body, hand.entry.item.cfg, hand.entry.refs, hand.entry.tile, hand.entry.state);
    hand.scene.settle();
  }
  for (const entry of live.values()) entry.spec.onShow?.(entry.state);
  const shot = hand ? hand.scene.shot() : null;

  if (!hand || !shot) {
    /* Nothing to land on: fade out over the board, whose field view swings in from above. */
    restBoard();
    el.dataset.state = "out";
    styleGround(1);
    for (const entry of live.values()) entry.state.scene?.arrive?.();
    parkState.hideTimer = setTimeout(() => {
      if (parkState.on || move !== parkState.move) return;
      el.hidden = true;
      app.dataset.park = "off";
      parkState.scene?.setActive(false);
    }, PARK_FADE_MS);
    return;
  }

  hand.scene.setRobotShown(false);
  hand.entry.tile.dataset.handover = "true";
  el.dataset.state = "fly";
  el.dataset.ui = "off";
  scene
    .fly({
      from: "current",
      /* Read again every frame: the robot is enabled and may already be driving, and the field view's
         camera follows it, so the shot to land on at the end is not the one there was at take-off. */
      to: () => {
        const now = hand.scene.shot();
        return now ? { ...now, rect: hand.rect } : null;
      },
      duration: DRIVE_MOVE_MS,
      /* The field view draws each frame first, so the shot read from it is the one on its canvas. */
      sync: (now) => hand.scene.frame(now),
      onProgress(eased) {
        /* The dark lifts as the robot starts to move, and the board comes up behind it and settles to
           its size as the robot lands. */
        styleGround(ground * (1 - ramp(0.02, 0.42, eased)));
        styleBoard(boardFrom + (1 - boardFrom) * ramp(0.05, 0.5, eased), scaleFrom + (1 - scaleFrom) * eased, hand.origin);
      },
    })
    .then((landed) => {
      if (!landed || move !== parkState.move) return;
      /* Landed: the field view takes the robot over in the same animation frame as the stage's last,
         from the same shot, under the same lights. */
      hand.scene.setRobotShown(true);
      hand.scene.frame(performance.now());
      el.hidden = true;
      delete el.dataset.state;
      styleGround(1);
      restBoard();
      app.dataset.park = "off";
      scene.setActive(false);
      delete hand.entry.tile.dataset.handover;
    });
}

/* The callouts follow the model as it turns. park3d.js's layoutCallouts sets each label beside the
 * robot on its part's side and level with the part, never over the model, where white words on the
 * silver frame could not be read, and a hairline runs from the label to a dot on the part. The bands
 * keep the labels clear of the name at the top left, the cards along the bottom, and the Dashboard
 * button and the hint on the right. With no robot connected there is nothing to say about its parts,
 * so the model stands alone. */
function placeCallouts() {
  const scene = parkState.scene;
  if (!scene || !parkState.on || !parkState.layout) return;
  /* Mid-move the labels are hidden, and measuring them sixty times a second would cost a layout a
     frame. They are placed again when the stage lands. */
  if (scene.flying) return;
  const canvas = $("#parkCanvas");
  const svg = $("#parkLines");
  const labels = [...document.querySelectorAll("#parkCallouts .callout")];
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const linked = nt.status.connected || demo.on;
  if (!w || !h || !linked) {
    for (const label of labels) if (label.dataset.on !== "false") label.dataset.on = "false";
    if (svg.innerHTML) svg.innerHTML = "";
    return;
  }

  /* Every read before any write, so a frame costs one layout however many labels there are. */
  const origin = canvas.getBoundingClientRect();
  const edge = (el, side) => {
    const r = el?.getBoundingClientRect();
    return r && r.height > 0 ? r[side] - origin.top : null;
  };
  const head = edge($(".park-head"), "bottom") ?? 0;
  const cards = edge($(".park-cards"), "top") ?? h;
  const dash = edge($("#parkDash"), "bottom") ?? 0;
  const hint = edge($("#parkHint"), "top") ?? h;
  const sizes = {};
  for (const label of labels) sizes[label.dataset.anchor] = { w: label.offsetWidth, h: label.offsetHeight };
  const spots = parkState.layout(scene.anchors(), scene.bounds(), sizes, {
    w, h, top: 16, left: [head + 24, cards - 24], right: [dash + 24, Math.min(cards, hint) - 24],
  });

  let lines = "";
  for (const label of labels) {
    const spot = spots[label.dataset.anchor];
    const on = spot ? "true" : "false";
    if (label.dataset.on !== on) label.dataset.on = on;
    if (!spot) continue;
    if (label.dataset.side !== spot.side) label.dataset.side = spot.side;
    label.style.transform = `translate(${spot.x.toFixed(1)}px, ${spot.y.toFixed(1)}px)`;
    const [x1, y1, x2, y2] = spot.line.map((v) => v.toFixed(1));
    lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/><circle cx="${x2}" cy="${y2}" r="3"/>`;
  }
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = lines;
}

/* ---- the last drive ----
 *
 * Tesla writes up every drive; Console writes up every stretch the robot was enabled: how long, how
 * far, how fast, and how low the battery went. It is kept for the session and shown on Park, which is
 * where the driver is looking once the robot is disabled again. Distance comes from the robot's pose,
 * so a robot that publishes none still gets its time and its battery. */
const DRIVE_POSE_KEY = "/Catalyst/Physics/PoseArray";
const driveLog = { current: null, last: null };

/* ---- the robot's mechanisms ----
 *
 * Read once per paint for both 3D views (see mechanisms.js). The hopper estimate lives here rather than
 * in either view, so the field view's volley and the balls in the hopper agree, and it starts each match
 * from the preload the moment autonomous begins. `fired` only ever counts up; the field view launches a
 * ball for each one it has not seen. */
const mechanismState = { now: null, at: null, fired: 0, wasEnabled: false, hopper: createHopper() };

function trackMechanisms(now) {
  const linked = nt.status.connected || demo.on;
  const m = linked ? readMechanisms(ntView) : null;
  mechanismState.now = m && hasMechanisms(m) ? m : null;
  const enabled = linked && ds.enabled;
  if (enabled && !mechanismState.wasEnabled && ds.auto) mechanismState.hopper.reset();
  mechanismState.wasEnabled = enabled;
  const dt = mechanismState.at === null ? 0 : (now - mechanismState.at) / 1000;
  mechanismState.at = now;
  if (mechanismState.now && enabled) mechanismState.fired += mechanismState.hopper.step(dt, mechanismState.now);
}

function trackDrive(now) {
  const linked = nt.status.connected || demo.on;
  const d = driveLog.current;
  if (!(linked && ds.enabled)) {
    /* An enable shorter than a second is a slip of the finger, not a drive. */
    if (d && now - d.start >= 1000) driveLog.last = { ...d, seconds: (now - d.start) / 1000 };
    driveLog.current = null;
    return;
  }
  const drive = d ?? (driveLog.current = {
    start: now, metres: 0, top: 0, speed: 0, lowest: null, pose: null, at: now, posed: false,
  });
  const volts = batteryVolts();
  if (volts !== null) drive.lowest = drive.lowest === null ? volts : Math.min(drive.lowest, volts);

  const pose = robotPlacement(ntView, { poseKey: DRIVE_POSE_KEY, age: poseAge }).pose;
  if (!pose) return;
  drive.posed = true;
  if (drive.pose) {
    const step = Math.hypot(pose[0] - drive.pose[0], pose[1] - drive.pose[1]);
    const dt = (now - drive.at) / 1000;
    /* Waits for the pose to move, so a pose published more slowly than the board paints is not read
       as a robot stopping between samples. */
    if (step === 0 && dt < 0.5) return;
    /* A pose reset jumps metres at once, faster than any FRC robot drives; it is not distance. */
    if (dt > 0 && step / dt <= 8) {
      drive.metres += step;
      drive.speed += (step / dt - drive.speed) * 0.35;
      drive.top = Math.max(drive.top, drive.speed);
    }
  }
  drive.pose = [pose[0], pose[1]];
  drive.at = now;
}

/* The words on Park: who the robot is, its state, its charge, what each callout points at, and the
 * four cards. Written only when they change; Park repaints with the rest of the board at 10 Hz. */
function paintParkInfo() {
  const linked = nt.status.connected || demo.on;
  let changed = false;
  const setText = (sel, text) => {
    const el = $(sel);
    if (el && el.textContent !== text) {
      el.textContent = text;
      changed = true;
    }
  };
  const remembered = linked ? null : lastRobot;

  const name = linked ? (str(`${SPEC_ROOT}Identity/Name`, "") || "Robot") : (remembered?.name || "Robot");
  const team = parkTeam(linked);
  setText("#parkName", team ? `${name} · ${team}` : name);
  const side = linked ? alliance() : null;
  const looking = nt.status.address ? `Looking for ${nt.status.address}…` : null;
  setText("#parkSub", linked
    ? [ds.estop ? "Emergency stopped" : "Disabled", side && `${side === "red" ? "Red" : "Blue"} alliance`, demo.on && "demo data"]
        .filter(Boolean).join(" · ")
    : remembered?.seen
      ? `${looking || "Not connected"} · last seen ${agoText(Date.now() - remembered.seen)}`
      : (looking || "No robot"));

  const volts = linked ? batteryVolts() : null;
  setText("#parkVolts", volts === null ? "—" : volts.toFixed(1));
  $("#parkVolts").dataset.empty = String(volts === null);
  const ready = batteryReadiness(volts);
  const charge = $("#parkCharge");
  if (charge.hidden !== !ready) {
    charge.hidden = !ready;
    changed = true;
  }
  if (ready) {
    if (charge.dataset.level !== ready.level) charge.dataset.level = ready.level;
    const width = `${(ready.fill * 100).toFixed(0)}%`;
    const fill = $("#parkChargeFill");
    if (fill.style.width !== width) fill.style.width = width;
    setText("#parkChargeText", ready.text);
  }

  const summary = linked ? deviceSummary(ntView) : null;
  const count = (c) => `${c.connected ?? 0}/${c.expected}`;
  const place = linked ? robotPlacement(ntView, { age: poseAge }) : null;
  const cameras = summary?.cameras?.expected ? `${count(summary.cameras)} cameras` : "";
  const placedBy = !place ? "" : !place.placed ? "not placed yet" : place.source === "vision" ? "placed by vision" : "";
  setText('[data-c="vision"]', [cameras, placedBy].filter(Boolean).join(" · ") || "—");
  setText('[data-c="battery"]', volts === null ? "—" : `${volts.toFixed(1)} V`);
  const modules = linked ? num(`${SPEC_ROOT}Drivetrain/Modules`, null) : null;
  const drive = linked ? str(`${SPEC_ROOT}Drivetrain/Type`, "") : "";
  setText('[data-c="drivetrain"]', modules ? `${drive || "Drive"} · ${modules} modules` : (drive || "—"));
  const kind = linked ? (str("/Catalyst/Devices/Controller/Kind", "") || str(`${SPEC_ROOT}Identity/Controller`, "")) : "";
  setText('[data-c="controllerName"]', kind || "Controller");
  const temp = linked ? num("/Catalyst/Systemcore/TempCelsius", null) : null;
  const cpu = linked ? num("/Catalyst/Systemcore/CpuPercent", null) : null;
  setText('[data-c="controller"]',
    [temp !== null && `${temp.toFixed(0)} °C`, cpu !== null && `CPU ${cpu.toFixed(0)}%`].filter(Boolean).join(" · ") || "—");

  const event = linked ? str("/FMSInfo/EventName", "") : "";
  const match = linked ? num("/FMSInfo/MatchNumber", null) : null;
  setText("#parkMatch", match ? `Match ${match}` : linked ? "Practice" : "—");
  setText("#parkMatchSub", [event, side && `${side === "red" ? "Red" : "Blue"} alliance`].filter(Boolean).join(" · ") || "No event");

  const options = linked ? (arr("/Auto Selector/options") || []) : [];
  const chosen = str("/Auto Selector/selected", null) ?? str("/Auto Selector/active", null);
  setText("#parkAuto", options.length ? (chosen || options[0]) : "—");
  setText("#parkAutoSub", options.length ? `${options.length} routines · change it from the dock` : "No chooser published");

  const loop = linked ? num("/Catalyst/Loop/Robot/AverageMs", null) : null;
  const active = noticeSeen.size;
  setText("#parkHealth", !linked ? "—" : active ? `${active} alert${active === 1 ? "" : "s"}` : "All clear");
  setText("#parkHealthSub",
    [summary?.motors?.expected && `${count(summary.motors)} motors`, loop !== null && `loop ${loop.toFixed(1)} ms`]
      .filter(Boolean).join(" · ").replace(/^./, (c) => c.toUpperCase()) || "Loop time unknown");

  const last = driveLog.last;
  if (!last) {
    setText("#parkDrive", "—");
    setText("#parkDriveSub", "No drive yet this session");
  } else {
    const time = `${Math.floor(last.seconds / 60)}:${String(Math.floor(last.seconds % 60)).padStart(2, "0")}`;
    const far = last.metres < 100 ? last.metres.toFixed(1) : last.metres.toFixed(0);
    setText("#parkDrive", last.posed ? `${far} m · ${time}` : time);
    setText("#parkDriveSub",
      [last.posed && `top ${last.top.toFixed(1)} m/s`, last.lowest !== null && `lowest ${last.lowest.toFixed(1)} V`]
        .filter(Boolean).join(" · ").replace(/^./, (c) => c.toUpperCase()) || "Nothing published to measure");
  }

  if (parkState.scene) {
    if (parkState.lastAlliance !== side) {
      parkState.lastAlliance = side;
      parkState.scene.setAlliance(side);
    }
    const spec = JSON.stringify(parkSpec(linked));
    if (parkState.lastSpec !== spec) {
      parkState.lastSpec = spec;
      parkState.scene.setRobot(JSON.parse(spec));
    }
    parkState.scene.setTeamNumber(team);
  }
  /* A label that changed width has to move, even while the model is still and drawing nothing. */
  if (changed) placeCallouts();
}

function paintPark() {
  if ((nt.status.connected || demo.on) && settings.parkView !== false) loadParkScene();
  const want = parkWanted(performance.now());
  if (want !== parkState.on) {
    parkState.on = want;
    if (want) showPark(); else hidePark();
  }
  if (parkState.on) paintParkInfo();
}

$("#parkDash").onclick = () => {
  parkState.dismissed = true;
  paintPark();
};
/* Tesla's P, for a robot: pressing the lit D while the robot is disabled parks the view again after
 * "Dashboard" put it away. */
$("#gears").addEventListener("click", () => {
  const linked = nt.status.connected || demo.on;
  if (linked && ds.enabled) return;
  parkState.dismissed = false;
  parkState.since = -Infinity;
  paintPark();
});



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
  [["5"], "CAN"],
  [["S"], "Settings"],
  [["D"], "Demo data on or off"],
  [["E"], "Edit layout"],
  [["A"], "Add a component"],
  [["L"], "Settings, on the layout"],
  [["?", "F1"], "Settings, on About"],
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
    ["robot.local", "Systemcore's mDNS name"],
    ["172.26.0.1", "Systemcore over USB"],
    [known ? `10.${Math.floor(team / 100)}.${team % 100}.2` : "10.TE.AM.2", "the pit's static IP"],
    [`roborio-${known ? team : "TEAM"}-frc.local`, "a roboRIO's mDNS name"],
    ["172.22.11.2", "a roboRIO over USB"],
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
/** Mark the selected option and slide the pill onto it. One slot of travel is 100% of its own width. */
function paintChoice(id, value) {
  const choice = $(id);
  if (!choice) return;
  const buttons = [...choice.querySelectorAll("button")];
  const i = Math.max(0, buttons.findIndex((b) => b.dataset.v === value));
  buttons.forEach((b, n) => b.setAttribute("aria-checked", String(n === i)));
  choice.querySelector(".choicesel").style.transform = `translateX(${i * 100}%)`;
}

function paintCamera() {
  paintChoice("#setCamera", settings.fieldCamera);
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

  /* Release notes only when there is a release to take. Showing the installed version's own notes
   * would be a changelog, and this page is a decision: take this or do not. `textContent`, never
   * `innerHTML` — the body arrives from the network and this program has no business executing it. */
  const notes = $("#relNotes");
  const body = info && info.available ? String(info.notes || "").trim() : "";
  notes.hidden = !body;
  if (body) {
    $("#relNotesVer").textContent = `v${info.version}`;
    $("#relNotesBody").textContent = body;
  }

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

/* The quick controls at the top of the Robot section, after the row of big square buttons at the top
 * of Tesla's Controls screen.
 *
 * None of them is a setting of its own. Each presses a control that already exists, through the same
 * function that control calls - `setDemo`, the team field, `setCamera`, the field model switch, the
 * units choice - and `paintQuick` reads every state back from where that control reads it. So a tile
 * and its control cannot disagree, and a tile cannot do anything its control would not. The reset is
 * wired in `buildSettings`, beside the button whose two presses it shares. */
const CAMERA_WORDS = { chase: "Chase", top: "Overhead", free: "Free" };
/* The field tile's own drawing for each camera, so the tile shows the camera in use the way the round
 * buttons on the field do. */
const CAMERA_GLYPHS = {
  chase: `<rect x="8" y="4" width="8" height="10" rx="2"/><path d="M5 20l3-4h8l3 4"/>`,
  top: `<rect x="4" y="4" width="16" height="16" rx="2.5"/><rect x="9.5" y="9" width="5" height="6" rx="1"/>`,
  free: `<ellipse cx="12" cy="12" rx="9" ry="3.6"/><path d="M18 7.5l2.2 1.3-1 2.3"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>`,
};

function wireQuick() {
  $("#qDemo").onclick = () => setDemo(!demo.on);
  /* Where the link chip in the status bar goes too. The team number decides which addresses the
   * console tries, so finding a different robot is changing that field. */
  $("#qTeam").onclick = () => {
    const input = $("#setTeam");
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    input.closest(".srow").scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    if (!input.disabled) input.focus({ preventScroll: true });
  };
  $("#qCamera").onclick = () => {
    setCamera(CAMERAS[(CAMERAS.indexOf(settings.fieldCamera) + 1) % CAMERAS.length]);
    paintQuick();
  };
  $("#qModel").onclick = () => $("#setModel").click();
  $("#qUnits").onclick = () => {
    const next = UNITS[(UNITS.indexOf(settings.units) + 1) % UNITS.length];
    $("#setUnits").querySelector(`button[data-v="${next}"]`)?.click();
    paintQuick();
  };
}

/* Runs inside the 10 Hz paint while the Robot section is open, so nothing is written that has not
 * changed. */
function paintQuick() {
  const state = (id) => $(id).querySelector("small");
  const press = (id, on) => {
    const v = String(on);
    if ($(id).getAttribute("aria-pressed") !== v) $(id).setAttribute("aria-pressed", v);
    setText(state(id), on ? "On" : "Off");
  };

  press("#qDemo", demo.on);
  press("#qModel", settings.fieldModel);
  setText(state("#qTeam"), teamNumber ? String(teamNumber) : "—");
  setText(state("#qUnits"), settings.units === "imperial" ? "Imperial" : "Metric");

  const camera = $("#qCamera");
  if (camera.dataset.mode !== settings.fieldCamera) {
    camera.dataset.mode = settings.fieldCamera;
    camera.querySelector("svg").innerHTML = CAMERA_GLYPHS[settings.fieldCamera];
    setText(state("#qCamera"), CAMERA_WORDS[settings.fieldCamera]);
  }
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
  $("#setSearch").oninput = (e) => applySearch(e.target.value);
  wireQuick();

  $("#gCopy").onclick = async () => {
    const text = sheetAsText();
    const note = $("#gCopyNote");
    if (!text) { note.textContent = "Nothing to copy yet."; return; }
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = "Copied.";
    } catch {
      /* Clipboard access can be refused, and saying "copied" when nothing was is the interface
       * inventing a fact about itself. */
      note.textContent = "The clipboard refused. Select the sheet and copy it by hand.";
    }
    setTimeout(() => { note.textContent = ""; }, 4000);
  };

  teamNoteDefault = $("#teamNote").textContent.trim();
  $("#setTeam").onchange = applyTeam;

  for (const b of $("#setUnits").querySelectorAll("button")) {
    b.onclick = () => {
      settings.units = b.dataset.v;
      saveSettings();
      paintChoice("#setUnits", settings.units);
      /* The sheet is formatted at paint time, so re-running it is the whole conversion. Tiles pick
       * the new units up on their next frame, which is within 100 ms. */
      paintGarage();
    };
  }

  for (const b of $("#setStartView").querySelectorAll("button")) {
    b.onclick = () => {
      settings.startView = b.dataset.v;
      saveSettings();
      paintChoice("#setStartView", settings.startView);
      /* Deliberately does not switch the view now. This says where the console opens, and yanking
       * someone out of Settings into Logs to demonstrate that would be the setting acting on the
       * wrong occasion. */
    };
  }

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
  const parkTog = $("#setPark");
  parkTog.setAttribute("aria-checked", String(settings.parkView));
  parkTog.onclick = () => {
    settings.parkView = !settings.parkView;
    saveSettings();
    parkTog.setAttribute("aria-checked", String(settings.parkView));
    paintPark();
  };

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
   * button that arms itself asks the question without putting anything in front of anything.
   *
   * The quick control at the top of the Robot section is this button in a second place, so it arms and
   * fires through the same two presses and each shows the other armed. Its page cannot see the board
   * or the status line under the Dashboard rows, so the tile says itself that the press took. */
  const reset = $("#resetBoard");
  const quickReset = $("#qReset");
  const quickResetState = quickReset.querySelector("small");
  let armed = 0;
  let settled = 0;
  const showArmed = (on) => {
    reset.classList.toggle("armed", on);
    quickReset.classList.toggle("armed", on);
    reset.textContent = on ? "Press again" : "Reset";
    quickResetState.textContent = on ? "Press again" : "Press twice";
  };
  const disarm = () => {
    clearTimeout(armed);
    armed = 0;
    showArmed(false);
  };
  const pressReset = () => {
    clearTimeout(settled);
    if (!armed) {
      showArmed(true);
      armed = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    resetBoard();
    setLayoutStatus("The board is back to the layout the console ships with.", "ok");
    quickResetState.textContent = "Done";
    settled = setTimeout(() => { quickResetState.textContent = "Press twice"; }, 2500);
  };
  reset.onclick = pressReset;
  quickReset.onclick = pressReset;

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

/* Filter every row in every section at once, in place. A match stays where it lives and keeps the
 * handler it was built with, so a setting found by searching is changed the same way as one found by
 * navigating — which is the whole point of searching for it. */
function clearSearchState() {
  const root = $("#settings");
  root.dataset.search = "false";
  $("#setSearch").value = "";
  for (const row of root.querySelectorAll(".srow")) row.hidden = false;
  for (const sec of root.querySelectorAll(".ssec")) delete sec.dataset.hits;
  $("#setNoHits").hidden = true;
}

function applySearch(raw) {
  const root = $("#settings");
  const query = (raw || "").trim().toLowerCase();

  if (!query) {
    clearSearchState();
    showSection(currentSection);
    return;
  }
  root.dataset.search = "true";

  let total = 0;
  for (const sec of root.querySelectorAll(".ssec")) {
    let hits = 0;
    for (const row of sec.querySelectorAll(".srow")) {
      /* The label, its explanation and any text on the control, so "imperial" reaches Units through
       * the segmented control rather than the label. Worth knowing what this does NOT do: it matches
       * the words on screen and nothing else, so a synonym finds nothing. Cutting the row copy down
       * narrowed what is searchable along with it. */
      const on = row.textContent.toLowerCase().includes(query);
      row.hidden = !on;
      if (on) hits++;
    }
    sec.dataset.hits = String(hits);
    /* About holds prose rather than rows, so it never matches and never claims to. */
    if (hits) sec.dataset.active = "true";
    else delete sec.dataset.active;
    total += hits;
  }

  $("#setNoHitsQ").textContent = raw.trim();
  $("#setNoHits").hidden = total > 0;
  $("#spane").scrollTop = 0;
  paintSettings();
}

function showSection(name) {
  const root = $("#settings");
  /* A section picked while a filter is up would be hidden by it, so navigating drops the filter and
   * then goes where it was asked. A no-op when nothing is being searched. */
  clearSearchState();
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
  /* A filter left up from last time would have the panel open on a search nobody is running. */
  clearSearchState();
  showSection(section || currentSection);
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

/** The last sheet the panel rendered, so copying it cannot disagree with what is on screen. */
let sheetForCopy = null;

/* The robot publishes SI, because that is what WPILib works in. Imperial is a display choice made
 * here, and it is worth offering: FRC writes its frame perimeter and height rules in inches, so a
 * team checking whether they are legal is converting these numbers by hand otherwise. Every figure
 * on the wire stays metric — only the label changes. */
const IN_PER_M = 39.3700787;
const imperial = () => settings.units === "imperial";

const metres = (v) => (imperial()
  ? `${(v * IN_PER_M).toFixed(1)} in`
  : `${v.toFixed(v < 1 ? 3 : 2)} m`);
const millis = (v) => (imperial()
  ? `${(v * IN_PER_M).toFixed(2)} in`
  : `${(v * 1000).toFixed(0)} mm`);
const mass = (v) => (imperial() ? `${(v * 2.2046226).toFixed(1)} lb` : `${v.toFixed(1)} kg`);
const speed = (v) => (imperial() ? `${(v * 3.2808399).toFixed(2)} ft/s` : `${v.toFixed(2)} m/s`);
const span = (l, w) => (imperial()
  ? `${(l * IN_PER_M).toFixed(1)} × ${(w * IN_PER_M).toFixed(1)} in`
  : `${(l * 1000).toFixed(0)} × ${(w * 1000).toFixed(0)} mm`);

/* Composite rows arrive pipe-delimited — "Kraken X60|8" for the inventory, "3|Climber" for a power
 * channel — the order differs per key and each caller names its own halves. That is how the
 * library already serialises a device list. Split rather than parsed: a value containing a pipe is
 * the library's problem to prevent, not something to guess at here. */
const pairs = (key, fmt) => {
  const rows = arr(`${SPEC_ROOT}${key}`);
  return rows && rows.length ? rows.map((r) => fmt(...String(r).split("|"))).join(", ") : null;
};

/* Readers, so the table below stays a table. `n` treats zero as absent, which is safe because the
 * library only ever publishes a figure it has checked is positive — see SpecSheet.positive. `b` does
 * not, because false is a real answer to "is this on CAN FD". */
const S = {
  s: (k) => str(`${SPEC_ROOT}${k}`),
  n: (k, fmt) => { const v = num(`${SPEC_ROOT}${k}`); return v ? fmt(v) : null; },
  b: (k, yes, no) => { const v = bool(`${SPEC_ROOT}${k}`); return v === null ? null : (v ? yes : no); },
  mm: (k) => S.n(k, millis),
};

/* Declarative on purpose. A spec sheet grows every season, and a table is the difference between
 * adding a line and editing a render function. Each entry returns a formatted string or null, and
 * null means the robot did not publish it — so it is left out rather than dashed. A dash would say
 * "this robot has no gyro"; absence says "it did not mention one", and only the second is true. */
const SPEC_GROUPS = [
  ["Software", [
    ["Catalyst", () => {
      const v = S.s("Software/CatalystVersion");
      if (!v) return null;
      /* The sha earns its place beside the version because a team mid-season is usually running a
       * build between releases, and "1.10.0" alone cannot tell two of those apart. */
      const sha = S.s("Software/CatalystGitSha");
      const dirty = bool(`${SPEC_ROOT}Software/CatalystGitDirty`);
      return sha ? `${v} · ${sha}${dirty ? " dirty" : ""}` : v;
    }],
    ["Robot code", () => S.s("Software/RobotCodeVersion")],
    ["Built", () => S.s("Software/RobotCodeBuild") || S.s("Software/CatalystCommitTime")],
    ["WPILib", () => S.s("Software/WPILibVersion")],
    ["Java", () => S.s("Software/JavaVersion")],
  ]],
  /* Canonical key first, Rio-named alias second. Catalyst 2.x renamed these to say "controller"
   * and publishes both for one season so existing layouts keep resolving; reading only the old name
   * would work today and go blank the moment the alias is dropped. Software/FpgaVersion is not here
   * at all - Systemcore has no FPGA and 2027 removed the whole surface, so that row could only ever
   * have been empty. */
  ["Controller", [
    ["Model", () => S.s("Identity/Controller")],
    ["Serial", () => S.s("Identity/ControllerSerial") || S.s("Identity/RioSerial")],
    ["Image", () => S.s("Software/ControllerImage") || S.s("Software/RioImage")],
    ["Comment", () => S.s("Identity/ControllerComment") || S.s("Identity/RioComment")],
  ]],
  ["Drivetrain", [
    ["Type", () => S.s("Drivetrain/Type")],
    ["Modules", () => S.n("Drivetrain/Modules", (v) => String(v))],
    ["Top speed", () => S.n("Drivetrain/MaxSpeedMps", speed)],
    ["Rotation", () => S.n("Drivetrain/MaxAngularRateRadPerSec", (v) => `${(v * 180 / Math.PI).toFixed(0)} °/s`)],
    ["Track width", () => S.n("Drivetrain/TrackWidthMeters", metres)],
    ["Wheelbase", () => S.n("Drivetrain/WheelBaseMeters", metres)],
    ["Wheel radius", () => S.mm("Drivetrain/WheelRadiusMeters")],
    ["Drive ratio", () => S.n("Drivetrain/DriveGearRatio", (v) => `${v.toFixed(2)}:1`)],
    ["Steer ratio", () => S.n("Drivetrain/SteerGearRatio", (v) => `${v.toFixed(2)}:1`)],
    ["Odometry", () => S.n("Drivetrain/OdometryHz", (v) => `${v.toFixed(0)} Hz`)],
    ["CAN bus", () => S.b("Drivetrain/CanFd", "CAN FD", "CAN 2.0")],
  ]],
  ["Chassis", [
    ["Mass", () => S.n("Chassis/MassKg", mass)],
    ["Moment", () => S.n("Chassis/MoiKgM2", (v) => `${v.toFixed(2)} kg·m²`)],
    ["Frame", () => {
      const l = num(`${SPEC_ROOT}Chassis/FrameLengthMeters`), w = num(`${SPEC_ROOT}Chassis/FrameWidthMeters`);
      return l && w ? span(l, w) : null;
    }],
    ["Bumper to bumper", () => {
      const l = num(`${SPEC_ROOT}Chassis/BumperLengthMeters`), w = num(`${SPEC_ROOT}Chassis/BumperWidthMeters`);
      return l && w ? span(l, w) : null;
    }],
    /* Arithmetic on two published numbers, the same licence the library takes for bumper-to-bumper,
     * and the figure a driver actually wants: it is the width that has to clear a gap on the
     * diagonal. Absent whenever either side it is built from is. */
    ["Diagonal", () => {
      const l = num(`${SPEC_ROOT}Chassis/BumperLengthMeters`), w = num(`${SPEC_ROOT}Chassis/BumperWidthMeters`);
      return l && w ? millis(Math.hypot(l, w)) : null;
    }],
    ["Bumper depth", () => S.mm("Chassis/BumperThicknessMeters")],
    ["Height", () => S.n("Chassis/HeightMeters", metres)],
  ]],
  ["Traction", [
    ["Wheel grip", () => S.n("Drivetrain/WheelCof", (v) => `${v.toFixed(2)} µ`)],
    ["Slip current", () => S.n("Drivetrain/SlipCurrentAmps", (v) => `${v.toFixed(0)} A`)],
    ["Drive limit", () => S.n("Drivetrain/DriveCurrentLimitAmps", (v) => `${v.toFixed(0)} A`)],
  ]],
  ["Power", [
    ["Battery", () => S.s("Power/Battery")],
    ["Distribution", () => S.s("Power/Module")],
    ["Channels used", () => {
      const used = arr(`${SPEC_ROOT}Power/ChannelsInUse`), total = num(`${SPEC_ROOT}Power/Channels`);
      if (!used || !used.length) return null;
      return total ? `${used.length} of ${total}` : String(used.length);
    }],
    ["Brownout", () => S.n("Power/BrownoutVolts", (v) => `${v.toFixed(2)} V`)],
  ]],
  ["Hardware", [
    ["CAN devices", () => S.n("Hardware/CanDevices", (v) => String(v))],
    ["Inventory", () => pairs("Hardware/Inventory", (type, count) => `${count} × ${type}`)],
    ["Gyro", () => {
      const g = S.s("Hardware/Gyro"), id = num(`${SPEC_ROOT}Hardware/GyroCanId`);
      return g ? (id ? `${g} · id ${id}` : g) : null;
    }],
    ["Cameras", () => { const c = arr(`${SPEC_ROOT}Hardware/Cameras`); return c && c.length ? c.join(", ") : null; }],
  ]],
];

/* A plan of this robot, to scale, from the figures on the wire. Bumpers, frame and module positions
 * are each drawn only if the robot published them, so a partial sheet gives a partial drawing rather
 * than a confident wrong one. Nose points up, which is +x in WPILib's frame.
 *
 * Rendered rather than diagrammed: this is the one place in the program that is allowed to be a
 * picture of your robot, and a hairline outline does not read as one. Everything it draws is still
 * a published measurement — what is invented here is the lighting, not the geometry. */
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

  const pad = 44;
  const scale = Math.min((cw - pad * 2) / outerW, (ch - pad * 2) / outerL);
  const cx = cw / 2, cy = ch / 2;
  /* Robot +x is forward and +y is to the left; screen y grows downward. */
  const px = (x, y) => [cx - y * scale, cy - x * scale];
  const box = (lengthM, widthM) => [cx - (widthM * scale) / 2, cy - (lengthM * scale) / 2,
                                     widthM * scale, lengthM * scale];

  /* Deliberately not the alliance colour. Alliance is match state — it flips between matches and a
   * team carries both sets of bumpers — so painting it here would make a robot's spec sheet change
   * colour depending on when you happened to open it. This card describes the machine, and the
   * machine is the same robot on either side: the dark shell Park draws it in before it knows. */
  const bumper = PLAN.shell;
  const bumperLit = PLAN.shellLit;

  const outer = box(outerL, outerW);
  const radius = Math.min(16, outer[2] / 7, outer[3] / 7);

  g.save();
  g.shadowColor = shadeAt(0.6);
  g.shadowBlur = 24;
  g.shadowOffsetY = 10;

  if (bumpL && bumpW) {
    /* Bumpers first and filled, because on a real robot they are the outline anyone recognises. */
    const grad = g.createLinearGradient(0, outer[1], 0, outer[1] + outer[3]);
    grad.addColorStop(0, bumperLit);
    grad.addColorStop(1, bumper);
    g.fillStyle = grad;
    g.beginPath(); g.roundRect(...outer, radius); g.fill();
  } else {
    /* No bumper figures, so nothing is drawn as though there were: the frame carries the silhouette
     * and the dashed edge says the outer dimension is not known. */
    g.strokeStyle = lightAt(0.2); g.lineWidth = 1.5; g.setLineDash([6, 5]);
    g.beginPath(); g.roundRect(...outer, radius); g.stroke();
    g.setLineDash([]);
  }
  g.restore();

  if (bumpL && bumpW) {
    /* A dark shell on a dark card is found by its edge, the way Park's is: a hairline of light round
     * the rim, brightest along the top where the light lands and all but gone at the bottom. */
    const rim = g.createLinearGradient(0, outer[1], 0, outer[1] + outer[3]);
    rim.addColorStop(0, lightAt(0.26));
    rim.addColorStop(0.5, lightAt(0.08));
    rim.addColorStop(1, lightAt(0.04));
    g.strokeStyle = rim; g.lineWidth = 1;
    g.beginPath(); g.roundRect(outer[0] + 0.5, outer[1] + 0.5, outer[2] - 1, outer[3] - 1, radius); g.stroke();
  }

  if (frameL && frameW) {
    const inner = box(frameL, frameW);
    const ir = Math.min(11, inner[2] / 8, inner[3] / 8);
    /* The frame deck, as brushed plate: lit from the top left and falling to a darker grey, sitting a
     * little into the shell rather than on top of it. */
    g.save();
    g.shadowColor = shadeAt(0.55); g.shadowBlur = 8;
    const deck = g.createLinearGradient(inner[0], inner[1], inner[0] + inner[2], inner[1] + inner[3]);
    deck.addColorStop(0, PLAN.deck);
    deck.addColorStop(1, PLAN.deckDark);
    g.fillStyle = deck;
    g.beginPath(); g.roundRect(...inner, ir); g.fill();
    g.restore();
    /* The grain runs along the robot's length. Fixed, not random: this repaints ten times a second
     * while the page is open, and a random grain would crawl. */
    g.save();
    g.beginPath(); g.roundRect(...inner, ir); g.clip();
    for (let i = 0, x = inner[0]; x < inner[0] + inner[2]; i++, x += 1.5) {
      const n = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
      g.fillStyle = n > 0.5 ? lightAt(0.035 * (n - 0.5)) : shadeAt(0.07 * (0.5 - n));
      g.fillRect(x, inner[1], 1, inner[3]);
    }
    g.restore();
    g.strokeStyle = lightAt(0.14); g.lineWidth = 1;
    g.beginPath(); g.roundRect(inner[0] + 0.5, inner[1] + 0.5, inner[2] - 1, inner[3] - 1, ir); g.stroke();
  }

  if (mods && mods.length >= 2) {
    /* Wheels, oriented fore-aft, sized off the published radius when there is one. */
    const wr = num(`${SPEC_ROOT}Drivetrain/WheelRadiusMeters`);
    const wl = (wr ? wr * 2 * scale : 22), ww = Math.max(7, wl * 0.34);
    for (let i = 0; i + 1 < mods.length; i += 2) {
      const [sx, sy] = px(mods[i], mods[i + 1]);
      g.save();
      g.shadowColor = shadeAt(0.5); g.shadowBlur = 7;
      const tyre = g.createLinearGradient(sx - ww / 2, 0, sx + ww / 2, 0);
      tyre.addColorStop(0, PLAN.tyre);
      tyre.addColorStop(0.45, PLAN.tyreLit);
      tyre.addColorStop(1, PLAN.tyre);
      g.fillStyle = tyre;
      g.beginPath(); g.roundRect(sx - ww / 2, sy - wl / 2, ww, wl, ww / 2.4); g.fill();
      g.restore();
    }
  }

  /* Which way is forward. A brighter band across the front bumper rather than a floating arrow —
   * it reads at a glance and it is where a team paints their number. Soft, on a dark shell. */
  g.save();
  g.beginPath(); g.roundRect(...outer, radius); g.clip();
  const nose = g.createLinearGradient(0, outer[1], 0, outer[1] + 16);
  nose.addColorStop(0, lightAt(0.16));
  nose.addColorStop(1, lightAt(0));
  g.fillStyle = nose;
  g.fillRect(outer[0], outer[1], outer[2], 16);
  g.restore();

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
  /* The card is lit for a picture. A robot that published a name and no geometry is the ordinary
   * case, not a broken one, so the lighting goes with the drawing rather than hanging over a gap. */
  root.dataset.plan = String(drew);
  /* Says what the drawing is actually built from, so nobody reads a partial plan as a full one. */
  const drawn = [
    num(`${SPEC_ROOT}Chassis/BumperLengthMeters`) && "bumpers",
    num(`${SPEC_ROOT}Chassis/FrameLengthMeters`) && "frame",
    (arr(`${SPEC_ROOT}Drivetrain/ModuleLocations`) || []).length >= 2 && "modules",
  ].filter(Boolean);
  $("#gPlanNote").textContent = drew ? `${drawn.join(", ")} to scale` : "";

  /* Built as data first and rendered from it, so the copy button can write exactly what is on the
   * screen — in whatever units are selected — instead of deriving it a second time and risking the
   * two versions disagreeing about the same robot. */
  const groups = [];
  const group = (title, got) => { if (got.length) groups.push([title, got]); };

  /* What the robot is made to do, ahead of what it is made of. Two robots can have identical
   * drivetrains and motor counts and still be completely different machines, and this is the only
   * part of the sheet that says so. The library records each entry as the component is built, so an
   * absent feature means the robot did not run it — not that it failed to mention it. */
  const inUse = arr(`${SPEC_ROOT}Catalyst/InUse`) || [];
  group("Catalyst", inUse.map((feature) => {
    const key = String(feature).replace(/ /g, "");
    const names = arr(`${SPEC_ROOT}Catalyst/${key}/Names`) || [];
    const count = num(`${SPEC_ROOT}Catalyst/${key}/Count`);
    /* Named instances say more than a tally, so the tally only appears when there is nothing to
     * name, or when there are more than will fit on one line. */
    if (names.length && names.length <= 3) return [feature, names.join(", ")];
    if (names.length) return [feature, `${names.length}`];
    return [feature, count ? String(count) : "yes"];
  }));

  for (const [title, rows] of SPEC_GROUPS) {
    group(title, rows.map(([label, read]) => [label, read()])
      .filter(([, v]) => v !== null && v !== undefined && v !== ""));
  }

  /* The channel map, listed rather than counted. The count above answers "how loaded is the PDH";
   * this answers "which breaker is the one that just popped", and only the robot knows it. Named
   * left and numbered right so the numbers align with every other row on the sheet. */
  const channels = arr(`${SPEC_ROOT}Power/ChannelsInUse`) || [];
  group("Power channels", channels
    .map((row) => String(row).split("|"))
    .filter((p) => p.length === 2 && p[1])
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([channel, what]) => [what, channel]));

  $("#gSpecs").innerHTML = groups.map(([title, rows]) =>
    `<div class="ggroup"><h4>${escapeHtml(title)}</h4>${rows.map(([label, v]) =>
      `<div class="gspec"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(v))}</b></div>`
    ).join("")}</div>`).join("");

  sheetForCopy = { name, sub: $("#gSub").textContent, groups };
}

/* ------------------------------------------------------------------ systemcore

   What the machine reports about itself, read straight off /Catalyst/Systemcore/.

   The rule this page is built on: a reading the machine did not send is absent, never zero. It is
   worth being blunt about why, because getting it wrong is not a cosmetic bug. Storage at 0% and no
   answer from the storage sensor render identically as a number, mean opposite things, and the
   wrong one of them is reassuring. So every helper below returns null for absent and every painter
   draws an em dash and an empty bar for null. Nothing here substitutes a default. */

const CORE = "/Catalyst/Systemcore/";

/* paint() runs at 10 Hz and again on every NetworkTables frame, and most of this page does not
   change between them: a team number, a set of network interfaces and a pair of brownout thresholds
   are fixed for the life of the match. Rewriting innerHTML anyway would destroy and rebuild those
   nodes tens of times a second, which costs layout, drops any text the user had selected, and
   restarts the bar transitions mid-flight.

   Comparing the string first is far cheaper than the write it avoids. */
function setHtml(el, html) {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

/* The same bargain one step down, for the nodes a page rewrites rather than rebuilds. Assigning
   textContent or a style property that already holds that value still dirties the node, and a bar
   whose width is re-set to the width it already has restarts its CSS transition — which is what turns
   a bar easing to a new reading into one that never settles. Reading the property back first is a
   cache hit; writing it is layout. */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setWidth(el, pct) {
  const w = `${pct.toFixed(1)}%`;
  if (el.style.width !== w) el.style.width = w;
}

/* Null clears it, so a reading that goes away takes its colour with it rather than leaving the last
   one behind as a statement about a number that is no longer there. */
function setLevel(el, level) {
  if (level === null || level === undefined) {
    if (el.dataset.level !== undefined) delete el.dataset.level;
  } else if (el.dataset.level !== level) {
    el.dataset.level = level;
  }
}

function setFlag(el, name, on) {
  const v = String(on);
  if (el.dataset[name] !== v) el.dataset[name] = v;
}

/* The wording and the thresholds live in core-format.js so they can be tested: the states they
   describe - a full disk, a worn-out eMMC, a pinned core - are exactly the ones nobody can
   reproduce on a robot without breaking it. */
const coreLevel = coreFmt.level;
const coreBytes = coreFmt.bytes;

/* Absent stays absent. num() already returns its fallback for a missing key, so the fallback is
   null and stays null all the way to the screen. */
function coreNum(key) {
  return num(CORE + key, null);
}

/* One vital: the number, its bar, and the colour they share. */
function paintVital(x, name, pct, opts = {}) {
  const level = coreLevel(pct, opts.warn, opts.crit);
  const digits = opts.digits ?? 0;

  x[name].textContent = pct === null ? "\u2014" : pct.toFixed(digits);
  x[`${name}Bar`].style.width = pct === null ? "0%" : `${Math.max(0, Math.min(100, pct))}%`;
  if (level === null) delete x[`${name}Bar`].dataset.level;
  else x[`${name}Bar`].dataset.level = level;

  const cell = x[`${name}Cell`];
  if (level === null || level === "ok") delete cell.dataset.level;
  else cell.dataset.level = level;
}

/* The five Systemcore buses and the SPI controller each hangs off, which is the fact that makes
   this table worth drawing rather than listing five numbers. Same pairing the library encodes in
   CatalystCANBus and the CAN ID planner warns about. */
const CORE_CAN_GROUPS = [
  ["Controller 1", ["can_s0", "can_s1"]],
  ["Controller 2", ["can_s2"]],
  ["Controller 3", ["can_s3", "can_s4"]],
];

/* ------------------------------------------------ the agent, when it is installed

   Systemcore publishes a summary of itself on NetworkTables and Catalyst mirrors it, but a summary
   is what it is: one processor figure for four cores, a storage percentage with no idea what filled
   it, and nothing about the robot program's own process. The questions asked in the ninety seconds
   before a match are the ones it cannot answer - which core is pinned and by what, what is using the
   disk, how many times the robot program has restarted, whether CAN saw bus errors.

   Catalyst ships an optional package that runs on the Systemcore itself and serves that from /proc
   and /sys. This talks to it when it is there, and the page works without it - everything the agent
   adds is additional, never a replacement for a reading that already arrives over NetworkTables.

   Polled slowly and on its own clock. It is a diagnostic, not an instrument: a driver never looks at
   this mid-match, and a page open in the pit should not be asking a robot for a process list ten
   times a second. */

const AGENT_PORT = 9010;
const AGENT_POLL_MS = 3000;
/* After this many silent failures the page stops asking and says the agent is not installed. Three
   rather than one because a robot that has just rebooted refuses connections for a few seconds, and
   flickering between "installed" and "not installed" is worse than either. */
const AGENT_GIVE_UP_AFTER = 3;

const coreAgent = { data: null, at: 0, misses: 0, inFlight: false, reachable: null };

function agentUrl(path) {
  /* The agent is on the robot, so it is wherever NetworkTables found one. A host with a port on it
     is the NT port, not the agent's. */
  const host = String(nt.status.address || "").replace(/:\d+$/, "");
  return host ? `http://${host}:${AGENT_PORT}${path}` : null;
}

/* A plausible machine, for demo mode.
 *
 * The same reasoning as the NetworkTables demo data: nobody should have to find a robot, install a
 * package on it and connect to it before they can find out whether this page works. It is a machine
 * in good order under load rather than a perfect one - one core carrying the robot program, a
 * program that has restarted once, and a log with something in it. */
function demoMotorHistory(t) {
  const names = ["FL_Drive", "FL_Steer", "FR_Drive", "FR_Steer", "BL_Drive", "BL_Steer", "BR_Drive", "BR_Steer"];
  return {
    present: true, updatedMs: Date.now(), clockTrusted: true,
    devices: names.map((name, i) => ({
      serial: "000E0B500C776800000A00011A00" + (0xE0 + i).toString(16).toUpperCase().padStart(4, "0"),
      model: "Talon FX", kind: "motor", bus: "can_s2", id: [30, 24, 4, 27, 45, 26, 46, 25][i], name,
      firmware: "26.1.1.1", poweredSeconds: 3600 * (9 + i * 1.7) + t, runningSeconds: 3600 * (2 + i * 0.6),
      loadedSeconds: 3600 * (1 + i * 0.3), revolutions: 120000 * (1 + i * 0.4), peakStatorAmps: 60 + i * 12,
      peakTempC: i === 4 ? 78 : 44 + i * 3, hotSeconds: i === 4 ? 420 : 0, energyJoules: 4e5 * (1 + i),
      boots: 40 + i * 3, firstSeenMs: Date.now() - 86400e3 * 30, lastSeenMs: Date.now(), identities: i === 4 ? 3 : 1,
      stickyFaults: 0,
    })),
  };
}

function demoAgentSnapshot(t) {
  const load = 0.5 + 0.5 * Math.abs(Math.sin(t * 0.7));
  const core = (i, base) => ({
    core: i,
    percent: Math.round((base + 28 * load) * 10) / 10,
    mhz: 1500 + Math.round(900 * load),
  });
  return {
    identity: {
      hostname: "robot", os: "Systemcore OS 2027.0.0-beta14", osVersion: "2027.0.0",
      kernel: "6.12.77-rt", model: "Raspberry Pi Compute Module 5",
      uptimeSeconds: 1180 + t, agentVersion: "2.0.0",
    },
    cpu: {
      /* One core busier than the rest, because that is what a robot program looks like. */
      cores: [core(0, 44), core(1, 12), core(2, 9), core(3, 7)],
      loadAverage: [1.2, 0.9, 0.7],
      model: "Cortex-A76",
      throttling: {
        underVoltageNow: false, frequencyCappedNow: false, throttledNow: false,
        softTempLimitNow: false, throttledSinceBoot: false, underVoltageSinceBoot: false,
      },
    },
    thermal: [{ zone: "cpu-thermal", celsius: 46 + 12 * load }],
    memory: {
      totalBytes: 8.0e9, availableBytes: 5.4e9, usedBytes: 2.6e9,
      cachedBytes: 3.1e9, swapTotalBytes: 0, swapFreeBytes: 0,
    },
    storage: {
      mounts: [{ mount: "/", device: "/dev/mmcblk0p2", filesystem: "ext4",
                 totalBytes: 32.0e9, usedBytes: 15.0e9, freeBytes: 17.0e9 }],
      directories: [
        { path: "/home/systemcore", bytes: 9.4e9 },
        { path: "/var/log", bytes: 2.1e9 },
      ],
    },
    processes: {
      count: 148,
      topByCpu: [
        { pid: 812, name: "java", cpuPercent: 38 + 20 * load, rssBytes: 512e6 },
        { pid: 431, name: "MrcCommDaemon", cpuPercent: 6.2, rssBytes: 48e6 },
        { pid: 502, name: "limelight", cpuPercent: 4.1, rssBytes: 96e6 },
        { pid: 1, name: "systemd", cpuPercent: 0.2, rssBytes: 12e6 },
      ],
      topByMemory: [],
    },
    can: [
      { name: "can_s0", up: true, state: "ERROR-ACTIVE", bitrate: 1000000, restarts: 0,
        rxPackets: 1842300, txPackets: 921100, rxErrors: 0, txErrors: 0,
        rxDropped: 0, txDropped: 0 },
      { name: "can_s2", up: true, state: "ERROR-ACTIVE", bitrate: 1000000, restarts: 0,
        rxPackets: 412900, txPackets: 208400, rxErrors: 0, txErrors: 0,
        rxDropped: 0, txDropped: 0 },
    ],
    network: [],
    robotProgram: {
      unit: "robot.service", state: "active", subState: "running",
      /* One restart, because that is the case worth showing: it looks completely normal from a
         driver's station and this page is the only thing that says it happened. */
      restarts: 1, runningForSeconds: 640 + t, memoryBytes: 512e6, pid: 812,
      log: [
        "2027-03-14T10:21:02+0000 robot: ********** Robot program starting **********",
        "2027-03-14T10:21:03+0000 robot: Catalyst 2.0.0-alpha.1 (systemcore)",
        "2027-03-14T10:21:03+0000 robot: CANRegistry: 13 devices on can_s0, 3 on can_s2",
        "2027-03-14T10:21:04+0000 robot: Physics Core: shadow mode",
        "2027-03-14T10:21:04+0000 robot: Robot code ready",
      ],
    },
    motorHistory: demoMotorHistory(t),
    sampledAt: Date.now() / 1000,
  };
}

async function pollAgent() {
  if (coreAgent.inFlight) return;
  if (demo.on) {
    /* Demo mode stands in for the agent too, so the whole page can be seen without a robot. */
    coreAgent.data = demoAgentSnapshot((performance.now() - demo.t0) / 1000);
    coreAgent.reachable = true;
    return;
  }
  if (!nt.status.connected) {
    coreAgent.reachable = false;
    coreAgent.data = null;
    return;
  }
  const url = agentUrl("/api/system");
  if (!url) return;

  coreAgent.inFlight = true;
  try {
    /* A timeout, because the failure being guarded against is not an error response - it is a robot
       that has gone away mid-request and a fetch that never settles. */
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    coreAgent.data = await res.json();
    coreAgent.at = performance.now();
    coreAgent.misses = 0;
    coreAgent.reachable = true;
  } catch {
    /* Silent. A robot without the package installed is the common case, not a fault, and an alert
       about it every three seconds would train people to ignore alerts. */
    coreAgent.misses += 1;
    if (coreAgent.misses >= AGENT_GIVE_UP_AFTER) {
      coreAgent.reachable = false;
      coreAgent.data = null;
    }
  } finally {
    coreAgent.inFlight = false;
  }
}

/* Only while somebody is looking at the page. */
setInterval(() => {
  if ($("#settings").dataset.open === "true" && currentSection === "core") pollAgent();
}, AGENT_POLL_MS);

function paintCore() {
  /* buildSettings already collected every [data-x] in the settings tree, and this section is
     inside it, so there is nothing of its own to wire. */
  const x = settingsRefs;
  const root = $("#core");

  /* "Is there a machine" is answered by whether anything at all arrived, not by a flag. A robot on
     Catalyst 2.x that never calls SystemCoreStatus.publish() is indistinguishable from no robot,
     and the empty state says so rather than pretending the machine is idle. */
  const cpu = coreNum("CpuPercent");
  const temp = coreNum("TempCelsius");
  const ramFrac = coreNum("RamFraction");
  const diskFrac = coreNum("StorageFraction");
  const live = [cpu, temp, ramFrac, diskFrac].some((v) => v !== null);
  root.dataset.live = live ? "true" : "false";
  if (!live) return;

  /* --- the four that move ------------------------------------------------- */
  paintVital(x, "cpu", cpu);
  /* The CM5 throttles rather than reporting anything, so the symptom of a hot Systemcore in a
     sealed electronics box is a loop overrun. 80 and 90 are below where throttling starts, so this
     says something while there is still time to open the box. */
  paintVital(x, "temp", temp, { warn: 80, crit: 90 });
  paintVital(x, "ram", ramFrac === null ? null : ramFrac * 100);
  /* Storage earlier than the rest: a disk that fills stops logging, then stops the robot program,
     and nothing about that symptom points at the disk. */
  paintVital(x, "disk", diskFrac === null ? null : diskFrac * 100, { warn: 85, crit: 93 });

  /* Absolute sizes under the ratios. "88% used" is the same number on 8 GiB and on 512 MiB and a
     different problem, and the ratio alone cannot tell them apart. */
  const pair = (used, total) => {
    const u = coreBytes(coreNum(used));
    const t = coreBytes(coreNum(total));
    return u && t ? `${u} of ${t}` : "";
  };
  x.ramSub.textContent = pair("RamUsedBytes", "RamTotalBytes");
  x.diskSub.textContent = pair("StorageUsedBytes", "StorageTotalBytes");

  paintCoreCan(x);
  paintCoreWear(x);
  paintCorePower(x);
  paintCoreMachine(x);
  paintCoreAgent(x);
}

/* Everything the on-device agent adds. Each card hides itself when the agent is not there, so the
   page degrades to the NetworkTables view rather than showing a row of empty sections. */
function paintCoreAgent(x) {
  /* Demo mode refreshes it here rather than waiting for the poll, so the page is complete the
     moment it opens instead of filling in three seconds later. */
  if (demo.on) {
    coreAgent.data = demoAgentSnapshot((performance.now() - demo.t0) / 1000);
    coreAgent.reachable = true;
  }
  const a = coreAgent.data;

  x.coresCard.hidden = !a?.cpu?.cores?.length;
  x.programCard.hidden = !a?.robotProgram?.state;
  x.loadCard.hidden = !a?.processes?.topByCpu?.length;
  x.camCard.hidden = !a?.cameras?.cameras?.length;
  x.motorCard.hidden = !a?.motorHistory?.devices?.length;
  if (!a) {
    setHtml(x.canCounters, "");
    paintAgentNote(x);
    return;
  }

  paintAgentCores(x, a.cpu);
  paintAgentProgram(x, a.robotProgram);
  paintAgentLoad(x, a);
  paintAgentCameras(x, a.cameras);
  paintAgentMotorHistory(x, a.motorHistory);
  paintAgentCanCounters(x, a.can);
  paintAgentNote(x);
}

/* ---- motor history ------------------------------------------------------------------------ */

/* Hours to one decimal, or minutes when there are not many. */
function hoursText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0";
  if (seconds < 3600) return `${(seconds / 60).toFixed(0)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

function revsText(revs) {
  if (!Number.isFinite(revs) || revs <= 0) return "0";
  if (revs >= 1e6) return `${(revs / 1e6).toFixed(2)} M`;
  if (revs >= 1e3) return `${(revs / 1e3).toFixed(1)} k`;
  return revs.toFixed(0);
}

/* A serial is 32 hex characters; the last eight are what tells them apart on a robot. */
function shortSerial(serial) {
  const s = String(serial || "");
  return s.length > 10 ? "\u2026" + s.slice(-8) : s;
}

/* One row per device from either source: the agent's flattened rows, or a NetworkTables row string. */
function motorRowsFromNt(rows) {
  return rows.map((line) => {
    const f = String(line).split("|");
    const n = (i) => { const v = Number(f[i]); return Number.isFinite(v) ? v : 0; };
    return {
      serial: f[0] || "", model: f[1] || "", kind: f[2] || "device", bus: f[3] || "", id: n(4),
      name: f[5] || "", firmware: f[6] || "", poweredSeconds: n(7), runningSeconds: n(8),
      loadedSeconds: n(9), revolutions: n(10), peakStatorAmps: n(11), peakTempC: n(12),
      hotSeconds: n(13), energyJoules: n(14), boots: n(15), firstSeenMs: n(16), lastSeenMs: n(17),
      identities: n(18), stickyFaults: n(19),
    };
  });
}

const MOTOR_SORTS = {
  powered: (r) => r.poweredSeconds,
  running: (r) => r.runningSeconds,
  hot: (r) => r.hotSeconds,
  peakTemp: (r) => r.peakTempC,
  peakAmps: (r) => r.peakStatorAmps,
  revolutions: (r) => r.revolutions,
  boots: (r) => r.boots,
};

/* The table both the tile and the core-page card draw. Motors first, then everything else, each
   sorted by the chosen column, descending. */
function motorTableHtml(rows, sortKey, limit, hotCelsius) {
  const key = MOTOR_SORTS[sortKey] || MOTOR_SORTS.powered;
  const motors = rows.filter((r) => r.kind === "motor").sort((a, b) => key(b) - key(a));
  const others = rows.filter((r) => r.kind !== "motor");
  const shown = motors.slice(0, limit);
  const maxPowered = Math.max(1, ...motors.map((r) => r.poweredSeconds));
  const cell = (r) => {
    const hot = r.peakTempC >= hotCelsius;
    const label = r.name ? escapeHtml(r.name) : `<span class="dim">unnamed</span>`;
    const where = [r.bus, Number.isFinite(r.id) && r.id ? `id ${r.id}` : ""].filter(Boolean).join(" \u00b7 ");
    const past = r.identities > 1 ? `<span class="mh-past" title="${r.identities} identities on record: this motor has been renumbered, renamed or reflashed">${r.identities - 1} past</span>` : "";
    return `<tr>
      <td class="mh-name">${label}<small>${escapeHtml(where)} \u00b7 ${escapeHtml(shortSerial(r.serial))}${past}</small></td>
      <td class="mh-bar"><div class="track"><i style="width:${(100 * r.poweredSeconds / maxPowered).toFixed(1)}%"></i></div><span>${hoursText(r.poweredSeconds)}</span></td>
      <td>${hoursText(r.runningSeconds)}</td>
      <td>${revsText(r.revolutions)}</td>
      <td>${r.peakStatorAmps ? r.peakStatorAmps.toFixed(0) : "\u2014"}</td>
      <td class="${hot ? "warn" : ""}">${r.peakTempC ? r.peakTempC.toFixed(0) + "\u00b0" : "\u2014"}</td>
      <td class="${r.hotSeconds > 0 ? "warn" : ""}">${r.hotSeconds > 0 ? hoursText(r.hotSeconds) : "\u2014"}</td>
      <td>${r.boots || 0}</td>
    </tr>`;
  };
  const rest = motors.length > shown.length ? `<div class="cap">and ${motors.length - shown.length} more motors</div>` : "";
  const otherNote = others.length ? `<div class="cap">${others.length} other device${others.length === 1 ? "" : "s"} on record (encoders, IMUs)</div>` : "";
  return `<table class="mh">
    <thead><tr><th>Motor</th><th>Powered</th><th>Turning</th><th>Revs</th><th>Peak A</th><th>Peak \u00b0C</th><th>Hot</th><th>Boots</th></tr></thead>
    <tbody>${shown.map(cell).join("")}</tbody></table>${rest}${otherNote}`;
}

function paintAgentMotorHistory(x, hist) {
  if (!hist?.devices?.length) { setHtml(x.motorHist, ""); return; }
  setHtml(x.motorHist, motorTableHtml(hist.devices, "powered", 40, 70));
  const when = hist.updatedMs && hist.clockTrusted !== false ? `updated ${duration(Math.max(0, Date.now() - hist.updatedMs))} ago` : "robot clock not set, dates are relative";
  const url = agentUrl("/api/motor-history");
  setHtml(x.motorCap, `${escapeHtml(when)}. The file is the record: <code>${url ? escapeHtml(url) : "/api/motor-history"}</code>, `
    + `or <code>.csv</code> for a spreadsheet. The Catalyst App's Motor history tool saves either.`);
}

function paintAgentCores(x, cpu) {
  if (!cpu?.cores?.length) return;
  setHtml(x.cores, cpu.cores.map((c) => {
    const pct = c.percent;
    return `<div class="ccore">
        <span>c${c.core}</span>
        <div class="ctrack"><i style="width:${pct === null ? 0 : Math.min(100, pct)}%" data-level="${coreLevel(pct)}"></i></div>
        <b>${pct === null ? "—" : pct.toFixed(0) + "%"}${c.mhz ? `<span class="mhz">${c.mhz} MHz</span>` : ""}</b>
      </div>`;
  }).join(""));

  const bits = [];
  if (cpu.loadAverage) {
    /* Load is the queue, not the usage. 40% CPU with a load of 6 is a machine waiting on something,
       and that reads completely differently from 40% with a load of 0.5. */
    bits.push(`load <b>${cpu.loadAverage.join(" &middot; ")}</b>`);
  }
  const t = cpu.throttling;
  if (t) {
    /* Now and since-boot are different facts. A robot that throttled during its last match and has
       since cooled down still carries the since-boot bit, and that is the evidence. */
    if (t.throttledNow) bits.push('<b class="bad">throttling now</b>');
    else if (t.throttledSinceBoot) bits.push("throttled earlier this boot");
    if (t.underVoltageNow) bits.push('<b class="bad">under-voltage now</b>');
    else if (t.underVoltageSinceBoot) bits.push("under-voltage earlier this boot");
  }
  setHtml(x.throttle, bits.join(" &middot; "));
}

function paintAgentProgram(x, prog) {
  if (!prog?.state) return;
  const rows = [];
  const running = prog.state === "active";
  rows.push(["State", `${prog.state}${prog.subState ? ` (${prog.subState})` : ""}`, running ? "" : "crit"]);
  if (prog.runningForSeconds !== null && prog.runningForSeconds !== undefined) {
    rows.push(["Running for", duration(prog.runningForSeconds * 1000), ""]);
  }
  /* The signal people miss entirely. A program that crashes and restarts inside a second looks
     completely normal from the driver's station. */
  if (prog.restarts !== null && prog.restarts !== undefined) {
    rows.push(["Restarts", String(prog.restarts), prog.restarts > 0 ? "warn" : ""]);
  }
  if (prog.memoryBytes) rows.push(["Memory", coreBytes(prog.memoryBytes) ?? "—", ""]);
  if (prog.pid) rows.push(["PID", String(prog.pid), "dim"]);
  setHtml(x.program, coreRows(rows));

  const log = prog.log || [];
  x.logWrap.hidden = !log.length;
  /* Newest last, the way a terminal reads. */
  setHtml(x.log, log.map((line) => escapeHtml(line)).join("\n"));
}

function paintAgentLoad(x, a) {
  const procs = a.processes?.topByCpu || [];
  setHtml(x.procs, procs.map((row) =>
    `<div class="crow"><span>${escapeHtml(row.name)}<span class="sub">${row.pid}</span></span>`
    + `<b>${row.cpuPercent.toFixed(0)}%<span class="sub">${coreBytes(row.rssBytes) ?? ""}</span></b></div>`
  ).join(""));

  /* Directories, largest first, so the answer to "what do I delete" is the first row. */
  const dirs = (a.storage?.directories || [])
    .filter((d) => d.bytes)
    .sort((p, q) => q.bytes - p.bytes);
  setHtml(x.dirs, dirs.map((d) =>
    `<div class="crow"><span>${escapeHtml(d.path)}</span><b>${coreBytes(d.bytes)}</b></div>`
  ).join(""));
}

function paintAgentCanCounters(x, buses) {
  if (!buses?.length) { setHtml(x.canCounters, ""); return; }
  setHtml(x.canCounters, buses.map((b) => {
    const errors = (b.rxErrors || 0) + (b.txErrors || 0);
    const dropped = (b.rxDropped || 0) + (b.txDropped || 0);
    const frames = (b.rxPackets || 0) + (b.txPackets || 0);
    const bits = [`<b>${frames.toLocaleString()}</b> frames`];
    /* Zero errors is the expected case and saying so every time is noise. A non-zero count is the
       whole reason to look. */
    if (errors) bits.push(`<b class="bad">${errors}</b> errors`);
    if (dropped) bits.push(`<b class="bad">${dropped}</b> dropped`);
    if (b.restarts) bits.push(`<b class="bad">${b.restarts}</b> restarts`);
    if (b.state && b.state !== "ERROR-ACTIVE") bits.push(`<b>${escapeHtml(b.state)}</b>`);
    return `<div class="ccounter"><span class="name">${escapeHtml(b.name)}</span> ${bits.join(" &middot; ")}</div>`;
  }).join(""));
}


/* The OS's own view of the cameras, joined with each camera's status by the agent. This is the
 * card that works with no robot code at all, which is when an overheating camera is easiest to
 * do something about. */
function paintAgentCameras(x, cams) {
  if (!cams?.cameras?.length) { setHtml(x.cams, ""); return; }
  setHtml(x.cams, cams.cameras.map((c) => {
    const hot = Number.isFinite(c.temperatureC) && c.temperatureC >= 80;
    const state = !c.statusReachable ? "DISCONNECTED" : hot ? "HOT" : c.ntConnected ? "OK" : "NO_NT";
    const words = state === "DISCONNECTED" ? "not answering"
      : state === "HOT" ? "running hot"
      : c.ntConnected ? "talking to the robot" : "no NetworkTables session";
    const bits = [];
    if (Number.isFinite(c.fps)) bits.push(`${c.fps.toFixed(0)} fps`);
    if (Number.isFinite(c.temperatureC)) bits.push(`${c.temperatureC.toFixed(0)}\u00b0C`);
    if (Number.isFinite(c.cpuPercent)) bits.push(`cpu ${c.cpuPercent.toFixed(0)}%`);
    const sub = [c.ip, c.pipelineType, words].filter(Boolean).map(escapeHtml).join(" \u00b7 ");
    return `<div class="gcam" data-state="${state}"><i></i><div class="n">${escapeHtml(c.name || c.host || c.ip || "camera")}`
      + `<small>${sub}</small></div><div class="m">${bits.join(" \u00b7 ")}</div></div>`;
  }).join(""));
}

function paintAgentNote(x) {
  if (coreAgent.reachable) {
    const id = coreAgent.data?.identity || {};
    const parts = [];
    if (id.os) parts.push(escapeHtml(id.os));
    if (id.kernel) parts.push(`kernel ${escapeHtml(id.kernel)}`);
    if (id.uptimeSeconds) parts.push(`up ${duration(id.uptimeSeconds * 1000)}`);
    setHtml(x.agentNote, parts.length ? parts.join(" &middot; ") : "");
    return;
  }
  /* Not an error state. Most robots will not have the package installed, and this is the only place
     that says the extra detail exists at all. */
  setHtml(x.agentNote,
    "Install <code>catalyst-agent</code> on the Systemcore for per-core load, the robot "
    + "program&rsquo;s own log, what is using the disk, and CAN frame counters.");
}

/* Per-bus utilisation, grouped by controller. */
function paintCoreCan(x) {
  const util = arr(CORE + "CanUtilization");
  const card = x.canCard;
  card.hidden = !util || !util.length;
  if (card.hidden) return;

  card.hidden = false;

  /* The rows are rebuilt only when the set of buses changes, which is once. Their widths and
     numbers change every frame and are written straight to the nodes. */
  const shape = CORE_CAN_GROUPS.map(([, buses]) =>
    buses.filter((b) => Number(b.slice(-1)) < util.length).join(",")).join("|");
  setHtml(x.buses, CORE_CAN_GROUPS.map(([title, buses]) => {
    const rows = buses
      .filter((bus) => Number(bus.slice(-1)) < util.length)
      .map((bus) => `<div class="cbus" data-bus="${bus}">
          <span>${escapeHtml(bus)}</span>
          <div class="ctrack"><i></i></div>
          <b></b>
        </div>`).join("");
    return rows ? `<div class="cgroup"><h4>${escapeHtml(title)}</h4>${rows}</div>` : "";
  }).join("") + `<!--${shape}-->`);

  for (const row of x.buses.querySelectorAll(".cbus")) {
    /* The published contract is a fraction per bus, 0-1, so this scales by 100. A board was seen
       publishing about 5, which drew "500%" - a utilisation no bus can have.

       Not silently rescaled: "over 1 so divide by 100" is right for a busy bus and wrong for an idle
       one, because 0.5 is both a legal fraction and a plausible half-percent. So an out-of-range
       reading is shown pinned at 100% and marked suspect, which says "this number is wrong" instead
       of quietly inventing a different wrong number. */
    const raw = util[Number(row.dataset.bus.slice(-1))];
    const suspect = !(raw >= 0 && raw <= 1);
    const pct = suspect ? 100 : raw * 100;
    row.dataset.suspect = String(suspect);
    row.title = suspect
      ? `The robot published ${raw} for this bus. Utilisation is meant to be 0-1, so this reading `
        + `cannot be scaled to a percentage and is shown pinned.`
      : "";
    const bar = row.querySelector("i");
    bar.style.width = `${Math.min(100, pct).toFixed(1)}%`;
    bar.dataset.level = coreLevel(pct, 70, 85);
    row.querySelector("b").textContent = `${pct.toFixed(0)}%`;
    /* A bus with nothing on it is not a problem, and dimming it keeps the eye on the ones carrying
       load rather than spreading attention over five equal-looking rows. */
    row.dataset.idle = String(pct < 1);
  }

  /* Counts since boot, not a live state. A bus that dropped three times and is up now is a
     different problem from one that is down, and the wording has to keep them apart. */
  const down = coreNum("CanDownCount");
  const unavail = coreNum("CanUnavailCount");
  const nowDown = bool(CORE + "CanDown", false);
  const bits = [];
  if (nowDown) bits.push('<b class="bad">a bus is down right now</b>');
  if (down !== null && down > 0) bits.push(`dropped <b>${down.toFixed(0)}</b> time${down === 1 ? "" : "s"} since boot`);
  if (unavail !== null && unavail > 0) bits.push(`unavailable <b>${unavail.toFixed(0)}</b> time${unavail === 1 ? "" : "s"}`);
  setHtml(x.canFaults, bits.join(" &middot; "));
}

/* eMMC wear. */
function paintCoreWear(x) {
  const used = coreNum("EmmcLifeUsed");
  const preEol = coreNum("EmmcPreEol");
  x.wearCard.hidden = used === null && preEol === null;
  if (x.wearCard.hidden) return;

  const pct = used === null ? null : used * 100;
  x.wearBar.style.width = pct === null ? "0%" : `${Math.min(100, pct).toFixed(0)}%`;
  const level = coreLevel(pct, 70, 90);
  if (level) x.wearBar.dataset.level = level; else delete x.wearBar.dataset.level;

  x.wearText.textContent = coreFmt.wearText(used);

  const state = coreFmt.preEolState(preEol);
  x.wearState.textContent = state ? state.text : "";
  x.wearState.className = state ? state.level : "";
}

function paintCorePower(x) {
  const rows = [];
  const volts = coreNum("BatteryVolts");
  const brownedOut = bool(CORE + "BrownedOut", false);
  const floor = coreNum("BrownoutVolts");
  const recover = coreNum("RecoveryVolts");
  const rail = coreNum("Rail3v3Amps");

  if (volts !== null) rows.push(["Battery", `${volts.toFixed(2)} V`, brownedOut ? "crit" : ""]);
  if (brownedOut) rows.push(["State", "browned out", "crit"]);
  /* These used to be constants in robot code, copied from the roboRIO. They are the device's own
     numbers now, and they are not the same numbers. */
  if (floor !== null) rows.push(["Brownout at", `${floor.toFixed(2)} V`, "dim"]);
  if (recover !== null) rows.push(["Recovers at", `${recover.toFixed(2)} V`, "dim"]);
  /* The rail that powers the IO pins, and the reason a servo cannot be driven from one. */
  if (rail !== null) rows.push(["3.3 V rail", `${rail.toFixed(2)} A`, ""]);

  x.powerCard.hidden = !rows.length;
  setHtml(x.power, coreRows(rows));
}

function paintCoreMachine(x) {
  const rows = [];
  const team = coreNum("TeamNumber");
  const hsub = coreNum("HardwareSubRev");
  const nics = arr(CORE + "NetworkInterfaces");

  if (team !== null) rows.push(["Team", team.toFixed(0), ""]);
  if (hsub !== null) rows.push(["Hardware rev", hsub.toFixed(0), "dim"]);
  /* Passed through as the OS words it. Reformatting would mean guessing at a shape that has no
     documentation, and the question this answers - radio or only USB - survives the raw form. */
  if (nics && nics.length) rows.push(["Network", nics.join(", "), ""]);

  /* Agent only. The first question when one robot behaves differently from the one beside it is
     whether they are on the same OS build, and nothing on NetworkTables can answer it. */
  const id = coreAgent.data?.identity;
  if (id) {
    if (id.model) rows.push(["Model", id.model, "dim"]);
    if (id.os) rows.push(["OS", id.os, ""]);
    if (id.kernel) rows.push(["Kernel", id.kernel, "dim"]);
    if (id.hostname) rows.push(["Hostname", id.hostname, "dim"]);
    if (id.uptimeSeconds) rows.push(["Uptime", duration(id.uptimeSeconds * 1000), ""]);
  }

  x.idCard.hidden = !rows.length;
  setHtml(x.ident, coreRows(rows));
}

function coreRows(rows) {
  return rows.map(([k, v, cls]) =>
    `<div class="crow"><span>${escapeHtml(k)}</span><b class="${cls}">${escapeHtml(v)}</b></div>`
  ).join("");
}

/* The wiring, which is its own section. Both halves hide themselves when the robot published nothing
 * for them, so the empty state is "neither drew" rather than a flag kept in step by hand. */
function paintDevices() {
  paintDeviceTree();
  paintPowerPanel();
  paintCameraCard();
  const drew = !$("#gTreeCard").hidden || !$("#gPowerCard").hidden || !$("#gCamCard").hidden;
  $("#gViz").hidden = !drew;
  $("#devEmpty").hidden = drew;
}

/* Every CAN device, on the bus it is actually on. The sheet already said "11 CAN devices" and "8 ×
 * Kraken X60", which answers a question nobody has: at 2am in the pit the question is which id is on
 * which wire, and whether the one that stopped answering is on the rio bus or the CANivore. */
function paintDeviceTree() {
  const rows = (arr(`${SPEC_ROOT}Hardware/Devices`) || [])
    .map((r) => String(r).split("|"))
    .filter((p) => p.length === 3);

  const card = $("#gTreeCard");
  card.hidden = rows.length === 0;
  if (!rows.length) return;

  const buses = new Map();
  for (const [bus, id, type] of rows) {
    if (!buses.has(bus)) buses.set(bus, []);
    buses.get(bus).push([id, type]);
  }

  $("#gTreeCount").textContent = String(rows.length);
  $("#gTree").innerHTML = [...buses].map(([bus, devices]) => `
    <div class="gbus">
      <div class="gbusname">${escapeHtml(bus)}<span>${devices.length}</span></div>
      ${devices.map(([id, type]) =>
        `<div class="gdev"><i>${escapeHtml(id)}</i><span>${escapeHtml(type)}</span></div>`).join("")}
    </div>`).join("");
}


/* Every camera the robot declared, with the state its vision health assigned it. The roster says
 * which cameras exist and whether each answers; the health rows say what is wrong with one that
 * does. Either alone is enough for the card. */
function paintCameraCard() {
  const card = $("#gCamCard");
  const roster = (arr("/Catalyst/Devices/Cameras/Rows") || []).map((r) => String(r).split("|"));
  const health = new Map((arr("/Catalyst/Vision/Health/Rows") || [])
    .map((r) => String(r).split("|")).filter((p) => p.length >= 3).map((p) => [p[0], p]));
  const names = roster.length ? roster.map((p) => p[0]) : [...health.keys()];
  card.hidden = names.length === 0;
  if (card.hidden) return;
  $("#gCamCount").textContent = String(names.length);
  setHtml($("#gCams"), names.map((name) => {
    const r = roster.find((p) => p[0] === name);
    const h = health.get(name);
    const state = h ? h[1] : r ? (r[1] === "true" ? "OK" : "DISCONNECTED") : "UNKNOWN";
    const detail = h ? h[2] : r ? r[2] : "";
    const metrics = [];
    if (h && h[3]) metrics.push(`${Number(h[3]).toFixed(0)} fps`);
    if (h && h[4]) metrics.push(`${Number(h[4]).toFixed(0)}\u00b0C`);
    return `<div class="gcam" data-state="${escapeHtml(state)}"><i></i><div class="n">${escapeHtml(name)}`
      + `<small>${escapeHtml(cameraStateWords(state))}${detail ? ` \u00b7 ${escapeHtml(detail)}` : ""}</small></div>`
      + `<div class="m">${metrics.join(" \u00b7 ")}</div></div>`;
  }).join(""));
}

function cameraStateWords(state) {
  return {
    OK: "healthy", NO_TARGETS: "no targets in view", DISCONNECTED: "no data", STALE: "frames stopped",
    HOT: "running hot", LOW_FPS: "frame rate low", REJECTING: "mostly rejected", UNKNOWN: "unknown",
  }[state] || String(state).toLowerCase();
}

/* The distribution panel as a panel. A list of five channels does not show you that channels 9 to 19
 * are empty, and the shape of what is free is most of what you want when adding a mechanism. */
function paintPowerPanel() {
  const used = new Map(
    (arr(`${SPEC_ROOT}Power/ChannelsInUse`) || [])
      .map((r) => String(r).split("|"))
      .filter((p) => p.length === 2 && p[1])
      .map(([channel, what]) => [Number(channel), what]),
  );
  const total = num(`${SPEC_ROOT}Power/Channels`);

  const card = $("#gPowerCard");
  /* Without a channel count there is no panel to draw — a strip sized to whatever happens to be in
   * use would invent the shape of a distribution board this console was never told about. */
  card.hidden = !total || !used.size;
  if (card.hidden) return;

  $("#gPowerCount").textContent = `${used.size} of ${total}`;
  const slots = [];
  for (let i = 0; i < total; i++) {
    slots.push(`<div class="gslot" data-on="${used.has(i)}" title="${
      escapeHtml(used.get(i) || `channel ${i}, free`)}">${i}</div>`);
  }
  $("#gPower").innerHTML = slots.join("");
  $("#gPowerKey").innerHTML = [...used.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([channel, what]) => `<div><b>${channel}</b>${escapeHtml(what)}</div>`)
    .join("");
}

/* The sheet as plain text, for the pit. At inspection someone is reading frame perimeter and weight
 * off a screen and writing them on a form; this is that, without the transcription. Written from the
 * same data the panel rendered, so it says what the screen says including the chosen units. */
function sheetAsText() {
  if (!sheetForCopy) return "";
  const lines = [sheetForCopy.name];
  if (sheetForCopy.sub) lines.push(sheetForCopy.sub);
  /* Widest label across the whole sheet, so every group's values line up in one column rather than
   * each group finding its own — the point of plain text here is that it is readable pasted. */
  const pad = Math.max(...sheetForCopy.groups.flatMap(([, rows]) => rows.map(([l]) => l.length)));
  for (const [title, rows] of sheetForCopy.groups) {
    lines.push("", title.toUpperCase());
    for (const [label, v] of rows) lines.push(`  ${label.padEnd(pad)}  ${v}`);
  }
  return lines.join("\n");
}

function paintSettings() {
  if (!settingsRefs || $("#settings").dataset.open !== "true") return;
  const x = settingsRefs;

  if (currentSection === "robot") { paintAddresses(); paintGarage(); paintQuick(); }
  if (currentSection === "core") paintCore();
  if (currentSection === "devices") paintDevices();
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
  paintNotices();
  fitStatusBar();
  paintDockAuto();
  trackDrive(performance.now());
  trackMechanisms(performance.now());
  rememberRobot(performance.now());
  paintPark();

  for (const entry of live.values()) {
    try {
      entry.spec.update(entry.body, entry.item.cfg, entry.refs, entry.tile, entry.state);
    } catch (err) {
      /* One misbehaving tile must not stop the rest of the board painting. */
      console.warn(`component ${entry.item.type} update failed`, err);
    }
  }

  const active = activeView();
  if (active === "tune") syncTune();
  if (active === "topics") paintTopics();
  if (active === "logs") tickLinkHistory();
  if (active === "can") paintCan();
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
paintChoice("#setUnits", settings.units);
paintChoice("#setStartView", settings.startView);

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

/* After the board exists, so the view being opened has something in it. The markup opens on the
 * dashboard; this is the only place the preference is applied, because switching later would mean a
 * visible flick from one view to another on every launch. */
if (settings.startView !== "board") showView(settings.startView);

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
  5: () => showView("can"),
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

/* The press answer, from the identity's own motion module.
 *
 * One delegated listener rather than a handler per control, because the dock and the tablist are
 * rebuilt and the update chip arrives six seconds after launch — a wiring pass would miss it. It is
 * `pointerdown`, not `click`, because the whole point is to answer at the moment of the press.
 *
 * Only controls that are pressed: the views, the dock, the settings rail, its buttons and its quick
 * controls, and the palette's cards. Not the tiles, which are surfaces repainting at 10 Hz, and not
 * the chips, which are readouts that happen to be clickable. `stateLayer` declines to run at all under
 * `prefers-reduced-motion` and removes its own element, so nothing here has to be undone. */
window.addEventListener("pointerdown", (e) => {
  const hit = e.target instanceof Element ? e.target.closest(".tab, .dk, .snav, .sbtn, .sclose, .qtile, .item") : null;
  if (hit && !hit.disabled) stateLayer(hit, e);
}, { passive: true });

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    /* Escape inside a field means "abandon what I am typing", not "throw the dialog away". Closing
     * the layout modal blanks the paste box, so a stray Escape after pasting a board someone sent you
     * used to destroy it. Blur first; a second Escape then closes, because by then the field is no
     * longer focused. */
    /* The search box is the exception, because a filter is state on screen rather than text being
     * composed: Escape there means "show me everything again", which is what it means in every other
     * search field anyone has used.
     *
     * It blurs on the way out, and that is the whole point of the line. Without it the next Escape
     * lands on the branch below, which only blurs, so closing the panel from a search took three
     * presses: clear, blur, close. Two is the promise everywhere else in here and there is no reason
     * this one should cost more. */
    if (e.target === $("#setSearch") && e.target.value) {
      clearSearchState();
      showSection(currentSection);
      e.target.blur();
      e.preventDefault();
      return;
    }
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
