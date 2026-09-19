// What moves on the robot, and how, read from the CAD's geometry.
//
// Every function here works on part records built by robot-cad.mjs:
//   { name, label, assemblies, top, faces, cls, keep, reason, matrix }
// where `faces` are the part's analysed B-rep faces in its own coordinates (mesh.mjs) and `matrix` takes
// them to the frame being worked in (the CAD frame while finding the robot frame, the robot frame after).
// No dependencies.

import { add, cross, dot, length, normalize, scale, sub, symmetricEigen, transformDirection, transformPoint } from "./geometry.mjs";

const DEG = 180 / Math.PI;

/* ---- faces in a working frame ---- */

/**
 * A part's cylindrical surfaces in the working frame, cached per matrix.
 *
 * Onshape splits a full cylinder into two half-cylinder faces, so faces on one axis with one radius are
 * merged into a single surface whose sweep is the sum of theirs (capped at 360) and whose length spans
 * them all. `index` is the largest face's index, `faces` all of them.
 */
export function cylinders(part) {
  if (part._cyl && part._cylMatrix === part.matrix) return part._cyl;
  const raw = part.faces
    .map((f, index) => (f.kind === "cylinder" ? { index, area: f.area, radius: f.radius, length: f.length, sweep: f.sweep, axis: normalize(transformDirection(part.matrix, f.axis)), centre: transformPoint(part.matrix, f.centre) } : null))
    .filter(Boolean)
    .sort((a, b) => b.area - a.area);
  const merged = [];
  for (const c of raw) {
    const s = dot(c.centre, c.axis);
    const lo = s - c.length / 2, hi = s + c.length / 2;
    const into = merged.find((m) => Math.abs(m.radius - c.radius) < 0.0003 && sameLine(m, c, 0.0005) && lo <= m.hi + 0.0005 && hi >= m.lo - 0.0005);
    if (!into) {
      merged.push({ ...c, faces: [c.index], lo, hi });
      continue;
    }
    const sign = Math.sign(dot(into.axis, c.axis)) || 1;
    const clo = sign > 0 ? lo : -hi, chi = sign > 0 ? hi : -lo;
    into.faces.push(c.index);
    into.area += c.area;
    into.sweep = Math.min(360, into.sweep + c.sweep);
    into.lo = Math.min(into.lo, clo);
    into.hi = Math.max(into.hi, chi);
  }
  part._cyl = merged.map((m) => {
    const mid = (m.lo + m.hi) / 2;
    const offset = mid - dot(m.centre, m.axis);
    return { index: m.index, faces: m.faces, area: m.area, radius: m.radius, sweep: m.sweep, axis: m.axis, length: m.hi - m.lo, centre: add(m.centre, scale(m.axis, offset)) };
  });
  part._cylMatrix = part.matrix;
  return part._cyl;
}

/** A part's planar faces in the working frame, with their extents along the frame axes. */
export function planes(part) {
  if (part._pl && part._plMatrix === part.matrix) return part._pl;
  part._pl = part.faces
    .map((f, index) => {
      if (f.kind !== "plane") return null;
      const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (let i = 0; i < f.positions.length; i += 3) {
        const p = transformPoint(part.matrix, [f.positions[i], f.positions[i + 1], f.positions[i + 2]]);
        for (let k = 0; k < 3; k++) {
          box.min[k] = Math.min(box.min[k], p[k]);
          box.max[k] = Math.max(box.max[k], p[k]);
        }
      }
      const normal = normalize(transformDirection(part.matrix, f.normal));
      const point = transformPoint(part.matrix, [f.positions[0], f.positions[1], f.positions[2]]);
      return { index, area: f.area, normal, offset: dot(normal, point), box };
    })
    .filter(Boolean);
  part._plMatrix = part.matrix;
  return part._pl;
}

/** Every vertex of a part in the working frame. */
export function vertices(part) {
  const out = [];
  for (const f of part.faces) {
    for (let i = 0; i < f.positions.length; i += 3) out.push(transformPoint(part.matrix, [f.positions[i], f.positions[i + 1], f.positions[i + 2]]));
  }
  return out;
}

export function boxOf(points) {
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < box.min[k]) box.min[k] = p[k];
      if (p[k] > box.max[k]) box.max[k] = p[k];
    }
  }
  return box;
}

export function partBox(part) {
  if (part._box && part._boxMatrix === part.matrix) return part._box;
  part._box = boxOf(vertices(part));
  part._boxMatrix = part.matrix;
  return part._box;
}

/** Distance from point p to the line through `point` along unit `axis`. */
export function lineDistance(p, point, axis) {
  const d = sub(p, point);
  return length(sub(d, scale(axis, dot(d, axis))));
}

/** Two axis lines are the same line: parallel within ~1.8° and within `tolerance` metres of each other. */
export function sameLine(a, b, tolerance = 0.0015) {
  return Math.abs(dot(a.axis, b.axis)) > 0.9995 && lineDistance(b.centre, a.centre, a.axis) <= tolerance;
}

/** The dominant axis of a part's full cylinders: the axis a gear, pulley, wheel or tube turns on. */
export function mainAxis(part, { minSweep = 300 } = {}) {
  const full = cylinders(part).filter((c) => c.sweep >= minSweep);
  if (!full.length) return null;
  /* Weight each line by area and pick the heaviest, so a pulley's bore and hub vote together. */
  const lines = [];
  for (const c of full) {
    const line = lines.find((l) => sameLine(l, c, 0.001));
    if (line) {
      line.weight += c.area;
      line.maxRadius = Math.max(line.maxRadius, c.radius);
      line.members.push(c);
    } else lines.push({ axis: c.axis, centre: c.centre, weight: c.area, maxRadius: c.radius, members: [c] });
  }
  lines.sort((a, b) => b.weight - a.weight);
  const best = lines[0];
  /* Span along the axis, from every vertex of the part. */
  let lo = Infinity, hi = -Infinity;
  for (const v of vertices(part)) {
    const s = dot(sub(v, best.centre), best.axis);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  const centre = add(best.centre, scale(best.axis, (lo + hi) / 2));
  return { axis: best.axis, centre, radius: best.maxRadius, length: hi - lo, lines };
}

/* ---- swerve modules ---- */

/**
 * Find the swerve modules and the up direction, in the CAD frame. A module is a part whose name says
 * swerve and that has a wheel: a horizontal cylinder of 1.5–3 in radius at its lowest point.
 */
export function findModules(parts) {
  const candidates = parts.filter((p) => /swerve/i.test(p.label) && p.size >= 0.15 && p.faces.some((f) => f.kind === "cylinder" && f.radius >= 0.03 && f.radius <= 0.08 && f.sweep >= 180));
  if (candidates.length < 3) throw new Error(`found ${candidates.length} swerve module candidates; this pipeline needs the four modules to place the robot frame`);

  /* Up: the common direction of the modules' smaller cylinders (bearings, motors, the steering stack),
     which in any swerve module are vertical. */
  const scatter = [0, 0, 0, 0, 0, 0];
  for (const part of candidates) {
    for (const c of cylinders(part)) {
      if (c.radius > 0.035 || c.sweep < 180) continue;
      const [x, y, z] = c.axis;
      scatter[0] += c.area * x * x; scatter[1] += c.area * x * y; scatter[2] += c.area * x * z;
      scatter[3] += c.area * y * y; scatter[4] += c.area * y * z; scatter[5] += c.area * z * z;
    }
  }
  let up = symmetricEigen(scatter)[2].vector;

  const modules = candidates
    .map((part) => {
      const cyl = cylinders(part);
      const bottom = (c) => dot(c.centre, up) - c.radius;
      const treads = cyl.filter((c) => c.radius >= 0.03 && c.radius <= 0.08 && c.sweep >= 180 && Math.abs(dot(c.axis, up)) < 0.05);
      if (!treads.length) return null;
      treads.sort((a, b) => bottom(a) - bottom(b) || b.area - a.area);
      return { part, tread: treads[0] };
    })
    .filter(Boolean);
  if (modules.length < 3) throw new Error(`found ${modules.length} swerve modules with a wheel; this pipeline needs the four modules to place the robot frame`);
  /* Up points from the wheels toward the rest of the module. */
  const box = partBox(modules[0].part);
  const middle = scale(add(box.min, box.max), 0.5);
  if (dot(sub(middle, modules[0].tread.centre), up) < 0) up = scale(up, -1);

  for (const m of modules) {
    const cyl = cylinders(m.part);
    const horizontal = (p) => sub(p, scale(up, dot(p, up)));
    const near = cyl.filter((c) => Math.abs(dot(c.axis, up)) > 0.999 && c.sweep >= 180 && c.radius >= 0.015 && c.radius <= 0.075 && length(sub(horizontal(c.centre), horizontal(m.tread.centre))) < 0.03);
    const clusters = [];
    for (const c of near) {
      const h = horizontal(c.centre);
      const cluster = clusters.find((k) => length(sub(k.h, h)) < 0.001);
      if (cluster) cluster.area += c.area;
      else clusters.push({ h, area: c.area });
    }
    clusters.sort((a, b) => b.area - a.area);
    const steerH = clusters.length ? clusters[0].h : horizontal(m.tread.centre);
    m.steerPoint = add(steerH, scale(up, dot(m.tread.centre, up)));
    m.steerFound = clusters.length > 0;
    m.wheelCenter = m.tread.centre;
    m.wheelRadius = m.tread.radius;
    m.wheelWidth = m.tread.length;
  }
  return { up, modules };
}

/**
 * Split a module's faces into what steers, what rolls, and what is fixed to the frame.
 *
 * The simplified module is one welded body, so the split is geometric. The wheel is every face inside
 * the tread's cylinder. What steers is every face wholly below the plate the steering bearing hangs
 * from (the plate is where the tread is cut off) and within the wheel's sweep of the steering axis;
 * the motors hang below that plate too but sit further out.
 *
 * Positions are in the working frame; returns arrays of face indices.
 */
export function splitModuleFaces(part, module, up) {
  const steerAxisPoint = module.steerPoint;
  const tread = module.tread;
  let treadTop = -Infinity;
  for (const faceIndex of tread.faces ?? [tread.index]) {
    const treadFace = part.faces[faceIndex];
    for (let i = 0; i < treadFace.positions.length; i += 3) {
      const p = transformPoint(part.matrix, [treadFace.positions[i], treadFace.positions[i + 1], treadFace.positions[i + 2]]);
      treadTop = Math.max(treadTop, dot(p, up));
    }
  }
  const cut = treadTop + 0.0005;
  const sweep = Math.hypot(tread.length / 2, tread.radius) + 0.004;
  const wheel = [], steer = [], fixed = [];
  part.faces.forEach((f, index) => {
    let maxHeight = -Infinity, maxRadial = 0, inWheel = true;
    for (let i = 0; i < f.positions.length; i += 3) {
      const p = transformPoint(part.matrix, [f.positions[i], f.positions[i + 1], f.positions[i + 2]]);
      maxHeight = Math.max(maxHeight, dot(p, up));
      const d = sub(p, steerAxisPoint);
      maxRadial = Math.max(maxRadial, length(sub(d, scale(up, dot(d, up)))));
      const w = sub(p, tread.centre);
      const along = dot(w, tread.axis);
      if (Math.abs(along) > tread.length / 2 + 0.003 || length(sub(w, scale(tread.axis, along))) > tread.radius + 0.0015) inWheel = false;
    }
    if (maxHeight > cut) fixed.push(index);
    else if (inWheel) wheel.push(index);
    else if (maxRadial <= sweep) steer.push(index);
    else fixed.push(index);
  });
  return { wheel, steer, fixed, cut, sweepRadius: sweep };
}

/* ---- the frame perimeter and bumpers ---- */

/** The drive frame's outer rails: the box of the Drive assembly's frame tubes, in the robot frame. */
export function framePerimeter(parts) {
  const rails = parts.filter((p) => p.top === "Drive" && /\btube\b/i.test(p.name));
  if (!rails.length) return null;
  const box = boxOf(rails.flatMap((p) => [partBox(p).min, partBox(p).max]));
  return {
    length: box.max[0] - box.min[0],
    width: box.max[2] - box.min[2],
    bottom: box.min[1],
    top: box.max[1],
    center: [(box.max[0] + box.min[0]) / 2, (box.max[2] + box.min[2]) / 2],
    rails: rails.length,
  };
}

/* ---- rollers ---- */

const TUBE = /\bOD x\b.*\bID\b|\btube\b/i;
const DRIVE = /\b(pulley|gear|sprocket)\b/i;

/**
 * Rollers: tubes that something turns. A tube is a roller when a pulley, gear or sprocket shares its
 * axis within its length, or when it sits in a sub-assembly named as a roller; a flywheel part is one
 * by name. Returns `{ tube, axis, centre, radius, length, members }` where members are the kept parts
 * that turn with it (the tube, end hubs, its pulleys), and `lines` the smaller coaxial parts left out
 * because the tube turns on bearings around them.
 */
export function findRollers(parts) {
  const kept = parts.filter((p) => p.keep);
  const withAxis = new Map();
  const axisOf = (p) => {
    if (!withAxis.has(p)) withAxis.set(p, mainAxis(p));
    return withAxis.get(p);
  };
  const isFlywheel = (p) => /flywheel/i.test(p.name) && !/bracket|plate|mount|spacer/i.test(p.name);
  const tubes = kept.filter((p) => (TUBE.test(p.name) || isFlywheel(p)) && p.top !== "Drive").map((p) => ({ part: p, axis: axisOf(p) })).filter((t) => t.axis && t.axis.radius >= 0.009 && (t.axis.length >= 0.2 || isFlywheel(t.part)));
  const rollers = [];
  const claimed = new Set();
  /* Larger tubes first, so a dead axle inside a roller joins the roller rather than becoming one. */
  tubes.sort((a, b) => b.axis.radius - a.axis.radius);
  for (const t of tubes) {
    if (claimed.has(t.part)) continue;
    const line = { axis: t.axis.axis, centre: t.axis.centre };
    const span = t.axis.length / 2 + 0.09;
    const coaxial = parts.filter((p) => p !== t.part && p.top === t.part.top).filter((p) => {
      const a = axisOf(p);
      if (!a || !sameLine(line, a, 0.0015)) return false;
      if (Math.abs(dot(sub(a.centre, line.centre), line.axis)) > span) return false;
      /* Only parts of revolution turn with a roller: a bracket whose bearing bore happens to sit on the
         roller's axis reaches far beyond its bore. */
      return revolutionReach(p, line) <= Math.max(a.radius * 1.35 + 0.004, 0.01);
    });
    const assembly = t.part.assemblies[t.part.assemblies.length - 1];
    const inRollerAssembly = t.part.assemblies.length > 1 && /roller/i.test(assembly);
    const driven = coaxial.some((p) => DRIVE.test(p.name)) || isFlywheel(t.part);
    if (!driven && !inRollerAssembly) continue;
    /* A pulley that rides on a bearing ("circular bore") means the tube spins on bearings around its
       shaft; parts bored to the hex shaft then belong to the shaft, not the tube. */
    const onBearings = coaxial.some((p) => DRIVE.test(p.name) && /circular bore/i.test(p.name));
    const members = [t.part];
    const shaft = [];
    for (const p of coaxial) {
      if (onBearings && /\bhex\b|thunderhex|churro/i.test(p.name) && !/circular bore/i.test(p.name)) shaft.push(p);
      else if (p.keep) members.push(p);
    }
    for (const p of members) claimed.add(p);
    rollers.push({ tube: t.part, axis: t.axis.axis, centre: t.axis.centre, radius: t.axis.radius, length: t.axis.length, members, shaft, onBearings, assembly: inRollerAssembly ? assembly : null });
  }
  return rollers;
}

/** How far a part reaches from a line: its largest vertex distance from it. */
export function revolutionReach(part, line) {
  let reach = 0;
  for (const v of vertices(part)) reach = Math.max(reach, lineDistance(v, line.centre, line.axis));
  return reach;
}

/* ---- belts ---- */

/** HTD 5 mm belts: the pulleys a belt wraps, as { centre, axis, teeth } from the belt's inner arcs. */
export function beltPulleys(part) {
  if (!/\bhtd ?5\b|\b5 ?mm\b/i.test(part.name) || !/belt/i.test(part.name)) return [];
  const arcs = cylinders(part);
  const lines = [];
  for (const c of arcs) {
    const line = lines.find((l) => sameLine(l, c, 0.001));
    if (line) {
      line.inner = Math.min(line.inner, c.radius);
    } else lines.push({ axis: c.axis, centre: c.centre, inner: c.radius });
  }
  /* The inner (toothed) face of an HTD5 belt sits 2.93 mm inside the pitch line (measured on 15, 18
     and 45 tooth pulleys in this CAD), so the tooth count comes out whole. */
  return lines.map((l) => ({ axis: l.axis, centre: l.centre, teeth: Math.round((2 * Math.PI * (l.inner + 0.00293)) / 0.005) }));
}

/* ---- the hood ---- */

/**
 * The hood: its parts, pivot, and the pins that carry parts with it.
 *
 * `core` are the hood's own brackets (by name). The pivot is the hole line in the core that coincides
 * with a roller's axis (the flywheel it turns around); every other hole line in the core is a pin, and
 * a part turns with the hood when its own axis is one of those pins. A belt goes with the hood when all
 * the pulleys it wraps are on pins or on the pivot.
 */
export function findHood(parts, rollers, { coreName = /^Shooter Hood (Rack |Connection |Bearing )?Bracket$/i } = {}) {
  const core = parts.filter((p) => coreName.test(p.name));
  if (!core.length) return null;
  const holes = [];
  for (const p of core) {
    for (const c of cylinders(p)) {
      if (c.sweep < 300) continue;
      const line = holes.find((l) => sameLine(l, c, 0.0015));
      if (line) line.area += c.area;
      else holes.push({ axis: c.axis, centre: c.centre, radius: c.radius, area: c.area });
    }
  }
  const pivotRoller = rollers
    .filter((r) => holes.some((h) => sameLine(h, r, 0.002)))
    .filter((r) => !core.includes(r.tube))
    .sort((a, b) => b.radius - a.radius)[0];
  if (!pivotRoller) return { core, holes, pivot: null };
  const pivotLine = { axis: pivotRoller.axis, centre: pivotRoller.centre };
  const pins = holes.filter((h) => !sameLine(h, pivotLine, 0.002));

  const members = new Set(core);
  const onPin = (line) => pins.some((pin) => sameLine(pin, line, 0.0015));
  const carried = [];
  for (const r of rollers) {
    if (onPin(r)) {
      carried.push(r);
      for (const p of r.members) members.add(p);
      for (const p of r.shaft) members.add(p);
    }
  }
  const shooter = parts.filter((p) => p.top === core[0].top && !members.has(p));
  for (const p of shooter) {
    if (/belt/i.test(p.name)) {
      const pulleys = beltPulleys(p);
      if (pulleys.length && pulleys.every((q) => onPin(q) || sameLine(pivotLine, q, 0.0015)) && pulleys.some((q) => onPin(q))) members.add(p);
      continue;
    }
    const a = mainAxis(p);
    if (a && onPin(a) && !rollers.some((r) => r.members.includes(p) && !carried.includes(r))) members.add(p);
  }
  return { core, holes, pins, pivotRoller, pivot: { point: pivotRoller.centre, axis: pivotRoller.axis }, members, carried };
}

/**
 * The hood's travel from its rack: the angular span of the rack's teeth about the pivot, and where the
 * fixed pinion that drives it sits. Angles are measured about `axis` (right-handed), from the robot's
 * forward direction projected into the plane of rotation.
 */
export function hoodRack(parts, hood) {
  const rackParts = hood.core.filter((p) => /\brack\b/i.test(p.name));
  if (!rackParts.length) return null;
  const { point } = hood.pivot;
  /* Angles are counter-clockwise about +z (from +x toward +y), whichever way the fitted axis points. */
  const axis = hood.pivot.axis[2] < 0 ? scale(hood.pivot.axis, -1) : hood.pivot.axis;
  const ref = normalize(sub([1, 0, 0], scale(axis, dot([1, 0, 0], axis))));
  const ortho = cross(axis, ref);
  const polar = (p) => {
    const d = sub(p, point);
    const x = dot(d, ref), y = dot(d, ortho);
    return { r: Math.hypot(x, y), a: Math.atan2(y, x) * DEG };
  };
  const pts = vertices(rackParts[0]).map(polar);
  const rMax = Math.max(...pts.map((p) => p.r));
  /* The teeth are the outermost feature of a sector rack: everything within one tooth depth of its rim. */
  const teeth = pts.filter((p) => p.r >= rMax - 0.0065);
  const span = [Math.min(...teeth.map((p) => p.a)), Math.max(...teeth.map((p) => p.a))];
  const tipRadius = rMax;
  /* The pinion: a fixed gear whose axis is parallel to the pivot, just outside the teeth, within their
     angular span. */
  const pinion = parts
    .filter((p) => p.keep !== undefined && /\bgear\b/i.test(p.name) && !hood.members.has(p))
    .map((p) => ({ part: p, axis: mainAxis(p) }))
    .filter((g) => g.axis && Math.abs(dot(g.axis.axis, axis)) > 0.999)
    .map((g) => ({ ...g, polar: polar(g.axis.centre), outer: g.axis.radius }))
    .filter((g) => g.polar.a >= span[0] - 5 && g.polar.a <= span[1] + 5 && g.polar.r > tipRadius - 0.005 && g.polar.r < tipRadius + 0.04)
    .sort((a, b) => a.polar.r - b.polar.r)[0];
  return { span, tipRadius, pinion: pinion ? { name: pinion.part.name, angle: pinion.polar.a, distance: pinion.polar.r } : null, rackTeethAngles: teeth.length };
}

/* ---- the intake ---- */

/**
 * The intake's slide axis, from its racks: the long straight edges of a rack, projected square to the
 * robot's sides, pointing forward.
 */
export function intakeAxis(rackParts) {
  let sum = [0, 0, 0];
  let area = 0;
  for (const part of rackParts) {
    for (const pl of planes(part)) {
      if (Math.abs(pl.normal[2]) > 0.1) continue; // a face of the plate itself
      const extent = Math.hypot(pl.box.max[0] - pl.box.min[0], pl.box.max[1] - pl.box.min[1]);
      if (extent < 0.2) continue; // teeth and ends
      let dir = normalize([pl.normal[1], -pl.normal[0], 0]);
      if (dir[0] < 0) dir = scale(dir, -1);
      sum = add(sum, scale(dir, pl.area));
      area += pl.area;
    }
  }
  return area ? { axis: normalize(sum), faces: area } : null;
}

/**
 * Whether a moving part is resting against a fixed one along `axis`: a face of each, square to the axis,
 * at the same station, facing each other, overlapping. Returns the contacts with their `side`: "outer"
 * when the fixed face is ahead of the moving one (it stops further travel along +axis), "inner" when
 * behind.
 */
export function stopContacts(moving, fixed, axis, { tolerance = 0.0005 } = {}) {
  const contacts = [];
  for (const m of moving) {
    for (const pm of planes(m)) {
      const cm = dot(pm.normal, axis);
      if (Math.abs(cm) < 0.99) continue;
      const sm = pm.offset * Math.sign(cm);
      for (const f of fixed) {
        for (const pf of planes(f)) {
          const cf = dot(pf.normal, axis);
          if (Math.abs(cf) < 0.99 || Math.sign(cf) === Math.sign(cm)) continue;
          const sf = pf.offset * Math.sign(cf);
          if (Math.abs(sm - sf) > tolerance) continue;
          const overlap = [0, 1, 2].every((k) => Math.min(pm.box.max[k], pf.box.max[k]) - Math.max(pm.box.min[k], pf.box.min[k]) > -tolerance);
          if (!overlap) continue;
          contacts.push({ moving: m.name, fixed: f.name, station: sm, side: cm > 0 ? "outer" : "inner" });
        }
      }
    }
  }
  return contacts;
}

/* ---- the hopper ---- */

/** Count FUEL balls that fit in a box on a hexagonal close-packed lattice. */
export function latticeCapacity(box, diameter) {
  const r = diameter / 2;
  const lo = box.min.map((v) => v + r);
  const hi = box.max.map((v) => v - r);
  if (lo.some((v, k) => v > hi[k] + 1e-9)) return 0;
  const layerStep = diameter * Math.sqrt(2 / 3);
  const rowStep = (diameter * Math.sqrt(3)) / 2;
  let count = 0;
  for (let layer = 0; lo[1] + layer * layerStep <= hi[1] + 1e-9; layer++) {
    const layerShiftX = layer % 2 ? r : 0;
    const layerShiftZ = layer % 2 ? rowStep / 3 : 0;
    for (let row = 0; lo[2] + layerShiftZ + row * rowStep <= hi[2] + 1e-9; row++) {
      const shift = (row % 2 ? r : 0) + layerShiftX;
      for (let col = 0; lo[0] + shift + col * diameter <= hi[0] + 1e-9; col++) count++;
    }
  }
  return count;
}
