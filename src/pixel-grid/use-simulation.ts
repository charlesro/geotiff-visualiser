import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import {
  BARE, CROP_COLORS, strideFieldSim, geolocationSpread, CROP_PRESETS, PATTERNS, TRUTH_TYPES, bestPhaseOffset, cropById, makeBetaSchedule, simulateField,
  truthAt, utmEnvelope, TMAX, coverStats, speciesChannel, meanPerSpecies,
  blockPlacement, layoutKey, plantedAreaPx, stakeBlockPlan,
  type BlockDesign, type FieldParams, type FieldSim, type PatternType, type SensorParams, type SimLayout,
} from './simulate';
import { contrastInfo, plantedPixels } from './resolving';
import { aoiUtmOrigin, buildS2Grid, type LngLatBounds, type S2Grid } from './s2-grid';
import { fieldOverlapTest, type Poly } from './geometry';
import { cellInFieldTest } from './field-membership';
import { categoricalColors, distinctColors, mixN } from './util';
import { PCA_SAMPLE, RES_LADDER } from './sensors';
import { pixelId } from './pca-field';
import { importedTrialExtent, trialExtent } from './ladder';
import { ladderKey, rungCellOrigin } from './ladder-rung';
import type { SweepStep } from './PcaSweep';
import type { useFieldGrid } from './use-grid';
import { arrayOf, inRange, isLngLat, isNum, oneOf, readSaved, shape, usePersistentState } from './persist';
import { MAX_IMPORT_PLOTS, tooManyVarieties, varietiesOf } from './design-import';
import { resolveImportedPlan } from './imported-plan';
import { isAligned, nearestTurn, rotateImportedPlan, shiftImportedPlan, stakeOnGrid, trialAngle } from './imported-rotate';
import type { ImportedDesign, ImportedPlan } from './imported-types';

/**
 * Largest field one ladder rung simulates whole; beyond it a central window of
 * this many pixels stands in, and the panel is flagged with a circle.
 *
 * This is a budget for a THUMBNAIL, not for an answer. A rung is 92 pixels tall
 * and draws at most 500 dots, so simulating tens of thousands to choose them is
 * oversampling by two orders of magnitude, and it is paid 18 times over when the
 * aligned comparison is on: measured on a 300-plot trial, building both ladders
 * cold blocked the main thread for 3.9 s in nine visible janks, which reads as
 * the page freezing. simulateField is 72 of the 90 ms of a 40,000-pixel rung, so
 * the cost is very nearly linear in this number.
 *
 * Small trials are unaffected: under the cap a rung is exact and carries no
 * flag. It binds only at the fine end of the ladder over a large field, where
 * the rung was already an estimate over a central window and said so.
 *
 * Not lower than this, because the window is a sample and its size is the
 * sample's noise. Measured against a 40,000-pixel window on a 40-variety block
 * trial, 12,000 moved a rung's purity by up to 2.1 points and the gap between
 * the two ladders by 1.2; 20,000 halves that, which keeps it under the tie band
 * the comparison is judged on (TIE_POINTS in PcaStep). A cheaper thumbnail is
 * not worth a verdict that sampling could flip.
 */
const LADDER_MAX_CELLS = 20_000;

/**
 * Plants slide to the phase that leaves the most pure pixels (strip edges on
 * pixel edges; a block trial is snapped by buildBlockPlan instead).
 *
 * Always on, and a module CONSTANT rather than state: the switch left the UI,
 * and what was left was a `useState(true)` with no setter anywhere, a returned
 * value nothing could change, and a segment of the map's cache key that could
 * never move. It stays named, and read where the choice is made, so turning it
 * back into a control is one line here rather than a hunt through three memos.
 */
const OPTIMIZE_PLACEMENT = true;

/** A restored crop must still be a usable curve, not whatever happened to be stored. */
const isFieldParams = (v: unknown): v is FieldParams => {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return typeof f.name === 'string'
    && typeof f.color === 'string' && /^#[0-9a-f]{6}$/i.test(f.color)
    && TRUTH_TYPES.some(t => t.id === f.truth)
    && ['L1', 'k1', 'x01', 'k2', 'x02', 'tc'].every(k => isNum(f[k]));
};
const isPreset = (v: unknown) => typeof v === 'string' && (v === 'custom' || CROP_PRESETS.some(c => c.id === v));
const isStr = (v: unknown): v is string => typeof v === 'string';
const isHex = (v: unknown) => isStr(v) && /^#[0-9a-f]{6}$/i.test(v);
/**
 * A saved imported design. The reader validated the geometry on the way in, so
 * this checks the SHAPE the page relies on (rings of finite [lng, lat], text
 * attributes, the column names), not the geography: a save that fails simply
 * leaves no trial loaded.
 */
const isImportedDesign = (v: unknown) => v === null || shape({
  fileName: isStr,
  plots: arrayOf(shape({
    rings: arrayOf(arrayOf(isLngLat, 3), 1),
    props: (p: unknown) => !!p && typeof p === 'object' && !Array.isArray(p) && Object.values(p as object).every(isStr),
  }), 1, MAX_IMPORT_PLOTS),
  columns: arrayOf(isStr),
  varietyColumn: isStr,
  nameColumn: isStr,
  warnings: arrayOf(isStr),
})(v);

/** One imported variety's editor choices: its preset, and a curve or colour the user set. */
interface ImportedCurve { preset: string; crop?: FieldParams; color?: string }
const isCurveMap = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.values(v as object).every(e => {
    if (!e || typeof e !== 'object') return false;
    const c = e as Record<string, unknown>;
    return isPreset(c.preset) && (c.crop === undefined || isFieldParams(c.crop)) && (c.color === undefined || isHex(c.color));
  });

type GridApi = ReturnType<typeof useFieldGrid>;

/**
 * Steps 3 and 4: the planting design, what a sensor makes of it, and the PCA.
 *
 * Three hooks rather than one, because they have genuinely different lifetimes.
 * The experiment PARAMETERS are cheap and always live. The field SIMULATION is
 * viewport-clipped and only runs while a sim step is open. The PCA runs on the
 * FIELD, never the viewport, and defers itself behind a timeout so a spinner
 * can paint first.
 *
 * Load-bearing, and very easy to "tidy" into a performance bug:
 *
 *  - `layout` and `sensor` are fresh object literals on every render and are
 *    deliberately absent from every dependency array; the primitives plus
 *    `sensorSig` stand in for them. Memoize them and add them to deps, and
 *    `simulateField` re-runs on every render: a few-hundred-millisecond freeze
 *    per keystroke, byte-identical output, invisible to every gate.
 *  - `patternOrigin` is computed exactly ONCE, here, and shared by the map
 *    overlay, the canvas visual, the field sim and the PCA. A second copy makes
 *    the drawn pattern drift from the simulated one.
 *  - `runSweep`'s deps are all primitives on purpose: pass an object and the
 *    250 ms debounce re-arms every render, so the sweep never settles.
 *  - `simStyle` / `fieldOutlineStyle` are re-created per render on purpose:
 *    react-leaflet will not restyle on a prop change, so `geoKey` (assembled in
 *    the shell) is what actually repaints.
 */

/** Planting design, crop curves and noise. Sigma is owned by step 2 and passed in. */
export function useExperiment({ sigmaX, sigmaY, psfOffX, psfOffY, fieldBounds, fieldOrigin, pixelSize, epsg }: {
  sigmaX: number; sigmaY: number; psfOffX: number; psfOffY: number;
  /**
   * The grid's snapped UTM extent and the pattern origin. A block design is a
   * FINITE trial: it has to be anchored on the field, in the frame the ENGINE
   * samples, and snapped to the real pixel lattice. Both come from `build`, and
   * `fieldOrigin` is the SAME corner `patternOrigin` uses, computed once in the
   * shell rather than here, so the drawn trial and the simulated one cannot
   * drift. The plan is resolved HERE, once, next to the layout it belongs to;
   * building it anywhere else would give the map a second copy, and a plan
   * resolved from a different extent draws one trial while the purity, the
   * ladder and the PCA describe another, with no error anywhere.
   */
  fieldBounds: [number, number, number, number] | null;
  fieldOrigin: [number, number] | null;
  pixelSize: number;
  /** The grid's UTM CRS: an imported trial is resolved into it. */
  epsg: number | null;
}) {
  // Experiment simulation (repo parameter set)
  const [pattern, setPattern] = usePersistentState<PatternType>('pattern', 'row', oneOf(...PATTERNS.map(p => p.id)));
  const [stripWidth, setStripWidth] = usePersistentState('stripWidth', 3, inRange(0.01, 1000));
  const [spacing, setSpacing] = usePersistentState('spacing', 0, inRange(0, 1000));
  const [rotation, setRotation] = usePersistentState('rotation', 0, inRange(0, 90));
  /**
   * The species under test, 2 to 8 of them. Stored as ONE array under new keys
   * rather than cropA/cropB, which could only ever describe two.
   *
   * Migration is a LAZY INITIALISER, never a mount effect: an effect that wrote
   * on mount would overwrite the very value it was meant to restore (the trap
   * that cost the sigma reset). readSaved returns undefined when a stored value
   * fails its validator, so an old or hand-edited save falls back to the pair
   * below instead of reaching the engine.
   */
  const [species, setSpecies] = usePersistentState<FieldParams[]>('species',
    () => {
      const a = readSaved<FieldParams>('cropA', isFieldParams) ?? cropById('maize');
      const b = readSaved<FieldParams>('cropB', isFieldParams) ?? cropById('wheat');
      return [a, b];
    }, arrayOf(isFieldParams, 2, 8));
  const [presets, setPresets] = usePersistentState<string[]>('presets',
    () => [readSaved<string>('presetA', isPreset) ?? 'maize', readSaved<string>('presetB', isPreset) ?? 'wheat'],
    arrayOf(isPreset, 2, 8));

  /**
   * Write one species by INDEX.
   *
   * The stored list can be SHORTER than the design asks for: two species saved
   * against a four-species trial is the normal state, with the rest padded in
   * for drawing. So an edit to species 3 has to materialise that padding into
   * the stored array first, or it would write past the end and leave a hole
   * where a crop should be. Both setters pad the same way `speciesActive` does,
   * so what you edit is exactly what the map was already showing you.
   */
  const padTo = <T,>(arr: T[], n: number, fill: (i: number) => T): T[] => {
    const out = arr.slice(0, Math.max(arr.length, n));
    for (let i = out.length; i < n; i++) out.push(fill(i));
    return out;
  };
  const setSpeciesAt = useCallback((i: number, c: FieldParams) => setSpecies(s => {
    const out = padTo(s, i + 1, k => ({ ...CROP_PRESETS[k % CROP_PRESETS.length] }));
    out[i] = c;
    return out;
  }), [setSpecies]);
  const setPresetAt = useCallback((i: number, id: string) => setPresets(p => {
    const out = padTo(p, i + 1, k => CROP_PRESETS[k % CROP_PRESETS.length].id);
    out[i] = id;
    return out;
  }), [setPresets]);

  const [magnitude, setMagnitude] = usePersistentState('magnitude', 0.04, inRange(0, 0.15));
  const [alpha, setAlpha] = usePersistentState('alpha', 2, inRange(0.1, 10));
  const [beta, setBeta] = usePersistentState('beta', 2, inRange(0.1, 10));
  // 100% by default: a pixel counts as pure only if it is entirely one crop.
  // The repo engine's own default is 80%, which flatters the design: it calls a
  // pixel "pure maize" when a fifth of it is wheat. Start strict; the slider in
  // "Noise & purity threshold" relaxes it.
  const [threshold, setThreshold] = usePersistentState('threshold', 100, inRange(50, 100));

  /**
   * The randomised block design. Persisted under its own key and validated
   * field by field: a stale or hand-edited save must fall back to the default
   * rather than reach the geometry, where a NaN plot width would quietly
   * produce a trial with no plots in it.
   */
  const [blockDesign, setBlockDesign] = usePersistentState<BlockDesign>('blockDesign',
    () => ({ nSpecies: 4, nBlocks: 4, plotLength: 8, plotWidth: 2, plotAlley: 0.5, blockAlley: 1.5, blocksPerRow: 1, seed: 1 }),
    shape({
      nSpecies: inRange(2, 8), nBlocks: inRange(1, 20),
      plotLength: inRange(0.1, 1000), plotWidth: inRange(0.1, 1000),
      plotAlley: inRange(0, 100), blockAlley: inRange(0, 100),
      blocksPerRow: inRange(1, 20), seed: isNum,
    }));

  /**
   * A trial uploaded as a file (layout "Imported trial"). Each value of its
   * variety column is its own species, and the plots sharing a value are that
   * variety's repetitions. Persisted so a refresh keeps the trial.
   */
  /**
   * `importedDesignSaved` is false when the browser refused to store it, which
   * is two different situations and the page tells them apart (saveRefusal in
   * persist.ts, read by the shell). A trial is the whole geometry of up to 5,000
   * plots and can pass the quota on its own, while the companion keys (the turn,
   * the shift, the field it set) are small enough to save WHEN THE STORE IS
   * SAVING ANYTHING; in a private window or with storage switched off, nothing
   * is kept and those keys are just as lost. persist.ts drops the stale design
   * rather than let an older trial come back under this one's field.
   */
  const [importedDesign, setImportedDesign, importedDesignSaved] = usePersistentState<ImportedDesign | null>('importedDesign', null, isImportedDesign);
  /**
   * What the editor set per variety, by variety KEY rather than position, so
   * switching the variety column and back loses nothing. A variety with no
   * entry grows the crop the reader detected, in its own generated colour.
   */
  const [importedCurves, setImportedCurves] = usePersistentState<Record<string, ImportedCurve>>('importedCurves', {}, isCurveMap);
  const varieties = useMemo(() => (importedDesign ? varietiesOf(importedDesign) : []), [importedDesign]);
  const importing = pattern === 'imported' && varieties.length > 0;

  // ----- experiment simulation (repo engine over the real grid) -----
  /**
   * The design resolved against THIS field, built exactly once. Everything that
   * draws or measures the trial reads this same object off `layout.block`, so
   * the map and the numbers cannot describe different trials. Keyed on the
   * primitives rather than the design object, which is a fresh literal whenever
   * any field changes.
   */
  const blockPlan = useMemo(() => {
    if (pattern !== 'block' || !fieldBounds || !fieldOrigin) return undefined;
    // The conversion into the engine's (u,v) frame lives in simulate.ts, not
    // here: a copy inlined in this hook is one the regression suite cannot run.
    // An ALIGNED trial is staked on the sub-pixel offset that actually yields
    // the most pure pixels, not merely corner-snapped: the snap is one arbitrary
    // phase and is only a good one where plot and alley are whole pixels (see
    // stakeBlockPlan). At any other angle there is no phase to choose and this
    // returns the same plan the snap would have. The sensor is part of it
    // because the answer depends on the blur, so it is in the deps too.
    const place = blockPlacement(fieldBounds, fieldOrigin, rotation, pixelSize, OPTIMIZE_PLACEMENT);
    const sen: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100, offX: psfOffX, offY: psfOffY };
    return stakeBlockPlan(blockDesign, place, fieldOrigin, rotation, pixelSize, sen, fieldBounds).plan;
  }, [pattern, fieldBounds?.join(','), fieldOrigin?.[0], fieldOrigin?.[1], rotation, pixelSize,
      sigmaX, sigmaY, psfOffX, psfOffY, threshold,
      blockDesign.nSpecies, blockDesign.nBlocks, blockDesign.plotLength, blockDesign.plotWidth,
      blockDesign.plotAlley, blockDesign.blockAlley, blockDesign.blocksPerRow, blockDesign.seed]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The uploaded design in THIS grid's metres, resolved once and shared the way
   * a block plan is. What stops it (too many varieties in the chosen column, a
   * plot that does not project) is the user's to see, so it is returned as an
   * error rather than turned into a silently empty trial.
   */
  const imported = useMemo((): { plan?: ImportedPlan; error?: string } => {
    if (pattern !== 'imported' || !importedDesign || !epsg) return {};
    const tooMany = tooManyVarieties(importedDesign);
    if (tooMany) return { error: tooMany };
    try {
      return { plan: resolveImportedPlan(importedDesign, varieties, epsg) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [pattern, importedDesign, varieties, epsg]);

  /**
   * An extra turn given to the imported trial about its centre, in degrees; 0
   * is the trial as the file draws it. The angle control shows the trial's
   * resulting angle to the pixel rows, so setting it to 0 lines the plots up
   * with them. Kept apart from `rotation`, which belongs to the generated
   * layouts: switching to an imported trial must not turn it by whatever angle
   * the strips last had.
   */
  const [importedTurn, setImportedTurn] = usePersistentState('importedTurn', 0, inRange(-45, 45));
  /**
   * Where the turned trial was staked, in metres: the shift that put its plots
   * on the pixel grid, decided ONCE when the angle was set (PixelGridApp) and
   * kept here. Deciding it in this memo instead would move the trial after the
   * page had already set the field outline from it, so the plots hung outside
   * their own field; and it would re-stake, and move, on every resolution click.
   */
  const [importedShift, setImportedShift] = usePersistentState<[number, number]>('importedShift', [0, 0],
    v => Array.isArray(v) && v.length === 2 && v.every(isNum));
  const importedFileAngle = useMemo(() => (imported.plan ? trialAngle(imported.plan) : 0), [imported.plan]);
  /** The trial as drawn, turned, and moved to where it was staked. A pure function of what is saved. */
  const importedPlan = useMemo(() => {
    if (!imported.plan) return undefined;
    return shiftImportedPlan(rotateImportedPlan(imported.plan, importedTurn), importedShift[0], importedShift[1]);
  }, [imported.plan, importedTurn, importedShift[0], importedShift[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const importedAngle = (((importedFileAngle + importedTurn) % 90) + 90) % 90;

  const layout: SimLayout = { pattern, width: stripWidth, spacing, rotationDeg: rotation, block: blockPlan, imported: importedPlan };
  /**
   * Every layout dependency in one string, including the resolved corner. The
   * memo deps, the map's remount key and the overlay's effect deps take THIS
   * instead of hand-listing primitives: a field forgotten in one of those lists
   * shows a stale design with no error, no type failure and no failing test.
   */
  const layoutSig = layoutKey(layout);
  const sensor: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100, offX: psfOffX, offY: psfOffY };
  // Every primitive the sensor depends on: `sensor` itself is a fresh literal each
  // render and is deliberately kept out of dependency arrays, so this string is
  // what tells the memos the PSF changed. Miss the offsets here and the page
  // keeps showing the purity it computed for a centred kernel.
  const sensorSig = `${sigmaX}_${sigmaY}_${threshold}_${psfOffX}_${psfOffY}`;

  /**
   * The species as everything downstream should DRAW them: one distinct colour
   * each, and a suffix when two share a name. Two entries on the same preset
   * (maize compared against maize with one parameter changed) would otherwise
   * be drawn and labelled identically on the map, in the scatter and in every
   * legend. Decided in exactly one place, so those three cannot drift apart.
   * Curves are never touched: only colour and label.
   */
  /**
   * How many species the CURRENT design actually needs.
   *
   * The block design drives the simulation, so its species count is the master
   * and the editable list follows it. Without this the two disagree silently: a
   * four-species trial runs with two species defined, the map legend draws a
   * 50/50 gradient for a design that has no such mixture, and the overlay falls
   * back to raw palette colours for species nobody has named.
   *
   * Species beyond the edited list are filled from the presets rather than
   * invented, so a freshly raised species count arrives with real growth curves
   * instead of copies of species 0.
   */
  const nActive = importing ? varieties.length : pattern === 'block' ? Math.max(2, Math.min(8, blockDesign.nSpecies)) : 2;
  // An imported trial can carry dozens of varieties, far past the eight preset
  // colours, and many share one preset (forty wheats): colour by position.
  const importPalette = useMemo(() => categoricalColors(varieties.length, CROP_COLORS), [varieties.length]);
  const speciesActive = useMemo<FieldParams[]>(() => {
    if (importing) {
      return varieties.map((v, i) => {
        const e = importedCurves[v.key];
        return { ...(e?.crop ?? cropById(v.crop)), name: v.label, color: e?.color ?? importPalette[i] };
      });
    }
    const out = species.slice(0, nActive);
    while (out.length < nActive) out.push({ ...CROP_PRESETS[out.length % CROP_PRESETS.length] });
    return out;
  }, [species, nActive, importing, varieties, importedCurves, importPalette]);
  /**
   * The preset ids, padded by the SAME rule. A padded species is a real preset,
   * so labelling it "Custom" in the editor would be a plain untruth, and padding
   * it a second way inside the control would leave two definitions of what
   * padding means, free to drift apart.
   */
  const presetsActive = useMemo<string[]>(() => {
    if (importing) return varieties.map(v => importedCurves[v.key]?.preset ?? v.crop);
    const out = presets.slice(0, nActive);
    while (out.length < nActive) out.push(CROP_PRESETS[out.length % CROP_PRESETS.length].id);
    return out;
  }, [presets, nActive, importing, varieties, importedCurves]);

  const colorSig = speciesActive.map(s => s.color).join(',');
  const nameSig = speciesActive.map(s => s.name).join('|');
  const colors = useMemo(() => distinctColors(speciesActive.map(s => s.color), CROP_COLORS), [colorSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = useMemo(() => {
    const count = new Map<string, number>();
    speciesActive.forEach(s => count.set(s.name, (count.get(s.name) ?? 0) + 1));
    const seen = new Map<string, number>();
    return speciesActive.map(s => {
      if ((count.get(s.name) ?? 0) < 2) return s.name;
      const k = seen.get(s.name) ?? 0;
      seen.set(s.name, k + 1);
      return `${s.name} (${String.fromCharCode(65 + k)})`;
    });
  }, [nameSig]); // eslint-disable-line react-hooks/exhaustive-deps
  // Memoised, and returning the ORIGINAL object when nothing had to change, so
  // the memoised chart components can still skip redrawing.
  const speciesD = useMemo<FieldParams[]>(
    () => speciesActive.map((s, i) => (s.color === colors[i] && s.name === names[i] ? s : { ...s, color: colors[i], name: names[i] })),
    [speciesActive, colors, names]);


  const fsig = (c: FieldParams) => `${c.truth}_${c.L1}_${c.k1}_${c.x01}_${c.k2}_${c.x02}_${c.tc}`;
  /**
   * Every species' drawn colour and curve in one string: the memo key for
   * anything that redraws when a crop changes. Hashes the WHOLE array, so
   * editing the third species is not a silent no-op.
   */
  const cropSig = `${colors.join('')}-${speciesActive.map(fsig).join('-')}`;

  /**
   * The species editors' write path. The periodic and block layouts keep their
   * stored list of two to eight; an imported trial writes that variety's entry,
   * by key. A curve edit (a preset or a parameter) keeps the variety's colour,
   * and a colour edit keeps its curve, so neither undoes the other.
   */
  const setSpeciesAtAny = useCallback((i: number, c: FieldParams) => {
    if (!importing) { setSpeciesAt(i, c); return; }
    const v = varieties[i], cur = speciesActive[i];
    if (!v || !cur) return;
    const colourOnly = fsig(c) === fsig(cur) && c.color.toLowerCase() !== colors[i]?.toLowerCase();
    setImportedCurves(m => {
      const e: ImportedCurve = m[v.key] ?? { preset: v.crop };
      return { ...m, [v.key]: colourOnly ? { ...e, color: c.color } : { ...e, crop: { ...c, name: v.label } } };
    });
  }, [importing, varieties, speciesActive, colors, setSpeciesAt, setImportedCurves]); // eslint-disable-line react-hooks/exhaustive-deps
  const setPresetAtAny = useCallback((i: number, id: string) => {
    if (!importing) { setPresetAt(i, id); return; }
    const v = varieties[i];
    if (!v) return;
    setImportedCurves(m => ({ ...m, [v.key]: { ...(m[v.key] ?? {}), preset: id } }));
  }, [importing, varieties, setPresetAt, setImportedCurves]);

  return { pattern, setPattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation,
           species, setSpecies, presets, setPresets, colors, names, speciesD, nActive,
           presetsActive, setSpeciesAt: setSpeciesAtAny, setPresetAt: setPresetAtAny,
           importedDesign, setImportedDesign, importedDesignSaved, importedCurves, setImportedCurves, varieties,
           importedPlan, importedBasePlan: imported.plan, importedError: imported.error,
           importedTurn, setImportedTurn, importedShift, setImportedShift, importedFileAngle, importedAngle,
           magnitude, setMagnitude,
           alpha, setAlpha, beta, setBeta, threshold, setThreshold,
           blockDesign, setBlockDesign, blockPlan,
           layout, layoutSig, sensor, sensorSig, cropSig };
}

export type Experiment = ReturnType<typeof useExperiment>;

/** What the chosen sensor makes of the design, over the rendered grid. */
export function useSimulation({ aoi, gridApi, exp, simOn, fieldOrigin }: {
  aoi: LngLatBounds | null;
  /**
   * No field ring here: which pixels are in the field is decided once in
   * use-grid and arrives as `gridApi.inField`, so the overlay cannot answer it
   * differently from the count, the export and the PCA.
   */
  gridApi: GridApi; exp: Experiment; simOn: boolean;
  /** The field corner, computed once in the shell and shared with useExperiment. */
  fieldOrigin: [number, number] | null;
}) {
  const { renderGrid, build, inField, geoErrM } = gridApi;
  const { pattern, stripWidth, spacing, rotation, threshold, layout, layoutSig, sensor,
          sensorSig, magnitude, alpha, beta, speciesD, colors, cropSig } = exp;

  // Pattern origin: the field corner, optionally slid to the phase that maximises
  // pure pixels (strip edges land on pixel edges). `offset` = [along-row, cross-row] m.
  const patternOrigin = useMemo((): { origin: [number, number]; offset: [number, number] } | null => {
    if (!aoi || !build?.epsg || !fieldOrigin) return null;
    // The SAME corner the block plan was anchored on. Recomputing it here would
    // be two sources for one number, which is how the drawn and the simulated
    // pattern drift apart.
    const base = fieldOrigin;
    if (!OPTIMIZE_PLACEMENT) return { origin: base, offset: [0, 0] };
    // The sensor is passed so the phase is chosen for the blur this page
    // simulates: a sharp optimum is the blurred worst (see searchPhaseOffset).
    const [du, dv] = bestPhaseOffset(pattern, build.res, stripWidth, spacing, threshold / 100, base[0], base[1], sensor);
    const t = (rotation * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    return { origin: [base[0] + du * cos - dv * sin, base[1] + du * sin + dv * cos] as [number, number], offset: [du, dv] as [number, number] };
    // layoutSig rather than the loose primitives: it also covers the block
    // design, whose seed, plot size and alleys move none of them.
  }, [aoi, build?.epsg, build?.res, layoutSig, sensorSig, fieldOrigin?.[0], fieldOrigin?.[1]]);

  const sim = useMemo(
    () => (simOn && renderGrid && patternOrigin ? simulateField(renderGrid, patternOrigin.origin, layout, sensor) : null),
    [simOn, renderGrid, patternOrigin, pattern, stripWidth, spacing, rotation, sensorSig],
  );

  /**
   * What the purity would be if the imagery is not exactly where it says it is.
   *
   * Every other number on this page assumes the product's pixels land on their
   * nominal lattice. Real ones are offset by a few metres, which at these pixel
   * sizes is a large part of one pixel, and the design cannot be moved to
   * compensate because the offset is not known when the trial is planted. So
   * the useful answer is a range rather than a figure: a design whose purity
   * swings ten points on where the imagery happens to fall is fragile, however
   * good the number it reports.
   *
   * On an IDLE pass, never in the render: it is one full simulation per sample,
   * 200 ms to 800 ms for sixteen of them, and it qualifies a number rather than
   * producing one. Until it lands the card shows the nominal purity alone.
   */
  const [geoSpread, setGeoSpread] = useState<ReturnType<typeof geolocationSpread>>(null);
  useEffect(() => {
    if (!simOn || !renderGrid || !patternOrigin || !(geoErrM > 0)) { setGeoSpread(null); return; }
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      setGeoSpread(geolocationSpread(renderGrid, patternOrigin.origin, layout, sensor, geoErrM, 4));
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const id = w.requestIdleCallback ? w.requestIdleCallback(run, { timeout: 2000 }) : window.setTimeout(run, 400);
    return () => { cancelled = true; if (!w.requestIdleCallback) clearTimeout(id); };
  }, [simOn, renderGrid, patternOrigin, layoutSig, sensorSig, geoErrM]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The season every species records, plus what one mixed pixel records.
   *
   * The mixture is weighted by what the sensor ACTUALLY sees over trial pixels:
   * each species (meanBySpecies) and, like a crop of its own, the bare alley soil
   * that makes up the rest. The PCA builds every pixel's season the same way,
   * so the dashed curve and the scatter now describe one model. Leaving the soil
   * out overstated the mixed pixel's greenness on any design with alleys. With
   * no alleys the soil share is zero and the curve is the one it always was.
   *
   * Each species gets its own `s{i}` key so the chart can draw n lines, and the
   * soil its own flat `soil` curve; `A` and `B` remain as aliases for the
   * two-species readers.
   */
  const ndviSeries = useMemo(() => {
    if (!simOn) return null;
    const n = Math.max(1, speciesD.length);
    const mean = sim && sim.meanBySpecies.length >= n ? Array.from(sim.meanBySpecies).slice(0, n) : null;
    const tot = mean ? mean.reduce((a, b) => a + b, 0) : 0;
    // Soil is whatever the species leave. Clamped: rounding can push the species
    // total a hair past 1 on a design with no alleys at all.
    const soilW = mean && tot > 1e-9 ? Math.max(0, 1 - tot) : 0;
    const w = mean && tot > 1e-9
      ? mean.map(v => v / (tot + soilW))
      : n === 2
        ? [sim?.meanPropA ?? 0.5, 1 - (sim?.meanPropA ?? 0.5)]
        : new Array(n).fill(1 / n);
    const soilShare = mean && tot > 1e-9 ? soilW / (tot + soilW) : 0;
    const varSched = makeBetaSchedule(TMAX, alpha, beta, magnitude);
    const pts: Record<string, number>[] = [];
    for (let d = 0; d <= 365; d += 5) {
      const vals = speciesD.map(s => truthAt(s, d));
      let mix = soilShare * BARE.ndvi;
      for (let i = 0; i < n; i++) mix += w[i] * vals[i];
      const vmax = Math.max(0, mix * (1 - mix));
      const sd = Math.sqrt(Math.min(varSched[d] ?? 0, vmax));
      const row: Record<string, number> = {
        day: d, mix: +mix.toFixed(3), soil: BARE.ndvi,
        lo: +Math.max(0, mix - sd).toFixed(3), hi: +Math.min(1, mix + sd).toFixed(3),
      };
      vals.forEach((v, i) => { row[`s${i}`] = +v.toFixed(3); });
      row.A = row.s0; row.B = row.s1 ?? row.s0;
      pts.push(row);
    }
    return pts;
  }, [simOn, sim, cropSig, speciesD.length, magnitude, alpha, beta]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Sim cell colour by view mode (no per-cell borders, which read as noise).
   *
   * `sp` is the cell's real per-species composition. Without it the rest of the
   * pixel was inferred as `1 - f - bare` and handed to a two-colour blend, which
   * lumps EVERY species after the first into "crop B": a four-species trial was
   * drawn as a two-crop mixture, plausibly and wrongly. mixN is the one blend in
   * the codebase, shared with the map legend, so they cannot disagree.
   */
  const simStyle = (f: number, bare: number, sp?: number[], off = 0) => {
    const fr = sp && sp.length ? sp : [f, Math.max(0, 1 - f - bare)];
    // The off-trial fraction is a WEIGHT, not a leftover. Without it a pixel
    // outside the trial has an all-zero species vector, mixN skips every zero,
    // and the blend divides by `w || 1` and paints it solid black. On a block
    // design that is most of the field.
    //
    // There used to be a purity view and an NDVI view here, chosen by a `simView`
    // state that nothing could ever change: no control set it, so two thirds of
    // this function could not run. They are in the history if they are wanted
    // back, with a control to reach them.
    const color = mixN(fr, colors, bare, off);
    return { stroke: true, color: '#000', weight: 0.6, opacity: 0.55, fillColor: color, fillOpacity: 0.8, interactive: false } as L.PathOptions;
  };
  /** "Real field" mode: transparent cells (the true pattern shows through) with
   *  just the grid outline. */
  const fieldOutlineStyle = () =>
    ({ stroke: true, color: '#0b0e11', weight: 1.6, opacity: 0.9, fill: false, interactive: false }) as L.PathOptions;
  const simGeojson = useMemo(() => {
    if (!sim || !renderGrid) return null;
    const nSp = sim.nSpecies;
    const spAll = sim.proportionBySpecies;
    const offAll = sim.proportionOffTrial;
    const features = [];
    // The pixels overlapping the field, by the one rule the page uses, decided
    // once for this grid in use-grid rather than clipped per cell a third time.
    const keep = inField && inField.grid === renderGrid ? inField.mask : null;
    for (let k = 0; k < renderGrid.cells.length; k++) {
      const c = renderGrid.cells[k];
      if (keep && !keep[k]) continue;
      // The cell's own species composition travels WITH it. Reconstructing it at
      // paint time from a single "crop A fraction" is what limited the overlay
      // to two species.
      const sp = spAll ? Array.from(spAll.subarray(k * nSp, k * nSp + nSp)) : undefined;
      features.push({
        type: 'Feature' as const,
        // col/row identify the pixel, so "In field only" can hide it by the same
        // key the in-field pixel list uses.
        properties: { col: c.col, row: c.row, f: sim.proportionA[k], b: sim.proportionBare[k], sp, off: offAll ? offAll[k] : 0 },
        geometry: { type: 'Polygon' as const, coordinates: [c.ring] },
      });
    }
    return { type: 'FeatureCollection' as const, features };
  }, [sim, renderGrid, inField]);

  // A block trial is not described by a strip width, and naming two crops is
  // wrong when the design carries four: it would report a maize-and-wheat
  // experiment for a trial containing neither in most of its plots.
  const bd = exp.blockDesign;
  const simSummary = !aoi
    ? 'needs an area'
    : pattern === 'imported'
      ? (exp.importedDesign
          ? `${exp.varieties.length} varieties · ${exp.importedDesign.plots.length} plots · ${exp.importedDesign.fileName}`
          : 'imported trial: no file yet')
    : pattern === 'block'
      ? `${bd.nSpecies} species × ${bd.nBlocks} blocks · ${bd.plotLength} × ${bd.plotWidth} m plots`
      : `${speciesD[0]?.name} × ${speciesD[1]?.name} · ${stripWidth} m ${PATTERNS.find(p => p.id === pattern)?.label.toLowerCase() ?? ''}`;

  return { patternOrigin, sim, geoSpread, ndviSeries, simStyle, fieldOutlineStyle, simGeojson, simSummary };
}

/** The PCA, always over the FIELD and never the viewport, plus the resolution sweep. */
export function usePcaSim({ aoi, fieldRing, gridApi, exp, patternOrigin, activeStep, compareAligned, compareFrom, mapSim }: {
  aoi: LngLatBounds | null;
  /** The field as a closed ring (use-area `fieldRing`), never "was a shape traced". */
  fieldRing: Poly | null;
  gridApi: GridApi; exp: Experiment;
  patternOrigin: { origin: [number, number]; offset: [number, number] } | null;
  activeStep: 'area' | 'grid' | 'sim' | 'pca' | null;
  /** Also compute the ladder at 0° so the two can be shown side by side. */
  compareAligned: boolean;
  /**
   * The angle the comparison's left-hand ladder is built at, when that is NOT
   * the design's current angle.
   *
   * Adopting the aligned placement from the ladder turns the design to 0, and
   * the comparison then had nothing to compare and vanished, taking away the
   * thing that had just been used to make the choice. Remembering where the
   * design came from keeps both placements on screen, so the click can be
   * looked at and undone. Null whenever the angle was set any other way, since
   * then the design's own angle is the one side of the comparison.
   */
  compareFrom: number | null;
  /** The map's simulation of `renderGrid`, reused when the PCA runs on that same grid. */
  mapSim: FieldSim | null;
}) {
  const { grid, renderGrid, build, buildOpts, inField, sigmaX, sigmaY, psfOffX, psfOffY } = gridApi;
  const { pattern, stripWidth, spacing, rotation, threshold, sensorSig, layout, layoutSig, blockDesign,
          importedAngle, importedFileAngle, importedBasePlan } = exp;
  const [selectedPixels, setSelectedPixels] = useState<number[]>([]); // pixels picked in the PCA → highlight on map

  /**
   * The PCA runs on the field itself: every pixel when the grid fits, else about
   * PCA_SAMPLE of them SPREAD over the whole field.
   *
   * It used to clip to a central square of that many cells, and called it a
   * representative subsample. A contiguous window is the least representative
   * sample a plot trial can be given: at 0.5 m the square is 25 m across, and a
   * trial of 25 m plots fits one or two of them inside it. The chart then showed
   * the two species that happened to be in the middle of the field, its purity
   * was theirs, and lassoing every point on it highlighted one small blob on the
   * map, which is what gave the game away.
   *
   * Striding asks the question a sample is for: what is this field like. Every
   * kth pixel on both axes lands in every block and every plot, at the cost of
   * the same number of cells.
   */
  const pcaGrid = useMemo(() => {
    if (grid) return grid;
    if (!aoi || !buildOpts || !build?.utmBounds || !build.epsg) return null;
    const res = build.res;
    /**
     * Sampled over the TRIAL, not over the field, whenever the two differ.
     *
     * A field is mostly not the trial. Spreading the sample across the field
     * puts the trial's share of it on the trial, and that share can be tiny: a
     * 20-plot variety trial of 403 m2 on a 6.2 ha field is 0.65% of it, so a
     * 2,000 pixel sample of the field landed 12 pixels on the trial and the
     * chart was fitted on twelve points. Clipping to the trial first spends
     * every sample where the question is.
     *
     * This is the extent a ladder rung already uses, from the same functions,
     * so the big chart and the rung at that size describe the same ground. A
     * periodic layout has no trial to clip to: it fills the field, and the
     * field extent is already the right one.
     */
    const sensorL: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100, offX: psfOffX, offY: psfOffY };
    let box: [number, number, number, number] = build.utmBounds;
    if (layout.pattern === 'imported' && layout.imported) {
      box = importedTrialExtent(layout.imported, res, sensorL, box);
    } else if (layout.pattern === 'block' && layout.block && patternOrigin) {
      box = trialExtent(layout.block, patternOrigin.origin, layout.rotationDeg, res, sensorL, box);
    }
    const nx = Math.max(1, Math.round((box[2] - box[0]) / res));
    const ny = Math.max(1, Math.round((box[3] - box[1]) / res));
    // The step that leaves about PCA_SAMPLE cells of THAT box. Ceil, so the
    // count lands under the target rather than over it.
    const stride = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / PCA_SAMPLE)));
    const sameAsField = box === build.utmBounds;
    if (sameAsField) return buildS2Grid(aoi, { ...buildOpts, stride, maxCells: PCA_SAMPLE * 4 }).grid;
    // buildS2Grid clips in WGS84, so the trial's box goes back through the CRS.
    const inv = proj4(crsToProj4Def(`EPSG:${build.epsg}`), 'EPSG:4326');
    let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
    for (const [E, N] of [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]] as [number, number][]) {
      const [lng, lat] = inv.forward([E, N]);
      w = Math.min(w, lng); e = Math.max(e, lng); so = Math.min(so, lat); n = Math.max(n, lat);
    }
    return buildS2Grid(aoi, { ...buildOpts, clip: [w, so, e, n], stride, maxCells: PCA_SAMPLE * 4 }).grid;
  }, [grid, aoi, buildOpts, build, layoutSig, sensorSig, patternOrigin]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The PCA's simulation TOGETHER with the grid it describes.
   *
   * They used to be kept apart. A resolution click replaces the grid in the same
   * render but the simulation only after the timeout below, so for one render
   * the new grid's cell indices read the old simulation's arrays past their end:
   * NaN seasons, a full PCA of that garbage run inside the click itself, and a
   * chart collapsed to a single dot until the real simulation landed. As one
   * pair, a view is always built from a simulation and the very grid it covers,
   * and until the new one arrives the chart keeps showing the previous, whole one.
   * `subsampled` says whether that grid was the central window of a field too
   * fine to simulate whole.
   */
  const [pcaRun, setPcaRun] = useState<{ grid: S2Grid; sim: FieldSim; subsampled: boolean } | null>(null);
  const [pcaBusy, setPcaBusy] = useState(false);
  // The map simulates `renderGrid` with this same layout origin, design and sensor
  // (its memo is keyed on patternOrigin and sensorSig, and patternOrigin on
  // layoutSig). When the PCA's grid IS that grid, simulating it a second time
  // repeated the most expensive step of a resolution change for nothing. Null
  // otherwise, so panning a capped map (a new renderGrid) never reruns the PCA.
  const sharedSim = renderGrid && renderGrid === pcaGrid ? mapSim : null;
  useEffect(() => {
    if (activeStep !== 'pca' || !pcaGrid || !patternOrigin) { setPcaRun(null); setPcaBusy(false); return; }
    setPcaBusy(true);
    const id = setTimeout(() => {
      // The SHARED layout, not a rebuilt one: a literal assembled from loose
      // primitives here would carry no block plan at all, so a randomised block
      // design would be invisible to the PCA while the map drew it.
      const layoutL: SimLayout = layout;
      const sensorL: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100, offX: psfOffX, offY: psfOffY };
      /**
       * simulateField answers for the whole rectangle, because the PSF has to
       * sweep it; a sampled grid then keeps every stride-th pixel of that
       * answer, in the order buildS2Grid produced its cells (strideFieldSim).
       * Simulating only the kept pixels is not the same thing: each one's value
       * comes from the ground around it, which is exactly what would be missing.
       */
      const step = pcaGrid.stride ?? 1;
      const whole = sharedSim ?? simulateField(pcaGrid, patternOrigin.origin, layoutL, sensorL);
      const [wE0, wN0, wE1, wN1] = pcaGrid.utmBounds;
      const wNx = Math.round((wE1 - wE0) / pcaGrid.res), wNy = Math.round((wN1 - wN0) / pcaGrid.res);
      const sim = sharedSim ? whole : strideFieldSim(whole, wNx, wNy, step, layoutL);
      setPcaRun({ grid: pcaGrid, sim, subsampled: pcaGrid !== grid });
      setPcaBusy(false);
    }, 30);
    return () => clearTimeout(id);
    // layoutSig, not the loose primitives: a changed seed, plot size or alley
    // moves none of pattern/stripWidth/spacing/rotation, so the PCA would have
    // gone on showing the design it computed before the edit.
  }, [activeStep, pcaGrid, patternOrigin, layoutSig, sensorSig, sharedSim]); // eslint-disable-line react-hooks/exhaustive-deps

  // The PCA runs on the full bbox grid; restrict it to pixels INSIDE the traced
  // field so the scatter (and click/lasso → map highlight) only ever hits real
  // field pixels. `cellIndex[j]` maps a scatter point back to a cell of `grid`.
  const pcaView = useMemo((): { sim: FieldSim & { pixelIds: Float64Array }; cellIndex: number[] | null; grid: S2Grid; res: number; subsampled: boolean } | null => {
    if (!pcaRun) return null;
    const { grid: runGrid, sim: pcaSim, subsampled } = pcaRun;
    const cells = runGrid.cells;
    // Each pixel's ground identity, so its noise and sampling match the same
    // pixel in the ladder's thumbnails (pca-field pixelId).
    const idsOf = (ks: ArrayLike<number>) => Float64Array.from({ length: ks.length }, (_, j) => pixelId(cells[ks[j]].col, cells[ks[j]].row));
    const whole = () => ({ sim: { ...pcaSim, pixelIds: idsOf(cells.map((_, k) => k)) }, cellIndex: null, grid: runGrid, res: runGrid.res, subsampled });
    if (!fieldRing) return whole();
    const keep: number[] = [];
    // The mask use-grid already built, when the PCA ran on that same grid. It
    // does not when the field is too fine to render whole: `pcaGrid` is then a
    // sampled grid of its own, and this walks it once.
    const mask = inField && inField.grid === runGrid ? inField.mask : null;
    const test = mask ? null : cellInFieldTest(fieldRing, runGrid.epsg, runGrid.res)!;
    for (let k = 0; k < cells.length; k++) if (mask ? mask[k] : test!(cells[k])) keep.push(k);
    if (!keep.length || keep.length === cells.length) return whole(); // all-in or degenerate → no remap
    const n = keep.length;
    const nSp = pcaSim.nSpecies;
    const pA = new Float32Array(n), pBare = new Float32Array(n), mixed = new Uint8Array(n);
    const srcSp = pcaSim.proportionBySpecies;
    const srcOff = pcaSim.proportionOffTrial;
    const sp = srcSp ? new Float32Array(n * nSp) : null;
    const off = srcOff ? new Float32Array(n) : null;
    let sumP = 0;
    for (let j = 0; j < n; j++) {
      const k = keep[j];
      pA[j] = pcaSim.proportionA[k]; pBare[j] = pcaSim.proportionBare[k]; mixed[j] = pcaSim.mixed[k];
      if (sp && srcSp) for (let s = 0; s < nSp; s++) sp[j * nSp + s] = srcSp[k * nSp + s];
      if (off && srcOff) off[j] = srcOff[k];
      sumP += pA[j];
    }
    // coverStats, not a fourth hand-rolled tally. The version this replaces read
    // `mixed[j] === 0` as crop A and `=== 1` as crop B, which for a block trial
    // are PLOT ids: plots 0 and 1 were counted and the other fourteen fell
    // through every branch, so purePct described two plots out of sixteen.
    const { coverSpecies } = speciesChannel(layout);
    // offTrial too, as the ladder's own panels count it, so the purity printed on
    // the current resolution's thumbnail follows the same rule as its neighbours.
    const st = coverStats({ mixed, coverSpecies, nSpecies: nSp, offTrial: off });
    const sim: FieldSim & { pixelIds: Float64Array } = {
      pixelIds: idsOf(keep),
      proportionA: pA, proportionBare: pBare, mixed,
      purePct: st.purePct, pureCrop: st.pureCrop, pureBare: st.pureBare, total: st.total, meanPropA: n ? sumP / n : 0.5,
      nSpecies: nSp, pureBySpecies: st.pureBySpecies,
      meanBySpecies: meanPerSpecies(sp, nSp, n, off),
      proportionBySpecies: sp,
      proportionOffTrial: off,
      pureA: st.pureBySpecies[0], pureB: st.pureBySpecies[1],
    };
    return { sim, cellIndex: keep, grid: runGrid, res: runGrid.res, subsampled };
    // `inField` is deliberately NOT a dependency. A new mask describes a new
    // renderGrid, which the check above then declines to use, so the result is
    // identical either way - and listing it would rebuild every array here on
    // every PAN of a capped map, the same trap `sharedSim` avoids above.
  }, [pcaRun, fieldRing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cells the user picked in the PCA scatter (click / lasso), as map polygons.
  // Looked up in the grid the scatter was computed on, which for a moment after
  // a resolution change is not yet the new one.
  const selectionGeojson = useMemo(() => {
    if (!pcaView || !selectedPixels.length) return null;
    const cells = pcaView.grid.cells;
    const idxMap = pcaView.cellIndex;
    const features = selectedPixels
      .map(j => (idxMap ? idxMap[j] : j))
      .filter(k => k != null && k >= 0 && k < cells.length)
      .map(k => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [cells[k].ring] } }));
    return features.length ? { type: 'FeatureCollection' as const, features } : null;
  }, [selectedPixels, pcaView]);

  // Resolution sweep: PCA at every pixel size in RES_LADDER.
  const [sweep, setSweep] = useState<SweepStep[] | null>(null);
  const [sweepAligned, setSweepAligned] = useState<SweepStep[] | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);
  /** What a rebuilt ladder means, defined once and testable: ladder-rung.ts. */
  const ladderSig = ladderKey(layout);
  /**
   * ONE resolution of the ladder at a GIVEN rotation, the unit the sweep is split
   * into. Parameterised by rotation so the comparison at 0° runs the identical code.
   * Pure and synchronous. Depends on the field, the design and the sensor, and on
   * nothing about the resolution currently displayed, which is what lets the rungs
   * be kept between clicks.
   */
  const stepAt = useCallback((rotationDeg: number, r: number, asDrawn = true): SweepStep | null => {
    if (!aoi || !build?.epsg) return null;
    const epsg = build.epsg;
    // The SHARED layout, with only the rotation overridden: "vs aligned" reruns
    // this identical code at 0 degrees. Rebuilding it from primitives would drop
    // the block plan, so a randomised design would be invisible to the ladder.
    let layoutL: SimLayout = { ...layout, rotationDeg };
    const sensorL: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100, offX: psfOffX, offY: psfOffY };
    const [minE, minN, maxE, maxN] = utmEnvelope(aoi, epsg);
    const base = aoiUtmOrigin(aoi, epsg);
    const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    // Each size gets its own purity-optimal placement (matches the map when picked).
    let ox = base[0], oy = base[1];
    // A block design is anchored and snapped by buildBlockPlan instead, and its
    // plots carry n species: searchPhaseOffset keeps two counters and assigns
    // with `& 1`, so it would optimise "species 0 or 1 coverage" and ignore the
    // rest.
    if (OPTIMIZE_PLACEMENT && layout.pattern !== 'block' && layout.pattern !== 'imported') {
      const [du, dv] = bestPhaseOffset(pattern, r, stripWidth, spacing, threshold / 100, base[0], base[1], sensorL);
      ox = base[0] + du * cos - dv * sin; oy = base[1] + du * sin + dv * cos;
    }
    /**
     * The WHOLE FIELD, on pixels snapped to multiples of r, keeping the pixels
     * that OVERLAP the field: the same rule the big scatter, the pixel count and
     * the export use (geometry.ts fieldOverlapTest). It used to be "centre
     * inside", which left a tilted field's corners covered by no kept pixel.
     */
    let e0 = Math.floor(minE / r) * r, n0 = Math.floor(minN / r) * r;
    let e1 = Math.ceil(maxE / r) * r, n1 = Math.ceil(maxN / r) * r;
    /** Pixels counted are those overlapping this ring (UTM), else those overlapping the field. */
    let trialRing: [number, number][] | null = null;
    if (layout.pattern === 'imported') {
      // Already in this grid's metres: nothing to resolve per size, only the
      // part of the field that sees the trial (the same exact rule as a block
      // trial's, see ladder.ts). At another angle than the one shown (the
      // aligned comparison) it is the same trial, turned to that angle.
      // Your design's rungs are the trial exactly as it stands, turn and stake
      // included. The comparison's rungs turn it by the smallest turn to that
      // angle and stake it on THIS rung's grid, the best it could be at that
      // size, the way a block trial is snapped per size.
      /**
       * A rung is measured in its OWN placement's frame, never in the field's.
       *
       * The field is the outline of whichever placement is currently adopted
       * (the page sets it from the trial), so clamping a rung to it measured the
       * OTHER placement inside the wrong outline: turning the trial 11.6 degrees
       * inside the envelope of its own 0 degree hull cuts the corners off, and
       * the same rung then reported 10,445 trial pixels where it had reported
       * 11,037. Clicking a panel changed the purity of the ladder it was in,
       * which is the one thing a comparison may not do.
       *
       * Infinity is the honest bound: widenedExtent clamps with max/min, so this
       * leaves the trial's own widened box exactly as it computes it, rather than
       * restating its kernel reach here and letting the two drift.
       */
      const UNCLIPPED: [number, number, number, number] = [-Infinity, -Infinity, Infinity, Infinity];
      /**
       * The comparison ladder ALWAYS re-stakes, whichever placement the design
       * happens to be sitting at.
       *
       * It used to decide by comparing angles, so the moment the aligned
       * placement was adopted the right-hand ladder stopped meaning "the best
       * this trial could be at each size" and started meaning "the trial exactly
       * as it stands", staked once at the size that was clicked. Its numbers
       * changed under the reader as a result of their own click: 54% at 1 m
       * became 45%, 16% at 3 m became 12%. A comparison has to measure the same
       * thing before and after it is acted on, so which ladder this is decides
       * it, not where the design currently sits.
       */
      let plan = layout.imported;
      const turn = nearestTurn(importedFileAngle, rotationDeg);
      const asStands = asDrawn && Math.abs(rotationDeg - importedAngle) < 1e-9;
      if (!asStands && importedBasePlan) {
        plan = rotateImportedPlan(importedBasePlan, turn);
        if (isAligned(importedFileAngle + turn)) {
          plan = stakeOnGrid(plan, r, sensorL, importedTrialExtent(plan, r, sensorL, UNCLIPPED)).plan;
        }
      }
      if (plan) {
        layoutL = { ...layoutL, imported: plan };
        [e0, n0, e1, n1] = importedTrialExtent(plan, r, sensorL, UNCLIPPED);
        /**
         * Counted over its OWN outline, not the field's: the drawn trial's
         * would cut the corners off a turned one (the comparison ladder turns
         * it again per rung), and the two ladders must count by the same rule.
         *
         * Both rules are "the pixels that see the trial": the other layouts
         * count over the field ring, inside the same trial extent, and
         * coverStats drops every pixel more than half off-trial either way.
         * They differ in exactly one case, deliberately: a generated trial
         * bigger than its field is cut down to the field, while an imported
         * trial IS the field (the page sets the field from its outline).
         */
        trialRing = plan.footprint;
      }
    } else if (layout.pattern === 'block') {
      /**
       * The trial as it is staked for pixels of THIS size: the plan resolved
       * against this rung's own lattice, exactly as the page resolves it when
       * this rung is picked. The map's plan is snapped to the displayed size
       * instead, so borrowing it made each thumbnail describe a trial that
       * picking it would not show.
       */
      // Staked on THIS rung's lattice, the best the trial could be at this size,
      // which is what the aligned ladder claims to show. Corner-snapping alone
      // put it at the 13th percentile of the available phases at 6 m and made
      // "turned onto the pixel grid" report worse than the same trial left at
      // 10 degrees. No phase to choose at any other angle, where it is a no-op.
      const plan = stakeBlockPlan(blockDesign, blockPlacement([e0, n0, e1, n1], base, rotationDeg, r, OPTIMIZE_PLACEMENT),
        [ox, oy], rotationDeg, r, sensorL, [e0, n0, e1, n1]).plan;
      layoutL = { ...layoutL, block: plan };
      // Only the pixels that see the trial, which a rung reproduces exactly
      // (see trialExtent); the rest of the field was most of a rung's cost.
      [e0, n0, e1, n1] = trialExtent(plan, [ox, oy], rotationDeg, r, sensorL, [e0, n0, e1, n1]);
    }
    // Very large extents fall back to a central window of LADDER_MAX_CELLS
    // pixels, flagged `partial` on the panel.
    let partial = false;
    if (Math.round((e1 - e0) / r) * Math.round((n1 - n0) / r) > LADDER_MAX_CELLS) {
      partial = true;
      const cx = (e0 + e1) / 2, cy = (n0 + n1) / 2;
      const side = Math.floor(Math.sqrt(LADDER_MAX_CELLS)) * r;
      const w = Math.min(side, e1 - e0), h = Math.min(side, n1 - n0);
      e0 = Math.floor((cx - w / 2) / r) * r; n0 = Math.floor((cy - h / 2) / r) * r;
      e1 = e0 + Math.round(w / r) * r; n1 = n0 + Math.round(h / r) * r;
    }
    // simulateField reads only the pixel size and the snapped extent.
    const box = { res: r, utmBounds: [e0, n0, e1, n1] } as unknown as S2Grid;
    const all = simulateField(box, [ox, oy], layoutL, sensorL);
    const nx = Math.round((e1 - e0) / r);
    const toUtm = proj4('EPSG:4326', crsToProj4Def(`EPSG:${epsg}`));
    const ringUtm = trialRing ?? (fieldRing ? fieldRing.map(([lng, lat]) => toUtm.forward([lng, lat]) as [number, number]) : null);
    // Pixels overlapping the ring, by the rule the whole page uses (geometry.ts).
    const overlaps = ringUtm ? fieldOverlapTest(ringUtm) : null;
    const keep: number[] = [];
    for (let k = 0; k < all.mixed.length; k++) {
      if (!overlaps) { keep.push(k); continue; }
      const [cE, cN] = rungCellOrigin(k, nx, e0, n0, r);
      if (overlaps(cE, cN, r)) keep.push(k);
    }
    const nSp = all.nSpecies, n = keep.length;
    const proportionA = new Float32Array(n), proportionBare = new Float32Array(n), mixed = new Uint8Array(n);
    const proportionBySpecies = all.proportionBySpecies ? new Float32Array(n * nSp) : null;
    const proportionOffTrial = all.proportionOffTrial ? new Float32Array(n) : null;
    // The pixel's column and row, computed the way buildS2Grid names its cells,
    // so a pixel here and the same pixel in the big chart share one identity.
    const pixelIds = new Float64Array(n);
    keep.forEach((k, j) => {
      proportionA[j] = all.proportionA[k]; proportionBare[j] = all.proportionBare[k]; mixed[j] = all.mixed[k];
      if (proportionBySpecies && all.proportionBySpecies) for (let s = 0; s < nSp; s++) proportionBySpecies[j * nSp + s] = all.proportionBySpecies[k * nSp + s];
      if (proportionOffTrial && all.proportionOffTrial) proportionOffTrial[j] = all.proportionOffTrial[k];
      const [cE, cN] = rungCellOrigin(k, nx, e0, n0, r);
      pixelIds[j] = pixelId(Math.round(cE / r), Math.round(cN / r));
    });
    const st = coverStats({ mixed, coverSpecies: speciesChannel(layoutL).coverSpecies, nSpecies: nSp, offTrial: proportionOffTrial });
    /**
     * The rung's headline pair: its own pure pixels, over its own PLANTED AREA
     * in pixels. Read off the mixture this rung already computed, with no second
     * simulation. Counting the pixels that merely HAVE crop in them instead
     * moves the denominator whenever the trial moves, which hid a 10.2% gain in
     * pure pixels behind a one-point change in the share. See resolving.ts.
     */
    // The design's own planted area, a constant for this design and pixel size,
    // so a rung that wins pure pixels reports exactly that gain in its share.
    // A rung measured on a CENTRAL SAMPLE (`partial`) holds only a fraction of
    // the trial, so it is divided by the crop in the sample instead: the whole
    // design's area under a sample's pure count made the 0.5 m rung read 12%
    // beneath a 2 m rung reading 77%. The same rule as pureEfficiency's.
    const measured = plantedPixels({ species: proportionBySpecies, offTrial: proportionOffTrial, nSpecies: nSp, count: n });
    const geo = plantedAreaPx(layoutL, r);
    const planted = geo != null && geo > 0 && measured >= 0.8 * geo ? geo : measured;
    const resolvingPct = planted >= 1 ? Math.max(0, Math.min(100, (100 * st.pureCrop) / planted)) : null;
    // Threshold-free, for the tooltip: what the mixed pixels are worth unmixed,
    // and whether two varieties can be told apart at all, which no count sees.
    const under = contrastInfo({ species: proportionBySpecies, bare: proportionBare, offTrial: proportionOffTrial, nSpecies: nSp, count: n });
    // `mixed` travels with the rung, not just its tally: the thumbnail colours
    // each dot pure or mixed off these same bytes, so it cannot paint a pixel
    // green that the purity printed under it counted as mixed.
    return { res: r, proportionA, proportionBare, mixed, purePct: st.purePct, pureCount: st.pureCrop, trialCount: st.total,
             resolvingPct, nEff: under.nEff, contrastDead: under.dead, plantCount: Math.round(planted),
             proportionBySpecies, nSpecies: nSp, proportionOffTrial, pixelIds, partial };
    // ladderSig covers the whole design, block parameters included; blockDesign's
    // fields are all in it.
  }, [aoi, fieldRing, build?.epsg, ladderSig, sigmaX, sigmaY, psfOffX, psfOffY, threshold]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bumped by every new run and every cancellation. A chunk that finds it changed
  // stops without writing, so a stale ladder can never land after a newer one.
  const sweepGen = useRef(0);

  /**
   * Finished rungs, by angle and pixel size, for the stepAt that computed them.
   * Picking a thumbnail changes none of stepAt's inputs, so every rung already
   * built is reused and a click no longer rebuilds the ladder. A new stepAt (a
   * changed field, design or sensor) starts an empty cache.
   */
  const rungs = useRef<{ owner: typeof stepAt; steps: Map<string, SweepStep> } | null>(null);
  /** One placeholder per size, so an unchanged ladder compares equal to the last one. */
  const stubs = useRef(new Map<number, SweepStep>());
  const stubFor = (r: number): SweepStep => {
    let s = stubs.current.get(r);
    if (!s) {
      s = { res: r, proportionA: new Float32Array(0), proportionBare: new Float32Array(0), mixed: new Uint8Array(0),
            proportionBySpecies: null, proportionOffTrial: null, nSpecies: 0, purePct: NaN, current: true };
      stubs.current.set(r, s);
    }
    return s;
  };
  const sameSteps = (a: SweepStep[] | null, b: SweepStep[] | null) =>
    a === b || (!!a && !!b && a.length === b.length && a.every((s, i) => s === b[i]));

  const runSweep = useCallback(() => {
    if (!aoi || !build?.epsg) return;
    const gen = ++sweepGen.current;
    if (rungs.current?.owner !== stepAt) rungs.current = { owner: stepAt, steps: new Map() };
    const cache = rungs.current.steps;
    // The comparison run: the same design with the strips along the pixel rows.
    // Only computed while the user asks for it, and pointless at 0°.
    // An imported trial has its own angle (the file's, plus any turn).
    // The design's own angle, unless the aligned placement was adopted FROM the
    // ladder: then it is where the design was before that click, so the pair the
    // user was comparing survives the choice they made with it.
    const own = layout.pattern === 'imported' ? importedAngle : rotation;
    const angle = compareFrom ?? own;
    // The same tolerance the "vs aligned" button uses, so it never builds a
    // comparison the button says there is no point in.
    const wantAligned = compareAligned && Math.min(angle, 90 - angle) >= 0.05;
    const jobs: [number, number, 0 | 1][] = [
      ...RES_LADDER.map(r => [angle, r, 0] as [number, number, 0]),
      ...(wantAligned ? RES_LADDER.map(r => [0, r, 1] as [number, number, 1]) : []),
    ];
    const isCurrent = (r: number) => build?.res != null && Math.abs(r - build.res) < 1e-9;
    const cur: SweepStep[] = [], al: SweepStep[] = [];
    let i = 0;
    // One simulated resolution per task, yielding to the browser in between, so
    // the page can still echo a keystroke. Rungs already built cost nothing and
    // are taken in the same task. The result is committed once at the end, so
    // the panels never show a half-updated ladder.
    const next = () => {
      if (gen !== sweepGen.current) return;
      let worked = false;
      while (i < jobs.length && !worked) {
        const [rot, r, which] = jobs[i++];
        let step = cache.get(`${rot}|${r}|${which}`) ?? null;
        if (!step && which === 0 && isCurrent(r)) {
          // The current resolution's thumbnail draws the big scatter's own
          // simulation (PcaSweep swaps it in), so it is not simulated here now:
          // at 0.5 m it is the most expensive rung. Built once the page is idle.
          step = stubFor(r);
        } else if (!step) {
          setSweepBusy(true);
          step = stepAt(rot, r, which === 0);
          if (step) cache.set(`${rot}|${r}|${which}`, step);
          worked = true;
        }
        if (step) (which ? al : cur).push(step);
      }
      if (i < jobs.length) { setTimeout(next, 0); return; }
      setSweep(prev => (sameSteps(prev, cur) ? prev : cur));
      setSweepAligned(prev => (!wantAligned ? null : sameSteps(prev, al) ? prev : al));
      setSweepBusy(false);
      // Build the skipped rung while nobody is interacting, so picking another
      // size later finds it ready instead of computing it after the click.
      const pending = cur.filter(s => s.current);
      if (!pending.length) return;
      const idle = (f: () => void) => {
        const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
        if (w.requestIdleCallback) w.requestIdleCallback(f, { timeout: 3000 }); else setTimeout(f, 500);
      };
      const fill = () => {
        if (gen !== sweepGen.current) return;
        const stub = pending.shift()!;
        const made = stepAt(angle, stub.res, true);
        if (made) {
          cache.set(`${angle}|${stub.res}|0`, made);
          setSweep(prev => (prev ? prev.map(s => (s === stub ? made : s)) : prev));
        }
        if (pending.length) idle(fill);
      };
      idle(fill);
    };
    setTimeout(next, 30);
  }, [aoi, build?.epsg, build?.res, rotation, compareAligned, compareFrom, stepAt, layout.pattern, importedAngle]); // eslint-disable-line react-hooks/exhaustive-deps
  // Auto-recompute whenever an input that feeds the sweep changes: no button click
  // needed. Debounced so dragging a slider doesn't refit on every frame. Only while
  // the PCA step is open (nothing else shows the sweep). The crop / noise params only
  // change the PCA embed, which PcaSweep redoes from the cached data (no refit here).
  useEffect(() => {
    if (activeStep !== 'pca') return;
    const id = setTimeout(runSweep, 250);
    return () => {
      clearTimeout(id);
      // Inputs changed (or the step closed): abandon any ladder still being built
      // from the old inputs rather than letting it finish and flash stale results.
      sweepGen.current++;
      setSweepBusy(false);
    };
  }, [activeStep, runSweep]);

  // The chart on screen ran on a sample spread over the field, not every pixel.
  const pcaSubsampled = !!pcaView?.subsampled;
  /**
   * The crop this design plants at the PCA chart's OWN pixel size, so the purity
   * tab can state the headline share rather than a second, unexplained
   * percentage of the same pure pixels (they read 62% and 47% side by side).
   */
  const pcaPlanted = useMemo(
    () => (pcaView ? plantedAreaPx(layout, pcaView.res) : null),
    [pcaView, layoutSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const pcaSim = pcaRun?.sim ?? null;

  return { pcaGrid, pcaSim, pcaBusy, pcaView, pcaSubsampled, pcaPlanted, selectedPixels, setSelectedPixels,
           selectionGeojson, sweep, sweepAligned, sweepBusy };
}
