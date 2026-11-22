import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import { pointInPoly } from './geometry';
import { normCdf } from './plot-size';
import { ce90Shifts, heldMask, probit } from './resolving';
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

/**
 * The layouts the page OFFERS. The two 2:2 strip layouts ('strip-row-2',
 * 'strip-col-2') are not among them any more ("remove all the 2:2",
 * 2026-11-21): the engine still draws and measures them, they are only not in
 * the list, and a browser that had one selected falls back to the first.
 */
export const PATTERNS: { id: PatternType; label: string }[] = [
  { id: 'row', label: 'Alternating rows (1:1)' },
  { id: 'col', label: 'Alternating columns (1:1)' },
  { id: 'checker', label: 'Checkerboard' },
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
  /**
   * Share of the pixel's signal held by its dominant cover: the figure the
   * mixed threshold is compared with. It was computed for every pixel and then
   * dropped, so a pixel could say whether it passed but not by how much. 0
   * where the pixel saw nothing at all.
   */
  cropMapPurity: Float32Array;
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
  const { rowsAgg, colsAgg, cropMapCenter, cropMapMajority, cropMapMixed, cropMapProportionA, cropMapProportionBare, cropMapPurity,
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
      cropMapPurity[idx] = totalCropWeight > 0 ? maxWeight / totalCropWeight : 0;
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
  const cropMapPurity = new Float32Array(rowsAgg * colsAgg);
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

  const result: AggregateResult = { rowsAgg, colsAgg, cropMapMixed, cropMapMajority, cropMapCenter, cropMapProportionA, cropMapProportionBare, cropMapPurity,
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
 * One block's own random stream. Seeded PER BLOCK rather than once per design,
 * so adding a repetition leaves every earlier block byte-identical and a partly
 * staked trial is not invalidated by extending it.
 */
function blockStream(block: number, seed: number): () => number {
  const s = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(block + 1, 0x85ebca6b)) >>> 0;
  const rnd = randomLcg((s % 2147483647) || 1);
  for (let i = 0; i < 8; i++) rnd();   // nearby LCG seeds correlate in their first draws
  return rnd;
}

/** Fisher-Yates, in place. */
function shuffleOrder(a: Uint8Array, rnd: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
}

/**
 * One block's species order drawn on its own, with no regard for its
 * neighbours: the FIRST draw of the block's stream. blockOrders keeps it
 * whenever it puts no species beside itself.
 */
export function blockPermutation(nSpecies: number, block: number, seed: number): Uint8Array {
  const n = Math.max(1, nSpecies | 0);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  shuffleOrder(out, blockStream(block, seed));
  return out;
}

/** Draws a block may spend looking for an order that suits its neighbours. */
const ORDER_TRIES = 64;

/**
 * Every block's species order, block after block: out[b * nSpecies + k] is the
 * species of plot k of block b.
 *
 * NO TWO PLOTS THAT SHARE A SIDE CARRY THE SAME SPECIES. Inside a block that is
 * given, each species being there once. Between blocks, plot k lies beside plot
 * k of the block before it in the row, and a block's first plot lies against
 * the last plot of the block above it (see blockPlots).
 *
 * The orders used to be drawn independently, which is textbook RCBD and puts a
 * species beside itself often: with two species and two blocks in a row, about
 * one seed in two gave two strips, each species a single band across both
 * repetitions. Asked for on 2026-11-20: "the same color plots should not be
 * side by side". It changes no pixel count: a pixel astride two plots of one
 * species was already counted mixed (purity is per plot, suite section H10b).
 *
 * Each block still draws from its own stream, and draws again until its order
 * suits the blocks already placed (the one before it in the row and the one
 * above): uniform among the orders allowed. The first draw is the old order,
 * so a layout that already kept its species apart is unchanged, and a block
 * depends only on earlier ones, so adding a repetition still leaves every
 * earlier block as it was. From two species up such an order was found for
 * every arrangement the suite tries (section H3); with two species the trial
 * is a checkerboard, the first block's order being the only thing left to draw.
 */
export function blockOrders(nSpecies: number, nBlocks: number, cols: number, seed: number): Uint8Array {
  const n = Math.max(1, nSpecies | 0);
  const perRow = Math.max(1, cols | 0);
  const out = new Uint8Array(n * nBlocks);
  const draw = new Uint8Array(n);
  for (let b = 0; b < nBlocks; b++) {
    const at = b * n;
    const left = b % perRow > 0 ? at - n : -1;         // the block before it in the row
    const up = b >= perRow ? (b - perRow) * n : -1;    // the block above
    const clash = (o: Uint8Array) => {
      if (up >= 0 && o[0] === out[up + n - 1]) return true;
      if (left >= 0) for (let k = 0; k < n; k++) if (o[k] === out[left + k]) return true;
      return false;
    };
    const rnd = blockStream(b, seed);
    for (let i = 0; i < n; i++) draw[i] = i;
    shuffleOrder(draw, rnd);
    if (n >= 2) {
      let tries = 1;
      while (clash(draw) && tries < ORDER_TRIES) { shuffleOrder(draw, rnd); tries++; }
      if (clash(draw)) {
        // Never seen (64 draws at one chance in two or better), but the rule
        // must not rest on luck: a rotation of the block before, or the block
        // above as it is when the row starts here.
        if (left >= 0) {
          for (let s = 1; s < n; s++) {
            for (let k = 0; k < n; k++) draw[k] = out[left + ((k + s) % n)];
            if (!clash(draw)) break;
          }
        } else {
          for (let k = 0; k < n; k++) draw[k] = out[up + k];
        }
      }
    }
    out.set(draw, at);
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
  /**
   * Where the trial's middle goes, as a UTM point, in place of the middle of
   * the bounds: its seat in a field that is not a box (trial-seat.ts). The
   * staking then scores its phases around that point, see stakeBlockPlan.
   */
  centre?: [number, number] | null,
): { centerU: number; centerV: number; snap: number; phaseU: number; phaseV: number; window?: [number, number] } {
  const [minE, minN, maxE, maxN] = utmBounds;
  const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const toUV = (E: number, N: number): [number, number] => {
    const dx = E - origin[0], dy = N - origin[1];
    return [dx * cos + dy * sin, -dx * sin + dy * cos];
  };
  const [centerU, centerV] = centre ? toUV(centre[0], centre[1]) : toUV((minE + maxE) / 2, (minN + maxN) / 2);
  const [phaseU, phaseV] = toUV(minE, minN);
  const axisAligned = Math.abs(rotationDeg % 90) < 1e-9;
  const snap = snapToPixels && axisAligned && res > 0 ? res : 0;
  return centre ? { centerU, centerV, snap, phaseU, phaseV, window: centre } : { centerU, centerV, snap, phaseU, phaseV };
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
  const plotSpecies = blockOrders(nSpecies, nBlocks, cols, resolved.seed);

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
 * The crop area a design PLANTS, in whole pixels. Null when the layout has no
 * separate notion of planted area from the ground it sits on.
 *
 * This is the denominator the purity share is taken over, and it is deliberately
 * the geometry the user typed rather than anything measured off the simulation.
 * A measured denominator moves when the trial moves, and then a placement that
 * wins 10.2% more pure pixels reports a 4.5% better share, because part of the
 * gain was "more of the trial fits inside the field" and the denominator
 * quietly absorbed it. Against a constant, the share is exactly proportional to
 * the pure count, so what the reader can count on the panel is what the
 * percentage says, and a trial hanging out of its field is charged for it
 * instead of being excused.
 *
 * A periodic pattern has no trial distinct from the field it covers, so it has
 * no answer here and the caller falls back to summing the crop it can see.
 */
export function plantedAreaPx(layout: SimLayout, res: number): number | null {
  if (!(res > 0)) return null;
  const px = res * res;
  const block = layout.pattern === 'block' ? layout.block : null;
  if (block) return (block.nPlots * block.design.plotLength * block.design.plotWidth) / px;
  const imported = layout.pattern === 'imported' ? layout.imported : null;
  if (imported) {
    // Shoelace over every ring of every plot. Holes and outer rings wind
    // opposite ways in both shapefiles and GeoJSON, so they subtract, and the
    // absolute value is taken per PLOT rather than per ring.
    let area = 0;
    for (const plot of imported.plots) {
      let a = 0;
      for (const ring of plot.rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
      }
      area += Math.abs(a / 2);
    }
    return area / px;
  }
  return null;
}

/**
 * Pixel-simulations the phase search may spend, and the largest window a
 * candidate is scored over.
 *
 * The window is the rung's OWN extent, not a small representative patch. Scored
 * on a couple of block pitches instead, the search picked a phase that was best
 * in the patch and WORSE over the trial: at 8 m it returned 108 pure pixels
 * where the plain corner snap gave 119. A search must optimise the number that
 * will be reported, or it can lose to doing nothing.
 *
 * The budget is where it is by measurement, not by feel. At 60,000 the search
 * collapses to 2 x 2 on a large fine-pixel trial and finds nothing; at 130,000
 * every rung of the measured ladder improves on the corner snap; at 260,000 the
 * answers are identical and it costs 40% more. Worst case is bounded by
 * PHASE_MAX_CELLS and PHASE_MAX_N together, about 130 ms.
 */
const PHASE_BUDGET = 130_000;
const PHASE_MAX_CELLS = 8_000;
const PHASE_MAX_N = 6;

/**
 * Put an ALIGNED block trial on the sub-pixel offset that actually yields the
 * most pure pixels, rather than assuming its corner belongs on a pixel corner.
 *
 * buildBlockPlan's corner snap used to be described as "the whole phase
 * optimisation for a block design". It is not an optimisation, it is one
 * arbitrary phase, and it is only a good one when the plot and alley happen to
 * be whole pixels. Measured on a 40 m plot / 5 m alley design:
 *
 *   5 m pixels  plot 8 px, alley 1 px      snap lands at the 94th percentile
 *   6 m pixels  plot 6.67 px, alley 0.83   snap lands at the 13th percentile
 *
 * At 6 m that cost the aligned ladder 29.9% where the best phase gives 38.1%,
 * so "turned onto the pixel grid" reported WORSE than the same trial left at
 * 10 degrees (33.6%), and the comparison contradicted itself. An imported trial
 * never had this problem because stakeOnGrid already searches; this is the same
 * treatment for a generated one.
 *
 * Only for an aligned trial: `place.snap` is 0 at any other angle (plot edges
 * cannot be parallel to pixel edges), and there is then no phase to choose.
 * Scored on the pure-pixel COUNT, the quantity the page reports. The corner
 * snap is itself one of the candidates, so this can never return less than it.
 */
/**
 * The window stakeBlockPlan scores a phase over, in pixels, and how many
 * phases it tries per axis: the extent itself, cut down when it is very large,
 * and as fine a mesh as the budget pays for over it. Null for an extent that
 * is no extent. Its own function because the design suggestion has to count a
 * plot's pixels at the phase the page WILL stake it at, which means the same
 * mesh, from the same rule.
 */
/**
 * Where a lattice's pixel edges fall, modulo its pixel, read off one of them
 * (the corner of a box laid on it). Zero for a lattice on whole multiples of
 * its pixel, and exactly zero: an edge worked out as k * res does not always
 * divide back to a whole number, and a remainder of 1e-13 or of res less that
 * must not move anything. Zero for no edge at all (an unbounded extent).
 *
 * Most lattices here are on whole multiples. Native Landsat is half a pixel
 * off, and south of the equator so are the 30 and 60 m grids in a southern
 * frame (sensors.ts latticePhase). Whatever snaps to "the lattice" inside a
 * box takes the box's own offset from this, so that a trial is staked, and its
 * extent cut, on the pixels the box really has.
 */
export function latticeOffset(edge: number, res: number): number {
  if (!Number.isFinite(edge) || !(res > 0)) return 0;
  const m = ((edge % res) + res) % res;
  return m < 1e-6 * res || res - m < 1e-6 * res ? 0 : m;
}

export function stakeMesh(extent: [number, number, number, number], res: number): { nx: number; ny: number; steps: number } | null {
  const [e0, n0, e1, n1] = extent;
  let nx = Math.max(1, Math.round((e1 - e0) / res)), ny = Math.max(1, Math.round((n1 - n0) / res));
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  if (nx * ny > PHASE_MAX_CELLS) {
    const k = Math.sqrt(PHASE_MAX_CELLS / (nx * ny));
    nx = Math.max(1, Math.floor(nx * k)); ny = Math.max(1, Math.floor(ny * k));
  }
  // Candidates per axis, from the same budget rule stakeOnGrid uses: the work is
  // the window, so the grid is as fine as the budget allows and no finer.
  return { nx, ny, steps: Math.max(1, Math.min(PHASE_MAX_N, Math.floor(Math.sqrt(PHASE_BUDGET / Math.max(1, nx * ny))))) };
}

export function stakeBlockPlan(
  design: BlockDesign,
  place: { centerU: number; centerV: number; snap?: number; phaseU?: number; phaseV?: number; window?: [number, number] },
  origin: [number, number],
  rotationDeg: number,
  res: number,
  sensor: SensorParams,
  extent: [number, number, number, number],
  /**
   * Phases to try per axis, in place of the mesh's own. For a caller that
   * scores a small stand-in of a trial and needs the phase the whole trial
   * will be given on its field (suggest-design).
   */
  steps?: number,
): { plan: BlockPlan; offset: [number, number]; staked: boolean } {
  const base = buildBlockPlan(design, place);
  // A trial at an angle has no position to choose on a lattice that is known:
  // its plot edges cannot run along the pixels. On one that falls anywhere
  // (SensorParams.anyPosition) it still has a worst position, and that is the
  // one to count it at: the same search, over one pixel each way.
  const snap = place.snap && place.snap > 0 ? place.snap : sensor.anyPosition && res > 0 ? res : 0;
  if (!(snap > 0) || !(res > 0)) return { plan: base, offset: [0, 0], staked: false };

  // The rung's own extent, centred and capped only if it is very large.
  const mesh = stakeMesh(extent, res);
  if (!mesh) return { plan: base, offset: [0, 0], staked: false };
  const { nx, ny } = mesh;
  const [e0, n0, e1, n1] = extent;
  // Around the trial: the middle of the extent, or the seat it was given. A
  // large field's window is cut down to its middle, and a trial seated away
  // from there would be scored on a window it is not in, every phase alike.
  const [cx, cy] = place.window ?? [(e0 + e1) / 2, (n0 + n1) / 2];
  // On the extent's OWN lattice. The window used to be laid on whole multiples
  // of the pixel whatever the extent: on a grid half a pixel off (native
  // Landsat) every phase was then scored against pixels the map does not have,
  // and the trial staked on the worst of them (found by an outside review,
  // 2026-11-22).
  const pE = latticeOffset(e0, res), pN = latticeOffset(n0, res);
  const w0 = Math.floor((cx - (nx * res) / 2 - pE) / res) * res + pE;
  const v0 = Math.floor((cy - (ny * res) / 2 - pN) / res) * res + pN;
  const box = { res, utmBounds: [w0, v0, w0 + nx * res, v0 + ny * res] } as unknown as S2Grid;

  const layoutOf = (plan: BlockPlan): SimLayout => ({ pattern: 'block', width: 2, spacing: 0, rotationDeg, block: plan });
  // What a position is worth, by the engine: its pure pixels, or first the ones
  // that hold within the CE90 the reader places for (SensorParams.placeHeldM),
  // the image landing along the plots' own sides and diagonals.
  const holdM = placedFor(sensor, Math.min(base.design.plotLength, base.design.plotWidth));
  const lands = ce90Shifts(holdM, rotationDeg);
  const scoreOf = (plan: BlockPlan): number => {
    const nominal = fieldVerdicts(box, origin, layoutOf(plan), sensor);
    const pure = pureVerdictCount(nominal);
    if (!lands.length || pure === 0) return pure;
    const mask = heldMask(nominal, lands.length, (q, need) => fieldVerdicts(box, [origin[0] - lands[q][0], origin[1] - lands[q][1]], layoutOf(plan), sensor, need));
    let held = 0;
    for (let k = 0; k < mask.length; k++) if (mask[k]) held++;
    return held * HELD_FIRST + pure;
  };
  // Under a blur that is a spot the count moves with the position far more
  // finely than a mesh of six a side can follow: see spotStake.
  const fine = spotStake(base, origin, rotationDeg, res, sensor, w0, v0, nx, ny, snap, holdM);
  if (fine) {
    if (fine[0] === 0 && fine[1] === 0) return { plan: base, offset: [0, 0], staked: true };
    const cand: BlockPlan = { ...base, u0: base.u0 + fine[0], v0: base.v0 + fine[1] };
    // The engine has the last word, as everywhere: the position is kept only if it beats the corner snap there.
    return keepsCount(sensor, scoreOf(cand), scoreOf(base)) ? { plan: cand, offset: fine, staked: true } : { plan: base, offset: [0, 0], staked: true };
  }

  const n = steps && steps > 0 ? Math.min(PHASE_MAX_N, Math.floor(steps)) : mesh.steps;
  if (n < 2) return { plan: base, offset: [0, 0], staked: false };

  let best = base, bestScore = noCountYet(sensor), bestOff: [number, number] = [0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const du = (i * snap) / n, dv = (j * snap) / n;
      // Shifting u0/v0 IS the phase: the plan's geometry is unchanged and only
      // where it sits against the lattice moves, so no plan is rebuilt.
      const cand: BlockPlan = { ...base, u0: base.u0 + du, v0: base.v0 + dv };
      // Only the count is read, so only the verdicts are worked out.
      const pure = scoreOf(cand);
      if (keepsCount(sensor, pure, bestScore)) { bestScore = pure; best = cand; bestOff = [du, dv]; }
    }
  }
  return { plan: best, offset: bestOff, staked: true };
}

/**
 * Positions tried per axis by spotStake: a twenty-fourth of a pixel apart. The
 * same for every trial, so that a plot sized on its own (suggest-design.ts
 * plotCount) is counted at the position the whole trial is then staked at.
 */
export const SPOT_STAKE_N = 24;

/** True when a block trial under this sensor is staked by spotStake and not by the mesh of engine runs. */
export function stakesBySpot(sensor: SensorParams): boolean {
  // Not at a threshold of 1: the engine calls a pixel pure there once every other cover is under a billionth, a product of two shares never is.
  const thr = sensor.mixThreshold;
  return followsSpot(sensor) && thr > 0.5 && thr < 1 && (sensor.offX ?? 0) === 0 && (sensor.offY ?? 0) === 0;
}

/**
 * The position of an aligned block trial, within one pixel each way, that
 * leaves the most pure pixels under a blur that is a spot (the note's model):
 * the shift along the plots and across them, or null when this is not the case
 * to which it applies (a sharp sensor, a threshold of a half or less, a spot
 * pushed off its pixel).
 *
 * WHY NOT THE MESH. Under a spot a pixel's share of a plot moves smoothly with
 * the trial, and the count of pure pixels changes wherever one of them crosses
 * the threshold: plots that are not a whole number of pixels apart sit at a
 * few different places on the lattice, and the positions that suit most of
 * them at once are narrow. Six positions a side missed them: 40 m plots 45 m
 * apart at 6 m pixels kept 414 pure pixels at the mesh's pick, and 480 half a
 * metre further along both ways; at 4 m every position of the mesh was the
 * same place modulo the plots' own step, and the search could not move at all.
 *
 * HOW. With the trial along the pixel rows a plot's share of a pixel is the
 * product of two numbers, one for the pixel's column against the plot's length
 * and one for its row against the plot's width (the note's P = F(x) F(y)), and
 * the pixel is pure when the product reaches the threshold. So for each
 * position along an axis the shares that could ever count are listed once,
 * largest first, and a position both ways is then counted by pairing two short
 * lists, with no simulation at all. Every position of a mesh of 24 a side
 * together costs less than the six a side did through the engine.
 *
 * The count is over the same window the mesh search scores (the pixels of the
 * box given). A tie keeps the smallest shift, as the mesh search does, so a
 * trial already at its best is left on its corner snap.
 *
 * For a lattice that falls anywhere (SensorParams.anyPosition) the position
 * returned is the one that keeps the FEWEST pure pixels, by the same count.
 */
function spotStake(
  base: BlockPlan, origin: [number, number], rotationDeg: number, res: number, sensor: SensorParams,
  w0: number, v0: number, nx: number, ny: number, snap: number, holdM = 0,
): [number, number] | null {
  const thr = sensor.mixThreshold;
  if (!stakesBySpot(sensor)) return null;
  const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const flat = Math.abs(sin) < 1e-9, upright = Math.abs(cos) < 1e-9;
  if (!flat && !upright) return null;
  const d = base.design, nSp = d.nSpecies, plotPitch = d.plotWidth + d.plotAlley;
  const su = spotSigma(flat ? sensor.sigmaX : sensor.sigmaY) * res, sv = spotSigma(flat ? sensor.sigmaY : sensor.sigmaX) * res;
  // The pixels' centres along the trial's two axes, as the engine's frame has them.
  const nU = flat ? nx : ny, nV = flat ? ny : nx;
  const uAt = new Float64Array(nU), vAt = new Float64Array(nV);
  for (let q = 0; q < nU; q++) uAt[q] = flat ? (w0 + (q + 0.5) * res - origin[0]) * cos : (v0 + (q + 0.5) * res - origin[1]) * sin;
  for (let q = 0; q < nV; q++) vAt[q] = flat ? (v0 + (q + 0.5) * res - origin[1]) * cos : -(w0 + (q + 0.5) * res - origin[0]) * sin;

  const N = SPOT_STAKE_N;
  const alongU: AxisShares[][] = [];
  for (let c = 0; c < base.cols; c++) {
    const row: AxisShares[] = [];
    for (let i = 0; i < N; i++) row.push(spotAxis(base.u0 + c * base.pitchU + (i * snap) / N, base.blockU, uAt, su, thr, holdM));
    alongU.push(row);
  }
  const alongV: AxisShares[][] = [];
  for (let r = 0; r < base.rows; r++) {
    for (let q = 0; q < nSp; q++) {
      const row: AxisShares[] = [];
      for (let j = 0; j < N; j++) row.push(spotAxis(base.v0 + r * base.pitchV + q * plotPitch + (j * snap) / N, d.plotWidth, vAt, sv, thr, holdM));
      alongV.push(row);
    }
  }
  let best = noCountYet(sensor), bi = 0, bj = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let score = 0;
      for (let r = 0; r < base.rows; r++) {
        for (let c = 0; c < base.cols; c++) {
          if (r * base.cols + c >= d.nBlocks) continue;         // the ragged last row
          const A = alongU[c][i];
          if (A.own.length === 0) continue;
          for (let q = 0; q < nSp; q++) {
            const B = alongV[r * nSp + q][j];
            score += purePairs(A, B, thr);
            if (holdM > 0) score += heldPairs(A, B, thr) * HELD_FIRST;
          }
        }
      }
      if (keepsCount(sensor, score, best)) { best = score; bi = i; bj = j; }
    }
  }
  return [(bi * snap) / N, (bj * snap) / N];
}

/**
 * One side of a plot against the pixels along it, for the counts that pair two
 * sides (the note's P = F(x) F(y)): the pixels whose share of the side reaches
 * the threshold, the only ones that can be pure for the plot.
 */
export interface AxisShares {
  /** Those pixels' shares of the side, largest first. */
  own: Float64Array;
  /**
   * With a geolocation error to hold against: for the same pixels, in no
   * particular order, three numbers each. Its share, the smaller of its shares
   * with the image landed the CE90 either way along this side, and the smaller
   * with it landed the CE90 over root two either way (the diagonal landings).
   * Null with no error.
   */
  lands: Float64Array | null;
}

/** AxisShares from a list of shares at the pixels of an axis, and, to hold against a CE90, the shares at the four landings along it. */
export function axisSharesOf(
  own: ArrayLike<number>, thr: number,
  along: { plus: ArrayLike<number>; minus: ArrayLike<number>; diagPlus: ArrayLike<number>; diagMinus: ArrayLike<number> } | null,
): AxisShares {
  const kept: number[] = [], lands: number[] = [];
  for (let q = 0; q < own.length; q++) {
    const w = own[q];
    if (!(w >= thr)) continue;
    kept.push(w);
    if (along) lands.push(w, Math.min(along.plus[q], along.minus[q]), Math.min(along.diagPlus[q], along.diagMinus[q]));
  }
  return { own: Float64Array.from(kept).sort().reverse(), lands: along ? Float64Array.from(lands) : null };
}

/** AxisShares of the interval [lo, lo + len) under a spot of standard deviation `s`, at the pixel centres `at`. */
function spotAxis(lo: number, len: number, at: Float64Array, s: number, thr: number, holdM: number): AxisShares {
  const hi = lo + len, diag = holdM / Math.SQRT2;
  const kept: number[] = [], lands: number[] = [];
  for (let q = 0; q < at.length; q++) {
    const c = at[q];
    // A spot centred outside an interval has less than half of itself in it.
    if (c <= lo || c >= hi) continue;
    const w = band(lo, hi, c, s);
    if (!(w >= thr)) continue;
    kept.push(w);
    if (holdM > 0) {
      lands.push(w, Math.min(band(lo, hi, c + holdM, s), band(lo, hi, c - holdM, s)), Math.min(band(lo, hi, c + diag, s), band(lo, hi, c - diag, s)));
    }
  }
  return { own: Float64Array.from(kept).sort().reverse(), lands: holdM > 0 ? Float64Array.from(lands) : null };
}

/** Pixels pure for a plot: the pairs, one share from each side, whose product reaches the threshold. */
export function purePairs(A: AxisShares, B: AxisShares, thr: number): number {
  // Both largest first: as the share along one side falls, fewer along the other still make the product.
  const a = A.own, b = B.own;
  let k = b.length, n = 0;
  for (let i = 0; i < a.length && k > 0; i++) {
    while (k > 0 && a[i] * b[k - 1] < thr) k--;
    n += k;
  }
  return n;
}

/**
 * Pixels that hold for a plot within the CE90 the two sides were listed for:
 * pure with the image in place and at each of its eight landings, along the
 * plot's sides and along its diagonals. A landing along one side moves one
 * share only, and of the two ways along it the smaller share decides; the four
 * diagonal landings move both, and the two smaller shares decide them all.
 */
export function heldPairs(A: AxisShares, B: AxisShares, thr: number): number {
  const a = A.lands, b = B.lands;
  if (!a || !b) return 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 3) {
    const a0 = a[i], aC = a[i + 1], aD = a[i + 2];
    for (let j = 0; j < b.length; j += 3) {
      const b0 = b[j];
      if (a0 * b0 >= thr && aC * b0 >= thr && a0 * b[j + 1] >= thr && aD * b[j + 2] >= thr) n++;
    }
  }
  return n;
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
  const cropMapPurity = new Float32Array(cells);
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

  const result: AggregateResult = { rowsAgg, colsAgg, cropMapMixed, cropMapMajority, cropMapCenter, cropMapProportionA, cropMapProportionBare, cropMapPurity,
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
  /**
   * True for a sensor whose pixel lattice is not known before the image is
   * taken: a tasked satellite delivers each image on a grid of its own, and no
   * trial can be planted against it. A fixed grid (Sentinel-2, Landsat) is
   * known to the metre years ahead, and a trial is slid to the position on it
   * that keeps the most pure pixels. Here there is no position to choose, and
   * the note takes the worst: every search that slides a trial along the
   * lattice (bestPhaseOffset, stakeBlockPlan, stakeOnGrid, placementSearch)
   * then returns the position that keeps the FEWEST, so that what is counted
   * is what the trial keeps wherever the grid falls. The engine itself reads
   * nothing of it: a position given is simulated the same for any sensor.
   */
  anyPosition?: boolean;
  /**
   * WHAT those searches count, as a CE90 in metres. None, or 0: the pure
   * pixels, with the image exactly where it says. Above 0: the pure pixels
   * that hold, for the same cover, wherever the image lands within that
   * distance, and among positions that hold as many, the pure ones. The two
   * are not the same position: 30 m strips at 10 m keep two pure pixel rows 10 m
   * from each border, and neither holds; one row down the middle of the strip
   * holds. Which of the two a trial is placed for is the reader's choice
   * (use-grid `placeFor`). Nothing holds past half a plot or half a strip: the
   * pure pixels alone are then counted. Like anyPosition, the engine reads
   * nothing of it.
   */
  placeHeldM?: number;
}

/**
 * In a search's score a pixel that holds weighs this much more than a pure one:
 * first the pixels that hold, then the pure ones. Above any count of pixels a
 * search scores (its windows are a few thousand pixels).
 */
export const HELD_FIRST = 1e7;

/** The CE90 a search places for, in metres, or 0 for the pure pixels: none past half the short side of what a cover id stands for. */
export function placedFor(sensor: SensorParams, shortSideM: number): number {
  const m = sensor.placeHeldM;
  return typeof m === 'number' && m > 0 && m < shortSideM / 2 ? m : 0;
}

/** Whether `a` is the count to keep over `b` for this sensor: more pure pixels on a known lattice, fewer on one that falls anywhere. */
export const keepsCount = (sensor: SensorParams, a: number, b: number): boolean => (sensor.anyPosition ? a < b : a > b);
/** The count any real one replaces at the start of such a search. */
export const noCountYet = (sensor: SensorParams): number => (sensor.anyPosition ? Infinity : -1);

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

/** Fine cells per pixel, each way, that a simulation of this layout is sampled on. */
export const fineCellsPerPixel = (res: number, layout: SimLayout): number => strideFor(res, minFeatureM(layout));

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
  const pattern = layout.pattern;
  // Every cell is patternCultureUV(u, v) with
  //   u = dx * cos + dy * sin,  v = -dx * sin + dy * cos,
  // and what follows only avoids working that out a cell at a time where the
  // answer is known sooner. The map is the same byte for byte (the suite checks
  // it against the cell-by-cell definition).
  if (sin === 0 && rows > 0 && cols > 0) {
    // Along the pixel rows u is the column's and v is the row's: dy * 0 and
    // dx * 0 are zeros, and adding a zero changes nothing but, at most, the
    // sign of a zero, which no comparison, floor or remainder below can see.
    // So each axis is classified once, and a cell is a lookup in the two.
    const uCol = new Float64Array(cols), vRow = new Float64Array(rows);
    const dy0 = minN + 0.5 * fineRes - patternOy, dx0 = minE + 0.5 * fineRes - patternOx;
    for (let c = 0; c < cols; c++) { const dx = minE + (c + 0.5) * fineRes - patternOx; uCol[c] = dx * cos + dy0 * sin; }
    for (let r = 0; r < rows; r++) { const dy = minN + (r + 0.5) * fineRes - patternOy; vRow[r] = -dx0 * sin + dy * cos; }
    if (pattern === 'row' || pattern === 'strip-row-2') {
      for (let r = 0; r < rows; r++) map.fill(patternCultureUV(uCol[0], vRow[r], layout), r * cols, (r + 1) * cols);
      return map;
    }
    if (pattern === 'col' || pattern === 'strip-col-2') {
      const first = map.subarray(0, cols);
      for (let c = 0; c < cols; c++) first[c] = patternCultureUV(uCol[c], vRow[0], layout);
      for (let r = 1; r < rows; r++) map.copyWithin(r * cols, 0, cols);
      return map;
    }
    if (pattern === 'checker') {
      const W = layout.width, P = W + Math.max(0, layout.spacing || 0);
      const inU = new Uint8Array(cols), iU = new Float64Array(cols);
      for (let c = 0; c < cols; c++) { const u = uCol[c]; inU[c] = (((u % P) + P) % P) < W ? 1 : 0; iU[c] = Math.floor(u / P); }
      for (let r = 0; r < rows; r++) {
        const v = vRow[r], base = r * cols;
        if (!((((v % P) + P) % P) < W)) { map.fill(BARE.id, base, base + cols); continue; }
        const iV = Math.floor(v / P);
        for (let c = 0; c < cols; c++) map[base + c] = inU[c] ? (((iU[c] + iV) % 2) + 2) % 2 : BARE.id;
      }
      return map;
    }
    if (pattern === 'block') {
      const p = layout.block;
      if (!p) { map.fill(OFF_TRIAL.id); return map; }
      // blockCoverUV, one axis at a time: its tests on u, then its tests on v.
      const colOff = new Uint8Array(cols), colAlley = new Uint8Array(cols), colI = new Float64Array(cols);
      for (let c = 0; c < cols; c++) {
        const du = uCol[c] - p.u0;
        if (du < 0 || du >= p.totalU) { colOff[c] = 1; continue; }
        const ci = Math.floor(du / p.pitchU);
        colI[c] = ci;
        if (du - ci * p.pitchU >= p.blockU) colAlley[c] = 1;
      }
      const pitch = p.design.plotWidth + p.design.plotAlley, nSp = p.design.nSpecies, nBlocks = p.design.nBlocks;
      for (let r = 0; r < rows; r++) {
        const base = r * cols, dv = vRow[r] - p.v0;
        if (dv < 0 || dv >= p.totalV) { map.fill(OFF_TRIAL.id, base, base + cols); continue; }
        const ri = Math.floor(dv / p.pitchV), vIn = dv - ri * p.pitchV;
        const k = Math.floor(vIn / pitch);
        const rowBare = vIn >= p.blockV || k >= nSp || vIn - k * pitch >= p.design.plotWidth;
        for (let c = 0; c < cols; c++) {
          if (colOff[c]) { map[base + c] = OFF_TRIAL.id; continue; }
          const b = ri * p.cols + colI[c];
          map[base + c] = b >= nBlocks ? OFF_TRIAL.id : colAlley[c] || rowBare ? BARE.id : b * nSp + k;
        }
      }
      return map;
    }
  }
  // Turned: every cell on its own. The two terms that hold along a row are
  // taken out of the inner loop (the same products, added in the same order),
  // and the periodic patterns are written out so that no closure is made per cell.
  const W = layout.width, P = W + Math.max(0, layout.spacing || 0);
  const rowKind = pattern === 'row' || pattern === 'strip-row-2';
  const colKind = pattern === 'col' || pattern === 'strip-col-2';
  const two = pattern === 'strip-row-2' || pattern === 'strip-col-2';
  for (let r = 0; r < rows; r++) {
    const dy = minN + (r + 0.5) * fineRes - patternOy;
    const dySin = dy * sin, dyCos = dy * cos, base = r * cols;
    if (rowKind || colKind) {
      for (let c = 0; c < cols; c++) {
        const dx = minE + (c + 0.5) * fineRes - patternOx;
        const x = rowKind ? -dx * sin + dyCos : dx * cos + dySin;
        if (!((((x % P) + P) % P) < W)) { map[base + c] = BARE.id; continue; }
        let i = Math.floor(x / P);
        if (two) i = Math.floor(i / 2);
        map[base + c] = ((i % 2) + 2) % 2;
      }
    } else {
      for (let c = 0; c < cols; c++) {
        const dx = minE + (c + 0.5) * fineRes - patternOx;
        map[base + c] = patternCultureUV(dx * cos + dySin, -dx * sin + dyCos, layout);
      }
    }
  }
  return map;
}

export interface FieldSim {
  proportionA: Float32Array;    // per sensor pixel, aligned to grid.cells order
  proportionBare: Float32Array; // fraction of bare-soil gap in the pixel
  mixed: Uint8Array;            // MIXED, a sentinel, else the dominant cover id
  /**
   * Per pixel, the share of its signal held by its dominant cover, and that
   * cover's id whether or not it clears the threshold: what the map says about
   * the pixel under the pointer. Present on a simulation of a whole grid
   * (simulateField); the subsets cut from one for the PCA do not carry them.
   */
  purity?: Float32Array;
  dominant?: Uint8Array;
  purePct: number;              // % of TRIAL pixels that are a pure single crop
  /** The count behind purePct: pure single-crop pixels. */
  pureCrop: number;
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

// ===== the note's model: a spot on the ground, and no box for the pixel =======
//
// PHENET note, Appendix A, assumption H1: "the measured value of a pixel is the
// ground signal weighted by the PSF centred on the true pixel centre. The PSF is
// an isotropic Gaussian [...]. The FWHM values were measured on images, so they
// already include the detector footprint and the motion blur: we do not add a
// separate box for the pixel."
//
// The repo's engine (`aggregate`, above) does add one. It averages the ground
// over each pixel's square, then weights whole pixels by a Gaussian read at the
// pixels' centres: the footprint is counted on top of a blur that already
// contains it, and a neighbouring pixel counts the same from its near edge to
// its far one, where a spot falls away across it. For a pixel on the centre of
// a 20 m plot, under the Sentinel-2 blur, that reads 30 % of its signal from
// outside where the note's law gives 18 % (and 38 % against 26 % once the
// geolocation error is in the spot). An outside review of the code against the
// note found it (2026-11-22); the plot-size card already followed the note, so
// the page held two models, and every count on the map, in the table and in
// the suggestions came from the one the note does not use.
//
// What follows is the note's own: for each pixel, the share of a Gaussian spot
// centred on it that falls on each cover, worked out on the ground the layout
// describes and not on a grid of samples.
//
//  - strips are bands, and a band's share is one difference of two normal
//    distribution values, whatever the angle and whatever the spot's two widths;
//  - a checkerboard's cell and a block trial's plot are rectangles, and a
//    rectangle's share is the product of its two sides' (the note's
//    P = F(x) F(y)) whenever the spot is as wide one way as the other, or the
//    rectangle lies along its axes;
//  - any other shape, an imported plot that is no rectangle, or a rectangle
//    under a spot that is neither round nor aligned with it, is taken along its
//    outline (Green's theorem turns the share into an integral along the edges).
//
// The ground is whatever the layout says it is, as far as the spot reaches:
// nothing is cut at the edge of the grid being simulated, so a pixel at the
// edge of a box reads exactly what it reads in the middle of a larger one.
//
// EVERY BLUR IS A SPOT, and no spot is narrower than a pixel's own footprint.
// The note's blur is end to end: it contains the detector, whose square alone
// spreads the signal by 1 / sqrt(12) of a pixel (FOOTPRINT_SIGMA). A figure
// typed in under that cannot be an end-to-end blur, and is read as the least
// one there can be, axis by axis (spotSigma). So the model does not change
// with the figure, and a wider blur never reads sharper than a narrower one.
// It used to switch at the footprint to the repo engine, whose Gaussian is
// read at whole pixels only: at 0.288 px that engine left 0.24 % of a pixel
// beside a border on the other crop, and the spot at 0.289 px left 4.2 %
// (found by an outside review, 2026-11-22).
//
// Only NO blur at all, both sigmas exactly 0, is not a spot: it is the pixel
// as a plain square, each cover by the area it holds of it, which is the repo
// engine's own phase 1 and exact. That engine's blur (simulateFieldReference)
// is kept as what it was, and reads no pixel of the page any more.

/**
 * The spread of a pixel's own footprint, a uniform square, in pixels: 1 / sqrt(12).
 * An end-to-end spot cannot be narrower than the footprint it contains.
 */
export const FOOTPRINT_SIGMA = 1 / Math.sqrt(12);

/** The spot a blur of `sigma` pixels is read with along one axis: itself, or the footprint's own spread when it is narrower. */
export const spotSigma = (sigma: number): number => (sigma > FOOTPRINT_SIGMA ? sigma : FOOTPRINT_SIGMA);

/** True when a sensor has a blur at all, along either axis: the model of this section applies. False for no blur, the pixel as a square. */
export function followsSpot(sensor: Pick<SensorParams, 'sigmaX' | 'sigmaY'>): boolean {
  return typeof sensor.sigmaX === 'number' && typeof sensor.sigmaY === 'number'
    && Number.isFinite(sensor.sigmaX) && Number.isFinite(sensor.sigmaY)
    && sensor.sigmaX >= 0 && sensor.sigmaY >= 0 && (sensor.sigmaX > 0 || sensor.sigmaY > 0);
}

/** How far a spot is followed, in its own sigmas: past it a Gaussian holds 2e-9 of its weight. */
const SPOT_REACH = 6;
/** A share under this is no share: the pixel is not said to see that cover. */
const SPOT_DUST = 1e-9;

/**
 * What a spot of standard deviation `s` centred at `c` puts between `lo` and `hi`.
 *
 * The far side's term is left out where it cannot change the answer by a bit:
 * 8.5 sigmas below, it is under 1e-17, less than half the last bit of any
 * upper term of an eighth or more (which one sigma past the near side still
 * is). Checked on six million bands: none differs. Half of a plot's pixels are
 * that far from one of its sides at the finest pixel sizes.
 */
const band = (lo: number, hi: number, c: number, s: number): number => {
  const zh = (hi - c) / s, zl = (lo - c) / s, up = normCdf(zh);
  return zl <= -8.5 && zh >= -1 ? up : up - normCdf(zl);
};

/**
 * The bands of one row of intervals, each next to the one before: `band`, but
 * an interval that starts exactly where the last one ended (strips with no
 * alley between them, plots that touch) takes its lower edge's value from
 * that one instead of working it out again. The same numbers as `band` gives,
 * to the bit: it is the same expression of the same edge.
 */
let chainEdge = NaN, chainValue = 0;
const chainStart = (): void => { chainEdge = NaN; };
const chainBand = (lo: number, hi: number, c: number, s: number): number => {
  const zh = (hi - c) / s, zl = (lo - c) / s, up = normCdf(zh);
  const out = zl <= -8.5 && zh >= -1 ? up : up - (lo === chainEdge ? chainValue : normCdf(zl));
  chainEdge = hi; chainValue = up;
  return out;
};

/** Five-point Gauss-Legendre on [0, 1]. */
const GL_X = [0.046910077030668, 0.230765344947158, 0.5, 0.769234655052841, 0.953089922969332];
const GL_W = [0.118463442528095, 0.239314335249683, 0.284444444444444, 0.239314335249683, 0.118463442528095];
const INV_SQRT_2PI = 0.3989422804014327;
/** Past this many sigmas a term of the outline integral is its limit (0, or a plain difference). */
const EDGE_REACH = 7.5;

/**
 * One edge's term of the outline integral, in the spot's own units (X and Y in
 * sigmas from its centre): the integral of Phi(X) phi(Y) dY along the edge.
 * Summed round a ring it is the share of a standard Gaussian inside the ring,
 * positive for a ring that runs counter-clockwise (Green's theorem with
 * Q = Phi(X) phi(Y), whose derivative in X is the density).
 *
 * The integrand is smooth on the scale of one sigma, so the edge is cut into
 * pieces no longer than that and each is read at five points. Where the edge
 * is far to the left Phi is 0 and it contributes nothing; far to the right Phi
 * is 1 and the term is a difference of two distribution values; far above or
 * below, phi is 0.
 */
function edgeTerm(x0: number, y0: number, x1: number, y1: number): number {
  const dy = y1 - y0;
  if (dy === 0) return 0;
  const dx = x1 - x0;
  // The stretch of the edge inside the band |Y| <= EDGE_REACH.
  let ta = (-EDGE_REACH - y0) / dy, tb = (EDGE_REACH - y0) / dy;
  if (ta > tb) { const q = ta; ta = tb; tb = q; }
  if (ta < 0) ta = 0;
  if (tb > 1) tb = 1;
  if (!(tb > ta)) return 0;
  // Cut again where it crosses X = -EDGE_REACH and X = +EDGE_REACH: up to
  // three stretches, between ta, the two crossings in the order they are met,
  // and tb. (No list is made of them: this runs for every edge of every pixel.)
  let c1 = tb, c2 = tb;
  if (dx !== 0) {
    const tm = (-EDGE_REACH - x0) / dx, tp = (EDGE_REACH - x0) / dx;
    const lo = tm < tp ? tm : tp, hi = tm < tp ? tp : tm;
    if (lo > ta && lo < tb) c1 = lo;
    if (hi > ta && hi < tb) { if (c1 === tb) c1 = hi; else c2 = hi; }
  }
  let total = 0;
  for (let q = 0; q < 3; q++) {
    const t0 = q === 0 ? ta : q === 1 ? c1 : c2, t1 = q === 0 ? c1 : q === 1 ? c2 : tb;
    if (!(t1 > t0)) continue;
    const xm = x0 + dx * (t0 + t1) / 2;
    if (xm <= -EDGE_REACH) continue;
    if (xm >= EDGE_REACH) { total += normCdf(y0 + dy * t1) - normCdf(y0 + dy * t0); continue; }
    const pieces = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * (t1 - t0)));
    const h = (t1 - t0) / pieces;
    let sum = 0;
    for (let s = 0; s < pieces; s++) {
      const base = t0 + s * h;
      for (let g = 0; g < 5; g++) {
        const tt = base + GL_X[g] * h, Y = y0 + dy * tt;
        sum += GL_W[g] * normCdf(x0 + dx * tt) * Math.exp(-0.5 * Y * Y);
      }
    }
    total += sum * h * dy * INV_SQRT_2PI;
  }
  return total;
}

/**
 * The share of a spot centred at (cx, cy), with standard deviations sx along E
 * and sy along N, that falls inside ONE simple ring, whichever way it winds:
 * the outline integral round it, and its size.
 */
function spotInRing(ring: [number, number][], cx: number, cy: number, sx: number, sy: number): number {
  let total = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    total += edgeTerm((a[0] - cx) / sx, (a[1] - cy) / sy, (b[0] - cx) / sx, (b[1] - cy) / sy);
  }
  const share = Math.abs(total);
  return share > 1 ? 1 : share;
}

/**
 * The same for a shape of several rings read by the EVEN-ODD rule, as the rest
 * of the page reads an imported plot (importedCoverAt): a point is in the plot
 * when an odd number of its rings hold it. `sign` says, ring by ring, whether
 * the ring adds its share or takes it away (ringSigns).
 *
 * The rings used to be summed with the sign their winding gave them, which is
 * right only for a file whose outer rings all wind one way and its holes the
 * other. Nothing makes a file do that, and the point test does not ask it to:
 * a plot of two parts wound opposite ways read as no plot at all, and a hole
 * wound like its outline was filled in (found by an outside review, 2026-11-22).
 */
function spotInRings(rings: [number, number][][], sign: ArrayLike<number>, cx: number, cy: number, sx: number, sy: number): number {
  let total = 0;
  for (let q = 0; q < rings.length; q++) {
    const ring = rings[q], n = ring.length;
    let own = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      own += edgeTerm((a[0] - cx) / sx, (a[1] - cy) / sy, (b[0] - cx) / sx, (b[1] - cy) / sy);
    }
    total += sign[q] * Math.abs(own);
  }
  return total < 0 ? 0 : total > 1 ? 1 : total;
}

/** Twice a ring's signed area, taken from its first vertex (a ring's coordinates are six and seven figures long: taken from the origin, a small plot's area would be lost in them). */
function shoelace2(ring: [number, number][]): number {
  const [x0, y0] = ring[0];
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    s += (a[0] - x0) * (b[1] - y0) - (b[0] - x0) * (a[1] - y0);
  }
  return s;
}

/** Whether a point is inside one ring (crossings to its east). */
function inRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < xi + ((y - yi) / (yj - yi)) * (xj - xi)) inside = !inside;
  }
  return inside;
}

/**
 * For each ring of a shape read by the even-odd rule: +1 when the ring adds
 * the ground it encloses, -1 when it takes it away. A ring inside an even
 * number of the others (none, for an outline or a second part) adds; inside an
 * odd number (a hole) it takes away; and so on inwards. Rings that cross each
 * other are not a shape this can read, and nothing reads them better.
 */
function ringSigns(rings: [number, number][][]): Float64Array {
  const out = new Float64Array(rings.length).fill(1);
  if (rings.length < 2) return out;
  for (let q = 0; q < rings.length; q++) {
    // A point of the ring itself: the middle of its first side, nudged off no other ring's vertex.
    const a = rings[q][0], b = rings[q][1] ?? a, x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
    let depth = 0;
    for (let r = 0; r < rings.length; r++) if (r !== q && inRing(x, y, rings[r])) depth++;
    if (depth % 2 === 1) out[q] = -1;
  }
  return out;
}

/** A ring without its closing vertex, wound counter-clockwise. */
function openCcw(ring: [number, number][]): [number, number][] {
  const n = ring.length;
  const open = n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? ring.slice(0, n - 1) : ring.slice();
  return open.length >= 3 && shoelace2(open) < 0 ? open.reverse() : open;
}

/** `ring` cut down to what lies inside the convex ring `win` (open, counter-clockwise): Sutherland-Hodgman. Empty when nothing is left. */
function clipToConvex(ring: [number, number][], win: [number, number][]): [number, number][] {
  let out = ring;
  for (let i = 0; i < win.length && out.length >= 3; i++) {
    const a = win[i], b = win[(i + 1) % win.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const next: [number, number][] = [];
    for (let q = 0; q < out.length; q++) {
      const p = out[q], n = out[(q + 1) % out.length];
      const sp = ex * (p[1] - a[1]) - ey * (p[0] - a[0]), sn = ex * (n[1] - a[1]) - ey * (n[0] - a[0]);
      if (sp >= 0) next.push(p);
      if ((sp > 0 && sn < 0) || (sp < 0 && sn > 0)) { const t = sp / (sp - sn); next.push([p[0] + t * (n[0] - p[0]), p[1] + t * (n[1] - p[1])]); }
    }
    out = next;
  }
  return out.length >= 3 ? out : [];
}

/** A plot of an imported trial, made ready for the spot: its box, and its own frame when it is a rectangle. */
interface SpotPlot {
  cover: number;
  rings: [number, number][][];
  /** Per ring, +1 or -1: what the ring does to the plot's ground under the even-odd rule (ringSigns). */
  sign: Float64Array;
  box: [number, number, number, number];
  /** Centre, the unit vector along its first side, and its two half sides: null for anything but a rectangle. */
  rect: { cx: number; cy: number; ex: number; ey: number; ha: number; hb: number } | null;
  /**
   * Ground this plot does not keep, because a LATER plot of the file lies on
   * it too and the later plot wins (importedCoverAt): the pieces it shares
   * with each of them, to take away (weight -1), and the pieces shared with
   * two of them at once, taken away twice and so given back once (+1). Null
   * for a plot no later plot touches, which is every plot of most trials.
   */
  less: { ring: [number, number][]; w: number }[] | null;
}
interface SpotPlan {
  plots: SpotPlot[]; cell: number; e0: number; n0: number; gx: number; gy: number; bins: Int32Array[];
  /**
   * The last spot each plot was weighed for, and the number of the spot in
   * hand. Both live with the plan, which is kept from one simulation to the
   * next: a count restarted at each simulation met the marks the one before had
   * left, and a plot was then passed over as already weighed.
   */
  stamp: Int32Array; tick: number;
  /**
   * The footprint's sides as (a point, the unit normal pointing in), four
   * numbers each, when it is convex, which a hull is: null otherwise. A spot
   * whose centre is further inside than it reaches from every side lies wholly
   * in the trial, and one that far outside any side lies wholly out of it; the
   * outline integral is then not needed, which is most pixels of a trial.
   */
  hullSides: Float64Array | null;
  /** The footprint as a rectangle, when it is one: its share of a round spot is then two bands, as a plot's. */
  hullRect: SpotPlot['rect'];
  /**
   * 1 for a plot that overlaps another in a way no clip settles here (neither
   * of the two is convex): a pixel whose spot reaches one is worked out point
   * by point instead (spotByPoints), slowly and to about a hundredth. Null
   * when there is none, which is every trial seen so far.
   */
  rough: Uint8Array | null;
}
const spotPlans = new WeakMap<ImportedPlan, SpotPlan>();

/** A ring's four corners when it is a rectangle (four sides, closed or not, square at every corner), else null. */
function rectOf(ring: [number, number][]): SpotPlot['rect'] {
  const n = ring.length;
  const m = n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? n - 1 : n;
  if (m !== 4) return null;
  const [a, b, c, d] = ring;
  const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - a[0], vy = d[1] - a[1];
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (!(lu > 0) || !(lv > 0)) return null;
  const tol = 1e-6 * Math.max(lu, lv);
  // A parallelogram whose two sides are square to each other.
  if (Math.abs(a[0] + ux + vx - c[0]) > tol || Math.abs(a[1] + uy + vy - c[1]) > tol) return null;
  if (Math.abs(ux * vx + uy * vy) > 1e-6 * lu * lv) return null;
  return { cx: a[0] + (ux + vx) / 2, cy: a[1] + (uy + vy) / 2, ex: ux / lu, ey: uy / lu, ha: lu / 2, hb: lv / 2 };
}

/** The sides of a convex ring, each as a point and its inward unit normal; null for a ring that is not convex or has no area. */
function convexSides(ring: [number, number][]): Float64Array | null {
  // Without its closing vertex and without a vertex said twice: a side of no length has no direction to turn from.
  const pts: [number, number][] = [];
  for (const p of ring) { const last = pts[pts.length - 1]; if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p); }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  const n = pts.length;
  if (n < 3) return null;
  const area = shoelace2(pts);
  if (!(Math.abs(area) > 0)) return null;
  const sign = area > 0 ? 1 : -1;
  const out = new Float64Array(4 * n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    // Every turn the same way, or the ring is not convex (a little slack for points in a line).
    if (sign * (dx * (c[1] - b[1]) - dy * (c[0] - b[0])) < -1e-9 * len * Math.hypot(c[0] - b[0], c[1] - b[1])) return null;
    out[m++] = a[0]; out[m++] = a[1]; out[m++] = (-dy / len) * sign; out[m++] = (dx / len) * sign;
  }
  return out;
}

/** The plots of a plan, boxed, and sorted into a coarse grid so that a pixel asks only the ones near it. */
function spotPlanOf(plan: ImportedPlan): SpotPlan {
  const hit = spotPlans.get(plan);
  if (hit) return hit;
  const plots: SpotPlot[] = plan.plots.map((pl, k) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const ring of pl.rings) for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
    return { cover: importedCoverId(plan, k), rings: pl.rings, sign: ringSigns(pl.rings), box: [w, s, e, n],
             rect: pl.rings.length === 1 ? rectOf(pl.rings[0]) : null, less: null };
  });
  const [b0, b1, b2, b3] = plan.bbox;
  const area = Math.max(1e-6, (b2 - b0) * (b3 - b1));
  // A cell about a plot and a half wide, and never so small that 512 of them a
  // side stop short of the trial: past that count the last cell used to stand
  // for everything beyond it, and a pixel out there looked in a cell that did
  // not exist (a strip of 600 plots 12 km long read as bare ground past 7.7 km;
  // found by an outside review, 2026-11-22).
  const cell = Math.max(0.25, Math.sqrt(area / Math.max(1, plots.length)) * 1.5, (b2 - b0) / 512, (b3 - b1) / 512);
  const gx = Math.max(1, Math.min(512, Math.ceil((b2 - b0) / cell))), gy = Math.max(1, Math.min(512, Math.ceil((b3 - b1) / cell)));
  const lists: number[][] = Array.from({ length: gx * gy }, () => []);
  const at = (v: number, lo: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor((v - lo) / cell)));
  plots.forEach((pl, k) => {
    for (let j = at(pl.box[1], b1, gy); j <= at(pl.box[3], b1, gy); j++) {
      for (let i = at(pl.box[0], b0, gx); i <= at(pl.box[2], b0, gx); i++) lists[j * gx + i].push(k);
    }
  });
  const rough = sharedGround(plots, lists);
  const made: SpotPlan = { plots, cell, e0: b0, n0: b1, gx, gy, bins: lists.map(l => Int32Array.from(l)), stamp: new Int32Array(plots.length), tick: 0,
                           hullSides: convexSides(plan.footprint), hullRect: rectOf(plan.footprint), rough };
  spotPlans.set(plan, made);
  return made;
}

/**
 * The ground plots of one file share, settled once for the plan: where two
 * plots overlap the LATER one of the file has the ground (importedCoverAt),
 * so the earlier one is given, as pieces to take away, what it shares with
 * each later plot (SpotPlot.less).
 *
 * A shared piece is a clip of one plot against the other, which is exact when
 * one of the two is a single convex ring: nearly every plot of a trial. Where
 * three plots share ground, the piece common to all three was taken from the
 * earliest twice and is given back once. Four deep is not followed: it would
 * be a sliver at a corner where four plots meet, a thousandth of a pixel.
 * Plots that only touch share nothing, by a billionth of the smaller one.
 *
 * Returns the plots no clip settles (two that overlap and neither convex), or
 * null. They were summed as if nothing overlapped, each plot whole, before:
 * two plots drawn one on the other read half each instead of the later one
 * alone (found by an outside review, 2026-11-22).
 */
function sharedGround(plots: SpotPlot[], bins: number[][]): Uint8Array | null {
  const n = plots.length;
  if (n < 2) return null;
  const simple = plots.map(p => (p.rings.length === 1 && convexSides(p.rings[0]) ? openCcw(p.rings[0]) : null));
  const size = plots.map(p => p.rings.reduce((a, ring, q) => a + p.sign[q] * Math.abs(shoelace2(ring)) / 2, 0));
  /** What plot k shares with the single convex ring `win`: k's rings clipped, each with its own sign. */
  const shared = (k: number, win: [number, number][]): { ring: [number, number][]; w: number }[] => {
    const out: { ring: [number, number][]; w: number }[] = [];
    plots[k].rings.forEach((ring, q) => {
      const cut = clipToConvex(openCcw(ring), win);
      if (cut.length) out.push({ ring: cut, w: plots[k].sign[q] });
    });
    return out;
  };
  const areaOf = (pieces: { ring: [number, number][]; w: number }[]) => pieces.reduce((a, c) => a + c.w * Math.abs(shoelace2(c.ring)) / 2, 0);
  let rough: Uint8Array | null = null;
  const seen = new Set<number>();
  /** Per earlier plot: the later plots it shares ground with, and the pieces. */
  const cuts = new Map<number, { later: number; pieces: { ring: [number, number][]; w: number }[] }[]>();
  for (const list of bins) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const k = Math.min(list[a], list[b]), j = Math.max(list[a], list[b]);
        if (seen.has(k * n + j)) continue;
        seen.add(k * n + j);
        const A = plots[k].box, B = plots[j].box;
        if (A[0] >= B[2] || B[0] >= A[2] || A[1] >= B[3] || B[1] >= A[3]) continue;
        // The same ground whichever of the two is the window: the later plot's rings, or the earlier one's.
        let pieces: { ring: [number, number][]; w: number }[];
        if (simple[j]) pieces = shared(k, simple[j]!);
        else if (simple[k]) pieces = shared(j, simple[k]!);
        else { (rough ??= new Uint8Array(n))[k] = 1; rough[j] = 1; continue; }
        if (!(areaOf(pieces) > 1e-9 * Math.min(Math.abs(size[k]), Math.abs(size[j])))) continue;
        if (!cuts.has(k)) cuts.set(k, []);
        cuts.get(k)!.push({ later: j, pieces });
      }
    }
  }
  for (const [k, list] of cuts) {
    const less: { ring: [number, number][]; w: number }[] = [];
    for (const c of list) for (const piece of c.pieces) less.push({ ring: piece.ring, w: -piece.w });
    // Ground shared with two later plots at once: taken away twice above, given back once.
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const win = simple[list[b].later] ?? null, other = simple[list[a].later] ?? null;
        const from = win ? list[a].pieces : other ? list[b].pieces : null;
        const through = win ?? other;
        if (!from || !through) continue;
        for (const piece of from) {
          const cut = clipToConvex(piece.ring, through);
          if (cut.length && Math.abs(shoelace2(cut)) / 2 > 1e-9 * Math.abs(size[k])) less.push({ ring: cut, w: piece.w });
        }
      }
    }
    plots[k].less = less;
  }
  return rough;
}

/** Quantiles of the standard normal at the middles of SPOT_POINTS equal shares: where spotByPoints looks. */
const SPOT_POINTS = 48;
let spotQuantiles: Float64Array | null = null;

/**
 * A pixel's covers taken point by point: its spot as SPOT_POINTS squared
 * points of equal weight, each asked what the plan has under it. Only for the
 * plots no clip settles (SpotPlan.rough): about a hundredth of a share off,
 * and a thousand times the work of a pixel read the usual way.
 */
function spotByPoints(plan: ImportedPlan, E: number, N: number, sx: number, sy: number, add: (id: number, w: number) => void): void {
  if (!spotQuantiles) {
    spotQuantiles = new Float64Array(SPOT_POINTS);
    for (let i = 0; i < SPOT_POINTS; i++) spotQuantiles[i] = probit((i + 0.5) / SPOT_POINTS);
  }
  const z = spotQuantiles, w = 1 / (SPOT_POINTS * SPOT_POINTS);
  const tally = new Float64Array(256);
  for (let j = 0; j < SPOT_POINTS; j++) for (let i = 0; i < SPOT_POINTS; i++) tally[importedCoverAt(E + z[i] * sx, N + z[j] * sy, plan)] += w;
  for (let id = 0; id < 256; id++) if (tally[id] > 0) add(id, tally[id]);
}

/**
 * Phase 1 by the note's model: for every pixel asked for, the share of its
 * spot on each cover, as the (slot, weight) pairs `leanResolve` reads. The
 * weights of a pixel add up to 1 and are already the spot's: phase 2 is then
 * run with no blur of its own, and only classifies.
 *
 * `spotE`, `spotN` name one spot directly, for the one pixel `pixelSources`
 * draws: the grid is then that single pixel.
 */
function spotCovers(
  layout: SimLayout, patternOrigin: [number, number], minE: number, minN: number, nx: number, ny: number, res: number,
  sensor: SensorParams, need: ArrayLike<number> | null,
): PixelCovers {
  const cells = nx * ny;
  const pairStart = new Int32Array(cells + 1);
  // Room for three covers a pixel asked for, which few pixels pass (the lists grow when they do): a search asks about a few pixels of a large grid.
  let asked = cells;
  if (need) { asked = 0; for (let k = 0; k < cells; k++) if (need[k]) asked++; }
  let cap = asked * 3 + 64;
  let pairSlot = new Int32Array(cap), pairW = new Float64Array(cap), len = 0;
  // One pixel's covers in the making: a weight per cover id, and the ids touched.
  const acc = new Float64Array(256), touched = new Int32Array(256);
  let nT = 0;
  const add = (id: number, w: number): void => {
    if (!(w > SPOT_DUST)) return;
    if (acc[id] === 0) touched[nT++] = id;
    acc[id] += w;
  };
  /** Writes the pixel's pairs, lowest cover id first (the order that settles a tie), and clears the scratch. */
  const close = (k: number): void => {
    pairStart[k] = len;
    if (nT === 0) { touched[nT++] = OFF_TRIAL.id; acc[OFF_TRIAL.id] = 1; }  // a pixel always reads something
    for (let i = 1; i < nT; i++) { const v = touched[i]; let j = i - 1; while (j >= 0 && touched[j] > v) { touched[j + 1] = touched[j]; j--; } touched[j + 1] = v; }
    if (len + nT > cap) {
      cap = Math.max(cap * 2, len + nT);
      const s2 = new Int32Array(cap); s2.set(pairSlot); pairSlot = s2;
      const w2 = new Float64Array(cap); w2.set(pairW); pairW = w2;
    }
    for (let i = 0; i < nT; i++) { const id = touched[i]; pairSlot[len] = id; pairW[len++] = acc[id]; acc[id] = 0; }
    nT = 0;
  };

  const sx = spotSigma(sensor.sigmaX) * res, sy = spotSigma(sensor.sigmaY) * res;
  const offE = (sensor.offX ?? 0) * res, offN = (sensor.offY ?? 0) * res;
  const t = (layout.rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const [ox, oy] = patternOrigin;
  const round = Math.abs(sx - sy) <= 1e-12 * Math.max(sx, sy);
  // Along the pixel rows (or a quarter turn from them) the layout's two axes
  // are the grid's, and a spot that is not round is still a product of the two.
  const flat = Math.abs(sin) < 1e-12, upright = Math.abs(cos) < 1e-12;
  const su = flat ? sx : upright ? sy : round ? sx : NaN, sv = flat ? sy : upright ? sx : round ? sy : NaN;
  const separable = Number.isFinite(su);
  const pattern = layout.pattern;
  const imported = importedOf(layout);
  const W = layout.width, P = W + Math.max(0, layout.spacing || 0);

  /** The pixel's spot centre. */
  const centreE = (gc: number) => minE + (gc + 0.5) * res + offE;
  const centreN = (gr: number) => minN + (gr + 0.5) * res + offN;

  // ---- strips: a band's share is one-dimensional, at any angle ----
  if (!imported && (pattern === 'row' || pattern === 'strip-row-2' || pattern === 'col' || pattern === 'strip-col-2')) {
    const rowKind = pattern === 'row' || pattern === 'strip-row-2';
    const two = pattern === 'strip-row-2' || pattern === 'strip-col-2';
    // The coordinate the strips are cut along, x = a dx + b dy, and the spot's spread along it.
    const a = rowKind ? -sin : cos, b = rowKind ? cos : sin;
    const sn = Math.hypot(a * sx, b * sy);
    const noAlley = !(P - W > 1e-12);
    /** The two crops' shares and the alleys' for a spot centred at `c` along that coordinate. */
    const shares = (c: number, out: Float64Array): void => {
      const R = SPOT_REACH * sn;
      let s0 = 0, s1 = 0;
      chainStart();
      for (let i = Math.floor((c - R) / P), last = Math.floor((c + R) / P); i <= last; i++) {
        const lo = i * P, s = chainBand(lo, lo + W, c, sn);
        if (!(s > 0)) continue;
        const q = two ? Math.floor(i / 2) : i;
        if ((((q % 2) + 2) % 2) === 0) s0 += s; else s1 += s;
      }
      const sum = s0 + s1;
      if (noAlley && sum > 0) { out[0] = s0 / sum; out[1] = s1 / sum; out[2] = 0; return; }
      out[0] = s0; out[1] = s1; out[2] = Math.max(0, 1 - sum);
    };
    const one = new Float64Array(3);
    const byRow = Math.abs(a) < 1e-12, byCol = Math.abs(b) < 1e-12;
    // Along a grid axis the coordinate is the row's (or the column's) alone: worked out once for each.
    const lineShares = byRow || byCol ? new Float64Array(3 * (byRow ? ny : nx)) : null;
    if (lineShares) {
      const tmp = new Float64Array(3);
      for (let q = 0, n = byRow ? ny : nx; q < n; q++) {
        const c = byRow ? b * (centreN(q) - oy) + a * (centreE(0) - ox) : a * (centreE(q) - ox) + b * (centreN(0) - oy);
        shares(c, tmp);
        lineShares.set(tmp, 3 * q);
      }
    }
    for (let gr = 0; gr < ny; gr++) {
      for (let gc = 0; gc < nx; gc++) {
        const k = gr * nx + gc;
        if (need && !need[k]) { pairStart[k] = len; continue; }
        let s0: number, s1: number, bare: number;
        if (lineShares) { const q = 3 * (byRow ? gr : gc); s0 = lineShares[q]; s1 = lineShares[q + 1]; bare = lineShares[q + 2]; }
        else { shares(a * (centreE(gc) - ox) + b * (centreN(gr) - oy), one); s0 = one[0]; s1 = one[1]; bare = one[2]; }
        add(0, s0); add(1, s1); add(BARE.id, bare);
        close(k);
      }
    }
    pairStart[cells] = len;
    return { T: 0, means: [], hasValid: new Uint8Array(0), pairStart, pairSlot, pairW, slots: { cnt: new Float64Array(256), ord: new Int32Array(256), keys: [], index: new Map() } };
  }

  /** The layout's frame: u along its rows, v across them, from its origin. */
  const uOf = (E: number, N: number) => (E - ox) * cos + (N - oy) * sin;
  const vOf = (E: number, N: number) => -(E - ox) * sin + (N - oy) * cos;

  // ---- checkerboard and block trial, where a rectangle's share is the product of its sides' ----
  if (!imported && separable && (pattern === 'checker' || (pattern === 'block' && layout.block))) {
    const p = pattern === 'block' ? layout.block! : null;
    /**
     * Along one axis, what the spot puts on each interval the layout cuts it
     * into. Checkerboard: [cells of even index, cells of odd index].
     * Block trial along u: for each block column in reach, [column, the block's
     * own length, its cell with the alley]. Along v: for each block row in
     * reach, [row, its cell with the alley, then each plot of the block].
     *
     * Written into a list given, and its length returned: a trial at an angle
     * asks for both at every pixel, and each used to be two new arrays.
     */
    const nSp = p ? p.design.nSpecies : 0, plotPitch = p ? p.design.plotWidth + p.design.plotAlley : 0;
    const uRoom = p ? Math.max(3, 3 * p.cols) : 2, vRoom = p ? Math.max(2 + nSp, (2 + nSp) * p.rows) : 2;
    const alongU = (u: number, out: Float64Array): number => {
      if (!p) return parity(u, su, out);
      let m = 0;
      const R = SPOT_REACH * su, du = u - p.u0;
      for (let c = Math.max(0, Math.floor((du - R) / p.pitchU)), last = Math.min(p.cols - 1, Math.floor((du + R) / p.pitchU)); c <= last; c++) {
        const lo = p.u0 + c * p.pitchU;
        const cellShare = band(lo, Math.min(lo + p.pitchU, p.u0 + p.totalU), u, su);
        if (cellShare > 0) { out[m++] = c; out[m++] = band(lo, lo + p.blockU, u, su); out[m++] = cellShare; }
      }
      return m;
    };
    const alongV = (v: number, out: Float64Array): number => {
      if (!p) return parity(v, sv, out);
      let m = 0;
      const R = SPOT_REACH * sv, dv = v - p.v0;
      for (let r = Math.max(0, Math.floor((dv - R) / p.pitchV)), last = Math.min(p.rows - 1, Math.floor((dv + R) / p.pitchV)); r <= last; r++) {
        const lo = p.v0 + r * p.pitchV;
        const cellShare = band(lo, Math.min(lo + p.pitchV, p.v0 + p.totalV), v, sv);
        if (!(cellShare > 0)) continue;
        out[m++] = r; out[m++] = cellShare;
        chainStart();
        for (let q = 0; q < nSp; q++) { const a = lo + q * plotPitch; out[m++] = chainBand(a, a + p.design.plotWidth, v, sv); }
      }
      return m;
    };
    /** A checkerboard's cells along one axis: the shares of the even ones and of the odd ones. */
    function parity(c: number, s: number, out: Float64Array): number {
      const R = SPOT_REACH * s;
      let even = 0, odd = 0;
      chainStart();
      for (let i = Math.floor((c - R) / P), last = Math.floor((c + R) / P); i <= last; i++) {
        const lo = i * P, w = chainBand(lo, lo + W, c, s);
        if (!(w > 0)) continue;
        if ((((i % 2) + 2) % 2) === 0) even += w; else odd += w;
      }
      out[0] = even; out[1] = odd;
      return 2;
    }
    const combine = (U: Float64Array, nU: number, V: Float64Array, nV: number): void => {
      if (!p) {
        const c0 = U[0] * V[0] + U[1] * V[1], c1 = U[0] * V[1] + U[1] * V[0];
        add(0, c0); add(1, c1); add(BARE.id, 1 - c0 - c1);
        return;
      }
      const stride = 2 + nSp;
      let inTrial = 0, planted = 0;
      for (let j = 0; j < nV; j += stride) {
        const r = V[j];
        for (let i = 0; i < nU; i += 3) {
          const b = r * p.cols + U[i];
          if (b >= p.design.nBlocks) continue;                 // the ragged last row: no block, no trial
          inTrial += U[i + 2] * V[j + 1];
          const own = U[i + 1];
          if (!(own > 0)) continue;
          for (let q = 0; q < nSp; q++) {
            const w = own * V[j + 2 + q];
            if (w > SPOT_DUST) { add(b * nSp + q, w); planted += w; }
          }
        }
      }
      add(BARE.id, inTrial - planted);
      add(OFF_TRIAL.id, 1 - inTrial);
    };
    // Along the rows u is the column's and v the row's; a quarter turn swaps them.
    const lined = flat || upright;
    const uBuf = new Float64Array(uRoom), vBuf = new Float64Array(vRoom);
    const uLine = lined ? new Array<Float64Array>(flat ? nx : ny) : null, vLine = lined ? new Array<Float64Array>(flat ? ny : nx) : null;
    if (uLine && vLine) {
      for (let q = 0; q < uLine.length; q++) uLine[q] = uBuf.slice(0, alongU(flat ? uOf(centreE(q), centreN(0)) : uOf(centreE(0), centreN(q)), uBuf));
      for (let q = 0; q < vLine.length; q++) vLine[q] = vBuf.slice(0, alongV(flat ? vOf(centreE(0), centreN(q)) : vOf(centreE(q), centreN(0)), vBuf));
    }
    for (let gr = 0; gr < ny; gr++) {
      for (let gc = 0; gc < nx; gc++) {
        const k = gr * nx + gc;
        if (need && !need[k]) { pairStart[k] = len; continue; }
        if (uLine && vLine) { const U = uLine[flat ? gc : gr], V = vLine[flat ? gr : gc]; combine(U, U.length, V, V.length); }
        else { const E = centreE(gc), N = centreN(gr); const nU = alongU(uOf(E, N), uBuf), nV = alongV(vOf(E, N), vBuf); combine(uBuf, nU, vBuf, nV); }
        close(k);
      }
    }
    pairStart[cells] = len;
    return { T: 0, means: [], hasValid: new Uint8Array(0), pairStart, pairSlot, pairW, slots: { cnt: new Float64Array(256), ord: new Int32Array(256), keys: [], index: new Map() } };
  }

  // ---- everything else, along its outline ----
  /** A rectangle of the layout's own frame, as a ring of the grid's. */
  const ringUV = (u0: number, v0: number, u1: number, v1: number): [number, number][] =>
    ([[u0, v0], [u1, v0], [u1, v1], [u0, v1]] as [number, number][]).map(([u, v]) => [ox + u * cos - v * sin, oy + u * sin + v * cos] as [number, number]);
  const prep = imported ? spotPlanOf(imported) : null;
  const hull = imported ? imported.footprint : null;
  const rx = SPOT_REACH * sx, ry = SPOT_REACH * sy, far = SPOT_REACH * Math.max(sx, sy);
  // The plots a pixel may see, kept from one pixel of a row to the next while
  // both look in the same cells of the index: a cell is a plot and a half
  // wide, so dozens of pixels in a row share one list, and the cells were
  // walked and the plots told apart again for each of them.
  const cand = prep ? new Int32Array(prep.plots.length) : null;
  // A side of the footprint this near (round spot) has a say in the trial's share; the others, 6.5 sigmas inside and more, have none to a part in 1e10.
  const nearSide = 6.5 * sx;
  for (let gr = 0; gr < ny; gr++) {
    const N = centreN(gr);
    let seenI0 = -1, seenI1 = -1, nCand = 0, j0 = 0, j1 = -1;
    const rowInBox = !!imported && !(N + ry < imported.bbox[1] || N - ry > imported.bbox[3]);
    if (rowInBox && prep) {
      // Both ends inside the grid of cells: a pixel past its last cell looks in that cell, where everything past it was put.
      j0 = Math.min(prep.gy - 1, Math.max(0, Math.floor((N - ry - prep.n0) / prep.cell)));
      j1 = Math.min(prep.gy - 1, Math.max(0, Math.floor((N + ry - prep.n0) / prep.cell)));
    }
    for (let gc = 0; gc < nx; gc++) {
      const k = gr * nx + gc;
      if (need && !need[k]) { pairStart[k] = len; continue; }
      const E = centreE(gc);
      if (imported && prep && hull && cand) {
        const b0 = imported.bbox[0], b2 = imported.bbox[2];
        let inTrial = 0, planted = 0;
        if (rowInBox && !(E + rx < b0 || E - rx > b2)) {
          const { cell, e0, gx, bins, plots, stamp, rough } = prep;
          const i0 = Math.min(gx - 1, Math.max(0, Math.floor((E - rx - e0) / cell))), i1 = Math.min(gx - 1, Math.max(0, Math.floor((E + rx - e0) / cell)));
          if (i0 !== seenI0 || i1 !== seenI1) {
            seenI0 = i0; seenI1 = i1; nCand = 0;
            if (prep.tick > 2_000_000_000) { stamp.fill(0); prep.tick = 0; }
            const stampNo = ++prep.tick;
            for (let j = j0; j <= j1; j++) {
              for (let i = i0; i <= i1; i++) {
                const list = bins[j * gx + i];
                for (let q = 0; q < list.length; q++) {
                  const id = list[q];
                  if (stamp[id] === stampNo) continue;
                  stamp[id] = stampNo;
                  const pb = plots[id].box;
                  if (N + ry < pb[1] || N - ry > pb[3]) continue;
                  cand[nCand++] = id;
                }
              }
            }
          }
          let tangled = false, whole = false;
          for (let q = 0; q < nCand; q++) {
            const id = cand[q], pl = plots[id];
            if (E + rx < pl.box[0] || E - rx > pl.box[2]) continue;
            if (rough && rough[id]) { tangled = true; break; }
            let w: number;
            const rc = pl.rect;
            if (rc && round) {
              // The note's P = F(x) F(y), in the plot's own frame: a round spot has no direction.
              const dE = E - rc.cx, dN = N - rc.cy, a = dE * rc.ex + dN * rc.ey, b2n = -dE * rc.ey + dN * rc.ex;
              // Six sigmas past a side, or a first band already under a billionth: the share is dust, and was never kept.
              if ((a < 0 ? -a : a) >= rc.ha + rx || (b2n < 0 ? -b2n : b2n) >= rc.hb + rx) continue;
              const along = band(-rc.ha, rc.ha, a, sx);
              if (!(along > SPOT_DUST)) continue;
              w = along * band(-rc.hb, rc.hb, b2n, sx);
            } else w = spotInRings(pl.rings, pl.sign, E, N, sx, sy);
            // Less the ground a later plot of the file has taken from it.
            if (pl.less && w > SPOT_DUST) for (const cut of pl.less) w += cut.w * spotInRing(cut.ring, E, N, sx, sy);
            if (w > SPOT_DUST) {
              add(pl.cover, w); planted += w;
              // All of the spot on one plot: nothing is left for any other, nor for the ground between or beyond.
              if (w >= 1 && !pl.less) { whole = true; break; }
            }
          }
          if (tangled) {
            // Plots that overlap in a way no clip settles: this pixel point by point, every cover at once.
            for (let i = 0; i < nT; i++) acc[touched[i]] = 0;
            nT = 0;
            spotByPoints(imported, E, N, sx, sy, add);
            close(k);
            continue;
          }
          if (whole) inTrial = 1;
          else {
            // How much of the spot is in the trial's footprint: all of it, none of it, or the outline decides.
            const sides = prep.hullSides, hr = round ? prep.hullRect : null;
            if (hr) {
              const dE = E - hr.cx, dN = N - hr.cy, a = dE * hr.ex + dN * hr.ey, b2n = -dE * hr.ey + dN * hr.ex;
              inTrial = band(-hr.ha, hr.ha, a, sx) * band(-hr.hb, hr.hb, b2n, sx);
            } else if (sides) {
              // The sides near enough to matter: one is a straight border (one value of the normal law), two at a right angle a corner (two).
              let depth = Infinity, near = 0, s1 = 0, s2 = 0, d1 = 0, d2 = 0;
              for (let q = 0; q < sides.length; q += 4) {
                const d = (E - sides[q]) * sides[q + 2] + (N - sides[q + 1]) * sides[q + 3];
                if (d < depth) depth = d;
                if (d < nearSide) { if (near === 0) { s1 = q; d1 = d; } else if (near === 1) { s2 = q; d2 = d; } near++; }
              }
              if (depth >= far) inTrial = 1;
              else if (depth <= -far) inTrial = 0;
              else if (round && near === 1 && sides.length <= 80) inTrial = normCdf(d1 / sx);
              else if (round && near === 2 && sides.length <= 80 && Math.abs(sides[s1 + 2] * sides[s2 + 2] + sides[s1 + 3] * sides[s2 + 3]) < 1e-9) inTrial = normCdf(d1 / sx) * normCdf(d2 / sx);
              else inTrial = spotInRing(hull, E, N, sx, sy);
            } else inTrial = spotInRing(hull, E, N, sx, sy);
          }
        }
        // Inside the footprint and on no plot is bare alley; outside it, no trial at all.
        if (planted > inTrial) inTrial = planted;
        add(BARE.id, inTrial - planted);
        add(OFF_TRIAL.id, 1 - inTrial);
      } else if (pattern === 'block' && layout.block) {
        const p = layout.block, nSp = p.design.nSpecies, plotPitch = p.design.plotWidth + p.design.plotAlley;
        // A spot that is neither round nor along the trial: each rectangle along its outline.
        const u = uOf(E, N), v = vOf(E, N), reach = SPOT_REACH * Math.max(sx, sy);
        let inTrial = 0, planted = 0;
        for (let r = Math.max(0, Math.floor((v - p.v0 - reach) / p.pitchV)), rl = Math.min(p.rows - 1, Math.floor((v - p.v0 + reach) / p.pitchV)); r <= rl; r++) {
          for (let c = Math.max(0, Math.floor((u - p.u0 - reach) / p.pitchU)), cl = Math.min(p.cols - 1, Math.floor((u - p.u0 + reach) / p.pitchU)); c <= cl; c++) {
            const b = r * p.cols + c;
            if (b >= p.design.nBlocks) continue;
            const bu = p.u0 + c * p.pitchU, bv = p.v0 + r * p.pitchV;
            inTrial += spotInRing(ringUV(bu, bv, Math.min(bu + p.pitchU, p.u0 + p.totalU), Math.min(bv + p.pitchV, p.v0 + p.totalV)), E, N, sx, sy);
            for (let q = 0; q < nSp; q++) {
              const a = bv + q * plotPitch;
              const w = spotInRing(ringUV(bu, a, bu + p.blockU, a + p.design.plotWidth), E, N, sx, sy);
              if (w > SPOT_DUST) { add(b * nSp + q, w); planted += w; }
            }
          }
        }
        if (planted > inTrial) inTrial = planted;
        add(BARE.id, inTrial - planted);
        add(OFF_TRIAL.id, 1 - inTrial);
      } else if (pattern === 'checker') {
        const u = uOf(E, N), v = vOf(E, N), reach = SPOT_REACH * Math.max(sx, sy);
        let c0 = 0, c1 = 0;
        for (let j = Math.floor((v - reach) / P), jl = Math.floor((v + reach) / P); j <= jl; j++) {
          for (let i = Math.floor((u - reach) / P), il = Math.floor((u + reach) / P); i <= il; i++) {
            const w = spotInRing(ringUV(i * P, j * P, i * P + W, j * P + W), E, N, sx, sy);
            if ((((i + j) % 2) + 2) % 2 === 0) c0 += w; else c1 += w;
          }
        }
        add(0, c0); add(1, c1); add(BARE.id, 1 - c0 - c1);
      } else add(OFF_TRIAL.id, 1);                              // a layout with no ground to speak of
      close(k);
    }
  }
  pairStart[cells] = len;
  return { T: 0, means: [], hasValid: new Uint8Array(0), pairStart, pairSlot, pairW, slots: { cnt: new Float64Array(256), ord: new Int32Array(256), keys: [], index: new Map() } };
}

// ===== the driver's own path through the engine ==============================
//
// `aggregate` is the port of the repo's engine and stays exactly as it is: it
// takes any series, any rotation and any cover map, and the suite pins it value
// for value. The page never asks it for any of that. Every simulation the page
// runs has no series (T = 0), no rotation of the fine grid, a cover map it built
// itself and weights the outside in, and reads seven arrays of the result.
//
// What follows is that one case written on its own: the same sums, of the same
// numbers, in the same order, so every figure is the one `aggregate` gives, to
// the last bit (simulateFieldReference is the proof, and the suite compares the
// two pixel by pixel). It is faster for what it does not do:
//
//  - a fine cell is read once, not once per sub-sample (16 reads of one byte);
//  - nothing is allocated per pixel, and nothing is computed that no caller
//    reads (the cover at the centre, the dominant species, the dominant plot);
//  - a pixel whose whole kernel window is one cover is settled without summing:
//    its shares are w / w and 0 / w whatever the sum comes to;
//  - a caller that only needs some pixels says which (`need`), and one that
//    only needs the verdict byte says so (`verdictOnly`).

/** What the driver keeps of a simulation. The arrays past `mixed` are null in a verdict-only run. */
interface LeanOut {
  mixed: Uint8Array;
  majority: Uint8Array | null;
  purity: Float32Array | null;
  proportionA: Float32Array | null;
  proportionBare: Float32Array | null;
  species: Float32Array | null;
  offTrial: Float32Array | null;
}

/**
 * Phase 1 of `aggregate` for the grid the driver hands it: no rotation, a fine
 * grid that is a whole number of cells per pixel, no series. All sixteen
 * sub-samples of a fine cell land on that cell, so a cell counts for sixteen at
 * once. The pairs come out in first-seen order, as `aggregate` leaves them.
 */
function sampledCovers(cropMap: Uint8Array, ny: number, nx: number, g: number): PixelCovers {
  const cells = ny * nx, cols = nx * g, SS = 16;
  const pairStart = new Int32Array(cells + 1);
  let pairCap = cells + 16;
  let pairSlot = new Int32Array(pairCap);
  let pairW = new Float64Array(pairCap);
  let pairLen = 0;
  const cnt = new Float64Array(256), ord = new Int32Array(256);
  for (let gr = 0; gr < ny; gr++) {
    for (let gc = 0; gc < nx; gc++) {
      let n = 0, runId = 0, run = 0;
      for (let sy = 0; sy < g; sy++) {
        const rowBase = (gr * g + sy) * cols + gc * g;
        for (let sx = 0; sx < g; sx++) {
          const id = cropMap[rowBase + sx];
          if (id === runId) { run += SS; continue; }
          if (run > 0) { if (cnt[runId] === 0) ord[n++] = runId; cnt[runId] += run; }
          runId = id;
          run = SS;
        }
      }
      if (run > 0) { if (cnt[runId] === 0) ord[n++] = runId; cnt[runId] += run; }
      if (pairLen + n > pairCap) {
        pairCap = Math.max(pairCap * 2, pairLen + n);
        const nextSlot = new Int32Array(pairCap); nextSlot.set(pairSlot); pairSlot = nextSlot;
        const nextW = new Float64Array(pairCap); nextW.set(pairW); pairW = nextW;
      }
      pairStart[gr * nx + gc] = pairLen;
      for (let i = 0; i < n; i++) {
        const slot = ord[i];
        pairSlot[pairLen] = slot;
        pairW[pairLen++] = cnt[slot];
        cnt[slot] = 0;
      }
    }
  }
  pairStart[cells] = pairLen;
  return { T: 0, means: [], hasValid: new Uint8Array(0), pairStart, pairSlot, pairW,
           slots: { cnt, ord, keys: [], index: new Map() } };
}

/**
 * 1 for each pixel whose kernel window, cut at the grid's edge, holds one cover
 * and nothing else: every pixel in it is a single cover (`one`), the same one.
 * Two passes of runs, along the rows and then down the columns.
 */
function uniformWindows(one: Int16Array, rows: number, cols: number, wx: number, wy: number): Uint8Array {
  const rowOk = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let c = 0;
    while (c < cols) {
      const s = one[base + c];
      let e = c + 1;
      while (e < cols && one[base + e] === s) e++;
      if (s >= 0) {
        for (let q = c; q < e; q++) {
          const c0 = q - wx < 0 ? 0 : q - wx, c1 = q + wx > cols - 1 ? cols - 1 : q + wx;
          if (c0 >= c && c1 < e) rowOk[base + q] = 1;
        }
      }
      c = e;
    }
  }
  const flat = new Uint8Array(rows * cols);
  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows) {
      const k = r * cols + c;
      if (!rowOk[k]) { r++; continue; }
      const s = one[k];
      let e = r + 1;
      while (e < rows && rowOk[e * cols + c] && one[e * cols + c] === s) e++;
      for (let q = r; q < e; q++) {
        const r0 = q - wy < 0 ? 0 : q - wy, r1 = q + wy > rows - 1 ? rows - 1 : q + wy;
        if (r0 >= r && r1 < e) flat[q * cols + c] = 1;
      }
      r = e;
    }
  }
  return flat;
}

/**
 * Phase 2 for the driver: `resolvePixels` with no series, the outside weighed
 * in, and plain numbers for the blur. Each sum is the one resolvePixels makes,
 * term for term and in its order; see the banner above for what is left out.
 *
 * `need`, when given, marks the pixels to answer for: the others are written
 * MIXED and nothing else, a verdict no caller can mistake for a pure pixel.
 */
function leanResolve(
  pc: PixelCovers, rowsAgg: number, colsAgg: number, nSp: number,
  sigmaX: number, sigmaY: number, mixThreshold: number, offX: number, offY: number,
  coverSpecies: Uint8Array | null, need: ArrayLike<number> | null, verdictOnly: boolean,
): LeanOut {
  const cells = rowsAgg * colsAgg;
  const { pairStart, pairSlot, pairW, slots } = pc;
  const keys = slots.keys;
  const full = !verdictOnly;
  const mixed = new Uint8Array(cells);
  const majority = full ? new Uint8Array(cells) : null;
  const purity = full ? new Float32Array(cells) : null;
  const proportionA = full ? new Float32Array(cells) : null;
  const proportionBare = full ? new Float32Array(cells) : null;
  const species = full && nSp > 0 ? new Float32Array(cells * nSp) : null;
  const offTrial = full && nSp > 0 ? new Float32Array(cells) : null;
  const spScratch = new Float64Array(Math.max(1, nSp));

  const windowX = Math.max(0, Math.ceil(3 * sigmaX + Math.abs(offX)));
  const windowY = Math.max(0, Math.ceil(3 * sigmaY + Math.abs(offY)));
  /**
   * NO WINDOW AT ALL, which is every call the page makes now: a spot's shares
   * come already blurred (spotCovers) and a sensor with no blur has nothing to
   * weigh in. A pixel is then classified from its own pairs and nothing else,
   * and none of what follows is needed to do it: no kernel, no table of runs,
   * no search for windows of one cover, no scratch to copy the pairs into and
   * read them back from. The same sums of the same numbers in the same order
   * as the general path below gives with a kernel of one weight of 1, bit for
   * bit (the suite compares them); it was a tenth of a simulation.
   */
  if (windowX === 0 && windowY === 0 && offX === 0 && offY === 0) {
    const pureOff = 1 < mixThreshold;
    for (let idx = 0; idx < cells; idx++) {
      if (need && !need[idx]) { mixed[idx] = MIXED; continue; }
      const p0 = pairStart[idx], p1 = pairStart[idx + 1];
      if (p1 - p0 === 1 && pairSlot[p0] < 256) {
        // One cover from edge to edge: its share is the whole, whatever its weight.
        const cover = pairSlot[p0];
        mixed[idx] = pureOff ? MIXED : cover;
        if (full) {
          majority![idx] = cover;
          purity![idx] = 1;
          if (cover === 0) proportionA![idx] = 1;
          if (cover === BARE.id) proportionBare![idx] = 1;
          if (species) {
            if (cover === OFF_TRIAL.id) offTrial![idx] = 1;
            else if (cover <= MAX_COVER) {
              const s = coverSpecies ? coverSpecies[cover] : cover;
              if (s < nSp) species[idx * nSp + s] = 1;
            }
          }
        }
        continue;
      }
      let dominantCrop = 0, maxWeight = 0, total = 0, wA = 0, wBare = 0, offW = 0, hasA = false, hasBare = false;
      if (species) spScratch.fill(0, 0, nSp);
      for (let p = p0; p < p1; p++) {
        const slot = pairSlot[p], w = pairW[p];
        const coverId = slot < 256 ? slot : keys[slot - 256];
        total += w;
        if (w > maxWeight) { maxWeight = w; dominantCrop = coverId; }
        if (!full) continue;
        if (slot === 0) { wA = w; hasA = true; }
        if (slot === BARE.id) { wBare = w; hasBare = true; }
        if (species) {
          if (coverId === OFF_TRIAL.id) offW += w;
          else if (coverId <= MAX_COVER) {
            const s = coverSpecies ? coverSpecies[coverId] : coverId;
            if (s < nSp) spScratch[s] += w;
          }
        }
      }
      mixed[idx] = total > 0 && maxWeight / total < mixThreshold ? MIXED : dominantCrop;
      if (!full) continue;
      if (species) {
        const base = idx * nSp;
        if (total > 0) for (let s = 0; s < nSp; s++) species[base + s] = spScratch[s] / total;
        offTrial![idx] = total > 0 ? offW / total : 0;
      }
      majority![idx] = dominantCrop;
      purity![idx] = total > 0 ? maxWeight / total : 0;
      proportionA![idx] = total > 0 ? (hasA ? wA || 0 : 0) / total : 0;
      proportionBare![idx] = total > 0 ? (hasBare ? wBare || 0 : 0) / total : 0;
    }
    return { mixed, majority, purity, proportionA, proportionBare, species, offTrial };
  }
  const eY = Math.min(windowY, rowsAgg - 1);
  const eX = Math.min(windowX, colsAgg - 1);
  const kW = 2 * eX + 1;
  const kernel = new Float64Array((2 * eY + 1) * kW);
  for (let i = 0; i <= 2 * eY; i++) {
    for (let j = 0; j <= 2 * eX; j++) {
      const dy = i - eY - offY;
      const dx = j - eX - offX;
      kernel[i * kW + j] = Math.exp(-0.5 * ((dx / (sigmaX || 0.5)) ** 2 + (dy / (sigmaY || 0.5)) ** 2));
    }
  }

  // The pixels that are one cover from edge to edge, which is most of them:
  // their one (slot, weight) pair is read from two flat arrays, not through the
  // pair list. A slot past the byte range is left to the pair list.
  const one = new Int16Array(cells);
  const oneW = new Float64Array(cells);
  for (let k = 0; k < cells; k++) {
    const p = pairStart[k];
    if (pairStart[k + 1] - p === 1 && pairSlot[p] < 256) { one[k] = pairSlot[p]; oneW[k] = pairW[p]; }
    else one[k] = -1;
  }
  // A window of one cover sums to that cover's weight alone, and every share is
  // then w / w or 0 / w: no sum is needed to know them. Only where w cannot be
  // 0, which the pixel's own weight guarantees when the kernel is not pushed so
  // far off centre that it underflows there.
  const flat = kernel[eY * kW + eX] > 0 ? uniformWindows(one, rowsAgg, colsAgg, windowX, windowY) : null;
  const sharpMixed = 1 < mixThreshold;
  // run[k]: how many pixels from k on, along its row, are that same single
  // cover with that same weight (0 when k is not a single cover). Inside a plot
  // that is every pixel of a window's row, and the sum over them is then one
  // table read and one addition each, kept in a register instead of written to
  // the slot's cell and read back. A lower bound is enough, so it stops at 65535.
  const run = new Uint16Array(cells);
  for (let r = 0; r < rowsAgg; r++) {
    for (let k = (r + 1) * colsAgg - 1, first = r * colsAgg, next = 0; k >= first; k--) {
      if (one[k] < 0) { next = 0; continue; }
      next = next > 0 && one[k + 1] === one[k] && oneW[k + 1] === oneW[k] ? Math.min(65535, next + 1) : 1;
      run[k] = next;
    }
  }

  const nSlots = slots.cnt.length;
  const fin = new Float64Array(nSlots);
  const seen = new Int32Array(nSlots);
  const finOrd = new Int32Array(nSlots);

  for (let gr = 0; gr < rowsAgg; gr++) {
    const r0 = Math.max(0, gr - windowY);
    const r1 = Math.min(rowsAgg - 1, gr + windowY);
    for (let gc = 0; gc < colsAgg; gc++) {
      const idx = gr * colsAgg + gc;
      if (need && !need[idx]) { mixed[idx] = MIXED; continue; }

      if (flat && flat[idx]) {
        const cover = one[idx];
        mixed[idx] = sharpMixed ? MIXED : cover;
        if (full) {
          majority![idx] = cover;
          purity![idx] = 1;
          if (cover === 0) proportionA![idx] = 1;
          if (cover === BARE.id) proportionBare![idx] = 1;
          if (species) {
            if (cover === OFF_TRIAL.id) offTrial![idx] = 1;
            else if (cover <= MAX_COVER) {
              const s = coverSpecies ? coverSpecies[cover] : cover;
              if (s < nSp) species[idx * nSp + s] = 1;
            }
          }
        }
        continue;
      }

      // Each cover's weight is the sum resolvePixels makes: its terms, in raster
      // order, added one at a time from 0. `sum` is the running total of the
      // cover in hand (`cur`), written to its cell only when another cover
      // takes over. resolvePixels reads the total as `fin || 0`, which changes
      // nothing here: every term is a finite weight times a finite, positive
      // share, so a total is never NaN nor a negative zero.
      const stamp = idx + 1;
      let n = 0, cur = -1, sum = 0;
      const c0 = Math.max(0, gc - windowX);
      const c1 = Math.min(colsAgg - 1, gc + windowX);
      for (let nr = r0; nr <= r1; nr++) {
        const kRow = (nr - gr + eY) * kW + eX - gc;
        const rowBase = nr * colsAgg;
        let nc = c0;
        while (nc <= c1) {
          const nIdx = rowBase + nc;
          const len = run[nIdx];
          if (len > 0) {
            const s1 = one[nIdx];
            if (s1 !== cur) {
              if (cur >= 0) fin[cur] = sum;
              if (seen[s1] !== stamp) { seen[s1] = stamp; finOrd[n++] = s1; sum = 0; } else sum = fin[s1];
              cur = s1;
            }
            const w1 = oneW[nIdx];
            const end = nc + len - 1 < c1 ? nc + len - 1 : c1;
            for (let q = kRow + nc, qEnd = kRow + end; q <= qEnd; q++) sum += w1 * kernel[q];
            nc = end + 1;
          } else {
            const weight = kernel[kRow + nc];
            const pEnd = pairStart[nIdx + 1];
            for (let p = pairStart[nIdx]; p < pEnd; p++) {
              const slot = pairSlot[p];
              if (slot !== cur) {
                if (cur >= 0) fin[cur] = sum;
                if (seen[slot] !== stamp) { seen[slot] = stamp; finOrd[n++] = slot; sum = 0; } else sum = fin[slot];
                cur = slot;
              }
              sum += pairW[p] * weight;
            }
            nc++;
          }
        }
      }
      if (cur >= 0) fin[cur] = sum;

      let dominantCrop = 0;
      let maxWeight = 0;
      let totalCropWeight = 0;
      for (let i = 0; i < n; i++) {
        const slot = finOrd[i];
        const w = fin[slot];
        totalCropWeight += w;
        if (w > maxWeight) { maxWeight = w; dominantCrop = slot < 256 ? slot : keys[slot - 256]; }
      }
      const isMixed = totalCropWeight > 0 && maxWeight / totalCropWeight < mixThreshold;
      mixed[idx] = isMixed ? MIXED : dominantCrop;
      if (!full) continue;

      if (species) {
        const base = idx * nSp;
        let offW = 0;
        spScratch.fill(0, 0, nSp);
        for (let i = 0; i < n; i++) {
          const slot = finOrd[i];
          const coverId = slot < 256 ? slot : keys[slot - 256];
          const w = fin[slot];
          if (coverId === OFF_TRIAL.id) { offW += w; continue; }
          if (coverId > MAX_COVER) continue;                 // BARE
          const s = coverSpecies ? coverSpecies[coverId] : coverId;
          if (s < nSp) spScratch[s] += w;
        }
        if (totalCropWeight > 0) for (let s = 0; s < nSp; s++) species[base + s] = spScratch[s] / totalCropWeight;
        offTrial![idx] = totalCropWeight > 0 ? offW / totalCropWeight : 0;
      }
      majority![idx] = dominantCrop;
      purity![idx] = totalCropWeight > 0 ? maxWeight / totalCropWeight : 0;
      proportionA![idx] = totalCropWeight > 0 ? (seen[0] === stamp ? fin[0] || 0 : 0) / totalCropWeight : 0;
      proportionBare![idx] = totalCropWeight > 0 ? (seen[BARE.id] === stamp ? fin[BARE.id] || 0 : 0) / totalCropWeight : 0;
    }
  }
  return { mixed, majority, purity, proportionA, proportionBare, species, offTrial };
}

/**
 * The driver's simulation of a grid, or null when it is not the plain case
 * written above (a blur that is not a finite number, an extent with no pixel):
 * the caller then goes through `aggregate`, which is defined for anything.
 */
function leanAggregate(
  grid: S2Grid, patternOrigin: [number, number], layout: SimLayout, sensor: SensorParams,
  need: ArrayLike<number> | null, verdictOnly: boolean,
): LeanOut | null {
  const { sigmaX, sigmaY } = sensor;
  const offX = sensor.offX ?? 0, offY = sensor.offY ?? 0;
  if (!Number.isFinite(sigmaX) || !Number.isFinite(sigmaY) || !Number.isFinite(offX) || !Number.isFinite(offY)) return null;
  if (typeof sigmaX !== 'number' || typeof sigmaY !== 'number' || typeof offX !== 'number' || typeof offY !== 'number') return null;
  const res = grid.res;
  const [minE, minN, maxE, maxN] = grid.utmBounds;
  const nx = Math.round((maxE - minE) / res);
  const ny = Math.round((maxN - minN) / res);
  if (!(nx >= 1) || !(ny >= 1) || !Number.isFinite(nx * ny)) return null;
  const { coverSpecies, nSpecies } = speciesChannel(layout);
  // A blur that is a spot: the note's model. Phase 1 hands over each pixel's
  // shares as the spot has them, and phase 2 is left nothing to blur (and no
  // pixel is blind: a spot reads the ground wherever it is).
  if (followsSpot(sensor)) {
    const spot = spotCovers(layout, patternOrigin, minE, minN, nx, ny, res, sensor, need);
    return leanResolve(spot, ny, nx, Math.max(0, nSpecies | 0), 0, 0, sensor.mixThreshold, 0, 0, coverSpecies, need, verdictOnly);
  }
  const imported = importedOf(layout);
  let pc: PixelCovers;
  if (imported) {
    pc = importedPixelCovers(imported, minE, minN, nx, ny, res).pc;
  } else {
    const g = strideFor(res, minFeatureM(layout));
    const cropMap = buildCropMap(minE, minN, ny * g, nx * g, res / g, patternOrigin[0], patternOrigin[1], layout);
    pc = sampledCovers(cropMap, ny, nx, g);
  }
  const out = leanResolve(pc, ny, nx, Math.max(0, nSpecies | 0), sigmaX, sigmaY, sensor.mixThreshold, offX, offY, coverSpecies, need, verdictOnly);
  const blind = psfBlindPixels(ny, nx, sensor);
  if (blind) {
    for (let k = 0; k < blind.length; k++) {
      if (!blind[k]) continue;
      out.mixed[k] = OFF_TRIAL.id;
      if (out.offTrial) out.offTrial[k] = 1;
    }
  }
  return out;
}

/**
 * The verdict byte of each pixel of a grid and nothing else: MIXED, a sentinel,
 * or the cover the pixel is pure for. It is `simulateField(...).mixed`, for the
 * callers that read no other array (a placement search counting pure pixels,
 * the pixels that hold under a shift).
 *
 * With `need`, only the pixels it marks are answered for, and the others read
 * MIXED: a pixel's verdict comes from the ground around it and from nothing
 * about its neighbours' verdicts, so the ones asked for are exactly what a
 * simulation of the whole grid gives them.
 */
export function fieldVerdicts(
  grid: S2Grid, patternOrigin: [number, number], layout: SimLayout, sensor: SensorParams, need: ArrayLike<number> | null = null,
): Uint8Array {
  const lean = leanAggregate(grid, patternOrigin, layout, sensor, need, true);
  return lean ? lean.mixed : simulateFieldReference(grid, patternOrigin, layout, sensor).mixed;
}

/**
 * The per-pixel arrays of a simulation and none of its totals, for a caller
 * that keeps some pixels of a grid and counts on those itself (a row of the
 * satellites table: the pixels on the trial's own outline, about half of a
 * turned trial's box). With `need`, only the pixels it marks are worked out,
 * and they are what a simulation of the whole grid gives them, bit for bit: a
 * pixel is read from the ground under its own spot and from nothing about its
 * neighbours. The others read mixed, and zero everywhere else.
 */
export function fieldShares(
  grid: S2Grid, patternOrigin: [number, number], layout: SimLayout, sensor: SensorParams, need: ArrayLike<number> | null = null,
): Pick<FieldSim, 'proportionA' | 'proportionBare' | 'mixed' | 'proportionBySpecies' | 'proportionOffTrial' | 'nSpecies'> {
  // A sensor with no blur but a kernel pushed off its pixel does read its neighbours (the repo engine's window): all of the grid then.
  const alone = followsSpot(sensor) || ((sensor.offX ?? 0) === 0 && (sensor.offY ?? 0) === 0);
  const lean = leanAggregate(grid, patternOrigin, layout, sensor, alone ? need : null, false);
  if (!lean) return simulateFieldReference(grid, patternOrigin, layout, sensor);
  return { proportionA: lean.proportionA!, proportionBare: lean.proportionBare!, mixed: lean.mixed,
           proportionBySpecies: lean.species, proportionOffTrial: lean.offTrial, nSpecies: speciesChannel(layout).nSpecies };
}

/**
 * Pure crop pixels in a set of verdicts: `simulateField(...).pureCrop` without
 * the simulation's other arrays. coverStats also leaves out a pixel more than
 * half off the trial, and such a pixel is never pure for a crop: the ground
 * outside outweighs any one cover in it, so its verdict is off-trial or mixed.
 */
export function pureVerdictCount(verdicts: ArrayLike<number>): number {
  let pure = 0;
  for (let k = 0; k < verdicts.length; k++) if (verdicts[k] <= MAX_COVER) pure++;
  return pure;
}

/** Run the engine over the real grid's sensor cells. */
export function simulateField(grid: S2Grid, patternOrigin: [number, number], layout: SimLayout, sensor: SensorParams): FieldSim {
  const lean = leanAggregate(grid, patternOrigin, layout, sensor, null, false);
  if (!lean) return simulateFieldReference(grid, patternOrigin, layout, sensor);
  const { coverSpecies, nSpecies } = speciesChannel(layout);
  const mixed = lean.mixed;
  const proportionA = lean.proportionA!;
  let sumP = 0;
  for (let k = 0; k < mixed.length; k++) sumP += proportionA[k];
  const st = coverStats({ mixed, coverSpecies, nSpecies, offTrial: lean.offTrial });
  return {
    proportionA, proportionBare: lean.proportionBare!, mixed,
    purity: lean.purity!, dominant: lean.majority!,
    purePct: st.purePct, pureCrop: st.pureCrop, pureBare: st.pureBare,
    total: st.total, meanPropA: mixed.length ? sumP / mixed.length : 0.5,
    nSpecies, pureBySpecies: st.pureBySpecies,
    meanBySpecies: meanPerSpecies(lean.species, nSpecies, mixed.length, lean.offTrial),
    proportionBySpecies: lean.species,
    proportionOffTrial: lean.offTrial,
    pureA: st.pureBySpecies[0], pureB: st.pureBySpecies[1],
  };
}

/**
 * The same simulation through `aggregate`, as the driver ran it before it had a
 * path of its own. What simulateField must equal, array for array (the suite
 * compares them), and what it falls back to outside the plain case.
 */
export function simulateFieldReference(grid: S2Grid, patternOrigin: [number, number], layout: SimLayout, sensor: SensorParams): FieldSim {
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
    purity: agg.cropMapPurity, dominant: agg.cropMapMajority,
    purePct: st.purePct, pureCrop: st.pureCrop, pureBare: st.pureBare,
    total: st.total, meanPropA: mixed.length ? sumP / mixed.length : 0.5,
    nSpecies, pureBySpecies: st.pureBySpecies,
    meanBySpecies: meanPerSpecies(agg.cropMapSpecies, nSpecies, mixed.length, agg.cropMapProportionOffTrial),
    proportionBySpecies: agg.cropMapSpecies,
    proportionOffTrial: agg.cropMapProportionOffTrial,
    pureA: st.pureBySpecies[0], pureB: st.pureBySpecies[1],
  };
}

/**
 * Every `stride`-th pixel of a simulation, on both axes, in the order
 * buildS2Grid's `stride` option produces its cells.
 *
 * simulateField answers for a whole rectangle, because that is what the PSF
 * needs to sweep; a strided grid keeps one pixel in `stride` squared of it.
 * The two orders have to be derived from one statement of the rule or the
 * chart reads a neighbour's season for every point, so this is that statement,
 * and the grid builder's loop is written to match it.
 *
 * Purity is recomputed over the sample rather than carried across from the
 * whole: it is the sample's own figure, and the panel says it is a sample.
 */
export function strideFieldSim(
  sim: FieldSim, nx: number, ny: number, stride: number, layout: SimLayout,
): FieldSim {
  const step = Math.max(1, Math.floor(stride));
  if (step === 1) return sim;
  const keep: number[] = [];
  for (let j = 0; j < ny; j += step) for (let i = 0; i < nx; i += step) keep.push(j * nx + i);
  const n = keep.length, nSp = sim.nSpecies;
  const proportionA = Float32Array.from(keep, k => sim.proportionA[k]);
  const proportionBare = Float32Array.from(keep, k => sim.proportionBare[k]);
  const mixed = Uint8Array.from(keep, k => sim.mixed[k]);
  const offTrial = sim.proportionOffTrial ? Float32Array.from(keep, k => sim.proportionOffTrial![k]) : null;
  let bySpecies: Float32Array | null = null;
  if (sim.proportionBySpecies) {
    bySpecies = new Float32Array(n * nSp);
    for (let j = 0; j < n; j++) for (let sIdx = 0; sIdx < nSp; sIdx++) bySpecies[j * nSp + sIdx] = sim.proportionBySpecies[keep[j] * nSp + sIdx];
  }
  const { coverSpecies } = speciesChannel(layout);
  const st = coverStats({ mixed, coverSpecies, nSpecies: nSp, offTrial });
  let sumP = 0;
  for (let k = 0; k < n; k++) sumP += proportionA[k];
  return {
    proportionA, proportionBare, mixed,
    purePct: st.purePct, pureCrop: st.pureCrop, pureBare: st.pureBare, total: st.total,
    meanPropA: n ? sumP / n : 0.5,
    nSpecies: nSp, pureBySpecies: st.pureBySpecies,
    meanBySpecies: meanPerSpecies(bySpecies, nSp, n, offTrial),
    proportionBySpecies: bySpecies,
    proportionOffTrial: offTrial,
    pureA: st.pureBySpecies[0], pureB: st.pureBySpecies[1],
  };
}

/**
 * Where a geolocation error can put the imagery, as sub-pixel offsets to measure
 * the design at.
 *
 * A product's pixels are not exactly where its coordinates say: Sentinel-2 is
 * good to a few metres, which at these pixel sizes is a large part of one pixel.
 * The design cannot be moved to compensate, because nobody knows the offset when
 * the trial is planted, so the honest question is not "how pure is this" but
 * "how pure is this whatever the offset turns out to be".
 *
 * Purity is PERIODIC in the offset with the pixel size: shifting the ground by
 * exactly one pixel reproduces the same geometry against the lattice. So one
 * unit cell holds every distinct case, and an error of half a pixel or more can
 * already land anywhere in it. That is why the window is clamped to res/2: past
 * that the samples would repeat themselves and cost time saying nothing new.
 */
export interface GeoSpreadInfo {
  best: number; median: number; worst: number;
  /** best minus worst, in percentage points: how much of the purity is luck. */
  spread: number;
  samples: number;
  /** The uncertainty it was measured over, so a caller cannot mislabel it. */
  radiusM: number;
  /**
   * True when the uncertainty reaches half a pixel or more, so the offset can
   * put the design anywhere against the lattice and the range is simply the
   * full one. Past that point a bigger number changes nothing, and saying
   * "up to 10 m off" would imply it did.
   */
  anyPhase: boolean;
}

export function shiftSamples(radiusM: number, res: number, n = 4): [number, number][] {
  const r = Math.min(Math.max(0, radiusM), res / 2);
  if (!(r > 0) || n < 1) return [[0, 0]];
  // At or past half a pixel the offset reaches every phase, so the sample is
  // the whole unit cell, corners included. Below it, the offset is genuinely
  // bounded and the reachable set is a DISC, not the square around it: keeping
  // the corners there would report a spread from offsets that cannot happen.
  const anyPhase = radiusM >= res / 2;
  /**
   * Zero is always one of the samples, because it is always a possible outcome:
   * the imagery may land exactly where it says. Without it the range could
   * exclude the very number printed beside it, and an even grid never contains
   * its own centre, so the card read "50%" above "52% to 57%".
   */
  const out: [number, number][] = [[0, 0]];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Cell CENTRES of an n x n grid over [-r, r]^2, so no sample sits on the
      // edge and the set is symmetric about zero.
      const dx = -r + (2 * r * (i + 0.5)) / n;
      const dy = -r + (2 * r * (j + 0.5)) / n;
      if (Math.hypot(dx, dy) < 1e-9) continue;   // the centre is already in
      if (anyPhase || Math.hypot(dx, dy) <= radiusM + 1e-9) out.push([dx, dy]);
    }
  }
  return out.length ? out : [[0, 0]];
}

/**
 * What the design's purity does across those offsets: the best case, the middle
 * and the worst.
 *
 * Each sample MOVES THE TRIAL under a fixed lattice, which is the same relative
 * displacement as the imagery landing somewhere else and keeps the measured
 * window exactly where it was.
 *
 * It used to displace the PSF centre instead, and this comment claimed that was
 * the same measurement, "to about 0.2 points". That held for the one design it
 * was checked on and does not hold in general. Moving the kernel REWEIGHTS
 * whole neighbouring pixels; moving the trial moves the plot edges across the
 * pixel boundaries, and no reweighting can express that. Measured on a 20 x 40 m
 * plot design at 3 m over a FIXED window, the two agree exactly at WHOLE
 * pixels, a whole-pixel shift being a relabelling of the same configuration,
 * and differ by up to 100 pure pixels in 1,100 in between. That is precisely
 * the sub-pixel range a geolocation error lives in, and checking only round
 * offsets is what made the two methods look interchangeable.
 *
 * Moving the grid's bounds instead is a third thing and a worse one: it slides
 * the measurement window over the field as well, so the pixel count changes for
 * a reason that has nothing to do with the phase. An imported trial carries
 * absolute coordinates rather than an origin, so for that one the bounds are
 * what must move, and the window shift is sub-pixel against a whole field.
 *
 * Scored with the SAME share the page's headline uses, pure pixels over the
 * crop the design plants, not over trial pixels. A range in one currency
 * printed directly beneath a headline in another is how the purity tab came to
 * read 47% under a ladder reading 62% for the same pure pixels.
 *
 * `spread` is the number worth reading. A design whose purity swings ten points
 * on where the imagery happens to land is a fragile design, however good its
 * best case looks, and the best case is what every other figure on the page
 * reports.
 */
export function geolocationSpread(
  grid: S2Grid, patternOrigin: [number, number], layout: SimLayout, sensor: SensorParams,
  radiusM: number, n = 4,
): GeoSpreadInfo | null {
  const shifts = shiftSamples(radiusM, grid.res, n);
  if (shifts.length < 2) return null;
  const { coverSpecies, nSpecies } = speciesChannel(layout);
  const [gw, gs, ge, gn] = grid.utmBounds;
  /**
   * The design's own planted area does not move when the lattice does, so every
   * sample is a share of the same thing. Null for a periodic pattern, which has
   * no trial distinct from the ground it covers; the crop the simulation can
   * see is summed instead.
   */
  const planted = plantedAreaPx(layout, grid.res);
  const vals: number[] = [];
  const imported = layout.pattern === 'imported';
  for (const [dx, dy] of shifts) {
    // The trial moves by -d under a fixed lattice, which is the lattice moving
    // by +d. An imported plan has no origin to move, so there the grid does.
    const movedGrid = imported
      ? { ...grid, utmBounds: [gw + dx, gs + dy, ge + dx, gn + dy] as [number, number, number, number] }
      : grid;
    const movedOrigin: [number, number] = imported
      ? patternOrigin
      : [patternOrigin[0] - dx, patternOrigin[1] - dy];
    const sim = simulateField(movedGrid, movedOrigin, layout, sensor);
    const st = coverStats({ mixed: sim.mixed, coverSpecies, nSpecies, offTrial: sim.proportionOffTrial });
    let denom = planted ?? 0;
    if (!(denom >= 1) && sim.proportionBySpecies) {
      denom = 0;
      for (let k = 0; k < sim.mixed.length; k++) for (let x = 0; x < sim.nSpecies; x++) denom += sim.proportionBySpecies[k * sim.nSpecies + x];
    }
    vals.push(denom >= 1 ? Math.max(0, Math.min(100, (100 * st.pureCrop) / denom)) : 0);
  }
  vals.sort((a, b) => a - b);
  const worst = vals[0], best = vals[vals.length - 1];
  const mid = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  return { best, median: mid, worst, spread: best - worst, samples: vals.length, radiusM,
           anyPhase: radiusM >= grid.res / 2 };
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
 * Where one pixel's signal lands, cover by cover: what its purity is made of.
 */
export interface PixelSources {
  /**
   * What the signal lands on, largest share first: a cover id (a plot or a
   * species, BARE.id, OFF_TRIAL.id) and its share of the signal. The shares add
   * up to 1 and the first one IS the pixel's purity.
   */
  covers: { id: number; share: number }[];
  /**
   * The same signal as dots of equal weight, for the map: where each one sits
   * (metres of the grid's CRS) and the cover under it.
   */
  dotE: Float64Array;
  dotN: Float64Array;
  dotCover: Uint8Array;
  /** Ground between two dots where they are densest, in metres. */
  spacingM: number;
}

// The R2 sequence: additive, so any run of it is spread as evenly as its start.
const R2_A = 0.7548776662466927, R2_B = 0.5698402909980532;

/**
 * `pixelSources` under the note's model (a blur that is a spot): the shares are
 * the spot's own, the ones `simulateField` classifies the pixel by, and the
 * dots are the spot itself, drawn where it puts its weight. Each dot stands at
 * an equal-probability point of the Gaussian (an evenly spread sequence, read
 * through the normal law's quantiles), so they thin out from the pixel's
 * centre the way the signal does, with nothing cut at a pixel's edge.
 */
function spotSources(
  pixelW: number, pixelS: number, res: number, patternOrigin: [number, number], layout: SimLayout, sensor: SensorParams, nDots: number,
): PixelSources | null {
  const pc = spotCovers(layout, patternOrigin, pixelW, pixelS, 1, 1, res, sensor, null);
  const covers: { id: number; share: number }[] = [];
  let total = 0;
  for (let q = pc.pairStart[0]; q < pc.pairStart[1]; q++) total += pc.pairW[q];
  if (!(total > 0)) return null;
  for (let q = pc.pairStart[0]; q < pc.pairStart[1]; q++) covers.push({ id: pc.pairSlot[q], share: pc.pairW[q] / total });
  covers.sort((a, b) => b.share - a.share);    // stable: a tie keeps the engine's order

  const n = Math.max(0, Math.floor(nDots));
  const sx = spotSigma(sensor.sigmaX) * res, sy = spotSigma(sensor.sigmaY) * res;
  const cE = pixelW + (0.5 + (sensor.offX ?? 0)) * res, cN = pixelS + (0.5 + (sensor.offY ?? 0)) * res;
  const dotE = new Float64Array(n), dotN = new Float64Array(n), dotCover = new Uint8Array(n);
  for (let m = 0; m < n; m++) {
    const E = cE + sx * probit((0.5 + m * R2_A) % 1), N = cN + sy * probit((0.5 + m * R2_B) % 1);
    dotE[m] = E;
    dotN[m] = N;
    dotCover[m] = cultureAt(E, N, layout, patternOrigin[0], patternOrigin[1]);
  }
  // Where the dots are densest, at the spot's centre: n dots at a density of 1 / (2 pi sx sy) there.
  return { covers, dotE, dotN, dotCover, spacingM: n > 0 ? Math.sqrt((2 * Math.PI * sx * sy) / n) : res };
}

/**
 * The arithmetic of `aggregate` and `aggregateImported` for ONE pixel, with
 * the covers kept apart instead of folded into the largest of them: phase 1
 * over the pixels its PSF window reaches (exact areas on an imported trial,
 * the fine grid on every other layout), then the window's weights. The same
 * window, the same bounds (the PSF does not reach past the grid), the same
 * weight expression and the same order, so the first share is the purity
 * `simulateField` gives that pixel and its cover the dominant one, ties
 * included. Suite section H28 holds the two together.
 *
 * The dots are a picture of those shares, not the shares themselves. Each
 * pixel of the window gets dots in proportion to its weight (largest
 * remainder, so they add up to `nDots`), spread evenly over its own square,
 * which is how the engine reads it: one weight per neighbouring pixel, and
 * inside a pixel every square metre counts the same. A dot takes the cover
 * found under it, so counting the dots of a cover lands within a few dots of
 * its share and never exactly on it. Print the shares.
 *
 * `i` and `j` are the pixel's column and row in the grid, from its south-west
 * corner. Null for a pixel that is not in the grid, or whose PSF puts no
 * weight on it at all (see psfBlindPixels).
 */
export function pixelSources(
  grid: Pick<S2Grid, 'res' | 'utmBounds'>, patternOrigin: [number, number], layout: SimLayout, sensor: SensorParams,
  i: number, j: number, nDots = 1000,
): PixelSources | null {
  const res = grid.res;
  const [minE, minN, maxE, maxN] = grid.utmBounds;
  const nx = Math.round((maxE - minE) / res), ny = Math.round((maxN - minN) / res);
  if (!(Number.isInteger(i) && Number.isInteger(j) && i >= 0 && i < nx && j >= 0 && j < ny)) return null;
  if (followsSpot(sensor)) return spotSources(minE + i * res, minN + j * res, res, patternOrigin, layout, sensor, nDots);
  const { sigmaX, sigmaY } = sensor;
  const offX = sensor.offX ?? 0, offY = sensor.offY ?? 0;
  const windowX = Math.max(0, Math.ceil(3 * sigmaX + Math.abs(offX)));
  const windowY = Math.max(0, Math.ceil(3 * sigmaY + Math.abs(offY)));
  const c0 = Math.max(0, i - windowX), c1 = Math.min(nx - 1, i + windowX);
  const r0 = Math.max(0, j - windowY), r1 = Math.min(ny - 1, j + windowY);
  const wx = c1 - c0 + 1, wy = r1 - r0 + 1;
  const wE = minE + c0 * res, wN = minN + r0 * res;

  const kernel = new Float64Array(wx * wy);
  let kSum = 0;
  for (let jj = 0; jj < wy; jj++) {
    for (let ii = 0; ii < wx; ii++) {
      const dy = r0 + jj - j - offY;
      const dx = c0 + ii - i - offX;
      const w = Math.exp(-0.5 * ((dx / (sigmaX || 0.5)) ** 2 + (dy / (sigmaY || 0.5)) ** 2));
      kernel[jj * wx + ii] = w;
      kSum += w;
    }
  }
  if (!(kSum > 0)) return null;

  // Covers in the order the engine first meets them, which is what settles a
  // tie between two shares there.
  const fin = new Float64Array(256);
  const met = new Uint8Array(256);
  const order: number[] = [];
  const add = (id: number, w: number) => { if (!met[id]) { met[id] = 1; order.push(id); } fin[id] += w; };
  const imported = importedOf(layout);
  if (imported) {
    const { pc } = importedPixelCovers(imported, wE, wN, wx, wy, res);
    for (let k = 0; k < wx * wy; k++) {
      for (let p = pc.pairStart[k]; p < pc.pairStart[k + 1]; p++) add(pc.pairSlot[p], pc.pairW[p] * kernel[k]);
    }
  } else {
    const g = strideFor(res, minFeatureM(layout));
    const cols = wx * g;
    const map = buildCropMap(wE, wN, wy * g, cols, res / g, patternOrigin[0], patternOrigin[1], layout);
    const tally = new Float64Array(256);
    const first: number[] = [];
    for (let jj = 0; jj < wy; jj++) {
      for (let ii = 0; ii < wx; ii++) {
        first.length = 0;
        for (let sy = 0; sy < g; sy++) {
          const rowBase = (jj * g + sy) * cols + ii * g;
          for (let sx = 0; sx < g; sx++) {
            const id = map[rowBase + sx];
            if (tally[id] === 0) first.push(id);
            tally[id]++;
          }
        }
        const w = kernel[jj * wx + ii];
        for (const id of first) { add(id, tally[id] * w); tally[id] = 0; }
      }
    }
  }
  let total = 0;
  for (const id of order) total += fin[id];
  if (!(total > 0)) return null;
  const covers = order.filter(id => fin[id] > 0).map(id => ({ id, share: fin[id] / total }));
  covers.sort((a, b) => b.share - a.share);    // stable: a tie keeps the engine's order

  const n = Math.max(0, Math.floor(nDots));
  const count = new Int32Array(wx * wy);
  const rest: { k: number; f: number }[] = [];
  let given = 0;
  for (let k = 0; k < wx * wy; k++) {
    const q = (n * kernel[k]) / kSum;
    const whole = Math.floor(q);
    count[k] = whole;
    given += whole;
    rest.push({ k, f: q - whole });
  }
  rest.sort((a, b) => b.f - a.f || a.k - b.k);
  for (let t = 0; t < n - given && t < rest.length; t++) count[rest[t].k]++;

  const dotE = new Float64Array(n), dotN = new Float64Array(n), dotCover = new Uint8Array(n);
  let m = 0, densest = 0;
  for (let jj = 0; jj < wy; jj++) {
    for (let ii = 0; ii < wx; ii++) {
      const c = count[jj * wx + ii];
      if (c > densest) densest = c;
      for (let t = 0; t < c && m < n; t++, m++) {
        const E = wE + (ii + ((0.5 + m * R2_A) % 1)) * res;
        const N = wN + (jj + ((0.5 + m * R2_B) % 1)) * res;
        dotE[m] = E;
        dotN[m] = N;
        dotCover[m] = cultureAt(E, N, layout, patternOrigin[0], patternOrigin[1]);
      }
    }
  }
  return { covers, dotE, dotN, dotCover, spacingM: densest > 0 ? res / Math.sqrt(densest) : res };
}

/**
 * Find the pattern phase (origin shift, in metres) that maximises pure single-crop
 * pixels: i.e. slide the whole planting so strip edges land on pixel edges. Solved
 * 1D per striping axis against the real pixel lattice (exact when rows follow the
 * pixels; a good heuristic when rotated). Returns [du, dv] in the rotated
 * (along-row u, cross-row v) frame; add it to the pattern origin.
 */
/**
 * bestPhaseOffset scores every candidate with the engine itself, so it is cached
 * by argument: the resolution ladder calls it once per size, twice with "vs
 * aligned", with identical arguments, since rotation is not an input. The
 * sensor IS part of the key, because the answer depends on the blur (see below).
 */
const phaseCache = new Map<string, [number, number]>();
const PHASE_CACHE_MAX = 512;

export function bestPhaseOffset(
  pattern: PatternType, res: number, width: number, spacing: number, threshold: number, ox0: number, oy0: number,
  /**
   * The sensor the placement is being chosen FOR. Optional so the untyped JS
   * suites keep their positional call sites; absent, it is a sharp sensor at
   * `threshold`, which is exactly the old behaviour.
   */
  sensor?: SensorParams,
): [number, number] {
  // An imported trial sits where the file put it; there is no phase to slide.
  if (pattern === 'imported') return [0, 0];
  const sen: SensorParams = sensor ?? { sigmaX: 0, sigmaY: 0, mixThreshold: threshold, offX: 0, offY: 0 };
  const key = `${pattern}|${res}|${width}|${spacing}|${ox0}|${oy0}|${sen.sigmaX}|${sen.sigmaY}|${sen.mixThreshold}|${sen.offX ?? 0}|${sen.offY ?? 0}|${sen.anyPosition ? 1 : 0}|${sen.placeHeldM ?? 0}`;
  const hit = phaseCache.get(key);
  if (hit) return [hit[0], hit[1]]; // a copy: callers must never share the cached tuple
  const out = searchPhaseOffset(pattern, res, width, spacing, ox0, oy0, sen);
  if (phaseCache.size >= PHASE_CACHE_MAX) phaseCache.delete(phaseCache.keys().next().value as string);
  phaseCache.set(key, out);
  return [out[0], out[1]];
}

/** Candidate phases per axis. */
const STRIP_PHASE_STEPS = 48;
/**
 * The most pixels a candidate is counted over: along the striping axis of rows
 * or columns, and each way across a checkerboard (where the count is 2-D).
 */
const PHASE_SPAN_MAX = 240;
const PHASE_CHECKER_MAX = 64;
/** Phases per axis of a checkerboard's first, two-axis pass. */
const CHECKER_COARSE = 8;

/**
 * How many pixels a candidate phase is counted over along a striping axis: the
 * shortest stretch after which the pattern and the lattice line up again, so
 * that the count is the pattern's own density of pure pixels and not an accident
 * of where a window was cut. A period that is no simple fraction of the pixel
 * has no such stretch, and gets a few periods instead.
 */
function phaseSpanPx(period: number, res: number, cap: number): number {
  const ratio = period / res;
  for (let m = 1; m <= 16; m++) {
    const n = m * ratio, whole = Math.round(n);
    if (whole >= 1 && Math.abs(n - whole) < 1e-6) {
      let px = whole;
      while (px < 8) px += whole;
      return Math.min(cap, px);
    }
  }
  return Math.min(cap, Math.max(16, Math.round(4 * ratio)));
}

/**
 * Slide a periodic planting to the phase that yields the most PURE pixels
 * through the real sensor.
 *
 * This used to maximise a SHARP proxy, the mean dominant-crop coverage with no
 * blur and no threshold, on the reasoning that it "peaks only when strip edges
 * land exactly on pixel edges". That is true for a sharp sensor and backwards
 * for a blurred one. An edge on a pixel edge sits BETWEEN two pixels, so after
 * the blur both neighbours are contaminated; an edge through the middle of a
 * pixel sacrifices that one pixel and leaves its neighbours cleaner. Measured on
 * 3 m strips at 2 m pixels with the Sentinel-2 blur, the sharp optimum was the
 * blurred WORST: 30,660 sharp-pure pixels there against 10,290 blurred, where
 * the phase it rejected gave 20,370. It chose the bottom of the range at three
 * rungs of the ladder in four, which is how turning a strip trial onto the
 * pixel rows came to look worse than leaving it at 10 degrees.
 *
 * So each candidate is scored by the engine, on the pure count the page reports.
 *
 * WHAT IS SEARCHED. Sliding the planting by one whole pixel puts every edge
 * where its neighbour's was: the same picture, one pixel along. So the phases
 * worth trying lie within ONE PIXEL (or one period of the pattern, when that is
 * shorter), and the candidates are spread over that. They used to be spread
 * over a period of the pattern, which tries fewer and fewer sub-pixel positions
 * as the period grows: a period of 12 pixels tried 4 of them, and a period of
 * 48 pixels tried one, the shift it started from (found by an outside review,
 * 2026-11-22: 48 m rows at 1 m pixels kept 9024 pure pixels where half a pixel
 * further gives 9216).
 *
 * WHAT IS COUNTED. The pixels of a stretch after which pattern and lattice
 * line up again (phaseSpanPx), with the pattern's origin in its middle, inside
 * a margin as wide as the blur. The count used to run to the edge of a window
 * a few periods across, where the blur is cut off and a pixel reads cleaner
 * than it is, and where a window that held a strip more or less changed the
 * count by itself: on a checkerboard of 70 m cells under the Sentinel-2 blur it
 * settled on 1920 to 2016 pure pixels where the best phase gives 2079.
 *
 * A CHECKERBOARD varies both ways. A coarse pass over both axes at once comes
 * first, then one axis with the other held, then the other, then the first
 * again. The passes along one axis cannot start the search: with the other
 * axis where it happens to be, no pixel may be pure at any phase of the one
 * searched (cells of 3 pixels under the Sentinel-2 blur at 95 %, started half
 * a pixel off both ways: every candidate scored 0 on all three passes and the
 * trial stayed where it was, with no pure pixel, where a half-pixel move both
 * ways gives 11 %; found by an outside review, 2026-11-22).
 */
function searchPhaseOffset(
  pattern: PatternType, res: number, width: number, spacing: number, ox0: number, oy0: number,
  sensor: SensorParams,
): [number, number] {
  const P = width + Math.max(0, spacing);
  const vAxis = pattern === 'row' || pattern === 'strip-row-2' || pattern === 'checker';
  const uAxis = pattern === 'col' || pattern === 'strip-col-2' || pattern === 'checker';
  if (!(res > 0) || !(P > 0) || (!vAxis && !uAxis)) return [0, 0];
  const two = pattern === 'strip-row-2' || pattern === 'strip-col-2';
  const period = two ? 2 * P : P;

  const cap = pattern === 'checker' ? PHASE_CHECKER_MAX : PHASE_SPAN_MAX;
  const span = phaseSpanPx(period, res, cap);
  // Along an axis the pattern does not vary on, two pixels say all there is.
  const nu = uAxis ? span : 2, nv = vAxis ? span : 2;
  const padX = Math.ceil(3 * (sensor.sigmaX || 0) + Math.abs(sensor.offX ?? 0)) + 1;
  const padY = Math.ceil(3 * (sensor.sigmaY || 0) + Math.abs(sensor.offY ?? 0)) + 1;
  const nx = nu + 2 * padX, ny = nv + 2 * padY;
  const e0 = (Math.floor(ox0 / res) - padX - (nu >> 1)) * res;
  const n0 = (Math.floor(oy0 / res) - padY - (nv >> 1)) * res;
  const box = { res, utmBounds: [e0, n0, e0 + nx * res, n0 + ny * res] } as unknown as S2Grid;
  const layout: SimLayout = { pattern, width, spacing, rotationDeg: 0 };

  // What is counted: the pure pixels, or first the ones that hold within the
  // CE90 the reader places for (SensorParams.placeHeldM). Two strips of one
  // crop with no alley between them are one strip twice as wide.
  const lands = ce90Shifts(placedFor(sensor, two && !(spacing > 0) ? 2 * width : width), 0);
  const inner = lands.length ? new Uint8Array(nx * ny) : null;
  const score = (du: number, dv: number) => {
    const verdicts = fieldVerdicts(box, [ox0 + du, oy0 + dv], layout, sensor);
    let pure = 0;
    for (let r = padY; r < padY + nv; r++) {
      for (let c = padX, k = r * nx + padX; c < padX + nu; c++, k++) if (verdicts[k] <= MAX_COVER) pure++;
    }
    if (!inner || pure === 0) return pure;
    // Only the stretch counted is asked about again: the margin reads mixed, which no landing can hold.
    inner.fill(MIXED);
    for (let r = padY; r < padY + nv; r++) for (let c = padX, k = r * nx + padX; c < padX + nu; c++, k++) inner[k] = verdicts[k];
    const mask = heldMask(inner, lands.length, (q, need) => fieldVerdicts(box, [ox0 + du - lands[q][0], oy0 + dv - lands[q][1]], layout, sensor, need));
    let held = 0;
    for (let k = 0; k < mask.length; k++) if (mask[k]) held++;
    return held * HELD_FIRST + pure;
  };
  const reach = Math.min(period, res);
  const search = (axis: 'u' | 'v', other: number, from = 0): number => {
    // Strictly greater keeps the place it starts from, then the FIRST
    // maximiser: a flat optimum resolves to the smallest shift, and a pattern
    // already at its best is left alone. (Strictly fewer, and the first
    // minimiser, for a lattice that falls anywhere: SensorParams.anyPosition.)
    let best = from, bestScore = axis === 'u' ? score(from, other) : score(other, from);
    for (let k = 0; k < STRIP_PHASE_STEPS; k++) {
      const d = (k / STRIP_PHASE_STEPS) * reach;
      const sc = axis === 'u' ? score(d, other) : score(other, d);
      if (keepsCount(sensor, sc, bestScore)) { bestScore = sc; best = d; }
    }
    return best;
  };
  // Row-type patterns vary across rows only, and column-type along rows only, so
  // one axis is searched with the other left where it is.
  if (!uAxis) return [0, search('v', 0)];
  if (!vAxis) return [search('u', 0), 0];
  let u0 = 0, v0 = 0, top = noCountYet(sensor);
  for (let i = 0; i < CHECKER_COARSE; i++) {
    for (let j = 0; j < CHECKER_COARSE; j++) {
      const du = (i / CHECKER_COARSE) * reach, dv = (j / CHECKER_COARSE) * reach;
      const sc = score(du, dv);
      if (keepsCount(sensor, sc, top)) { top = sc; u0 = du; v0 = dv; }
    }
  }
  // Refined an axis at a time from there: each pass starts from the pick so
  // far and leaves it only for a phase that is strictly better.
  let dv = search('v', u0, v0);
  const du = search('u', dv, u0);
  dv = search('v', du, dv);
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
  // The driver's own simulation of that square: one model for every caller.
  const sim = simulateField({ res: gsd, utmBounds: [minE, minN, minE + nx * gsd, minN + ny * gsd] } as unknown as S2Grid, [patternOx, patternOy], layout, sensor);
  return {
    proportionA: sim.proportionA, proportionBare: sim.proportionBare, mixed: sim.mixed,
    nx, ny,
    purePct: sim.purePct,
    nSpecies: sim.nSpecies, proportionBySpecies: sim.proportionBySpecies,
    meanBySpecies: sim.meanBySpecies,
    proportionOffTrial: sim.proportionOffTrial,
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
  return gsds.map(gsd => {
    const oMinE = Math.floor(wMinE / gsd) * gsd;
    const oMinN = Math.floor(wMinN / gsd) * gsd;
    const nx = Math.max(1, Math.ceil((wMaxE - oMinE) / gsd));
    const ny = Math.max(1, Math.ceil((wMaxN - oMinN) / gsd));
    // The driver's own simulation of that window: one model for every caller.
    const sim = simulateField({ res: gsd, utmBounds: [oMinE, oMinN, oMinE + nx * gsd, oMinN + ny * gsd] } as unknown as S2Grid, [minE, minN], layout, sensor);
    // Off-trial ground is not a resolved pixel of an imported trial; the
    // off-trial channel is only read for one. A periodic layout has no ground
    // off the trial, so an off-trial verdict there is a pixel whose kernel saw
    // nothing (psfBlindPixels), and is left out as it always was.
    const off = imported ? sim.proportionOffTrial : null;
    let pure = 0, counted = 0;
    for (let k = 0; k < sim.mixed.length; k++) {
      if (!imported && sim.mixed[k] === OFF_TRIAL.id) continue;
      if (off && off[k] > 0.5) continue;
      counted++;
      if (sim.mixed[k] !== MIXED && !(off && sim.mixed[k] === OFF_TRIAL.id)) pure++;
    }
    return { gsd, purePct: counted ? (100 * pure) / counted : 0 };
  });
}
