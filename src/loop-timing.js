/* LoopMonitor's AverageMs measures the interval between loop starts. Work time is a
 * separate, optional measurement: a healthy scheduled 20 ms period is not 20 ms of work. */
export const ROBOT_LOOP_KEY = "/Catalyst/Loop/Robot/AverageMs";
const ROOT = "/Catalyst/Loop/Robot/";

function number(read, key) {
  const entry = read.raw(key);
  return entry?.t === "num" && Number.isFinite(entry.v) && entry.v >= 0 ? entry.v : null;
}

export function readLoopTiming(read, { loopKey = ROBOT_LOOP_KEY, budget = 20 } = {}) {
  const empty = { value: null, work: null, period: null, kind: "unknown", state: "", headroom: null, budget };
  if (!read.linked) return empty;
  const validBudget = Number.isFinite(budget) && budget > 0;
  /* A user-selected topic retains its own configured meaning and budget. Do not
   * replace it with Robot's work measurement just because that topic is published. */
  if (loopKey !== ROBOT_LOOP_KEY) {
    const value = number(read, loopKey);
    return { ...empty, value, kind: value === null ? "unknown" : "configured",
      state: value === null || !validBudget ? "" : value > budget ? "bad" : value > budget * .75 ? "warn" : "ok",
      headroom: value === null || !validBudget ? null : Math.max(0, 1 - value / budget) };
  }
  const period = number(read, ROBOT_LOOP_KEY);
  const work = number(read, `${ROOT}AverageWorkMs`) ?? number(read, `${ROOT}WorkMs`);
  const published = read.raw(`${ROOT}OverBudget`);
  const overBudget = published?.t === "bool" && typeof published.v === "boolean" ? published.v : null;
  const value = work ?? period;
  const kind = work !== null ? "work" : period !== null ? "period" : "unknown";
  const state = overBudget === true ? "bad" : value === null ? ""
    : work !== null ? !validBudget ? "" : work > budget ? "bad" : work > budget * .75 ? "warn" : "ok"
    /* LoopMonitor uses 1.2 times the 20 ms schedule for interval-only overruns. */
    : overBudget === false ? "ok" : period > 24 ? "bad" : "ok";
  /* The application chooses the begin/end boundaries. This measurement need not
   * cover every scheduler callback, so it cannot establish total CPU headroom. */
  return { value, work, period, kind, state, budget, headroom: null };
}
