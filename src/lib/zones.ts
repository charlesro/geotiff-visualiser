import { RasterLayer } from '../types';
import { extractPixelTimeseriesOptions } from './pixel-extraction';
import { polygonLabel } from './polygon-source';

/**
 * Buffer-zone pixel extraction.
 *
 * For every selected polygon the Sentinel-2 pixels are split by distance to
 * the polygon boundary:
 *   - interior: at least `distance` metres inside the boundary
 *   - edge:     inside the polygon but closer than `distance` to the boundary
 *     (optionally also the ring up to `distance` outside the boundary)
 *
 * Implemented on top of extractPixelTimeseriesOptions: a negative buffer
 * makes the inward-shrunk polygon the "core" (its pixels are the interior
 * set, the remainder of the polygon the edge set); a positive buffer adds
 * the outside ring.
 */

export type PixelZone = 'interior' | 'edge';

export interface ZoneExtraction {
  /** Point features, one per pixel, with `zone` and `<metric>_<date>` properties. */
  interior: any;
  edge: any;
  /** Dashed helper geometries: the inward-shrunk boundaries. */
  boundaries: any;
  perPolygon: { pid: number; label: string; interior: number; edge: number }[];
  metric: string;
  distance: number;
  includeOutside: boolean;
  /** Sorted acquisition dates covered by the extracted series. */
  dates: string[];
}

export interface ZoneProgress {
  done: number;
  total: number;
  label: string;
}

const notBoundary = (f: any) => f.properties?.type !== 'buffer_boundary';

export async function extractZones(
  features: any[],
  layers: RasterLayer[],
  distance: number,
  metric: string,
  includeOutside: boolean,
  onProgress: (p: ZoneProgress) => void
): Promise<ZoneExtraction> {
  if (features.length === 0) throw new Error('No polygons selected.');
  if (layers.length === 0) throw new Error('No imagery fetched.');
  if (distance <= 0) throw new Error('Buffer distance must be positive.');

  const interiorPoints: any[] = [];
  const edgePoints: any[] = [];
  const boundaryFeatures: any[] = [];
  const perPolygon: ZoneExtraction['perPolygon'] = [];
  const dates = new Set<string>();

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const label = polygonLabel(feature);
    onProgress({ done: i, total: features.length, label });
    // Per-polygon extraction is mostly synchronous now; yield regularly so
    // the progress bar repaints.
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));

    // Negative buffer: pixels inside the shrunk core vs the inner edge band.
    const inner = await extractPixelTimeseriesOptions(feature, layers, -distance, metric);
    for (const row of inner.timeseries) {
      if (row.date && row.date !== 'Unknown') dates.add(row.date);
    }

    const interior = inner.pixelPoints.features.filter(notBoundary);
    const edge = (inner.excludedPixelPoints?.features || []).filter(notBoundary);

    // The shrunk-core outline, useful on the map to see where the split is.
    const coreBoundary = inner.pixelPoints.features.find((f: any) => !notBoundary(f));
    if (coreBoundary) boundaryFeatures.push(coreBoundary);

    if (includeOutside) {
      // Positive buffer: the excluded set is the ring outside the boundary.
      const outer = await extractPixelTimeseriesOptions(feature, layers, distance, metric);
      edge.push(...(outer.excludedPixelPoints?.features || []).filter(notBoundary));
    }

    for (const p of interior) p.properties.zone = 'interior';
    for (const p of edge) p.properties.zone = 'edge';

    interiorPoints.push(...interior);
    edgePoints.push(...edge);
    perPolygon.push({
      pid: feature.properties?.__pid ?? i,
      label,
      interior: interior.length,
      edge: edge.length,
    });
  }

  onProgress({ done: features.length, total: features.length, label: 'Done' });

  if (interiorPoints.length + edgePoints.length === 0) {
    throw new Error(
      'No pixels found inside the selected polygons. Make sure the fetched imagery covers the selection.'
    );
  }

  return {
    interior: { type: 'FeatureCollection', features: interiorPoints },
    edge: { type: 'FeatureCollection', features: edgePoints },
    boundaries: { type: 'FeatureCollection', features: boundaryFeatures },
    perPolygon,
    metric,
    distance,
    includeOutside,
    dates: Array.from(dates).sort(),
  };
}
