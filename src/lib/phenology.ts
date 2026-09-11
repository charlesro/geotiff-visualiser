/**
 * Growing-season detection from the NDVI phenology of the growth scenarios.
 *
 * The whole-year Sentinel-2 series mixes the declared crop with whatever else
 * occupied the field before/after it (a cover crop, bare soil). The crop code
 * is a constant annual declaration and can't separate them, but the NDVI curve
 * can: the declared crop is the year's main green-up→senescence cycle.
 *
 * We read that curve from the clustering — each scenario's mean interior curve
 * (its centroid) is a denoised signal, so a window is found where noisy
 * individual fields aren't identifiable. `growingSeasonFromClusters` is the
 * entry point; it combines three stages:
 *
 *  1. `detectCoarseWindow` — a coarse foot-to-foot window from the centroid,
 *     with separate annual (goes bare) and perennial (never bare) regimes.
 *  2. `fitDoubleLogistic` — a Beck et al. (2006) double-logistic fitted to the
 *     centroid, seeded by that window, refining it to sub-day green-up and
 *     senescence bounds. Curves it can't model (multi-cut perennials) are
 *     flagged `poorFit` and keep the coarse window.
 *  3. `matchesCropCalendar` — compares the result to the crop's known Wallonia
 *     calendar (public/crop-calendars.json), so off-calendar scenarios (likely
 *     mislabels) can be dropped.
 *
 * Scenarios with no clear cycle are dropped; the rest are pooled per crop into
 * the shared overlap (or used per-scenario when the PCA is scoped to one).
 */

export interface SeasonWindow {
  start: string;
  end: string;
}

/** Known cultural calendar for a crop (from the researched knowledge base). The
 *  green window is the NDVI-visible canopy period; "none" for crops with no
 *  defined cycle (fallow, buffer strips, admin categories). */
export interface CropCalendar {
  regime: string;
  greenStart: string; // MM-DD or "none"
  greenEnd: string; // MM-DD or "none"
  peakStart?: string;
  peakEnd?: string;
}
export type CropCalendars = Record<string, CropCalendar>;

/** Fold a crp_lbl to a lookup key that survives apostrophe/accent/whitespace
 *  differences. The Walloon labels mix apostrophe encodings (a plain "'", the
 *  typographic curly quote, and a Windows-1252 mojibake control byte) across
 *  otherwise identical crops, so an exact-string match against the calendar
 *  keys would silently miss (→ "no calendar" → always matches → filter
 *  does nothing). */
function normalizeCropKey(s: string): string {
  const accents: Record<string, string> = { \u00e0: 'a', \u00e2: 'a', \u00e9: 'e', \u00e8: 'e', \u00ea: 'e', \u00eb: 'e', \u00ee: 'i', \u00ef: 'i', \u00f4: 'o', \u00fb: 'u', \u00f9: 'u', \u00e7: 'c' };
  return s
    .toLowerCase()
    // drop every apostrophe variant (plain, backtick, acute, curly quotes,
    // prime, and the Windows-1252 mojibake U+0091\u2013U+0094) so "d'hiver",
    // the curly-quote form and "dhiver" all fold to the same key.
    .replace(/['`\u00b4\u2018\u2019\u2032\u0091\u0092\u0093\u0094]/g, '')
    .replace(/[\u00e0\u00e2\u00e9\u00e8\u00ea\u00eb\u00ee\u00ef\u00f4\u00fb\u00f9\u00e7]/g, m => accents[m] ?? m)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// --- exact civil-date arithmetic (Howard Hinnant's algorithms) --------------
// The time axis must be strictly increasing and injective: two acquisitions can
// never share a coordinate. A 365-day day-of-year approximation collides
// 29 February with 1 March, silently dropping an observation from the charts'
// date lookup, so every date in this module goes through these instead —
// including the crop calendars, whose bare MM-DD windows are instantiated in a
// real year before being compared.

/** Days from 1970-01-01 for a proleptic Gregorian y-m-d. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of `daysFromCivil`. */
function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

/**
 * The module's time axis: an exact day count, 1 on 1 January of `baseYear`.
 * Day-of-year alone wraps at 1 January, which would make a series spanning the
 * new year run backwards and collide acquisitions a year apart. Detection,
 * fitting and the charts all share this axis. For a series inside a single
 * non-leap year it is numerically identical to the day-of-year.
 */
export function dayIndex(date: string, baseYear: number): number | null {
  const m = /(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return daysFromCivil(Number(m[1]), mm, dd) - daysFromCivil(baseYear, 1, 1) + 1;
}

/** Inverse of `dayIndex`. */
export function dayIndexToDate(day: number, baseYear: number): string {
  const [y, m, d] = civilFromDays(daysFromCivil(baseYear, 1, 1) + Math.round(day) - 1);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The year a series is anchored on — the year of its first acquisition. */
const baseYearOf = (dates: string[]): number => Number((dates[0] ?? '2021').slice(0, 4)) || 2021;

/** Tolerance (days) around the calendar peak window when checking the detected
 *  peak — accounts for year-to-year and detection slack. */
const PEAK_TOLERANCE_DAYS = 21;

/**
 * Does a detected NDVI scenario match the crop's known Wallonia calendar? Two
 * necessary conditions, so a scenario growing in the wrong season is dropped:
 *
 *  1. Green-window overlap — the detected [start,end] must overlap the crop's
 *     green window by at least half of the shorter one (broadly in-season).
 *  2. Peak timing — when the calendar defines a peak window and the scenario's
 *     greenest date is known, that peak must fall within the calendar peak
 *     (±tolerance). This is what separates a winter cereal (peaks May–Jun) from
 *     a summer crop like maize (peaks Jul–Aug) whose green windows still overlap.
 *
 * Crops with no calendar (fallow, strips, "none") always match; a missing peak
 * (perennials, some vegetables) falls back to the overlap test alone.
 */
function matchesCropCalendar(
  detectedStart: string,
  detectedEnd: string,
  cal: CropCalendar | undefined,
  detectedPeak?: string
): boolean {
  if (!cal || cal.greenStart === 'none' || cal.greenEnd === 'none') return true;
  // Compare on the exact day axis, never day-of-year. A window crossing 1 January
  // runs backwards in day-of-year, and waving those through would skip the check
  // on exactly the series shape (winter crops fetched across the new year) that
  // this module exists to support.
  const y0 = Number(detectedStart.slice(0, 4));
  const ds = dayIndex(detectedStart, y0);
  const de = dayIndex(detectedEnd, y0);
  if (ds == null || de == null || de <= ds) return true;

  // The calendar is a bare MM-DD window with no year. Instantiate it in the
  // neighbouring years and keep the best agreement, so a detected window that
  // straddles the new year is still compared against the right season.
  const years = [y0 - 1, y0, y0 + 1];
  let bestOverlap = 0;
  for (const y of years) {
    const ks = dayIndex(`${y}-${cal.greenStart}`, y0);
    const ke = dayIndex(`${y}-${cal.greenEnd}`, y0);
    if (ks == null || ke == null || ke < ks) continue;
    const overlap = Math.max(0, Math.min(de, ke) - Math.max(ds, ks));
    const shorter = Math.max(1, Math.min(de - ds, ke - ks));
    bestOverlap = Math.max(bestOverlap, overlap / shorter);
  }
  if (bestOverlap < 0.5) return false;

  // Peak test — only when both the calendar and the detection provide one. This
  // is what separates a winter cereal (peaks May–Jun) from a summer crop like
  // maize (peaks Jul–Aug) whose green windows still overlap.
  const pk = detectedPeak ? dayIndex(detectedPeak, y0) : null;
  if (cal.peakStart && cal.peakEnd && pk != null) {
    const inSomeYear = years.some(y => {
      const ps = dayIndex(`${y}-${cal.peakStart}`, y0);
      const pe = dayIndex(`${y}-${cal.peakEnd}`, y0);
      return ps != null && pe != null && pe >= ps && pk >= ps - PEAK_TOLERANCE_DAYS && pk <= pe + PEAK_TOLERANCE_DAYS;
    });
    if (!inSomeYear) return false;
  }
  return true;
}

export interface GrowingSeasonResult {
  /** Shared overlap window across the selected crops, or null if they don't overlap. */
  window: SeasonWindow | null;
  /** Median growing window per crop (for display / the no-overlap message). */
  perSpecies: { species: string; window: SeasonWindow; fields: number }[];
  /** How many growth scenarios (not fields) were pooled into `window`. */
  scenariosUsed: number;
  /** Window per growth scenario (cluster); `window` is null when the scenario's
   *  mean curve has no clear growth cycle. `matchesCalendar` compares the detected
   *  window to the crop's known calendar (`expected`); false = off-calendar. */
  perCluster?: {
    species: string;
    cluster: number;
    window: SeasonWindow | null;
    size: number;
    expected?: SeasonWindow | null;
    matchesCalendar?: boolean;
    /** Set when the window came from the user rather than being derived. */
    picked?: boolean;
    /** Why no model is shown, when there is a window but no fit. */
    fitNote?: string;
    /** Double-logistic fit of the scenario's centroid (null when it has no clear
     *  cycle; `poorFit` when a single sigmoid pair can't model it — a perennial).
     *  `params` drive the smooth curve overlay; `sos`/`eos` are the fit-refined
     *  season bounds (day-of-year). */
    fit?: {
      params: DLParams;
      sos: number;
      eos: number;
      r2: number;
      confidence: 'high' | 'medium' | 'low';
      poorFit: boolean;
    } | null;
  }[];
  note?: string;
}

/**
 * Median weighted by how many fields each scenario represents — the value where
 * the cumulative weight crosses half the total. Scenarios are not equally
 * important: a 200-field scenario describes the crop far better than a 3-field
 * outlier, and an unweighted median would let the two cancel each other out.
 */
const weightedMedian = (values: number[], weights: number[]): number => {
  const items = values
    .map((value, i) => ({ value, weight: Math.max(0, Number.isFinite(weights[i]) ? weights[i] : 0) }))
    .filter(x => x.weight > 0) // a scenario describing no field must not vote
    .sort((a, b) => a.value - b.value);
  if (items.length === 0) {
    // No usable weights — fall back to the plain median of the raw values.
    const s = [...values].filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (s.length === 0) return 0;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const total = items.reduce((t, x) => t + x.weight, 0);
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    acc += items[i].weight;
    // An exact half-weight tie has two equally valid middles; average them, so
    // that with equal weights this degenerates to the plain median rather than
    // always picking the lower value (which biased every pooled window earlier).
    if (acc * 2 === total && i + 1 < items.length) return (items[i].value + items[i + 1].value) / 2;
    if (acc * 2 > total) return items[i].value;
  }
  return items[items.length - 1].value;
};

/**
 * NDVI at or below which a field reads as bare soil rather than canopy. Both the
 * "does this crop have a real off-season" test and the perennial green-span walk
 * use it, and they must agree: a threshold that calls a gap bare while the walk
 * still calls it green would produce a window with no consistent meaning.
 */
const BARE_SOIL_NDVI = 0.3;

/**
 * One field's growing window, as [startIndex, endIndex] into the shared, sorted
 * date list. Two regimes, told apart by whether the field ever goes bare:
 *
 *  - Annual (a real off-season, NDVI → bare soil): the single canopy cycle
 *    around the year's peak — flat baseline → green-up (positive sigmoid) → peak
 *    plateau → senescence (negative sigmoid) → baseline. Bounded at the foot of
 *    each sigmoid, so the whole rising and falling limbs are kept while the winter
 *    cover crop, spring bare soil and a fall cover crop are left out.
 *  - Perennial / grassland (never bare — luzerne, permanent pasture): the whole
 *    green period, hopping over the brief cut-dips, not one regrowth cycle.
 *
 * Returns null when too sparse.
 */
function detectCoarseWindow(ndvi: (number | null)[]): [number, number] | null {
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

  // A real off-season: NDVI at bare-soil level for ≥ 2 acquisitions.
  let bare = false;
  let run = 0;
  for (const i of idx) {
    run = (ndvi[i] as number) < BARE_SOIL_NDVI ? run + 1 : 0;
    if (run >= 2) {
      bare = true;
      break;
    }
  }

  let s = peakPos;
  let e = peakPos;
  if (!bare) {
    // Perennial: keep the whole green span, hopping over a single cut-dip.
    const green = (k: number): boolean =>
      k >= 0 && k < idx.length && (ndvi[idx[k]] as number) >= BARE_SOIL_NDVI;
    while (s > 0 && (green(s - 1) || green(s - 2))) s -= green(s - 1) ? 1 : 2;
    while (e < idx.length - 1 && (green(e + 1) || green(e + 2))) e += green(e + 1) ? 1 : 2;
  } else {
    // Annual: the growing season is the sigmoid-to-sigmoid span around the peak —
    // a flat baseline, a green-up (positive sigmoid), a peak plateau, then
    // senescence (negative sigmoid) back to baseline. Walk out from the peak while
    // NDVI stays above a low fraction of the amplitude (the plateau + most of each
    // limb), then step ONE point further to the foot of each sigmoid — the
    // near-baseline point at the base of the rise / fall — so the green-up and
    // senescence limbs are included, not just the plateau (the previous 0.35
    // threshold stopped at the shoulder and clipped the whole rising limb).
    // Stop early at a renewed rise below the peak (`low`) — a neighbouring crop
    // (winter or fall cover) — and don't step onto it.
    const foot = baseline + 0.2 * (peak - baseline);
    const low = baseline + 0.6 * (peak - baseline);
    while (e < idx.length - 1) {
      const next = ndvi[idx[e + 1]] as number;
      const cur = ndvi[idx[e]] as number;
      if (next <= foot || (cur < low && next > cur + 0.03)) break;
      e++;
    }
    // Include the foot of the falling limb — but not a rising neighbour.
    if (e < idx.length - 1 && (ndvi[idx[e + 1]] as number) < (ndvi[idx[e]] as number)) e++;
    while (s > 0) {
      const prev = ndvi[idx[s - 1]] as number;
      const cur = ndvi[idx[s]] as number;
      if (prev <= foot || (cur < low && prev > cur + 0.03)) break;
      s--;
    }
    // Include the foot of the rising limb — but not an earlier rising neighbour.
    if (s > 0 && (ndvi[idx[s - 1]] as number) < (ndvi[idx[s]] as number)) s--;
  }
  return [idx[s], idx[e]];
}

/** Pool per-scenario windows (day-of-year) into per-crop medians and the shared
 *  overlap across crops, then format the day-of-year bounds back to dates. */
function aggregate(perScenario: { species: string; startDoy: number; endDoy: number; size: number }[], baseYear: number): GrowingSeasonResult {
  const starts = new Map<string, number[]>();
  const ends = new Map<string, number[]>();
  const sizes = new Map<string, number[]>();
  for (const { species, startDoy, endDoy, size } of perScenario) {
    if (!starts.has(species)) {
      starts.set(species, []);
      ends.set(species, []);
      sizes.set(species, []);
    }
    starts.get(species)!.push(startDoy);
    ends.get(species)!.push(endDoy);
    sizes.get(species)!.push(size);
  }
  const perSpecies = [...starts.keys()].map(sp => ({
    species: sp,
    sDoy: weightedMedian(starts.get(sp)!, sizes.get(sp)!),
    eDoy: weightedMedian(ends.get(sp)!, sizes.get(sp)!),
    fields: sizes.get(sp)!.reduce((t, n) => t + n, 0),
  }));
  const stripped = perSpecies.map(p => ({
    species: p.species,
    window: { start: dayIndexToDate(p.sDoy, baseYear), end: dayIndexToDate(p.eDoy, baseYear) },
    fields: p.fields,
  }));
  if (perSpecies.length === 0) {
    return { window: null, perSpecies: [], scenariosUsed: 0, note: 'Could not detect a growing season.' };
  }
  const sharedStart = Math.max(...perSpecies.map(p => p.sDoy));
  const sharedEnd = Math.min(...perSpecies.map(p => p.eDoy));
  if (sharedStart > sharedEnd) {
    return {
      window: null,
      perSpecies: stripped,
      scenariosUsed: perScenario.length,
      note: 'The selected crops’ seasons don’t overlap — no shared window.',
    };
  }
  return { window: { start: dayIndexToDate(sharedStart, baseYear), end: dayIndexToDate(sharedEnd, baseYear) }, perSpecies: stripped, scenariosUsed: perScenario.length };
}

/** Minimum peak-to-baseline amplitude for a scenario's mean curve to count as
 *  having an obvious growth cycle (below this it's flat noise, unidentifiable). */
const OBVIOUS_AMPLITUDE = 0.25;

/** The double-logistic's free parameter count (wmin, amplitude, mS, S, mA, A). */
const DL_PARAM_COUNT = 6;

/**
 * Acquisitions a fit needs before it can be trusted. At exactly DL_PARAM_COUNT
 * points the model interpolates the data exactly — residuals are identically
 * zero, so R² is 1 and every residual-based quality gate is structurally unable
 * to reject, however wrong the recovered parameters are. Two spare observations
 * is the minimum that makes the residuals mean anything. This is the bar for
 * letting a fit INFLUENCE a window it did not get from the user — the fitter's
 * own floor is the laxer `MIN_SHAPE_POINTS` below.
 */
const MIN_FIT_POINTS = DL_PARAM_COUNT + 2;

/**
 * Minimum points to fit a curve whose WINDOW the user supplied.
 *
 * The stricter threshold above exists because a weakly-identified fit used to be
 * allowed to move the season bounds. When the bounds are marked by hand the fit
 * can no longer do that — it only describes the shape inside them — so a lower
 * bar is safe, and necessary: a summer window in a 9-date yearly series holds
 * four or five acquisitions, and demanding eight would mean never fitting at
 * all. The double-logistic is inherently smooth and single-peaked, so even an
 * exactly-determined fit draws a sensible curve; `confidence` reports the thin
 * evidence via the degrees of freedom. It never goes below the parameter count —
 * fewer points than parameters is not a fit, it is an underdetermined system.
 */
const MIN_SHAPE_POINTS = DL_PARAM_COUNT;

/** Median spacing between acquisitions (days) — the natural slack when deciding
 *  how far past its data a fit may place a season bound. */
function revisitGap(days: (number | null)[]): number {
  const gaps: number[] = [];
  let prev: number | null = null;
  for (const d of days) {
    if (d == null || !isFinite(d)) continue;
    if (prev != null) gaps.push(d - prev);
    prev = d;
  }
  if (gaps.length === 0) return 10;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

/**
 * Resolve a species name to its known calendar. The parcel database's `crp_lbl`
 * carries a mojibake apostrophe and inconsistent accents, so both sides are put
 * through `normalizeCropKey` rather than compared literally.
 *
 * Returns both the raw entry (for the overlap test) and the `expected` window
 * the charts draw as a guide — "none" means the crop has no growth window worth
 * drawing (permanent grassland, bare fallow) and yields null.
 */
export function calendarLookup(calendars?: Record<string, CropCalendar>) {
  const byNorm = calendars
    ? new Map(Object.entries(calendars).map(([k, v]) => [normalizeCropKey(k), v]))
    : null;
  return (species: string) => {
    const cal = byNorm?.get(normalizeCropKey(species)) ?? null;
    const expected: SeasonWindow | null =
      cal && cal.greenStart !== 'none' ? { start: cal.greenStart, end: cal.greenEnd } : null;
    return { cal, expected };
  };
}

/**
 * Detect the growing season from the per-species k-means CLUSTERS instead of
 * per field. Each scenario's mean interior curve (the cluster centroid) is a
 * clean, denoised signal, so a window can be found where individual fields are
 * unidentifiable. Scenarios whose curve has no clear growth cycle are dropped;
 * each kept scenario gets its own window (per-cluster), and the kept scenarios
 * are pooled per crop into the shared overlap for a joint run.
 */
export function growingSeasonFromClusters(
  clustering: {
    groups: { species: string; centroids: number[][]; sizes: number[] }[];
    dates: string[];
  },
  opts: {
    /** Keep only the N most-represented scenarios per species (sorted biggest-
     *  first). Default: all. */
    maxPerSpecies?: number;
    /** Known crop calendars, keyed by crp_lbl, to flag/drop off-calendar scenarios. */
    calendars?: CropCalendars;
  } = {}
): GrowingSeasonResult {
  const maxPerSpecies = opts.maxPerSpecies ?? Infinity;
  const dates = clustering.dates;
  if (dates.length < 3) {
    return { window: null, perSpecies: [], scenariosUsed: 0, perCluster: [], note: 'Too few dates in the fetched series — fetch more dates across the year.' };
  }
  // Effective per-scenario windows pooled per crop, in day-of-year (continuous,
  // so the fit-refined bounds aren't snapped to the sparse acquisition dates).
  const perScenario: { species: string; startDoy: number; endDoy: number; size: number }[] = [];
  const perCluster: NonNullable<GrowingSeasonResult['perCluster']> = [];
  const baseYear = baseYearOf(dates);
  const doys = dates.map(d => dayIndex(d, baseYear));
  // Same axis with unparseable dates as NaN — the fitter drops non-finite points.
  const fitDoys = doys.map(d => d ?? NaN);
  const lookupCalendar = calendarLookup(opts.calendars);
  for (const group of clustering.groups) {
    const { cal, expected } = lookupCalendar(group.species);
    const keep = Math.min(group.centroids.length, maxPerSpecies);
    for (let c = 0; c < keep; c++) {
      // k-means can leave a cluster empty; its centroid is a leftover seed that
      // describes no field, so it must neither be reported nor vote.
      const size = group.sizes[c] ?? 0;
      if (size <= 0) continue;
      const centroid = group.centroids[c];
      let peak = -Infinity;
      let peakIdx = -1;
      let base = Infinity;
      for (let i = 0; i < centroid.length; i++) {
        const v = centroid[i];
        if (isFinite(v)) {
          if (v > peak) {
            peak = v;
            peakIdx = i;
          }
          if (v < base) base = v;
        }
      }
      const hasGrowth = isFinite(peak) && peak - base >= OBVIOUS_AMPLITUDE;
      const win = hasGrowth ? detectCoarseWindow(centroid) : null;

      // Fit a double-logistic to the centroid, seeded by the heuristic
      // [start, peak, end] window. The fit gives a smooth flat→green-up→plateau→
      // senescence model and refined foot-to-foot bounds (sos/eos).
      //
      // Prefer to fit only the dates INSIDE the heuristic window. That window is
      // there precisely because the rest of the year belongs to something else
      // (a cover crop, bare soil); one sigmoid pair cannot represent two bumps,
      // so feeding it the whole series inflates the residual until the `poorFit`
      // gate rejects it — throwing the refinement away on exactly the mixed-crop
      // fields this module exists to untangle.
      //
      // A sparse series can leave too few in-window acquisitions to identify six
      // parameters, though; there a starved fit is worse than a contaminated one,
      // so we fall back to the full series.
      let fit: NonNullable<GrowingSeasonResult['perCluster']>[number]['fit'] = null;
      /** The span the fit actually saw — outside it the sigmoid tails are pure
       *  extrapolation, so the refined bounds must not wander past it. */
      let fitSupport: [number, number] | null = null;
      if (win && peakIdx >= 0) {
        const sd = doys[win[0]];
        const pd = doys[peakIdx];
        const ed = doys[win[1]];
        if (sd != null && pd != null && ed != null) {
          const masked = fitDoys.map((t, i) => (i >= win[0] && i <= win[1] ? t : NaN));
          const usable = masked.filter((t, i) => isFinite(t) && isFinite(centroid[i])).length;
          const useMask = usable >= MIN_FIT_POINTS;
          fitSupport = useMask ? [sd, ed] : [doys[0] ?? sd, doys[dates.length - 1] ?? ed];
          const f = fitDoubleLogistic(useMask ? masked : fitDoys, centroid, [sd, pd, ed]);
          fit = {
            params: f.params, sos: f.sos, eos: f.eos,
            r2: f.r2, confidence: f.confidence, poorFit: f.poorFit,
          };
        }
      }

      // Effective window: the fit-refined bounds when the fit is good, else the
      // heuristic foot-to-foot window. The refined bounds are clamped to the span
      // the fit actually saw (plus one revisit gap of slack, so a foot that
      // genuinely sits just outside the coarse window is still reachable) — NOT
      // to the whole series. Beyond its support the model is unconstrained
      // extrapolation, and letting that become the analysis window was measurably
      // worse than not refining at all.
      let window: SeasonWindow | null = win ? { start: dates[win[0]], end: dates[win[1]] } : null;
      let effDoys: [number, number] | null =
        win && doys[win[0]] != null && doys[win[1]] != null ? [doys[win[0]]!, doys[win[1]]!] : null;
      const lo = doys[0];
      const hi = doys[dates.length - 1];
      // Only a fit with spare observations may MOVE the window. The fitter's own
      // floor is the parameter count, which is enough to draw a curve inside a
      // window the user marked, but not enough to be trusted to relocate one:
      // at that point the model interpolates and the residuals cannot object.
      // `confidence` is 'low' exactly when the degrees of freedom are too thin.
      if (win && fit && !fit.poorFit && fit.confidence !== 'low' && fitSupport && lo != null && hi != null) {
        const slack = revisitGap(doys);
        const bLo = Math.max(lo, fitSupport[0] - slack);
        const bHi = Math.min(hi, fitSupport[1] + slack);
        const sos = Math.max(bLo, Math.min(bHi, fit.sos));
        const eos = Math.max(bLo, Math.min(bHi, fit.eos));
        if (eos > sos) {
          window = { start: dayIndexToDate(sos, baseYear), end: dayIndexToDate(eos, baseYear) };
          effDoys = [sos, eos];
        }
      }

      const peakDate = peakIdx >= 0 ? dates[peakIdx] : undefined;
      const matchesCalendar = window ? matchesCropCalendar(window.start, window.end, cal, peakDate) : true;
      perCluster.push({
        species: group.species,
        cluster: c,
        window,
        size,
        expected,
        matchesCalendar,
        fit,
      });
      if (win && effDoys) {
        perScenario.push({ species: group.species, startDoy: effDoys[0], endDoy: effDoys[1], size });
      }
    }
  }
  if (perScenario.length === 0) {
    const note = 'No scenario has an obvious growth cycle — cluster the fields (step 4) with a denser series.';
    return { window: null, perSpecies: [], scenariosUsed: 0, perCluster, note };
  }
  return { ...aggregate(perScenario, baseYear), perCluster };
}

/** Key for one scenario's picked window. */
export const pickKey = (species: string, cluster: number) => `${species}\u0000${cluster}`;

/** Growing seasons the user marked on the charts, in absolute day index. */
export type SeasonPicks = Record<string, { start: number; end: number }>;

/** The minimum share of a scenario's fields that must carry over for a mark to follow it. */
const PICK_CARRYOVER = 0.5;

type PickClustering = {
  groups: { species: string; fields: { key: string; cluster: number }[] }[];
  dates: string[];
};

/**
 * Carry the marks across a re-clustering.
 *
 * A mark is stored as (species, cluster index) → absolute day index, and BOTH
 * halves of that are relative to the clustering it was made on. `clusterBySpecies`
 * relabels clusters by descending size, so one extra date can swap scenario 2 and
 * 3 and silently move a window onto a different crop cycle; and the day axis is
 * anchored to the first date in the series, so inserting an earlier acquisition
 * shifts every index by a year. Both are re-derived here from what the scenario
 * actually *is* — the set of fields in it — rather than from its position:
 * clusters are matched by Jaccard overlap of field keys, and a mark is dropped
 * when its scenario did not survive rather than being applied to a stranger.
 */
export function remapSeasonPicks(prev: PickClustering, next: PickClustering, picks: SeasonPicks): SeasonPicks {
  if (Object.keys(picks).length === 0) return picks;
  // Re-anchor the day axis first: both ends of a window move together.
  const shift =
    daysFromCivil(baseYearOf(prev.dates), 1, 1) - daysFromCivil(baseYearOf(next.dates), 1, 1);

  const membersOf = (c: PickClustering, species: string) => {
    const fields = c.groups.find(g => g.species === species)?.fields ?? [];
    const byCluster = new Map<number, Set<string>>();
    for (const f of fields) {
      if (!byCluster.has(f.cluster)) byCluster.set(f.cluster, new Set());
      byCluster.get(f.cluster)!.add(f.key);
    }
    return byCluster;
  };

  // Walk the OLD clustering rather than parsing the keys back apart: the key is
  // an opaque join of species and index, and a species name can contain anything.
  const out: SeasonPicks = {};
  for (const group of prev.groups) {
    const before = membersOf(prev, group.species);
    const after = membersOf(next, group.species);
    for (const [cluster, was] of before) {
      const win = picks[pickKey(group.species, cluster)];
      if (!win || was.size === 0) continue;

      let bestCluster = -1;
      let bestScore = 0;
      for (const [ci, now] of after) {
        let shared = 0;
        for (const k of now) if (was.has(k)) shared++;
        const jaccard = shared / (was.size + now.size - shared);
        if (jaccard > bestScore) {
          bestScore = jaccard;
          bestCluster = ci;
        }
      }
      if (bestCluster < 0 || bestScore < PICK_CARRYOVER) continue; // no clear successor
      out[pickKey(group.species, bestCluster)] = { start: win.start + shift, end: win.end + shift };
    }
  }
  return out;
}

/**
 * Build the season from windows the USER marked on each scenario's curve.
 *
 * Reading the season off a sparse series automatically is unreliable — with
 * month-long gaps between acquisitions the green-up is simply not identifiable,
 * and no constraint recovers information the data doesn't carry. So the window
 * is an input here, not an output: the user marks where growth starts and ends,
 * and the double-logistic is fitted to the observations inside that window to
 * describe its shape. A scenario with no pick contributes nothing.
 */
export function seasonFromPicks(
  clustering: {
    groups: { species: string; centroids: number[][]; sizes: number[] }[];
    dates: string[];
  },
  picks: SeasonPicks,
  opts: { maxPerSpecies?: number; calendars?: CropCalendars; matchOnly?: boolean } = {}
): GrowingSeasonResult {
  const maxPerSpecies = opts.maxPerSpecies ?? Infinity;
  const dates = clustering.dates;
  if (dates.length < 3) {
    return { window: null, perSpecies: [], scenariosUsed: 0, perCluster: [], note: 'Too few dates in the fetched series — fetch more dates across the year.' };
  }
  const baseYear = baseYearOf(dates);
  const days = dates.map(d => dayIndex(d, baseYear));
  const fitDays = days.map(d => d ?? NaN);
  const lookupCalendar = calendarLookup(opts.calendars);

  const perScenario: { species: string; startDoy: number; endDoy: number; size: number }[] = [];
  const perCluster: NonNullable<GrowingSeasonResult['perCluster']> = [];

  for (const group of clustering.groups) {
    const { cal, expected } = lookupCalendar(group.species);
    const keep = Math.min(group.centroids.length, maxPerSpecies);
    for (let c = 0; c < keep; c++) {
      const size = group.sizes[c] ?? 0;
      if (size <= 0) continue; // an empty k-means cluster describes no field
      const centroid = group.centroids[c];
      const pick = picks[pickKey(group.species, c)];
      const base = { species: group.species, cluster: c, size, expected };

      if (!pick || !(pick.end > pick.start)) {
        perCluster.push({ ...base, window: null, picked: false, fit: null });
        continue;
      }

      const window = { start: dayIndexToDate(pick.start, baseYear), end: dayIndexToDate(pick.end, baseYear) };

      // Fit only the observations the user enclosed — that span is the season.
      const masked = fitDays.map(t => (t >= pick.start && t <= pick.end ? t : NaN));
      const usable = masked.filter((t, i) => isFinite(t) && isFinite(centroid[i])).length;

      // Peak inside the picked window, for the calendar's peak-timing test.
      let peakIdx = -1;
      let peak = -Infinity;
      for (let i = 0; i < centroid.length; i++) {
        const t = days[i];
        if (t == null || t < pick.start || t > pick.end) continue;
        if (isFinite(centroid[i]) && centroid[i] > peak) {
          peak = centroid[i];
          peakIdx = i;
        }
      }
      const peakDate = peakIdx >= 0 ? dates[peakIdx] : undefined;

      let fit: NonNullable<GrowingSeasonResult['perCluster']>[number]['fit'] = null;
      let fitNote: string | undefined;
      if (usable >= MIN_SHAPE_POINTS) {
        const seedPeak = peakIdx >= 0 ? days[peakIdx]! : (pick.start + pick.end) / 2;
        // The model carries no baseline — both limbs decay to zero — so it is
        // fitted to the window's growth signal, not to raw VI sitting on a soil
        // floor. Feeding it the raw curve costs the whole baseline in residual.
        const zeroed = growthSignal(days, centroid, { start: pick.start, end: pick.end });
        const f = fitDoubleLogistic(masked, zeroed.map(v => v ?? NaN), [pick.start, seedPeak, pick.end]);
        if (f.poorFit) {
          fitNote = 'the curve in this window is not a single growth cycle';
        } else {
          fit = { params: f.params, sos: f.sos, eos: f.eos, r2: f.r2, confidence: f.confidence, poorFit: false };
        }
      } else {
        fitNote = `only ${usable} acquisition(s) inside the window — at least ${MIN_SHAPE_POINTS} are needed to draw a curve`;
      }

      const matchesCalendar = matchesCropCalendar(window.start, window.end, cal, peakDate);
      perCluster.push({ ...base, window, picked: true, matchesCalendar, fit, fitNote });
      if (!opts.matchOnly || matchesCalendar) {
        perScenario.push({ species: group.species, startDoy: pick.start, endDoy: pick.end, size });
      }
    }
  }

  if (perScenario.length === 0) {
    const anyPicked = perCluster.some(p => p.picked);
    return {
      window: null,
      perSpecies: [],
      scenariosUsed: 0,
      perCluster,
      note: anyPicked
        ? 'No marked scenario matches its crop’s known calendar — loosen the filter or revisit the marks.'
        : 'Mark the growing season on a scenario’s curve to use it.',
    };
  }
  return { ...aggregate(perScenario, baseYear), perCluster };
}

// ============================================================================
// Double-logistic (Beck et al. 2006) fit for sparse Sentinel-2 NDVI.
//
//   f(t) = a + b * ( 1/(1+exp(-d*(t-c))) + 1/(1+exp(f*(t-e))) - 1 )
//
// The parameters below are that equation, named for what they mean:
//
//   a = wmin            baseline (bare soil)
//   b = wmax - wmin     amplitude
//   c = S               green-up inflection day
//   d = mS              green-up rate
//   e = A               senescence inflection day
//   f = mA              senescence rate
//
// Engine: Nelder-Mead simplex (derivative-free, so no Jacobian and no linear
// algebra) with a deterministic multi-start. Constraints are enforced by
// REPARAMETERIZATION (softplus), never penalties, so the simplex can never step
// into an invalid region (b > 0, d,f > 0, e > c).
// ============================================================================

/** Fitted parameters of `f(t) = a + b*(1/(1+exp(-d*(t-c))) + 1/(1+exp(f*(t-e))) - 1)`.
 *  `a = wmin`, `b = wmax - wmin`, `c = S`, `d = mS`, `e = A`, `f = mA`. */
/**
 * The double-logistic parameters, named as in the governing equation.
 *
 *   g(t)  = L1 / (1 + e^(−k1 (t − x01)))          rising limb
 *   d(t)  = L1 − L1 / (1 + e^(−k2 (t − x02)))     falling limb
 *   b(t)  = 1 / (1 + e^(−(t − tc) / 2.5))         blend weight
 *   f(t)  = (1 − b(t))·g(t) + b(t)·d(t)
 *   VI(t) = clamp( f(t) + f(t−365) + f(t+365), 1e-9, 1−1e-9 )
 *
 * There is no baseline term: the curve decays to zero either side, which is what
 * the plant period's zeroed signal is fitted against.
 */
export interface DLParams {
  /** PEAK — the maximum value of the curve. */
  L1: number;
  /** GROWTH — green-up rate. Positive. */
  k1: number;
  /** START — green-up inflection day. */
  x01: number;
  /** DECAY — senescence rate. Positive; the limb falls because d(t) subtracts. */
  k2: number;
  /** END — senescence inflection day. */
  x02: number;
  /** OFFSET — the day the blend hands over from green-up to senescence. */
  tc: number;
}

interface DLFit {
  params: DLParams;
  /** Fit quality: absolute error, and the share of variance explained. */
  rmse: number;
  r2: number;
  /** Season bounds on the same absolute-day axis as the input `days`. */
  sos: number;
  eos: number;
  confidence: 'high' | 'medium' | 'low';
  /** A single sigmoid pair can't describe this curve (a multi-cut perennial, or
   *  too few points) — the caller should keep its coarse window. */
  poorFit: boolean;
}

const LN4 = Math.log(4);

// numerically-stable sigmoid: the taken branch's exp argument is always <= 0.
function sigmoid(x: number): number {
  if (x >= 0) { const z = Math.exp(-x); return 1 / (1 + z); }
  const z = Math.exp(x); return z / (1 + z);
}
function softplus(x: number): number {
  if (x > 30) return x;
  if (x < -30) return Math.exp(x);
  return Math.log1p(Math.exp(x));
}
function softplusInv(y: number): number {
  if (y > 30) return y;
  return Math.log(Math.expm1(y));
}

/**
 * Plausible 10–90% transition widths, as logistic rates (`width = ln(81)/rate`).
 *
 * Green-up is a canopy growing, so it always takes weeks: anything faster is the
 * optimizer exploiting a gap between acquisitions, not phenology. Senescence may
 * legitimately be abrupt — harvest removes the canopy in days — so its upper
 * bound is looser. Without these the fit happily returns a 4-day "green-up" that
 * matches the points and is agronomically impossible.
 */
const GREENUP_RATE = { min: 0.03, max: 0.40 }; // ~146 d down to ~11 d
const SENESCE_RATE = { min: 0.03, max: 1.20 }; // ~146 d down to ~3.7 d (harvest)

/** Map an unbounded coordinate onto (lo, hi) — a hard bound the simplex cannot
 *  step outside, so no penalty term has to be tuned to hold it. */
function bounded(v: number, lo: number, hi: number): number {
  return lo + (hi - lo) * sigmoid(v);
}
function boundedInv(y: number, lo: number, hi: number): number {
  const u = Math.min(1 - 1e-9, Math.max(1e-9, (y - lo) / (hi - lo)));
  return Math.log(u / (1 - u));
}

/** Period of the wrapping, in days. */
const WRAP = 365;

/** The rising limb: a logistic saturating at L1. */
const gLimb = (t: number, p: DLParams) => p.L1 * sigmoid(p.k1 * (t - p.x01));

/** The falling limb: L1 minus a logistic, so it decays from L1 towards 0. */
const dLimb = (t: number, p: DLParams) => p.L1 - p.L1 * sigmoid(p.k2 * (t - p.x02));

/** The blend weight, handing over from green-up to senescence around `tc`. */
const blend = (t: number, p: DLParams) => sigmoid((t - p.tc) / 2.5);

/** One un-wrapped cycle. */
const cycle = (t: number, p: DLParams) => {
  const w = blend(t, p);
  return (1 - w) * gLimb(t, p) + w * dLimb(t, p);
};

/**
 * VI(t) = clamp( f(t) + f(t−365) + f(t+365), 1e-9, 1−1e-9 )
 *
 * The three shifted copies make the model periodic over the year, so a cycle
 * that runs past New Year is continuous rather than truncated at the axis ends.
 */
export function doubleLogistic(t: number, p: DLParams): number {
  const v = cycle(t, p) + cycle(t - WRAP, p) + cycle(t + WRAP, p);
  return Math.min(1 - 1e-9, Math.max(1e-9, v));
}

/** Former name, kept so nothing downstream has to care which form is in use. */
export const beck = doubleLogistic;

/** Below this fraction of the amplitude the modelled canopy is indistinguishable
 *  from bare soil, so the prediction is reported as exactly zero. */
const GROWTH_FLOOR = 0.01;

/**
 * The model as a predictor of growth.
 *
 * This form carries no baseline — both limbs decay to zero — so the prediction
 * IS the model, floored to an exact zero once it drops below a hundredth of the
 * peak, where a modelled canopy is indistinguishable from none.
 */
export function predictGrowth(t: number, p: DLParams): number {
  if (!(p.L1 > 0)) return 0;
  const v = doubleLogistic(t, p);
  return v > GROWTH_FLOOR * p.L1 ? v : 0;
}

/** Kept for callers that put observations on the model's scale. This form has
 *  no baseline to remove, so it is always zero. */
export function growthBaseline(_p: DLParams): number {
  return 0;
}

// reparam vector <-> constrained params
function unpack(v: number[]): DLParams {
  const L1 = softplus(v[0]);
  const k1 = bounded(v[1], GREENUP_RATE.min, GREENUP_RATE.max);
  const x01 = v[2];
  const k2 = bounded(v[3], SENESCE_RATE.min, SENESCE_RATE.max);
  // Senescence always follows green-up, and the hand-over sits between the two:
  // both are parameterised as offsets so the simplex cannot order them wrongly.
  const x02 = x01 + softplus(v[4]);
  const tc = x01 + sigmoid(v[5]) * (x02 - x01);
  return { L1, k1, x01, k2, x02, tc };
}
function pack(p: DLParams): number[] {
  const width = Math.max(p.x02 - p.x01, 1e-2);
  const u = Math.min(1 - 1e-6, Math.max(1e-6, (p.tc - p.x01) / width));
  return [
    softplusInv(Math.max(p.L1, 1e-4)),
    boundedInv(p.k1, GREENUP_RATE.min, GREENUP_RATE.max),
    p.x01,
    boundedInv(p.k2, SENESCE_RATE.min, SENESCE_RATE.max),
    softplusInv(width),
    Math.log(u / (1 - u)),
  ];
}

function sseOf(ts: number[], ys: number[], p: DLParams): number {
  let s = 0;
  for (let i = 0; i < ts.length; i++) { const r = beck(ts[i], p) - ys[i]; s += r * r; }
  return s;
}
function makeObjective(ts: number[], ys: number[]): (v: number[]) => number {
  // Guards are relative to the observed span, not a fixed calendar year — the
  // time axis is an absolute day index that can start well past day 365.
  const spanLo = Math.min(...ts) - 120;
  const spanHi = Math.max(...ts) + 120;
  return (v: number[]) => {
    const p = unpack(v);
    let f = sseOf(ts, ys, p);
    // mild soft guards keep the optimum physically sane (tiny weight, rarely active)
    if (p.x01 < spanLo) f += (p.x01 - spanLo) ** 2 * 1e-3;
    if (p.x01 > spanHi) f += (p.x01 - spanHi) ** 2 * 1e-3;
    if (p.x02 > spanHi + 60) f += (p.x02 - spanHi - 60) ** 2 * 1e-3;
    // L1 is an asymptote, so on a short season it legitimately overshoots the
    // observed peak — but the wrapped model is clamped into (0,1), and letting
    // L1 run away buys residual with a plateau the clamp then flattens.
    if (p.L1 > 1.2) f += (p.L1 - 1.2) ** 2;
    // A whisper of a preference for gentler transitions. When acquisitions
    // bracket a transition the residual dominates and this changes nothing; when
    // the transition falls entirely inside a gap the residual is flat across a
    // wide range of rates, and without this the optimizer lands arbitrarily on a
    // bound and reports a 4-day harvest it never observed.
    f += 1e-5 * (p.k1 * p.k1 + p.k2 * p.k2);
    return f;
  };
}

interface NMResult { x: number[]; fx: number; iterations: number; converged: boolean; }
function nelderMead(
  f: (v: number[]) => number, x0: number[],
  opts: { maxIter?: number; tolF?: number; tolX?: number; steps?: number[] } = {}
): NMResult {
  const n = x0.length;
  const maxIter = opts.maxIter ?? 2000;
  const tolF = opts.tolF ?? 1e-12;
  const tolX = opts.tolX ?? 1e-9;
  const steps = opts.steps ?? new Array(n).fill(0.5);
  const alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5;

  const simplex: { x: number[]; fx: number }[] = [{ x: x0.slice(), fx: f(x0) }];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += steps[i]; simplex.push({ x, fx: f(x) }); }

  let iter = 0;
  for (; iter < maxIter; iter++) {
    simplex.sort((a, b) => a.fx - b.fx);
    const best = simplex[0].fx, worst = simplex[n].fx;
    let xspread = 0;
    for (let j = 0; j < n; j++) xspread = Math.max(xspread, Math.abs(simplex[n].x[j] - simplex[0].x[j]));
    if (Math.abs(worst - best) < tolF * (Math.abs(best) + tolF) && xspread < tolX) break;

    const cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i].x[j];
    for (let j = 0; j < n; j++) cen[j] /= n;

    const worstX = simplex[n].x;
    const xr = cen.map((c, j) => c + alpha * (c - worstX[j]));
    const fr = f(xr);
    if (fr < simplex[0].fx) {                       // expand
      const xe = cen.map((c, j) => c + gamma * (xr[j] - c));
      const fe = f(xe);
      simplex[n] = fe < fr ? { x: xe, fx: fe } : { x: xr, fx: fr };
    } else if (fr < simplex[n - 1].fx) {            // accept reflection
      simplex[n] = { x: xr, fx: fr };
    } else {                                        // contract
      let done = false;
      if (fr < simplex[n].fx) {
        const xc = cen.map((c, j) => c + rho * (xr[j] - c));
        const fc = f(xc);
        if (fc <= fr) { simplex[n] = { x: xc, fx: fc }; done = true; }
      } else {
        const xc = cen.map((c, j) => c + rho * (worstX[j] - c));
        const fc = f(xc);
        if (fc < simplex[n].fx) { simplex[n] = { x: xc, fx: fc }; done = true; }
      }
      if (!done) {                                  // shrink toward best
        const b = simplex[0].x;
        for (let i = 1; i <= n; i++) {
          const x = simplex[i].x.map((v, j) => b[j] + sigma * (v - b[j]));
          simplex[i] = { x, fx: f(x) };
        }
      }
    }
  }
  simplex.sort((a, b) => a.fx - b.fx);
  return { x: simplex[0].x, fx: simplex[0].fx, iterations: iter, converged: iter < maxIter };
}

// SOS/EOS = 0.2-amplitude foot crossings of the FITTED curve, keyed off the
// REALIZED peak (not wmax: short overlapping-limb seasons never saturate the
// plateau, so wmax is an inflated shape nuisance). Sub-day via linear interp.
function deriveSeason(p: DLParams, tMin: number, tMax: number): { sos: number; eos: number; peakVal: number } {
  const t0 = tMin - 120, t1 = tMax + 120, dt = 0.25;
  let peakT = p.x01, peakV = -Infinity;
  for (let t = t0; t <= t1; t += dt) { const v = beck(t, p); if (v > peakV) { peakV = v; peakT = t; } }
  // No baseline term in this form: the feet are a fraction of the realized peak.
  const thr = 0.2 * peakV;

  let sos: number | null = null, prevT = t0, prevV = beck(t0, p);
  for (let t = t0 + dt; t <= peakT; t += dt) {
    const v = beck(t, p);
    if (prevV < thr && v >= thr) sos = prevT + (thr - prevV) / (v - prevV) * dt;
    prevT = t; prevV = v;
  }
  let eos: number | null = null; prevT = peakT; prevV = beck(peakT, p);
  for (let t = peakT + dt; t <= t1; t += dt) {
    const v = beck(t, p);
    if (prevV >= thr && v < thr) { eos = prevT + (thr - prevV) / (v - prevV) * dt; break; }
    prevT = t; prevV = v;
  }
  if (sos == null) sos = p.x01 - LN4 / p.k1;   // analytic spring foot fallback
  if (eos == null) eos = p.x02 + LN4 / p.k2;   // analytic autumn foot fallback
  return { sos, eos, peakVal: peakV };
}

/**
 * Fit a double-logistic to a sparse NDVI series.
 *   doys       day-of-year (or any strictly-increasing time axis) per observation
 *   ndvi       NDVI per observation (null/NaN allowed; filtered out)
 *   windowDoys [startDoy, peakDoy, endDoy] coarse seed from the heuristic detector
 * SOS/EOS are returned on the same axis as `doys`. When `poorFit` is true the
 * fit is unusable (e.g. a multi-cut perennial) — fall back to the coarse window.
 */
function fitDoubleLogistic(
  doys: number[], ndvi: (number | null)[], windowDoys: [number, number, number]
): DLFit {
  const ts: number[] = [], ys: number[] = [];
  for (let i = 0; i < doys.length; i++) {
    const t = doys[i], y = ndvi[i];
    if (Number.isFinite(t) && y != null && Number.isFinite(y)) { ts.push(t); ys.push(y as number); }
  }
  const n = ts.length;
  let [startDoy, peakDoy, endDoy] = windowDoys;
  // guard against a degenerate seed ordering (peak at an endpoint / out of order)
  if (!(startDoy < peakDoy && peakDoy < endDoy)) peakDoy = (startDoy + endDoy) / 2;
  const ymin = ys.length ? Math.min(...ys) : 0;
  const ymax = ys.length ? Math.max(...ys) : 0;

  if (n < MIN_SHAPE_POINTS) { // too few points for any curve at all
    const params: DLParams = {
      L1: Math.max(ymax, 0.05), k1: 0.1, x01: (startDoy + peakDoy) / 2,
      k2: 0.1, x02: (peakDoy + endDoy) / 2, tc: peakDoy,
    };
    return { params, rmse: NaN, r2: NaN, sos: startDoy, eos: endDoy, confidence: 'low', poorFit: true };
  }

  const S0 = (startDoy + peakDoy) / 2;
  const A0 = (peakDoy + endDoy) / 2;
  const mS0 = 4 / Math.max(5, peakDoy - startDoy);   // ~4/width rule
  const mA0 = 4 / Math.max(5, endDoy - peakDoy);
  const base: DLParams = { L1: Math.max(ymax, 0.05), k1: mS0, x01: S0, k2: mA0, x02: A0, tc: peakDoy };

  // deterministic multi-start (safety net + exposes ill-conditioning): base +
  // 4 S/A inflection shifts + 2 rate scales. No RNG -> reproducible.
  const sSpan = Math.max(peakDoy - startDoy, 10);
  const aSpan = Math.max(endDoy - peakDoy, 10);
  const starts: DLParams[] = [base];
  for (const ds of [-0.35, 0.35]) for (const da of [-0.35, 0.35]) {
    let x01 = S0 + ds * sSpan, x02 = A0 + da * aSpan;
    if (x02 <= x01 + 3) x02 = x01 + Math.max(10, aSpan);
    starts.push({ ...base, x01, x02, tc: (x01 + x02) / 2 });
  }
  for (const k of [0.5, 2]) starts.push({ ...base, k1: mS0 * k, k2: mA0 * k });

  const obj = makeObjective(ts, ys);
  const simplexSteps = [0.05, 0.5, 0.5, 12, 0.5, 0.5];   // in reparam space
  let best: NMResult | null = null;
  for (const st of starts) {
    const res = nelderMead(obj, pack(st), { steps: simplexSteps });
    if (!best || res.fx < best.fx) best = res;
  }

  const params = unpack(best!.x);
  const sse = sseOf(ts, ys, params);
  const rmse = Math.sqrt(sse / n);
  const { sos, eos, peakVal } = deriveSeason(params, Math.min(...ts), Math.max(...ts));

  let maxAbsResid = 0;
  for (let i = 0; i < n; i++) maxAbsResid = Math.max(maxAbsResid, Math.abs(beck(ts[i], params) - ys[i]));
  const yMean = ys.reduce((s, v) => s + v, 0) / n;
  const ssTot = ys.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const r2 = 1 - sse / Math.max(ssTot, 1e-12);
  const obsRange = ymax - ymin;
  const relRmse = rmse / Math.max(peakVal, 1e-6);

  // Poor-fit gate. The thing worth refusing is a curve this model cannot
  // describe at all — a multi-cut perennial, where one rise-and-fall is fitted
  // to two or three, and R² collapses. R² is the discriminator for that.
  //
  // The absolute residual bounds that used to sit here were tuned against raw
  // VI and now punish the legitimate case: the signal is zeroed at the two
  // boundaries, so a period ending mid-harvest has a near-vertical edge no
  // smooth logistic can follow, and one or two large residuals there would
  // reject an otherwise excellent fit. A rise, a plateau and a fall at R² 0.94
  // is exactly what this model is for.
  const poorFit = r2 < 0.9 || obsRange < 0.05;
  // Degrees of freedom gate the label: with few spare observations a small rmse
  // says the model interpolated the points, not that it recovered the season.
  const dof = n - DL_PARAM_COUNT;
  const confidence: DLFit['confidence'] = poorFit || dof < 2 ? 'low' : rmse < 0.03 ? 'high' : 'medium';

  return { params, rmse, r2, sos, eos, confidence, poorFit };
}
// ============================================================================
// The plant period
//
// The user draws where the plant actually is on a scenario's curve. Both ends of
// that span are taken to be zero growth, and everything outside it is zero too:
// the model describes one crop cycle, not the year around it.
// ============================================================================

/**
 * A transition falling inside a gap at least this wide is not measured: the
 * 10–90% width of a plausible green-up is ~2 weeks, so a gap of that order can
 * hide the whole thing.
 */
const UNSEEN_TRANSITION_DAYS = 15;

/** A plant period, as absolute day indices on the series axis. */
export interface PlantPeriod {
  start: number;
  end: number;
}

export interface PeriodFit {
  params: DLParams;
  r2: number;
  /** Acquisitions inside the period that carried a value. */
  points: number;
  /**
   * Spare observations: points minus the six parameters. R² is only evidence
   * when this is comfortably positive — with one spare point a six-parameter
   * curve passes through almost any seven observations and scores ~1 whatever
   * the shape between them.
   */
  dof: number;
  /** The worst any single observation misses the curve by. Meaningful at any
   *  degrees of freedom, unlike R². */
  maxResidual: number;
  /** Low when there are no more points than parameters — R² cannot judge it. */
  confidence: 'high' | 'medium' | 'low';
  /** Why no curve, when the fit was refused. */
  note?: string;
  /**
   * Transitions that happen entirely between two acquisitions. Their timing is
   * bracketed but their RATE is not measured at all: any speed that gets from
   * one observation to the next fits equally well, so k1 / k2 there are a
   * consequence of the optimizer, not of the data.
   */
  unconstrained: { greenUp: number | null; senescence: number | null };
}

/** Linear interpolation of an observed curve at an arbitrary day, clamped. */
function interpolateAt(days: (number | null)[], values: number[], t: number): number | null {
  let lo: [number, number] | null = null;
  let hi: [number, number] | null = null;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const v = values[i];
    if (d == null || !isFinite(v)) continue;
    if (d <= t && (!lo || d > lo[0])) lo = [d, v];
    if (d >= t && (!hi || d < hi[0])) hi = [d, v];
  }
  if (lo && hi) return hi[0] === lo[0] ? lo[1] : lo[1] + ((hi[1] - lo[1]) * (t - lo[0])) / (hi[0] - lo[0]);
  return (lo ?? hi)?.[1] ?? null;
}

/**
 * The curve as growth above the plant period's own baseline.
 *
 * The baseline is the straight line joining the curve's value at the two chosen
 * boundaries, so both ends come out at exactly zero by construction — that is
 * what "the extremities are zero" means, and it also absorbs a soil background
 * that differs between sowing and harvest. Outside the period the signal is a
 * true zero rather than a small residual: there is no crop there to describe.
 *
 * Negative excursions inside the period are clamped away; growth below bare soil
 * is not a thing the model should try to reproduce.
 */
export function growthSignal(
  days: (number | null)[],
  values: number[],
  period: PlantPeriod,
  excluded?: ReadonlySet<number>
): (number | null)[] {
  // A dropped point must not anchor the baseline either — it is dropped because
  // it is not believed, and the baseline is read off the curve at the boundaries.
  const kept = excluded?.size
    ? days.map(d => (d != null && excluded.has(d) ? null : d))
    : days;
  const v0 = interpolateAt(kept, values, period.start);
  const v1 = interpolateAt(kept, values, period.end);
  const width = period.end - period.start;
  return days.map((d, i) => {
    const v = values[i];
    if (d == null || !isFinite(v)) return null;
    if (d < period.start || d > period.end) return 0;
    if (v0 == null || v1 == null || width <= 0) return null;
    const base = v0 + ((v1 - v0) * (d - period.start)) / width;
    return Math.max(0, v - base);
  });
}

/**
 * The baseline the growth is measured against: the straight line joining the
 * curve at the two boundaries. Adding it back to the model puts the fitted curve
 * on the same scale as the raw observations, for drawing them together.
 */
export function periodBaseline(
  days: (number | null)[],
  values: number[],
  period: PlantPeriod,
  excluded?: ReadonlySet<number>
): ((t: number) => number) | null {
  const kept = excluded?.size
    ? days.map(d => (d != null && excluded.has(d) ? null : d))
    : days;
  const v0 = interpolateAt(kept, values, period.start);
  const v1 = interpolateAt(kept, values, period.end);
  const width = period.end - period.start;
  if (v0 == null || v1 == null || width <= 0) return null;
  return t => v0 + ((v1 - v0) * (t - period.start)) / width;
}

/**
 * Fit the double logistic to one scenario's growth inside its plant period.
 *
 * Only the acquisitions inside the period are fitted: the zeros outside carry no
 * information about the shape and would drag the transitions towards the edges.
 */
export function fitPlantPeriod(
  days: (number | null)[],
  values: number[],
  period: PlantPeriod,
  /** Acquisition days the user has dropped — cloud, snow, a bad mosaic. */
  excluded?: ReadonlySet<number>
): PeriodFit | null {
  if (!(period.end > period.start)) return null;
  const growth = growthSignal(days, values, period, excluded);
  const ts: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const g = growth[i];
    if (d == null || g == null) continue;
    if (d < period.start || d > period.end) continue;
    if (excluded?.has(d)) continue;
    ts.push(d);
    ys.push(g);
  }
  if (ts.length < MIN_SHAPE_POINTS) {
    return {
      params: {
        L1: 1, k1: 0.1, x01: period.start, k2: 0.1, x02: period.end,
        tc: (period.start + period.end) / 2,
      },
      r2: NaN,
      points: ts.length,
      confidence: 'low',
      note: `${ts.length} of ${MIN_SHAPE_POINTS} images needed`,
      dof: ts.length - DL_PARAM_COUNT,
      maxResidual: NaN,
      unconstrained: { greenUp: null, senescence: null },
    };
  }

  /** The gap an inflection falls into, when no acquisition brackets it closely. */
  const gapAround = (t: number) => {
    let below = -Infinity;
    let above = Infinity;
    for (const d of ts) {
      if (d <= t && d > below) below = d;
      if (d >= t && d < above) above = d;
    }
    return isFinite(below) && isFinite(above) ? above - below : null;
  };
  let peak = ts[0];
  let best = -Infinity;
  for (let i = 0; i < ts.length; i++) {
    if (ys[i] > best) {
      best = ys[i];
      peak = ts[i];
    }
  }
  const f = fitDoubleLogistic(ts, ys, [period.start, peak, period.end]);
  const dof = ts.length - DL_PARAM_COUNT;
  const gUp = gapAround(f.params.x01);
  const gDown = gapAround(f.params.x02);
  let maxResidual = 0;
  for (let i = 0; i < ts.length; i++) {
    maxResidual = Math.max(maxResidual, Math.abs(doubleLogistic(ts[i], f.params) - ys[i]));
  }
  return {
    params: f.params,
    r2: f.r2,
    points: ts.length,
    dof,
    maxResidual,
    confidence: f.poorFit || dof < 2 ? 'low' : f.r2 > 0.97 ? 'high' : 'medium',
    note: f.poorFit ? 'not a single growth cycle' : undefined,
    unconstrained: {
      greenUp: gUp != null && gUp >= UNSEEN_TRANSITION_DAYS ? gUp : null,
      senescence: gDown != null && gDown >= UNSEEN_TRANSITION_DAYS ? gDown : null,
    },
  };
}

/**
 * The fitted model at a day: growth inside the period, a true zero outside.
 * Never negative — the double logistic can dip below its own baseline near the
 * transitions, and negative growth is not a thing this predicts.
 */
export function periodModelAt(fit: PeriodFit, period: PlantPeriod, t: number): number {
  if (t < period.start || t > period.end) return 0;
  return Math.max(0, beck(t, fit.params));
}
