import type { LngLatBounds } from './s2-grid';

/**
 * Pure planar geometry over WGS84 rings: the predicates the page uses to ask
 * "is this pixel in the field?" and "what does this strip look like clipped to
 * it?". No React, no Leaflet, no projection: callers hand in rings and get
 * rings back.
 *
 * Two contracts here are silent-wrong-answer traps if a caller ignores them,
 * so they are stated on each function rather than assumed: `cellCenter` averages
 * the FIRST FOUR vertices only, and `clipPolygon`'s window must be CONVEX.
 */

/** A drawn field shape: WGS84 ring [lng,lat]. */
type Poly = [number, number][];
/** Ray-casting point-in-polygon (ring not required to be closed). */
const pointInPoly = (lng: number, lat: number, ring: Poly): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
/** Bounding box [w,s,e,n] of a ring. */
const polyBbox = (ring: Poly): LngLatBounds => {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of ring) { w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat); }
  return [w, s, e, n];
};
/** Centre [lng,lat] of a grid cell (average of its 4 corners). */
const cellCenter = (ring: [number, number][]): [number, number] => {
  let x = 0, y = 0;
  for (let i = 0; i < 4; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / 4, y / 4];
};
/** Spherical polygon area in hectares (shoelace on an equirectangular projection). */
const polyAreaHa = (ring: Poly): number => {
  if (ring.length < 3) return 0;
  const R = 6378137, lat0 = (ring.reduce((a, [, lat]) => a + lat, 0) / ring.length) * Math.PI / 180;
  const pts = ring.map(([lng, lat]) => [lng * Math.PI / 180 * R * Math.cos(lat0), lat * Math.PI / 180 * R]);
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a) / 2 / 1e4;
};
/**
 * Sutherland–Hodgman: clip `subject` (any polygon) by the CONVEX `win` window.
 * Used to clip a crop-strip rectangle to the (possibly non-convex) field polygon
 * Here `subject` = the field, `win` = the rectangle, giving field ∩ rectangle.
 */
const clipPolygon = (subject: Poly, win: Poly): Poly => {
  if (subject.length < 3 || win.length < 3) return [];
  let area = 0;
  for (let i = 0; i < win.length; i++) { const [x1, y1] = win[i], [x2, y2] = win[(i + 1) % win.length]; area += x1 * y2 - x2 * y1; }
  const ccw = area > 0;
  const inside = (p: [number, number], a: [number, number], b: [number, number]) => {
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    return ccw ? c >= 0 : c <= 0;
  };
  const isect = (p: [number, number], q: [number, number], a: [number, number], b: [number, number]): [number, number] => {
    const a1 = b[1] - a[1], b1 = a[0] - b[0], c1 = a1 * a[0] + b1 * a[1];
    const a2 = q[1] - p[1], b2 = p[0] - q[0], c2 = a2 * p[0] + b2 * p[1];
    const det = a1 * b2 - a2 * b1;
    return Math.abs(det) < 1e-18 ? q : [(b2 * c1 - b1 * c2) / det, (a1 * c2 - a2 * c1) / det];
  };
  let out: Poly = subject.slice();
  for (let e = 0; e < win.length && out.length; e++) {
    const a = win[e], b = win[(e + 1) % win.length];
    const input = out; out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j], prev = input[(j + input.length - 1) % input.length];
      const curIn = inside(cur, a, b), prevIn = inside(prev, a, b);
      if (curIn) { if (!prevIn) out.push(isect(prev, cur, a, b)); out.push(cur); }
      else if (prevIn) out.push(isect(prev, cur, a, b));
    }
  }
  return out;
};

/**
 * A test for "does this pixel belong to the field": true when the pixel's
 * square and the field ring share some AREA, in the same planar metres (UTM).
 *
 * The rule used to be "the pixel's CENTRE is in the field". A field tilted to
 * the pixel rows, an imported trial above all, then had corners that no kept
 * pixel covered: holes in the parcels, on the map, in the export, in the PCA.
 * Every pixel that sees any of the field now belongs to it; the ones mostly
 * outside are still left out of purity and the PCA by the off-trial share.
 * A square that only touches the ring along an edge or at a corner does not
 * count (its shared area is zero). The ring's box is computed once.
 */
const fieldOverlapTest = (ring: Poly) => {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return (e0: number, n0: number, size: number): boolean => {
    const e1 = e0 + size, n1 = n0 + size;
    if (e1 <= w || e0 >= e || n1 <= s || n0 >= n || ring.length < 3) return false;
    const part = clipPolygon(ring, [[e0, n0], [e1, n0], [e1, n1], [e0, n1]]);
    if (part.length < 3) return false;
    let a = 0;
    for (let i = 0, j = part.length - 1; i < part.length; j = i++) a += part[j][0] * part[i][1] - part[i][0] * part[j][1];
    return Math.abs(a) / 2 > 1e-9 * size * size;
  };
};

/**
 * Would a map centred here, in WGS84 [lat, lng], still be showing this field?
 *
 * The map reopens where it was left, and that view is saved under its own key,
 * independently of the field. The two can end up describing different places:
 * an import moves the field to the trial, removing it moves the field back, and
 * a pinned default field can be on another continent entirely, while the saved
 * view stays wherever the map last happened to be. Reopening there shows bare
 * ground with no grid on it, which reads as "the tool is broken" rather than
 * "you are looking somewhere else".
 *
 * The margin is the field's own span, with a floor of about a kilometre: at the
 * zoom this page opens on, a centre further off than that has no part of the
 * field on screen.
 */
const viewShowsField = (center: [number, number], field: [number, number, number, number] | null): boolean => {
  if (!field) return true; // no field to miss
  const [w, s, e, n] = field;
  const padLng = Math.max(e - w, 0.01), padLat = Math.max(n - s, 0.01);
  const [lat, lng] = center;
  return lng >= w - padLng && lng <= e + padLng && lat >= s - padLat && lat <= n + padLat;
};

export { pointInPoly, polyBbox, cellCenter, polyAreaHa, clipPolygon, fieldOverlapTest, viewShowsField };
export type { Poly };
