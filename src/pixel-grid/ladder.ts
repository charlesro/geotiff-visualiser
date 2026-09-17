import type { BlockPlan, SensorParams } from './simulate';
import type { ImportedPlan } from './imported-types';

type Psf = Pick<SensorParams, 'sigmaX' | 'sigmaY' | 'offX' | 'offY'>;

/**
 * A trial's bounding box [minE, minN, maxE, maxN], widened by twice the PSF's
 * reach plus a pixel on each side, snapped outward to multiples of `r` and
 * clipped to `extent`. Shared by every kind of finite trial, so the one rule
 * that makes a rung reproduce the whole field (see trialExtent) is written once.
 */
function widenedExtent(
  tE0: number, tN0: number, tE1: number, tN1: number, r: number, sensor: Psf,
  extent: [number, number, number, number],
): [number, number, number, number] {
  // aggregate's kernel window, in pixels, for each axis.
  const reachX = (2 * Math.ceil(3 * Math.max(0, sensor.sigmaX) + Math.abs(sensor.offX ?? 0)) + 2) * r;
  const reachY = (2 * Math.ceil(3 * Math.max(0, sensor.sigmaY) + Math.abs(sensor.offY ?? 0)) + 2) * r;
  let e0 = Math.max(extent[0], Math.floor((tE0 - reachX) / r) * r);
  let n0 = Math.max(extent[1], Math.floor((tN0 - reachY) / r) * r);
  let e1 = Math.min(extent[2], Math.ceil((tE1 + reachX) / r) * r);
  let n1 = Math.min(extent[3], Math.ceil((tN1 + reachY) / r) * r);
  // A trial wholly outside the field: none of it is in any pixel that is kept.
  if (e1 <= e0 || n1 <= n0) { e0 = extent[0]; n0 = extent[1]; e1 = e0 + r; n1 = n0 + r; }
  return [e0, n0, e1, n1];
}

/**
 * The part of a field a resolution-ladder rung has to simulate for a block trial.
 *
 * Only pixels that see the trial matter to a rung: the PCA drops ground more
 * than half outside the trial and coverStats does not count it. The trial's
 * footprint, widened by TWICE the PSF's reach plus a pixel on each side, holds
 * every pixel with any trial in it and every neighbour those pixels' kernels
 * read, so each of them gets exactly the value a whole-field run gives it
 * (pinned bitwise in the regression suite). Simulating the whole field instead
 * cost over a second per rung on a 6 ha field holding a 40 m trial, at a
 * stride of 24, for a few dozen pixels.
 *
 * `extent` is the whole field snapped to multiples of `r`; the result is too,
 * and never reaches outside it. `origin` is the frame the plan's (u,v) are
 * measured from.
 */
export function trialExtent(
  plan: BlockPlan, origin: [number, number], rotationDeg: number, r: number,
  sensor: Psf,
  extent: [number, number, number, number],
): [number, number, number, number] {
  const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  let tE0 = Infinity, tN0 = Infinity, tE1 = -Infinity, tN1 = -Infinity;
  const corners: [number, number][] = [
    [plan.u0, plan.v0], [plan.u0 + plan.totalU, plan.v0],
    [plan.u0, plan.v0 + plan.totalV], [plan.u0 + plan.totalU, plan.v0 + plan.totalV],
  ];
  for (const [u, v] of corners) {
    const E = origin[0] + u * cos - v * sin, N = origin[1] + u * sin + v * cos;
    tE0 = Math.min(tE0, E); tE1 = Math.max(tE1, E); tN0 = Math.min(tN0, N); tN1 = Math.max(tN1, N);
  }
  return widenedExtent(tE0, tN0, tE1, tN1, r, sensor, extent);
}

/**
 * trialExtent for an imported trial. Its plan is already in metres of the
 * grid's CRS and ignores origin and rotation, so its box is simply the plan's
 * bbox, which holds every cell the cover map does not call off-trial.
 */
export function importedTrialExtent(
  plan: ImportedPlan, r: number, sensor: Psf, extent: [number, number, number, number],
): [number, number, number, number] {
  const [tE0, tN0, tE1, tN1] = plan.bbox;
  return widenedExtent(tE0, tN0, tE1, tN1, r, sensor, extent);
}
