import {
  bestPhaseOffset, blockPlacement, buildBlockPlan, fieldVerdicts, fineCellsPerPixel, stakeBlockPlan,
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
   * Whether a trial of that footprint fits the field, for a field that is not
   * a box: its outline decides then, not its extent (trial-seat.ts).
   */
  fitsField?: (u: number, v: number) => boolean;
  /**
   * Phases the page's staking tries per axis on this field (stakeMesh). The
   * plot is counted at the phase that mesh finds, since that is where the
   * trial will be put. 6, the finest, when not given.
   */
  stakeSteps?: number;
  /** The randomisation the design already has. */
  seed?: number;
  /**
   * The trial's angle to the pixel rows, in degrees: 0, or none, for a trial
   * laid along them. A turned trial is sized on `countAt`, see suggestTurned.
   */
  rotationDeg?: number;
  /**
   * The fewest pixels a plot of this design keeps, turned, where the page will
   * put it: the satellites table's own count (ladder-step blockPlotCounts).
   * Null for a trial the table does not count plot by plot.
   */
  countAt?: (design: BlockDesign) => { pure: number; held: number | null } | null;
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
  /** The angle it was built at, in degrees: 0 along the pixel rows. */
  angle: number;
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

/** Arrangements worth telling apart: the same rows with fewer blocks in each is the same trial, narrower. */
function rowsOf(nBlocks: number): number[] {
  const out: number[] = [];
  for (let perRow = 1; perRow <= nBlocks; perRow++) {
    if (perRow > 1 && Math.ceil(nBlocks / (perRow - 1)) === Math.ceil(nBlocks / perRow)) continue;
    out.push(perRow);
  }
  return out;
}

/** Whether a footprint fits the field given, turned by `deg`; null when no field was given. */
function fitsGiven(req: SuggestRequest, u: number, v: number, deg: number): boolean | null {
  if (req.fitsField) return req.fitsField(u, v);
  if (!req.field) return null;
  // A field given by its extent is a box, and a turned rectangle is in a box when its own box is.
  const t = (deg * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  return u * c + v * s <= req.field.u + 1e-6 && u * s + v * c <= req.field.v + 1e-6;
}

/**
 * Of several arrangements, the one to build. One that fits the field before
 * one that does not. Among those, the most compact: the one whose longer side
 * is shortest, since the ground they take differs only by an alley or two and
 * a trial 13 m by 230 m is no one's idea of the best. Sides within a twentieth
 * are the same; then less ground.
 */
function mostCompact<T extends { fits: boolean | null; side: number; ground: number }>(found: T[]): T {
  const pool = found.some(c => c.fits) ? found.filter(c => c.fits) : found;
  const shortest = Math.min(...pool.map(c => c.side));
  return pool.filter(c => c.side <= shortest * 1.05).reduce((a, c) => (c.ground < a.ground ? c : a));
}

/**
 * The largest plots a block trial can have in a field: the design's own plot,
 * scaled, in the arrangement of blocks that lets it grow the most. `fits` says
 * whether a trial of a given footprint fits the field. Null when the trial does
 * not fit at any size.
 *
 * It answers "the most pure pixels this parcel can give": a plot keeps more
 * pixels the larger it is, so the largest plots that fit are the ones that keep
 * the most ("add an option to have the max amount of pure pixels given the
 * parcel", 2026-11-21). The species, the blocks, the alleys and the plot's
 * shape are the design's; only the size and the blocks per row are searched.
 */
export function largestPlots(
  design: BlockDesign, fits: (u: number, v: number) => boolean,
): { scale: number; perRow: number; footprint: [number, number] } | null {
  const nBlocks = Math.max(1, Math.round(design.nBlocks));
  const own = Math.max(1, Math.min(nBlocks, Math.round(design.blocksPerRow) || 1));
  const sized = (perRow: number, scale: number) => {
    const plan = buildBlockPlan({ ...design, blocksPerRow: perRow, plotLength: design.plotLength * scale, plotWidth: design.plotWidth * scale }, { centerU: 0, centerV: 0 });
    return [plan.totalU, plan.totalV] as [number, number];
  };
  // The design's own arrangement first: it is kept when another does no better.
  const ways = [own, ...rowsOf(nBlocks).filter(q => q !== own)];
  const longest = Math.max(design.plotLength, design.plotWidth), shortest = Math.min(design.plotLength, design.plotWidth);
  if (!(shortest > 0)) return null;
  let best: { scale: number; perRow: number; footprint: [number, number] } | null = null;
  for (const perRow of ways) {
    const ok = (scale: number) => { const [u, v] = sized(perRow, scale); return fits(u, v); };
    // Between the smallest plot the design fields take and the largest.
    let lo = 0.5 / shortest, hi = MAX_PLOT_M / longest;
    if (!(hi > lo) || !ok(lo)) continue;
    if (ok(hi)) lo = hi;
    else for (let it = 0; it < 22; it++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
    if (!best || lo > best.scale * 1.005) best = { scale: lo, perRow, footprint: sized(perRow, lo) };
  }
  return best;
}

/** A turned plot's pitch is tried by half pixels, up to this many pixels over the plot the pixel rows would need. */
const TURNED_STEP = 0.5;
const TURNED_REACH = 14;

/**
 * A trial TURNED from the pixel rows.
 *
 * Nothing of what makes the trial along the rows cheap to size holds here. A
 * plot's edges cross the pixels at an angle, so no pitch puts every plot the
 * same way on the lattice: each plot lies its own way, keeps its own count,
 * and the worst-placed one decides. No plot stands for the others and no axis
 * can be counted alone. So the whole trial is counted, by the engine, where
 * the page will put it (`countAt`, the satellites table's own per-plot count),
 * for every size tried.
 *
 * That count is paid for with a narrower search. Plots are tried square first,
 * from the size the pixel rows would need upwards by half pixels, a square
 * being the least ground for a margin lost all round; then a few rectangles a
 * little smaller than the square found. The arrangement is chosen as it is
 * along the rows, by the footprint, and since the count depends on the
 * arrangement the size is searched again when the size found changes it.
 *
 * The alleys are kept as asked: there is no step with the pixels to keep.
 */
function suggestTurned(ask: SuggestRequest, nSpecies: number, nBlocks: number, pixels: number, deg: number): Suggestion | null {
  const { res, plotAlley, blockAlley, countAt } = ask;
  if (!countAt) return null;
  const along = smallestPlot(ask, blockAlley);
  if (!along) return null;
  const design = (perRow: number, pu: number, pv: number): BlockDesign => ({
    nSpecies, nBlocks, blocksPerRow: perRow, seed: ask.seed ?? 1,
    plotLength: cm(pu * res - blockAlley), plotWidth: cm(pv * res - plotAlley), plotAlley, blockAlley,
  });
  const arrange = (pu: number, pv: number) => mostCompact(rowsOf(nBlocks).map(perRow => {
    const plan = buildBlockPlan(design(perRow, pu, pv), { centerU: 0, centerV: 0 });
    return { perRow, fits: fitsGiven(ask, plan.totalU, plan.totalV, deg), side: Math.max(plan.totalU, plan.totalV), ground: plan.totalU * plan.totalV };
  })).perRow;

  const half = (p: number) => Math.round(p / TURNED_STEP) * TURNED_STEP;
  const lowU = half(Math.floor(blockAlley / res / TURNED_STEP + 1e-9) * TURNED_STEP + TURNED_STEP);
  const lowV = half(Math.floor(plotAlley / res / TURNED_STEP + 1e-9) * TURNED_STEP + TURNED_STEP);
  const cap = Math.floor(MAX_PLOT_M / res);
  const start = Math.max(lowU, lowV, half(Math.floor(Math.sqrt(along.pu * along.pv) / TURNED_STEP) * TURNED_STEP));
  const counted = new Map<string, { pure: number; held: number | null } | null>();
  const count = (perRow: number, pu: number, pv: number) => {
    const key = `${perRow}|${pu}|${pv}`;
    if (!counted.has(key)) counted.set(key, pu >= lowU && pv >= lowV && pu <= cap && pv <= cap ? countAt(design(perRow, pu, pv)) : null);
    return counted.get(key)!;
  };
  const enough = (perRow: number, pu: number, pv: number) => { const c = count(perRow, pu, pv); return !!c && (c.held ?? c.pure) >= pixels; };
  const search = (perRow: number): { pu: number; pv: number } | null => {
    let p = start;
    const top = Math.min(cap, start + TURNED_REACH);
    while (p <= top && !enough(perRow, p, p)) p = half(p + TURNED_STEP);
    if (p > top) return null;
    // The first square tried may not be the smallest that does.
    while (p - TURNED_STEP >= Math.max(lowU, lowV) && enough(perRow, half(p - TURNED_STEP), half(p - TURNED_STEP))) p = half(p - TURNED_STEP);
    // Rectangles of less ground than that square, the smallest first, either way round.
    const shapes: [number, number][] = [[-1, 0.5], [-0.5, 0], [-1, 1], [-0.5, 0.5]];
    for (const [a, b] of shapes) {
      for (const [pu, pv] of [[half(p + a), half(p + b)], [half(p + b), half(p + a)]] as [number, number][]) {
        if (Math.max(pu, pv) <= MAX_ASPECT * Math.min(pu, pv) && enough(perRow, pu, pv)) return { pu, pv };
      }
    }
    return { pu: p, pv: p };
  };

  let perRow = arrange(start + 1.5, start + 1.5);
  let plot = search(perRow);
  if (!plot) return null;
  const again = arrange(plot.pu, plot.pv);
  if (again !== perRow) {
    const other = search(again);
    if (other) { perRow = again; plot = other; }
  }
  const built = design(perRow, plot.pu, plot.pv);
  const plan = buildBlockPlan(built, { centerU: 0, centerV: 0 });
  const c = count(perRow, plot.pu, plot.pv)!;
  return {
    design: built, pitchPx: [plot.pu, plot.pv], pure: c.pure, held: c.held,
    footprint: [cm(plan.totalU), cm(plan.totalV)],
    fits: fitsGiven(ask, plan.totalU, plan.totalV, deg),
    alleyWidened: false, angle: deg,
  };
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
  const deg = Number.isFinite(req.rotationDeg) ? (req.rotationDeg as number) : 0;
  if (Math.abs(deg) > 1e-9) return suggestTurned(ask, nSpecies, nBlocks, pixels, deg);

  // One row of blocks keeps the block alley as it is; several rows need it in
  // step with the pixels. The plot is searched once for each alley that occurs.
  const stacked = alleyInStep(plotAlley, asked, res);
  const plots = new Map<number, ReturnType<typeof smallestPlot>>();
  const plotFor = (blockAlley: number) => {
    if (!plots.has(blockAlley)) plots.set(blockAlley, smallestPlot(ask, blockAlley));
    return plots.get(blockAlley)!;
  };

  const found: (Suggestion & { side: number; ground: number })[] = [];
  for (const perRow of rowsOf(nBlocks)) {
    const rows = Math.ceil(nBlocks / perRow);
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
      fits: fitsGiven(req, plan.totalU, plan.totalV, 0),
      alleyWidened: blockAlley > asked + 1e-9, angle: 0,
      side: Math.max(plan.totalU, plan.totalV), ground: plan.totalU * plan.totalV,
    });
  }
  if (!found.length) return null;
  const best = mostCompact(found);
  const { side: _side, ground: _ground, ...out } = best;
  void _side; void _ground;
  return out;
}


// ===== alternating rows and columns ==========================================

/**
 * STRIPS: two crops in alternating rows, or alternating columns.
 *
 * What is asked is the pure pixels a strip must keep, IN THE WHOLE STRIP. A
 * strip has no length of its own, it runs the length of the field, so its
 * pixels are its pixels across times its length in pixels: on a long field
 * thin strips hold a great many. The first version asked for the pixels
 * across, and strips built for "10" came out more than twice as wide as
 * strips built for "3" over a field where the thin ones already held far more
 * than ten each ("this would also fit for 10 px, so why is the 10 px much
 * wider", 2026-11-20). So the strips are the thinnest that keep any pixel
 * across, and they are widened only when the field's strips are too short to
 * hold the count at that width. What comes out is the strip's width, and the
 * length of strip that holds the count.
 *
 * THE THINNEST STRIPS THAT DO are what is built ("always put the thinnest rows
 * or columns possible that achieve the wanted number of pixels", 2026-11-20).
 * Along the pixel rows (or columns: any quarter turn) that is most often a
 * strip and its alley of a WHOLE NUMBER OF PIXELS: every strip then lies on
 * the lattice as its neighbour does, all of them at the best place. Not
 * always (three requests in four in the suite, section H36; the others ask
 * for one pixel, or for an alley). The count steps with the width, and a whole
 * pixel more can step over the count asked for: at 10 m with the Sentinel-2
 * blur, strips of 2 pixels keep no pure pixel and strips of 3 keep two, while
 * strips of 2.5, lying two ways in turn, keep one in every strip. So the
 * widths between are tried too, by quarter pixels, and the strip that keeps
 * the fewest decides.
 * At any other angle a strip crosses the pixels obliquely and no pitch is
 * special: quarter pixels throughout.
 *
 * The count is the engine's, on the strips where the page will put them: the
 * page slides a periodic planting to the phase that leaves the most pure
 * pixels (bestPhaseOffset), from the field's corner, and this starts from the
 * same corner and asks the same function.
 */

/** What is asked of the strips. */
export interface StripRequest {
  /** Rows (strips along the layout's u axis) or columns. */
  pattern: 'row' | 'col';
  /** Pure pixels wanted in every strip, over its whole length. */
  pixels: number;
  res: number;
  sigmaX: number;
  sigmaY: number;
  /** The purity threshold, 0 to 1. */
  threshold: number;
  /** The geolocation error to hold against, in metres; 0 to count pure pixels with the image in place. */
  ce90M: number;
  /** Bare ground between strips, in metres: kept as asked. */
  spacing: number;
  /** The strips' angle to the pixel rows, in degrees. */
  rotationDeg?: number;
  /** The corner the page anchors the planting on (the field's own, s2-grid aoiUtmOrigin), in the grid's metres. */
  base?: [number, number];
  /**
   * The field's outline, in the grid's metres: the strips are as long as the
   * field lets them be. None: they are sized for a field long enough, and the
   * length they need is told.
   */
  ring?: [number, number][] | null;
}

/** Strips that meet the request. */
export interface StripSuggestion {
  pattern: 'row' | 'col';
  /** A strip's width and the bare ground beside it, in metres. */
  width: number;
  spacing: number;
  /** A strip and its alley, in pixels. */
  pitchPx: number;
  /** Pixels across the strip that keeps the fewest: pure, and within the CE90 (null with no geolocation error). */
  pure: number;
  held: number | null;
  angle: number;
  /** False at an angle, where the pixels across are a mean along the strip and not the same count everywhere. */
  whole: boolean;
  /** True when a strip and its alley are a whole number of pixels along the rows: every strip keeps the same pixels. */
  even: boolean;
  /** The length of strip that holds the pixels asked for, in metres. */
  lengthM: number;
  /**
   * On the field given: its strips, how many are that long, and the share of
   * the field's strips they make up, by length. Null with no field.
   */
  onField: { strips: number; enough: number; share: number } | null;
}

/** What the across search answers: strips, before a field has anything to say. */
type StripFit = Omit<StripSuggestion, 'lengthM' | 'onField'>;

/**
 * The share of a field's strips, by length, that must be long enough to hold
 * the pixels asked for. Not all of them: whatever its shape, a field ends on
 * strips cut short by its edge, and one sliver at a corner would otherwise set
 * the width of every strip.
 */
const STRIP_FIELD_SHARE = 0.9;

/** A strip's pitch is tried by quarter pixels wherever whole pixels are not the answer. */
const STRIP_STEP = 0.25;

/** Pixels a strip count may simulate at once: past it the strips are too wide to count. */
const STRIP_MAX_CELLS = 160_000;

/** Where the page puts the strips: slid from the field's corner to the phase with the most pure pixels. */
function stripOrigin(
  pattern: 'row' | 'col' | 'checker', width: number, spacing: number, rotationDeg: number, res: number, sensor: SensorParams, base: [number, number],
): [number, number] {
  const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const [du, dv] = bestPhaseOffset(pattern, res, width, spacing, sensor.mixThreshold, base[0], base[1], sensor);
  return [base[0] + du * cos - dv * sin, base[1] + du * sin + dv * cos];
}

/**
 * How long each strip is inside a field: the length of its centre line within
 * the outline, in metres, for every strip the outline crosses. Pure geometry.
 */
export function stripLengths(
  ring: [number, number][], pattern: 'row' | 'col', width: number, spacing: number, rotationDeg: number, origin: [number, number],
): number[] {
  const P = width + Math.max(0, spacing);
  if (!(P > 0) || ring.length < 3) return [];
  const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  // The strips' own frame: `s` across them, `a` along them.
  const pts = ring.map(([E, N]): [number, number] => {
    const dx = E - origin[0], dy = N - origin[1];
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    return pattern === 'row' ? [v, u] : [u, v];
  });
  let lo = Infinity, hi = -Infinity;
  for (const [sAt] of pts) { if (sAt < lo) lo = sAt; if (sAt > hi) hi = sAt; }
  const out: number[] = [];
  for (let i = Math.floor(lo / P); i <= Math.floor(hi / P); i++) {
    const mid = i * P + width / 2;
    if (mid <= lo || mid >= hi) continue;
    // Where the outline crosses the centre line: inside between each pair.
    const cuts: number[] = [];
    for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
      const [s0, a0] = pts[j], [s1, a1] = pts[k];
      if ((s0 > mid) !== (s1 > mid)) cuts.push(a0 + ((mid - s0) / (s1 - s0)) * (a1 - a0));
    }
    cuts.sort((x, y) => x - y);
    let len = 0;
    for (let k = 0; k + 1 < cuts.length; k += 2) len += cuts[k + 1] - cuts[k];
    if (len > 0) out.push(len);
  }
  return out;
}

/**
 * The pure pixels across a strip, by the engine, for the strip that keeps the
 * fewest: pure, and (with a geolocation error) pure for the same crop wherever
 * the image lands within it. Null when the strips are too wide to count.
 *
 * Counted over a slab square to the strips, a whole number of pixels long: the
 * pure pixels whose centre lies in a strip, over the slab's length in pixels.
 * Along the pixel rows that is a count of pixel rows, the same anywhere along
 * the strip. At an angle the pixels across change along the strip and this is
 * their mean, the width of the strip's pure band in pixels.
 */
export function stripPixels(
  pattern: 'row' | 'col', width: number, spacing: number, rotationDeg: number, res: number, sensor: SensorParams, ce90M: number,
  base: [number, number] = [0, 0],
): { pure: number; held: number | null } | null {
  const P = width + Math.max(0, spacing);
  if (!(width > 0) || !(res > 0)) return null;
  const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const origin = stripOrigin(pattern, width, spacing, rotationDeg, res, sensor, base);
  const layout: SimLayout = { pattern, width, spacing, rotationDeg };

  // The slab: twenty-four pixels and more along, and across it the strips
  // that between them lie every way a strip of this pitch lies on the lattice.
  // Two when they all lie alike (a whole pitch) or when the count is a mean
  // (turned); five for a pitch of quarter pixels along the rows, whose strips
  // lie four ways in turn.
  const evenPitch = Math.abs(P / res - Math.round(P / res)) < 1e-6;
  const ways = Math.abs(rotationDeg % 90) < 1e-9 && !evenPitch ? 5 : 2;
  const across = Math.ceil((((ways + 1) / 2) * P) / res + 1) * res, along = Math.max(12, Math.ceil(P / res)) * res;
  const reach = (Math.ceil(3 * Math.max(sensor.sigmaX, sensor.sigmaY, 0)) + 2) * res + Math.max(0, ce90M);
  const half = Math.ceil((Math.hypot(across, along) + reach) / res);
  if (4 * half * half > STRIP_MAX_CELLS) return null;
  const cE = Math.floor(base[0] / res) * res, cN = Math.floor(base[1] / res) * res;
  const n = 2 * half, e0 = cE - half * res, n0 = cN - half * res;
  const box = { res, utmBounds: [e0, n0, e0 + n * res, n0 + n * res] } as unknown as S2Grid;
  const nominal = fieldVerdicts(box, origin, layout, sensor);
  let mask: Uint8Array | null = null;
  if (ce90M > 0) {
    // Half a strip's width carries its centre line onto its edge: nothing holds.
    if (ce90M >= width / 2) mask = new Uint8Array(nominal.length);
    else {
      const lands = ce90Shifts(ce90M);
      mask = heldMask(nominal, lands.length, (q, need) => fieldVerdicts(box, [origin[0] - lands[q][0], origin[1] - lands[q][1]], layout, sensor, need));
    }
  }

  // The slab's own frame, about the planting's origin: `s` across the strips, `a` along them.
  const frame = (E: number, N: number): [number, number] => {
    const dx = E - origin[0], dy = N - origin[1];
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    return pattern === 'row' ? [v, u] : [u, v];
  };
  const [sc, ac] = frame(cE, cN);
  // Strips whole inside the slab.
  const first = Math.ceil((sc - across) / P), last = Math.floor((sc + across - width) / P);
  if (last - first + 1 < ways) return null;
  const pureIn = new Float64Array(last - first + 1), heldIn = new Float64Array(last - first + 1);
  for (let k = 0; k < nominal.length; k++) {
    const v = nominal[k];
    if (v > 1) continue;                                   // mixed, or bare ground
    const [sAt, aAt] = frame(e0 + ((k % n) + 0.5) * res, n0 + (Math.floor(k / n) + 0.5) * res);
    if (aAt < ac - along || aAt >= ac + along) continue;
    const i = Math.floor(sAt / P);
    if (i < first || i > last || sAt - i * P >= width || v !== (((i % 2) + 2) % 2)) continue;
    pureIn[i - first]++;
    if (mask && mask[k]) heldIn[i - first]++;
  }
  // Pixels in the slab's length: a strip's pure pixels over it are its pixels across.
  const len = (2 * along) / res;
  const fewest = (c: Float64Array) => Math.round((Math.min(...c) / len) * 1000) / 1000;
  return { pure: fewest(pureIn), held: mask ? fewest(heldIn) : null };
}

/**
 * The thinnest strips that keep the pixels asked for in every strip.
 *
 * Thin strips first: the thinnest that keep any pixel across, which hold the
 * count over a length of strip that a field usually has several times over.
 * Where the field's strips are shorter than that, the next width up, which
 * keeps more across and needs less length, and so on until nine tenths of the
 * field's strips, by length, are long enough. With no field the thinnest
 * strips are the answer and the length they need is told. Null when no strip
 * within the design's limits keeps a pixel.
 */
export function suggestStrips(req: StripRequest): StripSuggestion | null {
  const pixels = Math.max(1, Math.round(req.pixels));
  const { res, pattern } = req;
  if (!(res > 0)) return null;
  const deg = Number.isFinite(req.rotationDeg) ? (req.rotationDeg as number) : 0;
  const sensor: SensorParams = { sigmaX: req.sigmaX, sigmaY: req.sigmaY, mixThreshold: req.threshold };
  const ring = req.ring && req.ring.length >= 3 ? req.ring : null;
  /** The strips that keep `across` pixels across, with the length that holds the count and how the field takes them. */
  const at = (across: number): { out: StripSuggestion; lengths: number[]; kept: number } | null => {
    const fit = thinnestStripsAcross({ ...req, pixels: across });
    if (!fit) return null;
    // What a strip of that width keeps across, in every strip: at least what was asked of it.
    const kept = fit.held ?? fit.pure;
    const lengthPx = Math.max(1, Math.ceil(pixels / kept - 1e-9));
    let onField: StripSuggestion['onField'] = null, lengths: number[] = [];
    if (ring) {
      lengths = stripLengths(ring, pattern, fit.width, fit.spacing, deg, stripOrigin(pattern, fit.width, fit.spacing, deg, res, sensor, req.base ?? [0, 0]));
      const long = lengths.filter(len => Math.floor(len / res + 1e-9) >= lengthPx);
      const total = lengths.reduce((a, b) => a + b, 0);
      if (total > 0) onField = { strips: lengths.length, enough: long.length, share: long.reduce((a, b) => a + b, 0) / total };
    }
    return { out: { ...fit, lengthM: cm(lengthPx * res), onField }, lengths, kept };
  };
  // Long enough, or nothing longer to hope for: a strip one pixel long already holds the count.
  const does = (o: StripSuggestion) => !o.onField || o.onField.share >= STRIP_FIELD_SHARE || o.lengthM <= res + 1e-9;

  const first = at(1);
  if (!first || does(first.out)) return first?.out ?? null;
  // The field is too short for the thinnest strips. Wider ones keep more
  // across and need less length: straight to the pixels across that the
  // field's own strips call for, then one more at a time.
  let failed = 1, cur = first;
  for (let tries = 0; tries < 16; tries++) {
    if (cur.lengths.length < 2) break;                    // a strip as wide as the field is no strip trial
    const sorted = [...cur.lengths].sort((x, y) => y - x), total = sorted.reduce((a, b) => a + b, 0);
    let sum = 0, typical = sorted[0];
    for (const len of sorted) { sum += len; typical = len; if (sum >= STRIP_FIELD_SHARE * total) break; }
    const wanted = Math.ceil(pixels / Math.max(1, Math.floor(typical / res + 1e-9)) - 1e-9);
    const across = Math.min(pixels, Math.max(failed + 1, Math.floor(cur.kept + 1e-9) + 1, wanted));
    const next = at(across);
    if (!next) break;
    if (does(next.out)) {
      // Not past the thinnest that does: the counts across between the last one that failed and this one.
      let best = next.out;
      for (let k = across - 1; k > failed && k > Math.floor(cur.kept + 1e-9); k--) {
        const under = at(k);
        if (!under || !does(under.out)) break;
        best = under.out;
      }
      return best;
    }
    if (across >= pixels) break;
    failed = across; cur = next;
  }
  // No width does on this field: the thinnest strips, which say how few of its strips are long enough.
  return first.out;
}

/**
 * The thinnest strips that keep `pixels` pure pixels ACROSS every strip.
 * Null when no strip within the design's limits does.
 */
export function thinnestStripsAcross(req: StripRequest): StripFit | null {
  const pixels = Math.max(1, Math.round(req.pixels));
  const { res, pattern } = req;
  if (!(res > 0) || !(req.threshold > 0) || !(req.sigmaX >= 0) || !(req.sigmaY >= 0)) return null;
  const spacing = Math.max(0, req.spacing);
  const deg = Number.isFinite(req.rotationDeg) ? (req.rotationDeg as number) : 0;
  const whole = Math.abs(deg % 90) < 1e-9;
  // Whole pixels first along the rows, where they are most often the answer; quarter pixels at an angle.
  const step = whole ? 1 : STRIP_STEP;
  const snap = (p: number) => Math.round(p / step) * step;
  const quarter = (p: number) => Math.round(p / STRIP_STEP) * STRIP_STEP;
  const sensor: SensorParams = { sigmaX: req.sigmaX, sigmaY: req.sigmaY, mixThreshold: req.threshold };
  const widthOf = (p: number) => cm(p * res - spacing);
  // The smallest pitch that leaves any strip beside its alley, and a strip cannot keep more pixels than it is wide.
  const floorOf = (st: number) => Math.max(
    Math.round((Math.floor(spacing / res / st + 1e-9) * st + st) / st) * st,
    Math.round((Math.ceil((pixels + spacing / res) / st - 1e-9) * st) / st) * st);
  const low = floorOf(step);
  const cap = Math.floor(MAX_PLOT_M / res);
  const counted = new Map<number, { pure: number; held: number | null } | null>();
  const count = (p: number) => {
    if (!counted.has(p)) counted.set(p, stripPixels(pattern, widthOf(p), spacing, deg, res, sensor, req.ce90M, req.base));
    return counted.get(p)!;
  };
  const got = (p: number) => { const c = count(p); return c ? (c.held ?? c.pure) : null; };
  let p = low;
  for (let tries = 0; ; tries++) {
    if (p > cap || tries > 80) return null;
    const g = got(p);
    if (g === null) return null;
    if (g >= pixels - 1e-9) break;
    // Each pixel of pitch is a pixel across, near enough: stride over most of what is missing.
    p = snap(p + Math.max(step, Math.floor((pixels - g - 1) / step) * step));
  }
  for (;;) {
    const q = snap(p - step);
    const g = q >= low ? got(q) : null;
    if (g === null || g < pixels - 1e-9) break;
    p = q;
  }
  // Along the rows, the widths between that pitch and the whole pixel under it,
  // the thinnest first: nothing thinner than that pixel can do, since strips of
  // a whole pitch all lie at the best place and it did not.
  if (whole) {
    const under = floorOf(STRIP_STEP);
    for (let q = quarter(p - 1 + STRIP_STEP); q < p - 1e-9; q = quarter(q + STRIP_STEP)) {
      if (q < under) continue;
      const g = got(q);
      if (g !== null && g >= pixels - 1e-9) { p = q; break; }
    }
  }
  const c = count(p)!;
  return { pattern, width: widthOf(p), spacing, pitchPx: p, pure: c.pure, held: c.held, angle: deg, whole, even: whole && Number.isInteger(p) };
}

// ===== checkerboard ==========================================================

/**
 * A CHECKERBOARD: square cells of two crops, each cell against the other crop
 * on its four sides. A cell is a plot, so what is asked of it is what is asked
 * of a block trial's plot, the pure pixels it keeps, and what is built is the
 * cell's side.
 *
 * Counted as the strips are: by the engine, on the cells where the page slides
 * them, a pixel being a cell's when its centre lies in it and it is pure for
 * that cell's crop. Along the pixel rows every cell of a whole-pixel pitch
 * keeps the same count and the cell that keeps the fewest decides; at an angle
 * the cells all lie differently and the count is their mean.
 */
export interface CheckerRequest {
  /** Pure pixels wanted in every cell. */
  pixels: number;
  res: number;
  sigmaX: number;
  sigmaY: number;
  threshold: number;
  ce90M: number;
  /** Bare ground between cells, in metres, both ways: kept as asked. */
  spacing: number;
  rotationDeg?: number;
  base?: [number, number];
}

/** Cells that meet the request. */
export interface CheckerSuggestion {
  /** A cell's side and the bare ground beside it, in metres. */
  width: number;
  spacing: number;
  pitchPx: number;
  /** Pixels of the cell that keeps the fewest (their mean at an angle): pure, and within the CE90. */
  pure: number;
  held: number | null;
  angle: number;
  /** False at an angle, where the count is a mean over the cells. */
  whole: boolean;
  /** True when a cell and its alley are a whole number of pixels along the rows: every cell keeps the same pixels. */
  even: boolean;
}

/**
 * The pure pixels of a checkerboard's cell, by the engine: of the cell that
 * keeps the fewest along the pixel rows, the mean over the cells at an angle.
 * Null when the cells are too large to count.
 */
export function checkerPixels(
  width: number, spacing: number, rotationDeg: number, res: number, sensor: SensorParams, ce90M: number,
  base: [number, number] = [0, 0],
): { pure: number; held: number | null } | null {
  const P = width + Math.max(0, spacing);
  if (!(width > 0) || !(res > 0)) return null;
  const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const origin = stripOrigin('checker', width, spacing, rotationDeg, res, sensor, base);
  const layout: SimLayout = { pattern: 'checker', width, spacing, rotationDeg };
  const aligned = Math.abs(rotationDeg % 90) < 1e-9;
  // Cells each way: two where they all lie alike, five for a pitch of quarter
  // pixels (four ways in turn), four at an angle, where the count is a mean.
  const evenPitch = Math.abs(P / res - Math.round(P / res)) < 1e-6;
  const ways = aligned ? (evenPitch ? 2 : 5) : 4;
  const span = Math.ceil((((ways + 1) / 2) * P) / res + 1) * res;
  const reach = (Math.ceil(3 * Math.max(sensor.sigmaX, sensor.sigmaY, 0)) + 2) * res + Math.max(0, ce90M);
  const half = Math.ceil((Math.SQRT2 * span + reach) / res);
  if (4 * half * half > STRIP_MAX_CELLS) return null;
  const cE = Math.floor(base[0] / res) * res, cN = Math.floor(base[1] / res) * res;
  const n = 2 * half, e0 = cE - half * res, n0 = cN - half * res;
  const box = { res, utmBounds: [e0, n0, e0 + n * res, n0 + n * res] } as unknown as S2Grid;
  const nominal = fieldVerdicts(box, origin, layout, sensor);
  let mask: Uint8Array | null = null;
  if (ce90M > 0) {
    if (ce90M >= width / 2) mask = new Uint8Array(nominal.length);
    else {
      const lands = ce90Shifts(ce90M);
      mask = heldMask(nominal, lands.length, (q, need) => fieldVerdicts(box, [origin[0] - lands[q][0], origin[1] - lands[q][1]], layout, sensor, need));
    }
  }
  const frame = (E: number, N: number): [number, number] => {
    const dx = E - origin[0], dy = N - origin[1];
    return [dx * cos + dy * sin, -dx * sin + dy * cos];
  };
  const [uc, vc] = frame(cE, cN);
  // Cells whole inside the window, each way.
  const i0 = Math.ceil((uc - span) / P), i1 = Math.floor((uc + span - width) / P);
  const j0 = Math.ceil((vc - span) / P), j1 = Math.floor((vc + span - width) / P);
  const ni = i1 - i0 + 1, nj = j1 - j0 + 1;
  if (ni < ways || nj < ways) return null;
  const pureIn = new Float64Array(ni * nj), heldIn = new Float64Array(ni * nj);
  for (let k = 0; k < nominal.length; k++) {
    const v = nominal[k];
    if (v > 1) continue;
    const [u, w] = frame(e0 + ((k % n) + 0.5) * res, n0 + (Math.floor(k / n) + 0.5) * res);
    const i = Math.floor(u / P), j = Math.floor(w / P);
    if (i < i0 || i > i1 || j < j0 || j > j1 || u - i * P >= width || w - j * P >= width) continue;
    if (v !== ((((i + j) % 2) + 2) % 2)) continue;
    const c = (j - j0) * ni + (i - i0);
    pureIn[c]++;
    if (mask && mask[k]) heldIn[c]++;
  }
  const figure = (c: Float64Array) => (aligned ? Math.min(...c) : Math.round((c.reduce((a, b) => a + b, 0) / c.length) * 1000) / 1000);
  return { pure: figure(pureIn), held: mask ? figure(heldIn) : null };
}

/**
 * The smallest cells that keep the pixels asked for. Whole pixels first along
 * the rows, then the quarters under the whole pixel found (as for strips: a
 * whole pixel more can step over the count); quarter pixels at an angle.
 * Null when no cell within the design's limits does.
 */
export function suggestChecker(req: CheckerRequest): CheckerSuggestion | null {
  const pixels = Math.max(1, Math.round(req.pixels));
  const { res } = req;
  if (!(res > 0) || !(req.threshold > 0) || !(req.sigmaX >= 0) || !(req.sigmaY >= 0)) return null;
  const spacing = Math.max(0, req.spacing);
  const deg = Number.isFinite(req.rotationDeg) ? (req.rotationDeg as number) : 0;
  const whole = Math.abs(deg % 90) < 1e-9;
  const step = whole ? 1 : STRIP_STEP;
  const snap = (p: number) => Math.round(p / step) * step;
  const quarter = (p: number) => Math.round(p / STRIP_STEP) * STRIP_STEP;
  const sensor: SensorParams = { sigmaX: req.sigmaX, sigmaY: req.sigmaY, mixThreshold: req.threshold };
  const widthOf = (p: number) => cm(p * res - spacing);
  // A cell cannot keep more pixels than it covers.
  const floorOf = (st: number) => Math.max(
    Math.round((Math.floor(spacing / res / st + 1e-9) * st + st) / st) * st,
    Math.round((Math.ceil((Math.sqrt(pixels) + spacing / res) / st - 1e-9) * st) / st) * st);
  const low = floorOf(step), cap = Math.floor(MAX_PLOT_M / res);
  const counted = new Map<number, { pure: number; held: number | null } | null>();
  const count = (p: number) => {
    if (!counted.has(p)) counted.set(p, checkerPixels(widthOf(p), spacing, deg, res, sensor, req.ce90M, req.base));
    return counted.get(p)!;
  };
  const got = (p: number) => { const c = count(p); return c ? (c.held ?? c.pure) : null; };
  let p = low;
  for (let tries = 0; ; tries++) {
    if (p > cap || tries > 80) return null;
    const g = got(p);
    if (g === null) return null;
    if (g >= pixels - 1e-9) break;
    // A pixel of pitch is a pixel of side, near enough: stride over most of the side that is missing.
    p = snap(p + Math.max(step, Math.floor((Math.sqrt(pixels) - Math.sqrt(Math.max(0, g)) - 1) / step) * step));
  }
  for (;;) {
    const q = snap(p - step);
    const g = q >= low ? got(q) : null;
    if (g === null || g < pixels - 1e-9) break;
    p = q;
  }
  if (whole) {
    const under = floorOf(STRIP_STEP);
    for (let q = quarter(p - 1 + STRIP_STEP); q < p - 1e-9; q = quarter(q + STRIP_STEP)) {
      if (q < under) continue;
      const g = got(q);
      if (g !== null && g >= pixels - 1e-9) { p = q; break; }
    }
  }
  const c = count(p)!;
  return { width: widthOf(p), spacing, pitchPx: p, pure: c.pure, held: c.held, angle: deg, whole, even: whole && Number.isInteger(p) };
}

