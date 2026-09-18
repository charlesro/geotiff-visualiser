import { useMemo, useState } from 'react';
import { Table2 } from 'lucide-react';
import { fmt } from '../util';
import { distinctValues } from '../design-import';
import type { ImportedDesign } from '../imported-types';

/**
 * How many rows are put in the DOM at once.
 *
 * A design may carry thousands of plots, and this table exists to let someone
 * recognise their own data, not to page through it: the first rows say what the
 * columns hold, and the per-column counts in the header describe all of them,
 * not just the ones drawn. The count is stated rather than implied, so nobody
 * reads a truncated table as the whole file.
 */
const MAX_ROWS = 200;

/**
 * A cell's text, with an empty value made visible.
 *
 * The reader stores '' for a null or missing attribute, and an empty table cell
 * is indistinguishable from one holding a space. A middle dot says the file had
 * nothing there, which is itself worth seeing when picking a variety column.
 */
const show = (v: string | undefined): string => (v === undefined || v === '' ? '\u00b7' : v);

/**
 * The imported file's attribute table, on demand.
 *
 * The page asks the user which column names the varieties, and before this it
 * asked blind: the dropdown lists column NAMES, and a file written by someone
 * else says nothing in its names. A column called "COL" holding 42 values that
 * repeat 25 times each, and one called "MGRS_TILE" holding the same string 998
 * times, are indistinguishable there, and picking the second silently makes the
 * whole trial one species.
 *
 * So each header carries the count that actually decides it: how many DISTINCT
 * values the column holds over every plot, with the degenerate cases named
 * outright. A column with one value cannot group anything; a column with as
 * many values as there are plots gives every plot its own variety. Clicking a
 * header picks that column, so the answer is one click from the evidence for it.
 */
export function AttributeTable({ design, setVarietyColumn }: {
  design: ImportedDesign;
  setVarietyColumn: (column: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { plots, columns } = design;

  /**
   * Distinct values per column, over EVERY plot, computed only while the table
   * is open: it is a full pass over the design (plots x columns) and the panel
   * re-renders on every keystroke elsewhere in step 3.
   */
  const distinct = useMemo(() => {
    if (!open) return null;
    const out: Record<string, number> = {};
    for (const c of columns) out[c] = distinctValues({ plots, columns }, c).size;
    return out;
  }, [open, plots, columns]);

  if (!columns.length) {
    return <p className="text-[10px] text-neutral-600">This file carries no attributes, so there is no table to show.</p>;
  }

  const rows = Math.min(plots.length, MAX_ROWS);

  return (
    <div>
      <button type="button" onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[10px] text-neutral-400 transition-colors hover:text-sky-200">
        <Table2 className="h-3 w-3" />
        {open ? 'Hide' : 'Show'} attributes
        <span className="text-neutral-600">
          {fmt(plots.length)} {plots.length === 1 ? 'row' : 'rows'} &times; {columns.length} {columns.length === 1 ? 'column' : 'columns'}
        </span>
      </button>

      {open && distinct && (
        <>
          <div className="mt-1.5 max-h-56 overflow-auto rounded border border-white/10 bg-black/20">
            <table className="w-max min-w-full border-collapse text-[10px]">
              <thead className="sticky top-0 z-10 bg-[#11151a]">
                <tr>
                  {/* Not a column of the file: the reader numbers the plots in the
                      order it read them, which is the order everything else uses. */}
                  <th className="border-b border-white/10 px-1.5 py-1 text-right font-normal text-neutral-600">#</th>
                  {columns.map(c => {
                    const n = distinct[c];
                    const isVariety = c === design.varietyColumn;
                    const note = n === 1 ? 'one value: cannot group the plots'
                      : n === plots.length ? 'all different: every plot its own variety'
                      : `${fmt(n)} distinct`;
                    return (
                      <th key={c} className="border-b border-white/10 p-0 text-left font-normal">
                        <button type="button" onClick={() => setVarietyColumn(c)}
                          title={`Use "${c}" as the variety column (${note})`}
                          className={`w-full cursor-pointer px-1.5 py-1 text-left transition-colors hover:bg-white/5 ${isVariety ? 'text-sky-300' : 'text-neutral-300 hover:text-sky-200'}`}>
                          <span className="block font-mono underline decoration-dotted decoration-white/25 underline-offset-2">{c}</span>
                          <span className={`block font-normal ${n === 1 ? 'text-amber-400/80' : isVariety ? 'text-sky-400/70' : 'text-neutral-600'}`}>
                            {n === 1 ? '1 value' : n === plots.length ? 'all different' : `${fmt(n)} distinct`}
                          </span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {plots.slice(0, rows).map((p, i) => (
                  <tr key={i} className="odd:bg-white/[0.02]">
                    <td className="px-1.5 py-0.5 text-right font-mono text-neutral-600">{i + 1}</td>
                    {columns.map(c => (
                      <td key={c}
                        title={p.props[c] || undefined}
                        className={`max-w-[12rem] truncate px-1.5 py-0.5 font-mono ${c === design.varietyColumn ? 'text-sky-200' : 'text-neutral-300'}`}>
                        {show(p.props[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[10px] text-neutral-600">
            {rows < plots.length
              ? <>First {fmt(rows)} of {fmt(plots.length)} rows. The counts in the header are over all {fmt(plots.length)}.</>
              : <>All {fmt(plots.length)} {plots.length === 1 ? 'row' : 'rows'}.</>}
            {' '}Click a column to use it as the variety.
          </p>
        </>
      )}
    </div>
  );
}
