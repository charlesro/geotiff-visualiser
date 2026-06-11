/**
 * Vegetation index formulas — the single implementation.
 * Previously NDVI/EVI/GNDVI/SAVI were implemented independently in
 * geotiff-utils.ts (twice), pixel-extraction.ts and pca-utils.ts.
 */

export type SpectralIndexType = 'ndvi' | 'evi' | 'gndvi' | 'savi';

export interface ComputeIndexOptions {
  /**
   * Soil/atmosphere constant in the EVI denominator. Use 1 for 0–1
   * reflectance and 10000 for raw Sentinel-2 digital numbers (0–10000).
   */
  eviConstant?: number;
  /**
   * When true (default), NaN red/NIR inputs yield 0 — matching the rendering
   * pipelines. When false, NaN propagates — matching the extraction pipeline.
   */
  nanToZero?: boolean;
}

/** Compute one vegetation index value for a single pixel. */
export function computeIndexValue(
  type: SpectralIndexType,
  red: number,
  green: number | undefined,
  blue: number | undefined,
  nir: number,
  options: ComputeIndexOptions = {}
): number {
  const { eviConstant = 1, nanToZero = true } = options;

  if (nanToZero && (isNaN(red) || isNaN(nir))) return 0;

  switch (type) {
    case 'ndvi':
      return (nir - red) / (nir + red || 1);
    case 'evi':
      if (blue === undefined || isNaN(blue)) {
        // Fallback to NDVI if blue is missing
        return (nir - red) / (nir + red || 1);
      }
      return 2.5 * ((nir - red) / (nir + 6 * red - 7.5 * blue + eviConstant || 1));
    case 'gndvi':
      if (green === undefined || isNaN(green)) {
        // Fallback to NDVI if green is missing
        return (nir - red) / (nir + red || 1);
      }
      return (nir - green) / (nir + green || 1);
    case 'savi': {
      const L = 0.5;
      return ((nir - red) / (nir + red + L || 1)) * (1 + L);
    }
    default:
      return 0;
  }
}

/** Display strings for the UI — kept next to the formulas they describe. */
export const INDEX_FORMULAS: Record<SpectralIndexType, string> = {
  ndvi: '(NIR - Red) / (NIR + Red)',
  evi: '2.5 * ((NIR - Red) / (NIR + 6 * Red - 7.5 * Blue + 1))',
  gndvi: '(NIR - Green) / (NIR + Green)',
  savi: '((NIR - Red) / (NIR + Red + 0.5)) * (1 + 0.5)',
};
