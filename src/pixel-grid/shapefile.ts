import type { S2Grid } from './s2-grid';
import { centralMeridian } from './s2-grid';

/**
 * Minimal, dependency-free writer for a zipped ESRI Shapefile of polygons.
 *
 * Produces a real .zip (STORE / no compression) containing .shp/.shx/.dbf/.prj,
 * so QGIS/ArcGIS/R read it directly. Geometry is written in the grid's native
 * UTM CRS — the honest pixel squares — with a matching .prj, which is what you
 * want when aligning plots to pixels (reproject in your GIS if you need WGS84).
 *
 * Only what this app needs is implemented: Polygon (type 5), one ring per
 * record, numeric/character DBF fields. Outer rings are written clockwise per
 * the shapefile spec.
 */

// ----- growable little/big-endian byte buffer ---------------------------------

class ByteBuf {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  len = 0;

  private ensure(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number) { this.ensure(1); this.view.setUint8(this.len, v); this.len += 1; }
  u16le(v: number) { this.ensure(2); this.view.setUint16(this.len, v, true); this.len += 2; }
  u32le(v: number) { this.ensure(4); this.view.setUint32(this.len, v >>> 0, true); this.len += 4; }
  i32le(v: number) { this.ensure(4); this.view.setInt32(this.len, v, true); this.len += 4; }
  i32be(v: number) { this.ensure(4); this.view.setInt32(this.len, v, false); this.len += 4; }
  f64le(v: number) { this.ensure(8); this.view.setFloat64(this.len, v, true); this.len += 8; }
  f64be(v: number) { this.ensure(8); this.view.setFloat64(this.len, v, false); this.len += 8; }

  ascii(s: string) { this.ensure(s.length); for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0xff); }
  bytes(a: Uint8Array) { this.ensure(a.length); this.buf.set(a, this.len); this.len += a.length; }

  done(): Uint8Array { return this.buf.subarray(0, this.len); }
}

// ----- DBF attribute table ----------------------------------------------------

interface DbfField {
  name: string;
  type: 'N' | 'C';
  len: number;
  dec: number;
  /** value for a given cell index */
  value: (i: number) => string;
}

const dbfNum = (v: number, len: number, dec: number): string => {
  let s = v.toFixed(dec);
  if (s.length > len) s = '*'.repeat(len); // overflow marker, per dBASE convention
  return s.padStart(len, ' ');
};
const dbfStr = (v: string, len: number): string => (v + ' '.repeat(len)).slice(0, len);

function writeDbf(grid: S2Grid): Uint8Array {
  const n = grid.cells.length;
  const fields: DbfField[] = [
    { name: 'COL', type: 'N', len: 11, dec: 0, value: i => dbfNum(grid.cells[i].col, 11, 0) },
    { name: 'ROW', type: 'N', len: 11, dec: 0, value: i => dbfNum(grid.cells[i].row, 11, 0) },
    { name: 'EAST', type: 'N', len: 14, dec: 2, value: i => dbfNum(grid.cells[i].east, 14, 2) },
    { name: 'NORTH', type: 'N', len: 15, dec: 2, value: i => dbfNum(grid.cells[i].north, 15, 2) },
    { name: 'ZONE', type: 'N', len: 3, dec: 0, value: () => dbfNum(grid.zone, 3, 0) },
    { name: 'HEMI', type: 'C', len: 1, dec: 0, value: () => dbfStr(grid.south ? 'S' : 'N', 1) },
    { name: 'EPSG', type: 'N', len: 6, dec: 0, value: () => dbfNum(grid.epsg, 6, 0) },
    { name: 'RES_M', type: 'N', len: 8, dec: 2, value: () => dbfNum(grid.res, 8, 2) },
    { name: 'MGRS_TILE', type: 'C', len: 6, dec: 0, value: () => dbfStr(grid.tile ?? '', 6) },
  ];

  const recordSize = 1 + fields.reduce((s, f) => s + f.len, 0);
  const headerSize = 32 + 32 * fields.length + 1;
  const out = new ByteBuf();

  // Header.
  out.u8(0x03); // dBASE III, no memo
  const now = new Date();
  out.u8(now.getFullYear() - 1900);
  out.u8(now.getMonth() + 1);
  out.u8(now.getDate());
  out.u32le(n);
  out.u16le(headerSize);
  out.u16le(recordSize);
  for (let i = 0; i < 20; i++) out.u8(0); // reserved

  // Field descriptors.
  for (const f of fields) {
    const name = f.name.slice(0, 10);
    for (let i = 0; i < 11; i++) out.u8(i < name.length ? name.charCodeAt(i) : 0);
    out.ascii(f.type);
    out.u32le(0); // field data address (unused)
    out.u8(f.len);
    out.u8(f.dec);
    for (let i = 0; i < 14; i++) out.u8(0); // reserved
  }
  out.u8(0x0d); // header terminator

  // Records.
  for (let i = 0; i < n; i++) {
    out.u8(0x20); // not deleted
    for (const f of fields) out.ascii(f.value(i));
  }
  out.u8(0x1a); // EOF
  return out.done();
}

// ----- SHP / SHX geometry -----------------------------------------------------

/** Clockwise UTM ring for a cell (outer ring, per the shapefile spec). */
const cwRing = (east: number, north: number, res: number): [number, number][] => [
  [east, north],             // lower-left
  [east, north + res],       // upper-left
  [east + res, north + res], // upper-right
  [east + res, north],       // lower-right
  [east, north],             // close
];

const RECORD_CONTENT_WORDS = 64; // fixed per cell: 128 content bytes / 2

function writeShpShx(grid: S2Grid): { shp: Uint8Array; shx: Uint8Array } {
  const n = grid.cells.length;
  const res = grid.res;
  // The bounding box of the records ACTUALLY written, not of the area the grid
  // was built over. A field-clipped export writes only the pixels inside the
  // traced shape, and GIS software reads this header for "zoom to layer", so the
  // old box framed ground that holds no polygons. Identical to grid.utmBounds
  // whenever the grid is unclipped.
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const c of grid.cells) {
    if (c.east < minE) minE = c.east;
    if (c.north < minN) minN = c.north;
    if (c.east + res > maxE) maxE = c.east + res;
    if (c.north + res > maxN) maxN = c.north + res;
  }
  if (!n) { minE = 0; minN = 0; maxE = 0; maxN = 0; }

  const shp = new ByteBuf();
  const shx = new ByteBuf();

  const writeMainHeader = (b: ByteBuf, fileWords: number) => {
    b.i32be(9994);                 // file code
    for (let i = 0; i < 5; i++) b.i32be(0);
    b.i32be(fileWords);            // file length in 16-bit words
    b.i32le(1000);                 // version
    b.i32le(5);                    // shape type: Polygon
    b.f64le(minE); b.f64le(minN); b.f64le(maxE); b.f64le(maxN);
    b.f64le(0); b.f64le(0); b.f64le(0); b.f64le(0); // Z/M ranges
  };

  // Record content = 8(rec header) + 128 bytes each ⇒ total file size known up front.
  const shpWords = 50 + n * (4 + RECORD_CONTENT_WORDS);
  const shxWords = 50 + n * 4;
  writeMainHeader(shp, shpWords);
  writeMainHeader(shx, shxWords);

  let offsetWords = 50; // first record header starts after the 100-byte header
  for (let i = 0; i < n; i++) {
    const { east, north } = grid.cells[i];
    const ring = cwRing(east, north, res);

    // SHP record header (big-endian): record number (1-based), content length.
    shp.i32be(i + 1);
    shp.i32be(RECORD_CONTENT_WORDS);

    // SHP record content (little-endian).
    shp.i32le(5);                  // shape type Polygon
    shp.f64le(east); shp.f64le(north); shp.f64le(east + res); shp.f64le(north + res); // box
    shp.i32le(1);                  // numParts
    shp.i32le(ring.length);        // numPoints (5)
    shp.i32le(0);                  // part 0 start index
    for (const [x, y] of ring) { shp.f64le(x); shp.f64le(y); }

    // SHX entry (big-endian): offset, content length — both in 16-bit words.
    shx.i32be(offsetWords);
    shx.i32be(RECORD_CONTENT_WORDS);
    offsetWords += 4 + RECORD_CONTENT_WORDS;
  }

  return { shp: shp.done(), shx: shx.done() };
}

// ----- .prj (ESRI WKT for WGS84 / UTM zone) -----------------------------------

function utmWkt(grid: S2Grid): string {
  const name = `WGS_1984_UTM_Zone_${grid.zone}${grid.south ? 'S' : 'N'}`;
  const falseNorthing = grid.south ? 10000000.0 : 0.0;
  return (
    `PROJCS["${name}",` +
    `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",` +
    `SPHEROID["WGS_1984",6378137.0,298.257223563]],` +
    `PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],` +
    `PROJECTION["Transverse_Mercator"],` +
    `PARAMETER["False_Easting",500000.0],` +
    `PARAMETER["False_Northing",${falseNorthing}],` +
    `PARAMETER["Central_Meridian",${centralMeridian(grid.zone)}.0],` +
    `PARAMETER["Scale_Factor",0.9996],` +
    `PARAMETER["Latitude_Of_Origin",0.0],` +
    `UNIT["Meter",1.0]]`
  );
}

// ----- ZIP (STORE / no compression) -------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const asciiBytes = (s: string): Uint8Array => {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
};

/** Zip a set of named files with no compression. */
function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const out = new ByteBuf();
  const central: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];

  for (const f of files) {
    const nameBytes = asciiBytes(f.name);
    const crc = crc32(f.data);
    const offset = out.len;
    // Local file header.
    out.u32le(0x04034b50);
    out.u16le(20);            // version needed
    out.u16le(0);             // flags
    out.u16le(0);             // method: store
    out.u16le(0);             // mod time
    out.u16le(0);             // mod date
    out.u32le(crc);
    out.u32le(f.data.length); // compressed size
    out.u32le(f.data.length); // uncompressed size
    out.u16le(nameBytes.length);
    out.u16le(0);             // extra length
    out.bytes(nameBytes);
    out.bytes(f.data);
    central.push({ name: nameBytes, crc, size: f.data.length, offset });
  }

  const cdStart = out.len;
  for (const c of central) {
    out.u32le(0x02014b50);
    out.u16le(20);            // version made by
    out.u16le(20);            // version needed
    out.u16le(0);             // flags
    out.u16le(0);             // method
    out.u16le(0);             // mod time
    out.u16le(0);             // mod date
    out.u32le(c.crc);
    out.u32le(c.size);
    out.u32le(c.size);
    out.u16le(c.name.length);
    out.u16le(0);             // extra
    out.u16le(0);             // comment
    out.u16le(0);             // disk number
    out.u16le(0);             // internal attrs
    out.u32le(0);             // external attrs
    out.u32le(c.offset);
    out.bytes(c.name);
  }
  const cdSize = out.len - cdStart;

  // End of central directory.
  out.u32le(0x06054b50);
  out.u16le(0);
  out.u16le(0);
  out.u16le(central.length);
  out.u16le(central.length);
  out.u32le(cdSize);
  out.u32le(cdStart);
  out.u16le(0); // comment length

  return out.done();
}

/**
 * Build a zipped shapefile (Blob) of the grid's pixel polygons, in native UTM.
 * `base` is the file stem inside the zip (e.g. "s2_pixels_10m").
 */
export function gridToShapefileZip(grid: S2Grid, base: string): Blob {
  const { shp, shx } = writeShpShx(grid);
  const dbf = writeDbf(grid);
  const prj = asciiBytes(utmWkt(grid));
  const cpg = asciiBytes('UTF-8');
  const zip = zipStore([
    { name: `${base}.shp`, data: shp },
    { name: `${base}.shx`, data: shx },
    { name: `${base}.dbf`, data: dbf },
    { name: `${base}.prj`, data: prj },
    { name: `${base}.cpg`, data: cpg },
  ]);
  // Copy into a fresh ArrayBuffer so the Blob owns exactly the used bytes.
  return new Blob([zip.slice()], { type: 'application/zip' });
}
