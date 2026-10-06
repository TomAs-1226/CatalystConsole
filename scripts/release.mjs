// Build Catalyst Console on this machine and publish it as a GitHub release.
//
//   npm run release              build, sign, publish v<version>
//   npm run release -- --dry-run build and sign, list what would be published, publish nothing
//
// A release is built here rather than on a runner because the field, robot and driver models are
// baked from CAD into src/vendor on a development machine and are not in the repository. A runner's
// build draws the fallback robot on an empty floor, and the updater would hand that to every install.
//
// Before running it:  devtools release CatalystConsole <version>   (version files, CHANGELOG, tag)
//                     git push origin main v<version>
//
// What it publishes, by these exact names:
//   Catalyst.Console_<version>_x64-setup.exe        the installer; Catalyst Setup installs this
//   Catalyst.Console_<version>_x64-setup.exe.sig    its updater signature
//   latest.json                                     what an installed console's updater reads
//   catalyst-console.exe                            the bare binary the Catalyst app's build bundles
//
// The updater key is the suite's, kept outside git in ../CatalystApp/.keys. Point
// TAURI_SIGNING_PRIVATE_KEY at another one to override, and set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
// if it has a password.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const REPO = "TomAs-1226/CatalystConsole";

const stop = (message) => { console.error(`release: ${message}`); process.exit(1); };
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
const tryOut = (cmd, args) => { try { return out(cmd, args); } catch { return null; } };
// Content, not timestamps or line endings: the Tauri CLI rewrites Cargo.toml with the endings it
// prefers, which `git status` reports as modified although nothing in it changed.
const dirty = () => {
  tryOut("git", ["update-index", "-q", "--refresh"]);
  return tryOut("git", ["diff", "--quiet", "HEAD"]) === null
    || out("git", ["ls-files", "--others", "--exclude-standard"]) !== "";
};

const version = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
const tag = `v${version}`;

// --- is this the machine, and the commit, a release can come from? ---------------------------

// The reason this script exists. Without these the build is the one a runner would have made.
const MODELS = ["three.module.min.js", "field.glb", "robot.glb", "robot.json", "driver.glb", "driver.json", "devices.json"];
const missing = MODELS.filter((f) => !existsSync(join(root, "src/vendor", f)));
if (missing.length) {
  stop(`src/vendor is missing ${missing.join(", ")}. Bake the models first (npm run field-cad, robot-cad, driver-cad, device-cad).`);
}

if (dirty()) stop("the working tree has uncommitted changes.");
const head = out("git", ["rev-parse", "HEAD"]);
const tagged = tryOut("git", ["rev-parse", `${tag}^{commit}`]);
if (tagged !== head) {
  stop(`${tag} is not the commit checked out. Run: devtools release CatalystConsole ${version}`);
}
// A version means one build. A release that exists is never rebuilt or replaced.
if (!dryRun && tryOut("gh", ["release", "view", tag, "-R", REPO, "--json", "tagName"])) {
  stop(`${tag} is already released. Ship a fix as the next version.`);
}
if (!dryRun && !out("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) {
  stop(`${tag} is not on GitHub yet. Run: git push origin main ${tag}`);
}

const key = process.env.TAURI_SIGNING_PRIVATE_KEY || resolve(root, "../CatalystApp/.keys/catalyst-updater.key");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(key)) {
  stop(`no updater key at ${key}. Without it installed consoles cannot verify the update.`);
}

// --- build ------------------------------------------------------------------------------------

const env = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: key,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
};
const built = spawnSync("npm", ["run", "build", "--", "--bundles", "nsis"], { cwd: root, env, stdio: "inherit", shell: true });
if (built.status !== 0) stop("the build failed.");
if (dirty()) stop("the build changed tracked files (the identity copy drifted?). Commit that and release the next version.");

const nsis = join(root, "src-tauri/target/release/bundle/nsis");
const installer = join(nsis, `Catalyst Console_${version}_x64-setup.exe`);
const signature = `${installer}.sig`;
const bare = join(root, "src-tauri/target/release/catalyst-console.exe");
for (const f of [installer, signature, bare]) if (!existsSync(f)) stop(`the build did not produce ${f}`);

// --- what gets published ----------------------------------------------------------------------

// GitHub turns the space in an uploaded file name into a dot. Naming the files that way up front
// keeps the URL in latest.json and the asset it points at the same string.
const stage = join(root, "src-tauri/target/release/publish", tag);
mkdirSync(stage, { recursive: true });
const assetName = `Catalyst.Console_${version}_x64-setup.exe`;
copyFileSync(installer, join(stage, assetName));
copyFileSync(signature, join(stage, `${assetName}.sig`));
copyFileSync(bare, join(stage, "catalyst-console.exe"));

const notes = changelogSection(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version)
  || "Driver station dashboard for FrcCatalyst.";
const url = `https://github.com/${REPO}/releases/download/${tag}/${assetName}`;
const platform = { signature: readFileSync(signature, "utf8").trim(), url };
writeFileSync(join(stage, "latest.json"), `${JSON.stringify({
  version,
  notes: `Catalyst Console ${version}. See the release page for what changed.`,
  pub_date: new Date().toISOString(),
  platforms: { "windows-x86_64": platform, "windows-x86_64-nsis": platform },
}, null, 2)}\n`);
writeFileSync(join(stage, "notes.md"), `${notes}\n\nWindows x64. Built with the field, robot and driver models.\n`);

const files = [assetName, `${assetName}.sig`, "latest.json", "catalyst-console.exe"];
console.log(`\nrelease: ${tag} from ${head.slice(0, 7)}`);
for (const f of files) console.log(`  ${f.padEnd(48)} ${(statSync(join(stage, f)).size / 1e6).toFixed(2)} MB`);

if (dryRun) {
  console.log(`\nrelease: dry run, nothing published. The files are in ${stage}`);
  process.exit(0);
}

const published = spawnSync("gh", [
  "release", "create", tag, ...files.map((f) => join(stage, f)),
  "-R", REPO, "--verify-tag", "--title", `Catalyst Console v${version}`, "--notes-file", join(stage, "notes.md"),
], { cwd: root, stdio: "inherit" });
if (published.status !== 0) stop("gh release create failed; nothing above was replaced.");
console.log(`release: published https://github.com/${REPO}/releases/tag/${tag}`);

/** The body of `## [version]` in a Keep a Changelog file, without its heading. */
function changelogSection(text, v) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## ["));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}
