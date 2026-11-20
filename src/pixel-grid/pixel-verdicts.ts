import { MAX_COVER, fieldVerdicts, type SensorParams, type SimLayout } from './simulate';
import { shiftImportedPlan } from './imported-rotate';
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
  const imported = layout.pattern === 'imported' ? layout.imported : undefined;
  return imported
    ? fieldVerdicts(grid, origin, { ...layout, imported: shiftImportedPlan(imported, -dx, -dy) }, sensor, need)
    : fieldVerdicts(grid, [origin[0] - dx, origin[1] - dy], layout, sensor, need);
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
    const shifts = ce90Shifts(ce90M);
    robust = heldMask(nominal, shifts.length, (s, need) => shiftedVerdict(grid, origin, layout, sensor, shifts[s], need));
  }
  return { pure, cover, robust };
}
