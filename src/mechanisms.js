/* The robot's moving parts, as a Catalyst robot reports them, and what the console works out from them.
 *
 * The 3D views animate a real robot's mechanisms - the hood at the angle the code has it at, the intake
 * sliding out, rollers turning, FUEL filling the hopper while it intakes and leaving the shooter while it
 * shoots - and every number that drives that comes through here. It is pure, so the parts that have to
 * be right can be tested without a robot: which topics mean what, how full the hopper is after so many
 * seconds of intaking, and how fast and at what angle a ball leaves.
 *
 * The topic names are the ones team 5805's REBUILT robot publishes through CatalystLog (under
 * /Catalyst/). A robot that publishes none of them simply has nothing to animate.
 */

/** FUEL, REBUILT's game piece: a 5.91 in foam ball. */
export const FUEL_DIAMETER_M = 0.15;
/** The most FUEL a robot may start a match holding. */
export const PRELOAD_FUEL = 8;
export const GRAVITY = 9.81;

/* The share of the flywheel's surface speed a FUEL ball keeps, fitted to team 5805's shot table (see
   fitKeep). It only shapes how the shot is drawn leaving the robot; nothing downstream depends on it. */
export const LAUNCH_KEEP = 0.81;
/* How many FUEL the shooter takes abreast, and how many it gets through a second while it feeds. */
export const SHOOTER_LANES = 4;
export const FEED_RATE = 16;
/* How long a ball fed to the shooter takes to get from its place in the hopper to where it leaves the
   hood: the hopper draws it along that path (hopper3d.js) and the field view launches it from the exit
   this much later (field3d.js), so the ball it launches is the one that just arrived there. */
export const FEED_TRAVEL_S = 0.3;

const INCH = 0.0254;

/**
 * Every mechanism reading the views animate from, out of a read-only NetworkTables view (`num`, `bool`,
 * `str`, `arr`, as devices.js takes). Anything the robot does not publish is null.
 */
export function readMechanisms(read) {
  const num = (key) => {
    const v = read.num(key, null);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const roller = (name) => ({
    speed: num(`/Catalyst/${name}/Speed`),
    motorRps: num(`/Catalyst/${name}Motor/Velocity`),
    currentAmps: num(`/Catalyst/${name}/CurrentAmps`),
  });
  /* A deploy that has not homed reports a length measured from nowhere. */
  const homed = read.bool("/Catalyst/Deploy/Homed", null);
  const length = num("/Catalyst/Deploy/LengthInches");
  const modules = read.arr("/Catalyst/Swerve/ModuleStates");
  return {
    hoodDeg: num("/Catalyst/Hood/AngleDegrees"),
    hoodGoalDeg: num("/Catalyst/Hood/GoalAngle"),
    deployM: homed === false || length === null ? null : length * INCH,
    deployPose: read.str("/Catalyst/HopperManager/DeployPose", null),
    intake: roller("Intake"),
    conveyor: roller("Conveyor"),
    feeder: roller("Feeder"),
    shooterRps: num("/Catalyst/Shooter/VelocityRPS"),
    shooterGoalRps: num("/Catalyst/Shooter/SetpointRPS"),
    shooterAtSpeed: read.bool("/Catalyst/Shooter/AtSpeed", null),
    robotState: read.str("/Catalyst/RobotManager/State", null),
    hopperState: read.str("/Catalyst/HopperManager/State", null),
    hopperFull: read.bool("/Catalyst/HopperManager/IsFull", null),
    /* SwerveModuleState[] decodes as [speed, angle, speed, angle, ...]: metres a second and radians. */
    modules: Array.isArray(modules) && modules.length >= 2 && modules.length % 2 === 0
      ? Array.from({ length: modules.length / 2 }, (_, i) => ({ speed: modules[i * 2], angle: modules[i * 2 + 1] }))
      : null,
  };
}

/**
 * What the robot is aiming at, when it says: `{ state, target, aimPoint, headingErrorDeg, distance,
 * timeOfFlight }` from /Catalyst/Aim, or null while it publishes nothing or is not aiming.
 *
 * `state` is ALIGNING while the robot turns its shooter onto the target, ALIGNED once it is on it, and SOTF
 * while it shoots on the move. `target` is the HUB, [x, y] in field metres; `aimPoint` is where the shot is
 * actually aimed - the virtual goal a moving robot leads, target minus its velocity times the ball's time
 * of flight - and the target itself when the robot is still.
 */
export function readAim(read) {
  const state = String(read.str("/Catalyst/Aim/State", "") || "").toUpperCase();
  if (!["ALIGNING", "ALIGNED", "SOTF"].includes(state)) return null;
  const pair = (key) => {
    const v = read.arr(key);
    return Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [v[0], v[1]] : null;
  };
  const target = pair("/Catalyst/Aim/Target");
  if (!target) return null;
  const num = (key) => {
    const v = read.num(key, null);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  return {
    state,
    target,
    aimPoint: pair("/Catalyst/Aim/AimPoint") ?? target,
    headingErrorDeg: num("/Catalyst/Aim/HeadingErrorDeg"),
    distance: num("/Catalyst/Aim/DistanceMeters"),
    timeOfFlight: num("/Catalyst/Aim/TimeOfFlightSeconds"),
  };
}

/** True when anything here would move a part of the robot. */
export function hasMechanisms(m) {
  return Boolean(m) && [m.hoodDeg, m.deployM, m.intake?.speed, m.conveyor?.speed, m.feeder?.speed, m.shooterRps]
    .some((v) => v !== null && v !== undefined);
}

const state = (name) => (typeof name === "string" ? name.toUpperCase() : "");

/* Intake rollers spinning on nothing draw a few amps; FUEL going through them draws several times that. */
export const INTAKE_LOAD_AMPS = 12;

/**
 * Taking FUEL in: the hopper manager says it is intaking, or the rollers are running inward - and, when the
 * robot publishes its intake current, the rollers are actually loaded. A driver who drops the intake and
 * runs it across open carpet extends the hopper and brings nothing in, so nothing is counted.
 */
export function isIntaking(m) {
  const s = state(m.hopperState);
  const running = s ? s.includes("INTAK") : (m.intake?.speed ?? 0) > 0.5;
  if (!running) return false;
  const amps = m.intake?.currentAmps;
  return typeof amps !== "number" || amps >= INTAKE_LOAD_AMPS;
}

/** Pushing FUEL back out through the intake. */
export function isEjecting(m) {
  const s = state(m.hopperState);
  if (s) return s.includes("EJECT");
  return (m.intake?.speed ?? 0) < -0.5;
}

/** Feeding FUEL into a flywheel that is up to speed: what launches balls. */
export function isFeeding(m, minShooterRps = 8) {
  const s = state(m.hopperState);
  const asked = s ? s.includes("SCORE") || s.includes("FEED") : (m.feeder?.speed ?? 0) > 0.5;
  return asked && (m.feeder?.speed ?? 1) > 0.3 && Math.abs(m.shooterRps ?? 0) >= minShooterRps;
}

/**
 * What the shooter is doing, the way a driver asks it: `{ state, ready }`, or null with no flywheel speed
 * to go on.
 *
 * `state` is "shooting" or "feeding" while FUEL is going through a spinning shooter - feeding is lobbing
 * it into the alliance zone rather than at the HUB - "ready" with a setpoint and the flywheel at it,
 * "spinning" on the way there, "warm" at an idle speed with nothing asked of it, "idle", "spindown" while
 * a flywheel with nothing asked of it slows, and "stopped" while the robot is disabled and the flywheel
 * has stopped. `ready` is true only while a shot could go this instant.
 *
 * At speed is the robot's own flag when it publishes one, and otherwise within 3 percent of the setpoint
 * (a revolution a second at least). What counts as asked for is the robot manager's state when there is
 * one - 5805 idles its flywheel warm, so a setpoint alone does not mean a shot is coming.
 */
export function shooterReadiness(m, { enabled = true } = {}) {
  const rps = m?.shooterRps;
  if (typeof rps !== "number" || !Number.isFinite(rps)) return null;
  const spinning = Math.abs(rps) >= 2;
  if (!enabled) return { state: spinning ? "spindown" : "stopped", ready: false };
  if (isFeeding(m)) {
    const asked = state(m.robotState) || state(m.hopperState);
    return { state: asked.includes("FEED") ? "feeding" : "shooting", ready: true };
  }
  const goal = typeof m.shooterGoalRps === "number" && Number.isFinite(m.shooterGoalRps) ? m.shooterGoalRps : null;
  if (goal === null || Math.abs(goal) <= 0.5) return { state: spinning ? "spindown" : "idle", ready: false };
  const robot = state(m.robotState);
  if (robot && !/WARMUP|PREPARE|SCORE|FEED/.test(robot)) return { state: "warm", ready: false };
  const atSpeed = typeof m.shooterAtSpeed === "boolean"
    ? m.shooterAtSpeed
    : Math.abs(rps - goal) <= Math.max(1, Math.abs(goal) * 0.03);
  return { state: atSpeed ? "ready" : "spinning", ready: atSpeed };
}

/**
 * How much FUEL is in the hopper, estimated. Nothing on the robot counts balls, so the estimate runs on
 * time: while it intakes the hopper fills at `intakeRate` balls a second, while it feeds a spinning
 * shooter it empties at `feedRate`, and ejecting empties it at `ejectRate`. The one real measurement - the
 * hopper's full sensor - pins it at `capacity` whenever it reads true.
 *
 * step() returns how many balls left through the shooter in that step, so the views launch one ball each;
 * the fraction left over carries to the next step, so the cadence holds at any frame rate.
 */
export function createHopper({ capacity = 50, intakeRate = 8, feedRate = 8, ejectRate = 6, preload = PRELOAD_FUEL } = {}) {
  const cap = Math.max(1, capacity);
  let fill = Math.min(cap, Math.max(0, preload));
  let owed = 0;
  return {
    get fill() {
      return fill;
    },
    get capacity() {
      return cap;
    },
    /** Start again from `count` balls, the preload by default: a new match. */
    reset(count = preload) {
      fill = Math.min(cap, Math.max(0, count));
      owed = 0;
    },
    step(dt, m) {
      if (!(dt > 0) || !m) return 0;
      const seconds = Math.min(dt, 0.25);
      if (m.hopperFull === true) fill = cap;
      else if (isIntaking(m)) fill = Math.min(cap, fill + intakeRate * seconds);
      if (isEjecting(m)) fill = Math.max(0, fill - ejectRate * seconds);
      if (!isFeeding(m) || fill <= 0) {
        owed = 0;
        return 0;
      }
      owed += feedRate * seconds;
      /* A hair of slack, so seven frames of a seventh of a second owe eight balls, not 7.9999. */
      const launched = Math.min(Math.floor(owed + 1e-9), Math.floor(fill + 1e-9));
      owed -= launched;
      fill = Math.max(0, fill - launched);
      if (fill < 1 && launched === 0 && owed >= 1) {
        /* The last part of a ball is not a ball. */
        fill = 0;
        owed = 0;
      }
      return launched;
    },
  };
}

/**
 * The ball's launch angle above horizontal, in degrees, for a hood at `hoodDeg` as Hood.java reports it.
 *
 * Hood.java's angle is the hood's, not the ball's: 11 degrees is the retracted hard stop, and the ball
 * leaves at the complement. That is what the robot's own shot table says: a ball launched at 30 degrees
 * could not climb to the HUB's opening from 1.42 m at all, while at 60 degrees every entry in the table
 * lands in it with the ball keeping the same share of the flywheel's speed (see fitKeep).
 */
export function launchAngleDeg(hoodDeg) {
  return 90 - hoodDeg;
}

/** The speed a ball leaves at: the flywheel's surface speed times the share the ball keeps. */
export function launchSpeed(shooterRps, wheelRadiusM, keep) {
  return Math.abs(shooterRps) * 2 * Math.PI * wheelRadiusM * keep;
}

/**
 * The launch speed that carries a ball from `exitHeightM` to `targetHeightM`, `distanceM` away across the
 * floor, launched at `angleDeg`. Null when no speed can: the target is above the line the ball leaves on.
 */
export function speedToReach(distanceM, angleDeg, exitHeightM, targetHeightM, g = GRAVITY) {
  const theta = (angleDeg * Math.PI) / 180;
  const rise = exitHeightM + distanceM * Math.tan(theta) - targetHeightM;
  const cos = Math.cos(theta);
  if (!(rise > 0) || !(cos > 1e-6)) return null;
  return Math.sqrt((g * distanceM * distanceM) / (2 * cos * cos * rise));
}

/**
 * The share of the flywheel's surface speed a ball keeps, fitted to a robot's shot table: for each
 * `[distance m, RPM]` entry, the speed that lands the ball in the target at that distance over the
 * surface speed that RPM gives. Returns `{ keep, spread }` - the mean and the largest difference from it
 * - or null when no entry can be reached. A small spread is the check that the geometry is right.
 */
export function fitKeep(table, { hoodDeg, exitHeightM, targetHeightM, wheelRadiusM }) {
  const shares = [];
  for (const [distance, rpm] of table) {
    const needed = speedToReach(distance, launchAngleDeg(hoodDeg), exitHeightM, targetHeightM);
    const surface = (rpm / 60) * 2 * Math.PI * wheelRadiusM;
    if (needed !== null && surface > 0) shares.push(needed / surface);
  }
  if (!shares.length) return null;
  const keep = shares.reduce((a, b) => a + b, 0) / shares.length;
  return { keep, spread: Math.max(...shares.map((s) => Math.abs(s - keep))) };
}

/**
 * Where a ball is `t` seconds after leaving `from` ([x, y, z], y up) at `velocity` ([vx, vy, vz]), with
 * gravity alone. Foam FUEL does lose speed to the air, but the share fitted by fitKeep already absorbs
 * that for the distances a robot shoots from.
 */
export function ballAt(from, velocity, t, g = GRAVITY) {
  return [from[0] + velocity[0] * t, from[1] + velocity[1] * t - 0.5 * g * t * t, from[2] + velocity[2] * t];
}
