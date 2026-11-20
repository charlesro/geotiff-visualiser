import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import { BARE, OFF_TRIAL, speciesChannel, type PixelSources, type SimLayout } from './simulate';
import type { S2Grid } from './s2-grid';

/**
 * The "Signal of a pixel" layer, minus the drawing: what a cover is called,
 * which colour it gets, and the lines of the card that lists the shares.
 *
 * The layer exists because the purity figure alone does not say what it is a
 * share OF. A circle that holds 90 % of a pixel's signal was read as the whole
 * of it, so a circle that stuck out of its plot looked like it contradicted a
 * purity of 90 %. The dots show every part of the signal with the same weight,
 * the far ones included, each in the colour of what it lands on, and the card
 * gives the share of each cover: the first line is the purity.
 */

/** Dots a pixel's signal is drawn as. A thousand, so that one dot is 0.1 %. */
export const SOURCE_DOTS = 1000;

/**
 * The cover the purity is counted on is always the first colour, whatever it
 * is; soil and ground outside the trial keep one colour each; the other plots
 * take the list in the order of their share. None of them is a crop colour:
 * a dot says whose ground it is on, not what grows there, and a dot in its
 * plot's own colour would not show on it.
 */
export const SOURCE_COLORS = {
  own: '#34d399',
  others: ['#fb923c', '#f472b6', '#facc15', '#c084fc', '#38bdf8'],
  rest: '#f87171',
  bare: '#d6b88a',
  off: '#94a3b8',
} as const;

/**
 * What a cover id is called wherever the map names one: the species, with the
 * plot when cover ids are plots (a block trial, or an imported one that kept
 * them), bare soil, or the ground outside the trial.
 */
export function coverNamer(layout: SimLayout, names: string[]): (cover: number) => string {
  const species = speciesChannel(layout).coverSpecies;
  const plots = layout.pattern === 'block' || (layout.pattern === 'imported' && !!layout.imported?.plotIds);
  return d => {
    if (d === OFF_TRIAL.id) return 'outside the trial';
    if (d === BARE.id) return 'bare soil';
    const s = species ? species[d] : d;
    return `${names[s] ?? `species ${s + 1}`}${plots ? `, plot ${d + 1}` : ''}`;
  };
}

/** One line of the card: a cover, or the small ones folded together. */
export interface SourceRow {
  key: string;
  label: string;
  share: number;
  color: string;
}

/**
 * The card's lines and every cover's dot colour, from the shares.
 *
 * At most `maxRows` lines: a pixel on a corner of small plots can see a dozen
 * covers, most of them for a fraction of a percent, and a card that long
 * hides the map it explains. Past the limit the smallest are one line, in one
 * colour, and their dots take that colour too, so that a line and its dots
 * always match.
 */
export function sourceRows(
  covers: PixelSources['covers'], nameOf: (cover: number) => string, maxRows = 6,
): { rows: SourceRow[]; colorOf: string[] } {
  const colorOf: string[] = new Array(256).fill(SOURCE_COLORS.rest);
  const rows: SourceRow[] = [];
  const alone = covers.length > maxRows ? Math.max(1, maxRows - 1) : covers.length;
  let next = 0;
  for (let q = 0; q < alone; q++) {
    const { id, share } = covers[q];
    const color = q === 0 ? SOURCE_COLORS.own
      : id === BARE.id ? SOURCE_COLORS.bare
      : id === OFF_TRIAL.id ? SOURCE_COLORS.off
      : SOURCE_COLORS.others[next++] ?? SOURCE_COLORS.rest;
    colorOf[id] = color;
    rows.push({ key: `c${id}`, label: nameOf(id), share, color });
  }
  if (alone < covers.length) {
    let share = 0;
    for (let q = alone; q < covers.length; q++) share += covers[q].share;
    rows.push({ key: 'rest', label: `${covers.length - alone} others`, share, color: SOURCE_COLORS.rest });
  }
  return { rows, colorOf };
}

/**
 * A share as the card prints it. The first line is printed by the purity's own
 * rule instead (cut, never rounded up to the threshold), so that it reads the
 * same as the figure under the pointer.
 */
export const shareText = (p: number): string => (p < 0.0005 ? '< 0.1 %' : `${(Math.round(p * 1000) / 10).toFixed(1)} %`);

/**
 * The column and row of the pixel that holds a point, in a grid that is every
 * pixel of its extent, with its index in the grid's cells. Null outside it.
 */
export function pixelIndexAt(
  grid: Pick<S2Grid, 'epsg' | 'res' | 'utmBounds'>, lat: number, lng: number,
): { i: number; j: number; k: number } | null {
  if (!(grid.res > 0)) return null;
  const [E, N] = proj4('EPSG:4326', crsToProj4Def(`EPSG:${grid.epsg}`)).forward([lng, lat]);
  const [e0, n0, e1, n1] = grid.utmBounds, r = grid.res;
  const nx = Math.round((e1 - e0) / r), ny = Math.round((n1 - n0) / r);
  const i = Math.floor((E - e0) / r), j = Math.floor((N - n0) / r);
  return i >= 0 && i < nx && j >= 0 && j < ny ? { i, j, k: j * nx + i } : null;
}
