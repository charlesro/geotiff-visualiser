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
import { polyAreaHa, type Poly } from './geometry';
import { cellInFieldTest } from './field-membership';
import { fmt } from './util';
import { SOURCES } from './sensors';
import { inRange, oneOf, usePersistentState } from './persist';

/**
 * Step 2: which satellite, and therefore exactly where its pixels fall.
 *
 * This is the page's spine: everything downstream (the simulation, the PCA, the
 * shapefile, the map overlays) hangs off `build`. Three things live here that
 * look like they belong elsewhere, and don't:
 *
 *  - `sigmaX`/`sigmaY` are set HERE, in step 2, because the PSF is a property of
 *    the chosen satellite (an effect reseeds them from `SOURCES[].psf` on every
 *    source change), even though steps 3 and 4 are what consume them. They are
 *    returned as plain scalars and passed INTO the simulation hooks.
 *  - `viewBounds` is owned here even though the MAP reports it, because
 *    `renderGrid` clips to it. One owner keeps the map -> grid -> map cycle sane.
 *  - `onDownload` is here because it is a pure function of the built grid.
 *
 * The three `[sourceId]`-keyed effects must stay in THIS order (sigma reset, GSD
 * seed, catalog fetch). `pickRes` claims BOTH seed guards before it switches
 * source: without the GSD one it lost the race and every sweep-panel click
 * landed on a 1 m grid instead of the size clicked, and without the sigma one
 * the click also reseeded the blur, so the purity on the thumbnail clicked was
 * not the purity that came back.
 */
export function useFieldGrid({ aoi, fieldRing }: {
  aoi: LngLatBounds | null;
  /**
   * The field as a closed ring, however it was drawn: the traced shape, the
   * drawn box's own four corners, or an imported trial's outline (use-area).
   * Never "was a shape traced" - that is `area.aoiPoly`, and passing it here is
   * what once let a box AOI keep, in the export and the count, edge pixels that
   * the map's "In field only" was hiding.
   */
  fieldRing: Poly | null;
}) {
  const [sourceId, setSourceId] = usePersistentState('sourceId', 's2-10', v => typeof v === 'string' && SOURCES.some(s => s.id === v));
  const [gsd, setGsd] = usePersistentState('gsd', 1, inRange(0.01, 1000));
  const [customAnchor, setCustomAnchor] = usePersistentState<'utm' | 'plot'>('customAnchor', 'utm', oneOf('utm', 'plot'));
  const [viewBounds, setViewBounds] = useState<LngLatBounds | null>(null);
  const [sigmaX, setSigmaX] = usePersistentState('sigmaX', () => SOURCES.find(s => s.id === 's2-10')!.psf, inRange(0, 5));
  const [sigmaY, setSigmaY] = usePersistentState('sigmaY', () => SOURCES.find(s => s.id === 's2-10')!.psf, inRange(0, 5));
  // Where the blur actually sits, in PIXELS from the pixel centre. A real sensor's
  // PSF is not perfectly centred on its own pixel, and the offset moves the crop
  // fractions a pixel sees, so it belongs in the simulation, not just the drawing.
  const [psfOffX, setPsfOffX] = usePersistentState('psfOffX', 0, inRange(-2, 2));
  const [psfOffY, setPsfOffY] = usePersistentState('psfOffY', 0, inRange(-2, 2));

  const source = SOURCES.find(s => s.id === sourceId)!;

  // Load each satellite's realistic default PSF (σ, from its published MTF) when it's
  // picked; the user can still override sigmaX/sigmaY afterwards.
  // Only when the satellite actually CHANGES, not on first render, where sigma may
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
      // The KEY is not cleared here. This branch runs on mount too, and a saved
      // `sourceId` of 'custom' (what picking a size off the ladder leaves) then
      // wiped the covering grid restored a line above it, so coming back to
      // Sentinel-2 landed on the default tile instead of the one chosen. The
      // fetch below is the only writer, and it already drops a key that no
      // longer covers the area.
      setGrids(null); setGridState('idle'); return;
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
        // Keep the choice (restored, or made before a redraw) whenever it is still
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
    if (gridState === 'error' && source.offlinePhase0) {
      // South of the equator the false northing (10 000 000 m) is not a multiple
      // of 30 or 60, so "origin at a multiple of the pixel size" misses the real
      // lattice by 10 m at HLS 30 m and 20 m at S2 60 m: a third of a pixel,
      // exported with no hint that it is less exact than the northern case.
      // Anchoring on the false northing itself is exact in both hemispheres.
      const zone = utmZoneForLng((aoi[0] + aoi[2]) / 2);
      if ((aoi[1] + aoi[3]) / 2 >= 0) return { res: source.res };
      if (source.offlineSouth === 'false-northing')
        return { res: source.res, anchor: { epsg: utmEpsg(zone, true), ulx: 0, uly: 10_000_000 } };
      if (source.offlineSouth === 'north-crs')
        return { res: source.res, anchor: { epsg: utmEpsg(zone, false), ulx: 0, uly: 0 } };
      return { res: source.res };
    }
    return null;
  }, [aoi, sourceId, gsd, customAnchor, selectedGrid, gridState]);

  const build = useMemo(() => (aoi && buildOpts ? buildS2Grid(aoi, buildOpts) : null), [aoi, buildOpts]);
  const grid = build?.grid ?? null;

  // When the full grid is too fine to fill cells, render only the cells in the map
  // view (capped low so panning stays smooth), used by the sim / "Real field".
  const renderGrid = useMemo(() => {
    if (grid) return grid;
    if (aoi && buildOpts && build?.capped && viewBounds) return buildS2Grid(aoi, { ...buildOpts, clip: viewBounds, maxCells: 6000 }).grid;
    return null;
  }, [grid, aoi, buildOpts, build?.capped, viewBounds]);
  const clippedView = !grid && !!renderGrid;
  const geojson = useMemo(() => (renderGrid ? gridToGeoJson(renderGrid) : null), [renderGrid]);

  /**
   * Which cells of `renderGrid` belong to the field, decided ONCE.
   *
   * Membership is "the pixel's square shares area with the field ring"
   * (field-membership.ts), the one rule the map, the count, the export and the
   * PCA all ask, so they can never disagree. It used to be "centre inside",
   * which left a tilted field's corners covered by no kept pixel at all.
   *
   * Answering it costs a polygon clip per cell, and four places asked it of the
   * same cells on every change: the pixel count, the in-field overlay, the
   * simulation overlay and the PCA. `renderGrid` IS `grid` whenever the whole
   * grid fits, which is exactly when the count exists, so those three share
   * this pass; the PCA reuses it when its grid is this same object (it can be a
   * central subsample instead) and does its own pass otherwise.
   * Null when there is no grid or no field: every cell is in.
   */
  const inField = useMemo(() => {
    if (!renderGrid || !fieldRing) return null;
    const test = cellInFieldTest(fieldRing, renderGrid.epsg, renderGrid.res);
    if (!test) return null;
    const cells = renderGrid.cells;
    const mask = new Uint8Array(cells.length);
    let count = 0;
    for (let k = 0; k < cells.length; k++) if (test(cells[k])) { mask[k] = 1; count++; }
    return { grid: renderGrid, mask, count };
  }, [renderGrid, fieldRing]);

  // The plain grid is drawn as lines over the visible window (phase-correct),
  // independent of the cell cap, so even a 0.3 m grid shows instantly.
  /** The pixels that overlap the field, for "In field only". */
  const fieldGeojson = useMemo(() => {
    if (!renderGrid || !inField) return null;
    return gridToGeoJson({ ...renderGrid, cells: renderGrid.cells.filter((_, k) => inField.mask[k]) });
  }, [renderGrid, inField]);

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
  const pickRes = useCallback((r: number) => {
    // Claim BOTH [sourceId] guards before switching source. Otherwise the two
    // effects above see 'custom' as a fresh choice and reseed from that source's
    // own defaults:
    //  - the GSD from its 1 m, so clicking the 2 m panel landed on a 1 m grid,
    //    the wrong size and fine enough to trip the export cap;
    //  - the blur from its sigma 0.55, where the thumbnail just clicked was
    //    computed at the sensor's own (0.62 for Sentinel-2), so the purity you
    //    clicked was not the purity you got. A size click changes the pixel
    //    size and nothing else; switching satellite still reseeds both.
    gsdSource.current = 'custom';
    sigmaSource.current = 'custom';
    setSourceId('custom');
    setGsd(r);
  }, []);

  const onDownload = () => {
    if (!grid) return;
    const slug = source.provider.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const where = grid.tile ? `_${grid.tile}` : `_z${grid.zone}${grid.south ? 'S' : 'N'}`;
    const stem = `${slug}_pixels_${grid.res}m${where}`;
    // The exported pixels are the ones overlapping the field, as on the map:
    // the same mask the map drew, when it describes this grid.
    const keep = inField && inField.grid === grid ? inField.mask : null;
    const out = keep ? { ...grid, cells: grid.cells.filter((_, k) => keep[k]) } : grid;
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
  const psfOffXM = psfOffX * psfRes;
  const psfOffYM = psfOffY * psfRes;
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
    // Drawn where the blur actually sits, offset included, so the picture and
    // the purity numbers can never tell two different stories.
    const [lng, lat] = inv.forward([pcE + psfOffXM, pcN + psfOffYM]);
    return [lat, lng];
  }, [aoi, build?.utmBounds, build?.epsg, build?.res, psfOffXM, psfOffYM]);
  const dims = grid
    ? {
        nx: Math.round((grid.utmBounds[2] - grid.utmBounds[0]) / grid.res),
        ny: Math.round((grid.utmBounds[3] - grid.utmBounds[1]) / grid.res),
      }
    : null;
  const areaHa = build ? (build.cellCount * pxSize * pxSize) / 10_000 : 0; // pixels covering the box
  // The traced field, or else the drawn box itself. Not `areaHa`: that counts
  // every pixel touching the box, edge pixels whole: +15% on a 280 x 330 m box.
  const fieldAreaHa = fieldRing
    ? polyAreaHa(fieldRing)
    : aoi ? polyAreaHa([[aoi[0], aoi[1]], [aoi[2], aoi[1]], [aoi[2], aoi[3]], [aoi[0], aoi[3]]]) : 0;
  /** The same surface in square metres, what the panels display. Hectares stay
   *  internally for the cell-count cap, which is quoted in ha. */
  const fieldAreaM2 = fieldAreaHa * 10_000;
  const maxAreaHa = (40_000 * pxSize * pxSize) / 10_000;
  // Pixels overlapping the field (what the export contains). The mask above
  // already walked these very cells: `renderGrid` is `grid` whenever `grid`
  // exists, and this count exists only then.
  const fieldCellCount = useMemo(() => {
    if (!grid) return null;
    return inField && inField.grid === grid ? inField.count : grid.cells.length;
  }, [grid, inField]);
  /** S2/HLS use the MGRS tile word; Landsat uses a UTM zone. */
  const gridNoun = source.provider.startsWith('Landsat C2') ? 'zone' : 'tile';
  /** Whether a custom GSD nests cleanly inside Sentinel-2's 10 m grid. */
  const nestsS2 = Math.abs(10 / pxSize - Math.round(10 / pxSize)) < 1e-9;
  /** How much the pixels (and any aligned plot) are rotated from true north. */
  const convergence = aoi && build?.epsg ? gridConvergence((aoi[0] + aoi[2]) / 2, (aoi[1] + aoi[3]) / 2, build.epsg) : null;

  const gridSummary = !aoi
    ? 'needs an area'
    : grid
      // The pixels that will actually be exported (the ones overlapping the
      // field), not every pixel of the rounded-out grid: the header and the
      // export agree.
      ? `${source.provider} · ${grid.tile ?? `${grid.zone}${grid.south ? 'S' : 'N'}`} · ${fmt(fieldCellCount ?? build!.cellCount)} px`
      : build?.capped
        ? `${source.provider} · ${fmt(build.cellCount)} px (zoom to view)`
        : gridState === 'loading' ? 'identifying…' : 'pick a satellite & resolution';

  return { sourceId, setSourceId, source, gsd, setGsd, customAnchor, setCustomAnchor,
           sigmaX, setSigmaX, sigmaY, setSigmaY,
           psfOffX, setPsfOffX, psfOffY, setPsfOffY, psfOffXM, psfOffYM,
           grids, gridState, selectedGridKey, setSelectedGridKey, selectedGrid,
           buildOpts, build, grid, renderGrid, clippedView, geojson, fieldGeojson, inField, lineBox,
           viewBounds, setViewBounds, pxSize, psfSigmaM, psfFwhmM, psfCenter,
           psfSigmaXM, psfSigmaYM, psfFwhmXM, psfFwhmYM, psfAnisotropic,
           dims, areaHa, fieldAreaHa, fieldAreaM2, maxAreaHa, fieldCellCount,
           gridNoun, nestsS2, convergence, onDownload, pickRes, gridSummary };
}
