import buffer from '@turf/buffer';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { RasterLayer } from '../types';
import { extractPixelTimeseriesOptions } from './pixel-extraction';
import { polygonLabel } from './polygon-source';
import { getGeoJsonBounds, Bbox } from './geo';
import { CancelCheck, throwIfCancelled } from './cancel';

/**
 * Buffer-zone pixel extraction.
 *
 * For every selected polygon the Sentinel-2 pixels are split by distance to
 * the polygon boundary:
 *   - interior: at least `distance` metres inside the boundary
 *   - edge:     inside the polygon but closer than `distance` to the boundary
 *     (optionally also the ring up to `distance` outside the boundary)
 *
 * Edge pixels are further classified by what lies across the boundary,
 * using every loaded polygon as context:
 *   - edge_other_species: within `distance` of a field of another species
 *   - edge_same_species:  within `distance` of a field of the same species
 *   - edge_isolated:      no neighbouring field (road, hedge, open land…)
 * A pixel near both kinds of neighbour counts as edge_other_species.
 *
 * Implemented on top of extractPixelTimeseriesOptions: a negative buffer
 * makes the inward-shrunk polygon the "core" (its pixels are the interior
 * set, the remainder of the polygon the edge set); a positive buffer adds
 * the outside ring.
 */

export type PixelZone = 'interior' | 'edge_other_species' | 'edge_same_species' | 'edge_isolated';

export interface ZoneExtraction {
  /** Point features, one per pixel, with `zone` and `<metric>_<date>` properties. */
  interior: any;
  edge: any;
  /** Dashed helper geometries: the inward-shrunk boundaries. */
  boundaries: any;
  perPolygon: { pid: number; label: string; interior: number; edge: number }[];
  /** Edge pixels by neighbour class. */
  edgeCounts: { other: number; same: number; isolated: number };
  metric: string;
  distance: number;
  includeOutside: boolean;
  /** Sorted acquisition dates covered by the extracted series. */
  dates: string[];
}

const speciesOf = (f: any): string | null => f?.properties?.crp_lbl ?? f?.properties?.species ?? null;

type EdgeClass = 'edge_other_species' | 'edge_same_species' | 'edge_isolated';

/**
 * A polygon's identity: the same field can be loaded several times (the
 * neighbour-pairs query returns one row per field per pair), and a field
 * must never count as its own neighbour.
 */
const featureKey = (f: any): string => String(f?.properties?.NewID ?? `pid:${f?.properties?.__pid}`);

/**
 * Edge pixels sit up to `distance` inside their own boundary, and paired
 * fields have a boundary-to-boundary gap of ~10 m, so the neighbour search
 * has to reach further than `distance` from the pixel.
 */
const NEIGHBOUR_GAP_M = 15;

/**
 * Neighbour-aware classifier for edge pixels. Context polygons are
 * deduplicated by field identity and indexed by their padded bbox; the
 * buffered geometry is computed lazily only for polygons that pixels
 * actually come near.
 */
function buildEdgeClassifier(contextFeatures: any[], distance: number) {
  const M_PER_DEG = 111_320;
  const reach = distance + NEIGHBOUR_GAP_M;
  interface Entry {
    bbox: Bbox;
    feature: any;
    key: string;
    species: string | null;
    buffered: any; // undefined = not yet computed, null = failed
  }
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const f of contextFeatures) {
    const key = featureKey(f);
    if (seen.has(key)) continue;
    const b = getGeoJsonBounds(f);
    if (!b) continue;
    seen.add(key);
    const midLat = (b[1] + b[3]) / 2;
    const dLat = reach / M_PER_DEG;
    const dLng = reach / (M_PER_DEG * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
    entries.push({
      bbox: [b[0] - dLng, b[1] - dLat, b[2] + dLng, b[3] + dLat],
      feature: f,
      key,
      species: speciesOf(f),
      buffered: undefined,
    });
  }

  return (lng: number, lat: number, ownKey: string, ownSpecies: string | null): EdgeClass => {
    let foundSame = false;
    for (const e of entries) {
      if (e.key === ownKey) continue;
      if (lng < e.bbox[0] || lng > e.bbox[2] || lat < e.bbox[1] || lat > e.bbox[3]) continue;
      if (e.buffered === undefined) {
        try {
          e.buffered = buffer(e.feature, reach, { units: 'meters' }) || null;
        } catch {
          e.buffered = null;
        }
      }
      if (!e.buffered || !booleanPointInPolygon([lng, lat], e.buffered)) continue;
      if (e.species !== null && ownSpecies !== null) {
        if (e.species !== ownSpecies) return 'edge_other_species';
        foundSame = true;
      }
    }
    return foundSame ? 'edge_same_species' : 'edge_isolated';
  };
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
  onProgress: (p: ZoneProgress) => void,
  isCancelled?: CancelCheck,
  /** Every loaded polygon — the neighbour context for the edge classes. */
  contextFeatures: any[] = []
): Promise<ZoneExtraction> {
  if (features.length === 0) throw new Error('No polygons selected.');
  if (layers.length === 0) throw new Error('No imagery fetched.');
  if (distance <= 0) throw new Error('Buffer distance must be positive.');

  // The pairs query loads a field once per pair it belongs to; extract each
  // field once or its pixels would be duplicated into the PCA.
  const seenFields = new Set<string>();
  features = features.filter(f => {
    const key = featureKey(f);
    if (seenFields.has(key)) return false;
    seenFields.add(key);
    return true;
  });

  const classifyEdge = buildEdgeClassifier(
    contextFeatures.length > 0 ? contextFeatures : features,
    distance
  );

  const interiorPoints: any[] = [];
  const edgePoints: any[] = [];
  const boundaryFeatures: any[] = [];
  const perPolygon: ZoneExtraction['perPolygon'] = [];
  const edgeCounts = { other: 0, same: 0, isolated: 0 };
  const dates = new Set<string>();

  for (let i = 0; i < features.length; i++) {
    throwIfCancelled(isCancelled);
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

    const ownKey = featureKey(feature);
    const ownSpecies = speciesOf(feature);
    for (const p of interior) p.properties.zone = 'interior';
    for (const p of edge) {
      const [lng, lat] = p.geometry.coordinates;
      const cls = classifyEdge(lng, lat, ownKey, ownSpecies);
      p.properties.zone = cls;
      if (cls === 'edge_other_species') edgeCounts.other++;
      else if (cls === 'edge_same_species') edgeCounts.same++;
      else edgeCounts.isolated++;
    }

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
    edgeCounts,
    metric,
    distance,
    includeOutside,
    dates: Array.from(dates).sort(),
  };
}
