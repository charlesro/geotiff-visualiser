import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleMarker, GeoJSON, Polygon, Polyline, Rectangle, Tooltip as LTooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import { clipPolygon, type Poly } from './geometry';
import { cultureForCell, blockPlots, type FieldSim, type PixelSources, type SimLayout, BARE, MAX_COVER, MIXED, OFF_TRIAL, CROP_COLORS } from './simulate';
import { coverNamer } from './signal-sources';
import type { LngLatBounds, S2Grid } from './s2-grid';

/**
 * Everything drawn ON the Leaflet map, and the two draw tools that put a field
 * there. Kept in one file because the layers' stacking is encoded in the two
 * custom pane z-indices below ('truth' at 300, 'psf' at 460): they are only
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
 * Renders the field "as it really is": the crisp planting pattern at full
 * resolution as *vector* polygons beneath the pixel grid, drawn with an SVG
 * renderer so the strip boundaries stay clean lines (no rasterised stairs).
 * The pattern is built in the rotated UTM frame (where strips are axis-aligned
 * rectangles), then projected back to WGS84, so it lines up with the grid cells.
 *
 * `colors` is indexed by SPECIES, so the periodic patterns (which return 0 or 1)
 * and a block trial (which returns a plot's species) share one lookup and cannot
 * be coloured differently. `layoutSig` is the dependency: hand-listing layout
 * fields here once meant a block design could change with nothing redrawn.
 */
function TruthOverlay({ extent, epsg, layout, layoutSig, origin, colors, clipPoly }: {
  extent: [number, number, number, number]; epsg: number; layout: SimLayout; layoutSig: string;
  origin: [number, number]; colors: string[]; clipPoly?: Poly;
}) {
  const map = useMap();
  // Whether what is drawn depends on the extent given: only strips and checkerboards with no outline to cut them to.
  const usesExtent = layout.pattern !== 'imported' && !(layout.pattern === 'block' && layout.block) && !(clipPoly && clipPoly.length >= 3);
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
    const pushRect = (u0: number, u1: number, v0: number, v1: number, cult: number, clip = true) => {
      const rect: Poly = [toLngLat(u0, v0), toLngLat(u1, v0), toLngLat(u1, v1), toLngLat(u0, v1)];
      let ring: Poly;
      if (clip && clipPoly && clipPoly.length >= 3) {
        const c = clipPolygon(clipPoly, rect); // keep only the part inside the traced field
        if (c.length < 3) return;
        ring = [...c, c[0]];
      } else {
        ring = [...rect, rect[0]];
      }
      features.push({ type: 'Feature', properties: { cult }, geometry: { type: 'Polygon', coordinates: [ring] } });
    };
    if (layout.pattern === 'imported') {
      // The file's own plots, in the grid's metres, brought back to the map. The
      // footprint first, as bare ground, then each plot in its variety's colour.
      // Nothing is clipped: like a block trial, these plots are real objects.
      // Holes and multipart plots come out right because Leaflet fills even-odd.
      const plan = layout.imported;
      const ring = (pts: [number, number][]) => {
        const r = pts.map(([E, N]) => inv.forward([E, N]) as [number, number]);
        const a = r[0], z = r[r.length - 1];
        if (r.length && (a[0] !== z[0] || a[1] !== z[1])) r.push(a);
        return r;
      };
      if (plan) {
        if (plan.footprint.length >= 3)
          features.push({ type: 'Feature', properties: { cult: BARE.id }, geometry: { type: 'Polygon', coordinates: [ring(plan.footprint)] } });
        for (const plot of plan.plots)
          features.push({ type: 'Feature', properties: { cult: plot.species }, geometry: { type: 'Polygon', coordinates: plot.rings.map(ring) } });
      }
    } else if (layout.pattern === 'block' && layout.block) {
      const p = layout.block;
      // Bare backdrop over the TRIAL FOOTPRINT only, never the whole extent.
      // Ground outside a finite trial is not an alley: it is land the design
      // never touched, which is the whole distinction OFF_TRIAL exists to make,
      // and painting it bare-soil brown would claim otherwise on the map.
      //
      // NEVER clipped to the drawn area. A periodic pattern is infinite, so it
      // has to be cut to the field; a trial is a finite object with a real size,
      // and trimming it at the field edge drew plots that were smaller than the
      // design says, hiding the fact that the trial does not fit.
      pushRect(p.u0, p.u0 + p.totalU, p.v0, p.v0 + p.totalV, BARE.id, false);
      for (const r of blockPlots(p)) pushRect(r.u0, r.u1, r.v0, r.v1, r.species, false);
    } else {
      // Each crop strip occupies width W of every period P; the S-wide alleys are
      // painted bare-soil brown (a full bare backdrop, with the crop strips on top).
      const cMin = Math.floor(uMin / P), cMax = Math.floor(uMax / P);
      const rMin = Math.floor(vMin / P), rMax = Math.floor(vMax / P);
      if (S > 0) pushRect(uMin, uMax, vMin, vMax, BARE.id);
      if (layout.pattern === 'row' || layout.pattern === 'strip-row-2') {
        for (let r = rMin; r <= rMax; r++) pushRect(uMin, uMax, r * P, r * P + W, cultureForCell(r, 0, layout.pattern));
      } else if (layout.pattern === 'col' || layout.pattern === 'strip-col-2') {
        for (let c = cMin; c <= cMax; c++) pushRect(c * P, c * P + W, vMin, vMax, cultureForCell(0, c, layout.pattern));
      } else { // checker: square plots with an alley on every side
        for (let r = rMin; r <= rMax; r++)
          for (let c = cMin; c <= cMax; c++) pushRect(c * P, c * P + W, r * P, r * P + W, cultureForCell(r, c, layout.pattern));
      }
    }

    if (!map.getPane('truth')) { map.createPane('truth'); map.getPane('truth')!.style.zIndex = '300'; }
    const renderer = L.svg({ pane: 'truth', padding: 1 });
    const layer = L.geoJSON({ type: 'FeatureCollection', features } as any, {
      pane: 'truth',
      interactive: false,
      // same-colour stroke closes the hairline seams between adjacent bands
      style: (f: any) => {
        const cult = f.properties.cult as number;
        // Species index first, then the two sentinels. The palette fallback
        // covers a design asking for more species than are currently defined,
        // so an extra block column reads as its own crop rather than as ground.
        const col = cult < colors.length ? colors[cult]
          : cult === BARE.id ? BARE.color
          : cult === OFF_TRIAL.id ? OFF_TRIAL.color
          : CROP_COLORS[cult % CROP_COLORS.length];
        return { renderer, stroke: true, color: col, weight: 1, opacity: 1, fill: true, fillColor: col, fillOpacity: 1 };
      },
    });
    layer.addTo(map);
    return () => { layer.remove(); };
    // The view's extent is read for one case only (strips with no outline to
    // cut them to, see the top of the effect): for a trial, or strips inside a
    // traced field, it is not among the things this redraws for. It was, and
    // every pan and zoom took the whole trial off the map and projected and
    // drew it again (found by an outside review, 2026-11-22).
  }, [map, usesExtent ? extent[0] : 0, usesExtent ? extent[1] : 0, usesExtent ? extent[2] : 0, usesExtent ? extent[3] : 0, epsg, layoutSig, origin[0], origin[1], colors.join(','), clipPoly]);
  return null;
}

/**
 * The pixel grid drawn as LINES (one MultiLineString) instead of one polygon
 * per cell, O(rows+cols) not O(rows×cells), so even a 0.3 m grid draws fast.
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
  // Stroke and opacity follow the RULED gap, not the pixel size, so a strided
  // grid is as legible as a close-up one instead of fading away.
  const gapPx = cellPx * stride;
  const w = Math.max(0.35, Math.min(weight, gapPx * 0.16));
  const opacity = Math.max(0.35, Math.min(0.6, gapPx / 5));
  // One function for as long as the look is the same: a new one on each render
  // had react-leaflet restyle the lines after every pan (the key below is what
  // redraws them when the look changes, and it is made of these same values).
  const look = `${color}-${w.toFixed(2)}-${opacity.toFixed(2)}`;
  const style = useMemo(() => () => ({ color, weight: w, opacity, interactive: false }) as L.PathOptions, [look]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  return <GeoJSON key={`gl-${box.join('_')}-${step}-${look}`} data={data} style={style} />;
}

/**
 * The three spreads of the blur budget, to scale on the ground: sigma_PSF, the
 * blur of the optics; sigma_geo, how far the image may sit from where its
 * coordinates say; and sigma_eff, the two combined. One ring each, at one
 * sigma, around the centre of the pixel nearest the middle of the field, with
 * its name and its value on it.
 *
 * Drawn on the map because that is where they mean something: next to the
 * pixel they belong to and the plots they blur. A ring of sigma_geo as wide as
 * a pixel, or a sigma_eff ring that sits on the sigma_PSF one, is read at a
 * glance there and takes a row of figures to see in the budget's table.
 *
 * sigma_PSF and sigma_eff are ellipses when the blur is not the same on both
 * axes (Leaflet has no ellipse, so they are traced); the geolocation error has
 * no direction, and its ring is a circle.
 */
function SigmaRings({ center, psfXM, psfYM, geoM, light = false }: {
  center: [number, number];
  /** sigma_PSF along x and y, in metres. */
  psfXM: number; psfYM: number;
  /** sigma_geo per axis, in metres; 0 when no geolocation error is set. */
  geoM: number;
  /** True for a pale basemap, where the rings need the darker of each colour. */
  light?: boolean;
}) {
  /**
   * The broken rings are not one sigma. A Gaussian holds 90 % of itself within
   * sqrt(2 ln 10) = 2.146 of its sigma, and there is one such ring per
   * Gaussian that a signal can be said to follow:
   *
   *  - WITHOUT the CE90: the signal a sensor receives when it points at the
   *    centre of the pixel, 2.146 sigma_PSF. This is the one the purity figure
   *    goes with, and the one drawn when no geolocation error is set.
   *  - WITH the CE90: the same over many images, each a little off its
   *    coordinates, 2.146 sigma_eff. In the colour of the sigma_eff ring.
   *
   * Plain Gaussians both, so that either is checked by hand; the pixel's own
   * square is in neither. One sigma holds 39 % of a round spot, so the solid
   * rings read as much tighter than the ground a pixel answers for.
   */
  const K90 = Math.sqrt(-2 * Math.log(0.1));
  const r90X = K90 * psfXM, r90Y = K90 * psfYM;
  const e90X = K90 * Math.hypot(psfXM, geoM), e90Y = K90 * Math.hypot(psfYM, geoM);
  if (!(Math.max(psfXM, psfYM) > 0)) return null;
  const [lat, lng] = center;
  const mPerLat = 111320, mPerLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const at = (dxM: number, dyM: number): [number, number] => [lat + dyM / mPerLat, lng + dxM / mPerLng];
  const ring = (rxM: number, ryM: number): [number, number][] =>
    Array.from({ length: 180 }, (_, k) => { const t = (k / 180) * 2 * Math.PI; return at(rxM * Math.cos(t), ryM * Math.sin(t)); });
  const effXM = Math.hypot(psfXM, geoM), effYM = Math.hypot(psfYM, geoM);
  const aniso = Math.abs(psfXM - psfYM) > 1e-9;
  const m = (x: number, y: number) => (aniso ? `${x.toFixed(2)} × ${y.toFixed(2)} m` : `${x.toFixed(2)} m`);
  const line = light ? { psf: '#0369a1', geo: '#6d28d9', eff: '#be123c' } : { psf: '#38bdf8', geo: '#a78bfa', eff: '#fb7185' };
  const text = { psf: '#7dd3fc', geo: '#c4b5fd', eff: '#fda4af', all: '#f1f5f9' };
  // (The rings are drawn with no simplification: Leaflet thins a path as it
  // gets small on screen, and a ring a few pixels across came out an octagon.)
  // ONE label, beside the rings, with a line per sigma in its ring's colour.
  // A name hung on each ring sat on the other two as soon as the rings were
  // closer together than a label is wide, which at most zooms they are. On a
  // dark plate whatever the basemap, and with no arrow: it points at nothing
  // the colours do not already say.
  const TIP = 'border-0! bg-[#11151a]/90! px-2! py-1! text-[12px]! leading-snug! font-medium! shadow-none! before:hidden!';
  const row = (color: string, name: string, value: string) => (
    <div style={{ color }}>σ<sub>{name}</sub> {value}</div>
  );
  return (
    <>
      {geoM > 0 && <Polygon positions={ring(e90X, e90Y)} smoothFactor={0}
        pathOptions={{ color: line.eff, weight: 2, dashArray: '7 6', fill: false, interactive: false }} />}
      <Polygon positions={ring(r90X, r90Y)} smoothFactor={0}
        pathOptions={{ color: light ? '#0f172a' : '#f8fafc', weight: 2, dashArray: '7 6', fill: false, interactive: false }} />
      <Polygon positions={ring(effXM, effYM)} smoothFactor={0} pathOptions={{ color: line.eff, weight: 2, fill: false, interactive: false }} />
      <Polygon positions={ring(psfXM, psfYM)} smoothFactor={0} pathOptions={{ color: line.psf, weight: 2, dashArray: geoM > 0 ? undefined : '6 4', fill: false, interactive: false }} />
      {geoM > 0 && <Polygon positions={ring(geoM, geoM)} smoothFactor={0} pathOptions={{ color: line.geo, weight: 2, fill: false, interactive: false }} />}
      {/* On the LEFT of the rings: the purity readout hangs to the right of the
          pointer, and right after a click the pointer is on this very pixel. */}
      <CircleMarker center={at(-e90X, 0)} radius={0.1} pathOptions={{ opacity: 0, fillOpacity: 0, interactive: false }}>
        <LTooltip permanent direction="left" offset={[-8, 0]} className={TIP}>
          {row(text.psf, 'PSF', m(psfXM, psfYM))}
          {/* With no geolocation error the two are one ring, and it says so. */}
          {geoM > 0 ? row(text.geo, 'geo', `${geoM.toFixed(2)} m`) : null}
          {row(text.eff, 'eff', geoM > 0 ? m(effXM, effYM) : '= PSF')}
          <div style={{ color: text.all }}>90 % of signal{geoM > 0 ? ', without CE90:' : ' within'} {m(r90X, r90Y)}</div>
          {geoM > 0 ? <div style={{ color: text.eff }}>90 % of signal, with CE90: {m(e90X, e90Y)}</div> : null}
        </LTooltip>
      </CircleMarker>
    </>
  );
}

/**
 * One pixel's signal as dots of equal weight, each in the colour of the cover
 * it lands on, with the pixel's own square outlined under them.
 *
 * Dots, and not a glow whose strength follows the weight: a glow fades to
 * nothing where the signal is thin, and the thin part is spread over so much
 * ground that it adds up. That is what a circle holding 90 % of the signal
 * hid: a tenth of it lies beyond, and on a pixel near a border a good part of
 * that tenth is still on its own plot. A dot far out weighs what a dot at the
 * centre weighs, and is drawn as large.
 *
 * Canvas markers added by hand, not a thousand React elements: the map tree
 * re-renders on every pan (see FieldMap), and these do not change with it.
 * Their radius is in screen pixels, taken from the ground between two dots
 * where they are densest, so that at any zoom the dots of the pixel itself
 * nearly touch and never merge; below that they would be specks, and there
 * they stop shrinking and run into a patch of colour, which still reads.
 */
function SignalDots({ sources, colorOf, epsg, ring, pane }: {
  sources: PixelSources;
  /** The colour of each cover id's dots. */
  colorOf: string[];
  epsg: number;
  /** The pixel's own square, as [lat, lng] corners. */
  ring: [number, number][] | null;
  /** The pane the dots are drawn in: between the PSF haze and the sigma rings. */
  pane: string;
}) {
  const map = useMap();
  useEffect(() => {
    const n = sources.dotCover.length;
    if (!n || !map.getPane(pane)) return;
    const inv = proj4(crsToProj4Def(`EPSG:${epsg}`), 'EPSG:4326');
    const [, lat0] = inv.forward([sources.dotE[0], sources.dotN[0]]);
    const look = (): L.CircleMarkerOptions => {
      const pxPerM = Math.pow(2, map.getZoom()) / (156543.03392 * Math.cos((lat0 * Math.PI) / 180));
      const radius = Math.max(1.2, Math.min(5, 0.36 * sources.spacingM * pxPerM));
      // A dark edge sets a dot apart from a plot of its own colour; on a speck it would be all there is.
      return { radius, stroke: radius >= 2.2, color: '#0b0e11', weight: 0.8, opacity: 0.9 };
    };
    const first = look();
    const group = L.layerGroup();
    const dots: L.CircleMarker[] = [];
    for (let m = 0; m < n; m++) {
      const [lng, lat] = inv.forward([sources.dotE[m], sources.dotN[m]]);
      dots.push(L.circleMarker([lat, lng], { ...first, pane, fillColor: colorOf[sources.dotCover[m]], fillOpacity: 1, interactive: false }).addTo(group));
    }
    group.addTo(map);
    const resize = () => { const now = look(); for (const d of dots) d.setStyle(now); };
    map.on('zoomend', resize);
    return () => { map.off('zoomend', resize); group.remove(); };
  }, [map, sources, colorOf, epsg, pane]);
  if (!ring) return null;
  return (
    <>
      <Polygon positions={ring} pathOptions={{ color: '#0b0e11', weight: 4, opacity: 0.9, fill: false, interactive: false }} />
      <Polygon positions={ring} pathOptions={{ color: '#ffffff', weight: 2, opacity: 1, fill: false, interactive: false }} />
    </>
  );
}

/**
 * A click on the map, reported as [lat, lng], while an overlay that sits on one
 * pixel is on (the blur overlays, the signal dots): they move to the pixel that
 * was clicked. Mounted only then, so a click means
 * nothing the rest of the time, and never while a field is being drawn, when
 * every click is a corner of it. A drag is not a click: Leaflet does not fire
 * one at the end of a pan.
 *
 * The pointer is a crosshair for as long as it is mounted, which is the only
 * thing on the map that says a pixel can be picked.
 */
function PixelPicker({ onPick }: { onPick: (at: [number, number]) => void }) {
  const map = useMapEvents({ click: e => onPick([e.latlng.lat, e.latlng.lng]) });
  useEffect(() => {
    const box = map.getContainer(), was = box.style.cursor;
    box.style.cursor = 'crosshair';
    return () => { box.style.cursor = was; };
  }, [map]);
  return null;
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
  // A zoom ends in a move, always: listening to both reported every zoom twice, two renders and two saves of the view for one.
  const map = useMapEvents({ moveend: () => emit(map) });
  useEffect(() => { emit(map); }, []);
  return null;
}

/**
 * What a pixel's purity reads as: one decimal, cut rather than rounded, so a
 * pixel a hair under the threshold is never printed as the threshold itself
 * (89.96 % beside the word "mixed" would read as 90.0 %).
 */
const purityText = (p: number): string => (p >= 0.99995 ? '100 %' : `${(Math.floor(p * 1000) / 10).toFixed(1)} %`);

/**
 * The pixel under the pointer: its purity, what it is mostly made of, and
 * whether that clears the threshold.
 *
 * ONE listener on the map, not one per cell. The overlay is drawn on a canvas
 * with `interactive: false` on every cell, which is what keeps tens of
 * thousands of them cheap, so the pixel is found from the pointer's own
 * coordinates: the grid is a lattice, and a point's cell is two divisions.
 *
 * The readout lives in the map's container through a portal and is moved by
 * writing its transform, so the pointer never re-renders the map above it:
 * GridLines is rebuilt on every render of that tree, and a state change per
 * mouse move would rule the whole grid again each time.
 *
 * Rendered inside the selection pane, so the outline of the hovered pixel sits
 * above the simulation overlay however often that layer is remounted.
 */
function PixelHover({ grid, sim, mask, layout, names, held }: {
  /** The grid the simulation covers, every pixel of it (never a strided sample). */
  grid: S2Grid;
  sim: FieldSim;
  /** 1 for the pixels that belong to the field; the others are not drawn and not read. */
  mask: ArrayLike<number> | null;
  layout: SimLayout;
  /** Species names, as drawn. */
  names: string[];
  /**
   * 1 for the pixels that stay pure wherever the image lands within its CE90,
   * when the map is showing that; null when it is not, or not worked out yet.
   */
  held: ArrayLike<number> | null;
}) {
  const map = useMap();
  const tip = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(-1);
  const usable = !!sim.purity && !!sim.dominant && sim.purity.length === grid.cells.length && !(grid.stride && grid.stride > 1);

  useEffect(() => {
    if (!usable) { setK(-1); return; }
    const fwd = proj4('EPSG:4326', crsToProj4Def(`EPSG:${grid.epsg}`));
    const [e0, n0, e1, n1] = grid.utmBounds, r = grid.res;
    const nx = Math.round((e1 - e0) / r), ny = Math.round((n1 - n0) / r);
    const move = (ev: L.LeafletMouseEvent) => {
      const [E, N] = fwd.forward([ev.latlng.lng, ev.latlng.lat]);
      const i = Math.floor((E - e0) / r), j = Math.floor((N - n0) / r);
      const at = i >= 0 && i < nx && j >= 0 && j < ny ? j * nx + i : -1;
      const hit = at >= 0 && (!mask || mask[at]) ? at : -1;
      setK(hit);
      const el = tip.current;
      if (!el || hit < 0) return;
      // Beside the pointer, on whichever side keeps it inside the map.
      const size = map.getSize(), w = el.offsetWidth || 190, h = el.offsetHeight || 46;
      const x = ev.containerPoint.x + 14 + w > size.x ? ev.containerPoint.x - 14 - w : ev.containerPoint.x + 14;
      const y = ev.containerPoint.y + 14 + h > size.y ? ev.containerPoint.y - 14 - h : ev.containerPoint.y + 14;
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    const out = () => setK(-1);
    // The container's own mouseleave, not the map's mouseout: Leaflet fires
    // that one only when the pointer goes to another element of the page, so a
    // pointer that left the window altogether kept its readout on the map.
    const box = map.getContainer();
    map.on('mousemove', move);
    box.addEventListener('mouseleave', out);
    // A pan or a zoom moves the ground under a still pointer.
    map.on('movestart', out);
    return () => { map.off('mousemove', move); box.removeEventListener('mouseleave', out); map.off('movestart', out); };
  }, [map, grid, mask, usable]);

  // The same names as the lines of the Signal of a pixel card.
  const nameOf = useMemo(() => coverNamer(layout, names), [layout, names]);
  const shown = usable && k >= 0 && k < grid.cells.length;
  let head = '', verdict = '', what = '', holds = '', pure = false;
  if (shown) {
    const p = sim.purity![k], d = sim.dominant![k], v = sim.mixed[k];
    pure = v !== MIXED;
    // A pixel whose PSF weighs nothing on the grid is off-trial whatever its cover reads.
    what = v === OFF_TRIAL.id ? nameOf(OFF_TRIAL.id) : nameOf(d);
    head = p > 0 ? purityText(p) : 'no signal';
    verdict = pure ? 'pure' : 'mixed';
    if (!pure) what = `mostly ${what}`;
    // Only a pixel that is pure for a crop has anything to lose to a shift.
    if (held && held.length === grid.cells.length && v <= MAX_COVER) holds = held[k] ? 'stays pure within the CE90' : 'not pure within the CE90';
  }
  const ring = shown ? grid.cells[k].ring.map(([lng, lat]) => [lat, lng] as [number, number]) : null;

  return (
    <>
      {ring && (
        <>
          {/* Dark under light, so the outline reads on any basemap and any crop colour. */}
          <Polygon positions={ring} pathOptions={{ color: '#0b0e11', weight: 4, opacity: 0.9, fill: false, interactive: false }} />
          <Polygon positions={ring} pathOptions={{ color: '#ffffff', weight: 2, opacity: 1, fill: false, interactive: false }} />
        </>
      )}
      {createPortal(
        <div ref={tip} role="status"
          className="pointer-events-none absolute left-0 top-0 z-[1100] whitespace-nowrap rounded-md border border-white/10 bg-[#11151a]/90 px-2.5 py-1.5 text-[14px] leading-snug text-slate-200 shadow-lg backdrop-blur"
          style={{ display: shown ? 'block' : 'none' }}>
          <div className="flex items-baseline gap-2">
            <span className="text-slate-400">purity</span>
            <span className="font-mono text-[15px] font-semibold text-white">{head}</span>
            <span className={pure ? 'text-emerald-300' : 'text-amber-300'}>{verdict}</span>
          </div>
          <div className="text-[13px] text-slate-400">{what}</div>
          {holds && <div className="text-[13px] text-slate-400">{holds}</div>}
        </div>,
        map.getContainer(),
      )}
    </>
  );
}

/**
 * Keeps the map the size of its box.
 *
 * Leaflet measures its container once and again only when the WINDOW is
 * resized. The map's box changes without that: the panel beside it is dragged
 * wider or narrower, the pane the page sits in is resized or shown again. The
 * map then went on drawing for its old size and left a black band down the
 * side where the box had grown ("at some window sizes the map can bug",
 * 2026-11-21). Watching the box itself covers every such case. The top-left
 * corner stays where it is, so a panel being dragged does not slide the map.
 */
function KeepSized() {
  const map = useMap();
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const watch = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => map.invalidateSize({ pan: false, debounceMoveend: true }));
    });
    watch.observe(map.getContainer());
    return () => { watch.disconnect(); cancelAnimationFrame(frame); };
  }, [map]);
  return null;
}

export { BASEMAPS, AOI_STYLE, TruthOverlay, GridLines, SigmaRings, SignalDots, PixelPicker, RectDrawer, PolyDrawer, ViewTracker, PixelHover, KeepSized, purityText };
export type { BasemapKey };
