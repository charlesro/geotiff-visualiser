import {
  blockPlacement, buildBlockPlan, fieldVerdicts, fineCellsPerPixel, stakeBlockPlan,
  type BlockDesign, type BlockPlan, type SensorParams, type SimLayout,
} from './simulate';
import { ce90Shifts, heldMask, plotTally } from './resolving';
import { trialExtent } from './ladder';
import type { S2Grid } from './s2-grid';

/**
 * The smallest block trial that gives every micro-plot the pixels asked for.
 *
 * The agronomist says how many species, how many repetitions, how many pixels
 * a micro-plot must keep and which satellite will look at it; this works out
 * the plot size and the arrangement, laid along the pixel rows.
 *
 * WHY THE PLOTS COME OUT AS THEY DO. A pixel is pure when its plot holds
 * enough of its signal, and everything outside the plot is foreign alike: an
 * alley, another plot, the ground beyond the trial. So a plot's pure pixels
 * depend on its own size and on where it sits against the pixel lattice, and
 * on nothing else. Two things follow, and the whole search rests on them:
 *
 *  - A plot and its alley together are made a WHOLE NUMBER OF PIXELS, both
 *    ways. Every plot then sits against the lattice exactly as its neighbour
 *    does and keeps exactly as many pixels. With any other pitch the plots
 *    drift across the lattice, the worst-placed one sets the size of all of
 *    them, and the trial is larger for the same count.
 *  - One plot therefore stands for all of them.
 *
 * HOW A PLOT IS COUNTED. Along the pixel rows a plot is a rectangle and the
 * blur is one Gaussian per axis, so the share of a pixel's signal that its
 * plot holds is the product of two shares, one per axis (`axisShares`). That
 * is the engine's own sum, factorised: the same fine cells, the same weights,
 * the same window. It costs a few hundred additions where a simulation costs
 * milliseconds, which is what lets every plot shape be tried. It is not what
 * decides, though: the plot the search settles on is then counted by the
 * engine itself (`plotPixels`), staked as the page stakes it, and a plot the
 * engine counts short is dropped and the search goes on.
 *
 * The alleys are part of what is asked, and the page asks for none unless the
 * reader types some: an alley takes ground and gives no pixel, so the smallest
 * trial has its plots touching. Whatever is asked is kept, with one exception:
 * the block alley when blocks are stacked in several rows, which has to differ
 * from the plot alley by a whole number of pixels for the rows to stay in
 * step; it is then widened to the next such width, never narrowed.
 *
 * WHAT IS COUNTED is the page's own figure: a plot's pure pixels, or, with a
 * geolocation error, its pixels that stay pure for that plot wherever the
 * image lands within the CE90 (robustMask's set, the one the satellites table
 * prints per plot).
 */

/** What is asked of the trial. */
export interface SuggestRequest {
  /** Species in a block, and blocks: a repetition is a block. */
  nSpecies: number;
  nBlocks: number;
  /** Pixels every micro-plot must keep. */
  pixels: number;
  /** The satellite: its pixel size in metres and its blur in pixels. */
  res: number;
  sigmaX: number;
  sigmaY: number;
  /** The purity threshold, 0 to 1. */
  threshold: number;
  /** The geolocation error to hold against, in metres; 0 to count pure pixels with the image in place. */
  ce90M: number;
  /** The alleys asked for, in metres (0 for plots that touch): kept, see above. */
  plotAlley: number;
  blockAlley: number;
  /** The field's extent along the pixel rows and across them, in metres: an arrangement that fits it is preferred. */
  field?: { u: number; v: number } | null;
  /**
   * Phases the page's staking tries per axis on this field (stakeMesh). The
   * plot is counted at the phase that mesh finds, since that is where the
   * trial will be put. 6, the finest, when not given.
   */
  stakeSteps?: number;
  /** The randomisation the design already has. */
  seed?: number;
}

/** A trial that meets the request. */
export interface Suggestion {
  design: BlockDesign;
  /** A plot and its alley, in pixels, along a block and across it. */
  pitchPx: [number, number];
  /** The fewest pixels a plot keeps, by the engine: pure, and within the CE90 (null with no geolocation error). */
  pure: number;
  held: number | null;
  /** The trial's footprint in metres, along the pixel rows and across them. */
  footprint: [number, number];
  /** Whether that fits the field given; null when none was. */
  fits: boolean | null;
  /** True when the block alley was widened to keep the rows of blocks in step. */
  alleyWidened: boolean;
}

/** Largest plot the design fields accept, in metres, and the longest a plot may be for its width. */
const MAX_PLOT_M = 1000;
const MAX_ASPECT = 4;

/** A dimension as the design fields hold it: to the centimetre, so that a pitch of whole pixels survives the form. */
const cm = (m: number): number => Math.round(m * 100) / 100;

/**
 * The fewest pixels a plot of this design keeps, by the engine: pure, and (with
 * a geolocation error) pure for the same plot wherever the image lands within
 * it. The trial is staked as the page stakes it, alone on open ground: a field
 * that cuts it is the caller's to check. `steps` is the staking mesh of the
 * field the trial is meant for (stakeMesh), the finest when not given.
 */
export function plotPixels(
  design: BlockDesign, res: number, sensor: SensorParams, ce90M: number, steps = 6,
): { pure: number; held: number | null } {
  const flat = buildBlockPlan(design, { centerU: 0, centerV: 0 });
  // Open ground around the trial, on the lattice: what a pixel's kernel reaches, the shift, and two pixels more.
  const reach = (Math.ceil(3 * Math.max(sensor.sigmaX, sensor.sigmaY, 0)) + 2) * res + Math.max(0, ce90M);
  const half = (side: number) => Math.ceil((side / 2 + reach) / res) * res;
  const hu = half(flat.totalU), hv = half(flat.totalV);
  const extent: [number, number, number, number] = [-hu, -hv, hu, hv];
  const origin: [number, number] = [0, 0];
  const plan = stakeBlockPlan(design, blockPlacement(extent, origin, 0, res, true), origin, 0, res, sensor, extent, steps).plan;
  const layout: SimLayout = { pattern: 'block', width: 2, spacing: 0, rotationDeg: 0, block: plan };
  const [e0, n0, e1, n1] = trialExtent(plan, origin, 0, res, sensor, extent);
  const box = { res, utmBounds: [e0, n0, e1, n1] } as unknown as S2Grid;
  const nominal = fieldVerdicts(box, origin, layout, sensor);
  const pure = plotTally(nominal, plan.nPlots)?.min ?? 0;
  if (!(ce90M > 0)) return { pure, held: null };
  // Half the short side of a plot carries its centre line onto its edge: nothing holds.
  if (ce90M >= Math.min(design.plotLength, design.plotWidth) / 2) return { pure, held: 0 };
  const lands = ce90Shifts(ce90M);
  const mask = heldMask(nominal, lands.length, (q, need) => fieldVerdicts(box, [-lands[q][0], -lands[q][1]], layout, sensor, need));
  return { pure, held: plotTally(nominal, plan.nPlots, mask)?.min ?? 0 };
}

/** The block alley that keeps stacked rows of blocks in step with the pixels: the plot alley plus whole pixels, never under the alley asked for. */
export function alleyInStep(plotAlley: number, blockAlley: number, res: number): number {
  if (!(blockAlley > plotAlley)) return plotAlley;
  return cm(plotAlley + Math.ceil((blockAlley - plotAlley) / res - 1e-9) * res);
}

/**
 * One axis of a plot against the pixel lattice: for each pixel from `lo` to
 * `hi`, the share of its signal, along this axis, that the plot holds.
 *
 * The plot covers [start, start + len) on an axis whose pixel k is
 * [k res, (k + 1) res). A pixel is sampled on `g` fine cells, a cell being in
 * the plot when its centre is, and the pixel's signal is the Gaussian-weighted
 * sum of its neighbours' within ceil(3 sigma) pixels: the engine's own phase 1
 * and phase 2, for one axis. The share of a pixel in two dimensions is the
 * product of its two axes' shares.
 */
export function axisShares(
  start: number, len: number, res: number, g: number, sigma: number, lo: number, hi: number,
): Float64Array {
  const win = Math.max(0, Math.ceil(3 * sigma));
  const s = sigma || 0.5;
  const inPlot = (k: number): number => {
    let c = 0;
    for (let q = 0; q < g; q++) { const x = (k + (q + 0.5) / g) * res; if (x >= start && x < start + len) c++; }
    return c;
  };
  const cells = new Float64Array(hi - lo + 1 + 2 * win);
  for (let k = lo - win; k <= hi + win; k++) cells[k - lo + win] = inPlot(k);
  let total = 0;
  const w = new Float64Array(2 * win + 1);
  for (let d = -win; d <= win; d++) { w[d + win] = Math.exp(-0.5 * (d / s) ** 2); total += w[d + win]; }
  const out = new Float64Array(hi - lo + 1);
  for (let k = lo; k <= hi; k++) {
    let own = 0;
    for (let d = -win; d <= win; d++) own += cells[k + d - lo + win] * w[d + win];
    out[k - lo] = own / (g * total);
  }
  return out;
}

/**
 * The pixels one plot keeps, by the factorised count: staked on a mesh of
 * `steps` phases per axis as stakeBlockPlan does it (the phase with the most
 * pure pixels, the first of equals), and at that phase the pure pixels and the
 * ones that hold wherever the image lands within the CE90.
 */
export function plotCount(
  length: number, width: number, res: number, g: number, sensor: SensorParams, ce90M: number, steps: number,
): { pure: number; held: number | null } {
  const tau = sensor.mixThreshold;
  const shift = Math.max(0, ce90M);
  // Pixels that can see the plot at any phase and any landing, per axis.
  const lo = Math.floor(-shift / res) - 1;
  const hiU = Math.ceil((res + length + shift) / res), hiV = Math.ceil((res + width + shift) / res);
  const along = (start: number) => axisShares(start, length, res, g, sensor.sigmaX, lo, hiU);
  const across = (start: number) => axisShares(start, width, res, g, sensor.sigmaY, lo, hiV);
  const n = Math.max(1, Math.floor(steps));
  const U: Float64Array[] = [], V: Float64Array[] = [];
  for (let i = 0; i < n; i++) { U.push(along((i * res) / n)); V.push(across((i * res) / n)); }
  const pureAt = (a: Float64Array, b: Float64Array): number => {
    let c = 0;
    for (let j = 0; j < b.length; j++) { if (!(b[j] > 0)) continue; for (let i = 0; i < a.length; i++) if (a[i] * b[j] >= tau) c++; }
    return c;
  };
  let bi = 0, bj = 0, pure = -1;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const c = pureAt(U[i], V[j]); if (c > pure) { pure = c; bi = i; bj = j; } }
  if (!(shift > 0)) return { pure, held: null };
  if (shift >= Math.min(length, width) / 2) return { pure, held: 0 };
  // The image lands (dx, dy) away: the plot is that far the other way under a lattice that has not moved.
  const lands = ce90Shifts(shift);
  const a0 = U[bi], b0 = V[bj];
  const As = lands.map(([dx]) => along((bi * res) / n - dx)), Bs = lands.map(([, dy]) => across((bj * res) / n - dy));
  let held = 0;
  for (let j = 0; j < b0.length; j++) {
    for (let i = 0; i < a0.length; i++) {
      if (!(a0[i] * b0[j] >= tau)) continue;
      let ok = true;
      for (let q = 0; q < lands.length && ok; q++) ok = As[q][i] * Bs[q][j] >= tau;
      if (ok) held++;
    }
  }
  return { pure, held };
}

/**
 * The plot, as pitches of whole pixels (pu along a block, pv across it), with
 * the smallest area that keeps the pixels asked for, counted by the engine.
 * Null when no plot within the design's limits does.
 */
function smallestPlot(
  req: SuggestRequest, blockAlley: number,
): { pu: number; pv: number; pure: number; held: number | null } | null {
  const { res, pixels, plotAlley, ce90M } = req;
  const steps = req.stakeSteps ?? 6;
  const sensor: SensorParams = { sigmaX: req.sigmaX, sigmaY: req.sigmaY, mixThreshold: req.threshold };
  const cap = Math.floor(MAX_PLOT_M / res);
  // The smallest pitch that leaves any plot at all beside its alley.
  const lowU = Math.floor(blockAlley / res + 1e-9) + 1, lowV = Math.floor(plotAlley / res + 1e-9) + 1;
  /** The two plots that stand for all of them, at a pitch. */
  const mini = (pu: number, pv: number): BlockDesign => ({
    nSpecies: 2, nBlocks: 1, blocksPerRow: 1, seed: 1,
    plotLength: cm(pu * res - blockAlley), plotWidth: cm(pv * res - plotAlley), plotAlley, blockAlley,
  });
  const seen = new Map<number, number>();
  /** Pitches the engine counted short of what the factorised count promised. */
  const refused = new Set<number>();
  const key = (pu: number, pv: number) => pu * 100_000 + pv;
  const got = (pu: number, pv: number): number => {
    if (refused.has(key(pu, pv))) return -1;
    let c = seen.get(key(pu, pv));
    if (c === undefined) {
      const d = mini(pu, pv);
      const g = fineCellsPerPixel(res, { pattern: 'block', width: 2, spacing: 0, rotationDeg: 0, block: { design: d } as BlockPlan });
      const r = plotCount(d.plotLength, d.plotWidth, res, g, sensor, ce90M, steps);
      c = r.held ?? r.pure;
      seen.set(key(pu, pv), c);
    }
    return c;
  };
  const enough = (pu: number, pv: number) => got(pu, pv) >= pixels;

  for (let attempt = 0; attempt < 12; attempt++) {
    // A square pitch first: it is at or near the smallest, and it bounds the search.
    let p = Math.max(lowU, lowV, Math.ceil(Math.sqrt(pixels)));
    while (p <= cap && !enough(p, p)) p++;
    if (p > cap) return null;
    let best = { pu: p, pv: p };
    const area = () => best.pu * best.pv;
    // Then every other shape, no longer than MAX_ASPECT times its width: for each
    // length, the narrowest plot that is enough, found by halving (a wider plot
    // never keeps fewer pixels).
    const to = Math.min(cap, p * MAX_ASPECT);
    for (let pu = lowU; pu <= to; pu++) {
      let lo = Math.max(lowV, Math.ceil(pu / MAX_ASPECT)), hi = Math.min(cap, pu * MAX_ASPECT, Math.floor(area() / pu));
      if (hi < lo || !enough(pu, hi)) continue;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (enough(pu, mid)) hi = mid; else lo = mid + 1;
      }
      const smaller = pu * hi < area(), squarer = pu * hi === area() && Math.abs(pu - hi) < Math.abs(best.pu - best.pv);
      if (smaller || squarer) best = { pu, pv: hi };
    }
    // The engine has the last word, on the two plots themselves.
    const counted = plotPixels(mini(best.pu, best.pv), res, sensor, ce90M, steps);
    if ((counted.held ?? counted.pure) >= pixels) return { ...best, ...counted };
    refused.add(key(best.pu, best.pv));
  }
  return null;
}

/**
 * The trial: the smallest plot that keeps the pixels asked for, and the
 * arrangement of its blocks that fits the field if one does and is the most
 * compact. Null when no plot within the design's limits keeps that many pixels.
 */
export function suggestBlockDesign(req: SuggestRequest): Suggestion | null {
  const nSpecies = Math.max(2, Math.min(8, Math.round(req.nSpecies)));
  const nBlocks = Math.max(1, Math.min(20, Math.round(req.nBlocks)));
  const pixels = Math.max(1, Math.round(req.pixels));
  const { res } = req;
  if (!(res > 0) || !(req.threshold > 0) || !(req.sigmaX >= 0) || !(req.sigmaY >= 0)) return null;
  const plotAlley = Math.max(0, req.plotAlley), asked = Math.max(0, req.blockAlley);
  const ask: SuggestRequest = { ...req, nSpecies, nBlocks, pixels, plotAlley, blockAlley: asked };

  // One row of blocks keeps the block alley as it is; several rows need it in
  // step with the pixels. The plot is searched once for each alley that occurs.
  const stacked = alleyInStep(plotAlley, asked, res);
  const plots = new Map<number, ReturnType<typeof smallestPlot>>();
  const plotFor = (blockAlley: number) => {
    if (!plots.has(blockAlley)) plots.set(blockAlley, smallestPlot(ask, blockAlley));
    return plots.get(blockAlley)!;
  };

  const found: (Suggestion & { side: number; ground: number })[] = [];
  for (let perRow = 1; perRow <= nBlocks; perRow++) {
    const rows = Math.ceil(nBlocks / perRow);
    // The same rows with fewer blocks in each is the same trial, narrower: skip the wider spelling.
    if (perRow > 1 && Math.ceil(nBlocks / (perRow - 1)) === rows) continue;
    const blockAlley = rows > 1 ? stacked : asked;
    const plot = plotFor(blockAlley);
    if (!plot) continue;
    const design: BlockDesign = {
      nSpecies, nBlocks, blocksPerRow: perRow, seed: req.seed ?? 1,
      plotLength: cm(plot.pu * res - blockAlley), plotWidth: cm(plot.pv * res - plotAlley), plotAlley, blockAlley,
    };
    const plan = buildBlockPlan(design, { centerU: 0, centerV: 0 });
    found.push({
      design, pitchPx: [plot.pu, plot.pv], pure: plot.pure, held: plot.held,
      footprint: [cm(plan.totalU), cm(plan.totalV)],
      fits: req.field ? plan.totalU <= req.field.u + 1e-6 && plan.totalV <= req.field.v + 1e-6 : null,
      alleyWidened: blockAlley > asked + 1e-9,
      side: Math.max(plan.totalU, plan.totalV), ground: plan.totalU * plan.totalV,
    });
  }
  if (!found.length) return null;
  // An arrangement that fits the field before one that does not. Among those,
  // the most compact: the one whose longer side is shortest, since the ground
  // they take differs only by an alley or two and a trial 13 m by 230 m is no
  // one's idea of the best. Sides within a twentieth are the same; then less ground.
  const pool = found.some(c => c.fits) ? found.filter(c => c.fits) : found;
  const shortest = Math.min(...pool.map(c => c.side));
  const best = pool.filter(c => c.side <= shortest * 1.05).reduce((a, c) => (c.ground < a.ground ? c : a));
  const { side: _side, ground: _ground, ...out } = best;
  void _side; void _ground;
  return out;
}
