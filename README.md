# Polygon Time-Series PCA

A focused web app for one workflow: analyse how the **interior** of field polygons differs from their **edges** in Sentinel-2 time series.

1. **Polygons** — load polygons from a database (local DuckDB engine via `POST /query`, geometry as WKT) or from a GeoJSON / zipped shapefile, then select the ones to analyse (in the list or by clicking the map). The built-in **neighbour pairs** form finds the N closest pairs of fields of two chosen species (parametrised version of the thesis analysis script, with an info button on every parameter).
2. **Sentinel-2 time series** — fetch evenly-spaced, cloud-filtered scenes over the selection from the Microsoft Planetary Computer (bands B02/B03/B04/B08, windowed COG reads in the browser).
3. **Buffer zones** — split each polygon's pixels by distance to its boundary: *interior* (≥ d metres inside, default 10 m) vs *edge* (< d metres from the boundary, optionally including the outside ring). Metric: NDVI, EVI, B08 or B04.
4. **PCA** — principal component analysis on the pixel time series (pixels × dates), with a scatter plot colourable by zone/polygon/attribute, explained variance, per-date loadings, and CSV export of the scores.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

No API key is required. An optional Planetary Computer key (step 2 → advanced) raises rate limits.

## Database engine

The Database tab talks to any local server exposing `GET /api/status` and `POST /query` (`{"query": sql}` → `{"status", "columns", "rows"}`). A minimal one ships with the repo:

```bash
pip install duckdb
npm run engine        # = python3 server/engine.py, listens on :8080
```

Multi-statement SQL is supported; the rows of the last statement are returned.

## Database format

The query must return one row per polygon with a WKT geometry column, e.g.

```sql
SELECT *, ST_AsText(geometry) AS geometry_wkt
FROM read_parquet('polygons.parquet')
```

All other columns become feature attributes (usable to colour the PCA scatter).

## Code map

- `src/App.tsx` — workflow state and step wiring
- `src/components/` — `Sidebar` (stepper), `MapPanel` (map), `PcaPanel` (results), `steps/` (one component per step)
- `src/lib/polygon-source.ts` — DB/file → normalised polygon FeatureCollection
- `src/lib/fetch-series.ts` — STAC search + windowed COG download
- `src/lib/zones.ts` — interior/edge pixel split (on top of `pixel-extraction.ts`)
- `src/lib/pca.ts` — PCA on pixel time series + CSV export
