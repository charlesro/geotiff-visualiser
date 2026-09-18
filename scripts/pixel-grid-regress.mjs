/**
 * Regression suite for the Pixel Grid Designer's pure modules:
 * run with `npm run test:pixel-grid`.
 *
 * The tool itself (src/pixel-grid/PixelGridApp.tsx) is one big component that
 * only orchestrates; everything that can be *wrong* lives in three dependency-
 * free-ish modules underneath it:
 *
 *   s2-grid.ts    the UTM lattice: if the phase slips by a metre the exported
 *                 shapefile no longer matches the product's pixels,
 *   simulate.ts   the mixed-pixel engine: purity is the number the agronomist
 *                 actually reads off the page,
 *   shapefile.ts  the byte writer: a malformed zip fails silently in QGIS.
 *
 * These are CHARACTERIZATION tests: they pin what the code does today so the
 * component above can be restructured without changing any of it. Where the
 * current behaviour looks wrong it is still asserted, marked with a comment.
 *
 * Same mechanism as the other two suites: transpile the TypeScript with the
 * esbuild that ships inside Vite and exercise it from node. Unlike those, these
 * modules import each other and proj4, so the transpiled tree is written under
 * node_modules/ (mirroring src/), where relative specifiers keep working and node
 * still resolves proj4 by walking up to the project's node_modules.
 *
 * Nothing here touches the network. The one section that exercises
 * `fetchCoveringGrids` (E2) replaces `fetch` with a catalogue of its own, so
 * what is tested is the deadline and the fallback, never a real API.
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
const REVEAL = {
  'src/pixel-grid/simulate.ts': ['const strideFor =', 'function patternCultureUV(', 'function buildCropMap(',
                                'function importedPixelCovers(', 'function aggregateImported('],
  'src/pixel-grid/imported-plan.ts': ['function narrowestFeature(', 'function foldRing('],
};

fs.rmSync(BUILD, { recursive: true, force: true });
for (const rel of ['src/lib/geo.ts', 'src/lib/projections.ts', 'src/pixel-grid/s2-grid.ts', 'src/pixel-grid/geometry.ts', 'src/pixel-grid/simulate.ts', 'src/pixel-grid/shapefile.ts', 'src/pixel-grid/util.ts', 'src/pixel-grid/pca-field.ts', 'src/pixel-grid/ladder.ts', 'src/pixel-grid/ladder-rung.ts', 'src/pixel-grid/sensors.ts', 'src/pixel-grid/design-import.ts', 'src/pixel-grid/imported-plan.ts', 'src/pixel-grid/imported-rotate.ts', 'src/pixel-grid/field-membership.ts']) {
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
  buildS2Grid, aoiUtmOrigin, gridToGeoJson, fetchCoveringGrids, EARTH_SEARCH_URL, STAC_TIMEOUT_MS,
} = await import(path.join(BUILD, 'src/pixel-grid/s2-grid.mjs'));
const {
  makeTruth, makeBetaSchedule, cultureForCell, aggregate, simulate,
  simulateField, simulatePatch, bestPhaseOffset, cultureAt, utmEnvelope,
  resolutionSweep, truthAt, strideFor, patternCultureUV, coverStats, buildCropMap, speciesChannel, importedCoverAt,
  buildBlockPlan, blockPermutation, blockCoverUV, blockPlots, minFeatureM, layoutKey, blockPlacement,
  importedPixelCovers, aggregateImported,
  TMAX, DEFAULT_PARS, BARE, OFF_TRIAL, MIXED, MAX_COVER, MAX_PLOTS, PATTERNS, CROP_COLORS, cropById, parsOf,
} = await import(path.join(BUILD, 'src/pixel-grid/simulate.mjs'));
const { mix3, mixN, distinctColors, coverShares } = await import(path.join(BUILD, 'src/pixel-grid/util.mjs'));
const { embed } = await import(path.join(BUILD, 'src/lib/projections.mjs'));
const { fitCover, axisSigns, pointStyle, samplePts, linearPca, pixelId, MIN_PTS } = await import(path.join(BUILD, 'src/pixel-grid/pca-field.mjs'));
const { trialExtent, importedTrialExtent } = await import(path.join(BUILD, 'src/pixel-grid/ladder.mjs'));
const { ladderKey, rungCellOrigin } = await import(path.join(BUILD, 'src/pixel-grid/ladder-rung.mjs'));
// The real ladder, so a size added to the page is a size these checks cover.
const { RES_LADDER } = await import(path.join(BUILD, 'src/pixel-grid/sensors.mjs'));
const { resolveImportedPlan, varietyKeyOf, convexHull, hullWidth, narrowestFeature, foldRing } = await import(path.join(BUILD, 'src/pixel-grid/imported-plan.mjs'));
const { purePixels, stakeOnGrid, rotateImportedPlan } = await import(path.join(BUILD, 'src/pixel-grid/imported-rotate.mjs'));
const { varietiesOf: readerVarietiesOf, varietyKeyOf: readerVarietyKeyOf } = await import(path.join(BUILD, 'src/pixel-grid/design-import.mjs'));
const { pointInPoly, fieldOverlapTest, viewShowsField } = await import(path.join(BUILD, 'src/pixel-grid/geometry.mjs'));
const { cellInFieldTest } = await import(path.join(BUILD, 'src/pixel-grid/field-membership.mjs'));
const { gridToShapefileZip } = await import(path.join(BUILD, 'src/pixel-grid/shapefile.mjs'));

/**
 * The five two-species patterns, named explicitly rather than read from
 * PATTERNS. Every "did the legacy behaviour move" check iterates THIS: when the
 * block design joined PATTERNS, the pinned table silently grew from 40 rows to
 * 48 and the off-trial guard started testing a pattern it was never about.
 */
const LEGACY_PATTERNS = ['row', 'col', 'checker', 'strip-row-2', 'strip-col-2'];

let bad = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

/** A small field near Louvain-la-Neuve, UTM zone 31N, the app's home ground. */
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

console.log('\nC2. what pixel is in the field');
{
  // The one rule five readers share: the map overlay and its "In field only"
  // view, the pixel count in the step-2 header, the shapefile export, the PCA's
  // pixel selection and every ladder rung all ask cellInFieldTest, which asks
  // geometry.ts's fieldOverlapTest. It used to be "the pixel's CENTRE is in the
  // field", which punched holes along the edge of a field tilted to the pixel
  // rows, so the properties below are pinned rather than left to the next edit.
  const sq = [[1000, 2000], [1030, 2000], [1030, 2030], [1000, 2030]];
  const t = fieldOverlapTest(sq);
  ok('a pixel wholly inside the ring is kept', t(1000, 2000, 10) && t(1010, 2010, 10));
  ok('a pixel sharing only part of its area is kept', t(995, 2000, 10) && t(1025, 2025, 10));
  ok('a pixel touching only along an edge is not', !t(1030, 2000, 10) && !t(990, 2000, 10));
  ok('a pixel touching only at a corner is not', !t(1030, 2030, 10) && !t(990, 1990, 10));
  ok('a pixel nowhere near the ring is not', !t(5000, 5000, 10));
  // The tolerance is 1e-9·size², an AREA: a micrometre of overlap along a 10 m
  // pixel is 1e-5 m² and counts, a nanometre of it is 1e-8 m² and does not.
  ok('the tolerance is on shared area, not on the overlap in metres',
    t(1030 - 1e-6, 2000, 10) && !t(1030 - 1e-9, 2000, 10));
  ok('a ring with fewer than three vertices keeps nothing',
    !fieldOverlapTest([[0, 0], [1, 1]])(0, 0, 10));

  // The case the centre rule got wrong, in one probe: a field tilted 45° to the
  // pixel rows has corner pixels that share area while their centres do not.
  const diamond = [[0, 0], [40, 40], [0, 80], [-40, 40]];
  const td = fieldOverlapTest(diamond);
  ok('a tilted field keeps the corner pixel whose CENTRE is outside',
    td(30, 30, 10) && !pointInPoly(35, 35, diamond));

  // cellInFieldTest is that test in the grid's own UTM metres against the exact
  // lattice square, NOT against the cell's reprojected WGS84 corners.
  const fieldWgs = [[4.7003, 50.6002], [4.7018, 50.6002], [4.7018, 50.6008], [4.7003, 50.6008]];
  const keep = cellInFieldTest(fieldWgs, 32631, 10);
  const toUtm = proj4('EPSG:4326', '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs');
  const direct = fieldOverlapTest(fieldWgs.map(p => toUtm.forward(p)));
  const gC2 = buildS2Grid(AOI, { res: 10 });
  ok('cellInFieldTest is fieldOverlapTest on the projected ring, cell for cell',
    gC2.grid.cells.every(c => keep(c) === direct(c.east, c.north, 10)));
  ok('... and it keeps some of the grid but not all of it',
    (() => { const n = gC2.grid.cells.filter(keep).length; return n > 0 && n < gC2.grid.cells.length; })(),
    `${gC2.grid.cells.filter(keep).length}/${gC2.grid.cells.length}`);
  ok('no usable field ring means no test at all, so every pixel is in',
    cellInFieldTest(null, 32631, 10) === null && cellInFieldTest([[4.7, 50.6], [4.71, 50.6]], 32631, 10) === null);

  // The map reopens where it was left, and that view is saved under its own key
  // with nothing tying it to the field. An import moves the field to the trial,
  // Remove moves it back, a pinned default field can be on another continent:
  // the page then opened on bare ground with the field off screen, no grid and
  // nothing to click. It reads as a broken tool, not as "look elsewhere".
  const belgium = [4.6882, 50.5489, 4.6918, 50.5511];       // [w, s, e, n]
  const midBelgium = [(50.5489 + 50.5511) / 2, (4.6882 + 4.6918) / 2];   // leaflet [lat, lng]
  ok('the saved view is kept when it is looking at the field', viewShowsField(midBelgium, belgium));
  ok('and when it is just off the edge, where the field is still on screen',
    viewShowsField([50.5511 + 0.003, 4.6918 + 0.003], belgium));
  ok('but not from 800 km away, which is the split that showed 0 px over a 10,965 m2 field',
    viewShowsField([50.60046, 4.70027], [1.4943, 43.5320, 1.4963, 43.5329]) === false);
  ok('nor from the next town over',
    viewShowsField([50.5500, 4.7500], belgium) === false);
  ok('a field-less page keeps whatever view it had', viewShowsField(midBelgium, null));
  // A field far smaller than the floor still gets the floor, so a 20 m plot does
  // not send the map home every time the user nudges it.
  const tiny = [4.7000, 50.6000, 4.7002, 50.6001];
  ok('a tiny field is given a workable margin rather than its own span',
    viewShowsField([50.6000 + 0.008, 4.7001], tiny) && viewShowsField([50.6000 + 0.03, 4.7001], tiny) === false);
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
  // nearest index rather than an exact division: the .5 is rounded away.
  ok('col/row round to the nearest index on an off-phase lattice',
    r.grid.cells.every(c => c.col === Math.round(c.east / 30) && Math.abs(c.col - c.east / 30) === 0.5));
  const zeroPhase = buildS2Grid(AOI, { res: 30, anchor: { epsg: 32631, ulx: 300000, uly: 4900020 } });
  ok('a phase-0 anchor is identical to the deterministic rule',
    zeroPhase.utmBounds.join(',') === buildS2Grid(AOI, { res: 30 }).utmBounds.join(','));

  // An anchor whose origin is missing comes from a catalogue item whose
  // proj:transform is short or holds a null. It used to travel the whole way:
  // phase() turned it into NaN, and NaN clears every guard written as a
  // comparison (nx > maxCells and nx <= 0 are BOTH false), so the builder
  // reached `new Array(NaN)` and threw "Invalid array length". buildS2Grid runs
  // in useFieldGrid's own body, outside every error boundary, and both the
  // source and the chosen grid are persisted: that unmounted the page and the
  // reload brought it straight back.
  // It falls back to the deterministic lattice rather than refusing a grid:
  // for every source here that lattice IS the product's (the tile origins are
  // multiples of the pixel size), so the user keeps an exact grid. What it must
  // not do is keep CLAIMING the product's tile it could not read.
  const plain = buildS2Grid(AOI, { res: 30 });
  for (const [what, bad] of [
    ['no origin at all', { epsg: 32631, tile: 'LC31N' }],
    ['a null easting', { epsg: 32631, ulx: null, uly: 4900020, tile: 'LC31N' }],
    ['a NaN northing', { epsg: 32631, ulx: 300000, uly: NaN, tile: 'LC31N' }],
    ['an infinite easting', { epsg: 32631, ulx: Infinity, uly: 4900020, tile: 'LC31N' }],
  ]) {
    let threw = null, out = null;
    try { out = buildS2Grid(AOI, { res: 30, anchor: bad }); } catch (e) { threw = e; }
    ok(`an anchor with ${what} falls back to the exact lattice instead of taking the page down`,
      threw === null && out.grid !== null &&
      out.utmBounds.join(',') === plain.utmBounds.join(',') &&
      out.grid.anchored === false && out.grid.tile === undefined,
      threw ? `threw ${threw.constructor.name}: ${threw.message}`
            : `anchored ${out.grid?.anchored}, tile ${out.grid?.tile}`);
  }
}

console.log('\nE. the cell cap and the viewport clip');
{
  const full = buildS2Grid(AOI, { res: 10 });
  const capped = buildS2Grid(AOI, { res: 10, maxCells: 10 });
  ok('over the cap no grid is built, but the count is still reported',
    capped.grid === null && capped.capped === true && capped.cellCount === full.cellCount, `${capped.cellCount}`);
  ok('and the extent is still returned when the grid is capped',
    capped.utmBounds.join(',') === full.utmBounds.join(','));
  ok('a grid under the cap is not flagged', full.capped === false && full.grid !== null);

  // The clip keeps the lattice phase: it only produces fewer cells.
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

  /**
   * A clip window that misses the area: panning the map away from a capped
   * field. Each axis is judged on its own, because two negative dimensions
   * multiply back into an ordinary looking count. That used to read as "too
   * large" when both axes missed, and, when only one did, as a grid of that many
   * EMPTY array holes, handed to the renderer as cells with no ring.
   */
  const gone = buildS2Grid(AOI, { res: 10, clip: [4.9, 50.9, 4.91, 50.91] });
  ok('a clip window that misses the area on both axes yields no grid',
    gone.grid === null && gone.cellCount === 0 && !gone.capped,
    `count=${gone.cellCount} capped=${gone.capped}`);
  const halfGone = buildS2Grid(AOI, { res: 10, clip: [4.9, 50.6, 4.91, 50.6008] });
  ok('and one that misses on a single axis yields no grid either, not a bag of holes',
    halfGone.grid === null && halfGone.cellCount === 0 && !halfGone.capped,
    `count=${halfGone.cellCount} capped=${halfGone.capped}`);
  const stillTooFine = buildS2Grid(AOI, { res: 0.05, maxCells: 6000 });
  ok('while a grid that is merely too fine is still capped, with its real count',
    stillTooFine.grid === null && stillTooFine.capped && stillTooFine.cellCount > 6000, `${stillTooFine.cellCount} cells`);
  const overField = buildS2Grid(AOI, { res: 10, clip: [4.7010, 50.6005, 4.7020, 50.6015] });
  ok('and a clip over the area still builds real cells',
    !!overField.grid && Array.from(overField.grid.cells).every(c => c && c.ring.length === 5),
    `${overField.grid?.cells.length} cells`);

  // A zero-area area still snaps outward to one whole pixel.
  const pt = buildS2Grid([4.7, 50.6, 4.7, 50.6], { res: 10 });
  ok('a zero-area area yields exactly one pixel', pt.cellCount === 1 && pt.grid.cells.length === 1);

  const south = buildS2Grid([-58.400, -34.620, -58.396, -34.618], { res: 10 });
  ok('a southern-hemisphere area gets a 327xx CRS',
    south.epsg === 32721 && south.grid.south === true && south.grid.zone === 21, `${south.epsg}`);
}

console.log('\nE2. the catalogue lookup gives up rather than hang');
{
  /**
   * Still no network: `fetch` is replaced for this section by a catalogue that
   * accepts the request and then says nothing, which is what a hung socket does
   * and what no error handler ever sees. Without a deadline of its own, step 2
   * sat on "Identifying" for as long as the browser's own timeout, so the
   * offline fallback never engaged.
   */
  const realFetch = globalThis.fetch;
  const cfg = { collection: 'sentinel-2-l2a', asset: 'B02', res: 10, gridLabel: () => 'T31UFS' };
  const ITEM = {
    features: [{ properties: { 'proj:epsg': 32631 }, assets: { B02: { 'proj:transform': [10, 0, 499980, 0, -10, 5600040] } } }],
  };
  const calls = [];
  // A socket that opens and then stops: it settles only when something aborts it.
  const stall = (url, init) => {
    calls.push(url);
    return new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason)));
  };
  const settle = async p => p.then(v => ({ value: v }), e => ({ name: e?.name, message: e?.message }));

  globalThis.fetch = stall;
  const t0 = performance.now();
  const timedOut = await settle(fetchCoveringGrids(AOI, cfg, undefined, 40));
  const tookMs = performance.now() - t0;
  ok('a catalogue that never answers ends in a TimeoutError, not a hang',
    timedOut.name === 'TimeoutError' && tookMs < 1000, `${timedOut.name} after ${tookMs.toFixed(0)} ms`);
  // The cases below pass their own deadline; this is the one the page ships.
  ok('and the shipped deadline is a real one, in seconds not minutes',
    STAC_TIMEOUT_MS > 0 && STAC_TIMEOUT_MS <= 15000, `${STAC_TIMEOUT_MS} ms`);

  // The second catalogue is asked with a deadline of its own: a shared one
  // would already be spent by the time the first one's stall handed over.
  calls.length = 0;
  const withAlt = { ...cfg, alt: { ...cfg, url: EARTH_SEARCH_URL } };
  const bothOut = await settle(fetchCoveringGrids(AOI, withAlt, undefined, 40));
  ok('a stalled catalogue still hands over to the second one, which gets its own deadline',
    bothOut.name === 'TimeoutError' && calls.length === 2 && calls[1] === EARTH_SEARCH_URL, `${calls.length} calls`);

  // The caller's own abort (the user redraws the area) is not a timeout: it
  // must reach fetchCoveringGrids' catch as an abort so the alt is not asked.
  calls.length = 0;
  const ctrl = new AbortController();
  const aborted = settle(fetchCoveringGrids(AOI, withAlt, ctrl.signal, 5000));
  ctrl.abort(new Error('redrawn'));
  const abortRes = await aborted;
  ok('the caller\'s own abort is passed straight on, and no second catalogue is asked',
    abortRes.message === 'redrawn' && calls.length === 1, `${abortRes.message}, ${calls.length} calls`);

  // A deadline that is never cleared aborts a request that was already answered:
  // the signal handed to fetch must be dead in the water once the body is read.
  calls.length = 0;
  let served = null;
  globalThis.fetch = (url, init) => { calls.push(url); served = init.signal; return Promise.resolve({ ok: true, json: async () => ITEM }); };
  const found = await fetchCoveringGrids(AOI, cfg, undefined, 40);
  await new Promise(r => setTimeout(r, 120));
  ok('an answered lookup reads its grid and leaves no timer running behind it',
    found.length === 1 && found[0].epsg === 32631 && served.aborted === false,
    `${found.length} grid(s), signal aborted=${served.aborted}`);

  // A catalogue that answers with a transform it cannot honour. These are real
  // shapes in the wild (a cropped array, a null where a number belongs), and
  // every one of them used to become an "anchor" whose origin was undefined or
  // null: the first crashed the page out of a hook with no boundary above it,
  // the second silently anchored on 0. An item that cannot say where its pixels
  // are is not a covering grid, so it is not offered as one.
  for (const [what, transform] of [
    ['too short to hold an origin', [10, 0, 499980]],
    ['a null easting', [10, 0, null, 0, -10, 5600040]],
    ['a string northing', [10, 0, 499980, 0, -10, '5600040']],
    ['nothing at all', null],
  ]) {
    globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({
      features: [{ properties: { 'proj:epsg': 32631 }, assets: { B02: { 'proj:transform': transform } } }],
    }) });
    let threw = null, grids = null;
    try { grids = await fetchCoveringGrids(AOI, cfg, undefined, 200); } catch (e) { threw = e; }
    ok(`a catalogue item whose transform is ${what} is skipped, not turned into an anchor`,
      threw === null && grids.length === 0,
      threw ? `threw ${threw.message}` : `${grids.length} grid(s): ${JSON.stringify(grids.map(g => [g.ulx, g.uly]))}`);
  }

  globalThis.fetch = realFetch;
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
  // sign (-1 % 2 === -1), and a -1 matches neither crop id, and it used to render as
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
  ok('bare soil sits above the species id space, distinct from both crops',
    BARE.id === 254 && BARE.ndvi === 0);
  ok('the three sentinels are distinct and all above MAX_COVER',
    new Set([BARE.id, OFF_TRIAL.id, MIXED]).size === 3 &&
    [BARE.id, OFF_TRIAL.id, MIXED].every(v => v > MAX_COVER) && MAX_COVER === 252,
    `bare ${BARE.id} off ${OFF_TRIAL.id} mixed ${MIXED} max ${MAX_COVER}`);
  ok('no legacy pattern ever emits the off-trial sentinel',
    (() => {
      for (const id of LEGACY_PATTERNS) for (let u = -60; u <= 60; u += 0.7) for (let v = -60; v <= 60; v += 0.7) {
        const c = patternCultureUV(u, v, { pattern: id, width: 7, spacing: 3, rotationDeg: 0 });
        if (c !== 0 && c !== 1 && c !== BARE.id) return false;
      }
      return true;
    })());
  ok('and PATTERNS still holds exactly the five legacy designs, the block design and the imported trial',
    PATTERNS.map(p => p.id).join(',') === [...LEGACY_PATTERNS, 'block', 'imported'].join(','),
    PATTERNS.map(p => p.id).join(','));
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

console.log('\nG2. the five two-species patterns, pinned byte for byte');
{
  // Measured from the build BEFORE the sentinels moved and the per-species
  // channel was added. Every row must reproduce exactly: these are the numbers
  // that prove the legacy paths did not drift when BARE went from 2 to 254.
  const PINNED = `row 20/0 sharp 100.0000 96 96 0 0.500000\ncol 20/0 sharp 100.0000 96 96 0 0.500000\nchecker 20/0 sharp 100.0000 96 96 0 0.500000\nstrip-row-2 20/0 sharp 100.0000 128 64 0 0.666667\nstrip-col-2 20/0 sharp 100.0000 96 96 0 0.500000\nrow 13/0 sharp 41.6667 48 32 0 0.541667\ncol 13/0 sharp 43.7500 48 36 0 0.515625\nchecker 13/0 sharp 18.2292 18 17 0 0.501302\nstrip-row-2 13/0 sharp 66.6667 64 64 0 0.541667\nstrip-col-2 13/0 sharp 68.7500 60 72 0 0.500000\nrow 20/5 sharp 66.6667 96 32 0 0.500000\ncol 20/5 sharp 62.5000 84 36 0 0.437500\nchecker 20/5 sharp 41.6667 48 32 0 0.343750\nstrip-row-2 20/5 sharp 66.6667 80 48 0 0.500000\nstrip-col-2 20/5 sharp 62.5000 72 48 0 0.500000\nrow 30/10 sharp 75.0000 96 48 48 0.500000\ncol 30/10 sharp 75.0000 72 72 48 0.375000\nchecker 30/10 sharp 56.2500 54 54 84 0.281250\nstrip-row-2 30/10 sharp 75.0000 96 48 48 0.500000\nstrip-col-2 30/10 sharp 75.0000 72 72 48 0.375000\nrow 20/0 blur 100.0000 96 96 0 0.500000\ncol 20/0 blur 100.0000 96 96 0 0.500000\nchecker 20/0 blur 27.0833 26 26 0 0.500000\nstrip-row-2 20/0 blur 100.0000 128 64 0 0.666667\nstrip-col-2 20/0 blur 100.0000 96 96 0 0.500000\nrow 13/0 blur 8.3333 16 0 0 0.538455\ncol 13/0 blur 6.2500 12 0 0 0.513324\nchecker 13/0 blur 0.0000 0 0 0 0.501025\nstrip-row-2 13/0 blur 66.6667 64 64 0 0.539957\nstrip-col-2 13/0 blur 68.7500 60 72 0 0.498763\nrow 20/5 blur 66.6667 96 32 0 0.499766\ncol 20/5 blur 56.2500 72 36 0 0.435024\nchecker 20/5 blur 12.5000 16 8 0 0.342882\nstrip-row-2 20/5 blur 66.6667 80 48 0 0.499825\nstrip-col-2 20/5 blur 56.2500 72 36 0 0.501194\nrow 30/10 blur 75.0000 96 48 0 0.503183\ncol 30/10 blur 75.0000 72 72 0 0.374999\nchecker 30/10 blur 38.0208 37 36 24 0.283040\nstrip-row-2 30/10 blur 75.0000 96 48 0 0.499999\nstrip-col-2 30/10 blur 75.0000 72 72 0 0.374999`;
  const { grid } = buildS2Grid([4.7000, 50.6000, 4.7021, 50.6010], { res: 10 });
  const [minE, minN] = grid.utmBounds;
  const rows = [];
  for (const [label, sensor] of [['sharp', { sigmaX: 0, sigmaY: 0, mixThreshold: 0.8 }], ['blur', { sigmaX: 0.62, sigmaY: 0.62, mixThreshold: 0.8 }]])
    for (const [w, sp] of [[20, 0], [13, 0], [20, 5], [30, 10]])
      for (const id of LEGACY_PATTERNS) {
        const f = simulateField(grid, [minE, minN], { pattern: id, width: w, spacing: sp, rotationDeg: 0 }, sensor);
        rows.push(`${id} ${w}/${sp} ${label} ${f.purePct.toFixed(4)} ${f.pureA} ${f.pureB} ${f.pureBare} ${f.meanPropA.toFixed(6)}`);
      }
  const got = rows.join('\n');
  const firstDiff = got === PINNED ? '' : got.split('\n').find((r, i) => r !== PINNED.split('\n')[i]);
  ok('all 40 legacy rows reproduce their pinned purity, counts and mean fraction',
    got === PINNED, firstDiff ? `first drift: ${firstDiff}` : `${rows.length} rows`);
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

  // PSF centre offset: the kernel peaks on a neighbour, so the pixel reads that
  // neighbour's crop. The numbers must move, not just the drawing on the map.
  const centred = aggregate(empty(), rows, cols, g, 0.3, 0.3, true, 0, stripes(0), 0.8);
  const near = (a, b) => Math.abs(a - b) < 0.05;
  const east1 = aggregate(empty(), rows, cols, g, 0.3, 0.3, true, 0, stripes(0), 0.8, 1, 0);
  const east2 = aggregate(empty(), rows, cols, g, 0.3, 0.3, true, 0, stripes(0), 0.8, 2, 0);
  ok('a kernel offset one pixel east reads the eastern neighbour',
    near(east1.cropMapProportionA[0], centred.cropMapProportionA[1]) &&
    near(east1.cropMapProportionA[1], centred.cropMapProportionA[2]),
    `${east1.cropMapProportionA[0].toFixed(2)},${east1.cropMapProportionA[1].toFixed(2)} vs centred ${centred.cropMapProportionA.slice(0, 4).join(',')}`);
  ok('a two-pixel offset reaches two pixels over',
    near(east2.cropMapProportionA[0], centred.cropMapProportionA[2]));
  ok('a zero offset is byte-identical to a centred kernel',
    Array.from(aggregate(empty(), rows, cols, g, 0.3, 0.3, true, 0, stripes(0), 0.8, 0, 0).cropMapProportionA).join(',') ===
    Array.from(centred.cropMapProportionA).join(','));

  // Hand-computed cross-check of the kernel. With sigma 1 and the centre pushed
  // 1.5 px east, pixel (1,1) averages its four columns with weights
  // exp(-0.5*(nc-2.5)^2) over column crops [1,0,1,0], which is 0.4342 by hand.
  // One number that pins the kernel shape, the sign of the offset and the window.
  const off15 = aggregate(empty(), rows, cols, g, 1, 1, true, 0, stripes(0), 0.8, 1.5, 0);
  const mid = off15.cropMapProportionA[1 * off15.colsAgg + 1];
  ok('the offset kernel matches a hand-computed weighted average',
    Math.abs(mid - 0.4342) < 0.005, mid.toFixed(4));

  // The Y AXIS, which the x-only checks above cannot see. Row indices grow
  // north (buildCropMap), so +offY must read the band to the north. A symmetric
  // design hides a flipped sign in the purity total, so compare per pixel.
  // ASYMMETRIC bands: one crop-A row, then two crop-B rows. An alternating
  // pattern gives a pixel the same crop to its north and to its south, so it
  // cannot tell the two directions apart, which is exactly how a flipped sign
  // survives a test suite. Rows grow north (buildCropMap), so agg row 0 is the
  // southern edge and the crop-A fractions run [1, 0, 0, 1] from south to north.
  const bands = () => {
    const m = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) m[r * cols + c] = Math.floor(r / g) % 3 === 0 ? 0 : 1;
    return m;
  };
  const bCentred = aggregate(empty(), rows, cols, g, 0.3, 0.3, true, 0, bands(), 0.8);
  const W = bCentred.colsAgg;
  const bNorth = aggregate(empty(), rows, cols, g, 0.3, 0.3, true, 0, bands(), 0.8, 0, 1);
  const bSouth = aggregate(empty(), rows, cols, g, 0.3, 0.3, true, 0, bands(), 0.8, 0, -1);
  ok('a kernel offset one pixel north reads the row to the NORTH',
    near(bNorth.cropMapProportionA[W], bCentred.cropMapProportionA[2 * W]),
    `${bNorth.cropMapProportionA[W].toFixed(2)} vs the row north of it ${bCentred.cropMapProportionA[2 * W].toFixed(2)}`);
  ok('a kernel offset one pixel south reads the row to the SOUTH',
    near(bSouth.cropMapProportionA[W], bCentred.cropMapProportionA[0]),
    `${bSouth.cropMapProportionA[W].toFixed(2)} vs the row south of it ${bCentred.cropMapProportionA[0].toFixed(2)}`);
  ok('north and south offsets disagree, so the sign cannot be lost',
    Math.abs(bNorth.cropMapProportionA[W] - bSouth.cropMapProportionA[W]) > 0.5,
    `north ${bNorth.cropMapProportionA[W].toFixed(2)} vs south ${bSouth.cropMapProportionA[W].toFixed(2)}`);

  // Offline lattices south of the equator. The two products are distributed
  // differently and the plain "multiple of the pixel size" rule fits neither:
  // measured against live metadata, S2 60 m was 20 m out and HLS 30 m 10 m out.
  const southAoi = [-51.10, -25.05, -51.09, -25.04];
  const mod = (v, r) => ((v % r) + r) % r;
  const s2South = buildS2Grid(southAoi, { res: 60, anchor: { epsg: utmEpsg(22, true), ulx: 0, uly: 10_000_000 } });
  ok('the Sentinel-2 southern offline lattice sits on the false northing',
    s2South.epsg === 32722 && s2South.grid.cells.every(c => mod(c.north, 60) === mod(10_000_000, 60)),
    `epsg ${s2South.epsg}, phase ${mod(s2South.grid.cells[0].north, 60)}`);
  const hlsSouth = buildS2Grid(southAoi, { res: 30, anchor: { epsg: utmEpsg(22, false), ulx: 0, uly: 0 } });
  ok('the HLS southern offline lattice stays in the northern CRS at phase 0',
    hlsSouth.epsg === 32622 && hlsSouth.grid.cells.every(c => mod(c.north, 30) === 0) && hlsSouth.grid.cells[0].north < 0,
    `epsg ${hlsSouth.epsg}, first northing ${hlsSouth.grid.cells[0].north}`);
}

console.log('\nH2. the per-species channel is additive, not a rewrite');
{
  const rows = 16, cols = 16, g = 4;
  const empty = () => new Array(rows * cols).fill(new Float64Array(0));
  const stripes = () => {
    const m = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) m[r * cols + c] = Math.floor((c % 8) / 4);
    return m;
  };
  const legacy = aggregate(empty(), rows, cols, g, 0.5, 0.5, true, 0, stripes(), 0.8);
  const withSp = aggregate(empty(), rows, cols, g, 0.5, 0.5, true, 0, stripes(), 0.8, 0, 0, null, 2);

  ok('asking for no species allocates no species channel',
    legacy.cropMapSpecies === null && legacy.cropMapDominant === null && legacy.cropMapProportionOffTrial === null);
  ok('and leaves every legacy array byte-identical',
    Array.from(legacy.cropMapProportionA).join(',') === Array.from(withSp.cropMapProportionA).join(',') &&
    Array.from(legacy.cropMapMixed).join(',') === Array.from(withSp.cropMapMixed).join(',') &&
    Array.from(legacy.cropMapProportionBare).join(',') === Array.from(withSp.cropMapProportionBare).join(','));
  // Not bit-exact by promise: proportionA divides once and stores once, while
  // the species fold sums then divides. Two orders, so the last bit may differ.
  // 1e-7 is under a float32 ULP near 0.5 and still catches any real fold error
  // (a dropped or double-counted cover moves this by orders of magnitude).
  ok('species 0 of the new channel is the old proportionA, to within a float32 ULP',
    withSp.cropMapProportionA.every((v, k) => Math.abs(withSp.cropMapSpecies[k * 2] - v) < 1e-7),
    `worst ${Math.max(...Array.from(withSp.cropMapProportionA, (v, k) => Math.abs(withSp.cropMapSpecies[k * 2] - v))).toExponential(2)}`);
  ok('every pixel is a partition: species + bare + off-trial sums to 1',
    withSp.cropMapProportionA.every((_, k) => {
      const s = withSp.cropMapSpecies[k * 2] + withSp.cropMapSpecies[k * 2 + 1];
      return Math.abs(s + withSp.cropMapProportionBare[k] + withSp.cropMapProportionOffTrial[k] - 1) < 1e-6;
    }));
  ok('the dominant species is the argmax of the species vector',
    withSp.cropMapDominant.every((d, k) => {
      const a = withSp.cropMapSpecies[k * 2], b = withSp.cropMapSpecies[k * 2 + 1];
      return d === (a >= b ? 0 : 1) && Math.abs(withSp.cropMapDominantFrac[k] - Math.max(a, b)) < 1e-6;
    }));

  const st = coverStats({ mixed: withSp.cropMapMixed, nSpecies: 2 });
  let pureA = 0, pureB = 0, pureBare = 0;
  for (const v of withSp.cropMapMixed) { if (v === 0) pureA++; else if (v === 1) pureB++; else if (v === BARE.id) pureBare++; }
  ok('coverStats reproduces the tally it replaced',
    st.pureBySpecies[0] === pureA && st.pureBySpecies[1] === pureB && st.pureBare === pureBare &&
    st.total === withSp.cropMapMixed.length && Math.abs(st.purePct - (100 * (pureA + pureB)) / st.total) < 1e-9,
    `A ${st.pureBySpecies[0]} B ${st.pureBySpecies[1]} bare ${st.pureBare} of ${st.total}`);
  ok('a pixel more than half off-trial is left out of the denominator',
    (() => {
      const mixed = new Uint8Array([0, 1, 0, 1]);
      const off = new Float32Array([0, 0, 0.9, 0.4]);
      const s = coverStats({ mixed, offTrial: off, nSpecies: 2 });
      return s.total === 3 && s.offTrial === 1 && s.pureCrop === 3;
    })());
}

console.log('\nH3. the randomised block design: geometry and reproducibility');
{
  const design = { nSpecies: 4, nBlocks: 4, plotLength: 8, plotWidth: 2, plotAlley: 0.5, blockAlley: 1.5, blocksPerRow: 1, seed: 1 };
  const plan = buildBlockPlan(design, { centerU: 0, centerV: 0, snap: 0 });

  ok('the plan resolves to n species x n blocks plots',
    plan.nPlots === 16 && plan.plotSpecies.length === 16 && plan.design.nBlocks === 4);
  ok('a block spans its plots plus the alleys between them',
    Math.abs(plan.blockV - (4 * 2 + 3 * 0.5)) < 1e-9 && plan.blockU === 8,
    `${plan.blockU} x ${plan.blockV}`);
  ok('the footprint is the blocks plus the alleys between blocks, with none trailing',
    Math.abs(plan.totalU - (4 * (8 + 1.5) - 1.5)) < 1e-9 && Math.abs(plan.totalV - plan.blockV) < 1e-9,
    `${plan.totalU} x ${plan.totalV}`);

  // Randomisation: complete blocks, reproducible, and stable when extended.
  ok('every block is a complete permutation of the species',
    (() => {
      for (let sp = 2; sp <= 8; sp++) for (let nb = 1; nb <= 20; nb++) {
        const p = buildBlockPlan({ ...design, nSpecies: sp, nBlocks: nb }, { centerU: 0, centerV: 0 });
        for (let b = 0; b < p.design.nBlocks; b++) {
          const got = Array.from(p.plotSpecies.slice(b * sp, (b + 1) * sp)).sort((x, y) => x - y).join(',');
          if (got !== Array.from({ length: sp }, (_, i) => i).join(',')) return false;
        }
      }
      return true;
    })());
  ok('the same seed replays exactly, a different seed does not',
    Array.from(blockPermutation(4, 2, 7)).join(',') === Array.from(blockPermutation(4, 2, 7)).join(',') &&
    [0, 1, 2, 3].some(b => Array.from(blockPermutation(4, b, 7)).join(',') !== Array.from(blockPermutation(4, b, 8)).join(',')));
  ok('adding a repetition leaves every earlier block byte-identical',
    Array.from(buildBlockPlan({ ...design, nBlocks: 5 }, { centerU: 0, centerV: 0, snap: 0 }).plotSpecies.slice(0, 16)).join(',') ===
    Array.from(plan.plotSpecies).join(','));
  ok('the permutation is not the identity everywhere (the LCG warm-up works)',
    Array.from({ length: 12 }, (_, b) => Array.from(blockPermutation(4, b, 1)).join(',')).some(s => s !== '0,1,2,3'));
  ok('no clock and no global RNG: two plans built apart are identical',
    (() => {
      const a = buildBlockPlan(design, { centerU: 0, centerV: 0, snap: 0 });
      let x = 0; for (let i = 0; i < 2e5; i++) x += Math.sqrt(i);
      const b = buildBlockPlan(design, { centerU: 0, centerV: 0, snap: 0 });
      return x > 0 && Array.from(a.plotSpecies).join(',') === Array.from(b.plotSpecies).join(',') && a.u0 === b.u0;
    })());

  // Geometry: plots tile exactly, nothing leaks, negatives are safe.
  const step = 0.1, seen = new Map();
  let invalid = 0, bare = 0, off = 0;
  for (let u = plan.u0 - 3; u < plan.u0 + plan.totalU + 3; u += step)
    for (let v = plan.v0 - 3; v < plan.v0 + plan.totalV + 3; v += step) {
      const c = blockCoverUV(u, v, plan);
      if (c === OFF_TRIAL.id) { off++; continue; }
      if (c === BARE.id) { bare++; continue; }
      if (c < 0 || c >= plan.nPlots) { invalid++; continue; }
      seen.set(c, (seen.get(c) || 0) + 1);
    }
  ok('every plot appears and no sample lands on an invalid id',
    seen.size === 16 && invalid === 0 && bare > 0 && off > 0, `${seen.size} plots, ${invalid} invalid`);
  ok('each plot measures plotLength x plotWidth',
    [...seen.values()].every(n => Math.abs(n * step * step - 16) < 0.5),
    `${Math.min(...[...seen.values()].map(n => n * step * step)).toFixed(2)} to ${Math.max(...[...seen.values()].map(n => n * step * step)).toFixed(2)} m2`);
  ok('far negative coordinates are off-trial, never a wrapped plot id',
    (() => {
      for (let u = -200; u < -50; u += 0.7) for (let v = -200; v < -50; v += 0.7)
        if (blockCoverUV(u, v, plan) !== OFF_TRIAL.id) return false;
      return true;
    })());
  ok('with both alleys zero the trial tiles solid, no bare inside the footprint',
    (() => {
      const solid = buildBlockPlan({ ...design, plotAlley: 0, blockAlley: 0 }, { centerU: 0, centerV: 0, snap: 0 });
      for (let u = solid.u0 + 0.05; u < solid.u0 + solid.totalU; u += 0.25)
        for (let v = solid.v0 + 0.05; v < solid.v0 + solid.totalV; v += 0.25)
          if (blockCoverUV(u, v, solid) === BARE.id) return false;
      return true;
    })());
  ok('the ragged last row is off-trial, not a phantom block',
    (() => {
      const ragged = buildBlockPlan({ ...design, nBlocks: 3, blocksPerRow: 2 }, { centerU: 0, centerV: 0, snap: 0 });
      const u = ragged.u0 + ragged.pitchU + ragged.blockU / 2;   // second row
      const v = ragged.v0 + ragged.pitchV + ragged.blockV / 2;   // second column: block 3, absent
      return blockCoverUV(u, v, ragged) === OFF_TRIAL.id;
    })());

  // The map and the simulation must read the same plan.
  ok('every blockPlots rectangle centre returns that plot, with that species',
    blockPlots(plan).every(r =>
      blockCoverUV((r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2, plan) === r.plot &&
      plan.plotSpecies[r.plot] === r.species));

  // Ids are minted under the sentinels, whatever a UI might ask for.
  const huge = buildBlockPlan({ ...design, nSpecies: 8, nBlocks: 40 }, { centerU: 0, centerV: 0 });
  ok('the block count is capped where ids are minted, below the sentinels',
    huge.nPlots - 1 <= MAX_COVER && huge.design.nBlocks === Math.floor(MAX_PLOTS / 8),
    `${huge.design.nBlocks} blocks, highest id ${huge.nPlots - 1}, ceiling ${MAX_COVER}`);

  // Anchoring and the layout key.
  ok('the trial is centred on the field, and snaps to the pixel lattice when asked',
    (() => {
      const free = buildBlockPlan(design, { centerU: 100, centerV: 200, snap: 0 });
      const snapped = buildBlockPlan(design, { centerU: 100, centerV: 200, snap: 10 });
      return Math.abs(free.u0 + free.totalU / 2 - 100) < 1e-9 &&
             snapped.u0 % 10 === 0 && snapped.v0 % 10 === 0;
    })());
  ok('minFeatureM is the plot width for legacy layouts and the narrowest feature for a block',
    LEGACY_PATTERNS.every(id => minFeatureM({ pattern: id, width: 7, spacing: 3, rotationDeg: 0 }) === 7) &&
    minFeatureM({ pattern: 'block', width: 2, spacing: 0, rotationDeg: 0, block: plan }) === 0.5);
  ok('layoutKey moves when any block parameter moves',
    (() => {
      const L = { pattern: 'block', width: 2, spacing: 0, rotationDeg: 0, block: plan };
      const base = layoutKey(L);
      const perturbed = [
        { ...design, nSpecies: 3 }, { ...design, nBlocks: 5 }, { ...design, plotLength: 9 },
        { ...design, plotWidth: 3 }, { ...design, plotAlley: 1 }, { ...design, blockAlley: 2 },
        { ...design, blocksPerRow: 2 }, { ...design, seed: 2 },
      ].map(d => layoutKey({ ...L, block: buildBlockPlan(d, { centerU: 0, centerV: 0, snap: 0 }) }));
      const moved = layoutKey({ ...L, block: buildBlockPlan(design, { centerU: 7, centerV: 0, snap: 0 }) });
      return new Set([base, ...perturbed, moved]).size === perturbed.length + 2;
    })());
}

console.log('\nH5. a block trial is anchored in the frame the engine samples');
{
  // Every check in H3 builds its plan at centerU/centerV = 0, where a frame
  // error is invisible because zero is zero in every frame. This section uses
  // the page's REAL inputs, which is how the wiring bug it pins got through.
  const design = { nSpecies: 4, nBlocks: 4, plotLength: 8, plotWidth: 2, plotAlley: 0.5, blockAlley: 1.5, blocksPerRow: 1, seed: 1 };
  const res = 10;
  const origin = aoiUtmOrigin(AOI, 32631);           // what the engine measures (u,v) from
  // A snapped grid whose edge is deliberately NOT a round multiple of the pixel
  // size: Landsat C2 really does sit at 15 m mod 30.
  const minE = Math.floor(origin[0] / res) * res + 5;
  const minN = Math.floor(origin[1] / res) * res + 5;
  const bounds = [minE, minN, minE + 150, minN + 120];
  const place = blockPlacement(bounds, origin, 0, res, true);
  const plan = buildBlockPlan(design, place);

  ok('the trial lands on the field, not 620 km away in raw UTM',
    blockPlots(plan).every(r => {
      const E = origin[0] + (r.u0 + r.u1) / 2, N = origin[1] + (r.v0 + r.v1) / 2;
      return E > bounds[0] && E < bounds[2] && N > bounds[1] && N < bounds[3];
    }), `u0 ${plan.u0.toFixed(2)}, v0 ${plan.v0.toFixed(2)}`);
  ok('every plot centre reads back as that plot through the engine frame',
    blockPlots(plan).every(r => blockCoverUV((r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2, plan) === r.plot));
  ok('anchoring the plan in raw UTM instead puts the whole field off-trial',
    (() => {
      const wrong = buildBlockPlan(design, { centerU: (bounds[0] + bounds[2]) / 2, centerV: (bounds[1] + bounds[3]) / 2, snap: 0 });
      for (let u = 0; u < 150; u += 7) for (let v = 0; v < 120; v += 7)
        if (blockCoverUV(u, v, wrong) !== OFF_TRIAL.id) return false;
      return true;
    })());
  ok('plot edges land on real pixel edges, whatever the lattice phase',
    phaseOf(plan.u0 - place.phaseU, res) < 1e-9 && phaseOf(plan.v0 - place.phaseV, res) < 1e-9,
    `u0 ${plan.u0.toFixed(2)}, lattice phase ${phaseOf(place.phaseU, res).toFixed(2)}`);
  ok('and a snap to bare multiples of the pixel size would have missed them',
    phaseOf(place.phaseU, res) > 1e-9 && phaseOf(place.phaseV, res) > 1e-9);
  ok('snapping is off for a rotated trial, whose plots cannot be pixel-aligned',
    blockPlacement(bounds, origin, 30, res, true).snap === 0 &&
    blockPlacement(bounds, origin, 0, res, true).snap === res &&
    blockPlacement(bounds, origin, 0, res, false).snap === 0);
  ok('snapping moves the trial by less than one pixel, so it stays centred',
    Math.abs(plan.u0 + plan.totalU / 2 - place.centerU) <= res &&
    Math.abs(plan.v0 + plan.totalV / 2 - place.centerV) <= res);
}

console.log('\nH6. purity is counted across ALL species, not the first two');
{
  // Nothing in this suite exercised a block trial's PER-SPECIES purity, which is
  // exactly how pureA/pureB could describe 2 plots out of 16 while every check
  // stayed green. simulateField and simulatePatch now pass the plot-to-species
  // table that aggregate and coverStats always accepted.
  const design = { nSpecies: 4, nBlocks: 4, plotLength: 8, plotWidth: 2, plotAlley: 0.5, blockAlley: 1.5, blocksPerRow: 1, seed: 1 };
  const res = 0.5;
  const origin = aoiUtmOrigin(AOI, 32631);
  const minE = Math.floor(origin[0] / res) * res, minN = Math.floor(origin[1] / res) * res;
  const place = blockPlacement([minE, minN, minE + 260, minN + 245], origin, 0, res, true);
  const plan = buildBlockPlan(design, place);
  const layout = { pattern: 'block', width: 2, spacing: 0, rotationDeg: 0, block: plan };
  const patch = simulatePatch(origin[0] + plan.u0 - 5, origin[1] + plan.v0 - 5, 60, res,
    origin[0], origin[1], layout, { sigmaX: 0, sigmaY: 0, mixThreshold: 1.0 });

  ok('the patch carries the species count of the design it simulated',
    patch.nSpecies === 4, `${patch.nSpecies}`);
  ok('the per-species composition channel is populated, one row per pixel',
    patch.proportionBySpecies !== null &&
    patch.proportionBySpecies.length === patch.nx * patch.ny * 4,
    `${patch.proportionBySpecies ? patch.proportionBySpecies.length : 'null'}`);

  const st = coverStats({ mixed: patch.mixed, coverSpecies: plan.plotSpecies, nSpecies: 4 });
  ok('every one of the four species has pure pixels of its own',
    st.pureBySpecies.length === 4 && Array.from(st.pureBySpecies).every(v => v > 0),
    Array.from(st.pureBySpecies).join(', '));
  ok('the per-species counts account for every pure pixel, none lost',
    Array.from(st.pureBySpecies).reduce((a, b) => a + b, 0) === st.pureCrop,
    `${Array.from(st.pureBySpecies).reduce((a, b) => a + b, 0)} vs ${st.pureCrop}`);

  // The defect this section exists for, stated as a measurement.
  let twoIdOnly = 0;
  for (let k = 0; k < patch.mixed.length; k++) if (patch.mixed[k] === 0 || patch.mixed[k] === 1) twoIdOnly++;
  ok('reading only cover ids 0 and 1 undercounts a 16-plot trial badly',
    twoIdOnly < st.pureCrop / 4,
    `${twoIdOnly} of ${st.pureCrop} pure pixels, ${(100 * twoIdOnly / st.pureCrop).toFixed(0)}%`);

  // A balanced RCBD gives every species the same area, so the sensor should see
  // about the same amount of each. This is what feeds the season curve.
  const mean = Array.from(patch.meanBySpecies);
  ok('the mean composition is balanced across species, as a complete block is',
    mean.length === 4 && mean.every(v => v > 0) &&
    Math.max(...mean) - Math.min(...mean) < 0.25 * Math.max(...mean),
    mean.map(v => v.toFixed(3)).join(', '));
  ok('species fractions never exceed the whole pixel',
    mean.reduce((a, b) => a + b, 0) <= 1 + 1e-6,
    mean.reduce((a, b) => a + b, 0).toFixed(3));

  // Identity for the five periodic layouts: they carry no block plan, so the
  // channel is the two-species one and every legacy answer is untouched.
  const rows = simulatePatch(origin[0], origin[1], 40, 1, origin[0], origin[1],
    { pattern: 'row', width: 3, spacing: 0, rotationDeg: 0 }, { sigmaX: 0, sigmaY: 0, mixThreshold: 1.0 });
  ok('a periodic layout still reports exactly two species',
    rows.nSpecies === 2 && rows.meanBySpecies.length === 2, `${rows.nSpecies}`);
}

console.log('\nH7. no cell is painted black: the blend is told about off-trial ground');
{
  // The map overlay colours a cell by handing its composition to mixN. A cell
  // OUTSIDE a finite trial has an all-zero species vector, so mixN skips every
  // fraction, ends with zero weight and divides by `w || 1`: solid black, over
  // most of the field. Nothing in this suite touches simStyle, so the colour
  // rule is pinned here against the sentinels it must respect.
  const design = { nSpecies: 4, nBlocks: 4, plotLength: 8, plotWidth: 2, plotAlley: 0.5, blockAlley: 1.5, blocksPerRow: 1, seed: 1 };
  const res = 2;
  const origin = aoiUtmOrigin(AOI, 32631);
  const minE = Math.floor(origin[0] / res) * res, minN = Math.floor(origin[1] / res) * res;
  const place = blockPlacement([minE, minN, minE + 260, minN + 245], origin, 0, res, true);
  const plan = buildBlockPlan(design, place);
  const layout = { pattern: 'block', width: 2, spacing: 0, rotationDeg: 0, block: plan };
  const patch = simulatePatch(origin[0] + plan.u0 - 24, origin[1] + plan.v0 - 24, 90, res,
    origin[0], origin[1], layout, { sigmaX: 0.6, sigmaY: 0.55, mixThreshold: 1.0 });
  const COLORS = CROP_COLORS.slice(0, 4);

  ok('a pixel entirely outside the trial blends to off-trial grey, not black',
    mixN([0, 0, 0, 0], COLORS, 0, 1) === OFF_TRIAL.color,
    `${mixN([0, 0, 0, 0], COLORS, 0, 1)} vs ${OFF_TRIAL.color}`);
  ok('and without the off-trial weight that same pixel is solid black',
    mixN([0, 0, 0, 0], COLORS, 0, 0) === '#000000');

  // Every cell of a real trial, coloured with the SAME weights the map passes:
  // the continuous off-trial fraction, not a 0/1 stand-in for it. A partly
  // off-trial cell with faint species fractions is exactly the case a coarse
  // proxy would wave through.
  ok('the patch reports a per-pixel off-trial fraction for the blend to weight',
    patch.proportionOffTrial !== null && patch.proportionOffTrial.length === patch.nx * patch.ny,
    `${patch.proportionOffTrial ? patch.proportionOffTrial.length : 'null'}`);
  const n = patch.nSpecies, sp = patch.proportionBySpecies;
  let black = 0, cells = 0, partial = 0;
  for (let k = 0; k < patch.mixed.length; k++) {
    const fr = Array.from(sp.subarray(k * n, k * n + n));
    const off = patch.proportionOffTrial ? patch.proportionOffTrial[k] : 0;
    if (off > 0.01 && off < 0.99) partial++;
    cells++;
    if (mixN(fr, COLORS, patch.proportionBare[k], off) === '#000000') black++;
  }
  ok('no cell in a whole simulated patch comes back black',
    black === 0, `${black} black of ${cells}`);
  ok('the patch really does contain off-trial ground, so the check has teeth',
    Array.from(patch.mixed).some(m => m === OFF_TRIAL.id),
    `${Array.from(patch.mixed).filter(m => m === OFF_TRIAL.id).length} off-trial cells`);
}

console.log('\nH8. the PCA embedding can see more than two species');
{
  // The DR embedding had NO test coverage anywhere in this repo, which is how a
  // two-species reconstruction survived unnoticed inside both PCA visuals. What
  // matters is not the picture but the arithmetic: a mixture of N distinct
  // species spans N-1 directions, while a mixture of two spans exactly one, no
  // matter how many species the design actually contains.
  const NPT = 24;
  const curveOf = (f) => {
    const full = makeTruth(f.truth, TMAX, parsOf(f));
    return Array.from({ length: NPT }, (_, i) => full[Math.round((i * (TMAX - 1)) / (NPT - 1))]);
  };
  const species = ['maize', 'wheat', 'soy', 'beet'].map(id => cropById(id));
  const curves = species.map(curveOf);
  const rows = [], fracs = [];
  const push = (fr) => {
    fracs.push(fr);
    rows.push(Array.from({ length: NPT }, (_, t) => fr.reduce((m, f, i) => m + f * curves[i][t], 0)));
  };
  for (let i = 0; i < 4; i++) { const fr = [0, 0, 0, 0]; fr[i] = 1; for (let r = 0; r < 6; r++) push(fr.slice()); }
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const fr = [0, 0, 0, 0]; fr[i] = 0.5; fr[j] = 0.5; for (let r = 0; r < 3; r++) push(fr.slice());
  }

  const res = embed('pca', { fit: rows, proj: rows, components: 4 });
  ok('the embedding returns one score row per pixel and the components asked for',
    res.scores.length === rows.length && res.explained.length === 4,
    `${res.scores.length} rows, ${res.explained.length} components`);
  ok('a four-species mixture carries real variance on a THIRD axis',
    res.explained[2] > 1, `PC3 ${res.explained[2].toFixed(1)}%`);

  // The reconstruction both visuals used to build: one scalar, everything else
  // declared to be a second crop. It is rank one by construction.
  const rows2 = fracs.map(fr => {
    const pA = fr[0], pB = 1 - pA;
    return Array.from({ length: NPT }, (_, t) => pA * curves[0][t] + pB * curves[1][t]);
  });
  const res2 = embed('pca', { fit: rows2, proj: rows2, components: 4 });
  ok('the two-curve reconstruction it replaced has essentially none, whatever the design',
    res2.explained[2] < 0.5, `PC3 ${res2.explained[2].toFixed(3)}%`);
  ok('so the old path could not have shown a third species even in principle',
    res.explained[2] > res2.explained[2] * 10 + 1,
    `${res.explained[2].toFixed(1)}% vs ${res2.explained[2].toFixed(3)}%`);
}

console.log('\nH9. a pixel is described by its WHOLE footprint, bare soil included');
{
  // The PCA tooltip, species colouring and purity test divided each species by
  // the CROP cover alone. A pixel lying in an alley holds two slivers of blur
  // spill from the plots either side, so dividing them by each other called a
  // mostly bare pixel "50% maize, 50% grass". Pinned on a REAL alley pixel.
  const design = { nSpecies: 4, nBlocks: 2, plotLength: 8, plotWidth: 2, plotAlley: 1.5, blockAlley: 1.5, blocksPerRow: 1, seed: 1 };
  const res = 0.5;
  const origin = aoiUtmOrigin(AOI, 32631);
  const minE = Math.floor(origin[0] / res) * res, minN = Math.floor(origin[1] / res) * res;
  const plan = buildBlockPlan(design, blockPlacement([minE, minN, minE + 120, minN + 120], origin, 0, res, true));
  const layout = { pattern: 'block', width: 2, spacing: 0, rotationDeg: 0, block: plan };
  const patch = simulatePatch(origin[0] + plan.u0 - 2, origin[1] + plan.v0 - 2, 44, res,
    origin[0], origin[1], layout, { sigmaX: 0.6, sigmaY: 0.6, mixThreshold: 1.0 });
  const n = patch.nSpecies, sp = patch.proportionBySpecies, off = patch.proportionOffTrial;
  const at = k => Array.from(sp.subarray(k * n, k * n + n));
  let alley = -1, interior = -1;
  for (let k = 0; k < patch.mixed.length; k++) {
    const fr = at(k), crop = fr.reduce((a, b) => a + b, 0), bare = patch.proportionBare[k];
    if (alley < 0 && bare > 0.8 && crop > 1e-3 && (off ? off[k] : 0) < 0.05) alley = k;
    if (interior < 0 && Math.max(...fr) > 0.99) interior = k;
  }
  ok('the simulated trial has an alley pixel carrying some blur spill', alley >= 0);
  const fr = at(alley), bare = patch.proportionBare[alley], o = off ? off[alley] : 0;
  const c = coverShares(fr, bare, o);
  ok('that alley pixel is dominated by bare soil, not by a crop',
    c.dominant.kind === 'bare', `${c.dominant.kind} ${(100 * c.dominant.share).toFixed(0)}%`);
  ok('its crops are slivers of the pixel, not an even split',
    Math.max(...c.species) < 0.2, c.species.map(v => (100 * v).toFixed(1) + '%').join(' '));
  const cropOnly = fr.map(v => v / fr.reduce((a, b) => a + b, 0));
  ok('dividing by the crop cover alone is what made it look like a crop mix',
    Math.max(...cropOnly) >= 0.4, cropOnly.map(v => (100 * v).toFixed(0) + '%').filter(s => s !== '0%').join(' / '));
  ok('shares of the whole footprint sum to one',
    Math.abs(c.species.reduce((a, b) => a + b, 0) + c.bare + c.off - 1) < 1e-9);
  ok('a pixel inside a plot is dominated by that plot\'s own species',
    interior >= 0 && coverShares(at(interior), patch.proportionBare[interior], off ? off[interior] : 0).dominant.kind === 'species');
  ok('an empty footprint names no crop at all',
    coverShares([0, 0, 0], 0, 0).dominant.kind === 'off');
  ok('ground outside the trial is named as such, not as a crop',
    coverShares([0.02, 0], 0.03, 0.95).dominant.kind === 'off');
}

console.log('\nH10. the big PCA and its ladder thumbnails are one computation');
{
  // The thumbnail at the current resolution used to sample a central window with
  // its own noise, signs and colours, so it could not look like the chart above
  // it. Both now go through pca-field; these pin the properties that make the
  // thumbnail the big chart in miniature.
  const design = { nSpecies: 4, nBlocks: 4, plotLength: 8, plotWidth: 2, plotAlley: 0.5, blockAlley: 1.5, blocksPerRow: 1, seed: 1 };
  const res = 0.5;
  const origin = aoiUtmOrigin(AOI, 32631);
  const minE = Math.floor(origin[0] / res) * res, minN = Math.floor(origin[1] / res) * res;
  const plan = buildBlockPlan(design, blockPlacement([minE, minN, minE + 120, minN + 120], origin, 0, res, true));
  const layout = { pattern: 'block', width: 2, spacing: 0, rotationDeg: 0, block: plan };
  const src = simulatePatch(origin[0] + plan.u0 - 3, origin[1] + plan.v0 - 3, 44, res,
    origin[0], origin[1], layout, { sigmaX: 0.6, sigmaY: 0.6, mixThreshold: 0.95 });
  const species = ['maize', 'wheat', 'soy', 'grass'].map(id => cropById(id));

  const big = fitCover(src, species, 0.04, 'pca');
  ok('asking again with the same data returns the very same fit object',
    fitCover(src, species, 0.04, 'pca') === big);
  ok('a capped fit is a different computation, not a cache hit',
    fitCover(src, species, 0.04, 'pca', { fitCap: 500 }) !== big);

  const offAll = src.proportionOffTrial;
  const trial = Array.from(src.proportionA, (_, k) => k).filter(k => (offAll ? offAll[k] : 0) <= 0.5).length;
  ok('every trial pixel becomes a point, and ground mostly outside the trial does not',
    big.pts.length === trial && big.tooFew === 0, `${big.pts.length} points, ${trial} trial pixels`);

  // Capped fits for the other resolutions: the axes they find must be the same axes.
  const cap = fitCover(src, species, 0.04, 'pca', { fitCap: 500 });
  const corr = (a, b) => { const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb); };
  const r1 = corr(big.pts.map(p => p.s[0]), cap.pts.map(p => p.s[0]));
  const r2 = corr(big.pts.map(p => p.s[1]), cap.pts.map(p => p.s[1]));
  ok('a fit on a subset finds the same first two axes as the full fit',
    Math.abs(r1) > 0.99 && Math.abs(r2) > 0.99, `|r| PC1 ${Math.abs(r1).toFixed(4)}, PC2 ${Math.abs(r2).toFixed(4)}`);

  // One orientation rule for every view: a mirrored fit (scores AND loadings
  // negated, which is all a PCA's sign ambiguity is) comes back facing the same way.
  const [sx, sy] = axisSigns(big, 0, 1, species);
  const mirrored = { ...big, pts: big.pts.map(p => ({ ...p, s: p.s.map((v, i) => (i < 2 ? -v : v)) })),
    loadings: big.loadings.map((l, i) => (i < 2 ? l.map(v => -v) : l)) };
  const [mx, my] = axisSigns(mirrored, 0, 1, species);
  ok('a mirrored fit gets the opposite signs, so both views end up facing the same way',
    mx === -sx && my === -sy && big.pts.every((p, i) => sx * p.s[0] === mx * mirrored.pts[i].s[0]));
  const noLoadings = { ...big, loadings: [] };
  const [nx1, ny1] = axisSigns(noLoadings, 0, 1, species);
  const [nx2, ny2] = axisSigns({ ...mirrored, loadings: [] }, 0, 1, species);
  ok('a method without loadings is oriented from the pixels instead, by the same promise',
    nx2 === -nx1 && ny2 === -ny1);

  const alley = big.pts.find(p => p.bare > 0.9);
  ok('an alley pixel is drawn in bare-soil colour in species mode, in both views',
    !!alley && pointStyle(alley, 'species', 'none', CROP_COLORS).color === BARE.color);

  // The ladder's thumbnails embed a hashed sample, not every pixel.
  const sampled = fitCover(src, species, 0.04, 'pca', { sample: 300 });
  const fullKs = new Set(big.pts.map(p => p.k));
  ok('a sampled thumbnail keeps about the requested number of trial pixels, all real ones',
    sampled.pts.length > 200 && sampled.pts.length < 400 && sampled.pts.every(p => fullKs.has(p.k)),
    `${sampled.pts.length} of ${big.pts.length}`);
  ok('drawing a subsample of the big fit keeps the same pixels on every call',
    samplePts(big.pts, 300).map(p => p.k).join() === samplePts(big.pts, 300).map(p => p.k).join() &&
    samplePts(big.pts, 300).length < big.pts.length);

  const tiny = { ...src, proportionA: src.proportionA.slice(0, MIN_PTS - 1), proportionBare: src.proportionBare.slice(0, MIN_PTS - 1),
    proportionBySpecies: src.proportionBySpecies.slice(0, (MIN_PTS - 1) * src.nSpecies), proportionOffTrial: null };
  const small = fitCover(tiny, species, 0.04, 'pca');
  ok('too few trial pixels is reported, not embedded into a meaningless chart',
    small.pts.length === 0 && small.tooFew === MIN_PTS - 1, `${small.tooFew}`);

  // The big chart's PCA is solved from the covariance, not by ml-pca's SVD of
  // the whole matrix (that SVD was most of a resolution change at 0.5 m). It
  // must be the SAME PCA: same variance per axis, same scores up to sign.
  const NTP = 24;
  const curvesP = species.map(f => { const full = makeTruth(f.truth, TMAX, parsOf(f)); return Array.from({ length: NTP }, (_, i) => full[Math.round((i * (TMAX - 1)) / (NTP - 1))]); });
  let seed = 11; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const nP = 3000, rowsP = [];
  for (let j = 0; j < nP; j++) {
    const w = species.map(() => rnd() ** 3), tot = w.reduce((a, b) => a + b, 0) + rnd() * 0.3;
    rowsP.push(Array.from({ length: NTP }, (_, t) => w.reduce((m, wi, i) => m + (wi / tot) * curvesP[i][t], 0) + (rnd() - 0.5) * 0.02));
  }
  const flat = Float64Array.from(rowsP.flat());
  for (const step of [1, 7]) {
    const mine = linearPca(flat, nP, NTP, step, 4);
    const ref = embed('pca', { fit: step > 1 ? rowsP.filter((_, i) => i % step === 0) : rowsP, proj: rowsP, components: 4 });
    const dExp = Math.max(...mine.explained.map((v, i) => Math.abs(v - ref.explained[i])));
    const rs = [0, 1, 2].map(c => Math.abs(corr(mine.scores.map(s => s[c]), ref.scores.map(s => s[c]))));
    const dScale = Math.max(...[0, 1, 2].map(c => Math.abs(Math.hypot(...mine.scores.map(s => s[c])) - Math.hypot(...ref.scores.map(s => s[c]))) / Math.hypot(...ref.scores.map(s => s[c]))));
    ok(`the covariance PCA is ml-pca's PCA${step > 1 ? ', fitted on a subset' : ''}: same variance per axis, same scores up to sign`,
      dExp < 1e-6 && rs.every(r => r > 0.999999) && dScale < 1e-6,
      `max explained diff ${dExp.toExponential(1)}, |r| ${rs.map(r => r.toFixed(7)).join(' ')}, scale diff ${dScale.toExponential(1)}`);
  }
}

console.log('\nH10b. the scatter and the purity numbers decide pure/mixed by ONE rule');
{
// The scatter's pure/mixed and the page's pure/mixed are ONE decision. They used
// to be two: pointStyle read the species-FOLDED share while the engine weighs a
// single cover id, which on a block or imported trial is one PLOT. A pixel
// sitting in two plots of the same variety was mixed in the purity card and in
// every ladder count, and green in the scatter, at the same time.
{
  // Two species, six touching blocks, and a purity threshold of 90%: the plots
  // that meet along the block boundaries carry the same variety on both sides.
  const design = { nSpecies: 2, nBlocks: 6, plotLength: 6, plotWidth: 6, plotAlley: 0, blockAlley: 0, blocksPerRow: 1, seed: 3 };
  const pureT = 90;
  const resP = 1;
  const originP = aoiUtmOrigin(AOI, 32631);
  const minE = Math.floor(originP[0] / resP) * resP, minN = Math.floor(originP[1] / resP) * resP;
  const planP = buildBlockPlan(design, blockPlacement([minE, minN, minE + 120, minN + 120], originP, 0, resP, true));
  const layoutP = { pattern: 'block', width: 6, spacing: 0, rotationDeg: 0, block: planP };
  const srcP = simulatePatch(originP[0] + planP.u0 - 2, originP[1] + planP.v0 - 2, 60, resP,
    originP[0], originP[1], layoutP, { sigmaX: 0.6, sigmaY: 0.6, mixThreshold: pureT / 100 });
  const speciesP = ['maize', 'wheat'].map(id => cropById(id));
  const fitP = fitCover(srcP, speciesP, 0.04, 'pca');
  const greenP = p => pointStyle(p, 'purity', 'purity', CROP_COLORS, pureT).color === '#22c55e';
  const foldedPure = p => {
    const d = coverShares(p.fr, p.bare, p.off).dominant;
    return d.kind === 'species' && d.share >= pureT / 100;
  };

  // Without this the checks below would pass on a fixture that never exercises
  // the disagreement. These are exactly the pixels the old rule drew green.
  const split = fitP.pts.filter(p => srcP.mixed[p.k] === MIXED && foldedPure(p));
  ok('the fixture really does hold pixels the two rules used to disagree about',
    split.length > 50, `${split.length} of ${fitP.pts.length}`);
  ok('a pixel in two plots of one variety is drawn mixed, as the purity card counts it',
    split.every(p => !greenP(p)));
  ok('every point in the scatter is pure exactly when the engine says it is',
    fitP.pts.every(p => greenP(p) === (srcP.mixed[p.k] !== MIXED)));

  // The verdict survives the thinning a thumbnail applies, so a ladder rung and
  // the big chart cannot colour one pixel two ways.
  const thumbP = fitCover(srcP, speciesP, 0.04, 'pca', { sample: 300 });
  ok('and in a sampled thumbnail of the same simulation',
    thumbP.pts.every(p => greenP(p) === (srcP.mixed[p.k] !== MIXED)));

  // A source with no engine verdict (a hand-built fixture, a caller that never
  // ran the engine) still gets the share rule rather than everything called pure.
  const fitN = fitCover({ ...srcP, mixed: null }, speciesP, 0.04, 'pca');
  ok('with no verdict to read, the share rule against the slider still decides',
    fitN.pts.some(foldedPure) && fitN.pts.every(p => greenP(p) === foldedPure(p)));

  // A verdict array that does not describe these pixels is ignored rather than
  // applied off by one: the shares and the verdicts are assembled separately.
  const shortV = { ...srcP, mixed: srcP.mixed.slice(0, MIN_PTS) };
  ok('a verdict array of the wrong length is refused rather than shifted onto the wrong pixels',
    fitCover(shortV, speciesP, 0.04, 'pca').pts.every(p => p.mixed === undefined));
}
}

console.log('\nH11. a ladder rung is independent of the displayed size, and costs only the trial');
{
  // Every thumbnail click used to rebuild the whole ladder: each rung borrowed
  // the map's block plan, snapped to the DISPLAYED pixel size, and simulated the
  // whole field. A rung now resolves its own plan at its own size and simulates
  // only the trial's footprint. These pin that the result is unchanged.
  const epsg = 32631;
  const species = ['maize', 'wheat', 'soy', 'grass'].map(id => cropById(id));
  const cases = [
    { aoi: [4.7000, 50.6000, 4.70347, 50.60220], sensor: { sigmaX: 0.6, sigmaY: 0.6, mixThreshold: 0.95 },
      design: { nSpecies: 4, nBlocks: 4, plotLength: 8, plotWidth: 2, plotAlley: 0.5, blockAlley: 1.5, blocksPerRow: 1, seed: 1 } },
    { aoi: [4.7000, 50.6000, 4.70347, 50.60220], sensor: { sigmaX: 1.2, sigmaY: 0.4, mixThreshold: 0.8, offX: 0.7, offY: -0.3 },
      design: { nSpecies: 3, nBlocks: 6, plotLength: 6, plotWidth: 3, plotAlley: 1, blockAlley: 2, blocksPerRow: 2, seed: 3 } },
    { aoi: [4.7000, 50.6000, 4.7021, 50.6010], sensor: { sigmaX: 0.55, sigmaY: 0.55, mixThreshold: 0.95 },
      design: { nSpecies: 4, nBlocks: 4, plotLength: 30, plotWidth: 8, plotAlley: 1.5, blockAlley: 1.5, blocksPerRow: 2, seed: 8 } },
  ];
  const rungOf = (c, r, footprint) => {
    const [minE, minN, maxE, maxN] = utmEnvelope(c.aoi, epsg);
    const base = aoiUtmOrigin(c.aoi, epsg);
    const whole = [Math.floor(minE / r) * r, Math.floor(minN / r) * r, Math.ceil(maxE / r) * r, Math.ceil(maxN / r) * r];
    const plan = buildBlockPlan(c.design, blockPlacement(whole, base, 0, r, true));
    const layout = { pattern: 'block', width: 2, spacing: 0, rotationDeg: 0, block: plan };
    const [e0, n0, e1, n1] = footprint ? trialExtent(plan, base, 0, r, c.sensor, whole) : whole;
    const all = simulateField({ res: r, utmBounds: [e0, n0, e1, n1] }, base, layout, c.sensor);
    const nx = Math.round((e1 - e0) / r);
    const pixelIds = Float64Array.from(all.mixed, (_, k) => pixelId(Math.round((e0 + (k % nx) * r) / r), Math.round((n0 + Math.floor(k / nx) * r) / r)));
    const st = coverStats({ mixed: all.mixed, coverSpecies: plan.plotSpecies, nSpecies: all.nSpecies, offTrial: all.proportionOffTrial });
    return { src: { ...all, pixelIds }, st, plan, whole, n: all.mixed.length };
  };
  let identical = true, smaller = 0, idsMatch = true, plansMatch = true, detail = '';
  for (const c of cases) for (const r of [0.5, 1, 3, 10]) {
    const W = rungOf(c, r, false), T = rungOf(c, r, true);
    const fW = fitCover(W.src, species, 0.04, 'pca'), fT = fitCover(T.src, species, 0.04, 'pca');
    const same = fW.pts.length === fT.pts.length && W.st.purePct === T.st.purePct && W.st.total === T.st.total &&
      fW.pts.every((p, i) => fT.pts[i].id === p.id && p.s.every((v, j) => v === fT.pts[i].s[j]));
    if (!same && identical) detail = `differs at ${r} m`;
    identical = identical && same;
    if (T.n < W.n) smaller++;
    // The big chart's grid at this size names its pixels the way the rung does,
    // and resolves the same trial, so picking the rung shows what it drew.
    const g = buildS2Grid(c.aoi, { res: r, zone: 31, south: false, maxCells: 1e7 });
    idsMatch = idsMatch && g.grid.cells.length === W.n && g.grid.cells.every((cell, k) => pixelId(cell.col, cell.row) === W.src.pixelIds[k]);
    const page = buildBlockPlan(c.design, blockPlacement(g.utmBounds, aoiUtmOrigin(c.aoi, epsg), 0, r, true));
    plansMatch = plansMatch && page.u0 === W.plan.u0 && page.v0 === W.plan.v0;
  }
  ok('a rung simulated over the trial footprint equals the whole-field rung, bitwise, points and purity', identical, detail);
  ok('and it simulates fewer pixels on fields larger than their trial', smaller >= 6, `${smaller} of 12 rungs smaller`);
  ok('a rung names its pixels exactly as the big chart\'s grid does, so noise and sampling agree', idsMatch);
  ok('a rung resolves the same trial the page resolves when that size is picked', plansMatch);

  // The thumbnail and the big chart at that size are ONE fit: same rows in the
  // same order, so the same scores and the same signs. Pinned on a design whose
  // second axis separates two crops (grass twice), where signs taken from a
  // 500-pixel fit used to disagree with the full fit.
  const dup = ['maize', 'wheat', 'soy', 'grass', 'grass'].map(id => cropById(id));
  const userLike = { aoi: [4.746909141540528, 50.53835595467376, 4.74836826324463, 50.53896282711907], sensor: { sigmaX: 0.55, sigmaY: 0.55, mixThreshold: 0.95 },
    design: { nSpecies: 5, nBlocks: 5, plotLength: 15, plotWidth: 15, plotAlley: 1.5, blockAlley: 1.5, blocksPerRow: 1, seed: 8 } };
  let oneFit = true, sameFace = true, detail2 = '';
  for (const r of [1, 2, 3]) {
    const rung = rungOf(userLike, r, true);
    const g = buildS2Grid(userLike.aoi, { res: r, zone: 31, south: false, maxCells: 1e7 }).grid;
    const whole = [g.utmBounds[0], g.utmBounds[1], g.utmBounds[2], g.utmBounds[3]];
    const plan = buildBlockPlan(userLike.design, blockPlacement(whole, aoiUtmOrigin(userLike.aoi, epsg), 0, r, true));
    const chartSim = simulateField(g, aoiUtmOrigin(userLike.aoi, epsg), { pattern: 'block', width: 2, spacing: 0, rotationDeg: 0, block: plan }, userLike.sensor);
    const chart = fitCover({ ...chartSim, pixelIds: Float64Array.from(g.cells, c => pixelId(c.col, c.row)) }, dup, 0.04, 'pca');
    const thumb = fitCover(rung.src, dup, 0.04, 'pca');
    const same = chart.pts.length === thumb.pts.length && chart.pts.every((p, i) => thumb.pts[i].id === p.id && p.s.every((v, j) => v === thumb.pts[i].s[j]));
    if (!same && oneFit) detail2 = `scores differ at ${r} m`;
    oneFit = oneFit && same;
    const a1 = axisSigns(chart, 0, 1, dup), a2 = axisSigns(thumb, 0, 1, dup);
    sameFace = sameFace && a1[0] === a2[0] && a1[1] === a2[1];
  }
  ok('a thumbnail is the big chart\'s own fit at that size: identical scores, pixel for pixel', oneFit, detail2);
  ok('and it faces the same way, so picking it changes nothing', sameFace);
}

console.log('\nH12. an imported trial');
{
  // A design uploaded as a file: real plot polygons, each variety its own
  // species, several plots of one variety its repetitions. Every fixture here is
  // SYNTHETIC. The trials are shaped like a real one (contiguous plots rotated
  // off grid north, more plots than varieties, closed shapefile rings) and carry
  // none of anyone's data.
  const epsg = 32631;
  const toUtm = proj4('EPSG:4326', '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs');
  let seed = 20260917;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const [E0, N0] = toUtm.forward([1.495, 43.532]);

  /** Plots given as rings in metres become a design in WGS84, as a reader hands it over. */
  const designOf = (plots, keys, varietyColumn = 'Variety') => ({
    fileName: 'synthetic.zip', columns: ['Name', 'Variety'], varietyColumn, nameColumn: 'Name', warnings: [],
    plots: plots.map((rings, i) => ({
      rings: rings.map(ring => ring.map(([x, y]) => toUtm.inverse([x, y]))),
      props: { Name: `SYN_${String(i + 1).padStart(3, '0')}`, Variety: keys[i] },
    })),
  });
  /** The varieties as the reader lists them: first appearance order, with their repetitions. */
  const varietiesOf = (design) => {
    const count = new Map();
    design.plots.forEach((_, i) => { const k = varietyKeyOf(design, i); count.set(k, (count.get(k) ?? 0) + 1); });
    return [...count].map(([key, plots]) => ({ key, label: key, plots, crop: 'wheat' }));
  };
  const resolve = (plots, keys) => { const d = designOf(plots, keys); return resolveImportedPlan(d, varietiesOf(d), epsg); };
  const rect = (cx, cy, w, h, deg) => {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
  };
  /**
   * A trial laid out like the kind of file this feature is for: nx x ny
   * contiguous w x h plots rotated `deg` off grid north, `nVar` varieties, the
   * plots beyond them repeating earlier varieties (never next to each other).
   */
  const gridTrial = ({ nx = 10, ny = 5, w = 15.0, h = 14.6, alley = 0, deg = 11, nVar = 40 } = {}) => {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const at = (u, v) => [E0 + u * c - v * s, N0 + u * s + v * c];
    const plots = [], keys = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const u0 = i * (w + alley), v0 = j * (h + alley), k = plots.length;
      plots.push([[at(u0, v0), at(u0 + w, v0), at(u0 + w, v0 + h), at(u0, v0 + h), at(u0, v0)]]);
      keys.push(`http://example.org/wheat/SYN${String(k < nVar ? k : ((k - nVar) * 7) % nVar).padStart(2, '0')}/`);
    }
    return { plots, keys };
  };
  /** Independent of the rasteriser: pointInPoly on one centre, later plots winning. */
  const expectedCover = (plan, E, N) => {
    let id = pointInPoly(E, N, plan.footprint) ? BARE.id : OFF_TRIAL.id;
    plan.plots.forEach((p, i) => {
      let inside = false;
      for (const ring of p.rings) if (pointInPoly(E, N, ring)) inside = !inside;
      if (inside) id = plan.plotIds ? i : p.species;
    });
    return id;
  };
  const layoutOf = (plan) => ({ pattern: 'imported', width: 2, spacing: 0, rotationDeg: 0, imported: plan });

  // ---- the cover map is pointInPoly, cell centre by cell centre ------------
  {
    const shapes = [], keys = [];
    for (let i = 0; i < 30; i++) {
      const cx = E0 + rnd() * 80, cy = N0 + rnd() * 60, deg = rnd() * 180;
      switch (i % 6) {
        case 0: shapes.push([rect(cx, cy, 2 + rnd() * 12, 1 + rnd() * 8, deg)]); break;
        case 1: {   // a concave star
          const n = 5 + Math.floor(rnd() * 8);
          shapes.push([Array.from({ length: 2 * n }, (_, k) => {
            const a = (k * Math.PI) / n + rnd() * 0.2, r = (k % 2 ? 1.5 : 5) * (0.6 + rnd() * 0.8);
            return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
          })]);
          break;
        }
        case 2: shapes.push([rect(cx, cy, 12, 9, deg), rect(cx + 1, cy - 0.5, 4, 3, deg + 20)]); break;        // a hole
        case 3: shapes.push([rect(cx, cy, 4, 3, deg), rect(cx + 7, cy + 2, 3, 5, deg + 45)]); break;           // two parts
        case 4: shapes.push([rect(cx, cy, 6, 4, deg), rect(cx + 2, cy + 1, 6, 4, deg + 10)]); break;           // overlapping parts
        default: shapes.push([[[cx - 4, cy - 3], [cx + 4, cy + 3], [cx + 4, cy - 3], [cx - 4, cy + 3]]]);      // a bow tie
      }
      keys.push(`V${i % 7}`);
    }
    const plan = resolve(shapes, keys);
    let cells = 0, wrong = 0, viaCultureAt = 0, overlaps = 0;
    for (const [fineRes, minE, minN] of [[0.25, E0 - 10.3, N0 - 7.7], [10 / 24, E0 - 12.1, N0 - 9.05]]) {
      const rows = Math.ceil(80 / fineRes), cols = Math.ceil(100 / fineRes);
      const map = buildCropMap(minE, minN, rows, cols, fineRes, 0, 0, layoutOf(plan));
      for (let r = 0; r < rows; r++) {
        const N = minN + (r + 0.5) * fineRes;
        for (let c = 0; c < cols; c++) {
          const E = minE + (c + 0.5) * fineRes;
          const want = expectedCover(plan, E, N), got = map[r * cols + c];
          cells++;
          if (got !== want) wrong++;
          if (cultureAt(E, N, layoutOf(plan), 0, 0) !== got) viaCultureAt++;
          if (got < plan.plots.length) {
            let hits = 0;
            for (const p of plan.plots) { let inside = false; for (const ring of p.rings) if (pointInPoly(E, N, ring)) inside = !inside; if (inside) hits++; }
            if (hits > 1) overlaps++;
          }
        }
      }
    }
    ok('every fine cell of rotated, concave, holed, multipart and overlapping plots is exactly pointInPoly at its centre',
      wrong === 0, `${wrong} of ${cells} cells differ`);
    ok('cultureAt answers the same cover as the map on every one of those centres', viaCultureAt === 0, `${viaCultureAt} differ`);
    ok('where plots overlap the later plot wins, and the fixture really has overlaps', overlaps > 100, `${overlaps} overlapped cells`);

    // Centres lying exactly ON an edge: the one case a "sample the centre"
    // raster is usually excused from. This one computes pointInPoly's own
    // crossings, so it agrees there too.
    const fineRes = 0.125, minE = E0 + 0.37, minN = N0 - 0.19, rows = 160, cols = 200;
    const cx = c => minE + (c + 0.5) * fineRes, cy = r => minN + (r + 0.5) * fineRes;
    const onLattice = [
      { rings: [[[cx(10), cy(10)], [cx(60), cy(10)], [cx(60), cy(50)], [cx(10), cy(50)]]], species: 0 },
      { rings: [[[cx(60), cy(20)], [cx(110), cy(20)], [cx(110), cy(70)]]], species: 1 },
      { rings: [[[cx(120), cy(5)], [cx(190), cy(5)], [cx(190), cy(150)], [cx(120), cy(150)]], [[cx(140), cy(40)], [cx(170), cy(40)], [cx(170), cy(100)], [cx(140), cy(100)]]], species: 0 },
    ];
    const all = onLattice.flatMap(p => p.rings.flat());
    const hand = { epsg, plots: onLattice, coverSpecies: Uint8Array.from([0, 1, 0]), plotIds: true, nSpecies: 2, footprint: convexHull(all),
      bbox: [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))],
      minFeature: 1, sig: 'hand' };
    const map = buildCropMap(minE, minN, rows, cols, fineRes, 0, 0, layoutOf(hand));
    let edgeWrong = 0, onEdge = 0;
    const xsEdge = new Set(all.map(p => p[0])), ysEdge = new Set(all.map(p => p[1]));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (xsEdge.has(cx(c)) || ysEdge.has(cy(r))) onEdge++;
      if (map[r * cols + c] !== expectedCover(hand, cx(c), cy(r))) edgeWrong++;
    }
    ok('and it agrees on centres lying exactly on plot edges and vertices too', edgeWrong === 0 && onEdge > 1000,
      `${edgeWrong} differ, ${onEdge} centres on an edge line`);
  }

  // ---- bare alley inside the footprint, off-trial outside it ----------------
  const alleyTrial = gridTrial({ nx: 3, ny: 2, w: 8, h: 6, alley: 0.5, deg: 11, nVar: 6 });
  const alleyPlan = resolve(alleyTrial.plots, alleyTrial.keys);
  {
    const t = (11 * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const at = (u, v) => [E0 + u * c - v * s, N0 + u * s + v * c];
    const L = layoutOf(alleyPlan);
    ok('the middle of an alley between two plots is bare soil', cultureAt(...at(8.25, 3), L, 0, 0) === BARE.id);
    ok('the middle of a plot is that plot', cultureAt(...at(4, 3), L, 0, 0) === 0 && cultureAt(...at(12.5, 9.5), L, 0, 0) === 4);
    ok('ground beyond the trial\'s footprint is off-trial, not alley',
      cultureAt(...at(-3, 3), L, 0, 0) === OFF_TRIAL.id && cultureAt(...at(12, 20), L, 0, 0) === OFF_TRIAL.id);
    ok('an imported trial ignores rotation, strip width and the pattern origin',
      [[4, 3], [8.25, 3], [-3, 3]].every(([u, v]) => cultureAt(...at(u, v), { ...L, rotationDeg: 37, width: 9, spacing: 3 }, 123, 456) === cultureAt(...at(u, v), L, 0, 0)));
    const fineRes = 0.125, [bx0, by0, bx1, by1] = alleyPlan.bbox;
    const minE = bx0 - 5, minN = by0 - 5, rows = Math.ceil((by1 - by0 + 10) / fineRes), cols = Math.ceil((bx1 - bx0 + 10) / fineRes);
    const map = buildCropMap(minE, minN, rows, cols, fineRes, 0, 0, L);
    const n = { bare: 0, off: 0, plot: 0, bareOutside: 0 };
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const id = map[r * cols + q];
      if (id === BARE.id) { n.bare++; if (!pointInPoly(minE + (q + 0.5) * fineRes, minN + (r + 0.5) * fineRes, alleyPlan.footprint)) n.bareOutside++; }
      else if (id === OFF_TRIAL.id) n.off++;
      else n.plot++;
    }
    // Two 0.5 m alleys across 8 x 6 m plots: about (2 * 12.5 + 16.5) * 0.5 m2 of alley.
    const bareM2 = n.bare * fineRes * fineRes;
    ok('the alleys are bare, about as much as the design leaves, and all of it inside the footprint',
      Math.abs(bareM2 - (2 * 12.5 + 25) * 0.5) < 2 && n.bareOutside === 0 && n.off > 0,
      `${bareM2.toFixed(2)} m2 bare, ${n.bareOutside} outside`);
    const contiguous = gridTrial({ nx: 4, ny: 3, w: 15, h: 14.6, deg: 11, nVar: 12 });
    const cPlan = resolve(contiguous.plots, contiguous.keys);
    const cMap = buildCropMap(cPlan.bbox[0] - 2, cPlan.bbox[1] - 2, 520, 520, fineRes, 0, 0, layoutOf(cPlan));
    ok('a trial of contiguous plots has no bare ground inside it at all', !cMap.includes(BARE.id));
  }

  // ---- the resolver: species, cover ids, minFeature, signature --------------
  const trial50 = gridTrial();
  const trialDesign = designOf(trial50.plots, trial50.keys);
  const trialVarieties = varietiesOf(trialDesign);
  const plan = resolveImportedPlan(trialDesign, trialVarieties, epsg);
  {
    ok('a plot\'s species is the index of its variety, and repetitions share it',
      plan.nSpecies === 40 && trialVarieties.filter(v => v.plots === 2).length === 10 &&
      plan.plots.every((p, i) => trialVarieties[p.species].key === trial50.keys[i]) &&
      plan.plots[40].species === plan.plots[0].species && plan.plots[41].species === plan.plots[7].species);
    ok('up to 253 plots the cover ids are plot ids, folded to species by coverSpecies',
      plan.plotIds && plan.coverSpecies.length === 50 && plan.plots.every((p, i) => plan.coverSpecies[i] === p.species));
    // A convex hull holds every vertex it is built from; the one of a rectangular
    // block of plots is that rectangle, 150 x 73 m.
    const hullArea = plan.footprint.reduce((a, [x, y], i) => { const [x2, y2] = plan.footprint[(i + 1) % plan.footprint.length]; return a + (x * y2 - x2 * y) / 2; }, 0);
    const holds = plan.plots.every(p => p.rings.every(ring => ring.every(([x, y]) => plan.footprint.every(([ax, ay], i) => {
      const [bx, by] = plan.footprint[(i + 1) % plan.footprint.length];
      return (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= -1e-6;
    }))));
    const all = plan.plots.flatMap(p => p.rings.flat());
    ok('the footprint is the convex hull of every plot and its bbox the trial\'s',
      holds && Math.abs(hullArea - 150 * 73) < 1e-3 &&
      plan.bbox.join() === [Math.min(...all.map(q => q[0])), Math.min(...all.map(q => q[1])), Math.max(...all.map(q => q[0])), Math.max(...all.map(q => q[1]))].join() &&
      Math.abs((plan.bbox[2] - plan.bbox[0]) - (150 * Math.cos(11 * Math.PI / 180) + 73 * Math.sin(11 * Math.PI / 180))) < 1e-3,
      `hull ${hullArea.toFixed(3)} m2, bbox ${(plan.bbox[2] - plan.bbox[0]).toFixed(2)} x ${(plan.bbox[3] - plan.bbox[1]).toFixed(2)} m`);
    ok('the narrowest feature of contiguous plots is the plot width', Math.abs(plan.minFeature - 14.6) < 1e-6, `${plan.minFeature}`);
    ok('with 0.5 m alleys between plots it is the alley', Math.abs(alleyPlan.minFeature - 0.5) < 1e-6, `${alleyPlan.minFeature}`);
    ok('minFeatureM hands the engine that measurement',
      minFeatureM(layoutOf(plan)) === plan.minFeature && minFeatureM(layoutOf(alleyPlan)) === alleyPlan.minFeature);
    // Rows of 6 m plots overlapping by 2 cm: the corners of one row sit 2 cm
    // inside the next. What is left visible of a plot, 5.98 m, is a real feature;
    // those 2 cm are not, and taking them for a gap would pin the stride at its cap.
    const overlapping = gridTrial({ nx: 3, ny: 2, w: 8, h: 6, alley: -0.02, deg: 11, nVar: 6 });
    const overlapFeature = resolve(overlapping.plots, overlapping.keys).minFeature;
    ok('a 2 cm overlap between hand-drawn plots is not a gap the grid must resolve',
      Math.abs(overlapFeature - 5.98) < 1e-6, `${overlapFeature}`);
    const ell = [[[E0, N0], [E0 + 20, N0], [E0 + 20, N0 + 3], [E0 + 3, N0 + 3], [E0 + 3, N0 + 20], [E0, N0 + 20]]];
    // A 20 m L with 3 m arms. Its hull is narrowest across the diagonal cut,
    // 23 / sqrt 2 = 16.3 m, which is what this measured before: the grid then
    // sampled 3 m arms as if they were 16 m wide.
    ok('a concave plot is measured by its narrowest arm, not by its hull',
      Math.abs(resolve([ell], ['L']).minFeature - 3) < 1e-6, `${resolve([ell], ['L']).minFeature.toFixed(3)} m`);
    ok('rotating calipers find the brute-force minimum width of random hulls',
      (() => {
        for (let t = 0; t < 400; t++) {
          const h = convexHull(Array.from({ length: 3 + Math.floor(rnd() * 30) }, () => [rnd() * 60, rnd() * 25]));
          if (h.length < 3) continue;
          let brute = Infinity;
          for (let i = 0; i < h.length; i++) {
            const a = h[i], b = h[(i + 1) % h.length], ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
            brute = Math.min(brute, Math.max(...h.map(p => Math.abs(ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / len)));
          }
          if (Math.abs(brute - hullWidth(h)) > 1e-9) return false;
        }
        return true;
      })());

    const key = layoutKey(layoutOf(plan));
    const again = layoutKey(layoutOf(resolveImportedPlan(designOf(trial50.plots, trial50.keys), trialVarieties, epsg)));
    const moved = trial50.plots.map((rings, i) => (i === 17 ? [rings[0].map(([x, y], k) => (k === 2 ? [x + 0.004, y] : [x, y]))] : rings));
    // Plots 40 and 41 repeat varieties first seen earlier, so swapping them moves
    // species indices; renaming a variety moves no index at all.
    const swapped = trial50.keys.slice(); [swapped[40], swapped[41]] = [swapped[41], swapped[40]];
    const renamed = trial50.keys.map(k => (k === trial50.keys[5] ? k + 'bis' : k));
    const keys = [key, layoutKey(layoutOf(resolve(moved, trial50.keys))), layoutKey(layoutOf(resolve(trial50.plots, swapped))),
      layoutKey(layoutOf(resolve(trial50.plots, renamed))), layoutKey(layoutOf(resolve(trial50.plots.slice(0, 49), trial50.keys.slice(0, 49)))),
      layoutKey(layoutOf(resolveImportedPlan(trialDesign, trialVarieties, 32630)))];
    ok('layoutKey is stable for the same file and moves when geometry or the assignment moves',
      key === again && new Set(keys).size === keys.length, keys.map(k => k.slice(-8)).join(' '));
    // The cover map reads coordinates exactly, so the key must too: a signature
    // rounded to the millimetre kept serving a map this 0.3 mm move changes.
    const edgeAt = (x) => [[[x, N0 + 0.5], [E0 + 10.3, N0 + 0.5], [E0 + 10.3, N0 + 10.5], [x, N0 + 10.5]]];
    const nearA = resolve([edgeAt(E0 + 0.2001)], ['A']), nearB = resolve([edgeAt(E0 + 0.2004)], ['A']);
    const fineA = buildCropMap(E0 + 0.2, N0 + 1, 4, 8, 0.0001, 0, 0, layoutOf(nearA)), fineB = buildCropMap(E0 + 0.2, N0 + 1, 4, 8, 0.0001, 0, 0, layoutOf(nearB));
    ok('a sub-millimetre move of a plot edge moves the key, as it moves the cover map',
      layoutKey(layoutOf(nearA)) !== layoutKey(layoutOf(nearB)) && fineA.some((v, k) => v !== fineB[k]));
    ok('and it ignores the sliders an imported trial does not read',
      layoutKey({ ...layoutOf(plan), rotationDeg: 30, width: 7, spacing: 2 }) === key);
    ok('a plan left on a strip layout is ignored by every reader of the cover map',
      speciesChannel({ ...layoutOf(plan), pattern: 'row' }).nSpecies === 2 && minFeatureM({ ...layoutOf(plan), pattern: 'row' }) === 2 &&
      !layoutKey({ ...layoutOf(plan), pattern: 'row' }).includes(plan.sig));

    // Through the READER's own variety list, whatever it spells the keys: the
    // two once spelled them differently ("plot N" and "#N"), and every plot of
    // a design without a variety column was then unlisted.
    // One function, not two that agree today: the resolver re-exports the
    // reader's, so there is no second spelling left to drift.
    ok('the resolver\'s varietyKeyOf IS the reader\'s, the same function object',
      varietyKeyOf === readerVarietyKeyOf);
    const perPlot = designOf(trial50.plots.slice(0, 6), trial50.keys.slice(0, 6), '');
    const perPlotVarieties = readerVarietiesOf(perPlot);
    const perPlotPlan = resolveImportedPlan(perPlot, perPlotVarieties, epsg);
    ok('with no variety column every plot is its own variety, keyed as the reader keys it',
      perPlotVarieties.length === 6 && new Set(perPlotVarieties.map(v => v.key)).size === 6 &&
      perPlotVarieties.every((v, i) => v.key === varietyKeyOf(perPlot, i)) &&
      perPlotPlan.nSpecies === 6 && perPlotPlan.plots.every((p, i) => p.species === i),
      perPlotVarieties.map(v => v.key).join());
    const readerPlan = resolveImportedPlan(trialDesign, readerVarietiesOf(trialDesign), epsg);
    ok('and the reader\'s variety list resolves a design with a variety column the same way',
      readerPlan.nSpecies === 40 && readerPlan.plots.every((p, i) => p.species === plan.plots[i].species));
    const throws = (f) => { try { f(); return false; } catch { return true; } };
    ok('the resolver refuses a plot whose variety is not listed, and more varieties than it can number',
      throws(() => resolveImportedPlan(trialDesign, trialVarieties.slice(1), epsg)) &&
      throws(() => resolveImportedPlan(trialDesign, [...trialVarieties, ...Array.from({ length: 214 }, (_, i) => ({ key: `x${i}`, label: '', plots: 0, crop: 'wheat' }))], epsg)) &&
      !throws(() => resolveImportedPlan(trialDesign, [...trialVarieties, ...Array.from({ length: 213 }, (_, i) => ({ key: `x${i}`, label: '', plots: 0, crop: 'wheat' }))], epsg)));
  }

  // ---- what the fine grid must resolve: seams, wedges, and ground inside a plot --
  {
    const strideAt = (p, gsd) => strideFor(gsd, minFeatureM(layoutOf(p)));
    // Two contiguous 10 x 10 m plots covering exactly the same ground, their
    // straight edges cut into more pieces. Measuring from each vertex to the
    // neighbour's nearest corner read 5 m, then 0.1 m, and pinned the stride.
    const square = (u0, cuts) => [[[u0, 0], ...cuts.map(f => [u0 + 10 * f, 0]), [u0 + 10, 0], [u0 + 10, 10],
      ...cuts.map(f => [u0 + 10 * (1 - f), 10]), [u0, 10], [u0, 0]].map(([u, v]) => [E0 + u, N0 + v])];
    const cutPairs = [[], [0.5], [0.99], [0.25, 0.5, 0.75]].map(cuts => resolve([square(0, cuts), square(10, cuts)], ['A', 'B']).minFeature);
    ok('extra vertices along a straight edge are not gaps: contiguous 10 m plots measure 10 m however their edges are cut',
      cutPairs.every(m => Math.abs(m - 10) < 1e-6), cutPairs.map(m => m.toFixed(3)).join(' '));

    // The same trial with every vertex nudged, as a survey or a hand digitises it.
    const jittered = (t, amount) => t.plots.map(rings => {
      const ring = rings[0].slice(0, -1).map(([x, y]) => [x + (rnd() * 2 - 1) * amount, y + (rnd() * 2 - 1) * amount]);
      return [[...ring, ring[0]]];
    });
    const noisy = [0.01, 0.03].map(j => resolve(jittered(trial50, j), trial50.keys));
    ok('centimetre seams between plots meant to touch are not alleys: the stride stays the plot width\'s',
      noisy.every(p => p.minFeature > 14.4 && p.minFeature <= 14.6 + 1e-9 && strideAt(p, 10) === strideAt(plan, 10) && strideAt(p, 3) === strideAt(plan, 3)),
      noisy.map(p => p.minFeature.toFixed(3)).join(' '));
    const noisyAlley = resolve(jittered(alleyTrial, 0.01), alleyTrial.keys);
    ok('while a real 0.5 m alley between jittered plots is still the alley', Math.abs(noisyAlley.minFeature - 0.5) < 0.03, noisyAlley.minFeature.toFixed(3));

    // Ground a plot leaves bare INSIDE itself: its width used to be its hull's.
    const box = (u0, v0, w, h) => [[E0 + u0, N0 + v0], [E0 + u0 + w, N0 + v0], [E0 + u0 + w, N0 + v0 + h], [E0 + u0, N0 + v0 + h], [E0 + u0, N0 + v0]];
    const multi = [], split = [], kM = [], kS = [];
    for (let i = 0; i < 8; i++) {
      multi.push([box(6.5 * i, 0, 3, 20), box(6.5 * i + 3.5, 0, 3, 20)]); kM.push(`SYN_${i % 3}`);
      split.push([box(6.5 * i, 0, 3, 20)], [box(6.5 * i + 3.5, 0, 3, 20)]); kS.push(`SYN_${i % 3}`, `SYN_${i % 3}`);
    }
    const multiPlan = resolve(multi, kM), splitPlan = resolve(split, kS);
    const inside = {
      'two parts 0.5 m apart': multiPlan.minFeature,
      'a 0.3 m hole': resolve([[box(0, 0, 12, 12), box(3, 5.85, 6, 0.3)]], ['A']).minFeature,
      'a 0.5 m rim': resolve([[box(0, 0, 12, 12), box(0.5, 0.5, 11, 11)]], ['A']).minFeature,
      'a 0.4 m slit': resolve([[[[0, 0], [12, 0], [12, 12], [6.2, 12], [6.2, 2], [5.8, 2], [5.8, 12], [0, 12]].map(([u, v]) => [E0 + u, N0 + v])]], ['A']).minFeature,
      'an L with 1 m arms': resolve([[[[0, 0], [20, 0], [20, 1], [1, 1], [1, 20], [0, 20]].map(([u, v]) => [E0 + u, N0 + v])]], ['A']).minFeature,
    };
    const wantInside = [0.5, 0.3, 0.5, 0.4, 1];
    ok('a gap between the parts of a plot, a hole, a rim, a notch and an arm are each measured',
      Object.values(inside).every((m, i) => Math.abs(m - wantInside[i]) < 1e-6), Object.entries(inside).map(([k, m]) => `${k}: ${m.toFixed(3)}`).join(', '));
    const bareOf = (p) => simulateField(boxAt5(p), [0, 0], layoutOf(p), { sigmaX: 0, sigmaY: 0, mixThreshold: 0.8 }).proportionBare;
    const boxAt5 = (p) => ({ res: 5, utmBounds: [Math.floor((p.bbox[0] - 10) / 5) * 5, Math.floor((p.bbox[1] - 10) / 5) * 5, Math.ceil((p.bbox[2] + 10) / 5) * 5, Math.ceil((p.bbox[3] + 10) / 5) * 5] });
    const bM = bareOf(multiPlan), bS = bareOf(splitPlan);
    ok('so the same ground as one multipart plot or as two plots is sampled alike: same stride, same bare share per pixel',
      strideAt(multiPlan, 5) === strideAt(splitPlan, 5) && bM.every((v, k) => Math.abs(v - bS[k]) < 1e-6),
      `stride ${strideAt(multiPlan, 5)} vs ${strideAt(splitPlan, 5)}`);

    // Slivers that are not strips: every width down to 0 occurs in them, over hardly any ground.
    const circle = (cx, cy, r, n) => [Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)])];
    const apart = resolve([circle(E0, N0, 5, 64), circle(E0 + 11, N0, 5, 64)], ['A', 'B']).minFeature;
    const tangent = resolve([circle(E0, N0, 5, 1000), circle(E0 + 10, N0, 5, 1000)], ['A', 'B']).minFeature;
    // A plot's corner on its neighbour's side, turned 10 degrees away from it:
    // the bare wedge between them is 0.7 m wide half way up, and 0 at the corner.
    const turned = (() => {
      const t = (-10 * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      return [[[0, 0], [10, 0], [10, 10], [0, 10]].map(([u, v]) => [E0 + 10 + u * c - v * s, N0 + 2 + u * s + v * c])];
    })();
    const corner = resolve([[box(0, 0, 10, 10)], turned], ['A', 'B']).minFeature;
    ok('round plots 1 m apart measure the 1 m between them, and cusps and wedges are not features',
      apart > 1 && apart < 1.05 && tangent > 9 && Math.abs(corner - 10) < 1e-6,
      `apart ${apart.toFixed(3)}, tangent ${tangent.toFixed(2)}, corner on a side ${corner.toFixed(3)}`);

    // Folding: what the strip search sees of a ring. Kept vertices are the
    // ring's own, in order; everything dropped stays within sqrt 2 times the
    // fold of the chord that replaced it; clean corners survive.
    const FOLD = 0.025;
    const foldHolds = (ring) => {
      const f = foldRing(ring, FOLD), open = ring.slice(0, ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? -1 : undefined);
      let at = 0, worst = 0;
      for (let k = 0; k < f.length; k++) {
        const a = f[k], b = f[(k + 1) % f.length], from = open.indexOf(a, at);
        if (from < 0) return Infinity;
        const to = k + 1 < f.length ? open.indexOf(b, from + 1) : open.length;
        for (let i = from + 1; i < to; i++) worst = Math.max(worst, pointSegDist(open[i][0], open[i][1], a[0], a[1], b[0], b[1]));
        at = from + 1;
      }
      return worst;
    };
    const pointSegDist = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0));
      return Math.hypot(px - ax - t * dx, py - ay - t * dy);
    };
    const saw = (cx, cy, n, depth) => [Array.from({ length: n }, (_, k) => {
      const a = (2 * Math.PI * k) / n, r = k % 2 ? 5 - depth : 5;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    })];
    let foldWorst = 0, foldKept = true;
    for (let it = 0; it < 300; it++) {
      const n = 3 + Math.floor(rnd() * 400), ring = [];
      let x = E0, y = N0, heading = rnd() * 6.3;
      for (let k = 0; k < n; k++) { ring.push([x, y]); heading += (rnd() - 0.5) * (rnd() < 0.2 ? 3 : 0.2); const step = rnd() < 0.5 ? rnd() * 0.05 : rnd() * 3; x += step * Math.cos(heading); y += step * Math.sin(heading); }
      const w = foldHolds(rnd() < 0.5 ? ring : [...ring, ring[0]]);
      if (!Number.isFinite(w)) foldKept = false; else foldWorst = Math.max(foldWorst, w);
    }
    const denseEdge = square(0, Array.from({ length: 99 }, (_, k) => (k + 1) / 100))[0];
    ok('folding keeps a ring\'s own vertices in order, and everything it drops within sqrt 2 folds of its chord',
      foldKept && foldWorst <= Math.SQRT2 * FOLD + 1e-9 && foldRing(denseEdge, FOLD).length === 4 && foldRing(box(0, 0, 0.3, 0.2), FOLD).length === 4 &&
      foldHolds(saw(E0, N0, 2000, 0.02)[0]) <= Math.SQRT2 * FOLD + 1e-9, `worst ${foldWorst.toFixed(4)} m over 300 random walks`);

    // A ring whose edge is 20,000 teeth 2 cm deep: each tooth faces the others
    // across every width, and their pieces were compared with each other one by
    // one (six minutes for one design, and a 17 cm "strip" found by chance).
    let tMark = performance.now();
    const jagged = resolve([saw(E0, N0, 20000, 0.02)], ['A']).minFeature;
    const tJagged = performance.now() - tMark;
    ok('a jagged edge is not a comb of strips, and resolves at once',
      Math.abs(jagged - 10) < 0.05 && tJagged < 1000, `${jagged.toFixed(3)} m in ${tJagged.toFixed(0)} ms`);

    // A plot narrower than the fold is still the narrowest thing in the design.
    const sliver = resolve([[box(0, 0, 10, 10)], [box(10, 0, 0.02, 10)], [box(10.02, 0, 10, 10)]], ['A', 'B', 'C']).minFeature;
    ok('a 2 cm plot among 10 m plots is measured by its own width, floored', sliver === 0.05, `${sliver}`);

    // The bucketed search against every pair of folded boundaries, on random designs.
    const SEAM = 0.1, SIN15 = Math.sin(Math.PI / 12), COS15 = Math.cos(Math.PI / 12);
    const segGap = (a, b) => {
      const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const A = [a[0], a[1]], B = [a[2], a[3]], Cq = [b[0], b[1]], D = [b[2], b[3]];
      if (o(A, B, Cq) * o(A, B, D) < 0 && o(Cq, D, A) * o(Cq, D, B) < 0) return 0;
      return Math.min(pointSegDist(...A, ...b), pointSegDist(...B, ...b), pointSegDist(...Cq, ...a), pointSegDist(...D, ...a));
    };
    const allPairs = (p) => {
      let best = Infinity;
      for (const q of p.plots) for (const ring of q.rings) { const w = hullWidth(convexHull(ring)); if (w > 0) best = Math.min(best, w); }
      const segs = [];
      [...p.plots.flatMap(q => q.rings), p.footprint].map(ring => foldRing(ring, FOLD)).forEach((ring, ri) => {
        if (ring.length < 2) return;
        ring.forEach((a, k) => {
          const b = ring[(k + 1) % ring.length];
          segs.push({ s: [a[0], a[1], b[0], b[1]], ri, k, n: ring.length, len: Math.hypot(b[0] - a[0], b[1] - a[1]) });
        });
      });
      const stretch = (g) => {
        const u = [(g.s[2] - g.s[0]) / g.len, (g.s[3] - g.s[1]) / g.len], mine = segs.filter(h => h.ri === g.ri), out = [g];
        const along = h => h.len > 0 && (h.s[2] - h.s[0]) * u[0] + (h.s[3] - h.s[1]) * u[1] >= COS15 * h.len;
        let f = 1;
        for (; f < g.n && along(mine[(g.k + f) % g.n]); f++) out.push(mine[(g.k + f) % g.n]);
        for (let b = 1; b < g.n - f + 1 && along(mine[(g.k - b + g.n) % g.n]); b++) out.push(mine[(g.k - b + g.n) % g.n]);
        return out;
      };
      const found = [];
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const S = segs[i], T = segs[j];
        if (!S.len || !T.len) continue;
        const [ax, ay, bx, by] = S.s, [px, py, qx, qy] = T.s, ux = (bx - ax) / S.len, uy = (by - ay) / S.len;
        if (Math.abs(ux * (qy - py) - uy * (qx - px)) > SIN15 * T.len) continue;
        const tp = (px - ax) * ux + (py - ay) * uy, tq = (qx - ax) * ux + (qy - ay) * uy;
        const lo = Math.max(0, Math.min(tp, tq)), hi = Math.min(S.len, Math.max(tp, tq));
        if (!(hi > lo)) continue;
        const np = (px - ax) * -uy + (py - ay) * ux, nq = (qx - ax) * -uy + (qy - ay) * ux;
        const across = m => np + ((m - tp) / (tq - tp)) * (nq - np);
        if ((across(lo) > 0) !== (across(hi) > 0)) continue;
        const w = Math.min(Math.abs(across(lo)), Math.abs(across(hi)));
        if (w >= SEAM) found.push({ w, S, T, ax, ay, ux, uy, tm: (lo + hi) / 2, across: across((lo + hi) / 2) });
      }
      found.sort((a, b) => a.w - b.w);
      for (const { w, S, T, ax, ay, ux, uy, tm, across } of found) {
        if (w >= best) break;
        const tS = stretch(S), tT = stretch(T);
        const span = (tr) => { const ps = tr.flatMap(g => [(g.s[0] - ax) * ux + (g.s[1] - ay) * uy, (g.s[2] - ax) * ux + (g.s[3] - ay) * uy]); return [Math.min(...ps), Math.max(...ps)]; };
        const [s0, s1] = span(tS), [t0s, t1s] = span(tT);
        if (!(Math.min(s1, t1s) - Math.max(s0, t0s) >= w / 2)) continue;
        if (tS.some(a => tT.some(b => segGap(a.s, b.s) < SEAM))) continue;
        const ox = ax + tm * ux, oy = ay + tm * uy, sg = Math.sign(across), d = Math.min(0.05, w / 4);
        const at = k => importedCoverAt(ox - k * uy, oy + k * ux, p);
        const mid = at(across / 2);
        if (mid !== at(sg * d) || mid !== at(across - sg * d) || mid === at(-sg * d) || mid === at(across + sg * d)) continue;
        return w;
      }
      return best;
    };
    const handPlan = (plots) => {
      const all = plots.flatMap(q => q.rings.flat());
      return { epsg, plots, plotIds: plots.length <= MAX_PLOTS, nSpecies: 4,
        coverSpecies: plots.length <= MAX_PLOTS ? Uint8Array.from(plots, q => q.species) : Uint8Array.from([0, 1, 2, 3]), footprint: convexHull(all),
        bbox: all.reduce((b, q) => [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])], [Infinity, Infinity, -Infinity, -Infinity]),
        minFeature: 1, sig: 'hand' };
    };
    const turn = (cx, cy, deg) => { const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return ([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]; };
    let designs = 0, differ = 0, detail = '';
    for (let it = 0; it < 150; it++) {
      const plots = [], base = rnd() * 90, aligned = rnd() < 0.5;
      for (let k = 2 + Math.floor(rnd() * 10); k > 0; k--) {
        const cx = E0 + rnd() * 40, cy = N0 + rnd() * 30, deg = aligned ? base + (rnd() * 6 - 3) : rnd() * 180, at = turn(cx, cy, deg), sp = Math.floor(rnd() * 4);
        const rectAt = (u0, v0, w, h) => [[u0, v0], [u0 + w, v0], [u0 + w, v0 + h], [u0, v0 + h]].map(at);
        switch (Math.floor(rnd() * 6)) {
          case 0: plots.push({ rings: [rectAt(0, 0, 0.3 + rnd() * 9, 0.3 + rnd() * 9)], species: sp }); break;
          case 1: plots.push({ rings: [rectAt(0, 0, 4 + rnd() * 8, 4 + rnd() * 8), rectAt(1 + rnd(), 1 + rnd(), 0.2 + rnd() * 2, 0.2 + rnd() * 2)], species: sp }); break;
          case 2: plots.push({ rings: [circle(cx, cy, 1 + rnd() * 5, 12 + Math.floor(rnd() * 60))[0]], species: sp }); break;
          case 3: { const a = 0.3 + rnd() * 2.7, L = 5 + rnd() * 10; plots.push({ rings: [[[0, 0], [L, 0], [L, a], [a, a], [a, L], [0, L]].map(at)], species: sp }); break; }
          case 4: {   // a jittered, densified plot: pieces that fold, and some that do not
            const w = 2 + rnd() * 8, h = 2 + rnd() * 8, jit = rnd() * 0.06, ring = [];
            for (let q = 0; q < 4; q++) for (let m = 0; m < 12; m++) {
              const [u0, v0] = [[0, 0], [w, 0], [w, h], [0, h]][q], [u1, v1] = [[w, 0], [w, h], [0, h], [0, 0]][q];
              ring.push(at([u0 + ((u1 - u0) * m) / 12 + (rnd() * 2 - 1) * jit, v0 + ((v1 - v0) * m) / 12 + (rnd() * 2 - 1) * jit]));
            }
            plots.push({ rings: [ring], species: sp });
            break;
          }
          default: {   // a row of three, with an alley or a seam between them
            const w = 1 + rnd() * 5, h = 3 + rnd() * 9, gap = rnd() < 0.5 ? rnd() * 0.4 : rnd() * 0.1 - 0.05;
            for (let q = 0; q < 3; q++) plots.push({ rings: [rectAt(q * (w + gap), 0, w, h)], species: sp });
          }
        }
      }
      const p = handPlan(plots);
      designs++;
      const got = narrowestFeature(p), want = allPairs(p);
      if (!(got === want || Math.abs(got - want) < 1e-9)) { differ++; detail ||= `design ${it}: ${got} vs ${want}`; }
    }
    ok('the bucketed strip search finds exactly what comparing every pair of folded boundaries finds',
      differ === 0 && designs === 150, detail || `${designs} random designs`);

    // Buckets far smaller than the strip being looked for: 300 round plots (20
    // unfoldable sides each) below two long strips 1 m apart. The band read
    // beside a segment must still reach across the whole alley. The outer
    // plots touch the footprint's sides, so no sliver of bare ground runs
    // between a plot and a hull edge passing just beside it.
    const dots = [];
    for (let j = 0; j < 12; j++) for (let i = 0; i < 25; i++) dots.push({ rings: circle(E0 + 0.6 + 2.4 * i, N0 - 2 - 2.4 * j, 0.6, 20), species: 2 });
    const reachPlan = handPlan([{ rings: [box(0, 0, 58.8, 2).slice(0, -1)], species: 0 }, { rings: [box(0, 3, 58.8, 2).slice(0, -1)], species: 1 }, ...dots]);
    const reach = narrowestFeature(reachPlan);
    ok('however small the buckets, the search reaches across the alley it is looking for', Math.abs(reach - 1) < 1e-9, `${reach}`);

    // Built to defeat the search: 1200 square frames 1 m wide, nested, so a
    // probe near the middle tests every frame around it. Finished, the search
    // answers 1 m; it gives up instead and samples as finely as a seam, never
    // coarser, where piles like it once froze the page for minutes.
    const nested = [];
    for (let i = 0; i < 1200; i++) nested.push({ rings: [box(-7 - i, -7 - i, 14 + 2 * i, 14 + 2 * i).slice(0, -1), box(-6 - i, -6 - i, 12 + 2 * i, 12 + 2 * i).slice(0, -1)], species: i % 4 });
    tMark = performance.now();
    const piled = narrowestFeature(handPlan(nested));
    const tPiled = performance.now() - tMark;
    ok('a design built to exhaust the strip search stops within its budget and answers a seam, never coarser',
      piled === 0.1 && tPiled < 3000, `${piled} in ${tPiled.toFixed(0)} ms`);

    // The budget charges a probe for the plots it really tests. The same 80
    // plots hidden under one drawn over them, and 80 frames around it, in two
    // file orders: with the frames drawn last every probe tests them all before
    // reaching the plot on top (about 9.7 million units), drawn before it the
    // plot on top answers at once (about 4.5 million). A budget between the two
    // must stop the first and not the second.
    const pileOf = (framesLast) => {
      const hidden = [], frames = [];
      for (let i = 0; i < 80; i++) { const w = 5 + rnd(); hidden.push({ rings: [box(rnd() * 30, rnd() * 30, w, w).slice(0, -1)], species: 1 }); }
      const cover = { rings: [box(-5, -5, 50, 50).slice(0, -1)], species: 0 };
      for (let i = 0; i < 80; i++) {
        const h = 28 + 6 * i;
        frames.push({ rings: [box(17 - h, 17 - h, 2 * h + 6, 2 * h + 6).slice(0, -1), box(20 - h, 20 - h, 2 * h, 2 * h).slice(0, -1)], species: 2 + (i % 2) });
      }
      return handPlan(framesLast ? [...hidden, cover, ...frames] : [...hidden, ...frames, cover]);
    };
    const seedBefore = seed;
    const probedLast = narrowestFeature(pileOf(true), 7e6);
    seed = seedBefore;
    const probedFirst = narrowestFeature(pileOf(false), 7e6);
    ok('and it charges each probe for every plot the probe tests, so piling plots over a probe exhausts it',
      probedLast === 0.1 && probedFirst === 3, `frames drawn last ${probedLast}, drawn before the plot on top ${probedFirst}`);

    // Densified plots: 200 contiguous squares of 1000 vertices each took 4.7 s
    // to resolve, on the page's main thread, whenever a variety was reassigned.
    const dense = [], denseKeys = [];
    for (let j = 0; j < 10; j++) for (let i = 0; i < 20; i++) {
      const ring = [];
      for (let side = 0; side < 4; side++) for (let k = 0; k < 250; k++) {
        const [x0, y0] = [[0, 0], [10, 0], [10, 10], [0, 10]][side], [x1, y1] = [[10, 0], [10, 10], [0, 10], [0, 0]][side];
        ring.push([E0 + 10 * i + x0 + ((x1 - x0) * k) / 250, N0 + 10 * j + y0 + ((y1 - y0) * k) / 250]);
      }
      dense.push([ring]); denseKeys.push(`SYN_${(i + j) % 50}`);
    }
    const denseDesign = designOf(dense, denseKeys);
    const denseVarieties = varietiesOf(denseDesign);
    const t0 = performance.now();
    const densePlan = resolveImportedPlan(denseDesign, denseVarieties, epsg);
    const tDense = performance.now() - t0;
    ok('a design of densified plots resolves in well under two seconds, and measures its plots',
      tDense < 2000 && Math.abs(densePlan.minFeature - 10) < 0.01, `${tDense.toFixed(0)} ms for 200 plots x 1000 vertices, ${densePlan.minFeature.toFixed(3)} m`);
  }

  // ---- a PSF with no weight anywhere on the grid ------------------------------
  {
    // Narrow and pushed off centre (sigma 0.05 px, 2 px north, both typeable):
    // every kernel weight an edge pixel reaches underflows to 0, and aggregate
    // left such a pixel as a pure pixel of cover 0.
    const sq = (e0, n0, w, h) => [[e0, n0], [e0 + w, n0], [e0 + w, n0 + h], [e0, n0 + h], [e0, n0]];
    const one = { epsg, plots: [{ rings: [sq(640040, 5605040, 10, 10)], species: 1 }], plotIds: true, nSpecies: 2, coverSpecies: Uint8Array.from([1]),
      footprint: convexHull(sq(640040, 5605040, 10, 10)), bbox: [640040, 5605040, 640050, 5605050], minFeature: 10, sig: 'one' };
    const whole = [640000, 5605000, 640100, 5605100];
    const blind = { sigmaX: 0.05, sigmaY: 0.05, offX: 0, offY: 2, mixThreshold: 0.8 };
    const W = simulateField({ res: 10, utmBounds: whole }, [0, 0], layoutOf(one), blind);
    const part = importedTrialExtent(one, 10, blind, whole);
    const T = simulateField({ res: 10, utmBounds: part }, [0, 0], layoutOf(one), blind);
    ok('a pixel whose PSF weighs nothing on the grid is off-trial, not a pure pixel of cover 0',
      W.total === 1 && Array.from(W.pureBySpecies).join() === '0,1' &&
      Array.from(W.mixed.slice(90)).every(id => id === OFF_TRIAL.id) && Array.from(W.proportionOffTrial.slice(90)).every(v => v === 1),
      `total ${W.total}, pure ${Array.from(W.pureBySpecies)}`);
    ok('so the ladder rung over the trial\'s extent counts what the whole field counts',
      T.total === W.total && T.purePct === W.purePct && Array.from(T.pureBySpecies).join() === Array.from(W.pureBySpecies).join(),
      `${T.total} vs ${W.total}`);
    const design = { nSpecies: 2, nBlocks: 1, plotLength: 10, plotWidth: 10, plotAlley: 0, blockAlley: 0, blocksPerRow: 1, seed: 1 };
    const bp = buildBlockPlan(design, blockPlacement(whole, [640040, 5605040], 0, 10, true));
    const blockL = { pattern: 'block', width: 1, spacing: 0, rotationDeg: 0, block: bp };
    const Bb = simulateField({ res: 10, utmBounds: whole }, [640040, 5605040], blockL, blind);
    const Bs = simulateField({ res: 10, utmBounds: whole }, [640040, 5605040], blockL, { ...blind, sigmaX: 0.1, sigmaY: 0.1 });
    ok('a block trial counts the same pixels with that kernel as with one just wide enough not to underflow',
      Bb.total === Bs.total && Array.from(Bb.pureBySpecies).join() === Array.from(Bs.pureBySpecies).join(), `${Bb.total} vs ${Bs.total}`);
    const bnd = [4.7, 50.6, 4.702, 50.6015], strips = { pattern: 'col', width: 20, spacing: 0, rotationDeg: 0 };
    const sweepOf = (sensorS) => resolutionSweep(bnd, 32631, strips, [10, 5], sensorS).map(q => q.purePct).join();
    ok('the purity sweep of a periodic layout skips such pixels too, and counts none pure when none can see',
      sweepOf(blind) === sweepOf({ ...blind, sigmaX: 0.1, sigmaY: 0.1 }) &&
      sweepOf({ sigmaX: 0.01, sigmaY: 0.01, offX: 0.5, offY: 0, mixThreshold: 0.8 }) === '0,0');
    // Exactly those pixels: the ones aggregate gave no weight at all, which are
    // the ones with no species, no bare and no off-trial share.
    let pixels = 0, zero = 0, wrong = 0;
    // Fixed kernels first: one seen only by its own row's neighbours at the
    // grid's northern edge, one blind everywhere, one blind only along an edge.
    const fixedZ = [{ sigmaX: 0.02, sigmaY: 0.02, offX: 1, offY: 0.3 }, { sigmaX: 0.02, sigmaY: 0.02, offX: -1, offY: -0.3 },
      { sigmaX: 0.01, sigmaY: 0.5, offX: 0.5, offY: 0 }, { sigmaX: 0.05, sigmaY: 0.05, offX: 0, offY: 2 }];
    for (let it = 0; it < 40; it++) {
      const sensorZ = it < fixedZ.length ? { ...fixedZ[it], mixThreshold: 0.8 }
        : { sigmaX: rnd() * 0.08, sigmaY: rnd() < 0.3 ? 1.5 * rnd() : rnd() * 0.08, offX: rnd() * 4 - 2, offY: rnd() * 4 - 2, mixThreshold: 0.8 };
      // The grid's northern edge cuts through the trial, so its top row holds
      // plots rather than off-trial margin (which reads the same either way).
      const r = 1, [b0, b1, b2, b3] = alleyPlan.bbox;
      const grid = { res: r, utmBounds: [Math.floor(b0) - 2, Math.floor(b1) - 2, Math.ceil(b2) + 2, Math.round((b1 + b3) / 2)] };
      const L = layoutOf(alleyPlan);
      const nxZ = Math.round((grid.utmBounds[2] - grid.utmBounds[0]) / r), nyZ = Math.round((grid.utmBounds[3] - grid.utmBounds[1]) / r);
      const { coverSpecies, nSpecies } = speciesChannel(L);
      // The engine's own aggregation of this trial, before the blind pixels are
      // marked: an imported trial is measured by exact areas, not sampled.
      const agg = aggregateImported(alleyPlan, grid.utmBounds[0], grid.utmBounds[1], nxZ, nyZ, r,
        { ...sensorZ, mixThreshold: 0.8 }, coverSpecies, nSpecies);
      const sim = simulateField(grid, [0, 0], L, sensorZ);
      for (let k = 0; k < sim.mixed.length; k++) {
        pixels++;
        const none = agg.cropMapDominantFrac[k] === 0 && agg.cropMapProportionBare[k] === 0 && agg.cropMapProportionOffTrial[k] === 0;
        if (none) zero++;
        if (none ? !(sim.mixed[k] === OFF_TRIAL.id && sim.proportionOffTrial[k] === 1)
                 : !(sim.mixed[k] === agg.cropMapMixed[k] && Object.is(sim.proportionOffTrial[k], agg.cropMapProportionOffTrial[k]))) wrong++;
      }
    }
    ok('and exactly those: every pixel aggregate gave no weight, and no other', wrong === 0 && zero > 0, `${zero} of ${pixels} weightless, ${wrong} wrong`);
  }

  // ---- more plots than the cover map can number ------------------------------
  {
    // A 17 x 15 grid of 2 m plots, all one variety but the last plot. With plot
    // ids a pixel straddling two plots of that variety is mixed; with species
    // ids it is pure. That difference is the whole point of plot ids.
    const t = gridTrial({ nx: 17, ny: 15, w: 2, h: 2, deg: 0, nVar: 1 });
    const keysOf = n => Array.from({ length: n }, (_, i) => (i === n - 1 ? 'B' : 'A'));
    const byPlot = resolve(t.plots.slice(0, 253), keysOf(253));
    const bySpecies = resolve(t.plots.slice(0, 254), keysOf(254));
    ok('253 plots keep plot ids; the 254th falls back to species ids with an identity table',
      byPlot.plotIds && byPlot.coverSpecies.length === 253 &&
      !bySpecies.plotIds && Array.from(bySpecies.coverSpecies).join() === '0,1' && bySpecies.nSpecies === 2);
    const sensor = { sigmaX: 0, sigmaY: 0, mixThreshold: 0.95 };
    // One-metre pixels centred on the plot edges: every other pixel in each axis
    // straddles one, so about three pixels in four touch two plots.
    const box = (p) => ({ res: 1, utmBounds: [p.bbox[0] - 0.5, p.bbox[1] - 0.5, p.bbox[0] + 34.5, p.bbox[1] + 30.5] });
    const simP = simulateField(box(byPlot), [0, 0], layoutOf(byPlot), sensor);
    const simS = simulateField(box(bySpecies), [0, 0], layoutOf(bySpecies), sensor);
    const fb = coverStats({ mixed: simS.mixed, coverSpecies: bySpecies.coverSpecies, nSpecies: 2, offTrial: simS.proportionOffTrial });
    ok('with species ids the cover map holds species, and the tallies still add up',
      Array.from(simS.mixed).every(id => id <= 1 || id >= OFF_TRIAL.id) && fb.pureBySpecies[0] + fb.pureBySpecies[1] === fb.pureCrop && fb.pureBySpecies[1] > 0,
      `${fb.pureBySpecies[0]} + ${fb.pureBySpecies[1]} of ${fb.total}`);
    ok('a pixel straddling two plots of one variety is mixed with plot ids and pure with species ids',
      // Species ids lose only the pixels half off the trial's edge; plot ids keep about one pixel in four.
      simS.purePct > 80 && simP.purePct < 30, `${simP.purePct.toFixed(1)}% vs ${simS.purePct.toFixed(1)}%`);
  }

  // ---- a synthetic trial shaped like a real one, end to end ------------------
  const layout = layoutOf(plan);
  const sensor = { sigmaX: 0.55, sigmaY: 0.55, mixThreshold: 0.95 };
  const boxAt = (r, margin) => ({ res: r, utmBounds: [Math.floor((plan.bbox[0] - margin) / r) * r, Math.floor((plan.bbox[1] - margin) / r) * r,
    Math.ceil((plan.bbox[2] + margin) / r) * r, Math.ceil((plan.bbox[3] + margin) / r) * r] });
  {
    let t0 = performance.now();
    const fine = simulateField(boxAt(0.5, 10), [0, 0], layout, sensor);
    const tFine = performance.now() - t0;
    const coarse = simulateField(boxAt(10, 10), [0, 0], layout, sensor);
    const g = strideFor(0.5, minFeatureM(layout));
    const e0 = Math.floor(plan.bbox[0]), n0 = Math.floor(plan.bbox[1]);
    const times = [];
    for (let i = 0; i < 9; i++) { t0 = performance.now(); buildCropMap(e0, n0, 105 * 2 * g, 160 * 2 * g, 0.5 / g, 0, 0, layout); times.push(performance.now() - t0); }
    times.sort((a, b) => a - b);
    console.log(`        (a ${160 * 2 * g} x ${105 * 2 * g} fine cover map at stride ${g} takes ${times[4].toFixed(2)} ms; simulateField, ` +
      `which measures the plots rather than sampling them, takes ${tFine.toFixed(0)} ms over the whole ${fine.mixed.length}-pixel box)`);
    ok('the trial runs end to end with one species per variety',
      fine.nSpecies === 40 && fine.pureBySpecies.length === 40 && fine.proportionBySpecies.length === fine.mixed.length * 40);
    ok('at 0.5 m most trial pixels are pure, every variety has pure pixels and there is no alley',
      fine.purePct > 75 && Array.from(fine.pureBySpecies).every(v => v > 0) && fine.pureBare === 0,
      `${fine.purePct.toFixed(1)}% of ${fine.total}, fewest ${Math.min(...fine.pureBySpecies)} for one variety`);
    ok('at 10 m, pixels as wide as two thirds of a rotated plot, almost nothing is pure',
      coarse.purePct < 10 && coarse.total > 50, `${coarse.purePct.toFixed(1)}% of ${coarse.total}`);
    const trialM2 = 50 * 15 * 14.6, meanSum = Array.from(fine.meanBySpecies).reduce((a, b) => a + b, 0);
    ok('the trial pixels cover the trial\'s area, and the species share them out',
      Math.abs(fine.total * 0.25 - trialM2) < 0.05 * trialM2 && meanSum > 0.97 && meanSum <= 1 + 1e-6,
      `${(fine.total * 0.25).toFixed(0)} vs ${trialM2} m2, species sum ${meanSum.toFixed(3)}`);

    // Repetitions: pure pixels of a variety are the pure pixels of all its plots.
    const perPlot = new Uint32Array(50);
    for (const id of fine.mixed) if (id < 50) perPlot[id]++;
    ok('a variety\'s pure pixels are exactly the pure pixels of its plots, summed',
      Array.from(fine.pureBySpecies).every((n, s) => n === plan.plots.reduce((a, p, i) => a + (p.species === s ? perPlot[i] : 0), 0)));
    const reps = trialVarieties.map((v, s) => ({ plots: v.plots, pure: fine.pureBySpecies[s] }));
    ok('so a variety grown on two plots reads about twice the pure ground of one grown on one',
      Math.min(...reps.filter(r => r.plots === 2).map(r => r.pure)) > 1.6 * Math.max(...reps.filter(r => r.plots === 1).map(r => r.pure)),
      `${Math.min(...reps.filter(r => r.plots === 2).map(r => r.pure))} vs ${Math.max(...reps.filter(r => r.plots === 1).map(r => r.pure))}`);
    const { res, utmBounds } = boxAt(0.5, 10), nx = Math.round((utmBounds[2] - utmBounds[0]) / res);
    ok('a pixel well inside a plot is pure for that plot, whose species is its variety',
      plan.plots.every((p, i) => {
        const [cx, cy] = p.rings[0].slice(0, 4).reduce((a, q) => [a[0] + q[0] / 4, a[1] + q[1] / 4], [0, 0]);
        const k = Math.floor((cy - utmBounds[1]) / res) * nx + Math.floor((cx - utmBounds[0]) / res);
        return fine.mixed[k] === i && plan.coverSpecies[fine.mixed[k]] === trialVarieties.findIndex(v => v.key === trial50.keys[i]);
      }));

    const patchBox = boxAt(1, 5), side = Math.max(patchBox.utmBounds[2] - patchBox.utmBounds[0], patchBox.utmBounds[3] - patchBox.utmBounds[1]);
    const patch = simulatePatch(patchBox.utmBounds[0], patchBox.utmBounds[1], side, 1, 999, -999, layout, sensor);
    const field = simulateField({ res: 1, utmBounds: [patchBox.utmBounds[0], patchBox.utmBounds[1], patchBox.utmBounds[0] + side, patchBox.utmBounds[1] + side] }, [0, 0], layout, sensor);
    ok('simulatePatch over the same square is simulateField, whatever origin it is handed',
      patch.purePct === field.purePct && patch.mixed.every((v, k) => v === field.mixed[k]) &&
      patch.proportionBySpecies.every((v, k) => Object.is(v, field.proportionBySpecies[k])));
    ok('phase optimisation leaves an imported trial where the file put it',
      bestPhaseOffset('imported', 10, 2, 0, 0.8, E0, N0).join() === '0,0');
    const lng = trialDesign.plots.flatMap(p => p.rings[0]).map(q => q[0]), lat = trialDesign.plots.flatMap(p => p.rings[0]).map(q => q[1]);
    const sweep = resolutionSweep([Math.min(...lng) - 0.001, Math.min(...lat) - 0.001, Math.max(...lng) + 0.001, Math.max(...lat) + 0.001], epsg, layout, [20, 10, 1], sensor);
    ok('the purity sweep measures the trial itself: finer pixels resolve more of it',
      sweep.every(s => s.purePct >= 0 && s.purePct <= 100) && sweep[2].purePct > 70 && sweep[2].purePct > sweep[0].purePct,
      sweep.map(s => `${s.gsd}:${s.purePct.toFixed(1)}`).join(' '));
  }

  // ---- a ladder rung over the trial's extent is the whole-field rung --------
  {
    const sensors = [
      { sigmaX: 0.55, sigmaY: 0.55, mixThreshold: 0.95 },
      { sigmaX: 1.2, sigmaY: 0.4, mixThreshold: 0.8, offX: 0.7, offY: -0.3 },
    ];
    const small = gridTrial({ nx: 4, ny: 3, w: 8, h: 6, alley: 0.5, deg: 23, nVar: 5 });
    const trials = [[plan, 'trial-like'], [resolve(small.plots, small.keys), 'alleys']];
    let identical = true, smaller = 0, larger = 0, runs = 0, detail = '';
    for (const [p, name] of trials) for (const sensorL of sensors) for (const r of name === 'alleys' ? [0.5, 1, 3, 10] : [1, 3, 10]) {
      const L = layoutOf(p);
      const whole = [Math.floor((p.bbox[0] - 45) / r) * r, Math.floor((p.bbox[1] - 30) / r) * r, Math.ceil((p.bbox[2] + 25) / r) * r, Math.ceil((p.bbox[3] + 40) / r) * r];
      const part = importedTrialExtent(p, r, sensorL, whole);
      const W = simulateField({ res: r, utmBounds: whole }, [0, 0], L, sensorL);
      const T = simulateField({ res: r, utmBounds: part }, [0, 0], L, sensorL);
      const nW = Math.round((whole[2] - whole[0]) / r), nT = Math.round((part[2] - part[0]) / r);
      const dc = Math.round((part[0] - whole[0]) / r), dr = Math.round((part[1] - whole[1]) / r);
      const nSp = W.nSpecies;
      let same = W.purePct === T.purePct && W.total === T.total && Array.from(W.pureBySpecies).join() === Array.from(T.pureBySpecies).join();
      let trialInT = 0;
      for (let k = 0; k < T.mixed.length && same; k++) {
        if (T.proportionOffTrial[k] > 0.5) continue;
        trialInT++;
        const kw = (Math.floor(k / nT) + dr) * nW + (k % nT) + dc;
        same = T.mixed[k] === W.mixed[kw] && Object.is(T.proportionA[k], W.proportionA[kw]) && Object.is(T.proportionBare[k], W.proportionBare[kw]) &&
          Object.is(T.proportionOffTrial[k], W.proportionOffTrial[kw]);
        for (let s = 0; s < nSp && same; s++) same = Object.is(T.proportionBySpecies[k * nSp + s], W.proportionBySpecies[kw * nSp + s]);
      }
      same = same && trialInT === W.total;
      if (!same && identical) detail = `${name} differs at ${r} m`;
      identical = identical && same;
      runs++;
      if (T.mixed.length < W.mixed.length) smaller++;
      if (T.mixed.length > W.mixed.length) larger++;
    }
    ok('a rung simulated over the imported trial\'s extent equals the whole-field rung, bitwise, pixel for pixel', identical, detail || `${runs} rungs`);
    ok('and it never simulates more pixels than the field, and fewer on most rungs',
      larger === 0 && smaller >= runs / 2, `${smaller} of ${runs} smaller`);
    const extent = [0, 0, 100, 100];
    const farAway = { ...plan, bbox: [5000, 5000, 5100, 5100] };
    ok('importedTrialExtent never reaches outside the field, even for a trial that is not on it',
      importedTrialExtent(farAway, 1, sensors[0], extent).join() === '0,0,1,1');
  }
}

console.log('\nH13. an imported trial is measured, not sampled');
{
  // The engine sampled a pixel by classifying g x g fine cells by their centres,
  // and g is 4 wherever plots are wider than the pixel: a pixel's share of a
  // plot came in quarters. Along a tilted edge those roundings cancel out;
  // along an edge PARALLEL to the pixel rows every pixel rounds the same way,
  // so a trial staked along the grid lost pure pixels it really had and the page
  // told the agronomist that lining a trial up with the satellite does not pay.
  // Shares are polygon areas now. This section pins them against arithmetic
  // anyone can redo by hand, against sampling fine enough to be trusted, and
  // against that conclusion.
  const epsg = 32631;
  // Whole metres, where a coordinate and an offset of a few metres are both
  // exact: an area computed here is the analytic one to the last bit, not to
  // the 1e-9 m a six-figure easting would round every vertex to.
  const E0 = 500000, N0 = 4000000;
  let seed13 = 424242;
  const rnd13 = () => (seed13 = (Math.imul(seed13, 1664525) + 1013904223) >>> 0) / 4294967296;
  const boxRing = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  const turnRing = (cx, cy, w, h, deg) => {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
  };
  const circleRing = (cx, cy, r, n) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);
  /** A plan built by hand, so a fixture is its geometry and nothing else. */
  const planOf = (plots, nSpecies, tag) => {
    const all = plots.flatMap(p => p.rings.flat());
    return {
      epsg, plots, coverSpecies: Uint8Array.from(plots, p => p.species), plotIds: true, nSpecies,
      footprint: convexHull(all),
      bbox: [Math.min(...all.map(q => q[0])), Math.min(...all.map(q => q[1])), Math.max(...all.map(q => q[0])), Math.max(...all.map(q => q[1]))],
      minFeature: 1, sig: `h13-${tag}`,
    };
  };
  const importedLayout = (plan) => ({ pattern: 'imported', width: 2, spacing: 0, rotationDeg: 0, imported: plan });
  /** What each cover holds of each pixel, in square metres: the engine's phase 1 itself. */
  const sharesOf = (plan, minE, minN, nx, ny, res) => {
    const { pc } = importedPixelCovers(plan, minE, minN, nx, ny, res);
    return Array.from({ length: nx * ny }, (_, k) => {
      const m = new Map();
      for (let q = pc.pairStart[k]; q < pc.pairStart[k + 1]; q++) m.set(pc.pairSlot[q], (m.get(pc.pairSlot[q]) ?? 0) + pc.pairW[q]);
      return m;
    });
  };
  const orderOf = (plan, minE, minN, nx, ny, res) => {
    const { pc } = importedPixelCovers(plan, minE, minN, nx, ny, res);
    return Array.from({ length: nx * ny }, (_, k) => Array.from(pc.pairSlot.slice(pc.pairStart[k], pc.pairStart[k + 1])));
  };
  /** Independent of the engine: the cover of a point, straight from pointInPoly, later plots winning. */
  const coverAtPoint = (plan, E, N) => {
    let id = pointInPoly(E, N, plan.footprint) ? BARE.id : OFF_TRIAL.id;
    plan.plots.forEach((p, i) => {
      let inside = false;
      for (const ring of p.rings) if (pointInPoly(E, N, ring)) inside = !inside;
      if (inside) id = plan.plotIds ? i : p.species;
    });
    return id;
  };

  // ---- areas anyone can check by hand ---------------------------------------
  {
    const rect = planOf([{ rings: [boxRing(E0 + 2.25, N0 + 1.25, 3.5, 2.5)], species: 0 }], 2, 'rect');
    const sh = sharesOf(rect, E0, N0, 8, 8, 1);
    const at = (i, j, cover) => sh[j * 8 + i].get(cover) ?? 0;
    ok('the pixel holding a rectangle\'s corner gets exactly the corner\'s area',
      at(2, 1, 0) === 0.75 * 0.75, `${at(2, 1, 0)} vs ${0.75 * 0.75}`);
    ok('a pixel inside the plot is the whole pixel, one outside it none of it',
      at(3, 2, 0) === 1 && at(6, 6, 0) === 0 && at(6, 6, OFF_TRIAL.id) === 1);
    ok('and the plot\'s shares add up to its area',
      Math.abs(sh.reduce((a, m) => a + (m.get(0) ?? 0), 0) - 3.5 * 2.5) < 1e-12);

    // A 4 x 4 square turned 45 degrees: every pixel it meets is cut by a slope,
    // the very case a centre-sampled quarter cannot express.
    const diamond = planOf([{ rings: [turnRing(E0 + 4, N0 + 4, 4, 4, 45)], species: 0 }], 2, 'diamond');
    const dsh = sharesOf(diamond, E0, N0, 8, 8, 1);
    // Its corners are irrational, so they land on the 1e-10 m lattice a
    // six-figure easting has: that rounding, not the clipping, is what these
    // two are allowed to differ by.
    const leg = 4 + 2 * Math.SQRT2 - 6;   // how far its east corner reaches past x = 6
    ok('a rotated square keeps its area, and the pixel past its corner holds the triangle it cuts',
      Math.abs(dsh.reduce((a, m) => a + (m.get(0) ?? 0), 0) - 16) < 1e-9 &&
      Math.abs((dsh[4 * 8 + 6].get(0) ?? 0) - (leg * leg) / 2) < 1e-9,
      `${dsh.reduce((a, m) => a + (m.get(0) ?? 0), 0)} m2, corner pixel ${(dsh[4 * 8 + 6].get(0) ?? 0).toFixed(9)}`);

    // A hole, by the even-odd rule the rasteriser uses: the ring inside the ring
    // is not covered, whichever way either of them is wound.
    const holed = planOf([{ rings: [boxRing(E0 + 1, N0 + 1, 6, 6), boxRing(E0 + 2.5, N0 + 2.5, 3, 3).slice().reverse()], species: 0 }], 2, 'hole');
    const hsh = sharesOf(holed, E0, N0, 8, 8, 1);
    ok('a plot with a hole covers its area less the hole\'s, and the hole is bare ground',
      Math.abs(hsh.reduce((a, m) => a + (m.get(0) ?? 0), 0) - (36 - 9)) < 1e-9 &&
      (hsh[3 * 8 + 3].get(BARE.id) ?? 0) === 1 && (hsh[3 * 8 + 3].get(0) ?? 0) === 0 &&
      Math.abs((hsh[2 * 8 + 2].get(0) ?? 0) - 0.75) < 1e-12 && Math.abs((hsh[2 * 8 + 2].get(BARE.id) ?? 0) - 0.25) < 1e-12,
      `${hsh.reduce((a, m) => a + (m.get(0) ?? 0), 0)} m2`);

    const multi = planOf([{ rings: [boxRing(E0 + 1, N0 + 1, 2.5, 2), boxRing(E0 + 5, N0 + 4.5, 2, 2.5)], species: 0 }], 2, 'multi');
    const msh = sharesOf(multi, E0, N0, 8, 8, 1);
    ok('a plot in two parts covers both of them and nothing between',
      Math.abs(msh.reduce((a, m) => a + (m.get(0) ?? 0), 0) - (2.5 * 2 + 2 * 2.5)) < 1e-12 &&
      (msh[3 * 8 + 3].get(0) ?? 0) === 0);

    const over = planOf([{ rings: [boxRing(E0 - 2.5, N0 + 2, 5, 3)], species: 0 }], 2, 'edge');
    const osh = sharesOf(over, E0, N0, 8, 8, 1);
    ok('a plot running off the grid is counted only where the grid is',
      Math.abs(osh.reduce((a, m) => a + (m.get(0) ?? 0), 0) - 2.5 * 3) < 1e-12);

    // Overlapping plots: the rasteriser paints them in file order, so the later
    // one holds the ground they share, and the earlier one keeps the rest.
    const lap = planOf([{ rings: [boxRing(E0 + 1, N0 + 1, 4, 4)], species: 0 }, { rings: [boxRing(E0 + 3, N0 + 3, 4, 4)], species: 1 }], 2, 'lap');
    const lsh = sharesOf(lap, E0, N0, 8, 8, 1);
    ok('where two plots overlap the later one takes the ground they share',
      Math.abs(lsh.reduce((a, m) => a + (m.get(1) ?? 0), 0) - 16) < 1e-9 &&
      Math.abs(lsh.reduce((a, m) => a + (m.get(0) ?? 0), 0) - (16 - 4)) < 1e-9 &&
      (lsh[3 * 8 + 3].get(0) ?? 0) === 0 && (lsh[3 * 8 + 3].get(1) ?? 0) === 1,
      `${lsh.reduce((a, m) => a + (m.get(0) ?? 0), 0).toFixed(6)} m2 left of ${4 * 4} for the earlier plot`);

    // The order the covers are listed in is part of the answer: phase 2 adds the
    // weights in it and breaks a dominance tie by it.
    const order = orderOf(lap, E0, N0, 8, 8, 1).concat(orderOf(holed, E0, N0, 8, 8, 1));
    const ordered = order.every(ids => {
      const plots = ids.filter(id => id <= MAX_COVER), rest = ids.filter(id => id > MAX_COVER);
      return plots.every((id, i) => i === 0 || id > plots[i - 1]) &&
             ids.slice(0, plots.length).join() === plots.join() &&
             (rest.length < 2 || (rest[0] === BARE.id && rest[1] === OFF_TRIAL.id)) &&
             new Set(ids).size === ids.length;
    });
    ok('a pixel lists its covers in ascending cover id, then bare alley, then off-trial ground', ordered);
  }

  // ---- against sampling fine enough to be trusted ----------------------------
  {
    // 64 x 64 samples per pixel, classified by the independent point test above:
    // an edge crossing a pixel is then resolved to a 64th of it, so the exact
    // area and the sampled one may differ by about that much and no more.
    let worst = 0, worstWhat = '', sums = 0, neg = 0, pixels = 0, designs = 0;
    for (let it = 0; it < 8; it++) {
      const plots = [];
      for (let p = 0; p < 3 + (it % 3); p++) {
        const cx = E0 + 3 + rnd13() * 6, cy = N0 + 3 + rnd13() * 6, deg = rnd13() * 180, sp = p % 3;
        if (it % 4 === 0) plots.push({ rings: [turnRing(cx, cy, 2 + rnd13() * 5, 2 + rnd13() * 5, deg)], species: sp });
        else if (it % 4 === 1) plots.push({ rings: [turnRing(cx, cy, 5, 5, deg), turnRing(cx, cy, 2, 2, deg + 25)], species: sp });      // a hole
        else if (it % 4 === 2) plots.push({ rings: [circleRing(cx, cy, 1 + rnd13() * 2, 9 + Math.floor(rnd13() * 20))], species: sp });  // round
        else plots.push({ rings: [[[cx - 3, cy - 2], [cx + 3, cy + 2], [cx + 3, cy - 2], [cx - 3, cy + 2]]], species: sp });             // a bow tie
      }
      const plan = planOf(plots, 3, `sample${it}`);
      const res = [0.5, 1, 2][it % 3];
      const minE = Math.floor((plan.bbox[0] - res) / res) * res, minN = Math.floor((plan.bbox[1] - res) / res) * res;
      const nx = Math.min(24, Math.ceil((plan.bbox[2] + res - minE) / res)), ny = Math.min(24, Math.ceil((plan.bbox[3] + res - minN) / res));
      const got = sharesOf(plan, minE, minN, nx, ny, res);
      designs++;
      const S = 64, cell = (res * res) / (S * S);
      for (let k = 0; k < nx * ny; k++) {
        pixels++;
        let sum = 0;
        for (const v of got[k].values()) { sum += v; if (!(v > 0)) neg++; }
        if (Math.abs(sum - res * res) > 1e-9 * res * res) sums++;
        const want = new Map();
        const i = k % nx, j = (k / nx) | 0;
        for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
          const id = coverAtPoint(plan, minE + i * res + ((b + 0.5) * res) / S, minN + j * res + ((a + 0.5) * res) / S);
          want.set(id, (want.get(id) ?? 0) + cell);
        }
        for (const id of new Set([...got[k].keys(), ...want.keys()])) {
          const d = Math.abs((got[k].get(id) ?? 0) - (want.get(id) ?? 0)) / (res * res);
          if (d > worst) { worst = d; worstWhat = `design ${it} at ${res} m, pixel ${k}, cover ${id}`; }
        }
      }
    }
    ok('exact shares agree with 64 x 64 sampling of rotated, holed, round and self-crossing plots',
      worst < 0.05, `worst ${worst.toFixed(4)} of a pixel (${worstWhat}), ${designs} designs, ${pixels} pixels`);
    ok('and every pixel\'s shares add up to its area, with nothing negative in them',
      sums === 0 && neg === 0, `${sums} pixels off, ${neg} shares not positive`);
  }

  // ---- what the sampling cost the agronomist --------------------------------
  {
    // The file this feature was built for: 50 contiguous plots of about 14.6 x
    // 15 m, ten across and five up, drawn 11.36 degrees off the pixel rows, 40
    // varieties with ten of them grown twice.
    const trial = (deg) => {
      const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      const at = (u, v) => [E0 + u * c - v * s, N0 + u * s + v * c];
      const w = 14.63, h = 14.99, plots = [];
      for (let j = 0; j < 5; j++) for (let i = 0; i < 10; i++) {
        const u0 = i * w, v0 = j * h, k = plots.length;
        plots.push({ rings: [[at(u0, v0), at(u0 + w, v0), at(u0 + w, v0 + h), at(u0, v0 + h), at(u0, v0)]], species: k < 40 ? k : ((k - 40) * 7) % 40 });
      }
      return planOf(plots, 40, `trial${deg}`);
    };
    const shift = (plan, dx, dy) => ({
      ...plan,
      plots: plan.plots.map(p => ({ ...p, rings: p.rings.map(r => r.map(([x, y]) => [x + dx, y + dy])) })),
      footprint: plan.footprint.map(([x, y]) => [x + dx, y + dy]),
      bbox: [plan.bbox[0] + dx, plan.bbox[1] + dy, plan.bbox[2] + dx, plan.bbox[3] + dy],
      sig: `${plan.sig}|${dx},${dy}`,
    });
    const s2 = { sigmaX: 0.55, sigmaY: 0.55, mixThreshold: 0.9 };
    /** Pure pixels of a trial on the pixel lattice of size r, over its own ground. */
    const pureCount = (plan, r) => {
      const m = 6 * r, b = plan.bbox;
      const ext = [Math.floor((b[0] - m) / r) * r, Math.floor((b[1] - m) / r) * r, Math.ceil((b[2] + m) / r) * r, Math.ceil((b[3] + m) / r) * r];
      const sim = simulateField({ res: r, utmBounds: ext }, [0, 0], importedLayout(plan), s2);
      return Array.from(sim.pureBySpecies).reduce((a, c) => a + c, 0);
    };
    const drawn = trial(11.36), aligned = trial(0);
    const rows = [];
    let wins = true;
    for (const r of [2, 4, 5]) {
      const asDrawn = pureCount(drawn, r);
      let best = -1;
      for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) best = Math.max(best, pureCount(shift(aligned, (i * r) / 10, (j * r) / 10), r));
      rows.push(`${r} m: ${best} aligned vs ${asDrawn} as drawn`);
      wins = wins && best >= asDrawn;
    }
    // Sampled in quarters, this very trial read 1660 aligned against 1679 as
    // drawn at 2 m, and the user's own file 1650 against 1657: staking a trial
    // along the pixel rows looked like a mistake, because every pixel beside an
    // edge parallel to those rows had its neighbour's share rounded the same way.
    ok('a trial staked along the pixel rows now keeps at least what the same trial drawn across them keeps',
      wins, rows.join(', '));

    // The old answer depended on the stride the fine grid would have used, which
    // is a property of the narrowest plot, not of the ground.
    const coarse = { ...drawn, minFeature: 40, sig: `${drawn.sig}|coarse` };
    ok('and the measurement no longer depends on how finely the old grid would have sampled',
      pureCount(coarse, 4) === pureCount(drawn, 4) && minFeatureM(importedLayout(coarse)) !== minFeatureM(importedLayout(drawn)));
  }

  // ---- the edges of the exact path ------------------------------------------
  {
    // Two plots are added up rather than swept unless the pair can be PROVEN to
    // overlap, and the proof allows a billionth of the smaller plot for the
    // width a shared edge picks up from rounding. Plots that really overlap by
    // less than that are added up, so the earlier one keeps a sliver the later
    // one should win, and the sliver is counted twice: the pixel's background
    // is short by it. It comes out of the background and never out of the
    // pixel's area, and it is bounded by the tolerance itself. Both plots are
    // 15 m2 here, so the tolerance is 1.5e-8 m2 of shared ground.
    const lapPlan = (d) => planOf([
      { rings: [boxRing(E0, N0, 5, 3)], species: 0 },
      { rings: [boxRing(E0 + 5 - d, N0, 5, 3)], species: 1 },
      { rings: [boxRing(E0, N0 + 5, 10, 3)], species: 2 },   // a third plot, so the pixel below is inside the footprint
    ], 3, `lap${d}`);
    // The pixel x [E0+4, E0+6], y [N0+2, N0+4]: plot 0 holds 1 m2 of it, plot 1
    // holds 1 m2 plus the overlap, and the 2 m2 above the plots is bare alley.
    const lapPixel = (d) => sharesOf(lapPlan(d), E0, N0, 5, 4, 2)[1 * 5 + 2];
    {
      const d = 4e-9, m = lapPixel(d);                       // 4e-9 m2 of shared ground, under the 1.5e-8 tolerance
      const sum = [...m.values()].reduce((a, b) => a + b, 0);
      ok('an overlap below the proof tolerance is left with the earlier plot, out of the background',
        Math.abs((m.get(0) ?? 0) - 1) < 1e-10 && Math.abs((m.get(BARE.id) ?? 0) - (2 - d)) < 1e-10 &&
        Math.abs((m.get(BARE.id) ?? 0) - 2) <= 1e-9 * 15,
        `plot 0 ${(m.get(0) ?? 0).toFixed(12)}, bare ${(m.get(BARE.id) ?? 0).toFixed(12)} of 2`);
      ok('and the pixel is still shared out whole, with nothing negative in it',
        sum === 4 && [...m.values()].every(v => v > 0), `${sum} m2 of 4`);
    }
    {
      const d = 4e-6, m = lapPixel(d);                       // a thousand times wider: proven, and swept exactly
      const sum = [...m.values()].reduce((a, b) => a + b, 0);
      ok('an overlap the proof can see is measured exactly, the later plot taking the shared ground',
        Math.abs((m.get(0) ?? 0) - (1 - d)) < 1e-10 && Math.abs((m.get(1) ?? 0) - (1 + d)) < 1e-10 &&
        Math.abs((m.get(BARE.id) ?? 0) - 2) < 1e-10 && sum === 4,
        `plot 0 ${(m.get(0) ?? 0).toFixed(12)}, plot 1 ${(m.get(1) ?? 0).toFixed(12)}, bare ${(m.get(BARE.id) ?? 0).toFixed(12)}`);
    }

    // The sweep cuts a pixel at every height where two of its edges cross. It
    // used to ask for room for every PAIR of edges before looking for one: a
    // dense ring inside a single pixel meant hundreds of megabytes of zeroed
    // array for the handful of crossings it actually has. The crossings are
    // appended as they are found now, and the edges are read lowest end first
    // so the pairs whose heights cannot meet are skipped instead of tested.
    const dense = planOf([{ rings: [circleRing(E0, N0, 20, 2000), circleRing(E0, N0, 8, 1000)] , species: 0 }], 1, 'dense');
    const buffers = () => process.memoryUsage().arrayBuffers ?? process.memoryUsage().external ?? 0;
    const memBefore = buffers();
    const dsh = sharesOf(dense, E0 - 30, N0 - 30, 1, 1, 60)[0];
    const grewMB = (buffers() - memBefore) / 1e6;
    const dsum = [...dsh.values()].reduce((a, b) => a + b, 0);
    // 3000 edges in one pixel: the pair array alone was 100 MB of it.
    ok('a dense ring swept inside one pixel does not ask for room for every pair of its edges',
      grewMB < 16, `${grewMB.toFixed(1)} MB`);
    ok('and the ring with the hole in it still measures its own area',
      Math.abs((dsh.get(0) ?? 0) - Math.PI * (400 - 64)) < 0.01 && Math.abs(dsum - 60 * 60) < 1e-9,
      `${(dsh.get(0) ?? 0).toFixed(3)} of ${(Math.PI * (400 - 64)).toFixed(3)} m2, pixel ${dsum}`);

    // Staking the aligned comparison: the trial is tried at an N x N grid of
    // sub-pixel shifts, N chosen so the search stays within a budget of
    // simulated pixels. A trial too big for ONE simulation to fit that budget
    // leaves N at 1, which offers the trial where it stands and nothing to
    // choose between, and counting its pure pixels answered a question nobody
    // asked: half a second of blocked page here, 1.6 s on a 2000-plot import.
    const s13 = { sigmaX: 0.55, sigmaY: 0.55, mixThreshold: 0.9 };
    const wide = planOf([[0, 0], [380, 0], [0, 380], [380, 380]].map(([u, v], i) =>
      ({ rings: [boxRing(E0 + u, N0 + v, 20, 20)], species: i })), 4, 'wide');
    const wideField = [wide.bbox[0] - 20, wide.bbox[1] - 20, wide.bbox[2] + 20, wide.bbox[3] + 20];
    const t13 = performance.now();
    const staked = stakeOnGrid(wide, 0.5, s13, wideField);   // 660,000 pixels: one call is already over budget
    const stakeMs = performance.now() - t13;
    ok('a trial too big to search is staked where it stands, without simulating it to find that out',
      staked.plan === wide && staked.shift[0] === 0 && staked.shift[1] === 0 && stakeMs < 50,
      `${stakeMs.toFixed(1)} ms, shift ${staked.shift.join(',')}`);
    // ... and SAYS it never searched. Without this flag "aligned" is the best of
    // a search at one pixel size and merely "turned" at another, and the page
    // has no way to tell the reader which of the two it is looking at.
    ok('and it reports that it was not staked, so the page can say so',
      staked.staked === false, `staked=${staked.staked}`);

    // and a trial the budget does cover is still searched, and the search still
    // pays: this one keeps pure pixels at a shift it loses where it stands.
    const small = planOf(Array.from({ length: 12 }, (_, i) =>
      ({ rings: [boxRing(E0 + (i % 4) * 15, N0 + ((i / 4) | 0) * 15, 14, 14)], species: i })), 12, 'small');
    const smallField = [small.bbox[0] - 20, small.bbox[1] - 20, small.bbox[2] + 20, small.bbox[3] + 20];
    const picked = stakeOnGrid(small, 2, s13, smallField);
    // STRICTLY better at a NON-ZERO shift, because the search starts at (0, 0)
    // and only replaces its best on a strict improvement: with `>=` and no test
    // on the shift, a stakeOnGrid that had quietly stopped moving anything would
    // pass this section unchanged.
    ok('a trial the budget covers is still staked at the best sub-pixel shift it can find',
      picked.staked === true &&
      purePixels(picked.plan, 2, s13, smallField) > purePixels(small, 2, s13, smallField) &&
      (picked.shift[0] !== 0 || picked.shift[1] !== 0) &&
      picked.shift.every(v => v >= 0 && v < 2),
      `shift ${picked.shift.join(',')}: ${purePixels(picked.plan, 2, s13, smallField)} pure vs ${purePixels(small, 2, s13, smallField)} where it stands`);

    // Whether a trial is searched is decided by the PIXELS it covers, never by
    // how many plots are drawn on them. A factor of plots/50 here once inverted
    // the budget it was meant to enforce: the denser of two trials over ONE
    // footprint was refused a search that the sparser one was granted and paid
    // for. The cost really is flat in plot count (one candidate over a fixed
    // 100 x 100 m at 0.5 m: 32 ms at 50 plots, 28 at 600), because a pixel's
    // work is the plot boundaries crossing THAT pixel.
    //
    // Plots do cost something, but ADDED (about two pixels each, for the
    // per-candidate shifting) rather than multiplied, so 200 of them cannot
    // decide whether a 900-pixel footprint is searched at all.
    //
    // An explicit small `budget` puts the two trials on either side of the old
    // factor's threshold while simulating only a few hundred pixels: with the
    // factor the 200-plot trial gets N = 1 and the 16-plot one N = 2; with the
    // additive term both get N = 2. A test at the default budget cannot see
    // this, because both land on N > 1 either way.
    const plotsOver = (n, tag) => {
      const cols = Math.ceil(Math.sqrt(n)), w = 48 / cols;
      return planOf(Array.from({ length: n }, (_, i) =>
        ({ rings: [boxRing(E0 + (i % cols) * w, N0 + (((i / cols) | 0) * w), w * 0.9, w * 0.9)], species: i % 4 })), 4, tag);
    };
    const sameField = [E0 - 6, N0 - 6, E0 + 54, N0 + 54];
    const fewPlots = stakeOnGrid(plotsOver(16, 'few'), 2, s13, sameField, 8000);
    const manyPlots = stakeOnGrid(plotsOver(200, 'many'), 2, s13, sameField, 8000);
    ok('the same footprint is searched whether 16 plots are drawn on it or 200',
      fewPlots.staked === true && manyPlots.staked === true,
      `16 plots staked=${fewPlots.staked}, 200 plots staked=${manyPlots.staked}`);
  }

  // ---- every other layout is untouched --------------------------------------
  {
    // A strip or block layout still goes through the fine grid, bit for bit:
    // only an imported trial takes the exact path.
    const res = 2, minE = 500040, minN = 4000060, nx = 24, ny = 18;
    const grid = { res, utmBounds: [minE, minN, minE + nx * res, minN + ny * res] };
    const origin = [minE - 3.25, minN + 1.5];
    const design = { nSpecies: 4, nBlocks: 3, plotLength: 12, plotWidth: 3, plotAlley: 0.5, blockAlley: 1.5, blocksPerRow: 2, seed: 5 };
    const layouts = [
      { pattern: 'row', width: 3, spacing: 0, rotationDeg: 0 },
      { pattern: 'col', width: 5, spacing: 1.5, rotationDeg: 17 },
      { pattern: 'checker', width: 4, spacing: 0, rotationDeg: 0 },
      { pattern: 'block', width: 3, spacing: 0, rotationDeg: 0, block: buildBlockPlan(design, blockPlacement(grid.utmBounds, origin, 0, res, true)) },
    ];
    let same = true, detail = '';
    for (const layout of layouts) {
      for (const sensor of [{ sigmaX: 0, sigmaY: 0, mixThreshold: 0.8 }, { sigmaX: 0.55, sigmaY: 0.55, mixThreshold: 0.95, offX: 0.3, offY: -0.2 }]) {
        const sim = simulateField(grid, origin, layout, sensor);
        const g = strideFor(res, minFeatureM(layout));
        const cropMap = buildCropMap(minE, minN, ny * g, nx * g, res / g, origin[0], origin[1], layout);
        const { coverSpecies, nSpecies } = speciesChannel(layout);
        const agg = aggregate(new Array(ny * g * nx * g).fill(new Float64Array(0)), ny * g, nx * g, g, sensor.sigmaX, sensor.sigmaY, true, 0, cropMap,
          sensor.mixThreshold, sensor.offX ?? 0, sensor.offY ?? 0, coverSpecies, nSpecies);
        const fields = sim.mixed.every((v, k) => v === agg.cropMapMixed[k]) &&
          sim.proportionA.every((v, k) => Object.is(v, agg.cropMapProportionA[k])) &&
          sim.proportionBare.every((v, k) => Object.is(v, agg.cropMapProportionBare[k])) &&
          sim.proportionBySpecies.every((v, k) => Object.is(v, agg.cropMapSpecies[k]));
        if (!fields && same) detail = `${layout.pattern} at sigma ${sensor.sigmaX}`;
        same = same && fields;
      }
    }
    ok('a strip or block layout is still the fine grid\'s own aggregation, bitwise', same, detail || '4 layouts x 2 sensors');
  }
}

console.log('\nH4. one blend in the codebase: mix3 is the two-species spelling of mixN');
{
  // mix3 paints the map's mixture overlay. It now delegates to mixN, so this
  // pins the reduction against the arithmetic it replaced: same weights, same
  // rounding, same hex. Without it "provably unchanged" is only an argument.
  const hexRgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix3Old = (pA, pB, pBare, colA, colB) => {
    const [aR, aG, aB] = hexRgb(colA), [bR, bG, bB] = hexRgb(colB), [sR, sG, sB] = hexRgb(BARE.color);
    const w = pA + pB + pBare || 1;
    const c = [(pA * aR + pB * bR + pBare * sR) / w, (pA * aG + pB * bG + pBare * sG) / w, (pA * aB + pB * bB + pBare * sB) / w];
    return `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  };
  let worst = '';
  const same = (() => {
    for (const colA of ['#e69f00', '#0072b2', '#999999'])
      for (const colB of ['#009e73', '#cc79a7', '#e69f00'])
        for (let a = 0; a <= 1.0001; a += 0.1)
          for (let b = 0; a + b <= 1.0001; b += 0.1) {
            const bare = Math.max(0, 1 - a - b);
            const got = mix3(a, b, bare, colA, colB), want = mix3Old(a, b, bare, colA, colB);
            if (got !== want) { worst = `${a.toFixed(1)}/${b.toFixed(1)}/${bare.toFixed(1)} ${colA}+${colB}: ${got} vs ${want}`; return false; }
          }
    return true;
  })();
  ok('mix3 through mixN is byte-identical to the blend it replaced', same, worst || 'swept 3 x 3 colours x 66 fraction splits');
  ok('mixN of one species at full cover is that species colour exactly',
    mixN([1], ['#e69f00']) === '#e69f00' && mixN([0, 1], ['#e69f00', '#0072b2']) === '#0072b2');
  ok('mixN weights four species evenly and stays inside the palette range',
    (() => {
      const c = mixN([0.25, 0.25, 0.25, 0.25], CROP_COLORS.slice(0, 4));
      return /^#[0-9a-f]{6}$/.test(c) && c !== CROP_COLORS[0];
    })());
  ok('off-trial ground darkens a pixel without being counted as a species',
    mixN([1], ['#e69f00'], 0, 0) === '#e69f00' && mixN([1], ['#e69f00'], 0, 1) !== '#e69f00');

  // Two species on the same preset must not be drawn identically.
  // The duplicate must move onto a colour NOBODY wants: filling from the first
  // merely-unused colour hands it one a later species asked for, which then
  // gets bumped in turn, and every species after it shifts by one.
  const picked = distinctColors(['#e69f00', '#e69f00', '#0072b2'], CROP_COLORS);
  ok('a duplicate moves aside without stealing a colour a later species asked for',
    picked[0] === '#e69f00' && picked[2] === '#0072b2' &&
    picked[1] !== '#e69f00' && picked[1] !== '#0072b2' &&
    new Set(picked.map(c => c.toLowerCase())).size === 3, picked.join(' '));
  ok('and the species that asked first keeps the colour, whatever its position',
    (() => {
      const p = distinctColors(['#0072b2', '#e69f00', '#0072b2', '#e69f00'], CROP_COLORS);
      return p[0] === '#0072b2' && p[1] === '#e69f00' &&
             p[2] !== '#0072b2' && p[3] !== '#e69f00' &&
             new Set(p.map(c => c.toLowerCase())).size === 4;
    })());
  ok('and leaves an already-distinct set untouched',
    distinctColors(CROP_COLORS.slice(0, 5), CROP_COLORS).join(',') === CROP_COLORS.slice(0, 5).join(','));
  ok('the palette carries one colour per species up to the eight-species cap',
    CROP_COLORS.length === 8 && new Set(CROP_COLORS).size === 8);
}

console.log('\nI. field purity: the documented 50% → 100% phase case');
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
  ok('the mean crop-A fraction is unchanged by the phase, only its packing moves',
    Math.abs(on.meanPropA - off.meanPropA) < 1e-6, `${on.meanPropA.toFixed(4)} vs ${off.meanPropA.toFixed(4)}`);
  ok('the per-pixel arrays are one entry per grid cell',
    [on.proportionA, on.proportionBare, on.mixed].every(a => a.length === grid.cells.length));

  // bestPhaseOffset must find the 5 m shift that puts the edges back on the lattice.
  const [du, dv] = bestPhaseOffset('col', 10, 20, 0, 0.8, minE + 5, minN);
  ok('the search only moves the striping axis', dv === 0 && du > 0);
  // The score is flat across every shift that keeps all 16 sub-samples of a
  // pixel inside one strip, and the search keeps the FIRST maximiser, so it
  // stops just short of the exact 5 m: anywhere in that plateau aligns.
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

  // The PSF is set in step 2 but consumed here, a coupling a refactor must keep.
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
  // not: divisibility beats fineness. The UI's sweep chart is meant to show this.
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
  ok('an unclipped export declares the grid\'s full snapped UTM extent',
    [0, 1, 2, 3].every(i => sv.getFloat64(36 + 8 * i, true) === grid.utmBounds[i]),
    grid.utmBounds.join(','));

  // A field-clipped export writes only the pixels inside the traced shape, so
  // the declared extent has to shrink with them. GIS software reads this header
  // for "zoom to layer", and it used to describe the whole drawn box however
  // little of it the file covered.
  const keep = grid.cells.filter(c => c.east < grid.utmBounds[0] + 20 && c.north < grid.utmBounds[1] + 20);
  const cbuf = new Uint8Array(await gridToShapefileZip({ ...grid, cells: keep }, 'clipped').arrayBuffer());
  const cdv = new DataView(cbuf.buffer);
  const cfiles = new Map();
  let coff = 0;
  while (coff + 4 <= cbuf.length && cdv.getUint32(coff, true) === 0x04034b50) {
    const size = cdv.getUint32(coff + 18, true);
    const nlen = cdv.getUint16(coff + 26, true), elen = cdv.getUint16(coff + 28, true);
    const name = String.fromCharCode(...cbuf.slice(coff + 30, coff + 30 + nlen));
    cfiles.set(name, cbuf.slice(coff + 30 + nlen + elen, coff + 30 + nlen + elen + size));
    coff += 30 + nlen + elen + size;
  }
  const cshp = cfiles.get('clipped.shp');
  const csv = new DataView(cshp.buffer, cshp.byteOffset, cshp.byteLength);
  const want = [
    Math.min(...keep.map(c => c.east)), Math.min(...keep.map(c => c.north)),
    Math.max(...keep.map(c => c.east)) + 10, Math.max(...keep.map(c => c.north)) + 10,
  ];
  ok('a clipped export declares the extent of the pixels it actually contains',
    keep.length > 0 && [0, 1, 2, 3].every(i => csv.getFloat64(36 + 8 * i, true) === want[i]),
    `${[0, 1, 2, 3].map(i => csv.getFloat64(36 + 8 * i, true)).join(',')} vs ${want.join(',')}`);
  ok('and that extent is smaller than the whole drawn box',
    want[2] - want[0] < grid.utmBounds[2] - grid.utmBounds[0],
    `${want[2] - want[0]} m wide vs the box's ${grid.utmBounds[2] - grid.utmBounds[0]} m`);
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
  // ESRI/GDAL parse it fine, noted so a refactor does not "fix" it by accident.
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

console.log('\nH13b. a ladder rung is measured in its own placement, not the adopted one');
{
  // The comparison's two ladders are two PLACEMENTS of one trial, and the page
  // lets the user adopt either. A rung has to report the same purity whichever
  // one is adopted, or the act of choosing changes the numbers the choice was
  // made on. It failed twice, for two different reasons, and both are here.
  //
  // (1) The rung's outer box came from the FIELD, and the field is the outline
  // of whatever placement is adopted. Measuring the other placement inside it
  // cut that trial's corners off: the same rung read 10,445 trial pixels where
  // it had read 11,037.
  const sensorB = { sigmaX: 0.62, sigmaY: 0.62, mixThreshold: 0.9 };
  const E0 = 500000, N0 = 4000000, epsgB = 32631;
  const planB = (plots, nSpecies, tag) => {
    const all = plots.flatMap(p => p.rings.flat());
    return { epsg: epsgB, plots, coverSpecies: Uint8Array.from(plots, p => p.species), plotIds: true, nSpecies,
      footprint: convexHull(all),
      bbox: [Math.min(...all.map(q => q[0])), Math.min(...all.map(q => q[1])), Math.max(...all.map(q => q[0])), Math.max(...all.map(q => q[1]))],
      minFeature: 1, sig: `h13b-${tag}` };
  };
  const UNCLIPPED = [-Infinity, -Infinity, Infinity, Infinity];
  // The other placement's own box, snapped, with no room to spare: this is what
  // the field's envelope amounts to once the aligned placement has been adopted.
  const boxOf = (plan, r) => {
    const [a, b, c, d] = plan.bbox;
    return [Math.floor(a / r) * r, Math.floor(b / r) * r, Math.ceil(c / r) * r, Math.ceil(d / r) * r];
  };
  const tilted = planB(Array.from({ length: 24 }, (_, i) => {
    const t = 11.6 * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t);
    const X = (i % 6) * 12, Y = ((i / 6) | 0) * 9;
    const ring = [[0, 0], [10, 0], [10, 7], [0, 7]].map(([dx, dy]) =>
      [E0 + (X + dx) * cs - (Y + dy) * sn, N0 + (X + dx) * sn + (Y + dy) * cs]);
    ring.push(ring[0]);
    return { rings: [ring], species: i % 4 };
  }), 4, 'tilted');
  const straight = rotateImportedPlan(tilted, -11.6);

  const moved = [];
  for (const r of [1, 2, 3]) {
    // What the page measures now: the trial's own widened box, clamped by
    // nothing, so the same rung answers the same whichever placement is adopted.
    const own = importedTrialExtent(tilted, r, sensorB, UNCLIPPED);
    const [a, b, c, d] = tilted.bbox;
    ok(`at ${r} m the tilted trial is measured over its OWN box, not a field's`,
      own[0] <= Math.floor(a / r) * r && own[1] <= Math.floor(b / r) * r &&
      own[2] >= Math.ceil(c / r) * r && own[3] >= Math.ceil(d / r) * r, own.join());
    // What it used to do once the aligned placement had been adopted: the field
    // was that placement's outline, and the tilted trial was measured inside it.
    const clipped = importedTrialExtent(tilted, r, sensorB, boxOf(straight, r));
    ok(`... and measuring it inside the ALIGNED hull really would cut it, at ${r} m`,
      clipped.join() !== own.join(), `${clipped.join()} vs ${own.join()}`);
    moved.push([r, purePixels(tilted, r, sensorB, clipped), purePixels(tilted, r, sensorB, own)]);
  }
  // Not "always lower": a smaller window drops edge pixels, and at a coarse size
  // where the trial is barely a pixel per plot that can go either way. The point
  // is that the number MOVES, which is what a click must never do to it.
  ok('and a rung\'s purity really does move when it is measured in the wrong hull',
    moved.some(([, cut, full]) => cut !== full),
    moved.map(([r, cut, full]) => `${r} m: ${cut} vs ${full}`).join(', '));

  // (2) The comparison rung re-stakes at every size, and that must not depend on
  // where the design happens to sit: staking the aligned plan is a function of
  // the plan and the pixel size, nothing else.
  const a1 = stakeOnGrid(straight, 2, sensorB, importedTrialExtent(straight, 2, sensorB, UNCLIPPED));
  const a2 = stakeOnGrid(straight, 2, sensorB, importedTrialExtent(straight, 2, sensorB, UNCLIPPED));
  ok('staking the aligned placement is reproducible, so its ladder cannot drift',
    a1.shift.join() === a2.shift.join() &&
    purePixels(a1.plan, 2, sensorB, importedTrialExtent(a1.plan, 2, sensorB, UNCLIPPED)) ===
    purePixels(a2.plan, 2, sensorB, importedTrialExtent(a2.plan, 2, sensorB, UNCLIPPED)),
    `shift ${a1.shift.join()}`);
}

console.log('\nH14. the two rules the resolution ladder is built on');
{
  // ladderKey and rungCellOrigin (ladder-rung.ts) were both inside a React hook,
  // where nothing could reach them, and both had already been wrong once: the
  // ladder rebuilt itself on every thumbnail click, and a second copy of the
  // pixel-origin formula could hand a pixel's season to its neighbour.
  const design = { nSpecies: 4, nBlocks: 4, plotLength: 8, plotWidth: 2, plotAlley: 0.5, blockAlley: 1.5, blocksPerRow: 1, seed: 1 };
  const bounds = [600000, 5600000, 600300, 5600300], base = [600000, 5600000];
  // Angle 0: that is when a block plan is SNAPPED to the pixel lattice, so its
  // corner really does follow the pixel size (a turned trial is not snapped).
  const layoutAt = (r, d = design) => ({
    pattern: 'block', width: 3, spacing: 0, rotationDeg: 0,
    block: buildBlockPlan(d, blockPlacement(bounds, base, 0, r, true)),
  });
  const keys = RES_LADDER.map(r => ladderKey(layoutAt(r)));
  ok('one ladder key across every rung, so finished rungs survive a thumbnail click',
    new Set(keys).size === 1, `${new Set(keys).size} distinct`);
  const corners = new Set(RES_LADDER.map(r => `${layoutAt(r).block.u0},${layoutAt(r).block.v0}`));
  ok('and the key is not constant by accident: each rung snaps the plan to its own lattice',
    corners.size > 1, `${corners.size} distinct corners`);
  let allMove = true, missed = '';
  for (const k of Object.keys(design)) {
    const moved = { ...design, [k]: design[k] + 1 };
    if (ladderKey(layoutAt(2, moved)) === ladderKey(layoutAt(2))) { allMove = false; missed += ' ' + k; }
  }
  ok('every field of the design moves the key, so no rung is reused for a different trial', allMove, missed);
  ok('the strip angle moves it too', ladderKey({ ...layoutAt(2), rotationDeg: 12 }) !== ladderKey(layoutAt(2)));
  ok('a layout with no block plan keys on its own fields',
    ladderKey({ pattern: 'row', width: 3, spacing: 0, rotationDeg: 0 }) !==
    ladderKey({ pattern: 'row', width: 4, spacing: 0, rotationDeg: 0 }));

  // Row by row from the SOUTH, west to east: the order simulateField fills.
  ok('rung cell 0 is the south-west corner', String(rungCellOrigin(0, 10, 100, 200, 2)) === '100,200');
  ok('rung cell 9 is the east end of the first row', String(rungCellOrigin(9, 10, 100, 200, 2)) === '118,200');
  ok('rung cell 10 starts the row above', String(rungCellOrigin(10, 10, 100, 200, 2)) === '100,202');
  // and it is the formula H11 already pins the simulation against
  const r = 2, nx = 7;
  ok('it is the formula the rest of the ladder reads pixel identities with',
    Array.from({ length: nx * 3 }, (_, k) => String(rungCellOrigin(k, nx, 100, 200, r)))
      .every((v, k) => v === `${100 + (k % nx) * r},${200 + Math.floor(k / nx) * r}`));
}

console.log('\n' + (bad ? `${bad} FAILURE(S)` : 'ALL PIXEL-GRID CHECKS PASSED'));
process.exit(bad ? 1 : 0);
