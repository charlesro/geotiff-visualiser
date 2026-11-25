import { CE90_TO_SIGMA } from './resolving';
import type { ImportedPlan } from './imported-types';

/**
 * How large a plot must be for a sensor to give pure pixels in it.
 *
 * The PHENET note answers this with one closed form, L = GSD + 2 z sigma_eff,
 * which is one pure pixel in a SQUARE plot for the AVERAGE image. A trial is
 * rarely that case, so this module answers the same question numerically, with
 * the same model, for what a design actually asks:
 *
 *  ANY PLOT SHAPE. A pixel centred at (x, y) from the centre of an a x b plot
 *    keeps the share F_a(x) F_b(y) of its signal, where F is what a Gaussian
 *    spot keeps between two parallel borders. The product is what "the four
 *    neighbours add up" becomes when it is done exactly: each side is counted
 *    with its own distance, and the corners are not counted twice. A strip is
 *    the same with one pair of borders at infinity.
 *
 *  ANY NUMBER OF PURE PIXELS, wherever the pixel grid falls. A trial has many
 *    plots and each one sits differently on the lattice, so what a design can
 *    count on is the placement that is worst for it.
 *
 *  THREE READINGS OF THE GEOLOCATION ERROR, because sigma_eff is only one:
 *    corrected  each image is put back in place before it is read, so only
 *               the blur is left: sigma_PSF, no shift.
 *    average    the note. Blur and shift merged in sigma_eff. Exact for a
 *               mean over many images; for one image a pixel on that buffer
 *               is over the threshold about 4 times in 10.
 *    robust     the SAME pixels stay pure in 9 images out of 10: sigma_PSF,
 *               with the image anywhere within its CE90. This is the reading
 *               a pixel list chosen by coordinates needs.
 *
 * Nothing here knows about the simulation engine, and both follow the note: a
 * measured FWHM already contains the detector, and nothing is added for the
 * pixel's own footprint (simulate.ts followsSpot).
 */

/** What a pixel sees, and how pure it must be. */
export interface Viewing {
  /** Pixel size, m. */
  gsd: number;
  /** Gaussian sigma of the spot a pixel sees, m. */
  sigma: number;
  /** Radius the image may land within, m; 0 when it is where its coordinates say. */
  shift: number;
  /** Share of a pixel's signal that must come from its own plot (0.9 for epsilon = 10 %). */
  threshold: number;
  /** Angle between the plot's sides and the pixel rows, degrees. */
  angleDeg: number;
}

/**
 * Where the pixel grid is taken to fall on a plot. 'worst': anywhere, so the
 * plot is counted at the placement worst for it (a tasked sensor, whose grid
 * is not known at planting). 'best': where the plot is best off, which a
 * design on a fixed, known grid (Sentinel-2, Landsat) can choose.
 */
export type GridAt = 'worst' | 'best';

/** A plot in its own frame: `a` along x, `b` along y, in metres. A strip has b = Infinity. */
export interface Plot {
  a: number;
  b: number;
}

/**
 * Standard normal CDF (Abramowitz and Stegun 26.2.17, absolute error under
 * 7.5e-8). On a share near 0.9 that moves a plot size by a few micrometres.
 */
export function normCdf(z: number): number {
  // Past 8.3 the tail is under half the last bit of 1 and the formula below
  // gives exactly 1 (checked from 8.294 up): said at once, with no exponential.
  if (z >= 8.3) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = (Math.exp(-0.5 * z * z) / 2.5066282746310002) * poly;
  return z >= 0 ? 1 - upper : upper;
}

/** What a spot of sigma `s` centred `t` from the middle keeps between two borders `L` apart. */
function between(L: number, t: number, s: number): number {
  if (L === Infinity) return 1;
  if (!(s > 0)) return Math.abs(t) <= L / 2 ? 1 : 0;
  return normCdf((L / 2 - t) / s) + normCdf((L / 2 + t) / s) - 1;
}

/**
 * Share of a pixel's signal that comes from its own plot, for a pixel centred
 * at (x, y) from the plot's centre. Everything else, the four neighbours, the
 * alleys, the diagonal plots, is the complement, whatever grows there.
 */
export function ownShare(x: number, y: number, plot: Plot, sigma: number): number {
  return between(plot.a, x, sigma) * between(plot.b, y, sigma);
}

/** Directions of the quarter circle that points away from the plot centre. */
const ARC: [number, number][] = Array.from({ length: 13 }, (_, k) => {
  const t = (k * Math.PI) / 24;
  return [Math.cos(t), Math.sin(t)] as [number, number];
});

/**
 * The share a pixel is sure of: its lowest over every place the image can land
 * within `shift`. The share falls away from the centre on both axes, so the
 * worst landing is always on the outward quarter of the circle, and a disc
 * lies in the (convex) pure region as soon as that arc does.
 */
export function heldShare(x: number, y: number, plot: Plot, v: Viewing): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (!(v.shift > 0)) return ownShare(ax, ay, plot, v.sigma);
  if (plot.b === Infinity) return between(plot.a, ax + v.shift, v.sigma);
  if (plot.a === Infinity) return between(plot.b, ay + v.shift, v.sigma);
  let low = 1;
  for (const [c, s] of ARC) {
    const share = ownShare(ax + v.shift * c, ay + v.shift * s, plot, v.sigma);
    if (share < low) low = share;
  }
  return low;
}

/** Largest t in [0, hi] where `ok` holds, for a test that holds at 0 and then stops. */
function edge(ok: (t: number) => boolean, hi: number, steps = 26): number {
  if (ok(hi)) return hi;
  let lo = 0;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/*
 * THE ENTRY SCALE. Grow a plot about its centre, keeping its shape: a pixel
 * centred at (x, y) becomes pure at one scale and stays pure above it. That
 * scale, E(x, y), is what everything below is built on, because it turns two
 * questions that are steps in the plot size into one that is continuous:
 *
 *   at a given placement of the grid, the plot holds n pure pixels from the
 *   n-th smallest E among the lattice points on;
 *   wherever the grid falls, from the LARGEST of those over the placements.
 *
 * A count sampled over placements is a step function and misses the worst one
 * whenever it sits beside a symmetric placement, which is where the sampling
 * looks (measured: one pixel short at the size it called enough). The n-th
 * smallest E is continuous in the placement, so a coarse sweep and a local
 * climb find its maximum to well under a centimetre.
 */

/** E for the blur alone, tabulated over the quarter plane the plot is symmetric in. */
interface EntryTable {
  X: number; Y: number;
  dx: number; dy: number;
  nx: number; ny: number;
  e: Float64Array;
}

/** Nodes per axis of the table. E is close to linear away from the corners, so this is generous. */
const NODES = 56;

/** Smallest factor on `plot` at which a pixel centred at (x, y) keeps `threshold` of its signal. */
function entryScale(x: number, y: number, plot: Plot, sigma: number, threshold: number): number {
  // Under this the pixel centre is not even inside the plot.
  const lo = Math.max((2 * x) / plot.a, plot.b === Infinity ? 0 : (2 * y) / plot.b);
  if (!(sigma > 0)) return lo;
  // 4.5 sigma inside every border leaves 7 millionths outside: over any threshold offered.
  return crossing(x, y, plot, sigma, threshold, lo, lo + (9 * sigma) / Math.min(plot.a, plot.b));
}

/**
 * The scale between `lo` and `hi` at which the pixel at (x, y) reaches the
 * threshold, by false position with the Illinois correction: the share is
 * smooth in the scale, so a few evaluations do what twenty halvings did.
 * Returns the side of the bracket where the threshold IS met.
 */
function crossing(x: number, y: number, plot: Plot, sigma: number, threshold: number, lo: number, hi: number): number {
  const miss = (s: number) => between(plot.a * s, x, sigma) * between(plot.b * s, y, sigma) - threshold;
  let flo = miss(lo), fhi = miss(hi);
  if (flo >= 0) return lo;
  for (let grow = 0; fhi < 0 && grow < 40; grow++) { lo = hi; flo = fhi; hi *= 1.5; fhi = miss(hi); }
  const tol = 2e-6 / Math.min(plot.a, plot.b);
  for (let i = 0, side = 0; i < 40 && hi - lo > tol; i++) {
    let mid = hi - (fhi * (hi - lo)) / (fhi - flo);
    if (!(mid > lo && mid < hi)) mid = (lo + hi) / 2;
    const fm = miss(mid);
    if (fm >= 0) { hi = mid; fhi = fm; if (side === 1) flo /= 2; side = 1; }
    else { lo = mid; flo = fm; if (side === -1) fhi /= 2; side = -1; }
  }
  return hi;
}

/**
 * E over [0, X] x [0, Y]. A pixel one node further out enters later, and by no
 * more than the plot needs to grow to put the border back where it was, so
 * each node is solved inside the narrow bracket its neighbour gives.
 */
function entryTable(plot: Plot, sigma: number, threshold: number, X: number, Y: number): EntryTable {
  const nx = NODES, ny = NODES, dx = X / nx, dy = Y / ny, w = nx + 1;
  const e = new Float64Array(w * (ny + 1));
  const blurred = sigma > 0;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = i * dx, y = j * dy;
      if (!blurred || (i === 0 && j === 0)) { e[j * w + i] = entryScale(x, y, plot, sigma, threshold); continue; }
      const from = i > 0 ? e[j * w + i - 1] : e[(j - 1) * w];
      const most = i > 0 ? (2 * dx) / plot.a : (2 * dy) / plot.b;
      e[j * w + i] = crossing(x, y, plot, sigma, threshold, from, from + most * 1.0001 + 1e-12);
    }
  }
  return { X, Y, dx, dy, nx, ny, e };
}

/** E at any point by bilinear interpolation; Infinity outside the table, where it is not needed. */
function entryAt(t: EntryTable, x: number, y: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax > t.X || ay > t.Y) return Infinity;
  const kx = ax / t.dx, ky = ay / t.dy;
  const i = Math.min(t.nx - 1, Math.floor(kx)), j = Math.min(t.ny - 1, Math.floor(ky));
  const fx = kx - i, fy = ky - j, w = t.nx + 1;
  const e00 = t.e[j * w + i], e10 = t.e[j * w + i + 1], e01 = t.e[(j + 1) * w + i], e11 = t.e[(j + 1) * w + i + 1];
  return (e00 * (1 - fx) + e10 * fx) * (1 - fy) + (e01 * (1 - fx) + e11 * fx) * fy;
}

/** Directions the held table is built from: finer than ARC, since it is built once. */
const FINE_ARC: [number, number][] = Array.from({ length: 31 }, (_, k) => {
  const t = (k * Math.PI) / 60;
  return [Math.cos(t), Math.sin(t)] as [number, number];
});

/**
 * E for a pixel that must stay pure wherever the image lands within `shift`,
 * as a table of its own over [0, X] x [0, Y]: at each node, the latest of the
 * entry scales of the places the pixel can be carried to, which by the same
 * symmetry are all on the outward quarter of the circle. `blur` must reach
 * `shift` further than X and Y so that every carried point reads a value.
 */
function heldTable(blur: EntryTable, X: number, Y: number, shift: number): EntryTable {
  const nx = NODES, ny = NODES, dx = X / nx, dy = Y / ny;
  const e = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      let late = 0;
      for (const [c, s] of FINE_ARC) {
        const at = entryAt(blur, i * dx + shift * c, j * dy + shift * s);
        if (at > late) late = at;
      }
      e[j * (nx + 1) + i] = late;
    }
  }
  return { X, Y, dx, dy, nx, ny, e };
}

/** The table a lattice point is read in: the blur's own, or the held one when the image may move. */
function tableFor(plot: Plot, v: Viewing, X: number, Y: number): EntryTable {
  const shift = Math.max(0, v.shift);
  if (!(shift > 0)) return entryTable(plot, v.sigma, v.threshold, X, Y);
  return heldTable(entryTable(plot, v.sigma, v.threshold, X + shift, Y + shift), X, Y, shift);
}

/** The pixel lattice seen from the plot: its two steps, and whether it lies along the plot's sides. */
function lattice(v: Viewing): { ux: number; uy: number; aligned: boolean } {
  const deg = ((v.angleDeg % 90) + 90) % 90;
  const aligned = deg < 1e-6 || deg > 90 - 1e-6;
  const t = aligned ? 0 : (deg * Math.PI) / 180;
  return { ux: Math.cos(t) * v.gsd, uy: Math.sin(t) * v.gsd, aligned };
}

/**
 * The lattice points that can fall in the box |x| <= X, |y| <= Y at some
 * placement, as index pairs. A plot that is long, or turned, fills a small part
 * of the square of indices around it, and walking that square at every
 * placement was most of the time spent.
 */
function candidates(lat: { ux: number; uy: number }, gsd: number, X: number, Y: number): Int32Array {
  const reach = Math.ceil(Math.hypot(X, Y) / gsd) + 1;
  const out: number[] = [];
  for (let i = -reach; i <= reach; i++) {
    for (let j = -reach; j <= reach; j++) {
      // The middle of the cell the point moves in as the placement goes from 0 to 1.
      const p = i + 0.5, q = j + 0.5;
      const x = p * lat.ux - q * lat.uy, y = p * lat.uy + q * lat.ux;
      if (Math.abs(x) <= X + gsd && Math.abs(y) <= Y + gsd) out.push(i, j);
    }
  }
  return Int32Array.from(out);
}

/** A placement is periodic: its fraction of a pixel, in [0, 1). */
const frac = (t: number) => t - Math.floor(t);

/** The k-th smallest (k from 0) of the first `n` values of `a`, which it reorders. */
function kth(a: Float64Array, n: number, k: number): number {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else break;
  }
  return a[k];
}

/** Placements tried along each axis in the sweep. Even, so the half-pixel placement is one of them. */
const SWEEP = 32;
/** Lattice tests one sweep may spend before it tries fewer placements. */
const WORK = 1_500_000;
/** Up to this many pure pixels a count is checked against the size search: one pixel still matters. */
const SURE = 40;
/** Places the climb starts from, for each n. */
const STARTS = 3;
/** Past this size the search gives up: no trial has plots kilometres across. */
const SIDE_MAX = 5000;
/**
 * How far the search can fall short of the worst placement, as a factor on the
 * plot. Measured against a brute-force count over random placements on 300
 * random designs (sensor, threshold, shape, angle, n from 1 to 25): the search
 * alone was one pixel short on a few of them, by at most 0.5 % of the plot
 * side. The size is given 0.6 % larger, so that it errs on the side of a plot
 * that is enough. A strip needs no search and no margin.
 */
const MARGIN = 1.006;

/**
 * The smallest plots of the SAME SHAPE as `plot` that keep at least n pure
 * pixels wherever the pixel grid falls, for each n in `wanted`: the factor to
 * scale the plot by, or null when no plot under `SIDE_MAX` does.
 *
 * For a strip, n is the number of pure pixels ACROSS it: along its length
 * there is no end to count to, and on a turned grid the same figure is the
 * density of pure pixels, pure band / GSD squared per metre of strip.
 */
export function pureScales(plot: Plot, v: Viewing, wanted: number[], where: GridAt = 'worst'): (number | null)[] {
  if (plot.a === Infinity && plot.b !== Infinity) return pureScales({ a: plot.b, b: Infinity }, v, wanted, where);
  const short = Math.min(plot.a, plot.b);
  const usable = short > 0 && short < Infinity && v.gsd > 0 && v.threshold > 0 && v.threshold < 1 && v.sigma >= 0;
  if (!usable || !wanted.length) return wanted.map(() => null);
  const ok = (n: number) => Number.isFinite(n) && n >= 1;

  // A strip: n pixels across fit as soon as the pixel centred n/2 pixels from
  // the middle line, carried `shift` further out, is pure.
  if (plot.b === Infinity) {
    return wanted.map(n => {
      if (!ok(n)) return null;
      // A millimetre over, so that the strip it names is on the right side of its own threshold.
      // At the best place on the grid the outermost of n pixels is (n - 1) / 2 pixels from the middle line, not n / 2.
      const reach = ((where === 'best' ? n - 1 : n) * v.gsd) / 2;
      const s = entryScale(reach + Math.max(0, v.shift), 0, plot, v.sigma, v.threshold) + 1e-3 / short;
      return s * short <= SIDE_MAX ? s : null;
    });
  }

  const lat = lattice(v);
  const ns = wanted.map(n => (ok(n) ? Math.floor(n) : 0));
  const out: (number | null)[] = wanted.map(() => null);
  // The search costs as the square of the cap, so it starts at about the size
  // one pure pixel needs and grows only for the counts still unresolved.
  let cap = (1.15 * (v.gsd + 2 * (1.3 * v.sigma + Math.max(0, v.shift)))) / short;
  let left = ns.map((n, k) => (n >= 1 ? k : -1)).filter(k => k >= 0);
  for (let attempt = 0; left.length && attempt < 40 && cap * short <= SIDE_MAX; attempt++) {
    const got = scalesUnder(plot, v, lat, left.map(k => ns[k]), cap, where);
    const still: number[] = [];
    left.forEach((k, i) => {
      const s = got[i];
      // A scale near the cap may be missing lattice points that lie beyond it.
      if (s !== null && s < cap * 0.97) out[k] = s * MARGIN; else still.push(k);
    });
    left = still;
    cap *= 1.35;
  }
  return out;
}

/** `pureScales` for one cap: null for an n it does not ask for, the cap itself when the plot must be larger. */
function scalesUnder(plot: Plot, v: Viewing, lat: { ux: number; uy: number; aligned: boolean }, ns: number[], cap: number, where: GridAt = 'worst'): (number | null)[] {
  // Only a point inside the plot at the cap can be pure under it.
  const X = (cap * plot.a) / 2, Y = (cap * plot.b) / 2;
  const table = tableFor(plot, v, X, Y);
  const cand = candidates(lat, v.gsd, X, Y);
  const buf = new Float64Array(cand.length / 2);
  /** The entry scales under the cap at one placement, into `buf`. */
  const pointsAt = (fa: number, fb: number): number => {
    const ga = frac(fa), gb = frac(fb);
    let n = 0;
    for (let c = 0; c < cand.length; c += 2) {
      const p = cand[c] + ga, q = cand[c + 1] + gb;
      const x = p * lat.ux - q * lat.uy, y = p * lat.uy + q * lat.ux;
      if (x > X || x < -X || y > Y || y < -Y) continue;
      const e = entryAt(table, x, y);
      if (e <= cap) buf[n++] = e;
    }
    return n;
  };
  /** The n-th smallest entry scale at a placement: the cap when it holds fewer than n. */
  const nthAt = (fa: number, fb: number, n: number): number => {
    const count = pointsAt(fa, fb);
    return n <= count ? kth(buf, count, n - 1) : cap;
  };
  const shift = Math.max(0, v.shift);
  /** nthAt solved without the table, for the pixels the table puts near or under `near`. */
  const exactNth = (fa: number, fb: number, n: number, near: number): number => {
    const ga = frac(fa), gb = frac(fb), vals: number[] = [];
    for (let c = 0; c < cand.length; c += 2) {
      const p = cand[c] + ga, q = cand[c + 1] + gb;
      const x = p * lat.ux - q * lat.uy, y = p * lat.uy + q * lat.ux;
      if (x > X || x < -X || y > Y || y < -Y) continue;
      if (entryAt(table, x, y) > near * 1.03) continue;
      const ax = Math.abs(x), ay = Math.abs(y);
      let late = 0;
      for (const [cs, sn] of FINE_ARC) { const e = entryScale(ax + shift * cs, ay + shift * sn, plot, v.sigma, v.threshold); if (e > late) late = e; }
      vals.push(late);
    }
    vals.sort((p1, p2) => p1 - p2);
    return n <= vals.length ? Math.min(cap, vals[n - 1]) : near;
  };

  // The sweep. An aligned lattice mirrors on both axes, a turned one only
  // through the centre: a quarter of the placements for one, half for the other.
  let m = SWEEP;
  const per = cand.length / 2;
  while (m > 4 && per * (lat.aligned ? (m / 2 + 1) ** 2 : (m / 2 + 1) * m) > WORK) m -= 2;
  const iMax = m / 2, jMax = lat.aligned ? m / 2 : m - 1;
  const cols = jMax + 1, cells = (iMax + 1) * cols;
  const swept = ns.map(n => (n >= 1 ? new Float64Array(cells) : null));
  for (let pi = 0; pi <= iMax; pi++) {
    for (let pj = 0; pj <= jMax; pj++) {
      const count = pointsAt(pi / m, pj / m);
      const sorted = buf.subarray(0, count).sort();
      for (let k = 0; k < ns.length; k++) {
        const at = swept[k];
        if (at) at[pi * cols + pj] = ns[k] <= count ? sorted[ns[k] - 1] : cap;
      }
    }
  }

  // The worst placement is the largest n-th entry scale; the best, the smallest.
  const dir = where === 'best' ? -1 : 1;
  return ns.map((n, k) => {
    const at = swept[k];
    if (!at) return null;
    // The climb, from the worst placements of the sweep that are not next to
    // each other: step to a placement that is worse still, in directions that
    // turn from one round to the next (the n-th smallest has ridges, and a
    // fixed set of directions stalls on them), shrinking the step when none is.
    // For the best placement the same climb goes the other way.
    const order = Array.from(at.keys()).sort((p, q) => dir * (at[q] - at[p]));
    const starts: number[] = [];
    for (const c of order) {
      if (starts.length >= STARTS) break;
      const ci = Math.floor(c / cols), cj = c % cols;
      if (starts.every(o => Math.abs(Math.floor(o / cols) - ci) > 1 || Math.abs((o % cols) - cj) > 1)) starts.push(c);
    }
    let worst = at[order[0]], wa = Math.floor(order[0] / cols) / m, wb = (order[0] % cols) / m;
    if (worst >= cap) return cap;
    for (const c of starts) {
      let fa = Math.floor(c / cols) / m, fb = (c % cols) / m, s = at[c];
      // Down to a thousandth of a pixel: past that the size no longer moves by a millimetre.
      for (let step = 0.7 / m, round = 0; round < 60 && step > 1e-3; round++) {
        let moved = false;
        // The lattice's own directions first: on an aligned grid the ridges
        // run along them, between two pixels at the same distance.
        for (let d = 0; d < 14; d++) {
          const ang = d < 8 ? (d * Math.PI) / 4 : round * 1.9416 + ((d - 8) * Math.PI) / 3;
          const na = fa + step * Math.cos(ang), nb = fb + step * Math.sin(ang);
          const val = nthAt(na, nb, n);
          if (dir * (val - s) > 1e-12) { s = val; fa = na; fb = nb; moved = true; break; }
        }
        if (!moved) step *= 0.6;
      }
      if (dir * (s - worst) > 0) { worst = s; wa = fa; wb = fb; }
    }
    // Within a CE90, the held table is read across a ridge where the worst landing turns from one
    // side to the other, and its bilinear reading came 0.1 to 0.2 m over (Neon, 2026-11-25): at the
    // placement found, the pixels are solved again, each at the latest of its landings.
    return shift > 0 ? exactNth(wa, wb, n, worst) : worst;
  });
}

/** The smallest plot of the same shape as `plot` that keeps at least `n` pure pixels: see `pureScales`. */
export function requiredScale(n: number, plot: Plot, v: Viewing): number | null {
  return pureScales(plot, v, [n])[0];
}

/**
 * Fewest pure pixels a plot holds over every placement of the pixel grid; for
 * a strip, fewest across it. `approx` when the plot holds so many pixels that
 * only a few placements could be tried, where one pixel more or less is noise.
 */
export function fewestPure(plot: Plot, v: Viewing): { count: number; approx: boolean } {
  const none = { count: 0, approx: false };
  if (plot.a === Infinity && plot.b !== Infinity) return fewestPure({ a: plot.b, b: Infinity }, v);
  if (!(v.gsd > 0) || !(plot.a > 0) || !(plot.b > 0) || !(v.threshold > 0) || !(v.threshold < 1)) return none;
  if (!(heldShare(0, 0, plot, v) >= v.threshold)) return none;
  if (plot.b === Infinity) {
    const half = edge(x => heldShare(x, 0, plot, v) >= v.threshold, plot.a / 2);
    return { count: Math.floor((2 * half) / v.gsd + 1e-6), approx: false };
  }
  const lat = lattice(v);
  const X = plot.a / 2, Y = plot.b / 2;
  const table = tableFor(plot, v, X, Y);
  const cand = candidates(lat, v.gsd, X, Y);
  const per = cand.length / 2;
  let m = SWEEP;
  while (m > 2 && per * (lat.aligned ? (m / 2 + 1) ** 2 : (m / 2 + 1) * m) > WORK) m -= 2;
  const iMax = m / 2, jMax = lat.aligned ? m / 2 : m - 1;
  let fewest = Infinity;
  for (let pi = 0; pi <= iMax && fewest > 0; pi++) {
    for (let pj = 0; pj <= jMax && fewest > 0; pj++) {
      // Off the symmetric placements by a hair: on them two pixels sit at the
      // same distance and are counted in or out together, which the placement
      // next to them does not do.
      const fa = pi / m + 1e-4, fb = pj / m + 1.7e-4;
      let count = 0;
      for (let c = 0; c < cand.length; c += 2) {
        const p = cand[c] + fa, q = cand[c + 1] + fb;
        const x = p * lat.ux - q * lat.uy, y = p * lat.uy + q * lat.ux;
        if (x > X || x < -X || y > Y || y < -Y) continue;
        if (entryAt(table, x, y) <= 1) count++;
      }
      if (count < fewest) fewest = count;
    }
  }
  let count = Number.isFinite(fewest) ? fewest : 0;
  const approx = m < 8;
  // A count over sampled placements can only err upwards. The size search
  // above finds the worst placement itself, so it has the last word, as long
  // as the count is small enough for one pixel to matter. It is read without
  // its margin: a plot set to the size the search returned must count as
  // holding what that size was asked for.
  for (let tries = 0; !approx && count > 0 && count <= SURE && tries < 6; tries++) {
    const need = pureScales(plot, v, [count])[0];
    if (need !== null && need <= MARGIN) break;
    count--;
  }
  return { count, approx };
}

/**
 * What the purest pixel of the plot keeps at the placement that is worst for
 * it. Its complement is what that pixel takes from outside the plot, which is
 * how far a plot too small for one pure pixel is from having one.
 */
export function purestShare(plot: Plot, v: Viewing): number {
  if (!(v.gsd > 0) || !(plot.a > 0) || !(plot.b > 0)) return 0;
  if (plot.a === Infinity && plot.b !== Infinity) return purestShare({ a: plot.b, b: Infinity }, v);
  if (plot.b === Infinity) return heldShare(v.gsd / 2, 0, plot, v);
  const { ux, uy, aligned } = lattice(v);
  const m = 16, iMax = m / 2, jMax = aligned ? m / 2 : m - 1;
  let worst = 1;
  for (let pi = 0; pi <= iMax; pi++) {
    for (let pj = 0; pj <= jMax; pj++) {
      const fa = pi / m, fb = pj / m;
      let best = 0;
      for (let i = -2; i <= 1; i++) {
        for (let j = -2; j <= 1; j++) {
          const p = i + fa, q = j + fb;
          const share = heldShare(p * ux - q * uy, p * uy + q * ux, plot, v);
          if (share > best) best = share;
        }
      }
      if (best < worst) worst = best;
    }
  }
  return worst;
}

/**
 * THE PUREST PIXEL OF THE WEAKEST PLOT of a trial as it stands on the grid
 * (2026-11-25): the plots by their centres in the grid's metres, all turned by
 * `v.angleDeg`, on a lattice whose pixel edges are at `edge` + k gsd. For each
 * plot, the best of the pixels within three of its centre, read in the plot's
 * own frame; then the plot whose best is worst. The plot-size card reads it at
 * the placement the engine gave the trial, so that it speaks of the map's trial.
 */
export function purestOfPlots(centres: [number, number][], plot: Plot, v: Viewing, edge: [number, number]): number {
  if (!centres.length || !(v.gsd > 0)) return 0;
  const g = v.gsd, t = (v.angleDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  let worst = 1;
  for (const [E, N] of centres) {
    const i0 = Math.floor((E - edge[0]) / g), j0 = Math.floor((N - edge[1]) / g);
    let best = 0;
    for (let i = i0 - 3; i <= i0 + 3; i++) {
      for (let j = j0 - 3; j <= j0 + 3; j++) {
        const dx = edge[0] + (i + 0.5) * g - E, dy = edge[1] + (j + 0.5) * g - N;
        const share = heldShare(dx * c + dy * s, -dx * s + dy * c, plot, v);
        if (share > best) best = share;
      }
    }
    if (best < worst) worst = best;
  }
  return worst;
}

/**
 * A TRIAL ON A KNOWN GRID: the plots of a trial laid along the pixel rows, by
 * their centres in the trial's own frame (m, x along the plots' `a` side), on
 * a lattice whose position is known, so that the whole trial can be put where
 * it does best. Each plot is counted where it falls: plots that are not a
 * whole number of pixels apart sit at different places on the lattice, and
 * the weakest of them is what the trial keeps in every plot.
 *
 * Returned: the fewest pure pixels any plot keeps, at the place on the grid
 * where that is the most (sampled over `m` x `m` positions of the trial within
 * a pixel, so it can only err low), and what the purest pixel of the weakest
 * plot keeps there. `approx` when the plots hold so many pixels that only a
 * few positions could be tried. For a strip (b = Infinity) the count is the
 * pixels across it, and only x is read.
 */
export function seatedTrial(centres: [number, number][], plot: Plot, v: Viewing): { count: number; keeps: number; approx: boolean; at: [number, number] } {
  const none = { count: 0, keeps: 0, approx: false, at: [0, 0] as [number, number] };
  if (!centres.length || !(v.gsd > 0) || !(plot.a > 0) || !(plot.b > 0) || !(v.threshold > 0) || !(v.threshold < 1)) return none;
  const g = v.gsd, strip = plot.b === Infinity;
  const X = plot.a / 2, Y = strip ? 0 : plot.b / 2;
  const nx = Math.ceil(X / g) + 1;
  // A strip: the half band within which a pixel centre is pure, as fewestPure finds it.
  const half = strip && heldShare(0, 0, plot, v) >= v.threshold ? edge(x => heldShare(x, 0, plot, v) >= v.threshold, plot.a / 2) : -1;
  const table = strip ? null : tableFor(plot, v, X, Y);
  // Pixel centres sit at (i + 1/2 - phase) g from a plot centre whose phase on the lattice is `phase`.
  // The pure pixels of a plot fill one region, symmetric on both axes and growing inwards (E rises
  // outwards), so a column of pixels at x is pure for |y| up to yTop(x): found once per x by halving,
  // and the column's pure pixels are then counted at once. The same test as entryAt(x, y) <= 1.
  const tops = new Map<number, number>();
  const yTop = (ax: number): number => {
    const key = Math.round(ax * 1e6);
    let top = tops.get(key);
    if (top !== undefined) return top;
    if (entryAt(table!, ax, 0) > 1) top = -1;
    else if (entryAt(table!, ax, Y) <= 1) top = Y;
    else {
      let lo = 0, hi = Y;
      for (let k = 0; k < 44; k++) { const mid = (lo + hi) / 2; if (entryAt(table!, ax, mid) <= 1) lo = mid; else hi = mid; }
      top = lo;
    }
    tops.set(key, top);
    return top;
  };
  const countAt = (px: number, py: number): number => {
    let n = 0;
    for (let i = -nx; i <= nx; i++) {
      const x = (i + 0.5 - px) * g;
      if (x > X || x < -X) continue;
      if (strip) { if (Math.abs(x) <= half) n++; continue; }
      const top = yTop(Math.abs(x));
      if (top < 0) continue;
      // Rows j with |(j + 1/2 - py) g| <= top.
      const j0 = Math.ceil(py - 0.5 - top / g - 1e-12), j1 = Math.floor(py - 0.5 + top / g + 1e-12);
      if (j1 >= j0) n += j1 - j0 + 1;
    }
    return n;
  };
  const purestAt = (px: number, py: number): number => {
    let best = 0;
    for (let i = -2; i <= 1; i++) {
      for (let j = strip ? 0 : -2; j <= (strip ? 0 : 1); j++) {
        const share = heldShare((i + 0.5 - px) * g, strip ? 0 : (j + 0.5 - py) * g, plot, v);
        if (share > best) best = share;
      }
    }
    return best;
  };
  // The places of the plots on the lattice, shared by every position of the trial: whole-pixel pitches give one.
  const pairs = strip ? [...new Set(centres.map(([x]) => +frac(x / g).toFixed(9)))].map(x => [x, 0] as [number, number])
    : [...new Set(centres.map(([x, y]) => `${+frac(x / g).toFixed(9)},${+frac(y / g).toFixed(9)}`))].map(k => k.split(',').map(Number) as [number, number]);
  // A strip is one axis: its positions are tried finely. A plot is tried on a grid of positions, then refined below.
  let m = strip ? 1024 : 32;
  while (m > 2 && m * (strip ? 1 : m) * pairs.length * (2 * nx + 1) > WORK) m -= 2;
  let most = -1, at: [number, number] = [0, 0];
  for (let a = 0; a < m; a++) {
    for (let b = 0; b < (strip ? 1 : m); b++) {
      // Off the symmetric positions by a hair, as in fewestPure.
      const sx = a / m + 1e-4, sy = strip ? 0 : b / m + 1.7e-4;
      let weakest = Infinity;
      for (const [px, py] of pairs) {
        const c = countAt(frac(px + sx), frac(py + sy));
        if (c < weakest) { weakest = c; if (weakest <= most) break; }
      }
      if (weakest > most) { most = weakest; at = [sx, sy]; }
    }
  }
  // THE REFINEMENT. At the smallest plot that keeps n pixels, the place on the grid that does it can be a
  // single point (four pixels in a square plot: its centre on a pixel corner), which positions 1/32 of a
  // pixel apart miss. The n-th smallest entry scale of a plot is continuous in its place on the grid, so
  // the largest over the plots is climbed down from the best positions tried, as pureScales climbs, and
  // one pixel more is counted wherever that brings it to 1 or under.
  // Only where the sweep was fine enough to start from and the count is small enough for a pixel to
  // matter, and within a budget of work (Neon, 2026-11-25: unbounded, large plots froze the page).
  if (!strip && most >= 0 && m >= 8 && most <= SURE) {
    const big = tableFor(plot, v, X * 1.15, Y * 1.15);
    const reachX = Math.ceil((1.15 * X) / g) + 1, reachY = Math.ceil((1.15 * Y) / g) + 1;
    const cells = (2 * reachX + 1) * (2 * reachY + 1);
    const buf = new Float64Array(cells);
    let spent = 0;
    const budget = 4 * WORK;
    const nth = (px: number, py: number, n: number): number => {
      let k = 0;
      spent += cells;
      for (let i = -reachX; i <= reachX; i++) {
        const x = (i + 0.5 - px) * g;
        for (let j = -reachY; j <= reachY; j++) {
          const e = entryAt(big, x, (j + 0.5 - py) * g);
          if (e < Infinity) buf[k++] = e;
        }
      }
      return n <= k ? kth(buf, k, n - 1) : 2;
    };
    /** The worst plot's n-th entry scale at a position; it stops at `cut`, past which the position is no better. */
    const late = (sx: number, sy: number, n: number, cut = Infinity) => {
      let w = 0;
      for (const [px, py] of pairs) { const e = nth(frac(px + sx), frac(py + sy), n); if (e > w) { w = e; if (w >= cut) break; } }
      return w;
    };
    for (let extra = 0; extra < 4 && spent < budget; extra++) {
      const n = most + 1, c = 8;
      // Starts: the lowest of a coarse sweep, a few that are not next to each other, and the place found so far.
      const sweep: [number, number, number][] = [];
      for (let a = 0; a < c; a++) for (let b = 0; b < c; b++) sweep.push([a / c, b / c, late(a / c, b / c, n)]);
      sweep.sort((p1, p2) => p1[2] - p2[2]);
      const starts: [number, number, number][] = [[at[0], at[1], late(at[0], at[1], n)]];
      for (const q of sweep) {
        if (starts.length > 3) break;
        if (starts.every(o => Math.abs(o[0] - q[0]) > 1.5 / c || Math.abs(o[1] - q[1]) > 1.5 / c)) starts.push(q);
      }
      let found: [number, number] | null = null;
      for (const [fa0, fb0, s0] of starts) {
        let fa = fa0, fb = fb0, val = s0;
        for (let step = 0.7 / c, round = 0; round < 60 && step > 1e-4 && val > 1 && spent < budget; round++) {
          let moved = false;
          for (let dd = 0; dd < 14; dd++) {
            const ang = dd < 8 ? (dd * Math.PI) / 4 : round * 1.9416 + ((dd - 8) * Math.PI) / 3;
            const na = fa + step * Math.cos(ang), nb = fb + step * Math.sin(ang), nv = late(na, nb, n, val - 1e-12);
            if (nv < val - 1e-12) { val = nv; fa = na; fb = nb; moved = true; break; }
          }
          if (!moved) step *= 0.6;
        }
        if (val <= 1) { found = [frac(fa), frac(fb)]; break; }
      }
      if (!found) break;
      // Counted at the place found, by the same test as the sweep: the climb's table is a little coarser.
      const weakest = Math.min(...pairs.map(([px, py]) => countAt(frac(px + found![0]), frac(py + found![1]))));
      if (weakest <= most) break;
      most = weakest; at = found;
    }
  }
  // Where no position keeps a pure pixel in every plot, the place that brings the weakest plot's purest pixel closest.
  const weakestPurest = (sx: number, sy: number) => Math.min(...pairs.map(([px, py]) => purestAt(frac(px + sx), frac(py + sy))));
  let keeps = weakestPurest(at[0], at[1]);
  if (most <= 0) {
    for (let a = 0; a < 16; a++) for (let b = 0; b < (strip ? 1 : 16); b++) keeps = Math.max(keeps, weakestPurest(a / 16, strip ? 0 : b / 16));
  }
  // `at`: where the trial was put, as the fraction of a pixel its own origin is moved by along x and y.
  return { count: Math.max(0, most), keeps, approx: m < 8, at };
}

/**
 * The radius of the circle, around a pixel's centre, that holds `share` of the
 * pixel's signal, when everything that spreads it is counted: a Gaussian blur
 * of `sigmaX` by `sigmaY` (the optics and the geolocation error together, in
 * metres) and the pixel's own footprint, a square of side `pixel` over which
 * the detector adds up what it receives.
 *
 * For a round Gaussian alone it is sigma * sqrt(-2 ln(1 - share)), 2.146 sigma
 * at 90 %. With the footprint, or a blur that is not round, there is no closed
 * form: the spread along each axis is the Gaussian run over the box, whose
 * cumulative is exact, so the signal is laid on a fine grid cell by cell with
 * no sampling error, and the cells are added up from the centre outwards.
 */
export function signalRadius(share: number, sigmaX: number, sigmaY: number, pixel = 0): number {
  if (!(share > 0) || !(share < 1)) return 0;
  const sx = Math.max(0, sigmaX), sy = Math.max(0, sigmaY), b = Math.max(0, pixel);
  if (!(sx > 0) && !(sy > 0) && !(b > 0)) return 0;
  // Integral of the normal CDF: H(z) = z Phi(z) + phi(z).
  const H = (z: number) => z * normCdf(z) + Math.exp(-0.5 * z * z) / 2.5066282746310002;
  /** Cumulative, along one axis, of a Gaussian of sigma `s` spread over a box of side `b`. */
  const cum = (x: number, s: number): number => {
    if (!(s > 0)) return b > 0 ? Math.max(0, Math.min(1, x / b + 0.5)) : (x >= 0 ? 1 : 0);
    if (!(b > 0)) return normCdf(x / s);
    return (s / b) * (H((x + b / 2) / s) - H((x - b / 2) / s));
  };
  const reach = 4.5 * Math.max(sx, sy) + b / 2;
  const N = 320, step = (2 * reach) / N;
  const axis = (s: number) => {
    const m = new Float64Array(N);
    for (let i = 0; i < N; i++) m[i] = cum(-reach + (i + 1) * step, s) - cum(-reach + i * step, s);
    return m;
  };
  const mx = axis(sx), my = axis(sy);
  // Rings of one cell's width, by the distance of each cell's centre.
  const rings = new Float64Array(Math.ceil(N * 0.75) + 2);
  for (let j = 0; j < N; j++) {
    const y = -reach + (j + 0.5) * step;
    for (let i = 0; i < N; i++) {
      const x = -reach + (i + 0.5) * step;
      rings[Math.min(rings.length - 1, Math.floor(Math.hypot(x, y) / step))] += mx[i] * my[j];
    }
  }
  let held = 0;
  for (let k = 0; k < rings.length; k++) {
    if (held + rings[k] >= share) return (k + (rings[k] > 0 ? (share - held) / rings[k] : 0)) * step;
    held += rings[k];
  }
  return reach;
}

/** One reading of the geolocation error. */
export interface ImageCase {
  id: 'corrected' | 'average' | 'robust';
  /** Sigma of the spot, m. */
  sigma: number;
  /** Radius the image may land within, m. */
  shift: number;
}

/**
 * The three readings, from the blur and the CE90. With no geolocation error
 * they are one and the same, and only the first is returned.
 */
export function imageCases(
  sigmaPsfM: number, ce90M: number,
  /** The geolocation sigma itself, when the CE90 given was rounded for display: the default is a third of a pixel exactly. */
  sigmaGeoM: number = ce90M / CE90_TO_SIGMA,
): ImageCase[] {
  if (!(ce90M > 0)) return [{ id: 'corrected', sigma: sigmaPsfM, shift: 0 }];
  return [
    { id: 'corrected', sigma: sigmaPsfM, shift: 0 },
    { id: 'average', sigma: Math.hypot(sigmaPsfM, sigmaGeoM), shift: 0 },
    { id: 'robust', sigma: sigmaPsfM, shift: ce90M },
  ];
}

/**
 * The plots of an imported trial as rectangles in the trial's own frame: each
 * plot's extent along the trial's rows and across them, to the decimetre, with
 * how many plots share it, smallest short side first. A plot that is not a
 * rectangle is read as the box around it, which flatters it.
 */
export function importedPlotBoxes(plan: Pick<ImportedPlan, 'plots'>, angleDeg: number): (Plot & { count: number })[] {
  const t = (-angleDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const seen = new Map<string, Plot & { count: number }>();
  for (const p of plan.plots) {
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const ring of p.rings) {
      for (const [x, y] of ring) {
        const u = x * c - y * s, w = x * s + y * c;
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (w < v0) v0 = w; if (w > v1) v1 = w;
      }
    }
    const a = Math.round((u1 - u0) * 10) / 10, b = Math.round((v1 - v0) * 10) / 10;
    if (!(a > 0) || !(b > 0)) continue;
    const key = `${a}_${b}`, had = seen.get(key);
    if (had) had.count++; else seen.set(key, { a, b, count: 1 });
  }
  return [...seen.values()].sort((p, q) => Math.min(p.a, p.b) - Math.min(q.a, q.b) || p.a * p.b - q.a * q.b);
}
