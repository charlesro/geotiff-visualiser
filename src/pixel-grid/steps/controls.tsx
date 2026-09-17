import React from 'react';
import { CropControl, Explain, InfoDot } from '../ui';
import { PATTERNS, cropById, type BlockDesign, type FieldParams, type PatternType } from '../simulate';
import type { ImportedPlan } from '../imported-types';
import { fmt } from '../util';

/**
 * The planting controls steps 3 and 4 both carry.
 *
 * They are the SAME controls over the SAME state — step 4 repeats them so you
 * can retune the design while watching the PCA, rather than jumping back a step.
 * Before this file they were duplicated verbatim, differing only in the three
 * cosmetic knobs below, which is exactly how the two copies drift apart.
 *
 * The clamps are load-bearing and deliberately inconsistent with each other
 * (`if (v > 0)` silently ignores a bad strip width, the other two coerce): that
 * is the existing behaviour and typing "0" into each field is the test.
 */

// Flat sentence-case, not uppercase-tracked: nine shouting labels were most of
// what made the panel feel loud.
const LABEL = 'mb-1 block text-[11px] text-neutral-500';
const FIELD = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none';
const UNIT = 'text-xs text-neutral-500';

/** One select style for the whole page — the old large/small split was cosmetic drift. */
export const SELECT = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none';

export function LayoutSelect({ pattern, setPattern, selectClass }: {
  pattern: PatternType; setPattern: (p: PatternType) => void; selectClass: string;
}) {
  return (
    <div>
      <label className={LABEL}>Layout</label>
      <select value={pattern} onChange={e => setPattern(e.target.value as PatternType)} className={selectClass}>
        {PATTERNS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
    </div>
  );
}

/** One labelled number input. The block design needs eight of them. */
function NumField({ label, value, onChange, min, max, step = 1, unit, hint, action }: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step?: number; unit?: string;
  hint?: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div>
      <label className={LABEL}>
        {label}
        {hint && <> <Explain text={hint}><InfoDot /></Explain></>}
        {action}
      </label>
      <div className="flex items-center gap-1">
        <input type="number" min={min} max={max} step={step} value={value}
          onChange={e => {
            const v = step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value);
            if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
          }}
          className={FIELD} />
        {unit && <span className={UNIT}>{unit}</span>}
      </div>
    </div>
  );
}

/**
 * Strip width / row spacing / angle, or the block design when the layout is a
 * trial. `rotationLabel` differs between the steps ("Strip angle" vs "Field
 * rotation"): same state, two names, kept as-is.
 *
 * The strip fields are HIDDEN for a block layout rather than left showing. They
 * drive nothing there (a trial's geometry is its plots and alleys), and a
 * control that visibly does nothing when you type in it is worse than absent.
 * Rotation stays: it turns the whole trial, and it is what switches the pixel
 * snapping off.
 */
export function LayoutFields({ pattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation, rotationLabel, spacingHint, rotationHint, rotationAction, blockDesign, setBlockDesign }: {
  pattern: PatternType;
  stripWidth: number; setStripWidth: (v: number) => void;
  spacing: number; setSpacing: (v: number) => void;
  rotation: number; setRotation: (v: number) => void;
  rotationLabel: string;
  /** Optional on-demand notes, so the explanations stop living as body prose. */
  spacingHint?: React.ReactNode;
  rotationHint?: React.ReactNode;
  /** Rendered on the rotation row: the "compare with aligned" toggle. */
  rotationAction?: React.ReactNode;
  blockDesign?: BlockDesign;
  setBlockDesign?: (v: BlockDesign | ((p: BlockDesign) => BlockDesign)) => void;
}) {
  const rotationField = (
    <NumField label={rotationLabel} value={rotation} onChange={setRotation} min={0} max={90} unit="°"
      hint={rotationHint} action={rotationAction} />
  );

  // An imported trial's geometry is the file's; only its angle can be changed.
  // Tenths of a degree, since a file's own angle is rarely a whole number.
  if (pattern === 'imported') {
    return (
      // Two columns rather than three: its label carries two actions.
      <div className="grid grid-cols-2 gap-2">
        <NumField label={rotationLabel} value={Math.round(rotation * 10) / 10} onChange={setRotation}
          min={0} max={90} step={0.1} unit="°" hint={rotationHint} action={rotationAction} />
      </div>
    );
  }

  if (pattern === 'block' && blockDesign && setBlockDesign) {
    const d = blockDesign;
    const set = (k: keyof BlockDesign) => (v: number) => setBlockDesign(p => ({ ...p, [k]: v }));
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <NumField label="Species" value={d.nSpecies} onChange={set('nSpecies')} min={2} max={8}
            hint="How many treatments each block contains. Every block gets all of them, in its own random order." />
          <NumField label="Blocks" value={d.nBlocks} onChange={set('nBlocks')} min={1} max={20}
            hint="Repetitions. Each is a complete set of the species." />
          <NumField label="Per row" value={d.blocksPerRow} onChange={set('blocksPerRow')} min={1} max={20} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <NumField label="Plot length" value={d.plotLength} onChange={set('plotLength')} min={0.5} max={1000} step={0.5} unit="m" />
          <NumField label="Plot width" value={d.plotWidth} onChange={set('plotWidth')} min={0.5} max={1000} step={0.5} unit="m" />
          {rotationField}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <NumField label="Plot alley" value={d.plotAlley} onChange={set('plotAlley')} min={0} max={100} step={0.5} unit="m"
            hint="Bare soil between plots inside a block, shown in brown." />
          <NumField label="Block alley" value={d.blockAlley} onChange={set('blockAlley')} min={0} max={100} step={0.5} unit="m" />
          <NumField label="Seed" value={d.seed} onChange={set('seed')} min={0} max={9999}
            hint="Changes the randomisation. The same seed always replays the same layout." />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      <NumField label="Strip width" value={stripWidth} onChange={setStripWidth} min={0.5} max={1000} step={0.5} unit="m" />
      <NumField label="Row spacing" value={spacing} onChange={setSpacing} min={0} max={1000} step={0.5} unit="m" hint={spacingHint} />
      {rotationField}
    </div>
  );
}

/**
 * What this trial is, and whether the chosen sensor can actually see it.
 *
 * TWO different limits bite at different pixel sizes, and a bare purity
 * percentage hides which one you have hit:
 *
 *  - under about one pixel per plot width the GEOMETRY is impossible. No
 *    threshold, no PSF, no sensor tuning recovers it; the plot has to grow.
 *  - above that the blur still crosses plot edges, so a plot several pixels
 *    wide can still yield no fully pure pixel. What recovers those is relaxing
 *    the purity threshold, NOT a finer grid, and saying so is the difference
 *    between a useful card and a discouraging one.
 *
 * The percentage is always the one the engine MEASURED over the real grid. The
 * notes explain that number; they never stand in for it, and when the grid is
 * too fine to render there is no measurement and the card stays silent.
 */
export function BlockSummary({ design, plan, res, threshold, purePct }: {
  design: BlockDesign;
  plan?: { totalU: number; totalV: number; nPlots: number };
  /** Pixel size in metres; absent until a grid is built. */
  res?: number;
  threshold: number;
  /** Measured pure-pixel share, absent when the grid was too fine to render. */
  purePct?: number;
}) {
  const nPlots = plan?.nPlots ?? design.nSpecies * design.nBlocks;
  const plotArea = design.plotLength * design.plotWidth;
  const acrossPx = res ? design.plotWidth / res : null;
  const alongPx = res ? design.plotLength / res : null;
  const subPixel = acrossPx != null && acrossPx < 1;

  const note = subPixel
    ? `A plot is narrower than one pixel at ${res} m, so no pixel can sit inside one. Widen the plots or pick a finer sensor.`
    : purePct === 0 && res
      ? `The sensor's blur reaches across every plot edge at ${res} m. Lowering the purity threshold below ${threshold}% is what recovers pixels here, not a finer grid.`
      : null;

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[11px] text-neutral-300">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        {plan && (
          <span>Trial <span className="font-mono text-neutral-100">{plan.totalU.toFixed(1)} × {plan.totalV.toFixed(1)} m</span></span>
        )}
        <span><span className="font-mono text-neutral-100">{nPlots}</span> plots of <span className="font-mono text-neutral-100">{plotArea} m²</span></span>
        {acrossPx != null && alongPx != null && (
          <span>plot is <span className="font-mono text-neutral-100">{alongPx.toFixed(1)} × {acrossPx.toFixed(1)}</span> px</span>
        )}
      </div>
      {purePct != null && (
        <div className="mt-1">
          Pure plot pixels <span className={`font-mono ${purePct > 0 ? 'text-sky-300' : 'text-amber-400'}`}>{purePct.toFixed(0)}%</span>
          <span className="text-neutral-500"> at {threshold}% purity</span>
        </div>
      )}
      {note && <div className="mt-1 text-neutral-400">{note}</div>}
    </div>
  );
}

/**
 * What an imported trial is, and what the chosen sensor makes of it: the same
 * job as BlockSummary, for plots that came from a file. Sizes are measured off
 * the resolved plan (the grid's metres), never off the file's degrees.
 */
export function ImportedSummary({ plan, res, threshold, purePct }: {
  plan: ImportedPlan;
  res?: number;
  threshold: number;
  purePct?: number;
}) {
  // Plot area by the shoelace sum over all of a plot's rings: holes and outer
  // rings wind opposite ways in both shapefiles and GeoJSON, so they subtract.
  const areas = plan.plots.map(p => Math.abs(p.rings.reduce((acc, r) => {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return acc + a / 2;
  }, 0))).sort((x, y) => x - y);
  const median = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
  const side = Math.sqrt(median);
  const sidePx = res ? side / res : null;
  const [e0, n0, e1, n1] = plan.bbox;
  const note = sidePx != null && sidePx < 1
    ? `A typical plot is smaller than one ${res} m pixel, so no pixel can sit inside one. Pick a finer sensor.`
    : purePct === 0 && res
      ? `The sensor's blur reaches across every plot edge at ${res} m. Lowering the purity threshold below ${threshold}% is what recovers pixels here, not a finer grid.`
      : null;
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[11px] text-neutral-300">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span>Trial <span className="font-mono text-neutral-100">{(e1 - e0).toFixed(0)} × {(n1 - n0).toFixed(0)} m</span></span>
        <span><span className="font-mono text-neutral-100">{fmt(plan.plots.length)}</span> plots of about <span className="font-mono text-neutral-100">{median.toFixed(0)} m²</span></span>
        {sidePx != null && <span>about <span className="font-mono text-neutral-100">{sidePx.toFixed(1)}</span> px across</span>}
      </div>
      {purePct != null && (
        <div className="mt-1">
          Pure plot pixels <span className={`font-mono ${purePct > 0 ? 'text-sky-300' : 'text-amber-400'}`}>{purePct.toFixed(0)}%</span>
          <span className="text-neutral-500"> at {threshold}% purity</span>
        </div>
      )}
      {!plan.plotIds && (
        <div className="mt-1 text-neutral-400">
          More plots than the simulation can tell apart one by one: a pixel spanning two plots of the same variety counts as pure.
        </div>
      )}
      {note && <div className="mt-1 text-neutral-400">{note}</div>}
    </div>
  );
}

/**
 * The two crop curve editors. Step 3 stacks them, step 4 puts them side by side.
 *
 * `onColor` deliberately bypasses `onCrop`: the colour is display only, so
 * recolouring must NOT flip the preset to "Custom" the way editing the growth
 * curve does — the crop is still maize, it is just drawn differently.
 */
/**
 * One editor per species in the design, 2 to 8 of them.
 *
 * This replaces a fixed pair of "Crop A" and "Crop B" editors, which could not
 * reach species 3 onward at all: a four-species trial ran with two species the
 * user could edit and two padded in behind their back. CropControl itself needed
 * no change, since nothing in it assumed a pair.
 *
 * Labelled by each species' own drawn name rather than by a letter, and given
 * `swatchColor` so the dot matches what the map paints, which is not always the
 * stored colour once distinctColors has separated two species that clashed.
 * `align="right"` on the right-hand column keeps the colour popover from
 * overflowing the sidebar.
 */
export function SpeciesList({ wrapperClass, species, presets, colors, names, setSpeciesAt, setPresetAt }: {
  wrapperClass: string;
  /** The species as drawn: already padded to the design's count and recoloured. */
  species: FieldParams[];
  presets: string[];
  colors: string[];
  names: string[];
  setSpeciesAt: (i: number, c: FieldParams) => void;
  setPresetAt: (i: number, id: string) => void;
}) {
  return (
    <div className={wrapperClass}>
      {species.map((s, i) => (
        <CropControl key={i} label={names[i] ?? s.name} crop={s} preset={presets[i] ?? 'custom'}
          swatchColor={colors[i]} align={i % 2 === 1 ? 'right' : 'left'}
          onCrop={c => { setSpeciesAt(i, c); setPresetAt(i, 'custom'); }}
          onPreset={id => { setSpeciesAt(i, cropById(id)); setPresetAt(i, id); }}
          onColor={hex => setSpeciesAt(i, { ...s, color: hex })} />
      ))}
    </div>
  );
}
