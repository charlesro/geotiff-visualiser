import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, ImageOverlay, ScaleControl, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Bbox } from '../lib/geo';
import { ZoneExtraction } from '../lib/zones';
import { polygonLabel } from '../lib/polygon-source';
import { Square } from 'lucide-react';
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
  const [startLatLng, setStartLatLng] = useState<L.LatLng | null>(null);
  const [rect, setRect] = useState<L.Rectangle | null>(null);

  useMapEvents({
    mousedown: (e) => {
      if (!drawMode) return;
      setStartLatLng(e.latlng);
    },
    mousemove: (e) => {
      if (!drawMode || !startLatLng) return;
      if (rect) map.removeLayer(rect);
      const newRect = L.rectangle([[startLatLng.lat, startLatLng.lng], [e.latlng.lat, e.latlng.lng]], { color: '#38bdf8', fill: true, fillOpacity: 0.1, weight: 2 });
      newRect.addTo(map);
      setRect(newRect);
    },
    mouseup: (e) => {
      if (!drawMode || !startLatLng) return;
      const bounds = L.latLngBounds(startLatLng, e.latlng);
      if (rect) map.removeLayer(rect);
      setRect(null);
      setStartLatLng(null);

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
    },
  });

  return (
    <button
      onClick={() => setDrawMode(!drawMode)}
      className={cn(
        'absolute left-3 top-12 z-[1000] flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
        drawMode
          ? 'border-sky-400 bg-sky-500/20 text-sky-200'
          : 'border-white/10 bg-[#11151acc] text-slate-300 hover:text-slate-200'
      )}
    >
      <Square className="h-3.5 w-3.5" />
      {drawMode ? 'Drawing…' : 'Select by box'}
    </button>
  );
}

const ZONE_COLORS: Record<string, string> = {
  interior: '#34d399',
  edge: '#fbbf24',
};

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

export default function MapPanel({ polygons, selectedIds, onTogglePolygon, zones, preview, fitRequest }: MapPanelProps) {
  const [basemap, setBasemap] = useState<BasemapKey>('satellite');

  // GeoJSON layers only restyle when remounted, so key them on their inputs.
  const polygonsKey = useMemo(
    () => `polys-${polygons?.features?.length ?? 0}-${Array.from(selectedIds).join('.')}`,
    [polygons, selectedIds]
  );

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
      click: () => onTogglePolygon(feature.properties.__pid),
      mouseover: () => path.setStyle({ weight: 3.5 }),
      mouseout: () => path.setStyle(polygonStyle(feature)),
    });
  };

  const pixelToMarker = (feature: any, latlng: L.LatLng) =>
    L.circleMarker(latlng, {
      radius: 3,
      stroke: false,
      fillColor: ZONE_COLORS[feature.properties?.zone] || '#94a3b8',
      fillOpacity: 0.85,
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

        {preview && (
          <ImageOverlay url={preview.url} bounds={preview.bounds} opacity={preview.opacity} className="pixel-perfect" />
        )}

        {polygons && (
          <GeoJSON key={polygonsKey} data={polygons} style={polygonStyle} onEachFeature={onEachPolygon} />
        )}

        {zones && (
          <>
            <GeoJSON key="zone-edge" data={zones.edge} pointToLayer={pixelToMarker} />
            <GeoJSON key="zone-interior" data={zones.interior} pointToLayer={pixelToMarker} />
            <GeoJSON key="zone-boundaries" data={zones.boundaries} style={boundaryStyle} />
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

      {/* Zone legend */}
      {zones && (
        <div className="absolute bottom-6 right-3 z-[1000] rounded-md border border-white/10 bg-[#11151acc] px-3 py-2 text-xs text-slate-300 backdrop-blur">
          <div className="mb-1 font-medium text-slate-200">
            Pixel zones · {zones.metric} · {zones.distance} m
          </div>
          <div className="flex items-center gap-2 py-0.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: ZONE_COLORS.interior }} />
            Interior (&ge; {zones.distance} m inside) · {zones.interior.features.length} px
          </div>
          <div className="flex items-center gap-2 py-0.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: ZONE_COLORS.edge }} />
            Edge (&lt; {zones.distance} m from boundary) · {zones.edge.features.length} px
          </div>
        </div>
      )}
    </div>
  );
}
