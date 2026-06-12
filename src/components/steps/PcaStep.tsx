import React from 'react';
import { BarChart3, Download, ExternalLink } from 'lucide-react';
import { PixelZone, ZoneExtraction } from '../../lib/zones';
import { PcaRunResult } from '../../lib/pca';
import { SpeciesClustering, CLUSTER_COLORS } from '../../lib/species-clusters';
import { Button, ErrorNote, Field, inputClass, PrereqNote, Stat } from '../ui';
import { cn } from '../../lib/utils';

/**
 * Step 5 — run the PCA on the extracted pixel time series and open the
 * results panel. The observation set can be narrowed three ways, combined:
 * a growth scenario from step 4, a subset of the extracted fields, and the
 * pixel classes — with the classes used to FIT the axes chosen separately
 * from the classes PROJECTED into the fitted space.
 */

export const PCA_SCOPE_ALL = 'all';

/** Encode a species+cluster scope as one select value. */
export const pcaScopeValue = (species: string, cluster: number) => `${species} ${cluster}`;
export const parsePcaScope = (scope: string): { species: string; cluster: number } | null => {
  if (scope === PCA_SCOPE_ALL) return null;
  const sep = scope.lastIndexOf(' ');
  return { species: scope.slice(0, sep), cluster: Number(scope.slice(sep + 1)) };
};

const ZONE_CHIPS: { key: PixelZone; label: string; color: string }[] = [
  { key: 'interior', label: 'Interior', color: '#34d399' },
  { key: 'edge_other_species', label: 'Edge · other', color: '#f87171' },
  { key: 'edge_same_species', label: 'Edge · same', color: '#fbbf24' },
  { key: 'edge_isolated', label: 'Edge · isolated', color: '#94a3b8' },
];

function ZonePicker({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: PixelZone[];
  onChange: (zones: PixelZone[]) => void;
}) {
  const toggle = (zone: PixelZone) =>
    onChange(value.includes(zone) ? value.filter(z => z !== zone) : [...value, zone]);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
        <span className="text-[10px] text-slate-600">{hint}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {ZONE_CHIPS.map(z => {
          const active = value.includes(z.key);
          return (
            <button
              key={z.key}
              onClick={() => toggle(z.key)}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                active
                  ? 'border-white/30 bg-white/10 text-slate-200'
                  : 'border-white/10 text-slate-600 hover:text-slate-400'
              )}
            >
              <span
                className={cn('h-1.5 w-1.5 rounded-full', !active && 'opacity-30')}
                style={{ background: z.color }}
              />
              {z.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface PcaStepProps {
  zones: ZoneExtraction | null;
  clustering: SpeciesClustering | null;
  scope: string;
  onScopeChange: (scope: string) => void;
  /** Subset of extracted fields (pids) the PCA runs on; null = all. */
  fields: Set<number> | null;
  onFieldsChange: (fields: Set<number> | null) => void;
  /** pid → pair_id from the neighbour-pairs query, to group the field list. */
  pairOf: Map<number, string>;
  fitZones: PixelZone[];
  onFitZonesChange: (zones: PixelZone[]) => void;
  projectZones: PixelZone[];
  onProjectZonesChange: (zones: PixelZone[]) => void;
  result: PcaRunResult | null;
  busy: boolean;
  error: string | null;
  onRun: () => void;
  onOpenResults: () => void;
  onExportCsv: () => void;
}

export default function PcaStep(props: PcaStepProps) {
  const perPolygon = props.zones?.perPolygon || [];
  const fieldCount = props.fields === null ? perPolygon.length : props.fields.size;

  const setFields = (next: Set<number>) =>
    props.onFieldsChange(next.size === perPolygon.length ? null : next);
  const currentFields = () => new Set(props.fields === null ? perPolygon.map(p => p.pid) : props.fields);

  const toggleField = (pid: number) => {
    const next = currentFields();
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    setFields(next);
  };

  const togglePair = (pids: number[], include: boolean) => {
    const next = currentFields();
    for (const pid of pids) {
      if (include) next.add(pid);
      else next.delete(pid);
    }
    setFields(next);
  };

  // Group the extracted fields by neighbour pair so each pair can be ticked
  // as a unit; fields outside any pair go to the trailing group.
  const fieldGroups = React.useMemo(() => {
    const byPair = new Map<string, typeof perPolygon>();
    const solo: typeof perPolygon = [];
    for (const p of perPolygon) {
      const pair = props.pairOf.get(p.pid);
      if (pair === undefined) {
        solo.push(p);
        continue;
      }
      if (!byPair.has(pair)) byPair.set(pair, []);
      byPair.get(pair)!.push(p);
    }
    const groups = Array.from(byPair.entries())
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([pair, items]) => ({ pair, items }));
    return { groups, solo };
  }, [perPolygon, props.pairOf]);

  const scoped = parsePcaScope(props.scope);
  const scopeColor = scoped ? CLUSTER_COLORS[scoped.cluster % CLUSTER_COLORS.length] : null;

  return (
    <>
      {!props.zones && <PrereqNote message="Extract the pixel zones in step 3 first — the PCA runs on those pixels." />}

      {props.zones && (
        <Field
          label="Scenario scope"
          hint={
            props.clustering
              ? 'Restrict to one growth scenario from step 4.'
              : 'Run the species clustering in step 4 to enable per-scenario PCA.'
          }
        >
          <select
            className={inputClass}
            value={props.scope}
            disabled={!props.clustering}
            onChange={e => props.onScopeChange(e.target.value)}
          >
            <option value={PCA_SCOPE_ALL}>All scenarios</option>
            {props.clustering?.groups.map(group =>
              group.sizes.map((size, ci) => (
                <option key={pcaScopeValue(group.species, ci)} value={pcaScopeValue(group.species, ci)}>
                  {group.species} — scenario {ci + 1} ({size} field{size === 1 ? '' : 's'})
                </option>
              ))
            )}
          </select>
        </Field>
      )}
      {scoped && (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: scopeColor! }} />
          Only the pixels of {scoped.species} fields in scenario {scoped.cluster + 1} are considered.
        </p>
      )}

      {props.zones && (
        <details className="rounded-md border border-white/10 px-2.5 py-1.5">
          <summary className="cursor-pointer select-none text-xs text-slate-400 hover:text-slate-200">
            Fields · {fieldCount}/{perPolygon.length} included
          </summary>
          <div className="mt-1.5 flex gap-2 text-[11px]">
            <button className="text-sky-400 hover:text-sky-300" onClick={() => props.onFieldsChange(null)}>
              All
            </button>
            <button className="text-sky-400 hover:text-sky-300" onClick={() => props.onFieldsChange(new Set())}>
              None
            </button>
          </div>
          <div className="mt-1 max-h-48 overflow-y-auto">
            {fieldGroups.groups.map(({ pair, items }) => {
              const pids = items.map(p => p.pid);
              const allIn = pids.every(pid => props.fields === null || props.fields.has(pid));
              return (
                <div key={pair} className="mb-1 rounded border border-white/5 px-1.5 py-1">
                  <label className="flex cursor-pointer items-center gap-2 text-[11px] font-medium text-slate-300">
                    <input
                      type="checkbox"
                      checked={allIn}
                      onChange={() => togglePair(pids, !allIn)}
                      className="accent-sky-500"
                    />
                    Pair {pair.replace('_', ' ↔ ')}
                  </label>
                  {items.map(p => {
                    const checked = props.fields === null || props.fields.has(p.pid);
                    return (
                      <label
                        key={p.pid}
                        className="ml-4 flex cursor-pointer items-center gap-2 py-0.5 text-[11px] text-slate-400 hover:text-slate-200"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleField(p.pid)}
                          className="accent-sky-500"
                        />
                        <span className="truncate">{p.label}</span>
                        <span className="ml-auto shrink-0 text-slate-600">{p.interior + p.edge} px</span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
            {fieldGroups.solo.length > 0 && fieldGroups.groups.length > 0 && (
              <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-slate-600">Unpaired</div>
            )}
            {fieldGroups.solo.map(p => {
              const checked = props.fields === null || props.fields.has(p.pid);
              return (
                <label
                  key={p.pid}
                  className="flex cursor-pointer items-center gap-2 py-0.5 text-[11px] text-slate-400 hover:text-slate-200"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleField(p.pid)}
                    className="accent-sky-500"
                  />
                  <span className="truncate">{p.label}</span>
                  <span className="ml-auto shrink-0 text-slate-600">{p.interior + p.edge} px</span>
                </label>
              );
            })}
          </div>
        </details>
      )}

      {props.zones && (
        <div className="space-y-2 rounded-md border border-white/10 p-2.5">
          <ZonePicker
            label="Fit axes on"
            hint="these pixels define the components"
            value={props.fitZones}
            onChange={props.onFitZonesChange}
          />
          <ZonePicker
            label="Project"
            hint="these pixels are placed in the space"
            value={props.projectZones}
            onChange={props.onProjectZonesChange}
          />
        </div>
      )}

      <Button onClick={props.onRun} busy={props.busy} disabled={!props.zones} className="w-full">
        <BarChart3 className="h-3.5 w-3.5" />
        Run PCA{scoped ? ` · scenario ${scoped.cluster + 1}` : ''}
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
            axes fit on {props.result.fitCount} px (
            {props.result.fitZones.map(z => ZONE_CHIPS.find(c => c.key === z)?.label ?? z).join(', ')}) ·{' '}
            {props.result.rows.length} px placed
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
