/**
 * What the catalogue holds in one month of the series, beyond what it already has.
 *
 * Cloud cover is shown rather than used to filter: it is measured over the whole
 * 110 km tile, so a 60%-cloudy scene can be perfectly clear over a handful of
 * fields — and the reverse happens just as often. The two numbers that decide
 * are how much of the fields the swath covers at all, and how much of the ground
 * it actually saw, which is read from the Scene Classification band on demand
 * because each read costs a real request.
 */
import React, { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { SceneCandidate, SceneClarity, PARTIAL_COVERAGE } from '../../lib/fetch-series';
import { cn } from '../../lib/utils';
import { PickerState } from './model';

export function ScenePicker({
  state,
  busy,
  clarity,
  onCheck,
  onCheckAll,
  onInsert,
  onClose,
}: {
  state: PickerState;
  busy: boolean;
  clarity: Record<string, SceneClarity | 'loading' | 'none'>;
  onCheck: (candidate: SceneCandidate) => Promise<void>;
  onCheckAll: (candidates: SceneCandidate[]) => Promise<void>;
  onInsert: (chosen: SceneCandidate[]) => void | Promise<unknown>;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const toggle = (date: string) =>
    setChosen(s => {
      const next = new Set(s);
      next.has(date) ? next.delete(date) : next.add(date);
      return next;
    });
  const picked = state.candidates.filter(cd => chosen.has(cd.date));
  const unchecked = state.candidates.filter(cd => clarity[cd.date] === undefined).length;

  return (
    <div className="rounded-lg border border-sky-400/25 bg-sky-500/[0.04]">
      <div className="flex items-baseline justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="text-[11px] text-slate-200">
          {state.label}
          <span className="ml-2 tabular-nums text-slate-500">
            {state.range.start} → {state.range.end}
          </span>
        </span>
        <button onClick={onClose} className="shrink-0 text-slate-500 hover:text-slate-300" title="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="px-3 py-2 text-[10px]">
        {state.loading && (
          <p className="flex items-center gap-1.5 text-sky-300/90">
            <Loader2 className="h-3 w-3 animate-spin" /> Searching the catalogue…
          </p>
        )}
        {state.error && <p className="text-amber-300/90">{state.error}</p>}

        {!state.loading && !state.error && state.candidates.length === 0 && (
          <p className="text-slate-500">
            The catalogue holds nothing more here — what is missing is the satellite’s doing, not a
            filter’s.
          </p>
        )}

        {!state.loading && state.candidates.length > 0 && (
          <>
            <div className="mb-1 flex items-center gap-2 text-slate-600">
              <span className="w-3" />
              <span className="w-12">date</span>
              <span className="w-12 text-right" title="Cloud over the whole 110 km tile, not over your fields">
                cloud
              </span>
              <span className="w-12 text-right" title="Share of your analysed fields the swath covers at all">
                covers
              </span>
              <span
                className="w-14 text-right"
                title="Share of your field pixels where the ground was actually visible, from the Scene Classification band — the one to trust"
              >
                visible
              </span>
              {unchecked > 0 && (
                <button
                  onClick={() => onCheckAll(state.candidates)}
                  disabled={busy}
                  className="ml-auto rounded border border-white/10 px-1.5 py-0.5 transition-colors hover:border-sky-400/40 hover:text-sky-200 disabled:opacity-40"
                >
                  check all ({unchecked})
                </button>
              )}
            </div>

            <div className="max-h-44 space-y-px overflow-y-auto pr-1">
              {state.candidates.map(cd => {
                const thin = cd.coverage < PARTIAL_COVERAGE;
                const cl = clarity[cd.date];
                const on = chosen.has(cd.date);
                return (
                  <label
                    key={cd.date}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 transition-colors',
                      on ? 'bg-sky-500/10' : 'hover:bg-white/[0.03]'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(cd.date)}
                      disabled={busy}
                      className="h-3 w-3 shrink-0 accent-sky-500"
                    />
                    <span className={cn('w-12 tabular-nums', on ? 'text-slate-200' : 'text-slate-300')}>
                      {cd.date.slice(5)}
                    </span>
                    <span className="w-12 text-right tabular-nums text-slate-500">
                      {cd.cloudCover == null ? '—' : `${cd.cloudCover.toFixed(0)}%`}
                    </span>
                    <span
                      className={cn(
                        'w-12 text-right tabular-nums',
                        thin ? 'text-amber-300/80' : 'text-slate-400'
                      )}
                    >
                      {(cd.coverage * 100).toFixed(0)}%
                    </span>
                    <span className="w-14 text-right tabular-nums">
                      {cl === undefined ? (
                        <button
                          onClick={e => {
                            e.preventDefault();
                            void onCheck(cd);
                          }}
                          disabled={busy}
                          className="text-sky-300/80 underline decoration-dotted underline-offset-2 hover:text-sky-200 disabled:opacity-40"
                        >
                          check
                        </button>
                      ) : cl === 'loading' ? (
                        <Loader2 className="ml-auto h-3 w-3 animate-spin text-sky-300/80" />
                      ) : cl === 'none' ? (
                        <span className="text-slate-600">no SCL</span>
                      ) : (
                        <span
                          className={
                            cl.clear >= 0.8
                              ? 'text-emerald-300'
                              : cl.clear >= 0.5
                                ? 'text-amber-300/90'
                                : 'text-rose-300/80'
                          }
                        >
                          {(cl.clear * 100).toFixed(0)}%
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="mt-2 flex items-center gap-2 border-t border-white/[0.06] pt-2">
              <button
                onClick={() => onInsert(picked)}
                disabled={busy || picked.length === 0}
                className="rounded border border-sky-400/30 bg-sky-500/10 px-2 py-0.5 text-sky-200 transition-colors hover:border-sky-400/60 disabled:opacity-40"
              >
                {picked.length === 0
                  ? 'Add to the series'
                  : `Add ${picked.length} date${picked.length === 1 ? '' : 's'}`}
              </button>
              <span className="text-slate-600">re-extracts the pixels and re-clusters</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
