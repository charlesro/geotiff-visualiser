import { ZoneExtraction, PixelZone } from './zones';

/**
 * Per-date zone means of a single polygon's pixel time series, for the
 * NDVI inspector chart. Built from a ZoneExtraction of that one polygon so
 * the chart shows exactly the pixels (and classes) the analysis uses.
 */

export interface NdviSeriesPoint {
  date: string;
  interior?: number;
  edge_other_species?: number;
  edge_same_species?: number;
  edge_isolated?: number;
}

export interface NdviInspection {
  label: string;
  series: NdviSeriesPoint[];
  counts: { interior: number; other: number; same: number; isolated: number };
  metric: string;
  distance: number;
}

const ZONES: PixelZone[] = ['interior', 'edge_other_species', 'edge_same_species', 'edge_isolated'];

export function summarizeExtraction(x: ZoneExtraction, label: string): NdviInspection {
  const byZone: Record<string, any[]> = { interior: x.interior.features };
  for (const z of ZONES.slice(1)) byZone[z] = [];
  for (const f of x.edge.features) {
    const z = f.properties?.zone;
    if (byZone[z]) byZone[z].push(f);
  }

  const series: NdviSeriesPoint[] = x.dates.map(date => {
    const point: NdviSeriesPoint = { date };
    for (const z of ZONES) {
      let sum = 0;
      let n = 0;
      for (const f of byZone[z]) {
        const v = f.properties?.[`${x.metric}_${date}`];
        if (typeof v === 'number' && isFinite(v)) {
          sum += v;
          n++;
        }
      }
      if (n > 0) point[z] = sum / n;
    }
    return point;
  });

  return {
    label,
    series,
    counts: {
      interior: x.interior.features.length,
      other: x.edgeCounts.other,
      same: x.edgeCounts.same,
      isolated: x.edgeCounts.isolated,
    },
    metric: x.metric,
    distance: x.distance,
  };
}
