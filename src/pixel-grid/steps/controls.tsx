import React from 'react';
import { CropControl, Explain, InfoDot } from '../ui';
import { PATTERNS, cropById, type FieldParams, type PatternType } from '../simulate';

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

/**
 * Strip width / row spacing / angle. `rotationLabel` differs between the steps
 * ("Strip angle" vs "Field rotation") — same state, two names, kept as-is.
 */
export function LayoutFields({ stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation, rotationLabel, spacingHint, rotationHint, rotationAction }: {
  stripWidth: number; setStripWidth: (v: number) => void;
  spacing: number; setSpacing: (v: number) => void;
  rotation: number; setRotation: (v: number) => void;
  rotationLabel: string;
  /** Optional on-demand notes, so the explanations stop living as body prose. */
  spacingHint?: React.ReactNode;
  rotationHint?: React.ReactNode;
  /** Rendered on the rotation row — the "compare with aligned" toggle. */
  rotationAction?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <div>
        <label className={LABEL}>Strip width</label>
        <div className="flex items-center gap-1">
          <input type="number" min="0.5" step="0.5" value={stripWidth}
            onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setStripWidth(v); }}
            className={FIELD} />
          <span className={UNIT}>m</span>
        </div>
      </div>
      <div>
        <label className={LABEL}>Row spacing{spacingHint && <> <Explain text={spacingHint}><InfoDot /></Explain></>}</label>
        <div className="flex items-center gap-1">
          <input type="number" min="0" step="0.5" value={spacing}
            onChange={e => setSpacing(Math.max(0, parseFloat(e.target.value) || 0))}
            className={FIELD} />
          <span className={UNIT}>m</span>
        </div>
      </div>
      <div>
        <label className={LABEL}>
          {rotationLabel}
          {rotationHint && <> <Explain align="right" text={rotationHint}><InfoDot /></Explain></>}
          {rotationAction}
        </label>
        <div className="flex items-center gap-1">
          <input type="number" min="0" max="90" step="1" value={rotation}
            onChange={e => setRotation(Math.max(0, Math.min(90, parseInt(e.target.value) || 0)))}
            className={FIELD} />
          <span className={UNIT}>°</span>
        </div>
      </div>
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
export function CropPair({ wrapperClass, cropA, setCropA, presetA, setPresetA, cropB, setCropB, presetB, setPresetB, colB }: {
  wrapperClass: string;
  cropA: FieldParams; setCropA: (c: FieldParams) => void; presetA: string; setPresetA: (id: string) => void;
  cropB: FieldParams; setCropB: (c: FieldParams) => void; presetB: string; setPresetB: (id: string) => void;
  colB: string;
}) {
  return (
    <div className={wrapperClass}>
      <CropControl label="Crop A" crop={cropA} preset={presetA}
        onCrop={c => { setCropA(c); setPresetA('custom'); }}
        onPreset={id => { setCropA(cropById(id)); setPresetA(id); }}
        onColor={hex => setCropA({ ...cropA, color: hex })} />
      <CropControl label="Crop B" crop={cropB} preset={presetB} swatchColor={colB} align="right"
        onCrop={c => { setCropB(c); setPresetB('custom'); }}
        onPreset={id => { setCropB(cropById(id)); setPresetB(id); }}
        onColor={hex => setCropB({ ...cropB, color: hex })} />
    </div>
  );
}
