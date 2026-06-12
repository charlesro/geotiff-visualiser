import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, ImageOverlay, CircleMarker, ScaleControl, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Bbox } from '../lib/geo';
import { ZoneExtraction } from '../lib/zones';
import { polygonLabel } from '../lib/polygon-source';
import { NdviPixel } from '../lib/ndvi-series';
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
  zones: ZoneExtraction | null;
  preview: ScenePreview | null;
  /** Native-10 m windows of the previewed scene, drawn over the coarse mosaic. */
  clusterPreviews: ScenePreview[];
  scenes: RasterLayer[];
  previewSceneId: string | null;
  onPreviewScene: (id: string | null) => void;
  onDeleteScene: (id: string) => void;
  /** Called with the clicked polygon while "Inspect NDVI" mode is active. */
  onInspectPolygon: (feature: any) => void;
  /** Pixels of the polygon open in the NDVI inspector — clickable markers. */
  inspectPixels: NdviPixel[] | null;
  /** Pixel picked in the NDVI panel or on the map, marked with a white ring. */
  highlightPixel: { id?: string; lng: number; lat: number } | null;
  onPickPixel: (pixel: NdviPixel) => void;
  /** Changes to this object trigger a fitBounds. */
  fitRequest: { bounds: Bbox; token: number } | null;
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
      { padding: [40, 40], maxZoom: 16 }
    );
  }, [fitRequest, map]);
  return null;
}

function BboxSelector({ polygons, onSelect }: { polygons: any | null; onSelect: (pid: number) => void }) {
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

        // Find all polygons whose bounds intersect the drawn box
        if (polygons?.features) {
          for (const f of polygons.features) {
            if (!f.properties?.__pid && f.properties?.__pid !== 0) continue;
            try {
              const fbounds = L.geoJSON(f).getBounds();
              if (fbounds.intersects(bounds)) {
                onSelect(f.properties.__pid);
              }
            } catch {
              /* skip invalid geometries */
            }
          }
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

const ZONE_COLORS: Record<string, string> = {
  interior: '#34d399',
  edge_other_species: '#f87171',
  edge_same_species: '#fbbf24',
  edge_isolated: '#94a3b8',
};

const ZONE_LEGEND: { key: string; label: (d: number) => string }[] = [
  { key: 'interior', label: d => `Interior (≥ ${d} m inside)` },
  { key: 'edge_other_species', label: () => 'Edge — other species next to it' },
  { key: 'edge_same_species', label: () => 'Edge — same species next to it' },
  { key: 'edge_isolated', label: () => 'Edge — no neighbouring field' },
];

// Deterministic color cycle for crop species (crp_lbl).
const SPECIES_COLORS = [
  '#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
  '#06b6d4', '#f97316', '#14b8a6', '#d946ef', '#6366f1', '#84cc16',
  '#fb923c', '#22d3ee', '#f87171', '#60a5fa', '#34d399', '#fbbf24',
];

const speciesColor = (crpLbl: string | undefined): string => {
  if (!crpLbl) return '#e2e8f0';
  // Hash the species name to a consistent index.
  let hash = 0;
  for (let i = 0; i < crpLbl.length; i++) {
    hash = ((hash << 5) - hash) + crpLbl.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return SPECIES_COLORS[Math.abs(hash) % SPECIES_COLORS.length];
};

export default function MapPanel({ polygons, selectedIds, onTogglePolygon, zones, preview, clusterPreviews, scenes, previewSceneId, onPreviewScene, onDeleteScene, onInspectPolygon, inspectPixels, highlightPixel, onPickPixel, fitRequest }: MapPanelProps) {
  const [basemap, setBasemap] = useState<BasemapKey>('dark');
  const [showZoneDots, setShowZoneDots] = useState(true);
  const [probeMode, setProbeMode] = useState(false);
  // Polygon click handlers are bound when the GeoJSON layer mounts (the
  // layer only remounts when polygons/selection change); read the mode and
  // the callbacks through refs so the bound handlers never go stale.
  const probeRef = useRef(probeMode);
  probeRef.current = probeMode;
  const handlersRef = useRef({ onTogglePolygon, onInspectPolygon });
  handlersRef.current = { onTogglePolygon, onInspectPolygon };

  // GeoJSON layers only restyle when remounted, so key them on their inputs.
  const polygonsKey = useMemo(
    () => `polys-${polygons?.features?.length ?? 0}-${Array.from(selectedIds).join('.')}`,
    [polygons, selectedIds]
  );
  const zonesKey = useMemo(() => (zones ? Date.now() : 0), [zones]);

  const polygonStyle = (feature: any) => {
    const selected = selectedIds.has(feature?.properties?.__pid);
    const baseColor = speciesColor(feature?.properties?.crp_lbl);
    return {
      color: selected ? '#38bdf8' : baseColor,
      weight: selected ? 2.5 : 1.2,
      opacity: selected ? 1 : 0.7,
      fillColor: selected ? '#38bdf8' : baseColor,
      fillOpacity: selected ? 0.18 : 0.12,
    };
  };

  const onEachPolygon = (feature: any, layer: L.Layer) => {
    const path = layer as L.Path;
    layer.bindTooltip(polygonLabel(feature), { sticky: true, direction: 'top', opacity: 0.9 });
    layer.on({
      click: () => {
        if (probeRef.current) handlersRef.current.onInspectPolygon(feature);
        else handlersRef.current.onTogglePolygon(feature.properties.__pid);
      },
      mouseover: () => path.setStyle({ weight: 3.5 }),
      mouseout: () => path.setStyle(polygonStyle(feature)),
    });
  };

  // interactive: false — the dots must not swallow clicks meant for the
  // polygons underneath (selection and the NDVI inspector).
  const pixelToMarker = (feature: any, latlng: L.LatLng) =>
    L.circleMarker(latlng, {
      radius: 3,
      stroke: false,
      fillColor: ZONE_COLORS[feature.properties?.zone] || '#94a3b8',
      fillOpacity: 0.85,
      interactive: false,
    });

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
        <BboxSelector polygons={polygons} onSelect={onTogglePolygon} />
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
        {preview && (
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

        {polygons && (
          <GeoJSON key={polygonsKey} data={polygons} style={polygonStyle} onEachFeature={onEachPolygon} />
        )}

        {zones && (
          <>
            {showZoneDots && (
              <>
                <GeoJSON key={`zone-edge-${zonesKey}`} data={zones.edge} pointToLayer={pixelToMarker} />
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
                fillColor: ZONE_COLORS[p.zone] || '#94a3b8',
                fillOpacity: 0.95,
              }}
              eventHandlers={{ click: () => onPickPixel(p) }}
            />
          );
        })}
        {highlightPixel && (
          <CircleMarker
            center={[highlightPixel.lat, highlightPixel.lng]}
            radius={10}
            pathOptions={{ color: '#ffffff', weight: 2.5, fill: false }}
            interactive={false}
          />
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

      {/* Scene timeline */}
      <SceneTimeline
        scenes={scenes}
        previewSceneId={previewSceneId}
        onPreviewScene={onPreviewScene}
        onDeleteScene={onDeleteScene}
      />

      {/* Zone legend */}
      {zones && (
        <div className="absolute bottom-6 right-3 z-[1000] rounded-md border border-white/10 bg-[#11151acc] px-3 py-2 text-xs text-slate-300 backdrop-blur">
          <div className="mb-1 flex items-center justify-between gap-3 font-medium text-slate-200">
            <span>
              Pixel zones · {zones.metric} · {zones.distance} m
            </span>
            <button
              onClick={() => setShowZoneDots(s => !s)}
              className="text-slate-400 transition-colors hover:text-white"
              title={showZoneDots ? 'Hide the pixel dots' : 'Show the pixel dots'}
            >
              {showZoneDots ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </button>
          </div>
          {ZONE_LEGEND.map(({ key, label }) => {
            const count =
              key === 'interior'
                ? zones.interior.features.length
                : key === 'edge_other_species'
                  ? zones.edgeCounts.other
                  : key === 'edge_same_species'
                    ? zones.edgeCounts.same
                    : zones.edgeCounts.isolated;
            return (
              <div key={key} className="flex items-center gap-2 py-0.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ZONE_COLORS[key] }} />
                {label(zones.distance)} · {count} px
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
