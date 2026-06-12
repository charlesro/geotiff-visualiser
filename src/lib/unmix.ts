import { PixelZone, ZoneExtraction, featureKey } from './zones';

/**
 * Linear spectral unmixing of the mixed boundary pixels.
 *
 * A pixel straddling the boundary between two crops is a spatial mixture of
 * the two surfaces. Modelled linearly over the time series:
 *
 *   pixel ≈ α · ownEndmember + (1 − α) · partnerEndmember
 *
 * where α ∈ [0, 1] is the fraction of the pixel's own field. The endmembers
 * are the "pure" signatures from the interior pixels:
 *   - own:     the pixel's own field interior mean (falls back to the own
 *              species' global interior mean when the field has too little
 *              interior — e.g. narrow fields)
 *   - partner: a neighbouring species' global interior mean; with more than
 *              two species the partner is the one giving the best fit
 *
 * α is solved by constrained least squares (closed form, clamped to [0, 1])
 * and written onto the pixel feature as `mix_fraction` (own), `mix_partner`
 * (species) and `mix_residual` (normalised goodness of fit). Only
 * edge_other_species pixels are unmixed — the only class that is genuinely a
 * mixture of two different signals.
 */

/** A field needs at least this many interior pixels to be its own endmember. */
const MIN_FIELD_INTERIOR = 4;

const speciesOfProps = (p: any): string => String(p?.crp_lbl ?? p?.species ?? 'unknown');

export interface UnmixingSummary {
  /** Edge_other_species pixels that were successfully unmixed. */
  count: number;
  /** Mean own-field fraction across them. */
  meanFraction: number;
  /** 10-bin histogram of the own fraction (0–0.1 … 0.9–1.0). */
  histogram: number[];
  /** Pixels skipped (incomplete series or no usable endmember pair). */
  skipped: number;
}

const vecOf = (props: any, prefix: string, dates: string[]): number[] | null => {
  const v: number[] = [];
  for (const d of dates) {
    const x = props[prefix + d];
    if (typeof x !== 'number' || !isFinite(x)) return null;
    v.push(x);
  }
  return v;
};

const meanRows = (rows: number[][]): number[] => {
  const m = new Array(rows[0].length).fill(0);
  for (const r of rows) for (let i = 0; i < r.length; i++) m[i] += r[i];
  return m.map(x => x / rows.length);
};

/**
 * Compute the mixing fractions in place: mutates the edge feature properties
 * of `zones` and returns a summary. Safe to call again (idempotent).
 */
export function computeUnmixing(zones: ZoneExtraction): UnmixingSummary {
  const prefix = `${zones.metric}_`;
  const dates = zones.dates;

  // Endmembers from the interior pixels: per field and per species.
  const fieldRows = new Map<string, number[][]>();
  const speciesRows = new Map<string, number[][]>();
  for (const f of zones.interior.features) {
    const v = vecOf(f.properties, prefix, dates);
    if (!v) continue;
    const key = featureKey(f);
    (fieldRows.get(key) ?? fieldRows.set(key, []).get(key)!).push(v);
    const sp = speciesOfProps(f.properties);
    (speciesRows.get(sp) ?? speciesRows.set(sp, []).get(sp)!).push(v);
  }
  const fieldMean = new Map<string, number[]>();
  for (const [k, rows] of fieldRows) if (rows.length >= MIN_FIELD_INTERIOR) fieldMean.set(k, meanRows(rows));
  const speciesMean = new Map<string, number[]>();
  for (const [k, rows] of speciesRows) speciesMean.set(k, meanRows(rows));

  const histogram = new Array(10).fill(0);
  let count = 0;
  let skipped = 0;
  let fracSum = 0;

  for (const f of zones.edge.features) {
    const props = f.properties;
    if (props?.zone !== 'edge_other_species') {
      // Not a two-species mixture — clear any stale value.
      if (props) {
        delete props.mix_fraction;
        delete props.mix_partner;
        delete props.mix_residual;
      }
      continue;
    }
    const p = vecOf(props, prefix, dates);
    const ownSp = speciesOfProps(props);
    const own = fieldMean.get(featureKey(f)) ?? speciesMean.get(ownSp);
    if (!p || !own) {
      skipped++;
      continue;
    }

    // Partner endmember: the other species giving the lowest residual.
    let best: { partner: string; alpha: number; resid: number } | null = null;
    for (const [sp, mean] of speciesMean) {
      if (sp === ownSp) continue;
      const { alpha, resid } = solve(p, own, mean);
      if (!best || resid < best.resid) best = { partner: sp, alpha, resid };
    }
    if (!best) {
      skipped++;
      continue;
    }

    props.mix_fraction = best.alpha;
    props.mix_partner = best.partner;
    props.mix_residual = best.resid;
    fracSum += best.alpha;
    histogram[Math.min(9, Math.floor(best.alpha * 10))]++;
    count++;
  }

  return { count, meanFraction: count > 0 ? fracSum / count : 0, histogram, skipped };
}

/** Closed-form constrained least squares for p ≈ α·A + (1−α)·B, α∈[0,1]. */
function solve(p: number[], A: number[], B: number[]): { alpha: number; resid: number } {
  let num = 0;
  let den = 0;
  for (let i = 0; i < p.length; i++) {
    const ab = A[i] - B[i];
    num += (p[i] - B[i]) * ab;
    den += ab * ab;
  }
  let alpha = den > 0 ? num / den : 0.5;
  alpha = Math.max(0, Math.min(1, alpha));
  // Normalised residual: fit error relative to the endmember separation.
  let err = 0;
  let sep = 0;
  for (let i = 0; i < p.length; i++) {
    const fit = alpha * A[i] + (1 - alpha) * B[i];
    err += (p[i] - fit) ** 2;
    sep += (A[i] - B[i]) ** 2;
  }
  const resid = sep > 0 ? Math.sqrt(err / sep) : Math.sqrt(err);
  return { alpha, resid };
}

/** Interpolate two hex colours (#rrggbb) at t∈[0,1]. */
export function mixHexColors(c0: string, c1: string, t: number): string {
  const h = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const [r0, g0, b0] = h(c0);
  const [r1, g1, b1] = h(c1);
  const u = Math.max(0, Math.min(1, t));
  const mix = (a: number, b: number) => Math.round(a + (b - a) * u);
  return `#${[mix(r0, r1), mix(g0, g1), mix(b0, b1)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

export const UNMIXED_ZONES: PixelZone[] = ['edge_other_species'];

/** Sequential colour scale for the own-field fraction: 0 (neighbour) → 1 (own). */
export const MIX_LOW = '#a855f7';
export const MIX_HIGH = '#facc15';
