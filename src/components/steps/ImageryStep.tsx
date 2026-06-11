import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Satellite, Trash2 } from 'lucide-react';
import { RasterLayer } from '../../types';
import { SeriesFetchParams, SeriesProgress } from '../../lib/fetch-series';
import { DatasetDateRange } from '../../lib/neighbor-query';
import { Button, ErrorNote, Field, inputClass, PrereqNote, ProgressBar, StopButton } from '../ui';
import { cn } from '../../lib/utils';

/**
 * Step 2 — fetch the Sentinel-2 time series over the selected polygons.
 */

interface ImageryStepProps {
  scenes: RasterLayer[];
  selectedCount: number;
  busy: boolean;
  progress: SeriesProgress | null;
  error: string | null;
  failedDates: string[];
  partialDates: number;
  onFetch: (params: SeriesFetchParams) => void;
  onCancel: () => void;
  /** Acquisition span of the connected dataset — the default fetch period. */
  datasetRange: DatasetDateRange | null;
  previewSceneId: string | null;
  onPreviewScene: (id: string | null) => void;
  onDeleteScene: (id: string) => void;
}

function defaultDates(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export default function ImageryStep(props: ImageryStepProps) {
  const defaults = defaultDates();
  const [startDate, setStartDate] = useState(props.datasetRange?.start || defaults.start);
  const [endDate, setEndDate] = useState(props.datasetRange?.end || defaults.end);

  // When the dataset's date span becomes known (Connect in step 1), adopt it.
  useEffect(() => {
    if (props.datasetRange) {
      setStartDate(props.datasetRange.start);
      setEndDate(props.datasetRange.end);
    }
  }, [props.datasetRange]);
  const [maxCloud, setMaxCloud] = useState(20);
  const [count, setCount] = useState(12);
  const [token, setToken] = useState(() => localStorage.getItem('mpc_token') || '');
  const [showToken, setShowToken] = useState(false);

  const fetchSeries = () => {
    localStorage.setItem('mpc_token', token);
    props.onFetch({ startDate, endDate, maxCloudCover: maxCloud, targetCount: count, token: token || undefined });
  };

  return (
    <>
      {props.selectedCount === 0 && (
        <PrereqNote message="Select at least one polygon in step 1 (tick it in the list or click it on the map) to enable the fetch." />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="From">
          <input type="date" className={inputClass} value={startDate} onChange={e => setStartDate(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" className={inputClass} value={endDate} onChange={e => setEndDate(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={`Max cloud cover · ${maxCloud}%`}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={maxCloud}
            onChange={e => setMaxCloud(Number(e.target.value))}
            className="w-full accent-sky-500"
          />
        </Field>
        <Field label="Scenes" hint="Evenly spaced over the period.">
          <input
            type="number"
            min={3}
            max={60}
            className={inputClass}
            value={count}
            onChange={e => setCount(Math.max(3, Number(e.target.value) || 3))}
          />
        </Field>
      </div>

      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer select-none hover:text-slate-300">Planetary Computer API key (optional)</summary>
        <div className="mt-2 flex gap-2">
          <input
            type={showToken ? 'text' : 'password'}
            className={inputClass}
            placeholder="Higher rate limits"
            value={token}
            onChange={e => setToken(e.target.value)}
          />
          <button className="text-slate-500 hover:text-slate-300" onClick={() => setShowToken(s => !s)}>
            {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </details>

      <div className="flex gap-2">
        <Button onClick={fetchSeries} busy={props.busy} disabled={props.selectedCount === 0} className="flex-1">
          <Satellite className="h-3.5 w-3.5" />
          Fetch time series · {props.selectedCount} polygon{props.selectedCount === 1 ? '' : 's'}
        </Button>
        {props.busy && <StopButton onClick={props.onCancel} />}
      </div>

      {props.busy && props.progress && (
        <ProgressBar current={props.progress.current} total={props.progress.total} message={props.progress.message} />
      )}
      <ErrorNote message={props.error} />
      {props.failedDates.length > 0 && (
        <p className="text-[11px] text-amber-400/80">
          {props.failedDates.length} scene(s) failed to download and were skipped: {props.failedDates.join(', ')}
        </p>
      )}

      {props.scenes.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-slate-400">{props.scenes.length} scenes in the series — click to preview</div>
          {props.partialDates > 0 && (
            <p className="text-[11px] leading-relaxed text-slate-600">
              {props.partialDates} date(s) were skipped because their satellite swath only covers part of the
              selection.
            </p>
          )}
          <div className="max-h-44 overflow-y-auto rounded-md border border-white/10">
            {props.scenes.map(scene => {
              const date = scene.datetime?.split('T')[0] || scene.name;
              const cloud = scene.stacItem?.properties?.['eo:cloud_cover'];
              const previewing = props.previewSceneId === scene.id;
              return (
                <div
                  key={scene.id}
                  onClick={() => props.onPreviewScene(previewing ? null : scene.id)}
                  className={cn(
                    'group flex w-full cursor-pointer items-center justify-between border-b border-white/5 px-2.5 py-1.5 text-xs last:border-0',
                    previewing ? 'bg-sky-500/10 text-sky-200' : 'text-slate-400 hover:bg-white/[0.03]'
                  )}
                >
                  <span className="font-mono">{date}</span>
                  <span className="flex items-center gap-2">
                    {typeof cloud === 'number' && <span className="text-slate-600">{cloud.toFixed(0)}% cloud</span>}
                    {previewing && <Eye className="h-3.5 w-3.5" />}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        props.onDeleteScene(scene.id);
                      }}
                      className="rounded p-0.5 text-slate-600 opacity-0 transition-all hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
                      title="Remove this scene from the series"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
