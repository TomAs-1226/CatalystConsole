/* The team's own robot, from its CAD.
 *
 * `npm run robot-cad` bakes an Onshape export into src/vendor/robot.glb and a manifest, robot.json, that
 * says where every moving part pivots and slides (see scripts/robot-cad.mjs). This module loads the pair
 * once for the page and holds the arithmetic that poses the model from telemetry: the hood's rotation for
 * Hood.java's angle, the intake's slide for Deploy's length, where a ball leaves the shooter at a hood
 * angle, where balls come in through the intake, how fast each roller appears to turn, and each swerve
 * module's heading and wheel speed. The drawing - materials, bumpers, the FUEL in the hopper - is
 * robot3d.js's.
 *
 * All positions are in the robot's frame, as the manifest writes them: metres, x toward the front, y up,
 * z toward the right, the floor under the middle of the swerve modules at the origin.
 */

/** The pair from `npm run robot-cad`, loaded once per page: `{ manifest, scene }`, or null without one. */
let loading = null;
export function loadRobotCad() {
  loading ??= (async () => {
    const response = await fetch("./vendor/robot.json").catch(() => null);
    if (!response || !response.ok) return null;
    const manifest = await response.json();
    if (manifest?.version !== 1) return null;
    const { GLTFLoader } = await import("./vendor/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().loadAsync(`./vendor/${manifest.model?.file ?? "robot.glb"}`);
    return { manifest, scene: gltf.scene };
  })().catch((err) => {
    console.warn("no robot CAD to draw; drawing the generic robot", err);
    return null;
  });
  return loading;
}

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Turn [x, y, z] about the unit `axis` through `pivot` by `angle` radians (Rodrigues). */
export function turnAbout(point, pivot, axis, angle) {
  const p = [point[0] - pivot[0], point[1] - pivot[1], point[2] - pivot[2]];
  const turned = turnVector(p, axis, angle);
  return [turned[0] + pivot[0], turned[1] + pivot[1], turned[2] + pivot[2]];
}

/** Turn the vector `v` about the unit `axis` by `angle` radians. */
export function turnVector(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [kx, ky, kz] = axis;
  const dot = kx * v[0] + ky * v[1] + kz * v[2];
  const cross = [ky * v[2] - kz * v[1], kz * v[0] - kx * v[2], kx * v[1] - ky * v[0]];
  return [
    v[0] * c + cross[0] * s + kx * dot * (1 - c),
    v[1] * c + cross[1] * s + ky * dot * (1 - c),
    v[2] * c + cross[2] * s + kz * dot * (1 - c),
  ];
}

/**
 * The hood's rotation from its modelled pose, in radians about the manifest's hood axis, for Hood.java's
 * `hoodDeg`. Held between the retracted stop and the rack's physical end, so a bad reading cannot fold
 * the hood through the robot. With no reading the hood stays where the CAD has it.
 */
export function hoodTurn(manifest, hoodDeg) {
  const hood = manifest.hood;
  if (!Number.isFinite(hoodDeg)) return 0;
  const high = Number.isFinite(hood.physicalMax) ? hood.physicalMax : hood.max ?? 45;
  return (clamp(hoodDeg, hood.stop ?? hood.cadAngle, high) - hood.cadAngle) * DEG;
}

/** How far the intake has slid out of its retracted pose, as [x, y, z], for a deploy length in metres. */
export function intakeSlide(manifest, deployM) {
  const intake = manifest.intake;
  const along = Number.isFinite(deployM) ? clamp(deployM, 0, intake.hardStop ?? intake.travel) : intake.restPosition ?? 0;
  return [intake.axis[0] * along, intake.axis[1] * along, intake.axis[2] * along];
}

/**
 * Where a ball leaves the shooter with the hood at `hoodDeg`, and which way: `{ point, direction }`. The
 * exit is carried by the hood, so it turns with it about the hood's pivot.
 */
export function shooterExit(manifest, hoodDeg) {
  const exit = manifest.shooter.exit;
  const hood = manifest.hood;
  const turn = Number.isFinite(hoodDeg) ? hoodTurn(manifest, hoodDeg) : hoodTurn(manifest, exit.atHoodAngle ?? hood.cadAngle);
  return {
    point: turnAbout(exit.point, hood.pivot, hood.axis, turn),
    direction: turnVector(exit.direction, hood.axis, turn),
    width: exit.width,
  };
}

/** Where balls come in through the intake with it slid out `deployM` metres: the middle of its mouth. */
export function intakeMouth(manifest, deployM) {
  const mouth = manifest.intakeMouth;
  const axis = manifest.intake.axis;
  const along = (Number.isFinite(deployM) ? deployM : 0) - mouth.atIntakeExtension;
  return [mouth.center[0] + axis[0] * along, mouth.center[1] + axis[1] * along, mouth.center[2] + axis[2] * along];
}

/* How fast a roller appears to turn, revolutions a second. The eye cannot follow a flywheel at thirty
   revolutions a second - at sixty frames a second it strobes backwards - so every roller is shown at a
   rate that reads as fast without aliasing, rising with the real speed and never past SPIN_CAP. */
const SPIN_CAP = 4.5;
function shown(revsPerSecond) {
  const r = Math.abs(revsPerSecond);
  if (!(r > 1e-3)) return 0;
  return Math.sign(revsPerSecond) * Math.min(SPIN_CAP, r < 2 ? r : 2 + Math.log2(r / 2) * 0.9);
}

/** A real speed in revolutions a second, as it is shown (see SPIN_CAP). */
export function shownRevs(revsPerSecond) {
  return shown(revsPerSecond);
}

/** The shown spin of a roller with this manifest `role`, in revolutions a second, from the readings. */
export function rollerSpin(role, mechanisms) {
  if (!mechanisms) return 0;
  switch (role) {
    case "shooter-flywheel":
    case "shooter-inertia-flywheel":
    case "shooter-top-roller":
      return shown(mechanisms.shooterRps ?? 0);
    case "feeder":
      return shown((mechanisms.feeder?.speed ?? 0) * 12);
    case "conveyor":
      return shown((mechanisms.conveyor?.speed ?? 0) * 12);
    case "intake":
      return shown((mechanisms.intake?.speed ?? 0) * 10);
    default:
      return 0;
  }
}

/**
 * Each swerve module's state for a robot moving at `vx`, `vy` (metres a second, robot frame, WPILib: x
 * forward, y left) and turning at `omega` (radians a second, counter-clockwise), for modules at
 * `positions` ([x, y] each, WPILib frame): `[{ speed, angle }]`, the angle counter-clockwise from forward.
 * A module with nothing to do keeps `rest` rather than snapping to zero.
 */
export function moduleStates(vx, vy, omega, positions, rest = []) {
  return positions.map(([x, y], i) => {
    const mx = vx - omega * y;
    const my = vy + omega * x;
    const speed = Math.hypot(mx, my);
    return speed < 0.02 ? { speed: 0, angle: rest[i] ?? 0 } : { speed, angle: Math.atan2(my, mx) };
  });
}

/**
 * The shortest way for a module to show `angle` given it shows `current`: a swerve module reverses its
 * wheel rather than turning more than a quarter turn, so this does too. Returns { angle, flip } where
 * flip is -1 when the wheel runs backwards.
 */
export function optimizeModule(angle, current) {
  let delta = Math.atan2(Math.sin(angle - current), Math.cos(angle - current));
  if (Math.abs(delta) > Math.PI / 2) {
    delta -= Math.sign(delta) * Math.PI;
    return { angle: current + delta, flip: -1 };
  }
  return { angle: current + delta, flip: 1 };
}

/** The robot's size from the manifest, in the shape robot3d.js's normalizeRobot takes. */
export function cadSpec(manifest) {
  const frame = manifest.framePerimeter;
  const bumpers = manifest.bumpers;
  return {
    frameLength: frame.length,
    frameWidth: frame.width,
    bumperLength: bumpers.length,
    bumperWidth: bumpers.width,
    bumperThickness: bumpers.thickness,
    height: manifest.bounds.max[1],
    /* WPILib's frame: y to the left, which is the manifest's -z. */
    modules: manifest.modules.map((m) => [m.position[0], -m.position[2]]),
  };
}
