import React, { useState } from 'react';
import { Check, ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
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
  const [collapsed, setCollapsed] = useState(false);

  // The full panel is hidden — not unmounted — while collapsed, so the step
  // forms keep their values (buffer distance, dates…) across collapse and
  // step switches.
  return (
    <>
      {/* Slim rail: step numbers only, the map gets the room. */}
      <div
        className={cn(
          'flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-white/10 bg-[#11151a] py-2',
          !collapsed && 'hidden'
        )}
      >
        <button
          onClick={() => setCollapsed(false)}
          className="mb-1 rounded-md p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200"
          title="Expand the workflow panel"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        {steps.map(step => (
          <button
            key={step.id}
            onClick={() => {
              setCollapsed(false);
              onActivate(step.id);
            }}
            title={step.title}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors',
              step.done
                ? 'bg-emerald-500/20 text-emerald-400'
                : activeStep === step.id
                  ? 'bg-sky-500/20 text-sky-300'
                  : 'bg-white/10 text-slate-400 hover:bg-white/20'
            )}
          >
            {step.done ? <Check className="h-3.5 w-3.5" /> : step.id}
          </button>
        ))}
      </div>

      <div
        className={cn('flex h-full w-[390px] shrink-0 flex-col border-r border-white/10 bg-[#11151a]', collapsed && 'hidden')}
      >
      <div className="flex items-center justify-end border-b border-white/5 px-2 py-1">
        <button
          onClick={() => setCollapsed(true)}
          className="rounded-md p-1 text-slate-600 hover:bg-white/5 hover:text-slate-300"
          title="Collapse the workflow panel — more room for the map"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {steps.map(step => {
          const open = activeStep === step.id;
          return (
            <section key={step.id} className="border-b border-white/5">
              <button
                onClick={() => onActivate(step.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]',
                  !step.enabled && !open && 'opacity-55'
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
              {/* Hidden, not unmounted, when closed: the form state survives. */}
              <div className={cn('space-y-3 px-4 pb-4 pt-1', !open && 'hidden')}>{step.content}</div>
            </section>
          );
        })}
      </div>
      </div>
    </>
  );
}
