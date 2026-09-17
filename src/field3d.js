/* The field view.
 *
 * The field is drawn procedurally rather than loaded from CAD, and that is a deliberate trade, not a
 * shortcut. The season's assembly is ~900 parts and ~300 MB; putting that in a driver station
 * dashboard would cost more memory than the rest of the app combined and would tell the driver
 * nothing the outline does not. What actually matters here is *where the robot is* — the field is
 * context around that, so it is built from the field's real dimensions and left plain.
 *
 * Dimensions come from the tile's configuration, so when the season's drawings are in hand you type
 * the two numbers in and the geometry is correct. Nothing is hard-coded to a guess about the layout.
 *
 * The robot is robot3d.js's model, the same one the Park stage draws, built from the robot's own spec
 * sheet, so the machine that drives across the field is the machine that was parked. It is Tesla's
 * driving visualisation for a robot: while the robot is disabled the camera sits off its front corner
 * the way Tesla's car panel shows the parked car, and when it is enabled the camera swings round behind
 * it and follows, with the far field fading into the dark the way Tesla's road does.
 *
 * Cost control, because this runs on the same laptop as the Driver Station:
 *   * Frames are drawn on demand: every display frame, up to 60 a second, while the robot or the
 *     camera is moving, and about once a second while nothing is.
 *   * Rendering stops entirely when the dashboard tab is not showing.
 *   * No shadow maps, no post-processing. The field is flat materials; only the robot is lit properly.
 *   * The renderer is disposed properly when the tile goes away.
 */

import * as THREE from "./vendor/three.module.min.js";
import { createRobotModel, studioEnvironment } from "./robot3d.js";
import { createShots } from "./shots3d.js";
import { FEED_RATE, LAUNCH_KEEP, launchSpeed, SHOOTER_LANES } from "./mechanisms.js";

/* The scene's palette, read from the stylesheet rather than written down twice.
 *
 * This module used to carry its own hexes, and they were the one part of the console that had
 * already been drawn in the house identity - graphite field, crimson nose - while everything painted
 * in CSS was still on the old one. That is exactly the failure a mirrored palette invites, so there
 * is no mirror any more: `:root` holds these under `drawn marks`, and this reads them.
 *
 * Read when the module loads, which is when the field tile first asks for it, long after the
 * stylesheets are in. THREE.Color parses a CSS string through the same sRGB conversion it applies to
 * a hex literal, so nothing about how these land on screen has changed. */
const T = ((style) => (name) => style.getPropertyValue(name).trim())(
  getComputedStyle(document.documentElement)
);

const CARPET = T("--draw-carpet");
const WALL = T("--draw-wall");
const LINE = T("--draw-line");
/* Alliance is the console's, not this scene's: the same two tokens the header and the hub tile read,
   so a field that says "red" and a label that says "red" cannot disagree. */
const RED = T("--red-alliance");
const BLUE = T("--blue-alliance");
const FLOOR = T("--draw-floor");
const SIGNAL = T("--cat-signal");       /* the path ahead of the robot */
const TRIM = T("--cat-ink-strong");     /* the key light, the centre line */
const SKY = T("--draw-sky");
const BOUNCE = T("--draw-bounce");
const FILL_LIGHT = T("--draw-fill");
const UNKNOWN = T("--draw-unknown");
const FUEL = T("--draw-fuel") || "#a8913e";

/* Frames while something moves, and the refresh while nothing does. */
const FRAME_MS = 1000 / 60;
const IDLE_REFRESH_MS = 1000;

/* The two cameras that follow the robot, as a shot in the robot's own frame (x toward its front, y up,
   z toward its right), in metres.

   Parked: off the front-left corner at the bearing the Park stage photographs the robot from, near
   enough that the robot fills a good part of the tile. Handing the robot between Park and this view is
   then a change of distance and framing, not of angle.

   Driving: behind and above, looking at the ground a little ahead, close enough that the robot reads
   as the robot and high enough that the field around it reads as where it is. */
const PARKED_BEARING = Math.PI / 2 + 0.66;   // matches park3d.js's YAW_DEFAULT
const PARKED_EYE = [
  Math.sin(PARKED_BEARING) * Math.cos(0.46) * 3.3,
  0.24 + Math.sin(0.46) * 3.3,
  Math.cos(PARKED_BEARING) * Math.cos(0.46) * 3.3,
];
const PARKED_LOOK = [0, 0.24, 0];
const CHASE_EYE = [-4.4, 2.9, 0];
const CHASE_LOOK = [3.0, 0, 0];

/* How the displayed robot follows reported poses. Poses arrive about ten times a second; between them
   the robot is carried forward along its last velocity for up to one reporting interval, then eased
   onto the report, so it glides instead of hopping. A jump further than any robot drives between two
   reports is a pose reset, and the robot is put there at once. */
const EXTRAPOLATE_S = 0.12;
const FOLLOW_S = 0.06;
const TELEPORT_M = 1.5;
/* The camera turns with the robot, but slowly: a swerve robot can spin on the spot, and a camera that
   whipped round with it would make a driver sick. Rates are a spring's natural frequency, in radians a
   second (see spring): 4.4 trails a steady turn by the same 0.45 s the camera always has. */
const CAMERA_TURN_RATE = 4.4;
/* The slower swing round to look over the robot at what it aims at (see placeCamera). */
const AIM_TURN_RATE = 3.2;
const CAMERA_SWING_RATE = 5;
/* How long the camera keeps the aiming shot once the robot stops aiming, so a robot that aims, shoots,
   and aims again a moment later does not swing the camera away and back between the two. */
const AIM_HOLD_S = 1.6;

/* ---- the clearing ----
 *
 * The robot drives through the field model's game pieces, and on the REBUILT field that is hundreds of
 * balls: drawn as they are, it wades through them with half of it hidden. So the field dissolves where
 * it would get in the way, the way Tesla's visualisation keeps its car clear of whatever it draws round
 * it: everything standing low on the carpet within about a metre of the robot fades out, and anything
 * between the camera and the robot fades out too, at any height. It is a dither rather than a blend,
 * so there is no sorting of transparent geometry to go wrong, and at this size the grain reads as a
 * soft edge. The carpet itself is never touched. The clearing follows the drawn robot, so pieces
 * dissolve as it arrives and come back behind it as it leaves. */

const CARVE_VERTEX = /* glsl */ `
  {
    /* Every part of the baked field is instanced, so a part's own centre and size come from its
       instance. A small part - a game piece, a bolt - standing low near the robot shrinks away into
       itself as the robot comes, and grows back after it has gone. */
    #ifdef USE_INSTANCING
      mat4 carvePlace = modelMatrix * instanceMatrix;
    #else
      mat4 carvePlace = modelMatrix;
    #endif
    vec3 carveCentre = (carvePlace * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float carveSize = length((carvePlace * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
    vCarvePiece = (1.0 - step(0.3, carveSize)) * (1.0 - smoothstep(0.55, 0.8, carveCentre.y));
    float carveNear = 1.0 - smoothstep(0.85, 1.7, length(carveCentre.xz - uCarveRobot.xz));
    /* And along the band to what the robot is aiming at (see aiming in the scene), so the band lies on
       clear carpet rather than being broken up by the FUEL it crosses. */
    vec2 aimRun = uAimTo - uAimFrom;
    float aimAlong = clamp(dot(carveCentre.xz - uAimFrom, aimRun) / max(dot(aimRun, aimRun), 1e-4), 0.0, 1.0);
    float aimNear = 1.0 - smoothstep(0.2, 0.34, length(carveCentre.xz - (uAimFrom + aimRun * aimAlong)));
    transformed *= 1.0 - vCarvePiece * max(carveNear * uCarveAmount, aimNear * uAimAmount);
    vCarveWorld = (carvePlace * vec4(transformed, 1.0)).xyz;
  }
  #include <project_vertex>
`;

const CARVE_FRAGMENT = /* glsl */ `
  #include <clipping_planes_fragment>
  {
    // Nothing on the carpet's own surface is carved, whatever is near the robot.
    float onCarpet = 1.0 - smoothstep(0.012, 0.03, vCarveWorld.y);

    // Round the robot, for the larger parts the vertex shader leaves alone: anything standing below
    // 0.8 m is gone inside a metre of the robot. The edge is kept narrow: a dither across a wide band
    // reads as grain, not as a soft edge.
    float fromRobot = length(vCarveWorld.xz - uCarveRobot.xz);
    float low = 1.0 - smoothstep(0.55, 0.8, vCarveWorld.y);
    float nearRobot = mix(mix(1.0, smoothstep(0.95, 1.2, fromRobot), low), 1.0, vCarvePiece);

    // Along the sight line from the lens to the robot: a tube, wider at the lens end, that stops short
    // of the robot so the clearing round it is left to decide what stands right beside it.
    vec3 sight = uCarveRobot + vec3(0.0, 0.25, 0.0) - uCarveEye;
    float along = clamp(dot(vCarveWorld - uCarveEye, sight) / max(dot(sight, sight), 1e-4), 0.0, 1.0);
    float offLine = length(vCarveWorld - (uCarveEye + sight * along));
    float radius = mix(1.1, 0.55, along);
    float window = smoothstep(0.02, 0.12, along) * (1.0 - smoothstep(0.82, 0.94, along));
    float onLine = mix(1.0, smoothstep(radius * 0.85, radius, offLine), window);

    float keep = mix(1.0, min(nearRobot, onLine), uCarveAmount * (1.0 - onCarpet));
    float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (keep < 0.999 && keep <= grain) discard;

    // The target the robot is aiming at, lit (see aiming in the scene): whatever stands inside its
    // footprint, off the carpet and no higher than a HUB, drawn in its own colour times the tint.
    vec3 litOffset = abs(vCarveWorld - uLitCentre);
    float lit = step(litOffset.x, uLitHalf) * step(litOffset.z, uLitHalf) * step(0.03, vCarveWorld.y) * step(vCarveWorld.y, 2.0);
    diffuseColor.rgb *= mix(vec3(1.0), uLitTint, lit);
  }
`;

/* ---- the path ahead ----
 *
 * Tesla draws the route its car is about to take as a band on the road ahead of it. The robot gets the
 * same, kept quiet: a band narrower than half the robot, in the one blue the console allows for a path,
 * soft at the edges, rising out from under the front bumper and fading away toward its end.
 *
 *   * A planned path - PathPlanner's, or a team planner's - is a solid band.
 *   * An improvised one - an Autopilot finding its own way - is the same band broken into faint
 *     chevrons that drift slowly toward the goal, so a glance tells a plan being followed from a plan
 *     being made up.
 *   * Where the robot is actually heading, from its own motion, is a thin white line a second and a
 *     bit long, so a gap between plan and motion is visible at once.
 *
 * All three lie flat just above the carpet and are drawn as one strip of triangles each. */

const PATH_VERTEX = /* glsl */ `
  attribute float along;
  attribute float across;
  varying float vAlong;
  varying float vAcross;
  void main() {
    vAlong = along;
    vAcross = across;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PATH_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uLength;
  uniform float uEmerge;
  uniform float uChevrons;
  uniform float uTime;
  uniform float uReach;
  uniform float uPulse;
  varying float vAlong;
  varying float vAcross;
  void main() {
    float side = abs(vAcross);
    float body = 1.0 - smoothstep(0.55, 1.0, side);
    float core = 1.0 - smoothstep(0.0, 0.35, side);
    float emerge = smoothstep(uEmerge * 0.4, uEmerge, vAlong);
    // Fades out from uReach of the way along: a plan ahead trails off, a band to a target arrives at it.
    float reach = 1.0 - smoothstep(uLength * uReach, uLength, vAlong);
    float alpha = (body * 0.62 + core * 0.38) * emerge * reach;
    if (uChevrons > 0.5) {
      // Chevrons 0.18 m long every 0.42 m, bent back at the edges so they point the way the robot is
      // going, drifting forward at 0.4 m a second: close enough together to read as one broken band.
      float phase = fract((vAlong + side * 0.1 - uTime * 0.4) / 0.42);
      alpha *= smoothstep(0.0, 0.06, phase) * (1.0 - smoothstep(0.38, 0.46, phase)) * 1.3;
    }
    // A soft bead of light running along the band, for the moment something engages. Off below zero.
    float glow = uPulse < 0.0 ? 0.0 : exp(-pow((vAlong - uPulse * uLength) / 0.35, 2.0)) * core * emerge;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), glow * 0.35), min(1.0, alpha * uOpacity + glow * 0.25 * uOpacity));
    #include <colorspace_fragment>
  }
`;

/* Most points one band holds. A PathPlanner path is dense; beyond this it is thinned. */
const PATH_POINTS = 240;

/** A band of `width` along world points [[x, z], ...] at height `y`, into `ribbon`'s geometry. */
function layRibbon(ribbon, points, width, y) {
  const geometry = ribbon.geometry;
  const count = Math.min(points.length, PATH_POINTS);
  if (count < 2) {
    ribbon.visible = false;
    return 0;
  }
  const position = geometry.getAttribute("position");
  const along = geometry.getAttribute("along");
  let travelled = 0;
  for (let i = 0; i < count; i++) {
    const [x, z] = points[i];
    if (i > 0) travelled += Math.hypot(x - points[i - 1][0], z - points[i - 1][1]);
    const [ax, az] = points[Math.max(0, i - 1)];
    const [bx, bz] = points[Math.min(count - 1, i + 1)];
    const tx = bx - ax;
    const tz = bz - az;
    const len = Math.hypot(tx, tz) || 1;
    const nx = (-tz / len) * (width / 2);
    const nz = (tx / len) * (width / 2);
    position.setXYZ(i * 2, x + nx, y, z + nz);
    position.setXYZ(i * 2 + 1, x - nx, y, z - nz);
    along.setX(i * 2, travelled);
    along.setX(i * 2 + 1, travelled);
  }
  position.needsUpdate = true;
  along.needsUpdate = true;
  geometry.setDrawRange(0, (count - 1) * 6);
  geometry.computeBoundingSphere();
  ribbon.material.uniforms.uLength.value = travelled;
  ribbon.visible = travelled > 0.05;
  return travelled;
}

function makeRibbon(colour, opacity, emerge) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PATH_POINTS * 2 * 3), 3));
  geometry.setAttribute("along", new THREE.BufferAttribute(new Float32Array(PATH_POINTS * 2), 1));
  const across = new Float32Array(PATH_POINTS * 2);
  const index = [];
  for (let i = 0; i < PATH_POINTS; i++) {
    across[i * 2] = -1;
    across[i * 2 + 1] = 1;
    if (i < PATH_POINTS - 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geometry.setAttribute("across", new THREE.BufferAttribute(across, 1));
  geometry.setIndex(index);
  geometry.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(colour) },
      uOpacity: { value: opacity },
      uLength: { value: 1 },
      uEmerge: { value: emerge },
      uChevrons: { value: 0 },
      uTime: { value: 0 },
      uReach: { value: 0.55 },
      uPulse: { value: -1 },
    },
    vertexShader: PATH_VERTEX,
    fragmentShader: PATH_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 2;
  return mesh;
}

/** Teach a field material to dissolve round the robot (see the clearing, above). */
function carve(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCarveRobot = uniforms.uCarveRobot;
    shader.uniforms.uCarveEye = uniforms.uCarveEye;
    shader.uniforms.uCarveAmount = uniforms.uCarveAmount;
    shader.uniforms.uAimFrom = uniforms.uAimFrom;
    shader.uniforms.uAimTo = uniforms.uAimTo;
    shader.uniforms.uAimAmount = uniforms.uAimAmount;
    shader.uniforms.uLitCentre = uniforms.uLitCentre;
    shader.uniforms.uLitHalf = uniforms.uLitHalf;
    shader.uniforms.uLitTint = uniforms.uLitTint;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uCarveRobot;\nuniform float uCarveAmount;\nuniform vec2 uAimFrom;\nuniform vec2 uAimTo;\nuniform float uAimAmount;\nvarying vec3 vCarveWorld;\nvarying float vCarvePiece;")
      .replace("#include <project_vertex>", CARVE_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uCarveRobot;\nuniform vec3 uCarveEye;\nuniform float uCarveAmount;\nuniform vec3 uLitCentre;\nuniform float uLitHalf;\nuniform vec3 uLitTint;\nvarying vec3 vCarveWorld;\nvarying float vCarvePiece;")
      .replace("#include <clipping_planes_fragment>", CARVE_FRAGMENT);
  };
  material.customProgramCacheKey = () => "field-carve";
  return material;
}

/**
 * One step of a critically damped spring: `offset` from its goal and `velocity`, `dt` seconds on, at
 * natural frequency `rate`. Returns [offset, velocity]. The camera eases on these rather than on
 * exponentials: an exponential sets off at its fastest, so the moment what the camera wanted changed -
 * the robot starting to aim, the robot being enabled - it lurched into motion within a frame. A spring
 * gathers speed, then settles without overshooting, the way a camera operator pans.
 */
function spring(offset, velocity, rate, dt) {
  const push = (velocity + rate * offset) * dt;
  const decay = Math.exp(-rate * dt);
  return [(offset + push) * decay, (velocity - rate * push) * decay];
}

/** The shortest signed turn from angle `from` to angle `to`, in radians. */
function angleTo(from, to) {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** [x, y, z] turned about the vertical axis the way three.js turns an object with rotation.y = angle. */
function turnY([x, y, z], angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + z * s, y, -x * s + z * c];
}

/** A shot's eye as a bearing, elevation and distance about its look point. */
function polar(eye, look) {
  const dx = eye[0] - look[0];
  const dy = eye[1] - look[1];
  const dz = eye[2] - look[2];
  const r = Math.max(1e-6, Math.hypot(dx, dy, dz));
  return { look: [...look], bearing: Math.atan2(dx, dz), elevation: Math.asin(Math.max(-1, Math.min(1, dy / r))), r };
}

export function createField(canvas, opts) {
  const length = Number(opts.length) > 1 ? Number(opts.length) : 16.54;
  const width = Number(opts.width) > 1 ? Number(opts.width) : 8.07;
  const trailLen = Math.max(0, opts.trail | 0);
  /* Whether to go looking for the baked model at all. It is a preference about this laptop rather than
     anything this scene can work out, so it arrives as an argument. The console used to express it by
     shimming `window.fetch` to answer 404 for the model's own URL — which worked, and which meant this
     module could be told a file was missing while it sat on disk. Anyone who read only one of the two
     files would have had no way to know. Default on, so a caller that says nothing gets the model. */
  const useModel = opts.model !== false;
  const reduced =
    typeof opts.reducedMotion === "boolean"
      ? opts.reducedMotion
      : Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

  /* The frame poses are mapped through. It starts as the tile's configured field size, which is what
     the procedural outline is drawn from, and is replaced by the baked map's own dimensions when one
     loads. The two are not the same number — the map is the field the CAD actually measures, the tile
     config is the field someone typed in — and a robot has to be drawn in the frame the physics is
     indexed against, not the one the outline happens to use. On the 2026 field the difference is
     16.55 vs 16.54 and 8.05 vs 8.07: 5 mm in x, 10 mm in y. Small, but there is no reason to keep it. */
  let poseLength = length;
  let poseWidth = width;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  /* The robot is tone-mapped exactly as on the Park stage, so it looks the same machine when it is handed
     over. The field is not: every field material opts out of the curve below, because its greys were
     chosen as they land on screen and the curve's toe would crush them. */
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 120);

  /* The far field fades into the tile's own background, as Tesla's road fades into the dark, so the
     robot and what is near it carry the picture and the far side of the field is only context. The
     distances follow the camera (see placeCamera), so the overhead view, which is far from everything,
     is not washed out. */
  const tileGround = (() => {
    const host = canvas.closest(".t") || canvas.parentElement;
    const colour = host ? getComputedStyle(host).backgroundColor : "";
    const parsed = new THREE.Color(NaN, NaN, NaN);
    if (colour && !/rgba\(.*,\s*0\)$/.test(colour)) parsed.setStyle(colour);
    return Number.isFinite(parsed.r) ? parsed : new THREE.Color("#1c1c1e");
  })();
  scene.fog = new THREE.Fog(tileGround, 12, 34);

  scene.add(new THREE.HemisphereLight(SKY, BOUNCE, 0.85));
  const key = new THREE.DirectionalLight(TRIM, 0.55);
  key.position.set(6, 12, 8);
  scene.add(key);
  // A second, weaker light from the opposite side so the far half of the field is not a silhouette.
  const fill = new THREE.DirectionalLight(FILL_LIGHT, 0.3);
  fill.position.set(-8, 6, -7);
  scene.add(fill);

  /* ---- field geometry. Built centred on the origin; poses are translated in. ----
   *
   * Two layers. `field` is the procedural outline, drawn from the season's dimensions. `cad` is the
   * official model, loaded only if someone has run `npm run field-cad` to bake one — when it arrives
   * the outline hides and the real field takes over. The outline is not a placeholder to be ashamed
   * of: it is what renders on a machine that has no model, and it is the thing that always works. */

  /* Where the clearing is (see the clearing, above): the drawn robot, the lens, and how far it is
     switched on, which eases to nothing while there is no robot on the field to clear round. */
  const carveUniforms = {
    uCarveRobot: { value: new THREE.Vector3(0, -100, 0) },
    uCarveEye: { value: new THREE.Vector3() },
    uCarveAmount: { value: 0 },
    uAimFrom: { value: new THREE.Vector2() },
    uAimTo: { value: new THREE.Vector2() },
    uAimAmount: { value: 0 },
    uLitCentre: { value: new THREE.Vector3(0, -100, 0) },
    uLitHalf: { value: 0 },
    uLitTint: { value: new THREE.Color(1, 1, 1) },
  };

  const field = new THREE.Group();
  scene.add(field);

  const cad = new THREE.Group();
  cad.visible = false;
  scene.add(cad);

  const flat = (color, opacity = 1) =>
    new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false });
  const lit = (color) => new THREE.MeshLambertMaterial({ color, toneMapped: false });

  /* The venue floor the field sits on. Without it the frame above the far wall is transparent, and a
     hard black wedge across the top of the tile reads as a rendering fault rather than as sky. It sits
     outside `field` because it is wanted under the CAD model too. */
  const backdrop = new THREE.Group();
  scene.add(backdrop);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(length * 4, width * 6), flat(FLOOR));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;
  backdrop.add(floor);

  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(length, width), flat(CARPET));
  carpet.rotation.x = -Math.PI / 2;
  field.add(carpet);

  /* One-metre grid, drawn as a single LineSegments so it costs one draw call. */
  {
    const points = [];
    for (let x = 1; x < length; x++) points.push(x - length / 2, 0.002, -width / 2, x - length / 2, 0.002, width / 2);
    for (let y = 1; y < width; y++) points.push(-length / 2, 0.002, y - width / 2, length / 2, 0.002, y - width / 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    field.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: LINE, transparent: true, opacity: 0.22, toneMapped: false })));
  }

  /* Perimeter wall, plus taller translucent panels where the driver stations are. */
  {
    const h = 0.5, t = 0.06;
    const rail = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lit(WALL));
      m.position.set(x, h / 2, z);
      field.add(m);
      return m;
    };
    rail(length, t, 0, -width / 2);
    rail(length, t, 0, width / 2);

    const glass = (x, color) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(t, 2.0, width), flat(color, 0.13));
      m.position.set(x, 1.0, 0);
      field.add(m);
      const base = new THREE.Mesh(new THREE.BoxGeometry(t * 2, 0.55, width), lit(color));
      base.position.set(x, 0.275, 0);
      base.material.color.multiplyScalar(0.45);
      field.add(base);
    };
    glass(-length / 2, BLUE);
    glass(length / 2, RED);
  }

  /* Centre line and the two alliance-side lines. These are the marks every field has; anything more
     specific would be a guess about the season. */
  {
    const stripe = (x, color, opacity) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.05, width), flat(color, opacity));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.004, 0);
      field.add(m);
    };
    stripe(0, TRIM, 0.35);
    stripe(-length / 2 + 2.0, BLUE, 0.5);
    stripe(length / 2 - 2.0, RED, 0.5);
  }

  /* ---- the official field model, when one has been baked ---- */

  /* SolidWorks exports Z-up, so the model needs the usual quarter turn to sit in three.js's Y-up
     world. Where it then sits comes from field-collision.json, which the extractor writes when it
     bakes the collision map: `modelToField` is the model-space coordinate of field (0, 0, carpet),
     found by flood-filling the drivable interior.

     This used to centre the model's bounding box instead, and that was simply wrong. The bounding box
     includes everything standing outside the walls, and on the 2026 field that is a scoring table —
     a 240 x 30 in block off the +y wall with nothing matching it on -y. It dragged the box 0.835 m
     across the field width, so the robot drew 0.8 m inside the field from the wall it was actually
     touching and stopped against an invisible barrier. The CAD's own origin was the field centre the
     whole time; measuring the bounding box is what threw that away. The extractor learned this lesson
     already (see the flood fill in scripts/field-collision.mjs) — this is the same mistake in the
     other repo. */
  async function loadFieldModel() {
    /* Switched off is the same outcome as not bundled, by the same route out: the procedural outline
       is already on screen and simply stays there. */
    if (!useModel) return false;

    const response = await fetch("./vendor/field.glb", { method: "HEAD" }).catch(() => null);
    if (!response || !response.ok) return false;

    /* Fetched in parallel with the loader import: it is a few hundred KB of grid we only want four
       numbers out of, and it must not add a round trip to the model's own load. */
    const metaPromise = fetch("./vendor/field-collision.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    const { GLTFLoader } = await import("./vendor/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().loadAsync("./vendor/field.glb");
    const model = gltf.scene;
    model.rotation.x = -Math.PI / 2;
    model.updateMatrixWorld(true);

    const meta = await metaPromise;
    const transform = meta?.modelToField;
    if (meta && Array.isArray(meta.heightsMillimetres) && meta.cols > 0 && meta.rows > 0 && meta.cellMeters > 0 &&
        meta.heightsMillimetres.length === meta.cols * meta.rows) {
      heights = { cols: meta.cols, rows: meta.rows, cell: meta.cellMeters, mm: meta.heightsMillimetres };
    }
    /* Every field the branch below reads has to be present and sane, not just the two that were
       obvious. The guard checked the axis order and the length but the body then destructured
       originMeters and used widthMeters, so a map written by an older version of the extractor — or a
       hand-edited one — would take the fast path and throw partway through instead of falling back. A
       guard that does not cover its own body is not a guard. */
    const usable =
      transform &&
      transform.axes?.join("") === "xyz" &&
      Array.isArray(transform.originMeters) &&
      transform.originMeters.length === 3 &&
      transform.originMeters.every(Number.isFinite) &&
      Number.isFinite(meta.lengthMeters) && meta.lengthMeters > 1 &&
      Number.isFinite(meta.widthMeters) && meta.widthMeters > 1;

    if (usable) {
      /* The quarter turn above sends model (mx, my, mz) to three (mx, mz, -my), so putting the map's
         centre on the scene origin is a subtraction on each axis rather than anything cleverer. The
         scene origin stays at the field centre because the outline, the backdrop, topHeight() and both
         cameras are all built around it. */
      const [ox, oy, oz] = transform.originMeters;
      model.position.set(
        -(ox + meta.lengthMeters / 2),
        // The carpet datum, not the model's lowest vertex: -box.min.y used to stand the model on the
        // UNDERSIDE of the 5 mm carpet mesh, which floated the whole field by its own thickness.
        -oz,
        oy + meta.widthMeters / 2
      );
      poseLength = meta.lengthMeters;
      poseWidth = meta.widthMeters;
    } else {
      /* No baked map, or an axis order this quarter turn does not handle. Centring the bounding box is
         off by however much structure stands outside one wall and not the other — 0.835 m on the 2026
         field — but a field drawn 0.8 m out still beats no field at all. */
      console.warn(
        "field-collision.json has no usable modelToField; falling back to bounding-box centring, " +
          "which misplaces the CAD by however asymmetric the structure outside the walls is"
      );
      const box = new THREE.Box3().setFromObject(model);
      const centre = box.getCenter(new THREE.Vector3());
      model.position.set(-centre.x, -box.min.y, -centre.z);
    }

    /* The KOP model is lit for a marketing render: unpainted parts come through as near-white, which
       in a dark cockpit is a slab of glare that the eye goes to instead of the robot. Every material
       is re-grounded into this dashboard's world — hue kept so alliance red and blue still read,
       saturation and lightness pulled right down so the field recedes and the robot stands out.
       This is the whole reason it looks like part of the console rather than a CAD viewer. */
    const hsl = { h: 0, s: 0, l: 0 };
    const remapped = new Map();

    model.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.frustumCulled = true;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      const next = materials.map((m) => {
        if (!m) return m;
        if (remapped.has(m.uuid)) return remapped.get(m.uuid);

        (m.color || new THREE.Color(UNKNOWN)).getHSL(hsl, THREE.SRGBColorSpace);
        /* Read and write in sRGB, not the linear working space. Pick these numbers linearly and the
           output transfer curve lifts them by roughly a third on screen.

           The band is narrow on purpose. Too light and the field is a slab of glare that pulls the eye
           off the robot; too dark and it is a black void with no readable structure. These sit the
           carpet and framing around #3a-#48 — clearly present, clearly behind the robot. */
        // Tesla renders the world around its car in flat greys and keeps colour for what matters, so the
        // field keeps only a trace of each part's hue - enough that alliance structures still lean red
        // or blue - and the robot, lit near-white, is the one bright thing in the scene.
        const colour = new THREE.Color().setHSL(
          hsl.h,
          hsl.s * 0.22,
          hsl.s < 0.15 ? 0.3 : 0.31 + hsl.s * 0.08,
          THREE.SRGBColorSpace
        );
        const flatMat = carve(new THREE.MeshLambertMaterial({
          color: colour,
          transparent: m.transparent,
          opacity: m.opacity,
          side: m.side,
          toneMapped: false,
        }), carveUniforms);
        remapped.set(m.uuid, flatMat);
        m.dispose();
        return flatMat;
      });
      obj.material = Array.isArray(obj.material) ? next : next[0];
      /* The field's FUEL - several hundred instances of one ball - keeps its colour where everything else
         goes grey: muted yellow, the same as the balls the robot shoots. */
      if (obj.isInstancedMesh && obj.count >= 400 && !Array.isArray(obj.material)) {
        obj.material = carve(new THREE.MeshLambertMaterial({ color: FUEL, toneMapped: false }), carveUniforms);
      }
    });

    cad.add(model);
    cad.visible = !unplaced;
    field.visible = false;   // the outline steps aside for the real thing
    backdrop.visible = !unplaced; // but the venue floor stays: the model stops at the field edge
    dirty = true;
    return true;
  }

  /* ---- the robot ---- */

  /* `robot` is where the robot is on the field and which way it faces; the model inside it is the same
     one the Park stage draws.

     It is drawn as a second pass over the field, in a scene of its own with the Park stage's studio
     lights (see robot3d.js), rather than under the field's. The field's lights are set for grey
     carpet seen from far off; under them the robot was a different colour from the one the stage had
     just handed over, and it changed in the frame the handover happened. The field is drawn first, so
     its depth hides the robot wherever something really stands between it and the camera, and the
     robot's smoked hood blends over the field behind it. */
  const robotScene = new THREE.Scene();
  const robot = new THREE.Group();
  robot.visible = false;
  robotScene.add(robot);
  const model = createRobotModel({ maxAnisotropy: renderer.capabilities.getMaxAnisotropy() });
  robotScene.add(model.lights);
  model.setSpec({});
  robot.add(model.root);

  /* The robot shooting (see shots3d.js): drawn in the field's scene, like the field's own FUEL. The app
     counts the balls that leave the hopper (see mechanisms.js createHopper) and they go out here in
     volleys, up to four abreast across the shooter, each ball a little early or late and a little off
     the others in speed and angle, the way a real shooter's stream looks. */
  const shots = createShots({ colour: FUEL });
  scene.add(shots.root);
  let mechanisms = null;
  let firedSeen = null;
  let queued = 0;
  let nextVolley = 0;
  const launches = [];      // { at, lane, lanes, speed, pitch, yaw }, soonest first
  /* About a standard deviation's worth of noise from three uniform numbers, cheaply. */
  const wobble = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;

  function volley(now) {
    if (!(queued > 0) || now < nextVolley) return;
    const lanes = model.muzzle(30)?.lanes ?? SHOOTER_LANES;
    const count = Math.min(lanes, queued);
    queued -= count;
    const order = Array.from({ length: lanes }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const lane of order.slice(0, count)) {
      launches.push({
        at: now + Math.random() * 70,
        lane,
        lanes,
        speed: 1 + wobble() * 0.03,
        pitch: (wobble() * 1.4 * Math.PI) / 180,
        yaw: (wobble() * 1.8 * Math.PI) / 180,
      });
    }
    launches.sort((a, b) => a.at - b.at);
    /* The next volley when the feed has brought this many balls up, give or take. */
    nextVolley = now + ((count / FEED_RATE) * 1000) * (0.85 + Math.random() * 0.3);
  }

  const launchFrom = new THREE.Vector3();
  const launchAlong = new THREE.Vector3();
  const upward = new THREE.Vector3(0, 1, 0);
  function launchBall(shot, now) {
    if (!mechanisms || !robot.visible || unplaced || !model.root.visible) return;
    const muzzle = model.muzzle(mechanisms.hoodDeg);
    if (!muzzle) return;
    const speed = launchSpeed(mechanisms.shooterRps ?? 0, muzzle.wheelRadius, LAUNCH_KEEP) * shot.speed;
    if (!(speed > 1)) return;
    model.root.updateMatrixWorld();
    const offset = (shot.lane - (shot.lanes - 1) / 2) * muzzle.laneSpacing;
    launchFrom.copy(muzzle.point).addScaledVector(muzzle.across, offset).applyMatrix4(model.root.matrixWorld);
    launchAlong.copy(muzzle.direction).applyAxisAngle(muzzle.across, shot.pitch).applyAxisAngle(upward, shot.yaw)
      .transformDirection(model.root.matrixWorld);
    const vx = reported ? reported.vx : 0;
    const vz = reported ? reported.vz : 0;
    shots.launch(
      [launchFrom.x, launchFrom.y, launchFrom.z],
      [launchAlong.x * speed + vx, launchAlong.y * speed, launchAlong.z * speed + vz],
      now
    );
  }
  model.onChange(() => { dirty = true; });
  let environment = null;

  /* The pose the robot was last reported at, its velocity, and the pose it is drawn at. */
  let reported = null;      // { x, z, heading, vx, vz, vh, at }
  const shown = { x: 0, z: 0, heading: 0 };
  let parked = true;

  /* A robot that is on the other end of the link but has not been placed on the field yet - its
     estimator still at the corner it booted at, no Limelight fix - is drawn on a small stage of its own
     instead of in that corner: the field goes, and a soft pool of light stands in for the ground. The
     caller says so with `placed: false`. */
  let unplaced = false;
  const pool = (() => {
    const size = 256;
    const art = document.createElement("canvas");
    art.width = size;
    art.height = size;
    const context = art.getContext("2d");
    const glow = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    glow.addColorStop(0, "rgba(58, 58, 60, 0.95)");
    glow.addColorStop(0.35, "rgba(44, 44, 46, 0.7)");
    glow.addColorStop(1, "rgba(28, 28, 30, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(art);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 5),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.001;
    mesh.visible = false;
    mesh.renderOrder = -1;
    scene.add(mesh);
    return mesh;
  })();

  function setUnplaced(next) {
    if (unplaced === next) return;
    unplaced = next;
    pool.visible = next;
    backdrop.visible = !next;
    field.visible = !next && !cad.children.length;
    cad.visible = !next && cad.children.length > 0;
    if (trail) trail.visible = !next;
    dirty = true;
  }

  function stepRobot(dt, now) {
    if (!reported) return false;
    const ahead = Math.min(Math.max(0, (now - reported.at) / 1000), EXTRAPOLATE_S);
    const tx = reported.x + reported.vx * ahead;
    const tz = reported.z + reported.vz * ahead;
    const th = reported.heading + reported.vh * ahead;
    const k = reduced ? 1 : 1 - Math.exp(-dt / FOLLOW_S);
    shown.x += (tx - shown.x) * k;
    shown.z += (tz - shown.z) * k;
    shown.heading += angleTo(shown.heading, th) * k;
    robot.position.set(shown.x, 0, shown.z);
    robot.rotation.y = shown.heading;
    const still = Math.abs(tx - shown.x) < 1e-4 && Math.abs(tz - shown.z) < 1e-4 && Math.abs(angleTo(shown.heading, th)) < 1e-4;
    const coasting = ahead < EXTRAPOLATE_S && (reported.vx !== 0 || reported.vz !== 0 || reported.vh !== 0);
    return !still || coasting;
  }

  /* ---- trail ---- */

  let trail = null;
  let trailPoints = 0;
  if (trailLen > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(trailLen * 3), 3));
    geo.setDrawRange(0, 0);
    /* Grey and faint: where the robot has been matters less than where it is going, and blue is kept
       for the plan ahead. */
    trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: TRIM, transparent: true, opacity: 0.2, toneMapped: false }));
    trail.frustumCulled = false;
    scene.add(trail);
  }

  function pushTrail(x, z) {
    if (!trail) return;
    const attr = trail.geometry.getAttribute("position");
    const a = attr.array;
    if (trailPoints < trailLen) {
      a[trailPoints * 3] = x;
      a[trailPoints * 3 + 1] = 0.02;
      a[trailPoints * 3 + 2] = z;
      trailPoints++;
    } else {
      a.copyWithin(0, 3);
      a[(trailLen - 1) * 3] = x;
      a[(trailLen - 1) * 3 + 1] = 0.02;
      a[(trailLen - 1) * 3 + 2] = z;
    }
    trail.geometry.setDrawRange(0, trailPoints);
    attr.needsUpdate = true;
  }

  /* ---- the path ahead (see above) ---- */

  /* The destination: the robot's footprint drawn faintly where the plan ends, facing the way it will
     arrive, with a notch at its front. It comes and goes with the band. */
  const destination = new THREE.Group();
  destination.visible = false;
  scene.add(destination);
  const destinationMaterial = new THREE.MeshBasicMaterial({
    color: SIGNAL, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
  let destinationSize = "";
  function shapeDestination(length, width) {
    const key = `${length.toFixed(3)}x${width.toFixed(3)}`;
    if (key === destinationSize) return;
    destinationSize = key;
    for (const child of [...destination.children]) {
      child.geometry.dispose();
      destination.remove(child);
    }
    const rounded = (w, h, r) => {
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2 + r, -h / 2);
      shape.lineTo(w / 2 - r, -h / 2);
      shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
      shape.lineTo(w / 2, h / 2 - r);
      shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
      shape.lineTo(-w / 2 + r, h / 2);
      shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
      shape.lineTo(-w / 2, -h / 2 + r);
      shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
      return shape;
    };
    const line = 0.035;
    const outline = rounded(length, width, 0.1);
    outline.holes.push(rounded(length - 2 * line, width - 2 * line, 0.1 - line));
    const ring = new THREE.Mesh(new THREE.ShapeGeometry(outline, 6), destinationMaterial);
    ring.rotation.x = -Math.PI / 2;
    destination.add(ring);
    /* The notch: a small arrowhead inside the front edge. The shape's +x is the robot's front. */
    const notch = new THREE.Shape();
    notch.moveTo(length / 2 - 0.05, 0);
    notch.lineTo(length / 2 - 0.16, 0.07);
    notch.lineTo(length / 2 - 0.16, -0.07);
    notch.closePath();
    const arrow = new THREE.Mesh(new THREE.ShapeGeometry(notch), destinationMaterial);
    arrow.rotation.x = -Math.PI / 2;
    destination.add(arrow);
  }

  /* ---- aiming (see mechanisms.js readAim) ----
     Drawn the way Tesla draws what Autopilot is doing: in the scene, grey while it is getting ready and
     blue once it has engaged, and nothing that blinks.

     What the robot aims at is picked out as Tesla picks out the car it is following: the HUB itself is
     lit - everything standing in its footprint, in the field's own shader (see the clearing) - a lighter
     grey than the field round it while the shooter swings onto it, and blue from the moment the robot
     locks on. A band lies on the carpet from the robot to it, like the path ahead of the car:
     grey, reaching further toward the HUB as the heading error closes, then blue, with a bead of light
     running down it into the HUB, which brightens once as the bead arrives.

     Shooting on the move, the band is broken into chevrons drifting toward the target, and it runs to the
     point the robot actually aims at - where its motion carries the ball to the HUB from - so the lead is
     the angle between the band and the HUB. FUEL lobbed to a place on the carpet, while the HUB is off,
     is aimed at the same way, with the place ringed on the carpet instead of anything lit.

     Every mark is a number the robot published; nothing predicts where a ball goes. The camera, meanwhile,
     pulls up and swings round to look over the robot at the target (see placeCamera). */
  const OPENING_HEIGHT = 1.83;
  const OPENING_RADIUS = 0.56;
  /* Where the band stops short of the target's centre: just off the face of a HUB, which is 0.6 m out. */
  const TARGET_FACE = 0.72;
  /* Half the width of what is lit round the target's centre: a HUB is 1.19 m square. */
  const TARGET_HALF = 0.605;
  const AIM_PULSE_S = 0.7;
  const AIM_GREY = new THREE.Color(T("--cat-body"));
  const AIM_BLUE = new THREE.Color(SIGNAL);
  /* The target is drawn in its own grey times these, in the working (linear) space: lifted while aligning,
     and a quiet steel blue once locked - its grey, about a third of the way to white, comes out near
     #425276, picked out rather than painted. */
  const LIT_ALIGNING = new THREE.Color(1.5, 1.5, 1.55);
  const LIT_LOCKED = new THREE.Color(0.78, 1.18, 2.5);
  const WHITE = new THREE.Color(1, 1, 1);

  const aimBand = makeRibbon(TRIM, 0, 0.55);
  aimBand.material.uniforms.uReach.value = 0.84;
  aimBand.renderOrder = 3;
  scene.add(aimBand);

  /* What stands at a target, from the field's collision map: a HUB is a structure, lit where it stands;
     anything else - FUEL lobbed to a point in the alliance zone, while the HUB is off - is a place on the
     carpet, marked there the way Autopark marks the space it is going to. Without the map every target is
     taken for a structure. */
  let heights = null;
  const standing = new Map();
  function standsAt(tx, tz) {
    if (!heights) return true;
    const key = `${tx.toFixed(2)} ${tz.toFixed(2)}`;
    if (standing.has(key)) return standing.get(key);
    const fx = tx + poseLength / 2;
    const fy = -tz + poseWidth / 2;
    let top = 0;
    for (let x = fx - 0.65; x <= fx + 0.65 + 1e-9; x += heights.cell) {
      for (let y = fy - 0.65; y <= fy + 0.65 + 1e-9; y += heights.cell) {
        const c = Math.floor(x / heights.cell);
        const r = Math.floor(y / heights.cell);
        if (c < 0 || r < 0 || c >= heights.cols || r >= heights.rows) continue;
        top = Math.max(top, heights.mm[r * heights.cols + c]);
      }
    }
    if (standing.size > 64) standing.clear();
    standing.set(key, top > 900);
    return top > 900;
  }

  /* Without the field model there is no HUB to light, and its opening is outlined instead. */
  const overlay = () => new THREE.MeshBasicMaterial({
    color: TRIM, transparent: true, opacity: 0, depthWrite: false, depthTest: false, toneMapped: false,
    side: THREE.DoubleSide, fog: false,
  });
  const lying = (geometry) => {
    const mesh = new THREE.Mesh(geometry, overlay());
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 5;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  };
  const openingFill = lying(new THREE.CircleGeometry(OPENING_RADIUS, 64));
  const openingRim = lying(new THREE.RingGeometry(OPENING_RADIUS - 0.09, OPENING_RADIUS, 64));
  /* A place on the carpet: a ring lying on it, hidden by whatever stands in front of it as the carpet is. */
  const SPOT_RADIUS = 0.42;
  const spotFill = lying(new THREE.CircleGeometry(SPOT_RADIUS - 0.07, 64));
  const spotRim = lying(new THREE.RingGeometry(SPOT_RADIUS - 0.07, SPOT_RADIUS, 64));
  for (const mesh of [spotFill, spotRim]) {
    mesh.material.depthTest = true;
    mesh.renderOrder = 3;
  }

  let aimInfo = null;       // { state, target: [x, z], aimPoint: [x, z], headingErrorDeg } in the scene
  let aimShown = null;      // the last aim drawn, kept while it fades out
  let aimFade = 0;
  let aimLock = 0;          // grey 0 to blue 1
  let aimReach = 0;         // how much of the way to its end the band reaches, 0 to 1
  let lockedAt = -Infinity;
  let lastAimState = "IDLE";
  const aimColour = new THREE.Color();

  function placeAim(dt, now) {
    const want = aimInfo && robot.visible && !unplaced && model.root.visible ? 1 : 0;
    const ease = (value, goal, seconds) => {
      const next = reduced ? goal : goal + (value - goal) * Math.exp(-dt / seconds);
      return Math.abs(next - goal) < 0.002 ? goal : next;
    };
    aimFade = ease(aimFade, want, 0.14);
    if (aimInfo) aimShown = aimInfo;
    const info = aimShown;
    const visible = Boolean(aimFade > 0 && info);
    aimBand.visible = visible;
    if (!visible) {
      openingFill.visible = false;
      openingRim.visible = false;
      spotFill.visible = false;
      spotRim.visible = false;
      carveUniforms.uLitTint.value.copy(WHITE);
      carveUniforms.uLitHalf.value = 0;
      carveUniforms.uAimAmount.value = 0;
      lastAimState = "IDLE";
      aimReach = 0;
      aimLock = 0;
      return false;
    }
    const [tx, tz] = info.target;
    const [ax, az] = info.aimPoint;
    const locked = info.state === "ALIGNED" || info.state === "SOTF";
    if (locked && lastAimState !== "ALIGNED" && lastAimState !== "SOTF") lockedAt = now;
    lastAimState = info.state;

    /* Grey to blue, and how far the band reaches: most of the way once the heading error is small, all of
       it once locked. Without an error to go on it simply reaches. */
    aimLock = ease(aimLock, locked ? 1 : 0, 0.1);
    const error = Number.isFinite(info.headingErrorDeg) ? Math.abs(info.headingErrorDeg) : null;
    const reachGoal = locked || error === null ? 1 : 0.45 + 0.5 * (1 - Math.min(1, error / 45));
    aimReach = ease(aimReach, reachGoal, 0.16);
    aimColour.copy(AIM_GREY).lerp(AIM_BLUE, aimLock);
    const since = (now - lockedAt) / 1000;
    const pulsing = !reduced && locked && since >= 0 && since < AIM_PULSE_S;
    const late = since / AIM_PULSE_S - 0.85;
    const arrival = pulsing ? Math.exp(-(late * late) / 0.015) : 0;

    /* The target: a structure lit where it stands - or with no field model to light, its opening outlined -
       or a place on the carpet ringed. */
    const structure = standsAt(tx, tz);
    const modelled = cad.children.length > 0;
    carveUniforms.uLitCentre.value.set(tx, 0, tz);
    carveUniforms.uLitHalf.value = structure && modelled ? TARGET_HALF : 0;
    carveUniforms.uLitTint.value.copy(LIT_ALIGNING).lerp(LIT_LOCKED, aimLock).multiplyScalar(1 + 0.3 * arrival).lerp(WHITE, 1 - aimFade);
    spotRim.visible = !structure;
    spotFill.visible = !structure;
    if (!structure) {
      spotRim.position.set(tx, 0.016, tz);
      spotRim.material.color.copy(aimColour);
      spotRim.material.opacity = aimFade * (0.45 + 0.5 * aimLock);
      spotFill.position.set(tx, 0.015, tz);
      spotFill.material.color.copy(aimColour);
      spotFill.material.opacity = aimFade * aimLock * (0.16 + 0.22 * arrival);
    }
    openingRim.visible = structure && !modelled;
    openingFill.visible = structure && !modelled;
    if (structure && !modelled) {
      openingRim.position.set(tx, OPENING_HEIGHT + 0.02, tz);
      openingRim.material.color.copy(aimColour);
      openingRim.material.opacity = aimFade * (0.5 + 0.45 * aimLock);
      openingFill.position.set(tx, OPENING_HEIGHT + 0.019, tz);
      openingFill.material.color.copy(aimColour);
      openingFill.material.opacity = aimFade * aimLock * (0.2 + 0.25 * arrival);
    }

    /* The band, to just off the target's face - or toward the point the robot leads, while it does. */
    const leading = info.state === "SOTF" && Math.hypot(ax - tx, az - tz) > 0.08;
    const ex = leading ? ax : tx;
    const ez = leading ? az : tz;
    const dx = ex - robot.position.x;
    const dz = ez - robot.position.z;
    const span = Math.hypot(dx, dz) || 1;
    const length = Math.max(0.3, span - (structure ? TARGET_FACE : SPOT_RADIUS + 0.06)) * aimReach;
    const endX = robot.position.x + (dx / span) * length;
    const endZ = robot.position.z + (dz / span) * length;
    layRibbon(aimBand, [[robot.position.x, robot.position.z], [endX, endZ]], 0.24, 0.018);
    carveUniforms.uAimFrom.value.set(robot.position.x, robot.position.z);
    carveUniforms.uAimTo.value.set(endX, endZ);
    carveUniforms.uAimAmount.value = aimFade;
    const uniforms = aimBand.material.uniforms;
    uniforms.uColor.value.copy(aimColour);
    uniforms.uOpacity.value = aimFade * (0.32 + 0.58 * aimLock);
    uniforms.uChevrons.value = info.state === "SOTF" ? 1 : 0;
    if (info.state === "SOTF" && !reduced) uniforms.uTime.value = (uniforms.uTime.value + dt) % 1200;
    uniforms.uPulse.value = pulsing ? Math.min(1, since / (AIM_PULSE_S * 0.85)) : -1;

    return aimFade !== want || pulsing || aimLock !== (locked ? 1 : 0) || aimReach !== reachGoal || info.state === "SOTF";
  }

  const PLANNED_OPACITY = 0.9;
  const MOTION_OPACITY = 0.8;
  /* The fade's time constant: most of the way in about half a second. */
  const PATH_FADE_S = 0.16;
  const plannedBand = makeRibbon(SIGNAL, PLANNED_OPACITY, 0.7);
  const motionLine = makeRibbon(TRIM, MOTION_OPACITY, 0.3);
  scene.add(plannedBand, motionLine);
  let plan = null;          // { points: [[x, z], ...] in the scene, improvised }
  let travelTurn = 0;       // how fast the direction of travel is turning, rad/s
  const PREDICT_S = 1.6;
  const PREDICT_MIN_SPEED = 0.25;

  /* The part of the plan still ahead of the robot, starting from the robot itself. A plan the robot is
     nowhere near is drawn from its own start instead, rather than with a line to wherever it is. */
  function planAhead(points) {
    const rx = robot.position.x;
    const rz = robot.position.z;
    let nearest = 0;
    let nearestDistance = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = (points[i][0] - rx) ** 2 + (points[i][1] - rz) ** 2;
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = i;
      }
    }
    const onIt = nearestDistance < 1.2 * 1.2;
    let start = nearest;
    if (onIt && nearest < points.length - 1) {
      const [ax, az] = points[nearest];
      const [bx, bz] = points[nearest + 1];
      const t = ((rx - ax) * (bx - ax) + (rz - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2 || 1);
      if (t > 0) start = nearest + 1;
    }
    const out = onIt ? [[rx, rz]] : [];
    const remaining = points.length - start;
    const step = Math.max(1, Math.ceil(remaining / (PATH_POINTS - 1)));
    for (let i = start; i < points.length; i += step) out.push(points[i]);
    if ((points.length - 1 - start) % step !== 0) out.push(points[points.length - 1]);
    return out;
  }

  /* Where the robot's own motion takes it over the next moment: its direction of travel, turning at
     the rate it has been turning. */
  function motionAhead() {
    const out = [[robot.position.x, robot.position.z]];
    let x = robot.position.x;
    let z = robot.position.z;
    let direction = Math.atan2(reported.vz, reported.vx);
    const speed = Math.hypot(reported.vx, reported.vz);
    const steps = 26;
    const dt = PREDICT_S / steps;
    for (let i = 0; i < steps; i++) {
      direction += travelTurn * dt;
      x += Math.cos(direction) * speed * dt;
      z += Math.sin(direction) * speed * dt;
      out.push([x, z]);
    }
    return out;
  }

  /* How far the paths are faded in. They come up after the robot has landed on this view from the Park
     stage, as the last thing to arrive, and go as it lifts off again, instead of appearing or vanishing
     in the very frame the robot changes hands. */
  let pathFade = 0;

  /** Lay the bands for this frame. Returns true while the chevrons are drifting or the bands fading. */
  function placePaths(dt) {
    const driving = robot.visible && !unplaced && !parked && model.root.visible;
    const want = driving ? 1 : 0;
    pathFade = reduced ? want : want + (pathFade - want) * Math.exp(-dt / PATH_FADE_S);
    if (Math.abs(want - pathFade) < 0.004) pathFade = want;
    plannedBand.material.uniforms.uOpacity.value = PLANNED_OPACITY * pathFade;
    motionLine.material.uniforms.uOpacity.value = MOTION_OPACITY * pathFade;
    const shown = pathFade > 0 && robot.visible && !unplaced;
    let drifting = pathFade !== want;
    const arriving = shown && plan && plan.end;
    if (arriving) {
      const spec = model.spec;
      shapeDestination(spec ? spec.bumperLength : 0.9, spec ? spec.bumperWidth : 0.9);
      destination.position.set(plan.end[0], 0.014, plan.end[1]);
      destination.rotation.y = plan.end[2];
    }
    destinationMaterial.opacity = 0.55 * pathFade;
    destination.visible = Boolean(arriving) && pathFade > 0;
    if (shown && plan) {
      layRibbon(plannedBand, planAhead(plan.points), 0.32, 0.012);
      const uniforms = plannedBand.material.uniforms;
      uniforms.uChevrons.value = plan.improvised ? 1 : 0;
      if (plan.improvised && plannedBand.visible && !reduced) {
        uniforms.uTime.value = (uniforms.uTime.value + dt) % 1200;
        drifting = true;
      }
    } else {
      plannedBand.visible = false;
    }
    const speed = reported ? Math.hypot(reported.vx, reported.vz) : 0;
    if (shown && speed > PREDICT_MIN_SPEED) layRibbon(motionLine, motionAhead(), 0.05, 0.016);
    else motionLine.visible = false;
    return drifting;
  }

  /* ---- camera ---- */

  let mode = "chase";
  const target = new THREE.Vector3(0, 0, 0);
  const desired = new THREE.Vector3(0, 10, 12);
  const look = new THREE.Vector3(0, 0, 0);
  let orbit = { yaw: -Math.PI / 2, pitch: 0.72, dist: Math.max(length, width) * 0.85 };

  /* The following camera, held as a bearing, elevation and distance about its look point in the
     robot's frame, and turned by `cameraHeading`, which trails the robot's own heading. Easing those
     rather than a position is what makes the camera swing round the robot when it goes from parked to
     driving, instead of cutting straight across the carpet. */
  let rel = null;
  let relSpeed = null;
  let cameraHeading = 0;
  let headingSpeed = 0;
  let aimHeld = 0;
  const stillRel = () => ({ bearing: 0, elevation: 0, r: 0, look: [0, 0, 0] });

  /* How far the chase camera has swung away from directly behind the robot to see past something.
     Eased, never snapped: a camera that jumps the instant a truss clips the sight line is more
     disorienting than the obstruction was. */
  let chaseSwing = 0;
  let swingTarget = 0;
  let lastOcclusionCheck = 0;
  const occluder = new THREE.Raycaster();
  const CANDIDATE_SWINGS = [0, 0.55, -0.55, 1.15, -1.15, 1.9, -1.9, Math.PI];

  /** True when something solid sits between a chase camera swung by `swing` and the robot. */
  function blockedAt(swing) {
    const eye = turnY(CHASE_EYE, robot.rotation.y + swing);
    const from = new THREE.Vector3(robot.position.x + eye[0], eye[1], robot.position.z + eye[2]);
    const toRobot = robot.position.clone().add(new THREE.Vector3(0, 0.25, 0)).sub(from);
    const distance = toRobot.length();
    occluder.set(from, toRobot.normalize());
    occluder.far = distance - 0.6;   // stop short so the robot itself never counts as the blocker
    return occluder.intersectObject(cad, true).length > 0;
  }

  /* Only meaningful once the CAD is loaded — the procedural outline has nothing tall enough to hide
     behind, and raycasting against it every frame would be work for no answer. */
  function updateOcclusion(now) {
    if (!cad.visible || !robot.visible || mode !== "chase" || parked) { swingTarget = 0; return; }
    if (now - lastOcclusionCheck < 250) return;   // four times a second is plenty and costs nothing
    lastOcclusionCheck = now;

    // Keep the current angle if it still works, so the camera settles instead of hunting.
    if (!blockedAt(swingTarget)) return;
    for (const swing of CANDIDATE_SWINGS) {
      if (!blockedAt(swing)) { swingTarget = swing; return; }
    }
    swingTarget = 0;   // boxed in on every side: stay put rather than spin
  }

  /* Overhead height that just fits the field, accounting for aspect so it does not crop on a narrow
     tile. Recomputed on resize because tiles get dragged around. */
  function topHeight() {
    const fov = (camera.fov * Math.PI) / 180;
    const byWidth = width / 2 / Math.tan(fov / 2);
    const byLength = length / 2 / Math.tan(fov / 2) / Math.max(0.2, camera.aspect);
    return Math.max(byWidth, byLength) * 1.08;
  }

  /** The shot the following camera wants, as polar coordinates in the robot's frame. */
  function wantedRel(aimed) {
    if (parked) return polar(PARKED_EYE, PARKED_LOOK);
    if (aimed) {
      /* Aiming: pulled up and back until the robot and what it aims at are both in the picture, the robot in
         the lower half and the target in the upper half, clear of the figures over the top of the panel -
         further back the further away the target is. High, because behind a robot that is shooting there is
         often something tall, its own alliance's wall or the other HUB, that a lower camera would be looking
         through. */
      const range = Math.hypot(aimed.target[0] - robot.position.x, aimed.target[1] - robot.position.z);
      const look = [Math.min(range * 0.5, 4), 0.45, 0];
      const distance = Math.max(6.5, Math.min(12, 5.5 + range * 0.95));
      const elevation = 0.6;
      return polar([look[0] - Math.cos(elevation) * distance, look[1] + Math.sin(elevation) * distance, 0], look);
    }
    const eye = turnY(CHASE_EYE, chaseSwing);
    const lookAt = turnY(CHASE_LOOK, chaseSwing);
    return polar(eye, lookAt);
  }

  /** The camera's present position as polar coordinates in the robot's frame, to ease on from. */
  function relFromCamera() {
    const eye = turnY([camera.position.x - robot.position.x, camera.position.y, camera.position.z - robot.position.z], -cameraHeading);
    const lookAt = turnY([target.x - robot.position.x, target.y, target.z - robot.position.z], -cameraHeading);
    return polar(eye, lookAt);
  }

  /** Move the camera one step toward where it wants to be. Returns true while it is still moving. */
  function placeCamera(dt) {
    let moving = false;
    swingTarget = parked ? 0 : swingTarget;
    // Swing eases more slowly still — this one is a deliberate move around an obstruction, and it
    // should read as the camera choosing a better angle rather than as a glitch.
    const swingStep = (swingTarget - chaseSwing) * (1 - Math.exp(-dt * 2.2));
    chaseSwing += swingStep;
    if (Math.abs(swingTarget - chaseSwing) > 1e-3) moving = true;

    if (mode === "chase" && robot.visible) {
      /* While the robot aims, the camera looks where it aims: from behind the robot, over it, at the HUB.
         A robot that shoots out of its back faces away from its target, and a camera following its
         heading would watch the balls fly at the lens with the target behind it. The swing round is
         slower than a turn, so it reads as the camera choosing the shot. */
      aimHeld = aimInfo && !parked ? AIM_HOLD_S : parked ? 0 : Math.max(0, aimHeld - dt);
      const aimed = aimHeld > 0 ? aimInfo ?? aimShown : null;
      if (aimed && aimHeld < AIM_HOLD_S) moving = true;
      /* Toward the middle of the HUB and the point the robot leads, so both of their marks are in frame. */
      const aimX = aimed ? (aimed.target[0] + aimed.aimPoint[0]) / 2 : 0;
      const aimZ = aimed ? (aimed.target[1] + aimed.aimPoint[1]) / 2 : 0;
      const reference = aimed ? Math.atan2(-(aimZ - robot.position.z), aimX - robot.position.x) : robot.rotation.y;
      /* A spring on the heading, its offset measured the short way round. */
      const turn = -angleTo(cameraHeading, reference);
      if (reduced) {
        cameraHeading -= turn;
        headingSpeed = 0;
      } else {
        const [next, speed] = spring(turn, headingSpeed, aimed ? AIM_TURN_RATE : CAMERA_TURN_RATE, dt);
        cameraHeading += next - turn;
        headingSpeed = speed;
      }
      if (Math.abs(angleTo(cameraHeading, reference)) > 1e-3 || Math.abs(headingSpeed) > 1e-3) moving = true;

      const want = wantedRel(aimed);
      if (!rel) {
        rel = relFromCamera();
        relSpeed = stillRel();
      }
      /* The same spring on each part of the shot: its bearing, its elevation, its distance - in proportion,
         so a close shot and a far one close at the same pace - and the point it looks at. */
      const ease = (offset, key, index) => {
        if (reduced) return 0;
        const velocity = index === undefined ? relSpeed[key] : relSpeed[key][index];
        const [next, speed] = spring(offset, velocity, CAMERA_SWING_RATE, dt);
        if (index === undefined) relSpeed[key] = speed;
        else relSpeed[key][index] = speed;
        if (Math.abs(next) > 1e-3 || Math.abs(speed) > 1e-3) moving = true;
        return next;
      };
      for (let i = 0; i < 3; i++) rel.look[i] = want.look[i] + ease(rel.look[i] - want.look[i], "look", i);
      rel.bearing = want.bearing + ease(-angleTo(rel.bearing, want.bearing), "bearing");
      rel.elevation = want.elevation + ease(rel.elevation - want.elevation, "elevation");
      rel.r = want.r * Math.exp(ease(Math.log(rel.r / want.r), "r"));

      const flat = Math.cos(rel.elevation) * rel.r;
      const eye = turnY([rel.look[0] + Math.sin(rel.bearing) * flat, rel.look[1] + Math.sin(rel.elevation) * rel.r, rel.look[2] + Math.cos(rel.bearing) * flat], cameraHeading);
      const lookAt = turnY(rel.look, cameraHeading);
      camera.position.set(robot.position.x + eye[0], eye[1], robot.position.z + eye[2]);
      target.set(robot.position.x + lookAt[0], lookAt[1], robot.position.z + lookAt[2]);
      camera.lookAt(target);
      return moving;
    }

    rel = null;
    if (mode === "top") {
      desired.set(0, topHeight(), 0.01);
      look.set(0, 0, 0);
    } else if (mode === "chase") {
      /* No robot to follow: a view down the field from above the blue end. */
      desired.set(-length * 0.34, 7.0, width * 1.05);
      look.set(0, 0, 0);
    } else {
      desired.set(
        Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * orbit.dist,
        Math.sin(orbit.pitch) * orbit.dist,
        Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * orbit.dist
      );
      look.set(0, 0, 0);
    }
    /* Exponential approach: fast enough to keep up with a robot, smooth enough not to be a strobe. */
    const k = reduced ? 1 : 1 - Math.exp(-dt * (mode === "top" ? 6 : 4));
    camera.position.lerp(desired, k);
    target.lerp(look, k);
    camera.lookAt(target);
    return camera.position.distanceTo(desired) > 1e-3 || target.distanceTo(look) > 1e-3;
  }

  /* The fog starts a little way past what the camera is looking at, so whatever the camera is framed on
     is never dimmed and everything beyond it falls away. */
  function placeFog() {
    const distance = camera.position.distanceTo(target);
    scene.fog.near = distance + 5;
    scene.fog.far = distance + 26;
  }

  /* Drag to orbit, wheel to zoom — only meaningful in free mode, and harmless elsewhere. */
  let dragging = false;
  let last = { x: 0, y: 0 };
  canvas.addEventListener("pointerdown", (e) => {
    if (mode !== "free") return;
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    orbit.yaw -= (e.clientX - last.x) * 0.006;
    orbit.pitch = Math.max(0.08, Math.min(1.45, orbit.pitch + (e.clientY - last.y) * 0.005));
    last = { x: e.clientX, y: e.clientY };
    dirty = true;
  });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener("wheel", (e) => {
    if (mode !== "free") return;
    e.preventDefault();
    orbit.dist = Math.max(4, Math.min(48, orbit.dist * (1 + Math.sign(e.deltaY) * 0.09)));
    dirty = true;
  }, { passive: false });

  /* ---- sizing ---- */

  let sized = { w: 0, h: 0 };
  function resize() {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (w === sized.w && h === sized.h) return;
    sized = { w, h };
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  /* ---- loop ---- */

  let raf = 0;
  let lastFrame = -Infinity;
  let lockedUntil = -Infinity;
  let disposed = false;
  let dirty = true;
  let moving = false;

  /* Kick the model load off now. It is deliberately not awaited: the outline is already on screen and
     the field must never be blank while a 6 MB file decodes. */
  loadFieldModel()
    .then((ok) => { if (ok && !disposed) opts.onModel?.(true); })
    .catch((err) => console.warn("field model unavailable, keeping the outline", err));

  function visible() {
    /* Cheapest possible test, and the one that matters: is the dashboard tab even showing? */
    if (document.hidden) return false;
    const view = canvas.closest(".view");
    if (view && view.dataset.active !== "true") return false;
    return canvas.clientWidth > 0 && canvas.clientHeight > 0;
  }

  function render(now, dt) {
    resize();
    updateOcclusion(now);
    const robotMoving = stepRobot(dt, now);
    /* The robot's motion in its own frame, for the swerve modules to follow when it does not publish them. */
    if (reported) {
      const c = Math.cos(shown.heading);
      const s = Math.sin(shown.heading);
      const vx = reported.vx;
      const vy = -reported.vz;
      model.setMotion(c * vx + s * vy, -s * vx + c * vy, reported.vh);
    } else {
      model.setMotion(0, 0, 0);
    }
    const cameraMoving = placeCamera(dt);
    const modelMoving = model.step(now);
    /* The clearing follows the drawn robot and the lens, and fades in and out with the robot. */
    const clearing = robot.visible && !unplaced ? 1 : 0;
    const amount = carveUniforms.uCarveAmount;
    amount.value += (clearing - amount.value) * (reduced ? 1 : 1 - Math.exp(-dt * 5));
    if (Math.abs(clearing - amount.value) < 1e-3) amount.value = clearing;
    carveUniforms.uCarveRobot.value.copy(robot.position);
    carveUniforms.uCarveEye.value.copy(camera.position);
    const clearingMoving = amount.value !== clearing;
    const pathsMoving = placePaths(dt);
    const aimMoving = placeAim(dt, now);
    if (!environment) {
      /* The studio reflections the robot's metal needs, rendered once for this renderer. */
      environment = studioEnvironment(renderer);
      model.setEnvironment(environment.texture);
    }
    volley(now);
    while (launches.length && launches[0].at <= now) launchBall(launches.shift(), now);
    const shotsMoving = shots.step(now);
    draw();
    moving = robotMoving || cameraMoving || modelMoving || clearingMoving || pathsMoving || shotsMoving || launches.length > 0 || queued > 0 || aimMoving;
    dirty = false;
  }

  /* The field, then the robot over it (see robotScene). */
  function draw() {
    placeFog();
    /* The studio faces the lens, as it does on the Park stage. */
    model.aim(Math.atan2(camera.position.x - target.x, camera.position.z - target.z));
    renderer.autoClear = true;
    renderer.render(scene, camera);
    renderer.autoClear = false;
    renderer.render(robotScene, camera);
    renderer.autoClear = true;
  }

  function tick(now) {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    if (!visible()) return;
    /* While the Park stage is flying the robot here it draws this view's frames itself (see frame), and
       this loop stands aside. It takes over again on its own if those frames stop coming. */
    if (now < lockedUntil) return;
    const elapsed = now - lastFrame;
    /* Two milliseconds of slack, so a 60 Hz display's frames are not dropped for arriving a hair
       early. */
    if (elapsed < (moving || dirty ? FRAME_MS : IDLE_REFRESH_MS) - 2) return;
    lastFrame = now;
    render(now, Math.min(0.1, elapsed / 1000));
  }
  raf = requestAnimationFrame(tick);

  /* ---- public surface ---- */

  let lastTrailAt = 0;

  return {
    /**
     * `state.pose` is `[x, y, theta]` in WPILib field coordinates, or null when unknown. `state.alliance`
     * colours the bumpers, `state.enabled` chooses between the parked and the driving camera, and
     * `state.spec` and `state.team` are the robot's spec sheet and number, as Park takes them.
     */
    update(state) {
      /* Sizing lives here as well as in the loop. `ResizeObserver` only delivers during a rendering
         opportunity, so a tile that was laid out while the window was hidden would otherwise keep a
         stale backing-store size until the next animation frame. */
      resize();

      if (state.spec !== undefined && model.setSpec(state.spec)) dirty = true;
      if (state.team !== undefined) model.setTeamNumber(state.team);
      if (state.mechanisms !== undefined || state.hopper !== undefined) {
        if (model.setMechanisms(state.mechanisms ?? null, state.hopper ?? null)) dirty = true;
      }
      if (model.setAlliance(state.alliance, !reduced && robot.visible)) dirty = true;
      if (typeof state.enabled === "boolean" && parked === state.enabled) {
        parked = !state.enabled;
        dirty = true;
      }
      if (state.path !== undefined) {
        /* The plan in field metres, into the scene's frame once here rather than every frame. */
        const points = state.path && Array.isArray(state.path.points) ? state.path.points : null;
        plan = points && points.length >= 2
          ? {
              points: points.map(([fx, fy]) => [fx - poseLength / 2, -(fy - poseWidth / 2)]),
              end: Array.isArray(state.path.end)
                ? [state.path.end[0] - poseLength / 2, -(state.path.end[1] - poseWidth / 2), state.path.end[2]]
                : null,
              improvised: state.path.style === "improvised",
            }
          : null;
        dirty = true;
      }

      if (state.mechanisms !== undefined) mechanisms = state.mechanisms;
      if (state.aim !== undefined) {
        const toScene = ([fx, fy]) => [fx - poseLength / 2, -(fy - poseWidth / 2)];
        const next = state.aim
          ? { ...state.aim, target: toScene(state.aim.target), aimPoint: toScene(state.aim.aimPoint) }
          : null;
        if (Boolean(next) !== Boolean(aimInfo) || next?.state !== aimInfo?.state) dirty = true;
        aimInfo = next;
      }
      if (Number.isFinite(state.fired)) {
        if (firedSeen === null || state.fired < firedSeen) {
          /* First sight, or a new count: nothing to launch for balls that left before this view was
             watching. */
          firedSeen = state.fired;
        } else if (state.fired > firedSeen) {
          /* Queued for the volleys, and never more than a couple of volleys behind: a tab that was hidden
             does not come back to a minute of shooting to catch up on. */
          queued = Math.min(queued + state.fired - firedSeen, SHOOTER_LANES * 3);
          firedSeen = state.fired;
          dirty = true;
        }
      }

      if (!state.pose && state.placed === false) {
        /* On the link but not on the field yet: the robot on its own stage, facing the way its gyro
           says. */
        const heading = Number.isFinite(state.heading) ? state.heading : 0;
        setUnplaced(true);
        if (!robot.visible) {
          cameraHeading = heading;
          headingSpeed = 0;
          rel = null;
        }
        robot.visible = true;
        shown.x = 0;
        shown.z = 0;
        shown.heading = heading;
        reported = { x: 0, z: 0, heading, vx: 0, vz: 0, vh: 0, at: performance.now() };
        robot.position.set(0, 0, 0);
        robot.rotation.y = heading;
        pool.position.set(0, 0.001, 0);
        dirty = true;
        return;
      }
      if (!state.pose) {
        if (robot.visible) dirty = true;
        robot.visible = false;
        reported = null;
        setUnplaced(false);
        return;
      }
      if (unplaced) {
        /* Just placed: the field comes back, and the robot is put where it is rather than sliding
           there from the stage. */
        setUnplaced(false);
        reported = null;
      }
      const [fx, fy, theta] = state.pose;
      const x = fx - poseLength / 2;
      const z = -(fy - poseWidth / 2);
      /* WPILib's heading turns counter-clockwise seen from above, and field y is three's -z, so the
         heading is three's rotation about y unchanged. (It used to be negated, which drew every robot
         mirrored: turning left on the field, it turned right on screen.) */
      const heading = theta;
      const now = performance.now();

      if (!reported || !robot.visible || Math.hypot(x - shown.x, z - shown.z) > TELEPORT_M) {
        /* First sight of the robot, or a pose reset: put it there. */
        shown.x = x;
        shown.z = z;
        shown.heading = heading;
        reported = { x, z, heading, vx: 0, vz: 0, vh: 0, at: now };
        if (!robot.visible) {
          cameraHeading = heading;
          headingSpeed = 0;
          rel = null;
        }
        robot.visible = true;
        robot.position.set(x, 0, z);
        robot.rotation.y = heading;
        dirty = true;
      } else if (x !== reported.x || z !== reported.z || heading !== reported.heading) {
        const gap = (now - reported.at) / 1000;
        const fresh = gap > 0.01 && gap < 0.5;
        const blend = (old, measured) => (fresh ? old * 0.4 + measured * 0.6 : 0);
        const vx = blend(reported.vx, (x - reported.x) / gap);
        const vz = blend(reported.vz, (z - reported.z) / gap);
        /* How fast the direction of travel is turning, for the motion line. Not the heading's rate: a
           swerve robot can spin while it drives straight. */
        if (fresh && Math.hypot(vx, vz) > PREDICT_MIN_SPEED && Math.hypot(reported.vx, reported.vz) > PREDICT_MIN_SPEED) {
          const rate = angleTo(Math.atan2(reported.vz, reported.vx), Math.atan2(vz, vx)) / gap;
          travelTurn = travelTurn * 0.6 + Math.max(-3, Math.min(3, rate)) * 0.4;
        } else {
          travelTurn = 0;
        }
        reported = {
          x,
          z,
          heading,
          vx,
          vz,
          vh: blend(reported.vh, angleTo(reported.heading, heading) / gap),
          at: now,
        };
        dirty = true;
      } else if (now - reported.at > 150 && (reported.vx || reported.vz || reported.vh)) {
        /* The same pose twice, a while apart: the robot has stopped, so stop carrying it forward. */
        reported = { ...reported, vx: 0, vz: 0, vh: 0, at: now };
        dirty = true;
      }

      /* Sample the trail on distance, not on time: a stationary robot should not stack 200 points on
         top of itself, and a fast one should not leave gaps. */
      if (now - lastTrailAt > 40) {
        lastTrailAt = now;
        pushTrail(x, z);
      }
    },

    setMode(next) {
      if (mode !== next) {
        mode = next;
        rel = null;
        dirty = true;
      }
    },

    /**
     * The camera's view of the robot right now, for handing to the Park stage: `{ eye, look, fov }`
     * with eye and look as [x, y, z] in the robot's own frame (x front, y up, z right, the floor under
     * its centre at the origin). Null when there is no robot on the field to hand over.
     */
    shot() {
      if (disposed || !robot.visible) return null;
      robot.updateMatrixWorld();
      const inverse = robot.matrixWorld.clone().invert();
      const eye = camera.position.clone().applyMatrix4(inverse);
      const lookAt = target.clone().applyMatrix4(inverse);
      return { eye: eye.toArray(), look: lookAt.toArray(), fov: camera.fov };
    },

    /**
     * Put the robot on its latest pose and the camera where it is heading, at once, and draw. Used when
     * the Park stage is about to hand the robot over, so the shot it lands on is the one this view will
     * be showing.
     */
    settle() {
      if (disposed) return;
      resize();
      if (reported) {
        shown.x = reported.x;
        shown.z = reported.z;
        shown.heading = reported.heading;
        robot.position.set(shown.x, 0, shown.z);
        robot.rotation.y = shown.heading;
      }
      aimHeld = aimInfo && !parked ? AIM_HOLD_S : 0;
      const aimed = aimHeld > 0 ? aimInfo : null;
      cameraHeading = aimed
        ? Math.atan2(-((aimed.target[1] + aimed.aimPoint[1]) / 2 - robot.position.z), (aimed.target[0] + aimed.aimPoint[0]) / 2 - robot.position.x)
        : robot.rotation.y;
      headingSpeed = 0;
      chaseSwing = swingTarget;
      if (mode === "chase" && robot.visible) {
        rel = wantedRel(aimed);
        relSpeed = stillRel();
      }
      model.settle();
      /* A step long enough for every eased value to land where it is heading. */
      placeCamera(10);
      draw();
      dirty = false;
      moving = false;
    },

    /**
     * Draw this view's frame for `now` from someone else's animation frame, and hold the view's own loop
     * off while they keep doing so. The Park stage calls it at the start of each frame of a flight to or
     * from this view, so the field under the flying robot and the shot the robot is flying to move in
     * step, frame for frame, at whatever rate the display runs. If the calls stop the loop resumes by
     * itself within a few frames.
     */
    frame(now = performance.now()) {
      if (disposed) return;
      const elapsed = now - lastFrame;
      lastFrame = now;
      lockedUntil = now + 60;
      render(now, Math.min(0.1, Math.max(0, elapsed) / 1000));
    },

    /** Show or hide the robot model while leaving everything else as it is, for the instant the Park
     *  stage is drawing the robot in its place. */
    setRobotShown(show) {
      if (disposed) return;
      if (model.root.visible !== Boolean(show)) {
        model.root.visible = Boolean(show);
        dirty = true;
      }
    },

    /** Swing the camera in from high above the robot, for coming back to the board without the Park
     *  stage to hand over from. */
    arrive() {
      if (disposed) return;
      const at = robot.visible ? robot.position : new THREE.Vector3(0, 0, 0);
      camera.position.set(at.x - 1.5, 17, at.z + 3);
      target.set(at.x, 0, at.z);
      camera.lookAt(target);
      rel = null;
      dirty = true;
    },

    /** Draw one frame right now. Used when the dashboard tab comes back, so the field is current the
     *  instant it is on screen rather than one animation frame later. */
    redraw() {
      if (disposed) return;
      render(performance.now(), 1 / 60);
    },

    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      model.dispose();
      shots.dispose();
      scene.traverse((obj) => {
        obj.geometry?.dispose?.();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material?.dispose?.();
      });
      environment?.dispose();
      renderer.dispose();
      /* Release the GL context outright. Browsers cap how many a page may hold, and a driver who
         rearranges their layout a dozen times should not hit that cap. */
      renderer.forceContextLoss?.();
    },
  };
}
