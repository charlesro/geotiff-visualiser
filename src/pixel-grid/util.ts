import { BARE, OFF_TRIAL } from './simulate';

/**
 * Colour and number formatting shared across the page's panels, map overlays and
 * canvas visuals. Kept apart from the geometry so a component that only needs to
 * print a metre value does not pull in polygon clipping.
 */

/** Linear interpolate between two hex colours (t=0 → a, t=1 → b). */
const lerpHex = (a: string, b: string, t: number): string => {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  const m = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${m.map(v => v.toString(16).padStart(2, '0')).join('')}`;
};

const hexRgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

/**
 * Fraction-weighted blend of ANY number of species plus bare alley and
 * off-trial ground: what one mixed pixel looks like. The single blend in the
 * codebase, so the map, the PCA scatter and the ladder cannot drift apart.
 */
const mixN = (fracs: ArrayLike<number>, colors: string[], pBare = 0, pOffTrial = 0): string => {
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < fracs.length; i++) {
    const f = fracs[i];
    if (!f) continue;
    const [cr, cg, cb] = hexRgb(colors[i % colors.length]);
    r += f * cr; g += f * cg; b += f * cb; w += f;
  }
  for (const [f, col] of [[pBare, BARE.color], [pOffTrial, OFF_TRIAL.color]] as [number, string][]) {
    if (!f) continue;
    const [cr, cg, cb] = hexRgb(col);
    r += f * cr; g += f * cg; b += f * cb; w += f;
  }
  const d = w || 1;
  return `#${[r / d, g / d, b / d].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
};

/** Fraction-weighted blend of crop A / crop B / bare soil — reduces to a clean
 *  A↔B gradient when there's no bare gap. Kept as the two-species spelling of
 *  mixN so the existing map colouring is provably the same blend. */
const mix3 = (pA: number, pB: number, pBare: number, colA: string, colB: string): string =>
  mixN([pA, pB], [colA, colB], pBare, 0);

/**
 * One distinct colour per species. Two species on the same preset (say maize
 * compared against maize with one parameter changed) would otherwise be drawn
 * identically on the map and in every legend, so the later one is moved to the
 * first palette colour nobody is using.
 */
const distinctColors = (wanted: string[], palette: string[]): string[] => {
  // Two passes, because one is not enough: filling a duplicate from the first
  // UNUSED palette colour can hand it a colour a later species legitimately
  // asked for, which then gets bumped in turn. So reserve every wanted colour
  // first, and fill duplicates only from colours nobody wants.
  const claimed = new Set<string>();
  const firstAt = new Map<string, number>();
  wanted.forEach((c, i) => {
    const key = (c || '').toLowerCase();
    if (!key) return;
    claimed.add(key);
    if (!firstAt.has(key)) firstAt.set(key, i);
  });
  const taken = new Set(claimed);
  return wanted.map((c, i) => {
    const key = (c || '').toLowerCase();
    if (key && firstAt.get(key) === i) return c;      // this species asked first
    const free = palette.find(p => !taken.has(p.toLowerCase()));
    const pick = free ?? c;
    taken.add((pick || '').toLowerCase());
    return pick;
  });
};

const fmt = (n: number) => n.toLocaleString('en-US');
const fmtM = (m: number) => (m < 0.995 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`);

export { lerpHex, hexRgb, mix3, mixN, distinctColors, fmt, fmtM };
