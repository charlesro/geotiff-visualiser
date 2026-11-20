import { Fragment, memo, useEffect, useMemo, useRef } from 'react';
import type { FieldParams } from './simulate';
import { axisSigns, fitCover, peekFit, pointStyle, samplePts, type ColorBy, type CoverSource } from './pca-field';
import { fmt, pct0 } from './util';
import type { PlotTally } from './resolving';

/**
 * Small-multiples PCA: one compact scatter per pixel size, so you can watch the
 * clusters (one per species, plus the mixtures between them) collapse together
 * as the sensor gets coarser.
 *
 * Every panel is the SAME computation as the big scatter above it (pca-field):
 * the whole field's trial pixels, the same seasons and noise, a PCA shown on
 * PC1 × PC2, the same axis orientation and the same colours. The panel at the
 * current resolution does not recompute anything: it draws the big scatter's
 * own simulation and cached fit, so it is that chart in miniature. It used to
 * sample a small window at the field centre with its own noise, signs and
 * colours, and could not match the chart it sat under.
 */

/**
 * Points drawn per thumbnail. A few hundred show the cloud's shape at 92 px;
 * more only costs drawing time. The fit behind them uses every trial pixel.
 */
const LADDER_POINTS = 500;

export interface SweepStep extends CoverSource {
  /** The satellite this rung is: its source id, which a click selects, and the name its row carries. */
  id: string;
  name: string;
  res: number;
  purePct: number;
  /**
   * Pure pixels as a share of this rung's PLANTED AREA in pixels. Undefined on a
   * placeholder rung, `null` when the design plants nothing measurable here.
   */
  resolvingPct?: number | null;
  /** Tooltip only: what the mixed pixels are worth unmixed (see resolving.ts). */
  nEff?: number;
  /** Tooltip only: two varieties cannot be told apart at all at this size. */
  contrastDead?: boolean;
  /** The share's denominator: the planted crop area, in whole pixels. */
  plantCount?: number;
  /**
   * Geolocation, read two ways off the same CE90 (step 2's Geoloc figure), both
   * through this rung's own pipeline and in the share's own units. Undefined
   * when no geolocation error is set.
   *
   * geoRobust: the pixels pure for the same plot wherever the image lands
   * within the CE90. The set a pixel list chosen by coordinates can rely on.
   * geoMean: the PHENET note's number, the share under one effective spot
   * sigma_eff = sqrt(sigma_psf^2 + sigma_geo^2). Absent past 5 px of blur.
   */
  geoRobust?: number;
  geoRobustPure?: number;
  geoMean?: number;
  geoMeanPure?: number;
  /** The CE90 this rung was computed with, in metres. */
  ce90M?: number;
  /** Pure pixels plot by plot, at the nominal placement and over the robust set. */
  plots?: PlotTally;
  plotsRobust?: PlotTally;
  /** The note's closed-form smallest plot side at this pixel size, and the design's own. */
  minPlotM?: number;
  plotSideM?: number;
  /** Pure pixels, and the trial pixels they are counted over (NaN on a placeholder). */
  pureCount?: number;
  trialCount?: number;
  /** True when the field was too big to sample whole and a central window was used. */
  partial?: boolean;
  /**
   * The current resolution, left unsimulated: its panel draws the big chart's
   * own simulation, so the ladder does not compute it a second time.
   */
  current?: boolean;
  /**
   * On the best-placement ladder of an imported trial: where this rung puts
   * the trial (the file's trial turned by `turn` degrees, then moved by
   * `shift` metres), the angle to the pixel rows that leaves it at, and
   * whether a search ran or the trial is simply as the file has it. A click
   * on the rung puts the trial exactly there.
   */
  placement?: { turn: number; shift: [number, number]; angle: number; searched: boolean };
}

interface Dot { x: number; y: number; color: string }

/**
 * One mini dot plot, drawn on a <canvas>. These panels have no axes, tooltips or
 * per-dot interaction, so SVG bought nothing and cost about 25 ms of React work
 * per panel on every render. Canvas draws a panel in well under a millisecond.
 */
function DotCanvas({ pts, height }: { pts: Dot[]; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const w = cv.clientWidth, h = height;
      if (!w) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!pts.length) return;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
      const pad = 4;
      const px = (x: number) => (x1 > x0 ? pad + ((x - x0) / (x1 - x0)) * (w - 2 * pad) : w / 2);
      const py = (y: number) => (y1 > y0 ? h - pad - ((y - y0) / (y1 - y0)) * (h - 2 * pad) : h / 2); // PC2 up
      ctx.globalAlpha = 0.8;
      for (const p of pts) {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(px(p.x), py(p.y), 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [pts, height]);
  return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} />;
}

function PcaSweep({ steps, pairWith, pairLabels, species, colors, magnitude, threshold, colorBy, activeId, activeSim, onPick, onPickPair, geoErrM = 0 }: {
  steps: SweepStep[];
  /**
   * A second ladder over the same resolutions (e.g. the rows laid along the
   * pixels). When given, the two are drawn as PAIRS, one resolution per row,
   * `steps` on the left and `pairWith` on the right.
   */
  pairWith?: SweepStep[] | null;
  pairLabels?: [string, string];
  /** Every species in the design, already padded and recoloured for drawing. */
  species: FieldParams[]; colors: string[]; magnitude: number;
  /** The purity threshold in percent, so a thumbnail's pure/mixed colouring is the chart's. */
  threshold: number;
  /** The big scatter's colour encoding, so a pixel is the same colour in both. */
  colorBy: ColorBy;
  /** The satellite selected: its rung is the one on the map. */
  activeId?: string;
  /**
   * The big scatter's own simulation, drawn for the current resolution. Only
   * passed when it IS at that resolution: for a moment after a click the chart
   * still holds the previous size, and drawing it under the new size's label
   * would show one resolution's cloud and purity as another's.
   */
  activeSim?: (CoverSource & { purePct: number }) | null;
  /** The big scatter ran on a sample spread over the field, not all of it. */
  /**
   * Label panels with pure pixel COUNTS instead of percentages. Two placements
   * of one trial cover the same area but not the same number of edge pixels, so
   * their percentages have different denominators and can rank them backwards.
   */
  onPick?: (id: string) => void;
  /**
   * Clicking a panel of the PAIRED ladder. That ladder draws a DIFFERENT
   * placement of the design, not merely a different pixel size, so picking one
   * has to put that placement on the map as well: with only `onPick`, clicking
   * the aligned panel showed the size it asked for underneath the design as
   * drawn, which is a third thing that is neither panel.
   */
  onPickPair?: (id: string) => void;
  /** Step 2's geolocation error in metres, to label each panel's range. 0 = off. */
  geoErrM?: number;
}) {
  const speciesSig = species.map(c => `${c.truth}_${c.L1}_${c.k1}_${c.x01}_${c.k2}_${c.x02}_${c.tc}`).join('|');

  const toCharts = (list: SweepStep[], mayUseActive: boolean) =>
    list.map(s => {
      const isActive = mayUseActive && !!activeSim && activeId === s.id;
      if (!isActive && s.current) {
        // Waiting for the big chart's simulation, which this panel will draw.
        return { id: s.id, name: s.name, res: s.res, purePct: NaN, pureCount: NaN, trialCount: NaN, partial: false, pts: [] as Dot[], tooFew: 0, waiting: true };
      }
      const src: CoverSource = isActive ? activeSim! : s;
      // Every rung is fitted on ALL its trial pixels, exactly as the big chart
      // fits that size: its pixels carry the same identities (so the same noise)
      // and come in the same order, so it IS that chart's fit, and a thumbnail
      // cannot change or flip when it is picked. Fitted on a sample instead, its
      // axes came out a little different and now and then mirrored. Only the
      // drawing is thinned to LADDER_POINTS. The current size reuses the big
      // chart's cached fit; with another method selected there is no PCA cached
      // for it, and it is fitted here like any other rung.
      const fit = (isActive ? peekFit(src, species, magnitude, 'pca') : null) ?? fitCover(src, species, magnitude, 'pca');
      // Signs from the WHOLE fit, so every panel faces exactly like the big chart.
      const [sx, sy] = axisSigns(fit, 0, 1, species);
      const pts: Dot[] = samplePts(fit.pts, LADDER_POINTS).map(p => ({
        x: sx * (p.s[0] ?? 0), y: sy * (p.s[1] ?? 0),
        color: pointStyle(p, colorBy, 'none', colors, threshold).color,
      }));
      /**
       * EVERY number on a panel comes from that panel's own rung. Only the
       * drawing is borrowed.
       *
       * The big chart is lent to the panel at the displayed size so the picture
       * cannot change when a thumbnail is picked, but it is a different
       * measurement: the whole field, sometimes a spread sample of it, where the
       * rung is the trial's own extent under LADDER_MAX_CELLS. Reading its
       * percentage made a panel worth 49% show 50% for exactly as long as it was
       * the size being displayed, so clicking along the ladder moved the numbers
       * it was being read for. A rung's purity has to be a property of the rung.
       *
       * The current rung's own figure arrives with the idle pass, so until then
       * the panel shows no number rather than the big chart's.
       */
      return { id: s.id, name: s.name, res: s.res, purePct: s.purePct,
               resolvingPct: s.current ? undefined : s.resolvingPct, nEff: s.current ? undefined : s.nEff,
               plantCount: s.plantCount, contrastDead: s.contrastDead,
               geoRobust: s.current ? undefined : s.geoRobust, geoRobustPure: s.current ? undefined : s.geoRobustPure,
               geoMean: s.current ? undefined : s.geoMean, ce90M: s.ce90M,
               plots: s.current ? undefined : s.plots, plotsRobust: s.current ? undefined : s.plotsRobust,
               minPlotM: s.minPlotM, plotSideM: s.plotSideM,
               pureCount: s.current ? NaN : (s.pureCount ?? NaN), trialCount: s.trialCount ?? NaN,
               partial: !!s.partial, pts, tooFew: fit.tooFew, waiting: false };
    });
  // The rotated ladder may substitute the big scatter; the 0° comparison ladder
  // is a different design and never does.
  const charts = useMemo(() => toCharts(steps, true),
    [steps, speciesSig, magnitude, threshold, colorBy, colors.join(','), activeId, activeSim]); // eslint-disable-line react-hooks/exhaustive-deps
  const pairCharts = useMemo(() => (pairWith ? toCharts(pairWith, false) : null),
    [pairWith, speciesSig, magnitude, threshold, colorBy, colors.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const pc = (v: number) => (v >= 70 ? 'text-emerald-400' : v >= 40 ? 'text-amber-400' : 'text-rose-400');

  const panel = (c: ReturnType<typeof toCharts>[number], key: string, paired = false) => {
    const active = activeId === c.id;
    const sampled = c.partial ? ' (sampled over the central part of a large field)' : '';
    // A rung of an imported trial's best-placement ladder says where it puts the trial.
    const place = paired ? pairWith?.find(s => s.id === c.id)?.placement : undefined;
    return (
      <button
        key={key}
        type="button"
        onClick={() => (paired ? onPickPair : onPick)?.(c.id)}
        title={paired
          ? place
            ? `Put the trial where it keeps the most pure pixels for ${c.name}, ${c.res} m (${+place.angle.toFixed(2)}° to the pixel rows), and show it${sampled}`
            : `Turn the design along the pixel rows and show it as ${c.name} sees it, ${c.res} m${sampled}`
          : `Show the field as ${c.name} sees it, ${c.res} m${sampled}`}
        className={`rounded-md border p-1 text-left transition-colors ${active ? 'border-sky-400 bg-sky-500/10 ring-1 ring-sky-400/40' : 'border-white/10 bg-black/30 hover:border-sky-500/40 hover:bg-white/[0.04]'}`}
      >
        <div className="truncate px-0.5 text-[12px] leading-tight text-neutral-400">{c.name}</div>
        <div className="flex items-baseline justify-between px-0.5 text-[13px]">
          <span className="font-mono text-neutral-300">{c.res} m{active ? ' ·' : ''}{c.partial ? ' ◦' : ''}</span>
          {/* TWO numbers, never one. The SHARE is how many of the pixels that
              are ON THE CROP come out clean; a pixel of nothing but alley soil
              is not counted against it. The COUNT beside it is not decoration:
              the share is knowingly not monotone in pixel size, and the count
              is what does not mislead there. The denominator is the design's
              own PLANTED AREA, a constant for a design and a pixel size, which
              is what makes the share exactly proportional to the count. Any
              measured denominator moves when the trial does and hid a 10.2%
              gain in pure pixels behind a 4.5% change. */}
          {c.resolvingPct !== undefined && (
            <span className="flex items-baseline gap-1"
              title={[
                c.resolvingPct === null
                  ? 'This design plants less than one pixel of crop at this size'
                  : `${fmt(c.pureCount)} pure of the ${fmt(c.plantCount ?? NaN)} pixels of crop this design plants`,
                Number.isFinite(c.trialCount) ? `${fmt(c.trialCount ?? NaN)} trial pixels in all` : null,
                c.contrastDead
                  ? 'Two varieties cannot be told apart at this pixel size'
                  : c.nEff ? `the mixed ones are worth ${c.nEff.toFixed(1)} more clean pixels per variety if you unmix them` : null,
              ].filter(Boolean).join(' · ')}>
              <span className={c.resolvingPct === null ? 'text-rose-400' : pc(c.resolvingPct)}>
                {c.resolvingPct === null ? 'n/a' : `${c.resolvingPct.toFixed(0)}%`}
              </span>
              {Number.isFinite(c.pureCount) && (
                <span className="font-mono text-[12px] text-neutral-500">{fmt(c.pureCount)}px</span>
              )}
            </span>
          )}
        </div>
        {/* Two short lines under the headline, each one figure, neither wrapping
            in a panel a third of the sidebar wide. They were four, of up to
            thirty-five characters, in a panel that holds seventeen: six or seven
            lines of caption over each small chart, nine times, or eighteen.
            What they left out is in their tooltips. */}
        {/* What survives the geolocation error: pixels pure for the same plot at
            every image position within the CE90. A count range hid this (64 to
            77 pure at every position, 16 of them the same pixels). */}
        {c.geoRobust !== undefined && (
          <div className="whitespace-nowrap px-0.5 font-mono text-[12px] leading-tight tracking-tight text-neutral-500"
            title={`Pixels that stay pure, for the same plot, for any geolocation error within the CE90 (${c.ce90M ?? geoErrM} m): ${fmt(c.geoRobustPure ?? 0)} px.${c.geoMean !== undefined ? ` Pure share computed with σeff instead: ${pct0(c.geoMean)}.` : ''}`}>
            within CE90 <span className={c.geoRobust < 0.5 ? 'text-rose-400' : 'text-neutral-300'}>{pct0(c.geoRobust)}</span>
          </div>
        )}
        {/* Pure pixels per plot, over the robust set when there is one: the
            fewest any plot holds, or how many plots hold none. The note's
            closed-form minimum plot side is in the tooltip; the plot-size card
            of step 3 gives the size a design needs. */}
        {(() => {
          const t = c.plotsRobust ?? c.plots;
          if (!t) return null;
          const small = c.minPlotM !== undefined && c.plotSideM !== undefined && c.plotSideM < c.minPlotM;
          return (
            <div className={`whitespace-nowrap px-0.5 font-mono text-[12px] leading-tight tracking-tight ${small && t.none === 0 ? 'text-amber-300/80' : 'text-neutral-500'}`}
              title={`Number of pure pixels in each plot: minimum ${t.min}, median ${t.median}. A plot without any pure pixel is unusable: ${t.none} of ${t.plots}.${c.minPlotM !== undefined ? ` The note's closed form asks for a plot side of at least ${c.minPlotM.toFixed(1)} m at this pixel size (GSD + 2 z σeff, ε = ${100 - threshold} %)${c.plotSideM !== undefined ? `; here L = ${c.plotSideM} m` : ''}.` : ''}`}>
              {t.none > 0
                ? <span className="text-rose-400">{t.none}/{t.plots} plots empty</span>
                : <>min <span className="text-neutral-300">{t.min}</span> px / plot</>}
            </div>
          );
        })()}
        <div className="pointer-events-none">
          {c.waiting
            ? <div className="flex items-center justify-center text-[12px] text-neutral-600" style={{ height: 92 }}>…</div>
            : c.tooFew > 0 || !c.pts.length
            ? <div className="flex items-center justify-center text-center text-[12px] leading-tight text-neutral-500" style={{ height: 92 }}>{c.tooFew} trial px</div>
            : <DotCanvas pts={c.pts} height={92} />}
        </div>
      </button>
    );
  };

  if (pairCharts) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {pairLabels && (<>
          <p className="text-[13px] uppercase tracking-wide text-sky-300/80">{pairLabels[0]}</p>
          <p className="text-[13px] uppercase tracking-wide text-neutral-500">{pairLabels[1]}</p>
        </>)}
        {charts.map(c => {
          // Matched by satellite, not by position, so a missing one can never
          // shift every later row out of step.
          const twin = pairCharts.find(p => p.id === c.id);
          return (
            <Fragment key={c.id}>
              {panel(c, `a-${c.id}`)}
              {twin ? panel(twin, `b-${c.id}`, true) : <div />}
            </Fragment>
          );
        })}
      </div>
    );
  }

  return <div className="grid grid-cols-3 gap-2">{charts.map(c => panel(c, c.id))}</div>;
}

// Memoised: a parameter change re-renders the whole page, and without this every
// panel redrew even when its ladder had not changed. All props are kept stable
// upstream (pickRes, speciesD, colors, pairLabels, pcaView) so the comparison holds.
export default memo(PcaSweep);
