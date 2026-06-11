import React, { useCallback, useMemo, useState } from 'react';
import { saveAs } from 'file-saver';
import { Layers, RotateCcw } from 'lucide-react';
import { RasterLayer } from './types';
import { Bbox, getGeoJsonBounds, bufferBboxMeters } from './lib/geo';
import {
  loadPolygonsFromDatabase,
  loadPolygonsFromFile,
} from './lib/polygon-source';
import { fetchSentinelSeries, SeriesFetchParams, SeriesProgress } from './lib/fetch-series';
import { extractZones, ZoneExtraction, ZoneProgress } from './lib/zones';
import { runPixelPca, pcaScoresToCsv, PcaRunResult } from './lib/pca';
import MapPanel, { ScenePreview } from './components/MapPanel';
import Sidebar, { StepDescriptor } from './components/Sidebar';
import PolygonsStep from './components/steps/PolygonsStep';
import ImageryStep from './components/steps/ImageryStep';
import ZonesStep from './components/steps/ZonesStep';
import PcaStep from './components/steps/PcaStep';
import PcaPanel from './components/PcaPanel';

/**
 * Polygon Time-Series PCA.
 *
 * One linear workflow: load polygons (database or file) → select them on the
 * map → fetch a Sentinel-2 time series over the selection → split each
 * polygon's pixels into interior / edge zones by distance to the boundary →
 * run a PCA on the pixel time series.
 */

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
  const [seriesBusy, setSeriesBusy] = useState(false);
  const [seriesProgress, setSeriesProgress] = useState<SeriesProgress | null>(null);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [previewSceneId, setPreviewSceneId] = useState<string | null>(null);

  // Step 3 — buffer zones
  const [zones, setZones] = useState<ZoneExtraction | null>(null);
  const [zonesBusy, setZonesBusy] = useState(false);
  const [zonesProgress, setZonesProgress] = useState<ZoneProgress | null>(null);
  const [zonesError, setZonesError] = useState<string | null>(null);

  // Step 4 — PCA
  const [pcaResult, setPcaResult] = useState<PcaRunResult | null>(null);
  const [pcaBusy, setPcaBusy] = useState(false);
  const [pcaError, setPcaError] = useState<string | null>(null);
  const [showPcaPanel, setShowPcaPanel] = useState(false);

  const [activeStep, setActiveStep] = useState(1);
  const [fitRequest, setFitRequest] = useState<{ bounds: Bbox; token: number } | null>(null);

  const requestFit = useCallback((bounds: Bbox | null) => {
    if (bounds) setFitRequest({ bounds, token: Date.now() });
  }, []);

  const clearFromZones = useCallback(() => {
    setZones(null);
    setZonesError(null);
    setPcaResult(null);
    setPcaError(null);
    setShowPcaPanel(false);
  }, []);

  const clearFromImagery = useCallback(() => {
    setScenes([]);
    setFailedDates([]);
    setPartialDates(0);
    setSeriesError(null);
    setPreviewSceneId(null);
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
      setPolygonsBusy(true);
      setPolygonsError(null);
      try {
        const result = await loadPolygonsFromDatabase(url, sql);
        onPolygonsLoaded(result, 'database');
      } catch (e) {
        setPolygonsError(errorMessage(e));
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

  const togglePolygon = useCallback(
    (pid: number) => {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(pid)) next.delete(pid);
        else next.add(pid);
        return next;
      });
      clearFromZones();
    },
    [clearFromZones]
  );

  const selectedFeatures = useMemo(
    () => (polygons?.features || []).filter((f: any) => selectedIds.has(f.properties.__pid)),
    [polygons, selectedIds]
  );

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

      setSeriesBusy(true);
      setSeriesError(null);
      setSeriesProgress(null);
      clearFromZones();
      try {
        const result = await fetchSentinelSeries(bbox, params, setSeriesProgress);
        setScenes(result.layers);
        setFailedDates(result.failedDates);
        setPartialDates(result.partialDates);
        setPreviewSceneId(result.layers[result.layers.length - 1]?.id ?? null);
        requestFit(bbox);
      } catch (e) {
        setScenes([]);
        setSeriesError(errorMessage(e));
      } finally {
        setSeriesBusy(false);
        setSeriesProgress(null);
      }
    },
    [selectedFeatures, clearFromZones, requestFit]
  );

  const preview = useMemo<ScenePreview | null>(() => {
    if (!previewSceneId) return null;
    const scene = scenes.find(s => s.id === previewSceneId);
    if (!scene?.dataUrl) return null;
    return { url: scene.dataUrl, bounds: scene.data.bounds, opacity: 0.85 };
  }, [previewSceneId, scenes]);

  // ----- Step 3 handlers -----------------------------------------------------

  const runZones = useCallback(
    async (distance: number, metric: string, includeOutside: boolean) => {
      setZonesBusy(true);
      setZonesError(null);
      setPcaResult(null);
      setShowPcaPanel(false);
      try {
        const result = await extractZones(selectedFeatures, scenes, distance, metric, includeOutside, setZonesProgress);
        setZones(result);
      } catch (e) {
        setZones(null);
        setZonesError(errorMessage(e));
      } finally {
        setZonesBusy(false);
        setZonesProgress(null);
      }
    },
    [selectedFeatures, scenes]
  );

  // ----- Step 4 handlers -----------------------------------------------------

  const runPca = useCallback(async () => {
    if (!zones) return;
    setPcaBusy(true);
    setPcaError(null);
    try {
      // Let the spinner paint before the synchronous PCA work.
      await new Promise(r => setTimeout(r, 30));
      const pixels = [...zones.interior.features, ...zones.edge.features];
      const result = runPixelPca(pixels, zones.metric);
      setPcaResult(result);
      setShowPcaPanel(true);
    } catch (e) {
      setPcaResult(null);
      setPcaError(errorMessage(e));
    } finally {
      setPcaBusy(false);
    }
  }, [zones]);

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
          onToggle={togglePolygon}
          onSelectAll={() => {
            setSelectedIds(new Set((polygons?.features || []).map((f: any) => f.properties.__pid)));
            clearFromZones();
          }}
          onClearSelection={() => {
            setSelectedIds(new Set());
            clearFromZones();
          }}
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
          onFetch={fetchSeries}
          previewSceneId={previewSceneId}
          onPreviewScene={setPreviewSceneId}
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
          onRun={runZones}
        />
      ),
    },
    {
      id: 4,
      title: 'PCA',
      summary: pcaResult
        ? `PC1 ${pcaResult.explained[0].toFixed(1)}% · PC2 ${(pcaResult.explained[1] || 0).toFixed(1)}%`
        : 'Principal components of the pixel series',
      enabled: zones !== null,
      done: pcaResult !== null,
      content: (
        <PcaStep
          zones={zones}
          result={pcaResult}
          busy={pcaBusy}
          error={pcaError}
          onRun={runPca}
          onOpenResults={() => setShowPcaPanel(true)}
          onExportCsv={exportCsv}
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
            zones={zones}
            preview={preview}
            scenes={scenes}
            previewSceneId={previewSceneId}
            onPreviewScene={setPreviewSceneId}
            fitRequest={fitRequest}
          />
          {showPcaPanel && pcaResult && (
            <PcaPanel result={pcaResult} onClose={() => setShowPcaPanel(false)} onExportCsv={exportCsv} />
          )}
        </main>
      </div>
    </div>
  );
}
