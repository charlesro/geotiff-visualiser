import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { Layers } from 'lucide-react';
import { BASEMAPS, type BasemapKey } from './map-layers';
import { inRange, isBool, isLngLat, isNum, oneOf, readSaved, resetSavedState, saveRefusal, usePersistentState, writeSaved } from './persist';
import { useAoiField, usePlaceSearch } from './use-area';
import { useFieldGrid } from './use-grid';
import { useExperiment, usePcaSim, useSimulation } from './use-simulation';
import { pixelVerdicts } from './pixel-verdicts';
import { aoiUtmOrigin, utmEpsg, utmZoneForLng, type LngLatBounds } from './s2-grid';
import { buildBlockPlan, stakeMesh, utmEnvelope, type BlockDesign } from './simulate';
import { fieldAngle, fieldSeat, trialFitsField } from './trial-seat';
import { SOURCES, ladderRungs, latticePhase, type Rung } from './sensors';
import { blockPlotCounts, ladderStep } from './ladder-step';
import { suggestBlockDesign, suggestChecker, suggestStrips, type CheckerSuggestion, type StripSuggestion } from './suggest-design';
import { PER_STRIP_DEFAULT, SUGGEST_FIT, type SuggestAsk, type SuggestOutcome } from './steps/SuggestDesign';
import { SHOW_GRID_STEP, type MostUndo, type PlotsSetting, type SimSection } from './steps/props';
import { readDesignFiles } from './design-import';
import { convexHull } from './imported-plan';
import { polyBbox, viewShowsField, type Poly } from './geometry';
import { alignedWithin, isAligned, nearestTurn, rotateImportedPlan, shiftImportedPlan, stakeOnGrid } from './imported-rotate';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import type { ColorBy, ShapeBy } from './pca-field';
import { FieldMap } from './FieldMap';
import { AreaStep } from './steps/AreaStep';
import { GridStep } from './steps/GridStep';
import { SimStep } from './steps/SimStep';
import { PcaStep } from './steps/PcaStep';
import { DOCS_PAGE } from './docs';

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
  // With the grid step not shown (SHOW_GRID_STEP), a browser that had it open
  // is not left on a step that is not there: it opens the simulation instead.
  const [activeStep, setActiveStep] = usePersistentState<'area' | 'grid' | 'sim' | 'pca' | null>('activeStep', SHOW_GRID_STEP ? 'grid' : 'sim',
    v => v === null || (SHOW_GRID_STEP ? oneOf('area', 'grid', 'sim', 'pca') : oneOf('area', 'sim', 'pca'))(v));
  const toggleStep = (s: 'area' | 'grid' | 'sim' | 'pca') => setActiveStep(cur => (cur === s ? null : s));
  // The simulation is on the map in every step. It had a switch of its own, off
  // only in step 1 and only if asked: "Real field" is the way to see the trial
  // as planted instead, and the switch doubled it ("PSF blur and simulation are
  // duplicates of real field and the sigmas", 2026-11-22).
  // Outline the pure pixels of the simulation on the map and dim the others.
  const [showPure, setShowPure] = usePersistentState('showPure', false, isBool);

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
  const { sigmaX, sigmaY, renderGrid, fieldAreaM2, gridSummary } = gridApi;
  const [basemap, setBasemap] = usePersistentState<BasemapKey>('basemap', 'satellite', v => typeof v === 'string' && v in BASEMAPS);
  // Render the true planting pattern under the grid. ON by default: the page is
  // about what a sensor makes of a layout, and with this off the map is a grid
  // of empty squares that says nothing about the trial underneath. It stays a
  // toggle, and stays persisted, so turning it off is remembered.
  const [showField, setShowField] = usePersistentState('showField', true, isBool);
  const [showSigmas, setShowSigmas] = usePersistentState('showSigmas', false, isBool);  // the three sigmas of the blur budget, as rings
  const [showSources, setShowSources] = usePersistentState('showSources', false, isBool);  // one pixel's signal as dots, with the share of each cover
  const [fieldOnly, setFieldOnly] = usePersistentState('fieldOnly', false, isBool);  // trim the grid to the traced field

  // Disclosure / tab state for the step panels. It lives up here because `Step`
  // unmounts a collapsed panel, which would otherwise reset it every time the
  // user folds a step away.
  // Step 3's folds: one open at a time, all shut to begin with ("make all
  // subtabs closed by default"). Kept under a key of its own, `simFold`: the
  // one before it, `simSection`, began with the design open and was saved that
  // way in every browser that had the page.
  const [simSection, setSimSection] = usePersistentState<SimSection>('simFold', null,
    v => v === null || oneOf('sat', 'design', 'suggest', 'size', 'curves')(v));
  const [blurOpen, setBlurOpen] = usePersistentState('blurOpen', false, isBool);
  const [pcaRetuneOpen, setPcaRetuneOpen] = usePersistentState('pcaRetuneOpen', false, isBool);
  const [compareAligned, setCompareAligned] = usePersistentState('compareAligned', false, isBool);  // rotated vs 0° ladders
  const [ladderView, setLadderView] = usePersistentState<'table' | 'charts'>('ladderView', 'table', oneOf('table', 'charts'));
  // The count the plot-size card's typed row asks for (steps 2 and 3 show the same card).
  const [wantPure, setWantPure] = usePersistentState('wantPure', 16, v => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 400);
  // What "Use these" of the plot-size card replaced, for its Undo: plot sides as the design fields accept them.
  const isPlots = (v: unknown) => !!v && typeof v === 'object' && inRange(0.1, 1000)((v as PlotsSetting).plotLength)
    && inRange(0.1, 1000)((v as PlotsSetting).plotWidth) && Number.isInteger((v as PlotsSetting).blocksPerRow) && (v as PlotsSetting).blocksPerRow >= 1
    && ((v as PlotsSetting).rotation === undefined || inRange(-90, 90)((v as PlotsSetting).rotation));
  const [mostUndo, setMostUndo] = usePersistentState<MostUndo | null>('mostUndo', null,
    v => v === null || (!!v && typeof v === 'object' && isPlots((v as MostUndo).from) && isPlots((v as MostUndo).to)));
  /**
   * Where the design was before the aligned placement was adopted from the
   * ladder, so the comparison outlives the choice made with it.
   *
   * Picking the aligned panel turns the design to 0, which left the two ladders
   * describing the same thing: the comparison disappeared at the moment it was
   * used, with no way back to the placement it had just been weighed against.
   *
   * SAVED, with the kind of design it was adopted for. It was held in memory
   * only, on the grounds that a refresh is a fresh look at whatever the design
   * is now; but the turn itself is saved, so a refresh brought back a trial
   * turned to the pixel rows with nothing left saying where it had been turned
   * from: one ladder, "vs aligned" greyed out, the original angle gone. What
   * is read from it is `compareFrom`, further down, which holds only while the
   * design still sits at the aligned placement. Forgotten the moment the angle
   * is set any other way, or another trial is read.
   */
  const [adopted, setAdopted] = usePersistentState<{ deg: number; imported: boolean; to?: number } | null>('compareFrom', null,
    v => v === null || (typeof v === 'object' && isNum((v as { deg?: unknown }).deg) && isBool((v as { imported?: unknown }).imported)
      && ((v as { to?: unknown }).to === undefined || isNum((v as { to?: unknown }).to))));
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
      return v >= 320 && v <= 4000 ? clampPanelW(v) : 460;
    } catch { return 460; }
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
    sigmaX, sigmaY, anyPosition: gridApi.source.kind !== 'catalog', placeHeldM: gridApi.placeHeldM,
    fieldBounds: gridApi.build?.utmBounds ?? null, fieldOrigin, pixelSize: gridApi.build?.res ?? 10,
    epsg: gridApi.build?.epsg ?? null, aoi, fieldRing,
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
  const { setFieldFromTrial, restoreFieldBeforeTrial, setFieldBox } = area;
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
      // The angle remembered for the trial this one replaces is not this one's.
      setAdopted(null);
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
  }, [cancelStake, setImportedDesign, setImportedCurves, setImportedTurn, setImportedShift, setPattern, setFieldFromTrial, setShowField, setAdopted]);

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

  /**
   * The angle the design was turned from, while it still sits where that turn
   * put it, for the same kind of design: along the pixel rows for the strips
   * and the block trial, at the angle of the best placement that was picked
   * for an imported one (`to`). Anything else (a pattern picked since, an
   * angle typed in a box) and there is no adopted placement to step back
   * from, whatever is saved. Read against the angle ON SCREEN, so that it
   * holds from the click and not from the moment a stake lands a little later.
   *
   * An imported trial found along the pixel rows with nothing remembered was
   * turned there before the angle was kept, or by a 0 typed in the box: the
   * angle it was drawn at is in the file, so it is compared with that, and the
   * original rotation is never the one thing the page cannot show.
   */
  const importedNow = exp.pattern === 'imported';
  const angleShown = importedNow ? (pendingAngle ?? exp.importedAngle) : exp.rotation;
  /** Two angles to the pixel rows that are the same one: square pixels look alike a quarter turn round. */
  const sameAngle = (p: number, q: number) => alignedWithin(p - q, 0.05);
  const fileFrom = importedNow && exp.importedTurn !== 0 ? { deg: exp.importedFileAngle, to: 0 } : null;
  const turnedFrom = adopted && adopted.imported === importedNow ? { deg: adopted.deg, to: adopted.to ?? 0 } : fileFrom;
  const compareFrom = turnedFrom && sameAngle(angleShown, turnedFrom.to) && !sameAngle(turnedFrom.deg, turnedFrom.to) ? turnedFrom.deg : null;
  /** `to`: the angle of the placement being adopted; the pixel rows when it is not said. */
  const setCompareFrom = (deg: number | null, to = 0) => setAdopted(deg === null ? null : { deg, imported: importedNow, to });

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
      setAdopted(null);
      setImportError(null); setPattern('block');
      // The field the trial took over comes back, so removing a file is not a
      // silent way of losing the shape the user traced.
      restoreFieldBeforeTrial();
    },
    /**
     * Put the trial exactly where a rung of the best-placement ladder has it:
     * the file's trial turned by `turn` degrees, then moved by `shift` metres.
     * Nothing is searched or staked here, which is the point: the rung was
     * measured at that placement, and what lands on the map has to be the
     * rung that was clicked. The turn, the shift and the field's outline land
     * together or not at all, as in setAngle.
     */
    setPlacement: (turn: number, shift: [number, number]) => {
      const base = exp.importedBasePlan, build = gridApi.build;
      if (!base || !build?.epsg) return;
      cancelStake();
      try {
        const plan = shiftImportedPlan(rotateImportedPlan(base, turn), shift[0], shift[1]);
        const toLngLat = proj4(crsToProj4Def(`EPSG:${build.epsg}`), 'EPSG:4326');
        const ring = plan.footprint.map(q => toLngLat.forward(q) as [number, number]);
        if (ring.length < 3) throw new Error('Turning this trial left it with no outline.');
        setImportError(null);
        setImportedTurn(turn);
        setImportedShift(shift);
        setFieldFromTrial(ring);
      } catch (e) {
        setImportError(e instanceof Error ? e.message : String(e));
      }
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
      const sensor = { sigmaX, sigmaY, mixThreshold: exp.threshold / 100, anyPosition: gridApi.source.kind !== 'catalog', placeHeldM: gridApi.placeHeldM };
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
  /**
   * See StepProps.setAngleByHand. Deliberately not memoised: `importApi` is
   * rebuilt every render and its `setAngle` closes over this render's design,
   * grid and sensor, so a callback pinned with an empty dep list would go on
   * calling the first render's and stake against a trial that had moved on.
   */
  const setAngleByHand = (deg: number) => { setCompareFrom(null); importApi.setAngle(deg); };

  /**
   * "Suggest a design" (step 3): what the reader asks of a block trial, and the
   * build that answers it. The request is saved like any other setting; what
   * was last built is only for the lines under the button.
   *
   * A build writes four things at once, which is why it lives here: the block
   * design, the angle (along the pixel rows unless another is asked for: that
   * is where a trial of whole-pixel plots keeps the most), the layout, and the
   * satellite the trial was sized for. The search itself is a few tens of
   * milliseconds along the rows (suggest-design.ts), more for a turned trial,
   * which is counted whole at every size tried; it runs after a tick so that
   * the button can say it is working.
   */
  const [suggestAsk, setSuggestAsk] = usePersistentState<SuggestAsk>('suggestAsk',
    () => ({ species: 4, reps: 4, sat: '', hold: true, plotAlley: 0, blockAlley: 0 }),
    v => !!v && typeof v === 'object' && inRange(2, 8)((v as SuggestAsk).species) && inRange(1, 20)((v as SuggestAsk).reps)
      && typeof (v as SuggestAsk).sat === 'string' && isBool((v as SuggestAsk).hold)
      && inRange(0, 100)((v as SuggestAsk).plotAlley) && inRange(0, 100)((v as SuggestAsk).blockAlley)
      // A request saved before the angle existed has none: along the pixel rows.
      && ((v as SuggestAsk).angle === undefined || inRange(-90, 90)((v as SuggestAsk).angle))
      && ((v as SuggestAsk).stripAlley === undefined || inRange(0, 100)((v as SuggestAsk).stripAlley))
      && ((v as SuggestAsk).perStrip === undefined || inRange(1, 2000)((v as SuggestAsk).perStrip))
      && ((v as SuggestAsk).repsMax === undefined || isBool((v as SuggestAsk).repsMax)));
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestOutcome, setSuggestOutcome] = useState<SuggestOutcome | null>(null);
  /** How far a build has got: steps done of all, and what is being worked out. Null when none runs. */
  const [suggestProgress, setSuggestProgress] = useState<{ done: number; total: number; what: string } | null>(null);
  /**
   * A build's ticket: a field redrawn or cleared, or another layout picked,
   * while a build is between two of its steps, and that build stops without
   * writing anything (Neon's review, 2026-11-25: it went on to put its trial
   * on the new field, or back in the old layout).
   */
  const buildRun = useRef(0);
  useEffect(() => { buildRun.current++; }, [aoi?.join(','), fieldRing, exp.pattern]); // eslint-disable-line react-hooks/exhaustive-deps
  const buildSuggested = () => {
    if (suggestBusy) return;
    const grid = gridApi.build;
    // The satellites of the table, the one selected taken as it stands in step 2.
    const sats = ladderRungs({ id: gridApi.sourceId, res: grid?.res ?? gridApi.pxSize, sigmaX, sigmaY });
    /**
     * "Coarsest that fits the field" (2026-11-24: "i dont specify sattelite [...]
     * i just say the species and the number of pixels and it gives me the
     * biggest gsd that works"): no satellite is named; the satellites of the
     * list are tried from the coarsest pixel down, each with its own blur and
     * CE90 as delivered, and the first whose smallest block trial fits the
     * field drawn is built. A block trial, on a field there is.
     */
    const fitSearch = suggestAsk.sat === SUGGEST_FIT && exp.pattern === 'block';
    /**
     * "As many repetitions as fit the field" (2026-11-25: "one with both
     * satellite and area constrained where you give the max number of
     * repetition that can fit"): the satellite named, the field drawn, and the
     * repetitions found, from 1 to 20, as the most whose smallest trial fits.
     * With the coarsest satellite asked for too there would be two unknowns:
     * that one is answered first, at the repetitions typed.
     */
    const repsSearch = !!suggestAsk.repsMax && exp.pattern === 'block' && !fitSearch;
    if ((fitSearch || repsSearch) && !aoi) return;
    const named = sats.find(g => g.id === suggestAsk.sat) ?? sats.find(g => g.id === gridApi.sourceId);
    if (!named && !fitSearch) return;
    /**
     * NO EXPERIMENT AREA IS NEEDED. Where there is one and the trial fits it,
     * the trial goes in the middle of it. Where there is none, or it is too
     * small for any arrangement, the page makes the area itself, around the
     * trial: in the middle of the area that was there, or of the map. Building
     * used to refuse without an area and, with a small one, to tell the reader
     * to go and draw a larger one, for a trial whose size the page had just
     * worked out.
     */
    const view = mapRef.current?.getCenter();
    const centre: [number, number] = aoi ? [(aoi[0] + aoi[2]) / 2, (aoi[1] + aoi[3]) / 2]
      : view ? [view.lng, view.lat] : [initialCenter[1], initialCenter[0]];
    const epsg = grid?.epsg ?? utmEpsg(utmZoneForLng(centre[0]), centre[1] < 0);
    // The trial's angle to the pixel rows as asked. A build may turn it to the field's own direction (below).
    const askedAngle = suggestAsk.angle ?? 0;
    // A quarter turn lies along the pixels (suggestBlockDesign sizes it as it does no turn at all).
    const isTurned = (deg: number) => Math.abs(deg % 90) > 1e-9;
    // A trial's own box's half sides when it is turned by `deg`.
    const halfBoxAt = (deg: number) => {
      const rad = (deg * Math.PI) / 180, cosA = Math.abs(Math.cos(rad)), sinA = Math.abs(Math.sin(rad));
      return (u: number, v: number): [number, number] => [(u * cosA + v * sinA) / 2, (u * sinA + v * cosA) / 2];
    };
    /**
     * "this one could fit in if it was rotated" (2026-11-25): on a traced field
     * that is turned to the pixel rows, a trial that does not fit at the angle
     * asked is tried along the field's two directions (its smallest enclosing
     * rectangle's sides), and the first angle at which it fits is built.
     */
    const fieldDeg = aoi ? fieldAngle(fieldRing, aoi, epsg) : null;
    const angles = fieldDeg == null ? [askedAngle]
      : [askedAngle, ...[fieldDeg, fieldDeg <= 0 ? fieldDeg + 90 : fieldDeg - 90].filter(d => Math.abs(d - askedAngle) > 1e-6)];
    // Alternating rows or columns have no trial to size: their strips are
    // (suggestStrips), and a checkerboard's cells (suggestChecker).
    const kind = exp.pattern === 'row' || exp.pattern === 'col' || exp.pattern === 'checker' ? exp.pattern : null;
    if (kind) { if (named) buildStrips(kind, named, epsg, centre, askedAngle); return; }
    setSuggestBusy(true);
    /**
     * A bar under the button (2026-11-25: "can you make a loading bar for the
     * build this trial"): the build is cut into steps, one per satellite tried,
     * one per count of repetitions tried, then the trial and its count on the
     * field, and the page is drawn between two steps.
     */
    const finish = () => { setSuggestBusy(false); setSuggestProgress(null); };
    /**
     * The satellites "Coarsest that fits" tries: the list from the coarsest
     * pixel down, a sensor of one's own and the pansharpened products left out
     * (Neon, 2026-11-25): a trial is designed on native multispectral pixels,
     * as the satellites list says.
     */
    const fitOrder = fitSearch ? sats.filter(g => g.id !== 'custom' && !/pansharpened/i.test(SOURCES.find(s => s.id === g.id)?.provider ?? '')).sort((a, b) => b.res - a.res) : [];
    // A satellite named, on a field turned to the rows: first tried on the field, along it when only that fits.
    const preTry = !fitSearch && !repsSearch && !!aoi && angles.length > 1;
    let done = 0;
    const total = fitOrder.length + (repsSearch ? 20 : 0) + (preTry ? 1 : 0) + 2;
    const run = ++buildRun.current;
    /** A step of the bar; false when the build was overtaken meanwhile, and has to stop. */
    const step = async (what: string): Promise<boolean> => {
      setSuggestProgress({ done, total, what });
      done++;
      // A frame for the bar to be drawn in, then the next step; a hidden tab draws no frames, and the timer goes on.
      await new Promise<void>(r => {
        let gone = false;
        const go = () => { if (!gone) { gone = true; window.setTimeout(r, 0); } };
        requestAnimationFrame(go);
        window.setTimeout(go, 50);
      });
      return run === buildRun.current;
    };
    window.setTimeout(async () => {
     // Everything a build needs for one satellite: its CE90, its lattice, its search.
     const withSat = (sat: Rung, angle: number) => {
      const r = sat.res, turned = isTurned(angle), halfBox = halfBoxAt(angle);
      const ce90M = suggestAsk.hold ? Math.round(gridApi.ce90At(r, sat.id) * 100) / 100 : 0;
      // Where the page will then put what is built: for the pixels that hold within this satellite's CE90, or for the pure ones.
      const placeHeldM = gridApi.placeFor === 'held' ? Math.round(gridApi.ce90At(r, sat.id) * 100) / 100 : 0;
      const def = crsToProj4Def(`EPSG:${epsg}`);
      const toUtm = proj4('EPSG:4326', def), toLngLat = proj4(def, 'EPSG:4326');
      // An extent as a rung of the table snaps it, so that the staking mesh is the table's own.
      const stepsOn = (b: LngLatBounds) => {
        const [e0, n0, e1, n1] = utmEnvelope(b, epsg);
        // On the satellite's own lattice, as the rung lays its box (ladder-step.ts).
        const [pE, pN] = latticePhase(sat.id, r, epsg);
        return stakeMesh([Math.floor((e0 - pE) / r) * r + pE, Math.floor((n0 - pN) / r) * r + pN, Math.ceil((e1 - pE) / r) * r + pE, Math.ceil((n1 - pN) / r) * r + pN], r)?.steps;
      };
      /**
       * A turned trial is sized on the satellites table's own count, plot by
       * plot, on the ground it will lie on: an area and its outline. With the
       * box unticked no geolocation error is held against, as along the rows.
       */
      const countOn = (ground: LngLatBounds, ring: Poly | null) => (design: BlockDesign) => {
        const c = blockPlotCounts({
          aoi: ground, fieldRing: ring, epsg, threshold: exp.threshold, blockDesign: design,
          layout: { pattern: 'block', width: exp.stripWidth, spacing: exp.spacing, rotationDeg: angle },
          importedAngle: 0, importedFileAngle: 0, importedBasePlan: undefined,
          geoAuto: false, geoManual: suggestAsk.hold ? gridApi.geoManual : 0, geoProvider: suggestAsk.hold && !gridApi.geoTyped,
          placeFor: gridApi.placeFor, pageGeo: { auto: false, manualM: gridApi.geoManual, provider: !gridApi.geoTyped },
        }, angle, sat);
        if (!c) throw new Error('This trial is too large to be counted plot by plot at an angle. Ask for fewer pixels, species or repetitions, or build it along the pixel rows (angle 0).');
        return c;
      };
      type Count = ReturnType<typeof countOn>;
      const ask = (field: { u: number; v: number } | null, stakeSteps: number | undefined, countAt?: Count, reps = suggestAsk.reps) => suggestBlockDesign({
        nSpecies: suggestAsk.species, nBlocks: reps, pixels: wantPure,
        res: r, sigmaX: sat.sigmaX, sigmaY: sat.sigmaY, threshold: exp.threshold / 100, anyPosition: sat.anyPosition, placeHeldM, ce90M,
        // The alleys asked for in the panel, none by default: NOT the design's
        // own, which are whatever the layout last had.
        plotAlley: suggestAsk.plotAlley, blockAlley: suggestAsk.blockAlley,
        field, fitsField: field ? fitsField : undefined, stakeSteps, seed: exp.blockDesign.seed,
        rotationDeg: angle, countAt,
      });
      const had = aoi ? utmEnvelope(aoi, epsg) : null;
      const field = had ? { u: had[2] - had[0], v: had[3] - had[1] } : { u: 0, v: 0 };
      const said = { satId: sat.id, sat: sat.name, res: r, pixels: wantPure, ce90M, threshold: exp.threshold, field, angle };
      // A trial fits a traced field when it has a seat wholly inside the
      // outline, which the box of an oblique parcel says nothing about. A field
      // that is a box holds a turned trial when it holds the trial's own box.
      // With a pixel to spare all round, as Most in this field asks (2026-11-25): a trial that only just
      // fitted had its edge plots cut by the field's outline, and the table counted none in them.
      // The same test as Most in this field's (trial-seat.ts trialFitsField).
      const fitsField = (u: number, v: number) => !!aoi && trialFitsField(fieldRing, aoi, epsg, u, v, angle, r);
      // The area the page makes for a trial that has none to go in: the trial's
      // own box, and a margin that keeps it clear of the edge.
      const [cE, cN] = toUtm.forward(centre);
      const areaFor = (u: number, v: number): LngLatBounds => {
        const margin = Math.max(3 * r, 0.05 * Math.max(u, v), 5);
        const [bu, bv] = halfBox(u, v), hu = bu + margin, hv = bv + margin;
        const corners = ([[cE - hu, cN - hv], [cE + hu, cN - hv], [cE + hu, cN + hv], [cE - hu, cN + hv]] as [number, number][])
          .map(q => toLngLat.forward(q) as [number, number]);
        return [Math.min(...corners.map(q => q[0])), Math.min(...corners.map(q => q[1])), Math.max(...corners.map(q => q[0])), Math.max(...corners.map(q => q[1]))];
      };
      const ringOf = (b: LngLatBounds): Poly => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
      const cmOf = (m: number) => Math.round(m * 100) / 100;
      /** A turned design counted on the area the page would make for it. */
      const countOnOwn: Count = design => {
        const size = buildBlockPlan(design, { centerU: 0, centerV: 0 });
        const own = areaFor(cmOf(size.totalU), cmOf(size.totalV));
        return countOn(own, ringOf(own))(design);
      };
      return { r, ce90M, ask, had, field, said, stepsOn, countOn, countOnOwn, areaFor, ringOf, toLngLat, turned, halfBox };
     };
     /** A satellite's smallest trial on the field, at the angle asked, else along the field: the first angle at which it fits, or the one asked. */
     const onTheField = (g: Rung, n = suggestAsk.reps) => {
       let first: { deg: number; tried: ReturnType<ReturnType<typeof withSat>['ask']> } | null = null;
       let error: string | undefined;
       for (const deg of angles) {
         const w = withSat(g, deg);
         let tried: ReturnType<typeof w.ask> = null;
         // A turned trial too large to count plot by plot does not fit at that angle; another angle may (Neon, 2026-11-25).
         try { tried = w.had ? w.ask(w.field, w.stepsOn(aoi!), w.turned ? w.countOn(aoi!, fieldRing) : undefined, n) : null; }
         catch (e) { error = e instanceof Error ? e.message : String(e); continue; }
         if (tried && tried.fits !== false) return { deg, tried, fits: true };
         if (!first) first = { deg, tried };
       }
       return { deg: first?.deg ?? askedAngle, tried: first?.tried ?? null, fits: false, error: first ? undefined : error };
     };
      // The coarsest satellite whose smallest trial fits the field: the list from the
      // coarsest pixel down, a sensor of one's own left out. The one tried just before
      // it, coarser and too large for the field, is said too.
      let sat: Rung | undefined = named, coarser: NonNullable<SuggestOutcome['fit']>['coarser'] = null;
      let angle = askedAngle;
      // The trial a search already found for the satellite, angle and repetitions built: not asked for twice.
      let found: ReturnType<typeof onTheField>['tried'] = null;
      if (fitSearch) {
        sat = undefined;
        let error: string | undefined;
        try {
          for (const g of fitOrder) {
            if (!await step(`Trying ${g.name} · ${g.res} m`)) { finish(); return; }
            const on = onTheField(g);
            if (on.fits) { sat = g; angle = on.deg; found = on.tried; break; }
            if (on.error) error = on.error;
            coarser = { name: g.name, res: g.res, footprint: on.tried ? on.tried.footprint : null };
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        if (!sat) {
          const [e0, n0, e1, n1] = utmEnvelope(aoi!, epsg);
          // None fits: said as such, or, when some could not even be counted, why.
          setSuggestOutcome({ satId: '', sat: '', res: 0, pixels: wantPure, ce90M: 0, threshold: exp.threshold, field: { u: e1 - e0, v: n1 - n0 }, angle: askedAngle,
            built: null, onField: null, area: null, ...(error ? { error } : { fit: { coarser: null, none: true } }) });
          finish();
          return;
        }
      }
      if (!sat) { finish(); return; }
      // The most repetitions whose smallest trial fits the field, every count from 1 to 20 tried
      // (more repetitions may fit in another arrangement of blocks than fewer did).
      let reps = suggestAsk.reps, most: SuggestOutcome['most'] = undefined;
      if (repsSearch) {
        const tried: (ReturnType<typeof onTheField> | null)[] = [];
        let error: string | undefined;
        try {
          for (let n = 1; n <= 20; n++) {
            if (!await step(`Trying ${n} ${n === 1 ? 'repetition' : 'repetitions'}`)) { finish(); return; }
            tried[n] = aoi ? onTheField(sat, n) : null;
            if (tried[n]?.error) error = tried[n]!.error;
            // A trial of more blocks is never smaller than one of fewer, in its best arrangement: two counts
            // in a row that do not fit, and no larger one will (Neon, 2026-11-25: all 20 were tried).
            if (n >= 2 && !tried[n]?.fits && !tried[n - 1]?.fits) break;
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        const fits = (n: number) => !!tried[n]?.fits;
        const best = [...Array(20).keys()].map(k => 20 - k).find(fits) ?? 0;
        if (!best && error) {
          setSuggestOutcome({ ...withSat(sat, askedAngle).said, built: null, onField: null, area: null, error });
          finish();
          return;
        }
        const next = best < 20 ? tried[best + 1] : null;
        most = { reps: best, next: best < 20 ? { reps: best + 1, footprint: next?.tried ? next.tried.footprint : null } : null };
        if (!best) {
          setSuggestOutcome({ ...withSat(sat, askedAngle).said, built: null, onField: null, area: null, most });
          finish();
          return;
        }
        reps = best;
        angle = tried[best]!.deg;
        found = tried[best]!.tried;
        // Written into the request as it is NOW: what was typed meanwhile stays (Neon, 2026-11-25).
        if (reps !== suggestAsk.reps) setSuggestAsk(cur => ({ ...cur, reps }));
      } else if (preTry) {
        // A satellite named, on a turned field: along the field's own direction when only that fits.
        if (!await step(`Trying ${sat.name} along the field`)) { finish(); return; }
        try { const on = onTheField(sat, reps); if (on.fits) { angle = on.deg; found = on.tried; } } catch { /* the build below says why */ }
      }
      const { r, ce90M, ask: askReps, had, field, said, stepsOn, countOn, countOnOwn, areaFor, ringOf, toLngLat, turned, halfBox } = withSat(sat, angle);
      const ask = (f: { u: number; v: number } | null, steps: number | undefined, countAt?: Parameters<typeof askReps>[2]) => askReps(f, steps, countAt, reps);
      done = Math.max(done, total - 2);
      if (!await step(`Building the trial for ${sat.name} · ${r} m`)) { finish(); return; }
      try {
        let ground: LngLatBounds | null = aoi, ring = fieldRing;
        let area: SuggestOutcome['area'] = null;
        // In the area there is, when some arrangement fits it: the one a search found already, else asked now.
        let built = found && found.fits !== false ? found : aoi && had ? ask(field, stepsOn(aoi), turned ? countOn(aoi, fieldRing) : undefined) : null;
        /**
         * A FIELD DRAWN IS THE READER'S, and is never replaced (2026-11-25: "it
         * doesnt respect my field boundaries. it creates a new one"). A trial
         * that does not fit it is not built, and the reader is told the size of
         * the smallest one. Only with no field at all does the page make one.
         */
        if (aoi && built && built.fits === false) {
          setSuggestOutcome({ ...said, built: null, onField: null, area: null, tooBig: { footprint: built.footprint } });
          return;
        }
        if (!aoi && !built) {
          // No field: an area of its own: the trial, and a margin that keeps it
          // clear of the edge wherever the staking then puts it. The mesh the
          // page will stake on depends on that area's size, which depends on
          // the trial: asked again until the two agree. A turned trial is not
          // staked: it is counted on its own area at every size, once.
          let steps: number | undefined = 6, own: ReturnType<typeof ask> = null, box: LngLatBounds | null = null;
          for (let pass = 0; pass < (turned ? 1 : 3); pass++) {
            own = ask(null, steps, turned ? countOnOwn : undefined);
            if (!own) break;
            box = areaFor(own.footprint[0], own.footprint[1]);
            const need = stepsOn(box);
            if (need === steps) break;
            steps = need;
          }
          if (own && box) {
            built = own;
            ground = box;
            ring = ringOf(box);
            const [e0, n0, e1, n1] = utmEnvelope(box, epsg);
            area = { how: 'made', u: e1 - e0, v: n1 - n0 };
          } else if (!own) {
            built = null;
          }
        }
        let onField: SuggestOutcome['onField'] = null;
        if (built && ground) {
          // What the satellites table will count for it on THIS area, plot by
          // plot, while the trial is small enough for the table to count so.
          // Counted BEFORE anything is written: a build overtaken meanwhile, or
          // one whose count fails, leaves the page as it was.
          if ((built.footprint[0] / r) * (built.footprint[1] / r) <= 15_000) {
            if (!await step('Counting its pixels on the field')) { finish(); return; }
            const row = ladderStep({
              aoi: ground, fieldRing: ring, epsg, threshold: exp.threshold, blockDesign: built.design,
              layout: { pattern: 'block', width: exp.stripWidth, spacing: exp.spacing, rotationDeg: angle },
              importedAngle: 0, importedFileAngle: 0, importedBasePlan: undefined,
              geoAuto: false, geoManual: gridApi.geoManual, geoProvider: !gridApi.geoTyped, placeFor: gridApi.placeFor,
            }, angle, sat, true);
            if (row.plots) onField = { pure: row.plots.min, held: row.plotsRobust?.min ?? null };
          }
          cancelStake();
          exp.setPattern('block');
          exp.setBlockDesign(built.design);
          exp.setRotation(angle);
          setAdopted(null);
          if (sat.id !== gridApi.sourceId) gridApi.setSourceId(sat.id);
          if (area) setFieldBox(ground);
          // Show what was built: the trial on its seat in the field, the
          // middle of its area when that is a box.
          const [gE0, gN0, gE1, gN1] = utmEnvelope(ground, epsg);
          const [tE, tN] = fieldSeat(ring, ground, epsg, built.footprint[0], built.footprint[1], angle)?.centre ?? [(gE0 + gE1) / 2, (gN0 + gN1) / 2];
          const [hu, hv] = halfBox(built.footprint[0], built.footprint[1]);
          const [w, so] = toLngLat.forward([tE - hu, tN - hv]), [e, n] = toLngLat.forward([tE + hu, tN + hv]);
          mapRef.current?.fitBounds([[so, w], [n, e]], { padding: [60, 60], maxZoom: 21 });
        }
        setSuggestOutcome({ ...said, built, onField, area, ...(fitSearch ? { fit: { coarser, none: false } } : {}), ...(most ? { most } : {}),
          ...(angle !== askedAngle ? { alongField: true } : {}) });
      } catch (e) {
        setSuggestOutcome({ ...said, built: null, onField: null, area: null, error: e instanceof Error ? e.message : String(e) });
      } finally {
        finish();
      }
    }, 30);
  };
  /**
   * Alternating rows or columns: the thinnest strips that keep the pixels
   * asked for in every strip, over its length in the field, written to the
   * layout's own fields (strip width, spacing, angle) with the satellite they
   * were sized for.
   *
   * The page anchors a periodic planting on the field's corner and slides it
   * from there, so the strips are counted from that corner, and they are as
   * long as the field's outline lets them be. With no experiment area the page
   * makes one, four strips of each crop wide and as long as the strips need to
   * hold the count, in the middle of the map: its corner depends on its size,
   * which depends on the strips, so they are asked for again until the two
   * agree.
   */
  const buildStrips = (kind: 'row' | 'col' | 'checker', sat: Rung, epsg: number, centre: [number, number], angle: number) => {
    const r = sat.res;
    setSuggestBusy(true);
    window.setTimeout(() => {
      const ce90M = suggestAsk.hold ? Math.round(gridApi.ce90At(r, sat.id) * 100) / 100 : 0;
      // Where the page will then put what is built: for the pixels that hold within this satellite's CE90, or for the pure ones.
      const placeHeldM = gridApi.placeFor === 'held' ? Math.round(gridApi.ce90At(r, sat.id) * 100) / 100 : 0;
      // A strip is asked for by the pixels in the whole strip; a checkerboard's
      // cell is a plot, and is asked for by the plot's own count.
      const pixels = kind === 'checker' ? wantPure : suggestAsk.perStrip ?? PER_STRIP_DEFAULT;
      const said = { satId: sat.id, sat: sat.name, res: r, pixels, ce90M, threshold: exp.threshold, field: { u: 0, v: 0 }, angle, built: null, onField: null };
      // What the lines under the button are told, for strips or for cells.
      const told = (found: StripSuggestion | CheckerSuggestion | null) => (kind === 'checker'
        ? { cells: { found: found as CheckerSuggestion | null } }
        : { strips: { pattern: kind, found: found as StripSuggestion | null } });
      try {
        const def = crsToProj4Def(`EPSG:${epsg}`);
        const toUtm = proj4('EPSG:4326', def), toLngLat = proj4(def, 'EPSG:4326');
        const sized = { pixels, res: r, sigmaX: sat.sigmaX, sigmaY: sat.sigmaY, threshold: exp.threshold / 100, anyPosition: sat.anyPosition, placeHeldM, ce90M, spacing: suggestAsk.stripAlley ?? 0, rotationDeg: angle };
        // Counted where this satellite's pixel edges really fall: the field's
        // corner and outline are handed over in the lattice's own count, since
        // the search counts from zero (sensors.ts latticePhase; zero for most).
        const [pE, pN] = latticePhase(sat.id, r, epsg);
        const off = (q: [number, number]): [number, number] => (pE || pN ? [q[0] - pE, q[1] - pN] : q);
        const ask = (corner: [number, number], outline: [number, number][] | null): StripSuggestion | CheckerSuggestion | null => {
          const base = off(corner), ring = outline && outline.map(off);
          return kind === 'checker' ? suggestChecker({ ...sized, base }) : suggestStrips({ pattern: kind, ...sized, base, ring });
        };
        let found: ReturnType<typeof ask> = null, made: LngLatBounds | null = null;
        // In the field there is, its strips as long as its outline lets them be.
        if (aoi) found = ask(aoiUtmOrigin(aoi, epsg), fieldRing ? fieldRing.map(q => toUtm.forward(q) as [number, number]) : null);
        else {
          const [cE, cN] = toUtm.forward(centre);
          let base: [number, number] = [cE, cN];
          for (let pass = 0; pass < 5; pass++) {
            found = ask(base, null);
            if (!found) { made = null; break; }
            // Four strips of each crop across, and the length that holds the
            // count with room to spare: half as much again when the strips
            // cross the square at an angle.
            const half = Math.max(4 * found.pitchPx * r, 12 * r, 'lengthM' in found ? (Math.abs(angle % 90) < 1e-9 ? 0.5 : 0.75) * found.lengthM + 2 * r : 0);
            const corners = ([[cE - half, cN - half], [cE + half, cN - half], [cE + half, cN + half], [cE - half, cN + half]] as [number, number][])
              .map(q => toLngLat.forward(q) as [number, number]);
            made = [Math.min(...corners.map(q => q[0])), Math.min(...corners.map(q => q[1])), Math.max(...corners.map(q => q[0])), Math.max(...corners.map(q => q[1]))];
            const corner = aoiUtmOrigin(made, epsg);
            if (corner[0] === base[0] && corner[1] === base[1]) break;
            base = corner;
          }
        }
        let area: SuggestOutcome['area'] = null;
        if (found) {
          cancelStake();
          exp.setStripWidth(found.width);
          exp.setSpacing(found.spacing);
          exp.setRotation(angle);
          setAdopted(null);
          if (sat.id !== gridApi.sourceId) gridApi.setSourceId(sat.id);
          if (made) {
            setFieldBox(made);
            const [e0, n0, e1, n1] = utmEnvelope(made, epsg);
            area = { how: 'made', u: e1 - e0, v: n1 - n0 };
            mapRef.current?.fitBounds([[made[1], made[0]], [made[3], made[2]]], { padding: [60, 60], maxZoom: 21 });
          }
        }
        setSuggestOutcome({ ...said, area, ...told(found) });
      } catch (e) {
        setSuggestOutcome({ ...said, area: null, ...told(null), error: e instanceof Error ? e.message : String(e) });
      } finally {
        setSuggestBusy(false);
      }
    }, 30);
  };
  /**
   * The lines under the button stand only while the page still holds the trial
   * that was built. A plot-size row applied, a field typed or another satellite
   * picked afterwards, and they described a trial that was gone: "plots of
   * 10.5 x 11.5 m" over a design of 8.5 x 9.1.
   */
  const builtDesign = suggestOutcome?.built?.design;
  const builtStrips = suggestOutcome?.strips;
  const builtCells = suggestOutcome?.cells;
  // The satellite, the pixel size, the purity and the angle a build was made for.
  const sameSetting = !!suggestOutcome && exp.rotation === suggestOutcome.angle && suggestOutcome.satId === gridApi.sourceId && suggestOutcome.res === gridApi.pxSize
    && suggestOutcome.threshold === exp.threshold;
  // Strips and cells are both a width and a spacing in the layout's own fields.
  const holds = (f: { width: number; spacing: number } | null) => !f || (sameSetting && exp.stripWidth === f.width && exp.spacing === f.spacing);
  const outcomeStands = !suggestOutcome
    // Strips and cells are described under the layout they were built for, while its fields still hold them.
    || (builtStrips ? exp.pattern === builtStrips.pattern && holds(builtStrips.found)
      : builtCells ? exp.pattern === 'checker' && holds(builtCells.found)
      : exp.pattern === 'block' && (!builtDesign || (sameSetting
        && (['nSpecies', 'nBlocks', 'blocksPerRow', 'plotLength', 'plotWidth', 'plotAlley', 'blockAlley'] as const).every(k => builtDesign[k] === exp.blockDesign[k]))));
  const suggest = { ask: suggestAsk, setAsk: setSuggestAsk,
                    busy: suggestBusy, progress: suggestProgress, outcome: outcomeStands ? suggestOutcome : null, build: buildSuggested };

  // Only what `geoKey` needs; the panels read the rest straight off `exp`.
  const { layoutSig, sensorSig, cropSig } = exp;

  const simApi = useSimulation({ aoi, gridApi, exp, simOn: true, showPure, fieldOrigin });
  /**
   * What the export says about each pixel. Assigned here, each render, because
   * only the shell holds both halves: the grid hook that writes the file and
   * the simulation that knows which pixels to trust. Nothing is computed until
   * the button is pressed. With no simulation running the file is geometry
   * only, as it always was.
   */
  gridApi.exportAttrsRef.current = g => {
    if (!simApi.patternOrigin) return null;
    const v = pixelVerdicts(g, simApi.patternOrigin.origin, exp.layout, exp.sensor, gridApi.geoErrM);
    return [
      { name: 'PURE', values: v.pure },
      { name: 'COVER', values: v.cover },
      ...(v.robust ? [{ name: 'PURE_CE90', values: v.robust }] : []),
    ];
  };
  const { patternOrigin, simSummary } = simApi;

  // mapSim: when the PCA runs on the grid the map already simulated, it reuses that result.
  const pcaApi = usePcaSim({ aoi, fieldRing, gridApi, exp, patternOrigin, activeStep, compareAligned, compareFrom, mapSim: simApi.sim });

  // `layoutSig` stands in for the four layout segments this used to splice in
  // (pattern, width, spacing, rotation). Those move for none of a block
  // design's parameters, so a changed seed or plot size left the previous trial
  // on the map: react-leaflet only repaints when this key changes.
  const geoKey = renderGrid
    ? `${renderGrid.epsg}-${renderGrid.res}-${renderGrid.utmBounds.join(',')}-${basemap}-sim-${layoutSig}-${sensorSig}-${cropSig}`
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
                      areaSummary, gridSummary, simSummary, geoKey,
                      simSection, setSimSection, blurOpen, setBlurOpen, pcaRetuneOpen, setPcaRetuneOpen,
                      compareAligned, setCompareAligned, ladderView, setLadderView, compareFrom, setCompareFrom, setAngleByHand, setActiveStep,
                      pcaColorBy, setPcaColorBy, pcaShapeBy, setPcaShapeBy, importApi, curvesOpen, setCurvesOpen,
                      wantPure, setWantPure, mostUndo, setMostUndo, suggest };

  return (
    <div className="flex h-full w-full bg-[#050505] text-neutral-200 font-sans">
      {/* Map */}
      <FieldMap
        mapRef={mapRef} initialCenter={initialView.center} initialZoom={initialView.zoom} onView={saveView}
        basemap={basemap} setBasemap={setBasemap}
        showField={showField} setShowField={setShowField}
        showSigmas={showSigmas} setShowSigmas={setShowSigmas}
        showSources={showSources} setShowSources={setShowSources}
        fieldOnly={fieldOnly} setFieldOnly={setFieldOnly}
        showPure={showPure} setShowPure={setShowPure}
        geoKey={geoKey}
        area={area} gridApi={gridApi} exp={exp} sim={simApi} pca={pcaApi}
      />

      {/* Sidebar */}
      <aside className="relative flex shrink-0 flex-col border-l border-white/10 bg-[#11151a] text-slate-200" style={{ width: panelW }}>
        {/* Drag the left edge to widen the panel */}
        <div onPointerDown={startResize} title="Drag to resize"
          className="absolute inset-y-0 -left-1 z-[1200] w-2 cursor-col-resize hover:bg-sky-500/40" />
        <header className="shrink-0 border-b border-white/10 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-[15px] font-semibold text-white">Pixel Grid Designer</h1>
            <div className="flex shrink-0 items-center gap-1.5">
            {/* What every figure of the page means, on a page of its own: the one link to it, and the panel explains nothing. */}
            <a href={DOCS_PAGE} target="_blank" rel="noopener noreferrer" title="What the page computes, and what every figure means"
              className="rounded-md border border-white/10 px-2 py-1 text-[14px] text-slate-400 transition-colors hover:border-white/25 hover:text-slate-200">
              Docs
            </a>
            <button type="button"
              onClick={() => (confirmReset ? resetSavedState() : setConfirmReset(true))}
              title="Clear the field and all settings (your pinned field stays)"
              className={`rounded-md border px-2 py-1 text-[14px] transition-colors ${confirmReset ? 'border-amber-400/60 bg-amber-500/15 text-amber-200' : 'border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200'}`}>
              {confirmReset ? 'Click again to reset' : 'Reset'}
            </button>
            {!STANDALONE && (
              <a
                href="./"
                title="Back to the Polygon Time-Series PCA app"
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-[14px] text-sky-300 transition-colors hover:bg-sky-500/20"
              >
                <Layers className="h-3 w-3" /> Polygon PCA
              </a>
            )}
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
        <AreaStep {...stepProps} />

        {SHOW_GRID_STEP && <GridStep {...stepProps} />}

        <SimStep {...stepProps} />

        <PcaStep {...stepProps} />

        </div>

      </aside>
    </div>
  );
}
