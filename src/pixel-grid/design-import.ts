import proj4 from 'proj4';
import { iter as zipEntries } from 'but-unzip';
import type { ImportedDesign, ImportedPlot, ImportedVariety, LngLat } from './imported-types';

/**
 * Reads an experimental design the user uploads (a zipped shapefile, its loose
 * parts, GeoJSON, KML or KMZ) into an ImportedDesign: WGS84 plot rings, every
 * attribute as text, and a first guess at which column names the varieties and
 * which names the plots.
 *
 * Pure and DOM-free on purpose: the regression suite runs it under node, and a
 * file the page cannot read should fail here with a sentence the user can act
 * on, never deep inside the engine.
 *
 * The shapefile bytes are read here rather than through shpjs's parsers, which
 * the rest of the app uses for quick previews. Three of its habits are wrong for
 * a design, where every plot and every id matters:
 *   - it regroups a record's rings by winding order and silently DROPS any ring
 *     it cannot nest (a two-part plot whose parts wind opposite ways loses one),
 *     while the contract keeps every ring and fills them even-odd;
 *   - it swallows a .prj proj4 cannot read and returns raw metres as if they
 *     were degrees, which puts the trial in the ocean without a word;
 *   - its DBF numbers go through parseFloat (an 18-digit plot id loses digits and
 *     two plots can collide), and without a .cpg it decodes Latin-1 as UTF-8.
 * What IS reused: proj4 for the projection math of a .prj (the datum shift,
 * prime meridian and angle unit are decided here, see crsFromWkt), and
 * but-unzip, the zip reader shpjs itself depends on.
 */

// ===== limits and errors =======================================================

/** Largest upload (and largest unzipped member) accepted. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
/** Most plots a design may have: beyond this the fine raster stops being interactive. */
export const MAX_IMPORT_PLOTS = 5000;
/**
 * Most varieties a design may have. Mirrors simulate.ts's MAX_COVER: the cover
 * map is a byte whose ids 0..252 are species and 253..255 are off-trial, bare
 * and mixed. Not imported, because simulate.ts drags in the whole engine.
 */
export const MAX_IMPORT_VARIETIES = 252;

/** A problem with the uploaded file, worded for the person who uploaded it. */
export class DesignImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignImportError';
  }
}

function fail(message: string): never {
  throw new DesignImportError(message);
}

/**
 * A KML that only links to other files (NetworkLink). GDAL and Google Earth
 * write a KMZ as such a doc.kml beside the layers it links, so when another
 * layer of the upload is read this is the archive's normal shape, not a layer
 * the user lost, and it is not reported.
 */
class LinksOnly extends DesignImportError {}

export interface DesignFile {
  name: string;
  data: ArrayBuffer;
}

/** The part of a design the column detectors look at. */
export type DesignLike = Pick<ImportedDesign, 'columns' | 'plots'>;

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
/** Rounded UP to a tenth, so a file just over the limit never reads as exactly the limit. */
const megabytes = (bytes: number) => `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;
const coord = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * A plot's value in a column, '' when it has none. Own properties only: a
 * column called "constructor" that one plot lacks must not read Object's.
 */
const cell = (props: Record<string, string>, col: string): string => (Object.hasOwn(props, col) ? props[col] : '');

// ===== entry point =============================================================

type Bytes = Uint8Array;

/** One file of the upload, or one member of an uploaded archive. */
interface Entry {
  path: string;
  /** The uploaded file it came from: the archive's name for a zip member. */
  source: string;
  bytes: Bytes;
  inArchive: boolean;
}

type ShpPart = 'shp' | 'shx' | 'dbf' | 'prj' | 'cpg';

type LayerSource =
  | { kind: 'shp'; key: string; source: string; parts: Partial<Record<ShpPart, Entry>> }
  | { kind: 'geojson' | 'kml'; source: string; entry: Entry };

interface ReadLayer {
  label: string;
  source: string;
  plots: ImportedPlot[];
  columns: string[];
  warnings: string[];
}

const SHP_PARTS = new Set<string>(['shp', 'shx', 'dbf', 'prj', 'cpg']);
const LAYER_EXTS = new Set<string>(['geojson', 'json', 'kml']);
/** Files that travel with a shapefile and carry nothing a design needs: accepted without a word. */
const SIDECARS = new Set<string>(['qix', 'sbn', 'sbx', 'fix', 'xml', 'qmd', 'qpj', 'aih', 'ain', 'atx', 'ixs', 'mxs', 'cst', 'lyr', 'lyrx', 'qml', 'sld']);

const extOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};
const stemOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
};
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Read an uploaded design. Accepts a .zip holding a shapefile (or GeoJSON/KML),
 * the loose parts of a shapefile selected together, .geojson/.json, .kml and
 * .kmz. When the upload holds several polygon layers, the one with the most
 * plots (within MAX_IMPORT_PLOTS) is used and a warning names the others.
 *
 * Throws DesignImportError, with a message meant for the user, when nothing
 * usable can be read or a limit is exceeded.
 */
export async function readDesignFiles(files: DesignFile[]): Promise<ImportedDesign> {
  if (!files.length) fail('No file was given.');
  for (const f of files) {
    if (f.data.byteLength > MAX_IMPORT_BYTES) {
      fail(`"${f.name}" is ${megabytes(f.data.byteLength)}; designs up to ${megabytes(MAX_IMPORT_BYTES)} can be imported.`);
    }
  }

  const warnings: string[] = [];
  const entries: Entry[] = [];
  const ignored: string[] = [];
  const archives: string[] = [];
  for (const f of files) {
    const ext = extOf(f.name);
    if (ext === 'zip' || ext === 'kmz') {
      archives.push(f.name);
      entries.push(...(await unzipArchive(f)));
    } else if (SHP_PARTS.has(ext) || LAYER_EXTS.has(ext)) {
      entries.push({ path: f.name, source: f.name, bytes: new Uint8Array(f.data), inArchive: false });
    } else if (!SIDECARS.has(ext)) {
      ignored.push(f.name);
    }
  }

  const layers = groupLayers(entries);
  const emptyArchives = archives.filter(a => !layers.some(l => l.source === a));
  if (!layers.length) {
    if (emptyArchives.length) fail(`"${emptyArchives[0]}" holds no shapefile, GeoJSON or KML.`);
    const shown = ignored[0] ?? files[0].name;
    fail(
      SHP_PARTS.has(extOf(shown))
        ? `"${shown}" alone is not a design: select the .shp together with its .dbf and .prj, or upload them zipped.`
        : `"${shown}" is not a design file the designer can read. Upload a zipped shapefile (.zip), the shapefile's parts (.shp, .dbf, .prj...), GeoJSON (.geojson, .json), KML or KMZ.`,
    );
  }

  const usable: ReadLayer[] = [];
  const failures: string[] = [];
  const quiet: string[] = [];
  for (const layer of layers) {
    try {
      usable.push(readLayer(layer));
    } catch (e) {
      // A bug in a parser still reaches the user as a sentence naming the file.
      const message = e instanceof DesignImportError ? e.message : `"${layerLabel(layer)}" could not be read (${(e as Error)?.message ?? e}).`;
      (e instanceof LinksOnly ? quiet : failures).push(message);
    }
  }
  if (!usable.length) fail([...failures, ...quiet].join(' '));

  let best = usable[0];
  for (const l of usable) if (l.plots.length > best.plots.length) best = l;
  warnings.push(...best.warnings);
  if (usable.length > 1) {
    const others = usable.filter(l => l !== best).map(l => `"${l.label}" (${plural(l.plots.length, 'plot')})`);
    warnings.unshift(`The upload holds ${usable.length} polygon layers; using "${best.label}" (${plural(best.plots.length, 'plot')}) and ignoring ${others.join(', ')}.`);
  }
  for (const f of failures) warnings.push(`Another layer was ignored: ${f}`);
  for (const a of emptyArchives) warnings.push(`"${a}" holds no shapefile, GeoJSON or KML and was ignored.`);
  if (ignored.length) warnings.push(`Ignored ${plural(ignored.length, 'file')} that ${ignored.length === 1 ? 'is' : 'are'} not part of a design: ${ignored.join(', ')}.`);

  const design: ImportedDesign = {
    fileName: best.source,
    plots: best.plots,
    columns: best.columns,
    varietyColumn: '',
    nameColumn: '',
    warnings,
  };
  design.varietyColumn = detectVarietyColumn(design);
  design.nameColumn = detectNameColumn(design);

  if (!design.varietyColumn) {
    if (design.plots.length > MAX_IMPORT_VARIETIES) {
      fail(
        `"${design.fileName}" has ${plural(design.plots.length, 'plot')} and no attribute that groups them into at most ${MAX_IMPORT_VARIETIES} varieties, ` +
          `so every plot would be its own variety. Add a variety column (at most ${MAX_IMPORT_VARIETIES} distinct values) and import it again.`,
      );
    }
    warnings.push(
      design.columns.length
        ? 'No column names the varieties, so every plot is its own variety.'
        : 'The file has no attributes, so every plot is its own variety.',
    );
  } else if (varietyWordRank(design.varietyColumn) < 0) {
    warnings.push(`No column is named like a variety; varieties were guessed from "${design.varietyColumn}". Pick another column if that is wrong.`);
  }
  return design;
}

const layerLabel = (l: LayerSource): string =>
  l.kind === 'shp' ? (l.parts.shp ?? l.parts.dbf ?? l.parts.shx ?? l.parts.prj ?? l.parts.cpg)!.path : l.entry.path;

/**
 * Where the zip's end-of-central-directory record starts, or -1. but-unzip finds
 * that record by walking back over 'P' bytes, and when none is real and the
 * last candidate is byte 0 it restarts from the end forever (a TypedArray's
 * lastIndexOf reads a negative start as "from the end"). Every zip begins with
 * "PK", so a truncated download would freeze the page instead of failing.
 */
function findZipDirectory(b: Bytes): number {
  const lowest = Math.max(0, b.length - 22 - 0xffff); // the record, then at most a 65,535-byte comment
  for (let i = b.length - 22; i >= lowest; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
  }
  return -1;
}

/**
 * The uncompressed size each central directory entry declares, in the order
 * but-unzip yields them (null where it is not stated: ZIP64, or a directory cut
 * short). Read so an oversized member is refused BEFORE it is inflated: a
 * 1.5 MB zip can hold gigabytes of zeros, and inflating first would exhaust the
 * tab's memory on the way to the refusal.
 */
function declaredZipSizes(b: Bytes, eocd: number): (number | null)[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = v.getUint16(eocd + 10, true);
  const sizes: (number | null)[] = [];
  let at = v.getUint32(eocd + 16, true);
  for (let k = 0; k < count; k++) {
    if (at + 46 > b.length || v.getUint32(at, true) !== 0x02014b50) break;
    const size = v.getUint32(at + 24, true);
    sizes.push(size === 0xffffffff ? null : size);
    at += 46 + v.getUint16(at + 28, true) + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return sizes;
}

/** Raised inside the inflater when a member outgrows MAX_IMPORT_BYTES. */
class InflateLimit extends Error {}

/**
 * A raw-deflate inflater that stops as soon as the output passes
 * MAX_IMPORT_BYTES. The declared size can lie, and but-unzip's own inflater
 * collects everything before anyone can look at it. Undefined where the
 * platform has no DecompressionStream, which leaves but-unzip's default (the
 * declared-size check still applies).
 */
const cappedInflate = typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined'
  ? undefined
  : async (raw: Uint8Array): Promise<Uint8Array> => {
    const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMPORT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new InflateLimit();
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };

async function unzipArchive(file: DesignFile): Promise<Entry[]> {
  const out: Entry[] = [];
  const bytes = new Uint8Array(file.data);
  const tooBig = (path: string, size: string) =>
    fail(`"${path}" inside "${file.name}" is ${size} once unzipped; designs up to ${megabytes(MAX_IMPORT_BYTES)} can be imported.`);
  let items;
  let sizes: (number | null)[];
  try {
    const eocd = findZipDirectory(bytes);
    if (eocd < 0) throw new Error('no central directory');
    items = [...zipEntries(bytes, cappedInflate)];
    sizes = declaredZipSizes(bytes, eocd);
  } catch {
    return fail(`"${file.name}" could not be unzipped: it is damaged or not a zip archive.`);
  }
  for (const [k, item] of items.entries()) {
    const path = item.filename;
    // Finder's resource forks and folders are not layers.
    if (path.endsWith('/') || /(^|\/)__MACOSX\//.test(path) || baseOf(path).startsWith('._')) continue;
    const ext = extOf(path);
    if (!SHP_PARTS.has(ext) && !LAYER_EXTS.has(ext)) continue;
    const declared = sizes[k] ?? null;
    if (declared !== null && declared > MAX_IMPORT_BYTES) tooBig(path, megabytes(declared));
    let member: Bytes;
    try {
      member = await item.read();
    } catch (e) {
      if (e instanceof InflateLimit) tooBig(path, `over ${megabytes(MAX_IMPORT_BYTES)}`);
      return fail(`"${path}" inside "${file.name}" could not be unzipped: the archive is damaged or uses an unsupported compression.`);
    }
    if (member.length > MAX_IMPORT_BYTES) tooBig(path, megabytes(member.length));
    out.push({ path, source: file.name, bytes: member, inArchive: true });
  }
  return out;
}

/** Shapefile parts meet by stem (case-insensitive, per archive); every GeoJSON/KML is its own layer. */
function groupLayers(entries: Entry[]): LayerSource[] {
  const layers: LayerSource[] = [];
  const shp = new Map<string, Extract<LayerSource, { kind: 'shp' }>>();
  for (const e of entries) {
    const ext = extOf(e.path);
    if (SHP_PARTS.has(ext)) {
      const key = `${e.inArchive ? e.source : ''}\u0000${stemOf(e.path).toLowerCase()}`;
      let group = shp.get(key);
      if (!group) {
        group = { kind: 'shp', key, source: e.source, parts: {} };
        shp.set(key, group);
        layers.push(group);
      }
      group.parts[ext as ShpPart] = e;
      // A loose shapefile is shown under its .shp's name, the file the user recognises.
      if (ext === 'shp' && !e.inArchive) group.source = e.path;
    } else if (ext === 'kml') {
      layers.push({ kind: 'kml', source: e.source, entry: e });
    } else {
      layers.push({ kind: 'geojson', source: e.source, entry: e });
    }
  }
  // A lone .prj or .cpg is a stray companion, not a layer that failed.
  return layers.filter(l => l.kind !== 'shp' || l.parts.shp || l.parts.dbf || l.parts.shx);
}

function readLayer(layer: LayerSource): ReadLayer {
  if (layer.kind === 'shp') return readShapefileLayer(layer);
  return layer.kind === 'kml' ? readKmlLayer(layer.entry) : readGeoJsonLayer(layer.entry);
}

// ===== geometry shared by every format ========================================

type Pos = [number, number];

/** A feature as a format reader hands it over, before CRS and ring checks. */
type RawGeom =
  | { kind: 'polygons'; polygons: Pos[][][] }
  | { kind: 'none' }
  | { kind: 'other'; type: string }
  | { kind: 'invalid' };

interface RawFeature {
  geom: RawGeom;
  props: Record<string, string>;
}

/**
 * How a layer's coordinates reach WGS84.
 *   lonlat, declared: the file states WGS84 lon/lat (a .prj, KML, a GeoJSON crs).
 *   lonlat, assumed:  nothing states it (no .prj, GeoJSON without crs), so the
 *                     numbers must also LOOK like a field trial in degrees.
 *   proj:             anything else, through `forward`; its numbers must look
 *                     like what the system says they are (degrees or lengths).
 */
type LayerCrs =
  | { kind: 'lonlat'; how: 'declared' | 'assumed' }
  | {
    kind: 'proj';
    name: string;
    forward: (x: number, y: number) => Pos;
    /** What the file's own numbers are: angles of a geographic system, or lengths of a projected one. */
    raw: 'degrees' | 'lengths';
    /** Metres per unit of those lengths (feet are 0.3048). */
    metresPerUnit: number;
    /** Where a datum from DATUM_SHIFTS is used, so a .prj borrowed from elsewhere is caught. */
    area?: { datum: string; bbox: [number, number, number, number] };
    /** Appended to the reprojection warning (the datum shift that was applied). */
    note?: string;
  };

/**
 * Widest a design read as unlabelled degrees may be. Local metre coordinates
 * such as 0..150 fall inside the lon/lat range, but no field trial spans
 * hundreds of degrees; without this they would be drawn across the globe.
 */
const ASSUMED_MAX_SPAN_DEG = 10;

/**
 * Where a plot's size tells degrees from lengths. A plot is at least half a
 * metre across and a field trial's plot at most a few hundred metres, which is
 * under 0.01 degree: so a median plot diagonal above 0.1 in the file's own
 * numbers is not degrees, and below 0.1 is not metres, with a factor of ten to
 * spare either way. The span test alone misses a small local grid (0..9 m read
 * as a 330 km plot) and degrees under a projected .prj (plots 2 cm wide off
 * the coast of Africa).
 */
const PLOT_SIZE_SPLIT = 0.1;

/** Column set that keeps file order and never lets two source keys share a name. */
class Columns {
  readonly names: string[] = [];
  private bySource = new Map<string, string>();
  private taken = new Set<string>();

  add(sourceKey: string, wanted: string): string {
    const known = this.bySource.get(sourceKey);
    if (known !== undefined) return known;
    // "__proto__" would silently vanish as an object key, and a column called ''
    // would read as "no variety column" (varietyColumn's sentinel), so a blank
    // name gets a placeholder as the DBF reader gives it.
    const base = !wanted.trim() ? `field_${this.names.length + 1}` : wanted === '__proto__' ? '_proto_' : wanted;
    let name = base;
    for (let k = 2; this.taken.has(name); k++) name = `${base}_${k}`;
    this.taken.add(name);
    this.bySource.set(sourceKey, name);
    this.names.push(name);
    return name;
  }
}

/** Drop repeated vertices and closure, reject what encloses nothing, return the ring closed. */
function cleanRing(ring: Pos[]): LngLat[] | null {
  const out: LngLat[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push([p[0], p[1]]);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  if (out.length < 3 || new Set(out.map(p => `${p[0]},${p[1]}`)).size < 3) return null;
  // Twice the signed area, relative to the first vertex so a 15 m plot at 43 deg
  // of latitude does not cancel in the products, and judged against the ring's
  // own size so float noise on a straight line is not mistaken for area.
  const [x0, y0] = out[0];
  let a2 = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < out.length; i++) {
    const [x, y] = out[i];
    const [nx, ny] = out[(i + 1) % out.length];
    a2 += (x - x0) * (ny - y0) - (nx - x0) * (y - y0);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX, h = maxY - minY;
  if (!(Math.abs(a2) > 1e-10 * (w * w + h * h))) return null;
  out.push([out[0][0], out[0][1]]);
  return out;
}

/**
 * Reproject, validate and clean a layer's features into plots, with one
 * aggregated warning per kind of thing skipped. Throws when nothing usable
 * remains, when the coordinates cannot be longitude/latitude, or when the layer
 * has more plots than the designer takes.
 */
function finishLayer(label: string, source: string, columns: string[], features: RawFeature[], crs: LayerCrs, warnings: string[], notLonLatHint: string): ReadLayer {
  const forward = crs.kind === 'proj' ? crs.forward : (x: number, y: number): Pos => [x, y];
  const plots: ImportedPlot[] = [];
  // unprojected: finite in the file (every reader checks that) but not after the coordinate system's forward.
  let none = 0, invalid = 0, unprojected = 0, droppedRings = 0, emptied = 0;
  const other = new Map<string, number>();
  // Judged on the rings that are KEPT: a dropped placeholder ring at 0,0 says
  // nothing about the coordinate system and must not fail the plots beside it.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let outside: Pos | null = null;
  let first: Pos | null = null;
  let firstRaw: Pos | null = null;
  let rawInLonLatRange = true;
  const rawDiagonals: number[] = [];
  const see = (ring: LngLat[], raw: Pos[], outer: boolean) => {
    for (const [x, y] of ring) {
      if (!first) first = [x, y];
      if (!outside && (Math.abs(x) > 180 || Math.abs(y) > 90)) outside = [x, y];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of raw) {
      if (!firstRaw) firstRaw = [x, y];
      if (Math.abs(x) > 180 || Math.abs(y) > 90) rawInLonLatRange = false;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (outer) rawDiagonals.push(Math.hypot(x1 - x0, y1 - y0));
  };

  for (const f of features) {
    const g = f.geom;
    if (g.kind === 'none') { none++; continue; }
    if (g.kind === 'invalid') { invalid++; continue; }
    if (g.kind === 'other') { other.set(g.type, (other.get(g.type) ?? 0) + 1); continue; }

    let finite = true;
    const projected: Pos[][][] = g.polygons.map(poly => poly.map(ring => ring.map(([x, y]) => {
      let p: Pos;
      try {
        p = forward(x, y);
      } catch {
        p = [NaN, NaN];
      }
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) finite = false;
      return p;
    })));
    if (!finite) { unprojected++; continue; }

    const rings: LngLat[][] = [];
    const droppedBefore = droppedRings;
    projected.forEach((poly, pi) => {
      if (!poly.length) { droppedRings++; return; }
      const outer = cleanRing(poly[0]);
      // A hole means nothing once the ring it cuts is gone.
      if (!outer) { droppedRings += poly.length; return; }
      see(outer, g.polygons[pi][0], true);
      rings.push(outer);
      for (let k = 1; k < poly.length; k++) {
        const hole = cleanRing(poly[k]);
        if (hole) {
          see(hole, g.polygons[pi][k], false);
          rings.push(hole);
        } else {
          droppedRings++;
        }
      }
    });
    if (!rings.length) {
      // A MultiPolygon with no polygons still counts as one empty ring, so it is reported.
      if (droppedRings === droppedBefore) droppedRings++;
      emptied++;
      continue;
    }
    const props: Record<string, string> = {};
    for (const c of columns) props[c] = cell(f.props, c);
    plots.push({ rings, props });
  }

  const sample = (p: Pos | null) => (p ? `e.g. ${coord(p[0])}, ${coord(p[1])}` : '');
  const sorted = rawDiagonals.slice().sort((a, b) => a - b);
  const medianPlot = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
  const rawIsDegrees = crs.kind === 'lonlat' || crs.raw === 'degrees';
  if (crs.kind === 'proj') {
    if (outside) {
      fail(`"${label}" does not land on the Earth when read with its coordinate system (${crs.name}) (${sample(outside)}): the coordinate system probably belongs to other data.`);
    }
    if (crs.raw === 'lengths' && rawInLonLatRange && medianPlot * crs.metresPerUnit < PLOT_SIZE_SPLIT) {
      fail(
        `"${label}" has coordinates that look like longitude/latitude (${sample(firstRaw)}), but its coordinate system (${crs.name}) is in metres, ` +
          `which would make each plot a few centimetres wide: the coordinate system probably belongs to other data.`,
      );
    }
  }
  if (rawIsDegrees && (
    (crs.kind === 'lonlat' && outside) ||
    (crs.kind === 'lonlat' && crs.how === 'assumed' && (maxX - minX > ASSUMED_MAX_SPAN_DEG || maxY - minY > ASSUMED_MAX_SPAN_DEG)) ||
    medianPlot > PLOT_SIZE_SPLIT
  )) {
    fail(`"${label}" has coordinates that are not longitude/latitude (${sample(outside ?? firstRaw)}). ${notLonLatHint}`);
  }
  if (crs.kind === 'proj' && crs.area && first) {
    const [s, w, n, e] = crs.area.bbox;
    const [lon, lat] = first as Pos;
    const margin = 1;
    if (lat < s - margin || lat > n + margin || lon < w - margin || lon > e + margin) {
      fail(
        `"${label}" lands at ${coord(lon)}, ${coord(lat)} when read with its coordinate system (${crs.name}), far outside the area the ${crs.area.datum} datum ` +
          `is used in: the coordinate system probably belongs to other data.`,
      );
    }
  }

  if (other.size) {
    const total = [...other.values()].reduce((a, b) => a + b, 0);
    const kinds = [...other.entries()].map(([t, n]) => `${n} ${t}`).join(', ');
    warnings.push(`Skipped ${plural(total, 'feature')} that ${total === 1 ? 'is' : 'are'} not a polygon (${kinds}).`);
  }
  if (none) warnings.push(`Skipped ${plural(none, 'feature')} with no geometry.`);
  if (invalid) warnings.push(`Skipped ${plural(invalid, 'feature')} with invalid or non-finite coordinates.`);
  if (unprojected && crs.kind === 'proj' && plots.length) {
    warnings.push(`Skipped ${plural(unprojected, 'feature')} whose coordinates could not be reprojected from ${crs.name}.`);
  }
  if (droppedRings) {
    warnings.push(
      `Dropped ${plural(droppedRings, 'empty or degenerate ring')} (fewer than 3 distinct points, or no area)` +
        (emptied ? `; ${plural(emptied, 'feature')} had nothing else and ${emptied === 1 ? 'was' : 'were'} skipped.` : '.'),
    );
  }

  if (!plots.length && unprojected && crs.kind === 'proj') {
    fail(`"${label}" could not be reprojected from its coordinate system (${crs.name}). Export the layer in WGS84 (EPSG:4326) and import it again.`);
  }
  if (!plots.length) {
    const why: string[] = [];
    if (other.size) why.push([...other.entries()].map(([t, n]) => `${n} ${t}`).join(', '));
    if (none) why.push(`${none} without geometry`);
    if (invalid) why.push(`${invalid} with invalid coordinates`);
    if (emptied) why.push(`${emptied} empty or degenerate`);
    fail(`"${label}" holds no usable plot polygons${why.length ? ` (features found: ${why.join('; ')})` : ''}. A design must be the plots drawn as polygons.`);
  }
  if (plots.length > MAX_IMPORT_PLOTS) {
    fail(`"${label}" holds ${plural(plots.length, 'plot')}; at most ${MAX_IMPORT_PLOTS.toLocaleString('en-US')} can be imported.`);
  }
  return { label, source, plots, columns, warnings };
}

// ===== text and numbers ========================================================

/**
 * A number as the text a person would type: integers exactly, fractions rounded
 * to 15 significant digits so binary noise (0.30000000000000004) never becomes
 * a distinct variety or a distinct plot name.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n === 0 ? 0 : n);
  return String(Number(n.toPrecision(15)));
}

/** Any attribute value as text: '' for null/undefined, JSON for objects. */
function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

const utf8 = new TextDecoder('utf-8');

// ===== shapefile ===============================================================

const SHAPE_TYPE_NAMES: Record<number, string> = {
  1: 'Point', 11: 'Point', 21: 'Point',
  3: 'LineString', 13: 'LineString', 23: 'LineString',
  8: 'MultiPoint', 18: 'MultiPoint', 28: 'MultiPoint',
  31: 'MultiPatch',
};

function readShapefileLayer(layer: Extract<LayerSource, { kind: 'shp' }>): ReadLayer {
  const { shp, dbf, prj, cpg } = layer.parts;
  if (!shp) {
    const shown = (dbf ?? layer.parts.shx)!.path;
    return fail(`"${shown}" has no matching .shp file: select the .shp together with its .dbf and .prj, or upload them zipped.`);
  }
  const label = shp.path;
  const warnings: string[] = [];
  const geoms = readShpGeometries(shp.bytes, label, warnings);

  let columns: string[] = [];
  let rows: (Record<string, string> | null)[] = [];
  if (dbf) {
    const table = readDbf(dbf.bytes, cpg ? utf8.decode(cpg.bytes) : undefined, dbf.path, cpg?.path, warnings);
    columns = table.columns;
    rows = table.rows;
    if (rows.length !== geoms.length) {
      warnings.push(
        `"${dbf.path}" has ${plural(rows.length, 'row')} but "${label}" has ${plural(geoms.length, 'shape')}; ` +
          (rows.length < geoms.length ? 'the extra shapes have empty attributes.' : 'the extra rows were ignored.'),
      );
    }
  } else {
    warnings.push(`"${label}" came without its .dbf, so the plots have no attributes.`);
  }

  const features: RawFeature[] = [];
  let deleted = 0;
  geoms.forEach((geom, i) => {
    const row = i < rows.length ? rows[i] : {};
    // dBASE marks a deleted row instead of removing it; GIS software hides the feature too.
    if (row === null) { deleted++; return; }
    features.push({ geom, props: row });
  });
  if (deleted) warnings.push(`Skipped ${plural(deleted, 'feature')} marked as deleted in "${dbf!.path}".`);

  let crs: LayerCrs;
  const wkt = prj ? utf8.decode(prj.bytes).trim() : ''; // the decoder drops a byte order mark
  if (!wkt) {
    crs = { kind: 'lonlat', how: 'assumed' };
    warnings.push(`"${label}" has no .prj file, so its coordinates were read as WGS84 longitude/latitude.`);
  } else {
    crs = crsFromWkt(wkt, prj!.path);
    if (crs.kind === 'proj') warnings.push(`Reprojected "${label}" from ${crs.name} to WGS84 longitude/latitude${crs.note ? `, ${crs.note}` : ''}.`);
  }
  const hint = wkt
    ? `Its .prj says they are longitude/latitude, so the .prj probably belongs to other data.`
    : `The .prj file that says which coordinate system they are in is missing: select it together with the .shp, or zip all the shapefile's parts together.`;
  return finishLayer(label, layer.source, columns, features, crs, warnings, hint);
}

// ----- .prj (WKT) -----

/** One WKT element, KEYWORD[args], whose args are elements, quoted strings, numbers or bare words. */
interface WktNode {
  key: string;
  args: WktArg[];
}
type WktArg = WktNode | { s: string } | { n: number; raw: string } | { w: string };

const isWktNode = (a: WktArg): a is WktNode => 'key' in a;

/** WKT1 or WKT2 text as its element tree, or null when it is not well formed. */
function parseWkt(text: string): WktNode | null {
  const n = text.length;
  let i = 0;
  const skip = () => {
    while (i < n && /\s/.test(text[i])) i++;
  };
  const word = () => /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 80))?.[0];
  const element = (key: string): WktNode | null => {
    const close = text[i] === '[' ? ']' : ')';
    i++;
    const args: WktArg[] = [];
    for (;;) {
      skip();
      if (text[i] === close) {
        i++;
        return { key: key.toUpperCase(), args };
      }
      if (args.length) {
        if (text[i] !== ',') return null;
        i++;
        skip();
      }
      const c = text[i];
      if (c === '"') {
        let s = '';
        for (i++; ; i++) {
          if (i >= n) return null;
          if (text[i] === '"') {
            if (text[i + 1] !== '"') break;
            i++; // "" is a quote inside the string
          }
          s += text[i];
        }
        i++;
        args.push({ s });
      } else if (c !== undefined && /[-+.\d]/.test(c)) {
        const num = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(text.slice(i, i + 80))?.[0];
        if (!num) return null;
        i += num.length;
        args.push({ n: Number(num), raw: num });
      } else {
        const w = word();
        if (!w) return null;
        i += w.length;
        skip();
        if (text[i] === '[' || text[i] === '(') {
          const kid = element(w);
          if (!kid) return null;
          args.push(kid);
        } else {
          args.push({ w });
        }
      }
    }
  };
  skip();
  const key = word();
  if (!key) return null;
  i += key.length;
  skip();
  if (text[i] !== '[' && text[i] !== '(') return null;
  const root = element(key);
  skip();
  return root && i >= n ? root : null;
}

const wktKid = (el: WktNode | undefined, ...keys: string[]): WktNode | undefined =>
  el?.args.find((a): a is WktNode => isWktNode(a) && keys.includes(a.key));
const wktName = (el: WktNode | undefined): string => {
  const a = el?.args[0];
  return a && 's' in a ? a.s : '';
};
const wktNumbers = (el: WktNode | undefined): number[] => (el ? el.args.flatMap(a => ('n' in a ? [a.n] : [])) : []);
const wktText = (a: WktArg): string =>
  isWktNode(a) ? `${a.key}[${a.args.map(wktText).join(',')}]` : 's' in a ? `"${a.s.replace(/"/g, '""')}"` : 'n' in a ? a.raw : a.w;
/** Every element with one of `keys` below `el`, depth first. */
const wktFindAll = (el: WktNode, keys: string[], out: WktNode[] = []): WktNode[] => {
  for (const a of el.args) {
    if (!isWktNode(a)) continue;
    if (keys.includes(a.key)) out.push(a);
    wktFindAll(a, keys, out);
  }
  return out;
};

/** A datum or meridian name as a lookup key: "D_Belge_1972" and "Belge 1972" are both "belge1972". */
const crsKey = (name: string): string => fold(name).replace(/^d_/, '').replace(/[^a-z0-9]/g, '');

const DEGREE = Math.PI / 180;
const ARC_SECOND = Math.PI / 648000;

/**
 * Longitude of each prime meridian from Greenwich, in degrees (EPSG). Looked up
 * by NAME because the value in a .prj is not reliable: ESRI writes Paris as
 * 2.33722917 degrees while GDAL's WKT1 writes 2.5969213 in the grads of the
 * datum, both beside UNIT["grad"].
 */
const PRIME_MERIDIANS: Record<string, number> = {
  greenwich: 0, paris: 2.33722917, ferro: -17.6666666666667, rome: 12.4523333333333, madrid: -3.687375, lisbon: -9.13190611111111,
  bern: 7.43958333333333, brussels: 4.367975, stockholm: 18.0582777777778, oslo: 10.7229166666667, athens: 23.7163375,
  jakarta: 106.807719444444, bogota: -74.0809166666667,
};

/**
 * Shifts to WGS84 for the older national datums a field trial may still be
 * surveyed in, keyed by the datum names ESRI, GDAL (WKT1) and WKT2 give them.
 * proj4js knows almost none of them from a .prj: it leaves Belge 1972, DHDN,
 * Amersfoort or LUREF unshifted (plots 170 to 220 m off, 17 to 22 pixels) and
 * shifts Belge 1972 the wrong way round. So the reader applies these itself.
 *
 * Each is the EPSG transformation PROJ uses without grids, written as proj4's
 * position-vector towgs84 (coordinate-frame rotations negated), checked against
 * PROJ's cs2cs across the datum's area; `accuracy` is EPSG's, in metres, and is
 * told to the user. `a` guards against a namesake on another ellipsoid; `bbox`
 * ([south, west, north, east]) catches a .prj that belongs to other data.
 * Datums whose transformation depends on the region (ED50, Pulkovo, NAD27 on
 * grids) are left out on purpose: a wrong shift is worse than a clear refusal.
 */
const DATUM_SHIFTS: { names: string[]; a: number; towgs84: number[]; accuracy: number; bbox: [number, number, number, number] }[] = [
  // EPSG:15929 BD72 to WGS 84 (3)
  { names: ['belge1972', 'reseaunationalbelge1972'], a: 6378388, towgs84: [-106.8686, 52.2978, -103.7239, 0.3366, -0.457, 1.8422, -1.2747], accuracy: 1, bbox: [49.5, 2.5, 51.51, 6.4] },
  // EPSG:1777 DHDN to WGS 84 (2); within 0.6 m of (3) in the former East
  { names: ['deutscheshauptdreiecksnetz'], a: 6377397.155, towgs84: [598.1, 73.7, 418.2, 0.202, 0.045, -2.455, 6.7], accuracy: 3, bbox: [47.27, 5.86, 55.09, 15.04] },
  // EPSG:4833 Amersfoort to WGS 84 (4)
  { names: ['amersfoort'], a: 6377397.155, towgs84: [565.4171, 50.3319, 465.5524, -0.398957388243134, 0.343987817378283, -1.87740163998045, 4.0725], accuracy: 1, bbox: [50.75, 3.2, 53.7, 7.22] },
  // EPSG:5486 LUREF to WGS 84 (3)
  { names: ['luxembourgreferenceframe'], a: 6378388, towgs84: [-189.6806, 18.3463, -42.7695, -0.33746, -3.09264, 2.53861, 0.4598], accuracy: 1, bbox: [49.44, 5.73, 50.19, 6.53] },
  // EPSG:1193 NTF to WGS 84 (1), and EPSG:8094 for NTF (Paris)
  { names: ['ntf', 'nouvelletriangulationfrancaise', 'ntfparis', 'nouvelletriangulationfrancaiseparis'], a: 6378249.2, towgs84: [-168, -60, 320], accuracy: 2, bbox: [41.31, -4.87, 51.14, 9.63] },
  // EPSG:1314 OSGB36 to WGS 84 (6)
  { names: ['osgb1936', 'ordnancesurveyofgreatbritain1936'], a: 6377563.396, towgs84: [446.448, -125.157, 542.06, 0.15, 0.247, 0.842, -20.489], accuracy: 2, bbox: [49.75, -9.01, 61.01, 2.01] },
  // EPSG:1766 CH1903 and EPSG:1676 CH1903+ to WGS 84 (both keys read "ch1903")
  { names: ['ch1903'], a: 6377397.155, towgs84: [674.374, 15.056, 405.346], accuracy: 1.5, bbox: [45.81, 5.95, 47.81, 10.5] },
  // EPSG:1618 MGI to WGS 84 (3)
  { names: ['mgi', 'militargeographischeinstitut'], a: 6377397.155, towgs84: [577.326, 90.129, 463.919, 5.137, 1.474, 5.297, 2.4232], accuracy: 1.5, bbox: [46.4, 9.53, 49.02, 17.17] },
  // EPSG:1660 Monte Mario to WGS 84 (4), mainland; within 4.3 m of the island ones
  { names: ['montemario'], a: 6378388, towgs84: [-104.1, -49.1, -9.9, 0.971, -2.917, 0.714, -11.68], accuracy: 5, bbox: [34.76, 5.93, 47.1, 18.99] },
  // EPSG:1623 S-JTSK to WGS 84 (1), Czechia; within 6 m of (4) in Slovakia
  { names: ['sjtsk', 'systemoftheunifiedtrigonometricalcadastralnetwork'], a: 6377397.155, towgs84: [570.8, 85.7, 462.8, 4.998, 1.587, 5.261, 3.56], accuracy: 6, bbox: [47.73, 12.09, 51.06, 22.56] },
  // EPSG:1272 GGRS87 to WGS 84 (1): on the GRS80 ellipsoid, yet 330 m from WGS84
  { names: ['ggrs1987', 'greekgeodeticreferencesystem1987'], a: 6378137, towgs84: [-199.87, 74.79, 246.62], accuracy: 1, bbox: [34.88, 19.57, 41.75, 28.3] },
  // EPSG:9676 Israel 1993 to WGS 84 (2): GRS80 too
  { names: ['israel', 'israel1993'], a: 6378137, towgs84: [23.772, 17.49, 17.859, -0.3132, -1.85274, 1.67299, -5.4262], accuracy: 1, bbox: [29.45, 34.17, 33.28, 35.69] },
  // EPSG:1987 Datum 73 to WGS 84 (4)
  { names: ['datum73'], a: 6378388, towgs84: [-239.749, 88.181, 30.488, 0.263, 0.082, 1.211, 2.229], accuracy: 1, bbox: [36.95, -9.56, 42.16, -6.19] },
  // EPSG:1988 Lisbon to WGS 84 (4)
  { names: ['lisbon', 'lisbon1937'], a: 6378388, towgs84: [-288.885, -91.744, 126.244, -1.691, 0.41, -0.211, -4.598], accuracy: 2, bbox: [36.95, -9.56, 42.16, -6.19] },
  // EPSG:1242 HD72 to WGS 84 (4)
  { names: ['hungarian1972', 'hungariandatum1972'], a: 6378160, towgs84: [52.17, -71.82, -14.9], accuracy: 1, bbox: [45.74, 16.11, 48.58, 22.9] },
  // EPSG:1641 TM65 and EPSG:1954 TM75 to WGS 84 (2)
  { names: ['tm65', 'tm75', 'geodeticdatumof1965'], a: 6377340.189, towgs84: [482.5, -130.6, 564.6, -1.042, -0.214, -0.631, 8.15], accuracy: 1, bbox: [51.39, -10.56, 55.43, -5.34] },
  // EPSG:1955 OSNI 1952 to WGS 84 (1)
  { names: ['osni1952'], a: 6377563.396, towgs84: [482.5, -130.6, 564.6, -1.042, -0.214, -0.631, 8.15], accuracy: 1, bbox: [53.96, -8.18, 55.36, -5.34] },
  // EPSG:1896 RT90 to WGS 84 (2)
  { names: ['rt1990', 'riketskoordinatsystem1990'], a: 6377397.155, towgs84: [414.1, 41.3, 603.1, -0.855, 2.141, -7.023, 0], accuracy: 1, bbox: [54.96, 10.03, 69.07, 24.17] },
  // EPSG:10099 KKJ to WGS 84 (2)
  { names: ['kkj', 'kartastokoordinaattijarjestelma1966'], a: 6378388, towgs84: [-96.062, -82.428, -121.753, 4.801, 0.345, -1.376, 1.496], accuracy: 1, bbox: [59.75, 19.24, 70.09, 31.59] },
  // EPSG:1654 NGO 1948 to WGS 84 (1)
  { names: ['ngo1948'], a: 6377492.018, towgs84: [278.3, 93, 474.5, 7.889, 0.05, -6.61, 6.21], accuracy: 3, bbox: [57.9, 4.39, 71.24, 31.32] },
  // EPSG:1564 NZGD49 to WGS 84 (2)
  { names: ['newzealand1949', 'newzealandgeodeticdatum1949'], a: 6378388, towgs84: [59.47, -5.04, 187.44, 0.47, -0.1, 1.024, -4.5993], accuracy: 4, bbox: [-47.65, 165.87, -33.89, 179.27] },
];

/** What a .prj says, as far as reprojecting it needs. */
interface PrjCrs {
  /** The horizontal CRS element (PROJCS, GEOGCS, PROJCRS, GEOGCRS...), out of any BOUNDCRS or compound. */
  root: WktNode;
  wkt2: boolean;
  projected: boolean;
  name: string;
  datum: string;
  /** Semi-major axis in metres and inverse flattening, NaN when the .prj gives none. */
  a: number;
  rf: number;
  /** A position-vector shift to WGS84 the file itself gives (TOWGS84, or a WKT2 BOUNDCRS), else null. */
  towgs84: number[] | null;
  pmName: string;
  /** The prime meridian's longitude in degrees, null when it is not Greenwich and not one the reader knows. */
  pmDegrees: number | null;
  /** The geographic angle unit in degrees: 1 for degrees, 0.9 for grads. */
  angleDegrees: number;
  /** For WKT2: every angle unit in the CRS is a degree (WKT1 is judged by angleDegrees). */
  allDegrees: boolean;
  metresPerUnit: number;
}

/** A WKT2 BOUNDCRS's abridged transformation as a position-vector towgs84, or null. */
function wkt2Helmert(t: WktNode): number[] | null {
  const method = fold(wktName(wktKid(t, 'METHOD')));
  if (!/translation|position vector|coordinate frame/.test(method)) return null;
  const find = (re: RegExp) => t.args.find((a): a is WktNode => isWktNode(a) && a.key === 'PARAMETER' && re.test(fold(wktName(a))));
  const param = (re: RegExp, unitKeys: string[], unitSize: number, fallback: number) => {
    const p = find(re);
    if (!p) return 0;
    const unit = wktNumbers(wktKid(p, ...unitKeys))[0] ?? fallback;
    return (wktNumbers(p)[0] ?? 0) * (unit / unitSize);
  };
  const shift = [/^x-axis translation/, /^y-axis translation/, /^z-axis translation/].map(re => param(re, ['LENGTHUNIT', 'UNIT'], 1, 1));
  if (/translations$|geocentric translation/.test(method) && !/rotation|position vector|coordinate frame/.test(method)) return shift;
  const sign = /coordinate frame/.test(method) ? -1 : 1;
  const rot = [/^x-axis rotation/, /^y-axis rotation/, /^z-axis rotation/].map(re => sign * param(re, ['ANGLEUNIT', 'UNIT'], ARC_SECOND, ARC_SECOND));
  // proj4 wants the scale difference in ppm. PROJ writes an abridged one as the
  // bare factor 1.0000067, others as ppm or with a SCALEUNIT: a value within 1 %
  // of 1 can only be the factor (no datum is 10,000 ppm off).
  const scale = find(/^scale difference/);
  const value = wktNumbers(scale)[0] ?? 0;
  const unit = wktNumbers(wktKid(scale, 'SCALEUNIT', 'UNIT'))[0];
  const ratio = unit === undefined ? value : value * unit;
  const ppm = Math.abs(ratio - 1) < 0.01 ? (ratio - 1) * 1e6 : unit === undefined ? value : ratio * 1e6;
  return [...shift, ...rot, ppm];
}

const HORIZONTAL_CRS: Record<string, { projected: boolean; wkt2: boolean }> = {
  PROJCS: { projected: true, wkt2: false }, GEOGCS: { projected: false, wkt2: false },
  PROJCRS: { projected: true, wkt2: true }, PROJECTEDCRS: { projected: true, wkt2: true },
  GEOGCRS: { projected: false, wkt2: true }, GEOGRAPHICCRS: { projected: false, wkt2: true },
  GEODCRS: { projected: false, wkt2: true }, GEODETICCRS: { projected: false, wkt2: true },
};

/** The parts of a parsed .prj that decide how to reproject it, or null for what is not a horizontal map CRS. */
function describePrj(tree: WktNode): PrjCrs | null {
  let root: WktNode | undefined = tree;
  let towgs84: number[] | null = null;
  if (root.key === 'COMPD_CS' || root.key === 'COMPOUNDCRS') {
    root = root.args.find((a): a is WktNode => isWktNode(a) && (a.key in HORIZONTAL_CRS || a.key === 'BOUNDCRS'));
  }
  if (root?.key === 'BOUNDCRS') {
    const transform = wktKid(root, 'ABRIDGEDTRANSFORMATION');
    towgs84 = transform ? wkt2Helmert(transform) : null;
    root = wktKid(root, 'SOURCECRS')?.args.find(isWktNode);
  }
  const kind = root && Object.hasOwn(HORIZONTAL_CRS, root.key) ? HORIZONTAL_CRS[root.key] : null;
  if (!root || !kind) return null;
  const geog = !kind.projected ? root : wktKid(root, kind.wkt2 ? 'BASEGEOGCRS' : 'GEOGCS', 'BASEGEODCRS');
  if (!geog) return null;
  if (kind.wkt2 && !kind.projected) {
    // A GEODCRS can be geocentric X/Y/Z, which is not a map at all.
    const cs = wktKid(root, 'CS')?.args[0];
    if (cs && !('w' in cs && /^ellipsoidal$/i.test(cs.w))) return null;
  }
  const datum = wktKid(geog, 'DATUM', 'GEODETICDATUM', 'TRF', 'ENSEMBLE');
  const ellipsoid = wktKid(datum, 'SPHEROID', 'ELLIPSOID');
  const [a = NaN, rf = NaN] = wktNumbers(ellipsoid);
  const aUnit = kind.wkt2 ? wktNumbers(wktKid(ellipsoid, 'LENGTHUNIT'))[0] ?? 1 : 1;
  if (!towgs84) {
    const t = wktNumbers(wktKid(datum, 'TOWGS84'));
    if (t.length === 3 || t.length === 7) towgs84 = t;
  }

  let angle: number;
  if (!kind.wkt2) {
    angle = wktNumbers(wktKid(geog, 'UNIT'))[0] ?? DEGREE;
  } else {
    const axis = wktFindAll(geog, ['AXIS']).map(x => wktKid(x, 'ANGLEUNIT', 'UNIT')).find(Boolean);
    angle = wktNumbers(wktKid(geog, 'ANGLEUNIT', 'UNIT') ?? axis)[0] ?? DEGREE;
  }
  const isDegree = (x: number) => Math.abs(x / DEGREE - 1) < 1e-9;
  // Snapped, so lon/lat in a .prj's "0.0174532925199433" degrees stay bit-identical.
  const angleDegrees = isDegree(angle) ? 1 : Math.abs(angle / DEGREE - 0.9) < 1e-9 ? 0.9 : angle / DEGREE;

  const pm = wktKid(geog, 'PRIMEM');
  const pmName = wktName(pm);
  const pmValue = wktNumbers(pm)[0] ?? 0;
  const pmKey = crsKey(pmName);
  let pmDegrees: number | null;
  if (pmValue === 0 || !pm) pmDegrees = 0;
  else if (Object.hasOwn(PRIME_MERIDIANS, pmKey)) pmDegrees = PRIME_MERIDIANS[pmKey];
  else if (kind.wkt2) pmDegrees = pmValue * ((wktNumbers(wktKid(pm, 'ANGLEUNIT'))[0] ?? DEGREE) / DEGREE);
  else pmDegrees = isDegree(angle) ? pmValue : null;

  let metresPerUnit = 1;
  if (kind.projected) {
    // WKT2 states the length unit on the CRS or on each of its own axes.
    const axisUnit = () => root!.args.filter((x): x is WktNode => isWktNode(x) && x.key === 'AXIS').map(x => wktKid(x, 'LENGTHUNIT')).find(Boolean);
    const unit = kind.wkt2 ? wktKid(root, 'LENGTHUNIT', 'UNIT') ?? axisUnit() : wktKid(root, 'UNIT');
    metresPerUnit = wktNumbers(unit)[0] ?? 1;
  }
  return {
    root,
    wkt2: kind.wkt2,
    projected: kind.projected,
    name: wktName(root),
    datum: wktName(datum),
    a: a * aUnit,
    rf,
    towgs84,
    pmName,
    pmDegrees,
    angleDegrees,
    allDegrees: wktFindAll(root, ['ANGLEUNIT']).every(u => isDegree(wktNumbers(u)[0] ?? DEGREE)) && isDegree(angle),
    metresPerUnit,
  };
}

const WGS84_DATUM = /^(wgs84|wgs1984|worldgeodeticsystem1984.*)$/;
/**
 * WGS84's and GRS80's ellipsoids. A datum on them that DATUM_SHIFTS does not
 * list and the .prj gives no shift for is taken as WGS84: true to a metre or
 * two of ETRS89, RGF93, NAD83, GDA94 and their kind, the datums modern
 * surveys use (GGRS87 and Israel 1993 are the listed exceptions).
 */
const geocentricEllipsoid = (a: number, rf: number) =>
  Math.abs(a - 6378137) < 0.5 && (Math.abs(rf - 298.257223563) < 1e-6 || Math.abs(rf - 298.257222101) < 1e-6);

/**
 * A PROJCS rewritten so proj4js does only the projection math, on the right
 * ellipsoid: its GEOGCS becomes Greenwich, degrees and a datum proj4js has no
 * shift for, and the angles of its parameters go from the datum's unit (grads
 * for the old French zones, which proj4js would read as degrees: 610 km off)
 * to degrees, with longitudes moved from the prime meridian to Greenwich.
 */
function canonicalProjcs(info: PrjCrs): string {
  const geogcs = `GEOGCS["base",DATUM["Unshifted",SPHEROID["base",${info.a},${info.rf}]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]`;
  const params = info.root.args.filter((a): a is WktNode => isWktNode(a) && a.key === 'PARAMETER').map(p => fold(wktName(p)));
  const args = info.root.args.map(arg => {
    if (!isWktNode(arg)) return wktText(arg);
    if (arg.key === 'GEOGCS') return geogcs;
    const v = wktNumbers(arg)[0];
    if (arg.key !== 'PARAMETER' || v === undefined) return wktText(arg);
    let name = wktName(arg);
    // ESRI's New Zealand Map Grid names its origin Longitude_Of_Origin, which
    // proj4js does not read (every vertex comes out NaN); Central_Meridian it does.
    if (fold(name) === 'longitude_of_origin' && !params.includes('central_meridian')) name = 'Central_Meridian';
    let value = v;
    if (/meridian|parallel|latitude|longitude|azimuth|angle/i.test(name)) value *= info.angleDegrees;
    if (/meridian|longitude/i.test(name)) value += info.pmDegrees ?? 0;
    return value === v && name === wktName(arg) ? wktText(arg) : `PARAMETER[${wktText({ s: name })},${value}]`;
  });
  return `${info.root.key}[${args.join(',')}]`;
}

/** lon/lat on a datum's ellipsoid to WGS84, by a position-vector towgs84. */
function datumShift(a: number, rf: number, towgs84: number[]): (lon: number, lat: number) => Pos {
  const conv = proj4(`+proj=longlat +a=${a} +rf=${rf} +towgs84=${towgs84.join(',')} +no_defs`, 'WGS84');
  return (lon, lat) => conv.forward([lon, lat]) as Pos;
}

/**
 * How a .prj's coordinates reach WGS84 longitude/latitude.
 *
 * proj4js alone is not trusted with a .prj: it drops a datum it does not know
 * (a Belgian Lambert 72 plot lands 170 m off without a word), ignores the prime
 * meridian and reads grads as degrees (a trial 600 km from where it was staked), and loses
 * the ellipsoid of a WKT2_2015 description. So the reader decides the datum
 * shift, the meridian and the angle unit itself, and hands proj4js only a
 * projection it can do. What it cannot do right, it refuses in words.
 */
function crsFromWkt(wkt: string, prjLabel: string): LayerCrs {
  const tree = parseWkt(wkt);
  const info = tree && describePrj(tree);
  const shownName = info?.name || wktName(tree ?? undefined) || 'the .prj coordinate system';
  const unreadable = (): never =>
    fail(`"${prjLabel}" describes a coordinate system the designer cannot read (${shownName}). Export the layer in WGS84 (EPSG:4326) and import it again.`);
  if (!info) return unreadable();

  const datumShown = info.datum.replace(/^D_/i, '').replace(/_/g, ' ').trim() || 'unnamed';
  const exportAgain = 'Export the layer in WGS84 (EPSG:4326), or in an ETRS89 system such as UTM, and import it again.';
  if (info.pmDegrees === null) {
    fail(`"${prjLabel}" measures longitude from the ${info.pmName} meridian, which the designer does not know. ${exportAgain}`);
  }
  const key = crsKey(info.datum);
  const wgs84Named = WGS84_DATUM.test(key);
  const stated = info.towgs84 && info.towgs84.some(v => v !== 0) ? info.towgs84 : null;
  // TOWGS84[0,0,0...] is the file saying its datum IS WGS84: believed, like any stated shift.
  const statedNone = !!info.towgs84 && !stated;
  const known = statedNone ? undefined : DATUM_SHIFTS.find(d => d.names.includes(key) && Math.abs(d.a - info.a) < 1);
  const shift = stated ?? known?.towgs84 ?? null;
  if (!shift && !statedNone && !wgs84Named && !geocentricEllipsoid(info.a, info.rf)) {
    fail(
      `"${prjLabel}" uses the ${datumShown} datum, and the designer does not know the shift from it to WGS84: without it the plots would land ` +
        `tens to hundreds of metres off. ${exportAgain}`,
    );
  }
  if (shift && !(info.a > 0 && info.rf >= 0)) return unreadable();

  const note = !shift ? undefined
    : stated ? `shifting the ${datumShown} datum by the parameters its .prj gives`
    : `shifting the ${datumShown} datum with its published transformation (accurate to about ${known!.accuracy} m)`;
  const area = !stated && known ? { datum: datumShown, bbox: known.bbox } : undefined;
  const toWgs84 = shift ? datumShift(info.a, info.rf, shift) : null;
  const plain = !shift && Math.abs(info.angleDegrees - 1) < 1e-9 && info.pmDegrees === 0 && info.allDegrees;

  if (!info.projected) {
    if (plain && wgs84Named) return { kind: 'lonlat', how: 'declared' };
    const k = info.angleDegrees, pm = info.pmDegrees!;
    return {
      kind: 'proj', name: shownName, raw: 'degrees', metresPerUnit: 1, area, note,
      forward: (x, y) => (toWgs84 ? toWgs84(x * k + pm, y * k) : [x * k + pm, y * k]),
    };
  }
  if (plain) {
    // A projection on WGS84 or GRS80 in degrees from Greenwich: proj4js reads
    // it right (and knows Web Mercator's sphere from the WGS84 datum's name).
    let conv: { forward: (p: number[]) => number[] };
    try {
      conv = proj4(wktText(info.root), 'WGS84');
    } catch {
      return unreadable();
    }
    return { kind: 'proj', name: shownName, raw: 'lengths', metresPerUnit: info.metresPerUnit, forward: (x, y) => conv.forward([x, y]) as Pos };
  }
  if (info.wkt2) {
    fail(
      `"${prjLabel}" describes ${shownName} in the WKT2 format, which the designer reads for systems on WGS84 or ETRS89 only. ` +
        `Save the .prj in the ESRI (WKT1) format, or export the layer in WGS84 (EPSG:4326), and import it again.`,
    );
  }
  let unproject: { forward: (p: number[]) => number[] };
  try {
    unproject = proj4(canonicalProjcs(info), `+proj=longlat +a=${info.a} +rf=${info.rf} +no_defs`);
  } catch {
    return unreadable();
  }
  return {
    kind: 'proj', name: shownName, raw: 'lengths', metresPerUnit: info.metresPerUnit, area, note,
    forward: (x, y) => {
      const [lon, lat] = unproject.forward([x, y]);
      return toWgs84 ? toWgs84(lon, lat) : [lon, lat];
    },
  };
}

/** One geometry per .shp record, in record order (the .dbf row with the same index is its attributes). */
function readShpGeometries(b: Bytes, label: string, warnings: string[]): RawGeom[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 100 || v.getInt32(0) !== 9994) fail(`"${label}" is not a valid shapefile (.shp).`);
  // The header's file length (in 16-bit words) is where the records end: bytes a
  // copy tool padded on after it are not shapes. A length past the data is not
  // believed.
  const declared = v.getInt32(24) * 2;
  const end = declared >= 100 && declared <= b.length ? declared : b.length;
  const out: RawGeom[] = [];
  let o = 100;
  while (o + 8 <= end) {
    const len = v.getInt32(o + 4) * 2; // big-endian, in 16-bit words
    const start = o + 8;
    if (len < 0 || start + len > end) {
      warnings.push(`"${label}" ends in the middle of a record; ${plural(out.length, 'shape')} could be read.`);
      break;
    }
    o = start + len;
    if (len < 4) { out.push({ kind: 'none' }); continue; }
    const type = v.getInt32(start, true);
    if (type === 0) out.push({ kind: 'none' });
    else if (type === 5 || type === 15 || type === 25) out.push(readShpPolygon(v, start, len));
    else out.push({ kind: 'other', type: SHAPE_TYPE_NAMES[type] ?? `shape type ${type}` });
  }
  return out;
}

/**
 * Polygon, PolygonZ and PolygonM share their first 44 bytes plus parts and XY
 * points; Z and M arrays follow and are ignored. Every part becomes its own
 * ring: the shapefile does not label outers and holes, winding does, and the
 * contract fills all rings even-odd so the labels are not needed.
 */
function readShpPolygon(v: DataView, start: number, len: number): RawGeom {
  const end = start + len;
  if (len < 44) return { kind: 'invalid' };
  const numParts = v.getInt32(start + 36, true);
  const numPoints = v.getInt32(start + 40, true);
  if (numParts === 0 || numPoints === 0) return { kind: 'polygons', polygons: [[]] };
  const pointsAt = start + 44 + 4 * numParts;
  if (numParts < 0 || numPoints < 0 || pointsAt + 16 * numPoints > end) return { kind: 'invalid' };
  const polygons: Pos[][][] = [];
  for (let k = 0; k < numParts; k++) {
    const from = v.getInt32(start + 44 + 4 * k, true);
    const to = k + 1 < numParts ? v.getInt32(start + 48 + 4 * k, true) : numPoints;
    if (from < 0 || to < from || to > numPoints) return { kind: 'invalid' };
    const ring: Pos[] = [];
    for (let i = from; i < to; i++) {
      const x = v.getFloat64(pointsAt + 16 * i, true);
      const y = v.getFloat64(pointsAt + 16 * i + 8, true);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { kind: 'invalid' };
      ring.push([x, y]);
    }
    polygons.push([ring]);
  }
  return { kind: 'polygons', polygons };
}

// ----- DBF -----

/** Where a field sits in a record: offset counts the deletion flag byte. */
interface DbfSlot {
  type: string;
  offset: number;
  len: number;
}

interface DbfField extends DbfSlot {
  name: string;
}

/** DBF language driver ids that name a code page a TextDecoder can read. */
const LDID_ENCODINGS: Record<number, string> = {
  0x03: 'windows-1252', 0x57: 'windows-1252', 0x58: 'windows-1252', 0x59: 'windows-1252',
  0x13: 'shift_jis', 0x4d: 'gbk', 0x4e: 'euc-kr', 0x4f: 'big5', 0x7b: 'shift_jis',
  0x64: 'ibm866', 0x65: 'ibm866', 0x66: 'ibm866', 0xc8: 'windows-1250', 0xc9: 'windows-1251', 0xca: 'windows-1254', 0xcb: 'windows-1253',
};

const decoderOk = (label: string): boolean => {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
};

/** A .cpg's content ("UTF-8", "1252", "ANSI 1252", "88591"...) as a TextDecoder label, or null. */
function cpgEncoding(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (t === 'utf8' || t === 'utf-8' || t === '65001') return 'utf-8';
  const iso = /^(?:iso[-_ ]?)?8859[-_ ]?(\d{1,2})$/.exec(t)?.[1];
  if (iso) return decoderOk(`iso-8859-${Number(iso)}`) ? `iso-8859-${Number(iso)}` : null;
  const num = /^(?:ansi\s*|cp\s*|windows-?|ibm\s*)?(\d+)$/.exec(t)?.[1];
  if (num) {
    const n = Number(num);
    if (n === 65001) return 'utf-8';
    if (n === 874 || (n >= 1250 && n <= 1258)) return `windows-${n}`;
    if (n >= 28591 && n <= 28606) return `iso-8859-${n - 28590}`;
    const cp: Record<number, string> = { 866: 'ibm866', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 20866: 'koi8-r' };
    return cp[n] ?? null;
  }
  return decoderOk(t) ? t : null;
}

/**
 * What some bytes say about UTF-8: any byte above ASCII at all, how many whole
 * multi-byte characters, and whether something UTF-8 cannot hold turned up.
 */
interface Utf8Evidence {
  high: boolean;
  whole: number;
  broken: boolean;
}

/**
 * Add [from, to) to the evidence. A character running past `to` is forgiven
 * as a cut (a writer truncating UTF-8 at the field width) when `cutAllowed`,
 * but never counts as a whole character: a Latin-1 "Rosé" filling a 4-byte
 * field ends in a lone 0xE9 that looks exactly like a cut "é".
 */
function scanUtf8(b: Bytes, from: number, to: number, ev: Utf8Evidence, cutAllowed: boolean): void {
  let i = from;
  while (i < to) {
    const c = b[i];
    if (c < 0x80) { i++; continue; }
    ev.high = true;
    const need = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : -1;
    if (need < 0) { ev.broken = true; return; }
    const end = Math.min(i + need, to - 1);
    for (let k = i + 1; k <= end; k++) if ((b[k] & 0xc0) !== 0x80) { ev.broken = true; return; }
    if (i + need >= to) {
      if (!cutAllowed) ev.broken = true;
      return;
    }
    ev.whole++;
    i += need + 1;
  }
}

/**
 * The DBF's text encoding, judged on the field NAMES as well as the text
 * values (a Latin-1 "Variété" column over plain ASCII values must not be read
 * as UTF-8, or the variety column is not found). A .cpg is trusted, except
 * that one claiming UTF-8 over bytes that cannot be UTF-8 is overruled (a
 * common mislabel). Without a .cpg, UTF-8 needs at least one whole multi-byte
 * character and nothing that breaks it; anything else is read as the code page
 * the header's language driver names, else Windows-1252, with a warning.
 */
function dbfEncoding(b: Bytes, names: Bytes[], fields: DbfSlot[], headerLen: number, recLen: number, nRec: number, cpgText: string | undefined, label: string, cpgLabel: string | undefined, warnings: string[]): string {
  const ev: Utf8Evidence = { high: false, whole: 0, broken: false };
  for (const name of names) {
    const end = name.indexOf(0);
    // A name fills 10 bytes (the 11th ends it) only when a writer cut it there.
    scanUtf8(name, 0, end < 0 ? name.length : end, ev, end < 0 || end >= 10);
  }
  for (let r = 0; r < nRec && !ev.broken; r++) {
    const row = headerLen + r * recLen;
    for (const f of fields) {
      if (f.type !== 'C') continue;
      const from = row + f.offset;
      scanUtf8(b, from, from + f.len, ev, true);
      if (ev.broken) break;
    }
  }
  const ascii = !ev.high;
  const valid = !ev.broken;
  const evident = valid && ev.whole > 0;
  const fallback = LDID_ENCODINGS[b[29]] && decoderOk(LDID_ENCODINGS[b[29]]) ? LDID_ENCODINGS[b[29]] : 'windows-1252';
  const fallbackName = fallback === 'windows-1252' ? 'Windows-1252 (Latin-1)' : fallback;

  if (cpgText !== undefined) {
    const enc = cpgEncoding(cpgText);
    if (enc && enc !== 'utf-8' && decoderOk(enc)) return enc;
    if (enc === 'utf-8') {
      if (valid) return 'utf-8';
      warnings.push(`"${cpgLabel}" says UTF-8 but the text in "${label}" is not UTF-8; it was read as ${fallbackName}.`);
      return fallback;
    }
    if (ascii) return 'utf-8';
    if (evident) {
      warnings.push(`"${cpgLabel}" names an encoding the designer does not know ("${cpgText.trim()}"); the text in "${label}" was read as UTF-8.`);
      return 'utf-8';
    }
    warnings.push(`"${cpgLabel}" names an encoding the designer does not know ("${cpgText.trim()}"); the text in "${label}" was read as ${fallbackName}.`);
    return fallback;
  }
  if (ascii || evident) return 'utf-8';
  warnings.push(`"${label}" has no .cpg file and its text is not UTF-8, so it was read as ${fallbackName}. If accents look wrong, include the .cpg file.`);
  return fallback;
}

/**
 * A DBF numeric field's text, tidied but not round-tripped through a double
 * where that would lose digits: "1.000000" is "1", "-0.50" is "-0.5", an
 * 18-digit id stays exact. Only a fraction longer than a double holds is
 * rounded, which is where writers leave binary noise.
 */
function tidyNumberText(raw: string): string {
  const t = raw.trim();
  if (!t || /^\*+$/.test(t)) return ''; // blank, or dBASE's overflow marker
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (m && (m[2] || m[3])) {
    const int = m[2].replace(/^0+(?=\d)/, '') || '0';
    const frac = (m[3] ?? '').replace(/0+$/, '');
    if (frac && (int + frac).replace(/^0+/, '').length > 15) return formatNumber(Number(t));
    const body = frac ? `${int}.${frac}` : int;
    return m[1] === '-' && /[1-9]/.test(body) ? `-${body}` : body;
  }
  const n = Number(t);
  return Number.isFinite(n) ? formatNumber(n) : t;
}

function readDbf(b: Bytes, cpgText: string | undefined, label: string, cpgLabel: string | undefined, warnings: string[]): { columns: string[]; rows: (Record<string, string> | null)[] } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 33) fail(`"${label}" is not a valid .dbf attribute table.`);
  const declared = v.getUint32(4, true);
  let headerLen = v.getUint16(8, true);
  const recLen = v.getUint16(10, true);

  const rawFields: { nameBytes: Bytes; type: string; len: number }[] = [];
  // Descriptors end at the 0x0D terminator, or where the header says it ends
  // when a writer forgot the terminator (a header too short to hold even one
  // field is not believed).
  const descriptorsEnd = headerLen >= 65 ? Math.min(b.length, headerLen - 1) : b.length;
  for (let at = 32; at + 32 <= descriptorsEnd && b[at] !== 0x0d; at += 32) {
    const nameBytes = b.subarray(at, at + 11);
    const type = String.fromCharCode(b[at + 11]).toUpperCase();
    // Character fields wider than 255 keep the high byte where decimals would be (GDAL reads them so).
    const len = type === 'C' ? b[at + 16] + 256 * b[at + 17] : b[at + 16];
    rawFields.push({ nameBytes, type, len });
  }
  const minHeader = 32 + 32 * rawFields.length + 1;
  if (headerLen < minHeader) headerLen = minHeader;
  let offset = 1; // the deletion flag
  const slots: DbfSlot[] = rawFields.map(f => {
    const slot = { type: f.type, offset, len: f.len };
    offset += f.len;
    return slot;
  });
  if (!rawFields.length || recLen < offset) fail(`"${label}" is not a valid .dbf attribute table.`);

  const available = Math.max(0, Math.floor((b.length - headerLen) / recLen));
  const nRec = Math.min(declared, available);
  if (nRec < declared) warnings.push(`"${label}" is cut short: ${plural(nRec, 'row')} of ${declared.toLocaleString('en-US')} could be read.`);

  const encoding = dbfEncoding(b, rawFields.map(f => f.nameBytes), slots, headerLen, recLen, nRec, cpgText, label, cpgLabel, warnings);
  const dec = new TextDecoder(encoding);
  const text = (from: number, to: number) => dec.decode(b.subarray(from, to)).replace(/\0/g, '').replace(/\uFFFD+$/, '').trim();

  const cols = new Columns();
  const fields: DbfField[] = rawFields.map((f, i) => {
    const end = f.nameBytes.indexOf(0);
    const name = dec.decode(f.nameBytes.subarray(0, end < 0 ? 11 : end)).trim();
    return { ...slots[i], name: cols.add(String(i), name || `field_${i + 1}`) };
  });

  const rows: (Record<string, string> | null)[] = [];
  for (let r = 0; r < nRec; r++) {
    const row = headerLen + r * recLen;
    if (b[row] === 0x2a) { rows.push(null); continue; }
    const props: Record<string, string> = {};
    for (const f of fields) props[f.name] = dbfValue(v, b, row + f.offset, f, text);
    rows.push(props);
  }
  return { columns: cols.names, rows };
}

function dbfValue(v: DataView, b: Bytes, at: number, f: DbfField, text: (from: number, to: number) => string): string {
  switch (f.type) {
    case 'N':
    case 'F':
      return tidyNumberText(text(at, at + f.len));
    case 'D': {
      const t = text(at, at + f.len);
      if (!t || /^0+$/.test(t)) return '';
      return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t;
    }
    case 'L': {
      const c = String.fromCharCode(b[at]).toLowerCase();
      return c === 't' || c === 'y' ? 'true' : c === 'f' || c === 'n' ? 'false' : '';
    }
    case 'I':
    case '+':
      return f.len === 4 ? String(v.getInt32(at, true)) : text(at, at + f.len);
    case 'O':
    case 'B':
      return f.len === 8 ? formatNumber(v.getFloat64(at, true)) : '';
    case 'Y':
      if (f.len !== 8) return text(at, at + f.len);
      return tidyNumberText((() => {
        const raw = v.getBigInt64(at, true);
        const neg = raw < 0n;
        const abs = (neg ? -raw : raw).toString().padStart(5, '0');
        return `${neg ? '-' : ''}${abs.slice(0, -4)}.${abs.slice(-4)}`;
      })());
    case 'T':
    case '@': {
      if (f.len !== 8) return text(at, at + f.len);
      const day = v.getInt32(at, true);
      if (!day) return '';
      const ms = (day - 2440588) * 86400000 + v.getInt32(at + 4, true);
      const d = new Date(ms);
      return Number.isFinite(d.getTime()) ? d.toISOString() : '';
    }
    case 'M':
    case 'G':
    case 'P':
      return ''; // a pointer into a .dbt memo file the upload does not carry
    default:
      return text(at, at + f.len);
  }
}

// ===== GeoJSON =================================================================

const L93_DEF = '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

/**
 * The EPSG codes a legacy GeoJSON "crs" member may name that the designer can
 * reproject, as proj4 definitions. Built here, not registered with proj4.defs,
 * so importing a file never changes the projections the rest of the app sees.
 */
function epsgDefinition(code: number): { def: string } | { lonlat: string } | null {
  if (code === 4326) return { lonlat: '' };
  // ETRS89 and RGF93 are fixed to Europe and drift from WGS84 by under a metre;
  // proj4 itself treats them as identical, so the reader says so and moves on.
  if (code === 4258 || code === 4171) return { lonlat: `EPSG:${code} was read as WGS84 (the two differ by about a metre).` };
  if (code === 3857 || code === 900913 || code === 3785 || code === 102100 || code === 102113) return { def: 'EPSG:3857' };
  if (code === 2154) return { def: L93_DEF };
  if (code >= 32601 && code <= 32660) return { def: `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs` };
  if (code >= 32701 && code <= 32760) return { def: `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs` };
  if (code >= 25828 && code <= 25838) return { def: `+proj=utm +zone=${code - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs` };
  return null;
}

function geoJsonCrs(crs: unknown, label: string, warnings: string[]): LayerCrs {
  if (crs === undefined || crs === null) return { kind: 'lonlat', how: 'assumed' };
  const c = crs as { type?: unknown; properties?: Record<string, unknown> };
  const p = c.properties ?? {};
  let name = '';
  if (typeof p.name === 'string') name = p.name.trim();
  else if (p.code !== undefined && /^\d+$/.test(String(p.code))) name = `EPSG:${p.code}`;
  if (!name) {
    return fail(`"${label}" declares its coordinate system in a form the designer cannot read. GeoJSON should be in WGS84 (EPSG:4326): export it again that way.`);
  }
  if (/CRS:?84$/i.test(name)) return { kind: 'lonlat', how: 'declared' };
  const code = /epsg.*?(\d+)\s*$/i.exec(name)?.[1];
  const known = code ? epsgDefinition(Number(code)) : null;
  if (!known) {
    return fail(`"${label}" is in the coordinate system "${name}", which the designer cannot reproject. Export it in WGS84 (EPSG:4326) and import it again.`);
  }
  if ('lonlat' in known) {
    if (known.lonlat) warnings.push(`"${label}": ${known.lonlat}`);
    return { kind: 'lonlat', how: 'declared' };
  }
  const conv = proj4(known.def, 'WGS84');
  const shown = `EPSG:${code}`;
  warnings.push(`Reprojected "${label}" from ${shown} (its "crs" member) to WGS84 longitude/latitude.`);
  return { kind: 'proj', name: shown, raw: 'lengths', metresPerUnit: 1, forward: (x, y) => conv.forward([x, y]) as Pos };
}

const isPosition = (p: unknown): p is number[] =>
  Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** A GeoJSON Polygon's coordinates as [outer, ...holes], or null when malformed. */
function geoJsonPolygon(coords: unknown): Pos[][] | null {
  if (!Array.isArray(coords)) return null;
  const rings: Pos[][] = [];
  for (const ring of coords) {
    if (!Array.isArray(ring)) return null;
    const out: Pos[] = [];
    for (const p of ring) {
      if (!isPosition(p)) return null;
      out.push([p[0], p[1]]);
    }
    rings.push(out);
  }
  return rings;
}

function geoJsonGeometry(g: unknown): RawGeom {
  if (g === null || g === undefined) return { kind: 'none' };
  if (typeof g !== 'object') return { kind: 'invalid' };
  const geom = g as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (geom.type === 'Polygon') {
    const poly = geoJsonPolygon(geom.coordinates);
    return poly ? { kind: 'polygons', polygons: [poly] } : { kind: 'invalid' };
  }
  if (geom.type === 'MultiPolygon') {
    if (!Array.isArray(geom.coordinates)) return { kind: 'invalid' };
    const polygons: Pos[][][] = [];
    for (const c of geom.coordinates) {
      const poly = geoJsonPolygon(c);
      if (!poly) return { kind: 'invalid' };
      polygons.push(poly);
    }
    return { kind: 'polygons', polygons };
  }
  if (geom.type === 'GeometryCollection') {
    if (!Array.isArray(geom.geometries)) return { kind: 'invalid' };
    const polygons: Pos[][][] = [];
    for (const member of geom.geometries) {
      const m = geoJsonGeometry(member);
      if (m.kind === 'invalid') return m;
      if (m.kind === 'polygons') polygons.push(...m.polygons);
    }
    return polygons.length ? { kind: 'polygons', polygons } : { kind: 'other', type: 'GeometryCollection' };
  }
  return { kind: 'other', type: typeof geom.type === 'string' ? geom.type : 'unknown geometry' };
}

const GEOMETRY_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);

function readGeoJsonLayer(entry: Entry): ReadLayer {
  const label = entry.path;
  let root: unknown;
  try {
    root = JSON.parse(utf8.decode(entry.bytes));
  } catch (e) {
    return fail(`"${label}" is not valid JSON (${(e as Error).message}).`);
  }
  const r = (root ?? {}) as { type?: unknown; features?: unknown; crs?: unknown };
  let raw: { geometry: unknown; properties: unknown }[];
  if (r.type === 'FeatureCollection' && Array.isArray(r.features)) {
    raw = r.features.map(f => (f && typeof f === 'object' ? (f as { geometry: unknown; properties: unknown }) : { geometry: null, properties: null }));
  } else if (r.type === 'Feature') {
    raw = [r as { geometry: unknown; properties: unknown }];
  } else if (typeof r.type === 'string' && GEOMETRY_TYPES.has(r.type)) {
    raw = [{ geometry: r, properties: null }];
  } else if (r.type === 'Topology') {
    return fail(`"${label}" is TopoJSON, which the designer does not read. Convert it to GeoJSON or a shapefile first.`);
  } else {
    return fail(`"${label}" is not GeoJSON: it needs a FeatureCollection, a Feature or a geometry at its top level.`);
  }

  const warnings: string[] = [];
  const crs = geoJsonCrs(r.crs, label, warnings);
  const cols = new Columns();
  const features: RawFeature[] = raw.map(f => {
    const props: Record<string, string> = {};
    if (f.properties && typeof f.properties === 'object' && !Array.isArray(f.properties)) {
      for (const [k, val] of Object.entries(f.properties as Record<string, unknown>)) props[cols.add(k, k)] = stringify(val);
    }
    return { geom: geoJsonGeometry(f.geometry), props };
  });
  const hint = crs.kind === 'lonlat' && crs.how === 'declared'
    ? 'Its "crs" member says longitude/latitude, but the numbers are not: export the file again in WGS84 (EPSG:4326).'
    : 'GeoJSON must be in WGS84 (EPSG:4326): export it again in that system, or give it a "crs" member naming its EPSG code.';
  return finishLayer(label, entry.source, cols.names, features, crs, warnings, hint);
}

// ===== KML / KMZ ===============================================================

interface XmlNode {
  /** Local name: namespace prefixes are dropped ("kml:Placemark" is "Placemark"). */
  name: string;
  attrs: Record<string, string>;
  kids: XmlNode[];
  /** Direct text content, entities decoded, CDATA kept verbatim. */
  text: string;
}

const XML_ENTITIES = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"], ['nbsp', '\u00a0']]);

const decodeEntities = (t: string): string =>
  t.indexOf('&') < 0
    ? t
    : t.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, e: string) => {
        if (e[0] !== '#') return XML_ENTITIES.get(e) ?? whole;
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
      });

const localName = (qname: string): string => qname.slice(qname.indexOf(':') + 1);

/**
 * A small, forgiving XML reader: enough for KML without DOMParser (absent under
 * node and in workers). Comments, processing instructions and DOCTYPE are
 * skipped; a close tag closes the nearest open element of its name, so an
 * unclosed tag (say an HTML <br> in a description) cannot unbalance the rest.
 */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, kids: [], text: '' };
  const stack: XmlNode[] = [root];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      top.text += src.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      let j = lt + 2;
      for (let depth = 0; j < n; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    let j = lt + 1;
    for (let quote = ''; j < n; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= n) break; // an unterminated tag ends the document
    const body = src.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === '/') {
      const name = localName(body.slice(1).trim());
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const tag = /^([^\s/>]+)/.exec(inner);
    if (!tag) {
      top.text += decodeEntities(`<${body}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of inner.slice(tag[1].length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[localName(a[1])] = decodeEntities(a[2] ?? a[3] ?? '');
    }
    const el: XmlNode = { name: localName(tag[1]), attrs, kids: [], text: '' };
    top.kids.push(el);
    if (!selfClosing) stack.push(el);
  }
  return root;
}

const kid = (el: XmlNode, name: string) => el.kids.find(k => k.name === name);
const kidsNamed = (el: XmlNode, name: string) => el.kids.filter(k => k.name === name);

function descendants(el: XmlNode, name: string, out: XmlNode[] = [], stopAt?: string): XmlNode[] {
  for (const k of el.kids) {
    if (k.name === name) out.push(k);
    else if (k.name !== stopAt) descendants(k, name, out, stopAt);
  }
  return out;
}

/**
 * Bytes of a KML as text: a byte order mark first (it is written by the tool
 * that encoded the bytes, while a declaration is often copied from a template),
 * then the XML declaration's encoding, else UTF-8.
 */
function decodeXmlBytes(b: Bytes): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return utf8.decode(b);
  let head = '';
  for (let i = 0; i < Math.min(b.length, 200); i++) head += String.fromCharCode(b[i]);
  const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];
  if (declared && decoderOk(declared)) return new TextDecoder(declared).decode(b);
  return utf8.decode(b);
}

/** A KML <coordinates> text as XY positions, or null when a tuple is not two finite numbers. */
function kmlCoordinates(text: string): Pos[] | null {
  const tuples = text.trim().replace(/\s*,\s*/g, ',').split(/\s+/).filter(Boolean);
  const out: Pos[] = [];
  for (const t of tuples) {
    const parts = t.split(',');
    if (parts.length < 2 || parts[0] === '' || parts[1] === '') return null;
    const x = Number(parts[0]), y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([x, y]);
  }
  return out;
}

const KML_GEOMETRIES = new Set(['Point', 'LineString', 'LinearRing', 'Polygon', 'MultiGeometry', 'Model', 'Track', 'MultiTrack']);

function kmlGeometry(placemark: XmlNode): RawGeom {
  const polygons: Pos[][][] = [];
  const others: string[] = [];
  let invalid = false;
  const visit = (el: XmlNode) => {
    if (el.name === 'MultiGeometry') {
      for (const k of el.kids) if (KML_GEOMETRIES.has(k.name)) visit(k);
      return;
    }
    if (el.name !== 'Polygon') {
      others.push(el.name === 'Track' || el.name === 'MultiTrack' ? `gx:${el.name}` : el.name);
      return;
    }
    const outer = kid(el, 'outerBoundaryIs');
    const outerCoords = outer ? descendants(outer, 'coordinates')[0] : undefined;
    if (!outerCoords) {
      polygons.push([]);
      return;
    }
    const rings: Pos[][] = [];
    for (const c of [outerCoords, ...kidsNamed(el, 'innerBoundaryIs').flatMap(inner => descendants(inner, 'coordinates'))]) {
      const ring = kmlCoordinates(c.text);
      if (!ring) {
        invalid = true;
        return;
      }
      rings.push(ring);
    }
    polygons.push(rings);
  };
  for (const k of placemark.kids) if (KML_GEOMETRIES.has(k.name)) visit(k);
  if (invalid) return { kind: 'invalid' };
  if (polygons.length) return { kind: 'polygons', polygons };
  if (others.length) return { kind: 'other', type: others[0] };
  return { kind: 'none' };
}

function readKmlLayer(entry: Entry): ReadLayer {
  const label = entry.path;
  const doc = parseXml(decodeXmlBytes(entry.bytes));
  const placemarks = descendants(doc, 'Placemark', [], 'Placemark');
  if (!placemarks.length) {
    if (descendants(doc, 'NetworkLink').length) {
      throw new LinksOnly(`"${label}" holds no placemarks, only links to other files (NetworkLink), which the designer does not follow.`);
    }
    fail(`"${label}" holds no placemarks, so no plot polygons.`);
  }

  const cols = new Columns();
  const features: RawFeature[] = placemarks.map(pm => {
    const props: Record<string, string> = {};
    const name = kid(pm, 'name');
    if (name) props[cols.add('element:name', 'name')] = name.text.trim();
    const description = kid(pm, 'description');
    if (description) props[cols.add('element:description', 'description')] = description.text.trim();
    const extended = kid(pm, 'ExtendedData');
    if (extended) {
      // Data (untyped) and SchemaData/SimpleData (typed) are two spellings of one attribute.
      const walk = (el: XmlNode) => {
        for (const k of el.kids) {
          if (k.name === 'Data' && k.attrs.name !== undefined) {
            props[cols.add(`data:${k.attrs.name}`, k.attrs.name)] = (kid(k, 'value')?.text ?? '').trim();
          } else if (k.name === 'SimpleData' && k.attrs.name !== undefined) {
            props[cols.add(`data:${k.attrs.name}`, k.attrs.name)] = k.text.trim();
          } else if (k.name === 'SchemaData') {
            walk(k);
          }
        }
      };
      walk(extended);
    }
    return { geom: kmlGeometry(pm), props };
  });
  const hint = 'KML coordinates must be longitude,latitude in WGS84.';
  return finishLayer(label, entry.source, cols.names, features, { kind: 'lonlat', how: 'declared' }, [], hint);
}

// ===== column detection ========================================================

/** Lower case, accents stripped: "Variété" and "VARIETE" compare equal. */
const fold = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** A column name's words: camelCase, snake_case and punctuation all split. */
const nameTokens = (col: string): string[] =>
  fold(col.replace(/([a-z0-9])([A-Z])/g, '$1 $2')).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Words that name the varieties, most telling first. Long stems match anywhere
 * in the name ("NomVariete", "Genotypes"); the short English words (entry, line,
 * clone) must be a whole word of it, so "baseline" is not read as "line"; and
 * the abbreviation "var" only counts as the column's whole name ("Var",
 * "var_name"), never inside "var_yield" or "variable".
 */
const VARIETY_WORDS = ['germplasm', 'variet', 'genotyp', 'cultivar', 'accession', 'entry', 'treatment', 'traitement', 'modalit', 'hybrid', 'line', 'lignee', 'clone', 'var'];
const SHORT_VARIETY_WORDS: Record<string, (tokens: string[]) => boolean> = {
  entry: t => t.includes('entry') || t.includes('entries'),
  line: t => t.includes('line') || t.includes('lines'),
  clone: t => t.includes('clone') || t.includes('clones'),
  var: t => (t.includes('var') || t.includes('vars')) && t.every(w => ['var', 'vars', 'name', 'nom', 'code'].includes(w)),
};
/**
 * Treatment words name the FACTOR a plot received (a nitrogen rate, an
 * irrigation regime), which is the variety only when nothing better is there:
 * a trial's "Variété" wins over its "Modalité" even when every plot has its
 * own variety, because each variety is its own species.
 */
const TREATMENT_WORDS = new Set(['treatment', 'traitement', 'modalit']);

/** Index of the variety word a column name carries, or -1. */
export function varietyWordRank(col: string): number {
  const flat = fold(col).replace(/[^a-z0-9]/g, '');
  const tokens = nameTokens(col);
  return VARIETY_WORDS.findIndex(w => (SHORT_VARIETY_WORDS[w] ? SHORT_VARIETY_WORDS[w](tokens) : flat.includes(w)));
}

const distinctValues = (d: DesignLike, col: string): Set<string> => {
  const s = new Set<string>();
  for (const p of d.plots) s.add(cell(p.props, col));
  return s;
};

/**
 * The column naming the varieties, or '' when none does.
 *
 *   1. A column named like a variety (germplasm, variety/variete, genotype,
 *      cultivar, accession, entry, treatment/traitement, modalite, hybrid,
 *      line/lignee, clone, var; case and accents ignored) that is not entirely
 *      empty. Among several: a variety word before a treatment word
 *      (treatment, traitement, modalite); then values that repeat without
 *      being constant, then all-distinct, then constant; ties by the word
 *      order above, then column order.
 *   2. Else the non-constant column with repeats whose distinct count is
 *      largest (ties: column order).
 *   3. Else the column with the most distinct values, when that is at least 2.
 *   4. Else ''.
 *
 * Only columns with at most MAX_IMPORT_VARIETIES distinct values qualify, so a
 * guess can always be simulated. A column holding one value everywhere is only
 * taken when its NAME says variety: an unnamed constant (an id left at 0, a
 * layer tag) says nothing about the plots, and '' tells them apart instead.
 *
 * '' means "no variety column": every plot is its own variety (see
 * assignVarieties).
 */
export function detectVarietyColumn(d: DesignLike): string {
  const n = d.plots.length;
  if (!n) return '';
  const stats = d.columns.map((col, i) => {
    const values = distinctValues(d, col);
    return { col, i, distinct: values.size, allEmpty: values.size === 1 && values.has(''), word: varietyWordRank(col) };
  });
  const fits = stats.filter(s => s.distinct <= MAX_IMPORT_VARIETIES);
  const repeats = (s: { distinct: number }) => s.distinct >= 2 && s.distinct < n;
  const shape = (s: { distinct: number }) => (repeats(s) ? 0 : s.distinct >= 2 ? 1 : 2);

  const tier = (s: { word: number }) => (TREATMENT_WORDS.has(VARIETY_WORDS[s.word]) ? 1 : 0);
  const named = fits.filter(s => s.word >= 0 && !s.allEmpty).sort((a, b) => tier(a) - tier(b) || shape(a) - shape(b) || a.word - b.word || a.i - b.i);
  if (named.length) return named[0].col;
  const repeating = fits.filter(repeats).sort((a, b) => b.distinct - a.distinct || a.i - b.i);
  if (repeating.length) return repeating[0].col;
  const varied = fits.filter(s => s.distinct >= 2).sort((a, b) => b.distinct - a.distinct || a.i - b.i);
  return varied.length ? varied[0].col : '';
}

const NAME_WORDS = ['name', 'nom', 'plot', 'parcel', 'parcelle', 'plotid', 'id', 'code', 'label'];

/**
 * The column naming each plot, or '' to number them. A column is usable when
 * every plot has a non-empty value and no two share one. Preferred: a name
 * that IS one of name, nom, plot, parcel, parcelle, plot_id, id, code, label
 * (case, accents and separators ignored), then one containing such a word
 * ("plot_name"), in that word order; else the first usable column.
 */
export function detectNameColumn(d: DesignLike): string {
  const n = d.plots.length;
  if (!n) return '';
  const unique = d.columns.filter(col => {
    const seen = new Set<string>();
    for (const p of d.plots) {
      const v = cell(p.props, col);
      if (!v || seen.has(v)) return false;
      seen.add(v);
    }
    return true;
  });
  const score = (col: string): number => {
    const flat = fold(col).replace(/[^a-z0-9]/g, '');
    const exact = NAME_WORDS.indexOf(flat);
    if (exact >= 0) return exact;
    const tokens = nameTokens(col);
    const inner = NAME_WORDS.findIndex(w => tokens.includes(w));
    return inner >= 0 ? NAME_WORDS.length + inner : Infinity;
  };
  const named = unique.map((col, i) => ({ col, i, s: score(col) })).filter(c => c.s < Infinity).sort((a, b) => a.s - b.s || a.i - b.i);
  if (named.length) return named[0].col;
  return unique[0] ?? '';
}

// ===== varieties ===============================================================

export const NO_VARIETY_LABEL = '(no variety)';

const tidyText = (s: string): string => s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

const decodeSegment = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * A readable label for a variety value.
 *
 *   - Empty: "(no variety)".
 *   - A URL whose host has no dot is a namespace, not a website
 *     (http://Species_name/NAME/BREEDER): the first path segment is the
 *     variety, "NAME".
 *   - Any other URL: its last non-empty path segment, with a web extension and a
 *     leading numeric id and separator stripped ("1012345-sy-example" is
 *     "sy-example"). A lowercase slug is then made readable: hyphens become
 *     spaces, words get a capital, and a first word of two or three letters
 *     (a breeder prefix such as sy, lg, kws) is upper-cased: "SY Example".
 *     Segments that already carry capitals keep their spelling.
 *   - Everywhere: percent-escapes decoded, underscores become spaces, runs of
 *     whitespace collapse, ends trimmed.
 *
 * Labels are for display and may collide; the key stays the identity.
 */
export function varietyLabel(value: string): string {
  const v = value.trim();
  if (!v) return NO_VARIETY_LABEL;
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(v);
  if (!url) return tidyText(v) || v;
  const host = url[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  const segments = url[2].split('/').map(decodeSegment).filter(s => s.trim());
  let label: string;
  if (!host.includes('.')) {
    label = segments[0] ?? host;
  } else if (segments.length) {
    let seg = segments[segments.length - 1].replace(/\.(html?|php|aspx?|jsp)$/i, '');
    const stripped = seg.replace(/^\d+[-_.\s]+(?=\S)/, '');
    if (stripped) seg = stripped;
    if (!/[A-Z]/.test(seg) && /[a-z]/.test(seg)) {
      const words = seg.split(/[-_\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1));
      if (words.length > 1 && /^[A-Za-z]{2,3}$/.test(words[0])) words[0] = words[0].toUpperCase();
      seg = words.join(' ');
    }
    label = seg;
  } else {
    label = host;
  }
  return tidyText(label) || v;
}

type CropId = 'maize' | 'wheat' | 'soy' | 'beet' | 'grass';
/** CROP_PRESETS order (simulate.ts), which also breaks ties. */
const CROP_ORDER: CropId[] = ['maize', 'wheat', 'soy', 'beet', 'grass'];
const CROP_WORDS: Record<CropId, (t: string, prev: string) => boolean> = {
  maize: t => t === 'zea' || t === 'maize' || t === 'mais' || t === 'maiz' || t === 'corn',
  wheat: t => t.startsWith('tritic') || t === 'wheat' || t === 'ble' || t === 'bles' || t === 'froment',
  soy: t => t === 'glycine' || t === 'soy' || t === 'soja' || t === 'soya' || t === 'soybean' || t === 'soybeans',
  // "beta" alone is too common a word; the species name is two.
  beet: (t, prev) => t === 'beet' || t === 'beets' || t === 'sugarbeet' || t.startsWith('betterave') || (t === 'vulgaris' && prev === 'beta'),
  grass: t => t === 'grass' || t === 'grasses' || t === 'grassland' || t === 'ryegrass' || t === 'alfalfa' || t === 'luzerne' ||
    t === 'medicago' || t === 'lolium' || t === 'festuca' || t === 'prairie' || t === 'prairies',
};

/** Count the crop words of ONE attribute value into `hits`. */
function addCropHits(value: string, hits: Map<CropId, number>): void {
  const raw = value.normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens = raw.map(fold);
  tokens.forEach((t, i) => {
    // Unaccented "mais" is also French for "but" (a comment such as "levée
    // hétérogène mais correcte" would make a wheat variety maize): it names the
    // crop only with its diaeresis ("maïs"), or leading a short label ("MAIS",
    // "Mais grain", "MAIS ENSILAGE 2025").
    if (t === 'mais' && !/[ïÏ]/.test(raw[i]) && (i > 0 || tokens.length > 3)) return;
    for (const crop of CROP_ORDER) if (CROP_WORDS[crop](t, tokens[i - 1] ?? '')) hits.set(crop, (hits.get(crop) ?? 0) + 1);
  });
}

/**
 * The CROP_PRESETS id a text points at ('' when none): Triticum/wheat/ble/froment
 * is wheat, Zea/maize/maïs/corn maize, Glycine/soy/soja soy, Beta vulgaris/beet/
 * betterave beet, grass/alfalfa/luzerne/Medicago/Lolium/Festuca/prairie grass.
 * Whole words only (after folding case and accents, with URLs and underscores
 * split), so "table" is not "ble"; "mais" without its diaeresis only as the
 * head of a short label. The crop named most often wins.
 */
export function detectCrop(text: string): string {
  const hits = new Map<CropId, number>();
  addCropHits(text, hits);
  return bestCrop(hits);
}

function bestCrop(hits: Map<CropId, number>): string {
  let best = '';
  let bestHits = 0;
  for (const crop of CROP_ORDER) {
    const h = hits.get(crop) ?? 0;
    if (h > bestHits) {
      best = crop;
      bestHits = h;
    }
  }
  return best;
}

const mostCommon = (values: string[]): string => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = '';
  let bestN = 0;
  for (const crop of CROP_ORDER) {
    const c = counts.get(crop) ?? 0;
    if (c > bestN) {
      best = crop;
      bestN = c;
    }
  }
  return best;
};

/**
 * The variety key of plot `index`. With a variety column, its raw value ('' for
 * a missing or unknown column, which groups those plots as "(no variety)").
 * Without one (varietyColumn ''), every plot is its own variety keyed "plot 1",
 * "plot 2"... by its position, so keys never collide with each other. The
 * spelling is the one imported-plan.ts's own varietyKeyOf builds: the resolver
 * looks each plot's key up in this list, so the two must agree.
 */
export function varietyKeyOf(design: Pick<ImportedDesign, 'plots' | 'varietyColumn'>, index: number): string {
  return design.varietyColumn ? cell(design.plots[index].props, design.varietyColumn) : `plot ${index + 1}`;
}

/**
 * The design's varieties in order of first appearance, and for each plot the
 * index of its variety in that list (the species it grows). Use this rather
 * than re-deriving keys, so '' means the same thing everywhere.
 *
 * crop: the key's crop words, else the crop most named across the variety's own
 * plots' attributes, else the crop most named across all plots of the design,
 * else 'default'.
 */
export function assignVarieties(design: ImportedDesign): { varieties: ImportedVariety[]; species: number[] } {
  const varieties: ImportedVariety[] = [];
  const members: number[][] = [];
  const index = new Map<string, number>();
  const species = design.plots.map((plot, i) => {
    const key = varietyKeyOf(design, i);
    let s = index.get(key);
    if (s === undefined) {
      s = varieties.length;
      index.set(key, s);
      const own = design.varietyColumn
        ? varietyLabel(key)
        : (design.nameColumn && cell(plot.props, design.nameColumn).trim()) || `Plot ${i + 1}`;
      varieties.push({ key, label: own, plots: 0, crop: '' });
      members.push([]);
    }
    varieties[s].plots++;
    members[s].push(i);
    return s;
  });

  // Plot attributes are only folded and scanned when some key names no crop.
  let plotCrops: string[] | null = null;
  const cropOfPlot = (i: number) => {
    // Value by value, so the "short label" rule for "mais" sees one value at a time.
    plotCrops ??= design.plots.map(p => {
      const hits = new Map<CropId, number>();
      for (const c of design.columns) addCropHits(cell(p.props, c), hits);
      return bestCrop(hits);
    });
    return plotCrops[i];
  };
  let designCrop: string | null = null;
  varieties.forEach((v, s) => {
    v.crop = (design.varietyColumn ? detectCrop(v.key) : '') ||
      mostCommon(members[s].map(cropOfPlot)) ||
      (designCrop ??= mostCommon(design.plots.map((_, i) => cropOfPlot(i)))) ||
      'default';
  });
  return { varieties, species };
}

/** The design's varieties (species), in order of first appearance. */
export function varietiesOf(design: ImportedDesign): ImportedVariety[] {
  return assignVarieties(design).varieties;
}

/**
 * Why the design's current variety column cannot be simulated, or '' when it
 * can. For the page to show after the user picks another column, since
 * varietiesOf itself never throws.
 */
export function tooManyVarieties(design: ImportedDesign): string {
  const count = design.varietyColumn ? distinctValues(design, design.varietyColumn).size : design.plots.length;
  if (count <= MAX_IMPORT_VARIETIES) return '';
  return design.varietyColumn
    ? `"${design.varietyColumn}" has ${count.toLocaleString('en-US')} distinct values; at most ${MAX_IMPORT_VARIETIES} varieties can be simulated.`
    : `Without a variety column every plot is its own variety, and ${plural(count, 'plot')} exceed the ${MAX_IMPORT_VARIETIES} varieties that can be simulated.`;
}
