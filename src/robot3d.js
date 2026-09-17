/* The robot model.
 *
 * One model for every view that draws the robot: the Park stage and the field view build the same
 * machine from the same description, so the robot a driver watches on the field is the one that was
 * parked, down to the numbers on its bumpers, and a transition between the two can hand one over to
 * the other without the robot changing under the viewer's eye.
 *
 * When the team has baked its own CAD (`npm run robot-cad`, see robot-cad.js) the model is that robot,
 * lightened to about 120k triangles, with its hood, intake, rollers and swerve modules posed from the
 * robot's telemetry and the FUEL in its hopper drawn from the hopper estimate. Otherwise it is built
 * from the robot's configured dimensions: a frame, bumpers and swerve modules drawn to scale.
 */

import * as THREE from "./vendor/three.module.min.js";
import { createHopperBalls } from "./hopper3d.js";
import {
  cadSpec,
  hoodTurn,
  intakeMouth,
  intakeSlide,
  loadRobotCad,
  moduleStates,
  optimizeModule,
  rollerSpin,
  shooterExit,
  shownRevs,
} from "./robot-cad.js";

/**
 * A robot description with every field present and sane, in metres.
 *
 * Any field may be missing. A bumper size on its own implies the frame inside it and a frame size on
 * its own implies the bumpers around it, so a config that knows only one of the two still draws the
 * robot at the right size. Anything that is not a finite number in a plausible range counts as
 * missing, because a model drawn from a typo is worse than the default one.
 */
export function normalizeRobot(spec) {
  const s = spec && typeof spec === "object" ? spec : {};
  const pick = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

  const bumperThickness = pick(s.bumperThickness, 0, 0.3) ?? 0.0762;
  const frame = (own, outer) => {
    if (pick(own, 0.2, 2) !== undefined) return own;
    if (pick(outer, 0.2, 2.6) !== undefined) return Math.max(0.2, outer - 2 * bumperThickness);
    return 0.74;
  };
  const frameLength = frame(s.frameLength, s.bumperLength);
  const frameWidth = frame(s.frameWidth, s.bumperWidth);
  const around = (outer, inner) => {
    const given = pick(outer, 0.2, 2.6);
    return given !== undefined && given >= inner ? given : inner + 2 * bumperThickness;
  };
  const bumperLength = around(s.bumperLength, frameLength);
  const bumperWidth = around(s.bumperWidth, frameWidth);
  const height = pick(s.height, 0.2, 2.5) ?? 0.52;

  /* Capped at eight: no drivetrain has more, and the cap bounds the triangle count whatever arrives. */
  let modules = Array.isArray(s.modules)
    ? s.modules
        .filter((m) => Array.isArray(m) && Number.isFinite(m[0]) && Number.isFinite(m[1]) && Math.abs(m[0]) <= 2 && Math.abs(m[1]) <= 2)
        .slice(0, 8)
        .map((m) => [m[0], m[1]])
    : [];
  if (!modules.length) {
    /* WPILib's order, front-left first, so the drivetrain callout lands on the module nearest the
       default camera. The inset shrinks on a small frame so opposite modules cannot cross. */
    const x = frameLength / 2 - Math.min(0.1, frameLength / 4);
    const y = frameWidth / 2 - Math.min(0.1, frameWidth / 4);
    modules = [[x, y], [x, -y], [-x, y], [-x, -y]];
  }

  return { frameLength, frameWidth, bumperLength, bumperWidth, bumperThickness, height, modules };
}

/**
 * A team number as the bumpers print it, or null when there is nothing to print.
 *
 * FRC team numbers are whole numbers from 1 up, and none has yet passed five digits. Zero is what an
 * unconfigured controller reports, so it prints nothing rather than a 0 on every side of the robot.
 */
export function bumperNumber(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 99999 ? String(n) : null;
}

/* Heights in metres above the floor. They are a real swerve robot's rather than styling: a 2 x 1 in
   frame tube an inch off the carpet, 5 in bumpers clearing it by an inch and a half, 4 in wheels. They
   are fixed because no robot config carries them and nothing a driver reads depends on them. */
const FRAME_BOTTOM = 0.028;
const RAIL = 0.0254;
const RAIL_HEIGHT = 0.0508;
const FRAME_TOP = FRAME_BOTTOM + RAIL_HEIGHT;
const BUMPER_BOTTOM = 0.04;
const BUMPER_HEIGHT = 0.127;
const WHEEL_RADIUS = 0.0508;
const WHEEL_WIDTH = 0.038;
const BATTERY = { length: 0.181, width: 0.077, height: 0.167 };


/* The materials the model is made of that the console has no token for: rubber, anodised black, a
   battery case. These describe the robot's parts rather than the interface, and they are kept
   together so a change of mind is one place.

   The greys are exactly neutral, unlike the interface's greys with their hint of blue. Under the
   renderer's tone curve a dark colour loses nearly all of its darkest channel, so two points of blue
   in a near-black come out navy. */
const PART = {
  pan: "#2a2a2a",
  rubber: "#141414",
  hub: "#8e8e8e",
  motor: "#1c1c1c",
  battery: "#181818",
  lid: "#3a3a3a",
  terminal: "#a33a33",
  hood: "#202020",
  flywheel: "#484848",
  lamp: "#e6f0ff",
  light: "#eef2fb",
};


/* ---- geometry helpers ---- */

/** A rounded rectangle centred on (cx, cy). */
/* What about a robot's mechanism readings changes its drawing, to the precision a drawing can show: a robot
   publishing the same numbers again has nothing new to draw, and saying it had kept every view awake. */
function mechanismSignature(m, hopper) {
  const r = (v, k) => (Number.isFinite(v) ? Math.round(v * k) : "-");
  const roller = (x) => (x ? `${r(x.speed, 100)},${r(x.motorRps, 10)},${r(x.currentAmps, 1)}` : "-");
  const fill = hopper === null ? "-" : r(hopper, 100);
  if (!m) return `none|${fill}`;
  const modules = Array.isArray(m.modules) ? m.modules.map((q) => `${r(q.speed, 100)}:${r(q.angle, 100)}`).join(";") : "-";
  return [
    r(m.hoodDeg, 10), r(m.deployM, 1000), roller(m.intake), roller(m.conveyor), roller(m.feeder),
    r(m.shooterRps, 10), m.robotState ?? "", m.hopperState ?? "", modules, fill,
  ].join("|");
}

function roundedRect(w, h, r, cx = 0, cy = 0) {
  const x = cx - w / 2;
  const y = cy - h / 2;
  r = Math.max(1e-4, Math.min(r, w / 2 - 1e-5, h / 2 - 1e-5));
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(x + w, y + h - r);
  shape.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  shape.lineTo(x + r, y + h);
  shape.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(x, y + r);
  shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/** A rounded rectangle with a rounded rectangular hole: a frame, or a ring of bumpers. */
function ring(outerW, outerD, outerR, innerW, innerD, innerR) {
  const shape = roundedRect(outerW, outerD, outerR);
  shape.holes.push(roundedRect(innerW, innerD, innerR));
  return shape;
}

/**
 * Vertex normals that are smooth across rounded edges and sharp across real corners.
 *
 * ExtrudeGeometry is not indexed, so its own normals are per face, and a bevel lit by per-face normals
 * shows every facet as a stripe of light. On brushed metal under studio lights that is the one thing
 * that makes a model look cheap. Faces meeting at less than `crease` share a normal; faces meeting at
 * more keep their own, so the flat top of a plate stays flat right up to its edge.
 */
function smoothNormals(geometry, crease = (40 * Math.PI) / 180) {
  const pos = geometry.getAttribute("position");
  const count = pos.count;
  const face = new Float32Array(count * 3);
  const unit = new Float32Array(count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    c.sub(b).cross(a.sub(b));   // area-weighted, so a sliver of bevel cannot outvote a whole face
    const len = c.length() || 1;
    for (let k = 0; k < 3; k++) {
      const o = (i + k) * 3;
      face[o] = c.x; face[o + 1] = c.y; face[o + 2] = c.z;
      unit[o] = c.x / len; unit[o + 1] = c.y / len; unit[o + 2] = c.z / len;
    }
  }

  const shared = new Map();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e5)}|${Math.round(pos.getY(i) * 1e5)}|${Math.round(pos.getZ(i) * 1e5)}`;
    const list = shared.get(key);
    if (list) list.push(i);
    else shared.set(key, [i]);
  }

  const limit = Math.cos(crease);
  const normals = new Float32Array(count * 3);
  for (const list of shared.values()) {
    for (const i of list) {
      const oi = i * 3;
      let x = 0, y = 0, z = 0;
      for (const j of list) {
        const oj = j * 3;
        if (unit[oi] * unit[oj] + unit[oi + 1] * unit[oj + 1] + unit[oi + 2] * unit[oj + 2] < limit) continue;
        x += face[oj]; y += face[oj + 1]; z += face[oj + 2];
      }
      const len = Math.hypot(x, y, z) || 1;
      normals[oi] = x / len; normals[oi + 1] = y / len; normals[oi + 2] = z / len;
    }
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  return geometry;
}

/**
 * A plan shape extruded upward to `height` with rounded top and bottom edges, centred on its own
 * middle. A bevel grows outward from the shape it is given, so callers pass the shape already inset
 * by `bevel` and the finished part comes out at the size they asked for.
 */
function extrudeUp(shape, height, bevel, bevelSegments = 2, curveSegments = 5) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(height - 2 * bevel, 1e-4),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    curveSegments,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bevel - height / 2, 0);
  return smoothNormals(geometry);
}

/** A box with rounded vertical edges and softened top and bottom edges. */
function roundedBox(w, h, d, r, bevel) {
  const b = Math.max(0, Math.min(bevel ?? r * 0.5, w / 2 - 1e-3, d / 2 - 1e-3, h / 2 - 1e-3));
  return extrudeUp(roundedRect(w - 2 * b, d - 2 * b, r - b), h, b);
}

/** A curved plate: an arc of `radius` swept from `from` to `to` radians, `width` deep along z. */
function arcPlate(radius, thickness, from, to, width, bevel) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, radius - bevel, from, to, false);
  shape.absarc(0, 0, radius - thickness + bevel, to, from, true);
  shape.closePath();
  const depth = Math.max(width - 2 * bevel, 1e-4);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 12,
  });
  geometry.translate(0, 0, -depth / 2);
  return smoothNormals(geometry);
}

/**
 * A machined side plate standing on its bottom edge, `thickness` deep along z: square at the foot,
 * rounded over the top, with one pocket milled out of it. The pocket is there because every real plate
 * has one, and a blank slab of that size reads as a wall.
 */
function sidePlate(width, height, round, thickness, bevel) {
  const w = width - 2 * bevel;
  const h = height - 2 * bevel;
  const r = Math.min(round, w / 2 - 1e-4, h / 2 - 1e-4);
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(w / 2, h - r);
  shape.absarc(w / 2 - r, h - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-w / 2 + r, h);
  shape.absarc(-w / 2 + r, h - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-w / 2, 0);
  if (w > 0.1 && h > 0.14) shape.holes.push(roundedRect(w * 0.46, h * 0.3, 0.014, -w * 0.08, h * 0.36));
  const depth = Math.max(thickness - 2 * bevel, 1e-4);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geometry.translate(0, bevel, -depth / 2);
  return smoothNormals(geometry);
}

/** A wheel's tyre, turned on a lathe so the tread has shoulders, with its axle along z. */
function tyre(radius, width) {
  const hw = width / 2;
  const e = Math.min(0.006, hw * 0.4);
  const inner = radius * 0.6;
  const profile = [
    [inner, -hw], [radius - e, -hw], [radius - e * 0.3, -hw + e * 0.3], [radius, -hw + e],
    [radius, hw - e], [radius - e * 0.3, hw - e * 0.3], [radius - e, hw], [inner, hw],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(profile, 28).rotateX(Math.PI / 2);
}

/** A cylinder with its axis along z. */
function axle(radius, length, segments) {
  return new THREE.CylinderGeometry(radius, radius, length, segments).rotateX(Math.PI / 2);
}

/**
 * The bumper fabric's weave, as a tangent-space normal map drawn on a canvas.
 *
 * Without it the bumpers are a smooth red that reads as moulded rubber from any distance. The pattern
 * is a plain weave, threads alternating over and under, with a little per-pixel irregularity so it does
 * not look printed. It is tileable by construction: the thread period divides the canvas and the slopes
 * wrap at the edges. Mipmapping averages it away to a flat normal when the robot is small, so it only
 * shows when there are pixels to show it with.
 */
function weave(size = 64, threads = 8) {
  const period = size / threads;
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const over = (Math.floor(x / period) + Math.floor(y / period)) % 2 === 0;
      const across = over ? (x % period) / period : (y % period) / period;
      height[y * size + x] = Math.sin(Math.PI * across) + (random() - 0.5) * 0.25;
    }
  }
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      image.data[o] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      image.data[o + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      image.data[o + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      image.data[o + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  /* ExtrudeGeometry's UVs are in metres, so this is threads of about five millimetres: coarser than
     real bumper cloth, which at this size would be finer than a pixel and simply vanish. */
  texture.repeat.set(1 / (threads * 0.005), 1 / (threads * 0.005));
  return texture;
}

/* ---- the robot ---- */

/**
 * Build the model for a normalised spec. Returns the group, the anchor points the callouts use, the
 * cylinders the camera frames (see silhouette), and the corner radius of the bumper outline, which the
 * floor's contact shadow follows.
 *
 * Coordinates follow field3d.js: three's x is the robot's front, and its z is the robot's right, so a
 * WPILib (x, y) lands at (x, -y).
 */
function buildRobot(spec, mat, keep) {
  const group = new THREE.Group();
  const L = spec.frameLength;
  const W = spec.frameWidth;
  const H = spec.height;
  const put = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(keep(geometry), material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };

  /* The frame: a ring of 2 x 1 tube with softened edges, so the long highlight along its top runs
     unbroken round the inside of the bumpers, and a darker belly pan dropped into it. */
  const rail = Math.min(RAIL, L / 4, W / 4);
  const fb = 0.003;
  put(
    extrudeUp(ring(L - 2 * fb, W - 2 * fb, 0.02 - fb, L - 2 * rail + 2 * fb, W - 2 * rail + 2 * fb, 0.006 + fb), RAIL_HEIGHT, fb),
    mat.body, 0, FRAME_BOTTOM + RAIL_HEIGHT / 2, 0
  );
  const pan = put(roundedBox(L - 2 * rail - 0.004, 0.006, W - 2 * rail - 0.004, 0.008, 0.002), mat.pan, 0, FRAME_BOTTOM + 0.004, 0);
  const deck = pan.position.y + 0.003;

  const { tx, thin, corner } = addBumpers(put, spec, mat, L, W, BUMPER_BOTTOM, BUMPER_HEIGHT);

  /* A light bar along the top of the front bumper. It is the one thing on the model that says which
     way is forward from every angle: the field view's overhead camera draws the robot a couple of
     dozen pixels across, and a line of light still reads at that size where the superstructure does
     not. */
  if (thin > 0.004) {
    const across = Math.max(0.1, (spec.bumperWidth - 2 * corner) * 0.62);
    put(new THREE.BoxGeometry(Math.min(0.026, tx * 0.34), 0.003, across), mat.light,
      spec.bumperLength / 2 - tx / 2, BUMPER_BOTTOM + BUMPER_HEIGHT + 0.0015, 0);
  }

  /* Swerve modules. The wheel sits under the frame, where from a low angle a sliver of tread shows
     beneath the bumper; the housing and its two motors sit on top, where the camera sees them. */
  const housing = Math.max(0.08, Math.min(0.15, L * 0.3, W * 0.3));
  const housingH = 0.05;
  const motorR = 0.029;
  const motorH = 0.07;
  const housingGeo = roundedBox(housing, housingH, housing, 0.022, 0.006);
  const tyreGeo = tyre(WHEEL_RADIUS, WHEEL_WIDTH);
  const hubGeo = axle(WHEEL_RADIUS * 0.6, WHEEL_WIDTH * 0.9, 20);
  const motorGeo = new THREE.CylinderGeometry(motorR, motorR, motorH, 24);
  const motorMat = [mat.motor, mat.body, mat.motor];   // side, top, bottom: a machined cap on a black can
  const motorTop = FRAME_TOP + housingH + motorH;
  for (const [mx, my] of spec.modules) {
    const x = mx;
    const z = -my;
    put(tyreGeo, mat.rubber, x, WHEEL_RADIUS, z);
    put(hubGeo, mat.hub, x, WHEEL_RADIUS, z);
    put(housingGeo, mat.body, x, FRAME_TOP + housingH / 2, z);
    /* The two motors stand side by side across the module, square to the line from the robot's
       centre, so every corner of the drivetrain reads the same way round. */
    const len = Math.hypot(x, z) || 1;
    const across = [-z / len, x / len];
    const inward = [-x / len * 0.012, -z / len * 0.012];
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(keep(motorGeo), motorMat);
      m.position.set(x + across[0] * side * 0.034 + inward[0], FRAME_TOP + housingH + motorH / 2, z + across[1] * side * 0.034 + inward[1]);
      group.add(m);
    }
  }

  /* The electronics, low on the belly pan: a controller with one small status light, and a power
     hub. Enough that looking down into the frame finds a machine rather than an empty tray. */
  put(roundedBox(0.13, 0.032, 0.1, 0.012, 0.004), mat.motor, L * 0.18, deck + 0.016, W * 0.03);
  put(new THREE.BoxGeometry(0.028, 0.003, 0.004), mat.lamp, L * 0.18 + 0.045, deck + 0.0335, W * 0.03 - 0.035);
  put(roundedBox(0.11, 0.03, 0.12, 0.01, 0.004), mat.motor, -L * 0.26, deck + 0.015, W * 0.16);

  /* The battery stands on the left side between the modules, long side outward, where the default
     camera sees it whole. */
  const batteryX = -Math.min(0.05, L * 0.07);
  const batteryZ = -(W / 2 - rail - BATTERY.width / 2 - 0.012);
  const batteryTop = deck + BATTERY.height;
  put(roundedBox(BATTERY.length, BATTERY.height - 0.012, BATTERY.width, 0.006, 0.003), mat.battery, batteryX, deck + (BATTERY.height - 0.012) / 2, batteryZ);
  put(roundedBox(BATTERY.length + 0.002, 0.012, BATTERY.width + 0.002, 0.007, 0.003), mat.lid, batteryX, batteryTop - 0.006, batteryZ);
  const post = new THREE.CylinderGeometry(0.008, 0.008, 0.012, 14);
  put(post, mat.terminal, batteryX + BATTERY.length * 0.3, batteryTop + 0.006, batteryZ);
  put(post, mat.motor, batteryX - BATTERY.length * 0.3, batteryTop + 0.006, batteryZ);

  /* The superstructure: two uprights on a cross member, tied by a crossbar, carrying a shooter's
     flywheels under a curved hood. Generic on purpose. It gives the robot a silhouette above the
     bumpers, and the crown of the hood is what reaches the configured height.

     The uprights are side plates rather than tubes. Tubes this tall read as spindly at the size the
     robot is drawn, and the plates are the largest clean faces of aluminium on the robot, which is
     where the studio reflections have room to show. */
  const hoodR = Math.min(0.12, Math.max(0.05, (H - FRAME_TOP) * 0.28));
  const shaftY = H - hoodR;
  const postZ = Math.min(0.16, W / 2 - 0.12);
  const postX = -Math.min(0.06, L * 0.08);
  const plateW = Math.min(0.26, L * 0.36);
  const plateH = H - 0.035 - FRAME_TOP;
  const baseTop = Math.max(BUMPER_BOTTOM + BUMPER_HEIGHT, motorTop, batteryTop + 0.012);
  let crown = new THREE.Vector3(0, baseTop, 0);
  let reach = 0;
  let muzzle = null;
  if (plateH > 0.08 && postZ > 0.06) {
    put(roundedBox(0.0254, RAIL_HEIGHT, W - 2 * rail - 0.002, 0.004, 0.0015), mat.body, postX, FRAME_BOTTOM + RAIL_HEIGHT / 2, 0);
    const plate = sidePlate(plateW, plateH, Math.min(0.1, plateW * 0.4), 0.008, 0.002);
    for (const side of [-1, 1]) put(plate, mat.body, postX, FRAME_TOP, side * postZ);
    put(roundedBox(0.03, 0.03, 2 * postZ, 0.01, 0.003), mat.body, postX - plateW * 0.36, FRAME_TOP + plateH * 0.22, 0);

    /* The hood covers the front of the flywheels and the top, and stops just past the crown, which is
       how a shooter hood sits. Swept further round it closes into a drum. */
    const hoodWidth = 2 * postZ - 0.012;
    put(arcPlate(hoodR, 0.006, 0.3, 1.8, hoodWidth, 0.002), mat.hood, postX, shaftY, 0);
    put(axle(0.008, 2 * postZ + 0.03, 14), mat.hub, postX, shaftY, 0);
    const flywheel = axle(hoodR - 0.05, 0.03, 32);
    for (const k of [-1, 1]) put(flywheel, mat.flywheel, postX, shaftY, k * hoodWidth * 0.22);
    crown = new THREE.Vector3(postX, H, 0);
    reach = Math.hypot(Math.abs(postX) + Math.max(hoodR, plateW / 2), postZ + 0.005);
    /* Balls leave over the crown of the hood, toward the front: a generic shooter, like the rest. */
    muzzle = { point: new THREE.Vector3(postX + hoodR * 0.5, H - 0.01, 0), forward: new THREE.Vector3(1, 0, 0), wheelRadius: Math.max(0.03, hoodR - 0.05), width: hoodWidth };
  }

  /* Anchors for the callouts, in the robot's frame, each with the direction its surface faces so the
     view can say when the part has turned away. */
  const [m0x, m0y] = spec.modules[0];
  const m0 = Math.hypot(m0x, m0y) || 1;
  const anchors = {
    battery: { point: new THREE.Vector3(batteryX, batteryTop, batteryZ - BATTERY.width / 2), normal: new THREE.Vector3(0, 0.7, -1).normalize() },
    drivetrain: { point: new THREE.Vector3(m0x, FRAME_TOP + housingH, -m0y), normal: new THREE.Vector3(m0x / m0, 0.8, -m0y / m0).normalize() },
    bumper: { point: new THREE.Vector3(spec.bumperLength / 2, BUMPER_BOTTOM + BUMPER_HEIGHT * 0.55, 0), normal: new THREE.Vector3(1, 0.15, 0).normalize() },
    top: { point: crown, normal: new THREE.Vector3(0, 1, 0) },
    /* The top of the controller on the belly pan, beside its status light. */
    controller: { point: new THREE.Vector3(L * 0.18, deck + 0.032, W * 0.03), normal: new THREE.Vector3(0, 1, 0) },
  };

  /* What the camera frames: a wide low cylinder reaching the bumper outline's true corners (or a module
     configured outside it), and a narrow tall one round the superstructure. */
  let radius = Math.hypot(spec.bumperLength / 2 - corner, spec.bumperWidth / 2 - corner) + corner;
  for (const [mx, my] of spec.modules) radius = Math.max(radius, Math.hypot(mx, my) + WHEEL_RADIUS);
  const parts = [{ radius, bottom: 0, top: baseTop }];
  if (reach > 0) parts.push({ radius: reach, bottom: 0, top: H });

  /* The model's own box, which bounds() projects to find the robot on screen, and whether it has
     bumpers to print a number on. */
  const box = new THREE.Box3().setFromObject(group);
  return { group, anchors, parts, corner, box, muzzle, bumpered: thin > 0.004 };
}

/**
 * Bumpers round a frame `frameLength` by `frameWidth` out to the spec's bumper size, from `bottom` to
 * `bottom + height` above the floor: one continuous ring rather than four rails, a flat face with
 * rounded top and bottom edges, the shape fabric takes when it is pulled over pool noodles. A deeper
 * bevel than this rounds the face away entirely and the ring reads as an inflatable.
 */
function addBumpers(put, spec, mat, frameLength, frameWidth, bottom, height) {
  const tx = (spec.bumperLength - frameLength) / 2;
  const tz = (spec.bumperWidth - frameWidth) / 2;
  const thin = Math.min(tx, tz);
  const corner = 0.02 + Math.max(thin, 0) * 0.6;
  if (thin > 0.004) {
    const b = Math.min(thin * 0.3, height * 0.25);
    put(
      extrudeUp(
        ring(spec.bumperLength - 2 * b, spec.bumperWidth - 2 * b, corner - b, frameLength + 2 * b, frameWidth + 2 * b, 0.02 + b),
        height, b, 4, 6
      ),
      mat.bumper, 0, bottom + height / 2, 0
    );
  }
  return { tx, thin, corner };
}

/* ---- the team's own robot, from its CAD ---- */

/* How quickly a posed part follows a new reading: long enough that telemetry arriving fifty times a second
   reads as motion rather than steps, short enough that the hood is where the code has it. */
const PART_FOLLOW_S = 0.07;
/* How quickly a swerve module turns to a new heading on screen. */
const MODULE_FOLLOW_S = 0.05;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The robot drawn from its CAD (see robot-cad.js), posed by `animate` from the robot's telemetry. The
 * baked geometry is shared with every other view that draws the robot; `restyle` gives this model its own
 * materials, which carry this view's reflections. The CAD has no bumpers, so they are drawn here at the
 * manifest's size, and the FUEL in the hopper is drawn in the ball positions the CAD analysis packed.
 */
function buildCadRobot(asset, spec, mat, keep, restyle, fuel) {
  const m = asset.manifest;
  const group = new THREE.Group();
  group.name = "cad-robot";
  const cad = asset.scene.clone(true);
  cad.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.material = Array.isArray(obj.material) ? obj.material.map(restyle) : restyle(obj.material);
    /* Glass after everything else it might be in front of, including the bumper numbers, because a
       panel's blend has to land on a finished picture to read as glass rather than as a grey film. */
    const glass = [obj.material].flat().some((material) => material?.userData?.glass);
    if (glass) obj.renderOrder = 3;
  });
  group.add(cad);
  const put = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(keep(geometry), material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  const frame = m.framePerimeter;
  const { thin, corner } = addBumpers(put, spec, mat, frame.length, frame.width, m.bumpers.bottom, m.bumpers.height);

  const find = (name) => cad.getObjectByName(name) ?? null;
  const unit = (a) => new THREE.Vector3(a[0], a[1], a[2]).normalize();
  const hood = find(m.hood.node);
  const hoodAxis = unit(m.hood.axis);
  const intake = find(m.intake.node);
  const intakeRest = intake ? intake.position.clone() : null;
  const rollers = m.rollers
    .map((r) => ({ node: find(r.node), role: r.role, axis: unit(r.axis), ratio: r.drivenBy?.ratio ?? 1, turned: 0 }))
    .filter((r) => r.node);
  const modules = m.modules
    .map((md) => ({
      steer: find(md.steerNode),
      wheel: find(md.wheelNode),
      rest: (md.cadSteerAngle * Math.PI) / 180,
      axis: unit(md.wheelAxis),
      radius: md.wheelRadius,
      angle: 0,
      turned: 0,
    }))
    .filter((md) => md.steer && md.wheel);
  const positions = cadSpec(m).modules;

  /* FUEL in the hopper, in the places the CAD analysis packed with the intake slid out. The places inside
     the intake's part of the hopper are carried by it (see hopper3d.js), so the pile compacts as the intake
     slides back rather than being dealt out to other places. */
  const places = m.hopper?.ballCentres?.deployed ?? m.hopper?.ballCentres?.stowed ?? [];
  const carriedBox = (m.hopper?.boxes ?? []).find((box) => box.movesWith === "intake");
  const carriedFrom = carriedBox?.atIntakeExtension ?? m.intake.travel ?? 0.3;
  const inside = (p, box) => [0, 1, 2].every((k) => p[k] >= box.min[k] - 0.02 && p[k] <= box.max[k] + 0.02);
  const slots = places.map((at) => ({ at, moves: Boolean(carriedBox && inside(at, carriedBox)) }));
  const feeder = m.rollers.find((r) => r.role === "feeder" && r.node === "roller-feeder-3")?.center
    ?? m.rollers.find((r) => r.role === "feeder")?.center
    ?? [-0.09, 0.42, 0];
  const hopperBalls = slots.length
    ? createHopperBalls({ slots, mouth: intakeMouth(m, carriedFrom), feeder, material: fuel })
    : null;
  if (hopperBalls) group.add(hopperBalls.root);

  const state = { at: null, hood: m.hood.cadAngle, deploy: 0 };

  /* Pose everything for `now`. Returns true while something is still moving. */
  function animate(readings, hopperShare, now, motion) {
    const dt = state.at === null ? 0 : Math.min(0.1, Math.max(0, (now - state.at) / 1000));
    state.at = now;
    const follow = (value, goal, seconds) => (dt > 0 ? goal + (value - goal) * Math.exp(-dt / seconds) : value);
    let moving = false;

    const hoodGoal = Number.isFinite(readings?.hoodDeg) ? readings.hoodDeg : m.hood.cadAngle;
    state.hood = follow(state.hood, hoodGoal, PART_FOLLOW_S);
    if (Math.abs(state.hood - hoodGoal) > 0.02) moving = true;
    hood?.quaternion.setFromAxisAngle(hoodAxis, hoodTurn(m, state.hood));

    const deployGoal = Number.isFinite(readings?.deployM) ? readings.deployM : 0;
    state.deploy = follow(state.deploy, deployGoal, PART_FOLLOW_S);
    if (Math.abs(state.deploy - deployGoal) > 1e-4) moving = true;
    if (intake) {
      const slide = intakeSlide(m, state.deploy);
      intake.position.set(intakeRest.x + slide[0], intakeRest.y + slide[1], intakeRest.z + slide[2]);
    }

    for (const roller of rollers) {
      const revs = rollerSpin(roller.role, readings) * roller.ratio;
      if (revs !== 0) {
        roller.turned = (roller.turned + revs * 2 * Math.PI * dt) % (2000 * Math.PI);
        moving = true;
      }
      roller.node.quaternion.setFromAxisAngle(roller.axis, roller.turned);
    }

    if (modules.length === positions.length) {
      /* The robot's own module states when it publishes them; otherwise the ones its motion implies. */
      const states = readings?.modules?.length === modules.length
        ? readings.modules
        : moduleStates(motion.vx, motion.vy, motion.omega, positions, modules.map((md) => md.angle));
      modules.forEach((md, i) => {
        const want = optimizeModule(states[i].angle, md.angle);
        md.angle = follow(md.angle, want.angle, MODULE_FOLLOW_S);
        if (Math.abs(md.angle - want.angle) > 1e-3) moving = true;
        md.steer.quaternion.setFromAxisAngle(UP, md.angle - md.rest);
        const revs = shownRevs((states[i].speed * want.flip) / (2 * Math.PI * md.radius));
        if (revs !== 0) {
          md.turned = (md.turned + revs * 2 * Math.PI * dt) % (2000 * Math.PI);
          moving = true;
        }
        md.wheel.quaternion.setFromAxisAngle(md.axis, md.turned);
      });
    }

    if (hopperBalls) {
      /* The intake carries its places with it, measured from where they were packed. */
      const slid = intakeSlide(m, state.deploy);
      const packed = intakeSlide(m, carriedFrom);
      hopperBalls.setIntake([slid[0] - packed[0], slid[1] - packed[1], slid[2] - packed[2]], intakeMouth(m, state.deploy));
      const share = Number.isFinite(hopperShare) ? Math.min(1, Math.max(0, hopperShare)) : 0;
      hopperBalls.setCount(Math.round(share * slots.length), now);
      if (hopperBalls.step(now)) moving = true;
    }
    return moving;
  }

  /* Where FUEL leaves, from the hood as it is drawn now, so balls come off the hood on screen. */
  function muzzleAt() {
    const exit = shooterExit(m, state.hood);
    return {
      point: new THREE.Vector3(exit.point[0], exit.point[1], exit.point[2]),
      direction: new THREE.Vector3(exit.direction[0], exit.direction[1], exit.direction[2]).normalize(),
      wheelRadius: m.shooter.flywheel?.radius ?? 0.0508,
      across: new THREE.Vector3(0, 0, 1),
      /* Four abreast: the shooter is four FUEL wide. */
      lanes: 4,
      laneSpacing: (exit.width ?? 0.55) / 4,
    };
  }

  const b = m.bounds;
  const bumperTop = m.bumpers.bottom + m.bumpers.height;
  const reach = Math.hypot(Math.max(-b.min[0], b.max[0]), Math.max(-b.min[2], b.max[2]));
  const parts = [
    { radius: Math.hypot(spec.bumperLength / 2 - corner, spec.bumperWidth / 2 - corner) + corner, bottom: 0, top: bumperTop },
    { radius: reach, bottom: 0, top: b.max[1] },
  ];
  const [flx, , flz] = m.modules[0].position;
  const anchors = {
    drivetrain: { point: new THREE.Vector3(flx, 0.13, flz), normal: new THREE.Vector3(flx, 0.9, flz).normalize() },
    bumper: {
      point: new THREE.Vector3(spec.bumperLength / 2, m.bumpers.bottom + m.bumpers.height * 0.55, 0),
      normal: new THREE.Vector3(1, 0.15, 0).normalize(),
    },
    top: { point: new THREE.Vector3(m.hood.pivot[0] + 0.06, b.max[1], 0), normal: new THREE.Vector3(0, 1, 0) },
  };
  const box = new THREE.Box3(
    new THREE.Vector3(Math.min(b.min[0], -spec.bumperLength / 2), 0, Math.min(b.min[2], -spec.bumperWidth / 2)),
    new THREE.Vector3(Math.max(b.max[0], spec.bumperLength / 2), b.max[1], Math.max(b.max[2], spec.bumperWidth / 2))
  );
  return {
    group,
    anchors,
    parts,
    corner,
    box,
    bumpered: thin > 0.004,
    animate,
    muzzleAt,
    dispose() {
      hopperBalls?.dispose();
    },
  };
}

/**
 * The team number on all four bumper faces, as white numerals on a transparent plane just proud of the
 * fabric, the way iron-on numbers sit on a real bumper cover.
 *
 * Three inches tall rather than the four the rules ask for: the flat of a five-inch bumper face ends
 * where its rounded edges begin, and numerals any taller would hang out over the curve.
 */
function bumperNumbers(text, spec, fontFamily) {
  /* The flat of the shorter face, less its rounded corners and a margin. A bumper too short to carry
     a number legibly carries none. */
  const flat = Math.min(spec.bumperLength, spec.bumperWidth) - 0.24;
  if (!(flat >= 0.08)) return null;
  const size = 160;
  const pad = 10;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const font = `600 ${size}px ${fontFamily}`;
  context.font = font;
  const ink = context.measureText(text);
  const ascent = Math.ceil(ink.actualBoundingBoxAscent || size * 0.72);
  const descent = Math.ceil(ink.actualBoundingBoxDescent || 0);
  const left = Math.ceil(ink.actualBoundingBoxLeft || 0);
  const width = Math.ceil((ink.actualBoundingBoxRight || ink.width) + left);
  canvas.width = width + 2 * pad;
  canvas.height = ascent + descent + 2 * pad;
  context.font = font;
  context.fillStyle = "#ffffff";
  context.textBaseline = "alphabetic";
  context.fillText(text, pad + left, pad + ascent);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const numeral = 0.0762;
  const metresPerPx = numeral / Math.max(1, ascent + descent);
  let w = canvas.width * metresPerPx;
  let h = canvas.height * metresPerPx;
  /* A long number on a short side is scaled to fit between the rounded corners. */
  if (w > flat) {
    h *= flat / w;
    w = flat;
  }
  const geometry = new THREE.PlaneGeometry(w, h);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    roughness: 0.85,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  material.envMapIntensity = 0.25;

  const y = (spec.bumperBottom ?? BUMPER_BOTTOM) + (spec.bumperHeight ?? BUMPER_HEIGHT) / 2;
  const proud = 0.0015;
  const faces = [
    [spec.bumperLength / 2 + proud, 0, Math.PI / 2],
    [-spec.bumperLength / 2 - proud, 0, -Math.PI / 2],
    [0, spec.bumperWidth / 2 + proud, 0],
    [0, -spec.bumperWidth / 2 - proud, Math.PI],
  ];
  const meshes = faces.map(([x, z, turn]) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = turn;
    /* After the bumper, whose fabric it lies on. */
    mesh.renderOrder = 1;
    return mesh;
  });
  return { meshes, geometry, material, texture };
}

/* ---- the studio ---- */

/**
 * The reflections, rendered once into an environment map and never seen directly.
 *
 * Brushed aluminium is mostly reflection, and against a black world it renders as dark grey plastic
 * however bright the lights are. So the metal sees a lit studio even though the viewer sees a black
 * one: a sphere shaded like a studio's walls and floor, and softboxes where a product photographer
 * would put them. A broad box overhead lays the long highlight along every top edge, a strip behind the
 * camera lights the faces turned toward the viewer, and faintly cool strips at the sides and back put
 * an edge on the silhouette. The stage turns in front of a camera that does not, so the lights stay
 * where a studio's stay.
 */
export function studioEnvironment(renderer) {
  const room = new THREE.Scene();
  const spent = [];
  const add = (geometry, material) => {
    spent.push(geometry, material);
    const mesh = new THREE.Mesh(geometry, material);
    room.add(mesh);
    return mesh;
  };

  /* The shading of the sphere matters most just below the horizon. Seen from a camera above the
     robot, every vertical face reflects that band, so a studio floor left black there turns the side
     plates and bumper-height metal black too. It is lit instead, as a pale studio floor would be,
     and falls away toward the nadir so faces turned down still read as the underside. */
  const shell = new THREE.SphereGeometry(10, 48, 24);
  const position = shell.getAttribute("position");
  const tone = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i) / 10;
    const v = y < 0 ? 0.03 + 0.27 * Math.pow(Math.max(0, 1 + y / 0.7), 1.6) : 0.2 + 0.25 * Math.pow(y, 0.8);
    tone[i * 3] = v;
    tone[i * 3 + 1] = v;
    tone[i * 3 + 2] = v;
  }
  shell.setAttribute("color", new THREE.BufferAttribute(tone, 3));
  add(shell, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));

  const softbox = (w, h, intensity, hex, x, y, z) => {
    const colour = new THREE.Color(hex).multiplyScalar(intensity);
    const panel = add(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide }));
    panel.position.set(x, y, z);
    panel.lookAt(0, 0.4, 0);
  };
  softbox(5, 2.5, 5.0, 0xffffff, -1, 7, 2);
  softbox(9, 1.2, 2.6, 0xffffff, 0, 2.0, 8);
  softbox(1.4, 6, 3.2, 0xf0f3f9, -8, 3, 0.5);
  softbox(1.4, 6, 1.6, 0xf0f3f9, 8, 3, -1.5);
  softbox(8, 1.2, 2.4, 0xe0e7f4, 0, 3.4, -8);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(room, 0.04);
  pmrem.dispose();
  for (const thing of spent) thing.dispose();
  return target;
}

/* ---- the model ---- */

/* How long the bumpers take to change colour when the alliance does. */
export const BUMPER_FADE_MS = 350;

/**
 * A robot model that can be put in any scene. The Park stage and the field view both draw this one, so
 * the robot a driver sees on the field is the robot that was parked, down to the numbers on its
 * bumpers.
 *
 * The model is built in the robot's own frame - x toward its front, z toward its right, y up, with the
 * floor under its centre at the origin - inside `root`, which the caller places and turns. Its metal
 * wants the studio's reflections (see studioEnvironment) to read as metal; without them the aluminium
 * renders as dark grey plastic.
 *
 * `opts.maxAnisotropy` is the renderer's, for the bumper weave. Callbacks registered with onChange run
 * when the picture changes on its own rather than because the caller just asked: the team number
 * finishing printing once its font has loaded. The caller redraws.
 */
export function createRobotModel(opts = {}) {
  /* The palette, read from the stylesheet as field3d.js reads its own, with the model's own values where
     the console has not set a token. Read here rather than when the module loads, so the module can be
     imported by the tests with no document. A value THREE cannot parse falls back too, rather than
     turning a bumper black. */
  const style = getComputedStyle(document.documentElement);
  const token = (name, fallback) => {
    const value = style.getPropertyValue(name).trim();
    if (value) {
      const colour = new THREE.Color(NaN, NaN, NaN).setStyle(value);
      if (Number.isFinite(colour.r) && Number.isFinite(colour.g) && Number.isFinite(colour.b)) return colour;
    }
    return new THREE.Color(fallback);
  };
  const BODY = token("--park-body", "#c7c7cc");
  /* A swatch used straight as a fabric's albedo glows under studio light: the lit face comes out
     brighter and more saturated than the swatch itself. Dyeing the fabric darker puts the lit face back
     near the token, which is what rich rather than neon comes to in practice. */
  const dye = (colour) => colour.multiplyScalar(0.6);
  const RED = dye(token("--park-bumper-red", "#c8322e"));
  const BLUE = dye(token("--park-bumper-blue", "#2f55c9"));
  const NEUTRAL = dye(token("--park-bumper-neutral", "#3a3a3c"));
  const FONT = style.getPropertyValue("--cat-sans").trim() || "system-ui, sans-serif";

  const owned = new Set();
  const own = (thing) => {
    owned.add(thing);
    return thing;
  };
  let geometries = new Set();
  const keep = (geometry) => {
    geometries.add(geometry);
    return geometry;
  };

  /* `reflect` is how much of the studio each surface picks up. It is per material rather than one
     number for the scene because the aluminium needs all of it to read as metal, and fabric given as
     much glows. */
  const standard = (colour, metalness, roughness, reflect) => {
    const material = own(new THREE.MeshStandardMaterial({ color: colour, metalness, roughness, dithering: true }));
    material.envMapIntensity = reflect;
    return material;
  };
  const mat = {
    body: standard(BODY, 1, 0.36, 1),
    pan: standard(PART.pan, 0.3, 0.6, 0.45),
    rubber: standard(PART.rubber, 0, 0.88, 0.4),
    hub: standard(PART.hub, 1, 0.3, 0.9),
    motor: standard(PART.motor, 0.4, 0.38, 0.8),
    battery: standard(PART.battery, 0, 0.45, 0.7),
    lid: standard(PART.lid, 0, 0.5, 0.6),
    terminal: standard(PART.terminal, 0, 0.5, 0.6),
    /* Smoked polycarbonate. Opaque, the hood was a black drum on top of the robot; tinted glass keeps
       the flywheels in view under a long streak of softbox, the way a car's glass roof is drawn. */
    hood: own(new THREE.MeshPhysicalMaterial({
      color: PART.hood,
      metalness: 0,
      roughness: 0.08,
      transparent: true,
      opacity: 0.62,
      envMapIntensity: 1.3,
      /* An open shell, so both sides are drawn - but it must not write depth: a transparent surface
         that does clips whatever draws after it, and what draws after it here is the flywheels the
         tint exists to show. */
      side: THREE.DoubleSide,
      depthWrite: false,
      dithering: true,
    })),
    flywheel: standard(PART.flywheel, 0, 0.7, 0.5),
    /* Fabric: rough, no metal, and a soft sheen that lifts at grazing angles the way a woven cover
       does. That rim of sheen is what separates a bumper from painted plastic. */
    bumper: own(new THREE.MeshPhysicalMaterial({
      color: NEUTRAL.clone(),
      metalness: 0,
      roughness: 0.9,
      sheen: 0.5,
      sheenRoughness: 0.55,
      sheenColor: new THREE.Color(1, 1, 1),
      normalMap: own(weave()),
      normalScale: new THREE.Vector2(0.45, 0.45),
      envMapIntensity: 0.25,
      dithering: true,
    })),
    lamp: own(new THREE.MeshBasicMaterial({ color: PART.lamp })),
    /* The light bar across the front bumper. Unlit and exempt from the tone curve, so it is the same
       soft white whatever the scene's lights are doing. */
    light: own(new THREE.MeshBasicMaterial({ color: PART.light, toneMapped: false })),
  };
  /* The weave is seen at a glancing angle along every bumper face, which is exactly where plain
     mipmapping smears it away first. */
  mat.bumper.normalMap.anisotropy = Math.min(4, opts.maxAnisotropy ?? 1);
  const sheenFrom = (colour) => mat.bumper.sheenColor.copy(colour).lerp(new THREE.Color(1, 1, 1), 0.3);
  sheenFrom(NEUTRAL);

  /* The studio's lights, which travel with the model into whichever scene draws it. Both views light
     the robot with this one rig and turn it with their camera's heading (see aim), so the robot is lit
     the same way however it is seen, and the frame the field view takes it over from the Park stage is
     the same picture in both. Two rigs - a showroom's on the stage, a field's on the tile - made the
     robot change colour at the handover. A low ambient, so the side away from the lights falls toward
     black the way a car's does on a stage; a key from above the camera's left shoulder; a cool rim from
     behind that draws the outline. Most of the metal's light is the studio reflections. */
  const lights = new THREE.Group();
  lights.name = "studio";
  lights.add(new THREE.HemisphereLight(0xffffff, 0x0b0b0c, 0.15));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
  keyLight.position.set(-2.2, 5, 3.4);
  const rimLight = new THREE.DirectionalLight(0xdae3f4, 2.2);
  rimLight.position.set(2.4, 3.2, -5);
  lights.add(keyLight, rimLight);
  let aimed = 0;

  /* The CAD's materials, restyled once each for this model: the same classes the pipeline names, with the
     CAD's own colours, finished the way the parts are - anodised and bare aluminium catch the studio, prints
     and belts are matte, polycarbonate is nearly clear. */
  const cadMaterials = new Map();
  const reflecting = (material) => {
    material.envMapRotation.set(0, aimed, 0);
    if (envTexture) material.envMap = envTexture;
    return material;
  };
  /* No part of the robot reflects more of the softbox than this, whatever the CAD says. A CAD author
     picks a colour to tell parts apart on their screen, not to stand under a studio light: the white
     electronics plate on the floor is #e5e5e5, which is a brighter surface than paper, and it came out
     as the brightest thing in the picture - a flat blown-out rectangle that read as a hole in the
     robot. Scaling the whole colour keeps it white and keeps every part's relation to every other. */
  const CAD_ALBEDO_CEILING = 0.62;
  const graded = (colour) => {
    const lum = 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
    if (lum > CAD_ALBEDO_CEILING) colour.multiplyScalar(CAD_ALBEDO_CEILING / lum);
    return colour;
  };
  const restyle = (source) => {
    if (!source) return source;
    let made = cadMaterials.get(source);
    if (made) return made;
    const colour = graded(source.color ? source.color.clone() : new THREE.Color(0.5, 0.5, 0.5));
    switch (source.name) {
      case "aluminium": made = standard(colour, 0.85, 0.36, 1); break;
      case "steel": made = standard(colour, 1, 0.3, 1); break;
      case "black": made = standard(colour, 0.3, 0.55, 0.5); break;
      case "motor": made = standard(colour, 0.45, 0.4, 0.8); break;
      case "tread": made = standard(colour.multiplyScalar(0.85), 0, 0.85, 0.35); break;
      case "belt": made = standard(colour, 0, 0.8, 0.3); break;
      case "print": made = standard(colour, 0, 0.72, 0.4); break;
      case "electronics": made = standard(colour, 0.1, 0.6, 0.5); break;
      /* Polycarbonate, and the one material whose drawing had to be reasoned about rather than chosen.
         A slab of it is a closed solid, so `FrontSide` draws each panel once instead of twice - and a
         look into the hopper crosses four of them. At DoubleSide and 0.15 each, eight blended layers
         washed out about seven tenths of what was behind them, which read as parts being cut away
         rather than as glass, and cost eight full physical-shader passes over most of the robot. One
         layer per panel at 0.12 leaves the rollers and the FUEL legible, and the streak of softbox
         along each sheet is what says there is a sheet there at all. `depthWrite` stays off so glass
         never clips what is behind it. */
      case "poly":
        made = own(new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(0.9, 0.92, 0.95),
          metalness: 0,
          roughness: 0.05,
          transparent: true,
          opacity: 0.12,
          envMapIntensity: 1.8,
          side: THREE.FrontSide,
          depthWrite: false,
          dithering: true,
        }));
        made.userData.glass = true;
        break;
      default: made = standard(colour, 0.1, 0.65, 0.5);
    }
    cadMaterials.set(source, reflecting(made));
    return made;
  };
  let fuelMaterial = null;
  let cad = null;
  let requested = {};
  const motion = { vx: 0, vy: 0, omega: 0 };

  const root = new THREE.Group();
  root.name = "robot";
  let built = null;
  let spec = null;
  let signature = "";
  let envTexture = null;
  let disposed = false;
  const listeners = new Set();
  const notify = () => {
    for (const fn of listeners) fn();
  };

  /* ---- the team number ---- */

  let teamText = null;
  let numbers = null;
  /* Counts every change, so a font load that finishes late cannot print a number that has since been
     replaced. */
  let numbersWanted = 0;

  function dropNumbers() {
    if (!numbers) return;
    for (const mesh of numbers.meshes) mesh.removeFromParent();
    numbers.geometry.dispose();
    numbers.material.dispose();
    numbers.texture.dispose();
    numbers = null;
  }

  function applyNumbers() {
    dropNumbers();
    const wanted = ++numbersWanted;
    if (!built || !built.bumpered || !teamText) return;
    const text = teamText;
    const print = () => {
      if (disposed || wanted !== numbersWanted || !built) return;
      dropNumbers();
      const made = bumperNumbers(text, spec, FONT);
      if (!made) return;
      numbers = made;
      made.material.envMapRotation.set(0, aimed, 0);
      if (envTexture) {
        made.material.envMap = envTexture;
        made.material.needsUpdate = true;
      }
      for (const mesh of made.meshes) built.group.add(mesh);
      notify();
    };
    /* The console's face is already on the page, but a canvas does not wait for a font: numerals drawn
       before it loads come out in the fallback face and stay that way. */
    const loading = document.fonts?.load?.(`600 160px ${FONT}`, text);
    if (loading) loading.then(print, print);
    else print();
  }

  /* ---- alliance ---- */

  let allianceTarget = NEUTRAL;
  let fade = null;
  let mechanisms = null;
  let hopper = null;
  let mechanismSig = "";

  /* Build the robot for `next`, or for the CAD once it has loaded, whose size wins over the spec sheet's.
     Returns true when the model was rebuilt: callers pass the config over on every telemetry tick, and
     rebuilding for nothing would be the most expensive thing either view does. */
  function applySpec(next) {
    requested = next;
    const normal = cad
      ? { ...normalizeRobot(cadSpec(cad.manifest)), bumperBottom: cad.manifest.bumpers.bottom, bumperHeight: cad.manifest.bumpers.height }
      : normalizeRobot(next);
    const sig = (cad ? "cad:" : "") + JSON.stringify(normal);
    if (sig === signature) return false;
    signature = sig;
    if (built) {
      dropNumbers();
      root.remove(built.group);
      built.dispose?.();
      for (const geometry of geometries) geometry.dispose();
      geometries = new Set();
    }
    if (cad) {
      fuelMaterial ??= reflecting(standard(token("--draw-fuel", "#a8913e"), 0, 0.9, 0.3));
      built = buildCadRobot(cad, normal, mat, keep, restyle, fuelMaterial);
    } else {
      built = buildRobot(normal, mat, keep);
    }
    spec = normal;
    root.add(built.group);
    applyNumbers();
    return true;
  }

  if (opts.cad !== false) {
    loadRobotCad().then((asset) => {
      if (!asset || disposed) return;
      cad = asset;
      if (spec !== null) {
        applySpec(requested);
        notify();
      }
    });
  }
  mat.bumper.color.copy(NEUTRAL);

  return {
    root,
    /** The studio lights for the scene that draws this model. Add them to that scene once; see aim. */
    lights,
    /** The normalised description the model is built from, or null before setSpec. */
    get spec() { return spec; },
    /** Callout anchors in the robot's frame: `{ name: { point, normal } }`. */
    get anchors() { return built ? built.anchors : null; },
    /**
     * Where a ball leaves the shooter with the hood at `hoodDeg` (as Hood.java reports it), in the robot's
     * frame: `{ point, direction, wheelRadius }`, the direction a unit vector at the launch angle. Null for
     * a robot with no shooter.
     */
    muzzle(hoodDeg) {
      if (built?.muzzleAt) return built.muzzleAt(hoodDeg);
      const m = built?.muzzle;
      if (!m) return null;
      const launch = ((90 - (Number.isFinite(hoodDeg) ? hoodDeg : 30)) * Math.PI) / 180;
      const direction = m.forward.clone().multiplyScalar(Math.cos(launch)).setY(Math.sin(launch)).normalize();
      /* FUEL goes out abreast across the shooter, as many lanes as fit its width. */
      const lanes = Math.max(1, Math.min(4, Math.floor(m.width / 0.15)));
      return { point: m.point.clone(), direction, wheelRadius: m.wheelRadius, across: new THREE.Vector3(0, 0, 1), lanes, laneSpacing: lanes > 1 ? Math.min(0.17, m.width / lanes) : 0 };
    },
    /** The upright cylinders that frame the robot for a camera (see park3d.js's silhouette). */
    get parts() { return built ? built.parts : []; },
    /** The model's bounding box in the robot's frame. */
    get box() { return built ? built.box : null; },
    /** The corner radius of the bumper outline. */
    get corner() { return built ? built.corner : 0.1; },

    /** Build the robot for `next` (see normalizeRobot). Returns true when the model was rebuilt, false
     *  when it describes the robot already on screen, which is most calls: callers pass the config over
     *  on every telemetry tick, and rebuilding forty meshes for nothing would be the most expensive
     *  thing either view does. */
    setSpec(next) {
      if (disposed) return false;
      return applySpec(next);
    },

    /** How the robot is moving, in its own frame (WPILib: x forward, y left; metres and radians a second),
     *  for the swerve modules to follow when the robot does not publish their states. */
    setMotion(vx, vy, omega) {
      motion.vx = Number.isFinite(vx) ? vx : 0;
      motion.vy = Number.isFinite(vy) ? vy : 0;
      motion.omega = Number.isFinite(omega) ? omega : 0;
    },

    /** "red" or "blue" colours the bumpers; anything else is a robot with no alliance yet. With
     *  `animate` the colour cross-fades over BUMPER_FADE_MS as step() is called; without, it changes at
     *  once. Returns true when the colour is changing. */
    setAlliance(alliance, animate = false) {
      if (disposed) return false;
      /* FMS data and NetworkTables spell it "Red" as often as "red". */
      const name = typeof alliance === "string" ? alliance.toLowerCase() : alliance;
      const to = name === "red" ? RED : name === "blue" ? BLUE : NEUTRAL;
      if (to === allianceTarget) return false;
      allianceTarget = to;
      if (!animate) {
        fade = null;
        mat.bumper.color.copy(to);
        sheenFrom(to);
      } else {
        fade = { start: null, from: mat.bumper.color.clone(), to };
      }
      return true;
    },

    /**
     * The robot's mechanisms as mechanisms.js reads them, and how full the hopper estimate is, 0 to 1.
     * A model with moving parts poses them from these on its next step; the generic model has none and
     * ignores them. Returns true when the readings change what is drawn.
     */
    setMechanisms(readings, hopperFill = null) {
      if (disposed) return false;
      mechanisms = readings ?? null;
      hopper = Number.isFinite(hopperFill) ? hopperFill : null;
      if (!built?.animate) return false;
      const sig = mechanismSignature(mechanisms, hopper);
      if (sig === mechanismSig) return false;
      mechanismSig = sig;
      return true;
    },

    /** The team number on the bumpers. Anything bumperNumber() refuses prints none. */
    setTeamNumber(value) {
      if (disposed) return;
      const text = bumperNumber(value);
      if (text === teamText) return;
      teamText = text;
      applyNumbers();
      notify();
    },

    /** The studio reflections every lit part of the model uses. Textures belong to one renderer, so
     *  each view hands over its own. */
    setEnvironment(texture) {
      envTexture = texture;
      for (const thing of owned) {
        if (!thing.isMeshStandardMaterial) continue;
        thing.envMap = texture;
        thing.needsUpdate = true;
      }
      if (numbers) {
        numbers.material.envMap = texture;
        numbers.material.needsUpdate = true;
      }
    },

    /**
     * Turn the studio - its lights and its reflections - to face a camera whose compass heading is
     * `yaw`: atan2(dx, dz) of the camera's position less the point it looks at, in the scene's own
     * frame. At 0 the camera is on the scene's +z side, where the Park stage keeps its lens. Call it
     * whenever the camera moves; it costs nothing when the heading has not changed.
     */
    aim(yaw) {
      if (disposed || !Number.isFinite(yaw) || yaw === aimed) return;
      aimed = yaw;
      lights.rotation.y = yaw;
      /* three.js turns a material's reflections by the inverse of envMapRotation when it samples them,
         so the same angle turns the studio's softboxes the way the lights have just turned. */
      for (const thing of owned) {
        if (thing.isMeshStandardMaterial) thing.envMapRotation.set(0, yaw, 0);
      }
      if (numbers) numbers.material.envMapRotation.set(0, yaw, 0);
    },

    /** Advance anything the model animates by itself. Returns true while something is still moving. */
    step(now) {
      const posing = built?.animate ? built.animate(mechanisms, hopper, now, motion) : false;
      if (!fade) return posing;
      if (fade.start === null) fade.start = now;
      const u = Math.min(1, Math.max(0, (now - fade.start) / BUMPER_FADE_MS));
      mat.bumper.color.lerpColors(fade.from, fade.to, u * u * (3 - 2 * u));
      sheenFrom(mat.bumper.color);
      if (u < 1) return true;
      fade = null;
      return posing;
    },

    /** Finish any animation at once, as if it had run to the end. */
    settle() {
      if (!fade) return;
      mat.bumper.color.copy(fade.to);
      sheenFrom(fade.to);
      fade = null;
    },

    /** Run `fn` when the model changes on its own. Returns a function that unsubscribes it. */
    onChange(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      dropNumbers();
      if (built) {
        root.remove(built.group);
        built.dispose?.();
      }
      for (const geometry of geometries) geometry.dispose();
      for (const thing of owned) thing.dispose();
      built = null;
    },
  };
}
