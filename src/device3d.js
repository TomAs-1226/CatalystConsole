/* The devices on the robot, drawn as the objects they are.
 *
 * A camera in a list is a row of text. The same camera turning slowly on a stage is the thing bolted to
 * the robot, and somebody who has never seen one can match it to the part in their hand - which is the
 * whole job of a pit screen. Tesla draws the car, then the wheel, then the tyre; this draws the robot,
 * then the camera on it.
 *
 * The models are the vendors' own published CAD, baked by `npm run device-cad` into src/vendor/devices
 * and gitignored, so nothing third-party is checked in. A console without them simply shows the list.
 *
 * Everything here is on demand: no renderer exists until a panel asks for one, and the loop sleeps the
 * moment nothing is moving. A settings panel is not a place to leave a graphics chip running.
 */

import * as THREE from "./vendor/three.module.min.js";

/* A device turns at the pace of a shop turntable: visibly alive, slow enough to read the part by. */
const TURN_RATE = (9 * Math.PI) / 180;
const FRAME_MS = 1000 / 30;
const FOV = 30;

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

/**
 * A device on a small stage in `canvas`. Returns `{ show, setActive, dispose }`; `show(device)` takes an
 * entry from the manifest and loads its model the first time it is asked for.
 */
export function createDeviceStage(canvas, { reduced = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setClearAlpha(0);
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.01, 10);
  /* Close, low and off to one side: a part photographed on a bench rather than surveyed from above. */
  camera.position.set(0.21, 0.115, 0.17);
  camera.lookAt(0, 0.028, 0);

  /* The robot's own studio, scaled down to a part: a low ambient, a key over the camera's shoulder and a
     cool rim behind that draws the edge out of a dark panel. */
  scene.add(new THREE.HemisphereLight(0xffffff, 0x0b0b0c, 0.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(0.3, 0.5, 0.3);
  const rim = new THREE.DirectionalLight(0xdae3f4, 2.2);
  rim.position.set(-0.3, 0.2, -0.35);
  scene.add(key, rim);

  const turntable = new THREE.Group();
  scene.add(turntable);

  const loaded = new Map();
  let shown = null;
  let angle = 0;
  let raf = 0;
  let active = false;
  let disposed = false;
  let lastFrame = -Infinity;
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

  function tick(now) {
    raf = 0;
    if (!active || disposed) return;
    if (now - lastFrame < FRAME_MS - 2) {
      raf = requestAnimationFrame(tick);
      return;
    }
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    resize();
    if (!sized.w || !sized.h) return;
    if (!reduced) angle += TURN_RATE * dt;
    turntable.rotation.y = angle;
    renderer.render(scene, camera);
    /* Still turning, so the next frame is wanted. Reduced motion draws it once and stops. */
    if (!reduced) raf = requestAnimationFrame(tick);
  }

  function wake() {
    if (!active || disposed || raf) return;
    lastFrame = performance.now() - FRAME_MS;
    raf = requestAnimationFrame(tick);
  }

  const observer = new ResizeObserver(() => {
    if (resize()) wake();
  });
  observer.observe(canvas);

  return {
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
          /* The console's own grey, not whatever the CAD was exported with. */
          model.traverse((o) => {
            if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0x9a9aa0, roughness: 0.42, metalness: 0.55 });
          });
          /* Stood on the middle of the turntable and sized so any part fills the same amount of frame:
             a Limelight and a motor controller are different sizes and both want to be seen. */
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const fit = 0.1 / Math.max(size.x, size.z, 1e-6);
          model.scale.setScalar(fit);
          model.position.set(-((box.max.x + box.min.x) / 2) * fit, -box.min.y * fit, -((box.max.z + box.min.z) / 2) * fit);
          loaded.set(device.id, model);
        } catch (err) {
          console.warn(`no model for ${device.id}`, err);
          return false;
        }
      }
      if (disposed) return false;
      turntable.clear();
      turntable.add(model);
      shown = device.id;
      wake();
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
      for (const model of loaded.values()) {
        model.traverse((o) => {
          if (!o.isMesh) return;
          o.geometry?.dispose();
          o.material?.dispose();
        });
      }
      loaded.clear();
      renderer.dispose();
    },
  };
}
