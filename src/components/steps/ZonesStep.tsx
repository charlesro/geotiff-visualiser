import React, { useState } from 'react';
import { Scissors } from 'lucide-react';
import { ZoneExtraction, ZoneProgress } from '../../lib/zones';
import { zoneColor, zoneShort } from '../../lib/legend';
import { Button, ErrorNote, Field, inputClass, NumberInput, PrereqNote, ProgressBar, Stat, StopButton } from '../ui';

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
  /** Fields whose footprint falls under the fetched imagery. */
  coveredCount: number;
  /** Ground pixel size of the fetched scenes in metres (null before fetch). */
  pixelSize: number | null;
  /** The selection changed since these zones were extracted. */
  stale: boolean;
  onRun: (distance: number, metric: string, includeOutside: boolean, neighbourGap: number, allCovered: boolean) => void;
  onCancel: () => void;
}

export default function ZonesStep(props: ZonesStepProps) {
  const [distance, setDistance] = useState(10);
  const [metric, setMetric] = useState('NDVI');
  const [includeOutside, setIncludeOutside] = useState(false);
  const [neighbourGap, setNeighbourGap] = useState(12);
  const [allCovered, setAllCovered] = useState(true);

  const needsSelection = !allCovered && props.selectedCount === 0;
  const canRun = props.sceneCount > 0 && !needsSelection;

  return (
    <>
      {props.sceneCount === 0 ? (
        <PrereqNote message="Fetch a Sentinel-2 time series in step 2 first — the zones are extracted from those scenes." />
      ) : needsSelection ? (
        <PrereqNote message="Select at least one polygon in step 1, or tick “all fields under the imagery” below." />
      ) : null}
      {props.stale && (
        <PrereqNote message="The polygon selection changed since these zones were extracted — the pixels still shown are from the earlier selection. Re-extract to match the current selection." />
      )}
      {props.pixelSize !== null && props.pixelSize > distance && (
        <PrereqNote
          message={`The fetched scenes have ${props.pixelSize} m pixels — coarser than the ${distance} m buffer, so the interior/edge split will be meaningless. Large selections are downsampled to fit in memory: select a smaller area (≲ 20 km across keeps the native 10 m) and re-fetch the series.`}
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Buffer distance (m)">
          <NumberInput min={1} max={500} value={distance} onChange={setDistance} />
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

      <Field label={`Max gap to neighbour · ${neighbourGap} m`}>
        <input
          type="range"
          min={0}
          max={40}
          step={1}
          value={neighbourGap}
          onChange={e => setNeighbourGap(Number(e.target.value))}
          className="w-full accent-sky-500"
        />
      </Field>
      <p className="text-[11px] leading-relaxed text-slate-600">
        An edge pixel takes a neighbour's class only when that field lies directly across the boundary: closer to the
        pixel than its own boundary distance + {neighbourGap} m. Fields across wider gaps (a road…) leave the pixel{' '}
        <span className="text-slate-400">isolated</span>. Pixels in the open gap <em>between</em> two facing fields
        (inside neither polygon) are included as edge pixels too, classified by the field across — but only where the
        corridor is narrower than {neighbourGap} m, so wedges at corners and open land stay out.
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

      <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-400">
        <input
          type="checkbox"
          checked={allCovered}
          onChange={e => setAllCovered(e.target.checked)}
          className="mt-0.5 accent-sky-500"
        />
        <span>
          Extract <em>all fields under the imagery</em>
          {props.sceneCount > 0 && <span className="text-slate-500"> ({props.coveredCount.toLocaleString()} fields)</span>}, not
          only the {props.selectedCount.toLocaleString()} selected.
        </span>
      </label>

      <div className="flex gap-2">
        <Button
          onClick={() => props.onRun(distance, metric, includeOutside, neighbourGap, allCovered)}
          busy={props.busy}
          disabled={!canRun}
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
            <Stat label={zoneShort('interior')} value={props.zones.interior.features.length} accent={zoneColor('interior')} />
            <Stat label={zoneShort('edge_other_species')} value={props.zones.edgeCounts.other} accent={zoneColor('edge_other_species')} />
            <Stat label={zoneShort('edge_same_species')} value={props.zones.edgeCounts.same} accent={zoneColor('edge_same_species')} />
            <Stat label={zoneShort('edge_isolated')} value={props.zones.edgeCounts.isolated} accent={zoneColor('edge_isolated')} />
            <Stat label="Dates" value={props.zones.dates.length} />
          </div>
          {props.zones.unmixing && props.zones.unmixing.count > 0 && (
            <p className="text-[11px] leading-relaxed text-slate-500">
              Species mix estimated for {props.zones.unmixing.count} edge-other pixels — mean{' '}
              <span className="text-slate-300">
                {(props.zones.unmixing.meanFractionA * 100).toFixed(0)}% {props.zones.unmixing.speciesA}
              </span>{' '}
              / {(100 - props.zones.unmixing.meanFractionA * 100).toFixed(0)}% {props.zones.unmixing.speciesB}. Colour
              them on the map (legend toggle) or in the PCA scatter (Colour → species mix); the proportions are in the
              CSV export.
            </p>
          )}
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
