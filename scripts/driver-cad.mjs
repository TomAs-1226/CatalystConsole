/* Put the driver figure where the console can load it.
 *
 *   npm run driver-cad -- "path/to/character.glb" ["another-clip.glb" ...]
 *
 * Extra files contribute their clips to the same figure, which is how a pose this console does not have
 * gets in: download the stand you want from wherever animations come from, put the file next to the
 * character and name it something the chooser below recognises. Nothing is merged here - each file is
 * copied through and the clips are matched onto the skeleton at load, by bone name.
 *
 * The figure is a rigged humanoid with its animation already on it: a walk to come on with and a stand to
 * hold. The console does not animate a person - walking is not something to derive from first principles,
 * and every attempt to do it by hand here read as a puppet - so what it draws is somebody's clips.
 *
 * This script deliberately does almost nothing. It copies the file and writes down what is in it.
 *
 * It used to do more: strip the character's own mesh, build a mannequin over its skeleton, normalise the
 * scale, and re-export the lot as a new GLB. Every one of those steps worked and the result still came out
 * wrong, because a rig carries its units in three places at once - the bones, the node above them, and the
 * position tracks of its clips - and re-exporting rearranges which of the three they end up in. A file
 * that plays correctly in the viewer it shipped with is the one thing about a rig that can be relied on,
 * so it is passed through untouched and everything else happens at load, in one consistent space, where it
 * can be measured against what is actually on screen. See createModelDriver in src/driver3d.js.
 *
 * Out: src/vendor/driver.glb and src/vendor/driver.json, baked rather than checked in - like the robot's
 * model, so the repository carries no third-party mesh.
 */

import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const DEFAULT_SOURCE = resolve(HOME, "Downloads", "Xbot.glb");

/**
 * Which clip is the walk and which is the stand, by what its name says it is - the only thing a file from
 * an animation library reliably tells you. First match wins, so the order is the order of preference: an
 * idle with the arms folded is the stand this console wants, and a plain idle will do when there is none.
 */
const WANTED = {
  walk: [/^walk$/i, /walk(?!.*(back|strafe|crouch|jump|run))/i],
  stand: [/(cross|fold)\w*[ _-]?(arm|idle)|(arm|idle)\w*[ _-]?(cross|fold)/i, /^idle$/i, /standing[ _-]?idle/i, /idle/i],
};

function log(line) {
  process.stdout.write(`${line}\n`);
}

/** What is in a GLB, read straight out of its JSON chunk - no loader, no scene, no units to get wrong. */
function contents(file) {
  const bytes = readFileSync(file);
  if (bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(`${basename(file)} is not a GLB`);
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
  return {
    clips: (json.animations ?? []).map((a, i) => a.name ?? `clip${i}`),
    bones: (json.skins?.[0]?.joints ?? []).map((i) => json.nodes[i]?.name).filter(Boolean),
    triangles: Math.round((json.meshes ?? []).flatMap((m) => m.primitives).reduce((n, p) => {
      const count = p.indices != null ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count;
      return n + count / 3;
    }, 0)),
  };
}

function main() {
  const source = process.argv[2] || DEFAULT_SOURCE;
  const extra = process.argv.slice(3);
  if (extname(source).toLowerCase() !== ".glb") {
    throw new Error("the source has to be a GLB: it is passed through to the browser as it is");
  }
  log(`reading ${source}`);
  const { clips, bones, triangles } = contents(source);
  log(`  ${triangles} triangles, ${bones.length} bones, ${clips.length} clip(s): ${clips.join(", ")}`);
  if (!bones.length) throw new Error("the source has no skeleton - the figure has to be rigged");

  const out = resolve(root, "src/vendor");
  mkdirSync(out, { recursive: true });

  /* Every clip there is, and which file it is in. A file named for the pose it holds is how a clip whose
     own name is unhelpful - plenty of them are called "mixamo.com" - still gets chosen. */
  const pool = clips.map((name) => ({ name, file: "driver.glb" }));
  const files = [];
  extra.forEach((path, i) => {
    if (extname(path).toLowerCase() !== ".glb") throw new Error(`${basename(path)} is not a GLB`);
    const name = `driver-clip-${i + 1}.glb`;
    copyFileSync(path, resolve(out, name));
    const inside = contents(path);
    log(`  ${basename(path)}: ${inside.clips.length} clip(s): ${inside.clips.join(", ")}`);
    files.push({ file: name, from: basename(path), clips: inside.clips });
    for (const clip of inside.clips) pool.push({ name: clip, file: name, label: basename(path, ".glb") });
  });

  const chosen = {};
  for (const [role, patterns] of Object.entries(WANTED)) {
    for (const pattern of patterns) {
      const hit = pool.find((p) => pattern.test(p.name) || (p.label && pattern.test(p.label)));
      if (hit) {
        chosen[role] = { clip: hit.name, file: hit.file };
        log(`  ${role}: "${hit.name}" from ${hit.file}`);
        break;
      }
    }
    if (!chosen[role]) log(`  ${role}: nothing matched - the console will hold the rest pose`);
  }

  copyFileSync(source, resolve(out, "driver.glb"));
  const bytes = readFileSync(resolve(out, "driver.glb")).length;

  writeFileSync(resolve(out, "driver.json"), `${JSON.stringify({
    version: 3,
    generatedAt: new Date().toISOString(),
    source: basename(source),
    model: { file: "driver.glb", bytes, triangles, bones: bones.length },
    /* Which clip the console plays for each part of the walk-on, and which file it is in. */
    clips: chosen,
    available: pool.map((p) => `${p.name} (${p.file})`),
    /* Files beside driver.glb that carry nothing but clips. */
    extra: files,
    /* A mannequin is built over this skeleton at load, so the console needs the bone names. Everything
       else about the rig - its units, which way it faces, how long its stride is - is measured at load
       rather than written down here, because measuring it is reliable and reading it is not. */
    bones,
    how: "Copied as it is. A file that plays correctly in the viewer it shipped with is the only thing about a rig that can be relied on; the mannequin, the scale and the facing all happen at load.",
  }, null, 1)}\n`);
  log(`wrote src/vendor/driver.glb: ${(bytes / 1024).toFixed(0)} KB, and driver.json`);
}

main();
