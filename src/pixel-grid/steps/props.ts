import type { useAoiField, usePlaceSearch } from '../use-area';
import type { useFieldGrid } from '../use-grid';
import type { Experiment, useSimulation, usePcaSim } from '../use-simulation';
import type { ColorBy, ShapeBy } from '../pca-field';
import type { SuggestAsk, SuggestOutcome } from './SuggestDesign';

/**
 * What every step panel is handed. One shared bag rather than four bespoke prop
 * lists: the steps read across each other's data constantly (step 4 edits the
 * planting design step 3 owns; step 3 reports a purity that depends on step 2's
 * sensor), so a "minimal" per-step list would be neither minimal nor stable.
 */
/**
 * The "Pixel grid & export" step is KEPT IN THE CODE AND NOT SHOWN ("remove
 * the pixel grid and export tab (keep in the code just in case but dont show
 * on interface)", 2026-11-21). Everything it owns still runs: the satellite,
 * its blur and its geolocation error, the grid and its export are the page's
 * state, not the panel's. What the reader loses with the panel is the place
 * to type them. The satellite is still chosen in "Suggest a design" and by
 * clicking a row of the satellites table; the blur and the CE90 stay at their
 * defaults, or at what this browser last had.
 *
 * Set to true to bring the step back: the numbers the steps are shown under,
 * the step a finished drawing opens and the sentences that name a step all
 * follow from it.
 */
export const SHOW_GRID_STEP = false;

/** The number each step is shown under. */
export const STEP_NO = SHOW_GRID_STEP ? { area: 1, grid: 2, sim: 3, pca: 4 } : { area: 1, grid: 2, sim: 2, pca: 3 };

/** The folds of the Simulate experiment step. */
/** The plots of a block design that "Use these" changes. */
export interface PlotsSetting { plotLength: number; plotWidth: number; blocksPerRow: number; /** The trial's angle, when Use these turned it along the field. */ rotation?: number }
/** The plots before "Use these", and the plots it set. */
export interface MostUndo { from: PlotsSetting; to: PlotsSetting }

export type SimSection = 'sat' | 'design' | 'suggest' | 'size' | 'curves' | null;

export interface StepProps {
  activeStep: 'area' | 'grid' | 'sim' | 'pca' | null;
  toggleStep: (s: 'area' | 'grid' | 'sim' | 'pca') => void;
  area: ReturnType<typeof useAoiField>;
  search: ReturnType<typeof usePlaceSearch>;
  gridApi: ReturnType<typeof useFieldGrid>;
  exp: Experiment;
  sim: ReturnType<typeof useSimulation>;
  pca: ReturnType<typeof usePcaSim>;
  areaSummary: string;
  gridSummary: string;
  simSummary: string;
  geoKey: string;
  /**
   * Open/closed state for every disclosure and tab strip inside a step panel.
   * These live in the SHELL, not in the panels: `Step` renders {open && children},
   * so a collapsed step unmounts its subtree and any state held there is lost.
   */
  /**
   * Which fold of step 3 is open: one at a time, or none. The step was a
   * single column of everything (the design's nine fields, a summary, the
   * suggestion, the plot-size table, the crops, the noise), 1,100 px of it in
   * a panel that shows 450.
   */
  simSection: SimSection; setSimSection: (v: SimSection | ((p: SimSection) => SimSection)) => void;
  /** Step 2's blur and geolocation section: the two inputs and the budget they add up to. */
  blurOpen: boolean; setBlurOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  pcaRetuneOpen: boolean; setPcaRetuneOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  /**
   * How the resolution ladder is laid out: a table of its figures, or the small
   * scatter plots they used to be the captions of.
   */
  ladderView: 'table' | 'charts'; setLadderView: (v: 'table' | 'charts') => void;
  /** Show the resolution ladder twice: at the current rotation and at 0°. */
  compareAligned: boolean; setCompareAligned: (v: boolean | ((p: boolean) => boolean)) => void;
  /**
   * How PCA points are coloured and shaped. Here rather than in the scatter so the
   * resolution ladder uses the very same encoding as the chart above it.
   */
  pcaColorBy: ColorBy; setPcaColorBy: (c: ColorBy) => void;
  pcaShapeBy: ShapeBy; setPcaShapeBy: (s: ShapeBy) => void;
  /** Reading a trial file: owned by the shell, since a read can outlast a collapsed step. */
  /** See PixelGridApp: the angle the comparison's left ladder is pinned to. */
  compareFrom: number | null;
  /** `to`: the angle of the placement being adopted, the pixel rows when left out. */
  setCompareFrom: (deg: number | null, to?: number) => void;
  /**
   * Turning the trial from a CONTROL rather than from the ladder. It forgets any
   * remembered angle, because a hand-set angle is the design's own again. (An
   * imported trial set to 0 this way is still compared with the file's angle,
   * which needs no remembering.) The ladder uses importApi.setAngle directly
   * so that it can remember one.
   */
  setAngleByHand: (deg: number) => void;
  importApi: {
    busy: boolean;
    error: string | null;
    onFiles: (files: File[]) => void;
    onRemove: () => void;
    setVarietyColumn: (column: string) => void;
    setNameColumn: (column: string) => void;
    /** Turn the imported trial to this angle from the pixel rows, in degrees. */
    setAngle: (deg: number) => void;
    /** Put the trial where a rung of the best-placement ladder has it: turned, then moved. */
    setPlacement: (turn: number, shift: [number, number]) => void;
  };
  /**
   * How many pure pixels the last row of the plot-size card asks for: in every
   * plot, or across a strip. In the shell because the card is shown in two
   * steps and a collapsed step forgets what it held.
   */
  wantPure: number; setWantPure: (n: number) => void;
  /**
   * What "Use these" of the plot-size card replaced, and what it set, so that
   * its button can put the plots back while the design is still the one it set
   * (2026-11-24: "this should be a button allowing to go back to the previous
   * settings"). In the shell, and saved, for the same reason as `wantPure`.
   */
  mostUndo: MostUndo | null; setMostUndo: (u: MostUndo | null) => void;
  /**
   * "Suggest a design" in step 3: what is asked of the trial, the last trial
   * built from it, and the build itself. In the shell because a build writes
   * the design, the angle and the satellite at once, and because step 3
   * forgets everything it holds when folded.
   */
  suggest: {
    ask: SuggestAsk; setAsk: (a: SuggestAsk) => void;
    busy: boolean;
    /** How far the build running has got: steps done of all, and what is being worked out. */
    progress: { done: number; total: number; what: string } | null;
    outcome: SuggestOutcome | null;
    build: () => void;
  };
  /** The per-variety growth-curve editors of an imported trial, folded by default. */
  curvesOpen: boolean; setCurvesOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  /** So the compare button in step 3 can jump to where the ladders are drawn. */
  setActiveStep: (s: 'area' | 'grid' | 'sim' | 'pca' | null) => void;
}
