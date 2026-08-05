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

const files = [["node_modules/three/build/three.module.min.js", "three.module.min.js"]];

for (const [from, to] of files) {
  copyFileSync(resolve(root, from), resolve(out, to));
  console.log(`vendored ${to}`);
}
