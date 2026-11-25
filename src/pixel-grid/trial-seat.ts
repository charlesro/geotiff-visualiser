import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import type { Poly } from './geometry';
import type { LngLatBounds } from './s2-grid';
import { blockPlacement, buildBlockPlan, utmEnvelope, type BlockDesign } from './simulate';

/**
 * WHERE A BLOCK TRIAL SITS IN ITS FIELD.
 *
 * A trial used to go on the middle of the field's bounding box. That is the
 * middle of the field only when the field is a box. On a traced parcel it is
 * an arbitrary point: on an oblique one it lies near an edge, or outside, and
 * the page drew a trial with a corner hanging out of a field that had room for
 * it three times over ("sometimes it places the trials badly", 2026-11-20).
 *
 * The seat is the place where the trial's rectangle lies FURTHEST FROM THE
 * FIELD'S EDGES: wholly inside when it can be, with the widest margin there
 * is, and with the smallest overhang when it cannot. Where the margin is the
 * same along a stretch (a strip of even width), the place nearest the field's
 * centroid.
 *
 * A field that is a plain box keeps the middle of the box: that is the answer
 * there, exactly, and no figure computed on a box moves.
 */

/** A seat: the rectangle's centre, and its margin (negative: how far the worst of it hangs out). */
export interface Seat { x: number; y: number; clearance: number }

/** Lattice of centres tried, per axis, and the points of the rectangle an overhang is read at. */
const SEAT_MAX_GRID = 44;
const SEAT_MIN_GRID = 12;
const SEAT_BUDGET = 260_000;
const OVERHANG_SAMPLES = 5;

/**
 * The seat of a `w` x `h` rectangle turned by `rotationDeg` (its `w` side along
 * the direction that angle gives, as the engine's u axis) in a field given as a
 * ring of plane coordinates in metres. Null for a ring that encloses nothing.
 * Pure: the same ring and rectangle always give the same seat.
 */
export function seatRect(ring: [number, number][], w: number, h: number, rotationDeg = 0): Seat | null {
  let n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--;   // a closed ring's repeated point
  if (n < 3 || !(w > 0) || !(h > 0)) return null;

  // The rectangle's own frame, about the ring's first point: there it lies along the axes.
  const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const ox = ring[0][0], oy = ring[0][1];
  const px = new Float64Array(n), py = new Float64Array(n);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = ring[i][0] - ox, dy = ring[i][1] - oy;
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    px[i] = u; py[i] = v;
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  if (![u0, u1, v0, v1].every(Number.isFinite)) return null;
  const span = Math.hypot(u1 - u0, v1 - v0);
  if (!(span > 0)) return null;

  // The centroid, for the choice among places of equal margin.
  let area = 0, gx = 0, gy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cr = px[j] * py[i] - px[i] * py[j];
    area += cr; gx += (px[j] + px[i]) * cr; gy += (py[j] + py[i]) * cr;
  }
  if (Math.abs(area) < 1e-9 * span * span) return null;
  gx /= 3 * area; gy /= 3 * area;

  const a = w / 2, b = h / 2;
  const inside = (x: number, y: number): boolean => {
    let c = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      if ((py[i] > y) !== (py[j] > y) && x < ((px[j] - px[i]) * (y - py[i])) / (py[j] - py[i]) + px[i]) c = !c;
    }
    return c;
  };
  /** Squared distance from a point to edge i (from vertex i to the next). */
  const toEdge2 = (x: number, y: number, i: number): number => {
    const j = i + 1 === n ? 0 : i + 1;
    const ex = px[j] - px[i], ey = py[j] - py[i], l2 = ex * ex + ey * ey;
    let s = l2 > 0 ? ((x - px[i]) * ex + (y - py[i]) * ey) / l2 : 0;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    const qx = px[i] + s * ex - x, qy = py[i] + s * ey - y;
    return qx * qx + qy * qy;
  };
  /**
   * Squared distance from edge i to the rectangle centred on (cx, cy), 0 when
   * the edge enters it. A segment and a rectangle that do not meet are nearest
   * at a corner of the one or an end of the other. Written flat, with no inner
   * function: it runs once per edge and per place tried.
   */
  const edgeToRect2 = (cx: number, cy: number, i: number): number => {
    const j = i + 1 === n ? 0 : i + 1;
    const x0 = px[i] - cx, y0 = py[i] - cy, x1 = px[j] - cx, y1 = py[j] - cy;
    const dx = x1 - x0, dy = y1 - y0;
    // Liang-Barsky: the part of the segment inside [-a, a] x [-b, b], if any.
    let lo = 0, hi = 1, meets = true;
    if (dx === 0) { if (x0 < -a || x0 > a) meets = false; }
    else {
      let r0 = (-a - x0) / dx, r1 = (a - x0) / dx;
      if (r0 > r1) { const r = r0; r0 = r1; r1 = r; }
      if (r0 > lo) lo = r0; if (r1 < hi) hi = r1;
    }
    if (meets) {
      if (dy === 0) { if (y0 < -b || y0 > b) meets = false; }
      else {
        let r0 = (-b - y0) / dy, r1 = (b - y0) / dy;
        if (r0 > r1) { const r = r0; r0 = r1; r1 = r; }
        if (r0 > lo) lo = r0; if (r1 < hi) hi = r1;
      }
    }
    if (meets && lo <= hi) return 0;
    let ex = Math.abs(x0) - a, ey = Math.abs(y0) - b;
    let best = (ex > 0 ? ex * ex : 0) + (ey > 0 ? ey * ey : 0);
    ex = Math.abs(x1) - a; ey = Math.abs(y1) - b;
    const end = (ex > 0 ? ex * ex : 0) + (ey > 0 ? ey * ey : 0);
    if (end < best) best = end;
    // The four corners against the edge, in the rectangle's frame.
    const l2 = dx * dx + dy * dy;
    for (let c = 0; c < 4; c++) {
      const qx = c === 0 || c === 3 ? -a : a, qy = c < 2 ? -b : b;
      let t2 = l2 > 0 ? ((qx - x0) * dx + (qy - y0) * dy) / l2 : 0;
      t2 = t2 < 0 ? 0 : t2 > 1 ? 1 : t2;
      const rx = x0 + t2 * dx - qx, ry = y0 + t2 * dy - qy, d = rx * rx + ry * ry;
      if (d < best) best = d;
    }
    return best;
  };
  const tiny = 1e-9 * span;
  /** The rectangle's margin where it lies wholly inside the field, or -1 where it does not. */
  const room = (cx: number, cy: number): number => {
    if (!inside(cx, cy)) return -1;
    let m = Infinity;
    for (let i = 0; i < n; i++) {
      const d = edgeToRect2(cx, cy, i);
      if (d < m) { m = d; if (!(m > 0)) return -1; }
    }
    return Math.sqrt(m);
  };
  /** How far the furthest point read on the rectangle lies outside the field, as a negative margin. */
  const overhang = (cx: number, cy: number): number => {
    let worst = 0;
    const k = OVERHANG_SAMPLES - 1;
    for (let iy = 0; iy <= k; iy++) for (let ix = 0; ix <= k; ix++) {
      const x = cx - a + (ix * w) / k, y = cy - b + (iy * h) / k;
      if (inside(x, y)) continue;
      let d = Infinity;
      for (let i = 0; i < n; i++) { const e = toEdge2(x, y, i); if (e < d) d = e; }
      if (d > worst) worst = d;
    }
    return -Math.max(Math.sqrt(worst), tiny);
  };
  /** The margin of the rectangle centred on (cx, cy): positive inside the field, negative by its worst overhang. */
  const margin = (cx: number, cy: number): number => {
    const m = room(cx, cy);
    return m > 0 ? m : overhang(cx, cy);
  };

  // Centres worth trying: where the rectangle is within the ring's own box, or
  // on the middle of that box along an axis it is too long for.
  const range = (lo: number, hi: number, half: number): [number, number] =>
    (hi - lo > 2 * half ? [lo + half, hi - half] : [(lo + hi) / 2, (lo + hi) / 2]);
  const [cu0, cu1] = range(u0, u1, a), [cv0, cv1] = range(v0, v1, b);
  const g = Math.max(SEAT_MIN_GRID, Math.min(SEAT_MAX_GRID, Math.round(Math.sqrt(SEAT_BUDGET / n))));
  const gu = cu1 > cu0 ? g : 1, gv = cv1 > cv0 ? g : 1;
  const tol = 1e-7 * span;
  let bx = (cu0 + cu1) / 2, by = (cv0 + cv1) / 2, bm = -Infinity, bd = Infinity;
  // The places where it fits first, which is the cheap question; the overhang
  // is read over the whole lattice only for a field it fits nowhere on it.
  for (const measure of [room, margin]) {
    for (let iy = 0; iy < gv; iy++) for (let ix = 0; ix < gu; ix++) {
      const x = gu > 1 ? cu0 + ((cu1 - cu0) * ix) / (gu - 1) : cu0;
      const y = gv > 1 ? cv0 + ((cv1 - cv0) * iy) / (gv - 1) : cv0;
      const m = measure(x, y);
      if (measure === room && !(m > 0)) continue;
      const d = (x - gx) * (x - gx) + (y - gy) * (y - gy);
      if (m > bm + tol || (m > bm - tol && d < bd)) { bx = x; by = y; bm = m; bd = d; }
    }
    if (bm > 0) break;
  }
  // Then towards the best place between the lattice's points, by halving steps.
  // A rectangle too long for the field both ways has one centre on the lattice
  // and nothing to halve: it is still moved, from an eighth of the field's span.
  let step = (Math.max(gu > 1 ? (cu1 - cu0) / (gu - 1) : 0, gv > 1 ? (cv1 - cv0) / (gv - 1) : 0) || span / 4) / 2;
  for (let it = 0; it < 90 && step > 1e-7 * span; it++) {
    let mx = bx, my = by, mm = bm;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = bx + dx * step, y = by + dy * step, m = margin(x, y);
      if (m > mm + tol) { mx = x; my = y; mm = m; }
    }
    if (mm > bm) { bx = mx; by = my; bm = mm; } else step /= 2;
  }
  // Where the margin is the same along a stretch, the place nearest the
  // centroid: as far towards it as the margin holds.
  if (margin(gx, gy) >= bm - tol) { bx = gx; by = gy; }
  else {
    let lo = 0, hi = 1;
    for (let it = 0; it < 24; it++) {
      const mid = (lo + hi) / 2;
      if (margin(bx + mid * (gx - bx), by + mid * (gy - by)) >= bm - tol) lo = mid; else hi = mid;
    }
    bx += lo * (gx - bx); by += lo * (gy - by);
  }
  return { x: ox + bx * cos - by * sin, y: oy + bx * sin + by * cos, clearance: bm };
}

/**
 * True when an outline IS its own bounding box: its four corners, each once (a
 * closing repeat of the first aside). Asking only that every vertex be a corner
 * of the box also passes a right-angled triangle on three of them, which is
 * half the box: a trial was then seated on the middle of the box, on the
 * triangle's long side, and said to fit a field half its size (found by an
 * outside review, 2026-11-22).
 */
function isBoxRing(ring: Poly, [w, s, e, n]: LngLatBounds): boolean {
  if (w === e || s === n) return true; // no area either way: the box is all there is
  const last = ring[ring.length - 1];
  const pts = ring.length > 1 && ring[0][0] === last[0] && ring[0][1] === last[1] ? ring.slice(0, -1) : ring;
  if (pts.length !== 4) return false;
  let corners = 0;
  for (const [x, y] of pts) {
    if (!((x === w || x === e) && (y === s || y === n))) return false;
    corners |= 1 << ((x === w ? 0 : 1) + (y === s ? 0 : 2));
  }
  return corners === 15;
}

/**
 * The convex hull of a field's corners, by the monotone chain. Its own small
 * copy: imported-plan.ts has one, but brings the shapefile reader with it.
 */
function hullOf(points: [number, number][]): [number, number][] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const q of list) { while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop(); out.push(q); }
    out.pop();
    return out;
  };
  return chain(pts).concat(chain(pts.slice().reverse()));
}

/**
 * THE FIELD'S OWN DIRECTION (2026-11-25: "this one could fit in if it was
 * rotated"): the angle of the smallest rectangle that holds the field's
 * outline, counter-clockwise from east as a trial's angle is, folded into
 * (-45, 45]. 0 for a field that is its box, one with no outline, or one within
 * a degree of the pixel rows: its two directions are then 0 and 90 degrees,
 * which differ for a block trial, whose species stack one way. Null with no
 * field. Every side of the outline's hull is tried, since the smallest
 * rectangle has a side on one of them.
 */
export function fieldAngle(fieldRing: Poly | null, aoi: LngLatBounds | null, epsg: number): number | null {
  if (!aoi) return null;
  // A field that is its box, or has no outline, lies along the pixel rows: its directions are 0 and 90 degrees
  // (a block trial is not the same turned a quarter, its species stacking the other way; Neon's review, 2026-11-25).
  if (!fieldRing || fieldRing.length < 3 || isBoxRing(fieldRing, aoi)) return 0;
  const to = proj4('EPSG:4326', crsToProj4Def(`EPSG:${epsg}`));
  // The smallest enclosing rectangle has a side on the HULL: a notch's edges are not candidates, its chord is.
  const pts = hullOf(fieldRing.map(p => to.forward(p) as [number, number]));
  if (pts.length < 3) return 0;
  let best = Infinity, deg = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(len > 0)) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
    for (const [x, y] of pts) {
      const p = x * ux + y * uy, q = -x * uy + y * ux;
      if (p < lo) lo = p; if (p > hi) hi = p; if (q < lo2) lo2 = q; if (q > hi2) hi2 = q;
    }
    const area = (hi - lo) * (hi2 - lo2);
    if (area < best - 1e-6) { best = area; deg = (Math.atan2(uy, ux) * 180) / Math.PI; }
  }
  let d = ((deg % 90) + 90) % 90;
  if (d > 45) d -= 90;
  return Math.abs(d) < 1 ? 0 : Math.round(d * 10) / 10;
}

/** The last seats found, by what they were found from: every satellite of the table asks for the same one. */
const seats = new Map<string, { centre: [number, number]; clearance: number }>();

/**
 * The seat of a trial of `totalU` x `totalV` metres in the page's field, as a
 * UTM point, with its margin. Null when the trial keeps the middle of the
 * field's box: no outline, or an outline that IS the box.
 */
export function fieldSeat(fieldRing: Poly | null, aoi: LngLatBounds, epsg: number, totalU: number, totalV: number, rotationDeg: number):
  { centre: [number, number]; clearance: number } | null {
  if (!fieldRing || fieldRing.length < 3) return null;
  if (isBoxRing(fieldRing, aoi)) return null;
  let sum = 0;
  for (let i = 0; i < fieldRing.length; i++) sum += (i + 1) * fieldRing[i][0] + (i + 1.37) * fieldRing[i][1];
  const key = `${epsg}|${totalU}|${totalV}|${rotationDeg}|${fieldRing.length}|${sum}`;
  const known = seats.get(key);
  if (known) return known;
  const to = proj4('EPSG:4326', crsToProj4Def(`EPSG:${epsg}`));
  const seat = seatRect(fieldRing.map(p => to.forward(p) as [number, number]), totalU, totalV, rotationDeg);
  if (!seat) return null;
  const out = { centre: [seat.x, seat.y] as [number, number], clearance: seat.clearance };
  if (seats.size >= 24) seats.delete(seats.keys().next().value as string);
  seats.set(key, out);
  return out;
}

/**
 * Whether a trial of `totalU` x `totalV` metres, turned by `rotationDeg`, fits
 * the page's field with `marginM` to spare all round: inside the outline of a
 * traced field, at its seat; inside the box of a field that is one, where a
 * turned rectangle fits when its own box does.
 */
export function trialFitsField(
  fieldRing: Poly | null, aoi: LngLatBounds, epsg: number, totalU: number, totalV: number, rotationDeg: number, marginM = 0,
): boolean {
  const seat = fieldSeat(fieldRing, aoi, epsg, totalU, totalV, rotationDeg);
  if (seat) return seat.clearance > marginM;
  // A traced outline with no seat for the trial holds none of it, its box notwithstanding (a ring with
  // no area among them: Neon's review, 2026-11-25).
  if (fieldRing && fieldRing.length >= 3 && !isBoxRing(fieldRing, aoi)) return false;
  const [e0, n0, e1, n1] = utmEnvelope(aoi, epsg);
  const t = (rotationDeg * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  return totalU * c + totalV * s <= e1 - e0 - 2 * marginM + 1e-6 && totalU * s + totalV * c <= n1 - n0 - 2 * marginM + 1e-6;
}

/**
 * blockPlacement for a design on the page's field: on the trial's seat where
 * the field has an outline of its own, on the middle of the field's box where
 * it has not. ONE function for the map, the satellites table and the design
 * suggestion, so that they cannot place the same trial in two places.
 */
export function seatedPlacement(
  design: BlockDesign,
  fieldRing: Poly | null,
  aoi: LngLatBounds | null,
  epsg: number | null,
  utmBounds: [number, number, number, number],
  origin: [number, number],
  rotationDeg: number,
  res: number,
  snapToPixels: boolean,
): ReturnType<typeof blockPlacement> {
  let centre: [number, number] | null = null;
  if (fieldRing && aoi && epsg) {
    const size = buildBlockPlan(design, { centerU: 0, centerV: 0 });
    centre = fieldSeat(fieldRing, aoi, epsg, size.totalU, size.totalV, rotationDeg)?.centre ?? null;
  }
  return blockPlacement(utmBounds, origin, rotationDeg, res, snapToPixels, centre);
}
