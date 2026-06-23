/**
 * Clustering methods for the unsupervised boundary finder's "blob" detection.
 *
 * In the displayed PCA plane the pure pixels form dense blobs; the finder
 * fits a cluster to each, draws it as a circle, and scores every pixel by its
 * distance to the nearest circle. The blobs were always found by k-means; this
 * module adds alternatives so the split can be compared. Each method takes the
 * 2-D points and returns a cluster index per point (−1 = noise/unassigned), and
 * the number of clusters it found.
 */

export type BlobMethod = 'kmeans' | 'gmm' | 'dbscan' | 'agglomerative';

export interface BlobMethodInfo {
  id: BlobMethod;
  label: string;
  /** Whether the cluster count k is an input (else found from the data). */
  usesK: boolean;
  blurb: string;
}

export const BLOB_METHODS: BlobMethodInfo[] = [
  { id: 'kmeans', label: 'k-means', usesK: true, blurb: 'Compact, round clusters of roughly equal spread. The fast default.' },
  {
    id: 'gmm',
    label: 'Gaussian mixture',
    usesK: true,
    blurb: 'Elliptical clusters of varying shape and size (fit by EM) — handles stretched blobs better than k-means.',
  },
  {
    id: 'dbscan',
    label: 'DBSCAN (density)',
    usesK: false,
    blurb: 'Finds dense cores of any shape and leaves the sparse in-between pixels as noise; the cluster count comes from the data.',
  },
  {
    id: 'agglomerative',
    label: 'Single-link (MST)',
    usesK: true,
    blurb: 'Cuts the longest links of the minimum spanning tree — separates well-gapped groups, even non-round ones.',
  },
];

export interface BlobResult {
  /** Cluster index per input point; −1 = noise (DBSCAN only). */
  assign: number[];
  /** Number of clusters found. */
  k: number;
}

const sq = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const e = a[i] - b[i];
    s += e * e;
  }
  return s;
};

// ----- k-means (farthest-point seeding, deterministic) ------------------------

function kmeans(pts: number[][], k: number): number[] {
  const n = pts.length;
  const d = pts[0].length;
  const cent: number[][] = [pts[0].slice()];
  while (cent.length < k) {
    let far = pts[0];
    let fd = -1;
    for (const p of pts) {
      let m = Infinity;
      for (const c of cent) {
        const dd = sq(p, c);
        if (dd < m) m = dd;
      }
      if (m > fd) {
        fd = m;
        far = p;
      }
    }
    cent.push(far.slice());
  }
  const assign = new Array<number>(n).fill(0);
  for (let it = 0; it < 50; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let b = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = sq(pts[i], cent[c]);
        if (dd < bd) {
          bd = dd;
          b = c;
        }
      }
      if (assign[i] !== b) {
        assign[i] = b;
        moved = true;
      }
    }
    if (!moved && it > 0) break;
    const sum = cent.map(() => new Array(d).fill(0));
    const cnt = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      cnt[assign[i]]++;
      for (let j = 0; j < d; j++) sum[assign[i]][j] += pts[i][j];
    }
    for (let c = 0; c < k; c++) if (cnt[c]) for (let j = 0; j < d; j++) cent[c][j] = sum[c][j] / cnt[c];
  }
  return assign;
}

// ----- Gaussian mixture (2-D, full covariance, EM) ----------------------------

function gmm(pts: number[][], k: number): number[] {
  const n = pts.length;
  // init from k-means
  let assign = kmeans(pts, k);
  const mean = Array.from({ length: k }, () => [0, 0]);
  // covariance as [a, b, d] for [[a,b],[b,d]]
  const cov = Array.from({ length: k }, () => [1, 0, 1]);
  const w = new Array(k).fill(1 / k);
  const resp = Array.from({ length: n }, () => new Array(k).fill(0));
  const recompute = () => {
    const cnt = new Array(k).fill(0);
    for (const m of mean) {
      m[0] = 0;
      m[1] = 0;
    }
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      mean[c][0] += pts[i][0];
      mean[c][1] += pts[i][1];
      cnt[c]++;
    }
    for (let c = 0; c < k; c++) if (cnt[c]) {
      mean[c][0] /= cnt[c];
      mean[c][1] /= cnt[c];
    }
    for (let c = 0; c < k; c++) {
      let a = 0,
        b = 0,
        dd = 0;
      for (let i = 0; i < n; i++) {
        if (assign[i] !== c) continue;
        const dx = pts[i][0] - mean[c][0];
        const dy = pts[i][1] - mean[c][1];
        a += dx * dx;
        b += dx * dy;
        dd += dy * dy;
      }
      const m = Math.max(1, cnt[c]);
      cov[c] = [a / m + 1e-6, b / m, dd / m + 1e-6];
      w[c] = cnt[c] / n || 1e-6;
    }
  };
  recompute();
  const pdf = (x: number[], c: number): number => {
    const [a, b, dd] = cov[c];
    const det = a * dd - b * b || 1e-12;
    const ix = x[0] - mean[c][0];
    const iy = x[1] - mean[c][1];
    // maha = [ix iy] · inv(Sigma) · [ix iy]^T
    const maha = (dd * ix * ix - 2 * b * ix * iy + a * iy * iy) / det;
    return Math.exp(-0.5 * maha) / (2 * Math.PI * Math.sqrt(Math.abs(det)));
  };
  for (let it = 0; it < 60; it++) {
    // E-step
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < k; c++) {
        const r = w[c] * pdf(pts[i], c);
        resp[i][c] = r;
        s += r;
      }
      s = s || 1e-12;
      for (let c = 0; c < k; c++) resp[i][c] /= s;
    }
    // hard re-assign + M-step (via recompute on the hard assignment)
    let moved = false;
    for (let i = 0; i < n; i++) {
      let b = 0;
      let bv = -Infinity;
      for (let c = 0; c < k; c++)
        if (resp[i][c] > bv) {
          bv = resp[i][c];
          b = c;
        }
      if (assign[i] !== b) {
        assign[i] = b;
        moved = true;
      }
    }
    recompute();
    if (!moved && it > 1) break;
  }
  return assign;
}

// ----- DBSCAN (density) -------------------------------------------------------

function dbscan(pts: number[][], eps: number, minPts: number): number[] {
  const n = pts.length;
  const eps2 = eps * eps;
  const region = (i: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) if (i !== j && sq(pts[i], pts[j]) <= eps2) out.push(j);
    return out;
  };
  const assign = new Array<number>(n).fill(-2); // -2 = unvisited, -1 = noise
  let c = -1;
  for (let i = 0; i < n; i++) {
    if (assign[i] !== -2) continue;
    const nb = region(i);
    if (nb.length + 1 < minPts) {
      assign[i] = -1;
      continue;
    }
    c++;
    assign[i] = c;
    const queue = [...nb];
    for (let q = 0; q < queue.length; q++) {
      const j = queue[q];
      if (assign[j] === -1) assign[j] = c; // border
      if (assign[j] !== -2) continue;
      assign[j] = c;
      const nb2 = region(j);
      if (nb2.length + 1 >= minPts) for (const x of nb2) queue.push(x);
    }
  }
  for (let i = 0; i < n; i++) if (assign[i] < -1) assign[i] = -1;
  return assign;
}

/** eps heuristic: a high percentile of each point's distance to its k-th neighbour. */
function dbscanEps(pts: number[][], minPts: number): number {
  const n = pts.length;
  const kd: number[] = [];
  const step = Math.max(1, Math.floor(n / 400));
  for (let i = 0; i < n; i += step) {
    const ds: number[] = [];
    for (let j = 0; j < n; j++) if (i !== j) ds.push(sq(pts[i], pts[j]));
    ds.sort((a, b) => a - b);
    kd.push(Math.sqrt(ds[Math.min(minPts - 1, ds.length - 1)] || 0));
  }
  kd.sort((a, b) => a - b);
  return kd[Math.floor(kd.length * 0.75)] || 1; // the "knee" ~ upper quartile
}

// ----- Single-linkage via MST cut --------------------------------------------

function agglomerative(pts: number[][], k: number): number[] {
  const n = pts.length;
  // Prim's MST, O(n^2).
  const inMst = new Array(n).fill(false);
  const dist = new Array(n).fill(Infinity);
  const parent = new Array(n).fill(-1);
  dist[0] = 0;
  const edges: { a: number; b: number; w: number }[] = [];
  for (let it = 0; it < n; it++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) if (!inMst[i] && dist[i] < best) {
      best = dist[i];
      u = i;
    }
    if (u === -1) break;
    inMst[u] = true;
    if (parent[u] !== -1) edges.push({ a: u, b: parent[u], w: Math.sqrt(dist[u]) });
    for (let v = 0; v < n; v++) if (!inMst[v]) {
      const dd = sq(pts[u], pts[v]);
      if (dd < dist[v]) {
        dist[v] = dd;
        parent[v] = u;
      }
    }
  }
  // Drop the k−1 longest edges → k components (union-find over the rest).
  edges.sort((x, y) => x.w - y.w);
  const keep = edges.slice(0, Math.max(0, edges.length - (k - 1)));
  const uf = new Array(n).fill(0).map((_, i) => i);
  const find = (i: number): number => {
    while (uf[i] !== i) {
      uf[i] = uf[uf[i]];
      i = uf[i];
    }
    return i;
  };
  for (const e of keep) uf[find(e.a)] = find(e.b);
  const label = new Map<number, number>();
  const assign = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!label.has(r)) label.set(r, label.size);
    assign[i] = label.get(r)!;
  }
  return assign;
}

// ----- silhouette (for auto-k) ------------------------------------------------

function silhouette(pts: number[][], assign: number[], k: number): number {
  const n = pts.length;
  const sN = Math.min(400, n);
  const idx = Array.from({ length: sN }, (_, i) => Math.floor((i * n) / sN));
  const sums = new Float64Array(k);
  const cnts = new Int32Array(k);
  let total = 0;
  let count = 0;
  for (const i of idx) {
    if (assign[i] < 0) continue;
    sums.fill(0);
    cnts.fill(0);
    for (const j of idx) {
      if (j === i || assign[j] < 0) continue;
      const dd = Math.sqrt(sq(pts[i], pts[j]));
      sums[assign[j]] += dd;
      cnts[assign[j]]++;
    }
    const ci = assign[i];
    if (!cnts[ci]) continue;
    const a = sums[ci] / cnts[ci];
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === ci || !cnts[c]) continue;
      const mean = sums[c] / cnts[c];
      if (mean < b) b = mean;
    }
    if (!isFinite(b)) continue;
    total += (b - a) / Math.max(a, b, 1e-9);
    count++;
  }
  return count > 0 ? total / count : -1;
}

const countClusters = (assign: number[]): number => {
  let max = -1;
  for (const a of assign) if (a > max) max = a;
  return max + 1;
};

const runK = (method: BlobMethod, pts: number[][], k: number): number[] =>
  method === 'gmm' ? gmm(pts, k) : method === 'agglomerative' ? agglomerative(pts, k) : kmeans(pts, k);

/**
 * Cluster the 2-D blob points with the chosen method. For the k-based methods
 * k is taken as given, or auto-picked by silhouette over 2..6 when 'auto'.
 */
export function clusterBlobs(method: BlobMethod, pts: number[][], kOpt: number | 'auto'): BlobResult {
  const n = pts.length;
  if (n < 5) return { assign: new Array(n).fill(0), k: 1 };

  if (method === 'dbscan') {
    const minPts = 4;
    const eps = dbscanEps(pts, minPts);
    const assign = dbscan(pts, eps, minPts);
    return { assign, k: countClusters(assign) };
  }

  let k: number;
  if (kOpt === 'auto') {
    const kMax = Math.min(6, n - 1);
    let bestK = 2;
    let bestSil = -Infinity;
    for (let kk = 2; kk <= kMax; kk++) {
      const sil = silhouette(pts, runK(method, pts, kk), kk);
      if (sil > bestSil) {
        bestSil = sil;
        bestK = kk;
      }
    }
    k = bestK;
  } else {
    k = Math.min(kOpt, n);
  }
  if (k < 2) return { assign: new Array(n).fill(0), k: 1 };
  const assign = runK(method, pts, k);
  return { assign, k: countClusters(assign) };
}
