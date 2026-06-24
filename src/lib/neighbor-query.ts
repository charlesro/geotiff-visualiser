import { runLocalQuery } from '../services/local-server';

/**
 * The "neighbour pairs" query — the parametrised version of the analysis
 * script used in the thesis workflow.
 *
 * From a parquet of crop fields (one row per field per date, columns NewID /
 * crp_lbl / geometry WKT), it finds the closest pairs of fields of two given
 * species and returns them in long format: one row per field per pair, with
 * pair_id / role_in_pair / neighbor metadata — ready to be displayed and
 * compared in the app.
 */

export interface NeighborPairsParams {
  parquetPath: string;
  /** The crop labels to study together (2 = pairs, 3 = triplets, …). */
  species: string[];
  /** Max boundary-to-boundary distance, in degrees (0.0001 ≈ 11 m N–S). */
  neighborDistance: number;
  /** Keep only the N closest pairs. */
  maxPairs: number;
}

export const DEFAULT_NEIGHBOR_PARAMS: NeighborPairsParams = {
  parquetPath: '/Users/charles/Documents/These/data_full_melted.parquet',
  species: ['Maïs ensilage', 'Luzerne'],
  neighborDistance: 0.0001,
  maxPairs: 100,
};

/** Escape a value for inclusion in a single-quoted SQL string literal. */
const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export function buildNeighborPairsQuery(p: NeighborPairsParams): string {
  const path = sqlString(p.parquetPath);
  const species = (p.species || []).map(s => s.trim()).filter(Boolean);
  if (species.length < 2) throw new Error('Pick at least two species.');
  const speciesList = species.map(sqlString).join(', ');
  const distance = Number(p.neighborDistance);
  const maxPairs = Math.max(1, Math.floor(p.maxPairs));
  if (!isFinite(distance) || distance <= 0) throw new Error('Neighbour distance must be a positive number.');

  return `INSTALL spatial;
LOAD spatial;
SET threads TO 8;

-- One row per field of the chosen species
CREATE OR REPLACE TABLE fields_unique AS
SELECT
  NewID,
  any_value(crp_lbl) AS crp_lbl,
  any_value(geometry) AS geometry_wkt,
  ST_GeomFromText(any_value(geometry)) AS geom
FROM read_parquet(${path})
WHERE geometry IS NOT NULL
  AND crp_lbl IN (${speciesList})
GROUP BY NewID;

CREATE INDEX IF NOT EXISTS fields_unique_geom_idx
ON fields_unique
USING RTREE (geom);

-- Closest pairs of *different*-species fields among the chosen species, within
-- the distance threshold. (The component filter in JS then keeps only fields
-- whose connected cluster spans every chosen species.)
CREATE OR REPLACE TABLE neighbor_pairs AS
WITH candidate_pairs AS (
  SELECT
    a.NewID AS field_id_1,
    a.crp_lbl AS species_1,
    b.NewID AS field_id_2,
    b.crp_lbl AS species_2,
    ST_Distance(a.geom, b.geom) AS distance,
    a.geometry_wkt AS geometry_wkt_1,
    b.geometry_wkt AS geometry_wkt_2
  FROM fields_unique a
  JOIN fields_unique b
    ON a.crp_lbl <> b.crp_lbl
   AND a.NewID < b.NewID
   AND ST_DWithin(a.geom, b.geom, ${distance})
)
SELECT *
FROM candidate_pairs
ORDER BY distance
LIMIT ${maxPairs};

-- Long format: one row per field per pair
SELECT
  CAST(field_id_1 AS VARCHAR) || '_' || CAST(field_id_2 AS VARCHAR) AS pair_id,
  field_id_1 AS NewID,
  species_1 AS crp_lbl,
  'species_1' AS role_in_pair,
  field_id_2 AS neighbor_id,
  species_2 AS neighbor_crp_lbl,
  distance,
  geometry_wkt_1 AS geometry_wkt
FROM neighbor_pairs
UNION ALL
SELECT
  CAST(field_id_1 AS VARCHAR) || '_' || CAST(field_id_2 AS VARCHAR) AS pair_id,
  field_id_2 AS NewID,
  species_2 AS crp_lbl,
  'species_2' AS role_in_pair,
  field_id_1 AS neighbor_id,
  species_1 AS neighbor_crp_lbl,
  distance,
  geometry_wkt_2 AS geometry_wkt
FROM neighbor_pairs
ORDER BY pair_id, role_in_pair;`;
}

/**
 * Keep only the fields whose connected cross-species cluster spans *every*
 * chosen species. A field qualifies when it neighbours another chosen species,
 * or is linked to it through a chain of cross-species neighbours that, together,
 * touches all of them. For two species this is a no-op (every cross-species pair
 * already spans both). Operates on the long-format rows (NewID / crp_lbl /
 * neighbor_id edges) returned by the query, before they become polygons.
 */
export function filterToSpanningComponents(rows: any[], species: string[]): any[] {
  const chosen = (species || []).map(s => s.trim()).filter(Boolean);
  if (chosen.length <= 2) return rows;

  // Union-find over the field ids, linked by each row's (field ↔ neighbour) edge.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const n = parent.get(x)!;
      parent.set(x, r);
      x = n;
    }
    return r;
  };
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const speciesOf = new Map<string, string>();
  for (const row of rows) {
    const id = String(row.NewID);
    add(id);
    speciesOf.set(id, String(row.crp_lbl));
    if (row.neighbor_id != null) {
      const nb = String(row.neighbor_id);
      add(nb);
      parent.set(find(id), find(nb));
    }
  }

  // Species present in each connected component.
  const compSpecies = new Map<string, Set<string>>();
  for (const [id, sp] of speciesOf) {
    const root = find(id);
    let set = compSpecies.get(root);
    if (!set) {
      set = new Set();
      compSpecies.set(root, set);
    }
    set.add(sp);
  }
  const need = chosen;
  const keepRoot = new Set<string>();
  for (const [root, sps] of compSpecies) {
    if (need.every(s => sps.has(s))) keepRoot.add(root);
  }
  return rows.filter(row => keepRoot.has(find(String(row.NewID))));
}

/** Distinct crop labels in the parquet, for the species dropdowns. */
export async function fetchSpeciesList(baseUrl: string, parquetPath: string): Promise<string[]> {
  const data = await runLocalQuery(
    baseUrl,
    `SELECT DISTINCT crp_lbl FROM read_parquet(${sqlString(parquetPath)}) WHERE crp_lbl IS NOT NULL ORDER BY crp_lbl;`
  );
  return (data.rows || []).map((r: any) => String(r.crp_lbl));
}

/**
 * Which crops actually border which, within the given distance — the species
 * adjacency graph over the whole parquet. Lets the UI only offer species that
 * could form a spanning cluster with the ones already chosen. Symmetric map:
 * species → list of species that have at least one field touching one of theirs.
 */
export async function fetchSpeciesAdjacency(
  baseUrl: string,
  parquetPath: string,
  neighborDistance: number,
  signal?: AbortSignal
): Promise<Record<string, string[]>> {
  const d = Number(neighborDistance);
  if (!isFinite(d) || d <= 0) return {};
  const path = sqlString(parquetPath);
  const sql = `INSTALL spatial;
LOAD spatial;
SET threads TO 8;

CREATE OR REPLACE TABLE fa_adj AS
SELECT NewID, any_value(crp_lbl) AS crp_lbl, ST_GeomFromText(any_value(geometry)) AS geom
FROM read_parquet(${path})
WHERE geometry IS NOT NULL AND crp_lbl IS NOT NULL
GROUP BY NewID;

CREATE INDEX IF NOT EXISTS fa_adj_idx ON fa_adj USING RTREE (geom);

-- Distinct pairs of different crops with at least one touching field pair.
SELECT DISTINCT a.crp_lbl AS s1, b.crp_lbl AS s2
FROM fa_adj a
JOIN fa_adj b
  ON a.crp_lbl < b.crp_lbl
 AND ST_DWithin(a.geom, b.geom, ${d});`;
  const data = await runLocalQuery(baseUrl, sql, signal);
  const sets: Record<string, Set<string>> = {};
  for (const r of data.rows || []) {
    const s1 = String(r.s1);
    const s2 = String(r.s2);
    (sets[s1] ??= new Set()).add(s2);
    (sets[s2] ??= new Set()).add(s1);
  }
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(sets)) out[k] = [...sets[k]];
  return out;
}

/** Whether a set of crops is connected in the species-adjacency graph (using
 *  only edges among set members) — i.e. they can share one spanning cluster. */
export function speciesSetConnected(set: string[], adj: Record<string, string[]>): boolean {
  if (set.length <= 1) return true;
  const inSet = new Set(set);
  const seen = new Set<string>([set[0]]);
  const stack = [set[0]];
  while (stack.length) {
    const x = stack.pop()!;
    for (const y of adj[x] || []) {
      if (inSet.has(y) && !seen.has(y)) {
        seen.add(y);
        stack.push(y);
      }
    }
  }
  return seen.size === inSet.size;
}

export interface DatasetDateRange {
  start: string;
  end: string;
}

/**
 * Acquisition date span of the dataset. The melted parquet stores one column
 * per metric and date (e.g. crp_cd__2021-01-08), so the span is read from
 * the date suffixes of the column names.
 */
export async function fetchDatasetDateRange(
  baseUrl: string,
  parquetPath: string
): Promise<DatasetDateRange | null> {
  const data = await runLocalQuery(
    baseUrl,
    `SELECT min(d) AS start_date, max(d) AS end_date
FROM (
  SELECT regexp_extract(column_name, '([0-9]{4}-[0-9]{2}-[0-9]{2})$', 1) AS d
  FROM (DESCRIBE SELECT * FROM read_parquet(${sqlString(parquetPath)}))
)
WHERE d <> '';`
  );
  const row = (data.rows || [])[0];
  if (!row?.start_date || !row?.end_date) return null;
  return { start: String(row.start_date), end: String(row.end_date) };
}
