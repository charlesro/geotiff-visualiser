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
import { CancelCheck, throwIfCancelled } from './cancel';
import { GeoTIFFData, clearTiffCache, evictTiff } from './geotiff-utils';

/**
 * Sentinel-2 time-series acquisition for the workflow.
 *
 * Searches the Planetary Computer STAC catalogue over the selection bbox,
 * keeps only the acquisition dates whose swath actually covers the whole
 * selection, picks evenly-spaced dates among them, and downloads a mosaic
 * of every MGRS tile of each date so the full area is present in each scene.
 */

const SERIES_ASSETS = ['B02', 'B03', 'B04', 'B08'];

/** A date gives a clean, all-fields scene when it covers at least this share. */
const MIN_COVERAGE = 0.98;

/**
 * Fallback floor when no date covers every field (selection spans several
 * overpasses): keep dates imaging at least this share, so each scene is still
 * worthwhile and the heterogeneous series has a well-covered core to settle on.
 */
export const PARTIAL_COVERAGE = 0.3;

export interface SeriesFetchParams {
  startDate: string;
  endDate: string;
  maxCloudCover: number;
  targetCount: number;
  /** Download every covered date instead of `targetCount` evenly-spaced ones. */
  fetchAll?: boolean;
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
  /** Dates dropped because their swath images too little of the selection. */
  partialDates: number;
  /**
   * True when no single date covered every field, so the series was built
   * heterogeneously — each field carries only the dates that imaged it.
   */
  heterogeneous: boolean;
}

export async function fetchSentinelSeries(
  bbox: Bbox,
  params: SeriesFetchParams,
  onProgress: (p: SeriesProgress) => void,
  isCancelled?: CancelCheck,
  /** Padded bboxes of the polygon clusters — fetched at native 10 m for the analysis. */
  analysisBboxes: Bbox[] = []
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

  // Coverage of the fields we analyse, per date. Measured over the polygon
  // clusters, not the padded selection rectangle: a wide selection's empty
  // corners often poke past a swath edge even when every field sits inside one
  // overpass, and a swath edge crossing empty space need not be mosaicked.
  const aoi = analysisBboxes.length > 0 ? analysisBboxes : [bbox];
  const withCoverage = byDate.map(item => ({ item, cov: dateCoverage(item, aoi) }));

  // Prefer dates that image (essentially) every field — a clean series. If
  // none does, the selection spans several Sentinel-2 overpasses; rather than
  // give up, fall back to a heterogeneous series of every date that images a
  // worthwhile share of the fields. Each field then carries only the dates it
  // was imaged on, and the PCA settles on the largest consistently-covered
  // core (see runPixelPca). Empty / near-empty dates are still dropped.
  const full = withCoverage.filter(d => d.cov >= MIN_COVERAGE);
  const heterogeneous = full.length === 0;
  const usable = (heterogeneous ? withCoverage.filter(d => d.cov >= PARTIAL_COVERAGE) : full).map(d => d.item);
  const partialDates = byDate.length - usable.length;
  if (usable.length === 0) {
    throw new Error(
      `${byDate.length} date(s) matched but none images a usable share of the selected fields — ` +
        'check the cloud-cover limit, or that the fields fall within the Sentinel-2 coverage.'
    );
  }
  const covered = usable;

  const picked = (params.fetchAll ? [...covered] : selectEvenlySpaced(covered, params.targetCount)).sort(
    (a, b) => new Date(a.properties.datetime).getTime() - new Date(b.properties.datetime).getTime()
  );

  const seriesId = crypto.randomUUID();
  const layers: RasterLayer[] = [];
  const failedDates: string[] = [];

  for (let i = 0; i < picked.length; i++) {
    throwIfCancelled(isCancelled);
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
      const onWindows = (done: number, total: number) =>
        onProgress({
          stage: 'downloading',
          current: i,
          total: picked.length,
          message: `Scene ${i + 1}/${picked.length} (${date}) — 10 m window ${done}/${total}…`,
        });
      layers.push(await downloadScene(item, bbox, seriesId, params.token, isCancelled, analysisBboxes, onWindows));
    } catch (e) {
      throwIfCancelled(isCancelled);
      console.error(`Failed to download scene ${date}:`, e);
      failedDates.push(date);
    } finally {
      // Block caches of this date's COGs are useless for the next date.
      clearTiffCache();
    }
  }

  onProgress({ stage: 'downloading', current: picked.length, total: picked.length, message: 'Done' });

  if (layers.length === 0) {
    throw new Error('All matching scenes failed to download. Check your network and try again.');
  }
  return { layers, failedDates, partialDates, heterogeneous };
}

const tilesOf = (item: STACItem): STACItem[] => (item.groupItems?.length ? item.groupItems : [item]);

const intersectsBbox = (tile: STACItem, bbox: Bbox): boolean =>
  !!tile.bbox && getBboxIntersectionArea(tile.bbox as Bbox, bbox) > 0;

/**
 * Fraction of the area of interest covered by the date's tile footprints,
 * estimated on a point grid sampled *inside* the AOI rectangles (the polygon
 * clusters). The STAC geometry is the *data* footprint, so swath-edge tiles
 * only count where they really have pixels. Each rectangle is sampled on its
 * own grid, so a date that misses a whole cluster is correctly penalised, but
 * empty land between clusters never counts against it.
 */
function dateCoverage(item: STACItem, aoiBboxes: Bbox[]): number {
  const geometries = tilesOf(item)
    .map(t => t.geometry)
    .filter(Boolean);
  if (geometries.length === 0 || aoiBboxes.length === 0) return 0;

  // ~1500 sample points total, spread evenly across the clusters.
  const N = Math.max(2, Math.min(10, Math.round(Math.sqrt(1500 / aoiBboxes.length))));
  let covered = 0;
  let total = 0;
  for (const box of aoiBboxes) {
    for (let iy = 0; iy < N; iy++) {
      const lat = box[1] + ((iy + 0.5) / N) * (box[3] - box[1]);
      for (let ix = 0; ix < N; ix++) {
        const lng = box[0] + ((ix + 0.5) / N) * (box[2] - box[0]);
        total++;
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
  }
  return total > 0 ? covered / total : 0;
}

/**
 * The tiles of one acquisition that matter for a selection, and the CRS to
 * mosaic them in. Tiles can straddle a UTM zone boundary while the mosaic grid
 * needs a single CRS, so the zone covering the most of the selection wins and
 * the others are dropped.
 */
function tilesForSelection(item: STACItem, bbox: Bbox): { tiles: STACItem[]; crs: string } {
  const touching = tilesOf(item).filter(t => intersectsBbox(t, bbox));
  const tiles = touching.length > 0 ? touching : [tilesOf(item)[0]];
  const overlapByEpsg = new Map<number, number>();
  for (const tile of tiles) {
    const epsg = tile.properties['proj:epsg'] ?? 0;
    const overlap = tile.bbox ? getBboxIntersectionArea(tile.bbox as Bbox, bbox) : 0;
    overlapByEpsg.set(epsg, (overlapByEpsg.get(epsg) || 0) + overlap);
  }
  const bestEpsg = Array.from(overlapByEpsg.entries()).sort((a, b) => b[1] - a[1])[0][0];
  return {
    tiles: tiles.filter(t => (t.properties['proj:epsg'] ?? 0) === bestEpsg),
    crs: bestEpsg ? `EPSG:${bestEpsg}` : 'EPSG:4326',
  };
}

async function downloadScene(
  item: STACItem,
  bbox: Bbox,
  seriesId: string,
  token?: string,
  isCancelled?: CancelCheck,
  analysisBboxes: Bbox[] = [],
  onWindows?: (done: number, total: number) => void
): Promise<RasterLayer> {
  const { tiles: sameZone, crs } = tilesForSelection(item, bbox);

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

  const date = item.properties.datetime.split('T')[0];
  const data = await fetchSceneMosaic(mosaicTiles, bbox, crs, DEFAULT_OPTIONS, isCancelled);

  // When the preview mosaic was downsampled, additionally fetch one
  // native-10 m grid per polygon cluster — the analysis reads those, so the
  // interior/edge split stays at 10 m no matter how large the selection is.
  const previewRes = data.metadata.resolution?.[0] ?? 10;
  let analysisGrids: GeoTIFFData[] | undefined;
  if (previewRes > 10 && analysisBboxes.length > 0) {
    analysisGrids = await fetchAnalysisGrids(mosaicTiles, analysisBboxes, crs, isCancelled, onWindows);
  }

  return createRasterLayer({
    name: `S2 ${date}`,
    data,
    visible: false,
    stacItem: item,
    seriesId,
    datetime: item.properties.datetime,
    remoteBbox: bbox,
    analysisGrids,
  });
}

/** Download the per-cluster 10 m windows, a few clusters at a time. */
async function fetchAnalysisGrids(
  tiles: MosaicTile[],
  bboxes: Bbox[],
  crs: string,
  isCancelled?: CancelCheck,
  onWindows?: (done: number, total: number) => void
): Promise<GeoTIFFData[]> {
  const grids: GeoTIFFData[] = [];
  const queue = bboxes.map((b, i) => ({ bbox: b, index: i }));
  let done = 0;
  onWindows?.(0, bboxes.length);

  const WORKERS = 3; // each window already reads its bands in parallel
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        throwIfCancelled(isCancelled);
        grids[next.index] = await fetchSceneMosaic(tiles, next.bbox, crs, DEFAULT_OPTIONS, isCancelled, {
          skipCanvas: true,
        });
        onWindows?.(++done, bboxes.length);
      }
    })
  );
  return grids;
}

// ---------------------------------------------------------------------------
// Filling a hole in an existing series
//
// `fetchSentinelSeries` searches and downloads in one go, choosing dates for
// you. Filling a gap is the opposite: the user points at a hole and needs to
// see what the catalogue actually holds there — dates, how cloudy, how much of
// the fields they image — before spending a download on one. So the two halves
// are also exposed separately.
// ---------------------------------------------------------------------------

/** One acquisition the catalogue offers, before deciding whether to download it. */
export interface SceneCandidate {
  date: string;
  /** Scene cloud cover (%), worst of the tiles making up the date. */
  cloudCover: number | null;
  /** Share of the analysed fields the date's swath actually images (0–1). */
  coverage: number;
  /**
   * The same share, restricted to the growth scenario the picker was opened
   * from (0–1), or null when it was not opened from one. A gap is a gap in ONE
   * scenario's curve, and a swath clipping the far side of the selection can
   * image most of the fields while missing every field in that scenario.
   */
  scopeCoverage: number | null;
  item: STACItem;
}

/**
 * What the catalogue holds between two dates, newest information first: every
 * acquisition with its cloud cover and how much of the fields it images.
 * Nothing is downloaded. `maxCloudCover` is deliberately a search filter only —
 * a date that is 60% cloudy over the tile may still be clear over the fields,
 * so the caller is shown the number and decides.
 */
export async function searchSceneCandidates(
  bbox: Bbox,
  params: { startDate: string; endDate: string; maxCloudCover: number; token?: string },
  analysisBboxes: Bbox[] = [],
  scopeBboxes: Bbox[] = []
): Promise<SceneCandidate[]> {
  const items = await searchSentinel2Chunked(
    bbox,
    params.startDate,
    params.endDate,
    params.maxCloudCover,
    params.token || undefined
  );
  if (items.length === 0) return [];
  const aoi = analysisBboxes.length > 0 ? analysisBboxes : [bbox];
  return groupItemsByDate(items)
    .map(item => {
      const tiles = tilesOf(item);
      const clouds = tiles
        .map(t => t.properties?.['eo:cloud_cover'])
        .filter((c): c is number => typeof c === 'number');
      return {
        date: item.properties.datetime.split('T')[0],
        cloudCover: clouds.length ? Math.max(...clouds) : null,
        coverage: dateCoverage(item, aoi),
        scopeCoverage: scopeBboxes.length > 0 ? dateCoverage(item, scopeBboxes) : null,
        item,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Download specific acquisitions the caller chose from `searchSceneCandidates`.
 * `seriesId` should be the one the existing scenes already carry, so the new
 * layers belong to the same series.
 */
export async function downloadSceneCandidates(
  candidates: SceneCandidate[],
  bbox: Bbox,
  seriesId: string,
  onProgress: (p: SeriesProgress) => void,
  token?: string,
  isCancelled?: CancelCheck,
  analysisBboxes: Bbox[] = []
): Promise<{ layers: RasterLayer[]; failedDates: string[] }> {
  const layers: RasterLayer[] = [];
  const failedDates: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    throwIfCancelled(isCancelled);
    const { item, date } = candidates[i];
    try {
      const onWindows = (done: number, total: number) =>
        onProgress({
          stage: 'downloading',
          current: i,
          total: candidates.length,
          message: `Scene ${i + 1}/${candidates.length} (${date}) — 10 m window ${done}/${total}…`,
        });
      onProgress({ stage: 'downloading', current: i, total: candidates.length, message: `Downloading ${date}…` });
      layers.push(await downloadScene(item, bbox, seriesId, token, isCancelled, analysisBboxes, onWindows));
    } catch (e) {
      throwIfCancelled(isCancelled);
      console.error(`Failed to download scene ${date}:`, e);
      failedDates.push(date);
    } finally {
      clearTiffCache();
    }
  }
  return { layers, failedDates };
}

// ---------------------------------------------------------------------------
// Is the scene actually clear over THESE fields?
//
// `eo:cloud_cover` is a whole-tile figure — 110 x 110 km — so it says almost
// nothing about a handful of fields inside it: a 70%-cloudy tile can be
// perfectly clear over them, and a 10%-cloudy one can have the single cloud
// parked right on top. Sentinel-2 L2A ships a per-pixel Scene Classification
// (SCL, 20 m) that labels cloud, cirrus and cloud shadow, so the question can
// be answered properly by reading it over the fields alone.
// ---------------------------------------------------------------------------

/** SCL classes that mean "ground was seen": vegetation, bare soil, water. */
const SCL_CLEAR = new Set([4, 5, 6]);
/** SCL classes that mean "obscured": shadow, cloud medium/high, thin cirrus. */
const SCL_OBSCURED = new Set([3, 8, 9, 10]);

export interface SceneClarity {
  /** Share of the fields' pixels where the ground was seen (0–1). */
  clear: number;
  /** Share obscured by cloud, cirrus or cloud shadow (0–1). */
  obscured: number;
  /**
   * Share that is neither: snow/ice, cast shadow, saturated or unclassified.
   * The ground was not seen there either, but the reason is not cloud — folding
   * these into `obscured` would overstate cloud, and leaving them out of the
   * denominator would let a snow-covered scene report as fully clear.
   */
  unusable: number;
  /** Pixels the swath actually covered — 0 means the fields were outside it. */
  covered: number;
}

/**
 * Read the Scene Classification band over the analysed field windows and report
 * how much of the ground was actually visible. Only the SCL asset is fetched,
 * at 20 m, over the polygon-cluster bboxes — a far smaller read than the four
 * 10 m bands a full scene download pulls.
 *
 * Returns null when the item has no SCL asset (older or non-L2A products).
 */
export async function readSceneClarity(
  item: STACItem,
  bbox: Bbox,
  analysisBboxes: Bbox[],
  token?: string,
  isCancelled?: CancelCheck
): Promise<SceneClarity | null> {
  const { tiles: sameZone, crs } = tilesForSelection(item, bbox);

  const mosaicTiles: MosaicTile[] = [];
  for (const tile of sameZone) {
    const signed = await signSTACItem(tile, token);
    const href = signed.assets['SCL']?.href;
    if (href) mosaicTiles.push({ bandUrls: { SCL: href } });
  }
  if (mosaicTiles.length === 0) return null;

  // The fields' own windows, not the whole selection rectangle — the empty land
  // between clusters must not dilute the answer.
  const windows = analysisBboxes.length > 0 ? analysisBboxes : [bbox];

  let clear = 0;
  let obscured = 0;
  let covered = 0;
  try {
    for (const win of windows) {
      throwIfCancelled(isCancelled);
      const grid = await fetchSceneMosaic(mosaicTiles, win, crs, DEFAULT_OPTIONS, isCancelled, { skipCanvas: true });
      const scl = grid.bandData?.['SCL'];
      if (!scl) continue;
      for (let i = 0; i < scl.length; i++) {
        const v = Math.round(scl[i]);
        if (v === 0) continue; // no data — outside the swath, not a verdict
        covered++;
        if (SCL_CLEAR.has(v)) clear++;
        else if (SCL_OBSCURED.has(v)) obscured++;
      }
    }
  } finally {
    // Evict only what this read added. A full `clearTiffCache()` would also drop
    // the 10 m bands an insert running alongside it is still reading, forcing a
    // re-fetch of every remaining window.
    for (const t of mosaicTiles) evictTiff(t.bandUrls.SCL);
  }
  if (covered === 0) return null;
  return {
    clear: clear / covered,
    obscured: obscured / covered,
    unusable: (covered - clear - obscured) / covered,
    covered,
  };
}
