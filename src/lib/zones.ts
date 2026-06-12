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
 * using every loaded polygon as context. A neighbour only counts when it is
 * plausibly *directly across the boundary* from the pixel: its true distance
 * to the pixel must not exceed the pixel's own distance to its boundary plus
 * `neighbourGap` metres (the realistic boundary-to-neighbour separation).
 *   - edge_other_species: such a neighbour of another species exists
 *   - edge_same_species:  only such neighbours of the same species exist
 *   - edge_isolated:      nothing within reach (road, hedge, open land…)
 * Pixels across wider gaps (a road between the fields…) come out isolated
 * instead of inheriting a neighbour class from 30 m away.
 *
 * Pixels in the open gap between two facing fields (outside both polygons)
 * are also part of the boundary zone: the thin ring up to `neighbourGap`
 * outside each field is extracted, and a gap pixel is kept — as
 * edge_other_species / edge_same_species — when a neighbouring field lies
 * within reach and the pixel is inside no field. Each gap pixel is emitted
 * once even though it sits in the rings of both facing fields.
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
  /** Max boundary-to-neighbour separation (m) for the edge classes. */
  neighbourGap: number;
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

/** Outer rings + holes of a (Multi)Polygon, as [lng, lat] coordinate rings. */
const ringsOf = (f: any): number[][][] => {
  const g = f?.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat();
  return [];
};

/**
 * Distance (m) from a point to the closest ring segment, on a local
 * equirectangular projection — exact enough at field scale and much cheaper
 * than geodesic formulas.
 */
function distToBoundaryM(lng: number, lat: number, rings: number[][][]): number {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_540;
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = (ring[i][0] - lng) * kx;
      const ay = (ring[i][1] - lat) * ky;
      const bx = (ring[i + 1][0] - lng) * kx;
      const by = (ring[i + 1][1] - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d2 = px * px + py * py;
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best);
}

/**
 * Neighbour-aware classifier for edge pixels. Context polygons are
 * deduplicated by field identity and indexed by their padded bbox; ring
 * coordinates are extracted lazily only for polygons that pixels actually
 * come near. The caller passes the per-pixel reach: the pixel's distance to
 * its own boundary + the neighbour gap, so a neighbour only counts when it
 * sits directly across the boundary from that pixel.
 */
function buildEdgeClassifier(contextFeatures: any[], maxReach: number) {
  const M_PER_DEG = 111_320;
  interface Entry {
    bbox: Bbox;
    feature: any;
    key: string;
    species: string | null;
    rings?: number[][][];
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
    const dLat = maxReach / M_PER_DEG;
    const dLng = maxReach / (M_PER_DEG * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
    entries.push({
      bbox: [b[0] - dLng, b[1] - dLat, b[2] + dLng, b[3] + dLat],
      feature: f,
      key,
      species: speciesOf(f),
    });
  }

  const classify = (lng: number, lat: number, ownKey: string, ownSpecies: string | null, reach: number): EdgeClass => {
    let foundSame = false;
    for (const e of entries) {
      if (e.key === ownKey) continue;
      if (lng < e.bbox[0] || lng > e.bbox[2] || lat < e.bbox[1] || lat > e.bbox[3]) continue;
      if (e.rings === undefined) e.rings = ringsOf(e.feature);
      const d = booleanPointInPolygon([lng, lat], e.feature) ? 0 : distToBoundaryM(lng, lat, e.rings);
      if (d > reach) continue;
      if (e.species !== null && ownSpecies !== null) {
        if (e.species !== ownSpecies) return 'edge_other_species';
        foundSame = true;
      }
    }
    return foundSame ? 'edge_same_species' : 'edge_isolated';
  };

  /**
   * Classification for a pixel in the open gap between fields (outside its
   * own polygon). Returns null when the pixel is not really in a gap: inside
   * another field (that field's crop, not a gap) or with no neighbouring
   * field within reach (road verge, open land…).
   */
  const classifyGap = (
    lng: number,
    lat: number,
    ownKey: string,
    ownSpecies: string | null,
    reach: number
  ): EdgeClass | null => {
    let foundOther = false;
    let foundSame = false;
    for (const e of entries) {
      if (e.key === ownKey) continue;
      if (lng < e.bbox[0] || lng > e.bbox[2] || lat < e.bbox[1] || lat > e.bbox[3]) continue;
      if (e.rings === undefined) e.rings = ringsOf(e.feature);
      if (booleanPointInPolygon([lng, lat], e.feature)) return null; // inside another field
      const d = distToBoundaryM(lng, lat, e.rings);
      if (d > reach) continue;
      if (e.species !== null && ownSpecies !== null) {
        if (e.species !== ownSpecies) foundOther = true;
        else foundSame = true;
      }
    }
    return foundOther ? 'edge_other_species' : foundSame ? 'edge_same_species' : null;
  };

  return { classify, classifyGap };
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
  contextFeatures: any[] = [],
  /** Max boundary-to-neighbour separation (m) for the edge classes. */
  neighbourGap: number = 12
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

  const { classify: classifyEdge, classifyGap } = buildEdgeClassifier(
    contextFeatures.length > 0 ? contextFeatures : features,
    // Bbox prefilter bound: edge pixels lie within `distance` of their own
    // boundary (also outside when includeOutside), so their reach never
    // exceeds distance + gap.
    distance + neighbourGap
  );

  // Gap pixels can fall in the rings of both facing fields — emit them once.
  const seenGapIds = new Set<string>();

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

    // Pixels in the open gap between this field and a facing one (outside
    // both polygons) are part of the boundary zone: extract the thin outer
    // ring and keep only the pixels a neighbouring field really faces.
    const gapCandidates: any[] = [];
    if (!includeOutside && neighbourGap > 0) {
      const outer = await extractPixelTimeseriesOptions(feature, layers, neighbourGap, metric);
      gapCandidates.push(...(outer.excludedPixelPoints?.features || []).filter(notBoundary));
    }

    if (includeOutside) {
      // Positive buffer: the excluded set is the ring outside the boundary.
      const outer = await extractPixelTimeseriesOptions(feature, layers, distance, metric);
      edge.push(...(outer.excludedPixelPoints?.features || []).filter(notBoundary));
    }

    const ownKey = featureKey(feature);
    const ownSpecies = speciesOf(feature);
    const ownRings = ringsOf(feature);
    for (const p of interior) p.properties.zone = 'interior';
    for (const p of edge) {
      const [lng, lat] = p.geometry.coordinates;
      // A neighbour counts only if it can sit directly across the boundary
      // from this pixel: within its own boundary distance + the gap.
      const reach = distToBoundaryM(lng, lat, ownRings) + neighbourGap;
      const cls = classifyEdge(lng, lat, ownKey, ownSpecies, reach);
      p.properties.zone = cls;
      if (cls === 'edge_other_species') edgeCounts.other++;
      else if (cls === 'edge_same_species') edgeCounts.same++;
      else edgeCounts.isolated++;
    }

    for (const p of gapCandidates) {
      const id = p.properties?.id;
      if (id && seenGapIds.has(id)) continue;
      const [lng, lat] = p.geometry.coordinates;
      const reach = distToBoundaryM(lng, lat, ownRings) + neighbourGap;
      const cls = classifyGap(lng, lat, ownKey, ownSpecies, reach);
      if (!cls) continue; // not a gap pixel: inside a field, or nothing across
      if (id) seenGapIds.add(id);
      p.properties.zone = cls;
      if (cls === 'edge_other_species') edgeCounts.other++;
      else edgeCounts.same++;
      edge.push(p);
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
    neighbourGap,
    dates: Array.from(dates).sort(),
  };
}
