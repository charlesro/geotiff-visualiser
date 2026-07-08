import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Rectangle, Polygon, Polyline, CircleMarker, Circle, Tooltip as LTooltip, GeoJSON, ScaleControl, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { ChevronDown, Layers } from 'lucide-react';
import { saveAs } from 'file-saver';
import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import {
  aoiUtmOrigin,
  buildS2Grid,
  fetchCoveringGrids,
  gridConvergence,
  gridToGeoJson,
  utmEpsg,
  utmZoneForLng,
  zoneFromEpsg,
  type BuildOptions,
  type CoveringGrid,
  type LngLatBounds,
  type S2Grid,
  type SourceConfig,
} from './s2-grid';
import { gridToShapefileZip } from './shapefile';
import {
  BARE,
  CROP_PRESETS,
  PATTERNS,
  TRUTH_TYPES,
  TMAX,
  bestPhaseOffset,
  cropById,
  cultureForCell,
  makeBetaSchedule,
  simulateField,
  simulatePatch,
  utmEnvelope,
  truthAt,
  type FieldParams,
  type FieldSim,
  type PatternType,
  type SensorParams,
  type SimLayout,
} from './simulate';
import SimVisual from './SimVisual';
import PcaSimVisual from './PcaSimVisual';
import PcaSweep, { type SweepStep } from './PcaSweep';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';

/** A field near Lonzée (Gembloux), so the tool opens with a grid already drawn. */
const DEFAULT_AOI: LngLatBounds = [4.6882, 50.5489, 4.6918, 50.5511];
const DEFAULT_CENTER: [number, number] = [(DEFAULT_AOI[1] + DEFAULT_AOI[3]) / 2, (DEFAULT_AOI[0] + DEFAULT_AOI[2]) / 2];

/** A user-pinned default field, persisted in the browser so it survives reloads. */
const FIELD_KEY = 'pixelGrid.defaultField';
const loadDefaultField = (): { aoi: LngLatBounds; aoiPoly: [number, number][] | null } | null => {
  try {
    const f = JSON.parse(localStorage.getItem(FIELD_KEY) || 'null');
    if (Array.isArray(f?.aoi) && f.aoi.length === 4 && f.aoi.every((n: any) => typeof n === 'number'))
      return { aoi: f.aoi, aoiPoly: Array.isArray(f.aoiPoly) ? f.aoiPoly : null };
  } catch { /* corrupt / unavailable — ignore */ }
  return null;
};

/** Linear interpolate between two hex colours (t=0 → a, t=1 → b). */
const lerpHex = (a: string, b: string, t: number): string => {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  const m = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${m.map(v => v.toString(16).padStart(2, '0')).join('')}`;
};
/** Sensor pixels the PCA samples when the full field is too fine to render. */
const PCA_SAMPLE = 2500;
/** Pixel sizes (m) compared side-by-side in the resolution sweep. */
const RES_LADDER = [0.5, 1, 2, 3, 4, 5, 6, 8, 10];

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
const hexRgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
/** Fraction-weighted blend of crop A / crop B / bare soil — reduces to a clean
 *  A↔B gradient when there's no bare gap. */
const mix3 = (pA: number, pB: number, pBare: number, colA: string, colB: string): string => {
  const [aR, aG, aB] = hexRgb(colA), [bR, bG, bB] = hexRgb(colB), [sR, sG, sB] = hexRgb(BARE.color);
  const w = pA + pB + pBare || 1;
  const c = [(pA * aR + pB * bR + pBare * sR) / w, (pA * aG + pB * bG + pBare * sG) / w, (pA * aB + pB * bB + pBare * sB) / w];
  return `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
};

/** A collapsible numbered step — matches the PCA app's flat stepper sections. */
function Step({ n, title, summary, open, enabled = true, onClick, children }: {
  n: number; title: string; summary?: string; open: boolean; enabled?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <section className="border-b border-white/5">
      <button onClick={onClick} className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] ${!enabled && !open ? 'opacity-55' : ''}`}>
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${open ? 'bg-sky-500/20 text-sky-300' : 'bg-white/10 text-slate-400'}`}>{n}</span>
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-medium ${open ? 'text-slate-100' : 'text-slate-300'}`}>{title}</span>
          {!open && summary && <span className="block truncate text-xs text-slate-500">{summary}</span>}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-600 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="space-y-3 px-4 pb-4 pt-1">{children}</div>}
    </section>
  );
}

const Slider = ({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number; fmt?: (v: number) => string; onChange: (v: number) => void;
}) => (
  <label className="block">
    <span className="mb-0.5 flex justify-between text-[11px] text-neutral-400">
      <span>{label}</span><span className="font-mono text-neutral-300">{fmt ? fmt(value) : value}</span>
    </span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))} className="w-full accent-violet-500" />
  </label>
);

/** Field picker with editable truth type + double-logistic params (repo set). */
function CropControl({ label, crop, preset, swatchColor, onCrop, onPreset }: {
  label: string; crop: FieldParams; preset: string; swatchColor?: string; onCrop: (c: FieldParams) => void; onPreset: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<FieldParams>) => onCrop({ ...crop, ...patch });
  return (
    <div>
      <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: swatchColor ?? crop.color }} /> {label}
      </label>
      <div className="flex gap-1.5">
        <select value={preset} onChange={e => onPreset(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none">
          {CROP_PRESETS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          {preset === 'custom' && <option value="custom">Custom</option>}
        </select>
        <button onClick={() => setOpen(o => !o)} title="Edit the growth (truth) curve"
          className={`rounded-md border px-2 text-xs ${open ? 'border-violet-500 bg-violet-500/15 text-violet-300' : 'border-white/10 bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}`}>
          curve ▾
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-white/10 bg-black/20 p-2">
          <label className="block">
            <span className="mb-0.5 block text-[11px] text-neutral-400">Truth type</span>
            <select value={crop.truth} onChange={e => set({ truth: e.target.value as FieldParams['truth'] })}
              className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-sky-500 focus:outline-none">
              {TRUTH_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          {crop.truth === 'double' && <>
            <Slider label="Peak (L1)" value={crop.L1} min={0.1} max={1} step={0.01} fmt={v => v.toFixed(2)} onChange={v => set({ L1: v })} />
            <Slider label="Green-up day (x01)" value={crop.x01} min={0} max={365} step={1} fmt={v => `${v | 0}`} onChange={v => set({ x01: v })} />
            <Slider label="Green-up rate (k1)" value={crop.k1} min={0.01} max={0.5} step={0.001} fmt={v => v.toFixed(3)} onChange={v => set({ k1: v })} />
            <Slider label="Offset / switch (tc)" value={crop.tc} min={0} max={365} step={1} fmt={v => `${v | 0}`} onChange={v => set({ tc: v })} />
            <Slider label="Senescence day (x02)" value={crop.x02} min={0} max={365} step={1} fmt={v => `${v | 0}`} onChange={v => set({ x02: v })} />
            <Slider label="Decay rate (k2)" value={crop.k2} min={0.01} max={0.5} step={0.001} fmt={v => v.toFixed(3)} onChange={v => set({ k2: v })} />
          </>}
        </div>
      )}
    </div>
  );
}

interface Source {
  id: string;
  provider: string;
  resLabel: string;
  res: number;
  /** 'catalog' = read the real fixed grid live; 'custom' = you define the grid. */
  kind: 'catalog' | 'custom';
  group: string;
  note: string;
  /**
   * Default Gaussian PSF σ, in PIXELS, from each sensor's published MTF at Nyquist
   * via a Gaussian model: MTF(½) = exp(−π²σ²/2) ⇒ σ = √(−2·ln M)/π.
   * S2 MSI spec M≈0.15–0.3 (→σ≈0.53 at 0.25); Landsat OLI M≈0.30 (σ≈0.49);
   * Pléiades PAN M≈0.17 (σ≈0.60, products MTF-sharpened → ~0.55); CubeSats/PlanetScope
   * are softer (larger effective GRD than GSD → σ≈0.6). Both axes use this value.
   */
  psf: number;
  /** Where the MTF/PSF figure comes from (shown as a link). */
  psfSrc?: { url: string; label: string };
  /** Grid lattice phase is 0, so a rule-based offline grid is still exact (catalog only). */
  offlinePhase0?: boolean;
  cfg?: SourceConfig;
}

const FIXED = 'Fixed grid — read live from the catalog';
const TASK = 'Commercial — you define the grid';
const s2Label = (it: any) => it.properties?.['s2:mgrs_tile'] ?? '';
// Where each sensor's MTF/PSF figure is documented.
const SRC_S2 = { url: 'https://sentiwiki.copernicus.eu/web/s2-mission', label: 'ESA SentiWiki' };
const SRC_LS = { url: 'https://www.usgs.gov/landsat-missions/spatial-performance-landsat-8-instruments', label: 'USGS · Landsat 8 spatial performance' };
const eo = (slug: string) => ({ url: `https://www.eoportal.org/satellite-missions/${slug}`, label: 'eoPortal' });
const SRC_PLANET = { url: 'https://www.tandfonline.com/doi/full/10.1080/01431161.2024.2357839', label: 'SuperDove vs Landsat 8 (2024)' };
const SOURCES: Source[] = [
  { id: 's2-10', provider: 'Sentinel-2', resLabel: '10 m', res: 10, kind: 'catalog', group: FIXED, offlinePhase0: true, psf: 0.62, psfSrc: SRC_S2,
    note: 'The 10 m bands (B02/B03/B04/B08). MTF 0.15 @ Nyquist — blurriest end of ESA\'s 0.15–0.30 spec (conservative).',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 10, gridLabel: s2Label } },
  { id: 's2-20', provider: 'Sentinel-2', resLabel: '20 m', res: 20, kind: 'catalog', group: FIXED, offlinePhase0: true, psf: 0.62, psfSrc: SRC_S2,
    note: 'Red-edge & SWIR (B05–B07, B8A, B11/B12). MTF 0.15 @ Nyquist (conservative end of spec).',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 20, gridLabel: s2Label } },
  { id: 's2-60', provider: 'Sentinel-2', resLabel: '60 m', res: 60, kind: 'catalog', group: FIXED, offlinePhase0: true, psf: 0.62, psfSrc: SRC_S2,
    note: 'Aerosol / cirrus bands (B01/B09/B10).',
    cfg: { collection: 'sentinel-2-l2a', asset: 'B04', res: 60, gridLabel: s2Label } },
  { id: 'hls-30', provider: 'Landsat · HLS', resLabel: '30 m', res: 30, kind: 'catalog', group: FIXED, offlinePhase0: true, psf: 0.55, psfSrc: SRC_LS,
    note: 'Harmonized Landsat-Sentinel — both on one 30 m grid that nests with S2.',
    cfg: { collection: 'hls2-s30', asset: null, res: 30,
      gridLabel: it => (it.id?.split('.')?.[2] ?? '').replace(/^T/, '') } },
  { id: 'ls-30', provider: 'Landsat C2', resLabel: '30 m', res: 30, kind: 'catalog', group: FIXED, offlinePhase0: false, psf: 0.55, psfSrc: SRC_LS,
    note: 'Native USGS Landsat 8/9 OLI grid (conservative MTF≈0.25 @ Nyquist) — offset half a pixel from Sentinel-2.',
    cfg: { collection: 'landsat-c2-l2', asset: null, res: 30,
      gridLabel: it => { const e = it.properties?.['proj:epsg']; return e >= 32700 ? `${e - 32700}S` : `${e - 32600}N`; } } },
  { id: 'wv', provider: 'WorldView / GeoEye', resLabel: '0.3 m', res: 0.3, kind: 'custom', group: TASK, psf: 0.55, psfSrc: eo('worldview-3'),
    note: 'Maxar tasking — agile pointing, no fixed grid. Conservative (raw, before MTF-compensation).' },
  { id: 'pleiades', provider: 'Pléiades', resLabel: '0.5 m', res: 0.5, kind: 'custom', group: TASK, psf: 0.60, psfSrc: eo('pleiades'),
    note: 'Airbus tasking. Raw PAN MTF≈0.17 @ Nyquist (conservative — before delivery MTF-sharpening).' },
  { id: 'skysat', provider: 'SkySat', resLabel: '0.5 m', res: 0.5, kind: 'custom', group: TASK, psf: 0.62, psfSrc: eo('skysat'),
    note: 'Planet SkySat tasking — small-sat optics, softer than the GSD implies (conservative).' },
  { id: 'spot', provider: 'SPOT 6/7', resLabel: '1.5 m', res: 1.5, kind: 'custom', group: TASK, psf: 0.60, psfSrc: eo('spot-6-7'),
    note: 'Airbus SPOT — define your output grid.' },
  { id: 'planet', provider: 'PlanetScope', resLabel: '3 m', res: 3, kind: 'custom', group: TASK, psf: 0.66, psfSrc: SRC_PLANET,
    note: 'Planet daily (Dove/SuperDove) — effective resolution is well coarser than the 3 m GSD (conservative).' },
  { id: 'custom', provider: 'Custom', resLabel: '—', res: 1, kind: 'custom', group: TASK, psf: 0.55,
    note: 'Any sensor — pick the GSD and where the grid sits.' },
];

const GSD_PRESETS = [0.3, 0.5, 1, 1.5, 2, 3, 5];

const BASEMAPS = {
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    light: false,
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
    light: false,
  },
  topo: {
    label: 'Topo',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, HERE, Garmin, FAO, NOAA',
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

/** Grid lines: white on dark basemaps, dark on light ones. */
const gridStyle = (light: boolean): L.PathOptions => ({
  color: light ? '#0f172a' : '#f1f5f9',
  weight: 0.6,
  opacity: light ? 0.7 : 0.85,
  fillOpacity: 0,
  interactive: false,
});
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
function GridLines({ box, res, epsg, color, weight }: {
  box: [number, number, number, number]; res: number; epsg: number; color: string; weight: number;
}) {
  const map = useMap();
  const data = useMemo(() => {
    const [minE, minN, maxE, maxN] = box;
    const nx = Math.round((maxE - minE) / res), ny = Math.round((maxN - minN) / res);
    if (nx < 1 || ny < 1 || nx > 1500 || ny > 1500) return null; // too dense to read as lines
    const inv = proj4(crsToProj4Def(`EPSG:${epsg}`), 'EPSG:4326');
    const lines: [number, number][][] = [];
    for (let i = 0; i <= nx; i++) { const E = minE + i * res; lines.push([inv.forward([E, minN]) as [number, number], inv.forward([E, maxN]) as [number, number]]); }
    for (let j = 0; j <= ny; j++) { const N = minN + j * res; lines.push([inv.forward([minE, N]) as [number, number], inv.forward([maxE, N]) as [number, number]]); }
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }] } as GeoJSON.FeatureCollection;
  }, [box[0], box[1], box[2], box[3], res, epsg]);
  if (!data) return null;
  // Scale stroke to the on-screen cell size: keep the line ~⅙ of a cell so the
  // grid never fills to solid black when zoomed out, and fade it as cells shrink
  // below a few pixels (where individual cells can't be read anyway).
  const mpp = (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();
  const cellPx = res / mpp;
  const w = Math.max(0.1, Math.min(weight, cellPx * 0.16));
  const opacity = Math.max(0.12, Math.min(0.6, cellPx / 5));
  return <GeoJSON key={`gl-${box.join('_')}-${color}-${w.toFixed(2)}-${opacity.toFixed(2)}`} data={data} style={() => ({ color, weight: w, opacity, interactive: false }) as L.PathOptions} />;
}

/**
 * The sensor PSF drawn on the ground as a bold, smooth Gaussian glow (a real
 * exp(−r²/2σ²) footprint rendered to a canvas and placed as a georeferenced
 * ImageOverlay, so it scales with zoom), plus a crisp FWHM ring — so you can see
 * how far one ground point's signal actually spreads across the pixel grid.
 */
function PsfOverlay({ center, sigmaM, fwhmM }: { center: [number, number]; sigmaM: number; fwhmM: number }) {
  const map = useMap();
  useEffect(() => {
    if (sigmaM <= 0) return;
    const K = 3.2;                       // draw out to ±3.2σ
    const N = 220;
    const cv = document.createElement('canvas'); cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(N, N);
    const sPix = N / (2 * K);            // σ in canvas pixels
    const c = (N - 1) / 2;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = x - c, dy = y - c;
      const g = Math.exp(-0.5 * (dx * dx + dy * dy) / (sPix * sPix));
      const o = (y * N + x) * 4;
      img.data[o] = 56; img.data[o + 1] = 189; img.data[o + 2] = 248; // sky-400 #38bdf8
      img.data[o + 3] = Math.round(235 * g);                          // bold Gaussian alpha
    }
    ctx.putImageData(img, 0, 0);
    const [lat, lng] = center;
    const halfM = K * sigmaM;
    const dLat = halfM / 111320, dLng = halfM / (111320 * Math.cos((lat * Math.PI) / 180));
    const bounds = L.latLngBounds([lat - dLat, lng - dLng], [lat + dLat, lng + dLng]);
    if (!map.getPane('psf')) { const p = map.createPane('psf'); p.style.zIndex = '460'; p.style.mixBlendMode = 'screen'; p.style.pointerEvents = 'none'; }
    const ov = L.imageOverlay(cv.toDataURL(), bounds, { pane: 'psf', interactive: false, opacity: 1 });
    ov.addTo(map);
    return () => { ov.remove(); };
  }, [map, center[0], center[1], sigmaM]);
  if (sigmaM <= 0) return null;
  return (
    <Circle center={center} radius={fwhmM / 2}
      pathOptions={{ color: '#e0f2fe', weight: 2, dashArray: '5 4', fill: false, interactive: false }}>
      <LTooltip permanent direction="top" offset={[0, -8]} className="psf-tip">PSF · FWHM ≈ {fwhmM < 10 ? fwhmM.toFixed(1) : Math.round(fwhmM)} m</LTooltip>
    </Circle>
  );
}

interface Suggestion {
  label: string;
  lat: number;
  lon: number;
  /** [west, south, east, north] when the place has an extent. */
  bbox?: [number, number, number, number];
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

const fmt = (n: number) => n.toLocaleString('en-US');
const fmtM = (m: number) => (m < 0.995 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`);
/** Small spinning ring for "recomputing…" feedback. */
const Spinner = ({ className = '' }: { className?: string }) => (
  <span className={`inline-block animate-spin rounded-full border-2 border-sky-400/25 border-t-sky-400 ${className || 'h-3.5 w-3.5'}`} />
);

/** Reports the current map viewport (WGS84 bounds) so a too-fine grid can be clipped to it. */
function ViewTracker({ onChange }: { onChange: (b: LngLatBounds) => void }) {
  const emit = (map: L.Map) => { const b = map.getBounds(); onChange([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]); };
  const map = useMapEvents({ moveend: () => emit(map), zoomend: () => emit(map) });
  useEffect(() => { emit(map); }, []);
  return null;
}

export default function PixelGridApp() {
  const mapRef = useRef<L.Map | null>(null);
  const [drawKind, setDrawKind] = useState<null | 'rect' | 'poly'>(null);
  const drawMode = drawKind !== null;
  const [basemap, setBasemap] = useState<BasemapKey>('dark');
  const [showField, setShowField] = useState(false);   // render the true planting pattern under the grid
  const [showPsf, setShowPsf] = useState(false);        // draw the sensor PSF footprint on the map
  const [selectedPixels, setSelectedPixels] = useState<number[]>([]); // pixels picked in the PCA → highlight on map
  const [panelW, setPanelW] = useState(() => {          // drag the panel's left edge to widen it
    const v = Number(localStorage.getItem('pgrid_panel_w'));
    return v >= 320 && v <= 1400 ? v : 380;
  });
  const [aoi, setAoi] = useState<LngLatBounds | null>(() => loadDefaultField()?.aoi ?? DEFAULT_AOI);
  const [aoiPoly, setAoiPoly] = useState<Poly | null>(() => loadDefaultField()?.aoiPoly ?? null); // field shape (null = plain rectangle = aoi)
  const [defaultSaved, setDefaultSaved] = useState<boolean>(() => !!loadDefaultField());
  // Map opens centred on the restored field (only read once, at mount).
  const initialCenter = useMemo<[number, number]>(() => {
    const f = loadDefaultField()?.aoi ?? DEFAULT_AOI;
    return [(f[1] + f[3]) / 2, (f[0] + f[2]) / 2];
  }, []);
  const [sourceId, setSourceId] = useState('s2-10');
  const [gsd, setGsd] = useState(1);
  const [customAnchor, setCustomAnchor] = useState<'utm' | 'plot'>('utm');
  const [viewBounds, setViewBounds] = useState<LngLatBounds | null>(null);

  // Collapsible steps (one open at a time, PCA-style; click an open one to close it)
  const [activeStep, setActiveStep] = useState<'area' | 'grid' | 'sim' | 'pca' | null>('grid');
  const toggleStep = (s: 'area' | 'grid' | 'sim' | 'pca') => setActiveStep(cur => (cur === s ? null : s));
  const simOn = activeStep === 'sim' || activeStep === 'pca';

  // Experiment simulation (repo parameter set)
  const [pattern, setPattern] = useState<PatternType>('row');
  const [stripWidth, setStripWidth] = useState(3);
  const [spacing, setSpacing] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [optimizePlacement, setOptimizePlacement] = useState(true); // slide plants to max purity
  const [cropA, setCropA] = useState<FieldParams>(() => cropById('maize'));
  const [cropB, setCropB] = useState<FieldParams>(() => cropById('wheat'));
  const [presetA, setPresetA] = useState('maize');
  const [presetB, setPresetB] = useState('wheat');
  const [sigmaX, setSigmaX] = useState(() => SOURCES.find(s => s.id === 's2-10')!.psf);
  const [sigmaY, setSigmaY] = useState(() => SOURCES.find(s => s.id === 's2-10')!.psf);
  const [magnitude, setMagnitude] = useState(0.04);
  const [alpha, setAlpha] = useState(2);
  const [beta, setBeta] = useState(2);
  const [threshold, setThreshold] = useState(80);
  const [day] = useState(196);
  const [simView] = useState<'mixture' | 'purity' | 'ndvi'>('mixture');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const lastPicked = useRef('');

  const source = SOURCES.find(s => s.id === sourceId)!;

  // Load each satellite's realistic default PSF (σ, from its published MTF) when it's
  // picked — the user can still override σx/σy afterwards.
  useEffect(() => { setSigmaX(source.psf); setSigmaY(source.psf); }, [sourceId]);

  // Authoritative grid lookup against the product catalog, per source.
  const [grids, setGrids] = useState<CoveringGrid[] | null>(null);
  const [gridState, setGridState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [selectedGridKey, setSelectedGridKey] = useState<string | null>(null);

  const autoZone = aoi ? utmZoneForLng((aoi[0] + aoi[2]) / 2) : null;

  // Switching to a commercial source seeds the GSD with its typical value.
  useEffect(() => { if (source.kind === 'custom' && source.res > 0) setGsd(source.res); }, [sourceId]);

  // For catalog sources, identify the real grid(s) covering the area.
  useEffect(() => {
    if (!aoi || source.kind !== 'catalog' || !source.cfg) {
      setGrids(null); setGridState('idle'); setSelectedGridKey(null); return;
    }
    const ctrl = new AbortController();
    setGridState('loading');
    setGrids(null);
    fetchCoveringGrids(aoi, source.cfg, ctrl.signal)
      .then(found => {
        if (ctrl.signal.aborted) return;
        setGrids(found);
        setGridState(found.length ? 'ok' : 'error');
        const auto = utmZoneForLng((aoi[0] + aoi[2]) / 2);
        const pick = found.find(g => zoneFromEpsg(g.epsg) === auto) ?? found[0];
        setSelectedGridKey(pick?.label ?? null);
      })
      .catch(() => { if (!ctrl.signal.aborted) { setGridState('error'); setGrids(null); } });
    return () => ctrl.abort();
  }, [aoi, sourceId]);

  const selectedGrid = grids?.find(g => g.label === selectedGridKey) ?? null;

  // Build options for the active source (shared by the full build and the clipped render).
  const buildOpts = useMemo((): BuildOptions | null => {
    if (!aoi) return null;
    if (source.kind === 'custom') {
      const zone = utmZoneForLng((aoi[0] + aoi[2]) / 2);
      const south = (aoi[1] + aoi[3]) / 2 < 0;
      const epsg = utmEpsg(zone, south);
      if (customAnchor === 'plot') {
        const [ulx, uly] = aoiUtmOrigin(aoi, epsg);
        return { res: gsd, anchor: { epsg, ulx, uly } };
      }
      return { res: gsd, zone, south }; // multiples of GSD (gdalwarp -tap)
    }
    if (selectedGrid) return { res: source.res, anchor: selectedGrid };
    // Offline fallback: only exact for phase-0 grids (S2/HLS); Landsat needs the catalog.
    if (gridState === 'error' && source.offlinePhase0) return { res: source.res };
    return null;
  }, [aoi, sourceId, gsd, customAnchor, selectedGrid, gridState]);

  const build = useMemo(() => (aoi && buildOpts ? buildS2Grid(aoi, buildOpts) : null), [aoi, buildOpts]);
  const grid = build?.grid ?? null;

  // When the full grid is too fine to fill cells, render only the cells in the map
  // view (capped low so panning stays smooth) — used by the sim / "Real field".
  const renderGrid = useMemo(() => {
    if (grid) return grid;
    if (aoi && buildOpts && build?.capped && viewBounds) return buildS2Grid(aoi, { ...buildOpts, clip: viewBounds, maxCells: 6000 }).grid;
    return null;
  }, [grid, aoi, buildOpts, build?.capped, viewBounds]);
  const clippedView = !grid && !!renderGrid;
  const geojson = useMemo(() => (renderGrid ? gridToGeoJson(renderGrid) : null), [renderGrid]);

  // The plain grid is drawn as lines over the visible window (phase-correct),
  // independent of the cell cap — so even a 0.3 m grid shows instantly.
  const lineBox = useMemo((): [number, number, number, number] | null => {
    if (!build?.utmBounds) return null;
    const [fMinE, fMinN, fMaxE, fMaxN] = build.utmBounds;
    const res = build.res;
    if (!viewBounds) return [fMinE, fMinN, fMaxE, fMaxN];
    const fwd = proj4('EPSG:4326', crsToProj4Def(`EPSG:${build.epsg}`));
    let cMinE = Infinity, cMinN = Infinity, cMaxE = -Infinity, cMaxN = -Infinity;
    const [vw, vs, ve, vn] = viewBounds;
    for (const [lng, lat] of [[vw, vs], [ve, vs], [ve, vn], [vw, vn]] as [number, number][]) {
      const [x, y] = fwd.forward([lng, lat]);
      cMinE = Math.min(cMinE, x); cMaxE = Math.max(cMaxE, x); cMinN = Math.min(cMinN, y); cMaxN = Math.max(cMaxN, y);
    }
    const nxF = Math.round((fMaxE - fMinE) / res), nyF = Math.round((fMaxN - fMinN) / res);
    const i0 = Math.max(0, Math.floor((cMinE - fMinE) / res)), i1 = Math.min(nxF, Math.ceil((cMaxE - fMinE) / res));
    const j0 = Math.max(0, Math.floor((cMinN - fMinN) / res)), j1 = Math.min(nyF, Math.ceil((cMaxN - fMinN) / res));
    if (i1 <= i0 || j1 <= j0) return null;
    return [fMinE + i0 * res, fMinN + j0 * res, fMinE + i1 * res, fMinN + j1 * res];
  }, [build?.utmBounds, build?.epsg, build?.res, viewBounds]);

  // ----- experiment simulation (repo engine over the real grid) -----
  const layout: SimLayout = { pattern, width: stripWidth, spacing, rotationDeg: rotation };
  const sensor: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100 };
  const sensorSig = `${sigmaX}_${sigmaY}_${threshold}`;

  // Same species picked for both (to tweak one parameter and compare) → recolour B
  // so the two are still distinguishable everywhere. Curves/names are untouched.
  const dupSpecies = cropA.color.toLowerCase() === cropB.color.toLowerCase();
  const colB = dupSpecies
    ? (['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00'].find(c => c !== cropA.color.toLowerCase()) ?? '#0072b2')
    : cropB.color;
  const nameA = dupSpecies ? `${cropA.name} (A)` : cropA.name;
  const nameB = dupSpecies ? `${cropB.name} (B)` : cropB.name;
  const cropAd: FieldParams = dupSpecies ? { ...cropA, name: nameA } : cropA;
  const cropBd: FieldParams = dupSpecies ? { ...cropB, color: colB, name: nameB } : cropB;

  // Pattern origin: the field corner, optionally slid to the phase that maximises
  // pure pixels (strip edges land on pixel edges). `offset` = [along-row, cross-row] m.
  const patternOrigin = useMemo((): { origin: [number, number]; offset: [number, number] } | null => {
    if (!aoi || !build?.epsg) return null;
    const base = aoiUtmOrigin(aoi, build.epsg);
    if (!optimizePlacement) return { origin: base, offset: [0, 0] };
    const [du, dv] = bestPhaseOffset(pattern, build.res, stripWidth, spacing, threshold / 100, base[0], base[1]);
    const t = (rotation * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    return { origin: [base[0] + du * cos - dv * sin, base[1] + du * sin + dv * cos] as [number, number], offset: [du, dv] as [number, number] };
  }, [aoi, build?.epsg, build?.res, optimizePlacement, pattern, stripWidth, spacing, threshold, rotation]);
  // Concrete planting instruction: how far to shift the pattern from the SW corner.
  const placementShift = useMemo(() => {
    if (!patternOrigin || !optimizePlacement) return null;
    const P = stripWidth + Math.max(0, spacing);
    const norm = (d: number) => ((d % P) + P) % P;
    const [du, dv] = patternOrigin.offset;
    if (pattern === 'checker') return `${fmtM(norm(du))} along the rows × ${fmtM(norm(dv))} across them`;
    if (pattern === 'col' || pattern === 'strip-col-2') return `${fmtM(norm(du))} across the columns`;
    return `${fmtM(norm(dv))} across the rows`;
  }, [patternOrigin, optimizePlacement, pattern, stripWidth, spacing]);

  const sim = useMemo(
    () => (simOn && renderGrid && patternOrigin ? simulateField(renderGrid, patternOrigin.origin, layout, sensor) : null),
    [simOn, renderGrid, patternOrigin, pattern, stripWidth, spacing, rotation, sensorSig],
  );

  // The PCA always runs on the field itself — the full grid when it fits, else a
  // central subsample of ~PCA_SAMPLE cells — so it works even when the grid is
  // too fine to render on the map.
  const pcaGrid = useMemo(() => {
    if (grid) return grid;
    if (!aoi || !buildOpts || !build?.utmBounds) return null;
    const [mnE, mnN, mxE, mxN] = build.utmBounds;
    const half = (build.res * Math.sqrt(PCA_SAMPLE)) / 2; // central square ≈ PCA_SAMPLE cells
    const cx = (mnE + mxE) / 2, cy = (mnN + mxN) / 2;
    const sMinE = Math.max(mnE, cx - half), sMaxE = Math.min(mxE, cx + half);
    const sMinN = Math.max(mnN, cy - half), sMaxN = Math.min(mxN, cy + half);
    const inv = proj4(crsToProj4Def(`EPSG:${build.epsg}`), 'EPSG:4326');
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [E, N] of [[sMinE, sMinN], [sMaxE, sMinN], [sMaxE, sMaxN], [sMinE, sMaxN]] as [number, number][]) {
      const [lng, lat] = inv.forward([E, N]); w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat);
    }
    return buildS2Grid(aoi, { ...buildOpts, clip: [w, s, e, n], maxCells: PCA_SAMPLE * 4 }).grid;
  }, [grid, aoi, buildOpts, build]);

  // Deferred so a spinner can paint before the (few-hundred-ms) aggregate runs.
  const [pcaSim, setPcaSim] = useState<FieldSim | null>(null);
  const [pcaBusy, setPcaBusy] = useState(false);
  useEffect(() => {
    if (activeStep !== 'pca' || !pcaGrid || !patternOrigin) { setPcaSim(null); setPcaBusy(false); return; }
    setPcaBusy(true);
    const id = setTimeout(() => {
      const layoutL: SimLayout = { pattern, width: stripWidth, spacing, rotationDeg: rotation };
      const sensorL: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100 };
      setPcaSim(simulateField(pcaGrid, patternOrigin.origin, layoutL, sensorL));
      setPcaBusy(false);
    }, 30);
    return () => clearTimeout(id);
  }, [activeStep, pcaGrid, patternOrigin, pattern, stripWidth, spacing, rotation, sensorSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // The PCA runs on the full bbox grid; restrict it to pixels INSIDE the traced
  // field so the scatter (and click/lasso → map highlight) only ever hits real
  // field pixels. `cellIndex[j]` maps a scatter point back to its pcaGrid cell.
  const pcaView = useMemo((): { sim: FieldSim; cellIndex: number[] | null } | null => {
    if (!pcaSim || !pcaGrid) return null;
    if (!aoiPoly) return { sim: pcaSim, cellIndex: null };
    const cells = pcaGrid.cells;
    const keep: number[] = [];
    for (let k = 0; k < cells.length; k++) { const [lng, lat] = cellCenter(cells[k].ring); if (pointInPoly(lng, lat, aoiPoly)) keep.push(k); }
    if (!keep.length || keep.length === cells.length) return { sim: pcaSim, cellIndex: null }; // all-in or degenerate → no remap
    const n = keep.length;
    const pA = new Float32Array(n), pBare = new Float32Array(n), mixed = new Uint8Array(n);
    let pureA = 0, pureB = 0, pureBare = 0, sumP = 0;
    for (let j = 0; j < n; j++) {
      const k = keep[j];
      pA[j] = pcaSim.proportionA[k]; pBare[j] = pcaSim.proportionBare[k]; mixed[j] = pcaSim.mixed[k];
      sumP += pA[j];
      if (mixed[j] === 0) pureA++; else if (mixed[j] === 1) pureB++; else if (mixed[j] === BARE.id) pureBare++;
    }
    const sim: FieldSim = { proportionA: pA, proportionBare: pBare, mixed, purePct: (100 * (pureA + pureB)) / n, pureA, pureB, pureBare, total: n, meanPropA: sumP / n };
    return { sim, cellIndex: keep };
  }, [pcaSim, pcaGrid, aoiPoly]);

  // Cells the user picked in the PCA scatter (click / lasso), as map polygons.
  const selectionGeojson = useMemo(() => {
    if (!pcaGrid || !selectedPixels.length) return null;
    const cells = pcaGrid.cells;
    const idxMap = pcaView?.cellIndex;
    const features = selectedPixels
      .map(j => (idxMap ? idxMap[j] : j))
      .filter(k => k != null && k >= 0 && k < cells.length)
      .map(k => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [cells[k].ring] } }));
    return features.length ? { type: 'FeatureCollection' as const, features } : null;
  }, [pcaGrid, selectedPixels, pcaView]);

  // Resolution sweep: PCA at every pixel size in RES_LADDER.
  const [sweep, setSweep] = useState<SweepStep[] | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);
  const runSweep = useCallback(() => {
    if (!aoi || !build?.epsg) return;
    const aoiL = aoi, epsg = build.epsg;
    setSweepBusy(true);
    // Defer so the "Computing…" state paints before the synchronous crunch.
    setTimeout(() => {
      const layoutL: SimLayout = { pattern, width: stripWidth, spacing, rotationDeg: rotation };
      const sensorL: SensorParams = { sigmaX, sigmaY, mixThreshold: threshold / 100 };
      const [minE, minN, maxE, maxN] = utmEnvelope(aoiL, epsg);
      const cx = (minE + maxE) / 2, cy = (minN + maxN) / 2;
      const fieldMin = Math.min(maxE - minE, maxN - minN);
      const base = aoiUtmOrigin(aoiL, epsg);
      const t = (rotation * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
      const steps: SweepStep[] = RES_LADDER.map(r => {
        // Each size gets its own purity-optimal placement (matches the map when picked).
        let ox = base[0], oy = base[1];
        if (optimizePlacement) {
          const [du, dv] = bestPhaseOffset(pattern, r, stripWidth, spacing, threshold / 100, base[0], base[1]);
          ox = base[0] + du * cos - dv * sin; oy = base[1] + du * sin + dv * cos;
        }
        const sizeM = Math.min(fieldMin, Math.max(r * 40, 20)); // ~40 px/side, bounded by the field
        const p = simulatePatch(cx - sizeM / 2, cy - sizeM / 2, sizeM, r, ox, oy, layoutL, sensorL);
        return { res: r, proportionA: p.proportionA, proportionBare: p.proportionBare, purePct: p.purePct };
      });
      setSweep(steps);
      setSweepBusy(false);
    }, 30);
  }, [aoi, build?.epsg, pattern, stripWidth, spacing, rotation, optimizePlacement, sigmaX, sigmaY, threshold]);
  // Auto-recompute whenever an input that feeds the sweep changes — no button click
  // needed. Debounced so dragging a slider doesn't refit on every frame. Only while
  // the PCA step is open (nothing else shows the sweep). The crop / noise params only
  // change the PCA embed, which PcaSweep redoes from the cached data (no refit here).
  useEffect(() => {
    if (activeStep !== 'pca') return;
    const id = setTimeout(runSweep, 250);
    return () => clearTimeout(id);
  }, [activeStep, runSweep]);
  // Click a sweep panel → show the field at that pixel size (a custom grid @ res).
  const pickRes = (r: number) => { setSourceId('custom'); setGsd(r); };
  const pcaSubsampled = !grid && !!pcaGrid; // PCA ran on a central subsample, not the whole field
  const ndviSeries = useMemo(() => {
    if (!simOn) return null;
    const m = sim?.meanPropA ?? 0.5;
    const varSched = makeBetaSchedule(TMAX, alpha, beta, magnitude);
    const pts: { day: number; A: number; B: number; mix: number; lo: number; hi: number }[] = [];
    for (let d = 0; d <= 365; d += 5) {
      const a = truthAt(cropA, d), b = truthAt(cropB, d);
      const mix = m * a + (1 - m) * b;
      const vmax = Math.max(0, mix * (1 - mix));
      const sd = Math.sqrt(Math.min(varSched[d] ?? 0, vmax));
      pts.push({ day: d, A: +a.toFixed(3), B: +b.toFixed(3), mix: +mix.toFixed(3), lo: +Math.max(0, mix - sd).toFixed(3), hi: +Math.min(1, mix + sd).toFixed(3) });
    }
    return pts;
  }, [simOn, sim, cropA, cropB, magnitude, alpha, beta]);

  /** Sim cell colour by view mode (no per-cell borders — they read as noise).
   *  f = crop-A fraction, bare = bare-soil fraction; crop-B fraction = 1−f−bare. */
  const simStyle = (f: number, bare: number, mx: number) => {
    const pB = Math.max(0, 1 - f - bare);
    let color: string;
    if (simView === 'purity') {
      color = mx === 255 ? '#ef4444' : mx === BARE.id ? BARE.color : '#22c55e';
    } else if (simView === 'ndvi') {
      const ndvi = f * truthAt(cropA, day) + pB * truthAt(cropB, day) + bare * BARE.ndvi;
      color = lerpHex('#5b4129', '#15803d', Math.max(0, Math.min(1, ndvi)));
    } else {
      // continuous mixture: fraction-weighted blend of crop A / crop B / bare soil
      color = mix3(f, pB, bare, cropA.color, colB);
    }
    return { stroke: true, color: '#000', weight: 0.6, opacity: 0.55, fillColor: color, fillOpacity: 0.8, interactive: false } as L.PathOptions;
  };
  /** "Real field" mode: transparent cells (the true pattern shows through) with
   *  just the grid outline. */
  const fieldOutlineStyle = () =>
    ({ stroke: true, color: '#0b0e11', weight: 1.6, opacity: 0.9, fill: false, interactive: false }) as L.PathOptions;
  const simGeojson = useMemo(() => {
    if (!sim || !renderGrid) return null;
    const features = [];
    for (let k = 0; k < renderGrid.cells.length; k++) {
      const c = renderGrid.cells[k];
      if (aoiPoly) { const [lng, lat] = cellCenter(c.ring); if (!pointInPoly(lng, lat, aoiPoly)) continue; }
      features.push({
        type: 'Feature' as const,
        properties: { f: sim.proportionA[k], b: sim.proportionBare[k], mx: sim.mixed[k] },
        geometry: { type: 'Polygon' as const, coordinates: [c.ring] },
      });
    }
    return { type: 'FeatureCollection' as const, features };
  }, [sim, renderGrid, aoiPoly]);

  const fsig = (c: FieldParams) => `${c.truth}_${c.L1}_${c.k1}_${c.x01}_${c.k2}_${c.x02}_${c.tc}`;
  const cropSig = `${cropA.color}${colB}-${fsig(cropA)}-${fsig(cropB)}`;
  const geoKey = renderGrid
    ? `${renderGrid.epsg}-${renderGrid.res}-${renderGrid.utmBounds.join(',')}-${basemap}-${simOn ? simView : 'off'}-${simOn && simView === 'ndvi' ? day : ''}-${pattern}-${stripWidth}-${spacing}-${rotation}-${optimizePlacement ? 'opt' : 'raw'}-${sensorSig}-${cropSig}`
    : 'none';

  const onDrawDone = useCallback((b: LngLatBounds) => {
    setAoi(b);
    setAoiPoly(null);
    setDrawKind(null);
    setActiveStep('grid');
  }, []);
  const onPolyDone = useCallback((pts: Poly) => {
    setAoi(polyBbox(pts));
    setAoiPoly(pts);
    setDrawKind(null);
    setActiveStep('grid');
  }, []);

  const startDraw = (kind: 'rect' | 'poly') => { setStatus(null); setDrawKind(kind); };
  const cancelDraw = () => setDrawKind(null);
  const clearAoi = () => { setAoi(null); setAoiPoly(null); setDrawKind(null); };
  const saveDefaultField = () => {
    if (!aoi) return;
    try { localStorage.setItem(FIELD_KEY, JSON.stringify({ aoi, aoiPoly })); setDefaultSaved(true); } catch { /* storage full/blocked */ }
  };
  const clearDefaultField = () => { try { localStorage.removeItem(FIELD_KEY); } catch { /* ignore */ } setDefaultSaved(false); };

  // Esc backs out of draw mode if it was started by mistake.
  useEffect(() => {
    if (!drawMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawKind(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawMode]);

  // Debounced place autocomplete via Photon (an OSM geocoder built for type-ahead).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || q === lastPicked.current) { setSuggestions([]); setShowSuggestions(false); return; }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`;
        const r = await fetch(url, { signal: ctrl.signal });
        const data = await r.json();
        const list: Suggestion[] = (data.features ?? [])
          .map((f: any) => {
            const p = f.properties ?? {};
            const [lon, lat] = f.geometry?.coordinates ?? [];
            const parts = [p.name, p.city || p.county, p.state, p.country].filter(Boolean);
            const label = parts.filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(', ');
            const e = p.extent; // [west, north, east, south]
            const bbox = Array.isArray(e) ? ([e[0], e[3], e[2], e[1]] as [number, number, number, number]) : undefined;
            return { label, lat, lon, bbox } as Suggestion;
          })
          .filter((s: Suggestion) => s.label && Number.isFinite(s.lat) && Number.isFinite(s.lon));
        const seen = new Set<string>();
        const deduped = list.filter(s => (seen.has(s.label) ? false : (seen.add(s.label), true)));
        setSuggestions(deduped);
        setShowSuggestions(true);
        setActiveSuggestion(-1);
      } catch { /* aborted or offline — leave current suggestions */ }
    }, 300);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [query]);

  const flyTo = (lat: number, lon: number, bbox?: [number, number, number, number]) => {
    const map = mapRef.current;
    if (!map) return;
    if (bbox) map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { maxZoom: 17 });
    else map.setView([lat, lon], 16);
  };

  const pickSuggestion = (s: Suggestion) => {
    lastPicked.current = s.label;
    setQuery(s.label);
    setSuggestions([]);
    setShowSuggestions(false);
    setActiveSuggestion(-1);
    setStatus(null);
    flyTo(s.lat, s.lon, s.bbox);
  };

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (suggestions.length) {
      pickSuggestion(suggestions[activeSuggestion >= 0 ? activeSuggestion : 0]);
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || !suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveSuggestion(i => Math.min(suggestions.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveSuggestion(i => Math.max(0, i - 1)); }
    else if (e.key === 'Escape') { setShowSuggestions(false); }
  };

  const onDownload = () => {
    if (!grid) return;
    const slug = source.provider.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const where = grid.tile ? `_${grid.tile}` : `_z${grid.zone}${grid.south ? 'S' : 'N'}`;
    const stem = `${slug}_pixels_${grid.res}m${where}`;
    // Clip the exported pixels to the traced field shape (centre inside the polygon).
    const out = aoiPoly
      ? { ...grid, cells: grid.cells.filter(c => { const [lng, lat] = cellCenter(c.ring); return pointInPoly(lng, lat, aoiPoly); }) }
      : grid;
    saveAs(gridToShapefileZip(out, stem), `${stem}.zip`);
  };

  // derived stats
  const pxSize = source.kind === 'custom' ? gsd : source.res;
  // PSF footprint on the ground: σ (px) → metres, and the Gaussian FWHM (2.355σ).
  const psfSigmaM = ((sigmaX + sigmaY) / 2) * (build?.res ?? pxSize);
  const psfFwhmM = 2.3548 * psfSigmaM;
  // Centre the PSF blob on the CENTRE of the pixel nearest the field middle, so it
  // clearly reads as one pixel's footprint (not floating between cells).
  const psfCenter = useMemo((): [number, number] | null => {
    if (!aoi) return null;
    if (!build?.utmBounds) return [(aoi[1] + aoi[3]) / 2, (aoi[0] + aoi[2]) / 2];
    const [mnE, mnN] = build.utmBounds, r = build.res;
    const fwd = proj4('EPSG:4326', crsToProj4Def(`EPSG:${build.epsg}`));
    const inv = proj4(crsToProj4Def(`EPSG:${build.epsg}`), 'EPSG:4326');
    const [cE, cN] = fwd.forward([(aoi[0] + aoi[2]) / 2, (aoi[1] + aoi[3]) / 2]);
    const pcE = mnE + (Math.floor((cE - mnE) / r) + 0.5) * r; // pixel centre
    const pcN = mnN + (Math.floor((cN - mnN) / r) + 0.5) * r;
    const [lng, lat] = inv.forward([pcE, pcN]);
    return [lat, lng];
  }, [aoi, build?.utmBounds, build?.epsg, build?.res]);
  const dims = grid
    ? {
        nx: Math.round((grid.utmBounds[2] - grid.utmBounds[0]) / grid.res),
        ny: Math.round((grid.utmBounds[3] - grid.utmBounds[1]) / grid.res),
      }
    : null;
  const areaHa = build ? (build.cellCount * pxSize * pxSize) / 10_000 : 0; // bounding-box area
  const fieldAreaHa = aoiPoly ? polyAreaHa(aoiPoly) : areaHa; // the traced field (or the box)
  const maxAreaHa = (40_000 * pxSize * pxSize) / 10_000;
  // Pixels whose centre falls inside the traced field (what the export contains).
  const fieldCellCount = useMemo(() => {
    if (!grid) return null;
    if (!aoiPoly) return grid.cells.length;
    let c = 0;
    for (const cell of grid.cells) { const [lng, lat] = cellCenter(cell.ring); if (pointInPoly(lng, lat, aoiPoly)) c++; }
    return c;
  }, [grid, aoiPoly]);
  /** S2/HLS use the MGRS tile word; Landsat uses a UTM zone. */
  const gridNoun = source.provider.startsWith('Landsat C2') ? 'zone' : 'tile';
  /** Whether a custom GSD nests cleanly inside Sentinel-2's 10 m grid. */
  const nestsS2 = Math.abs(10 / pxSize - Math.round(10 / pxSize)) < 1e-9;
  /** How much the pixels (and any aligned plot) are rotated from true north. */
  const convergence = aoi && build?.epsg ? gridConvergence((aoi[0] + aoi[2]) / 2, (aoi[1] + aoi[3]) / 2, build.epsg) : null;

  // Resampling / ordering recipe for commercial grids (works even when capped).
  const recipe = source.kind === 'custom' && build?.utmBounds
    ? (() => {
        const c = (v: number) => Number(v.toFixed(3)).toString(); // strip float noise
        const [e0, n0, e1, n1] = build.utmBounds!;
        const tap = customAnchor === 'utm' ? '-tap ' : '';
        return {
          epsg: build.epsg,
          gsd: build.res,
          extent: build.utmBounds!,
          gdalwarp: `gdalwarp -t_srs EPSG:${build.epsg} -tr ${build.res} ${build.res} ${tap}-te ${c(e0)} ${c(n0)} ${c(e1)} ${c(n1)} -r bilinear input.tif output.tif`,
        };
      })()
    : null;
  const copyRecipe = () => { if (recipe) navigator.clipboard?.writeText(recipe.gdalwarp); };

  // Collapsed-step summaries
  const areaSummary = aoi ? `≈ ${fieldAreaHa.toFixed(1)} ha ${aoiPoly ? 'field' : 'drawn'}` : 'search or draw a field';
  const gridSummary = !aoi
    ? 'needs an area'
    : grid
      ? `${source.provider} · ${grid.tile ?? `${grid.zone}${grid.south ? 'S' : 'N'}`} · ${fmt(build!.cellCount)} px`
      : build?.capped
        ? `${source.provider} · ${fmt(build.cellCount)} px (zoom to view)`
        : gridState === 'loading' ? 'identifying…' : 'pick a satellite & resolution';
  const simSummary = !aoi
    ? 'needs an area'
    : `${cropA.name} × ${cropB.name} · ${stripWidth} m ${PATTERNS.find(p => p.id === pattern)?.label.toLowerCase() ?? ''}`;

  // Drag the panel's left edge to resize it (the map takes the rest).
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) =>
      setPanelW(Math.max(320, Math.min(window.innerWidth - 280, Math.round(window.innerWidth - ev.clientX))));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setPanelW(w => { localStorage.setItem('pgrid_panel_w', String(w)); return w; });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="flex h-full w-full bg-[#050505] text-neutral-200 font-sans">
      {/* Map */}
      <div className="relative flex-1">
        <MapContainer
          ref={mapRef}
          center={initialCenter}
          zoom={16}
          maxZoom={23}
          preferCanvas
          style={{ height: '100%', width: '100%' }}
          attributionControl
        >
          <TileLayer
            key={basemap}
            url={BASEMAPS[basemap].url}
            attribution={BASEMAPS[basemap].attribution}
            maxZoom={23}
            maxNativeZoom={basemap === 'satellite' ? 18 : 19}
          />
          <ScaleControl position="bottomleft" />
          <ViewTracker onChange={setViewBounds} />
          <RectDrawer active={drawKind === 'rect'} onDone={onDrawDone} />
          <PolyDrawer active={drawKind === 'poly'} onDone={onPolyDone} />
          {aoi && !drawMode && (
            aoiPoly
              ? <Polygon positions={aoiPoly.map(([lng, lat]) => [lat, lng]) as [number, number][]} pathOptions={AOI_STYLE} />
              : <Rectangle bounds={[[aoi[1], aoi[0]], [aoi[3], aoi[2]]]} pathOptions={AOI_STYLE} />
          )}
          {showField && lineBox && build && aoi && patternOrigin && (
            <TruthOverlay extent={lineBox} epsg={build.epsg} layout={layout} origin={patternOrigin.origin} colorA={cropA.color} colorB={colB} clipPoly={aoiPoly ?? undefined} />
          )}
          {showPsf && psfCenter && psfSigmaM > 0 && (
            <PsfOverlay center={psfCenter} sigmaM={psfSigmaM} fwhmM={psfFwhmM} />
          )}
          {selectionGeojson && (
            <GeoJSON key={`sel-${selectedPixels.length}-${selectedPixels[0] ?? ''}`} data={selectionGeojson}
              style={() => ({ color: '#fde047', weight: 2, fillColor: '#fde047', fillOpacity: 0.35, interactive: false }) as L.PathOptions} />
          )}
          {(() => {
            const gridLines = lineBox && build
              ? <GridLines box={lineBox} res={build.res} epsg={build.epsg} color={BASEMAPS[basemap].light ? '#0f172a' : '#f1f5f9'} weight={0.6} />
              : null;
            if (showField) {
              // Per-cell outlines (with not-pure rings) when cells are available;
              // otherwise just the pixel-grid lines, so a thin grid never vanishes.
              const d = simGeojson ?? geojson;
              return d
                ? <GeoJSON key={geoKey + '-field'} data={d as any} style={fieldOutlineStyle} />
                : gridLines;
            }
            if (simOn && simGeojson) return <GeoJSON key={geoKey} data={simGeojson} style={(f: any) => simStyle(f?.properties?.f ?? 0, f?.properties?.b ?? 0, f?.properties?.mx ?? 0)} />;
            return gridLines;
          })()}
        </MapContainer>

        {/* Basemap switcher */}
        <div className="absolute right-3 top-3 z-[1000] flex overflow-hidden rounded-md border border-white/10 bg-[#11151acc] text-xs backdrop-blur">
          {(Object.keys(BASEMAPS) as BasemapKey[]).map(key => (
            <button
              key={key}
              onClick={() => setBasemap(key)}
              className={`px-3 py-1.5 transition-colors ${
                basemap === key ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {BASEMAPS[key].label}
            </button>
          ))}
        </div>

        {/* Real-field (true planting pattern) toggle */}
        <button
          onClick={() => setShowField(v => !v)}
          disabled={!build}
          title="Show the field as it really is — the planting pattern under the pixel grid"
          className={`absolute right-3 top-12 z-[1000] rounded-md border px-3 py-1.5 text-xs backdrop-blur transition-colors disabled:opacity-40 ${
            showField ? 'border-sky-500/50 bg-sky-500/20 text-sky-300' : 'border-white/10 bg-[#11151acc] text-slate-300 hover:text-slate-100'
          }`}
        >
          {showField ? '✓ Real field' : 'Real field'}
        </button>

        {/* Sensor PSF footprint toggle */}
        <button
          onClick={() => setShowPsf(v => !v)}
          disabled={!build || psfSigmaM <= 0}
          title="Draw the sensor's blur footprint (PSF) on the ground, to scale with the pixels"
          className={`absolute right-3 top-[5.25rem] z-[1000] rounded-md border px-3 py-1.5 text-xs backdrop-blur transition-colors disabled:opacity-40 ${
            showPsf ? 'border-sky-500/50 bg-sky-500/20 text-sky-300' : 'border-white/10 bg-[#11151acc] text-slate-300 hover:text-slate-100'
          }`}
        >
          {showPsf ? '✓ PSF blur' : 'PSF blur'}
        </button>

        {drawMode && (
          <div className="pointer-events-none absolute left-1/2 top-4 z-[1000] -translate-x-1/2 rounded-full bg-sky-500/90 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
            {drawKind === 'poly'
              ? 'Click to add corners · click the first point (or double-click) to close · Esc to cancel'
              : 'Click and drag to draw a box · press Esc to cancel'}
          </div>
        )}

        {/* Map legend (simulation overlay colours) */}
        {simOn && simGeojson && (
          <div className="pointer-events-none absolute bottom-7 left-2 z-[1000] rounded-md border border-white/10 bg-[#11151a]/85 px-2.5 py-2 text-[11px] text-slate-200 backdrop-blur">
            <div className="mb-1 font-medium text-slate-300">Mixture</div>
            <div className="space-y-1">
              <div className="h-2.5 w-32 rounded-sm" style={{ background: `linear-gradient(to right, ${colB}, ${cropA.color})` }} />
              <div className="flex w-32 justify-between text-[10px] text-slate-400">
                <span>all {nameB}</span><span>all {nameA}</span>
              </div>
              {spacing > 0 && (
                <div className="flex items-center gap-1 text-[10px] text-slate-400">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BARE.color }} /> bare-soil alley
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <aside className="relative flex shrink-0 flex-col border-l border-white/10 bg-[#11151a] text-slate-200" style={{ width: panelW }}>
        {/* Drag the left edge to widen the panel */}
        <div onPointerDown={startResize} title="Drag to resize"
          className="absolute inset-y-0 -left-1 z-[1200] w-2 cursor-col-resize hover:bg-sky-500/40" />
        <header className="shrink-0 border-b border-white/10 px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-sm font-semibold text-white">Sentinel-2 Pixel Grid Designer</h1>
            <a
              href="/"
              title="Back to the Polygon Time-Series PCA app"
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300 transition-colors hover:bg-sky-500/20"
            >
              <Layers className="h-3 w-3" /> Polygon PCA
            </a>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
            Draw your area → see the real pixels → align plots to whole, pure pixels.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
        <Step n={1} title="Experiment area" summary={areaSummary} open={activeStep === 'area'} onClick={() => toggleStep('area')}>
        {/* Search with autocomplete */}
        <form onSubmit={onSearch} className="relative flex gap-2">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            onFocus={() => { if (suggestions.length) setShowSuggestions(true); }}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            placeholder="Find a place…"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-sky-500 focus:outline-none"
          />
          <button type="submit" className="rounded-md border border-white/10 bg-neutral-800 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700">
            Go
          </button>
          {showSuggestions && suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-[1100] mt-1 max-h-64 overflow-auto rounded-md border border-white/10 bg-neutral-900 py-1 shadow-xl">
              {suggestions.map((s, i) => (
                <li key={`${s.label}-${i}`}>
                  <button
                    type="button"
                    onMouseDown={e => { e.preventDefault(); pickSuggestion(s); }}
                    onMouseEnter={() => setActiveSuggestion(i)}
                    className={`block w-full px-3 py-2 text-left text-sm ${
                      i === activeSuggestion ? 'bg-sky-500/15 text-sky-200' : 'text-neutral-300 hover:bg-neutral-800'
                    }`}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>

        {/* Draw rectangle / polygon · cancel · clear */}
        <div className="flex gap-2">
          {drawMode ? (
            <button
              onClick={cancelDraw}
              className="flex-1 rounded-md border border-white/15 bg-neutral-800 px-3 py-2 text-sm font-medium text-neutral-200 hover:bg-neutral-700"
            >
              Cancel drawing
            </button>
          ) : (
            <>
              <button
                onClick={() => startDraw('rect')}
                className="flex-1 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400"
              >
                {aoi ? 'Box' : 'Draw a box'}
              </button>
              <button
                onClick={() => startDraw('poly')}
                className="flex-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-300 hover:bg-sky-500/20"
              >
                {aoi ? 'Shape' : 'Trace field shape'}
              </button>
              {aoi && (
                <button onClick={clearAoi} className="rounded-md border border-white/10 bg-neutral-800 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-700">
                  Clear
                </button>
              )}
            </>
          )}
        </div>

        {aoi && !drawMode && (
          <div className="flex items-center gap-2 text-[11px]">
            <button
              onClick={saveDefaultField}
              className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 font-medium text-sky-300 transition-colors hover:bg-sky-500/20"
            >
              ★ Set as default field
            </button>
            {defaultSaved && (
              <>
                <span className="text-emerald-400/90">saved · loads on reload</span>
                <button onClick={clearDefaultField} className="text-neutral-500 underline decoration-dotted hover:text-neutral-300">clear</button>
              </>
            )}
          </div>
        )}

        {!aoi && (
          <p className="text-[11px] leading-relaxed text-neutral-400">
            Find your area in <span className="text-neutral-200">Satellite</span> view (top-right), then
            <span className="text-neutral-200"> Draw a box</span> for a quick rectangle, or
            <span className="text-neutral-200"> Trace field shape</span> to click around an irregular field.
          </p>
        )}
        </Step>

        <Step n={2} title="Pixel grid & export" summary={gridSummary} open={activeStep === 'grid'} onClick={() => toggleStep('grid')} enabled={!!aoi}>
        {!aoi ? (
          <p className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-slate-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : (<>
        {/* Satellite / grid source */}
        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-neutral-400">Satellite / grid</label>
          <select
            value={sourceId}
            onChange={e => setSourceId(e.target.value)}
            className="w-full rounded-md border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none"
          >
            {[FIXED, TASK].map(g => (
              <optgroup key={g} label={g}>
                {SOURCES.filter(s => s.group === g).map(s => (
                  <option key={s.id} value={s.id}>{s.provider}{s.resLabel !== '—' ? ` · ${s.resLabel}` : ''}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="mt-1 text-[11px] leading-snug text-neutral-500">{source.note}</p>
        </div>

        {/* Custom grid controls (commercial / tasking) */}
        {source.kind === 'custom' && (
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-neutral-400">Pixel size (GSD)</label>
              <div className="flex flex-wrap items-center gap-1.5">
                {GSD_PRESETS.map(g => (
                  <button
                    key={g}
                    onClick={() => setGsd(g)}
                    className={`rounded-md border px-2 py-1 text-sm ${gsd === g ? 'border-sky-500 bg-sky-500/15 text-sky-300' : 'border-white/10 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'}`}
                  >
                    {g} m
                  </button>
                ))}
                <input
                  type="number" min="0.05" step="0.05" value={gsd}
                  onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setGsd(v); }}
                  className="w-16 rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none"
                />
              </div>
              <p className="mt-1 text-[11px] leading-snug text-neutral-500">
                {nestsS2
                  ? <span className="text-emerald-400/80">✓ nests in Sentinel-2's 10 m grid ({Math.round(10 / gsd)}×{Math.round(10 / gsd)} per S2 pixel).</span>
                  : <>Doesn't divide 10 m — won't align to Sentinel-2's grid.</>}
              </p>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-neutral-400">Grid origin</label>
              <div className="flex gap-1.5">
                {([['utm', 'UTM grid (× GSD)'], ['plot', 'Align to my plot']] as const).map(([v, lbl]) => (
                  <button
                    key={v}
                    onClick={() => setCustomAnchor(v)}
                    className={`flex-1 rounded-md border px-2 py-1.5 text-xs ${customAnchor === v ? 'border-sky-500 bg-sky-500/15 text-sky-300' : 'border-white/10 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'}`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] leading-snug text-neutral-500">
                {customAnchor === 'utm'
                  ? 'Pixel edges on multiples of the GSD — reproducible across every delivery (gdalwarp -tap).'
                  : 'Grid starts at your drawn box corner, so pixels line up with the plot.'}
              </p>
            </div>
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-300">
              This is a grid <span className="font-medium">you define</span> — {source.provider} has no fixed grid.
              Imagery lands here only if you order / resample onto it (recipe below).
            </p>
          </div>
        )}

        {/* Real product grid (authoritative anchor) — catalog sources only */}
        {aoi && source.kind === 'catalog' && (
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-neutral-400">
              {source.provider} {gridNoun}
            </label>

            {gridState === 'loading' && (
              <p className="text-sm text-neutral-400">Identifying the {gridNoun} from the catalog…</p>
            )}

            {gridState === 'ok' && grids && grids.length > 1 && (
              <>
                <select
                  value={selectedGridKey ?? ''}
                  onChange={e => setSelectedGridKey(e.target.value)}
                  className="w-full rounded-md border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none"
                >
                  {grids.map(g => (
                    <option key={g.label} value={g.label}>
                      {g.label} — EPSG:{g.epsg} (zone {zoneFromEpsg(g.epsg)})
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] leading-snug text-amber-400/90">
                  This area straddles {grids.length} {gridNoun}s with different grids. Pick the one
                  whose product you’ll use.
                </p>
              </>
            )}

            {gridState === 'ok' && grids && grids.length === 1 && (
              <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                {grids[0].label} · EPSG:{grids[0].epsg}
                <span className="mt-0.5 block text-[11px] text-emerald-400/80">✓ aligned to the real product grid</span>
              </p>
            )}

            {gridState === 'error' && source.offlinePhase0 && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-snug text-amber-300">
                Couldn’t reach the catalog — grid computed offline. Still exact for the standard
                zone (this grid's origin is a multiple of the pixel size).
              </p>
            )}

            {gridState === 'error' && !source.offlinePhase0 && (
              <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] leading-snug text-rose-300">
                Couldn’t identify the {source.provider} grid — its lattice is offset from Sentinel-2
                and must be read live from the catalog. Check your connection and redraw.
              </p>
            )}
          </div>
        )}

        {/* Sensor sharpness (PSF) — a property of the chosen satellite */}
        {aoi && build && (
          <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">Sensor blur · PSF (σ, px)</label>
              <button
                onClick={() => setShowPsf(v => !v)}
                disabled={psfSigmaM <= 0}
                className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40 ${showPsf ? 'border-sky-500/50 bg-sky-500/15 text-sky-300' : 'border-white/10 bg-neutral-800 text-neutral-300 hover:text-neutral-100'}`}
              >
                {showPsf ? '✓ on map' : 'show on map'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center gap-1"><span className="w-7 text-[11px] text-neutral-500">σx</span>
                <input type="number" min="0" max="5" step="0.1" value={sigmaX} onChange={e => setSigmaX(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" /></div>
              <div className="flex items-center gap-1"><span className="w-7 text-[11px] text-neutral-500">σy</span>
                <input type="number" min="0" max="5" step="0.1" value={sigmaY} onChange={e => setSigmaY(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" /></div>
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">
              Default <span className="font-mono">{source.psf.toFixed(2)}</span> px = {source.provider}'s <span className="text-neutral-300">worst-case</span> blur — the blurriest end of its MTF-at-Nyquist range (conservative){source.psfSrc && <> · <a href={source.psfSrc.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline decoration-dotted hover:text-sky-300">{source.psfSrc.label} ↗</a></>}.{' '}
              {psfSigmaM > 0
                ? <>One ground point smears across <span className="font-mono text-sky-300">≈{psfFwhmM < 10 ? psfFwhmM.toFixed(1) : Math.round(psfFwhmM)} m</span> (FWHM) — {(psfFwhmM / build.res).toFixed(1)}× the {build.res} m pixel. <span className="text-neutral-300">Show on map</span> to see it.</>
                : <>σ = 0 → perfectly sharp pixels.</>}
            </p>
          </div>
        )}

        {/* Stats + download */}
        {aoi && build && (
          <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-3 text-sm">
            {build.capped ? (
              <p className="text-amber-400/90">
                Full field ≈ <span className="font-mono">{fmt(build.cellCount)}</span> pixels.{' '}
                <span className="text-emerald-400/90">The grid is drawn on the map</span> — zoom in to see / simulate individual pixels.{' '}
                {source.kind === 'custom'
                  ? 'Export the whole field via the recipe below.'
                  : <>Draw a smaller area (≤ {fmt(Math.round(maxAreaHa))} ha at {pxSize} m) to export the cells.</>}
              </p>
            ) : grid && dims ? (
              <>
                <dl className="grid grid-cols-2 gap-y-1.5 text-neutral-300">
                  <dt className="text-neutral-500">Source</dt>
                  <dd className="text-right">{source.provider} · {grid.res} m</dd>
                  {grid.tile && <><dt className="text-neutral-500 capitalize">{gridNoun}</dt><dd className="text-right font-mono">{grid.tile}</dd></>}
                  <dt className="text-neutral-500">CRS</dt>
                  <dd className="text-right font-mono">EPSG:{grid.epsg}</dd>
                  <dt className="text-neutral-500">Grid</dt>
                  <dd className="text-right font-mono">{dims.nx} × {dims.ny}{aoiPoly ? ' bbox' : ''}</dd>
                  <dt className="text-neutral-500">{aoiPoly ? 'Pixels in field' : 'Pixels'}</dt>
                  <dd className="text-right font-mono">{fmt(aoiPoly ? (fieldCellCount ?? 0) : build.cellCount)}</dd>
                  <dt className="text-neutral-500">Area</dt>
                  <dd className="text-right font-mono">{fieldAreaHa.toFixed(2)} ha</dd>
                </dl>
                <button
                  onClick={onDownload}
                  className="mt-3 w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"
                >
                  Download shapefile (.zip)
                </button>
                <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">
                  {source.kind === 'custom'
                    ? <>A grid <span className="text-neutral-300">you defined</span> ({customAnchor === 'utm' ? 'multiples of GSD' : 'aligned to your plot'}) in UTM (EPSG:{grid.epsg}), with a .prj.</>
                    : grid.anchored
                      ? <>Polygons anchored to the real <span className="font-mono">{grid.tile}</span> {source.provider} grid in native UTM (EPSG:{grid.epsg}), with a .prj — these are the actual pixel squares.</>
                      : <>Polygons in native UTM (EPSG:{grid.epsg}) with a .prj — exact pixel squares for the standard zone.</>}
                </p>
                {convergence !== null && (
                  <div className="mt-2 rounded-md border border-sky-500/25 bg-sky-500/10 p-2 text-[11px] leading-snug text-sky-200/90">
                    <span className="font-medium text-sky-300">Row orientation:</span> pixels are{' '}
                    <span className="font-mono">{Math.abs(convergence).toFixed(2)}°</span>{' '}
                    {Math.abs(convergence) < 0.05 ? 'aligned with true north' : convergence > 0 ? 'clockwise (east) of true north' : 'counter-clockwise (west) of true north'}.{' '}
                    {Math.abs(convergence) < 0.05
                      ? 'Rows can follow true north here.'
                      : <>Rotate plot rows {Math.abs(convergence).toFixed(2)}° from true/compass north to match the pixels — or set your RTK A–B line parallel to the UTM grid (use the exported shapefile).</>}
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}

        {/* Order / resample recipe (commercial grids) */}
        {aoi && recipe && (
          <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Order / resample recipe</span>
              <button onClick={copyRecipe} className="rounded border border-white/10 bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700">Copy</button>
            </div>
            <code className="block overflow-x-auto whitespace-pre rounded bg-black/40 p-2 text-[11px] leading-relaxed text-emerald-300">{recipe.gdalwarp}</code>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-neutral-400">
              <dt>CRS</dt><dd className="font-mono">EPSG:{recipe.epsg}</dd>
              <dt>GSD</dt><dd className="font-mono">{recipe.gsd} m</dd>
              <dt>Extent</dt><dd className="font-mono break-all">{recipe.extent.map(v => Math.round(v)).join(', ')}</dd>
            </dl>
            <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">
              Run this on every delivery (or set CRS + GSD in your tasking order) so all images land on this grid.
            </p>
          </div>
        )}
        </>)}
        </Step>

        <Step n={3} title="Simulate experiment" summary={simSummary} open={activeStep === 'sim'} onClick={() => toggleStep('sim')} enabled={!!aoi}>
        {!aoi ? (
          <p className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-slate-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : (
              <div className="space-y-3">
                <p className="text-[11px] leading-snug text-neutral-500">
                  Lay out an intercropping / variety pattern and see what each resolution resolves.
                </p>
                <div>
                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Layout</label>
                  <select value={pattern} onChange={e => setPattern(e.target.value as PatternType)}
                    className="w-full rounded-md border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none">
                    {PATTERNS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Strip width</label>
                    <div className="flex items-center gap-1">
                      <input type="number" min="0.5" step="0.5" value={stripWidth}
                        onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setStripWidth(v); }}
                        className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" />
                      <span className="text-xs text-neutral-500">m</span>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Row spacing</label>
                    <div className="flex items-center gap-1">
                      <input type="number" min="0" step="0.5" value={spacing}
                        onChange={e => setSpacing(Math.max(0, parseFloat(e.target.value) || 0))}
                        className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" />
                      <span className="text-xs text-neutral-500">m</span>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Strip angle</label>
                    <div className="flex items-center gap-1">
                      <input type="number" min="0" max="90" step="1" value={rotation}
                        onChange={e => setRotation(Math.max(0, Math.min(90, parseInt(e.target.value) || 0)))}
                        className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" />
                      <span className="text-xs text-neutral-500">°</span>
                    </div>
                  </div>
                </div>
                <p className="text-[11px] leading-snug text-neutral-500">Row spacing inserts a bare-soil alley between strips (shown in brown).</p>

                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-2.5 py-2">
                  <input type="checkbox" checked={optimizePlacement} onChange={e => setOptimizePlacement(e.target.checked)} className="mt-0.5 accent-emerald-500" />
                  <span className="text-xs text-neutral-200">
                    <span className="font-medium">Align plants to the pixels</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">
                      {optimizePlacement
                        ? <>Offset the planting <span className="font-mono text-emerald-300">{placementShift ?? '0 cm'}</span> from the field's SW corner so strip edges land on pixel edges — maximises pure pixels.</>
                        : <>Plants start exactly at the field edge (may straddle pixels).</>}
                    </span>
                  </span>
                </label>

                <p className="text-[11px] leading-snug text-neutral-500">
                  0° = strips run along the pixel rows (why it looks aligned). This angle is relative to the
                  pixel grid — the grid itself sits{convergence !== null ? ` ${Math.abs(convergence).toFixed(2)}° ` : ' ~1° '}
                  off true north (grid convergence), visible on the map.
                </p>

                <div className="space-y-2">
                  <CropControl label="Crop A" crop={cropA} preset={presetA}
                    onCrop={c => { setCropA(c); setPresetA('custom'); }}
                    onPreset={id => { setCropA(cropById(id)); setPresetA(id); }} />
                  <CropControl label="Crop B" crop={cropB} preset={presetB} swatchColor={colB}
                    onCrop={c => { setCropB(c); setPresetB('custom'); }}
                    onPreset={id => { setCropB(cropById(id)); setPresetB(id); }} />
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Noise variance (Beta schedule)</label>
                  <div className="grid grid-cols-3 gap-2">
                    {([['mag', magnitude, setMagnitude, 0, 0.15, 0.005], ['α', alpha, setAlpha, 0.1, 10, 0.1], ['β', beta, setBeta, 0.1, 10, 0.1]] as const).map(([lbl, val, set, mn, mx, st]) => (
                      <div key={lbl}>
                        <span className="mb-0.5 block text-[11px] text-neutral-500">{lbl}</span>
                        <input type="number" min={mn} max={mx} step={st} value={val} onChange={e => set(Math.max(mn, Math.min(mx, parseFloat(e.target.value) || 0)))}
                          className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" />
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Pure ≥ {threshold}% one crop</label>
                  <input type="range" min="50" max="100" step="5" value={threshold} onChange={e => setThreshold(parseInt(e.target.value))} className="w-full accent-sky-500" />
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Map view · mixture</label>
                  <div className="text-[11px] text-neutral-400">
                    <div className="h-2.5 w-full rounded-sm" style={{ background: `linear-gradient(to right, ${colB}, ${cropA.color})` }} />
                    <div className="mt-0.5 flex justify-between text-[10px]"><span>all {nameB}</span><span>50/50</span><span>all {nameA}</span></div>
                    {spacing > 0 && (
                      <div className="mt-1 flex items-center gap-1 text-[10px]">
                        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BARE.color }} /> bare-soil alley
                      </div>
                    )}
                  </div>
                </div>

                {sim && renderGrid && (
                  <div className="rounded-md border border-white/10 bg-black/30 p-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs text-neutral-400">Pure pixels @ {renderGrid.res} m{clippedView ? ' (in view)' : ''}</span>
                      <span className={`font-mono text-lg ${sim.purePct >= 70 ? 'text-emerald-400' : sim.purePct >= 40 ? 'text-amber-400' : 'text-rose-400'}`}>{sim.purePct.toFixed(0)}%</span>
                    </div>
                    <p className="text-[11px] text-neutral-500">{fmt(sim.pureA + sim.pureB)} / {fmt(sim.total)} pixels ≥{threshold}% one crop · A {fmt(sim.pureA)} · B {fmt(sim.pureB)}{spacing > 0 ? ` · bare ${fmt(sim.pureBare)}` : ''}</p>
                  </div>
                )}

                {build?.epsg && (
                  <SimVisual aoi={aoi} epsg={build.epsg} origin={patternOrigin?.origin ?? null} layout={layout} sensor={sensor} colorA={cropA.color} colorB={colB} />
                )}

                {ndviSeries && (
                  <div>
                    <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">NDVI season — pure vs mixed pixel</label>
                    <div style={{ height: 150 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={ndviSeries} margin={{ top: 5, right: 6, bottom: 0, left: -24 }}>
                          <XAxis dataKey="day" tick={{ fontSize: 9, fill: '#888' }} ticks={[0, 90, 180, 270, 365]} />
                          <YAxis domain={[0, 1]} tick={{ fontSize: 9, fill: '#888' }} />
                          <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 11 }} labelFormatter={d => `day ${d}`} />
                          {simView === 'ndvi' && <ReferenceLine x={day} stroke="#666" strokeDasharray="3 3" />}
                          {magnitude > 0 && <Line type="monotone" dataKey="hi" stroke="#64748b" dot={false} strokeWidth={0.75} name="noise +σ" />}
                          {magnitude > 0 && <Line type="monotone" dataKey="lo" stroke="#64748b" dot={false} strokeWidth={0.75} name="noise −σ" />}
                          <Line type="monotone" dataKey="A" stroke={cropA.color} dot={false} strokeWidth={1.5} name={cropA.name} />
                          <Line type="monotone" dataKey="B" stroke={colB} dot={false} strokeWidth={1.5} name={dupSpecies ? `${cropB.name} (B)` : cropB.name} />
                          <Line type="monotone" dataKey="mix" stroke="#e5e7eb" strokeDasharray="4 3" dot={false} strokeWidth={1.5} name="Mixed pixel" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="text-[11px] leading-snug text-neutral-500">
                      Dashed = the mixed pixel a sensor measures (tracks neither crop){magnitude > 0 ? '; grey band = the Beta-scheduled noise (±σ).' : '.'}
                    </p>
                  </div>
                )}
              </div>
        )}
        </Step>

        <Step n={4} title="PCA simulation" summary={`${cropA.name} × ${cropB.name} → PCA`} open={activeStep === 'pca'} onClick={() => toggleStep('pca')} enabled={!!aoi}>
        {!aoi ? (
          <p className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-slate-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : pcaView ? (
          <div className="space-y-3">
            {pcaSubsampled && (
              <p className="rounded-md border border-sky-500/20 bg-sky-500/5 px-2.5 py-1.5 text-[11px] text-sky-300/90">
                Field too fine to draw in full — PCA computed on a representative {fmt(pcaView.sim.total)}-pixel central subsample.
              </p>
            )}
            <PcaSimVisual sim={pcaView.sim} cropA={cropAd} cropB={cropBd} magnitude={magnitude}
              onSelect={setSelectedPixels} busy={pcaBusy} />

            {/* Resolution sweep — every pixel size side-by-side */}
            <div className="rounded-lg border border-white/10 bg-black/20 p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Across resolutions</span>
                <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">{sweepBusy ? <><Spinner className="h-3 w-3" /> <span className="text-sky-300">Updating…</span></> : `${RES_LADDER[0]}–${RES_LADDER[RES_LADDER.length - 1]} m · live`}</span>
              </div>
              {sweep ? (
                <>
                  <PcaSweep steps={sweep} cropA={cropAd} cropB={cropBd} magnitude={magnitude} activeRes={build?.res} onPick={pickRes} />
                  <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">
                    Each panel is an independent PCA of the field's pixels at that size (% = pure single-crop pixels); watch the two crop clusters merge as the sensor coarsens. <span className="text-neutral-300">Click a panel</span> to render the field at that resolution on the map.
                  </p>
                </>
              ) : (
                <p className="text-[11px] leading-snug text-neutral-500">Computing the PCA at {RES_LADDER[0]}–{RES_LADDER[RES_LADDER.length - 1]} m…</p>
              )}
            </div>

            <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">Grid, field &amp; plant parameters</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Resolution · grid</label>
                <select value={sourceId} onChange={e => setSourceId(e.target.value)}
                  className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-100 focus:border-sky-500 focus:outline-none">
                  {[FIXED, TASK].map(g => (
                    <optgroup key={g} label={g}>
                      {SOURCES.filter(s => s.group === g).map(s => (
                        <option key={s.id} value={s.id}>{s.provider}{s.resLabel !== '—' ? ` · ${s.resLabel}` : ''}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Layout</label>
                <select value={pattern} onChange={e => setPattern(e.target.value as PatternType)}
                  className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-100 focus:border-sky-500 focus:outline-none">
                  {PATTERNS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
            </div>
            {source.kind === 'custom' && (
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Pixel size (GSD)</label>
                <select value={gsd} onChange={e => setGsd(+e.target.value)}
                  className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-100 focus:border-sky-500 focus:outline-none">
                  {GSD_PRESETS.map(g => <option key={g} value={g}>{g} m</option>)}
                </select>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Strip width</label>
                <div className="flex items-center gap-1">
                  <input type="number" min="0.5" step="0.5" value={stripWidth}
                    onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setStripWidth(v); }}
                    className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" />
                  <span className="text-xs text-neutral-500">m</span>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Row spacing</label>
                <div className="flex items-center gap-1">
                  <input type="number" min="0" step="0.5" value={spacing}
                    onChange={e => setSpacing(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" />
                  <span className="text-xs text-neutral-500">m</span>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-neutral-400">Field rotation</label>
                <div className="flex items-center gap-1">
                  <input type="number" min="0" max="90" step="1" value={rotation}
                    onChange={e => setRotation(Math.max(0, Math.min(90, parseInt(e.target.value) || 0)))}
                    className="w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" />
                  <span className="text-xs text-neutral-500">°</span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <CropControl label="Crop A" crop={cropA} preset={presetA}
                onCrop={c => { setCropA(c); setPresetA('custom'); }}
                onPreset={id => { setCropA(cropById(id)); setPresetA(id); }} />
              <CropControl label="Crop B" crop={cropB} preset={presetB} swatchColor={colB}
                onCrop={c => { setCropB(c); setPresetB('custom'); }}
                onPreset={id => { setCropB(cropById(id)); setPresetB(id); }} />
            </div>
          </div>
        ) : (
          <p className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-slate-400">Build the pixel grid in step&nbsp;2 first.</p>
        )}
        </Step>

        {status && <p className="px-4 py-2 text-xs text-slate-400">{status}</p>}
        </div>

        <div className="shrink-0 border-t border-white/10 px-4 py-2 text-[11px] text-slate-500">
          <a href="/" className="text-sky-400 hover:underline">← Polygon Time-Series PCA</a>
        </div>
      </aside>
    </div>
  );
}
