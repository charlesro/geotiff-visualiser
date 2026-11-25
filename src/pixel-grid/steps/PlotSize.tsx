import React, { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { fmt } from '../util';
import { fewestPure, imageCases, importedPlotBoxes, pureScales, purestOfPlots, purestShare, seatedTrial, type ImageCase, type Plot } from '../plot-size';
import { blockPlotCounts, type BlockCounts, type LadderContext } from '../ladder-step';
import type { Rung } from '../sensors';
import { FOOTPRINT_SIGMA } from '../simulate';
import { largestPlots } from '../suggest-design';
import { fieldAngle, trialFitsField } from '../trial-seat';
import type { StepProps } from './props';

/**
 * The plot size a trial needs, for the sensor of step 2 and the design of
 * step 3: the smallest plot, of the design's own shape, that keeps a given
 * number of pure pixels wherever the pixel grid falls.
 *
 * One column per reading of the geolocation error, because the three do not
 * agree and each answers a different use: images put back in place, the mean
 * over many images (the PHENET note's sigma_eff), and a pixel list that has to
 * hold in 9 images out of 10. See plot-size.ts for the model.
 *
 * The same card is shown in step 2, under the blur it follows from, and in
 * step 3, beside the plot dimensions it judges. It holds no setting of its
 * own: the count typed in its last row lives in the page shell.
 *
 * A fourth column, a "worst case" over the 204 placements' rotations, was
 * added and removed on 2026-11-24: it treated the geolocation error as blur,
 * so it came out below "9 images in 10" and the name misled.
 *
 * ON A KNOWN GRID (Sentinel-2, Landsat: a fixed lattice, "grid phase known"),
 * with the plots along the pixel rows, the trial is put where it does best,
 * as the page puts it on the map (asked for on 2026-11-24: "16 doesn't seem
 * correct for shift corrected", where the map showed about 25). The sizes are
 * then for a plot at its best place on the grid, which every plot of a trial
 * reaches when plot and alley come to a whole number of pixels; "Now" and
 * "Most in this field" count each plot of the trial where it falls, alleys and
 * all (plot-size.ts seatedTrial). A tasked sensor, a turned trial and a trial
 * read from a file keep the worst place of the grid.
 *
 * For a block trial on a field it also reads the question the other way
 * round: not "what size for so many pixels" but "the most pixels this parcel
 * can give", which is the largest plots with which the trial still fits the
 * field, and what a plot of that size keeps.
 *
 * A BLOCK TRIAL IS COUNTED BY THE ENGINE (2026-11-25, Neon's second review):
 * "Now" and "Most in this field" are the satellites table's own figures
 * (ladder-step.ts blockPlotCounts), the trial seated in the field and placed
 * on the lattice by "Place the trial for", as the map shows it. The card's
 * own search put the trial where each column did best, so on Sentinel-2 its
 * 40 m plots read 9 pure pixels where the map, placed for pixels that hold,
 * had 4. The sizes above stay the card's: what one plot needs at its best (or
 * worst) place. "Most in this field" weighs the largest plots at each angle,
 * and on a known grid along the rows the plots a whole number of pixels
 * apart, by the pixels the engine counts in the weakest plot, those "Place
 * the trial for" asks for first, the larger plot on a tie.
 */

/** What the design calls a plot, as the rectangle the calculation needs. */
interface DesignPlot {
  plot: Plot;
  /** A strip has no length: its rows count pure pixels across it. */
  strip: boolean;
  /** Angle between the plot's sides and the pixel rows, degrees. */
  angle: number;
  /** The plot as the design has it now, in words. */
  now: string;
  /** How a size is written: one side for a square or a strip, both otherwise. */
  write: (scale: number) => string;
  /** Sets the design to this scale of itself. Absent for a trial read from a file. */
  apply?: (scale: number) => void;
  /** How the plots repeat, for counting each where it falls on a known grid; absent for a turned trial or a file. */
  shape?: TrialShape;
}

/** The layout of a trial's plots: blocks as buildBlockPlan lays them, or one plot repeated at a pitch. */
type TrialShape =
  | { kind: 'blocks'; nSpecies: number; nBlocks: number; perRow: number; plotAlley: number; blockAlley: number }
  | { kind: 'every'; pitch: number; grid: boolean };

/** Plots repeated at a pitch are counted over this many along each axis: enough for every place on the lattice they come to. */
const REPEATS = 24;

/** The centres of a trial's plots of a x b in the trial's own frame, x along a (simulate.ts buildBlockPlan and blockPlots). */
function centresOf(shape: TrialShape, a: number, b: number): [number, number][] {
  const out: [number, number][] = [];
  if (shape.kind === 'every') {
    for (let i = 0; i < REPEATS; i++) {
      if (!shape.grid) { out.push([i * shape.pitch + a / 2, 0]); continue; }
      for (let j = 0; j < REPEATS; j++) out.push([i * shape.pitch + a / 2, j * shape.pitch + b / 2]);
    }
    return out;
  }
  const { nSpecies, nBlocks, perRow, plotAlley, blockAlley } = shape;
  const pitchU = a + blockAlley, pitchV = nSpecies * b + (nSpecies - 1) * plotAlley + blockAlley;
  for (let k = 0; k < nBlocks; k++) {
    const c = k % perRow, r = Math.floor(k / perRow);
    for (let q = 0; q < nSpecies; q++) out.push([c * pitchU + a / 2, r * pitchV + q * (b + plotAlley) + b / 2]);
  }
  return out;
}

/** Along the pixel rows: a turned trial puts its plots everywhere on the grid. */
const alongRows = (deg: number) => { const m = ((deg % 90) + 90) % 90; return m < 1e-6 || m > 90 - 1e-6; };

/** A dimension the design fields accept: up to the decimetre above, within their range. */
const fieldSize = (m: number) => Math.max(0.5, Math.min(1000, Math.ceil(m * 10 - 1e-6) / 10));
const one = (m: number) => (m >= 100 ? m.toFixed(0) : m.toFixed(1));

/** A trial "Most in this field" can propose: plots a x b m, so many blocks per row, at an angle. */
interface MostPick { a: number; b: number; perRow: number; angle: number }

/**
 * The engine's counts, kept: a turned trial on a fine sensor is some 50 ms a
 * count, and the card asks for "Now" and every pick of "Most in this field"
 * on each change of the design, most of which leave them as they were.
 */
const COUNTED = new Map<string, BlockCounts | null>();
const ringIds = new WeakMap<object, number>();
let nextRing = 1;
function countedKey(ctx: LadderContext, rung: Rung, angle: number): string {
  let ring = 0;
  if (ctx.fieldRing) { ring = ringIds.get(ctx.fieldRing) ?? nextRing++; ringIds.set(ctx.fieldRing, ring); }
  return JSON.stringify([ctx.aoi, ring, ctx.epsg, ctx.threshold, ctx.blockDesign, ctx.layout.width, ctx.layout.spacing,
    ctx.geoManual, ctx.geoProvider, ctx.placeFor, ctx.pageGeo ?? null, angle, rung.id, rung.res, rung.sigmaX, rung.sigmaY, rung.anyPosition]);
}
function countedOnce(ctx: LadderContext, rung: Rung, angle: number): BlockCounts | null {
  const key = countedKey(ctx, rung, angle);
  if (COUNTED.has(key)) return COUNTED.get(key)!;
  let out: BlockCounts | null = null;
  try { out = blockPlotCounts(ctx, angle, rung, { mean: true, centres: true }); } catch { out = null; }
  if (COUNTED.size >= 48) COUNTED.delete(COUNTED.keys().next().value as string);
  COUNTED.set(key, out);
  return out;
}

/** The engine's figures as the card's columns: shift corrected, average image, 9 images in 10. */
function engineColumn(e: BlockCounts, id: ImageCase['id']): number | null {
  return id === 'corrected' ? e.pure : id === 'average' ? e.mean ?? null : e.held;
}

function designPlot(exp: StepProps['exp']): DesignPlot | null {
  const { pattern, stripWidth, spacing, setStripWidth, blockDesign, setBlockDesign, rotation, importedPlan, importedAngle } = exp;
  if (pattern === 'block') {
    const a = blockDesign.plotLength, b = blockDesign.plotWidth;
    const { nSpecies, nBlocks, blocksPerRow, plotAlley, blockAlley } = blockDesign;
    return {
      plot: { a, b }, strip: false, angle: rotation,
      shape: alongRows(rotation) ? { kind: 'blocks', nSpecies, nBlocks, perRow: Math.max(1, Math.min(nBlocks, blocksPerRow || 1)), plotAlley, blockAlley } : undefined,
      now: `plots ${a} × ${b} m`,
      write: s => (a === b ? `${one(a * s)} m` : `${one(a * s)} × ${one(b * s)}`),
      apply: s => setBlockDesign(d => ({ ...d, plotLength: fieldSize(a * s), plotWidth: fieldSize(b * s) })),
    };
  }
  if (pattern === 'imported') {
    if (!importedPlan) return null;
    // The plot with the shortest side decides: every plot has to hold its pixels.
    const boxes = importedPlotBoxes(importedPlan, importedAngle);
    if (!boxes.length) return null;
    const { a, b } = boxes[0];
    return {
      plot: { a, b }, strip: false, angle: importedAngle,
      now: `${boxes.length > 1 ? 'smallest plot' : 'plots'} ${a} × ${b} m`,
      write: s => (a === b ? `${one(a * s)} m` : `${one(a * s)} × ${one(b * s)}`),
    };
  }
  if (pattern === 'checker') {
    return {
      plot: { a: stripWidth, b: stripWidth }, strip: false, angle: rotation,
      // Cells a row spacing apart (Neon, 2026-11-25: the pitch left the spacing out).
      shape: alongRows(rotation) ? { kind: 'every', pitch: stripWidth + (spacing > 0 ? spacing : 0), grid: true } : undefined,
      now: `cells ${stripWidth} × ${stripWidth} m`,
      write: s => `${one(stripWidth * s)} m`,
      apply: s => setStripWidth(fieldSize(stripWidth * s)),
    };
  }
  // Strips. In a 2:2 pattern two strips of one crop touch when there is no bare
  // row between them, and a pixel across both is pure: the pair is the unit.
  const paired = (pattern === 'strip-row-2' || pattern === 'strip-col-2') && !(spacing > 0);
  const per = paired ? 2 : 1;
  return {
    plot: { a: stripWidth * per, b: Infinity }, strip: true, angle: 0,
    shape: alongRows(rotation) ? { kind: 'every', pitch: stripWidth * per + (spacing > 0 ? spacing : 0), grid: false } : undefined,
    now: paired ? `pairs of strips, ${stripWidth * 2} m` : `strips ${stripWidth} m wide`,
    write: s => `${one(stripWidth * s)} m`,
    apply: s => setStripWidth(fieldSize(stripWidth * s)),
  };
}

/** The three readings of a geolocation error, as column heads. What each one is, is on the documentation page. */
const HEADS: Record<ImageCase['id'], React.ReactNode> = {
  corrected: <>shift<br />corrected</>,
  average: <>average<br />image</>,
  robust: <>9 images<br />in 10</>,
};

export function PlotSizeCard(p: StepProps) {
  const { wantPure, setWantPure, mostUndo, setMostUndo } = p;
  const { build, pxSize, psfSigmaXM, psfSigmaYM, geoErrM, geoSigmaM, source } = p.gridApi;
  const { threshold } = p.exp;
  const design = designPlot(p.exp);
  const res = build?.res ?? pxSize;
  // One sigma for both axes, the larger: a plot is not always laid along the blur. Never narrower than
  // a pixel's own footprint, as the engine reads a blur typed under it (simulate.ts spotSigma; Neon, 2026-11-25).
  const typed = Math.max(psfSigmaXM, psfSigmaYM);
  const sigma = typed > 0 && res > 0 ? Math.max(typed, FOOTPRINT_SIGMA * res) : typed;
  const a = design?.plot.a ?? 0, b = design?.plot.b ?? 0, angle = design?.angle ?? 0, strip = !!design?.strip;

  /**
   * The largest plots this field holds, for a block trial: the design's plot,
   * scaled, a pixel clear of the field's edge, in the arrangement of blocks
   * that lets it grow the most. Sizes go DOWN to the decimetre, so that what
   * is applied still fits.
   */
  const { aoi, fieldRing } = p.area;
  const epsg = build?.epsg ?? null;
  const { pattern, blockDesign: bd, rotation, setBlockDesign, setRotation } = p.exp;
  // The field's own direction, when it is turned to the pixel rows (trial-seat.ts fieldAngle).
  const fieldDeg = useMemo(() => (aoi && epsg ? fieldAngle(fieldRing, aoi, epsg) : null), [aoi?.join(','), fieldRing, epsg]); // eslint-disable-line react-hooks/exhaustive-deps
  // On a fixed, known grid a trial along the pixel rows is counted where it falls (see above).
  const known = source.kind === 'catalog';
  const picks = useMemo((): MostPick[] | null => {
    if (pattern !== 'block' || !aoi || !epsg || !(res > 0)) return null;
    // The design's own angle, then the field's two directions (2026-11-25: "this one could fit in
    // if it was rotated"). A field along the rows has 0 and 90 for directions: the blocks stack the other way.
    const angles = [rotation];
    if (fieldDeg != null) for (const x of [fieldDeg, fieldDeg <= 0 ? fieldDeg + 90 : fieldDeg - 90]) if (!angles.some(y => Math.abs(y - x) < 1e-6)) angles.push(x);
    const down = (m: number) => Math.floor(m * 10 + 1e-6) / 10;
    const out: (MostPick & { scale: number })[] = [];
    for (const angle of angles) {
      const found = largestPlots(bd, (u, v) => trialFitsField(fieldRing, aoi, epsg, u, v, angle, res));
      if (!found) continue;
      const la = down(bd.plotLength * found.scale), lb = down(bd.plotWidth * found.scale);
      if (!(la >= 0.5 && lb >= 0.5)) continue;
      out.push({ a: la, b: lb, perRow: found.perRow, angle, scale: found.scale });
      // On a known grid along the rows, also the plots a whole number of pixels apart: every plot then
      // sits on the lattice as the first does, where larger plots drift across it (Neon, 2026-11-25).
      if (known && alongRows(angle)) {
        const wa = down(Math.floor((la + bd.blockAlley) / res + 1e-6) * res - bd.blockAlley);
        const wb = down(Math.floor((lb + bd.plotAlley) / res + 1e-6) * res - bd.plotAlley);
        if (wa >= 0.5 && wb >= 0.5 && (wa < la || wb < lb)) out.push({ a: wa, b: wb, perRow: found.perRow, angle, scale: found.scale * Math.min(wa / la, wb / lb) });
      }
    }
    // The largest first: the card's own model, when the engine cannot count, proposes that one.
    out.sort((x, y) => y.scale - x.scale);
    return out.length ? out.map(({ a, b, perRow, angle }) => ({ a, b, perRow, angle })) : null;
  }, [pattern, aoi?.join(','), fieldRing, epsg, rotation, res, fieldDeg, known,   // eslint-disable-line react-hooks/exhaustive-deps
      bd.nSpecies, bd.nBlocks, bd.blocksPerRow, bd.plotLength, bd.plotWidth, bd.plotAlley, bd.blockAlley]);
  // The engine, for a block trial: the page's own context and this satellite's rung (use-simulation ladderCtx).
  const engineCtx = pattern === 'block' ? p.pca.ladderCtx : null;
  const rung = useMemo(() => p.pca.ladder.find(g => g.id === p.gridApi.sourceId) ?? null, [p.pca.ladder, p.gridApi.sourceId]);
  const shapeKey = design?.shape ? JSON.stringify(design.shape) : '';

  // The numbers follow the inputs a moment behind, so a slider dragged in
  // another field never waits on them.
  const inputs = useMemo(() => ({ res, sigma, geoErrM, geoSigmaM, threshold, a, b, angle, strip, wantPure, picks,
    shape: known && shapeKey ? JSON.parse(shapeKey) as TrialShape : null, engineCtx, rung }),
    [res, sigma, geoErrM, geoSigmaM, threshold, a, b, angle, strip, wantPure, picks, known, shapeKey, engineCtx, rung]);
  // Nothing at all in the render that first shows the card (the page's first
  // one, when step 3 is the step left open): the three searches are a good
  // tenth of a second on a slow computer, and held up everything else the
  // page had to paint. They are worked out in the render after it.
  const d = useDeferredValue(inputs, null);
  const stale = d !== inputs;
  const result = useMemo(() => {
    if (!d || !(d.a > 0) || !(d.res > 0) || !(d.sigma > 0)) return null;
    const plot: Plot = { a: d.a, b: d.b };
    const rows = [...new Set([...(d.strip ? [1, 2, 3] : [1, 4, 9]), d.wantPure])].sort((x, y) => x - y);
    const shape = d.shape;
    const views = imageCases(d.sigma, d.geoErrM, d.geoSigmaM).map(c => ({ id: c.id, v: { gsd: d.res, sigma: c.sigma, shift: c.shift, threshold: d.threshold / 100, angleDeg: d.angle } }));
    // The engine's count of a block trial at its place on the map, or null where it cannot count.
    const ctx = d.engineCtx, rg = d.rung;
    const counted = (pick: MostPick | null): BlockCounts | null => {
      if (!ctx || !rg || ctx.layout.pattern !== 'block') return null;
      const design = pick ? { ...ctx.blockDesign, plotLength: pick.a, plotWidth: pick.b, blocksPerRow: pick.perRow } : ctx.blockDesign;
      return countedOnce({ ...ctx, blockDesign: design }, rg, pick ? pick.angle : d.angle);
    };
    const nowE = counted(null);
    // "Most in this field": the pick whose weakest plot keeps the most, by the engine, in what the
    // trial is placed for ("Place the trial for": pixels that hold, or pure ones), then in the other.
    let mostPick: MostPick | null = null, mostE: BlockCounts | null = null;
    if (d.picks) {
      const forPure = ctx?.placeFor === 'pure';
      const rank = (e: BlockCounts): [number, number] => (e.held === null ? [e.pure, 0] : forPure ? [e.pure, e.held] : [e.held, e.pure]);
      for (const pk of d.picks) {
        const e = counted(pk);
        if (!e) continue;
        const [p1, p2] = rank(e), [q1, q2] = mostE ? rank(mostE) : [-1, -1];
        if (!mostE || p1 > q1 || (p1 === q1 && (p2 > q2 || (p2 === q2 && pk.a * pk.b > mostPick!.a * mostPick!.b)))) { mostPick = pk; mostE = e; }
      }
      // The engine could not count any of them: the largest, by the card's own model.
      if (!mostPick) mostPick = d.picks[0];
    }
    const cases = views.map(({ id, v }) => {
      const scales = pureScales(plot, v, rows, shape ? 'best' : 'worst');
      // A known grid: the trial counted plot by plot where it falls; otherwise the worst place on the grid.
      const own = shape ? seatedTrial(centresOf(shape, d.a, d.b), plot, v) : null;
      let now = own ? { count: own.count, approx: own.approx } : fewestPure(plot, v);
      let keeps = own ? own.keeps : purestShare(plot, v);
      const fromEngine = nowE ? engineColumn(nowE, id) : null;
      if (nowE && fromEngine !== null) {
        now = { count: fromEngine, approx: false };
        keeps = nowE.centres?.length && nowE.edge ? purestOfPlots(nowE.centres, plot, v, nowE.edge) : keeps;
      }
      let most: { count: number; approx: boolean } | null = null;
      if (mostPick) {
        const m = mostE ? engineColumn(mostE, id) : null;
        if (m !== null) most = { count: m, approx: false };
        else {
          const mp = { a: mostPick.a, b: mostPick.b };
          most = shape?.kind === 'blocks' && alongRows(mostPick.angle)
            ? (({ count, approx }) => ({ count, approx }))(seatedTrial(centresOf({ ...shape, perRow: mostPick.perRow || shape.perRow }, mp.a, mp.b), mp, v))
            : fewestPure(mp, { ...v, angleDeg: mostPick.angle });
        }
      }
      return { id, scales, now, keeps, most };
    });
    return { rows, cases, mostPick };
  }, [d]);


  // How wide the card is: too narrow for a label beside its figures (the
  // panel goes down to 320 px), each label goes on its own line above them.
  const [cardW, setCardW] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => setCardW(Math.round(entries[0]?.contentRect.width ?? 0)));
    ro.observe(el);
    observer.current = ro;
  }, []);

  if (!design) return null;
  // Not worked out yet (the first render): the card's frame at about its
  // height, so that what is under it does not jump when the figures land.
  if (!d) return <div className="rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[13px] uppercase tracking-wide text-neutral-600" style={{ minHeight: '10.5rem' }}>Plot size required</div>;
  if (!result) return null;
  const eps = 100 - threshold;
  const cols = result.cases.length;
  // Two sides per cell need more room than one.
  const both = !design.strip && design.plot.a !== design.plot.b;
  const widthRem = both ? 5.9 : 4.7;
  // The label column needs about 7 rem beside the figures (the count typed in, and "pure px").
  const stacked = cardW > 0 && cardW < 16 * (7 + cols * (widthRem + 0.5));
  const grid: React.CSSProperties = { gridTemplateColumns: stacked ? `repeat(${cols}, minmax(0, 1fr))` : `minmax(0, 1fr) repeat(${cols}, ${widthRem}rem)` };
  const gridClass = 'grid items-baseline gap-x-2 gap-y-0.5';
  /** A row's name: beside its figures, or on a line of its own above them. */
  const nameClass = stacked ? 'col-span-full text-neutral-400' : 'text-neutral-400';
  const unit = design.strip ? 'px across' : 'pure px';
  const outside = (keeps: number) => {
    const out = (1 - keeps) * 100;
    return out < 0.05 ? '< 0.1 %' : `${out < 9.95 ? out.toFixed(1) : out.toFixed(0)} %`;
  };

  return (
    <div ref={measure} className={`rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[14px] transition-opacity ${stale ? 'opacity-60' : ''}`}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px] uppercase tracking-wide text-neutral-500">
        <span>{design.strip ? 'Strip width required' : both ? 'Plot size required, m' : 'Plot side required'}</span>
        {/* The threshold as a purity, the way Suggest a design sets it (it read "ε = 10 %" until 2026-11-24). */}
        <span className="normal-case tracking-normal">purity {threshold} %</span>
      </div>

      <div className={gridClass} style={grid}>
        {!stacked && <span />}
        {result.cases.map(c => (
          <span key={c.id} className="text-right text-[12px] leading-tight text-neutral-500">
            {result.cases.length > 1 ? HEADS[c.id] : 'no shift'}
          </span>
        ))}

        {result.rows.map((n, r) => (
          <React.Fragment key={n}>
            <span className={nameClass}>
              {n === wantPure ? (
                <span className="inline-flex flex-wrap items-center gap-x-1.5">
                  <input type="number" min={1} max={400} step={1} value={wantPure} aria-label={design.strip ? 'Pure pixels wanted across a strip' : 'Pure pixels wanted in every plot'}
                    onChange={e => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) setWantPure(Math.max(1, Math.min(400, v))); }}
                    className="w-12 rounded border border-white/10 bg-neutral-900 px-1.5 py-0.5 text-[14px] text-neutral-100 focus:border-sky-500 focus:outline-none" />
                  {unit}
                </span>
              ) : <>{n} {unit}</>}
            </span>
            {result.cases.map(c => {
              const s = c.scales[r];
              if (s == null) return <span key={c.id} className="text-right font-mono text-neutral-600">none</span>;
              const text = design.write(s);
              return design.apply ? (
                <button key={c.id} type="button" onClick={() => design.apply!(s)} title="Set the design to this size"
                  className="rounded text-right font-mono text-neutral-200 transition-colors hover:text-sky-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500">
                  {text}
                </button>
              ) : <span key={c.id} className="text-right font-mono text-neutral-200">{text}</span>;
            })}
          </React.Fragment>
        ))}
      </div>

      {/* The other way round: the most pixels this parcel can give. */}
      {result.mostPick && result.cases[0]?.most && (() => {
        const largest = result.mostPick;
        const there = bd.plotLength === largest.a && bd.plotWidth === largest.b && bd.blocksPerRow === largest.perRow && rotation === largest.angle;
        // Undo, while the design is still what "Use these" set: the plots it replaced, and the angle, come back.
        // Gated on the design alone: the pick can move once the plots change (Neon, 2026-11-25).
        const undo = mostUndo && mostUndo.to.plotLength === bd.plotLength && mostUndo.to.plotWidth === bd.plotWidth
          && mostUndo.to.blocksPerRow === bd.blocksPerRow && (mostUndo.to.rotation ?? rotation) === rotation ? mostUndo.from : null;
        const click = () => {
          if (undo) {
            const { rotation: back, ...plots } = undo;
            setBlockDesign(dd => ({ ...dd, ...plots }));
            if (back !== undefined && back !== rotation) setRotation(back);
            setMostUndo(null);
            return;
          }
          setMostUndo({ from: { plotLength: bd.plotLength, plotWidth: bd.plotWidth, blocksPerRow: bd.blocksPerRow, rotation },
                        to: { plotLength: largest.a, plotWidth: largest.b, blocksPerRow: largest.perRow, rotation: largest.angle } });
          setBlockDesign(dd => ({ ...dd, plotLength: largest.a, plotWidth: largest.b, blocksPerRow: largest.perRow }));
          if (largest.angle !== rotation) setRotation(largest.angle);
        };
        return (
          <>
            <div className="mb-0.5 mt-2 flex items-baseline justify-between gap-2 border-t border-white/5 pt-1.5 text-[12px] uppercase tracking-wide text-neutral-600">
              <span className="min-w-0">
                Most in this field: <span className="normal-case tracking-normal text-neutral-500">plots {largest.a} × {largest.b} m{largest.perRow !== bd.blocksPerRow ? `, ${largest.perRow} per row` : ''}{largest.angle !== rotation ? `, turned ${largest.angle}°` : ''}</span>
              </span>
              <button type="button" disabled={there && !undo} onClick={click}
                title={undo ? `Back to plots ${undo.plotLength} × ${undo.plotWidth} m${undo.blocksPerRow !== bd.blocksPerRow ? `, ${undo.blocksPerRow} per row` : ''}${undo.rotation !== undefined && undo.rotation !== rotation ? `, at ${undo.rotation}°` : ''}`
                  : there ? 'The design already has these plots' : 'Set the design to these plots'}
                className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[12px] normal-case tracking-normal text-neutral-300 transition-colors hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-neutral-300">
                {undo ? 'Undo' : there ? 'In use' : 'Use these'}
              </button>
            </div>
            <div className={gridClass} style={grid}>
              <span className={nameClass}>pure px in every plot</span>
              {result.cases.map(c => (
                <span key={c.id} className="text-right font-mono text-neutral-200">{c.most ? `${c.most.approx ? '≈ ' : ''}${fmt(c.most.count)}` : ''}</span>
              ))}
            </div>
          </>
        );
      })()}

      <div className="mb-0.5 mt-2 border-t border-white/5 pt-1.5 text-[12px] uppercase tracking-wide text-neutral-600">
        Now: <span className="normal-case tracking-normal text-neutral-500">{design.now}</span>
      </div>
      <div className={gridClass} style={grid}>
        <span className={nameClass}>{design.strip ? 'pure px across' : 'pure px in every plot'}</span>
        {result.cases.map(c => (
          <span key={c.id} className={`text-right font-mono ${c.now.count === 0 ? 'text-amber-300' : 'text-neutral-200'}`}>
            {c.now.approx ? '≈ ' : ''}{fmt(c.now.count)}
          </span>
        ))}
        <span className={nameClass}>purest pixel, from outside</span>
        {result.cases.map(c => (
          <span key={c.id} className={`text-right font-mono ${1 - c.keeps > eps / 100 ? 'text-amber-300' : 'text-neutral-200'}`}>{outside(c.keeps)}</span>
        ))}
      </div>
    </div>
  );
}
