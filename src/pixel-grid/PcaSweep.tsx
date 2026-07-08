import { useMemo } from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, ResponsiveContainer, Symbols } from 'recharts';
import { BARE, makeTruth, makeBetaSchedule, parsOf, TMAX, type FieldParams } from './simulate';
import { embed } from '../lib/projections';

/**
 * Small-multiples PCA: one compact scatter per pixel size so you can see the
 * clusters (pure crop A / mixed / pure crop B) collapse together as the sensor
 * gets coarser. Each chart is an independent PCA of that resolution's pixels.
 */

const NT = 24;
const EPS = 1e-3;
const MAXPTS = 360; // cap points per mini-chart so 9 charts stay snappy

const hexRgb = (h: string): [number, number, number] => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const mixHex = (a: string, b: string, t: number) => {
  const [ar, ag, ab] = hexRgb(a), [br, bg, bb] = hexRgb(b);
  const f = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(br + (ar - br) * f)},${Math.round(bg + (ag - bg) * f)},${Math.round(bb + (ab - bb) * f)})`;
};
const pureCurve = (f: FieldParams): number[] => {
  const full = makeTruth(f.truth, TMAX, parsOf(f));
  return Array.from({ length: NT }, (_, i) => full[Math.round((i * (TMAX - 1)) / (NT - 1))]);
};
const rngFor = (seed: number) => {
  let s = (seed % 2147483647 + 2147483647) % 2147483647 || 1;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
};
const gauss = (rnd: () => number) => {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export interface SweepStep { res: number; proportionA: Float32Array; proportionBare: Float32Array; purePct: number; }

/** One PCA of a resolution's pixels (each pixel = a noisy NDVI season, repo model). */
function embedOne(step: SweepStep, A: number[], B: number[], magnitude: number) {
  const { proportionA, proportionBare } = step;
  const n = proportionA.length;
  const stride = n > MAXPTS ? Math.ceil(n / MAXPTS) : 1;
  const varSched = makeBetaSchedule(NT, 2, 2, Math.max(0, magnitude));
  const pAs: number[] = [];
  const rows: number[][] = [];
  for (let k = 0; k < n; k += stride) {
    const pA = proportionA[k];
    const pBare = proportionBare ? proportionBare[k] : 0;
    const pB = Math.max(0, 1 - pA - pBare);
    pAs.push(pA);
    const rnd = rngFor(k * 2654435761 + 12345);
    const z = gauss(rnd); // ONE normal per pixel → correlated season (repo `simulate`)
    rows.push(A.map((a, t) => {
      const m = pA * a + pB * B[t] + pBare * BARE.ndvi;
      const sd = Math.sqrt(Math.min(Math.max(0, varSched[t]), m * (1 - m))); // clamp to m(1−m)
      return Math.min(1 - EPS, Math.max(EPS, m + sd * z));
    }));
  }
  if (rows.length < 3) return { pts: [] as { x: number; y: number; pA: number }[] };
  const { scores, index } = embed('pca', { fit: rows, proj: rows, components: Math.min(2, NT) });
  return { pts: scores.map((s, j) => ({ x: s[0] ?? 0, y: s[1] ?? 0, pA: pAs[index[j]] })) };
}

export default function PcaSweep({ steps, cropA, cropB, magnitude, activeRes, onPick }: {
  steps: SweepStep[]; cropA: FieldParams; cropB: FieldParams; magnitude: number;
  activeRes?: number; onPick?: (res: number) => void;
}) {
  const A = useMemo(() => pureCurve(cropA), [cropA]);
  const B = useMemo(() => pureCurve(cropB), [cropB]);
  const charts = useMemo(
    () => steps.map(s => ({ res: s.res, purePct: s.purePct, ...embedOne(s, A, B, magnitude) })),
    [steps, A, B, magnitude],
  );
  const pc = (v: number) => (v >= 70 ? 'text-emerald-400' : v >= 40 ? 'text-amber-400' : 'text-rose-400');

  return (
    <div className="grid grid-cols-3 gap-2">
      {charts.map(c => {
        const active = activeRes != null && Math.abs(activeRes - c.res) < 1e-6;
        return (
          <button
            key={c.res}
            type="button"
            onClick={() => onPick?.(c.res)}
            title={`Show the field at ${c.res} m`}
            className={`rounded-md border p-1 text-left transition-colors ${active ? 'border-sky-400 bg-sky-500/10 ring-1 ring-sky-400/40' : 'border-white/10 bg-black/30 hover:border-sky-500/40 hover:bg-white/[0.04]'}`}
          >
            <div className="flex items-baseline justify-between px-0.5 text-[10px]">
              <span className="font-mono text-neutral-300">{c.res} m{active ? ' ·' : ''}</span>
              <span className={pc(c.purePct)}>{c.purePct.toFixed(0)}%</span>
            </div>
            <div style={{ height: 92 }} className="pointer-events-none">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 4, right: 4, bottom: 2, left: 2 }}>
                  <XAxis type="number" dataKey="x" hide />
                  <YAxis type="number" dataKey="y" hide />
                  <Scatter data={c.pts} isAnimationActive={false}
                    shape={(p: any) => <Symbols cx={p.cx} cy={p.cy} type="circle" size={9} fill={mixHex(cropA.color, cropB.color, p.payload.pA)} fillOpacity={0.8} />} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </button>
        );
      })}
    </div>
  );
}
