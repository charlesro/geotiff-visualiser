/**
 * Single source of truth for the Sentinel-2 band -> STAC asset mapping.
 */

/** Sentinel-2 band number -> STAC asset key. */
export const S2_BAND_TO_ASSET: Record<number, string> = {
  1: 'B01', 2: 'B02', 3: 'B03', 4: 'B04', 5: 'B05', 6: 'B06',
  7: 'B07', 8: 'B08', 9: 'B8A', 10: 'B09', 11: 'B11', 12: 'B12'
};

export const getAssetKey = (bandNum: number): string => S2_BAND_TO_ASSET[bandNum] || 'B04';
