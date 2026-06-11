import React from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/utils';

/** Small shared form primitives so every step looks identical. */

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-600">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-white/10 bg-[#0b0e11] px-2.5 py-1.5 text-sm text-slate-200 ' +
  'placeholder:text-slate-600 focus:border-sky-500/60 focus:outline-none';

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
