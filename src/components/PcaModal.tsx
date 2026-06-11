import React, { useState, useEffect } from 'react';
import { X, BarChart3, Sliders, Play, TrendingUp, Download, Info, Check, HelpCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { PCA } from 'ml-pca';
import { 
  ScatterChart, 
  Scatter, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer, 
  Cell,
  Legend,
  BarChart,
  Bar
} from 'recharts';
import { cn } from '../lib/utils';
import { extractSpecies } from '../lib/species';
import { isTsColumn, vectorLayerHasTimeSeries } from '../lib/timeseries';

// Re-exported for backwards compatibility — the implementation lives in lib/timeseries.ts.
export { vectorLayerHasTimeSeries } from '../lib/timeseries';

interface PcaModalProps {
  isOpen: boolean;
  onClose: () => void;
  layers: any[];
  setLayers: React.Dispatch<React.SetStateAction<any[]>>;
}

export default function PcaModal({ isOpen, onClose, layers, setLayers }: PcaModalProps) {
  const [selectedPcaLayerIds, setSelectedPcaLayerIds] = useState<string[]>([]);
  const [selectedProjectionLayerIds, setSelectedProjectionLayerIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'scatter' | 'scree' | 'features'>('scatter');
  const [pcaResult, setPcaResult] = useState<{
    layerNames: string[];
    features: any[];
    explainedVariance: number[];
    cumulativeVariance: number[];
    keys: string[];
  } | null>(null);

  const [colorByAttribute, setColorByAttribute] = useState<string>('Layer');

  const availableAttributes = React.useMemo(() => {
    if (!pcaResult) return ['Layer'];
    const keysSet = new Set<string>();
    pcaResult.features.forEach(f => {
      if (f.properties) {
        Object.keys(f.properties).forEach(k => {
          if (!isTsColumn(k) && k !== 'PC1' && k !== 'PC2' && k !== 'PC3' && k !== 'id' && k !== 'NewID') {
            keysSet.add(k);
          }
        });
      }
    });
    return ['Layer', ...Array.from(keysSet).sort()];
  }, [pcaResult]);

  const getAttributeValue = (f: any, attr: string): string => {
    if (attr === 'Layer') return f.layerName;
    if (!f.properties) return 'Unknown';
    if (f.properties[attr] !== undefined && f.properties[attr] !== null && f.properties[attr] !== '') {
      return String(f.properties[attr]);
    }
    // Case insensitive/fallback
    const attrLower = attr.toLowerCase();
    for (const k of Object.keys(f.properties)) {
      if (k.toLowerCase() === attrLower) {
        if (f.properties[k] !== undefined && f.properties[k] !== null && f.properties[k] !== '') {
          return String(f.properties[k]);
        }
      }
    }
    return 'Unknown';
  };

  const uniqueCategories = React.useMemo(() => {
    if (!pcaResult) return [];
    const categoriesSet = new Set<string>();
    pcaResult.features.forEach(f => {
      categoriesSet.add(getAttributeValue(f, colorByAttribute));
    });
    return Array.from(categoriesSet).sort();
  }, [pcaResult, colorByAttribute]);

  // Auto-select valid candidates on mount or layers change
  useEffect(() => {
    const currentCandidates = layers.filter(l => l.type === 'vector' && vectorLayerHasTimeSeries(l)).map(l => l.id);
    setSelectedPcaLayerIds(prev => {
      const stillValid = prev.filter(id => currentCandidates.includes(id));
      if (stillValid.length === 0 && currentCandidates.length > 0 && prev.length === 0) {
        return [currentCandidates[0]];
      }
      if (stillValid.length === prev.length && stillValid.every(id => prev.includes(id))) {
        return prev;
      }
      return stillValid;
    });
    setSelectedProjectionLayerIds(prev => {
      const next = prev.filter(id => currentCandidates.includes(id));
      if (next.length === prev.length && next.every(id => prev.includes(id))) {
        return prev;
      }
      return next;
    });
  }, [layers, isOpen]);

  // Handle running PCA
  const runVectorPCA = () => {
    setError(null);
    setLoading(true);

    setTimeout(() => {
      try {
        const fittingLayers = layers.filter(l => selectedPcaLayerIds.includes(l.id) && l.type === 'vector');
        const projectionLayers = layers.filter(l => selectedProjectionLayerIds.includes(l.id) && l.type === 'vector');
        
        if (fittingLayers.length === 0) {
          setError("Please select at least one vector layer to fit the PCA.");
          setLoading(false);
          return;
        }

        // 1. Collect fitting features
        const allFittingFeatures: any[] = [];
        for (const cl of fittingLayers) {
          if (cl.data && cl.data.features) {
            cl.data.features.forEach((f: any) => {
              allFittingFeatures.push({
                layerId: cl.id,
                layerName: cl.name,
                featureRef: f,
                properties: f.properties || {}
              });
            });
          }
        }

        if (allFittingFeatures.length === 0) {
          setError("No features found in the selected PCA fitting layers.");
          setLoading(false);
          return;
        }

        // 2. Identify timeseries keys from fitting features (shared convention)
        const allTsKeysSet = new Set<string>();

        for (const f of allFittingFeatures) {
          for (const k of Object.keys(f.properties)) {
            if (isTsColumn(k)) {
              allTsKeysSet.add(k);
            }
          }
        }

        const sortedTsKeys = Array.from(allTsKeysSet).sort();

        if (sortedTsKeys.length < 2) {
          setError("At least 2 dates of timeseries data are required to perform PCA.");
          setLoading(false);
          return;
        }

        if (allFittingFeatures.length < 2) {
          setError("At least 2 features are required to fit the PCA.");
          setLoading(false);
          return;
        }

        // 3. Impute missing values for fitting
        const colMeans = sortedTsKeys.map((key) => {
          let sum = 0;
          let count = 0;
          for (const f of allFittingFeatures) {
            const val = Number(f.properties[key]);
            if (!isNaN(val) && val !== null && val !== undefined) {
              sum += val;
              count++;
            }
          }
          return count > 0 ? sum / count : 0;
        });

        // Assemble fitting dataset
        const rawFittingDataset: number[][] = [];
        const validFittingFeatures: any[] = [];

        for (const f of allFittingFeatures) {
          const row: number[] = [];
          let numValid = 0;
          for (let colIdx = 0; colIdx < sortedTsKeys.length; colIdx++) {
            const key = sortedTsKeys[colIdx];
            const valStr = f.properties[key];
            const val = Number(valStr);
            if (!isNaN(val) && val !== null && val !== undefined) {
              row.push(val);
              numValid++;
            } else {
              row.push(colMeans[colIdx]);
            }
          }
          if (numValid > 0) {
            rawFittingDataset.push(row);
            validFittingFeatures.push(f);
          }
        }

        if (validFittingFeatures.length < 2) {
          setError("Not enough valid fitting features to compute PCA.");
          setLoading(false);
          return;
        }

        // 4. Handle columns with zero/low standard deviation to avoid scaling errors
        const numRows = rawFittingDataset.length;
        const numCols = sortedTsKeys.length;
        const highVarianceColIndices: number[] = [];

        for (let colIdx = 0; colIdx < numCols; colIdx++) {
          let sum = 0;
          for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
            sum += rawFittingDataset[rowIdx][colIdx];
          }
          const mean = sum / numRows;

          let sumSquares = 0;
          for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
            sumSquares += Math.pow(rawFittingDataset[rowIdx][colIdx] - mean, 2);
          }
          const stdDev = Math.sqrt(sumSquares / numRows);

          // If standard deviation is greater than 1e-6, use the column
          if (stdDev > 1e-6) {
            highVarianceColIndices.push(colIdx);
          }
        }

        let datasetToPca: number[][];
        let processedKeys: string[];
        let forceNoScale = false;

        if (highVarianceColIndices.length >= 2) {
          // Use only the columns with non-zero standard deviation
          datasetToPca = rawFittingDataset.map(row => highVarianceColIndices.map(colIdx => row[colIdx]));
          processedKeys = highVarianceColIndices.map(colIdx => sortedTsKeys[colIdx]);
        } else {
          // Too many constant columns. Rather than failing, run without scaling on all columns.
          datasetToPca = rawFittingDataset;
          processedKeys = sortedTsKeys;
          forceNoScale = true;
        }

        // Run ml-pca (center always, scale only if we successfully isolated non-constant dimensions)
        const pcaInstance = new PCA(datasetToPca, { center: true, scale: !forceNoScale });
        const numComponents = Math.min(3, processedKeys.length);
        const projectedFitting = pcaInstance.predict(datasetToPca, { nComponents: numComponents });
        const fittingScoreArray = projectedFitting.to2DArray();

        // 5. Predict/Project Projection-Only Layers
        const allProjectionFeatures: any[] = [];
        for (const cl of projectionLayers) {
          if (cl.data && cl.data.features) {
            cl.data.features.forEach((f: any) => {
              allProjectionFeatures.push({
                layerId: cl.id,
                layerName: cl.name,
                featureRef: f,
                properties: f.properties || {}
              });
            });
          }
        }

        const rawProjectionDataset: number[][] = [];
        const validProjectionFeatures: any[] = [];

        for (const f of allProjectionFeatures) {
          const row: number[] = [];
          let numValid = 0;
          for (let colIdx = 0; colIdx < sortedTsKeys.length; colIdx++) {
            const key = sortedTsKeys[colIdx];
            const valStr = f.properties[key];
            const val = Number(valStr);
            if (!isNaN(val) && val !== null && val !== undefined) {
              row.push(val);
              numValid++;
            } else {
              row.push(colMeans[colIdx]);
            }
          }
          if (numValid > 0) {
            rawProjectionDataset.push(row);
            validProjectionFeatures.push(f);
          }
        }

        let projectionDatasetToPredict: number[][];
        if (highVarianceColIndices.length >= 2) {
          projectionDatasetToPredict = rawProjectionDataset.map(row => highVarianceColIndices.map(colIdx => row[colIdx]));
        } else {
          projectionDatasetToPredict = rawProjectionDataset;
        }

        let projectionScoreArray: number[][] = [];
        if (projectionDatasetToPredict.length > 0) {
          const projectedProjection = pcaInstance.predict(projectionDatasetToPredict, { nComponents: numComponents });
          projectionScoreArray = projectedProjection.to2DArray();
        }

        const explainedVariance = pcaInstance.getExplainedVariance();
        const cumulativeVariance = pcaInstance.getCumulativeVariance();

        // 6. Build scores mapping and update layers
        const featureScoreMap = new Map<any, { pc1: number, pc2?: number, pc3?: number }>();
        const scoreData: any[] = [];

        // Add fitting features scores
        for (let i = 0; i < validFittingFeatures.length; i++) {
          const f = validFittingFeatures[i];
          const rowScores = fittingScoreArray[i];
          const pc1 = rowScores[0] || 0;
          const pc2 = rowScores[1];
          const pc3 = rowScores[2];

          featureScoreMap.set(f.featureRef, { pc1, pc2, pc3 });

          const fId = f.featureRef.id || f.properties.id || f.properties.name || f.properties.FID || `Feature_${i + 1}`;
          const shortName = typeof fId === 'string' && fId.startsWith('p_')
            ? fId.replace('pixel_', 'P_').replace('p_', 'P_')
            : String(fId);

          scoreData.push({
            id: fId,
            pc1,
            pc2: pc2 || 0,
            pc3: pc3 || 0,
            name: shortName,
            layerName: f.layerName,
            isProjectionOnly: false,
            properties: f.properties
          });
        }

        // Add projection features scores
        for (let i = 0; i < validProjectionFeatures.length; i++) {
          const f = validProjectionFeatures[i];
          const rowScores = projectionScoreArray[i];
          const pc1 = rowScores[0] || 0;
          const pc2 = rowScores[1];
          const pc3 = rowScores[2];

          featureScoreMap.set(f.featureRef, { pc1, pc2, pc3 });

          const fId = f.featureRef.id || f.properties.id || f.properties.name || f.properties.FID || `Feature_Proj_${i + 1}`;
          const shortName = typeof fId === 'string' && fId.startsWith('p_')
            ? fId.replace('pixel_', 'P_').replace('p_', 'P_') + " (Proj)"
            : String(fId) + " (Proj)";

          scoreData.push({
            id: fId,
            pc1,
            pc2: pc2 || 0,
            pc3: pc3 || 0,
            name: shortName,
            layerName: f.layerName,
            isProjectionOnly: true,
            properties: f.properties
          });
        }

        // Update layers state functionally in the parent App component (both fitting and projection layers)
        const allSelectedIds = [...selectedPcaLayerIds, ...selectedProjectionLayerIds];
        setLayers((prev: any[]) => prev.map(l => {
          if (allSelectedIds.includes(l.id) && l.type === 'vector') {
            const newFeatures = l.data.features.map((originalF: any) => {
              const scores = featureScoreMap.get(originalF);
              if (scores) {
                return {
                  ...originalF,
                  properties: {
                    ...originalF.properties,
                    PC1: Number(scores.pc1.toFixed(5)),
                    ...(scores.pc2 !== undefined ? { PC2: Number(scores.pc2.toFixed(5)) } : {}),
                    ...(scores.pc3 !== undefined ? { PC3: Number(scores.pc3.toFixed(5)) } : {})
                  }
                };
              }
              return originalF;
            });
            return {
              ...l,
              data: {
                ...l.data,
                features: newFeatures
              }
            };
          }
          return l;
        }));

        setPcaResult({
          layerNames: Array.from(new Set([...fittingLayers.map(l => l.name), ...projectionLayers.map(l => l.name)])),
          features: scoreData,
          explainedVariance,
          cumulativeVariance,
          keys: processedKeys
        });
      } catch (err) {
        console.error("PCA Calculation failed:", err);
        setError(`PCA computation failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(false);
      }
    }, 100);
  };

  const prevProjIds = React.useRef(selectedProjectionLayerIds);
  useEffect(() => {
    const projChanged = JSON.stringify(prevProjIds.current) !== JSON.stringify(selectedProjectionLayerIds);
    prevProjIds.current = selectedProjectionLayerIds;

    if (projChanged && pcaResult !== null) {
      runVectorPCA();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectionLayerIds]);

  const downloadPcaCsv = () => {
    if (!pcaResult) return;
    try {
      // Header
      const header = ['FeatureID', 'LayerName', 'PC1', 'PC2', 'PC3', 'Type'];
      const rows = pcaResult.features.map(f => [
        `"${f.id}"`,
        `"${f.layerName}"`,
        f.pc1.toFixed(5),
        f.pc2.toFixed(5),
        f.pc3.toFixed(5),
        f.isProjectionOnly ? '"Projection"' : '"Fitting"'
      ]);

      const blob = new Blob([
        [header.join(','), ...rows.map(r => r.join(','))].join('\n')
      ], { type: 'text/csv;charset=utf-8;' });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `pca_timeseries_results.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (e) {
      console.error(e);
      setError("Failed to export PCA results to CSV");
    }
  };

  const validVectorLayers = layers.filter(l => l.type === 'vector' && vectorLayerHasTimeSeries(l));

  // Visual helper colors for multi-layer clusters
  const LAYER_COLORS = [
    '#f97316', // Orange
    '#3b82f6', // Blue
    '#10b981', // Emerald
    '#ec4899', // Pink
    '#8b5cf6', // Violet
    '#eab308', // Yellow
    '#06b6d4', // Cyan
  ];

  const getLayerColor = (layerName: string) => {
    if (!pcaResult) return '#f97316';
    const idx = pcaResult.layerNames.indexOf(layerName);
    return idx !== -1 ? LAYER_COLORS[idx % LAYER_COLORS.length] : '#f97316';
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md">
        {/* Backdrop overlay dismiss */}
        <div className="absolute inset-0" onClick={onClose} />

        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2 }}
          className="relative w-full max-w-5xl bg-[#0a0a0b] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[85vh] z-10"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-white/[0.02]">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-orange-500 rounded-xl flex items-center justify-center shadow-lg shadow-orange-500/20">
                <BarChart3 size={20} className="text-black" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-white tracking-tight">Timeseries Principal Component Analysis (PCA)</h1>
                <p className="text-xs text-white/50">Run PCA dimension reduction on extracted NDVI timeseries vector layers</p>
              </div>
            </div>
            
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-white/5 rounded-full text-white/40 hover:text-white transition-all active:scale-95"
            >
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* Left Controls Column */}
            <div className="w-80 border-r border-white/10 p-5 flex flex-col justify-between bg-black/20 overflow-y-auto custom-scrollbar">
              <div className="space-y-6">
                <div>
                  <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-3">1. Select Fitting Layers</h3>
                  <p className="text-[10px] text-white/50 mb-2.5 leading-relaxed">
                    These layers are used to compute/train the principal component eigenvectors.
                  </p>
                  
                  {validVectorLayers.length === 0 ? (
                    <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02] text-center">
                      <p className="text-xs text-white/40 italic">No vector layers with extracted timeseries columns found in your session.</p>
                      <p className="text-[10px] text-white/30 mt-2">Upload a vector layer and perform pixel zonal summaries or pixel extractions first.</p>
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1 custom-scrollbar">
                      {validVectorLayers.map(l => {
                        const isChecked = selectedPcaLayerIds.includes(l.id);
                        return (
                          <div
                            key={l.id}
                            onClick={() => {
                              setSelectedPcaLayerIds(prev => {
                                const next = prev.includes(l.id)
                                  ? prev.filter(id => id !== l.id)
                                  : [...prev, l.id];
                                // Auto deselect from projection layer to avoid conflict
                                setSelectedProjectionLayerIds(extPrev => extPrev.filter(id => id !== l.id));
                                return next;
                              });
                            }}
                            className={cn(
                              "flex items-center justify-between p-2.5 rounded-xl border cursor-pointer transition-all",
                              isChecked
                                ? "bg-orange-500/10 border-orange-500/30 text-white"
                                : "bg-white/5 border-white/5 text-white/60 hover:text-white"
                            )}
                          >
                            <div className="flex flex-col min-w-0 pr-2">
                              <span className="text-xs font-semibold truncate">{l.name}</span>
                              <span className="text-[9px] text-white/30">
                                {l.data?.features?.length || 0} features
                              </span>
                            </div>
                            <div className={cn(
                              "w-3.5 h-3.5 rounded flex items-center justify-center border transition-all flex-shrink-0",
                              isChecked
                                ? "bg-orange-500 border-orange-500 text-black"
                                : "border-white/20"
                            )}>
                              {isChecked && (
                                <Check size={8} strokeWidth={4} />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-3">2. Select Projection-Only</h3>
                  <p className="text-[10px] text-white/50 mb-2.5 leading-relaxed">
                    These layers are projected onto the computed PCA space without influencing component training.
                  </p>
                  
                  {validVectorLayers.length === 0 ? (
                    <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02] text-center">
                      <p className="text-xs text-white/40 italic">No vector layers available.</p>
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1 custom-scrollbar">
                      {validVectorLayers.map(l => {
                        const isFitted = selectedPcaLayerIds.includes(l.id);
                        const isChecked = selectedProjectionLayerIds.includes(l.id);
                        return (
                          <div
                            key={l.id}
                            onClick={() => {
                              if (isFitted) return; // Prevent toggling if already fitted
                              setSelectedProjectionLayerIds(prev => {
                                const next = prev.includes(l.id)
                                  ? prev.filter(id => id !== l.id)
                                  : [...prev, l.id];
                                return next;
                              });
                            }}
                            className={cn(
                              "flex items-center justify-between p-2.5 rounded-xl border transition-all",
                              isFitted 
                                ? "bg-white/5 border-white/10 opacity-60 cursor-not-allowed" 
                                : isChecked
                                  ? "bg-amber-500/10 border-amber-500/30 text-white cursor-pointer"
                                  : "bg-white/5 border-white/5 text-white/60 hover:text-white cursor-pointer"
                            )}
                          >
                            <div className="flex flex-col min-w-0 pr-2">
                              <span className="text-xs font-semibold truncate">
                                {l.name}
                              </span>
                              <span className="text-[9px] text-white/30">
                                {l.data?.features?.length || 0} features {isFitted && "- Used for Fitting"}
                              </span>
                            </div>
                            <div className={cn(
                              "w-3.5 h-3.5 rounded flex items-center justify-center border transition-all flex-shrink-0",
                              isFitted
                                ? "border-white/10 bg-white/10"
                                : isChecked
                                  ? "bg-amber-500 border-amber-500 text-black"
                                  : "border-white/20"
                            )}>
                              {isChecked && !isFitted && (
                                <Check size={8} strokeWidth={4} />
                              )}
                              {isFitted && (
                                <div className="w-1.5 h-1.5 rounded-full bg-white/30" />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-4 border-t border-white/5 mt-5">
                {error && (
                  <div className="p-3 mb-3 bg-red-500/10 border border-red-500/20 text-red-500 rounded-xl text-xs font-medium leading-normal animate-fadeIn text-center">
                    {error}
                  </div>
                )}

                <button
                  onClick={runVectorPCA}
                  disabled={selectedPcaLayerIds.length === 0 || loading}
                  className="w-full py-3 bg-orange-500 hover:bg-orange-600 disabled:bg-orange-500/10 disabled:text-white/20 transition-all font-semibold rounded-xl text-black disabled:cursor-not-allowed text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg shadow-orange-500/15"
                >
                  {loading ? (
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, ease: 'linear', duration: 1 }}
                      className="w-4 h-4 border-2 border-black border-t-transparent rounded-full"
                    />
                  ) : (
                    <Play size={14} fill="currentColor" />
                  )}
                  {loading ? "Calculating..." : `Run PCA Analysis`}
                </button>
              </div>
            </div>

            {/* Right Results Display */}
            <div className="flex-1 p-6 flex flex-col bg-white/[0.01] overflow-y-auto custom-scrollbar">
              {!pcaResult ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-8 border border-dashed border-white/10 rounded-2xl bg-black/10">
                  <Sliders size={48} className="text-white/20 mb-4 animate-[pulse_2s_infinite]" />
                  <h3 className="text-sm font-semibold text-white mb-1">Results Pending</h3>
                  <p className="text-xs text-white/40 max-w-sm">
                    Select your vector polygon/pixel layers on the left side and press "Run PCA Analysis" to project timeseries data into principal components.
                  </p>
                </div>
              ) : (
                <div className="flex-1 flex flex-col space-y-6">
                  {/* Stats Summary Rows */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                      <p className="text-[10px] text-white/40 uppercase tracking-wider font-bold">Processed Columns</p>
                      <h4 className="text-lg font-bold text-white mt-1 font-mono">{pcaResult.keys.length}</h4>
                      <p className="text-[9px] text-white/30 truncate mt-0.5">dates detected as timeseries</p>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                      <p className="text-[10px] text-white/40 uppercase tracking-wider font-bold">Projected Points</p>
                      <h4 className="text-lg font-bold text-white mt-1 font-mono">{pcaResult.features.length}</h4>
                      <p className="text-[9px] text-white/30 truncate mt-0.5">features successfully mapped</p>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                      <p className="text-[10px] text-white/40 uppercase tracking-wider font-bold">PC1 Explained Variance</p>
                      <h4 className="text-lg font-bold text-orange-400 mt-1 font-mono">
                        {((pcaResult.explainedVariance[0] || 0) * 100).toFixed(1)}%
                      </h4>
                      <p className="text-[9px] text-white/30 mt-0.5">captures primary timeline trend</p>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                      <p className="text-[10px] text-white/40 uppercase tracking-wider font-bold">PC1 + PC2 Total Coverage</p>
                      <h4 className="text-lg font-bold text-emerald-400 mt-1 font-mono">
                        {(((pcaResult.explainedVariance[0] || 0) + (pcaResult.explainedVariance[1] || 0)) * 100).toFixed(1)}%
                      </h4>
                      <p className="text-[9px] text-white/30 mt-0.5">combined variance coverage</p>
                    </div>
                  </div>

                  {/* Tabs and Export Action */}
                  <div className="flex items-center justify-between border-b border-white/10 pb-2">
                    <div className="flex items-center gap-1.5 p-0.5 bg-white/5 rounded-lg">
                      <button
                        onClick={() => setActiveTab('scatter')}
                        className={cn(
                          "px-4 py-1.5 text-xs font-semibold rounded-md transition-all",
                          activeTab === 'scatter' 
                            ? "bg-orange-500 text-black shadow-md" 
                            : "text-white/60 hover:text-white"
                        )}
                      >
                        PC1 vs PC2 Scatter Plot
                      </button>
                      <button
                        onClick={() => setActiveTab('scree')}
                        className={cn(
                          "px-4 py-1.5 text-xs font-semibold rounded-md transition-all",
                          activeTab === 'scree' 
                            ? "bg-orange-500 text-black shadow-md" 
                            : "text-white/60 hover:text-white"
                        )}
                      >
                        Scree Plot (Explained Variance)
                      </button>
                      <button
                        onClick={() => setActiveTab('features')}
                        className={cn(
                          "px-4 py-1.5 text-xs font-semibold rounded-md transition-all",
                          activeTab === 'features' 
                            ? "bg-orange-500 text-black shadow-md" 
                            : "text-white/60 hover:text-white"
                        )}
                      >
                        PC Scores Table ({pcaResult.features.length})
                      </button>
                    </div>

                    <button
                      onClick={downloadPcaCsv}
                      className="px-3 py-1.5 border border-white/10 hover:border-orange-500/40 hover:bg-orange-500/10 text-white/80 hover:text-white transition-all rounded-lg text-xs font-medium flex items-center gap-2 active:scale-95"
                    >
                      <Download size={14} className="text-orange-500" />
                      Export Scores CSV
                    </button>
                  </div>

                  {/* Dynamic Content pane */}
                  <div className="flex-1 min-h-0">
                    <AnimatePresence mode="wait">
                      {activeTab === 'scatter' && (
                        <motion.div
                          key="scatter-chart"
                          initial={{ opacity: 0, y: 5 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 5 }}
                          className="w-full space-y-4"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] text-white/50 font-medium font-sans">Colormap (Color By):</span>
                              <select
                                value={colorByAttribute}
                                onChange={(e) => setColorByAttribute(e.target.value)}
                                className="bg-zinc-900/90 border border-white/10 hover:border-white/20 rounded-lg px-2.5 py-1 text-xs text-white/90 focus:outline-none focus:border-orange-500/50 cursor-pointer h-7 transition-colors font-sans"
                              >
                                {availableAttributes.map((attr) => (
                                  <option key={attr} value={attr}>
                                    {attr === 'Layer' ? 'Source Layer' : attr}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <span className="text-[10px] text-white/30 italic font-mono">
                              Colored by: {colorByAttribute === 'Layer' ? 'layer name' : colorByAttribute} ({uniqueCategories.length} categories)
                            </span>
                          </div>

                          <div className="h-[400px] w-full border border-white/5 rounded-2xl bg-black/40 p-4">
                            <ResponsiveContainer width="100%" height={360}>
                              <ScatterChart margin={{ top: 20, right: 30, bottom: 20, left: -10 }}>
                                <XAxis 
                                  type="number" 
                                  dataKey="x" 
                                  name="Principal Component 1"
                                  stroke="rgba(255,255,255,0.3)" 
                                  label={{ value: 'PC1 Score', fill: 'rgba(255,255,255,0.4)', position: 'insideBottom', offset: -10, fontSize: 10 }}
                                  fontSize={10} 
                                />
                                <YAxis 
                                  type="number" 
                                  dataKey="y" 
                                  name="Principal Component 2"
                                  stroke="rgba(255,255,255,0.3)" 
                                  label={{ value: 'PC2 Score', fill: 'rgba(255,255,255,0.4)', angle: -90, position: 'insideLeft', offset: -10, fontSize: 10 }}
                                  fontSize={10} 
                                />
                                <Tooltip 
                                  cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeDasharray: '3 3' }}
                                  content={({ active, payload }) => {
                                    if (active && payload && payload.length) {
                                      const data = payload[0].payload;
                                      return (
                                        <div className="bg-zinc-950 border border-white/10 p-3 rounded-lg text-xs shadow-2xl backdrop-blur-md space-y-2">
                                          <p className="font-bold text-orange-500 truncate max-w-[200px]">{data.name}</p>
                                          {data.species && data.species !== 'Unknown' && (
                                            <p className="text-purple-400 font-bold text-[11px]">Species: {data.species}</p>
                                          )}
                                          {colorByAttribute !== 'Layer' && colorByAttribute.toLowerCase() !== 'species' && (
                                            <p className="text-amber-400 font-bold text-[11px]">
                                              {colorByAttribute}: {data.properties?.[colorByAttribute] ?? 'Unknown'}
                                            </p>
                                          )}
                                          <p className="text-white/45 text-[10px]">{data.layer}</p>
                                          {data.isProjectionOnly && (
                                            <div className="pt-0.5 pb-1">
                                              <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-400 uppercase tracking-widest leading-none border border-amber-500/20">
                                                Projection-Only
                                              </span>
                                            </div>
                                          )}
                                          <div className="font-mono space-y-1 pt-1 border-t border-white/5 text-[11px]">
                                            <p>PC1: <span className="text-white font-bold">{data.x.toFixed(4)}</span></p>
                                            <p>PC2: <span className="text-white font-bold">{data.y.toFixed(4)}</span></p>
                                            <p className="text-[10px] text-white/30 truncate mt-1">Layer: {data.layer}</p>
                                          </div>
                                        </div>
                                      );
                                    }
                                    return null;
                                  }}
                                />
                                <Legend verticalAlign="top" height={36} iconType="circle" wrapperStyle={{ fontSize: '11px', color: '#ccc' }} />
                                {uniqueCategories.map((category, idx) => (
                                  <Scatter 
                                    key={`${category}-${idx}`}
                                    name={category} 
                                    data={pcaResult.features
                                      .filter(f => getAttributeValue(f, colorByAttribute) === category)
                                      .map((f: any) => ({
                                        x: f.pc1,
                                        y: f.pc2,
                                        name: f.name,
                                        layer: f.layerName,
                                        isProjectionOnly: f.isProjectionOnly,
                                        species: extractSpecies(f.properties) || 'Unknown',
                                        properties: f.properties
                                      }))} 
                                    fill={LAYER_COLORS[idx % LAYER_COLORS.length]}
                                    shape={(props: any) => {
                                      const { cx, cy, fill, payload } = props;
                                      if (typeof cx !== 'number' || typeof cy !== 'number' || isNaN(cx) || isNaN(cy)) return null;
                                      if (payload.isProjectionOnly) {
                                        // Render a diamond for projection data
                                        return (
                                          <g transform={`translate(${cx}, ${cy})`}>
                                            <path d="M0,-5 L5,0 L0,5 L-5,0 Z" fill={fill} stroke="#ffffff" strokeWidth={1.5} opacity={0.9} />
                                          </g>
                                        );
                                      }
                                      // Render standard circle for fitting data
                                      return (
                                        <g transform={`translate(${cx}, ${cy})`}>
                                          <circle cx={0} cy={0} r={4} fill={fill} stroke="rgba(255,255,255,0.4)" strokeWidth={1} opacity={0.8} />
                                        </g>
                                      );
                                    }}
                                  />
                                ))}
                              </ScatterChart>
                            </ResponsiveContainer>
                          </div>
                        </motion.div>
                      )}

                      {activeTab === 'scree' && (
                        <motion.div
                           key="scree-chart"
                           initial={{ opacity: 0, y: 5 }}
                           animate={{ opacity: 1, y: 0 }}
                           exit={{ opacity: 0, y: 5 }}
                           className="w-full space-y-4"
                        >
                          <div className="h-[400px] w-full border border-white/5 rounded-2xl bg-black/40 p-4">
                            <ResponsiveContainer width="100%" height={360}>
                              <BarChart
                                data={pcaResult.explainedVariance.slice(0, 8).map((ev, i) => ({
                                  name: `PC ${i + 1}`,
                                  variance: Number((ev * 100).toFixed(2)),
                                  cumulative: Number((pcaResult.cumulativeVariance[i] * 100).toFixed(2))
                                }))}
                                margin={{ top: 20, right: 30, left: -20, bottom: 20 }}
                              >
                                <XAxis dataKey="name" stroke="rgba(255,255,255,0.3)" fontSize={10} />
                                <YAxis stroke="rgba(255,255,255,0.3)" fontSize={10} />
                                <Tooltip
                                  contentStyle={{ backgroundColor: '#09090b', borderColor: 'rgba(255,255,255,0.1)', borderRadius: '8px' }}
                                  itemStyle={{ fontSize: '11px', color: '#fff' }}
                                  labelStyle={{ color: '#f97316', fontWeight: 'bold', fontSize: '11px' }}
                                />
                                <Bar dataKey="variance" fill="#f97316" radius={[4, 4, 0, 0]} name="Individual Variance (%)" />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </motion.div>
                      )}

                      {activeTab === 'features' && (
                        <motion.div
                          key="features-table"
                          initial={{ opacity: 0, y: 5 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 5 }}
                          className="w-full space-y-4"
                        >
                           <div className="max-h-[400px] overflow-y-auto border border-white/5 rounded-2xl bg-black/40 custom-scrollbar">
                            <table className="w-full text-left border-collapse">
                              <thead>
                                <tr className="border-b border-white/10 text-[10px] text-white/40 uppercase tracking-wider bg-white/[0.02]">
                                  <th className="py-2.5 px-4">Feature ID</th>
                                  {pcaResult.features.some(f => extractSpecies(f.properties)) && (
                                    <th className="py-2.5 px-4">Species</th>
                                  )}
                                  <th className="py-2.5 px-4">Source Layer</th>
                                  <th className="py-2.5 px-4 text-right">PC1 Score</th>
                                  <th className="py-2.5 px-4 text-right">PC2 Score</th>
                                  <th className="py-2.5 px-4 text-right">PC3 Score</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-white/5 font-mono text-xs">
                                {pcaResult.features.map((f, i) => {
                                  const hasSpeciesCol = pcaResult.features.some(fe => extractSpecies(fe.properties));
                                  const speciesVal = extractSpecies(f.properties) || '-';
                                  return (
                                    <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                                      <td className="py-2 px-4 text-white font-sans max-w-[200px] truncate" title={f.id}>
                                        <div className="flex items-center gap-2">
                                          <span>{f.name}</span>
                                          {f.isProjectionOnly && (
                                            <span className="text-[9px] px-1 bg-amber-500/15 text-amber-400 font-bold font-sans uppercase rounded tracking-wider leading-none">
                                              Proj
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                      {hasSpeciesCol && (
                                        <td className="py-2 px-4 text-purple-400 font-sans font-medium">
                                          {speciesVal}
                                        </td>
                                      )}
                                      <td className="py-2 px-4">
                                        <span 
                                          className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10px]"
                                          style={{ backgroundColor: `${getLayerColor(f.layerName)}15`, color: getLayerColor(f.layerName) }}
                                        >
                                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: getLayerColor(f.layerName) }}></span>
                                          {f.layerName}
                                        </span>
                                      </td>
                                      <td className="py-2 px-4 text-right font-bold text-orange-400">
                                        {f.pc1.toFixed(4)}
                                      </td>
                                      <td className="py-2 px-4 text-right text-white/70">
                                        {f.pc2.toFixed(4)}
                                      </td>
                                      <td className="py-2 px-4 text-right text-white/50">
                                        {f.pc3.toFixed(4)}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
