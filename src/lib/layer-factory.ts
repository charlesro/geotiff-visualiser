import type { RasterLayer, VectorLayer } from '../types';
import type { GeoTIFFData, RenderingOptions } from './geotiff-utils';
import { getGeoJsonBounds, Bbox } from './geo';

/**
 * Layer construction and naming conventions.
 *
 * Every data source (local file upload, STAC browser fetch, local Python
 * server) builds its layers through these factories, so layers behave
 * consistently regardless of where they came from. The "Pixels" layer
 * naming/id convention used by pixel extraction, the feature panel, the
 * layer manager and the map renderer is also defined once here.
 */

export const DEFAULT_OPTIONS: RenderingOptions = {
  mode: 'rgb',
  bands: [4, 3, 2], // Sentinel-2 RGB: B04, B03, B02
  singleBand: 8, // Default to NIR
  indexType: 'ndvi',
  indexBands: { red: 4, green: 3, blue: 2, nir: 8 }, // Sentinel-2: B04, B03, B02, B08
  stretch: 'percentile',
  percentiles: [2, 98],
  opacity: 0.8,
  colormap: 'grayscale',
  showGrid: false,
  gridSpacing: 1
};

export interface CreateRasterLayerArgs {
  name: string;
  data: GeoTIFFData;
  id?: string;
  visible?: boolean;
  opacity?: number;
  options?: RenderingOptions;
  dataUrl?: string;
  seriesId?: string;
  datetime?: string;
  clipBbox?: Bbox | null;
  remoteUrls?: Record<string, string>;
  remoteBbox?: Bbox;
  stacItem?: any;
  originalSource?: any;
  originalBuffer?: ArrayBuffer;
}

/** Single factory for raster layers, whatever the data source. */
export function createRasterLayer(args: CreateRasterLayerArgs): RasterLayer {
  return {
    id: args.id ?? crypto.randomUUID(),
    name: args.name,
    type: 'raster',
    visible: args.visible ?? true,
    opacity: args.opacity ?? 0.8,
    data: args.data,
    dataUrl: args.dataUrl ?? args.data.image.toDataURL(),
    options: args.options ?? { ...DEFAULT_OPTIONS },
    seriesId: args.seriesId,
    datetime: args.datetime,
    clipBbox: args.clipBbox,
    remoteUrls: args.remoteUrls,
    remoteBbox: args.remoteBbox,
    stacItem: args.stacItem,
    originalSource: args.originalSource,
    originalBuffer: args.originalBuffer,
  };
}

/** Single factory for vector layers (uploaded shapefiles, query results, pixel layers). */
export function createVectorLayer(
  name: string,
  geojson: any,
  id?: string,
  opts: { visible?: boolean; opacity?: number } = {}
): VectorLayer {
  return {
    id: id || `vector-${Date.now()}`,
    name,
    type: 'vector',
    visible: opts.visible ?? true,
    opacity: opts.opacity ?? 1,
    data: geojson,
    bbox: getGeoJsonBounds(geojson) || undefined
  };
}

// ---------------------------------------------------------------------------
// "Pixels" layer convention (extracted pixel time-series stored as vectors)
// ---------------------------------------------------------------------------

export const PIXELS_LAYER_ID_PREFIX = 'pixels-';
export const PIXELS_LAYER_NAME_PREFIX = 'Pixels';

/** True if a layer holds extracted pixel time-series points. */
export const isPixelsLayer = (l: any): boolean =>
  !!l && (l.id?.startsWith(PIXELS_LAYER_ID_PREFIX) || l.name?.startsWith(PIXELS_LAYER_NAME_PREFIX));

/** Stable layer id for the pixels extracted from a given feature. */
export const pixelsLayerId = (featureId?: string | number): string =>
  `${PIXELS_LAYER_ID_PREFIX}${featureId ?? 'extract'}`;

/** Stable layer id for the excluded (buffer ring) pixels of a given feature. */
export const excludedPixelsLayerId = (featureId?: string | number): string =>
  `pixels-excluded-${featureId ?? 'extract'}`;

/** Best human-readable name for a GeoJSON feature. */
export const getFeatureDisplayName = (feature: any): string =>
  feature?.properties?.name || feature?.properties?.Name || feature?.properties?.id || feature?.id || 'Field';

/** Display name for a pixels layer: `Pixels (NDVI) [Field 12] +10m`. */
export const formatPixelsLayerName = (
  indexType: string,
  nameAttr: string,
  bufferMeters = 0,
  excluded = false
): string =>
  `${excluded ? 'Excluded Pixels' : PIXELS_LAYER_NAME_PREFIX} (${indexType}) [${nameAttr}] ${bufferMeters !== 0 ? (bufferMeters > 0 ? '+' : '') + bufferMeters + 'm' : ''}`.trim();

/** Trigger a browser download of GeoJSON data. */
export function downloadGeoJson(data: any, name: string): void {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data));
  const a = document.createElement('a');
  a.setAttribute('href', dataStr);
  a.setAttribute('download', `${name}.geojson`);
  document.body.appendChild(a);
  a.click();
  a.remove();
}
