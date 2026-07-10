/**
 * Growing-season detection from NDVI phenology of the interior pixels.
 *
 * The whole-year Sentinel-2 series mixes the declared crop with whatever else
 * occupied the field before/after it (a cover crop, bare soil). The crop code
 * is a constant annual declaration and can't separate them, but the NDVI curve
 * can: the declared crop is the year's main green-up→senescence cycle.
 *
 * We read that curve from the extracted INTERIOR pixels (the pure single-crop
 * signal, without the edge pixels' neighbour contamination), averaged per field.
 * `detectFieldWindow` then finds each field's window; per-field windows are
 * pooled to a robust (median) window per crop, and the crops' windows are
 * intersected into one shared date range where every field is in its main season.
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
    // Annual: cover the full canopy cycle — green-up through senescence — not
    // just the top of the peak. Expand from the peak down each limb to a low
    // fraction of the amplitude (0.35, well below half-max so the rising and
    // falling shoulders are included), stopping early only once NDVI has fallen
    // well below the peak and starts rising again — a neighbouring crop (winter
    // or fall cover crop) rather than this one.
    const threshold = baseline + 0.35 * (peak - baseline);
    const low = 0.75 * peak;
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

/** Pool per-field windows (indices into `dates`) into per-crop medians and the
 *  shared overlap across crops. */
function aggregate(perField: { species: string; win: [number, number] }[], dates: string[]): GrowingSeasonResult {
  const starts = new Map<string, number[]>();
  const ends = new Map<string, number[]>();
  for (const { species, win } of perField) {
    if (!starts.has(species)) {
      starts.set(species, []);
      ends.set(species, []);
    }
    starts.get(species)!.push(win[0]);
    ends.get(species)!.push(win[1]);
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
    return { window: null, perSpecies: [], fieldsUsed: 0, note: 'Could not detect a growing season.' };
  }
  const sharedStart = Math.max(...perSpecies.map(p => p.sIdx));
  const sharedEnd = Math.min(...perSpecies.map(p => p.eIdx));
  if (sharedStart > sharedEnd) {
    return {
      window: null,
      perSpecies: stripped,
      fieldsUsed: perField.length,
      note: 'The selected crops’ seasons don’t overlap — no shared window.',
    };
  }
  return { window: { start: dates[sharedStart], end: dates[sharedEnd] }, perSpecies: stripped, fieldsUsed: perField.length };
}

/**
 * Detect the shared growing window from the extracted INTERIOR pixels — the pure
 * single-crop signal, free of the edge pixels' neighbour contamination. Each
 * interior pixel carries <metric>_<date> values, a polygon_id and a species; we
 * average them per field into a clean NDVI curve, detect that field's window and
 * pool per crop. Uses only the dates actually fetched.
 */
export function growingSeasonFromInterior(features: any[], metric: string): GrowingSeasonResult {
  const prefix = `${metric}_`;
  const perFieldAgg = new Map<string, { species: string; sum: Map<string, number>; cnt: Map<string, number> }>();
  const allDates = new Set<string>();
  for (const f of features) {
    const p = f?.properties || {};
    if (p.type === 'buffer_boundary') continue;
    const key = String(p.polygon_id ?? p.__pid ?? p.NewID ?? '');
    if (key === '') continue;
    let agg = perFieldAgg.get(key);
    if (!agg) {
      agg = { species: String(p.species ?? p.crp_lbl ?? 'Unknown'), sum: new Map(), cnt: new Map() };
      perFieldAgg.set(key, agg);
    }
    for (const k of Object.keys(p)) {
      if (!k.startsWith(prefix)) continue;
      const d = k.slice(prefix.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const v = p[k];
      if (typeof v !== 'number' || !isFinite(v)) continue;
      agg.sum.set(d, (agg.sum.get(d) || 0) + v);
      agg.cnt.set(d, (agg.cnt.get(d) || 0) + 1);
      allDates.add(d);
    }
  }
  const dates = [...allDates].sort();
  if (dates.length < 3) {
    return {
      window: null,
      perSpecies: [],
      fieldsUsed: 0,
      note: 'Too few dates in the fetched series — fetch more dates across the year.',
    };
  }
  const perField: { species: string; win: [number, number] }[] = [];
  for (const agg of perFieldAgg.values()) {
    const series = dates.map(d => (agg.cnt.get(d) ? agg.sum.get(d)! / agg.cnt.get(d)! : null));
    const win = detectFieldWindow(series);
    if (win) perField.push({ species: agg.species, win });
  }
  if (perField.length === 0) {
    return { window: null, perSpecies: [], fieldsUsed: 0, note: 'Could not detect a growing season from the interior pixels.' };
  }
  return aggregate(perField, dates);
}
