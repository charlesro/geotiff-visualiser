/**
 * Shared vocabulary for the growth-scenarios drawer: the constants, the small
 * derivations every part of it agrees on, and the imagery flow's state.
 *
 * Kept separate from the components so the rules that must hold in more than one
 * place — which scenarios survive "keep top N", where the day axis is anchored,
 * what counts as a gap — are written exactly once.
 */
import { useEffect, useRef, useState } from 'react';
import { SpeciesClustering } from '../../lib/species-clusters';
import { SceneCandidate, SceneClarity } from '../../lib/fetch-series';
import { GrowingSeasonResult, SeasonPicks, dayIndex, dayIndexToDate } from '../../lib/phenology';
import { CropCalendarBook } from '../../lib/crop-calendars';
import { ZoneExtraction } from '../../lib/zones';

/** Scenarios per species for a first run — enough to separate sowing dates and
 *  varieties without splitting a crop into noise. */
export const DEFAULT_K = 10;

/** Upper bound; CLUSTER_COLORS carries exactly this many distinct hues. */
export const MAX_K = 12;

/**
 * Scenarios kept per species before the user touches anything. Clustering finely
 * and then keeping the biggest few is the intent of the step — the tail is
 * usually a handful of fields whose curve is noise, and every kept scenario is a
 * season the user has to mark by hand.
 */
export const KEEP_TOP_DEFAULT = 4;

/** Share of a species' fields the kept scenarios account for. */
export const keptCoverage = (sizes: number[], topN: number) => {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  return sizes.filter((_, ci) => ci < topN).reduce((a, b) => a + b, 0) / total;
};

/**
 * The hole that counts as a gap worth offering to fill, and the fallback
 * half-width when a click has no acquisition on one side. The search itself is
 * bounded by the neighbouring acquisitions, not by this.
 */
export const SEARCH_RADIUS_DAYS = 20;

/** Cloud ceiling for the gap search — a filter on the tile, not on the fields. */
export const SEARCH_MAX_CLOUD = 80;

/**
 * Below this share of a scenario's fields, a centroid point is drawn hollow: the
 * value is real but averaged over only part of the scenario, so it carries more
 * noise. Matches the bar clusterBySpecies uses to decide what to partition on.
 */
export const PARTIAL_SUPPORT = 0.8;

/** The year the day axis is anchored to: the first acquisition's. */
export const baseYearOf = (dates: string[] | undefined) => Number(dates?.[0]?.slice(0, 4)) || 2021;

/** "2021-06-24" -> "06-24" when it sits in `base`, else the full date. */
export const shortDate = (iso: string, base: number) =>
  Number(iso.slice(0, 4)) === base ? iso.slice(5) : iso;

/**
 * The scenarios "keep top N" leaves in play. Clusters come out biggest-first, so
 * position IS rank; an empty cluster is a leftover k-means seed describing no
 * field. Written once because the charts, the season and the PCA scope must all
 * agree on which scenarios exist.
 */
export const keptScenarios = (sizes: number[], count: number, topN: number) =>
  Array.from({ length: count }, (_, ci) => ci).filter(ci => ci < topN && (sizes[ci] ?? 0) > 0);

/** One scenario's entry in a computed season, or null when there is none yet. */
export const seasonEntry = (season: GrowingSeasonResult | null, species: string, cluster: number) =>
  season?.perCluster?.find(p => p.species === species && p.cluster === cluster) ?? null;

/**
 * "Keep top N" is stored as Infinity when nothing is dropped, so the filter can
 * run unconditionally. The coercion lives here because two controls write it —
 * the stepper and the per-row [keep] — and they must agree.
 */
export const topScenariosValue = (n: number, k: number) => (n >= k ? Infinity : n);

export type ScenarioEntry = NonNullable<GrowingSeasonResult['perCluster']>[number];

/** What the scene picker is showing: the span it searched and the offers in it. */
export interface PickerState {
  /** Human label for the span — "May 2021" or "May – Jul 2021". */
  label: string;
  range: { start: string; end: string };
  loading: boolean;
  candidates: SceneCandidate[];
  error: string | null;
}

/** One calendar month of the series, in day-index space. */
export interface MonthMark {
  /** "2021-11" — stable key and the range the catalogue is asked for. */
  key: string;
  label: string;
  year: number;
  from: number;
  to: number;
  /** Acquisitions the series already holds inside it. */
  count: number;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Every calendar month the series spans.
 *
 * Months are the frame the series is read against — evenly spaced and
 * universally understood — and the unit imagery is requested in. They carry no
 * verdict: a month with no acquisition may be perfectly well covered by the ones
 * either side, while a fast transition can need several inside a fortnight.
 * Which stretch needs more is the user's call, so they select it.
 */
export function monthsOf(dates: string[], baseYear: number): MonthMark[] {
  if (dates.length === 0) return [];
  const first = dates[0];
  const last = dates[dates.length - 1];
  const out: MonthMark[] = [];
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(5, 7));
  const endY = Number(last.slice(0, 4));
  const endM = Number(last.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const from = dayIndex(`${key}-01`, baseYear);
    const nY = m === 12 ? y + 1 : y;
    const nM = m === 12 ? 1 : m + 1;
    const to = dayIndex(`${nY}-${String(nM).padStart(2, '0')}-01`, baseYear);
    if (from != null && to != null) {
      out.push({
        key,
        label: MONTH_NAMES[m - 1],
        year: y,
        from,
        to,
        count: dates.filter(d => d.startsWith(key)).length,
      });
    }
    y = nY;
    m = nM;
  }
  return out;
}



/**
 * The "ask for imagery" flow: the picker opened on a hole in the series, and the
 * per-date clarity reads.
 *
 * It lives above the chart list because an insert keeps running in App while the
 * user scrolls, and because each clarity figure is a real COG read the user
 * waited for — cached by date rather than thrown away when the picker closes.
 */
export function useImageryFlow(
  clustering: SpeciesClustering | null,
  findScenes: (
    range: { start: string; end: string },
    maxCloud: number
  ) => Promise<SceneCandidate[]>,
  checkClarity: (candidate: SceneCandidate) => Promise<SceneClarity | null>
) {
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [clarity, setClarity] = useState<Record<string, SceneClarity | 'loading' | 'none'>>({});

  // A re-clustering makes the candidate list wrong — it was "what the catalogue
  // holds that this series lacks", and the series has just changed. The clarity
  // figures go with it: they are read over the analysed fields, and a re-cluster
  // is also what a new polygon selection produces, so keeping them risks showing
  // a "ground visible" figure measured over different fields.
  const clusteringId = clustering?.createdAt ?? 0;
  useEffect(() => {
    setPicker(null);
    setClarity({});
  }, [clusteringId]);

  /**
   * Everything the catalogue holds over a span of months that the series does
   * not. The span is the caller's choice: how much imagery a stretch of the year
   * needs is a judgement about the curve there, not something a count of
   * acquisitions can settle.
   */
  const ask = async (months: MonthMark[], baseYear: number) => {
    if (months.length === 0) return;
    const first = months[0];
    const last = months[months.length - 1];
    const label =
      first === last
        ? `${first.label} ${first.year}`
        : `${first.label} – ${last.label} ${last.year}`;
    const range = { start: dayIndexToDate(first.from, baseYear), end: dayIndexToDate(last.to - 1, baseYear) };
    setPicker({ label, range, loading: true, candidates: [], error: null });
    const settle = (patch: Partial<PickerState>) =>
      setPicker(p => (p && p.label === label ? { ...p, ...patch } : p));
    try {
      const found = await findScenes(range, SEARCH_MAX_CLOUD);
      settle({ loading: false, candidates: found, error: null });
    } catch (e) {
      settle({ loading: false, candidates: [], error: e instanceof Error ? e.message : String(e) });
    }
  };

  const check = async (cd: SceneCandidate) => {
    setClarity(c => ({ ...c, [cd.date]: 'loading' }));
    try {
      const r = await checkClarity(cd);
      setClarity(c => ({ ...c, [cd.date]: r ?? 'none' }));
    } catch {
      setClarity(c => ({ ...c, [cd.date]: 'none' }));
    }
  };

  // Read through a ref rather than the closure: the loop awaits, so the captured
  // `clarity` would not see what the previous iteration wrote.
  const clarityRef = useRef(clarity);
  clarityRef.current = clarity;
  const checkAll = async (candidates: SceneCandidate[]) => {
    for (const cd of candidates) {
      if (clarityRef.current[cd.date] === undefined) await check(cd);
    }
  };

  return { picker, ask, closePicker: () => setPicker(null), clarity, check, checkAll };
}

export type ImageryFlow = ReturnType<typeof useImageryFlow>;
