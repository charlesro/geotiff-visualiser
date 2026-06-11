import React, { useState } from 'react';
import { Scissors } from 'lucide-react';
import { ZoneExtraction, ZoneProgress } from '../../lib/zones';
import { Button, ErrorNote, Field, inputClass, PrereqNote, ProgressBar, Stat, StopButton } from '../ui';

/**
 * Step 3 — split the pixels of every selected polygon into interior
 * (≥ distance inside the boundary) and edge (< distance from the boundary).
 */

export const ZONE_METRICS = [
  { value: 'NDVI', label: 'NDVI — (B08−B04)/(B08+B04)' },
  { value: 'EVI', label: 'EVI — enhanced vegetation index' },
  { value: 'B08', label: 'B08 — NIR reflectance' },
  { value: 'B04', label: 'B04 — red reflectance' },
];

interface ZonesStepProps {
  zones: ZoneExtraction | null;
  busy: boolean;
  progress: ZoneProgress | null;
  error: string | null;
  sceneCount: number;
  selectedCount: number;
  /** Ground pixel size of the fetched scenes in metres (null before fetch). */
  pixelSize: number | null;
  onRun: (distance: number, metric: string, includeOutside: boolean) => void;
  onCancel: () => void;
}

export default function ZonesStep(props: ZonesStepProps) {
  const [distance, setDistance] = useState(10);
  const [metric, setMetric] = useState('NDVI');
  const [includeOutside, setIncludeOutside] = useState(false);

  return (
    <>
      {props.selectedCount === 0 ? (
        <PrereqNote message="Select at least one polygon in step 1 first." />
      ) : props.sceneCount === 0 ? (
        <PrereqNote message="Fetch a Sentinel-2 time series in step 2 first — the zones are extracted from those scenes." />
      ) : null}
      {props.pixelSize !== null && props.pixelSize > distance && (
        <PrereqNote
          message={`The fetched scenes have ${props.pixelSize} m pixels — coarser than the ${distance} m buffer, so the interior/edge split will be meaningless. Large selections are downsampled to fit in memory: select a smaller area (≲ 20 km across keeps the native 10 m) and re-fetch the series.`}
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Buffer distance (m)">
          <input
            type="number"
            min={1}
            max={500}
            className={inputClass}
            value={distance}
            onChange={e => setDistance(Math.max(1, Number(e.target.value) || 1))}
          />
        </Field>
        <Field label="Metric">
          <select className={inputClass} value={metric} onChange={e => setMetric(e.target.value)}>
            {ZONE_METRICS.map(m => (
              <option key={m.value} value={m.value}>
                {m.value}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="text-[11px] leading-relaxed text-slate-600">
        {ZONE_METRICS.find(m => m.value === metric)?.label}. Interior pixels lie at least {distance} m inside the
        polygon boundary; edge pixels are closer than {distance} m.
      </p>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
        <input
          type="checkbox"
          checked={includeOutside}
          onChange={e => setIncludeOutside(e.target.checked)}
          className="accent-sky-500"
        />
        Also include pixels up to {distance} m <em>outside</em> the boundary in the edge set
      </label>

      <div className="flex gap-2">
        <Button
          onClick={() => props.onRun(distance, metric, includeOutside)}
          busy={props.busy}
          disabled={props.sceneCount === 0 || props.selectedCount === 0}
          className="flex-1"
        >
          <Scissors className="h-3.5 w-3.5" />
          Extract pixel zones
        </Button>
        {props.busy && <StopButton onClick={props.onCancel} />}
      </div>

      {props.busy && props.progress && (
        <ProgressBar
          current={props.progress.done}
          total={props.progress.total}
          message={`Polygon ${Math.min(props.progress.done + 1, props.progress.total)}/${props.progress.total} — ${props.progress.label}`}
        />
      )}
      <ErrorNote message={props.error} />

      {props.zones && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Interior px" value={props.zones.interior.features.length} accent="#34d399" />
            <Stat label="Edge · other sp." value={props.zones.edgeCounts.other} accent="#f87171" />
            <Stat label="Edge · same sp." value={props.zones.edgeCounts.same} accent="#fbbf24" />
            <Stat label="Edge · isolated" value={props.zones.edgeCounts.isolated} accent="#94a3b8" />
            <Stat label="Dates" value={props.zones.dates.length} />
          </div>
          <div className="max-h-36 overflow-y-auto rounded-md border border-white/10">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-[#11151a] text-slate-500">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Polygon</th>
                  <th className="px-2 py-1.5 text-right font-medium text-emerald-400">Interior</th>
                  <th className="px-2 py-1.5 text-right font-medium text-amber-400">Edge</th>
                </tr>
              </thead>
              <tbody className="text-slate-400">
                {props.zones.perPolygon.map(row => (
                  <tr key={row.pid} className="border-t border-white/5">
                    <td className="truncate px-2.5 py-1">{row.label}</td>
                    <td className="px-2 py-1 text-right">{row.interior}</td>
                    <td className="px-2 py-1 text-right">{row.edge}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
