import { memo, useEffect, useMemo, useState, useTransition } from 'react';
import {
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  BarChart, Bar, LineChart, Line,
} from 'recharts';
import { PcaScatterCanvas, SymbolIcon } from './PcaScatterCanvas';
import { BARE, OFF_TRIAL, type FieldParams, type FieldSim } from './simulate';
import { coverShares, fmt } from './util';
import { DR_METHODS, type DrMethod } from '../lib/projections';
import { oneOf, usePersistentState } from './persist';
import { SYMS, axisSigns, fitCover, pointStyle, type ColorBy, type ShapeBy } from './pca-field';

/**
 * PCA of the grid cells, with the full scatter toolset: pick the DR method, the
 * axes, the colour/shape encodings, see the variance and loadings, and flag the
 * not-pure (mixed) pixels. What each pixel's season is, how it is embedded,
 * which way the axes face and how a pixel is coloured all come from pca-field,
 * shared with the resolution ladder so the two can never disagree.
 */

/** Most species keys listed under the scatter before the rest are summarised. */
const LEGEND_MAX = 12;

const AXIS_ABBR: Partial<Record<DrMethod, string>> = { pca: 'PC', whitened: 'PC', ica: 'IC', mnf: 'MNF', random: 'RP', kpca: 'KPC', isomap: 'Iso', diffusion: 'DC', tsne: 'tSNE' };

const selectClass = 'rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-sky-500 focus:outline-none';

function PcaSimVisual({ sim, species, colors, names, magnitude, threshold, onSelect, busy, colorBy, setColorBy, shapeBy, setShapeBy }: {
  sim: FieldSim;
  /** % of a pixel one cover must make up to count as pure (step 3's slider), for the purity tab's caption. */
  threshold: number;
  /** Colour and shape encodings, owned by the step so the resolution ladder uses the same ones. */
  colorBy: ColorBy; setColorBy: (c: ColorBy) => void;
  shapeBy: ShapeBy; setShapeBy: (s: ShapeBy) => void;
  /** Every species in the design, already padded and recoloured for drawing. */
  species: FieldParams[]; colors: string[]; names: string[];
  magnitude: number;
  /** Report the pixel indices selected in the scatter (click / lasso) → map highlight. */
  onSelect?: (indices: number[]) => void;
  /** True while the parent is recomputing the simulation → show a spinner. */
  busy?: boolean;
}) {
  // The chart's own view settings survive a refresh too; selection and lasso are
  // momentary and deliberately do not.
  const [tab, setTab] = usePersistentState<'scatter' | 'variance' | 'loadings' | 'purity'>('pcaTab', 'scatter', oneOf('scatter', 'variance', 'loadings', 'purity'));
  // Validated against the real list: an unknown method would make embed() throw.
  const [method, setMethodState] = usePersistentState<DrMethod>('pcaMethod', 'pca', v => DR_METHODS.some(m => m.id === v));
  const [pending, startTransition] = useTransition();
  // Switching the DR method re-embeds (slow for the nonlinear ones) — run it as a
  // transition so the spinner shows and the old chart stays until it's ready.
  const setMethod = (m: DrMethod) => startTransition(() => setMethodState(m));
  const working = !!busy || pending;
  // Up to 8 components now (a trial of S species has S-1 mixing directions);
  // cx/cy still clamp to what this fit actually produced.
  const isAxis = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 7;
  const [pcX, setPcX] = usePersistentState('pcaX', 0, isAxis);
  const [pcY, setPcY] = usePersistentState('pcaY', 1, isAxis);
  // Pixel selection (→ highlighted on the map). Click one, or lasso many.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lassoOn, setLassoOn] = useState(false);
  const pick = (ids: number[]) => { setSelected(new Set(ids)); onSelect?.(ids); };
  // Clear the selection whenever the underlying data changes.
  useEffect(() => { setSelected(new Set()); onSelect?.([]); }, [sim]); // eslint-disable-line react-hooks/exhaustive-deps

  const speciesSig = species.map(c => `${c.truth}_${c.L1}_${c.k1}_${c.x01}_${c.k2}_${c.x02}_${c.tc}_${c.color}`).join('|');

  /**
   * Seasons + embedding, once per (data, method). Axis and encoding changes are
   * cheap and never re-embed. Cached inside fitCover per simulation, so the
   * ladder's thumbnail at this resolution reads back this very object.
   */
  const fit = useMemo(() => fitCover(sim, species, magnitude, method), [sim, speciesSig, magnitude, method]); // eslint-disable-line react-hooks/exhaustive-deps

  const nComp = fit.explained.length;
  const abbr = AXIS_ABBR[method] ?? 'C';
  const ax = (i: number) => `${abbr}${i + 1}`;
  const axLabel = (i: number) => `${ax(i)} (${(fit.explained[i] ?? 0).toFixed(0)}%)`;
  const cx = Math.min(pcX, nComp - 1), cy = Math.min(pcY, nComp - 1);

  const hasSel = selected.size > 0;
  const points = useMemo(() => {
    // The shared orientation rule, so this chart and its thumbnail face the same way.
    const [sx, sy] = axisSigns(fit, cx, cy, species);
    return fit.pts.map(p => {
      const st = pointStyle(p, colorBy, shapeBy, colors, threshold);
      return { x: sx * (p.s[cx] ?? 0), y: sy * (p.s[cy] ?? 0), fr: p.fr, bare: p.bare, off: p.off, kind: st.kind, color: st.color, sym: st.sym, k: p.k, rim: st.rim };
    });
    // NOT keyed on the selection: selecting a point only redraws the canvas, it
    // never rebuilds these 20,000-odd encodings.
  }, [fit, cx, cy, colorBy, shapeBy, colors.join(','), threshold]); // eslint-disable-line react-hooks/exhaustive-deps
  const anyBare = points.some(p => p.kind === 'bare');
  const anyOff = points.some(p => p.kind === 'off');

  const varData = fit.explained.map((v, i) => ({ pc: ax(i), explained: +v.toFixed(1) }));
  const loadData = fit.loadings.length
    ? Array.from({ length: fit.loadings[0].length }, (_, t) => {
        const row: Record<string, number> = { t };
        fit.loadings.forEach((c, i) => { row[ax(i)] = +(c[t] ?? 0).toFixed(3); });
        return row;
      })
    : [];
  const loadColors = ['#38bdf8', '#f59e0b', '#a78bfa'];

  /**
   * Pure pixels per species, exactly as the engine counted them for the purity
   * percentages everywhere else: over the field's trial pixels, at the purity
   * threshold. Bare soil and mixed pixels complete the count, so the rows add up
   * to every trial pixel.
   */
  const purity = useMemo(() => {
    const rows = names.map((name, i) => ({ name, color: colors[i], count: sim.pureBySpecies[i] ?? 0 }));
    const pureCrop = rows.reduce((a, r) => a + r.count, 0);
    const mixed = Math.max(0, sim.total - pureCrop - sim.pureBare);
    const most = Math.max(1, ...rows.map(r => r.count), sim.pureBare, mixed);
    return { rows, pureCrop, pureBare: sim.pureBare, mixed, total: sim.total, most };
  }, [sim, names.join('|'), colors.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const pctOf = (n: number) => (purity.total ? `${((100 * n) / purity.total).toFixed(0)}%` : '');
  const purityRow = (key: string, label: string, color: string, count: number, muted = false) => (
    <div key={key} className="grid grid-cols-[minmax(0,8rem)_1fr_4.5rem] items-center gap-2 text-[11px]">
      <span className={`flex min-w-0 items-center gap-1.5 ${muted ? 'text-neutral-500' : 'text-neutral-300'}`}>
        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />
        <span className="truncate" title={label}>{label}</span>
      </span>
      <span className="h-2.5 overflow-hidden rounded-sm bg-white/[0.05]">
        <span className="block h-full rounded-sm" style={{ width: `${(100 * count) / purity.most}%`, background: color, opacity: muted ? 0.55 : 0.9 }} />
      </span>
      <span className="text-right font-mono tabular-nums text-neutral-300">
        {fmt(count)} <span className="text-neutral-500">{pctOf(count)}</span>
      </span>
    </div>
  );

  return (
    // Fragment (not a wrapper div) so the sticky chart's containing block is the
    // whole step — it stays pinned while the parameters below it scroll.
    <>
      {/* Chart stays pinned at the top so you keep an eye on it while editing the
          field / plant parameters that scroll underneath it. */}
      <div className="sticky top-0 z-20 -mx-4 space-y-2 bg-[#11151a] px-4 pb-2 pt-1 shadow-[0_10px_12px_-8px_rgba(0,0,0,0.8)]">
        <div className="flex items-center gap-1 border-b border-white/10 text-xs">
          {(['scatter', 'variance', 'loadings', 'purity'] as const).map(t => (
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
              {/* Say why the chart is empty. An unexplained blank panel reads as
                  a broken app; the real answer is that a finite trial can cover
                  only a handful of pixels in a large drawn area, and ground
                  outside it is not a sample of the experiment. */}
              {fit.tooFew > 0 && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 px-8 text-center text-[11px] leading-snug text-neutral-400">
                  <span className="text-neutral-300">
                    Only {fit.tooFew} pixel{fit.tooFew === 1 ? '' : 's'} sample{fit.tooFew === 1 ? 's' : ''} the trial here.
                  </span>
                  <span>Too few to embed. Ground outside the trial is not counted as data. Pick a finer sensor, or draw the area closer around the trial.</span>
                </div>
              )}
              <div style={{ opacity: working ? 0.45 : 1, transition: 'opacity 0.15s' }}>
                <PcaScatterCanvas points={points} selected={selected} height={280}
                  xLabel={axLabel(cx)} yLabel={axLabel(cy)} lassoOn={lassoOn} onPick={pick}
                  renderTooltip={p => {
                    const c = coverShares(p.fr, p.bare, p.off);
                    const parts = [
                      ...c.species.map((v, i) => ({ v, n: names[i] ?? `species ${i + 1}` })),
                      { v: c.bare, n: 'bare soil' },
                      { v: c.off, n: 'outside the trial' },
                    ]
                      .filter(e => e.v >= 0.005)
                      .sort((a, b) => b.v - a.v)
                      .slice(0, 4);
                    return parts.map((e, i) => <span key={i}>{i ? ' · ' : ''}{(e.v * 100).toFixed(0)}% {e.n}</span>);
                  }} />
              </div>
            </div>

            {/* One entry per species. The old key was a fixed triangle and
                square over two names, and a two-stop gradient: with four
                species it described a mixture that does not exist. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-neutral-400">
              {/* With shapes on, each key shows that species' SHAPE too: in the
                  pure/mixed colour mode the dots are green and red, and the shape
                  is the only thing left saying which species a dot is. */}
              {/* An imported trial can carry dozens of varieties. The key lists a
                  dozen and counts the rest; the Purity tab lists them all. */}
              {names.slice(0, names.length > LEGEND_MAX ? LEGEND_MAX - 1 : LEGEND_MAX).map((n, i) => (
                <span key={i} className="flex items-center gap-1">
                  {shapeBy === 'species'
                    ? <SymbolIcon type={SYMS[i % SYMS.length]} color={colorBy === 'species' ? colors[i] : '#94a3b8'} />
                    : <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colors[i] }} />}
                  {n}
                </span>
              ))}
              {/* Keyed in EVERY colour mode: the mixing blend now carries bare
                  soil and off-trial ground too, so brown and grey dots appear
                  there as well. One swatch per kind actually on the chart. */}
              {names.length > LEGEND_MAX && (
                <button type="button" onClick={() => setTab('purity')} className="text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline">
                  + {names.length - (LEGEND_MAX - 1)} more
                </button>
              )}
              {anyBare && (
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BARE.color }} />
                  mostly bare soil
                </span>
              )}
              {anyOff && (
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm border border-slate-400" style={{ background: OFF_TRIAL.color }} />
                  mostly outside the trial
                </span>
              )}
              {names.length > SYMS.length && shapeBy === 'species' && (
                <span className="text-neutral-500">shapes repeat past {SYMS.length} species; colour is the key</span>
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

        {tab === 'purity' && (
          <div className="rounded-md border border-white/10 bg-black/30 p-2" style={{ opacity: working ? 0.45 : 1, transition: 'opacity 0.15s' }}>
            {purity.total ? (
              <>
                {/* Scrolls past about a dozen rows, so an imported trial with dozens
                    of varieties does not push the chart off its pinned place. */}
                <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                  {purity.rows.map((r, i) => purityRow(`s${i}`, r.name, r.color, r.count))}
                </div>
                <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2">
                  {purityRow('bare', 'pure bare soil', BARE.color, purity.pureBare, true)}
                  {purityRow('mixed', 'mixed', '#64748b', purity.mixed, true)}
                </div>
                <p className="mt-2 text-[11px] text-neutral-500">
                  <span className="text-neutral-300">{fmt(purity.pureCrop)}</span> of {fmt(purity.total)} trial pixels are one pure species ({pctOf(purity.pureCrop)}).
                  Pure: at least {threshold}% one cover.
                </p>
              </>
            ) : (
              <p className="text-[11px] text-neutral-500">No pixel samples the trial at this size.</p>
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
                <option value="purity">pure / mixed (at {threshold}%)</option>
              </select>
            </label>
            <label className="flex items-center gap-1">Shape
              <select className={selectClass} value={shapeBy} onChange={e => setShapeBy(e.target.value as ShapeBy)}>
                <option value="species">species</option>
                <option value="purity">pure / mixed (at {threshold}%)</option>
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
// speciesD / colors / names, the setSelectedPixels setter).
export default memo(PcaSimVisual);
