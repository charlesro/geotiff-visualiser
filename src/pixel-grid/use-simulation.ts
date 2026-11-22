import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import {
  BARE, CROP_COLORS, MAX_COVER, strideFieldSim, CROP_PRESETS, PATTERNS, TRUTH_TYPES, bestPhaseOffset, cropById, makeBetaSchedule, simulateField,
  makeTruth, parsOf, TMAX, coverStats, speciesChannel, meanPerSpecies,
  layoutKey, plantedAreaPx, stakeBlockPlan,
  type BlockDesign, type FieldParams, type FieldSim, type PatternType, type SensorParams, type SimLayout, latticeOffset,
} from './simulate';
import { holdTracker } from './resolving';
import { buildS2Grid, cellFills, cellLines, type LngLatBounds, type S2Grid } from './s2-grid';
import { landings, shiftedVerdict } from './pixel-verdicts';
import { type Poly } from './geometry';
import { cellInFieldTest } from './field-membership';
import { categoricalColors, distinctColors, mixN } from './util';
import { PCA_SAMPLE, ladderRungs, type Rung } from './sensors';
import { pixelId } from './ladder-rung';
import { importedTrialExtent, trialExtent } from './ladder';
import { ladderKey } from './ladder-rung';
import { OPTIMIZE_PLACEMENT, ladderSearch, ladderStep, type LadderContext } from './ladder-step';
import { ladderPool } from './ladder-pool';
import { seatedPlacement } from './trial-seat';
import type { SweepStep } from './PcaSweep';
import type { useFieldGrid } from './use-grid';
import { arrayOf, inRange, isLngLat, isNum, oneOf, readSaved, shape, usePersistentState } from './persist';
import { MAX_IMPORT_PLOTS, tooManyVarieties, varietiesOf } from './design-import';
import { resolveImportedPlan } from './imported-plan';
import { alignedWithin, rotateImportedPlan, shiftImportedPlan, trialAngle } from './imported-rotate';
import type { ImportedDesign, ImportedPlan } from './imported-types';

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
 *  - The map overlays carry their own colours (`simGeojson`'s features), and
 *    the functions that style them live in FieldMap with ONE identity each.
 *    react-leaflet calls setStyle on every feature of a <GeoJSON> each time
 *    its `style` prop is another function, and a function made in a render is
 *    another one every time: every pan, every keystroke restyled and redrew
 *    the whole overlay. What repaints a changed overlay is `geoKey` (assembled
 *    in the shell), which remounts it.
 */

/** Planting design, crop curves and noise. Sigma is owned by step 2 and passed in. */
export function useExperiment({ sigmaX, sigmaY, anyPosition, placeHeldM, fieldBounds, fieldOrigin, pixelSize, epsg, aoi, fieldRing }: {
  sigmaX: number; sigmaY: number;
  /** The CE90 a trial is placed for, in metres: 0 when the page places for pure pixels (SensorParams.placeHeldM). */
  placeHeldM: number;
  /** True for a tasked sensor: the trial is counted at the worst position on its lattice (SensorParams.anyPosition). */
  anyPosition: boolean;
  /**
   * The field's box and its outline (use-area `fieldRing`): a block trial is
   * seated inside the outline, not on the middle of the box (trial-seat.ts).
   */
  aoi: LngLatBounds | null;
  fieldRing: Poly | null;
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
  /**
   * The trial's angle to the pixel rows. NEGATIVE angles are allowed, because a
   * field's rows can run either side of them: the parcel this page was measured
   * on runs 3.6 degrees anticlockwise, and entering its mirror image is only
   * equivalent by accident of the design being a symmetric grid.
   */
  const [rotation, setRotation] = usePersistentState('rotation', 0, inRange(-90, 90));
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
  // 90 % is the PHENET note's definition of a pure pixel (contamination <= 10 %).
  // 100 is not offered: a Gaussian never reaches zero, so at 100 % "pure" meant
  // "nothing foreign inside the kernel's cut-off at ceil(3 sigma) pixels", an
  // artefact of the truncation that read 0 pure pixels where the note counts 20.
  // A saved 100 fails this range and falls back to 90.
  const [threshold, setThreshold] = usePersistentState('threshold', 90, inRange(50, 99));

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
    const place = seatedPlacement(blockDesign, fieldRing, aoi, epsg, fieldBounds, fieldOrigin, rotation, pixelSize, OPTIMIZE_PLACEMENT);
    const sen: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100, anyPosition, placeHeldM };
    return stakeBlockPlan(blockDesign, place, fieldOrigin, rotation, pixelSize, sen, fieldBounds).plan;
  }, [pattern, fieldBounds?.join(','), fieldOrigin?.[0], fieldOrigin?.[1], rotation, pixelSize, fieldRing, aoi?.join(','), epsg,
      sigmaX, sigmaY, threshold, anyPosition, placeHeldM,
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
  const sensor: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100, anyPosition, placeHeldM };
  // Every primitive the sensor depends on: `sensor` itself is a fresh literal each
  // render and is deliberately kept out of dependency arrays, so this string is
  // what tells the memos the PSF changed. Miss the offsets here and the page
  // keeps showing the purity it computed for a centred kernel.
  const sensorSig = `${sigmaX}_${sigmaY}_${threshold}_${anyPosition ? 1 : 0}_${placeHeldM}`;

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
export function useSimulation({ aoi, gridApi, exp, simOn, showPure, fieldOrigin }: {
  aoi: LngLatBounds | null;
  /** The map's "Pure pixels" switch: the layer below is built only while it is on. */
  showPure: boolean;
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

  /**
   * Where the shown grid's pixel edges fall, modulo its pixel: zero on most
   * grids, half a pixel on native Landsat (sensors.ts latticePhase has the
   * rule; here it is read off the grid itself, which is the real one).
   */
  // Off the grid drawn, or off the one built while a capped grid waits to be
  // drawn; latticeOffset reads whole multiples as exactly zero, so a remainder
  // of rounding cannot move the pattern as the map is panned.
  const gridRes = build?.res ?? 0, gridBox = renderGrid?.utmBounds ?? build?.utmBounds ?? null;
  const gridPhase: [number, number] = gridRes > 0 && gridBox ? [latticeOffset(gridBox[0], gridRes), latticeOffset(gridBox[1], gridRes)] : [0, 0];

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
    // Slid onto the grid the map really shows (gridPhase): the search counts
    // from zero, so the corner is handed over in the grid's own count.
    const [du, dv] = bestPhaseOffset(pattern, build.res, stripWidth, spacing, threshold / 100, base[0] - gridPhase[0], base[1] - gridPhase[1], sensor);
    const t = (rotation * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    return { origin: [base[0] + du * cos - dv * sin, base[1] + du * sin + dv * cos] as [number, number], offset: [du, dv] as [number, number] };
    // layoutSig rather than the loose primitives: it also covers the block
    // design, whose seed, plot size and alleys move none of them.
  }, [aoi, build?.epsg, build?.res, layoutSig, sensorSig, fieldOrigin?.[0], fieldOrigin?.[1], gridPhase[0], gridPhase[1]]);

  const sim = useMemo(
    () => (simOn && renderGrid && patternOrigin ? simulateField(renderGrid, patternOrigin.origin, layout, sensor) : null),
    [simOn, renderGrid, patternOrigin, pattern, stripWidth, spacing, rotation, sensorSig],
  );


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
    // Each species' season once, then read day by day. truthAt builds the whole
    // season to return one day of it, so asking it for 74 days of 40 varieties
    // was a million evaluations of the curve for a chart of 74 points.
    const seasons = speciesD.map(s => makeTruth(s.truth, TMAX, parsOf(s)));
    const pts: Record<string, number>[] = [];
    for (let d = 0; d <= 365; d += 5) {
      const vals = seasons.map(season => season[d]);
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
   * The simulation as the map draws it: the field's pixels, each in the blend of
   * what it holds.
   *
   * `sp` is the cell's real per-species composition. Without it the rest of the
   * pixel was inferred as `1 - f - bare` and handed to a two-colour blend, which
   * lumps EVERY species after the first into "crop B": a four-species trial was
   * drawn as a two-crop mixture, plausibly and wrongly. mixN is the one blend in
   * the codebase, shared with the map legend, so they cannot disagree.
   *
   * The off-trial fraction is a WEIGHT, not a leftover. Without it a pixel
   * outside the trial has an all-zero species vector, mixN skips every zero,
   * and the blend divides by `w || 1` and paints it solid black. On a block
   * design that is most of the field.
   *
   * (There used to be a purity view and an NDVI view here, chosen by a `simView`
   * state that nothing could ever change. They are in the history if they are
   * wanted back, with a control to reach them.)
   *
   * Pixels of one colour are filled together (s2-grid cellFills): every pure
   * pixel of a plot is the same colour, and so is all the ground outside the
   * trial. The outlines are one more feature, every pixel's square, stroked
   * once over the fills (`simCells`, which is also what Real field mode draws
   * alone). A feature per pixel, each filled and stroked on its own, was two
   * canvas calls per pixel at every pan and zoom.
   */
  const simSets = useMemo(() => {
    if (!sim || !renderGrid) return null;
    const nSp = sim.nSpecies;
    const spAll = sim.proportionBySpecies;
    const offAll = sim.proportionOffTrial;
    const pair = [0, 0];
    const all: [number, number][][] = [];
    const byColor = new Map<string, [number, number][][]>();
    // The pixels overlapping the field, by the one rule the page uses, decided
    // once for this grid in use-grid rather than clipped per cell a third time.
    const keep = inField && inField.grid === renderGrid ? inField.mask : null;
    for (let k = 0; k < renderGrid.cells.length; k++) {
      if (keep && !keep[k]) continue;
      const f = sim.proportionA[k], bare = sim.proportionBare[k];
      // The cell's own species composition, read where the engine left it.
      // Reconstructing it from a single "crop A fraction" is what limited the
      // overlay to two species.
      let fr: ArrayLike<number> = pair;
      if (spAll && nSp) fr = spAll.subarray(k * nSp, k * nSp + nSp);
      else { pair[0] = f; pair[1] = Math.max(0, 1 - f - bare); }
      const color = mixN(fr, colors, bare, offAll ? offAll[k] : 0);
      const ring = renderGrid.cells[k].ring;
      all.push(ring);
      const same = byColor.get(color);
      if (same) same.push(ring); else byColor.set(color, [ring]);
    }
    const lines = cellLines({ lines: true as const }, all);
    const fills: GeoJSON.Feature[] = [];
    for (const [fill, rings] of byColor) fills.push(...cellFills({ fill }, rings));
    return {
      fills: { type: 'FeatureCollection' as const, features: [...fills, lines] },
      cells: { type: 'FeatureCollection' as const, features: [lines] },
    };
    // `colors` is a new array whenever a colour changes, and only then.
  }, [sim, renderGrid, inField, colors]);
  const simGeojson = simSets?.fills ?? null;
  const simCells = simSets?.cells ?? null;

  /**
   * Which pixels stay pure, for the same plot, wherever the image lands within
   * its CE90: the set the export writes as PURE_CE90 and the ladder counts as
   * "pure within CE90", for the map's "Pure pixels" switch to tell apart.
   *
   * It is one more simulation of the field per placement, eight of them, so it
   * is asked for only while the switch is on and worked out AFTER the click,
   * one placement per tick: done inside the render, a fine grid held the page
   * for as long as eight map simulations take. A run that is overtaken (the
   * design, the sensor or the CE90 moved) stops at its next tick and writes
   * nothing.
   *
   * Kept WITH the simulation and the CE90 it was computed for. For the render
   * in which a new simulation arrives the old mask is still here, and read
   * against the new pixels it would mark the wrong ones. And while a new CE90
   * is being worked out the old mask is still here too: the map was repainted
   * for the new figure with the old set, and never again once the right one
   * came, since its key had already moved (the legend read 6 m over the
   * pixels of 2.15 m). A mask that is not for this simulation and this CE90
   * is no mask.
   */
  const [held, setHeld] = useState<{ sim: FieldSim; ce90: number; mask: Uint8Array } | null>(null);
  const [heldBusy, setHeldBusy] = useState(false);
  useEffect(() => {
    const origin = patternOrigin?.origin;
    if (!showPure || !sim || !renderGrid || !origin || !(geoErrM > 0)) { setHeld(null); setHeldBusy(false); return; }
    setHeldBusy(true);
    // robustMask, a placement at a time: each is asked only about the pixels
    // still pure for their plot at every placement before it (holdTracker),
    // and once none is left the rest are not simulated at all.
    // Where the image can land and whether anything survives it: the table's
    // and the export's rule (pixel-verdicts.ts landings).
    const { lands: shifts, hopeless } = landings(layout, geoErrM);
    if (hopeless) { setHeld({ sim, ce90: geoErrM, mask: new Uint8Array(sim.mixed.length) }); setHeldBusy(false); return; }
    const hold = holdTracker(sim.mixed);
    let timer = 0, stopped = false, done = 0;
    const next = () => {
      if (stopped) return;
      if (done < shifts.length && hold.left() > 0) {
        hold.take(shiftedVerdict(renderGrid, origin, layout, sensor, shifts[done++], hold.alive));
        timer = window.setTimeout(next, 0);
        return;
      }
      setHeld({ sim, ce90: geoErrM, mask: hold.alive });
      setHeldBusy(false);
    };
    timer = window.setTimeout(next, 30);
    return () => { stopped = true; clearTimeout(timer); };
    // `sim` stands for the design, the sensor and the grid: it is rebuilt when
    // any of them moves, and `layout` and `sensor` are read as of that render.
  }, [showPure, sim, renderGrid, geoErrM]); // eslint-disable-line react-hooks/exhaustive-deps
  const pureHeld = held && held.sim === sim && held.ce90 === geoErrM ? held.mask : null;

  /**
   * The field's pixels again, told apart only by how pure they are: what the
   * map's "Pure pixels" switch lays over the simulation. 0 is not pure for a
   * crop, 1 is pure now but not at every place the image can land within its
   * CE90, 2 is pure and holds (every pure pixel, while that is not known or
   * there is no geolocation error to hold against). The verdict is the engine's
   * own byte, the one the counts, the ladder and the export's PURE column read,
   * so the map cannot highlight a different set. Bare soil and ground outside
   * the trial are not crops and are not pure.
   */
  const pureGeojson = useMemo(() => {
    if (!showPure || !sim || !renderGrid) return null;
    const keep = inField && inField.grid === renderGrid ? inField.mask : null;
    // The pixels of one level together (s2-grid cellFills, cellLines): the
    // veil, then the half veil and the broken outline of the pixels that are
    // pure but do not hold, then the outline of the ones that do, on top.
    const sets: [number, number][][][] = [[], [], []];
    for (let k = 0; k < renderGrid.cells.length; k++) {
      if (keep && !keep[k]) continue;
      const pure = sim.mixed[k] > MAX_COVER ? 0 : pureHeld && !pureHeld[k] ? 1 : 2;
      sets[pure].push(renderGrid.cells[k].ring);
    }
    const features: GeoJSON.Feature[] = [...cellFills({ pure: 0 }, sets[0]), ...cellFills({ pure: 1 }, sets[1])];
    if (sets[1].length) features.push(cellLines({ pure: 1, lines: true }, sets[1]));
    if (sets[2].length) features.push(cellLines({ pure: 2, lines: true }, sets[2]));
    return { type: 'FeatureCollection' as const, features };
  }, [showPure, sim, renderGrid, inField, pureHeld]);

  // A block trial is not described by a strip width, and naming two crops is
  // wrong when the design carries four: it would report a maize-and-wheat
  // experiment for a trial containing neither in most of its plots.
  const bd = exp.blockDesign;
  // The design, whether or not there is an area to simulate it on: step 3 is
  // where a trial is designed, and "needs an area" read as a locked door.
  const simSummary = pattern === 'imported'
      ? (exp.importedDesign
          ? `${exp.varieties.length} varieties · ${exp.importedDesign.plots.length} plots · ${exp.importedDesign.fileName}`
          : 'imported trial: no file yet')
    : pattern === 'block'
      ? `${bd.nSpecies} species × ${bd.nBlocks} blocks · ${bd.plotLength} × ${bd.plotWidth} m plots`
      : `${speciesD[0]?.name} × ${speciesD[1]?.name} · ${stripWidth} m ${PATTERNS.find(p => p.id === pattern)?.label.toLowerCase() ?? ''}`;

  return { patternOrigin, sim, ndviSeries, simGeojson, simCells, pureGeojson, pureHeld, heldBusy, simSummary };
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
  const { grid, renderGrid, build, buildOpts, inField, sigmaX, sigmaY } = gridApi;
  const { rotation, threshold, sensorSig, layout, layoutSig, blockDesign,
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
    const sensorL: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100 };
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
      const sensorL: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100 };
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
    const rings = selectedPixels
      .map(j => (idxMap ? idxMap[j] : j))
      .filter(k => k != null && k >= 0 && k < cells.length)
      .map(k => cells[k].ring);
    // Filled together and outlined in one stroke: a lasso over a fine grid is thousands of pixels.
    return rings.length ? { type: 'FeatureCollection' as const, features: [...cellFills({}, rings), cellLines({ lines: true }, rings)] as GeoJSON.Feature[] } : null;
  }, [selectedPixels, pcaView]);

  // The ladder: a PCA for every satellite (sensors.ts ladderRungs), the one
  // selected taken as it stands on the page.
  const ladder = useMemo(
    () => ladderRungs({ id: gridApi.sourceId, res: build?.res ?? gridApi.pxSize, sigmaX, sigmaY }),
    [gridApi.sourceId, build?.res, gridApi.pxSize, sigmaX, sigmaY],
  );
  /** A rung's identity in the cache: the satellite AND the figures it was computed at. */
  const rungKey = (g: Rung) => `${g.id}|${g.res}|${g.sigmaX}|${g.sigmaY}`;
  const ladderKeys = ladder.map(rungKey).join(';');
  const [sweep, setSweep] = useState<SweepStep[] | null>(null);
  const [sweepAligned, setSweepAligned] = useState<SweepStep[] | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);
  /** What a rebuilt ladder means, defined once and testable: ladder-rung.ts. */
  const ladderSig = ladderKey(layout);
  /**
   * What a rung of the ladder is computed from (ladder-step.ts), as plain data:
   * the page computes a rung from it, and so do the workers it is handed to.
   * Rebuilt only when the field, the design or the geolocation error moves:
   * `layout` is a fresh object every render and `ladderSig` stands for it (it
   * covers the whole design, block parameters included). A click on a row
   * selects another satellite, which is none of these, so every rung already
   * built is kept (see `rungs` below).
   */
  const ladderCtx = useMemo((): LadderContext | null => (aoi && build?.epsg
    ? { aoi, fieldRing, epsg: build.epsg, layout, threshold, blockDesign, importedAngle, importedFileAngle, importedBasePlan,
        geoAuto: gridApi.geoAuto, geoManual: gridApi.geoManual, geoProvider: gridApi.geoProvider, placeFor: gridApi.placeFor }
    : null),
    // The settings themselves, not a function made from them: see use-grid ce90At.
    [aoi, fieldRing, build?.epsg, ladderSig, threshold, gridApi.geoAuto, gridApi.geoManual, gridApi.geoProvider, gridApi.placeFor]); // eslint-disable-line react-hooks/exhaustive-deps
  /** ONE satellite of the ladder at a given rotation: ladderStep, on the page's own thread. */
  const stepAt = useCallback((rotationDeg: number, rung: Rung, asDrawn = true): SweepStep | null =>
    (ladderCtx ? ladderStep(ladderCtx, rotationDeg, rung, asDrawn) : null), [ladderCtx]);

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
  /** One placeholder per rung, so an unchanged ladder compares equal to the last one. */
  const stubs = useRef(new Map<string, SweepStep>());
  const stubFor = (g: Rung): SweepStep => {
    let s = stubs.current.get(rungKey(g));
    if (!s) {
      s = { id: g.id, name: g.name, res: g.res, proportionA: new Float32Array(0), proportionBare: new Float32Array(0), mixed: new Uint8Array(0),
            proportionBySpecies: null, proportionOffTrial: null, nSpecies: 0, purePct: NaN, current: true };
      stubs.current.set(rungKey(g), s);
    }
    return s;
  };
  /** The design the pool's workers were last handed, and the id the pool gave it. */
  const pooled = useRef<{ ctx: LadderContext; id: number } | null>(null);
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
    // comparison the button says there is no point in. An imported trial is
    // compared with its best placement instead, which is worth asking about
    // at any angle, the pixel rows' included.
    const wantAligned = compareAligned && (layout.pattern === 'imported' ? !!importedBasePlan : !alignedWithin(angle, 0.05));
    const jobs: [number, Rung, 0 | 1][] = [
      ...ladder.map(g => [angle, g, 0] as [number, Rung, 0]),
      ...(wantAligned ? ladder.map(g => [0, g, 1] as [number, Rung, 1]) : []),
    ];
    const commit = (cur: SweepStep[], al: SweepStep[]) => {
      setSweep(prev => (sameSteps(prev, cur) ? prev : cur));
      setSweepAligned(prev => (!wantAligned ? null : sameSteps(prev, al) ? prev : al));
      setSweepBusy(false);
    };
    // What the page's own pass keeps (`next`, further down: the path of a
    // browser with no workers). The satellite selected: its panel can draw the
    // big chart's own simulation.
    const isCurrent = (g: Rung) => g.id === gridApi.sourceId;
    const cur: SweepStep[] = [], al: SweepStep[] = [];
    /** The rungs left as placeholders, to build once the page is idle. */
    const waiting = new Map<SweepStep, Rung>();
    let i = 0;
    /**
     * In the workers, when the browser has them (ladder-pool): every rung not
     * already kept is asked for at once, they are computed away from the page
     * and several at a time, and the ladder is committed whole when the last
     * one is back, as below. A design that moves on meanwhile bumps `sweepGen`
     * and hands the pool its new context, which drops what was still waiting.
     * The selected satellite's rung is computed like any other here: holding
     * it back only ever saved the page's own time.
     */
    const pool = ladderCtx ? ladderPool() : null;
    if (pool && !pool.failed && ladderCtx) {
      if (pooled.current?.ctx !== ladderCtx) pooled.current = { ctx: ladderCtx, id: pool.setContext(ladderCtx) };
      const ctxId = pooled.current.id;
      let asked = false;
      // Asked for in the order of how long they take, the longest first: the
      // best placements (each a search) before the trial as drawn, and the
      // finest pixels first within each. The ladder is shown when the LAST rung
      // is back, and with the long ones queued last, one worker was still on a
      // search while the others had nothing left to do.
      const order = jobs.map((_, q) => q).sort((x, y) => jobs[y][2] - jobs[x][2] || x - y);
      const want: Promise<SweepStep>[] = new Array(jobs.length);
      for (const q of order) {
        const [rot, g, which] = jobs[q];
        const key = `${rot}|${which}|${rungKey(g)}`;
        const kept = cache.get(key);
        if (kept) { want[q] = Promise.resolve(kept); continue; }
        asked = true;
        want[q] = pool.step(ctxId, rot, g, which === 0, q).then(step => { cache.set(key, step); return step; });
      }
      if (asked) setSweepBusy(true);
      Promise.all(want).then(
        steps => { if (gen === sweepGen.current) commit(steps.slice(0, ladder.length), steps.slice(ladder.length)); },
        // Overtaken by a newer run, which has nothing to do here; or the
        // workers broke, and the page builds this ladder itself.
        () => { if (gen === sweepGen.current && pool.failed) setTimeout(next, 0); },
      );
      return;
    }
    setTimeout(next, 30);

    // One simulated resolution per task, yielding to the browser in between, so
    // the page can still echo a keystroke. Rungs already built cost nothing and
    // are taken in the same task. The result is committed once at the end, so
    // the panels never show a half-updated ladder.
    function next() {
      if (gen !== sweepGen.current) return;
      let worked = false;
      while (i < jobs.length && !worked) {
        const [rot, g, which] = jobs[i++];
        const key = `${rot}|${which}|${rungKey(g)}`;
        let step = cache.get(key) ?? null;
        if (!step && which === 0 && isCurrent(g)) {
          // The selected satellite's thumbnail draws the big scatter's own
          // simulation (PcaSweep swaps it in), so it is not simulated here now:
          // with fine pixels it is the most expensive rung. Built once the page is idle.
          step = stubFor(g);
          waiting.set(step, g);
        } else if (!step) {
          setSweepBusy(true);
          // A best-placement rung waits for its search, which is run here a
          // slice per task: the whole of it is seconds at the finest sizes.
          const search = which === 1 && layout.pattern === 'imported' && ladderCtx ? ladderSearch(ladderCtx, g) : null;
          if (search && !search.step()) { i--; worked = true; continue; }
          step = stepAt(rot, g, which === 0);
          if (step) cache.set(key, step);
          worked = true;
        }
        if (step) (which ? al : cur).push(step);
      }
      if (i < jobs.length) { setTimeout(next, 0); return; }
      commit(cur, al);
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
        const g = waiting.get(stub);
        const made = g ? stepAt(angle, g, true) : null;
        if (made && g) {
          cache.set(`${angle}|0|${rungKey(g)}`, made);
          setSweep(prev => (prev ? prev.map(s => (s === stub ? made : s)) : prev));
        }
        if (pending.length) idle(fill);
      };
      idle(fill);
    }
  }, [aoi, build?.epsg, ladderKeys, gridApi.sourceId, rotation, compareAligned, compareFrom, stepAt, layout.pattern, importedAngle]); // eslint-disable-line react-hooks/exhaustive-deps
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
