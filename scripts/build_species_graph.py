#!/usr/bin/env python3
"""Precompute the cross-species field-adjacency graph for the species menus.

The species dropdowns need to know, for a chosen set of crops, whether a single
connected cluster of fields actually spans *all* of them (the same test the
"Find neighbour clusters" step runs). Pairwise "do they ever touch" isn't
enough — e.g. Tournesol borders Maïs and Luzerne separately yet no cluster holds
all three, so it must not be offered alongside them.

That test is exact connectivity over the field graph, so we ship the graph and
let the app compute it client-side (instant, no engine load). The graph is built
off the live engine here (the engine is serial; see the sibling adjacency
script). Output: public/species-graph.json

    { distanceDeg, species:[name...], fieldSpecies:[speciesIdx per field...],
      edges:[f0,f1, f2,f3, ...] }   // flat pairs of field indices

Run once, and again if the dataset or default neighbour distance changes:

    python3 scripts/build_species_graph.py [PARQUET] [DISTANCE_DEG]

Requires the duckdb python module (pip install duckdb).
"""
import json
import os
import sys
import time

import duckdb

PARQUET = sys.argv[1] if len(sys.argv) > 1 else "/Users/charles/Documents/These/data_full_melted.parquet"
DISTANCE_DEG = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0001  # the app's default neighbour distance
CELL = 0.002  # blocking-grid cell in degrees (only affects speed, not the result)
OUT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "public", "species-graph.json"))


def main() -> None:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial; SET threads TO 8;")

    t = time.time()
    con.execute(
        f"""CREATE TABLE fields AS
        SELECT row_number() OVER () AS id, crp_lbl AS crp, ST_GeomFromText(geometry) AS geom,
          CAST(floor((ST_XMin(ST_GeomFromText(geometry)) - {DISTANCE_DEG}) / {CELL}) AS BIGINT) AS gx0,
          CAST(floor((ST_XMax(ST_GeomFromText(geometry)) + {DISTANCE_DEG}) / {CELL}) AS BIGINT) AS gx1,
          CAST(floor((ST_YMin(ST_GeomFromText(geometry)) - {DISTANCE_DEG}) / {CELL}) AS BIGINT) AS gy0,
          CAST(floor((ST_YMax(ST_GeomFromText(geometry)) + {DISTANCE_DEG}) / {CELL}) AS BIGINT) AS gy1
        FROM read_parquet('{PARQUET}')
        WHERE geometry IS NOT NULL AND crp_lbl IS NOT NULL;"""
    )
    edges = con.execute(
        f"""
        WITH c AS (
          SELECT id, crp, geom, gx, gy
          FROM fields, unnest(range(gx0, gx1 + 1)) AS g(gx), unnest(range(gy0, gy1 + 1)) AS h(gy)
        )
        SELECT DISTINCT a.id AS i, b.id AS j
        FROM c a JOIN c b
          ON a.gx = b.gx AND a.gy = b.gy AND a.id < b.id AND a.crp <> b.crp
         AND ST_DWithin(a.geom, b.geom, {DISTANCE_DEG});
        """
    ).fetchall()
    species_of = {r[0]: r[1] for r in con.execute("SELECT id, crp FROM fields").fetchall()}
    elapsed = time.time() - t

    # Keep only fields that take part in a cross-species adjacency, relabelled 0..M-1.
    species = sorted(set(species_of.values()))
    sidx = {s: k for k, s in enumerate(species)}
    relabel: dict[int, int] = {}
    field_species: list[int] = []
    flat: list[int] = []
    for i, j in edges:
        for fid in (i, j):
            if fid not in relabel:
                relabel[fid] = len(field_species)
                field_species.append(sidx[species_of[fid]])
        flat.append(relabel[i])
        flat.append(relabel[j])

    out = {
        "parquet": os.path.basename(PARQUET),
        "distanceDeg": DISTANCE_DEG,
        "species": species,
        "fieldSpecies": field_species,
        "edges": flat,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

    size_mb = os.path.getsize(OUT) / 1e6
    print(
        f"{len(species)} crops, {len(field_species)} fields, {len(edges)} edges, "
        f"d={DISTANCE_DEG} ({DISTANCE_DEG * 111000:.0f} m) in {elapsed:.1f}s"
    )
    print(f"wrote {OUT} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
