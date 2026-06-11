import React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * The workflow sidebar: a vertical stepper where exactly one step is open.
 * Steps unlock as their prerequisites complete, keeping the user on the
 * polygons → imagery → zones → PCA rail.
 */

export interface StepDescriptor {
  id: number;
  title: string;
  /** One-line summary shown when the step is done or collapsed. */
  summary: string | null;
  enabled: boolean;
  done: boolean;
  content: React.ReactNode;
}

export default function Sidebar({
  steps,
  activeStep,
  onActivate,
}: {
  steps: StepDescriptor[];
  activeStep: number;
  onActivate: (id: number) => void;
}) {
  return (
    <div className="flex h-full w-[390px] shrink-0 flex-col border-r border-white/10 bg-[#11151a]">
      <div className="flex-1 overflow-y-auto">
        {steps.map(step => {
          const open = activeStep === step.id;
          return (
            <section key={step.id} className="border-b border-white/5">
              <button
                onClick={() => step.enabled && onActivate(step.id)}
                disabled={!step.enabled}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
                  step.enabled ? 'hover:bg-white/[0.03]' : 'cursor-not-allowed opacity-45'
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                    step.done
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : open
                        ? 'bg-sky-500/20 text-sky-300'
                        : 'bg-white/10 text-slate-400'
                  )}
                >
                  {step.done ? <Check className="h-3.5 w-3.5" /> : step.id}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm font-medium', open ? 'text-slate-100' : 'text-slate-300')}>
                    {step.title}
                  </span>
                  {!open && step.summary && (
                    <span className="block truncate text-xs text-slate-500">{step.summary}</span>
                  )}
                </span>
                <ChevronDown
                  className={cn('h-4 w-4 shrink-0 text-slate-600 transition-transform', open && 'rotate-180')}
                />
              </button>
              {open && <div className="space-y-3 px-4 pb-4 pt-1">{step.content}</div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
