import { PixelZone } from './zones';

/**
 * Single source of truth for every colour and label in the app.
 *
 * Colours encode four *different* things — keep their palettes visually
 * separate so a colour never means two things at once:
 *
 *   1. Pixel class (interior / edge·…) — the analysis output. Fixed, semantic
 *      palette below. Shown as the map dots and the default PCA colouring.
 *   2. Species (crp_lbl) — a per-crop hue from `speciesColor`. Shown as the
 *      polygon outlines (before zones) and an optional PCA colouring.
 *   3. Growth scenario (step 4 clusters) — `CLUSTER_COLORS` in
 *      species-clusters.ts. Shown as polygon fills after clustering.
 *   4. Generic categories (field, pair) — `categoricalColor`, only in the PCA.
 *
 * Palettes 2–4 deliberately avoid the four pixel-class hues so the views
 * never collide. Only one encoding is ever active in a given view, and every
 * view shows the matching legend.
 */

/** Neutral grey for "no class / unknown". */
export const NEUTRAL = '#94a3b8';

export interface ZoneClass {
  key: PixelZone;
  color: string;
  /** Compact label for chips, stat tiles, toggles. */
  short: string;
  /** Full label for the map legend; `d` is the buffer distance in metres. */
  long: (d: number) => string;
  /** One-sentence meaning, for tooltips / help. */
  describe: string;
}

/** The four pixel classes, in canonical order. The ONLY place they're defined. */
export const ZONE_CLASSES: ZoneClass[] = [
  {
    key: 'interior',
    color: '#34d399',
    short: 'Interior',
    long: d => `Interior — ≥ ${d} m inside the field`,
    describe: 'Core pixels, far enough from any boundary to be a pure single-crop signal.',
  },
  {
    key: 'edge_other_species',
    color: '#f87171',
    short: 'Edge · other species',
    long: () => 'Edge — other species across the boundary',
    describe: 'Boundary pixels facing a field of a different crop — the mixed pixels.',
  },
  {
    key: 'edge_same_species',
    color: '#fbbf24',
    short: 'Edge · same species',
    long: () => 'Edge — same species across the boundary',
    describe: 'Boundary pixels facing a field of the same crop.',
  },
  {
    key: 'edge_isolated',
    color: '#94a3b8',
    short: 'Edge · isolated',
    long: () => 'Edge — no neighbouring field',
    describe: 'Boundary pixels with no field across (road, hedge, open land).',
  },
];

/** zone key → colour. */
export const ZONE_COLOR: Record<string, string> = Object.fromEntries(ZONE_CLASSES.map(z => [z.key, z.color]));
export const zoneColor = (key: string | undefined): string => ZONE_COLOR[key ?? ''] ?? NEUTRAL;
export const zoneClass = (key: string): ZoneClass | undefined => ZONE_CLASSES.find(z => z.key === key);
export const zoneShort = (key: string): string => zoneClass(key)?.short ?? key;

// ----- Species -----------------------------------------------------------------

/**
 * Per-crop hues — vivid cyan / orange / blue / purple. Chosen to punch through
 * the green / brown / pinkish false-colour field imagery (so no green, yellow
 * or brown of their own) and to stay clear of the pixel-class colours above
 * (no red, which is edge·other). Cyan and orange (a max-contrast pair) sit at
 * the two slots the two main crops hash to.
 */
const SPECIES_PALETTE = [
  '#ff5e00', // deep orange
  '#9b5cff', // violet
  '#c026ff', // purple
  '#2f6bff', // blue
  '#ff9100', // orange
  '#00b8d4', // teal-cyan
  '#00e5ff', // cyan        ← Maïs ensilage
  '#d000ff', // magenta-purple
  '#00aaff', // azure
  '#7d3cff', // violet
  '#ffab00', // amber
  '#ff7a00', // orange      ← Luzerne
];

/** Deterministic colour for a crop label (same crop → same colour every run). */
export const speciesColor = (crpLbl: string | undefined): string => {
  if (!crpLbl) return '#e2e8f0';
  let hash = 0;
  for (let i = 0; i < crpLbl.length; i++) {
    hash = (hash << 5) - hash + crpLbl.charCodeAt(i);
    hash &= hash;
  }
  return SPECIES_PALETTE[Math.abs(hash) % SPECIES_PALETTE.length];
};

// ----- Generic categorical (field, pair) ---------------------------------------

/** Neutral categorical ramp for the PCA's field / pair colouring. */
const CATEGORICAL = [
  '#38bdf8', '#a78bfa', '#f472b6', '#22d3ee', '#a3e635', '#fb923c',
  '#e879f9', '#60a5fa', '#2dd4bf', '#c084fc',
];
export const categoricalColor = (i: number): string => CATEGORICAL[((i % CATEGORICAL.length) + CATEGORICAL.length) % CATEGORICAL.length];
