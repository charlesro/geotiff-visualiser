import type { LngLatBounds } from './s2-grid';

/**
 * Pure planar geometry over WGS84 rings — the predicates the page uses to ask
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
 * — here `subject` = the field, `win` = the rectangle, giving field ∩ rectangle.
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

export { pointInPoly, polyBbox, cellCenter, polyAreaHa, clipPolygon };
export type { Poly };
