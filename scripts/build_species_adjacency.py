#!/usr/bin/env python3
"""Precompute the crop-adjacency graph that prunes the species dropdowns.

Two crops are linked when at least one field of each lies within the neighbour
distance of the other — i.e. they can appear together in a spanning cluster.
The app reads the result (src/data/species-adjacency.json) and only offers, in
each species menu, crops that keep the chosen set a single connected cluster.

Why a script and not a live query: the exact test is a cross-field spatial
join over all ~281k fields. The naive self-join is O(n2) and never returns, and
the local engine runs queries serially, so doing it on connect freezes the app.
Here we block the join by a coarse grid (each field is bucketed into every cell
its distance-expanded bbox covers, then only same-cell pairs are distance-tested)
which is exact and runs in a few seconds. Run it once, off the live engine,
whenever the dataset or the neighbour distance changes:

    python3 scripts/build_species_adjacency.py [PARQUET] [DISTANCE_DEG]

Requires the duckdb python module (pip install duckdb).
"""
import datetime
import json
import os
import sys
import time

import duckdb

PARQUET = sys.argv[1] if len(sys.argv) > 1 else "/Users/charles/Documents/These/data_full_melted.parquet"
DISTANCE_DEG = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0002  # ~22 m; slightly generous vs the 11 m default
CELL = 0.002  # blocking-grid cell in degrees (only affects speed, not the result)
OUT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "src", "data", "species-adjacency.json"))


def main() -> None:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial; SET threads TO 8;")

    t = time.time()
    con.execute(
        f"""CREATE TABLE fields AS
        SELECT crp_lbl AS crp, ST_GeomFromText(geometry) AS geom
        FROM read_parquet('{PARQUET}')
        WHERE geometry IS NOT NULL AND crp_lbl IS NOT NULL;"""
    )
    species = [r[0] for r in con.execute("SELECT DISTINCT crp FROM fields ORDER BY crp").fetchall()]

    # Bucket each field into every grid cell its distance-expanded bbox covers,
    # so two fields within the distance always share at least one cell.
    con.execute(
        f"""CREATE TABLE fb AS SELECT crp, geom,
        CAST(floor((ST_XMin(geom) - {DISTANCE_DEG}) / {CELL}) AS BIGINT) AS gx0,
        CAST(floor((ST_XMax(geom) + {DISTANCE_DEG}) / {CELL}) AS BIGINT) AS gx1,
        CAST(floor((ST_YMin(geom) - {DISTANCE_DEG}) / {CELL}) AS BIGINT) AS gy0,
        CAST(floor((ST_YMax(geom) + {DISTANCE_DEG}) / {CELL}) AS BIGINT) AS gy1
        FROM fields;"""
    )
    pairs = con.execute(
        f"""
        WITH cells AS (
          SELECT crp, geom, gx, gy
          FROM fb,
               unnest(range(gx0, gx1 + 1)) AS g(gx),
               unnest(range(gy0, gy1 + 1)) AS h(gy)
        )
        SELECT DISTINCT a.crp AS s1, b.crp AS s2
        FROM cells a
        JOIN cells b
          ON a.gx = b.gx AND a.gy = b.gy
         AND a.crp < b.crp
         AND ST_DWithin(a.geom, b.geom, {DISTANCE_DEG});
        """
    ).fetchall()
    elapsed = time.time() - t

    adjacency = {c: set() for c in species}
    for s1, s2 in pairs:
        adjacency[s1].add(s2)
        adjacency[s2].add(s1)

    out = {
        "parquet": os.path.basename(PARQUET),
        "distanceDeg": DISTANCE_DEG,
        "generated": datetime.date.today().isoformat(),
        "species": species,
        "adjacency": {k: sorted(v) for k, v in sorted(adjacency.items())},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=0)
        fh.write("\n")

    print(f"{len(species)} crops, {len(pairs)} adjacent pairs, d={DISTANCE_DEG} ({DISTANCE_DEG * 111000:.0f} m) in {elapsed:.1f}s")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
