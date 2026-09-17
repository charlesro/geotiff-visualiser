import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { Layers } from 'lucide-react';
import { BASEMAPS, type BasemapKey } from './map-layers';
import { inRange, isBool, isLngLat, oneOf, readSaved, resetSavedState, usePersistentState, writeSaved } from './persist';
import { useAoiField, usePlaceSearch } from './use-area';
import { useFieldGrid } from './use-grid';
import { useExperiment, usePcaSim, useSimulation } from './use-simulation';
import { aoiUtmOrigin } from './s2-grid';
import { readDesignFiles } from './design-import';
import { convexHull } from './imported-plan';
import { polyBbox } from './geometry';
import { isAligned, nearestTurn, rotateImportedPlan, stakeOnGrid } from './imported-rotate';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import type { ColorBy, ShapeBy } from './pca-field';
import { FieldMap } from './FieldMap';
import { AreaStep } from './steps/AreaStep';
import { GridStep } from './steps/GridStep';
import { SimStep } from './steps/SimStep';
import { PcaStep } from './steps/PcaStep';

/**
 * The Pixel Grid Designer.
 *
 * An agronomist draws a field, sees exactly where a chosen satellite's pixels
 * fall on it, exports those squares as a shapefile to plant against, and
 * simulates whether that sensor could tell two intercropped crops apart.
 *
 * This file is deliberately only wiring. The four hooks below are the data
 * layer, in dependency order — area feeds grid feeds experiment feeds
 * simulation feeds PCA — and everything visible lives in FieldMap and the four
 * step panels. The two things that genuinely belong at this level are:
 *
 *  - `geoKey`, a hand-rolled cache key whose thirteen segments are only all in
 *    scope here. react-leaflet will not restyle a <GeoJSON> when its props
 *    change, so remounting on a changed key is the ONLY thing that repaints the
 *    map overlay. Drop a segment and you get a stale map with no error anywhere.
 *  - `activeStep`, because three hooks gate expensive work on it and the
 *    stepper unmounts closed panels.
 */

/**
 * Built on its own for the public site (see vite-env.d.ts). There is no PCA app
 * published alongside it, so the links back to it are not rendered.
 */
const STANDALONE = import.meta.env.VITE_STANDALONE === '1';

export default function PixelGridApp() {
  const mapRef = useRef<L.Map | null>(null);

  // Collapsible steps (one open at a time, PCA-style; click an open one to close it)
  const [activeStep, setActiveStep] = usePersistentState<'area' | 'grid' | 'sim' | 'pca' | null>('activeStep', 'grid',
    v => v === null || oneOf('area', 'grid', 'sim', 'pca')(v));
  const toggleStep = (s: 'area' | 'grid' | 'sim' | 'pca') => setActiveStep(cur => (cur === s ? null : s));
  const simOn = activeStep === 'sim' || activeStep === 'pca';

  // Step 1 — the field. `setActiveStep` is passed straight through (never wrapped
  // in an arrow): the drawers reset in-progress geometry when `onDone`'s identity
  // changes, so a fresh one mid-trace would erase the user's vertices.
  const area = useAoiField(setActiveStep);
  const { aoi, aoiPoly, fieldRing, initialCenter } = area;

  // Step 2 — the satellite and its pixel lattice. Everything downstream hangs off
  // `build`; sigmaX/sigmaY are owned here (the PSF is a property of the chosen
  // sensor) and handed to the simulation hooks as plain scalars.
  // The FIELD is the traced shape, or else the drawn box itself. The hooks take
  // it under their old name `aoiPoly`: a box used to pass null there, so its
  // export, pixel count, map overlay and PCA all kept the edge pixels the grid
  // overhangs by, while "In field only" hid them. `aoiPoly` itself still means
  // "was a shape traced", which only the wording (field vs drawn) cares about.
  const gridApi = useFieldGrid({ aoi, aoiPoly: fieldRing });
  const { sigmaX, sigmaY, psfOffX, psfOffY, renderGrid, fieldAreaM2, gridSummary } = gridApi;
  const [basemap, setBasemap] = usePersistentState<BasemapKey>('basemap', 'satellite', v => typeof v === 'string' && v in BASEMAPS);
  const [showField, setShowField] = usePersistentState('showField', false, isBool);   // render the true planting pattern under the grid
  const [showPsf, setShowPsf] = usePersistentState('showPsf', false, isBool);        // draw the sensor PSF footprint on the map
  const [fieldOnly, setFieldOnly] = usePersistentState('fieldOnly', false, isBool);  // trim the grid to the traced field

  // Disclosure / tab state for the step panels. It lives up here because `Step`
  // unmounts a collapsed panel, which would otherwise reset it every time the
  // user folds a step away.
  const [simAdvOpen, setSimAdvOpen] = usePersistentState('simAdvOpen', false, isBool);
  const [pcaRetuneOpen, setPcaRetuneOpen] = usePersistentState('pcaRetuneOpen', false, isBool);
  const [compareAligned, setCompareAligned] = usePersistentState('compareAligned', false, isBool);  // rotated vs 0° ladders
  // PCA point encodings: shared by the big scatter and the ladder thumbnails.
  const [pcaColorBy, setPcaColorBy] = usePersistentState<ColorBy>('pcaColorBy', 'mixing', oneOf('mixing', 'species', 'purity'));
  const [pcaShapeBy, setPcaShapeBy] = usePersistentState<ShapeBy>('pcaShapeBy', 'species', oneOf('species', 'purity', 'none'));
  const [panelW, setPanelW] = useState(() => {          // drag the panel's left edge to widen it
    const saved = readSaved<number>('panelW', inRange(320, 1400));
    if (saved !== undefined) return saved;
    // The pre-persist.ts key, read raw. In a private window or with storage full
    // this access throws, and it used to do so from inside a pointer handler and
    // a state initialiser, where every other saved value fails softly.
    try {
      const v = Number(localStorage.getItem('pgrid_panel_w'));
      return v >= 320 && v <= 1400 ? v : 380;
    } catch { return 380; }
  });

  // Steps 3 & 4 — the planting design, the sensor's view of it, and the PCA.
  // Order matters: the PCA reuses `patternOrigin` from the simulation rather than
  // recomputing it, so the drawn pattern and the simulated one can never drift.
  // A block design is a finite trial: it is anchored on the field and snapped to
  // the pixel lattice. The corner it is anchored on is computed ONCE, here, and
  // given to both hooks: the experiment resolves the plan against it and the
  // simulation measures its (u,v) from it, so the drawn trial and the simulated
  // one cannot describe different ground.
  const fieldOrigin = useMemo((): [number, number] | null =>
    (aoi && gridApi.build?.epsg ? aoiUtmOrigin(aoi, gridApi.build.epsg) : null),
    [aoi, gridApi.build?.epsg]);
  const exp = useExperiment({
    sigmaX, sigmaY, psfOffX, psfOffY,
    fieldBounds: gridApi.build?.utmBounds ?? null, fieldOrigin, pixelSize: gridApi.build?.res ?? 10,
    epsg: gridApi.build?.epsg ?? null,
  });

  /**
   * Importing a trial file. The busy flag and the error live here, in the shell,
   * because step 3 unmounts when collapsed and a read can outlast that.
   */
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [curvesOpen, setCurvesOpen] = usePersistentState('curvesOpen', false, isBool);
  const { setImportedDesign, setImportedCurves, setPattern, setImportedTurn, setImportedShift } = exp;
  const { setAoi, setAoiPoly } = area;
  const onImportFiles = useCallback(async (files: File[]) => {
    setImportBusy(true);
    setImportError(null);
    try {
      const data = await Promise.all(files.map(async f => ({ name: f.name, data: await f.arrayBuffer() })));
      const design = await readDesignFiles(data);
      // The field becomes the trial's own outline, so the pixel count, the
      // purity, the PCA and the export all describe the trial's pixels.
      const hull = convexHull(design.plots.flatMap(p => p.rings.flat()));
      if (hull.length < 3) throw new Error('The plots in this file do not enclose any area.');
      setImportedDesign(design);
      setImportedCurves({});
      setImportedTurn(0);
      setImportedShift([0, 0]);
      setPattern('imported');
      setAoiPoly(hull);
      const box = polyBbox(hull);
      setAoi(box);
      mapRef.current?.fitBounds([[box[1], box[0]], [box[3], box[2]]], { padding: [40, 40], maxZoom: 19 });
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportBusy(false);
    }
  }, [setImportedDesign, setImportedCurves, setImportedTurn, setImportedShift, setPattern, setAoi, setAoiPoly]);
  const importApi = {
    busy: importBusy,
    // A read failure first; otherwise what stops the loaded design from simulating.
    error: importError ?? exp.importedError ?? null,
    onFiles: onImportFiles,
    onRemove: () => { setImportedDesign(null); setImportedCurves({}); setImportedTurn(0); setImportedShift([0, 0]); setImportError(null); setPattern('block'); },
    /**
     * Turn the trial to `deg` degrees from the pixel rows. The field follows it:
     * the field is the trial's outline, and left behind it would cut the turned
     * corners out of the pixel count, the purity and the export.
     */
    setAngle: (deg: number) => {
      // The smallest turn to that angle: 0 and 90 degrees are the same to square pixels.
      const turn = nearestTurn(exp.importedFileAngle, deg);
      setImportedTurn(turn);
      const base = exp.importedBasePlan, build = gridApi.build;
      if (!base || !build?.epsg) { setImportedShift([0, 0]); return; }
      let plan = rotateImportedPlan(base, turn);
      /**
       * Turned along the pixel rows, it is also STAKED on them: the best
       * sub-pixel position of the whole trial at this pixel size. Decided here,
       * on the click, and saved, so the trial cannot move under the field
       * outline set from it, nor slide again at the next resolution.
       */
      let shift: [number, number] = [0, 0];
      if (isAligned(exp.importedFileAngle + turn)) {
        const sensor = { sigmaX, sigmaY, mixThreshold: exp.threshold / 100, offX: psfOffX, offY: psfOffY };
        const staked = stakeOnGrid(plan, build.res, sensor, build.utmBounds);
        shift = staked.shift;
        plan = staked.plan;
      }
      setImportedShift(shift);
      const toLngLat = proj4(crsToProj4Def(`EPSG:${build.epsg}`), 'EPSG:4326');
      const ring = plan.footprint.map(p => toLngLat.forward(p) as [number, number]);
      if (ring.length < 3) return;
      setAoiPoly(ring);
      setAoi(polyBbox(ring));
    },
    setVarietyColumn: (c: string) => setImportedDesign(d => (d ? { ...d, varietyColumn: c } : d)),
    setNameColumn: (c: string) => setImportedDesign(d => (d ? { ...d, nameColumn: c } : d)),
  };
  // Only what `geoKey` needs; the panels read the rest straight off `exp`.
  const { optimizePlacement, day, simView, layoutSig, sensorSig, cropSig } = exp;

  const simApi = useSimulation({ aoi, aoiPoly: fieldRing, gridApi, exp, simOn, fieldOrigin });
  const { patternOrigin, simSummary } = simApi;

  // mapSim: when the PCA runs on the grid the map already simulated, it reuses that result.
  const pcaApi = usePcaSim({ aoi, aoiPoly: fieldRing, gridApi, exp, patternOrigin, activeStep, compareAligned, mapSim: simApi.sim });

  // `layoutSig` stands in for the four layout segments this used to splice in
  // (pattern, width, spacing, rotation). Those move for none of a block
  // design's parameters, so a changed seed or plot size left the previous trial
  // on the map: react-leaflet only repaints when this key changes.
  const geoKey = renderGrid
    ? `${renderGrid.epsg}-${renderGrid.res}-${renderGrid.utmBounds.join(',')}-${basemap}-${simOn ? simView : 'off'}-${simOn && simView === 'ndvi' ? day : ''}-${layoutSig}-${optimizePlacement ? 'opt' : 'raw'}-${sensorSig}-${cropSig}`
    : 'none';

  // The map reopens exactly where it was left; failing that, on the field.
  const initialView = useMemo(() => {
    const saved = readSaved<{ center: [number, number]; zoom: number }>('view',
      v => !!v && typeof v === 'object' && isLngLat((v as { center?: unknown }).center) && inRange(1, 23)((v as { zoom?: unknown }).zoom));
    return saved ?? { center: initialCenter, zoom: 16 };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const saveView = useCallback((center: [number, number], zoom: number) => writeSaved('view', { center, zoom }), []);

  // Reset asks once more before wiping: it discards the drawn field and every
  // setting, so a single stray click should not be enough.
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const id = setTimeout(() => setConfirmReset(false), 3000);
    return () => clearTimeout(id);
  }, [confirmReset]);

  const flyTo = (lat: number, lon: number, bbox?: [number, number, number, number]) => {
    const map = mapRef.current;
    if (!map) return;
    if (bbox) map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { maxZoom: 17 });
    else map.setView([lat, lon], 16);
  };

  const search = usePlaceSearch(flyTo);

  // Collapsed-step summaries
  const areaSummary = aoi ? `≈ ${fieldAreaM2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m² ${aoiPoly ? 'field' : 'drawn'}` : 'search or draw a field';
  // Drag the panel's left edge to resize it (the map takes the rest).
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) =>
      setPanelW(Math.max(320, Math.min(window.innerWidth - 280, Math.round(window.innerWidth - ev.clientX))));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setPanelW(w => { writeSaved('panelW', w); return w; });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const stepProps = { activeStep, toggleStep, area, search, gridApi, exp, sim: simApi, pca: pcaApi,
                      areaSummary, gridSummary, simSummary, geoKey, showPsf, setShowPsf,
                      simAdvOpen, setSimAdvOpen, pcaRetuneOpen, setPcaRetuneOpen,
                      compareAligned, setCompareAligned, setActiveStep,
                      pcaColorBy, setPcaColorBy, pcaShapeBy, setPcaShapeBy, importApi, curvesOpen, setCurvesOpen };

  return (
    <div className="flex h-full w-full bg-[#050505] text-neutral-200 font-sans">
      {/* Map */}
      <FieldMap
        mapRef={mapRef} initialCenter={initialView.center} initialZoom={initialView.zoom} onView={saveView}
        basemap={basemap} setBasemap={setBasemap}
        showField={showField} setShowField={setShowField}
        showPsf={showPsf} setShowPsf={setShowPsf}
        fieldOnly={fieldOnly} setFieldOnly={setFieldOnly}
        simOn={simOn} geoKey={geoKey}
        area={area} gridApi={gridApi} exp={exp} sim={simApi} pca={pcaApi}
      />

      {/* Sidebar */}
      <aside className="relative flex shrink-0 flex-col border-l border-white/10 bg-[#11151a] text-slate-200" style={{ width: panelW }}>
        {/* Drag the left edge to widen the panel */}
        <div onPointerDown={startResize} title="Drag to resize"
          className="absolute inset-y-0 -left-1 z-[1200] w-2 cursor-col-resize hover:bg-sky-500/40" />
        <header className="shrink-0 border-b border-white/10 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-sm font-semibold text-white">Pixel Grid Designer</h1>
            <div className="flex shrink-0 items-center gap-1.5">
            <button type="button"
              onClick={() => (confirmReset ? resetSavedState() : setConfirmReset(true))}
              title="Clear the field and all settings (your pinned field stays)"
              className={`rounded-md border px-2 py-1 text-xs transition-colors ${confirmReset ? 'border-amber-400/60 bg-amber-500/15 text-amber-200' : 'border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200'}`}>
              {confirmReset ? 'Click again to reset' : 'Reset'}
            </button>
            {!STANDALONE && (
              <a
                href="./"
                title="Back to the Polygon Time-Series PCA app"
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300 transition-colors hover:bg-sky-500/20"
              >
                <Layers className="h-3 w-3" /> Polygon PCA
              </a>
            )}
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
        <AreaStep {...stepProps} />

        <GridStep {...stepProps} />

        <SimStep {...stepProps} />

        <PcaStep {...stepProps} />

        </div>

        {!STANDALONE && (
          <div className="shrink-0 border-t border-white/10 px-4 py-2 text-[11px] text-slate-500">
            <a href="./" className="text-sky-400 hover:underline">← Polygon Time-Series PCA</a>
          </div>
        )}
      </aside>
    </div>
  );
}
