import test from "node:test";
import assert from "node:assert/strict";
import { chooserSelection } from "./auto-chooser.js";

const view = (values) => ({ str: (key, fallback) => values[key] ?? fallback });

test("alpha-7 robust chooser writes tune and waits for robot acknowledgement", () => {
  // Names and paths match the captured alpha-7 chooser, including its legacy dashboard bridge.
  const values = {
    "/Auto Selector/active": "Do Nothing",
    "/Auto Selector/selected": "Leave",
    "/Tunables/Auto Selector/selected/value": "Do Nothing",
  };
  const state = chooserSelection(view(values));
  assert.equal(state.writeKey, "/Tunables/Auto Selector/selected/tune");
  assert.equal(state.chosen, "Do Nothing");
  // A server echo of the request is not a robot acknowledgement.
  values[state.writeKey] = "Right shallow 2-sweep";
  assert.equal(chooserSelection(view(values)).chosen, "Do Nothing");
  values["/Tunables/Auto Selector/selected/value"] = "Right shallow 2-sweep";
  values["/Auto Selector/active"] = "Right shallow 2-sweep";
  assert.equal(chooserSelection(view(values)).chosen, "Right shallow 2-sweep");
});

test("SendableChooser keeps its selected write topic and trusts active over request echoes", () => {
  const values = { "/Custom/selected": "Leave", "/Custom/active": "Do Nothing" };
  assert.deepEqual(chooserSelection(view(values), "/Custom"), {
    writeKey: "/Custom/selected", chosen: "Do Nothing",
  });
});

test("direct robust tables, defaults and empty selections are supported", () => {
  assert.deepEqual(chooserSelection(view({ "/Custom/selected/value": "Leave" }), "/Custom"), {
    writeKey: "/Custom/selected/tune", chosen: "Leave",
  });
  assert.equal(chooserSelection(view({ "/Auto Selector/selected": "", "/Auto Selector/default": "Do Nothing" })).chosen, "Do Nothing");
  assert.equal(chooserSelection(view({})).chosen, null);
});
