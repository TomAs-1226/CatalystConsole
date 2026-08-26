// The rules behind the CAN page: which bus is which, which buses fight each other, and what counts
// as a bus in trouble.
//
// Its own module for the same reason core-format.js is: app.js touches the DOM at import time, and
// none of this needs a DOM to be wrong. The thing worth testing here is not the formatting — it is
// the topology, and the topology is the entire reason this page exists.
//
// **Systemcore's five buses are not five independent lanes.** They are MCP2518FD controllers on
// shared SPI hosts: can_s0 + can_s1 on one, can_s3 + can_s4 on another, can_s2 alone. Splitting a
// heavy load across can_s0 and can_s1 buys much less headroom than splitting it across can_s0 and
// can_s2, and nothing in the FRC toolchain draws that distinction — on paper both look like "two
// different buses". The pairing is read out of the Systemcore OS image and encoded in the library at
// CatalystCANBus.controllerGroup(); this file is the console's copy of it, and the grouping it
// produces is the whole point of the view.
//
// The same rule that runs through core-format.js runs through here: absent is not zero. A bus the
// robot never reported on has null utilisation, not 0%, and the two must never render alike — one
// means "nothing is on that wire", the other means "nobody asked".

/** How many CAN buses Systemcore exposes. CatalystCANBus.SYSTEMCORE_BUS_COUNT. */
export const SYSTEMCORE_BUS_COUNT = 5;

/** How many Motioncore exposes, for recognising a can_d* bus rather than for drawing one. */
export const MOTIONCORE_BUS_COUNT = 20;

/**
 * Utilisation at which Systemcore's own web UI starts warning, and so where this does.
 *
 * From CANBusHealth.UTILIZATION_WARN. Matching the OS on purpose: a team that sees a warning in one
 * place and not the other will reasonably assume one of them is broken.
 */
export const UTILIZATION_WARN = 0.9;

/**
 * Combined utilisation a shared-controller pair should stay under.
 *
 * From CANBusPlanner.TARGET_PAIR_UTILIZATION. Not twice the single-bus figure: the pair shares one
 * SPI host, so the ceiling is that controller's throughput rather than the sum of two free wires.
 */
export const PAIR_UTILIZATION_LIMIT = 1.0;

/**
 * Device count on one bus — or across one shared-controller pair — that earns a warning.
 *
 * From the busyThreshold inside CANRegistry.contentionWarnings(). Device count is a rough proxy for
 * load and the library says so; it is here because it is knowable with the robot disabled, which is
 * when somebody is standing in front of the robot able to move a wire.
 */
export const BUSY_DEVICE_COUNT = 12;

/** Below this a bus is drawn as carrying nothing, rather than as a bar too short to see. */
export const IDLE_BELOW = 0.01;

/* The three SPI controllers and the buses on each, in the order the hardware numbers them. Group
   ids match CatalystCANBus.controllerGroup() exactly, so a warning raised here and a warning raised
   on the robot are talking about the same controller.

   `note` is what the group is for: a reader who has never heard of an SPI host still has to come
   away knowing that moving a device between two buses in the same band buys less than moving it out
   of the band. */
export const CONTROLLERS = [
  { group: 0, name: "Controller 1", buses: ["can_s0", "can_s1"], note: "two buses, one SPI host" },
  { group: 1, name: "Controller 2", buses: ["can_s2"], note: "one bus, nothing to share with" },
  { group: 2, name: "Controller 3", buses: ["can_s3", "can_s4"], note: "two buses, one SPI host" },
];

/** Group id used for anything that is not one of Systemcore's own buses — a CANivore, mostly. */
export const NO_CONTROLLER = -1;

/**
 * A bus name in the one spelling everything else here uses.
 *
 * A port of CatalystCANBus.of(spec).name(), and it exists for the reason the library's version does:
 * "", "0" and "can_s0" are three spellings of one physical bus. The robot normalises before it
 * publishes, so on a current library every name arriving here is already canonical — but a console
 * outlives a robot's library version, and a 1.x robot publishes the raw string it was given. Two
 * spellings of one wire would split it into two half-loaded buses on screen, which is the exact
 * failure the library fixed on its own side.
 *
 * Unlike the library's, this never throws. A bus index outside the hardware's range is not something
 * to take a page down over; it comes back as its own trimmed name and lands in the unrecognised
 * group, where a reader can see it and wonder about it.
 *
 * @param {string|null|undefined} spec
 * @returns {string}
 */
export function normalizeBus(spec) {
  if (spec === null || spec === undefined) return "can_s0";
  const s = String(spec).trim();
  if (!s) return "can_s0";
  if (/^\d+$/.test(s)) {
    const i = Number(s);
    return i < SYSTEMCORE_BUS_COUNT ? `can_s${i}` : s;
  }
  return s;
}

/**
 * What kind of bus a name refers to.
 *
 * @param {string} bus
 * @returns {"systemcore"|"motioncore"|"canivore"}
 */
export function busKind(bus) {
  const s = String(bus ?? "");
  if (/^can_s\d+$/.test(s) && Number(s.slice(5)) < SYSTEMCORE_BUS_COUNT) return "systemcore";
  if (/^can_d\d+$/.test(s) && Number(s.slice(5)) < MOTIONCORE_BUS_COUNT) return "motioncore";
  return "canivore";
}

/**
 * A Systemcore bus's index, or null for anything else. CatalystCANBus.index().
 *
 * @param {string} bus
 * @returns {number|null}
 */
export function busIndex(bus) {
  return busKind(bus) === "systemcore" ? Number(String(bus).slice(5)) : null;
}

/**
 * Which physical SPI controller a bus hangs off, or NO_CONTROLLER for anything that is not one of
 * Systemcore's five. A port of CatalystCANBus.controllerGroup().
 *
 * @param {string} bus
 * @returns {number}
 */
export function controllerGroup(bus) {
  const i = busIndex(bus);
  if (i === null) return NO_CONTROLLER;
  return i <= 1 ? 0 : i === 2 ? 1 : 2;
}

/**
 * Whether two buses share an SPI controller, and so share bandwidth.
 *
 * A bus never counts as sharing with itself: this answers "will loading these two fight each other",
 * and one bus does not fight itself. CatalystCANBus.sharesControllerWith().
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sharesController(a, b) {
  if (a === b) return false;
  const ga = controllerGroup(a);
  return ga !== NO_CONTROLLER && ga === controllerGroup(b);
}

/**
 * The device list out of /Catalyst/CAN/Devices.
 *
 * The robot publishes one pipe-delimited line per device, written by CANRegistry.Entry.serialize()
 * as `bus|canId|type|name`. The name is last and is a string a team wrote, so it can contain a pipe
 * of its own — everything past the third separator belongs to the name and is put back together
 * rather than dropped.
 *
 * Anything that cannot be a device is left out instead of being shown as a device with holes in it.
 * A row with no numeric id is not a partial reading, it is a line this console does not understand.
 *
 * @param {string[]|null|undefined} rows
 * @returns {{bus: string, id: number, type: string, name: string}[]}
 */
export function parseDevices(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const parts = String(row ?? "").split("|");
    if (parts.length < 4) continue;
    const id = Number(parts[1]);
    if (!Number.isFinite(id)) continue;
    out.push({
      bus: normalizeBus(parts[0]),
      id,
      type: parts[2],
      name: parts.slice(3).join("|"),
    });
  }
  /* Bus then id, the order CANRegistry.all() uses, so the console lists a bus the way the robot
     thinks of it and a device does not move around between frames. */
  out.sort((a, b) => (a.bus === b.bus ? a.id - b.id : a.bus < b.bus ? -1 : 1));
  return out;
}

/**
 * A bus's live health, from whichever of the two sources reported it.
 *
 * Two exist and they are not interchangeable:
 *
 *  - `/Catalyst/Systemcore/CanUtilization` is the OS's own per-bus measurement, mirrored by
 *    SystemCoreStatus.publish() out of the system server's /diagnostics/canbusutil. It covers all
 *    five buses whether or not the robot registered a device on them, which is what makes an empty
 *    bus visibly empty rather than merely unmentioned.
 *  - `/Catalyst/CAN/Health/<bus>/*` is Phoenix's view, published by CANBusHealth.publish(). It
 *    reaches CANivores, and it carries the error counters, which the OS array does not.
 *
 * The OS figure wins for a Systemcore bus, because the Systemcore page already draws that number and
 * two surfaces of one console disagreeing about one bus is worse than either being slightly stale.
 * Phoenix's fills in everywhere the OS array cannot reach. `source` records which answered, so the
 * page can say so rather than leaving a reader to guess why two numbers differ.
 *
 * @param {string} bus
 * @param {number[]|null} osUtilization one entry per Systemcore bus, or null when not published
 * @param {object|null} phoenix {ok, utilization, busOff, txFull, rec, tec}, any field possibly null
 * @returns {{value: number|null, source: "os"|"phoenix"|null}}
 */
export function utilizationOf(bus, osUtilization, phoenix) {
  const i = busIndex(bus);
  if (i !== null && Array.isArray(osUtilization) && Number.isFinite(osUtilization[i])) {
    return { value: osUtilization[i], source: "os" };
  }
  const p = phoenix?.utilization;
  if (Number.isFinite(p)) return { value: p, source: "phoenix" };
  return { value: null, source: null };
}

/**
 * Everything the page draws, grouped by SPI controller.
 *
 * All five Systemcore buses are always present, even with no robot and no devices. An empty bus is
 * the most useful thing on this page — it is where the next mechanism should go — and a view that
 * only lists buses somebody already used cannot show that. Anything that is not a Systemcore bus
 * lands in one extra group at the end, because a CANivore has no SPI controller to belong to and
 * pretending it does would be inventing hardware.
 *
 * @param {object} input
 * @param {{bus: string, id: number, type: string, name: string}[]} [input.devices]
 * @param {number[]|null} [input.osUtilization] /Catalyst/Systemcore/CanUtilization
 * @param {Record<string, object>} [input.health] per-bus /Catalyst/CAN/Health/<bus> readings
 * @returns {{controllers: object[], deviceCount: number, busiest: number|null}}
 */
export function layout({ devices = [], osUtilization = null, health = {} } = {}) {
  const byBus = new Map();
  for (const d of devices) {
    if (!byBus.has(d.bus)) byBus.set(d.bus, []);
    byBus.get(d.bus).push(d);
  }

  const build = (name) => {
    const phoenix = health?.[name] ?? null;
    const util = utilizationOf(name, osUtilization, phoenix);
    return {
      name,
      kind: busKind(name),
      index: busIndex(name),
      devices: byBus.get(name) ?? [],
      utilization: util.value,
      source: util.source,
      /* Null utilisation is not idle. "Nothing is on that wire" and "nobody measured that wire" are
         different facts and the page has to keep them apart. */
      idle: util.value !== null && util.value < IDLE_BELOW,
      health: phoenix,
    };
  };

  const controllers = CONTROLLERS.map((c) => {
    const buses = c.buses.map(build);
    return {
      ...c,
      buses,
      shared: c.buses.length > 1,
      deviceCount: buses.reduce((n, b) => n + b.devices.length, 0),
      /* The number that binds a shared controller, and the reason the group is a group. Null unless
         every bus on it was measured — a half-measured pair total would read as a low one. */
      utilization: buses.every((b) => b.utilization !== null)
        ? buses.reduce((n, b) => n + b.utilization, 0)
        : null,
    };
  });

  const strays = [...byBus.keys()].filter((b) => controllerGroup(b) === NO_CONTROLLER).sort();
  if (strays.length) {
    const buses = strays.map(build);
    controllers.push({
      group: NO_CONTROLLER,
      name: "Off the Systemcore",
      note: "a CANivore brings its own controller — nothing here shares with anything above",
      buses,
      shared: false,
      deviceCount: buses.reduce((n, b) => n + b.devices.length, 0),
      utilization: null,
    });
  }

  const measured = controllers
    .flatMap((c) => c.buses)
    .map((b) => b.utilization)
    .filter((v) => v !== null);

  return {
    controllers,
    deviceCount: devices.length,
    busiest: measured.length ? Math.max(...measured) : null,
  };
}

/**
 * Wiring problems the console can see for itself.
 *
 * The robot works these out too — CANRegistry.contentionWarnings() and CANBusPlanner.validate(),
 * surfaced through Preflight — but only if robot code calls Preflight.run(), and only as of the
 * moment it did. Nothing publishes them continuously. So this computes the equivalent client-side
 * from what is on the wire, and the page marks the two apart: what the robot said, and what the
 * console worked out.
 *
 * Two of the four rules use device counts and two use measured utilisation, and they are kept
 * separate on purpose. Counts are knowable with the robot disabled, which is when somebody is
 * standing beside it holding a wire. Utilisation is only true under load and says nothing at rest.
 *
 * Deliberately not ported: CANBusPlanner's frames-per-second estimate. It prices a device from a
 * table of Phoenix status-signal rates that changes with firmware and with what a team configured,
 * and the library is explicit that it is conservative guesswork meant to be calibrated against a
 * real measurement. Guessing at load on a page sitting next to the measured figure would be the
 * console inventing a number it can see the real value of.
 *
 * @param {ReturnType<typeof layout>} model
 * @returns {{level: "warn"|"crit", text: string, buses: string[]}[]}
 */
export function contentionWarnings(model) {
  const out = [];
  const buses = model.controllers.flatMap((c) => c.buses);

  for (const b of buses) {
    if (b.devices.length > BUSY_DEVICE_COUNT) {
      out.push({
        level: "warn",
        buses: [b.name],
        text: `${b.name} carries ${b.devices.length} devices. Systemcore has `
          + `${SYSTEMCORE_BUS_COUNT} buses — spreading these out will cut utilisation.`,
      });
    }
    if (b.utilization !== null && b.utilization > UTILIZATION_WARN) {
      out.push({
        level: "crit",
        buses: [b.name],
        text: `${b.name} is at ${Math.round(b.utilization * 100)}% — past the point Systemcore `
          + "itself starts warning.",
      });
    }
  }

  /* The pair rules, which are the ones that hide. Two buses at 55% each look fine one at a time and
     together exceed what their shared SPI host can carry; twelve devices split across a pair are
     still twelve devices on one controller. Both read on paper as "they are on different buses". */
  for (const c of model.controllers) {
    if (!c.shared) continue;
    const names = c.buses.map((b) => b.name);

    if (c.deviceCount > BUSY_DEVICE_COUNT && c.buses.every((b) => b.devices.length)) {
      out.push({
        level: "warn",
        buses: names,
        text: `${names.join(" and ")} share an SPI controller and together carry ${c.deviceCount} `
          + "devices. Moving some onto an unpaired bus will help more than splitting them across "
          + "this pair.",
      });
    }
    if (c.utilization !== null && c.utilization > PAIR_UTILIZATION_LIMIT) {
      out.push({
        level: "crit",
        buses: names,
        text: `${names.join(" and ")} share an SPI controller and together sit at `
          + `${Math.round(c.utilization * 100)}%. Neither looks bad alone — move devices onto an `
          + "unpaired bus rather than shuffling them between these two.",
      });
    }
  }
  return out;
}

/**
 * The CAN half of the robot's own preflight, out of /Catalyst/Preflight/Findings.
 *
 * Preflight.run() publishes one line per finding, formatted by Preflight.Finding.toString():
 * `[BLOCKER] what — detail`, `[warn]    what — detail`, or `[ok]      what` with no detail. The two
 * that concern this page are titled "CAN plan" (CANBusPlanner.validate) and "CAN layout"
 * (CANRegistry.contentionWarnings).
 *
 * Only those two are kept. Preflight has plenty to say about storage and battery and the command
 * runtime, and none of it belongs on a page about CAN buses.
 *
 * @param {string[]|null|undefined} rows
 * @returns {{level: "ok"|"warn"|"crit", text: string}[]}
 */
export function parsePreflightCan(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const m = /^\[(BLOCKER|warn|ok)\]\s+(.*)$/.exec(String(row ?? ""));
    if (!m) continue;
    const [what, detail] = splitFinding(m[2]);
    if (what !== "CAN plan" && what !== "CAN layout") continue;
    out.push({
      level: m[1] === "BLOCKER" ? "crit" : m[1] === "warn" ? "warn" : "ok",
      text: detail || what,
    });
  }
  return out;
}

/* An em dash with a space either side separates a finding's title from its detail. Split once and
   once only: a detail sentence may well contain another one, and taking the last would cut a
   sentence in half. */
function splitFinding(body) {
  const at = body.indexOf(" — ");
  return at < 0 ? [body.trim(), ""] : [body.slice(0, at).trim(), body.slice(at + 3).trim()];
}

/**
 * Utilisation as the page prints it.
 *
 * Whole percents, because a bus does not hold still to a tenth and a figure that flickers in its
 * last digit is read as instability rather than as precision. Absent stays absent.
 *
 * @param {number|null} fraction 0–1
 * @returns {string|null}
 */
export function utilizationText(fraction) {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return null;
  return `${Math.round(fraction * 100)}%`;
}

/**
 * How wide the bar is drawn, 0–100.
 *
 * Clamped, and that matters at the top end: a shared controller's combined utilisation legitimately
 * exceeds 100% of one bus, and a bar wider than its track is a layout bug rather than a reading.
 * The number beside it still says the real figure.
 *
 * @param {number|null} fraction
 * @param {number} full the fraction the track represents — 1 for a bus, PAIR_UTILIZATION_LIMIT for a pair
 * @returns {number}
 */
export function barWidth(fraction, full = 1) {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(100, (fraction / full) * 100));
}

/**
 * Whether a bus's error counters have anything to say.
 *
 * A bus does not go from healthy to bus-off — the receive and transmit error counters climb first,
 * and 128 is where a CAN controller enters error-passive. Catching that in the pit is the difference
 * between finding a loose connector and finding it during an elimination.
 * CANBusHealth.BusStatus.hasErrorActivity(), same threshold.
 *
 * @param {object|null} health
 * @returns {boolean}
 */
export const ERROR_PASSIVE = 128;

export function hasErrorActivity(health) {
  if (!health) return false;
  return (health.rec ?? 0) >= ERROR_PASSIVE || (health.tec ?? 0) >= ERROR_PASSIVE;
}
