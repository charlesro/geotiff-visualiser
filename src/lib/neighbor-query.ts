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
  species1: string;
  species2: string;
  /** Max boundary-to-boundary distance, in degrees (0.0001 ≈ 11 m N–S). */
  neighborDistance: number;
  /** Keep only the N closest pairs. */
  maxPairs: number;
}

export const DEFAULT_NEIGHBOR_PARAMS: NeighborPairsParams = {
  parquetPath: '/Users/charles/Documents/These/data_full_melted.parquet',
  species1: 'Maïs ensilage',
  species2: 'Luzerne',
  neighborDistance: 0.0001,
  maxPairs: 100,
};

/** Escape a value for inclusion in a single-quoted SQL string literal. */
const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export function buildNeighborPairsQuery(p: NeighborPairsParams): string {
  const path = sqlString(p.parquetPath);
  const s1 = sqlString(p.species1);
  const s2 = sqlString(p.species2);
  const distance = Number(p.neighborDistance);
  const maxPairs = Math.max(1, Math.floor(p.maxPairs));
  if (!isFinite(distance) || distance <= 0) throw new Error('Neighbour distance must be a positive number.');

  // With a single species both directions of a pair would match; keep one.
  const samePairGuard = p.species1 === p.species2 ? 'AND a.NewID < b.NewID' : 'AND a.NewID <> b.NewID';

  return `INSTALL spatial;
LOAD spatial;
SET threads TO 8;

-- One row per field of the two species
CREATE OR REPLACE TABLE fields_unique AS
SELECT
  NewID,
  any_value(crp_lbl) AS crp_lbl,
  any_value(geometry) AS geometry_wkt,
  ST_GeomFromText(any_value(geometry)) AS geom
FROM read_parquet(${path})
WHERE geometry IS NOT NULL
  AND crp_lbl IN (${s1}, ${s2})
GROUP BY NewID;

CREATE INDEX IF NOT EXISTS fields_unique_geom_idx
ON fields_unique
USING RTREE (geom);

-- Closest pairs species_1 <-> species_2 within the distance threshold
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
    ON a.crp_lbl = ${s1}
   AND b.crp_lbl = ${s2}
   ${samePairGuard}
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
