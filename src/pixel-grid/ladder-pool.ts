// The worker's script, as the URL the build gives it: the pool starts workers
// from it, and the page can fetch it ahead of the first table (prefetchLadderWorker).
import ladderWorkerUrl from './ladder.worker?worker&url';
import type { LadderContext } from './ladder-step';
import type { Rung } from './sensors';
import type { SweepStep } from './PcaSweep';

/**
 * The workers that build the satellites table, so that the page does not.
 *
 * A rung is a simulation of the trial for one satellite, ten of them with a
 * geolocation error, and a search for the best placement on top for an imported
 * trial: a dozen satellites, twice with the comparison, come to seconds of
 * work. Run on the page's own thread, even a slice at a time, each slice holds
 * the page for as long as it lasts, and on a slow computer a slice is a second.
 * Run here, the page stays free whatever the computer, and the rungs are
 * computed several at a time where there are cores for it.
 *
 * One job per worker at a time, the rest wait in a queue the page keeps: a
 * design that changes drops what is still waiting, and at most one stale rung
 * per worker runs to its end (its search is kept by that worker, and is
 * usually the next thing asked for). `prefer` sends a rung to the worker that
 * computed it last time when that worker is free, for those kept searches.
 *
 * Null where there are no workers, and `failed` once one has broken: the hook
 * then builds the table on the page, a slice per task, as it did before.
 */

interface Job {
  id: number;
  ctxId: number;
  rot: number;
  rung: Rung;
  asDrawn: boolean;
  prefer: number;
  resolve: (step: SweepStep) => void;
  reject: (why: Error) => void;
}

interface Slot { worker: Worker; job: Job | null; ctxId: number }

export interface LadderPool {
  /** Workers in the pool. */
  readonly size: number;
  /** True once a worker has failed: nothing more is to be asked of the pool. */
  readonly failed: boolean;
  /** The design the next rungs are about. Rungs still waiting for another one are dropped. Returns its id. */
  setContext: (ctx: LadderContext) => number;
  /** One rung, for the design `ctxId`. Rejects with 'stale' when that design was replaced before it ran. */
  step: (ctxId: number, rot: number, rung: Rung, asDrawn: boolean, prefer: number) => Promise<SweepStep>;
}

/** Up to four, and one core left to the page. */
const poolSize = (): number => {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, cores - 1));
};

function createPool(): LadderPool | null {
  if (typeof Worker === 'undefined') return null;
  const slots: Slot[] = [];
  const queue: Job[] = [];
  let ctx: LadderContext | null = null;
  let ctxId = 0, nextJob = 1, failed = false;

  const fail = (why: string) => {
    failed = true;
    const lost = [...queue, ...slots.map(s => s.job).filter((j): j is Job => !!j)];
    queue.length = 0;
    for (const s of slots) { s.job = null; try { s.worker.terminate(); } catch { /* already gone */ } }
    for (const j of lost) j.reject(new Error(why));
  };

  const dispatch = () => {
    if (failed) return;
    for (let w = 0; w < slots.length && queue.length; w++) {
      const slot = slots[w];
      if (slot.job) continue;
      let at = queue.findIndex(j => j.prefer % slots.length === w);
      if (at < 0) at = 0;
      const job = queue.splice(at, 1)[0];
      slot.job = job;
      try {
        if (slot.ctxId !== job.ctxId) { slot.worker.postMessage({ type: 'ctx', id: job.ctxId, ctx }); slot.ctxId = job.ctxId; }
        slot.worker.postMessage({ type: 'step', job: job.id, ctxId: job.ctxId, rot: job.rot, rung: job.rung, asDrawn: job.asDrawn });
      } catch (err) {
        // A design that cannot be handed over (it should be plain data): the page computes instead.
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
    }
  };

  try {
    for (let w = 0, n = poolSize(); w < n; w++) {
      const worker = new Worker(ladderWorkerUrl, { type: 'module' });
      const slot: Slot = { worker, job: null, ctxId: -1 };
      worker.onmessage = (e: MessageEvent<{ job: number; step?: SweepStep; error?: string }>) => {
        const job = slot.job;
        if (!job || job.id !== e.data.job) return;
        slot.job = null;
        if (e.data.step) job.resolve(e.data.step); else job.reject(new Error(e.data.error ?? 'no rung'));
        dispatch();
      };
      // The script did not load, or threw outside a rung: no worker can be trusted to answer.
      worker.onerror = e => { e.preventDefault?.(); fail(e.message || 'worker failed'); };
      slots.push(slot);
    }
  } catch {
    for (const s of slots) { try { s.worker.terminate(); } catch { /* already gone */ } }
    return null;
  }

  return {
    get size() { return slots.length; },
    get failed() { return failed; },
    setContext: next => {
      ctx = next;
      ctxId++;
      for (const j of queue.splice(0)) j.reject(new Error('stale'));
      return ctxId;
    },
    step: (forCtx, rot, rung, asDrawn, prefer) => new Promise<SweepStep>((resolve, reject) => {
      if (failed) { reject(new Error('worker failed')); return; }
      if (forCtx !== ctxId) { reject(new Error('stale')); return; }
      queue.push({ id: nextJob++, ctxId: forCtx, rot, rung, asDrawn, prefer, resolve, reject });
      dispatch();
    }),
  };
}

/**
 * Fetch the workers' script ahead of need, so that the first table does not
 * wait on the network for it: the browser keeps it, and the workers started
 * later load it from there. Nothing is started here, and a failure is nothing.
 */
export function prefetchLadderWorker(): void {
  if (typeof Worker === 'undefined' || typeof fetch === 'undefined') return;
  void fetch(ladderWorkerUrl).then(r => r.arrayBuffer()).catch(() => {});
}

let pool: LadderPool | null | undefined;

/** The page's pool, made at the first call. Null when this browser has no workers to give. */
export function ladderPool(): LadderPool | null {
  if (pool === undefined) pool = createPool();
  return pool;
}
