/**
 * Regression suite for the Sentinel-2 Pixel Grid Designer's pure modules —
 * run with `npm run test:pixel-grid`.
 *
 * The tool itself (src/pixel-grid/PixelGridApp.tsx) is one big component that
 * only orchestrates; everything that can be *wrong* lives in three dependency-
 * free-ish modules underneath it:
 *
 *   s2-grid.ts    the UTM lattice — if the phase slips by a metre the exported
 *                 shapefile no longer matches the product's pixels,
 *   simulate.ts   the mixed-pixel engine — purity is the number the agronomist
 *                 actually reads off the page,
 *   shapefile.ts  the byte writer — a malformed zip fails silently in QGIS.
 *
 * These are CHARACTERIZATION tests: they pin what the code does today so the
 * component above can be restructured without changing any of it. Where the
 * current behaviour looks wrong it is still asserted, marked with a comment.
 *
 * Same mechanism as the other two suites: transpile the TypeScript with the
 * esbuild that ships inside Vite and exercise it from node. Unlike those, these
 * modules import each other and proj4, so the transpiled tree is written under
 * node_modules/ (mirroring src/) — relative specifiers keep working and node
 * still resolves proj4 by walking up to the project's node_modules.
 *
 * Nothing here touches the network: `fetchCoveringGrids` is out of scope, only
 * the offline maths is tested.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'node_modules/.pixel-grid-regress');

// Expose the internals under test without double-exporting what is already public.
const reveal = (t, decl) => (t.includes('export ' + decl) ? t : t.replace(decl, 'export ' + decl));
const REVEAL = { 'src/pixel-grid/simulate.ts': ['const strideFor =', 'function patternCultureUV('] };

fs.rmSync(BUILD, { recursive: true, force: true });
for (const rel of ['src/lib/geo.ts', 'src/pixel-grid/s2-grid.ts', 'src/pixel-grid/simulate.ts', 'src/pixel-grid/shapefile.ts']) {
  let ts = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const decl of REVEAL[rel] ?? []) ts = reveal(ts, decl);
  // esbuild only strips types; relative specifiers still need an extension to
  // load as real ESM from disk.
  const js = transformSync(ts, { loader: 'ts', format: 'esm' }).code
    .replace(/(from\s*['"])(\.\.?\/[^'"]+?)(['"])/g, (_, a, spec, c) => a + spec + '.mjs' + c);
  const dest = path.join(BUILD, rel.replace(/\.ts$/, '.mjs'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, js);
}

const {
  utmZoneForLng, utmEpsg, centralMeridian, zoneFromEpsg, gridConvergence,
  buildS2Grid, aoiUtmOrigin, gridToGeoJson,
} = await import(path.join(BUILD, 'src/pixel-grid/s2-grid.mjs'));
const {
  makeTruth, makeBetaSchedule, cultureForCell, aggregate, simulate,
  simulateField, simulatePatch, bestPhaseOffset, cultureAt, utmEnvelope,
  resolutionSweep, truthAt, strideFor, patternCultureUV,
  TMAX, DEFAULT_PARS, BARE, cropById, parsOf,
} = await import(path.join(BUILD, 'src/pixel-grid/simulate.mjs'));
const { gridToShapefileZip } = await import(path.join(BUILD, 'src/pixel-grid/shapefile.mjs'));

let bad = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

/** A small field near Louvain-la-Neuve — UTM zone 31N, the app's home ground. */
const AOI = [4.7000, 50.6000, 4.7021, 50.6010];
const SHARP = { sigmaX: 0, sigmaY: 0, mixThreshold: 0.8 };
const phaseOf = (v, res) => ((v % res) + res) % res;

console.log('A. UTM zone algebra');
{
  ok('Belgium is zone 31', utmZoneForLng(4.7) === 31, `${utmZoneForLng(4.7)}`);
  ok('the antimeridian is zone 1, not 0 or 61',
    utmZoneForLng(-180) === 1 && utmZoneForLng(179.999) === 60 && utmZoneForLng(180) === 1,
    `${utmZoneForLng(-180)}/${utmZoneForLng(179.999)}/${utmZoneForLng(180)}`);
  ok('every longitude lands in 1..60',
    (() => { for (let l = -180; l <= 180; l += 0.25) { const z = utmZoneForLng(l); if (!(z >= 1 && z <= 60)) return false; } return true; })());
  ok('a zone is exactly 6° wide and its centre is the central meridian',
    (() => { for (let l = -179.9; l < 180; l += 0.1) { if (Math.abs(l - centralMeridian(utmZoneForLng(l))) > 3.0001) return false; } return true; })());
  ok('zone 31 has central meridian 3°E', centralMeridian(31) === 3);
  ok('EPSG picks the hemisphere', utmEpsg(31, false) === 32631 && utmEpsg(31, true) === 32731);
  ok('EPSG → zone round-trips for all 60 zones, both hemispheres',
    (() => { for (let z = 1; z <= 60; z++) for (const s of [false, true]) if (zoneFromEpsg(utmEpsg(z, s)) !== z) return false; return true; })());
}

console.log('\nB. grid convergence is the angle from true north to grid north');
{
  // γ ≈ (λ − λ0)·sin φ. Positive = grid north EAST of true north; this is the
  // rotation the UI reports so a plot staked to the pixels can be set out.
  let worst = 0;
  for (const [lng, lat] of [[3, 50], [6, 50], [0, 50], [5.5, 60], [1.2, 43], [6, -30], [1, -45]]) {
    const zone = utmZoneForLng(lng);
    const epsg = utmEpsg(zone, lat < 0);
    const got = gridConvergence(lng, lat, epsg);
    const approx = (lng - centralMeridian(zone)) * Math.sin((lat * Math.PI) / 180);
    worst = Math.max(worst, Math.abs(got - approx));
  }
  ok('matches (λ−λ0)·sin φ everywhere tested', worst < 0.01, `max |diff| = ${worst.toFixed(4)}°`);
  ok('it is zero on the central meridian', Math.abs(gridConvergence(3, 50, 32631)) < 1e-6);
  ok('east of the CM in the north, grid north is east of true north',
    gridConvergence(5.5, 50, 32631) > 0, `${gridConvergence(5.5, 50, 32631).toFixed(3)}°`);
  ok('the sign flips in the southern hemisphere',
    gridConvergence(5.5, -30, 32731) < 0, `${gridConvergence(5.5, -30, 32731).toFixed(3)}°`);
}

console.log('\nC. the pixel lattice');
{
  const r10 = buildS2Grid(AOI, { res: 10 });
  const r20 = buildS2Grid(AOI, { res: 20 });
  const r60 = buildS2Grid(AOI, { res: 60 });

  ok('the grid lands in zone 31N', r10.epsg === 32631 && r10.grid.zone === 31 && r10.grid.south === false);
  ok('every 10 m cell corner is a multiple of 10 m in UTM',
    r10.grid.cells.every(c => c.east % 10 === 0 && c.north % 10 === 0));
  ok('the snapped extent is a multiple of the resolution too',
    r10.utmBounds.every(v => v % 10 === 0) && r20.utmBounds.every(v => v % 20 === 0) && r60.utmBounds.every(v => v % 60 === 0),
    r60.utmBounds.join(','));
  ok('col/row are the zone-wide pixel indices',
    r10.grid.cells.every(c => c.col === c.east / 10 && c.row === c.north / 10));
  ok('cellCount agrees with the extent and with the cells produced',
    r10.cellCount === r10.grid.cells.length &&
    r10.cellCount === ((r10.utmBounds[2] - r10.utmBounds[0]) / 10) * ((r10.utmBounds[3] - r10.utmBounds[1]) / 10),
    `${r10.cellCount}`);
  ok('cells run row-major from the south-west corner',
    r10.grid.cells[0].east === r10.utmBounds[0] && r10.grid.cells[0].north === r10.utmBounds[1]);

  // The whole point of the tool: the three S2 grids nest exactly.
  const set10 = new Set(r10.grid.cells.map(c => `${c.east}/${c.north}`));
  const nested20 = r20.grid.cells.every(c =>
    [[0, 0], [10, 0], [0, 10], [10, 10]].every(([dx, dy]) => set10.has(`${c.east + dx}/${c.north + dy}`)));
  ok('every 20 m pixel is exactly 2×2 ten-metre pixels', nested20 && r20.grid.cells.length * 4 === r10.grid.cells.length,
    `${r20.grid.cells.length}×4 vs ${r10.grid.cells.length}`);
  const r10wide = buildS2Grid(AOI, { res: 10 });
  const set10w = new Set(r10wide.grid.cells.map(c => `${c.east}/${c.north}`));
  const inner60 = r60.grid.cells.filter(c =>
    c.east >= r10wide.utmBounds[0] && c.east + 60 <= r10wide.utmBounds[2] &&
    c.north >= r10wide.utmBounds[1] && c.north + 60 <= r10wide.utmBounds[3]);
  const nested60 = inner60.length > 0 && inner60.every(c => {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) if (!set10w.has(`${c.east + i * 10}/${c.north + j * 10}`)) return false;
    return true;
  });
  ok('every interior 60 m pixel is exactly 6×6 ten-metre pixels', nested60, `${inner60.length} interior 60 m cells`);

  // Ring geometry: closed, correctly wound for Leaflet, and it really is the cell.
  const c0 = r10.grid.cells[0];
  const fwd = proj4('EPSG:4326', '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs');
  const back = c0.ring.map(([lng, lat]) => fwd.forward([lng, lat]));
  ok('the ring is closed and has 5 vertices',
    c0.ring.length === 5 && c0.ring[0][0] === c0.ring[4][0] && c0.ring[0][1] === c0.ring[4][1]);
  ok('the ring reprojects back onto the exact cell square',
    Math.abs(back[0][0] - c0.east) < 1e-3 && Math.abs(back[0][1] - c0.north) < 1e-3 &&
    Math.abs(back[2][0] - (c0.east + 10)) < 1e-3 && Math.abs(back[2][1] - (c0.north + 10)) < 1e-3,
    `${back[0].map(v => v.toFixed(3)).join(',')}`);

  ok('aoiUtmOrigin is the unsnapped corner the extent snaps down from',
    (() => { const [oe, on] = aoiUtmOrigin(AOI, 32631);
      return oe - r10.utmBounds[0] >= 0 && oe - r10.utmBounds[0] < 10 && on - r10.utmBounds[1] >= 0 && on - r10.utmBounds[1] < 10; })());
  ok('utmEnvelope and aoiUtmOrigin agree on the lower-left corner',
    utmEnvelope(AOI, 32631).slice(0, 2).join(',') === aoiUtmOrigin(AOI, 32631).join(','));

  const gj = gridToGeoJson(r10.grid);
  ok('the GeoJSON carries one polygon per cell, with its indices',
    gj.type === 'FeatureCollection' && gj.features.length === r10.grid.cells.length &&
    gj.features[0].geometry.type === 'Polygon' &&
    gj.features[0].properties.col === c0.col && gj.features[0].properties.row === c0.row);
}

console.log('\nD. anchoring to a real product grid');
{
  // Landsat-style: a 30 m lattice whose origin is ≡15 mod 30, i.e. offset half a
  // pixel from the S2 rule. The whole grid must inherit that phase.
  const anchor = { epsg: 32631, ulx: 300015, uly: 4899975, tile: 'LC31N' };
  const r = buildS2Grid(AOI, { res: 30, anchor });
  ok('a phase-15 anchor snaps the whole lattice to 15 mod 30',
    r.grid.cells.every(c => phaseOf(c.east, 30) === 15 && phaseOf(c.north, 30) === 15));
  ok('and the snapped extent carries the same phase',
    r.utmBounds.every(v => phaseOf(v, 30) === 15), r.utmBounds.join(','));
  ok('the grid is flagged as anchored and keeps the tile id',
    r.grid.anchored === true && r.grid.tile === 'LC31N');
  ok('the anchor also chooses the CRS, overriding the zone rule',
    buildS2Grid(AOI, { res: 30, zone: 1, anchor }).epsg === 32631);
  // col/row are `round(east / res)`, so on an off-phase lattice they are the
  // nearest index rather than an exact division — the .5 is rounded away.
  ok('col/row round to the nearest index on an off-phase lattice',
    r.grid.cells.every(c => c.col === Math.round(c.east / 30) && Math.abs(c.col - c.east / 30) === 0.5));
  const zeroPhase = buildS2Grid(AOI, { res: 30, anchor: { epsg: 32631, ulx: 300000, uly: 4900020 } });
  ok('a phase-0 anchor is identical to the deterministic rule',
    zeroPhase.utmBounds.join(',') === buildS2Grid(AOI, { res: 30 }).utmBounds.join(','));
}

console.log('\nE. the cell cap and the viewport clip');
{
  const full = buildS2Grid(AOI, { res: 10 });
  const capped = buildS2Grid(AOI, { res: 10, maxCells: 10 });
  ok('over the cap no grid is built, but the count is still reported',
    capped.grid === null && capped.capped === true && capped.cellCount === full.cellCount, `${capped.cellCount}`);
  ok('and the extent is still returned, so the gdalwarp recipe still works',
    capped.utmBounds.join(',') === full.utmBounds.join(','));
  ok('a grid under the cap is not flagged', full.capped === false && full.grid !== null);

  // The clip keeps the lattice phase — it only produces fewer cells.
  const clip = [4.7008, 50.6003, 4.7014, 50.6007];
  const clipped = buildS2Grid(AOI, { res: 10, clip });
  ok('clipping produces fewer cells', clipped.cellCount < full.cellCount, `${clipped.cellCount} vs ${full.cellCount}`);
  ok('the clipped lattice keeps the same origin phase',
    clipped.grid.cells.every(c => c.east % 10 === 0 && c.north % 10 === 0));
  ok('every clipped cell is one of the full grid\'s cells',
    (() => { const s = new Set(full.grid.cells.map(c => `${c.east}/${c.north}`));
      return clipped.grid.cells.every(c => s.has(`${c.east}/${c.north}`)); })());
  ok('the clipped extent sits inside the full one',
    clipped.utmBounds[0] >= full.utmBounds[0] && clipped.utmBounds[1] >= full.utmBounds[1] &&
    clipped.utmBounds[2] <= full.utmBounds[2] && clipped.utmBounds[3] <= full.utmBounds[3]);
  ok('a clip larger than the area changes nothing',
    buildS2Grid(AOI, { res: 10, clip: [4.69, 50.59, 4.71, 50.61] }).cellCount === full.cellCount);

  // characterizes current behaviour; suspected bug: a clip window that does not
  // intersect the area (pan the map away from a capped field — PixelGridApp.tsx
  // line 726 passes the raw viewport) inverts the extent instead of emptying it.
  // Two negative dimensions multiply to a POSITIVE cellCount, so the area reads
  // as "too large"; with only one axis disjoint the count stays under the cap
  // and a grid of that many EMPTY array holes is handed to the renderer.
  const gone = buildS2Grid(AOI, { res: 10, clip: [4.9, 50.9, 4.91, 50.91] });
  ok('a fully disjoint clip yields an inverted extent, not an empty grid',
    gone.utmBounds[0] > gone.utmBounds[2] && gone.utmBounds[1] > gone.utmBounds[3] && gone.cellCount > 0,
    `count=${gone.cellCount} bounds=${gone.utmBounds.join(',')}`);
  const halfGone = buildS2Grid(AOI, { res: 10, clip: [4.9, 50.6, 4.91, 50.6008] });
  // Array.from() is what materialises the holes — `every` would skip them.
  ok('a one-axis disjoint clip builds a grid whose cells are all holes',
    halfGone.grid !== null && halfGone.grid.cells.length > 0 && !(0 in halfGone.grid.cells) &&
    Array.from(halfGone.grid.cells).every(c => c === undefined),
    `${halfGone.grid?.cells.length} holes`);

  // A zero-area area still snaps outward to one whole pixel.
  const pt = buildS2Grid([4.7, 50.6, 4.7, 50.6], { res: 10 });
  ok('a zero-area area yields exactly one pixel', pt.cellCount === 1 && pt.grid.cells.length === 1);

  const south = buildS2Grid([-58.400, -34.620, -58.396, -34.618], { res: 10 });
  ok('a southern-hemisphere area gets a 327xx CRS',
    south.epsg === 32721 && south.grid.south === true && south.grid.zone === 21, `${south.epsg}`);
}

console.log('\nF. the truth curves');
{
  const P = DEFAULT_PARS;
  const [L1, , x01, , x02] = P;
  const t = makeTruth('double', TMAX, P);
  ok('the series is one value per day of year', t.length === TMAX && TMAX === 366);
  ok('x01 is the green-up half-maximum: exactly L1/2', Math.abs(t[x01] - L1 / 2) < 1e-6, `${t[x01].toFixed(9)} vs ${L1 / 2}`);
  // x02 is L1/2 on the senescence limb only; the blend has already handed over
  // by then, so the sum of the three periodic copies leaves ~4e-5.
  ok('x02 is the senescence half-maximum', Math.abs(t[x02] - L1 / 2) < 1e-3, `${t[x02].toFixed(6)} vs ${L1 / 2}`);
  const peak = Math.max(...t);
  ok('the peak is L1 and never exceeds it', peak <= L1 && L1 - peak < 1e-3, `peak=${peak.toFixed(6)} L1=${L1}`);
  ok('it is clamped strictly inside (0,1)', t.every(v => v > 0 && v < 1));
  ok('the curve rises to the peak and falls after it',
    (() => { const i = t.indexOf(peak); return i > x01 && i < x02 && t[x01] < t[i] && t[x02] < t[i]; })());

  ok('a constant truth is flat at 0.5', makeTruth('const', TMAX, P).every(v => v === 0.5));
  const lin = makeTruth('linear', TMAX, P);
  ok('a linear ramp runs 0.2 → 0.8', Math.abs(lin[0] - 0.2) < 1e-12 && Math.abs(lin[TMAX - 1] - 0.8) < 1e-12);
  ok('the ramp is strictly increasing', lin.every((v, i) => i === 0 || v > lin[i - 1]));
  const sine = makeTruth('sine', TMAX, P);
  ok('the sine has a 365-day period around 0.5',
    Math.abs(sine[0] - 0.5) < 1e-12 && Math.abs(sine[365] - 0.5) < 1e-12 && sine.every(v => v > 0 && v < 1));
  ok('and an amplitude of 0.4', Math.abs(Math.max(...sine) - 0.9) < 1e-4 && Math.abs(Math.min(...sine) - 0.1) < 1e-4);

  const maize = cropById('maize');
  ok('a preset id resolves, an unknown one falls back to the first',
    maize.id === 'maize' && cropById('nope').id === 'maize');
  ok('parsOf is the double-logistic parameter vector, in order',
    parsOf(maize).join(',') === [maize.L1, maize.k1, maize.x01, maize.k2, maize.x02, maize.tc].join(','));
  ok('truthAt indexes the curve and clamps out-of-range days',
    truthAt(maize, -50) === makeTruth('double', TMAX, parsOf(maize))[0] &&
    truthAt(maize, 1e6) === makeTruth('double', TMAX, parsOf(maize))[TMAX - 1]);
  ok('truthAt rounds a fractional day', truthAt(maize, 150.4) === truthAt(maize, 150) && truthAt(maize, 150.6) === truthAt(maize, 151));

  const beta = makeBetaSchedule(100, 2, 2, 0.05);
  ok('a beta schedule peaks at exactly the requested magnitude', Math.abs(Math.max(...beta) - 0.05) < 1e-15);
  ok('it is non-negative everywhere and the right length', beta.length === 100 && beta.every(v => v >= 0));
  ok('α = β is symmetric about mid-season',
    beta.every((v, i) => Math.abs(v - beta[99 - i]) < 1e-15) && beta.indexOf(Math.max(...beta)) === 49);
  ok('α = β = 1 is a flat schedule', makeBetaSchedule(10, 1, 1, 0.03).every(v => Math.abs(v - 0.03) < 1e-15));
  ok('zero magnitude means no noise at all', makeBetaSchedule(10, 2, 2, 0).every(v => v === 0));
}

console.log('\nG. the planting pattern');
{
  const cell = (mode) => [[0, 0], [0, 1], [1, 0], [1, 1], [2, 2], [3, 1]].map(([r, c]) => cultureForCell(r, c, mode)).join('');
  ok('alternating rows depend on the row only', cell('row') === '001101');
  ok('alternating columns depend on the column only', cell('col') === '010101');
  ok('the checkerboard is (r+c) mod 2', cell('checker') === '011000');
  ok('2:2 strips pair the rows', cell('strip-row-2') === '000011');
  ok('2:2 strips pair the columns', cell('strip-col-2') === '000010');

  // The map overlay indexes strips from a rotated frame whose origin sits inside
  // the field, so it asks for NEGATIVE rows. JavaScript's % keeps the dividend's
  // sign (-1 % 2 === -1), and a -1 matches neither crop id — it used to render as
  // bare soil, which made crop B disappear from the drawn field at large rotations.
  const rowAt = (rs) => rs.map(r => cultureForCell(r, 0, 'row')).join('');
  const stripAt = (rs) => rs.map(r => cultureForCell(r, 0, 'strip-row-2')).join('');
  ok('rows alternate across zero, not just above it', rowAt([-4, -3, -2, -1, 0, 1, 2, 3]) === '01010101');
  ok('2:2 strips stay paired across zero', stripAt([-4, -3, -2, -1, 0, 1, 2, 3]) === '00110011');
  ok('every pattern returns a real crop id at negative indices', (() => {
    for (const mode of ['row', 'col', 'checker', 'strip-row-2', 'strip-col-2'])
      for (let r = -8; r <= 8; r++)
        for (let c = -8; c <= 8; c++) {
          const v = cultureForCell(r, c, mode);
          if (v !== 0 && v !== 1) return false;
        }
    return true;
  })());
  ok('the pattern is periodic: f(n) === f(n + 2·period)', (() => {
    for (const mode of ['row', 'col', 'checker', 'strip-row-2', 'strip-col-2'])
      for (let r = -6; r <= 6; r++)
        for (let c = -6; c <= 6; c++)
          if (cultureForCell(r, c, mode) !== cultureForCell(r + 4, c + 4, mode)) return false;
    return true;
  })());

  // cultureAt is the metric-space form used to draw the ground truth.
  const col = { pattern: 'col', width: 20, spacing: 0, rotationDeg: 0 };
  ok('20 m column strips alternate every 20 m east',
    [5, 25, 45, 65].map(u => cultureAt(1000 + u, 2000, col, 1000, 2000)).join(',') === '0,1,0,1');
  ok('and they keep alternating west of the origin (no negative-modulo hole)',
    [-5, -25, -45].map(u => cultureAt(1000 + u, 2000, col, 1000, 2000)).join(',') === '1,0,1');
  ok('column strips are constant along north', cultureAt(1005, 2000, col, 1000, 2000) === cultureAt(1005, 2999, col, 1000, 2000));

  const row = { ...col, pattern: 'row' };
  ok('row strips are the same pattern turned 90°',
    [5, 25, 45].map(v => cultureAt(1000, 2000 + v, row, 1000, 2000)).join(',') === '0,1,0' &&
    cultureAt(1005, 2005, row, 1000, 2000) === cultureAt(1999, 2005, row, 1000, 2000));
  ok('rotating column strips by 90° makes them run with north',
    [5, 25, 45].map(v => cultureAt(1000, 2000 + v, { ...col, rotationDeg: 90 }, 1000, 2000)).join(',') === '0,1,0' &&
    [5, 25, 45].map(u => cultureAt(1000 + u, 2000, { ...col, rotationDeg: 90 }, 1000, 2000)).join(',') === '0,0,0');

  const gap = { pattern: 'col', width: 20, spacing: 10, rotationDeg: 0 };
  ok('a spacing inserts a bare-soil alley between strips',
    [5, 25, 35, 65].map(u => cultureAt(1000 + u, 2000, gap, 1000, 2000)).join(',') === `0,${BARE.id},1,0`);
  ok('bare soil is land cover 2, distinct from both crops', BARE.id === 2 && BARE.ndvi === 0.13);
  ok('with spacing 0 the alley never appears',
    (() => { for (let u = -200; u < 200; u += 0.5) if (patternCultureUV(u, 0, col) === BARE.id) return false; return true; })());
  ok('the checkerboard needs both axes inside a strip',
    patternCultureUV(5, 5, { ...gap, pattern: 'checker' }) === 0 &&
    patternCultureUV(25, 5, { ...gap, pattern: 'checker' }) === BARE.id &&
    patternCultureUV(5, 25, { ...gap, pattern: 'checker' }) === BARE.id);

  // The fine grid must resolve the strips, or coverage quantises to a flat 0.5.
  ok('the sub-sampling stride gives ≥4 fine cells per strip width',
    [[10, 20], [10, 5], [60, 2], [2, 100]].every(([gsd, w]) => strideFor(gsd, w) >= 4),
    [[10, 20], [10, 5], [60, 2], [2, 100]].map(([g, w]) => `${g}/${w}→${strideFor(g, w)}`).join(' '));
  ok('and it is capped at 24 so a hair-thin strip cannot explode the grid',
    strideFor(60, 0.05) === 24 && strideFor(10, 0.0001) === 24);
}

console.log('\nH. aggregate: PSF, majority and the mixed threshold');
{
  const rows = 16, cols = 16, g = 4;
  const empty = () => new Array(rows * cols).fill(new Float64Array(0));
  // Column blocks 4 fine cells wide = exactly one aggregated pixel wide.
  const stripes = (shift) => {
    const m = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) m[r * cols + c] = Math.floor(((c + shift) % 8) / 4);
    return m;
  };

  const aligned = aggregate(empty(), rows, cols, g, 0, 0, true, 0, stripes(0), 0.8);
  ok('the aggregated grid is the fine grid divided by the stride',
    aligned.rowsAgg === rows / g && aligned.colsAgg === cols / g);
  ok('strips aligned to the pixels give pure pixels, alternating',
    Array.from(aligned.cropMapMixed.slice(0, 4)).join('') === '0101' &&
    Array.from(aligned.cropMapProportionA.slice(0, 4)).join(',') === '1,0,1,0');
  ok('with no bare soil the bare fraction is zero everywhere',
    aligned.cropMapProportionBare.every(v => v === 0));

  const half = aggregate(empty(), rows, cols, g, 0, 0, true, 0, stripes(2), 0.8);
  ok('strips offset half a pixel give a 50/50 mix, flagged 255',
    Array.from(half.cropMapProportionA.slice(0, 4)).join(',') === '0.5,0.5,0.5,0.5' &&
    Array.from(half.cropMapMixed.slice(0, 4)).join('') === '255255255255');
  ok('the majority and centre maps still name a crop when the pixel is mixed',
    Array.from(half.cropMapMajority.slice(0, 4)).join('') === '0101' &&
    Array.from(half.cropMapCenter.slice(0, 4)).join('') === '0101');
  ok('lowering the mixed threshold to 0.5 accepts a 50/50 pixel as pure',
    aggregate(empty(), rows, cols, g, 0, 0, true, 0, stripes(2), 0.5).cropMapMixed.every(v => v !== 255));
  ok('a threshold above 1 makes every pixel mixed',
    aggregate(empty(), rows, cols, g, 0, 0, true, 0, stripes(0), 1.01).cropMapMixed.every(v => v === 255));

  // The PSF spreads signal across pixel edges: purity can only get worse.
  const pure = (s) => {
    const a = aggregate(empty(), rows, cols, g, s, s, true, 0, stripes(0), 0.8);
    return Array.from(a.cropMapMixed).filter(v => v !== 255).length;
  };
  const series = [0, 0.5, 1, 2].map(pure);
  ok('a wider PSF never increases the number of pure pixels',
    series.every((v, i) => i === 0 || v <= series[i - 1]), series.join(' → '));
  ok('a sharp sensor resolves the aligned strips completely', series[0] === (rows / g) * (cols / g));
  ok('a PSF as wide as a pixel destroys them', series[2] < series[0]);

  // Rotation grows the sampled bounding box, so it grows the aggregated grid.
  const rot = aggregate(empty(), rows, cols, g, 0, 0, true, 45, stripes(0), 0.8);
  ok('rotating the sensor enlarges the aggregated bounding box',
    rot.rowsAgg > aligned.rowsAgg && rot.colsAgg > aligned.colsAgg, `${rot.rowsAgg}×${rot.colsAgg}`);
  ok('every returned map has one entry per aggregated pixel',
    [rot.cropMapMixed, rot.cropMapMajority, rot.cropMapCenter, rot.cropMapProportionA, rot.cropMapProportionBare, rot.simsGrid]
      .every(m => m.length === rot.rowsAgg * rot.colsAgg));
}

console.log('\nI. field purity — the documented 50% → 100% phase case');
{
  // 16 × 12 ten-metre pixels; 20 m column strips, i.e. two pixels per strip.
  const { grid } = buildS2Grid(AOI, { res: 10 });
  const [minE, minN] = grid.utmBounds;
  const layout = { pattern: 'col', width: 20, spacing: 0, rotationDeg: 0 };
  ok('the test field is 16 × 12 pixels', grid.cells.length === 192);

  const on = simulateField(grid, [minE, minN], layout, SHARP);
  const off = simulateField(grid, [minE + 5, minN], layout, SHARP);
  ok('strips on the lattice: every pixel is a pure single crop',
    on.purePct === 100 && on.pureA + on.pureB === on.total, `${on.pureA}A + ${on.pureB}B of ${on.total}`);
  ok('strips half a pixel off the lattice: exactly half the pixels straddle an edge',
    off.purePct === 50, `${off.purePct}%`);
  ok('aligning the phase doubles the usable pixels', on.pureA + on.pureB === 2 * (off.pureA + off.pureB));
  ok('the mean crop-A fraction is unchanged by the phase — only its packing moves',
    Math.abs(on.meanPropA - off.meanPropA) < 1e-6, `${on.meanPropA.toFixed(4)} vs ${off.meanPropA.toFixed(4)}`);
  ok('the per-pixel arrays are one entry per grid cell',
    [on.proportionA, on.proportionBare, on.mixed].every(a => a.length === grid.cells.length));

  // bestPhaseOffset must find the 5 m shift that puts the edges back on the lattice.
  const [du, dv] = bestPhaseOffset('col', 10, 20, 0, 0.8, minE + 5, minN);
  ok('the search only moves the striping axis', dv === 0 && du > 0);
  // The score is flat across every shift that keeps all 16 sub-samples of a
  // pixel inside one strip, and the search keeps the FIRST maximiser, so it
  // stops just short of the exact 5 m — anywhere in that plateau aligns.
  ok('it lands within one sub-sample of the ideal 5 m shift',
    Math.abs(du - 5) < 10 / 16, `du=${du.toFixed(4)}, sub-sample=${(10 / 16).toFixed(4)} m`);
  ok('and applying it restores 100% purity',
    simulateField(grid, [minE + 5 + du, minN + dv], layout, SHARP).purePct === 100);
  ok('an already-aligned pattern is left effectively alone',
    simulateField(grid, [minE + bestPhaseOffset('col', 10, 20, 0, 0.8, minE, minN)[0], minN], layout, SHARP).purePct === 100);
  ok('a row pattern moves the cross-row axis instead',
    (() => { const [u, v] = bestPhaseOffset('row', 10, 20, 0, 0.8, minE, minN + 5); return u === 0 && v > 0; })());

  // Bare soil is a land cover, but it is NOT a resolvable crop pixel.
  const withGap = simulateField(grid, [minE, minN], { ...layout, spacing: 20 }, SHARP);
  ok('a bare alley produces pure bare pixels', withGap.pureBare > 0, `${withGap.pureBare} bare of ${withGap.total}`);
  ok('every pixel is still classified (nothing is mixed here)',
    withGap.pureA + withGap.pureB + withGap.pureBare === withGap.total);
  ok('but purePct counts crop pixels only, excluding bare soil',
    Math.abs(withGap.purePct - (100 * (withGap.pureA + withGap.pureB)) / withGap.total) < 1e-9 && withGap.purePct < 100,
    `${withGap.purePct.toFixed(2)}% with ${withGap.pureBare} bare`);
  ok('the bare fraction is reported per pixel and averages the alley width',
    Math.abs([...withGap.proportionBare].reduce((a, b) => a + b, 0) / withGap.total - 0.5) < 0.05);

  // The PSF is set in step 2 but consumed here — a coupling a refactor must keep.
  const blurred = simulateField(grid, [minE, minN], layout, { sigmaX: 1, sigmaY: 1, mixThreshold: 0.8 });
  ok('a blurred sensor loses the pure pixels an aligned pattern would have given',
    blurred.purePct < on.purePct, `${blurred.purePct.toFixed(1)}% vs ${on.purePct}%`);
}

console.log('\nJ. resolution');
{
  const { grid } = buildS2Grid(AOI, { res: 10 });
  const [minE, minN] = grid.utmBounds;
  const layout = { pattern: 'col', width: 25, spacing: 0, rotationDeg: 0 };

  // Same pattern, same origin, only the pixel size changes.
  const patch = gsd => simulatePatch(minE, minN, 200, gsd, minE, minN, layout, SHARP);
  const p = [50, 25, 20, 10, 5, 2.5, 1].map(patch);
  ok('a pixel twice the strip width resolves nothing', p[0].purePct === 0, `${p[0].purePct}%`);
  ok('a pixel at or below a quarter of the strip width resolves everything',
    p[4].purePct === 100 && p[5].purePct === 100 && p[6].purePct === 100,
    [p[4], p[5], p[6]].map(x => x.purePct).join(' '));
  ok('the finest resolution is far better than the coarsest', p[6].purePct - p[0].purePct === 100);
  // characterizes current behaviour, and it is correct: purity is not monotone
  // in the GSD. A 25 m pixel on a 25 m strip is perfect, a 20 m pixel on it is
  // not — divisibility beats fineness. The UI's sweep chart is meant to show this.
  ok('purity is NOT monotone in the GSD: divisibility wins',
    p[1].purePct === 100 && p[2].purePct < p[1].purePct, `25 m→${p[1].purePct}% 20 m→${p[2].purePct}%`);
  ok('the patch reports its own pixel dimensions and one value per pixel',
    p[3].nx === 20 && p[3].ny === 20 && p[3].proportionA.length === p[3].nx * p[3].ny);
  ok('shifting the pattern off the patch lattice halves purity',
    simulatePatch(minE, minN, 200, 10, minE + 5, minN, { ...layout, width: 20 }, SHARP).purePct === 50);

  // resolutionSweep runs the same engine over a 100 m window at the AOI centre.
  const gsds = [60, 30, 20, 10, 5];
  const sweep = resolutionSweep(AOI, 32631, { pattern: 'col', width: 20, spacing: 0, rotationDeg: 0 }, gsds, SHARP);
  ok('the sweep returns one point per requested GSD, tagged with it',
    sweep.length === gsds.length && sweep.every((s, i) => s.gsd === gsds[i]));
  ok('every purity is a percentage', sweep.every(s => s.purePct >= 0 && s.purePct <= 100));
  ok('pixels at or coarser than the strip width resolve nothing',
    sweep.slice(0, 3).every(s => s.purePct === 0), sweep.map(s => `${s.gsd}:${s.purePct.toFixed(1)}`).join(' '));
  ok('pixels finer than the strips do resolve them',
    sweep[4].purePct === 100 && sweep[3].purePct > 0, `10 m→${sweep[3].purePct.toFixed(1)}% 5 m→${sweep[4].purePct}%`);
  ok('the sweep is deterministic',
    JSON.stringify(resolutionSweep(AOI, 32631, { pattern: 'col', width: 20, spacing: 0, rotationDeg: 0 }, gsds, SHARP)) === JSON.stringify(sweep));
  // Unlike simulateField, the sweep counts a pure BARE pixel as resolved.
  const withGap = resolutionSweep(AOI, 32631, { pattern: 'col', width: 20, spacing: 20, rotationDeg: 0 }, [5], SHARP);
  ok('the sweep counts any unmixed pixel, bare soil included', withGap[0].purePct === 100, `${withGap[0].purePct}%`);
}

console.log('\nK. observation noise is seeded and bounded');
{
  const truth = makeTruth('double', 120, DEFAULT_PARS);
  const varPx = makeBetaSchedule(120, 2, 2, 0.02);
  const a = simulate(truth, varPx, { n: 8, seed: 42 });
  const b = simulate(truth, varPx, { n: 8, seed: 42 });
  const c = simulate(truth, varPx, { n: 8, seed: 43 });
  ok('the shape is n series of T days', a.length === 8 && a[0].length === 120);
  ok('the same seed replays exactly', a.every((r, i) => r.every((v, t) => v === b[i][t])));
  ok('a different seed gives a different draw',
    a.some((r, i) => r.some((v, t) => v !== c[i][t])));
  ok('every value stays strictly inside (0,1)', a.every(r => r.every(v => v > 0 && v < 1)));
  ok('zero variance reproduces the truth exactly',
    simulate(truth, new Float64Array(120), { n: 3, seed: 1 }).every(r => r.every((v, t) => Math.abs(v - truth[t]) < 1e-12)));
  ok('variance is capped at the binomial maximum, so nothing blows up',
    simulate(truth, new Float64Array(120).fill(1e6), { n: 4, seed: 7 }).every(r => r.every(v => v > 0 && v < 1)));
}

console.log('\nL. the exported shapefile is a real zipped shapefile');
{
  const { grid } = buildS2Grid([4.7, 50.6, 4.7005, 50.6003], { res: 10 });
  const n = grid.cells.length;
  const blob = gridToShapefileZip(grid, 's2_pixels_10m');
  ok('it is a zip Blob', blob.type === 'application/zip' && blob.size > 0, `${blob.size} bytes`);

  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const crcTable = (() => { const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let x = i; for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1; t[i] = x >>> 0; } return t; })();
  const crc32 = d => { let x = 0xffffffff; for (let i = 0; i < d.length; i++) x = crcTable[(x ^ d[i]) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };

  const files = new Map();
  let off = 0;
  while (off + 4 <= buf.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const crc = dv.getUint32(off + 14, true);
    const size = dv.getUint32(off + 18, true);
    const nlen = dv.getUint16(off + 26, true), elen = dv.getUint16(off + 28, true);
    const name = String.fromCharCode(...buf.slice(off + 30, off + 30 + nlen));
    files.set(name, { method, crc, data: buf.slice(off + 30 + nlen + elen, off + 30 + nlen + elen + size) });
    off += 30 + nlen + elen + size;
  }
  ok('the local file headers name every sidecar the GIS needs',
    [...files.keys()].join(' ') === 's2_pixels_10m.shp s2_pixels_10m.shx s2_pixels_10m.dbf s2_pixels_10m.prj s2_pixels_10m.cpg',
    [...files.keys()].join(' '));
  ok('every member is STOREd, not deflated', [...files.values()].every(f => f.method === 0));
  ok('every stored CRC matches its bytes', [...files.values()].every(f => crc32(f.data) === f.crc));

  let cd = 0, p = off;
  while (p + 4 <= buf.length && dv.getUint32(p, true) === 0x02014b50) {
    cd++;
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  ok('the central directory lists all five members', cd === 5, `${cd}`);
  ok('the end-of-central-directory record closes the file',
    dv.getUint32(p, true) === 0x06054b50 && dv.getUint16(p + 10, true) === 5 &&
    dv.getUint32(p + 16, true) === off && p + 22 === buf.length);

  const shp = files.get('s2_pixels_10m.shp').data;
  const sv = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  ok('the .shp header carries file code 9994 and shape type 5 (Polygon)',
    sv.getInt32(0, false) === 9994 && sv.getInt32(28, true) === 1000 && sv.getInt32(32, true) === 5);
  ok('the declared file length in 16-bit words is the real length',
    sv.getInt32(24, false) === shp.length / 2, `${sv.getInt32(24, false)} vs ${shp.length / 2}`);
  ok('the header bbox is the grid\'s snapped UTM extent',
    [0, 1, 2, 3].every(i => sv.getFloat64(36 + 8 * i, true) === grid.utmBounds[i]),
    grid.utmBounds.join(','));
  ok('there is exactly one fixed-size record per cell',
    (shp.length / 2 - 50) / (4 + 64) === n, `${(shp.length / 2 - 50) / (4 + 64)} vs ${n}`);
  ok('record 1 is a 1-based, 64-word, single-part 5-point polygon',
    sv.getInt32(100, false) === 1 && sv.getInt32(104, false) === 64 &&
    sv.getInt32(108, true) === 5 && sv.getInt32(144, true) === 1 && sv.getInt32(148, true) === 5);
  const ring = [0, 1, 2, 3, 4].map(i => [sv.getFloat64(156 + 16 * i, true), sv.getFloat64(164 + 16 * i, true)]);
  const c0 = grid.cells[0];
  ok('its ring is the cell square, closed and wound clockwise',
    JSON.stringify(ring) === JSON.stringify([
      [c0.east, c0.north], [c0.east, c0.north + 10],
      [c0.east + 10, c0.north + 10], [c0.east + 10, c0.north], [c0.east, c0.north]]),
    JSON.stringify(ring[0]));

  const shx = files.get('s2_pixels_10m.shx').data;
  const xv = new DataView(shx.buffer, shx.byteOffset, shx.byteLength);
  ok('the .shx is a 100-byte header plus one 8-byte entry per record', shx.length === 100 + 8 * n);
  ok('its first entry points just past the .shp header, with the same record length',
    xv.getInt32(100, false) === 50 && xv.getInt32(104, false) === 64);
  ok('its offsets step by one whole record', xv.getInt32(108, false) === 50 + 4 + 64);

  const dbf = files.get('s2_pixels_10m.dbf').data;
  const bv = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength);
  const headerSize = bv.getUint16(8, true), recSize = bv.getUint16(10, true);
  ok('the .dbf is dBASE III with one record per cell', dbf[0] === 0x03 && bv.getUint32(4, true) === n);
  ok('its length is header + n·record + EOF marker',
    dbf.length === headerSize + n * recSize + 1 && dbf[dbf.length - 1] === 0x1a);
  const fields = [];
  for (let i = 32; i < headerSize - 1; i += 32) {
    fields.push(String.fromCharCode(...dbf.slice(i, i + 11)).replace(/\0+$/, '') + ':' + String.fromCharCode(dbf[i + 11]));
  }
  ok('it carries the nine attributes the workflow needs',
    fields.join(' ') === 'COL:N ROW:N EAST:N NORTH:N ZONE:N HEMI:C EPSG:N RES_M:N MGRS_TILE:C', fields.join(' '));
  const rec0 = String.fromCharCode(...dbf.slice(headerSize, headerSize + recSize));
  ok('record 0 is undeleted and holds the first cell\'s indices and coordinates',
    rec0[0] === ' ' && rec0.includes(String(c0.col)) && rec0.includes(String(c0.row)) &&
    rec0.includes(c0.east.toFixed(2)) && rec0.includes(c0.north.toFixed(2)), `[${rec0}]`);
  ok('and its zone / hemisphere / EPSG / resolution',
    rec0.includes(' 31') && rec0.includes('N') && rec0.includes('32631') && rec0.includes('10.00'));

  const prj = String.fromCharCode(...files.get('s2_pixels_10m.prj').data);
  ok('the .prj names the grid\'s own UTM zone', prj.includes('PROJCS["WGS_1984_UTM_Zone_31N"'), prj.slice(0, 38));
  ok('with the matching central meridian and UTM constants',
    prj.includes('PARAMETER["Central_Meridian",3.0]') && prj.includes('PARAMETER["Scale_Factor",0.9996]') &&
    prj.includes('PARAMETER["False_Easting",500000.0]') && prj.includes('PARAMETER["Latitude_Of_Origin",0.0]'));
  // characterizes current behaviour; cosmetic only: every other WKT constant is
  // a hard-coded "0.0"-style literal, but the false northing is interpolated
  // from a JS number, so it renders as "0" / "10000000" with no decimal point.
  // ESRI/GDAL parse it fine — noted so a refactor does not "fix" it by accident.
  ok('the false northing is written without a decimal point',
    prj.includes('PARAMETER["False_Northing",0]'), /False_Northing",[-\d.]+/.exec(prj)?.[0]);
  ok('the .cpg declares UTF-8', String.fromCharCode(...files.get('s2_pixels_10m.cpg').data) === 'UTF-8');

  // A southern grid must get the 10 000 km false northing, or every plot is 10 000 km out.
  const sg = buildS2Grid([-58.400, -34.620, -58.3995, -34.6197], { res: 10 }).grid;
  const sbuf = new Uint8Array(await gridToShapefileZip(sg, 'south').arrayBuffer());
  const stext = String.fromCharCode(...sbuf);
  ok('a southern grid is written with the southern false northing and zone name',
    stext.includes('WGS_1984_UTM_Zone_21S') && stext.includes('PARAMETER["False_Northing",10000000]'),
    /WGS_1984_UTM_Zone_\w+/.exec(stext)?.[0] + ' ' + /False_Northing",[-\d.]+/.exec(stext)?.[0]);
}

console.log('\n' + (bad ? `${bad} FAILURE(S)` : 'ALL PIXEL-GRID CHECKS PASSED'));
process.exit(bad ? 1 : 0);
