import { Bbox, getGeoJsonBounds } from './geo';

/**
 * Greedy spatial clustering of the selected polygons.
 *
 * The analysis only needs native-resolution pixels inside (and just outside)
 * the polygons, so step 2 downloads one small 10 m window per cluster
 * instead of one huge grid over the whole selection. Neighbour-pair fields
 * are adjacent and naturally collapse into a single cluster.
 */

/** Padding around each feature, in metres — covers the outside edge ring. */
const PAD_METERS = 60;

/** A cluster's bbox never grows beyond this extent (metres). */
const MAX_EXTENT_METERS = 2500;

const M_PER_DEG_LAT = 111_320;

const padBbox = (b: Bbox): Bbox => {
  const midLat = (b[1] + b[3]) / 2;
  const dLat = PAD_METERS / M_PER_DEG_LAT;
  const dLng = PAD_METERS / (M_PER_DEG_LAT * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return [b[0] - dLng, b[1] - dLat, b[2] + dLng, b[3] + dLat];
};

const union = (a: Bbox, b: Bbox): Bbox => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

const extentMeters = (b: Bbox): number => {
  const midLat = (b[1] + b[3]) / 2;
  const w = (b[2] - b[0]) * M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
  const h = (b[3] - b[1]) * M_PER_DEG_LAT;
  return Math.max(w, h);
};

/**
 * Padded WGS84 bboxes covering all features, each at most ~2.5 km across.
 * Greedy: each feature joins the first cluster the union stays small with.
 */
export function clusterFeatureBboxes(features: any[]): Bbox[] {
  const clusters: Bbox[] = [];
  for (const f of features) {
    const fb = getGeoJsonBounds(f);
    if (!fb) continue;
    const padded = padBbox(fb);
    let merged = false;
    for (let i = 0; i < clusters.length; i++) {
      const u = union(clusters[i], padded);
      if (extentMeters(u) <= MAX_EXTENT_METERS) {
        clusters[i] = u;
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push(padded);
  }
  return clusters;
}
