import React, { useMemo, useState } from 'react';
import { X, Download } from 'lucide-react';
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
} from 'recharts';
import { PcaRunResult } from '../lib/pca';
import { isTsColumn } from '../lib/timeseries';
import { cn } from '../lib/utils';

/**
 * Results drawer: PC scatter plot (colourable by zone, polygon or any
 * categorical attribute), explained variance, and component loadings over
 * the acquisition dates.
 */

const PALETTE = ['#34d399', '#fbbf24', '#38bdf8', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#f87171', '#a3e635', '#e879f9'];
const ZONE_COLOR: Record<string, string> = { interior: '#34d399', edge: '#fbbf24' };

const EXCLUDED_ATTRS = new Set(['id', '__pid', 'zone', 'polygon_id', 'type']);

interface PcaPanelProps {
  result: PcaRunResult;
  onClose: () => void;
  onExportCsv: () => void;
}

export default function PcaPanel({ result, onClose, onExportCsv }: PcaPanelProps) {
  const [tab, setTab] = useState<'scatter' | 'variance' | 'loadings'>('scatter');
  const [pcX, setPcX] = useState(0);
  const [pcY, setPcY] = useState(1);
  const [colorBy, setColorBy] = useState('zone');

  const colorOptions = useMemo(() => {
    const options = ['zone', 'polygon'];
    const counts = new Map<string, Set<string>>();
    for (const row of result.rows) {
      for (const [key, value] of Object.entries(row.properties)) {
        if (EXCLUDED_ATTRS.has(key) || isTsColumn(key)) continue;
        if (typeof value !== 'string' && typeof value !== 'boolean') continue;
        if (!counts.has(key)) counts.set(key, new Set());
        counts.get(key)!.add(String(value));
      }
    }
    for (const [key, values] of counts) {
      if (values.size >= 2 && values.size <= 12) options.push(key);
    }
    return options;
  }, [result]);

  const categoryOf = (row: PcaRunResult['rows'][number]): string => {
    if (colorBy === 'zone') return row.zone;
    if (colorBy === 'polygon') return String(row.polygonId ?? 'unknown');
    return String(row.properties[colorBy] ?? 'unknown');
  };

  const groups = useMemo(() => {
    const map = new Map<string, { x: number; y: number; pixelId: string }[]>();
    for (const row of result.rows) {
      const cat = categoryOf(row);
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push({ x: row.scores[pcX], y: row.scores[pcY], pixelId: row.pixelId });
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [result, pcX, pcY, colorBy]);

  const groupColor = (name: string, index: number): string =>
    colorBy === 'zone' ? ZONE_COLOR[name] || PALETTE[index % PALETTE.length] : PALETTE[index % PALETTE.length];

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

  return (
    <div className="absolute inset-y-0 right-0 z-[1100] flex w-[620px] max-w-full flex-col border-l border-white/10 bg-[#0d1117f5] backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">PCA results</h2>
          <p className="text-[11px] text-slate-500">
            {result.rows.length} pixels · {result.metric} · {result.dates.length} dates ·{' '}
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
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
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
                Colour by
                <select className={selectClass} value={colorBy} onChange={e => setColorBy(e.target.value)}>
                  {colorOptions.map(opt => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ResponsiveContainer width="100%" height={460}>
              <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid stroke="#ffffff14" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={pcLabel(pcX)}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  label={{ value: pcLabel(pcX), position: 'insideBottom', offset: -5, fill: '#94a3b8', fontSize: 12 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={pcLabel(pcY)}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  label={{ value: pcLabel(pcY), angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 12 }}
                />
                <ZAxis range={[18, 18]} />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3', stroke: '#475569' }}
                  contentStyle={{ background: '#11151a', border: '1px solid #ffffff1a', borderRadius: 6, fontSize: 11 }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {groups.map(([name, points], i) => (
                  <Scatter key={name} name={`${name} (${points.length})`} data={points} fill={groupColor(name, i)} isAnimationActive={false} />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
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
                    stroke={PALETTE[(c + 2) % PALETTE.length]}
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
