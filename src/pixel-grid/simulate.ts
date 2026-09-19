import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import { pointInPoly } from './geometry';
import type { ImportedPlan } from './imported-types';
import type { LngLatBounds, S2Grid } from './s2-grid';

/**
 * Mixed-pixel simulator: a faithful port of github.com/charlesro/intercrop-simulator's
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
export type PatternType = 'row' | 'col' | 'checker' | 'strip-row-2' | 'strip-col-2' | 'block' | 'imported';

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
  { id: 'imported', label: 'Imported trial (file)' },
];

/** One field's parameters: the repo's per-field set, plus name/colour for UI. */
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

/**
 * The colour-blind-safe palette a species is drawn in, on the map, in the NDVI
 * chart, in the PCA scatter and in every legend. Lives here rather than in a
 * component so colour assignment can be checked headlessly, and because its
 * LENGTH is what caps a design at eight species: beyond that two treatments
 * would share a colour, and a trial you cannot tell apart on the map is worse
 * than one you cannot fit on the field.
 */
export const CROP_COLORS = ['#e69f00', '#0072b2', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442', '#999999'];

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
  // field, so r and c go negative there. A returned -1 matched neither crop id
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

/** Bare-soil gap (alley) inserted between strips: a third land cover. */
/**
 * Land-cover sentinels. Species and plot ids are CONTIGUOUS from 0, so the
 * markers sit at the top of the byte. BARE used to be id 2, which IS the third
 * species: a four-species design silently painted species three as bare soil,
 * counted it as bare in the purity totals and gave it bare soil's NDVI in the
 * PCA. Keep every comparison by symbol, never by the literal.
 */
export const MIXED = 255;
// Bare soil carries no vegetation signal: NDVI 0.
export const BARE = { id: 254, color: '#8a7355', ndvi: 0 } as const;
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
  /**
   * The dominant cover BEFORE the mixed threshold is applied, and the cover a
   * point sample at the pixel centre would read. No screen reads either one:
   * the page reads cropMapMixed, which is this classification with MIXED
   * written in. They are kept because they are what pins this port to the
   * repo's original engine (suite sections H and G2 read them pixel by pixel,
   * and the differential fuzz compares the whole result object field by field),
   * and because measuring says they are free: interleaved A/B runs of a 360,000
   * pixel field, with and without the centre pass, differ by less than the
   * run-to-run noise. The cost is 2 bytes per pixel of memory, nothing else.
   * Drop them only together with those pins, never quietly.
   */
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
  /**
   * Dominant PLOT id per pixel, so per-plot coverage can be counted. The one
   * field of this result with no reader at all today, not even a test: it is
   * 2 bytes per pixel and one comparison per cover slot, which measures as
   * nothing next to the PSF pass. Deleting it is a change to what `aggregate`
   * RETURNS, so it goes with a re-run of the differential fuzz against the
   * pre-coverage oracle, which compares the result field by field.
   */
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
 * Cover-id bookkeeping for `aggregate`, standing in for the Map it used to build
 * per pixel. A cover id that is a byte (always, for a Uint8Array cover map read
 * in bounds) is its own slot. Anything else gets slot 256, 257, ... through a
 * real Map, so odd ids group exactly as Map keys them. `cnt` is a running count
 * per slot, zero meaning "not seen yet in this pixel", and `ord` lists slots in
 * first-seen order: the Map's iteration order, which the float sums depend on.
 */
interface CoverSlots { cnt: Float64Array; ord: Int32Array; keys: number[]; index: Map<number, number> }

function coverSlot(st: CoverSlots, key: number): number {
  let slot = st.index.get(key);
  if (slot === undefined) {
    slot = 256 + st.keys.length;
    st.index.set(key, slot);
    st.keys.push(key);
    if (slot >= st.cnt.length) {
      const cnt = new Float64Array(st.cnt.length * 2); cnt.set(st.cnt); st.cnt = cnt;
      const ord = new Int32Array(st.ord.length * 2); ord.set(st.ord); st.ord = ord;
    }
  }
  return slot;
}

/**
 * True when a cover id is a byte number, the slot it keys directly. The typeof
 * test comes first so a value that is not a number (a BigInt, an object with
 * valueOf, a Symbol) is never coerced: it goes to `coverSlot` as a Map key, the
 * way the original Map took it, and nothing runs that the original did not run.
 */
function isByteId(id: unknown): id is number {
  return typeof id === 'number' && (id & 255) === id;
}

/**
 * Adds `count` sightings of cover id `id` to the pixel's tally, as `count`
 * consecutive `map.set(id, (map.get(id) || 0) + 1)` would: a first sighting
 * appends the slot to the first-seen list, and the integer count is exact.
 * Returns the new length of that list.
 */
function tally(st: CoverSlots, id: number, count: number, n: number): number {
  const slot = isByteId(id) ? id : coverSlot(st, id);
  const c = st.cnt[slot];
  if (c === 0) st.ord[n++] = slot;
  st.cnt[slot] = c + count;
  return n;
}

/**
 * `finalCropWeights.get(key) || 0` over aggregate's phase 2 scratch: the slot
 * holds a weight for this pixel only when its stamp is this pixel's. Any key,
 * byte or not, resolves to the same slot phase 1 gave it (none: weight 0).
 */
function finWeight(st: CoverSlots, seen: Int32Array, fin: Float64Array, stamp: number, key: unknown): number {
  const slot = isByteId(key) ? key : st.index.get(key as number);
  return slot !== undefined && seen[slot] === stamp ? fin[slot] || 0 : 0;
}

/**
 * What phase 1 hands phase 2, per pixel: its mean series, whether any of its
 * sub-samples landed on the fine grid, and its cover weights as the (slot,
 * weight) pairs pairStart[k] .. pairStart[k + 1]. The pair ORDER is part of the
 * answer, not an implementation detail: it is the order the float sums are
 * added in, and the order that breaks a dominance tie.
 *
 * `aggregateImported` fills the same structure from exact polygon areas rather
 * than from sub-samples, so an imported trial and a sampled one run ONE phase 2
 * instead of two copies of it that can drift apart.
 */
interface PixelCovers {
  T: number;
  means: Float64Array[];
  hasValid: Uint8Array;
  pairStart: Int32Array;
  pairSlot: Int32Array;
  pairW: Float64Array;
  slots: CoverSlots;
}

/**
 * Phase 2, shared by both phase 1s: the PSF over the neighbouring pixels, the
 * dominance / mixed classification, the species fold and the off-trial share.
 * Reproduced expression for expression from the Map-based original, which a
 * differential fuzz checks field by field.
 *
 * `centreCover` stands in for the cover map read at the pixel's centre, which
 * is the one thing phase 2 takes from the fine grid: the exact path has no fine
 * grid, and answers from its own geometry instead.
 */
function resolvePixels(
  out: AggregateResult,
  pc: PixelCovers,
  nSp: number,
  spScratch: Float64Array,
  sigmaX: number, sigmaY: number, includeOutside: boolean, mixThreshold: number, offX: number, offY: number,
  coverSpecies: Uint8Array | null,
  centreCover: (gr: number, gc: number) => number,
): void {
  const { rowsAgg, colsAgg, cropMapCenter, cropMapMajority, cropMapMixed, cropMapProportionA, cropMapProportionBare,
    cropMapSpecies, cropMapDominant, cropMapDominantFrac, cropMapDominantPlot, cropMapProportionOffTrial } = out;
  const outGrid = out.simsGrid;
  const { T, means, hasValid, pairStart, pairSlot, pairW, slots } = pc;
  const none = new Float64Array(0);

  // σ = 0 → no PSF: the window collapses to the pixel itself (sharp sensor).
  // The window follows the OFFSET too: a kernel pushed off centre has its far
  // tail outside the symmetric window, and clipping it would quietly renormalise
  // the blur back towards the centre, hiding the very effect being simulated.
  const windowX = Math.max(0, Math.ceil(3 * sigmaX + Math.abs(offX)));
  const windowY = Math.max(0, Math.ceil(3 * sigmaY + Math.abs(offY)));

  // A neighbour's PSF weight depends only on its offset (nr - gr, nc - gc), so
  // it is evaluated once per offset with the same expression. Offsets beyond
  // the aggregated grid are never in bounds and are left out of the table.
  // That is only exact when the four inputs are plain numbers: anything else
  // (an object with valueOf, a numeric string) is converted by the original
  // once per in-bounds neighbour, so then the weight is computed inline, in the
  // original's order, and the table stays empty.
  // Row indices grow NORTHWARD here: buildCropMap fills row r at
  // N = minN + (r + 0.5) * fineRes. So +offY peaks on the row to the
  // north, subtracting exactly as +offX does on the east axis. Getting
  // this backwards mirrors the answer about the pixel centre, which a
  // symmetric design hides in the purity total.
  const tabulate = typeof sigmaX === 'number' && typeof sigmaY === 'number' && typeof offX === 'number' && typeof offY === 'number';
  const eY = Math.min(windowY, rowsAgg - 1);
  const eX = Math.min(windowX, colsAgg - 1);
  const kW = 2 * eX + 1;
  const kernel = new Float64Array(tabulate && eX >= 0 && eY >= 0 ? (2 * eY + 1) * kW : 0);
  if (tabulate) {
    for (let i = 0; i <= 2 * eY; i++) {
      for (let j = 0; j <= 2 * eX; j++) {
        const dy = i - eY - offY;
        const dx = j - eX - offX;
        kernel[i * kW + j] = Math.exp(-0.5 * ((dx / (sigmaX || 0.5)) ** 2 + (dy / (sigmaY || 0.5)) ** 2));
      }
    }
  }

  // Phase 2 scratch standing in for the per-pixel Map: fin[slot] is the running
  // weight, seen[slot] the (pixel + 1) that last touched it, finOrd the slots in
  // first-seen order.
  const nSlots = slots.cnt.length;
  const fin = new Float64Array(nSlots);
  const seen = new Int32Array(nSlots);
  const finOrd = new Int32Array(nSlots);

  for (let gr = 0; gr < rowsAgg; gr++) {
    const r0 = Math.max(0, gr - windowY);
    const r1 = Math.min(rowsAgg - 1, gr + windowY);
    for (let gc = 0; gc < colsAgg; gc++) {
      const idx = gr * colsAgg + gc;
      const stamp = idx + 1;
      const acc = T === 0 ? none : new Float64Array(T);
      let totalWeight = 0;
      let n = 0;
      const c0 = Math.max(0, gc - windowX);
      const c1 = Math.min(colsAgg - 1, gc + windowX);

      for (let nr = r0; nr <= r1; nr++) {
        const kRow = (nr - gr + eY) * kW + eX - gc;
        for (let nc = c0; nc <= c1; nc++) {
          const nIdx = nr * colsAgg + nc;
          let weight: number;
          if (tabulate) weight = kernel[kRow + nc];
          else {
            const dy = nr - gr - offY;
            const dx = nc - gc - offX;
            weight = Math.exp(-0.5 * ((dx / (sigmaX || 0.5)) ** 2 + (dy / (sigmaY || 0.5)) ** 2));
          }
          if (includeOutside || hasValid[nIdx]) {
            totalWeight += weight;
            if (T !== 0) { const mean = means[nIdx]; for (let t = 0; t < T; t++) acc[t] += mean[t] * weight; }
            const pEnd = pairStart[nIdx + 1];
            for (let p = pairStart[nIdx]; p < pEnd; p++) {
              const slot = pairSlot[p];
              if (seen[slot] !== stamp) { seen[slot] = stamp; fin[slot] = 0; finOrd[n++] = slot; }
              fin[slot] = (fin[slot] || 0) + pairW[p] * weight;
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
      for (let i = 0; i < n; i++) {
        const slot = finOrd[i];
        const w = fin[slot];
        totalCropWeight += w;
        if (w > maxWeight) { maxWeight = w; dominantCrop = slot < 256 ? slot : slots.keys[slot - 256]; }
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
        for (let i = 0; i < n; i++) {
          const slot = finOrd[i];
          const coverId = slot < 256 ? slot : slots.keys[slot - 256];
          const w = fin[slot];
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

      const centerCrop = centreCover(gr, gc);

      cropMapCenter[idx] = centerCrop;
      cropMapMajority[idx] = dominantCrop;
      cropMapMixed[idx] = isMixed ? MIXED : dominantCrop;
      cropMapProportionA[idx] = totalCropWeight > 0 ? finWeight(slots, seen, fin, stamp, 0) / totalCropWeight : 0;
      cropMapProportionBare[idx] = totalCropWeight > 0 ? finWeight(slots, seen, fin, stamp, BARE.id) / totalCropWeight : 0;
    }
  }
}

/**
 * Verbatim port of the repo's `aggregate` (PSF + SUB=4 sub-sampling + rotation
 * + majority/mixed classification). The only change: the mixed threshold is a
 * parameter (`mixThreshold`, default 0.8 = the repo's literal).
 *
 * Tuned for speed with bit-identical results: every float is produced by the
 * same operations in the same order as the Map-based original, which a
 * differential fuzz against a byte copy of that original checks field by field.
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

  const SUB = 4;
  const step = 1 / SUB;
  const SS = SUB * SUB;

  // Phase 1 ("ideal" pixels), flattened instead of one object and Map per
  // pixel: pixel k's mean series is means[k], hasValid[k] says whether
  // any sub-sample landed on the fine grid, and its cover counts are the
  // (slot, count) pairs pairStart[k] .. pairStart[k + 1], in first-seen order.
  //
  // Exactness rule for everything below: any step that can run user code or
  // coerce a value (reading simsGrid, a series or cropMap, arithmetic on a value
  // read from them, arithmetic on an argument that may not be a number) is done
  // the same number of times, in the same order, with the same expression as the
  // Map-based original. Only pure arithmetic on numbers is restructured. The
  // series buffers are allocated per pixel where the original allocated them,
  // so a bad or huge T fails at the same allocation; with T = 0 nothing can
  // fail and one empty array stands in for all of them.
  const none = new Float64Array(0);
  const means: Float64Array[] = new Array(T === 0 ? 0 : cells);
  const hasValid = new Uint8Array(cells);
  const pairStart = new Int32Array(cells + 1);
  let pairCap = cells + 16;
  let pairSlot = new Int32Array(pairCap);
  let pairW = new Float64Array(pairCap);
  let pairLen = 0;
  const slots: CoverSlots = { cnt: new Float64Array(256), ord: new Int32Array(256), keys: [], index: new Map() };

  // The unrotated, unpadded grid every simulateField / simulatePatch call uses.
  // There cos = 1, sin = +-0 and sCenter === the fine centre, so the rotation
  // is exact: fRelR = +-0 + relSRow === relSRow (relSRow is never zero, it has a
  // fraction of 1/8, 3/8, 5/8 or 7/8), and ny = gr*g + sy + (ssy + 0.5) / 4 is
  // exact too, so floor(ny - sCenterR + rCenter) === gr*g + sy. All SUB*SUB
  // sub-samples of fine cell (gr*g + sy, gc*g + sx) land on that same cell, and
  // since rows and cols are whole numbers (=== a number) that are multiples of g,
  // every one of them is valid. The geometry is skipped, but each sub-sample
  // still reads simsGrid, the series and cropMap exactly as the original did.
  // What is saved is the float geometry and the Map: consecutive equal cover ids
  // (===, which implies the same Map key) are one run, tallied in one step at
  // the run's first sub-sample, which is where the Map first saw the id, so the
  // first-seen order is unchanged. A run of id 0 with length 0 is where every
  // pixel starts, which is the same as no run. A null simsGrid takes the general
  // path, which throws exactly where the original did.
  const aligned = cosA === 1 && sinA === 0 && rowsPad === rows && colsPad === cols && simsGrid != null;

  for (let gr = 0; gr < rowsAgg; gr++) {
    for (let gc = 0; gc < colsAgg; gc++) {
      const k = gr * colsAgg + gc;
      let weightSum = 0;
      let hasValidPixels = false;
      let n = 0;
      const acc = T === 0 ? none : new Float64Array(T);

      if (aligned) {
        let runId = 0;
        let run = 0;
        for (let sy = 0; sy < g; sy++) {
          const rowBase = (gr * g + sy) * cols + gc * g;
          for (let sx = 0; sx < g; sx++) {
            const cell = rowBase + sx;
            let q = 0;
            if (T === 0) {
              // With no series the original read simsGrid[cell] only to test it,
              // which runs nothing, so the bare read is the same step. The inner
              // loop makes no writes while the id repeats, which V8 runs fast.
              while (q < SS) {
                let cropId: number;
                do {
                  simsGrid[cell];
                  cropId = cropMap[cell];
                  q++;
                  if (cropId !== runId) break;
                  run++;
                } while (q < SS);
                if (cropId !== runId) {
                  if (run > 0) n = tally(slots, runId, run, n);
                  runId = cropId;
                  run = 1;
                }
              }
            } else {
              for (; q < SS; q++) {
                const srcSeries = simsGrid[cell];
                if (srcSeries) for (let t = 0; t < T; t++) acc[t] += srcSeries[t];
                const cropId = cropMap[cell];
                if (cropId === runId) { run++; continue; }
                if (run > 0) n = tally(slots, runId, run, n);
                runId = cropId;
                run = 1;
              }
            }
          }
        }
        if (run > 0) n = tally(slots, runId, run, n);
        hasValidPixels = true;
        weightSum = SS * g * g;
      } else {
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
                  n = tally(slots, cropId, 1, n);
                }
              }
            }
          }
        }
      }

      if (pairLen + n > pairCap) {
        pairCap = Math.max(pairCap * 2, pairLen + n);
        const nextSlot = new Int32Array(pairCap); nextSlot.set(pairSlot); pairSlot = nextSlot;
        const nextW = new Float64Array(pairCap); nextW.set(pairW); pairW = nextW;
      }
      pairStart[k] = pairLen;
      const cnt = slots.cnt, ord = slots.ord;
      for (let i = 0; i < n; i++) {
        const slot = ord[i];
        pairSlot[pairLen] = slot;
        pairW[pairLen++] = cnt[slot];
        cnt[slot] = 0;
      }
      hasValid[k] = hasValidPixels ? 1 : 0;
      if (T !== 0) {
        const mean = new Float64Array(T);
        if (weightSum > 0) for (let t = 0; t < T; t++) mean[t] = acc[t] / weightSum;
        means[k] = mean;
      }
    }
  }
  pairStart[cells] = pairLen;

  // The cover at the pixel's centre, read from the fine grid exactly where the
  // original read it: the same sub-sample position through the same rotation.
  const centre = (gr: number, gc: number): number => {
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
    return centerCrop;
  };

  const result: AggregateResult = { rowsAgg, colsAgg, cropMapMixed, cropMapMajority, cropMapCenter, cropMapProportionA, cropMapProportionBare,
                                    simsGrid: outGrid, cropMapSpecies, cropMapDominant, cropMapDominantFrac, cropMapDominantPlot, cropMapProportionOffTrial };
  resolvePixels(result, { T, means, hasValid, pairStart, pairSlot, pairW, slots }, nSp, spScratch,
                sigmaX, sigmaY, includeOutside, mixThreshold, offX, offY, coverSpecies, centre);
  return result;
}

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
/**
 * Where a finite trial sits, in the frame the ENGINE actually samples.
 *
 * buildCropMap measures (u,v) from the PATTERN ORIGIN (the drawn field's
 * corner), rotated by the layout angle. A plan anchored in raw UTM instead is
 * some 620 km away in that frame, so `blockCoverUV`'s bounds guard rejects
 * every point and the trial vanishes from the map, the purity and the PCA at
 * once, with no error anywhere. Exported and pure precisely so the regression
 * suite can exercise the SAME conversion the page runs, rather than a retyped
 * copy of it that can agree with the test while disagreeing with the app.
 *
 * `phaseU/phaseV` carry the lattice. utmBounds' corner is a real pixel edge, so
 * its offset inside this frame is where whole pixels begin; pixel edges are NOT
 * generally round multiples of the pixel size (Landsat C2 sits at 15 m mod 30).
 * Snapping is only meaningful for an unrotated trial, since rotated plot edges
 * cannot be parallel to pixel edges, so at any other angle it is switched off
 * rather than silently producing a misaligned "aligned" design.
 */
export function blockPlacement(
  utmBounds: [number, number, number, number],
  origin: [number, number],
  rotationDeg: number,
  res: number,
  snapToPixels: boolean,
): { centerU: number; centerV: number; snap: number; phaseU: number; phaseV: number } {
  const [minE, minN, maxE, maxN] = utmBounds;
  const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const toUV = (E: number, N: number): [number, number] => {
    const dx = E - origin[0], dy = N - origin[1];
    return [dx * cos + dy * sin, -dx * sin + dy * cos];
  };
  const [centerU, centerV] = toUV((minE + maxE) / 2, (minN + maxN) / 2);
  const [phaseU, phaseV] = toUV(minE, minN);
  const axisAligned = Math.abs(rotationDeg % 90) < 1e-9;
  return { centerU, centerV, snap: snapToPixels && axisAligned && res > 0 ? res : 0, phaseU, phaseV };
}

export function buildBlockPlan(
  design: BlockDesign,
  place: { centerU: number; centerV: number; snap?: number; phaseU?: number; phaseV?: number },
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

  /**
   * A block is one plot LONG (u) and all its species WIDE (v), and a row of
   * blocks runs along u, across the plots rather than behind them.
   *
   * It used to run along v, the axis the species already stack on, so raising
   * "per row" made the trial longer in the direction it was already longest:
   * two blocks at "11 per row" came out as all ten plots in a single file
   * 248.5 m long, hanging out of both ends of a 156 m field, while "1 per row"
   * was the compact 61.5 x 123.5 m arrangement. The control did the opposite of
   * its name, and its worst value was the one a reader would reach for.
   */
  const blockU = plotLength;
  const blockV = nSpecies * plotWidth + (nSpecies - 1) * plotAlley;
  const pitchU = blockU + blockAlley;
  const pitchV = blockV + blockAlley;
  const totalU = cols * pitchU - blockAlley;
  const totalV = rows * pitchV - blockAlley;

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
  if (snap > 0) {
    // Snap to the PIXEL EDGES, which are not bare multiples of the pixel size:
    // this frame is measured from the drawn field's corner, and the lattice is
    // anchored on the product's own transform. Rounding to multiples of `snap`
    // would put the plots near, but not on, real edges, and the page's promise
    // of plots aligned to whole pixels would quietly become approximate.
    const ph = (p: number | undefined) => (((p || 0) % snap) + snap) % snap;
    const pu = ph(place.phaseU), pv = ph(place.phaseV);
    u0 = Math.floor((u0 - pu) / snap) * snap + pu;
    v0 = Math.floor((v0 - pv) / snap) * snap + pv;
  }

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
  // `cols` blocks run along u; successive rows stack along v (buildBlockPlan).
  const c = Math.floor(du / p.pitchU), r = Math.floor(dv / p.pitchV);
  const b = r * p.cols + c;
  if (b >= p.design.nBlocks) return OFF_TRIAL.id;                 // ragged last row
  const uIn = du - c * p.pitchU, vIn = dv - r * p.pitchV;
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
    const bu = p.u0 + c * p.pitchU, bv = p.v0 + r * p.pitchV;
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

// ===== imported trial (a design uploaded as a file) ==========================

/**
 * The plan of an IMPORTED layout, or null. Keyed on the pattern as well as the
 * plan, like every other reader of the cover map: a plan left on a layout that
 * was switched back to strips must not fold strip ids through its plot table.
 */
function importedOf(layout: SimLayout): ImportedPlan | null {
  return layout.pattern === 'imported' && layout.imported ? layout.imported : null;
}

/** A plot's cover id: its plot id, or its species once plots outnumber the ids. */
const importedCoverId = (plan: ImportedPlan, plot: number): number => (plan.plotIds ? plot : plan.plots[plot].species);

/**
 * Box tests against an imported plan are widened by this much. pointInPoly's
 * crossing abscissa is a rounded quotient that can land a few ulps outside its
 * own edge's x range, so a box with no slack could reject a point the polygon
 * test accepts. A millimetre dwarfs that error and changes no answer.
 */
const BOX_SLACK_M = 1e-3;

/** Buckets of plot indices over the plan, so a point is tested against a few plots, not all. */
interface ImportedIndex {
  x0: number; y0: number; x1: number; y1: number;
  sx: number; sy: number; nx: number; ny: number;
  /** Plot indices whose slack box meets the bucket, ascending. */
  buckets: number[][];
  /** Each plot's slack box, [minE, minN, maxE, maxN] at 4 * plot. */
  boxes: Float64Array;
}
const importedIndexes = new WeakMap<ImportedPlan, ImportedIndex>();

function importedIndex(plan: ImportedPlan): ImportedIndex {
  const hit = importedIndexes.get(plan);
  if (hit) return hit;
  const n = plan.plots.length;
  const boxes = new Float64Array(4 * n);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let p = 0; p < n; p++) {
    let b0 = Infinity, b1 = Infinity, b2 = -Infinity, b3 = -Infinity;
    for (const ring of plan.plots[p].rings) for (const [x, y] of ring) {
      if (x < b0) b0 = x;
      if (x > b2) b2 = x;
      if (y < b1) b1 = y;
      if (y > b3) b3 = y;
    }
    boxes[4 * p] = b0 - BOX_SLACK_M; boxes[4 * p + 1] = b1 - BOX_SLACK_M;
    boxes[4 * p + 2] = b2 + BOX_SLACK_M; boxes[4 * p + 3] = b3 + BOX_SLACK_M;
    x0 = Math.min(x0, boxes[4 * p]); y0 = Math.min(y0, boxes[4 * p + 1]);
    x1 = Math.max(x1, boxes[4 * p + 2]); y1 = Math.max(y1, boxes[4 * p + 3]);
  }
  // The footprint too, so the outer box holds everything that is not off-trial
  // even for a hand-built plan whose footprint reaches past its plots.
  for (const [x, y] of plan.footprint) {
    x0 = Math.min(x0, x - BOX_SLACK_M); y0 = Math.min(y0, y - BOX_SLACK_M);
    x1 = Math.max(x1, x + BOX_SLACK_M); y1 = Math.max(y1, y + BOX_SLACK_M);
  }
  // About one bucket per plot, capped so a sprawling plan cannot allocate a huge table.
  const w = x1 - x0, h = y1 - y0;
  const side = Math.sqrt((Math.max(w, 1e-3) * Math.max(h, 1e-3)) / Math.max(1, n));
  const nx = Math.max(1, Math.min(512, Math.ceil(w / side) || 1));
  const ny = Math.max(1, Math.min(512, Math.ceil(h / side) || 1));
  const sx = w / nx || 1, sy = h / ny || 1;
  const buckets: number[][] = Array.from({ length: nx * ny }, () => []);
  const col = (x: number) => Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / sx)));
  const row = (y: number) => Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / sy)));
  for (let p = 0; p < n; p++) {
    // A plot with no vertex has an inverted box and belongs to no bucket.
    if (!(boxes[4 * p] <= boxes[4 * p + 2] && boxes[4 * p + 1] <= boxes[4 * p + 3])) continue;
    const c1 = col(boxes[4 * p + 2]), r1 = row(boxes[4 * p + 3]);
    for (let r = row(boxes[4 * p + 1]); r <= r1; r++)
      for (let c = col(boxes[4 * p]); c <= c1; c++) buckets[r * nx + c].push(p);
  }
  const idx: ImportedIndex = { x0, y0, x1, y1, sx, sy, nx, ny, buckets, boxes };
  importedIndexes.set(plan, idx);
  return idx;
}

/**
 * What covers a point of an imported trial, in metres of the plan's CRS: the
 * LAST plot containing it (later plots overwrite earlier ones, as they do in the
 * cover map), else bare alley inside the footprint, else off-trial. Containment
 * is pointInPoly's even-odd rule over all of a plot's rings together, the very
 * predicate the rasteriser reproduces, so this and the cover map agree on every
 * fine cell centre.
 *
 * `steps`, when given, is charged one per plot looked at and one per vertex
 * tested. A caller asking thousands of these of a file it did not draw (the
 * resolver's strip search) bounds its work by what they really cost: under a
 * pile of overlapping plots one answer can test every one of them.
 */
export function importedCoverAt(E: number, N: number, plan: ImportedPlan, steps?: { work: number }): number {
  const idx = importedIndex(plan);
  if (!(E >= idx.x0 && E <= idx.x1 && N >= idx.y0 && N <= idx.y1)) return OFF_TRIAL.id;
  const c = Math.min(idx.nx - 1, Math.max(0, Math.floor((E - idx.x0) / idx.sx)));
  const r = Math.min(idx.ny - 1, Math.max(0, Math.floor((N - idx.y0) / idx.sy)));
  const list = idx.buckets[r * idx.nx + c], b = idx.boxes;
  for (let q = list.length - 1; q >= 0; q--) {
    const p = list[q];
    if (E < b[4 * p] || E > b[4 * p + 2] || N < b[4 * p + 1] || N > b[4 * p + 3]) continue;
    let inside = false;
    for (const ring of plan.plots[p].rings) {
      if (steps) steps.work += ring.length;
      if (pointInPoly(E, N, ring)) inside = !inside;
    }
    if (inside) {
      if (steps) steps.work += list.length - q;
      return importedCoverId(plan, p);
    }
  }
  if (steps) steps.work += list.length + plan.footprint.length;
  return pointInPoly(E, N, plan.footprint) ? BARE.id : OFF_TRIAL.id;
}

/**
 * First column whose centre, computed exactly as buildCropMap computes it, is
 * at or east of x. Centres never decrease with the column, so the estimate is
 * only ever walked a step or two to the exact boundary.
 */
function firstCentreAtOrAfter(x: number, minE: number, cols: number, fineRes: number): number {
  let c = Math.ceil((x - minE) / fineRes - 0.5);
  if (!(c > 0)) c = 0;
  else if (c > cols) c = cols;
  while (c > 0 && minE + (c - 1 + 0.5) * fineRes >= x) c--;
  while (c < cols && minE + (c + 0.5) * fineRes < x) c++;
  return c;
}

/**
 * Paint `id` into every fine cell whose CENTRE is inside `rings`, by the
 * even-odd rule over all of them together.
 *
 * Exact, not approximate: for each row it collects the crossings pointInPoly
 * would compute at that row's centre line, from the same vertices in the same
 * order with the same expression, so a centre is painted precisely when
 * pointInPoly (XOR over the rings) accepts it, centres lying on an edge
 * included. A centre is inside when an odd number of crossings lie strictly
 * east of it, so sorting the crossings turns a row into runs filled with one
 * `fill` each. Edges enter an active list in order of their southern end and
 * leave it past their northern end, so a row only looks at edges spanning it.
 */
function fillRings(
  map: Uint8Array, minE: number, minN: number, rows: number, cols: number, fineRes: number,
  rings: [number, number][][], id: number,
): void {
  let total = 0;
  for (const ring of rings) total += ring.length;
  const ends = new Float64Array(4 * total);  // xi, yi, xj, yj: pointInPoly's i and j
  const lo = new Float64Array(total), hi = new Float64Array(total);
  let m = 0;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = ring[i][1], yj = ring[j][1];
      // A horizontal edge never crosses a row; one with a NaN end never toggles
      // pointInPoly either, whatever its crossing test says.
      if (!(yi < yj || yi > yj)) continue;
      ends[4 * m] = ring[i][0]; ends[4 * m + 1] = yi; ends[4 * m + 2] = ring[j][0]; ends[4 * m + 3] = yj;
      lo[m] = Math.min(yi, yj); hi[m] = Math.max(yi, yj);
      m++;
    }
  }
  if (!m) return;
  const order = Array.from({ length: m }, (_, e) => e).sort((a, b) => lo[a] - lo[b]);
  let yMax = -Infinity;
  for (let e = 0; e < m; e++) yMax = Math.max(yMax, hi[e]);
  // A row outside [lo, hi) has no crossing at all, so a row or two of slack on
  // the estimate costs nothing and cannot drop a row that has one.
  const r0 = Math.max(0, Math.floor((lo[order[0]] - minN) / fineRes - 0.5) - 1);
  const r1 = Math.min(rows - 1, Math.ceil((yMax - minN) / fineRes - 0.5) + 1);
  const active = new Int32Array(m);
  const xs = new Float64Array(m);
  let next = 0, nActive = 0;
  for (let r = r0; r <= r1; r++) {
    const N = minN + (r + 0.5) * fineRes;
    while (next < m && lo[order[next]] <= N) active[nActive++] = order[next++];
    let k = 0, kept = 0;
    for (let a = 0; a < nActive; a++) {
      const e = active[a];
      if (hi[e] <= N) continue;            // rows only go north: this edge is done
      active[kept++] = e;
      const xi = ends[4 * e], yi = ends[4 * e + 1], xj = ends[4 * e + 2], yj = ends[4 * e + 3];
      if ((yi > N) !== (yj > N)) {
        const x = ((xj - xi) * (N - yi)) / (yj - yi) + xi;
        if (x === x) xs[k++] = x;          // a NaN crossing never toggles pointInPoly
      }
    }
    nActive = kept;
    if (k > 16) xs.subarray(0, k).sort();
    else for (let i = 1; i < k; i++) {
      const x = xs[i];
      let j = i - 1;
      while (j >= 0 && xs[j] > x) { xs[j + 1] = xs[j]; j--; }
      xs[j + 1] = x;
    }
    // West of every crossing a centre has all k of them east of it.
    const base = r * cols;
    let inside = (k & 1) === 1, from = 0;
    for (let q = 0; q < k; q++) {
      const to = firstCentreAtOrAfter(xs[q], minE, cols, fineRes);
      if (inside && to > from) map.fill(id, base + from, base + to);
      inside = !inside;
      from = to;
    }
  }
}

/**
 * The cover map of an imported trial: off-trial everywhere, the footprint bare,
 * then every plot in file order with its cover id. A later plot overwrites an
 * earlier one where the two overlap, which is also what importedCoverAt answers.
 */
function rasteriseImported(
  map: Uint8Array, minE: number, minN: number, rows: number, cols: number, fineRes: number, plan: ImportedPlan,
): void {
  map.fill(OFF_TRIAL.id);
  fillRings(map, minE, minN, rows, cols, fineRes, [plan.footprint], BARE.id);
  for (let p = 0; p < plan.plots.length; p++) {
    fillRings(map, minE, minN, rows, cols, fineRes, plan.plots[p].rings, importedCoverId(plan, p));
  }
}

// ===== exact cover shares of an imported trial ===============================

/**
 * An imported plan flattened for exact area work, with everything that can be
 * settled once for the whole plan rather than once per pixel.
 *
 * Coordinates stay in the plan's own metres, and every pixel moves the few
 * vertices it needs to ITS OWN corner before clipping. That subtraction is
 * exact (the two are within a factor of two of each other), it keeps a clipped
 * area clear of the 1e-9 m granularity a six-figure UTM easting carries, and it
 * makes a pixel's shares depend on the pixel alone rather than on where the
 * grid it belongs to starts: a ladder rung over the trial's own extent then
 * equals the whole-field run bit for bit, which the suite pins.
 */
interface PlanGeometry {
  nPlots: number;
  /** Every ring's vertices, repeated and closing ones dropped: ring k runs ringStart[k] .. ringStart[k + 1]. */
  vx: Float64Array; vy: Float64Array; ringStart: Int32Array;
  /** Plot p owns rings plotRing[p] .. plotRing[p + 1]. */
  plotRing: Int32Array;
  /** The footprint's ring, the one past every plot's. */
  footRing: number;
  /** [minE, minN, maxE, maxN] per plot at 4 * p, the footprint's at 4 * nPlots. */
  box: Float64Array;
  /** Each plot's cover id: its plot id, or its species where plots outnumber the ids. */
  cover: Uint8Array;
  /**
   * 1 where a shape is ONE ring that never meets itself, so the |shoelace| of
   * any clip of it IS its area: plot p at p, the footprint at nPlots. Anything
   * else (a hole, several parts, a ring crossing itself) needs the sweep, which
   * follows the even-odd rule without caring how the rings lie.
   */
  simple: Uint8Array;
  /** Pairs of plots whose interiors may overlap, as p * nPlots + q with p < q. */
  overlap: Set<number>;
}

const planGeometries = new WeakMap<ImportedPlan, PlanGeometry>();

/** Two points are the same vertex, so the edge between them is no edge at all. */
const samePoint = (x0: number, y0: number, x1: number, y1: number) => x0 === x1 && y0 === y1;

function planGeometry(plan: ImportedPlan): PlanGeometry {
  const hit = planGeometries.get(plan);
  if (hit) return hit;
  const nPlots = plan.plots.length;
  let nRings = 1, nVerts = plan.footprint.length;
  for (const p of plan.plots) { nRings += p.rings.length; for (const r of p.rings) nVerts += r.length; }
  const vx = new Float64Array(nVerts), vy = new Float64Array(nVerts);
  const ringStart = new Int32Array(nRings + 1);
  const plotRing = new Int32Array(nPlots + 1);
  const box = new Float64Array(4 * (nPlots + 1));
  const cover = new Uint8Array(nPlots);
  const simple = new Uint8Array(nPlots + 1);
  let v = 0, k = 0;
  const addRing = (ring: [number, number][]): void => {
    const s = v;
    for (const [x, y] of ring) {
      if (v > s && samePoint(x, y, vx[v - 1], vy[v - 1])) continue;
      vx[v] = x; vy[v] = y; v++;
    }
    // A shapefile ring repeats its first vertex; carrying it would only add a
    // zero-length edge to every test below.
    while (v - s > 1 && samePoint(vx[v - 1], vy[v - 1], vx[s], vy[s])) v--;
    ringStart[k + 1] = v; k++;
  };
  for (let p = 0; p < nPlots; p++) {
    plotRing[p] = k;
    let b0 = Infinity, b1 = Infinity, b2 = -Infinity, b3 = -Infinity;
    for (const ring of plan.plots[p].rings) {
      addRing(ring);
      for (const [x, y] of ring) {
        if (x < b0) b0 = x;
        if (x > b2) b2 = x;
        if (y < b1) b1 = y;
        if (y > b3) b3 = y;
      }
    }
    box[4 * p] = b0; box[4 * p + 1] = b1; box[4 * p + 2] = b2; box[4 * p + 3] = b3;
    cover[p] = importedCoverId(plan, p);
  }
  plotRing[nPlots] = k;
  const footRing = k;
  addRing(plan.footprint);
  let f0 = Infinity, f1 = Infinity, f2 = -Infinity, f3 = -Infinity;
  for (const [x, y] of plan.footprint) {
    if (x < f0) f0 = x;
    if (x > f2) f2 = x;
    if (y < f1) f1 = y;
    if (y > f3) f3 = y;
  }
  box[4 * nPlots] = f0; box[4 * nPlots + 1] = f1; box[4 * nPlots + 2] = f2; box[4 * nPlots + 3] = f3;

  const geo: PlanGeometry = { nPlots, vx, vy, ringStart, plotRing, footRing, box, cover, simple, overlap: new Set<number>() };
  for (let p = 0; p < nPlots; p++) {
    simple[p] = plotRing[p + 1] - plotRing[p] === 1 && ringIsSimple(geo, plotRing[p]) ? 1 : 0;
  }
  simple[nPlots] = ringIsSimple(geo, footRing) ? 1 : 0;
  findOverlaps(geo);
  planGeometries.set(plan, geo);
  return geo;
}

/**
 * Do these two closed segments meet at all? Deliberately generous: a pair that
 * only ALMOST touches is reported as meeting, because every caller answers
 * "then take the slower, general path", and that path is exact either way.
 */
function segmentsMeet(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  if (Math.min(ax, bx) > Math.max(cx, dx) || Math.min(cx, dx) > Math.max(ax, bx)) return false;
  if (Math.min(ay, by) > Math.max(cy, dy) || Math.min(cy, dy) > Math.max(ay, by)) return false;
  const abx = bx - ax, aby = by - ay, cdx = dx - cx, cdy = dy - cy;
  const d1 = abx * (cy - ay) - aby * (cx - ax);
  const d2 = abx * (dy - ay) - aby * (dx - ax);
  const d3 = cdx * (ay - cy) - cdy * (ax - cx);
  const d4 = cdx * (by - cy) - cdy * (bx - cx);
  // A cross product is a length times a distance, so the slack is a length
  // times the nanometre that separates "on the line" from "beside it".
  const t1 = 1e-9 * (Math.abs(abx) + Math.abs(aby)) * (1 + Math.abs(cdx) + Math.abs(cdy));
  const t2 = 1e-9 * (Math.abs(cdx) + Math.abs(cdy)) * (1 + Math.abs(abx) + Math.abs(aby));
  const straddleAB = (d1 <= t1 && d2 >= -t1) || (d1 >= -t1 && d2 <= t1);
  const straddleCD = (d3 <= t2 && d4 >= -t2) || (d3 >= -t2 && d4 <= t2);
  return straddleAB && straddleCD;
}

/**
 * Does this ring never meet itself? Neighbouring edges are skipped: they share
 * a vertex by construction, and a spike that doubles back along one of them
 * covers no ground, so neither the winding number nor the shoelace notices it.
 *
 * Dense rings are bucketed rather than compared pair by pair, and a ring that
 * would exhaust the budget answers "no" instead of stalling the page: "no" only
 * costs the sweep, while a wrong "yes" would cost the wrong area.
 */
function ringIsSimple(geo: PlanGeometry, ring: number): boolean {
  const from = geo.ringStart[ring], m = geo.ringStart[ring + 1] - from;
  if (m < 4) return true;                     // a triangle has no non-adjacent pair
  const { vx, vy } = geo;
  const meets = (i: number, j: number): boolean => {
    if (i === j) return false;
    const i2 = i + 1 === m ? 0 : i + 1, j2 = j + 1 === m ? 0 : j + 1;
    if (i2 === j || j2 === i) return false;    // neighbours share that vertex
    return segmentsMeet(vx[from + i], vy[from + i], vx[from + i2], vy[from + i2],
                        vx[from + j], vy[from + j], vx[from + j2], vy[from + j2]);
  };
  if (m <= 48) {
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) if (meets(i, j)) return false;
    return true;
  }
  // One bucket per handful of edges, so a ring's own neighbourhood is all each
  // edge is compared against.
  const side = Math.max(1, Math.min(256, Math.round(Math.sqrt(m / 4))));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = from; i < from + m; i++) {
    if (vx[i] < x0) x0 = vx[i];
    if (vx[i] > x1) x1 = vx[i];
    if (vy[i] < y0) y0 = vy[i];
    if (vy[i] > y1) y1 = vy[i];
  }
  if (!(x1 >= x0 && y1 >= y0)) return false;   // a NaN vertex: nothing can be trusted
  const sx = (x1 - x0) / side || 1, sy = (y1 - y0) / side || 1;
  const buckets: number[][] = Array.from({ length: side * side }, () => []);
  let budget = 64 * m + 4096;
  for (let i = 0; i < m; i++) {
    const i2 = i + 1 === m ? 0 : i + 1;
    const ax = vx[from + i], ay = vy[from + i], bx = vx[from + i2], by = vy[from + i2];
    const c0 = Math.max(0, Math.min(side - 1, Math.floor((Math.min(ax, bx) - x0) / sx)));
    const c1 = Math.max(0, Math.min(side - 1, Math.floor((Math.max(ax, bx) - x0) / sx)));
    const r0 = Math.max(0, Math.min(side - 1, Math.floor((Math.min(ay, by) - y0) / sy)));
    const r1 = Math.max(0, Math.min(side - 1, Math.floor((Math.max(ay, by) - y0) / sy)));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > budget) return false;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { buckets[r * side + c].push(i); budget--; }
  }
  for (const list of buckets) {
    const n = list.length;
    budget -= (n * (n - 1)) / 2;
    if (budget < 0) return false;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (meets(list[a], list[b])) return false;
  }
  return true;
}

/**
 * Twice the signed area of a ring, by the shoelace formula about its own first
 * vertex: a shoelace over raw eastings would multiply six-figure numbers to
 * within a thousandth of a square metre of each other.
 */
function ringArea2(geo: PlanGeometry, ring: number): number {
  const from = geo.ringStart[ring], to = geo.ringStart[ring + 1];
  const { vx, vy } = geo;
  const ox = vx[from], oy = vy[from];
  let a = 0;
  for (let i = from, j = to - 1; i < to; j = i++) a += (vx[j] - ox) * (vy[i] - oy) - (vx[i] - ox) * (vy[j] - oy);
  return a;
}

/** Does this ring turn the same way at every corner? Only asked of simple rings, where that means convex. */
function ringIsConvex(geo: PlanGeometry, ring: number): boolean {
  const from = geo.ringStart[ring], m = geo.ringStart[ring + 1] - from;
  if (m < 3) return false;
  const { vx, vy } = geo;
  let pos = false, neg = false;
  for (let i = 0; i < m; i++) {
    const a = from + i, b = from + (i + 1 === m ? 0 : i + 1), c = from + (i + 2 >= m ? i + 2 - m : i + 2);
    const ux = vx[b] - vx[a], uy = vy[b] - vy[a], wx = vx[c] - vx[b], wy = vy[c] - vy[b];
    const cross = ux * wy - uy * wx;
    const tol = 1e-12 * (Math.abs(ux) + Math.abs(uy)) * (Math.abs(wx) + Math.abs(wy));
    if (cross > tol) pos = true;
    else if (cross < -tol) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

/**
 * Clipping scratch: two ping-pong vertex buffers, grown on demand and reused by
 * every pixel, because a 67,000-pixel run clips a few thousand rings and an
 * array per clip would cost more than the arithmetic.
 */
let clipAx = new Float64Array(64), clipAy = new Float64Array(64);
let clipBx = new Float64Array(64), clipBy = new Float64Array(64);

function clipRoom(n: number): void {
  if (clipAx.length >= n) return;
  let size = clipAx.length;
  while (size < n) size *= 2;
  const ax = new Float64Array(size); ax.set(clipAx); clipAx = ax;
  const ay = new Float64Array(size); ay.set(clipAy); clipAy = ay;
  clipBx = new Float64Array(size);
  clipBy = new Float64Array(size);
}

/** Loads a ring into the clip buffer, moved to (ox, oy). */
function clipLoad(geo: PlanGeometry, ring: number, ox: number, oy: number): number {
  const from = geo.ringStart[ring], to = geo.ringStart[ring + 1];
  clipRoom(2 * (to - from) + 8);
  let n = 0;
  for (let i = from; i < to; i++) { clipAx[n] = geo.vx[i] - ox; clipAy[n] = geo.vy[i] - oy; n++; }
  return n;
}

/**
 * One Sutherland-Hodgman pass: keeps the part of the clip buffer on the inside
 * of an axis-parallel line, and leaves the result in the clip buffer.
 *
 * A crossing lands exactly ON the line, so two neighbouring pixels cut the same
 * edge at the same place and the ground between them is counted once.
 */
function clipHalfAxis(n: number, vertical: boolean, bound: number, keepGreater: boolean): number {
  if (n === 0) return 0;
  clipRoom(2 * n);
  const ax = clipAx, ay = clipAy, bx = clipBx, by = clipBy;
  let out = 0;
  let px = ax[n - 1], py = ay[n - 1];
  let pv = vertical ? py : px;
  let pIn = keepGreater ? pv >= bound : pv <= bound;
  for (let i = 0; i < n; i++) {
    const cx = ax[i], cy = ay[i];
    const cv = vertical ? cy : cx;
    const cIn = keepGreater ? cv >= bound : cv <= bound;
    if (cIn !== pIn) {
      const t = (bound - pv) / (cv - pv);
      if (vertical) { bx[out] = px + (cx - px) * t; by[out] = bound; }
      else { bx[out] = bound; by[out] = py + (cy - py) * t; }
      out++;
    }
    if (cIn) { bx[out] = cx; by[out] = cy; out++; }
    px = cx; py = cy; pv = cv; pIn = cIn;
  }
  clipAx = bx; clipAy = by; clipBx = ax; clipBy = ay;
  return out;
}

/** The same pass against an arbitrary line through (ax, ay) and (bx, by), keeping `sgn`'s side. */
function clipHalfLine(n: number, ax: number, ay: number, bx: number, by: number, sgn: number): number {
  if (n === 0) return 0;
  clipRoom(2 * n);
  const px0 = clipAx, py0 = clipAy, ox = clipBx, oy = clipBy;
  const ex = bx - ax, ey = by - ay;
  let out = 0;
  let px = px0[n - 1], py = py0[n - 1];
  let pd = sgn * (ex * (py - ay) - ey * (px - ax));
  for (let i = 0; i < n; i++) {
    const cx = px0[i], cy = py0[i];
    const cd = sgn * (ex * (cy - ay) - ey * (cx - ax));
    if ((cd >= 0) !== (pd >= 0)) {
      const t = pd / (pd - cd);
      ox[out] = px + (cx - px) * t; oy[out] = py + (cy - py) * t; out++;
    }
    if (cd >= 0) { ox[out] = cx; oy[out] = cy; out++; }
    px = cx; py = cy; pd = cd;
  }
  clipAx = ox; clipAy = oy; clipBx = px0; clipBy = py0;
  return out;
}

/** Twice the signed area of the clip buffer. */
function clipArea2(n: number): number {
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += clipAx[j] * clipAy[i] - clipAx[i] * clipAy[j];
  return a;
}

/**
 * A ring clipped to the pixel square [0, s] x [0, s] around (cE, cN), left in
 * the clip buffer. The clipped ring winds around every point of the square
 * exactly as the original does, whatever the original does elsewhere, so its
 * signed area is the winding number integrated over the square and its
 * crossings are the original's crossings.
 */
function clipRingToPixel(geo: PlanGeometry, ring: number, cE: number, cN: number, s: number): number {
  let n = clipLoad(geo, ring, cE, cN);
  if (n < 3) return 0;
  n = clipHalfAxis(n, false, 0, true);
  if (n < 3) return 0;
  n = clipHalfAxis(n, false, s, false);
  if (n < 3) return 0;
  n = clipHalfAxis(n, true, 0, true);
  if (n < 3) return 0;
  return clipHalfAxis(n, true, s, false);
}

/** The area of a SIMPLE ring inside that pixel square: a simple ring winds 0 or 1 times, so this is the ground it holds. */
function clipRingArea(geo: PlanGeometry, ring: number, cE: number, cN: number, s: number): number {
  const n = clipRingToPixel(geo, ring, cE, cN, s);
  return n < 3 ? 0 : Math.abs(clipArea2(n)) / 2;
}

/**
 * Which plots might overlap, decided once for the plan: a pixel holding two
 * plots that only touch can add their areas, which is most pixels of a
 * contiguous trial, while a pixel holding two that really overlap has to be
 * swept so the later plot wins the ground they share.
 *
 * A pair is called overlapping unless it can be PROVEN not to be: the proof is
 * an exact clip of one against the other, which needs one of them convex, and
 * an area below a billionth of the smaller plot, which is the width a shared
 * edge acquires from rounding, never a strip of crop.
 */
function findOverlaps(geo: PlanGeometry): void {
  const n = geo.nPlots;
  if (n < 2) return;
  const box = geo.box;
  const order = Array.from({ length: n }, (_, p) => p).sort((a, b) => box[4 * a] - box[4 * b]);
  const convex = new Uint8Array(n);
  const area = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    if (!geo.simple[p]) continue;
    convex[p] = ringIsConvex(geo, geo.plotRing[p]) ? 1 : 0;
    area[p] = Math.abs(ringArea2(geo, geo.plotRing[p])) / 2;
  }
  for (let a = 0; a < n; a++) {
    const p = order[a];
    for (let b = a + 1; b < n; b++) {
      const q = order[b];
      if (box[4 * q] >= box[4 * p + 2]) break;                       // sorted: no later plot can reach back
      if (box[4 * p] >= box[4 * q + 2]) continue;
      if (box[4 * p + 1] >= box[4 * q + 3] || box[4 * q + 1] >= box[4 * p + 3]) continue;
      // Only simple plots are ever added up rather than swept, so a pair with a
      // hole or several parts in it needs no answer here.
      if (!geo.simple[p] || !geo.simple[q]) continue;
      const lo = Math.min(p, q), hi = Math.max(p, q);
      let shared: number;
      if (convex[q]) shared = convexClipArea(geo, geo.plotRing[p], geo.plotRing[q]);
      else if (convex[p]) shared = convexClipArea(geo, geo.plotRing[q], geo.plotRing[p]);
      else shared = Infinity;                                        // neither is a clip window: assume the worst
      if (shared > 1e-9 * Math.min(area[p], area[q])) geo.overlap.add(lo * n + hi);
    }
  }
}

/** The area `sub` shares with the CONVEX ring `win`, both moved to `win`'s first vertex. */
function convexClipArea(geo: PlanGeometry, sub: number, win: number): number {
  const from = geo.ringStart[win], to = geo.ringStart[win + 1], m = to - from;
  if (m < 3) return 0;
  const ox = geo.vx[from], oy = geo.vy[from];
  const sgn = ringArea2(geo, win) >= 0 ? 1 : -1;
  let n = clipLoad(geo, sub, ox, oy);
  for (let i = 0; i < m && n >= 3; i++) {
    const a = from + i, b = from + (i + 1 === m ? 0 : i + 1);
    const ax = geo.vx[a] - ox, ay = geo.vy[a] - oy, bx = geo.vx[b] - ox, by = geo.vy[b] - oy;
    // Two vertices a hair apart give no usable direction; skipping that side
    // only widens the window, which can only overstate the shared ground.
    if (Math.abs(bx - ax) + Math.abs(by - ay) < 1e-9) continue;
    n = clipHalfLine(n, ax, ay, bx, by, sgn);
  }
  return n < 3 ? 0 : Math.abs(clipArea2(n)) / 2;
}

/**
 * Sweep scratch: the clipped edges of one pixel, the heights where the order of
 * those edges can change, and the working arrays of one slab.
 */
let swXLo = new Float64Array(64), swYLo = new Float64Array(64);
let swXHi = new Float64Array(64), swYHi = new Float64Array(64);
let swSrc = new Int32Array(64);
let swXa = new Float64Array(64), swXb = new Float64Array(64);
let swOrd = new Int32Array(64), swKey = new Float64Array(64);
let swYOrd = new Int32Array(64);
let swEv = new Float64Array(256);
let swParity = new Uint8Array(16);

function sweepRoom(n: number): void {
  if (swXLo.length >= n) return;
  let size = swXLo.length;
  while (size < n) size *= 2;
  const xl = new Float64Array(size); xl.set(swXLo); swXLo = xl;
  const yl = new Float64Array(size); yl.set(swYLo); swYLo = yl;
  const xh = new Float64Array(size); xh.set(swXHi); swXHi = xh;
  const yh = new Float64Array(size); yh.set(swYHi); swYHi = yh;
  const sr = new Int32Array(size); sr.set(swSrc); swSrc = sr;
  swXa = new Float64Array(size); swXb = new Float64Array(size);
  swOrd = new Int32Array(size); swKey = new Float64Array(size);
}

/**
 * The exact share of one pixel taken by each of several covers that meet in it,
 * by a slab sweep of their clipped rings.
 *
 * Sources are given LOWEST priority first, and the ground at a point belongs to
 * the last source the even-odd rule puts it inside, which is what the
 * rasteriser does when a later plot is painted over an earlier one. Ground no
 * source covers belongs to the background, whose area comes back at index
 * `nSrc`. The heights where two edges cross are cut points of the sweep, so
 * inside a slab the edges keep their order and the ground between two of them
 * is one trapezium: the answer is exact for holes, several parts, rings that
 * cross each other or themselves, and plots that overlap, none of which the
 * shoelace of a clipped ring could be trusted with.
 */
function sweepPixel(
  geo: PlanGeometry, nSrc: number, srcFrom: Int32Array, srcTo: Int32Array, srcSimple: Uint8Array,
  cE: number, cN: number, s: number, out: Float64Array,
): void {
  out.fill(0, 0, nSrc + 1);
  if (swParity.length < nSrc) swParity = new Uint8Array(Math.max(2 * swParity.length, nSrc));
  let nE = 0;
  for (let q = 0; q < nSrc; q++) {
    for (let r = srcFrom[q]; r < srcTo[q]; r++) {
      const m = clipRingToPixel(geo, r, cE, cN, s);
      if (m < 3) continue;
      sweepRoom(nE + m);
      for (let i = 0, j = m - 1; i < m; j = i++) {
        const ya = clipAy[j], yb = clipAy[i];
        if (!(ya !== yb)) continue;              // a horizontal edge crosses no row
        if (ya < yb) { swXLo[nE] = clipAx[j]; swYLo[nE] = ya; swXHi[nE] = clipAx[i]; swYHi[nE] = yb; }
        else { swXLo[nE] = clipAx[i]; swYLo[nE] = yb; swXHi[nE] = clipAx[j]; swYHi[nE] = ya; }
        swSrc[nE] = q; nE++;
      }
    }
  }
  if (nE === 0) { out[nSrc] = s * s; return; }

  let nY = 0;
  // Every edge contributes its two ends, and the crossings are added as they
  // are found: a pixel holding n edges could in principle hold n(n-1)/2 of
  // them, but it never does, and asking for that many up front is gigabytes of
  // zeroed array for a dense ring that crosses itself a handful of times.
  if (swEv.length < 2 * nE + 2) swEv = new Float64Array(Math.max(2 * swEv.length, 2 * nE + 2));
  swEv[nY++] = 0; swEv[nY++] = s;
  for (let i = 0; i < nE; i++) {
    swEv[nY++] = swYLo[i] < 0 ? 0 : swYLo[i] > s ? s : swYLo[i];
    swEv[nY++] = swYHi[i] < 0 ? 0 : swYHi[i] > s ? s : swYHi[i];
  }
  // Two edges can only cross where their heights overlap. Reading the edges
  // lowest end first lets the inner loop stop at the first edge starting above
  // the outer one's top, which skips the pairs the height test would have
  // thrown away anyway: same crossings, and a dense ring inside one pixel no
  // longer costs a pass over every pair. Sorting is only worth its own cost
  // once there are edges enough to skip, so a small pixel is read as it lies.
  const sorted = nE > 64;
  if (sorted) {
    if (swYOrd.length < nE) swYOrd = new Int32Array(Math.max(2 * swYOrd.length, nE));
    const ord = swYOrd.subarray(0, nE);
    for (let i = 0; i < nE; i++) ord[i] = i;
    ord.sort((a, b) => swYLo[a] - swYLo[b]);
  }
  for (let a = 0; a < nE; a++) {
    const i = sorted ? swYOrd[a] : a;
    const si = swSrc[i], hi = swYHi[i];
    for (let b = a + 1; b < nE; b++) {
      const j = sorted ? swYOrd[b] : b;
      if (sorted && swYLo[j] >= hi) break;           // it starts above this edge's top, and so does every edge after it
      const sj = swSrc[j];
      // Two edges of one ring that never meets itself cannot cross, so only a
      // pair from different covers, or from a shape that may cross itself, is
      // worth the arithmetic.
      if (si === sj && srcSimple[si]) continue;
      const ya = Math.max(swYLo[i], swYLo[j]), yb = Math.min(hi, swYHi[j]);
      if (!(yb > ya)) continue;
      const da = sweepX(i, ya) - sweepX(j, ya), db = sweepX(i, yb) - sweepX(j, yb);
      if (!((da < 0 && db > 0) || (da > 0 && db < 0))) continue;
      const y = ya + ((yb - ya) * da) / (da - db);
      if (y > ya && y < yb) {
        if (nY === swEv.length) { const grown = new Float64Array(2 * nY); grown.set(swEv); swEv = grown; }
        swEv[nY++] = y;
      }
    }
  }
  const ev = swEv.subarray(0, nY);
  ev.sort();

  for (let e = 0; e + 1 < nY; e++) {
    const ya = ev[e], yb = ev[e + 1];
    const h = yb - ya;
    if (!(h > 0)) continue;
    let nA = 0;
    for (let i = 0; i < nE; i++) {
      if (!(swYLo[i] <= ya && swYHi[i] >= yb)) continue;
      const xa = sweepX(i, ya), xb = sweepX(i, yb);
      swXa[i] = xa; swXb[i] = xb;
      const key = xa + xb;
      let q = nA;
      while (q > 0 && swKey[q - 1] > key) { swOrd[q] = swOrd[q - 1]; swKey[q] = swKey[q - 1]; q--; }
      swOrd[q] = i; swKey[q] = key; nA++;
    }
    swParity.fill(0, 0, nSrc);
    let curLo = 0, curHi = 0, vis = nSrc;
    for (let t = 0; t < nA; t++) {
      const i = swOrd[t];
      const xa = swXa[i], xb = swXb[i];
      out[vis] += ((xa - curLo) + (xb - curHi)) * h * 0.5;
      const q = swSrc[i];
      swParity[q] ^= 1;
      vis = nSrc;
      for (let u = nSrc - 1; u >= 0; u--) if (swParity[u]) { vis = u; break; }
      curLo = xa; curHi = xb;
    }
    out[vis] += ((s - curLo) + (s - curHi)) * h * 0.5;
  }
}

/** Where edge `i` of the sweep stands at height `y`, its own ends returned exactly. */
function sweepX(i: number, y: number): number {
  const yl = swYLo[i], yh = swYHi[i];
  if (y <= yl) return swXLo[i];
  if (y >= yh) return swXHi[i];
  return swXLo[i] + ((swXHi[i] - swXLo[i]) * (y - yl)) / (yh - yl);
}

/** Crossing scratch for the scan: where one row's centre line meets the rings. */
let scanXs = new Float64Array(64);

/**
 * What one cover does to every pixel of the grid: which pixels its boundary
 * runs through (`touched`), which pixels it covers whole (`full`), and which
 * pixel centres are inside it (`centre`, painted `centreId` like the rasteriser
 * paints its fine cells).
 *
 * A pixel no edge comes near is inside or outside as a whole, so its centre
 * decides it, by the very crossing count pointInPoly uses. Pixels the boundary
 * runs through are left to exact clipping. The boundary is followed generously:
 * a pixel wrongly called touched only costs a clip that returns the whole
 * square or nothing, while a missed one would take a cover's share from it.
 */
function scanSource(
  geo: PlanGeometry, ring0: number, ring1: number,
  minE: number, minN: number, nx: number, ny: number, res: number, eps: number,
  stamp: Int32Array, mark: number, touched: number[], full: number[],
  centre: Uint8Array, centreId: number,
): void {
  const { vx, vy, ringStart } = geo;
  let edges = 0;
  for (let r = ring0; r < ring1; r++) edges += ringStart[r + 1] - ringStart[r];
  if (scanXs.length < edges) scanXs = new Float64Array(Math.max(2 * scanXs.length, edges));

  // The boundary, edge by edge, row band by row band.
  let yMin = Infinity, yMax = -Infinity;
  for (let r = ring0; r < ring1; r++) {
    const from = ringStart[r], m = ringStart[r + 1] - from;
    if (m < 2) continue;
    for (let i = 0; i < m; i++) {
      const a = from + i, b = from + (i + 1 === m ? 0 : i + 1);
      const ax = vx[a] - minE, ay = vy[a] - minN, bx = vx[b] - minE, by = vy[b] - minN;
      if (ay < yMin) yMin = ay;
      if (ay > yMax) yMax = ay;
      const ylo = ay < by ? ay : by, yhi = ay < by ? by : ay;
      let j0 = Math.floor((ylo - eps) / res), j1 = Math.floor((yhi + eps) / res);
      if (!(j1 >= 0) || !(j0 <= ny - 1)) continue;
      if (j0 < 0) j0 = 0;
      if (j1 > ny - 1) j1 = ny - 1;
      const dx = bx - ax, dy = by - ay;
      const eLo = ax < bx ? ax : bx, eHi = ax < bx ? bx : ax;
      for (let j = j0; j <= j1; j++) {
        let xlo = eLo, xhi = eHi;
        if (dy !== 0) {
          const lo = Math.max(ylo, j * res - eps), hi = Math.min(yhi, (j + 1) * res + eps);
          const x1 = ax + dx * ((lo - ay) / dy), x2 = ax + dx * ((hi - ay) / dy);
          // An edge that is nearly horizontal divides by a nearly zero dy, so
          // where it enters a band is known only to within this much.
          const slack = eps + (Math.abs(dx) * 2.3e-16 * (Math.abs(lo) + Math.abs(hi) + Math.abs(ay))) / Math.abs(dy);
          xlo = Math.max(eLo, (x1 < x2 ? x1 : x2) - slack);
          xhi = Math.min(eHi, (x1 < x2 ? x2 : x1) + slack);
        }
        let i0 = Math.floor((xlo - eps) / res), i1 = Math.floor((xhi + eps) / res);
        if (!(i1 >= 0) || !(i0 <= nx - 1)) continue;
        if (i0 < 0) i0 = 0;
        if (i1 > nx - 1) i1 = nx - 1;
        const base = j * nx;
        for (let c = i0; c <= i1; c++) {
          const k = base + c;
          if (stamp[k] !== mark) { stamp[k] = mark; touched.push(k); }
        }
      }
    }
  }
  if (!(yMax >= yMin)) return;

  // Row by row, the centres the cover holds: pointInPoly's own crossings, so
  // the pixel centres of this grid are classified exactly as the fine grid's
  // cell centres are.
  let j0 = Math.floor((yMin - eps) / res), j1 = Math.floor((yMax + eps) / res);
  if (!(j1 >= 0) || !(j0 <= ny - 1)) return;
  if (j0 < 0) j0 = 0;
  if (j1 > ny - 1) j1 = ny - 1;
  for (let j = j0; j <= j1; j++) {
    const yc = (j + 0.5) * res;
    let n = 0;
    for (let r = ring0; r < ring1; r++) {
      const from = ringStart[r], m = ringStart[r + 1] - from;
      if (m < 2) continue;
      for (let i = 0; i < m; i++) {
        const a = from + i, b = from + (i + 1 === m ? 0 : i + 1);
        const ay = vy[a] - minN, by = vy[b] - minN;
        if ((ay > yc) === (by > yc)) continue;
        const ax = vx[a] - minE, bx = vx[b] - minE;
        const x = ((bx - ax) * (yc - ay)) / (by - ay) + ax;
        if (x === x) scanXs[n++] = x;
      }
    }
    if (n < 2) continue;
    if (n > 16) scanXs.subarray(0, n).sort();
    else for (let i = 1; i < n; i++) {
      const x = scanXs[i];
      let q = i - 1;
      while (q >= 0 && scanXs[q] > x) { scanXs[q + 1] = scanXs[q]; q--; }
      scanXs[q + 1] = x;
    }
    // A centre is inside when an odd number of crossings lie east of it, so the
    // run that starts at crossing q holds n - 1 - q of them.
    const base = j * nx;
    for (let q = n - 1; q >= 0; q--) {
      if (((n - 1 - q) & 1) === 0) continue;
      let from = Math.ceil(scanXs[q] / res - 0.5);
      let to = q + 1 < n ? Math.ceil(scanXs[q + 1] / res - 0.5) : nx;
      if (from < 0) from = 0;
      if (to > nx) to = nx;
      for (let c = from; c < to; c++) {
        const k = base + c;
        centre[k] = centreId;
        if (stamp[k] !== mark) full.push(k);
      }
    }
  }
}

/** One pixel's working room: the covers it holds, and the plots whose boundary runs through it. */
let shCover = new Int32Array(16), shW = new Float64Array(16);
let listL = new Int32Array(16), capW = new Float64Array(16);
let srcFrom = new Int32Array(16), srcTo = new Int32Array(16), srcSimple = new Uint8Array(16), sweepOut = new Float64Array(17);

function shareRoom(n: number): void {
  if (shCover.length >= n) return;
  let size = shCover.length;
  while (size < n) size *= 2;
  shCover = new Int32Array(size); shW = new Float64Array(size);
  listL = new Int32Array(size); capW = new Float64Array(size);
  srcFrom = new Int32Array(size); srcTo = new Int32Array(size); srcSimple = new Uint8Array(size);
  sweepOut = new Float64Array(size + 1);
}

/**
 * Adds one cover's ground to the pixel's list, which is kept in ASCENDING COVER
 * ID: that order is what phase 2 sums the weights in and what breaks a
 * dominance tie, so it is fixed here rather than left to whichever plot the
 * geometry happened to reach first. Plots sharing a cover id (a design with
 * more plots than the cover map can number counts by species) are added up in
 * file order, the order the rasteriser paints them in.
 */
function addShare(cover: number, w: number, n: number): number {
  let i = n;
  while (i > 0 && shCover[i - 1] > cover) i--;
  if (i > 0 && shCover[i - 1] === cover) { shW[i - 1] += w; return n; }
  for (let q = n; q > i; q--) { shCover[q] = shCover[q - 1]; shW[q] = shW[q - 1]; }
  shCover[i] = cover; shW[i] = w;
  return n + 1;
}

/**
 * Phase 1 for an imported trial, from EXACT polygon areas: what each cover
 * holds of every pixel of an nx x ny grid whose south-west corner is
 * (minE, minN) and whose pixels are `res` metres square.
 *
 * Why not sample: the fine grid classifies each of g x g cells by its centre,
 * so a pixel's share of a plot is rounded to 1/g^2, and g is 4 for plots wider
 * than the pixel. Along a tilted edge those roundings cancel; along an edge
 * PARALLEL to the pixel rows every pixel rounds the same way, so a trial staked
 * along the grid lost pure pixels it really had, and the page told the
 * agronomist that lining a trial up with the satellite was not worth it.
 *
 * The rules, all three visible in the shares that come back:
 *  - a weight is the SQUARE METRES a cover holds of the pixel, and the weights
 *    of a pixel add up to its area with nothing negative;
 *  - ground inside the footprint that no plot covers is bare alley, ground
 *    outside it is off-trial, and a plot painted over another wins what they
 *    share, as the rasteriser and importedCoverAt have it;
 *  - the covers of a pixel are listed in ascending cover id, then bare, then
 *    off-trial.
 */
function importedPixelCovers(
  plan: ImportedPlan, minE: number, minN: number, nx: number, ny: number, res: number,
): { pc: PixelCovers; centre: Uint8Array } {
  const geo = planGeometry(plan);
  const nPlots = geo.nPlots;
  const cells = nx * ny;
  const A = res * res;
  // The width below which a boundary is treated as running through a pixel
  // rather than beside it, generous enough to swallow every rounding a metre
  // coordinate of this grid carries.
  const eps = 1e-9 * (res + nx * res + ny * res);

  const centre = new Uint8Array(cells).fill(OFF_TRIAL.id);
  const footState = new Uint8Array(cells);
  const topFull = new Int32Array(cells).fill(-1);
  const head = new Int32Array(cells).fill(-1);
  const tail = new Int32Array(cells);
  const poolNext: number[] = [];
  const poolPlot: number[] = [];
  const stamp = new Int32Array(cells);
  const touched: number[] = [];
  const full: number[] = [];

  scanSource(geo, geo.footRing, geo.footRing + 1, minE, minN, nx, ny, res, eps, stamp, 1, touched, full, centre, BARE.id);
  for (const k of touched) footState[k] = 2;
  for (const k of full) footState[k] = 1;
  for (let p = 0; p < nPlots; p++) {
    touched.length = 0;
    full.length = 0;
    scanSource(geo, geo.plotRing[p], geo.plotRing[p + 1], minE, minN, nx, ny, res, eps, stamp, p + 2, touched, full, centre, geo.cover[p]);
    for (const k of touched) {
      const e = poolNext.length;
      poolNext.push(-1);
      poolPlot.push(p);
      if (head[k] === -1) head[k] = e; else poolNext[tail[k]] = e;
      tail[k] = e;
    }
    // A plot covering a whole pixel hides every earlier one there, so the list
    // a pixel carries is only ever the plots drawn OVER its topmost full one.
    for (const k of full) { topFull[k] = p; head[k] = -1; }
  }

  shareRoom(nPlots + 4);
  const foot = geo.footRing;
  const pairStart = new Int32Array(cells + 1);
  let pairCap = cells + 16;
  let pairSlot = new Int32Array(pairCap);
  let pairW = new Float64Array(pairCap);
  let pairLen = 0;

  for (let j = 0; j < ny; j++) {
    const cN = minN + j * res;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const cE = minE + i * res;
      const base = topFull[k];
      let nL = 0;
      for (let e = head[k]; e !== -1; e = poolNext[e]) listL[nL++] = poolPlot[e];
      let nSh = 0, bare = 0, off = 0;

      if (nL === 0) {
        // No plot boundary in this pixel: it is one cover from edge to edge,
        // unless the footprint's own edge crosses it.
        if (base >= 0) nSh = addShare(geo.cover[base], A, nSh);
        else if (footState[k] === 1) bare = A;
        else if (footState[k] === 0) off = A;
        else if (geo.simple[nPlots]) {
          const h = Math.min(A, Math.max(0, clipRingArea(geo, foot, cE, cN, res)));
          bare = h;
          off = A - h;
        } else {
          srcFrom[0] = foot; srcTo[0] = foot + 1; srcSimple[0] = 0;
          sweepPixel(geo, 1, srcFrom, srcTo, srcSimple, cE, cN, res, sweepOut);
          bare = Math.max(0, sweepOut[0]);
          off = Math.max(0, sweepOut[1]);
        }
      } else {
        // Plots that only touch can be added up; a hole, several parts or two
        // plots that really overlap need the sweep, and so does a pixel the
        // footprint's edge crosses, where what is alley and what is off-trial
        // is a question about the plots too.
        let plain = true;
        for (let q = 0; q < nL && plain; q++) if (!geo.simple[listL[q]]) plain = false;
        // A trial whose plots only ever touch has nothing to look up here, and
        // that is most of them.
        for (let q = 0; q < nL && plain && geo.overlap.size > 0; q++) {
          for (let u = q + 1; u < nL; u++) {
            const a = listL[q], b = listL[u];
            if (geo.overlap.has((a < b ? a : b) * nPlots + (a < b ? b : a))) { plain = false; break; }
          }
        }
        const footPartial = base < 0 && footState[k] === 2;
        if (plain && !footPartial) {
          let remaining = A;
          for (let q = nL - 1; q >= 0; q--) {
            let a = clipRingArea(geo, geo.plotRing[listL[q]], cE, cN, res);
            if (!(a > 0)) a = 0;
            // Later plots are served first, so a rounding sliver, or a plot
            // drawn over another the pair test could not separate, is taken
            // from the earlier plot, never from the pixel's area.
            if (a > remaining) a = remaining;
            capW[q] = a;
            remaining -= a;
          }
          if (!(remaining > 0)) remaining = 0;
          if (base >= 0) nSh = addShare(geo.cover[base], remaining, nSh);
          else if (footState[k] === 1) bare = remaining;
          else off = remaining;
          for (let q = 0; q < nL; q++) if (capW[q] > 0) nSh = addShare(geo.cover[listL[q]], capW[q], nSh);
        } else {
          let nSrc = 0;
          if (footPartial) { srcFrom[0] = foot; srcTo[0] = foot + 1; srcSimple[0] = geo.simple[nPlots]; nSrc = 1; }
          for (let q = 0; q < nL; q++) {
            const p = listL[q];
            srcFrom[nSrc] = geo.plotRing[p];
            srcTo[nSrc] = geo.plotRing[p + 1];
            srcSimple[nSrc] = geo.simple[p];
            nSrc++;
          }
          sweepPixel(geo, nSrc, srcFrom, srcTo, srcSimple, cE, cN, res, sweepOut);
          const bg = Math.max(0, sweepOut[nSrc]);
          if (base >= 0) nSh = addShare(geo.cover[base], bg, nSh);
          else if (footState[k] === 1) bare = bg;
          else off = bg;
          if (footPartial) bare += Math.max(0, sweepOut[0]);
          for (let q = 0; q < nL; q++) {
            const w = Math.max(0, sweepOut[footPartial ? q + 1 : q]);
            if (w > 0) nSh = addShare(geo.cover[listL[q]], w, nSh);
          }
        }
      }

      if (pairLen + nSh + 2 > pairCap) {
        pairCap = Math.max(pairCap * 2, pairLen + nSh + 2);
        const nextSlot = new Int32Array(pairCap); nextSlot.set(pairSlot); pairSlot = nextSlot;
        const nextW = new Float64Array(pairCap); nextW.set(pairW); pairW = nextW;
      }
      pairStart[k] = pairLen;
      for (let q = 0; q < nSh; q++) {
        if (!(shW[q] > 0)) continue;                 // a cover with no ground is no cover
        pairSlot[pairLen] = shCover[q];
        pairW[pairLen++] = shW[q];
      }
      if (bare > 0) { pairSlot[pairLen] = BARE.id; pairW[pairLen++] = bare; }
      if (off > 0) { pairSlot[pairLen] = OFF_TRIAL.id; pairW[pairLen++] = off; }
    }
  }
  pairStart[cells] = pairLen;

  const pc: PixelCovers = {
    T: 0, means: [], hasValid: new Uint8Array(cells).fill(1), pairStart, pairSlot, pairW,
    slots: { cnt: new Float64Array(256), ord: new Int32Array(256), keys: [], index: new Map() },
  };
  return { pc, centre };
}

/**
 * `aggregate` for an imported trial: the exact shares above, then the SAME
 * phase 2 every other layout runs (the PSF, the dominance and mixed rules, the
 * species fold and the off-trial share). Only phase 1 differs, which is the
 * whole of the difference between sampling a pixel and measuring it.
 */
function aggregateImported(
  plan: ImportedPlan, minE: number, minN: number, nx: number, ny: number, res: number,
  sensor: SensorParams, coverSpecies: Uint8Array | null, nSpecies: number,
): AggregateResult {
  const rowsAgg = Math.max(1, ny), colsAgg = Math.max(1, nx);
  const cells = rowsAgg * colsAgg;
  const outGrid: Float64Array[] = new Array(cells);
  const cropMapCenter = new Uint8Array(cells);
  const cropMapMajority = new Uint8Array(cells);
  const cropMapMixed = new Uint8Array(cells);
  const cropMapProportionA = new Float32Array(cells);
  const cropMapProportionBare = new Float32Array(cells);
  const nSp = Math.max(0, nSpecies | 0);
  const cropMapSpecies = nSp > 0 ? new Float32Array(cells * nSp) : null;
  const cropMapDominant = nSp > 0 ? new Uint8Array(cells) : null;
  const cropMapDominantFrac = nSp > 0 ? new Float32Array(cells) : null;
  const cropMapDominantPlot = nSp > 0 ? new Uint16Array(cells) : null;
  const cropMapProportionOffTrial = nSp > 0 ? new Float32Array(cells) : null;
  const spScratch = nSp > 0 ? new Float64Array(nSp) : null!;

  let pc: PixelCovers;
  let centre: Uint8Array;
  if (nx >= 1 && ny >= 1) {
    const got = importedPixelCovers(plan, minE, minN, nx, ny, res);
    pc = got.pc;
    centre = got.centre;
  } else {
    // An extent with no pixels in it: one placeholder that sees nothing, as the
    // sampled path's empty fine grid leaves it.
    pc = {
      T: 0, means: [], hasValid: new Uint8Array(cells), pairStart: new Int32Array(cells + 1),
      pairSlot: new Int32Array(0), pairW: new Float64Array(0),
      slots: { cnt: new Float64Array(256), ord: new Int32Array(256), keys: [], index: new Map() },
    };
    centre = new Uint8Array(cells);
  }

  const result: AggregateResult = { rowsAgg, colsAgg, cropMapMixed, cropMapMajority, cropMapCenter, cropMapProportionA, cropMapProportionBare,
                                    simsGrid: outGrid, cropMapSpecies, cropMapDominant, cropMapDominantFrac, cropMapDominantPlot, cropMapProportionOffTrial };
  resolvePixels(result, pc, nSp, spScratch, sensor.sigmaX, sensor.sigmaY, true, sensor.mixThreshold, sensor.offX ?? 0, sensor.offY ?? 0,
                coverSpecies, (gr, gc) => centre[gr * colsAgg + gc]);
  return result;
}

// ===== field driver (repo engine over the real S2 grid) ======================
// Everything from here down is the driver: what a layout is (SimLayout), the
// fine grid it is painted on (buildCropMap, strideFor), and the calls the page
// makes (simulateField, simulatePatch, bestPhaseOffset, resolutionSweep). This
// banner used to sit above the block design, labelling an empty section, while
// the driver itself ran on unannounced for 500 lines.

/**
 * The narrowest feature the fine grid must resolve. strideFor samples against
 * ONE width, but a block design's smallest feature is usually an alley, which
 * can be 0.5 m beside 8 m plots: sampling at the plot width quantises the alleys
 * away, which is exactly the flat-0.5 artefact strideFor's own comment warns of.
 * Identity on layout.width for the five two-species patterns.
 */
export function minFeatureM(layout: SimLayout): number {
  const imported = importedOf(layout);
  // Measured once by the resolver: the narrowest plot or the narrowest gap.
  if (imported) return imported.minFeature > 0 ? imported.minFeature : 0.05;
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
  const imported = importedOf(layout);
  // Rotation, width and spacing do not move an imported trial, so they are not
  // part of its key: nudging a slider the engine ignores must not rebuild the
  // cover map and every ladder rung.
  if (imported) return `imported|${imported.sig}`;
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
  /**
   * The RESOLVED plan for an 'imported' layout, in metres of the grid's UTM CRS.
   * Such a layout is placed where the file put it: the engine ignores
   * rotationDeg, width, spacing and the pattern origin for it.
   */
  imported?: ImportedPlan;
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
    // An imported trial is not rotated or shifted: its callers pass (E, N) as (u, v).
    case 'imported':    return layout.imported ? importedCoverAt(u, v, layout.imported) : OFF_TRIAL.id;
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
 * Fine cells per sensor pixel: enough sub-sampling to resolve the strips.
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
  if (layout.pattern === 'imported') {
    // Plain UTM, polygon by polygon: a per-cell point-in-polygon over every plot
    // would cost plots x cells, the scanline costs the plots' own rows.
    if (layout.imported) rasteriseImported(map, minE, minN, rows, cols, fineRes, layout.imported);
    else map.fill(OFF_TRIAL.id);
    return map;
  }
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
  mixed: Uint8Array;            // MIXED, a sentinel, else the dominant cover id
  purePct: number;              // % of TRIAL pixels that are a pure single crop
  pureBare: number;
  total: number;
  meanPropA: number;
  /** How many species this simulation covers. 2 for every periodic layout. */
  nSpecies: number;
  /** Pure pixels per species, over ALL species rather than the first two. */
  pureBySpecies: Uint32Array;
  /** Mean fraction of each species across TRIAL pixels; off-trial excluded. */
  meanBySpecies: Float64Array;
  /** Per-pixel species composition at [k * nSpecies + s], null if unavailable. */
  proportionBySpecies: Float32Array | null;
  /**
   * Per-pixel fraction of ground OUTSIDE the trial. Anything that colours a
   * pixel needs this: a pixel with no species and no alley is not an empty
   * mixture, it is land the design never covered, and a blend that is not told
   * so has nothing to weight and renders black.
   */
  proportionOffTrial: Float32Array | null;
  /**
   * Species 0 and 1 by their old names. Kept so the two-species readers keep
   * working while they are converted one at a time; new code should read
   * pureBySpecies, which does not stop at two.
   */
  pureA: number;
  pureB: number;
}

const EMPTY = new Float64Array(0);

/**
 * The pixels whose PSF puts no weight at all on the simulated grid, or null
 * when there are none (every normal sensor: a pixel always weighs itself).
 *
 * A narrow kernel pushed off centre, sigma 0.05 px shifted 2 px say, underflows
 * to exactly 0 on every cell a pixel at the grid's edge can reach. aggregate
 * then has nothing to divide by and leaves that pixel as cover id 0 with no
 * off-trial share, so it was counted as a PURE trial pixel of plot 0's species,
 * and a ladder rung over a smaller extent disagreed with the whole field about
 * which pixels those were. The sensor read ground outside the grid, of which
 * nothing is known: callers treat such a pixel as off-trial.
 *
 * Same window, same bounds and the same weight expression as aggregate, so a
 * pixel is listed exactly when every weight aggregate sums for it is 0.
 */
function psfBlindPixels(rowsAgg: number, colsAgg: number, sensor: SensorParams): Uint8Array | null {
  const { sigmaX, sigmaY } = sensor;
  const offX = sensor.offX ?? 0, offY = sensor.offY ?? 0;
  const weight = (dx: number, dy: number) => Math.exp(-0.5 * ((dx / (sigmaX || 0.5)) ** 2 + (dy / (sigmaY || 0.5)) ** 2));
  const windowX = Math.max(0, Math.ceil(3 * sigmaX + Math.abs(offX)));
  const windowY = Math.max(0, Math.ceil(3 * sigmaY + Math.abs(offY)));
  if (weight(0 - offX, 0 - offY) > 0 && windowX >= 0 && windowY >= 0) return null;
  let blind: Uint8Array | null = null;
  for (let gr = 0; gr < rowsAgg; gr++) {
    const r0 = Math.max(0, gr - windowY), r1 = Math.min(rowsAgg - 1, gr + windowY);
    for (let gc = 0; gc < colsAgg; gc++) {
      const c0 = Math.max(0, gc - windowX), c1 = Math.min(colsAgg - 1, gc + windowX);
      let seen = false;
      for (let nr = r0; nr <= r1 && !seen; nr++) {
        for (let nc = c0; nc <= c1 && !seen; nc++) seen = weight(nc - gc - offX, nr - gr - offY) !== 0;
      }
      if (!seen) (blind ??= new Uint8Array(rowsAgg * colsAgg))[gr * colsAgg + gc] = 1;
    }
  }
  return blind;
}

/** Marks the pixels psfBlindPixels lists as wholly off-trial, in place. */
function markPsfBlind(agg: AggregateResult, sensor: SensorParams): Uint8Array | null {
  const blind = psfBlindPixels(agg.rowsAgg, agg.colsAgg, sensor);
  if (blind) {
    for (let k = 0; k < blind.length; k++) {
      if (!blind[k]) continue;
      agg.cropMapMixed[k] = OFF_TRIAL.id;
      if (agg.cropMapProportionOffTrial) agg.cropMapProportionOffTrial[k] = 1;
    }
  }
  return blind;
}

/**
 * How a layout's cover ids map to species.
 *
 * A block design puts PLOT ids in the cover map so per-plot coverage can be
 * counted, and BlockPlan.plotSpecies is exactly the plot-to-species table the
 * engine needs. Every other layout's cover id IS the species already. Both
 * `aggregate` and `coverStats` have accepted this pair from the start; nothing
 * was passing it, which is why a sixteen-plot trial reported on two species.
 */
export function speciesChannel(layout: SimLayout): { coverSpecies: Uint8Array | null; nSpecies: number } {
  // Every variety of an imported design is its own species; plots of one
  // variety are its repetitions and fold into it here.
  const imported = importedOf(layout);
  if (imported) return { coverSpecies: imported.coverSpecies, nSpecies: Math.max(2, imported.nSpecies) };
  const b = layout.block;
  return b
    ? { coverSpecies: b.plotSpecies, nSpecies: Math.max(2, b.design.nSpecies) }
    : { coverSpecies: null, nSpecies: 2 };
}

/**
 * Mean fraction of each species, averaged over the pixels that actually sample
 * the trial. Off-trial ground is EXCLUDED from the denominator: it is not a
 * dilute crop, it is land the design never touched, and counting it drags every
 * species' mean toward zero in proportion to how much of the field the trial
 * happens to occupy. A periodic layout has no off-trial pixels, so this is
 * identity for all five of them.
 */
export function meanPerSpecies(
  species: Float32Array | null, nSpecies: number, pixels: number, offTrial: Float32Array | null,
): Float64Array {
  const out = new Float64Array(Math.max(0, nSpecies));
  if (!species || !nSpecies || !pixels) return out;
  let used = 0;
  for (let k = 0; k < pixels; k++) {
    if (offTrial && offTrial[k] > 0.5) continue;
    used++;
    const base = k * nSpecies;
    for (let s = 0; s < nSpecies; s++) out[s] += species[base + s];
  }
  if (used) for (let s = 0; s < nSpecies; s++) out[s] /= used;
  return out;
}

/** Run the repo aggregate over the real grid's sensor cells. */
export function simulateField(grid: S2Grid, patternOrigin: [number, number], layout: SimLayout, sensor: SensorParams): FieldSim {
  const res = grid.res;
  const [minE, minN, maxE, maxN] = grid.utmBounds;
  const nx = Math.round((maxE - minE) / res);
  const ny = Math.round((maxN - minN) / res);
  const { coverSpecies, nSpecies } = speciesChannel(layout);
  const imported = importedOf(layout);
  let agg: AggregateResult;
  if (imported) {
    agg = aggregateImported(imported, minE, minN, nx, ny, res, sensor, coverSpecies, nSpecies);
  } else {
    const g = strideFor(res, minFeatureM(layout));
    const fineRes = res / g;
    const rows = ny * g, cols = nx * g;
    const cropMap = buildCropMap(minE, minN, rows, cols, fineRes, patternOrigin[0], patternOrigin[1], layout);
    const simsGrid: Float64Array[] = new Array(rows * cols).fill(EMPTY);
    agg = aggregate(simsGrid, rows, cols, g, sensor.sigmaX, sensor.sigmaY, true, 0, cropMap, sensor.mixThreshold, sensor.offX ?? 0, sensor.offY ?? 0, coverSpecies, nSpecies);
  }
  markPsfBlind(agg, sensor);

  const mixed = agg.cropMapMixed;
  const proportionA = agg.cropMapProportionA;
  const proportionBare = agg.cropMapProportionBare;
  let sumP = 0;
  for (let k = 0; k < mixed.length; k++) sumP += proportionA[k];
  const st = coverStats({ mixed, coverSpecies, nSpecies, offTrial: agg.cropMapProportionOffTrial });
  return {
    proportionA, proportionBare, mixed,
    purePct: st.purePct, pureBare: st.pureBare,
    total: st.total, meanPropA: mixed.length ? sumP / mixed.length : 0.5,
    nSpecies, pureBySpecies: st.pureBySpecies,
    meanBySpecies: meanPerSpecies(agg.cropMapSpecies, nSpecies, mixed.length, agg.cropMapProportionOffTrial),
    proportionBySpecies: agg.cropMapSpecies,
    proportionOffTrial: agg.cropMapProportionOffTrial,
    pureA: st.pureBySpecies[0], pureB: st.pureBySpecies[1],
  };
}

export interface SweepPoint { gsd: number; purePct: number; }

/** Culture (0/1) at a UTM point, for rendering the crisp ground-truth pattern. */
export function cultureAt(E: number, N: number, layout: SimLayout, ox: number, oy: number): number {
  // An imported trial is already in metres of the grid's CRS: no origin, no rotation.
  if (layout.pattern === 'imported') return patternCultureUV(E, N, layout);
  const t = (layout.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(t), sin = Math.sin(t);
  const dx = E - ox, dy = N - oy;
  const u = dx * cos + dy * sin;
  const v = -dx * sin + dy * cos;
  return patternCultureUV(u, v, layout);
}

/**
 * Find the pattern phase (origin shift, in metres) that maximises pure single-crop
 * pixels: i.e. slide the whole planting so strip edges land on pixel edges. Solved
 * 1D per striping axis against the real pixel lattice (exact when rows follow the
 * pixels; a good heuristic when rotated). Returns [du, dv] in the rotated
 * (along-row u, cross-row v) frame; add it to the pattern origin.
 */
/**
 * bestPhaseOffset is pure but costs ~35 ms (192 phases x 400 pixels x 16
 * sub-samples), and the resolution ladder calls it once per size (twice per size
 * with "vs aligned"), with IDENTICAL arguments, since rotation is not an input.
 * Results are cached by argument. `threshold` is deliberately left out of the
 * key: the search maximises continuous coverage and never reads it, so moving the
 * purity slider reuses every cached placement.
 */
const phaseCache = new Map<string, [number, number]>();
const PHASE_CACHE_MAX = 512;

export function bestPhaseOffset(
  // `threshold` is accepted but unread (see above); it stays in the signature
  // because every caller has it in hand and dropping it would silently shift
  // the two origins one slot left in the JS test suites, which are untyped.
  pattern: PatternType, res: number, width: number, spacing: number, _threshold: number, ox0: number, oy0: number,
): [number, number] {
  // An imported trial sits where the file put it; there is no phase to slide.
  if (pattern === 'imported') return [0, 0];
  const key = `${pattern}|${res}|${width}|${spacing}|${ox0}|${oy0}`;
  const hit = phaseCache.get(key);
  if (hit) return [hit[0], hit[1]]; // a copy: callers must never share the cached tuple
  const out = searchPhaseOffset(pattern, res, width, spacing, ox0, oy0);
  if (phaseCache.size >= PHASE_CACHE_MAX) phaseCache.delete(phaseCache.keys().next().value as string);
  phaseCache.set(key, out);
  return [out[0], out[1]];
}

function searchPhaseOffset(
  pattern: PatternType, res: number, width: number, spacing: number, ox0: number, oy0: number,
): [number, number] {
  const W = width, P = width + Math.max(0, spacing);
  const assign = (k: number, two: boolean) => (two ? Math.floor(k / 2) : k) & 1;
  const search = (origin: number, two: boolean): number => {
    const STEPS = 192, SUB = 16, NPIX = 400;
    const m0 = Math.round(origin / res);
    // Maximise the mean dominant-crop coverage (continuous): this peaks only when
    // strip edges land exactly on pixel edges, not merely when pixels are "pure
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
  purePct: number;              // % of TRIAL pixels that are a pure single crop
  nSpecies: number;
  /** Per-pixel species composition at [k * nSpecies + s], null if unavailable. */
  proportionBySpecies: Float32Array | null;
  /** Mean fraction of each species across TRIAL pixels; off-trial excluded. */
  meanBySpecies: Float64Array;
  /** Per-pixel fraction of ground outside the trial. Same meaning as FieldSim's. */
  proportionOffTrial: Float32Array | null;
}

/** Run the repo aggregate over a square UTM patch at a given GSD (for thumbnails). */
export function simulatePatch(
  minE: number, minN: number, sizeM: number, gsd: number,
  patternOx: number, patternOy: number, layout: SimLayout, sensor: SensorParams,
): PatchSim {
  const nx = Math.max(1, Math.round(sizeM / gsd));
  const ny = nx;
  const { coverSpecies, nSpecies } = speciesChannel(layout);
  const imported = importedOf(layout);
  let agg: AggregateResult;
  if (imported) {
    agg = aggregateImported(imported, minE, minN, nx, ny, gsd, sensor, coverSpecies, nSpecies);
  } else {
    const g = strideFor(gsd, minFeatureM(layout));
    const fineRes = gsd / g;
    const rows = ny * g, cols = nx * g;
    const cropMap = buildCropMap(minE, minN, rows, cols, fineRes, patternOx, patternOy, layout);
    const simsGrid: Float64Array[] = new Array(rows * cols).fill(EMPTY);
    agg = aggregate(simsGrid, rows, cols, g, sensor.sigmaX, sensor.sigmaY, true, 0, cropMap, sensor.mixThreshold, sensor.offX ?? 0, sensor.offY ?? 0, coverSpecies, nSpecies);
  }
  markPsfBlind(agg, sensor);
  const st = coverStats({ mixed: agg.cropMapMixed, coverSpecies, nSpecies, offTrial: agg.cropMapProportionOffTrial });
  return {
    proportionA: agg.cropMapProportionA, proportionBare: agg.cropMapProportionBare, mixed: agg.cropMapMixed,
    nx: agg.colsAgg, ny: agg.rowsAgg,
    purePct: st.purePct,
    nSpecies, proportionBySpecies: agg.cropMapSpecies,
    meanBySpecies: meanPerSpecies(agg.cropMapSpecies, nSpecies, agg.cropMapMixed.length, agg.cropMapProportionOffTrial),
    proportionOffTrial: agg.cropMapProportionOffTrial,
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
  const half = 50; // bounded window: purity of a periodic pattern is stationary
  let wMinE = Math.max(minE, cx - half), wMaxE = Math.min(maxE, cx + half);
  let wMinN = Math.max(minN, cy - half), wMaxN = Math.min(maxN, cy + half);
  const imported = importedOf(layout);
  if (imported) {
    // A finite trial is not stationary, and a window at the field centre can
    // miss it altogether: measure the trial itself, over its own pixels.
    wMinE = Math.max(minE, imported.bbox[0]); wMaxE = Math.min(maxE, imported.bbox[2]);
    wMinN = Math.max(minN, imported.bbox[1]); wMaxN = Math.min(maxN, imported.bbox[3]);
  }
  const channel = imported ? speciesChannel(layout) : { coverSpecies: null, nSpecies: 0 };
  return gsds.map(gsd => {
    const oMinE = Math.floor(wMinE / gsd) * gsd;
    const oMinN = Math.floor(wMinN / gsd) * gsd;
    const nx = Math.max(1, Math.ceil((wMaxE - oMinE) / gsd));
    const ny = Math.max(1, Math.ceil((wMaxN - oMinN) / gsd));
    let agg: AggregateResult;
    if (imported) {
      agg = aggregateImported(imported, oMinE, oMinN, nx, ny, gsd, sensor, channel.coverSpecies, channel.nSpecies);
    } else {
      const g = strideFor(gsd, minFeatureM(layout));
      const fineRes = gsd / g;
      const rows = ny * g, cols = nx * g;
      const cropMap = buildCropMap(oMinE, oMinN, rows, cols, fineRes, minE, minN, layout);
      const simsGrid: Float64Array[] = new Array(rows * cols).fill(EMPTY);
      // null and 0 are aggregate's own defaults: a periodic layout runs exactly as before.
      agg = aggregate(simsGrid, rows, cols, g, sensor.sigmaX, sensor.sigmaY, true, 0, cropMap, sensor.mixThreshold, sensor.offX ?? 0, sensor.offY ?? 0,
        channel.coverSpecies, channel.nSpecies);
    }
    // A periodic layout has no off-trial channel to mark, so its blind pixels
    // are skipped here by name.
    const blind = markPsfBlind(agg, sensor);
    // Off-trial ground is not a resolved pixel of an imported trial; the
    // off-trial channel only exists for one, so periodic layouts count every pixel.
    const off = imported ? agg.cropMapProportionOffTrial : null;
    let pure = 0, counted = 0;
    for (let k = 0; k < agg.cropMapMixed.length; k++) {
      if (blind && blind[k]) continue;
      if (off && off[k] > 0.5) continue;
      counted++;
      if (agg.cropMapMixed[k] !== 255 && !(off && agg.cropMapMixed[k] === OFF_TRIAL.id)) pure++;
    }
    return { gsd, purePct: counted ? (100 * pure) / counted : 0 };
  });
}
