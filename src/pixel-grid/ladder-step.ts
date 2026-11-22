import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import {
  MIXED, bestPhaseOffset, coverStats, fieldShares, fieldVerdicts, plantedAreaPx, speciesChannel, stakeBlockPlan, utmEnvelope,
  type BlockDesign, type SensorParams, type SimLayout,
} from './simulate';
import { CE90_TO_SIGMA, ce90Shifts, contrastInfo, heldMask, minPlotSideM, plantedPixels, plantedShare, plotTally, type PlotTally } from './resolving';
import { landings } from './pixel-verdicts';
import { aoiUtmOrigin, type LngLatBounds, type S2Grid } from './s2-grid';
import { fieldOverlapTest, type Poly } from './geometry';
import { pixelId } from './ladder-rung';
import { importedTrialExtent, trialExtent } from './ladder';
import { rungCellOrigin } from './ladder-rung';
import { seatedPlacement } from './trial-seat';
import { isAligned, nearestTurn, placementSearch, rotateImportedPlan, shiftImportedPlan, stakeOnGrid, worstShift, type PlacementSearch } from './imported-rotate';
import type { ImportedPlan } from './imported-types';
import { latticePhase, sourceCe90, type Rung } from './sensors';
import type { SweepStep } from './PcaSweep';

/**
 * One row of the satellites table, computed: the field and the design as one
 * satellite sees them.
 *
 * It was a callback inside the page's hook (use-simulation), closed over a
 * dozen of its values. It is a function of plain data here so that it can run
 * anywhere: on the page, under node for the suite, and in the workers that
 * build the table without holding the page (ladder.worker, ladder-pool). What
 * it needs of the page is `LadderContext`, and nothing in it is a function, so
 * that it can be handed to a worker as it is.
 */

/**
 * Largest field one ladder rung simulates whole; beyond it a central window of
 * this many pixels stands in, and the panel is flagged with a circle.
 *
 * This is a budget for a THUMBNAIL, not for an answer. A rung is 92 pixels tall
 * and draws at most 500 dots, so simulating tens of thousands to choose them is
 * oversampling by two orders of magnitude, and it is paid 18 times over when the
 * aligned comparison is on: measured on a 300-plot trial, building both ladders
 * cold blocked the main thread for 3.9 s in nine visible janks, which reads as
 * the page freezing. simulateField is 72 of the 90 ms of a 40,000-pixel rung, so
 * the cost is very nearly linear in this number.
 *
 * Small trials are unaffected: under the cap a rung is exact and carries no
 * flag. It binds only at the fine end of the ladder over a large field, where
 * the rung was already an estimate over a central window and said so.
 *
 * Not lower than this, because the window is a sample and its size is the
 * sample's noise. Measured against a 40,000-pixel window on a 40-variety block
 * trial, 12,000 moved a rung's purity by up to 2.1 points and the gap between
 * the two ladders by 1.2; 20,000 halves that, which keeps it under the tie band
 * the comparison is judged on (TIE_POINTS in PcaStep). A cheaper thumbnail is
 * not worth a verdict that sampling could flip.
 */
const LADDER_MAX_CELLS = 20_000;

/**
 * Plants slide to the phase that leaves the most pure pixels (strip edges on
 * pixel edges; a block trial is snapped by buildBlockPlan instead).
 *
 * Always on, and a module CONSTANT rather than state: the switch left the UI,
 * and what was left was a `useState(true)` with no setter anywhere, a returned
 * value nothing could change, and a segment of the map's cache key that could
 * never move. It stays named, and read where the choice is made, so turning it
 * back into a control is one line here rather than a hunt through three memos.
 */
export const OPTIMIZE_PLACEMENT = true;

/** What a rung is computed from, besides the rung itself. Plain data: it crosses to a worker. */
export interface LadderContext {
  /** The drawn area, and the field as a closed ring (use-area `fieldRing`), or null for none. */
  aoi: LngLatBounds;
  fieldRing: Poly | null;
  /** The grid's UTM CRS. */
  epsg: number;
  /**
   * The page's layout, block plan or imported plan included. A rung overrides
   * the rotation, and stakes a block plan or an imported one for its own size.
   */
  layout: SimLayout;
  /** The purity threshold, in percent. */
  threshold: number;
  blockDesign: BlockDesign;
  /** An imported trial's angle to the pixel rows as it stands, as the file has it, and the file's own plan. */
  importedAngle: number;
  importedFileAngle: number;
  importedBasePlan: ImportedPlan | undefined;
  /** The geolocation error: the note's default per pixel size, or the figure typed (ce90For). */
  geoAuto: boolean;
  geoManual: number;
  /** Each satellite at its own provider's figure instead (sensors.ts sourceCe90). */
  geoProvider?: boolean;
  /**
   * What a trial is placed for at each rung: the most pixels that hold within
   * that rung's CE90 (the default), or the most pure pixels (use-grid `placeFor`).
   */
  placeFor?: 'pure' | 'held';
  /**
   * The page's own geolocation setting, where it is not the one above: a
   * design sized with no error to hold against (geoManual 0) is still placed,
   * on the page, for the CE90 the page has. None: the setting above.
   */
  pageGeo?: { auto: boolean; manualM: number; provider?: boolean };
}

/**
 * The search for an imported trial's best placement at one rung, with the
 * sensor and the CE90 that rung is computed with. One definition for the sweep,
 * which may run it a slice per task, and for the rung, which reads its answer:
 * the two have to be asking about the same search. Null with no trial.
 */
export function ladderSearch(ctx: LadderContext, rung: Rung): PlacementSearch | null {
  // Searched on THIS satellite's lattice: the trial is moved by where its edges
  // fall instead of the lattice (see ladderStep), and a placement is a turn and
  // a shift from the file, which read the same in either frame.
  const [pE, pN] = latticePhase(rung.id, rung.res, ctx.epsg);
  return ctx.importedBasePlan
    ? placementSearch(pE || pN ? shiftImportedPlan(ctx.importedBasePlan, -pE, -pN) : ctx.importedBasePlan, rung.res, { sigmaX: rung.sigmaX, sigmaY: rung.sigmaY, mixThreshold: ctx.threshold / 100, anyPosition: rung.anyPosition },
        placedCe90(ctx, rung.id, rung.res))
    : null;
}

/** The CE90 a rung is held against: the page's setting, for that satellite (sensors.ts sourceCe90). */
const rungCe90 = (ctx: LadderContext, id: string, res: number): number =>
  sourceCe90(id, res, { auto: ctx.geoAuto, manualM: ctx.geoManual, provider: ctx.geoProvider });

/** The CE90 a rung's trial is PLACED for, to the centimetre: that rung's own, or 0 when the page places for pure pixels. */
const placedCe90 = (ctx: LadderContext, id: string, res: number): number =>
  (ctx.placeFor === 'pure' ? 0 : Math.round((ctx.pageGeo ? sourceCe90(id, res, ctx.pageGeo) : rungCe90(ctx, id, res)) * 100) / 100);

/**
 * ONE satellite of the ladder at a GIVEN rotation, the unit the sweep is split
 * into. Parameterised by rotation so the comparison at 0° runs the identical code.
 * Pure and synchronous. Depends on the field and the design (`ctx`), and takes
 * the pixel size and the blur from the rung it is asked for, never from the
 * sensor currently selected, which is what lets the rungs be kept between
 * clicks: a click selects another satellite, and no rung is about the one
 * selected.
 */
export function ladderStep(ctx: LadderContext, rotationDeg: number, rung: Rung, asDrawn = true): SweepStep {
  const { aoi, epsg, layout, threshold, fieldRing, blockDesign, importedAngle, importedFileAngle, importedBasePlan } = ctx;
  const pattern = layout.pattern, stripWidth = layout.width, spacing = layout.spacing;
  const ce90At = (res: number) => rungCe90(ctx, rung.id, res);
  const r = rung.res;
  // The SHARED layout, with only the rotation overridden: "vs aligned" reruns
  // this identical code at 0 degrees. Rebuilding it from primitives would drop
  // the block plan, so a randomised design would be invisible to the ladder.
  let layoutL: SimLayout = { ...layout, rotationDeg };
  // A tasked satellite's lattice falls anywhere: every slide below then goes to the position that keeps the fewest.
  // And every slide is for what the page places for: the pixels that hold within this rung's CE90, or the pure ones.
  const sensorL: SensorParams = { sigmaX: rung.sigmaX, sigmaY: rung.sigmaY, mixThreshold: threshold / 100, anyPosition: rung.anyPosition, placeHeldM: placedCe90(ctx, rung.id, r) };
  const [minE, minN, maxE, maxN] = utmEnvelope(aoi, epsg);
  const base = aoiUtmOrigin(aoi, epsg);
  /**
   * Where THIS satellite's pixel edges fall (sensors.ts latticePhase). Zero for
   * every grid but native Landsat (half a pixel off) and, south of the equator,
   * the 30 and 60 m ones. Every rung used to be laid on whole multiples of its
   * pixel, so Landsat C2 was measured on the HLS lattice and read the same
   * figures (found by an outside review, 2026-11-22).
   *
   * Rows, columns, checkerboards and block trials are measured on a box laid
   * on the real lattice: the slide, the staking and the trial's extent all
   * take the lattice from the box they are given (simulate.ts latticeOffset).
   * An imported trial is moved the other way instead and measured on whole
   * multiples, which is the same picture: its staking and its placement search
   * count from zero.
   */
  const [pE, pN] = latticePhase(rung.id, r, epsg);
  const moved = layout.pattern === 'imported';
  const bE = moved ? 0 : pE, bN = moved ? 0 : pN;
  const offLattice = (pl: ImportedPlan): ImportedPlan => (pE || pN ? shiftImportedPlan(pl, -pE, -pN) : pl);
  const t = (rotationDeg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  // Each size gets its own purity-optimal placement (matches the map when picked).
  let ox = base[0], oy = base[1];
  // A block design is anchored and snapped by buildBlockPlan instead, and its
  // plots carry n species: searchPhaseOffset keeps two counters and assigns
  // with `& 1`, so it would optimise "species 0 or 1 coverage" and ignore the
  // rest.
  if (OPTIMIZE_PLACEMENT && layout.pattern !== 'block' && layout.pattern !== 'imported') {
    const [du, dv] = bestPhaseOffset(pattern, r, stripWidth, spacing, threshold / 100, base[0] - pE, base[1] - pN, sensorL);
    ox = base[0] + du * cos - dv * sin; oy = base[1] + du * sin + dv * cos;
  }
  /**
   * The WHOLE FIELD, on pixels snapped to multiples of r, keeping the pixels
   * that OVERLAP the field: the same rule the big scatter, the pixel count and
   * the export use (geometry.ts fieldOverlapTest). It used to be "centre
   * inside", which left a tilted field's corners covered by no kept pixel.
   */
  let e0 = Math.floor((minE - bE) / r) * r + bE, n0 = Math.floor((minN - bN) / r) * r + bN;
  let e1 = Math.ceil((maxE - bE) / r) * r + bE, n1 = Math.ceil((maxN - bN) / r) * r + bN;
  /** Pixels counted are those overlapping this ring (UTM), else those overlapping the field. */
  let trialRing: [number, number][] | null = null;
  /** Where a best-placement rung puts the trial. */
  let placement: SweepStep['placement'];
  if (layout.pattern === 'imported') {
    // Already in this grid's metres: nothing to resolve per size, only the
    // part of the field that sees the trial (the same exact rule as a block
    // trial's, see ladder.ts). At another angle than the one shown (the
    // aligned comparison) it is the same trial, turned to that angle.
    // Your design's rungs are the trial exactly as it stands, turn and stake
    // included. The comparison's rungs turn it by the smallest turn to that
    // angle and stake it on THIS rung's grid, the best it could be at that
    // size, the way a block trial is snapped per size.
    /**
     * A rung is measured in its OWN placement's frame, never in the field's.
     *
     * The field is the outline of whichever placement is currently adopted
     * (the page sets it from the trial), so clamping a rung to it measured the
     * OTHER placement inside the wrong outline: turning the trial 11.6 degrees
     * inside the envelope of its own 0 degree hull cuts the corners off, and
     * the same rung then reported 10,445 trial pixels where it had reported
     * 11,037. Clicking a panel changed the purity of the ladder it was in,
     * which is the one thing a comparison may not do.
     *
     * Infinity is the honest bound: widenedExtent clamps with max/min, so this
     * leaves the trial's own widened box exactly as it computes it, rather than
     * restating its kernel reach here and letting the two drift.
     */
    const UNCLIPPED: [number, number, number, number] = [-Infinity, -Infinity, Infinity, Infinity];
    /**
     * The comparison ladder ALWAYS re-stakes, whichever placement the design
     * happens to be sitting at.
     *
     * It used to decide by comparing angles, so the moment the aligned
     * placement was adopted the right-hand ladder stopped meaning "the best
     * this trial could be at each size" and started meaning "the trial exactly
     * as it stands", staked once at the size that was clicked. Its numbers
     * changed under the reader as a result of their own click: 54% at 1 m
     * became 45%, 16% at 3 m became 12%. A comparison has to measure the same
     * thing before and after it is acted on, so which ladder this is decides
     * it, not where the design currently sits.
     */
    let plan = layout.imported && offLattice(layout.imported);
    const turn = nearestTurn(importedFileAngle, rotationDeg);
    const asStands = asDrawn && Math.abs(rotationDeg - importedAngle) < 1e-9;
    if (!asDrawn && importedBasePlan) {
      /**
       * The comparison ladder of an imported trial is its BEST placement at
       * this size, at whatever angle that is, not the trial along the pixel
       * rows: lying along them is one placement among others and, for plots
       * that are not a whole number of pixels, rarely the one that keeps the
       * most pure pixels (see bestPlacement). The search is run to its end
       * here; the sweep has usually done it already, a slice at a time.
       */
      const search = ladderSearch(ctx, rung)!;
      while (!search.step()) { /* every slice left */ }
      const best = search.found!;
      plan = best.plan;
      placement = { turn: best.turn, shift: best.shift, angle: best.angle, searched: best.searched };
    } else if (!asStands && importedBasePlan) {
      plan = rotateImportedPlan(offLattice(importedBasePlan), turn);
      if (isAligned(importedFileAngle + turn)) {
        plan = stakeOnGrid(plan, r, sensorL, importedTrialExtent(plan, r, sensorL, UNCLIPPED)).plan;
      }
    } else if (plan && rung.anyPosition) {
      // The trial as it stands, for a satellite whose lattice falls anywhere:
      // where the file puts it on the lattice drawn is one position among all
      // of them, and the row counts it at the one that keeps the fewest.
      const [sE, sN] = worstShift(plan, r, sensorL, placedCe90(ctx, rung.id, r));
      if (sE || sN) plan = shiftImportedPlan(plan, sE, sN);
    }
    if (plan) {
      layoutL = { ...layoutL, imported: plan };
      [e0, n0, e1, n1] = importedTrialExtent(plan, r, sensorL, UNCLIPPED);
      /**
       * Counted over its OWN outline, not the field's: the drawn trial's
       * would cut the corners off a turned one (the comparison ladder turns
       * it again per rung), and the two ladders must count by the same rule.
       *
       * Both rules are "the pixels that see the trial": the other layouts
       * count over the field ring, inside the same trial extent, and
       * coverStats drops every pixel more than half off-trial either way.
       * They differ in exactly one case, deliberately: a generated trial
       * bigger than its field is cut down to the field, while an imported
       * trial IS the field (the page sets the field from its outline).
       */
      trialRing = plan.footprint;
    }
  } else if (layout.pattern === 'block') {
    /**
     * The trial as it is staked for pixels of THIS size: the plan resolved
     * against this rung's own lattice, exactly as the page resolves it when
     * this rung is picked. The map's plan is snapped to the displayed size
     * instead, so borrowing it made each thumbnail describe a trial that
     * picking it would not show.
     */
    // Staked on THIS rung's lattice, the best the trial could be at this size,
    // which is what the aligned ladder claims to show. Corner-snapping alone
    // put it at the 13th percentile of the available phases at 6 m and made
    // "turned onto the pixel grid" report worse than the same trial left at
    // 10 degrees. No phase to choose at any other angle, where it is a no-op.
    // On its seat in the field, as the map puts it (trial-seat.ts).
    const plan = stakeBlockPlan(blockDesign, seatedPlacement(blockDesign, fieldRing, aoi, epsg, [e0, n0, e1, n1], base, rotationDeg, r, OPTIMIZE_PLACEMENT),
      [ox, oy], rotationDeg, r, sensorL, [e0, n0, e1, n1]).plan;
    layoutL = { ...layoutL, block: plan };
    // Only the pixels that see the trial, which a rung reproduces exactly
    // (see trialExtent); the rest of the field was most of a rung's cost.
    [e0, n0, e1, n1] = trialExtent(plan, [ox, oy], rotationDeg, r, sensorL, [e0, n0, e1, n1]);
  }
  // Very large extents fall back to a central window of LADDER_MAX_CELLS
  // pixels, flagged `partial` on the panel.
  let partial = false;
  if (Math.round((e1 - e0) / r) * Math.round((n1 - n0) / r) > LADDER_MAX_CELLS) {
    partial = true;
    const cx = (e0 + e1) / 2, cy = (n0 + n1) / 2;
    const side = Math.floor(Math.sqrt(LADDER_MAX_CELLS)) * r;
    const w = Math.min(side, e1 - e0), h = Math.min(side, n1 - n0);
    e0 = Math.floor((cx - w / 2 - bE) / r) * r + bE; n0 = Math.floor((cy - h / 2 - bN) / r) * r + bN;
    e1 = e0 + Math.round(w / r) * r; n1 = n0 + Math.round(h / r) * r;
  }
  // The engine reads only the pixel size and the snapped extent.
  const box = { res: r, utmBounds: [e0, n0, e1, n1] } as unknown as S2Grid;
  const nx = Math.round((e1 - e0) / r), cells = nx * Math.round((n1 - n0) / r);
  const ringUtm = trialRing ?? (fieldRing
    ? (() => { const toUtm = proj4('EPSG:4326', crsToProj4Def(`EPSG:${epsg}`)); return fieldRing.map(([lng, lat]) => toUtm.forward([lng, lat]) as [number, number]); })()
    : null);
  // Pixels overlapping the ring, by the rule the whole page uses (geometry.ts).
  const overlaps = ringUtm ? fieldOverlapTest(ringUtm) : null;
  const keep: number[] = [];
  const kept = overlaps ? new Uint8Array(cells) : null;
  for (let k = 0; k < cells; k++) {
    if (!overlaps || !kept) { keep.push(k); continue; }
    const [cE, cN] = rungCellOrigin(k, nx, e0, n0, r);
    if (overlaps(cE, cN, r)) { keep.push(k); kept[k] = 1; }
  }
  // Only the pixels kept are simulated: the box of a turned trial is half
  // ground the row never reads, and it was all worked out and thrown away.
  const all = fieldShares(box, [ox, oy], layoutL, sensorL, kept);
  const nSp = all.nSpecies, n = keep.length;
  const proportionA = new Float32Array(n), proportionBare = new Float32Array(n), mixed = new Uint8Array(n);
  const proportionBySpecies = all.proportionBySpecies ? new Float32Array(n * nSp) : null;
  const proportionOffTrial = all.proportionOffTrial ? new Float32Array(n) : null;
  // The pixel's column and row, computed the way buildS2Grid names its cells,
  // so a pixel here and the same pixel in the big chart share one identity.
  const pixelIds = new Float64Array(n);
  keep.forEach((k, j) => {
    proportionA[j] = all.proportionA[k]; proportionBare[j] = all.proportionBare[k]; mixed[j] = all.mixed[k];
    if (proportionBySpecies && all.proportionBySpecies) for (let s = 0; s < nSp; s++) proportionBySpecies[j * nSp + s] = all.proportionBySpecies[k * nSp + s];
    if (proportionOffTrial && all.proportionOffTrial) proportionOffTrial[j] = all.proportionOffTrial[k];
    const [cE, cN] = rungCellOrigin(k, nx, e0, n0, r);
    // A moved trial's pixels are named where they really lie.
    pixelIds[j] = pixelId(Math.round((moved ? cE + pE : cE) / r), Math.round((moved ? cN + pN : cN) / r));
  });
  const st = coverStats({ mixed, coverSpecies: speciesChannel(layoutL).coverSpecies, nSpecies: nSp, offTrial: proportionOffTrial });
  /**
   * The rung's headline pair: its own pure pixels, over its own PLANTED AREA
   * in pixels. Read off the mixture this rung already computed, with no second
   * simulation. Counting the pixels that merely HAVE crop in them instead
   * moves the denominator whenever the trial moves, which hid a 10.2% gain in
   * pure pixels behind a one-point change in the share. See resolving.ts.
   */
  // The design's own planted area, a constant for this design and pixel size,
  // so a rung that wins pure pixels reports exactly that gain in its share.
  // A rung measured on a CENTRAL SAMPLE (`partial`) holds only a fraction of
  // the trial, so it is divided by the crop in the sample instead: the whole
  // design's area under a sample's pure count made the 0.5 m rung read 12%
  // beneath a 2 m rung reading 77%. The same rule as pureEfficiency's.
  const measured = plantedPixels({ species: proportionBySpecies, offTrial: proportionOffTrial, nSpecies: nSp, count: n });
  const geo = plantedAreaPx(layoutL, r);
  const { planted, pct: resolvingPct } = plantedShare(st.pureCrop, measured, geo);
  // Threshold-free, for the tooltip: what the mixed pixels are worth unmixed,
  // and whether two varieties can be told apart at all, which no count sees.
  const under = contrastInfo({ species: proportionBySpecies, bare: proportionBare, offTrial: proportionOffTrial, nSpecies: nSp, count: n });

  /**
   * Where this rung's share lands if the imagery is up to `geoErrM` off.
   *
   * The trial is placed ONCE, as this rung places it, and the imagery lands
   * anywhere in the uncertainty: each sample moves the trial under the fixed
   * lattice, the same relative displacement, with the window and the field
   * mask left exactly where they are (see geolocationSpread for why moving
   * the PSF or the grid bounds is not the same thing).
   *
   * Every sample is scored by `shareAt`, which is this rung's own pipeline:
   * the same box, the same field mask and the same planted-area rule as the
   * nominal share above. A range computed any other way is a range in another
   * currency, and a range in another currency printed beside a number is how
   * this page came to show 47% under 62% for the same pure pixels.
   *
   * Only when an uncertainty is set: it is off by default and costs a few
   * simulations per rung when on.
   */
  /**
   * The plot is the unit a variety trial is read by, so each rung also says
   * how its pure pixels are spread over the plots. Cover ids ARE plot ids on a
   * block trial and on an imported one that kept them; a periodic pattern has
   * no plots, and a rung sampled over the centre of the field does not see
   * them all, so neither gets a tally.
   */
  const nPlots = partial ? 0
    : layoutL.pattern === 'block' && layoutL.block ? layoutL.block.nPlots
    : layoutL.pattern === 'imported' && layoutL.imported?.plotIds ? layoutL.imported.coverSpecies.length
    : 0;
  const plots: PlotTally | null = plotTally(mixed, nPlots);
  /** The design's own short plot side, for the closed form to be read against. */
  const plotSideM = layoutL.pattern === 'block' && layoutL.block
    ? Math.min(layoutL.block.design.plotLength, layoutL.block.design.plotWidth)
    : layoutL.pattern === 'imported' ? undefined : stripWidth;
  // This rung's own CE90: with the note's default it follows the pixel size
  // (sigma_geo = GSD / 3), so it is not one figure for the whole ladder. The
  // pixel it follows is the one the satellite's geolocation goes by (geolocRes).
  // To the centimetre for what is shown and for where an image is landed; the
  // sigma from the figure before it is rounded, so that the default is the
  // note's third of a pixel exactly (use-grid does the same for the panel).
  const ce90Exact = ce90At(r);
  const ce90 = Math.round(ce90Exact * 100) / 100;
  const sigGeoM = ce90Exact > 0 ? ce90Exact / CE90_TO_SIGMA : 0;
  const minPlotM = minPlotSideM(r, Math.hypot(Math.max(rung.sigmaX, rung.sigmaY) * r, sigGeoM), threshold / 100) ?? undefined;

  /**
   * Geolocation, ONE model with two readings. The Geoloc figure is a CE90:
   * nine images in ten land within it.
   *
   * ROBUST: the pixels that are pure, for the same plot, wherever the image
   * lands within that radius. This replaces a range of COUNTS, which hid the
   * damage: on a 15 m plot at WorldView-2's 3.5 m CE90 the count stays between
   * 64 and 77 at every placement while only 16 of the 64 pixels flagged at the
   * nominal position are pure at all of them. A pixel is chosen by its
   * coordinates, so it is the SET that has to survive, not its size. The
   * shifts are not clamped to half a pixel for the same reason: a count is
   * periodic in the lattice, a chosen pixel is not.
   *
   * MEAN: the note's own number. Over many images the miss is a Gaussian of
   * sigma = CE90 / 2.146, and averaging the PSF over it gives one effective
   * spot, sigma_eff = sqrt(sigma_psf^2 + sigma_geo^2). Skipped past 5 pixels
   * of blur, the widest kernel the engine is allowed anywhere else.
   */
  let geoRobust: number | undefined, geoRobustPure: number | undefined;
  let geoMean: number | undefined, geoMeanPure: number | undefined;
  let plotsRobust: PlotTally | null = null;
  if (ce90 > 0 && resolvingPct != null) {
    const coverSp = speciesChannel(layoutL).coverSpecies;
    /**
     * The verdicts of this rung's pixels with the trial or the sensor changed,
     * for the ones `need` marks (all of them when it is null). Only those are
     * worked out, and only their verdict (fieldVerdicts): the others read mixed.
     */
    const needBox = new Uint8Array(all.mixed.length);
    const verdictAt = (lay: SimLayout, org: [number, number], sen: SensorParams, need: ArrayLike<number> | null, on: S2Grid = box): Uint8Array => {
      needBox.fill(0);
      for (let j = 0; j < n; j++) if (!need || need[j]) needBox[keep[j]] = 1;
      const v = fieldVerdicts(on, org, lay, sen, needBox);
      const mx = new Uint8Array(n);
      for (let j = 0; j < n; j++) mx[j] = v[keep[j]];
      return mx;
    };
    const importedPlan = layoutL.pattern === 'imported' ? layoutL.imported : undefined;
    // Where the image can land, in the plots' own directions, and whether
    // anything can survive it (pixel-verdicts.ts landings: one rule with the
    // map and the export). robustMask over those placements, each asked only
    // about the pixels still pure for their plot at every one before it.
    const { lands, hopeless } = landings(layoutL, ce90);
    // An imported trial is not moved for a landing: the pixels are, the other
    // way, which is the same ground under each. Moving the plan made a new
    // plan of it eight times a row, each prepared for the engine from nothing.
    const mask = hopeless ? new Uint8Array(n) : heldMask(mixed, lands.length, (q, need) => (importedPlan
      ? verdictAt(layoutL, [ox, oy], sensorL, need, { res: r, utmBounds: [e0 + lands[q][0], n0 + lands[q][1], e1 + lands[q][0], n1 + lands[q][1]] } as unknown as S2Grid)
      : verdictAt(layoutL, [ox - lands[q][0], oy - lands[q][1]], sensorL, need)));
    // Crop only, exactly as coverStats counts the nominal: robustMask already
    // leaves out mixed, bare and off-trial verdicts.
    let robust = 0;
    for (let j = 0; j < n; j++) if (mask[j] && !(proportionOffTrial && proportionOffTrial[j] > 0.5)) robust++;
    geoRobustPure = robust;
    geoRobust = plantedShare(robust, measured, geo).pct ?? undefined;
    plotsRobust = plotTally(mixed, nPlots, mask);

    const effX = Math.hypot(rung.sigmaX, sigGeoM / r), effY = Math.hypot(rung.sigmaY, sigGeoM / r);
    if (Math.max(effX, effY) <= 5) {
      const mx = verdictAt(layoutL, [ox, oy], { sigmaX: effX, sigmaY: effY, mixThreshold: threshold / 100 }, null);
      const st2 = coverStats({ mixed: mx, coverSpecies: coverSp, nSpecies: nSp, offTrial: proportionOffTrial });
      geoMeanPure = st2.pureCrop;
      geoMean = plantedShare(st2.pureCrop, measured, geo).pct ?? undefined;
    }
  }
  return { id: rung.id, name: rung.name, res: r, proportionA, proportionBare, mixed, purePct: st.purePct, pureCount: st.pureCrop, trialCount: st.total,
           resolvingPct, nEff: under.nEff, contrastDead: under.dead, plantCount: Math.round(planted),
           geoRobust, geoRobustPure, geoMean, geoMeanPure, ce90M: ce90 > 0 ? ce90 : undefined,
           plots: plots ?? undefined, plotsRobust: plotsRobust ?? undefined, minPlotM, plotSideM,
           proportionBySpecies, nSpecies: nSp, proportionOffTrial, pixelIds, partial, placement };
}

/**
 * The plot-by-plot figures of a block trial's row and nothing else: the fewest
 * pure pixels a plot keeps as `rung` sees the trial on this field at this
 * angle, and the fewest that hold within the CE90 in force (null with none).
 * Null for a trial the table does not count plot by plot (too many pixels).
 *
 * They are ladderStep's own `plots.min` and `plotsRobust.min`, to the pixel
 * (suite section H35): the same placement, the same box, the same field mask,
 * the same landings. What is left out is everything else a row carries, the
 * shares, the contrast, the mean reading, the arrays a chart is drawn from,
 * which is most of a row's cost. The design suggestion sizes a TURNED trial on
 * this: there no plot stands for the others, every plot lying its own way
 * across the pixels, so the whole trial is counted where it will lie, for
 * every plot size tried.
 */
export function blockPlotCounts(ctx: LadderContext, rotationDeg: number, rung: Rung): { pure: number; held: number | null } | null {
  const { aoi, epsg, layout, threshold, fieldRing, blockDesign } = ctx;
  if (layout.pattern !== 'block') return null;
  const r = rung.res;
  const sensor: SensorParams = { sigmaX: rung.sigmaX, sigmaY: rung.sigmaY, mixThreshold: threshold / 100, anyPosition: rung.anyPosition, placeHeldM: placedCe90(ctx, rung.id, rung.res) };
  const [minE, minN, maxE, maxN] = utmEnvelope(aoi, epsg);
  const base = aoiUtmOrigin(aoi, epsg);
  // On this satellite's own lattice, as ladderStep lays its box.
  const [pE, pN] = latticePhase(rung.id, r, epsg);
  const field: [number, number, number, number] = [Math.floor((minE - pE) / r) * r + pE, Math.floor((minN - pN) / r) * r + pN,
    Math.ceil((maxE - pE) / r) * r + pE, Math.ceil((maxN - pN) / r) * r + pN];
  const plan = stakeBlockPlan(blockDesign, seatedPlacement(blockDesign, fieldRing, aoi, epsg, field, base, rotationDeg, r, OPTIMIZE_PLACEMENT),
    base, rotationDeg, r, sensor, field).plan;
  const lay: SimLayout = { ...layout, rotationDeg, block: plan };
  const [e0, n0, e1, n1] = trialExtent(plan, base, rotationDeg, r, sensor, field);
  const nx = Math.round((e1 - e0) / r);
  if (nx * Math.round((n1 - n0) / r) > LADDER_MAX_CELLS) return null;
  const box = { res: r, utmBounds: [e0, n0, e1, n1] } as unknown as S2Grid;
  const nominal = fieldVerdicts(box, base, lay, sensor);
  // A pixel that does not overlap the field is not one of the row's: it counts for no plot.
  if (fieldRing) {
    const toUtm = proj4('EPSG:4326', crsToProj4Def(`EPSG:${epsg}`));
    const overlaps = fieldOverlapTest(fieldRing.map(([lng, lat]) => toUtm.forward([lng, lat]) as [number, number]));
    for (let k = 0; k < nominal.length; k++) {
      const [cE, cN] = rungCellOrigin(k, nx, e0, n0, r);
      if (!overlaps(cE, cN, r)) nominal[k] = MIXED;
    }
  }
  const pure = plotTally(nominal, plan.nPlots)?.min ?? 0;
  const ce90 = Math.round(rungCe90(ctx, rung.id, r) * 100) / 100;
  if (!(ce90 > 0)) return { pure, held: null };
  if (ce90 >= Math.min(plan.design.plotLength, plan.design.plotWidth) / 2) return { pure, held: 0 };
  const lands = ce90Shifts(ce90, rotationDeg);
  const mask = heldMask(nominal, lands.length, (q, need) => fieldVerdicts(box, [base[0] - lands[q][0], base[1] - lands[q][1]], lay, sensor, need));
  return { pure, held: plotTally(nominal, plan.nPlots, mask)?.min ?? 0 };
}
