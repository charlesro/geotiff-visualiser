import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import { varietyKeyOf } from './design-import';
import { importedCoverAt, MAX_PLOTS } from './simulate';
import type { ImportedDesign, ImportedPlan, ImportedVariety } from './imported-types';

/**
 * Puts an uploaded design on a grid: projects its plots into the grid's UTM CRS
 * and settles, ONCE, everything the engine, the ladder and the memo keys read
 * off it (species per plot, cover ids, footprint, narrowest feature, signature).
 * Resolved once and shared for the same reason a BlockPlan is: a second copy
 * built from another CRS or variety list would draw one trial while the numbers
 * describe another.
 */

type XY = [number, number];

/**
 * The variety a plot grows, as the reader keys it. Re-exported rather than
 * rewritten: the reader lists the varieties this resolver looks plots up in,
 * and a second spelling of the rule (it once keyed plots "plot 1" here and "#1"
 * there) makes every plot of a design without a variety column unlisted.
 */
export { varietyKeyOf };

/**
 * The points that can be on the convex hull: all but those well inside the
 * octagon of the eight extreme points (Akl-Toussaint). A trial's footprint is
 * the hull of every vertex, and sorting all of them was a third of resolving a
 * design of many-vertex plots; most of them are plots in the middle. A point is
 * only dropped more than a micrometre inside every side, so rounding can never
 * drop one the hull needs.
 */
function outsideOctagon(points: XY[]): XY[] {
  // Extremes of -y, x-y, x, x+y, y, y-x, -x, -x-y: the octagon's corners, counter-clockwise.
  const ext = new Array<XY>(8).fill(points[0]);
  const best = new Float64Array(8).fill(-Infinity);
  for (const p of points) {
    const x = p[0], y = p[1];
    if (-y > best[0]) { best[0] = -y; ext[0] = p; }
    if (x - y > best[1]) { best[1] = x - y; ext[1] = p; }
    if (x > best[2]) { best[2] = x; ext[2] = p; }
    if (x + y > best[3]) { best[3] = x + y; ext[3] = p; }
    if (y > best[4]) { best[4] = y; ext[4] = p; }
    if (y - x > best[5]) { best[5] = y - x; ext[5] = p; }
    if (-x > best[6]) { best[6] = -x; ext[6] = p; }
    if (-x - y > best[7]) { best[7] = -x - y; ext[7] = p; }
  }
  // Each side as (a, edge, margin); a repeated extreme point is no side at all.
  const side = new Float64Array(40);
  let sides = 0;
  for (let i = 0; i < 8; i++) {
    const a = ext[i], b = ext[(i + 1) % 8], ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
    if (!(len > 0)) continue;
    side.set([a[0], a[1], ex, ey, 1e-6 * len], 5 * sides++);
  }
  if (sides < 3) return points.slice();
  const out: XY[] = [];
  for (const p of points) {
    let q = 0;
    for (; q < sides; q++) {
      const o = 5 * q;
      if (!(side[o + 2] * (p[1] - side[o + 1]) - side[o + 3] * (p[0] - side[o]) > side[o + 4])) break;
    }
    if (q < sides) out.push(p);
  }
  return out;
}

/**
 * Convex hull by Andrew's monotone chain, counter-clockwise, first vertex not
 * repeated. Collinear and duplicate points are dropped, so a degenerate input
 * (one point, a line) comes back with fewer than three vertices.
 */
export function convexHull(points: XY[]): XY[] {
  const pts = (points.length > 64 ? outsideOctagon(points) : points.slice()).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XY[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: XY[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum width of a convex polygon (counter-clockwise, as convexHull returns
 * it) by rotating calipers: the narrowest strip holding it always has one side
 * flush with a hull edge, and the farthest vertex from successive edges only
 * ever moves forward. 0 for a degenerate hull.
 */
export function hullWidth(h: XY[]): number {
  const n = h.length;
  if (n < 3) return 0;
  let best = Infinity, j = 1;
  for (let i = 0; i < n; i++) {
    const a = h[i], b = h[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    // Twice the triangle area over the edge: proportional to the distance from it.
    const far = (p: XY) => ex * (p[1] - a[1]) - ey * (p[0] - a[0]);
    while (far(h[(j + 1) % n]) > far(h[j])) j = (j + 1) % n;
    best = Math.min(best, far(h[j]) / len);
  }
  return Number.isFinite(best) ? best : 0;
}

/** The narrowest feature the engine is ever asked to resolve, as minFeatureM floors a block design. */
const MIN_FEATURE_FLOOR_M = 0.05;
/**
 * Two boundaries closer than this are one edge drawn twice, not a strip of
 * ground between them. Neighbours surveyed or digitised apart disagree by a few
 * centimetres, and counting such a seam as a gap pinned the stride at its cap
 * (seven times the time of a whole ladder) for a purity no one could tell
 * apart. It is also the width below which strideFor stops telling features
 * apart at all, and narrower than any alley a trial is sown with.
 */
const SEAM_M = 0.1;
/**
 * Boundary detail within this of a straight chord is folded into the chord
 * before strips are searched; every vertex dropped ends within sqrt 2 times it
 * of what is kept. A quarter of a seam: a wiggle, a tooth or a digitising step
 * that shallow is no feature the grid is asked to resolve, while left in, a
 * densified or hand-traced edge was hundreds of pieces compared with every
 * piece across the plot, and the teeth of a jagged one read as strips. Clean
 * rings lose only vertices that lie on their edges.
 */
const FOLD_M = SEAM_M / 4;
/** How far to either side of a boundary the cover is sampled: clear of anything folded into it. */
const PROBE_M = 2 * FOLD_M;
/** Two boundaries face each other when their directions are within 15 degrees. */
const FACING_SIN = Math.sin((15 * Math.PI) / 180);
const FACING_COS = Math.cos((15 * Math.PI) / 180);
const ANGLE_BINS = 12;          // 15 degrees each, so facing boundaries share a bin or sit in neighbours
/** Most segments followed each way along a ring when a boundary is traced. */
const TRACE_MAX = 256;
/**
 * What the strip search may spend, in units of about one vertex tested by a
 * probe (the cover map's own answer, which charges itself); a pair looked at or
 * two segments compared cost about as much as sixteen, a step along a ring
 * about four. A real design spends a small fraction of it. One built to defeat
 * the search (thousands of plots piled so every probe tests them all, or a pile
 * of edges hidden under a plot drawn over them) stops there, within about a
 * second, and is sampled as finely as a seam: never less accurate than a
 * finished search, only slower to simulate, where an unbounded search froze the
 * page while a variety was reassigned. Counted, not timed, so the same file
 * always gets the same answer.
 */
const WORK_MAX = 300_000_000;
const VISIT_COST = 16;
const COMPARE_COST = 16;
const TRACE_COST = 4;

/**
 * A closed ring with the detail within `tol` of a straight chord folded away,
 * first vertex kept, no repeated closing vertex. Linear: a run from an anchor
 * keeps the directions a chord may take (a wedge narrowed by every vertex
 * farther than `tol` from the anchor) and ends before the first vertex whose
 * direction left it, or that lies more than `tol` nearer the anchor than one
 * before it. Every dropped vertex is then within `tol` of the chord's line and
 * at most `tol` past its end, so within sqrt 2 times `tol` of the chord.
 */
function foldRing(ring: XY[], tol: number): XY[] {
  const v: XY[] = [];
  for (const p of ring) {
    const q = v[v.length - 1];
    if (!q || p[0] !== q[0] || p[1] !== q[1]) v.push(p);
  }
  while (v.length > 1 && v[0][0] === v[v.length - 1][0] && v[0][1] === v[v.length - 1][1]) v.pop();
  const m = v.length;
  if (m < 3) return v;
  const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  const out: XY[] = [];
  for (let a = 0; a < m;) {
    out.push(v[a]);
    const ax = v[a][0], ay = v[a][1];
    let end = a + 1, far = 0, bound = false, ref = 0, lo = 0, hi = 0;
    for (let e = a + 1; e <= m; e++) {                // e === m is the first vertex again
      const p = v[e % m], dx = p[0] - ax, dy = p[1] - ay, d = Math.hypot(dx, dy);
      if (d < far - tol) break;
      if (bound) {
        const off = wrap(Math.atan2(dy, dx) - ref);
        if (!(d > 0 && off >= lo && off <= hi)) break;
      }
      end = e;
      if (d > far) far = d;
      if (d > tol) {
        const th = Math.atan2(dy, dx), half = Math.asin(tol / d);
        if (!bound) { bound = true; ref = th; lo = -half; hi = half; }
        else {
          const off = wrap(th - ref);
          lo = Math.max(lo, off - half); hi = Math.min(hi, off + half);
          if (lo > hi) break;                          // no chord past e can keep every vertex near it
        }
      }
    }
    a = end;
  }
  return out;
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance between segments s and t of `xy` (x1, y1, x2, y2 at 4 * s), 0 when they cross. */
function segmentDistance(xy: Float64Array, s: number, t: number): number {
  const ax = xy[4 * s], ay = xy[4 * s + 1], bx = xy[4 * s + 2], by = xy[4 * s + 3];
  const cx = xy[4 * t], cy = xy[4 * t + 1], dx = xy[4 * t + 2], dy = xy[4 * t + 3];
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = side(ax, ay, bx, by, cx, cy), d2 = side(ax, ay, bx, by, dx, dy);
  const d3 = side(cx, cy, dx, dy, ax, ay), d4 = side(cx, cy, dx, dy, bx, by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    pointSegmentDistance(ax, ay, cx, cy, dx, dy), pointSegmentDistance(bx, by, cx, cy, dx, dy),
    pointSegmentDistance(cx, cy, ax, ay, bx, by), pointSegmentDistance(dx, dy, ax, ay, bx, by));
}

/**
 * Everything the strip search reads, built once per design, with its running
 * answer and step count. Small functions over one plain object rather than one
 * function of nested loops: V8 compiled that as an inner loop replaced on the
 * stack and threw the code away every time the loop exited, three hundred
 * thousand times over one dense design, which took minutes instead of
 * milliseconds.
 */
interface StripSearch {
  plan: ImportedPlan;
  xy: Float64Array;          // x1, y1, x2, y2 of segment s at 4 * s
  len: Float64Array;
  bin: Uint8Array;           // direction, in ANGLE_BINS buckets over 180 degrees
  ringOf: Int32Array;
  ringStart: Int32Array;     // each ring's first segment
  ringSize: Int32Array;      // and how many it has
  fwd: Int32Array;           // the stretch of s: segments after it along its ring
  back: Int32Array;          // and before it
  stretchLen: Float64Array;  // the stretch's span along s
  x0: number; y0: number; cell: number; nx: number; ny: number; slack: number;
  head: Int32Array;          // bucket (row, col, bin) to its first entry, -1 for none
  entrySeg: Int32Array;
  entryNext: Int32Array;
  entries: number;
  seen: Int32Array;          // the s that last looked at t, so a pair is looked at once
  budget: number;            // work allowed, WORK_MAX but for the regression suite
  band: Float64Array;        // scratch: the corners of the band stripsFrom reads
  best: number;
  work: number;
}

/** The segment `step` places after s along its ring (negative: before it). */
function segAt(q: StripSearch, s: number, step: number): number {
  const r = q.ringOf[s], size = q.ringSize[r], start = q.ringStart[r];
  return start + ((((s - start + step) % size) + size) % size);
}

/** Whether segment k runs within 15 degrees of the unit direction (ux, uy), in its sense. */
function runsAlong(q: StripSearch, k: number, ux: number, uy: number): boolean {
  const xy = q.xy;
  return q.len[k] > 0 && (xy[4 * k + 2] - xy[4 * k]) * ux + (xy[4 * k + 3] - xy[4 * k + 1]) * uy >= FACING_COS * q.len[k];
}

/**
 * The stretch of segment s: its neighbours along the ring that run within 15
 * degrees of it, in its sense. Its vertices then only move forward along s, so
 * it spans the start of its first segment to the end of its last. Returns the
 * steps taken.
 */
function traceStretch(q: StripSearch, s: number): number {
  const xy = q.xy, ls = q.len[s];
  if (ls === 0) return 1;
  const ux = (xy[4 * s + 2] - xy[4 * s]) / ls, uy = (xy[4 * s + 3] - xy[4 * s + 1]) / ls;
  const size = q.ringSize[q.ringOf[s]];
  let f = 0, b = 0;
  while (f + 1 < size && f < TRACE_MAX && runsAlong(q, segAt(q, s, f + 1), ux, uy)) f++;
  while (b + 1 < size - f && b < TRACE_MAX && runsAlong(q, segAt(q, s, -b - 1), ux, uy)) b++;
  q.fwd[s] = f; q.back[s] = b;
  const first = segAt(q, s, -b), last = segAt(q, s, f);
  q.stretchLen[s] = (xy[4 * last + 2] - xy[4 * first]) * ux + (xy[4 * last + 3] - xy[4 * first + 1]) * uy;
  return f + b + 1;
}

function bucketCol(q: StripSearch, x: number): number {
  const c = Math.floor((x - q.x0) / q.cell);
  return c < 0 ? 0 : c >= q.nx ? q.nx - 1 : c;
}
function bucketRow(q: StripSearch, y: number): number {
  const r = Math.floor((y - q.y0) / q.cell);
  return r < 0 ? 0 : r >= q.ny ? q.ny - 1 : r;
}

/** Enters segment s in every bucket it crosses: row by row, the columns its piece in that row spans. */
function indexSegment(q: StripSearch, s: number): void {
  const xy = q.xy, slack = q.slack;
  const ax = xy[4 * s], ay = xy[4 * s + 1], bx = xy[4 * s + 2], by = xy[4 * s + 3];
  const ya = Math.min(ay, by), yb = Math.max(ay, by);
  for (let r = bucketRow(q, ya - slack), r1 = bucketRow(q, yb + slack); r <= r1; r++) {
    let xa = Math.min(ax, bx), xb = Math.max(ax, bx);
    if (ay !== by) {
      const lo = Math.max(ya, q.y0 + r * q.cell), hi = Math.min(yb, q.y0 + (r + 1) * q.cell);
      const xl = ax + ((lo - ay) * (bx - ax)) / (by - ay), xh = ax + ((hi - ay) * (bx - ax)) / (by - ay);
      xa = Math.max(xa, Math.min(xl, xh)); xb = Math.min(xb, Math.max(xl, xh));
    }
    for (let c = bucketCol(q, xa - slack), c1 = bucketCol(q, xb + slack); c <= c1; c++) {
      const key = (r * q.nx + c) * ANGLE_BINS + q.bin[s];
      if (q.entries === q.entrySeg.length) {
        const grown = new Int32Array(2 * q.entries); grown.set(q.entrySeg); q.entrySeg = grown;
        const next = new Int32Array(2 * q.entries); next.set(q.entryNext); q.entryNext = next;
      }
      q.entrySeg[q.entries] = s; q.entryNext[q.entries] = q.head[key]; q.head[key] = q.entries++;
    }
  }
}

/** Whether any segment of the stretch of s comes within a seam of the stretch of t. */
function stretchesMeet(q: StripSearch, s: number, t: number): boolean {
  // (Each stretch holds its own segment, so two segments that touch meet here too.)
  for (let i = -q.back[s]; i <= q.fwd[s]; i++) {
    const si = segAt(q, s, i);
    for (let j = -q.back[t]; j <= q.fwd[t]; j++) if (segmentDistance(q.xy, si, segAt(q, t, j)) < SEAM_M) return true;
  }
  return false;
}

/**
 * The width of the strip between segments s and t, if they bound one narrower
 * than the best so far (see narrowestFeature), else 0.
 */
function stripWidth(q: StripSearch, s: number, t: number): number {
  const xy = q.xy, ls = q.len[s], lt = q.len[t];
  if (lt === 0) return 0;
  const ax = xy[4 * s], ay = xy[4 * s + 1], bx = xy[4 * s + 2], by = xy[4 * s + 3];
  const px = xy[4 * t], py = xy[4 * t + 1], qx = xy[4 * t + 2], qy = xy[4 * t + 3];
  // Boxes farther apart than the reach hold no narrower strip.
  const lim = Math.min(q.best, 2 * q.stretchLen[s]);
  if (Math.min(px, qx) - Math.max(ax, bx) > lim || Math.min(ax, bx) - Math.max(px, qx) > lim ||
      Math.min(py, qy) - Math.max(ay, by) > lim || Math.min(ay, by) - Math.max(py, qy) > lim) return 0;
  const ux = (bx - ax) / ls, uy = (by - ay) / ls, nX = -uy, nY = ux;
  if (Math.abs(ux * (qy - py) - uy * (qx - px)) > FACING_SIN * lt) return 0;
  // Where along s the two overlap, and how far apart they are at its narrower
  // end (the distance across is linear along the overlap). Two that cross on
  // the way are no strip.
  const tp = (px - ax) * ux + (py - ay) * uy, tq = (qx - ax) * ux + (qy - ay) * uy;
  const lo = Math.max(0, Math.min(tp, tq)), hi = Math.min(ls, Math.max(tp, tq));
  if (!(hi > lo)) return 0;
  const np = (px - ax) * nX + (py - ay) * nY, nq = (qx - ax) * nX + (qy - ay) * nY;
  const aLo = np + ((lo - tp) / (tq - tp)) * (nq - np), aHi = np + ((hi - tp) / (tq - tp)) * (nq - np);
  if ((aLo > 0) !== (aHi > 0)) return 0;
  const w = Math.min(Math.abs(aLo), Math.abs(aHi));
  if (!(w >= SEAM_M && w < q.best && w <= 2 * q.stretchLen[t])) return 0;
  // The two stretches side by side along s. Every segment of t's runs within
  // 30 degrees of s, one way or the other, so its ends are its extremes along s.
  const sFirst = segAt(q, s, -q.back[s]), sLast = segAt(q, s, q.fwd[s]);
  const tFirst = segAt(q, t, -q.back[t]), tLast = segAt(q, t, q.fwd[t]);
  const s0 = (xy[4 * sFirst] - ax) * ux + (xy[4 * sFirst + 1] - ay) * uy;
  const s1 = (xy[4 * sLast + 2] - ax) * ux + (xy[4 * sLast + 3] - ay) * uy;
  const t0 = (xy[4 * tFirst] - ax) * ux + (xy[4 * tFirst + 1] - ay) * uy;
  const t1 = (xy[4 * tLast + 2] - ax) * ux + (xy[4 * tLast + 3] - ay) * uy;
  if (!(Math.min(s1, Math.max(t0, t1)) - Math.max(s0, Math.min(t0, t1)) >= w / 2)) return 0;
  q.work += COMPARE_COST * (q.back[s] + q.fwd[s] + 1) * (q.back[t] + q.fwd[t] + 1);
  if (stretchesMeet(q, s, t)) return 0;
  // Probed half way along the overlap, across it at: just past s, just inside
  // s, the middle, just inside t, just past t. The strip is one cover from side
  // to side and another beyond each.
  const tm = (lo + hi) / 2, across = np + ((tm - tp) / (tq - tp)) * (nq - np);
  const ox = ax + tm * ux, oy = ay + tm * uy, sign = across > 0 ? 1 : -1, d = Math.min(PROBE_M, w / 4);
  const coverAt = (k: number) => importedCoverAt(ox + k * nX, oy + k * nY, q.plan, q);
  const between = coverAt(across / 2);
  if (between !== coverAt(sign * d) || between !== coverAt(across - sign * d)) return 0;
  if (between === coverAt(-sign * d) || between === coverAt(across + sign * d)) return 0;
  return w;
}

/**
 * Looks for strips between segment s and every later segment near it, lowering
 * q.best. A partner has to overlap s along its length and come within the reach
 * across it, so only the buckets under that band beside s are read, row by row:
 * a square box around s read every segment across it, most of them beside the
 * band rather than in it, and a design of long plots spent its time there.
 */
function stripsFrom(q: StripSearch, s: number): void {
  const xy = q.xy, ls = q.len[s];
  // A strip is at least half as long as it is wide, so no wider than twice this stretch.
  const reach = Math.min(q.best, 2 * q.stretchLen[s]);
  if (ls === 0 || !(reach >= SEAM_M)) return;
  const ax = xy[4 * s], ay = xy[4 * s + 1], ux = (xy[4 * s + 2] - ax) / ls, uy = (xy[4 * s + 3] - ay) / ls;
  // The band's corners, a hair wider and longer than it: along s from -slack to
  // ls + slack, across it within reach + slack either way.
  const al = -q.slack, ah = ls + q.slack, cw = reach + q.slack;
  const band = q.band;   // x, y of each corner at 2 * k
  band[0] = ax + al * ux + cw * uy; band[1] = ay + al * uy - cw * ux;
  band[2] = ax + ah * ux + cw * uy; band[3] = ay + ah * uy - cw * ux;
  band[4] = ax + ah * ux - cw * uy; band[5] = ay + ah * uy + cw * ux;
  band[6] = ax + al * ux - cw * uy; band[7] = ay + al * uy + cw * ux;
  const yMin = Math.min(band[1], band[3], band[5], band[7]), yMax = Math.max(band[1], band[3], band[5], band[7]);
  for (let r = bucketRow(q, yMin), r1 = bucketRow(q, yMax); r <= r1; r++) {
    // The band's extent east-west within this row: its edges clipped to the row.
    const yl = Math.max(yMin, q.y0 + r * q.cell), yh = Math.min(yMax, q.y0 + (r + 1) * q.cell);
    let xl = Infinity, xh = -Infinity;
    for (let k = 0; k < 4; k++) {
      const px = band[2 * k], py = band[2 * k + 1], rx = band[(2 * k + 2) % 8], ry = band[(2 * k + 3) % 8];
      const lo = Math.max(yl, Math.min(py, ry)), hi = Math.min(yh, Math.max(py, ry));
      if (lo > hi) continue;
      if (py === ry) { xl = Math.min(xl, px, rx); xh = Math.max(xh, px, rx); continue; }
      const xa = px + ((lo - py) * (rx - px)) / (ry - py), xb = px + ((hi - py) * (rx - px)) / (ry - py);
      xl = Math.min(xl, xa, xb); xh = Math.max(xh, xa, xb);
    }
    if (!(xl <= xh)) continue;
    for (let c = bucketCol(q, xl - q.slack), c1 = bucketCol(q, xh + q.slack); c <= c1; c++) {
      for (let db = -1; db <= 1; db++) {
        const b = (q.bin[s] + db + ANGLE_BINS) % ANGLE_BINS;
        for (let e = q.head[(r * q.nx + c) * ANGLE_BINS + b]; e >= 0; e = q.entryNext[e]) {
          q.work += VISIT_COST;
          const t = q.entrySeg[e];
          if (t <= s || q.seen[t] === s) continue;
          q.seen[t] = s;
          const w = stripWidth(q, s, t);
          if (w > 0) q.best = w;
          if (q.work > q.budget) return;
        }
      }
    }
  }
}

/**
 * The narrowest thing the fine grid must resolve, in metres, before the floor:
 * the smallest of every ring's own width and every STRIP of the cover map.
 *
 * Boundaries are first folded (FOLD_M). A strip is then ground between two
 * boundaries that face each other (within 15 degrees, overlapping along their
 * length): a plot's width, an alley between plots, the gap between the parts of
 * a multipart plot, a hole, a notch, an arm of an L, bare ground between a plot
 * and the footprint's edge. Its width is where it is narrowest along the
 * overlap, and it only counts when
 *   - it is at least SEAM_M wide, so a digitising seam is not an alley;
 *   - it is at least half as long as it is wide, measured along the STRETCHES
 *     the two boundaries belong to (their neighbours along the ring that still
 *     run within 15 degrees of them, so a polygonised curve counts as the arc it
 *     draws): two teeth of a jagged edge a few centimetres long face each other
 *     across any width, and are no strip;
 *   - those stretches do not meet, where the two boundaries would bound a wedge
 *     or a cusp instead (a plot corner on the footprint's edge, a curved plot
 *     where the footprint or a neighbour touches it): every width down to 0
 *     occurs in such a sliver, over hardly any ground, and whichever width a
 *     polygon's vertices happened to sample drove the stride to its cap;
 *   - the cover map really changes across BOTH boundaries there: the ground
 *     just inside each and in the middle is one cover, the ground just beyond
 *     each is another. Plots overlapping by a few centimetres fail it (beyond
 *     the hidden edge lies the plot drawn over it, as between), so does an edge
 *     in several pieces, which is at distance 0 from itself anyway, and so do
 *     two sides with another boundary between them (a plot's side and the far
 *     side of the plot turned against it, with the wedge between the two plots
 *     inside that "strip").
 * The corner of one plot near the side of a plot turned against it bounds no
 * strip either: what lies between those widens at once and holds hardly any
 * ground. A ring's own width (rotating calipers over the hull of its exact
 * vertices) is kept for shapes with no facing sides, a triangle, and bounds the
 * search: nothing wider can lower the answer.
 *
 * Pairs are found through buckets of segments per direction, queried only as
 * far as the best width so far (which shrinks as strips are found) and never
 * farther than twice the segment's stretch is long. Past its budget (WORK_MAX
 * unless the regression suite says otherwise) the search gives up and answers
 * a seam.
 */
function narrowestFeature(plan: ImportedPlan, budget = WORK_MAX): number {
  const rings: XY[][] = [];
  for (const p of plan.plots) for (const ring of p.rings) rings.push(ring);
  const plotRings = rings.length;
  rings.push(plan.footprint);

  // A plot ring's own width over its EXACT vertices: folding a plot narrower
  // than the fold leaves a line with no width, and that plot is the narrowest
  // thing there is.
  let best = Infinity;
  for (let r = 0; r < plotRings; r++) {
    const w = hullWidth(convexHull(rings[r]));
    if (w > 0 && w < best) best = w;
  }

  // Every boundary segment, folded, ring by ring.
  const folded = rings.map(ring => foldRing(ring, FOLD_M));
  let S = 0;
  for (const v of folded) if (v.length >= 2) S += v.length;
  if (!Number.isFinite(best) || S < 2) return best;
  const xy = new Float64Array(4 * S), ringOf = new Int32Array(S);
  const ringStart = new Int32Array(rings.length), ringSize = new Int32Array(rings.length);
  let n = 0;
  folded.forEach((v, r) => {
    ringStart[r] = n;
    if (v.length < 2) return;
    ringSize[r] = v.length;
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      xy[4 * n] = a[0]; xy[4 * n + 1] = a[1]; xy[4 * n + 2] = b[0]; xy[4 * n + 3] = b[1];
      ringOf[n++] = r;
    }
  });

  const len = new Float64Array(S), bin = new Uint8Array(S);
  let total = 0;
  for (let s = 0; s < S; s++) {
    const dx = xy[4 * s + 2] - xy[4 * s], dy = xy[4 * s + 3] - xy[4 * s + 1];
    len[s] = Math.hypot(dx, dy);
    total += len[s];
    let a = Math.atan2(dy, dx);
    if (a < 0) a += Math.PI;
    bin[s] = Math.min(ANGLE_BINS - 1, Math.floor((a / Math.PI) * ANGLE_BINS));
  }
  // Buckets about as wide as a segment or as the design's density, whichever
  // is larger, and never more than 4096 a side. A hair of slack on every bucket
  // lookup, so rounding at a bucket's edge can only add a bucket, never lose one.
  const [x0, y0, x1, y1] = plan.bbox;
  const W = Math.max(x1 - x0, 1e-3), H = Math.max(y1 - y0, 1e-3);
  const cell = Math.max(total / S, Math.sqrt((W * H) / S), W / 4096, H / 4096);
  const nx = Math.floor(W / cell) + 1, ny = Math.floor(H / cell) + 1;
  const q: StripSearch = {
    plan, xy, len, bin, ringOf, ringStart, ringSize,
    fwd: new Int32Array(S), back: new Int32Array(S), stretchLen: new Float64Array(S),
    x0, y0, cell, nx, ny, slack: 1e-6 * cell,
    head: new Int32Array(nx * ny * ANGLE_BINS).fill(-1), entrySeg: new Int32Array(4 * S + 16), entryNext: new Int32Array(4 * S + 16), entries: 0,
    seen: new Int32Array(S).fill(-1), band: new Float64Array(8),
    best, work: 0, budget,
  };
  for (let s = 0; s < S; s++) {
    q.work += TRACE_COST * traceStretch(q, s);
    if (q.work > budget) return Math.min(q.best, SEAM_M);
  }
  for (let s = 0; s < S; s++) indexSegment(q, s);
  for (let s = 0; s < S; s++) {
    stripsFrom(q, s);
    if (q.work > budget) return Math.min(q.best, SEAM_M);
  }
  return q.best;
}

/**
 * Two independent 32-bit hash streams (MurmurHash3's block mix, different
 * constants and seeds), so a collision has to happen in both: the signature
 * decides whether the page recomputes, and a collision would show the previous
 * design's numbers with no error anywhere. Coordinates go in as the two words
 * of their IEEE bits, not rounded: the cover map reads them exactly, so a key
 * that rounded to the millimetre kept serving a map that had moved.
 */
function signature(tokens: (text: (s: string) => void, num: (x: number) => void) => void): string {
  let h1 = 0x811c9dc5 | 0, h2 = 0x050c5d1f | 0;
  const f64 = new Float64Array(1), words = new Uint32Array(f64.buffer);
  const mix = (h: number, k: number, c1: number, c2: number) => {
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19);
    return (Math.imul(h, 5) + 0xe6546b64) | 0;
  };
  const word = (w: number) => {
    h1 = mix(h1, w, 0xcc9e2d51, 0x1b873593);
    h2 = mix(h2, w, 0x85ebca6b, 0xc2b2ae35);
  };
  let count = 0;
  tokens(
    s => { word(s.length); count++; for (let i = 0; i < s.length; i++) { word(s.charCodeAt(i)); count++; } },
    x => { f64[0] = x; word(words[0]); word(words[1]); count += 2; },
  );
  const final = (h: number) => {
    h ^= count; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  return final(h1) + final(h2);
}

/**
 * Resolve an uploaded design against the grid's UTM CRS `epsg`.
 *
 * Species of a plot = index in `varieties` of its variety key (varietyKeyOf).
 * Cover ids are PLOT ids up to MAX_PLOTS plots, so a pixel straddling two plots
 * of one variety is not called pure; beyond that they fall back to SPECIES ids
 * and `coverSpecies` is the identity.
 *
 * Throws rather than guess, because every fallback here would be a trial that
 * silently differs from the file: a plot whose variety is not in `varieties`,
 * more varieties than the cover map can number, a coordinate that does not
 * project, or a design with no vertex at all.
 */
export function resolveImportedPlan(design: ImportedDesign, varieties: ImportedVariety[], epsg: number): ImportedPlan {
  const nSpecies = varieties.length;
  if (nSpecies > MAX_PLOTS) {
    throw new RangeError(`${nSpecies} varieties: the simulation can tell at most ${MAX_PLOTS} apart`);
  }
  const index = new Map<string, number>();
  varieties.forEach((v, i) => { if (!index.has(v.key)) index.set(v.key, i); });

  const to = proj4('EPSG:4326', crsToProj4Def(`EPSG:${epsg}`));
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  const all: XY[] = [];
  const plots = design.plots.map((plot, i) => {
    const key = varietyKeyOf(design, i);
    const species = index.get(key);
    if (species === undefined) throw new Error(`plot ${i + 1}: variety "${key}" is not in the variety list`);
    const rings = plot.rings.map(ring => ring.map(([lng, lat]): XY => {
      const [x, y] = to.forward([lng, lat]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`plot ${i + 1}: vertex [${lng}, ${lat}] does not project to EPSG:${epsg}`);
      }
      if (x < minE) minE = x; if (x > maxE) maxE = x;
      if (y < minN) minN = y; if (y > maxN) maxN = y;
      all.push([x, y]);
      return [x, y];
    }));
    return { rings, species };
  });
  if (!all.length) throw new Error('the design has no plot geometry');

  const plotIds = plots.length <= MAX_PLOTS;
  const coverSpecies = plotIds
    ? Uint8Array.from(plots, p => p.species)
    : Uint8Array.from({ length: nSpecies }, (_, s) => s);

  const plan: ImportedPlan = {
    epsg, plots, coverSpecies, plotIds, nSpecies,
    footprint: convexHull(all),
    bbox: [minE, minN, maxE, maxN],
    minFeature: 0, sig: '',
  };
  // Measured on the plan itself, so "what the cover map shows" is the engine's
  // own answer (and its point index is built once, for the engine to reuse).
  const narrowest = narrowestFeature(plan);
  // A design of degenerate plots has no width to measure; its extent is the
  // only scale it has.
  plan.minFeature = Math.max(MIN_FEATURE_FLOOR_M, Number.isFinite(narrowest) ? narrowest : Math.max(maxE - minE, maxN - minN));

  // The variety keys too, in species order: the engine only reads indices, but
  // everything that labels or colours a species reads them through this list,
  // and the same indices over renamed varieties are a different trial to a reader.
  const sig = signature((text, num) => {
    num(epsg); num(nSpecies); num(plots.length);
    for (const v of varieties) text(v.key);
    for (const p of plots) {
      num(p.species); num(p.rings.length);
      for (const ring of p.rings) {
        num(ring.length);
        for (const [x, y] of ring) { num(x); num(y); }
      }
    }
  });
  plan.sig = `${plots.length}p-${sig}`;
  return plan;
}
