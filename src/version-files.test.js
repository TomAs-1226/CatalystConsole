// Every file that carries this console's version must say the same thing.
//
// package-lock.json still carried 0.1.0, the value a fresh npm project starts with, while
// package.json, tauri.conf.json and Cargo.lock all said 1.4.3. Nothing notices that until a
// packaging step or an installer reports the wrong version, so the check belongs in the test run.
//
// The fix when this fails: `devtools release CatalystConsole <version>`, which rewrites all of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // src/ -> repo root
const CRATE = "catalyst-console";

const readJson = (...parts) => JSON.parse(readFileSync(join(root, ...parts), "utf8"));
const readText = (...parts) => readFileSync(join(root, ...parts), "utf8");

/** The [package] version, not some dependency's further down the file. */
const cargoTomlVersion = (text) =>
  text
    .split(/^\[/m)
    .find((section) => section.startsWith("package]"))
    ?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];

const cargoLockVersion = (text, crate) =>
  text.match(new RegExp(`\\[\\[package\\]\\]\\s*\\nname = "${crate}"\\s*\\nversion = "([^"]+)"`))?.[1];

test("every file that carries the version agrees", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const tauri = readJson("src-tauri", "tauri.conf.json");

  const found = {
    "package-lock.json": lock.version,
    'package-lock.json packages[""]': lock.packages?.[""]?.version,
    "src-tauri/tauri.conf.json": tauri.version,
    "src-tauri/Cargo.toml": cargoTomlVersion(readText("src-tauri", "Cargo.toml")),
    "src-tauri/Cargo.lock": cargoLockVersion(readText("src-tauri", "Cargo.lock"), CRATE),
  };

  const disagree = Object.entries(found).filter(([, version]) => version !== pkg.version);
  assert.deepEqual(
    disagree,
    [],
    `package.json says ${pkg.version}; these disagree: ${JSON.stringify(Object.fromEntries(disagree))}`,
  );
});
