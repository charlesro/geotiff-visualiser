/**
 * Exact "can these crops share one cluster?" test for the species menus.
 *
 * The neighbour-clusters step keeps only fields whose connected cross-species
 * cluster spans every chosen crop. Whether such a cluster exists is a graph
 * connectivity question, so we ship the cross-species field-adjacency graph
 * (public/species-graph.json, built by scripts/build_species_graph.py) and
 * answer it client-side — instantly, with no load on the serial engine.
 *
 * `validAdditions(base)` returns the crops that, added to `base`, still leave a
 * single cluster spanning all of them — i.e. exactly the crops a menu may offer
 * without leading to the "No cluster spans every chosen species" dead end.
 */

interface RawGraph {
  distanceDeg: number;
  species: string[];
  fieldSpecies: number[];
  edges: number[];
}

export interface SpeciesGraph {
  distanceDeg: number;
  species: string[];
  speciesIndex: Map<string, number>;
  /** species index of every field (by field id) */
  fieldSpecies: Int16Array;
  /** unordered species-pair key (sa<<16|sb, sa<sb) → flat [fieldA, fieldB, …] */
  pairEdges: Map<number, Int32Array>;
}

let cache: Promise<SpeciesGraph> | null = null;

/** Fetch and index the graph once; subsequent calls reuse the same promise. */
export function loadSpeciesGraph(): Promise<SpeciesGraph> {
  if (!cache) {
    cache = fetch('/species-graph.json')
      .then(r => {
        if (!r.ok) throw new Error(`species-graph.json: ${r.status}`);
        return r.json() as Promise<RawGraph>;
      })
      .then(buildGraph)
      .catch(err => {
        cache = null; // don't cache a failure — let the next call retry
        throw err;
      });
  }
  return cache;
}

function buildGraph(raw: RawGraph): SpeciesGraph {
  const fieldSpecies = Int16Array.from(raw.fieldSpecies);
  // Group the flat edge list by unordered species pair.
  const buckets = new Map<number, number[]>();
  const e = raw.edges;
  for (let k = 0; k < e.length; k += 2) {
    const a = e[k];
    const b = e[k + 1];
    let sa = fieldSpecies[a];
    let sb = fieldSpecies[b];
    if (sa > sb) [sa, sb] = [sb, sa];
    const key = (sa << 16) | sb;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = []));
    bucket.push(a, b);
  }
  const pairEdges = new Map<number, Int32Array>();
  for (const [key, arr] of buckets) pairEdges.set(key, Int32Array.from(arr));
  return {
    distanceDeg: raw.distanceDeg,
    species: raw.species,
    speciesIndex: new Map(raw.species.map((s, i) => [s, i])),
    fieldSpecies,
    pairEdges,
  };
}

// --- tiny map-backed union-find ------------------------------------------------
class UF<T> {
  private p = new Map<T, T>();
  find(x: T): T {
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r) as T;
    while (this.p.get(x) !== r) {
      const n = this.p.get(x) as T;
      this.p.set(x, r);
      x = n;
    }
    return r;
  }
  add(x: T): void {
    if (!this.p.has(x)) this.p.set(x, x);
  }
  union(a: T, b: T): void {
    this.add(a);
    this.add(b);
    this.p.set(this.find(a), this.find(b));
  }
  roots(): IterableIterator<T> {
    return this.p.keys();
  }
}

/** Whether one connected cluster of fields spans every crop in `names` — the
 *  exact condition the "Find neighbour clusters" step requires. Unknown crops
 *  make it return true (don't claim a selection is broken we can't judge). */
export function setSpans(graph: SpeciesGraph, names: string[]): boolean {
  const idx: number[] = [];
  for (const n of names) {
    const i = graph.speciesIndex.get(n);
    if (i === undefined) return true;
    idx.push(i);
  }
  if (idx.length <= 1) return true;
  const set = new Set(idx);
  const uf = new UF<number>();
  for (const [key, edges] of graph.pairEdges) {
    if (set.has(key >>> 16) && set.has(key & 0xffff)) {
      for (let k = 0; k < edges.length; k += 2) uf.union(edges[k], edges[k + 1]);
    }
  }
  const compSpecies = new Map<number, Set<number>>();
  for (const node of uf.roots()) {
    const r = uf.find(node);
    let s = compSpecies.get(r);
    if (!s) compSpecies.set(r, (s = new Set()));
    s.add(graph.fieldSpecies[node]);
  }
  for (const s of compSpecies.values()) if (idx.every(i => s.has(i))) return true;
  return false;
}

/**
 * Crops that can join `baseNames` while keeping one cluster that spans them all.
 * Returns null when the graph doesn't cover the base crops (caller should then
 * fall back to a looser filter). Connectivity among the base crops is computed
 * once; each candidate is then tested only against the base–candidate edges.
 */
export function validAdditions(graph: SpeciesGraph, baseNames: string[]): Set<string> | null {
  const base: number[] = [];
  for (const n of baseNames) {
    const i = graph.speciesIndex.get(n);
    if (i === undefined) return null; // unknown crop — don't prune
    base.push(i);
  }
  const baseSet = new Set(base);

  // Union the base crops' fields; stash base↔candidate edges per candidate crop.
  const uf = new UF<number>();
  const candEdges = new Map<number, number[]>(); // candidate species → [baseField, candField, …]
  for (const [key, edges] of graph.pairEdges) {
    const sa = key >>> 16;
    const sb = key & 0xffff;
    const aIn = baseSet.has(sa);
    const bIn = baseSet.has(sb);
    if (aIn && bIn) {
      for (let k = 0; k < edges.length; k += 2) uf.union(edges[k], edges[k + 1]);
    } else if (aIn !== bIn) {
      const cand = aIn ? sb : sa;
      let arr = candEdges.get(cand);
      if (!arr) candEdges.set(cand, (arr = []));
      for (let k = 0; k < edges.length; k += 2) {
        const u = edges[k];
        const v = edges[k + 1];
        if (baseSet.has(graph.fieldSpecies[u])) {
          uf.add(u);
          arr.push(u, v);
        } else {
          uf.add(v);
          arr.push(v, u);
        }
      }
    }
  }

  // Species present in each base component.
  const compSpecies = new Map<number, Set<number>>();
  for (const node of uf.roots()) {
    const r = uf.find(node);
    let s = compSpecies.get(r);
    if (!s) compSpecies.set(r, (s = new Set()));
    s.add(graph.fieldSpecies[node]);
  }

  const valid = new Set<string>();
  for (const [cand, arr] of candEdges) {
    // Contract each touched base component to one node, add the candidate's
    // fields, and union along the base↔candidate edges. The candidate is valid
    // if some resulting blob carries every base crop plus the candidate.
    const luf = new UF<string>();
    for (let k = 0; k < arr.length; k += 2) {
      luf.union('r' + uf.find(arr[k]), 'c' + arr[k + 1]);
    }
    const blobSpecies = new Map<string, Set<number>>();
    for (const node of luf.roots()) {
      const lr = luf.find(node);
      let s = blobSpecies.get(lr);
      if (!s) blobSpecies.set(lr, (s = new Set()));
      if (node[0] === 'r') for (const sp of compSpecies.get(Number(node.slice(1)))!) s.add(sp);
      else s.add(cand);
    }
    for (const s of blobSpecies.values()) {
      if (s.has(cand) && base.every(b => s.has(b))) {
        valid.add(graph.species[cand]);
        break;
      }
    }
  }
  return valid;
}
