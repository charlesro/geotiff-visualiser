import React from 'react';
import { X, Loader2 } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import { NdviInspection } from '../lib/ndvi-series';

/**
 * Floating panel showing the NDVI time series of one inspected polygon,
 * one mean line per pixel zone (interior + the three edge classes).
 */

const ZONE_STYLE: { key: string; label: string; color: string }[] = [
  { key: 'interior', label: 'Interior', color: '#34d399' },
  { key: 'edge_other_species', label: 'Edge · other species', color: '#f87171' },
  { key: 'edge_same_species', label: 'Edge · same species', color: '#fbbf24' },
  { key: 'edge_isolated', label: 'Edge · isolated', color: '#94a3b8' },
];

interface NdviPanelProps {
  inspection: NdviInspection | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
}

export default function NdviPanel({ inspection, busy, error, onClose }: NdviPanelProps) {
  if (!inspection && !busy && !error) return null;

  return (
    <div className="absolute right-3 top-14 z-[1100] w-[26rem] max-w-[calc(100%-1.5rem)] rounded-lg border border-white/10 bg-[#11151af2] p-3 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-slate-200">
            {busy ? 'Extracting pixels…' : inspection ? inspection.label : 'NDVI inspector'}
          </div>
          {inspection && !busy && (
            <div className="text-[11px] text-slate-500">
              {inspection.metric} mean per zone · {inspection.distance} m split ·{' '}
              {inspection.counts.interior + inspection.counts.other + inspection.counts.same + inspection.counts.isolated}{' '}
              px
            </div>
          )}
        </div>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      {busy && (
        <div className="flex h-48 items-center justify-center text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {!busy && error && <div className="py-6 text-center text-xs text-red-400">{error}</div>}

      {!busy && !error && inspection && (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={inspection.series} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="#ffffff14" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fill: '#64748b', fontSize: 10 }}
                tickFormatter={(d: string) => d.slice(5)}
                stroke="#ffffff22"
              />
              <YAxis domain={[-0.2, 1]} tick={{ fill: '#64748b', fontSize: 10 }} stroke="#ffffff22" />
              <Tooltip
                contentStyle={{
                  background: '#1a2027',
                  border: '1px solid #ffffff1a',
                  borderRadius: 6,
                  fontSize: 11,
                }}
                labelStyle={{ color: '#e2e8f0' }}
                formatter={(value: any) => (typeof value === 'number' ? value.toFixed(3) : value)}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {ZONE_STYLE.filter(z => inspection.series.some(p => (p as any)[z.key] !== undefined)).map(z => (
                <Line
                  key={z.key}
                  type="monotone"
                  dataKey={z.key}
                  name={z.label}
                  stroke={z.color}
                  strokeWidth={2}
                  dot={{ r: 2.5, fill: z.color, strokeWidth: 0 }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
