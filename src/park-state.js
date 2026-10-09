/* Read-only Park identity and visual handover data. These never change robot telemetry. */
import { readAlliance } from "./driver-station.js";

const team = (value) => Number.isInteger(value) && value >= 1 && value <= 9999 ? value : null;

export function parkIdentity(read, { linked = read.linked, configuredTeam = null, rememberedTeam = null } = {}) {
  if (!linked) return { team: team(rememberedTeam), alliance: null };
  const published = (key) => {
    const value = read.raw(key);
    return value?.t === "num" ? team(value.v) : null;
  };
  return {
    team: published("/Catalyst/Systemcore/TeamNumber")
      ?? published("/Catalyst/Robot/Identity/TeamNumber") ?? team(configuredTeam),
    alliance: readAlliance(read),
  };
}

/** A selected auto's published start for the visual transition, never its current/parked pose. */
export function selectedAutoStart(read, { length = 16.54, width = 8.07 } = {}) {
  if (!read.linked) return null;
  const selected = read.str("/Auto Selector/selected", null) ?? read.str("/Auto Selector/active", null);
  if (typeof selected !== "string" || !selected.trim()) return null;
  const available = read.raw("/Catalyst/Auto/StartCheck/Available");
  if (available?.t !== "bool" || available.v !== true) return null;
  const expected = read.arr("/Catalyst/Auto/StartCheck/Expected");
  if (!Array.isArray(expected) || expected.length < 3 || !expected.slice(0, 3).every(Number.isFinite)) return null;
  if (expected[0] < 0 || expected[0] > length || expected[1] < 0 || expected[1] > width) return null;
  return expected.slice(0, 3);
}

/** Camera eye/look in an explicitly supplied robot frame, leaving the actual scene pose untouched. */
export function shotAtFieldPose(shot, pose, length, width) {
  if (!Array.isArray(pose) || pose.length < 3 || !pose.slice(0, 3).every(Number.isFinite)) return null;
  const x = pose[0] - length / 2;
  const z = -(pose[1] - width / 2);
  const c = Math.cos(pose[2]), s = Math.sin(pose[2]);
  const local = ([px, py, pz]) => [c * (px - x) - s * (pz - z), py, s * (px - x) + c * (pz - z)];
  return { eye: local(shot.eye), look: local(shot.look), fov: shot.fov };
}
