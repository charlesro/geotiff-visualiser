import { ladderStep, type LadderContext } from './ladder-step';
import type { Rung } from './sensors';
import type { SweepStep } from './PcaSweep';

/**
 * One worker of the pool that builds the satellites table (ladder-pool.ts).
 *
 * It holds the design it was last handed and computes one rung per message,
 * with the same function the page would run (ladderStep). Everything a rung
 * caches lives here between messages: a plan's geometry, and above all the
 * searches for an imported trial's best placement, which are seconds each and
 * are asked for again every time the trial is moved.
 *
 * Messages in:  { type: 'ctx', id, ctx }   the design the next rungs are about
 *               { type: 'step', job, ctxId, rot, rung, asDrawn }
 * Messages out: { job, step } or { job, error }
 */

type In =
  | { type: 'ctx'; id: number; ctx: LadderContext }
  | { type: 'step'; job: number; ctxId: number; rot: number; rung: Rung; asDrawn: boolean };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<In>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

let ctx: LadderContext | null = null;
let ctxId = -1;

/** The arrays of a rung, handed over rather than copied. */
function buffersOf(step: SweepStep): Transferable[] {
  const out = new Set<ArrayBufferLike>();
  for (const a of [step.proportionA, step.proportionBare, step.mixed, step.proportionBySpecies, step.proportionOffTrial, step.pixelIds]) {
    if (a && ArrayBuffer.isView(a) && a.buffer.byteLength) out.add(a.buffer);
  }
  return [...out] as Transferable[];
}

scope.onmessage = e => {
  const m = e.data;
  if (m.type === 'ctx') { ctx = m.ctx; ctxId = m.id; return; }
  if (m.ctxId !== ctxId || !ctx) { scope.postMessage({ job: m.job, error: 'stale' }); return; }
  try {
    const step = ladderStep(ctx, m.rot, m.rung, m.asDrawn);
    scope.postMessage({ job: m.job, step }, buffersOf(step));
  } catch (err) {
    scope.postMessage({ job: m.job, error: err instanceof Error ? err.message : String(err) });
  }
};
