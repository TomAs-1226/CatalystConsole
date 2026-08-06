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
 * Cost control, because this runs on the same laptop as the Driver Station:
 *   * 30 fps, not 60, and nothing is animated between poses.
 *   * Rendering stops entirely when the dashboard tab is not showing.
 *   * No shadow maps, no post-processing, no textures. Flat materials on ~30 meshes.
 *   * The renderer is disposed properly when the tile goes away.
 */

import * as THREE from "./vendor/three.module.min.js";

const CARPET = 0x24262b;
const WALL = 0x15161a;
const LINE = 0x4a4d55;
const RED = 0xff453a;
const BLUE = 0x4d90fe;

const FRAME_MS = 1000 / 30;

export function createField(canvas, opts) {
  const length = Number(opts.length) > 1 ? Number(opts.length) : 16.54;
  const width = Number(opts.width) > 1 ? Number(opts.width) : 8.07;
  const trailLen = Math.max(0, opts.trail | 0);

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

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 120);

  scene.add(new THREE.HemisphereLight(0xc8d4e4, 0x0a0b0d, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(6, 12, 8);
  scene.add(key);
  // A second, weaker light from the opposite side so the far half of the field is not a silhouette.
  const fill = new THREE.DirectionalLight(0x8fa8c8, 0.3);
  fill.position.set(-8, 6, -7);
  scene.add(fill);

  /* ---- field geometry. Built centred on the origin; poses are translated in. ----
   *
   * Two layers. `field` is the procedural outline, drawn from the season's dimensions. `cad` is the
   * official model, loaded only if someone has run `npm run field-cad` to bake one — when it arrives
   * the outline hides and the real field takes over. The outline is not a placeholder to be ashamed
   * of: it is what renders on a machine that has no model, and it is the thing that always works. */

  const field = new THREE.Group();
  scene.add(field);

  const cad = new THREE.Group();
  cad.visible = false;
  scene.add(cad);

  const flat = (color, opacity = 1) =>
    new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
  const lit = (color) => new THREE.MeshLambertMaterial({ color });

  /* The venue floor the field sits on. Without it the frame above the far wall is transparent, and a
     hard black wedge across the top of the tile reads as a rendering fault rather than as sky. It sits
     outside `field` because it is wanted under the CAD model too. */
  const backdrop = new THREE.Group();
  scene.add(backdrop);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(length * 4, width * 6), flat(0x191b20));
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
    field.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: LINE, transparent: true, opacity: 0.22 })));
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
    stripe(0, 0xffffff, 0.35);
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
    const response = await fetch("./vendor/field.glb", { method: "HEAD" }).catch(() => null);
    if (!response || !response.ok) return false;

    /* Fetched in parallel with the loader import: it is a few hundred KB of grid we only want four
       numbers out of, and it must not add a round trip to the model's own load. */
    const metaPromise = fetch("./vendor/field-collision.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    const { GLTFLoader } = await import("./vendor/GLTFLoader.js");
    const gltf = await new GLTFLoader().loadAsync("./vendor/field.glb");
    const model = gltf.scene;
    model.rotation.x = -Math.PI / 2;
    model.updateMatrixWorld(true);

    const meta = await metaPromise;
    const transform = meta?.modelToField;
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

        (m.color || new THREE.Color(0x888888)).getHSL(hsl, THREE.SRGBColorSpace);
        /* Read and write in sRGB, not the linear working space. Pick these numbers linearly and the
           output transfer curve lifts them by roughly a third on screen.

           The band is narrow on purpose. Too light and the field is a slab of glare that pulls the eye
           off the robot; too dark and it is a black void with no readable structure. These sit the
           carpet and framing around #3a-#48 — clearly present, clearly behind the robot. */
        const colour = new THREE.Color().setHSL(
          hsl.h,
          hsl.s * 0.55,
          // Grey parts land mid-dark and even; coloured parts keep a little more presence.
          hsl.s < 0.15 ? 0.33 : 0.35 + hsl.s * 0.12,
          THREE.SRGBColorSpace
        );
        const flatMat = new THREE.MeshLambertMaterial({
          color: colour,
          transparent: m.transparent,
          opacity: m.opacity,
          side: m.side,
        });
        remapped.set(m.uuid, flatMat);
        m.dispose();
        return flatMat;
      });
      obj.material = Array.isArray(obj.material) ? next : next[0];
    });

    cad.add(model);
    cad.visible = true;
    field.visible = false;   // the outline steps aside for the real thing
    backdrop.visible = true; // but the venue floor stays: the model stops at the field edge
    return true;
  }

  /* ---- the robot ---- */

  const robot = new THREE.Group();
  robot.visible = false;
  scene.add(robot);

  /* Roughly a real FRC robot: a 28 in frame inside 3 in bumpers, about 0.75 m over the bumpers with a
     superstructure. Everything here exists to answer one question at a glance — where is it pointing —
     so the shape is deliberately asymmetric front to back and the nose is the brightest thing on it. */
  const FRAME = 0.71;     // 28 in
  const BUMPER = 0.08;
  const OUTER = FRAME + BUMPER * 2;

  const belly = new THREE.Mesh(new THREE.BoxGeometry(FRAME, 0.11, FRAME), lit(0x2b2e35));
  belly.position.y = 0.115;
  robot.add(belly);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(FRAME * 0.94, 0.03, FRAME * 0.94), lit(0x3d424b));
  deck.position.y = 0.19;
  robot.add(deck);

  // A low superstructure, offset back, so the front of the robot is unmistakable from above.
  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.5), lit(0x30343c));
  tower.position.set(-0.13, 0.36, 0);
  robot.add(tower);

  const bumperMat = lit(BLUE);
  const bumperTrim = lit(0xffffff);
  const bumpers = new THREE.Group();
  for (const [w, d, x, z] of [
    [OUTER, BUMPER, 0, -(FRAME + BUMPER) / 2],
    [OUTER, BUMPER, 0, (FRAME + BUMPER) / 2],
    [BUMPER, FRAME, -(FRAME + BUMPER) / 2, 0],
    [BUMPER, FRAME, (FRAME + BUMPER) / 2, 0],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.13, d), bumperMat);
    m.position.set(x, 0.135, z);
    bumpers.add(m);
    // A pale lip along the top edge: it catches the light and gives the robot a readable silhouette
    // against both dark carpet and the pale field structures.
    const lip = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), bumperTrim);
    lip.position.set(x, 0.202, z);
    bumpers.add(lip);
  }
  robot.add(bumpers);

  for (const [x, z] of [[-0.26, -0.3], [0.26, -0.3], [-0.26, 0.3], [0.26, 0.3]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 14), lit(0x0b0c0e));
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, 0.075, z);
    robot.add(wheel);
  }

  /* The nose. Heading is what you actually read off this view, so it is the one thing on the robot
     allowed to be brand coral, and it sits proud of the bumper where nothing can hide it. */
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.26, 3), flat(0xe94560));
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(OUTER / 2 + 0.11, 0.26, 0);
  robot.add(nose);

  const noseBar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.34), flat(0xe94560));
  noseBar.position.set(OUTER / 2 - 0.02, 0.26, 0);
  robot.add(noseBar);

  /* ---- trail ---- */

  let trail = null;
  let trailPoints = 0;
  if (trailLen > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(trailLen * 3), 3));
    geo.setDrawRange(0, 0);
    trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xe94560, transparent: true, opacity: 0.6 }));
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

  /* ---- camera ---- */

  let mode = "chase";
  const target = new THREE.Vector3(0, 0, 0);
  const desired = new THREE.Vector3(0, 10, 12);
  const look = new THREE.Vector3(0, 0, 0);
  let orbit = { yaw: -Math.PI / 2, pitch: 0.72, dist: Math.max(length, width) * 0.85 };

  /* How far the chase camera has swung away from directly behind the robot to see past something.
     Eased, never snapped: a camera that jumps the instant a truss clips the sight line is more
     disorienting than the obstruction was. */
  let chaseSwing = 0;
  let swingTarget = 0;
  let lastOcclusionCheck = 0;
  const occluder = new THREE.Raycaster();
  const CANDIDATE_SWINGS = [0, 0.55, -0.55, 1.15, -1.15, 1.9, -1.9, Math.PI];

  /** True when something solid sits between a camera at this swing and the robot. */
  function blockedAt(swing) {
    const heading = robot.rotation.y + swing;
    const forward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    const from = robot.position.clone().addScaledVector(forward, -6.5).add(new THREE.Vector3(0, 5.4, 0));
    const toRobot = robot.position.clone().add(new THREE.Vector3(0, 0.25, 0)).sub(from);
    const distance = toRobot.length();
    occluder.set(from, toRobot.normalize());
    occluder.far = distance - 0.6;   // stop short so the robot itself never counts as the blocker
    return occluder.intersectObject(cad, true).length > 0;
  }

  /* Only meaningful once the CAD is loaded — the procedural outline has nothing tall enough to hide
     behind, and raycasting against it every frame would be work for no answer. */
  function updateOcclusion(now) {
    if (!cad.visible || !robot.visible || mode !== "chase") { swingTarget = 0; return; }
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

  function placeCamera(dt) {
    if (mode === "top") {
      desired.set(0, topHeight(), 0.01);
      look.set(0, 0, 0);
    } else if (mode === "chase") {
      /* High and well back, looking down at the robot rather than along the carpet. A low chase
         camera fills half the tile with sky and the other half with the square metre the robot is
         standing on, which tells a driver nothing — what they want is where they are on the field. */
      const heading = robot.rotation.y + chaseSwing;
      const forward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
      desired.copy(robot.position).addScaledVector(forward, -6.5).add(new THREE.Vector3(0, 5.4, 0));
      look.copy(robot.position).addScaledVector(forward, 2.0);
      look.y = 0.0;
      if (!robot.visible) {
        desired.set(-length * 0.34, 7.0, width * 1.05);
        look.set(0, 0, 0);
      }
    } else {
      desired.set(
        Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * orbit.dist,
        Math.sin(orbit.pitch) * orbit.dist,
        Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * orbit.dist
      );
      look.set(0, 0, 0);
    }
    /* Exponential approach: fast enough to keep up with a robot, smooth enough not to be a strobe. */
    const k = 1 - Math.exp(-dt * (mode === "top" ? 6 : 4));
    // Swing eases more slowly still — this one is a deliberate move around an obstruction, and it
    // should read as the camera choosing a better angle rather than as a glitch.
    chaseSwing += (swingTarget - chaseSwing) * (1 - Math.exp(-dt * 2.2));
    camera.position.lerp(desired, k);
    target.lerp(look, k);
    camera.lookAt(target);
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
  });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener("wheel", (e) => {
    if (mode !== "free") return;
    e.preventDefault();
    orbit.dist = Math.max(4, Math.min(48, orbit.dist * (1 + Math.sign(e.deltaY) * 0.09)));
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
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  /* ---- loop ---- */

  let raf = 0;
  let lastFrame = performance.now();
  let disposed = false;

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

  function tick(now) {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const elapsed = now - lastFrame;
    if (elapsed < FRAME_MS) return;
    lastFrame = now;
    if (!visible()) return;
    resize();
    updateOcclusion(now);
    placeCamera(Math.min(0.2, elapsed / 1000));
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  /* ---- public surface ---- */

  let lastTrailAt = 0;
  let lastAlliance = null;

  return {
    /** `state.pose` is `[x, y, theta]` in WPILib field coordinates, or null when unknown. */
    update(state) {
      /* Sizing lives here as well as in the loop. `ResizeObserver` only delivers during a rendering
         opportunity, so a tile that was laid out while the window was hidden would otherwise keep a
         stale backing-store size until the next animation frame. */
      resize();

      if (state.alliance !== lastAlliance) {
        lastAlliance = state.alliance;
        bumperMat.color.setHex(state.alliance === "red" ? RED : state.alliance === "blue" ? BLUE : 0x4d5560);
      }

      if (!state.pose) {
        robot.visible = false;
        return;
      }
      const [fx, fy, theta] = state.pose;
      const x = fx - poseLength / 2;
      const z = -(fy - poseWidth / 2);
      robot.position.set(x, 0, z);
      robot.rotation.y = -theta;
      robot.visible = true;

      /* Sample the trail on distance, not on time: a stationary robot should not stack 200 points on
         top of itself, and a fast one should not leave gaps. */
      const now = performance.now();
      if (now - lastTrailAt > 40) {
        lastTrailAt = now;
        pushTrail(x, z);
      }
    },

    setMode(next) {
      mode = next;
    },

    /** Draw one frame right now. Used when the dashboard tab comes back, so the field is current the
     *  instant it is on screen rather than one animation frame later. */
    redraw() {
      if (disposed) return;
      resize();
      placeCamera(0.25);
      renderer.render(scene, camera);
    },

    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      scene.traverse((obj) => {
        obj.geometry?.dispose?.();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material?.dispose?.();
      });
      renderer.dispose();
      /* Release the GL context outright. Browsers cap how many a page may hold, and a driver who
         rearranges their layout a dozen times should not hit that cap. */
      renderer.forceContextLoss?.();
    },
  };
}
