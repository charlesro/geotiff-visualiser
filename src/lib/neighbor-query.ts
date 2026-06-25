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

  // With 3+ species a spanning cluster almost never sits among the globally
  // closest pairs — the abundant, very-close pairs of the two commonest crops
  // crowd them out, so a small maxPairs returns zero spanning clusters even
  // though they exist. Cross-species pairs among the chosen crops are few, so
  // for 3+ species we take them all and let the JS component filter find the
  // clusters. maxPairs only caps the 2-species "closest pairs" view.
  const pairLimit = species.length >= 3 ? 2_000_000 : maxPairs;

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
LIMIT ${pairLimit};

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
 * Every field of *any* crop that lies within `distance` of one of `targetIds`
 * (the fields already loaded from the neighbour-clusters step). Used to grow a
 * selection outward by one ring of neighbours, regardless of species. Returns
 * the targets themselves too (a field is within 0 of itself). One row per field
 * with a WKT geometry column, so it parses like any other polygon result.
 */
export function buildNeighborFieldsQuery(
  parquetPath: string,
  targetIds: (string | number)[],
  distance: number
): string {
  const path = sqlString(parquetPath);
  const ids = Array.from(new Set(targetIds.map(id => String(id).trim()).filter(id => /^-?\d+$/.test(id))));
  if (ids.length === 0) throw new Error('No fields to grow from — run the neighbour step first.');
  const d = Number(distance);
  if (!isFinite(d) || d <= 0) throw new Error('Neighbour distance must be a positive number.');

  return `INSTALL spatial;
LOAD spatial;
SET threads TO 8;

-- One row per field, every crop, with a spatial index for the radius join.
CREATE OR REPLACE TABLE fields_all AS
SELECT
  NewID,
  any_value(crp_lbl) AS crp_lbl,
  any_value(geometry) AS geometry_wkt,
  ST_GeomFromText(any_value(geometry)) AS geom
FROM read_parquet(${path})
WHERE geometry IS NOT NULL
GROUP BY NewID;

CREATE INDEX IF NOT EXISTS fields_all_geom_idx ON fields_all USING RTREE (geom);

CREATE OR REPLACE TABLE grow_targets AS
SELECT geom FROM fields_all WHERE NewID IN (${ids.join(', ')});

-- Any field within the distance of any target field.
SELECT DISTINCT a.NewID, a.crp_lbl, a.geometry_wkt
FROM fields_all a
JOIN grow_targets t ON ST_DWithin(a.geom, t.geom, ${d});`;
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
