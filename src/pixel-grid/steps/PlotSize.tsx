import React, { useDeferredValue, useMemo } from 'react';
import { fmt } from '../util';
import { fewestPure, imageCases, importedPlotBoxes, pureScales, purestShare, type ImageCase, type Plot } from '../plot-size';
import { largestPlots } from '../suggest-design';
import { trialFitsField } from '../trial-seat';
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
 * For a block trial on a field it also reads the question the other way
 * round: not "what size for so many pixels" but "the most pixels this parcel
 * can give", which is the largest plots with which the trial still fits the
 * field, and what a plot of that size keeps.
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
}

/** A dimension the design fields accept: up to the decimetre above, within their range. */
const fieldSize = (m: number) => Math.max(0.5, Math.min(1000, Math.ceil(m * 10 - 1e-6) / 10));
const one = (m: number) => (m >= 100 ? m.toFixed(0) : m.toFixed(1));

function designPlot(exp: StepProps['exp']): DesignPlot | null {
  const { pattern, stripWidth, spacing, setStripWidth, blockDesign, setBlockDesign, rotation, importedPlan, importedAngle } = exp;
  if (pattern === 'block') {
    const a = blockDesign.plotLength, b = blockDesign.plotWidth;
    return {
      plot: { a, b }, strip: false, angle: rotation,
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
  const { wantPure, setWantPure } = p;
  const { build, pxSize, psfSigmaXM, psfSigmaYM, geoErrM, geoSigmaM } = p.gridApi;
  const { threshold } = p.exp;
  const design = designPlot(p.exp);
  const res = build?.res ?? pxSize;
  // One sigma for both axes, the larger: a plot is not always laid along the blur.
  const sigma = Math.max(psfSigmaXM, psfSigmaYM);
  const a = design?.plot.a ?? 0, b = design?.plot.b ?? 0, angle = design?.angle ?? 0, strip = !!design?.strip;

  /**
   * The largest plots this field holds, for a block trial: the design's plot,
   * scaled, a pixel clear of the field's edge, in the arrangement of blocks
   * that lets it grow the most. Sizes go DOWN to the decimetre, so that what
   * is applied still fits.
   */
  const { aoi, fieldRing } = p.area;
  const epsg = build?.epsg ?? null;
  const { pattern, blockDesign: bd, rotation, setBlockDesign } = p.exp;
  const largest = useMemo(() => {
    if (pattern !== 'block' || !aoi || !epsg || !(res > 0)) return null;
    const found = largestPlots(bd, (u, v) => trialFitsField(fieldRing, aoi, epsg, u, v, rotation, res));
    if (!found) return null;
    const down = (m: number) => Math.floor(m * 10 + 1e-6) / 10;
    const la = down(bd.plotLength * found.scale), lb = down(bd.plotWidth * found.scale);
    return la >= 0.5 && lb >= 0.5 ? { a: la, b: lb, perRow: found.perRow } : null;
  }, [pattern, aoi?.join(','), fieldRing, epsg, rotation, res,   // eslint-disable-line react-hooks/exhaustive-deps
      bd.nSpecies, bd.nBlocks, bd.blocksPerRow, bd.plotLength, bd.plotWidth, bd.plotAlley, bd.blockAlley]);
  const maxA = largest?.a ?? 0, maxB = largest?.b ?? 0;

  // The numbers follow the inputs a moment behind, so a slider dragged in
  // another field never waits on them.
  const inputs = useMemo(() => ({ res, sigma, geoErrM, geoSigmaM, threshold, a, b, angle, strip, wantPure, maxA, maxB }),
    [res, sigma, geoErrM, geoSigmaM, threshold, a, b, angle, strip, wantPure, maxA, maxB]);
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
    const cases = imageCases(d.sigma, d.geoErrM, d.geoSigmaM).map(c => {
      const v = { gsd: d.res, sigma: c.sigma, shift: c.shift, threshold: d.threshold / 100, angleDeg: d.angle };
      return { id: c.id, scales: pureScales(plot, v, rows), now: fewestPure(plot, v), keeps: purestShare(plot, v),
               most: d.maxA > 0 && d.maxB > 0 ? fewestPure({ a: d.maxA, b: d.maxB }, v) : null };
    });
    return { rows, cases };
  }, [d]);

  if (!design) return null;
  // Not worked out yet (the first render): the card's frame at about its
  // height, so that what is under it does not jump when the figures land.
  if (!d) return <div className="rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[13px] uppercase tracking-wide text-neutral-600" style={{ minHeight: '10.5rem' }}>Plot size required</div>;
  if (!result) return null;
  const eps = 100 - threshold;
  const cols = result.cases.length;
  // Two sides per cell need more room than one.
  const both = !design.strip && design.plot.a !== design.plot.b;
  const grid: React.CSSProperties = { gridTemplateColumns: `minmax(0, 1fr) repeat(${cols}, ${both ? '5.9rem' : '4.7rem'})` };
  const unit = design.strip ? 'px across' : 'pure px';
  const outside = (keeps: number) => {
    const out = (1 - keeps) * 100;
    return out < 0.05 ? 'under 0.1 %' : `${out < 9.95 ? out.toFixed(1) : out.toFixed(0)} %`;
  };

  return (
    <div className={`rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[14px] transition-opacity ${stale ? 'opacity-60' : ''}`}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px] uppercase tracking-wide text-neutral-500">
        <span>{design.strip ? 'Strip width required' : both ? 'Plot size required, m' : 'Plot side required'}</span>
        <span className="normal-case tracking-normal">ε = {eps} %</span>
      </div>

      <div className="grid items-baseline gap-x-2 gap-y-0.5" style={grid}>
        <span />
        {result.cases.map(c => (
          <span key={c.id} className="text-right text-[12px] leading-tight text-neutral-500">
            {cols > 1 ? HEADS[c.id] : 'no shift'}
          </span>
        ))}

        {result.rows.map((n, r) => (
          <React.Fragment key={n}>
            <span className="text-neutral-400">
              {n === wantPure ? (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
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
      {largest && result.cases[0]?.most && (() => {
        const there = bd.plotLength === largest.a && bd.plotWidth === largest.b && bd.blocksPerRow === largest.perRow;
        return (
          <>
            <div className="mb-0.5 mt-2 flex items-baseline justify-between gap-2 border-t border-white/5 pt-1.5 text-[12px] uppercase tracking-wide text-neutral-600">
              <span className="min-w-0">
                Most in this field: <span className="normal-case tracking-normal text-neutral-500">plots {largest.a} × {largest.b} m{largest.perRow !== bd.blocksPerRow ? `, ${largest.perRow} per row` : ''}</span>
              </span>
              <button type="button" disabled={there}
                onClick={() => setBlockDesign(dd => ({ ...dd, plotLength: largest.a, plotWidth: largest.b, blocksPerRow: largest.perRow }))}
                title={there ? 'The design already has these plots' : 'Set the design to these plots'}
                className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[12px] normal-case tracking-normal text-neutral-300 transition-colors hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-neutral-300">
                {there ? 'In use' : 'Use these'}
              </button>
            </div>
            <div className="grid items-baseline gap-x-2 gap-y-0.5" style={grid}>
              <span className="text-neutral-400">pure px in every plot</span>
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
      <div className="grid items-baseline gap-x-2 gap-y-0.5" style={grid}>
        <span className="text-neutral-400">{design.strip ? 'pure px across' : 'pure px in every plot'}</span>
        {result.cases.map(c => (
          <span key={c.id} className={`text-right font-mono ${c.now.count === 0 ? 'text-amber-300' : 'text-neutral-200'}`}>
            {c.now.approx ? '≈ ' : ''}{fmt(c.now.count)}
          </span>
        ))}
        <span className="text-neutral-400">purest pixel, from outside</span>
        {result.cases.map(c => (
          <span key={c.id} className={`text-right font-mono ${1 - c.keeps > eps / 100 ? 'text-amber-300' : 'text-neutral-200'}`}>{outside(c.keeps)}</span>
        ))}
      </div>
    </div>
  );
}
