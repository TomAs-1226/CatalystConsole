// Bake team 5805's Onshape robot into a light, animatable model for the Park stage and the field tile.
//
//   npm run robot-cad                          # newest Assembly*.gltf|glb in ~/Downloads
//   npm run robot-cad -- "path/to/Assembly 1.glb"
//   npm run robot-cad -- --budget 90000        # triangle budget (default 120000)
//
// Writes src/vendor/robot.glb and src/vendor/robot.json (not committed: src/vendor is generated), then
// `npm run robot-cad-preview` renders them to PNGs for checking by eye.
//
// The export is 100+ MB and 1.6 million triangles once every instance is placed. This drops the
// hardware nobody can see, simplifies each part at an error that keeps it reading as CAD, splits the
// robot into the groups that move (the hood, the intake, every roller, each swerve module's steering
// and wheel), and writes a manifest that says where each pivot and axis is, in the robot's frame, and
// how each was worked out. The robot code (5805-offseason2026-code) supplies the facts the geometry
// cannot: hood angle convention and limits, deploy travel, module layout.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { baseName, classifyFace, classifyPart, materialColour, partName } from "./robot-cad/classify.mjs";
import { buildSolids, clearOfSolids, partTriangles } from "./robot-cad/clearance.mjs";
import { cross, creaseNormals, dot, multiply, normalize, principalAxes, scale, sub, add, transformDirection, transformPoint, length, IDENTITY } from "./robot-cad/geometry.mjs";
import { robotFrame, moduleName, wpilibAngleDeg, wpilibOrder } from "./robot-cad/frame.mjs";
import { listInstances, readGltfFile } from "./robot-cad/gltf-read.mjs";
import { beltPulleys, boxOf, cylinders, findHood, findModules, findRollers, framePerimeter, hoodRack, intakeAxis, mainAxis, partBox, planes, sameLine, splitModuleFaces, stopContacts, vertices } from "./robot-cad/mechanisms.mjs";
import { readMeshFaces, weldFaces } from "./robot-cad/mesh.mjs";
import { simplify, simplifierReady } from "./robot-cad/simplify.mjs";
import { writeGlb } from "./robot-cad/write-glb.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INCH = 0.0254;
const DEG = 180 / Math.PI;

/* Facts from the robot code (C:\Users\yu_th\Desktop\5805-offseason2026-code), which the CAD cannot say. */
const CODE = {
  hood: {
    stopDeg: 11, // Hood.ANGLE_FROM_HORIZONTAL_DEG: "effective hood angle when fully retracted against the hard stop"
    minDeg: 13, // Hood.MIN_ANGLE_DEG, also IDLE
    maxDeg: 45, // Hood.MAX_ANGLE_DEG ("33 is max without top rollers touching", +1 deg past it)
    source: "src/main/java/frc/robot/hood/Hood.java",
  },
  deploy: {
    innerStopIn: 0.0, // Deploy.HOMING_SEED_INWARD
    outerStopIn: 11.9, // Deploy.HOMING_SEED_OUTWARD: "the outer hardstop physically sits just past" MAX
    maxIn: 11.8, // Deploy.MAX_LENGTH_INCHES (fully extended, intaking)
    stowIn: 5.0, // Deploy.STOW_LENGTH_INCHES
    source: "src/main/java/frc/robot/deploy/Deploy.java",
  },
  tuner: {
    moduleXIn: 11, // TunerConstants k*XPos (PLACEHOLDER: Team 581's practice chassis)
    moduleYIn: 11.75, // TunerConstants k*YPos
    wheelRadiusIn: 2,
    source: "src/main/java/frc/robot/generated/TunerConstants.java (marked PLACEHOLDER)",
  },
  shooter: {
    shootsBack: true, // PORT_SPEC: SHOOTER_TO_ROBOT = Transform2d(0, 0, 180 deg): "the robot shoots out its BACK"
    hoodPivot581In: [-11.35, 13.85, 18.85], // PORT_SPEC: 581 MechanismVisualizer SHOOTER_HOOD_PIVOT_POINT (WPILib x, y, z)
    deployAngle581Deg: 6.55, // PORT_SPEC: 581 DEPLOY_ANGLE_FROM_HORIZONTAL
  },
  ballDiameter: 0.15, // FUEL, 5.91 in
};

/* Bumpers are not in the CAD. These are the assumptions the manifest states. */
const BUMPER = { thickness: 3.25 * INCH, height: 5 * INCH, bottom: 0.75 * INCH };

const MATERIAL_LOOK = {
  aluminium: { metallic: 0.7, roughness: 0.42 },
  black: { metallic: 0.2, roughness: 0.55 },
  steel: { metallic: 0.9, roughness: 0.35 },
  poly: { metallic: 0, roughness: 0.12, alpha: 0.4, doubleSided: true },
  print: { metallic: 0, roughness: 0.75 },
  motor: { metallic: 0.35, roughness: 0.45 },
  tread: { metallic: 0, roughness: 0.9 },
  belt: { metallic: 0, roughness: 0.85 },
  electronics: { metallic: 0.1, roughness: 0.6 },
  other: { metallic: 0.1, roughness: 0.6 },
};

/* ---- arguments and input ---- */

function parseArgs(argv) {
  const out = { input: null, budget: 120000, outDir: join(root, "src", "vendor"), minSize: 0.012, crease: 35 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--budget") out.budget = Number(argv[++i]);
    else if (a === "--out") out.outDir = resolve(argv[++i]);
    else if (a === "--min-size") out.minSize = Number(argv[++i]);
    else if (a === "--crease") out.crease = Number(argv[++i]);
    else if (!a.startsWith("--")) out.input = resolve(a);
    else throw new Error(`unknown option ${a}`);
  }
  if (!(out.budget > 1000)) throw new Error("--budget must be a triangle count above 1000");
  return out;
}

function newestExport() {
  const downloads = join(homedir(), "Downloads");
  if (!existsSync(downloads)) return null;
  const candidates = readdirSync(downloads)
    .filter((f) => /^Assembly.*\.(gltf|glb)$/i.test(f))
    .map((f) => ({ path: join(downloads, f), mtime: statSync(join(downloads, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path ?? null;
}

/* ---- small helpers ---- */

const round = (v, digits = 4) => (Array.isArray(v) ? v.map((x) => round(x, digits)) : Number(v.toFixed(digits)));
const log = (...args) => console.log(...args);
const fmt = (n) => Math.round(n).toLocaleString("en-US");

function sumTriangles(faces) {
  let t = 0;
  for (const f of faces) t += f.indices.length / 3;
  return t;
}

/* ---- main ---- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input ?? newestExport();
  if (!input || !existsSync(input)) {
    console.error(args.input ? `No CAD export at ${args.input}` : "No Assembly*.gltf or Assembly*.glb in ~/Downloads.");
    console.error("Export the robot assembly from Onshape as glTF (or GLB), then re-run, optionally passing the path.");
    process.exit(1);
  }
  const started = Date.now();
  const inputStat = statSync(input);
  log(`reading ${input}`);
  log(`  ${(inputStat.size / 1e6).toFixed(1)} MB, modified ${new Date(inputStat.mtimeMs).toISOString()}`);
  const gltf = readGltfFile(input);
  const { json } = gltf;
  const generator = json.asset?.generator ?? "unknown";
  log(`  generator "${generator}", ${json.nodes.length} nodes, ${json.meshes.length} meshes, ${json.materials?.length ?? 0} materials`);

  /* ---- parts ---- */
  const faceCache = new Map();
  const facesOf = (mesh) => {
    if (!faceCache.has(mesh)) faceCache.set(mesh, readMeshFaces(gltf, mesh));
    return faceCache.get(mesh);
  };
  const instances = listInstances(gltf, multiply);
  const parts = instances.map((inst, index) => {
    const chain = inst.chain.map((i) => json.nodes[i]);
    const leaf = chain[chain.length - 1];
    const occurrence = chain.length > 1 ? chain[chain.length - 2] : null;
    const name = partName(leaf.name, occurrence?.name);
    const assemblies = chain.slice(1, -1).filter((n) => !/^occurrence of /i.test(n.name ?? "")).map((n) => baseName(n.name));
    const faces = facesOf(inst.mesh);
    /* Colour by area, so a sticker does not colour a motor. */
    const byColour = new Map();
    for (const f of faces) {
      const c = materialColour(json.materials?.[f.material]).join(",");
      byColour.set(c, (byColour.get(c) || 0) + f.area);
    }
    const colour = [...byColour].sort((a, b) => b[1] - a[1])[0]?.[0].split(",").map(Number) ?? [200, 200, 200];
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const f of faces) for (let i = 0; i < f.positions.length; i++) {
      const k = i % 3;
      if (f.positions[i] < min[k]) min[k] = f.positions[i];
      if (f.positions[i] > max[k]) max[k] = f.positions[i];
    }
    const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const decision = classifyPart({ name, path: assemblies, colour, size }, { minSize: args.minSize });
    return {
      index, name, assemblies, top: assemblies[0] ?? "", label: [...assemblies, name].join(" / "),
      mesh: inst.mesh, cadWorld: inst.world, matrix: inst.world, faces, colour, size,
      keep: decision.keep, cls: decision.cls ?? null, reason: decision.reason ?? null,
      triangles: sumTriangles(faces),
    };
  });
  const totalTriangles = parts.reduce((s, p) => s + p.triangles, 0);
  log(`  ${parts.length} part instances, ${fmt(totalTriangles)} triangles placed`);

  /* ---- the robot frame, from the swerve modules (CAD frame) ---- */
  const found = findModules(parts);
  const centroidOf = (list) => {
    let sum = [0, 0, 0], n = 0;
    for (const p of list) {
      const b = partBox(p);
      sum = add(sum, scale(add(b.min, b.max), 0.5 * p.size));
      n += p.size;
    }
    return n ? scale(sum, 1 / n) : null;
  };
  const drive = parts.filter((p) => p.top === "Drive");
  const intakeParts = parts.filter((p) => p.top === "Intake" && !p.assemblies.includes("Intake Gearboxes"));
  const shooterParts = parts.filter((p) => p.top === "Shooter");
  const driveCentre = centroidOf(drive);
  const intakeHint = intakeParts.length ? sub(centroidOf(intakeParts), driveCentre) : null;
  const shooterHint = shooterParts.length ? sub(driveCentre, centroidOf(shooterParts)) : null;
  const named = (re) => centroidOf(parts.filter((p) => ["Drive", "Floor"].includes(p.top) && re.test(p.name)));
  const frontNamed = named(/\bfront\b/i), backNamed = named(/\bback\b/i);
  const nameHint = frontNamed && backNamed ? sub(frontNamed, backNamed) : null;
  const forwardHint = intakeHint ?? nameHint ?? shooterHint;
  if (!forwardHint) throw new Error("no evidence for which way the robot faces (no Intake or Shooter assembly, no front/back part names)");
  const frame = robotFrame({ modules: found.modules, up: found.up, forwardHint });
  const agree = (hint) => (hint ? dot(normalize(sub(hint, scale(frame.up, dot(hint, frame.up)))), frame.forward) : null);
  log(`robot frame: forward = CAD ${fmtVec(frame.forward)}, up = CAD ${fmtVec(frame.up)}, right = CAD ${fmtVec(frame.right)}`);
  log(`  evidence (cosine with forward): intake ${agree(intakeHint)?.toFixed(3)}, front/back names ${agree(nameHint)?.toFixed(3)}, shooter opposite ${agree(shooterHint)?.toFixed(3)}`);

  /* ---- everything below is in the robot frame ---- */
  for (const p of parts) p.matrix = multiply(frame.matrix, p.cadWorld);
  const inRobot = findModules(parts);
  const modules = wpilibOrder(
    inRobot.modules.map((m) => {
      const position = [m.steerPoint[0], 0, m.steerPoint[2]];
      return { ...m, name: moduleName(position), position };
    }),
  );
  if (new Set(modules.map((m) => m.name)).size !== modules.length) throw new Error(`module names collide: ${modules.map((m) => m.name)}`);
  log(`  modules: ${modules.map((m) => `${m.name} (${round(m.position[0], 3)}, ${round(m.position[2], 3)})`).join(", ")}`);

  const perimeter = framePerimeter(parts);
  const rollers = findRollers(parts);
  const hood = findHood(parts, rollers);
  if (process.env.ROBOT_CAD_DEBUG) {
    for (const r of rollers) log(`  roller ${r.tube.label} r=${round(r.radius, 4)} c=${fmtVec(r.centre)} members=${r.members.map((p) => p.name).join(" | ")} shaft=${r.shaft.map((p) => p.name).join(" | ")}`);
    for (const h of hood?.holes ?? []) log(`  hood hole r=${round(h.radius, 4)} c=${fmtVec(h.centre)} axis=${fmtVec(h.axis)}`);
  }
  if (!hood?.pivot) throw new Error("could not find the hood's pivot");
  const rack = hoodRack(parts, hood);
  if (process.env.ROBOT_CAD_DEBUG) {
    log(`  hood members: ${[...hood.members].filter((p) => p.keep).map((p) => p.name).join(" | ")}`);
    log(`  hood rack: ${JSON.stringify(rack)}`);
  }

  /* ---- groups ---- */
  const moduleOfPart = new Map(modules.map((m) => [m.part, m]));
  const intakeSet = new Set(intakeParts);
  const groupOf = (p) => {
    if (moduleOfPart.has(p)) return "module";
    if (hood.members.has(p)) return "hood";
    if (intakeSet.has(p)) return "intake";
    return "static";
  };

  /* ---- the intake ---- */
  const intakeRacks = intakeParts.filter((p) => p.keep && /\brack\b/i.test(p.name) && p.cls === "aluminium");
  const slide = intakeAxis(intakeRacks.length ? intakeRacks : intakeParts.filter((p) => /\brack\b/i.test(p.name)));
  if (!slide) throw new Error("could not find the intake's slide axis from its racks");
  const stops = stopContacts(
    intakeParts.filter((p) => /hard ?stop/i.test(p.name)),
    parts.filter((p) => !intakeSet.has(p) && /slider|block|guide/i.test(p.name)),
    slide.axis,
  );
  const outer = stops.some((s) => s.side === "outer");
  const inner = stops.some((s) => s.side === "inner");
  const cadExtension = outer ? CODE.deploy.outerStopIn * INCH : inner ? CODE.deploy.innerStopIn * INCH : 0;
  const intakeState = outer ? "deployed (against the outer hard stop)" : inner ? "retracted (against the inner hard stop)" : "unknown";
  const intakeBoxCad = boxOf(intakeParts.filter((p) => p.keep).flatMap((p) => [partBox(p).min, partBox(p).max]));
  const intakeOrigin = sub([(intakeBoxCad.min[0] + intakeBoxCad.max[0]) / 2, (intakeBoxCad.min[1] + intakeBoxCad.max[1]) / 2, 0], scale(slide.axis, cadExtension));
  const inclineDeg = Math.asin(-slide.axis[1]) * DEG;
  log(`intake: axis ${fmtVec(slide.axis)} (${inclineDeg.toFixed(2)} deg below horizontal), CAD shows it ${intakeState}`);
  for (const s of stops) log(`  stop contact: ${s.moving} against ${s.fixed} at ${s.station.toFixed(4)} m (${s.side})`);

  /* ---- the hood ---- */
  const pivot = [hood.pivot.point[0], hood.pivot.point[1], 0];
  const hoodRollers = hood.carried.slice().sort((a, b) => a.centre[1] - b.centre[1]);
  const flywheel = hood.pivotRoller;
  const lastRoller = hoodRollers[hoodRollers.length - 1];
  const exit = shotExit(flywheel, lastRoller);
  /* +z rotation turns the hood's front up when the hood lies ahead of the pivot. Whichever way it is,
     positive rotation in the manifest is the one that flattens the shot (raises Hood.java's angle). */
  const probe = shotExit(flywheel, { ...lastRoller, centre: rotateAbout(lastRoller.centre, pivot, [0, 0, 1], 1 / DEG) });
  const flattensWithPlusZ = probe.elevation < exit.elevation;
  const hoodAxis = flattensWithPlusZ ? [0, 0, 1] : [0, 0, -1];
  const signed = (deg) => (flattensWithPlusZ ? deg : -deg);
  /* Limits in manifest-positive degrees from the CAD pose. */
  let rackLimits = null;
  if (rack?.pinion) {
    const margin = 360 / 154 / 2; // half a tooth of engagement
    const a = rack.pinion.angle - rack.span[1] + margin; // rotating +z moves the rack's angles up
    const b = rack.pinion.angle - rack.span[0] - margin;
    rackLimits = flattensWithPlusZ ? [a, b] : [-b, -a];
  }
  const collision = hoodCollision(hoodRollers, rollers.filter((r) => !hood.carried.includes(r) && r !== flywheel), pivot, hoodAxis);
  const retractLimit = Math.max(rackLimits ? rackLimits[0] : -Infinity, collision.retract ?? -Infinity);
  const extendLimit = Math.min(rackLimits ? rackLimits[1] : Infinity, collision.extend ?? Infinity);
  const atStop = retractLimit > -2.5;
  const cadAngle = atStop ? CODE.hood.stopDeg : CODE.hood.stopDeg - retractLimit;
  log(`hood: pivot (${round(pivot[0], 4)}, ${round(pivot[1], 4)}) axis ${fmtVec(hoodAxis)}; exit elevation ${exit.elevation.toFixed(2)} deg at the CAD pose`);
  log(`  travel from the CAD pose: retract ${retractLimit.toFixed(2)} deg (rack ${rackLimits?.[0]?.toFixed(2)}, rollers ${collision.retract?.toFixed(2)}), extend ${extendLimit.toFixed(2)} deg`);

  /* ---- rollers: roles, names, spin ---- */
  const conveyorRollers = rollers.filter((r) => r.tube.top === "Floor").sort((a, b) => b.centre[0] - a.centre[0]);
  const feederRollers = rollers.filter((r) => r.tube.top === "Shooter" && r !== flywheel && !hood.carried.includes(r) && !/flywheel/i.test(r.tube.name)).sort((a, b) => a.centre[1] - b.centre[1]);
  const inertia = rollers.filter((r) => /flywheel/i.test(r.tube.name) && r !== flywheel);
  const intakeRollers = rollers.filter((r) => intakeSet.has(r.tube)).sort((a, b) => a.centre[1] - b.centre[1]);
  const floorFit = fitLine(conveyorRollers.map((r) => [r.centre[0], r.centre[1]]));
  /* Down the slope toward the feeder, and the normal on the side the balls are. */
  const floorDown = floorFit ? normalize([-1, -floorFit.slope, 0]) : [-1, 0, 0];
  let floorNormal = normalize([floorDown[1], -floorDown[0], 0]);
  if (floorNormal[1] < 0) floorNormal = scale(floorNormal, -1);
  /* A roller's spin axis is its fitted axis, signed so positive rotation moves the surface at `contact`
     (a direction from the axis) along `travel`, the ball's direction of motion there. */
  const spinAxis = (r, contact, travel) => {
    const s = dot(cross(contact, travel), r.axis);
    return s < 0 ? scale(r.axis, -1) : r.axis;
  };
  const named2 = (list, prefix) => list.map((r, i) => [r, list.length === 1 ? prefix : `${prefix}-${i + 1}`]);
  const rollerInfo = new Map();
  const note = (r, node, role, spin, how, confidence) => rollerInfo.set(r, { node, role, spin, how, confidence });
  note(flywheel, "roller-flywheel", "shooter-flywheel", spinAxis(flywheel, sub(lastRoller.centre, flywheel.centre), exit.direction),
    "the largest shooter roller; the hood pivots on its axis. Positive spin moves its surface up past the ball toward the exit.", "high");
  hoodRollers.forEach((r, i) => note(r, hoodRollers.length === 2 ? ["roller-hood-lower", "roller-hood-upper"][i] : `roller-hood-${i + 1}`, "shooter-top-roller",
    spinAxis(r, sub(flywheel.centre, r.centre), exit.direction),
    "pinned through the hood brackets, so it rides on the hood; the ball is squeezed between it and the flywheel. Positive spin moves its ball-side surface toward the exit.", "high"));
  for (const [r, node] of named2(feederRollers, "roller-feeder")) {
    note(r, node, "feeder", spinAxis(r, [Math.sign(flywheel.centre[0] - r.centre[0]) || -1, 0, 0], [0, 1, 0]),
      "a fixed shooter roller in the vertical stack below the hood rollers (1 is lowest); Feeder.java is 'the last stage that pushes fuel into the shooter wheels'. The ball rises on the stack's flywheel side (it has to, to meet the flywheel), so positive spin carries it up there.", "medium");
  }
  for (const [r, node] of named2(conveyorRollers, "roller-conveyor")) {
    note(r, node, "conveyor", spinAxis(r, floorNormal, floorDown),
      "a roller of the sloped hopper floor (1 is frontmost); Conveyor.java 'carries fuel from the hopper toward the tower and feeder'. Positive spin moves balls lying on it down the slope toward the feeder.", "medium");
  }
  for (const [r, node] of named2(intakeRollers, "roller-intake")) {
    note(r, node, "intake", spinAxis(r, [0, -1, 0], [-1, 0, 0]),
      "a roller on the deploying intake (1 is lowest). Positive spin moves its underside backward, pulling a ball in.", "high");
  }
  for (const [r, node] of named2(inertia, "roller-flywheel-inertia")) {
    note(r, node, "shooter-inertia-flywheel", spinAxis(r, [0, 1, 0], cross(rollerInfo.get(flywheel).spin, [0, 1, 0])),
      "a stainless flywheel on its own shaft outside the side plate, belted to the shooter flywheel, so it turns the same way; its axis is signed like the flywheel's.", "high");
  }
  for (const r of rollers) {
    if (!rollerInfo.has(r)) note(r, `roller-${rollerInfo.size + 1}`, "other", r.axis, "a driven tube not recognised as any mechanism's roller.", "low");
  }
  const drives = driveRatios(parts, rollers, rollerInfo, flywheel);

  /* ---- which node each part's geometry goes to ---- */
  const nodeOfPart = new Map();
  for (const r of rollers) for (const p of r.members) nodeOfPart.set(p, rollerInfo.get(r).node);
  const groupNode = { static: "static", hood: "hood", intake: "intake" };

  /* ---- node origins in the robot frame (rest pose) ---- */
  const origins = new Map();
  origins.set("robot", [0, 0, 0]);
  origins.set("static", [0, 0, 0]);
  origins.set("hood", pivot);
  origins.set("intake", intakeOrigin);
  const parentOf = new Map([["static", "robot"], ["hood", "robot"], ["intake", "robot"]]);
  /* CAD-pose offset of each group, subtracted so the GLB rests retracted. */
  const restShift = { intake: scale(slide.axis, -cadExtension) };
  for (const r of rollers) {
    const info = rollerInfo.get(r);
    const group = groupOf(r.tube);
    const centre = add([r.centre[0], r.centre[1], r.centre[2]], restShift[group] ?? [0, 0, 0]);
    origins.set(info.node, centre);
    parentOf.set(info.node, group === "module" ? "robot" : groupNode[group]);
  }
  for (const m of modules) {
    const steer = [m.position[0], m.wheelCenter[1], m.position[2]];
    origins.set(`module-${m.name}`, steer);
    origins.set(`wheel-${m.name}`, m.wheelCenter);
    parentOf.set(`module-${m.name}`, "robot");
    parentOf.set(`wheel-${m.name}`, `module-${m.name}`);
  }

  /* ---- geometry jobs: each (part, region) whose triangles go to one node ---- */
  const jobs = [];
  const moduleSplits = new Map();
  const treadColours = [];
  for (const m of modules) {
    const split = splitModuleFaces(m.part, m, [0, 1, 0]);
    moduleSplits.set(m, split);
    treadColours.push(materialColour(json.materials?.[m.part.faces[m.tread.index].material]));
  }
  for (const p of parts) {
    if (!p.keep) continue;
    if (moduleOfPart.has(p)) {
      const m = moduleOfPart.get(p);
      const split = moduleSplits.get(m);
      for (const [region, faces, node] of [["fixed", split.fixed, "static"], ["steer", split.steer, `module-${m.name}`], ["wheel", split.wheel, `wheel-${m.name}`]]) {
        jobs.push({ part: p, region, faces: new Set(faces), node, shift: [0, 0, 0] });
      }
      continue;
    }
    const group = groupOf(p);
    const node = nodeOfPart.get(p) ?? groupNode[group];
    jobs.push({ part: p, region: "all", faces: null, node, shift: restShift[group] ?? [0, 0, 0] });
  }

  /* ---- simplification, searched to fit the budget ---- */
  await simplifierReady;
  const welded = new Map();
  const weldedOf = (job) => {
    const key = `${job.part.mesh}|${job.region}|${job.region === "all" ? "" : [...job.faces].join(",")}`;
    if (!welded.has(key)) {
      const select = job.faces ? (faceIndex) => job.faces.has(faceIndex) : null;
      const mesh = weldFaces(job.part.faces, { select });
      const pa = mesh.indices.length ? principalAxes(mesh.positions, mesh.indices) : null;
      /* A hollow tube's thinnest feature is its wall, not its outside: FRC rectangular tube is 1/16 in wall. */
      const wall = /\btube\b/i.test(job.part.name) && !/\bOD x\b/i.test(job.part.name) ? 0.0625 * INCH : Infinity;
      welded.set(key, { key, mesh, thickness: Math.min(pa ? pa.axes[0].extent : 0, wall), size: job.part.size, cache: new Map() });
    }
    return welded.get(key);
  };
  for (const job of jobs) job.welded = weldedOf(job);
  /* Parts inside the drive base are mostly hidden by the bumpers and the superstructure above them, so
     they get a coarser error; every part keeps within 3% of its size and 80% of its thickness, so a
     plate cannot collapse through itself. */
  const hidden = (part) => part.top === "Drive" && !/swerve x2/i.test(part.name);
  for (const job of jobs) job.welded.weight = Math.max(job.welded.weight ?? 0, hidden(job.part) && job.region === "all" ? 2 : 1);
  const errorFor = (w, global) => Math.max(0.00005, Math.min(global * w.weight, 0.03 * w.size, 0.8 * Math.max(w.thickness, 0.0005)));
  const simplified = (w, global) => {
    const e = errorFor(w, global);
    const k = e.toFixed(7);
    if (!w.cache.has(k)) w.cache.set(k, simplify(w.mesh, e));
    return w.cache.get(k);
  };
  const countAt = (global) => jobs.reduce((s, job) => s + simplified(job.welded, global).indices.length / 3, 0);
  let lo = 0.0001, hi = 0.02;
  let chosen = hi;
  if (countAt(lo) <= args.budget) chosen = lo;
  else {
    for (let i = 0; i < 14; i++) {
      const mid = Math.sqrt(lo * hi);
      if (countAt(mid) <= args.budget) {
        hi = mid;
        chosen = mid;
      } else lo = mid;
    }
  }
  log(`simplifying: error ${(chosen * 1000).toFixed(3)} mm (x2 inside the drive base; capped per part at 3% of its size and 80% of its thickness) -> ${fmt(countAt(chosen))} triangles`);
  if (process.env.ROBOT_CAD_DEBUG) {
    const rows = new Map();
    for (const job of jobs) {
      const key = `${job.part.name} [${job.region}]`;
      const row = rows.get(key) ?? { n: 0, cad: 0, at: 0, fine: 0, thickness: job.welded.thickness };
      row.n++;
      row.cad += job.welded.mesh.indices.length / 3;
      row.at += simplified(job.welded, chosen).indices.length / 3;
      row.fine += simplified(job.welded, 0.0005).indices.length / 3;
      rows.set(key, row);
    }
    log("  top parts by triangles (instances, welded CAD, at chosen error, at 0.5 mm, thickness mm):");
    for (const [key, r] of [...rows].sort((a, b) => b[1].at - a[1].at).slice(0, 40)) log(`    ${String(r.n).padStart(2)} x ${key.slice(0, 70).padEnd(70)} ${fmt(r.cad).padStart(8)} ${fmt(r.at).padStart(7)} ${fmt(r.fine).padStart(7)} ${(r.thickness * 1000).toFixed(1)}`);
  }

  /* ---- materials: class plus the CAD's colour, near-identical colours merged ---- */
  const colourArea = new Map();
  const faceClass = (job, face) => {
    if (moduleOfPart.has(job.part)) return classifyFace(job.part.cls, materialColour(json.materials?.[face.material]), { treadColours });
    return job.part.cls;
  };
  for (const job of jobs) {
    for (const face of job.part.faces) {
      const cls = faceClass(job, face);
      const colour = materialColour(json.materials?.[face.material]);
      const key = `${cls}|${colour.join(",")}`;
      colourArea.set(key, { cls, colour, area: (colourArea.get(key)?.area ?? 0) + face.area });
    }
  }
  const clusters = [];
  for (const entry of [...colourArea.values()].sort((a, b) => b.area - a.area)) {
    const near = clusters.find((c) => c.cls === entry.cls && Math.abs(c.colour[0] - entry.colour[0]) + Math.abs(c.colour[1] - entry.colour[1]) + Math.abs(c.colour[2] - entry.colour[2]) <= 40);
    if (near) {
      near.area += entry.area;
      near.members.push(entry.colour);
    } else clusters.push({ ...entry, members: [entry.colour] });
  }
  /* A colour covering under 2% of its class folds into that class's main colour. */
  for (const cls of new Set(clusters.map((c) => c.cls))) {
    const mine = clusters.filter((c) => c.cls === cls);
    const total = mine.reduce((s, c) => s + c.area, 0);
    const main = mine[0];
    for (const c of mine.slice(1)) {
      if (c.area < 0.02 * total) {
        main.members.push(...c.members);
        main.area += c.area;
        clusters.splice(clusters.indexOf(c), 1);
      }
    }
  }
  const materialKeyOf = (cls, colour) => {
    const exact = clusters.find((c) => c.cls === cls && c.members.some((m) => m[0] === colour[0] && m[1] === colour[1] && m[2] === colour[2]));
    const c = exact ?? clusters.find((k) => k.cls === cls);
    return `${cls}|${c.colour.join(",")}`;
  };
  const materials = new Map();
  for (const c of clusters) {
    const hex = `#${c.colour.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    materials.set(`${c.cls}|${c.colour.join(",")}`, { name: c.cls, colour: c.colour, ...MATERIAL_LOOK[c.cls], extras: { class: c.cls, cadColour: hex } });
  }

  /* ---- final geometry, per node and material ---- */
  const nodePrims = new Map();
  const perAssembly = new Map();
  for (const job of jobs) {
    const w = job.welded;
    const mesh = simplified(w, chosen);
    const faces = job.part.faces;
    /* Triangles grouped by material key, then crease normals per group in the part's own frame. */
    const byKey = new Map();
    const faceIndexOfMaterial = new Map();
    for (const f of faces) faceIndexOfMaterial.set(f.material, f);
    for (let t = 0; t < mesh.indices.length / 3; t++) {
      const face = faceIndexOfMaterial.get(mesh.triangleMaterial[t]);
      const colour = materialColour(json.materials?.[mesh.triangleMaterial[t]]);
      const cls = faceClass(job, face);
      const key = materialKeyOf(cls, colour);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
    }
    const origin = origins.get(job.node);
    if (!origin) throw new Error(`no origin for node ${job.node}`);
    let jobTriangles = 0;
    for (const [key, idx] of byKey) {
      const remap = new Map();
      const pos = [];
      const local = new Uint32Array(idx.length);
      idx.forEach((v, i) => {
        if (!remap.has(v)) {
          remap.set(v, pos.length / 3);
          pos.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
        }
        local[i] = remap.get(v);
      });
      const shaded = creaseNormals(Float32Array.from(pos), local, args.crease);
      const out = new Float32Array(shaded.positions.length);
      const nrm = new Float32Array(shaded.normals.length);
      for (let i = 0; i < shaded.positions.length; i += 3) {
        const p = transformPoint(job.part.matrix, [shaded.positions[i], shaded.positions[i + 1], shaded.positions[i + 2]]);
        out[i] = p[0] + job.shift[0] - origin[0];
        out[i + 1] = p[1] + job.shift[1] - origin[1];
        out[i + 2] = p[2] + job.shift[2] - origin[2];
        const n = normalize(transformDirection(job.part.matrix, [shaded.normals[i], shaded.normals[i + 1], shaded.normals[i + 2]]));
        nrm[i] = n[0]; nrm[i + 1] = n[1]; nrm[i + 2] = n[2];
      }
      if (!nodePrims.has(job.node)) nodePrims.set(job.node, new Map());
      const prims = nodePrims.get(job.node);
      if (!prims.has(key)) prims.set(key, { positions: [], normals: [], indices: [], count: 0 });
      const acc = prims.get(key);
      for (let i = 0; i < shaded.indices.length; i++) acc.indices.push(shaded.indices[i] + acc.count);
      for (const v of out) acc.positions.push(v);
      for (const v of nrm) acc.normals.push(v);
      acc.count += out.length / 3;
      jobTriangles += shaded.indices.length / 3;
    }
    const sub0 = job.part.top || "(root)";
    const row = perAssembly.get(sub0) ?? { before: 0, after: 0 };
    row.after += jobTriangles;
    perAssembly.set(sub0, row);
  }
  for (const p of parts) {
    const row = perAssembly.get(p.top || "(root)") ?? { before: 0, after: 0 };
    row.before += p.triangles;
    perAssembly.set(p.top || "(root)", row);
  }

  /* ---- the node tree ---- */
  const treeNodes = new Map();
  const nodeSpec = (name) => {
    if (treeNodes.has(name)) return treeNodes.get(name);
    const parent = parentOf.get(name);
    const origin = origins.get(name);
    const parentOrigin = parent ? origins.get(parent) : [0, 0, 0];
    const spec = { name, translation: sub(origin, parentOrigin), children: [], primitives: [] };
    const prims = nodePrims.get(name);
    if (prims) for (const [material, acc] of prims) spec.primitives.push({ material, positions: Float32Array.from(acc.positions), normals: Float32Array.from(acc.normals), indices: Uint32Array.from(acc.indices) });
    treeNodes.set(name, spec);
    if (parent) nodeSpec(parent).children.push(spec);
    return spec;
  };
  const rootSpec = { name: "robot", translation: [0, 0, 0], children: [], primitives: [] };
  treeNodes.set("robot", rootSpec);
  for (const name of ["static", "hood", "intake", ...[...rollerInfo.values()].map((r) => r.node), ...modules.flatMap((m) => [`module-${m.name}`, `wheel-${m.name}`])]) nodeSpec(name);

  mkdirSync(args.outDir, { recursive: true });
  const glbPath = join(args.outDir, "robot.glb");
  const written = await writeGlb(glbPath, rootSpec, materials, {
    generator: `catalyst-console robot-cad from "${basename(input)}" (${generator})`,
    extras: { manifest: "robot.json", frame: "x forward, y up, z right, metres; origin on the floor under the centre of the swerve modules" },
  });
  log(`wrote ${glbPath}: ${(written.bytes / 1e6).toFixed(2)} MB, ${fmt(written.triangles)} triangles, ${written.meshes} meshes (${written.sharedMeshes} shared), ${written.primitives} primitives`);

  /* ---- bounds at rest ---- */
  const restBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const [name, prims] of nodePrims) {
    const o = origins.get(name);
    for (const acc of prims.values()) {
      for (let i = 0; i < acc.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = acc.positions[i + k] + o[k];
          restBox.min[k] = Math.min(restBox.min[k], v);
          restBox.max[k] = Math.max(restBox.max[k], v);
        }
      }
    }
  }

  /* ---- manifest ---- */
  const manifest = buildManifest({
    input, inputStat, generator, json, totalTriangles, frame, found, modules, perimeter, parts, rollers, rollerInfo, drives,
    hood, rack, pivot, hoodAxis, exit, cadAngle, retractLimit, extendLimit, rackLimits, collision, atStop, flywheel, lastRoller, signed,
    slide, stops, cadExtension, intakeState, intakeOrigin, inclineDeg, intakeRollers, intakeParts,
    conveyorRollers, feederRollers, floorFit, origins, restShift, groupOf,
    written, chosen, args, restBox, materials, perAssembly, jobs, intakeHint, nameHint, shooterHint, agree,
  });
  const jsonPath = join(args.outDir, "robot.json");
  writeFileSync(jsonPath, JSON.stringify(manifest, null, 2) + "\n");
  log(`wrote ${jsonPath}`);

  /* ---- report ---- */
  log("\ntriangles by sub-assembly (instanced CAD -> model):");
  for (const [name, row] of [...perAssembly].sort((a, b) => b[1].before - a[1].before)) log(`  ${name.padEnd(10)} ${fmt(row.before).padStart(10)} -> ${fmt(row.after).padStart(7)}`);
  log("dropped by rule (instances, CAD triangles):");
  for (const [reason, row] of Object.entries(manifest.cleanup.dropped)) log(`  ${reason.padEnd(40)} ${String(row.instances).padStart(4)}  ${fmt(row.triangles).padStart(9)}`);
  log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

/* ---- mechanism helpers that need the whole picture ---- */

function fmtVec(v) {
  return `(${v.map((x) => (Math.abs(x) < 5e-5 ? 0 : x).toFixed(4)).join(", ")})`;
}

/** Rotate point p about the line through `centre` along unit `axis` by `angle` radians. */
function rotateAbout(p, centre, axis, angle) {
  const d = sub(p, centre);
  const c = Math.cos(angle), s = Math.sin(angle);
  const along = scale(axis, dot(axis, d));
  const perp = sub(d, along);
  return add(centre, add(along, add(scale(perp, c), scale(cross(axis, perp), s))));
}

/**
 * The ball's release from a two-wheel pinch: it leaves square to the line between the flywheel's axis
 * and the last roller's axis, upward, from the middle of the gap between their surfaces.
 */
function shotExit(flywheel, roller) {
  const d = sub([roller.centre[0], roller.centre[1], 0], [flywheel.centre[0], flywheel.centre[1], 0]);
  const distance = length(d);
  const u = scale(d, 1 / distance);
  let n = [-u[1], u[0], 0];
  if (n[1] < 0) n = scale(n, -1);
  const gap = distance - flywheel.radius - roller.radius;
  const point = add([flywheel.centre[0], flywheel.centre[1], 0], scale(u, flywheel.radius + gap / 2));
  const elevation = Math.atan2(n[1], Math.hypot(n[0], n[2])) * DEG;
  return { point, direction: n, elevation, gap, compression: 0.15 - gap, lineAngle: Math.atan2(u[1], u[0]) * DEG };
}

/**
 * How far the hood can turn from the CAD pose before a roller it carries touches a fixed roller, in
 * degrees of manifest-positive rotation: { retract (negative), extend (positive) }.
 */
function hoodCollision(carried, fixed, pivot, axis) {
  const hits = (deg) => carried.some((r) => {
    const c = rotateAbout(r.centre, pivot, axis, deg / DEG);
    return fixed.some((f) => Math.hypot(c[0] - f.centre[0], c[1] - f.centre[1]) < r.radius + f.radius);
  });
  const search = (dir) => {
    for (let deg = 0.05; deg <= 60; deg += 0.05) if (hits(dir * deg)) return dir * (deg - 0.05);
    return null;
  };
  return { retract: search(-1), extend: search(1) };
}

/**
 * Ball centres packed face-centred-cubic inside `inside(p)`, trying lattice offsets within `bounds` and
 * keeping the arrangement that fits most, sorted lowest first.
 */
function packBalls(inside, bounds, diameter) {
  const a = diameter * Math.SQRT2;
  const basis = [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]];
  let best = [];
  const steps = 5;
  for (let ox = 0; ox < steps; ox++) for (let oy = 0; oy < steps; oy++) for (let oz = 0; oz < steps; oz++) {
    const offset = [(ox / steps) * a, (oy / steps) * a, (oz / steps) * a];
    const found = [];
    for (let i = -1; bounds.min[0] + (i - 1) * a <= bounds.max[0]; i++) {
      for (let j = -1; bounds.min[1] + (j - 1) * a <= bounds.max[1]; j++) {
        for (let k = -1; bounds.min[2] + (k - 1) * a <= bounds.max[2]; k++) {
          for (const b of basis) {
            const p = [bounds.min[0] + offset[0] + (i + b[0]) * a, bounds.min[1] + offset[1] + (j + b[1]) * a, bounds.min[2] + offset[2] + (k + b[2]) * a];
            if (inside(p)) found.push(p);
          }
        }
      }
    }
    if (found.length > best.length) best = found;
  }
  return best.sort((p, q) => p[1] - q[1] || p[0] - q[0] || p[2] - q[2]);
}

/** Least-squares y = a + slope·x through 2D points. */
function fitLine(points) {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) * (x - mx);
    sxy += (x - mx) * (y - my);
  }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, at: (x) => my + slope * (x - mx) };
}

/**
 * Speed ratios between rollers that share a drive: belts (same direction, ratio by tooth count read
 * from the belt's arcs) and spur gears (opposite direction, ratio by tooth count from the part name,
 * meshing when their centre distance matches their pitch radii). Returns, for each roller reachable from
 * the flywheel, { from: flywheel, ratio } with the sign giving direction relative to the manifest's
 * spin axes.
 */
function driveRatios(parts, rollers, rollerInfo, flywheel) {
  /* Shafts: axis lines, with bearing-mounted parts kept apart from what is fixed to the shaft. */
  const shafts = [];
  const shaftOf = (line, bearing) => {
    let s = shafts.find((k) => k.bearing === bearing && sameLine(k, line, 0.0015));
    if (!s) {
      s = { axis: line.axis, centre: line.centre, bearing, gears: [], pulleys: [], roller: null };
      shafts.push(s);
    }
    return s;
  };
  for (const r of rollers) shaftOf(r, r.onBearings).roller = r;
  const top = flywheel.tube.top;
  for (const p of parts.filter((q) => q.top === top)) {
    const gear = /(\d+)t\b.*\bspur gear\b.*?\((\d+)\s*DP/i.exec(p.name);
    if (!gear) continue;
    const a = mainAxis(p);
    if (!a) continue;
    shaftOf(a, /circular bore/i.test(p.name)).gears.push({ teeth: Number(gear[1]), dp: Number(gear[2]), centre: a.centre, axis: a.axis });
  }
  const edges = [];
  for (const p of parts.filter((q) => q.top === top && /belt/i.test(q.name))) {
    const pulleys = beltPulleys(p);
    if (pulleys.length !== 2) continue;
    const ends = pulleys.map((q) => shafts.find((s) => sameLine(s, q, 0.0015) && (s.roller || s.gears.length)) ?? shaftOf(q, false));
    edges.push({ a: ends[0], b: ends[1], ratio: pulleys[0].teeth / pulleys[1].teeth, sign: 1 });
  }
  for (const s of shafts) {
    for (const t of shafts) {
      if (s === t) continue;
      for (const g of s.gears) {
        for (const h of t.gears) {
          if (g.dp !== h.dp || Math.abs(dot(g.axis, h.axis)) < 0.999) continue;
          const d = length(sub(sub(h.centre, g.centre), scale(g.axis, dot(sub(h.centre, g.centre), g.axis))));
          if (Math.abs(d - ((g.teeth + h.teeth) / (2 * g.dp)) * INCH) < 0.0008) edges.push({ a: s, b: t, ratio: g.teeth / h.teeth, sign: -1 });
        }
      }
    }
  }
  const start = shafts.find((s) => s.roller === flywheel);
  /* Angular speeds about one reference direction shared by every (parallel) shaft: a belt keeps the
     sense of rotation, a gear mesh reverses it. */
  const reference = start.axis;
  const speed = new Map([[start, 1]]);
  const queue = [start];
  while (queue.length) {
    const s = queue.shift();
    for (const e of edges) {
      const [from, to, ratio] = e.a === s ? [e.a, e.b, e.ratio] : e.b === s ? [e.b, e.a, 1 / e.ratio] : [null];
      if (!from || speed.has(to) || Math.abs(dot(to.axis, reference)) < 0.999) continue;
      speed.set(to, speed.get(s) * ratio * e.sign);
      queue.push(to);
    }
  }
  const out = new Map();
  const flySense = Math.sign(dot(rollerInfo.get(flywheel).spin, reference));
  for (const [s, v] of speed) {
    if (!s.roller || s.roller === flywheel) continue;
    const ownSense = Math.sign(dot(rollerInfo.get(s.roller).spin, reference));
    out.set(s.roller, { from: rollerInfo.get(flywheel).node, ratio: Number((v * ownSense * flySense).toFixed(4)) });
  }
  return out;
}

/* ---- the manifest ---- */

function buildManifest(c) {
  const r4 = (v) => round(v, 4);
  const { frame, modules, perimeter, rollers, rollerInfo, hood, exit } = c;

  /* Bumper mounts. */
  const mountParts = c.parts.filter((p) => /^cone bumper mount$/i.test(p.name));
  const mounts = mountParts.map((p) => {
    const b = partBox(p);
    const centre = scale(add(b.min, b.max), 0.5);
    const side = Math.abs(centre[0]) / (perimeter.length / 2) > Math.abs(centre[2]) / (perimeter.width / 2) ? (centre[0] > 0 ? "front" : "back") : centre[2] > 0 ? "right" : "left";
    return { position: r4(centre), side };
  }).sort((a, b) => a.side.localeCompare(b.side) || a.position[0] - b.position[0] || a.position[2] - b.position[2]);

  /* Hopper interior. */
  const hopperParts = c.parts.filter((p) => p.top === "Hopper");
  const walls = hopperParts.filter((p) => p.cls === "poly" && /side/i.test(p.name));
  const wallInner = Math.min(...walls.map((p) => Math.min(...planes(p).filter((pl) => Math.abs(pl.normal[2]) > 0.99 && pl.area > 0.01).map((pl) => Math.abs(pl.offset * Math.sign(pl.normal[2]))))));
  const topPoly = hopperParts.filter((p) => p.cls === "poly" && /top/i.test(p.name));
  const topInner = Math.min(...topPoly.flatMap((p) => planes(p).filter((pl) => Math.abs(pl.normal[1]) > 0.99 && pl.area > 0.01).map((pl) => Math.abs(pl.offset))));
  const hopperFront = Math.max(...walls.map((p) => partBox(p).max[0]));
  const back = Math.max(...c.feederRollers.map((r) => r.centre[0] + r.radius));
  /* The floor's top surface: the line through the conveyor rollers' tops, level beyond its front end. */
  const floorEnd = c.conveyorRollers[0].centre[0];
  const floorSlope = c.floorFit.slope;
  const floorTop = (x) => c.floorFit.at(Math.min(x, floorEnd)) + c.conveyorRollers[0].radius * Math.hypot(1, floorSlope);
  const slabs = 3;
  const boxes = [];
  for (let i = 0; i < slabs; i++) {
    const x0 = back + ((hopperFront - back) * i) / slabs;
    const x1 = back + ((hopperFront - back) * (i + 1)) / slabs;
    boxes.push({ min: r4([x0, floorTop((x0 + x1) / 2), -wallInner]), max: r4([x1, topInner, wallInner]), movesWith: "static" });
  }
  /* The deployed intake's own walls extend the hopper forward. */
  const intakeFrontPoly = c.intakeParts.filter((p) => p.cls === "poly" && /front poly/i.test(p.name));
  const intakeSidePoly = c.intakeParts.filter((p) => p.cls === "poly" && /side poly/i.test(p.name));
  let extension = null;
  if (intakeFrontPoly.length && intakeSidePoly.length) {
    /* Measured in the CAD pose and moved to MAX_LENGTH; the back of the box stays at the fixed hopper's
       front edge, which is where the extension starts. */
    const toMax = scale(c.slide.axis, CODE.deploy.maxIn * INCH - c.cadExtension);
    const frontInner = Math.min(...intakeFrontPoly.map((p) => partBox(p).min[0])) + toMax[0];
    const sideInner = Math.min(...intakeSidePoly.flatMap((p) => planes(p).filter((pl) => Math.abs(pl.normal[2]) > 0.99 && pl.area > 0.01).map((pl) => Math.abs(pl.offset * Math.sign(pl.normal[2])))));
    const sideTop = Math.max(...intakeSidePoly.map((p) => partBox(p).max[1])) + toMax[1];
    const rollerTop = Math.max(...c.intakeRollers.map((r) => r.centre[1] + r.radius)) + toMax[1];
    extension = {
      min: r4([hopperFront, rollerTop, -sideInner]),
      max: r4([frontInner, sideTop, sideInner]),
      movesWith: "intake",
      atIntakeExtension: r4(CODE.deploy.maxIn * INCH),
    };
  }
  const ball = CODE.ballDiameter;
  const rb = ball / 2;
  const volume = (b) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
  const ballVolume = (Math.PI / 6) * ball ** 3;
  /* Ball centres that fit the real section (the floor slopes, which boxes cannot follow) - and then are
     checked against the robot's own triangles. The section is a description of the volume, not of the
     robot: printed uprights, the shooter's side plates and brackets stand inside it, and a ball packed
     only against the analytic walls sat half way through one of them. On a view where the robot fills
     the screen that reads as a hole in the picture, so every candidate centre is tested for clearance
     against the parts that could be in the way (see robot-cad/clearance.mjs).

     The intake is tested where it is for the packing being checked: back at its stop for the stowed
     packing, out at MAX_LENGTH for the deployed one. */
  const inStatic = (p) => p[0] >= back + rb && p[0] <= hopperFront + rb && p[1] <= topInner - rb && Math.abs(p[2]) <= wallInner - rb && (p[1] - floorTop(p[0])) / Math.hypot(1, p[0] < floorEnd ? floorSlope : 0) >= rb;
  const inExtension = (p) => extension && p[0] >= extension.min[0] && p[0] <= extension.max[0] - rb && p[1] >= extension.min[1] + rb && p[1] <= extension.max[1] - rb && Math.abs(p[2]) <= extension.max[2] - rb;

  const hopperRegion = {
    min: [back - ball, floorTop(hopperFront) - ball, -wallInner - ball],
    max: [(extension ? extension.max[0] : hopperFront) + ball, topInner + ball, wallInner + ball],
  };
  const inRegion = (box) => [0, 1, 2].every((k) => box.max[k] >= hopperRegion.min[k] && box.min[k] <= hopperRegion.max[k]);
  const intakeSlideSet = new Set(c.intakeParts);
  const toStow = scale(c.slide.axis, -c.cadExtension);
  const toMaxSlide = scale(c.slide.axis, CODE.deploy.maxIn * INCH - c.cadExtension);
  const nearby = c.parts.filter((p) => p.keep && inRegion(partBox(p)));
  const obstacles = (translate) => {
    const triangles = [];
    for (const part of nearby) {
      const moved = intakeSlideSet.has(part) ? translate : null;
      const box = partBox(part);
      const shifted = moved
        ? { min: [box.min[0] + moved[0], box.min[1] + moved[1], box.min[2] + moved[2]], max: [box.max[0] + moved[0], box.max[1] + moved[1], box.max[2] + moved[2]] }
        : box;
      if (!inRegion(shifted)) continue;
      /* Appended one at a time: spreading a part's triangles into the array overflows the stack, and
         some of these parts have tens of thousands of numbers. */
      for (const v of partTriangles(part, { translate: moved })) triangles.push(v);
    }
    return buildSolids(triangles, ball);
  };
  const stowedSolids = obstacles(toStow);
  const deployedSolids = obstacles(toMaxSlide);
  /* A hair under the radius: a ball resting on a roller or against a wall is touching it, and a packing
     that refuses contact fits nothing at all. */
  const skin = rb - 0.0015;
  const staticPack = packBalls((p) => inStatic(p) && p[0] <= hopperFront - rb && clearOfSolids(stowedSolids, p, skin), { min: [back, 0, -wallInner], max: [hopperFront, topInner, wallInner] }, ball);
  const deployedPack = extension
    ? packBalls((p) => (inStatic(p) || inExtension(p)) && clearOfSolids(deployedSolids, p, skin), { min: [back, 0, -wallInner], max: [extension.max[0], topInner, wallInner] }, ball)
    : staticPack;
  const staticCapacity = staticPack.length;
  log(`  hopper: ${nearby.length} parts in the way, ${staticPack.length} balls stowed, ${deployedPack.length} deployed`);

  /* Intake mouth: under the lowest intake roller, at ball height, when deployed to MAX_LENGTH. */
  const low = c.intakeRollers[0];
  const toMax = scale(c.slide.axis, CODE.deploy.maxIn * INCH - c.cadExtension);
  const mouthCentre = add([low.centre[0] + low.radius, ball / 2, 0], [toMax[0], 0, 0]);

  const moduleEntries = modules.map((m) => {
    const tuner = [CODE.tuner.moduleXIn * INCH * Math.sign(m.position[0]), -CODE.tuner.moduleYIn * INCH * Math.sign(m.position[2])];
    /* Wheel axle sign: positive rotation drives the robot along the module's heading, and of the two
       headings the axle allows, the one with a forward component is used. */
    let axle = normalize([m.tread.axis[0], 0, m.tread.axis[2]]);
    let heading = normalize(cross(axle, [0, 1, 0]));
    if (heading[0] < -1e-9) {
      axle = scale(axle, -1);
      heading = scale(heading, -1);
    }
    return {
      name: m.name,
      position: r4(m.position),
      steerNode: `module-${m.name}`,
      wheelNode: `wheel-${m.name}`,
      wheelRadius: r4(m.wheelRadius),
      wheelWidth: r4(m.wheelWidth),
      wheelCenter: r4(m.wheelCenter),
      wheelAxis: r4(axle),
      cadSteerAngle: Number(wpilibAngleDeg(heading).toFixed(2)),
      tunerConstants: { x: r4(tuner[0]), y: r4(tuner[1]), differenceMm: Number((Math.hypot(m.position[0] - tuner[0], -m.position[2] - tuner[1]) * 1000).toFixed(1)) },
      how: "steering axis: the vertical cylindrical faces (bearing, steering gear, housing) that share one line within 3 cm of the wheel; wheel: the lowest horizontal cylinder in the module (the tread), its radius and width fitted to the face. The steer node turns about +y (positive = counter-clockwise seen from above, WPILib's direction); the wheel node turns about wheelAxis in the steer node's frame, positive driving the robot toward the heading cadSteerAngle.",
      confidence: m.steerFound ? "high" : "medium",
    };
  });

  const pivotPoint = c.pivot;
  const pivot581 = CODE.shooter.hoodPivot581In.map((v) => v * INCH);
  const hoodExitAt = (deg) => {
    const delta = (deg - c.cadAngle) / DEG;
    const dir = rotateAbout(exit.direction, [0, 0, 0], c.hoodAxis, delta);
    return Number((Math.atan2(dir[1], Math.hypot(dir[0], dir[2])) * DEG).toFixed(2));
  };

  const rollerEntries = rollers.map((r) => {
    const info = rollerInfo.get(r);
    const group = c.groupOf(r.tube);
    const shift = c.restShift[group] ?? [0, 0, 0];
    return {
      node: info.node,
      role: info.role,
      parent: group === "static" ? "robot" : group,
      center: r4(add(r.centre, shift)),
      axis: r4(info.spin),
      radius: r4(r.radius),
      length: r4(r.length),
      cad: r.assembly ?? r.tube.name,
      ...(c.drives.has(r) ? { drivenBy: c.drives.get(r) } : {}),
      how: info.how,
      confidence: info.confidence,
    };
  });

  const droppedRows = {};
  for (const p of c.parts) {
    if (p.keep) continue;
    const row = droppedRows[p.reason] ?? { instances: 0, triangles: 0, examples: [] };
    row.instances++;
    row.triangles += p.triangles;
    if (!row.examples.includes(p.name) && row.examples.length < 6) row.examples.push(p.name);
    droppedRows[p.reason] = row;
  }

  const frontEvidence = [
    { evidence: "Intake assembly (the deploy slides it out 'in front of the robot', Deploy.java) lies toward +x", cosine: c.agree(c.intakeHint) },
    { evidence: "Drive/Floor parts named Front vs Back", cosine: c.agree(c.nameHint) },
    { evidence: "Shooter assembly lies toward -x (PORT_SPEC: 'the robot shoots out its BACK')", cosine: c.agree(c.shooterHint) },
    { evidence: "computed shot exit direction points toward -x", value: r4(exit.direction) },
    { evidence: "hood pivot vs Team 581's SHOOTER_HOOD_PIVOT_POINT (-11.35 in, 18.85 in up)", measured: r4([pivotPoint[0], pivotPoint[1]]), reference: r4([pivot581[0], pivot581[2]]) },
    { evidence: "module spacing along x / along z vs TunerConstants 22 in / 23.5 in", measured: r4([c.frame.spacing.along, c.frame.spacing.across]), reference: r4([22 * INCH, 23.5 * INCH]) },
  ].map((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === "number" ? Number(v.toFixed(4)) : v])));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      file: basename(c.input),
      generator: c.generator,
      bytes: c.inputStat.size,
      modified: new Date(c.inputStat.mtimeMs).toISOString(),
      nodes: c.json.nodes.length,
      meshes: c.json.meshes.length,
      triangles: c.totalTriangles,
      robotCode: "5805-offseason2026-code (Hood.java, Deploy.java, TunerConstants.java, docs/PORT_SPEC.md)",
    },
    units: "metres, degrees",
    frame: {
      axes: "x forward, y up, z right (a WPILib (x, y) is (x, -z)); origin on the floor (bottom of the wheel treads) under the centre of the four swerve modules' steering axes",
      cad: { forward: r4(frame.forward), up: r4(frame.up), right: r4(frame.right), origin: r4(frame.origin), matrix: frame.matrix.map((v) => Number(v.toFixed(6))) },
      evidence: frontEvidence,
      how: "up is the common axis of the modules' bearing and motor cylinders, pointing away from the wheels; the floor is the lowest point of the four treads; forward is the side of the module rectangle facing the deploying intake, and every other clue agrees.",
      confidence: "high",
    },
    model: {
      file: "robot.glb",
      bytes: c.written.bytes,
      triangles: c.written.triangles,
      budget: c.args.budget,
      simplifyErrorMm: Number((c.chosen * 1000).toFixed(3)),
      creaseDeg: c.args.crease,
      quantization: "KHR_mesh_quantization: int16 positions, int8 normals, dequantized by each '<node>-geometry' child node",
      restPose: "hood at the CAD pose (its retracted stop), intake retracted (Deploy length 0), modules and rollers as in the CAD",
      materials: [...c.materials.values()].map((m) => ({ name: m.name, cadColour: m.extras.cadColour })),
      nodes: "robot > static, hood (> roller-hood-*), intake (> roller-intake-*), roller-*, module-* (> wheel-*). Every named node has an identity rotation and scale at rest.",
    },
    bounds: { min: r4(c.restBox.min), max: r4(c.restBox.max) },
    triangles: c.written.triangles,
    framePerimeter: {
      length: r4(perimeter.length),
      width: r4(perimeter.width),
      bottom: r4(perimeter.bottom),
      top: r4(perimeter.top),
      how: "outer box of the Drive assembly's frame tubes (2 x 1 in rails)",
      confidence: "high",
    },
    bumpers: {
      mounts,
      thickness: r4(BUMPER.thickness),
      length: r4(perimeter.length + 2 * BUMPER.thickness),
      width: r4(perimeter.width + 2 * BUMPER.thickness),
      bottom: r4(BUMPER.bottom),
      height: r4(BUMPER.height),
      assumed: [
        "the CAD has no bumpers; the eight WCP cone mounts sit on top of the frame rails (front, back and both sides), so bumpers hang on all four sides and cover the rails",
        "height 5 in (typical FRC bumper), thickness 3.25 in (3/4 in backing + 2.5 in pool noodle), fabric ignored",
        "bottom 0.75 in above the floor: it must be below the rail bottom (1.26 in) to cover it, and the top (5.75 in) must stay under the intake's lowest roller as it retracts over the front bumper (0.163 m there)",
        "MapleSimSwerve uses 35 x 35 in, marked 'TODO(5805): measure'",
      ],
      how: "mount positions from the Cone Bumper Mount parts; outline = frame perimeter + thickness",
      confidence: "medium for the outline, low for the vertical placement",
    },
    modules: moduleEntries,
    hood: {
      node: "hood",
      pivot: r4(pivotPoint),
      axis: r4(c.hoodAxis),
      positiveRotation: "raises Hood.java's angle: turns the hood's front end up and flattens the shot",
      retracted: {
        direction: "negative rotation about axis: the hood's front end (the two top rollers) moves down toward the fixed feeder rollers; Hood.java homes there at -1 V and calls it 11 deg",
        awayFromStop: "positive rotation about axis",
      },
      cadAngle: c.cadAngle,
      cadAngleRange: [c.cadAngle, Number((CODE.hood.stopDeg - c.retractLimit).toFixed(2))],
      stop: CODE.hood.stopDeg,
      min: CODE.hood.minDeg,
      max: CODE.hood.maxDeg,
      physicalMax: Number((c.cadAngle + c.extendLimit).toFixed(1)),
      angleToRotation: "rotation about axis (radians) = (hoodAngleDeg - cadAngle) * PI / 180, applied to the hood node's rest orientation",
      rack: c.rack ? { teethSpanDeg: r4(c.rack.span), tipRadius: r4(c.rack.tipRadius), pinion: c.rack.pinion ? { part: c.rack.pinion.name, angleDeg: r4(c.rack.pinion.angle), distance: r4(c.rack.pinion.distance) } : null, travelFromCadDeg: c.rackLimits ? r4(c.rackLimits) : null } : null,
      rollerClearanceFromCadDeg: { retract: c.collision.retract, extend: c.collision.extend },
      reference581: { pivot: r4([pivot581[0], pivot581[2]]), differenceMm: Number((Math.hypot(pivotPoint[0] - pivot581[0], pivotPoint[1] - pivot581[2]) * 1000).toFixed(1)) },
      how: "pivot: the hood brackets' bearing bore that is coaxial with the 4 in flywheel (the 95T belt from the flywheel shaft to the hood's jackshaft keeps its length only about this axis). Members: the four hood bracket parts plus every part pinned through their other holes (both top rollers, the jackshaft gear and pulley, tie rods, belts between them). Stop: the rack's teeth allow " +
        (c.rackLimits ? `${(-c.rackLimits[0]).toFixed(1)} deg` : "?") + " of retraction from the CAD pose but the lower top roller would touch a fixed feeder roller after " +
        `${c.collision.retract !== null ? (-c.collision.retract).toFixed(2) : "?"} deg, so the CAD is modelled within that of the retracted hard stop and cadAngle is taken as Hood.java's 11 deg; no separate stop part exists in the CAD.`,
      confidence: c.atStop ? "high for pivot and axis, medium-high for cadAngle (within 1.5 deg)" : "high for pivot and axis, low for cadAngle",
    },
    intake: {
      node: "intake",
      axis: r4(c.slide.axis),
      inclineDeg: Number(c.inclineDeg.toFixed(2)),
      origin: r4(c.intakeOrigin),
      units: "position along axis in metres = Deploy length in inches * 0.0254",
      lengthToPosition: "node.position = origin + axis * (lengthInches * 0.0254)",
      travel: r4(CODE.deploy.maxIn * INCH),
      hardStop: r4(CODE.deploy.outerStopIn * INCH),
      stow: r4(CODE.deploy.stowIn * INCH),
      cadPosition: r4(c.cadExtension),
      cadState: c.intakeState,
      restPosition: 0,
      stopContacts: [...new Map(c.stops.map((s) => [`${s.moving}|${s.fixed}|${s.side}`, { moving: s.moving, fixed: s.fixed, side: s.side }])).values()],
      reference581: { deployAngleDeg: CODE.shooter.deployAngle581Deg },
      how: "axis: the long straight edges of the two 7075 gear racks, square to the robot's sides. Travel: Deploy.java measures inches from the inner hard stop (0) to the outer hard stop (11.9), MAX_LENGTH 11.8, STOW 5.0. CAD position: the rack's hardstop print sits flush against the slider block's back face (same station to 0.1 mm), which only happens at the outer stop. Members: everything in the Intake assembly except Intake Gearboxes (motors, slider blocks, pinions stay fixed).",
      confidence: c.stops.length ? "high" : "medium",
    },
    rollers: rollerEntries,
    rollerSpin: "axis sign: positive rotation (right-handed) moves the roller's ball-contact surface along the ball's path (in through the intake, down the floor, up the feeder and out of the shooter). Rollers carry drivenBy when a belt or gear train ties them to the flywheel; ratio is signed against these axes.",
    hopper: {
      ball: { diameter: CODE.ballDiameter, name: "FUEL" },
      boxes: [...boxes, ...(extension ? [extension] : [])],
      section: {
        back: r4(back),
        front: r4(hopperFront),
        top: r4(topInner),
        halfWidth: r4(wallInner),
        floor: { through: r4([floorEnd, floorTop(floorEnd)]), slopeDeg: Number((Math.atan(floorSlope) * DEG).toFixed(2)), levelBeyondX: r4(floorEnd) },
      },
      capacity: {
        stowed: staticCapacity,
        deployed: deployedPack.length,
        byVolume: { stowed: Math.floor((0.64 * boxes.reduce((s, b) => s + volume(b), 0)) / ballVolume), deployed: Math.floor((0.64 * (boxes.reduce((s, b) => s + volume(b), 0) + (extension ? volume(extension) : 0))) / ballVolume) },
      },
      ballCentres: { stowed: staticPack.map(r4), deployed: deployedPack.map(r4), order: "lowest first, so the first N are where N balls settle" },
      how: "walls: inner faces of the hopper's side polycarbonate; top: underside of the top polycarbonate; back: front of the feeder rollers; floor: the tops of the conveyor rollers, a 44 deg slope down toward the feeder; front: the hopper walls' front edge and, when deployed, the intake's front and side polycarbonate above its rollers. Boxes are slabs with the floor at each slab's middle, so their high end dips a little into the floor; ballCentres and capacity come from the best face-centred-cubic packing of 150 mm balls inside the real sloped section, with every candidate centre then checked for clearance against the triangles of the parts that could be in the way - the section describes the volume, not the robot, and uprights and side plates stand inside it; byVolume is 64% random packing of the boxes' volume and is an upper bound that ignores everything standing in the hopper.",
      confidence: "medium for the stowed section; low for the deployed extension, whose floor (the intake rollers' tops) is a guess",
    },
    shooter: {
      flywheel: { node: "roller-flywheel", center: r4(c.flywheel.centre), radius: r4(c.flywheel.radius), length: r4(c.flywheel.length), axis: r4(rollerInfo.get(c.flywheel).spin) },
      exit: {
        point: r4(exit.point),
        height: r4(exit.point[1]),
        direction: r4(exit.direction),
        elevationDeg: Number(exit.elevation.toFixed(2)),
        atHoodAngle: c.cadAngle,
        impliedHoodAngle: Number((90 - exit.elevation).toFixed(2)),
        elevationAt: { [CODE.hood.minDeg]: hoodExitAt(CODE.hood.minDeg), 30: hoodExitAt(30), [CODE.hood.maxDeg]: hoodExitAt(CODE.hood.maxDeg) },
        width: r4(c.flywheel.length),
        parent: "hood",
        how: `the ball is pinched between the flywheel and the upper hood roller (gap ${(exit.gap * 1000).toFixed(1)} mm for a 150 mm ball) and leaves square to the line between their axes, which lies ${exit.lineAngle.toFixed(2)} deg above horizontal; the point is the ball's centre at release, on the robot's centreline (balls leave anywhere across the ${(c.flywheel.length * 1000).toFixed(0)} mm roller width). The exit turns with the hood, so elevation = ${exit.elevation.toFixed(2)} - (hoodAngle - ${c.cadAngle}).`,
        confidence: "medium: contact geometry is exact, but a squeezed foam ball leaves with some spin and wrap, so the real launch can differ by a few degrees",
      },
    },
    intakeMouth: {
      center: r4(mouthCentre),
      width: r4(low.length),
      height: r4(low.centre[1] - low.radius + toMax[1]),
      parent: "intake",
      atIntakeExtension: r4(CODE.deploy.maxIn * INCH),
      how: "at Deploy MAX_LENGTH: the front of the lowest intake roller at ball-centre height; width is that roller's length; height is the clearance under the roller (a FUEL ball is 150 mm, so it is squeezed a little)",
      confidence: "medium",
    },
    cleanup: {
      minPartSizeM: c.args.minSize,
      dropped: droppedRows,
      bySubassembly: Object.fromEntries([...c.perAssembly].map(([k, v]) => [k, { cadTriangles: v.before, modelTriangles: v.after }])),
    },
  };
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
