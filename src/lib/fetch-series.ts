import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { RasterLayer } from '../types';
import {
  searchSentinel2Chunked,
  groupItemsByDate,
  selectEvenlySpaced,
  signSTACItem,
  STACItem,
} from '../services/stac-service';
import { fetchSceneMosaic, MosaicTile } from './mosaic';
import { createRasterLayer, DEFAULT_OPTIONS } from './layer-factory';
import { getBboxIntersectionArea, Bbox } from './geo';

/**
 * Sentinel-2 time-series acquisition for the workflow.
 *
 * Searches the Planetary Computer STAC catalogue over the selection bbox,
 * keeps only the acquisition dates whose swath actually covers the whole
 * selection, picks evenly-spaced dates among them, and downloads a mosaic
 * of every MGRS tile of each date so the full area is present in each scene.
 */

export const SERIES_ASSETS = ['B02', 'B03', 'B04', 'B08'];

/** A date is kept when its tiles cover at least this fraction of the bbox. */
const MIN_COVERAGE = 0.98;

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
  /** Dates dropped because their swath does not cover the whole selection. */
  partialDates: number;
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

  // Keep only the dates whose combined tile footprints cover the selection;
  // a swath edge crossing the bbox cannot be fixed by mosaicking.
  const covered = byDate.filter(item => dateCoverage(item, bbox) >= MIN_COVERAGE);
  const partialDates = byDate.length - covered.length;
  if (covered.length === 0) {
    throw new Error(
      `${byDate.length} date(s) matched but none covers the whole selection (satellite swath edge). ` +
        'Try a longer period or a smaller selection.'
    );
  }

  const picked = selectEvenlySpaced(covered, params.targetCount).sort(
    (a, b) => new Date(a.properties.datetime).getTime() - new Date(b.properties.datetime).getTime()
  );

  const seriesId = crypto.randomUUID();
  const layers: RasterLayer[] = [];
  const failedDates: string[] = [];

  for (let i = 0; i < picked.length; i++) {
    const item = picked[i];
    const date = item.properties.datetime.split('T')[0];
    const tileCount = tilesOf(item).filter(t => intersectsBbox(t, bbox)).length;
    onProgress({
      stage: 'downloading',
      current: i,
      total: picked.length,
      message: `Downloading scene ${i + 1}/${picked.length} (${date}${tileCount > 1 ? `, ${tileCount} tiles` : ''})…`,
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
  return { layers, failedDates, availableDates: byDate.length, partialDates };
}

const tilesOf = (item: STACItem): STACItem[] => (item.groupItems?.length ? item.groupItems : [item]);

const intersectsBbox = (tile: STACItem, bbox: Bbox): boolean =>
  !!tile.bbox && getBboxIntersectionArea(tile.bbox as Bbox, bbox) > 0;

/**
 * Fraction of the bbox covered by the date's tile footprints, estimated on a
 * point grid. The STAC geometry is the *data* footprint, so swath-edge tiles
 * only count where they really have pixels.
 */
function dateCoverage(item: STACItem, bbox: Bbox): number {
  const geometries = tilesOf(item)
    .map(t => t.geometry)
    .filter(Boolean);
  if (geometries.length === 0) return 0;

  const N = 12;
  let covered = 0;
  for (let iy = 0; iy < N; iy++) {
    const lat = bbox[1] + ((iy + 0.5) / N) * (bbox[3] - bbox[1]);
    for (let ix = 0; ix < N; ix++) {
      const lng = bbox[0] + ((ix + 0.5) / N) * (bbox[2] - bbox[0]);
      for (const geom of geometries) {
        try {
          if (booleanPointInPolygon([lng, lat], geom)) {
            covered++;
            break;
          }
        } catch {
          /* malformed footprint — ignore */
        }
      }
    }
  }
  return covered / (N * N);
}

async function downloadScene(
  item: STACItem,
  bbox: Bbox,
  seriesId: string,
  token?: string
): Promise<RasterLayer> {
  // All tiles of the overpass that touch the selection take part in the
  // mosaic. Tiles can sit in different UTM zones near a zone boundary; the
  // mosaic grid needs one CRS, so keep the zone that covers the most area.
  const candidates = tilesOf(item).filter(t => intersectsBbox(t, bbox));
  const tiles = candidates.length > 0 ? candidates : [tilesOf(item)[0]];

  const overlapByEpsg = new Map<number, number>();
  for (const tile of tiles) {
    const epsg = tile.properties['proj:epsg'] ?? 0;
    const overlap = tile.bbox ? getBboxIntersectionArea(tile.bbox as Bbox, bbox) : 0;
    overlapByEpsg.set(epsg, (overlapByEpsg.get(epsg) || 0) + overlap);
  }
  const bestEpsg = Array.from(overlapByEpsg.entries()).sort((a, b) => b[1] - a[1])[0][0];
  const sameZone = tiles.filter(t => (t.properties['proj:epsg'] ?? 0) === bestEpsg);

  const mosaicTiles: MosaicTile[] = await Promise.all(
    sameZone.map(async tile => {
      const signed = await signSTACItem(tile, token);
      const bandUrls: Record<string, string> = {};
      for (const asset of SERIES_ASSETS) {
        const href = signed.assets[asset]?.href;
        if (href) bandUrls[asset] = href;
      }
      if (!bandUrls['B04'] || !bandUrls['B08']) {
        throw new Error(`Scene ${tile.id} is missing the B04/B08 assets.`);
      }
      return { bandUrls };
    })
  );

  const crs = bestEpsg ? `EPSG:${bestEpsg}` : 'EPSG:4326';
  const date = item.properties.datetime.split('T')[0];
  const data = await fetchSceneMosaic(mosaicTiles, bbox, crs, DEFAULT_OPTIONS);
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
