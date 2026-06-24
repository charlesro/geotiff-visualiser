import React, { useRef, useState } from 'react';
import { Database, FileUp, CheckSquare, Square, Plug, Search } from 'lucide-react';
import { Button, ErrorNote, Field, inputClass, NumberInput, StopButton } from '../ui';
import { polygonLabel } from '../../lib/polygon-source';
import {
  buildNeighborPairsQuery,
  filterToSpanningComponents,
  fetchSpeciesList,
  fetchDatasetDateRange,
  DatasetDateRange,
  DEFAULT_NEIGHBOR_PARAMS,
  NeighborPairsParams,
} from '../../lib/neighbor-query';
import { Plus, X } from 'lucide-react';
import { checkLocalServerStatus } from '../../services/local-server';
import { cn } from '../../lib/utils';

/**
 * Step 1 — load polygons and choose which ones to analyse.
 *
 * Database mode runs the parametrised neighbour analysis (closest touching
 * fields of the chosen species, kept where their cluster spans all of them)
 * against the local DuckDB engine, or any custom SQL. File mode accepts
 * GeoJSON / zipped shapefiles.
 */

const DEFAULT_CUSTOM_QUERY = `-- Return one row per polygon with a WKT geometry column
SELECT *, ST_AsText(geometry) AS geometry_wkt
FROM read_parquet('polygons.parquet')`;

const PARAM_INFO = {
  parquet:
    'The source dataset: a parquet file with one row per field (and date), containing at least NewID, crp_lbl and a WKT geometry column.',
  species:
    'The crop labels (crp_lbl) to study together — 2 for pairs, 3 for triplets, and so on. A field is kept when its connected cluster of touching, different-species fields spans every chosen species. Use "Connect" to list the species in the parquet.',
  distance:
    'Maximum boundary-to-boundary distance for two fields to count as neighbours, in degrees (the geometries are in lon/lat): 0.0001 ≈ 11 m. Larger values find more pairs but they are less adjacent.',
  maxPairs:
    'Keep only the N closest pairs after the distance filter, so the analysis stays focused on truly adjacent fields.',
};

function loadStoredParams(): NeighborPairsParams {
  try {
    const stored = localStorage.getItem('ppca_pair_params');
    if (stored) {
      const raw = JSON.parse(stored);
      // Migrate the old two-species shape (species1 / species2) → species[].
      if (!Array.isArray(raw.species) && (raw.species1 || raw.species2)) {
        raw.species = [raw.species1, raw.species2].filter(Boolean);
      }
      const { species1, species2, ...rest } = raw;
      void species1;
      void species2;
      const merged = { ...DEFAULT_NEIGHBOR_PARAMS, ...rest };
      if (!Array.isArray(merged.species) || merged.species.length < 2) merged.species = [...DEFAULT_NEIGHBOR_PARAMS.species];
      return merged;
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_NEIGHBOR_PARAMS, species: [...DEFAULT_NEIGHBOR_PARAMS.species] };
}

interface PolygonsStepProps {
  polygons: any | null;
  sourceLabel: string;
  selectedIds: Set<number>;
  busy: boolean;
  error: string | null;
  onLoadFromDb: (url: string, sql: string, filterRows?: (rows: any[]) => any[]) => void;
  onLoadFromFile: (file: File) => void;
  onCancel: () => void;
  onDatasetRange: (range: DatasetDateRange) => void;
  onToggle: (pid: number) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onZoomTo: (feature: any) => void;
}

export default function PolygonsStep(props: PolygonsStepProps) {
  const [tab, setTab] = useState<'database' | 'file'>('database');
  const [dbMode, setDbMode] = useState<'pairs' | 'sql'>('pairs');
  const [dbUrl, setDbUrl] = useState(() => localStorage.getItem('ppca_db_url') || 'http://localhost:8080');
  const [sql, setSql] = useState(() => localStorage.getItem('ppca_db_query') || DEFAULT_CUSTOM_QUERY);
  const [params, setParams] = useState<NeighborPairsParams>(loadStoredParams);
  const [species, setSpecies] = useState<string[]>([]);
  const [connectState, setConnectState] = useState<'idle' | 'busy' | 'ok'>('idle');
  const [connectError, setConnectError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setParam = <K extends keyof NeighborPairsParams>(key: K, value: NeighborPairsParams[K]) => {
    setParams(prev => {
      const next = { ...prev, [key]: value };
      localStorage.setItem('ppca_pair_params', JSON.stringify(next));
      return next;
    });
  };

  const connect = async () => {
    localStorage.setItem('ppca_db_url', dbUrl);
    setConnectState('busy');
    setConnectError(null);
    try {
      await checkLocalServerStatus(dbUrl);
      const list = await fetchSpeciesList(dbUrl, params.parquetPath);
      setSpecies(list);
      setConnectState('ok');
      // The dataset's acquisition span becomes the default period of step 2.
      try {
        const range = await fetchDatasetDateRange(dbUrl, params.parquetPath);
        if (range) props.onDatasetRange(range);
      } catch {
        /* non-fatal — step 2 falls back to "last year" */
      }
    } catch (e) {
      setConnectState('idle');
      setSpecies([]);
      setConnectError(
        `${e instanceof Error ? e.message : String(e)}\n\nIs the engine running? Start it with:\n  python3 server/engine.py`
      );
    }
  };

  const loadPairs = () => {
    localStorage.setItem('ppca_db_url', dbUrl);
    try {
      const sqlText = buildNeighborPairsQuery(params);
      props.onLoadFromDb(dbUrl, sqlText, rows => filterToSpanningComponents(rows, params.species));
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    }
  };

  // ----- species list editor -----
  const setSpeciesAt = (i: number, value: string) =>
    setParam('species', params.species.map((s, j) => (j === i ? value : s)));
  const addSpecies = () => {
    const used = new Set(params.species);
    const next = species.find(s => !used.has(s)) ?? '';
    setParam('species', [...params.species, next]);
  };
  const removeSpecies = (i: number) => setParam('species', params.species.filter((_, j) => j !== i));

  const loadCustomSql = () => {
    localStorage.setItem('ppca_db_url', dbUrl);
    localStorage.setItem('ppca_db_query', sql);
    props.onLoadFromDb(dbUrl, sql);
  };

  const speciesRow = (value: string, i: number) => (
    <div key={i} className="flex items-center gap-1.5">
      {species.length > 0 ? (
        <select className={inputClass} value={value} onChange={e => setSpeciesAt(i, e.target.value)}>
          {value !== '' && !species.includes(value) && <option value={value}>{value}</option>}
          {value === '' && <option value="">— pick a species —</option>}
          {species.map(s => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      ) : (
        <input className={inputClass} value={value} onChange={e => setSpeciesAt(i, e.target.value)} />
      )}
      <button
        onClick={() => removeSpecies(i)}
        disabled={params.species.length <= 2}
        title={params.species.length <= 2 ? 'At least two species are required' : 'Remove this species'}
        className="shrink-0 rounded p-1 text-slate-500 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  const features: any[] = props.polygons?.features || [];

  return (
    <>
      <div className="flex overflow-hidden rounded-md border border-white/10 text-xs">
        <button
          onClick={() => setTab('database')}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 py-1.5',
            tab === 'database' ? 'bg-sky-500/15 text-sky-300' : 'text-slate-400 hover:text-slate-200'
          )}
        >
          <Database className="h-3.5 w-3.5" /> Database
        </button>
        <button
          onClick={() => setTab('file')}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 py-1.5',
            tab === 'file' ? 'bg-sky-500/15 text-sky-300' : 'text-slate-400 hover:text-slate-200'
          )}
        >
          <FileUp className="h-3.5 w-3.5" /> File
        </button>
      </div>

      {tab === 'database' ? (
        <>
          <Field label="Engine URL" hint="Start it with: python3 server/engine.py">
            <div className="flex gap-2">
              <input className={inputClass} value={dbUrl} onChange={e => setDbUrl(e.target.value)} spellCheck={false} />
              <Button onClick={connect} busy={connectState === 'busy'} variant="ghost" className="shrink-0">
                <Plug className="h-3.5 w-3.5" />
                {connectState === 'ok' ? 'Connected' : 'Connect'}
              </Button>
            </div>
          </Field>
          {connectState === 'ok' && (
            <p className="text-[11px] text-emerald-400/90">
              Engine online · {species.length} species found in the parquet
            </p>
          )}

          <div className="flex overflow-hidden rounded-md border border-white/10 text-[11px]">
            <button
              onClick={() => setDbMode('pairs')}
              className={cn(
                'flex-1 py-1.5',
                dbMode === 'pairs' ? 'bg-white/10 text-slate-200' : 'text-slate-500 hover:text-slate-300'
              )}
            >
              Neighbour pairs
            </button>
            <button
              onClick={() => setDbMode('sql')}
              className={cn(
                'flex-1 py-1.5',
                dbMode === 'sql' ? 'bg-white/10 text-slate-200' : 'text-slate-500 hover:text-slate-300'
              )}
            >
              Custom SQL
            </button>
          </div>

          {dbMode === 'pairs' ? (
            <>
              <Field label="Parquet file" info={PARAM_INFO.parquet}>
                <input
                  className={cn(inputClass, 'font-mono text-xs')}
                  value={params.parquetPath}
                  onChange={e => setParam('parquetPath', e.target.value)}
                  spellCheck={false}
                />
              </Field>
              <Field label={`Species (${params.species.length})`} info={PARAM_INFO.species}>
                <div className="space-y-1.5">
                  {params.species.map((s, i) => speciesRow(s, i))}
                  <button
                    onClick={addSpecies}
                    className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-400 transition-colors hover:border-sky-400/40 hover:text-sky-300"
                  >
                    <Plus className="h-3 w-3" /> Add species
                  </button>
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="Neighbour distance"
                  info={PARAM_INFO.distance}
                  hint={`≈ ${Math.round(params.neighborDistance * 111320)} m`}
                >
                  <NumberInput
                    step={0.0001}
                    min={0}
                    value={params.neighborDistance}
                    onChange={n => setParam('neighborDistance', n)}
                  />
                </Field>
                <Field label="Max pairs" info={PARAM_INFO.maxPairs}>
                  <NumberInput min={1} value={params.maxPairs} onChange={n => setParam('maxPairs', n)} />
                </Field>
              </div>
              <div className="flex gap-2">
                <Button onClick={loadPairs} busy={props.busy} className="flex-1">
                  <Search className="h-3.5 w-3.5" />
                  {params.species.length > 2 ? 'Find neighbour clusters' : 'Find neighbour pairs'}
                </Button>
                {props.busy && <StopButton onClick={props.onCancel} />}
              </div>
            </>
          ) : (
            <>
              <Field label="SQL query" hint="Must return a WKT geometry column (e.g. geometry_wkt).">
                <textarea
                  className={cn(inputClass, 'h-28 resize-y font-mono text-xs leading-relaxed')}
                  value={sql}
                  onChange={e => setSql(e.target.value)}
                  spellCheck={false}
                />
              </Field>
              <div className="flex gap-2">
                <Button onClick={loadCustomSql} busy={props.busy} className="flex-1">
                  Load polygons
                </Button>
                {props.busy && <StopButton onClick={props.onCancel} />}
              </div>
            </>
          )}
          <ErrorNote message={connectError} />
        </>
      ) : (
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".geojson,.json,.zip"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) props.onLoadFromFile(file);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full rounded-md border border-dashed border-white/15 px-3 py-6 text-center text-xs text-slate-400 transition-colors hover:border-sky-500/50 hover:text-slate-200"
          >
            <FileUp className="mx-auto mb-1.5 h-5 w-5" />
            GeoJSON or zipped shapefile
          </button>
        </>
      )}

      <ErrorNote message={props.error} />

      {props.polygons && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>
              {features.length} polygons · <span className="text-sky-300">{props.selectedIds.size} selected</span>
            </span>
            <span className="flex gap-2">
              <button className="text-sky-400 hover:text-sky-300" onClick={props.onSelectAll}>
                All
              </button>
              <button className="text-slate-500 hover:text-slate-300" onClick={props.onClearSelection}>
                None
              </button>
            </span>
          </div>
          <div className="max-h-56 overflow-y-auto rounded-md border border-white/10">
            {features.map(f => {
              const pid = f.properties.__pid;
              const selected = props.selectedIds.has(pid);
              return (
                <div
                  key={pid}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 border-b border-white/5 px-2.5 py-1.5 text-left text-xs last:border-0',
                    selected ? 'bg-sky-500/10 text-slate-200' : 'text-slate-400 hover:bg-white/[0.03]'
                  )}
                  onClick={() => props.onToggle(pid)}
                >
                  {selected ? (
                    <CheckSquare className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                  ) : (
                    <Square className="h-3.5 w-3.5 shrink-0 text-slate-600" />
                  )}
                  <span className="flex-1 truncate">{polygonLabel(f)}</span>
                  <button
                    className="text-[10px] text-slate-600 hover:text-sky-300"
                    onClick={e => {
                      e.stopPropagation();
                      props.onZoomTo(f);
                    }}
                  >
                    zoom
                  </button>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-600">Tip: polygons can also be toggled by clicking them on the map.</p>
        </div>
      )}
    </>
  );
}
