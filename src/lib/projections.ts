import { Matrix, EigenvalueDecomposition } from 'ml-matrix';
import { PCA } from 'ml-pca';

/**
 * Dimensionality-reduction methods for the pixel time-series scatter.
 *
 * All of them take the same two matrices the PCA uses: the *fit* rows (which
 * define the space, for the linear methods) and the *proj* rows (the pixels
 * actually placed/displayed), and return 2 to 3D coordinates per projected pixel,
 * so the existing scatter, boundary finder and CSV work unchanged.
 *
 * Linear methods (pca, whitened, ica, mnf, random) build a feature→component
 * projection on the fit rows and apply it to every proj row (full coverage).
 * Nonlinear methods (kpca, isomap, diffusion, tsne) embed an even subsample of
 * the proj rows directly (an n×n problem), so only those pixels get coordinates
 * and `index` says which. Every method is wrapped so a failure falls back to PCA
 * rather than breaking the panel.
 */

export type DrMethod =
  | 'pca'
  | 'whitened'
  | 'ica'
  | 'mnf'
  | 'random'
  | 'kpca'
  | 'isomap'
  | 'diffusion'
  | 'tsne';

export interface DrMethodInfo {
  id: DrMethod;
  label: string;
  nonlinear: boolean;
  spatial?: boolean;
  /** One-line description shown under the selector. */
  blurb: string;
}

export const DR_METHODS: DrMethodInfo[] = [
  { id: 'pca', label: 'PCA', nonlinear: false, blurb: 'Linear, ordered by variance. Honest distances. The default.' },
  {
    id: 'whitened',
    label: 'Whitened PCA',
    nonlinear: false,
    blurb: 'PCA with every axis scaled to unit variance, so a low-variance gradient is not squashed against PC1.',
  },
  {
    id: 'ica',
    label: 'ICA (FastICA)',
    nonlinear: false,
    blurb: 'Independent components: separates statistically independent signals instead of maximizing variance.',
  },
  {
    id: 'mnf',
    label: 'MNF (spatial)',
    nonlinear: false,
    spatial: true,
    blurb: 'Minimum Noise Fraction: orders axes by spatial signal-to-noise from neighbouring pixels. Cleaner than PCA on noisy imagery.',
  },
  {
    id: 'random',
    label: 'Random projection',
    nonlinear: false,
    blurb: 'A random linear projection, a baseline to judge the structured methods against.',
  },
  {
    id: 'kpca',
    label: 'Kernel PCA (RBF)',
    nonlinear: true,
    blurb: 'Nonlinear PCA through an RBF kernel. Can unfold curved structure. Computed on a subsample.',
  },
  {
    id: 'isomap',
    label: 'Isomap',
    nonlinear: true,
    blurb: 'Geodesic MDS on a kNN graph. Unrolls a curved manifold (the PCA arch) into a straight gradient. Subsample.',
  },
  {
    id: 'diffusion',
    label: 'Diffusion map',
    nonlinear: true,
    blurb: 'Embeds by diffusion distance on an affinity graph. Robust on smooth gradients. Subsample.',
  },
  {
    id: 'tsne',
    label: 't-SNE',
    nonlinear: true,
    blurb: 'Local-structure embedding: tidy clusters, but distances and gaps are NOT metric (don’t threshold boundaries on it). Subsample.',
  },
];

export interface EmbedInput {
  /** Fit rows: they define the space for the linear methods. */
  fit: number[][];
  /** Projected rows: the pixels displayed; these get coordinates. */
  proj: number[][];
  /** Map positions [lng, lat] of the fit rows, for the spatial methods. */
  fitPos?: [number, number][];
  components: number;
}

export interface EmbedResult {
  /** scores[j] are the coordinates of proj row index[j]. */
  scores: number[][];
  index: number[];
  /** Spread carried by each axis, in % (true explained variance for PCA). */
  explained: number[];
  /** component × feature weights, or [] when undefined for the method. */
  loadings: number[][];
}

/** Cap for the n×n nonlinear methods (eigendecomposition / shortest paths). */
const NL_CAP = 600;
const TSNE_CAP = 500;

// ----- small linear-algebra helpers -------------------------------------------

const rng = (seed = 42) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const gaussFactory = (seed = 7) => {
  const r = rng(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0,
      v = 0,
      s = 0;
    do {
      u = 2 * r() - 1;
      v = 2 * r() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
};

const evenIndices = (n: number, cap: number): number[] =>
  n <= cap ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: cap }, (_, i) => Math.floor((i * n) / cap));

const colMean = (M: number[][]): number[] => {
  const p = M[0].length,
    n = M.length,
    m = new Array(p).fill(0);
  for (const r of M) for (let j = 0; j < p; j++) m[j] += r[j];
  return m.map(v => v / n);
};
const centerBy = (M: number[][], mean: number[]): number[][] => M.map(r => r.map((v, j) => v - mean[j]));

const axisStd = (S: number[][], k: number): number[] => {
  const n = S.length,
    mean = new Array(k).fill(0);
  for (const r of S) for (let c = 0; c < k; c++) mean[c] += r[c];
  for (let c = 0; c < k; c++) mean[c] /= n;
  const v = new Array(k).fill(0);
  for (const r of S) for (let c = 0; c < k; c++) {
    const e = r[c] - mean[c];
    v[c] += e * e;
  }
  return v.map(x => Math.sqrt(x / Math.max(1, n - 1)));
};
const axisVarianceShare = (S: number[][], k: number): number[] => {
  const v = axisStd(S, k).map(s => s * s);
  const total = v.reduce((a, b) => a + b, 0) || 1;
  return v.map(x => (100 * x) / total);
};

/** p×p covariance of already-centred rows. */
const covOf = (Xc: number[][]): number[][] => {
  const n = Xc.length,
    p = Xc[0].length;
  const C = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const r of Xc) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) C[i][j] += r[i] * r[j];
  const d = Math.max(1, n - 1);
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) C[i][j] /= d;
  return C;
};

/** Top-k eigenpairs of a symmetric matrix, eigenvalues descending; vectors as columns. */
const topEigSym = (S: number[][], k: number): { vecs: number[][]; vals: number[] } => {
  const evd = new EigenvalueDecomposition(new Matrix(S), { assumeSymmetric: true });
  const vals = evd.realEigenvalues;
  const V = evd.eigenvectorMatrix;
  const n = S.length;
  const order = vals.map((_, i) => i).sort((a, b) => vals[b] - vals[a]).slice(0, k);
  const vecs = Array.from({ length: n }, () => new Array(order.length).fill(0));
  const outVals: number[] = [];
  order.forEach((ei, c) => {
    outVals.push(vals[ei]);
    for (let i = 0; i < n; i++) vecs[i][c] = V.get(i, ei);
  });
  return { vecs, vals: outVals };
};

/** Inverse square root of a symmetric PSD matrix (with a small ridge). */
const invSqrtSym = (S: number[][], ridge = 1e-8): number[][] => {
  const p = S.length;
  const R = S.map((row, i) => row.map((v, j) => v + (i === j ? ridge : 0)));
  const evd = new EigenvalueDecomposition(new Matrix(R), { assumeSymmetric: true });
  const vals = evd.realEigenvalues;
  const V = evd.eigenvectorMatrix;
  const out = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let a = 0; a < p; a++) {
    const inv = 1 / Math.sqrt(Math.max(vals[a], ridge));
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) out[i][j] += V.get(i, a) * inv * V.get(j, a);
  }
  return out;
};

const matMul = (A: number[][], B: number[][]): number[][] => {
  const n = A.length,
    m = B[0].length,
    p = B.length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let l = 0; l < p; l++) {
    const a = A[i][l];
    if (a === 0) continue;
    for (let j = 0; j < m; j++) C[i][j] += a * B[l][j];
  }
  return C;
};
/** rows · A, where A is feature×component. */
const project = (rows: number[][], A: number[][]): number[][] => matMul(rows, A);
const transpose = (A: number[][]): number[][] => A[0].map((_, j) => A.map(r => r[j]));

const sqDist = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const e = a[i] - b[i];
    s += e * e;
  }
  return s;
};

const finite2D = (S: number[][]): boolean => S.every(r => r.every(v => Number.isFinite(v)));

// ----- linear methods ---------------------------------------------------------

const pcaEmbed = (fit: number[][], proj: number[][], k: number, whiten: boolean): EmbedResult => {
  const pca = new PCA(fit, { center: true, scale: false });
  const scores = pca.predict(proj, { nComponents: k }).to2DArray();
  const explained = pca.getExplainedVariance().slice(0, k).map(v => v * 100);
  const loadings = pca.getLoadings().to2DArray().slice(0, k);
  if (whiten) {
    const std = axisStd(pca.predict(fit, { nComponents: k }).to2DArray(), k);
    for (const r of scores) for (let c = 0; c < k; c++) r[c] /= std[c] || 1;
  }
  return { scores, index: proj.map((_, i) => i), explained, loadings };
};

const randomEmbed = (fit: number[][], proj: number[][], k: number): EmbedResult => {
  const p = fit[0].length;
  const mean = colMean(fit);
  const g = gaussFactory(13);
  const A = Array.from({ length: p }, () => Array.from({ length: k }, () => g()));
  for (let c = 0; c < k; c++) {
    let s = 0;
    for (let j = 0; j < p; j++) s += A[j][c] * A[j][c];
    s = Math.sqrt(s) || 1;
    for (let j = 0; j < p; j++) A[j][c] /= s;
  }
  const scores = project(centerBy(proj, mean), A);
  return { scores, index: proj.map((_, i) => i), explained: axisVarianceShare(scores, k), loadings: transpose(A) };
};

const icaEmbed = (fit: number[][], proj: number[][], k: number): EmbedResult => {
  const mean = colMean(fit);
  const Xc = centerBy(fit, mean);
  const { vecs: E, vals } = topEigSym(covOf(Xc), k); // E: p×k columns
  const invStd = vals.map(v => 1 / Math.sqrt(Math.max(v, 1e-9)));
  // Whitening matrix Wh (k×p): row a = invStd[a] * E[:,a]^T
  const p = fit[0].length;
  const whiten = (rows: number[][]): number[][] =>
    rows.map(r => {
      const z = new Array(k).fill(0);
      for (let a = 0; a < k; a++) {
        let s = 0;
        for (let j = 0; j < p; j++) s += r[j] * E[j][a];
        z[a] = s * invStd[a];
      }
      return z;
    });
  const Z = whiten(Xc); // n×k, unit variance, decorrelated
  const n = Z.length;
  // FastICA, symmetric, g = tanh.
  const g = gaussFactory(5);
  let W = Array.from({ length: k }, () => Array.from({ length: k }, () => g()));
  W = symDecorrelate(W);
  for (let iter = 0; iter < 200; iter++) {
    const Wnew = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let c = 0; c < k; c++) {
      const w = W[c];
      const acc = new Array(k).fill(0);
      let gpMean = 0;
      for (let i = 0; i < n; i++) {
        let u = 0;
        for (let a = 0; a < k; a++) u += w[a] * Z[i][a];
        const gu = Math.tanh(u);
        const gp = 1 - gu * gu;
        for (let a = 0; a < k; a++) acc[a] += Z[i][a] * gu;
        gpMean += gp;
      }
      gpMean /= n;
      for (let a = 0; a < k; a++) Wnew[c][a] = acc[a] / n - gpMean * w[a];
    }
    const Wd = symDecorrelate(Wnew);
    // convergence: max |<wi_new, wi_old>| ~ 1
    let conv = 1;
    for (let c = 0; c < k; c++) {
      let dot = 0;
      for (let a = 0; a < k; a++) dot += Wd[c][a] * W[c][a];
      conv = Math.min(conv, Math.abs(Math.abs(dot)));
    }
    W = Wd;
    if (conv > 1 - 1e-7) break;
  }
  const project2 = (rows: number[][]) => matMul(whiten(centerBy(rows, mean)), transpose(W));
  const scores = project2(proj);
  return { scores, index: proj.map((_, i) => i), explained: axisVarianceShare(scores, k), loadings: [] };
};

/** Symmetric decorrelation W ← (W Wᵀ)^{-1/2} W. */
const symDecorrelate = (W: number[][]): number[][] => {
  const WWt = matMul(W, transpose(W));
  return matMul(invSqrtSym(WWt, 1e-12), W);
};

const mnfEmbed = (fit: number[][], proj: number[][], fitPos: [number, number][] | undefined, k: number): EmbedResult => {
  const mean = colMean(fit);
  const Xc = centerBy(fit, mean);
  const SigmaD = covOf(Xc);
  // Noise = differences between spatially adjacent fit pixels.
  const SigmaN = noiseCov(Xc, fitPos);
  const Wn = invSqrtSym(SigmaN, 1e-6); // SigmaN^{-1/2}
  const C = matMul(matMul(Wn, SigmaD), Wn); // symmetric
  const { vecs: U, vals } = topEigSym(C, k);
  const A = matMul(Wn, U); // p×k projection (MNF directions)
  const scores = project(centerBy(proj, mean), A);
  const share = vals.map(v => Math.max(0, v));
  const tot = share.reduce((a, b) => a + b, 0) || 1;
  return { scores, index: proj.map((_, i) => i), explained: share.map(v => (100 * v) / tot), loadings: transpose(A) };
};

/** Noise covariance from each pixel minus its nearest spatial neighbour. */
const noiseCov = (Xc: number[][], pos: [number, number][] | undefined): number[][] => {
  const p = Xc[0].length;
  const N = Array.from({ length: p }, () => new Array(p).fill(0));
  const n = Xc.length;
  let m = 0;
  const addDiff = (i: number, j: number) => {
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) N[a][b] += (Xc[i][a] - Xc[j][a]) * (Xc[i][b] - Xc[j][b]);
    m++;
  };
  if (pos && pos.length === n) {
    // nearest spatial neighbour via a metre-space hash
    const lat0 = pos[0][1];
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 110540;
    const xs = pos.map(q => q[0] * kx);
    const ys = pos.map(q => q[1] * ky);
    const CELL = 60;
    const key = (cx: number, cy: number) => cx * 100003 + cy;
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const kk = key(Math.floor(xs[i] / CELL), Math.floor(ys[i] / CELL));
      (buckets.get(kk) ?? buckets.set(kk, []).get(kk)!).push(i);
    }
    for (let i = 0; i < n; i++) {
      let best = -1;
      let bd = Infinity;
      const cx = Math.floor(xs[i] / CELL);
      const cy = Math.floor(ys[i] / CELL);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const b = buckets.get(key(cx + dx, cy + dy));
          if (!b) continue;
          for (const j of b) {
            if (j === i) continue;
            const d = (xs[i] - xs[j]) ** 2 + (ys[i] - ys[j]) ** 2;
            if (d < bd) {
              bd = d;
              best = j;
            }
          }
        }
      if (best >= 0) addDiff(i, best);
    }
  }
  if (m === 0) {
    // No usable positions: fall back to consecutive-row differences.
    for (let i = 1; i < n; i++) addDiff(i, i - 1);
  }
  const d = Math.max(1, 2 * m);
  for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) N[a][b] /= d;
  return N;
};

// ----- nonlinear methods (on an even subsample) -------------------------------

/** RBF bandwidth: median pairwise squared distance. */
const medianSigma2 = (X: number[][]): number => {
  const n = X.length;
  const s: number[] = [];
  const r = rng(99);
  for (let t = 0; t < Math.min(2000, n * 4); t++) {
    const i = Math.floor(r() * n);
    const j = Math.floor(r() * n);
    if (i !== j) s.push(sqDist(X[i], X[j]));
  }
  s.sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] || 1;
};

const kpcaEmbed = (X: number[][], k: number): { scores: number[][]; explained: number[] } => {
  const n = X.length;
  const s2 = medianSigma2(X);
  const K = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      const v = Math.exp(-sqDist(X[i], X[j]) / (2 * s2));
      K[i][j] = v;
      K[j][i] = v;
    }
  // double-centre
  const rowm = K.map(r => r.reduce((a, b) => a + b, 0) / n);
  const all = rowm.reduce((a, b) => a + b, 0) / n;
  const Kc = K.map((r, i) => r.map((v, j) => v - rowm[i] - rowm[j] + all));
  const { vecs, vals } = topEigSym(Kc, k);
  const scores = Array.from({ length: n }, (_, i) =>
    vecs[i].map((v, c) => v * Math.sqrt(Math.max(vals[c], 0)))
  );
  const tot = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  return { scores, explained: vals.map(v => (100 * Math.max(0, v)) / tot) };
};

const diffusionEmbed = (X: number[][], k: number): { scores: number[][]; explained: number[] } => {
  const n = X.length;
  const s2 = medianSigma2(X);
  const W = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      const v = Math.exp(-sqDist(X[i], X[j]) / (2 * s2));
      W[i][j] = v;
      W[j][i] = v;
    }
  const d = W.map(r => r.reduce((a, b) => a + b, 0));
  const dis = d.map(v => 1 / Math.sqrt(Math.max(v, 1e-12)));
  // symmetric conjugate Ms = D^-1/2 W D^-1/2
  const Ms = W.map((r, i) => r.map((v, j) => v * dis[i] * dis[j]));
  const { vecs, vals } = topEigSym(Ms, k + 1); // first is the trivial stationary one
  // diffusion coords = (D^-1/2 v_c) * lambda_c, components 2..k+1
  const scores = Array.from({ length: n }, (_, i) =>
    Array.from({ length: k }, (_, c) => dis[i] * vecs[i][c + 1] * vals[c + 1])
  );
  const used = vals.slice(1, k + 1).map(v => Math.max(0, v));
  const tot = used.reduce((a, b) => a + b, 0) || 1;
  return { scores, explained: used.map(v => (100 * v) / tot) };
};

const isomapEmbed = (X: number[][], k: number): { scores: number[][]; explained: number[]; keep: number[] } => {
  const n = X.length;
  const kn = Math.min(12, n - 1);
  // kNN adjacency
  const adj: { j: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const ds = X.map((_, j) => (j === i ? Infinity : sqDist(X[i], X[j])));
    const order = ds.map((_, j) => j).sort((a, b) => ds[a] - ds[b]).slice(0, kn);
    for (const j of order) {
      const w = Math.sqrt(ds[j]);
      adj[i].push({ j, w });
      adj[j].push({ j: i, w }); // symmetrize
    }
  }
  // Ensure the graph is connected (Isomap needs it): bridge separate components
  // by their nearest cross-pair, so every pixel keeps a geodesic, none dropped.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < n; i++) for (const { j } of adj[i]) union(i, j);
  let roots = new Set(Array.from({ length: n }, (_, i) => find(i)));
  while (roots.size > 1) {
    let bi = -1,
      bj = -1,
      bd = Infinity;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (find(i) === find(j)) continue;
        const d = sqDist(X[i], X[j]);
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    if (bi < 0) break;
    const w = Math.sqrt(bd);
    adj[bi].push({ j: bj, w });
    adj[bj].push({ j: bi, w });
    union(bi, bj);
    roots = new Set(Array.from({ length: n }, (_, i) => find(i)));
  }
  const keep = Array.from({ length: n }, (_, i) => i);
  const m = keep.length;
  // Dijkstra from each kept node → geodesic distances
  const D2 = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let a = 0; a < m; a++) {
    const src = keep[a];
    const dist = new Array(n).fill(Infinity);
    dist[src] = 0;
    const visited = new Array(n).fill(false);
    // simple O(V^2) Dijkstra (m ≤ NL_CAP)
    for (let it = 0; it < m; it++) {
      let u = -1;
      let bd = Infinity;
      for (const g of keep) if (!visited[g] && dist[g] < bd) {
        bd = dist[g];
        u = g;
      }
      if (u === -1) break;
      visited[u] = true;
      for (const { j, w } of adj[u]) if (dist[u] + w < dist[j]) dist[j] = dist[u] + w;
    }
    for (let b = 0; b < m; b++) {
      const dd = dist[keep[b]];
      D2[a][b] = isFinite(dd) ? dd * dd : 0;
    }
  }
  // classical MDS: B = -1/2 J D2 J
  const rowm = D2.map(r => r.reduce((s, v) => s + v, 0) / m);
  const all = rowm.reduce((s, v) => s + v, 0) / m;
  const B = D2.map((r, i) => r.map((v, j) => -0.5 * (v - rowm[i] - rowm[j] + all)));
  const { vecs, vals } = topEigSym(B, k);
  const scores = Array.from({ length: m }, (_, i) => vecs[i].map((v, c) => v * Math.sqrt(Math.max(vals[c], 0))));
  const tot = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  return { scores, explained: vals.map(v => (100 * Math.max(0, v)) / tot), keep };
};

const tsneEmbed = (X: number[][], k: number): { scores: number[][]; explained: number[] } => {
  const n = X.length;
  const perp = Math.max(5, Math.min(30, Math.floor(n / 4)));
  // pairwise squared distances
  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = sqDist(X[i], X[j]);
    D[i][j] = d;
    D[j][i] = d;
  }
  // P with per-point beta from a perplexity binary search
  const P = Array.from({ length: n }, () => new Array(n).fill(0));
  const logU = Math.log(perp);
  for (let i = 0; i < n; i++) {
    let beta = 1,
      lo = -Infinity,
      hi = Infinity;
    for (let it = 0; it < 50; it++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const v = Math.exp(-D[i][j] * beta);
        P[i][j] = v;
        sum += v;
      }
      sum = sum || 1e-12;
      let H = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const p = P[i][j] / sum;
        if (p > 1e-12) H += -p * Math.log(p);
      }
      const diff = H - logU;
      if (Math.abs(diff) < 1e-4) break;
      if (diff > 0) {
        lo = beta;
        beta = hi === Infinity ? beta * 2 : (beta + hi) / 2;
      } else {
        hi = beta;
        beta = lo === -Infinity ? beta / 2 : (beta + lo) / 2;
      }
    }
    let sum = 0;
    for (let j = 0; j < n; j++) sum += P[i][j];
    sum = sum || 1e-12;
    for (let j = 0; j < n; j++) P[i][j] /= sum;
  }
  // symmetrize + early exaggeration
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const v = (P[i][j] + P[j][i]) / (2 * n);
    P[i][j] = v;
    P[j][i] = v;
  }
  const g = gaussFactory(21);
  let Y = Array.from({ length: n }, () => Array.from({ length: k }, () => g() * 1e-2));
  const gains = Array.from({ length: n }, () => new Array(k).fill(1));
  const inc = Array.from({ length: n }, () => new Array(k).fill(0));
  const ITERS = 350;
  for (let iter = 0; iter < ITERS; iter++) {
    const exa = iter < 100 ? 12 : 1;
    const mom = iter < 250 ? 0.5 : 0.8;
    // Q (student-t) and normaliser
    const num = Array.from({ length: n }, () => new Array(n).fill(0));
    let qsum = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const v = 1 / (1 + sqDist(Y[i], Y[j]));
      num[i][j] = v;
      num[j][i] = v;
      qsum += 2 * v;
    }
    qsum = qsum || 1e-12;
    const grad = Array.from({ length: n }, () => new Array(k).fill(0));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const q = num[i][j] / qsum;
      const mul = (exa * P[i][j] - q) * num[i][j];
      for (let d = 0; d < k; d++) grad[i][d] += 4 * mul * (Y[i][d] - Y[j][d]);
    }
    for (let i = 0; i < n; i++) for (let d = 0; d < k; d++) {
      gains[i][d] = Math.sign(grad[i][d]) === Math.sign(inc[i][d]) ? gains[i][d] * 0.8 : gains[i][d] + 0.2;
      if (gains[i][d] < 0.01) gains[i][d] = 0.01;
      inc[i][d] = mom * inc[i][d] - 200 * gains[i][d] * grad[i][d];
      Y[i][d] += inc[i][d];
    }
    // recentre
    const mean = new Array(k).fill(0);
    for (const r of Y) for (let d = 0; d < k; d++) mean[d] += r[d];
    for (let d = 0; d < k; d++) mean[d] /= n;
    for (const r of Y) for (let d = 0; d < k; d++) r[d] -= mean[d];
  }
  // pad to k dims if k>2 (t-SNE here is 2D-ish); already k dims
  return { scores: Y, explained: axisVarianceShare(Y, k) };
};

// ----- dispatcher -------------------------------------------------------------

const runMethod = (method: DrMethod, input: EmbedInput): EmbedResult => {
  const { fit, proj, fitPos, components: k } = input;
  switch (method) {
    case 'pca':
      return pcaEmbed(fit, proj, k, false);
    case 'whitened':
      return pcaEmbed(fit, proj, k, true);
    case 'random':
      return randomEmbed(fit, proj, k);
    case 'ica':
      return icaEmbed(fit, proj, k);
    case 'mnf':
      return mnfEmbed(fit, proj, fitPos, k);
    case 'kpca':
    case 'diffusion':
    case 'isomap':
    case 'tsne': {
      const cap = method === 'tsne' ? TSNE_CAP : NL_CAP;
      const sub = evenIndices(proj.length, cap);
      const X = sub.map(i => proj[i]);
      if (X.length < k + 2) return pcaEmbed(fit, proj, k, false);
      if (method === 'kpca') {
        const { scores, explained } = kpcaEmbed(X, k);
        return { scores, index: sub, explained, loadings: [] };
      }
      if (method === 'diffusion') {
        const { scores, explained } = diffusionEmbed(X, k);
        return { scores, index: sub, explained, loadings: [] };
      }
      if (method === 'tsne') {
        const { scores, explained } = tsneEmbed(X, k);
        return { scores, index: sub, explained, loadings: [] };
      }
      const { scores, explained, keep } = isomapEmbed(X, k);
      return { scores, index: keep.map(g => sub[g]), explained, loadings: [] };
    }
    default:
      return pcaEmbed(fit, proj, k, false);
  }
};

/**
 * Embed the projected rows with the chosen method. Always returns a usable
 * result: any failure (singular matrix, non-finite output…) falls back to PCA.
 */
export function embed(method: DrMethod, input: EmbedInput): EmbedResult {
  try {
    const r = runMethod(method, input);
    if (!r.scores.length || !finite2D(r.scores)) throw new Error('non-finite embedding');
    return r;
  } catch {
    if (method === 'pca') {
      // last resort: zeros, never throw
      return {
        scores: input.proj.map(() => new Array(input.components).fill(0)),
        index: input.proj.map((_, i) => i),
        explained: new Array(input.components).fill(0),
        loadings: [],
      };
    }
    return embed('pca', input);
  }
}
