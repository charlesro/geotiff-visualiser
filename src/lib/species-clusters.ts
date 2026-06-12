import { ZoneExtraction } from './zones';

/**
 * Per-species clustering of fields by their growth curve.
 *
 * Fields of the same species can follow different growth scenarios (sowing
 * date, variety, management…). To isolate them before the PCA, each field is
 * summarized by the mean time series of its interior pixels (edge pixels are
 * contaminated by the neighbours) and k-means is run separately within every
 * species group, so clusters never mix species.
 */

export const CLUSTER_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fb923c', '#c084fc', '#2dd4bf', '#facc15', '#fb7185'];

export interface ClusteredField {
  /** Field identity (NewID), same convention as the zone extraction. */
  key: string;
  pid: number | undefined;
  label: string;
  species: string;
  /** Pixels averaged into the curve. */
  pixelCount: number;
  /** Mean metric value per retained date. */
  curve: number[];
  /** Scenario index within the species (0 = largest cluster). */
  cluster: number;
}

export interface SpeciesClusterGroup {
  species: string;
  fields: ClusteredField[];
  /** centroids[cluster][dateIndex] */
  centroids: number[][];
  /** Fields per cluster. */
  sizes: number[];
}

export interface SpeciesClustering {
  groups: SpeciesClusterGroup[];
  /** Dates the curves are built on (those covered by ≥80% of fields). */
  dates: string[];
  /** Requested cluster count (capped at the species' field count). */
  k: number;
  metric: string;
  /** Fields dropped because their series was incomplete on the retained dates. */
  droppedFields: number;
  createdAt: number;
}

/** Field identity of a pixel point or polygon feature (matches zones.ts). */
export const fieldKeyOf = (props: any): string => String(props?.NewID ?? `pid:${props?.__pid}`);

/** Keep dates observed on at least this fraction of fields. */
const DATE_COVERAGE_THRESHOLD = 0.8;

export function clusterBySpecies(extraction: ZoneExtraction, k: number): SpeciesClustering {
  const prefix = `${extraction.metric}_`;

  // Group the extracted pixels by field. Interior pixels carry the field's
  // own signal; edge pixels are only used for fields too small to have any.
  interface FieldAcc {
    key: string;
    pid: number | undefined;
    species: string;
    label: string;
    interior: any[];
    edge: any[];
  }
  const fields = new Map<string, FieldAcc>();
  const collect = (features: any[], target: 'interior' | 'edge') => {
    for (const p of features) {
      const props = p.properties || {};
      const key = fieldKeyOf(props);
      let acc = fields.get(key);
      if (!acc) {
        const species = props.crp_lbl ?? props.species ?? 'unknown';
        acc = {
          key,
          pid: props.__pid,
          species: String(species),
          label: props.NewID !== undefined ? `${species} · ${props.NewID}` : `Polygon ${(props.__pid ?? 0) + 1}`,
          interior: [],
          edge: [],
        };
        fields.set(key, acc);
      }
      acc[target].push(props);
    }
  };
  collect(extraction.interior.features, 'interior');
  collect(extraction.edge.features, 'edge');

  if (fields.size < 2) {
    throw new Error('Clustering needs at least 2 fields — select more polygons in step 1.');
  }

  // Per-field mean curve over all extraction dates (NaN where unobserved).
  const allDates = extraction.dates;
  if (allDates.length < 3) {
    throw new Error(`Only ${allDates.length} acquisition date(s) — at least 3 are needed to cluster growth curves.`);
  }
  const rawCurves = new Map<string, { curve: number[]; pixelCount: number }>();
  for (const acc of fields.values()) {
    const pixels = acc.interior.length > 0 ? acc.interior : acc.edge;
    const curve = allDates.map(date => {
      let sum = 0;
      let n = 0;
      for (const props of pixels) {
        const v = props[prefix + date];
        if (typeof v === 'number' && isFinite(v)) {
          sum += v;
          n++;
        }
      }
      return n > 0 ? sum / n : NaN;
    });
    rawCurves.set(acc.key, { curve, pixelCount: pixels.length });
  }

  // Complete-case matrix: keep well-covered dates, drop incomplete fields.
  const keptDateIdx = allDates
    .map((_, di) => di)
    .filter(di => {
      let n = 0;
      for (const { curve } of rawCurves.values()) if (isFinite(curve[di])) n++;
      return n >= rawCurves.size * DATE_COVERAGE_THRESHOLD;
    });
  const dates = keptDateIdx.map(di => allDates[di]);
  if (dates.length < 3) {
    throw new Error('Fewer than 3 dates are shared across the fields — fetch a denser series.');
  }

  const complete: { acc: FieldAcc; curve: number[]; pixelCount: number }[] = [];
  let droppedFields = 0;
  for (const acc of fields.values()) {
    const { curve, pixelCount } = rawCurves.get(acc.key)!;
    const kept = keptDateIdx.map(di => curve[di]);
    if (kept.every(isFinite)) complete.push({ acc, curve: kept, pixelCount });
    else droppedFields++;
  }
  if (complete.length < 2) {
    throw new Error('Fewer than 2 fields have a complete series on the retained dates.');
  }

  // Cluster within each species, never across.
  const bySpecies = new Map<string, typeof complete>();
  for (const f of complete) {
    const list = bySpecies.get(f.acc.species) || [];
    list.push(f);
    bySpecies.set(f.acc.species, list);
  }

  const rand = mulberry32(42); // deterministic runs
  const groups: SpeciesClusterGroup[] = [];
  for (const [species, members] of bySpecies) {
    const kk = Math.max(1, Math.min(k, members.length));
    const matrix = members.map(m => m.curve);
    const { assign, centroids } = kk === 1
      ? { assign: members.map(() => 0), centroids: [meanRow(matrix)] }
      : kmeans(matrix, kk, rand);

    // Relabel so cluster 0 is the biggest — "scenario 1" reads naturally.
    const order = Array.from({ length: centroids.length }, (_, c) => c).sort(
      (a, b) => assign.filter(x => x === b).length - assign.filter(x => x === a).length
    );
    const remap = new Map(order.map((old, fresh) => [old, fresh]));

    const clustered: ClusteredField[] = members.map((m, i) => ({
      key: m.acc.key,
      pid: m.acc.pid,
      label: m.acc.label,
      species,
      pixelCount: m.pixelCount,
      curve: m.curve,
      cluster: remap.get(assign[i])!,
    }));
    const sizes = order.map(old => assign.filter(x => x === old).length);
    groups.push({
      species,
      fields: clustered.sort((a, b) => a.cluster - b.cluster),
      centroids: order.map(old => centroids[old]),
      sizes,
    });
  }
  groups.sort((a, b) => b.fields.length - a.fields.length);

  return { groups, dates, k, metric: extraction.metric, droppedFields, createdAt: Date.now() };
}

// ----- k-means ---------------------------------------------------------------

const dist2 = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
};

const meanRow = (rows: number[][]): number[] => {
  const m = new Array(rows[0].length).fill(0);
  for (const r of rows) for (let i = 0; i < r.length; i++) m[i] += r[i];
  return m.map(v => v / rows.length);
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lloyd's k-means with k-means++ seeding; best of several restarts. */
function kmeans(data: number[][], k: number, rand: () => number): { assign: number[]; centroids: number[][] } {
  let best: { assign: number[]; centroids: number[][]; inertia: number } | null = null;

  for (let restart = 0; restart < 8; restart++) {
    // k-means++ initialisation
    const centroids: number[][] = [data[Math.floor(rand() * data.length)].slice()];
    while (centroids.length < k) {
      const d2 = data.map(p => Math.min(...centroids.map(c => dist2(p, c))));
      const total = d2.reduce((a, b) => a + b, 0);
      if (total === 0) {
        centroids.push(data[Math.floor(rand() * data.length)].slice());
        continue;
      }
      let target = rand() * total;
      let idx = 0;
      while (idx < d2.length - 1 && (target -= d2[idx]) > 0) idx++;
      centroids.push(data[idx].slice());
    }

    const assign = new Array<number>(data.length).fill(-1);
    for (let iter = 0; iter < 100; iter++) {
      let changed = false;
      for (let i = 0; i < data.length; i++) {
        let bestC = 0;
        let bestD = Infinity;
        for (let c = 0; c < k; c++) {
          const d = dist2(data[i], centroids[c]);
          if (d < bestD) {
            bestD = d;
            bestC = c;
          }
        }
        if (assign[i] !== bestC) {
          assign[i] = bestC;
          changed = true;
        }
      }
      if (!changed) break;
      for (let c = 0; c < k; c++) {
        const members = data.filter((_, i) => assign[i] === c);
        if (members.length > 0) centroids[c] = meanRow(members);
      }
    }

    const inertia = data.reduce((s, p, i) => s + dist2(p, centroids[assign[i]]), 0);
    if (!best || inertia < best.inertia) best = { assign, centroids, inertia };
  }
  return { assign: best!.assign, centroids: best!.centroids };
}
