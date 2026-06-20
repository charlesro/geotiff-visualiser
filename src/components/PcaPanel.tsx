import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  CartesianGrid,
  Symbols,
  useXAxisScale,
  useYAxisScale,
  usePlotArea,
} from 'recharts';
import { PcaRunResult } from '../lib/pca';
import { PixelZone } from '../lib/zones';
import { CLUSTER_COLORS, fieldKeyOf } from '../lib/species-clusters';
import { mixHexColors } from '../lib/unmix';
import { ZONE_CLASSES, ZONE_COLOR, zoneColor, speciesColor, categoricalColor, NEUTRAL } from '../lib/legend';
import { cn } from '../lib/utils';

/**
 * Results drawer — the working surface for the PCA. The scatter is fully
 * driven from here: which pixel classes are projected, a colour encoding and
 * a shape encoding (two attributes visible at once), and point picking that
 * highlights the corresponding pixel on the map.
 */

const ZONE_CHIPS = ZONE_CLASSES.map(z => ({ key: z.key, label: z.short }));

type SymbolType = 'circle' | 'triangle' | 'square' | 'diamond' | 'star' | 'cross' | 'wye';
const SYMBOL_TYPES: SymbolType[] = ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'wye'];

type Attr = 'zone' | 'species' | 'scenario' | 'field' | 'pair' | 'mixing';
const ATTR_LABEL: Record<Attr, string> = {
  zone: 'pixel class',
  species: 'species',
  scenario: 'scenario',
  field: 'field',
  pair: 'pair',
  mixing: 'species mix',
};

/** Keep the scatter responsive — evenly sampled above this. */
const MAX_POINTS = 4000;

/** Even subsample of an array down to at most n items. */
function subsample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  return Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]);
}

/** Mean Euclidean distance (over the first `dims` PCs) from a point to its K
 *  nearest neighbours in `ref`. Used both for the boundary score (distance to
 *  the pure blobs) and, with `ref` = all points, as a local-density proxy. */
function meanNearest(scores: number[], ref: { scores: number[] }[], dims: number, K: number): number {
  const kbest = new Float64Array(K).fill(Infinity);
  for (const q of ref) {
    let s = 0;
    for (let k = 0; k < dims; k++) {
      const e = scores[k] - q.scores[k];
      s += e * e;
    }
    if (s < kbest[K - 1]) {
      let j = K - 1;
      while (j > 0 && kbest[j - 1] > s) {
        kbest[j] = kbest[j - 1];
        j--;
      }
      kbest[j] = s;
    }
  }
  let acc = 0;
  for (let k = 0; k < K; k++) acc += Math.sqrt(kbest[k]);
  return acc / K;
}

/** k-means (over the first `dims` PCs) with deterministic farthest-point
 *  seeding. Returns the centroids and each point's cluster index. Used by the
 *  unsupervised boundary finder to locate the pure clusters without labels. */
function kmeans(pts: { scores: number[] }[], k: number, dims: number): { cent: number[][]; asn: Int32Array } {
  const d2 = (a: number[], b: number[]) => {
    let s = 0;
    for (let i = 0; i < dims; i++) {
      const e = a[i] - b[i];
      s += e * e;
    }
    return s;
  };
  const cent: number[][] = [pts[0].scores.slice(0, dims)];
  while (cent.length < k) {
    let far = pts[0].scores;
    let fd = -1;
    for (const p of pts) {
      let m = Infinity;
      for (const c of cent) {
        const dd = d2(p.scores, c);
        if (dd < m) m = dd;
      }
      if (m > fd) {
        fd = m;
        far = p.scores;
      }
    }
    cent.push(far.slice(0, dims));
  }
  const asn = new Int32Array(pts.length);
  for (let it = 0; it < 40; it++) {
    let moved = false;
    for (let p = 0; p < pts.length; p++) {
      let b = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = d2(pts[p].scores, cent[c]);
        if (dd < bd) {
          bd = dd;
          b = c;
        }
      }
      asn[p] = b;
    }
    const sum = cent.map(() => new Float64Array(dims));
    const cnt = new Int32Array(k);
    for (let p = 0; p < pts.length; p++) {
      cnt[asn[p]]++;
      for (let i = 0; i < dims; i++) sum[asn[p]][i] += pts[p].scores[i];
    }
    for (let c = 0; c < k; c++) {
      if (!cnt[c]) continue;
      for (let i = 0; i < dims; i++) {
        const v = sum[c][i] / cnt[c];
        if (v !== cent[c][i]) moved = true;
        cent[c][i] = v;
      }
    }
    if (!moved) break;
  }
  return { cent, asn };
}

/** Mean silhouette of a clustering (how compact + separated), on an even
 *  subsample for speed. Used to auto-pick the number of clusters k: higher is
 *  better. Range roughly [-1, 1]. */
function silhouette(pts: { scores: number[] }[], asn: Int32Array, k: number, dims: number): number {
  const N = pts.length;
  const sN = Math.min(500, N);
  const idx = Array.from({ length: sN }, (_, i) => Math.floor((i * N) / sN));
  const sums = new Float64Array(k);
  const cnts = new Int32Array(k);
  let total = 0;
  let count = 0;
  for (const i of idx) {
    sums.fill(0);
    cnts.fill(0);
    for (const j of idx) {
      if (j === i) continue;
      let s = 0;
      for (let d = 0; d < dims; d++) {
        const e = pts[i].scores[d] - pts[j].scores[d];
        s += e * e;
      }
      const dd = Math.sqrt(s);
      sums[asn[j]] += dd;
      cnts[asn[j]]++;
    }
    const ci = asn[i];
    if (cnts[ci] === 0) continue;
    const a = sums[ci] / cnts[ci];
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === ci || cnts[c] === 0) continue;
      const mean = sums[c] / cnts[c];
      if (mean < b) b = mean;
    }
    if (!isFinite(b)) continue;
    total += (b - a) / Math.max(a, b, 1e-9);
    count++;
  }
  return count > 0 ? total / count : -1;
}

/**
 * Draws the k-means pure clusters found by the unsupervised boundary finder:
 * a cross at each centroid and a circle drawn at the flagging contour — the
 * blob's radius grown by the current threshold (the gap distance beyond the
 * edge at which a pixel is flagged). So the circle *is* the boundary; nothing
 * inside it is flagged. Rendered inside the ScatterChart so it can read the
 * axis scales (recharts v3 hooks).
 */
function BlobOverlay({
  clusters,
  threshold,
  showLines,
  corridorDist,
}: {
  clusters: { c: number[]; r: number }[];
  threshold: number;
  showLines: boolean;
  /** Half-width of the corridor band to draw (the direction threshold, data units). */
  corridorDist: number;
}) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  if (!xScale || !yScale) return null;
  // Pixels per data unit, averaged over the two axes (near equal-scale).
  const sx = Math.abs((xScale(1) as number) - (xScale(0) as number));
  const sy = Math.abs((yScale(1) as number) - (yScale(0) as number));
  const s = (sx + sy) / 2;
  const px = (cl: { c: number[] }) => [xScale(cl.c[0]) as number, yScale(cl.c[1]) as number];
  const band = 2 * corridorDist * s; // pixel width of the kept-corridor band
  return (
    <g style={{ pointerEvents: 'none' }}>
      {/* The mixing corridors: between every pair of blob centroids, a faint
          band the width of the direction threshold (the kept region) + the
          centre line. */}
      {showLines &&
        clusters.flatMap((a, i) =>
          clusters.slice(i + 1).map((b, j) => {
            const [ax, ay] = px(a);
            const [bx, by] = px(b);
            if (![ax, ay, bx, by].every(isFinite)) return null;
            return (
              <g key={`l-${i}-${j}`}>
                {band > 0.5 && (
                  <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#38bdf8" strokeWidth={band} strokeLinecap="round" opacity={0.07} />
                )}
                <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#38bdf8" strokeWidth={1} strokeDasharray="2 4" opacity={0.45} />
              </g>
            );
          })
        )}
      {clusters.map((cl, i) => {
        // Centroid is already in the displayed (pcX, pcY) plane.
        const cx = xScale(cl.c[0]) as number;
        const cy = yScale(cl.c[1]) as number;
        const r = (cl.r + threshold) * s; // flagging contour: dist − radius = threshold
        if (!isFinite(cx) || !isFinite(cy) || !isFinite(r) || r <= 0) return null;
        return (
          <g key={i}>
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="5 4" opacity={0.6} />
            <line x1={cx - 6} y1={cy} x2={cx + 6} y2={cy} stroke="#38bdf8" strokeWidth={1.5} />
            <line x1={cx} y1={cy - 6} x2={cx} y2={cy + 6} stroke="#38bdf8" strokeWidth={1.5} />
            <text x={cx + 8} y={cy - 8} fontSize={11} fontWeight={600} fill="#7dd3fc">
              blob {i + 1}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Pink rings on the flagged boundary pixels, drawn as a light SVG layer inside
 * the chart (reads the axis scales). Kept separate from the main <Scatter> so
 * moving the threshold sliders only redraws these few rings, not the whole
 * point cloud.
 */
function BoundaryHighlight({ points }: { points: { x: number; y: number }[] }) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  if (!xScale || !yScale || points.length === 0) return null;
  return (
    <g style={{ pointerEvents: 'none' }}>
      {points.map((p, i) => {
        const cx = xScale(p.x) as number;
        const cy = yScale(p.y) as number;
        if (!isFinite(cx) || !isFinite(cy)) return null;
        return <circle key={i} cx={cx} cy={cy} r={7} fill="none" stroke="#e879f9" strokeWidth={2} />;
      })}
    </g>
  );
}

/** Reports the chart's real plot-area aspect (width/height) so the parent can
 *  make the axes exactly equal-scale — then a data-circle renders as a true
 *  circle and the blob circles match the score precisely. */
function PlotAspectProbe({ onAspect }: { onAspect: (a: number) => void }) {
  const area = usePlotArea();
  useEffect(() => {
    if (area && area.width > 0 && area.height > 0) onAspect(area.width / area.height);
  }, [area?.width, area?.height, onAspect]);
  return null;
}

export interface PcaPickedPixel {
  id: string;
  zone: PixelZone;
  lng: number;
  lat: number;
}

interface PcaPanelProps {
  result: PcaRunResult;
  busy: boolean;
  /** Drawer width (px) — drag the left edge to change it. */
  width: number;
  onWidthChange: (w: number) => void;
  /** Field key → scenario index, from step 4 (null = not clustered). */
  clusterAssignment: Map<string, number> | null;
  /** Classes projected in the space — editable right here. */
  projectZones: PixelZone[];
  onProjectZonesChange: (zones: PixelZone[]) => void;
  /** Point picked in the scatter, mirrored as a ring on the map. */
  highlightPixelId: string | null;
  onPickPixel: (pixel: PcaPickedPixel | null) => void;
  /** Edge·other pixels flagged as boundaries (PCA-gap finder) → shown on the map. */
  onBoundaryPixels?: (pixels: { id: string; lng: number; lat: number }[]) => void;
  onClose: () => void;
  onExportCsv: () => void;
}

export default function PcaPanel({
  result,
  busy,
  width,
  onWidthChange,
  clusterAssignment,
  projectZones,
  onProjectZonesChange,
  highlightPixelId,
  onPickPixel,
  onBoundaryPixels,
  onClose,
  onExportCsv,
}: PcaPanelProps) {
  const [tab, setTab] = useState<'scatter' | 'variance' | 'loadings'>('scatter');
  const [pcX, setPcX] = useState(0);
  const [pcY, setPcY] = useState(1);
  const [colorBy, setColorBy] = useState<Attr>('zone');
  const [shapeBy, setShapeBy] = useState<Attr | 'none'>('species');
  // Experimental boundary finder: flag edge·other pixels sitting deep in the
  // gap between the pure-interior blobs in PCA space.
  const [boundaryOn, setBoundaryOn] = useState(false);
  const [boundaryT, setBoundaryT] = useState<number | null>(null); // null = default
  // Unsupervised: ignore the edge/interior labels — find the pure clusters by
  // k-means and score every pixel by how "between" two of them it is.
  const [boundaryUnsup, setBoundaryUnsup] = useState(false);
  const [boundaryK, setBoundaryK] = useState<number | 'auto'>('auto'); // pure-cluster count, or auto
  // Direction gate: a boundary pixel is a mixture, so it sits *on the line*
  // between two blobs. Keep only pixels within a small perpendicular distance
  // of a corridor (the segment between a pair of blobs they project between).
  const [boundaryDir, setBoundaryDir] = useState(false);
  const [boundaryDirDist, setBoundaryDirDist] = useState<number | null>(null); // null = default
  // Real plot-area aspect (width/height), measured from the chart, for exact
  // equal-scale axes so the blob circles render as true circles.
  const [measuredAspect, setMeasuredAspect] = useState<number | null>(null);
  const onAspect = useCallback(
    (a: number) => setMeasuredAspect(prev => (prev === null || Math.abs(prev - a) > 0.01 ? a : prev)),
    []
  );

  const hasPairs = useMemo(() => result.rows.some(r => r.properties?.pair_id != null), [result]);
  const hasMixing = useMemo(() => result.rows.some(r => typeof r.properties?.mix_frac_a === 'number'), [result]);
  // The two species defining the mix axis (from any unmixed pixel).
  const mixAxis = useMemo(() => {
    const r = result.rows.find(r => typeof r.properties?.mix_frac_a === 'number');
    return r ? { a: String(r.properties.mix_a_species), b: String(r.properties.mix_b_species) } : null;
  }, [result]);
  const attrOptions = useMemo(() => {
    const opts: Attr[] = ['zone', 'species'];
    if (clusterAssignment) opts.push('scenario');
    opts.push('field');
    if (hasPairs) opts.push('pair');
    if (hasMixing) opts.push('mixing');
    return opts;
  }, [clusterAssignment, hasPairs, hasMixing]);
  // Shapes are categorical; the continuous mixing fraction can only colour.
  const shapeOptions = useMemo(() => attrOptions.filter(a => a !== 'mixing'), [attrOptions]);

  const attrValue = useMemo(
    () =>
      (row: PcaRunResult['rows'][number], attr: Attr): string => {
        const props = row.properties || {};
        switch (attr) {
          case 'zone':
            return row.zone;
          case 'species':
            return String(props.crp_lbl ?? props.species ?? 'unknown');
          case 'scenario': {
            const c = clusterAssignment?.get(fieldKeyOf(props));
            return c !== undefined ? `scenario ${c + 1}` : 'unclustered';
          }
          case 'field':
            return String(props.NewID ?? row.polygonId ?? 'unknown');
          case 'pair':
            return props.pair_id != null ? String(props.pair_id) : 'no pair';
          case 'mixing':
            return ''; // continuous — coloured per point, no categories
        }
      },
    [clusterAssignment]
  );

  /** Ordered categories of an attribute with their counts over all rows. */
  const categoriesOf = (attr: Attr): { name: string; count: number }[] => {
    const counts = new Map<string, number>();
    for (const row of result.rows) {
      const v = attrValue(row, attr);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([name, count]) => ({ name, count }));
  };

  const colorCats = useMemo(() => (colorBy === 'mixing' ? [] : categoriesOf(colorBy)), [result, colorBy, attrValue]);
  const shapeCats = useMemo(
    () => (shapeBy === 'none' ? [] : categoriesOf(shapeBy)),
    [result, shapeBy, attrValue]
  );

  const colorOf = (attr: Attr, name: string, index: number): string => {
    if (attr === 'zone') return zoneColor(name);
    if (attr === 'species') return speciesColor(name);
    if (attr === 'scenario') {
      if (name === 'unclustered') return NEUTRAL;
      const n = Number(name.split(' ')[1]) - 1;
      return CLUSTER_COLORS[n % CLUSTER_COLORS.length];
    }
    return categoricalColor(index);
  };

  // Boundary finder. In PCA space the pure pixels form the species blobs; a
  // genuine mix sits in the gap *between* them, far from any pure signature.
  // Each candidate pixel is scored by its mean distance to its few nearest
  // *pure* pixels — the deeper in the gap, the higher the score — and a
  // threshold keeps only those far enough from every blob (most "in the
  // middle"). Two ways to define "pure" and "candidate":
  //   supervised   — pure = interior label, candidates = edge·other label.
  //   unsupervised — pure = the densest pixels (found from the data, no
  //                  labels), candidates = every pixel; the finder never sees
  //                  which pixels are edges.
  const canFindBoundary = useMemo(() => result.rows.length >= 10, [result]);
  const boundary = useMemo(() => {
    if (!boundaryOn) return null; // skip the (sometimes heavy) work when off
    const dims = result.components;
    const rows = result.rows;
    let ref: typeof rows;
    let candidates: typeof rows;
    if (!boundaryUnsup) {
      ref = rows.filter(r => r.zone === 'interior');
      candidates = rows.filter(r => r.zone === 'edge_other_species');
    } else {
      // Unsupervised, computed entirely in the *displayed* 2D plane (pcX, pcY)
      // so the blob circles and the flagging are the exact same shape — a pixel
      // inside a drawn circle is never flagged (no hidden PC3 to disagree).
      // k-means finds the pure clusters; each blob is a circle at its centroid
      // with radius = its largest 2σ spread (major axis of the 2×2 covariance).
      // A pixel is scored by its distance to the nearest circle *edge*: negative
      // inside a blob, a positive gap distance outside.
      const px = (row: (typeof rows)[number]) => [row.scores[pcX], row.scores[pcY]];
      const uni = subsample(rows, 2500).map(row => ({ scores: px(row) }));
      if (uni.length < 5) return null;
      // Choose k: the requested value, or auto-pick the one with the best
      // silhouette over 2..6 clusters (most compact + separated).
      let k: number;
      if (boundaryK === 'auto') {
        const kMax = Math.min(6, uni.length - 1);
        let bestK = 2;
        let bestSil = -Infinity;
        for (let kk = 2; kk <= kMax; kk++) {
          const sil = silhouette(uni, kmeans(uni, kk, 2).asn, kk, 2);
          if (sil > bestSil) {
            bestSil = sil;
            bestK = kk;
          }
        }
        k = bestK;
      } else {
        k = Math.min(boundaryK, uni.length);
      }
      if (uni.length < k + 3 || k < 2) return null;
      const { cent, asn } = kmeans(uni, k, 2);
      const clusters = cent.map((mu, c) => {
        let a = 0;
        let b = 0;
        let d = 0;
        let n = 0;
        for (let p = 0; p < uni.length; p++) {
          if (asn[p] !== c) continue;
          n++;
          const dx = uni[p].scores[0] - mu[0];
          const dy = uni[p].scores[1] - mu[1];
          a += dx * dx;
          b += dx * dy;
          d += dy * dy;
        }
        const m = Math.max(1, n - 1);
        a /= m;
        b /= m;
        d /= m;
        const mean = (a + d) / 2;
        const rad = Math.sqrt(Math.max(0, ((a - d) / 2) ** 2 + b * b));
        const r = 2 * Math.sqrt(Math.max(1e-9, mean + rad)); // 2σ along the major axis
        return { c: mu, r };
      });
      const scoreById = new Map<string, number>();
      const dirById = new Map<string, number>();
      let max = 0;
      let dirMax = 0;
      for (const row of rows) {
        const x = row.scores[pcX];
        const y = row.scores[pcY];
        let best = Infinity; // min distance to any circle edge
        for (const cl of clusters) {
          const dx = x - cl.c[0];
          const dy = y - cl.c[1];
          if (Math.sqrt(dx * dx + dy * dy) - cl.r < best) best = Math.sqrt(dx * dx + dy * dy) - cl.r;
        }
        scoreById.set(row.pixelId, best); // ≤ 0 inside a circle, > 0 = gap distance
        if (best > max) max = best;
        // Perpendicular distance to the nearest mixing corridor: the segment
        // between a pair of blobs that the pixel projects *between* (0 ≤ t ≤ 1).
        // Small = on the line between two blobs; ∞ = not between any pair.
        let dir = Infinity;
        for (let i = 0; i < clusters.length; i++) {
          const A = clusters[i].c;
          for (let j = i + 1; j < clusters.length; j++) {
            const B = clusters[j].c;
            const abx = B[0] - A[0];
            const aby = B[1] - A[1];
            const l2 = abx * abx + aby * aby || 1e-9;
            const t = ((x - A[0]) * abx + (y - A[1]) * aby) / l2;
            if (t < 0 || t > 1) continue;
            const ex = x - (A[0] + t * abx);
            const ey = y - (A[1] + t * aby);
            const perp = Math.sqrt(ex * ex + ey * ey);
            if (perp < dir) dir = perp;
          }
        }
        dirById.set(row.pixelId, dir);
        if (isFinite(dir) && dir > dirMax) dirMax = dir;
      }
      const avgR = clusters.reduce((s, cl) => s + cl.r, 0) / clusters.length;
      return {
        scoreById,
        dirById: dirById as Map<string, number> | undefined,
        dirMax,
        dirDefault: avgR, // ~one blob radius off the line
        max,
        defaultT: 0, // the blob circle edge
        count: rows.length,
        k: k as number | undefined,
        clusters: clusters as { c: number[]; r: number }[] | undefined,
      };
    }
    if (ref.length < 5 || candidates.length === 0) return null;
    const refSub = subsample(ref, 1500);
    const K = Math.min(4, refSub.length);
    const scoreById = new Map<string, number>();
    let max = 0;
    for (const r of candidates) {
      const score = meanNearest(r.scores, refSub, dims, K);
      scoreById.set(r.pixelId, score);
      if (score > max) max = score;
    }
    const sorted = Array.from(scoreById.values()).sort((a, b) => a - b);
    const defaultT = sorted[Math.floor(sorted.length * 0.6)] || 0;
    return {
      scoreById,
      dirById: undefined as Map<string, number> | undefined,
      dirMax: 0,
      dirDefault: 0,
      max,
      defaultT,
      count: candidates.length,
      k: undefined as number | undefined,
      clusters: undefined as { c: number[]; r: number }[] | undefined,
    };
  }, [result, boundaryOn, boundaryUnsup, boundaryK, pcX, pcY]);

  const boundaryT_ = boundaryT ?? boundary?.defaultT ?? 0;
  const boundaryDirDist_ = boundaryDirDist ?? boundary?.dirDefault ?? 0;
  // The slider thumbs read the immediate values above; the flagging + overlay
  // recompute off these deferred copies so dragging stays responsive even with
  // thousands of points (React renders the heavy update at lower priority).
  const dBoundaryT = useDeferredValue(boundaryT_);
  const dBoundaryDirDist = useDeferredValue(boundaryDirDist_);
  const boundaryIds = useMemo(() => {
    const set = new Set<string>();
    if (!boundaryOn || !boundary) return set;
    const dir = boundary.dirById;
    const gate = boundaryDir && dir;
    for (const [id, sc] of boundary.scoreById) {
      if (sc < dBoundaryT) continue;
      // Direction gate: keep only pixels close to a corridor between two blobs.
      if (gate && (dir.get(id) ?? Infinity) > dBoundaryDirDist) continue;
      set.add(id);
    }
    return set;
  }, [boundaryOn, boundary, dBoundaryT, boundaryDir, dBoundaryDirDist]);

  // Validation: of the flagged pixels, how many are actually labelled edge·other
  // (the real boundaries). Meaningful in unsupervised mode — the finder didn't
  // use those labels, so this is its precision against ground truth.
  const boundaryEdgeFrac = useMemo(() => {
    if (boundaryIds.size === 0) return null;
    let e = 0;
    for (const r of result.rows) if (boundaryIds.has(r.pixelId) && r.zone === 'edge_other_species') e++;
    return e / boundaryIds.size;
  }, [boundaryIds, result]);

  // Mirror the flagged pixels onto the map.
  useEffect(() => {
    if (!onBoundaryPixels) return;
    const pix =
      boundaryOn && boundary
        ? result.rows.filter(r => boundaryIds.has(r.pixelId)).map(r => ({ id: r.pixelId, lng: r.lng, lat: r.lat }))
        : [];
    onBoundaryPixels(pix);
  }, [boundaryIds, boundaryOn, boundary, result, onBoundaryPixels]);

  // Clear the map markers when the panel unmounts.
  useEffect(() => () => onBoundaryPixels?.([]), [onBoundaryPixels]);

  // The rows actually drawn (evenly sub-sampled past MAX_POINTS). Kept apart
  // from `points` and from the boundary state so neither the heavy point cloud
  // nor this list rebuilds when only a threshold slider moves.
  const displayedRows = useMemo(() => {
    let rows =
      result.rows.length > MAX_POINTS
        ? Array.from({ length: MAX_POINTS }, (_, i) => result.rows[Math.floor((i * result.rows.length) / MAX_POINTS)])
        : result.rows;
    // Always include the highlighted pixel (e.g. picked on the map) so its
    // ring shows even when the scatter is sub-sampled.
    if (highlightPixelId && !rows.some(r => r.pixelId === highlightPixelId)) {
      const sel = result.rows.find(r => r.pixelId === highlightPixelId);
      if (sel) rows = [...rows, sel];
    }
    return rows;
  }, [result, highlightPixelId]);

  const points = useMemo(() => {
    const colorIdx = new Map(colorCats.map((c, i) => [c.name, i]));
    const shapeIdx = new Map(shapeCats.map((c, i) => [c.name, i]));
    return displayedRows.map(row => {
      const cv = attrValue(row, colorBy);
      const sv = shapeBy === 'none' ? null : attrValue(row, shapeBy);
      // Mixing: continuous scale on the own-field fraction; pixels with no
      // fraction (interior, isolated…) stay muted so the mixed ones stand out.
      let color: string;
      if (colorBy === 'mixing') {
        const frac = row.properties?.mix_frac_a;
        color =
          typeof frac === 'number' && mixAxis
            ? mixHexColors(speciesColor(mixAxis.b), speciesColor(mixAxis.a), frac)
            : '#334155';
      } else {
        color = colorOf(colorBy, cv, colorIdx.get(cv) ?? 0);
      }
      return {
        x: row.scores[pcX],
        y: row.scores[pcY],
        pixelId: row.pixelId,
        color,
        symbol: (sv === null ? 'circle' : SYMBOL_TYPES[(shapeIdx.get(sv) ?? 0) % SYMBOL_TYPES.length]) as SymbolType,
        row,
      };
    });
  }, [displayedRows, pcX, pcY, colorBy, shapeBy, colorCats, shapeCats, attrValue, mixAxis]);

  // Coordinates of the flagged boundary pixels among the drawn rows — fed to the
  // lightweight overlay, so threshold changes never touch the main scatter.
  const boundaryHi = useMemo(() => {
    if (!boundaryOn || boundaryIds.size === 0) return [];
    const out: { x: number; y: number }[] = [];
    for (const r of displayedRows) {
      if (boundaryIds.has(r.pixelId)) out.push({ x: r.scores[pcX], y: r.scores[pcY] });
    }
    return out;
  }, [boundaryOn, boundaryIds, displayedRows, pcX, pcY]);

  const pick = (p: (typeof points)[number]) => {
    if (highlightPixelId === p.pixelId) onPickPixel(null);
    else onPickPixel({ id: p.pixelId, zone: p.row.zone, lng: p.row.lng, lat: p.row.lat });
  };

  const pickedRow = useMemo(
    () => (highlightPixelId ? result.rows.find(r => r.pixelId === highlightPixelId) || null : null),
    [highlightPixelId, result]
  );

  // Drag the drawer's left edge to resize it (the map gets the rest).
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const w = Math.round(window.innerWidth - ev.clientX);
      onWidthChange(Math.max(440, Math.min(window.innerWidth - 320, w)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Equal scale on both axes (same units per pixel), so distances in the
  // scatter are honest: the domains are centred on the data and sized from
  // the larger spread, corrected by the plot's width/height ratio.
  const CHART_W = width - 40; // p-4 padding + border
  const CHART_H = 470;
  const Y_AXIS_W = 60;
  const X_AXIS_H = 40;
  const plotW = CHART_W - 10 - Y_AXIS_W; // margins: right 10, left 0
  const plotH = CHART_H - 10 - 10 - X_AXIS_H; // margins: top 10, bottom 10
  // Use the real plot aspect once measured; fall back to the estimate first paint.
  const plotAspect = measuredAspect ?? plotW / plotH;
  const domains = useMemo(() => {
    if (points.length === 0) return { x: [0, 1] as [number, number], y: [0, 1] as [number, number] };
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of points) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    const ry = Math.max((yMax - yMin) / 2, (xMax - xMin) / 2 / plotAspect, 1e-6) * 1.08;
    const rx = ry * plotAspect;
    return { x: [cx - rx, cx + rx] as [number, number], y: [cy - ry, cy + ry] as [number, number] };
  }, [points, plotAspect]);

  const toggleProjected = (zone: PixelZone) => {
    if (projectZones.includes(zone)) {
      if (projectZones.length === 1) return; // keep at least one class in the space
      onProjectZonesChange(projectZones.filter(z => z !== zone));
    } else {
      onProjectZonesChange([...projectZones, zone]);
    }
  };

  const renderPoint = (props: any) => {
    const { cx, cy, payload } = props;
    if (typeof cx !== 'number' || typeof cy !== 'number') return <g />;
    const selected = payload.pixelId === highlightPixelId;
    return (
      <g onClick={() => pick(payload)} style={{ cursor: 'pointer' }}>
        {selected && <circle cx={cx} cy={cy} r={9} fill="none" stroke="#ffffff" strokeWidth={2} />}
        <Symbols
          cx={cx}
          cy={cy}
          type={payload.symbol}
          size={selected ? 90 : 34}
          fill={payload.color}
          fillOpacity={selected ? 1 : 0.82}
          stroke="#0b0e11"
          strokeWidth={selected ? 0 : 0.6}
          strokeOpacity={0.55}
        />
      </g>
    );
  };

  // Stable Scatter element: re-create it only when the drawn points or the
  // selection change (renderPoint closes over highlightPixelId for the ring).
  // Slider-driven boundary updates touch neither, so they reuse this element
  // and the (up to MAX_POINTS) custom shapes are not rebuilt each tick.
  const scatterEl = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => <Scatter data={points} shape={renderPoint} isAnimationActive={false} />,
    [points, highlightPixelId]
  );

  const varianceData = result.explained.map((v, i) => ({
    pc: `PC${i + 1}`,
    explained: Number(v.toFixed(2)),
    cumulative: Number(result.cumulative[i].toFixed(2)),
  }));

  const loadingsData = result.dates.map((date, i) => {
    const entry: Record<string, any> = { date };
    result.loadings.forEach((component, c) => {
      entry[`PC${c + 1}`] = Number(component[i]?.toFixed(4));
    });
    return entry;
  });

  const pcLabel = (i: number) => `PC${i + 1} (${result.explained[i].toFixed(1)}%)`;
  const selectClass =
    'rounded-md border border-white/10 bg-[#0b0e11] px-2 py-1 text-xs text-slate-300 focus:outline-none';

  const pickedLabel = (row: PcaRunResult['rows'][number]): string => {
    const props = row.properties || {};
    const species = props.crp_lbl ?? props.species;
    return species && props.NewID !== undefined ? `${species} · ${props.NewID}` : String(row.polygonId ?? row.pixelId);
  };

  return (
    <div
      className="absolute inset-y-0 right-0 z-[1100] flex max-w-full flex-col border-l border-white/10 bg-[#0d1117f5] backdrop-blur"
      style={{ width }}
    >
      <div
        onPointerDown={startResize}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-sky-500/40"
        title="Drag to resize"
      />
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            PCA results
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />}
          </h2>
          <p className="text-[11px] text-slate-500">
            axes fit on {result.fitCount} px (
            {result.fitZones.map(z => ZONE_CHIPS.find(c => c.key === z)?.label ?? z).join(', ')}) ·{' '}
            {result.rows.length} px placed · {result.metric} · {result.dates.length} dates ·{' '}
            {result.interpolatedFraction > 0.005 && (
              <span
                title="Some pixels were not imaged on every date (fields on different Sentinel-2 overpasses, or clouds). Those gaps were filled by interpolating each pixel's own NDVI curve, so every field is included on the same date axis."
                className="text-amber-300/90 underline decoration-dotted"
              >
                {(result.interpolatedFraction * 100).toFixed(0)}% interpolated ·{' '}
              </span>
            )}
            {result.cumulative[result.components - 1]?.toFixed(1)}% variance in {result.components} PCs
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onExportCsv} className="rounded-md border border-white/10 p-1.5 text-slate-400 hover:text-slate-200">
            <Download className="h-4 w-4" />
          </button>
          <button onClick={onClose} className="rounded-md border border-white/10 p-1.5 text-slate-400 hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex border-b border-white/10 text-xs">
        {(['scatter', 'variance', 'loadings'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-2 capitalize transition-colors',
              tab === t ? 'border-b-2 border-sky-500 text-sky-300' : 'text-slate-500 hover:text-slate-300'
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'scatter' && (
          <>
            {/* Projected classes — live, re-runs the projection */}
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Projected</span>
              {ZONE_CHIPS.map(z => {
                const active = projectZones.includes(z.key);
                return (
                  <button
                    key={z.key}
                    onClick={() => toggleProjected(z.key)}
                    disabled={busy}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                      active
                        ? 'border-white/30 bg-white/10 text-slate-200'
                        : 'border-white/10 text-slate-600 hover:text-slate-400'
                    )}
                  >
                    <span
                      className={cn('h-1.5 w-1.5 rounded-full', !active && 'opacity-30')}
                      style={{ background: ZONE_COLOR[z.key] }}
                    />
                    {z.label}
                  </button>
                );
              })}
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <label className="flex items-center gap-1.5">
                X
                <select className={selectClass} value={pcX} onChange={e => setPcX(Number(e.target.value))}>
                  {result.explained.map((_, i) => (
                    <option key={i} value={i}>{`PC${i + 1}`}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                Y
                <select className={selectClass} value={pcY} onChange={e => setPcY(Number(e.target.value))}>
                  {result.explained.map((_, i) => (
                    <option key={i} value={i}>{`PC${i + 1}`}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                Colour
                <select className={selectClass} value={colorBy} onChange={e => setColorBy(e.target.value as Attr)}>
                  {attrOptions.map(a => (
                    <option key={a} value={a}>
                      {ATTR_LABEL[a]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                Shape
                <select
                  className={selectClass}
                  value={shapeBy}
                  onChange={e => setShapeBy(e.target.value as Attr | 'none')}
                >
                  <option value="none">none</option>
                  {shapeOptions
                    .filter(a => a !== colorBy)
                    .map(a => (
                      <option key={a} value={a}>
                        {ATTR_LABEL[a]}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            {canFindBoundary && (
              <div className="mb-2 rounded-md border border-fuchsia-500/25 bg-fuchsia-500/5 px-2.5 py-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-200">
                  <input
                    type="checkbox"
                    checked={boundaryOn}
                    onChange={e => setBoundaryOn(e.target.checked)}
                    className="accent-fuchsia-500"
                  />
                  <span className="font-medium">Find boundaries</span>
                  <span className="text-[11px] text-slate-500">pixels in the gap between the pure blobs</span>
                </label>
                {boundaryOn && (
                  <div className="mt-2 space-y-1.5">
                    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
                      <input
                        type="checkbox"
                        checked={boundaryUnsup}
                        onChange={e => {
                          setBoundaryUnsup(e.target.checked);
                          setBoundaryT(null); // score scale differs per mode — reset to its default
                        }}
                        className="accent-fuchsia-500"
                      />
                      Ignore labels (unsupervised) — find pure clusters, flag pixels between them
                    </label>
                    {boundaryUnsup && (
                      <label className="flex items-center gap-2 text-[11px] text-slate-500">
                        Pure clusters (k)
                        <select
                          value={boundaryK}
                          onChange={e => {
                            const v = e.target.value;
                            setBoundaryK(v === 'auto' ? 'auto' : Number(v));
                            setBoundaryT(null);
                          }}
                          className="rounded border border-white/10 bg-[#0b0e11] px-1.5 py-0.5 text-slate-300"
                        >
                          <option value="auto">auto</option>
                          {[2, 3, 4, 5, 6, 7, 8].map(n => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                        {boundaryK === 'auto' && boundary?.k != null && (
                          <span className="text-fuchsia-300">detected {boundary.k}</span>
                        )}
                      </label>
                    )}
                    {boundaryUnsup && (
                      <>
                        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
                          <input
                            type="checkbox"
                            checked={boundaryDir}
                            onChange={e => setBoundaryDir(e.target.checked)}
                            className="accent-fuchsia-500"
                          />
                          Between two blobs (use direction)
                        </label>
                        {boundaryDir && boundary && boundary.dirMax > 0 && (
                          <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                            <span>Max distance off the corridor</span>
                            <input
                              type="range"
                              min={0}
                              max={boundary.dirMax}
                              step={boundary.dirMax / 100}
                              value={boundaryDirDist_}
                              onChange={e => setBoundaryDirDist(Number(e.target.value))}
                              className="w-40 accent-fuchsia-500"
                            />
                          </label>
                        )}
                      </>
                    )}
                    {boundary && (
                      <>
                        <div className="flex items-center justify-between text-[11px] text-slate-500">
                          <span>{boundaryUnsup ? 'Gap beyond the blob edge (0 = circle)' : 'Min distance from a pure blob'}</span>
                          <span className="text-fuchsia-300">
                            {boundaryIds.size} / {boundary.count} flagged
                            {boundaryUnsup && boundaryEdgeFrac !== null && (
                              <span className="text-slate-500"> · {(boundaryEdgeFrac * 100).toFixed(0)}% real edges</span>
                            )}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={boundary.max}
                          step={boundary.max / 100 || 0.001}
                          value={boundaryT_}
                          onChange={e => setBoundaryT(Number(e.target.value))}
                          className="w-full accent-fuchsia-500"
                        />
                        <p className="text-[10px] leading-relaxed text-slate-600">
                          {boundaryUnsup
                            ? 'No labels: k-means finds k pure clusters, each drawn as a blue circle (centroid + its largest 2σ radius). A pixel is scored by its distance to the nearest circle *edge* — negative inside a blob, positive out in the gap — so the threshold is the gap distance beyond the edge at which a pixel counts as a boundary (0 = the circle itself). The circles grow with the threshold to match. “Between two blobs” adds a direction test: it keeps a flagged pixel only when it lies close to a *corridor* — the line between a pair of blobs it sits between (the dashed lines) — within the slider distance. So a pixel that drifts off in another direction, away from every corridor, drops out. k is auto-picked (best silhouette over 2–6 clusters); override it if the split looks wrong. “% real edges” is how often a flagged pixel is genuinely an edge·other pixel.'
                            : 'Higher keeps only the pixels most in the middle — farthest from any pure-species signature. Flagged pixels are ringed here and on the map.'}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            <div
              className="overflow-hidden rounded-xl ring-1 ring-inset ring-white/[0.06]"
              style={{ background: 'radial-gradient(125% 90% at 50% -10%, #161d26 0%, #0c1014 60%)' }}
            >
            <ScatterChart width={CHART_W} height={CHART_H} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid stroke="#ffffff0a" strokeDasharray="3 6" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={pcLabel(pcX)}
                  domain={domains.x}
                  height={X_AXIS_H}
                  tickFormatter={(v: number) => v.toFixed(2)}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: '#ffffff14' }}
                  label={{ value: pcLabel(pcX), position: 'insideBottom', offset: -5, fill: '#94a3b8', fontSize: 12 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={pcLabel(pcY)}
                  domain={domains.y}
                  width={Y_AXIS_W}
                  tickFormatter={(v: number) => v.toFixed(2)}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: '#ffffff14' }}
                  label={{ value: pcLabel(pcY), angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 12 }}
                />
                <ZAxis range={[32, 32]} />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3', stroke: '#475569' }}
                  content={({ payload }) => {
                    const p = payload?.[0]?.payload;
                    if (!p) return null;
                    return (
                      <div className="rounded-md border border-white/10 bg-[#11151a] px-2 py-1 text-[11px] text-slate-300">
                        <div>{pickedLabel(p.row)}</div>
                        <div className="text-slate-500">
                          {p.row.zone} · {p.x.toFixed(3)}, {p.y.toFixed(3)} · click to locate
                        </div>
                      </div>
                    );
                  }}
                />
                {scatterEl}
                {boundaryOn && <BoundaryHighlight points={boundaryHi} />}
                <PlotAspectProbe onAspect={onAspect} />
                {boundaryOn && boundaryUnsup && boundary?.clusters && (
                  <BlobOverlay
                    clusters={boundary.clusters}
                    threshold={dBoundaryT}
                    showLines={boundaryDir}
                    corridorDist={boundaryDir ? dBoundaryDirDist : 0}
                  />
                )}
            </ScatterChart>
            </div>

            {/* Colour legend */}
            {colorBy === 'mixing' ? (
              <div className="mt-2 text-[11px] text-slate-400">
                <span className="mr-2 font-medium uppercase tracking-wide text-slate-600">species mix</span>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[10px]">{mixAxis?.b}</span>
                  <div
                    className="h-2 flex-1 rounded"
                    style={{
                      background: mixAxis
                        ? `linear-gradient(to right, ${speciesColor(mixAxis.b)}, ${speciesColor(mixAxis.a)})`
                        : undefined,
                    }}
                  />
                  <span className="text-[10px]">{mixAxis?.a}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-slate-600">
                  edge-other pixels only; interior / isolated / same-species shown muted
                </div>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                <span className="font-medium uppercase tracking-wide text-slate-600">{ATTR_LABEL[colorBy]}</span>
                {colorCats.slice(0, 14).map((c, i) => (
                  <span key={c.name} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: colorOf(colorBy, c.name, i) }} />
                    {c.name} ({c.count})
                  </span>
                ))}
                {colorCats.length > 14 && <span className="text-slate-600">+{colorCats.length - 14} more</span>}
              </div>
            )}

            {/* Shape legend */}
            {shapeBy !== 'none' && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                <span className="font-medium uppercase tracking-wide text-slate-600">{ATTR_LABEL[shapeBy]}</span>
                {shapeCats.slice(0, SYMBOL_TYPES.length).map((c, i) => (
                  <span key={c.name} className="flex items-center gap-1.5">
                    <svg width={12} height={12}>
                      <Symbols cx={6} cy={6} type={SYMBOL_TYPES[i % SYMBOL_TYPES.length]} size={42} fill="#cbd5e1" />
                    </svg>
                    {c.name} ({c.count})
                  </span>
                ))}
                {shapeCats.length > SYMBOL_TYPES.length && (
                  <span className="text-amber-400/80">
                    +{shapeCats.length - SYMBOL_TYPES.length} more — only {SYMBOL_TYPES.length} shapes exist, pick a
                    coarser attribute
                  </span>
                )}
              </div>
            )}

            {result.rows.length > MAX_POINTS && (
              <p className="mt-1 text-[10px] text-slate-600">
                showing {MAX_POINTS} of {result.rows.length} points (evenly sampled)
              </p>
            )}

            {/* Picked point */}
            {pickedRow && (
              <div className="mt-2 rounded-md border border-white/15 bg-white/[0.04] px-3 py-2 text-[11px] text-slate-300">
                <div className="mb-0.5 flex items-center justify-between">
                  <span className="font-medium text-slate-200">{pickedLabel(pickedRow)}</span>
                  <button onClick={() => onPickPixel(null)} className="text-slate-500 hover:text-slate-300">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-slate-400">
                  <span>class: {pickedRow.zone}</span>
                  {pickedRow.properties?.pair_id != null && <span>pair: {String(pickedRow.properties.pair_id)}</span>}
                  {clusterAssignment && <span>{attrValue(pickedRow, 'scenario')}</span>}
                  <span>
                    {pickedRow.lat.toFixed(5)}, {pickedRow.lng.toFixed(5)}
                  </span>
                  {typeof pickedRow.properties?.mix_frac_a === 'number' && (
                    <span className="col-span-2 text-slate-300">
                      mix: {(pickedRow.properties.mix_frac_a * 100).toFixed(0)}% {pickedRow.properties.mix_a_species} ·{' '}
                      {((1 - pickedRow.properties.mix_frac_a) * 100).toFixed(0)}% {pickedRow.properties.mix_b_species}
                    </span>
                  )}
                  <span className="col-span-2">
                    scores: {pickedRow.scores.map((s, i) => `PC${i + 1} ${s.toFixed(3)}`).join(' · ')}
                  </span>
                </div>
                <div className="mt-1 text-slate-500">The white ring on the map marks this pixel.</div>
              </div>
            )}
          </>
        )}

        {tab === 'variance' && (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={varianceData} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid stroke="#ffffff14" vertical={false} />
                <XAxis dataKey="pc" tick={{ fill: '#64748b', fontSize: 11 }} />
                <YAxis unit="%" tick={{ fill: '#64748b', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#11151a', border: '1px solid #ffffff1a', borderRadius: 6, fontSize: 11 }} />
                <Bar dataKey="explained" name="Explained variance" fill="#38bdf8" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
            <table className="mt-4 w-full text-left text-xs text-slate-400">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1.5 font-medium">Component</th>
                  <th className="py-1.5 text-right font-medium">Explained</th>
                  <th className="py-1.5 text-right font-medium">Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {varianceData.map(row => (
                  <tr key={row.pc} className="border-t border-white/5">
                    <td className="py-1.5">{row.pc}</td>
                    <td className="py-1.5 text-right">{row.explained}%</td>
                    <td className="py-1.5 text-right">{row.cumulative}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {tab === 'loadings' && (
          <>
            <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
              Loadings show how much each acquisition date contributes to a component — peaks identify the periods
              that drive the variance between pixels.
            </p>
            <ResponsiveContainer width="100%" height={380}>
              <LineChart data={loadingsData} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid stroke="#ffffff14" />
                <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} angle={-35} textAnchor="end" height={55} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#11151a', border: '1px solid #ffffff1a', borderRadius: 6, fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {result.loadings.map((_, c) => (
                  <Line
                    key={c}
                    type="monotone"
                    dataKey={`PC${c + 1}`}
                    stroke={categoricalColor(c)}
                    dot={false}
                    strokeWidth={1.8}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
    </div>
  );
}
