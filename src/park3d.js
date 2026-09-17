/* The park view.
 *
 * While the robot is disabled the console gives it the whole vehicle area: the robot, lit like a
 * product on a dark studio stage, turned by a finger. It is Tesla's Park screen for an FRC robot, and
 * like that screen it is not a data view. Nothing on the stage follows telemetry. It is there so a
 * parked robot looks like a machine rather than an empty tile, and so the callouts around it have
 * something to point at.
 *
 * The model is built from the robot's configured dimensions instead of loaded from CAD, for the reason
 * the field is (see field3d.js): a team's assembly is hundreds of megabytes and says nothing here that
 * a frame, bumpers and swerve modules drawn to scale do not.
 *
 * Cost control, because this shares the laptop with the Driver Station:
 *   * Frames are drawn on demand. A still stage costs nothing: the loop stops the moment nothing is
 *     moving, and wakes for input, for a change of robot or alliance, and when the idle turn is due.
 *   * 30 fps at most, like the field.
 *   * setActive(false) stops the loop outright. Nothing is drawn while the view is off screen.
 *   * No shadow maps and no post-processing. The floor, its grid and the contact shadow are one
 *     shader on one quad, and the studio reflections come from an environment rendered once.
 *   * Everything the scene allocates is released in dispose(), the GL context included.
 */

import * as THREE from "./vendor/three.module.min.js";

/* ---- camera maths ----
 *
 * Every decision about how the camera moves is made in the functions below, and none of them touch
 * THREE or the DOM, so `node --test` can pin the feel down without a GPU. The renderer further on only
 * applies what they return. */

/* How high the camera may look from, in radians above the horizon. The floor limit stays a few degrees
   up because a lens level with the ground sees the floor as a line and the robot as floating on it.
   The ceiling stops well short of straight down: over the top, a sideways drag spins the picture about
   its own centre, and that reads as the view breaking rather than the robot turning. */
export const ELEVATION_MIN = 0.06;
export const ELEVATION_MAX = 1.25;
export const ELEVATION_DEFAULT = 0.32;

/* The idle turn. Six seconds is long enough that it never starts while someone is reading the
   callouts after a drag, and seven degrees a second is a showroom turntable: visibly alive, slow
   enough that a callout can still be read while its part is on show. */
export const IDLE_AFTER_MS = 6000;
export const IDLE_RATE = (7 * Math.PI) / 180;
const IDLE_EASE_MS = 2500;

/* A flick's speed is read from this much of the drag's end. The last event alone reports a finger's
   jitter as speed; much more than this and a flick that slowed before letting go coasts as if it had
   not. */
export const RELEASE_WINDOW_MS = 80;
/* A turn and a half a second. Past that a coast is a blur, not a gesture anyone meant. */
export const SPIN_MAX = 3 * Math.PI;

/* Radians the stage turns for a drag across the canvas's shorter side. At the default framing this is
   about what keeps the near bumper under the finger, so the robot feels held rather than steered, and
   because it is measured against the canvas it feels the same full screen as in a small window. */
const DRAG_TURN = 3.4;
/* Vertical drags tilt at half the rate horizontal ones turn. The elevation range is barely a radian,
   and at full rate the small vertical wobble in any sideways flick would bob the camera. */
const TILT_RATIO = 0.5;

/* The robot fills this much of the canvas height at the default zoom, and never more than this much of
   its width, which is what keeps a narrow canvas from cropping the bumpers. */
const FILL_HEIGHT = 0.64;
const FILL_WIDTH = 0.8;

/**
 * A coasting velocity after `dtSeconds`, decaying by `perFrame60` per 60 Hz frame.
 *
 * Written as a power of the elapsed time rather than a multiply per frame, so a coast lasts as long at
 * the 30 fps this view draws at as it would at 60 or 144.
 */
export function dampVelocity(v, dtSeconds, perFrame60 = 0.92) {
  if (!Number.isFinite(v)) return 0;
  if (!(dtSeconds > 0)) return v;
  return v * Math.pow(perFrame60, dtSeconds * 60);
}

/**
 * How far a coast starting at `v` turns the stage during `dtSeconds`.
 *
 * This is the integral of dampVelocity across the step, not `v * dt`. Stepping position by the
 * velocity at the start of each frame overshoots by an amount that depends on the frame length, so a
 * flick would travel further on a slow laptop than on a fast one.
 */
export function coastAngle(v, dtSeconds, perFrame60 = 0.92) {
  if (!Number.isFinite(v) || !(dtSeconds > 0)) return 0;
  const rate = -60 * Math.log(perFrame60);
  if (!(rate > 0)) return v * dtSeconds;
  return (v * (1 - Math.exp(-rate * dtSeconds))) / rate;
}

/** An elevation held inside the range the camera may use. Garbage comes back as the default view. */
export function clampElevation(radians) {
  if (typeof radians !== "number" || Number.isNaN(radians)) return ELEVATION_DEFAULT;
  return Math.min(ELEVATION_MAX, Math.max(ELEVATION_MIN, radians));
}

/**
 * The angular velocity a drag was turning the stage at when it let go, in rad/s, signed like the
 * pointer's own movement (positive to the right).
 *
 * `samples` are `{ t, x }`: milliseconds and pixels, oldest first, ending with the release itself. The
 * speed is a least-squares slope over the last RELEASE_WINDOW_MS, which is what Compose's tracker and
 * motion.js's do, because the last two points alone report noise as speed. The one sample just before
 * the window is included as well: a slow machine may deliver a single event in 80 ms, and a window
 * holding one point would turn a real flick into no flick. A finger that stopped before lifting shows
 * up as the release sample sitting where the last move left it, so it correctly measures zero.
 */
export function releaseVelocity(samples, radPerPx = DRAG_TURN / 800) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples.length - 1;
  while (first > 0 && last.t - samples[first].t < RELEASE_WINDOW_MS) first--;

  const t0 = samples[first].t;
  let n = 0, st = 0, sx = 0, stt = 0, stx = 0;
  for (let i = first; i < samples.length; i++) {
    const t = samples[i].t - t0;
    const x = samples[i].x;
    n++; st += t; sx += x; stt += t * t; stx += t * x;
  }
  const det = n * stt - st * st;
  if (!(det > 0)) return 0;
  const pxPerMs = (n * stx - st * sx) / det;
  const v = pxPerMs * 1000 * radPerPx;
  if (!Number.isFinite(v)) return 0;
  return Math.max(-SPIN_MAX, Math.min(SPIN_MAX, v));
}

/**
 * The idle turn's speed in rad/s after `idleMs` without interaction.
 *
 * Zero until IDLE_AFTER_MS, then eased up to IDLE_RATE along a smoothstep, so the stage starts from
 * rest with no jolt of acceleration: a turntable that was switched on, not one that was already
 * spinning. Always zero under reduced motion.
 */
export function idleSpin(idleMs, reduced = false) {
  if (reduced || !(idleMs >= IDLE_AFTER_MS)) return 0;
  const u = Math.min(1, (idleMs - IDLE_AFTER_MS) / IDLE_EASE_MS);
  return IDLE_RATE * u * u * (3 - 2 * u);
}

/**
 * Where a robot lands on screen, in normalised device units (the canvas is 2 across), with the camera
 * `distance` from the point `lookY` metres above the floor at the robot's centre, looking down at
 * `elevation`.
 *
 * The robot is described as `parts`, upright cylinders `{ radius, bottom, top }` in metres above the
 * floor, all centred on the robot. One cylinder round the whole robot is simple and wrong: it puts the
 * top of a central superstructure out at the bumpers' far edge, so the robot comes out smaller than
 * asked, by more the taller and narrower that superstructure is. A wide low cylinder for the bumpers
 * and a narrow tall one for what stands on them is still the same from every side, so the framing
 * holds steady while the stage turns.
 *
 * `vertical` is half the height covered, `side` half the width, and `centre` how far the middle sits
 * above the middle of the canvas. All three are worked out under perspective rather than estimated
 * orthographically: at these distances the near bumper is drawn visibly larger than the far one, and an
 * orthographic centre sits the robot low.
 */
export function silhouette(parts, lookY, elevation, fovY, aspect, distance) {
  const tan = Math.tan(fovY / 2);
  const wide = aspect > 0 ? aspect : 1;
  const c = Math.cos(elevation);
  const s = Math.sin(elevation);
  let top = -Infinity;
  let bottom = Infinity;
  let side = 0;
  for (const { radius, bottom: from, top: to } of parts) {
    for (const y of [from - lookY, to - lookY]) {
      /* In the camera's vertical plane a cylinder is a rectangle, and its extremes on screen are the
         rectangle's corners: u runs toward the camera, y up from the point looked at. */
      for (const u of [-radius, radius]) {
        const depth = distance - (u * c + y * s);
        const ndc = (y * c - u * s) / (depth * tan);
        if (ndc > top) top = ndc;
        if (ndc < bottom) bottom = ndc;
      }
      /* Across the screen, a rim is widest where a sight line grazes it. */
      const rim = distance - y * s;
      const graze = Math.sqrt(Math.max(rim * rim - radius * radius * c * c, 1e-9));
      side = Math.max(side, radius / (graze * tan * wide));
    }
  }
  return { vertical: (top - bottom) / 2, side, centre: (top + bottom) / 2 };
}

/**
 * How far the camera stands from the point it looks at for the robot to fill `fill` of the canvas
 * height without covering more than `fillWidth` of its width.
 *
 * Solved by bisection on silhouette(), which shrinks steadily with distance. A wide canvas is limited
 * by height and a narrow one by width, so the same robot is framed well in a letterbox and in a
 * portrait tile alike.
 */
export function fitDistance(parts, lookY, elevation, fovY, aspect, fill = FILL_HEIGHT, fillWidth = FILL_WIDTH) {
  let near = closest(parts, lookY);
  let far = near + 500;
  for (let i = 0; i < 48; i++) {
    const mid = (near + far) / 2;
    const seen = silhouette(parts, lookY, elevation, fovY, aspect, mid);
    if (seen.vertical > fill || seen.side > fillWidth) near = mid;
    else far = mid;
  }
  return far;
}

/** The nearest the camera may stand to the point it looks at without any part reaching the lens. */
export function closest(parts, lookY) {
  let reach = 0;
  for (const { radius, bottom, top } of parts) {
    reach = Math.max(reach, Math.hypot(radius, Math.max(Math.abs(top - lookY), Math.abs(bottom - lookY))));
  }
  return reach + 0.05;
}

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

/* ---- the scene ---- */

const FRAME_MS = 1000 / 30;

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

/* The stage's floor stops here, metres from the robot's centre. By then its fade has reached nothing,
   so the quad's edge is never seen however low the camera goes. */
const FLOOR_RADIUS = 6;

/* Where the camera starts: off the front-left corner, 38 degrees round from the nose, the angle a car
   is photographed from. The stage turns rather than the camera (see placeCamera), so this is a
   rotation of the stage that puts that corner toward the lens. */
const YAW_DEFAULT = -(Math.PI / 2 + 0.66);
const ZOOM_MIN = 0.62;
const ZOOM_MAX = 1.8;
const ZOOM_EASE_S = 0.09;
const RESET_MS = 700;
/* When a finger lands on a turning stage the idle turn stops within about a third of a second: fast
   enough to feel caught, slow enough not to jolt. */
const SPIN_CATCH_S = 0.1;
const INERTIA_REST = 0.01;
const BUMPER_FADE_MS = 350;
/* How far past edge-on an anchor's surface may turn and still count as visible. Slightly past, so a
   callout does not blink off the instant its face is exactly side-on. */
const FACING_MIN = -0.1;

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
};

const FLOOR_VERTEX = /* glsl */ `
  varying vec2 vPlan;
  void main() {
    // The plane lies in its own xy before the mesh turns it flat, so xy here is the floor in metres:
    // x toward the robot's front, y toward its left.
    vPlan = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FLOOR_FRAGMENT = /* glsl */ `
  uniform vec3 uFloor;
  uniform vec3 uGrid;
  uniform float uRadius;
  uniform float uCell;
  uniform float uLine;
  uniform vec2 uFootprint;
  uniform float uCorner;
  varying vec2 vPlan;

  // Grid lines with a constant world width that never alias. Where a line would be thinner than a
  // pixel it is drawn one pixel wide and dimmed to the same coverage, and where the cells themselves
  // shrink below a pixel the grid fades to its average brightness instead of shimmering. This is Ben
  // Golus's construction, and it is what keeps the far floor calm at a grazing camera angle.
  float gridLines(vec2 plan, float pitch, float width) {
    vec2 uv = plan / pitch;
    vec2 ddx = dFdx(uv);
    vec2 ddy = dFdy(uv);
    vec2 footprint = vec2(length(vec2(ddx.x, ddy.x)), length(vec2(ddx.y, ddy.y)));
    vec2 wanted = vec2(width / pitch);
    vec2 drawn = clamp(wanted, footprint, vec2(0.5));
    vec2 aa = footprint * 1.5;
    vec2 fromLine = 1.0 - abs(fract(uv) * 2.0 - 1.0);
    vec2 cover = smoothstep(drawn + aa, drawn - aa, fromLine);
    cover *= clamp(wanted / drawn, 0.0, 1.0);
    cover = mix(cover, wanted, clamp(footprint * 2.0 - 1.0, 0.0, 1.0));
    return mix(cover.x, 1.0, cover.y);
  }

  float roundedRect(vec2 p, vec2 halfSize, float corner) {
    vec2 q = abs(p) - halfSize + corner;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
  }

  void main() {
    float reach = clamp(length(vPlan) / uRadius, 0.0, 1.0);

    // The pool of light the robot stands in, falling away quickly and then lingering, the way a
    // spotlight's edge does.
    float light = pow(1.0 - reach, 3.5);
    vec3 colour = uFloor * light;

    // The lines are lit by the same pool as the floor, so they fade with it instead of glowing on
    // their own out in the dark, and they give out before the floor does, so they read as markings
    // around the robot rather than a lattice running off to the horizon.
    float grid = max(gridLines(vPlan, uCell, uLine) * 0.5, gridLines(vPlan, uCell * 4.0, uLine * 1.4));
    float gridLight = pow(1.0 - reach, 2.0) * (1.0 - smoothstep(0.05, 0.5, reach));
    colour = mix(colour, uGrid * gridLight, grid * 0.8);

    // The contact shadow: dense right under the bumpers, where no light reaches, and a wide soft
    // skirt around them. It darkens the grid lines too, which is most of what makes the robot sit on
    // the floor instead of hovering over it.
    float d = roundedRect(vPlan, uFootprint, uCorner);
    float shade = max((1.0 - smoothstep(-0.08, 0.06, d)) * 0.95, (1.0 - smoothstep(-0.12, 0.8, d)) * 0.7);
    colour *= 1.0 - shade;

    gl_FragColor = vec4(colour, 1.0 - smoothstep(0.35, 0.9, reach));
    #include <colorspace_fragment>

    // A dark gradient this wide bands visibly in eight bits. A pixel of noise breaks the bands up and
    // costs nothing.
    float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    gl_FragColor.rgb += (grain - 0.5) / 255.0;
  }
`;

/* ---- geometry helpers ---- */

/** A rounded rectangle centred on (cx, cy). */
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

  /* Bumpers: one continuous ring rather than four rails, a flat face with rounded top and bottom edges,
     the shape fabric takes when it is pulled over pool noodles. A deeper bevel than this rounds the
     face away entirely and the ring reads as an inflatable. */
  const tx = (spec.bumperLength - L) / 2;
  const tz = (spec.bumperWidth - W) / 2;
  const thin = Math.min(tx, tz);
  const corner = 0.02 + Math.max(thin, 0) * 0.6;
  if (thin > 0.004) {
    const b = Math.min(thin * 0.3, BUMPER_HEIGHT * 0.25);
    put(
      extrudeUp(
        ring(spec.bumperLength - 2 * b, spec.bumperWidth - 2 * b, corner - b, L + 2 * b, W + 2 * b, 0.02 + b),
        BUMPER_HEIGHT, b, 4, 6
      ),
      mat.bumper, 0, BUMPER_BOTTOM + BUMPER_HEIGHT / 2, 0
    );
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
  };

  /* What the camera frames: a wide low cylinder reaching the bumper outline's true corners (or a module
     configured outside it), and a narrow tall one round the superstructure. */
  let radius = Math.hypot(spec.bumperLength / 2 - corner, spec.bumperWidth / 2 - corner) + corner;
  for (const [mx, my] of spec.modules) radius = Math.max(radius, Math.hypot(mx, my) + WHEEL_RADIUS);
  const parts = [{ radius, bottom: 0, top: baseTop }];
  if (reach > 0) parts.push({ radius: reach, bottom: 0, top: H });

  return { group, anchors, parts, corner };
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
function studio(renderer) {
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

/* ---- the view ---- */

/**
 * Create the park view on `canvas`.
 *
 * It starts inactive and draws nothing until setActive(true). `opts.reducedMotion` switches off the
 * idle turn, the coast after a flick and the animated reset; when it is not given, the system's
 * prefers-reduced-motion setting decides.
 */
export function createPark(canvas, opts) {
  const reduced =
    typeof opts?.reducedMotion === "boolean"
      ? opts.reducedMotion
      : Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

  /* The palette, read from the stylesheet as field3d.js reads its own, with the stage's own values
     where the console has not set a token. Read here rather than when the module loads, so the module
     can be imported by the tests with no document, and so a park created after a theme change draws
     in the new theme. A value THREE cannot parse falls back too, rather than turning a bumper black. */
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
  const FLOOR = token("--park-floor", "#2c2c2e");
  const GRID = token("--park-grid", "#48484a");

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  /* Transparent, not painted black: the floor fades out by alpha, so the stage melts into whatever the
     page behind it is instead of ending at the edge of a slightly different black rectangle. */
  renderer.setClearColor(0x000000, 0);
  /* Khronos' neutral curve rather than ACES: it rolls off the softbox highlights on the aluminium
     without pulling alliance red toward orange, which ACES does. */
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  /* A long lens, as a product is photographed. A wide one bulges the near bumper toward the viewer. */
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.05, 80);

  const owned = new Set();
  const own = (thing) => {
    owned.add(thing);
    return thing;
  };
  let robotGeometries = new Set();
  const keep = (geometry) => {
    robotGeometries.add(geometry);
    return geometry;
  };

  /* Lights. Low ambient so the side away from them falls to near black, as a car's does on a showroom
     stage; a key from above and in front; and a cool rim from behind that draws the robot's outline
     against the dark. Most of the metal's light comes from the studio reflections, so these are set
     for the painted and fabric parts. They do not move: the stage turns beneath them. */
  scene.add(new THREE.HemisphereLight(0xffffff, 0x0b0b0c, 0.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-2.2, 5, 3.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdae3f4, 2.2);
  rim.position.set(2.4, 3.2, -5);
  scene.add(rim);

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
      side: THREE.DoubleSide,
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
  };
  /* The weave is seen at a glancing angle along every bumper face, which is exactly where plain
     mipmapping smears it away first. */
  mat.bumper.normalMap.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const sheenFrom = (colour) => mat.bumper.sheenColor.copy(colour).lerp(new THREE.Color(1, 1, 1), 0.3);
  sheenFrom(NEUTRAL);

  /* The stage: floor and robot together. Everything the viewer turns is under this one node. */
  const stage = new THREE.Group();
  scene.add(stage);

  const floorUniforms = {
    uFloor: { value: FLOOR },
    uGrid: { value: GRID },
    uRadius: { value: FLOOR_RADIUS },
    uCell: { value: 0.25 },
    uLine: { value: 0.004 },
    uFootprint: { value: new THREE.Vector2(0.45, 0.45) },
    uCorner: { value: 0.1 },
  };
  const floor = new THREE.Mesh(
    own(new THREE.PlaneGeometry(FLOOR_RADIUS * 2, FLOOR_RADIUS * 2)),
    own(new THREE.ShaderMaterial({
      uniforms: floorUniforms,
      vertexShader: FLOOR_VERTEX,
      fragmentShader: FLOOR_FRAGMENT,
      transparent: true,
      depthWrite: false,
      /* The floor is a designed gradient, not lit HDR. The neutral curve's toe subtracts nearly all of
         the darkest channel from a dark colour, which would crush this floor to black and blow its
         faintest tint up into navy. Its tokens land on screen as written instead. */
      toneMapped: false,
    }))
  );
  floor.rotation.x = -Math.PI / 2;
  /* First of the see-through things, so the smoked hood always blends over the floor and never under
     it, whichever the depth sort would have put nearer. */
  floor.renderOrder = -1;
  stage.add(floor);

  let robot = null;
  let anchorDefs = null;
  let parts = [];
  let lookY = 0;
  let lastSpec = "";

  function applyRobot(spec) {
    const next = normalizeRobot(spec);
    const signature = JSON.stringify(next);
    /* A caller may hand the same config over on every telemetry tick. Rebuilding forty meshes for a
       robot that did not change would be the most expensive thing this view does. */
    if (signature === lastSpec) return;
    lastSpec = signature;

    if (robot) {
      stage.remove(robot);
      for (const geometry of robotGeometries) geometry.dispose();
      robotGeometries = new Set();
    }
    const built = buildRobot(next, mat, keep);
    robot = built.group;
    anchorDefs = built.anchors;
    parts = built.parts;
    /* Looking at the middle of the robot's height. placeCamera's lens shift does the fine centring, so
       this only has to put the camera's axis through the robot. */
    lookY = Math.max(...parts.map((part) => part.top)) / 2;
    stage.add(robot);

    floorUniforms.uFootprint.value.set(next.bumperLength / 2, next.bumperWidth / 2);
    floorUniforms.uCorner.value = built.corner;
    requestRender();
  }

  /* ---- camera state ----
   *
   * The camera never swings round. The stage turns under a fixed camera and fixed lights, the way a car
   * turns on a showroom turntable, so the key light and the rim stay where they flatter the model from
   * every side instead of ending up behind it half way round. */

  let yaw = YAW_DEFAULT;
  let elevation = ELEVATION_DEFAULT;
  let zoom = 1;
  let zoomTarget = 1;
  let inertia = 0;          // rad/s, left over from a flick
  let spin = 0;             // rad/s, the idle turn
  let lastInteraction = performance.now();
  let resetAnim = null;
  const lookAt = new THREE.Vector3();

  function placeCamera() {
    const fovY = THREE.MathUtils.degToRad(camera.fov);
    const aspect = camera.aspect;
    const fit = fitDistance(parts, lookY, elevation, fovY, aspect);
    /* Zoomed all the way in, never inside the robot. */
    const distance = Math.max(fit * zoom, closest(parts, lookY) + 0.2);
    lookAt.set(0, lookY, 0);
    camera.position.set(0, lookAt.y + Math.sin(elevation) * distance, Math.cos(elevation) * distance);
    camera.lookAt(lookAt);
    stage.rotation.y = yaw;
    /* Perspective draws the near bumper lower than the far one rises, so a robot the camera looks
       straight at sits below the middle of the canvas. A lens shift of exactly that much re-centres it
       without tilting the camera, which would change the angle the robot is seen from. */
    if (sized.w > 0 && sized.h > 0) {
      const { centre } = silhouette(parts, lookY, elevation, fovY, aspect, distance);
      camera.setViewOffset(sized.w, sized.h, 0, (-centre * sized.h) / 2, sized.w, sized.h);
    }
    camera.updateMatrixWorld();
    stage.updateMatrixWorld();
  }

  /* ---- sizing ---- */

  let sized = { w: 0, h: 0, dpr: 0 };
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (w === sized.w && h === sized.h && dpr === sized.dpr) return false;
    sized = { w, h, dpr };
    if (w === 0 || h === 0) return false;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    return true;
  }

  const observer = new ResizeObserver(() => {
    if (resize()) requestRender();
  });
  observer.observe(canvas);

  /* ---- loop ----
   *
   * On demand. requestRender() asks for one frame; a frame that finds something still moving asks for
   * the next, and one that finds nothing moving lets the loop stop. */

  let active = false;
  let disposed = false;
  let raf = 0;
  let wakeTimer = 0;
  let lastFrame = -Infinity;
  let asleep = true;
  let environment = null;
  const frameListeners = new Set();

  function requestRender() {
    if (!active || disposed || raf) return;
    raf = requestAnimationFrame(tick);
  }

  /* While the loop sleeps nothing is drawn, and the idle turn is not a frame anyone requested, so a
     timer wakes the loop when the turn is due. */
  function sleep(now) {
    asleep = true;
    clearTimeout(wakeTimer);
    wakeTimer = 0;
    if (reduced || pointers.size) return;
    const due = IDLE_AFTER_MS - (now - lastInteraction);
    if (due > 0) {
      wakeTimer = setTimeout(() => {
        wakeTimer = 0;
        requestRender();
      }, due + 20);
    }
  }

  function tick(now) {
    raf = 0;
    if (!active || disposed) return;
    /* The same 30 fps cap as the field, with two milliseconds of slack: at 60 Hz the second frame lands
       a hair under 33.3 ms often enough that a strict test drops to 20 fps. */
    if (now - lastFrame < FRAME_MS - 2) {
      raf = requestAnimationFrame(tick);
      return;
    }
    /* Waking from sleep, the gap since the last frame is time nothing was moving, so the first step
       is one frame long. Stepping a fresh flick by the whole pause would jump it round. */
    const dt = asleep ? FRAME_MS / 1000 : Math.min(now - lastFrame, 100) / 1000;
    lastFrame = now;
    asleep = false;

    resize();
    if (!sized.w || !sized.h) {
      /* Nothing to draw into. The observer asks again when the canvas has a size. */
      sleep(now);
      return;
    }
    const moving = step(dt, now);
    draw();
    if (moving) raf = requestAnimationFrame(tick);
    else sleep(now);
  }

  function step(dt, now) {
    let moving = false;

    if (resetAnim) {
      const u = Math.min(1, Math.max(0, (now - resetAnim.start) / RESET_MS));
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      yaw = resetAnim.yaw[0] + (resetAnim.yaw[1] - resetAnim.yaw[0]) * e;
      elevation = resetAnim.elevation[0] + (resetAnim.elevation[1] - resetAnim.elevation[0]) * e;
      zoom = zoomTarget = resetAnim.zoom[0] + (resetAnim.zoom[1] - resetAnim.zoom[0]) * e;
      lastInteraction = now;
      if (u < 1) moving = true;
      else resetAnim = null;
    } else {
      if (inertia !== 0) {
        yaw += coastAngle(inertia, dt);
        inertia = dampVelocity(inertia, dt);
        if (Math.abs(inertia) < INERTIA_REST) inertia = 0;
        else moving = true;
      }

      const idle = pointers.size ? 0 : now - lastInteraction;
      const want = idleSpin(idle, reduced);
      /* Up, the turn follows idleSpin's own ease. Down, it is caught: a hand on the stage stops it
         quickly rather than at the pace it wound up. */
      spin = want >= spin ? want : want + (spin - want) * Math.exp(-dt / SPIN_CATCH_S);
      if (spin < 1e-4 && want === 0) spin = 0;
      if (spin > 0) {
        yaw += spin * dt;
        moving = true;
      }
      /* The turn is due but idleSpin starts from zero, so the first frame past the threshold has no
         speed yet. Without this the loop would go back to sleep right on the threshold. */
      if (!reduced && idle >= IDLE_AFTER_MS) moving = true;

      if (zoom !== zoomTarget) {
        zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt / ZOOM_EASE_S));
        if (Math.abs(zoomTarget - zoom) < 1e-4) zoom = zoomTarget;
        else moving = true;
      }
    }

    if (bumperFade) {
      const u = Math.min(1, Math.max(0, (now - bumperFade.start) / BUMPER_FADE_MS));
      mat.bumper.color.lerpColors(bumperFade.from, bumperFade.to, u * u * (3 - 2 * u));
      sheenFrom(mat.bumper.color);
      if (u < 1) moving = true;
      else bumperFade = null;
    }

    return moving;
  }

  function draw() {
    if (!environment) {
      /* Built on the first frame rather than at creation, so a park that is created and never shown
         never costs the GPU anything. It is given to each material rather than to the scene, because
         only a material's own map honours its envMapIntensity. */
      environment = studio(renderer);
      for (const thing of owned) {
        if (!thing.isMeshStandardMaterial) continue;
        thing.envMap = environment.texture;
        thing.needsUpdate = true;
      }
    }
    placeCamera();
    renderer.render(scene, camera);
    for (const fn of frameListeners) {
      try {
        fn();
      } catch (err) {
        /* A broken callout must not stop the stage from drawing. */
        console.error("park frame listener failed", err);
      }
    }
  }

  /* ---- input ---- */

  const pointers = new Map();   // pointerId -> { x, y }
  let samples = [];
  let pinch = null;
  const listeners = [];
  const listen = (type, fn, options) => {
    canvas.addEventListener(type, fn, options);
    listeners.push([type, fn, options]);
  };

  const radPerPx = () => DRAG_TURN / Math.max(1, Math.min(sized.w || 800, sized.h || 800));
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };

  /* Any touch stops everything that was moving on its own: the coast, the idle turn, a reset. The user
     has the stage now. */
  function takeHold() {
    lastInteraction = performance.now();
    inertia = 0;
    resetAnim = null;
    clearTimeout(wakeTimer);
    wakeTimer = 0;
  }

  const previousTouchAction = canvas.style.touchAction;
  const previousCursor = canvas.style.cursor;
  /* The browser would otherwise claim a touch drag as a scroll or a page zoom before it reached us. */
  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";

  listen("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (pointers.size >= 2) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* A synthetic or already-finished pointer cannot be captured, and that costs nothing here. */
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    takeHold();
    if (pointers.size === 1) {
      samples = [{ t: e.timeStamp, x: e.clientX }];
    } else {
      pinch = { spread: spread(), zoom: zoomTarget };
      samples = [];
    }
    canvas.style.cursor = "grabbing";
    requestRender();
  });

  listen("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    lastInteraction = performance.now();

    if (pointers.size === 1) {
      const k = radPerPx();
      yaw += dx * k;
      elevation = clampElevation(elevation + dy * k * TILT_RATIO);
      samples.push({ t: e.timeStamp, x: e.clientX });
      /* Only the end of the drag is ever read, so the history is trimmed to a few windows' worth. */
      while (samples.length > 2 && e.timeStamp - samples[1].t > RELEASE_WINDOW_MS * 3) samples.shift();
    } else if (pinch) {
      zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (pinch.zoom * pinch.spread) / spread()));
    }
    requestRender();
  });

  function release(e, cancelled) {
    if (!pointers.has(e.pointerId)) return;
    const orbiting = pointers.size === 1;
    pointers.delete(e.pointerId);
    try {
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* Already released by the browser. */
    }

    if (orbiting && !cancelled) {
      samples.push({ t: e.timeStamp, x: e.clientX });
      /* Under reduced motion the stage stops where the finger left it. */
      inertia = reduced ? 0 : releaseVelocity(samples, radPerPx());
    }
    samples = [];
    pinch = null;
    if (pointers.size === 1) {
      /* One finger of a pinch lifted. The other carries on as a drag from where it is, with a fresh
         history, so the pinch's movement is not read as a flick. */
      const [rest] = pointers.values();
      samples = [{ t: e.timeStamp, x: rest.x }];
    }
    if (!pointers.size) canvas.style.cursor = "grab";
    lastInteraction = performance.now();
    requestRender();
  }

  listen("pointerup", (e) => release(e, false));
  listen("pointercancel", (e) => release(e, true));
  listen("lostpointercapture", (e) => release(e, true));

  listen("wheel", (e) => {
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * (sized.h || 800) : e.deltaY;
    /* Multiplicative, so each notch moves the camera the same proportion of its distance: zooming in
       close feels as controlled as zooming out. */
    zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomTarget * Math.exp(px * 0.0012)));
    takeHold();
    requestRender();
  }, { passive: false });

  listen("dblclick", (e) => {
    e.preventDefault();
    resetView();
  });

  /* ---- alliance ---- */

  let bumperFade = null;
  let allianceTarget = NEUTRAL;
  mat.bumper.color.copy(NEUTRAL);

  function resetView() {
    if (disposed) return;
    takeHold();
    spin = 0;
    /* Unwind the long way round the robot may have been turned, so a reset never spins it several times
       to get home. */
    const turns = Math.round((yaw - YAW_DEFAULT) / (2 * Math.PI));
    const home = YAW_DEFAULT + turns * 2 * Math.PI;
    if (reduced || !active) {
      yaw = home;
      elevation = ELEVATION_DEFAULT;
      zoom = zoomTarget = 1;
      requestRender();
      return;
    }
    resetAnim = {
      start: performance.now(),
      yaw: [yaw, home],
      elevation: [elevation, ELEVATION_DEFAULT],
      zoom: [zoom, 1],
    };
    requestRender();
  }

  /* ---- public surface ---- */

  const scratch = { point: new THREE.Vector3(), normal: new THREE.Vector3(), eye: new THREE.Vector3() };
  applyRobot({});

  return {
    /** The robot's dimensions in metres. Any field may be missing; see normalizeRobot. */
    setRobot(spec) {
      if (disposed) return;
      applyRobot(spec);
    },

    /** "red" or "blue" colours the bumpers; anything else is a robot with no alliance yet. */
    setAlliance(alliance) {
      if (disposed) return;
      /* FMS data and NetworkTables spell it "Red" as often as "red". */
      const name = typeof alliance === "string" ? alliance.toLowerCase() : alliance;
      const to = name === "red" ? RED : name === "blue" ? BLUE : NEUTRAL;
      if (to === allianceTarget) return;
      allianceTarget = to;
      if (reduced || !active) {
        bumperFade = null;
        mat.bumper.color.copy(to);
        sheenFrom(to);
      } else {
        bumperFade = { start: performance.now(), from: mat.bumper.color.clone(), to };
      }
      requestRender();
    },

    /** True while the view is on screen. False stops the loop entirely; nothing is drawn until true. */
    setActive(next) {
      if (disposed) return;
      next = Boolean(next);
      if (next === active) return;
      active = next;
      if (active) {
        /* Coming on screen counts as a fresh look: the idle turn waits its full delay from here. */
        lastInteraction = performance.now();
        spin = 0;
        asleep = true;
        resize();
        requestRender();
      } else {
        cancelAnimationFrame(raf);
        raf = 0;
        clearTimeout(wakeTimer);
        wakeTimer = 0;
        inertia = 0;
        spin = 0;
        resetAnim = null;
        pointers.clear();
        samples = [];
        pinch = null;
        canvas.style.cursor = "grab";
        if (bumperFade) {
          mat.bumper.color.copy(bumperFade.to);
          sheenFrom(bumperFade.to);
          bumperFade = null;
        }
      }
    },

    /**
     * Where the callout targets are on the canvas right now, in CSS pixels from its top-left corner.
     *
     * battery: the outer top edge of the battery. drivetrain: the top of the first module's housing
     * (front-left by WPILib's order). bumper: the middle of the front bumper. top: the top of the
     * superstructure. `visible` is false when the point is off the canvas or its surface has turned
     * away from the camera, so a callout can step aside rather than point through the robot.
     */
    anchors() {
      const hidden = () => ({ x: 0, y: 0, visible: false });
      if (disposed || !anchorDefs) return { battery: hidden(), drivetrain: hidden(), bumper: hidden(), top: hidden() };
      resize();
      if (!sized.w || !sized.h) return { battery: hidden(), drivetrain: hidden(), bumper: hidden(), top: hidden() };
      placeCamera();
      const out = {};
      for (const [name, def] of Object.entries(anchorDefs)) {
        const point = scratch.point.copy(def.point).applyMatrix4(robot.matrixWorld);
        const normal = scratch.normal.copy(def.normal).transformDirection(robot.matrixWorld);
        const facing = normal.dot(scratch.eye.copy(camera.position).sub(point).normalize());
        point.project(camera);
        const x = ((point.x + 1) / 2) * sized.w;
        const y = ((1 - point.y) / 2) * sized.h;
        out[name] = {
          x,
          y,
          visible: point.z > -1 && point.z < 1 && x >= 0 && x <= sized.w && y >= 0 && y <= sized.h && facing > FACING_MIN,
        };
      }
      return out;
    },

    /** Ease the camera back to the default three-quarter view. */
    resetView,

    /** Run `fn` after every drawn frame. Returns a function that unsubscribes it. */
    onFrame(fn) {
      if (typeof fn !== "function" || disposed) return () => {};
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(wakeTimer);
      observer.disconnect();
      for (const [type, fn, options] of listeners) canvas.removeEventListener(type, fn, options);
      for (const id of pointers.keys()) {
        try {
          canvas.releasePointerCapture(id);
        } catch {
          /* Already gone. */
        }
      }
      pointers.clear();
      frameListeners.clear();
      canvas.style.touchAction = previousTouchAction;
      canvas.style.cursor = previousCursor;
      for (const geometry of robotGeometries) geometry.dispose();
      for (const thing of owned) thing.dispose();
      environment?.dispose();
      renderer.dispose();
      /* Release the GL context outright, as the field does: browsers cap how many a page may hold. */
      renderer.forceContextLoss?.();
    },
  };
}
