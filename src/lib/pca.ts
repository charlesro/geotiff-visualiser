import { PixelZone } from './zones';
import { embed, DrMethod } from './projections';

/**
 * PCA on pixel time series.
 *
 * Each pixel is one observation; its features are the index values at every
 * acquisition date (stored on the pixel feature as `<metric>_<date>`
 * properties). Pixels missing values on the retained dates are dropped so the
 * matrix is complete.
 *
 * Fitting and projection are decoupled: the axes are computed from the
 * pixels of the `fitZones` classes only, and the pixels of the
 * `projectZones` classes are then placed in that space (using the fit's
 * centering). E.g. fit on interior pixels and project the edge pixels to see
 * how the edges deviate from the pure within-field signal.
 */

export const ALL_PIXEL_ZONES: PixelZone[] = [
  'interior',
  'edge_other_species',
  'edge_same_species',
  'edge_isolated',
];

export interface PcaFitOptions {
  /** Classes whose pixels define the principal axes. Default: all. */
  fitZones?: PixelZone[];
  /** Classes projected (displayed) in the fitted space. Default: all. */
  projectZones?: PixelZone[];
  /** Dimensionality-reduction method. Default: 'pca'. */
  method?: DrMethod;
}

export interface PcaPixelScore {
  pixelId: string;
  zone: PixelZone;
  polygonId: string | number | undefined;
  lng: number;
  lat: number;
  scores: number[];
  properties: Record<string, any>;
}

export interface PcaRunResult {
  rows: PcaPixelScore[];
  /** % of variance explained per component (0–100). */
  explained: number[];
  cumulative: number[];
  /** Acquisition dates used as the feature axis (union of all dates), sorted. */
  dates: string[];
  /** Fraction of matrix cells filled by interpolation (a pixel had no image on
   *  that date — a different overpass, or a cloud). 0 when every pixel was
   *  imaged on every date. */
  interpolatedFraction: number;
  /** loadings[component][dateIndex] */
  loadings: number[][];
  metric: string;
  components: number;
  droppedPixels: number;
  /** Classes the axes were fit on, and how many pixels entered the fit. */
  fitZones: PixelZone[];
  projectZones: PixelZone[];
  fitCount: number;
  /** Which method produced these coordinates. */
  method: DrMethod;
  /** True when the method embedded only a subsample (the nonlinear ones). */
  subsampled: boolean;
}

const zoneOf = (p: any): PixelZone => (p.properties?.zone as PixelZone) || 'interior';

export function runPixelPca(pixelFeatures: any[], metric: string, options: PcaFitOptions = {}): PcaRunResult {
  const fitZones = options.fitZones?.length ? options.fitZones : ALL_PIXEL_ZONES;
  const projectZones = options.projectZones?.length ? options.projectZones : ALL_PIXEL_ZONES;
  const fitSet = new Set<PixelZone>(fitZones);
  const projectSet = new Set<PixelZone>(projectZones);

  const pixels = pixelFeatures.filter(f => f.geometry?.type === 'Point' && f.properties?.id);
  const fitPixels = pixels.filter(p => fitSet.has(zoneOf(p)));
  const projectPixels = pixels.filter(p => projectSet.has(zoneOf(p)));
  if (fitPixels.length < 10) {
    throw new Error(
      `Only ${fitPixels.length} pixels in the fit classes — too few to fit the axes. Add classes or fields.`
    );
  }
  if (projectPixels.length === 0) {
    throw new Error('No pixels in the projected classes — tick at least one class to place in the space.');
  }

  // Feature axis: the union of real acquisition dates across all pixels, kept
  // when a meaningful share of pixels actually observed them (drops one-off
  // noise). Different fields may be imaged on different Sentinel-2 overpasses,
  // so they need not share dates.
  const prefix = `${metric}_`;
  const obsCount = new Map<string, number>();
  for (const p of pixels) {
    if (!fitSet.has(zoneOf(p)) && !projectSet.has(zoneOf(p))) continue;
    for (const key of Object.keys(p.properties)) {
      if (key.startsWith(prefix) && typeof p.properties[key] === 'number' && isFinite(p.properties[key])) {
        obsCount.set(key.slice(prefix.length), (obsCount.get(key.slice(prefix.length)) || 0) + 1);
      }
    }
  }
  const dates = Array.from(obsCount.entries())
    .filter(([, c]) => c >= Math.max(5, pixels.length * 0.02))
    .map(([d]) => d)
    .sort();

  if (dates.length < 3) {
    throw new Error(
      `Only ${dates.length} acquisition date(s) across the selection — at least 3 are needed. Fetch more scenes or widen the period.`
    );
  }
  const axisT = dates.map(d => Date.parse(d));
  const axisSpan = axisT[axisT.length - 1] - axisT[0] || 1;

  // Resample one pixel onto the date axis. A date the pixel was imaged on is
  // used as is; a gap — a date that imaged *other* fields but not this one, or
  // a cloud — is filled by linearly interpolating the pixel's own NDVI curve
  // (ends held flat). So a field imaged on one overpass and a field imaged on
  // another both get a value on every axis date and share one PCA space,
  // without forcing identical observation dates. Pixels with too few real
  // observations, or whose observations don't span enough of the period to
  // interpolate across, are dropped rather than fabricated.
  const MIN_OBS = 3;
  const MIN_SPAN = 0.5; // real observations must cover ≥ half the axis time span
  let interpolatedCells = 0;
  let totalCells = 0;
  const resampleRow = (p: any): number[] | null => {
    const raw: (number | null)[] = dates.map(d => {
      const v = p.properties[prefix + d];
      return typeof v === 'number' && isFinite(v) ? v : null;
    });
    const obs: number[] = [];
    for (let i = 0; i < raw.length; i++) if (raw[i] !== null) obs.push(i);
    if (obs.length < MIN_OBS) return null;
    const first = obs[0];
    const last = obs[obs.length - 1];
    if (axisT[last] - axisT[first] < MIN_SPAN * axisSpan) return null;
    const row = new Array<number>(dates.length);
    for (let i = 0; i < dates.length; i++) {
      totalCells++;
      if (raw[i] !== null) { row[i] = raw[i] as number; continue; }
      interpolatedCells++;
      if (i < first) { row[i] = raw[first] as number; continue; }
      if (i > last) { row[i] = raw[last] as number; continue; }
      let a = i - 1; while (raw[a] === null) a--;
      let b = i + 1; while (raw[b] === null) b++;
      const f = (axisT[i] - axisT[a]) / (axisT[b] - axisT[a] || 1);
      row[i] = (raw[a] as number) + f * ((raw[b] as number) - (raw[a] as number));
    }
    return row;
  };

  const fitMatrix: number[][] = [];
  const fitPos: [number, number][] = [];
  for (const p of fitPixels) {
    const row = resampleRow(p);
    if (row) {
      fitMatrix.push(row);
      fitPos.push([p.geometry.coordinates[0], p.geometry.coordinates[1]]);
    }
  }
  if (fitMatrix.length < 10) {
    throw new Error(
      `Only ${fitMatrix.length} fit pixels span enough of the period to build a time series. Fetch more scenes or widen the period.`
    );
  }

  const projMatrix: number[][] = [];
  const kept: any[] = [];
  for (const p of projectPixels) {
    const row = resampleRow(p);
    if (row) {
      projMatrix.push(row);
      kept.push(p);
    }
  }
  if (kept.length === 0) {
    throw new Error('No projected-class pixel spans enough of the period to place in the space.');
  }

  const components = Math.min(3, dates.length);
  const method = options.method ?? 'pca';
  // The chosen method builds the coordinates: linear methods fit on the fit
  // classes and place every projected pixel; nonlinear ones embed a subsample
  // of the projected pixels directly. `index` says which projected pixels got
  // coordinates (all of them for the linear methods).
  const { scores, index, explained, loadings } = embed(method, {
    fit: fitMatrix,
    proj: projMatrix,
    fitPos,
    components,
  });
  const cumulative = explained.reduce<number[]>((acc, v) => {
    acc.push((acc[acc.length - 1] || 0) + v);
    return acc;
  }, []);

  const rows: PcaPixelScore[] = index.map((pi, j) => {
    const p = kept[pi];
    return {
      pixelId: p.properties.id,
      zone: zoneOf(p),
      polygonId: p.properties.polygon_id ?? p.properties.__pid,
      lng: p.geometry.coordinates[0],
      lat: p.geometry.coordinates[1],
      scores: scores[j],
      properties: p.properties,
    };
  });

  return {
    rows,
    explained,
    cumulative,
    dates,
    interpolatedFraction: totalCells > 0 ? interpolatedCells / totalCells : 0,
    loadings,
    metric,
    components,
    droppedPixels: projectPixels.length - kept.length,
    fitZones: Array.from(fitSet),
    projectZones: Array.from(projectSet),
    fitCount: fitMatrix.length,
    method,
    subsampled: rows.length < kept.length,
  };
}

/** Serialize PCA scores to CSV for downstream analysis (R, Python…). */
export function pcaScoresToCsv(result: PcaRunResult): string {
  // Species-mix columns: name the axis species from the first unmixed pixel.
  const axisRow = result.rows.find(r => typeof r.properties?.mix_frac_a === 'number');
  const spA = axisRow?.properties?.mix_a_species ?? 'A';
  const spB = axisRow?.properties?.mix_b_species ?? 'B';
  const header = [
    'pixel_id',
    'polygon_id',
    'zone',
    'lng',
    'lat',
    `frac_${spA}`,
    `frac_${spB}`,
    'mix_residual',
    ...result.explained.map((_, i) => `PC${i + 1}`),
  ];
  const lines = [header.join(',')];
  for (const row of result.rows) {
    const fa = row.properties?.mix_frac_a;
    lines.push(
      [
        row.pixelId,
        row.polygonId ?? '',
        row.zone,
        row.lng.toFixed(6),
        row.lat.toFixed(6),
        typeof fa === 'number' ? fa.toFixed(4) : '',
        typeof fa === 'number' ? (1 - fa).toFixed(4) : '',
        typeof row.properties?.mix_residual === 'number' ? row.properties.mix_residual.toFixed(4) : '',
        ...row.scores.map(s => s.toFixed(6)),
      ].join(',')
    );
  }
  return lines.join('\n');
}
