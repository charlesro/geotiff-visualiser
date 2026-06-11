import { GeoTIFFData, RenderingOptions, getCachedTiff } from './geotiff-utils';
import { renderRasterToCanvas } from './raster-render';
import { getAssetKey } from './sentinel';
import { Bbox, projectBboxToCrs, unprojectBboxToWgs84 } from './geo';
import { CancelCheck, throwIfCancelled } from './cancel';

/**
 * Multi-tile scene mosaic.
 *
 * A Sentinel-2 overpass is distributed as ~110 km MGRS tiles; a selection
 * that straddles a tile boundary needs pixels from several tiles of the same
 * acquisition. This module builds one regular grid covering the whole
 * selection bbox (in the overpass's UTM CRS) and pastes the windowed reads
 * of every tile into it. Zero is the Sentinel-2 nodata value, so a target
 * cell keeps the first non-zero value it receives and tile overlaps /
 * swath-edge nodata compose naturally.
 */

export interface MosaicTile {
  /** Signed asset URLs, keyed by band name (B02, B03, B04, B08, ...). */
  bandUrls: Record<string, string>;
}

/**
 * Cap on the mosaic grid edge. 2048 cells keep a scene's four bands around
 * 67 MB; selections up to ~20 km stay at the native 10 m, larger ones are
 * resampled to the coarser resolution that fits the cap.
 */
const MAX_DIM = 2048;

/** Canvases below this edge get supersampled so Leaflet doesn't blur them. */
const MIN_CANVAS_SIZE = 512;

export interface MosaicOptions {
  /**
   * Skip the preview canvas (analysis-only grids): a 1×1 placeholder is
   * returned as `image` and no supersampling happens.
   */
  skipCanvas?: boolean;
}

export async function fetchSceneMosaic(
  tiles: MosaicTile[],
  wgs84Bbox: Bbox,
  crs: string,
  options: RenderingOptions,
  isCancelled?: CancelCheck,
  mosaicOptions: MosaicOptions = {}
): Promise<GeoTIFFData> {
  if (tiles.length === 0) throw new Error('No tiles to mosaic.');

  // Target grid over the selection, snapped to the 10 m Sentinel-2 grid.
  const [pMinX, pMinY, pMaxX, pMaxY] = projectBboxToCrs(wgs84Bbox, crs);
  const gridMinX = Math.floor(pMinX / 10) * 10;
  const gridMinY = Math.floor(pMinY / 10) * 10;
  const gridMaxX = Math.ceil(pMaxX / 10) * 10;
  const gridMaxY = Math.ceil(pMaxY / 10) * 10;
  const extentX = gridMaxX - gridMinX;
  const extentY = gridMaxY - gridMinY;

  const res = Math.max(10, 10 * Math.ceil(Math.max(extentX, extentY) / (MAX_DIM * 10)));
  const gridW = Math.max(1, Math.round(extentX / res));
  const gridH = Math.max(1, Math.round(extentY / res));

  const bandNames = Object.keys(tiles[0].bandUrls);
  const bands: Record<string, Float32Array> = {};
  for (const name of bandNames) bands[name] = new Float32Array(gridW * gridH);

  // All tile×band reads are independent (each tile pastes into a disjoint —
  // or identically-valued — region), so run them in parallel up to the
  // browser's per-host connection limit.
  const reads: { target: Float32Array; url: string }[] = [];
  for (const tile of tiles) {
    for (const [name, url] of Object.entries(tile.bandUrls)) {
      if (bands[name] && url) reads.push({ target: bands[name], url });
    }
  }
  const PARALLEL = 6;
  for (let i = 0; i < reads.length; i += PARALLEL) {
    throwIfCancelled(isCancelled);
    await Promise.all(
      reads
        .slice(i, i + PARALLEL)
        .map(r => pasteTileBand(r.target, gridW, gridH, [gridMinX, gridMinY, gridMaxX, gridMaxY], res, r.url))
    );
  }

  // Render the preview canvas; supersample small grids with nearest-neighbour
  // so individual pixels stay sharp on the map.
  let canvas: HTMLCanvasElement;
  if (mosaicOptions.skipCanvas) {
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
  } else {
    canvas = renderRasterToCanvas((bandNum: number) => bands[getAssetKey(bandNum)] || new Float32Array(gridW * gridH), options, gridW, gridH);
  }
  if (!mosaicOptions.skipCanvas && (gridW < MIN_CANVAS_SIZE || gridH < MIN_CANVAS_SIZE)) {
    const scale = Math.ceil(Math.max(MIN_CANVAS_SIZE / gridW, MIN_CANVAS_SIZE / gridH));
    const big = document.createElement('canvas');
    big.width = gridW * scale;
    big.height = gridH * scale;
    const ctx = big.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, big.width, big.height);
    canvas = big;
  }

  const gridBbox: Bbox = [gridMinX, gridMinY, gridMaxX, gridMaxY];
  const wgs84Bounds = unprojectBboxToWgs84(gridBbox, crs);

  return {
    image: canvas,
    bounds: [
      [wgs84Bounds[1], wgs84Bounds[0]],
      [wgs84Bounds[3], wgs84Bounds[2]],
    ],
    metadata: {
      width: gridW,
      height: gridH,
      bands: bandNames.length,
      crs,
      descriptions: bandNames,
      resolution: [res, res],
      imageBbox: wgs84Bounds,
      originalBbox: gridBbox,
      originalWidth: gridW,
      originalHeight: gridH,
      windowWidth: gridW,
      windowHeight: gridH,
      windowOffsetX: 0,
      windowOffsetY: 0,
    },
    rawBuffer: new ArrayBuffer(0),
    bandData: bands,
  };
}

/** Read the part of one tile band that overlaps the grid and paste it in. */
async function pasteTileBand(
  target: Float32Array,
  gridW: number,
  gridH: number,
  gridBbox: Bbox,
  res: number,
  url: string
): Promise<void> {
  const [gridMinX, gridMinY, gridMaxX, gridMaxY] = gridBbox;

  let attempts = 0;
  while (attempts < 3) {
    try {
      const tiff = await getCachedTiff(url);
      const image = await tiff.getImage();
      const tBbox = image.getBoundingBox();
      const tW = image.getWidth();
      const tH = image.getHeight();
      const tResX = (tBbox[2] - tBbox[0]) / tW;
      const tResY = (tBbox[3] - tBbox[1]) / tH;

      // Intersection of the tile extent with the target grid, in CRS metres.
      const isectMinX = Math.max(gridMinX, tBbox[0]);
      const isectMinY = Math.max(gridMinY, tBbox[1]);
      const isectMaxX = Math.min(gridMaxX, tBbox[2]);
      const isectMaxY = Math.min(gridMaxY, tBbox[3]);
      if (isectMinX >= isectMaxX || isectMinY >= isectMaxY) return;

      // Destination cells covered by the intersection.
      const dx0 = Math.max(0, Math.round((isectMinX - gridMinX) / res));
      const dy0 = Math.max(0, Math.round((gridMaxY - isectMaxY) / res));
      const dx1 = Math.min(gridW, Math.round((isectMaxX - gridMinX) / res));
      const dy1 = Math.min(gridH, Math.round((gridMaxY - isectMinY) / res));
      const outW = dx1 - dx0;
      const outH = dy1 - dy0;
      if (outW <= 0 || outH <= 0) return;

      // Source window in full-resolution tile pixels. Reading through the
      // GeoTIFF object (not the image) lets geotiff.js pick the COG overview
      // matching outW×outH instead of decoding the full 10 m data.
      const sLeft = Math.max(0, Math.floor((isectMinX - tBbox[0]) / tResX));
      const sTop = Math.max(0, Math.floor((tBbox[3] - isectMaxY) / tResY));
      const sRight = Math.min(tW, Math.ceil((isectMaxX - tBbox[0]) / tResX));
      const sBottom = Math.min(tH, Math.ceil((tBbox[3] - isectMinY) / tResY));
      if (sRight - sLeft <= 0 || sBottom - sTop <= 0) return;

      const raster = await tiff.readRasters({
        window: [sLeft, sTop, sRight, sBottom],
        width: outW,
        height: outH,
        resampleMethod: 'nearest',
      });
      const data = raster[0] as ArrayLike<number>;

      for (let y = 0; y < outH; y++) {
        const dstRow = (dy0 + y) * gridW + dx0;
        const srcRow = y * outW;
        for (let x = 0; x < outW; x++) {
          const v = data[srcRow + x] as number;
          if (v !== 0) target[dstRow + x] = v;
        }
      }
      return;
    } catch (e) {
      attempts++;
      if (attempts >= 3) throw new Error(`Failed to read mosaic tile band: ${e instanceof Error ? e.message : e}`);
      await new Promise(r => setTimeout(r, 800 * attempts));
    }
  }
}
