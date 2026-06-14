import type { RasterLayer } from '../types';
import type { GeoTIFFData, RenderingOptions } from './geotiff-utils';
import { Bbox } from './geo';

/**
 * Raster-layer construction. The Sentinel-2 series fetch builds every scene
 * through {@link createRasterLayer} so layers carry a consistent shape, with
 * {@link DEFAULT_OPTIONS} as the default render recipe.
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
  analysisGrids?: GeoTIFFData[];
}

/** Single factory for raster layers, whatever the data source. */
export function createRasterLayer(args: CreateRasterLayerArgs): RasterLayer {
  return {
    id: args.id ?? crypto.randomUUID(),
    name: args.name,
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
    analysisGrids: args.analysisGrids,
  };
}
