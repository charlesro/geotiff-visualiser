/**
 * An experimental design uploaded as a file: real plot polygons and the
 * attributes they carry. Shared by the file reader (design-import), the
 * resolver that puts it on a grid (imported-plan) and the engine (simulate),
 * so none of them re-describes the others' data.
 *
 * Each distinct value of the variety column is its OWN species (its own growth
 * curve, colour and purity count), and every plot carrying that value is one
 * repetition of it.
 */

export type LngLat = [number, number];

export interface ImportedPlot {
  /**
   * The plot's rings in WGS84 [lng, lat]: every outer ring and hole it has (a
   * MultiPolygon contributes all of its polygons' rings). What is inside is
   * decided by the even-odd rule over all of them together.
   */
  rings: LngLat[][];
  /** Every attribute the file gave this plot, as text ('' for null or missing). */
  props: Record<string, string>;
}

export interface ImportedDesign {
  /** What the user uploaded, for display (e.g. "trial_plots.zip"). */
  fileName: string;
  plots: ImportedPlot[];
  /** The attribute columns, in the file's order. */
  columns: string[];
  /** The column whose values are the varieties (auto-detected, user-changeable). */
  varietyColumn: string;
  /** The column naming each plot, or '' to number plots instead. */
  nameColumn: string;
  /** What the reader did that the user should know about (skipped features, CRS used...). */
  warnings: string[];
}

/** One variety of a design: a species of the simulation. */
export interface ImportedVariety {
  /** The raw value in the variety column; identity, never shown shortened. */
  key: string;
  /** A readable label derived from the key (e.g. a URL's variety segment). */
  label: string;
  /** Number of plots carrying it: its repetitions. */
  plots: number;
  /** CROP_PRESETS id the reader guessed for its growth curve. */
  crop: string;
}

/** The design resolved against a grid's UTM CRS: what the engine rasterises. */
export interface ImportedPlan {
  epsg: number;
  /** Each plot's rings in metres of `epsg`, and the species (variety index) it grows. */
  plots: { rings: [number, number][][]; species: number }[];
  /**
   * Cover id to species index, handed to the engine as `coverSpecies`. Cover ids
   * are PLOT ids (plotIds true) so a pixel straddling two plots of one variety
   * is not called pure; with more plots than the cover map can number, they fall
   * back to SPECIES ids (plotIds false) and this is the identity.
   */
  coverSpecies: Uint8Array;
  plotIds: boolean;
  nSpecies: number;
  /**
   * The trial's footprint (convex hull of every plot vertex), in metres: ground
   * inside it that no plot covers is bare alley, ground outside it is off-trial.
   */
  footprint: [number, number][];
  /** [minE, minN, maxE, maxN] of the footprint. */
  bbox: [number, number, number, number];
  /** Narrowest feature the fine grid must resolve, in metres (plot width or gap between plots). */
  minFeature: number;
  /** Stable signature of the geometry and the assignment, for layoutKey. */
  sig: string;
}
