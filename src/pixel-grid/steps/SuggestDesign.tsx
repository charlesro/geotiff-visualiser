import { Spinner } from '../ui';
import { ladderRungs } from '../sensors';
import type { CheckerSuggestion, StripSuggestion, Suggestion } from '../suggest-design';
import { NumField, SELECT } from './controls';
import { SHOW_GRID_STEP, type StepProps } from './props';

/**
 * "Suggest a design": the reader says what the trial has to hold (species,
 * repetitions, pixels in every micro-plot, how pure a pixel has to be) and
 * which satellite will look at it, and the page builds the smallest block
 * trial that does, along the pixel rows (suggest-design.ts). It writes the
 * design's own fields, so everything else on the page (the map, the plot-size
 * card, the satellites table) shows the trial that was built, and every figure
 * stays editable afterwards.
 *
 * For alternating rows or columns the same panel asks less: the pure pixels
 * wanted in every strip, over its whole length, and it builds the thinnest
 * strips that keep them.
 *
 * The body of one of step 3's folds. Step 3 unmounts when folded: what is asked
 * and what was last built live in the page shell.
 */

/**
 * The satellite list's first choice: no satellite named, the coarsest of the
 * list whose smallest trial fits the field drawn (2026-11-24). A block trial only.
 */
export const SUGGEST_FIT = 'fit';

/** What is asked. `sat` is a satellite's id, SUGGEST_FIT, or '' for the one selected in step 2. */
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
  /**
   * The trial's angle to the pixel rows, in degrees. None, or 0, is along the
   * rows, where plots of whole pixels all keep the same count and the trial is
   * smallest; a request saved before the angle existed has none.
   */
  angle?: number;
  /** Repetitions found as the most whose trial fits the field drawn, the satellite named (2026-11-25). */
  repsMax?: boolean;
  /**
   * Whether a block trial that does not fit the field at the angle asked may be
   * turned along the field's directions (2026-11-25: "i cant force an angle in
   * the suggest design"). Unset: it may, as Build did from the day it learnt to.
   * False: the angle asked or nothing.
   */
  alongField?: boolean;
  /** Bare ground between strips, for alternating rows or columns, in metres. None unless asked for, as the alleys above. */
  stripAlley?: number;
  /**
   * Pure pixels wanted in every strip, over its whole length. Its own figure:
   * the plot-size card's count for strips is the pixels ACROSS one, which is
   * another question.
   */
  perStrip?: number;
}

/** True at an angle where plots lie each their own way on the pixels: any but a multiple of a quarter turn. */
const offRows = (deg: number): boolean => Math.abs(deg % 90) > 1e-9;

/** Pixels asked of a strip until the reader types a figure. */
export const PER_STRIP_DEFAULT = 10;

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
  /** The angle it was built at, in degrees: 0 along the pixel rows. */
  angle: number;
  /** The trial, or null when no plot within the design's limits keeps that many pixels. */
  built: Suggestion | null;
  /** The experiment area's extent before the build, along the pixel rows and across them, in metres. */
  field: { u: number; v: number };
  /**
   * The area the build made for the trial, with its size in metres, where
   * there was none. Null when the trial went into the field drawn: a field
   * drawn is never replaced (2026-11-25).
   */
  area: { how: 'made'; u: number; v: number } | null;
  /** The smallest trial, when it does not fit the field drawn and nothing was built: its extent in metres. */
  tooBig?: { footprint: [number, number] };
  /**
   * What the satellites table counts for this trial on this field, plot by
   * plot: the fewest pure pixels, and the fewest that hold within the CE90 in
   * force on the page. Null for a trial too large to count plot by plot.
   */
  onField: { pure: number; held: number | null } | null;
  /**
   * For alternating rows or columns: the layout it was built for and the
   * strips found, null when no strip within the design's limits keeps the
   * pixels asked for. `built` is then null: there is no block trial.
   */
  strips?: { pattern: 'row' | 'col'; found: StripSuggestion | null };
  /** For a checkerboard: the cells found, null when no cell within the design's limits keeps the pixels asked for. */
  cells?: { found: CheckerSuggestion | null };
  /** Why nothing was built, when something went wrong. */
  error?: string;
  /**
   * When the satellite was the coarsest that fits: the satellite tried just
   * before the one built, coarser and too large for the field, with the trial
   * it needed (null when none up to 1000 m was found); `none` when no
   * satellite of the list fits.
   */
  fit?: { coarser: { name: string; res: number; footprint: [number, number] | null } | null; none: boolean };
  /**
   * When the repetitions were the most that fit: how many (0 when not one
   * does), and the trial one more would need (null past 20, the most offered;
   * its footprint null when none up to 1000 m was found).
   */
  most?: { reps: number; next: { reps: number; footprint: [number, number] | null } | null };
  /** True when the trial did not fit at the angle asked and was turned along the field to fit (2026-11-25). */
  alongField?: boolean;
}

/** A length as the design fields show it. */
const m = (v: number) => String(+v.toFixed(2));

export function SuggestDesign(p: StepProps) {
  const { ask, setAsk, busy, progress, outcome, build } = p.suggest;
  const { sourceId, pxSize, sigmaX, sigmaY, ce90At, geoTyped, geoManual } = p.gridApi;
  const { threshold, setThreshold } = p.exp;
  // Purity with its complement beside it, the epsilon the documentation's formulas use (2026-11-24).
  const purityLabel = `Purity (ε = ${100 - threshold} %)`;
  const res = p.gridApi.build?.res ?? pxSize;
  // The satellites of the table, the one selected as it stands in step 2.
  const sats = ladderRungs({ id: sourceId, res, sigmaX, sigmaY });
  // The coarsest satellite that fits the field: block trials only, on a field drawn.
  const fit = ask.sat === SUGGEST_FIT && p.exp.pattern === 'block';
  // The most repetitions that fit the field, for the satellite named.
  const most = !!ask.repsMax && p.exp.pattern === 'block' && !fit;
  const noField = (fit || most) && !p.area.aoi;
  const sat = sats.find(g => g.id === ask.sat) ?? sats.find(g => g.id === sourceId) ?? sats[0];
  // Coarsest that fits holds each satellite to its own CE90 as delivered, or to the one typed in the
  // Satellite fold, for all of them (gridApi.ce90At): a CE90 of 0 typed leaves nothing to hold (Neon, 2026-11-25).
  const ce90 = fit ? (geoTyped ? Math.round(geoManual * 100) / 100 : 1) : sat ? Math.round(ce90At(sat.res, sat.id) * 100) / 100 : 0;
  const set = <K extends keyof SuggestAsk>(k: K) => (v: SuggestAsk[K]) => setAsk({ ...ask, [k]: v });
  // Alternating rows or columns: two crops in strips, sized by the pixels across a strip.
  const strips = p.exp.pattern === 'row' || p.exp.pattern === 'col';
  // A checkerboard: square cells of two crops, each a plot, sized by the pixels a cell keeps.
  const checker = p.exp.pattern === 'checker';

  return (
    <>
      {checker ? (
        <div className="grid grid-cols-3 gap-2">
          <NumField label="Pixels / cell" value={p.wantPure} onChange={p.setWantPure} min={1} max={400} />
          <NumField label={purityLabel} value={threshold} onChange={setThreshold} min={50} max={99} unit="%" />
          <NumField label="Alley" value={ask.stripAlley ?? 0} onChange={set('stripAlley')} min={0} max={100} step={0.5} unit="m" />
        </div>
      ) : strips ? (
        <div className="grid grid-cols-3 gap-2">
          <NumField label="Pixels / strip" value={ask.perStrip ?? PER_STRIP_DEFAULT} onChange={set('perStrip')} min={1} max={2000} />
          <NumField label={purityLabel} value={threshold} onChange={setThreshold} min={50} max={99} unit="%" />
          <NumField label="Alley" value={ask.stripAlley ?? 0} onChange={set('stripAlley')} min={0} max={100} step={0.5} unit="m" />
        </div>
      ) : (<>
      <div className="grid grid-cols-3 gap-2">
        <NumField label="Species" value={ask.species} onChange={set('species')} min={2} max={8} />
        {/* A count typed is a count asked for: it ends the search for the most that fit. */}
        <NumField label={most ? 'Repetitions (most)' : 'Repetitions'} value={ask.reps} onChange={v => setAsk({ ...ask, reps: v, repsMax: false })} min={1} max={20} />
        <NumField label="Pixels / plot" value={p.wantPure} onChange={p.setWantPure} min={1} max={400} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {/* The page's own threshold, also set in the Design section: one figure, two places to set it. */}
        <NumField label={purityLabel} value={threshold} onChange={setThreshold} min={50} max={99} unit="%" />
        <NumField label="Plot alley" value={ask.plotAlley} onChange={set('plotAlley')} min={0} max={100} step={0.5} unit="m" />
        <NumField label="Block alley" value={ask.blockAlley} onChange={set('blockAlley')} min={0} max={100} step={0.5} unit="m" />
      </div>
      </>)}
      <div className="grid grid-cols-3 items-end gap-2">
        <select className={`${SELECT} col-span-2`} value={fit ? SUGGEST_FIT : sat?.id ?? ''} onChange={e => set('sat')(e.target.value)} aria-label="Satellite">
          {p.exp.pattern === 'block' && <option value={SUGGEST_FIT}>Coarsest that fits the field</option>}
          {sats.map(g => <option key={g.id} value={g.id}>{g.name} · {g.res} m{g.id === sourceId ? (SHOW_GRID_STEP ? ' (step 2)' : ' (now)') : ''}</option>)}
        </select>
        <NumField label="Angle" value={Math.round((ask.angle ?? 0) * 10) / 10} onChange={set('angle')} min={-90} max={90} step={0.1} unit="°" />
      </div>
      {ce90 > 0 && (
        <label className="flex items-center gap-2 text-[14px] text-neutral-400">
          <input type="checkbox" checked={ask.hold} onChange={e => set('hold')(e.target.checked)} />
          <span>Pixels must hold within the CE90{fit && !geoTyped ? '' : ` (${ce90} m)`}</span>
        </label>
      )}
      {p.exp.pattern === 'block' && !fit && (
        <label className="flex items-center gap-2 text-[14px] text-neutral-400">
          <input type="checkbox" checked={!!ask.repsMax} onChange={e => set('repsMax')(e.target.checked)} />
          <span>As many repetitions as fit the field</span>
        </label>
      )}
      {p.exp.pattern === 'block' && (
        <label className="flex items-center gap-2 text-[14px] text-neutral-400">
          <input type="checkbox" checked={ask.alongField !== false} onChange={e => set('alongField')(e.target.checked)} />
          <span>Turn it along the field if it does not fit</span>
        </label>
      )}
      {/* No area needed: the build makes one around the trial when there is none, or none large enough. */}
      <button type="button" onClick={build} disabled={busy || !sat || noField}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-sky-500 px-3 py-1.5 text-[15px] font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50">
        {busy && <Spinner className="h-3.5 w-3.5" />} {noField ? 'Draw the field first' : checker ? 'Build this checkerboard' : strips ? 'Build these strips' : 'Build this trial'}
      </button>
      {/* How far Build has got: one step per satellite or count of repetitions tried, then the trial (2026-11-25). */}
      {busy && progress && (
        <div className="space-y-1" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Build">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-sky-500 transition-[width] duration-200" style={{ width: `${Math.round((100 * (progress.done + 0.5)) / Math.max(1, progress.total))}%` }} />
          </div>
          <p className="text-[13px] text-neutral-500">{progress.what}</p>
        </div>
      )}
      {!busy && outcome && <Outcome o={outcome} />}
    </>
  );
}

/** What was built, in two lines: the trial, and what every plot keeps. */
function Outcome({ o }: { o: SuggestOutcome }) {
  const box = 'rounded-md border px-2.5 py-1.5 text-[14px] leading-snug';
  if (o.error) return <p className={`${box} border-rose-500/40 bg-rose-500/5 text-rose-200`}>{o.error}</p>;
  if (o.strips) return <StripOutcome o={o} box={box} />;
  if (o.cells) return <CellOutcome o={o} box={box} />;
  if (o.most && o.most.reps === 0) {
    return (
      <p className={`${box} border-amber-400/40 bg-amber-500/5 text-amber-200`}>
        Not one repetition fits the field ({m(Math.round(o.field.u))} × {m(Math.round(o.field.v))} m) for {o.sat}. Ask for fewer species or pixels, a lower purity, or draw a larger field.
      </p>
    );
  }
  if (o.fit?.none) {
    return (
      <p className={`${box} border-amber-400/40 bg-amber-500/5 text-amber-200`}>
        No satellite of the list fits this trial in the field ({m(Math.round(o.field.u))} × {m(Math.round(o.field.v))} m). Ask for fewer species, repetitions or pixels, a lower purity, or draw a larger field.
      </p>
    );
  }
  if (o.tooBig) {
    const [tu, tv] = o.tooBig.footprint;
    return (
      <p className={`${box} border-amber-400/40 bg-amber-500/5 text-amber-200`}>
        Nothing was built: the smallest trial for {o.sat} · {o.res} m, {m(Math.round(tu))} × {m(Math.round(tv))} m, does not fit the field ({m(Math.round(o.field.u))} × {m(Math.round(o.field.v))} m) with a pixel to spare all round.
        {' '}Try <i>As many repetitions as fit the field</i>, or <i>Coarsest that fits the field</i>.
      </p>
    );
  }
  const b = o.built;
  if (!b) {
    return (
      <p className={`${box} border-amber-400/40 bg-amber-500/5 text-amber-200`}>
        {o.angle === 0
          ? <>No plot up to 1000 m keeps {o.pixels} {o.pixels === 1 ? 'pixel' : 'pixels'} for {o.sat} at {o.threshold} % purity. Ask for fewer pixels, or a lower purity.</>
          : <>No plot found that keeps {o.pixels} {o.pixels === 1 ? 'pixel' : 'pixels'} in every plot for {o.sat} at {o.threshold} % purity, turned {o.angle}°. Ask for fewer pixels, a lower purity, or angle 0.</>}
      </p>
    );
  }
  const d = b.design;
  const rows = Math.ceil(d.nBlocks / d.blocksPerRow);
  const strong = 'font-semibold text-white';
  // The table's count of the same reading: within the CE90 when the build held to it, pure otherwise
  // (comparing the table's held count with pure pixels asked for warned of an edge that was far away; Neon, 2026-11-25).
  const table = o.onField ? (b.held !== null ? o.onField.held : o.onField.pure) : null;
  const asked = b.held ?? b.pure;
  return (
    <div className={`${box} border-white/10 bg-white/[0.02] text-neutral-300`}>
      {o.fit && (
        <p>
          Coarsest that fits: <b className={strong}>{o.sat} · {o.res} m</b>.
          {o.fit.coarser && <> {o.fit.coarser.name} · {o.fit.coarser.res} m {o.fit.coarser.footprint
            ? <>needs a trial of {m(Math.round(o.fit.coarser.footprint[0]))} × {m(Math.round(o.fit.coarser.footprint[1]))} m, and a pixel to spare all round.</>
            : <>has no plot up to 1000 m that keeps the pixels.</>}</>}
        </p>
      )}
      {o.most && (
        <p>
          Most repetitions that fit: <b className={strong}>{o.most.reps}</b>.
          {o.most.next && <> {o.most.next.reps} {o.most.next.footprint
            ? <>would need a trial of {m(Math.round(o.most.next.footprint[0]))} × {m(Math.round(o.most.next.footprint[1]))} m, and a pixel to spare all round.</>
            : <>have no trial up to 1000 m.</>}</>}
          {!o.most.next && <> 20 is the most offered.</>}
        </p>
      )}
      <p>
        Plots <b className={strong}>{m(d.plotLength)} × {m(d.plotWidth)} m</b> ({b.pitchPx[0]} × {b.pitchPx[1]} px{d.plotAlley > 0 || d.blockAlley > 0 ? ' with alleys' : ', touching'}),
        {' '}{rows === 1 ? '1 row' : `${rows} rows`} of blocks, trial {m(b.footprint[0])} × {m(b.footprint[1])} m{b.angle !== 0 ? <>, turned {b.angle}°{o.alongField && ' along the field'}</> : o.alongField && ', along the field'}.
      </p>
      <p>
        {/* Turned, the plots do not all keep the same count: the figure is the worst plot's. */}
        {b.held !== null
          ? <>Each plot keeps {offRows(b.angle) && 'at least '}<b className={strong}>{b.held}</b> px within the CE90 ({o.ce90M} m), {b.pure} pure.</>
          : <>Each plot keeps {offRows(b.angle) && 'at least '}<b className={strong}>{b.pure}</b> pure px.</>}
      </p>
      {b.alleyWidened && (
        <p className="text-neutral-400">Block alley set to {m(d.blockAlley)} m, so that rows of blocks stay in step with the pixels.</p>
      )}
      {o.area && (
        <p className="text-neutral-400">
          Experiment area made around it: {m(Math.round(o.area.u))} × {m(Math.round(o.area.v))} m.
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

/** Strips built: their width, what a strip keeps across and over what length it holds the count, and how the field takes them. */
function StripOutcome({ o, box }: { o: SuggestOutcome; box: string }) {
  const f = o.strips!.found;
  const what = o.strips!.pattern === 'row' ? 'rows' : 'columns';
  if (!f) {
    return (
      <p className={`${box} border-amber-400/40 bg-amber-500/5 text-amber-200`}>
        No strip up to 1000 m keeps a pure pixel for {o.sat} at {o.threshold} % purity. Ask for a lower purity.
      </p>
    );
  }
  const strong = 'font-semibold text-white';
  // Along the pixel rows a whole count; turned, a mean along the strip, to one decimal.
  const px = (v: number) => (f.whole ? String(v) : (Math.floor(v * 10) / 10).toFixed(1));
  const few = f.onField && f.onField.share < 0.9;
  return (
    <div className={`${box} border-white/10 bg-white/[0.02] text-neutral-300`}>
      <p>
        Alternating {what}, strips <b className={strong}>{m(f.width)} m</b> wide ({f.pitchPx} px{f.spacing > 0 ? ` with a ${m(f.spacing)} m alley` : ', touching'}){f.angle !== 0 && <>, turned {f.angle}°</>}.
      </p>
      <p>
        {/* A pitch that is not whole pixels lays the strips several ways in turn: the figure is the strip that keeps the fewest. */}
        {f.held !== null
          ? <>A strip keeps {f.whole && !f.even && 'at least '}{px(f.held)} px across within the CE90 ({o.ce90M} m){!f.whole && ' on average'}, {px(f.pure)} pure:</>
          : <>A strip keeps {f.whole && !f.even && 'at least '}{px(f.pure)} pure px across{!f.whole && ' on average'}:</>}
        {' '}<b className={strong}>{o.pixels}</b> px over <b className={strong}>{m(f.lengthM)} m</b> of its length.
      </p>
      {f.onField && (
        <p className={few ? 'text-amber-200' : 'text-neutral-400'}>
          On this field {f.onField.enough} of {f.onField.strips} strips are that long{few && ': the field is too short for the others'}.
        </p>
      )}
      {o.area && (
        <p className="text-neutral-400">Experiment area made for them: {m(Math.round(o.area.u))} × {m(Math.round(o.area.v))} m, four strips of each crop.</p>
      )}
    </div>
  );
}

/** A checkerboard built, in two lines: the cell's side, and what every cell keeps. */
function CellOutcome({ o, box }: { o: SuggestOutcome; box: string }) {
  const f = o.cells!.found;
  if (!f) {
    return (
      <p className={`${box} border-amber-400/40 bg-amber-500/5 text-amber-200`}>
        No cell up to 1000 m keeps {o.pixels} {o.pixels === 1 ? 'pixel' : 'pixels'} for {o.sat} at {o.threshold} % purity. Ask for fewer pixels, or a lower purity.
      </p>
    );
  }
  const strong = 'font-semibold text-white';
  const px = (v: number) => (f.whole ? String(v) : (Math.floor(v * 10) / 10).toFixed(1));
  const least = f.whole && !f.even && 'at least ';
  return (
    <div className={`${box} border-white/10 bg-white/[0.02] text-neutral-300`}>
      <p>
        Checkerboard, cells <b className={strong}>{m(f.width)} × {m(f.width)} m</b> ({f.pitchPx} px{f.spacing > 0 ? ` with a ${m(f.spacing)} m alley` : ', touching'}){f.angle !== 0 && <>, turned {f.angle}°</>}.
      </p>
      <p>
        {f.held !== null
          ? <>Each cell keeps {least}<b className={strong}>{px(f.held)}</b> px within the CE90 ({o.ce90M} m), {px(f.pure)} pure{!f.whole && ', on average'}.</>
          : <>Each cell keeps {least}<b className={strong}>{px(f.pure)}</b> pure px{!f.whole && ', on average'}.</>}
      </p>
      {o.area && (
        <p className="text-neutral-400">Experiment area made for it: {m(Math.round(o.area.u))} × {m(Math.round(o.area.v))} m, eight cells each way.</p>
      )}
    </div>
  );
}

