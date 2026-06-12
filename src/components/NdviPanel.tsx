import React, { useEffect, useMemo, useState } from 'react';
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
import { NdviInspection, NdviPixel } from '../lib/ndvi-series';
import { cn } from '../lib/utils';

/**
 * Floating panel showing the NDVI time series of one inspected polygon —
 * either the mean per pixel zone or one curve per pixel. Clicking a date
 * previews that scene on the map; pixel curves and the map's pixel markers
 * select each other; the zone chips highlight a whole category.
 */

const ZONE_STYLE: { key: string; label: string; color: string }[] = [
  { key: 'interior', label: 'Interior', color: '#34d399' },
  { key: 'edge_other_species', label: 'Edge · other species', color: '#f87171' },
  { key: 'edge_same_species', label: 'Edge · same species', color: '#fbbf24' },
  { key: 'edge_isolated', label: 'Edge · isolated', color: '#94a3b8' },
];

const ZONE_COLOR: Record<string, string> = Object.fromEntries(ZONE_STYLE.map(z => [z.key, z.color]));

/** Per-pixel mode draws one line per pixel; keep the chart responsive. */
const MAX_PIXEL_LINES = 300;

interface NdviPanelProps {
  inspection: NdviInspection | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  /** Clicking a date on the chart previews that scene on the map. */
  onSelectDate: (date: string) => void;
  /** The pixel selected in the chart or on the map (shared with the map). */
  highlightPixel: NdviPixel | null;
  onHighlightPixel: (pixel: NdviPixel | null) => void;
}

export default function NdviPanel({
  inspection,
  busy,
  error,
  onClose,
  onSelectDate,
  highlightPixel,
  onHighlightPixel,
}: NdviPanelProps) {
  const [mode, setMode] = useState<'mean' | 'pixels'>('mean');
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const selectedPixelId = highlightPixel?.id ?? null;

  // A pixel picked on the map should be visible: jump to the pixels chart.
  useEffect(() => {
    if (highlightPixel) setMode('pixels');
  }, [highlightPixel]);

  // Evenly sampled subset when there are too many pixels to draw. The
  // selected pixel is always included.
  const shownPixels = useMemo(() => {
    const all = inspection?.pixels || [];
    if (all.length <= MAX_PIXEL_LINES) return all;
    const step = all.length / MAX_PIXEL_LINES;
    const sampled = Array.from({ length: MAX_PIXEL_LINES }, (_, i) => all[Math.floor(i * step)]);
    if (selectedPixelId && !sampled.some(p => p.id === selectedPixelId)) {
      const sel = all.find(p => p.id === selectedPixelId);
      if (sel) sampled.push(sel);
    }
    return sampled;
  }, [inspection, selectedPixelId]);

  const pixelData = useMemo(() => {
    if (!inspection) return [];
    return inspection.dates.map(date => {
      const row: Record<string, any> = { date };
      for (const p of shownPixels) {
        if (p.values[date] !== undefined) row[p.id] = p.values[date];
      }
      return row;
    });
  }, [inspection, shownPixels]);

  if (!inspection && !busy && !error) return null;

  const pickPixel = (p: NdviPixel) => {
    setSelectedZone(null);
    onHighlightPixel(selectedPixelId === p.id ? null : p);
  };

  const pickZone = (zone: string) => {
    onHighlightPixel(null);
    setSelectedZone(prev => (prev === zone ? null : zone));
  };

  const close = () => {
    setSelectedZone(null);
    onHighlightPixel(null);
    onClose();
  };

  const chartClick = (state: any) => {
    if (state?.activeLabel) onSelectDate(String(state.activeLabel));
  };

  const lineStyle = (p: NdviPixel): { width: number; opacity: number } => {
    if (selectedPixelId) {
      return p.id === selectedPixelId ? { width: 2.5, opacity: 1 } : { width: 1, opacity: 0.08 };
    }
    if (selectedZone) {
      return p.zone === selectedZone ? { width: 1.6, opacity: 0.9 } : { width: 1, opacity: 0.06 };
    }
    return { width: 1, opacity: 0.35 };
  };

  const axisProps = {
    tick: { fill: '#64748b', fontSize: 10 },
    stroke: '#ffffff22',
  } as const;

  return (
    <div className="absolute right-3 top-14 z-[1100] w-[28rem] max-w-[calc(100%-1.5rem)] rounded-lg border border-white/10 bg-[#11151af2] p-3 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-200">
            {busy ? 'Extracting pixels…' : inspection ? inspection.label : 'NDVI inspector'}
          </div>
          {inspection && !busy && (
            <div className="text-[11px] text-slate-500">
              {inspection.metric} · {inspection.distance} m split · {inspection.pixels.length} px · click a date to
              preview it{mode === 'pixels' && ' · click a curve or a map point to match them'}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {inspection && !busy && (
            <div className="flex overflow-hidden rounded-md border border-white/10 text-[11px]">
              <button
                onClick={() => setMode('mean')}
                className={cn('px-2 py-1', mode === 'mean' ? 'bg-sky-500/20 text-sky-300' : 'text-slate-500 hover:text-slate-300')}
              >
                Mean
              </button>
              <button
                onClick={() => setMode('pixels')}
                className={cn('px-2 py-1', mode === 'pixels' ? 'bg-sky-500/20 text-sky-300' : 'text-slate-500 hover:text-slate-300')}
              >
                Pixels
              </button>
            </div>
          )}
          <button onClick={close} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {busy && (
        <div className="flex h-48 items-center justify-center text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {!busy && error && <div className="py-6 text-center text-xs text-red-400">{error}</div>}

      {!busy && !error && inspection && mode === 'mean' && (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={inspection.series} margin={{ top: 4, right: 8, bottom: 0, left: -16 }} onClick={chartClick}>
              <CartesianGrid stroke="#ffffff14" strokeDasharray="3 3" />
              <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} {...axisProps} />
              <YAxis domain={[-0.2, 1]} {...axisProps} />
              <Tooltip
                contentStyle={{ background: '#1a2027', border: '1px solid #ffffff1a', borderRadius: 6, fontSize: 11 }}
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
                  dot={{ r: 3, fill: z.color, strokeWidth: 0, cursor: 'pointer' }}
                  activeDot={{ r: 5, cursor: 'pointer' }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {!busy && !error && inspection && mode === 'pixels' && (
        <>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={pixelData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }} onClick={chartClick}>
                <CartesianGrid stroke="#ffffff14" strokeDasharray="3 3" />
                <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} {...axisProps} />
                <YAxis domain={[-0.2, 1]} {...axisProps} />
                <Tooltip content={() => null} cursor={{ stroke: '#ffffff33' }} />
                {shownPixels.map(p => {
                  const s = lineStyle(p);
                  return (
                    <Line
                      key={p.id}
                      type="monotone"
                      dataKey={p.id}
                      stroke={ZONE_COLOR[p.zone]}
                      strokeWidth={s.width}
                      strokeOpacity={s.opacity}
                      dot={false}
                      activeDot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  );
                })}
                {/* Invisible wide strokes on top: the actual click targets —
                    a 1 px line is impossible to hit. */}
                {shownPixels.map(p => (
                  <Line
                    key={`${p.id}__hit`}
                    type="monotone"
                    dataKey={p.id}
                    stroke={ZONE_COLOR[p.zone]}
                    strokeWidth={14}
                    strokeOpacity={0}
                    dot={false}
                    activeDot={false}
                    connectNulls
                    isAnimationActive={false}
                    onClick={() => pickPixel(p)}
                    style={{ cursor: 'pointer' }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
            {ZONE_STYLE.map(z => {
              const active = selectedZone === z.key;
              return (
                <button
                  key={z.key}
                  onClick={() => pickZone(z.key)}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-1.5 py-0.5 transition-colors',
                    active
                      ? 'border-white/40 bg-white/10 text-slate-200'
                      : 'border-transparent text-slate-500 hover:text-slate-300'
                  )}
                  title="Highlight all curves of this category"
                >
                  <span className="h-1.5 w-3 rounded-full" style={{ background: z.color }} />
                  {z.label}
                </button>
              );
            })}
            {inspection.pixels.length > MAX_PIXEL_LINES && (
              <span className="text-slate-600">showing {MAX_PIXEL_LINES} of {inspection.pixels.length} px</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
