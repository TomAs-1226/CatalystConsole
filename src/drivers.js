/* Driver profiles.
 *
 * A team has more than one person in front of this screen: a driver, an operator, a coach, someone in
 * the pit. They do not want the same board. Tesla keeps a profile per driver and restores the seat, the
 * mirrors and the screen when one gets in; this keeps the board layout and the settings, and restores
 * them when a profile is chosen.
 *
 * A profile also carries robot settings: the joystick deadband, the slew limit, the speed cap - whatever
 * makes the robot feel the way that driver likes it. Tesla moves the seat as well as the screen, and a
 * driver who has to type their deadband in again every time they take the sticks ends up driving with
 * somebody else's.
 *
 * That is a write to the robot, so it is worth being exact about which one. A profile holds nothing but
 * keys the robot itself declared tunable, and applying one writes them exactly the way Shuffleboard or
 * Elastic writes a tunable - the console's one write path, the same one the Tune sheet uses. It cannot
 * reach a key the robot did not offer, and nothing here goes anywhere near a control namespace. A
 * per-driver setting that let this screen drive the robot would be a way in through the back door; a
 * per-driver value for a number the robot published as adjustable is what dashboards have always been for.
 *
 * The store is one object in localStorage: the profiles, and which one is in use. Every read is checked
 * field by field, because storage can hold anything and a bad profile out of here would land in the
 * board builder - or, now, on the wire.
 */

/** Six colours a profile can be told apart by. Not the automation blue: that means "the robot is doing
 *  this" everywhere else in the console, and a person is not automation. */
export const DRIVER_COLOURS = Object.freeze([
  { id: "slate", label: "Slate", hex: "#7d8a99" },
  { id: "sand", label: "Sand", hex: "#b0a083" },
  { id: "moss", label: "Moss", hex: "#7f9279" },
  { id: "clay", label: "Clay", hex: "#b08b7d" },
  { id: "plum", label: "Plum", hex: "#96849d" },
  { id: "steel", label: "Steel", hex: "#8e8e93" },
]);

export const NAME_MAX = 24;
export const DRIVERS_MAX = 8;

/** How many robot settings one profile may carry. Nobody tunes two dozen numbers per driver, and the cap
 *  is what stops a corrupted store from handing the console a thousand keys to write on a profile switch. */
export const ROBOT_MAX = 24;

const colourOf = (id) => DRIVER_COLOURS.find((c) => c.id === id) ?? DRIVER_COLOURS[0];

/** The hex a profile's figure and chip are drawn in. */
export function driverHex(driver) {
  return colourOf(driver?.colour).hex;
}

/** A name as it will be stored: trimmed, one line, and never empty. */
export function cleanName(name, fallback = "Driver") {
  const text = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return text || fallback;
}

/**
 * A robot setting's value as this console is able to write it: a finite number, or the true or false of a
 * switch. A string, a NaN, an array, a value out of a store somebody edited by hand - none of those is
 * something that can go to a tunable, so each is dropped rather than carried as far as the wire.
 *
 * `null` means "not a value", which is why every caller tests against it rather than for falsiness: `0`
 * and `false` are both perfectly good settings.
 */
function readValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** A profile's robot settings as they are on disk, repaired: key to value, unreadable entries dropped. */
export function readRobotSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!key || Object.keys(out).length >= ROBOT_MAX) continue;
    const v = readValue(value);
    if (v === null) continue;
    out[key] = v;
  }
  return out;
}

let nextId = 1;
/** Ids are only ever compared with each other, so a counter and the clock are enough. */
function makeId() {
  nextId += 1;
  return `d${Date.now().toString(36)}${nextId.toString(36)}`;
}

/** A new profile. `settings` and `layout` are this console's own shapes and are stored as given; `robot`
 *  is checked on the way in, because everything in it is eventually written to a robot. */
export function makeDriver({ name, colour, settings = null, layout = null, robot = null } = {}) {
  return {
    id: makeId(),
    name: cleanName(name),
    colour: colourOf(colour).id,
    settings: settings ? { ...settings } : null,
    layout: Array.isArray(layout) ? layout.map((t) => ({ ...t, cfg: { ...(t.cfg || {}) } })) : null,
    robot: readRobotSettings(robot),
  };
}

function readDriver(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  return {
    id: raw.id,
    name: cleanName(raw.name),
    colour: colourOf(raw.colour).id,
    settings: raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings) ? { ...raw.settings } : null,
    layout: Array.isArray(raw.layout) ? raw.layout.filter((t) => t && typeof t === "object").map((t) => ({ ...t })) : null,
    robot: readRobotSettings(raw.robot),
  };
}

/**
 * The store as it is on disk, repaired. Anything unreadable is dropped rather than refused: a driver
 * opening the console wants their board, not a dialog about storage.
 */
export function readDrivers(raw) {
  const parsed = typeof raw === "string" ? safeParse(raw) : raw;
  const list = [];
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.list)) {
    for (const item of parsed.list.slice(0, DRIVERS_MAX)) {
      const driver = readDriver(item);
      if (driver && !list.some((d) => d.id === driver.id)) list.push(driver);
    }
  }
  const active = list.some((d) => d.id === parsed?.active) ? parsed.active : list[0]?.id ?? null;
  return { list, active };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** What goes to storage. */
export function writeDrivers(store) {
  return JSON.stringify({ active: store.active, list: store.list });
}

/** The profile in use, or null when none has been made yet. */
export function activeDriver(store) {
  return store.list.find((d) => d.id === store.active) ?? null;
}

/**
 * Switch to `id`, keeping what the current profile was last seen with. `current` is `{ settings, layout }`
 * as they are right now; they are written into the profile being left, so a profile always remembers the
 * board it was last used with without anyone having to press save.
 *
 * Returns `{ store, driver, restore }`: the new store, the profile now in use, and what the console
 * should apply - `restore.settings` and `restore.layout` are null when that profile has never been used
 * and should keep whatever is on screen, and `restore.robot` is what to write to the robot.
 *
 * The robot settings of the profile being left are not touched. What the robot is set to right now is
 * not necessarily what that driver asked for - it could be a number somebody changed in Tune between
 * matches - and a profile that quietly swallowed the robot's state every time it was put away would
 * hand it back the next time it was picked up. Taking the robot's values is a deliberate press.
 */
export function switchDriver(store, id, current = null) {
  const target = store.list.find((d) => d.id === id);
  if (!target) {
    return { store, driver: activeDriver(store), restore: { settings: null, layout: null, robot: {} } };
  }
  const list = store.list.map((d) => (d.id === store.active && current ? { ...d, ...capture(current) } : d));
  const driver = list.find((d) => d.id === id);
  return {
    store: { list, active: id },
    driver,
    restore: { settings: driver.settings, layout: driver.layout, robot: { ...driver.robot } },
  };
}

/** What a profile remembers of the console as it is now. Board and console settings only: see above. */
export function capture({ settings = null, layout = null } = {}) {
  return {
    settings: settings ? { ...settings } : null,
    layout: Array.isArray(layout) ? layout.map((t) => ({ ...t, cfg: { ...(t.cfg || {}) } })) : null,
  };
}

/** Add a profile and make it the one in use, remembering what the last one was left with. */
export function addDriver(store, driver, current = null) {
  if (store.list.length >= DRIVERS_MAX) return { store, driver: activeDriver(store), added: false };
  const list = store.list.map((d) => (d.id === store.active && current ? { ...d, ...capture(current) } : d));
  list.push(driver);
  return { store: { list, active: driver.id }, driver, added: true };
}

/** Rename or recolour. */
export function updateDriver(store, id, changes) {
  const list = store.list.map((d) => {
    if (d.id !== id) return d;
    return {
      ...d,
      name: changes.name === undefined ? d.name : cleanName(changes.name, d.name),
      colour: changes.colour === undefined ? d.colour : colourOf(changes.colour).id,
    };
  });
  return { list, active: store.active };
}

/**
 * Remove a profile. The last one cannot be removed - a console with no profile has nowhere to keep the
 * board - and removing the one in use moves to its neighbour.
 */
export function removeDriver(store, id) {
  if (store.list.length <= 1 || !store.list.some((d) => d.id === id)) return { store, removed: false };
  const index = store.list.findIndex((d) => d.id === id);
  const list = store.list.filter((d) => d.id !== id);
  const active = store.active === id ? list[Math.min(index, list.length - 1)].id : store.active;
  return { store: { list, active }, removed: true };
}

/**
 * Set one robot setting on a profile, or drop it with a value of `null`.
 *
 * A value the console could not write is not stored: a profile is a list of writes waiting to happen, so
 * anything that cannot be written has no business being in one. At the cap a new key is refused and the
 * store comes back as it was - the panel stops offering more before that, and this is the floor under it.
 */
export function setRobotSetting(store, id, key, value) {
  if (!key) return store;
  const list = store.list.map((d) => {
    if (d.id !== id) return d;
    const robot = { ...d.robot };
    if (value === null) delete robot[key];
    else {
      const v = readValue(value);
      if (v === null) return d;
      if (!(key in robot) && Object.keys(robot).length >= ROBOT_MAX) return d;
      robot[key] = v;
    }
    return { ...d, robot };
  });
  return { list, active: store.active };
}

/**
 * Take what the robot is set to now into a profile: `values` is key to reading, and each one the console
 * can write replaces what the profile held. Keys it holds that are not in `values` are left alone, so a
 * reading that was missing from the wire leaves the stored setting standing rather than blanking it.
 */
export function captureRobot(store, id, values) {
  const taken = readRobotSettings(values);
  const list = store.list.map((d) => {
    if (d.id !== id) return d;
    const robot = { ...d.robot };
    for (const [key, value] of Object.entries(taken)) {
      if (!(key in robot) && Object.keys(robot).length >= ROBOT_MAX) continue;
      robot[key] = value;
    }
    return { ...d, robot };
  });
  return { list, active: store.active };
}

/**
 * What a profile would do to the robot in front of it.
 *
 * `declared` is what the robot published as tunable - `{ key, kind }` and whatever else the manifest said
 * about it, where `kind` is the type the value has on the wire, or null when the robot has declared the
 * key without publishing a value yet. This is the whole of the rule that the console only ever writes
 * what the robot offered: a stored setting this robot does not declare is reported, never written, and
 * the panel shows it as a dash rather than as a number that means something here.
 *
 * Returns `{ rows, ready, missing }`: every stored setting in the order it was added, each with the
 * declaration it matched or null; the ones that can actually be written; and how many cannot.
 */
export function robotPlan(driver, declared = []) {
  const byKey = new Map();
  for (const entry of declared) {
    if (entry && typeof entry.key === "string" && entry.key) byKey.set(entry.key, entry);
  }
  /* A row for everything the robot declares, whether or not this profile has an opinion about it. The
   * robot is what says which settings exist - a driver should not have to know the name of a tunable to
   * find it, and a console that made them add each one by hand would be asking them to keep a list the
   * robot is already broadcasting.
   *
   * `value` is the profile's own answer, or null for "this profile does not set this one", which is a
   * real state and not a missing one: that setting simply stays wherever the robot has it.
   */
  const held = driver?.robot ?? {};
  const rows = [];
  for (const entry of byKey.values()) {
    const value = entry.key in held ? held[entry.key] : null;
    const wants = typeof value === "boolean" ? "bool" : "num";
    const fits = value === null || entry.kind == null || entry.kind === wants;
    rows.push({ key: entry.key, value, entry, writable: fits && value !== null, set: value !== null });
  }
  /* Anything the profile kept that this robot no longer declares. It cannot be written and it is not a
   * mistake worth a dialog - it is one row saying this robot does not have that setting. */
  for (const [key, value] of Object.entries(held)) {
    if (byKey.has(key)) continue;
    rows.push({ key, value, entry: null, writable: false, set: true });
  }
  return {
    rows,
    ready: rows.filter((r) => r.writable).map(({ key, value }) => ({ key, value })),
    missing: rows.filter((r) => r.set && !r.writable).length,
  };
}

/* -------------------------------------------------------------- the robot's manifests */

/* The robot declares what it will let a dashboard change, in a JSON manifest on one topic. The console
 * shows exactly that and nothing more — it never guesses that a topic looks tunable. The schema is in
 * README.md under "The contract with the robot". */
export const TUNABLE_MANIFEST = "/Catalyst/Tunables/.manifest";

/** The tunable manifest's entries as the robot published them, out of a read-only NetworkTables view
 *  with `str`; [] when there is none or it does not parse. */
export function readTunables(read) {
  const src = read.str(TUNABLE_MANIFEST, null);
  if (!src) return [];
  try {
    const parsed = JSON.parse(src);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The manifest with the type each value has on the wire attached, which is what decides both the control
 * drawn for it and whether a stored setting can be written to it. `kind` is null when the robot has
 * declared a key without publishing a value yet - the declaration is the permission, so that is still
 * writable, it is only unknown what it looks like. `read` needs `str`, and `raw` for a key's `{ t, v }`.
 */
export function readDeclaredTunables(read) {
  return readTunables(read)
    .filter((t) => t && typeof t.key === "string" && t.key)
    .map((t) => ({ ...t, kind: read.raw(t.key)?.t ?? null }));
}

/* What the robot's controls do, in a second manifest on one topic: a JSON array of
 * `{ "control", "action", "controller", "combo" }`, of which only the first two are required. It is read
 * and never written - which button does what is the robot's own wiring, and a dashboard that could
 * rebind a button would be a dashboard that drives. Showing it costs nothing and answers the question
 * every new driver asks. The Drivers panel prints this shape on screen when no robot publishes one. */
export const CONTROLS_MANIFEST = "/Catalyst/Controls/.manifest";

/** The controls manifest as `[{ control, action, controller, combo }]`, out of a view with `str`. */
export function readControlBindings(read) {
  const src = read.str(CONTROLS_MANIFEST, null);
  if (!src) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(src);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((b) => b && typeof b.control === "string" && b.control && typeof b.action === "string" && b.action)
    .map((b) => ({
      control: b.control,
      action: b.action,
      /* Which stick it is on. A robot that says nothing has one, and calling it the driver's is the
       * only reading that is true of every robot with a single controller. */
      controller: typeof b.controller === "string" && b.controller ? b.controller : "Driver",
      /* Declared, never inferred from a "+" in the text: the console does not decide what is a
       * combination on the robot's behalf. */
      combo: b.combo === true,
    }));
}
