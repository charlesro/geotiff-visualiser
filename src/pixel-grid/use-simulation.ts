import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import {
  BARE, CROP_PRESETS, PATTERNS, TRUTH_TYPES, bestPhaseOffset, cropById, makeBetaSchedule, simulateField, simulatePatch,
  truthAt, utmEnvelope, TMAX,
  type FieldParams, type FieldSim, type PatternType, type SensorParams, type SimLayout,
} from './simulate';
import { aoiUtmOrigin, buildS2Grid, type LngLatBounds } from './s2-grid';
import { cellCenter, pointInPoly, type Poly } from './geometry';
import { lerpHex, mix3 } from './util';
import { PCA_SAMPLE, RES_LADDER } from './sensors';
import type { SweepStep } from './PcaSweep';
import type { useFieldGrid } from './use-grid';
import { inRange, isNum, oneOf, usePersistentState } from './persist';

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
export function useExperiment({ sigmaX, sigmaY }: { sigmaX: number; sigmaY: number }) {
  // Experiment simulation (repo parameter set)
  const [pattern, setPattern] = usePersistentState<PatternType>('pattern', 'row', oneOf(...PATTERNS.map(p => p.id)));
  const [stripWidth, setStripWidth] = usePersistentState('stripWidth', 3, inRange(0.01, 1000));
  const [spacing, setSpacing] = usePersistentState('spacing', 0, inRange(0, 1000));
  const [rotation, setRotation] = usePersistentState('rotation', 0, inRange(0, 90));
  // Always on: plants slide to max purity. The switch left the UI, so a saved
  // "off" must not linger where nobody can turn it back on.
  const [optimizePlacement, setOptimizePlacement] = useState(true);
  const [cropA, setCropA] = usePersistentState<FieldParams>('cropA', () => cropById('maize'), isFieldParams);
  const [cropB, setCropB] = usePersistentState<FieldParams>('cropB', () => cropById('wheat'), isFieldParams);
  const [presetA, setPresetA] = usePersistentState('presetA', 'maize', isPreset);
  const [presetB, setPresetB] = usePersistentState('presetB', 'wheat', isPreset);
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

  // ----- experiment simulation (repo engine over the real grid) -----
  const layout: SimLayout = { pattern, width: stripWidth, spacing, rotationDeg: rotation };
  const sensor: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100 };
  const sensorSig = `${sigmaX}_${sigmaY}_${threshold}`;

  // Same species picked for both (to tweak one parameter and compare) → recolour B
  // so the two are still distinguishable everywhere. Curves/names are untouched.
  const dupSpecies = cropA.color.toLowerCase() === cropB.color.toLowerCase();
  const colB = dupSpecies
    ? (['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00'].find(c => c !== cropA.color.toLowerCase()) ?? '#0072b2')
    : cropB.color;
  const nameA = dupSpecies ? `${cropA.name} (A)` : cropA.name;
  const nameB = dupSpecies ? `${cropB.name} (B)` : cropB.name;
  // Memoised so the memoised chart components see the same object and can skip
  // redrawing when nothing about the crops changed.
  const cropAd = useMemo<FieldParams>(() => (dupSpecies ? { ...cropA, name: nameA } : cropA), [cropA, dupSpecies, nameA]);
  const cropBd = useMemo<FieldParams>(() => (dupSpecies ? { ...cropB, color: colB, name: nameB } : cropB), [cropB, dupSpecies, colB, nameB]);

  const fsig = (c: FieldParams) => `${c.truth}_${c.L1}_${c.k1}_${c.x01}_${c.k2}_${c.x02}_${c.tc}`;
  const cropSig = `${cropA.color}${colB}-${fsig(cropA)}-${fsig(cropB)}`;

  return { pattern, setPattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation,
           optimizePlacement, setOptimizePlacement, cropA, setCropA, cropB, setCropB,
           presetA, setPresetA, presetB, setPresetB, magnitude, setMagnitude,
           alpha, setAlpha, beta, setBeta, threshold, setThreshold, day, simView,
           layout, sensor, sensorSig, dupSpecies, colB, nameA, nameB, cropAd, cropBd, cropSig };
}

export type Experiment = ReturnType<typeof useExperiment>;

/** What the chosen sensor makes of the design, over the rendered grid. */
export function useSimulation({ aoi, aoiPoly, gridApi, exp, simOn }: {
  aoi: LngLatBounds | null; aoiPoly: Poly | null; gridApi: GridApi; exp: Experiment; simOn: boolean;
}) {
  const { renderGrid, build, } = gridApi;
  const { pattern, stripWidth, spacing, rotation, optimizePlacement, threshold, layout, sensor,
          sensorSig, cropA, cropB, colB, simView, day, magnitude, alpha, beta } = exp;

  // Pattern origin: the field corner, optionally slid to the phase that maximises
  // pure pixels (strip edges land on pixel edges). `offset` = [along-row, cross-row] m.
  const patternOrigin = useMemo((): { origin: [number, number]; offset: [number, number] } | null => {
    if (!aoi || !build?.epsg) return null;
    const base = aoiUtmOrigin(aoi, build.epsg);
    if (!optimizePlacement) return { origin: base, offset: [0, 0] };
    const [du, dv] = bestPhaseOffset(pattern, build.res, stripWidth, spacing, threshold / 100, base[0], base[1]);
    const t = (rotation * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    return { origin: [base[0] + du * cos - dv * sin, base[1] + du * sin + dv * cos] as [number, number], offset: [du, dv] as [number, number] };
  }, [aoi, build?.epsg, build?.res, optimizePlacement, pattern, stripWidth, spacing, threshold, rotation]);

  const sim = useMemo(
    () => (simOn && renderGrid && patternOrigin ? simulateField(renderGrid, patternOrigin.origin, layout, sensor) : null),
    [simOn, renderGrid, patternOrigin, pattern, stripWidth, spacing, rotation, sensorSig],
  );

  const ndviSeries = useMemo(() => {
    if (!simOn) return null;
    const m = sim?.meanPropA ?? 0.5;
    const varSched = makeBetaSchedule(TMAX, alpha, beta, magnitude);
    const pts: { day: number; A: number; B: number; mix: number; lo: number; hi: number }[] = [];
    for (let d = 0; d <= 365; d += 5) {
      const a = truthAt(cropA, d), b = truthAt(cropB, d);
      const mix = m * a + (1 - m) * b;
      const vmax = Math.max(0, mix * (1 - mix));
      const sd = Math.sqrt(Math.min(varSched[d] ?? 0, vmax));
      pts.push({ day: d, A: +a.toFixed(3), B: +b.toFixed(3), mix: +mix.toFixed(3), lo: +Math.max(0, mix - sd).toFixed(3), hi: +Math.min(1, mix + sd).toFixed(3) });
    }
    return pts;
  }, [simOn, sim, cropA, cropB, magnitude, alpha, beta]);

  /** Sim cell colour by view mode (no per-cell borders — they read as noise).
   *  f = crop-A fraction, bare = bare-soil fraction; crop-B fraction = 1−f−bare. */
  const simStyle = (f: number, bare: number, mx: number) => {
    const pB = Math.max(0, 1 - f - bare);
    let color: string;
    if (simView === 'purity') {
      color = mx === 255 ? '#ef4444' : mx === BARE.id ? BARE.color : '#22c55e';
    } else if (simView === 'ndvi') {
      const ndvi = f * truthAt(cropA, day) + pB * truthAt(cropB, day) + bare * BARE.ndvi;
      color = lerpHex('#5b4129', '#15803d', Math.max(0, Math.min(1, ndvi)));
    } else {
      // continuous mixture: fraction-weighted blend of crop A / crop B / bare soil
      color = mix3(f, pB, bare, cropA.color, colB);
    }
    return { stroke: true, color: '#000', weight: 0.6, opacity: 0.55, fillColor: color, fillOpacity: 0.8, interactive: false } as L.PathOptions;
  };
  /** "Real field" mode: transparent cells (the true pattern shows through) with
   *  just the grid outline. */
  const fieldOutlineStyle = () =>
    ({ stroke: true, color: '#0b0e11', weight: 1.6, opacity: 0.9, fill: false, interactive: false }) as L.PathOptions;
  const simGeojson = useMemo(() => {
    if (!sim || !renderGrid) return null;
    const features = [];
    for (let k = 0; k < renderGrid.cells.length; k++) {
      const c = renderGrid.cells[k];
      if (aoiPoly) { const [lng, lat] = cellCenter(c.ring); if (!pointInPoly(lng, lat, aoiPoly)) continue; }
      features.push({
        type: 'Feature' as const,
        properties: { f: sim.proportionA[k], b: sim.proportionBare[k], mx: sim.mixed[k] },
        geometry: { type: 'Polygon' as const, coordinates: [c.ring] },
      });
    }
    return { type: 'FeatureCollection' as const, features };
  }, [sim, renderGrid, aoiPoly]);

  const simSummary = !aoi
    ? 'needs an area'
    : `${cropA.name} × ${cropB.name} · ${stripWidth} m ${PATTERNS.find(p => p.id === pattern)?.label.toLowerCase() ?? ''}`;

  return { patternOrigin, sim, ndviSeries, simStyle, fieldOutlineStyle, simGeojson, simSummary };
}

/** The PCA — always over the FIELD, never the viewport — plus the resolution sweep. */
export function usePcaSim({ aoi, aoiPoly, gridApi, exp, patternOrigin, activeStep, compareAligned }: {
  aoi: LngLatBounds | null; aoiPoly: Poly | null; gridApi: GridApi; exp: Experiment;
  patternOrigin: { origin: [number, number]; offset: [number, number] } | null;
  activeStep: 'area' | 'grid' | 'sim' | 'pca' | null;
  /** Also compute the ladder at 0° so the two can be shown side by side. */
  compareAligned: boolean;
}) {
  const { grid, build, buildOpts, sigmaX, sigmaY } = gridApi;
  const { pattern, stripWidth, spacing, rotation, optimizePlacement, threshold, sensorSig } = exp;
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

  // Deferred so a spinner can paint before the (few-hundred-ms) aggregate runs.
  const [pcaSim, setPcaSim] = useState<FieldSim | null>(null);
  const [pcaBusy, setPcaBusy] = useState(false);
  useEffect(() => {
    if (activeStep !== 'pca' || !pcaGrid || !patternOrigin) { setPcaSim(null); setPcaBusy(false); return; }
    setPcaBusy(true);
    const id = setTimeout(() => {
      const layoutL: SimLayout = { pattern, width: stripWidth, spacing, rotationDeg: rotation };
      const sensorL: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100 };
      setPcaSim(simulateField(pcaGrid, patternOrigin.origin, layoutL, sensorL));
      setPcaBusy(false);
    }, 30);
    return () => clearTimeout(id);
  }, [activeStep, pcaGrid, patternOrigin, pattern, stripWidth, spacing, rotation, sensorSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // The PCA runs on the full bbox grid; restrict it to pixels INSIDE the traced
  // field so the scatter (and click/lasso → map highlight) only ever hits real
  // field pixels. `cellIndex[j]` maps a scatter point back to its pcaGrid cell.
  const pcaView = useMemo((): { sim: FieldSim; cellIndex: number[] | null } | null => {
    if (!pcaSim || !pcaGrid) return null;
    if (!aoiPoly) return { sim: pcaSim, cellIndex: null };
    const cells = pcaGrid.cells;
    const keep: number[] = [];
    for (let k = 0; k < cells.length; k++) { const [lng, lat] = cellCenter(cells[k].ring); if (pointInPoly(lng, lat, aoiPoly)) keep.push(k); }
    if (!keep.length || keep.length === cells.length) return { sim: pcaSim, cellIndex: null }; // all-in or degenerate → no remap
    const n = keep.length;
    const pA = new Float32Array(n), pBare = new Float32Array(n), mixed = new Uint8Array(n);
    let pureA = 0, pureB = 0, pureBare = 0, sumP = 0;
    for (let j = 0; j < n; j++) {
      const k = keep[j];
      pA[j] = pcaSim.proportionA[k]; pBare[j] = pcaSim.proportionBare[k]; mixed[j] = pcaSim.mixed[k];
      sumP += pA[j];
      if (mixed[j] === 0) pureA++; else if (mixed[j] === 1) pureB++; else if (mixed[j] === BARE.id) pureBare++;
    }
    const sim: FieldSim = { proportionA: pA, proportionBare: pBare, mixed, purePct: (100 * (pureA + pureB)) / n, pureA, pureB, pureBare, total: n, meanPropA: sumP / n };
    return { sim, cellIndex: keep };
  }, [pcaSim, pcaGrid, aoiPoly]);

  // Cells the user picked in the PCA scatter (click / lasso), as map polygons.
  const selectionGeojson = useMemo(() => {
    if (!pcaGrid || !selectedPixels.length) return null;
    const cells = pcaGrid.cells;
    const idxMap = pcaView?.cellIndex;
    const features = selectedPixels
      .map(j => (idxMap ? idxMap[j] : j))
      .filter(k => k != null && k >= 0 && k < cells.length)
      .map(k => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [cells[k].ring] } }));
    return features.length ? { type: 'FeatureCollection' as const, features } : null;
  }, [pcaGrid, selectedPixels, pcaView]);

  // Resolution sweep: PCA at every pixel size in RES_LADDER.
  const [sweep, setSweep] = useState<SweepStep[] | null>(null);
  const [sweepAligned, setSweepAligned] = useState<SweepStep[] | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);
  /**
   * ONE resolution of the ladder at a GIVEN rotation — the unit the sweep is split
   * into. Parameterised by rotation so the comparison at 0° runs the identical code.
   * Pure and synchronous (~15-50 ms, much less once the placement is cached).
   */
  const stepAt = useCallback((rotationDeg: number, r: number): SweepStep | null => {
    if (!aoi || !build?.epsg) return null;
    const epsg = build.epsg;
    const layoutL: SimLayout = { pattern, width: stripWidth, spacing, rotationDeg };
    const sensorL: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100 };
    const [minE, minN, maxE, maxN] = utmEnvelope(aoi, epsg);
    const cx = (minE + maxE) / 2, cy = (minN + maxN) / 2;
    const fieldMin = Math.min(maxE - minE, maxN - minN);
    const base = aoiUtmOrigin(aoi, epsg);
    const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    // Each size gets its own purity-optimal placement (matches the map when picked).
    let ox = base[0], oy = base[1];
    if (optimizePlacement) {
      const [du, dv] = bestPhaseOffset(pattern, r, stripWidth, spacing, threshold / 100, base[0], base[1]);
      ox = base[0] + du * cos - dv * sin; oy = base[1] + du * sin + dv * cos;
    }
    const sizeM = Math.min(fieldMin, Math.max(r * 40, 20)); // ~40 px/side, bounded by the field
    const p = simulatePatch(cx - sizeM / 2, cy - sizeM / 2, sizeM, r, ox, oy, layoutL, sensorL);
    return { res: r, proportionA: p.proportionA, proportionBare: p.proportionBare, purePct: p.purePct };
  }, [aoi, build?.epsg, pattern, stripWidth, spacing, optimizePlacement, sigmaX, sigmaY, threshold]);

  // Bumped by every new run and every cancellation. A chunk that finds it changed
  // stops without writing, so a stale ladder can never land after a newer one.
  const sweepGen = useRef(0);

  const runSweep = useCallback(() => {
    if (!aoi || !build?.epsg) return;
    const gen = ++sweepGen.current;
    setSweepBusy(true);
    // The comparison run: the same design with the strips along the pixel rows.
    // Only computed while the user asks for it, and pointless at 0°.
    const wantAligned = compareAligned && rotation !== 0;
    const jobs: [number, number, 0 | 1][] = [
      ...RES_LADDER.map(r => [rotation, r, 0] as [number, number, 0]),
      ...(wantAligned ? RES_LADDER.map(r => [0, r, 1] as [number, number, 1]) : []),
    ];
    const cur: SweepStep[] = [], al: SweepStep[] = [];
    let i = 0;
    // One resolution per task, yielding to the browser in between. The whole
    // ladder used to run as ONE task (~0.5 s, ~0.9 s with "vs aligned"), during
    // which the page could not even echo a keystroke. The result is still
    // committed once at the end, so the panels never show a half-updated ladder.
    const next = () => {
      if (gen !== sweepGen.current) return;
      const [rot, r, which] = jobs[i++];
      const step = stepAt(rot, r);
      if (step) (which ? al : cur).push(step);
      if (i < jobs.length) { setTimeout(next, 0); return; }
      setSweep(cur);
      setSweepAligned(wantAligned ? al : null);
      setSweepBusy(false);
    };
    setTimeout(next, 30);
  }, [aoi, build?.epsg, rotation, compareAligned, stepAt]);
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

  const pcaSubsampled = !grid && !!pcaGrid; // PCA ran on a central subsample, not the whole field

  return { pcaGrid, pcaSim, pcaBusy, pcaView, pcaSubsampled, selectedPixels, setSelectedPixels,
           selectionGeojson, sweep, sweepAligned, sweepBusy };
}
