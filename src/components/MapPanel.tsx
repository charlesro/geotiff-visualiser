import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, ImageOverlay, CircleMarker, ScaleControl, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Bbox } from '../lib/geo';
import { ZoneExtraction } from '../lib/zones';
import { polygonLabel } from '../lib/polygon-source';
import { NdviPixel } from '../lib/ndvi-series';
import { CLUSTER_COLORS, fieldKeyOf } from '../lib/species-clusters';
import { mixHexColors } from '../lib/unmix';
import { ZONE_CLASSES, zoneColor, speciesColor, NEUTRAL } from '../lib/legend';
import { LegendRow, GradientLegend } from './ui';
import { RasterLayer } from '../types';
import SceneTimeline from './SceneTimeline';
import { Activity, Eye, EyeOff, Square } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * The single map of the app: polygons (click to select), the buffer-zone
 * pixel split, and an optional true-colour preview of a fetched scene.
 */

export interface ScenePreview {
  url: string;
  bounds: [[number, number], [number, number]];
  opacity: number;
}

interface MapPanelProps {
  polygons: any | null;
  selectedIds: Set<number>;
  onTogglePolygon: (pid: number) => void;
  /** Add a batch of polygons to the selection (box draw); never deselects. */
  onBoxSelect: (pids: number[]) => void;
  /** Clear the whole selection. */
  onClearSelection: () => void;
  zones: ZoneExtraction | null;
  preview: ScenePreview | null;
  /** Native-10 m windows of the previewed scene, drawn over the coarse mosaic. */
  clusterPreviews: ScenePreview[];
  /** Boundary-prediction heatmap overlays (step 7); empty when off. */
  predictionOverlays: ScenePreview[];
  scenes: RasterLayer[];
  previewSceneId: string | null;
  onPreviewScene: (id: string | null) => void;
  onDeleteScene: (id: string) => void;
  /** Called with the clicked polygon while "Inspect NDVI" mode is active. */
  onInspectPolygon: (feature: any) => void;
  /** Field key → scenario index from step 4; colours the clustered fields. */
  clusterAssignment: Map<string, number> | null;
  clusterVersion: number;
  /** Pixels of the polygon open in the NDVI inspector — clickable markers. */
  inspectPixels: NdviPixel[] | null;
  /** Pixel picked in the NDVI panel or on the map, marked with a white ring. */
  highlightPixel: { id?: string; lng: number; lat: number } | null;
  onPickPixel: (pixel: NdviPixel) => void;
  /** When the PCA panel is open, zone dots become clickable to pick a pixel. */
  pcaPickMode: boolean;
  onPickMapPixel: (p: { id: string; zone: string; lng: number; lat: number }) => void;
  /** Changes to this object trigger a fitBounds. `padRight` keeps the target
   *  clear of a drawer covering the right side of the map. */
  fitRequest: { bounds: Bbox; token: number; padRight?: number; maxZoom?: number } | null;
}

const BASEMAPS = {
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
  },
  ign: {
    label: 'IGN Ortho',
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
    attribution: '© IGN — Géoplateforme',
  },
  topo: {
    label: 'Topo',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, HERE, Garmin, FAO, NOAA',
  },
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  streets: {
    label: 'Streets',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
  },
} as const;

type BasemapKey = keyof typeof BASEMAPS;

function FitController({ fitRequest }: { fitRequest: MapPanelProps['fitRequest'] }) {
  const map = useMap();
  useEffect(() => {
    if (!fitRequest) return;
    const [minLng, minLat, maxLng, maxLat] = fitRequest.bounds;
    map.fitBounds(
      [
        [minLat, minLng],
        [maxLat, maxLng],
      ],
      {
        paddingTopLeft: [40, 40],
        paddingBottomRight: [40 + (fitRequest.padRight ?? 0), 40],
        maxZoom: fitRequest.maxZoom ?? 16,
      }
    );
  }, [fitRequest, map]);
  return null;
}

/** Report the map's zoom so the coarse mosaic can hide when zoomed in. */
function ZoomWatcher({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMap();
  useEffect(() => onZoom(map.getZoom()), [map, onZoom]);
  useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  return null;
}

/**
 * While the PCA panel is open, a click on the map picks the nearest zone
 * pixel (within ~1 pixel) and reports it, so it highlights in the scatter.
 * One O(n) search per click — cheaper and smoother than making every dot an
 * interactive layer (which would hit-test on every hover).
 */
function PixelPicker({
  active,
  zones,
  onPick,
}: {
  active: boolean;
  zones: ZoneExtraction | null;
  onPick: (p: { id: string; zone: string; lng: number; lat: number }) => void;
}) {
  useMapEvents({
    click: e => {
      if (!active || !zones) return;
      const { lat, lng } = e.latlng;
      const cosLat = Math.cos((lat * Math.PI) / 180);
      let best: any = null;
      let bestD = Infinity;
      for (const f of [...zones.interior.features, ...zones.edge.features]) {
        const c = f.geometry?.coordinates;
        if (!c) continue;
        const dLat = c[1] - lat;
        const dLng = (c[0] - lng) * cosLat;
        const d = dLat * dLat + dLng * dLng;
        if (d < bestD) { bestD = d; best = f; }
      }
      // Accept only if the click landed within ~8 m of a pixel centre.
      if (best && Math.sqrt(bestD) * 111320 < 8) {
        onPick({ id: best.properties.id, zone: best.properties.zone, lng: best.geometry.coordinates[0], lat: best.geometry.coordinates[1] });
      }
    },
  });
  return null;
}

function BboxSelector({ polygons, onSelectBox }: { polygons: any | null; onSelectBox: (pids: number[]) => void }) {
  const map = useMap();
  const [drawMode, setDrawMode] = useState(false);
  const [firstPoint, setFirstPoint] = useState<L.LatLng | null>(null);
  const [rect, setRect] = useState<L.Rectangle | null>(null);
  const [marker, setMarker] = useState<L.CircleMarker | null>(null);

  useMapEvents({
    click: (e) => {
      if (!drawMode) return;

      if (!firstPoint) {
        // First click — place a corner marker and wait for the second click
        if (marker) map.removeLayer(marker);
        const m = L.circleMarker(e.latlng, { radius: 5, color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 1, weight: 2 });
        m.addTo(map);
        setMarker(m);
        setFirstPoint(e.latlng);
      } else {
        // Second click — complete the rectangle
        const bounds = L.latLngBounds(firstPoint, e.latlng);
        if (rect) map.removeLayer(rect);
        if (marker) map.removeLayer(marker);
        setRect(null);
        setMarker(null);
        setFirstPoint(null);

        // Add every polygon whose bounds intersect the drawn box to the
        // selection in one batch (a box always *adds*, never toggles off).
        if (polygons?.features) {
          const hits: number[] = [];
          for (const f of polygons.features) {
            if (!f.properties?.__pid && f.properties?.__pid !== 0) continue;
            try {
              if (L.geoJSON(f).getBounds().intersects(bounds)) hits.push(f.properties.__pid);
            } catch {
              /* skip invalid geometries */
            }
          }
          if (hits.length) onSelectBox(hits);
        }
        setDrawMode(false);
      }
    },
    mousemove: (e) => {
      if (!drawMode || !firstPoint) return;
      if (rect) map.removeLayer(rect);
      const newRect = L.rectangle(
        [[firstPoint.lat, firstPoint.lng], [e.latlng.lat, e.latlng.lng]],
        { color: '#38bdf8', fill: true, fillOpacity: 0.1, weight: 2, dashArray: '5 5' }
      );
      newRect.addTo(map);
      setRect(newRect);
    },
  });

  const cancel = () => {
    if (rect) map.removeLayer(rect);
    if (marker) map.removeLayer(marker);
    setRect(null);
    setMarker(null);
    setFirstPoint(null);
    setDrawMode(false);
  };

  return (
    <button
      onClick={() => (drawMode ? cancel() : setDrawMode(true))}
      className={cn(
        'absolute left-3 top-12 z-[1000] flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
        drawMode && !firstPoint && 'border-sky-400 bg-sky-500/20 text-sky-200',
        drawMode && firstPoint && 'border-amber-400 bg-amber-500/20 text-amber-200',
        !drawMode && 'border-white/10 bg-[#11151acc] text-slate-300 hover:text-slate-200'
      )}
    >
      <Square className="h-3.5 w-3.5" />
      {!drawMode && 'Select by box'}
      {drawMode && !firstPoint && 'Click first corner…'}
      {drawMode && firstPoint && 'Click second corner…'}
    </button>
  );
}

export default function MapPanel({ polygons, selectedIds, onTogglePolygon, onBoxSelect, onClearSelection, zones, clusterAssignment, clusterVersion, preview, clusterPreviews, predictionOverlays, scenes, previewSceneId, onPreviewScene, onDeleteScene, onInspectPolygon, inspectPixels, highlightPixel, onPickPixel, pcaPickMode, onPickMapPixel, fitRequest }: MapPanelProps) {
  const [basemap, setBasemap] = useState<BasemapKey>('dark');
  const [mapZoom, setMapZoom] = useState(0);
  const [showZoneDots, setShowZoneDots] = useState(true);
  // Once zoomed in far enough for the native-10 m windows to resolve, hide the
  // coarse mosaic so the zone dots sit on their true 10 m pixels, not on the
  // much coarser preview squares.
  const hideCoarseMosaic = clusterPreviews.length > 0 && mapZoom >= 15;
  // Colour edge_other_species pixels by their mixing fraction instead of a
  // flat class colour: own species at α=1 ↔ partner species at α=0.
  const [showMixing, setShowMixing] = useState(false);
  const hasMixing = (zones?.unmixing?.count ?? 0) > 0;
  const [probeMode, setProbeMode] = useState(false);
  // Polygon click handlers are bound when the GeoJSON layer mounts (the
  // layer only remounts when polygons/selection change); read the mode and
  // the callbacks through refs so the bound handlers never go stale.
  const probeRef = useRef(probeMode);
  probeRef.current = probeMode;
  // While picking PCA pixels, polygon clicks must not also toggle selection.
  const pcaPickRef = useRef(pcaPickMode);
  pcaPickRef.current = pcaPickMode;
  const handlersRef = useRef({ onTogglePolygon, onInspectPolygon });
  handlersRef.current = { onTogglePolygon, onInspectPolygon };

  // What the polygon outlines encode right now — drives both the colouring
  // and the legend, so the two can never disagree.
  const polygonMode: 'scenario' | 'species' | 'neutral' =
    clusterAssignment && clusterAssignment.size > 0 ? 'scenario' : zones && showZoneDots ? 'neutral' : 'species';

  // GeoJSON layers only restyle when remounted, so key them on their inputs.
  const polygonsKey = useMemo(
    () => `polys-${polygons?.features?.length ?? 0}-${Array.from(selectedIds).join('.')}-cl${clusterVersion}-${polygonMode}`,
    [polygons, selectedIds, clusterVersion, polygonMode]
  );
  const zonesKey = useMemo(() => (zones ? Date.now() : 0), [zones]);

  // Legend data for the active polygon encoding.
  const speciesLegend = useMemo<[string, number][]>(() => {
    if (!polygons || polygonMode !== 'species') return [];
    const counts = new Map<string, number>();
    for (const f of polygons.features) {
      const s = f.properties?.crp_lbl ?? f.properties?.species;
      if (s == null) continue;
      counts.set(String(s), (counts.get(String(s)) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [polygons, polygonMode]);

  const scenarioLegend = useMemo<[number, number][]>(() => {
    if (polygonMode !== 'scenario' || !clusterAssignment) return [];
    const counts = new Map<number, number>();
    for (const v of clusterAssignment.values()) counts.set(v, (counts.get(v) || 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => a[0] - b[0]);
  }, [clusterAssignment, polygonMode]);

  const zoneCount = (key: string): number =>
    key === 'interior'
      ? zones?.interior.features.length ?? 0
      : key === 'edge_other_species'
        ? zones?.edgeCounts.other ?? 0
        : key === 'edge_same_species'
          ? zones?.edgeCounts.same ?? 0
          : zones?.edgeCounts.isolated ?? 0;

  const polygonStyle = (feature: any) => {
    const selected = selectedIds.has(feature?.properties?.__pid);
    // The base fill keeps encoding the active mode (species / scenario /
    // muted) even when selected — selection is shown as a blue outline on
    // top, so the species colour stays visible.
    const scenario = clusterAssignment?.get(fieldKeyOf(feature?.properties));
    let base: string;
    let fillOpacity: number;
    if (scenario !== undefined) {
      base = CLUSTER_COLORS[scenario % CLUSTER_COLORS.length];
      fillOpacity = 0.3;
    } else if (polygonMode === 'neutral') {
      // Pixel zones drawn: dots carry the colour, so mute the outlines.
      base = NEUTRAL;
      fillOpacity = 0.04;
    } else {
      base = speciesColor(feature?.properties?.crp_lbl);
      fillOpacity = 0.12;
    }
    return {
      color: selected ? '#38bdf8' : base,
      weight: selected ? 2.5 : scenario !== undefined ? 1.8 : 1.2,
      opacity: selected ? 1 : 0.7,
      fillColor: base,
      fillOpacity: selected ? Math.max(fillOpacity, 0.2) : fillOpacity,
    };
  };

  const onEachPolygon = (feature: any, layer: L.Layer) => {
    const path = layer as L.Path;
    const scenario = clusterAssignment?.get(fieldKeyOf(feature?.properties));
    const label = polygonLabel(feature) + (scenario !== undefined ? ` · scenario ${scenario + 1}` : '');
    layer.bindTooltip(label, { sticky: true, direction: 'top', opacity: 0.9 });
    layer.on({
      click: () => {
        if (pcaPickRef.current) return; // pixel-pick mode owns clicks
        if (probeRef.current) handlersRef.current.onInspectPolygon(feature);
        else handlersRef.current.onTogglePolygon(feature.properties.__pid);
      },
      mouseover: () => path.setStyle({ weight: 3.5 }),
      mouseout: () => path.setStyle(polygonStyle(feature)),
    });
  };

  // interactive:false — the dots never swallow clicks (picking a pixel for
  // the PCA scatter is handled by a single map-click nearest-pixel search,
  // see PixelPicker, which avoids hit-testing every dot on hover).
  const pixelToMarker = (feature: any, latlng: L.LatLng) => {
    const props = feature.properties || {};
    let fill = zoneColor(props.zone);
    // Mixing view: blend the two species' own colours by the species-A
    // proportion (B at 0 → A at 1).
    if (showMixing && props.zone === 'edge_other_species' && typeof props.mix_frac_a === 'number') {
      fill = mixHexColors(speciesColor(props.mix_b_species), speciesColor(props.mix_a_species), props.mix_frac_a);
    }
    return L.circleMarker(latlng, {
      radius: 3,
      stroke: true,
      color: '#0b0e11',
      weight: 0.8,
      opacity: 0.9,
      fillColor: fill,
      fillOpacity: 0.95,
      interactive: false,
    });
  };

  const boundaryStyle = {
    color: '#f8fafc',
    weight: 1.2,
    dashArray: '4 4',
    opacity: 0.8,
    fill: false,
  };

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={[46.5, 2.5]}
        zoom={6}
        className="h-full w-full"
        preferCanvas
        zoomControl={true}
        attributionControl={true}
      >
        <TileLayer key={basemap} url={BASEMAPS[basemap].url} attribution={BASEMAPS[basemap].attribution} maxZoom={19} />
        <ScaleControl position="bottomleft" />
        <FitController fitRequest={fitRequest} />
        <BboxSelector polygons={polygons} onSelectBox={onBoxSelect} />
        <PixelPicker active={pcaPickMode} zones={zones} onPick={onPickMapPixel} />
        <ZoomWatcher onZoom={setMapZoom} />
        <button
          onClick={() => setProbeMode(p => !p)}
          className={cn(
            'absolute left-3 top-[5.5rem] z-[1000] flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
            probeMode
              ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200'
              : 'border-white/10 bg-[#11151acc] text-slate-300 hover:text-slate-200'
          )}
          title="When active, clicking a polygon shows its NDVI time series instead of selecting it"
        >
          <Activity className="h-3.5 w-3.5" />
          {probeMode ? 'Click a polygon…' : 'Inspect NDVI'}
        </button>

        {/* react-leaflet's ImageOverlay never updates `url` in place — key the
            overlays on the previewed scene so switching dates swaps the image. */}
        {preview && !hideCoarseMosaic && (
          <ImageOverlay
            key={`preview-${previewSceneId}`}
            url={preview.url}
            bounds={preview.bounds}
            opacity={preview.opacity}
            className="pixel-perfect"
          />
        )}
        {clusterPreviews.map((c, i) => (
          <ImageOverlay
            key={`cluster-${previewSceneId}-${i}`}
            url={c.url}
            bounds={c.bounds}
            opacity={c.opacity}
            className="pixel-perfect"
          />
        ))}
        {predictionOverlays.map((c, i) => (
          <ImageOverlay key={`predict-${i}`} url={c.url} bounds={c.bounds} opacity={c.opacity} className="pixel-perfect" />
        ))}

        {polygons && (
          <GeoJSON key={polygonsKey} data={polygons} style={polygonStyle} onEachFeature={onEachPolygon} />
        )}

        {zones && (
          <>
            {showZoneDots && (
              <>
                <GeoJSON key={`zone-edge-${zonesKey}-${showMixing ? 'mix' : 'cls'}`} data={zones.edge} pointToLayer={pixelToMarker} />
                <GeoJSON key={`zone-interior-${zonesKey}`} data={zones.interior} pointToLayer={pixelToMarker} />
              </>
            )}
            <GeoJSON
              key={`zone-boundaries-${zonesKey}`}
              data={zones.boundaries}
              style={boundaryStyle}
              interactive={false}
            />
          </>
        )}

        {/* Pixels of the inspected polygon: click one to highlight its curve. */}
        {inspectPixels?.map(p => {
          const selected = highlightPixel?.id === p.id;
          return (
            <CircleMarker
              key={p.id}
              center={[p.lat, p.lng]}
              radius={selected ? 6.5 : 4.5}
              pathOptions={{
                color: selected ? '#ffffff' : '#0b0e11',
                weight: selected ? 2.5 : 1,
                fillColor: zoneColor(p.zone),
                fillOpacity: 0.95,
              }}
              eventHandlers={{ click: () => onPickPixel(p) }}
            />
          );
        })}
        {highlightPixel && (
          <>
            <CircleMarker
              center={[highlightPixel.lat, highlightPixel.lng]}
              radius={14}
              pathOptions={{ color: '#0b0e11', weight: 5, fill: false, opacity: 0.6 }}
              interactive={false}
            />
            <CircleMarker
              center={[highlightPixel.lat, highlightPixel.lng]}
              radius={14}
              pathOptions={{ color: '#ffffff', weight: 2.5, fill: false }}
              interactive={false}
            />
            <CircleMarker
              center={[highlightPixel.lat, highlightPixel.lng]}
              radius={2.5}
              pathOptions={{ stroke: false, fillColor: '#ffffff', fillOpacity: 1 }}
              interactive={false}
            />
          </>
        )}
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

      {/* Boundary-prediction heatmap legend */}
      {predictionOverlays.length > 0 && (
        <div className="absolute left-3 top-3 z-[1000] rounded-md border border-white/10 bg-[#11151acc] px-3 py-2 backdrop-blur">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Predicted boundary</div>
          <div
            className="h-2 w-40 rounded"
            style={{ background: 'linear-gradient(to right, #140b34, #88226a, #de4940, #fcdc8c)' }}
          />
          <div className="mt-0.5 flex justify-between text-[10px] text-slate-500">
            <span>low</span>
            <span>high likelihood</span>
          </div>
        </div>
      )}

      {/* Scene timeline */}
      <SceneTimeline
        scenes={scenes}
        previewSceneId={previewSceneId}
        onPreviewScene={onPreviewScene}
        onDeleteScene={onDeleteScene}
      />

      {/* Legend — one panel, every colour on screen explained. Sits above the
          scene timeline when one is shown. */}
      {polygons && (
        <div
          className={cn(
            'absolute right-3 z-[1000] w-60 overflow-y-auto rounded-md border border-white/10 bg-[#11151acc] px-3 py-2 backdrop-blur',
            scenes.length > 0 ? 'bottom-20 max-h-[calc(100%-7rem)]' : 'bottom-6 max-h-[calc(100%-4rem)]'
          )}
        >
          {/* What the polygon outlines mean */}
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Fields · {polygonMode === 'scenario' ? 'growth scenario' : polygonMode === 'neutral' ? 'muted' : 'by species'}
          </div>
          {polygonMode === 'species' &&
            speciesLegend.slice(0, 6).map(([s, c]) => (
              <LegendRow key={s} color={speciesColor(s)} label={s} count={c} shape="square" />
            ))}
          {polygonMode === 'species' && speciesLegend.length > 6 && (
            <div className="py-0.5 text-[10px] text-slate-600">+{speciesLegend.length - 6} more species</div>
          )}
          {polygonMode === 'scenario' &&
            scenarioLegend.map(([n, c]) => (
              <LegendRow key={n} color={CLUSTER_COLORS[n % CLUSTER_COLORS.length]} label={`Scenario ${n + 1}`} count={c} shape="square" />
            ))}
          {polygonMode === 'neutral' && (
            <div className="py-0.5 text-[11px] text-slate-500">Outlines muted — coloured by pixel class below.</div>
          )}
          {selectedIds.size > 0 && (
            <button onClick={onClearSelection} className="group flex w-full items-center gap-2 py-0.5 text-left" title="Clear the selection">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: '#38bdf8' }} />
              <span className="min-w-0 flex-1 truncate text-xs text-slate-300 group-hover:text-white">
                Selected <span className="text-slate-500 group-hover:text-slate-300">· clear</span>
              </span>
              <span className="shrink-0 tabular-nums text-xs text-slate-500">{selectedIds.size.toLocaleString()}</span>
            </button>
          )}

          {/* What the pixel dots mean */}
          {zones && (
            <div className="mt-2 border-t border-white/10 pt-2">
              <div className="mb-1 flex items-start justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Pixel class · {zones.metric} · {zones.distance} m
                </span>
                <button
                  onClick={() => setShowZoneDots(s => !s)}
                  className="shrink-0 text-slate-400 transition-colors hover:text-white"
                  title={showZoneDots ? 'Hide the pixel dots' : 'Show the pixel dots'}
                >
                  {showZoneDots ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                </button>
              </div>
              {ZONE_CLASSES.map(z => (
                <LegendRow key={z.key} color={z.color} label={z.short} count={zoneCount(z.key)} />
              ))}

              {hasMixing && (
                <div className="mt-2 border-t border-white/10 pt-2">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={showMixing}
                      onChange={e => setShowMixing(e.target.checked)}
                      className="accent-sky-500"
                    />
                    <span className="font-medium text-slate-200">Recolour edge·other by species mix</span>
                  </label>
                  {showMixing && (
                    <div className="mt-1.5">
                      <GradientLegend
                        from={speciesColor(zones.unmixing!.speciesB)}
                        to={speciesColor(zones.unmixing!.speciesA)}
                        leftLabel={`100% ${zones.unmixing!.speciesB}`}
                        rightLabel={`100% ${zones.unmixing!.speciesA}`}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
