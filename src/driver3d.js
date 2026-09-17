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
  const FOLD = {
    shoulderSwing: 0.28,
    adduct: 0.3,
    across: [1.16, 0.98],
    elbow: 1.95,
  };

  const k = folding;
  const shoulder = [mix(walkShoulder[0], FOLD.shoulderSwing, k), mix(walkShoulder[1], FOLD.shoulderSwing, k)];
  const elbow = [mix(walkElbow[0], FOLD.elbow, k), mix(walkElbow[1], FOLD.elbow, k)];
  /* Left arm in toward +z, right arm in toward -z. */
  const adduct = [-FOLD.adduct * k, FOLD.adduct * k];
  const across = [-FOLD.across[0] * k, FOLD.across[1] * k];
  /* The outside arm rides a little higher and further forward, so the forearms stack instead of meeting
     edge to edge. */
  const forward = [0.035 * k, -0.02 * k];
  const lift = [0.012 * k, -0.012 * k];

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
  const profile = [new THREE.Vector2(0.0005, 0)];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    /* Domed: the radius is drawn in over the first and last eighth of the length. */
    const cap = Math.min(1, Math.min(u, 1 - u) / 0.125);
    profile.push(new THREE.Vector2(Math.max(0.0005, mix(a, b, u) * (0.4 + 0.6 * Math.sqrt(cap))), u * length));
  }
  profile.push(new THREE.Vector2(0.0005, length));
  return new THREE.LatheGeometry(profile, segments);
}

/**
 * The figure, as a rig: `{ root, joints, materials, geometries, setColour, dispose }`. `root` stands at
 * the origin with the figure's feet on y = 0.
 */
export function createDriver({ colour = "#8e8e93", grey = "#6b6b70", dark = "#2c2c2e" } = {}) {
  const geometries = [];
  const keep = (g) => {
    geometries.push(g);
    return g;
  };
  const suit = new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), roughness: 0.62, metalness: 0.05, dithering: true });
  const skin = new THREE.MeshStandardMaterial({ color: new THREE.Color(grey), roughness: 0.75, metalness: 0, dithering: true });
  const trim = new THREE.MeshStandardMaterial({ color: new THREE.Color(dark), roughness: 0.5, metalness: 0.1, dithering: true });
  const materials = [suit, skin, trim];

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
  part(hips, keep(segmentGeometry(PELVIS, 0.14, 0.125, 20, 5)), suit, { y: -0.05 });

  const chest = joint(hips, 0, PELVIS - 0.05, 0);
  part(chest, keep(segmentGeometry(SPINE, 0.13, 0.17, 20, 8)), suit);
  /* The shoulders, as one piece across the top of the chest. */
  const shoulderBar = part(chest, keep(new THREE.CapsuleGeometry(0.072, 0.23, 6, 18)), suit, { y: SPINE - 0.025 });
  shoulderBar.rotation.x = Math.PI / 2;

  const neck = joint(chest, 0, SPINE - 0.01, 0);
  part(neck, keep(segmentGeometry(NECK + 0.03, 0.052, 0.056, 14, 4)), skin);
  const head = joint(neck, 0, NECK, 0);
  const skull = part(head, keep(new THREE.SphereGeometry(0.108, 24, 18)), skin, { y: 0.1 });
  skull.scale.set(0.92, 1.1, 1);
  /* A band round the head at the brow, in the suit's colour: at the size this is drawn it is the piece
     of the profile's colour that reads from the front. */
  const band = part(head, keep(new THREE.TorusGeometry(0.101, 0.015, 8, 28)), suit, { y: 0.115 });
  band.rotation.x = Math.PI / 2;
  band.scale.set(1, 1.05, 1);

  const arms = [];
  const legs = [];
  for (const side of [0, 1]) {
    const sign = side === 0 ? -1 : 1;   // 0 is the figure's left, at -z
    const shoulder = joint(chest, 0, SPINE - 0.03, sign * 0.19);
    part(shoulder, keep(segmentGeometry(UPPER, 0.058, 0.048, 16, 6)), suit, { hang: UPPER });
    const elbow = joint(shoulder, 0, -UPPER, 0);
    part(elbow, keep(segmentGeometry(FORE, 0.05, 0.042, 16, 6)), suit, { hang: FORE });
    const wrist = joint(elbow, 0, -FORE, 0);
    const hand = part(wrist, keep(new THREE.SphereGeometry(0.05, 14, 10)), trim, { y: -0.045 });
    hand.scale.set(0.8, 1.3, 0.55);
    arms.push({ shoulder, elbow, wrist });

    const hip = joint(hips, 0, -0.03, sign * 0.098);
    part(hip, keep(segmentGeometry(THIGH, 0.088, 0.066, 18, 6)), suit, { hang: THIGH });
    const knee = joint(hip, 0, -THIGH, 0);
    part(knee, keep(segmentGeometry(SHIN, 0.064, 0.044, 16, 6)), suit, { hang: SHIN });
    const ankle = joint(knee, 0, -SHIN, 0);
    const foot = part(ankle, keep(new THREE.CapsuleGeometry(0.043, 0.14, 5, 12)), trim, { y: -0.045 });
    foot.rotation.z = Math.PI / 2;
    foot.position.x = 0.04;
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
      if (next) suit.color.set(next);
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
    arm.elbow.position.y = -0.3 + pose.lift[side];
    const leg = rig.legs[side];
    leg.hip.rotation.z = pose.hip[side];
    leg.knee.rotation.z = pose.knee[side];
    leg.ankle.rotation.z = pose.ankle[side];
  }
}
