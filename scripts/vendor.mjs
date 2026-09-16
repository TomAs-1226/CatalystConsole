// Copies the handful of third-party files we ship into src/vendor.
//
// The app loads them from disk, not a CDN: the webview runs under a strict CSP with
// `script-src 'self'`, and a dashboard that needs the internet to draw a field is a dashboard that
// fails in exactly the venue it is meant for.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "src/vendor");
mkdirSync(out, { recursive: true });

// The two examples keep three's own folder layout. GLTFLoader imports
// `../utils/BufferGeometryUtils.js`, so flattening them put that import at src/utils/, outside
// vendor, and the browser answered 404 — the loader then failed on exactly the field models it is
// there to read. Both still resolve bare "three" through the import map in index.html.
const files = [
  ["node_modules/three/build/three.module.min.js", "three.module.min.js"],
  ["node_modules/three/examples/jsm/loaders/GLTFLoader.js", "loaders/GLTFLoader.js"],
  ["node_modules/three/examples/jsm/utils/BufferGeometryUtils.js", "utils/BufferGeometryUtils.js"],
];

for (const [from, to] of files) {
  const target = resolve(out, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, from), target);
  console.log(`vendored ${to}`);
}
