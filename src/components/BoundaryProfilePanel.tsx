import React, { useMemo, useState } from 'react';
import { X, Download } from 'lucide-react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { ZoneExtraction } from '../lib/zones';
import { computeBoundaryProfile, profileToCsv, ProfileValue } from '../lib/boundary-profile';
import { Stat } from './ui';

/**
 * Boundary-profile drawer: the population edge-response curve, pooled over
 * every boundary transect by signed distance to the field edge. All controls
 * live on the chart.
 */

interface Props {
  zones: ZoneExtraction;
  onClose: () => void;
}

export default function BoundaryProfilePanel({ zones, onClose }: Props) {
  const [value, setValue] = useState<ProfileValue>('mean');
  const [date, setDate] = useState(zones.dates[Math.floor(zones.dates.length / 2)] ?? zones.dates[0]);
  const [groupBy, setGroupBy] = useState<'none' | 'class'>('none');
  const [binWidth, setBinWidth] = useState(5);
  const hasMixing = (zones.unmixing?.count ?? 0) > 0;

  const profile = useMemo(() => {
    try {
      return computeBoundaryProfile(zones, { value, date, groupBy, binWidth });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [zones, value, date, groupBy, binWidth]);

  // Merge the series onto one distance axis for a multi-band chart.
  const chartData = useMemo(() => {
    if (typeof profile === 'string') return [];
    const byCenter = new Map<number, Record<string, any>>();
    for (const s of profile.series) {
      for (const b of s.bins) {
        const row = byCenter.get(b.center) ?? { center: b.center };
        row[`${s.group}_mean`] = b.mean;
        row[`${s.group}_band`] = [b.mean - b.ci, b.mean + b.ci];
        byCenter.set(b.center, row);
      }
    }
    return Array.from(byCenter.values()).sort((a, b) => a.center - b.center);
  }, [profile]);

  const exportCsv = () => {
    if (typeof profile === 'string') return;
    const blob = new Blob([profileToCsv(profile)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `boundary_profile_${value}.csv`;
    a.click();
  };

  const axisProps = { tick: { fill: '#64748b', fontSize: 11 }, stroke: '#ffffff22' } as const;

  return (
    <div className="absolute inset-y-0 right-0 z-[1100] flex w-[640px] max-w-full flex-col border-l border-white/10 bg-[#0d1117f5] backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Boundary profile</h2>
          <p className="text-[11px] text-slate-500">
            edge-response curve · {zones.metric} · pooled over every boundary by distance to the field edge
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCsv} className="rounded-md border border-white/10 p-1.5 text-slate-400 hover:text-slate-200" title="Export the binned profile (CSV)">
            <Download className="h-4 w-4" />
          </button>
          <button onClick={onClose} className="rounded-md border border-white/10 p-1.5 text-slate-400 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* controls */}
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <label className="flex items-center gap-1.5">
            Value
            <select className={selectClass} value={value} onChange={e => setValue(e.target.value as ProfileValue)}>
              <option value="mean">mean {zones.metric}</option>
              <option value="date">{zones.metric} on a date</option>
              <option value="amplitude">{zones.metric} amplitude</option>
              {hasMixing && <option value="mixing">species-A fraction</option>}
            </select>
          </label>
          {value === 'date' && (
            <label className="flex items-center gap-1.5">
              Date
              <select className={selectClass} value={date} onChange={e => setDate(e.target.value)}>
                {zones.dates.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-1.5">
            Split
            <select className={selectClass} value={groupBy} onChange={e => setGroupBy(e.target.value as 'none' | 'class')}>
              <option value="none">pooled</option>
              <option value="class">by pixel class</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Bin (m)
            <select className={selectClass} value={binWidth} onChange={e => setBinWidth(Number(e.target.value))}>
              {[2, 5, 10, 20].map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
        </div>

        {typeof profile === 'string' ? (
          <div className="py-10 text-center text-xs text-amber-400/90">{profile}</div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={chartData} margin={{ top: 10, right: 12, bottom: 18, left: 0 }}>
                <CartesianGrid stroke="#ffffff12" />
                <XAxis
                  type="number"
                  dataKey="center"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v: number) => `${v}`}
                  label={{ value: 'distance to boundary (m) — negative = gap, positive = inside', position: 'insideBottom', offset: -10, fill: '#94a3b8', fontSize: 11 }}
                  {...axisProps}
                />
                <YAxis {...axisProps} />
                <Tooltip
                  contentStyle={{ background: '#11151a', border: '1px solid #ffffff1a', borderRadius: 6, fontSize: 11 }}
                  labelFormatter={(v: any) => `${v} m from boundary`}
                  formatter={(val: any, name: string) =>
                    Array.isArray(val) ? null : [typeof val === 'number' ? val.toFixed(3) : val, name.replace(/_mean$/, '')]
                  }
                />
                {/* boundary + interior reference */}
                <ReferenceLine x={0} stroke="#ffffff55" strokeDasharray="3 3" label={{ value: 'boundary', fill: '#94a3b8', fontSize: 10, position: 'top' }} />
                {isFinite(profile.interior) && (
                  <ReferenceLine y={profile.interior} stroke="#34d39988" strokeDasharray="4 4" label={{ value: 'interior', fill: '#34d399', fontSize: 10, position: 'right' }} />
                )}
                {profile.deiMeters != null && (
                  <ReferenceLine x={profile.deiMeters} stroke="#f8717188" strokeDasharray="2 4" label={{ value: 'DEI', fill: '#f87171', fontSize: 10, position: 'top' }} />
                )}
                {profile.series.map(s => (
                  <Area
                    key={`${s.group}_band`}
                    dataKey={`${s.group}_band`}
                    stroke="none"
                    fill={s.color}
                    fillOpacity={0.14}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
                {profile.series.map(s => (
                  <Line
                    key={`${s.group}_mean`}
                    type="monotone"
                    dataKey={`${s.group}_mean`}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>

            {groupBy === 'class' && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
                {profile.series.map(s => (
                  <span key={s.group} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-3 grid grid-cols-3 gap-2">
              <Stat
                label="Depth of edge influence"
                value={profile.deiMeters != null ? `${profile.deiMeters.toFixed(0)} m` : 'none'}
                accent="#f87171"
              />
              <Stat
                label="Magnitude (MEI)"
                value={profile.mei != null ? profile.mei.toFixed(3) : '—'}
              />
              <Stat label="Edge − interior" value={profile.meanDiff != null ? profile.meanDiff.toFixed(3) : '—'} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              {profile.totalPixels.toLocaleString()} pixels pooled. <span className="text-slate-400">DEI</span> is how far
              inside the field the value stays distinguishable from the deep-interior level (95% CIs); <span className="text-slate-400">MEI</span>{' '}
              = (edge − interior)/(edge + interior). Part of the near-boundary gradient is the 10 m sensor footprint, not
              a true field effect — compare the <em>interior-only</em> trend and the species-A-fraction curve to judge how
              much.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const selectClass = 'rounded-md border border-white/10 bg-[#0b0e11] px-2 py-1 text-xs text-slate-300 focus:outline-none';
