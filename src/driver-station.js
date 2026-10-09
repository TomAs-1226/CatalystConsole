/* WPILib 2027 moved FMSInfo topics into DriverStation. Keep the old namespace as a compatibility
 * fallback for existing 2026 robots, but never let a malformed new value be masked by stale data. */

export const DRIVER_STATION = "/DriverStation";
export const FMS_INFO = "/FMSInfo";

function nativeOrLegacy(read, name, parse, fallback = null) {
  const primary = `${DRIVER_STATION}/${name}`;
  if (read.has(primary)) return parse(primary, true);
  const legacy = `${FMS_INFO}/${name}`;
  return read.has(legacy) ? parse(legacy, false) : fallback;
}

function nativeValue(read, key, type, validate = () => true) {
  const value = read.raw(key);
  const expected = type === "str" ? "string" : type === "bool" ? "boolean" : "number";
  return value?.t === type && typeof value.v === expected && validate(value.v) ? value.v : null;
}

const controlWordNumber = (value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 63;

export function readControlWord(read) {
  const primary = `${DRIVER_STATION}/ControlWord`;
  if (read.has(primary)) return nativeValue(read, primary, "num", controlWordNumber);
  if (read.has(`${FMS_INFO}/ControlWord`)) return nativeValue(read, `${FMS_INFO}/ControlWord`, "num", controlWordNumber);
  return nativeValue(read, `${FMS_INFO}/FMSControlData`, "num", controlWordNumber);
}

export function readAlliance(read) {
  const red = nativeOrLegacy(read, "IsRedAlliance", (key, native) => native
    ? nativeValue(read, key, "bool")
    : read.bool(key, null));
  return red === null ? null : red ? "red" : "blue";
}

export function readGameData(read) {
  if (read.has(`${DRIVER_STATION}/GameData`)) return nativeValue(read, `${DRIVER_STATION}/GameData`, "str");
  if (read.has(`${FMS_INFO}/GameData`)) return read.str(`${FMS_INFO}/GameData`, null);
  return read.str(`${FMS_INFO}/GameSpecificMessage`, "");
}

export function readMatchField(read, name, kind, fallback = null) {
  const parse = (key, native) => {
    if (native) {
      const type = kind === "str" ? "str" : "num";
      const validate = name === "MatchNumber" ? Number.isFinite : () => true;
      return nativeValue(read, key, type, validate);
    }
    return kind === "str" ? read.str(key, null) : read.num(key, null);
  };
  return nativeOrLegacy(read, name, parse, fallback);
}

export function hasUtilityControlWord(read) {
  const native = `${DRIVER_STATION}/ControlWord`;
  if (read.has(native)) return nativeValue(read, native, "num", controlWordNumber) !== null;
  const legacy = `${FMS_INFO}/ControlWord`;
  return read.has(legacy) && nativeValue(read, legacy, "num", controlWordNumber) !== null;
}
