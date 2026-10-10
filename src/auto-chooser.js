/* SendableChooser and WPILib 2027 robust Selectable share options, but not their write topic. */
export function chooserSelection(read, base = "/Auto Selector") {
  const tunable = base.startsWith("/Tunables/") ? base : `/Tunables${base}`;
  const robustBase = read.str(`${base}/selected/value`, null) !== null ? base
    : read.str(`${tunable}/selected/value`, null) !== null ? tunable : null;
  const active = read.str(`${base}/active`, null);
  const acknowledged = robustBase ? read.str(`${robustBase}/selected/value`, null) : null;
  const selected = read.str(`${base}/selected`, null);
  return {
    writeKey: `${robustBase ?? base}/selected${robustBase ? "/tune" : ""}`,
    chosen: active || acknowledged || selected || read.str(`${base}/default`, null),
  };
}
