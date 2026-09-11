/**
 * The one chart in the growth-scenarios drawer.
 *
 * Three near-identical LineCharts used to exist — the species overlay, the
 * markable scenario curve and the fitted-growth curve. They shared an axis, a
 * dense grid, tick thinning and a dot renderer, and every fix to one of those
 * had to be made three times (the leap-day collision and the tick thinning each
 * got fixed twice before this). One component, three configurations.
 */
import React, { useId, useMemo, useRef, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, ReferenceArea, ReferenceLine, ResponsiveContainer } from 'recharts';
import { dayIndex, dayIndexToDate } from '../../lib/phenology';
import { cn } from '../../lib/utils';
import { MonthMark, PARTIAL_SUPPORT, monthsOf } from './model';

/**
 * The chart's x axis, in absolute day index.
 *
 * Day-of-year would collide on a series crossing 1 January and invert the axis;
 * the index is monotone across years. `dense` extra points let a fitted model be
 * drawn as a smooth curve rather than straight hops between acquisitions.
 */
export function chartAxis(dates: string[], baseYear: number, dense: number) {
  const obs: number[] = [];
  const dayToObs = new Map<number, number>();
  dates.forEach((d, i) => {
    const t = dayIndex(d, baseYear);
    if (t == null) return;
    obs.push(t);
    dayToObs.set(t, i);
  });
  const lo = obs[0] ?? 0;
  const hi = obs[obs.length - 1] ?? lo + 1;
  const grid = new Set(obs);
  for (let i = 0; i <= dense; i++) grid.add(Math.round(lo + ((hi - lo) * i) / dense));
  const points = Array.from(grid).sort((a, b) => a - b);
  // Ticks sit on month boundaries rather than on the acquisitions: an evenly
  // spaced frame is what makes an unevenly sampled series readable, and it says
  // where nothing was acquired without having to measure anything.
  const months = monthsOf(dates, baseYear);
  const ticks = months.map(m => m.from).filter(t => t >= lo && t <= hi);
  return { points, obs, ticks, months, dayToObs, lo, hi, baseYear };
}

export type ChartAxis = ReturnType<typeof chartAxis>;

/** How close, in pixels, the pointer must be to a curve to pick it out. */
const HOVER_TOLERANCE_PX = 5;

/**
 * Height reserved for the x axis, set explicitly rather than left to recharts'
 * default. The interaction overlay has to cover exactly the plot rectangle: if
 * it covers the axis too, every pixel maps to the wrong value and "on the line"
 * stops meaning what it says.
 */
const AXIS_H = 18;

/** Chart margins, shared by the plot and the overlay that must align with it. */
const MARGIN = { top: 4, right: 4, bottom: 0, left: 2 };

/** The plot rectangle inside the chart box — what recharts actually draws into. */
const PLOT_BOX = (axisW: number) => ({
  left: axisW + MARGIN.left,
  right: MARGIN.right,
  top: MARGIN.top,
  bottom: AXIS_H + MARGIN.bottom,
});

/** A round increment near a half of `span` — 1, 2 or 5 times a power of ten. */
function niceStep(span: number): number {
  const raw = Math.max(1e-9, span) / 2;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** Bands drawn behind the curves, in day-index space. */
export interface ChartBand {
  from: number;
  to: number;
  fill: string;
  opacity?: number;
  key: string;
}

export interface ChartSeries {
  key: string;
  colour: string;
  /** Thin translucent line with dots (observations) vs solid line (a model). */
  kind: 'observed' | 'model';
  dashed?: boolean;
}

/**
 * `series` names the dataKeys present in `data`. Observation series may carry a
 * companion `<key>__seen` value; where that falls below PARTIAL_SUPPORT of
 * `supportOf`, the dot is drawn hollow — the point is real but averaged over
 * only part of the scenario.
 */
export function PhenoChart({
  axis,
  data,
  series,
  bands = [],
  markers = [],
  height,
  yAxis,
  supportOf,
  onPlotClick,
  highlight,
  onHighlight,
  onMonthsPick,
  tooltip,
  className,
}: {
  axis: ChartAxis;
  data: Record<string, number | undefined>[];
  series: ChartSeries[];
  bands?: ChartBand[];
  markers?: { x: number; colour: string; label?: string; dashed?: boolean; key: string }[];
  height: number;
  yAxis: 'hidden' | 'value' | 'growth';
  supportOf?: number;
  /**
   * A click in the plot, as a day on the series axis plus whichever curve was
   * nearest. Handled by the overlay below rather than through recharts' own
   * mouse events, which report a position only while recharts believes the
   * pointer is inside the plot.
   */
  onPlotClick?: (day: number, nearest: string | null) => void;
  /**
   * The series to bring forward. Everything else recedes hard rather than
   * politely: with several curves on one axis, a small weight change is not
   * enough to follow one of them across the plot.
   */
  highlight?: string | null;
  /** Emitted as the pointer moves, naming the series nearest to it. */
  onHighlight?: (key: string | null) => void;

  /** Ask the catalogue for more imagery over a span of months the user drew. */
  onMonthsPick?: (keys: string[]) => void;
  /** Hover readout. `day` is null when the pointer is off the plot. */
  tooltip?: (row: Record<string, number | undefined> | null, day: number) => React.ReactNode;
  className?: string;
}) {
  const pad = Math.max(4, Math.round((axis.hi - axis.lo) * 0.01));
  const lo = axis.lo - pad;
  const hi = axis.hi + pad;
  // One constant for the Y axis, used by the axis AND by the overlay that has to
  // line up with the plot area — they cannot drift apart.
  const axisW = yAxis === 'hidden' ? 0 : 34;
  const plot = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; day: number } | null>(null);
  // Unique per chart instance: several of these render at once, and SVG filter
  // ids are global — a shared one would have every chart reference the first.
  const glowId = `pheno-glow-${useId().replace(/:/g, '')}`;
  // The span being swept out, held twice over: state drives the highlight, and
  // the ref is what the release reads. Committing from inside a state updater
  // would call back into a parent mid-render, and would read a stale span when
  // several segments are crossed in one frame.
  const [span, setSpan] = useState<[number, number] | null>(null);
  const spanRef = useRef<[number, number] | null>(null);
  const putSpan = (v: [number, number] | null) => {
    spanRef.current = v;
    setSpan(v);
  };

  // The Y domain is computed here rather than left to recharts' 'auto', because
  // the overlay has to invert a pointer position back into a value to work out
  // which curve it is nearest — and it can only do that if it knows the scale.
  const yDomain = useMemo<[number, number]>(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const row of data) {
      for (const s of series) {
        const v = row[s.key];
        if (typeof v === 'number' && isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    const padY = Math.max(1e-6, (max - min) * 0.08);
    let a = yAxis === 'growth' ? 0 : min - padY;
    let b = max + padY;
    // Round outward to a round step. Taking the raw extremes as the domain
    // defeats recharts' tick nicing and yields labels like 0.4756, which are
    // wider than the axis gutter and get clipped to nonsense.
    const step = niceStep(b - a);
    a = Math.floor(a / step) * step;
    b = Math.ceil(b / step) * step;
    return [a, b];
  }, [data, series, yAxis]);
  const decimals = Math.max(0, Math.min(3, -Math.floor(Math.log10(niceStep(yDomain[1] - yDomain[0]))))); 

  /** Which month a pointer X falls in, clamped to the ends of the strip. */
  const monthAt = (clientX: number) => {
    const r = strip.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || axis.months.length === 0) return null;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const day = lo + f * (hi - lo);
    let idx = axis.months.findIndex(m => day >= m.from && day < m.to);
    if (idx < 0) idx = day < axis.months[0].from ? 0 : axis.months.length - 1;
    return idx;
  };

  const dayAt = (clientX: number) => {
    const r = plot.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return null;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(lo + f * (hi - lo));
  };
  const rowAt = (day: number) => {
    let best: Record<string, number | undefined> | null = null;
    let bestD = Infinity;
    for (const t of axis.obs) {
      const d = Math.abs(t - day);
      if (d < bestD) {
        bestD = d;
        best = data.find(r => r.t === t) ?? null;
      }
    }
    // Only claim a reading when the pointer is actually near an acquisition.
    return bestD <= (hi - lo) * 0.02 ? best : null;
  };

  /**
   * The observed series whose DRAWN path passes closest to the pointer.
   *
   * Measured against the rendered geometry rather than against a linear
   * interpolation of the data: the lines are monotone splines, so between two
   * acquisitions the curve on screen is not the straight line between them.
   * Where several curves bunch together — which is most of a growth season —
   * that difference is bigger than the hit tolerance, and a click landing
   * exactly on one curve resolved to its neighbour.
   */
  const nearestSeries = (clientX: number, clientY: number) => {
    const root = host.current;
    const svg = root?.querySelector('svg');
    if (!root || !svg) return null;
    const sb = svg.getBoundingClientRect();
    const x = clientX - sb.left;
    const y = clientY - sb.top;
    let best: string | null = null;
    let bestD = Infinity;
    for (const s of series) {
      // A model line is a derived overlay drawn over its own data; only the
      // observations can be picked out.
      if (s.kind === 'model') continue;
      const path = root.querySelector<SVGPathElement>(`.ph-${s.key} path.recharts-curve`);
      const len = path?.getTotalLength?.() ?? 0;
      if (!path || !(len > 0)) continue;
      const steps = Math.min(240, Math.max(40, Math.round(len / 4)));
      for (let i = 0; i <= steps; i++) {
        const pt = path.getPointAtLength((len * i) / steps);
        const d = Math.hypot(pt.x - x, pt.y - y);
        if (d < bestD) {
          bestD = d;
          best = s.key;
        }
      }
    }
    return bestD <= HOVER_TOLERANCE_PX ? best : null;
  };

  return (
    <div ref={host} style={{ height }} className={cn('relative', className)}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={MARGIN}
        >
          <defs>
            {/* Two-stage bloom. A single blur has to choose between looking
                bright and looking sharp; stacking a wide faint spread under a
                tight, opaque core gives real luminance while the stroke on top
                stays crisp. Both halos are recoloured white — a coloured bloom
                just reads as a fatter, muddier line. */}
            <filter id={glowId} x="-45%" y="-45%" width="190%" height="190%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="wide" />
              <feFlood floodColor="#ffffff" floodOpacity="0.55" result="wideTint" />
              <feComposite in="wideTint" in2="wide" operator="in" result="bloom" />

              <feGaussianBlur in="SourceGraphic" stdDeviation="1.1" result="tight" />
              <feFlood floodColor="#ffffff" floodOpacity="1" result="coreTint" />
              <feComposite in="coreTint" in2="tight" operator="in" result="core" />

              <feMerge>
                <feMergeNode in="bloom" />
                <feMergeNode in="bloom" />
                <feMergeNode in="core" />
                <feMergeNode in="core" />
                <feMergeNode in="core" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <XAxis
            dataKey="t"
            type="number"
            domain={[lo, hi]}
            ticks={axis.ticks}
            tickFormatter={(t: number) => axis.months.find(m => m.from === t)?.label ?? ''}
            tick={{ fill: '#64748b', fontSize: 9 }}
            tickLine={false}
            axisLine={{ stroke: '#ffffff10' }}
            height={AXIS_H}
            allowDataOverflow
          />
          {yAxis === 'hidden' ? (
            <YAxis hide domain={yDomain} />
          ) : (
            <YAxis
              tick={{ fill: '#64748b', fontSize: 9 }}
              tickLine={false}
              axisLine={false}
              tickCount={3}
              width={axisW}
              domain={yDomain}
              tickFormatter={(v: number) => v.toFixed(decimals)}
              label={
                yAxis === 'growth'
                  ? { value: 'growth', angle: -90, position: 'insideLeft', fill: '#475569', fontSize: 8, dy: 18 }
                  : undefined
              }
            />
          )}

          {bands.map(b => (
            <ReferenceArea
              key={b.key}
              x1={b.from}
              x2={b.to}
              fill={b.fill}
              fillOpacity={b.opacity ?? 0.1}
              stroke="none"
              ifOverflow="hidden"
            />
          ))}
          {markers.map(m => (
            <ReferenceLine
              key={m.key}
              x={m.x}
              stroke={m.colour}
              strokeWidth={m.dashed ? 1 : 1.5}
              strokeDasharray={m.dashed ? '2 2' : undefined}
              ifOverflow="hidden"
              label={m.label ? { value: m.label, position: 'top', fill: m.colour, fontSize: 8 } : undefined}
            />
          ))}

          {/* Drawn dimmed-first so the highlighted curve paints last and sits
              on top of the others rather than behind them. */}
          {[...series]
            .sort((a, b) => Number(a.key === highlight) - Number(b.key === highlight))
            .map(s => {
              const lit = !highlight || s.key === highlight;
              const faded = !!highlight && s.key !== highlight;
              return s.kind === 'model' ? (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.colour}
                  strokeWidth={lit ? 2 : 1.5}
                  strokeOpacity={faded ? 0.12 : 1}
                  filter={lit && highlight ? `url(#${glowId})` : undefined}
                  strokeDasharray={s.dashed ? '3 2' : undefined}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ) : (
                <Line
                  key={s.key}
                  className={`ph-${s.key}`}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.colour}
                  strokeOpacity={faded ? 0.1 : highlight ? 1 : 0.62}
                  strokeWidth={lit && highlight ? 3 : 1.25}
                  filter={lit && highlight ? `url(#${glowId})` : undefined}
                  dot={(d: any) => {
                    if (d.payload?.[s.key] === undefined || faded) return <g key={d.key} />;
                    // Dropped from the fit: struck through, in the neutral
                    // colour, so it stays readable in context but plainly is
                    // not one of the points the curve was fitted to.
                    if (d.payload[`${s.key}__off`]) {
                      const a = 3.2;
                      return (
                        <g key={d.key} stroke="#64748b" strokeWidth={1.1} strokeLinecap="round">
                          <line x1={d.cx - a} y1={d.cy - a} x2={d.cx + a} y2={d.cy + a} />
                          <line x1={d.cx - a} y1={d.cy + a} x2={d.cx + a} y2={d.cy - a} />
                        </g>
                      );
                    }
                    const seen = d.payload[`${s.key}__seen`];
                    const thin = supportOf != null && seen !== undefined && seen < supportOf * PARTIAL_SUPPORT;
                    const r = highlight ? 2.6 : 1.6;
                    return thin ? (
                      <circle key={d.key} cx={d.cx} cy={d.cy} r={r + 1} fill="none" stroke={s.colour} strokeWidth={1} />
                    ) : (
                      <circle key={d.key} cx={d.cx} cy={d.cy} r={r} fill={s.colour} />
                    );
                  }}
                  connectNulls
                  isAnimationActive={false}
                />
              );
            })}
          {/* The white-hot centre. A halo alone spreads its light too thin on a
              stroke this size; a bright core down the middle is what makes the
              lit curve read as illuminated rather than merely thicker. */}
          {highlight && series.some(s => s.key === highlight && s.kind === 'observed') && (
            <Line
              key={`${highlight}__core`}
              type="monotone"
              dataKey={highlight}
              stroke="#ffffff"
              strokeOpacity={0.75}
              strokeWidth={1}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>

      {/* Month boundaries, as a plain reading frame. No verdict is attached to
          them: whether a stretch of the year holds enough imagery depends on
          what the curve is doing there, which only the user can judge. */}
      {axis.months.length > 0 && (
        <div className="pointer-events-none absolute" style={PLOT_BOX(axisW)}>
          {axis.months.map(m => {
            const a = (m.from - lo) / (hi - lo);
            if (a < 0 || a > 1) return null;
            return (
              <span
                key={m.key}
                className="absolute inset-y-0 border-l border-white/[0.05]"
                style={{ left: `${a * 100}%` }}
              />
            );
          })}
        </div>
      )}

      {/* The month strip: drag across it to choose the stretch you want more
          imagery over. It sits below the plot so the curves stay free.

          The sweep is tracked on the window by pointer X, not by each segment's
          own mouse-enter: the strip is only twelve pixels tall, and on a
          trackpad the smallest vertical wander during a drag leaves it — which
          silently stopped the selection growing. */}
      {onMonthsPick && axis.months.length > 0 && (
        <div
          ref={strip}
          className="absolute h-3 cursor-ew-resize"
          style={{ left: axisW + MARGIN.left, right: MARGIN.right, bottom: 0 }}
          onMouseDown={e => {
            e.preventDefault();
            const at = monthAt(e.clientX);
            if (at == null) return;
            putSpan([at, at]);
            const move = (ev: MouseEvent) => {
              const j = monthAt(ev.clientX);
              if (j != null && spanRef.current) putSpan([spanRef.current[0], j]);
            };
            const up = () => {
              window.removeEventListener('mousemove', move);
              window.removeEventListener('mouseup', up);
              const cur = spanRef.current;
              putSpan(null);
              if (cur) {
                const [x, y] = [Math.min(...cur), Math.max(...cur)];
                onMonthsPick(axis.months.slice(x, y + 1).map(mm => mm.key));
              }
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
          }}
        >
          {axis.months.map((m, i) => {
            const a = Math.max(0, (m.from - lo) / (hi - lo));
            const b = Math.min(1, (m.to - lo) / (hi - lo));
            if (!(b > a)) return null;
            const inDrag = span && i >= Math.min(...span) && i <= Math.max(...span);
            return (
              <span
                key={m.key}
                title={`${m.label} ${m.year} · ${m.count} in the series`}
                className={cn(
                  'pointer-events-none absolute bottom-0 top-0 border-l border-white/10 transition-colors',
                  inDrag ? 'bg-sky-400/40' : 'bg-white/[0.06]'
                )}
                style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }}
              />
            );
          })}
        </div>
      )}

      {/* The interaction surface, exactly over the plot area. */}
      <div
        ref={plot}
        className={cn('absolute', onPlotClick && 'cursor-crosshair')}
        style={PLOT_BOX(axisW)}
        onClick={e => {
          const day = dayAt(e.clientX);
          if (day != null) onPlotClick?.(day, nearestSeries(e.clientX, e.clientY));
        }}
        onMouseMove={e => {
          const day = dayAt(e.clientX);
          const r = plot.current?.getBoundingClientRect();
          if (day != null && r) setHover({ x: e.clientX - r.left, day });
          onHighlight?.(nearestSeries(e.clientX, e.clientY));
        }}
        onMouseLeave={() => {
          setHover(null);
          onHighlight?.(null);
        }}
      />
      {tooltip && hover && tooltip(rowAt(hover.day), hover.day) != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded border border-white/10 bg-slate-900/95 px-1.5 py-0.5 text-[10px] text-slate-300 shadow-lg"
          style={{
            left: Math.min(Math.max(hover.x + axisW - 40, 0), Math.max(0, (plot.current?.offsetWidth ?? 0) - 80)),
          }}
        >
          {tooltip(rowAt(hover.day), hover.day)}
        </div>
      )}
    </div>
  );
}
