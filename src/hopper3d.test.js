import { test } from "node:test";
import assert from "node:assert/strict";

import { packSlots } from "./hopper3d.js";

const R = 0.075;

test("a hopper packs FUEL inside its walls, from the floor up, without overlaps", () => {
  const min = [-0.3, 0.2, -0.3];
  const max = [0.3, 0.6, 0.3];
  const slots = packSlots(min, max, R);
  assert.ok(slots.length > 20, `${slots.length} balls`);
  for (const [x, y, z] of slots) {
    assert.ok(x >= min[0] + R * 0.8 && x <= max[0] - R * 0.8, `x ${x} inside`);
    assert.ok(y >= min[1] + R * 0.99 && y <= max[1], `y ${y} inside`);
    assert.ok(z >= min[2] + R * 0.8 && z <= max[2] - R * 0.8, `z ${z} inside`);
  }
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i][1] >= slots[i - 1][1] - R * 0.2, "filled from the floor up");
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const gap = Math.hypot(slots[i][0] - slots[j][0], slots[i][1] - slots[j][1], slots[i][2] - slots[j][2]);
      assert.ok(gap > R * 1.6, `balls ${i} and ${j} overlap: ${gap}`);
    }
  }
});

test("the same hopper packs the same way every time", () => {
  assert.deepEqual(packSlots([0, 0, 0], [0.5, 0.4, 0.5], R), packSlots([0, 0, 0], [0.5, 0.4, 0.5], R));
});

test("a box too small for a ball holds none", () => {
  assert.equal(packSlots([0, 0, 0], [0.1, 0.1, 0.1], R).length, 0);
});
