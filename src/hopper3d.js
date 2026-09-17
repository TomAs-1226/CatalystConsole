/* FUEL inside the robot.
 *
 * The hopper shows as many balls as the hopper estimate says it holds (see mechanisms.js createHopper), in
 * the places the robot's CAD analysis packed. A ball the robot takes in rolls off the carpet in front of
 * the intake, under its front roller and up into the pile; a ball fed to the shooter leaves from the place
 * nearest the feeder, and the rest of the pile moves up behind it the way a conveyor advances a queue. Like
 * the shots, it is a picture of what the estimate says, not a simulation of how the balls move.
 *
 * Where a ball settles depends on where the intake is, so the CAD analysis measured the packing twice -
 * with the intake in and with it out - and a place is drawn between its two answers as the intake slides.
 * The pile compacts as the intake comes in, and the places that only exist inside the deployed tray take
 * their balls with them, because nine balls fit inside this robot stowed and seventeen with the tray out.
 *
 * Everything here is in the robot's own frame (x front, y up, z right), inside the robot model, so it
 * travels and turns with the robot in both views.
 */

import * as THREE from "./vendor/three.module.min.js";
import { FUEL_DIAMETER_M } from "./mechanisms.js";

const RADIUS = FUEL_DIAMETER_M / 2;
/* A pickup: rolled in under the front roller, then carried up into its place. */
const ARRIVE_S = 0.55;
const ROLL_IN = 0.3;
/* Into the feeder. */
const LEAVE_S = 0.2;
/* The pile moving up a place behind a ball that has gone. */
const ADVANCE_S = 0.22;
/* Arrivals in a burst are staggered, so a big intake reads as a stream rather than a teleport. */
const STAGGER_S = 0.07;

/* A place that exists only with the intake out appears over this much of the travel, so it fades in as
   the tray it sits in arrives rather than popping into being at the first millimetre of deploy. */
const APPEARS_FROM = 0.55;
const APPEARS_BY = 0.92;

/**
 * The places FUEL settles in, paired by rank between the intake's two ends. `stowed` and `deployed` are
 * the CAD analysis's own answers - the best packing of real balls inside the real sloped section, with
 * the intake in and out, lowest first, so the first N of either is where N balls settle. Pairing them by
 * rank is what lets a ball be drawn part way through the intake's travel: rank 3 with the intake half out
 * is half way between where it sits stowed and where it sits deployed.
 *
 * Ranks past the stowed list are places that exist only while the intake is out. They have no stowed
 * position at all, which is the honest answer: nine balls fit inside this robot with its intake in, and a
 * tenth has nowhere to be. Drawing one anyway is what put a ball inside the shooter.
 */
export function pairPlaces(stowed = [], deployed = []) {
  const count = Math.max(stowed.length, deployed.length);
  return Array.from({ length: count }, (_, rank) => ({
    at: stowed[rank] ?? null,
    out: deployed[rank] ?? null,
  }));
}

/** Where a place is with the intake `u` of the way out: 0 stowed, 1 fully deployed. */
export function slotPosition(place, u = 0) {
  const k = Math.min(1, Math.max(0, u));
  if (!place.at) return place.out;
  if (!place.out) return place.at;
  return [
    place.at[0] + (place.out[0] - place.at[0]) * k,
    place.at[1] + (place.out[1] - place.at[1]) * k,
    place.at[2] + (place.out[2] - place.at[2]) * k,
  ];
}

/** How much of a place there is at that extension: 1 for one the robot has either way, a fade for one it
 *  only has with the intake out. A ball in a place that is going away shrinks into the pile. */
export function slotPresence(place, u = 0) {
  if (place.at && place.out) return 1;
  const ramp = smooth((Math.min(1, Math.max(0, u)) - APPEARS_FROM) / (APPEARS_BY - APPEARS_FROM));
  return place.out ? ramp : 1 - ramp;
}

const smooth = (u) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
};

/**
 * `places` are where balls settle, by rank, from `pairPlaces`: `{ at, out }` in the robot frame, either
 * of them [x, y, z] or null. `mouth` is where balls come in from - the front of the intake's lowest
 * roller at ball height - and `feeder` where they leave to. Returns
 * { root, setCount, setIntake, step, count, capacity, setColour, dispose }.
 */
export function createHopperBalls({ places: given, mouth, feeder, colour = "#a8913e", material: givenMaterial = null }) {
  const places = given.filter((p) => p && (p.at || p.out));
  let entry = [mouth[0], mouth[1], mouth[2]];
  /* How far out the intake is, 0 to 1. The places move between their two measured ends with it. */
  let extension = 0;
  /* An icosphere's triangles are all the same size, which a lat-long sphere's are not, so it reads evenly
     from every side for fewer of them. three.js builds it unindexed, though, and unindexed geometry gets
     one normal per face: the balls came out as visibly faceted lumps. A sphere about the origin has an
     exact normal at every point - the direction of the point itself - so they are written rather than
     computed, and 320 triangles then shade like a smooth ball. */
  const geometry = new THREE.IcosahedronGeometry(RADIUS, 2);
  {
    const position = geometry.getAttribute("position");
    const normal = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const length = Math.hypot(x, y, z) || 1;
      normal[i * 3] = x / length;
      normal[i * 3 + 1] = y / length;
      normal[i * 3 + 2] = z / length;
    }
    geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  }
  const material = givenMaterial ?? new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, places.length + 8));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  const root = new THREE.Group();
  root.name = "hopper-fuel";
  root.add(mesh);

  /* The balls in the pile, nearest the feeder first: { rank, since, lane, from, moved }. Balls on their way
     into the feeder are kept apart: { at, since }. */
  let pile = [];
  let leaving = [];
  let lastArrival = -Infinity;
  let arrivals = 0;
  const matrix = new THREE.Matrix4();
  const place = new THREE.Vector3();
  const still = new THREE.Quaternion();
  const size = new THREE.Vector3();

  const placeAt = (rank) => places[Math.min(rank, places.length - 1)];
  const placeOf = (rank) => slotPosition(placeAt(rank), extension);

  /* Where a ball in the pile is drawn at `now`, and whether it is still on its way there. */
  function drawn(ball, now) {
    const home = placeOf(ball.rank);
    /* A place the robot only has with its intake out takes its ball with it: the ball shrinks into the
       pile as the place goes, rather than being left standing inside the shooter. */
    const there = slotPresence(placeAt(ball.rank), extension);
    const t = (now - ball.since) / 1000;
    if (t < 0) return { at: pickupStart(ball), scale: 0, moving: true };
    if (t < ARRIVE_S) return { at: pickupAt(ball, home, t / ARRIVE_S), scale: there * Math.min(1, 0.7 + t / 0.08 * 0.3), moving: true };
    if (ball.from) {
      const u = (now - ball.moved) / 1000 / ADVANCE_S;
      if (u < 1) {
        const k = smooth(u);
        return {
          at: [ball.from[0] + (home[0] - ball.from[0]) * k, ball.from[1] + (home[1] - ball.from[1]) * k, ball.from[2] + (home[2] - ball.from[2]) * k],
          scale: there,
          moving: true,
        };
      }
      ball.from = null;
    }
    return { at: home, scale: there, moving: false };
  }

  /* A pickup's path: from the carpet a hand's width in front of the roller, rolling in under it, then up
     through the intake and over into its place on a curve. The lane is where across the intake's width
     the ball came in. */
  function pickupStart(ball) {
    return [entry[0] + 0.16, RADIUS, entry[2] + ball.lane];
  }
  function pickupAt(ball, home, u) {
    const start = pickupStart(ball);
    const under = [entry[0] - 0.03, RADIUS + 0.01, entry[2] + ball.lane * 0.9];
    if (u < ROLL_IN) {
      /* Grabbed by the roller: quick, and quicker as it is drawn under. */
      const k = (u / ROLL_IN) ** 1.6;
      return [start[0] + (under[0] - start[0]) * k, start[1] + (under[1] - start[1]) * k, start[2] + (under[2] - start[2]) * k];
    }
    const k = smooth((u - ROLL_IN) / (1 - ROLL_IN));
    const lift = [(under[0] + home[0]) / 2, Math.max(under[1], home[1]) + 0.1, (under[2] + home[2]) / 2];
    const a = (1 - k) * (1 - k);
    const b = 2 * (1 - k) * k;
    const c = k * k;
    return [a * under[0] + b * lift[0] + c * home[0], a * under[1] + b * lift[1] + c * home[1], a * under[2] + b * lift[2] + c * home[2]];
  }

  function setCount(count, now) {
    const wanted = Math.max(0, Math.min(places.length, Math.round(count)));
    /* Arrivals: each rolled in from the carpet, staggered behind the last, into the next place. */
    while (pile.length < wanted) {
      const since = Math.max(now, lastArrival + STAGGER_S * 1000);
      lastArrival = since;
      arrivals++;
      /* A lane across the intake that wanders from ball to ball, the same every time. */
      const lane = Math.sin(arrivals * 2.399) * 0.17;
      pile.push({ rank: pile.length, since, lane, from: null, moved: 0 });
    }
    /* Departures: the ball nearest the feeder goes in, and everything behind it moves up a place. */
    while (pile.length > wanted) {
      const first = pile.shift();
      leaving.push({ at: drawn(first, now).at, since: now });
      for (const ball of pile) {
        const was = drawn(ball, now);
        ball.rank -= 1;
        if (now - ball.since >= ARRIVE_S * 1000) {
          ball.from = was.at;
          ball.moved = now;
        }
      }
    }
  }

  function step(now) {
    let moving = false;
    leaving = leaving.filter((ball) => (now - ball.since) / 1000 < LEAVE_S);
    let i = 0;
    for (const ball of pile) {
      const shown = drawn(ball, now);
      if (shown.moving) moving = true;
      place.set(shown.at[0], shown.at[1], shown.at[2]);
      size.setScalar(shown.scale);
      mesh.setMatrixAt(i++, matrix.compose(place, still, size));
    }
    for (const ball of leaving) {
      const u = smooth((now - ball.since) / 1000 / LEAVE_S);
      place.set(ball.at[0] + (feeder[0] - ball.at[0]) * u, ball.at[1] + (feeder[1] - ball.at[1]) * u, ball.at[2] + (feeder[2] - ball.at[2]) * u);
      size.setScalar(1 - u * 0.6);
      mesh.setMatrixAt(i++, matrix.compose(place, still, size));
      moving = true;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    return moving;
  }

  return {
    root,
    setCount,
    step,
    /** How far out the intake is, 0 stowed to 1 deployed, and where balls come in from now. Every place
     *  moves between the two positions the CAD analysis measured for it. */
    setIntake(nextExtension, nextMouth) {
      extension = Math.min(1, Math.max(0, Number(nextExtension) || 0));
      if (nextMouth) entry = [nextMouth[0], nextMouth[1], nextMouth[2]];
    },
    /** How many balls the hopper can show, and how many of those it has room for right now. */
    get capacity() {
      return places.length;
    },
    get room() {
      return places.reduce((n, place) => n + (slotPresence(place, extension) > 0.5 ? 1 : 0), 0);
    },
    get count() {
      return pile.length;
    },
    setColour(next) {
      if (next && !givenMaterial) material.color.set(next);
    },
    dispose() {
      geometry.dispose();
      if (!givenMaterial) material.dispose();
      mesh.dispose();
    },
  };
}
