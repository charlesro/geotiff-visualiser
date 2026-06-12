import { PCA } from 'ml-pca';
import { PixelZone } from './zones';

/**
 * PCA on pixel time series.
 *
 * Each pixel is one observation; its features are the index values at every
 * acquisition date (properties following the `<metric>_<date>` convention,
 * see lib/timeseries.ts). Pixels missing values on the retained dates are
 * dropped so the matrix is complete.
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
  /** Acquisition dates used as features, sorted ascending. */
  dates: string[];
  /** loadings[component][dateIndex] */
  loadings: number[][];
  metric: string;
  components: number;
  droppedPixels: number;
  /** Classes the axes were fit on, and how many pixels entered the fit. */
  fitZones: PixelZone[];
  projectZones: PixelZone[];
  fitCount: number;
}

/** Keep dates observed on at least this fraction of pixels. */
const DATE_COVERAGE_THRESHOLD = 0.8;

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

  // Candidate dates and their coverage across the fit pixels (the model).
  const prefix = `${metric}_`;
  const dateCounts = new Map<string, number>();
  for (const p of fitPixels) {
    for (const key of Object.keys(p.properties)) {
      if (key.startsWith(prefix)) {
        const value = p.properties[key];
        if (typeof value === 'number' && isFinite(value)) {
          const date = key.slice(prefix.length);
          dateCounts.set(date, (dateCounts.get(date) || 0) + 1);
        }
      }
    }
  }

  const dates = Array.from(dateCounts.entries())
    .filter(([, count]) => count >= fitPixels.length * DATE_COVERAGE_THRESHOLD)
    .map(([date]) => date)
    .sort();

  if (dates.length < 3) {
    throw new Error(
      `Only ${dates.length} usable acquisition date(s) across the fit pixels — at least 3 are needed. Fetch more scenes or relax the cloud-cover limit.`
    );
  }

  // Complete-case rows over the retained dates.
  const completeRow = (p: any): number[] | null => {
    const row: number[] = [];
    for (const date of dates) {
      const value = p.properties[prefix + date];
      if (typeof value !== 'number' || !isFinite(value)) return null;
      row.push(value);
    }
    return row;
  };

  const fitMatrix: number[][] = [];
  for (const p of fitPixels) {
    const row = completeRow(p);
    if (row) fitMatrix.push(row);
  }
  if (fitMatrix.length < 10) {
    throw new Error(
      `Only ${fitMatrix.length} fit pixels have complete time series over the ${dates.length} retained dates. Fetch less cloudy scenes.`
    );
  }

  const projMatrix: number[][] = [];
  const kept: any[] = [];
  for (const p of projectPixels) {
    const row = completeRow(p);
    if (row) {
      projMatrix.push(row);
      kept.push(p);
    }
  }
  if (kept.length === 0) {
    throw new Error('No pixel of the projected classes has a complete series over the retained dates.');
  }

  const components = Math.min(3, dates.length);
  // Fit on the fit classes only; predict() centers new data with the fit's
  // means, so projected pixels land in the same space.
  const pca = new PCA(fitMatrix, { center: true, scale: false });
  const projected = pca.predict(projMatrix, { nComponents: components }).to2DArray();
  const explainedFractions = pca.getExplainedVariance().slice(0, components);
  const explained = explainedFractions.map(v => v * 100);
  const cumulative = explained.reduce<number[]>((acc, v) => {
    acc.push((acc[acc.length - 1] || 0) + v);
    return acc;
  }, []);

  // ml-pca loadings: rows = components when transposed via getLoadings()
  const loadingsMatrix = pca.getLoadings().to2DArray();
  const loadings = loadingsMatrix.slice(0, components);

  const rows: PcaPixelScore[] = kept.map((p, i) => ({
    pixelId: p.properties.id,
    zone: zoneOf(p),
    polygonId: p.properties.polygon_id ?? p.properties.__pid,
    lng: p.geometry.coordinates[0],
    lat: p.geometry.coordinates[1],
    scores: projected[i],
    properties: p.properties,
  }));

  return {
    rows,
    explained,
    cumulative,
    dates,
    loadings,
    metric,
    components,
    droppedPixels: projectPixels.length - kept.length,
    fitZones: Array.from(fitSet),
    projectZones: Array.from(projectSet),
    fitCount: fitMatrix.length,
  };
}

/** Serialize PCA scores to CSV for downstream analysis (R, Python…). */
export function pcaScoresToCsv(result: PcaRunResult): string {
  const header = [
    'pixel_id',
    'polygon_id',
    'zone',
    'lng',
    'lat',
    'mix_fraction_own',
    'mix_partner',
    'mix_residual',
    ...result.explained.map((_, i) => `PC${i + 1}`),
  ];
  const lines = [header.join(',')];
  for (const row of result.rows) {
    const mf = row.properties?.mix_fraction;
    lines.push(
      [
        row.pixelId,
        row.polygonId ?? '',
        row.zone,
        row.lng.toFixed(6),
        row.lat.toFixed(6),
        typeof mf === 'number' ? mf.toFixed(4) : '',
        row.properties?.mix_partner ?? '',
        typeof row.properties?.mix_residual === 'number' ? row.properties.mix_residual.toFixed(4) : '',
        ...row.scores.map(s => s.toFixed(6)),
      ].join(',')
    );
  }
  return lines.join('\n');
}
