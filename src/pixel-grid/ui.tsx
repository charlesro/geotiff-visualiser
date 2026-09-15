import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { CROP_PRESETS, TRUTH_TYPES, type FieldParams } from './simulate';

/**
 * The page's own chrome: the numbered stepper section, the labelled slider, the
 * crop curve editor, the spinner.
 *
 * Deliberately NOT src/components/ui.tsx — that one is the PCA app's, on a
 * slate-* palette, and adopting it here would repaint this page. These are kept
 * separate on purpose.
 *
 * IMPORTANT — `Step` renders {open && children}, so a COLLAPSED step unmounts
 * its children and every piece of state inside them is lost. Any state a step's
 * controls own must therefore live in a hook called by the page shell, never in
 * a component rendered as a `Step` child.
 */

/** A collapsible numbered step — matches the PCA app's flat stepper sections. */
function Step({ n, title, summary, open, enabled = true, onClick, children }: {
  n: number; title: string; summary?: string; open: boolean; enabled?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <section className="border-b border-white/5">
      <button onClick={onClick} className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] ${!enabled && !open ? 'opacity-55' : ''}`}>
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${open ? 'bg-sky-500/20 text-sky-300' : 'bg-white/10 text-slate-400'}`}>{n}</span>
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-medium ${open ? 'text-slate-100' : 'text-slate-300'}`}>{title}</span>
          {!open && summary && <span className="block truncate text-xs text-slate-500">{summary}</span>}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-600 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="space-y-3 px-4 pb-4 pt-1">{children}</div>}
    </section>
  );
}

const Slider = ({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number; fmt?: (v: number) => string; onChange: (v: number) => void;
}) => (
  <label className="block">
    <span className="mb-0.5 flex justify-between text-[11px] text-neutral-400">
      <span>{label}</span><span className="font-mono text-neutral-300">{fmt ? fmt(value) : value}</span>
    </span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))} className="w-full accent-sky-500" />
  </label>
);

/** Field picker with editable truth type + double-logistic params (repo set). */
/**
 * The crop palette offered by the swatch picker: Okabe-Ito, which is the set the
 * built-in crop presets already draw from. It is colour-blind safe, which matters
 * for a figure that ends up in a thesis.
 */
const CROP_COLORS = ['#e69f00', '#0072b2', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442', '#999999'];

function CropControl({ label, crop, preset, swatchColor, onCrop, onPreset, onColor, align = 'left' }: {
  label: string; crop: FieldParams; preset: string; swatchColor?: string;
  onCrop: (c: FieldParams) => void; onPreset: (id: string) => void;
  /** Recolour WITHOUT flipping the preset to "custom" — the curve is unchanged. */
  onColor?: (hex: string) => void;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(false);
  const pickRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!pick) return;
    const doc = (e: MouseEvent) => { if (!pickRef.current?.contains(e.target as Node)) setPick(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setPick(false); };
    document.addEventListener('mousedown', doc);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', doc); document.removeEventListener('keydown', key); };
  }, [pick]);
  const set = (patch: Partial<FieldParams>) => onCrop({ ...crop, ...patch });
  const shown = swatchColor ?? crop.color;
  return (
    <div>
      <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        {onColor ? (
          <span ref={pickRef} className="relative inline-flex">
            <button type="button" onClick={() => setPick(v => !v)} aria-label={`Colour for ${label}`}
              title="Pick this crop's colour"
              className="inline-block h-2.5 w-2.5 rounded-sm ring-offset-1 ring-offset-[#11151a] transition-shadow hover:ring-1 hover:ring-white/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500"
              style={{ background: shown }} />
            {pick && (
              <span className={`absolute top-full z-[1200] mt-1.5 w-max rounded-md border border-white/10 bg-neutral-900 p-2 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}>
                <span className="grid grid-cols-4 gap-1.5">
                  {CROP_COLORS.map(c => (
                    <button key={c} type="button" onClick={() => { onColor(c); setPick(false); }}
                      aria-label={c}
                      className={`h-5 w-5 rounded-sm transition-transform hover:scale-110 ${c.toLowerCase() === crop.color.toLowerCase() ? 'ring-2 ring-white' : 'ring-1 ring-white/15'}`}
                      style={{ background: c }} />
                  ))}
                </span>
                <label className="mt-2 flex items-center gap-1.5 text-[10px] normal-case tracking-normal text-neutral-400">
                  <input type="color" value={crop.color} onChange={e => onColor(e.target.value)}
                    className="h-5 w-6 cursor-pointer rounded border border-white/10 bg-transparent p-0" />
                  custom
                </label>
              </span>
            )}
          </span>
        ) : (
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: shown }} />
        )}
        {label}
      </label>
      <div className="flex gap-1.5">
        <select value={preset} onChange={e => onPreset(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none">
          {CROP_PRESETS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          {preset === 'custom' && <option value="custom">Custom</option>}
        </select>
        <button onClick={() => setOpen(o => !o)} title="Edit the growth curve"
          className={`rounded-md border px-2 text-xs ${open ? 'border-sky-500 bg-sky-500/15 text-sky-300' : 'border-white/10 bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}>
          curve ▾
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-white/10 bg-black/20 p-2">
          <label className="block">
            <span className="mb-0.5 block text-[11px] text-neutral-400">Truth type</span>
            <select value={crop.truth} onChange={e => set({ truth: e.target.value as FieldParams['truth'] })}
              className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-sky-500 focus:outline-none">
              {TRUTH_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          {crop.truth === 'double' && <>
            <Slider label="Peak (L1)" value={crop.L1} min={0.1} max={1} step={0.01} fmt={v => v.toFixed(2)} onChange={v => set({ L1: v })} />
            <Slider label="Green-up day (x01)" value={crop.x01} min={0} max={365} step={1} fmt={v => `${v | 0}`} onChange={v => set({ x01: v })} />
            <Slider label="Green-up rate (k1)" value={crop.k1} min={0.01} max={0.5} step={0.001} fmt={v => v.toFixed(3)} onChange={v => set({ k1: v })} />
            <Slider label="Offset / switch (tc)" value={crop.tc} min={0} max={365} step={1} fmt={v => `${v | 0}`} onChange={v => set({ tc: v })} />
            <Slider label="Senescence day (x02)" value={crop.x02} min={0} max={365} step={1} fmt={v => `${v | 0}`} onChange={v => set({ x02: v })} />
            <Slider label="Decay rate (k2)" value={crop.k2} min={0.01} max={0.5} step={0.001} fmt={v => v.toFixed(3)} onChange={v => set({ k2: v })} />
          </>}
        </div>
      )}
    </div>
  );
}

/** Small spinning ring for "recomputing…" feedback. */
const Spinner = ({ className = '' }: { className?: string }) => (
  <span className={`inline-block animate-spin rounded-full border-2 border-sky-400/25 border-t-sky-400 ${className || 'h-3.5 w-3.5'}`} />
);

/**
 * On-demand explanation.
 *
 * Deliberately NOT the Explain in src/components/ui.tsx: that one is
 * `pointer-events-none`, which is fine for a bare sentence and fatal here — the
 * popovers in this page are the only home for the ESA citation link, and a
 * pointer-events-none popover makes an <a href> permanently unclickable. It is
 * also hover-only, leaving no keyboard or touch path.
 *
 * So: hover to peek, click to pin, Escape or an outside click to dismiss, and
 * the panel itself is interactive so links inside it work.
 *
 * `align="right"` / `below` exist because the sidebar scroll container computes
 * to overflow-x: auto and will CLIP a popover that overhangs its edge — use them
 * on anchors near the right edge or the top of the panel.
 */
export function Explain({ text, children, align = 'left', below = false }: {
  text: React.ReactNode; children: React.ReactNode; align?: 'left' | 'right'; below?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!pinned) return;
    const doc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) { setPinned(false); setOpen(false); }
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPinned(false); setOpen(false); } };
    document.addEventListener('mousedown', doc);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', doc); document.removeEventListener('keydown', key); };
  }, [pinned]);
  return (
    <span ref={ref} className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => !pinned && setOpen(false)}>
      <button type="button" aria-expanded={open}
        onClick={() => { setPinned(p => !p); setOpen(true); }}
        className="inline-flex min-h-4 min-w-4 cursor-help items-center gap-1 rounded text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500">
        {children}
      </button>
      {open && (
        <span role="tooltip"
          className={`absolute z-[1200] w-64 rounded-md border border-white/10 bg-neutral-900 px-2.5 py-2 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-neutral-300 shadow-xl ${below ? 'top-full mt-1.5' : 'bottom-full mb-1.5'} ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {text}
        </span>
      )}
    </span>
  );
}

/** The affordance that says "there is more here if you want it". */
export const InfoDot = () => <Info className="h-3.5 w-3.5 shrink-0 text-neutral-600 hover:text-sky-400" />;

/** A one-word status token. Amber and rose are reserved for real warnings. */
export function Chip({ tone = 'neutral', children }: { tone?: 'neutral' | 'amber' | 'rose'; children: React.ReactNode }) {
  const t = tone === 'amber' ? 'text-amber-300 bg-amber-500/10'
    : tone === 'rose' ? 'text-rose-300 bg-rose-500/10'
    : 'text-neutral-400 bg-white/[0.04]';
  return <span className={`rounded px-1.5 py-0.5 ${t}`}>{children}</span>;
}

/** A closed-by-default section. `open` lives in the page shell — Step unmounts. */
export function Disclosure({ label, open, onToggle, children }: {
  label: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="border-t border-white/5 pt-2">
      <button onClick={onToggle}
        className="flex w-full items-center gap-1 text-[11px] text-neutral-500 transition-colors hover:text-neutral-300">
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />{label}
      </button>
      {open && <div className="mt-2 space-y-2">{children}</div>}
    </div>
  );
}

/** Segmented switch between two views of the same thing. State lives in the shell. */
export function Tabs<T extends string>({ value, onChange, tabs }: {
  value: T; onChange: (v: T) => void; tabs: { id: T; label: string; hint?: React.ReactNode }[];
}) {
  return (
    <div className="flex gap-1 rounded-md bg-black/30 p-0.5">
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={`flex-1 rounded px-2 py-1 text-[11px] transition-colors ${value === t.id ? 'bg-sky-500/15 text-sky-300' : 'text-neutral-400 hover:text-neutral-200'}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The number the step exists to produce. One per step, near the top. */
export function Hero({ value, unit, right, tone = 'text-neutral-50' }: {
  value: React.ReactNode; unit?: string; right?: React.ReactNode; tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={`text-[26px] font-semibold leading-none tabular-nums ${tone}`}>
        {value}{unit && <span className="ml-1 text-sm font-normal text-neutral-500">{unit}</span>}
      </span>
      {right && <span className="text-lg tabular-nums text-neutral-300">{right}</span>}
    </div>
  );
}

export { Step, Slider, CropControl, Spinner };
