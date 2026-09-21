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
  const planted = plantedPx != null && plantedPx > 0 && measured >= PLANTED_COVERAGE * plantedPx
    ? plantedPx
    : measured;
  return {
    pure: sim.pureCrop,
    planted,
    total: sim.total,
    pct: planted >= 1 ? Math.max(0, Math.min(100, (100 * sim.pureCrop) / planted)) : null,
    nEff: info.nEff,
    dead: info.dead,
  };
}
