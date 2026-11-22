import { normCdf } from './plot-size';
import { probit } from './resolving';

/**
 * THE PHENET NOTE'S OWN FIGURES ("Plot size and effective blur"), computed the
 * way the note's page computes them, so that this page can print them beside
 * its own and a reader can check one against the other.
 *
 * The rest of the page answers for a DESIGN (this plot, at this angle, on this
 * satellite's grid). The note answers for a SENSOR, whatever the grid: its
 * figures are worst cases over a fixed set of placements, and a mean over
 * random ones. They are different questions with different answers, and both
 * are wanted: a trial is designed with the first and the choice of a satellite
 * is made with the second.
 *
 * The model is the note's (Appendix A): an isotropic Gaussian spot of standard
 * deviation sigma_eff centred on the pixel centre, no box for the pixel's
 * footprint (the measured FWHM contains it), and a square plot of side L, of
 * which a pixel centred at (x, y) from the plot's centre keeps
 *
 *   P(x, y) = F(x) F(y),   F(x) = Phi((L/2 - x) / sigma) - Phi((-L/2 - x) / sigma)
 *
 * Everything here is pure, and pinned to the note's tables in the suite.
 */

/** FWHM = 2 sqrt(2 ln 2) sigma: the constant the note's page works with. */
export const FWHM_PER_SIGMA = 2.3548;

/** What a spot of `sigma` centred `d` from the middle of a band of half width `half` keeps of it. */
const kept = (half: number, d: number, sigma: number): number =>
  (sigma > 0 ? normCdf((half - d) / sigma) - normCdf((-half - d) / sigma) : Math.abs(d) <= half ? 1 : 0);

/** The share of its signal a pixel centred at (x, y) takes from a square plot of side L centred on the origin. */
export function squarePurity(x: number, y: number, L: number, sigma: number): number {
  return kept(L / 2, x, sigma) * kept(L / 2, y, sigma);
}

/** Contamination of the pixel sitting exactly on the plot's centre: 1 - (1 - 2 Q(L / 2 sigma))^2. */
export function centredContamination(L: number, sigma: number): number {
  return 1 - squarePurity(0, 0, L, sigma);
}

/**
 * The note's factorial design of grid placements: a misregistration of 0, 1/3,
 * 1/2, 3/4 or 1 pixel, along four directions, from three phases of the grid on
 * the plot (a pixel centred on the plot's centre, the centre on a pixel edge,
 * the centre on a pixel corner), each at four rotations of the grid. 51 offsets
 * by 4 rotations: the 204 placements.
 */
const AMPS = [0, 1 / 3, 1 / 2, 3 / 4, 1];
const DIRS: [number, number][] = [[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2]];
const PHASES: [number, number][] = [[0, 0], [0.5, 0], [0.5, 0.5]];
const ROTS = [0, 15, 30, 45].map(d => [Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180)] as [number, number]);

/** The offsets of the design, in metres, with the misregistration capped at `ampMax` pixels (null: all of them). */
function offsets(gsd: number, ampMax: number | null): [number, number][] {
  const out: [number, number][] = [];
  for (const a of AMPS) {
    if (ampMax != null && a > ampMax + 1e-9) continue;
    for (const [ux, uy] of a === 0 ? [[0, 0] as [number, number]] : DIRS) {
      for (const [px, py] of PHASES) out.push([(px + a * ux) * gsd, (py + a * uy) * gsd]);
    }
  }
  return out;
}

/** How many placements a sweep runs over: 204 for the whole design. */
export function placementCount(ampMax: number | null = null): number {
  return offsets(1, ampMax).length * ROTS.length;
}

/** Plot sides are tried from 1 m by steps of 0.25 m, as on the note's page, and further than its 60 m. */
const SIDE_FIRST = 1, SIDE_STEP = 0.25, SIDE_LAST = 2000;

/**
 * The smallest side, on the 0.25 m ladder, at which `worst(L)` reaches the
 * threshold. `worst` grows with L (a larger plot keeps more of every spot), so
 * the first side that passes is found by halving rather than by walking.
 */
function firstSide(worst: (L: number) => number, threshold: number): number | null {
  const at = (k: number) => SIDE_FIRST + k * SIDE_STEP;
  let lo = 0, hi = Math.round((SIDE_LAST - SIDE_FIRST) / SIDE_STEP);
  if (!(worst(at(hi)) >= threshold - 1e-9)) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (worst(at(mid)) >= threshold - 1e-9) hi = mid; else lo = mid + 1;
  }
  return at(lo);
}

/**
 * The note's minimum plot, CENTRAL-PIXEL criterion (its chapter 5): the
 * smallest square plot in which the pixel meant to sit at the plot's centre
 * stays pure in every one of the placements. That pixel is chosen by its
 * coordinates, so a misregistration carries it away from the centre: this is
 * the conservative figure. `ampMax` = 0.5 is the note's "realistic
 * registration", the misregistration capped at half a pixel.
 */
export function centralPixelMinPlot(gsd: number, sigmaEff: number, threshold = 0.9, ampMax: number | null = null): number | null {
  if (!(gsd > 0) || !(sigmaEff >= 0) || !(threshold > 0) || !(threshold < 1)) return null;
  const offs = offsets(gsd, ampMax);
  return firstSide(L => {
    let w = 1;
    for (const [dx, dy] of offs) {
      for (const [c, s] of ROTS) {
        const p = squarePurity(dx * c + dy * s, -dx * s + dy * c, L, sigmaEff);
        if (p < w) { w = p; if (w < threshold - 1e-9) return w; }
      }
    }
    return w;
  }, threshold);
}

/**
 * The note's minimum plot, ANY-PIXEL criterion: the smallest square plot that
 * keeps at least one pure pixel, whichever it is, in every placement. Only the
 * grid's phase and rotation matter to it; the closed form
 * L = GSD + 2 * 1.632 sigma_eff (resolving.ts minPlotSideM) is its approximation.
 */
export function anyPixelMinPlot(gsd: number, sigmaEff: number, threshold = 0.9): number | null {
  if (!(gsd > 0) || !(sigmaEff >= 0) || !(threshold > 0) || !(threshold < 1)) return null;
  const offs = offsets(gsd, null);
  return firstSide(L => {
    const h = L / 2;
    let w = 1;
    for (const [dx, dy] of offs) {
      for (const [c, s] of ROTS) {
        let best = 0;
        for (let i = -2; i <= 2; i++) {
          for (let j = -2; j <= 2; j++) {
            const u = i * gsd + dx, v = j * gsd + dy, x = u * c + v * s, y = -u * s + v * c;
            if (Math.abs(x) > h || Math.abs(y) > h) continue;
            const q = squarePurity(x, y, L, sigmaEff);
            if (q > best) best = q;
          }
        }
        if (best < w) { w = best; if (w < threshold - 1e-9) return w; }
      }
    }
    return w;
  }, threshold);
}

/**
 * The note's hard ceiling: the largest pixel at which even a pixel exactly on
 * the centre of a square plot of side L is pure, for a sensor whose spot keeps
 * the same shape relative to its pixel (sigma_eff = c GSD):
 *
 *   GSD_max = L / (2 c z),   z = Q^-1((1 - sqrt(1 - epsilon)) / 2)
 *
 * `c` is sigma_eff / GSD: sqrt((r / 2.355)^2 + (1/3)^2) with the note's default
 * geolocation error. 7.1 m for a 15 m plot and a peaked sensor at 10 %.
 */
export function hardCeilingGsd(L: number, sigmaEffPerGsd: number, threshold = 0.9): number | null {
  if (!(L > 0) || !(sigmaEffPerGsd > 0) || !(threshold > 0) || !(threshold < 1)) return null;
  const z = -probit((1 - Math.sqrt(threshold)) / 2);
  return L / (2 * sigmaEffPerGsd * z);
}

/**
 * Pure pixels of a square plot for ONE placement of the grid: the pixel
 * centres ((i + ox) g, (j + oy) g), turned by `rotDeg`, that lie in the plot
 * and keep at least `threshold` of their signal from it.
 */
export function purePixelCount(gsd: number, ox: number, oy: number, rotDeg: number, L: number, sigmaEff: number, threshold = 0.9): number {
  const t = (rotDeg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const n = Math.ceil((L * 0.75 + gsd) / gsd) + 1, h = L / 2;
  let count = 0;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const u = (i + ox) * gsd, v = (j + oy) * gsd, x = u * c - v * s, y = u * s + v * c;
      if (Math.abs(x) > h || Math.abs(y) > h) continue;
      if (squarePurity(x, y, L, sigmaEff) >= threshold) count++;
    }
  }
  return count;
}

/** A small seeded generator (mulberry32): the same draws on every run, so a figure does not flicker. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What random placements of the grid give a square plot: the note's Monte-Carlo. */
export interface PlacementDraws {
  /** How many placements were drawn. */
  n: number;
  /** Mean number of pure pixels, and the fewest, the median and the most. */
  mean: number;
  min: number;
  median: number;
  max: number;
  /** Share of the placements that keep at least one pure pixel: how often the plot can be followed. */
  atLeastOne: number;
}

/**
 * The note's Monte-Carlo: the grid dropped at random on a square plot (offset
 * uniform over a pixel, rotation uniform over a quarter turn) and its pure
 * pixels counted each time. Fewer draws on a plot of many pixels, as on the
 * note's page, which keeps a click under a second; the draws are seeded.
 */
export function placementDraws(gsd: number, L: number, sigmaEff: number, threshold = 0.9, draws?: number, seed = 1): PlacementDraws | null {
  if (!(gsd > 0) || !(L > 0) || !(sigmaEff >= 0) || !(threshold > 0) || !(threshold < 1)) return null;
  const pixels = (L / gsd + 2) ** 2;
  const n = Math.max(1, Math.floor(draws ?? (pixels > 3000 ? 600 : pixels > 800 ? 1500 : 3000)));
  const rand = rng(seed);
  const counts = new Float64Array(n);
  let sum = 0, some = 0;
  for (let k = 0; k < n; k++) {
    const c = purePixelCount(gsd, rand(), rand(), rand() * 90, L, sigmaEff, threshold);
    counts[k] = c;
    sum += c;
    if (c >= 1) some++;
  }
  counts.sort();
  return { n, mean: sum / n, min: counts[0], median: counts[Math.floor(n / 2)], max: counts[n - 1], atLeastOne: some / n };
}

/** The largest plot, in pixels a side, the random placements are drawn for. */
const DRAWS_MAX_PX = 80;

/** A sensor as the note describes it: its pixel, its spot, and the geolocation error in force. */
export interface NoteSensor {
  /** Pixel size, m. */
  gsd: number;
  /** Standard deviation of the measured PSF, m. */
  sigmaPsf: number;
  /** Standard deviation of the geolocation error per axis, m (the note's default is GSD / 3). */
  sigmaGeo: number;
  /** Share of a pixel's signal that must come from its own plot (0.9 for epsilon = 10 %). */
  threshold: number;
}

/** Every figure the note gives for a sensor and a square plot of side L (or no plot: the plot-free ones only). */
export interface NoteFigures {
  sigmaEff: number;
  /** Minimum plot, central pixel, over the 204 placements, and with the misregistration capped at half a pixel. */
  central: number | null;
  centralRegistered: number | null;
  /** Minimum plot, any pixel, by the exact sweep. */
  anyPixel: number | null;
  /** The same sensor resampled onto 2 m pixels (its geolocation error the same share of a pixel: 2/3 m by default), central pixel: only the optics differ between sensors. */
  common2m: number | null;
  /** For the plot given: the largest pixel a sensor of this shape could have, the centred pixel's contamination, and the draws. */
  ceilingGsd: number | null;
  centred: number | null;
  draws: PlacementDraws | null;
}

/** The note's table for one sensor: what its chapters 5 and 6 print, and the plot's own lines when a plot is given. */
export function noteFigures(s: NoteSensor, plotSide?: number | null): NoteFigures {
  const sigmaEff = Math.hypot(s.sigmaPsf, s.sigmaGeo);
  const L = plotSide != null && plotSide > 0 ? plotSide : null;
  return {
    sigmaEff,
    central: centralPixelMinPlot(s.gsd, sigmaEff, s.threshold, null),
    centralRegistered: centralPixelMinPlot(s.gsd, sigmaEff, s.threshold, 0.5),
    anyPixel: anyPixelMinPlot(s.gsd, sigmaEff, s.threshold),
    // The geolocation error as the same share of a pixel as the sensor's own: 2/3 m with the note's default, none with none.
    common2m: centralPixelMinPlot(2, Math.hypot(s.sigmaPsf, s.gsd > 0 ? (s.sigmaGeo * 2) / s.gsd : 0), s.threshold, null),
    ceilingGsd: L != null && s.gsd > 0 ? hardCeilingGsd(L, sigmaEff / s.gsd, s.threshold) : null,
    centred: L != null ? centredContamination(L, sigmaEff) : null,
    // Not on a plot more than 80 pixels a side: the draws would take seconds, and say nothing a count of 6000 pixels needs said.
    draws: L != null && L / s.gsd <= DRAWS_MAX_PX ? placementDraws(s.gsd, L, sigmaEff, s.threshold) : null,
  };
}
