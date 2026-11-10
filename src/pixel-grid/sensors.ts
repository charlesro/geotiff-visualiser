import { EARTH_SEARCH_URL, type SourceConfig } from './s2-grid';

/**
 * The satellites the tool can put a grid over, and what each one's optics do to
 * a sharp edge on the ground.
 *
 * Two families, and the difference is the whole point of the page. A `catalog`
 * source has a REAL, time-invariant pixel lattice that is read from product
 * metadata: you align your plots to it. A `custom` source is tasked and agile,
 * so there is no lattice to discover: you impose one and hand the recipe to the
 * provider.
 *
 * Every `psf` is a Gaussian sigma in PIXELS, and it comes from one of two
 * places, which `psfSrc` names:
 *
 *  MEASURED. Sentinel-2, PlanetScope, WorldView-2 and Pleiades carry a FWHM
 *    fitted on real images of the PHENET trials at Mauguio and Toulouse, by
 *    blurring a very-high-resolution reference of the same scene onto the
 *    sensor's grid. That fit already contains the detector footprint, the
 *    motion blur and the residual atmosphere, so nothing is added on top.
 *    sigma = FWHM / 2.355 / GSD. These are the figures to trust: a published
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

/** Sensor pixels the PCA samples when the full field is too fine to render. */
const PCA_SAMPLE = 2500;
/** Pixel sizes (m) compared side-by-side in the resolution sweep. */
const RES_LADDER = [0.5, 1, 2, 3, 4, 5, 6, 8, 10];

interface Source {
  id: string;
  provider: string;
  resLabel: string;
  res: number;
  /** 'catalog' = read the real fixed grid live; 'custom' = you define the grid. */
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
const TASK = 'Commercial: you define the grid';
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
 * Fitted on the PHENET images themselves, NIR band, note Table 9. No url: the
 * note is not published, and inventing a link for a number this load-bearing
 * would be worse than saying plainly where it was measured.
 */
const SRC_PHENET = { label: 'measured on PHENET images at Mauguio and Toulouse' };
const SOURCES: Source[] = [
  { id: 's2-10', provider: 'Sentinel-2', resLabel: '10 m', res: 10, kind: 'catalog', group: FIXED, offlinePhase0: true, offlineSouth: 'false-northing', psf: 0.59, psfSrc: SRC_PHENET, psfMeasured: true,
    note: 'Blue, green, red and NIR bands: B02, B03, B04, B08. Measured FWHM 14 m, 1.4x the pixel.',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 10, gridLabel: s2Label, alt: esS2(10) } },
  { id: 's2-20', provider: 'Sentinel-2', resLabel: '20 m', res: 20, kind: 'catalog', group: FIXED, offlinePhase0: true, offlineSouth: 'false-northing', psf: 0.62, psfSrc: SRC_S2,
    note: 'Red-edge and SWIR bands: B05 to B07, B8A, B11, B12.',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 20, gridLabel: s2Label, alt: esS2(20) } },
  { id: 's2-60', provider: 'Sentinel-2', resLabel: '60 m', res: 60, kind: 'catalog', group: FIXED, offlinePhase0: true, offlineSouth: 'false-northing', psf: 0.62, psfSrc: SRC_S2,
    note: 'Aerosol and cirrus bands: B01, B09, B10.',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 60, gridLabel: s2Label, alt: esS2(60) } },
  { id: 'hls-30', provider: 'Landsat · HLS', resLabel: '30 m', res: 30, kind: 'catalog', group: FIXED, offlinePhase0: true, offlineSouth: 'north-crs', psf: 0.55, psfSrc: SRC_LS,
    note: 'Landsat and Sentinel-2 on one shared 30 m grid.',
    cfg: { collection: 'hls2-s30', asset: null, res: 30,
      gridLabel: it => (it.id?.split('.')?.[2] ?? '').replace(/^T/, '') } },
  { id: 'ls-30', provider: 'Landsat C2', resLabel: '30 m', res: 30, kind: 'catalog', group: FIXED, offlinePhase0: false, psf: 0.55, psfSrc: SRC_LS,
    note: 'Native Landsat 8/9 grid, offset half a pixel from Sentinel-2.',
    cfg: { collection: 'landsat-c2-l2', asset: null, res: 30, gridLabel: lsLabel,
      alt: { collection: 'landsat-c2-l2', asset: null, res: 30, gridLabel: lsLabel, url: EARTH_SEARCH_URL } } },
  { id: 'wv', provider: 'WorldView-2 · native MS', resLabel: '1.6 m', res: 1.6, kind: 'custom', group: TASK, psf: 0.50, psfSrc: SRC_PHENET, psfMeasured: true,
    note: 'The bands an index is computed on. Measured FWHM 1.9 m. This is the row to design a trial against.' },
  { id: 'wv-ps', provider: 'WorldView-2 · pansharpened', resLabel: '0.4 m', res: 0.4, kind: 'custom', group: TASK, psf: 1.17, psfSrc: SRC_PHENET, psfMeasured: true,
    note: 'Measured FWHM 1.1 m, so nearly 3 pixels across: the fine grid is not a fine resolution.' },
  { id: 'pleiades', provider: 'Pléiades · native MS', resLabel: '2 m', res: 2, kind: 'custom', group: TASK, psf: 1.06, psfSrc: SRC_PHENET, psfMeasured: true,
    note: 'Measured FWHM 5 m, far softer than the 2 m pixel suggests.' },
  { id: 'pleiades-ps', provider: 'Pléiades · pansharpened', resLabel: '0.5 m', res: 0.5, kind: 'custom', group: TASK, psf: 2.55, psfSrc: SRC_PHENET, psfMeasured: true,
    note: 'Measured FWHM 3 m, six pixels across. Sharp to look at, not to measure with.' },
  { id: 'skysat', provider: 'SkySat', resLabel: '0.5 m', res: 0.5, kind: 'custom', group: TASK, psf: 0.62, psfSrc: eo('skysat'),
    note: 'Planet tasking, softer than its pixel size suggests.' },
  { id: 'spot', provider: 'SPOT 6/7', resLabel: '1.5 m', res: 1.5, kind: 'custom', group: TASK, psf: 0.60, psfSrc: eo('spot-6-7'),
    note: 'Airbus tasking, no fixed grid.' },
  { id: 'planet', provider: 'PlanetScope', resLabel: '3 m', res: 3, kind: 'custom', group: TASK, psf: 1.37, psfSrc: SRC_PHENET, psfMeasured: true,
    note: 'Measured FWHM 9.7 m, over three pixels across. Daily revisit, but it cannot resolve a small plot.' },
  { id: 'custom', provider: 'Custom', resLabel: '', res: 1, kind: 'custom', group: TASK, psf: 0.55,
    note: 'Any sensor: pick the pixel size and where the grid starts.' },
];

const GSD_PRESETS = [0.3, 0.5, 1, 1.5, 2, 3, 5];

export { PCA_SAMPLE, RES_LADDER, FIXED, TASK, s2Label, SRC_S2, SRC_LS, eo, SRC_PLANET, SOURCES, GSD_PRESETS };
export type { Source };
