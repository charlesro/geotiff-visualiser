import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import {
  BARE, MIXED, OFF_TRIAL, CROP_COLORS, CROP_PRESETS, PATTERNS, TRUTH_TYPES, bestPhaseOffset, cropById, makeBetaSchedule, simulateField,
  truthAt, utmEnvelope, TMAX, coverStats, speciesChannel, meanPerSpecies,
  blockPlacement, buildBlockPlan, layoutKey,
  type BlockDesign, type FieldParams, type FieldSim, type PatternType, type SensorParams, type SimLayout,
} from './simulate';
import { aoiUtmOrigin, buildS2Grid, type LngLatBounds, type S2Grid } from './s2-grid';
import { fieldOverlapTest, type Poly } from './geometry';
import { cellInFieldTest } from './field-membership';
import { categoricalColors, distinctColors, lerpHex, mixN } from './util';
import { PCA_SAMPLE, RES_LADDER } from './sensors';
import { pixelId } from './pca-field';
import { importedTrialExtent, trialExtent } from './ladder';
import type { SweepStep } from './PcaSweep';
import type { useFieldGrid } from './use-grid';
import { arrayOf, inRange, isLngLat, isNum, oneOf, readSaved, shape, usePersistentState } from './persist';
import { MAX_IMPORT_PLOTS, tooManyVarieties, varietiesOf } from './design-import';
import { resolveImportedPlan } from './imported-plan';
import { isAligned, nearestTurn, rotateImportedPlan, shiftImportedPlan, stakeOnGrid, trialAngle } from './imported-rotate';
import type { ImportedDesign, ImportedPlan } from './imported-types';

/** Largest field the resolution ladder samples whole; bigger fields use a central window. */
const LADDER_MAX_CELLS = 40_000;

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
 * FIELD — never the viewport — and defers itself behind a timeout so a spinner
 * can paint first.
 *
 * Load-bearing, and very easy to "tidy" into a performance bug:
 *
 *  - `layout` and `sensor` are fresh object literals on every render and are
 *    deliberately absent from every dependency array; the primitives plus
 *    `sensorSig` stand in for them. Memoize them and add them to deps, and
 *    `simulateField` re-runs on every render — a few-hundred-millisecond freeze
 *    per keystroke, byte-identical output, invisible to every gate.
 *  - `patternOrigin` is computed exactly ONCE, here, and shared by the map
 *    overlay, the canvas visual, the field sim and the PCA. A second copy makes
 *    the drawn pattern drift from the simulated one.
 *  - `runSweep`'s deps are all primitives on purpose: pass an object and the
 *    250 ms debounce re-arms every render, so the sweep never settles.
 *  - `simStyle` / `fieldOutlineStyle` are re-created per render on purpose —
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
  // Always on: plants slide to max purity. The switch left the UI, so a saved
  // "off" must not linger where nobody can turn it back on.
  const [optimizePlacement, setOptimizePlacement] = useState(true);
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

  // The two-crop aliases, now expressed through the indexed setters so there is
  // ONE write path rather than three that can drift apart.
  const cropA = species[0], cropB = species[1];
  const setCropA = useCallback((c: FieldParams) => setSpeciesAt(0, c), [setSpeciesAt]);
  const setCropB = useCallback((c: FieldParams) => setSpeciesAt(1, c), [setSpeciesAt]);
  const presetA = presets[0], presetB = presets[1];
  const setPresetA = useCallback((id: string) => setPresetAt(0, id), [setPresetAt]);
  const setPresetB = useCallback((id: string) => setPresetAt(1, id), [setPresetAt]);
  const [magnitude, setMagnitude] = usePersistentState('magnitude', 0.04, inRange(0, 0.15));
  const [alpha, setAlpha] = usePersistentState('alpha', 2, inRange(0.1, 10));
  const [beta, setBeta] = usePersistentState('beta', 2, inRange(0.1, 10));
  // 100% by default: a pixel counts as pure only if it is entirely one crop.
  // The repo engine's own default is 80%, which flatters the design — it calls a
  // pixel "pure maize" when a fifth of it is wheat. Start strict; the slider in
  // "Noise & purity threshold" relaxes it.
  const [threshold, setThreshold] = usePersistentState('threshold', 100, inRange(50, 100));
  const [day] = useState(196);
  const [simView] = useState<'mixture' | 'purity' | 'ndvi'>('mixture');

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
  const [importedDesign, setImportedDesign] = usePersistentState<ImportedDesign | null>('importedDesign', null, isImportedDesign);
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
    return buildBlockPlan(blockDesign, blockPlacement(fieldBounds, fieldOrigin, rotation, pixelSize, optimizePlacement));
  }, [pattern, fieldBounds?.join(','), fieldOrigin?.[0], fieldOrigin?.[1], rotation, pixelSize, optimizePlacement,
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
   * Curves are never touched — only colour and label.
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

  // Two-species aliases. distinctColors gives the first claimer the colour it
  // asked for, so colors[0] is always cropA's own and these keep the exact
  // meaning the call sites were written against.
  const dupSpecies = cropA.color.toLowerCase() === cropB.color.toLowerCase();
  const colB = colors[1];
  const nameA = names[0], nameB = names[1];
  const cropAd = speciesD[0], cropBd = speciesD[1];

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
           optimizePlacement, setOptimizePlacement,
           species, setSpecies, presets, setPresets, colors, names, speciesD, nActive,
           presetsActive, setSpeciesAt: setSpeciesAtAny, setPresetAt: setPresetAtAny,
           importedDesign, setImportedDesign, importedCurves, setImportedCurves, varieties,
           importedPlan, importedBasePlan: imported.plan, importedError: imported.error,
           importedTurn, setImportedTurn, importedShift, setImportedShift, importedFileAngle, importedAngle,
           cropA, setCropA, cropB, setCropB,
           presetA, setPresetA, presetB, setPresetB, magnitude, setMagnitude,
           alpha, setAlpha, beta, setBeta, threshold, setThreshold, day, simView,
           blockDesign, setBlockDesign, blockPlan,
           layout, layoutSig, sensor, sensorSig, dupSpecies, colB, nameA, nameB, cropAd, cropBd, cropSig };
}

export type Experiment = ReturnType<typeof useExperiment>;

/** What the chosen sensor makes of the design, over the rendered grid. */
export function useSimulation({ aoi, aoiPoly, gridApi, exp, simOn, fieldOrigin }: {
  aoi: LngLatBounds | null; aoiPoly: Poly | null; gridApi: GridApi; exp: Experiment; simOn: boolean;
  /** The field corner, computed once in the shell and shared with useExperiment. */
  fieldOrigin: [number, number] | null;
}) {
  const { renderGrid, build, } = gridApi;
  const { pattern, stripWidth, spacing, rotation, optimizePlacement, threshold, layout, layoutSig, sensor,
          sensorSig, cropA, cropB, colB, simView, day, magnitude, alpha, beta, speciesD, colors, cropSig } = exp;

  // Pattern origin: the field corner, optionally slid to the phase that maximises
  // pure pixels (strip edges land on pixel edges). `offset` = [along-row, cross-row] m.
  const patternOrigin = useMemo((): { origin: [number, number]; offset: [number, number] } | null => {
    if (!aoi || !build?.epsg || !fieldOrigin) return null;
    // The SAME corner the block plan was anchored on. Recomputing it here would
    // be two sources for one number, which is how the drawn and the simulated
    // pattern drift apart.
    const base = fieldOrigin;
    if (!optimizePlacement) return { origin: base, offset: [0, 0] };
    const [du, dv] = bestPhaseOffset(pattern, build.res, stripWidth, spacing, threshold / 100, base[0], base[1]);
    const t = (rotation * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    return { origin: [base[0] + du * cos - dv * sin, base[1] + du * sin + dv * cos] as [number, number], offset: [du, dv] as [number, number] };
    // layoutSig rather than the loose primitives: it also covers the block
    // design, whose seed, plot size and alleys move none of them.
  }, [aoi, build?.epsg, build?.res, optimizePlacement, layoutSig, threshold, fieldOrigin?.[0], fieldOrigin?.[1]]);

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
  const simStyle = (f: number, bare: number, mx: number, sp?: number[], off = 0) => {
    const fr = sp && sp.length ? sp : [f, Math.max(0, 1 - f - bare)];
    let color: string;
    if (simView === 'purity') {
      // OFF_TRIAL is not a pure pixel. It is ground the trial never covered, and
      // falling through to green claimed a clean crop reading over land that
      // holds no experiment at all, which for a block design is most of the field.
      color = mx === MIXED ? '#ef4444'
        : mx === BARE.id ? BARE.color
        : mx === OFF_TRIAL.id ? OFF_TRIAL.color
        : '#22c55e';
    } else if (simView === 'ndvi') {
      let ndvi = bare * BARE.ndvi + off * OFF_TRIAL.ndvi;
      for (let i = 0; i < fr.length; i++) ndvi += fr[i] * truthAt(speciesD[i] ?? speciesD[0], day);
      color = lerpHex('#5b4129', '#15803d', Math.max(0, Math.min(1, ndvi)));
    } else {
      // The off-trial fraction is a WEIGHT, not a leftover. Without it a pixel
      // outside the trial has an all-zero species vector, mixN skips every zero,
      // and the blend divides by `w || 1` and paints it solid black. On a block
      // design that is most of the field.
      color = mixN(fr, colors, bare, off);
    }
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
    // The pixels overlapping the field, by the one rule the page uses (field-membership.ts).
    const inField = cellInFieldTest(aoiPoly, renderGrid.epsg, renderGrid.res);
    for (let k = 0; k < renderGrid.cells.length; k++) {
      const c = renderGrid.cells[k];
      if (inField && !inField(c)) continue;
      // The cell's own species composition travels WITH it. Reconstructing it at
      // paint time from a single "crop A fraction" is what limited the overlay
      // to two species.
      const sp = spAll ? Array.from(spAll.subarray(k * nSp, k * nSp + nSp)) : undefined;
      features.push({
        type: 'Feature' as const,
        // col/row identify the pixel, so "In field only" can hide it by the same
        // key the in-field pixel list uses.
        properties: { col: c.col, row: c.row, f: sim.proportionA[k], b: sim.proportionBare[k], mx: sim.mixed[k], sp, off: offAll ? offAll[k] : 0 },
        geometry: { type: 'Polygon' as const, coordinates: [c.ring] },
      });
    }
    return { type: 'FeatureCollection' as const, features };
  }, [sim, renderGrid, aoiPoly]);

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
      : `${cropA.name} × ${cropB.name} · ${stripWidth} m ${PATTERNS.find(p => p.id === pattern)?.label.toLowerCase() ?? ''}`;

  return { patternOrigin, sim, ndviSeries, simStyle, fieldOutlineStyle, simGeojson, simSummary };
}

/** The PCA — always over the FIELD, never the viewport — plus the resolution sweep. */
export function usePcaSim({ aoi, aoiPoly, gridApi, exp, patternOrigin, activeStep, compareAligned, mapSim }: {
  aoi: LngLatBounds | null; aoiPoly: Poly | null; gridApi: GridApi; exp: Experiment;
  patternOrigin: { origin: [number, number]; offset: [number, number] } | null;
  activeStep: 'area' | 'grid' | 'sim' | 'pca' | null;
  /** Also compute the ladder at 0° so the two can be shown side by side. */
  compareAligned: boolean;
  /** The map's simulation of `renderGrid`, reused when the PCA runs on that same grid. */
  mapSim: FieldSim | null;
}) {
  const { grid, renderGrid, build, buildOpts, sigmaX, sigmaY, psfOffX, psfOffY } = gridApi;
  const { pattern, stripWidth, spacing, rotation, optimizePlacement, threshold, sensorSig, layout, layoutSig, blockDesign,
          importedAngle, importedFileAngle, importedBasePlan, importedTurn } = exp;
  const [selectedPixels, setSelectedPixels] = useState<number[]>([]); // pixels picked in the PCA → highlight on map

  // The PCA always runs on the field itself — the full grid when it fits, else a
  // central subsample of ~PCA_SAMPLE cells — so it works even when the grid is
  // too fine to render on the map.
  const pcaGrid = useMemo(() => {
    if (grid) return grid;
    if (!aoi || !buildOpts || !build?.utmBounds) return null;
    const [mnE, mnN, mxE, mxN] = build.utmBounds;
    const half = (build.res * Math.sqrt(PCA_SAMPLE)) / 2; // central square ≈ PCA_SAMPLE cells
    const cx = (mnE + mxE) / 2, cy = (mnN + mxN) / 2;
    const sMinE = Math.max(mnE, cx - half), sMaxE = Math.min(mxE, cx + half);
    const sMinN = Math.max(mnN, cy - half), sMaxN = Math.min(mxN, cy + half);
    const inv = proj4(crsToProj4Def(`EPSG:${build.epsg}`), 'EPSG:4326');
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [E, N] of [[sMinE, sMinN], [sMaxE, sMinN], [sMaxE, sMaxN], [sMinE, sMaxN]] as [number, number][]) {
      const [lng, lat] = inv.forward([E, N]); w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat);
    }
    return buildS2Grid(aoi, { ...buildOpts, clip: [w, s, e, n], maxCells: PCA_SAMPLE * 4 }).grid;
  }, [grid, aoi, buildOpts, build]);

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
      const sim = sharedSim ?? simulateField(pcaGrid, patternOrigin.origin, layoutL, sensorL);
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
    if (!aoiPoly) return whole();
    const keep: number[] = [];
    const inField = cellInFieldTest(aoiPoly, runGrid.epsg, runGrid.res)!;
    for (let k = 0; k < cells.length; k++) if (inField(cells[k])) keep.push(k);
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
      purePct: st.purePct, pureBare: st.pureBare, total: st.total, meanPropA: n ? sumP / n : 0.5,
      nSpecies: nSp, pureBySpecies: st.pureBySpecies,
      meanBySpecies: meanPerSpecies(sp, nSp, n, off),
      proportionBySpecies: sp,
      proportionOffTrial: off,
      pureA: st.pureBySpecies[0], pureB: st.pureBySpecies[1],
    };
    return { sim, cellIndex: keep, grid: runGrid, res: runGrid.res, subsampled };
  }, [pcaRun, aoiPoly]);

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
  /**
   * The design as the ladder sees it: everything in layoutSig except the corner
   * the current plan was snapped to. That corner follows the DISPLAYED pixel size,
   * so keying the ladder on it rebuilt every rung on every thumbnail click, while
   * each rung snaps its own plan anyway (see stepAt).
   */
  const ladderSig = layout.block ? layoutKey({ ...layout, block: { ...layout.block, u0: 0, v0: 0 } }) : layoutSig;
  /**
   * ONE resolution of the ladder at a GIVEN rotation, the unit the sweep is split
   * into. Parameterised by rotation so the comparison at 0° runs the identical code.
   * Pure and synchronous. Depends on the field, the design and the sensor, and on
   * nothing about the resolution currently displayed, which is what lets the rungs
   * be kept between clicks.
   */
  const stepAt = useCallback((rotationDeg: number, r: number): SweepStep | null => {
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
    if (optimizePlacement && layout.pattern !== 'block' && layout.pattern !== 'imported') {
      const [du, dv] = bestPhaseOffset(pattern, r, stripWidth, spacing, threshold / 100, base[0], base[1]);
      ox = base[0] + du * cos - dv * sin; oy = base[1] + du * sin + dv * cos;
    }
    /**
     * The WHOLE FIELD, on pixels snapped to multiples of r, keeping the pixels
     * whose centre is inside the field: the same rule the big scatter, the pixel
     * count and the export use.
     */
    let e0 = Math.floor(minE / r) * r, n0 = Math.floor(minN / r) * r;
    let e1 = Math.ceil(maxE / r) * r, n1 = Math.ceil(maxN / r) * r;
    /** Pixels counted are those whose centre is inside this ring (UTM), else inside the field. */
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
      let plan = layout.imported;
      const turn = nearestTurn(importedFileAngle, rotationDeg);
      if (Math.abs(rotationDeg - importedAngle) >= 1e-9 && importedBasePlan) {
        plan = rotateImportedPlan(importedBasePlan, turn);
        if (isAligned(importedFileAngle + turn)) plan = stakeOnGrid(plan, r, sensorL, [e0, n0, e1, n1]).plan;
      }
      if (plan) {
        layoutL = { ...layoutL, imported: plan };
        [e0, n0, e1, n1] = importedTrialExtent(plan, r, sensorL, [e0, n0, e1, n1]);
        // Counted over its OWN outline: the drawn trial's would cut the corners
        // off a turned one, and the two ladders must count by the same rule.
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
      const plan = buildBlockPlan(blockDesign, blockPlacement([e0, n0, e1, n1], base, rotationDeg, r, optimizePlacement));
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
    const ringUtm = trialRing ?? (aoiPoly ? aoiPoly.map(([lng, lat]) => toUtm.forward([lng, lat]) as [number, number]) : null);
    // Pixels overlapping the ring, by the rule the whole page uses (geometry.ts).
    const overlaps = ringUtm ? fieldOverlapTest(ringUtm) : null;
    const keep: number[] = [];
    for (let k = 0; k < all.mixed.length; k++) {
      // Cells run row by row from the south, west to east within a row.
      if (!overlaps || overlaps(e0 + (k % nx) * r, n0 + Math.floor(k / nx) * r, r)) keep.push(k);
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
      pixelIds[j] = pixelId(Math.round((e0 + (k % nx) * r) / r), Math.round((n0 + Math.floor(k / nx) * r) / r));
    });
    const st = coverStats({ mixed, coverSpecies: speciesChannel(layoutL).coverSpecies, nSpecies: nSp, offTrial: proportionOffTrial });
    return { res: r, proportionA, proportionBare, purePct: st.purePct, pureCount: st.pureCrop, trialCount: st.total,
             proportionBySpecies, nSpecies: nSp, proportionOffTrial, pixelIds, partial };
    // ladderSig covers the whole design, block parameters included; blockDesign's
    // fields are all in it.
  }, [aoi, aoiPoly, build?.epsg, ladderSig, optimizePlacement, sigmaX, sigmaY, psfOffX, psfOffY, threshold]); // eslint-disable-line react-hooks/exhaustive-deps

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
      s = { res: r, proportionA: new Float32Array(0), proportionBare: new Float32Array(0), proportionBySpecies: null,
            proportionOffTrial: null, nSpecies: 0, purePct: NaN, current: true };
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
    const angle = layout.pattern === 'imported' ? importedAngle : rotation;
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
        let step = cache.get(`${rot}|${r}`) ?? null;
        if (!step && which === 0 && isCurrent(r)) {
          // The current resolution's thumbnail draws the big scatter's own
          // simulation (PcaSweep swaps it in), so it is not simulated here now:
          // at 0.5 m it is the most expensive rung. Built once the page is idle.
          step = stubFor(r);
        } else if (!step) {
          setSweepBusy(true);
          step = stepAt(rot, r);
          if (step) cache.set(`${rot}|${r}`, step);
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
        const made = stepAt(angle, stub.res);
        if (made) {
          cache.set(`${angle}|${stub.res}`, made);
          setSweep(prev => (prev ? prev.map(s => (s === stub ? made : s)) : prev));
        }
        if (pending.length) idle(fill);
      };
      idle(fill);
    };
    setTimeout(next, 30);
  }, [aoi, build?.epsg, build?.res, rotation, compareAligned, stepAt, layout.pattern, importedAngle]); // eslint-disable-line react-hooks/exhaustive-deps
  // Auto-recompute whenever an input that feeds the sweep changes — no button click
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

  // The chart on screen ran on a central subsample, not the whole field.
  const pcaSubsampled = !!pcaView?.subsampled;
  const pcaSim = pcaRun?.sim ?? null;

  return { pcaGrid, pcaSim, pcaBusy, pcaView, pcaSubsampled, selectedPixels, setSelectedPixels,
           selectionGeojson, sweep, sweepAligned, sweepBusy };
}
