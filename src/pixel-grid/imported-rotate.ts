import type { ImportedPlan } from './imported-types';
import { coverStats, simulateField, speciesChannel, type SensorParams } from './simulate';
import type { S2Grid } from './s2-grid';
import { fieldOverlapTest } from './geometry';
import { importedTrialExtent } from './ladder';

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
export const isAligned = (angle: number): boolean => {
  const a = ((angle % 90) + 90) % 90;
  return Math.min(a, 90 - a) < 1e-6;
};

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
  const sim = simulateField({ res: r, utmBounds: [e0, n0, e1, n1] } as unknown as S2Grid, [0, 0], layout, sensor);
  const nx = Math.round((e1 - e0) / r);
  const overlaps = fieldOverlapTest(plan.footprint);
  const keep: number[] = [];
  for (let k = 0; k < sim.mixed.length; k++) {
    if (overlaps(e0 + (k % nx) * r, n0 + Math.floor(k / nx) * r, r)) keep.push(k);
  }
  const mixed = Uint8Array.from(keep, k => sim.mixed[k]);
  const off = sim.proportionOffTrial ? Float32Array.from(keep, k => sim.proportionOffTrial![k]) : null;
  return coverStats({ mixed, coverSpecies: speciesChannel(layout).coverSpecies, nSpecies: sim.nSpecies, offTrial: off }).pureCrop;
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
  const perCandidate = pixels + 2 * plan.plots.length;
  const n = Math.max(1, Math.min(10, Math.floor(Math.sqrt(budget / perCandidate))));
  // A trial too big for one call to fit the budget leaves N at 1, and a 1 x 1
  // search offers only the trial where it stands: counting its pure pixels
  // decides nothing, and the count is never read again. Simulating it anyway
  // cost the whole trial (1.6 s of blocked main thread at 0.5 m on a 2000-plot
  // import), so the budget bounded the number of shifts but not the work. It
  // bounds the work now: no shift to choose, no simulation. `staked: false` is
  // what stops that being silent.
  if (n === 1) return { plan, shift: [0, 0], staked: false };
  let best = plan, bestShift: [number, number] = [0, 0], bestCount = -1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // The shift is returned rather than read back off the result: recovering
      // it from a bbox of six-figure eastings loses its last digits, and the
      // page saves this number and rebuilds the trial from it.
      const shift: [number, number] = [(i * r) / n, (j * r) / n];
      const candidate = shiftImportedPlan(plan, shift[0], shift[1]);
      const count = purePixels(candidate, r, sensor, extent);
      if (count > bestCount) { bestCount = count; best = candidate; bestShift = shift; }
    }
  }
  return { plan: best, shift: bestShift, staked: true };
}
