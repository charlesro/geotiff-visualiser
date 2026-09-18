import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { Explain, InfoDot, Spinner } from '../ui';
import { fmt } from '../util';
import { VARIETY_GUESS_PREFIX } from '../design-import';
import type { ImportedDesign, ImportedVariety } from '../imported-types';
import { SELECT } from './controls';
import { AttributeTable } from './AttributeTable';

/** What the picker offers. Loose shapefile parts are accepted together, not one by one. */
const ACCEPT = '.zip,.shp,.shx,.dbf,.prj,.cpg,.geojson,.json,.kml,.kmz';

/**
 * Upload a real trial layout, and say what was read from it.
 *
 * Rendered inside a `Step`, which unmounts collapsed children, so this holds
 * only the momentary drag highlight: the design, the error and the busy flag
 * live in the page shell.
 */
export function ImportPanel({ design, varieties, busy, error, onFiles, onRemove, setVarietyColumn, setNameColumn }: {
  design: ImportedDesign | null;
  varieties: ImportedVariety[];
  busy: boolean;
  error: string | null;
  onFiles: (files: File[]) => void;
  onRemove: () => void;
  setVarietyColumn: (column: string) => void;
  setNameColumn: (column: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = () => input.current?.click();
  const take = (list: FileList | null) => { if (list && list.length) onFiles(Array.from(list)); };

  /**
   * The reader's warnings, minus a guess it no longer stands by.
   *
   * Every other warning is a fact about the file (a reprojection, a skipped
   * layer) and stays true for as long as the file is loaded. The variety guess
   * is the one that describes a CHOICE, and the dropdown two lines below lets
   * the user overrule it: it went on reading "guessed from COL" beside a
   * dropdown set to MGRS_TILE. Filtered here rather than dropped when the user
   * picks, so a design already saved with a stale note is repaired on load too.
   */
  const warnings = design
    ? design.warnings.filter(w => !w.startsWith(VARIETY_GUESS_PREFIX) || w.includes(`"${design.varietyColumn}"`))
    : [];

  const reps = varieties.map(v => v.plots);
  const repMin = reps.length ? Math.min(...reps) : 0, repMax = reps.length ? Math.max(...reps) : 0;

  return (
    <div className="space-y-2">
      <input ref={input} type="file" multiple accept={ACCEPT} className="hidden"
        // Cleared after reading, so choosing the same file again still fires.
        onChange={e => { take(e.target.files); e.target.value = ''; }} />

      {!design ? (
        <button type="button" onClick={pick} disabled={busy}
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
          className={`flex w-full flex-col items-center gap-1 rounded-md border border-dashed px-3 py-4 text-center text-[11px] transition-colors ${over ? 'border-sky-400 bg-sky-500/10 text-sky-200' : 'border-white/15 text-neutral-400 hover:border-sky-500/50 hover:text-neutral-200'}`}>
          {busy
            ? <span className="flex items-center gap-1.5 text-sky-300"><Spinner className="h-3 w-3" /> Reading the plots…</span>
            : <>
                <span className="text-xs text-neutral-200">Drop your trial's plot file, or click to choose</span>
                <span className="text-neutral-500">Zipped shapefile, its .shp .dbf .prj parts, GeoJSON, KML or KMZ</span>
              </>}
        </button>
      ) : (
        // The loaded card takes a dropped file too: after the first import the
        // drop zone is gone, and a small "Replace" next to the name was easy to
        // miss when the panel sat folded inside step 4.
        <div
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
          className={`rounded-md border px-2.5 py-2 text-[11px] text-neutral-300 transition-colors ${over ? 'border-sky-400 bg-sky-500/10' : 'border-white/10 bg-white/[0.02]'}`}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-neutral-100" title={design.fileName}>{design.fileName}</span>
            <button type="button" onClick={pick} disabled={busy}
              title="Import another file, or drop one on this card"
              className="flex shrink-0 items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-neutral-200 transition-colors hover:border-sky-500/60 hover:text-sky-200 disabled:opacity-40">
              {busy ? <Spinner className="h-3 w-3" /> : <Upload className="h-3 w-3" />} Replace file
            </button>
            <button type="button" onClick={onRemove}
              title="Drop the trial and put your own field back"
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-neutral-400 hover:text-rose-300">Remove</button>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            <span><span className="font-mono text-neutral-100">{fmt(design.plots.length)}</span> plots</span>
            <span><span className="font-mono text-neutral-100">{fmt(varieties.length)}</span> varieties</span>
            {reps.length > 0 && (
              <span>
                <span className="font-mono text-neutral-100">{repMin === repMax ? repMin : `${repMin} to ${repMax}`}</span>
                {' '}{repMax === 1 ? 'plot' : 'plots'} each
              </span>
            )}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 flex items-center gap-1 text-neutral-500">
                Variety column
                <Explain text={<>Each distinct value is its own species, with its own curve, colour and purity count. Plots sharing a value are its repetitions.</>}><InfoDot /></Explain>
              </span>
              <select className={SELECT} value={design.varietyColumn} onChange={e => setVarietyColumn(e.target.value)}>
                {/* A real state the reader produces when no column groups the plots,
                    and the only way back to it once another column has been picked. */}
                <option value="">(each plot its own variety)</option>
                {design.columns.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-500">Plot name column</span>
              <select className={SELECT} value={design.nameColumn} onChange={e => setNameColumn(e.target.value)}>
                <option value="">(numbered)</option>
                {design.columns.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
          {/* The pickers above ask which column names the varieties. The table
              answers it with the file's own values, and with the distinct count
              per column that actually decides it. */}
          <div className="mt-2">
            <AttributeTable design={design} setVarietyColumn={setVarietyColumn} />
          </div>

          {/* The field silently became the trial's outline the moment this file
              was read, and it moves again on every turn of the trial. Saying so
              here is the only place the user finds out why their drawn field is
              gone, and that Remove is what gives it back. */}
          <p className="mt-2 text-[10px] leading-snug text-neutral-500">
            The area measured is now the trial's outline, not the field you drew. Remove puts yours back.
          </p>
          {warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-amber-300/90">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {error && <p className="text-[11px] leading-snug text-rose-300">{error}</p>}
      <p className="text-[10px] text-neutral-600">Read in your browser. The file is not sent anywhere.</p>
    </div>
  );
}
