import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import {
  aoiUtmOrigin,
  buildS2Grid,
  fetchCoveringGrids,
  gridConvergence,
  gridToGeoJson,
  utmEpsg,
  utmZoneForLng,
  zoneFromEpsg,
  type BuildOptions,
  type CoveringGrid,
  type LngLatBounds,
} from './s2-grid';
import { gridToShapefileZip } from './shapefile';
import { cellCenter, pointInPoly, polyAreaHa, type Poly } from './geometry';
import { fmt } from './util';
import { SOURCES } from './sensors';
import { inRange, oneOf, usePersistentState } from './persist';

/**
 * Step 2: which satellite, and therefore exactly where its pixels fall.
 *
 * This is the page's spine — everything downstream (the simulation, the PCA, the
 * shapefile, the map overlays) hangs off `build`. Three things live here that
 * look like they belong elsewhere, and don't:
 *
 *  - `sigmaX`/`sigmaY` are set HERE, in step 2, because the PSF is a property of
 *    the chosen satellite (an effect reseeds them from `SOURCES[].psf` on every
 *    source change) — even though steps 3 and 4 are what consume them. They are
 *    returned as plain scalars and passed INTO the simulation hooks.
 *  - `viewBounds` is owned here even though the MAP reports it, because
 *    `renderGrid` clips to it. One owner keeps the map -> grid -> map cycle sane.
 *  - `onDownload` is here because it is a pure function of the built grid.
 *
 * The three `[sourceId]`-keyed effects must stay in THIS order (sigma reset, GSD
 * seed, catalog fetch); `pickRes` deliberately races the GSD-seed effect, which
 * is why the first click on a sweep panel lands on a 1 m grid. That is existing
 * behaviour, pinned here rather than fixed.
 */
export function useFieldGrid({ aoi, aoiPoly }: { aoi: LngLatBounds | null; aoiPoly: Poly | null }) {
  const [sourceId, setSourceId] = usePersistentState('sourceId', 's2-10', v => typeof v === 'string' && SOURCES.some(s => s.id === v));
  const [gsd, setGsd] = usePersistentState('gsd', 1, inRange(0.01, 1000));
  const [customAnchor, setCustomAnchor] = usePersistentState<'utm' | 'plot'>('customAnchor', 'utm', oneOf('utm', 'plot'));
  const [viewBounds, setViewBounds] = useState<LngLatBounds | null>(null);
  const [sigmaX, setSigmaX] = usePersistentState('sigmaX', () => SOURCES.find(s => s.id === 's2-10')!.psf, inRange(0, 5));
  const [sigmaY, setSigmaY] = usePersistentState('sigmaY', () => SOURCES.find(s => s.id === 's2-10')!.psf, inRange(0, 5));

  const source = SOURCES.find(s => s.id === sourceId)!;

  // Load each satellite's realistic default PSF (σ, from its published MTF) when it's
  // picked — the user can still override σx/σy afterwards.
  // Only when the satellite actually CHANGES — not on first render, where σ may
  // have just been restored from the last session and would be overwritten the
  // instant the page loaded.
  const sigmaSource = useRef(sourceId);
  useEffect(() => {
    if (sigmaSource.current === sourceId) return;
    sigmaSource.current = sourceId;
    setSigmaX(source.psf); setSigmaY(source.psf);
  }, [sourceId]);

  // Authoritative grid lookup against the product catalog, per source.
  const [grids, setGrids] = useState<CoveringGrid[] | null>(null);
  const [gridState, setGridState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [selectedGridKey, setSelectedGridKey] = usePersistentState<string | null>('gridKey', null, v => v === null || typeof v === 'string');


  // Switching to a commercial source seeds the GSD with its typical value.
  const gsdSource = useRef(sourceId);
  useEffect(() => {
    if (gsdSource.current === sourceId) return; // same guard: keep a restored GSD
    gsdSource.current = sourceId;
    if (source.kind === 'custom' && source.res > 0) setGsd(source.res);
  }, [sourceId]);

  // For catalog sources, identify the real grid(s) covering the area.
  useEffect(() => {
    if (!aoi || source.kind !== 'catalog' || !source.cfg) {
      setGrids(null); setGridState('idle'); setSelectedGridKey(null); return;
    }
    const ctrl = new AbortController();
    setGridState('loading');
    setGrids(null);
    fetchCoveringGrids(aoi, source.cfg, ctrl.signal)
      .then(found => {
        if (ctrl.signal.aborted) return;
        setGrids(found);
        setGridState(found.length ? 'ok' : 'error');
        const auto = utmZoneForLng((aoi[0] + aoi[2]) / 2);
        const pick = found.find(g => zoneFromEpsg(g.epsg) === auto) ?? found[0];
        // Keep the choice — restored, or made before a redraw — whenever it is still
        // one of the grids covering this area; only otherwise take the default.
        setSelectedGridKey(prev => (prev && found.some(g => g.label === prev) ? prev : pick?.label ?? null));
      })
      .catch(() => { if (!ctrl.signal.aborted) { setGridState('error'); setGrids(null); } });
    return () => ctrl.abort();
  }, [aoi, sourceId]);

  const selectedGrid = grids?.find(g => g.label === selectedGridKey) ?? null;

  // Build options for the active source (shared by the full build and the clipped render).
  const buildOpts = useMemo((): BuildOptions | null => {
    if (!aoi) return null;
    if (source.kind === 'custom') {
      const zone = utmZoneForLng((aoi[0] + aoi[2]) / 2);
      const south = (aoi[1] + aoi[3]) / 2 < 0;
      const epsg = utmEpsg(zone, south);
      if (customAnchor === 'plot') {
        const [ulx, uly] = aoiUtmOrigin(aoi, epsg);
        return { res: gsd, anchor: { epsg, ulx, uly } };
      }
      return { res: gsd, zone, south }; // multiples of GSD (gdalwarp -tap)
    }
    if (selectedGrid) return { res: source.res, anchor: selectedGrid };
    // Offline fallback: only exact for phase-0 grids (S2/HLS); Landsat needs the catalog.
    if (gridState === 'error' && source.offlinePhase0) return { res: source.res };
    return null;
  }, [aoi, sourceId, gsd, customAnchor, selectedGrid, gridState]);

  const build = useMemo(() => (aoi && buildOpts ? buildS2Grid(aoi, buildOpts) : null), [aoi, buildOpts]);
  const grid = build?.grid ?? null;

  // When the full grid is too fine to fill cells, render only the cells in the map
  // view (capped low so panning stays smooth) — used by the sim / "Real field".
  const renderGrid = useMemo(() => {
    if (grid) return grid;
    if (aoi && buildOpts && build?.capped && viewBounds) return buildS2Grid(aoi, { ...buildOpts, clip: viewBounds, maxCells: 6000 }).grid;
    return null;
  }, [grid, aoi, buildOpts, build?.capped, viewBounds]);
  const clippedView = !grid && !!renderGrid;
  const geojson = useMemo(() => (renderGrid ? gridToGeoJson(renderGrid) : null), [renderGrid]);

  // The plain grid is drawn as lines over the visible window (phase-correct),
  // independent of the cell cap — so even a 0.3 m grid shows instantly.
  /**
   * Only the cells whose centre falls inside the traced field — exactly the test
   * `onDownload` uses, so switching this on shows you the shapefile's contents
   * rather than a second, differently-clipped version of it.
   * Null when there is no traced polygon: a box AOI has nothing to clip away.
   */
  const fieldGeojson = useMemo(() => {
    if (!renderGrid || !aoiPoly) return null;
    const inside = renderGrid.cells.filter(c => {
      const [lng, lat] = cellCenter(c.ring);
      return pointInPoly(lng, lat, aoiPoly);
    });
    return gridToGeoJson({ ...renderGrid, cells: inside });
  }, [renderGrid, aoiPoly]);

  const lineBox = useMemo((): [number, number, number, number] | null => {
    if (!build?.utmBounds) return null;
    const [fMinE, fMinN, fMaxE, fMaxN] = build.utmBounds;
    const res = build.res;
    if (!viewBounds) return [fMinE, fMinN, fMaxE, fMaxN];
    const fwd = proj4('EPSG:4326', crsToProj4Def(`EPSG:${build.epsg}`));
    let cMinE = Infinity, cMinN = Infinity, cMaxE = -Infinity, cMaxN = -Infinity;
    const [vw, vs, ve, vn] = viewBounds;
    for (const [lng, lat] of [[vw, vs], [ve, vs], [ve, vn], [vw, vn]] as [number, number][]) {
      const [x, y] = fwd.forward([lng, lat]);
      cMinE = Math.min(cMinE, x); cMaxE = Math.max(cMaxE, x); cMinN = Math.min(cMinN, y); cMaxN = Math.max(cMaxN, y);
    }
    const nxF = Math.round((fMaxE - fMinE) / res), nyF = Math.round((fMaxN - fMinN) / res);
    const i0 = Math.max(0, Math.floor((cMinE - fMinE) / res)), i1 = Math.min(nxF, Math.ceil((cMaxE - fMinE) / res));
    const j0 = Math.max(0, Math.floor((cMinN - fMinN) / res)), j1 = Math.min(nyF, Math.ceil((cMaxN - fMinN) / res));
    if (i1 <= i0 || j1 <= j0) return null;
    return [fMinE + i0 * res, fMinN + j0 * res, fMinE + i1 * res, fMinN + j1 * res];
  }, [build?.utmBounds, build?.epsg, build?.res, viewBounds]);

  // Click a sweep panel → show the field at that pixel size (a custom grid @ res).
  // Stable identity: it is handed to the memoised PcaSweep, which would otherwise
  // redraw on every render just because a fresh function arrived.
  const pickRes = useCallback((r: number) => { setSourceId('custom'); setGsd(r); }, []);

  const onDownload = () => {
    if (!grid) return;
    const slug = source.provider.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const where = grid.tile ? `_${grid.tile}` : `_z${grid.zone}${grid.south ? 'S' : 'N'}`;
    const stem = `${slug}_pixels_${grid.res}m${where}`;
    // Clip the exported pixels to the traced field shape (centre inside the polygon).
    const out = aoiPoly
      ? { ...grid, cells: grid.cells.filter(c => { const [lng, lat] = cellCenter(c.ring); return pointInPoly(lng, lat, aoiPoly); }) }
      : grid;
    saveAs(gridToShapefileZip(out, stem), `${stem}.zip`);
  };

  // derived stats
  const pxSize = source.kind === 'custom' ? gsd : source.res;
  // PSF footprint on the ground: σ (px) → metres, and the Gaussian FWHM (2.355σ).
  // Per-axis, never averaged: the aggregate in simulate.ts blurs x and y with
  // separate sigmas, so collapsing them here would draw a footprint the model
  // never uses. `psfSigmaM` is kept only as "is there any blur at all".
  const psfRes = build?.res ?? pxSize;
  const psfSigmaXM = sigmaX * psfRes;
  const psfSigmaYM = sigmaY * psfRes;
  const psfFwhmXM = 2.3548 * psfSigmaXM;
  const psfFwhmYM = 2.3548 * psfSigmaYM;
  const psfAnisotropic = Math.abs(sigmaX - sigmaY) > 1e-9;
  const psfSigmaM = Math.max(psfSigmaXM, psfSigmaYM);
  const psfFwhmM = 2.3548 * psfSigmaM;
  // Centre the PSF blob on the CENTRE of the pixel nearest the field middle, so it
  // clearly reads as one pixel's footprint (not floating between cells).
  const psfCenter = useMemo((): [number, number] | null => {
    if (!aoi) return null;
    if (!build?.utmBounds) return [(aoi[1] + aoi[3]) / 2, (aoi[0] + aoi[2]) / 2];
    const [mnE, mnN] = build.utmBounds, r = build.res;
    const fwd = proj4('EPSG:4326', crsToProj4Def(`EPSG:${build.epsg}`));
    const inv = proj4(crsToProj4Def(`EPSG:${build.epsg}`), 'EPSG:4326');
    const [cE, cN] = fwd.forward([(aoi[0] + aoi[2]) / 2, (aoi[1] + aoi[3]) / 2]);
    const pcE = mnE + (Math.floor((cE - mnE) / r) + 0.5) * r; // pixel centre
    const pcN = mnN + (Math.floor((cN - mnN) / r) + 0.5) * r;
    const [lng, lat] = inv.forward([pcE, pcN]);
    return [lat, lng];
  }, [aoi, build?.utmBounds, build?.epsg, build?.res]);
  const dims = grid
    ? {
        nx: Math.round((grid.utmBounds[2] - grid.utmBounds[0]) / grid.res),
        ny: Math.round((grid.utmBounds[3] - grid.utmBounds[1]) / grid.res),
      }
    : null;
  const areaHa = build ? (build.cellCount * pxSize * pxSize) / 10_000 : 0; // pixels covering the box
  // The traced field, or else the drawn box itself. Not `areaHa`: that counts
  // every pixel touching the box, edge pixels whole — +15% on a 280 × 330 m box.
  const fieldAreaHa = aoiPoly
    ? polyAreaHa(aoiPoly)
    : aoi ? polyAreaHa([[aoi[0], aoi[1]], [aoi[2], aoi[1]], [aoi[2], aoi[3]], [aoi[0], aoi[3]]]) : 0;
  /** The same surface in square metres — what the panels display. Hectares stay
   *  internally for the cell-count cap, which is quoted in ha. */
  const fieldAreaM2 = fieldAreaHa * 10_000;
  const maxAreaHa = (40_000 * pxSize * pxSize) / 10_000;
  // Pixels whose centre falls inside the traced field (what the export contains).
  const fieldCellCount = useMemo(() => {
    if (!grid) return null;
    if (!aoiPoly) return grid.cells.length;
    let c = 0;
    for (const cell of grid.cells) { const [lng, lat] = cellCenter(cell.ring); if (pointInPoly(lng, lat, aoiPoly)) c++; }
    return c;
  }, [grid, aoiPoly]);
  /** S2/HLS use the MGRS tile word; Landsat uses a UTM zone. */
  const gridNoun = source.provider.startsWith('Landsat C2') ? 'zone' : 'tile';
  /** Whether a custom GSD nests cleanly inside Sentinel-2's 10 m grid. */
  const nestsS2 = Math.abs(10 / pxSize - Math.round(10 / pxSize)) < 1e-9;
  /** How much the pixels (and any aligned plot) are rotated from true north. */
  const convergence = aoi && build?.epsg ? gridConvergence((aoi[0] + aoi[2]) / 2, (aoi[1] + aoi[3]) / 2, build.epsg) : null;

  const gridSummary = !aoi
    ? 'needs an area'
    : grid
      ? `${source.provider} · ${grid.tile ?? `${grid.zone}${grid.south ? 'S' : 'N'}`} · ${fmt(build!.cellCount)} px`
      : build?.capped
        ? `${source.provider} · ${fmt(build.cellCount)} px (zoom to view)`
        : gridState === 'loading' ? 'identifying…' : 'pick a satellite & resolution';

  return { sourceId, setSourceId, source, gsd, setGsd, customAnchor, setCustomAnchor,
           sigmaX, setSigmaX, sigmaY, setSigmaY,
           grids, gridState, selectedGridKey, setSelectedGridKey, selectedGrid,
           buildOpts, build, grid, renderGrid, clippedView, geojson, fieldGeojson, lineBox,
           viewBounds, setViewBounds, pxSize, psfSigmaM, psfFwhmM, psfCenter,
           psfSigmaXM, psfSigmaYM, psfFwhmXM, psfFwhmYM, psfAnisotropic,
           dims, areaHa, fieldAreaHa, fieldAreaM2, maxAreaHa, fieldCellCount,
           gridNoun, nestsS2, convergence, onDownload, pickRes, gridSummary };
}
