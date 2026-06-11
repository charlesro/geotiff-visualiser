import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, ImageOverlay, useMap, GeoJSON, ScaleControl, useMapEvents, Marker, Rectangle } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import { Layer, RasterLayer } from '../types';
import { Map as MapIcon } from 'lucide-react';
import { cn } from '../lib/utils';
import { getSpeciesColor, extractSpecies } from '../lib/species';
import { isPixelsLayer } from '../lib/layer-factory';

export function MapClickHandler({ isPixelAnalysisMode, onPixelClick }: { isPixelAnalysisMode?: boolean, onPixelClick?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      if (isPixelAnalysisMode && onPixelClick) {
        onPixelClick(e.latlng.lat, e.latlng.lng);
      }
    },
  });
  return null;
}

// Custom component to handle dynamic clipping of ImageOverlay
function ClippedImageOverlay({ url, bounds, opacity, clipPath, ...props }: any) {
  const overlayRef = useRef<L.ImageOverlay>(null);

  useEffect(() => {
    const el = overlayRef.current?.getElement();
    if (el) {
      el.style.clipPath = clipPath || '';
    }
  }, [clipPath, url]);

  return (
    <ImageOverlay
      ref={overlayRef}
      url={url}
      bounds={bounds}
      opacity={opacity}
      className="pixel-perfect"
      {...props}
    />
  );
}

// Fix for default marker icons in Leaflet
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

interface MapViewerProps {
  layers: Layer[];
  onAreaSelected?: (bbox: [number, number, number, number] | null) => void;
  onDrawingUpdate?: (bbox: [number, number, number, number] | null) => void;
  isDrawingMode?: boolean;
  isPixelAnalysisMode?: boolean;
  onPixelClick?: (lat: number, lng: number) => void;
  onZoomChange?: (zoom: number) => void;
  onViewportChange?: (bounds: string, zoom: number, center: [number, number]) => void;
  searchBbox?: [number, number, number, number] | null;
  filterByBbox?: boolean;
  selectedVectorFeature?: any;
  initialCenter?: [number, number];
  onVectorClick?: (feature: any) => void;
  selectedLayerId?: string | null;
}

function GeomanController({ onAreaSelected, onDrawingUpdate, isDrawingMode, searchBbox }: { onAreaSelected?: (bbox: [number, number, number, number] | null) => void, onDrawingUpdate?: (bbox: [number, number, number, number] | null) => void, isDrawingMode?: boolean, searchBbox?: [number, number, number, number] | null }) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    map.pm.setGlobalOptions({ 
      allowSelfIntersection: false,
      snappable: false
    });

    map.pm.addControls({
      position: 'topleft',
      drawCircle: false,
      drawMarker: false,
      drawPolyline: false,
      drawRectangle: true,
      drawPolygon: false,
      drawCircleMarker: false,
      drawText: false,
      editMode: true,
      dragMode: true,
      cutLayer: false,
      removalMode: true,
    });

    // Hide controls by default, show only if needed or keep them for convenience
    // map.pm.toggleControls(); 

    const handleCreate = (e: any) => {
      const layer = e.layer;
      if (e.shape === 'Rectangle') {
        const bounds = layer.getBounds();
        const west = bounds.getWest();
        const south = bounds.getSouth();
        const east = bounds.getEast();
        const north = bounds.getNorth();
        
        onAreaSelected?.([west, south, east, north]);
        
        // Remove other rectangles if any (keep only one)
        map.eachLayer((l: any) => {
          if (l instanceof L.Rectangle && l !== layer) {
            map.removeLayer(l);
          }
        });
      }
    };

    const handleRemove = (e: any) => {
      if (e.shape === 'Rectangle') {
        onAreaSelected?.(null);
      }
    };

    const handleUpdate = (e: any) => {
      const layer = e.layer;
      if (layer instanceof L.Rectangle) {
        const bounds = layer.getBounds();
        onAreaSelected?.([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
      }
    };

    map.on('pm:create', handleCreate);
    map.on('pm:remove', handleRemove);
    
    const handleDrawStart = (e: any) => {
      const workingLayer = e.workingLayer;
      const handleMouseMove = () => {
        if (workingLayer && typeof workingLayer.getBounds === 'function') {
          try {
            const bounds = workingLayer.getBounds();
            if (bounds.isValid()) {
              onDrawingUpdate?.([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
            }
          } catch (err) {}
        }
      };
      map.on('mousemove', handleMouseMove);
      
      const handleDrawEnd = () => {
        map.off('mousemove', handleMouseMove);
        map.off('pm:drawend', handleDrawEnd);
        onDrawingUpdate?.(null);
      };
      map.on('pm:drawend', handleDrawEnd);
    };
    map.on('pm:drawstart', handleDrawStart);

    map.on('pm:globaleditmodetoggled', (e) => {
      if (!e.enabled) {
        // When edit mode is disabled, we might want to update the bbox
        map.eachLayer((l: any) => {
          if (l instanceof L.Rectangle) {
            const bounds = l.getBounds();
            onAreaSelected?.([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
          }
        });
      }
    });

    // Listen for updates on layers
    map.on('layeradd', (e: any) => {
      if (e.layer instanceof L.Rectangle) {
        e.layer.on('pm:edit', handleUpdate);
        e.layer.on('pm:dragend', handleUpdate);
      }
    });

    return () => {
      map.off('pm:create', handleCreate);
      map.off('pm:remove', handleRemove);
      map.off('pm:drawstart', handleDrawStart);
      map.eachLayer((l: any) => {
        if (l instanceof L.Rectangle) {
          l.off('pm:edit', handleUpdate);
          l.off('pm:dragend', handleUpdate);
        }
      });
    };
  }, [map, onAreaSelected]);

  useEffect(() => {
    if (isDrawingMode) {
      map.pm.enableDraw('Rectangle', {
        snappable: false,
      });
    } else {
      map.pm.disableDraw();
    }
  }, [map, isDrawingMode]);

  useEffect(() => {
    if (!searchBbox) {
      map.eachLayer((l: any) => {
        if (l instanceof L.Rectangle) {
          map.removeLayer(l);
        }
      });
    }
  }, [map, searchBbox]);

  return null;
}

function MapController({ layers }: { layers: Layer[] }) {
  const map = useMap();
  const fittedLayersRef = React.useRef<Set<string>>(new Set());

  useEffect(() => {
    const visibleLayers = layers.filter(l => l.visible);
    if (visibleLayers.length === 0) return;

    // Check if there are any new layers that we haven't fitted yet
    const newLayerIds = visibleLayers.map(l => l.id).filter(id => !fittedLayersRef.current.has(id));
    
    if (newLayerIds.length > 0) {
      const bounds = L.latLngBounds([]);
      
      // Only fit bounds for the NEW layers
      const newLayers = visibleLayers.filter(l => newLayerIds.includes(l.id));
      
      newLayers.forEach(layer => {
        // Skip automatic zooming for remotely fetched Sentinel/STAC images to avoid jumping the map
        if (layer.type === 'raster' && (layer as any).stacItem) {
          return;
        }
        if (layer.type === 'raster' && layer.data.bounds) {
          bounds.extend(layer.data.bounds);
        } else if (layer.type === 'vector' && layer.data) {
          const geoLayer = L.geoJSON(layer.data);
          bounds.extend(geoLayer.getBounds());
        }
      });

      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [20, 20] });
      }
    }
    
    // Mark ALL layers as fitted so we don't fit bounds when toggling visibility later
    layers.forEach(l => fittedLayersRef.current.add(l.id));
  }, [layers, map]);

  return null;
}


function PixelGrid({ layer, clipPath }: { layer: RasterLayer, clipPath?: string }) {
  const gridSvgUrl = useMemo(() => {
    if (!layer.options.showGrid || !layer.data.bounds) return null;
    
    // Use the actual canvas dimensions (which might be upscaled)
    const width = layer.data.image.width;
    const height = layer.data.image.height;
    
    // Use the native dimensions of the fetched window to determine scale
    // Fall back to metadata width/height if window dimensions aren't available
    const nativeWidth = layer.data.metadata.windowWidth || layer.data.metadata.width;
    const nativeHeight = layer.data.metadata.windowHeight || layer.data.metadata.height;
    
    // Calculate the scale factor between native window and current canvas
    const scaleX = width / nativeWidth;
    const scaleY = height / nativeHeight;
    
    // Adjust spacing based on scale
    const spacingX = (layer.options.gridSpacing || 1) * scaleX;
    const spacingY = (layer.options.gridSpacing || 1) * scaleY;
    
    // Create a simple SVG grid
    // stroke-width="1" here refers to 1 pixel of the upscaled canvas
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">
        <defs>
          <pattern id="grid" width="${spacingX}" height="${spacingY}" patternUnits="userSpaceOnUse">
            <path d="M ${spacingX} 0 L 0 0 0 ${spacingY}" fill="none" stroke="rgba(255, 255, 255, 0.2)" stroke-width="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
        <path d="M ${width} 0 L ${width} ${height} L 0 ${height}" fill="none" stroke="rgba(255, 255, 255, 0.2)" stroke-width="1" />
      </svg>
    `;
    
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  }, [layer.options.showGrid, layer.options.gridSpacing, layer.data.image.width, layer.data.image.height, layer.data.metadata.width, layer.data.metadata.height]);

  if (!gridSvgUrl || !layer.data.bounds) return null;

  return (
    <ClippedImageOverlay
      url={gridSvgUrl}
      bounds={layer.data.bounds}
      opacity={1}
      interactive={false}
      zIndex={1000}
      className="pixelated-overlay"
      clipPath={clipPath}
    />
  );
}

function ResolutionDisplay() {
  const map = useMap();
  const [resolution, setResolution] = useState<number>(0);

  const calculateResolution = useCallback(() => {
    const zoom = map.getZoom();
    const lat = map.getCenter().lat;
    // Standard Web Mercator resolution formula (meters per pixel)
    const res = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    setResolution(res);
  }, [map]);

  useEffect(() => {
    calculateResolution();
    map.on('zoomend moveend', calculateResolution);
    return () => {
      map.off('zoomend moveend', calculateResolution);
    };
  }, [map, calculateResolution]);

  return (
    <div className="absolute bottom-6 right-6 z-[1000] pointer-events-none">
      <div className="bg-black/60 backdrop-blur-md border border-white/10 rounded-lg px-3 py-2 flex flex-col items-end">
        <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Ground Resolution</p>
        <p className="text-xs font-mono text-orange-500">
          {resolution < 1 ? `${(resolution * 100).toFixed(2)} cm/px` : `${resolution.toFixed(2)} m/px`}
        </p>
      </div>
    </div>
  );
}

function RasterLayerRenderer({ layers, filterByBbox, searchBbox, isPixelAnalysisMode, isDrawingMode, onVectorClick, selectedLayerId, selectedVectorFeature }: { layers: Layer[], filterByBbox?: boolean, searchBbox?: [number, number, number, number] | null, isPixelAnalysisMode?: boolean, isDrawingMode?: boolean, onVectorClick?: (feature: any) => void, selectedLayerId?: string | null, selectedVectorFeature?: any }) {
  const map = useMap();
  const [, setTick] = useState(0);

  // Force re-render on map events to ensure clip-path percentages are calculated with fresh projections
  useEffect(() => {
    const handleEvents = () => setTick(t => t + 1);
    map.on('moveend zoomend', handleEvents);
    return () => {
      map.off('moveend zoomend', handleEvents);
    };
  }, [map]);

  const getClipPath = (layer: Layer) => {
    if (layer.type !== 'raster' || !layer.data.bounds) return undefined;
    
    const [[lMinLat, lMinLon], [lMaxLat, lMaxLon]] = layer.data.bounds;
    
    let clipMinLon = -180, clipMinLat = -90, clipMaxLon = 180, clipMaxLat = 90;
    let hasClip = false;

    if (filterByBbox && searchBbox) {
      const [sMinLon, sMinLat, sMaxLon, sMaxLat] = searchBbox;
      clipMinLon = Math.max(clipMinLon, sMinLon);
      clipMinLat = Math.max(clipMinLat, sMinLat);
      clipMaxLon = Math.min(clipMaxLon, sMaxLon);
      clipMaxLat = Math.min(clipMaxLat, sMaxLat);
      hasClip = true;
    }

    if (layer.clipBbox) {
      const [cMinLon, cMinLat, cMaxLon, cMaxLat] = layer.clipBbox;
      clipMinLon = Math.max(clipMinLon, cMinLon);
      clipMinLat = Math.max(clipMinLat, cMinLat);
      clipMaxLon = Math.min(clipMaxLon, cMaxLon);
      clipMaxLat = Math.min(clipMaxLat, cMaxLat);
      hasClip = true;
    }

    if (!hasClip) return undefined;

    // Calculate intersection of layer bounds and clip bounds
    const EPSILON = 1e-5; // Approx 1m on Earth
    if (lMaxLat < clipMinLat - EPSILON || lMinLat > clipMaxLat + EPSILON ||
        lMaxLon < clipMinLon - EPSILON || lMinLon > clipMaxLon + EPSILON) {
      return 'inset(100%)';
    }

    const interMinLat = Math.max(lMinLat, clipMinLat);
    const interMinLon = Math.max(lMinLon, clipMinLon);
    const interMaxLat = Math.max(interMinLat, Math.min(lMaxLat, clipMaxLat));
    const interMaxLon = Math.max(interMinLon, Math.min(lMaxLon, clipMaxLon));

    const lBounds = L.latLngBounds(layer.data.bounds);
    const cBounds = L.latLngBounds([interMinLat, interMinLon], [interMaxLat, interMaxLon]);

    // Use latLngToLayerPoint to get precise pixel coordinates for the current zoom
    const layerNW = map.latLngToLayerPoint(lBounds.getNorthWest());
    const layerSE = map.latLngToLayerPoint(lBounds.getSouthEast());
    const clipNW = map.latLngToLayerPoint(cBounds.getNorthWest());
    const clipSE = map.latLngToLayerPoint(cBounds.getSouthEast());
    
    const layerW = layerSE.x - layerNW.x;
    const layerH = layerSE.y - layerNW.y;
    
    if (layerW <= 0 || layerH <= 0) return undefined;

    const left = ((clipNW.x - layerNW.x) / layerW) * 100;
    const top = ((clipNW.y - layerNW.y) / layerH) * 100;
    const right = ((layerSE.x - clipSE.x) / layerW) * 100;
    const bottom = ((layerSE.y - clipSE.y) / layerH) * 100;
    
    // Clamp values to prevent "bleed through" or invalid CSS
    const l = Math.max(0, Math.min(100, left)).toFixed(6);
    const t = Math.max(0, Math.min(100, top)).toFixed(6);
    const r = Math.max(0, Math.min(100, right)).toFixed(6);
    const b = Math.max(0, Math.min(100, bottom)).toFixed(6);
    
    return `inset(${t}% ${r}% ${b}% ${l}%)`;
  };

  return (
    <>
      {[...layers].reverse().map((layer) => {
        if (!layer.visible) return null;

        const isSelected = layer.id === selectedLayerId;

        if (layer.type === 'raster' && layer.data.bounds) {
          const clipPath = getClipPath(layer);
          const drawBounds = layer.clipBbox ? [
            [layer.clipBbox[1], layer.clipBbox[0]],
            [layer.clipBbox[3], layer.clipBbox[2]]
          ] : layer.data.bounds;
          
          return (
            <React.Fragment key={`${layer.id}-${isPixelAnalysisMode}-${isDrawingMode}`}>
              <ClippedImageOverlay
                url={layer.dataUrl || layer.data.image.toDataURL()}
                bounds={layer.data.bounds}
                opacity={layer.opacity}
                interactive={!isPixelAnalysisMode && !isDrawingMode}
                className={cn("pixelated-overlay", isSelected && "selected-layer-raster")}
                clipPath={clipPath}
              />
              {isSelected && (
                <Rectangle 
                  bounds={drawBounds as L.LatLngBoundsExpression}
                  pathOptions={{ color: '#3b82f6', weight: 4, fill: false, dashArray: '5, 5' }}
                  interactive={false}
                />
              )}
              <PixelGrid layer={layer} clipPath={clipPath} />
            </React.Fragment>
          );
        }
        if (layer.type === 'vector' && layer.data) {
          return (
            <GeoJSON 
              key={`${layer.id}-${layer.name}-${isPixelAnalysisMode}-${isDrawingMode}-${isSelected}-${(layer.data as any)?.features?.length || 0}`} 
              data={layer.data as any} 
              interactive={!isPixelAnalysisMode && !isDrawingMode}
              style={(feature) => {
                if (feature?.properties?.type === 'buffer_boundary') {
                  return {
                    color: isSelected ? '#3b82f6' : '#06b6d4',
                    weight: isSelected ? 3 : 2,
                    dashArray: '5, 5',
                    fillOpacity: 0,
                    opacity: layer.opacity
                  };
                }
                const speciesVal = extractSpecies(feature?.properties);
                const speciesColor = speciesVal ? getSpeciesColor(String(speciesVal)) : undefined;
                const baseColor = speciesColor || '#f97316';

                return {
                  color: isSelected ? '#3b82f6' : baseColor,
                  weight: isSelected ? 4 : 2,
                  opacity: layer.opacity,
                  fillOpacity: layer.opacity * 0.2,
                  fillColor: isSelected ? '#3b82f6' : baseColor,
                  className: isSelected ? 'selected-vector-layer' : ''
                };
              }}
              pointToLayer={(feature, latlng) => {
                const isPointSelected = selectedVectorFeature && 
                  (feature.id === selectedVectorFeature.id || 
                   feature.properties?.id === selectedVectorFeature.properties?.id);
                
                const speciesVal = extractSpecies(feature?.properties);
                const speciesColor = speciesVal ? getSpeciesColor(String(speciesVal)) : undefined;
                const baseColor = speciesColor || '#f97316';

                return L.circleMarker(latlng, {
                  radius: isPointSelected ? 8 : (isPixelsLayer(layer) ? (isSelected ? 5 : 3) : (isSelected ? 7 : 5)),
                  fillColor: isPointSelected ? '#f97316' : (isSelected ? '#3b82f6' : baseColor),
                  color: isPointSelected ? '#ffffff' : '#fff',
                  weight: isPointSelected ? 3 : (isSelected ? 2 : 1),
                  opacity: layer.opacity,
                  fillOpacity: isPointSelected ? 1.0 : (layer.opacity * 0.8)
                });
              }}
              onEachFeature={(feature, layerNode) => {
                if (feature.properties && !isPixelAnalysisMode && !isDrawingMode) {
                  layerNode.on('click', () => {
                    if (onVectorClick) {
                      onVectorClick(feature);
                    }
                  });
                  if (!onVectorClick) {
                    const popupContent = Object.entries(feature.properties)
                      .map(([key, value]) => `<strong>${key}:</strong> ${value}`)
                      .join('<br/>');
                    layerNode.bindPopup(popupContent);
                  }
                }
              }}
            />
          );
        }
        return null;
      })}
    </>
  );
}

function MapEvents({ onZoomChange, onViewportChange }: { onZoomChange?: (zoom: number) => void, onViewportChange?: (bounds: string, zoom: number, center: [number, number]) => void }) {
  const map = useMapEvents({
    zoomend: () => {
      onZoomChange?.(map.getZoom());
      if (onViewportChange) {
        onViewportChange(map.getBounds().toBBoxString(), map.getZoom(), [map.getCenter().lat, map.getCenter().lng]);
      }
    },
    moveend: () => {
      if (onViewportChange) {
         onViewportChange(map.getBounds().toBBoxString(), map.getZoom(), [map.getCenter().lat, map.getCenter().lng]);
      }
    }
  });
  return null;
}

export function MapViewer({ 
  layers, 
  onAreaSelected, 
  onDrawingUpdate, 
  isDrawingMode, 
  isPixelAnalysisMode, 
  onPixelClick, 
  onZoomChange,
  onViewportChange,
  searchBbox, 
  filterByBbox,
  selectedVectorFeature,
  initialCenter,
  onVectorClick,
  selectedLayerId
}: MapViewerProps) {
  const processedLayers = useMemo(() => {
    if (!filterByBbox || !searchBbox) return layers;
    
    const [sMinLon, sMinLat, sMaxLon, sMaxLat] = searchBbox;
    
    return layers.filter(layer => {
      if (layer.type === 'raster' && layer.data.bounds) {
        const [[lMinLat, lMinLon], [lMaxLat, lMaxLon]] = layer.data.bounds;
        return !(lMaxLon < sMinLon || lMinLon > sMaxLon || lMaxLat < sMinLat || lMinLat > sMaxLat);
      }
      return true;
    });
  }, [layers, filterByBbox, searchBbox]);

  return (
    <div className={cn("w-full h-full relative rounded-xl overflow-hidden border border-white/10 shadow-2xl bg-[#0a0a0a]", isPixelAnalysisMode && "cursor-crosshair")}>
      <MapContainer
        center={initialCenter || [0, 0]}
        zoom={2}
        maxZoom={24}
        preferCanvas={false}
        className="w-full h-full"
        zoomControl={false}
      >
        <MapClickHandler isPixelAnalysisMode={isPixelAnalysisMode} onPixelClick={onPixelClick} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          maxZoom={24}
          maxNativeZoom={19}
        />
        
        <RasterLayerRenderer 
          layers={processedLayers} 
          filterByBbox={filterByBbox} 
          searchBbox={searchBbox} 
          isPixelAnalysisMode={isPixelAnalysisMode}
          isDrawingMode={isDrawingMode}
          onVectorClick={onVectorClick}
          selectedLayerId={selectedLayerId}
          selectedVectorFeature={selectedVectorFeature}
        />
        
        <MapController layers={layers} />
        <MapEvents onZoomChange={onZoomChange} onViewportChange={onViewportChange} />
        <GeomanController onAreaSelected={onAreaSelected} onDrawingUpdate={onDrawingUpdate} isDrawingMode={isDrawingMode} searchBbox={searchBbox} />
        <ScaleControl position="bottomleft" imperial={false} />
        <ResolutionDisplay />

        {(() => {
          const feature = selectedVectorFeature;
          if (feature && (feature.geometry?.type === 'Point' || feature.type === 'Point')) {
            const coords = feature.geometry?.coordinates || feature.coordinates;
            if (coords) {
              return (
                <Marker 
                  position={[coords[1], coords[0]]}
                  interactive={false}
                  icon={L.divIcon({
                    className: 'custom-pixel-marker',
                    html: `<div class="w-4 h-4 bg-orange-500 rounded-full border-2 border-white shadow-[0_0_10px_rgba(249,115,22,0.8)] animate-pulse"></div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                  })}
                />
              );
            }
          }
          return null;
        })()}
      </MapContainer>

      {layers.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm z-[1000]">
          <div className="text-center p-8 rounded-2xl bg-white/5 border border-white/10">
            <MapIcon className="w-12 h-12 text-orange-500 mx-auto mb-4 opacity-50" />
            <h3 className="text-xl font-semibold mb-2">No Layers Loaded</h3>
            <p className="text-white/60 font-medium">Upload a GeoTIFF or Shapefile to start visualizing</p>
          </div>
        </div>
      )}
    </div>
  );
}
