# Refactoring: one shared core instead of parallel apps

## Why

Every feature (local GeoTIFF upload, Sentinel-2 STAC fetching, the local Python
server, pixel extraction, the PCA modal, the SQL modal) had been built as an
independent silo with its own private copy of the same logic. Concretely, before
this refactor:

- `processGeoTIFF` (local files) and `processRemoteGeoTIFF` (remote COGs) each
  contained a full copy of the rendering engine: contrast stretch, the
  RGB / single-band / index loops, colormaps and the NDVI/EVI/GNDVI/SAVI math.
- The proj4 UTM projection snippet existed **8 times** across geotiff-utils,
  pixel-extraction and zonal extraction.
- The Sentinel-2 band→asset map (`getAssetKey`) existed **4 times**, two of
  them inside App.tsx itself.
- The `<metric>_<YYYY-MM-DD>` time-series property convention was re-parsed
  with a private regex in VectorFeaturePanel, PcaModal, LocalPythonServerModal
  and twice inline in App.tsx.
- The STAC pipeline (chunked search → dedupe → group-by-date → evenly-spaced
  selection) was copy-pasted in `handleSearch` and `fetchTimeSeries`.
- Each data source hand-rolled its own layer object literal, which is why
  layers from different sources behaved subtly differently.
- `getNormalizeUrl` + the ngrok bypass headers were duplicated between App.tsx
  and LocalPythonServerModal on every fetch call.

A fix or improvement applied to one copy never reached the others.

## The shared core

```
src/lib/
  geo.ts            projections (UTM/proj4), bbox math, GeoJSON bounds, buffering
  sentinel.ts       Sentinel-2 band domain: numbers ↔ asset keys ↔ display names
  spectral.ts       NDVI/EVI/GNDVI/SAVI formulas + UI display strings
  raster-render.ts  THE rendering pipeline: contrast stretch, colormaps, canvas
  timeseries.ts     the `<metric>_<date>` property convention + helpers
  layer-factory.ts  layer construction + "Pixels" layer naming/id conventions
src/services/
  stac-service.ts   + searchSentinel2Chunked / groupItemsByDate / selectEvenlySpaced
  local-server.ts   the one client for the local Python engine
```

How the features now relate (the "subclass" relationship you wanted):

- **Both raster pipelines render through `renderRasterToCanvas`.** The local
  pipeline resolves band numbers against the file's band order; the remote one
  resolves Sentinel-2 asset names. Everything else — stretch, transparency
  rules, colormaps, index math — is shared by construction, so local files and
  STAC imagery are guaranteed to look identical for the same options.
- **All four index consumers** (two renderers, pixel extraction, the formula
  display in the sidebar) call `computeIndexValue` / `INDEX_FORMULAS`.
  Note: extraction passes `eviConstant: 10000` (raw S2 digital numbers) while
  rendering uses the historical `1` — this pre-existing discrepancy is now
  visible and documented in one place instead of hidden in two files.
- **All three data sources** (file upload, STAC fetch, Python server, plus the
  PCA output layer) build layers via `createRasterLayer` / `createVectorLayer`.
- **Both search buttons** run the same `searchSentinel2Chunked → groupItemsByDate
  → selectEvenlySpaced` pipeline; `fetchTimeSeries` only adds progress logging
  via callbacks.
- **Every consumer of the time-series convention** (feature panel chart, PCA
  modal, SQL result table, App's date-removal logic) uses `lib/timeseries.ts`.
  The "Pixels" layer id/name convention lives in `layer-factory.ts` and is used
  by App, the feature panel and the map renderer.
- **Every request to the local Python engine** goes through
  `services/local-server.ts` (URL normalisation + tunnel bypass headers).

## Behaviour notes

- UI and behaviour are intentionally unchanged; this is a pure consolidation.
- Debug-only `console.log` noise in the two render pipelines was dropped.
- One latent bug fixed: the feature-panel chart parsed dates with
  `key.split('_')[1]`, which broke for metrics containing underscores; it now
  uses the shared parser.
- `getGeoJsonBounds` is re-exported from `App.tsx` and
  `vectorLayerHasTimeSeries` from `PcaModal.tsx` for backwards compatibility.

## Verify

```bash
npm install
npm run lint   # tsc --noEmit
npm run dev
```

Suggested smoke test: upload a .tif → fetch a STAC series → click a parcel →
extract pixels → open the PCA modal → delete a date from the chart.

## Worthwhile next steps (not done here)

- Split the remaining 3,385-line App.tsx into feature hooks/components
  (`useStacSearch`, `useLayers`, sidebar sections).
- Unify the two unrelated "PCA" features (raster NDVI PCA in `pca-utils.ts`
  vs. vector time-series PCA in `PcaModal.tsx`) behind one entry point.
- Decide on a single EVI constant (1 vs 10000) after checking which matches
  your data scale.
