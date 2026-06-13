import { ZoneExtraction } from './zones';
import { fieldKeyOf } from './species-clusters';
import { zoneColor, NEUTRAL } from './legend';

/**
 * Boundary (edge-response) profiling.
 *
 * Pools every extracted pixel along the signed distance to its field
 * boundary (`edge_dist_m`: negative in the gap outside, 0 at the boundary,
 * positive inside the field) and summarises a chosen metric per distance bin
 * — the standard edge-response curve. From it we report:
 *
 *   - the interior reference level (deep-interior mean),
 *   - the magnitude of edge influence (MEI), normalised edge-vs-interior,
 *   - the depth of edge influence (DEI): how far in the metric stays
 *     distinguishable from the interior, by a CI-overlap rule.
 *
 * Space-for-time substitution: thousands of boundary transects across many
 * fields are aligned by distance and averaged into one population curve.
 */

export type ProfileValue = 'date' | 'mean' | 'amplitude' | 'mixing';

export interface ProfileOptions {
  value: ProfileValue;
  /** Required when value === 'date'. */
  date?: string;
  /** Distance bin width in metres. */
  binWidth: number;
  /** One pooled curve, or one per pixel class. */
  groupBy: 'none' | 'class';
  /** Restrict to a single field (its `fieldKeyOf` key); undefined = all fields. */
  fieldKey?: string;
}

export interface ProfileBin {
  /** Bin centre, signed distance in metres. */
  center: number;
  mean: number;
  /** Standard error and 95% half-width. */
  se: number;
  ci: number;
  n: number;
}

export interface ProfileSeries {
  group: string;
  label: string;
  color: string;
  bins: ProfileBin[];
}

export interface BoundaryProfile {
  series: ProfileSeries[];
  binWidth: number;
  valueLabel: string;
  /** Deep-interior reference level and its 95% half-width. */
  interior: number;
  interiorCi: number;
  /** Edge value (nearest bin just inside the boundary) and the indices. */
  edgeValue: number | null;
  /** Magnitude of edge influence: (edge − interior)/(edge + interior). */
  mei: number | null;
  /** Raw edge − interior difference. */
  meanDiff: number | null;
  /** Depth of edge influence (m), or null if none detected. */
  deiMeters: number | null;
  totalPixels: number;
  distanceRange: [number, number];
}

const CLASS_LABEL: Record<string, string> = {
  interior: 'Interior',
  edge_other_species: 'Edge · other species',
  edge_same_species: 'Edge · same species',
  edge_isolated: 'Edge · isolated',
};

/** Pull the chosen scalar from a pixel's properties; NaN when unavailable. */
function valueOf(props: any, opts: ProfileOptions, metric: string, dates: string[]): number {
  if (opts.value === 'mixing') {
    const v = props.mix_frac_a;
    return typeof v === 'number' && isFinite(v) ? v : NaN;
  }
  if (opts.value === 'date') {
    const v = props[`${metric}_${opts.date}`];
    return typeof v === 'number' && isFinite(v) ? v : NaN;
  }
  // mean or amplitude over the season
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (const d of dates) {
    const v = props[`${metric}_${d}`];
    if (typeof v === 'number' && isFinite(v)) {
      sum += v;
      n++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (n === 0) return NaN;
  return opts.value === 'amplitude' ? max - min : sum / n;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a: number[], m: number) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));

export function computeBoundaryProfile(zones: ZoneExtraction, opts: ProfileOptions): BoundaryProfile {
  const metric = zones.metric;
  const dates = zones.dates;
  const pixels = [...zones.interior.features, ...zones.edge.features];

  // Collect (distance, value, class) for usable pixels.
  interface Pt { d: number; v: number; cls: string }
  const pts: Pt[] = [];
  for (const f of pixels) {
    const props = f.properties;
    if (opts.fieldKey && fieldKeyOf(props) !== opts.fieldKey) continue;
    const d = props?.edge_dist_m;
    if (typeof d !== 'number' || !isFinite(d)) continue;
    const v = valueOf(props, opts, metric, dates);
    if (!isFinite(v)) continue;
    pts.push({ d, v, cls: props.zone || 'interior' });
  }
  if (pts.length === 0) {
    throw new Error(
      opts.fieldKey
        ? 'This field has no pixels with the selected value — pick another date/metric or another field.'
        : 'No pixels carry the selected value — re-run the zone extraction, or pick another date/metric.'
    );
  }

  const bw = opts.binWidth;
  const binCenter = (d: number) => (Math.floor(d / bw) + 0.5) * bw;

  const buildSeries = (subset: Pt[], group: string, label: string, color: string): ProfileSeries => {
    const groups = new Map<number, number[]>();
    for (const p of subset) {
      const c = binCenter(p.d);
      (groups.get(c) ?? groups.set(c, []).get(c)!).push(p.v);
    }
    const bins: ProfileBin[] = Array.from(groups.entries())
      .map(([center, vals]) => {
        const m = mean(vals);
        const se = vals.length > 1 ? std(vals, m) / Math.sqrt(vals.length) : 0;
        return { center, mean: m, se, ci: 1.96 * se, n: vals.length };
      })
      .sort((a, b) => a.center - b.center);
    return { group, label, color, bins };
  };

  const series: ProfileSeries[] = [];
  if (opts.groupBy === 'class') {
    for (const cls of ['interior', 'edge_other_species', 'edge_same_species', 'edge_isolated']) {
      const subset = pts.filter(p => p.cls === cls);
      if (subset.length > 0) series.push(buildSeries(subset, cls, CLASS_LABEL[cls], zoneColor(cls)));
    }
  } else {
    series.push(buildSeries(pts, 'all', 'All boundary pixels', NEUTRAL));
  }

  // Interior reference: deep-interior pixels (≥ buffer distance inside).
  const interiorVals = pts.filter(p => p.d >= zones.distance).map(p => p.v);
  const L = interiorVals.length > 0 ? mean(interiorVals) : NaN;
  const interiorCi = interiorVals.length > 1 ? 1.96 * (std(interiorVals, L) / Math.sqrt(interiorVals.length)) : 0;

  // Edge value and MEI from the pooled bins nearest the boundary (just inside).
  const pooled = opts.groupBy === 'class' ? buildSeries(pts, 'all', 'all', NEUTRAL) : series[0];
  const insideBins = pooled.bins.filter(b => b.center > 0).sort((a, b) => a.center - b.center);
  const edgeBin = insideBins[0];
  const edgeValue = edgeBin ? edgeBin.mean : null;
  const meanDiff = edgeValue !== null && isFinite(L) ? edgeValue - L : null;
  const denom = edgeValue !== null ? edgeValue + L : 0;
  const mei = edgeValue !== null && isFinite(L) && Math.abs(denom) > 1e-6 ? (edgeValue - L) / denom : null;

  // Depth of edge influence: walking inward from the boundary, the last
  // distance at which the bin mean still differs from the interior level by
  // more than the combined 95% intervals.
  let deiMeters: number | null = null;
  for (const b of insideBins) {
    const differs = Math.abs(b.mean - L) > b.ci + interiorCi;
    if (differs) deiMeters = b.center;
    else break;
  }

  // Spreading tens of thousands of values into Math.min/max overflows the
  // call stack — reduce instead.
  let dMin = Infinity;
  let dMax = -Infinity;
  for (const p of pts) {
    if (p.d < dMin) dMin = p.d;
    if (p.d > dMax) dMax = p.d;
  }
  return {
    series,
    binWidth: bw,
    valueLabel:
      opts.value === 'date'
        ? `${metric} · ${opts.date}`
        : opts.value === 'mean'
          ? `mean ${metric}`
          : opts.value === 'amplitude'
            ? `${metric} amplitude`
            : 'species-A fraction',
    interior: L,
    interiorCi,
    edgeValue,
    mei,
    meanDiff,
    deiMeters,
    totalPixels: pts.length,
    distanceRange: [dMin, dMax],
  };
}

/** Long-format CSV of the binned profile for downstream stats (R / Python). */
export function profileToCsv(profile: BoundaryProfile): string {
  const lines = ['group,distance_m,mean,se,ci95,n'];
  for (const s of profile.series) {
    for (const b of s.bins) {
      lines.push([s.group, b.center, b.mean.toFixed(6), b.se.toFixed(6), b.ci.toFixed(6), b.n].join(','));
    }
  }
  return lines.join('\n');
}
