import type { ImportedPlan } from './imported-types';
import { MAX_COVER, fieldVerdicts, keepsCount, noCountYet, spotSigma, type SensorParams } from './simulate';
import type { S2Grid } from './s2-grid';
import { fieldOverlapTest } from './geometry';
import { importedTrialExtent } from './ladder';
import { ce90Shifts, heldMask } from './resolving';

/**
 * Turning an imported trial, to ask what the same layout would give at another
 * angle to the pixel rows (0° lines its plots up with them).
 *
 * A rigid rotation of the RESOLVED plan, about the centre of its footprint's
 * box, in the grid's metres. Everything the engine reads moves together, so the
 * map, the purity, the PCA and the ladder describe the same turned trial:
 * plots, footprint and box turn; plot widths and the gaps between plots do not
 * change, so minFeature stays; the signature records the turn, so every memo
 * keyed on the layout recomputes.
 */

/**
 * The trial's angle to the pixel rows, in degrees within [0, 90): the dominant
 * direction of its plot edges, each edge weighted by its length, folded onto a
 * quarter turn (a plot's long and short sides agree once folded). Measured
 * counter-clockwise from east, the way the other layouts' angle is.
 */
export function trialAngle(plan: ImportedPlan): number {
  let sx = 0, sy = 0;
  for (const plot of plan.plots) {
    for (const ring of plot.rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (!len) continue; // a closed ring repeats its first vertex
        const t = 4 * Math.atan2(dy, dx);
        sx += len * Math.cos(t);
        sy += len * Math.sin(t);
      }
    }
  }
  if (!sx && !sy) return 0;
  const deg = (Math.atan2(sy, sx) / 4) * (180 / Math.PI);
  return ((deg % 90) + 90) % 90;
}

/** `plan` turned by `turnDeg` degrees (counter-clockwise) about its box's centre. The same object for a zero turn. */
export function rotateImportedPlan(plan: ImportedPlan, turnDeg: number): ImportedPlan {
  if (!turnDeg) return plan;
  const [e0, n0, e1, n1] = plan.bbox;
  const cx = (e0 + e1) / 2, cy = (n0 + n1) / 2;
  const t = (turnDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const turn = ([x, y]: [number, number]): [number, number] =>
    [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  // A turned convex hull is the hull of the turned vertices, so the footprint
  // turns as it is, and its box still bounds every plot.
  const footprint = plan.footprint.map(turn);
  let b0 = Infinity, b1 = Infinity, b2 = -Infinity, b3 = -Infinity;
  for (const [x, y] of footprint) { b0 = Math.min(b0, x); b1 = Math.min(b1, y); b2 = Math.max(b2, x); b3 = Math.max(b3, y); }
  return {
    ...plan,
    plots: plan.plots.map(p => ({ ...p, rings: p.rings.map(r => r.map(turn)) })),
    footprint,
    bbox: [b0, b1, b2, b3],
    sig: `${plan.sig}|turn${turnDeg}`,
  };
}

/**
 * The smallest turn taking a trial drawn at `from` degrees to `to` degrees,
 * within (-45, 45]. Square pixels look the same a quarter turn round, so 0 and
 * 90 degrees are both "along the pixel rows", and a trial drawn at 80 degrees
 * aligns by turning 10, not 80.
 */
export function nearestTurn(from: number, to: number): number {
  let t = (((to - from) % 90) + 90) % 90;
  if (t > 45) t -= 90;
  return t;
}

/** True when a trial at `angle` degrees runs along the pixel rows. */
/**
 * Is `angle` within `tol` degrees of a pixel axis?
 *
 * A grid of plots repeats every 90 degrees, and the angle may be NEGATIVE: a
 * field whose rows run a few degrees anticlockwise of the pixel rows is entered
 * as such. So the angle is folded into [0, 90) FIRST. Written out by hand as
 * `Math.min(angle, 90 - angle) < tol` it reads -3.6 degrees as -3.6, which is
 * below any tolerance, so a trial at -3.6 degrees called itself already aligned
 * and switched the whole "vs aligned" comparison off. Three copies of that
 * expression were live, in two steps and in the ladder.
 */
export const alignedWithin = (angle: number, tol: number): boolean => {
  const a = ((angle % 90) + 90) % 90;
  return Math.min(a, 90 - a) < tol;
};

/** Exactly on a pixel axis, to floating-point slack. */
export const isAligned = (angle: number): boolean => alignedWithin(angle, 1e-6);

/** `plan` moved by (dx, dy) metres. */
export function shiftImportedPlan(plan: ImportedPlan, dx: number, dy: number): ImportedPlan {
  if (!dx && !dy) return plan;
  const move = ([x, y]: [number, number]): [number, number] => [x + dx, y + dy];
  const [b0, b1, b2, b3] = plan.bbox;
  return {
    ...plan,
    plots: plan.plots.map(p => ({ ...p, rings: p.rings.map(r => r.map(move)) })),
    footprint: plan.footprint.map(move),
    bbox: [b0 + dx, b1 + dy, b2 + dx, b3 + dy],
    sig: `${plan.sig}|shift${dx},${dy}`,
  };
}

/**
 * Pure pixels of an imported trial on the pixel grid of size `r` (edges on
 * multiples of r), counted over the pixels overlapping the trial's own
 * footprint: the rule the resolution ladder counts by. A COUNT, not a
 * percentage: two placements of one trial have the same area but not the same
 * number of edge pixels, so their percentages have different denominators.
 */
export function purePixels(plan: ImportedPlan, r: number, sensor: SensorParams, extent: [number, number, number, number]): number {
  const [e0, n0, e1, n1] = importedTrialExtent(plan, r, sensor, extent);
  const layout = { pattern: 'imported' as const, width: 1, spacing: 0, rotationDeg: 0, imported: plan };
  const nx = Math.round((e1 - e0) / r), ny = Math.round((n1 - n0) / r);
  // Only the pixels that overlap the trial are counted, so only they are
  // worked out, and only their verdict: a count reads nothing else. It is the
  // count coverStats gives (see pureVerdictCount for the pixels half off the trial).
  const overlaps = fieldOverlapTest(plan.footprint);
  const keep = new Uint8Array(Math.max(0, nx * ny));
  for (let k = 0; k < keep.length; k++) {
    if (overlaps(e0 + (k % nx) * r, n0 + Math.floor(k / nx) * r, r)) keep[k] = 1;
  }
  const verdicts = fieldVerdicts({ res: r, utmBounds: [e0, n0, e1, n1] } as unknown as S2Grid, [0, 0], layout, sensor, keep);
  let pure = 0;
  for (let k = 0; k < keep.length; k++) if (keep[k] && verdicts[k] <= MAX_COVER) pure++;
  return pure;
}

/**
 * Where the image can land around an IMPORTED trial lying along `angleDeg`: the
 * plots' own eight directions (ce90Shifts), and for a trial too large for a
 * plot id each (`plotIds` false: more than 253 plots, so its covers are
 * species) a second ring at half the radius. Two plots of one variety can sit
 * side by side across an alley there, and the rim alone can step from one to
 * the other over ground that is neither.
 *
 * ONE rule for the placement search (heldPixels, scanShifts) and for the
 * table, the map and the export (pixel-verdicts.ts landings): the search used
 * to score on the eight while the table counted on sixteen, so the placement
 * it called best could read lower in the table (found by an outside review,
 * 2026-11-22).
 */
export function importedLandings(ce90: number, angleDeg: number, plotIds: boolean): [number, number][] {
  const lands = ce90Shifts(ce90, angleDeg);
  return plotIds || !lands.length ? lands : [...lands, ...ce90Shifts(ce90 / 2, angleDeg + 22.5)];
}

/**
 * The pure pixels of an imported trial that stay pure, for the same plot,
 * wherever the image lands within `ce90` metres: the count the ladder's CE90
 * column is made of, by the same steps (the trial's own extent, the pixels
 * overlapping its footprint, eight shifts on the circle, robustMask, and no
 * pixel more than half off the trial). Nine simulations where purePixels
 * runs one.
 */
export function heldPixels(plan: ImportedPlan, r: number, sensor: SensorParams, ce90: number): number {
  const [e0, n0, e1, n1] = importedTrialExtent(plan, r, sensor, [-Infinity, -Infinity, Infinity, Infinity]);
  const box = { res: r, utmBounds: [e0, n0, e1, n1] } as unknown as S2Grid;
  const layoutOf = (q: ImportedPlan) => ({ pattern: 'imported' as const, width: 1, spacing: 0, rotationDeg: 0, imported: q });
  const nx = Math.round((e1 - e0) / r), ny = Math.round((n1 - n0) / r);
  const overlaps = fieldOverlapTest(plan.footprint);
  const keep = new Uint8Array(Math.max(0, nx * ny));
  for (let k = 0; k < keep.length; k++) {
    if (overlaps(e0 + (k % nx) * r, n0 + Math.floor(k / nx) * r, r)) keep[k] = 1;
  }
  // The verdicts where the image is meant to be, then each placement asked only
  // about the pixels still pure for their plot (holdTracker). A pixel outside
  // the footprint reads mixed from the start, so it is never asked about, and a
  // pixel more than half off the trial is never pure for a crop to begin with.
  const nominal = fieldVerdicts(box, [0, 0], layoutOf(plan), sensor, keep);
  const lands = importedLandings(ce90, trialAngle(plan), plan.plotIds);
  // The image landed elsewhere is the pixels moved that far over the same plan (no second plan is made of it).
  const mask = heldMask(nominal, lands.length, (s, need) =>
    fieldVerdicts({ res: r, utmBounds: [e0 + lands[s][0], n0 + lands[s][1], e1 + lands[s][0], n1 + lands[s][1]] } as unknown as S2Grid, [0, 0], layoutOf(plan), sensor, need));
  let held = 0;
  for (let k = 0; k < mask.length; k++) if (mask[k]) held++;
  return held;
}

/**
 * A trial turned to run along the pixel rows, staked where it keeps the most
 * pure pixels: the best of an N x N grid of sub-pixel shifts. This is what
 * "aligned" has to mean. Turned about its centre and left wherever that put
 * it, the plot edges can fall mid-pixel, and the comparison then blames the
 * angle for a bad position. N shrinks on large grids so the search stays
 * within about `budget` simulated pixels.
 *
 * `staked` says whether a search actually ran. It is the honest half of the
 * budget: when N collapses to 1 the trial is turned and left where the rotation
 * put it, so "aligned" means the best of a search at one pixel size and merely
 * "turned" at another, and nothing on the page could tell the two apart. A
 * caller that shows the aligned comparison should say which one it got rather
 * than let the reader assume the search.
 */
export function stakeOnGrid(
  plan: ImportedPlan, r: number, sensor: SensorParams, extent: [number, number, number, number], budget = 400_000,
): { plan: ImportedPlan; shift: [number, number]; staked: boolean } {
  const [b0, b1, b2, b3] = plan.bbox;
  // A candidate costs its pixels PLUS a little per plot, added not multiplied.
  //
  // Measured over 15 combinations of plot count, footprint and pixel size, the
  // simulation runs at 0.7 to 1.7 us per pixel with no useful dependence on how
  // many plots are drawn: a pixel's work is the plot boundaries crossing THAT
  // pixel, and more plots over a fixed area means smaller plots, not more work
  // per pixel. The genuinely per-plot cost is shiftImportedPlan, which moves
  // every vertex of every plot for each candidate: 0.08 ms at 50 plots, 1.5 ms
  // at 2000. Against 0.89 us per pixel that is about two pixels per plot, and a
  // least-squares fit over those 15 points agrees.
  //
  // It was once a FACTOR of `plots / 50`, which inverted the budget it was
  // meant to enforce: a 200-plot trial was refused a search outright while a
  // 50-plot trial over the same footprint was granted the full 3 x 3 and paid
  // 378 ms for it, and the refused search was worth about 18% more pure pixels.
  // The additive term still bounds what the factor was aimed at, a dense trial
  // at a coarse size, where N reaches its cap and the per-plot shifting is most
  // of the cost: a 2000-plot import at 10 m drops from 100 candidates to 64.
  const pixels = Math.max(1, ((b2 - b0) / r + 6) * ((b3 - b1) / r + 6));
  // Placed for the pixels that hold within a CE90 (SensorParams.placeHeldM): a
  // candidate is then asked about again at each landing, for the pixels still
  // pure, which is about half as much again per landing on a trial with many.
  const holdM = sensor.placeHeldM && sensor.placeHeldM > 0 ? sensor.placeHeldM : 0;
  const landCount = holdM > 0 ? importedLandings(holdM, trialAngle(plan), plan.plotIds).length : 0;
  const perCandidate = (pixels + 2 * plan.plots.length) * (1 + landCount / 2);
  const n = Math.max(1, Math.min(10, Math.floor(Math.sqrt(budget / perCandidate))));
  // A trial too big for one call to fit the budget leaves N at 1, and a 1 x 1
  // search offers only the trial where it stands: counting its pure pixels
  // decides nothing, and the count is never read again. Simulating it anyway
  // cost the whole trial (1.6 s of blocked main thread at 0.5 m on a 2000-plot
  // import), so the budget bounded the number of shifts but not the work. It
  // bounds the work now: no shift to choose, no simulation. `staked: false` is
  // what stops that being silent.
  if (n === 1) return { plan, shift: [0, 0], staked: false };
  // The most pure pixels on a lattice that is known, the fewest on one that falls anywhere (SensorParams.anyPosition).
  let best = plan, bestShift: [number, number] = [0, 0], bestCount = noCountYet(sensor);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // The shift is returned rather than read back off the result: recovering
      // it from a bbox of six-figure eastings loses its last digits, and the
      // page saves this number and rebuilds the trial from it.
      const shift: [number, number] = [(i * r) / n, (j * r) / n];
      const candidate = shiftImportedPlan(plan, shift[0], shift[1]);
      const count = holdM > 0 ? heldPixels(candidate, r, sensor, holdM) : purePixels(candidate, r, sensor, extent);
      if (keepsCount(sensor, count, bestCount)) { bestCount = count; best = candidate; bestShift = shift; }
    }
  }
  return { plan: best, shift: bestShift, staked: true };
}

/** The standard normal's distribution function, to 1.5e-7 (Abramowitz and Stegun 7.1.26). */
function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Where a trial is put: turned, then moved. */
export interface Placement {
  /** Degrees the file's trial is turned by, counter-clockwise about its box's centre. */
  turn: number;
  /** Metres it is then moved by, east and north. */
  shift: [number, number];
  /** Its angle to the pixel rows once placed, in [0, 90). */
  angle: number;
  /** The trial there. */
  plan: ImportedPlan;
  /**
   * What the placement was chosen on, counted by the engine: the pure pixels,
   * or with a geolocation error the pure pixels that hold within the CE90.
   * NaN when no search ran.
   */
  pure: number;
  /**
   * Whether a search ran. False for a trial too large to search at this pixel
   * size: the placement is then the trial as the file has it, and nothing says
   * it is the best.
   */
  searched: boolean;
}

/**
 * Pure pixels of a turned trial at every one of n x n sub-pixel shifts, by a
 * stand-in for the engine that costs a few operations per pixel.
 *
 * A pixel is counted pure when its centre is inside a plot and the plot's
 * edges are far enough: for each edge, the share of a Gaussian spot that stays
 * on the near side of a straight border at that distance, and the product of
 * those shares against the threshold. The spot is the engine's: the blur alone
 * (the note's model, simulate.ts followsSpot), never narrower than a pixel's
 * own footprint, where the product of the shares is the engine's own figure
 * for a rectangular plot under a round blur. A guide and no more for any other
 * shape, which is why nothing is decided on it: it only chooses the placements
 * the engine is then asked about.
 *
 * `counts[b * n + a]` is the count with the trial moved by (a, b) * r / n.
 * One pass over a lattice n times finer than the pixels does every shift at
 * once: a pixel centre under one shift is a point of that lattice.
 *
 * With `lands` (where the image can land, from ce90Shifts) a pixel is counted
 * only when it passes at its own place and at every one of those, for the
 * same plot: the pixels that hold within the CE90, as robustMask has them.
 */
/** A plot that is a rectangle, as scanShifts wants it: its centre from the middle of the plan's box, the unit vector along its first side, its two half sides. */
interface ScanRect { dx: number; dy: number; ex: number; ey: number; ha: number; hb: number }
const scanRects = new WeakMap<ImportedPlan, (ScanRect | null)[]>();

/** Each plot of a plan as a ScanRect, or null where it is not one ring of four square corners. Kept with the plan: a search asks for it at every angle. */
function scanRectsOf(base: ImportedPlan): (ScanRect | null)[] {
  const hit = scanRects.get(base);
  if (hit) return hit;
  const [b0, b1, b2, b3] = base.bbox;
  const cx = (b0 + b2) / 2, cy = (b1 + b3) / 2;
  const out = base.plots.map((p): ScanRect | null => {
    if (p.rings.length !== 1) return null;
    const ring = p.rings[0], len = ring.length;
    const m = len > 1 && ring[0][0] === ring[len - 1][0] && ring[0][1] === ring[len - 1][1] ? len - 1 : len;
    if (m !== 4) return null;
    const [a, b, c, d] = ring;
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - a[0], vy = d[1] - a[1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (!(lu > 0) || !(lv > 0)) return null;
    const tol = 1e-6 * Math.max(lu, lv);
    if (Math.abs(a[0] + ux + vx - c[0]) > tol || Math.abs(a[1] + uy + vy - c[1]) > tol) return null;
    if (Math.abs(ux * vx + uy * vy) > 1e-6 * lu * lv) return null;
    return { dx: a[0] + (ux + vx) / 2 - cx, dy: a[1] + (uy + vy) / 2 - cy, ex: ux / lu, ey: uy / lu, ha: lu / 2, hb: lv / 2 };
  });
  scanRects.set(base, out);
  return out;
}

/**
 * `plain` runs every plot through the general test, edge by edge: what the
 * rectangles' own path below must give, count for count (the suite compares
 * them), and never asked for by the page.
 */
function scanShifts(
  base: ImportedPlan, turn: number, r: number, n: number, sensor: SensorParams, counts: Float64Array,
  lands: [number, number][] = [], plain = false,
): void {
  counts.fill(0);
  const [b0, b1, b2, b3] = base.bbox;
  const cx = (b0 + b2) / 2, cy = (b1 + b3) / 2;
  const t = (turn * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const thr = sensor.mixThreshold;
  // The distance at which ONE straight border alone leaves exactly the threshold.
  let lo = 0, hi = 8;
  for (let q = 0; q < 40; q++) { const mid = (lo + hi) / 2; if (phi(mid) < thr) lo = mid; else hi = mid; }
  const zThr = hi;
  // The spot the engine reads with: the blur and nothing more (the note's H1),
  // never narrower than a pixel's own footprint (simulate.ts spotSigma). With no
  // blur at all that is the footprint's own spread, the square pixel's.
  const vx = (spotSigma(sensor.sigmaX) * r) ** 2, vy = (spotSigma(sensor.sigmaY) * r) ** 2, box = 0;
  const h = r / n;
  const rects = plain ? null : scanRectsOf(base);
  const nL = lands.length, la = new Float64Array(nL), lb = new Float64Array(nL), halfR = r / 2;
  // Per edge: start, direction, 1 / length^2, 1 / sigma, and the two squared
  // distances that settle it without a square root (too close, far enough).
  let edge = new Float64Array(64 * 8);
  for (let pi = 0; pi < base.plots.length; pi++) {
    const plot = base.plots[pi];
    const rc = rects ? rects[pi] : null;
    if (rc) {
      /**
       * A RECTANGLE, which is every plot of nearly every trial, in its own
       * frame: a point's distances to its four sides are its two coordinates
       * there, taken from the half sides. No edge is projected on, no square
       * root is taken, and no crossing is counted: a point at least the
       * threshold's distance from all four sides is inside.
       *
       * Along a row of the lattice both coordinates move by a fixed step, so
       * the stretch of the row that can be pure at all is cut out directly
       * (the rectangle's box turned on the lattice is twice its area at 45
       * degrees, and all of it was walked). Inside that stretch, the points
       * further than 3.5 sigma from every side, at their own place and at
       * every landing, are pure with nothing to work out: they are added to
       * the n shifts they belong to, n at a time.
       *
       * Same counts as the general test, which is kept for every other shape.
       * The quick count was two fifths of the whole satellites table on a
       * trial of 54 plots; this is what an outside review proposed for it
       * (2026-11-22).
       */
      const rcx = cx + rc.dx * c - rc.dy * s, rcy = cy + rc.dx * s + rc.dy * c;
      const ex = rc.ex * c - rc.ey * s, ey = rc.ex * s + rc.ey * c;
      const ha = rc.ha, hb = rc.hb;
      // The blur across the two sides square to `a`, and across the two square to `b`.
      const sigA = Math.sqrt(vx * ex * ex + vy * ey * ey + box), sigB = Math.sqrt(vx * ey * ey + vy * ex * ex + box);
      const dThrA = zThr * sigA, dThrB = zThr * sigB;
      if (!(ha - dThrA >= 0) || !(hb - dThrB >= 0)) continue;
      // Where the image can land, in the plot's frame, and how far each way.
      let minLa = 0, maxLa = 0, minLb = 0, maxLb = 0;
      for (let q = 0; q < nL; q++) {
        const a = lands[q][0] * ex + lands[q][1] * ey, b = -lands[q][0] * ey + lands[q][1] * ex;
        la[q] = a; lb[q] = b;
        if (a < minLa) minLa = a;
        if (a > maxLa) maxLa = a;
        if (b < minLb) minLb = b;
        if (b > maxLb) maxLb = b;
      }
      // Where a point can pass the first test at its own place and at every landing.
      const aLo = -(ha - dThrA) - minLa, aHi = ha - dThrA - maxLa, bLo = -(hb - dThrB) - minLb, bHi = hb - dThrB - maxLb;
      if (!(aLo <= aHi) || !(bLo <= bHi)) continue;
      const dCutA = 3.5 * sigA, dCutB = 3.5 * sigB, invA = 1 / sigA, invB = 1 / sigB;
      // A little slack: the stretch is cut generously and each of its ends is then tested point by point, the core is cut short.
      const eps = 1e-9 * Math.max(ha, hb, 1);
      const cA = ha - dCutA - eps, cB = hb - dCutB - eps;
      const cALo = -cA - minLa, cAHi = cA - maxLa, cBLo = -cB - minLb, cBHi = cB - maxLb;
      const hasCore = thr <= 1 && cALo <= cAHi && cBLo <= cBHi;
      const yMin = rcy + (ey >= 0 ? aLo * ey : aHi * ey) + (ex >= 0 ? bLo * ex : bHi * ex);
      const yMax = rcy + (ey >= 0 ? aHi * ey : aLo * ey) + (ex >= 0 ? bHi * ex : bLo * ex);
      const k0 = Math.floor((yMin - halfR) / h) - 1, k1 = Math.ceil((yMax - halfR) / h) + 1;
      const stepA = h * ex, stepB = -h * ey, dx0 = halfR - rcx;
      /** The points m of a row with lo <= base + m step <= hi, cut into [from, to]: false when there is none. */
      let from = 0, to = 0;
      const cut = (base0: number, step: number, low: number, high: number): boolean => {
        if (Math.abs(step) < 1e-12) return base0 >= low && base0 <= high;
        const t1 = (low - base0) / step, t2 = (high - base0) / step;
        const first = Math.ceil(step > 0 ? t1 : t2), last = Math.floor(step > 0 ? t2 : t1);
        if (first > from) from = first;
        if (last < to) to = last;
        return from <= to;
      };
      /** One side's part in a point's share: nothing past 3.5 sigma, as in the general test. */
      const pass = (a: number, b: number): boolean => {
        const da1 = ha - a, da2 = ha + a, db1 = hb - b, db2 = hb + b;
        if (da1 < dThrA || da2 < dThrA || db1 < dThrB || db2 < dThrB) return false;
        let prod = 1;
        if (da1 < dCutA) prod *= phi(da1 * invA);
        if (da2 < dCutA) prod *= phi(da2 * invA);
        if (db1 < dCutB) prod *= phi(db1 * invB);
        if (db2 < dCutB) prod *= phi(db2 * invB);
        return prod >= thr;
      };
      const test = (mA: number, mB: number, aBase: number, bBase: number, bRow: number): void => {
        if (mA > mB) return;
        let col = (n - (((mA % n) + n) % n)) % n;
        for (let m = mA; m <= mB; m++) {
          const a = aBase + m * stepA, b = bBase + m * stepB;
          let ok = pass(a, b);
          for (let q = 0; q < nL && ok; q++) ok = pass(a + la[q], b + lb[q]);
          if (ok) counts[bRow + col]++;
          if (--col < 0) col = n - 1;
        }
      };
      for (let k = k0; k <= k1; k++) {
        const dy = halfR + k * h - rcy;
        const aBase = dx0 * ex + dy * ey, bBase = -dx0 * ey + dy * ex;
        from = -1e12; to = 1e12;
        if (!cut(aBase, stepA, aLo - eps, aHi + eps) || !cut(bBase, stepB, bLo - eps, bHi + eps)) continue;
        if (!(to - from < 1e9)) continue;                 // a row of points all at one place: no rectangle is that
        const mStart = from, mEnd = to;
        const bRow = ((n - (((k % n) + n) % n)) % n) * n;
        if (hasCore && cut(aBase, stepA, cALo, cAHi) && cut(bBase, stepB, cBLo, cBHi)) {
          const cStart = from, cEnd = to;
          test(mStart, cStart - 1, aBase, bBase, bRow);
          const len = cEnd - cStart + 1, full = Math.floor(len / n), rem = len - full * n;
          if (full > 0) for (let q = 0; q < n; q++) counts[bRow + q] += full;
          let col = (n - (((cStart % n) + n) % n)) % n;
          for (let q = 0; q < rem; q++) { counts[bRow + col]++; if (--col < 0) col = n - 1; }
          test(cEnd + 1, mEnd, aBase, bBase, bRow);
        } else test(mStart, mEnd, aBase, bBase, bRow);
      }
      continue;
    }
    let nE = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, reach = Infinity;
    for (const ring of plot.rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const ax = cx + (a[0] - cx) * c - (a[1] - cy) * s, ay = cy + (a[0] - cx) * s + (a[1] - cy) * c;
        const bx = cx + (b[0] - cx) * c - (b[1] - cy) * s, by = cy + (b[0] - cx) * s + (b[1] - cy) * c;
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        if (!(len2 > 0)) continue;                       // a closed ring repeats its first vertex
        if ((nE + 1) * 8 > edge.length) { const next = new Float64Array(edge.length * 2); next.set(edge); edge = next; }
        // The blur across this edge: the PSF's variance along the edge's normal.
        const sig = Math.sqrt((vx * dy * dy + vy * dx * dx) / len2 + box);
        const o = nE++ * 8;
        edge[o] = ax; edge[o + 1] = ay; edge[o + 2] = dx; edge[o + 3] = dy; edge[o + 4] = 1 / len2;
        edge[o + 5] = 1 / sig; edge[o + 6] = (zThr * sig) ** 2; edge[o + 7] = (3.5 * sig) ** 2;
        reach = Math.min(reach, zThr * sig);
        x0 = Math.min(x0, ax); y0 = Math.min(y0, ay); x1 = Math.max(x1, ax); y1 = Math.max(y1, ay);
      }
    }
    if (nE < 3) continue;
    // No pure pixel centre within `reach` of the plot's box edge: skip that rim.
    const m0 = Math.ceil((x0 + reach - r / 2) / h), m1 = Math.floor((x1 - reach - r / 2) / h);
    const k0 = Math.ceil((y0 + reach - r / 2) / h), k1 = Math.floor((y1 - reach - r / 2) / h);
    const edges = edge, count = nE;
    /** Is a pixel centred here pure for this plot? */
    const pureAt = (px: number, py: number): boolean => {
      let prod = 1, inside = false;
      for (let e = 0; e < count; e++) {
        const o = e * 8;
        const ax = edges[o], ay = edges[o + 1], dx = edges[o + 2], dy = edges[o + 3];
        const wx = px - ax, wy = py - ay;
        let u = (wx * dx + wy * dy) * edges[o + 4];
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const qx = wx - u * dx, qy = wy - u * dy, d2 = qx * qx + qy * qy;
        if (d2 < edges[o + 6]) return false;
        if (d2 < edges[o + 7]) prod *= phi(Math.sqrt(d2) * edges[o + 5]);
        // Even-odd crossing, over every ring of the plot at once.
        const by = ay + dy;
        if ((ay > py) !== (by > py) && px < ax + ((py - ay) / dy) * dx) inside = !inside;
      }
      return inside && prod >= thr;
    };
    for (let k = k0; k <= k1; k++) {
      const py = r / 2 + k * h;
      const bRow = ((n - (((k % n) + n) % n)) % n) * n;
      for (let m = m0; m <= m1; m++) {
        const px = r / 2 + m * h;
        if (!pureAt(px, py)) continue;
        // The trial moved by -d is the pixel moved by +d.
        let holds = true;
        for (let q = 0; q < lands.length && holds; q++) holds = pureAt(px + lands[q][0], py + lands[q][1]);
        if (holds) counts[bRow + (n - (((m % n) + n) % n)) % n]++;
      }
    }
  }
}

/** scanShifts as the suite reads it: the counts of an n x n mesh of shifts, by the rectangles' own path or (`plain`) by the general test alone. */
export function shiftCounts(
  base: ImportedPlan, turn: number, r: number, n: number, sensor: SensorParams, lands: [number, number][] = [], plain = false,
): Float64Array {
  const counts = new Float64Array(n * n);
  scanShifts(base, turn, r, n, sensor, counts, lands, plain);
  return counts;
}

/**
 * Where on a lattice of size `r` a trial keeps the FEWEST pure pixels, turned
 * as it is: the shift to give it, east and north, within one pixel.
 *
 * For a lattice that falls anywhere (SensorParams.anyPosition). A trial read
 * from a file sits at some position on the lattice the page happens to draw,
 * which is no more the position an image will have than any other: the
 * satellites table counts it at its worst. By the stand-in (scanShifts) on a
 * mesh as fine as a tenth of the placement search's budget pays for, at most
 * sixteen a side; with a geolocation error, the fewest that hold within it,
 * which is what the table then leads with. [0, 0] when the budget pays for no
 * mesh at all (a fine grid under a very large trial).
 */
export function worstShift(plan: ImportedPlan, r: number, sensor: SensorParams, ce90 = 0): [number, number] {
  let area = 0;
  for (const p of plan.plots) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of p.rings) for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 > x0 && y1 > y0) area += (x1 - x0) * (y1 - y0);
  }
  if (!(r > 0) || !(area > 0)) return [0, 0];
  const lands = importedLandings(ce90, trialAngle(plan), plan.plotIds);
  const tries = 4_000_000 / Math.max(1, area / (r * r)) / (1 + lands.length / 2);
  const n = Math.min(16, Math.floor(Math.sqrt(tries)));
  if (!(n >= 2)) return [0, 0];
  const counts = new Float64Array(n * n);
  scanShifts(plan, 0, r, n, sensor, counts, lands);
  let worst = 0;
  for (let q = 1; q < counts.length; q++) if (counts[q] < counts[worst]) worst = q;
  return [((worst % n) * r) / n, (Math.floor(worst / n) * r) / n];
}

/**
 * The placement of an imported trial that keeps the most pure pixels on the
 * grid of size `r`: any angle to the pixel rows, any position.
 *
 * Turning a trial along the pixel rows is one candidate, not the answer. On
 * a real trial of 54 plots of 14.2 by 15.5 m at 2 m pixels, the trial along the
 * rows keeps 627 pure pixels at its best position, the trial as drawn 648, and
 * the same trial at 45 degrees 698: plots that are not a whole number of
 * pixels gain nothing from lying along them, and the comparison that only
 * offered "aligned" was offering the worst of the three.
 *
 * WHAT is counted is what the ladder leads with. With no geolocation error,
 * the pure pixels. With one (`ce90` metres, this size's own), the pure pixels
 * that hold wherever the image lands within it: a position tuned to a tenth
 * of a pixel is worth nothing under an image that lands a metre off, and a
 * placement chosen on the nominal count can lose pixels on the count the page
 * then judges it by.
 *
 * Two steps, because the engine is far too slow to ask about every placement
 * (about 10 ms each on that trial at 2 m, nine times that with a CE90, and
 * there are thousands):
 *
 *  1. scanShifts, the stand-in, at every degree and an n x n mesh of shifts,
 *     then a quarter of a degree apart and on a mesh twice as fine around the
 *     three best angles. On that trial it lands within 3 pixels of the
 *     engine's count at 20 and 45 degrees and reads 4 % high along the rows,
 *     where the engine's one weight per pixel shows; it runs at about 80
 *     million pixel centres a second. n comes from a budget of them, so a
 *     fine grid under a large trial is searched more coarsely.
 *  2. The ENGINE on the trial as drawn and on the best few of those. The
 *     count it gives is the one returned, and the one that decides: the
 *     stand-in never has the last word. The trial along the rows is one of
 *     them whenever it is anywhere near the best, since the stand-in flatters
 *     it.
 *
 * So the answer is never worse than the trial as drawn, whatever the stand-in
 * thought. A tie keeps the trial as drawn, then the stand-in's order, which
 * leaves a trial where it is when moving it gains nothing (every size at
 * which no pixel is pure, to begin with).
 *
 * `budget` is the pixels the engine may simulate in all. When it does not pay
 * for the trial as drawn and one other placement, or the stand-in cannot look
 * at every third degree, nothing is searched and the trial is returned as the
 * file has it, marked: a fine grid under a large trial with a CE90 set, where
 * each placement costs seconds to check.
 *
 * A GENERATOR, yielding between the stand-in's passes and after each placement
 * the engine is asked about, so that whoever drives it can hand the page back
 * in between: the whole search is two or three seconds at the sizes where it
 * is dearest, and no single slice of it is more than about half of one.
 */
function* searchSteps(
  base: ImportedPlan, r: number, sensor: SensorParams, ce90: number, budget: number,
): Generator<void, Placement, void> {
  const fileAngle = trialAngle(base);
  const ALL: [number, number, number, number] = [-Infinity, -Infinity, Infinity, Infinity];
  const at = (turn: number, shift: [number, number]): ImportedPlan => shiftImportedPlan(rotateImportedPlan(base, turn), shift[0], shift[1]);
  const angleOf = (turn: number) => (((fileAngle + turn) % 90) + 90) % 90;
  // How many landings a candidate costs; where they are follows each turn.
  const lands = importedLandings(ce90, fileAngle, base.plotIds);
  const score = (plan: ImportedPlan): number => (lands.length
    ? heldPixels(plan, r, sensor, ce90)
    : purePixels(plan, r, sensor, importedTrialExtent(plan, r, sensor, ALL)));
  const asDrawn = (): Placement => ({ turn: 0, shift: [0, 0], angle: angleOf(0), plan: base, pure: NaN, searched: false });
  const [b0, b1, b2, b3] = base.bbox;
  // Pixel centres one candidate looks at: the plots' own boxes, which a turn can double.
  let area = 0;
  for (const p of base.plots) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of p.rings) for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 > x0 && y1 > y0) area += (x1 - x0) * (y1 - y0);
  }
  const points = Math.max(1, (1.5 * area) / (r * r));
  // Shifts the stand-in may try in all: 40 million pixel centres, about half a
  // second. A pixel that passes is looked at again at every place the image
  // can land, which on a trial with many pure pixels is most of the work.
  const tries = 40_000_000 / points / (1 + lands.length / 2);
  // What a placement costs the engine: its pixels, once per simulation. The
  // trial as drawn is asked about first and is the dearest, a tilted trial's
  // box being mostly not trial; any other costs about its plots' own ground.
  // A wide blur costs more per pixel, by the area of its kernel: the budget is
  // counted in pixels under a blur of 1.4 pixels, whose window is 11 across.
  const reachPx = 2 * Math.ceil(3 * Math.max(sensor.sigmaX, sensor.sigmaY, 0)) + 1;
  const sims = (1 + lands.length) * Math.max(1, (reachPx * reachPx) / 121);
  const drawnCost = (Math.max(1, ((b2 - b0) / r + 6) * ((b3 - b1) / r + 6)) + 2 * base.plots.length) * sims;
  const otherCost = (points + 2 * base.plots.length) * sims;
  const afford = Math.min(lands.length ? 6 : 10, 1 + Math.floor((budget - drawnCost) / otherCost));
  if (tries < 42 || afford < 2) return asDrawn();
  // Every degree, then a quarter of a degree around the best three on a mesh
  // twice as fine: 90 n^2 + 24 (2n)^2 shifts. With too little for that even at
  // n = 1, every third degree and half a degree around the best two.
  const wide = tries >= 186;
  const n = wide ? Math.max(1, Math.min(8, Math.floor(Math.sqrt(tries / 186)))) : 1;
  /** The stand-in's best shift at one angle, on a mesh of m x m. */
  const scan = (angle: number, m: number): { angle: number; turn: number; shift: [number, number]; guess: number } => {
    const turn = nearestTurn(fileAngle, angle);
    const counts = new Float64Array(m * m);
    scanShifts(base, turn, r, m, sensor, counts, lands.length ? importedLandings(ce90, fileAngle + turn, base.plotIds) : lands);
    // The position that keeps the most on a lattice that is known. On one that
    // falls anywhere an angle is worth what its worst position keeps, and the
    // angles are then ranked by that: the angle is still the planter's to choose.
    let best = 0;
    for (let q = 1; q < counts.length; q++) if (keepsCount(sensor, counts[q], counts[best])) best = q;
    return { angle, turn, shift: [((best % m) * r) / m, (Math.floor(best / m) * r) / m], guess: counts[best] };
  };
  const apart = (p: number, q: number) => Math.min(Math.abs(p - q), 90 - Math.abs(p - q));
  const scanned = new Map<number, ReturnType<typeof scan>>();
  for (let a = 0; a < 90; a += wide ? 1 : 3) {
    scanned.set(a, scan(a, n));
    if (a % 30 === 29 || (!wide && a % 30 === 27)) yield;
  }
  // The best angles of the first pass, no two of them the same peak.
  const peaks: number[] = [];
  for (const c of [...scanned.values()].sort((p, q) => q.guess - p.guess || p.angle - q.angle)) {
    if (peaks.length >= (wide ? 3 : 2) || !(c.guess > 0)) break;
    if (!peaks.some(a => apart(a, c.angle) < 2)) peaks.push(c.angle);
  }
  const fine = wide ? 0.25 : 0.5, reach = wide ? 4 : 3, mesh = wide ? Math.min(16, 2 * n) : 1;
  for (const peak of peaks) {
    for (let q = -reach; q <= reach; q++) {
      const a = (((peak + q * fine) % 90) + 90) % 90;
      // The peak itself again too, on the finer mesh: a narrow best shift falls between the points of the coarse one.
      if (q === 0 || !scanned.has(a)) scanned.set(a, scan(a, mesh));
    }
    yield;
  }
  const ranked = [...scanned.values()].sort((p, q) => q.guess - p.guess || p.angle - q.angle);

  // The engine's turn. As drawn always; then the stand-in's best, no two
  // within half a degree of each other and none it found nothing at, for as
  // many as the budget pays.
  // (On a lattice that falls anywhere the trial as drawn is asked about at its
  // own worst position, like every other angle: where the file happens to put
  // it on the lattice is no more its place than any other.)
  // On the mesh the best angles were looked at again with: a coarser one would
  // find it a shallower worst than theirs, and the trial as drawn would be
  // flattered against them.
  const drawn = sensor.anyPosition ? scan(angleOf(0), Math.max(n, mesh)) : null;
  const asked: { turn: number; shift: [number, number] }[] = [{ turn: 0, shift: drawn ? drawn.shift : [0, 0] }];
  const taken: number[] = [];
  for (const c of ranked) {
    if (asked.length >= afford || !(c.guess > 0)) break;
    if (taken.some(a => apart(a, c.angle) < 0.5)) continue;
    taken.push(c.angle);
    asked.push({ turn: c.turn, shift: c.shift });
  }
  let won: Placement | null = null;
  for (let q = 0; q < asked.length; q++) {
    const c = asked[q];
    const plan = c.turn === 0 && c.shift[0] === 0 && c.shift[1] === 0 ? base : at(c.turn, c.shift);
    const pure = score(plan);
    if (!won || pure > won.pure) won = { turn: c.turn, shift: c.shift, angle: angleOf(c.turn), plan, pure, searched: true };
    if (q < asked.length - 1) yield;
  }
  return won!;
}

/** A search for a trial's best placement, to be run a step at a time or all at once. */
export interface PlacementSearch {
  /** The placement, once the search is over. */
  found: Placement | null;
  /** One more slice of the search. True when it is over. */
  step: () => boolean;
}

/**
 * Searches kept by what they were asked: the trial as the file has it, the
 * pixel size, the sensor and the CE90. The answer does not depend on where
 * the trial currently sits, and adopting a placement rebuilds every rung of
 * the ladder, so without this each click on the best placement paid for the
 * nine searches again. Bounded, oldest first out.
 */
const searches = new Map<string, PlacementSearch>();
const SEARCHES_MAX = 48;
/** The pixels the engine may simulate for one search: two to three seconds in all. */
const SEARCH_BUDGET = 1_200_000;

export function placementSearch(
  base: ImportedPlan, r: number, sensor: SensorParams, ce90 = 0, budget = SEARCH_BUDGET,
): PlacementSearch {
  const key = `${base.sig}|${r}|${sensor.sigmaX}|${sensor.sigmaY}|${sensor.offX ?? 0}|${sensor.offY ?? 0}|${sensor.mixThreshold}|${ce90}|${budget}|${sensor.anyPosition ? 1 : 0}`;
  const kept = searches.get(key);
  if (kept) return kept;
  const steps = searchSteps(base, r, sensor, ce90, budget);
  const search: PlacementSearch = {
    found: null,
    step: () => {
      if (search.found) return true;
      const next = steps.next();
      if (next.done) search.found = next.value;
      return !!next.done;
    },
  };
  if (searches.size >= SEARCHES_MAX) searches.delete(searches.keys().next().value as string);
  searches.set(key, search);
  return search;
}

/** The search run to its end: see searchSteps. */
export function bestPlacement(
  base: ImportedPlan, r: number, sensor: SensorParams, ce90 = 0, budget = SEARCH_BUDGET,
): Placement {
  const search = placementSearch(base, r, sensor, ce90, budget);
  while (!search.step()) { /* every slice, one after the other */ }
  return search.found!;
}
