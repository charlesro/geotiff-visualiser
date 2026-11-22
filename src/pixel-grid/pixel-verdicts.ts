import { MAX_COVER, fieldVerdicts, type SensorParams, type SimLayout } from './simulate';
import { importedLandings, trialAngle } from './imported-rotate';
import { ce90Shifts, heldMask } from './resolving';
import type { S2Grid } from './s2-grid';

/**
 * What the simulation says about each exported pixel, for the shapefile.
 *
 * The export used to carry geometry only, so the one thing the page works out,
 * which pixels to trust, never left the screen. All arrays are in grid.cells
 * order: buildS2Grid and simulateField both run row by row from the south-west
 * corner, so on a full (unstrided, unclipped) grid index k is the same pixel.
 */
export interface PixelVerdicts {
  /** 1 when the pixel is pure for one plot (or one species, on a strip pattern). */
  pure: Uint8Array;
  /** That plot or species, 1-based so 0 can mean "none". */
  cover: Uint16Array;
  /**
   * 1 when it is pure for that same plot wherever the image lands within the
   * CE90. Null when no geolocation error is set: there is nothing to survive.
   */
  robust: Uint8Array | null;
}

/**
 * The verdict of every pixel when the image lands (dx, dy) metres from where
 * its coordinates say.
 *
 * The trial moves under a fixed lattice, the same relative displacement as the
 * image landing elsewhere, and it keeps index k on the same pixel. An imported
 * plan has no origin to move, so the plan itself is shifted.
 *
 * One placement per call, because each is a simulation of the field: the
 * export runs the eight in a row, the map asks for them one at a time so that
 * the page stays alive in between.
 *
 * `need` marks the pixels the caller will read (the ones still pure at every
 * placement so far, see holdTracker): the others are not worked out and read
 * mixed. Without it, every pixel.
 */
export function shiftedVerdict(
  grid: S2Grid, origin: [number, number], layout: SimLayout, sensor: SensorParams, [dx, dy]: [number, number],
  need: ArrayLike<number> | null = null,
): Uint8Array {
  // An imported trial has no origin to move: its pixels are moved the other way instead, over the plan as it is.
  if (layout.pattern === 'imported' && layout.imported) {
    const [w, s, e, n] = grid.utmBounds;
    return fieldVerdicts({ ...grid, utmBounds: [w + dx, s + dy, e + dx, n + dy] }, origin, layout, sensor, need);
  }
  return fieldVerdicts(grid, [origin[0] - dx, origin[1] - dy], layout, sensor, need);
}

/**
 * What a layout's pixels have to survive to HOLD within a CE90: where the image
 * can land, and whether anything can survive it at all. One rule for the
 * satellites table, the map's "Pure pixels" layer and the export's ROBUST
 * column, which each used to build their own landings.
 *
 * `lands` are the plot's own eight directions (ce90Shifts at the layout's
 * angle; an imported trial's is the direction its plots lie along).
 *
 * `hopeless`: a shift of half the short side of a plot or a strip carries its
 * own centre line onto its edge, so nothing holds past that, and nothing needs
 * simulating. It is also what keeps the rim-only check honest on a layout
 * whose cover ids come back: the strips of one crop share an id, so a pixel
 * pushed a whole strip further lands pure for "the same cover" in the NEXT
 * strip of that crop, with a strip of the other crop in between. The table had
 * this guard and the map and the export did not: 3 m rows under an 18 m CE90
 * were exported as holding (found by an outside review, 2026-11-22).
 *
 * An imported trial has no one width to say when the rim skips a plot; it is
 * never called hopeless, and one too large for a plot id each gets a second
 * ring (imported-rotate.ts importedLandings, the placement search's own rule).
 */
export function landings(layout: SimLayout, ce90M: number): { lands: [number, number][]; hopeless: boolean } {
  if (!(ce90M > 0)) return { lands: [], hopeless: false };
  const imported = layout.pattern === 'imported' ? layout.imported : undefined;
  if (imported) return { lands: importedLandings(ce90M, trialAngle(imported), imported.plotIds), hopeless: false };
  // The ground one cover id stands for, by its short side. Two strips of one
  // crop side by side with no alley between them (the 2:2 patterns) are one
  // strip twice as wide.
  const pair = (layout.pattern === 'strip-row-2' || layout.pattern === 'strip-col-2') && !(layout.spacing > 0);
  const side = layout.pattern === 'block'
    ? (layout.block ? Math.min(layout.block.design.plotLength, layout.block.design.plotWidth) : undefined)
    : pair ? 2 * layout.width : layout.width;
  return { lands: ce90Shifts(ce90M, layout.rotationDeg), hopeless: side != null && ce90M >= side / 2 };
}

export function pixelVerdicts(
  grid: S2Grid, origin: [number, number], layout: SimLayout, sensor: SensorParams, ce90M: number,
): PixelVerdicts {
  const nominal = fieldVerdicts(grid, origin, layout, sensor);
  const n = nominal.length;
  const pure = new Uint8Array(n), cover = new Uint16Array(n);
  for (let k = 0; k < n; k++) if (nominal[k] <= MAX_COVER) { pure[k] = 1; cover[k] = nominal[k] + 1; }
  let robust: Uint8Array | null = null;
  if (ce90M > 0) {
    const { lands, hopeless } = landings(layout, ce90M);
    robust = hopeless ? new Uint8Array(n)
      : heldMask(nominal, lands.length, (s, need) => shiftedVerdict(grid, origin, layout, sensor, lands[s], need));
  }
  return { pure, cover, robust };
}
