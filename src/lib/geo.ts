import proj4 from 'proj4';

/**
 * Shared geospatial primitives.
 *
 * Every feature (local GeoTIFF processing, remote COG fetching, pixel
 * extraction, zonal statistics, cropping) goes through these helpers instead
 * of carrying its own copy of the projection / bbox math.
 */

/** [minX/minLng, minY/minLat, maxX/maxLng, maxY/maxLat] */
export type Bbox = [number, number, number, number];

/**
 * Resolve a CRS identifier to a proj4-compatible definition.
 * UTM zones (EPSG:326xx / 327xx) are built manually since proj4 does not
 * ship their definitions.
 */
export function crsToProj4Def(crs: string): string {
  if (crs.startsWith('EPSG:326') || crs.startsWith('EPSG:327')) {
    const zone = parseInt(crs.slice(8));
    const isSouth = crs.startsWith('EPSG:327');
    return `+proj=utm +zone=${zone} ${isSouth ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
  }
  return crs;
}

/** Derive a CRS string from geotiff.js geoKeys. */
export function crsFromGeoKeys(geoKeys: any): string {
  if (geoKeys && geoKeys.ProjectedCSTypeGeoKey) {
    return `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
  }
  if (geoKeys && geoKeys.GeographicTypeGeoKey) {
    return `EPSG:${geoKeys.GeographicTypeGeoKey}`;
  }
  return 'EPSG:4326';
}

/** Project WGS84 lng/lat into the given CRS. */
export function projectToCrs(crs: string, lng: number, lat: number): [number, number] {
  if (crs === 'EPSG:4326') return [lng, lat];
  return proj4('EPSG:4326', crsToProj4Def(crs), [lng, lat]) as [number, number];
}

/**
 * Unproject CRS coordinates back to WGS84 [lng, lat].
 * Falls back to the raw input if the transform fails (same defensive
 * behaviour the inlined copies had).
 */
export function unprojectToWgs84(crs: string | undefined, x: number, y: number): [number, number] {
  const crsVal = crs || 'EPSG:4326';
  if (crsVal === 'EPSG:4326') return [x, y];
  try {
    return proj4(crsToProj4Def(crsVal), 'EPSG:4326', [x, y]) as [number, number];
  } catch (e) {
    return [x, y];
  }
}

function envelope(points: [number, number][]): Bbox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Project a WGS84 bbox into CRS space (envelope of the 4 corners). */
export function projectBboxToCrs(bbox: Bbox, crs: string): Bbox {
  return envelope([
    projectToCrs(crs, bbox[0], bbox[1]),
    projectToCrs(crs, bbox[2], bbox[1]),
    projectToCrs(crs, bbox[2], bbox[3]),
    projectToCrs(crs, bbox[0], bbox[3]),
  ]);
}

/** Unproject a CRS bbox into WGS84 (envelope of the 4 corners). */
export function unprojectBboxToWgs84(bbox: Bbox, crs: string | undefined): Bbox {
  return envelope([
    unprojectToWgs84(crs, bbox[0], bbox[1]),
    unprojectToWgs84(crs, bbox[2], bbox[1]),
    unprojectToWgs84(crs, bbox[2], bbox[3]),
    unprojectToWgs84(crs, bbox[0], bbox[3]),
  ]);
}

/** Area of the intersection of two bboxes (0 when disjoint). */
export function getBboxIntersectionArea(bbox1: Bbox, bbox2: Bbox): number {
  const minX = Math.max(bbox1[0], bbox2[0]);
  const minY = Math.max(bbox1[1], bbox2[1]);
  const maxX = Math.min(bbox1[2], bbox2[2]);
  const maxY = Math.min(bbox1[3], bbox2[3]);
  if (maxX > minX && maxY > minY) {
    return (maxX - minX) * (maxY - minY);
  }
  return 0;
}

/** Bounds of any GeoJSON object (Feature, FeatureCollection or geometry). */
export const getGeoJsonBounds = (geojson: any): Bbox | null => {
  let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
  let hasCoords = false;

  const extractCoords = (coords: any[]) => {
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
      hasCoords = true;
    } else if (Array.isArray(coords)) {
      coords.forEach(extractCoords);
    }
  };

  if (geojson.type === 'FeatureCollection' && geojson.features) {
    geojson.features.forEach((f: any) => {
      if (f.geometry?.coordinates) extractCoords(f.geometry.coordinates);
    });
  } else if (geojson.geometry?.coordinates) {
    extractCoords(geojson.geometry.coordinates);
  } else if (geojson.coordinates) {
    extractCoords(geojson.coordinates);
  }

  return hasCoords ? [minLon, minLat, maxLon, maxLat] : null;
};

/** Expand a WGS84 bbox by a distance in meters. */
export function bufferBboxMeters(bbox: Bbox, bufferMeters: number): Bbox {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const latBuffer = bufferMeters / 111320;
  const lonBuffer = Math.abs(bufferMeters / (111320 * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180))) || latBuffer;
  return [
    minLon - lonBuffer,
    minLat - latBuffer,
    maxLon + lonBuffer,
    maxLat + latBuffer,
  ];
}

/** Approximate ground dimensions of a WGS84 bbox (assumes 10 m/px, Sentinel-2). */
export function getBboxDimensions(bbox: Bbox) {
  const [west, south, east, north] = bbox;
  const lat = (south + north) / 2;
  const lonDiff = Math.abs(east - west);
  const latDiff = Math.abs(north - south);

  const widthMeters = lonDiff * 111320 * Math.cos(lat * Math.PI / 180);
  const heightMeters = latDiff * 111320;

  const widthPixels = Math.round(widthMeters / 10);
  const heightPixels = Math.round(heightMeters / 10);

  return { widthPixels, heightPixels, widthMeters, heightMeters };
}
