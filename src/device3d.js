/* The devices on the robot, drawn as the objects they are.
 *
 * A camera in a list is a row of text. The same camera on a stage is the thing bolted to the robot, and
 * somebody who has never seen one can match it to the part in their hand - which is the whole job of a
 * pit screen. Tesla draws the car, then the wheel, then the tyre; this draws the robot, then the camera
 * on it, then the controller it plugs into.
 *
 * The models are the vendors' own: published CAD for the Limelights, and for the Systemcore - which has
 * none published - the model its own web interface draws, read out of the OS image the team flashes.
 * `npm run device-cad` bakes them into src/vendor/devices, which is gitignored, so nothing third-party
 * is checked in. A console without them simply shows the list.
 *
 * One stage, used for every one of them: the robot on its spec sheet too. Everything stands on Park's
 * floor under Park's studio, at its real size, with the camera backed off until it fits.
 *
 * Nothing here draws unless something is moving. A new thing on the stage turns into its resting angle
 * once, the way a turntable presents a car, and stops; a drag turns it and it coasts to rest; a hidden
 * panel draws nothing at all. A settings page is not a place to leave a graphics chip running.
 */

import * as THREE from "./vendor/three.module.min.js";
import { studioEnvironment, studioLights } from "./robot3d.js";
import { FLOOR_FRAGMENT, FLOOR_VERTEX } from "./stagefloor.js";

/* A long lens, as a product is photographed, and the same one Park uses. */
const FOV = 30;
/* The camera looks down at this angle, radians above the horizon. */
const ELEVATION = 0.34;
/* The turn a stage makes to present something new: it starts this far short of its resting angle and
   eases into it. Long enough to read as a turntable, short enough to be over before anyone waits on it. */
const PRESENT_FROM = -0.75;
const PRESENT_MS = 1500;
/* Radians of turn per pixel dragged, how quickly a released stage slows (per second), and the speed at
   which a coast is done. */
const DRAG_RATE = 0.0085;
const FRICTION = 3.5;
const REST_SPEED = 0.03;

const CLAY = { color: 0x8e8e93, roughness: 0.42, metalness: 0.55 };

/** The baked manifest, once per page, or null when nothing has been baked. */
let loading = null;
export function loadDevices() {
  loading ??= (async () => {
    const response = await fetch("./vendor/devices.json").catch(() => null);
    if (!response || !response.ok) return null;
    const manifest = await response.json();
    return manifest?.version === 1 && Array.isArray(manifest.devices) ? manifest : null;
  })().catch(() => null);
  return loading;
}

/**
 * Which baked device a thing on the robot is, by its name. A camera called "limelight-left" is a
 * Limelight; one called "front" is nothing this console has a model of, and saying so is the right
 * answer rather than drawing the nearest thing and hoping.
 */
export function deviceFor(manifest, name) {
  if (!manifest || !name) return null;
  const plain = String(name).toLowerCase();
  let best = null;
  for (const device of manifest.devices) {
    for (const hint of device.match ?? []) {
      /* The longest hint that matches wins, so "limelight4" beats the "limelight" that would also match
         it and the console draws the model the robot actually has. */
      if (plain.includes(hint) && (!best || hint.length > best.hint.length)) best = { device, hint };
    }
  }
  return best?.device ?? null;
}

/** The baked device with this id, or null. */
export function deviceById(manifest, id) {
  return manifest?.devices.find((device) => device.id === id) ?? null;
}

/* A grid pitch that reads at this size: 1, 2.5 or 5 of a power of ten, near a quarter of the thing. */
function gridPitch(size) {
  const want = size / 4;
  const power = 10 ** Math.floor(Math.log10(want));
  return [1, 2.5, 5, 10].map((step) => step * power).reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}

/**
 * A stage in `canvas`. Returns
 * `{ show(device), showModel(object, opts), environment, maxAnisotropy, showing, setActive, dispose }`.
 *
 * showModel's options: `lights`, a group to light the stage with in place of the studio's own (the robot
 * brings the same rig, already turned for its reflections); `step(now)`, called each frame and returning
 * true while the object is still animating itself; `rest`, the angle it comes to rest at, radians about
 * the vertical; `grid`, whether the floor carries Park's grid; `margin`, how much room the frame leaves.
 */
export function createDeviceStage(canvas, { reduced = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.01, 10);

  /* The studio: its reflections, made once and lent to anything that asks, and its lights. */
  let environment = null;
  const ownEnvironment = () => {
    environment ??= studioEnvironment(renderer);
    return environment;
  };
  const ownLights = studioLights();
  let lights = ownLights;
  scene.add(ownLights);

  /* Park's floor, on the turntable with the thing so the contact shadow turns under it. */
  const style = getComputedStyle(document.documentElement);
  const token = (name, fallback) => {
    const value = style.getPropertyValue(name).trim();
    if (value) {
      const colour = new THREE.Color(NaN, NaN, NaN).setStyle(value);
      if (Number.isFinite(colour.r) && Number.isFinite(colour.g) && Number.isFinite(colour.b)) return colour;
    }
    return new THREE.Color(fallback);
  };
  const floorUniforms = {
    uFloor: { value: token("--park-floor", "#2c2c2e") },
    uGrid: { value: token("--park-grid", "#48484a") },
    uRadius: { value: 1 },
    uCell: { value: 0.25 },
    uLine: { value: 0 },
    uFootprint: { value: new THREE.Vector2(0.1, 0.1) },
    uCorner: { value: 0.02 },
    uOpacity: { value: 1 },
  };
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: floorUniforms,
      vertexShader: FLOOR_VERTEX,
      fragmentShader: FLOOR_FRAGMENT,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.renderOrder = -1;
  floor.visible = false;

  const turntable = new THREE.Group();
  turntable.add(floor);
  scene.add(turntable);

  const loaded = new Map();
  let shown = null;
  let shownObject = null;
  let framing = null;
  let step = null;
  let rest = 0;
  let angle = 0;
  let present = null;
  let velocity = 0;
  let drag = null;
  let raf = 0;
  let active = false;
  let disposed = false;
  let last = 0;
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
    frame();
    return true;
  }

  /* Frame the thing as it turns. Everything it can sweep is a cylinder about the vertical, as wide as
     the farthest corner of its footprint and as tall as it is, so the camera backs off until that whole
     cylinder is in shot - the thing never leaves the frame however it is turned - and aims so the
     cylinder sits in the middle of the picture rather than wherever its centre happens to fall. */
  const ring = Array.from({ length: 48 }, () => new THREE.Vector3());
  const probe = new THREE.Vector3();
  function frame() {
    camera.updateProjectionMatrix();
    if (!framing) return;
    const { reach, height, margin } = framing;
    ring.forEach((p, i) => {
      const a = (Math.floor(i / 2) / 24) * Math.PI * 2;
      p.set(Math.cos(a) * reach, i % 2 ? height : 0, Math.sin(a) * reach);
    });
    const place = (distance, aim) => {
      camera.near = distance / 50;
      camera.far = distance * 4 + reach * 8;
      camera.position.set(0, aim + Math.sin(ELEVATION) * distance, Math.cos(ELEVATION) * distance);
      camera.lookAt(0, aim, 0);
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
    };
    const spread = () => {
      let low = Infinity;
      let high = -Infinity;
      let side = 0;
      for (const p of ring) {
        probe.copy(p).project(camera);
        low = Math.min(low, probe.y);
        high = Math.max(high, probe.y);
        side = Math.max(side, Math.abs(probe.x));
      }
      return { low, high, side };
    };
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    let aim = height / 2;
    let distance = reach * 4;
    for (let pass = 0; pass < 3; pass++) {
      /* The nearest camera that still has all of it in shot, by halving. */
      let near = reach * 1.5;
      let far = reach * 60 + height * 60;
      for (let i = 0; i < 28; i++) {
        const mid = (near + far) / 2;
        place(mid, aim);
        const { low, high, side } = spread();
        if (Math.max(side, Math.abs(low), Math.abs(high)) <= margin) far = mid;
        else near = mid;
      }
      distance = far;
      place(distance, aim);
      /* Then aim at the middle of what the camera sees of it. */
      const { low, high } = spread();
      aim += ((low + high) / 2) * distance * tanHalf * Math.cos(ELEVATION);
    }
    place(distance, aim);
  }

  function tick(now) {
    raf = 0;
    if (!active || disposed) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    resize();
    if (!sized.w || !sized.h) return;

    let moving = false;
    if (present) {
      present.start ??= now;
      const u = Math.min(1, (now - present.start) / PRESENT_MS);
      /* Ease out: a turntable already turning, slowing into place. */
      angle = rest + present.from * (1 - u) ** 3;
      moving = u < 1;
      if (!moving) present = null;
    } else if (!drag && velocity !== 0) {
      angle += velocity * dt;
      velocity *= Math.exp(-FRICTION * dt);
      if (Math.abs(velocity) < REST_SPEED) velocity = 0;
      moving = velocity !== 0;
    }
    if (step?.(now)) moving = true;

    turntable.rotation.y = angle;
    renderer.render(scene, camera);
    if (moving) raf = requestAnimationFrame(tick);
  }

  /** Draw the next frame, and keep drawing for as long as something moves. */
  function wake() {
    if (!active || disposed || raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  const observer = new ResizeObserver(() => {
    if (resize()) wake();
  });
  observer.observe(canvas);

  /* A drag turns the stage and a flick sets it coasting. Only sideways: the page still scrolls under a
     vertical swipe (touch-action in the stylesheet). */
  canvas.addEventListener("pointerdown", (event) => {
    if (!shownObject || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    present = null;
    velocity = 0;
    drag = { id: event.pointerId, x: event.clientX, t: event.timeStamp, v: 0 };
    canvas.dataset.dragging = "true";
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dt = Math.max(1, event.timeStamp - drag.t) / 1000;
    angle += dx * DRAG_RATE;
    /* Velocity smoothed over the last few moves, so the coast follows the flick rather than whichever
       single event happened to come last. */
    drag.v = drag.v * 0.6 + ((dx * DRAG_RATE) / dt) * 0.4;
    drag.x = event.clientX;
    drag.t = event.timeStamp;
    turntable.rotation.y = angle;
    if (!raf) {
      /* One frame per move, drawn on the next animation frame rather than inside the event. */
      wake();
    }
  });
  const release = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    /* A finger held still before it lifts is a placement, not a flick. */
    const still = event.timeStamp - drag.t > 80;
    velocity = reduced || still ? 0 : THREE.MathUtils.clamp(drag.v, -8, 8);
    drag = null;
    delete canvas.dataset.dragging;
    wake();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  /* Double-click puts it back where it rests. */
  canvas.addEventListener("dblclick", () => {
    if (!shownObject) return;
    velocity = 0;
    const off = Math.atan2(Math.sin(angle - rest), Math.cos(angle - rest));
    present = reduced ? null : { from: off, start: null };
    angle = rest + (reduced ? 0 : off);
    wake();
  });

  /** Put any object on the stage at its real size, and frame the camera to it. */
  function showModel(object, { lights: bring = null, step: stepper = null, rest: restAt = 0, grid = false, margin = 1 } = {}) {
    if (disposed) return;
    const fresh = object !== shownObject;

    /* Measured where it stands alone, at its own size: measured on the turntable, the turntable's turn
       would be in the box, and measured after an earlier fit, that fit would be. */
    object.removeFromParent();
    object.position.set(0, 0, 0);
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    object.position.set(-(box.max.x + box.min.x) / 2, -box.min.y, -(box.max.z + box.min.z) / 2);

    if (fresh && shownObject) turntable.remove(shownObject);
    turntable.add(object);
    shownObject = object;
    step = stepper;

    /* The farthest corner of the footprint from the axis it turns about, which is the middle of it. */
    framing = { reach: Math.hypot(size.x, size.z) / 2, height: size.y, margin };
    /* The floor's shader works in the plane's own units, so the plane is made to the size wanted rather
       than scaled to it. */
    const reach = Math.max(size.x, size.z);
    const floorRadius = reach * 2.2;
    if (floorUniforms.uRadius.value !== floorRadius) {
      floor.geometry.dispose();
      floor.geometry = new THREE.PlaneGeometry(floorRadius * 2, floorRadius * 2);
      floorUniforms.uRadius.value = floorRadius;
    }
    floorUniforms.uFootprint.value.set(size.x / 2, size.z / 2);
    floorUniforms.uCorner.value = Math.min(size.x, size.z) * 0.12;
    const pitch = grid ? gridPitch(reach) : 0.25;
    floorUniforms.uCell.value = pitch;
    floorUniforms.uLine.value = grid ? pitch * 0.016 : 0;
    floor.visible = true;

    const wanted = bring ?? ownLights;
    if (wanted !== lights) {
      scene.remove(lights);
      scene.add(wanted);
      lights = wanted;
    }
    scene.environment = ownEnvironment().texture;

    frame();
    if (fresh) {
      rest = restAt;
      velocity = 0;
      angle = rest + (reduced ? 0 : PRESENT_FROM);
      present = reduced ? null : { from: PRESENT_FROM, start: null };
    }
    turntable.rotation.y = angle;
    wake();
  }

  return {
    showModel,
    /** The studio reflections this stage lights with, for a model that sets its own (see robot3d.js). */
    get environment() {
      return ownEnvironment().texture;
    },
    /** For a model's fabric weave, which is seen at a glancing angle. */
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    /** Put `device` on the stage, loading it if this is the first time. */
    async show(device) {
      if (disposed || !device) return false;
      if (shown === device.id) return true;
      let model = loaded.get(device.id);
      if (!model) {
        try {
          const { GLTFLoader } = await import("./vendor/loaders/GLTFLoader.js");
          const gltf = await new GLTFLoader().loadAsync(`./vendor/${device.file}`);
          model = gltf.scene;
          /* A model baked with its maker's finishes keeps them. One baked from bare geometry is drawn in
             the console's clay, one material for all of it rather than one per mesh. */
          if (device.finish !== "cad") {
            const clay = new THREE.MeshStandardMaterial(CLAY);
            model.traverse((o) => {
              if (!o.isMesh) return;
              o.material?.dispose?.();
              o.material = clay;
            });
          }
          loaded.set(device.id, model);
        } catch (err) {
          console.warn(`no model for ${device.id}`, err);
          return false;
        }
      }
      if (disposed) return false;
      showModel(model, { rest: device.rest ?? 0.6, margin: device.margin ?? 0.84 });
      shown = device.id;
      return true;
    },
    get showing() {
      return shown;
    },
    setActive(next) {
      active = Boolean(next);
      if (active) wake();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    dispose() {
      disposed = true;
      active = false;
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      const materials = new Set();
      for (const model of loaded.values()) {
        model.traverse((o) => {
          if (!o.isMesh) return;
          o.geometry?.dispose();
          for (const m of [].concat(o.material)) materials.add(m);
        });
      }
      for (const m of materials) m?.dispose?.();
      loaded.clear();
      floor.geometry.dispose();
      floor.material.dispose();
      environment?.dispose();
      renderer.dispose();
    },
  };
}
