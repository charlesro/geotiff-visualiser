/**
 * Growth scenarios — step 1: the clustering.
 *
 * Fields of one species do not grow alike: sowing date, variety and management
 * split them into distinct curves. k-means runs separately within each species
 * so scenarios never mix crops, and the scenarios come out biggest-first.
 *
 * This panel answers two questions and nothing else yet: did the split find
 * real, distinct growth curves, and how many of them are worth carrying
 * forward. Everything downstream — the growth period, the fitted model, the
 * extra imagery — is added on top of this.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Boxes, Loader2, ImagePlus, Sprout, Check } from 'lucide-react';
import { CLUSTER_COLORS, SpeciesClustering } from '../../lib/species-clusters';
import { SceneCandidate, SceneClarity } from '../../lib/fetch-series';
import { ZoneExtraction } from '../../lib/zones';
import { Button, ErrorNote, Explain, NumberInput, PrereqNote, ProgressBar, StopButton } from '../ui';
import { cn } from '../../lib/utils';
import {
  PlantPeriod,
  pickKey,
  dayIndex,
  dayIndexToDate,
  fitPlantPeriod,
  growthSignal,
  periodBaseline,
  periodModelAt,
} from '../../lib/phenology';
import { PhenoChart, chartAxis } from './PhenoChart';
import { ScenePicker } from './ScenePicker';
import {
  DEFAULT_K,
  MAX_K,
  baseYearOf,
  keptScenarios,
  MonthMark,
  monthsOf,
  topScenariosValue,
  useImageryFlow,
} from './model';

/** Shorter than this and the sweep was a slip, not a plant period. */
const MIN_PERIOD_DAYS = 10;

export interface ClusterPanelProps {
  width: number;
  onWidthChange: (w: number) => void;
  onClose: () => void;

  zones: ZoneExtraction | null;
  clustering: SpeciesClustering | null;
  busy: boolean;
  error: string | null;
  onRun: (k: number) => void;

  /** How many of the biggest scenarios per species stay in play. */
  topScenarios: number;
  onTopScenariosChange: (n: number) => void;

  // --- the plant period, per scenario ---
  /** Keyed by `pickKey(species, cluster)`; day indices on the series axis. */
  periods: Record<string, PlantPeriod>;
  onPeriodChange: (species: string, cluster: number, period: PlantPeriod | null) => void;
  /** Acquisition days dropped from each scenario's fit, keyed like `periods`. */
  excludedDays: Record<string, number[]>;
  onToggleExcluded: (species: string, cluster: number, day: number) => void;

  // --- filling holes in the series with more imagery ---
  /** False until there are pixel zones to measure a candidate scene against. */
  canAddScenes: boolean;
  /** `range` is inclusive and already excludes the acquisitions bounding the hole. */
  onFindScenes: (range: { start: string; end: string }, maxCloud: number) => Promise<SceneCandidate[]>;
  onCheckClarity: (candidate: SceneCandidate) => Promise<SceneClarity | null>;
  onInsertScenes: (chosen: SceneCandidate[]) => Promise<boolean>;
  onStopInsert: () => void;
  seriesBusy: boolean;
  seriesProgress: { stage: string; current: number; total: number; message: string } | null;
  seriesError: string | null;
}

export default function ClusterSeasonPanel(props: ClusterPanelProps) {
  const c = props.clustering;
  const [k, setK] = useState(c?.k ?? DEFAULT_K);
  const imagery = useImageryFlow(c, props.onFindScenes, props.onCheckClarity);
  // Selecting months is deliberately armed rather than always live: the strip
  // would otherwise be an invisible target sitting under every curve, and a
  // visible one is a permanent bar the user does not need most of the time.
  const [armed, setArmed] = useState(false);
  /** The scenario the plant period is being drawn on. One at a time: the drag
   *  has to belong to a curve, and hover alone would change target mid-gesture. */
  const [selected, setSelected] = useState<{ species: string; cluster: number } | null>(null);
  // Marking is armed too, for the same reason as the month strip: a chart that
  // silently reacts to clicks is not a control anyone can find.
  const [marking, setMarking] = useState(false);
  useEffect(() => setSelected(null), [c?.createdAt]);

  /** Leave both modes and every selection they made — back to the plain curves. */
  const stopEditing = () => {
    setMarking(false);
    setArmed(false);
    setSelected(null);
    imagery.closePicker();
  };
  // Escape is the reflex for "get me out of this", and without it the only way
  // back was to notice that the button toggles.
  useEffect(() => {
    if (!marking && !armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopEditing();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [marking, armed]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) =>
      props.onWidthChange(
        Math.max(400, Math.min(window.innerWidth - 320, Math.round(window.innerWidth - ev.clientX)))
      );
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const baseYear = baseYearOf(c?.dates);
  const months = useMemo(() => (c ? monthsOf(c.dates, baseYear) : []), [c, baseYear]);

  const totals = useMemo(() => {
    if (!c) return null;
    const fields = c.groups.reduce((a, g) => a + g.sizes.reduce((x, y) => x + y, 0), 0);
    const kept = c.groups.reduce(
      (a, g) => a + g.sizes.filter((_, i) => i < props.topScenarios).reduce((x, y) => x + y, 0),
      0
    );
    const count = c.groups.reduce(
      (a, g) => a + keptScenarios(g.sizes, g.centroids.length, props.topScenarios).length,
      0
    );
    return { fields, kept, count, share: fields > 0 ? kept / fields : 0 };
  }, [c, props.topScenarios]);

  return (
    <div
      className="absolute inset-y-0 right-0 z-[1100] flex max-w-full flex-col border-l border-white/10 bg-[#0d1117f5] backdrop-blur"
      style={{ width: props.width }}
    >
      <div
        onPointerDown={startResize}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-sky-500/40"
        title="Drag to resize"
      />

      <header className="flex items-start gap-3 border-b border-white/[0.07] px-4 pb-3 pt-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold leading-none text-slate-100">
            <Boxes className="h-4 w-4 shrink-0 text-sky-400" />
            Growth scenarios
          </h2>
          <p className="mt-1.5 text-[11px] leading-none text-slate-500">
            {totals ? (
              <>
                <span className="tabular-nums text-slate-400">{totals.count}</span> scenarios ·{' '}
                <span className="tabular-nums">{totals.kept.toLocaleString()}</span> of{' '}
                <span className="tabular-nums">{totals.fields.toLocaleString()}</span> fields
              </>
            ) : (
              'Split each species into distinct growth curves'
            )}
          </p>
        </div>
        <button
          onClick={props.onClose}
          className="shrink-0 pt-0.5 text-slate-400 hover:text-slate-200"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* Controls sit in their own bar, labelled above the field rather than
          beside it, so what is editable is unambiguous at a glance. */}
      <div className="flex items-end gap-3 border-b border-white/[0.07] px-4 py-3">
        <label className="shrink-0">
          <span className="mb-1 block text-[10px] uppercase tracking-[0.06em] text-slate-500">
            scenarios / species
          </span>
          <NumberInput min={2} max={MAX_K} value={k} onChange={setK} className="w-[68px] py-1 text-[13px]" />
        </label>

        {c && (
          <label className="shrink-0">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.06em] text-slate-500">
              keep biggest
            </span>
            <NumberInput
              min={1}
              max={c.k}
              value={Math.min(props.topScenarios, c.k)}
              onChange={n => props.onTopScenariosChange(topScenariosValue(n, c.k))}
              className="w-[68px] py-1 text-[13px]"
            />
          </label>
        )}

        <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
          {c && (
            <span className="text-[10px] tabular-nums text-slate-500">
              {((totals?.share ?? 0) * 100).toFixed(0)}% of fields kept
            </span>
          )}
          <div className="flex items-center gap-2">
            {c && (
              <button
                onClick={() => {
                  if (marking) stopEditing();
                  else {
                    setMarking(true);
                    setArmed(false);
                  }
                }}
                title={
                  marking
                    ? 'Finish and go back to the curves (Esc)'
                    : 'Click a curve, then click the start and end of its growth'
                }
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] transition-colors',
                  marking
                    ? 'border-emerald-400/50 bg-emerald-500/10 text-emerald-200'
                    : 'border-white/10 text-slate-300 hover:border-emerald-400/40 hover:text-emerald-200'
                )}
              >
                {marking ? <Check className="h-3.5 w-3.5" /> : <Sprout className="h-3.5 w-3.5" />}
                {marking ? 'Done' : 'Growth period'}
              </button>
            )}
            {c && (
              <button
                onClick={() => {
                  if (armed) stopEditing();
                  else {
                    setArmed(true);
                    setMarking(false);
                    setSelected(null);
                  }
                }}
                disabled={!props.canAddScenes}
                title={
                  props.canAddScenes
                    ? 'Pick a stretch of months to look for more imagery in'
                    : 'Extract the pixel zones in step 3 first'
                }
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] transition-colors',
                  armed
                    ? 'border-sky-400/50 bg-sky-500/10 text-sky-200'
                    : 'border-white/10 text-slate-300 hover:border-sky-400/40 hover:text-sky-200',
                  !props.canAddScenes && 'cursor-not-allowed opacity-40'
                )}
              >
                {armed ? <Check className="h-3.5 w-3.5" /> : <ImagePlus className="h-3.5 w-3.5" />}
                {armed ? 'Done' : 'Add imagery'}
              </button>
            )}
            <Button onClick={() => props.onRun(k)} busy={props.busy} disabled={!props.zones}>
              <Boxes className="h-3.5 w-3.5" />
              {c ? 'Re-cluster' : 'Find scenarios'}
            </Button>
          </div>
        </div>
      </div>

      {c && marking && (
        <div className="border-b border-white/[0.07] px-4 py-2.5 text-[11px] text-emerald-300/80">
          {selected == null
            ? 'Click a curve to choose a scenario, then click the start and the end of its growth. Both ends become zero, and so does everything outside them.'
            : `Scenario ${selected.cluster + 1} selected — click the start of growth, then the end. Pick another scenario from the legend below its chart.`}
          <span className="ml-2 text-emerald-300/50">Esc or Done to finish.</span>
        </div>
      )}

      {/* Only ever present once there is something to say: an insert running, a
          failure, a span the user asked about, or the selector armed. */}
      {c && (props.seriesBusy || props.seriesError || imagery.picker || armed) && (
        <div className="space-y-2 border-b border-white/[0.07] px-4 py-2.5 text-[11px]">
          {armed && !imagery.picker && !props.seriesBusy && (
            <p className="text-sky-300/80">
              Drag across the months under any curve to see what the catalogue holds there.
            </p>
          )}
          {props.seriesBusy && props.seriesProgress && (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <ProgressBar
                  current={props.seriesProgress.current}
                  total={props.seriesProgress.total}
                  message={props.seriesProgress.message}
                />
              </div>
              <StopButton onClick={props.onStopInsert} />
            </div>
          )}
          <ErrorNote message={props.seriesError} />
          {imagery.picker && (
            <ScenePicker
              state={imagery.picker}
              busy={props.seriesBusy}
              clarity={imagery.clarity}
              onCheck={imagery.check}
              onCheckAll={imagery.checkAll}
              onInsert={chosen => props.onInsertScenes(chosen)}
              onClose={imagery.closePicker}
            />
          )}
        </div>
      )}

      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {!props.zones && (
          <PrereqNote message="Extract the pixel zones in step 3 first — the clustering reads each field's interior pixels." />
        )}
        <ErrorNote message={props.error} />
        {props.busy && (
          <p className="flex items-center gap-2 text-[11px] text-sky-300/90">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Clustering each species…
          </p>
        )}
        {props.zones && !c && !props.busy && (
          <p className="text-[11px] leading-relaxed text-slate-500">
            Each field is summarised by the mean {props.zones.metric} curve of its interior pixels — edge
            pixels are contaminated by the neighbouring parcel. k-means then runs within every species
            separately, so a scenario is always one crop.
          </p>
        )}

        {c &&
          c.groups.map(group => (
            <SpeciesBlock
              key={group.species}
              group={group}
              dates={c.dates}
              baseYear={baseYear}
              topScenarios={props.topScenarios}
              onKeep={n => props.onTopScenariosChange(topScenariosValue(n, c.k))}
              marking={marking}
              onPickMonths={armed && props.canAddScenes ? ms => imagery.ask(ms, baseYear) : undefined}
              periods={props.periods}
              onPeriodChange={props.onPeriodChange}
              excludedDays={props.excludedDays}
              onToggleExcluded={props.onToggleExcluded}
              selected={selected?.species === group.species ? selected.cluster : null}
              onSelect={cluster =>
                setSelected(cur =>
                  cur?.species === group.species && cur.cluster === cluster
                    ? null
                    : { species: group.species, cluster }
                )
              }
            />
          ))}

        {c && (
          <p className="text-[10px] leading-snug text-slate-600">
            {c.dates.length} acquisition dates
            {c.dates.length > c.clusteringDates.length
              ? `, ${c.clusteringDates.length} of them seen by nearly every field — only those decide the split`
              : ''}
            {c.droppedFields > 0 ? ` · ${c.droppedFields} field(s) had too gappy a series to place` : ''}.
          </p>
        )}
      </div>
    </div>
  );
}

/** One species: its scenarios overlaid, then read back as a legend. */
function SpeciesBlock({
  group,
  dates,
  baseYear,
  topScenarios,
  onKeep,
  marking,
  onPickMonths,
  periods,
  onPeriodChange,
  excludedDays,
  onToggleExcluded,
  selected,
  onSelect,
}: {
  group: SpeciesClustering['groups'][number];
  dates: string[];
  baseYear: number;
  topScenarios: number;
  /** Raise the keep-biggest count, from the species that prompted it. */
  onKeep: (n: number) => void;
  /** Absent when there is nothing to measure a candidate scene against yet. */
  /** True while the panel is in plant-period marking mode. */
  marking: boolean;
  onPickMonths?: (months: MonthMark[]) => void;
  periods: Record<string, PlantPeriod>;
  onPeriodChange: (species: string, cluster: number, period: PlantPeriod | null) => void;
  excludedDays: Record<string, number[]>;
  onToggleExcluded: (species: string, cluster: number, day: number) => void;
  /** The scenario whose plant period is being edited, if it is in this species. */
  selected: number | null;
  onSelect: (cluster: number) => void;
}) {
  // One piece of state ties the chart and the legend together: whatever the
  // pointer is on, every element belonging to that scenario lights up and the
  // rest recede.
  const [lit, setLit] = useState<number | null>(null);
  const kept = keptScenarios(group.sizes, group.centroids.length, topScenarios);
  const dropped = group.centroids
    .map((_, ci) => ci)
    .filter(ci => !kept.includes(ci) && (group.sizes[ci] ?? 0) > 0);
  const total = group.sizes.reduce((a, b) => a + b, 0);
  const axis = chartAxis(dates, baseYear, 80);

  const obsDays = dates.map(d => dayIndex(d, baseYear));

  /** Every scenario that has a plant period, with its fit and its baseline. */
  const fitted = useMemo(() => {
    const out = new Map<
      number,
      { period: PlantPeriod; fit: ReturnType<typeof fitPlantPeriod>; base: ((t: number) => number) | null }
    >();
    for (const ci of kept) {
      const period = periods[pickKey(group.species, ci)];
      if (!period) continue;
      const vals = group.centroids[ci];
      const off = new Set(excludedDays[pickKey(group.species, ci)] ?? []);
      out.set(ci, {
        period,
        fit: fitPlantPeriod(obsDays, vals, period, off),
        base: periodBaseline(obsDays, vals, period, off),
      });
    }
    return out;
  }, [kept, periods, excludedDays, group, obsDays]);

  const data = axis.points.map(t => {
    const row: Record<string, number | undefined> = { t };
    const oi = axis.dayToObs.get(t);
    for (const ci of kept) {
      if (oi !== undefined && isFinite(group.centroids[ci][oi])) row[`c${ci}`] = group.centroids[ci][oi];
      // The fitted cycle, put back on the raw scale so it lies over its own
      // data. Only inside the period: outside, the model is zero growth, which
      // on a reflectance axis is the baseline, not a value worth drawing.
      const f = fitted.get(ci);
      // A refused fit still returns parameters so its reason can be shown; they
      // describe nothing and must not be drawn — they would also drag the shared
      // Y domain far past the data.
      if (f?.fit && !f.fit.note && f.base && t >= f.period.start && t <= f.period.end) {
        row[`m${ci}`] = f.base(t) + periodModelAt(f.fit, f.period, t);
      }
    }
    return row;
  });

  /** The first of the two clicks that make a period, if one has landed. */
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => setPending(null), [selected]);
  const livePeriod = (ci: number) => periods[pickKey(group.species, ci)] ?? null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 text-[10px]">
        <span className="truncate font-medium uppercase tracking-[0.08em] text-slate-400">
          {group.species}
        </span>
        <span className="shrink-0 tabular-nums text-slate-600">{total.toLocaleString()} fields</span>
      </div>

      {/* Every kept scenario on one axis — the only way to see whether the split
          actually found different growth curves or just sliced one apart. */}
      <PhenoChart
        axis={axis}
        data={data}
        height={132}
        yAxis="value"
        series={kept.flatMap(ci => [
          { key: `c${ci}`, colour: CLUSTER_COLORS[ci % CLUSTER_COLORS.length], kind: 'observed' as const },
          {
            key: `m${ci}`,
            colour: CLUSTER_COLORS[ci % CLUSTER_COLORS.length],
            kind: 'model' as const,
            dashed: true,
          },
        ])}
        bands={
          selected != null && livePeriod(selected)
            ? [
                {
                  key: 'period',
                  from: livePeriod(selected)!.start,
                  to: livePeriod(selected)!.end,
                  fill: CLUSTER_COLORS[selected % CLUSTER_COLORS.length],
                  opacity: 0.14,
                },
              ]
            : []
        }
        markers={
          pending != null && selected != null
            ? [{ key: 'pending', x: pending, colour: CLUSTER_COLORS[selected % CLUSTER_COLORS.length] }]
            : []
        }
        highlight={selected != null ? `c${selected}` : lit != null ? `c${lit}` : null}
        onHighlight={key => setLit(key ? Number(key.slice(1)) : null)}
        onPlotClick={
          !marking
            ? undefined
            : (day, nearest) => {
                // Picking a scenario is a click on its curve; once one is
                // chosen every click in the plot is a boundary.
                //
                // Switching by clicking another curve sounds convenient and is
                // not: the start of growth is precisely where all the curves of
                // a species are bunched together near zero, so the first click
                // of a period would be swallowed as a switch. The legend is the
                // way to change scenario — it is unambiguous at any zoom.
                if (selected == null) {
                  if (nearest) onSelect(Number(nearest.slice(1)));
                  return;
                }
                if (pending == null) {
                  // The existing period survives until a complete replacement
                  // lands, so a stray click cannot destroy one.
                  setPending(day);
                  return;
                }
                if (day === pending) return;
                setPending(null);
                onPeriodChange(group.species, selected, {
                  start: Math.min(pending, day),
                  end: Math.max(pending, day),
                });
              }
        }
        onMonthsPick={
          onPickMonths ? keys => onPickMonths(axis.months.filter(m => keys.includes(m.key))) : undefined
        }
        // Nothing to say unless the pointer is actually on a curve.
        tooltip={(row, day) =>
          lit == null ? null : (
            <span className="tabular-nums">
              <span className="text-slate-400">{dayLabel(day, baseYear)}</span>
              <span className="mx-1 text-slate-600">·</span>
              <span style={{ color: CLUSTER_COLORS[lit % CLUSTER_COLORS.length] }}>{lit + 1}</span>
              {typeof row?.[`c${lit}`] === 'number' && (
                <span className="ml-1 text-slate-300">{(row[`c${lit}`] as number).toFixed(3)}</span>
              )}
            </span>
          )
        }
      />

      {selected != null && (
        <PeriodReadout
          species={group.species}
          cluster={selected}
          colour={CLUSTER_COLORS[selected % CLUSTER_COLORS.length]}
          axis={axis}
          obsDays={obsDays}
          values={group.centroids[selected]}
          period={livePeriod(selected)}
          pending={pending}
          excluded={excludedDays[pickKey(group.species, selected)] ?? []}
          onToggleExcluded={day => onToggleExcluded(group.species, selected, day)}
          fit={fitted.get(selected)?.fit ?? null}
          baseYear={baseYear}
          onClear={() => onPeriodChange(group.species, selected, null)}
        />
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
        {kept.map(ci => {
          const on = lit === ci || selected === ci;
          const dim = (lit != null || selected != null) && !on;
          return (
            <button
              key={ci}
              onMouseEnter={() => setLit(ci)}
              onMouseLeave={() => setLit(null)}
              onClick={() => onSelect(ci)}
              title={selected === ci ? 'Click to stop editing this period' : 'Click to set its plant period'}
              className={cn(
                'flex items-center gap-1.5 rounded px-1 py-0.5 transition-all duration-100',
                selected === ci && 'bg-sky-500/15 ring-1 ring-sky-400/30',
                on && selected !== ci && 'bg-white/[0.06]',
                dim && 'opacity-25'
              )}
            >
              <span
                className="rounded-full transition-all duration-100"
                style={{
                  background: CLUSTER_COLORS[ci % CLUSTER_COLORS.length],
                  width: on ? 4 : 2,
                  height: on ? 12 : 8,
                }}
              />
              <span className={on ? 'font-medium text-slate-100' : 'text-slate-400'}>{ci + 1}</span>
              <span className={cn('tabular-nums', on ? 'text-slate-300' : 'text-slate-600')}>
                {group.sizes[ci]} · {((group.sizes[ci] / total) * 100).toFixed(0)}%
              </span>
            </button>
          );
        })}
        {dropped.length > 0 && (
          <button
            onClick={() => onKeep(kept.length + 1)}
            className="tabular-nums text-slate-600 underline decoration-dotted underline-offset-2 transition-colors hover:text-sky-300"
            title={`Also keep scenario ${kept.length + 1} (${group.sizes[dropped[0]]} fields)`}
          >
            + {dropped.length} smaller ({dropped.reduce((a, ci) => a + group.sizes[ci], 0)} fields)
          </button>
        )}
      </div>
    </section>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A day on the series axis, as a date a person reads.
 *
 * "14 Oct", not "10-14": these numbers sit in a column beside rates and
 * durations, where a hyphenated pair reads as a range or a subtraction rather
 * than a calendar date. The year appears only when it is not the series' own,
 * which is the only case where it disambiguates anything.
 */
const dayLabel = (day: number, baseYear: number) => {
  const iso = dayIndexToDate(Math.round(day), baseYear);
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${y === baseYear ? '' : ` ${y}`}`;
};

/** 10–90% width (days) of a logistic transition with rate `k`. */
const transitionWidth = (k: number) => Math.log(81) / k;

/**
 * The selected scenario's growth, as the model sees it: zero at both boundaries
 * and zero outside, with the fitted double logistic over it. This is the thing
 * being parametrised, so it is shown on its own terms rather than as a bump on a
 * reflectance axis.
 */
function PeriodReadout({
  species,
  cluster,
  colour,
  axis,
  obsDays,
  values,
  period,
  pending,
  excluded,
  onToggleExcluded,
  fit,
  baseYear,
  onClear,
}: {
  species: string;
  cluster: number;
  colour: string;
  axis: ReturnType<typeof chartAxis>;
  obsDays: (number | null)[];
  values: number[];
  period: PlantPeriod | null;
  /** The first click of a pair, once it has landed. */
  pending: number | null;
  /** Acquisition days left out of the fit. */
  excluded: number[];
  onToggleExcluded: (day: number) => void;
  fit: ReturnType<typeof fitPlantPeriod>;
  baseYear: number;
  onClear: () => void;
}) {
  if (!period) {
    return (
      <p className="rounded-md border border-sky-400/25 bg-sky-500/[0.04] px-3 py-2 text-[11px] text-sky-300/80">
        {pending == null ? (
          <>
            Click the start of growth on scenario {cluster + 1}’s curve, then the end. Both boundaries become
            zero, and so does everything outside them.
          </>
        ) : (
          <>Now click the end of growth.</>
        )}
      </p>
    );
  }

  const off = new Set(excluded);
  // Only the exclusions inside the period matter — one outside it changes
  // nothing, and counting it read as "the fit is missing a point" when it was
  // not. Narrowing a period can move a dropped point out of range.
  const droppedInside = excluded.filter(d => d >= period.start && d <= period.end).length;
  // A drop outside the period is inert now but comes back the moment the period
  // is widened over it, so it stays visible and restorable rather than silent.
  const outsidePeriod = excluded.length - droppedInside;
  const growth = growthSignal(obsDays, values, period, off);
  const data = axis.points.map(t => {
    const oi = axis.dayToObs.get(t);
    const row: Record<string, number | undefined> = { t };
    if (oi !== undefined && growth[oi] != null) {
      row.g = growth[oi] as number;
      // Marks the dot as dropped; the line still passes through it so the point
      // stays visible in context rather than vanishing.
      if (off.has(t)) row.g__off = 1;
    }
    if (fit && !fit.note) row.m = periodModelAt(fit, period, t);
    return row;
  });
  /** Snap a click to the acquisition it landed on, if it landed on one. */
  const obsNear = (day: number) => {
    let best: number | null = null;
    let bestD = Infinity;
    for (const t of axis.obs) {
      const d = Math.abs(t - day);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best != null && bestD <= (axis.hi - axis.lo) * 0.02 ? best : null;
  };
  const p = fit?.params;
  const short = (d: number) => dayLabel(d, baseYear);

  return (
    <div className="rounded-md border border-white/[0.08] bg-white/[0.015]">
      <div className="flex items-baseline justify-between gap-2 px-3 pt-2 text-[10px]">
        <span className="flex items-baseline gap-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colour }} />
          <span className="text-slate-300">scenario {cluster + 1} · plant period</span>
          <span className="tabular-nums text-slate-400">
            {short(period.start)} – {short(period.end)}
          </span>
          <span className="tabular-nums text-slate-600">{Math.round(period.end - period.start)} d</span>
          {pending != null && <span className="text-sky-300/90">now click the end</span>}
        </span>
        <span className="flex items-baseline gap-2">
          {fit && isFinite(fit.r2) && (
            <Explain
              text={
                fit.dof < 2 ? (
                  <>
                    {fit.points} observations and 6 parameters leaves {fit.dof} spare, so R² is not evidence
                    here — a six-parameter curve passes through almost any {fit.points} points and scores
                    close to 1 whatever it does between them. What the curve misses each observation by is
                    the honest number, and it is at most {fit.maxResidual.toFixed(3)}. Add imagery inside the
                    period to earn a verdict.
                  </>
                ) : (
                  <>
                    R² across the {fit.points} observations inside the period, with {fit.dof} of them spare
                    after the 6 parameters. The worst single point misses the curve by{' '}
                    {fit.maxResidual.toFixed(3)}.
                  </>
                )
              }
            >
              <span
                className={cn(
                  'tabular-nums underline decoration-dotted underline-offset-2',
                  fit.dof < 2 ? 'text-amber-300/80' : 'text-emerald-400/80'
                )}
              >
                {fit.dof < 2
                  ? `${fit.points} pts · 6 params`
                  : `R² ${fit.r2.toFixed(3)}`}
                <span className="ml-1.5 text-slate-500">±{fit.maxResidual.toFixed(3)}</span>
              </span>
            </Explain>
          )}
          {fit?.note && <span className="text-amber-300/80">{fit.note}</span>}
          {excluded.length > 0 && (
            <Explain
              text={
                <>
                  {droppedInside} of the {excluded.length} dropped point
                  {excluded.length === 1 ? '' : 's'} fall{droppedInside === 1 ? 's' : ''} inside this
                  period and {droppedInside === 1 ? 'is' : 'are'} left out of the fit
                  {outsidePeriod > 0 && (
                    <>
                      ; the other {outsidePeriod} sit{outsidePeriod === 1 ? 's' : ''} outside it and change
                      {outsidePeriod === 1 ? 's' : ''} nothing until the period is widened over{' '}
                      {outsidePeriod === 1 ? 'it' : 'them'}
                    </>
                  )}
                  . The model has 6 parameters, so a period needs 6 usable observations before it can be
                  fitted at all — on a sparse series one dropped date is enough to put a period below the
                  bar. Click to put them all back.
                </>
              }
            >
              <button
                onClick={() => excluded.forEach(onToggleExcluded)}
                className="tabular-nums text-amber-300/70 underline decoration-dotted underline-offset-2 hover:text-amber-200"
              >
                {droppedInside > 0 ? `${droppedInside} dropped` : `${outsidePeriod} dropped outside`}
              </button>
            </Explain>
          )}
          <button onClick={onClear} className="text-slate-600 hover:text-rose-300">
            clear
          </button>
        </span>
      </div>

      <p className="px-3 pb-1 text-[10px] text-slate-600">
        Click a point below to leave it out of the fit — a cloudy or snowed-over date can drag the whole
        curve. Click it again to put it back.
      </p>
      <PhenoChart
        axis={axis}
        data={data}
        height={104}
        yAxis="growth"
        series={[
          { key: 'g', colour, kind: 'observed' },
          { key: 'm', colour, kind: 'model' },
        ]}
        bands={[{ key: 'p', from: period.start, to: period.end, fill: colour, opacity: 0.1 }]}
        onPlotClick={day => {
          const t = obsNear(day);
          if (t != null) onToggleExcluded(t);
        }}
        markers={
          p && fit && !fit.note
            ? [
                { key: 'x01', x: p.x01, colour: '#94a3b8', dashed: true, label: 'x01' },
                { key: 'tc', x: p.tc, colour: '#64748b', dashed: true, label: 'tc' },
                { key: 'x02', x: p.x02, colour: '#94a3b8', dashed: true, label: 'x02' },
              ]
            : []
        }
      />

      {p && fit && !fit.note && (
        <p className="px-3 pb-1 text-[10px] text-slate-600">
          <Explain text={
            <>
              Two logistics blended into one another: a rising limb g(t) for green-up, a falling limb d(t)
              for senescence, and a sharp blend b(t) that hands over from one to the other around tc. The
              sum of three copies 365 days apart makes it periodic, so a cycle running past New Year stays
              continuous. Fitted only to the acquisitions inside the period you marked.
            </>
          }>
            <span className="underline decoration-dotted decoration-slate-700 underline-offset-2">
              f = (1−b)·g + b·d, wrapped over 365 d
            </span>
          </Explain>
        </p>
      )}
      {/* Column-major, so each column is one idea: the peak, then when and how
          fast green-up happens, then the same for senescence. Row-major put k1
          beside L1, which pairs a rate with an amplitude for no reason. */}
      {p && fit && !fit.note && (
        <div className="grid grid-flow-col grid-rows-3 gap-x-4 gap-y-0.5 px-3 pb-2 text-[10px] sm:grid-rows-2">
          <Param
            sym="L1"
            value={p.L1.toFixed(3)}
            meaning="peak"
            tip="PEAK — the value the rising limb saturates at. The realised maximum can sit below it when the two limbs overlap, because senescence starts before green-up has finished."
          />
          <Param
            sym="tc"
            value={short(p.tc)}
            meaning="hand-over"
            tip="OFFSET — a date: the day the blend switches from the green-up limb to the senescence limb. Its 2.5-day scale makes the hand-over sharp, so the two limbs do not average each other into a flat plateau."
          />
          <Param
            sym="x01"
            value={short(p.x01)}
            meaning="green-up mid"
            tip="START — a date: the green-up inflection, when the rising limb is halfway to its peak. The steepest point of the rise, and the most robust date the fit produces."
          />
          <Param
            sym="k1"
            value={p.k1.toFixed(3)}
            meaning={fit.unconstrained.greenUp ? 'not measured' : `over ${transitionWidth(p.k1).toFixed(0)} d`}
            dim={!!fit.unconstrained.greenUp}
            tip={
              fit.unconstrained.greenUp
                ? `GROWTH — the green-up rate. Green-up happens entirely inside a ${fit.unconstrained.greenUp.toFixed(0)}-day gap between acquisitions, so any speed that gets from one image to the next fits equally well: this number comes from the optimizer, not from the data. Add imagery in that gap to measure it.`
                : `GROWTH — the green-up rate, per day. Read as a duration it is the 10–90% width, ln(81)/k1 ≈ ${transitionWidth(p.k1).toFixed(0)} days.`
            }
          />
          <Param
            sym="x02"
            value={short(p.x02)}
            meaning="senescence mid"
            tip="END — a date: the senescence inflection, when the falling limb is halfway down. Harvest, or the end of the cycle."
          />
          <Param
            sym="k2"
            value={p.k2.toFixed(3)}
            meaning={fit.unconstrained.senescence ? 'not measured' : `over ${transitionWidth(p.k2).toFixed(0)} d`}
            dim={!!fit.unconstrained.senescence}
            tip={
              fit.unconstrained.senescence
                ? `DECAY — the senescence rate. The fall happens entirely inside a ${fit.unconstrained.senescence.toFixed(0)}-day gap between acquisitions, so its speed is not measured — only the fact that it happened somewhere in there. Add imagery in that gap to pin it down.`
                : `DECAY — the senescence rate, per day. Positive: the limb falls because d(t) subtracts its logistic from the peak. As a duration, ln(81)/k2 ≈ ${transitionWidth(p.k2).toFixed(0)} days.`
            }
          />
        </div>
      )}
    </div>
  );
}

const Param = ({
  sym,
  value,
  meaning,
  tip,
  dim,
}: {
  sym: string;
  value: string;
  meaning: string;
  tip: string;
  /** The data does not determine this one — shown, but not to be relied on. */
  dim?: boolean;
}) => (
  <div className={cn('flex items-baseline gap-1.5', dim && 'text-slate-600')}>
    <Explain text={tip} className="w-6 shrink-0">
      <span className="italic text-slate-400 underline decoration-dotted decoration-slate-600 underline-offset-2">
        {sym}
      </span>
    </Explain>
    <span className={cn('w-[52px] shrink-0 text-right tabular-nums', dim ? 'text-slate-500' : 'text-slate-200')}>
      {value}
    </span>
    <span className={cn('truncate', dim ? 'text-amber-300/50' : 'text-slate-600')}>{meaning}</span>
  </div>
);
