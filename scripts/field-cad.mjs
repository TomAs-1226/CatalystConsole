// Bake the official REBUILT field model into something a dashboard can carry.
//
// FIRST ships the field as a SolidWorks assembly with a glTF binary alongside it, in the KOP CAD
// download. That .glb is 223 MB and 6.8 million vertices — a beautiful marketing asset and a terrible
// dashboard one. This decimates it to roughly 190k vertices and 6 MB, which renders at 30 fps in a
// tile without the driver station noticing.
//
//   npm run field-cad                       # looks in ~/Downloads for Field_2026.zip
//   npm run field-cad -- path/to/Field.zip  # or point it at one
//
// The result lands in src/vendor/field.glb and is NOT committed: it is FIRST's model, not ours, and
// every team already has the download. Without it the field view falls back to the procedural outline,
// which is drawn from the published dimensions and works fine.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "src", "vendor");
const scratch = join(root, ".field-cad");

const zipPath =
  process.argv[2] || join(homedir(), "Downloads", "Field_2026.zip");

if (!existsSync(zipPath)) {
  console.error(`No field CAD at ${zipPath}`);
  console.error("Download the KOP field CAD from https://www.firstinspires.org/resources/library/frc/playing-field");
  console.error("then re-run, optionally passing the zip path as an argument.");
  process.exit(1);
}

mkdirSync(vendor, { recursive: true });
mkdirSync(scratch, { recursive: true });

// PowerShell's Expand-Archive is everywhere on Windows and needs no dependency; `unzip` covers the
// rest. Either way we only want the one .glb out of ~933 entries.
console.log(`extracting the field model from ${zipPath} …`);
const isWindows = process.platform === "win32";
if (isWindows) {
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
        `$a=[System.IO.Compression.ZipFile]::OpenRead('${zipPath}'); ` +
        `$e=$a.Entries | Where-Object { $_.FullName -like '*.glb' } | Select-Object -First 1; ` +
        `if(-not $e){ throw 'no .glb inside the archive' }; ` +
        `[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,'${join(scratch, "field-raw.glb")}',$true); ` +
        `$a.Dispose()`,
    ],
    { stdio: "inherit" }
  );
} else {
  execFileSync("sh", ["-c", `unzip -o -j '${zipPath}' '*.glb' -d '${scratch}' && mv '${scratch}'/*.glb '${join(scratch, "field-raw.glb")}'`], {
    stdio: "inherit",
  });
}

/* prune/dedup/weld/simplify, then quantize. Quantization is deliberate: three.js reads
   KHR_mesh_quantization in core, whereas Draco and meshopt would each need a decoder shipped
   alongside — one more binary in a app that is meant to stay small. */
console.log("decimating (this takes a minute) …");
execFileSync(
  "npx",
  [
    "gltf-transform", "optimize",
    join(scratch, "field-raw.glb"),
    join(vendor, "field.glb"),
    "--compress", "quantize",
    "--simplify-ratio", "0.02",
    "--simplify-error", "0.03",
    "--texture-compress", "false",
  ],
  { stdio: "inherit", shell: isWindows }
);

await rm(scratch, { recursive: true, force: true });
console.log(`\nwrote src/vendor/field.glb — the field view will pick it up on next launch.`);
