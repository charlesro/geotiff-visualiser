import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, EyeOff, Pause, Play, Trash2 } from 'lucide-react';
import { RasterLayer } from '../types';
import { cn } from '../lib/utils';

/**
 * Timeline of the fetched Sentinel-2 series, shown over the map. Each scene
 * is a dot positioned by acquisition date; clicking a dot previews that
 * scene, the arrows step through the series and play animates it.
 */

interface SceneTimelineProps {
  scenes: RasterLayer[];
  previewSceneId: string | null;
  onPreviewScene: (id: string | null) => void;
  onDeleteScene: (id: string) => void;
}

const sceneDate = (s: RasterLayer): string => s.datetime?.split('T')[0] || s.name;

export default function SceneTimeline({ scenes, previewSceneId, onPreviewScene, onDeleteScene }: SceneTimelineProps) {
  const [playing, setPlaying] = useState(false);

  const ordered = useMemo(
    () =>
      [...scenes].sort(
        (a, b) => new Date(a.datetime || 0).getTime() - new Date(b.datetime || 0).getTime()
      ),
    [scenes]
  );

  const activeIndex = ordered.findIndex(s => s.id === previewSceneId);

  // Dot positions: proportional to the date within the series span.
  const positions = useMemo(() => {
    if (ordered.length === 0) return [];
    const t0 = new Date(ordered[0].datetime || 0).getTime();
    const t1 = new Date(ordered[ordered.length - 1].datetime || 0).getTime();
    const span = t1 - t0 || 1;
    return ordered.map(s => ((new Date(s.datetime || 0).getTime() - t0) / span) * 100);
  }, [ordered]);

  const step = (delta: number) => {
    if (ordered.length === 0) return;
    const next = activeIndex < 0 ? 0 : (activeIndex + delta + ordered.length) % ordered.length;
    onPreviewScene(ordered[next].id);
  };

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => step(1), 1300);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, activeIndex, ordered]);

  if (ordered.length === 0) return null;

  const active = activeIndex >= 0 ? ordered[activeIndex] : null;
  const cloud = active?.stacItem?.properties?.['eo:cloud_cover'];

  return (
    <div className="absolute bottom-6 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-white/10 bg-[#11151ad9] px-3 py-2 backdrop-blur">
      {/* Transport */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => setPlaying(p => !p)}
          className="rounded p-1 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          title={playing ? 'Pause' : 'Play the series'}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={() => step(-1)}
          className="rounded p-1 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          title="Previous scene"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => step(1)}
          className="rounded p-1 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          title="Next scene"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Track */}
      <div className="relative h-8 w-64 sm:w-80">
        <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-white/20" />
        {ordered.map((s, i) => {
          const isActive = s.id === previewSceneId;
          return (
            <button
              key={s.id}
              onClick={() => onPreviewScene(isActive ? null : s.id)}
              style={{ left: `${positions[i]}%` }}
              className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-1.5"
              title={sceneDate(s)}
            >
              <span
                className={cn(
                  'block rounded-full transition-all',
                  isActive
                    ? 'h-3 w-3 bg-sky-400 ring-4 ring-sky-400/25'
                    : 'h-2 w-2 bg-slate-400 group-hover:bg-sky-300'
                )}
              />
            </button>
          );
        })}
        <span className="absolute -bottom-0.5 left-0 text-[9px] text-slate-500">{sceneDate(ordered[0])}</span>
        <span className="absolute -bottom-0.5 right-0 text-[9px] text-slate-500">
          {sceneDate(ordered[ordered.length - 1])}
        </span>
      </div>

      {/* Current scene */}
      <div className="flex w-44 items-center justify-end gap-2">
        {active ? (
          <>
            <span className="font-mono text-xs text-sky-200">{sceneDate(active)}</span>
            {typeof cloud === 'number' && (
              <span className="text-[10px] text-slate-500">{cloud.toFixed(0)}%☁</span>
            )}
            <button
              onClick={() => onPreviewScene(null)}
              className="rounded p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
              title="Hide the overlay"
            >
              <EyeOff className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onDeleteScene(active.id)}
              className="rounded p-1 text-slate-400 transition-colors hover:bg-red-500/15 hover:text-red-400"
              title="Remove this scene from the series"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <Eye className="h-3 w-3" /> Pick a date
          </span>
        )}
      </div>
    </div>
  );
}
