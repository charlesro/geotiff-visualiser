import React from 'react';
import { Loader2, AlertTriangle, Info } from 'lucide-react';
import { cn } from '../lib/utils';

/** Small shared form primitives so every step looks identical. */

export function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex align-middle">
      <Info className="h-3 w-3 cursor-help text-slate-600 transition-colors group-hover:text-sky-400" />
      <span className="pointer-events-none invisible absolute bottom-full left-1/2 z-[1200] mb-1.5 w-60 -translate-x-1/2 rounded-md border border-white/10 bg-[#1a2027] px-2.5 py-2 text-[11px] font-normal normal-case tracking-normal text-slate-300 shadow-xl group-hover:visible">
        {text}
      </span>
    </span>
  );
}

export function Field({
  label,
  children,
  hint,
  info,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  info?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
        {info && <InfoTip text={info} />}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-600">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-white/10 bg-[#0b0e11] px-2.5 py-1.5 text-sm text-slate-200 ' +
  'placeholder:text-slate-600 focus:border-sky-500/60 focus:outline-none';

/**
 * Number field that doesn't fight your typing.
 *
 * A raw `<input type="number">` with `value={n}` + min-clamping on every
 * keystroke makes editing the leading digit impossible: to change 10 → 20 you
 * select "10", type "2", and the clamp instantly rewrites it (2 is below the
 * min, or `Number('') || fallback` kicks in). This holds the keystrokes as a
 * string while focused and only clamps to [min, max] on blur, so partial
 * edits are never rewritten under you.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  className,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
}) {
  const [text, setText] = React.useState(String(value));
  const focused = React.useRef(false);

  // Adopt external changes (reset, dataset defaults) only when not editing.
  React.useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  const clamp = (n: number) => {
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    return n;
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn(className ?? inputClass, disabled && 'opacity-50')}
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={e => {
        const raw = e.target.value;
        setText(raw);
        // Push valid numbers up live but DON'T clamp mid-typing, so a value
        // momentarily below the min (e.g. "2" on the way to "20") survives.
        const n = Number(raw);
        if (raw !== '' && Number.isFinite(n)) onChange(n);
      }}
      onBlur={e => {
        focused.current = false;
        const n = Number(e.target.value);
        const final = clamp(Number.isFinite(n) ? n : min ?? 0);
        onChange(final);
        setText(String(final));
      }}
    />
  );
}

export function Button({
  children,
  onClick,
  disabled,
  busy,
  variant = 'primary',
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'primary' && 'bg-sky-600 text-white hover:bg-sky-500',
        variant === 'ghost' && 'border border-white/10 text-slate-300 hover:bg-white/5',
        variant === 'danger' && 'border border-red-500/30 text-red-400 hover:bg-red-500/10',
        className
      )}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}

/** Red Stop button shown next to an action while it is running. */
export function StopButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Stop the current operation"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
    >
      <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
      Stop
    </button>
  );
}

/** Amber hint shown when a step's prerequisite isn't met yet. */
export function PrereqNote({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-300/90">
      {message}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="whitespace-pre-wrap">{message}</span>
    </div>
  );
}

export function ProgressBar({ current, total, message }: { current: number; total: number; message?: string }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      {message && <div className="mt-1.5 text-[11px] text-slate-500">{message}</div>}
    </div>
  );
}

/** A colour swatch — the same shape everywhere a colour is keyed to a label. */
export function Swatch({ color, shape = 'dot' }: { color: string; shape?: 'dot' | 'line' | 'square' }) {
  if (shape === 'line') return <span className="h-[3px] w-3.5 shrink-0 rounded-full" style={{ background: color }} />;
  return (
    <span
      className={cn('h-2.5 w-2.5 shrink-0', shape === 'square' ? 'rounded-[3px]' : 'rounded-full')}
      style={{ background: color }}
    />
  );
}

/** One legend entry: swatch + label, optional trailing count. */
export function LegendRow({
  color,
  label,
  count,
  shape,
}: {
  color: string;
  label: string;
  count?: number;
  shape?: 'dot' | 'line' | 'square';
}) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-slate-300">
      <Swatch color={color} shape={shape} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 tabular-nums text-slate-500">{count.toLocaleString()}</span>}
    </div>
  );
}

/** A horizontal colour gradient with end labels — for continuous encodings. */
export function GradientLegend({ from, to, leftLabel, rightLabel }: { from: string; to: string; leftLabel: string; rightLabel: string }) {
  return (
    <div>
      <div className="h-2 w-full rounded" style={{ background: `linear-gradient(to right, ${from}, ${to})` }} />
      <div className="mt-0.5 flex justify-between text-[10px] text-slate-500">
        <span className="truncate">{leftLabel}</span>
        <span className="truncate">{rightLabel}</span>
      </div>
    </div>
  );
}

export function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-[#0b0e11] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold" style={{ color: accent || '#e2e8f0' }}>
        {value}
      </div>
    </div>
  );
}
