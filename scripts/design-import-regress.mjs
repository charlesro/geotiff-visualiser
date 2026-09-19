/**
 * Regression suite for the design reader (src/pixel-grid/design-import.ts),
 * run with `npm run test:design-import`.
 *
 * An uploaded design is the one input of the Pixel Grid Designer the user did
 * not draw on the page. If a ring is lost, a coordinate system misread or one
 * variety split in two, the simulation is confidently wrong about the user's
 * own trial, so every format and every refusal is exercised here from bytes
 * built in memory: shapefiles with their .shx/.dbf/.prj/.cpg, zips (stored and
 * deflated), GeoJSON, KML and KMZ.
 *
 * The fixtures mimic only the SHAPE of a real cereal variety trial: a 5 x 10 grid
 * of contiguous 14.6 x 15.0 m plots rotated about 11 degrees, a WGS84 .prj, a
 * UTF-8 .cpg, URL-valued germplasm with repetitions. Every name, URL, value and
 * coordinate below is synthetic; the real file belongs to a third party.
 *
 * Same mechanism as scripts/pixel-grid-regress.mjs: esbuild transpiles the
 * TypeScript under node_modules/ so proj4 and but-unzip resolve exactly as they
 * do for the app.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'node_modules/.design-import-regress');

fs.rmSync(BUILD, { recursive: true, force: true });
for (const rel of ['src/pixel-grid/design-import.ts']) {
  const ts = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // esbuild only strips types; relative specifiers still need an extension to
  // load as real ESM from disk.
  const js = transformSync(ts, { loader: 'ts', format: 'esm' }).code
    .replace(/(from\s*['"])(\.\.?\/[^'"]+?)(['"])/g, (_, a, spec, c) => a + spec + '.mjs' + c);
  const dest = path.join(BUILD, rel.replace(/\.ts$/, '.mjs'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, js);
}

const {
  readDesignFiles, detectVarietyColumn, detectNameColumn, varietiesOf, assignVarieties, varietyKeyOf, VARIETY_GUESS_PREFIX,
  varietyLabel, detectCrop, tooManyVarieties, formatNumber, parseXml, varietyWordRank,
  DesignImportError, MAX_IMPORT_BYTES, MAX_IMPORT_PLOTS, MAX_IMPORT_VARIETIES, NO_VARIETY_LABEL,
} = await import(path.join(BUILD, 'src/pixel-grid/design-import.mjs'));

let bad = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

/** The error a call throws, or null. */
const rejection = async fn => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
const refuses = (e, re) => e instanceof DesignImportError && re.test(e.message);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ===== byte writers ===========================================================

const MB = 1024 * 1024;
const encoder = new TextEncoder();
const utf8 = s => encoder.encode(s);
const latin1 = s => Uint8Array.from(s, ch => ch.charCodeAt(0) & 0xff);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const toArrayBuffer = u => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
const file = (name, content) => ({ name, data: toArrayBuffer(typeof content === 'string' ? utf8(content) : content) });

/**
 * One .shp record's content. r is null (a null shape), { type: 1, point },
 * { type: 5 | 15 | 25, parts } (Z and M arrays written for 15, M for 25), or
 * { raw } bytes as they are.
 */
function shapeContent(r) {
  if (r === null) return new Uint8Array(4);
  if (r.raw) return r.raw;
  if (r.type === 1) {
    const c = new Uint8Array(20);
    const v = new DataView(c.buffer);
    v.setInt32(0, 1, true);
    v.setFloat64(4, r.point[0], true);
    v.setFloat64(12, r.point[1], true);
    return c;
  }
  const pts = r.parts.flat();
  const nParts = r.parts.length, n = pts.length;
  const hasZ = r.type === 15, hasM = r.type === 15 || r.type === 25;
  const c = new Uint8Array(44 + 4 * nParts + 16 * n + (hasZ ? 16 + 8 * n : 0) + (hasM ? 16 + 8 * n : 0));
  const v = new DataView(c.buffer);
  v.setInt32(0, r.type, true);
  if (n) {
    v.setFloat64(4, Math.min(...pts.map(p => p[0])), true);
    v.setFloat64(12, Math.min(...pts.map(p => p[1])), true);
    v.setFloat64(20, Math.max(...pts.map(p => p[0])), true);
    v.setFloat64(28, Math.max(...pts.map(p => p[1])), true);
  }
  v.setInt32(36, nParts, true);
  v.setInt32(40, n, true);
  let start = 0;
  r.parts.forEach((p, k) => {
    v.setInt32(44 + 4 * k, start, true);
    start += p.length;
  });
  let o = 44 + 4 * nParts;
  for (const [x, y] of pts) {
    v.setFloat64(o, x, true);
    v.setFloat64(o + 8, y, true);
    o += 16;
  }
  if (hasZ) {
    o += 16;
    for (let i = 0; i < n; i++, o += 8) v.setFloat64(o, 150 + i, true);
  }
  if (hasM) {
    o += 16;
    for (let i = 0; i < n; i++, o += 8) v.setFloat64(o, -1e39, true); // "no data" M
  }
  return c;
}

function shapefile(records) {
  const contents = records.map(shapeContent);
  const shpLen = 100 + contents.reduce((n, c) => n + 8 + c.length, 0);
  const shp = new Uint8Array(shpLen);
  const shx = new Uint8Array(100 + 8 * contents.length);
  const sv = new DataView(shp.buffer), xv = new DataView(shx.buffer);
  for (const [v, len] of [[sv, shpLen], [xv, shx.length]]) {
    v.setInt32(0, 9994);
    v.setInt32(24, len / 2);
    v.setInt32(28, 1000, true);
    v.setInt32(32, 5, true);
  }
  let o = 100;
  contents.forEach((c, i) => {
    xv.setInt32(100 + 8 * i, o / 2);
    xv.setInt32(104 + 8 * i, c.length / 2);
    sv.setInt32(o, i + 1);
    sv.setInt32(o + 4, c.length / 2);
    shp.set(c, o + 8);
    o += 8 + c.length;
  });
  return { shp, shx };
}

/**
 * A dBASE III table. Cells are the raw text (right-aligned for N/F, left for
 * the rest) or a Uint8Array written as is; C cells go through `encode`.
 */
function dbf(fields, rows, { encode = utf8, ldid = 0, deleted = [] } = {}) {
  const headerLen = 32 + 32 * fields.length + 1;
  const recLen = 1 + fields.reduce((n, f) => n + f.len, 0);
  const out = new Uint8Array(headerLen + recLen * rows.length + 1);
  const v = new DataView(out.buffer);
  out[0] = 0x03;
  out[1] = 124;
  out[2] = 10;
  out[3] = 15;
  v.setUint32(4, rows.length, true);
  v.setUint16(8, headerLen, true);
  v.setUint16(10, recLen, true);
  out[29] = ldid;
  fields.forEach((f, i) => {
    const at = 32 + 32 * i;
    out.set(latin1(f.name.slice(0, 10)), at);
    out[at + 11] = f.type.charCodeAt(0);
    out[at + 16] = f.len;
    out[at + 17] = f.dec ?? 0;
  });
  out[headerLen - 1] = 0x0d;
  rows.forEach((row, r) => {
    let o = headerLen + r * recLen;
    out[o++] = deleted.includes(r) ? 0x2a : 0x20;
    fields.forEach((f, i) => {
      const cell = out.subarray(o, o + f.len);
      cell.fill(0x20);
      const raw = row[i] ?? '';
      const bytes = (raw instanceof Uint8Array ? raw : (f.type === 'C' ? encode : latin1)(String(raw))).subarray(0, f.len);
      cell.set(bytes, f.type === 'N' || f.type === 'F' ? f.len - bytes.length : 0);
      o += f.len;
    });
  });
  out[out.length - 1] = 0x1a;
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = data => {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/**
 * A zip of { name, data } entries, STORE by default or DEFLATE. An entry may
 * also give `body` (its compressed bytes as they are) and `declared` (the
 * uncompressed size its headers claim), to build archives that lie.
 */
function zip(entries, { deflate = false } = {}) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data, body: given, declared } of entries) {
    const nameBytes = utf8(name);
    const body = given ?? (deflate ? new Uint8Array(zlib.deflateRawSync(data)) : data);
    const crc = data ? crc32(data) : 0;
    const size = declared ?? data.length;
    const h = new Uint8Array(30);
    const hv = new DataView(h.buffer);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 0x800, true); // UTF-8 names
    hv.setUint16(8, deflate ? 8 : 0, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, body.length, true);
    hv.setUint32(22, size, true);
    hv.setUint16(26, nameBytes.length, true);
    locals.push(h, nameBytes, body);
    const c = new Uint8Array(46);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.push(c, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const cd = concat(...central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, offset, true);
  return concat(...locals, cd, eocd);
}

/** A shapefile's parts as zip entries or loose files, under one stem. */
const partsList = (stem, parts) => Object.entries(parts).filter(([, d]) => d !== undefined).map(([ext, d]) => ({ name: `${stem}.${ext}`, data: typeof d === 'string' ? utf8(d) : d }));
const zipFile = (zipName, entries, opts) => file(zipName, zip(entries, opts));

// ===== coordinate systems =====================================================

const UTM31 = '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs';
const UTM33S = '+proj=utm +zone=33 +south +datum=WGS84 +units=m +no_defs';
const L93 = '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const GCS_WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const WKT = {
  wgs84: GCS_WGS84,
  rgf93: 'GEOGCS["GCS_RGF_1993",DATUM["D_RGF_1993",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
  l93: 'PROJCS["RGF_1993_Lambert_93",GEOGCS["GCS_RGF_1993",DATUM["D_RGF_1993",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",700000.0],PARAMETER["False_Northing",6600000.0],PARAMETER["Central_Meridian",3.0],PARAMETER["Standard_Parallel_1",44.0],PARAMETER["Standard_Parallel_2",49.0],PARAMETER["Latitude_Of_Origin",46.5],UNIT["Meter",1.0]]',
  utm31n: `PROJCS["WGS_1984_UTM_Zone_31N",${GCS_WGS84},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",3.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`,
  utm33s: `PROJCS["WGS_1984_UTM_Zone_33S",${GCS_WGS84},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",15.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`,
  mercator: `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",${GCS_WGS84},PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]`,
};

const maxDeviation = (rings, expected) => {
  let worst = 0;
  rings.forEach((ring, k) => ring.forEach((p, i) => {
    worst = Math.max(worst, Math.abs(p[0] - expected[k][i][0]), Math.abs(p[1] - expected[k][i][1]));
  }));
  return worst;
};

// ===== the field-trial shaped trial =================================================

const THETA = (11 * Math.PI) / 180;
const PLOT_W = 14.6, PLOT_H = 15.0;
const TRIAL = (() => {
  const [E0, N0] = proj4('WGS84', UTM31, [1.5, 43.53]);
  const plots = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 10; c++) {
      const u0 = c * PLOT_W, u1 = (c + 1) * PLOT_W, v0 = r * PLOT_H, v1 = (r + 1) * PLOT_H;
      // Clockwise, as the shapefile spec wants an outer ring.
      const local = [[u0, v0], [u0, v1], [u1, v1], [u1, v0], [u0, v0]];
      const utm = local.map(([u, v]) => [E0 + u * Math.cos(THETA) - v * Math.sin(THETA), N0 + u * Math.sin(THETA) + v * Math.cos(THETA)]);
      const lonlat = utm.map(p => proj4(UTM31, 'WGS84', p));
      const l93 = lonlat.map(p => proj4('WGS84', L93, p));
      plots.push({ r, c, utm, lonlat, l93 });
    }
  }
  return plots;
})();

/** 40 synthetic varieties in the three URL spellings such files carry. */
const germplasm = k => [
  `http://Triticum_aestivum/SYN${k}/BREEDER_${k}`,
  `http://Triticum_aestivum/SYN${k}/`,
  `http://Triticum_aestivum/SYN_${k}/Seed_House_${k}_SA`,
  `https://www.catalogue.example.org/catalogue/variete/${1000000 + k}-zz-fictiva-${k}`,
][k % 4];
const germplasmLabel = k => [`SYN${k}`, `SYN${k}`, `SYN ${k}`, `ZZ Fictiva ${k}`][k % 4];
/** Plot i's variety: 40 varieties over 50 plots, the first 10 twice, scattered (7 is coprime with 50). */
const varietyOfPlot = i => {
  const j = (i * 7) % 50;
  return j < 40 ? j : j - 40;
};
const plotName = (r, c) => `99TST01_Y${String(r + 1).padStart(2, '0')}X${String(c + 1).padStart(3, '0')}`;

const TRIAL_FIELDS = [
  { name: 'Name', type: 'C', len: 20 },
  { name: 'URI', type: 'C', len: 80 },
  { name: 'type_name', type: 'C', len: 20 },
  { name: 'type_URI', type: 'C', len: 60 },
  { name: 'CreationDa', type: 'D', len: 8 },
  { name: 'Replicatio', type: 'N', len: 19, dec: 11 },
  { name: 'comment', type: 'C', len: 50 },
  { name: 'Destructio', type: 'C', len: 10 },
  { name: 'FactorLeve', type: 'C', len: 10 },
  { name: 'isPartOf', type: 'C', len: 60 },
  { name: 'Germplasm', type: 'C', len: 120 },
];
const TRIAL_ROWS = TRIAL.map((p, i) => [
  plotName(p.r, p.c), `http://example.org/trial/99TST01/${plotName(p.r, p.c)}`, 'Plot', 'http://example.org/ontology#Plot',
  '20241015', '1.00000000000', '', '', '[]', 'http://example.org/trial/99TST01', germplasm(varietyOfPlot(i)),
]);

/** The trial's shapefile parts, with coordinates written in `crs` and its .prj. */
const trialParts = (crs = 'wgs84', { prj = true, cpg = 'UTF-8' } = {}) => {
  const coords = { wgs84: p => p.lonlat, l93: p => p.l93, utm31n: p => p.utm }[crs];
  const { shp, shx } = shapefile(TRIAL.map(p => ({ type: 5, parts: [coords(p)] })));
  return { shp, shx, dbf: dbf(TRIAL_FIELDS, TRIAL_ROWS), prj: prj ? WKT[crs] : undefined, cpg };
};

// ===== national grids, pinned against PROJ ====================================

/**
 * A small square (about 15 by 22 m) near each place, projected by PROJ 9.7
 * (cs2cs EPSG:4326 to the
 * grid, which uses the same published datum shifts when no grid file is
 * installed), with the grid's .prj as PROJ writes it for ESRI and, for two of
 * them, as GDAL's WKT1. The reader must bring the corners back to the lon/lat
 * they came from (cs2cs prints DHDN Gauss-Kruger and LUREF northing first; they
 * are stored easting first, as a shapefile holds them). EPSG definitions and synthetic points
 * only.
 */
const NATIONAL = {
  31370: { esri: "PROJCS[\"Belge_Lambert_1972\",GEOGCS[\"GCS_Belge_1972\",DATUM[\"D_Belge_1972\",SPHEROID[\"International_1924\",6378388.0,297.0]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",0.0174532925199433]],PROJECTION[\"Lambert_Conformal_Conic\"],PARAMETER[\"False_Easting\",150000.013],PARAMETER[\"False_Northing\",5400088.438],PARAMETER[\"Central_Meridian\",4.36748666666667],PARAMETER[\"Standard_Parallel_1\",51.1666672333333],PARAMETER[\"Standard_Parallel_2\",49.8333339],PARAMETER[\"Latitude_Of_Origin\",90.0],UNIT[\"Meter\",1.0]]",
    gdal: "PROJCS[\"BD72 / Belgian Lambert 72\",GEOGCS[\"BD72\",DATUM[\"Reseau_National_Belge_1972\",SPHEROID[\"International 1924\",6378388,297,AUTHORITY[\"EPSG\",\"7022\"]],AUTHORITY[\"EPSG\",\"6313\"]],PRIMEM[\"Greenwich\",0,AUTHORITY[\"EPSG\",\"8901\"]],UNIT[\"degree\",0.0174532925199433,AUTHORITY[\"EPSG\",\"9122\"]],AUTHORITY[\"EPSG\",\"4313\"]],PROJECTION[\"Lambert_Conformal_Conic_2SP\"],PARAMETER[\"latitude_of_origin\",90],PARAMETER[\"central_meridian\",4.36748666666667],PARAMETER[\"standard_parallel_1\",51.1666672333333],PARAMETER[\"standard_parallel_2\",49.8333339],PARAMETER[\"false_easting\",150000.013],PARAMETER[\"false_northing\",5400088.438],UNIT[\"metre\",1,AUTHORITY[\"EPSG\",\"9001\"]],AXIS[\"Easting\",EAST],AXIS[\"Northing\",NORTH],AUTHORITY[\"EPSG\",\"31370\"]]",
    lonlat: [[4.7,50.56],[4.7,50.5602],[4.700200000000001,50.5602],[4.700200000000001,50.56]],
    xy: [[173470.8905,138860.5455],[173470.791,138882.792],[173484.9619,138882.8553],[173485.0614,138860.6089]] },
  31467: { esri: "PROJCS[\"DHDN_3_Degree_Gauss_Zone_3\",GEOGCS[\"GCS_Deutsches_Hauptdreiecksnetz\",DATUM[\"D_Deutsches_Hauptdreiecksnetz\",SPHEROID[\"Bessel_1841\",6377397.155,299.1528128]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",0.0174532925199433]],PROJECTION[\"Gauss_Kruger\"],PARAMETER[\"False_Easting\",3500000.0],PARAMETER[\"False_Northing\",0.0],PARAMETER[\"Central_Meridian\",9.0],PARAMETER[\"Scale_Factor\",1.0],PARAMETER[\"Latitude_Of_Origin\",0.0],UNIT[\"Meter\",1.0]]",
    lonlat: [[9,51],[9,51.0002],[9.0002,51.0002],[9.0002,51]],
    xy: [[3500073.5746,5651645.8825],[3500073.5744,5651668.1321],[3500087.6139,5651668.1323],[3500087.6142,5651645.8826]] },
  28992: { esri: "PROJCS[\"RD_New\",GEOGCS[\"GCS_Amersfoort\",DATUM[\"D_Amersfoort\",SPHEROID[\"Bessel_1841\",6377397.155,299.1528128]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",0.0174532925199433]],PROJECTION[\"Double_Stereographic\"],PARAMETER[\"False_Easting\",155000.0],PARAMETER[\"False_Northing\",463000.0],PARAMETER[\"Central_Meridian\",5.38763888888889],PARAMETER[\"Scale_Factor\",0.9999079],PARAMETER[\"Latitude_Of_Origin\",52.1561605555556],UNIT[\"Meter\",1.0]]",
    lonlat: [[5.66,51.97],[5.66,51.9702],[5.660200000000001,51.9702],[5.660200000000001,51.97]],
    xy: [[173746.0332,442433.211],[173745.9496,442455.4623],[173759.6931,442455.5139],[173759.7767,442433.2626]] },
  2169: { esri: "PROJCS[\"LUREF_Luxembourg_TM\",GEOGCS[\"GCS_LUREF\",DATUM[\"D_Luxembourg_Reference_Frame\",SPHEROID[\"International_1924\",6378388.0,297.0]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",0.0174532925199433]],PROJECTION[\"Transverse_Mercator\"],PARAMETER[\"False_Easting\",80000.0],PARAMETER[\"False_Northing\",100000.0],PARAMETER[\"Central_Meridian\",6.16666666666667],PARAMETER[\"Scale_Factor\",1.0],PARAMETER[\"Latitude_Of_Origin\",49.8333333333333],UNIT[\"Meter\",1.0]]",
    lonlat: [[6.13,49.61],[6.13,49.6102],[6.1302,49.6102],[6.1302,49.61]],
    xy: [[77244.6955,75041.8709],[77244.7065,75064.1154],[77259.1614,75064.1083],[77259.1504,75041.8638]] },
  27572: { esri: "PROJCS[\"NTF_Paris_Lambert_Zone_II\",GEOGCS[\"GCS_NTF_Paris\",DATUM[\"Nouvelle_Triangulation_Francaise_(Paris)\",SPHEROID[\"Clarke_1880_IGN\",6378249.2,293.466021293627]],PRIMEM[\"Paris\",2.33722917],UNIT[\"Grad\",0.0157079632679489]],PROJECTION[\"Lambert_Conformal_Conic\"],PARAMETER[\"False_Easting\",600000.0],PARAMETER[\"False_Northing\",2200000.0],PARAMETER[\"Central_Meridian\",0.0],PARAMETER[\"Standard_Parallel_1\",52.0],PARAMETER[\"Scale_Factor\",0.99987742],PARAMETER[\"Latitude_Of_Origin\",52.0],UNIT[\"Meter\",1.0]]",
    gdal: "PROJCS[\"NTF (Paris) / Lambert zone II\",GEOGCS[\"NTF (Paris)\",DATUM[\"Nouvelle_Triangulation_Francaise_Paris\",SPHEROID[\"Clarke 1880 (IGN)\",6378249.2,293.466021293627,AUTHORITY[\"EPSG\",\"7011\"]],AUTHORITY[\"EPSG\",\"6807\"]],PRIMEM[\"Paris\",2.33722917,AUTHORITY[\"EPSG\",\"8903\"]],UNIT[\"grad\",0.0157079632679489,AUTHORITY[\"EPSG\",\"9105\"]],AUTHORITY[\"EPSG\",\"4807\"]],PROJECTION[\"Lambert_Conformal_Conic_1SP\"],PARAMETER[\"latitude_of_origin\",52],PARAMETER[\"central_meridian\",0],PARAMETER[\"scale_factor\",0.99987742],PARAMETER[\"false_easting\",600000],PARAMETER[\"false_northing\",2200000],UNIT[\"metre\",1,AUTHORITY[\"EPSG\",\"9001\"]],AXIS[\"Easting\",EAST],AXIS[\"Northing\",NORTH],AUTHORITY[\"EPSG\",\"27572\"]]",
    lonlat: [[1.355,43.552],[1.355,43.5522],[1.3552,43.5522],[1.3552,43.552]],
    xy: [[520568.4124,1839386.9406],[520568.6904,1839409.1919],[520584.8741,1839408.9897],[520584.5961,1839386.7383]] },
  27200: { esri: "PROJCS[\"GD_1949_New_Zealand_Map_Grid\",GEOGCS[\"GCS_New_Zealand_1949\",DATUM[\"D_New_Zealand_1949\",SPHEROID[\"International_1924\",6378388.0,297.0]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",0.0174532925199433]],PROJECTION[\"New_Zealand_Map_Grid\"],PARAMETER[\"False_Easting\",2510000.0],PARAMETER[\"False_Northing\",6023150.0],PARAMETER[\"Longitude_Of_Origin\",173.0],PARAMETER[\"Latitude_Of_Origin\",-41.0],UNIT[\"Meter\",1.0]]",
    lonlat: [[175.6,-40.3],[175.6,-40.2998],[175.6002,-40.2998],[175.6002,-40.3]],
    xy: [[2730989.1158,6097405.2657],[2730989.7704,6097427.462],[2731006.7653,6097426.9608],[2731006.1106,6097404.7644]] },
};

/** WKT2 descriptions from PROJ 9, with their USAGE, ID and REMARK text dropped. */
const WKT2 = {
  wgs84_2015: "GEODCRS[\"WGS 84\",DATUM[\"World Geodetic System 1984\",ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],CS[ellipsoidal,2],AXIS[\"geodetic latitude (Lat)\",north,ORDER[1],ANGLEUNIT[\"degree\",0.0174532925199433]],AXIS[\"geodetic longitude (Lon)\",east,ORDER[2],ANGLEUNIT[\"degree\",0.0174532925199433]]]",
  wgs84_2019: "GEOGCRS[\"WGS 84\",ENSEMBLE[\"World Geodetic System 1984 ensemble\",MEMBER[\"World Geodetic System 1984 (Transit)\"],MEMBER[\"World Geodetic System 1984 (G730)\"],MEMBER[\"World Geodetic System 1984 (G873)\"],MEMBER[\"World Geodetic System 1984 (G1150)\"],MEMBER[\"World Geodetic System 1984 (G1674)\"],MEMBER[\"World Geodetic System 1984 (G1762)\"],MEMBER[\"World Geodetic System 1984 (G2139)\"],MEMBER[\"World Geodetic System 1984 (G2296)\"],ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]],ENSEMBLEACCURACY[2.0]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],CS[ellipsoidal,2],AXIS[\"geodetic latitude (Lat)\",north,ORDER[1],ANGLEUNIT[\"degree\",0.0174532925199433]],AXIS[\"geodetic longitude (Lon)\",east,ORDER[2],ANGLEUNIT[\"degree\",0.0174532925199433]]]",
  etrs89_2015: "GEODCRS[\"ETRS89\",DATUM[\"European Terrestrial Reference System 1989\",ELLIPSOID[\"GRS 1980\",6378137,298.257222101,LENGTHUNIT[\"metre\",1]]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],CS[ellipsoidal,2],AXIS[\"geodetic latitude (Lat)\",north,ORDER[1],ANGLEUNIT[\"degree\",0.0174532925199433]],AXIS[\"geodetic longitude (Lon)\",east,ORDER[2],ANGLEUNIT[\"degree\",0.0174532925199433]]]",
  l93_2015: "PROJCRS[\"RGF93 v1 / Lambert-93\",BASEGEODCRS[\"RGF93 v1\",DATUM[\"Reseau Geodesique Francais 1993 v1\",ELLIPSOID[\"GRS 1980\",6378137,298.257222101,LENGTHUNIT[\"metre\",1]]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]]],CONVERSION[\"Lambert-93\",METHOD[\"Lambert Conic Conformal (2SP)\"],PARAMETER[\"Latitude of false origin\",46.5,ANGLEUNIT[\"degree\",0.0174532925199433]],PARAMETER[\"Longitude of false origin\",3,ANGLEUNIT[\"degree\",0.0174532925199433]],PARAMETER[\"Latitude of 1st standard parallel\",49,ANGLEUNIT[\"degree\",0.0174532925199433]],PARAMETER[\"Latitude of 2nd standard parallel\",44,ANGLEUNIT[\"degree\",0.0174532925199433]],PARAMETER[\"Easting at false origin\",700000,LENGTHUNIT[\"metre\",1]],PARAMETER[\"Northing at false origin\",6600000,LENGTHUNIT[\"metre\",1]]],CS[Cartesian,2],AXIS[\"easting (X)\",east,ORDER[1],LENGTHUNIT[\"metre\",1]],AXIS[\"northing (Y)\",north,ORDER[2],LENGTHUNIT[\"metre\",1]]]",
  bd72_2019: "PROJCRS[\"BD72 / Belgian Lambert 72\",BASEGEOGCRS[\"BD72\",DATUM[\"Reseau National Belge 1972\",ELLIPSOID[\"International 1924\",6378388,297,LENGTHUNIT[\"metre\",1]]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]]],CONVERSION[\"Belgian Lambert 72\",METHOD[\"Lambert Conic Conformal (2SP)\"],PARAMETER[\"Latitude of false origin\",90,ANGLEUNIT[\"degree\",0.0174532925199433]],PARAMETER[\"Longitude of false origin\",4.36748666666667,ANGLEUNIT[\"degree\",0.0174532925199433]],PARAMETER[\"Latitude of 1st standard parallel\",51.1666672333333,ANGLEUNIT[\"degree\",0.0174532925199433]],PARAMETER[\"Latitude of 2nd standard parallel\",49.8333339,ANGLEUNIT[\"degree\",0.0174532925199433]],PARAMETER[\"Easting at false origin\",150000.013,LENGTHUNIT[\"metre\",1]],PARAMETER[\"Northing at false origin\",5400088.438,LENGTHUNIT[\"metre\",1]]],CS[Cartesian,2],AXIS[\"easting (X)\",east,ORDER[1],LENGTHUNIT[\"metre\",1]],AXIS[\"northing (Y)\",north,ORDER[2],LENGTHUNIT[\"metre\",1]]]",
  geocentric_2019: "GEODCRS[\"WGS 84\",ENSEMBLE[\"World Geodetic System 1984 ensemble\",MEMBER[\"World Geodetic System 1984 (Transit)\"],MEMBER[\"World Geodetic System 1984 (G730)\"],MEMBER[\"World Geodetic System 1984 (G873)\"],MEMBER[\"World Geodetic System 1984 (G1150)\"],MEMBER[\"World Geodetic System 1984 (G1674)\"],MEMBER[\"World Geodetic System 1984 (G1762)\"],MEMBER[\"World Geodetic System 1984 (G2139)\"],MEMBER[\"World Geodetic System 1984 (G2296)\"],ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]],ENSEMBLEACCURACY[2.0]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],CS[Cartesian,3],AXIS[\"(X)\",geocentricX,ORDER[1],LENGTHUNIT[\"metre\",1]],AXIS[\"(Y)\",geocentricY,ORDER[2],LENGTHUNIT[\"metre\",1]],AXIS[\"(Z)\",geocentricZ,ORDER[3],LENGTHUNIT[\"metre\",1]]]",
  dhdnBound_2019: "BOUNDCRS[SOURCECRS[GEOGCRS[\"DHDN\",DATUM[\"Deutsches Hauptdreiecksnetz\",ELLIPSOID[\"Bessel 1841\",6377397.155,299.1528128,LENGTHUNIT[\"metre\",1]]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],CS[ellipsoidal,2],AXIS[\"geodetic latitude (Lat)\",north,ORDER[1],ANGLEUNIT[\"degree\",0.0174532925199433]],AXIS[\"geodetic longitude (Lon)\",east,ORDER[2],ANGLEUNIT[\"degree\",0.0174532925199433]]]],TARGETCRS[GEOGCRS[\"WGS 84\",DATUM[\"World Geodetic System 1984\",ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],CS[ellipsoidal,2],AXIS[\"latitude\",north,ORDER[1],ANGLEUNIT[\"degree\",0.0174532925199433]],AXIS[\"longitude\",east,ORDER[2],ANGLEUNIT[\"degree\",0.0174532925199433]]]],ABRIDGEDTRANSFORMATION[\"DHDN to WGS 84 (2)\",METHOD[\"Position Vector transformation (geog2D domain)\"],PARAMETER[\"X-axis translation\",598.1],PARAMETER[\"Y-axis translation\",73.7],PARAMETER[\"Z-axis translation\",418.2],PARAMETER[\"X-axis rotation\",0.202],PARAMETER[\"Y-axis rotation\",0.045],PARAMETER[\"Z-axis rotation\",-2.455],PARAMETER[\"Scale difference\",1.0000067]]]",
  ed50utm_esri: "PROJCS[\"ED_1950_UTM_Zone_31N\",GEOGCS[\"GCS_European_1950\",DATUM[\"D_European_1950\",SPHEROID[\"International_1924\",6378388.0,297.0]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",0.0174532925199433]],PROJECTION[\"Transverse_Mercator\"],PARAMETER[\"False_Easting\",500000.0],PARAMETER[\"False_Northing\",0.0],PARAMETER[\"Central_Meridian\",3.0],PARAMETER[\"Scale_Factor\",0.9996],PARAMETER[\"Latitude_Of_Origin\",0.0],UNIT[\"Meter\",1.0]]",
};

// ==============================================================================

console.log('A. an field-trial shaped zipped shapefile reads whole');
{
  const design = await readDesignFiles([zipFile('trial.zip', partsList('trial', trialParts()))]);
  ok('fileName is the uploaded zip', design.fileName === 'trial.zip', design.fileName);
  ok('all 50 plots, in record order', design.plots.length === 50);
  ok('columns in DBF order', same(design.columns, TRIAL_FIELDS.map(f => f.name)), design.columns.join(','));
  ok('no warnings for a clean WGS84 + UTF-8 file', design.warnings.length === 0, JSON.stringify(design.warnings));
  const p0 = design.plots[0].props;
  ok('text attributes as written', p0.Name === '99TST01_Y01X001' && p0.type_name === 'Plot' && p0.FactorLeve === '[]' && p0.comment === '' && p0.Germplasm === germplasm(0));
  ok('a numeric 1.00000000000 reads "1", not float noise', p0.Replicatio === '1', p0.Replicatio);
  ok('a D field reads as an ISO date', p0.CreationDa === '2024-10-15', p0.CreationDa);
  ok('every plot carries every column as a string',
    design.plots.every(p => design.columns.every(c => typeof p.props[c] === 'string') && Object.keys(p.props).length === design.columns.length));
  ok('one closed ring per plot, bit-identical to what was written',
    design.plots.every((p, i) => p.rings.length === 1 && p.rings[0].length === 5 && same(p.rings[0], TRIAL[i].lonlat)));
  ok('contiguous plots share their edge vertices exactly (no alley invented)',
    same(design.plots[0].rings[0][3], design.plots[1].rings[0][0]) && same(design.plots[0].rings[0][1], design.plots[10].rings[0][0]));
  const back = design.plots[0].rings[0].map(p => proj4('WGS84', UTM31, p));
  const az = (Math.atan2(back[3][1] - back[0][1], back[3][0] - back[0][0]) * 180) / Math.PI;
  const w = Math.hypot(back[3][0] - back[0][0], back[3][1] - back[0][1]);
  const h = Math.hypot(back[1][0] - back[0][0], back[1][1] - back[0][1]);
  ok('the grid is still rotated 11 degrees', Math.abs(az - 11) < 1e-6, `${az.toFixed(8)} deg`);
  ok('plots are still 14.6 x 15.0 m', Math.abs(w - 14.6) < 1e-6 && Math.abs(h - 15) < 1e-6, `${w.toFixed(6)} x ${h.toFixed(6)}`);
  ok('variety column detected: Germplasm', design.varietyColumn === 'Germplasm', design.varietyColumn);
  ok('name column detected: Name', design.nameColumn === 'Name', design.nameColumn);

  const varieties = varietiesOf(design);
  const expectedOrder = [];
  for (let i = 0; i < 50; i++) if (!expectedOrder.includes(varietyOfPlot(i))) expectedOrder.push(varietyOfPlot(i));
  ok('40 varieties over 50 plots', varieties.length === 40, `${varieties.length}`);
  ok('varieties in order of first appearance', same(varieties.map(v => v.key), expectedOrder.map(germplasm)));
  ok('first appearances pinned: plots 0, 1, 2 grow varieties 0, 7, 14', same(varieties.slice(0, 3).map(v => v.key), [germplasm(0), germplasm(7), germplasm(14)]));
  ok('repetitions: the first ten varieties have 2 plots, the rest 1',
    varieties.every(v => v.plots === (expectedOrder[varieties.indexOf(v)] < 10 ? 2 : 1)) && varieties.reduce((n, v) => n + v.plots, 0) === 50);
  ok('labels from the three URL spellings', varieties.every((v, s) => v.label === germplasmLabel(expectedOrder[s])),
    varieties.slice(0, 4).map(v => v.label).join(' | '));
  ok('every variety is wheat (Triticum in the key, or the design majority for catalogue URLs)', varieties.every(v => v.crop === 'wheat'));
  const { species } = assignVarieties(design);
  ok('assignVarieties maps each plot to its variety index',
    species.length === 50 && species.every((s, i) => varieties[s].key === germplasm(varietyOfPlot(i))));
  ok('varietyKeyOf is the raw column value', varietyKeyOf(design, 3) === germplasm(varietyOfPlot(3)));
}

console.log('\nB. coordinate systems');
{
  const l93 = await readDesignFiles([zipFile('l93.zip', partsList('trial', trialParts('l93')))]);
  ok('Lambert-93 (ESRI WKT) lands on the WGS84 trial within 1e-9 deg',
    l93.plots.every((p, i) => maxDeviation(p.rings, [TRIAL[i].lonlat]) < 1e-9),
    `worst ${Math.max(...l93.plots.map((p, i) => maxDeviation(p.rings, [TRIAL[i].lonlat]))).toExponential(2)}`);
  ok('Lambert-93: the reprojection is reported', same(l93.warnings, ['Reprojected "trial.shp" from RGF_1993_Lambert_93 to WGS84 longitude/latitude.']), JSON.stringify(l93.warnings));

  const origin = shapefile([{ type: 5, parts: [[[700000, 6600000], [700000, 6600010], [700010, 6600010], [700010, 6600000], [700000, 6600000]]] }]);
  const o = await readDesignFiles([zipFile('o.zip', partsList('o', { ...origin, prj: WKT.l93 }))]);
  const [ox, oy] = o.plots[0].rings[0][0];
  ok('Lambert-93 false origin (700000, 6600000) is (3E, 46.5N)', Math.abs(ox - 3) < 1e-9 && Math.abs(oy - 46.5) < 1e-9, `${ox}, ${oy}`);
  const ref = proj4(L93, 'WGS84', [700010, 6600010]);
  ok('and a corner off the origin matches proj4 on the EPSG definition', maxDeviation([[o.plots[0].rings[0][2]]], [[ref]]) < 1e-9);

  const utm = await readDesignFiles([zipFile('utm.zip', partsList('trial', trialParts('utm31n')))]);
  ok('UTM 31N lands on the WGS84 trial within 1e-9 deg',
    utm.plots.every((p, i) => maxDeviation(p.rings, [TRIAL[i].lonlat]) < 1e-9));
  ok('UTM 31N: reported by the .prj name', /from WGS_1984_UTM_Zone_31N to WGS84/.test(utm.warnings[0] ?? ''), utm.warnings[0]);

  const s = shapefile([{ type: 5, parts: [[[500000, 10000000], [500010, 10000000], [500010, 9999990], [500000, 9999990]]] }]);
  const south = await readDesignFiles([zipFile('s.zip', partsList('s', { ...s, prj: WKT.utm33s }))]);
  const [sx, sy] = south.plots[0].rings[0][0];
  ok('UTM 33S: (500000, 10000000) is (15E, 0N)', Math.abs(sx - 15) < 1e-9 && Math.abs(sy) < 1e-9, `${sx}, ${sy}`);

  const rgf = await readDesignFiles([zipFile('rgf.zip', partsList('trial', { ...trialParts(), prj: WKT.rgf93 }))]);
  ok('a geographic non-WGS84 .prj (GCS_RGF_1993) goes through proj4 and is reported',
    rgf.plots.every((p, i) => maxDeviation(p.rings, [TRIAL[i].lonlat]) < 1e-9) && /from GCS_RGF_1993/.test(rgf.warnings[0] ?? ''), rgf.warnings[0]);

  const noPrj = await readDesignFiles([zipFile('noprj.zip', partsList('trial', trialParts('wgs84', { prj: false })))]);
  ok('no .prj but lon/lat numbers: read as WGS84, with a warning',
    noPrj.plots.length === 50 && same(noPrj.warnings, ['"trial.shp" has no .prj file, so its coordinates were read as WGS84 longitude/latitude.']), JSON.stringify(noPrj.warnings));

  const e1 = await rejection(() => readDesignFiles([zipFile('x.zip', partsList('trial', trialParts('utm31n', { prj: false })))]));
  ok('no .prj and UTM numbers: refused, naming the missing .prj',
    refuses(e1, /^"trial\.shp" has coordinates that are not longitude\/latitude \(e\.g\. \d+\.?\d*, \d+\.?\d*\)\. The \.prj file that says which coordinate system they are in is missing/), e1?.message);

  const local = shapefile(TRIAL.map(p => ({ type: 5, parts: [p.utm.map(([x, y]) => [x - TRIAL[0].utm[0][0] + 20, y - TRIAL[0].utm[0][1] + 20])] })));
  const e2 = await rejection(() => readDesignFiles([zipFile('x.zip', partsList('local', { ...local }))]));
  ok('no .prj and small local metres (inside the lon/lat range): refused by the span check', refuses(e2, /not longitude\/latitude/), e2?.message);

  const e3 = await rejection(() => readDesignFiles([zipFile('x.zip', partsList('trial', { ...trialParts(), prj: 'this is not a coordinate system' }))]));
  ok('an unreadable .prj is refused, not ignored', refuses(e3, /^"trial\.prj" describes a coordinate system the designer cannot read/), e3?.message);

  const epsgStyle = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';
  const epsgWgs = await readDesignFiles([zipFile('w.zip', partsList('trial', { ...trialParts(), prj: epsgStyle }))]);
  ok('an EPSG-style WGS 84 .prj is plain lon/lat: exact, no warning', same(epsgWgs.plots[7].rings, [TRIAL[7].lonlat]) && epsgWgs.warnings.length === 0, JSON.stringify(epsgWgs.warnings));
  // TOWGS84 spells "WGS84" too; a datum shift must not be mistaken for WGS84 itself.
  const ed50 = 'GEOGCS["ED50",DATUM["European_Datum_1950",SPHEROID["International 1924",6378388,297],TOWGS84[-87,-98,-121,0,0,0,0]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
  const shifted = await readDesignFiles([zipFile('ed50.zip', partsList('trial', { ...trialParts(), prj: ed50 }))]);
  const edRef = TRIAL[0].lonlat.map(p => proj4('+proj=longlat +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +no_defs', 'WGS84', p));
  ok('a geographic .prj with a TOWGS84 shift is reprojected, not taken for WGS84',
    maxDeviation(shifted.plots[0].rings, [edRef]) < 1e-9 && maxDeviation(shifted.plots[0].rings, [TRIAL[0].lonlat]) > 5e-4 && /from ED50 to WGS84/.test(shifted.warnings[0] ?? ''), shifted.warnings[0]);
  const zeroShift = ed50.replace('TOWGS84[-87,-98,-121,0,0,0,0]', 'TOWGS84[0,0,0,0,0,0,0]');
  const declaredSame = await readDesignFiles([zipFile('z.zip', partsList('trial', { ...trialParts(), prj: zeroShift }))]);
  ok('TOWGS84[0,0,0,...] on an old ellipsoid is the file saying "this is WGS84": believed, not refused as an unknown datum',
    same(declaredSame.plots[2].rings, [TRIAL[2].lonlat]) && !declaredSame.warnings.some(w => /shifting/.test(w)), JSON.stringify(declaredSame.warnings));
  const e5 = await rejection(() => readDesignFiles([zipFile('x.zip', partsList('trial', { ...trialParts('utm31n'), prj: WKT.wgs84 }))]));
  ok('a WGS84 .prj over metres: refused, blaming the .prj rather than calling it missing',
    refuses(e5, /not longitude\/latitude .*\. Its \.prj says they are longitude\/latitude, so the \.prj probably belongs to other data\.$/), e5?.message);

  const far = shapefile([{ type: 5, parts: [[[1e12, 1e6], [1e12 + 10, 1e6], [1e12 + 10, 1e6 + 10], [1e12, 1e6]]] }]);
  const e4 = await rejection(() => readDesignFiles([zipFile('x.zip', partsList('far', { ...far, prj: WKT.mercator }))]));
  ok('a .prj that puts the data off the Earth is refused', refuses(e4, /does not land on the Earth when read with its coordinate system \(WGS_1984_Web_Mercator_Auxiliary_Sphere\)/), e4?.message);
}

console.log('\nB2. national grids: datum shifts, prime meridians, grads, WKT2');
{
  const metres = (p, q) => Math.hypot((p[0] - q[0]) * 111320 * Math.cos((q[1] * Math.PI) / 180), (p[1] - q[1]) * 110574);
  /** The farthest a read corner is from where PROJ says it belongs, in metres (Infinity when the read failed). */
  const worst = (dsg, lonlat) => (dsg.plots.length ? Math.max(...lonlat.map((q, i) => metres(dsg.plots[0].rings[0][i], q))) : Infinity);
  /** A read that must succeed, as a design with no plots and the refusal as its only warning when it does not, so a regression is a FAIL, not a crash. */
  const attempt = files => readDesignFiles(files).catch(e => ({ plots: [], columns: [], warnings: [String(e?.message ?? e)] }));
  const grid = (xy, prj, stem = 'grid') => {
    const { shp, shx } = shapefile([{ type: 5, parts: [[...xy, xy[0]]] }]);
    return zipFile(`${stem}.zip`, partsList(stem, { shp, shx, prj }));
  };
  const shiftNote = /, shifting the .+ datum with its published transformation \(accurate to about \d+(\.\d+)? m\)\.$/;

  // proj4js alone leaves these datums unshifted (BD72 170 m off, DHDN 218 m,
  // RD New 175 m, LUREF 217 m) and reads NTF (Paris) grads as degrees (610 km).
  for (const [code, place] of [[31370, 'Belgian Lambert 72'], [31467, 'DHDN Gauss-Kruger zone 3'], [28992, 'Dutch RD New'], [2169, 'LUREF Luxembourg TM'], [27572, 'NTF (Paris) Lambert zone II, in grads from the Paris meridian'], [27200, 'NZGD49 New Zealand Map Grid (ESRI Longitude_Of_Origin)']]) {
    const g = NATIONAL[code];
    const dsg = await attempt([grid(g.xy, g.esri)]);
    const reprojected = dsg.warnings.find(w => w.startsWith('Reprojected'));
    ok(`${place} (EPSG:${code}, ESRI .prj) lands where PROJ puts it, within 5 cm`, worst(dsg, g.lonlat) < 0.05, dsg.plots.length ? `${worst(dsg, g.lonlat).toFixed(4)} m` : dsg.warnings[0]);
    ok(`${place}: the datum shift and its accuracy are reported`, shiftNote.test(reprojected ?? ''), reprojected);
  }
  for (const code of [31370, 27572]) {
    const g = NATIONAL[code];
    const dsg = await attempt([grid(g.xy, g.gdal)]);
    ok(`EPSG:${code} with GDAL's WKT1 .prj (other datum names, Paris meridian in grads) lands within 5 cm`, worst(dsg, g.lonlat) < 0.05, dsg.plots.length ? `${worst(dsg, g.lonlat).toFixed(4)} m` : dsg.warnings[0]);
  }
  const bd72 = await attempt([grid(NATIONAL[31370].xy, NATIONAL[31370].esri)]);
  ok('the Belgian warning in full', same(bd72.warnings.filter(w => w.startsWith('Reprojected')), [
    'Reprojected "grid.shp" from Belge_Lambert_1972 to WGS84 longitude/latitude, shifting the Belge 1972 datum with its published transformation (accurate to about 1 m).',
  ]), JSON.stringify(bd72.warnings));

  const far = NATIONAL[31370].xy.map(([x, y]) => [x - 500000, y]);
  const eFar = await rejection(() => readDesignFiles([grid(far, NATIONAL[31370].esri)]));
  ok('a Belgian Lambert 72 .prj over coordinates 500 km west of Belgium is refused as belonging to other data',
    refuses(eFar, /^"grid\.shp" lands at -?\d+\.\d+, \d+\.\d+ when read with its coordinate system \(Belge_Lambert_1972\), far outside the area the Belge 1972 datum is used in/), eFar?.message);

  const utmCorners = TRIAL[0].utm.slice(0, 4);
  const eEd50 = await rejection(() => readDesignFiles([grid(utmCorners, WKT2.ed50utm_esri)]));
  ok('a datum with no single published shift (ED50) is refused by name, not read 100 m off',
    refuses(eEd50, /^"grid\.prj" uses the European 1950 datum, and the designer does not know the shift from it to WGS84: without it the plots would land tens to hundreds of metres off\. Export the layer in WGS84/), eEd50?.message);
  const ePm = await rejection(() => readDesignFiles([grid(NATIONAL[27572].xy, NATIONAL[27572].gdal.replace('PRIMEM["Paris"', 'PRIMEM["Nowhere"'))]));
  ok('a prime meridian the reader cannot place is refused by name', refuses(ePm, /^"grid\.prj" measures longitude from the Nowhere meridian, which the designer does not know\./), ePm?.message);

  const trialIn = prj => readDesignFiles([zipFile('t.zip', partsList('trial', { ...trialParts(), prj }))]);
  for (const key of ['wgs84_2015', 'wgs84_2019']) {
    const dsg = await attempt([zipFile('t.zip', partsList('trial', { ...trialParts(), prj: WKT2[key] }))]);
    ok(`WKT2 WGS 84 (${key.slice(-4)}, ${key.endsWith('2015') ? 'GEODCRS' : 'GEOGCRS with a datum ensemble'}) is plain lon/lat: exact, no warning`,
      dsg.plots.length === 50 && same(dsg.plots[4].rings, [TRIAL[4].lonlat]) && dsg.warnings.length === 0, JSON.stringify(dsg.warnings));
  }
  const etrs = await attempt([zipFile('t.zip', partsList('trial', { ...trialParts(), prj: WKT2.etrs89_2015 }))]);
  ok('WKT2 ETRS89 (GEODCRS) reads as lon/lat on GRS80, reported',
    etrs.plots.length === 50 && same(etrs.plots[4].rings, [TRIAL[4].lonlat]) && /^Reprojected "trial\.shp" from ETRS89 to WGS84/.test(etrs.warnings[0] ?? ''), JSON.stringify(etrs.warnings));
  const l93w2 = await attempt([zipFile('t.zip', partsList('trial', { ...trialParts('l93'), prj: WKT2.l93_2015 }))]);
  ok('WKT2 Lambert-93 (PROJCRS on GRS80) lands on the trial within 1e-9 deg',
    l93w2.plots.length === 50 && l93w2.plots.every((p, i) => maxDeviation(p.rings, [TRIAL[i].lonlat]) < 1e-9), l93w2.plots.length ? `worst ${Math.max(...l93w2.plots.map((p, i) => maxDeviation(p.rings, [TRIAL[i].lonlat]))).toExponential(2)}` : l93w2.warnings[0]);
  const eW2 = await rejection(() => readDesignFiles([grid(NATIONAL[31370].xy, WKT2.bd72_2019)]));
  ok('WKT2 on an older datum is refused, asking for an ESRI .prj', refuses(eW2, /^"grid\.prj" describes BD72 \/ Belgian Lambert 72 in the WKT2 format, which the designer reads for systems on WGS84 or ETRS89 only\. Save the \.prj in the ESRI \(WKT1\) format/), eW2?.message);
  const eGeocentric = await rejection(() => trialIn(WKT2.geocentric_2019));
  ok('a geocentric X/Y/Z CRS is not a map: refused as unreadable', refuses(eGeocentric, /^"trial\.prj" describes a coordinate system the designer cannot read \(WGS 84\)/), eGeocentric?.message);

  // A BOUNDCRS carries its shift as an abridged transformation, scale as the bare factor 1.0000067.
  const dhdnPoint = [[9.0, 51.0], [9.0, 51.0002], [9.0002, 51.0002], [9.0002, 51.0]];
  const dhdn = await attempt([grid(dhdnPoint, WKT2.dhdnBound_2019)]);
  const dhdnRef = dhdnPoint.map(p => proj4('+proj=longlat +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +no_defs', 'WGS84', p));
  ok('WKT2 BOUNDCRS (DHDN, position vector, scale as a factor) shifts exactly as its parameters say',
    dhdn.plots.length === 1 && maxDeviation([dhdn.plots[0].rings[0].slice(0, 4)], [dhdnRef]) < 1e-9 && /by the parameters its \.prj gives\.$/.test(dhdn.warnings.find(w => w.startsWith('Reprojected')) ?? ''), JSON.stringify(dhdn.warnings));

  // A .prj copied from other data over degrees: before, plots 2 cm wide off Africa.
  for (const prj of ['l93', 'utm31n']) {
    const e = await rejection(() => trialIn(WKT[prj]));
    ok(`degrees under a ${prj === 'l93' ? 'Lambert-93' : 'UTM'} .prj are refused, not shrunk to centimetres near 0,0`,
      refuses(e, /^"trial\.shp" has coordinates that look like longitude\/latitude \(e\.g\. 1\.\d+, 43\.\d+\), but its coordinate system \(.+\) is in metres/), e?.message);
  }
}

console.log('\nC. shapefile geometry: Z/M, null shapes, parts, holes, degenerate rings');
{
  const x = 4.7, y = 50.6, d = 0.0001;
  const sq = (x0, y0, s = d) => [[x0, y0], [x0, y0 + s], [x0 + s, y0 + s], [x0 + s, y0], [x0, y0]]; // clockwise
  const ccw = ring => [...ring].reverse();
  const records = [
    { type: 5, parts: [sq(x, y)] },                                                         // 0 plain
    { type: 15, parts: [sq(x + 1 * d * 2, y)] },                                            // 1 PolygonZ with M
    null,                                                                                     // 2 null shape
    { type: 1, point: [x, y] },                                                              // 3 a point
    { type: 5, parts: [sq(x, y + 4 * d, 4 * d), ccw(sq(x + d, y + 5 * d, d)), ccw(sq(x + 9 * d, y + 9 * d))] }, // 4 outer + hole + disjoint CCW part
    { type: 5, parts: [sq(x + 4 * d, y).slice(0, 4)] },                                     // 5 unclosed
    { type: 5, parts: [[[x, y], [x + d, y], [x, y], [x + d, y]]] },                          // 6 two distinct points
    { type: 5, parts: [sq(x + 6 * d, y), [[x, y], [x + d, y + d], [x + 2 * d, y + 2 * d], [x, y]]] }, // 7 good ring + zero-area ring
    { type: 25, parts: [sq(x + 8 * d, y)] },                                                 // 8 PolygonM
    { type: 5, parts: [[[x, y], [NaN, y], [x + d, y + d], [x, y]]] },                       // 9 NaN vertex
    { type: 5, parts: [] },                                                                  // 10 zero parts
  ];
  const { shp, shx } = shapefile(records);
  const table = dbf([{ name: 'rec', type: 'N', len: 4 }], records.map((_, i) => [String(i)]));
  const design = await readDesignFiles([zipFile('edge.zip', partsList('edge', { shp, shx, dbf: table, prj: WKT.wgs84, cpg: 'UTF-8' }))]);
  const recs = design.plots.map(p => p.props.rec);
  ok('kept records: plain, Z, multipart, unclosed, one good ring of 7, M', same(recs, ['0', '1', '4', '5', '7', '8']), recs.join(','));
  const byRec = r => design.plots[recs.indexOf(r)];
  ok('PolygonZ: Z and M dropped, XY exact', same(byRec('1').rings, [sq(x + 2 * d, y)]) && byRec('1').rings[0].every(p => p.length === 2));
  ok('PolygonM reads like a Polygon', same(byRec('8').rings, [sq(x + 8 * d, y)]));
  ok('multipart: outer, hole AND the disjoint counter-clockwise part all kept (shpjs drops that last one)',
    same(byRec('4').rings, records[4].parts));
  ok('an unclosed ring is accepted and returned closed', same(byRec('5').rings, [sq(x + 4 * d, y)]));
  ok('a degenerate ring next to a good one: only the good one stays', same(byRec('7').rings, [sq(x + 6 * d, y)]));
  ok('warnings: one per kind, aggregated', same(design.warnings, [
    'Skipped 1 feature that is not a polygon (1 Point).',
    'Skipped 1 feature with no geometry.',
    'Skipped 1 feature with invalid or non-finite coordinates.',
    'Dropped 3 empty or degenerate rings (fewer than 3 distinct points, or no area); 2 features had nothing else and were skipped.',
    'No column is named like a variety; varieties were guessed from "rec". Pick another column if that is wrong.',
  ]), JSON.stringify(design.warnings));

  const several = shapefile([null, { type: 1, point: [x, y] }, { type: 1, point: [x, y] }, { type: 3, parts: [sq(x, y)] }]);
  const eNone = await rejection(() => readDesignFiles([zipFile('pts.zip', partsList('pts', { ...several, prj: WKT.wgs84 }))]));
  ok('a layer with no polygon at all is refused, saying what it found',
    refuses(eNone, /^"pts\.shp" holds no usable plot polygons \(features found: 2 Point, 1 LineString; 1 without geometry\)\. A design must be the plots drawn as polygons\.$/), eNone?.message);

  const cut = shapefile([{ type: 5, parts: [sq(x, y)] }, { type: 5, parts: [sq(x + 2 * d, y)] }]).shp;
  const truncated = cut.subarray(0, cut.length - 30);
  const t = await readDesignFiles([zipFile('cut.zip', partsList('cut', { shp: truncated, prj: WKT.wgs84 }))]);
  ok('a .shp cut mid-record keeps the whole records and says so',
    t.plots.length === 1 && t.warnings.some(w => w === '"cut.shp" ends in the middle of a record; 1 shape could be read.'), JSON.stringify(t.warnings));
  ok('a .shp without .dbf: plots with no attributes, and a warning',
    same(t.columns, []) && t.warnings.includes('"cut.shp" came without its .dbf, so the plots have no attributes.'));

  const two = shapefile([{ type: 5, parts: [sq(x, y)] }, { type: 5, parts: [sq(x + 2 * d, y)] }]).shp;
  const padded = await readDesignFiles([zipFile('pad.zip', partsList('pad', { shp: concat(two, new Uint8Array(64)), prj: WKT.wgs84 }))]);
  ok('bytes padded after the header\'s file length are not read as shapes',
    padded.plots.length === 2 && !padded.warnings.some(w => /no geometry|middle of a record/.test(w)), JSON.stringify(padded.warnings));

  const eShp = await rejection(() => readDesignFiles([file('bad.shp', new Uint8Array(120)), file('bad.prj', WKT.wgs84)]));
  ok('a .shp without the 9994 file code is refused', refuses(eShp, /^"bad\.shp" is not a valid shapefile \(\.shp\)\.$/), eShp?.message);

  // A 3 x 3 grid of 3 m plots in local metres spans 9 units: inside the span test.
  const micro = shapefile(Array.from({ length: 9 }, (_, i) => {
    const u = (i % 3) * 3, v = Math.floor(i / 3) * 3;
    return { type: 5, parts: [[[u, v], [u, v + 3], [u + 3, v + 3], [u + 3, v], [u, v]]] };
  }));
  const eMicro = await rejection(() => readDesignFiles([zipFile('m.zip', partsList('micro', { ...micro }))]));
  ok('no .prj and a 9 m local metre grid: refused by its plot size, not read as 330 km plots',
    refuses(eMicro, /^"micro\.shp" has coordinates that are not longitude\/latitude \(e\.g\. 0, 0\)\. The \.prj file that says which coordinate system they are in is missing/), eMicro?.message);
  const eMicroWgs = await rejection(() => readDesignFiles([zipFile('m.zip', partsList('micro', { ...micro, prj: WKT.wgs84 }))]));
  ok('... and under a WGS84 .prj, refused blaming the .prj', refuses(eMicroWgs, /^"micro\.shp" has coordinates that are not longitude\/latitude .*Its \.prj says they are longitude\/latitude/), eMicroWgs?.message);

  const beyond = { type: 5, parts: [[[5e7, 1000], [5e7, 1010], [5e7 + 10, 1010], [5e7 + 10, 1000], [5e7, 1000]]] };
  const eUnprojected = await rejection(() => readDesignFiles([zipFile('u.zip', partsList('u', { ...shapefile([beyond]), prj: WKT.utm31n }))]));
  ok('coordinates the .prj cannot project are refused as such, not as "invalid coordinates"',
    refuses(eUnprojected, /^"u\.shp" could not be reprojected from its coordinate system \(WGS_1984_UTM_Zone_31N\)\. Export the layer in WGS84/), eUnprojected?.message);
  const someUnprojected = await readDesignFiles([zipFile('u.zip', partsList('u', { ...shapefile([...TRIAL.slice(0, 3).map(p => ({ type: 5, parts: [p.utm] })), beyond]), prj: WKT.utm31n }))]);
  ok('... and beside good plots, skipped with a warning',
    someUnprojected.plots.length === 3 && someUnprojected.warnings.includes('Skipped 1 feature whose coordinates could not be reprojected from WGS_1984_UTM_Zone_31N.'), JSON.stringify(someUnprojected.warnings));
}

console.log('\nD. DBF text encodings and values');
{
  const x = 4.7, y = 50.6, d = 0.0001;
  const sq = i => [[x + 2 * i * d, y], [x + 2 * i * d, y + d], [x + (2 * i + 1) * d, y + d], [x + (2 * i + 1) * d, y], [x + 2 * i * d, y]];
  const shp3 = shapefile([0, 1, 2].map(i => ({ type: 5, parts: [sq(i)] })));
  const fields = [{ name: 'nom', type: 'C', len: 20 }, { name: 'bout', type: 'C', len: 5 }];
  const rows = [['Blé tendre', 'été'], ['Maïs grain', 'abcdé'], ['Betterave', 'x']];
  const read = (table, cpg) => readDesignFiles([zipFile('enc.zip', partsList('enc', { ...shp3, dbf: table, prj: WKT.wgs84, cpg }))]);
  const accents = dsg => dsg.plots[0].props.nom === 'Blé tendre' && dsg.plots[1].props.nom === 'Maïs grain' && dsg.plots[0].props.bout === 'été';
  const encWarnings = dsg => dsg.warnings.filter(w => /UTF-8|Windows-1252|encoding/.test(w));

  const l1 = dbf(fields, rows, { encode: latin1, ldid: 0x57 });
  const a = await read(l1, 'ISO-8859-1');
  ok('Latin-1 with .cpg ISO-8859-1: accents right, no warning', accents(a) && encWarnings(a).length === 0, `${a.plots[0].props.nom} ${JSON.stringify(encWarnings(a))}`);
  const b = await read(l1, '1252');
  ok('Latin-1 with .cpg 1252: accents right', accents(b) && encWarnings(b).length === 0);
  const b2 = await read(l1, 'ANSI 1252');
  ok('Latin-1 with .cpg "ANSI 1252": accents right', accents(b2) && encWarnings(b2).length === 0);
  const c = await read(l1, undefined);
  ok('Latin-1 without .cpg: detected (not UTF-8), read as Windows-1252, with a warning',
    accents(c) && same(encWarnings(c), ['"enc.dbf" has no .cpg file and its text is not UTF-8, so it was read as Windows-1252 (Latin-1). If accents look wrong, include the .cpg file.']),
    `${c.plots[0].props.nom} ${JSON.stringify(encWarnings(c))}`);
  const c2 = await read(dbf(fields, rows, { encode: latin1, ldid: 0 }), undefined);
  ok('Latin-1 without .cpg nor language driver: still Windows-1252', accents(c2) && encWarnings(c2).length === 1);
  const u = dbf(fields, rows);
  const e = await read(u, undefined);
  ok('UTF-8 without .cpg: read as UTF-8, no warning', accents(e) && encWarnings(e).length === 0, e.plots[0].props.nom);
  ok('UTF-8 cut inside a character by the field width: the whole characters kept', e.plots[1].props.bout === 'abcd', JSON.stringify(e.plots[1].props.bout));
  const f = await read(u, 'UTF-8');
  ok('UTF-8 with .cpg UTF-8', accents(f) && encWarnings(f).length === 0);
  const g = await read(l1, 'UTF-8');
  ok('a .cpg claiming UTF-8 over Latin-1 bytes is overruled, with a warning',
    accents(g) && same(encWarnings(g), ['"enc.cpg" says UTF-8 but the text in "enc.dbf" is not UTF-8; it was read as Windows-1252 (Latin-1).']), JSON.stringify(encWarnings(g)));
  const h = await read(u, 'FOO-9');
  ok('an unknown .cpg over UTF-8 bytes: UTF-8, and the .cpg is named', accents(h) && /names an encoding the designer does not know \("FOO-9"\)/.test(encWarnings(h)[0] ?? ''));

  const numFields = [
    { name: 'one', type: 'N', len: 19, dec: 11 }, { name: 'neg', type: 'N', len: 10, dec: 2 }, { name: 'long', type: 'N', len: 18 },
    { name: 'blank', type: 'N', len: 10, dec: 2 }, { name: 'noise', type: 'F', len: 20, dec: 18 }, { name: 'over', type: 'N', len: 5 },
    { name: 'day', type: 'D', len: 8 }, { name: 'flag', type: 'L', len: 1 }, { name: 'expo', type: 'N', len: 10 }, { name: 'lead', type: 'N', len: 6 },
    { name: 'dup', type: 'C', len: 3 }, { name: 'dup', type: 'C', len: 3 }, { name: '', type: 'C', len: 3 },
  ];
  const numRows = [
    ['1.00000000000', '-0.50', '123456789012345678', '', '0.300000000000000044', '*****', '20241015', 'T', '1.5E+03', '007', 'a', 'b', 'c'],
    ['2.50000000000', '-0.00', '000000000000000001', '', '1.000000000000000000', '12', '', '?', '-2', '+3.10', 'd', 'e', 'f'],
    ['3', '0', '9', '', '0.5', '1', '00000000', 'f', '0', '0', 'g', 'h', 'i'],
  ];
  const num = await read(dbf(numFields, numRows, { deleted: [] }), 'UTF-8');
  const [r0, r1, r2] = num.plots.map(p => p.props);
  ok('"1.00000000000" -> "1", "2.50000000000" -> "2.5"', r0.one === '1' && r1.one === '2.5', `${r0.one} ${r1.one}`);
  ok('"-0.50" -> "-0.5", "-0.00" -> "0"', r0.neg === '-0.5' && r1.neg === '0', `${r0.neg} ${r1.neg}`);
  ok('an 18-digit integer stays exact (no double round trip)', r0.long === '123456789012345678' && r1.long === '1', `${r0.long} ${r1.long}`);
  ok('a blank number is ""', r0.blank === '');
  ok('binary noise in a long fraction is rounded away', r0.noise === '0.3' && r1.noise === '1', `${r0.noise} ${r1.noise}`);
  ok('the dBASE overflow marker ***** is ""', r0.over === '' && r1.over === '12');
  ok('dates: ISO, blank and 00000000 are ""', r0.day === '2024-10-15' && r1.day === '' && r2.day === '');
  ok('logicals: T true, f false, ? ""', r0.flag === 'true' && r2.flag === 'false' && r1.flag === '');
  ok('exponent and signs: 1.5E+03 -> 1500, 007 -> 7, +3.10 -> 3.1', r0.expo === '1500' && r0.lead === '7' && r1.lead === '3.1', `${r0.expo} ${r0.lead} ${r1.lead}`);
  ok('a repeated field name gets a suffix, an empty one a placeholder', same(num.columns.slice(-3), ['dup', 'dup_2', 'field_13']), num.columns.slice(-3).join(','));
  ok('... and each keeps its own values', r0.dup === 'a' && r0.dup_2 === 'b' && r0.field_13 === 'c');

  const del = await read(dbf(fields, rows, { deleted: [1] }), 'UTF-8');
  ok('a row marked deleted drops its feature, with a warning',
    same(del.plots.map(p => p.props.nom), ['Blé tendre', 'Betterave']) && del.warnings.includes('Skipped 1 feature marked as deleted in "enc.dbf".'), JSON.stringify(del.warnings));
  const short = await read(dbf(fields, rows.slice(0, 2)), 'UTF-8');
  ok('fewer rows than shapes: the extra shape has empty attributes, and a warning',
    short.plots.length === 3 && short.plots[2].props.nom === '' && short.warnings.includes('"enc.dbf" has 2 rows but "enc.shp" has 3 shapes; the extra shapes have empty attributes.'), JSON.stringify(short.warnings));
  const eDbf = await rejection(() => read(new Uint8Array(20), 'UTF-8'));
  ok('a truncated .dbf is refused', refuses(eDbf, /^"enc\.dbf" is not a valid \.dbf attribute table\.$/), eDbf?.message);

  // GDAL's default shapefile: no .cpg, language driver 1252, Latin-1 field names over ASCII values.
  const named = await read(dbf([{ name: 'Parcelle', type: 'C', len: 4 }, { name: 'Variété', type: 'C', len: 8 }], [['P1', 'Apache'], ['P2', 'Rubisko'], ['P3', 'Apache']], { encode: latin1, ldid: 0x57 }), undefined);
  ok('a Latin-1 column NAME over ASCII values, no .cpg: "Variété" reads right and is the variety column',
    same(named.columns, ['Parcelle', 'Variété']) && named.varietyColumn === 'Variété' && varietiesOf(named).length === 2, `${named.columns} / ${named.varietyColumn}`);
  const roses = await read(dbf([{ name: 'Variete', type: 'C', len: 4 }], [['Rosé'], ['Rosè'], ['Rosé']], { encode: latin1, ldid: 0x57 }), undefined);
  ok('Latin-1 accents that fill the field (a lone lead byte at its end), no .cpg: not cut UTF-8, "Rosé" and "Rosè" stay two varieties',
    same(roses.plots.map(p => p.props.Variete), ['Rosé', 'Rosè', 'Rosé']) && varietiesOf(roses).length === 2 && encWarnings(roses).length === 1, JSON.stringify(roses.plots.map(p => p.props.Variete)));
  const cutOnly = dbf([{ name: 'bout', type: 'C', len: 5 }], [['abcdé'], ['x'], ['y']]);
  const trusted = await read(cutOnly, 'UTF-8');
  ok('... while a .cpg saying UTF-8 is believed over the same ambiguous cut', trusted.plots[0].props.bout === 'abcd' && encWarnings(trusted).length === 0, JSON.stringify(trusted.plots[0].props.bout));
}

console.log('\nE. loose shapefile parts selected together');
{
  const parts = trialParts();
  const loose = [
    file('Trial.SHP', parts.shp), file('Trial.shx', parts.shx), file('Trial.dbf', parts.dbf), file('Trial.PRJ', parts.prj), file('Trial.cpg', parts.cpg),
    file('Trial.shp.xml', '<metadata/>'), file('notes.txt', 'hello'),
  ];
  const design = await readDesignFiles(loose);
  const zipped = await readDesignFiles([zipFile('trial.zip', partsList('trial', parts))]);
  ok('loose parts read the same plots and attributes as the zip', same(design.plots, zipped.plots) && same(design.columns, zipped.columns));
  ok('fileName is the .shp the user picked', design.fileName === 'Trial.SHP', design.fileName);
  ok('sidecars (.shp.xml) pass silently; an unrelated file is named in a warning',
    same(design.warnings, ['Ignored 1 file that is not part of a design: notes.txt.']), JSON.stringify(design.warnings));
  const e1 = await rejection(() => readDesignFiles([file('Trial.dbf', parts.dbf), file('Trial.prj', parts.prj)]));
  ok('a .dbf without its .shp is refused', refuses(e1, /^"Trial\.dbf" has no matching \.shp file: select the \.shp together with its \.dbf and \.prj, or upload them zipped\.$/), e1?.message);
  const e2 = await rejection(() => readDesignFiles([file('Trial.prj', parts.prj)]));
  ok('a lone .prj is refused as not a design', refuses(e2, /^"Trial\.prj" alone is not a design/), e2?.message);
  const e3 = await rejection(() => readDesignFiles([file('plots.csv', 'a,b')]));
  ok('an unsupported file is refused, listing what is accepted', refuses(e3, /^"plots\.csv" is not a design file the designer can read\. Upload a zipped shapefile/), e3?.message);
  const upper = await readDesignFiles([file('TRIAL.ZIP', zip(partsList('trial', parts)))]);
  ok('extensions are case-insensitive (.ZIP)', upper.plots.length === 50);
}

console.log('\nF. archives and several layers');
{
  const parts = trialParts();
  const border = shapefile([{ type: 5, parts: [TRIAL[0].lonlat] }]);
  const two = await readDesignFiles([zipFile('two.zip', [
    ...partsList('border', { ...border, prj: WKT.wgs84 }),
    ...partsList('data/trial', parts),
  ])]);
  ok('two layers: the one with the most plots is used', two.plots.length === 50 && two.columns.includes('Germplasm'));
  ok('... and the choice is explained', two.warnings[0] === 'The upload holds 2 polygon layers; using "data/trial.shp" (50 plots) and ignoring "border.shp" (1 plot).', two.warnings[0]);

  const broken = await readDesignFiles([zipFile('mixed.zip', [
    ...partsList('trial', parts),
    ...partsList('projected', { ...trialParts('utm31n', { prj: false }) }),
  ])]);
  ok('a layer that fails beside a good one is ignored with its reason',
    broken.plots.length === 50 && broken.warnings.some(w => /^Another layer was ignored: "projected\.shp" has coordinates that are not longitude\/latitude/.test(w)), JSON.stringify(broken.warnings));

  const deflated = await readDesignFiles([zipFile('deflate.zip', [
    { name: '__MACOSX/._trial.shp', data: utf8('junk') },
    { name: '._trial.dbf', data: utf8('junk') },
    { name: 'readme.txt', data: utf8('not a layer') },
    ...partsList('trial', parts),
  ], { deflate: true })]);
  ok('a DEFLATE zip reads; Finder junk and readme are skipped silently', deflated.plots.length === 50 && deflated.warnings.length === 0, JSON.stringify(deflated.warnings));

  const gj = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { v: 'A' }, geometry: { type: 'Polygon', coordinates: [TRIAL[0].lonlat] } }] };
  const inZip = await readDesignFiles([zipFile('gj.zip', [{ name: 'layer.geojson', data: utf8(JSON.stringify(gj)) }])]);
  ok('a zip holding GeoJSON reads it; fileName stays the zip', inZip.plots.length === 1 && inZip.fileName === 'gj.zip');

  const eEmpty = await rejection(() => readDesignFiles([zipFile('empty.zip', [{ name: 'readme.txt', data: utf8('x') }])]));
  ok('a zip with no layer is refused', refuses(eEmpty, /^"empty\.zip" holds no shapefile, GeoJSON or KML\.$/), eEmpty?.message);
  const ePrjOnly = await rejection(() => readDesignFiles([zipFile('prj.zip', [{ name: 'trial.prj', data: utf8(WKT.wgs84) }])]));
  ok('a zip holding only a .prj is refused the same way', refuses(ePrjOnly, /^"prj\.zip" holds no shapefile, GeoJSON or KML\.$/), ePrjOnly?.message);
  const beside = await readDesignFiles([zipFile('empty.zip', [{ name: 'readme.txt', data: utf8('x') }]), zipFile('trial.zip', partsList('trial', parts))]);
  ok('an empty zip beside a good one is named in a warning', beside.plots.length === 50 && beside.warnings.includes('"empty.zip" holds no shapefile, GeoJSON or KML and was ignored.'), JSON.stringify(beside.warnings));
  const eDamaged = await rejection(() => readDesignFiles([file('broken.zip', utf8('PK this is not really a zip archive at all'))]));
  ok('a damaged zip is refused', refuses(eDamaged, /^"broken\.zip" could not be unzipped: it is damaged or not a zip archive\.$/), eDamaged?.message);
  // Both of these used to spin forever inside but-unzip: its search for the
  // central directory restarts from the end when the last "P" is byte 0.
  const whole = zip(partsList('trial', trialParts()));
  const eCut = await rejection(() => readDesignFiles([file('cut.zip', whole.subarray(0, whole.length - 30))]));
  ok('a truncated download (no central directory) is refused, not hung on', refuses(eCut, /^"cut\.zip" could not be unzipped/), eCut?.message);
  const eTiny = await rejection(() => readDesignFiles([file('tiny.zip', utf8('PK'))]));
  ok('a two-byte "PK" file is refused, not hung on', refuses(eTiny, /^"tiny\.zip" could not be unzipped/), eTiny?.message);

  // GDAL's LIBKML driver writes a KMZ as a doc.kml that only links layers/<name>.kml.
  const linkDoc = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><NetworkLink><Link><href>layers/trial.kml</href></Link></NetworkLink></Document></kml>';
  const layerKml = `<kml><Document>${TRIAL.slice(0, 2).map((p, i) => `<Placemark><name>P${i}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${p.lonlat.map(q => q.join(',')).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`).join('')}</Document></kml>`;
  const libkml = await readDesignFiles([zipFile('trial.kmz', [{ name: 'doc.kml', data: utf8(linkDoc) }, { name: 'layers/trial.kml', data: utf8(layerKml) }])]);
  ok('a GDAL-style KMZ: the linked layer is read and the link-only doc.kml is not reported as a lost layer',
    libkml.plots.length === 2 && !libkml.warnings.some(w => /doc\.kml|layer/.test(w)), JSON.stringify(libkml.warnings));
  const eLinks = await rejection(() => readDesignFiles([zipFile('links.kmz', [{ name: 'doc.kml', data: utf8(linkDoc) }])]));
  ok('a KMZ that only links elsewhere is refused, saying so',
    refuses(eLinks, /^"doc\.kml" holds no placemarks, only links to other files \(NetworkLink\), which the designer does not follow\.$/), eLinks?.message);
}

console.log('\nG. GeoJSON');
{
  const d = 0.0001;
  const sq = (x, y, s = d) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
  const x = 4.7, y = 50.6;
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'A', n: 1, noise: 0.1 + 0.2, flag: true, nothing: null, obj: { a: [1, 2] }, spaced: '  padded  ' }, geometry: { type: 'Polygon', coordinates: [sq(x, y)] } },
      { type: 'Feature', properties: { late: 'L', name: 'B' }, geometry: { type: 'MultiPolygon', coordinates: [[sq(x + 2 * d, y, 4 * d), sq(x + 3 * d, y + d)], [sq(x + 8 * d, y)]] } },
      { type: 'Feature', properties: null, geometry: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [x, y] }, { type: 'Polygon', coordinates: [sq(x + 10 * d, y)] }] } },
      { type: 'Feature', properties: { name: 'Z' }, geometry: { type: 'Polygon', coordinates: [sq(x + 12 * d, y).map(([a, b]) => [a, b, 99, 7])] } },
      { type: 'Feature', properties: { name: 'open' }, geometry: { type: 'Polygon', coordinates: [sq(x + 14 * d, y).slice(0, 4)] } },
      { type: 'Feature', properties: { name: 'pt' }, geometry: { type: 'Point', coordinates: [x, y] } },
      { type: 'Feature', properties: { name: 'nogeom' }, geometry: null },
      { type: 'Feature', properties: { name: 'str' }, geometry: { type: 'Polygon', coordinates: [[[x, y], ['4.7', y], [x + d, y + d], [x, y]]] } },
      { type: 'Feature', properties: { name: 'line' }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + 2 * d, y], [x, y]]] } },
      { type: 'Feature', properties: { name: 'empty' }, geometry: { type: 'MultiPolygon', coordinates: [] } },
    ],
  };
  const text = JSON.stringify(fc).replace('"coordinates":[[[4.7,50.6],["4.7"', '"coordinates":[[[4.7,50.6],[1e999');
  const design = await readDesignFiles([file('plots.geojson', String.fromCharCode(0xfeff) + text)]);
  ok('a BOM is tolerated', design.plots.length > 0);
  ok('kept: Polygon, MultiPolygon, GeometryCollection, Z, unclosed', same(design.plots.map(p => p.props.name), ['A', 'B', '', 'Z', 'open']), design.plots.map(p => p.props.name).join(','));
  ok('columns: union of property keys in order of first appearance', same(design.columns, ['name', 'n', 'noise', 'flag', 'nothing', 'obj', 'spaced', 'late']), design.columns.join(','));
  const pa = design.plots[0].props;
  ok('values: 1 -> "1", 0.1+0.2 -> "0.3", true -> "true", null -> "", objects as JSON, strings trimmed',
    pa.n === '1' && pa.noise === '0.3' && pa.flag === 'true' && pa.nothing === '' && pa.obj === '{"a":[1,2]}' && pa.spaced === 'padded' && pa.late === '', JSON.stringify(pa));
  ok('a column a feature lacks is ""; properties: null gives all ""', design.plots[1].props.n === '' && Object.values(design.plots[2].props).every(v => v === ''));
  ok('MultiPolygon: both polygons and the hole, three rings', same(design.plots[1].rings, [sq(x + 2 * d, y, 4 * d), sq(x + 3 * d, y + d), sq(x + 8 * d, y)]));
  ok('GeometryCollection: its polygon is kept, its point ignored', same(design.plots[2].rings, [sq(x + 10 * d, y)]));
  ok('Z and M dropped', same(design.plots[3].rings, [sq(x + 12 * d, y)]));
  ok('an unclosed ring comes back closed', same(design.plots[4].rings, [sq(x + 14 * d, y)]));
  ok('warnings: not polygons, no geometry, invalid (Infinity from 1e999), degenerate/empty', same(design.warnings, [
    'Skipped 1 feature that is not a polygon (1 Point).',
    'Skipped 1 feature with no geometry.',
    'Skipped 1 feature with invalid or non-finite coordinates.',
    'Dropped 2 empty or degenerate rings (fewer than 3 distinct points, or no area); 2 features had nothing else and were skipped.',
    'No column is named like a variety; varieties were guessed from "n". Pick another column if that is wrong.',
  ]), JSON.stringify(design.warnings));
  // "name" is all-distinct but empty on one plot; "n" ("1" once, "" four times)
  // is the first column that repeats without being constant, so it is the guess,
  // and a name column needs every plot named.
  ok('the detected variety and name columns', design.varietyColumn === 'n' && design.nameColumn === '', `${design.varietyColumn} / ${design.nameColumn}`);

  const single = await readDesignFiles([file('one.json', JSON.stringify({ type: 'Feature', properties: { variety: 'V' }, geometry: { type: 'Polygon', coordinates: [sq(x, y)] } }))]);
  ok('.json holding one Feature', single.plots.length === 1 && single.fileName === 'one.json' && single.varietyColumn === 'variety');
  const bare = await readDesignFiles([file('bare.geojson', JSON.stringify({ type: 'Polygon', coordinates: [sq(x, y)] }))]);
  ok('a bare geometry: one plot, no columns, every plot its own variety',
    bare.plots.length === 1 && same(bare.columns, []) && bare.varietyColumn === '' && same(bare.warnings, ['The file has no attributes, so every plot is its own variety.']), JSON.stringify(bare.warnings));

  const fcIn = (coords, crs) => JSON.stringify({ type: 'FeatureCollection', crs, features: coords.map((c, i) => ({ type: 'Feature', properties: { id: i }, geometry: { type: 'Polygon', coordinates: [c] } })) });
  const trialIn = key => TRIAL.slice(0, 3).map(p => p[key]);
  const expect3 = TRIAL.slice(0, 3).map(p => [p.lonlat]);
  const within = (dsg, tol = 1e-9) => dsg.plots.length === 3 && dsg.plots.every((p, i) => maxDeviation(p.rings, expect3[i]) < tol);

  const g2154 = await readDesignFiles([file('l93.geojson', fcIn(trialIn('l93'), { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::2154' } }))]);
  ok('legacy crs urn:ogc:def:crs:EPSG::2154 is reprojected', within(g2154) && g2154.warnings[0] === 'Reprojected "l93.geojson" from EPSG:2154 (its "crs" member) to WGS84 longitude/latitude.', g2154.warnings[0]);
  const g32631 = await readDesignFiles([file('utm.geojson', fcIn(trialIn('utm'), { type: 'name', properties: { name: 'http://www.opengis.net/def/crs/EPSG/0/32631' } }))]);
  ok('crs http://www.opengis.net/def/crs/EPSG/0/32631 is reprojected', within(g32631));
  const merc = TRIAL.slice(0, 3).map(p => p.lonlat.map(q => proj4('WGS84', 'EPSG:3857', q)));
  const g3857 = await readDesignFiles([file('m.geojson', fcIn(merc, { type: 'EPSG', properties: { code: 3857 } }))]);
  ok('the old {"type":"EPSG","properties":{"code":3857}} form is honoured', within(g3857, 1e-8));
  const utm6 = TRIAL.slice(0, 3).map(p => p.lonlat.map(q => proj4('WGS84', '+proj=utm +zone=31 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs', q)));
  const g25831 = await readDesignFiles([file('etrs.geojson', fcIn(utm6, { type: 'name', properties: { name: 'EPSG:25831' } }))]);
  ok('ETRS89 / UTM 31N (EPSG:25831) is reprojected', within(g25831, 1e-8));
  const g84 = await readDesignFiles([file('crs84.geojson', fcIn(trialIn('lonlat'), { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }))]);
  ok('CRS84 is plain lon/lat, no reprojection warning', within(g84) && !g84.warnings.some(w => /Reprojected/.test(w)));
  const g4258 = await readDesignFiles([file('etrs89.geojson', fcIn(trialIn('lonlat'), { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4258' } }))]);
  ok('EPSG:4258 is read as WGS84, and the reader says so', within(g4258) && g4258.warnings[0] === '"etrs89.geojson": EPSG:4258 was read as WGS84 (the two differ by about a metre).', g4258.warnings[0]);

  const e84 = await rejection(() => readDesignFiles([file('m84.geojson', fcIn(trialIn('utm'), { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }))]));
  ok('metres under a CRS84 crs: refused, blaming the crs member', refuses(e84, /Its "crs" member says longitude\/latitude, but the numbers are not/), e84?.message);
  const proto = await readDesignFiles([file('proto.geojson', JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { constructor: 'C1', toString: 'T' }, geometry: { type: 'Polygon', coordinates: [sq(x, y)] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [sq(x + 2 * d, y)] } },
  ] }))]);
  ok('a column named "constructor" that a plot lacks reads "", never an inherited function',
    proto.plots[1].props.constructor === '' && proto.plots[1].props.toString === '' && varietiesOf({ ...proto, varietyColumn: 'constructor' }).map(v => v.key).join('|') === 'C1|', JSON.stringify(proto.plots[1].props));

  const blankKey = await readDesignFiles([file('blank.geojson', JSON.stringify({ type: 'FeatureCollection', features: Array.from({ length: 6 }, (_, i) => ({
    type: 'Feature', properties: { '': i % 2 ? 'Apache' : 'Rubisko', plot: `P${i}` }, geometry: { type: 'Polygon', coordinates: [sq(x + 2 * i * d, y)] },
  })) }))]);
  ok('a property with an empty name becomes "field_1", never the "no variety column" sentinel',
    same(blankKey.columns, ['field_1', 'plot']) && blankKey.varietyColumn === 'field_1' && varietiesOf(blankKey).length === 2, `${JSON.stringify(blankKey.columns)} / ${JSON.stringify(blankKey.varietyColumn)}`);
  const placeholder = { type: 'FeatureCollection', features: [
    ...TRIAL.slice(0, 5).map(p => ({ type: 'Feature', properties: { Germplasm: 'A' }, geometry: { type: 'Polygon', coordinates: [p.lonlat] } })),
    { type: 'Feature', properties: { Germplasm: 'EMPTY' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0, 0], [0, 0]]] } },
  ] };
  const held = await readDesignFiles([file('placeholder.geojson', JSON.stringify(placeholder))]);
  ok('a degenerate placeholder at 0,0 is dropped and its coordinates do not fail the real plots',
    held.plots.length === 5 && held.warnings[0] === 'Dropped 1 empty or degenerate ring (fewer than 3 distinct points, or no area); 1 feature had nothing else and was skipped.', JSON.stringify(held.warnings));

  const e1 = await rejection(() => readDesignFiles([file('ntf.geojson', fcIn(trialIn('l93'), { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::27572' } }))]));
  ok('an EPSG code the reader has no definition for is refused', refuses(e1, /^"ntf\.geojson" is in the coordinate system "urn:ogc:def:crs:EPSG::27572", which the designer cannot reproject\. Export it in WGS84 \(EPSG:4326\) and import it again\.$/), e1?.message);
  const e2 = await rejection(() => readDesignFiles([file('link.geojson', fcIn(trialIn('l93'), { type: 'link', properties: { href: 'http://example.org/crs', type: 'proj4' } }))]));
  ok('a linked crs is refused', refuses(e2, /declares its coordinate system in a form the designer cannot read/), e2?.message);
  const e3 = await rejection(() => readDesignFiles([file('l93.geojson', fcIn(trialIn('l93')))]));
  ok('projected numbers without a crs are refused, pointing at WGS84',
    refuses(e3, /^"l93\.geojson" has coordinates that are not longitude\/latitude \(e\.g\. \d+(\.\d+)?, \d+(\.\d+)?\)\. GeoJSON must be in WGS84 \(EPSG:4326\)/), e3?.message);
  const eDegrees = await rejection(() => readDesignFiles([file('deg.geojson', fcIn(trialIn('lonlat'), { type: 'name', properties: { name: 'EPSG:2154' } }))]));
  ok('degrees under a Lambert-93 "crs" member are refused', refuses(eDegrees, /^"deg\.geojson" has coordinates that look like longitude\/latitude .* but its coordinate system \(EPSG:2154\) is in metres/), eDegrees?.message);
  const e4 = await rejection(() => readDesignFiles([file('bad.geojson', '{"type": "FeatureCollection", ')]));
  ok('invalid JSON is refused', refuses(e4, /^"bad\.geojson" is not valid JSON \(/), e4?.message);
  const e5 = await rejection(() => readDesignFiles([file('other.json', '{"rows": []}')]));
  ok('JSON that is not GeoJSON is refused', refuses(e5, /^"other\.json" is not GeoJSON/), e5?.message);
  const e6 = await rejection(() => readDesignFiles([file('topo.json', '{"type": "Topology", "objects": {}}')]));
  ok('TopoJSON is refused by name', refuses(e6, /is TopoJSON/), e6?.message);
}

console.log('\nH. KML and KMZ');
{
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE kml [ <!ENTITY junk "ignored"> ]>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2" xmlns:kml="http://www.opengis.net/kml/2.2">
<!-- <Placemark><name>commented out</name></Placemark> -->
<Document><name>Trial</name>
  <Schema name="plots" id="plots"><SimpleField name="Vari&#233;t&#xE9;" type="string"/></Schema>
  <Folder><name>plots</name>
    <Placemark id="p1">
      <name><![CDATA[P1 <A&B>]]></name>
      <description>Bl&#233; &amp; co line<br>two</description>
      <ExtendedData><SchemaData schemaUrl="#plots">
        <SimpleData name="Vari&#233;t&#xE9;">Alpha</SimpleData><SimpleData name="Bloc">1</SimpleData>
      </SchemaData></ExtendedData>
      <Style><PolyStyle><color>ff00ff00</color></PolyStyle></Style>
      <Polygon><extrude>0</extrude><outerBoundaryIs><LinearRing><coordinates>
        4.7,50.6,0 4.7001,50.6,0
        4.7001,50.6001,0	4.7,50.6001,0
        4.7,50.6,0
      </coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>4.70004,50.60004 4.70006,50.60004 4.70006,50.60006 4.70004,50.60004</coordinates></LinearRing></innerBoundaryIs>
      </Polygon>
    </Placemark>
    <kml:Placemark>
      <kml:name>P2</kml:name>
      <kml:ExtendedData><kml:Data name="Vari&#233;t&#xE9;"><kml:displayName>Variety</kml:displayName><kml:value>Beta &lt;2&gt;</kml:value></kml:Data></kml:ExtendedData>
      <kml:MultiGeometry>
        <kml:Point><kml:coordinates>4.7002,50.6</kml:coordinates></kml:Point>
        <kml:Polygon><kml:outerBoundaryIs><kml:LinearRing><kml:coordinates>4.7002,50.6 4.7003,50.6 4.7003,50.6001 4.7002,50.6001 4.7002,50.6</kml:coordinates></kml:LinearRing></kml:outerBoundaryIs></kml:Polygon>
        <kml:MultiGeometry><kml:Polygon><kml:outerBoundaryIs><kml:LinearRing><kml:coordinates>4.7004,50.6 4.7005,50.6 4.7005,50.6001 4.7004,50.6</kml:coordinates></kml:LinearRing></kml:outerBoundaryIs></kml:Polygon></kml:MultiGeometry>
      </kml:MultiGeometry>
    </kml:Placemark>
    <Placemark><name>marker</name><Point><coordinates>4.7,50.6</coordinates></Point></Placemark>
    <Placemark><name>P3</name><Polygon><outerBoundaryIs><LinearRing><coordinates>4.7006, 50.6 4.7007, 50.6 4.7007, 50.6001 4.7006, 50.6001</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    <Placemark><name>bad</name><Polygon><outerBoundaryIs><LinearRing><coordinates>4.7,50.6 x,50.6 4.7001,50.6001</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  </Folder>
</Document>
</kml>`;
  const design = await readDesignFiles([file('trial.kml', kml)]);
  ok('three polygon placemarks; the commented one, the point and the bad one are not plots',
    same(design.plots.map(p => p.props.name), ['P1 <A&B>', 'P2', 'P3']), design.plots.map(p => p.props.name).join(','));
  ok('columns: name, description, then ExtendedData names (entities decoded) in order',
    same(design.columns, ['name', 'description', 'Variété', 'Bloc']), design.columns.join(','));
  const [k1, k2, k3] = design.plots;
  ok('CDATA kept verbatim, entities decoded in text and attributes', k1.props.name === 'P1 <A&B>' && k1.props['Variété'] === 'Alpha' && k2.props['Variété'] === 'Beta <2>');
  ok('an unclosed <br> inside a description does not unbalance the document', k1.props.description === 'Blé & co line' && k2.props.name === 'P2', JSON.stringify(k1.props.description));
  ok('Data and SimpleData of the same name fill one column; missing is ""', k1.props.Bloc === '1' && k2.props.Bloc === '' && k3.props['Variété'] === '');
  ok('outer + inner boundary, whitespace and altitude handled', same(k1.rings, [
    [[4.7, 50.6], [4.7001, 50.6], [4.7001, 50.6001], [4.7, 50.6001], [4.7, 50.6]],
    [[4.70004, 50.60004], [4.70006, 50.60004], [4.70006, 50.60006], [4.70004, 50.60004]],
  ]));
  ok('prefixed MultiGeometry (nested too): both polygons kept, its point ignored', k2.rings.length === 2 && same(k2.rings[1], [[4.7004, 50.6], [4.7005, 50.6], [4.7005, 50.6001], [4.7004, 50.6]]));
  ok('"lon, lat" with a space after the comma still reads, closed on return', same(k3.rings, [[[4.7006, 50.6], [4.7007, 50.6], [4.7007, 50.6001], [4.7006, 50.6001], [4.7006, 50.6]]]));
  ok('warnings: the point and the unparseable coordinates', same(design.warnings.slice(0, 2), [
    'Skipped 1 feature that is not a polygon (1 Point).',
    'Skipped 1 feature with invalid or non-finite coordinates.',
  ]), JSON.stringify(design.warnings));
  ok('the accented "Variété" column is recognised as the variety column', design.varietyColumn === 'Variété' && design.nameColumn === 'name', `${design.varietyColumn} / ${design.nameColumn}`);

  const kmz = await readDesignFiles([zipFile('trial.kmz', [{ name: 'doc.kml', data: utf8(kml) }, { name: 'files/icon.png', data: new Uint8Array([137, 80, 78, 71]) }])]);
  ok('KMZ (stored) reads its doc.kml; fileName is the .kmz', same(kmz.plots, design.plots) && kmz.fileName === 'trial.kmz');
  const kmzDeflate = await readDesignFiles([zipFile('trial.kmz', [{ name: 'doc.kml', data: utf8(kml) }], { deflate: true })]);
  ok('KMZ (deflated) reads too', same(kmzDeflate.plots, design.plots));

  const latin = `<?xml version="1.0" encoding="ISO-8859-1"?><kml><Placemark><name>Blé</name><Polygon><outerBoundaryIs><LinearRing><coordinates>4.7,50.6 4.7001,50.6 4.7001,50.6001 4.7,50.6</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
  const lat = await readDesignFiles([file('latin.kml', latin1(latin))]);
  ok('a KML declaring ISO-8859-1 is decoded by its declaration', lat.plots[0].props.name === 'Blé', lat.plots[0].props.name);
  const bom = await readDesignFiles([file('bom.kml', concat(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(latin.replace('Blé', 'Blé tendre'))))]);
  ok('a UTF-8 byte order mark wins over an ISO-8859-1 declaration copied from a template', bom.plots[0].props.name === 'Blé tendre', bom.plots[0].props.name);

  const e1 = await rejection(() => readDesignFiles([file('empty.kml', '<kml><Document><name>nothing</name></Document></kml>')]));
  ok('a KML without placemarks is refused', refuses(e1, /^"empty\.kml" holds no placemarks, so no plot polygons\.$/), e1?.message);
  const e2 = await rejection(() => readDesignFiles([file('far.kml', '<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>500000,4800000 500010,4800000 500010,4800010 500000,4800000</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>')]));
  ok('a KML with metres for coordinates is refused', refuses(e2, /^"far\.kml" has coordinates that are not longitude\/latitude/), e2?.message);

  const xml = parseXml('<a x="1 &amp; 2"><b>t&#x41;</b></c><d/>tail</a>');
  ok('parseXml: attributes decoded, a stray close tag ignored, self-closing handled',
    xml.kids[0].attrs.x === '1 & 2' && xml.kids[0].kids[0].text === 'tA' && xml.kids[0].kids[1].name === 'd' && xml.kids[0].text === 'tail');
}

console.log('\nI. variety and name column detection');
{
  const D = (columns, rows) => ({ columns, plots: rows.map(r => ({ rings: [], props: Object.fromEntries(columns.map((c, i) => [c, r[i]])) })) });
  ok('a variety word beats a treatment word even when every plot has its own variety (each variety is a species)',
    detectVarietyColumn(D(['Variety', 'Treatment'], [['A', 'T1'], ['B', 'T1'], ['C', 'T2'], ['D', 'T2']])) === 'Variety');
  const unreplicated = Array.from({ length: 48 }, (_, i) => [String(i), `M${i % 4}`, `V${i}`]);
  ok('an unreplicated trial: all-distinct "Variété" over repeating "Modalité"', detectVarietyColumn(D(['Parcelle', 'Modalité', 'Variété'], unreplicated)) === 'Variété');
  ok('among variety words, repeating still beats all-distinct (Genotype over accession ids)',
    detectVarietyColumn(D(['accession', 'genotype'], [['a1', 'G1'], ['a2', 'G1'], ['a3', 'G2'], ['a4', 'G2']])) === 'genotype');
  ok('"Var" is a variety column: over a rounded Area, and over "treatment_date"',
    detectVarietyColumn(D(['FID', 'Var', 'Area'], Array.from({ length: 48 }, (_, i) => [String(i), `V${i % 12}`, (219 + (i % 40) * 0.01).toFixed(2)]))) === 'Var' &&
    detectVarietyColumn(D(['plot', 'treatment_date', 'var'], Array.from({ length: 48 }, (_, i) => [String(i), ['2025-03-01', '2025-04-01'][i % 2], `V${i % 12}`]))) === 'var');
  ok('"var" only as the whole name: not var_yield, not variable', varietyWordRank('var_yield') === -1 && varietyWordRank('variable') === -1 && varietyWordRank('VAR') >= 0 && varietyWordRank('var_name') >= 0);
  ok('names match ignoring case and accents: Variété, GENOTYPE, Modalité, entry_no',
    ['Variété', 'GENOTYPE', 'Modalité', 'entry_no', 'NomVariete', 'cultivars', 'Lignée'].every(c => detectVarietyColumn(D([c, 'x'], [['a', '1'], ['a', '2'], ['b', '3']])) === c));
  ok('short words must be whole words: "baseline" is not "line"', varietyWordRank('baseline') === -1 && varietyWordRank('line_id') >= 0 && varietyWordRank('Entries') >= 0);
  ok('among repeating named columns, the word order decides (germplasm first)',
    detectVarietyColumn(D(['treatment', 'germplasm'], [['t1', 'g1'], ['t1', 'g1'], ['t2', 'g2']])) === 'germplasm');
  ok('an all-empty named column is passed over', detectVarietyColumn(D(['variety', 'block'], [['', '1'], ['', '1'], ['', '2']])) === 'block');
  ok('a constant named column is taken (one variety), even beside a repeating unnamed one',
    detectVarietyColumn(D(['variety', 'dose'], [['Apache', '0'], ['Apache', '0'], ['Apache', '60']])) === 'variety');
  ok('no named column: the repeating column with the most distinct values',
    detectVarietyColumn(D(['a', 'b', 'rep', 'code'], [['1', 'x', '1', 'p1'], ['1', 'y', '1', 'p2'], ['2', 'z', '1', 'p3'], ['2', 'z', '1', 'p4']])) === 'b');
  ok('nothing repeats: the first column with the most distinct values', detectVarietyColumn(D(['uid', 'label'], [['1', 'a'], ['2', 'b']])) === 'uid');
  ok('all columns constant, no columns, no plots: ""',
    detectVarietyColumn(D(['id', 'layer'], [['0', 'L'], ['0', 'L']])) === '' && detectVarietyColumn(D([], [[], []])) === '' && detectVarietyColumn(D(['v'], [])) === '');
  const many = Array.from({ length: 300 }, (_, i) => [`V${i % 253}`, `B${i % 10}`]);
  ok('a column with more than 252 distinct values is never guessed', detectVarietyColumn(D(['variety', 'block'], many)) === 'block');
  ok('and when no column fits, ""', detectVarietyColumn(D(['name'], Array.from({ length: 253 }, (_, i) => [`P${i}`]))) === '');

  ok('name: an exact "Name" beats another unique column', detectNameColumn(D(['URI', 'Name'], [['u1', 'n1'], ['u2', 'n2']])) === 'Name');
  ok('name: word order among exact names (id before code)', detectNameColumn(D(['code', 'id'], [['c1', '1'], ['c2', '2']])) === 'id');
  ok('name: an exact word beats a contained one (label over plot_name)', detectNameColumn(D(['plot_name', 'label'], [['a', 'x'], ['b', 'y']])) === 'label');
  ok('name: PlotID and plot_id are exact', detectNameColumn(D(['x', 'PlotID'], [['a', '1'], ['b', '2']])) === 'PlotID');
  ok('name: a repeated or empty value disqualifies; the first unique column is used',
    detectNameColumn(D(['Name', 'uid'], [['a', '1'], ['a', '2']])) === 'uid' && detectNameColumn(D(['Name', 'uid'], [['', '1'], ['b', '2']])) === 'uid');
  ok('name: nothing unique gives ""', detectNameColumn(D(['a'], [['x'], ['x']])) === '');
}

console.log('\nJ. varieties: labels, crops, order, and what "" means');
{
  const labels = [
    ['http://Triticum_aestivum/ALPHA/SEEDCO', 'ALPHA'],
    ['http://Triticum_aestivum/BRAVO/', 'BRAVO'],
    ['http://Triticum_aestivum/CHARLIE_TWO/Seed_House_SA', 'CHARLIE TWO'],
    ['https://www.catalogue.example.org/catalogue/variete/1045887-zz-fictiva', 'ZZ Fictiva'],
    ['https://www.catalogue.example.org/catalogue/variete/2000002-grandiosa/', 'Grandiosa'],
    ['https://example.org/v/kws-some%20thing.html', 'KWS Some Thing'],
    ['https://example.org/v/Mixed_Case-Name', 'Mixed Case-Name'],
    ['https://example.org/v/1234567', '1234567'],
    ['https://example.org/', 'example.org'],
    ['  Apache_Blé  ', 'Apache Blé'],
    ['urn:x:y', 'urn:x:y'],
    ['', NO_VARIETY_LABEL],
  ];
  for (const [key, want] of labels) ok(`label ${JSON.stringify(key)} -> ${JSON.stringify(want)}`, varietyLabel(key) === want, varietyLabel(key));

  const crops = [
    ['http://Triticum_aestivum/X/', 'wheat'], ['Blé tendre', 'wheat'], ['froment', 'wheat'], ['winter wheat', 'wheat'],
    ['Zea mays', 'maize'], ['maïs grain', 'maize'], ['corn', 'maize'],
    ['Glycine max', 'soy'], ['Soja', 'soy'], ['Beta vulgaris', 'beet'], ['betteraves', 'beet'],
    ['Lolium perenne', 'grass'], ['luzerne', 'grass'], ['Medicago_sativa', 'grass'], ['prairie temporaire', 'grass'], ['Festuca', 'grass'], ['alfalfa', 'grass'],
    ['table', ''], ['beta version', ''], ['cornflower', ''], ['', ''],
    // "mais" is also French for "but".
    ['Levée hétérogène mais correcte', ''], ['MAIS', 'maize'], ['Mais grain', 'maize'], ['MAIS ENSILAGE 2025', 'maize'], ['semis tardif, maïs derrière', 'maize'],
  ];
  for (const [text, want] of crops) ok(`crop ${JSON.stringify(text)} -> ${JSON.stringify(want)}`, detectCrop(text) === want, detectCrop(text));
  ok('crop: the crop named most wins', detectCrop('maize after wheat after wheat') === 'wheat');

  const design = (columns, rows, varietyColumn, nameColumn = '') => ({
    fileName: 't', columns, varietyColumn, nameColumn, warnings: [],
    plots: rows.map(r => ({ rings: [], props: Object.fromEntries(columns.map((c, i) => [c, r[i]])) })),
  });
  const own = design(['variety', 'species'], [['V1', 'Zea mays'], ['V2', 'Glycine max'], ['V3', ''], ['V1', '']], 'variety');
  const ownV = varietiesOf(own);
  ok('crop from the variety\'s own plots, then the design majority (tie in preset order: maize)',
    same(ownV.map(v => [v.key, v.plots, v.crop]), [['V1', 2, 'maize'], ['V2', 1, 'soy'], ['V3', 1, 'maize']]), JSON.stringify(ownV));
  ok('no crop word anywhere: "default"', varietiesOf(design(['v'], [['a'], ['b']], 'v')).every(v => v.crop === 'default'));
  const catalogue = 'https://www.catalogue.example.org/catalogue/variete/1045887-zz-fictiva';
  const withComment = design(['Germplasm', 'comment'], [['http://Triticum_aestivum/ALPHA/', ''], [catalogue, 'Levée hétérogène mais correcte'], ['http://Triticum_aestivum/ALPHA/', ''], [catalogue, '']], 'Germplasm');
  ok('a "mais" (but) in a comment does not make the catalogue variety of a wheat trial maize',
    same(varietiesOf(withComment).map(v => v.crop), ['wheat', 'wheat']), JSON.stringify(varietiesOf(withComment)));

  const blank = design(['variety', 'Name'], [['B', 'n1'], ['', 'n2'], ['B', 'n3'], ['', 'n4'], ['A', 'n5']], 'variety', 'Name');
  const { varieties, species } = assignVarieties(blank);
  ok('order of first appearance, with an empty value as its own "(no variety)"',
    same(varieties.map(v => [v.key, v.label, v.plots]), [['B', 'B', 2], ['', NO_VARIETY_LABEL, 2], ['A', 'A', 1]]) && same(species, [0, 1, 0, 1, 2]));

  const none = design(['Name', 'note'], [['p_1', 'Triticum'], ['p_2', ''], ['p_3', '']], '', 'Name');
  const nv = assignVarieties(none);
  ok('"" : every plot is its own variety, keyed "plot 1", "plot 2"... (as imported-plan.ts keys them) and labelled by the name column as is',
    same(nv.varieties.map(v => [v.key, v.label, v.plots]), [['plot 1', 'p_1', 1], ['plot 2', 'p_2', 1], ['plot 3', 'p_3', 1]]) && same(nv.species, [0, 1, 2]));
  ok('"" : crops still come from the plots, then the design', nv.varieties.every(v => v.crop === 'wheat'));
  ok('"" without a name column: "Plot N"', same(varietiesOf({ ...none, nameColumn: '' }).map(v => v.label), ['Plot 1', 'Plot 2', 'Plot 3']));
  ok('"" : varietyKeyOf agrees', varietyKeyOf(none, 2) === 'plot 3');
  const stale = varietiesOf({ ...none, varietyColumn: 'gone' });
  ok('a column that is not in the design groups every plot as "(no variety)"', same(stale.map(v => [v.key, v.label, v.plots]), [['', NO_VARIETY_LABEL, 3]]));

  const wide = design(['variety'], Array.from({ length: 253 }, (_, i) => [`V${i}`]), 'variety');
  ok('tooManyVarieties: a column past the limit is explained', tooManyVarieties(wide) === '"variety" has 253 distinct values; at most 252 varieties can be simulated.', tooManyVarieties(wide));
  ok('tooManyVarieties: "" past the limit is explained', /^Without a variety column every plot is its own variety, and 253 plots exceed the 252 varieties/.test(tooManyVarieties({ ...wide, varietyColumn: '' })));
  ok('tooManyVarieties: within the limit is ""', tooManyVarieties(design(['variety'], Array.from({ length: 252 }, (_, i) => [`V${i}`]), 'variety')) === '');
  ok('formatNumber: noise, integers, -0, non-finite',
    formatNumber(0.1 + 0.2) === '0.3' && formatNumber(1) === '1' && formatNumber(-0) === '0' && formatNumber(123456789012345) === '123456789012345' && formatNumber(NaN) === '' && formatNumber(1.0000000001) === '1.0000000001');
}

console.log('\nK. limits and refusals');
{
  const d = 0.00005;
  const squares = (n, props) => JSON.stringify({
    type: 'FeatureCollection',
    features: Array.from({ length: n }, (_, i) => {
      const x = 4.7 + (i % 100) * 2 * d, y = 50.6 + Math.floor(i / 100) * 2 * d;
      return { type: 'Feature', properties: props(i), geometry: { type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] } };
    }),
  });
  ok('limits are the documented ones', MAX_IMPORT_BYTES === 50 * MB && MAX_IMPORT_PLOTS === 5000 && MAX_IMPORT_VARIETIES === 252);

  const e0 = await rejection(() => readDesignFiles([]));
  ok('no file', refuses(e0, /^No file was given\.$/), e0?.message);
  const eBig = await rejection(() => readDesignFiles([{ name: 'huge.zip', data: new ArrayBuffer(MAX_IMPORT_BYTES + 1) }]));
  ok('a file over 50 MB is refused before it is read', refuses(eBig, /^"huge\.zip" is 50\.1 MB; designs up to 50 MB can be imported\.$/), eBig?.message);
  const eInflate = await rejection(() => readDesignFiles([zipFile('bomb.zip', [{ name: 'big.geojson', data: new Uint8Array(MAX_IMPORT_BYTES + 1) }], { deflate: true })]));
  ok('a member over 50 MB once unzipped is refused', refuses(eInflate, /^"big\.geojson" inside "bomb\.zip" is 50\.1 MB once unzipped/), eInflate?.message);
  // Refused from the zip directory BEFORE inflating: this member's bytes are not even deflate data.
  const eDeclared = await rejection(() => readDesignFiles([zipFile('bomb.zip', [
    { name: 'trial.dbf', body: utf8('not deflate data'), declared: 1500 * MB },
    ...partsList('trial', { shp: trialParts().shp, prj: WKT.wgs84 }),
  ], { deflate: true })]));
  ok('a member declaring 1.5 GB is refused from the directory, before it is inflated',
    refuses(eDeclared, /^"trial\.dbf" inside "bomb\.zip" is 1500 MB once unzipped; designs up to 50 MB can be imported\.$/), eDeclared?.message);
  const zeros = new Uint8Array(zlib.deflateRawSync(new Uint8Array(MAX_IMPORT_BYTES + MB)));
  const eLying = await rejection(() => readDesignFiles([zipFile('lying.zip', [{ name: 'big.geojson', body: zeros, declared: 1000 }], { deflate: true })]));
  ok('a member declaring 1 KB that inflates past 50 MB is stopped while inflating',
    refuses(eLying, /^"big\.geojson" inside "lying\.zip" is over 50 MB once unzipped/), eLying?.message);

  const at = await readDesignFiles([file('max.geojson', squares(MAX_IMPORT_PLOTS, i => ({ variety: `V${i % 12}` })))]);
  ok('exactly 5,000 plots are accepted', at.plots.length === 5000 && varietiesOf(at).length === 12);
  const eMany = await rejection(() => readDesignFiles([file('many.geojson', squares(MAX_IMPORT_PLOTS + 1, i => ({ variety: `V${i % 12}` })))]));
  ok('5,001 plots are refused', refuses(eMany, /^"many\.geojson" holds 5,001 plots; at most 5,000 can be imported\.$/), eMany?.message);
  const layered = await readDesignFiles([zipFile('region.zip', [
    { name: 'region.geojson', data: utf8(squares(MAX_IMPORT_PLOTS + 1, () => ({}))) },
    { name: 'trial.geojson', data: utf8(squares(3, i => ({ variety: `V${i}` }))) },
  ])]);
  ok('an over-limit layer beside a trial: the trial is used, the other explained',
    layered.plots.length === 3 && layered.warnings.includes('Another layer was ignored: "region.geojson" holds 5,001 plots; at most 5,000 can be imported.'), JSON.stringify(layered.warnings));

  const ok252 = await readDesignFiles([file('v252.geojson', squares(300, i => ({ variety: `V${i % 252}` })))]);
  ok('252 varieties are accepted', ok252.varietyColumn === 'variety' && varietiesOf(ok252).length === 252);
  const e253 = await rejection(() => readDesignFiles([file('v253.geojson', squares(300, i => ({ variety: `V${i % 253}`, plot: `P${i}` })))]));
  ok('253 varieties (and nothing else that groups the plots) are refused',
    refuses(e253, /^"v253\.geojson" has 300 plots and no attribute that groups them into at most 252 varieties/), e253?.message);
  const own = await readDesignFiles([file('own.geojson', squares(4, i => ({ plot: `P${i}` })))]);
  ok('a few plots with only unique names: each its own variety, named by the column, with a warning',
    own.varietyColumn === 'plot' && own.nameColumn === 'plot' && varietiesOf(own).length === 4 &&
    own.warnings.includes('No column is named like a variety; varieties were guessed from "plot". Pick another column if that is wrong.'), JSON.stringify(own.warnings));
  // The guess note is the ONE warning that describes a choice rather than a
  // fact about the file, and the page lets the user overrule that choice. It
  // carries an exported marker so the page can drop exactly this note when they
  // do, instead of matching on its prose; without the marker it went on saying
  // "guessed from COL" beside a dropdown reading MGRS_TILE.
  ok('the guess note is the only warning carrying the marker the page filters on',
    own.warnings.filter(w => w.startsWith(VARIETY_GUESS_PREFIX)).length === 1 &&
    own.warnings.some(w => w.startsWith(VARIETY_GUESS_PREFIX) && w.includes('"plot"')),
    JSON.stringify(own.warnings));
  ok('and dropping it leaves every warning that IS a fact about the file',
    (() => {
      const reprojected = { warnings: ['Reprojected "x.shp" from A to WGS84.', ...own.warnings] };
      const kept = reprojected.warnings.filter(w => !w.startsWith(VARIETY_GUESS_PREFIX));
      return kept.length === reprojected.warnings.length - 1 && kept.every(w => !w.includes('guessed from'));
    })());

  const constant = await readDesignFiles([file('const.geojson', squares(4, () => ({ id: 0 })))]);
  ok('only a constant unnamed column: varietyColumn "" and the warning says every plot is its own variety',
    constant.varietyColumn === '' && varietiesOf(constant).length === 4 && constant.warnings.includes('No column names the varieties, so every plot is its own variety.'), JSON.stringify(constant.warnings));
  const e300 = await rejection(() => readDesignFiles([file('c300.geojson', squares(300, () => ({ id: 0 })))]));
  ok('... and with more than 252 such plots, refused', refuses(e300, /has 300 plots and no attribute that groups them/), e300?.message);

  ok('every refusal is a DesignImportError', [e0, eBig, eInflate, eMany, e253, e300].every(e => e instanceof DesignImportError && e.name === 'DesignImportError'));
}

console.log('\nL. house style');
{
  /**
   * The no-em-dash rule, asked of everything the Pixel Grid Designer ships,
   * not of the one file this suite happens to be about. It was checked on
   * design-import.ts alone and passed for a year while two dozen other shipped
   * files carried em dashes, which is the shape of a check that tests its
   * author rather than the codebase.
   *
   * NOT_YET_CLEAN was the list of files that still carried one, allowed to
   * shrink and never to grow. It is EMPTY now: every shipped file has been
   * cleaned, so the rule is simply the rule, and the first em dash to land
   * anywhere in this set fails the suite. Keep it empty; adding a name back is
   * conceding the rule rather than fixing the file.
   */
  const EM_DASH = String.fromCharCode(0x2014);
  const NOT_YET_CLEAN = new Set([]);
  const walk = (dir, exts) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(`${dir}/${d.name}`, exts)
      : exts.some(x => d.name.endsWith(x)) ? [`${dir}/${d.name}`] : []);
  const shipped = [...walk('src/pixel-grid', ['.ts', '.tsx']), 'src/lib/geo.ts', 'src/lib/projections.ts',
    ...walk('scripts', ['.mjs'])].sort();
  const dashed = shipped.filter(rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').includes(EM_DASH));
  ok('no em dash in any shipped file',
    dashed.every(rel => NOT_YET_CLEAN.has(rel)), dashed.filter(rel => !NOT_YET_CLEAN.has(rel)).join(' ') ||
    `${shipped.length} files checked, ${dashed.length} still to clean`);
  ok('and the list itself names only files that exist',
    [...NOT_YET_CLEAN].every(rel => fs.existsSync(path.join(ROOT, rel))),
    [...NOT_YET_CLEAN].filter(rel => !fs.existsSync(path.join(ROOT, rel))).join(' '));
}

console.log(bad ? `\n${bad} DESIGN-IMPORT CHECK(S) FAILED` : '\nALL DESIGN-IMPORT CHECKS PASSED');
process.exit(bad ? 1 : 0);
