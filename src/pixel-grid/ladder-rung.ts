import { layoutKey, type SimLayout } from './simulate';

/**
 * The two rules the resolution ladder is built on, as pure functions, because
 * both have already been wrong once and neither could be tested where it lived
 * (inside a React hook, use-simulation.ts).
 *
 * They belong together: one says WHEN a ladder has to be rebuilt, the other
 * says WHERE each simulated pixel of a rung sits on the ground.
 */

/**
 * The design as the LADDER sees it: everything `layoutKey` covers except the
 * corner a block plan was snapped to.
 *
 * That corner follows the pixel size currently displayed, so keying the ladder
 * on the full layout rebuilt every rung on every thumbnail click, while each
 * rung snaps its own plan to its own size anyway (stepAt). Keying on this
 * instead is what lets finished rungs be kept between clicks.
 *
 * Anything else that moves the design still moves this key: it is `layoutKey`
 * with (u0, v0) zeroed, never a hand-listed subset, so a field added to a block
 * plan cannot be forgotten here.
 */
export function ladderKey(layout: SimLayout): string {
  return layout.block ? layoutKey({ ...layout, block: { ...layout.block, u0: 0, v0: 0 } }) : layoutKey(layout);
}

/**
 * The south-west corner, in the grid's metres, of the `k`-th pixel a rung
 * simulated: rungs are a plain box of `nx` pixels per row, running row by row
 * from the SOUTH, west to east within a row (the order simulateField fills).
 *
 * Written once because stepAt needs it twice, for two different answers that
 * must agree: which pixels overlap the trial, and what ground identity each
 * kept pixel carries into the scatter. A copy of the formula that drifted would
 * hand a pixel's season to its neighbour, with nothing to show for it.
 */
export function rungCellOrigin(k: number, nx: number, e0: number, n0: number, r: number): [number, number] {
  return [e0 + (k % nx) * r, n0 + Math.floor(k / nx) * r];
}
