import { EigenvalueDecomposition, Matrix } from 'ml-matrix';
import { BARE, OFF_TRIAL, makeTruth, makeBetaSchedule, parsOf, TMAX, type FieldParams } from './simulate';
import { coverShares, mixN, type CoverKind } from './util';
import { embed, type DrMethod } from '../lib/projections';

/**
 * The PCA of a simulated field, computed ONE way for every view that shows it.
 *
 * The big scatter and the resolution ladder's thumbnails used to build their own
 * seasons, run their own PCA, pick their own axis signs and their own colours.
 * The thumbnail at the user's own resolution therefore showed different ground
 * (a central window), different noise draws, a mirrored orientation and a
 * different colour scheme from the chart directly above it, and could not look
 * the same. Everything that decides what a PCA view shows lives here now, and
 * the fit is cached per simulation, so two views asking for the same thing get
 * the same object instead of two computations that merely hope to agree.
 */

export const NT = 24;
const EPS = 1e-3;
/** Fewest trial pixels worth embedding; below this the fit is not a result. */
export const MIN_PTS = 8;
/** % of the pixel one crop must hold for the pure/mixed encodings. */
export const PURE_T = 80;

export type ColorBy = 'mixing' | 'species' | 'purity';
export type ShapeBy = 'species' | 'purity' | 'none';
export type SymbolType = 'triangle' | 'square' | 'circle' | 'diamond' | 'star' | 'cross' | 'wye';

/**
 * One symbol per species. There are seven, against a maximum of eight species,
 * so at eight the shapes wrap and COLOUR carries the distinction.
 */
export const SYMS: SymbolType[] = ['triangle', 'square', 'circle', 'diamond', 'star', 'cross', 'wye'];

/** What a PCA needs from a simulation. A FieldSim and a ladder step both qualify. */
export interface CoverSource {
  proportionA: ArrayLike<number>;
  proportionBare: ArrayLike<number> | null;
  /** Per-pixel species composition at [k * nSpecies + s]. */
  proportionBySpecies: Float32Array | null;
  proportionOffTrial: ArrayLike<number> | null;
  nSpecies: number;
  /**
   * Each pixel's identity on the ground (see pixelId). Its noise draw and whether
   * a thumbnail samples it follow this, so the same pixel is the same point in
   * every view. Without it, the index in these arrays is used.
   */
  pixelIds?: ArrayLike<number> | null;
}

/** `k` indexes the source arrays (selection maps back through it); `id` is the pixel's identity. */
export interface FitPoint { s: number[]; fr: number[]; bare: number; off: number; k: number; id: number }

/**
 * A ground pixel's identity, from its column and row on the absolute lattice
 * (buildS2Grid's cell.col and cell.row: UTM metres over the pixel size). The big
 * chart and a ladder rung simulate different extents, so the same pixel sits at
 * different array positions in each; seeding its noise by position gave it a
 * different draw in each view, and a thumbnail changed when it was picked.
 */
export const pixelId = (col: number, row: number): number =>
  (Math.imul(col, 73856093) ^ Math.imul(row, 19349663)) >>> 1;
export interface FieldFit {
  pts: FitPoint[];
  explained: number[];
  loadings: number[][];
  /** Trial pixels available when there were too few to embed; 0 when embedded. */
  tooFew: number;
}

export const pureCurve = (f: FieldParams): number[] => {
  const full = makeTruth(f.truth, TMAX, parsOf(f));
  return Array.from({ length: NT }, (_, i) => full[Math.round((i * (TMAX - 1)) / (NT - 1))]);
};
const rngFor = (seed: number) => {
  let s = (seed % 2147483647 + 2147483647) % 2147483647 || 1;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
};
const gauss = (rnd: () => number) => {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const cache = new WeakMap<object, Map<string, FieldFit>>();

/** Keep a pixel with probability `p`, decided by a hash of its index: deterministic and spread out. */
const hashKeep = (p: number) => {
  const threshold = Math.max(0, Math.min(1, p)) * 4294967296;
  return (k: number) => (Math.imul(k + 1, 2654435761) >>> 0) < threshold;
};

/**
 * PCA of `n` rows of `p` features stored flat in `X`, fitted on every `step`-th
 * row and applied to all of them.
 *
 * The same PCA as ml-pca's (centred, not scaled, axes ordered by variance), but
 * solved as a p by p covariance and its eigenvectors rather than an SVD of the
 * whole n by p matrix built from nested arrays. At 0.5 m that SVD was most of
 * the 150 to 250 ms every resolution change spent on the big chart; this is a
 * few milliseconds. Axis signs are arbitrary either way and every view fixes
 * them with axisSigns. Returns null when the numbers are not usable, so the
 * caller can fall back to the general embedding.
 */
export function linearPca(X: Float64Array, n: number, p: number, step: number, k: number):
  { scores: number[][]; explained: number[]; loadings: number[][] } | null {
  const mean = new Float64Array(p);
  let m = 0;
  for (let i = 0; i < n; i += step, m++) for (let t = 0; t < p; t++) mean[t] += X[i * p + t];
  if (m < 2) return null;
  for (let t = 0; t < p; t++) mean[t] /= m;
  const C = new Float64Array(p * p);
  const d = new Float64Array(p);
  for (let i = 0; i < n; i += step) {
    for (let t = 0; t < p; t++) d[t] = X[i * p + t] - mean[t];
    for (let a = 0; a < p; a++) {
      const da = d[a], row = a * p;
      for (let b = a; b < p; b++) C[row + b] += da * d[b];
    }
  }
  const S: number[][] = Array.from({ length: p }, () => new Array<number>(p));
  for (let a = 0; a < p; a++) for (let b = a; b < p; b++) { S[a][b] = S[b][a] = C[a * p + b] / (m - 1); }
  if (!S.every(row => row.every(Number.isFinite))) return null;
  const evd = new EigenvalueDecomposition(new Matrix(S), { assumeSymmetric: true });
  const vals = evd.realEigenvalues;
  const V = evd.eigenvectorMatrix;
  const order = vals.map((_, i) => i).sort((x, y) => vals[y] - vals[x]).slice(0, Math.min(k, p));
  const total = vals.reduce((s, v) => s + Math.max(0, v), 0);
  const loadings = order.map(e => Array.from({ length: p }, (_, t) => V.get(t, e)));
  const explained = order.map(e => (total > 0 ? (100 * Math.max(0, vals[e])) / total : 0));
  const scores: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = new Array<number>(loadings.length);
    for (let c = 0; c < loadings.length; c++) {
      const w = loadings[c];
      let acc = 0;
      for (let t = 0; t < p; t++) acc += (X[i * p + t] - mean[t]) * w[t];
      s[c] = acc;
    }
    if (!s.every(Number.isFinite)) return null;
    scores[i] = s;
  }
  return { scores, explained, loadings };
}

/**
 * About `max` of a fit's points, picked by the same pixel hash, for drawing.
 * The cloud keeps its shape; a thumbnail does not need every dot.
 */
export function samplePts(pts: FitPoint[], max: number): FitPoint[] {
  if (pts.length <= max) return pts;
  const keep = hashKeep(max / pts.length);
  return pts.filter(p => keep(p.id));
}

/** The fit fitCover would return for these arguments if it is already cached, else null. Never computes. */
export function peekFit(
  src: CoverSource, species: FieldParams[], magnitude: number, method: DrMethod,
  opts: { fitCap?: number; sample?: number } = {},
): FieldFit | null {
  return cache.get(src)?.get(fitKey(species, magnitude, method, opts)) ?? null;
}

const fitKey = (species: FieldParams[], magnitude: number, method: DrMethod, opts: { fitCap?: number; sample?: number }) =>
  `${species.map(c => `${c.truth}_${c.L1}_${c.k1}_${c.x01}_${c.k2}_${c.x02}_${c.tc}`).join('|')}#${magnitude}#${method}#${opts.fitCap ?? Infinity}#${opts.sample ?? 0}`;

/**
 * Seasons for every trial pixel of `src`, embedded with `method`.
 *
 * Each pixel's season is mixed from its REAL composition: every species, bare
 * alley soil and off-trial ground, plus ONE correlated normal draw per pixel
 * (the repo's noise model), seeded by the pixel's index in `src`. Ground more
 * than half outside the trial is not a sample of the trial and is skipped.
 *
 * `fitCap` fits the axes on an evenly spaced subset of at most that many rows
 * and projects every row onto them. `sample` goes further and keeps only about
 * that many trial pixels at all, chosen by a hash of the pixel index so the
 * choice is spread over the whole field rather than following its rows (a
 * regular stride can alias with a plot pattern). A thumbnail needs a few
 * hundred points to show the shape of the cloud; building and projecting tens
 * of thousands was most of the ladder's cost. Views that must agree exactly
 * pass neither and share the cached result.
 */
export function fitCover(
  src: CoverSource, species: FieldParams[], magnitude: number, method: DrMethod,
  opts: { fitCap?: number; sample?: number } = {},
): FieldFit {
  const fitCap = opts.fitCap ?? Infinity;
  const sample = opts.sample ?? 0;
  const key = fitKey(species, magnitude, method, opts);
  let memo = cache.get(src);
  if (!memo) cache.set(src, (memo = new Map()));
  const hit = memo.get(key);
  if (hit) return hit;

  const curves = species.map(pureCurve);
  const varSched = makeBetaSchedule(NT, 2, 2, Math.max(0, magnitude));
  const nSp = Math.max(1, src.nSpecies);
  const spAll = src.proportionBySpecies;
  const offAll = src.proportionOffTrial;
  const ids = src.pixelIds ?? null;
  const nAll = src.proportionA.length;
  let keepPixel: ((k: number) => boolean) | null = null;
  if (sample > 0) {
    let trial = 0;
    for (let k = 0; k < nAll; k++) if (!offAll || offAll[k] <= 0.5) trial++;
    if (trial > sample) keepPixel = hashKeep(sample / trial);
  }
  const keep: number[] = [];
  for (let k = 0; k < nAll; k++) {
    if (offAll && offAll[k] > 0.5) continue;
    if (keepPixel && !keepPixel(ids ? ids[k] : k)) continue;
    keep.push(k);
  }
  const n = keep.length;

  let out: FieldFit;
  if (n < MIN_PTS) {
    out = { pts: [], explained: [], loadings: [], tooFew: n };
  } else {
    // Every season in ONE flat array, row j at [j * NT]. 20,000 small arrays
    // were a large part of what a fit at 0.5 m cost.
    const X = new Float64Array(n * NT);
    const fracs: number[][] = new Array(n), bares = new Float64Array(n), offs = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const k = keep[j];
      const off = offAll ? offAll[k] : 0;
      const pBare = src.proportionBare ? src.proportionBare[k] : 0;
      const fr = spAll
        ? Array.from(spAll.subarray(k * nSp, k * nSp + nSp))
        : [src.proportionA[k], Math.max(0, 1 - src.proportionA[k] - pBare)];
      const z = gauss(rngFor(ids ? ids[k] + 12345 : k * 2654435761 + 12345));
      const o = j * NT;
      for (let t = 0; t < NT; t++) {
        let m = pBare * BARE.ndvi + off * OFF_TRIAL.ndvi;
        // Zero shares skipped: an imported trial has dozens of varieties and a
        // pixel holds one or two, and adding 0 * curve leaves m bit for bit as it was.
        for (let i = 0; i < fr.length; i++) if (fr[i]) m += fr[i] * (curves[i]?.[t] ?? 0);
        const sd = Math.sqrt(Math.min(Math.max(0, varSched[t]), m * (1 - m)));
        X[o + t] = Math.min(1 - EPS, Math.max(EPS, m + sd * z));
      }
      fracs[j] = fr; bares[j] = pBare; offs[j] = off;
    }
    // A trial of S species has up to S-1 independent mixing directions, but the
    // chart offers eight axes at most: scoring forty varieties on 24 components
    // was work nothing could display.
    const components = Math.min(Math.max(3, nSp), 8, NT);
    const step = Number.isFinite(fitCap) && n > fitCap ? Math.ceil(n / fitCap) : 1;
    const fast = method === 'pca' ? linearPca(X, n, NT, step, components) : null;
    let r: { scores: number[][]; index: number[]; explained: number[]; loadings: number[][] };
    if (fast) {
      r = { ...fast, index: keep.map((_, j) => j) };
    } else {
      const rows = Array.from({ length: n }, (_, j) => Array.from(X.subarray(j * NT, (j + 1) * NT)));
      const fitRows = step > 1 ? rows.filter((_, i) => i % step === 0) : rows;
      r = embed(method, { fit: fitRows, proj: rows, components });
    }
    const pts = r.scores.map((s, j) => {
      const k = keep[r.index[j]];
      return { s, fr: fracs[r.index[j]], bare: bares[r.index[j]], off: offs[r.index[j]], k, id: ids ? ids[k] : k };
    });
    out = { pts, explained: r.explained, loadings: r.loadings, tooFew: 0 };
  }
  // A few fits per simulation (a method switch and back); each can hold tens of
  // thousands of points, so do not let edits pile them up.
  if (memo.size >= 3) memo.delete(memo.keys().next().value as string);
  memo.set(key, out);
  return out;
}

/**
 * Signs that make every PCA view face the same way.
 *
 * A PCA's axis signs are arbitrary, so every view has to pick them by one rule,
 * or the same data is drawn as its own mirror image and neighbouring sizes in
 * the ladder do not line up.
 *
 * The rule reads the fit's LOADINGS: each species' pure season (and bare soil),
 * projected on the axis, says where a pure pixel of it lands. The horizontal
 * axis is oriented so species 0 lands on the positive side, the vertical axis
 * so species 1 does. A species that lands too close to the middle to decide
 * (under 30% of the farthest one) passes the decision to the next species in
 * order, then bare soil.
 *
 * It used to be a correlation between the scores and one share per axis (the
 * first species, mixedness). Estimated from noisy pixels, that sat near zero
 * whenever the axis separated two other crops: a 500-pixel fit and a full fit
 * of the same field then faced opposite ways in 35 of 282 random trials, and a
 * thumbnail flipped when it was picked. Loadings barely move between such fits;
 * this rule disagreed in 5 of those 282 and halved the misaligned neighbours.
 * Methods without loadings (the nonlinear ones) keep a share-correlation vote.
 */
const signCache = new WeakMap<FieldFit, Map<string, [number, number]>>();
/** A species this close to the middle, relative to the farthest one, does not decide the sign. */
const SIGN_MARGIN = 0.3;
export function axisSigns(fit: FieldFit, xi: number, yi: number, species: FieldParams[]): [number, number] {
  const pts = fit.pts;
  if (pts.length < 2) return [1, 1];
  // Cached per fit: the scatter and its thumbnail ask for the same signs. The
  // species are part of the fit's own cache key, so they cannot differ here.
  let memo = signCache.get(fit);
  if (!memo) signCache.set(fit, (memo = new Map()));
  const hit = memo.get(`${xi},${yi}`);
  if (hit) return hit;
  const L = fit.loadings;
  const signs: [number, number] = L.length > Math.max(xi, yi) && L[xi].length === NT && species.length
    ? loadingSigns(L, xi, yi, species)
    : shareSigns(pts, xi, yi);
  memo.set(`${xi},${yi}`, signs);
  return signs;
}

function loadingSigns(L: number[][], xi: number, yi: number, species: FieldParams[]): [number, number] {
  const seasons = [...species.map(pureCurve), new Array<number>(NT).fill(BARE.ndvi)];
  const centre = Array.from({ length: NT }, (_, t) => seasons.reduce((m, c) => m + c[t], 0) / seasons.length);
  const decide = (c: number, lead: number): number => {
    const p = seasons.map(sn => sn.reduce((acc, v, t) => acc + (v - centre[t]) * L[c][t], 0));
    const far = Math.max(...p.map(Math.abs));
    if (!(far > 0)) return 1;
    const order = [lead, ...p.map((_, j) => j).filter(j => j !== lead)];
    for (const j of order) if (Math.abs(p[j]) >= SIGN_MARGIN * far) return p[j] < 0 ? -1 : 1;
    return 1;
  };
  return [decide(xi, 0), decide(yi, Math.min(1, species.length - 1))];
}

/** Every share votes by its correlation with the axis times its absolute value; the lead share counts four times. */
function shareSigns(pts: FitPoint[], xi: number, yi: number): [number, number] {
  const n = pts.length;
  const S = pts[0].fr.length;
  const F = S + 2, BARE_F = S, MIX_F = S + 1;
  const feat = new Float64Array(n * F);
  const mean = new Float64Array(F);
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    const c = coverShares(pts[i].fr, pts[i].bare, pts[i].off);
    const o = i * F;
    for (let j = 0; j < S; j++) feat[o + j] = c.species[j] ?? 0;
    feat[o + BARE_F] = c.bare;
    feat[o + MIX_F] = 1 - c.dominant.share;
    for (let j = 0; j < F; j++) mean[j] += feat[o + j];
    mx += pts[i].s[xi] ?? 0; my += pts[i].s[yi] ?? 0;
  }
  mx /= n; my /= n;
  for (let j = 0; j < F; j++) mean[j] /= n;
  const cx = new Float64Array(F), cy = new Float64Array(F), vf = new Float64Array(F);
  let vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (pts[i].s[xi] ?? 0) - mx, dy = (pts[i].s[yi] ?? 0) - my;
    vx += dx * dx; vy += dy * dy;
    const o = i * F;
    for (let j = 0; j < F; j++) {
      const d = feat[o + j] - mean[j];
      cx[j] += dx * d; cy[j] += dy * d; vf[j] += d * d;
    }
  }
  const vote = (c: Float64Array, v: number, lead: number) => {
    let sum = 0;
    for (let j = 0; j < F; j++) {
      if (!(vf[j] > 0) || !(v > 0)) continue;
      const r = c[j] / Math.sqrt(v * vf[j]);
      sum += (j === lead ? 4 : 1) * r * Math.abs(r);
    }
    return sum < 0 ? -1 : 1;
  };
  return [vote(cx, vx, 0), vote(cy, vy, MIX_F)];
}

/**
 * How one pixel is drawn: its colour, symbol and what dominates it. Shared by
 * the scatter and the thumbnails so the same pixel is the same colour in both.
 */
export function pointStyle(p: FitPoint, colorBy: ColorBy, shapeBy: ShapeBy, colors: string[]):
  { color: string; sym: SymbolType; kind: CoverKind; rim: boolean } {
  // Shares of the WHOLE pixel, bare soil and off-trial ground included.
  const d = coverShares(p.fr, p.bare, p.off).dominant;
  const pure = d.kind === 'species' && d.share >= PURE_T / 100;
  const groundColor = d.kind === 'bare' ? BARE.color : OFF_TRIAL.color;
  const color =
    colorBy === 'mixing' ? mixN(p.fr, colors, p.bare, p.off)
    : colorBy === 'species' ? (d.kind === 'species' ? (colors[d.i] ?? colors[0]) : groundColor)
    : d.kind !== 'species' ? groundColor
    : pure ? '#22c55e' : '#ef4444';
  const sym: SymbolType = shapeBy === 'species' ? (d.kind === 'species' ? SYMS[d.i % SYMS.length] : 'cross')
    : shapeBy === 'purity' ? (pure ? 'circle' : 'cross')
    : 'circle';
  // Off-trial ground is dark grey, about 1.6:1 against the chart background.
  return { color, sym, kind: d.kind, rim: d.kind === 'off' };
}
