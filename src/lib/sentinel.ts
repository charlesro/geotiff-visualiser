import type { RasterLayer } from '../types';

/**
 * Single source of truth for the Sentinel-2 band domain.
 * Previously this mapping was copy-pasted in App.tsx (twice) and
 * geotiff-utils.ts (twice more).
 */

/** Sentinel-2 band number -> STAC asset key. */
export const S2_BAND_TO_ASSET: Record<number, string> = {
  1: 'B01', 2: 'B02', 3: 'B03', 4: 'B04', 5: 'B05', 6: 'B06',
  7: 'B07', 8: 'B08', 9: 'B8A', 10: 'B09', 11: 'B11', 12: 'B12'
};

export const getAssetKey = (bandNum: number): string => S2_BAND_TO_ASSET[bandNum] || 'B04';

/** Every spectral asset we may want to reference on a STAC item. */
export const S2_ALL_ASSETS = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B09', 'B11', 'B12'];

/** Band numbers exposed in band selectors for STAC-backed layers. */
export const S2_SELECTABLE_BANDS = [2, 3, 4, 5, 6, 7, 8, 9, 11, 12];

export const S2_BAND_NAMES: Record<number, string> = {
  1: 'B01 (Coastal)', 2: 'B02 (Blue)', 3: 'B03 (Green)', 4: 'B04 (Red)',
  5: 'B05 (Red Edge 1)', 6: 'B06 (Red Edge 2)', 7: 'B07 (Red Edge 3)',
  8: 'B08 (NIR)', 9: 'B8A (Narrow NIR)', 10: 'B09 (Water Vapour)',
  11: 'B11 (SWIR 1)', 12: 'B12 (SWIR 2)'
};

/** Bands a layer can render, depending on its source. */
export const getBandOptions = (layer: RasterLayer): number[] => {
  if (layer.stacItem) {
    return S2_SELECTABLE_BANDS;
  }
  return Array.from({ length: layer.data.metadata.bands }, (_, idx) => idx + 1);
};

/** Human readable band name for any layer source. */
export const getBandName = (layer: RasterLayer, bandIndex: number): string => {
  if (layer.stacItem) {
    return S2_BAND_NAMES[bandIndex] || `Band ${bandIndex}`;
  } else if (layer.data.metadata.descriptions && layer.data.metadata.descriptions[bandIndex - 1]) {
    return layer.data.metadata.descriptions[bandIndex - 1];
  }
  return `Band ${bandIndex}`;
};
