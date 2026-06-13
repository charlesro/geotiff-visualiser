import { RasterLayer } from '../types';
import { GeoTIFFData } from './geotiff-utils';
import { ZoneExtraction } from './zones';
import { getGeoJsonBounds, Bbox } from './geo';

/**
 * Field-boundary prediction from the Sentinel-2 time series.
 *
 * Premise: each field is a single pure crop, so an interior pixel carries one
 * clean signature while a pixel straddling a boundary is a mixture. Two
 * per-pixel scores turn that into a boundary-likelihood raster over the
 * imagery, independent of the polygon database:
 *
 *   - gradient: the multitemporal spatial gradient magnitude (Sobel on every
 *     date's NDVI, combined). Peaks ON the transition line. Unsupervised.
 *   - impurity: distance from the pixel's NDVI time-series to the nearest pure
 *     crop signature (the species interior means from the zone extraction).
 *     Large where a pixel matches no single crop — i.e. a mixture.
 *
 * The loaded polygons are the ground truth: their outlines are rasterised to a
 * boundary band and each score is scored against it with a rank-based ROC AUC,
 * so "pretty heatmap" becomes a number.
 */

export type PredictMethod = 'gradient' | 'impurity';

export interface PredictGrid {
  /** Leaflet bounds [[south,west],[north,east]]. */
  bounds: [[number, number], [number, number]];
  width: number;
  height: number;
  /** Normalised 0..1 scores, row-major; NaN where invalid. */
  gradient: Float32Array;
  impurity: Float32Array | null;
}

export interface PredictMetrics {
  available: boolean;
  /** ROC AUC of the score vs the rasterised polygon boundary. */
  auc: number;
  /** Mean normalised score on true-boundary vs interior pixels. */
  boundaryMean: number;
  interiorMean: number;
}

export interface BoundaryPrediction {
  grids: PredictGrid[];
  metrics: Record<PredictMethod, PredictMetrics>;
  dates: string[];
  evaluatedPixels: number;
  truePositivePixels: number;
  /** Boundary band half-width used for the ground truth, in pixels. */
  truthBandPx: number;
}

// Polygon outer rings + holes as [lng,lat] coordinate rings.
const ringsOf = (f: any): number[][][] => {
  const g = f?.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat();
  return [];
};

const ndviOf = (b08: Float32Array, b04: Float32Array, i: number): number => {
  const nir = b08[i];
  const red = b04[i];
  if (!nir || !red) return NaN; // 0 = nodata
  const d = nir + red;
  return d === 0 ? NaN : (nir - red) / d;
};

/** The analysis windows (10 m) when present, else the preview mosaic. */
const gridsOfScene = (s: RasterLayer): GeoTIFFData[] => (s.analysisGrids?.length ? s.analysisGrids : s.data ? [s.data] : []);

export function computeBoundaryPrediction(
  scenes: RasterLayer[],
  polygonFeatures: any[],
  zones: ZoneExtraction | null
): BoundaryPrediction {
  const usable = scenes.filter(s => gridsOfScene(s).length > 0);
  if (usable.length < 2) {
    throw new Error('Boundary prediction needs at least two dates of imagery — fetch a longer series.');
  }
  const dates = usable.map(s => (s.datetime || '').split('T')[0]);
  const nGrids = Math.min(...usable.map(s => gridsOfScene(s).length));
  const T = usable.length;

  // Species endmembers for the impurity score, from the extracted interior
  // pixels (only when the zones were extracted as NDVI over these dates).
  const endmembers = zones && zones.metric === 'NDVI' ? buildEndmembers(zones, dates) : null;

  const grids: PredictGrid[] = [];
  // (score, isBoundary) samples for the AUC, accumulated across grids.
  const gradEval: number[] = [];
  const gradLabel: number[] = [];
  const impEval: number[] = [];
  const impLabel: number[] = [];
  let truePos = 0;

  for (let g = 0; g < nGrids; g++) {
    const ref = gridsOfScene(usable[0])[g];
    const W = ref.metadata.width;
    const H = ref.metadata.height;
    const n = W * H;

    // NDVI cube: one Float32Array per date.
    const cube: Float32Array[] = [];
    for (let t = 0; t < T; t++) {
      const gd = gridsOfScene(usable[t])[g];
      const bands = gd.bandData || {};
      const b08 = bands['B08'] || bands['8'];
      const b04 = bands['B04'] || bands['4'];
      const arr = new Float32Array(n);
      if (b08 && b04 && gd.metadata.width === W && gd.metadata.height === H) {
        for (let i = 0; i < n; i++) arr[i] = ndviOf(b08, b04, i);
      } else {
        arr.fill(NaN);
      }
      cube.push(arr);
    }

    // A pixel is usable when every date is finite.
    const valid = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let ok = true;
      for (let t = 0; t < T; t++) if (!Number.isFinite(cube[t][i])) { ok = false; break; }
      valid[i] = ok ? 1 : 0;
    }

    const gradient = computeGradient(cube, W, H, valid);
    const impurity = endmembers ? computeImpurity(cube, n, endmembers) : null;

    // Restrict to pixels inside a field, so roads / hedges / open land are
    // never scored or drawn. The gradient is still computed from the true
    // outside neighbours, so the field-edge pixels themselves are kept.
    const inside = rasterizeFill(ref, polygonFeatures, W, H);
    for (let i = 0; i < n; i++) if (!valid[i] || !inside[i]) { gradient[i] = NaN; if (impurity) impurity[i] = NaN; }

    // Ground-truth boundary band from the polygon outlines.
    const truth = rasterizeBoundary(ref, polygonFeatures, W, H);

    for (let i = 0; i < n; i++) {
      if (!valid[i] || !inside[i]) continue;
      const lbl = truth[i];
      if (lbl) truePos++;
      gradEval.push(gradient[i]);
      gradLabel.push(lbl);
      if (impurity) {
        impEval.push(impurity[i]);
        impLabel.push(lbl);
      }
    }

    grids.push({ bounds: ref.bounds, width: W, height: H, gradient, impurity });
  }

  // Normalise each score to 0..1 by its 98th percentile (robust to outliers),
  // shared across grids so the colour scale is comparable everywhere. The
  // grid rasters AND the AUC sample are scaled with the same denominator.
  const gradDenom = percentile98(gradEval);
  const impDenom = endmembers ? percentile98(impEval) : 1;
  for (const g of grids) {
    scaleArray(g.gradient, gradDenom);
    if (g.impurity) scaleArray(g.impurity, impDenom);
  }
  scale(gradEval, gradDenom);
  if (endmembers) scale(impEval, impDenom);

  return {
    grids,
    metrics: {
      gradient: metricsFor(true, gradEval, gradLabel),
      impurity: metricsFor(!!endmembers, impEval, impLabel),
    },
    dates,
    evaluatedPixels: gradLabel.length,
    truePositivePixels: truePos,
    truthBandPx: 1,
  };
}

// ----- per-pixel scores --------------------------------------------------------

const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

/** sqrt over dates of (Sobel_x² + Sobel_y²); NaN on borders / invalid nbhd. */
function computeGradient(cube: Float32Array[], W: number, H: number, valid: Uint8Array): Float32Array {
  const out = new Float32Array(W * H).fill(NaN);
  const T = cube.length;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++)
        for (let dx = -1; dx <= 1; dx++) if (!valid[(y + dy) * W + (x + dx)]) { ok = false; break; }
      if (!ok) continue;
      let sum = 0;
      for (let t = 0; t < T; t++) {
        let gx = 0;
        let gy = 0;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const v = cube[t][(y + dy) * W + (x + dx)];
            gx += v * SOBEL_X[k];
            gy += v * SOBEL_Y[k];
            k++;
          }
        sum += gx * gx + gy * gy;
      }
      out[i] = Math.sqrt(sum);
    }
  }
  return out;
}

/** Min Euclidean distance (over dates) to a species endmember curve. */
function computeImpurity(cube: Float32Array[], n: number, endmembers: Float32Array[]): Float32Array {
  const out = new Float32Array(n);
  const T = cube.length;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (const em of endmembers) {
      let s = 0;
      for (let t = 0; t < T; t++) {
        const d = cube[t][i] - em[t];
        s += d * d;
      }
      if (s < best) best = s;
    }
    out[i] = Math.sqrt(best);
  }
  return out;
}

function buildEndmembers(zones: ZoneExtraction, dates: string[]): Float32Array[] | null {
  const sums = new Map<string, { sum: Float32Array; n: Float32Array }>();
  for (const f of zones.interior.features) {
    const props = f.properties;
    const sp = String(props?.crp_lbl ?? props?.species ?? 'unknown');
    let acc = sums.get(sp);
    if (!acc) {
      acc = { sum: new Float32Array(dates.length), n: new Float32Array(dates.length) };
      sums.set(sp, acc);
    }
    for (let t = 0; t < dates.length; t++) {
      const v = props[`NDVI_${dates[t]}`];
      if (typeof v === 'number' && isFinite(v)) {
        acc.sum[t] += v;
        acc.n[t]++;
      }
    }
  }
  const ems: Float32Array[] = [];
  for (const { sum, n } of sums.values()) {
    if (n.every(c => c > 0)) ems.push(sum.map((s, t) => s / n[t]));
  }
  return ems.length > 0 ? ems : null;
}

// ----- ground truth + metrics --------------------------------------------------

/** Mark grid cells the polygon outlines pass through (+ a 1-px band). */
function rasterizeBoundary(grid: GeoTIFFData, polygons: any[], W: number, H: number): Uint8Array {
  const truth = new Uint8Array(W * H);
  const bb = grid.metadata.imageBbox;
  if (!bb) return truth;
  const [minLng, minLat, maxLng, maxLat] = bb;
  const toPx = (lng: number, lat: number): [number, number] => [
    ((lng - minLng) / (maxLng - minLng)) * W - 0.5,
    ((maxLat - lat) / (maxLat - minLat)) * H - 0.5,
  ];
  const mark = (x: number, y: number) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    truth[y * W + x] = 1;
    if (x + 1 < W) truth[y * W + x + 1] = 1;
    if (x - 1 >= 0) truth[y * W + x - 1] = 1;
    if (y + 1 < H) truth[(y + 1) * W + x] = 1;
    if (y - 1 >= 0) truth[(y - 1) * W + x] = 1;
  };
  const gridBox: Bbox = [minLng, minLat, maxLng, maxLat];
  for (const f of polygons) {
    const fb = getGeoJsonBounds(f);
    if (!fb || fb[2] < minLng || fb[0] > maxLng || fb[3] < minLat || fb[1] > maxLat) continue;
    for (const ring of ringsOf(f)) {
      for (let s = 0; s < ring.length - 1; s++) {
        const [ax, ay] = toPx(ring[s][0], ring[s][1]);
        const [bx, by] = toPx(ring[s + 1][0], ring[s + 1][1]);
        // DDA line raster.
        const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
        for (let k = 0; k <= steps; k++) {
          const x = Math.round(ax + ((bx - ax) * k) / steps);
          const y = Math.round(ay + ((by - ay) * k) / steps);
          mark(x, y);
        }
      }
    }
  }
  return truth;
}

/** Mark grid cells whose centre is inside any polygon (scanline even-odd
 *  fill, each polygon rasterised separately and OR-ed together). */
function rasterizeFill(grid: GeoTIFFData, polygons: any[], W: number, H: number): Uint8Array {
  const mask = new Uint8Array(W * H);
  const bb = grid.metadata.imageBbox;
  if (!bb) return mask;
  const [minLng, minLat, maxLng, maxLat] = bb;
  // Integer pixel coord == pixel centre under this mapping.
  const px = (lng: number) => ((lng - minLng) / (maxLng - minLng)) * W - 0.5;
  const py = (lat: number) => ((maxLat - lat) / (maxLat - minLat)) * H - 0.5;

  for (const f of polygons) {
    const fb = getGeoJsonBounds(f);
    if (!fb || fb[2] < minLng || fb[0] > maxLng || fb[3] < minLat || fb[1] > maxLat) continue;
    const rings = ringsOf(f).map(r => r.map(([lng, lat]) => [px(lng), py(lat)] as [number, number]));
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const r of rings) for (const p of r) { if (p[1] < yMin) yMin = p[1]; if (p[1] > yMax) yMax = p[1]; }
    const y0 = Math.max(0, Math.ceil(yMin));
    const y1 = Math.min(H - 1, Math.floor(yMax));
    for (let y = y0; y <= y1; y++) {
      const xs: number[] = [];
      for (const r of rings) {
        for (let s = 0; s < r.length - 1; s++) {
          const ay = r[s][1];
          const by = r[s + 1][1];
          if ((ay <= y) !== (by <= y)) {
            const t = (y - ay) / (by - ay);
            xs.push(r[s][0] + t * (r[s + 1][0] - r[s][0]));
          }
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k]));
        const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
        for (let x = xa; x <= xb; x++) mask[y * W + x] = 1;
      }
    }
  }
  return mask;
}

/** 98th percentile of finite values, as the normalisation denominator. */
function percentile98(sample: number[]): number {
  const finite = sample.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return 1;
  const p = finite[Math.floor(finite.length * 0.98)] || finite[finite.length - 1];
  return p > 0 ? p : 1;
}

const scale = (vals: number[], denom: number) => {
  for (let i = 0; i < vals.length; i++) vals[i] = Math.min(1, vals[i] / denom);
};

/** Divide a raster by denom, clamp to 1, preserve NaN. */
const scaleArray = (arr: Float32Array, denom: number) => {
  for (let i = 0; i < arr.length; i++) {
    if (Number.isFinite(arr[i])) arr[i] = Math.min(1, arr[i] / denom);
  }
};

/** ROC AUC via the Mann–Whitney rank statistic, + class means. */
function metricsFor(available: boolean, scores: number[], labels: number[]): PredictMetrics {
  if (!available || scores.length === 0) return { available, auc: NaN, boundaryMean: NaN, interiorMean: NaN };
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSumPos = 0;
  let nPos = 0;
  let bSum = 0;
  let iSum = 0;
  let iN = 0;
  for (let r = 0; r < idx.length; r++) {
    const i = idx[r];
    if (labels[i]) {
      rankSumPos += r + 1;
      nPos++;
      bSum += scores[i];
    } else {
      iSum += scores[i];
      iN++;
    }
  }
  const nNeg = scores.length - nPos;
  const auc = nPos > 0 && nNeg > 0 ? (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : NaN;
  return {
    available,
    auc,
    boundaryMean: nPos > 0 ? bSum / nPos : NaN,
    interiorMean: iN > 0 ? iSum / iN : NaN,
  };
}

// ----- rendering ---------------------------------------------------------------

/** Inferno-ish ramp; alpha grows with score so low values stay see-through. */
function heat(t: number): [number, number, number] {
  // dark purple → magenta → orange → pale yellow
  const stops: [number, [number, number, number]][] = [
    [0.0, [20, 11, 52]],
    [0.4, [136, 34, 106]],
    [0.7, [222, 73, 64]],
    [1.0, [252, 220, 140]],
  ];
  for (let s = 1; s < stops.length; s++) {
    if (t <= stops[s][0]) {
      const [t0, c0] = stops[s - 1];
      const [t1, c1] = stops[s];
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

/** Render one grid's score raster to a data URL (transparent below threshold). */
export function renderPredictionOverlay(
  grid: PredictGrid,
  method: PredictMethod,
  threshold: number
): string | null {
  const score = method === 'gradient' ? grid.gradient : grid.impurity;
  if (!score) return null;
  const { width: W, height: H } = grid;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const t = score[i];
    const o = i * 4;
    if (!Number.isFinite(t) || t < threshold) {
      img.data[o + 3] = 0;
      continue;
    }
    const [r, gg, b] = heat(t);
    img.data[o] = r;
    img.data[o + 1] = gg;
    img.data[o + 2] = b;
    img.data[o + 3] = Math.round(60 + 195 * t); // 0.23..1 alpha
  }
  ctx.putImageData(img, 0, 0);

  // Upscale with nearest-neighbour so 10 m cells stay crisp on the map.
  const TARGET = 256;
  if (W >= TARGET && H >= TARGET) return canvas.toDataURL();
  const scaleUp = Math.ceil(Math.max(TARGET / W, TARGET / H));
  const big = document.createElement('canvas');
  big.width = W * scaleUp;
  big.height = H * scaleUp;
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(canvas, 0, 0, big.width, big.height);
  return big.toDataURL();
}
