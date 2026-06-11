import React from 'react';
import { BarChart3, Download, ExternalLink } from 'lucide-react';
import { ZoneExtraction } from '../../lib/zones';
import { PcaRunResult } from '../../lib/pca';
import { Button, ErrorNote, PrereqNote, Stat } from '../ui';

/**
 * Step 4 — run the PCA on the extracted pixel time series and open the
 * results panel.
 */

interface PcaStepProps {
  zones: ZoneExtraction | null;
  result: PcaRunResult | null;
  busy: boolean;
  error: string | null;
  onRun: () => void;
  onOpenResults: () => void;
  onExportCsv: () => void;
}

export default function PcaStep(props: PcaStepProps) {
  const pixelCount = props.zones
    ? props.zones.interior.features.length + props.zones.edge.features.length
    : 0;

  return (
    <>
      {!props.zones && <PrereqNote message="Extract the pixel zones in step 3 first — the PCA runs on those pixels." />}
      {props.zones && (
        <p className="text-xs leading-relaxed text-slate-500">
          Observations: <span className="text-slate-300">{pixelCount} pixels</span> (interior + edge) · features:{' '}
          <span className="text-slate-300">
            {props.zones.metric} on {props.zones.dates.length} dates
          </span>
          . Pixels with incomplete series are dropped.
        </p>
      )}

      <Button onClick={props.onRun} busy={props.busy} disabled={!props.zones} className="w-full">
        <BarChart3 className="h-3.5 w-3.5" />
        Run PCA
      </Button>
      <ErrorNote message={props.error} />

      {props.result && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            {props.result.explained.map((v, i) => (
              <Stat key={i} label={`PC${i + 1} variance`} value={`${v.toFixed(1)}%`} />
            ))}
          </div>
          <div className="text-[11px] text-slate-500">
            {props.result.rows.length} pixels retained
            {props.result.droppedPixels > 0 && ` (${props.result.droppedPixels} dropped — incomplete series)`} ·{' '}
            {props.result.dates.length} dates
          </div>
          <div className="flex gap-2">
            <Button onClick={props.onOpenResults} className="flex-1">
              <ExternalLink className="h-3.5 w-3.5" /> Open results
            </Button>
            <Button onClick={props.onExportCsv} variant="ghost">
              <Download className="h-3.5 w-3.5" /> CSV
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
