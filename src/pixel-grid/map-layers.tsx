import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleMarker, GeoJSON, Polygon, Polyline, Rectangle, Tooltip as LTooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import { clipPolygon, type Poly } from './geometry';
import { cultureForCell, type SimLayout, BARE } from './simulate';
import type { LngLatBounds } from './s2-grid';

/**
 * Everything drawn ON the Leaflet map, and the two draw tools that put a field
 * there. Kept in one file because the layers' stacking is encoded in the two
 * custom pane z-indices below ('truth' at 300, 'psf' at 460) — they are only
 * meaningful relative to each other and to Leaflet's own overlay pane, so
 * splitting them apart invites a silent re-ordering.
 *
 * Note `Tooltip` is imported as `LTooltip`: recharts exports a `Tooltip` too,
 * and the page renders both.
 */

const BASEMAPS = {
  // Esri's Dark Gray Canvas, not CARTO's dark_all: CARTO now requires an API key
  // and stamps "API KEY REQUIRED" across every tile it serves without one. Esri's
  // canvas is keyless, but its imagery stops at zoom 16 (above that it returns a
  // "no data" placeholder), so FieldMap caps maxNativeZoom at 16 for this layer.
  dark: {
    label: 'Dark',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri · Esri, HERE, Garmin, © OpenStreetMap contributors',
    light: false,
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri · Source: Esri, Maxar, Earthstar Geographics',
    light: false,
  },
  topo: {
    label: 'Topo',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri · Source: Esri, HERE, Garmin, FAO, NOAA',
    light: true,
  },
  streets: {
    label: 'Streets',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    light: true,
  },
} as const;
type BasemapKey = keyof typeof BASEMAPS;

const AOI_STYLE: L.PathOptions = { color: '#38bdf8', weight: 2, fillOpacity: 0, interactive: false };

/**
 * Renders the field "as it really is" — the crisp planting pattern (crop A vs B
 * at full resolution) as *vector* polygons beneath the pixel grid, drawn with an
 * SVG renderer so the strip boundaries stay clean lines (no rasterised stairs).
 * The pattern is built in the rotated UTM frame (where strips are axis-aligned
 * rectangles), then projected back to WGS84, so it lines up with the grid cells.
 */
function TruthOverlay({ extent, epsg, layout, origin, colorA, colorB, clipPoly }: {
  extent: [number, number, number, number]; epsg: number; layout: SimLayout; origin: [number, number]; colorA: string; colorB: string; clipPoly?: Poly;
}) {
  const map = useMap();
  useEffect(() => {
    const inv = proj4(crsToProj4Def(`EPSG:${epsg}`), 'EPSG:4326'); // UTM → [lng,lat]
    const [ox, oy] = origin;
    const W = layout.width;
    const t = (layout.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(t), sin = Math.sin(t);
    // Bounds to fill: the whole field polygon (when clipping) so the pattern covers
    // the field, not just the viewport; otherwise the given extent.
    let [minE, minN, maxE, maxN] = extent;
    if (clipPoly && clipPoly.length >= 3) {
      const fwd = proj4('EPSG:4326', crsToProj4Def(`EPSG:${epsg}`));
      minE = Infinity; minN = Infinity; maxE = -Infinity; maxN = -Infinity;
      for (const [lng, lat] of clipPoly) { const [E, N] = fwd.forward([lng, lat]) as [number, number]; minE = Math.min(minE, E); minN = Math.min(minN, N); maxE = Math.max(maxE, E); maxN = Math.max(maxN, N); }
    }
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const [E, N] of [[minE, minN], [maxE, minN], [maxE, maxN], [minE, maxN]] as [number, number][]) {
      const dx = E - ox, dy = N - oy;
      const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
      uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
    }
    const S = Math.max(0, layout.spacing || 0);
    const P = W + S; // strip width + bare alley
    // (u,v) corner → [lng,lat], inverse-rotating back to UTM first.
    const toLngLat = (u: number, v: number): [number, number] =>
      inv.forward([ox + u * cos - v * sin, oy + u * sin + v * cos]) as [number, number];

    const features: any[] = [];
    const pushRect = (u0: number, u1: number, v0: number, v1: number, cult: number) => {
      const rect: Poly = [toLngLat(u0, v0), toLngLat(u1, v0), toLngLat(u1, v1), toLngLat(u0, v1)];
      let ring: Poly;
      if (clipPoly && clipPoly.length >= 3) {
        const c = clipPolygon(clipPoly, rect); // keep only the part inside the traced field
        if (c.length < 3) return;
        ring = [...c, c[0]];
      } else {
        ring = [...rect, rect[0]];
      }
      features.push({ type: 'Feature', properties: { cult }, geometry: { type: 'Polygon', coordinates: [ring] } });
    };
    // Each crop strip occupies width W of every period P; the S-wide alleys are
    // painted bare-soil brown (a full bare backdrop, with the crop strips on top).
    const cMin = Math.floor(uMin / P), cMax = Math.floor(uMax / P);
    const rMin = Math.floor(vMin / P), rMax = Math.floor(vMax / P);
    if (S > 0) pushRect(uMin, uMax, vMin, vMax, BARE.id);
    if (layout.pattern === 'row' || layout.pattern === 'strip-row-2') {
      for (let r = rMin; r <= rMax; r++) pushRect(uMin, uMax, r * P, r * P + W, cultureForCell(r, 0, layout.pattern));
    } else if (layout.pattern === 'col' || layout.pattern === 'strip-col-2') {
      for (let c = cMin; c <= cMax; c++) pushRect(c * P, c * P + W, vMin, vMax, cultureForCell(0, c, layout.pattern));
    } else { // checker — square plots with an alley on every side
      for (let r = rMin; r <= rMax; r++)
        for (let c = cMin; c <= cMax; c++) pushRect(c * P, c * P + W, r * P, r * P + W, cultureForCell(r, c, layout.pattern));
    }

    if (!map.getPane('truth')) { map.createPane('truth'); map.getPane('truth')!.style.zIndex = '300'; }
    const renderer = L.svg({ pane: 'truth', padding: 1 });
    const layer = L.geoJSON({ type: 'FeatureCollection', features } as any, {
      pane: 'truth',
      interactive: false,
      // same-colour stroke closes the hairline seams between adjacent bands
      style: (f: any) => {
        const col = f.properties.cult === 0 ? colorA : f.properties.cult === 1 ? colorB : BARE.color;
        return { renderer, stroke: true, color: col, weight: 1, opacity: 1, fill: true, fillColor: col, fillOpacity: 1 };
      },
    });
    layer.addTo(map);
    return () => { layer.remove(); };
  }, [map, extent[0], extent[1], extent[2], extent[3], epsg, layout.pattern, layout.width, layout.spacing, layout.rotationDeg, origin[0], origin[1], colorA, colorB, clipPoly]);
  return null;
}

/**
 * The pixel grid drawn as LINES (one MultiLineString) instead of one polygon
 * per cell — O(rows+cols) not O(rows×cells), so even a 0.3 m grid draws fast.
 * `box` is the UTM window to draw (the visible part of the field).
 */
/** Smallest gap between ruled lines, in screen pixels, before they stop being readable. */
const MIN_LINE_GAP_PX = 6;

function GridLines({ box, res, epsg, color, weight, onStep }: {
  box: [number, number, number, number]; res: number; epsg: number; color: string; weight: number;
  /** Reports the ruled spacing in metres when it is coarser than one pixel, else 0. */
  onStep?: (stepM: number) => void;
}) {
  const map = useMap();
  const mpp = (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();
  const cellPx = res / mpp;
  // Zoomed out, a 10 m pixel covers a fraction of a screen pixel, and ruling
  // every edge produced a mesh so faint it read as an empty map. That is the
  // first thing a freshly drawn area showed. Rule every k-th edge instead, so
  // the gap on screen stays readable and the lines stay solid. Every line is
  // still a real pixel edge, and they are anchored to absolute multiples of the
  // step rather than to the clipped box, so they do not crawl as you pan.
  const stride = Math.max(1, Math.ceil(MIN_LINE_GAP_PX / Math.max(cellPx, 1e-6)));
  const step = res * stride;
  const data = useMemo(() => {
    const [minE, minN, maxE, maxN] = box;
    // Anchored to the LATTICE, not to round numbers. box[0]/box[1] sit on a
    // pixel edge, so (box mod res) is the lattice phase and is invariant as the
    // clipped box moves: lines stay on real pixel edges and still do not crawl
    // while panning. Plain multiples of the step drew the Sentinel-2 lattice on
    // top of a Landsat grid, 15 m from the pixels the shapefile exports.
    const pE = ((minE % res) + res) % res, pN = ((minN % res) + res) % res;
    const e0 = Math.ceil((minE - pE) / step) * step + pE;
    const n0 = Math.ceil((minN - pN) / step) * step + pN;
    const nx = Math.floor((maxE - e0) / step), ny = Math.floor((maxN - n0) / step);
    if (nx < 0 || ny < 0 || nx > 1500 || ny > 1500) return null;
    const inv = proj4(crsToProj4Def(`EPSG:${epsg}`), 'EPSG:4326');
    const lines: [number, number][][] = [];
    for (let i = 0; i <= nx; i++) { const E = e0 + i * step; lines.push([inv.forward([E, minN]) as [number, number], inv.forward([E, maxN]) as [number, number]]); }
    for (let j = 0; j <= ny; j++) { const N = n0 + j * step; lines.push([inv.forward([minE, N]) as [number, number], inv.forward([maxE, N]) as [number, number]]); }
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }] } as GeoJSON.FeatureCollection;
  }, [box[0], box[1], box[2], box[3], step, epsg]);
  useEffect(() => { onStep?.(stride > 1 ? step : 0); }, [onStep, stride, step]);
  if (!data) return null;
  // Stroke and opacity follow the RULED gap, not the pixel size, so a strided
  // grid is as legible as a close-up one instead of fading away.
  const gapPx = cellPx * stride;
  const w = Math.max(0.35, Math.min(weight, gapPx * 0.16));
  const opacity = Math.max(0.35, Math.min(0.6, gapPx / 5));
  return <GeoJSON key={`gl-${box.join('_')}-${step}-${color}-${w.toFixed(2)}-${opacity.toFixed(2)}`} data={data} style={() => ({ color, weight: w, opacity, interactive: false }) as L.PathOptions} />;
}

/**
 * The sensor PSF drawn on the ground as a bold, smooth Gaussian glow (a real
 * exp(−r²/2σ²) footprint rendered to a canvas and placed as a georeferenced
 * ImageOverlay, so it scales with zoom), plus a crisp FWHM ring — so you can see
 * how far one ground point's signal actually spreads across the pixel grid.
 */
function PsfOverlay({ center, sigmaXM, sigmaYM, fwhmXM, fwhmYM, light = false }: {
  center: [number, number]; sigmaXM: number; sigmaYM: number; fwhmXM: number; fwhmYM: number;
  /** True for a pale basemap — see the blend-mode note below. */
  light?: boolean;
}) {
  const map = useMap();
  const sMax = Math.max(sigmaXM, sigmaYM);
  useEffect(() => {
    if (sMax <= 0) return;
    const K = 3.2;                       // draw out to ±3.2σ
    const N = 220;
    const cv = document.createElement('canvas'); cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(N, N);
    const sPix = N / (2 * K);            // σ in canvas pixels
    const c = (N - 1) / 2;
    // The canvas holds a CIRCULAR unit Gaussian; the anisotropy comes from the
    // geographic bounds below, which stretch it by σx and σy independently.
    //
    // Alpha carries a GAMMA rather than tracking the Gaussian linearly. Linear
    // alpha falls to 32/255 by 2σ and 12/255 by 2.45σ — so the glow looked like
    // it stopped at about 1.5σ, while 95% of a point's energy needs 2.45σ. The
    // picture read as a far tighter footprint than the sensor actually has. The
    // gamma only affects how far the haze stays *perceptible*; the two contour
    // rings below carry the quantitative claim.
    const GAMMA = 0.7;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = x - c, dy = y - c;
      const g = Math.exp(-0.5 * (dx * dx + dy * dy) / (sPix * sPix));
      const o = (y * N + x) * 4;
      // Screen-blended sky-400 over a dark map; multiply-blended deep blue over a
      // pale one. A single colour cannot work for both: `screen` lightens, so on
      // a white basemap it produced white on white and the footprint vanished.
      if (light) { img.data[o] = 3; img.data[o + 1] = 105; img.data[o + 2] = 161; }   // sky-700
      else { img.data[o] = 56; img.data[o + 1] = 189; img.data[o + 2] = 248; }        // sky-400
      img.data[o + 3] = Math.round((light ? 210 : 235) * Math.pow(g, GAMMA));
    }
    ctx.putImageData(img, 0, 0);
    const [lat, lng] = center;
    const dLat = (K * sigmaYM) / 111320;
    const dLng = (K * sigmaXM) / (111320 * Math.cos((lat * Math.PI) / 180));
    const bounds = L.latLngBounds([lat - dLat, lng - dLng], [lat + dLat, lng + dLng]);
    if (!map.getPane('psf')) { const p = map.createPane('psf'); p.style.zIndex = '460'; p.style.pointerEvents = 'none'; }
    // Set every time, not just on creation: the pane outlives a basemap switch.
    map.getPane('psf')!.style.mixBlendMode = light ? 'multiply' : 'screen';
    const ov = L.imageOverlay(cv.toDataURL(), bounds, { pane: 'psf', interactive: false, opacity: 1 });
    ov.addTo(map);
    return () => { ov.remove(); };
  }, [map, center[0], center[1], sigmaXM, sigmaYM, light]);
  if (sMax <= 0) return null;

  // Leaflet has no ellipse, and these contours of an anisotropic Gaussian are
  // ellipses — so they are traced as polygons rather than faked with circles.
  //
  // TWO rings, because one was misleading. For a 2-D Gaussian the half-maximum
  // radius (FWHM/2 = 1.177σ) encloses exactly HALF the energy: half of every
  // ground point lands outside the inner ring. The outer ring is the 95%
  // contour at σ·sqrt(-2·ln 0.05) = 2.448σ — the honest extent of the smear.
  const [lat, lng] = center;
  const mPerLat = 111320, mPerLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const R95 = Math.sqrt(-2 * Math.log(0.05)); // 2.448 σ
  const ellipse = (rxM: number, ryM: number): [number, number][] =>
    Array.from({ length: 72 }, (_, k) => {
      const t = (k / 72) * 2 * Math.PI;
      return [lat + (ryM * Math.sin(t)) / mPerLat, lng + (rxM * Math.cos(t)) / mPerLng] as [number, number];
    });
  const fmt = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v));
  const aniso = Math.abs(fwhmXM - fwhmYM) >= 0.05;
  const dim = (x: number, y: number) => (aniso ? `${fmt(x)} × ${fmt(y)}` : `${fmt(x)}`);
  const label = `Sensor blur · half the signal within ${dim(fwhmXM, fwhmYM)} m · 95% within ${dim(2 * R95 * sigmaXM, 2 * R95 * sigmaYM)} m`;
  return (
    <>
      <Polygon positions={ellipse(R95 * sigmaXM, R95 * sigmaYM)}
        pathOptions={{ color: light ? '#075985' : '#7dd3fc', weight: 1, dashArray: '2 4', opacity: light ? 0.9 : 0.75, fill: false, interactive: false }} />
      <Polygon positions={ellipse(fwhmXM / 2, fwhmYM / 2)}
        pathOptions={{ color: light ? '#0c4a6e' : '#e0f2fe', weight: 2, dashArray: '5 4', fill: false, interactive: false }}>
        <LTooltip permanent direction="top" offset={[0, -8]} className="psf-tip">{label}</LTooltip>
      </Polygon>
    </>
  );
}

/** Drag-to-draw a rectangle on the map while `active`. */
function RectDrawer({ active, onDone }: { active: boolean; onDone: (b: LngLatBounds) => void }) {
  const map = useMap();
  const startRef = useRef<L.LatLng | null>(null);
  const [preview, setPreview] = useState<LngLatBounds | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = map.getContainer();
    map.dragging.disable();
    container.style.cursor = 'crosshair';
    startRef.current = null;
    setPreview(null);

    const norm = (a: L.LatLng, b: L.LatLng): LngLatBounds => [
      Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat),
    ];
    const down = (e: L.LeafletMouseEvent) => { startRef.current = e.latlng; setPreview(norm(e.latlng, e.latlng)); };
    const move = (e: L.LeafletMouseEvent) => { if (startRef.current) setPreview(norm(startRef.current, e.latlng)); };
    const up = (e: L.LeafletMouseEvent) => {
      const s = startRef.current;
      if (!s) return;
      startRef.current = null;
      const b = norm(s, e.latlng);
      setPreview(null);
      if (b[2] - b[0] > 1e-7 && b[3] - b[1] > 1e-7) onDone(b);
    };
    map.on('mousedown', down);
    map.on('mousemove', move);
    map.on('mouseup', up);

    return () => {
      map.off('mousedown', down);
      map.off('mousemove', move);
      map.off('mouseup', up);
      map.dragging.enable();
      container.style.cursor = '';
      startRef.current = null;
      setPreview(null);
    };
  }, [active, map, onDone]);

  if (!preview) return null;
  return (
    <Rectangle
      bounds={[[preview[1], preview[0]], [preview[3], preview[2]]]}
      pathOptions={{ color: '#38bdf8', weight: 1, dashArray: '5,5', fillOpacity: 0.08, fillColor: '#38bdf8', interactive: false }}
    />
  );
}

/** Click to drop vertices; click the first point (or double-click) to close. */
function PolyDrawer({ active, onDone }: { active: boolean; onDone: (pts: Poly) => void }) {
  const map = useMap();
  const [pts, setPts] = useState<Poly>([]);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const ptsRef = useRef<Poly>(pts);
  ptsRef.current = pts;

  useEffect(() => {
    if (!active) { setPts([]); setCursor(null); return; }
    const container = map.getContainer();
    container.style.cursor = 'crosshair';
    map.doubleClickZoom.disable();
    const finish = () => { if (ptsRef.current.length >= 3) onDone(ptsRef.current); };
    const click = (e: L.LeafletMouseEvent) => {
      const cur = ptsRef.current;
      if (cur.length >= 3) {
        const first = map.latLngToContainerPoint(L.latLng(cur[0][1], cur[0][0]));
        if (first.distanceTo(e.containerPoint) < 12) { finish(); return; } // clicked the first vertex → close
      }
      setPts([...cur, [e.latlng.lng, e.latlng.lat]]);
    };
    const move = (e: L.LeafletMouseEvent) => setCursor([e.latlng.lng, e.latlng.lat]);
    const dbl = (e: L.LeafletMouseEvent) => { L.DomEvent.stop(e.originalEvent); finish(); };
    map.on('click', click);
    map.on('mousemove', move);
    map.on('dblclick', dbl);
    return () => {
      map.off('click', click); map.off('mousemove', move); map.off('dblclick', dbl);
      map.doubleClickZoom.enable(); container.style.cursor = '';
      setPts([]); setCursor(null);
    };
  }, [active, map, onDone]);

  if (!active || pts.length === 0) return null;
  const chain = cursor ? [...pts, cursor] : pts;
  return (
    <>
      <Polyline positions={chain.map(([lng, lat]) => [lat, lng]) as [number, number][]}
        pathOptions={{ color: '#38bdf8', weight: 1.5, dashArray: '5,5', interactive: false }} />
      {pts.map(([lng, lat], i) => (
        <CircleMarker key={i} center={[lat, lng]} radius={i === 0 ? 5 : 3}
          pathOptions={{ color: '#38bdf8', fillColor: i === 0 ? '#38bdf8' : '#0b0e11', fillOpacity: 1, weight: 1.5, interactive: false }} />
      ))}
    </>
  );
}


/** Reports the current map viewport (WGS84 bounds) so a too-fine grid can be clipped to it. */
function ViewTracker({ onChange, onView }: {
  onChange: (b: LngLatBounds) => void;
  /** Also report centre + zoom, so the page can reopen exactly where it was left. */
  onView?: (center: [number, number], zoom: number) => void;
}) {
  const emit = (map: L.Map) => {
    const b = map.getBounds();
    onChange([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    const c = map.getCenter();
    onView?.([c.lat, c.lng], map.getZoom());
  };
  const map = useMapEvents({ moveend: () => emit(map), zoomend: () => emit(map) });
  useEffect(() => { emit(map); }, []);
  return null;
}

export { BASEMAPS, AOI_STYLE, TruthOverlay, GridLines, PsfOverlay, RectDrawer, PolyDrawer, ViewTracker };
export type { BasemapKey };
