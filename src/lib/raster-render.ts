import type { RenderingOptions } from './geotiff-utils';
import { computeIndexValue } from './spectral';

/**
 * The single canvas rendering pipeline.
 *
 * Local GeoTIFFs (processGeoTIFF) and remote COGs (processRemoteGeoTIFF) both
 * render through this module. Previously each carried its own ~120-line copy
 * of the stretch + RGB/single/index loops, so fixes applied to one pipeline
 * silently missed the other.
 */

export const COLORMAPS: Record<string, (v: number) => number[]> = {
  grayscale: (v: number) => [v, v, v],
  viridis: (v: number) => {
    const f = v / 255;
    return [
      Math.round(255 * (0.267 + 0.667 * f - 0.651 * f * f + 0.166 * f * f * f)),
      Math.round(255 * (0.004 + 0.312 * f + 0.694 * f * f - 0.426 * f * f * f)),
      Math.round(255 * (0.329 + 0.884 * f - 0.948 * f * f + 0.396 * f * f * f))
    ];
  },
  magma: (v: number) => {
    const f = v / 255;
    return [
      Math.round(255 * (0.001 + 0.505 * f + 0.494 * f * f)),
      Math.round(255 * (0.001 + 0.187 * f + 0.281 * f * f)),
      Math.round(255 * (0.001 + 0.606 * f - 0.301 * f * f))
    ];
  },
  inferno: (v: number) => {
    const f = v / 255;
    return [
      Math.round(255 * (0.001 + 0.857 * f + 0.142 * f * f)),
      Math.round(255 * (0.001 + 0.125 * f + 0.454 * f * f)),
      Math.round(255 * (0.001 + 0.001 * f + 0.258 * f * f))
    ];
  },
  rdylgn: (v: number) => {
    // Red-Yellow-Green colormap for indices
    const f = v / 255;
    if (f < 0.5) {
      const t = f * 2;
      return [255, Math.round(255 * t), 0];
    } else {
      const t = (f - 0.5) * 2;
      return [Math.round(255 * (1 - t)), 255, 0];
    }
  }
};

/** Contrast-stretch raster values to 0–255 according to the rendering options. */
export function stretchToUint8(
  data: ArrayLike<number>,
  options: RenderingOptions,
  isIndex = false
): Uint8Array {
  const sampleSize = Math.min(data.length, 100000);
  if (sampleSize === 0) return new Uint8Array(data.length);

  let min = isIndex ? -1 : 0;
  let max = isIndex ? 1 : 255;

  if (options.stretch === 'percentile') {
    const sample = new Float32Array(sampleSize);
    let validCount = 0;
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      if (!isNaN(val) && val !== 0 && Math.random() < (sampleSize / data.length) && validCount < sampleSize) {
        sample[validCount++] = val;
      }
    }
    if (validCount > 0) {
      const sorted = sample.subarray(0, validCount).sort();
      min = sorted[Math.floor(sorted.length * (options.percentiles[0] / 100))];
      max = sorted[Math.floor(sorted.length * (options.percentiles[1] / 100))];
    }
  } else if (options.stretch === 'minmax') {
    min = Infinity;
    max = -Infinity;
    let hasValid = false;
    for (let i = 0; i < data.length; i++) {
      if (!isNaN(data[i])) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
        hasValid = true;
      }
    }
    if (!hasValid) {
      min = 0;
      max = 255;
    }
  }

  const stretched = new Uint8Array(data.length);
  const range = max - min || 1;
  for (let i = 0; i < data.length; i++) {
    if (isNaN(data[i])) {
      stretched[i] = 0;
      continue;
    }
    const val = ((data[i] - min) / range) * 255;
    stretched[i] = Math.max(0, Math.min(255, val));
  }
  return stretched;
}

/**
 * Render bands to a canvas in the requested mode.
 *
 * `getBand` resolves a 1-based standard band number to its raster data —
 * the local pipeline resolves against the file's band order (honouring
 * options.bandMap), the remote pipeline resolves Sentinel-2 asset names.
 * Both data sources therefore render identically by construction.
 */
export function renderRasterToCanvas(
  getBand: (bandNum: number) => ArrayLike<number>,
  options: RenderingOptions,
  width: number,
  height: number
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const imageData = ctx.createImageData(width, height);

  if (options.mode === 'rgb') {
    const rawR = getBand(options.bands[0]);
    const rawG = getBand(options.bands[1]);
    const rawB = getBand(options.bands[2]);

    const r = stretchToUint8(rawR, options);
    const g = stretchToUint8(rawG, options);
    const b = stretchToUint8(rawB, options);

    for (let i = 0; i < r.length; i++) {
      if (rawR[i] === 0 && rawG[i] === 0 && rawB[i] === 0) {
        imageData.data[i * 4] = 0;
        imageData.data[i * 4 + 1] = 0;
        imageData.data[i * 4 + 2] = 0;
        imageData.data[i * 4 + 3] = 0; // Transparent nodata
      } else {
        imageData.data[i * 4] = r[i];
        imageData.data[i * 4 + 1] = g[i];
        imageData.data[i * 4 + 2] = b[i];
        imageData.data[i * 4 + 3] = 255;
      }
    }
  } else if (options.mode === 'single') {
    const rawBand = getBand(options.singleBand);
    const bandData = stretchToUint8(rawBand, options);
    const colormapFn = COLORMAPS[options.colormap] || COLORMAPS.grayscale;

    for (let i = 0; i < bandData.length; i++) {
      if (rawBand[i] === 0) {
        imageData.data[i * 4] = 0;
        imageData.data[i * 4 + 1] = 0;
        imageData.data[i * 4 + 2] = 0;
        imageData.data[i * 4 + 3] = 0; // Transparent nodata
      } else {
        const [r, g, b] = colormapFn(bandData[i]);
        imageData.data[i * 4] = r;
        imageData.data[i * 4 + 1] = g;
        imageData.data[i * 4 + 2] = b;
        imageData.data[i * 4 + 3] = 255;
      }
    }
  } else if (options.mode === 'index') {
    const r = getBand(options.indexBands.red);
    const g = getBand(options.indexBands.green);
    const b = getBand(options.indexBands.blue);
    const nir = getBand(options.indexBands.nir);

    const indexData = new Float32Array(r.length);
    for (let i = 0; i < r.length; i++) {
      indexData[i] = computeIndexValue(options.indexType, r[i], g[i], b[i], nir[i]);
    }

    // Indices usually range from -1 to 1
    const bandData = stretchToUint8(indexData, options, true);
    const colormapFn = COLORMAPS[options.colormap] || COLORMAPS.rdylgn;

    for (let i = 0; i < bandData.length; i++) {
      const [cr, cg, cb] = colormapFn(bandData[i]);
      imageData.data[i * 4] = cr;
      imageData.data[i * 4 + 1] = cg;
      imageData.data[i * 4 + 2] = cb;
      imageData.data[i * 4 + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}
