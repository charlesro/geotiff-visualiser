import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import type { LngLatBounds, S2Grid } from './s2-grid';

/**
 * Mixed-pixel simulator — a faithful port of github.com/charlesro/intercrop-simulator's
 * engine (makeTruth / makeBetaSchedule / simulate / cultureForCell / aggregate),
 * driven over the real Sentinel-2 / satellite pixel grid instead of an abstract
 * one. The sensor pixels are the actual grid cells (axis-aligned in UTM); the
 * planting pattern is sampled on a fine grid (GSD ÷ stride) at metre strip
 * widths, then aggregated with the repo's SUB=4 sub-sampling + Gaussian PSF and
 * classified with its majority / mixed-threshold rule.
 *
 * The functions below the "// ===== repo engine" marker are reproduced verbatim
 * from the repo (only typed and with the mixed threshold exposed as a param).
 */

// ===== repo constants & types ================================================

export const TMAX = 366;
export const DEFAULT_PARS: number[] = [0.78, 0.117, 104, 0.078, 221, 198];

export type TruthType = 'double' | 'sine' | 'linear' | 'const';
export type PatternType = 'row' | 'col' | 'checker' | 'strip-row-2' | 'strip-col-2' | 'block';

export const TRUTH_TYPES: { id: TruthType; label: string }[] = [
  { id: 'double', label: 'Double logistic' },
  { id: 'sine', label: 'Sine wave' },
  { id: 'linear', label: 'Linear ramp' },
  { id: 'const', label: 'Constant' },
];

export const PATTERNS: { id: PatternType; label: string }[] = [
  { id: 'row', label: 'Alternating rows (1:1)' },
  { id: 'col', label: 'Alternating columns (1:1)' },
  { id: 'checker', label: 'Checkerboard' },
  { id: 'strip-row-2', label: 'Strip rows (2:2)' },
  { id: 'strip-col-2', label: 'Strip columns (2:2)' },
  { id: 'block', label: 'Randomised blocks (RCBD)' },
];

/** One field's parameters — the repo's per-field set, plus name/colour for UI. */
export interface FieldParams {
  name: string;
  color: string;
  truth: TruthType;
  /** Double-logistic pars [L1, k1, x01, k2, x02, tc]. */
  L1: number; k1: number; x01: number; k2: number; x02: number; tc: number;
}

export interface CropPreset extends FieldParams { id: string; }

// Okabe–Ito high-contrast, colour-blind-safe palette (A orange vs B blue by default).
export const CROP_PRESETS: CropPreset[] = [
  { id: 'maize',   name: 'Maize',          color: '#e69f00', truth: 'double', L1: 0.85, k1: 0.12,  x01: 150, k2: 0.10,  x02: 270, tc: 215 },
  { id: 'wheat',   name: 'Winter wheat',   color: '#0072b2', truth: 'double', L1: 0.72, k1: 0.09,  x01: 60,  k2: 0.12,  x02: 175, tc: 135 },
  { id: 'soy',     name: 'Soybean',        color: '#009e73', truth: 'double', L1: 0.78, k1: 0.11,  x01: 165, k2: 0.11,  x02: 280, tc: 225 },
  { id: 'beet',    name: 'Sugar beet',     color: '#cc79a7', truth: 'double', L1: 0.85, k1: 0.07,  x01: 120, k2: 0.06,  x02: 300, tc: 215 },
  { id: 'grass',   name: 'Grass / alfalfa',color: '#56b4e9', truth: 'double', L1: 0.65, k1: 0.15,  x01: 80,  k2: 0.03,  x02: 330, tc: 205 },
  { id: 'default', name: 'Default (repo)', color: '#d55e00', truth: 'double', L1: 0.78, k1: 0.117, x01: 104, k2: 0.078, x02: 221, tc: 198 },
];

export const cropById = (id: string): CropPreset => CROP_PRESETS.find(c => c.id === id) ?? CROP_PRESETS[0];

export const parsOf = (f: FieldParams): number[] => [f.L1, f.k1, f.x01, f.k2, f.x02, f.tc];

// ===== repo engine (verbatim, typed) =========================================

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

const doubleLogisticRaw = (t: number, pars: number[]) => {
  const [L1, k1, x01, k2, x02, tc] = pars;
  const g = L1 / (1 + Math.exp(-k1 * (t - x01)));
  const d = -L1 / (1 + Math.exp(-k2 * (t - x02))) + L1;
  const b = 1 / (1 + Math.exp(-(t - tc) / 2.5));
  return (1 - b) * g + b * d;
};

const doubleLogistic = (t: number, pars: number[]) => {
  const P = 365;
  const val = doubleLogisticRaw(t, pars) + doubleLogisticRaw(t - P, pars) + doubleLogisticRaw(t + P, pars);
  return clamp(val, 1e-9, 1 - 1e-9);
};

export function makeTruth(kind: TruthType, T: number, pars: number[]): Float64Array {
  const a = new Float64Array(T);
  if (kind === 'const') {
    a.fill(0.5);
  } else if (kind === 'linear') {
    for (let i = 0; i < T; i++) a[i] = 0.2 + 0.6 * (i / (T - 1));
  } else if (kind === 'sine') {
    for (let i = 0; i < T; i++) {
      const th = (2 * Math.PI * i) / 365;
      a[i] = 0.5 + 0.4 * Math.sin(th);
    }
    for (let i = 0; i < T; i++) a[i] = clamp(a[i], 1e-9, 1 - 1e-9);
  } else {
    for (let i = 0; i < T; i++) a[i] = doubleLogistic(i, pars);
  }
  return a;
}

export function makeBetaSchedule(T: number, alpha: number, beta: number, magnitude: number): Float64Array {
  const out = new Float64Array(T);
  let maxVal = 0;
  for (let t = 0; t < T; t++) {
    const x = (t + 0.5) / T;
    const val = Math.pow(x, alpha - 1) * Math.pow(1 - x, beta - 1);
    out[t] = val;
    if (val > maxVal) maxVal = val;
  }
  if (maxVal > 1e-9) {
    const scale = magnitude / maxVal;
    for (let t = 0; t < T; t++) out[t] *= scale;
  } else {
    out.fill(magnitude);
  }
  return out;
}

/** d3.randomLcg, inlined (seeded LCG). */
function randomLcg(seed: number): () => number {
  const eps = 1 / 0x100000000;
  let state = 0 <= seed && seed < 1 ? seed / eps : Math.abs(seed);
  return () => {
    state = (Math.imul(0x19660d, state) + 0x3c6ef35f) | 0;
    return eps * (state >>> 0);
  };
}

export function simulate(
  truth: Float64Array | number[],
  varPx: Float64Array | number[],
  { n = 100, seed = 12345 }: { n?: number; seed?: number } = {},
): Float64Array[] {
  const T = truth.length | 0;
  const N = n | 0;
  const eps = 1e-9;
  const rng = randomLcg(seed ?? 0.1234567);

  const normals = Array.from({ length: N }, () => {
    let u = 0, v = 0, s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
  });

  const sig = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const m = +(truth as any)[t];
    const vmax = Math.max(0, m * (1 - m) * (1 - 1e-8));
    const v = Math.max(0, Math.min(+(varPx as any)[t], vmax));
    sig[t] = Math.sqrt(v);
  }

  const out: Float64Array[] = Array.from({ length: N }, () => new Float64Array(T));
  for (let i = 0; i < N; i++) {
    const z = normals[i];
    const s = out[i];
    for (let t = 0; t < T; t++) {
      const m = +(truth as any)[t];
      const x = m + sig[t] * z;
      s[t] = Math.min(1 - eps, Math.max(eps, x));
    }
  }
  return out;
}

export const cultureForCell = (r: number, c: number, mode: PatternType): number => {
  // Positive modulo, because JavaScript's % keeps the sign of the dividend:
  // -1 % 2 is -1, not 1. The pattern is periodic over ALL integers, and the map
  // overlay indexes strips from a rotated frame whose origin sits inside the
  // field — so r and c go negative there. A returned -1 matched neither crop id
  // and painted the strip bare-soil brown, which is what made crop B vanish at
  // large rotations. Identical to the old expression for r, c >= 0, which is the
  // only range `aggregate` uses.
  const alt = (n: number) => ((n % 2) + 2) % 2;
  switch (mode) {
    case 'row': return alt(r);
    case 'col': return alt(c);
    case 'checker': return alt(r + c);
    case 'strip-row-2': return alt(Math.floor(r / 2));
    case 'strip-col-2': return alt(Math.floor(c / 2));
    default: return 0;
  }
};

/** Bare-soil gap (alley) inserted between strips — a third land cover. */
/**
 * Land-cover sentinels. Species and plot ids are CONTIGUOUS from 0, so the
 * markers sit at the top of the byte. BARE used to be id 2, which IS the third
 * species: a four-species design silently painted species three as bare soil,
 * counted it as bare in the purity totals and gave it bare soil's NDVI in the
 * PCA. Keep every comparison by symbol, never by the literal.
 */
export const MIXED = 255;
export const BARE = { id: 254, color: '#8a7355', ndvi: 0.13 } as const;
/**
 * Ground inside the drawn area but outside a finite trial. NOT the same as an
 * alley: alley soil really does dilute the pixel a sensor reads, while ground
 * nobody planted must not drag the headline purity down just because the user
 * drew a bigger box, so it is excluded from the denominator instead.
 */
export const OFF_TRIAL = { id: 253, color: '#3b3b3b', ndvi: BARE.ndvi } as const;
/** Highest usable species / plot id; everything above is a sentinel. */
export const MAX_COVER = 252;

export interface AggregateResult {
  rowsAgg: number;
  colsAgg: number;
  cropMapMixed: Uint8Array;
  cropMapMajority: Uint8Array;
  cropMapCenter: Uint8Array;
  cropMapProportionA: Float32Array;
  cropMapProportionBare: Float32Array;
  simsGrid: Float64Array[];
  /**
   * Per-species composition, present only when the caller passes nSpecies > 0.
   * `cropMapProportionA` alone is lossy with more than two species: a pixel of
   * 25% each of four species and one of 25%/75% of two both report 0.25, and
   * every consumer rebuilds the rest as 1 - pA - pBare. Species s of pixel k is
   * at cropMapSpecies[k * nSpecies + s].
   */
  cropMapSpecies: Float32Array | null;
  /** Dominant SPECIES index per pixel (not the dominant cover id). */
  cropMapDominant: Uint8Array | null;
  /** That species' fraction of all cover in the pixel, alley soil included. */
  cropMapDominantFrac: Float32Array | null;
  /** Dominant PLOT id per pixel, so per-plot coverage can be counted. */
  cropMapDominantPlot: Uint16Array | null;
  cropMapProportionOffTrial: Float32Array | null;
}

/** One tally of what a set of pixels covers, shared by every caller. */
export interface CoverStats {
  /** Pixels that actually sample the trial (off-trial ones are not counted). */
  total: number;
  pureCrop: number;
  purePct: number;
  pureBySpecies: Uint32Array;
  pureBare: number;
  mixedCount: number;
  offTrial: number;
}

/**
 * Count pure pixels ONCE. This used to be spelled out in three places, each
 * enumerating `=== 0 / === 1 / === BARE.id`, so a third species fell through
 * every branch and the headline number silently understated a resolved design.
 * A pixel counts as pure when its dominant cover clears the threshold that
 * `aggregate` already applied (anything not MIXED, BARE or OFF_TRIAL).
 */
export function coverStats(args: {
  mixed: Uint8Array;
  /** Maps a cover id to a species; omit when a cover id IS the species. */
  coverSpecies?: Uint8Array | null;
  nSpecies?: number;
  /** Per-pixel off-trial fraction; a pixel more than half off-trial is skipped. */
  offTrial?: Float32Array | null;
}): CoverStats {
  const { mixed, coverSpecies = null, offTrial = null } = args;
  const nSp = Math.max(2, args.nSpecies ?? 2);
  const pureBySpecies = new Uint32Array(nSp);
  let total = 0, pureCrop = 0, pureBare = 0, mixedCount = 0, off = 0;
  for (let k = 0; k < mixed.length; k++) {
    if (offTrial && offTrial[k] > 0.5) { off++; continue; }
    total++;
    const id = mixed[k];
    if (id === MIXED) { mixedCount++; continue; }
    if (id === BARE.id) { pureBare++; continue; }
    if (id === OFF_TRIAL.id) { off++; total--; continue; }
    const s = coverSpecies ? coverSpecies[id] : id;
    if (s < nSp) pureBySpecies[s]++;
    pureCrop++;
  }
  return { total, pureCrop, purePct: total ? (100 * pureCrop) / total : 0, pureBySpecies, pureBare, mixedCount, offTrial: off };
}

/**
 * Verbatim port of the repo's `aggregate` (PSF + SUB=4 sub-sampling + rotation
 * + majority/mixed classification). The only change: the mixed threshold is a
 * parameter (`mixThreshold`, default 0.8 = the repo's literal).
 */
export function aggregate(
  simsGrid: Float64Array[],
  rows: number,
  cols: number,
  stride: number,
  sigmaX: number,
  sigmaY: number,
  includeOutside: boolean,
  rotationDeg: number,
  cropMap: Uint8Array,
  mixThreshold = 0.8,
  /** PSF centre offset from the pixel centre, in PIXELS (+x east, +y north). */
  offX = 0,
  offY = 0,
  /**
   * Maps a cover id in `cropMap` to a species index. A block design puts PLOT
   * ids in the cover map so per-plot coverage can be counted; everything else
   * leaves this null, where a cover id is already the species.
   */
  coverSpecies: Uint8Array | null = null,
  /** Number of species. 0 (the default) skips the per-species channel entirely. */
  nSpecies = 0,
): AggregateResult {
  const angle = (rotationDeg * Math.PI) / 180;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  const absCos = Math.abs(cosA);
  const absSin = Math.abs(sinA);
  const bbRows = Math.ceil(rows * absCos + cols * absSin);
  const bbCols = Math.ceil(cols * absCos + rows * absSin);

  const g = Math.max(1, Math.floor(stride));
  const rowsPad = Math.max(1, Math.ceil(bbRows / g) * g);
  const colsPad = Math.max(1, Math.ceil(bbCols / g) * g);

  const rowsAgg = Math.max(1, Math.floor(rowsPad / g));
  const colsAgg = Math.max(1, Math.floor(colsPad / g));
  const T = simsGrid && simsGrid[0] ? simsGrid[0].length | 0 : 0;

  const outGrid: Float64Array[] = new Array(rowsAgg * colsAgg);
  const cropMapCenter = new Uint8Array(rowsAgg * colsAgg);
  const cropMapMajority = new Uint8Array(rowsAgg * colsAgg);
  const cropMapMixed = new Uint8Array(rowsAgg * colsAgg);
  const cropMapProportionA = new Float32Array(rowsAgg * colsAgg);
  const cropMapProportionBare = new Float32Array(rowsAgg * colsAgg);
  // Allocated only when asked for, so the two-species path is unchanged.
  const nSp = Math.max(0, nSpecies | 0);
  const cells = rowsAgg * colsAgg;
  const cropMapSpecies = nSp > 0 ? new Float32Array(cells * nSp) : null;
  const cropMapDominant = nSp > 0 ? new Uint8Array(cells) : null;
  const cropMapDominantFrac = nSp > 0 ? new Float32Array(cells) : null;
  const cropMapDominantPlot = nSp > 0 ? new Uint16Array(cells) : null;
  const cropMapProportionOffTrial = nSp > 0 ? new Float32Array(cells) : null;
  /** Per-pixel float64 scratch, allocated once: see the fold below. */
  const spScratch = nSp > 0 ? new Float64Array(nSp) : null!;

  const rCenter = rows / 2;
  const cCenter = cols / 2;
  const sCenterR = rowsPad / 2;
  const sCenterC = colsPad / 2;

  const idealGrid: { mean: Float64Array; hasValidPixels: boolean; weightSum: number; cropWeights: Map<number, number> }[] =
    new Array(rowsAgg * colsAgg);
  const SUB = 4;
  const step = 1 / SUB;

  for (let gr = 0; gr < rowsAgg; gr++) {
    for (let gc = 0; gc < colsAgg; gc++) {
      const acc = new Float64Array(T);
      let weightSum = 0;
      let hasValidPixels = false;
      const cropWeights = new Map<number, number>();

      for (let sy = 0; sy < g; sy++) {
        for (let sx = 0; sx < g; sx++) {
          for (let ssy = 0; ssy < SUB; ssy++) {
            for (let ssx = 0; ssx < SUB; ssx++) {
              const ny = gr * g + sy + (ssy + 0.5) * step;
              const nx = gc * g + sx + (ssx + 0.5) * step;

              const relSRow = ny - sCenterR;
              const relSCol = nx - sCenterC;

              const fRelC = relSCol * cosA + relSRow * sinA;
              const fRelR = -relSCol * sinA + relSRow * cosA;

              const fRow = Math.floor(fRelR + rCenter);
              const fCol = Math.floor(fRelC + cCenter);

              const isValid = fRow >= 0 && fRow < rows && fCol >= 0 && fCol < cols;
              if (isValid) hasValidPixels = true;

              if (includeOutside) weightSum += 1;
              else if (isValid) weightSum += 1;

              if (isValid) {
                const srcSeries = simsGrid[fRow * cols + fCol];
                if (srcSeries) for (let t = 0; t < T; t++) acc[t] += srcSeries[t];
                const cropId = cropMap[fRow * cols + fCol];
                cropWeights.set(cropId, (cropWeights.get(cropId) || 0) + 1);
              }
            }
          }
        }
      }

      const mean = new Float64Array(T);
      if (weightSum > 0) for (let t = 0; t < T; t++) mean[t] = acc[t] / weightSum;
      idealGrid[gr * colsAgg + gc] = { mean, hasValidPixels, weightSum, cropWeights };
    }
  }

  // σ = 0 → no PSF: the window collapses to the pixel itself (sharp sensor).
  // The window follows the OFFSET too: a kernel pushed off centre has its far
  // tail outside the symmetric window, and clipping it would quietly renormalise
  // the blur back towards the centre, hiding the very effect being simulated.
  const windowX = Math.max(0, Math.ceil(3 * sigmaX + Math.abs(offX)));
  const windowY = Math.max(0, Math.ceil(3 * sigmaY + Math.abs(offY)));

  for (let gr = 0; gr < rowsAgg; gr++) {
    for (let gc = 0; gc < colsAgg; gc++) {
      const idx = gr * colsAgg + gc;
      const acc = new Float64Array(T);
      let totalWeight = 0;
      const finalCropWeights = new Map<number, number>();

      for (let nr = gr - windowY; nr <= gr + windowY; nr++) {
        for (let nc = gc - windowX; nc <= gc + windowX; nc++) {
          if (nr >= 0 && nr < rowsAgg && nc >= 0 && nc < colsAgg) {
            const neighbor = idealGrid[nr * colsAgg + nc];
            // Row indices grow NORTHWARD here: buildCropMap fills row r at
            // N = minN + (r + 0.5) * fineRes. So +offY peaks on the row to the
            // north, subtracting exactly as +offX does on the east axis. Getting
            // this backwards mirrors the answer about the pixel centre, which a
            // symmetric design hides in the purity total.
            const dy = nr - gr - offY;
            const dx = nc - gc - offX;
            const weight = Math.exp(-0.5 * ((dx / (sigmaX || 0.5)) ** 2 + (dy / (sigmaY || 0.5)) ** 2));

            if (includeOutside || neighbor.hasValidPixels) {
              totalWeight += weight;
              for (let t = 0; t < T; t++) acc[t] += neighbor.mean[t] * weight;
              for (const [cropId, w] of neighbor.cropWeights.entries())
                finalCropWeights.set(cropId, (finalCropWeights.get(cropId) || 0) + w * weight);
            }
          }
        }
      }

      const finalMean = new Float64Array(T);
      if (totalWeight > 0) for (let t = 0; t < T; t++) finalMean[t] = acc[t] / totalWeight;
      outGrid[idx] = finalMean;

      let dominantCrop = 0;
      let maxWeight = 0;
      let totalCropWeight = 0;
      for (const [cropId, w] of finalCropWeights.entries()) {
        totalCropWeight += w;
        if (w > maxWeight) { maxWeight = w; dominantCrop = cropId; }
      }
      const isMixed = totalCropWeight > 0 && maxWeight / totalCropWeight < mixThreshold;

      if (cropMapSpecies) {
        // Fold cover ids into species. Bare and off-trial stay OUT of the
        // species vector but bare stays IN the denominator, because alley soil
        // really is part of what the sensor reads. finalCropWeights holds at
        // most nSpecies + 2 entries, so this is a handful of iterations.
        const base = idx * nSp;
        let offW = 0, domPlot = 0xffff, domPlotW = -1;
        // Accumulate in FLOAT64 and divide before storing. Summing straight into
        // the Float32Array rounds each partial sum to 32 bits, which left
        // species 0 a full ULP away from proportionA (line 368 divides once and
        // stores once). Same maths, one fewer rounding, and this vector feeds
        // the PCA where the error would compound across the season.
        spScratch.fill(0, 0, nSp);
        for (const [coverId, w] of finalCropWeights.entries()) {
          if (coverId === OFF_TRIAL.id) { offW += w; continue; }
          if (coverId > MAX_COVER) continue;                 // BARE
          const s = coverSpecies ? coverSpecies[coverId] : coverId;
          if (s < nSp) spScratch[s] += w;
          if (w > domPlotW) { domPlotW = w; domPlot = coverId; }
        }
        let domS = 0, domF = 0;
        if (totalCropWeight > 0) {
          for (let s = 0; s < nSp; s++) {
            const f = spScratch[s] / totalCropWeight;
            cropMapSpecies[base + s] = f;
            if (f > domF) { domF = f; domS = s; }
          }
        }
        cropMapDominant![idx] = domS;
        cropMapDominantFrac![idx] = domF;
        cropMapDominantPlot![idx] = domPlot;
        cropMapProportionOffTrial![idx] = totalCropWeight > 0 ? offW / totalCropWeight : 0;
      }

      let centerCrop = 0;
      const sRow = gr * g + (g - 1) / 2;
      const sCol = gc * g + (g - 1) / 2;
      const relSRow = sRow - sCenterR;
      const relSCol = sCol - sCenterC;
      const fRelC = relSCol * cosA + relSRow * sinA;
      const fRelR = -relSCol * sinA + relSRow * cosA;
      const fRow = Math.floor(fRelR + rCenter);
      const fCol = Math.floor(fRelC + cCenter);
      if (fRow >= 0 && fRow < rows && fCol >= 0 && fCol < cols) centerCrop = cropMap[fRow * cols + fCol];

      cropMapCenter[idx] = centerCrop;
      cropMapMajority[idx] = dominantCrop;
      cropMapMixed[idx] = isMixed ? MIXED : dominantCrop;
      cropMapProportionA[idx] = totalCropWeight > 0 ? (finalCropWeights.get(0) || 0) / totalCropWeight : 0;
      cropMapProportionBare[idx] = totalCropWeight > 0 ? (finalCropWeights.get(BARE.id) || 0) / totalCropWeight : 0;
    }
  }

  return { rowsAgg, colsAgg, cropMapMixed, cropMapMajority, cropMapCenter, cropMapProportionA, cropMapProportionBare, simsGrid: outGrid,
           cropMapSpecies, cropMapDominant, cropMapDominantFrac, cropMapDominantPlot, cropMapProportionOffTrial };
}

// ===== field driver (repo engine over the real S2 grid) ======================

// ===== randomised complete block design ======================================

/**
 * A micro-plot trial: n species, n repetitions, plots of a given size with
 * alleys between them. This is what the agronomist types.
 *
 * The layout is a PURE function of these numbers, `seed` included, because a
 * trial that has been staked out in a field must be reproducible months later.
 * Nothing here reads the clock or a global RNG.
 */
export interface BlockDesign {
  nSpecies: number;      // treatments per block
  nBlocks: number;       // repetitions
  plotLength: number;    // m, along u (a block's long axis)
  plotWidth: number;     // m, across v
  plotAlley: number;     // m, bare ground between plots inside a block
  blockAlley: number;    // m, bare ground between blocks
  blocksPerRow: number;  // 1 = blocks stacked in tiers
  seed: number;
}

/**
 * A design RESOLVED against a field: the object the simulation, the ladder, the
 * PCA and the map overlay all read. Resolved once and shared, because a second
 * copy built from a different extent or seed would draw one trial while the
 * numbers describe another, with no error anywhere.
 */
export interface BlockPlan {
  design: BlockDesign;
  cols: number; rows: number;      // block grid (cols = blocksPerRow)
  blockU: number; blockV: number;  // one block's extent
  pitchU: number; pitchV: number;  // block extent + the alley between blocks
  totalU: number; totalV: number;  // the whole trial's footprint
  u0: number; v0: number;          // its corner, in the rotated frame
  nPlots: number;
  /** plotSpecies[plotId] -> species index. */
  plotSpecies: Uint8Array;
}

/** One plot as a rectangle, for drawing and for exporting. */
export interface BlockPlot {
  plot: number; block: number; pos: number; species: number;
  u0: number; u1: number; v0: number; v1: number;
}

/**
 * Plot ids share the Uint8Array cover map with the sentinels, so ids 0..252 are
 * usable and 253+ would be read back as off-trial, bare or mixed. Enforced in
 * buildBlockPlan, where ids are MINTED, rather than trusted to a UI clamp.
 */
export const MAX_PLOTS = MAX_COVER + 1;

/**
 * One block's species order. Seeded PER BLOCK rather than once per design, so
 * adding a repetition leaves every earlier block byte-identical and a partly
 * staked trial is not invalidated by extending it. Independent per-block draws
 * are correct RCBD statistics, so two blocks may legitimately come out alike.
 */
export function blockPermutation(nSpecies: number, block: number, seed: number): Uint8Array {
  const n = Math.max(1, nSpecies | 0);
  const s = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(block + 1, 0x85ebca6b)) >>> 0;
  const rnd = randomLcg((s % 2147483647) || 1);
  for (let i = 0; i < 8; i++) rnd();   // nearby LCG seeds correlate in their first draws
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  for (let i = n - 1; i > 0; i--) {    // Fisher-Yates
    const j = Math.floor(rnd() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/**
 * Resolve a design against a field. CENTRED on it, not pinned to a corner: the
 * resolution ladder samples a window around the field centre, so a corner-pinned
 * trial would sit outside the very window that measures it.
 *
 * `snap` (the pixel size) puts the trial's corner on a pixel corner. That is the
 * whole phase optimisation for a block design: exact, O(1), and explainable.
 * It deliberately never enters searchPhaseOffset, whose scorer keeps two
 * counters and assigns crops with `& 1`, i.e. is two-species by construction.
 */
export function buildBlockPlan(
  design: BlockDesign,
  place: { centerU: number; centerV: number; snap?: number },
): BlockPlan {
  const nSpecies = Math.max(1, Math.min(MAX_COVER, design.nSpecies | 0));
  const plotLength = Math.max(0.01, design.plotLength);
  const plotWidth = Math.max(0.01, design.plotWidth);
  const plotAlley = Math.max(0, design.plotAlley);
  const blockAlley = Math.max(0, design.blockAlley);
  // Cap where the ids are minted: 8 species x 32 blocks would mint id 255 and be
  // read straight back as "mixed".
  const nBlocks = Math.max(1, Math.min(design.nBlocks | 0, Math.floor(MAX_PLOTS / nSpecies)));
  const cols = Math.max(1, Math.min(nBlocks, design.blocksPerRow | 0 || 1));
  const rows = Math.ceil(nBlocks / cols);

  const blockU = plotLength;
  const blockV = nSpecies * plotWidth + (nSpecies - 1) * plotAlley;
  const pitchU = blockU + blockAlley;
  const pitchV = blockV + blockAlley;
  const totalU = rows * pitchU - blockAlley;
  const totalV = cols * pitchV - blockAlley;

  const resolved: BlockDesign = {
    nSpecies, nBlocks, plotLength, plotWidth, plotAlley, blockAlley,
    blocksPerRow: cols, seed: design.seed | 0,
  };
  const nPlots = nSpecies * nBlocks;
  const plotSpecies = new Uint8Array(nPlots);
  for (let b = 0; b < nBlocks; b++) {
    const perm = blockPermutation(nSpecies, b, resolved.seed);
    for (let k = 0; k < nSpecies; k++) plotSpecies[b * nSpecies + k] = perm[k];
  }

  const snap = place.snap && place.snap > 0 ? place.snap : 0;
  let u0 = place.centerU - totalU / 2;
  let v0 = place.centerV - totalV / 2;
  if (snap > 0) { u0 = Math.floor(u0 / snap) * snap; v0 = Math.floor(v0 / snap) * snap; }

  return { design: resolved, cols, rows, blockU, blockV, pitchU, pitchV, totalU, totalV, u0, v0, nPlots, plotSpecies };
}

/**
 * What covers a point: a PLOT id, bare alley, or ground outside the trial.
 * O(1) and allocation-free, because buildCropMap calls it once per fine cell,
 * millions of times. It must never loop over plots.
 */
export function blockCoverUV(u: number, v: number, p: BlockPlan): number {
  const du = u - p.u0, dv = v - p.v0;
  // Bounds FIRST: the map draws in a rotated frame where u and v go negative,
  // and a negative index would otherwise read some other plot's id.
  if (du < 0 || du >= p.totalU || dv < 0 || dv >= p.totalV) return OFF_TRIAL.id;
  const r = Math.floor(du / p.pitchU), c = Math.floor(dv / p.pitchV);
  const b = r * p.cols + c;
  if (b >= p.design.nBlocks) return OFF_TRIAL.id;                 // ragged last row
  const uIn = du - r * p.pitchU, vIn = dv - c * p.pitchV;
  if (uIn >= p.blockU || vIn >= p.blockV) return BARE.id;         // alley between blocks
  const pitch = p.design.plotWidth + p.design.plotAlley;
  const k = Math.floor(vIn / pitch);
  if (k >= p.design.nSpecies || vIn - k * pitch >= p.design.plotWidth) return BARE.id;
  return b * p.design.nSpecies + k;
}

/** Every plot as a rectangle in the rotated frame, for drawing and export. */
export function blockPlots(p: BlockPlan): BlockPlot[] {
  const out: BlockPlot[] = [];
  const pitch = p.design.plotWidth + p.design.plotAlley;
  for (let b = 0; b < p.design.nBlocks; b++) {
    const r = Math.floor(b / p.cols), c = b % p.cols;
    const bu = p.u0 + r * p.pitchU, bv = p.v0 + c * p.pitchV;
    for (let k = 0; k < p.design.nSpecies; k++) {
      const plot = b * p.design.nSpecies + k;
      const v0 = bv + k * pitch;
      out.push({
        plot, block: b, pos: k, species: p.plotSpecies[plot],
        u0: bu, u1: bu + p.blockU, v0, v1: v0 + p.design.plotWidth,
      });
    }
  }
  return out;
}

/**
 * The narrowest feature the fine grid must resolve. strideFor samples against
 * ONE width, but a block design's smallest feature is usually an alley, which
 * can be 0.5 m beside 8 m plots: sampling at the plot width quantises the alleys
 * away, which is exactly the flat-0.5 artefact strideFor's own comment warns of.
 * Identity on layout.width for the five two-species patterns.
 */
export function minFeatureM(layout: SimLayout): number {
  if (layout.pattern !== 'block' || !layout.block) return layout.width;
  const d = layout.block.design;
  let m = Math.min(d.plotWidth, d.plotLength);
  if (d.plotAlley > 0) m = Math.min(m, d.plotAlley);
  if (d.blockAlley > 0) m = Math.min(m, d.blockAlley);
  return Math.max(0.05, m);
}

/**
 * Everything a layout depends on, in one string. The memo dependency arrays,
 * the map's remount key and the overlay's effect deps take THIS rather than a
 * hand-listed set of primitives: a field forgotten in one of those lists shows
 * a stale design with no error, no type failure and no failing test.
 * Includes the RESOLVED corner, so re-anchoring the trial also invalidates.
 */
export function layoutKey(layout: SimLayout): string {
  const base = `${layout.pattern}|${layout.width}|${layout.spacing}|${layout.rotationDeg}`;
  const p = layout.block;
  if (!p) return base;
  const d = p.design;
  return `${base}|${d.nSpecies}|${d.nBlocks}|${d.plotLength}|${d.plotWidth}|${d.plotAlley}|` +
         `${d.blockAlley}|${d.blocksPerRow}|${d.seed}|${p.u0.toFixed(3)}|${p.v0.toFixed(3)}`;
}

export interface SimLayout {
  pattern: PatternType;
  width: number;        // strip / plot width in metres
  spacing: number;      // bare-soil gap between strips, in metres (0 = none)
  rotationDeg: number;
  /** The RESOLVED plan for a 'block' layout. Built once, shared by every reader. */
  block?: BlockPlan;
}

/**
 * Culture in the rotated (u = along-row, v = cross-row) frame, honouring the
 * inter-row spacing. Returns 0 (crop A), 1 (crop B) or BARE.id (2 = bare alley).
 * With spacing = 0 this is exactly `cultureForCell(floor(v/W), floor(u/W))`.
 */
function patternCultureUV(u: number, v: number, layout: SimLayout): number {
  const W = layout.width;
  const S = Math.max(0, layout.spacing || 0);
  const P = W + S;
  const inStrip = (x: number) => (((x % P) + P) % P) < W;
  const idx = (x: number) => Math.floor(x / P);
  const alt = (n: number) => ((n % 2) + 2) % 2;
  switch (layout.pattern) {
    case 'row':         return inStrip(v) ? alt(idx(v)) : BARE.id;
    case 'col':         return inStrip(u) ? alt(idx(u)) : BARE.id;
    case 'checker':     return inStrip(u) && inStrip(v) ? alt(idx(u) + idx(v)) : BARE.id;
    case 'strip-row-2': return inStrip(v) ? alt(Math.floor(idx(v) / 2)) : BARE.id;
    case 'strip-col-2': return inStrip(u) ? alt(Math.floor(idx(u) / 2)) : BARE.id;
    // A block layout carries its resolved plan; without one there is no trial
    // here yet, so the ground is off-trial rather than silently species A.
    case 'block':       return layout.block ? blockCoverUV(u, v, layout.block) : OFF_TRIAL.id;
    default: {
      // Exhaustive: adding a pattern without handling it is a type error here,
      // instead of quietly painting the whole field species A at runtime.
      const unhandled: never = layout.pattern;
      void unhandled;
      return OFF_TRIAL.id;
    }
  }
}
export interface SensorParams {
  sigmaX: number;
  sigmaY: number;
  /** PSF centre offset from the pixel centre, in PIXELS. Optional: 0 = centred. */
  offX?: number;
  offY?: number;
  /** Pure when dominant crop fraction ≥ threshold (repo default 0.8). */
  mixThreshold: number;
}

/** Truth (NDVI) of a field on a day-of-year. */
export const truthAt = (f: FieldParams, day: number): number =>
  makeTruth(f.truth, TMAX, parsOf(f))[Math.max(0, Math.min(TMAX - 1, Math.round(day)))];

/**
 * Fine cells per sensor pixel — enough sub-sampling to resolve the strips.
 * Uses ≥4 samples per strip width (factor 4) so the crop fraction is accurate;
 * too-coarse sampling quantises e.g. a 0.6 coverage to a flat 0.5 (all-mixed
 * artefact) when the pixel and strip periods resonate.
 */
const strideFor = (gsd: number, width: number): number =>
  Math.max(4, Math.min(24, Math.ceil((4 * gsd) / Math.max(0.1, width))));

/** Build the fine-grid culture map (0/1) over a UTM extent, rotated to the layout. */
function buildCropMap(
  minE: number, minN: number, rows: number, cols: number, fineRes: number,
  patternOx: number, patternOy: number, layout: SimLayout,
): Uint8Array {
  const map = new Uint8Array(rows * cols);
  const t = (layout.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(t), sin = Math.sin(t);
  for (let r = 0; r < rows; r++) {
    const N = minN + (r + 0.5) * fineRes;
    for (let c = 0; c < cols; c++) {
      const E = minE + (c + 0.5) * fineRes;
      const dx = E - patternOx, dy = N - patternOy;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      map[r * cols + c] = patternCultureUV(u, v, layout);
    }
  }
  return map;
}

export interface FieldSim {
  proportionA: Float32Array;    // per sensor pixel, aligned to grid.cells order
  proportionBare: Float32Array; // fraction of bare-soil gap in the pixel
  mixed: Uint8Array;            // 255 = mixed, else dominant crop id (0/1/2)
  purePct: number;              // % pixels that are a pure single CROP (A or B)
  pureA: number;
  pureB: number;
  pureBare: number;
  total: number;
  meanPropA: number;
}

const EMPTY = new Float64Array(0);

/** Run the repo aggregate over the real grid's sensor cells. */
export function simulateField(grid: S2Grid, patternOrigin: [number, number], layout: SimLayout, sensor: SensorParams): FieldSim {
  const res = grid.res;
  const [minE, minN, maxE, maxN] = grid.utmBounds;
  const nx = Math.round((maxE - minE) / res);
  const ny = Math.round((maxN - minN) / res);
  const g = strideFor(res, minFeatureM(layout));
  const fineRes = res / g;
  const rows = ny * g, cols = nx * g;
  const cropMap = buildCropMap(minE, minN, rows, cols, fineRes, patternOrigin[0], patternOrigin[1], layout);
  const simsGrid: Float64Array[] = new Array(rows * cols).fill(EMPTY);
  const agg = aggregate(simsGrid, rows, cols, g, sensor.sigmaX, sensor.sigmaY, true, 0, cropMap, sensor.mixThreshold, sensor.offX ?? 0, sensor.offY ?? 0);

  const mixed = agg.cropMapMixed;
  const proportionA = agg.cropMapProportionA;
  const proportionBare = agg.cropMapProportionBare;
  let sumP = 0;
  for (let k = 0; k < mixed.length; k++) sumP += proportionA[k];
  const st = coverStats({ mixed, offTrial: agg.cropMapProportionOffTrial });
  return {
    proportionA, proportionBare, mixed,
    purePct: st.purePct, pureA: st.pureBySpecies[0], pureB: st.pureBySpecies[1], pureBare: st.pureBare,
    total: st.total, meanPropA: mixed.length ? sumP / mixed.length : 0.5,
  };
}

export interface SweepPoint { gsd: number; purePct: number; }

/** Culture (0/1) at a UTM point, for rendering the crisp ground-truth pattern. */
export function cultureAt(E: number, N: number, layout: SimLayout, ox: number, oy: number): number {
  const t = (layout.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(t), sin = Math.sin(t);
  const dx = E - ox, dy = N - oy;
  const u = dx * cos + dy * sin;
  const v = -dx * sin + dy * cos;
  return patternCultureUV(u, v, layout);
}

/**
 * Find the pattern phase (origin shift, in metres) that maximises pure single-crop
 * pixels — i.e. slide the whole planting so strip edges land on pixel edges. Solved
 * 1D per striping axis against the real pixel lattice (exact when rows follow the
 * pixels; a good heuristic when rotated). Returns [du, dv] in the rotated
 * (along-row u, cross-row v) frame; add it to the pattern origin.
 */
/**
 * bestPhaseOffset is pure but costs ~35 ms (192 phases x 400 pixels x 16
 * sub-samples), and the resolution ladder calls it once per size — twice per size
 * with "vs aligned", with IDENTICAL arguments, since rotation is not an input.
 * Results are cached by argument. `threshold` is deliberately left out of the
 * key: the search maximises continuous coverage and never reads it, so moving the
 * purity slider reuses every cached placement.
 */
const phaseCache = new Map<string, [number, number]>();
const PHASE_CACHE_MAX = 512;

export function bestPhaseOffset(
  pattern: PatternType, res: number, width: number, spacing: number, threshold: number, ox0: number, oy0: number,
): [number, number] {
  const key = `${pattern}|${res}|${width}|${spacing}|${ox0}|${oy0}`;
  const hit = phaseCache.get(key);
  if (hit) return [hit[0], hit[1]]; // a copy: callers must never share the cached tuple
  const out = searchPhaseOffset(pattern, res, width, spacing, threshold, ox0, oy0);
  if (phaseCache.size >= PHASE_CACHE_MAX) phaseCache.delete(phaseCache.keys().next().value as string);
  phaseCache.set(key, out);
  return [out[0], out[1]];
}

function searchPhaseOffset(
  pattern: PatternType, res: number, width: number, spacing: number, threshold: number, ox0: number, oy0: number,
): [number, number] {
  const W = width, P = width + Math.max(0, spacing);
  const assign = (k: number, two: boolean) => (two ? Math.floor(k / 2) : k) & 1;
  const search = (origin: number, two: boolean): number => {
    const STEPS = 192, SUB = 16, NPIX = 400;
    const m0 = Math.round(origin / res);
    // Maximise the mean dominant-crop coverage (continuous): this peaks only when
    // strip edges land exactly on pixel edges — not merely when pixels are "pure
    // enough" to clear the threshold (which leaves a constant sub-pixel shift).
    let best = 0, bestScore = -1;
    for (let s = 0; s < STEPS; s++) {
      const d = (s / STEPS) * P;
      let score = 0;
      for (let p = 0; p < NPIX; p++) {
        const lo = (m0 + p) * res;
        let cA = 0, cB = 0;
        for (let ss = 0; ss < SUB; ss++) {
          const x = lo + ((ss + 0.5) / SUB) * res - origin - d; // pattern coordinate
          const m = ((x % P) + P) % P;
          if (m < W) { if (assign(Math.floor(x / P), two) === 0) cA++; else cB++; }
        }
        score += Math.max(cA, cB); // how cleanly this pixel is a single crop
      }
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  };
  const vAxis = pattern === 'row' || pattern === 'strip-row-2' || pattern === 'checker';
  const uAxis = pattern === 'col' || pattern === 'strip-col-2' || pattern === 'checker';
  const dv = vAxis ? search(oy0, pattern === 'strip-row-2') : 0;
  const du = uAxis ? search(ox0, pattern === 'strip-col-2') : 0;
  return [du, dv];
}

export interface PatchSim {
  proportionA: Float32Array;    // per sensor pixel, row-major south→north
  proportionBare: Float32Array;
  mixed: Uint8Array;
  nx: number; ny: number;       // sensor pixels across / up
  purePct: number;              // % pixels that are a pure single CROP (A or B)
}

/** Run the repo aggregate over a square UTM patch at a given GSD (for thumbnails). */
export function simulatePatch(
  minE: number, minN: number, sizeM: number, gsd: number,
  patternOx: number, patternOy: number, layout: SimLayout, sensor: SensorParams,
): PatchSim {
  const nx = Math.max(1, Math.round(sizeM / gsd));
  const ny = nx;
  const g = strideFor(gsd, minFeatureM(layout));
  const fineRes = gsd / g;
  const rows = ny * g, cols = nx * g;
  const cropMap = buildCropMap(minE, minN, rows, cols, fineRes, patternOx, patternOy, layout);
  const simsGrid: Float64Array[] = new Array(rows * cols).fill(EMPTY);
  const agg = aggregate(simsGrid, rows, cols, g, sensor.sigmaX, sensor.sigmaY, true, 0, cropMap, sensor.mixThreshold, sensor.offX ?? 0, sensor.offY ?? 0);
  const st = coverStats({ mixed: agg.cropMapMixed, offTrial: agg.cropMapProportionOffTrial });
  return {
    proportionA: agg.cropMapProportionA, proportionBare: agg.cropMapProportionBare, mixed: agg.cropMapMixed,
    nx: agg.colsAgg, ny: agg.rowsAgg,
    purePct: st.purePct,
  };
}

/** Project a WGS84 area's corners → UTM envelope [minE,minN,maxE,maxN]. */
export function utmEnvelope(bounds: LngLatBounds, epsg: number): [number, number, number, number] {
  const to = proj4('EPSG:4326', crsToProj4Def(`EPSG:${epsg}`));
  const [w, s, e, n] = bounds;
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [lng, lat] of [[w, s], [e, s], [e, n], [w, n]] as [number, number][]) {
    const [x, y] = to.forward([lng, lat]);
    minE = Math.min(minE, x); maxE = Math.max(maxE, x);
    minN = Math.min(minN, y); maxN = Math.max(maxN, y);
  }
  return [minE, minN, maxE, maxN];
}

/** Purity vs resolution: run the repo aggregate at each GSD over a bounded window. */
export function resolutionSweep(
  bounds: LngLatBounds, epsg: number, layout: SimLayout, gsds: number[], sensor: SensorParams,
): SweepPoint[] {
  const [minE, minN, maxE, maxN] = utmEnvelope(bounds, epsg);
  const cx = (minE + maxE) / 2, cy = (minN + maxN) / 2;
  const half = 50; // bounded window — purity of a periodic pattern is stationary
  const wMinE = Math.max(minE, cx - half), wMaxE = Math.min(maxE, cx + half);
  const wMinN = Math.max(minN, cy - half), wMaxN = Math.min(maxN, cy + half);
  return gsds.map(gsd => {
    const oMinE = Math.floor(wMinE / gsd) * gsd;
    const oMinN = Math.floor(wMinN / gsd) * gsd;
    const nx = Math.max(1, Math.ceil((wMaxE - oMinE) / gsd));
    const ny = Math.max(1, Math.ceil((wMaxN - oMinN) / gsd));
    const g = strideFor(gsd, minFeatureM(layout));
    const fineRes = gsd / g;
    const rows = ny * g, cols = nx * g;
    const cropMap = buildCropMap(oMinE, oMinN, rows, cols, fineRes, minE, minN, layout);
    const simsGrid: Float64Array[] = new Array(rows * cols).fill(EMPTY);
    const agg = aggregate(simsGrid, rows, cols, g, sensor.sigmaX, sensor.sigmaY, true, 0, cropMap, sensor.mixThreshold, sensor.offX ?? 0, sensor.offY ?? 0);
    let pure = 0;
    for (let k = 0; k < agg.cropMapMixed.length; k++) if (agg.cropMapMixed[k] !== 255) pure++;
    return { gsd, purePct: agg.cropMapMixed.length ? (100 * pure) / agg.cropMapMixed.length : 0 };
  });
}
