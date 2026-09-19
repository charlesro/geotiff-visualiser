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

/** Fraction-weighted blend of crop A / crop B / bare soil, reducing to a clean
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

/**
 * `n` colours that stay apart, for an imported trial that can carry dozens of
 * varieties. The first ones are `base` (the colour-blind-safe palette the
 * presets use). Past it, hues step by the golden angle, so varieties next to
 * each other in the list never sit next to each other on the colour wheel, at
 * three lightness levels. Saturation stays high: bare soil's brown and
 * off-trial grey already mean something on the map and in the PCA, and a
 * variety must not look like either.
 */
const categoricalColors = (n: number, base: string[]): string[] => {
  const out = base.slice(0, n);
  const hex = (h: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (k: number) => {
      const t = (k + h / 30) % 12;
      return l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1));
    };
    return `#${[f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
  };
  const taken = new Set(out.map(c => c.toLowerCase()));
  for (let i = 0; out.length < n; i++) {
    const c = hex((i * 137.508) % 360, 0.72, [0.56, 0.7, 0.44][i % 3]);
    if (taken.has(c)) continue;
    taken.add(c);
    out.push(c);
  }
  return out;
};

/** What dominates a pixel: a species (by index), bare alley soil, or ground outside the trial. */
type CoverKind = 'species' | 'bare' | 'off';

/**
 * A pixel's cover as shares of its WHOLE footprint: every species, bare alley
 * soil and ground outside the trial, summing to 1, plus what dominates it.
 *
 * Normalising over the species alone is what labelled a pixel lying in an
 * alley "50% maize · 50% grass": its crop cover was two slivers of blur spill
 * from the plots on either side, and dividing those slivers by each other
 * threw away the bare soil that was most of the pixel. Every place that names,
 * colours or classifies a single pixel should read it through here.
 */
const coverShares = (fr: ArrayLike<number>, bare = 0, off = 0) => {
  let total = Math.max(0, bare) + Math.max(0, off);
  for (let i = 0; i < fr.length; i++) total += Math.max(0, fr[i] || 0);
  if (total <= 0) {
    return { species: Array.from(fr, () => 0), bare: 0, off: 0, dominant: { kind: 'off' as CoverKind, i: -1, share: 0 } };
  }
  const species = Array.from(fr, v => Math.max(0, v || 0) / total);
  const b = Math.max(0, bare) / total, o = Math.max(0, off) / total;
  let kind: CoverKind = 'species', i = -1, share = -1;
  species.forEach((v, k) => { if (v > share) { share = v; i = k; } });
  if (b > share) { kind = 'bare'; i = -1; share = b; }
  if (o > share) { kind = 'off'; i = -1; share = o; }
  return { species, bare: b, off: o, dominant: { kind, i, share } };
};

const fmt = (n: number) => n.toLocaleString('en-US');
const fmtM = (m: number) => (m < 0.995 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`);

export { lerpHex, hexRgb, mix3, mixN, distinctColors, categoricalColors, coverShares, fmt, fmtM };
export type { CoverKind };
