import React from 'react';
import { Boxes, Sprout, ExternalLink } from 'lucide-react';
import { ZoneExtraction } from '../../lib/zones';
import { SpeciesClustering } from '../../lib/species-clusters';
import { GrowingSeasonResult } from '../../lib/phenology';
import { Button, PrereqNote } from '../ui';

/**
 * Step 4 — a launcher for the Growth-scenarios window. Clustering and the
 * growing-season selection outgrew the sidebar, so they live in a resizable
 * drawer (like the PCA results); this step opens it and shows a one-line status.
 */

interface ClusterStepProps {
  zones: ZoneExtraction | null;
  clustering: SpeciesClustering | null;
  busy: boolean;
  season: GrowingSeasonResult | null;
  seasonOnly: boolean;
  onOpen: () => void;
}

export default function ClusterStep(props: ClusterStepProps) {
  const c = props.clustering;
  return (
    <>
      {!props.zones && (
        <PrereqNote message="Extract the pixel zones in step 3 first — the clustering reads each field's interior pixels." />
      )}
      <p className="text-xs leading-relaxed text-slate-500">
        Cluster each species’ fields by their interior growth curve to isolate growth scenarios (sowing date, variety…),
        then read the growing season from those scenarios. Opens in its own window.
      </p>

      <Button onClick={props.onOpen} busy={props.busy} disabled={!props.zones} className="w-full">
        <Boxes className="h-3.5 w-3.5" />
        {c ? 'Open growth-scenarios window' : 'Cluster & growth scenarios'}
        <ExternalLink className="h-3.5 w-3.5 opacity-70" />
      </Button>

      {c && (
        <div className="space-y-1 rounded-md border border-white/10 px-2.5 py-2 text-[11px] text-slate-400">
          <div>
            <span className="text-slate-300">{c.groups.length}</span> species ·{' '}
            <span className="text-slate-300">up to {c.k}</span> scenarios each · {c.dates.length} dates
            {c.droppedFields > 0 && ` · ${c.droppedFields} field(s) dropped`}
          </div>
          <div className="flex items-center gap-1 text-emerald-400/80">
            <Sprout className="h-3 w-3" />
            {props.seasonOnly
              ? props.season?.window
                ? `Growing season: ${props.season.window.start} → ${props.season.window.end}`
                : 'Growing season on — no shared window'
              : 'Growing season off (PCA uses the whole year)'}
          </div>
        </div>
      )}
    </>
  );
}
