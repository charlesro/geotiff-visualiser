import { GeoTIFFData, RenderingOptions } from './lib/geotiff-utils';

/** One fetched Sentinel-2 scene: a rendered preview plus its band data. */
export interface RasterLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  seriesId?: string;
  datetime?: string;
  clipBbox?: [number, number, number, number] | null;
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
