import { useCallback, useEffect, useMemo, useState } from 'react';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import {
  BARE, PATTERNS, bestPhaseOffset, cropById, makeBetaSchedule, simulateField, simulatePatch,
  truthAt, utmEnvelope, TMAX,
  type FieldParams, type FieldSim, type PatternType, type SensorParams, type SimLayout,
} from './simulate';
import { aoiUtmOrigin, buildS2Grid, type LngLatBounds } from './s2-grid';
import { cellCenter, pointInPoly, type Poly } from './geometry';
import { fmtM, lerpHex, mix3 } from './util';
import { PCA_SAMPLE, RES_LADDER } from './sensors';
import type { SweepStep } from './PcaSweep';
import type { useFieldGrid } from './use-grid';

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
  const [pattern, setPattern] = useState<PatternType>('row');
  const [stripWidth, setStripWidth] = useState(3);
  const [spacing, setSpacing] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [optimizePlacement, setOptimizePlacement] = useState(true); // slide plants to max purity
  const [cropA, setCropA] = useState<FieldParams>(() => cropById('maize'));
  const [cropB, setCropB] = useState<FieldParams>(() => cropById('wheat'));
  const [presetA, setPresetA] = useState('maize');
  const [presetB, setPresetB] = useState('wheat');
  const [magnitude, setMagnitude] = useState(0.04);
  const [alpha, setAlpha] = useState(2);
  const [beta, setBeta] = useState(2);
  // 100% by default: a pixel counts as pure only if it is entirely one crop.
  // The repo engine's own default is 80%, which flatters the design — it calls a
  // pixel "pure maize" when a fifth of it is wheat. Start strict; the slider in
  // "Noise & purity threshold" relaxes it.
  const [threshold, setThreshold] = useState(100);
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
  const cropAd: FieldParams = dupSpecies ? { ...cropA, name: nameA } : cropA;
  const cropBd: FieldParams = dupSpecies ? { ...cropB, color: colB, name: nameB } : cropB;

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
  // Concrete planting instruction: how far to shift the pattern from the SW corner.
  const placementShift = useMemo(() => {
    if (!patternOrigin || !optimizePlacement) return null;
    const P = stripWidth + Math.max(0, spacing);
    const norm = (d: number) => ((d % P) + P) % P;
    const [du, dv] = patternOrigin.offset;
    if (pattern === 'checker') return `${fmtM(norm(du))} along the rows × ${fmtM(norm(dv))} across them`;
    if (pattern === 'col' || pattern === 'strip-col-2') return `${fmtM(norm(du))} across the columns`;
    return `${fmtM(norm(dv))} across the rows`;
  }, [patternOrigin, optimizePlacement, pattern, stripWidth, spacing]);

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

  return { patternOrigin, placementShift, sim, ndviSeries, simStyle, fieldOutlineStyle, simGeojson, simSummary };
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
   * One resolution ladder at a GIVEN rotation. Parameterised rather than reading
   * `rotation` directly so the same code can produce the comparison run at 0°.
   * Synchronous and pure — the callers own the busy flags and the deferral.
   */
  const sweepAt = useCallback((rotationDeg: number): SweepStep[] | null => {
    if (!aoi || !build?.epsg) return null;
    const epsg = build.epsg;
    const layoutL: SimLayout = { pattern, width: stripWidth, spacing, rotationDeg };
    const sensorL: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100 };
    const [minE, minN, maxE, maxN] = utmEnvelope(aoi, epsg);
    const cx = (minE + maxE) / 2, cy = (minN + maxN) / 2;
    const fieldMin = Math.min(maxE - minE, maxN - minN);
    const base = aoiUtmOrigin(aoi, epsg);
    const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    return RES_LADDER.map(r => {
      // Each size gets its own purity-optimal placement (matches the map when picked).
      let ox = base[0], oy = base[1];
      if (optimizePlacement) {
        const [du, dv] = bestPhaseOffset(pattern, r, stripWidth, spacing, threshold / 100, base[0], base[1]);
        ox = base[0] + du * cos - dv * sin; oy = base[1] + du * sin + dv * cos;
      }
      const sizeM = Math.min(fieldMin, Math.max(r * 40, 20)); // ~40 px/side, bounded by the field
      const p = simulatePatch(cx - sizeM / 2, cy - sizeM / 2, sizeM, r, ox, oy, layoutL, sensorL);
      return { res: r, proportionA: p.proportionA, proportionBare: p.proportionBare, purePct: p.purePct };
    });
  }, [aoi, build?.epsg, pattern, stripWidth, spacing, optimizePlacement, sigmaX, sigmaY, threshold]);

  const runSweep = useCallback(() => {
    if (!aoi || !build?.epsg) return;
    setSweepBusy(true);
    // Defer so the "Computing…" state paints before the synchronous crunch.
    setTimeout(() => {
      setSweep(sweepAt(rotation));
      // The comparison run: the same design with the strips laid along the pixel
      // rows. Only computed while the user is asking for it, and pointless at 0°
      // where it would be the identical ladder.
      setSweepAligned(compareAligned && rotation !== 0 ? sweepAt(0) : null);
      setSweepBusy(false);
    }, 30);
  }, [aoi, build?.epsg, rotation, compareAligned, sweepAt]);
  // Auto-recompute whenever an input that feeds the sweep changes — no button click
  // needed. Debounced so dragging a slider doesn't refit on every frame. Only while
  // the PCA step is open (nothing else shows the sweep). The crop / noise params only
  // change the PCA embed, which PcaSweep redoes from the cached data (no refit here).
  useEffect(() => {
    if (activeStep !== 'pca') return;
    const id = setTimeout(runSweep, 250);
    return () => clearTimeout(id);
  }, [activeStep, runSweep]);

  const pcaSubsampled = !grid && !!pcaGrid; // PCA ran on a central subsample, not the whole field

  return { pcaGrid, pcaSim, pcaBusy, pcaView, pcaSubsampled, selectedPixels, setSelectedPixels,
           selectionGeojson, sweep, sweepAligned, sweepBusy };
}
