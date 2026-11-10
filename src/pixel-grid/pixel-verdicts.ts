import { MAX_COVER, simulateField, type SensorParams, type SimLayout } from './simulate';
import { shiftImportedPlan } from './imported-rotate';
import { ce90Shifts, robustMask } from './resolving';
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

export function pixelVerdicts(
  grid: S2Grid, origin: [number, number], layout: SimLayout, sensor: SensorParams, ce90M: number,
): PixelVerdicts {
  const nominal = simulateField(grid, origin, layout, sensor).mixed;
  const n = nominal.length;
  const pure = new Uint8Array(n), cover = new Uint16Array(n);
  for (let k = 0; k < n; k++) if (nominal[k] <= MAX_COVER) { pure[k] = 1; cover[k] = nominal[k] + 1; }
  let robust: Uint8Array | null = null;
  if (ce90M > 0) {
    // The trial moves under a fixed lattice, the same relative displacement as
    // the image landing elsewhere, and it keeps index k on the same pixel. An
    // imported plan has no origin to move, so the plan itself is shifted.
    const imported = layout.pattern === 'imported' ? layout.imported : undefined;
    const shifted = ce90Shifts(ce90M).map(([dx, dy]) => (imported
      ? simulateField(grid, origin, { ...layout, imported: shiftImportedPlan(imported, -dx, -dy) }, sensor).mixed
      : simulateField(grid, [origin[0] - dx, origin[1] - dy], layout, sensor).mixed));
    robust = robustMask(nominal, shifted);
  }
  return { pure, cover, robust };
}
