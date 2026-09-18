import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { Layers } from 'lucide-react';
import { BASEMAPS, type BasemapKey } from './map-layers';
import { inRange, isBool, isLngLat, oneOf, readSaved, resetSavedState, saveRefusal, usePersistentState, writeSaved } from './persist';
import { useAoiField, usePlaceSearch } from './use-area';
import { useFieldGrid } from './use-grid';
import { useExperiment, usePcaSim, useSimulation } from './use-simulation';
import { aoiUtmOrigin } from './s2-grid';
import { readDesignFiles } from './design-import';
import { convexHull } from './imported-plan';
import { polyBbox, viewShowsField } from './geometry';
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
 * layer, in dependency order (area feeds grid feeds experiment feeds
 * simulation feeds PCA), and everything visible lives in FieldMap and the four
 * step panels. The two things that genuinely belong at this level are:
 *
 *  - `geoKey`, a hand-rolled cache key whose segments are only all in scope
 *    here. react-leaflet will not restyle a <GeoJSON> when its props change, so
 *    remounting on a changed key is the ONLY thing that repaints the map
 *    overlay. Drop a segment and you get a stale map with no error anywhere.
 *  - `activeStep`, because three hooks gate expensive work on it and the
 *    stepper unmounts closed panels.
 */

/**
 * Built on its own for the public site (see vite-env.d.ts). There is no PCA app
 * published alongside it, so the links back to it are not rendered.
 */
const STANDALONE = import.meta.env.VITE_STANDALONE === '1';

/** How long the trial angle waits for the next keystroke before it is staked. */
const STAKE_DELAY = 250;

/**
 * The side panel's width, held to what THIS window can show: at least 320 px of
 * panel, and at least 280 px of map beside it. The drag handle and the restore
 * both go through it, so a width saved on a wide screen cannot hide the map on
 * a narrow one, and the two can never disagree about what is allowed.
 */
const clampPanelW = (w: number): number =>
  Math.max(320, Math.min(typeof window === 'undefined' ? w : window.innerWidth - 280, w));

export default function PixelGridApp() {
  const mapRef = useRef<L.Map | null>(null);

  // Collapsible steps (one open at a time, PCA-style; click an open one to close it)
  const [activeStep, setActiveStep] = usePersistentState<'area' | 'grid' | 'sim' | 'pca' | null>('activeStep', 'grid',
    v => v === null || oneOf('area', 'grid', 'sim', 'pca')(v));
  const toggleStep = (s: 'area' | 'grid' | 'sim' | 'pca') => setActiveStep(cur => (cur === s ? null : s));
  const simOn = activeStep === 'sim' || activeStep === 'pca';

  // Step 1, the field. `setActiveStep` is passed straight through (never wrapped
  // in an arrow): the drawers reset in-progress geometry when `onDone`'s identity
  // changes, so a fresh one mid-trace would erase the user's vertices.
  const area = useAoiField(setActiveStep);
  const { aoi, aoiPoly, fieldRing, initialCenter } = area;

  // Step 2, the satellite and its pixel lattice. Everything downstream hangs off
  // `build`; sigmaX/sigmaY are owned here (the PSF is a property of the chosen
  // sensor) and handed to the simulation hooks as plain scalars.
  // The FIELD is the traced shape, or else the drawn box itself, and that RING
  // is what the hooks take. A box used to pass null instead, so its export,
  // pixel count, map overlay and PCA all kept the edge pixels the grid overhangs
  // by, while "In field only" hid them. `area.aoiPoly` still means "was a shape
  // traced", which only the wording (field vs drawn) cares about.
  const gridApi = useFieldGrid({ aoi, fieldRing });
  const { sigmaX, sigmaY, psfOffX, psfOffY, renderGrid, fieldAreaM2, gridSummary } = gridApi;
  const [basemap, setBasemap] = usePersistentState<BasemapKey>('basemap', 'satellite', v => typeof v === 'string' && v in BASEMAPS);
  // Render the true planting pattern under the grid. ON by default: the page is
  // about what a sensor makes of a layout, and with this off the map is a grid
  // of empty squares that says nothing about the trial underneath. It stays a
  // toggle, and stays persisted, so turning it off is remembered.
  const [showField, setShowField] = usePersistentState('showField', true, isBool);
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
    // The range the DRAG can produce, not a narrower one: the handle clamps to
    // `innerWidth - 280`, so on anything wider than 1680 px the widest drags
    // wrote a value the reader then rejected, and a panel deliberately widened
    // came back at 380. Clamped to THIS window below, because a width dragged
    // on a 3840 px screen is most of a 1280 px one.
    const saved = readSaved<number>('panelW', inRange(320, 4000));
    if (saved !== undefined) return clampPanelW(saved);
    // The pre-persist.ts key, read raw. In a private window or with storage full
    // this access throws, and it used to do so from inside a pointer handler and
    // a state initialiser, where every other saved value fails softly.
    try {
      const v = Number(localStorage.getItem('pgrid_panel_w'));
      return v >= 320 && v <= 4000 ? clampPanelW(v) : 380;
    } catch { return 380; }
  });

  // Steps 3 and 4: the planting design, the sensor's view of it, and the PCA.
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

  /**
   * Setting the trial angle turns the whole plan and then STAKES it: an N x N
   * search of sub-pixel positions, each one a full simulation of the trial
   * (stakeOnGrid). That ran inside the number input's onChange, so typing "45"
   * staked at "4" and again at "45", each one blocking the main thread for up
   * to a second on a dense trial.
   *
   * The decision stays HERE, on the click, and must not move back into render:
   * a trial that re-stakes itself while rendering would move under the field
   * outline set from it, and slide again at every resolution change. So it is
   * only deferred. The last angle typed within STAKE_DELAY wins, the page
   * paints in between, and the import panel's spinner says it is working.
   *
   * Until the stake lands, NOTHING about the trial has moved, and that is
   * deliberate. The turn, the staked shift and the field the trial sets are
   * three separate saved keys: applying the turn first meant a refresh inside
   * that window came back holding the new turn beside the old angle's shift and
   * field ring, which is the one state the trial must never be in, and nothing
   * re-stakes on load, so it stayed that way until the angle was set again.
   * `pendingAngle` carries the typed angle to the number input meanwhile.
   */
  const stakeTimer = useRef<number | null>(null);
  const [staking, setStaking] = useState(false);
  const [pendingAngle, setPendingAngle] = useState<number | null>(null);
  const cancelStake = useCallback(() => {
    if (stakeTimer.current !== null) { clearTimeout(stakeTimer.current); stakeTimer.current = null; }
    setStaking(false);
    setPendingAngle(null);
  }, []);
  const scheduleStake = useCallback((job: () => void) => {
    if (stakeTimer.current !== null) clearTimeout(stakeTimer.current);
    setStaking(true);
    stakeTimer.current = window.setTimeout(() => {
      stakeTimer.current = null;
      try { job(); } finally { setStaking(false); }
    }, STAKE_DELAY);
  }, []);
  useEffect(() => () => { if (stakeTimer.current !== null) clearTimeout(stakeTimer.current); }, []);
  const { setImportedDesign, setImportedCurves, setPattern, setImportedTurn, setImportedShift } = exp;
  const { setFieldFromTrial, restoreFieldBeforeTrial } = area;
  const onImportFiles = useCallback(async (files: File[]) => {
    setImportBusy(true);
    setImportError(null);
    try {
      const data = await Promise.all(files.map(async f => ({ name: f.name, data: await f.arrayBuffer() })));
      const design = await readDesignFiles(data);
      // The field becomes the trial's own outline, so the pixel count, the
      // purity, the PCA and the export all describe the trial's pixels. The
      // field that was there is kept (use-area) and comes back on Remove: it is
      // persisted, so without that the traced shape was gone for good.
      const hull = convexHull(design.plots.flatMap(p => p.rings.flat()));
      if (hull.length < 3) throw new Error('The plots in this file do not enclose any area.');
      // A stake still pending from the trial being replaced, or typed while this
      // file was being read, would land afterwards and set the OLD file's turn,
      // shift and outline over the new one. Cancelled here rather than on entry,
      // so a file that fails to read leaves the loaded trial's own stake alone.
      cancelStake();
      setImportedDesign(design);
      setImportedCurves({});
      setImportedTurn(0);
      setImportedShift([0, 0]);
      setPattern('imported');
      setFieldFromTrial(hull);
      // Someone who has just handed the page their own trial wants to SEE it.
      // With the pattern overlay off, a successful import looked like nothing
      // happening: the map redrew the same empty squares over a new outline.
      setShowField(true);
      const box = polyBbox(hull);
      mapRef.current?.fitBounds([[box[1], box[0]], [box[3], box[2]]], { padding: [40, 40], maxZoom: 19 });
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportBusy(false);
    }
  }, [cancelStake, setImportedDesign, setImportedCurves, setImportedTurn, setImportedShift, setPattern, setFieldFromTrial, setShowField]);

  /**
   * The trial is loaded but will not survive a refresh, and WHICH refusal it was
   * decides what there is to do about it. A quota is about this file: a smaller
   * trial fits, and everything else on the page is still being remembered. A
   * browser storing nothing at all (a private window, storage off for the site)
   * is about the browser: trimming the file changes nothing, and the sensor, the
   * field and every other setting are just as unsaved. Told the one story, a
   * user in a private window goes and edits a file that was never the problem.
   *
   * Asked only once a save has actually been refused, since asking is itself a
   * probe write.
   */
  const trialUnsaved = !!exp.importedDesign && !exp.importedDesignSaved;
  // In an EFFECT, not a memo: `saveRefusal` answers by writing one byte and
  // removing it again, and a render must not touch storage. Every other storage
  // touch on this page is already in an effect or an event handler, and React
  // is free to run a render it then throws away.
  const [unsavedMessage, setUnsavedMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!trialUnsaved) { setUnsavedMessage(null); return; }
    setUnsavedMessage(saveRefusal() === 'no-storage'
      ? 'This browser is not storing anything (a private window, or storage turned off for this site): the trial is loaded now, but a refresh will open with no trial, and no other setting is being remembered either.'
      : 'This trial is too large for the browser to remember: it is loaded now, but a refresh will open with no trial.');
  }, [trialUnsaved]);

  const importApi = {
    // Reading a file, or staking the trial after a turn: both are the page
    // working on the trial, and both are shown by the panel's own spinner.
    busy: importBusy || staking,
    // A read failure first; then what stops the loaded design from simulating;
    // then the one thing that is wrong even though the trial works: the browser
    // refused to keep it, so a refresh will open with no trial.
    error: importError ?? exp.importedError ?? unsavedMessage,
    onFiles: onImportFiles,
    onRemove: () => {
      cancelStake();
      setImportedDesign(null); setImportedCurves({}); setImportedTurn(0); setImportedShift([0, 0]);
      setImportError(null); setPattern('block');
      // The field the trial took over comes back, so removing a file is not a
      // silent way of losing the shape the user traced.
      restoreFieldBeforeTrial();
    },
    /**
     * Turn the trial to `deg` degrees from the pixel rows. The field follows it:
     * the field is the trial's outline, and left behind it would cut the turned
     * corners out of the pixel count, the purity and the export.
     *
     * The turn, the shift staked for THAT turn and the ring computed from the
     * result are decided first and applied together, in one React commit, so
     * they are saved together too. Nothing here may set one of the three on its
     * own: each is its own key, and a half-applied turn is a half-saved trial
     * (see scheduleStake). The angle on screen comes from `pendingAngle` while
     * the stake is pending, which is what keeps the input typeable.
     */
    setAngle: (deg: number) => {
      // The smallest turn to that angle: 0 and 90 degrees are the same to square pixels.
      const turn = nearestTurn(exp.importedFileAngle, deg);
      const base = exp.importedBasePlan, build = gridApi.build;
      // No plan and no grid: there is nothing to stake and nothing to set the
      // field from, so the turn is the whole of it and can land at once.
      if (!base || !build?.epsg) { cancelStake(); setImportedTurn(turn); setImportedShift([0, 0]); return; }
      const epsg = build.epsg, res = build.res, bounds = build.utmBounds;
      const sensor = { sigmaX, sigmaY, mixThreshold: exp.threshold / 100, offX: psfOffX, offY: psfOffY };
      const aligned = isAligned(exp.importedFileAngle + turn);
      setPendingAngle(deg);
      scheduleStake(() => {
        try {
          let plan = rotateImportedPlan(base, turn);
          /**
           * Turned along the pixel rows, it is also STAKED on them: the best
           * sub-pixel position of the whole trial at this pixel size. Decided
           * here, on the click, and saved, so the trial cannot move under the
           * field outline set from it, nor slide again at the next resolution.
           */
          let shift: [number, number] = [0, 0];
          if (aligned) {
            const staked = stakeOnGrid(plan, res, sensor, bounds);
            shift = staked.shift;
            plan = staked.plan;
          }
          const toLngLat = proj4(crsToProj4Def(`EPSG:${epsg}`), 'EPSG:4326');
          const ring = plan.footprint.map(p => toLngLat.forward(p) as [number, number]);
          if (ring.length < 3) throw new Error('Turning this trial left it with no outline.');
          // Past here nothing can fail, so the three land or none of them do.
          // A turn that works also clears the message a turn that failed left.
          setImportError(null);
          setImportedTurn(turn);
          setImportedShift(shift);
          setFieldFromTrial(ring);
          setPendingAngle(null);
        } catch (e) {
          // The trial is untouched, so the input goes back to the angle it is
          // really at; the throw would otherwise surface as an uncaught error
          // in a timer, where no error boundary and no panel can show it.
          setPendingAngle(null);
          setImportError(e instanceof Error ? e.message : String(e));
        }
      });
    },
    setVarietyColumn: (c: string) => setImportedDesign(d => (d ? { ...d, varietyColumn: c } : d)),
    setNameColumn: (c: string) => setImportedDesign(d => (d ? { ...d, nameColumn: c } : d)),
  };
  // Only what `geoKey` needs; the panels read the rest straight off `exp`.
  const { layoutSig, sensorSig, cropSig } = exp;

  const simApi = useSimulation({ aoi, gridApi, exp, simOn, fieldOrigin });
  const { patternOrigin, simSummary } = simApi;

  // mapSim: when the PCA runs on the grid the map already simulated, it reuses that result.
  const pcaApi = usePcaSim({ aoi, fieldRing, gridApi, exp, patternOrigin, activeStep, compareAligned, mapSim: simApi.sim });

  // `layoutSig` stands in for the four layout segments this used to splice in
  // (pattern, width, spacing, rotation). Those move for none of a block
  // design's parameters, so a changed seed or plot size left the previous trial
  // on the map: react-leaflet only repaints when this key changes.
  const geoKey = renderGrid
    ? `${renderGrid.epsg}-${renderGrid.res}-${renderGrid.utmBounds.join(',')}-${basemap}-${simOn ? 'sim' : 'off'}-${layoutSig}-${sensorSig}-${cropSig}`
    : 'none';

  // The map reopens where it was left, but only if the FIELD is still in view
  // there. The view and the field are saved under separate keys and either can
  // move without the other, so the page could open on ground a long way from
  // the field: no grid, no outline, nothing to click, and no hint that the
  // field is simply elsewhere. Failing that it opens on the field.
  const initialView = useMemo(() => {
    const saved = readSaved<{ center: [number, number]; zoom: number }>('view',
      v => !!v && typeof v === 'object' && isLngLat((v as { center?: unknown }).center) && inRange(1, 23)((v as { zoom?: unknown }).zoom));
    return saved && viewShowsField(saved.center, aoi) ? saved : { center: initialCenter, zoom: 16 };
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
      setPanelW(clampPanelW(Math.round(window.innerWidth - ev.clientX)));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setPanelW(w => { writeSaved('panelW', w); return w; });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /**
   * What the step panels read. The trial angle is the one value they must not
   * take straight from `exp` while a stake is pending: the angle input is
   * controlled by it, and with the trial still at its old angle every keystroke
   * would be rewritten under the cursor, so "45" could never be typed a digit
   * at a time. The map is given the real `exp`, because it draws the trial and
   * the trial has not moved yet.
   */
  const shownExp = pendingAngle === null ? exp : { ...exp, importedAngle: pendingAngle };

  const stepProps = { activeStep, toggleStep, area, search, gridApi, exp: shownExp, sim: simApi, pca: pcaApi,
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
