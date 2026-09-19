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
  // A skinned mesh cloned the ordinary way keeps pointing at the original skeleton, so every copy of the
  // driver would move together. This is the clone that rebinds one.
  ["node_modules/three/examples/jsm/utils/SkeletonUtils.js", "utils/SkeletonUtils.js"],
  // The interface face. Console is drawn after Tesla's in-car screens, whose own typeface is
  // proprietary; Figtree is the openly licensed face nearest it in proportion and weight. Two subsets,
  // Latin and Latin Extended, so an event or team name with an accent does not fall back mid-word.
  // The licence travels with the files, as the SIL Open Font License requires.
  ["node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2", "fonts/figtree-latin-wght-normal.woff2"],
  ["node_modules/@fontsource-variable/figtree/files/figtree-latin-ext-wght-normal.woff2", "fonts/figtree-latin-ext-wght-normal.woff2"],
  ["node_modules/@fontsource-variable/figtree/LICENSE", "fonts/FIGTREE-LICENSE.txt"],
];

for (const [from, to] of files) {
  const target = resolve(out, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, from), target);
  console.log(`vendored ${to}`);
}
