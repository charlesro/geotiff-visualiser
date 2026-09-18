import { Fragment, memo, useEffect, useMemo, useRef } from 'react';
import type { FieldParams } from './simulate';
import { axisSigns, fitCover, peekFit, pointStyle, samplePts, type ColorBy, type CoverSource } from './pca-field';
import { fmt } from './util';

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
  res: number;
  purePct: number;
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

function PcaSweep({ steps, pairWith, pairLabels, species, colors, magnitude, threshold, colorBy, activeRes, activeSim, onPick, onPickPair }: {
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
  activeRes?: number;
  /**
   * The big scatter's own simulation, drawn for the current resolution. Only
   * passed when it IS at that resolution: for a moment after a click the chart
   * still holds the previous size, and drawing it under the new size's label
   * would show one resolution's cloud and purity as another's.
   */
  activeSim?: (CoverSource & { purePct: number }) | null;
  /** The big scatter ran on a central subsample of the field, not all of it. */
  /**
   * Label panels with pure pixel COUNTS instead of percentages. Two placements
   * of one trial cover the same area but not the same number of edge pixels, so
   * their percentages have different denominators and can rank them backwards.
   */
  onPick?: (res: number) => void;
  /**
   * Clicking a panel of the PAIRED ladder. That ladder draws a DIFFERENT
   * placement of the design, not merely a different pixel size, so picking one
   * has to put that placement on the map as well: with only `onPick`, clicking
   * the aligned panel showed the size it asked for underneath the design as
   * drawn, which is a third thing that is neither panel.
   */
  onPickPair?: (res: number) => void;
}) {
  const speciesSig = species.map(c => `${c.truth}_${c.L1}_${c.k1}_${c.x01}_${c.k2}_${c.x02}_${c.tc}`).join('|');

  const toCharts = (list: SweepStep[], mayUseActive: boolean) =>
    list.map(s => {
      const isActive = mayUseActive && !!activeSim && activeRes != null && Math.abs(activeRes - s.res) < 1e-6;
      if (!isActive && s.current) {
        // Waiting for the big chart's simulation, which this panel will draw.
        return { res: s.res, purePct: NaN, pureCount: NaN, trialCount: NaN, partial: false, pts: [] as Dot[], tooFew: 0, waiting: true };
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
       * measurement: the whole field, sometimes a central subsample, where the
       * rung is the trial's own extent under LADDER_MAX_CELLS. Reading its
       * percentage made a panel worth 49% show 50% for exactly as long as it was
       * the size being displayed, so clicking along the ladder moved the numbers
       * it was being read for. A rung's purity has to be a property of the rung.
       *
       * The current rung's own figure arrives with the idle pass, so until then
       * the panel shows no number rather than the big chart's.
       */
      return { res: s.res, purePct: s.purePct,
               pureCount: s.current ? NaN : (s.pureCount ?? NaN), trialCount: s.trialCount ?? NaN,
               partial: !!s.partial, pts, tooFew: fit.tooFew, waiting: false };
    });
  // The rotated ladder may substitute the big scatter; the 0° comparison ladder
  // is a different design and never does.
  const charts = useMemo(() => toCharts(steps, true),
    [steps, speciesSig, magnitude, threshold, colorBy, colors.join(','), activeRes, activeSim]); // eslint-disable-line react-hooks/exhaustive-deps
  const pairCharts = useMemo(() => (pairWith ? toCharts(pairWith, false) : null),
    [pairWith, speciesSig, magnitude, threshold, colorBy, colors.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const pc = (v: number) => (v >= 70 ? 'text-emerald-400' : v >= 40 ? 'text-amber-400' : 'text-rose-400');

  const panel = (c: ReturnType<typeof toCharts>[number], key: string, paired = false) => {
    const active = activeRes != null && Math.abs(activeRes - c.res) < 1e-6;
    const sampled = c.partial ? ' (sampled over the central part of a large field)' : '';
    return (
      <button
        key={key}
        type="button"
        onClick={() => (paired ? onPickPair : onPick)?.(c.res)}
        title={paired
          ? `Turn the design along the pixel rows and show it at ${c.res} m${sampled}`
          : `Show the field at ${c.res} m${sampled}`}
        className={`rounded-md border p-1 text-left transition-colors ${active ? 'border-sky-400 bg-sky-500/10 ring-1 ring-sky-400/40' : 'border-white/10 bg-black/30 hover:border-sky-500/40 hover:bg-white/[0.04]'}`}
      >
        <div className="flex items-baseline justify-between px-0.5 text-[10px]">
          <span className="font-mono text-neutral-300">{c.res} m{active ? ' ·' : ''}{c.partial ? ' ◦' : ''}</span>
          {/* The share of this rung's own trial pixels that come out pure. The
              count behind it is in the tooltip: it is what the share is taken
              over, and the two placements of a pair do not catch the same number
              of edge pixels, so the denominators are worth being able to read. */}
          {Number.isFinite(c.purePct) && (
            <span className={pc(c.purePct)}
              title={Number.isFinite(c.pureCount) ? `${fmt(c.pureCount)} pure of ${fmt(c.trialCount ?? NaN)} trial pixels` : undefined}>
              {c.purePct.toFixed(0)}%
            </span>
          )}
        </div>
        <div className="pointer-events-none">
          {c.waiting
            ? <div className="flex items-center justify-center text-[9px] text-neutral-600" style={{ height: 92 }}>…</div>
            : c.tooFew > 0 || !c.pts.length
            ? <div className="flex items-center justify-center text-center text-[9px] leading-tight text-neutral-500" style={{ height: 92 }}>{c.tooFew} trial px</div>
            : <DotCanvas pts={c.pts} height={92} />}
        </div>
      </button>
    );
  };

  if (pairCharts) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {pairLabels && (<>
          <p className="text-[10px] uppercase tracking-wide text-sky-300/80">{pairLabels[0]}</p>
          <p className="text-[10px] uppercase tracking-wide text-neutral-500">{pairLabels[1]}</p>
        </>)}
        {charts.map(c => {
          // Matched by resolution, not by position, so a missing size can never
          // shift every later row out of step.
          const twin = pairCharts.find(p => Math.abs(p.res - c.res) < 1e-9);
          return (
            <Fragment key={c.res}>
              {panel(c, `a-${c.res}`)}
              {twin ? panel(twin, `b-${c.res}`, true) : <div />}
            </Fragment>
          );
        })}
      </div>
    );
  }

  return <div className="grid grid-cols-3 gap-2">{charts.map(c => panel(c, String(c.res)))}</div>;
}

// Memoised: a parameter change re-renders the whole page, and without this every
// panel redrew even when its ladder had not changed. All props are kept stable
// upstream (pickRes, speciesD, colors, pairLabels, pcaView) so the comparison holds.
export default memo(PcaSweep);
