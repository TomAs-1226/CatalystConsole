// Which CAD parts the dashboard model keeps, and what each is made of.
//
// Pure functions over names and colours, so the rules can be read and tested without the CAD. The
// rules are ordered: the first match wins. Drop rules come first, because hardware names mention the
// material too ("#10-32 x 3" L SHCS (Steel, Black Oxide)" is a screw, not steel structure).

/** The material classes a runtime restyles by name. */
export const MATERIAL_CLASSES = ["aluminium", "black", "steel", "poly", "print", "motor", "tread", "belt", "electronics", "other"];

/* Hardware that is either hidden inside something else or too small to read at dashboard scale. Each
   entry is [reason, pattern]; the reason is what the report counts. */
export const DROP_RULES = [
  ["fastener", /\b(BHCS|SHCS|FHCS|SHSS|screw|bolt(?!-spacer)|rivet|locknut|nyloc|nut)\b(?! strip)/i],
  ["fastener", /\bwasher\b/i],
  ["nut strip (inside tube)", /\bnut strip\b|tube connecting nut|cone bumper mount nut/i],
  ["bumper mount (recorded in manifest)", /\bcone bumper mount\b/i],
  ["bearing", /\bbearing\b(?! (bracket|block|plate|mount))|\bbushing\b/i],
  ["grommet / zip tie", /\bgrommet|zip ?tie|cable tie/i],
  ["spacer / standoff", /\bspacer\b(?! plate)|\bstandoff\b|spacer-config|shaft collar/i],
  ["hidden insert", /\badapter\b|\broller hub\b|tube plug|\binsert\b(?! \))/i],
  ["hidden strip", /\bteflon\b|\bptfe\b/i],
];

/* Parts that are named after their material or function. [class, pattern]. */
export const CLASS_RULES = [
  ["electronics", /\b(battery|pdp|pdh|mpm|breaker|roborio|systemcore|canivore|radio|limelight|pigeon|cancoder|vrm|rsl|camera)\b/i],
  ["motor", /\b(kraken|falcon|neo|vortex|cim|minion)\b|\bbrushless motor\b/i],
  ["belt", /\bbelt\b|\bchain\b(?! mount)/i],
  ["tread", /\bwheel\b(?! bracket)|\btread\b|\bcolson\b|\bcompliant\b/i],
  ["poly", /\bpoly(carbonate)?\b|\blexan\b/i],
  ["print", /\bprint(ed)?\b|3d-print|custom htd .*pulley/i],
  ["black", /\bsrpp\b|\bhdpe\b|\buhmw\b|\bdelrin\b|\bacetal\b|\bthunderhex\b|\bchurro\b|\bhex shaft\b/i],
  ["steel", /\bstainless\b|\bsteel\b/i],
  ["metal", /\btube\b|\bOD x\b|\brack\b|\bbracket\b|\bplate\b|\bgear\b|\bpulley\b|\bsprocket\b|\bbaseplate\b|\bchannel\b|\bextrusion\b|\bflywheel\b|\b(6061|7075)\b|\baluminum\b|\baluminium\b/i],
];

/** Strip Onshape's instance suffix: "Intake Front <1>" → "Intake Front". */
export function baseName(name) {
  return String(name ?? "").replace(/\s*<\d+>\s*$/, "").trim();
}

/** A part's name from its node, falling back to the occurrence wrapper Onshape puts around it. */
export function partName(nodeName, occurrenceName) {
  const own = String(nodeName ?? "").trim();
  if (own && own !== "undefined") return own;
  return String(occurrenceName ?? "").replace(/^occurrence of\s*/i, "").trim();
}

/** Colour of a glTF material as sRGB bytes. Onshape names materials "r_g_b_x_y" in 0..1 floats. */
export function materialColour(material) {
  const factor = material?.pbrMetallicRoughness?.baseColorFactor;
  if (Array.isArray(factor)) return factor.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
  const parts = String(material?.name ?? "").split("_").map(Number);
  if (parts.length >= 3 && parts.slice(0, 3).every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return parts.slice(0, 3).map((v) => Math.round(v * 255));
  return [200, 200, 200];
}

/** HSV-ish summary used by the colour fallbacks. */
export function colourTone([r, g, b]) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return { value: max, saturation: max ? (max - min) / max : 0 };
}

const isDarkNeutral = (rgb) => {
  const t = colourTone(rgb);
  return t.value < 0.33 && t.saturation < 0.25;
};

/** Tan and orange CAD colours are how this CAD marks 3D prints when the name does not say so. */
const isPrintColour = ([r, g, b]) => r > 200 && g > 160 && g < 200 && b < 140;

/**
 * Decide what happens to one part.
 *
 * `size` is the diagonal of the part's own bounding box in metres; parts under `minSize` are dropped
 * as too small to read, unless a class rule says they are a motor, a belt or electronics.
 *
 * Returns `{ keep: true, cls }` or `{ keep: false, reason }`.
 */
export function classifyPart({ name, path = [], colour = [200, 200, 200], size = Infinity }, { minSize = 0.012 } = {}) {
  const text = String(name ?? "");
  for (const [reason, pattern] of DROP_RULES) {
    if (!pattern.test(text)) continue;
    /* A printed motor spacer is a visible block, not a standoff. */
    if (reason === "spacer / standoff" && /\bprint\b/i.test(text) && size >= 0.06) break;
    return { keep: false, reason };
  }
  /* Short shafts live inside gearboxes; long ones show between a roller and its plate. */
  if (/\bthunderhex\b|\bhex shaft\b/i.test(text) && size < 0.1) return { keep: false, reason: "short shaft (inside gearbox)" };

  let cls = null;
  for (const [candidate, pattern] of CLASS_RULES) {
    if (pattern.test(text)) {
      cls = candidate;
      break;
    }
  }
  const important = cls === "motor" || cls === "belt" || cls === "electronics";
  if (size < minSize && !important) return { keep: false, reason: "tiny part" };

  /* This CAD draws polycarbonate, sheet and tube alike, in the same near-white; aluminium is grey. */
  if (cls === "metal") cls = isDarkNeutral(colour) ? "black" : /\bOD x\b/i.test(text) && isNearWhite(colour) ? "poly" : "aluminium";
  if (!cls) {
    const inElectronics = path.some((p) => /\b(pdp|pdh|electronics|power)\b/i.test(p));
    if (!text && inElectronics) cls = "electronics";
    else if (!text && path.some((p) => /^drive\b/i.test(p))) cls = "electronics";
    else if (isPrintColour(colour)) cls = "print";
    else if (isDarkNeutral(colour)) cls = "black";
    else if (isNearWhite(colour)) cls = "poly";
    else cls = "other";
  }
  return { keep: true, cls };
}

function isNearWhite(rgb) {
  const t = colourTone(rgb);
  return t.value >= 0.88 && t.saturation < 0.05;
}

/**
 * The class of one face of a part whose faces carry different colours: a simplified swerve module is
 * a single body with its tread, plates and motors told apart only by colour.
 */
export function classifyFace(partClass, faceColour, { treadColours = [] } = {}) {
  if (treadColours.some((c) => Math.abs(c[0] - faceColour[0]) + Math.abs(c[1] - faceColour[1]) + Math.abs(c[2] - faceColour[2]) < 6)) return "tread";
  return partClass;
}
