/* Driver profiles.
 *
 * A team has more than one person in front of this screen: a driver, an operator, a coach, someone in
 * the pit. They do not want the same board. Tesla keeps a profile per driver and restores the seat, the
 * mirrors and the screen when one gets in; this keeps the board layout and the settings, and restores
 * them when a profile is chosen.
 *
 * What it deliberately does not do is change anything about the robot. A profile is about what this
 * screen shows, nothing else - the console does not control the robot, and a per-driver setting that
 * reached the robot would be a way in through the back door.
 *
 * The store is one object in localStorage: the profiles, and which one is in use. Every read is checked
 * field by field, because storage can hold anything and a bad profile out of here would land in the
 * board builder.
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

let nextId = 1;
/** Ids are only ever compared with each other, so a counter and the clock are enough. */
function makeId() {
  nextId += 1;
  return `d${Date.now().toString(36)}${nextId.toString(36)}`;
}

/** A new profile. `settings` and `layout` are this console's own shapes and are stored as given. */
export function makeDriver({ name, colour, settings = null, layout = null } = {}) {
  return {
    id: makeId(),
    name: cleanName(name),
    colour: colourOf(colour).id,
    settings: settings ? { ...settings } : null,
    layout: Array.isArray(layout) ? layout.map((t) => ({ ...t, cfg: { ...(t.cfg || {}) } })) : null,
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
 * and should keep whatever is on screen.
 */
export function switchDriver(store, id, current = null) {
  const target = store.list.find((d) => d.id === id);
  if (!target) return { store, driver: activeDriver(store), restore: { settings: null, layout: null } };
  const list = store.list.map((d) => (d.id === store.active && current ? { ...d, ...capture(current) } : d));
  const driver = list.find((d) => d.id === id);
  return {
    store: { list, active: id },
    driver,
    restore: { settings: driver.settings, layout: driver.layout },
  };
}

/** What a profile remembers of the console as it is now. */
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
