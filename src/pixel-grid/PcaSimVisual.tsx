import { memo, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Symbols,
  BarChart, Bar, LineChart, Line,
} from 'recharts';
import {
  BARE, makeTruth, makeBetaSchedule, parsOf, TMAX,
  type FieldParams, type FieldSim,
} from './simulate';
import { embed, DR_METHODS, type DrMethod } from '../lib/projections';
import { oneOf, usePersistentState } from './persist';

/**
 * PCA of the grid cells, with the full scatter toolset: pick the DR method, the
 * axes, the colour/shape encodings, see the variance and loadings, and flag the
 * not-pure (mixed) pixels. Each cell's NDVI season is a sample (pure = one crop,
 * mixed = the area-weighted sum + Beta-schedule noise).
 */

const NT = 24;
const EPS = 1e-3;
const SYM_A = 'triangle';
const SYM_B = 'square';
const AXIS_ABBR: Partial<Record<DrMethod, string>> = { pca: 'PC', whitened: 'PC', ica: 'IC', mnf: 'MNF', random: 'RP', kpca: 'KPC', isomap: 'Iso', diffusion: 'DC', tsne: 'tSNE' };

type ColorBy = 'mixing' | 'species' | 'purity';
type ShapeBy = 'species' | 'purity' | 'none';

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

const selectClass = 'rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-sky-500 focus:outline-none';

const PURE_T = 80; // % of one crop for the pure/mixed colour & shape encodings

function PcaSimVisual({ sim, cropA, cropB, magnitude, onSelect, busy }: {
  sim: FieldSim; cropA: FieldParams; cropB: FieldParams; magnitude: number;
  /** Report the pixel indices selected in the scatter (click / lasso) → map highlight. */
  onSelect?: (indices: number[]) => void;
  /** True while the parent is recomputing the simulation → show a spinner. */
  busy?: boolean;
}) {
  // The chart's own view settings survive a refresh too; selection and lasso are
  // momentary and deliberately do not.
  const [tab, setTab] = usePersistentState<'scatter' | 'variance' | 'loadings'>('pcaTab', 'scatter', oneOf('scatter', 'variance', 'loadings'));
  // Validated against the real list: an unknown method would make embed() throw.
  const [method, setMethodState] = usePersistentState<DrMethod>('pcaMethod', 'pca', v => DR_METHODS.some(m => m.id === v));
  const [pending, startTransition] = useTransition();
  // Switching the DR method re-embeds (slow for the nonlinear ones) — run it as a
  // transition so the spinner shows and the old chart stays until it's ready.
  const setMethod = (m: DrMethod) => startTransition(() => setMethodState(m));
  const working = !!busy || pending;
  const isAxis = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 2; // 3 components are computed
  const [pcX, setPcX] = usePersistentState('pcaX', 0, isAxis);
  const [pcY, setPcY] = usePersistentState('pcaY', 1, isAxis);
  const [colorBy, setColorBy] = usePersistentState<ColorBy>('pcaColorBy', 'mixing', oneOf('mixing', 'species', 'purity'));
  const [shapeBy, setShapeBy] = usePersistentState<ShapeBy>('pcaShapeBy', 'species', oneOf('species', 'purity', 'none'));
  // Pixel selection (→ highlighted on the map). Click one, or lasso many.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lassoOn, setLassoOn] = useState(false);
  const [lassoPath, setLassoPath] = useState<{ x: number; y: number }[]>([]);
  const lassoRef = useRef<{ drawing: boolean; path: { x: number; y: number }[]; svg: SVGSVGElement | null }>({ drawing: false, path: [], svg: null });
  const posRef = useRef<Record<number, { x: number; y: number }>>({}); // point k → screen px (from the Dot renderer)
  const pick = (ids: number[]) => { setSelected(new Set(ids)); onSelect?.(ids); };
  // Clear the selection whenever the underlying data changes.
  useEffect(() => { setSelected(new Set()); onSelect?.([]); }, [sim]); // eslint-disable-line react-hooks/exhaustive-deps

  const sig = (c: FieldParams) => `${c.truth}_${c.L1}_${c.k1}_${c.x01}_${c.k2}_${c.x02}_${c.tc}_${c.color}`;

  // Build the cell signals + embed once per (data, method) — axis/encoding
  // changes are cheap and never re-embed (matters for the slow nonlinear ones).
  const fit = useMemo(() => {
    const A = pureCurve(cropA), B = pureCurve(cropB);
    const varSched = makeBetaSchedule(NT, 2, 2, Math.max(0, magnitude));
    const pAs: number[] = [];
    const rows = Array.from(sim.proportionA, (pA, k) => {
      pAs.push(pA);
      const pBare = sim.proportionBare ? sim.proportionBare[k] : 0;
      const pB = Math.max(0, 1 - pA - pBare);
      const rnd = rngFor(k * 2654435761 + 12345);
      const z = gauss(rnd); // ONE normal per pixel → correlated season (repo `simulate`)
      return A.map((a, t) => {
        const m = pA * a + pB * B[t] + pBare * BARE.ndvi;
        const sd = Math.sqrt(Math.min(Math.max(0, varSched[t]), m * (1 - m))); // clamp to m(1−m)
        return Math.min(1 - EPS, Math.max(EPS, m + sd * z));
      });
    });
    const components = Math.min(3, NT);
    const { scores, index, explained, loadings } = embed(method, { fit: rows, proj: rows, components });
    const pts = scores.map((s, j) => ({ s, pA: pAs[index[j]], k: index[j] })); // k = pixel index
    return { pts, explained, loadings };
  }, [sim, sig(cropA), sig(cropB), magnitude, method]);

  const nComp = fit.explained.length;
  const abbr = AXIS_ABBR[method] ?? 'C';
  const ax = (i: number) => `${abbr}${i + 1}`;
  const axLabel = (i: number) => `${ax(i)} (${(fit.explained[i] ?? 0).toFixed(0)}%)`;
  const cx = Math.min(pcX, nComp - 1), cy = Math.min(pcY, nComp - 1);

  const hasSel = selected.size > 0;
  const points = useMemo(() => fit.pts.map(p => {
    const pure = Math.max(p.pA, 1 - p.pA) >= PURE_T / 100;
    const color =
      colorBy === 'mixing' ? mixHex(cropA.color, cropB.color, p.pA)
      : colorBy === 'species' ? (p.pA >= 0.5 ? cropA.color : cropB.color)
      : pure ? '#22c55e' : '#ef4444';
    const sym = (shapeBy === 'species' ? (p.pA >= 0.5 ? SYM_A : SYM_B)
      : shapeBy === 'purity' ? (pure ? 'circle' : 'cross')
      : 'circle') as any;
    return { x: p.s[cx] ?? 0, y: p.s[cy] ?? 0, pA: p.pA, color, sym, k: p.k, sel: selected.has(p.k) };
  }), [fit, cx, cy, colorBy, shapeBy, cropA.color, cropB.color, selected]);

  const Dot = (p: any) => {
    const { cx: x, cy: y, payload } = p;
    if (typeof x !== 'number') return <g />;
    posRef.current[payload.k] = { x, y }; // remember screen position for the lasso
    const dim = hasSel && !payload.sel;
    return (
      <g>
        {payload.sel && <circle cx={x} cy={y} r={7} fill="none" stroke="#fde047" strokeWidth={2} />}
        <Symbols cx={x} cy={y} type={payload.sym} size={34} fill={payload.color} fillOpacity={dim ? 0.2 : 0.85} stroke={payload.sel ? '#fde047' : '#0b0e11'} strokeWidth={payload.sel ? 1 : 0.5} />
      </g>
    );
  };

  // ----- lasso select ---------------------------------------------------------
  const svgPt = (e: React.PointerEvent): { x: number; y: number } => {
    const r = lassoRef.current.svg!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top }; // same px frame as the Dot cx/cy
  };
  const pointInPath = (pt: { x: number; y: number }, poly: { x: number; y: number }[]) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
    }
    return inside;
  };
  const lassoDown = (e: React.PointerEvent) => {
    if (!lassoOn) return;
    e.preventDefault();
    lassoRef.current.svg?.setPointerCapture(e.pointerId);
    lassoRef.current.drawing = true;
    const start = [svgPt(e)];
    lassoRef.current.path = start; setLassoPath(start);
  };
  const lassoMove = (e: React.PointerEvent) => {
    if (!lassoRef.current.drawing) return;
    const q = svgPt(e), prev = lassoRef.current.path;
    if (prev.length && Math.hypot(prev[prev.length - 1].x - q.x, prev[prev.length - 1].y - q.y) < 2) return;
    const next = [...prev, q];
    lassoRef.current.path = next; setLassoPath(next);
  };
  const lassoUp = () => {
    if (!lassoRef.current.drawing) return;
    lassoRef.current.drawing = false;
    const path = lassoRef.current.path;
    if (path.length >= 3) {
      const ids = points.filter(p => { const pos = posRef.current[p.k]; return pos && pointInPath(pos, path); }).map(p => p.k);
      pick(ids);
    }
    lassoRef.current.path = []; setLassoPath([]);
  };

  const varData = fit.explained.map((v, i) => ({ pc: ax(i), explained: +v.toFixed(1) }));
  const loadData = fit.loadings.length
    ? Array.from({ length: fit.loadings[0].length }, (_, t) => {
        const row: Record<string, number> = { t };
        fit.loadings.forEach((c, i) => { row[ax(i)] = +(c[t] ?? 0).toFixed(3); });
        return row;
      })
    : [];
  const loadColors = ['#38bdf8', '#f59e0b', '#a78bfa'];

  return (
    // Fragment (not a wrapper div) so the sticky chart's containing block is the
    // whole step — it stays pinned while the parameters below it scroll.
    <>
      {/* Chart stays pinned at the top so you keep an eye on it while editing the
          field / plant parameters that scroll underneath it. */}
      <div className="sticky top-0 z-20 -mx-4 space-y-2 bg-[#11151a] px-4 pb-2 pt-1 shadow-[0_10px_12px_-8px_rgba(0,0,0,0.8)]">
        <div className="flex items-center gap-1 border-b border-white/10 text-xs">
          {(['scatter', 'variance', 'loadings'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-2.5 py-1 capitalize ${tab === t ? 'border-b-2 border-sky-500 text-sky-300' : 'text-neutral-500 hover:text-neutral-300'}`}>{t}</button>
          ))}
          {working && (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-sky-300">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400/25 border-t-sky-400" /> updating…
            </span>
          )}
          {hasSel
            ? <button onClick={() => pick([])} className={`rounded border border-yellow-400/40 bg-yellow-400/10 px-2 py-0.5 text-[10px] text-yellow-300 hover:bg-yellow-400/20 ${working ? '' : 'ml-auto'}`}>{selected.size} selected · clear</button>
            : <span className={`text-[11px] text-neutral-500 ${working ? '' : 'ml-auto'}`}>{points.length} px</span>}
          <button onClick={() => setLassoOn(v => !v)} title="Draw a lasso to select pixels"
            className={`rounded border px-2 py-0.5 text-[10px] ${lassoOn ? 'border-sky-400/50 bg-sky-500/15 text-sky-300' : 'border-white/10 text-neutral-400 hover:text-neutral-200'}`}>
            {lassoOn ? '✓ Lasso' : 'Lasso'}
          </button>
        </div>

        {tab === 'scatter' && (
          <>
            <div className="relative overflow-hidden rounded-xl ring-1 ring-inset ring-white/[0.06]"
                 style={{ background: 'radial-gradient(125% 90% at 50% -10%, #161d26 0%, #0c1014 60%)' }}>
              <div style={{ height: 280, opacity: working ? 0.45 : 1, transition: 'opacity 0.15s' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 10, right: 12, bottom: 24, left: 0 }}>
                    <CartesianGrid stroke="#ffffff0a" strokeDasharray="3 6" />
                    <XAxis type="number" dataKey="x" tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={(v: number) => v.toFixed(2)}
                      tickLine={false} axisLine={{ stroke: '#ffffff14' }} label={{ value: axLabel(cx), position: 'insideBottom', offset: -8, fill: '#94a3b8', fontSize: 11 }} />
                    <YAxis type="number" dataKey="y" width={42} tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={(v: number) => v.toFixed(2)}
                      tickLine={false} axisLine={{ stroke: '#ffffff14' }} label={{ value: axLabel(cy), angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }} />
                    {!lassoOn && <Tooltip cursor={{ strokeDasharray: '3 3', stroke: '#475569' }}
                      content={({ payload }: any) => {
                        const p = payload?.[0]?.payload; if (!p) return null;
                        return <div className="rounded-md border border-white/10 bg-[#11151a] px-2 py-1 text-[11px] text-slate-300">
                          {(p.pA * 100).toFixed(0)}% {cropA.name} · {((1 - p.pA) * 100).toFixed(0)}% {cropB.name}</div>;
                      }} />}
                    <Scatter data={points} shape={Dot} isAnimationActive={false} onClick={(d: any) => pick([d.k])} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
              {/* Lasso overlay — captures pointer events only when armed. */}
              <svg ref={el => { lassoRef.current.svg = el; }} className="absolute inset-0 h-full w-full"
                style={{ pointerEvents: lassoOn ? 'auto' : 'none', cursor: lassoOn ? 'crosshair' : 'default', touchAction: 'none' }}
                onPointerDown={lassoDown} onPointerMove={lassoMove} onPointerUp={lassoUp} onPointerCancel={lassoUp}>
                {lassoPath.length > 1 && (
                  <polygon points={lassoPath.map(p => `${p.x},${p.y}`).join(' ')} fill="#38bdf822" stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="4 3" />
                )}
              </svg>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-neutral-400">
              <span className="flex items-center gap-2">
                <svg width="9" height="9" viewBox="0 0 10 10"><polygon points="5,1 9,9 1,9" fill="#94a3b8" /></svg>{cropA.name}
                <svg width="9" height="9" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#94a3b8" /></svg>{cropB.name}
              </span>
              {colorBy === 'mixing' && (
                <span className="flex items-center gap-1">
                  {cropB.name}<span className="h-2 w-12 rounded-sm" style={{ background: `linear-gradient(to right, ${cropB.color}, ${cropA.color})` }} />{cropA.name}
                </span>
              )}
            </div>
          </>
        )}

        {tab === 'variance' && (
          <div className="rounded-md border border-white/10 bg-black/30 p-2">
            <div style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={varData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke="#ffffff0a" strokeDasharray="3 6" />
                  <XAxis dataKey="pc" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={{ stroke: '#ffffff14' }} tickLine={false} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={{ stroke: '#ffffff14' }} tickLine={false} unit="%" />
                  <Tooltip contentStyle={{ background: '#11151a', border: '1px solid #ffffff1a', fontSize: 11 }} formatter={(v: number) => `${v}%`} />
                  <Bar dataKey="explained" fill="#38bdf8" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1 text-[11px] text-neutral-500">Variance carried by each axis.</p>
          </div>
        )}

        {tab === 'loadings' && (
          <div className="rounded-md border border-white/10 bg-black/30 p-2">
            {loadData.length ? (
              <>
                <div style={{ height: 200 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={loadData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                      <CartesianGrid stroke="#ffffff0a" strokeDasharray="3 6" />
                      <XAxis dataKey="t" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={{ stroke: '#ffffff14' }} tickLine={false} />
                      <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={{ stroke: '#ffffff14' }} tickLine={false} />
                      <Tooltip contentStyle={{ background: '#11151a', border: '1px solid #ffffff1a', fontSize: 11 }} labelFormatter={(t) => `t ${t}`} />
                      {fit.loadings.map((_, i) => <Line key={i} type="monotone" dataKey={ax(i)} stroke={loadColors[i % loadColors.length]} dot={false} strokeWidth={1.4} />)}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-1 text-[11px] text-neutral-500">How each season time-step weights into the components.</p>
              </>
            ) : (
              <p className="text-[11px] text-neutral-500">Loadings aren’t defined for {DR_METHODS.find(m => m.id === method)?.label}.</p>
            )}
          </div>
        )}
      </div>

      {/* Chart controls — scroll under the pinned chart. */}
      {tab === 'scatter' && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-neutral-400">
            <label className="flex items-center gap-1">Method
              <select className={selectClass} value={method} onChange={e => setMethod(e.target.value as DrMethod)}>
                {DR_METHODS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1">X
              <select className={selectClass} value={cx} onChange={e => setPcX(+e.target.value)}>
                {fit.explained.map((_, i) => <option key={i} value={i}>{ax(i)}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1">Y
              <select className={selectClass} value={cy} onChange={e => setPcY(+e.target.value)}>
                {fit.explained.map((_, i) => <option key={i} value={i}>{ax(i)}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1">Colour
              <select className={selectClass} value={colorBy} onChange={e => setColorBy(e.target.value as ColorBy)}>
                <option value="mixing">mix fraction</option>
                <option value="species">species</option>
                <option value="purity">pure / mixed</option>
              </select>
            </label>
            <label className="flex items-center gap-1">Shape
              <select className={selectClass} value={shapeBy} onChange={e => setShapeBy(e.target.value as ShapeBy)}>
                <option value="species">species</option>
                <option value="purity">pure / mixed</option>
                <option value="none">none</option>
              </select>
            </label>
          </div>
        </>
      )}
    </>
  );
}

// Memoised: it only needs to redraw when its own data changes. A parameter change
// re-renders the whole page, and redrawing ~700 interactive dots each time cost
// hundreds of milliseconds. Its props are kept stable upstream (pcaView,
// cropAd/cropBd, the setSelectedPixels setter).
export default memo(PcaSimVisual);
