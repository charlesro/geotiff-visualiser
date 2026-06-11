import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, BarChart3, Info, ChevronDown, Layers, Trash2, Download, Search } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, Legend, ReferenceLine } from 'recharts';
import { format } from 'date-fns';
import { cn } from '../lib/utils';
import { getGeoJsonBounds } from '../App';
import { extractPixelTimeseriesOptions } from '../lib/pixel-extraction';

interface VectorFeaturePanelProps {
  feature?: any;
  layer?: any; // A vector layer, like a pixel timeseries layer
  vectorLayers?: any[]; // All vector layers to find corresponding pixel layers
  onClose: () => void;
  onSetSearchBbox?: (bbox: [number, number, number, number]) => void;
  onSetSearchDates?: (startDate: string, endDate: string) => void;
  onExtractNDVI?: (feature: any) => void;
  onAddVectorLayer?: (name: string, geojson: any, id?: string) => void;
  onRemoveDate?: (layerId: string, date: string) => void;
  onDateClick?: (date: string) => void;
  onRemoveFeature?: (layerId: string, featureId: string) => void;
  onFeatureSelect?: (feature: any, layer: any) => void;
  seriesLayers?: any[];
}

const isTsColumn = (c: string) => /_{1,2}(\d{4}-\d{2}-\d{2})$/.test(c);
const getTsMetricAndDate = (c: string) => {
  const match = c.match(/^(.*?)_{1,2}(\d{4}-\d{2}-\d{2})$/);
  if (match) return { metric: match[1], date: match[2] };
  return null;
};
const getDate = (c: string) => getTsMetricAndDate(c)?.date || null;
const getMetric = (c: string) => getTsMetricAndDate(c)?.metric || null;

const getMetrics = (tsCols: string[]) => {
  const metrics = new Set<string>();
  for (const c of tsCols) {
    const parsed = getTsMetricAndDate(c);
    if (parsed) metrics.add(parsed.metric);
  }
  return Array.from(metrics);
};

const getShortName = (name: string, pixelLayer: any) => {
  if (!pixelLayer || !pixelLayer.data || !pixelLayer.data.features) return name;
  const idx = pixelLayer.data.features.findIndex((f: any) => (f.properties?.id || '') === name);
  return idx !== -1 ? `P_${idx + 1}` : name.replace('pixel_', 'P_').replace('p_', 'P_');
};

export const VectorFeaturePanel: React.FC<VectorFeaturePanelProps> = ({ 
  feature, layer, vectorLayers = [], onClose, onSetSearchBbox, onSetSearchDates, 
  onExtractNDVI, onAddVectorLayer, onRemoveDate, onDateClick, onRemoveFeature, onFeatureSelect, seriesLayers 
}) => {
  const [activeTab, setActiveTab] = useState<'info' | 'timeseries'>('info');
  
  // Attempt to find the "freshest" version of the feature from the vector layers
  const featureId = feature?.id || feature?.properties?.id;
  const isPixelsLayer = (l: any) => l?.id?.startsWith('pixels-') || l?.name?.startsWith('Pixels');

  // Find the relevant pixel layer
  const pixelLayer = useMemo(() => {
    const lId = isPixelsLayer(layer) ? layer.id : (featureId ? `pixels-${featureId}` : null);
    if (!lId) return null;
    // Always look up in vectorLayers prop to get the most recent state from App.tsx
    return vectorLayers.find(p => p.id === lId);
  }, [layer, vectorLayers, featureId]);

  // Always use the feature data from the pixelLayer if available to stay in sync with deletions
  const targetFeature = useMemo(() => {
    if (pixelLayer && pixelLayer.data?.features && featureId) {
      const fresh = pixelLayer.data.features.find((f: any) => (f.id || f.properties?.id) === featureId);
      if (fresh) return fresh;
    }
    // Fallback to the passed feature or the first feature of the passed layer
    return feature || layer?.data?.features?.[0];
  }, [feature, layer, pixelLayer, featureId]);

  // Auto-switch to timeseries tab IF we have one found or are viewing one
  useEffect(() => {
    if (pixelLayer) {
      setActiveTab('timeseries');
    }
  }, [pixelLayer?.id]);

  // Pixel Series State
  const [bufferMeters, setBufferMeters] = useState<number>(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [pixelIndex, setPixelIndex] = useState<string>('NDVI');
  const [isExtracting, setIsExtracting] = useState(false);

  // Sync selectedDate with external clicks
  useEffect(() => {
    // If external onDateClick happens, we should probably highlight it in our chart
    // But we don't have a reverse prop for that easily here. 
    // We'll just reset purely local selection if a different tab is opened perhaps.
  }, [activeTab]);

  const handleExtractPixels = async () => {
    if (!seriesLayers || seriesLayers.length === 0 || !targetFeature) return;
    setIsExtracting(true);
    try {
      const { pixelPoints, excludedPixelPoints } = await extractPixelTimeseriesOptions(targetFeature, seriesLayers, bufferMeters, pixelIndex);
      if (onAddVectorLayer) {
        if (pixelPoints && pixelPoints.features && pixelPoints.features.length > 0) {
          // Fix: If we're already on a pixel layer, preserve its ID to avoid creating duplicate layers
          const targetId = isPixelsLayer(layer) ? layer.id : `pixels-${featureId || 'extract'}`;
          const nameAttr = targetFeature?.properties?.name || targetFeature?.properties?.Name || targetFeature?.properties?.id || targetFeature?.id || 'Field';
          onAddVectorLayer(`Pixels (${pixelIndex}) [${nameAttr}] ${bufferMeters !== 0 ? (bufferMeters > 0 ? '+' : '') + bufferMeters + 'm' : ''}`.trim(), pixelPoints, targetId);
        }
        if (bufferMeters !== 0 && excludedPixelPoints && excludedPixelPoints.features && excludedPixelPoints.features.length > 0) {
          const excludedTargetId = `pixels-excluded-${featureId || 'extract'}`;
          const nameAttr = targetFeature?.properties?.name || targetFeature?.properties?.Name || targetFeature?.properties?.id || targetFeature?.id || 'Field';
          onAddVectorLayer(`Excluded Pixels (${pixelIndex}) [${nameAttr}] ${bufferMeters !== 0 ? (bufferMeters > 0 ? '+' : '') + bufferMeters + 'm' : ''}`.trim(), excludedPixelPoints, excludedTargetId);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsExtracting(false);
    }
  };

  const properties = targetFeature?.properties || {};
  const keys = Object.keys(properties);
  const tsCols = keys.filter(isTsColumn);
  const standardCols = keys.filter(c => 
    !isTsColumn(c) && c !== 'id' && c.toLowerCase() !== 'geometry' && 
    !(typeof properties[c] === 'string' && properties[c].startsWith('MULTIPOLYGON')) &&
    !(typeof properties[c] === 'string' && properties[c].startsWith('POLYGON'))
  );
  
  // Calculate Chart Data for Pixels
  const chartData = useMemo(() => {
    if (!pixelLayer || pixelLayer.type !== 'vector' || !pixelLayer.data || !pixelLayer.data.features) return [];
    
    const allDates = new Set<string>();
    const features = pixelLayer.data.features;
    
    for (const f of features) {
      if (!f.properties) continue;
      for (const key of Object.keys(f.properties)) {
        if (isTsColumn(key)) {
          const d = getDate(key);
          if (d) allDates.add(d);
        }
      }
    }

    const sortedDates = Array.from(allDates).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    
    const parsedData: any[] = [];
    for (const date of sortedDates) {
      const timestamp = new Date(date).getTime();
      const row: any = { date: timestamp, dateStr: date };
      for (let i = 0; i < features.length; i++) {
        const f = features[i];
        if (!f.properties) continue;
        const pid = f.properties.id || `p_${i}`;
        for (const key of Object.keys(f.properties)) {
          if (isTsColumn(key)) {
            const colDate = key.split('_')[1];
            if (colDate === date) {
              const metric = getMetric(key) || 'value';
              if (metric !== pixelIndex) continue;
              
              const val = f.properties[key];
              if (val !== null && val !== undefined) {
                row[pid] = typeof val === 'number' ? val : parseFloat(val);
              }
            }
          }
        }
      }
      parsedData.push(row);
    }
    return parsedData;
  }, [pixelLayer, pixelIndex]);

  const lineKeys = useMemo(() => {
    if (chartData.length === 0) return [];
    const keys = new Set<string>();
    chartData.forEach(row => {
      Object.keys(row).forEach(k => {
        if (k !== 'date' && k !== 'dateStr') keys.add(k);
      });
    });
    return Array.from(keys);
  }, [chartData]);

  const selectedSeriesKey = useMemo(() => {
    if (!pixelLayer || !pixelLayer.data?.features || !targetFeature) return null;
    const targetId = targetFeature.id || targetFeature.properties?.id;
    if (!targetId) return null;
    
    const idx = pixelLayer.data.features.findIndex((f: any) => (f.id || f.properties?.id) === targetId);
    if (idx !== -1) {
      const f = pixelLayer.data.features[idx];
      return f.properties?.id || `p_${idx}`;
    }
    return null;
  }, [pixelLayer, targetFeature]);

  if (!targetFeature && !layer) return null;

  const isPoint = targetFeature?.geometry?.type === 'Point' || targetFeature?.type === 'Point' || targetFeature?.id?.startsWith('point-');

  return (
    <div id="vector-feature-panel" className="absolute top-4 right-4 z-[1000] w-[460px] flex flex-col pointer-events-none">
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.98 }}
          className="bg-[#080808]/95 backdrop-blur-3xl border border-white/10 rounded-2xl shadow-[0_32px_64px_-16px_rgba(0,0,0,0.6)] flex flex-col h-auto max-h-[85vh] pointer-events-auto overflow-hidden"
        >
          {/* Unified Header */}
          <div className="flex items-center justify-between p-4 border-b border-white/5 bg-gradient-to-r from-orange-500/10 via-transparent to-transparent">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-orange-500/10 border border-orange-500/20 flex items-center justify-center shadow-inner">
                <Layers className="w-4 h-4 text-orange-500" />
              </div>
              <div className="flex flex-col">
                <h2 className="text-[10px] font-black text-white/30 uppercase tracking-[0.25em] mb-0.5">Observation Unit</h2>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white max-w-[220px] truncate">
                    {featureId || properties.id || properties.NewID || properties.crp_lbl || layer?.name || 'Inspect Point'}
                  </span>
                  {isPoint && (
                    <span className="flex items-center gap-1.5 text-[9px] bg-orange-500/10 text-orange-500 px-2 py-0.5 rounded-full border border-orange-500/20 font-bold uppercase tracking-wider">
                      <div className="w-1 h-1 bg-orange-500 rounded-full animate-pulse" />
                      Point
                    </span>
                  )}
                </div>
              </div>
            </div>
            <button 
              id="vector-feature-panel-close"
              onClick={onClose} 
              className="w-8 h-8 flex items-center justify-center text-white/20 hover:text-white transition-all hover:bg-white/5 rounded-lg border border-transparent hover:border-white/5"
            >
              <X size={18} />
            </button>
          </div>

          {/* Unified Navigation */}
          <div className="flex border-b border-white/5 bg-[#0a0a0a] px-2">
            <button
              id="feature-panel-tab-info"
              onClick={() => setActiveTab('info')}
              className={cn(
                "px-4 py-3 text-[10px] font-black transition-all border-b-2 tracking-[0.15em] flex items-center gap-2 uppercase",
                activeTab === 'info' ? "border-orange-500 text-white" : "border-transparent text-white/30 hover:text-white/60"
              )}
            >
              <Info size={12} className={activeTab === 'info' ? "text-orange-500" : ""} /> Properties
            </button>
            <button
              id="feature-panel-tab-timeseries"
              onClick={() => setActiveTab('timeseries')}
              className={cn(
                "px-4 py-3 text-[10px] font-black transition-all border-b-2 tracking-[0.15em] flex items-center gap-2 uppercase relative",
                activeTab === 'timeseries' ? "border-orange-500 text-white" : "border-transparent text-white/30 hover:text-white/60"
              )}
            >
              <BarChart3 size={12} className={activeTab === 'timeseries' ? "text-orange-500" : ""} /> Spectral Series
              {pixelLayer && (
                <div className="absolute top-2.5 right-1 w-1.5 h-1.5 bg-orange-500 rounded-full shadow-[0_0_8px_rgba(249,115,22,1)]" />
              )}
            </button>
          </div>

          {/* Unified Content */}
          <div className="overflow-y-auto custom-scrollbar flex-1 bg-[#080808]">
            {activeTab === 'info' && (
              <div className="flex flex-col min-h-[300px] divide-y divide-white/5">
                {/* Properties Section */}
                <div className="p-4 flex-1">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em]">Attributes</h3>
                    <div className="flex gap-2">
                      {isPoint && (
                        <div className="flex gap-1.5">
                          <div className="bg-white/5 px-2 py-0.5 rounded border border-white/5">
                            <span className="text-[9px] text-white/30 uppercase mr-1.5 font-bold">Lat</span>
                            <span className="text-[10px] text-white/80 font-mono">{Number(properties.lat || 0).toFixed(6)}</span>
                          </div>
                          <div className="bg-white/5 px-2 py-0.5 rounded border border-white/5">
                            <span className="text-[9px] text-white/30 uppercase mr-1.5 font-bold">Lng</span>
                            <span className="text-[10px] text-white/80 font-mono">{Number(properties.lng || 0).toFixed(6)}</span>
                          </div>
                        </div>
                      )}
                      
                      {pixelLayer && onRemoveFeature && featureId && (
                        <button 
                          id="btn-delete-point"
                          onClick={() => onRemoveFeature(pixelLayer.id, featureId)}
                          className="flex items-center gap-1 px-2 py-0.5 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded border border-red-500/20 text-[9px] font-bold uppercase tracking-wider transition-all"
                          title="Delete this point from the vector layer"
                        >
                          <Trash2 size={11} />
                          Delete Point
                        </button>
                      )}
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 gap-0.5">
                    {standardCols.length > 0 ? standardCols.map(c => (
                      <div key={c} className="group flex items-center justify-between py-2 px-2 hover:bg-white/[0.03] transition-all rounded-lg border border-transparent hover:border-white/5">
                        <span className="text-[10px] text-white/40 font-bold uppercase tracking-tight">{c}</span>
                        <span className="text-[11px] font-mono text-white/90 text-right bg-white/[0.05] px-2 py-0.5 rounded max-w-[200px] truncate">
                          {properties[c] !== null && properties[c] !== undefined ? String(properties[c]) : <span className="italic opacity-30">n/a</span>}
                        </span>
                      </div>
                    )) : (
                      <div className="text-center py-8 px-4 border border-dashed border-white/10 rounded-xl">
                        <Info size={24} className="mx-auto text-white/10 mb-2" />
                        <p className="text-xs text-white/30 font-medium">No extended metadata found.</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Operations Section */}
                <div className="p-4 bg-white/[0.01] space-y-3">
                  <h3 className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em] mb-2">Execution</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 space-y-2 flex flex-col justify-between">
                      <p className="text-[9px] text-white/40 leading-relaxed">Focus date/bbox range on target bounds.</p>
                      <button
                        id="btn-focus-map"
                        onClick={() => {
                          if (onSetSearchBbox && targetFeature) {
                            const bbox = getGeoJsonBounds(targetFeature);
                            if (bbox) {
                              const pad = 0.01;
                              onSetSearchBbox([bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad]);
                            }
                          }
                          if (onSetSearchDates) {
                            const dates = tsCols.map(c => getTsMetricAndDate(c)?.date).filter(Boolean) as string[];
                            if (dates.length > 0) {
                              const sortedDates = dates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
                              onSetSearchDates(sortedDates[0], sortedDates[sortedDates.length - 1]);
                            } else if (seriesLayers && seriesLayers.length > 0) {
                              const sorted = [...seriesLayers].sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
                              onSetSearchDates(sorted[0].datetime, sorted[sorted.length - 1].datetime);
                            }
                          }
                        }}
                        className="w-full h-8 flex items-center justify-center gap-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-all text-[10px] font-bold text-white group"
                      >
                        <Search size={12} className="text-white/40 group-hover:text-orange-500 transition-colors" />
                        Focus Map
                      </button>
                    </div>

                    <div className="p-3 rounded-xl bg-orange-500/[0.02] border border-orange-500/10 space-y-2 flex flex-col justify-between">
                      <p className="text-[9px] text-orange-500/40 leading-relaxed">Extract raw pixel values for indexing.</p>
                      <div>
                        <button
                          id="btn-analyze-bands"
                          onClick={() => {
                            if (onExtractNDVI && targetFeature) onExtractNDVI(targetFeature);
                          }}
                          disabled={!seriesLayers || seriesLayers.length < 3}
                          className="w-full h-8 flex items-center justify-center gap-1.5 rounded-lg bg-orange-500 border border-orange-600 hover:bg-orange-600 disabled:opacity-20 disabled:grayscale transition-all text-[10px] font-black text-black uppercase tracking-widest"
                        >
                          Analyze
                        </button>
                        {!seriesLayers || seriesLayers.length < 3 ? (
                          <p className="text-[8px] text-center text-red-500/50 mt-1 italic">Needs 3+ layers</p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'timeseries' && (
              <div className="flex flex-col min-h-[350px]">
                {!pixelLayer ? (
                  /* Setup View */
                  <div className="flex-1 p-8 flex flex-col items-center justify-center text-center">
                    <div className="w-16 h-16 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center mb-6 shadow-2xl relative">
                      <BarChart3 size={32} className="text-orange-500" />
                      <div className="absolute inset-0 bg-orange-500/20 blur-2xl rounded-full" />
                    </div>
                    <h3 className="text-lg font-bold text-white mb-2">Temporal Reconstruction</h3>
                    <p className="text-[11px] text-white/30 mb-6 max-w-sm leading-relaxed">Reconstruct the spectral history of this location by extracting pixel data from the Sentinel-2 time series.</p>
                    
                    <div className="w-full max-w-xs bg-white/[0.02] border border-white/5 rounded-xl p-5 space-y-5">
                      <div className="space-y-2 text-left">
                        <label className="text-[9px] font-black text-white/20 uppercase tracking-[0.25em] pl-1">Target Dimension</label>
                        <select 
                          id="select-pixel-index"
                          value={pixelIndex}
                          onChange={(e) => setPixelIndex(e.target.value)}
                          className="w-full bg-[#111] text-white border border-white/10 rounded-lg p-3 text-xs font-bold outline-none focus:border-orange-500/50 appearance-none shadow-inner"
                        >
                          <option value="NDVI">NDVI (Vegetation Focus)</option>
                          <option value="EVI">EVI (Structural Focus)</option>
                          <option value="4">Band 4 (Red Reflectance)</option>
                          <option value="8">Band 8 (NIR Reflectance)</option>
                        </select>
                      </div>

                      <div className="space-y-3 text-left">
                        <div className="flex items-center justify-between px-1">
                          <label className="text-[9px] font-black text-white/20 uppercase tracking-[0.25em]">Boundary Offset</label>
                          <span className="text-[9px] font-mono text-orange-500 bg-orange-500/10 px-2 py-0.5 rounded border border-orange-500/10 font-bold">
                            {bufferMeters > 0 ? `+${bufferMeters}m` : bufferMeters < 0 ? `${bufferMeters}m` : '0m'}
                          </span>
                        </div>
                        <input
                          id="range-boundary-offset"
                          type="range"
                          min="-50"
                          max="50"
                          step="5"
                          value={bufferMeters}
                          onChange={(e) => setBufferMeters(parseInt(e.target.value))}
                          className="w-full h-1 bg-white/5 rounded-lg appearance-none cursor-pointer accent-orange-500"
                        />
                      </div>

                      <button
                        id="btn-commence-extraction"
                        onClick={handleExtractPixels}
                        disabled={isExtracting || !seriesLayers || seriesLayers.length === 0}
                        className="w-full py-3.5 bg-orange-500 text-black hover:bg-orange-600 disabled:opacity-20 disabled:grayscale rounded-xl transition-all font-black text-[10px] uppercase tracking-[0.2em] shadow-[0_10px_20px_-5px_rgba(249,115,22,0.3)] mt-2"
                      >
                        {isExtracting ? (
                          <div className="flex items-center justify-center gap-2">
                            <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} className="w-3.5 h-3.5 border-2 border-black/20 border-t-black rounded-full" />
                            Calculating...
                          </div>
                        ) : (
                          "Commence Extraction"
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Data & Visual View */
                  <div className="flex flex-col h-[380px]">
                    <div className="flex flex-1 w-full overflow-hidden">
                      {/* Interactive Visualizer */}
                      <div className="flex-1 p-4 relative flex flex-col min-h-0">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <h4 className="text-[10px] font-black text-orange-500 uppercase tracking-[0.2em]">Signal History</h4>
                            <div className="h-3 w-px bg-white/10" />
                            <span className="text-[10px] font-bold text-white/40">{pixelIndex} Dimension</span>
                          </div>
                          
                          <div className="flex items-center gap-1.5">
                            <button 
                              id="btn-export-observations"
                              onClick={() => {
                                const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(pixelLayer.data));
                                const a = document.createElement('a');
                                a.setAttribute("href", dataStr);
                                a.setAttribute("download", (pixelLayer.name || "pixels") + ".geojson");
                                document.body.appendChild(a);
                                a.click();
                                a.remove();
                              }}
                              className="p-1.5 bg-white/[0.03] hover:bg-white/10 rounded-lg text-white/40 hover:text-orange-500 transition-colors border border-white/5"
                              title="Export Observations"
                            >
                              <Download size={13} />
                            </button>
                            <button 
                              id="btn-update-timeseries"
                              onClick={handleExtractPixels}
                              disabled={isExtracting || !seriesLayers || seriesLayers.length === 0}
                              className="flex items-center gap-1 px-2.5 py-1.5 bg-orange-500/10 hover:bg-orange-500/20 text-orange-500 rounded-lg border border-orange-500/20 text-[9px] font-bold transition-all uppercase tracking-wider disabled:opacity-50"
                              title="Re-extract pixel data from the current series layers"
                            >
                              {isExtracting ? (
                                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} className="w-3" />
                              ) : (
                                <BarChart3 size={11} />
                              )}
                              Update
                            </button>
                          </div>
                        </div>

                        {selectedDate && (
                          <motion.div 
                            initial={{ opacity: 0, y: -5 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="mb-3 flex items-center justify-between p-2 rounded-lg bg-orange-500/10 border border-orange-500/20"
                          >
                            <div className="flex items-center gap-2">
                              <div className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse" />
                              <div className="flex flex-col">
                                <span className="text-[8px] font-black text-white/30 uppercase tracking-widest leading-none mb-0.5">Active Date</span>
                                <span className="text-xs font-mono font-bold text-white">{selectedDate}</span>
                              </div>
                            </div>
                            <button 
                              id="btn-delete-image-observation"
                              onClick={() => {
                                if (pixelLayer && onRemoveDate && selectedDate) {
                                  onRemoveDate(pixelLayer.id, selectedDate);
                                  setSelectedDate(null);
                                }
                              }}
                              className="flex items-center gap-1 px-2.5 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded-md transition-all text-[9px] font-black uppercase tracking-widest shadow-lg shadow-red-500/20"
                              title="Delete Image & Data for this date"
                            >
                              <Trash2 size={11} />
                              Delete
                            </button>
                          </motion.div>
                        )}
                        
                        <div className="flex-1 min-h-0">
                          {chartData.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart 
                                data={chartData} 
                                margin={{ top: 15, right: 10, left: -25, bottom: 0 }}
                                onClick={(e) => {
                                  if (e && e.activeLabel && chartData.length > 0) {
                                    const timestamp = Number(e.activeLabel);
                                    // Find nearest row in chartData to handle proportional scale clicks
                                    let matchedRow = chartData[0];
                                    let minDiff = Math.abs(chartData[0].date - timestamp);
                                    for (let i = 1; i < chartData.length; i++) {
                                      const diff = Math.abs(chartData[i].date - timestamp);
                                      if (diff < minDiff) {
                                        minDiff = diff;
                                        matchedRow = chartData[i];
                                      }
                                    }
                                    if (matchedRow) {
                                      setSelectedDate(matchedRow.dateStr);
                                      onDateClick?.(matchedRow.dateStr);
                                    }
                                  }
                                }}
                              >
                                <XAxis 
                                  type="number"
                                  dataKey="date" 
                                  domain={[
                                    (min: number) => min - 86400000 * 2,
                                    (max: number) => max + 86400000 * 2
                                  ]}
                                  stroke="rgba(255,255,255,0.15)" 
                                  fontSize={9} 
                                  tickFormatter={(v) => {
                                    try {
                                      return format(new Date(Number(v)), 'MM-dd');
                                    } catch {
                                      return String(v);
                                    }
                                  }} 
                                  tickMargin={10}
                                  axisLine={false}
                                  tickLine={false}
                                  fontFamily="Inter"
                                />
                                <YAxis 
                                  stroke="rgba(255,255,255,0.15)" 
                                  fontSize={9} 
                                  axisLine={false} 
                                  tickLine={false} 
                                  domain={['auto', 'auto']}
                                  fontFamily="Inter"
                                />
                                <RechartsTooltip 
                                  content={({ active, label, payload }) => {
                                    if (active && payload && payload.length) {
                                      const rowData = payload[0].payload;
                                      const displayLabel = rowData?.dateStr || label;
                                      return (
                                        <div className="bg-[#111]/90 backdrop-blur-md border border-white/10 p-2 rounded-lg shadow-2xl min-w-[120px]">
                                          <p className="text-[10px] font-black text-white/50 uppercase tracking-widest border-b border-white/5 pb-1 mb-1">{displayLabel}</p>
                                          <div className="space-y-1">
                                            {payload.slice(0, 5).map((entry: any) => (
                                              <div key={entry.name} className="flex justify-between gap-3 text-[10px]">
                                                <span className="font-medium" style={{ color: entry.color }}>
                                                  {getShortName(entry.name, pixelLayer)}
                                                </span>
                                                <span className="font-mono text-white/90">
                                                  {typeof entry.value === 'number' ? entry.value.toFixed(4) : entry.value}
                                                </span>
                                              </div>
                                            ))}
                                            {payload.length > 5 && (
                                              <p className="text-[8px] text-white/30 italic">+{payload.length - 5} more pixels</p>
                                            )}
                                          </div>
                                          <p className="text-[8px] text-orange-500/60 font-bold mt-2 pt-1 border-t border-white/5">Click/Tap to Inspect Date</p>
                                        </div>
                                      );
                                    }
                                    return null;
                                  }}
                                  cursor={{ stroke: 'rgba(249,115,22,0.1)', strokeWidth: 16 }}
                                />
                                {selectedDate && (() => {
                                  const matchedRow = chartData.find(d => d.dateStr === selectedDate);
                                  return matchedRow ? (
                                    <ReferenceLine 
                                      x={matchedRow.date} 
                                      stroke="rgba(249,115,22,0.4)" 
                                      strokeWidth={1.5} 
                                      strokeDasharray="3 3"
                                    />
                                  ) : null;
                                })()}
                                {lineKeys.slice(0, 20).map((key, i) => {
                                   const isSelectedLine = selectedSeriesKey === key;
                                   const isAnyLineSelected = selectedSeriesKey !== null;
                                   const strokeWidth = isAnyLineSelected ? (isSelectedLine ? 4.5 : 1) : 2;
                                   const strokeOpacity = isAnyLineSelected ? (isSelectedLine ? 1.0 : 0.1) : (selectedDate ? 0.3 : 0.6);

                                   return (
                                      <Line 
                                        key={key} 
                                        type="linear"
                                        connectNulls 
                                        dataKey={key} 
                                        stroke={`hsl(${(i * 137.5) % 360}, 65%, 60%)`} 
                                        strokeWidth={strokeWidth}
                                        strokeOpacity={strokeOpacity}
                                        activeDot={(props: any) => {
                                          const { cx, cy, payload } = props;
                                          if (!cx || !cy) return null;
                                          const isSelectedLine = selectedSeriesKey === key;
                                          const r = isSelectedLine ? 6.5 : 4.0;
                                          const fill = isSelectedLine ? "#f97316" : `hsl(${(i * 137.5) % 360}, 65%, 60%)`;
                                          const stroke = "#fff";
                                          const strokeWidth = isSelectedLine ? 2.0 : 1.0;
                                          
                                          return (
                                             <circle 
                                               cx={cx} 
                                               cy={cy} 
                                               r={r} 
                                               fill={fill}
                                               stroke={stroke}
                                               strokeWidth={strokeWidth}
                                               className="cursor-pointer transition-all hover:scale-125"
                                               onClick={(e) => {
                                                 e.stopPropagation();
                                                 const features = pixelLayer?.data?.features || [];
                                                 const f = features.find((f: any, idx: number) => {
                                                   const pid = f.properties?.id || `p_${idx}`;
                                                   return pid === key;
                                                 });
                                                 if (f && onFeatureSelect) {
                                                   onFeatureSelect(f, pixelLayer);
                                                 }
                                                 if (payload && payload.dateStr) {
                                                   setSelectedDate(payload.dateStr);
                                                   if (onDateClick) {
                                                     onDateClick(payload.dateStr);
                                                   }
                                                 }
                                               }}
                                             />
                                          );
                                        }}
                                        dot={(props: any) => {
                                          const { cx, cy, payload } = props;
                                          if (!cx || !cy) return null;
                                          
                                          const isSelectedLine = selectedSeriesKey === key;
                                          const isSelectedDate = payload.dateStr === selectedDate;
                                          const lineColor = `hsl(${(i * 137.5) % 360}, 65%, 60%)`;
                                          
                                          let r = 2.0;
                                          let fill = lineColor;
                                          let fillOpacity = 0.35;
                                          let stroke = "none";
                                          let strokeWidth = 0;
                                          
                                          if (isSelectedLine) {
                                            if (isSelectedDate) {
                                              r = 5.5;
                                              fill = "#f97316";
                                              fillOpacity = 1.0;
                                              stroke = "#fff";
                                              strokeWidth = 2.0;
                                            } else {
                                              r = 3.5;
                                              fill = lineColor;
                                              fillOpacity = 0.95;
                                              stroke = "#fff";
                                              strokeWidth = 1.0;
                                            }
                                          } else {
                                            if (isSelectedDate) {
                                              r = 4.0;
                                              fill = "#f97316";
                                              fillOpacity = 0.6;
                                              stroke = "#fff";
                                              strokeWidth = 1.0;
                                            } else {
                                              r = 2.0;
                                              fill = lineColor;
                                              fillOpacity = 0.45;
                                            }
                                          }
                                          
                                          return (
                                             <circle 
                                               cx={cx} 
                                               cy={cy} 
                                               r={r} 
                                               fill={fill} 
                                               fillOpacity={fillOpacity}
                                               stroke={stroke}
                                               strokeWidth={strokeWidth}
                                               className="cursor-pointer transition-all hover:scale-125"
                                               onClick={(e) => {
                                                 e.stopPropagation();
                                                 const features = pixelLayer?.data?.features || [];
                                                 const f = features.find((f: any, idx: number) => {
                                                   const pid = f.properties?.id || `p_${idx}`;
                                                   return pid === key;
                                                 });
                                                 if (f && onFeatureSelect) {
                                                   onFeatureSelect(f, pixelLayer);
                                                 }
                                                 if (payload && payload.dateStr) {
                                                   setSelectedDate(payload.dateStr);
                                                   if (onDateClick) {
                                                     onDateClick(payload.dateStr);
                                                   }
                                                 }
                                               }}
                                             />
                                          );
                                        }}
                                        animationDuration={1500}
                                      />
                                   );
                                })}
                              </LineChart>
                            </ResponsiveContainer>
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center bg-white/[0.01] rounded-xl border border-dashed border-white/5 py-8">
                              <BarChart3 size={32} strokeWidth={1} className="mb-2 text-white/5" />
                              <p className="text-[9px] uppercase tracking-[0.2em] font-black text-white/20">Awaiting Signal</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
};

