import proj4 from 'proj4';
import { convexHull } from './imported-plan';
import type { ImportedDesign, LngLat } from './imported-types';
import { SOURCES } from './sensors';

/**
 * The worked examples of the documentation page, as settings of the designer.
 *
 * "for each example add a button open this example and it opens the example in
 * the app with these exact settings" (2026-11-23). Each example of
 * pixel-grid-docs.html has a link to `pixel-grid.html?example=ID`; persist.ts
 * reads the id and starts the page from `seed`, in a store of its own, so
 * opening an example never touches what the visitor had set in the designer.
 *
 * The documentation's numbers are worked out by scripts/docs-figures.mjs from
 * THESE objects (the field, the designs, the made-up trial file), and it stops
 * when one of them is not what an example is computed with. So what the link
 * opens is what the page describes.
 *
 * A seed is written under the names persist.ts saves by (the first argument
 * of each usePersistentState), and must pass that state's own validator:
 * anything that does not is dropped for the default, like any saved value.
 */

/** The south-west corner of the examples' field, UTM 31N: deliberately not on whole pixels. */
export const EXAMPLE_E0 = 619203.7;
export const EXAMPLE_N0 = 5600764.3;
export const EXAMPLE_EPSG = 32631;
const toLL = proj4('+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs', 'EPSG:4326');
const ll = (e: number, n: number): LngLat => toLL.forward([e, n]) as LngLat;

/** A field of `u` by `v` metres (east, north) from that corner, as the page keeps one: [west, south, east, north]. */
export function exampleField(u: number, v: number): [number, number, number, number] {
  const [w, s] = ll(EXAMPLE_E0, EXAMPLE_N0), [e, n] = ll(EXAMPLE_E0 + u, EXAMPLE_N0 + v);
  return [w, s, e, n];
}
/** A square field of `side` metres from that corner. */
export const exampleBox = (side: number) => exampleField(side, side);
/** The fields of the two examples that start from a field: the coarsest satellite for it, and the most repetitions in it. */
export const FIT_FIELD: [number, number] = [250, 250];
export const REPS_FIELD: [number, number] = [300, 200];
const viewOn = (e: number, n: number, zoom: number) => { const c = ll(e, n); return { center: [c[1], c[0]] as [number, number], zoom }; };
const boxView = (side: number, zoom = 17) => viewOn(EXAMPLE_E0 + side / 2, EXAMPLE_N0 + side / 2, zoom);

/** A made-up trial as its file would be read: 24 plots of 50 x 40 m, 6 varieties in 4 repetitions, at 17 degrees. */
export function exampleTrialFile(): ImportedDesign {
  const ANG = 17, A = 50, B = 40, names = ['Alba', 'Brio', 'Cora', 'Dune', 'Elan', 'Faro'];
  const order = [[0, 1, 2, 3, 4, 5], [3, 5, 0, 2, 1, 4], [4, 2, 5, 1, 3, 0], [1, 4, 3, 0, 5, 2]];
  const rad = (ANG * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad), f0 = [EXAMPLE_E0 + 100, EXAMPLE_N0 + 100];
  const design: ImportedDesign = { fileName: 'trial.geojson', columns: ['Plot', 'Variety'], varietyColumn: 'Variety', nameColumn: 'Plot', warnings: [], plots: [] };
  for (let b = 0; b < order.length; b++) for (let k = 0; k < names.length; k++) {
    const ring = [[b * A, k * B], [b * A + A, k * B], [b * A + A, k * B + B], [b * A, k * B + B]]
      .map(([u, v]) => ll(f0[0] + u * cos - v * sin, f0[1] + u * sin + v * cos));
    design.plots.push({ rings: [ring], props: { Plot: String(b * names.length + k + 1), Variety: names[order[b][k]] } });
  }
  return design;
}

export interface DocExample {
  /** The value of `?example=`, and the end of the documentation's anchor `ex-ID`. */
  id: string;
  seed: Record<string, unknown>;
}

const psfOf = (id: string) => SOURCES.find(s => s.id === id)!.psf;
/** What every example starts from: Sentinel-2's 10 m bands, 90 % purity, each satellite's CE90 as delivered, placed for the pixels that hold. */
const common = (sat = 's2-10') => ({
  sourceId: sat, gsd: SOURCES.find(s => s.id === sat)!.res, sigmaX: psfOf(sat), sigmaY: psfOf(sat),
  threshold: 90, geoTyped: false, geoErrM: 0, placeFor: 'held',
  rotation: 0, activeStep: 'sim', showPure: true, showField: false, showSigmas: false, showSources: false, fieldOnly: false,
  compareAligned: false, ladderView: 'table',
  suggestAsk: { species: 4, reps: 4, sat: '', hold: true, plotAlley: 0, blockAlley: 0 },
});
/** 4 species in 4 blocks of square plots that touch, one row of blocks: what Suggest a design builds for 4 pixels per plot. */
const blocks = (side: number) => ({ nSpecies: 4, nBlocks: 4, plotLength: side, plotWidth: side, plotAlley: 0, blockAlley: 0, blocksPerRow: 4, seed: 1 });
/** The margin the documentation leaves around a block trial: 60 m on each side. */
const fieldOf = (side: number) => 4 * side + 120;

const file = exampleTrialFile();
const hull = convexHull(file.plots.flatMap(p => p.rings.flat()));
const hullBox = (): [number, number, number, number] => {
  const xs = hull.map(p => p[0]), ys = hull.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** What Suggest a design is asked in the examples: 4 species, 4 pixels per plot that hold, no alleys. */
const asked = (more: Record<string, unknown>) => ({ species: 4, reps: 4, sat: '', hold: true, plotAlley: 0, blockAlley: 0, ...more });
const fieldView = ([u, v]: [number, number]) => viewOn(EXAMPLE_E0 + u / 2, EXAMPLE_N0 + v / 2, 17);

/**
 * The four examples (2026-11-25: "1 import trial, one suggest design with area
 * constraint and one design trial with sattelite constrained", "and one with
 * both sattelite and area constrained where you give the max number of
 * repetition that can fit"). The two that start from a field open on Suggest
 * a design, set to answer, so that Build gives what the page describes.
 */
export const DOC_EXAMPLES: DocExample[] = [
  // 1. An existing trial: the made-up file, compared with its best placement for every satellite.
  { id: 'file', seed: { ...common(), pattern: 'imported', importedDesign: file, importedTurn: 0, importedShift: [0, 0], aoiPoly: hull, aoi: hullBox(), showField: true,
    activeStep: 'pca', compareAligned: true, view: viewOn(EXAMPLE_E0 + 100 + 65, EXAMPLE_N0 + 100 + 145, 17) } },
  // 2. A field, and no satellite: the coarsest satellite whose trial fits it.
  { id: 'fit', seed: { ...common(), pattern: 'block', blockDesign: blocks(40), wantPure: 4, simFold: 'suggest', aoi: exampleField(...FIT_FIELD), aoiPoly: null, view: fieldView(FIT_FIELD),
    suggestAsk: asked({ sat: 'fit' }) } },
  // 3. A satellite, Sentinel-2: the trial built for 4 pixels that hold per plot.
  { id: 'varieties', seed: { ...common(), pattern: 'block', blockDesign: blocks(40), wantPure: 4, simFold: 'sat', aoi: exampleBox(fieldOf(40)), aoiPoly: null, view: boxView(fieldOf(40)) } },
  // 4. A satellite and a field: the most repetitions that fit.
  { id: 'reps', seed: { ...common(), pattern: 'block', blockDesign: blocks(40), wantPure: 4, simFold: 'suggest', aoi: exampleField(...REPS_FIELD), aoiPoly: null, view: fieldView(REPS_FIELD),
    suggestAsk: asked({ sat: 's2-10', repsMax: true }) } },
];

/** The example a page address asks for (`?example=ID`), or null. */
export function exampleFromSearch(search: string): DocExample | null {
  try {
    const id = new URLSearchParams(search).get('example');
    return DOC_EXAMPLES.find(e => e.id === id) ?? null;
  } catch {
    return null;
  }
}
