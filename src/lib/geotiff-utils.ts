import * as fromGeoTIFF from 'geotiff';
import {
  crsFromGeoKeys,
  projectToCrs,
  projectBboxToCrs,
  unprojectToWgs84,
  unprojectBboxToWgs84,
} from './geo';
import { renderRasterToCanvas } from './raster-render';
import { getAssetKey } from './sentinel';

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

export interface ZonalPixelRecord {
  lat: number;
  lng: number;
  pixel_x: number;
  pixel_y: number;
  [key: string]: any; // Attributes and Band values
}

export interface RemoteBandResult {
  data: Float32Array | Uint16Array;
  width: number;
  height: number;
  pixelScale: [number, number, number];
  tiepoint: [number, number, number, number, number, number];
  geoKeys: number[] | Uint16Array | null;
  geoDoubleParams: number[] | Float64Array | null;
  geoAsciiParams: string | null;
}

export async function extractPixelValue(
  source: ArrayBuffer | string,
  lat: number,
  lng: number,
  crsVal: string,
  bboxVal: [number, number, number, number],
  widthVal: number,
  heightVal: number,
  bandIndex: number // 1-based
): Promise<number | null> {
  try {
    const tiff = typeof source === 'string' ? await getCachedTiff(source) : await fromGeoTIFF.fromArrayBuffer(source);
    const image = await tiff.getImage();

    // Project WGS84 to Image CRS
    const [x_crs, y_crs] = projectToCrs(crsVal, lng, lat);

    const [minX, minY, maxX, maxY] = bboxVal;

    // Check if point is within bounds
    if (x_crs < minX || x_crs > maxX || y_crs < minY || y_crs > maxY) {
      return null;
    }

    // Calculate pixel coordinates
    // Assuming origin is top-left (maxY is top, minY is bottom)
    const px = Math.floor(((x_crs - minX) / (maxX - minX)) * widthVal);
    const py = Math.floor(((maxY - y_crs) / (maxY - minY)) * heightVal);

    if (px < 0 || px >= widthVal || py < 0 || py >= heightVal) {
      return null;
    }

    // Read exactly 1 pixel
    const raster = await image.readRasters({
      window: [px, py, px + 1, py + 1],
      samples: [bandIndex - 1] // 0-based for geotiff.js
    });

    if (raster && raster[0] && raster[0].length > 0) {
      return raster[0][0];
    }
    return null;
  } catch (err) {
    console.error('Error extracting pixel value:', err);
    return null;
  }
}

export async function fetchRemoteBand(
  url: string,
  wgs84Bbox: [number, number, number, number],
  targetWidth: number,
  targetHeight: number,
  crsVal: string,
  bboxVal: [number, number, number, number],
  widthVal: number,
  heightVal: number,
  keepNativeResolution: boolean = false
): Promise<RemoteBandResult> {
  const tiff = await getCachedTiff(url);
  const image = await tiff.getImage();
  
  // Project WGS84 Bbox to Image CRS
  const [minX, minY] = projectToCrs(crsVal, wgs84Bbox[0], wgs84Bbox[1]);
  const [maxX, maxY] = projectToCrs(crsVal, wgs84Bbox[2], wgs84Bbox[3]);

  // Use actual image dimensions for window calculation
  const imgWidth = image.getWidth();
  const imgHeight = image.getHeight();

  const resX = (bboxVal[2] - bboxVal[0]) / imgWidth;
  const resY = (bboxVal[3] - bboxVal[1]) / imgHeight;

  // Snap to 20m grid to ensure 10m and 20m bands align perfectly
  const snapToGrid = 20;

  let safeTargetWidth = Math.max(1, Math.round(targetWidth));
  let safeTargetHeight = Math.max(1, Math.round(targetHeight));
  let left = 0;
  let top = 0;

  if (keepNativeResolution) {
    // For "Current Crop", snap the physical bounding box to the 20m grid
    const snappedMinX = bboxVal[0] + Math.floor((minX - bboxVal[0]) / snapToGrid) * snapToGrid;
    const snappedMaxY = bboxVal[3] - Math.floor((bboxVal[3] - maxY) / snapToGrid) * snapToGrid;
    const snappedMaxX = bboxVal[0] + Math.ceil((maxX - bboxVal[0]) / snapToGrid) * snapToGrid;
    const snappedMinY = bboxVal[3] - Math.ceil((bboxVal[3] - minY) / snapToGrid) * snapToGrid;

    left = Math.max(0, Math.round((snappedMinX - bboxVal[0]) / resX));
    top = Math.max(0, Math.round((bboxVal[3] - snappedMaxY) / resY));
    const right = Math.min(imgWidth, Math.round((snappedMaxX - bboxVal[0]) / resX));
    const bottom = Math.min(imgHeight, Math.round((bboxVal[3] - snappedMinY) / resY));

    safeTargetWidth = Math.max(1, right - left);
    safeTargetHeight = Math.max(1, bottom - top);
  } else {
    // For fixed size (e.g. 256x256), snap the center to the 20m grid
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    
    const snappedCenterX = bboxVal[0] + Math.round((centerX - bboxVal[0]) / snapToGrid) * snapToGrid;
    const snappedCenterY = bboxVal[3] - Math.round((bboxVal[3] - centerY) / snapToGrid) * snapToGrid;

    const centerPixelX = (snappedCenterX - bboxVal[0]) / resX;
    const centerPixelY = (bboxVal[3] - snappedCenterY) / resY;

    left = Math.round(centerPixelX - safeTargetWidth / 2);
    top = Math.round(centerPixelY - safeTargetHeight / 2);
  }

  const right = left + safeTargetWidth;
  const bottom = top + safeTargetHeight;

  const raster = await image.readRasters({
    window: [left, top, right, bottom],
    width: safeTargetWidth,
    height: safeTargetHeight,
    resampleMethod: 'nearest'
  });

  // The physical tiepoint is exactly the top-left of the pixel window
  const cropMinX = bboxVal[0] + left * resX;
  const cropMaxY = bboxVal[3] - top * resY;

  let geoKeys = (image as any).fileDirectory.GeoKeyDirectory || null;
  if (!geoKeys && crsVal && crsVal.startsWith('EPSG:')) {
    const epsgCode = parseInt(crsVal.split(':')[1]);
    if (!isNaN(epsgCode)) {
      if (epsgCode === 4326) {
        geoKeys = new Uint16Array([
          1, 1, 0, 3,
          1024, 0, 1, 2,
          1025, 0, 1, 1,
          2048, 0, 1, 4326
        ]);
      } else {
        geoKeys = new Uint16Array([
          1, 1, 0, 3,
          1024, 0, 1, 1,
          1025, 0, 1, 1,
          3072, 0, 1, epsgCode
        ]);
      }
    }
  }

  return {
    data: raster[0] as Float32Array | Uint16Array,
    width: safeTargetWidth,
    height: safeTargetHeight,
    pixelScale: [resX, resY, 0], // EXACT native resolution
    tiepoint: [0, 0, 0, cropMinX, cropMaxY, 0],
    geoKeys: geoKeys,
    geoDoubleParams: (image as any).fileDirectory.GeoDoubleParams || null,
    geoAsciiParams: (image as any).fileDirectory.GeoAsciiParams || null
  };
}

export function rasterToGeotiffBlob(
  data: Float32Array | Uint16Array,
  width: number,
  height: number,
  metadata: {
    pixelScale: [number, number, number];
    tiepoint: [number, number, number, number, number, number];
    geoKeys: number[] | Uint16Array | null;
    geoDoubleParams: number[] | Float64Array | null;
    geoAsciiParams: string | null;
  }
): Blob {
  const isFloat = data instanceof Float32Array;
  const bytesPerSample = isFloat ? 4 : 2;
  const sampleFormat = isFloat ? 3 : 1; // 3 = Float, 1 = Unsigned Int
  const bitsPerSample = bytesPerSample * 8;
  
  const imageDataByteCount = data.length * bytesPerSample;
  
  const hasGeoKeys = metadata.geoKeys && metadata.geoKeys.length > 0;
  const hasGeoDouble = metadata.geoDoubleParams && metadata.geoDoubleParams.length > 0;
  const hasGeoAscii = metadata.geoAsciiParams && metadata.geoAsciiParams.length > 0;
  
  let numTags = 13;
  if (hasGeoKeys) numTags++;
  if (hasGeoDouble) numTags++;
  if (hasGeoAscii) numTags++;
  
  const ifdSize = 2 + numTags * 12 + 4;
  
  let offsetCounter = 8 + ifdSize;
  
  const align = (size: number) => {
    if (offsetCounter % size !== 0) {
      offsetCounter += size - (offsetCounter % size);
    }
  };

  align(8);
  const pixelScaleOffset = offsetCounter;
  offsetCounter += 3 * 8;

  align(8);
  const tiepointOffset = offsetCounter;
  offsetCounter += 6 * 8;

  let geoKeysOffset = 0;
  if (hasGeoKeys) {
    align(2);
    geoKeysOffset = offsetCounter;
    offsetCounter += metadata.geoKeys!.length * 2;
  }

  let geoDoubleOffset = 0;
  if (hasGeoDouble) {
    align(8);
    geoDoubleOffset = offsetCounter;
    offsetCounter += metadata.geoDoubleParams!.length * 8;
  }

  let geoAsciiOffset = 0;
  if (hasGeoAscii) {
    align(1);
    geoAsciiOffset = offsetCounter;
    offsetCounter += metadata.geoAsciiParams!.length;
    if (!metadata.geoAsciiParams!.endsWith('\0')) {
      offsetCounter += 1;
    }
  }

  align(bytesPerSample);
  const imageDataOffset = offsetCounter;
  offsetCounter += imageDataByteCount;

  const totalSize = offsetCounter;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  
  // Header
  view.setUint16(0, 0x4949, true); // II
  view.setUint16(2, 42, true);     // TIFF magic
  view.setUint32(4, 8, true);      // Offset to first IFD
  
  // IFD
  let offset = 8;
  view.setUint16(offset, numTags, true);
  offset += 2;
  
  const writeTag = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    view.setUint32(offset + 8, value, true);
    offset += 12;
  };
  
  writeTag(256, 4, 1, width);
  writeTag(257, 4, 1, height);
  writeTag(258, 3, 1, bitsPerSample);
  writeTag(259, 3, 1, 1); // No compression
  writeTag(262, 3, 1, 1); // BlackIsZero
  writeTag(273, 4, 1, imageDataOffset);
  writeTag(277, 3, 1, 1);
  writeTag(278, 4, 1, height);
  writeTag(279, 4, 1, imageDataByteCount);
  writeTag(284, 3, 1, 1);
  writeTag(339, 3, 1, sampleFormat);
  writeTag(33550, 12, 3, pixelScaleOffset);
  writeTag(33922, 12, 6, tiepointOffset);
  
  if (hasGeoKeys) writeTag(34735, 3, metadata.geoKeys!.length, geoKeysOffset);
  if (hasGeoDouble) writeTag(34736, 12, metadata.geoDoubleParams!.length, geoDoubleOffset);
  
  let asciiLen = hasGeoAscii ? metadata.geoAsciiParams!.length : 0;
  if (hasGeoAscii && !metadata.geoAsciiParams!.endsWith('\0')) asciiLen += 1;
  if (hasGeoAscii) writeTag(34737, 2, asciiLen, geoAsciiOffset);
  
  view.setUint32(offset, 0, true); // Next IFD
  
  // Write values
  const pixelScaleView = new Float64Array(buffer, pixelScaleOffset, 3);
  pixelScaleView.set(metadata.pixelScale);
  
  const tiepointView = new Float64Array(buffer, tiepointOffset, 6);
  tiepointView.set(metadata.tiepoint);
  
  if (hasGeoKeys) {
    const geoKeysView = new Uint16Array(buffer, geoKeysOffset, metadata.geoKeys!.length);
    // @ts-ignore - set accepts number[] or Uint16Array
    geoKeysView.set(metadata.geoKeys!);
  }

  if (hasGeoDouble) {
    const geoDoubleView = new Float64Array(buffer, geoDoubleOffset, metadata.geoDoubleParams!.length);
    // @ts-ignore
    geoDoubleView.set(metadata.geoDoubleParams!);
  }

  if (hasGeoAscii) {
    const asciiBytes = new Uint8Array(buffer, geoAsciiOffset, asciiLen);
    for (let i = 0; i < metadata.geoAsciiParams!.length; i++) {
      asciiBytes[i] = metadata.geoAsciiParams!.charCodeAt(i);
    }
    if (!metadata.geoAsciiParams!.endsWith('\0')) {
      asciiBytes[asciiLen - 1] = 0;
    }
  }
  
  // Write image data
  if (isFloat) {
    const imageDataView = new Float32Array(buffer, imageDataOffset, data.length);
    imageDataView.set(data as Float32Array);
  } else {
    const imageDataView = new Uint16Array(buffer, imageDataOffset, data.length);
    imageDataView.set(data as Uint16Array);
  }
  
  return new Blob([buffer], { type: 'image/tiff' });
}

export function rasterToPngBlob(data: Float32Array, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.imageSmoothingEnabled = false;

  const imageData = ctx.createImageData(width, height);
  
  // Find min/max for normalization
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  
  const range = max - min || 1;
  
  for (let i = 0; i < data.length; i++) {
    const val = Math.round(((data[i] - min) / range) * 255);
    imageData.data[i * 4] = val;
    imageData.data[i * 4 + 1] = val;
    imageData.data[i * 4 + 2] = val;
    imageData.data[i * 4 + 3] = 255;
  }
  
  ctx.putImageData(imageData, 0, 0);
  
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to create blob'));
    }, 'image/png');
  });
}

/**
 * Processes a GeoTIFF file and returns data suitable for Leaflet ImageOverlay.
 */
export async function processGeoTIFF(
  source: ArrayBuffer | Blob | string, 
  options: RenderingOptions = { 
    mode: 'rgb',
    bands: [1, 2, 3], 
    singleBand: 1,
    indexType: 'ndvi',
    indexBands: { red: 1, green: 2, blue: 3, nir: 4 },
    stretch: 'percentile', 
    percentiles: [2, 98], 
    opacity: 1.0,
    colormap: 'grayscale',
    showGrid: false,
    gridSpacing: 1
  },
  wgs84Bbox?: [number, number, number, number] | null
): Promise<GeoTIFFData> {
  let tiff;
  if (source instanceof ArrayBuffer) {
    tiff = await fromGeoTIFF.fromArrayBuffer(source);
  } else if (source instanceof Blob) {
    tiff = await fromGeoTIFF.fromBlob(source);
  } else {
    tiff = await getCachedTiff(source);
  }
  const image = await tiff.getImage();
  
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY] in CRS
  const geoKeys = image.getGeoKeys();
  
  // 1. Determine CRS
  const crs = crsFromGeoKeys(geoKeys);

  // 2. Calculate Pixel Window if bbox is provided
  let readOptions: any = {
    resampleMethod: 'nearest'
  };

  if (wgs84Bbox) {
    const [minX, minY, maxX, maxY] = projectBboxToCrs(wgs84Bbox, crs);

    const resX = (bbox[2] - bbox[0]) / width;
    const resY = (bbox[3] - bbox[1]) / height;

    let left = Math.max(0, Math.floor((minX - bbox[0]) / resX));
    let top = Math.max(0, Math.floor((bbox[3] - maxY) / resY));
    let right = Math.min(width, Math.ceil((maxX - bbox[0]) / resX));
    let bottom = Math.min(height, Math.ceil((bbox[3] - minY) / resY));

    const overlapsGeo = !(
      minX > bbox[2] ||
      maxX < bbox[0] ||
      minY > bbox[3] ||
      maxY < bbox[1]
    );

    if (overlapsGeo) {
      if (bottom - top < 5) {
        const center = Math.floor((top + bottom) / 2);
        top = Math.max(0, center - 1);
        bottom = Math.min(height, center + 4);
      }
      if (right - left < 5) {
        const center = Math.floor((left + right) / 2);
        left = Math.max(0, center - 1);
        right = Math.min(width, center + 4);
      }
    }

    const windowWidth = right - left;
    const windowHeight = bottom - top;

    if (windowWidth > 0 && windowHeight > 0) {
      readOptions.window = [left, top, right, bottom];
      
      // Calculate the actual geographic bounds of the cropped window in CRS units
      const resX = (bbox[2] - bbox[0]) / width;
      const resY = (bbox[3] - bbox[1]) / height;
      const actualMinX = bbox[0] + left * resX;
      const actualMaxX = bbox[0] + right * resX;
      const actualMaxY = bbox[3] - top * resY;
      const actualMinY = bbox[3] - bottom * resY;
      
      // Update bbox for the return value
      const cropBbox = [actualMinX, actualMinY, actualMaxX, actualMaxY];
      
      // Use the same supersampling logic as remote
      const MIN_CANVAS_SIZE = 512;
      let targetW = windowWidth;
      let targetH = windowHeight;
      if (targetW < MIN_CANVAS_SIZE || targetH < MIN_CANVAS_SIZE) {
        const scale = Math.ceil(Math.max(MIN_CANVAS_SIZE / targetW, MIN_CANVAS_SIZE / targetH));
        targetW = windowWidth * scale;
        targetH = windowHeight * scale;
      }
      
      const MAX_DIM = 16384;
      readOptions.width = Math.min(targetW, MAX_DIM);
      readOptions.height = Math.min(targetH, MAX_DIM);
      
      // Store window dims for metadata
      (readOptions as any)._windowOffsetX = left;
      (readOptions as any)._windowOffsetY = top;
      (readOptions as any)._windowWidth = windowWidth;
      (readOptions as any)._windowHeight = windowHeight;
      (readOptions as any)._cropBbox = cropBbox;
    }
  }

  if (!readOptions.width) {
    const MAX_DIM = 16384;
    let targetWidth = width;
    let targetHeight = height;
    if (width > MAX_DIM || height > MAX_DIM) {
      const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
      targetWidth = Math.round(width * ratio);
      targetHeight = Math.round(height * ratio);
    }
    readOptions.width = targetWidth;
    readOptions.height = targetHeight;
  }

  const finalWidth = readOptions.width;
  const finalHeight = readOptions.height;
  const nativeWindowWidth = (readOptions as any)._windowWidth || width;
  const nativeWindowHeight = (readOptions as any)._windowHeight || height;
  const windowOffsetX = (readOptions as any)._windowOffsetX || 0;
  const windowOffsetY = (readOptions as any)._windowOffsetY || 0;
  const effectiveBbox = (readOptions as any)._cropBbox || bbox;

  console.log('[DEBUG] GeoTIFF FileDirectory:', {
     GDAL_METADATA: image.getGDALMetadata ? image.getGDALMetadata() : null
  });

  const rasters = await image.readRasters(readOptions);
  
  // 1. Prepare Image Data
  // geotiff.js readRasters returns an array of TypedArrays (one per band)
  // or a single TypedArray if it's interleaved (which we don't handle here yet)
  const isMultiBand = Array.isArray(rasters) && !('buffer' in rasters);
  const totalBands = isMultiBand ? (rasters as any).length : 1;
  
  const getBand = (idx: number) => {
    if (isMultiBand) {
      let actualIdx = Math.min(Math.max(0, idx - 1), totalBands - 1);
      
      if (options.bandMap && typeof options.bandMap[idx] === 'number') {
         actualIdx = options.bandMap[idx];
      }
      
      return rasters[actualIdx] as any;
    }
    return rasters as any;
  };

  // Cache bands for extraction
  const bands: Record<string, Float32Array> = {};
  for (let i = 0; i < totalBands; i++) {
    bands[`Band ${i + 1}`] = getBand(i + 1);
  }

  // 2-3. Stretch + render through the shared pipeline (see raster-render.ts)
  const finalCanvas = renderRasterToCanvas(getBand, options, finalWidth, finalHeight);

  // 4. Get CRS + Bounds & Reproject to WGS84
  const fileDirectory = image.getFileDirectory();
  
  let resolution: [number, number] | undefined;
  const anyFileDirectory = fileDirectory as any;
  if (anyFileDirectory.ModelPixelScale) {
    resolution = [anyFileDirectory.ModelPixelScale[0], anyFileDirectory.ModelPixelScale[1]];
  } else if (bbox) {
    // Fallback: calculate from bbox and dimensions
    resolution = [
      (bbox[2] - bbox[0]) / width,
      (bbox[3] - bbox[1]) / height
    ];
  }

  // Use effectiveBbox for bounds calculation (handles crop)
  const [actMinLon, actMinLat, actMaxLon, actMaxLat] = unprojectBboxToWgs84(
    effectiveBbox as [number, number, number, number],
    crs
  );

  // Try to get band descriptions from GDAL metadata
  const descriptions: string[] = [];
  try {
    const gdalMetadata = (image as any).getGDALMetadata?.();
    for (let i = 0; i < totalBands; i++) {
      const desc = gdalMetadata?.[`BAND_${i + 1}`] || `Band ${i + 1}`;
      descriptions.push(desc);
    }
  } catch (e) {
    for (let i = 0; i < totalBands; i++) {
      descriptions.push(`Band ${i + 1}`);
    }
  }

  return {
    image: finalCanvas,
    bounds: [[actMinLat, actMinLon], [actMaxLat, actMaxLon]],
    metadata: {
      width: finalWidth,
      height: finalHeight,
      windowWidth: nativeWindowWidth,
      windowHeight: nativeWindowHeight,
      bands: totalBands,
      crs,
      descriptions,
      resolution,
      imageBbox: [actMinLon, actMinLat, actMaxLon, actMaxLat],
      originalBbox: bbox as [number, number, number, number],
      originalWidth: image.getWidth(),
      originalHeight: image.getHeight(),
      windowOffsetX,
      windowOffsetY
    },
    rawBuffer: source instanceof ArrayBuffer ? source : new ArrayBuffer(0),
    originalSource: source,
    bandData: bands
  };
}

/**
 * Processes remote Cloud Optimized GeoTIFFs (COGs) from URLs.
 * This is optimized for fetching only the required pixels within a bounding box.
 */
export async function processRemoteGeoTIFF(
  bandUrls: Record<string, string>,
  wgs84Bbox: [number, number, number, number], // [minLng, minLat, maxLng, maxLat]
  options: RenderingOptions,
  cachedBandData?: Record<string, Float32Array>,
  cachedMetadata?: GeoTIFFData['metadata']
): Promise<GeoTIFFData> {
  if (Object.keys(bandUrls).length === 0 && !cachedBandData) {
    throw new Error('No band URLs provided for processing.');
  }

  let widthVal, heightVal, bboxVal, crsVal;
  if (cachedMetadata && cachedMetadata.originalWidth && cachedMetadata.originalHeight && cachedMetadata.originalBbox) {
    widthVal = cachedMetadata.originalWidth;
    heightVal = cachedMetadata.originalHeight;
    bboxVal = cachedMetadata.originalBbox;
    crsVal = cachedMetadata.crs || 'EPSG:4326';
  } else {
    // 1. Open ONLY the reference band (preferably B04/10m) to get metadata
    // Sentinel-2 L2A images share the same spatial extent and CRS across all bands.
    // For resolution, we will use the reference band's grid for the output canvas.
    const refUrl = bandUrls['B04'] || bandUrls['B03'] || bandUrls['B02'] || bandUrls['B08'] || Object.values(bandUrls)[0];
    let attempts = 0;
    let refImage;
    while (attempts < 3) {
      try {
        const tiff = await getCachedTiff(refUrl);
        refImage = await tiff.getImage();
        break;
      } catch (e) {
        attempts++;
        if (attempts >= 3) throw new Error(`Failed to fetch header for reference URL: ${refUrl}`);
        await new Promise(resolve => setTimeout(resolve, 500 * attempts));
      }
    }

    if (!refImage) throw new Error('Could not read reference image header.');

    widthVal = refImage.getWidth();
    heightVal = refImage.getHeight();
    bboxVal = refImage.getBoundingBox();
    
    crsVal = crsFromGeoKeys(refImage.getGeoKeys());
  }

  // 2. Project WGS84 Bbox to Image CRS (UTM is common for Sentinel-2)
  const [minX, minY, maxX, maxY] = projectBboxToCrs(wgs84Bbox, crsVal);

  // 3. Calculate Pixel Window
  // Note: GeoTIFF origin is top-left
  const resX = (bboxVal[2] - bboxVal[0]) / widthVal;
  const resY = Math.abs((bboxVal[3] - bboxVal[1]) / heightVal);

  const imgMinX = bboxVal[0];
  const imgMaxX = bboxVal[2];
  const imgMinY = Math.min(bboxVal[1], bboxVal[3]);
  const imgMaxY = Math.max(bboxVal[1], bboxVal[3]);

  // Use the correctly ordered bounding box variables
  let left = Math.max(0, Math.floor((minX - imgMinX) / resX));
  let top = Math.max(0, Math.floor((imgMaxY - maxY) / resY));
  let right = Math.min(widthVal, Math.ceil((maxX - imgMinX) / resX));
  let bottom = Math.min(heightVal, Math.ceil((imgMaxY - minY) / resY));

  const overlapsGeo = !(
    minX > imgMaxX ||
    maxX < imgMinX ||
    minY > imgMaxY ||
    maxY < imgMinY
  );

  // If there's overlap geographically but the pixel window is extremely small,
  // expand it to at least 5x5 pixels so we always fetch/render a visible image (e.g. for points/small fields)
  if (overlapsGeo) {
    if (bottom - top < 5) {
      const center = Math.floor((top + bottom) / 2);
      top = Math.max(0, center - 1);
      bottom = Math.min(heightVal, center + 4);
    }
    if (right - left < 5) {
      const center = Math.floor((left + right) / 2);
      left = Math.max(0, center - 1);
      right = Math.min(widthVal, center + 4);
    }
  }

  const windowWidth = right - left;
  const windowHeight = bottom - top;

  if (windowWidth <= 0 || windowHeight <= 0) {
    console.warn(`[processRemoteGeoTIFF] Crop window width (${windowWidth}) or height (${windowHeight}) <= 0. Non-overlapping coordinates: bounds ${wgs84Bbox} vs image extent ${bboxVal}. Returning empty transparent placeholder.`);
    const dummyWidth = 2;
    const dummyHeight = 2;
    const dummyBandData: Record<string, Float32Array> = {};
    const expectedBandNames = cachedMetadata?.descriptions || (bandUrls ? Object.keys(bandUrls) : ['B04', 'B03', 'B02', 'B08']);
    
    expectedBandNames.forEach(b => {
      dummyBandData[b] = new Float32Array(dummyWidth * dummyHeight);
    });
    
    const canvas = document.createElement('canvas');
    canvas.width = dummyWidth;
    canvas.height = dummyHeight;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(dummyWidth, dummyHeight);
    for (let i = 0; i < dummyWidth * dummyHeight * 4; i++) {
      imgData.data[i] = 0; // Transparent black
    }
    ctx.putImageData(imgData, 0, 0);
    
    return {
      image: canvas,
      bounds: [[wgs84Bbox[1], wgs84Bbox[0]], [wgs84Bbox[3], wgs84Bbox[2]]],
      metadata: {
        width: dummyWidth,
        height: dummyHeight,
        bands: expectedBandNames.length,
        crs: crsVal,
        descriptions: expectedBandNames,
        resolution: [resX, resY],
        imageBbox: wgs84Bbox,
        originalBbox: bboxVal,
        originalWidth: widthVal,
        originalHeight: heightVal,
        windowWidth: dummyWidth,
        windowHeight: dummyHeight,
        windowOffsetX: 0,
        windowOffsetY: 0
      },
      rawBuffer: new ArrayBuffer(0),
      bandData: dummyBandData
    };
  }
  
  // Calculate the actual geographic bounds of the cropped window
  const actualMinX = bboxVal[0] + left * resX;
  const actualMaxX = bboxVal[0] + right * resX;
  const actualMaxY = bboxVal[3] - top * resY;
  const actualMinY = bboxVal[3] - bottom * resY;
  
  // Unproject all 4 corners of the UTM pixel window to find the WGS84 bounding box
  const actualWgs84Bbox = unprojectBboxToWgs84(
    [actualMinX, actualMinY, actualMaxX, actualMaxY],
    crsVal
  );

  // Limit absolute maximum fetch size to 16k, but for visual clarity, we might upscale small crops.
  const nativeWidth = windowWidth;
  const nativeHeight = windowHeight;
  
  // Visual Clarity Fix: If the crop is tiny (e.g. 50m with 10m pixels = 5x5 pixels),
  // creating a 5x5 canvas and stretching it in the browser causes severe aliasing/blurring
  // even with pixelated-rendering. We will supersample the canvas to a minimum of 512px
  // using nearest-neighbor to ensure "sharp" pixel visibility.
  let finalWidth = nativeWidth;
  let finalHeight = nativeHeight;
  
  const MIN_CANVAS_SIZE = 512;
  if (finalWidth < MIN_CANVAS_SIZE || finalHeight < MIN_CANVAS_SIZE) {
    const scale = Math.ceil(Math.max(MIN_CANVAS_SIZE / finalWidth, MIN_CANVAS_SIZE / finalHeight));
    finalWidth = nativeWidth * scale;
    finalHeight = nativeHeight * scale;
  }
  
  finalWidth = Math.min(finalWidth, 16384);
  finalHeight = Math.min(finalHeight, 16384);
  
  console.log(`Processing remote GeoTIFF. TIFF Window: ${nativeWidth}x${nativeHeight}, Output Canvas: ${finalWidth}x${finalHeight}`);

  // 4. Fetch Rasters for required bands
  let bandData: Record<string, Float32Array> = cachedBandData ? { ...cachedBandData } : {};
  console.log(`Initial bandData keys: ${Object.keys(bandData).join(', ')}`);
  
  const bandsToFetch = Object.entries(bandUrls).filter(([name]) => !bandData[name]);
  
  if (bandsToFetch.length > 0) {
    // Process bands in chunks to avoid rate limiting or browser connection limits
    const CHUNK_SIZE = 6; // Browsers support 6 parallel connections per domain
    for (let i = 0; i < bandsToFetch.length; i += CHUNK_SIZE) {
      const chunk = bandsToFetch.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map(async ([name, url]) => {
        if (!url) return;
        
        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
          try {
            if (!url.includes('?')) {
              console.warn(`Band ${name} URL is NOT signed: ${url.substring(0, 100)}...`);
            }
            
            console.log(`Fetching band ${name} from URL: ${url.substring(0, 100)}... (Attempt ${attempts + 1})`);
            const bTiff = await getCachedTiff(url);
            const bImage = await bTiff.getImage();
        
        // Calculate window dynamically for each band based on its own dimensions
        const bWidth = bImage.getWidth();
        const bHeight = bImage.getHeight();
        const bBbox = bImage.getBoundingBox();
        const bResX = (bBbox[2] - bBbox[0]) / bWidth;
        const bResY = Math.abs((bBbox[3] - bBbox[1]) / bHeight);
        
        const bImgMinX = bBbox[0];
        const bImgMaxX = bBbox[2];
        const bImgMinY = Math.min(bBbox[1], bBbox[3]);
        const bImgMaxY = Math.max(bBbox[1], bBbox[3]);
        
        // Use the projected coordinates (minX, minY, maxX, maxY) to calculate the window
        // Note: GeoTIFF origin is top-left
        const bLeft = Math.max(0, Math.floor((minX - bImgMinX) / bResX));
        const bTop = Math.max(0, Math.floor((bImgMaxY - maxY) / bResY));
        const bRight = Math.min(bWidth, Math.ceil((maxX - bImgMinX) / bResX));
        const bBottom = Math.min(bHeight, Math.ceil((bImgMaxY - minY) / bResY));
        
        const raster = await bImage.readRasters({
          window: [bLeft, bTop, bRight, bBottom]
        });
        
        let rasterData = raster[0] as Float32Array;
        const nativeWidth = bRight - bLeft;
        const nativeHeight = bBottom - bTop;
        
        if (nativeWidth !== finalWidth || nativeHeight !== finalHeight) {
          // Manual nearest neighbor resampling to guarantee no interpolation
          const resampled = new Float32Array(finalWidth * finalHeight);
          const scaleX = nativeWidth / finalWidth;
          const scaleY = nativeHeight / finalHeight;
          
          for (let y = 0; y < finalHeight; y++) {
            const srcY = Math.min(nativeHeight - 1, Math.floor(y * scaleY));
            for (let x = 0; x < finalWidth; x++) {
              const srcX = Math.min(nativeWidth - 1, Math.floor(x * scaleX));
              resampled[y * finalWidth + x] = rasterData[srcY * nativeWidth + srcX];
            }
          }
          rasterData = resampled;
        }
        
        // Map the fetched raster to the band name
        bandData[name] = rasterData;
        console.log(`Successfully fetched band ${name}, data length: ${bandData[name].length}`);
        break; // Sucess, exit the retry loop
      } catch (e) {
        attempts++;
        console.error(`Error fetching band ${name} (Attempt ${attempts}):`, e);
        if (attempts >= maxAttempts) {
          throw new Error(`Failed to fetch band ${name}. This might be due to authentication or network issues.`);
        }
        // Wait a short time before retrying
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
      }
    } // end while
    }));
    }
  } else {
    console.log('Using cached band data for reprocessing.');
  }

  // 5. Process the combined rasters (similar to processGeoTIFF logic)
  // For simplicity, we'll mock a "rasters" array that the internal logic expects
  // But wait, the internal logic of processGeoTIFF is tied to the full image.
  // We should extract the rendering logic to a shared function.
  
  // Let's refactor processGeoTIFF to use a shared rendering function.
  // For now, I'll just implement a simplified version here or refactor.
  
  // Actually, I'll refactor processGeoTIFF to extract the rendering part.
  // But first, let's finish the metadata for the return object.
  
  // Helper to get band data
  const getBand = (name: string) => {
    console.log(`Getting band: ${name}, available keys: ${Object.keys(bandData).join(', ')}`);
    if (bandData[name]) return bandData[name];
    console.warn(`Band ${name} not found in fetched data, returning empty array.`);
    return new Float32Array(finalWidth * finalHeight);
  };

  // Stretch + render through the shared pipeline (see raster-render.ts).
  // The remote pipeline resolves standard band numbers to Sentinel-2 asset names.
  const finalCanvas = renderRasterToCanvas(
    (bandNum: number) => getBand(getAssetKey(bandNum)),
    options,
    finalWidth,
    finalHeight
  );

  return {
    image: finalCanvas,
    bounds: [[actualWgs84Bbox[1], actualWgs84Bbox[0]], [actualWgs84Bbox[3], actualWgs84Bbox[2]]],
    metadata: {
      width: finalWidth,
      height: finalHeight,
      bands: cachedMetadata?.bands || (bandUrls ? Object.keys(bandUrls).length : 0),
      crs: crsVal,
      descriptions: cachedMetadata?.descriptions || (bandUrls ? Object.keys(bandUrls) : []),
      resolution: [resX, resY],
      imageBbox: actualWgs84Bbox as [number, number, number, number],
      originalBbox: bboxVal,
      originalWidth: widthVal,
      originalHeight: heightVal,
      windowWidth: nativeWidth,
      windowHeight: nativeHeight,
      windowOffsetX: left,
      windowOffsetY: top
    },
    rawBuffer: new ArrayBuffer(0), // No buffer for remote COGs
    bandData: bandData
  };
}

/**
 * Extracts pixels from a RasterLayer that intersect with a VectorLayer's features.
 * Returns a CSV string with SHP attributes and band values.
 */
export async function extractZonalPixels(
  rasterData: GeoTIFFData,
  vectorData: any // GeoJSON FeatureCollection
): Promise<string> {
  const { bandData, metadata } = rasterData;
  if (!bandData || Object.keys(bandData).length === 0) {
    throw new Error("No pixel data available for extraction.");
  }

  // Use dynamic imports for spatial libraries to avoid bloat if not used
  const { default: booleanPointInPolygon } = await import('@turf/boolean-point-in-polygon');
  // @ts-ignore
  const { default: RBush } = await import('rbush');

  const { width, height, crs, originalBbox, originalWidth, originalHeight, windowOffsetX, windowOffsetY } = metadata;
  
  if (!originalBbox || !originalWidth || !originalHeight) {
    throw new Error("Metadata missing for coordinate reconstruction.");
  }

  // Calculate resolution in original CRS
  const resX = (originalBbox[2] - originalBbox[0]) / originalWidth;
  const resY = (originalBbox[3] - originalBbox[1]) / originalHeight;
  
  // Projection helper (shared, see geo.ts)
  const unproject = (x: number, y: number): [number, number] => unprojectToWgs84(crs, x, y);

  // Prepare Spatial Index for Vector Features
  const tree = new RBush();
  const features = vectorData.type === 'FeatureCollection' ? vectorData.features : [vectorData];
  
  const indexedFeatures = features.map((f: any, idx: number) => {
    // Basic bbox for each feature
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    
    const coords = f.geometry.coordinates;
    const processCoords = (c: any) => {
      if (typeof c[0] === 'number') {
        minLon = Math.min(minLon, c[0]);
        minLat = Math.min(minLat, c[1]);
        maxLon = Math.max(maxLon, c[0]);
        maxLat = Math.max(maxLat, c[1]);
      } else {
        c.forEach(processCoords);
      }
    };
    processCoords(coords);
    
    return {
      minX: minLon,
      minY: minLat,
      maxX: maxLon,
      maxY: maxLat,
      feature: f,
      id: idx
    };
  });
  
  tree.load(indexedFeatures);

  const bands = Object.keys(bandData).sort();
  const headers = ['lat', 'lng', 'pixel_x', 'pixel_y', ...Object.keys(features[0].properties), ...bands];
  
  let csv = headers.join(',') + '\n';
  
  // Determine if we need to downsample for the check
  // If resolution is high and area is large, we might have millions of pixels.
  // The bandData already represents the windowed/resampled pixels.
  
  // windowOffsetX and windowOffsetY are in the ORIGINAL image space.
  // width and height are the dimensions of the bandData.
  
  const scaleX = (metadata.windowWidth || metadata.originalWidth) / width;
  const scaleY = (metadata.windowHeight || metadata.originalHeight) / height;

  const totalPixels = width * height;
  console.log(`Extracting pixels: ${width}x${height} = ${totalPixels} pixels`);
  
  let matchedCount = 0;

  for (let y = 0; y < height; y++) {
    // Actual native pixel center in original CRS
    const nativeY = (windowOffsetY || 0) + (y + 0.5) * scaleY;
    const crsY = originalBbox[3] - nativeY * resY;
    
    for (let x = 0; x < width; x++) {
      const nativeX = (windowOffsetX || 0) + (x + 0.5) * scaleX;
      const crsX = originalBbox[0] + nativeX * resX;
      
      const [lng, lat] = unproject(crsX, crsY);
      
      // Query tree for candidate features
      const candidates = tree.search({
        minX: lng,
        minY: lat,
        maxX: lng,
        maxY: lat
      });
      
      for (const candidate of candidates) {
        if (booleanPointInPolygon([lng, lat], candidate.feature)) {
          // Matched!
          const row = [
            lat.toFixed(6),
            lng.toFixed(6),
            (windowOffsetX || 0) + x,
            (windowOffsetY || 0) + y,
            ...Object.values(candidate.feature.properties),
            ...bands.map(b => bandData[b][y * width + x])
          ];
          csv += row.join(',') + '\n';
          matchedCount++;
          break; // Assume a pixel belongs to only one cell in the grid
        }
      }
    }
    
    // Safety check to avoid browser freeze for truly massive extractions
    if (y % 100 === 0 && y > 0) {
      console.log(`Processing extraction: ${((y / height) * 100).toFixed(1)}%`);
    }
  }

  console.log(`Extraction complete. Matched ${matchedCount} pixels.`);
  if (matchedCount === 0) {
    throw new Error("No pixels found within the vector features.");
  }

  return csv;
}
