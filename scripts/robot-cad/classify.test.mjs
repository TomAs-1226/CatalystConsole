import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, classifyFace, classifyPart, materialColour, partName } from "./classify.mjs";

const keep = (name, extra = {}) => classifyPart({ name, colour: [165, 165, 165], size: 0.2, ...extra });

test("hardware and hidden parts are dropped, with the rule that dropped them", () => {
  assert.equal(keep('#10-32 x 1-1/2" L BHCS (Steel, Black Oxide)').reason, "fastener");
  assert.equal(keep("#10-32 Thin Nylon-Insert Locknut").reason, "fastener");
  assert.equal(keep("Intake Ramp Washer Print").reason, "fastener");
  assert.equal(keep('1/2" Rounded Hex (13.75mm) ID Bearing (1.125" OD, 0.313" WD, Shielded, Flanged)').reason, "bearing");
  assert.equal(keep("5269T611_Locking Grommets").reason, "grommet / zip tie");
  assert.equal(keep('#10 Aluminum Spacer (1-1/2" L, 3/8" OD)').reason, "spacer / standoff");
  assert.equal(keep("Kraken-Spacer-Config").reason, "spacer / standoff");
  assert.equal(keep('3D-Print Adapter (1/2" Hex Bore, VEX/WCP Profile)').reason, "hidden insert");
  assert.equal(keep('Nut Strip (1/2" Square ,1.5"  , #10-32 Tapped, Alternating .5" Hole Spacing)').reason, "nut strip (inside tube)");
  assert.equal(keep("Cone Bumper Mount").reason, "bumper mount (recorded in manifest)");
  assert.equal(keep('1/2" ThunderHex (1.75 in)', { size: 0.048 }).reason, "short shaft (inside gearbox)");
  assert.equal(keep("Some Bracket", { size: 0.008 }).reason, "tiny part");
});

test("names that merely contain a hardware word are kept", () => {
  assert.equal(keep("Shooter Hood Bearing Bracket").keep, true);
  assert.equal(keep("Intake Ramp Spacer Plate").cls, "aluminium");
  assert.equal(keep("Intake Motor Spacer Print", { colour: [228, 189, 104], size: 0.081 }).cls, "print");
  assert.equal(keep('23t Custom HTD 5mm Pulley (0.444" Wide, 1/2" Hex Bore w/ WCP Insert )', { colour: [67, 72, 77] }).cls, "print");
  assert.equal(keep("Shooter Hood Motor Mount Bracket", { colour: [0, 87, 184] }).cls, "aluminium");
  assert.equal(keep("Intake Energy Chain Mount Print", { colour: [228, 189, 104] }).cls, "print");
});

test("classes come from names first, then from the CAD colour", () => {
  assert.equal(keep("Kraken X60 Brushless Motor").cls, "motor");
  assert.equal(keep("95 Tooth x 9mm HTD5 Belt", { size: 0.005 }).cls, "belt");
  assert.equal(keep("Hopper Top Poly").cls, "poly");
  assert.equal(keep("Intake Main Rack SRPP").cls, "black");
  assert.equal(keep('4" Stainless Steel Flywheel (1/2" Triangle Bore)').cls, "steel");
  assert.equal(keep("Wheel - FIX", { colour: [255, 0, 0] }).cls, "tread");
  assert.equal(keep("Robot Battery").cls, "electronics");
  assert.equal(keep('Tube 2"x1"x20"').cls, "aluminium");
  assert.equal(keep('12t Aluminum Pulley (HTD 5mm, 9mm Wide, 8mm SplineXS Bore)', { colour: [55, 55, 55] }).cls, "black");
  assert.equal(keep('3" OD x 2.875" ID x 21.75" L', { colour: [234, 234, 234] }).cls, "poly");
  assert.equal(keep("Hopper Funnel", { colour: [234, 234, 234] }).cls, "poly");
  assert.equal(keep("Swerve Tube Support", { colour: [228, 189, 104] }).cls, "print");
  assert.equal(keep("Part 1", { colour: [67, 72, 77] }).cls, "black");
  assert.equal(classifyPart({ name: "", path: ["Drive", "PDP 2.0"], colour: [232, 232, 232], size: 0.036 }).cls, "electronics");
});

test("a single-body part's faces take their class from their colour", () => {
  assert.equal(classifyFace("black", [207, 219, 229], { treadColours: [[207, 219, 229]] }), "tread");
  assert.equal(classifyFace("black", [64, 64, 64], { treadColours: [[207, 219, 229]] }), "black");
  assert.equal(classifyFace("black", [222, 211, 181], { treadColours: [] }), "aluminium");
});

test("names and colours are read the way Onshape writes them", () => {
  assert.equal(baseName("Intake Front <1>"), "Intake Front");
  assert.equal(partName(undefined, "occurrence of Part 1"), "Part 1");
  assert.equal(partName("Hopper Funnel", "occurrence of Hopper Funnel"), "Hopper Funnel");
  assert.deepEqual(materialColour({ pbrMetallicRoughness: { baseColorFactor: [0, 0.3411765, 0.7215686, 1] } }), [0, 87, 184]);
  assert.deepEqual(materialColour({ name: "1.000000_0.000000_0.000000_0.000000_0.000000" }), [255, 0, 0]);
});
