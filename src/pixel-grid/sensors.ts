import { EARTH_SEARCH_URL, type SourceConfig } from './s2-grid';
import { ce90For } from './resolving';

/**
 * The satellites the tool can put a grid over, and what each one's optics do to
 * a sharp edge on the ground.
 *
 * Two families, and the difference is the whole point of the page. A `catalog`
 * source has a REAL, time-invariant pixel lattice that is read from product
 * metadata: you align your plots to it. A `custom` source is tasked and agile:
 * each image comes on a grid of its own, there is no lattice to plant against,
 * and the note counts what a trial keeps at the worst position on it
 * (Rung.anyPosition, and simulate.ts SensorParams.anyPosition). The grid drawn
 * for one is a grid to ask the provider for, and a count on it is no promise.
 *
 * Every `psf` is a Gaussian sigma in PIXELS, and it comes from one of two
 * places, which `psfSrc` names:
 *
 *  MEASURED. Sentinel-2, PlanetScope, WorldView-2 and Pleiades carry a FWHM
 *    fitted on real images of the PHENET trials at Mauguio and Toulouse, by
 *    blurring a very-high-resolution reference of the same scene onto the
 *    sensor's grid. That fit already contains the detector footprint, the
 *    motion blur and the residual atmosphere, so nothing is added on top.
 *    sigma = FWHM / 2.3548 / GSD, from the FWHM itself (`measured`), not from
 *    a sigma kept to two decimals: 0.59 pixels for Sentinel-2 is a FWHM of
 *    13.9 m, and the note's figure is 14. These are the figures to trust: a published
 *    MTF describes the instrument, this describes the product as delivered,
 *    and for the tasked sensors the two differ by a factor of two to four.
 *
 *  PUBLISHED. The rest keep sigma = sqrt(-2 ln M) / pi from the sensor's MTF
 *    at Nyquist, M = MTF(1/2), taking the BLURRIEST end of each published
 *    range so the purity numbers are conservative rather than flattering.
 *
 * A pansharpened product is sharp only SPATIALLY, borrowed from the
 * panchromatic band. An index like LAI is computed on the native multispectral
 * bands, so for trial design it is the native MS row that counts.
 */

/**
 * Where a satellite's pixel EDGES fall, as [east, north] in metres modulo its
 * pixel, in the UTM frame `epsg`.
 *
 * Every fixed grid here is laid on whole multiples of its pixel counted from
 * the zone's origin and the EQUATOR, except native Landsat, whose coordinates
 * name pixel centres: its edges sit half a pixel off (15 m mod 30, read off
 * live product metadata, suite section E). A southern UTM frame (327xx) counts
 * northings from 10 000 000 m south of that, which is not a multiple of 30 or
 * 60: the same lattices read 10 m (HLS), 25 m (Landsat) and 40 m (Sentinel-2
 * at 60 m) there.
 *
 * A tasked sensor has no lattice of its own (the grid is the one asked for),
 * so it reads [0, 0], and so does anything unknown.
 */
export function latticePhase(sourceId: string, res: number, epsg: number): [number, number] {
  const src = SOURCES.find(s => s.id === sourceId);
  if (!src || src.kind !== 'catalog' || !(res > 0)) return [0, 0];
  const half = sourceId === 'ls-30' ? res / 2 : 0;
  const south = epsg >= 32701 && epsg <= 32760;
  const mod = (v: number) => ((v % res) + res) % res;
  return [mod(half), mod(half + (south ? 10_000_000 : 0))];
}

/**
 * The pixel size the DEFAULT geolocation error is a third of (resolving.ts
 * ce90For), for one satellite's rung.
 *
 * The note's default follows the pixel: with nothing known, a third of it. One
 * thing is known, though: Sentinel-2's 20 m and 60 m bands are the same
 * instrument on the same platform as its 10 m bands, registered with them, so
 * an image lands in the same place whichever band is read. Taken from their
 * own pixel, the default gave the 20 m bands a CE90 of 14.3 m and the 60 m ones
 * 42.9 m, two and six times the 10 m bands' 7.15 m (found by an outside review,
 * 2026-11-22). ESA's own figure for the product is a CE90 of about 6.9 m
 * (GEO_S2), which is that 7.15 m.
 */
export function geolocRes(sourceId: string, res: number): number {
  return sourceId.startsWith('s2-') ? Math.min(res, 10) : res;
}

/**
 * How a geolocation error is set. The page knows two ways:
 *  `provider`: every satellite takes the figure its own provider states for an
 *    image as delivered (`geo`), and a sensor of one's own none at all;
 *  neither flag: `manualM`, a figure typed, for every satellite alike.
 * `auto` is the PHENET note's own rule, a third of a pixel for every sensor.
 * The page does not offer it any more ("since we have delivered values for
 * ce 90 for all sattelite i think we can remove all mentions of the default
 * one", 2026-11-22); it is kept for whoever calls the engine with the note's
 * assumption, as the note's own figures and the regression suite do.
 */
export interface GeoSetting { auto: boolean; manualM: number; provider?: boolean }

/**
 * The CE90 in force for ONE satellite at one pixel size: the single place the
 * table, the map, the suggestions and the panel read it from.
 *
 * "As delivered" is a mode and not a figure typed in: the first version put
 * the selected satellite's figure into the typed one, and Pleiades' 8.5 m then
 * stayed on every row of the table and on whichever satellite was picked next
 * (found by an outside review, 2026-11-22).
 */
export function sourceCe90(sourceId: string, res: number, geo: GeoSetting): number {
  // As delivered: the provider's own figure. A sensor of one's own has no provider and no figure: none is held
  // against it until one is typed. (It used to fall back on a third of the pixel, the note's rule for a sensor
  // nothing is known of. The page no longer offers that rule: every satellite of the list has a figure.)
  if (geo.provider) return SOURCES.find(s => s.id === sourceId)?.geo?.ce90M ?? 0;
  return ce90For(geo.auto, geo.manualM, geolocRes(sourceId, res));
}

/** Sensor pixels the PCA samples when the full field is too fine to render. */
const PCA_SAMPLE = 2500;
/** Pixel sizes (m) compared side-by-side in the resolution sweep. */
const RES_LADDER = [0.5, 1, 2, 3, 4, 5, 6, 8, 10];

interface Source {
  id: string;
  /** The name that fits a narrow table: the ladder's row for this satellite. */
  short: string;
  provider: string;
  resLabel: string;
  res: number;
  /** 'catalog' = read the real fixed grid live; 'custom' = tasked, or a sensor of one's own: no grid is known before the image. */
  kind: 'catalog' | 'custom';
  group: string;
  note: string;
  /**
   * Default Gaussian PSF σ, in PIXELS, from each sensor's published MTF at Nyquist
   * via a Gaussian model: MTF(½) = exp(−π²σ²/2) ⇒ σ = √(−2·ln M)/π.
   * S2 MSI spec M≈0.15–0.3 (→σ≈0.53 at 0.25); Landsat OLI M≈0.30 (σ≈0.49);
   * Pléiades PAN M≈0.17 (σ≈0.60, products MTF-sharpened → ~0.55); CubeSats/PlanetScope
   * are softer (larger effective GRD than GSD → σ≈0.6). Both axes use this value.
   */
  psf: number;
  /** Where the MTF/PSF figure comes from (shown as a link when it has a url). */
  psfSrc?: { url?: string; label: string };
  /**
   * True when `psf` was fitted on real imagery rather than read off a published
   * MTF. It changes what the blur budget may claim: a fit on an image already
   * contains the detector footprint and the motion blur, so adding a separate
   * pixel box on top counts the detector twice.
   */
  psfMeasured?: boolean;
  /**
   * True when no published MTF value was found for the sensor (checked
   * 2026-11-23: the eoPortal pages of SkySat and SPOT 6/7 describe the
   * instruments and give no MTF). `psf` is then an ASSUMED MTF at Nyquist,
   * 0.15 to 0.17, and the page says "assumed", not "published MTF".
   */
  psfAssumed?: boolean;
  /**
   * What the PROVIDER states about where an image lands AS DELIVERED, with no
   * ground control of the user's, as a CE90 in metres. `says` is the provider's
   * own figure where it is given in another measure (an RMSE, a 95 % radius).
   *
   * It is NOT the page's default. The default is the PHENET note's third of a
   * pixel (resolving.ts ce90For), which the note calls typical of a
   * well-registered product and no more than that; these are several pixels
   * wide on every tasked sensor, and no plot of a trial holds a pixel against
   * them. Which of the two a reader's images are like is the reader's to say.
   * The panel shows the figure beside the default, a click away, so that
   * whoever reads an image as delivered can size for it.
   */
  geo?: { ce90M: number; says: string; label: string; url?: string };
  /** Grid lattice phase is 0, so a rule-based offline grid is still exact (catalog only). */
  offlinePhase0?: boolean;
  /**
   * Which lattice an OFFLINE grid must use south of the equator, because the two
   * products are distributed differently and the default rule fits neither:
   *
   *  'false-northing' is Sentinel-2: southern CRS (327xx). Its false northing,
   *    10 000 000 m, is not a multiple of 60, so anchoring on 0 misses the real
   *    60 m lattice by 20 m. Anchor on the false northing instead.
   *  'north-crs' is HLS: keeps the NORTHERN CRS (326xx) with negative northings
   *    south of the equator, so the offline grid must be built there too;
   *    building it in the southern CRS misses the 30 m lattice by 10 m.
   *
   * Both measured against live product metadata at two southern sites; north of
   * the equator every source is exact either way and this is not consulted.
   */
  offlineSouth?: 'false-northing' | 'north-crs';
  cfg?: SourceConfig;
}

const FIXED = 'Fixed grid: read live from the catalog';
const TASK = 'Commercial, tasked: the grid falls where the image does';
const s2Label = (it: any) => it.properties?.['s2:mgrs_tile'] ?? '';
/** Earth Search writes the same tile as "MGRS-31UFS" and keeps the pixel origin on the red band. */
const esS2Label = (it: any) => String(it.properties?.['grid:code'] ?? '').replace(/^MGRS-/, '');
const esS2 = (res: number) => ({ collection: 'sentinel-2-l2a', asset: 'red', res, gridLabel: esS2Label, url: EARTH_SEARCH_URL });
const lsLabel = (it: any) => { const e = it.properties?.['proj:epsg']; return e >= 32700 ? `${e - 32700}S` : `${e - 32600}N`; };
// Where each sensor's MTF/PSF figure is documented.
const SRC_S2 = { url: 'https://sentiwiki.copernicus.eu/web/s2-mission', label: 'ESA SentiWiki' };
const SRC_LS = { url: 'https://www.usgs.gov/landsat-missions/spatial-performance-landsat-8-instruments', label: 'USGS · Landsat 8 spatial performance' };
const eo = (slug: string) => ({ url: `https://www.eoportal.org/satellite-missions/${slug}`, label: 'eoPortal' });
const SRC_PLANET = { url: 'https://www.tandfonline.com/doi/full/10.1080/01431161.2024.2357839', label: 'SuperDove vs Landsat 8 (2024)' };
/**
 * A provider's accuracy in another measure, as a CE90, for a circular normal
 * error of sigma per axis: the radial RMSE is sigma sqrt(2) and the radius
 * holding a share p of the errors is sigma sqrt(-2 ln(1 - p)).
 */
const rmseToCe90 = (rmse: number): number => Math.round(rmse * Math.sqrt(Math.LN10) * 10) / 10;
const radiusToCe90 = (radius: number, share: number): number => Math.round(radius * Math.sqrt(Math.LN10 / -Math.log(1 - share)) * 10) / 10;
/** Every figure below was read at the page linked, 2026-11-22. */
const GEO_S2 = { ce90M: radiusToCe90(8, 0.955), says: 'better than 8 m for 95.5 % of products, since the 2021 refinement on the Global Reference Image',
  label: 'ESA Data Quality Reports, quoted by CESBIO', url: 'https://www.cesbio.cnrs.fr/multitemp/a-first-peek-at-new-sentinel2-geometric-processing/' };
const GEO_LS = { ce90M: rmseToCe90(12), says: 'Tier 1 scenes: 12 m RMSE or better',
  label: 'USGS, in the Earth Engine catalog', url: 'https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LC08_C02_T1' };
const GEO_WV = { ce90M: 3.5, says: 'demonstrated under 3.5 m CE90 without ground control',
  label: 'DigitalGlobe data sheet', url: 'https://www.mass.gov/doc/digital-globe-worldview-2-data-sheet-0/download' };
const GEO_AIRBUS = 'https://cnig.gouv.fr/IMG/documents_wordpress/2017/02/ADS_geopos_CNIG.pdf';
const GEO_PLEIADES = { ce90M: 8.5, says: 'under 8.5 m CE90 at 30 degrees without ground control', label: 'Airbus DS (2016)', url: GEO_AIRBUS };
const GEO_SPOT = { ce90M: 15, says: 'under 15 m CE90 at 30 degrees without ground control', label: 'Airbus DS (2016)', url: GEO_AIRBUS };
const GEO_PLANET = { ce90M: rmseToCe90(10), says: 'ortho products: less than 10 m RMSE',
  label: 'Planet product specification (2018)', url: 'https://assets.planet.com/docs/Combined-Imagery-Product-Spec-Dec-2018.pdf' };

/**
 * Fitted on the PHENET images themselves, NIR band: the FWHM the note's model
 * uses (14, 11.8, 5, 3, 2.0 and 1.1 m). No url: the note is not published, and
 * inventing a link for a number this load-bearing would be worse than saying
 * plainly where it was measured.
 *
 * Aligned with the note's newer version on 2026-11-24 ("align the designer with
 * the new note"): WorldView-2 native 1.9 -> 2.0 m and PlanetScope 9.7 -> 11.8 m.
 * Each is the FWHM fitted with the image allowed to move (1.67 and 11.4 m), with
 * the blur of the sharp reference it was fitted against added back in quadrature
 * (1.06 m for the WorldView-2 panchromatic band, 3.0 m for pansharpened Pleiades):
 * sqrt(1.67^2 + 1.06^2) = 2.0, sqrt(11.4^2 + 3.0^2) = 11.8.
 *
 * The note is not of one mind about Pleiades' native bands: its tables carry
 * 5 m, and its Appendix C, which fits each band on its own, gives 5.7 to
 * 6.1 m. The tables' figure is the one every other figure of the note is
 * worked out from, and the one kept here.
 */
const SRC_PHENET = { label: 'measured on PHENET images at Mauguio and Toulouse' };
/** A Gaussian's full width at half maximum, in its standard deviations: the note's K. */
const FWHM_PER_SIGMA = 2.3548;
/** A measured FWHM in metres as a sigma in pixels of `res` metres. */
const measured = (fwhmM: number, res: number): number => fwhmM / FWHM_PER_SIGMA / res;
/*
 * Pansharpened rows: sharp only in the panchromatic band, while an index is
 * computed on the native multispectral bands. The two the note measured
 * (WorldView-2, Pleiades) have a native row to size a trial on, and the
 * default geolocation error is too kind for them (about 1 m measured between
 * images); SkySat and SPOT have no native row and no measured blur. All of it
 * is said on the documentation page ("Pansharpened products"), which the
 * suite holds against this list.
 */
const SOURCES: Source[] = [
  { id: 's2-10', short: 'Sentinel-2', provider: 'Sentinel-2', resLabel: '10 m', res: 10, kind: 'catalog', group: FIXED, offlinePhase0: true, offlineSouth: 'false-northing', psf: measured(14, 10), psfSrc: SRC_PHENET, psfMeasured: true, geo: GEO_S2,
    note: 'Blue, green, red and NIR bands: B02, B03, B04, B08.',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 10, gridLabel: s2Label, alt: esS2(10) } },
  { id: 's2-20', short: 'Sentinel-2', provider: 'Sentinel-2', resLabel: '20 m', res: 20, kind: 'catalog', group: FIXED, offlinePhase0: true, offlineSouth: 'false-northing', psf: 0.62, psfSrc: SRC_S2, geo: GEO_S2,
    note: 'Red-edge and SWIR bands: B05 to B07, B8A, B11, B12.',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 20, gridLabel: s2Label, alt: esS2(20) } },
  { id: 's2-60', short: 'Sentinel-2', provider: 'Sentinel-2', resLabel: '60 m', res: 60, kind: 'catalog', group: FIXED, offlinePhase0: true, offlineSouth: 'false-northing', psf: 0.62, psfSrc: SRC_S2, geo: GEO_S2,
    note: 'Aerosol and cirrus bands: B01, B09, B10.',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 60, gridLabel: s2Label, alt: esS2(60) } },
  { id: 'hls-30', short: 'Landsat HLS', provider: 'Landsat · HLS', resLabel: '30 m', res: 30, kind: 'catalog', group: FIXED, offlinePhase0: true, offlineSouth: 'north-crs', psf: 0.55, psfSrc: SRC_LS, geo: GEO_LS,
    note: 'Landsat and Sentinel-2 on one shared 30 m grid.',
    cfg: { collection: 'hls2-s30', asset: null, res: 30,
      gridLabel: it => (it.id?.split('.')?.[2] ?? '').replace(/^T/, '') } },
  { id: 'ls-30', short: 'Landsat C2', provider: 'Landsat C2', resLabel: '30 m', res: 30, kind: 'catalog', group: FIXED, offlinePhase0: false, psf: 0.55, psfSrc: SRC_LS, geo: GEO_LS,
    note: 'Native Landsat 8/9 grid, offset half a pixel from Sentinel-2.',
    cfg: { collection: 'landsat-c2-l2', asset: null, res: 30, gridLabel: lsLabel,
      alt: { collection: 'landsat-c2-l2', asset: null, res: 30, gridLabel: lsLabel, url: EARTH_SEARCH_URL } } },
  { id: 'wv', short: 'WV-2 MS', provider: 'WorldView-2 · native MS', resLabel: '1.6 m', res: 1.6, kind: 'custom', group: TASK, psf: measured(2.0, 1.6), psfSrc: SRC_PHENET, psfMeasured: true, geo: GEO_WV,
    note: 'Native multispectral. Measured FWHM 2.0 m.' },
  { id: 'wv-ps', short: 'WV-2 pan', provider: 'WorldView-2 · pansharpened', resLabel: '0.4 m', res: 0.4, kind: 'custom', group: TASK, psf: measured(1.1, 0.4), psfSrc: SRC_PHENET, psfMeasured: true, geo: GEO_WV,
    note: 'Pansharpened. Measured FWHM 1.1 m.' },
  { id: 'pleiades', short: 'Pléiades MS', provider: 'Pléiades · native MS', resLabel: '2 m', res: 2, kind: 'custom', group: TASK, psf: measured(5, 2), psfSrc: SRC_PHENET, psfMeasured: true, geo: GEO_PLEIADES,
    note: 'Native multispectral. Measured FWHM 5 m.' },
  { id: 'pleiades-ps', short: 'Pléiades pan', provider: 'Pléiades · pansharpened', resLabel: '0.5 m', res: 0.5, kind: 'custom', group: TASK, psf: measured(3, 0.5), psfSrc: SRC_PHENET, psfMeasured: true, geo: GEO_PLEIADES,
    note: 'Pansharpened. Measured FWHM 3 m.' },
  { id: 'skysat', short: 'SkySat pan', provider: 'SkySat · pansharpened', resLabel: '0.5 m', res: 0.5, kind: 'custom', group: TASK, psf: 0.62, psfSrc: eo('skysat'), psfAssumed: true, geo: GEO_PLANET,
    note: 'Pansharpened ortho product. Blur from an assumed MTF.' },
  { id: 'spot', short: 'SPOT pan', provider: 'SPOT 6/7 · pansharpened', resLabel: '1.5 m', res: 1.5, kind: 'custom', group: TASK, psf: 0.60, psfSrc: eo('spot-6-7'), psfAssumed: true, geo: GEO_SPOT,
    note: 'Panchromatic and pansharpened products. Blur from an assumed MTF.' },
  { id: 'planet', short: 'PlanetScope', provider: 'PlanetScope', resLabel: '3 m', res: 3, kind: 'custom', group: TASK, psf: measured(11.8, 3), psfSrc: SRC_PHENET, psfMeasured: true, geo: GEO_PLANET,
    note: 'Measured FWHM 11.8 m.' },
  { id: 'custom', short: 'Custom', provider: 'Custom', resLabel: '', res: 1, kind: 'custom', group: TASK, psf: 0.55,
    note: 'Any sensor: pick the pixel size and where the grid starts.' },
];

const GSD_PRESETS = [0.3, 0.5, 1, 1.5, 2, 3, 5];

/**
 * One row of the ladder: a satellite, with the pixel size and the blur its
 * rung is computed at.
 */
interface Rung {
  /** The source's id: what a click on the row selects. */
  id: string;
  name: string;
  res: number;
  /** Gaussian sigma of the blur, in pixels, per axis. */
  sigmaX: number;
  sigmaY: number;
  /**
   * True for a tasked sensor, whose lattice is not known before the image is
   * taken: the trial is then counted at the position on it that keeps the
   * fewest pure pixels (simulate.ts SensorParams.anyPosition).
   */
  anyPosition: boolean;
}


/**
 * The ladder's rows: every satellite of the list, finest pixels first.
 *
 * It used to be nine pixel sizes, all under the blur of whichever sensor was
 * selected: "3 m" was then PlanetScope's pixel under Sentinel-2's optics, or
 * the other way round, a sensor nobody can task. A trial is read by a
 * satellite, which brings its pixel size AND its blur, and the two do not go
 * together the way a ladder of sizes assumed (Pléiades pansharpened has 0.5 m
 * pixels under a blur 2.5 pixels wide, SkySat the same pixels under 0.6).
 *
 * Each satellite is taken at its own figures, except the one selected, which
 * is taken as it stands on the page (its pixel size and blur can be edited
 * there), so that its row is the trial on the map. A custom sensor is no
 * satellite and has a row only while it is the one in use.
 */
function ladderRungs(current: { id: string; res: number; sigmaX: number; sigmaY: number }): Rung[] {
  const rungs: Rung[] = [];
  for (const src of SOURCES) {
    const here = src.id === current.id;
    if (src.id === 'custom' && !here) continue;
    rungs.push(here && current.res > 0
      ? { id: src.id, name: src.short, res: current.res, sigmaX: current.sigmaX, sigmaY: current.sigmaY, anyPosition: src.kind !== 'catalog' }
      : { id: src.id, name: src.short, res: src.res, sigmaX: src.psf, sigmaY: src.psf, anyPosition: src.kind !== 'catalog' });
  }
  // Stable: two satellites with the same pixels keep the order of the list.
  return rungs.map((r, k) => ({ r, k })).sort((a, b) => a.r.res - b.r.res || a.k - b.k).map(x => x.r);
}

export { PCA_SAMPLE, RES_LADDER, FIXED, TASK, s2Label, SRC_S2, SRC_LS, eo, SRC_PLANET, SOURCES, GSD_PRESETS, ladderRungs };
export type { Source, Rung };
