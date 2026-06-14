import React, { useMemo, useState } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  CartesianGrid,
  Symbols,
} from 'recharts';
import { PcaRunResult } from '../lib/pca';
import { PixelZone } from '../lib/zones';
import { CLUSTER_COLORS, fieldKeyOf } from '../lib/species-clusters';
import { mixHexColors } from '../lib/unmix';
import { ZONE_CLASSES, ZONE_COLOR, zoneColor, speciesColor, categoricalColor, NEUTRAL } from '../lib/legend';
import { cn } from '../lib/utils';

/**
 * Results drawer — the working surface for the PCA. The scatter is fully
 * driven from here: which pixel classes are projected, a colour encoding and
 * a shape encoding (two attributes visible at once), and point picking that
 * highlights the corresponding pixel on the map.
 */

const ZONE_CHIPS = ZONE_CLASSES.map(z => ({ key: z.key, label: z.short }));

type SymbolType = 'circle' | 'triangle' | 'square' | 'diamond' | 'star' | 'cross' | 'wye';
const SYMBOL_TYPES: SymbolType[] = ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'wye'];

type Attr = 'zone' | 'species' | 'scenario' | 'field' | 'pair' | 'mixing';
const ATTR_LABEL: Record<Attr, string> = {
  zone: 'pixel class',
  species: 'species',
  scenario: 'scenario',
  field: 'field',
  pair: 'pair',
  mixing: 'species mix',
};

/** Keep the scatter responsive — evenly sampled above this. */
const MAX_POINTS = 4000;

export interface PcaPickedPixel {
  id: string;
  zone: PixelZone;
  lng: number;
  lat: number;
}

interface PcaPanelProps {
  result: PcaRunResult;
  busy: boolean;
  /** Drawer width (px) — drag the left edge to change it. */
  width: number;
  onWidthChange: (w: number) => void;
  /** Field key → scenario index, from step 4 (null = not clustered). */
  clusterAssignment: Map<string, number> | null;
  /** Classes projected in the space — editable right here. */
  projectZones: PixelZone[];
  onProjectZonesChange: (zones: PixelZone[]) => void;
  /** Point picked in the scatter, mirrored as a ring on the map. */
  highlightPixelId: string | null;
  onPickPixel: (pixel: PcaPickedPixel | null) => void;
  onClose: () => void;
  onExportCsv: () => void;
}

export default function PcaPanel({
  result,
  busy,
  width,
  onWidthChange,
  clusterAssignment,
  projectZones,
  onProjectZonesChange,
  highlightPixelId,
  onPickPixel,
  onClose,
  onExportCsv,
}: PcaPanelProps) {
  const [tab, setTab] = useState<'scatter' | 'variance' | 'loadings'>('scatter');
  const [pcX, setPcX] = useState(0);
  const [pcY, setPcY] = useState(1);
  const [colorBy, setColorBy] = useState<Attr>('zone');
  const [shapeBy, setShapeBy] = useState<Attr | 'none'>('species');

  const hasPairs = useMemo(() => result.rows.some(r => r.properties?.pair_id != null), [result]);
  const hasMixing = useMemo(() => result.rows.some(r => typeof r.properties?.mix_frac_a === 'number'), [result]);
  // The two species defining the mix axis (from any unmixed pixel).
  const mixAxis = useMemo(() => {
    const r = result.rows.find(r => typeof r.properties?.mix_frac_a === 'number');
    return r ? { a: String(r.properties.mix_a_species), b: String(r.properties.mix_b_species) } : null;
  }, [result]);
  const attrOptions = useMemo(() => {
    const opts: Attr[] = ['zone', 'species'];
    if (clusterAssignment) opts.push('scenario');
    opts.push('field');
    if (hasPairs) opts.push('pair');
    if (hasMixing) opts.push('mixing');
    return opts;
  }, [clusterAssignment, hasPairs, hasMixing]);
  // Shapes are categorical; the continuous mixing fraction can only colour.
  const shapeOptions = useMemo(() => attrOptions.filter(a => a !== 'mixing'), [attrOptions]);

  const attrValue = useMemo(
    () =>
      (row: PcaRunResult['rows'][number], attr: Attr): string => {
        const props = row.properties || {};
        switch (attr) {
          case 'zone':
            return row.zone;
          case 'species':
            return String(props.crp_lbl ?? props.species ?? 'unknown');
          case 'scenario': {
            const c = clusterAssignment?.get(fieldKeyOf(props));
            return c !== undefined ? `scenario ${c + 1}` : 'unclustered';
          }
          case 'field':
            return String(props.NewID ?? row.polygonId ?? 'unknown');
          case 'pair':
            return props.pair_id != null ? String(props.pair_id) : 'no pair';
          case 'mixing':
            return ''; // continuous — coloured per point, no categories
        }
      },
    [clusterAssignment]
  );

  /** Ordered categories of an attribute with their counts over all rows. */
  const categoriesOf = (attr: Attr): { name: string; count: number }[] => {
    const counts = new Map<string, number>();
    for (const row of result.rows) {
      const v = attrValue(row, attr);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([name, count]) => ({ name, count }));
  };

  const colorCats = useMemo(() => (colorBy === 'mixing' ? [] : categoriesOf(colorBy)), [result, colorBy, attrValue]);
  const shapeCats = useMemo(
    () => (shapeBy === 'none' ? [] : categoriesOf(shapeBy)),
    [result, shapeBy, attrValue]
  );

  const colorOf = (attr: Attr, name: string, index: number): string => {
    if (attr === 'zone') return zoneColor(name);
    if (attr === 'species') return speciesColor(name);
    if (attr === 'scenario') {
      if (name === 'unclustered') return NEUTRAL;
      const n = Number(name.split(' ')[1]) - 1;
      return CLUSTER_COLORS[n % CLUSTER_COLORS.length];
    }
    return categoricalColor(index);
  };

  const points = useMemo(() => {
    let rows =
      result.rows.length > MAX_POINTS
        ? Array.from({ length: MAX_POINTS }, (_, i) => result.rows[Math.floor((i * result.rows.length) / MAX_POINTS)])
        : result.rows;
    // Always include the highlighted pixel (e.g. picked on the map) so its
    // ring shows even when the scatter is sub-sampled.
    if (highlightPixelId && !rows.some(r => r.pixelId === highlightPixelId)) {
      const sel = result.rows.find(r => r.pixelId === highlightPixelId);
      if (sel) rows = [...rows, sel];
    }
    const colorIdx = new Map(colorCats.map((c, i) => [c.name, i]));
    const shapeIdx = new Map(shapeCats.map((c, i) => [c.name, i]));
    return rows.map(row => {
      const cv = attrValue(row, colorBy);
      const sv = shapeBy === 'none' ? null : attrValue(row, shapeBy);
      // Mixing: continuous scale on the own-field fraction; pixels with no
      // fraction (interior, isolated…) stay muted so the mixed ones stand out.
      let color: string;
      if (colorBy === 'mixing') {
        const frac = row.properties?.mix_frac_a;
        color =
          typeof frac === 'number' && mixAxis
            ? mixHexColors(speciesColor(mixAxis.b), speciesColor(mixAxis.a), frac)
            : '#334155';
      } else {
        color = colorOf(colorBy, cv, colorIdx.get(cv) ?? 0);
      }
      return {
        x: row.scores[pcX],
        y: row.scores[pcY],
        pixelId: row.pixelId,
        color,
        symbol: (sv === null ? 'circle' : SYMBOL_TYPES[(shapeIdx.get(sv) ?? 0) % SYMBOL_TYPES.length]) as SymbolType,
        row,
      };
    });
  }, [result, pcX, pcY, colorBy, shapeBy, colorCats, shapeCats, attrValue, mixAxis, highlightPixelId]);

  const pick = (p: (typeof points)[number]) => {
    if (highlightPixelId === p.pixelId) onPickPixel(null);
    else onPickPixel({ id: p.pixelId, zone: p.row.zone, lng: p.row.lng, lat: p.row.lat });
  };

  const pickedRow = useMemo(
    () => (highlightPixelId ? result.rows.find(r => r.pixelId === highlightPixelId) || null : null),
    [highlightPixelId, result]
  );

  // Drag the drawer's left edge to resize it (the map gets the rest).
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const w = Math.round(window.innerWidth - ev.clientX);
      onWidthChange(Math.max(440, Math.min(window.innerWidth - 320, w)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Equal scale on both axes (same units per pixel), so distances in the
  // scatter are honest: the domains are centred on the data and sized from
  // the larger spread, corrected by the plot's width/height ratio.
  const CHART_W = width - 40; // p-4 padding + border
  const CHART_H = 470;
  const Y_AXIS_W = 60;
  const X_AXIS_H = 40;
  const plotW = CHART_W - 10 - Y_AXIS_W; // margins: right 10, left 0
  const plotH = CHART_H - 10 - 10 - X_AXIS_H; // margins: top 10, bottom 10
  const plotAspect = plotW / plotH;
  const domains = useMemo(() => {
    if (points.length === 0) return { x: [0, 1] as [number, number], y: [0, 1] as [number, number] };
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of points) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    const ry = Math.max((yMax - yMin) / 2, (xMax - xMin) / 2 / plotAspect, 1e-6) * 1.08;
    const rx = ry * plotAspect;
    return { x: [cx - rx, cx + rx] as [number, number], y: [cy - ry, cy + ry] as [number, number] };
  }, [points, plotAspect]);

  const toggleProjected = (zone: PixelZone) => {
    if (projectZones.includes(zone)) {
      if (projectZones.length === 1) return; // keep at least one class in the space
      onProjectZonesChange(projectZones.filter(z => z !== zone));
    } else {
      onProjectZonesChange([...projectZones, zone]);
    }
  };

  const renderPoint = (props: any) => {
    const { cx, cy, payload } = props;
    if (typeof cx !== 'number' || typeof cy !== 'number') return <g />;
    const selected = payload.pixelId === highlightPixelId;
    return (
      <g onClick={() => pick(payload)} style={{ cursor: 'pointer' }}>
        {selected && <circle cx={cx} cy={cy} r={9} fill="none" stroke="#ffffff" strokeWidth={2} />}
        <Symbols
          cx={cx}
          cy={cy}
          type={payload.symbol}
          size={selected ? 90 : 32}
          fill={payload.color}
          fillOpacity={selected ? 1 : 0.8}
        />
      </g>
    );
  };

  const varianceData = result.explained.map((v, i) => ({
    pc: `PC${i + 1}`,
    explained: Number(v.toFixed(2)),
    cumulative: Number(result.cumulative[i].toFixed(2)),
  }));

  const loadingsData = result.dates.map((date, i) => {
    const entry: Record<string, any> = { date };
    result.loadings.forEach((component, c) => {
      entry[`PC${c + 1}`] = Number(component[i]?.toFixed(4));
    });
    return entry;
  });

  const pcLabel = (i: number) => `PC${i + 1} (${result.explained[i].toFixed(1)}%)`;
  const selectClass =
    'rounded-md border border-white/10 bg-[#0b0e11] px-2 py-1 text-xs text-slate-300 focus:outline-none';

  const pickedLabel = (row: PcaRunResult['rows'][number]): string => {
    const props = row.properties || {};
    const species = props.crp_lbl ?? props.species;
    return species && props.NewID !== undefined ? `${species} · ${props.NewID}` : String(row.polygonId ?? row.pixelId);
  };

  return (
    <div
      className="absolute inset-y-0 right-0 z-[1100] flex max-w-full flex-col border-l border-white/10 bg-[#0d1117f5] backdrop-blur"
      style={{ width }}
    >
      <div
        onPointerDown={startResize}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-sky-500/40"
        title="Drag to resize"
      />
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            PCA results
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />}
          </h2>
          <p className="text-[11px] text-slate-500">
            axes fit on {result.fitCount} px (
            {result.fitZones.map(z => ZONE_CHIPS.find(c => c.key === z)?.label ?? z).join(', ')}) ·{' '}
            {result.rows.length} px placed · {result.metric} · {result.dates.length} dates ·{' '}
            {result.cumulative[result.components - 1]?.toFixed(1)}% variance in {result.components} PCs
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onExportCsv} className="rounded-md border border-white/10 p-1.5 text-slate-400 hover:text-slate-200">
            <Download className="h-4 w-4" />
          </button>
          <button onClick={onClose} className="rounded-md border border-white/10 p-1.5 text-slate-400 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex border-b border-white/10 text-xs">
        {(['scatter', 'variance', 'loadings'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-2 capitalize transition-colors',
              tab === t ? 'border-b-2 border-sky-500 text-sky-300' : 'text-slate-500 hover:text-slate-300'
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'scatter' && (
          <>
            {/* Projected classes — live, re-runs the projection */}
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Projected</span>
              {ZONE_CHIPS.map(z => {
                const active = projectZones.includes(z.key);
                return (
                  <button
                    key={z.key}
                    onClick={() => toggleProjected(z.key)}
                    disabled={busy}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                      active
                        ? 'border-white/30 bg-white/10 text-slate-200'
                        : 'border-white/10 text-slate-600 hover:text-slate-400'
                    )}
                  >
                    <span
                      className={cn('h-1.5 w-1.5 rounded-full', !active && 'opacity-30')}
                      style={{ background: ZONE_COLOR[z.key] }}
                    />
                    {z.label}
                  </button>
                );
              })}
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <label className="flex items-center gap-1.5">
                X
                <select className={selectClass} value={pcX} onChange={e => setPcX(Number(e.target.value))}>
                  {result.explained.map((_, i) => (
                    <option key={i} value={i}>{`PC${i + 1}`}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                Y
                <select className={selectClass} value={pcY} onChange={e => setPcY(Number(e.target.value))}>
                  {result.explained.map((_, i) => (
                    <option key={i} value={i}>{`PC${i + 1}`}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                Colour
                <select className={selectClass} value={colorBy} onChange={e => setColorBy(e.target.value as Attr)}>
                  {attrOptions.map(a => (
                    <option key={a} value={a}>
                      {ATTR_LABEL[a]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                Shape
                <select
                  className={selectClass}
                  value={shapeBy}
                  onChange={e => setShapeBy(e.target.value as Attr | 'none')}
                >
                  <option value="none">none</option>
                  {shapeOptions
                    .filter(a => a !== colorBy)
                    .map(a => (
                      <option key={a} value={a}>
                        {ATTR_LABEL[a]}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            <ScatterChart width={CHART_W} height={CHART_H} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid stroke="#ffffff14" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={pcLabel(pcX)}
                  domain={domains.x}
                  height={X_AXIS_H}
                  tickFormatter={(v: number) => v.toFixed(2)}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  label={{ value: pcLabel(pcX), position: 'insideBottom', offset: -5, fill: '#94a3b8', fontSize: 12 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={pcLabel(pcY)}
                  domain={domains.y}
                  width={Y_AXIS_W}
                  tickFormatter={(v: number) => v.toFixed(2)}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  label={{ value: pcLabel(pcY), angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 12 }}
                />
                <ZAxis range={[32, 32]} />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3', stroke: '#475569' }}
                  content={({ payload }) => {
                    const p = payload?.[0]?.payload;
                    if (!p) return null;
                    return (
                      <div className="rounded-md border border-white/10 bg-[#11151a] px-2 py-1 text-[11px] text-slate-300">
                        <div>{pickedLabel(p.row)}</div>
                        <div className="text-slate-500">
                          {p.row.zone} · {p.x.toFixed(3)}, {p.y.toFixed(3)} · click to locate
                        </div>
                      </div>
                    );
                  }}
                />
                <Scatter data={points} shape={renderPoint} isAnimationActive={false} />
            </ScatterChart>

            {/* Colour legend */}
            {colorBy === 'mixing' ? (
              <div className="mt-2 text-[11px] text-slate-400">
                <span className="mr-2 font-medium uppercase tracking-wide text-slate-600">species mix</span>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[10px]">{mixAxis?.b}</span>
                  <div
                    className="h-2 flex-1 rounded"
                    style={{
                      background: mixAxis
                        ? `linear-gradient(to right, ${speciesColor(mixAxis.b)}, ${speciesColor(mixAxis.a)})`
                        : undefined,
                    }}
                  />
                  <span className="text-[10px]">{mixAxis?.a}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-slate-600">
                  edge-other pixels only; interior / isolated / same-species shown muted
                </div>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                <span className="font-medium uppercase tracking-wide text-slate-600">{ATTR_LABEL[colorBy]}</span>
                {colorCats.slice(0, 14).map((c, i) => (
                  <span key={c.name} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: colorOf(colorBy, c.name, i) }} />
                    {c.name} ({c.count})
                  </span>
                ))}
                {colorCats.length > 14 && <span className="text-slate-600">+{colorCats.length - 14} more</span>}
              </div>
            )}

            {/* Shape legend */}
            {shapeBy !== 'none' && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                <span className="font-medium uppercase tracking-wide text-slate-600">{ATTR_LABEL[shapeBy]}</span>
                {shapeCats.slice(0, SYMBOL_TYPES.length).map((c, i) => (
                  <span key={c.name} className="flex items-center gap-1.5">
                    <svg width={12} height={12}>
                      <Symbols cx={6} cy={6} type={SYMBOL_TYPES[i % SYMBOL_TYPES.length]} size={42} fill="#cbd5e1" />
                    </svg>
                    {c.name} ({c.count})
                  </span>
                ))}
                {shapeCats.length > SYMBOL_TYPES.length && (
                  <span className="text-amber-400/80">
                    +{shapeCats.length - SYMBOL_TYPES.length} more — only {SYMBOL_TYPES.length} shapes exist, pick a
                    coarser attribute
                  </span>
                )}
              </div>
            )}

            {result.rows.length > MAX_POINTS && (
              <p className="mt-1 text-[10px] text-slate-600">
                showing {MAX_POINTS} of {result.rows.length} points (evenly sampled)
              </p>
            )}

            {/* Picked point */}
            {pickedRow && (
              <div className="mt-2 rounded-md border border-white/15 bg-white/[0.04] px-3 py-2 text-[11px] text-slate-300">
                <div className="mb-0.5 flex items-center justify-between">
                  <span className="font-medium text-slate-200">{pickedLabel(pickedRow)}</span>
                  <button onClick={() => onPickPixel(null)} className="text-slate-500 hover:text-slate-300">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-slate-400">
                  <span>class: {pickedRow.zone}</span>
                  {pickedRow.properties?.pair_id != null && <span>pair: {String(pickedRow.properties.pair_id)}</span>}
                  {clusterAssignment && <span>{attrValue(pickedRow, 'scenario')}</span>}
                  <span>
                    {pickedRow.lat.toFixed(5)}, {pickedRow.lng.toFixed(5)}
                  </span>
                  {typeof pickedRow.properties?.mix_frac_a === 'number' && (
                    <span className="col-span-2 text-slate-300">
                      mix: {(pickedRow.properties.mix_frac_a * 100).toFixed(0)}% {pickedRow.properties.mix_a_species} ·{' '}
                      {((1 - pickedRow.properties.mix_frac_a) * 100).toFixed(0)}% {pickedRow.properties.mix_b_species}
                    </span>
                  )}
                  <span className="col-span-2">
                    scores: {pickedRow.scores.map((s, i) => `PC${i + 1} ${s.toFixed(3)}`).join(' · ')}
                  </span>
                </div>
                <div className="mt-1 text-slate-500">The white ring on the map marks this pixel.</div>
              </div>
            )}
          </>
        )}

        {tab === 'variance' && (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={varianceData} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid stroke="#ffffff14" vertical={false} />
                <XAxis dataKey="pc" tick={{ fill: '#64748b', fontSize: 11 }} />
                <YAxis unit="%" tick={{ fill: '#64748b', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#11151a', border: '1px solid #ffffff1a', borderRadius: 6, fontSize: 11 }} />
                <Bar dataKey="explained" name="Explained variance" fill="#38bdf8" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
            <table className="mt-4 w-full text-left text-xs text-slate-400">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1.5 font-medium">Component</th>
                  <th className="py-1.5 text-right font-medium">Explained</th>
                  <th className="py-1.5 text-right font-medium">Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {varianceData.map(row => (
                  <tr key={row.pc} className="border-t border-white/5">
                    <td className="py-1.5">{row.pc}</td>
                    <td className="py-1.5 text-right">{row.explained}%</td>
                    <td className="py-1.5 text-right">{row.cumulative}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {tab === 'loadings' && (
          <>
            <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
              Loadings show how much each acquisition date contributes to a component — peaks identify the periods
              that drive the variance between pixels.
            </p>
            <ResponsiveContainer width="100%" height={380}>
              <LineChart data={loadingsData} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid stroke="#ffffff14" />
                <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} angle={-35} textAnchor="end" height={55} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#11151a', border: '1px solid #ffffff1a', borderRadius: 6, fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {result.loadings.map((_, c) => (
                  <Line
                    key={c}
                    type="monotone"
                    dataKey={`PC${c + 1}`}
                    stroke={categoricalColor(c)}
                    dot={false}
                    strokeWidth={1.8}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
    </div>
  );
}
