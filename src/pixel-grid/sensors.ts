import type { SourceConfig } from './s2-grid';

/**
 * The satellites the tool can put a grid over, and what each one's optics do to
 * a sharp edge on the ground.
 *
 * Two families, and the difference is the whole point of the page. A `catalog`
 * source has a REAL, time-invariant pixel lattice that is read from product
 * metadata — you align your plots to it. A `custom` source is tasked and agile,
 * so there is no lattice to discover: you impose one and hand the recipe to the
 * provider.
 *
 * Every `psf` is a Gaussian sigma in PIXELS, derived from that sensor's
 * published MTF at Nyquist via  MTF(1/2) = exp(-pi^2 sigma^2 / 2)  =>
 * sigma = sqrt(-2 ln M) / pi, taking the BLURRIEST end of each published range
 * so the purity numbers this page reports are conservative rather than
 * flattering. `psfSrc` is where that figure is documented.
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
  /** Where the MTF/PSF figure comes from (shown as a link). */
  psfSrc?: { url: string; label: string };
  /** Grid lattice phase is 0, so a rule-based offline grid is still exact (catalog only). */
  offlinePhase0?: boolean;
  cfg?: SourceConfig;
}

const FIXED = 'Fixed grid: read live from the catalog';
const TASK = 'Commercial: you define the grid';
const s2Label = (it: any) => it.properties?.['s2:mgrs_tile'] ?? '';
// Where each sensor's MTF/PSF figure is documented.
const SRC_S2 = { url: 'https://sentiwiki.copernicus.eu/web/s2-mission', label: 'ESA SentiWiki' };
const SRC_LS = { url: 'https://www.usgs.gov/landsat-missions/spatial-performance-landsat-8-instruments', label: 'USGS · Landsat 8 spatial performance' };
const eo = (slug: string) => ({ url: `https://www.eoportal.org/satellite-missions/${slug}`, label: 'eoPortal' });
const SRC_PLANET = { url: 'https://www.tandfonline.com/doi/full/10.1080/01431161.2024.2357839', label: 'SuperDove vs Landsat 8 (2024)' };
const SOURCES: Source[] = [
  { id: 's2-10', provider: 'Sentinel-2', resLabel: '10 m', res: 10, kind: 'catalog', group: FIXED, offlinePhase0: true, psf: 0.62, psfSrc: SRC_S2,
    note: 'Blue, green, red and NIR bands: B02, B03, B04, B08.',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 10, gridLabel: s2Label } },
  { id: 's2-20', provider: 'Sentinel-2', resLabel: '20 m', res: 20, kind: 'catalog', group: FIXED, offlinePhase0: true, psf: 0.62, psfSrc: SRC_S2,
    note: 'Red-edge and SWIR bands: B05 to B07, B8A, B11, B12.',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 20, gridLabel: s2Label } },
  { id: 's2-60', provider: 'Sentinel-2', resLabel: '60 m', res: 60, kind: 'catalog', group: FIXED, offlinePhase0: true, psf: 0.62, psfSrc: SRC_S2,
    note: 'Aerosol and cirrus bands: B01, B09, B10.',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 60, gridLabel: s2Label } },
  { id: 'hls-30', provider: 'Landsat · HLS', resLabel: '30 m', res: 30, kind: 'catalog', group: FIXED, offlinePhase0: true, psf: 0.55, psfSrc: SRC_LS,
    note: 'Landsat and Sentinel-2 on one shared 30 m grid.',
    cfg: { collection: 'hls2-s30', asset: null, res: 30,
      gridLabel: it => (it.id?.split('.')?.[2] ?? '').replace(/^T/, '') } },
  { id: 'ls-30', provider: 'Landsat C2', resLabel: '30 m', res: 30, kind: 'catalog', group: FIXED, offlinePhase0: false, psf: 0.55, psfSrc: SRC_LS,
    note: 'Native Landsat 8/9 grid, offset half a pixel from Sentinel-2.',
    cfg: { collection: 'landsat-c2-l2', asset: null, res: 30,
      gridLabel: it => { const e = it.properties?.['proj:epsg']; return e >= 32700 ? `${e - 32700}S` : `${e - 32600}N`; } } },
  { id: 'wv', provider: 'WorldView / GeoEye', resLabel: '0.3 m', res: 0.3, kind: 'custom', group: TASK, psf: 0.55, psfSrc: eo('worldview-3'),
    note: 'Maxar tasking, no fixed grid.' },
  { id: 'pleiades', provider: 'Pléiades', resLabel: '0.5 m', res: 0.5, kind: 'custom', group: TASK, psf: 0.60, psfSrc: eo('pleiades'),
    note: 'Airbus tasking, no fixed grid.' },
  { id: 'skysat', provider: 'SkySat', resLabel: '0.5 m', res: 0.5, kind: 'custom', group: TASK, psf: 0.62, psfSrc: eo('skysat'),
    note: 'Planet tasking, softer than its pixel size suggests.' },
  { id: 'spot', provider: 'SPOT 6/7', resLabel: '1.5 m', res: 1.5, kind: 'custom', group: TASK, psf: 0.60, psfSrc: eo('spot-6-7'),
    note: 'Airbus tasking, no fixed grid.' },
  { id: 'planet', provider: 'PlanetScope', resLabel: '3 m', res: 3, kind: 'custom', group: TASK, psf: 0.66, psfSrc: SRC_PLANET,
    note: 'Planet daily imagery, softer than its 3 m pixels suggest.' },
  { id: 'custom', provider: 'Custom', resLabel: '', res: 1, kind: 'custom', group: TASK, psf: 0.55,
    note: 'Any sensor: pick the pixel size and where the grid starts.' },
];

const GSD_PRESETS = [0.3, 0.5, 1, 1.5, 2, 3, 5];

export { PCA_SAMPLE, RES_LADDER, FIXED, TASK, s2Label, SRC_S2, SRC_LS, eo, SRC_PLANET, SOURCES, GSD_PRESETS };
export type { Source };
