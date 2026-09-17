// Render src/vendor/robot.glb to PNGs, so the model and its manifest can be checked by eye.
//
//   npm run robot-cad-preview                         # standard views into .robot-cad-preview/
//   npm run robot-cad-preview -- --out some/dir       # somewhere else
//   npm run robot-cad-preview -- --glb x.glb --manifest x.json --views views.json
//
// three.js draws the model in headless Edge (software WebGL is fine), served by a throwaway local HTTP
// server; the DevTools protocol drives the page. Every view is rendered twice where it helps: the model
// alone, and the model with the manifest drawn over it (pivot axes, roller axes, the hopper's ball box,
// the bumper outline, module positions, the shot's exit direction), because a pivot in the wrong place
// or an axis pointing the wrong way is obvious in a picture and invisible in a JSON file.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/microsoft-edge",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".glb": "model/gltf-binary" };

/* The standard set. Cameras are in the robot frame: x forward, y up, z right, metres. */
export function standardViews(manifest) {
  const b = manifest?.bounds ?? { min: [-0.45, 0, -0.4], max: [0.45, 0.6, 0.4] };
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const views = [];
  const both = (v) => {
    views.push({ ...v, gizmos: false });
    views.push({ ...v, name: `${v.name}-gizmos`, gizmos: true });
  };
  both({ name: "three-quarter-front-left", camera: { position: [c[0] + 1.35 * span, c[1] + 0.95 * span, c[2] - 1.25 * span], target: c, fov: 30 } });
  both({ name: "side-left", camera: { position: [c[0], c[1], c[2] - 3], target: c, ortho: span * 0.62 } });
  both({ name: "front", camera: { position: [c[0] + 3, c[1], c[2]], target: c, ortho: span * 0.62 } });
  both({ name: "top", camera: { position: [c[0], c[1] + 3, c[2]], target: c, up: [1, 0, 0], ortho: span * 0.62 } });
  both({ name: "three-quarter-rear-right", camera: { position: [c[0] - 1.35 * span, c[1] + 0.95 * span, c[2] + 1.25 * span], target: c, fov: 30 } });

  const hood = manifest?.hood;
  if (hood) {
    const p = hood.pivot;
    for (const deg of [hood.min ?? 13, hood.max ?? 45]) {
      views.push({
        name: `hood-${deg}deg-side-left`,
        gizmos: true,
        poses: { hood: deg },
        clip: { normal: [0, 0, 1], constant: -p[2] + 0.02 },
        camera: { position: [p[0], p[1], p[2] - 3], target: [p[0], p[1] - 0.08, p[2]], ortho: 0.3 },
      });
    }
    views.push({
      name: "hood-cad-side-left",
      gizmos: true,
      poses: {},
      clip: { normal: [0, 0, 1], constant: -p[2] + 0.02 },
      camera: { position: [p[0], p[1], p[2] - 3], target: [p[0], p[1] - 0.08, p[2]], ortho: 0.3 },
    });
  }
  const intake = manifest?.intake;
  if (intake) {
    for (const [label, x] of [["stowed", 0], ["deployed", intake.travel]]) {
      views.push({ name: `intake-${label}-side-left`, gizmos: true, poses: { intake: x }, camera: { position: [c[0], c[1], c[2] - 3], target: c, ortho: span * 0.62 } });
      views.push({ name: `intake-${label}-three-quarter`, gizmos: false, poses: { intake: x }, camera: { position: [c[0] + 1.35 * span, c[1] + 0.95 * span, c[2] - 1.25 * span], target: c, fov: 30 } });
    }
  }
  if (manifest?.modules?.length) {
    views.push({
      name: "modules-steered-top",
      gizmos: true,
      poses: { steer: { fl: 45, fr: -45, bl: 135, br: -135 } },
      camera: { position: [c[0], c[1] + 3, c[2]], target: c, up: [1, 0, 0], ortho: span * 0.62 },
    });
  }
  return views;
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#fff}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
</head><body>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const W = Number(new URLSearchParams(location.search).get("w") || 1400);
const H = Number(new URLSearchParams(location.search).get("h") || 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.localClippingEnabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2f2f0);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xffffff, 0x888880, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(2, 4, -1.5);
scene.add(sun);

const grid = new THREE.GridHelper(2, 20, 0xb8b8b8, 0xd8d8d8);
scene.add(grid);

const manifest = await (await fetch("/manifest.json")).json().catch(() => null);
const gltf = await new GLTFLoader().loadAsync("/model.glb");
const model = gltf.scene;
scene.add(model);

const rest = new Map();
model.traverse((o) => rest.set(o, { p: o.position.clone(), q: o.quaternion.clone() }));
const clipPlanes = [];
model.traverse((o) => {
  if (o.isMesh) {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) { m.clippingPlanes = clipPlanes; m.clipShadows = true; m.side = THREE.DoubleSide; }
  }
});

/* ---- gizmos drawn from the manifest ---- */
const gizmos = new THREE.Group();
scene.add(gizmos);
const line = (points, color, width = 1) => {
  const g = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  l.renderOrder = 10;
  return l;
};
const axisLine = (point, dir, half, color) => {
  const p = new THREE.Vector3(...point), d = new THREE.Vector3(...dir).normalize().multiplyScalar(half);
  return line([p.clone().sub(d).toArray(), p.clone().add(d).toArray()], color);
};
const dot = (point, color, r = 0.008) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.set(...point);
  m.renderOrder = 11;
  return m;
};
const arrow = (from, dir, len, color) => {
  const a = new THREE.ArrowHelper(new THREE.Vector3(...dir).normalize(), new THREE.Vector3(...from), len, color, 0.04, 0.02);
  a.traverse((o) => { if (o.material) { o.material.depthTest = false; o.renderOrder = 12; } });
  return a;
};
const boxLines = (min, max, color) => {
  const b = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
  const h = new THREE.Box3Helper(b, color);
  h.material.depthTest = false;
  h.renderOrder = 10;
  return h;
};
/* Gizmos that ride on a moving node are parented to it, so a pose moves them with the part. */
const byName = (name) => (name ? model.getObjectByName(name) : null);
const attach = (object, nodeName) => {
  const node = byName(nodeName);
  if (!node) { gizmos.add(object); return; }
  /* Manifest geometry is in the robot frame with the model at rest; convert into the node's frame. */
  model.updateMatrixWorld(true);
  const inv = node.matrixWorld.clone().invert();
  object.applyMatrix4(inv);
  const holder = new THREE.Group();
  holder.add(object);
  holder.userData.gizmo = true;
  node.add(holder);
  nodeGizmos.push(holder);
};
const nodeGizmos = [];
if (manifest) {
  const f = manifest.frame;
  if (f) {
    const y0 = f.bottom ?? 0.03, y1 = f.top ?? 0.08;
    for (const y of [y0, y1]) {
      const L = f.length / 2, Wd = f.width / 2;
      gizmos.add(line([[L, y, -Wd], [L, y, Wd], [-L, y, Wd], [-L, y, -Wd], [L, y, -Wd]], 0x0a84ff));
    }
  }
  const bum = manifest.bumpers;
  if (bum) {
    for (const y of [bum.bottom, bum.bottom + bum.height]) {
      const L = bum.length / 2, Wd = bum.width / 2;
      gizmos.add(line([[L, y, -Wd], [L, y, Wd], [-L, y, Wd], [-L, y, -Wd], [L, y, -Wd]], 0xff2d55));
    }
    for (const m of bum.mounts || []) gizmos.add(dot(m.position, 0xff2d55, 0.007));
  }
  for (const m of manifest.modules || []) {
    const steer = byName(m.steerNode);
    gizmos.add(dot(m.position, 0x34c759, 0.01));
    gizmos.add(axisLine([m.position[0], 0.15, m.position[2]], [0, 1, 0], 0.15, 0x34c759));
    if (m.wheelAxis) attach(axisLine(m.wheelCenter, m.wheelAxis, 0.05, 0x34c759), m.steerNode);
  }
  const hood = manifest.hood;
  if (hood) {
    gizmos.add(axisLine(hood.pivot, hood.axis, 0.42, 0xff9500));
    gizmos.add(dot(hood.pivot, 0xff9500, 0.01));
  }
  const intake = manifest.intake;
  if (intake) {
    gizmos.add(arrow(intake.origin, intake.axis, Math.max(intake.travel, 0.1), 0xaf52de));
    gizmos.add(dot(intake.origin, 0xaf52de, 0.01));
  }
  for (const r of manifest.rollers || []) attach(axisLine(r.center, r.axis, (r.length ?? 0.5) / 2 + 0.03, 0x5ac8fa), r.parent === "robot" ? null : r.parent);
  for (const box of manifest.hopper?.boxes || []) gizmos.add(boxLines(box.min, box.max, 0xffcc00));
  const shooter = manifest.shooter;
  if (shooter?.exit) attach(arrow(shooter.exit.point, shooter.exit.direction, 0.35, 0xff3b30), "hood");
  if (shooter?.exit) attach(dot(shooter.exit.point, 0xff3b30, 0.01), "hood");
  const mouth = manifest.intakeMouth;
  if (mouth) {
    const c = mouth.center, h = mouth.width / 2;
    attach(line([[c[0], c[1], c[2] - h], [c[0], c[1], c[2] + h]], 0xaf52de), "intake");
  }
}

const posesOf = (poses) => {
  for (const [o, r] of rest) { o.position.copy(r.p); o.quaternion.copy(r.q); }
  if (!manifest || !poses) return;
  if (poses.hood !== undefined && manifest.hood) {
    const node = byName(manifest.hood.node);
    const delta = THREE.MathUtils.degToRad(poses.hood - manifest.hood.cadAngle);
    node.quaternion.copy(rest.get(node).q).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...manifest.hood.axis), delta));
  }
  if (poses.intake !== undefined && manifest.intake) {
    const node = byName(manifest.intake.node);
    node.position.fromArray(manifest.intake.origin).addScaledVector(new THREE.Vector3(...manifest.intake.axis), poses.intake);
  }
  if (poses.steer && manifest.modules) {
    for (const m of manifest.modules) {
      const deg = poses.steer[m.name];
      if (deg === undefined) continue;
      const node = byName(m.steerNode);
      node.quaternion.copy(rest.get(node).q).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg - m.cadSteerAngle)));
    }
  }
};

window.renderView = (spec) => {
  posesOf(spec.poses);
  gizmos.visible = !!spec.gizmos;
  for (const g of nodeGizmos) g.visible = !!spec.gizmos;
  grid.visible = spec.grid !== false;
  clipPlanes.length = 0;
  for (const c of [].concat(spec.clip || [])) clipPlanes.push(new THREE.Plane(new THREE.Vector3(...c.normal), c.constant));
  const cam = spec.camera;
  let camera;
  if (cam.ortho) {
    const h = cam.ortho, w = h * (W / H);
    camera = new THREE.OrthographicCamera(-w, w, h, -h, 0.01, 20);
  } else {
    camera = new THREE.PerspectiveCamera(cam.fov || 35, W / H, 0.01, 20);
  }
  camera.position.set(...cam.position);
  camera.up.set(...(cam.up || [0, 1, 0]));
  camera.lookAt(new THREE.Vector3(...cam.target));
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL("image/png");
};
window.modelInfo = () => {
  const names = [];
  model.traverse((o) => { if (o.name) names.push(o.name); });
  let tris = 0;
  model.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return { names, tris };
};
window.ready = true;
</script></body></html>`;

function serve({ glb, manifest }) {
  const threeRoot = join(root, "node_modules", "three");
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      try {
        if (url.pathname === "/" || url.pathname === "/index.html") {
          res.writeHead(200, { "content-type": TYPES[".html"] }).end(PAGE);
        } else if (url.pathname === "/model.glb") {
          res.writeHead(200, { "content-type": TYPES[".glb"] }).end(readFileSync(glb));
        } else if (url.pathname === "/manifest.json") {
          const body = manifest && existsSync(manifest) ? readFileSync(manifest) : "null";
          res.writeHead(200, { "content-type": TYPES[".json"] }).end(body);
        } else if (url.pathname.startsWith("/three/")) {
          const file = resolve(threeRoot, "." + url.pathname.slice("/three".length));
          if (!file.startsWith(threeRoot)) throw new Error("outside three");
          res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(readFileSync(file));
        } else {
          res.writeHead(404).end();
        }
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function renderViews({ glb, manifest, views, outDir, width = 1400, height = 1000, log = console.log }) {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) throw new Error("Microsoft Edge not found; set EDGE_PATH to a Chromium-based browser");
  mkdirSync(outDir, { recursive: true });
  const server = await serve({ glb, manifest });
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = join(tmpdir(), `robot-cad-preview-${process.pid}-${port}`);
  const browser = spawn(edge, [
    "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", `--window-size=${width},${height}`, "about:blank",
  ], { stdio: "ignore" });
  const written = [];
  try {
    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
      await sleep(150);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === "page");
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error("headless Edge did not start");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    let seq = 0;
    const pending = new Map();
    const problems = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
      if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    };
    const send = (method, params = {}) => new Promise((ok) => {
      const id = ++seq;
      pending.set(id, ok);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      return r.result?.result?.value;
    };
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?w=${width}&h=${height}` });
    for (let i = 0; i < 400; i++) {
      await sleep(100);
      if (problems.length) throw new Error(`page failed: ${problems.join(" | ")}`);
      if (await evaluate("window.ready === true").catch(() => false)) break;
      if (i === 399) throw new Error("page never became ready");
    }
    const info = await evaluate("window.modelInfo()");
    log(`preview: ${info.tris.toLocaleString("en-US")} triangles on screen`);
    for (const view of views) {
      const dataUrl = await evaluate(`window.renderView(${JSON.stringify(view)})`);
      const file = join(outDir, `${view.name}.png`);
      writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
      written.push(file);
      log(`  ${file}`);
    }
    if (problems.length) log(`page reported: ${problems.join(" | ")}`);
    ws.close();
  } finally {
    browser.kill();
    server.close();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold it */ }
  }
  return written;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const glb = resolve(opt("glb", join(root, "src", "vendor", "robot.glb")));
  const manifest = resolve(opt("manifest", join(root, "src", "vendor", "robot.json")));
  const outDir = resolve(opt("out", join(root, ".robot-cad-preview")));
  if (!existsSync(glb)) {
    console.error(`No model at ${glb}; run npm run robot-cad first.`);
    process.exit(1);
  }
  const manifestJson = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : null;
  const viewsFile = opt("views", null);
  const views = viewsFile ? JSON.parse(readFileSync(viewsFile, "utf8")) : standardViews(manifestJson);
  const width = Number(opt("width", 1400));
  const height = Number(opt("height", 1000));
  await renderViews({ glb, manifest: existsSync(manifest) ? manifest : null, views, outDir, width, height });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
}
