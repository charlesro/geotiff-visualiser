import { GeoTIFFData, RenderingOptions } from './lib/geotiff-utils';

export type LayerType = 'raster' | 'vector';

export interface BaseLayer {
  id: string;
  name: string;
  type: LayerType;
  visible: boolean;
  opacity: number;
  seriesId?: string;
  datetime?: string;
  clipBbox?: [number, number, number, number] | null;
}

export interface RasterLayer extends BaseLayer {
  type: 'raster';
  data: GeoTIFFData;
  options: RenderingOptions;
  dataUrl?: string;
  remoteUrls?: Record<string, string>;
  remoteBbox?: [number, number, number, number];
  stacItem?: any;
  originalBuffer?: ArrayBuffer;
  originalSource?: any;
  /**
   * Native-resolution (10 m) grids covering only the analysed polygons,
   * one per polygon cluster. When present, pixel extraction reads these
   * instead of `data` (which may be downsampled for large selections).
   */
  analysisGrids?: GeoTIFFData[];
}

export interface VectorLayer extends BaseLayer {
  type: 'vector';
  data: any; // GeoJSON
  bbox?: [number, number, number, number];
}

export type Layer = RasterLayer | VectorLayer;
