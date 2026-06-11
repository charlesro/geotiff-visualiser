import { RasterLayer } from '../types';
import {
  searchSentinel2Chunked,
  groupItemsByDate,
  selectEvenlySpaced,
  signSTACItem,
  STACItem,
} from '../services/stac-service';
import { processRemoteGeoTIFF } from './geotiff-utils';
import { createRasterLayer, DEFAULT_OPTIONS } from './layer-factory';
import { getBboxIntersectionArea, Bbox } from './geo';

/**
 * Sentinel-2 time-series acquisition for the workflow.
 *
 * Searches the Planetary Computer STAC catalogue over the selection bbox,
 * picks evenly-spaced acquisition dates, and downloads a windowed crop of
 * the bands needed for spectral indices (B02/B03/B04/B08) from each scene.
 */

export const SERIES_ASSETS = ['B02', 'B03', 'B04', 'B08'];

export interface SeriesFetchParams {
  startDate: string;
  endDate: string;
  maxCloudCover: number;
  targetCount: number;
  token?: string;
}

export interface SeriesProgress {
  stage: 'searching' | 'downloading';
  current: number;
  total: number;
  message: string;
}

export interface SeriesFetchResult {
  layers: RasterLayer[];
  /** Acquisition dates that matched but failed to download. */
  failedDates: string[];
  /** Number of distinct acquisition dates available in the period. */
  availableDates: number;
}

export async function fetchSentinelSeries(
  bbox: Bbox,
  params: SeriesFetchParams,
  onProgress: (p: SeriesProgress) => void
): Promise<SeriesFetchResult> {
  onProgress({ stage: 'searching', current: 0, total: 1, message: 'Searching the Sentinel-2 catalogue…' });

  const allItems = await searchSentinel2Chunked(
    bbox,
    params.startDate,
    params.endDate,
    params.maxCloudCover,
    params.token || undefined
  );
  if (allItems.length === 0) {
    throw new Error('No Sentinel-2 scenes match the area, period and cloud-cover limit.');
  }

  const byDate = groupItemsByDate(allItems);
  const picked = selectEvenlySpaced(byDate, params.targetCount).sort(
    (a, b) => new Date(a.properties.datetime).getTime() - new Date(b.properties.datetime).getTime()
  );

  const seriesId = crypto.randomUUID();
  const layers: RasterLayer[] = [];
  const failedDates: string[] = [];

  for (let i = 0; i < picked.length; i++) {
    const item = picked[i];
    const date = item.properties.datetime.split('T')[0];
    onProgress({
      stage: 'downloading',
      current: i,
      total: picked.length,
      message: `Downloading scene ${i + 1}/${picked.length} (${date})…`,
    });

    try {
      layers.push(await downloadScene(item, bbox, seriesId, params.token));
    } catch (e) {
      console.error(`Failed to download scene ${date}:`, e);
      failedDates.push(date);
    }
  }

  onProgress({ stage: 'downloading', current: picked.length, total: picked.length, message: 'Done' });

  if (layers.length === 0) {
    throw new Error('All matching scenes failed to download. Check your network and try again.');
  }
  return { layers, failedDates, availableDates: byDate.length };
}

async function downloadScene(
  item: STACItem,
  bbox: Bbox,
  seriesId: string,
  token?: string
): Promise<RasterLayer> {
  // An overpass can be split across adjacent MGRS tiles; use the tile that
  // covers the selection best.
  const tiles = item.groupItems?.length ? item.groupItems : [item];
  let best = tiles[0];
  let bestOverlap = -1;
  for (const tile of tiles) {
    const overlap = tile.bbox ? getBboxIntersectionArea(tile.bbox as Bbox, bbox) : 0;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = tile;
    }
  }

  const signed = await signSTACItem(best, token);
  const bandUrls: Record<string, string> = {};
  for (const asset of SERIES_ASSETS) {
    const href = signed.assets[asset]?.href;
    if (href) bandUrls[asset] = href;
  }
  if (!bandUrls['B04'] || !bandUrls['B08']) {
    throw new Error(`Scene ${item.id} is missing the B04/B08 assets.`);
  }

  const date = item.properties.datetime.split('T')[0];
  const data = await processRemoteGeoTIFF(bandUrls, bbox, DEFAULT_OPTIONS);
  return createRasterLayer({
    name: `S2 ${date}`,
    data,
    visible: false,
    stacItem: item,
    seriesId,
    datetime: item.properties.datetime,
    remoteBbox: bbox,
  });
}
