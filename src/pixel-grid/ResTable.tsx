import React from 'react';
import { Explain } from './ui';
import { fmt, pct0 } from './util';
import type { SweepStep } from './PcaSweep';

/**
 * The ladder as a table: one row per satellite, the figures a design is read
 * by side by side, a click on a row to put that satellite on the map.
 *
 * It replaces, by default, a grid of nine small scatter plots with their
 * figures in a caption over each. In a panel 320 px wide those were three to a
 * row and unreadable; with the aligned comparison on they were eighteen, a pair
 * to a row, 2,600 px of scrolling to compare numbers that were never on screen
 * together. A table holds the nine sizes, or the nine pairs, in one view. The
 * small plots are still there for whoever wants the picture: the ladder's
 * header switches between the two.
 *
 * Every number is the rung's own, exactly as a panel printed it; this is
 * another way of laying out the same `SweepStep`s, and it computes nothing.
 */

const tone = (v: number) => (v >= 70 ? 'text-emerald-400' : v >= 40 ? 'text-amber-400' : 'text-rose-400');
/**
 * A rung's pure share as a faint bar BEHIND its figures, the width of the cell
 * they stand in. A bar of its own needs a column, and in a 320 px panel the
 * column left for it was twelve pixels wide.
 */
function bar(s: SweepStep): React.CSSProperties {
  const v = s.current || s.resolvingPct == null ? 0 : Math.max(0, Math.min(100, s.resolvingPct));
  if (!(v > 0)) return {};
  const rgb = v >= 70 ? '52, 211, 153' : v >= 40 ? '251, 191, 36' : '251, 113, 133';
  return { backgroundImage: `linear-gradient(to right, rgba(${rgb}, 0.16) ${v}%, transparent ${v}%)` };
}
const TERM = 'underline decoration-neutral-700 decoration-dotted underline-offset-2';

/** What a rung says, as a panel's tooltips said it. */
function about(s: SweepStep, geoErrM: number, threshold: number): string {
  const t = s.plotsRobust ?? s.plots;
  return [
    s.resolvingPct == null
      ? null
      : `${fmt(s.pureCount ?? NaN)} pure of the ${fmt(s.plantCount ?? NaN)} pixels of crop this design plants`,
    s.geoRobust !== undefined
      ? `${fmt(s.geoRobustPure ?? 0)} px stay pure, for the same plot, for any geolocation error within the CE90 (${s.ce90M ?? geoErrM} m)${s.geoMean !== undefined ? `; with σeff instead: ${pct0(s.geoMean)}` : ''}`
      : null,
    t ? `pure pixels in each plot: minimum ${t.min}, median ${t.median}; ${t.none} of ${t.plots} plots have none` : null,
    s.minPlotM !== undefined ? `the note's closed form asks for a plot side of at least ${s.minPlotM.toFixed(1)} m (ε = ${100 - threshold} %)` : null,
    s.contrastDead ? 'two varieties cannot be told apart at this pixel size' : null,
    s.partial ? 'sampled over the central part of a large field' : null,
    s.placement ? where(s.placement) : null,
  ].filter(Boolean).join(' · ');
}

/** An angle to the pixel rows, as short as it can be said: 45°, 22.75°. */
const deg = (a: number) => `${+a.toFixed(2)}°`;
/** Where a best-placement rung puts the trial, in words. */
function where(p: NonNullable<SweepStep['placement']>): string {
  if (!p.searched) return 'not searched at this size (too many pixels to try placements on): the trial as the file has it';
  if (p.turn === 0 && p.shift[0] === 0 && p.shift[1] === 0) return `no placement found that beats the trial as the file has it, at ${deg(p.angle)}`;
  return `the trial at ${deg(p.angle)} to the pixel rows, turned ${+Math.abs(p.turn).toFixed(2)}° ${p.turn < 0 ? 'clockwise' : 'counter-clockwise'} from the file and moved ${+p.shift[0].toFixed(2)} m east, ${+p.shift[1].toFixed(2)} m north`;
}

/** A rung's pure share, or what stands in for it while it is being worked out. */
const share = (s: SweepStep): React.ReactNode =>
  s.current || s.resolvingPct === undefined ? <span className="text-neutral-600">…</span>
    : s.resolvingPct === null ? <span className="text-rose-400">n/a</span>
    : <span className={tone(s.resolvingPct)}>{s.resolvingPct.toFixed(0)}%</span>;
const held = (s: SweepStep): React.ReactNode =>
  s.current || s.geoRobust === undefined ? <span className="text-neutral-600">…</span>
    : <span className={s.geoRobust < 0.5 ? 'text-rose-400' : 'text-neutral-300'}>{pct0(s.geoRobust)}</span>;

export function ResTable({ steps, pairWith, pairLabels, shown = 0, activeId, onPick, onPickPair, geoErrM = 0, threshold }: {
  steps: SweepStep[];
  /** A second ladder over the same sizes (the design along the pixel rows): two groups of columns. */
  pairWith?: SweepStep[] | null;
  /** What the two ladders are, in a few words each. */
  pairLabels?: [string, string];
  /** Which of the two placements is on the map; null when it is neither. */
  shown?: 0 | 1 | null;
  /** The satellite selected: its row is the one on the map. */
  activeId?: string;
  onPick?: (id: string) => void;
  onPickPair?: (id: string) => void;
  geoErrM?: number;
  threshold: number;
}) {
  const isActive = (id: string) => activeId === id;
  const anyHeld = [...steps, ...(pairWith ?? [])].some(s => s.geoRobust !== undefined);
  const anyPlots = steps.some(s => (s.plotsRobust ?? s.plots) !== undefined);
  // The satellite, and under it the pixel size its row is computed at.
  const size = (s: SweepStep) => (
    <span className="min-w-0 leading-tight">
      <span className={`block truncate text-[12.5px] ${isActive(s.id) ? 'text-sky-300' : 'text-neutral-300'}`}>{s.name}</span>
      <span className="block whitespace-nowrap font-mono text-[11px] text-neutral-500">
        {s.res} m{s.partial ? <span title="Sampled over the central part of a large field"> ◦</span> : null}
      </span>
    </span>
  );
  /** Wide enough for the longest name, and no wider. */
  const NAME = 'minmax(4.4rem, max-content)';
  const pureTip = 'Pure pixels, as a share of the crop this design plants, for that satellite: its pixel size and its blur. A pixel is pure when its dominant plot holds at least the threshold of its signal.';
  const heldTip = `Pixels that stay pure, for the same plot, wherever the image lands within its CE90${geoErrM > 0 ? ` (${geoErrM} m for the satellite shown)` : ''}.`;
  const head = 'text-[12px] text-neutral-500';

  // Two placements side by side: the share and what holds within the CE90, for each.
  if (pairWith) {
    // The columns as an inline style: a class name put together at run time is one Tailwind never sees.
    // A best-placement ladder says at which angle each of its rungs is: one
    // more narrow column, there only then.
    const anyPlace = pairWith.some(s => s.placement);
    const cols: React.CSSProperties = { gridTemplateColumns: `${NAME} repeat(${anyHeld ? 4 : 2}, minmax(0, 1fr))${anyPlace ? ' 2.4rem' : ''}` };
    const span = anyHeld ? 'col-span-2' : '';
    // The two names, each over its own figures and one column more: the first
    // takes the size column's, the second the angle's when there is one. In a
    // narrow panel a name as wide as its two figures was cut short.
    const wide = anyHeld ? 'col-span-3' : 'col-span-2';
    const nameSpan = [wide, anyPlace ? wide : span];
    const group = (s: SweepStep | undefined, which: 0 | 1, pick?: (id: string) => void) => {
      if (!s) return <span className={span} />;
      const on = isActive(s.id) && shown === which;
      return (
        <button type="button" onClick={() => pick?.(s.id)} title={about(s, geoErrM, threshold)} style={bar(s)}
          className={`${span} grid ${anyHeld ? 'grid-cols-2' : 'grid-cols-1'} rounded px-1 py-0.5 text-right font-mono text-[13px] transition-shadow ${on ? 'ring-1 ring-sky-400/70' : 'hover:ring-1 hover:ring-white/15'}`}>
          <span>{share(s)}</span>
          {anyHeld && <span>{held(s)}</span>}
        </button>
      );
    };
    return (
      <div className="grid items-center gap-x-1 gap-y-0.5" style={cols}>
        {[0, 1].map(i => (
          <span key={i} className={`${nameSpan[i]} truncate px-1 text-right ${head} ${shown === i ? 'text-sky-300' : ''}`} title={pairLabels?.[i]}>
            {pairLabels?.[i] ?? (i ? 'aligned' : 'as drawn')}
          </span>
        ))}
        <span className={head}>satellite</span>
        {[0, 1].map(i => (
          <React.Fragment key={i}>
            <span className={`px-1 text-right ${head}`}><Explain text={pureTip} align={i ? 'right' : 'left'}><span className={TERM}>pure</span></Explain></span>
            {anyHeld && <span className={`px-1 text-right ${head}`}><Explain text={heldTip} align="right"><span className={TERM}>CE90</span></Explain></span>}
          </React.Fragment>
        ))}
        {anyPlace && (
          <span className={`text-right ${head}`}>
            <Explain align="right" text="The angle to the pixel rows at which the trial keeps the most pure pixels at this size. A dot: no placement was searched at this size, the trial is as the file has it.">
              <span className={TERM}>angle</span>
            </Explain>
          </span>
        )}
        {steps.map((s, k) => {
          const place = pairWith[k]?.placement;
          return (
            <React.Fragment key={s.id}>
              {size(s)}
              {group(s, 0, onPick)}
              {group(pairWith[k], 1, onPickPair)}
              {anyPlace && (
                <span className="whitespace-nowrap text-right font-mono text-[12px] text-neutral-500" title={place ? where(place) : undefined}>
                  {!place ? '' : place.searched ? deg(Math.round(place.angle * 10) / 10) : '·'}
                </span>
              )}
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  // One ladder: the share with its bar, what holds within the CE90, and the plot that has least.
  // One template for the header and every row, each a grid of its own: the
  // name column is as wide as the widest name the list can hold.
  const cols: React.CSSProperties = { gridTemplateColumns: `5.4rem 2.6rem${anyHeld ? ' 2.9rem' : ''} minmax(0, 1fr)` };
  return (
    <div className="space-y-0.5">
      <div className={`grid items-center gap-x-2 px-1 ${head}`} style={cols}>
        <span>satellite</span>
        <span className="text-right"><Explain text={pureTip}><span className={TERM}>pure</span></Explain></span>
        {anyHeld && <span className="text-right"><Explain text={heldTip}><span className={TERM}>CE90</span></Explain></span>}
        <span className="text-right">
          {anyPlots && (
            <Explain align="right" text="Fewest pure pixels in a plot, counted over the pixels that hold within the CE90 when a geolocation error is set. In red, how many plots have none.">
              <span className={TERM}>per plot</span>
            </Explain>
          )}
        </span>
      </div>
      {steps.map(s => {
        const t = s.current ? undefined : (s.plotsRobust ?? s.plots);
        return (
          <button key={s.id} type="button" onClick={() => onPick?.(s.id)} title={about(s, geoErrM, threshold)}
            style={{ ...cols, ...bar(s) }}
            className={`grid w-full items-center gap-x-2 rounded px-1 py-0.5 text-left text-[13px] transition-shadow ${isActive(s.id) ? 'ring-1 ring-sky-400/70' : 'hover:ring-1 hover:ring-white/15'}`}>
            {size(s)}
            <span className="text-right font-mono">{share(s)}</span>
            {anyHeld && <span className="text-right font-mono">{held(s)}</span>}
            <span className="whitespace-nowrap text-right font-mono text-[12px] text-neutral-500">
              {!anyPlots || !t ? '' : t.none > 0
                ? <span className="text-rose-400">{t.none}/{t.plots} empty</span>
                : <>min <span className="text-neutral-300">{t.min}</span></>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
