import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';

/**
 * Sentinel-2 pixel-grid reconstruction.
 *
 * Sentinel-2 products are tiled in the MGRS grid and projected in UTM. Within a
 * given UTM zone the pixel grid is fully deterministic, no imagery needed:
 *
 *   - 10 m bands (B02/B03/B04/B08)  → pixel edges on UTM multiples of 10 m
 *   - 20 m bands (B05/B06/B07/B8A/B11/B12) → multiples of 20 m
 *   - 60 m bands (B01/B09/B10)      → multiples of 60 m
 *
 * and the three grids nest exactly (one 20 m pixel = 2×2 ten-metre pixels,
 * one 60 m = 6×6). So to recover the exact footprints anywhere we pick the UTM
 * zone, project the area, snap to a multiple of the resolution, emit the cell
 * squares, and unproject the corners back to WGS84 for display.
 *
 * Caveat the UI exposes: near a zone seam (every 6° of longitude) the same
 * ground can be covered by tiles from two different zones with two different
 * grids, so the chosen zone must match the tile the data will actually come
 * from. `utmZoneForLng` gives the standard zone; the user can override it.
 */

export type LngLat = [number, number];

/** [west, south, east, north] in WGS84 degrees. */
export type LngLatBounds = [number, number, number, number];

export const S2_RESOLUTIONS = [10, 20, 60] as const;
export type S2Resolution = (typeof S2_RESOLUTIONS)[number];

export interface S2Cell {
  /** Pixel column index within the zone (easting / res). */
  col: number;
  /** Pixel row index within the zone (northing / res). */
  row: number;
  /** UTM easting / northing of the cell's lower-left corner (metres). */
  east: number;
  north: number;
  /** WGS84 ring [lng,lat], closed, lower-left origin, for Leaflet display. */
  ring: LngLat[];
}

export interface S2Grid {
  cells: S2Cell[];
  zone: number;
  /** EPSG of the UTM CRS: 326xx (north) / 327xx (south). */
  epsg: number;
  south: boolean;
  res: number;
  /** Snapped UTM bounds actually covered: [minE, minN, maxE, maxN]. */
  utmBounds: [number, number, number, number];
  /** MGRS tile id (e.g. "31UFS") when anchored to a real product, else undefined. */
  tile?: string;
  /** True when the origin came from a real product transform (not the rule). */
  anchored: boolean;
  /**
   * Every `stride`-th pixel of the lattice was kept, in both axes; 1 (or absent)
   * means the grid is every pixel of its extent. The cells still carry their
   * true col/row, so a strided grid names the same ground as the whole one; what
   * it does not do is tile it.
   */
  stride?: number;
}

export interface BuildResult {
  grid: S2Grid | null;
  /** Number of cells the area would produce (reported even when over the cap). */
  cellCount: number;
  /** True when cellCount exceeded `maxCells` and no grid was built. */
  capped: boolean;
  /** Snapped UTM extent [minE,minN,maxE,maxN], set even when capped (for recipes). */
  utmBounds: [number, number, number, number] | null;
  epsg: number;
  res: number;
}

/** Standard UTM zone (1–60) for a longitude. */
export const utmZoneForLng = (lng: number): number => {
  const wrapped = ((lng + 180) % 360 + 360) % 360;
  return Math.min(60, Math.max(1, Math.floor(wrapped / 6) + 1));
};

/** EPSG code of the WGS84 / UTM CRS for a zone + hemisphere. */
export const utmEpsg = (zone: number, south: boolean): number => (south ? 32700 : 32600) + zone;

/** Central meridian (°E) of a UTM zone. */
export const centralMeridian = (zone: number): number => zone * 6 - 183;

/** UTM zone number from a 326xx/327xx EPSG code. */
export const zoneFromEpsg = (epsg: number): number => epsg - (epsg >= 32700 ? 32700 : 32600);

/**
 * Grid convergence at a point (degrees): the angle from true north to UTM grid
 * north. Positive = grid north is EAST of true north (pixels appear rotated
 * clockwise on a north-up map). This is exactly how much the S2 pixels, and
 * any plot aligned to them, are rotated from compass/true north.
 */
export function gridConvergence(lng: number, lat: number, epsg: number): number {
  const def = crsToProj4Def(`EPSG:${epsg}`);
  const fwd = proj4('EPSG:4326', def);
  const inv = proj4(def, 'EPSG:4326');
  const [e, n] = fwd.forward([lng, lat]);
  const a = inv.forward([e, n]);          // round-tripped point
  const b = inv.forward([e, n + 100]);    // 100 m along grid north
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(toRad(b[1]));
  const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * Exact anchor taken from a real Sentinel-2 product: its CRS and the UTM
 * coordinates of a pixel corner (the product's grid origin). Snapping the area
 * onto this lattice reproduces the product's pixels to the metre, and pins the
 * right tile/zone where two overlap at a seam.
 */
export interface TileAnchor {
  epsg: number;
  /** UTM easting/northing of the product's pixel-grid origin (≡ 0 mod res). */
  ulx: number;
  uly: number;
  /** MGRS tile id, for display/export. */
  tile?: string;
}

export interface BuildOptions {
  res?: number;
  /** Override the auto-selected zone (e.g. near a seam). Ignored if `anchor` set. */
  zone?: number;
  /** Override the hemisphere; defaults from the area centre latitude. */
  south?: boolean;
  /** Anchor to a real product grid instead of the deterministic rule. */
  anchor?: TileAnchor;
  /** Hard cap on cell count; above it no grid is built. Default 40 000. */
  maxCells?: number;
  /**
   * Restrict the generated cells to this WGS84 window (e.g. the map viewport).
   * The grid keeps the same origin/phase (only fewer cells are produced), so a
   * too-fine grid can still be drawn where you're looking.
   */
  clip?: LngLatBounds;
  /**
   * Keep only every `stride`-th pixel along each axis, spreading a small number
   * of cells over the WHOLE extent instead of clipping to part of it.
   *
   * `clip` and this answer different questions. Clipping asks "what is here",
   * which is right for a viewport; striding asks "what is this field like",
   * which is what a sample is for. The cap is checked against the STRIDED count,
   * so a field too fine to build whole can still be sampled end to end.
   */
  stride?: number;
}

const DEFAULT_MAX_CELLS = 40_000;

/**
 * Build the Sentinel-2 pixel grid covering a WGS84 area.
 * Returns `{ grid: null, capped: true }` when the area is too large.
 */
export function buildS2Grid(bounds: LngLatBounds, opts: BuildOptions = {}): BuildResult {
  const res = opts.res ?? 10;
  const maxCells = opts.maxCells ?? DEFAULT_MAX_CELLS;
  const anchor = opts.anchor;
  const [w, s, e, n] = bounds;
  const cLng = (w + e) / 2;
  const cLat = (s + n) / 2;
  const epsg = anchor ? anchor.epsg : utmEpsg(opts.zone ?? utmZoneForLng(cLng), opts.south ?? cLat < 0);
  const south = epsg >= 32700;
  const zone = zoneFromEpsg(epsg);
  const def = crsToProj4Def(`EPSG:${epsg}`);
  const toUtm = proj4('EPSG:4326', def);
  const toWgs = proj4(def, 'EPSG:4326');

  // Project the four corners and take the envelope: the graticule is rotated
  // relative to UTM, so the envelope safely covers the whole area.
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [lng, lat] of [[w, s], [e, s], [e, n], [w, n]] as LngLat[]) {
    const [x, y] = toUtm.forward([lng, lat]);
    if (x < minE) minE = x;
    if (x > maxE) maxE = x;
    if (y < minN) minN = y;
    if (y > maxN) maxN = y;
  }

  // Snap outward onto the pixel grid. With an anchor we step from the product's
  // own origin; without one we step from 0 (≡ the product grid, since every S2
  // tile origin in a zone is a multiple of 10/20/60 m). Phase `o` is the origin
  // offset modulo the resolution, 0 for both paths in practice.
  //
  // The origin is checked, not trusted: it is read from a third party's JSON
  // (projTransform), and `%` answers something for every value it is handed.
  // `undefined` gave NaN, which clears every later guard and threw "Invalid
  // array length" out of a hook with no boundary above it; `null` gave 0, a
  // grid quietly built on the DEFAULT lattice while claiming to be anchored on
  // the product's. Neither is an anchor, so neither anchors.
  const usable = anchor && Number.isFinite(anchor.ulx) && Number.isFinite(anchor.uly);
  const oE = usable ? ((anchor!.ulx % res) + res) % res : 0;
  const oN = usable ? ((anchor!.uly % res) + res) % res : 0;
  let snapMinE = Math.floor((minE - oE) / res) * res + oE;
  let snapMinN = Math.floor((minN - oN) / res) * res + oN;
  let snapMaxE = Math.ceil((maxE - oE) / res) * res + oE;
  let snapMaxN = Math.ceil((maxN - oN) / res) * res + oN;

  // Optional viewport clip: intersect the snapped extent with the clip window
  // (same origin/phase), so a too-fine grid still renders where you're looking.
  if (opts.clip) {
    let cMinE = Infinity, cMinN = Infinity, cMaxE = -Infinity, cMaxN = -Infinity;
    const [cw, cs, ce, cn] = opts.clip;
    for (const [lng, lat] of [[cw, cs], [ce, cs], [ce, cn], [cw, cn]] as LngLat[]) {
      const [x, y] = toUtm.forward([lng, lat]);
      if (x < cMinE) cMinE = x; if (x > cMaxE) cMaxE = x;
      if (y < cMinN) cMinN = y; if (y > cMaxN) cMaxN = y;
    }
    snapMinE = Math.max(snapMinE, Math.floor((cMinE - oE) / res) * res + oE);
    snapMinN = Math.max(snapMinN, Math.floor((cMinN - oN) / res) * res + oN);
    snapMaxE = Math.min(snapMaxE, Math.ceil((cMaxE - oE) / res) * res + oE);
    snapMaxN = Math.min(snapMaxN, Math.ceil((cMaxN - oN) / res) * res + oN);
  }

  const nx = Math.round((snapMaxE - snapMinE) / res);
  const ny = Math.round((snapMaxN - snapMinN) / res);
  // Each axis is judged on its own, never on the product. A clip window that
  // misses the field on BOTH axes makes nx and ny negative, and two negatives
  // multiply back into a perfectly ordinary looking count: under the cap it
  // built that many EMPTY slots, which reached the map as cells with no ring.
  //
  // Stated as "not a usable count" rather than "<= 0", because NaN is the other
  // way here. Every comparison with NaN is false, so a NaN axis satisfies no
  // guard written as a comparison and arrived at `new Array(NaN)`. An anchor
  // read from catalogue JSON is the way one gets in (see projTransform).
  const empty = !(nx >= 1) || !(ny >= 1);
  // Cells actually produced, which is what the cap is about and what the caller
  // gets back: a strided grid covers the same ground with fewer of them.
  const stride = Math.max(1, Math.floor(opts.stride ?? 1));
  const sx = Math.ceil(nx / stride), sy = Math.ceil(ny / stride);
  const cellCount = empty ? 0 : sx * sy;

  const utmBounds: [number, number, number, number] = [snapMinE, snapMinN, snapMaxE, snapMaxN];
  if (empty || cellCount > maxCells) {
    return { grid: null, cellCount, capped: !empty && cellCount > maxCells, utmBounds, epsg, res };
  }

  // Precompute the (nx+1)×(ny+1) corner lattice once, then assemble cells by
  // sharing corners: a quarter of the projection work of doing it per cell.
  //
  // Only worth it when the cells TOUCH. A strided grid shares no corners, and
  // the lattice would project every pixel of the extent to keep one in `stride`
  // squared of them: 139,104 cells' worth of projection for a 2,500 cell sample,
  // which is the whole cost the sample exists to avoid. Those project their own
  // four corners instead.
  const shareCorners = stride === 1;
  const lng2d: number[][] = [];
  const lat2d: number[][] = [];
  for (let j = 0; shareCorners && j <= ny; j++) {
    const y = snapMinN + j * res;
    const lngRow: number[] = new Array(nx + 1);
    const latRow: number[] = new Array(nx + 1);
    for (let i = 0; i <= nx; i++) {
      const x = snapMinE + i * res;
      const [lng, lat] = toWgs.forward([x, y]);
      lngRow[i] = lng;
      latRow[i] = lat;
    }
    lng2d.push(lngRow);
    lat2d.push(latRow);
  }

  const cells: S2Cell[] = new Array(cellCount);
  let k = 0;
  for (let j = 0; j < ny; j += stride) {
    const north = snapMinN + j * res;
    for (let i = 0; i < nx; i += stride) {
      const east = snapMinE + i * res;
      // Ring lower-left → lower-right → upper-right → upper-left → close.
      const corner = (ci: number, cj: number): LngLat => (shareCorners
        ? [lng2d[cj][ci], lat2d[cj][ci]]
        : toWgs.forward([snapMinE + ci * res, snapMinN + cj * res]) as LngLat);
      const ll = corner(i, j), lr = corner(i + 1, j), ur = corner(i + 1, j + 1), ul = corner(i, j + 1);
      const ring: LngLat[] = [ll, lr, ur, ul, ll];
      cells[k++] = {
        col: Math.round(east / res),
        row: Math.round(north / res),
        east,
        north,
        ring,
      };
    }
  }

  return {
    grid: {
      cells, zone, epsg, south, res,
      utmBounds,
      // An anchor with no usable origin is not an anchor: the lattice below is
      // the deterministic one, so neither the tile id nor the claim of being
      // anchored to a product would be true of it.
      tile: usable ? anchor!.tile : undefined,
      anchored: !!usable,
      stride,
    },
    cellCount,
    capped: false,
    utmBounds,
    epsg,
    res,
  };
}

/** Lower-left UTM corner (min easting/northing) of a WGS84 area in a CRS. */
export function aoiUtmOrigin(bounds: LngLatBounds, epsg: number): [number, number] {
  const to = proj4('EPSG:4326', crsToProj4Def(`EPSG:${epsg}`));
  const [w, s, e, n] = bounds;
  let minE = Infinity, minN = Infinity;
  for (const [lng, lat] of [[w, s], [e, s], [e, n], [w, n]] as LngLat[]) {
    const [x, y] = to.forward([lng, lat]);
    if (x < minE) minE = x;
    if (y < minN) minN = y;
  }
  return [minE, minN];
}

/** GeoJSON FeatureCollection of the grid cells (WGS84), for the map overlay. */
export function gridToGeoJson(grid: S2Grid): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: grid.cells.map(c => ({
      type: 'Feature' as const,
      properties: { col: c.col, row: c.row },
      geometry: { type: 'Polygon' as const, coordinates: [c.ring] },
    })),
  };
}

// ----- authoritative grid lookup ----------------------------------------------

/** A distinct real product grid covering the area, with its exact origin. */
export interface CoveringGrid extends TileAnchor {
  /** Short human label, e.g. "31UFS" (S2/HLS tile) or "31N" (Landsat zone). */
  label: string;
  /** Which catalog this grid was read from, for the page to name. */
  catalog?: string;
}

/**
 * Describes how to read a fixed-grid product's pixel grid from STAC items.
 * `asset` names the asset whose `proj:transform` carries the grid; `null` reads
 * the item-level `proj:transform`. `gridLabel` turns an item into a short id.
 */
export interface SourceConfig {
  collection: string;
  asset: string | null;
  res: number;
  gridLabel: (item: any) => string;
  /** Which STAC API to ask. Defaults to the Planetary Computer. */
  url?: string;
  /** The same grid in a second catalog, asked only when the first one fails. */
  alt?: SourceConfig;
}

const MPC_STAC_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
export const EARTH_SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search';
/** Shown on the page so the grid's provenance is never guesswork. */
const CATALOG_NAMES: Record<string, string> = {
  [MPC_STAC_URL]: 'Planetary Computer',
  [EARTH_SEARCH_URL]: 'Earth Search',
};

/**
 * The item's affine transform, ONLY when it really holds an origin.
 *
 * This is parsed from a third party's JSON, and a transform that is short, or
 * carries a null where a number belongs, made `t[2]` and `t[5]` undefined. That
 * travelled the whole way: `phase()` turned it into NaN, NaN passed every
 * `> maxCells` and `<= 0` guard in buildS2Grid (every comparison with NaN is
 * false), and the grid builder reached `new Array(NaN)` and threw
 * "Invalid array length". buildS2Grid runs in useFieldGrid's own body, outside
 * every error boundary, and the chosen source and grid are both persisted, so
 * that unmounted the page AND came back on the reload.
 */
const projTransform = (it: any, asset: string | null): number[] | undefined => {
  const t = (asset ? it.assets?.[asset]?.['proj:transform'] : null) ?? it.properties?.['proj:transform'];
  if (!Array.isArray(t) || t.length < 6) return undefined;
  return Number.isFinite(t[2]) && Number.isFinite(t[5]) ? t : undefined;
};
const projEpsg = (it: any, asset: string | null): number | undefined =>
  (asset ? it.assets?.[asset]?.['proj:epsg'] : undefined) ?? it.properties?.['proj:epsg'];

const phase = (v: number, res: number): number => ((v % res) + res) % res;

/**
 * Find the real product grid(s) covering an area and read each one's exact
 * pixel origin from the metadata (`proj:transform`). Grids are deduped by their
 * *lattice phase* (origin mod resolution), not the raw origin: Landsat scenes
 * are cropped to varying extents but all share one fixed lattice, so phase
 * collapses them to a single grid. Usually one grid; at a UTM-zone seam two,
 * which the caller lets the user choose between. Metadata only, no imagery.
 */
export async function fetchCoveringGrids(
  bounds: LngLatBounds,
  cfg: SourceConfig,
  signal?: AbortSignal,
  timeoutMs = STAC_TIMEOUT_MS,
): Promise<CoveringGrid[]> {
  try {
    const found = await searchLattices(bounds, cfg, signal, timeoutMs);
    if (found.length || !cfg.alt) return found;
  } catch (err) {
    // A dead catalog must not take the page down when a second one has the
    // same grid: Microsoft's API has gone down for days at a time. An aborted
    // request is the caller redrawing, so it is passed straight on.
    if (!cfg.alt || signal?.aborted) throw err;
  }
  // Each catalog gets its own deadline: a shared one would already be spent by
  // the time the first catalog's stall handed over to the second.
  return searchLattices(bounds, cfg.alt, signal, timeoutMs);
}

/**
 * How long one catalog has to answer. A hung socket is not an error: `fetch`
 * simply never settles, so without a deadline step 2 sat on "Identifying" for
 * as long as the browser's own timeout (minutes), with no grid, no fallback and
 * no way to tell a slow network from a dead one. Long enough that a slow answer
 * still arrives, short enough that a dead one is not the whole visit.
 */
export const STAC_TIMEOUT_MS = 8000;

/**
 * `signal`, with a deadline of its own. Hand-rolled rather than
 * AbortSignal.any + AbortSignal.timeout: those are recent, and the page ships
 * to whatever browser the reader has. Returns the signal to pass to fetch and
 * the teardown, which MUST run once the body is read, or a pending timer keeps
 * every answered request alive to its deadline.
 */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  // Already aborted: the listener would never fire, so copy the reason across now.
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    const err = new Error(`STAC search timed out after ${timeoutMs} ms`);
    err.name = 'TimeoutError';
    ctrl.abort(err);
  }, timeoutMs);
  return {
    signal: ctrl.signal,
    done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

async function searchLattices(
  bounds: LngLatBounds,
  cfg: SourceConfig,
  signal?: AbortSignal,
  timeoutMs = STAC_TIMEOUT_MS,
): Promise<CoveringGrid[]> {
  const cLng = (bounds[0] + bounds[2]) / 2;
  const cLat = (bounds[1] + bounds[3]) / 2;
  const body = {
    collections: [cfg.collection],
    intersects: { type: 'Point', coordinates: [cLng, cLat] },
    limit: 100,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  };
  const url = cfg.url ?? MPC_STAC_URL;
  // The deadline covers reading the body as well as opening the connection: a
  // socket that accepts the request and then stops sending stalls on .json().
  const deadline = withDeadline(signal, timeoutMs);
  let data: any;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });
    if (!r.ok) throw new Error(`STAC search failed (${r.status})`);
    data = await r.json();
  } finally {
    deadline.done();
  }

  const byLattice = new Map<string, CoveringGrid>();
  for (const it of data.features ?? []) {
    const t = projTransform(it, cfg.asset);
    const epsg = projEpsg(it, cfg.asset);
    if (!t || !epsg) continue;
    const ulx = t[2];
    const uly = t[5];
    const key = `${epsg}|${phase(ulx, cfg.res)}|${phase(uly, cfg.res)}`;
    if (!byLattice.has(key)) {
      let label = '';
      try { label = cfg.gridLabel(it) || ''; } catch { /* keep '' */ }
      byLattice.set(key, { label, epsg, ulx, uly, tile: label, catalog: CATALOG_NAMES[url] ?? new URL(url).hostname });
    }
  }
  return [...byLattice.values()].sort((a, b) => a.epsg - b.epsg || a.label.localeCompare(b.label));
}
