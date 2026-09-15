import { Fragment, memo, useEffect, useMemo, useRef } from 'react';
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
  return { pts: orient(scores.map((s, j) => ({ x: s[0] ?? 0, y: s[1] ?? 0, pA: pAs[index[j]] }))) };
}

/**
 * Put every panel in the same orientation: PC1 increasing with the crop-A
 * fraction, PC2 increasing with mixedness pA·(1−pA). A PCA's axis signs are
 * arbitrary, so without this neighbouring panels came out mirrored — maize on
 * the left in one, on the right in the next — and a side-by-side comparison read
 * a sign flip as a difference in the data. Flipping an axis changes nothing else.
 */
function orient(pts: { x: number; y: number; pA: number }[]) {
  const n = pts.length;
  if (n < 2) return pts;
  let mx = 0, my = 0, ma = 0, mm = 0;
  for (const p of pts) { mx += p.x; my += p.y; ma += p.pA; mm += p.pA * (1 - p.pA); }
  mx /= n; my /= n; ma /= n; mm /= n;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += (p.x - mx) * (p.pA - ma); cy += (p.y - my) * (p.pA * (1 - p.pA) - mm); }
  const sx = cx < 0 ? -1 : 1, sy = cy < 0 ? -1 : 1;
  return sx === 1 && sy === 1 ? pts : pts.map(p => ({ ...p, x: sx * p.x, y: sy * p.y }));
}


/**
 * One mini dot plot, drawn on a <canvas>. These panels have no axes, tooltips or
 * per-dot interaction, so drawing them as SVG bought nothing — and it cost ~25 ms
 * of React work per panel on EVERY render (hundreds of <Symbols> each), which
 * was most of the freeze after any parameter change. Canvas draws a panel in
 * well under a millisecond. Same dot size, opacity, colours and orientation.
 */
function DotCanvas({ pts, colorA, colorB, height }: {
  pts: { x: number; y: number; pA: number }[]; colorA: string; colorB: string; height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const w = cv.clientWidth, h = height;
      if (!w) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!pts.length) return;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
      const pad = 4;
      const px = (x: number) => (x1 > x0 ? pad + ((x - x0) / (x1 - x0)) * (w - 2 * pad) : w / 2);
      const py = (y: number) => (y1 > y0 ? h - pad - ((y - y0) / (y1 - y0)) * (h - 2 * pad) : h / 2); // PC2 up
      ctx.globalAlpha = 0.8;
      for (const p of pts) {
        ctx.fillStyle = mixHex(colorA, colorB, p.pA);
        ctx.beginPath();
        ctx.arc(px(p.x), py(p.y), 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [pts, colorA, colorB, height]);
  return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} />;
}

function PcaSweep({ steps, pairWith, pairLabels, cropA, cropB, magnitude, activeRes, onPick }: {
  steps: SweepStep[];
  /**
   * A second ladder over the same resolutions (e.g. the rows laid along the
   * pixels). When given, the two are drawn as PAIRS — one resolution per row,
   * `steps` on the left and `pairWith` on the right — so each size is compared
   * against itself rather than across two separate grids.
   */
  pairWith?: SweepStep[] | null;
  pairLabels?: [string, string];
  cropA: FieldParams; cropB: FieldParams; magnitude: number;
  activeRes?: number; onPick?: (res: number) => void;
}) {
  const A = useMemo(() => pureCurve(cropA), [cropA]);
  const B = useMemo(() => pureCurve(cropB), [cropB]);
  const toCharts = (list: SweepStep[]) =>
    list.map(s => ({ res: s.res, purePct: s.purePct, ...embedOne(s, A, B, magnitude) }));
  const charts = useMemo(() => toCharts(steps), [steps, A, B, magnitude]); // eslint-disable-line react-hooks/exhaustive-deps
  const pairCharts = useMemo(() => (pairWith ? toCharts(pairWith) : null), [pairWith, A, B, magnitude]); // eslint-disable-line react-hooks/exhaustive-deps
  const pc = (v: number) => (v >= 70 ? 'text-emerald-400' : v >= 40 ? 'text-amber-400' : 'text-rose-400');

  const panel = (c: ReturnType<typeof toCharts>[number], key: string) => {
    const active = activeRes != null && Math.abs(activeRes - c.res) < 1e-6;
    return (
      <button
        key={key}
        type="button"
        onClick={() => onPick?.(c.res)}
        title={`Show the field at ${c.res} m`}
        className={`rounded-md border p-1 text-left transition-colors ${active ? 'border-sky-400 bg-sky-500/10 ring-1 ring-sky-400/40' : 'border-white/10 bg-black/30 hover:border-sky-500/40 hover:bg-white/[0.04]'}`}
      >
        <div className="flex items-baseline justify-between px-0.5 text-[10px]">
          <span className="font-mono text-neutral-300">{c.res} m{active ? ' ·' : ''}</span>
          <span className={pc(c.purePct)}>{c.purePct.toFixed(0)}%</span>
        </div>
        <div className="pointer-events-none">
          <DotCanvas pts={c.pts} colorA={cropA.color} colorB={cropB.color} height={92} />
        </div>
      </button>
    );
  };

  if (pairCharts) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {pairLabels && (<>
          <p className="text-[10px] uppercase tracking-wide text-sky-300/80">{pairLabels[0]}</p>
          <p className="text-[10px] uppercase tracking-wide text-neutral-500">{pairLabels[1]}</p>
        </>)}
        {charts.map(c => {
          // Matched by resolution, not by position, so a missing size can never
          // shift every later row out of step.
          const twin = pairCharts.find(p => Math.abs(p.res - c.res) < 1e-9);
          return (
            <Fragment key={c.res}>
              {panel(c, `a-${c.res}`)}
              {twin ? panel(twin, `b-${c.res}`) : <div />}
            </Fragment>
          );
        })}
      </div>
    );
  }

  return <div className="grid grid-cols-3 gap-2">{charts.map(c => panel(c, String(c.res)))}</div>;
}

// Memoised: a parameter change re-renders the whole page, and without this every
// panel redrew even when its ladder had not changed. All props are kept stable
// upstream (pickRes, cropAd/cropBd, pairLabels) so the comparison actually holds.
export default memo(PcaSweep);
