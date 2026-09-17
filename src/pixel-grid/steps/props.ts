import type { useAoiField, usePlaceSearch } from '../use-area';
import type { useFieldGrid } from '../use-grid';
import type { Experiment, useSimulation, usePcaSim } from '../use-simulation';
import type { ColorBy, ShapeBy } from '../pca-field';

/**
 * What every step panel is handed. One shared bag rather than four bespoke prop
 * lists: the steps read across each other's data constantly (step 4 edits the
 * planting design step 3 owns; step 3 reports a purity that depends on step 2's
 * sensor), so a "minimal" per-step list would be neither minimal nor stable.
 */
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
  showPsf: boolean;
  setShowPsf: (v: boolean | ((p: boolean) => boolean)) => void;
  /**
   * Open/closed state for every disclosure and tab strip inside a step panel.
   * These live in the SHELL, not in the panels: `Step` renders {open && children},
   * so a collapsed step unmounts its subtree and any state held there is lost.
   */
  simAdvOpen: boolean; setSimAdvOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  pcaRetuneOpen: boolean; setPcaRetuneOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  /** Show the resolution ladder twice — at the current rotation and at 0°. */
  compareAligned: boolean; setCompareAligned: (v: boolean | ((p: boolean) => boolean)) => void;
  /**
   * How PCA points are coloured and shaped. Here rather than in the scatter so the
   * resolution ladder uses the very same encoding as the chart above it.
   */
  pcaColorBy: ColorBy; setPcaColorBy: (c: ColorBy) => void;
  pcaShapeBy: ShapeBy; setPcaShapeBy: (s: ShapeBy) => void;
  /** Reading a trial file: owned by the shell, since a read can outlast a collapsed step. */
  importApi: {
    busy: boolean;
    error: string | null;
    onFiles: (files: File[]) => void;
    onRemove: () => void;
    setVarietyColumn: (column: string) => void;
    setNameColumn: (column: string) => void;
    /** Turn the imported trial to this angle from the pixel rows, in degrees. */
    setAngle: (deg: number) => void;
  };
  /** The per-variety growth-curve editors of an imported trial, folded by default. */
  curvesOpen: boolean; setCurvesOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  /** So the compare button in step 3 can jump to where the ladders are drawn. */
  setActiveStep: (s: 'area' | 'grid' | 'sim' | 'pca' | null) => void;
}
