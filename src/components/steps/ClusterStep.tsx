import React, { useState } from 'react';
import { Boxes } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer } from 'recharts';
import { ZoneExtraction } from '../../lib/zones';
import { SpeciesClustering, CLUSTER_COLORS } from '../../lib/species-clusters';
import { Button, ErrorNote, Field, NumberInput, PrereqNote } from '../ui';

/**
 * Step 4 — cluster the fields of each species by their growth curve, to
 * isolate growth scenarios (sowing date, variety…) before the PCA.
 */

interface ClusterStepProps {
  zones: ZoneExtraction | null;
  clustering: SpeciesClustering | null;
  busy: boolean;
  error: string | null;
  onRun: (k: number) => void;
}

export default function ClusterStep(props: ClusterStepProps) {
  const [k, setK] = useState(3);

  return (
    <>
      {!props.zones && (
        <PrereqNote message="Extract the pixel zones in step 3 first — the clustering reads each field's interior pixels." />
      )}
      <p className="text-xs leading-relaxed text-slate-500">
        Each field is summarized by the mean {props.zones?.metric ?? 'NDVI'} curve of its interior pixels, and k-means
        runs <span className="text-slate-300">separately within every species</span> — clusters never mix species. Use
        the scenarios to restrict the PCA in step 5.
      </p>

      <Field label="Scenarios per species (k)" hint="Capped at the species' field count.">
        <NumberInput min={2} max={8} value={k} onChange={setK} />
      </Field>

      <Button onClick={() => props.onRun(k)} busy={props.busy} disabled={!props.zones} className="w-full">
        <Boxes className="h-3.5 w-3.5" />
        Cluster per species
      </Button>
      <ErrorNote message={props.error} />

      {props.clustering && (
        <div className="space-y-3">
          <div className="text-[11px] text-slate-500">
            {props.clustering.groups.length} species · {props.clustering.dates.length} dates
            {props.clustering.droppedFields > 0 && ` · ${props.clustering.droppedFields} field(s) dropped (incomplete series)`}{' '}
            · fields on the map are coloured by scenario
          </div>
          <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
            {props.clustering.groups.map(group => {
              const chartData = props.clustering!.dates.map((date, di) => {
                const row: Record<string, any> = { date };
                group.centroids.forEach((c, ci) => (row[`c${ci}`] = c[di]));
                return row;
              });
              return (
                <div key={group.species} className="rounded-md border border-white/10 p-2">
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs font-medium text-slate-300">{group.species}</span>
                    <span className="shrink-0 text-[10px] text-slate-600">{group.fields.length} fields</span>
                  </div>
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {group.sizes.map((size, ci) => (
                      <span
                        key={ci}
                        className="flex items-center gap-1 rounded-full border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-400"
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: CLUSTER_COLORS[ci % CLUSTER_COLORS.length] }}
                        />
                        scenario {ci + 1} · {size}
                      </span>
                    ))}
                  </div>
                  <div className="h-20">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
                        <XAxis
                          dataKey="date"
                          tickFormatter={(d: string) => d.slice(5)}
                          tick={{ fill: '#475569', fontSize: 8 }}
                          stroke="#ffffff14"
                          interval="preserveStartEnd"
                        />
                        <YAxis hide domain={['auto', 'auto']} />
                        {group.centroids.map((_, ci) => (
                          <Line
                            key={ci}
                            type="monotone"
                            dataKey={`c${ci}`}
                            stroke={CLUSTER_COLORS[ci % CLUSTER_COLORS.length]}
                            strokeWidth={1.5}
                            dot={false}
                            isAnimationActive={false}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
