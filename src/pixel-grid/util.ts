import { BARE } from './simulate';

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
/** Fraction-weighted blend of crop A / crop B / bare soil — reduces to a clean
 *  A↔B gradient when there's no bare gap. */
const mix3 = (pA: number, pB: number, pBare: number, colA: string, colB: string): string => {
  const [aR, aG, aB] = hexRgb(colA), [bR, bG, bB] = hexRgb(colB), [sR, sG, sB] = hexRgb(BARE.color);
  const w = pA + pB + pBare || 1;
  const c = [(pA * aR + pB * bR + pBare * sR) / w, (pA * aG + pB * bG + pBare * sG) / w, (pA * aB + pB * bB + pBare * sB) / w];
  return `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
};

const fmt = (n: number) => n.toLocaleString('en-US');
const fmtM = (m: number) => (m < 0.995 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`);

export { lerpHex, hexRgb, mix3, fmt, fmtM };
