/**
 * Growing-season detection from NDVI phenology of the growth scenarios.
 *
 * The whole-year Sentinel-2 series mixes the declared crop with whatever else
 * occupied the field before/after it (a cover crop, bare soil). The crop code
 * is a constant annual declaration and can't separate them, but the NDVI curve
 * can: the declared crop is the year's main green-up→senescence cycle.
 *
 * We read that curve from the step-4 clusters — each scenario's mean interior
 * curve (its centroid) is a denoised signal, so a window is found where noisy
 * individual fields aren't identifiable. `detectFieldWindow` finds each
 * scenario's window; scenarios with no clear cycle are dropped, and the rest are
 * pooled per crop into the shared overlap (or used per-scenario when scoped).
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
  /** Window per growth scenario (cluster). `obvious` is false when the scenario's
   *  mean curve has no clear growth cycle and was dropped from the aggregate. */
  perCluster?: { species: string; cluster: number; window: SeasonWindow | null; obvious: boolean; size: number }[];
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
/** Minimum peak-to-baseline amplitude for a scenario's mean curve to count as
 *  having an obvious growth cycle (below this it's flat noise, unidentifiable). */
const OBVIOUS_AMPLITUDE = 0.25;

/**
 * Detect the growing season from the per-species k-means CLUSTERS instead of
 * per field. Each scenario's mean interior curve (the cluster centroid) is a
 * clean, denoised signal, so a window can be found where individual fields are
 * unidentifiable. Scenarios whose curve has no clear growth cycle are dropped;
 * each kept scenario gets its own window (per-cluster), and the kept scenarios
 * are pooled per crop into the shared overlap for a joint run.
 */
export function growingSeasonFromClusters(clustering: {
  groups: { species: string; centroids: number[][]; sizes: number[] }[];
  dates: string[];
}): GrowingSeasonResult {
  const dates = clustering.dates;
  if (dates.length < 3) {
    return { window: null, perSpecies: [], fieldsUsed: 0, perCluster: [], note: 'Too few dates in the fetched series — fetch more dates across the year.' };
  }
  const perField: { species: string; win: [number, number] }[] = [];
  const perCluster: NonNullable<GrowingSeasonResult['perCluster']> = [];
  for (const group of clustering.groups) {
    for (let c = 0; c < group.centroids.length; c++) {
      const centroid = group.centroids[c];
      let peak = -Infinity;
      let base = Infinity;
      for (const v of centroid) {
        if (isFinite(v)) {
          if (v > peak) peak = v;
          if (v < base) base = v;
        }
      }
      const hasGrowth = isFinite(peak) && peak - base >= OBVIOUS_AMPLITUDE;
      const win = hasGrowth ? detectFieldWindow(centroid) : null;
      perCluster.push({
        species: group.species,
        cluster: c,
        window: win ? { start: dates[win[0]], end: dates[win[1]] } : null,
        obvious: !!win,
        size: group.sizes[c] ?? 0,
      });
      if (win) perField.push({ species: group.species, win });
    }
  }
  if (perField.length === 0) {
    return { window: null, perSpecies: [], fieldsUsed: 0, perCluster, note: 'No scenario has an obvious growth cycle — cluster the fields (step 4) with a denser series.' };
  }
  return { ...aggregate(perField, dates), perCluster };
}
