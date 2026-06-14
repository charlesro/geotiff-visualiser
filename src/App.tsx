import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { Layers, RotateCcw } from 'lucide-react';
import { RasterLayer } from './types';
import { Bbox, getGeoJsonBounds, bufferBboxMeters, getBboxIntersectionArea } from './lib/geo';
import {
  loadPolygonsFromDatabase,
  loadPolygonsFromFile,
  polygonLabel,
} from './lib/polygon-source';
import { summarizeExtraction, NdviInspection, NdviPixel } from './lib/ndvi-series';
import NdviPanel from './components/NdviPanel';
import { fetchSentinelSeries, SeriesFetchParams, SeriesProgress } from './lib/fetch-series';
import { clusterFeatureBboxes } from './lib/cluster';
import { renderAnalysisGridPreview } from './lib/mosaic';
import { DEFAULT_OPTIONS } from './lib/layer-factory';
import { extractZones, featureKey, PixelZone, ZoneExtraction, ZoneProgress } from './lib/zones';
import { computeUnmixing } from './lib/unmix';
import { clusterBySpecies, SpeciesClustering, fieldKeyOf } from './lib/species-clusters';
import { runPixelPca, pcaScoresToCsv, PcaRunResult } from './lib/pca';
import { isCancelledError } from './lib/cancel';
import { DatasetDateRange } from './lib/neighbor-query';
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

export default function App() {
  // Step 1 — polygons & selection
  const [polygons, setPolygons] = useState<any | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [polygonsBusy, setPolygonsBusy] = useState(false);
  const [polygonsError, setPolygonsError] = useState<string | null>(null);

  // Step 2 — imagery
  const [scenes, setScenes] = useState<RasterLayer[]>([]);
  const [failedDates, setFailedDates] = useState<string[]>([]);
  const [partialDates, setPartialDates] = useState(0);
  /** Selection the series was fetched for — the 10 m windows cover only it. */
  const [fetchedSelectionKey, setFetchedSelectionKey] = useState<string | null>(null);
  const [seriesBusy, setSeriesBusy] = useState(false);
  const [seriesProgress, setSeriesProgress] = useState<SeriesProgress | null>(null);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [previewSceneId, setPreviewSceneId] = useState<string | null>(null);
  /** Rendered 10 m overlays of the analysis windows, cached per scene id. */
  const clusterPreviewCache = useRef(new Map<string, ScenePreview[]>());

  // Step 3 — buffer zones
  const [zones, setZones] = useState<ZoneExtraction | null>(null);
  const [zonesBusy, setZonesBusy] = useState(false);
  const [zonesProgress, setZonesProgress] = useState<ZoneProgress | null>(null);
  const [zonesError, setZonesError] = useState<string | null>(null);
  /** Selection the zones were extracted from — to flag (not wipe) staleness. */
  const [zonesSelectionKey, setZonesSelectionKey] = useState<string | null>(null);

  // Step 4 — species clustering (growth scenarios)
  const [clustering, setClustering] = useState<SpeciesClustering | null>(null);
  const [clusteringBusy, setClusteringBusy] = useState(false);
  const [clusteringError, setClusteringError] = useState<string | null>(null);

  // Step 5 — PCA
  const [pcaScope, setPcaScope] = useState<string>(PCA_SCOPE_ALL);
  /** Subset of extracted fields (pids) the PCA runs on; null = all. */
  const [pcaFields, setPcaFields] = useState<Set<number> | null>(null);
  // Default: fit the axes on the pure interior pixels, and display the
  // interior vs the edge facing another species (the comparison of interest).
  const [pcaFitZones, setPcaFitZones] = useState<PixelZone[]>(PCA_DEFAULT_FIT);
  const [pcaProjectZones, setPcaProjectZones] = useState<PixelZone[]>(PCA_DEFAULT_PROJECT);
  const [pcaResult, setPcaResult] = useState<PcaRunResult | null>(null);
  const [pcaBusy, setPcaBusy] = useState(false);
  const [pcaError, setPcaError] = useState<string | null>(null);
  const [showPcaPanel, setShowPcaPanel] = useState(false);
  const [showBoundaryPanel, setShowBoundaryPanel] = useState(false);

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
        const series = await cacheGet<any>('series');
        if (series?.scenes?.length) {
          const revived = reviveScenes(series.scenes);
          persistedScenesRef.current = revived;
          setScenes(prev => (prev.length > 0 ? prev : revived));
          setFailedDates(prev => (prev.length > 0 ? prev : series.failedDates || []));
          setPartialDates(prev => prev || series.partialDates || 0);
          setFetchedSelectionKey(prev => prev ?? series.fetchedSelectionKey ?? null);
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
        fetchedSelectionKey,
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [scenes, failedDates, partialDates, fetchedSelectionKey]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    cacheSet('preview', previewSceneId);
  }, [previewSceneId]);

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

  const clearFromClustering = useCallback(() => {
    setClustering(null);
    setClusteringError(null);
    setPcaScope(PCA_SCOPE_ALL);
    setPcaFields(null);
    setPcaFitZones(PCA_DEFAULT_FIT);
    setPcaProjectZones(PCA_DEFAULT_PROJECT);
    setPcaResult(null);
    setPcaError(null);
    setShowPcaPanel(false);
  }, []);

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
    setFetchedSelectionKey(null);
    setSeriesError(null);
    setPreviewSceneId(null);
    clusterPreviewCache.current.clear();
    setPrediction(null);
    setPredictError(null);
    clearFromZones();
  }, [clearFromZones]);

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
    async (url: string, sql: string) => {
      const op = beginOp();
      setPolygonsBusy(true);
      setPolygonsError(null);
      try {
        const result = await loadPolygonsFromDatabase(url, sql, op.abort.signal);
        onPolygonsLoaded(result, 'database');
      } catch (e) {
        if (!isCancelledError(e)) setPolygonsError(errorMessage(e));
      } finally {
        setPolygonsBusy(false);
      }
    },
    [onPolygonsLoaded]
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

  const fetchSeries = useCallback(
    async (params: SeriesFetchParams) => {
      const bounds = getGeoJsonBounds({ type: 'FeatureCollection', features: selectedFeatures });
      if (!bounds) {
        setSeriesError('Select at least one polygon first.');
        return;
      }
      // Margin so edge pixels just outside the polygons are covered too.
      const bbox = bufferBboxMeters(bounds, 120);

      const op = beginOp();
      setSeriesBusy(true);
      setSeriesError(null);
      setSeriesProgress(null);
      clearFromZones();
      try {
        // One padded bbox per polygon cluster — fetched at native 10 m for
        // the analysis even when the preview mosaic is downsampled.
        const clusters = clusterFeatureBboxes(selectedFeatures);
        const result = await fetchSentinelSeries(bbox, params, setSeriesProgress, () => op.cancelled, clusters);
        setScenes(result.layers);
        setFailedDates(result.failedDates);
        setPartialDates(result.partialDates);
        setFetchedSelectionKey(Array.from(selectedIds).sort((a, b) => a - b).join('.'));
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
    [selectedFeatures, selectedIds, clearFromZones, requestFit]
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
      clusterPreviewCache.current.delete(id);
      // Zones and PCA were computed from the full series — invalidate them.
      clearFromZones();
    },
    [scenes, clearFromZones]
  );

  /** True when polygons were (de)selected after the series was fetched. */
  const selectionChangedSinceFetch = useMemo(() => {
    if (scenes.length === 0 || fetchedSelectionKey === null) return false;
    return Array.from(selectedIds).sort((a, b) => a - b).join('.') !== fetchedSelectionKey;
  }, [scenes, fetchedSelectionKey, selectedIds]);

  /** Zones were extracted from a different selection than is now active. */
  const zonesStale = useMemo(() => {
    if (!zones || zonesSelectionKey === null) return false;
    return Array.from(selectedIds).sort((a, b) => a - b).join('.') !== zonesSelectionKey;
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

  // 10 m overlays for the previewed scene: the analysis windows already hold
  // the native-resolution pixels, so they are rendered lazily (cached per
  // scene) and drawn on top of the coarse preview mosaic.
  const clusterPreviews = useMemo<ScenePreview[]>(() => {
    if (!previewSceneId) return [];
    const scene = scenes.find(s => s.id === previewSceneId);
    if (!scene?.analysisGrids?.length) return [];
    const cached = clusterPreviewCache.current.get(scene.id);
    if (cached) return cached;
    const rendered = scene.analysisGrids.map(grid => {
      const { url, corners } = renderAnalysisGridPreview(grid, DEFAULT_OPTIONS);
      return { url, corners, bounds: grid.bounds, opacity: 0.95 };
    });
    clusterPreviewCache.current.set(scene.id, rendered);
    return rendered;
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
        setZonesSelectionKey(allCovered ? null : Array.from(selectedIds).sort((a, b) => a - b).join('.'));
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
        setPcaScope(PCA_SCOPE_ALL);
      } catch (e) {
        setClustering(null);
        setClusteringError(errorMessage(e));
      } finally {
        setClusteringBusy(false);
      }
    },
    [zones]
  );

  /**
   * Extracted fields grouped by neighbour pair for the PCA field list. Pair
   * membership is resolved by field identity (NewID), so a field belonging
   * to several pairs appears under each of them (the pairs query loads one
   * row per field per pair, but the extraction keeps each field once).
   * Pairs and fields are ordered by pixel count, largest first.
   */
  const pcaFieldGroups = useMemo(() => {
    const per = zones?.perPolygon || [];
    const byKey = new Map(per.map(p => [p.key, p]));
    const px = (p: { interior: number; edge: number }) => p.interior + p.edge;

    const pairs = new Map<string, Map<number, (typeof per)[number]>>();
    const inPair = new Set<string>();
    for (const f of polygons?.features || []) {
      const pairId = f.properties?.pair_id;
      if (pairId == null) continue;
      const entry = byKey.get(featureKey(f));
      if (!entry) continue; // field not part of the extraction
      const group = pairs.get(String(pairId)) ?? new Map();
      group.set(entry.pid, entry);
      pairs.set(String(pairId), group);
      inPair.add(entry.key);
    }

    const groups = Array.from(pairs.entries()).map(([pair, members]) => {
      const items = Array.from(members.values()).sort((a, b) => px(b) - px(a));
      return { pair, items, px: items.reduce((s, p) => s + px(p), 0) };
    });
    groups.sort((a, b) => b.px - a.px);
    const solo = per.filter(p => !inPair.has(p.key)).sort((a, b) => px(b) - px(a));
    return { groups, solo };
  }, [zones, polygons]);

  /** Field key → scenario index, for the map coloring. */
  const clusterAssignment = useMemo(() => {
    if (!clustering) return null;
    const m = new Map<string, number>();
    for (const group of clustering.groups) {
      for (const f of group.fields) m.set(f.key, f.cluster);
    }
    return m;
  }, [clustering]);

  // ----- Step 5 handlers -----------------------------------------------------

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
      const result = runPixelPca(pixels, zones.metric, {
        fitZones: pcaFitZones,
        projectZones: pcaProjectZones,
      });
      setPcaResult(result);
      setShowPcaPanel(true);
    } catch (e) {
      setPcaResult(null);
      setPcaError(errorMessage(e));
    } finally {
      setPcaBusy(false);
    }
  }, [zones, clustering, pcaScope, pcaFields, pcaFitZones, pcaProjectZones]);

  // Changing the projected classes from the results panel re-runs the
  // projection live. Refs avoid re-firing when the run itself lands.
  const pcaLive = useRef({ runPca, active: false });
  pcaLive.current = { runPca, active: pcaResult !== null };
  useEffect(() => {
    if (pcaLive.current.active) pcaLive.current.runPca();
  }, [pcaProjectZones]);

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
      content: (
        <PolygonsStep
          polygons={polygons}
          sourceLabel={sourceLabel}
          selectedIds={selectedIds}
          busy={polygonsBusy}
          error={polygonsError}
          onLoadFromDb={loadFromDb}
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
      content: (
        <ImageryStep
          scenes={scenes}
          selectedCount={selectedIds.size}
          busy={seriesBusy}
          progress={seriesProgress}
          error={seriesError}
          failedDates={failedDates}
          partialDates={partialDates}
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
      title: 'Species clustering',
      summary: clustering
        ? `${clustering.groups.length} species · up to ${clustering.k} scenarios each`
        : 'Isolate growth scenarios within each species',
      enabled: zones !== null,
      done: clustering !== null,
      content: (
        <ClusterStep
          zones={zones}
          clustering={clustering}
          busy={clusteringBusy}
          error={clusteringError}
          onRun={runClustering}
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
      content: (
        <PcaStep
          zones={zones}
          clustering={clustering}
          scope={pcaScope}
          onScopeChange={setPcaScope}
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
          onOpenResults={() => setShowPcaPanel(true)}
          onExportCsv={exportCsv}
        />
      ),
    },
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
  ];

  return (
    <div className="flex h-full flex-col bg-[#0b0e11] font-sans text-slate-200">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 bg-[#11151a] px-4">
        <div className="flex items-center gap-2.5">
          <Layers className="h-4.5 w-4.5 text-sky-400" />
          <h1 className="text-sm font-semibold tracking-tight">Polygon Time-Series PCA</h1>
          <span className="text-xs text-slate-600">Sentinel-2 · interior vs edge buffer analysis</span>
        </div>
        <button
          onClick={resetAll}
          className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1 text-xs text-slate-400 transition-colors hover:text-slate-200"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </button>
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
            clusterVersion={clustering?.createdAt ?? 0}
            preview={preview}
            clusterPreviews={clusterPreviews}
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
          />
          {showPcaPanel && pcaResult && (
            <PcaPanel
              result={pcaResult}
              busy={pcaBusy}
              width={pcaPanelWidth}
              onWidthChange={onPcaPanelWidth}
              clusterAssignment={clusterAssignment}
              projectZones={pcaProjectZones}
              onProjectZonesChange={setPcaProjectZones}
              highlightPixelId={highlightPixel?.id ?? null}
              onPickPixel={pickPcaPixel}
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
