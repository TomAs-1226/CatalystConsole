/* The driver, for the driver profiles in Settings.
 *
 * A grey figure walks on from the left, plants its last step, and folds its arms - the way a driver
 * walks onto the grid before a race and stands beside the car. It is there for the same reason the
 * Park stage draws the robot rather than listing its dimensions: a profile is a person, and a person
 * reads faster than a name in a list. The suit takes the profile's colour, so switching profiles is a
 * thing you watch happen rather than a radio button.
 *
 * Nothing here is loaded from a file. The figure is built out of lathes and spheres at a person's
 * proportions, about ten thousand triangles - the same order as one of the robot's mechanisms - which
 * keeps it smooth at the size it is drawn and costs a fraction of what a downloaded character would.
 *
 * `driverPose` is the whole choreography and is pure: a time in seconds goes in, every joint angle
 * comes out. It is separated from the drawing so the timing can be tested without a canvas, and so a
 * pose can be read at any moment rather than only played forward.
 *
 * Frame: x is the way the figure walks and faces, y up, z its right. Metres and radians.
 */

import * as THREE from "./vendor/three.module.min.js";

export const DRIVER_HEIGHT_M = 1.78;

/* The walk-on, in seconds from the start. */
export const WALK_S = 2.4;
export const SETTLE_S = 0.55;
export const FOLD_S = 0.85;
export const ARRIVED_S = WALK_S + SETTLE_S;
export const POSED_S = ARRIVED_S + FOLD_S;

/* Where the figure walks in from, and how far it covers in one stride of each leg. */
const FROM_X = -2.15;
const STRIDE_M = 0.68;

/* The gait, in radians. A walk is a small thing: thirty degrees of thigh is a stride, not a march. */
const HIP_SWING = 0.52;
const KNEE_SWING = 0.78;
const ANKLE_SWING = 0.22;
const ARM_SWING = 0.4;
const ELBOW_WALK = 0.34;
const BOB_M = 0.022;
const LEAN = 0.05;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (u) => {
  const x = clamp01(u);
  return x * x * (3 - 2 * x);
};
/* Arriving: fast at first, still at the end, with no bounce - a person stopping, not a spring. */
const easeOut = (u) => 1 - (1 - clamp01(u)) ** 3;
const mix = (a, b, k) => a + (b - a) * k;

/**
 * Every joint at `t` seconds. `crossed` forces the folded-arms pose on or off instead of following the
 * clock, which is what a profile being switched while the figure is already standing there wants.
 */
export function driverPose(t, { crossed = null } = {}) {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0;

  /* ---- where the walk has got to ---- */
  const walking = clamp01(time / WALK_S);
  /* Eased at both ends: the figure is already moving when it appears and slows into its mark. */
  const along = walking < 1 ? smooth(walking) : 1;
  const x = mix(FROM_X, 0, along);
  /* The stride is driven by distance covered, so the feet never slide: they are where the ground is. */
  const phase = ((x - FROM_X) / STRIDE_M) * 2 * Math.PI;
  /* How much of the gait is still being played. It goes out over the settle, not at the moment the
     figure reaches its mark, or the last step would freeze mid-air. */
  const gait = time < WALK_S ? 1 : 1 - smooth((time - WALK_S) / SETTLE_S);

  const swing = (offset) => Math.sin(phase + offset);
  /* The knee bends on the leg that is swinging through, which is the half of the cycle where the hip is
     coming forward. Never backwards, so `max`. */
  const bend = (offset) => Math.max(0, -Math.cos(phase + offset)) ** 1.3;

  const hip = [HIP_SWING * swing(0) * gait, HIP_SWING * swing(Math.PI) * gait];
  const knee = [-KNEE_SWING * bend(0) * gait, -KNEE_SWING * bend(Math.PI) * gait];
  const ankle = [ANKLE_SWING * swing(Math.PI) * gait, ANKLE_SWING * swing(0) * gait];
  /* Two rises per stride, one over each stance leg. */
  const bob = -BOB_M * Math.cos(2 * phase) * gait;
  const lean = LEAN * gait;

  /* ---- the arms ---- */
  const folding = crossed === true ? 1
    : crossed === false ? 0
      : smooth((time - ARRIVED_S) / FOLD_S);

  /* Walking: the arms swing against the legs, with a little elbow in them. */
  const walkShoulder = [ARM_SWING * swing(Math.PI) * gait, ARM_SWING * swing(0) * gait];
  const walkElbow = [ELBOW_WALK + 0.2 * Math.max(0, swing(Math.PI)) * gait, ELBOW_WALK + 0.2 * Math.max(0, swing(0)) * gait];

  /* Folded: the upper arms come in against the ribs, the elbows close, and the forearms turn across the
     chest - the right forearm on the outside, the left hand tucked under it, which is how people
     actually do it and what keeps the two arms from occupying the same space. */
  /* The numbers are worked, not eyed. The chest is 170 mm across at the shoulder, so a forearm that
     crosses the midline has to be at least that far in front of the shoulder joint or it is inside the
     ribs. A forearm is horizontal when the shoulder swing and the elbow flex add to a right angle, and
     turning the arm about the shoulder is what carries that horizontal forearm across the body rather
     than straight out in front. Working it through: the elbow lands 92 mm ahead of the shoulder and the
     hand 214 mm, which clears the chest, and the upper arm is only lightly drawn in - 0.26 rad of it put
     the elbow inside the waist. Both arms turn through the same angle, so the forearms finish parallel,
     one lying on the other: an X across the chest is a schoolteacher, not a driver on the grid. */
  const FOLD = {
    shoulderSwing: 0.3,
    adduct: 0.12,
    /* The same angle both sides, so the two forearms end up parallel rather than crossing in an X. */
    across: [1.05, 1.05],
    elbow: 1.55,
  };

  /* The elbows close before the arms come across, because that is the order a person does it in and
     because the other order takes the hands through each other at the front on the way. */
  const k = folding;
  const kBend = smooth(clamp01(k * 1.6));
  const kAcross = smooth(clamp01((k - 0.35) / 0.65));
  const shoulder = [mix(walkShoulder[0], FOLD.shoulderSwing, kBend), mix(walkShoulder[1], FOLD.shoulderSwing, kBend)];
  const elbow = [mix(walkElbow[0], FOLD.elbow, kBend), mix(walkElbow[1], FOLD.elbow, kBend)];
  /* Left arm in toward +z, right arm in toward -z. */
  const adduct = [-FOLD.adduct * kAcross, FOLD.adduct * kAcross];
  const across = [-FOLD.across[0] * kAcross, FOLD.across[1] * kAcross];
  /* The outside arm rides a little higher and further forward, so the forearms stack instead of meeting
     edge to edge. */
  /* What keeps the two forearms out of each other: the left rides 35 mm higher and 55 mm further
     forward, so it lies on the right one the way a folded pair does, and the right hand tucks away
     underneath it. */
  const forward = [0.055 * k, -0.03 * k];
  const lift = [0.035 * k, -0.035 * k];

  /* ---- the rest of the body ---- */
  /* Arriving, the chest comes up and the chin with it, and the shoulders drop as the arms settle. */
  const settled = clamp01((time - WALK_S) / (SETTLE_S + FOLD_S));
  const stand = easeOut(settled);
  /* A breath, once the figure is standing. Small enough to be felt rather than seen. */
  const breath = folding > 0.3 ? Math.sin((time - ARRIVED_S) * 1.5) * 0.008 * folding : 0;

  return {
    x,
    y: bob + breath,
    lean: lean - 0.02 * stand,
    /* Squared up to the camera as it arrives, having walked in at a slight angle. */
    turn: mix(-0.16, 0, stand),
    hip,
    knee,
    ankle,
    shoulder,
    elbow,
    adduct,
    across,
    forward,
    lift,
    /* The chest opens and the chin lifts as the arms fold. */
    chest: 0.06 * folding,
    head: { lift: 0.05 * stand + breath * 2, turn: mix(0.12, 0, stand) },
    /* Weight onto the front foot as it stops, then even. */
    weight: Math.sin(Math.PI * clamp01((time - WALK_S) / SETTLE_S)) * 0.035,
    walking: gait,
    folded: folding,
  };
}

/* ---- the figure ---- */

/**
 * A rounded segment standing on the origin and reaching up to `length`, `a` wide at the bottom and `b`
 * at the top, domed at both ends. Turned as a lathe, so it is smooth all the way round for about 250
 * triangles - the shape of an upper arm, a thigh, a chest.
 *
 * Everything is built the same way up and hung where it belongs, rather than half the parts being
 * modelled upside down: a limb that hangs from a joint is placed at -length.
 */
export function segmentGeometry(length, a, b, segments = 18, steps = 8) {
  return profileGeometry(length, [[0, a], [1, b]], segments, steps);
}

/**
 * The same, from a list of [u, radius] stops up the length, which is how a torso gets a waist: hips
 * wide, waist drawn in, chest wide again. Radius is interpolated smoothly between the stops.
 */
export function profileGeometry(length, stops, segments = 18, steps = 12) {
  const radiusAt = (u) => {
    let lo = stops[0];
    let hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (u >= stops[i][0] && u <= stops[i + 1][0]) {
        lo = stops[i];
        hi = stops[i + 1];
        break;
      }
    }
    const span = hi[0] - lo[0];
    return span > 0 ? mix(lo[1], hi[1], smooth((u - lo[0]) / span)) : lo[1];
  };
  const profile = [new THREE.Vector2(0.0005, 0)];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    /* Domed: the radius is drawn in over the first and last eighth of the length. */
    const cap = Math.min(1, Math.min(u, 1 - u) / 0.125);
    profile.push(new THREE.Vector2(Math.max(0.0005, radiusAt(u) * (0.4 + 0.6 * Math.sqrt(cap))), u * length));
  }
  profile.push(new THREE.Vector2(0.0005, length));
  return new THREE.LatheGeometry(profile, segments);
}

/**
 * The figure, as a rig: `{ root, joints, materials, geometries, setColour, dispose }`. `root` stands at
 * the origin with the figure's feet on y = 0.
 */
export function createDriver({ colour = "#8e8e93", grey = "#76767c", dark = "#3f3f44" } = {}) {
  const geometries = [];
  const keep = (g) => {
    geometries.push(g);
    return g;
  };
  const suit = new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), roughness: 0.62, metalness: 0.05, dithering: true });
  const skin = new THREE.MeshStandardMaterial({ color: new THREE.Color(grey), roughness: 0.75, metalness: 0, dithering: true });
  const trim = new THREE.MeshStandardMaterial({ color: new THREE.Color(dark), roughness: 0.5, metalness: 0.1, dithering: true });
  /* The visor: near black and polished, so it catches the softbox and reads as glass. */
  const glass = new THREE.MeshPhysicalMaterial({ color: new THREE.Color("#141417"), roughness: 0.08, metalness: 0.2, dithering: true });
  /* The livery stripe, a shade brighter than the suit so it separates from it. */
  const accent = new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), roughness: 0.4, metalness: 0.1, dithering: true });
  accent.color.multiplyScalar(1.35);
  const materials = [suit, skin, trim, glass, accent];

  const root = new THREE.Group();
  root.name = "driver";

  const joint = (parent, x, y, z) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.userData.rest = [x, y, z];
    parent.add(g);
    return g;
  };
  /* A part standing on its parent joint, or hung from it when `hang`. */
  const part = (parent, geometry, material, { y = 0, hang = 0 } = {}) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = y - hang;
    parent.add(mesh);
    return mesh;
  };

  /* Proportions of a 1.76 m person, in metres, measured from the floor: hip pivot at 1.03, shoulders at
     1.44, crown at 1.76, fingertips at mid-thigh. */
  const ANKLE_Y = 0.09;
  const SHIN = 0.46;
  const THIGH = 0.48;
  const HIP_Y = ANKLE_Y + SHIN + THIGH;
  const PELVIS = 0.14;
  const SPINE = 0.29;
  const NECK = 0.08;
  const UPPER = 0.31;
  const FORE = 0.27;

  const body = joint(root, 0, 0, 0);
  const hips = joint(body, 0, HIP_Y, 0);
  const chest = joint(hips, 0, PELVIS - 0.06, 0);
  /* One torso from the hips to the shoulders, with a waist in it. Two cylinders and a belt read as a
     robot; a person is wide at the hips, drawn in at the waist and wide again across the chest. */
  const torso = part(chest, keep(profileGeometry(PELVIS + SPINE, [
    [0, 0.145], [0.26, 0.118], [0.42, 0.125], [0.72, 0.168], [0.92, 0.172], [1, 0.15],
  ], 26, 18)), suit, { hang: PELVIS - 0.06 });
  torso.scale.z = 1.12;   // a person is wider across than front to back

  const neck = joint(chest, 0, SPINE - 0.015, 0);
  part(neck, keep(segmentGeometry(NECK + 0.04, 0.056, 0.06, 14, 5)), skin, { y: -0.02 });
  /* The collar of the suit, over the shoulders: a driver wears a head restraint, and it is what stops
     the neck reading as a stick between a body and a ball. */
  const collar = part(chest, keep(new THREE.TorusGeometry(0.098, 0.028, 8, 26)), trim, { y: SPINE - 0.01 });
  collar.rotation.x = Math.PI / 2;
  collar.scale.set(1, 1.25, 1);

  const head = joint(neck, 0, NECK, 0);
  /* A helmet, not a face. A driver wears one, so it is what this figure should be wearing - and it is
     the honest way to draw a person at this size: a modelled face at 200 pixels is a smear, while a
     helmet is a shape that is meant to be smooth. The profile's colour goes over the crown, where it
     reads from every angle. */
  const SHELL = 0.134;
  const shell = part(head, keep(new THREE.SphereGeometry(SHELL, 28, 22)), suit, { y: 0.108 });
  shell.scale.set(0.97, 1.02, 0.95);

  /* The visor: a patch cut out of the same sphere, a hair proud of it, dark and polished. three.js
     measures a sphere's phi from -x, so a patch centred on the figure's face - which looks along +x -
     starts at pi less half its width. A wide, shallow letterbox, the shape a helmet's opening is. */
  const VISOR_ARC = 1.9;
  const visor = part(head, keep(new THREE.SphereGeometry(SHELL + 0.002, 30, 16, Math.PI - VISOR_ARC / 2, VISOR_ARC, 1.0, 0.44)), glass, { y: 0.108 });
  visor.scale.copy(shell.scale);

  /* The chin bar under it. A torus arc starts at +x and sweeps toward +z once it is laid flat, so it is
     turned back by half its own arc to sit centred on the face. */
  const CHIN_ARC = 1.75;
  const chin = part(head, keep(new THREE.TorusGeometry(0.113, 0.021, 8, 26, CHIN_ARC)), suit, { y: 0.056 });
  chin.rotation.set(Math.PI / 2, CHIN_ARC / 2, 0);
  chin.scale.set(1, 1, 1.04);

  /* The livery: one stripe over the crown from the brow to the back of the neck, in the profile's
     colour. A torus arc of half a turn already lies in the plane this wants, so it is not turned at all. */
  const STRIPE_FROM = 0.8;
  const stripe = part(head, keep(new THREE.TorusGeometry(SHELL - 0.004, 0.011, 8, 26, Math.PI - STRIPE_FROM)), accent, { y: 0.108 });
  stripe.rotation.z = STRIPE_FROM;
  stripe.scale.set(0.99, 1.04, 0.97);

  const arms = [];
  const legs = [];
  for (const side of [0, 1]) {
    const sign = side === 0 ? -1 : 1;   // 0 is the figure's left, at -z
    const shoulder = joint(chest, 0, SPINE - 0.035, sign * 0.185);
    /* A ball at each joint, so a limb that bends has a shoulder and an elbow rather than a hinge. */
    part(shoulder, keep(new THREE.SphereGeometry(0.068, 16, 12)), suit);
    part(shoulder, keep(profileGeometry(UPPER, [[0, 0.062], [0.3, 0.055], [1, 0.046]], 16, 8)), suit, { hang: UPPER });
    const elbow = joint(shoulder, 0, -UPPER, 0);
    part(elbow, keep(new THREE.SphereGeometry(0.048, 14, 10)), suit);
    part(elbow, keep(profileGeometry(FORE, [[0, 0.05], [0.35, 0.045], [1, 0.036]], 16, 8)), suit, { hang: FORE });
    const wrist = joint(elbow, 0, -FORE, 0);
    /* A glove, in the suit: a dark blob on the end of each arm read as a mitten. */
    const hand = part(wrist, keep(new THREE.SphereGeometry(0.036, 14, 10)), suit, { y: -0.032 });
    hand.scale.set(0.85, 1.25, 0.62);
    arms.push({ shoulder, elbow, wrist });

    const hip = joint(hips, 0, -0.03, sign * 0.098);
    part(hip, keep(new THREE.SphereGeometry(0.085, 16, 12)), suit);
    part(hip, keep(profileGeometry(THIGH, [[0, 0.085], [0.25, 0.079], [1, 0.058]], 18, 9)), suit, { hang: THIGH });
    const knee = joint(hip, 0, -THIGH, 0);
    part(knee, keep(new THREE.SphereGeometry(0.058, 14, 10)), suit);
    part(knee, keep(profileGeometry(SHIN, [[0, 0.06], [0.35, 0.056], [1, 0.038]], 16, 9)), suit, { hang: SHIN });
    const ankle = joint(knee, 0, -SHIN, 0);
    const foot = part(ankle, keep(new THREE.CapsuleGeometry(0.036, 0.15, 5, 12)), trim, { y: -0.048 });
    foot.rotation.z = Math.PI / 2;
    foot.position.x = 0.042;
    legs.push({ hip, knee, ankle });
  }

  return {
    root,
    body,
    hips,
    chest,
    neck,
    head,
    arms,
    legs,
    materials,
    height: HIP_Y + PELVIS + SPINE + NECK + 0.22,
    setColour(next) {
      if (!next) return;
      suit.color.set(next);
      accent.color.set(next).multiplyScalar(1.35);
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

/** Put a rig from `createDriver` into the pose `driverPose` returned. */
export function applyPose(rig, pose) {
  rig.body.position.set(pose.x, pose.y, 0);
  rig.body.rotation.y = pose.turn;
  rig.body.rotation.z = pose.lean;
  rig.hips.rotation.z = -pose.weight;
  rig.chest.rotation.z = -pose.chest;
  rig.head.rotation.z = -pose.head.lift;
  rig.head.rotation.y = pose.head.turn;
  for (const side of [0, 1]) {
    const arm = rig.arms[side];
    arm.shoulder.rotation.set(pose.adduct[side], pose.across[side], pose.shoulder[side] + pose.forward[side]);
    arm.elbow.rotation.z = pose.elbow[side];
    arm.elbow.position.y = arm.elbow.userData.rest[1] + pose.lift[side];
    const leg = rig.legs[side];
    leg.hip.rotation.z = pose.hip[side];
    leg.knee.rotation.z = pose.knee[side];
    leg.ankle.rotation.z = pose.ankle[side];
  }
}

/* ---- the stage ---- */

/* The figure is drawn nearly life size in a panel a few hundred pixels tall, so a long lens and a low
   camera - the same lens the Park stage photographs the robot with. */
const STAGE_FOV = 26;
const FRAME_MS = 1000 / 60;

/**
 * A driver on a small stage of their own, in `canvas`. Draws on demand: a frame is asked for while the
 * walk-on is playing or a colour is settling, and the loop stops when the figure is standing still.
 *
 * Returns `{ play, setColour, setActive, resize, dispose }`. `play(from)` starts the walk-on again;
 * `setActive(false)` is what a panel that has scrolled out of sight calls, and nothing is drawn until
 * it comes back.
 */
export function createDriverStage(canvas, { colour = "#8e8e93", reduced = false } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setClearAlpha(0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(STAGE_FOV, 16 / 9, 0.1, 40);
  /* Far enough back that the whole figure fits the tall, narrow panel it stands in: the vertical field
     is 26 degrees, so a 1.76 m figure needs about 3.8 m, and 4.0 leaves a little air over its head. */
  /* Far enough back that the whole figure fits the panel it stands in - the field is 26 degrees, so a
     1.76 m figure needs about 3.8 m - and looking a little to the left of the mark, so there is room on
     that side for the walk-on to come from. */
  camera.position.set(3.75, 1.62, 2.8);
  camera.lookAt(-0.12, 0.92, 0);

  /* The same studio the robot stands in: a low ambient, a key over the camera's shoulder, a cool rim
     from behind that draws the figure's edge out of a dark panel. */
  scene.add(new THREE.HemisphereLight(0xffffff, 0x0b0b0c, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(3, 4.4, 2.6);
  const rim = new THREE.DirectionalLight(0xdae3f4, 2.4);
  rim.position.set(-2.4, 2.2, -3.2);
  scene.add(key, rim);

  /* The floor: a disc that fades to nothing before its edge, so the figure stands on something without
     the panel having a horizon in it. */
  const floorGeometry = new THREE.CircleGeometry(3.2, 48);
  const floorMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uOpacity: { value: 0.5 } },
    vertexShader: `
      varying vec2 vXy;
      void main() {
        vXy = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vXy;
      uniform float uOpacity;
      void main() {
        float r = length(vXy) / 3.2;
        float fade = smoothstep(1.0, 0.25, r);
        gl_FragColor = vec4(vec3(0.07, 0.07, 0.075), fade * uOpacity);
      }`,
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  /* The built-in figure goes up straight away, and the baked model - if the team has run
     `npm run driver-cad` - replaces it when it has loaded. Neither the panel nor the choreography knows
     which one it is drawing: both rigs take the same pose. */
  let wanted = colour;
  let rig = createDriver({ colour });
  let played = null;
  scene.add(rig.root);
  loadDriverModel().then(async (asset) => {
    if (!asset || disposed) return;
    let better = null;
    try {
      better = await createModelDriver(asset, { colour: wanted });
    } catch (err) {
      console.warn("the baked driver would not load; keeping the built-in figure", err);
      return;
    }
    if (disposed) {
      better.dispose();
      return;
    }
    scene.remove(rig.root);
    rig.dispose();
    rig = better;
    played = better;
    scene.add(rig.root);
    started = performance.now();
    standing = Boolean(reduced);
    wake();
  });

  let sized = { w: 0, h: 0, dpr: 0 };
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (!w || !h || (w === sized.w && h === sized.h && dpr === sized.dpr)) return false;
    sized = { w, h, dpr };
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    return true;
  }

  let raf = 0;
  let active = false;
  let disposed = false;
  let started = -Infinity;
  let standing = true;   // nothing to play: hold the posed figure
  let lastFrame = -Infinity;

  /* The walk-on is drawn at whatever the display offers, because it is a movement the eye follows. The
     breath that is left over afterwards is a slow sine on a figure that is otherwise still, so it is
     drawn at a quarter of that - enough to be smooth, little enough that a settings panel left open
     does not keep the graphics chip awake for nothing. */
  const BREATH_MS = 1000 / 15;

  function tick(now) {
    raf = 0;
    if (!active || disposed) return;
    const done = played ? played.seconds : POSED_S;
    const t = standing ? done + 4 : (now - started) / 1000;
    const playing = t < done;
    if (now - lastFrame < (playing ? FRAME_MS : BREATH_MS) - 2) {
      raf = requestAnimationFrame(tick);
      return;
    }
    lastFrame = now;
    resize();
    if (!sized.w || !sized.h) return;
    if (played) played.step(t, now);
    else applyPose(rig, driverPose(t, standing ? { crossed: true } : {}));
    renderer.render(scene, camera);
    /* Reduced motion gets the standing figure and nothing else moving. */
    if (playing || !reduced) raf = requestAnimationFrame(tick);
  }

  function wake() {
    if (!active || disposed || raf) return;
    raf = requestAnimationFrame(tick);
  }

  const observer = new ResizeObserver(() => {
    if (resize()) wake();
  });
  observer.observe(canvas);

  return {
    /** Start the walk-on. */
    play() {
      if (disposed) return;
      started = performance.now();
      standing = Boolean(reduced);
      wake();
    },
    /** Hold the figure where the walk-on leaves it, without playing. */
    stand() {
      standing = true;
      wake();
    },
    setColour(next) {
      if (next) wanted = next;
      rig.setColour(next);
      wake();
    },
    setActive(next) {
      active = Boolean(next);
      if (active) wake();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    resize() {
      if (resize()) wake();
    },
    dispose() {
      disposed = true;
      active = false;
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      rig.dispose();
      floorGeometry.dispose();
      floorMaterial.dispose();
      renderer.dispose();
    },
  };
}

/* ---- the baked figure ---- */

/**
 * The figure from `npm run driver-cad`: `{ manifest, scene, animations }`, or null when none is baked.
 * Loaded once per page, like the robot's CAD.
 */
let loadingModel = null;
export function loadDriverModel() {
  loadingModel ??= (async () => {
    const response = await fetch("./vendor/driver.json").catch(() => null);
    if (!response || !response.ok) return null;
    const manifest = await response.json();
    if (!(manifest?.version >= 3)) return null;
    const { GLTFLoader } = await import("./vendor/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(`./vendor/${manifest.model?.file ?? "driver.glb"}`);
    /* Files that carry a clip and no figure - a stand this console did not ship with, dropped in beside
       the character. They are loaded whole and only their animations are kept. */
    const animations = (gltf.animations ?? []).map((clip) => ({ clip, file: manifest.model?.file ?? "driver.glb" }));
    for (const entry of manifest.extra ?? []) {
      try {
        const other = await loader.loadAsync(`./vendor/${entry.file}`);
        for (const clip of other.animations ?? []) animations.push({ clip, file: entry.file });
      } catch (err) {
        console.warn(`the driver's extra clips in ${entry.file} would not load`, err);
      }
    }
    return { manifest, scene: gltf.scene, animations };
  })().catch((err) => {
    console.warn("no driver model baked; drawing the built-in figure", err);
    return null;
  });
  return loadingModel;
}

/** A person, in metres, whatever the rig was modelled at. */
const DRIVER_M = 1.76;

/* A bone name with its rig's prefix taken off, so a skeleton can be read without knowing whose it is. */
const plainBone = (name) => name.replace(/^mixamorig[:_ ]?\d*/i, "").replace(/^[:_]/, "");

/**
 * The mannequin the console draws: grey, featureless, jointed.
 *
 * A character mesh from an animation library is a person - a face, a build, clothes - and a person is the
 * wrong thing to put on this screen. What belongs there is an artist's dummy: obviously a stand-in for
 * whoever is driving rather than a picture of anybody.
 *
 * It is built over the source's own skeleton, so every clip that skeleton can play still plays, and each
 * limb is one piece bound rigidly to one bone, which is what a wooden dummy is. A ball at each joint
 * covers the gap the way a ball joint does. There is no smooth skinning because there is nothing to
 * smooth: the pieces are meant to read as separate.
 *
 * Lengths come from the skeleton - every piece reaches from its bone to the next - so the proportions are
 * the rig's own. Only the thicknesses are chosen, as a fraction of the figure's height, which is what
 * makes this work on a rig of any size.
 */
const LIMBS = [
  { bone: "Hips", to: "Spine", girth: 0.115, wide: 1.15, ball: 0.105 },
  { bone: "Spine", to: "Spine1", girth: 0.105, wide: 1.2 },
  { bone: "Spine1", to: "Spine2", girth: 0.112, wide: 1.25 },
  { bone: "Spine2", to: "Neck", girth: 0.125, wide: 1.3, taper: 0.55, ball: 0.075 },
  { bone: "Neck", to: "Head", girth: 0.042 },
  /* The head is a rounded box of a thing rather than a cone: the piece stops well short of the crown
     bone and keeps its width, and the ball at the jaw fills in underneath it. */
  { bone: "Head", to: "HeadTop_End", girth: 0.092, taper: 0.92, reach: 0.6, ball: 0.088 },
  { bone: "LeftShoulder", to: "LeftArm", girth: 0.058, ball: 0.06 },
  { bone: "RightShoulder", to: "RightArm", girth: 0.058, ball: 0.06 },
  { bone: "LeftArm", to: "LeftForeArm", girth: 0.048, taper: 0.85, ball: 0.05 },
  { bone: "RightArm", to: "RightForeArm", girth: 0.048, taper: 0.85, ball: 0.05 },
  { bone: "LeftForeArm", to: "LeftHand", girth: 0.04, taper: 0.8, ball: 0.041 },
  { bone: "RightForeArm", to: "RightHand", girth: 0.04, taper: 0.8, ball: 0.041 },
  { bone: "LeftHand", to: "LeftHandMiddle1", girth: 0.032, reach: 2.1, taper: 0.8, ball: 0.033 },
  { bone: "RightHand", to: "RightHandMiddle1", girth: 0.032, reach: 2.1, taper: 0.8, ball: 0.033 },
  { bone: "LeftUpLeg", to: "LeftLeg", girth: 0.08, taper: 0.76, ball: 0.082 },
  { bone: "RightUpLeg", to: "RightLeg", girth: 0.08, taper: 0.76, ball: 0.082 },
  { bone: "LeftLeg", to: "LeftFoot", girth: 0.058, taper: 0.68, ball: 0.058 },
  { bone: "RightLeg", to: "RightFoot", girth: 0.058, taper: 0.68, ball: 0.058 },
  { bone: "LeftFoot", to: "LeftToeBase", girth: 0.042, reach: 1.35, taper: 0.85, ball: 0.042 },
  { bone: "RightFoot", to: "RightToeBase", girth: 0.042, reach: 1.35, taper: 0.85, ball: 0.042 },
];

/** A rounded, tapered piece from one point to another, in the space both were measured in. */
function limbGeometry(a, b, rA, rB, segments = 12) {
  const along = new THREE.Vector3().subVectors(b, a);
  const length = along.length();
  if (!(length > 1e-9)) return null;
  const profile = [];
  const STEPS = 7;
  for (let i = 0; i <= STEPS; i++) {
    const u = i / STEPS;
    /* Drawn in at both ends, so a piece is a rounded slug rather than a pipe with its ends open. */
    const cap = Math.min(1, Math.min(u, 1 - u) / 0.16);
    profile.push(new THREE.Vector2(Math.max(1e-5, (rA + (rB - rA) * u) * (0.35 + 0.65 * Math.sqrt(cap))), u * length));
  }
  const geometry = new THREE.LatheGeometry(profile, segments);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.normalize()));
  geometry.translate(a.x, a.y, a.z);
  return geometry;
}

/**
 * The mannequin over `skeleton`, built in the space the bones are in right now and bound to them, so it
 * moves with every clip they can play. `unit` is how many of that space's units a metre is.
 */
async function buildMannequin(skeleton, unit, material, reference) {
  const { mergeGeometries } = await import("./vendor/utils/BufferGeometryUtils.js");
  const index = new Map(skeleton.bones.map((b, i) => [plainBone(b.name), i]));
  /* Built in the space the skeleton's own bind matrices are written in, which is the space the mesh that
     came with the rig was bound in - not the world, and not the rig's local space either. Getting this
     wrong does not look like a small error: every piece follows its bone through a different transform
     and the figure comes apart into a cloud. */
  const toBind = reference.bindMatrixInverse.clone();
  const at = (name) => {
    const i = index.get(name);
    return i === undefined ? null : skeleton.bones[i].getWorldPosition(new THREE.Vector3()).applyMatrix4(toBind);
  };

  const pieces = [];
  const owners = [];
  const add = (geometry, bone) => {
    if (!geometry) return;
    pieces.push(geometry);
    owners.push(index.get(bone) ?? 0);
  };

  for (const limb of LIMBS) {
    const a = at(limb.bone);
    const b = at(limb.to);
    if (!a || !b || index.get(limb.bone) === undefined) continue;
    /* A hand and a foot run past the bone they point at, because that bone stops at a knuckle. */
    const end = limb.reach ? a.clone().addScaledVector(new THREE.Vector3().subVectors(b, a), limb.reach) : b;
    const r = limb.girth * unit;
    const piece = limbGeometry(a, end, r, r * (limb.taper ?? 1));
    /* A body is wider across than it is front to back, and a stack of circular pieces reads as a pipe.
       Widening the torso along the figure's own left-right axis is what makes it a chest. */
    if (piece && limb.wide) piece.scale(limb.wide, 1, 1);
    add(piece, limb.bone);
    if (limb.ball) {
      const ball = new THREE.SphereGeometry(limb.ball * unit, 14, 10);
      ball.translate(a.x, a.y, a.z);
      add(ball, limb.bone);
    }
  }
  if (!pieces.length) return null;

  const merged = mergeGeometries(pieces, false);
  const count = merged.getAttribute("position").count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  let vertex = 0;
  pieces.forEach((piece, i) => {
    const n = piece.getAttribute("position").count;
    for (let k = 0; k < n; k++, vertex++) {
      skinIndex[vertex * 4] = owners[i];
      skinWeight[vertex * 4] = 1;
    }
    piece.dispose();
  });
  merged.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndex, 4));
  merged.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeight, 4));
  merged.computeVertexNormals();

  const mesh = new THREE.SkinnedMesh(merged, material);
  mesh.name = "mannequin";
  /* A skinned mesh's bounding box is its bind pose, which is not where it is once it is posed. */
  mesh.frustumCulled = false;
  /* Bound with an identity bind matrix, because the geometry was just built in the same space the bones
     report themselves in. Everything above it - the scale that makes it a person's height, the turn that
     makes it face forward - goes on a group above, where it moves the bones and the mesh together. */
  mesh.bind(skeleton, reference.bindMatrix);
  return mesh;
}

/**
 * Where the figure has got to along its walk-on at `t` seconds.
 *
 * The only part of the choreography the console owns. Walking is not derived here - it is a clip somebody
 * animated - and what is left is carrying the figure along the floor. The speed that has to happen at is
 * not a matter of taste: a walk clip is animated on the spot, so the ground has to pass under it at
 * exactly the rate its feet are already moving, which is measured off the clip itself. Any other speed is
 * a moon-walk.
 */
export function walkOn(t, { speed = 0.9, from = -1.6, settle = 0.35 } = {}) {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0;
  const seconds = speed > 0 ? Math.abs(from) / speed : 0;
  if (time < seconds) return { x: from + speed * time, walking: true, standing: 0 };
  return { x: 0, walking: false, standing: Math.min(1, (time - seconds) / Math.max(settle, 1e-3)) };
}

/**
 * A rig around the baked model: a mannequin over its skeleton, playing its clips.
 *
 * Everything about the rig is measured here rather than taken on trust, and measured with a clip running
 * rather than at rest. A rig carries its units in three places at once - the bones, the node above them,
 * and the position tracks of its clips - and the only frame in which all three agree is the one the
 * figure is actually drawn in. Which way it faces, how tall it is and how long its stride is are all read
 * off the skeleton while the walk plays.
 */
export async function createModelDriver(asset, { colour = "#8e8e93" } = {}) {
  const { clone: cloneSkinned } = await import("./vendor/utils/SkeletonUtils.js");
  /* A skinned mesh cloned the ordinary way keeps its original skeleton, so two figures on one page would
     move as one. */
  const model = cloneSkinned(asset.scene);

  const root = new THREE.Group();
  root.name = "driver";
  /* The group that makes the rig a person: its scale, its facing, its feet on the floor. */
  const fit = new THREE.Group();
  fit.name = "driver-fit";
  fit.add(model);
  root.add(fit);
  root.updateMatrixWorld(true);

  let skeleton = null;
  const originals = [];
  model.traverse((o) => {
    if (o.isSkinnedMesh) {
      skeleton ??= o.skeleton;
      originals.push(o);
    }
  });
  if (!skeleton) throw new Error("the baked driver has no skeleton");

  const mixer = new THREE.AnimationMixer(model);
  const bones = new Map(skeleton.bones.map((b) => [plainBone(b.name), b]));

  /* A clip from another file names bones the way its own rig did. Matching on what is left after the rig
     prefix - "mixamorig:Hips" against "Hips" - is what lets one animation library drive another rig, and
     a track for a bone this skeleton does not have is dropped rather than left to throw. */
  const fitted = (clip) => {
    const tracks = [];
    for (const track of clip.tracks) {
      const [node, ...rest] = track.name.split(".");
      const bone = bones.get(plainBone(node));
      if (!bone) continue;
      const copy = track.clone();
      copy.name = `${bone.name}.${rest.join(".")}`;
      tracks.push(copy);
    }
    return tracks.length ? new THREE.AnimationClip(clip.name, clip.duration, tracks) : null;
  };
  const named = asset.manifest?.clips ?? {};
  const pick = (want) => {
    if (!want) return null;
    const hit = asset.animations.find((a) => a.clip.name === want.clip && (!want.file || a.file === want.file))
      ?? asset.animations.find((a) => a.clip.name === (want.clip ?? want));
    if (!hit) return null;
    /* A clip out of the figure's own file already names these bones; one from elsewhere does not. */
    return hit.file === (asset.manifest?.model?.file ?? "driver.glb") ? hit.clip : fitted(hit.clip);
  };
  const walkClip = pick(named.walk);
  const standClip = pick(named.stand);
  const of = (name) => bones.get(name) ?? null;
  const crown = of("HeadTop_End") ?? of("Head");
  const feet = [of("LeftFoot"), of("RightFoot")];
  const toe = of("LeftToeBase") ?? of("LeftToe_End");

  /* ---- measure, with the walk running ---- */
  let unit = 1;          // units of the rig's space per metre
  let yaw = 0;           // which way it faces, radians from +x
  let floor = 0;         // where the floor is in the rig's space
  let stride = 1.4;      // metres of ground one loop of the walk covers
  if (crown && feet.every(Boolean)) {
    const action = walkClip ? mixer.clipAction(walkClip) : null;
    action?.play();
    const head = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    let tall = 0;
    let apart = 0;
    let low = Infinity;
    const STEPS = walkClip ? 48 : 1;
    for (let i = 0; i <= STEPS; i++) {
      if (walkClip) mixer.setTime((walkClip.duration * i) / STEPS);
      model.updateMatrixWorld(true);
      crown.getWorldPosition(head);
      feet[0].getWorldPosition(a);
      feet[1].getWorldPosition(b);
      tall = Math.max(tall, head.y - Math.min(a.y, b.y));
      apart = Math.max(apart, Math.hypot(a.x - b.x, a.z - b.z));
      low = Math.min(low, a.y, b.y);
      if (toe && i === Math.round(STEPS / 4)) {
        const ahead = toe.getWorldPosition(new THREE.Vector3()).sub(a);
        ahead.y = 0;
        if (ahead.lengthSq() > 1e-12) {
          ahead.normalize();
          yaw = Math.atan2(ahead.z, ahead.x);
        }
      }
    }
    action?.stop();
    skeleton.pose();
    model.updateMatrixWorld(true);
    if (tall > 1e-9) {
      /* The crown is the top of the head, so the measured height is the figure's own. */
      unit = tall / DRIVER_M;
      floor = low;
      /* Two steps to a loop, one per leg. */
      stride = (apart * 2) / unit;
    }
  }

  fit.scale.setScalar(1 / unit);
  fit.rotation.y = yaw;
  fit.position.y = -floor / unit;
  root.updateMatrixWorld(true);

  /* ---- the figure ---- */
  const suit = new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), roughness: 0.58, metalness: 0.05, dithering: true });
  const dummy = await buildMannequin(skeleton, unit, suit, originals[0]);
  if (dummy) {
    /* It goes where the mesh it replaces was, so its own place in the hierarchy matches the bind matrix
       it was built against. */
    (originals[0].parent ?? fit).add(dummy);
    for (const mesh of originals) mesh.visible = false;
  } else {
    /* Nothing was recognised in this skeleton, so the character's own mesh is what there is. */
    for (const mesh of originals) mesh.material = suit;
  }

  const speed = walkClip?.duration ? stride / walkClip.duration : 0;
  const walking = walkClip ? mixer.clipAction(walkClip) : null;
  const standing = standClip ? mixer.clipAction(standClip) : null;
  walking?.setLoop(THREE.LoopRepeat, Infinity);
  standing?.setLoop(THREE.LoopRepeat, Infinity);

  let last = null;
  let phase = "";

  return {
    root,
    body: root,
    model,
    materials: [suit],
    /** What the figure measured out at, for anyone who wants to check it. */
    measured: { unit, yaw, stride, speed },
    /** How long the walk-on takes. */
    get seconds() {
      return (speed > 0 ? 1.6 / speed : 0) + 1.3;
    },
    /** Put the figure where it is at `t` seconds into the walk-on, and advance its clips. */
    step(t, now) {
      const at = walkOn(t, { speed: speed || 1, from: speed > 0 ? -1.6 : 0 });
      root.position.x = at.x;
      const want = at.walking ? "walk" : "stand";
      if (want !== phase) {
        /* Cross-faded rather than cut, in the clips' own time: a figure that snaps from walking to
           standing has not arrived anywhere. */
        if (want === "walk") walking?.reset().fadeIn(0.2).play();
        else {
          standing?.reset().fadeIn(0.5).play();
          walking?.fadeOut(0.5);
        }
        phase = want;
      }
      const dt = last === null ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      mixer.update(dt);
      return at.walking || at.standing < 1;
    },
    setColour(next) {
      if (next) suit.color.set(next);
    },
    dispose() {
      mixer.stopAllAction();
      suit.dispose();
      dummy?.geometry.dispose();
    },
  };
}
