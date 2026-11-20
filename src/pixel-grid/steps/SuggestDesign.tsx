import { Explain, InfoDot, Spinner } from '../ui';
import { ladderRungs } from '../sensors';
import type { Suggestion } from '../suggest-design';
import { NumField, SELECT } from './controls';
import type { StepProps } from './props';

/**
 * "Suggest a design": the reader says what the trial has to hold (species,
 * repetitions, pixels in every micro-plot, how pure a pixel has to be) and
 * which satellite will look at it, and the page builds the smallest block
 * trial that does, along the pixel rows (suggest-design.ts). It writes the
 * design's own fields, so everything else on the page (the map, the plot-size
 * card, the satellites table) shows the trial that was built, and every figure
 * stays editable afterwards.
 *
 * The body of one of step 3's folds. Step 3 unmounts when folded: what is asked
 * and what was last built live in the page shell.
 */

/** What is asked. `sat` is a satellite's id, or '' for the one selected in step 2. */
export interface SuggestAsk {
  species: number;
  reps: number;
  sat: string;
  /** Count the pixels that hold within the geolocation error, when one is set. */
  hold: boolean;
  /**
   * Bare ground between the plots of a block and between blocks, in metres.
   * NONE unless asked for: an alley takes ground and gives no pixel, so the
   * smallest trial has its plots touching. The first version carried over the
   * alleys the design happened to have (the layout's defaults, 0.5 and 1.5 m),
   * and built a trial with dirt strips nobody had asked for.
   */
  plotAlley: number;
  blockAlley: number;
}

/** What the last "Build" did. */
export interface SuggestOutcome {
  /** The satellite it was built for (its id and its name), and the request as it was answered. */
  satId: string;
  sat: string;
  res: number;
  pixels: number;
  ce90M: number;
  /** The purity threshold it was built at, in percent. */
  threshold: number;
  /** The trial, or null when no plot within the design's limits keeps that many pixels. */
  built: Suggestion | null;
  /** The experiment area's extent before the build, along the pixel rows and across them, in metres. */
  field: { u: number; v: number };
  /**
   * The area the build made for the trial, with its size in metres: where
   * there was none ('made'), or where the one there could not hold the trial
   * ('replaced'). Null when the trial went into the area as it was.
   */
  area: { how: 'made' | 'replaced'; u: number; v: number } | null;
  /**
   * What the satellites table counts for this trial on this field, plot by
   * plot: the fewest pure pixels, and the fewest that hold within the CE90 in
   * force on the page. Null for a trial too large to count plot by plot.
   */
  onField: { pure: number; held: number | null } | null;
  /** Why nothing was built, when something went wrong. */
  error?: string;
}

/** A length as the design fields show it. */
const m = (v: number) => String(+v.toFixed(2));

export function SuggestDesign(p: StepProps) {
  const { ask, setAsk, busy, outcome, build } = p.suggest;
  const { sourceId, pxSize, sigmaX, sigmaY, ce90At } = p.gridApi;
  const { threshold, setThreshold } = p.exp;
  const res = p.gridApi.build?.res ?? pxSize;
  // The satellites of the table, the one selected as it stands in step 2.
  const sats = ladderRungs({ id: sourceId, res, sigmaX, sigmaY });
  const sat = sats.find(g => g.id === ask.sat) ?? sats.find(g => g.id === sourceId) ?? sats[0];
  const ce90 = sat ? Math.round(ce90At(sat.res) * 100) / 100 : 0;
  const set = <K extends keyof SuggestAsk>(k: K) => (v: SuggestAsk[K]) => setAsk({ ...ask, [k]: v });

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <NumField label="Species" value={ask.species} onChange={set('species')} min={2} max={8}
          hint="Treatments in each block." />
        <NumField label="Repetitions" value={ask.reps} onChange={set('reps')} min={1} max={20}
          hint="Blocks: each holds every species once." />
        <NumField label="Pixels / plot" value={p.wantPure} onChange={p.setWantPure} min={1} max={400}
          hint="The fewest pixels every micro-plot must keep. The same figure as the last row of the plot-size card." />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {/* The page's own threshold, the slider under "Noise & purity threshold": one figure, two places to set it. */}
        <NumField label="Purity" value={threshold} onChange={setThreshold} min={50} max={99} unit="%"
          hint="A pixel counts when at least this share of its signal comes from its own plot (ε = 100 minus it). This is the page's purity threshold: changing it here changes it everywhere." />
        <NumField label="Plot alley" value={ask.plotAlley} onChange={set('plotAlley')} min={0} max={100} step={0.5} unit="m"
          hint="Bare ground between the plots of a block. None by default: an alley takes ground and gives no pixel, so the smallest trial has its plots touching." />
        <NumField label="Block alley" value={ask.blockAlley} onChange={set('blockAlley')} min={0} max={100} step={0.5} unit="m"
          hint="Bare ground between blocks. None by default. With several rows of blocks it is widened, if need be, to differ from the plot alley by whole pixels." />
      </div>
      <select className={SELECT} value={sat?.id ?? ''} onChange={e => set('sat')(e.target.value)} aria-label="Satellite"
        title="The trial is sized for this satellite's pixels and blur, and Build selects it in step 2">
        {sats.map(g => <option key={g.id} value={g.id}>{g.name} · {g.res} m{g.id === sourceId ? ' (selected in step 2)' : ''}</option>)}
      </select>
      {ce90 > 0 && (
        <label className="flex items-center gap-2 text-[14px] text-neutral-400">
          <input type="checkbox" checked={ask.hold} onChange={e => set('hold')(e.target.checked)} />
          <span>Pixels must hold within the CE90 ({ce90} m)</span>
          <Explain align="right" text="Ticked, a pixel counts only if it stays pure for its plot wherever the image lands within the geolocation error. Unticked, the pixels that are pure with the image exactly in place."><InfoDot /></Explain>
        </label>
      )}
      {/* No area needed: the build makes one around the trial when there is none, or none large enough. */}
      <button type="button" onClick={build} disabled={busy || !sat}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-sky-500 px-3 py-1.5 text-[15px] font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50">
        {busy && <Spinner className="h-3.5 w-3.5" />} Build this trial
      </button>
      {outcome && <Outcome o={outcome} />}
    </>
  );
}

/** What was built, in two lines: the trial, and what every plot keeps. */
function Outcome({ o }: { o: SuggestOutcome }) {
  const box = 'rounded-md border px-2.5 py-1.5 text-[14px] leading-snug';
  if (o.error) return <p className={`${box} border-rose-500/40 bg-rose-500/5 text-rose-200`}>{o.error}</p>;
  const b = o.built;
  if (!b) {
    return (
      <p className={`${box} border-amber-400/40 bg-amber-500/5 text-amber-200`}>
        No plot up to 1000 m keeps {o.pixels} {o.pixels === 1 ? 'pixel' : 'pixels'} for {o.sat} at {o.threshold} % purity. Ask for fewer pixels, or a lower purity.
      </p>
    );
  }
  const d = b.design;
  const rows = Math.ceil(d.nBlocks / d.blocksPerRow);
  const strong = 'font-semibold text-white';
  // The table counts within the CE90 in force on the page, whatever the box above says.
  const table = o.onField ? (o.onField.held ?? o.onField.pure) : null;
  const asked = b.held ?? b.pure;
  return (
    <div className={`${box} border-white/10 bg-white/[0.02] text-neutral-300`}>
      <p>
        Plots <b className={strong}>{m(d.plotLength)} × {m(d.plotWidth)} m</b> ({b.pitchPx[0]} × {b.pitchPx[1]} px{d.plotAlley > 0 || d.blockAlley > 0 ? ' with alleys' : ', touching'}),
        {' '}{rows === 1 ? '1 row' : `${rows} rows`} of blocks, trial {m(b.footprint[0])} × {m(b.footprint[1])} m.
      </p>
      <p>
        {b.held !== null
          ? <>Each plot keeps <b className={strong}>{b.held}</b> px within the CE90 ({o.ce90M} m), {b.pure} pure.</>
          : <>Each plot keeps <b className={strong}>{b.pure}</b> pure px.</>}
      </p>
      {b.alleyWidened && (
        <p className="text-neutral-400">Block alley set to {m(d.blockAlley)} m, so that rows of blocks stay in step with the pixels.</p>
      )}
      {o.area && (
        <p className="text-neutral-400">
          {o.area.how === 'made'
            ? <>Experiment area made around it: {m(Math.round(o.area.u))} × {m(Math.round(o.area.v))} m.</>
            : <>The area ({m(Math.round(o.field.u))} × {m(Math.round(o.field.v))} m) was too small: replaced by one of {m(Math.round(o.area.u))} × {m(Math.round(o.area.v))} m around the trial.</>}
        </p>
      )}
      {b.fits === false && (
        <p className="text-amber-200">It does not fit the experiment area ({m(o.field.u)} × {m(o.field.v)} m).</p>
      )}
      {b.fits !== false && table !== null && table < asked && (
        <p className="text-amber-200">On this field the satellites table counts {table} in the worst plot: the field's edge cuts the trial.</p>
      )}
    </div>
  );
}
