import { runLocalQuery } from '../services/local-server';

/**
 * Growing-season detection from field-level NDVI phenology.
 *
 * The whole-year Sentinel-2 series mixes the declared crop with whatever else
 * occupied the field before/after it (a cover crop, bare soil). The crop code
 * is a constant annual declaration and can't separate them, but the NDVI curve
 * can: the declared crop is the year's main green-up→senescence cycle.
 *
 * For each selected field we read its NDVI series (from the parquet's
 * s2_mean_ndvi_<date> columns) and take the contiguous window around the year's
 * peak where NDVI stays above the half-max level — that isolates the main crop
 * cycle and drops separate off-season peaks. Per-field windows are pooled to a
 * robust (median) window per crop, and the crops' windows are intersected into
 * one shared date range where every selected field is in its main season.
 */

export interface SeasonWindow {
  start: string;
  end: string;
}

export interface GrowingSeasonResult {
  /** Shared overlap window across the selected crops, or null if they don't overlap. */
  window: SeasonWindow | null;
  /** Median growing window per crop (for display / the no-overlap message). */
  perSpecies: { species: string; window: SeasonWindow; fields: number }[];
  fieldsUsed: number;
  note?: string;
}

const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * One field's growing window, as [startIndex, endIndex] into the shared, sorted
 * date list. Two regimes, told apart by whether the field ever goes bare:
 *
 *  - Annual (a real off-season, NDVI → bare soil): the single canopy cycle
 *    around the year's peak. Bounded by the half-max level and stopped at the
 *    senescence trough, so the winter cover crop, spring bare soil and a fall
 *    cover crop are all left out — just the crop's own green cycle.
 *  - Perennial / grassland (never bare — luzerne, permanent pasture): the whole
 *    green period, hopping over the brief cut-dips, not one regrowth cycle.
 *
 * Returns null when too sparse.
 */
function detectFieldWindow(ndvi: (number | null)[]): [number, number] | null {
  const idx: number[] = [];
  for (let i = 0; i < ndvi.length; i++) {
    const v = ndvi[i];
    if (v != null && isFinite(v)) idx.push(i);
  }
  if (idx.length < 3) return null;
  let peakPos = 0;
  for (let k = 1; k < idx.length; k++) if ((ndvi[idx[k]] as number) > (ndvi[idx[peakPos]] as number)) peakPos = k;
  const peak = ndvi[idx[peakPos]] as number;
  let baseline = peak;
  for (const i of idx) baseline = Math.min(baseline, ndvi[i] as number);

  // A real off-season: NDVI at bare-soil level (< 0.3) for ≥ 2 acquisitions.
  let bare = false;
  let run = 0;
  for (const i of idx) {
    run = (ndvi[i] as number) < 0.3 ? run + 1 : 0;
    if (run >= 2) {
      bare = true;
      break;
    }
  }

  let s = peakPos;
  let e = peakPos;
  if (!bare) {
    // Perennial: keep the whole green span, hopping over a single cut-dip.
    const green = (k: number): boolean => k >= 0 && k < idx.length && (ndvi[idx[k]] as number) >= 0.3;
    while (s > 0 && (green(s - 1) || green(s - 2))) s -= green(s - 1) ? 1 : 2;
    while (e < idx.length - 1 && (green(e + 1) || green(e + 2))) e += green(e + 1) ? 1 : 2;
  } else {
    // Annual: expand from the peak while above half-max, stopping once NDVI has
    // fallen well below the peak and starts rising again (a neighbouring crop).
    const threshold = baseline + 0.5 * (peak - baseline);
    const low = 0.7 * peak;
    while (e < idx.length - 1) {
      const next = ndvi[idx[e + 1]] as number;
      const cur = ndvi[idx[e]] as number;
      if (next < threshold || (cur < low && next > cur + 0.03)) break;
      e++;
    }
    while (s > 0) {
      const prev = ndvi[idx[s - 1]] as number;
      const cur = ndvi[idx[s]] as number;
      if (prev < threshold || (cur < low && prev > cur + 0.03)) break;
      s--;
    }
  }
  return [idx[s], idx[e]];
}

/**
 * Pure core: turn NDVI query rows into the shared growing window. Each row has a
 * NewID and the s2_mean_ndvi_<date> columns; `fields` supplies the crop label per
 * NewID. Exported for testing without the engine.
 */
export function computeGrowingSeason(
  rows: any[],
  fields: { NewID: number | string; crp_lbl?: string }[]
): GrowingSeasonResult {
  if (rows.length === 0) throw new Error('No NDVI data found for the selected fields.');

  // Shared, sorted date axis from the NDVI column names.
  const dateCols = Object.keys(rows[0])
    .filter(k => /^s2_mean_ndvi_\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();
  const dates = dateCols.map(c => c.slice('s2_mean_ndvi_'.length));
  if (dates.length < 3) throw new Error('The dataset has too few NDVI dates to detect a season.');

  const speciesOf = new Map<string, string>();
  for (const f of fields) speciesOf.set(String(f.NewID), f.crp_lbl || 'Unknown');

  // Per-species pools of window start/end indices.
  const starts = new Map<string, number[]>();
  const ends = new Map<string, number[]>();
  let used = 0;
  for (const row of rows) {
    const series = dateCols.map(c => {
      const v = row[c];
      return typeof v === 'number' ? v : v == null ? null : Number(v);
    });
    const win = detectFieldWindow(series);
    if (!win) continue;
    used++;
    const sp = speciesOf.get(String(row.NewID)) || 'Unknown';
    if (!starts.has(sp)) {
      starts.set(sp, []);
      ends.set(sp, []);
    }
    starts.get(sp)!.push(win[0]);
    ends.get(sp)!.push(win[1]);
  }

  const perSpecies = [...starts.keys()].map(sp => ({
    species: sp,
    sIdx: median(starts.get(sp)!),
    eIdx: median(ends.get(sp)!),
    fields: starts.get(sp)!.length,
  }));

  const stripped = perSpecies.map(p => ({
    species: p.species,
    window: { start: dates[p.sIdx], end: dates[p.eIdx] },
    fields: p.fields,
  }));

  if (perSpecies.length === 0) {
    return { window: null, perSpecies: [], fieldsUsed: used, note: 'Could not detect a growing season from NDVI.' };
  }

  // Shared overlap: latest species-start to earliest species-end.
  const sharedStart = Math.max(...perSpecies.map(p => p.sIdx));
  const sharedEnd = Math.min(...perSpecies.map(p => p.eIdx));
  if (sharedStart > sharedEnd) {
    return {
      window: null,
      perSpecies: stripped,
      fieldsUsed: used,
      note: 'The selected crops’ seasons don’t overlap — no shared window.',
    };
  }
  return { window: { start: dates[sharedStart], end: dates[sharedEnd] }, perSpecies: stripped, fieldsUsed: used };
}

/**
 * Detect the shared growing-season window for a set of fields. `fields` pairs a
 * numeric NewID with its crop label (for the per-crop aggregation).
 */
export async function fetchGrowingSeasonWindow(
  baseUrl: string,
  parquetPath: string,
  fields: { NewID: number | string; crp_lbl?: string }[],
  signal?: AbortSignal
): Promise<GrowingSeasonResult> {
  const ids = Array.from(
    new Set(fields.map(f => String(f.NewID).trim()).filter(id => /^-?\d+$/.test(id)))
  );
  if (ids.length === 0) throw new Error('No fields with a numeric id to read NDVI for.');

  const data = await runLocalQuery(
    baseUrl,
    `SELECT NewID, COLUMNS('s2_mean_ndvi_[0-9]{4}-[0-9]{2}-[0-9]{2}')
     FROM read_parquet(${sqlString(parquetPath)})
     WHERE NewID IN (${ids.join(', ')});`,
    signal
  );
  return computeGrowingSeason(data.rows || [], fields);
}
