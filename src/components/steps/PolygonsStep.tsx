import React, { useRef, useState } from 'react';
import { Database, FileUp, CheckSquare, Square } from 'lucide-react';
import { Button, ErrorNote, Field, inputClass } from '../ui';
import { polygonLabel } from '../../lib/polygon-source';
import { cn } from '../../lib/utils';

/**
 * Step 1 — load polygons (database query or file) and choose which ones to
 * analyse.
 */

const DEFAULT_QUERY = `-- Return one row per polygon with a WKT geometry column
SELECT *, ST_AsText(geometry) AS geometry_wkt
FROM read_parquet('polygons.parquet')`;

interface PolygonsStepProps {
  polygons: any | null;
  sourceLabel: string;
  selectedIds: Set<number>;
  busy: boolean;
  error: string | null;
  onLoadFromDb: (url: string, sql: string) => void;
  onLoadFromFile: (file: File) => void;
  onToggle: (pid: number) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onZoomTo: (feature: any) => void;
}

export default function PolygonsStep(props: PolygonsStepProps) {
  const [tab, setTab] = useState<'database' | 'file'>('database');
  const [dbUrl, setDbUrl] = useState(() => localStorage.getItem('ppca_db_url') || 'http://localhost:8080');
  const [sql, setSql] = useState(() => localStorage.getItem('ppca_db_query') || DEFAULT_QUERY);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadFromDb = () => {
    localStorage.setItem('ppca_db_url', dbUrl);
    localStorage.setItem('ppca_db_query', sql);
    props.onLoadFromDb(dbUrl, sql);
  };

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
          <Field label="Engine URL" hint="Local Python engine exposing POST /query (DuckDB).">
            <input className={inputClass} value={dbUrl} onChange={e => setDbUrl(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="SQL query">
            <textarea
              className={cn(inputClass, 'h-28 resize-y font-mono text-xs leading-relaxed')}
              value={sql}
              onChange={e => setSql(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Button onClick={loadFromDb} busy={props.busy} className="w-full">
            Load polygons
          </Button>
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
