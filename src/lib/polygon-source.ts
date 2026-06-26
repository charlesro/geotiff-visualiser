import { parse as parseWkt } from 'wellknown';
import shp from 'shpjs';
import { runLocalQuery } from '../services/local-server';

/**
 * Polygon ingestion — the single entry point of the workflow.
 *
 * Polygons come either from the local DuckDB engine (SQL query whose result
 * contains a WKT or GeoJSON geometry column) or from a file (GeoJSON or
 * zipped shapefile). Both paths produce the same normalised
 * FeatureCollection: only Polygon/MultiPolygon features, each with a stable
 * numeric id stored both as `feature.id` and `properties.__pid`.
 */

export interface PolygonLoadResult {
  collection: any;
  /** Non-geometry attribute columns found on the features. */
  attributes: string[];
  /** How many input rows/features were skipped (no usable polygon geometry). */
  skipped: number;
}

const GEOMETRY_KEY_HINTS = ['geometry_wkt', 'wkt', 'geometry', 'geom', 'shape', 'the_geom'];
const WKT_POLYGON_REGEX = /^\s*(SRID=\d+\s*;\s*)?(MULTI)?POLYGON/i;

function parseGeometryValue(value: any): any | null {
  if (!value) return null;
  if (typeof value === 'object' && value.type && value.coordinates) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (WKT_POLYGON_REGEX.test(trimmed)) {
      try {
        return parseWkt(trimmed.replace(/^SRID=\d+\s*;\s*/i, ''));
      } catch {
        return null;
      }
    }
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && obj.type && obj.coordinates) return obj;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function findGeometryKey(row: Record<string, any>): string | null {
  const keys = Object.keys(row);
  for (const hint of GEOMETRY_KEY_HINTS) {
    const match = keys.find(k => k.toLowerCase() === hint);
    if (match && parseGeometryValue(row[match])) return match;
  }
  return keys.find(k => parseGeometryValue(row[k]) !== null) ?? null;
}

const isPolygonal = (geom: any): boolean =>
  !!geom && (geom.type === 'Polygon' || geom.type === 'MultiPolygon');

/** Normalise any feature list into the workflow FeatureCollection. */
function normalizeFeatures(rawFeatures: { geometry: any; properties: Record<string, any> }[]): PolygonLoadResult {
  const features: any[] = [];
  let skipped = 0;
  const attributes = new Set<string>();
  // The neighbour-pairs/clusters query emits long format — one row per field
  // per pair — so a field bordering several cross-species fields arrives as
  // several rows sharing one NewID and identical geometry. Collapse them to a
  // single feature (keeping the first row, whose pair metadata — role_in_pair /
  // neighbor_id / pair_id — is what the UI shows) so each field is fetched,
  // extracted and projected exactly once. Features without a NewID (e.g. a
  // generic GeoJSON/shapefile) carry no field identity and are all kept.
  const seenIds = new Set<string>();

  for (const raw of rawFeatures) {
    if (!isPolygonal(raw.geometry)) {
      skipped++;
      continue;
    }
    const newId = raw.properties?.NewID;
    if (newId != null && newId !== '') {
      const key = String(newId);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
    }
    const pid = features.length;
    const properties = { ...raw.properties, __pid: pid };
    Object.keys(raw.properties || {}).forEach(k => attributes.add(k));
    features.push({ type: 'Feature', id: pid, geometry: raw.geometry, properties });
  }

  return {
    collection: { type: 'FeatureCollection', features },
    attributes: Array.from(attributes),
    skipped,
  };
}

/** Run a SQL query against the local DuckDB engine and parse polygons out of it. */
export async function loadPolygonsFromDatabase(
  baseUrl: string,
  sql: string,
  signal?: AbortSignal,
  /** Optional post-query row filter (e.g. keep only spanning clusters). */
  filterRows?: (rows: any[]) => any[]
): Promise<PolygonLoadResult> {
  const data = await runLocalQuery(baseUrl, sql, signal);
  let rows: any[] = data.rows || [];
  if (rows.length === 0) {
    throw new Error('The query returned no rows.');
  }
  if (filterRows) {
    rows = filterRows(rows);
    if (rows.length === 0) {
      throw new Error(
        'No cluster spans every chosen species. Raise the neighbour distance / max pairs, or pick species that actually border each other.'
      );
    }
  }

  const geometryKey = findGeometryKey(rows[0]);
  if (!geometryKey) {
    throw new Error(
      'No geometry column found in the result. Return a WKT column, e.g. ST_AsText(geometry) AS geometry_wkt.'
    );
  }

  const result = normalizeFeatures(
    rows.map(row => {
      const { [geometryKey]: geomValue, ...properties } = row;
      return { geometry: parseGeometryValue(geomValue), properties };
    })
  );

  if (result.collection.features.length === 0) {
    throw new Error('The query returned rows, but none contained a Polygon or MultiPolygon geometry.');
  }
  return result;
}

/**
 * Add `addition`'s features to an existing collection, de-duplicating by NewID
 * (falling back to geometry). Existing features keep their `__pid` so any
 * current selection stays valid; only genuinely new fields get fresh ids.
 */
export function mergePolygonCollections(
  existing: any,
  addition: PolygonLoadResult
): { collection: any; addedCount: number } {
  const keyOf = (feat: any): string => {
    const id = feat?.properties?.NewID;
    return id != null ? `id:${id}` : `geo:${JSON.stringify(feat?.geometry)}`;
  };
  const features: any[] = [...(existing?.features || [])];
  const seen = new Set(features.map(keyOf));
  let nextPid = features.reduce((m, f) => Math.max(m, (f.properties?.__pid ?? -1) + 1), features.length);
  let addedCount = 0;
  for (const feat of addition.collection.features) {
    const key = keyOf(feat);
    if (seen.has(key)) continue;
    seen.add(key);
    const pid = nextPid++;
    features.push({ ...feat, id: pid, properties: { ...feat.properties, __pid: pid } });
    addedCount++;
  }
  return { collection: { type: 'FeatureCollection', features }, addedCount };
}

/** Load polygons from a .geojson/.json file or a zipped shapefile. */
export async function loadPolygonsFromFile(file: File): Promise<PolygonLoadResult> {
  let geojson: any;
  if (file.name.toLowerCase().endsWith('.zip')) {
    const parsed = await shp(await file.arrayBuffer());
    const collections = Array.isArray(parsed) ? parsed : [parsed];
    geojson = {
      type: 'FeatureCollection',
      features: collections.flatMap((fc: any) => fc.features || []),
    };
  } else {
    geojson = JSON.parse(await file.text());
  }

  let rawFeatures: any[];
  if (geojson.type === 'FeatureCollection') rawFeatures = geojson.features || [];
  else if (geojson.type === 'Feature') rawFeatures = [geojson];
  else if (geojson.type && geojson.coordinates) rawFeatures = [{ type: 'Feature', geometry: geojson, properties: {} }];
  else throw new Error('Unrecognised file content — expected GeoJSON or a zipped shapefile.');

  const result = normalizeFeatures(
    rawFeatures.map((f: any) => ({ geometry: f.geometry, properties: f.properties || {} }))
  );
  if (result.collection.features.length === 0) {
    throw new Error('No Polygon or MultiPolygon features found in the file.');
  }
  return result;
}

/** Best human-readable label for a polygon in lists and tooltips. */
export function polygonLabel(feature: any): string {
  const props = feature?.properties || {};
  // Neighbour-pairs rows: species + field id (+ which side of the pair).
  if (props.crp_lbl !== undefined && props.NewID !== undefined) {
    const role = props.role_in_pair === 'species_2' ? ' (2)' : props.role_in_pair === 'species_1' ? ' (1)' : '';
    return `${props.crp_lbl} · ${props.NewID}${role}`;
  }
  const candidates = ['name', 'nom', 'label', 'parcel', 'plot', 'code', 'id', 'newid'];
  for (const key of Object.keys(props)) {
    if (key === '__pid') continue;
    if (candidates.includes(key.toLowerCase())) {
      const v = props[key];
      if (v !== null && v !== undefined && v !== '') return String(v);
    }
  }
  return `Polygon ${(props.__pid ?? 0) + 1}`;
}
