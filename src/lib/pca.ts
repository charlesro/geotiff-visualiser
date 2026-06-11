import { PCA } from 'ml-pca';
import { PixelZone } from './zones';

/**
 * PCA on pixel time series.
 *
 * Each pixel is one observation; its features are the index values at every
 * acquisition date (properties following the `<metric>_<date>` convention,
 * see lib/timeseries.ts). Pixels missing values on the retained dates are
 * dropped so the matrix is complete.
 */

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
}

/** Keep dates observed on at least this fraction of pixels. */
const DATE_COVERAGE_THRESHOLD = 0.8;

export function runPixelPca(pixelFeatures: any[], metric: string): PcaRunResult {
  const pixels = pixelFeatures.filter(f => f.geometry?.type === 'Point' && f.properties?.id);
  if (pixels.length < 10) {
    throw new Error(`Only ${pixels.length} pixels available — too few for a meaningful PCA.`);
  }

  // Collect candidate dates and their coverage across pixels.
  const prefix = `${metric}_`;
  const dateCounts = new Map<string, number>();
  for (const p of pixels) {
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
    .filter(([, count]) => count >= pixels.length * DATE_COVERAGE_THRESHOLD)
    .map(([date]) => date)
    .sort();

  if (dates.length < 3) {
    throw new Error(
      `Only ${dates.length} usable acquisition date(s) across the pixel set — at least 3 are needed. Fetch more scenes or relax the cloud-cover limit.`
    );
  }

  // Complete-case matrix: drop pixels missing any retained date.
  const matrix: number[][] = [];
  const kept: any[] = [];
  for (const p of pixels) {
    const row: number[] = [];
    let complete = true;
    for (const date of dates) {
      const value = p.properties[prefix + date];
      if (typeof value !== 'number' || !isFinite(value)) {
        complete = false;
        break;
      }
      row.push(value);
    }
    if (complete) {
      matrix.push(row);
      kept.push(p);
    }
  }

  if (matrix.length < 10) {
    throw new Error(
      `Only ${matrix.length} pixels have complete time series over the ${dates.length} retained dates. Fetch less cloudy scenes.`
    );
  }

  const components = Math.min(3, dates.length);
  const pca = new PCA(matrix, { center: true, scale: false });
  const projected = pca.predict(matrix, { nComponents: components }).to2DArray();
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
    zone: (p.properties.zone as PixelZone) || 'interior',
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
    droppedPixels: pixels.length - kept.length,
  };
}

/** Serialize PCA scores to CSV for downstream analysis (R, Python…). */
export function pcaScoresToCsv(result: PcaRunResult): string {
  const header = ['pixel_id', 'polygon_id', 'zone', 'lng', 'lat', ...result.explained.map((_, i) => `PC${i + 1}`)];
  const lines = [header.join(',')];
  for (const row of result.rows) {
    lines.push(
      [
        row.pixelId,
        row.polygonId ?? '',
        row.zone,
        row.lng.toFixed(6),
        row.lat.toFixed(6),
        ...row.scores.map(s => s.toFixed(6)),
      ].join(',')
    );
  }
  return lines.join('\n');
}
