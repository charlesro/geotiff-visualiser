import * as fromGeoTIFF from 'geotiff';
import { getAssetKey } from './sentinel';

/**
 * GeoTIFF caching and the shared raster types.
 *
 * The live imagery path fetches Sentinel-2 COGs through {@link getCachedTiff}
 * (see mosaic.ts), renders them with raster-render.ts and stores the result
 * as a {@link GeoTIFFData}. {@link RenderingOptions} is the band/stretch/index
 * recipe consumed by the renderer.
 */

// Re-export so existing imports keep working; the definition lives in sentinel.ts.
export { getAssetKey };

const tiffCache = new Map<string, Promise<any>>();

export function getCachedTiff(url: string): Promise<any> {
  const cleanUrl = url.split('?')[0]; // Cache by base URL
  if (tiffCache.has(cleanUrl)) {
    return tiffCache.get(cleanUrl)!;
  }
  const actualPromise = fromGeoTIFF.fromUrl(url).catch(e => {
    tiffCache.delete(cleanUrl);
    throw e;
  });
  tiffCache.set(cleanUrl, actualPromise);
  return actualPromise;
}

/**
 * Drop the cached GeoTIFF objects (and their fetched-block caches). Called
 * between scenes of a series download: blocks of one date's COGs are never
 * reused for another date, and hundreds of small window reads would
 * otherwise keep all downloaded blocks in memory.
 */
export function clearTiffCache(): void {
  tiffCache.clear();
}

/** Drop one cached GeoTIFF (by its base URL) so a failed read can refetch it. */
export function evictTiff(url: string): void {
  tiffCache.delete(url.split('?')[0]);
}

export interface RenderingOptions {
  mode: 'rgb' | 'single' | 'index';
  bands: [number, number, number]; // 1-based indices
  singleBand: number;
  indexType: 'ndvi' | 'evi' | 'gndvi' | 'savi';
  indexBands: {
    red: number;
    green: number;
    blue: number;
    nir: number;
  };
  stretch: 'percentile' | 'minmax' | 'none';
  percentiles: [number, number];
  opacity: number;
  colormap: 'grayscale' | 'viridis' | 'magma' | 'inferno' | 'rdylgn';
  showGrid: boolean;
  gridSpacing: number; // in pixels of original image
  bandMap?: Record<number, number>; // maps standard indices (like 4 for B04) to actual geotiff band index (0-based)
}

export interface GeoTIFFData {
  image: HTMLCanvasElement;
  bounds: [[number, number], [number, number]]; // [[lat, lng], [lat, lng]]
  metadata: {
    width: number;
    height: number;
    bands: number;
    crs?: string;
    descriptions?: string[];
    resolution?: [number, number]; // [xRes, yRes] in CRS units
    imageBbox?: [number, number, number, number]; // [minX, minY, maxX, maxY] in CRS
    originalBbox?: [number, number, number, number];
    originalWidth?: number;
    originalHeight?: number;
    windowWidth?: number;
    windowHeight?: number;
    windowOffsetX?: number;
    windowOffsetY?: number;
  };
  rawBuffer: ArrayBuffer; // Keep buffer for re-processing
  originalSource?: any; // Blob, ArrayBuffer, or string URL
  bandData?: Record<string, Float32Array>; // Cache for remote band data
  imageBbox?: [number, number, number, number]; // [minX, minY, maxX, maxY] in CRS
}
