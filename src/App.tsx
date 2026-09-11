import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { Grid3x3, Layers, RotateCcw } from 'lucide-react';
import { RasterLayer } from './types';
import { Bbox, getGeoJsonBounds, bufferBboxMeters, getBboxIntersectionArea } from './lib/geo';
import {
  loadPolygonsFromDatabase,
  loadPolygonsFromFile,
  mergePolygonCollections,
  polygonLabel,
} from './lib/polygon-source';
import { summarizeExtraction, NdviInspection, NdviPixel } from './lib/ndvi-series';
import NdviPanel from './components/NdviPanel';
import {
  fetchSentinelSeries,
  searchSceneCandidates,
  downloadSceneCandidates,
  readSceneClarity,
  SceneCandidate,
  SceneClarity,
  SeriesFetchParams,
  SeriesProgress,
} from './lib/fetch-series';
import { clusterFeatureBboxes } from './lib/cluster';
import { GeoTIFFData } from './lib/geotiff-utils';
import { extractZones, featureKey, fieldGapMeters, PixelZone, ZoneExtraction, ZoneProgress } from './lib/zones';
import { computeUnmixing } from './lib/unmix';
import { clusterBySpecies, SpeciesClustering, fieldKeyOf } from './lib/species-clusters';
import { runPixelPca, pcaScoresToCsv, PcaRunResult } from './lib/pca';
import { DrMethod } from './lib/projections';
import { isCancelledError } from './lib/cancel';
import { DatasetDateRange } from './lib/neighbor-query';
import {
  growingSeasonFromClusters,
  seasonFromPicks,
  pickKey,
  remapSeasonPicks,
  SeasonPicks,
  GrowingSeasonResult,
  dayIndex,
} from './lib/phenology';
import { loadCropCalendars, CropCalendarBook } from './lib/crop-calendars';
import { cacheClear, cacheDelete, cacheGet, cacheSet, reviveScenes, serializeScenes } from './lib/persist';
import MapPanel, { ScenePreview } from './components/MapPanel';
import Sidebar, { StepDescriptor } from './components/Sidebar';
import PolygonsStep from './components/steps/PolygonsStep';
import ImageryStep from './components/steps/ImageryStep';
import ZonesStep from './components/steps/ZonesStep';
import ClusterStep from './components/steps/ClusterStep';
import PcaStep, { PCA_SCOPE_ALL, parsePcaScope } from './components/steps/PcaStep';
import BoundaryStep from './components/steps/BoundaryStep';
import BoundaryPredictStep from './components/steps/BoundaryPredictStep';
import { computeBoundaryPrediction, renderPredictionOverlay, BoundaryPrediction, PredictMethod } from './lib/boundary-detect';
import PcaPanel from './components/PcaPanel';
import ClusterSeasonPanel from './components/cluster/ClusterSeasonPanel';
import { KEEP_TOP_DEFAULT } from './components/cluster/model';
import BoundaryProfilePanel from './components/BoundaryProfilePanel';

/**
 * Polygon Time-Series PCA.
 *
 * One linear workflow: load polygons (database or file) → select them on the
 * map → fetch a Sentinel-2 time series over the selection → split each
 * polygon's pixels into interior / edge zones by distance to the boundary →
 * run a PCA on the pixel time series.
 */

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** PCA defaults: fit on the pure interior, show interior vs different-species edge. */
const PCA_DEFAULT_FIT: PixelZone[] = ['interior'];
const PCA_DEFAULT_PROJECT: PixelZone[] = ['interior', 'edge_other_species'];

/**
 * A first guess at each scenario's growth period, from the shape of its curve.
 *
 * Deliberately a starting point rather than an answer: on a month-gapped series
 * the green-up is not identifiable, which is why the window is a human input at
 * all. But an approximately-right window that the user drags into place beats an
 * empty chart, and the fit drawn over it says immediately whether it is close.
 */
function proposePicks(clustering: SpeciesClustering, maxPerSpecies: number): SeasonPicks {
  const guessed = growingSeasonFromClusters(clustering, { maxPerSpecies });
  const base = Number(clustering.dates[0]?.slice(0, 4)) || 2021;
  const out: SeasonPicks = {};
  for (const pc of guessed.perCluster ?? []) {
    if (!pc.window) continue;
    const start = dayIndex(pc.window.start, base);
    const end = dayIndex(pc.window.end, base);
    if (start != null && end != null && end > start) out[pickKey(pc.species, pc.cluster)] = { start, end };
  }
  return out;
}

/** The Planetary Computer key, if the user saved one — anonymous access otherwise. */
const mpcToken = () => localStorage.getItem('mpc_token') || undefined;

export default function App() {
  // Step 1 — polygons & selection
  const [polygons, setPolygons] = useState<any | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [polygonsBusy, setPolygonsBusy] = useState(false);
  const [polygonsError, setPolygonsError] = useState<string | null>(null);
  // Bordering fields of other species, hidden from the analysis but kept so the
  // toggle can bring them back. Empty = nothing hidden.
  const [stashedBordering, setStashedBordering] = useState<any[]>([]);

  // Step 2 — imagery
  const [scenes, setScenes] = useState<RasterLayer[]>([]);
  const [failedDates, setFailedDates] = useState<string[]>([]);
  const [partialDates, setPartialDates] = useState(0);
  /** No single date imaged every field — the series is heterogeneous. */
  const [heterogeneous, setHeterogeneous] = useState(false);
  /** Selection the series was fetched for — the 10 m windows cover only it. */
  const [fetchedSelectionKey, setFetchedSelectionKey] = useState<string | null>(null);
  const [seriesBusy, setSeriesBusy] = useState(false);
  const [seriesProgress, setSeriesProgress] = useState<SeriesProgress | null>(null);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [previewSceneId, setPreviewSceneId] = useState<string | null>(null);

  // Step 3 — buffer zones
  const [zones, setZones] = useState<ZoneExtraction | null>(null);
  const [zonesBusy, setZonesBusy] = useState(false);
  const [zonesProgress, setZonesProgress] = useState<ZoneProgress | null>(null);
  const [zonesError, setZonesError] = useState<string | null>(null);
  /** Selection the zones were extracted from — to flag (not wipe) staleness. */
  const [zonesSelectionKey, setZonesSelectionKey] = useState<string | null>(null);

  // Step 4 — growth scenarios: species clustering + the growing season read from
  // it. Both live in the Growth-scenarios window (ClusterSeasonPanel).
  const [clustering, setClustering] = useState<SpeciesClustering | null>(null);
  const [clusteringBusy, setClusteringBusy] = useState(false);
  const [clusteringError, setClusteringError] = useState<string | null>(null);
  /** Keep only the N most-represented scenarios per species (Infinity = all). */
  // Keeping only the best-represented scenarios is a goal of this step, not an
  // afterthought: k is deliberately generous so the clustering separates sowing
  // dates finely, and then the small outlier scenarios are dropped. Starting at
  // "keep everything" put twenty curves in front of the user to mark by hand.
  const [topScenarios, setTopScenarios] = useState<number>(KEEP_TOP_DEFAULT);
  /** Drop scenarios whose detected window is off the crop's known Wallonia
   *  calendar (likely a mislabel / a different actual crop). */
  const [matchCalendarOnly, setMatchCalendarOnly] = useState(false);
  /** Growing season marked by the user on each scenario's curve, keyed by
   *  species+cluster. Detecting it automatically from a month-gapped series is
   *  unreliable, so the window is an input rather than an inference. */
  const [seasonPicks, setSeasonPicks] = useState<SeasonPicks>({});
  /** The season built from those picks — shared by the scenario charts, the NDVI
   *  band and the PCA date filter. Null until at least one scenario is marked. */
  const [season, setSeason] = useState<GrowingSeasonResult | null>(null);
  const [seasonBusy, setSeasonBusy] = useState(false);
  const [seasonError, setSeasonError] = useState<string | null>(null);

  // Step 5 — PCA
  const [pcaScope, setPcaScope] = useState<string>(PCA_SCOPE_ALL);
  /** Subset of extracted fields (pids) the PCA runs on; null = all, empty = none.
   *  Defaults to none so the user picks the fields/groups deliberately. */
  const [pcaFields, setPcaFields] = useState<Set<number> | null>(new Set());
  // Default: fit the axes on the pure interior pixels, and display the
  // interior vs the edge facing another species (the comparison of interest).
  const [pcaFitZones, setPcaFitZones] = useState<PixelZone[]>(PCA_DEFAULT_FIT);
  const [pcaProjectZones, setPcaProjectZones] = useState<PixelZone[]>(PCA_DEFAULT_PROJECT);
  const [pcaMethod, setPcaMethod] = useState<DrMethod>('pca');
  const [pcaResult, setPcaResult] = useState<PcaRunResult | null>(null);
  const [pcaBusy, setPcaBusy] = useState(false);
  const [pcaError, setPcaError] = useState<string | null>(null);
  /** Restrict the PCA to the growing season while the fetch stays whole-year —
   *  the actual-plant dates are extracted at analysis time. */
  const [restrictPcaToSeason, setRestrictPcaToSeason] = useState(false);
  const [showPcaPanel, setShowPcaPanel] = useState(false);
  const [showClusterPanel, setShowClusterPanel] = useState(false);
  const [showBoundaryPanel, setShowBoundaryPanel] = useState(false);
  /** Edge·other pixels flagged as boundaries in the PCA-gap finder. */
  const [pcaBoundaryPixels, setPcaBoundaryPixels] = useState<{ id: string; lng: number; lat: number }[]>([]);
  const [pcaSelectedPixels, setPcaSelectedPixels] = useState<{ id: string; lng: number; lat: number }[]>([]);

  // Step 7 — boundary prediction
  const [prediction, setPrediction] = useState<BoundaryPrediction | null>(null);
  const [predictBusy, setPredictBusy] = useState(false);
  const [predictError, setPredictError] = useState<string | null>(null);
  const [predictMethod, setPredictMethod] = useState<PredictMethod | 'off'>('pca');
  const [predictThreshold, setPredictThreshold] = useState(0.3);
  /** Width of the results drawer (drag its left edge to resize). */
  const [pcaPanelWidth, setPcaPanelWidth] = useState(() => {
    const saved = Number(localStorage.getItem('ppca_panel_w'));
    return saved >= 440 ? saved : 660;
  });
  const onPcaPanelWidth = useCallback((w: number) => {
    setPcaPanelWidth(w);
    localStorage.setItem('ppca_panel_w', String(w));
  }, []);
  /** Width of the growth-scenarios drawer (its own persisted key). */
  const [clusterPanelWidth, setClusterPanelWidth] = useState(() => {
    const saved = Number(localStorage.getItem('ppca_cluster_panel_w'));
    return saved >= 440 ? saved : 620;
  });
  const onClusterPanelWidth = useCallback((w: number) => {
    setClusterPanelWidth(w);
    localStorage.setItem('ppca_cluster_panel_w', String(w));
  }, []);
  // One right-side drawer at a time — opening one closes the other.
  const openClusterPanel = useCallback(() => {
    setShowPcaPanel(false);
    setShowClusterPanel(true);
  }, []);
  const closeClusterPanel = useCallback(() => setShowClusterPanel(false), []);
  const openPcaPanel = useCallback(() => {
    setShowClusterPanel(false);
    setShowPcaPanel(true);
  }, []);

  const [activeStep, setActiveStep] = useState(1);
  const [fitRequest, setFitRequest] = useState<{
    bounds: Bbox;
    token: number;
    padRight?: number;
    maxZoom?: number;
  } | null>(null);

  // Acquisition span of the connected dataset; used as the default fetch period.
  const [datasetRange, setDatasetRange] = useState<DatasetDateRange | null>(() => {
    try {
      return JSON.parse(localStorage.getItem('ppca_dataset_range') || 'null');
    } catch {
      return null;
    }
  });
  const onDatasetRange = useCallback((range: DatasetDateRange) => {
    setDatasetRange(range);
    localStorage.setItem('ppca_dataset_range', JSON.stringify(range));
  }, []);

  // ----- Reload persistence ---------------------------------------------------
  // Polygons, selection and the fetched series are cached in IndexedDB and
  // restored on startup, so a refresh (or a dev update) doesn't force a
  // re-fetch. Saves only start once the initial restore is done.
  const hydratedRef = useRef(false);
  /** The scenes array that already sits in the cache — skip re-saving it. */
  const persistedScenesRef = useRef<RasterLayer[] | null>(null);
  /** The zones object already in the cache — skip re-saving the just-restored one. */
  const persistedZonesRef = useRef<ZoneExtraction | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const poly = await cacheGet<{ collection: any; sourceLabel: string }>('polygons');
        if (poly?.collection) {
          setPolygons((prev: any) => prev ?? poly.collection);
          setSourceLabel(prev => prev || poly.sourceLabel);
        }
        const sel = await cacheGet<number[]>('selection');
        if (sel?.length) setSelectedIds(prev => (prev.size > 0 ? prev : new Set(sel)));
        const bordering = await cacheGet<any[]>('bordering');
        if (bordering?.length) setStashedBordering(prev => (prev.length > 0 ? prev : bordering));
        const series = await cacheGet<any>('series');
        if (series?.scenes?.length) {
          const revived = reviveScenes(series.scenes);
          persistedScenesRef.current = revived;
          setScenes(prev => (prev.length > 0 ? prev : revived));
          setFailedDates(prev => (prev.length > 0 ? prev : series.failedDates || []));
          setPartialDates(prev => prev || series.partialDates || 0);
          setHeterogeneous(prev => prev || series.heterogeneous || false);
          setFetchedSelectionKey(prev => prev ?? series.fetchedSelectionKey ?? null);
        }
        const zoneCache = await cacheGet<{ zones: ZoneExtraction; key: string | null }>('zones');
        if (zoneCache?.zones) {
          persistedZonesRef.current = zoneCache.zones;
          setZones(prev => prev ?? zoneCache.zones);
          setZonesSelectionKey(prev => (prev !== null ? prev : zoneCache.key ?? null));
        }
        const preview = await cacheGet<string>('preview');
        if (preview) setPreviewSceneId(prev => prev ?? preview);
      } catch (e) {
        console.warn('Cache restore failed:', e);
      } finally {
        hydratedRef.current = true;
      }
    })();
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (polygons) cacheSet('polygons', { collection: polygons, sourceLabel });
    else cacheDelete('polygons');
  }, [polygons, sourceLabel]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (stashedBordering.length) cacheSet('bordering', stashedBordering);
    else cacheDelete('bordering');
  }, [stashedBordering]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    cacheSet('selection', Array.from(selectedIds));
  }, [selectedIds]);

  // The series is hundreds of MB of band data — debounce so pruning scenes
  // with the Delete key doesn't write it once per keystroke.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (scenes.length === 0) {
      cacheDelete('series');
      return;
    }
    if (scenes === persistedScenesRef.current) return; // just restored — already cached
    const t = setTimeout(() => {
      persistedScenesRef.current = scenes;
      cacheSet('series', {
        scenes: serializeScenes(scenes),
        failedDates,
        partialDates,
        heterogeneous,
        fetchedSelectionKey,
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [scenes, failedDates, partialDates, heterogeneous, fetchedSelectionKey]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    cacheSet('preview', previewSceneId);
  }, [previewSceneId]);

  // The extracted zones (pixel features per class) survive a reload too — they
  // can be the slowest thing to recompute. Debounced; large but plain data.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!zones) {
      cacheDelete('zones');
      return;
    }
    if (zones === persistedZonesRef.current) return; // just restored — already cached
    const t = setTimeout(() => {
      persistedZonesRef.current = zones;
      cacheSet('zones', { zones, key: zonesSelectionKey });
    }, 800);
    return () => clearTimeout(t);
  }, [zones, zonesSelectionKey]);

  // One cancellation handle for whichever operation is currently running.
  // Stop flips the flag (polled by the long loops) and aborts in-flight
  // engine queries.
  const opRef = useRef<{ cancelled: boolean; abort: AbortController } | null>(null);
  const beginOp = () => {
    const op = { cancelled: false, abort: new AbortController() };
    opRef.current = op;
    return op;
  };
  const cancelOp = useCallback(() => {
    if (opRef.current) {
      opRef.current.cancelled = true;
      opRef.current.abort.abort();
    }
  }, []);

  const requestFit = useCallback((bounds: Bbox | null, opts?: { padRight?: number; maxZoom?: number }) => {
    if (bounds) setFitRequest({ bounds, token: Date.now(), ...opts });
  }, []);

  /** Newest detection wins: a slow earlier run must not clobber a newer one when
   *  the filters are changed in quick succession, nor republish after a reset. */
  const seasonRunId = useRef(0);
  /** Filters the currently-published season was computed with. */
  const seasonFilterRef = useRef<string | null>(null);
  /**
   * The crop calendars, loaded once for display. The season computation loads
   * them itself (it must fail loudly when the calendar filter is on); this copy
   * only feeds the guide drawn behind each curve, which has to be there before
   * any season has been computed. A failure here just means no guide.
   */
  const [cropCalendars, setCropCalendars] = useState<CropCalendarBook | null>(null);
  /** Set when a re-clustering could not carry every mark over — see `insertScenes`. */
  const [pickCarryNote, setPickCarryNote] = useState<string | null>(null);
  /**
   * Acquisition days dropped from a scenario's fit, keyed like the periods.
   * A cloudy or snow-covered date can sit far off the curve and drag the whole
   * model; excluding it is a judgement about the image, not about the crop.
   */
  const [excludedDays, setExcludedDays] = useState<Record<string, number[]>>({});
  const toggleExcluded = useCallback((species: string, cluster: number, day: number) => {
    setExcludedDays(prev => {
      const key = pickKey(species, cluster);
      const cur = prev[key] ?? [];
      const next = cur.includes(day) ? cur.filter(d => d !== day) : [...cur, day];
      return { ...prev, [key]: next };
    });
  }, []);
  useEffect(() => {
    let live = true;
    loadCropCalendars().then(
      book => live && setCropCalendars(book),
      () => {}
    );
    return () => {
      live = false;
    };
  }, []);

  /**
   * Drop everything derived from a clustering. The season's window and its
   * per-scenario entries are computed from specific clusters, and "keep top N"
   * and the PCA scope are indexed by cluster position — once the clustering
   * changes or goes away they are all meaningless, and leaving the restriction
   * armed would silently keep filtering the PCA by a window of clusters that no
   * longer exist. `matchCalendarOnly` deliberately survives: it is a preference
   * about how to judge scenarios, not something derived from these clusters.
   * Called both when re-clustering and when the clustering is cleared.
   */
  const resetScenarioDerivedState = useCallback(() => {
    setSeasonPicks({});
    setExcludedDays({});
    // Invalidate any detection still in flight: without this it would publish
    // after the reset and resurrect a season for a clustering that is gone.
    seasonRunId.current++;
    seasonFilterRef.current = null;
    setSeason(null);
    setRestrictPcaToSeason(false);
    setSeasonError(null);
    // The run invalidated just above can no longer clear this itself — its
    // `finally` only clears the flag when it is still the current run — so
    // without this the spinner and the disabled calendar filter never come back.
    setSeasonBusy(false);
    setTopScenarios(KEEP_TOP_DEFAULT);
    setSettledTopScenarios(KEEP_TOP_DEFAULT);
    setPcaScope(PCA_SCOPE_ALL);
  }, []);

  const clearFromClustering = useCallback(() => {
    setClustering(null);
    setClusteringError(null);
    resetScenarioDerivedState();
    setPcaFields(new Set());
    setPcaFitZones(PCA_DEFAULT_FIT);
    setPcaProjectZones(PCA_DEFAULT_PROJECT);
    setPcaResult(null);
    setPcaError(null);
    setShowPcaPanel(false);
    setShowClusterPanel(false);
  }, [resetScenarioDerivedState]);

  const clearFromZones = useCallback(() => {
    setZones(null);
    setZonesError(null);
    setZonesSelectionKey(null);
    clearFromClustering();
  }, [clearFromClustering]);

  const clearFromImagery = useCallback(() => {
    setScenes([]);
    setFailedDates([]);
    setPartialDates(0);
    setHeterogeneous(false);
    setFetchedSelectionKey(null);
    setSeriesError(null);
    setPreviewSceneId(null);
    setPrediction(null);
    setPredictError(null);
    clearFromZones();
  }, [clearFromZones]);

  // Single-step clears, for the per-step reset buttons (each clears its own
  // output; the cascade above already drops everything downstream).
  const clearPolygons = useCallback(() => {
    setPolygons(null);
    setSourceLabel('');
    setSelectedIds(new Set());
    setPolygonsError(null);
    setStashedBordering([]);
    clearFromImagery();
  }, [clearFromImagery]);

  const clearPca = useCallback(() => {
    setPcaResult(null);
    setPcaError(null);
    setShowPcaPanel(false);
  }, []);

  const clearPrediction = useCallback(() => {
    setPrediction(null);
    setPredictError(null);
  }, []);

  // ----- Step 1 handlers -----------------------------------------------------

  const onPolygonsLoaded = useCallback(
    (result: { collection: any; skipped: number }, label: string) => {
      setPolygons(result.collection);
      setSourceLabel(label);
      setSelectedIds(new Set());
      setPolygonsError(
        result.skipped > 0 ? `${result.skipped} feature(s) without polygon geometry were skipped.` : null
      );
      clearFromImagery();
      requestFit(getGeoJsonBounds(result.collection));
    },
    [clearFromImagery, requestFit]
  );

  const loadFromDb = useCallback(
    async (url: string, sql: string, filterRows?: (rows: any[]) => any[]) => {
      const op = beginOp();
      setPolygonsBusy(true);
      setPolygonsError(null);
      try {
        const result = await loadPolygonsFromDatabase(url, sql, op.abort.signal, filterRows);
        onPolygonsLoaded(result, 'database');
      } catch (e) {
        if (!isCancelledError(e)) setPolygonsError(errorMessage(e));
      } finally {
        setPolygonsBusy(false);
      }
    },
    [onPolygonsLoaded]
  );

  // Grow the current result by one ring of neighbouring fields (any species),
  // merging them in rather than replacing — existing selection is preserved.
  const mergeFromDb = useCallback(
    async (url: string, sql: string) => {
      const op = beginOp();
      setPolygonsBusy(true);
      setPolygonsError(null);
      try {
        const addition = await loadPolygonsFromDatabase(url, sql, op.abort.signal);
        const { collection, addedCount } = mergePolygonCollections(polygons, addition);
        setPolygons(collection);
        setPolygonsError(addedCount === 0 ? 'No new bordering fields found.' : null);
        requestFit(getGeoJsonBounds(collection));
      } catch (e) {
        if (!isCancelledError(e)) setPolygonsError(errorMessage(e));
      } finally {
        setPolygonsBusy(false);
      }
    },
    [polygons, requestFit]
  );

  // Hide / restore the bordering fields of other species. Hiding stashes them
  // (out of polygons and selection) so calculations ignore them; pressing again
  // merges them back. `selectedSpecies` are the chosen crops — everything else
  // loaded is a bordering field. Survives reloads (persisted).
  const toggleBordering = useCallback(
    (selectedSpecies: string[]) => {
      if (stashedBordering.length > 0) {
        // Restore — merge the stash back (fresh ids), re-selecting what was selected.
        const { collection } = mergePolygonCollections(polygons, {
          collection: { type: 'FeatureCollection', features: stashedBordering },
          attributes: [],
          skipped: 0,
        });
        setPolygons(collection);
        const reselect = new Set(
          stashedBordering.filter(f => f.properties?.__wasSelected).map(f => String(f.properties?.NewID))
        );
        if (reselect.size > 0) {
          setSelectedIds(prev => {
            const next = new Set(prev);
            for (const f of collection.features) {
              if (reselect.has(String(f.properties?.NewID))) next.add(f.properties.__pid);
            }
            return next;
          });
        }
        setStashedBordering([]);
      } else {
        // Hide — stash every loaded field whose crop isn't one of the chosen ones.
        const chosen = new Set(selectedSpecies.filter(Boolean));
        const feats = polygons?.features || [];
        const hide = feats.filter((f: any) => f.properties?.crp_lbl != null && !chosen.has(f.properties.crp_lbl));
        if (hide.length === 0) return;
        const hidePids = new Set(hide.map((f: any) => f.properties?.__pid));
        setStashedBordering(
          hide.map((f: any) => ({
            ...f,
            properties: { ...f.properties, __wasSelected: selectedIds.has(f.properties?.__pid) },
          }))
        );
        setSelectedIds(prev => new Set([...prev].filter(pid => !hidePids.has(pid))));
        setPolygons({ type: 'FeatureCollection', features: feats.filter((f: any) => !hidePids.has(f.properties?.__pid)) });
      }
    },
    [polygons, selectedIds, stashedBordering]
  );

  const loadFromFile = useCallback(
    async (file: File) => {
      setPolygonsBusy(true);
      setPolygonsError(null);
      try {
        const result = await loadPolygonsFromFile(file);
        onPolygonsLoaded(result, file.name);
      } catch (e) {
        setPolygonsError(errorMessage(e));
      } finally {
        setPolygonsBusy(false);
      }
    },
    [onPolygonsLoaded]
  );

  // Changing the selection does NOT wipe the extracted zones — they're an
  // expensive snapshot. The Zones step flags them as stale instead.
  const togglePolygon = useCallback((pid: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  }, []);

  /** Box draw: add a batch of polygons to the selection (never deselects). */
  const selectByBox = useCallback((pids: number[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const pid of pids) next.add(pid);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // The prediction depends on the imagery and (for PCA/impurity) the zones —
  // invalidate it whenever either changes, so a stale prediction never leaves
  // the PCA method disabled after the zones are extracted.
  useEffect(() => {
    setPrediction(null);
    setPredictError(null);
  }, [zones, scenes]);

  /** Predict field boundaries from the imagery and score against the polygons. */
  const runPrediction = useCallback(async () => {
    setPredictBusy(true);
    setPredictError(null);
    try {
      await new Promise(r => setTimeout(r, 30)); // let the spinner paint
      const result = computeBoundaryPrediction(scenes, polygons?.features || [], zones);
      setPrediction(result);
      // Show the best available method (PCA preferred, then gradient).
      setPredictMethod(result.metrics.pca.available ? 'pca' : 'gradient');
    } catch (e) {
      setPrediction(null);
      setPredictError(errorMessage(e));
    } finally {
      setPredictBusy(false);
    }
  }, [scenes, polygons, zones]);

  /** Heatmap overlays of the prediction for the chosen method/threshold. */
  const predictionOverlays = useMemo<ScenePreview[]>(() => {
    if (!prediction || predictMethod === 'off') return [];
    const out: ScenePreview[] = [];
    for (const grid of prediction.grids) {
      const url = renderPredictionOverlay(grid, predictMethod, predictThreshold);
      if (url) out.push({ url, bounds: grid.bounds, opacity: 1 });
    }
    return out;
  }, [prediction, predictMethod, predictThreshold]);

  /** Zoom the map to a single field by pid (boundary-profile inspection). */
  const focusField = useCallback(
    (pid: number | null) => {
      if (pid == null) return;
      const feature = (polygons?.features || []).find((f: any) => f.properties?.__pid === pid);
      if (feature) requestFit(getGeoJsonBounds(feature), { padRight: 660, maxZoom: 17 });
    },
    [polygons, requestFit]
  );

  const selectedFeatures = useMemo(
    () => (polygons?.features || []).filter((f: any) => selectedIds.has(f.properties.__pid)),
    [polygons, selectedIds]
  );

  // Lat/lng footprints of the fetched imagery at usable resolution — the 10 m
  // analysis windows when present, else the preview mosaic.
  const imageryBboxes = useMemo<Bbox[]>(() => {
    const scene = scenes[0];
    if (!scene) return [];
    const toBbox = (b: any): Bbox | null =>
      b ? [b[0][1], b[0][0], b[1][1], b[1][0]] : null; // [[lat,lng],[lat,lng]] → [minLng,minLat,maxLng,maxLat]
    if (scene.analysisGrids?.length) {
      return scene.analysisGrids.map(g => toBbox(g.bounds)).filter((b): b is Bbox => b !== null);
    }
    const mosaic = toBbox(scene.data?.bounds);
    return mosaic ? [mosaic] : scene.remoteBbox ? [scene.remoteBbox] : [];
  }, [scenes]);

  // Every loaded field whose footprint falls under that imagery, selected or
  // not — the candidate set when extracting "all fields covered by imagery".
  const coveredFeatures = useMemo(() => {
    if (!polygons || imageryBboxes.length === 0) return [];
    return polygons.features.filter((f: any) => {
      const fb = getGeoJsonBounds(f);
      return fb && imageryBboxes.some(ib => getBboxIntersectionArea(fb, ib) > 0);
    });
  }, [polygons, imageryBboxes]);

  // ----- Step 2 handlers -----------------------------------------------------

  // Detect the growing window per growth scenario (step-4 cluster), from each
  // scenario's clean mean interior curve — robust where individual fields are
  // unidentifiable. Scenarios with no obvious growth cycle are dropped.
  // "Keep top N" is typed digit by digit, and the intermediate values are not the
  // user's intent — widening 3 -> 10 passes through 1. Detection is a few hundred
  // ms of synchronous curve fitting and the scope clamp below is destructive, so
  // both follow a settled value; the charts keep using the live one for feedback.
  const [settledTopScenarios, setSettledTopScenarios] = useState(topScenarios);
  useEffect(() => {
    const id = setTimeout(() => setSettledTopScenarios(topScenarios), 250);
    return () => clearTimeout(id);
  }, [topScenarios]);

  const detectGrowingSeason = useCallback(async () => {
    if (!clustering) {
      throw new Error('Cluster the fields first (step 4) — the season is marked on each scenario’s growth curve.');
    }
    // Known Wallonia calendars flag off-calendar scenarios. A fetch failure is
    // non-fatal for the season itself, but it would turn "match the crop
    // calendar" into a silent no-op, so surface it rather than drop the filter.
    let calendars;
    try {
      calendars = await loadCropCalendars();
    } catch {
      if (matchCalendarOnly) {
        throw new Error('Could not load the crop calendars — the calendar filter can’t be applied.');
      }
    }
    return seasonFromPicks(clustering, seasonPicks, {
      maxPerSpecies: settledTopScenarios,
      calendars,
      matchOnly: matchCalendarOnly,
    });
  }, [clustering, seasonPicks, settledTopScenarios, matchCalendarOnly]);

  /**
   * The footprint every download and every catalogue read works from: one padded
   * bbox around the whole selection, plus one per polygon cluster so the analysis
   * grids are read at native 10 m only where there are fields.
   */
  /** Stable identity of the current selection, for "is this step still current?". */
  const selectionKey = useMemo(
    () => Array.from(selectedIds).sort((a, b) => a - b).join('.'),
    [selectedIds]
  );

  const seriesGeometry = useCallback(() => {
    const bounds = getGeoJsonBounds({ type: 'FeatureCollection', features: selectedFeatures });
    if (!bounds) return null;
    return { bbox: bufferBboxMeters(bounds, 120), clusters: clusterFeatureBboxes(selectedFeatures) };
  }, [selectedFeatures]);

  const fetchSeries = useCallback(
    async (params: SeriesFetchParams) => {
      const geom = seriesGeometry();
      if (!geom) {
        setSeriesError('Select at least one polygon first.');
        return;
      }
      const { bbox } = geom;

      const op = beginOp();
      setSeriesBusy(true);
      setSeriesError(null);
      setSeriesProgress(null);
      clearFromZones();
      try {
        // One padded bbox per polygon cluster — fetched at native 10 m for
        // the analysis even when the preview mosaic is downsampled.
        const result = await fetchSentinelSeries(bbox, params, setSeriesProgress, () => op.cancelled, geom.clusters);
        setScenes(result.layers);
        setFailedDates(result.failedDates);
        setPartialDates(result.partialDates);
        setHeterogeneous(result.heterogeneous);
        setFetchedSelectionKey(selectionKey);
        setPreviewSceneId(result.layers[result.layers.length - 1]?.id ?? null);
        requestFit(bbox);
      } catch (e) {
        setScenes([]);
        if (!isCancelledError(e)) setSeriesError(errorMessage(e));
      } finally {
        setSeriesBusy(false);
        setSeriesProgress(null);
      }
    },
    [seriesGeometry, selectedIds, clearFromZones, requestFit]
  );

  const deleteScene = useCallback(
    (id: string) => {
      // When the previewed scene is deleted, advance to the next one (by
      // date) so the series can be pruned scene after scene.
      const ordered = [...scenes].sort(
        (a, b) => new Date(a.datetime || 0).getTime() - new Date(b.datetime || 0).getTime()
      );
      const idx = ordered.findIndex(s => s.id === id);
      const fallback = ordered[idx + 1] ?? ordered[idx - 1] ?? null;
      setScenes(prev => prev.filter(s => s.id !== id));
      setPreviewSceneId(prev => (prev === id ? (fallback?.id ?? null) : prev));
      // Zones and PCA were computed from the full series — invalidate them.
      clearFromZones();
    },
    [scenes, clearFromZones]
  );

  /** True when polygons were (de)selected after the series was fetched. */
  const selectionChangedSinceFetch = useMemo(() => {
    if (scenes.length === 0 || fetchedSelectionKey === null) return false;
    return selectionKey !== fetchedSelectionKey;
  }, [scenes, fetchedSelectionKey, selectedIds]);

  /** Zones were extracted from a different selection than is now active. */
  const zonesStale = useMemo(() => {
    if (!zones || zonesSelectionKey === null) return false;
    return selectionKey !== zonesSelectionKey;
  }, [zones, zonesSelectionKey, selectedIds]);

  /** Ground pixel size the analysis runs at (m). The 10 m cluster grids win over the preview mosaic. */
  const pixelSize = useMemo(() => {
    const first = scenes[0];
    const res = first?.analysisGrids?.[0]?.metadata?.resolution?.[0] ?? first?.data?.metadata?.resolution?.[0];
    return typeof res === 'number' ? res : null;
  }, [scenes]);

  const preview = useMemo<ScenePreview | null>(() => {
    if (!previewSceneId) return null;
    const scene = scenes.find(s => s.id === previewSceneId);
    if (!scene?.dataUrl) return null;
    return { url: scene.dataUrl, bounds: scene.data.bounds, opacity: 0.85 };
  }, [previewSceneId, scenes]);

  // Native-10 m analysis grids of the previewed scene. The map renders them
  // lazily and only the ones in view — a wide selection has hundreds, and
  // rendering them all up front stalls the main thread.
  const clusterGrids = useMemo<GeoTIFFData[]>(() => {
    if (!previewSceneId) return [];
    const scene = scenes.find(s => s.id === previewSceneId);
    return scene?.analysisGrids ?? [];
  }, [previewSceneId, scenes]);

  // ----- Step 3 handlers -----------------------------------------------------

  const runZones = useCallback(
    async (distance: number, metric: string, includeOutside: boolean, neighbourGap: number, allCovered: boolean) => {
      const op = beginOp();
      setZonesBusy(true);
      setZonesError(null);
      setPcaResult(null);
      setShowPcaPanel(false);
      try {
        // "All covered" extracts every field under the imagery; otherwise just
        // the selected ones.
        const features = allCovered ? coveredFeatures : selectedFeatures;
        const result = await extractZones(
          features,
          scenes,
          distance,
          metric,
          includeOutside,
          setZonesProgress,
          () => op.cancelled,
          // Neighbour context for the edge classes: every loaded polygon.
          polygons?.features || [],
          neighbourGap
        );
        // Estimate the mixing fraction of every edge_other_species pixel and
        // attach it to the pixel features (used by the map, PCA and CSV).
        result.unmixing = computeUnmixing(result);
        setZones(result);
        // Staleness only tracks the selection in selected-mode; covered-mode
        // follows the imagery, so a selection change doesn't invalidate it.
        setZonesSelectionKey(allCovered ? null : selectionKey);
        // Scenarios and PCA were computed from the previous extraction.
        clearFromClustering();
      } catch (e) {
        setZones(null);
        if (!isCancelledError(e)) setZonesError(errorMessage(e));
      } finally {
        setZonesBusy(false);
        setZonesProgress(null);
      }
    },
    [selectedFeatures, coveredFeatures, selectedIds, scenes, polygons, clearFromClustering]
  );

  // ----- NDVI inspector -------------------------------------------------------

  const [inspectedFeature, setInspectedFeature] = useState<any | null>(null);
  const [ndviInspection, setNdviInspection] = useState<NdviInspection | null>(null);
  const [ndviBusy, setNdviBusy] = useState(false);
  const [ndviError, setNdviError] = useState<string | null>(null);
  const [highlightPixel, setHighlightPixel] = useState<NdviPixel | null>(null);

  const inspectNdvi = useCallback((feature: any) => {
    setHighlightPixel(null);
    setInspectedFeature(feature);
  }, []);

  // The inspection recomputes whenever the series changes (scene deleted,
  // re-fetch), so the chart always reflects the current scenes.
  useEffect(() => {
    if (!inspectedFeature) {
      setNdviInspection(null);
      return;
    }
    if (scenes.length === 0) {
      setNdviInspection(null);
      setNdviError('Fetch a Sentinel-2 time series in step 2 first — the chart reads those scenes.');
      return;
    }
    let stale = false;
    (async () => {
      setNdviBusy(true);
      setNdviError(null);
      try {
        // Same pipeline as step 3, for this one polygon, so the chart shows
        // exactly the pixels and zone classes the analysis uses.
        const distance = zones?.distance ?? 10;
        const extraction = await extractZones(
          [inspectedFeature],
          scenes,
          distance,
          'NDVI',
          false,
          () => {},
          undefined,
          polygons?.features || [],
          zones?.neighbourGap ?? 12
        );
        if (!stale) setNdviInspection(summarizeExtraction(extraction, polygonLabel(inspectedFeature)));
      } catch (e) {
        if (!stale) {
          setNdviInspection(null);
          setNdviError(errorMessage(e));
        }
      } finally {
        if (!stale) setNdviBusy(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [inspectedFeature, scenes, zones?.distance, zones?.neighbourGap, polygons]);

  const closeNdvi = useCallback(() => {
    setInspectedFeature(null);
    setNdviInspection(null);
    setNdviError(null);
    setNdviBusy(false);
    setHighlightPixel(null);
  }, []);

  /** Chart date click → preview that scene on the map. */
  const previewDate = useCallback(
    (date: string) => {
      const scene = scenes.find(s => s.datetime?.startsWith(date));
      if (scene) setPreviewSceneId(scene.id);
    },
    [scenes]
  );

  /** Map pixel-marker click → toggle that pixel's curve highlight. */
  const pickPixel = useCallback((pixel: NdviPixel) => {
    setHighlightPixel(prev => (prev?.id === pixel.id ? null : pixel));
  }, []);

  // Keyboard navigation: arrow keys switch scenes, Delete removes the
  // previewed one (the preview then advances, so Delete can be pressed
  // repeatedly to prune the series).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (scenes.length === 0) return;
      // Keys typed in a form field (dates, counts…) are not scene commands.
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      const currentIdx = scenes.findIndex(s => s.id === previewSceneId);
      const validIdx = currentIdx >= 0 ? currentIdx : 0;

      if (e.key === 'ArrowLeft' && validIdx > 0) {
        e.preventDefault();
        setPreviewSceneId(scenes[validIdx - 1].id);
      } else if (e.key === 'ArrowRight' && validIdx < scenes.length - 1) {
        e.preventDefault();
        setPreviewSceneId(scenes[validIdx + 1].id);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && previewSceneId) {
        e.preventDefault();
        deleteScene(previewSceneId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [scenes, previewSceneId, deleteScene]);

  // ----- Step 4 handlers -----------------------------------------------------

  const runClustering = useCallback(
    async (k: number) => {
      if (!zones) return;
      setClusteringBusy(true);
      setClusteringError(null);
      try {
        // Let the spinner paint before the synchronous k-means work.
        await new Promise(r => setTimeout(r, 30));
        setClustering(clusterBySpecies(zones, k));
        resetScenarioDerivedState();
      } catch (e) {
        setClustering(null);
        setClusteringError(errorMessage(e));
      } finally {
        setClusteringBusy(false);
      }
    },
    [zones, resetScenarioDerivedState]
  );

  /**
   * Extracted fields grouped into neighbour *clusters* for the PCA field list:
   * connected components of the adjacency graph (union-find), so every field
   * reachable through a chain of neighbours lands in one group. Adjacency is
   * measured from the *geometry* — two fields are neighbours when their
   * boundaries come within the extraction's neighbour gap. This is the app's
   * own notion of a facing neighbour, and unlike the cross-species
   * `neighbor_id` column it also links same-species neighbours and is never
   * truncated by the max-pairs limit, so a contiguous block never splits.
   * Ordered by pixel count.
   */
  const pcaFieldGroups = useMemo(() => {
    const per = zones?.perPolygon || [];
    const px = (p: { interior: number; edge: number }) => p.interior + p.edge;

    // One geometry per extracted field (the polygon rows repeat a field once
    // per neighbour pair; any of them carries the same geometry).
    const geomByKey = new Map<string, any>();
    for (const f of polygons?.features || []) {
      const k = featureKey(f);
      if (!geomByKey.has(k)) geomByKey.set(k, f);
    }
    const fields = per
      .map(p => {
        const f = geomByKey.get(p.key);
        const bbox = f ? getGeoJsonBounds(f) : null;
        return f && bbox ? { p, f, bbox } : null;
      })
      .filter((x): x is { p: (typeof per)[number]; f: any; bbox: Bbox } => x !== null);

    // Union-find over field indices; link any two within the neighbour gap.
    const gapM = Math.max(zones?.neighbourGap ?? 12, 2);
    const padded = fields.map(x => bufferBboxMeters(x.bbox, gapM));
    const parent = fields.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        if (find(i) === find(j)) continue;
        if (getBboxIntersectionArea(padded[i], padded[j]) <= 0) continue; // bbox pre-filter
        if (fieldGapMeters(fields[i].f, fields[j].f) <= gapM) parent[find(i)] = find(j);
      }
    }

    // Gather the connected components.
    const comps = new Map<number, (typeof per)[number][]>();
    for (let i = 0; i < fields.length; i++) {
      const root = find(i);
      (comps.get(root) ?? comps.set(root, []).get(root)!).push(fields[i].p);
    }

    const groups = Array.from(comps.values())
      .filter(items => items.length >= 2) // a group needs at least two neighbours
      .map(items => {
        const sorted = items.sort((a, b) => px(b) - px(a));
        return { id: sorted.map(p => p.pid).join('.'), items: sorted, px: sorted.reduce((s, p) => s + px(p), 0) };
      });
    groups.sort((a, b) => b.px - a.px);

    const grouped = new Set(groups.flatMap(g => g.items.map(i => i.key)));
    const solo = per.filter(p => !grouped.has(p.key)).sort((a, b) => px(b) - px(a));
    return { groups, solo };
  }, [zones, polygons]);

  /** Field key → scenario index, for the map coloring. */
  /**
   * Field → scenario colour for the map. "Keep top N" drops scenarios from every
   * chart, the season and the PCA scope, so it has to drop them here too: the
   * panel points the user at the map to read the clustering, and a scenario that
   * is no longer in play must not still be coloured in as if it were.
   */
  const clusterAssignment = useMemo(() => {
    if (!clustering) return null;
    const m = new Map<string, number>();
    for (const group of clustering.groups) {
      for (const f of group.fields) {
        if (f.cluster < settledTopScenarios) m.set(f.key, f.cluster);
      }
    }
    return m;
  }, [clustering, settledTopScenarios]);

  /**
   * The fields belonging to one growth scenario, as analysis bboxes. A gap the
   * user clicked is a gap in ONE scenario's curve, so how much of THAT
   * scenario a swath images is the number that decides — a scene clipping the
   * far side of the selection can image most fields and miss this one entirely.
   */
  const scenarioBboxes = useCallback(
    (scope: { species: string; cluster: number } | null): Bbox[] => {
      if (!scope || !clustering) return [];
      const group = clustering.groups.find(g => g.species === scope.species);
      const keys = new Set((group?.fields ?? []).filter(f => f.cluster === scope.cluster).map(f => f.key));
      if (keys.size === 0) return [];
      const features = selectedFeatures.filter(f => keys.has(featureKey(f)));
      return features.length > 0 ? clusterFeatureBboxes(features) : [];
    },
    [clustering, selectedFeatures]
  );

  /**
   * What the catalogue holds inside the gap the user pointed at, with cloud cover
   * and field coverage, so they can judge before spending a download. The cloud
   * limit is a search filter only: a scene 60% cloudy over the tile can still be
   * clear over the fields, so the number is shown rather than used to decide.
   *
   * `range` is already bounded by the acquisitions either side of the click. The
   * `have` filter still runs on top: a date can sit inside a gap on the chart and
   * yet be in the series, because the clustering drops dates too few fields saw,
   * and offering to download something already downloaded is never useful.
   */
  const findSceneCandidates = useCallback(
    async (
      range: { start: string; end: string },
      maxCloud: number,
      scope: { species: string; cluster: number } | null = null
    ): Promise<SceneCandidate[]> => {
      const geom = seriesGeometry();
      if (!geom) throw new Error('Select at least one polygon first.');
      if (range.end < range.start) return []; // adjacent acquisitions leave no room
      const have = new Set(scenes.map(l => l.datetime?.slice(0, 10)));
      const found = await searchSceneCandidates(
        geom.bbox,
        {
          startDate: range.start,
          endDate: range.end,
          maxCloudCover: maxCloud,
          token: mpcToken(),
        },
        geom.clusters,
        scenarioBboxes(scope)
      );
      return found.filter(c => !have.has(c.date));
    },
    [seriesGeometry, scenes, scenarioBboxes]
  );

  /**
   * How much of the fields the scene actually saw, from the Scene Classification
   * band. The tile-wide `eo:cloud_cover` cannot answer this — SCL is read at
   * 20 m over the field windows only, so it is a small read per candidate and is
   * done on demand rather than for every search result.
   */
  const checkSceneClarity = useCallback(
    async (candidate: SceneCandidate): Promise<SceneClarity | null> => {
      const geom = seriesGeometry();
      if (!geom) return null;
      return readSceneClarity(
        candidate.item,
        geom.bbox,
        geom.clusters,
        mpcToken()
      );
    },
    [seriesGeometry]
  );

  /**
   * Insert chosen acquisitions into the series and redo everything that was done
   * for the existing ones: the pixels are re-extracted with the same zone
   * settings and the scenarios re-clustered with the same k, so every chart and
   * the season come back including the new date.
   *
   * Nothing is committed until the whole replay has succeeded — a half-applied
   * insert would leave the series holding a date the zones and the clustering
   * have never seen, with nothing on screen to say so. The marks are carried
   * across by field membership (`remapSeasonPicks`), because both halves of a
   * mark are relative to the old clustering: k-means renumbers scenarios by
   * size, and an inserted date earlier than the series start moves the day axis.
   */
  const insertScenes = useCallback(
    async (chosen: SceneCandidate[]): Promise<boolean> => {
      const geom = seriesGeometry();
      if (!geom || chosen.length === 0) return false;
      const op = beginOp();
      setSeriesBusy(true);
      setSeriesError(null);
      setSeriesProgress(null);
      try {
        const seriesId = scenes[0]?.seriesId ?? crypto.randomUUID();
        const { layers, failedDates } = await downloadSceneCandidates(
          chosen,
          geom.bbox,
          seriesId,
          setSeriesProgress,
          mpcToken(),
          () => op.cancelled,
          geom.clusters
        );
        if (layers.length === 0) {
          setSeriesError(`Could not download ${failedDates.join(', ') || 'the chosen scene(s)'}.`);
          return false;
        }
        const merged = [...scenes, ...layers].sort(
          (a, b) => new Date(a.datetime || 0).getTime() - new Date(b.datetime || 0).getTime()
        );

        // Replay the downstream steps over the longer series. The extraction
        // records the settings it was made with, so they survive a reload.
        let nextZones: ZoneExtraction | null = null;
        let nextClustering: SpeciesClustering | null = null;
        let nextPicks: SeasonPicks | null = null;
        if (zones) {
          setSeriesProgress({ stage: 'downloading', current: 1, total: 1, message: 'Re-extracting pixels…' });
          // A null selection key means the extraction covered every imaged field.
          const features = zonesSelectionKey === null ? coveredFeatures : selectedFeatures;
          nextZones = await extractZones(
            features,
            merged,
            zones.distance,
            zones.metric,
            zones.includeOutside,
            setZonesProgress,
            () => op.cancelled,
            polygons?.features || [],
            zones.neighbourGap
          );
          nextZones.unmixing = computeUnmixing(nextZones);
          if (clustering) {
            setSeriesProgress({ stage: 'downloading', current: 1, total: 1, message: 'Re-clustering scenarios…' });
            nextClustering = clusterBySpecies(nextZones, clustering.k);
            nextPicks = remapSeasonPicks(clustering, nextClustering, seasonPicks);
            const lost = Object.keys(seasonPicks).length - Object.keys(nextPicks).length;
            // A date the fields mostly missed repartitions the clustering, and a
            // mark whose scenario dissolved is dropped rather than reassigned to
            // whatever now sits at that index. Say so — silently losing marks the
            // user placed by hand is worse than the stale fit this replaced.
            setPickCarryNote(
              lost > 0
                ? `${lost} of ${Object.keys(seasonPicks).length} marks could not follow the new clustering — their scenarios changed too much. Re-mark them below.`
                : null
            );
          }
        }

        // Commit as one batch, now that every step has succeeded.
        setScenes(merged);
        // Keep earlier failures visible, minus any date this insert recovered.
        const added = new Set(layers.map(l => l.datetime?.slice(0, 10)));
        setFailedDates(prev =>
          Array.from(new Set([...prev.filter(d => !added.has(d)), ...failedDates])).sort()
        );
        if (nextZones) setZones(nextZones);
        if (nextClustering) {
          setClustering(nextClustering);
          if (nextPicks) setSeasonPicks(nextPicks);
          // The season was fitted to the shorter series; the whole point of the
          // insert is that it should now be fitted to this one.
          seasonFilterRef.current = null;
        }
        return true;
      } catch (e) {
        if (isCancelledError(e)) {
          setSeriesError('Stopped — the scene was not added and nothing was re-extracted.');
        } else {
          setSeriesError(errorMessage(e));
        }
        return false;
      } finally {
        setSeriesBusy(false);
        setSeriesProgress(null);
        setZonesProgress(null);
      }
    },
    [seriesGeometry, scenes, zones, zonesSelectionKey, clustering, coveredFeatures, selectedFeatures, polygons, beginOp]
  );

  // ----- Growing-season handlers ---------------------------------------------

  /**
   * Everything the published season depends on, as one string. `createdAt`
   * stands for the clustering itself: an insert re-clusters over a longer
   * series, and a season fitted to the old one has to be recomputed even though
   * no filter and no mark changed. Written once and used by both the effect that
   * detects staleness and the run that clears it, so the two cannot drift apart.
   */
  const seasonFilterKey = `${clustering?.createdAt ?? 0}|${settledTopScenarios}|${matchCalendarOnly}|${JSON.stringify(seasonPicks)}`;

  /**
   * Run the detection and publish the result — the single place that writes the
   * season state. `enableRestriction` additionally switches the PCA's
   * growing-season restriction on when a shared window was found (the toggle
   * path); display-only callers leave the restriction untouched.
   */
  const detectAndPublishSeason = useCallback(
    async (enableRestriction: boolean) => {
      const runId = ++seasonRunId.current;
      // The inputs THIS run reads. Stamped at publish time so an input changed
      // mid-flight is not mistaken for one the published season already reflects.
      const launchedWith = seasonFilterKey;
      setSeasonBusy(true);
      try {
        const result = await detectGrowingSeason();
        if (runId !== seasonRunId.current) return null; // superseded by a newer run
        seasonFilterRef.current = launchedWith;
        setSeason(result);
        if (result.window) {
          if (enableRestriction) setRestrictPcaToSeason(true);
          setSeasonError(null);
        } else {
          setRestrictPcaToSeason(false);
          setSeasonError(result.note || 'No shared growing window across the selected crops.');
        }
        return result;
      } catch (e) {
        if (runId === seasonRunId.current) setSeasonError(errorMessage(e));
        return null;
      } finally {
        if (runId === seasonRunId.current) setSeasonBusy(false);
      }
    },
    [detectGrowingSeason, seasonFilterKey]
  );

  // Toggle the growing-season restriction; detect the window the first time it's
  // turned on. Falls back to off (whole year) if there's no shared window.
  const toggleSeasonOnly = useCallback(
    async (on: boolean) => {
      setSeasonError(null);
      if (!on) {
        setRestrictPcaToSeason(false);
        return;
      }
      if (season?.window) {
        setRestrictPcaToSeason(true); // already detected — just re-arm the restriction
        return;
      }
      await detectAndPublishSeason(true);
    },
    [season, detectAndPublishSeason]
  );

  /**
   * Record (or clear) the growing season the user marked on one scenario's
   * curve. Bounds are absolute day indices, taken from the chart's own axis.
   */
  const setSeasonPick = useCallback((species: string, cluster: number, pick: { start: number; end: number } | null) => {
    setPickCarryNote(null);
    setSeasonPicks(prev => {
      const key = pickKey(species, cluster);
      if (!pick) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      const start = Math.min(pick.start, pick.end);
      const end = Math.max(pick.start, pick.end);
      if (prev[key]?.start === start && prev[key]?.end === end) return prev;
      return { ...prev, [key]: { start, end } };
    });
  }, []);

  const clearSeasonPicks = useCallback(() => setSeasonPicks({}), []);

  /**
   * Pre-fill every unmarked scenario with the curve-shape heuristic, as a
   * starting point to correct rather than an answer to trust — reading the
   * season off a month-gapped series is exactly what turned out to be
   * unreliable. Scenarios already marked are left alone.
   */
  const suggestSeasonPicks = useCallback(() => {
    if (!clustering) return;
    const guessed = proposePicks(clustering, settledTopScenarios);
    // Never overwrite a window the user placed or adjusted by hand.
    setSeasonPicks(prev => ({ ...guessed, ...prev }));
  }, [clustering, settledTopScenarios]);

  // Keep a detected season in sync with its inputs. The ref records which ones
  // the current season was computed with, so the season merely *appearing*
  // doesn't trigger a redundant second pass (the fit is the expensive part) —
  // only a genuine change re-runs it.
  const hasPicks = Object.keys(seasonPicks).length > 0;
  useEffect(() => {
    // Recompute when the marks or the filters change. Also fires on the FIRST
    // mark, when no season exists yet.
    if (!season && !hasPicks) return;
    if (seasonFilterRef.current === seasonFilterKey) return; // already reflects this input
    void detectAndPublishSeason(false);
  }, [season, hasPicks, seasonFilterKey, detectAndPublishSeason]);

  // A scenario dropped by "keep top N" must not stay the PCA scope: the step's
  // select filters its options by the same rule, so the control would go blank
  // while the run still silently targeted the now-hidden scenario.
  //
  // "Keep top N" is typed digit by digit, so widening 3 -> 10 passes through 1
  // and would clear the scope on the way. The cleared scope is remembered and
  // put back once the field is wide enough to hold it again.
  const shelvedPcaScope = useRef<string | null>(null);
  useEffect(() => {
    const scoped = parsePcaScope(pcaScope);
    if (scoped && scoped.cluster >= settledTopScenarios) {
      shelvedPcaScope.current = pcaScope;
      setPcaScope(PCA_SCOPE_ALL);
      return;
    }
    if (pcaScope !== PCA_SCOPE_ALL) {
      shelvedPcaScope.current = null; // the user chose something else meanwhile
      return;
    }
    const remembered = shelvedPcaScope.current;
    if (!remembered) return;
    const shelved = parsePcaScope(remembered);
    if (shelved && shelved.cluster < settledTopScenarios) {
      setPcaScope(remembered);
      shelvedPcaScope.current = null;
    }
  }, [pcaScope, settledTopScenarios]);

  const runPca = useCallback(async () => {
    if (!zones) return;
    setPcaBusy(true);
    setPcaError(null);
    try {
      // Let the spinner paint before the synchronous PCA work.
      await new Promise(r => setTimeout(r, 30));
      let pixels = [...zones.interior.features, ...zones.edge.features];
      // Restrict to one growth scenario from step 4 when a scope is chosen.
      const scoped = parsePcaScope(pcaScope);
      if (scoped && clustering) {
        const group = clustering.groups.find(g => g.species === scoped.species);
        const keys = new Set(
          (group?.fields || []).filter(f => f.cluster === scoped.cluster).map(f => f.key)
        );
        pixels = pixels.filter(p => keys.has(fieldKeyOf(p.properties)));
      }
      // Restrict to the fields ticked in the step's field list.
      if (pcaFields !== null) {
        pixels = pixels.filter(p => pcaFields.has(p.properties?.__pid));
      }
      // Growing-season window: the scoped scenario's own window when a scenario
      // is chosen, else the crops' shared overlap.
      let seasonWindow = restrictPcaToSeason ? season?.window ?? null : null;
      if (restrictPcaToSeason && scoped && season?.perCluster) {
        const pc = season.perCluster.find(p => p.species === scoped.species && p.cluster === scoped.cluster);
        if (pc) seasonWindow = pc.window; // may be null → that scenario has no obvious season
      }
      const result = runPixelPca(pixels, zones.metric, {
        fitZones: pcaFitZones,
        projectZones: pcaProjectZones,
        method: pcaMethod,
        dateStart: seasonWindow?.start,
        dateEnd: seasonWindow?.end,
      });
      setPcaResult(result);
      openPcaPanel();
    } catch (e) {
      setPcaResult(null);
      setPcaError(errorMessage(e));
    } finally {
      setPcaBusy(false);
    }
  }, [zones, clustering, pcaScope, pcaFields, pcaFitZones, pcaProjectZones, pcaMethod, restrictPcaToSeason, season, openPcaPanel]);

  // Changing the projected classes from the results panel re-runs the
  // projection live. Refs avoid re-firing when the run itself lands.
  const pcaLive = useRef({ runPca, active: false });
  pcaLive.current = { runPca, active: pcaResult !== null };
  useEffect(() => {
    if (pcaLive.current.active) pcaLive.current.runPca();
  }, [pcaProjectZones, pcaMethod]);

  /** Scatter point picked in the results panel → white ring on the map and
   *  the map flies to the pixel (offset so the drawer doesn't cover it). */
  const pickPcaPixel = useCallback(
    (p: { id: string; zone: PixelZone; lng: number; lat: number } | null) => {
      setHighlightPixel(p ? { id: p.id, zone: p.zone, lng: p.lng, lat: p.lat, values: {} } : null);
      if (p) {
        const d = 0.0008; // ~80 m — lands at field scale around the pixel
        requestFit([p.lng - d, p.lat - d, p.lng + d, p.lat + d], { padRight: pcaPanelWidth, maxZoom: 17 });
      }
    },
    [requestFit, pcaPanelWidth]
  );

  /** Clicking a zone dot on the map → highlight that pixel in the PCA scatter
   *  (no fly-to: the user already sees it on the map). Click again to clear. */
  const pickMapPixel = useCallback((p: { id: string; zone: string; lng: number; lat: number }) => {
    setHighlightPixel(prev =>
      prev?.id === p.id ? null : { id: p.id, zone: p.zone as PixelZone, lng: p.lng, lat: p.lat, values: {} }
    );
  }, []);

  const closePcaPanel = useCallback(() => {
    setShowPcaPanel(false);
    setHighlightPixel(null);
    setPcaBoundaryPixels([]);
    setPcaSelectedPixels([]);
  }, []);

  const exportCsv = useCallback(() => {
    if (!pcaResult) return;
    const blob = new Blob([pcaScoresToCsv(pcaResult)], { type: 'text/csv;charset=utf-8' });
    saveAs(blob, `pca_scores_${pcaResult.metric}_${new Date().toISOString().slice(0, 10)}.csv`);
  }, [pcaResult]);

  const resetAll = useCallback(() => {
    setPolygons(null);
    setSourceLabel('');
    setSelectedIds(new Set());
    setPolygonsError(null);
    clearFromImagery();
    setActiveStep(1);
    cacheClear();
  }, [clearFromImagery]);

  // ----- Workflow definition -------------------------------------------------

  const steps: StepDescriptor[] = [
    {
      id: 1,
      title: 'Polygons',
      summary: polygons
        ? `${polygons.features.length} loaded (${sourceLabel}) · ${selectedIds.size} selected`
        : 'Load from database or file',
      enabled: true,
      done: selectedIds.size > 0,
      onReset: clearPolygons,
      canReset: polygons !== null,
      content: (
        <PolygonsStep
          polygons={polygons}
          sourceLabel={sourceLabel}
          selectedIds={selectedIds}
          busy={polygonsBusy}
          error={polygonsError}
          onLoadFromDb={loadFromDb}
          onMergeFromDb={mergeFromDb}
          onToggleBordering={toggleBordering}
          hiddenBorderingCount={stashedBordering.length}
          onLoadFromFile={loadFromFile}
          onCancel={cancelOp}
          onDatasetRange={onDatasetRange}
          onToggle={togglePolygon}
          onSelectAll={() => setSelectedIds(new Set((polygons?.features || []).map((f: any) => f.properties.__pid)))}
          onClearSelection={clearSelection}
          onZoomTo={f => requestFit(getGeoJsonBounds(f))}
        />
      ),
    },
    {
      id: 2,
      title: 'Sentinel-2 time series',
      summary: scenes.length > 0 ? `${scenes.length} scenes fetched` : 'Fetch imagery over the selection',
      enabled: selectedIds.size > 0,
      done: scenes.length > 0,
      onReset: clearFromImagery,
      canReset: scenes.length > 0,
      content: (
        <ImageryStep
          scenes={scenes}
          selectedCount={selectedIds.size}
          busy={seriesBusy}
          progress={seriesProgress}
          error={seriesError}
          failedDates={failedDates}
          partialDates={partialDates}
          heterogeneous={heterogeneous}
          selectionChanged={selectionChangedSinceFetch}
          onFetch={fetchSeries}
          onCancel={cancelOp}
          datasetRange={datasetRange}
          previewSceneId={previewSceneId}
          onPreviewScene={setPreviewSceneId}
          onDeleteScene={deleteScene}
        />
      ),
    },
    {
      id: 3,
      title: 'Buffer zones',
      summary: zones
        ? `${zones.interior.features.length} interior / ${zones.edge.features.length} edge px · ${zones.distance} m`
        : 'Split pixels by distance to boundary',
      enabled: scenes.length > 0,
      done: zones !== null,
      onReset: clearFromZones,
      canReset: zones !== null,
      content: (
        <ZonesStep
          zones={zones}
          busy={zonesBusy}
          progress={zonesProgress}
          error={zonesError}
          sceneCount={scenes.length}
          selectedCount={selectedIds.size}
          coveredCount={coveredFeatures.length}
          pixelSize={pixelSize}
          stale={zonesStale}
          onRun={runZones}
          onCancel={cancelOp}
        />
      ),
    },
    {
      id: 4,
      title: 'Growth scenarios',
      summary: clustering
        ? `${clustering.groups.length} species · up to ${clustering.k} scenarios each`
        : 'Cluster fields & pick the growing season',
      enabled: zones !== null,
      done: clustering !== null,
      onReset: clearFromClustering,
      canReset: clustering !== null,
      content: (
        <ClusterStep
          zones={zones}
          clustering={clustering}
          busy={clusteringBusy}
          season={season}
          seasonOnly={restrictPcaToSeason}
          onOpen={openClusterPanel}
        />
      ),
    },
    {
      id: 5,
      title: 'PCA',
      summary: pcaResult
        ? `PC1 ${pcaResult.explained[0].toFixed(1)}% · PC2 ${(pcaResult.explained[1] || 0).toFixed(1)}%`
        : 'Principal components of the pixel series',
      enabled: zones !== null,
      done: pcaResult !== null,
      onReset: clearPca,
      canReset: pcaResult !== null,
      content: (
        <PcaStep
          zones={zones}
          clustering={clustering}
          scope={pcaScope}
          onScopeChange={setPcaScope}
          topScenarios={topScenarios}
          fields={pcaFields}
          onFieldsChange={setPcaFields}
          fieldGroups={pcaFieldGroups}
          fitZones={pcaFitZones}
          onFitZonesChange={setPcaFitZones}
          projectZones={pcaProjectZones}
          onProjectZonesChange={setPcaProjectZones}
          result={pcaResult}
          busy={pcaBusy}
          error={pcaError}
          onRun={runPca}
          seasonOnly={restrictPcaToSeason}
          season={season}
          onOpenClusterWindow={openClusterPanel}
          onOpenResults={openPcaPanel}
          onExportCsv={exportCsv}
        />
      ),
    },
    /* Boundary profile (6) and Boundary prediction (7) are hidden for now —
       uncomment to bring the steps back; the components/handlers below are kept.
    {
      id: 6,
      title: 'Boundary profile',
      summary: 'Edge-response curve over distance to the boundary',
      enabled: zones !== null,
      done: false,
      content: <BoundaryStep zones={zones} onOpen={() => setShowBoundaryPanel(true)} />,
    },
    {
      id: 7,
      title: 'Boundary prediction',
      summary: prediction
        ? `gradient AUC ${prediction.metrics.gradient.auc.toFixed(2)}`
        : 'Predict field boundaries from the mixing',
      enabled: scenes.length >= 2,
      done: prediction !== null,
      onReset: clearPrediction,
      canReset: prediction !== null,
      content: (
        <BoundaryPredictStep
          zones={zones}
          sceneCount={scenes.length}
          prediction={prediction}
          busy={predictBusy}
          error={predictError}
          method={predictMethod}
          onMethod={setPredictMethod}
          threshold={predictThreshold}
          onThreshold={setPredictThreshold}
          onRun={runPrediction}
        />
      ),
    },
    */
  ];

  return (
    <div className="flex h-full flex-col bg-[#0b0e11] font-sans text-slate-200">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 bg-[#11151a] px-4">
        <div className="flex items-center gap-2.5">
          <Layers className="h-4.5 w-4.5 text-sky-400" />
          <h1 className="text-sm font-semibold tracking-tight">Polygon Time-Series PCA</h1>
          <span className="text-xs text-slate-600">Sentinel-2 · interior vs edge buffer analysis</span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="./pixel-grid.html"
            className="flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300 transition-colors hover:bg-sky-500/20"
          >
            <Grid3x3 className="h-3 w-3" /> Pixel Grid Designer
          </a>
          <button
            onClick={resetAll}
            className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1 text-xs text-slate-400 transition-colors hover:text-slate-200"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar steps={steps} activeStep={activeStep} onActivate={setActiveStep} />
        <main className="relative min-w-0 flex-1">
          <MapPanel
            polygons={polygons}
            selectedIds={selectedIds}
            onTogglePolygon={togglePolygon}
            onBoxSelect={selectByBox}
            onClearSelection={clearSelection}
            zones={zones}
            clusterAssignment={clusterAssignment}
            clusterVersion={(clustering?.createdAt ?? 0) + settledTopScenarios}
            preview={preview}
            clusterGrids={clusterGrids}
            boundaryPixels={pcaBoundaryPixels}
            selectedPixels={pcaSelectedPixels}
            predictionOverlays={predictionOverlays}
            scenes={scenes}
            previewSceneId={previewSceneId}
            onPreviewScene={setPreviewSceneId}
            onDeleteScene={deleteScene}
            onInspectPolygon={inspectNdvi}
            inspectPixels={ndviInspection?.pixels ?? null}
            highlightPixel={highlightPixel}
            onPickPixel={pickPixel}
            pcaPickMode={showPcaPanel && pcaResult !== null}
            onPickMapPixel={pickMapPixel}
            fitRequest={fitRequest}
          />
          <NdviPanel
            inspection={ndviInspection}
            busy={ndviBusy}
            error={ndviError}
            onClose={closeNdvi}
            onSelectDate={previewDate}
            highlightPixel={highlightPixel}
            onHighlightPixel={setHighlightPixel}
            seasonWindow={restrictPcaToSeason ? season?.window ?? null : null}
            seasonOn={restrictPcaToSeason}
            onToggleSeason={toggleSeasonOnly}
            seasonBusy={seasonBusy}
            seasonError={seasonError}
          />
          {showClusterPanel && (
            <ClusterSeasonPanel
              width={clusterPanelWidth}
              onWidthChange={onClusterPanelWidth}
              onClose={closeClusterPanel}
              zones={zones}
              clustering={clustering}
              // An insert re-clusters underneath; re-clustering on top of that
              // would race the rebuild.
              busy={clusteringBusy || seriesBusy}
              error={clusteringError}
              onRun={runClustering}
              topScenarios={topScenarios}
              onTopScenariosChange={setTopScenarios}
              periods={seasonPicks}
              onPeriodChange={setSeasonPick}
              excludedDays={excludedDays}
              onToggleExcluded={toggleExcluded}
              canAddScenes={selectedFeatures.length > 0 && zones !== null}
              onFindScenes={findSceneCandidates}
              onCheckClarity={checkSceneClarity}
              onInsertScenes={insertScenes}
              onStopInsert={cancelOp}
              seriesBusy={seriesBusy}
              seriesProgress={seriesProgress}
              seriesError={seriesError}
            />
          )}
          {showPcaPanel && pcaResult && (
            <PcaPanel
              result={pcaResult}
              busy={pcaBusy}
              width={pcaPanelWidth}
              onWidthChange={onPcaPanelWidth}
              clusterAssignment={clusterAssignment}
              projectZones={pcaProjectZones}
              onProjectZonesChange={setPcaProjectZones}
              method={pcaMethod}
              onMethodChange={setPcaMethod}
              highlightPixelId={highlightPixel?.id ?? null}
              onPickPixel={pickPcaPixel}
              onBoundaryPixels={setPcaBoundaryPixels}
              onSelectPixels={setPcaSelectedPixels}
              onClose={closePcaPanel}
              onExportCsv={exportCsv}
            />
          )}
          {showBoundaryPanel && zones && (
            <BoundaryProfilePanel
              zones={zones}
              onClose={() => setShowBoundaryPanel(false)}
              onFocusField={focusField}
            />
          )}
        </main>
      </div>
    </div>
  );
}
