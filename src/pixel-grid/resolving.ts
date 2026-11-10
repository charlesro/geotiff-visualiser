import type { FieldSim } from './simulate';

/**
 * What the page reports about purity, and the one subtlety in it.
 *
 * The headline is PURE PIXELS: the count, and that count as a share of the
 * PLANTED AREA, the crop the design puts on the ground expressed in whole
 * pixels. "Of the crop you planted, this much comes back as a clean pixel."
 *
 * The denominator is the part that had to be got right, because the whole use of
 * the share is that a better placement shows up in it. Two denominators that
 * look equivalent are not, and both move with the placement: the COUNT of pixels
 * with crop in them, and the crop summed while skipping pixels more than half
 * off-trial. Against a 10.2% gain in pure pixels they reported one point and
 * three points. Summing every crop fraction in the window reports the gain
 * itself: +4.1% against +4.1%, +29.3% against +29.2%. See plantedPixels.
 *
 * KNOWN AND ACCEPTED: the share is still not monotone in pixel size, because
 * purity genuinely is not. The COUNT beside it is what does not mislead, which
 * is why the two are always printed together and never the share alone.
 *
 * `contrastInfo` below is a second, threshold-free reading kept for the tooltip:
 * what the MIXED pixels are worth once they are unmixed. It is deliberately not
 * the headline. It credits information that only a linear unmixing with a known
 * design matrix recovers, and an agronomist who averages the clean pixels in
 * each plot does not get it. It is also the only thing here that can see two
 * varieties being impossible to tell apart, which no pure-pixel count can.
 *
 * Its estimand is variety DIFFERENCES, not levels, and that is load-bearing.
 * Measured against a design where two varieties are dialled into each other, a
 * level-based score still reads 33% once the worst comparison's variance has
 * inflated 500,000-fold, and then RISES to 166% when that comparison dies
 * outright, because the pseudo-inverse silently drops the direction that became
 * unestimable. The contrast-based score reads 0.1%, then reports it dead.
 */

/**
 * Cyclic Jacobi eigenvalue decomposition for a small SYMMETRIC matrix.
 *
 * Everything here is at most (species + 3) on a side, so an O(n^3) sweep that
 * is obviously correct beats anything faster. Returns eigenvalues with their
 * vectors as COLUMNS of `vectors`, which is what the pseudo-inverse needs.
 *
 * Symmetric input is a precondition, not a request: every matrix this file
 * builds is a Gram matrix (X'X) or a congruence of one, so it holds by
 * construction and is never re-checked at runtime.
 */
function jacobi(input: number[][], n: number): { values: number[]; vectors: number[][] } {
  const a = input.map(r => r.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off <= 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i][i]), vectors: v };
}

/**
 * Moore-Penrose pseudo-inverse of a small symmetric matrix.
 *
 * A true inverse is not safe here. The nuisance block below can be exactly
 * singular for a real design: with no alleys the bare column is identically
 * zero, and with no crop at all the bare and off-trial columns sum to the
 * intercept. Directions at or below the tolerance are dropped rather than
 * inverted, which is the right thing for a NUISANCE block (the fit simply does
 * not adjust for a direction the data cannot see). It would be the wrong thing
 * for the contrast block, which is why that one is tested for collapse instead.
 */
function pinvSym(m: number[][], n: number): number[][] {
  const { values, vectors } = jacobi(m, n);
  const max = Math.max(...values.map(Math.abs), 0);
  const tol = 1e-12 * (max || 1);
  const out: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let k = 0; k < n; k++) {
    if (Math.abs(values[k]) <= tol) continue;
    const inv = 1 / values[k];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i][j] += vectors[i][k] * inv * vectors[j][k];
  }
  return out;
}

/**
 * Orthonormal Helmert basis: an S x (S-1) matrix whose columns span every
 * difference between varieties and contain no overall level.
 *
 * Working in this subspace is what makes the score about telling varieties
 * apart. The overall level, which the soil endmember and the season both move,
 * is orthogonal to it and cannot flatter the answer.
 */
function helmert(S: number): number[][] {
  const H: number[][] = Array.from({ length: S }, () => new Array(S - 1).fill(0));
  for (let k = 1; k < S; k++) {
    const col = new Array(S).fill(0);
    for (let i = 0; i < k; i++) col[i] = 1 / k;
    col[k] = -1;
    const norm = Math.hypot(...col);
    for (let i = 0; i < S; i++) H[i][k - 1] = col[i] / norm;
  }
  return H;
}

/** What `contrastInfo` measured, before it is turned into a percentage. */
export interface ContrastInfo {
  /**
   * Contrast-effective pixels per variety: the number of PERFECTLY PURE pixels
   * per variety that would estimate the variety differences just as precisely.
   * Mean Var(b_i - b_j) = 2 * sigma^2 / nEff over the pairwise differences.
   */
  nEff: number;
  /** Some variety pair cannot be told apart at all; `nEff` is then 0. */
  dead: boolean;
  /** Trial pixels the figure was measured over (more than half off-trial excluded). */
  total: number;
}

/**
 * A-optimality on the variety contrasts, from the mixture the engine already
 * produced.
 *
 * Model: a pixel's value is the mixture of what is under it,
 *     y_i = sum_s T_is b_s + Z_i g + noise
 * with T the per-species fractions and Z the nuisances (an intercept, the bare
 * soil share and the off-trial share). Sweeping Z out gives the information
 * that is genuinely about the varieties,
 *     C = T'T - T'Z (Z'Z)^+ Z'T
 * and restricting to the contrast subspace gives C_h = H'CH, whose harmonic
 * mean eigenvalue is exactly the A-optimal score on the pairwise differences.
 *
 * The soil column is what makes this fair. Alley soil is COMMON MODE: it dilutes
 * every plot alike, so a design should not be punished twice for it. A
 * neighbouring VARIETY is not common mode, and sweeping out the soil leaves that
 * contamination fully charged.
 */
export function contrastInfo(args: {
  /** Per-pixel species fractions at [k * nSpecies + s]. */
  species: Float32Array | null;
  bare: Float32Array;
  offTrial: Float32Array | null;
  nSpecies: number;
  /** Pixel count; `bare.length` unless a caller is measuring a subset. */
  count: number;
}): ContrastInfo {
  const { species, bare, offTrial, nSpecies: S, count } = args;
  // A design with fewer than two varieties has no difference to estimate, and a
  // window with no trial pixels has nothing to measure. Both are real: a 1.5 m
  // plot at 10 m leaves an empty window, which is exactly the regime where the
  // answer matters, so they return a labelled zero rather than throwing.
  if (!species || S < 2 || count <= 0) return { nEff: 0, dead: true, total: 0 };

  const NZ = 3;                                    // intercept, bare, off-trial
  const TtT: number[][] = Array.from({ length: S }, () => new Array(S).fill(0));
  const TtZ: number[][] = Array.from({ length: S }, () => new Array(NZ).fill(0));
  const ZtZ: number[][] = Array.from({ length: NZ }, () => new Array(NZ).fill(0));
  const zMass = new Array(NZ).fill(0);
  const t = new Float64Array(S), z = new Float64Array(NZ);
  let total = 0;

  for (let k = 0; k < count; k++) {
    const off = offTrial ? offTrial[k] : 0;
    if (off > 0.5) continue;                       // the same rule coverStats uses
    total++;
    for (let s = 0; s < S; s++) t[s] = species[k * S + s];
    z[0] = 1; z[1] = bare[k]; z[2] = off;
    for (let i = 0; i < NZ; i++) zMass[i] += Math.abs(z[i]);
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < S; j++) TtT[i][j] += t[i] * t[j];
      for (let j = 0; j < NZ; j++) TtZ[i][j] += t[i] * z[j];
    }
    for (let i = 0; i < NZ; i++) for (let j = 0; j < NZ; j++) ZtZ[i][j] += z[i] * z[j];
  }
  if (total === 0) return { nEff: 0, dead: true, total: 0 };

  // Drop a nuisance carrying less than one pixel's worth of mass rather than
  // refusing to answer. With no alleys the bare column is identically zero, and
  // a contiguous drill trial with no alley is perfectly estimable: declaring it
  // unidentifiable because of an all-zero nuisance would be a false alarm on a
  // design that is fine.
  const keep: number[] = [];
  for (let i = 0; i < NZ; i++) if (zMass[i] > 1e-9) keep.push(i);
  const nz = keep.length;

  const C: number[][] = TtT.map(r => r.slice());
  if (nz > 0) {
    const Zg = keep.map(a => keep.map(b => ZtZ[a][b]));
    const Zi = pinvSym(Zg, nz);
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < S; j++) {
        let acc = 0;
        for (let a = 0; a < nz; a++) for (let b = 0; b < nz; b++) acc += TtZ[i][keep[a]] * Zi[a][b] * TtZ[j][keep[b]];
        C[i][j] -= acc;
      }
    }
  }

  const H = helmert(S), D = S - 1;
  const Ch: number[][] = Array.from({ length: D }, () => new Array(D).fill(0));
  for (let p = 0; p < D; p++) {
    for (let q = 0; q < D; q++) {
      let acc = 0;
      for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) acc += H[i][p] * C[i][j] * H[j][q];
      Ch[p][q] = acc;
    }
  }

  const { values } = jacobi(Ch, D);
  const lmax = Math.max(...values);
  // A collapsed eigenvalue is a variety comparison that the imagery cannot make
  // at all. Reported as dead rather than as a very small number, because the
  // pseudo-inverse would otherwise drop it and the score would RISE.
  if (!(lmax > 0) || values.some(v => v <= 1e-9 * lmax)) return { nEff: 0, dead: true, total };
  let harm = 0;
  for (const v of values) harm += 1 / v;
  return { nEff: D / harm, dead: false, total };
}

/** `contrastInfo` read straight off a simulation. */
export function simContrastInfo(sim: FieldSim): ContrastInfo {
  return contrastInfo({
    species: sim.proportionBySpecies,
    bare: sim.proportionBare,
    offTrial: sim.proportionOffTrial,
    nSpecies: sim.nSpecies,
    count: sim.mixed.length,
  });
}

/**
 * Planted pixels: the crop area the design actually puts on the ground, in units
 * of whole pixels, summed straight off the mixture the engine produced.
 *
 * This is the denominator, and getting it wrong twice is what it took to get it
 * right. The point of the share is that a better placement should show up in it,
 * and a denominator that moves with the placement cannot do that.
 *
 *  - The COUNT of pixels with crop in them moved 6.7% when the trial was staked
 *    onto the pixel grid, so a 10.2% gain in pure pixels read as one point.
 *  - Summing crop but SKIPPING pixels more than half off-trial (the rule
 *    coverStats uses for the numerator) still moved it: a turned trial has more
 *    half-off edge pixels, so more of its crop was dropped, and the same gain
 *    read as 3% instead of 10%.
 *
 * Every crop fraction in the measured window counts here, off-trial edge pixels
 * included. A pixel being mostly outside the trial does not mean the crop under
 * it was never planted, and the numerator is unaffected either way because such
 * a pixel can never BE pure. Measured against the plot geometry, this lands on
 * it: 2000.2 and 2000.0 pixels for two placements of a design that plants
 * exactly 2000 pixels' worth, where the skipping rule gave 1953 and 1972. The
 * share then moves with the count, +4.1% against +4.1%, +29.3% against +29.2%.
 *
 * What it does NOT include is crop outside the measured window, which is right:
 * a trial hanging out of its field is not credited with the part that is not in
 * the field.
 */
export function plantedPixels(args: {
  species: Float32Array | null;
  /** Unused; kept so callers need not know which rule this applies. */
  offTrial?: Float32Array | null;
  nSpecies: number;
  count: number;
}): number {
  const { species, nSpecies: S, count } = args;
  if (!species || S < 1) return 0;
  let planted = 0;
  for (let k = 0; k < count; k++) for (let s = 0; s < S; s++) planted += species[k * S + s];
  return planted;
}

/** The headline pair the page prints. */
export interface Resolving {
  /** Pure single-crop pixels: the count on the panel. */
  pure: number;
  /** The planted crop area in whole pixels: the share's denominator. */
  planted: number;
  /** Every trial pixel, so the alley and edge share stays readable. */
  total: number;
  /**
   * 100 * pure / planted, or null when there is less than ONE PIXEL's worth of
   * crop to take a share of. A 4 m plot trial at 60 m pixels plants a tenth of a
   * pixel; dividing by that is not a percentage, and printing the 0% it produces
   * would send the reader after a finer sensor when the plots are what is too
   * small. The count beside it reads 0 either way.
   */
  pct: number | null;
  /**
   * Tooltip only: the clean pixels per variety that would estimate the variety
   * DIFFERENCES as precisely, once the mixed pixels are unmixed (contrastInfo).
   * Never the headline; it credits information only a linear unmixing recovers.
   */
  nEff: number;
  /** Two varieties cannot be told apart at all at this pixel size. */
  dead: boolean;
}

/**
 * How much of the design's crop a window has to hold before the design's own
 * planted area may be used as the denominator.
 *
 * A rung over a large field is measured on a CENTRAL SAMPLE, not the whole
 * trial, and a sample holds a fraction of the crop. Dividing a sample's pure
 * pixels by the whole design's planted area is how the 0.5 m rung came to read
 * 12% under a 2 m rung reading 77%. Below this share the window is a sample and
 * can only speak for the crop inside it; above it, the window holds the trial
 * and the constant denominator is both available and what makes the share
 * proportional to the count. A trial that merely spills over its field edge
 * lands well above the line (0.94 on the measured design) and is still charged
 * for the crop it loses, which is the point.
 */
const PLANTED_COVERAGE = 0.8;

/**
 * THE rule for a purity share, in one place: pure pixels over the crop the
 * design plants.
 *
 * `geo` is the planted area from the design's own geometry (plantedAreaPx), a
 * constant for a design and a pixel size, which is what makes the share exactly
 * proportional to the pure count. It is used when the measured window actually
 * holds the trial; a sampled window holds a fraction of it and is divided by
 * the crop it can see (`measured`) instead. Below one pixel of crop there is
 * nothing to take a share of, and the answer is null rather than 0%.
 *
 * Every share this page prints goes through here: the ladder's rung, each of
 * its geolocation samples, and pureEfficiency. They used to carry three copies
 * of this rule, and the geolocation range is only in the same units as the
 * share it qualifies for as long as they cannot drift apart.
 */
export function plantedShare(pure: number, measured: number, geo: number | null): { planted: number; pct: number | null } {
  const planted = geo != null && geo > 0 && measured >= PLANTED_COVERAGE * geo ? geo : measured;
  return { planted, pct: planted >= 1 ? Math.max(0, Math.min(100, (100 * pure) / planted)) : null };
}

/**
 * Pure pixels, as a share of the crop area the design plants.
 *
 * `plantedPx` is that area from the design's own geometry (plantedAreaPx), a
 * CONSTANT for a design and a pixel size, which is what makes the share exactly
 * proportional to the pure count. It is used when this window actually holds
 * the trial; on a sampled window, and for a periodic pattern that has no trial
 * distinct from the ground it covers, the crop the simulation can see is summed
 * instead.
 */
export function pureEfficiency(sim: FieldSim, plantedPx: number | null): Resolving {
  const info = simContrastInfo(sim);
  const measured = plantedPixels({
    species: sim.proportionBySpecies, offTrial: sim.proportionOffTrial,
    nSpecies: sim.nSpecies, count: sim.mixed.length,
  });
  const { planted } = plantedShare(sim.pureCrop, measured, plantedPx);
  return {
    pure: sim.pureCrop,
    planted,
    total: sim.total,
    pct: plantedShare(sim.pureCrop, measured, plantedPx).pct,
    nEff: info.nEff,
    dead: info.dead,
  };
}

// ===== geolocation, per-plot verdict and the note's closed form ==============

/**
 * CE90 to a per-axis sigma. A circular normal error of sigma per axis has a
 * Rayleigh radial miss, so the radius holding 90 % of it is sigma*sqrt(-2 ln 0.1).
 * The Geoloc figure is a CE90 EVERYWHERE on the page: the blur budget divides it
 * by this, and the robust set below uses it as the radius 9 images in 10 land in.
 */
export const CE90_TO_SIGMA = 2.1460;

/** Cover ids at or below this are plots or species; above it are the sentinels. */
const MAX_CROP_COVER = 252;

/**
 * Inverse of the standard normal CDF (Acklam's rational approximation, about
 * 1e-9 relative). Only the closed form below needs it.
 */
export function probit(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -probit(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Buffer width in units of the effective sigma: a pixel is pure once its centre
 * sits this many sigmas inside the plot edge. Q(k) = 1 - threshold, so 1.28 at
 * 90 % and 1.64 at 95 %.
 */
export const bufferK = (threshold: number): number => -probit(1 - Math.max(0.5, Math.min(0.999, threshold)));

/**
 * The smallest plot side that keeps at least one pure pixel wherever the grid
 * falls, by the PHENET note's closed form (any-pixel criterion):
 *
 *   L_min = GSD + 2 * z * sigma_eff,   z = Q^-1(1 - sqrt(threshold))
 *
 * The purest pixel is the one nearest the plot centre, at worst half a pixel
 * away on each axis (the GSD term), and it needs F(x)F(y) >= threshold, so each
 * axis needs sqrt(threshold). 1.632 at 90 %. Checked against the note's own
 * table (PlanetScope 16.8 m, Sentinel-2 32.2 m) in the regression suite.
 */
export function minPlotSideM(res: number, sigmaEffM: number, threshold: number): number | null {
  if (!(res > 0) || !(sigmaEffM > 0) || !(threshold > 0) || !(threshold < 1)) return null;
  return res + 2 * -probit(1 - Math.sqrt(threshold)) * sigmaEffM;
}

/**
 * Where the imagery can land: `n` shifts on the circle of radius CE90.
 *
 * NOT clamped to half a pixel, unlike a count. A count is periodic in the
 * lattice, so past half a pixel it stops changing. A pixel chosen by its
 * coordinates is not: one whole pixel of shift hands it its neighbour's ground.
 * The boundary is enough because a plot's pure region is convex (a superlevel
 * set of a log-concave share), so a disc lies inside it as soon as its rim does.
 */
export function ce90Shifts(ce90M: number, n = 8): [number, number][] {
  if (!(ce90M > 0) || n < 1) return [];
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return [ce90M * Math.cos(t), ce90M * Math.sin(t)] as [number, number];
  });
}

/**
 * The pixels that are pure for the SAME cover at every placement: 1 where the
 * nominal verdict is a crop cover and every shifted verdict is that same cover.
 * A pixel pure for plot A at one placement and plot B at another is not robust,
 * it has changed plots. All arrays index the same lattice pixels.
 */
export function robustMask(nominal: ArrayLike<number>, shifted: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(nominal.length);
  for (let k = 0; k < nominal.length; k++) {
    const id = nominal[k];
    if (id > MAX_CROP_COVER) continue;
    let ok = 1;
    for (let s = 0; s < shifted.length; s++) if (shifted[s][k] !== id) { ok = 0; break; }
    out[k] = ok;
  }
  return out;
}

/** Pure pixels per plot: what a variety trial is actually read by. */
export interface PlotTally {
  plots: number;
  /** Fewest and median pure pixels in a plot. */
  min: number;
  median: number;
  /** Plots with no pure pixel at all: these cannot be followed. */
  none: number;
}

/**
 * Count pure pixels plot by plot. `verdict[k]` is the engine's own byte (the
 * dominant cover id, which IS the plot id on a block or imported trial), and
 * `mask`, when given, keeps only the pixels it marks (the robust set).
 */
export function plotTally(verdict: ArrayLike<number>, nPlots: number, mask?: ArrayLike<number> | null): PlotTally | null {
  if (!(nPlots > 0) || nPlots > MAX_CROP_COVER + 1) return null;
  const per = new Uint32Array(nPlots);
  for (let k = 0; k < verdict.length; k++) {
    const id = verdict[k];
    if (id < nPlots && (!mask || mask[k])) per[id]++;
  }
  const sorted = Array.from(per).sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return {
    plots: nPlots,
    min: sorted[0],
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    none: sorted.filter(v => v === 0).length,
  };
}
