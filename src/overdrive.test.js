import { test } from "node:test";
import assert from "node:assert/strict";

import { createOverdriveDebounce, OVERDRIVE_COOLDOWN_MS, OVERDRIVE_ENGAGE_MS, OVERDRIVE_WARP_MS } from "./overdrive.js";

test("nothing shows until the raw flag has held for engageMs", () => {
  const d = createOverdriveDebounce({ engageMs: 100, cooldownMs: 2000, warpMs: 1200 });
  assert.equal(d.next(false, 0), "idle");
  assert.equal(d.next(true, 0), "idle");
  assert.equal(d.next(true, 50), "idle", "50 ms in is still unconfirmed");
  assert.equal(d.next(true, 99), "idle", "99 ms is still short of engageMs");
  assert.equal(d.next(true, 100), "warp", "100 ms confirms a fresh engage and starts the warp");
});

test("a flicker under engageMs shows nothing at all, and does not poison the next engage's cooldown check", () => {
  const d = createOverdriveDebounce({ engageMs: 100, cooldownMs: 2000, warpMs: 1200 });
  assert.equal(d.next(true, 0), "idle");
  assert.equal(d.next(true, 40), "idle");
  assert.equal(d.next(false, 60), "idle", "let go before engageMs: never shown, so not an ending either");
  // A real engage straight after: if the flicker above had counted as an ending, this would be
  // "inside cooldown" of it and skip the warp. It must not - the flicker was never shown.
  assert.equal(d.next(true, 70), "idle");
  assert.equal(d.next(true, 169), "idle");
  assert.equal(d.next(true, 170), "warp", "a full 100 ms after this engage started, and fresh");
});

test("a held engage plays the warp once and settles into the badge after warpMs, then holds it", () => {
  const d = createOverdriveDebounce({ engageMs: 100, cooldownMs: 2000, warpMs: 1200 });
  assert.equal(d.next(true, 0), "idle");
  assert.equal(d.next(true, 100), "warp");
  assert.equal(d.next(true, 500), "warp", "still inside warpMs");
  assert.equal(d.next(true, 1299), "warp", "1199 ms since the warp started");
  assert.equal(d.next(true, 1300), "badge", "1200 ms since the warp started settles it");
  assert.equal(d.next(true, 9000), "badge", "and it holds however long the flag stays true");
});

test("letting go clears everything at once, badge included", () => {
  const d = createOverdriveDebounce({ engageMs: 100, cooldownMs: 2000, warpMs: 1200 });
  d.next(true, 0);
  d.next(true, 100);
  d.next(true, 1300); // settled into the badge
  assert.equal(d.next(false, 1400), "idle");
  assert.equal(d.next(false, 1500), "idle");
});

test("releasing mid-warp stops everything immediately, and still counts as an ending for the cooldown", () => {
  const d = createOverdriveDebounce({ engageMs: 100, cooldownMs: 2000, warpMs: 1200 });
  d.next(true, 0);
  assert.equal(d.next(true, 100), "warp");
  assert.equal(d.next(false, 300), "idle", "let go 200 ms into the warp: it stops at once");
  // Re-engaging inside the cooldown of that early release still skips the warp.
  d.next(true, 400);
  assert.equal(d.next(true, 499), "idle");
  assert.equal(d.next(true, 500), "badge", "500 - 300 = 200 ms, well inside cooldownMs");
});

test("a re-engage inside cooldownMs of the last release shows the badge only, with no warp replay", () => {
  const d = createOverdriveDebounce({ engageMs: 100, cooldownMs: 2000, warpMs: 1200 });
  d.next(true, 0);
  d.next(true, 100); // warp starts
  d.next(true, 1300); // settles to badge
  assert.equal(d.next(false, 5000), "idle"); // released; endedAt = 5000
  d.next(true, 6900); // 1900 ms later - inside the 2000 ms cooldown
  assert.equal(d.next(true, 6999), "idle", "still arming");
  assert.equal(d.next(true, 7000), "badge", "confirmed inside cooldown: badge only, no warp");
});

test("a re-engage after cooldownMs has passed plays the warp again", () => {
  const d = createOverdriveDebounce({ engageMs: 100, cooldownMs: 2000, warpMs: 1200 });
  d.next(true, 0);
  d.next(true, 100);
  d.next(true, 1300);
  assert.equal(d.next(false, 5000), "idle"); // endedAt = 5000
  d.next(true, 7001); // 2001 ms later - just past the cooldown
  assert.equal(d.next(true, 7101), "warp", "past cooldown: this is a fresh engage");
});

test("reducedMotion skips the warp phase entirely: a held engage goes straight to the badge", () => {
  const d = createOverdriveDebounce({ engageMs: 100, cooldownMs: 2000, warpMs: 1200, reducedMotion: true });
  assert.equal(d.next(true, 0), "idle");
  assert.equal(d.next(true, 100), "badge", "no warp phase, ever");
  assert.equal(d.next(true, 2000), "badge");
  assert.equal(d.next(false, 2100), "idle");
});

test("the exported defaults match what app.js and the CSS are built around", () => {
  assert.equal(OVERDRIVE_ENGAGE_MS, 100);
  assert.equal(OVERDRIVE_COOLDOWN_MS, 2000);
  assert.equal(OVERDRIVE_WARP_MS, 1200);
  const d = createOverdriveDebounce();
  assert.equal(d.next(true, 0), "idle");
  assert.equal(d.next(true, OVERDRIVE_ENGAGE_MS), "warp");
});
