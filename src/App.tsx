import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { motion, AnimatePresence, Reorder } from 'motion/react';
import { Upload, FileText, Map as MapIcon, Layers, Info, X, Loader2, Settings2, Sliders, Hexagon, Eye, EyeOff, Trash2, ChevronUp, ChevronDown, Search, Calendar, Cloud, Download, Folder, LineChart as LineChartIcon, Maximize, Minimize, BookOpen, RotateCcw, Database, BarChart3 } from 'lucide-react';
import { processGeoTIFF, processRemoteGeoTIFF, GeoTIFFData, RenderingOptions, fetchRemoteBand, rasterToGeotiffBlob, extractZonalPixels } from './lib/geotiff-utils';
import { extractPixelTimeseriesOptions } from './lib/pixel-extraction';
import { MapViewer } from './components/MapViewer';
import { VectorFeaturePanel } from './components/VectorFeaturePanel';
import { LocalPythonServerModal } from './components/LocalPythonServerModal';
import { DocumentationModal } from './components/DocumentationModal';
import PcaModal from './components/PcaModal';
import { cn } from './lib/utils';
import shp from 'shpjs';
import {
  searchSentinel2Chunked,
  groupItemsByDate,
  selectEvenlySpaced,
  signUrl,
  signSTACItem,
  STACItem,
} from './services/stac-service';
import {
  normalizeLocalUrl,
  fetchLocalServer,
  fetchWithLocalHeaders,
  checkLocalServerStatus,
} from './services/local-server';
import {
  getGeoJsonBounds,
  getBboxIntersectionArea,
  getBboxDimensions,
  bufferBboxMeters,
} from './lib/geo';
import { getAssetKey, S2_ALL_ASSETS, getBandOptions, getBandName } from './lib/sentinel';
import { INDEX_FORMULAS } from './lib/spectral';
import { removeDateProperties, extractDateFromFilename } from './lib/timeseries';
import {
  DEFAULT_OPTIONS,
  createRasterLayer,
  createVectorLayer,
  isPixelsLayer,
  pixelsLayerId,
  getFeatureDisplayName,
  formatPixelsLayerName,
  downloadGeoJson,
} from './lib/layer-factory';
import { format, subDays } from 'date-fns';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { get, set, clear } from 'idb-keyval';

import { Layer, RasterLayer, VectorLayer } from './types';

// Re-exported for backwards compatibility — the implementation lives in lib/geo.ts.
export { getGeoJsonBounds } from './lib/geo';

export default function App() {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ 
    current: number, 
    total: number, 
    status?: string,
    bytesDownloaded?: number,
    totalBytes?: number
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verboseLogs, setVerboseLogs] = useState<string[]>([]);

  const addVerboseLog = (msg: string) => {
    console.log(`[Diagnostic] ${msg}`);
    setVerboseLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const logErrorDetails = (context: string, err: any) => {
    const errorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const errorStack = err instanceof Error && err.stack ? `\nStack: ${err.stack}` : '';
    const fullLog = `[ERROR] ${context} -> ${errorMsg}${errorStack}`;
    console.error(fullLog);
    setVerboseLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${fullLog}`]);
  };
  const [isDragging, setIsDragging] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [extractionResult, setExtractionResult] = useState<{ csv: string, layerName: string } | null>(null);
  
  // Search State
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [isPixelAnalysisMode, setIsPixelAnalysisMode] = useState(false);
  const [mapZoom, setMapZoom] = useState<number>(2);
  const [searchBbox, setSearchBbox] = useState<[number, number, number, number] | null>(null);
  const [drawingBbox, setDrawingBbox] = useState<[number, number, number, number] | null>(null);
  const [startDate, setStartDate] = useState("2024-05-01");
  const [endDate, setEndDate] = useState("2024-05-31");
  const [targetCount, setTargetCount] = useState(5);
  const [maxCloudCover, setMaxCloudCover] = useState(60);
  const [searchResults, setSearchResults] = useState<STACItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isExtractingTimeline, setIsExtractingTimeline] = useState(false);
  const [filterByBbox, setFilterByBbox] = useState(false);
  const [isFetchingSeries, setIsFetchingSeries] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{current: number, total: number} | null>(null);
  const [mpcToken, setMpcToken] = useState<string>(localStorage.getItem('mpc_token') || '');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cropAroundShp, setCropAroundShp] = useState(false);
  const [shpBufferMeters, setShpBufferMeters] = useState(50);
  const [mapCenter, setMapCenter] = useState<[number, number]>([0, 0]);
  const [isStateLoaded, setIsStateLoaded] = useState(false);
  const [showLocalPythonServer, setShowLocalPythonServer] = useState(false);
  const [showPcaModal, setShowPcaModal] = useState(false);
  const [showVerboseLogsList, setShowVerboseLogsList] = useState(false);
  
  const [localUrl, setLocalUrl] = useState('http://localhost:8080');
  const [useLocalServer, setUseLocalServer] = useState<boolean>(() => {
    const saved = localStorage.getItem('use_local_server');
    return saved === null ? false : saved === 'true';
  });

  // Save useLocalServer to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('use_local_server', String(useLocalServer));
  }, [useLocalServer]);

  const [selectedVectorFeature, setSelectedVectorFeature] = useState<any>(null);
  const [selectedVectorLayer, setSelectedVectorLayer] = useState<VectorLayer | null>(null);

  const handleSelectVector = useCallback((feature: any, layer: VectorLayer | null = null) => {
    setSelectedVectorFeature(feature);
    setSelectedVectorLayer(layer);
  }, []);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const globalCropBboxRef = React.useRef<[number, number, number, number] | null>(null);

  // Load state on mount
  useEffect(() => {
    const loadState = async () => {
      try {
        const savedState = await get('app_state');
        if (savedState) {
          if (savedState.searchBbox) setSearchBbox(savedState.searchBbox);
          if (savedState.drawingBbox) setDrawingBbox(savedState.drawingBbox);
          if (savedState.startDate) setStartDate(savedState.startDate);
          if (savedState.endDate) setEndDate(savedState.endDate);
          if (savedState.targetCount) setTargetCount(savedState.targetCount);
          if (savedState.maxCloudCover) setMaxCloudCover(savedState.maxCloudCover);
          if (savedState.mapZoom) setMapZoom(savedState.mapZoom);
          if (savedState.mapCenter) setMapCenter(savedState.mapCenter);
          if (savedState.cropAroundShp !== undefined) setCropAroundShp(savedState.cropAroundShp);
          if (savedState.shpBufferMeters) setShpBufferMeters(savedState.shpBufferMeters);
          if (savedState.mpcToken) setMpcToken(savedState.mpcToken);
          
          if (savedState.layers) {
            const reconstructedLayers = savedState.layers.map((l: any) => {
              if (l.type === 'raster') {
                if (l.data) {
                  // Restore prototype for GeoTIFFData image canvas (if needed by other code)
                  l.data.image = document.createElement('canvas');
                }
                if (!l.datetime && l.stacItem?.properties?.datetime) {
                  l.datetime = l.stacItem.properties.datetime;
                }
              }
              return l;
            });
            setLayers(reconstructedLayers);
          }
          if (savedState.selectedLayerId) setSelectedLayerId(savedState.selectedLayerId);
        }
      } catch (err) {
        console.error("Failed to load saved state", err);
      } finally {
        setIsStateLoaded(true);
      }
    };
    loadState();
  }, []);

  // Save state when it changes
  useEffect(() => {
    if (!isStateLoaded) return;
    
    // We omit the actual canvas instance from the saved layers to avoid serialization errors.
    const stateToSave = {
      searchBbox, drawingBbox, selectedLayerId, startDate, endDate, 
      targetCount, maxCloudCover, mapZoom, mapCenter, cropAroundShp, shpBufferMeters, mpcToken,
      layers: layers.filter(l => !l.id.startsWith('pca-') && !l.id.startsWith('pixels-')).map(l => {
        if (l.type === 'raster' && l.data) {
          // Keep everything except the HTMLCanvasElement and massive typed arrays
          const { image, rawBuffer, bandData, ...restData } = l.data;
          return { ...l, data: restData } as any;
        }
        return l;
      })
    };
    
    // Fire and forget save
    set('app_state', stateToSave).catch(e => console.error("Failed to save state", e));
  }, [
    layers, searchBbox, drawingBbox, selectedLayerId, startDate, endDate, 
    targetCount, maxCloudCover, mapZoom, mapCenter, cropAroundShp, shpBufferMeters, mpcToken, isStateLoaded
  ]);

  // Save token to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('mpc_token', mpcToken);
  }, [mpcToken]);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
      } catch (err) {
        console.error("Error attempting to enable fullscreen:", err);
        setIsFullscreen(true); // Fallback
      }
    } else {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      }
    }
  };

  const getBufferedShpBbox = useCallback((bufferMeters: number): [number, number, number, number] | null => {
    const vectorLayer = layers.find(l => l.type === 'vector');
    if (!vectorLayer || !vectorLayer.data) return null;

    // We already have bbox pre-calculated in the vector layer!
    const bounds = vectorLayer.bbox || getGeoJsonBounds(vectorLayer.data);
    if (!bounds) return null;

    return bufferBboxMeters(bounds, bufferMeters);
  }, [layers]);

  const globalCropBbox = useMemo(() => {
    return cropAroundShp ? getBufferedShpBbox(shpBufferMeters) : null;
  }, [cropAroundShp, shpBufferMeters, getBufferedShpBbox]);

  useEffect(() => {
    globalCropBboxRef.current = globalCropBbox;
  }, [globalCropBbox]);

  const applyVectorCrop = useCallback(() => {
    const newClipBbox = getBufferedShpBbox(shpBufferMeters);
    if (!newClipBbox) return;

    layers.forEach(l => {
      if (l.type === 'raster') {
        const rasterBbox = l.remoteBbox || l.data?.metadata?.imageBbox || l.data?.metadata?.originalBbox;
        let shouldCrop = cropAroundShp;
        if (cropAroundShp && rasterBbox && newClipBbox) {
          const overlap = getBboxIntersectionArea(newClipBbox, rasterBbox as [number, number, number, number]);
          if (overlap <= 0) {
            shouldCrop = false;
          }
        }
        
        const bboxData = shouldCrop ? newClipBbox : null;
        if (JSON.stringify(bboxData) !== JSON.stringify(l.clipBbox)) {
          reprocessLayer(l.id, l.options, true, bboxData);
        }
      }
    });
  }, [layers, cropAroundShp, shpBufferMeters, getBufferedShpBbox]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const selectedLayer = useMemo(() => 
    layers.find(l => l.id === selectedLayerId) || null
  , [layers, selectedLayerId]);

  const activeLayer = useMemo(() => 
    layers.find(l => l.id === selectedLayerId) || layers.find(l => l.type === 'raster' && l.datetime && l.visible) || null
  , [layers, selectedLayerId]);

  const memoizedSeriesLayers = useMemo(() => {
    const activeSeriesId = activeLayer?.seriesId;
    const seriesLayers = activeSeriesId 
      ? layers.filter(l => l.seriesId === activeSeriesId)
      : layers.filter(l => !l.seriesId);
    return seriesLayers;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.map(l => l.id).join(','), activeLayer?.seriesId]);

  const handleSearch = async () => {
    if (!searchBbox) {
      setError('Please select an area on the map first.');
      return;
    }
    if (!startDate || !endDate) {
      setError('Please specify both start and end dates.');
      return;
    }

    setIsSearching(true);
    setError(null);
    try {
      // Shared pipeline: chunked search -> dedupe -> group-by-date -> evenly spaced
      const rawResults = await searchSentinel2Chunked(searchBbox, startDate, endDate, maxCloudCover, mpcToken);
      const uniqueResults = groupItemsByDate(rawResults);
      const selectedItems = selectEvenlySpaced(uniqueResults, targetCount);

      setSearchResults(selectedItems);
      if (selectedItems.length === 0) {
        setError('No images found for the selected area and criteria.');
      }
    } catch (err) {
      console.error(err);
      setError('Failed to search for Sentinel-2 images.');
    } finally {
      setIsSearching(false);
    }
  };

  const createLayerFromSTACItem = async (item: STACItem & { groupItems?: STACItem[] }, isVisible: boolean = true, seriesId?: string): Promise<RasterLayer> => {
    if (!searchBbox) throw new Error("Search bbox is required");
    
    let bboxToUse = searchBbox;
    if (cropAroundShp && globalCropBboxRef.current) {
      const shpBbox = globalCropBboxRef.current;
      const overlap = getBboxIntersectionArea(shpBbox, searchBbox);
      if (overlap > 0) {
        bboxToUse = shpBbox;
        addVerboseLog(`[createLayer] SHP crop bounds intersect with search bounding box. Cropping raster around SHP.`);
      } else {
        addVerboseLog(`[createLayer] SHP crop bounds [${shpBbox.join(', ')}] DO NOT overlap with search bounding box [${searchBbox.join(', ')}]. Bypassing SHP crop and using search bounds so pictures are centered on where you asked.`);
      }
    }

    let itemsToProcess = item.groupItems && item.groupItems.length > 0 ? item.groupItems : [item];
    
    // Deduplicate by STAC Item ID to be absolutely sure there are no duplicates in the processing queue
    const uniqueMap = new Map<string, STACItem>();
    itemsToProcess.forEach(it => {
      uniqueMap.set(it.id, it);
    });
    itemsToProcess = Array.from(uniqueMap.values());
    
    addVerboseLog(`[createLayer] Processing STAC Item ${item.id} (${item.properties.datetime}) containing ${itemsToProcess.length} tile(s)...`);
    addVerboseLog(`[createLayer] Selected bounding box: [${bboxToUse.join(', ')}]`);
    
    // Filter out items that do not overlap with the requested crop bounding box
    if (bboxToUse) {
      const filtered = itemsToProcess.filter(it => {
        if (!it.bbox) return true;
        return !(
          it.bbox[2] < bboxToUse[0] || // it is entirely west of bboxToUse
          it.bbox[0] > bboxToUse[2] || // it is entirely east of bboxToUse
          it.bbox[3] < bboxToUse[1] || // it is entirely south of bboxToUse
          it.bbox[1] > bboxToUse[3]    // it is entirely north of bboxToUse
        );
      });
      if (filtered.length > 0) {
        itemsToProcess = filtered;
      } else {
        const warnMsg = `All tiles on ${item.properties.datetime.split('T')[0]} were outside the cropped bbox. Falling back to use all ${itemsToProcess.length} tiles.`;
        addVerboseLog(`[createLayer] [Warning] ${warnMsg}`);
        console.warn(warnMsg);
      }
    }

    addVerboseLog(`[createLayer] Requesting MPC endpoint to sign ${itemsToProcess.length} tile(s)...`);
    let signedItems;
    try {
      signedItems = await Promise.all(itemsToProcess.map(it => signSTACItem(it, mpcToken)));
      addVerboseLog(`[createLayer] MPC URLs signed successfully.`);
    } catch (e) {
      logErrorDetails(`MPC Signing failed for ${itemsToProcess.length} tile(s)`, e);
      throw e;
    }
    
    const signedItem = signedItems[0];
    const assets = signedItem.assets;
    
    // Check if at least one asset is signed
    const signedAssetCount = Object.values(assets).filter((a: any) => a?.href?.includes('?')).length;
    addVerboseLog(`[createLayer] Signed primary item assets: found ${signedAssetCount} signed URL(s) out of ${Object.keys(assets).length}.`);
    
    if (signedAssetCount === 0) {
      const err = new Error('Failed to sign the image URLs (Unsigned). Microsoft Planetary Computer returned unsigned URLs. This usually means the signing service is down or you need an API key for this area. Please check if you have entered a valid MPC API Key.');
      logErrorDetails(`Unsigned URLs returned from MPC`, err);
      throw err;
    }

    if (!assets.B04 || !assets.B03 || !assets.B02) {
      const errMessage = `STAC item missing required bands (B04, B03, B02). Found keys: ${Object.keys(assets).join(', ')}`;
      addVerboseLog(`[createLayer] [Error] ${errMessage}`);
      console.error(errMessage, assets);
      throw new Error('Selected image is missing required spectral bands.');
    }

    // Default bands (empty so we only fetch what is strictly required)
    const bandUrls: Record<string, string | string[]> = {};

    // Collect all band URLs from STAC to store them in remoteUrls
    const allBandUrls: Record<string, string | string[]> = {};
    S2_ALL_ASSETS.forEach(band => {
      const hrefs = (signedItems as any[]).map(si => si.assets[band]?.href).filter(Boolean);
      if (hrefs.length > 0) {
        allBandUrls[band] = hrefs.length === 1 ? hrefs[0] : hrefs;
      }
    });

    // Ensure we only pass the bands required by DEFAULT_OPTIONS for initial rendering
    const requiredBands = [
      getAssetKey(DEFAULT_OPTIONS.bands[0]),
      getAssetKey(DEFAULT_OPTIONS.bands[1]),
      getAssetKey(DEFAULT_OPTIONS.bands[2]),
      getAssetKey(DEFAULT_OPTIONS.indexBands.nir),
      getAssetKey(DEFAULT_OPTIONS.singleBand)
    ];

    requiredBands.forEach(band => {
      const hrefs = (signedItems as any[]).map(si => si.assets[band]?.href).filter(Boolean);
      if (hrefs.length > 0) {
        bandUrls[band] = hrefs.length === 1 ? hrefs[0] : hrefs;
      }
    });

    addVerboseLog(`[createLayer] requiredBands set is [${Object.keys(bandUrls).join(', ')}]`);
    
    let processedData;
    let localEngineAvailable = false;
    
    if (useLocalServer) {
      addVerboseLog(`[createLayer] Checking status of Local Python Engine at ${localUrl}...`);
      try {
        const pingData = await checkLocalServerStatus(localUrl);
        localEngineAvailable = true;
        addVerboseLog(`[createLayer] Local Python Engine detected successfully! Response: ${JSON.stringify(pingData)}`);
      } catch(e) {
        const errMessage = `Failed to connect to the local Python server at ${normalizeLocalUrl(localUrl)}.\nPlease verify that your local Python server is running, or disable Local Python Server in the settings modal.\nDetail: ${e instanceof Error ? e.message : String(e)}`;
        addVerboseLog(`[createLayer] [Error] ${errMessage}`);
        throw new Error(errMessage);
      }
    } else {
      addVerboseLog(`[createLayer] Local Python Engine integration is disabled. Bypassing other methods and falling back directly to browser-side decoding.`);
    }

    if (useLocalServer && localEngineAvailable) {
      addVerboseLog(`[createLayer] Delegating band crop to Local Python Engine...`);
      try {
        let procRes: Response;
        const postUrl = `${normalizeLocalUrl(localUrl)}/api/process_bands`;

        try {
          addVerboseLog(`[createLayer] Step 1/3: Sending POST to process_bands API (${postUrl}) with Item ID: ${item.id}`);
          // Add a random token for caching since we updated python server script
          const reqId = `${item.id}_${Math.random().toString(36).substring(7)}`;
          procRes = await fetchLocalServer(localUrl, '/api/process_bands', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: reqId,
              urls: bandUrls,
              bbox: bboxToUse
            })
          });
        } catch (err) {
          logErrorDetails(`POST request to process_bands API (${postUrl}) completely failed. Possible network blocker, CORS restriction, or server unreachable`, err);
          throw new Error(`Failed to contact Local Python Engine at ${postUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }

        addVerboseLog(`[createLayer] Step 1 response status matches: Code ${procRes.status} (${procRes.statusText})`);
        if (!procRes.ok) {
          const errorContent = await procRes.text().catch(() => "Unknown error content");
          addVerboseLog(`[createLayer] process_bands API returned non-OK status. Content overview: ${errorContent.substring(0, 200)}`);
          throw new Error(`HTTP Error ${procRes.status} from process_bands: ${errorContent}`);
        }

        let procData;
        try {
          procData = await procRes.json();
        } catch (err) {
          logErrorDetails(`Failed to parse response JSON from process_bands API`, err);
          throw new Error(`Failed to decode process_bands JSON response: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (procData.error) {
          addVerboseLog(`[createLayer] Python server returned an explicit error block: ${procData.error}`);
          throw new Error("Python Engine Internal Error: " + procData.error);
        }
        
        const downloadUrl = normalizeLocalUrl(procData.url);
        addVerboseLog(`[createLayer] Step 2/3: Downloading processed GeoTIFF from Python cache URL: ${downloadUrl}`);

        let fileRes: Response;
        try {
          fileRes = await fetchWithLocalHeaders(downloadUrl);
        } catch (err) {
          logErrorDetails(`GET file download request to ${downloadUrl} failed. Possible CORS issue, mixed content blocker, or hostname resolution error`, err);
          throw new Error(`Failed to download result from ${downloadUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }

        addVerboseLog(`[createLayer] Step 2 response status: Code ${fileRes.status} (${fileRes.statusText})`);
        if (!fileRes.ok) {
          const errorContent = await fileRes.text().catch(() => "Unknown error content");
          addVerboseLog(`[createLayer] GET file download returned non-OK status: ${errorContent.substring(0, 100)}`);
          throw new Error(`HTTP Error ${fileRes.status} from download URL: ${errorContent}`);
        }

        let arrayBuffer: ArrayBuffer;
        try {
          arrayBuffer = await fileRes.arrayBuffer();
          addVerboseLog(`[createLayer] Successfully downloaded GeoTIFF buffer. Data length: ${arrayBuffer.byteLength} bytes`);
        } catch (err) {
          logErrorDetails(`Failed to extract ArrayBuffer from file response stream`, err);
          throw new Error(`Failed to retrieve binary buffer from download stream: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          addVerboseLog(`[createLayer] Step 3/3: Parsing GeoTIFF buffer and building image canvas in browser...`);
          
          // Python backend wrote the GeoTIFF bands in the exact order of keys in bandUrls.
          // We need to map standard indices (like 4 for B04) to their 0-based array index in the GeoTIFF.
          const requiredKeys = Object.keys(bandUrls);
          const mapIndices: Record<number, number> = {};
          const extractNum = (k: string) => {
             if (k === 'B8A') return 9;
             const m = k.match(/B(\d+)/);
             return m ? parseInt(m[1], 10) : 4;
          };
          requiredKeys.forEach((key, idx) => {
             mapIndices[extractNum(key)] = idx;
          });
          
          const optionsWithMap = { ...DEFAULT_OPTIONS, bandMap: mapIndices };
          
          processedData = await processGeoTIFF(arrayBuffer, optionsWithMap, null);
          addVerboseLog(`[createLayer] Success! GeoTIFF parsed. Dimensions: ${processedData.image.width}x${processedData.image.height}`);
        } catch (err) {
          logErrorDetails(`Failed parsing browser-side GeoTIFF with processGeoTIFF`, err);
          throw new Error(`Failed to parse GeoTIFF: ${err instanceof Error ? err.message : String(err)}`);
        }
      } catch (outerErr) {
        logErrorDetails("Local Python Engine processing failed", outerErr);
        throw new Error(`Local Python Engine processing failed: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`);
      }
    }

    if (!localEngineAvailable) {
      addVerboseLog(`[createLayer] Running browser-side thick client approach. Directly calling processRemoteGeoTIFF...`);
      
      // Determine the single best overlapping tile to fetch
      let bestTile = itemsToProcess[0];
      if (itemsToProcess.length > 1 && bboxToUse) {
        let maxOverlap = -1;
        itemsToProcess.forEach(tile => {
          if (tile.bbox) {
            const overlap = getBboxIntersectionArea(tile.bbox as any, bboxToUse);
            if (overlap > maxOverlap) {
              maxOverlap = overlap;
              bestTile = tile;
            }
          }
        });
        addVerboseLog(`[createLayer] Multiple tiles available for browser-side fallback. Selected best overlapping tile ${bestTile.id} with overlap area ${maxOverlap.toFixed(6)}`);
      }

      const tileIndex = itemsToProcess.indexOf(bestTile);
      // Legacy Thick Client Browser Approach
      const singleBandUrls: Record<string, string> = {};
      Object.entries(bandUrls).forEach(([bandName, val]) => {
        singleBandUrls[bandName] = Array.isArray(val) ? (val[tileIndex] || val[0]) : val;
      });
      try {
        processedData = await processRemoteGeoTIFF(singleBandUrls, bboxToUse, DEFAULT_OPTIONS);
        addVerboseLog(`[createLayer] Browser-side processRemoteGeoTIFF success! Canvas size: ${processedData.image.width}x${processedData.image.height}`);
      } catch (e) {
        logErrorDetails("Browser-side thick client retrieval completely failed", e);
        throw e;
      }
    }
    
    const actualClipBbox = (cropAroundShp && globalCropBboxRef.current && bboxToUse === globalCropBboxRef.current)
      ? globalCropBboxRef.current
      : undefined;

    return createRasterLayer({
      name: `S2A_${item.properties.datetime.split('T')[0]}`,
      data: processedData,
      visible: isVisible,
      remoteUrls: allBandUrls as any,
      remoteBbox: searchBbox,
      stacItem: item,
      seriesId,
      datetime: item.properties.datetime,
      clipBbox: actualClipBbox
    });
  };

  const fetchSentinelImage = async (item: STACItem) => {
    if (!searchBbox) return;
    
    setLoading(true);
    setError(null);
    setVerboseLogs([]);
    addVerboseLog(`Single STAC Image Fetch triggered for date: ${item.properties.datetime.split('T')[0]}, ID: ${item.id}`);
    try {
      const newLayer = await createLayerFromSTACItem(item, true);
      addVerboseLog(`SUCCESS! Loaded single image layer successfully.`);
      setLayers(prev => [newLayer, ...prev]);
      setSelectedLayerId(newLayer.id);
      setIsDrawingMode(false);
    } catch (err) {
      logErrorDetails("Error in fetchSentinelImage", err);
      setError(err instanceof Error ? err.message : 'Failed to fetch and process Sentinel-2 data.');
    } finally {
      setLoading(false);
    }
  };

  const fetchFromPythonServer = async (bbox: [number, number, number, number]) => {
    if (!bbox) return;
    setLoading(true);
    setIsFetchingSeries(true);
    setError(null);
    setVerboseLogs([]);
    addVerboseLog(`[PythonMosaic] Querying Python Mosaic Engine for bbox: [${bbox.join(', ')}]`);

    try {
      const normalizedLocalUrl = normalizeLocalUrl(localUrl);
      addVerboseLog(`[PythonMosaic] Checking local python engine status at ${normalizedLocalUrl}...`);

      await checkLocalServerStatus(localUrl);

      // Find the active vector layer if any to send its polygons
      const vectorLayer = layers.find(l => l.type === 'vector' && l.visible && l.data) as VectorLayer;

      // Query format specified in prompt:
      const queryBody: any = {
        id: "s2_mosaic_" + Math.random().toString(36).substring(2, 8),
        bbox: bbox,
        start_date: startDate ? startDate.split('T')[0] : "2024-05-01",
        end_date: endDate ? endDate.split('T')[0] : "2024-05-31",
        bands: ["B04", "B03", "B02", "B08"],
        max_cloud_cover: maxCloudCover || 30,
        resolution: 10,
        n_dates: targetCount || 2,
        resampling: "bilinear",
        cluster_distance_m: 500,
        polygon_buffer_m: cropAroundShp ? shpBufferMeters : 0
      };

      if (vectorLayer && vectorLayer.data) {
        queryBody.polygons = vectorLayer.data;
        addVerboseLog(`[PythonMosaic] Attaching active Vector Layer polygons constraint to the query.`);
      }

      addVerboseLog(`[PythonMosaic] Sending search & process query: ${JSON.stringify(queryBody, null, 2)}`);
      
      const res = await fetchLocalServer(localUrl, '/api/process_sentinel2_dates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(queryBody)
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Python server returned error ${res.status}: ${errText}`);
      }

      const responseData = await res.json();
      
      // Robustly get results array from possible formats
      let results: any[] = [];
      if (Array.isArray(responseData)) {
        results = responseData;
      } else if (responseData && Array.isArray(responseData.results)) {
        results = responseData.results;
      } else if (responseData && responseData.status === 'success' && Array.isArray(responseData.data)) {
        results = responseData.data;
      } else if (responseData && responseData.results) {
        results = Object.values(responseData.results);
      }

      addVerboseLog(`[PythonMosaic] Successfully retrieved ${results.length} daily results.`);

      if (results.length === 0) {
        setError('No images found on the Python server for the selected area and criteria.');
        setIsFetchingSeries(false);
        setLoading(false);
        return;
      }

      // Use the returned polygon_bounds_wgs84 if provided, otherwise fallback to request bbox
      const effectiveBbox: [number, number, number, number] = responseData.polygon_bounds_wgs84 || bbox;
      if (responseData.polygon_bounds_wgs84) {
        addVerboseLog(`[PythonMosaic] Applying received polygon_bounds_wgs84 to layers for correct map overlay alignment: [${effectiveBbox.join(', ')}]`);
      }

      // Sort results by date descending to put newest on top
      results.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const newLayers: RasterLayer[] = [];
      const seriesId = crypto.randomUUID();

      setDownloadProgress({ current: 0, total: results.length, status: 'Initializing download pipeline...' });

      for (let i = 0; i < results.length; i++) {
        const dateResult = results[i];
        const dateStr = dateResult.date;
        const tifUrl = dateResult.url;

        addVerboseLog(`[PythonMosaic] [${i+1}/${results.length}] Downloading GeoTIFF for ${dateStr}...`);
        setDownloadProgress({
          current: i + 1,
          total: results.length,
          status: `Downloading & rendering mosaic for ${dateStr}`
        });

        const downloadUrl = normalizeLocalUrl(tifUrl);
        const fileRes = await fetchWithLocalHeaders(downloadUrl);

        if (!fileRes.ok) {
          throw new Error(`Failed to download GeoTIFF for ${dateStr} from ${downloadUrl}`);
        }

        const arrayBuffer = await fileRes.arrayBuffer();
        addVerboseLog(`[PythonMosaic] Downloaded ${arrayBuffer.byteLength} bytes for ${dateStr}`);

        // Custom Sentinel band index mapping: Standard bands are Red (4), Green (3), Blue (2), NIR (8)
        // Order of bands in our Python-generated 4-band GeoTIFF: B04, B03, B02, B08 
        const mapIndices: Record<number, number> = {
          4: 0, // B04
          3: 1, // B03
          2: 2, // B02
          8: 3  // B08
        };
        const optionsWithMap = { ...DEFAULT_OPTIONS, bandMap: mapIndices };

        // Process geotiff with correct clipping bbox bounds
        const processedData = await processGeoTIFF(arrayBuffer, optionsWithMap, null);
        addVerboseLog(`[PythonMosaic] Decoded GeoTIFF for ${dateStr}. Dimensions: ${processedData.image.width}x${processedData.image.height}`);

        const absoluteTifUrl = tifUrl.startsWith('http') ? tifUrl : `${normalizedLocalUrl}${tifUrl.startsWith('/') ? '' : '/'}${tifUrl}`;

        const newLayer = createRasterLayer({
          name: `S2A_Mosaic_${dateStr}`,
          data: processedData,
          visible: i === 0, // Set the most recent date visible
          remoteUrls: {
            B04: absoluteTifUrl,
            B03: absoluteTifUrl,
            B02: absoluteTifUrl,
            B08: absoluteTifUrl
          } as any,
          remoteBbox: effectiveBbox,
          seriesId,
          datetime: `${dateStr}T00:00:00Z`
        });

        newLayers.push(newLayer);
      }

      setLayers(prev => [...newLayers, ...prev]);
      if (newLayers.length > 0) {
        setSelectedLayerId(newLayers[0].id);
      }
      setIsDrawingMode(false);
      addVerboseLog(`[PythonMosaic] SUCCESS! Loaded ${newLayers.length} daily Sentinel-2 mosaic layers.`);

    } catch (err: any) {
      logErrorDetails("Python mosaic query flow completely failed", err);
      const isFetchErr = err instanceof TypeError || (err?.message && (err.message.includes('fetch') || err.message.includes('NetworkError') || err.message.includes('Failed to fetch')));
      const errorMsg = isFetchErr
        ? `Could not connect to the Local Python Server at ${normalizeLocalUrl(localUrl)}.\n\nPlease ensure your local Python server is running on port 8080 (see "Local Python Server Mode" instructions in settings) or disable Local Python Server Mode to use standard browser-side processing.`
        : (err instanceof Error ? err.message : 'Failed to query local Python Mosaic Engine.');
      setError(errorMsg);
    } finally {
      setLoading(false);
      setIsFetchingSeries(false);
      setDownloadProgress(null);
    }
  };

  const fetchTimeSeries = async (fetchAllMatches: boolean = false) => {
    if (!searchBbox) {
      setError('Please select an area on the map first.');
      return;
    }
    if (!startDate || !endDate) {
      setError('Please specify both start and end dates.');
      return;
    }

    if (useLocalServer) {
      await fetchFromPythonServer(searchBbox);
      return;
    }

    setIsFetchingSeries(true);
    setError(null);
    setVerboseLogs([]);
    addVerboseLog(`Starting Time Series Fetch. Date Range: ${startDate} to ${endDate}. Cloud Cover limit: ${maxCloudCover}%. Target count: ${targetCount}`);
    try {
      // 1. Shared pipeline: chunked search -> dedupe -> group-by-date -> evenly spaced
      const dedupedAllResults = await searchSentinel2Chunked(searchBbox, startDate, endDate, maxCloudCover, mpcToken, {
        onChunkStart: (i, n, intervalStart, intervalEnd) =>
          addVerboseLog(`Searching STAC for interval ${i + 1}/${n}: [${intervalStart.split('T')[0]} to ${intervalEnd.split('T')[0]}]...`),
        onChunkResult: (i, n, count) =>
          addVerboseLog(`Interval ${i + 1}/${n} returned ${count} matches.`),
        onChunkError: (i, err) =>
          logErrorDetails(`Error fetching interval ${i}`, err),
      });

      if (dedupedAllResults.length === 0) {
        throw new Error('No images found for the selected area and criteria.');
      }
      addVerboseLog(`Found ${dedupedAllResults.length} deduplicated items across all search intervals.`);

      const uniqueResults = groupItemsByDate(dedupedAllResults);
      addVerboseLog(`Grouped into ${uniqueResults.length} unique daily passes.`);

      // 2. Select items
      const selectedItems: STACItem[] = fetchAllMatches
        ? [...uniqueResults]
        : selectEvenlySpaced(uniqueResults, targetCount);
      addVerboseLog(`Selected ${selectedItems.length} candidate passes to keep timeline evenly-distributed.`);

      // Filter out items that are already downloaded
      const itemsToFetch = selectedItems.filter(item => 
        !layers.some(l => l.type === 'raster' && l.stacItem?.id === item.id)
      );

      if (selectedItems.length > 0 && itemsToFetch.length === 0) {
        setError('All selected images within this time range are already in the timeline.');
        setIsFetchingSeries(false);
        return;
      }

      addVerboseLog(`Filtered down to ${itemsToFetch.length} new items to actually download/process.`);

      // 3. Fetch each item
      const seriesId = crypto.randomUUID();
      setFetchProgress({ current: 0, total: itemsToFetch.length });
      
      const newLayers: RasterLayer[] = [];
      // Fetch sequentially to speed up the time series retrieval without hitting connection limits
      const CHUNK_SIZE = 1;
      addVerboseLog(`Processing ${itemsToFetch.length} STAC scenes sequentially...`);
      for (let i = 0; i < itemsToFetch.length; i += CHUNK_SIZE) {
        const chunk = itemsToFetch.slice(i, i + CHUNK_SIZE);
        const chunkResults = await Promise.all(chunk.map(async (item, idx) => {
          const absoluteIdx = i + idx;
          addVerboseLog(`\n--- [Scene ${absoluteIdx + 1}/${itemsToFetch.length}] Date: ${item.properties.datetime.split('T')[0]} | ID: ${item.id} ---`);
          try {
            const layer = await createLayerFromSTACItem(item, absoluteIdx === 0, seriesId);
            addVerboseLog(`[Scene ${absoluteIdx + 1}/${itemsToFetch.length}] SUCCESS! Created merged layer ${layer.name}`);
            return layer;
          } catch (e) {
            logErrorDetails(`Failed to fetch item ${absoluteIdx} in series (Date: ${item.properties.datetime.split('T')[0]}, ID: ${item.id})`, e);
            throw e;
          }
        }));
        
        for (const res of chunkResults) {
          if (res) newLayers.push(res);
        }
        
        setFetchProgress({ current: Math.min(i + CHUNK_SIZE, itemsToFetch.length), total: itemsToFetch.length });
      }

      if (newLayers.length === 0) {
        throw new Error('Failed to fetch any images in the time series.');
      }

      // Add all new layers, keeping previous layers so multiple timelines can exist
      setLayers(prev => [...newLayers, ...prev]);
      setSelectedLayerId(newLayers[0].id);
      setIsDrawingMode(false);
      
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to fetch time series.');
    } finally {
      setIsFetchingSeries(false);
      setFetchProgress(null);
    }
  };

  const processFile = useCallback(async (file: File, isVisible: boolean = true, seriesId?: string) => {
    const isTiff = file.name.toLowerCase().endsWith('.tif') || file.name.toLowerCase().endsWith('.tiff');
    const isZip = file.name.toLowerCase().endsWith('.zip');

    if (!isTiff && !isZip) {
      setError('Please upload a valid .tif, .tiff or .zip (shapefile) file.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (isTiff) {
        const bboxToUse = globalCropBboxRef.current || null;
        const processedData = await processGeoTIFF(file, DEFAULT_OPTIONS, bboxToUse);
        const datetime = extractDateFromFilename(file.name);

        let actualClipBbox = undefined;
        if (bboxToUse && processedData.metadata.imageBbox) {
          const overlap = getBboxIntersectionArea(bboxToUse, processedData.metadata.imageBbox);
          if (overlap > 0) {
            actualClipBbox = bboxToUse;
          }
        }

        const newLayer = createRasterLayer({
          name: file.name,
          data: processedData,
          visible: isVisible,
          originalSource: file,
          datetime: datetime,
          clipBbox: actualClipBbox,
          seriesId: datetime ? seriesId : undefined
        });
        setLayers(prev => [newLayer, ...prev]);
        setSelectedLayerId(newLayer.id);
      } else if (isZip) {
        const buffer = await file.arrayBuffer();
        const geojson = await shp(buffer);
        const newLayer = createVectorLayer(file.name, geojson, crypto.randomUUID(), { visible: isVisible, opacity: 0.8 });
        setLayers(prev => [newLayer, ...prev]);
        setSelectedLayerId(newLayer.id);
      }
    } catch (err) {
      console.error(err);
      setError('Failed to process file. Ensure it is a valid GeoTIFF or zipped Shapefile.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      const seriesId = crypto.randomUUID();
      for (let i = 0; i < files.length; i++) {
        await processFile(files[i], i === files.length - 1, seriesId);
      }
    }
    // Reset the input value so the same folder/files can be selected again
    event.target.value = '';
  }, [processFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files) {
      const seriesId = crypto.randomUUID();
      for (let i = 0; i < files.length; i++) {
        await processFile(files[i], i === files.length - 1, seriesId);
      }
    }
  }, [processFile]);

  // Re-process raster layer when its options or clip change
  const reprocessLayer = useCallback(async (layerId: string, options: RenderingOptions, showLoading: boolean = true, clipBbox?: [number, number, number, number] | null) => {
    const layer = layers.find(l => l.id === layerId);
    if (layer && layer.type === 'raster') {
      const targetBbox = clipBbox !== undefined ? clipBbox : layer.clipBbox;
      console.log('Reprocessing layer options:', options, 'clipBbox:', targetBbox);
      setError(null);
      if (showLoading) setLoading(true);
      try {
        let processedData: GeoTIFFData;
        
        if (layer.remoteUrls && layer.remoteBbox) {
          console.log('Reprocessing remote layer:', layer.name);
          
          // For remote layers, we always re-fetch if the bbox changes to get higher resolution
          const bboxChanged = JSON.stringify(targetBbox) !== JSON.stringify(layer.clipBbox);
          
          if (layer.data.bandData && !bboxChanged) {
            console.log('Using cached band data, checking for missing bands');
            
            // Check if required bands are in cache
            const requiredBands = options.mode === 'rgb' ? [getAssetKey(options.bands[0]), getAssetKey(options.bands[1]), getAssetKey(options.bands[2])] : 
                                 options.mode === 'single' ? [getAssetKey(options.singleBand)] : 
                                 [getAssetKey(options.indexBands.red), getAssetKey(options.indexBands.green), getAssetKey(options.indexBands.blue), getAssetKey(options.indexBands.nir)];
            
            const missingBands = requiredBands.filter(band => !layer.data.bandData![band]);
            
            if (missingBands.length === 0) {
              console.log('All required bands in cache');
              processedData = await processRemoteGeoTIFF({}, targetBbox || layer.remoteBbox, options, layer.data.bandData, layer.data.metadata);
              
              setLayers(prev => prev.map(l => 
                l.id === layerId ? { ...l, data: processedData, dataUrl: processedData.image.toDataURL(), options, clipBbox: targetBbox } as RasterLayer : l
              ));
              return; // Exit early since we've already updated the layer
            } else {
              console.log('Missing bands in cache, fetching:', missingBands);
              
              // Construct signedUrls for missing bands
              let signedUrls: Record<string, string> = {};
              if (layer.stacItem) {
                const signedItem = await signSTACItem(layer.stacItem, mpcToken);
                const assets = signedItem.assets;
                
                missingBands.forEach(band => {
                  signedUrls[band] = assets[band]?.href || '';
                });
              } else {
                const remoteUrls = layer.remoteUrls as Record<string, string>;
                for (const band of missingBands) {
                  if (remoteUrls[band]) {
                    const baseUrl = remoteUrls[band].split('?')[0];
                    signedUrls[band] = await signUrl(baseUrl, mpcToken);
                  }
                }
              }
              
              // Update layer with new signed URLs
              const updatedRemoteUrls = { ...layer.remoteUrls, ...signedUrls };
              processedData = await processRemoteGeoTIFF(signedUrls, targetBbox || layer.remoteBbox, options, layer.data.bandData, layer.data.metadata);
              
              // Update layer with new signed URLs
              setLayers(prev => prev.map(l => 
                l.id === layerId ? { ...l, data: processedData, dataUrl: processedData.image.toDataURL(), options, remoteUrls: updatedRemoteUrls, clipBbox: targetBbox } as RasterLayer : l
              ));
              return; // Exit early since we've already updated the layer
            }
          } else {
            // Re-sign URLs in case they expired or bbox changed
            let signedUrls: Record<string, string> = {};
            
            if (layer.stacItem) {
              // Use the more reliable STAC item signing
              const signedItem = await signSTACItem(layer.stacItem, mpcToken);
              const assets = signedItem.assets;

              // Always fetch all necessary bands for all modes so switching works
              signedUrls = {
                [getAssetKey(options.bands[0])]: assets[getAssetKey(options.bands[0])]?.href || assets.B04?.href || '',
                [getAssetKey(options.bands[1])]: assets[getAssetKey(options.bands[1])]?.href || assets.B03?.href || '',
                [getAssetKey(options.bands[2])]: assets[getAssetKey(options.bands[2])]?.href || assets.B02?.href || '',
                [getAssetKey(options.indexBands.nir)]: assets[getAssetKey(options.indexBands.nir)]?.href || assets.B08?.href || assets.B8A?.href || '',
                [getAssetKey(options.singleBand)]: assets[getAssetKey(options.singleBand)]?.href || assets.B04?.href || ''
              };
            } else {
              // Fallback to individual signing
              const remoteUrls = layer.remoteUrls as Record<string, string>;
              for (const [name, url] of Object.entries(remoteUrls)) {
                if (typeof url === 'string') {
                  // Strip existing SAS token if present before re-signing
                  const baseUrl = url.split('?')[0];
                  signedUrls[name] = await signUrl(baseUrl, mpcToken);
                }
              }
            }
            
            // Check if at least one URL is signed
            const isSigned = Object.values(signedUrls).some(url => url.includes('?'));
            if (!isSigned) {
              throw new Error('Failed to re-sign image URLs. This usually means the SAS tokens have expired and the signing service is currently unavailable or requires an API key.');
            }
            
            console.log('Re-signed URLs for reprocessing:', signedUrls);
            processedData = await processRemoteGeoTIFF(signedUrls, targetBbox || layer.remoteBbox, options, undefined, layer.data.metadata);
            
            // Keep all original remoteUrls, just update the ones we re-signed
            const updatedRemoteUrls = { ...layer.remoteUrls, ...signedUrls };
            
            setLayers(prev => prev.map(l => 
              l.id === layerId ? { ...l, data: processedData, dataUrl: processedData.image.toDataURL(), options, remoteUrls: updatedRemoteUrls, clipBbox: targetBbox } as RasterLayer : l
            ));
          }
        } else if (layer.originalSource || layer.originalBuffer) {
          console.log('Reprocessing local layer:', layer.name);
          processedData = await processGeoTIFF(layer.originalSource || layer.originalBuffer, options, targetBbox);
          setLayers(prev => prev.map(l => 
            l.id === layerId ? { ...l, data: processedData, dataUrl: processedData.image.toDataURL(), options, clipBbox: targetBbox } as RasterLayer : l
          ));
        }
      } catch (err) {
        console.error('Error reprocessing layer:', err);
        setError(err instanceof Error ? err.message : 'Failed to re-process raster layer.');
      } finally {
        if (showLoading) setLoading(false);
      }
    }
  }, [layers, mpcToken]);

  const updateLayerOptions = async (layerId: string, newOptions: Partial<RenderingOptions>) => {
    console.log('Updating layer options:', layerId, newOptions);
    const layer = layers.find(l => l.id === layerId);
    if (layer && layer.type === 'raster') {
      const updatedOptions = { ...layer.options, ...newOptions };
      console.log('Updated options:', updatedOptions);
      // Reprocess if it's not just opacity
      const needsReprocess = Object.keys(newOptions).some(key => key !== 'opacity');
      
      if (needsReprocess) {
        // Sync across all raster layers
        const rasterLayers = layers.filter(l => l.type === 'raster');
        setLoading(true);
        try {
          for (const l of rasterLayers) {
            await reprocessLayer(l.id, { ...l.options, ...newOptions }, false);
          }
        } finally {
          setLoading(false);
        }
      } else {
        setLayers(prev => prev.map(l => 
          (l.type === 'raster') ? { ...l, options: { ...l.options, ...newOptions }, opacity: newOptions.opacity ?? l.opacity } as RasterLayer : l
        ));
      }
    }
  };

  const toggleVisibility = (id: string) => {
    setLayers(prev => prev.map(l => 
      l.id === id ? { ...l, visible: !l.visible } : l
    ));
  };

  const removeLayer = (id: string) => {
    const layerToRemove = layers.find(l => l.id === id);
    if (!layerToRemove) return;

    const dateToRemove = (layerToRemove as any).datetime?.split('T')[0];

    // Find next selection BEFORE setting state if it's the current selection
    let nextId: string | null = null;
    if (selectedLayerId === id) {
      const seriesId = (layerToRemove as any).seriesId;
      if (seriesId) {
        const seriesLayers = layers
          .filter(l => l.type === 'raster' && l.seriesId === seriesId && l.datetime)
          .sort((a, b) => new Date(a.datetime!).getTime() - new Date(b.datetime!).getTime());
        
        const currentIndex = seriesLayers.findIndex(l => l.id === id);
        const remaining = seriesLayers.filter(l => l.id !== id);
        
        if (remaining.length > 0) {
          const targetIdx = Math.max(0, Math.min(currentIndex, remaining.length - 1));
          nextId = remaining[targetIdx].id;
        }
      }
    }

    setLayers(prev => {
      // 1. Remove the layer itself
      let next = prev.filter(l => l.id !== id);
      
      // 2. Clean up vector properties for this date if it was a timed layer
      if (dateToRemove) {
        next = next.map(l => {
          if (l.type !== 'vector' || !l.data || !l.data.features) return l;
          return { ...l, data: { ...l.data, features: removeDateProperties(l.data.features, dateToRemove) } };
        });
      }

      // 3. Ensure the next layer is visible if we are auto-switching
      if (nextId) {
        next = next.map(l => l.id === nextId ? { ...l, visible: true } : l);
      }
      
      return next;
    });

    if (selectedLayerId === id) {
      setSelectedLayerId(nextId);
    }
  };

  const generateMajaMetadataXML = (
    layer: RasterLayer, 
    item: any,
    cropInfo10m: { width: number, height: number, ulx: number, uly: number } | null = null,
    cropInfo20m: { width: number, height: number, ulx: number, uly: number } | null = null
  ) => {
    const props = item.properties;
    
    // Try to get projection info from assets if not in properties
    const b02Asset = item.assets.B02 || item.assets.B04 || Object.values(item.assets)[0];
    const epsg = props['proj:epsg'] || b02Asset?.['proj:epsg'] || 32631;
    const shape = props['proj:shape'] || b02Asset?.['proj:shape'] || [10980, 10980];
    const transform = props['proj:transform'] || b02Asset?.['proj:transform'] || [10, 0, 300000, 0, -10, 5000000];

    const cloudPercent = props['eo:cloud_cover'] || 0;
    const orbitNumber = props['sat:relative_orbit'] || 0;
    const crsName = layer.data.metadata.crs || `WGS 84 / UTM zone ${epsg % 100}N`;
    
    const nrows10 = cropInfo10m ? cropInfo10m.height : shape[0];
    const ncols10 = cropInfo10m ? cropInfo10m.width : shape[1];
    const nrows20 = cropInfo20m ? cropInfo20m.height : Math.floor(nrows10 / 2);
    const ncols20 = cropInfo20m ? cropInfo20m.width : Math.floor(ncols10 / 2);
    
    const ulx10 = cropInfo10m ? cropInfo10m.ulx : transform[2];
    const uly10 = cropInfo10m ? cropInfo10m.uly : transform[5];
    
    const ulx20 = cropInfo20m ? cropInfo20m.ulx : transform[2];
    const uly20 = cropInfo20m ? cropInfo20m.uly : transform[5];

    const sunZenith = 90 - (props['view:sun_elevation'] || 45);
    const sunAzimuth = props['view:sun_azimuth'] || 180;
    
    const viewZenith = props['view:incidence_angle'] || 0;
    const viewAzimuth = props['view:azimuth'] || 0;

    const sunZenithValues = sunZenith.toFixed(6);
    const sunAzimuthValues = sunAzimuth.toFixed(6);
    const viewZenithValues = viewZenith.toFixed(6);
    const viewAzimuthValues = viewAzimuth.toFixed(6);

    return `<?xml version="1.0" encoding="UTF-8"?>
<Level-2A_Product>
  <General_Info>
    <Product_Info>
      <PRODUCT_URI>${item.id}</PRODUCT_URI>
      <PROCESSING_LEVEL>L2A</PROCESSING_LEVEL>
    </Product_Info>
    <QUALITY_INDEX name="CloudPercent">${cloudPercent}</QUALITY_INDEX>
    <ORBIT_NUMBER>${orbitNumber}</ORBIT_NUMBER>
  </General_Info>
  <Geometric_Info>
    <Tile_Geocoding>
      <HORIZONTAL_CS_NAME>${crsName}</HORIZONTAL_CS_NAME>
      <HORIZONTAL_CS_CODE>EPSG:${epsg}</HORIZONTAL_CS_CODE>
      <Size resolution="10">
        <NROWS>${nrows10}</NROWS>
        <NCOLS>${ncols10}</NCOLS>
      </Size>
      <Size resolution="20">
        <NROWS>${nrows20}</NROWS>
        <NCOLS>${ncols20}</NCOLS>
      </Size>
      <Geoposition resolution="10">
        <ULX>${ulx10}</ULX>
        <ULY>${uly10}</ULY>
        <XDIM>10</XDIM>
        <YDIM>-10</YDIM>
      </Geoposition>
      <Geoposition resolution="20">
        <ULX>${ulx20}</ULX>
        <ULY>${uly20}</ULY>
        <XDIM>20</XDIM>
        <YDIM>-20</YDIM>
      </Geoposition>
    </Tile_Geocoding>
  </Geometric_Info>
  <Radiometric_Info>
    <Reflectance_Conversion>
      <QUANTIFICATION_VALUE>10000</QUANTIFICATION_VALUE>
    </Reflectance_Conversion>
  </Radiometric_Info>
  <Angles_Grids_List>
    <Sun_Angles_Grids>
      <Zenith>
        <Values_List>
          <VALUES>${sunZenithValues}</VALUES>
        </Values_List>
      </Zenith>
      <Azimuth>
        <Values_List>
          <VALUES>${sunAzimuthValues}</VALUES>
        </Values_List>
      </Azimuth>
    </Sun_Angles_Grids>
    <Viewing_Incidence_Angles_Grids_List>
      ${['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B8A', 'B11', 'B12'].map(band => `
      <Band_Viewing_Incidence_Angles_Grids band_id="${band}">
        <Viewing_Incidence_Angles_Grids detector_id="1">
          <Zenith>
            <Values_List>
              <VALUES>${viewZenithValues}</VALUES>
            </Values_List>
          </Zenith>
          <Azimuth>
            <Values_List>
              <VALUES>${viewAzimuthValues}</VALUES>
            </Values_List>
          </Azimuth>
        </Viewing_Incidence_Angles_Grids>
      </Band_Viewing_Incidence_Angles_Grids>`).join('')}
    </Viewing_Incidence_Angles_Grids_List>
  </Angles_Grids_List>
</Level-2A_Product>`;
  };

  const [downloadOptions, setDownloadOptions] = useState<{
    layers: RasterLayer[];
    cropSize: { width: number; height: number };
  } | null>(null);

  const calculateCropPixelSize = (layer: RasterLayer) => {
    return {
      width: layer.data.metadata.width,
      height: layer.data.metadata.height
    };
  };

  const downloadLayers = async (layersToDownload: RasterLayer[], size: string = 'full') => {
    console.log('downloadLayers called for:', layersToDownload.length, 'layers, size:', size);
    
    const validLayers = layersToDownload.filter(l => l.stacItem);
    if (validLayers.length === 0) {
      setError('No layers have original STAC metadata for download.');
      return;
    }
    
    setLoading(true);
    setDownloadOptions(null);
    
    const isFull = size === 'full';
    const bandsToDownload = ['B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B11', 'B12'];
    
    setDownloadProgress({ 
      current: 0, 
      total: validLayers.length * (bandsToDownload.length + 1), 
      status: 'Initializing download...',
      bytesDownloaded: 0,
      totalBytes: 0
    });
    
    try {
      const zip = new JSZip();
      
      let totalEstimatedBytes = 0;
      let totalDownloaded = 0;
      
      if (isFull) {
        setDownloadProgress(prev => prev ? { ...prev, status: 'Estimating download size...' } : null);
        for (const layer of validLayers) {
          const signedItem = await signSTACItem(layer.stacItem!, mpcToken);
          const assets = signedItem.assets;
          await Promise.all(bandsToDownload.map(async (key) => {
            const asset = assets[key];
            if (asset?.href) {
              try {
                const head = await fetch(asset.href, { method: 'HEAD' });
                const size = parseInt(head.headers.get('content-length') || '0');
                totalEstimatedBytes += size;
              } catch (e) {}
            }
          }));
        }
        setDownloadProgress(prev => prev ? { ...prev, totalBytes: totalEstimatedBytes } : null);
      }

      let currentProgress = 0;

      for (const layer of validLayers) {
        setDownloadProgress(prev => prev ? { ...prev, status: `Re-signing STAC item for ${layer.name}...` } : null);
        const signedItem = await signSTACItem(layer.stacItem!, mpcToken);
        const assets = signedItem.assets;
        
        const date = new Date(signedItem.properties.datetime);
        const datePart = format(date, 'yyyyMMdd-HHmmss-SSS');
        const tileId = signedItem.properties['s2:mgrs_tile'] || 'UNKNOWN';
        const platform = signedItem.properties.platform?.toUpperCase().replace('-', '') || 'SENTINEL2A';
        const baseName = `${platform}_${datePart}_L2A_${tileId}_C_V2-2`;
        
        const folder = zip.folder(baseName);
        if (!folder) throw new Error('Failed to create ZIP folder');
        
        const imgDataFolder = folder.folder('IMG_DATA');
        if (!imgDataFolder) throw new Error('Failed to create IMG_DATA folder');
        
        // 1. Determine BBox and Dimensions for Crop
        let downloadBbox = layer.remoteBbox;
        let targetWidth = layer.data.metadata.originalWidth || layer.data.metadata.width;
        let targetHeight = layer.data.metadata.originalHeight || layer.data.metadata.height;

        if (!isFull) {
          const baseBbox = layer.clipBbox || layer.remoteBbox;
          if (!baseBbox) throw new Error('No BBox available for cropping');
          
          const centerLng = (baseBbox[0] + baseBbox[2]) / 2;
          const centerLat = (baseBbox[1] + baseBbox[3]) / 2;
          
          const fullWidth = layer.data.metadata.originalWidth || layer.data.metadata.width;
          const fullHeight = layer.data.metadata.originalHeight || layer.data.metadata.height;
          
          let fullLngRange, fullLatRange;
          if (layer.stacItem && layer.stacItem.bbox) {
            fullLngRange = Math.abs(layer.stacItem.bbox[2] - layer.stacItem.bbox[0]);
            fullLatRange = Math.abs(layer.stacItem.bbox[3] - layer.stacItem.bbox[1]);
          } else {
            fullLngRange = Math.abs(layer.remoteBbox![2] - layer.remoteBbox![0]);
            fullLatRange = Math.abs(layer.remoteBbox![3] - layer.remoteBbox![1]);
          }
          
          const degPerPixelX = fullLngRange / fullWidth;
          const degPerPixelY = fullLatRange / fullHeight;

          if (size === 'crop') {
            const cropSize = calculateCropPixelSize(layer);
            if (cropSize) {
              targetWidth = cropSize.width;
              targetHeight = cropSize.height;
              downloadBbox = baseBbox;
            }
          } else {
            const pixelSize = parseInt(size);
            targetWidth = pixelSize;
            targetHeight = pixelSize;
            
            const halfWidthDeg = (pixelSize * degPerPixelX) / 2;
            const halfHeightDeg = (pixelSize * degPerPixelY) / 2;
            
            downloadBbox = [
              centerLng - halfWidthDeg,
              centerLat - halfHeightDeg,
              centerLng + halfWidthDeg,
              centerLat + halfHeightDeg
            ];
          }
        }

        let cropInfo10m: { width: number, height: number, ulx: number, uly: number } | null = null;
        let cropInfo20m: { width: number, height: number, ulx: number, uly: number } | null = null;

        for (const bandKey of bandsToDownload) {
          const asset = assets[bandKey];
          if (asset?.href) {
            try {
              const bandNum = bandKey.replace('B0', 'B');
              setDownloadProgress(prev => prev ? { ...prev, status: `Downloading ${bandKey} for ${layer.name}...` } : null);
              
              if (isFull) {
                const response = await fetch(asset.href);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                
                const reader = response.body?.getReader();
                if (!reader) throw new Error('Failed to get stream reader');
                
                const chunks: Uint8Array[] = [];
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  chunks.push(value);
                  totalDownloaded += value.length;
                  setDownloadProgress(prev => prev ? { 
                    ...prev, 
                    bytesDownloaded: totalDownloaded,
                    status: `Downloading ${bandNum} (${Math.round(totalDownloaded / 1024 / 1024)}MB / ${Math.round(totalEstimatedBytes / 1024 / 1024)}MB)`
                  } : null);
                }
                
                const blob = new Blob(chunks);
                imgDataFolder.file(`${baseName}_FRE_${bandNum}.tif`, blob);
              } else {
                // Cropped download: fetch data and convert to GeoTIFF
                let currentTargetWidth = targetWidth;
                let currentTargetHeight = targetHeight;
                
                if (size !== 'crop') {
                  const bandRes20m = ['B05', 'B06', 'B07', 'B8A', 'B11', 'B12'];
                  const bandRes60m = ['B01', 'B09', 'B10'];
                  
                  if (bandRes20m.includes(bandKey)) {
                    currentTargetWidth = Math.max(1, Math.round(targetWidth / 2));
                    currentTargetHeight = Math.max(1, Math.round(targetHeight / 2));
                  } else if (bandRes60m.includes(bandKey)) {
                    currentTargetWidth = Math.max(1, Math.round(targetWidth / 6));
                    currentTargetHeight = Math.max(1, Math.round(targetHeight / 6));
                  }
                }

                const result = await fetchRemoteBand(
                  asset.href,
                  downloadBbox!,
                  currentTargetWidth,
                  currentTargetHeight,
                  layer.data.metadata.crs || 'EPSG:4326',
                  layer.data.metadata.imageBbox || layer.data.imageBbox!,
                  layer.data.metadata.originalWidth || layer.data.metadata.width,
                  layer.data.metadata.originalHeight || layer.data.metadata.height,
                  size === 'crop'
                );
                
                if (['B02', 'B03', 'B04', 'B08'].includes(bandKey)) {
                  if (!cropInfo10m) cropInfo10m = { width: result.width, height: result.height, ulx: result.tiepoint[3], uly: result.tiepoint[4] };
                } else if (['B05', 'B06', 'B07', 'B8A', 'B11', 'B12'].includes(bandKey)) {
                  if (!cropInfo20m) cropInfo20m = { width: result.width, height: result.height, ulx: result.tiepoint[3], uly: result.tiepoint[4] };
                }

                const tifBlob = rasterToGeotiffBlob(result.data, result.width, result.height, {
                  pixelScale: result.pixelScale,
                  tiepoint: result.tiepoint,
                  geoKeys: result.geoKeys,
                  geoDoubleParams: result.geoDoubleParams,
                  geoAsciiParams: result.geoAsciiParams
                });
                imgDataFolder.file(`${baseName}_${bandNum}.tif`, tifBlob);
              }
              
              currentProgress++;
              setDownloadProgress(prev => prev ? { ...prev, current: currentProgress } : null);
            } catch (e) {
              console.error(`Error downloading band ${bandKey}:`, e);
            }
          }
        }
        
        // 2. Metadata XML (Custom MAJA L2A format for sensorsio)
        setDownloadProgress(prev => prev ? { ...prev, status: `Generating metadata XML for ${layer.name}...` } : null);
        const xmlContent = generateMajaMetadataXML(layer, signedItem, cropInfo10m, cropInfo20m);
        folder.file(`${baseName}_MTD_ALL.xml`, xmlContent);
        currentProgress++;
        setDownloadProgress(prev => prev ? { ...prev, current: currentProgress, status: 'Metadata generated' } : null);
      }

      setDownloadProgress(prev => prev ? { ...prev, status: 'Generating ZIP archive (fast mode)...' } : null);
      const content = await zip.generateAsync({ 
        type: 'blob',
        compression: 'STORE' 
      });
      
      setDownloadProgress(prev => prev ? { ...prev, status: 'Finalizing download...' } : null);
      
      const zipName = validLayers.length === 1 
        ? `${validLayers[0].name.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`
        : `Sentinel2_TimeSeries_${format(new Date(), 'yyyyMMdd-HHmmss')}.zip`;
        
      saveAs(content, zipName);
    } catch (err) {
      console.error('Error downloading layer(s):', err);
      setError(`Failed to download image package: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
      setDownloadProgress(null);
    }
  };

  const updateIndexBand = (layerId: string, key: keyof RenderingOptions['indexBands'], value: number) => {
    const layer = layers.find(l => l.id === layerId);
    if (layer && layer.type === 'raster') {
      updateLayerOptions(layerId, {
        indexBands: { ...layer.options.indexBands, [key]: value }
      });
    }
  };

  const toggleLayerCrop = (layerId: string) => {
    const layer = layers.find(l => l.id === layerId);
    if (!layer || layer.type !== 'raster') return;

    const newClipBbox = layer.clipBbox ? null : (searchBbox ? [...searchBbox] as [number, number, number, number] : null);
    reprocessLayer(layerId, layer.options, true, newClipBbox);
  };

  const handleExportPixelTable = async (rasterLayer: RasterLayer) => {
    const vectorLayer = layers.find(l => l.type === 'vector' && l.visible && l.data) as VectorLayer;
    if (!vectorLayer) {
      setError("Please ensure a Shapefile layer is loaded and visible to perform extraction.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const csv = await extractZonalPixels(rasterLayer.data, vectorLayer.data);
      setExtractionResult({ csv, layerName: rasterLayer.name });
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to export pixel table.');
    } finally {
      setLoading(false);
    }
  };

  const moveLayer = (id: string, direction: 'up' | 'down') => {
    const index = layers.findIndex(l => l.id === id);
    if (index === -1) return;
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === layers.length - 1) return;

    const newLayers = [...layers];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    [newLayers[index], newLayers[targetIndex]] = [newLayers[targetIndex], newLayers[index]];
    setLayers(newLayers);
  };

  const handleAddVectorLayer = useCallback((name: string, geojson: any, id?: string) => {
    const newLayer = createVectorLayer(name, geojson, id);
    setLayers(prev => {
      const idx = prev.findIndex(l => l.id === newLayer.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = newLayer;
        return next;
      }
      return [newLayer, ...prev];
    });

    if (isPixelsLayer(newLayer)) {
      setTimeout(() => setSelectedVectorLayer(newLayer), 50);
    }
  }, []);

  const handleRemoveFeature = useCallback((layerId: string, featureId: string) => {
    setLayers(prev => prev.map(l => {
      if (l.id !== layerId || l.type !== 'vector' || !l.data || !l.data.features) return l;
      
      const newFeatures = l.data.features.filter((f: any) => {
        const fId = f.id || f.properties?.id;
        return fId !== featureId;
      });
      
      return { ...l, data: { ...l.data, features: newFeatures } };
    }));
    
    setSelectedVectorFeature(null);
    setSelectedVectorLayer(null);
  }, []);

  const handleUpdateTimeline = async () => {
    const targetFeature = selectedVectorFeature;
    const allRasters = layers.filter(l => l.type === 'raster' && l.datetime) as RasterLayer[];
    
    if (!targetFeature || allRasters.length === 0) {
      if (!targetFeature) setError("Please select a parcel on the map first.");
      else if (allRasters.length === 0) setError("No images available to extract data from.");
      return;
    }
    
    setIsExtractingTimeline(true);
    try {
      // Find the "root" feature ID. If this is a pixel from a previous extraction, 
      // it might have an ID like "pixel_x_y". We should look for the original parcel if possible,
      // but if not, we use the current selection.
      let featureId = targetFeature.id || targetFeature.properties?.id;
      
      // Default to NDVI, 0m buffer for sidebar quick update
      const { pixelPoints } = await extractPixelTimeseriesOptions(targetFeature, allRasters, 0, 'NDVI');
      
      if (pixelPoints && pixelPoints.features && pixelPoints.features.length > 0) {
        // If we are currently viewing a pixel layer, try to reuse its ID
        const currentPixelLayer = layers.find(l =>
          (l.id === pixelsLayerId(featureId) || (selectedVectorLayer?.id === l.id && isPixelsLayer(l)))
        );
        const targetId = currentPixelLayer?.id || pixelsLayerId(featureId);

        const nameAttr = getFeatureDisplayName(targetFeature) || featureId || 'Field';
        handleAddVectorLayer(formatPixelsLayerName('NDVI', nameAttr), pixelPoints, targetId);
        
        // Auto-select the latest raster image if available
        const latestRaster = [...allRasters].sort((a,b) => 
          new Date(b.datetime!).getTime() - new Date(a.datetime!).getTime()
        )[0];
        if (latestRaster) {
          setSelectedLayerId(latestRaster.id);
        }
      }
    } catch (e) {
      console.error("Timeline extraction failed:", e);
      setError("Failed to update time series data.");
    } finally {
      setIsExtractingTimeline(false);
    }
  };

  return (
    <div 
      className="min-h-screen bg-[#050505] text-white font-sans selection:bg-orange-500/30"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag Overlay */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] bg-orange-500/10 backdrop-blur-md border-4 border-dashed border-orange-500/50 m-4 rounded-3xl flex flex-col items-center justify-center pointer-events-none"
          >
            <div className="p-6 bg-orange-500 rounded-full shadow-2xl shadow-orange-500/50 mb-6">
              <Upload size={48} className="text-black animate-bounce" />
            </div>
            <h2 className="text-3xl font-bold tracking-tight text-white mb-2">Drop to Visualize</h2>
            <p className="text-white/60 font-medium">Supports .TIF, .TIFF and zipped Shapefiles</p>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Header */}
      {!isFullscreen && (
        <header className="fixed top-0 left-0 right-0 z-50 border-b border-white/5 bg-black/40 backdrop-blur-xl">
          <div className="w-full px-6 h-16 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-orange-500 rounded-lg flex items-center justify-center shadow-lg shadow-orange-500/20">
                <MapIcon size={18} className="text-black" />
              </div>
              <h1 className="text-lg font-semibold tracking-tight">GeoTIFF <span className="text-orange-500">Visualizer</span></h1>
            </div>
            
            <div className="flex items-center gap-4">
              <button 
                onClick={() => setShowPcaModal(true)}
                className="mr-2 flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-400 hover:to-purple-500 border border-purple-400/50 rounded-full transition-all active:scale-95 shadow-[0_0_20px_rgba(139,92,246,0.4)] hover:shadow-[0_0_30px_rgba(139,92,246,0.6)] text-white"
              >
                <BarChart3 size={16} className="text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
                <span className="text-sm font-bold tracking-wide drop-shadow-[0_0_5px_rgba(0,0,0,0.5)]">Timeseries PCA</span>
              </button>

              <button 
                onClick={() => setShowLocalPythonServer(true)}
                className="mr-2 flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 border border-blue-400/50 rounded-full transition-all active:scale-95 shadow-[0_0_20px_rgba(59,130,246,0.4)] hover:shadow-[0_0_30px_rgba(59,130,246,0.6)] text-white"
              >
                <Database size={16} className="text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
                <span className="text-sm font-bold tracking-wide drop-shadow-[0_0_5px_rgba(0,0,0,0.5)]">Local SQL Server</span>
              </button>

              <button 
                onClick={() => setShowDocs(true)}
                className="mr-2 flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 border border-orange-400/50 rounded-full transition-all active:scale-95 shadow-[0_0_20px_rgba(249,115,22,0.4)] hover:shadow-[0_0_30px_rgba(249,115,22,0.6)] text-white"
              >
                <BookOpen size={16} className="text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
                <span className="text-sm font-bold tracking-wide drop-shadow-[0_0_5px_rgba(0,0,0,0.5)]">Documentation</span>
              </button>

              <label className="cursor-pointer group">
                <input type="file" accept=".tif,.tiff" multiple onChange={handleFileUpload} className="hidden" />
                <div className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full transition-all active:scale-95">
                  <Upload size={16} className="text-orange-500" />
                  <span className="text-sm font-medium">Upload TIF</span>
                </div>
              </label>

              <label className="cursor-pointer group">
                {/* @ts-ignore - webkitdirectory is non-standard but supported */}
                <input type="file" accept=".tif,.tiff" multiple webkitdirectory="" directory="" onChange={handleFileUpload} className="hidden" />
                <div className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full transition-all active:scale-95">
                  <Folder size={16} className="text-orange-500" />
                  <span className="text-sm font-medium">Upload Folder</span>
                </div>
              </label>
              
              <label className="cursor-pointer group">
                <input type="file" accept=".zip" multiple onChange={handleFileUpload} className="hidden" />
                <div className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full transition-all active:scale-95">
                  <Hexagon size={16} className="text-orange-500" />
                  <span className="text-sm font-medium">Upload SHP (.zip)</span>
                </div>
              </label>

              {layers.length > 0 && (
                <button 
                  onClick={() => {
                    const newLayers = layers.filter(l => l.type === 'vector');
                    setLayers(newLayers);
                    if (!newLayers.find(l => l.id === selectedLayerId)) {
                      setSelectedLayerId(null);
                    }
                  }}
                  className="p-2 hover:bg-white/5 rounded-full text-white/40 hover:text-white transition-colors"
                  title="Clear all layers"
                >
                  <X size={20} />
                </button>
              )}

              <div className="w-px h-6 bg-white/10 mx-2"></div>

              <button
                onClick={() => setShowResetConfirm(true)}
                className="flex items-center gap-2 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-full transition-all active:scale-95 text-red-500"
                title="Hard Reset"
              >
                <RotateCcw size={16} />
                <span className="text-sm font-medium">Reset</span>
              </button>

              <button
                onClick={toggleFullscreen}
                className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full transition-all active:scale-95 text-white"
                title="Enter Fullscreen"
              >
                <Maximize size={16} className="text-orange-500" />
                <span className="text-sm font-medium">Fullscreen</span>
              </button>
            </div>
          </div>
        </header>
      )}

      {showDocs && <DocumentationModal onClose={() => setShowDocs(false)} />}
      <PcaModal 
        isOpen={showPcaModal}
        onClose={() => setShowPcaModal(false)}
        layers={layers}
        setLayers={setLayers}
      />
      <LocalPythonServerModal 
        isOpen={showLocalPythonServer} 
        onClose={() => setShowLocalPythonServer(false)} 
        localUrl={localUrl}
        setLocalUrl={setLocalUrl}
        useLocalServer={useLocalServer}
        setUseLocalServer={setUseLocalServer}
        onAddVectorLayer={handleAddVectorLayer}
        onAddRemoteRasterLayer={async (url, name) => {
          setLoading(true);
          setError(null);
          try {
             // For single local file we can stream it dynamically!
             const bboxToUse = globalCropBboxRef.current || null;
             // processGeoTIFF now accepts a URL!
             const processedData = await processGeoTIFF(url, DEFAULT_OPTIONS, bboxToUse);
             const datetime = extractDateFromFilename(name);

             let actualClipBbox = undefined;
             if (bboxToUse && processedData.metadata.imageBbox) {
               const overlap = getBboxIntersectionArea(bboxToUse, processedData.metadata.imageBbox);
               if (overlap > 0) {
                 actualClipBbox = bboxToUse;
               }
             }

             const newLayer = createRasterLayer({
                name: name,
                data: processedData,
                originalSource: url,
                datetime: datetime,
                clipBbox: actualClipBbox
             });
             setLayers(prev => [newLayer, ...prev]);
             setSelectedLayerId(newLayer.id);
          } catch(err: any) {
             console.error(err);
             setError("Failed to load local GeoTIFF: " + err.message);
          } finally {
             setLoading(false);
          }
        }}
      />
      {isFullscreen && (
        <button
          onClick={toggleFullscreen}
          className="fixed top-6 right-6 z-[9999] p-3 bg-black/80 hover:bg-black backdrop-blur-md border border-white/20 rounded-full text-white shadow-2xl transition-all hover:scale-105 group"
          title="Exit Fullscreen"
        >
          <Minimize size={24} className="group-hover:text-orange-500 transition-colors" />
        </button>
      )}

      <main className={cn("px-6 w-full grid gap-6 h-screen transition-all duration-300 grid-cols-1 lg:grid-cols-[1fr_380px]", isFullscreen ? "pt-6 pb-6" : "pt-20 pb-6")}>
        {/* Map Section */}
        <div className="relative h-full min-h-[400px] flex flex-col">
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 flex flex-col items-center justify-center bg-black/20 backdrop-blur-sm z-50 rounded-xl"
              >
                <Loader2 className="w-12 h-12 text-orange-500 animate-spin mb-4" />
                  <p className="text-lg font-medium text-white/80">
                    {downloadProgress ? (downloadProgress.status || 'Downloading Image Package...') : 'Processing Data...'}
                  </p>
                  {downloadProgress ? (
                    <div className="mt-4 w-64">
                      <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden">
                        <motion.div 
                          className="h-full bg-orange-500"
                          initial={{ width: 0 }}
                          animate={{ width: downloadProgress.totalBytes ? `${(downloadProgress.bytesDownloaded! / downloadProgress.totalBytes) * 100}%` : `${(downloadProgress.current / downloadProgress.total) * 100}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-white/40 mt-2 text-center uppercase tracking-widest">
                        {downloadProgress.totalBytes 
                          ? `${Math.round(downloadProgress.bytesDownloaded! / 1024 / 1024)}MB / ${Math.round(downloadProgress.totalBytes / 1024 / 1024)}MB`
                          : `${downloadProgress.current} of ${downloadProgress.total} files processed`
                        }
                      </p>
                    </div>
                  ) : (
                  <p className="text-sm text-white/40 mt-2 italic">Updating rendering pipeline</p>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
          
          <div className="flex-1 relative rounded-xl overflow-hidden">
            <MapViewer 
              layers={layers} 
              selectedLayerId={selectedLayerId}
              onAreaSelected={(bbox) => {
                setSearchBbox(bbox);
                if (bbox && useLocalServer) {
                  fetchFromPythonServer(bbox);
                }
              }}
              onDrawingUpdate={setDrawingBbox}
              isDrawingMode={isDrawingMode}
              isPixelAnalysisMode={isPixelAnalysisMode}
              onPixelClick={(lat, lng) => {
                const pointFeature = {
                  type: 'Feature',
                  id: `point-${lat.toFixed(5)}-${lng.toFixed(5)}`,
                  geometry: { type: 'Point', coordinates: [lng, lat] },
                  properties: { id: `Point (${lat.toFixed(3)}, ${lng.toFixed(3)})`, lat, lng }
                };
                handleSelectVector(pointFeature);
                setIsPixelAnalysisMode(false); // Turn off mode after click
              }}
              searchBbox={searchBbox}
              filterByBbox={filterByBbox}
              selectedVectorFeature={selectedVectorFeature}
              onZoomChange={setMapZoom}
              onViewportChange={(b, z, c) => {
                setMapZoom(z);
                setMapCenter(c);
              }}
              initialCenter={mapCenter}
              onVectorClick={(f) => {
                handleSelectVector(f);
              }}
            />

            {(() => {
              const activeSeriesId = activeLayer?.seriesId;
              const seriesLayers = memoizedSeriesLayers;

              return (
                <>
                  {(selectedVectorFeature || selectedVectorLayer) && (
                    <VectorFeaturePanel
                      key={selectedVectorFeature?.id || selectedVectorLayer?.id || 'vector-panel'}
                      feature={selectedVectorFeature}
                      layer={selectedVectorLayer}
                      vectorLayers={layers.filter(l => l.type === 'vector')}
                      onClose={() => {
                        setSelectedVectorFeature(null);
                        setSelectedVectorLayer(null);
                      }}
                      seriesLayers={layers.filter(l => l.type === 'raster' && l.datetime).sort((a, b) => new Date(a.datetime!).getTime() - new Date(b.datetime!).getTime())}
                      onAddVectorLayer={handleAddVectorLayer}
                      onSetSearchBbox={(bbox) => {
                        setSearchBbox(bbox);
                        // zoom out a little to see the context
                        const zoom = mapZoom > 14 ? mapZoom : 14;
                        setMapZoom(zoom);
                        setMapCenter([(bbox[1] + bbox[3])/2, (bbox[0] + bbox[2])/2]);
                      }}
                      onSetSearchDates={(start, end) => {
                        setStartDate(start);
                        setEndDate(end);
                      }}
                      onFeatureSelect={(feature, layer) => {
                        setSelectedVectorFeature(feature);
                        setSelectedVectorLayer(layer);
                      }}
                       onDateClick={(dateStr) => {
                        // Find the raster layer that matches this date
                        let targetRaster = layers.find(l => l.type === 'raster' && l.datetime?.startsWith(dateStr));
                        if (targetRaster) {
                          setSelectedLayerId(targetRaster.id);
                          // Ensure ONLY the target raster is visible among raster layers to avoid layering issues
                          setLayers(prev => prev.map(l => {
                            if (l.id === targetRaster!.id) return { ...l, visible: true };
                            if (l.type === 'raster') return { ...l, visible: false };
                            return l;
                          }));
                        }
                      }}
                      onRemoveDate={(_vectorLayerId, dateToRemove) => {
                        // Find the raster layer that matches this date and series first, and remove it
                        // This will trigger the consolidated removeLayer logic which cleans up all vector layers
                        const activeSeriesId = activeLayer?.seriesId;
                        const targetRaster = layers.find(l => 
                          l.type === 'raster' && 
                          (activeSeriesId ? l.seriesId === activeSeriesId : true) &&
                          l.datetime && 
                          (l.datetime === dateToRemove || l.datetime.startsWith(dateToRemove + 'T') || l.datetime.startsWith(dateToRemove))
                        );
                        if (targetRaster) {
                          removeLayer(targetRaster.id);
                        } else {
                          // Fallback: If no image found, at least clean up the vector properties manually
                          setLayers(prev => prev.map(l => {
                            if (l.type !== 'vector' || !l.data || !l.data.features) return l;
                            return { ...l, data: { ...l.data, features: removeDateProperties(l.data.features, dateToRemove) } };
                          }));
                        }
                      }}
                      onRemoveFeature={handleRemoveFeature}
                      onExtractNDVI={async (feature) => {
                        if (seriesLayers.length < 3) {
                           setError("Please fetch a time series with at least 3 images first.");
                           return;
                        }
                        try {
                           const { computeNDVIPCA } = await import('./lib/pca-utils');
                           const pcaImageUrl = await computeNDVIPCA(seriesLayers as RasterLayer[]);

                           // Create a new layer with the PCA output
                           const pcaLayer = createRasterLayer({
                             name: 'PCA Species Map',
                             opacity: 1.0,
                             data: (seriesLayers[0] as RasterLayer).data, // Reuse base metadata for positioning
                             dataUrl: pcaImageUrl,
                             options: (seriesLayers[0] as RasterLayer).options,
                           });

                           // Hide other layers to show the PCA result
                           setLayers(prev => [pcaLayer, ...prev.map(l => ({...l, visible: false}))]);
                           setSelectedLayerId(pcaLayer.id);
                           // Removed success alert, user will see the map change
                        } catch (err) {
                           console.error('PCA ERROR:', err);
                           setError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    />
                  )}
                  {/* Timeline Overlay */}
                  {(() => {
                    const rasterLayersWithTime = seriesLayers
                      .filter(l => l.type === 'raster' && l.datetime)
                      .sort((a, b) => new Date(a.datetime!).getTime() - new Date(b.datetime!).getTime());
                      
                    if (rasterLayersWithTime.length === 0) return null;
                    
                    const currentIndex = rasterLayersWithTime.findIndex(l => l.id === activeLayer?.id);
              
              return (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000] w-11/12 max-w-2xl bg-black/80 backdrop-blur-md border border-white/20 rounded-2xl p-4 shadow-2xl">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-orange-500 uppercase tracking-widest">Timeline</span>
                    <div className="flex items-center gap-4">
                      <span className="text-sm font-mono text-white/80 flex items-center gap-3">
                        {activeLayer?.datetime ? format(new Date(activeLayer.datetime), 'MMM dd, yyyy HH:mm') : 'Unknown Date'}
                        {activeLayer?.type === 'raster' && activeLayer.stacItem?.properties?.['eo:cloud_cover'] !== undefined && (
                          <span className="flex items-center gap-1 text-orange-500/80 text-xs">
                            <Cloud size={14} />
                            {activeLayer.stacItem.properties['eo:cloud_cover'].toFixed(1)}%
                          </span>
                        )}
                      </span>
                      <button
                        onClick={() => {
                          if (activeLayer) {
                            removeLayer(activeLayer.id);
                          }
                        }}
                        className="flex items-center gap-1 text-xs bg-red-500/20 hover:bg-red-500/40 text-red-500 px-2 py-1 rounded transition-colors"
                        title="Delete current image"
                      >
                        <Trash2 size={14} />
                      </button>

                      <button
                        onClick={handleUpdateTimeline}
                        disabled={isExtractingTimeline || !selectedVectorFeature || !layers.some(l => l.type === 'raster' && l.datetime)}
                        className="flex items-center gap-1 text-xs bg-orange-500/20 hover:bg-orange-500/40 text-orange-500 px-2 py-1 rounded transition-colors disabled:opacity-50"
                        title={!selectedVectorFeature ? "Select a parcel first to update its data" : "Re-extract pixel data from all available images"}
                      >
                        {isExtractingTimeline ? (
                          <motion.div 
                            animate={{ rotate: 360 }} 
                            transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} 
                            className="w-3.5 h-3.5 border-2 border-orange-500/20 border-t-orange-500 rounded-full" 
                          />
                        ) : (
                          <BarChart3 size={14} />
                        )}
                        Update Time Series
                      </button>

                      <button
                        onClick={() => {
                          const cropSize = activeLayer?.type === 'raster' ? calculateCropPixelSize(activeLayer as RasterLayer) : null;
                          if (cropSize) {
                            setDownloadOptions({ layers: rasterLayersWithTime as RasterLayer[], cropSize });
                          } else {
                            downloadLayers(rasterLayersWithTime as RasterLayer[], 'full');
                          }
                        }}
                        className="flex items-center gap-1 text-xs bg-orange-500/20 hover:bg-orange-500/40 text-orange-500 px-2 py-1 rounded transition-colors"
                        title="Download entire series as ZIP"
                      >
                        <Download size={14} />
                        Download Series
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] text-white/40 font-mono">
                      {format(new Date(rasterLayersWithTime[0].datetime!), 'MMM dd')}
                    </span>
                    
                    <input 
                      type="range" 
                      min={0} 
                      max={rasterLayersWithTime.length - 1} 
                      value={currentIndex !== -1 ? currentIndex : 0}
                      onChange={(e) => {
                        const newIndex = parseInt(e.target.value);
                        const newActiveLayer = rasterLayersWithTime[newIndex];
                        
                        // Update visibility: only the selected layer in the timeline should be visible
                        setLayers(prev => prev.map(l => {
                          if (l.type === 'raster' && l.datetime && l.seriesId === activeSeriesId) {
                            return { ...l, visible: l.id === newActiveLayer.id };
                          }
                          return l;
                        }));
                        
                        setSelectedLayerId(newActiveLayer.id);
                      }}
                      className="flex-1 h-2 bg-white/20 rounded-lg appearance-none cursor-pointer accent-orange-500"
                    />
                    
                    <span className="text-[10px] text-white/40 font-mono">
                      {format(new Date(rasterLayersWithTime[rasterLayersWithTime.length - 1].datetime!), 'MMM dd')}
                    </span>
                  </div>
                  
                  <div className="flex justify-between mt-2 px-8 relative">
                    <div className="absolute top-1/2 left-8 right-8 h-[1px] bg-white/10 -translate-y-1/2 z-0" />
                    {rasterLayersWithTime.map((l, i) => (
                      <div 
                        key={l.id} 
                        onClick={() => {
                          setLayers(prev => prev.map(layer => {
                            if (layer.type === 'raster' && layer.datetime && layer.seriesId === activeSeriesId) {
                              return { ...layer, visible: layer.id === l.id };
                            }
                            return layer;
                          }));
                          setSelectedLayerId(l.id);
                        }}
                        className={cn(
                          "w-2 h-2 rounded-full transition-all cursor-pointer z-10 relative",
                          i === currentIndex ? "bg-orange-500 scale-150 shadow-[0_0_10px_rgba(249,115,22,0.5)]" : "bg-white/40 hover:bg-white/80 hover:scale-125"
                        )}
                        title={l.datetime ? format(new Date(l.datetime), 'MMM dd, yyyy') : ''}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}
          </>
        );
      })()}
          </div>
        </div>

        {/* Sidebar / Info Section */}
        <aside className="flex flex-col gap-6 overflow-y-auto pr-2 custom-scrollbar">
            {/* Sentinel-2 Search Card */}
            <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-6">
              <Search size={18} className="text-orange-500" />
              <h2 className="font-semibold text-sm uppercase tracking-wider text-white/60">Sentinel-2 Search</h2>
            </div>

            <div className="space-y-4">
              <div className="flex gap-2">
                <button
                  onClick={() => setIsDrawingMode(!isDrawingMode)}
                  className={cn(
                    "flex-1 py-3 px-4 rounded-xl border flex items-center justify-center gap-2 transition-all",
                    isDrawingMode 
                      ? "bg-orange-500 border-orange-600 text-black shadow-lg shadow-orange-500/20" 
                      : "bg-white/5 border-white/10 text-white hover:bg-white/10"
                  )}
                >
                  <MapIcon size={16} />
                  <span className="text-sm font-bold">{isDrawingMode ? 'Drawing Area...' : 'Select Area on Map'}</span>
                </button>
                <button
                  onClick={() => setIsPixelAnalysisMode(!isPixelAnalysisMode)}
                  className={cn(
                    "flex-1 py-3 px-4 rounded-xl border flex items-center justify-center gap-2 transition-all",
                    isPixelAnalysisMode 
                      ? "bg-indigo-500 border-indigo-600 text-white shadow-lg shadow-indigo-500/20" 
                      : "bg-white/5 border-white/10 text-white hover:bg-white/10"
                  )}
                >
                  <LineChartIcon size={16} />
                  <span className="text-sm font-bold">{isPixelAnalysisMode ? 'Click on Map...' : 'Pixel Analysis'}</span>
                </button>
                {searchBbox && (
                  <button
                    onClick={() => setSearchBbox(null)}
                    className="p-3 bg-white/5 border border-white/10 rounded-xl hover:bg-red-500/20 hover:text-red-500 hover:border-red-500/50 transition-all"
                    title="Clear Selected Area"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>

              {(drawingBbox || searchBbox) && (
                <div className="space-y-3">
                  <div className="p-3 bg-white/5 border border-white/10 rounded-xl">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold">
                        {drawingBbox ? 'Drawing BBox' : 'Selected BBox'}
                      </p>
                      {(() => {
                        const dims = getBboxDimensions(drawingBbox || searchBbox!);
                        return (
                          <span className="text-[10px] font-mono text-white/60">
                            ~{dims.widthPixels}x{dims.heightPixels} px
                          </span>
                        );
                      })()}
                    </div>
                    <p className="text-[10px] font-mono text-orange-500 truncate">
                      {(drawingBbox || searchBbox)!.map(c => c.toFixed(4)).join(', ')}
                    </p>
                    {(() => {
                      const dims = getBboxDimensions(drawingBbox || searchBbox!);
                      return (
                        <p className="text-[10px] text-white/40 mt-1">
                          Approx. {(dims.widthMeters / 1000).toFixed(2)}km × {(dims.heightMeters / 1000).toFixed(2)}km
                        </p>
                      );
                    })()}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2 flex items-center gap-1">
                    <Settings2 size={10} /> MPC API Key (Optional)
                  </p>
                  <input
                    type="password"
                    placeholder="Enter Planetary Computer API Key"
                    value={mpcToken}
                    onChange={(e) => setMpcToken(e.target.value)}
                    className={cn(
                      "w-full bg-white/5 border rounded-xl px-3 py-2 text-xs text-white/80 focus:outline-none transition-all",
                      mpcToken ? "border-green-500/30 focus:border-green-500/50" : "border-white/10 focus:border-orange-500/50"
                    )}
                  />
                  <p className="text-[8px] text-white/20 mt-1 italic">
                    {mpcToken ? "✓ API Key active" : "Required for higher rate limits and some collections."}
                  </p>
                  <a 
                    href="https://planetarycomputer.microsoft.com/account" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-[8px] text-orange-500/60 hover:text-orange-500 underline mt-1 block"
                  >
                    Get a free API Key from Microsoft
                  </a>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2 flex items-center gap-1">
                    <Calendar size={10} /> Start Date
                  </p>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-orange-500/50"
                  />
                </div>
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2 flex items-center gap-1">
                    <Calendar size={10} /> End Date
                  </p>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-orange-500/50"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2 flex items-center gap-1">
                    <Cloud size={10} /> Cloud %
                  </p>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={maxCloudCover}
                    onChange={(e) => setMaxCloudCover(parseInt(e.target.value) || 0)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-orange-500/50"
                  />
                </div>
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2 flex items-center gap-1">
                    <Layers size={10} /> Image Count
                  </p>
                  <input
                    type="number"
                    min="2"
                    max="100"
                    value={targetCount}
                    onChange={(e) => setTargetCount(parseInt(e.target.value) || 2)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-orange-500/50"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  onClick={handleSearch}
                  disabled={!searchBbox || isSearching || isFetchingSeries}
                  className="w-full py-3 bg-white/10 text-white rounded-xl font-bold text-sm hover:bg-white/20 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isSearching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                  Search Images
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => fetchTimeSeries(false)}
                    disabled={!searchBbox || isSearching || isFetchingSeries}
                    className="w-full py-2 bg-orange-500 text-black rounded-xl font-bold text-xs hover:bg-orange-600 transition-all disabled:opacity-50 flex flex-col items-center justify-center gap-1"
                  >
                    <div className="flex items-center gap-1">
                      {isFetchingSeries ? <Loader2 size={14} className="animate-spin" /> : <Layers size={14} />}
                      <span>Fetch {targetCount}</span>
                    </div>
                    {isFetchingSeries && fetchProgress && (
                      <span className="text-[9px] opacity-80">{fetchProgress.current}/{fetchProgress.total}</span>
                    )}
                  </button>
                  <button
                    onClick={() => fetchTimeSeries(true)}
                    disabled={!searchBbox || isSearching || isFetchingSeries}
                    className="w-full py-2 bg-orange-500/20 text-orange-500 border border-orange-500/50 rounded-xl font-bold text-xs hover:bg-orange-500/30 transition-all disabled:opacity-50 flex flex-col items-center justify-center gap-1"
                  >
                    <div className="flex items-center gap-1">
                      {isFetchingSeries ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                      <span>Fetch All</span>
                    </div>
                    {isFetchingSeries && fetchProgress && (
                      <span className="text-[9px] opacity-80">{fetchProgress.current}/{fetchProgress.total}</span>
                    )}
                  </button>
                </div>
              </div>

      {/* Download Options Modal */}
      <AnimatePresence>
        {downloadOptions && (
          <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-zinc-900 border border-white/10 rounded-3xl p-8 max-w-md w-full shadow-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-orange-500/20 rounded-lg">
                    <Download size={20} className="text-orange-500" />
                  </div>
                  <h2 className="text-xl font-bold">
                    {downloadOptions.layers.length > 1 ? 'Download Series Options' : 'Download Options'}
                  </h2>
                </div>
                <button 
                  onClick={() => setDownloadOptions(null)}
                  className="p-2 hover:bg-white/5 rounded-full transition-colors"
                >
                  <X size={20} className="text-white/40" />
                </button>
              </div>

              <p className="text-white/60 text-sm mb-8">
                {downloadOptions.layers.length > 1 
                  ? `Select the dimensions for your download. This will export a ZIP containing ${downloadOptions.layers.length} folders (one for each date in the series).`
                  : 'Select the dimensions for your download. All downloads will be exported as a ZIP of GeoTIFF (.tif) bands.'}
              </p>

              <div className="space-y-3">
                <button
                  onClick={() => downloadLayers(downloadOptions.layers, 'crop')}
                  className="w-full group flex items-center justify-between p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl transition-all"
                >
                  <div className="flex flex-col items-start">
                    <span className="font-semibold">Current Crop</span>
                    <span className="text-xs text-white/40">{downloadOptions.cropSize.width} x {downloadOptions.cropSize.height} pixels</span>
                  </div>
                  <ChevronDown size={18} className="text-white/20 group-hover:text-orange-500 -rotate-90 transition-colors" />
                </button>

                <button
                  onClick={() => downloadLayers(downloadOptions.layers, '128')}
                  className="w-full group flex items-center justify-between p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl transition-all"
                >
                  <div className="flex flex-col items-start">
                    <span className="font-semibold">Thumbnail Size</span>
                    <span className="text-xs text-white/40">128 x 128 pixels (centered)</span>
                  </div>
                  <ChevronDown size={18} className="text-white/20 group-hover:text-orange-500 -rotate-90 transition-colors" />
                </button>

                <button
                  onClick={() => downloadLayers(downloadOptions.layers, '256')}
                  className="w-full group flex items-center justify-between p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl transition-all"
                >
                  <div className="flex flex-col items-start">
                    <span className="font-semibold">Standard Size</span>
                    <span className="text-xs text-white/40">256 x 256 pixels (centered)</span>
                  </div>
                  <ChevronDown size={18} className="text-white/20 group-hover:text-orange-500 -rotate-90 transition-colors" />
                </button>

                <button
                  onClick={() => downloadLayers(downloadOptions.layers, '512')}
                  className="w-full group flex items-center justify-between p-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl transition-all"
                >
                  <div className="flex flex-col items-start">
                    <span className="font-semibold">Large Size</span>
                    <span className="text-xs text-white/40">512 x 512 pixels (centered)</span>
                  </div>
                  <ChevronDown size={18} className="text-white/20 group-hover:text-orange-500 -rotate-90 transition-colors" />
                </button>

                <div className="pt-4 mt-4 border-t border-white/5">
                  <button
                    onClick={() => downloadLayers(downloadOptions.layers, 'full')}
                    className="w-full group flex items-center justify-between p-4 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/20 rounded-2xl transition-all"
                  >
                    <div className="flex flex-col items-start">
                      <span className="font-semibold text-orange-500">Original Full Size</span>
                      <span className="text-xs text-orange-500/60">Full resolution GeoTIFF bands</span>
                    </div>
                    <ChevronDown size={18} className="text-orange-500/40 group-hover:text-orange-500 -rotate-90 transition-colors" />
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Search Results */}
              <AnimatePresence>
                {searchResults.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-2 pt-4 border-t border-white/10"
                  >
                    <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2">Results (Latest 10)</p>
                    <div className="max-h-[300px] overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                      {searchResults.map((item) => (
                        <div 
                          key={item.id}
                          className="p-3 bg-white/5 border border-white/5 rounded-xl hover:border-orange-500/30 transition-all group"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] font-mono text-orange-500">{format(new Date(item.properties.datetime), 'MMM dd, yyyy HH:mm')}</span>
                            <span className="text-[10px] text-white/40 flex items-center gap-1">
                              <Cloud size={10} /> {item.properties['eo:cloud_cover'].toFixed(1)}%
                            </span>
                          </div>
                          <button
                            onClick={() => fetchSentinelImage(item)}
                            className="w-full py-2 bg-orange-500/10 hover:bg-orange-500 text-orange-500 hover:text-black rounded-lg text-[10px] font-bold transition-all flex items-center justify-center gap-2"
                          >
                            <Download size={12} /> Fetch & Add Layer
                          </button>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </section>

          {layers.some(l => l.type === 'vector') && (
            <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <Hexagon size={18} className="text-orange-500" />
                <h2 className="font-semibold text-sm uppercase tracking-wider text-white/60">Vector Optimization</h2>
              </div>
              
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Crop Rasters Around SHP</p>
                  <button
                    onClick={() => setCropAroundShp(!cropAroundShp)}
                    className={cn(
                      "w-10 h-5 rounded-full relative transition-colors",
                      cropAroundShp ? "bg-orange-500" : "bg-white/10"
                    )}
                  >
                    <div className={cn(
                      "w-4 h-4 bg-white rounded-full absolute top-[2px] transition-all",
                      cropAroundShp ? "translate-x-5" : "translate-x-1"
                    )} />
                  </button>
                </div>

                {cropAroundShp && (
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Buffer Distance</p>
                      <span className="text-[10px] font-mono text-orange-500">{shpBufferMeters}m</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="5000"
                      step="10"
                      value={shpBufferMeters}
                      onChange={(e) => setShpBufferMeters(parseInt(e.target.value))}
                      onMouseUp={() => applyVectorCrop()}
                      onTouchEnd={() => applyVectorCrop()}
                      className="w-full accent-orange-500"
                    />
                    <p className="text-[9px] text-white/30 mt-2 leading-tight">By default, we prune raster bounds to ~50m around vector edges to drastically lower memory usage. Slide to load more of the surrounding raster.</p>
                    <button onClick={applyVectorCrop} className="mt-3 w-full py-2 bg-orange-500/20 text-orange-500 text-xs font-bold rounded-lg hover:bg-orange-500/30 transition-colors">Apply Optimization</button>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Layer Manager Card */}
          <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Layers size={18} className="text-orange-500" />
                <h2 className="font-semibold text-sm uppercase tracking-wider text-white/60">Layer Manager</h2>
              </div>
              <div className="flex items-center gap-2">
                {searchBbox && (
                  <button
                    onClick={() => setFilterByBbox(!filterByBbox)}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1 rounded-lg border transition-all",
                      filterByBbox 
                        ? "bg-orange-500/20 border-orange-500/50 text-orange-500" 
                        : "bg-white/5 border-white/10 text-white/40 hover:bg-white/10"
                    )}
                    title="Toggle Global Spatial Filter"
                  >
                    <Sliders size={12} />
                    <span className="text-[10px] font-bold uppercase tracking-wider">Filter View</span>
                  </button>
                )}
                {layers.length > 0 && (
                  <button
                    onClick={() => {
                      const newLayers = layers.filter(l => l.type === 'vector');
                      setLayers(newLayers);
                      if (!newLayers.find(l => l.id === selectedLayerId)) {
                        setSelectedLayerId(null);
                      }
                    }}
                    className="flex items-center gap-1 px-2 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-lg text-xs font-medium transition-colors"
                    title="Delete All Layers"
                  >
                    <Trash2 size={12} />
                    Clear All
                  </button>
                )}
              </div>
            </div>

            {layers.length === 0 ? (
              <div className="text-center py-8 border border-dashed border-white/10 rounded-xl">
                <p className="text-sm text-white/30 italic">No layers loaded</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {layers.map((layer, index) => (
                  <div 
                    key={layer.id}
                    onClick={() => setSelectedLayerId(layer.id)}
                    className={cn(
                      "group flex flex-col gap-2 p-3 rounded-xl border transition-all cursor-pointer relative overflow-hidden",
                      selectedLayerId === layer.id 
                        ? "bg-orange-500/10 border-orange-500 ring-1 ring-orange-500/50" 
                        : "bg-white/5 border-white/5 hover:bg-white/10"
                    )}
                  >
                    {selectedLayerId === layer.id && (
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-orange-500" />
                    )}
                    <div className="flex items-center gap-3 w-full">
                    <div className="flex flex-col gap-1">
                      <button 
                        onClick={(e) => { e.stopPropagation(); moveLayer(layer.id, 'up'); }}
                        disabled={index === 0}
                        className="p-0.5 text-white/20 hover:text-white disabled:opacity-0"
                      >
                        <ChevronUp size={12} />
                      </button>
                      <button 
                        onClick={(e) => { e.stopPropagation(); moveLayer(layer.id, 'down'); }}
                        disabled={index === layers.length - 1}
                        className="p-0.5 text-white/20 hover:text-white disabled:opacity-0"
                      >
                        <ChevronDown size={12} />
                      </button>
                    </div>

                    <div className={cn(
                      "p-2 rounded-lg",
                      layer.type === 'raster' ? "bg-blue-500/10 text-blue-500" : "bg-purple-500/10 text-purple-500"
                    )}>
                      {layer.type === 'raster' ? <FileText size={16} /> : <Hexagon size={16} />}
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{layer.name}</p>
                      <p className="text-[10px] text-white/40 uppercase tracking-widest">{layer.type}</p>
                    </div>

                    <div className={cn(
                      "flex items-center gap-1 transition-opacity",
                      selectedLayerId === layer.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}>
                      {layer.type === 'raster' && (
                        <div className="flex items-center gap-1">
                          {layers.some(l => l.type === 'vector' && l.visible) && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleExportPixelTable(layer as RasterLayer); }}
                              className="p-1.5 bg-indigo-500/10 text-indigo-500 rounded-lg hover:bg-indigo-500/20 transition-all"
                              title="Export Pixel Table (joined with SHP)"
                            >
                              <Folder size={14} />
                            </button>
                          )}
                          <button 
                            onClick={(e) => { e.stopPropagation(); toggleLayerCrop(layer.id); }}
                            disabled={!searchBbox && !layer.clipBbox}
                            className={cn(
                              "p-1.5 rounded-lg transition-all disabled:opacity-20",
                              layer.clipBbox ? "bg-orange-500/20 text-orange-500" : "hover:bg-white/10 text-white/60"
                            )}
                            title={layer.clipBbox ? "Clear Crop" : "Crop to Selection"}
                          >
                            <MapIcon size={14} />
                          </button>
                        </div>
                      )}
                      {layer.type === 'raster' && layer.stacItem && (
                        <button 
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            const cropSize = calculateCropPixelSize(layer as RasterLayer);
                            if (cropSize) {
                              setDownloadOptions({ layers: [layer as RasterLayer], cropSize });
                            } else {
                              downloadLayers([layer as RasterLayer], 'full');
                            }
                          }}
                          className="p-1.5 hover:bg-white/10 rounded-lg text-white/60"
                          title="Download Image Package (ZIP)"
                        >
                          <Download size={14} />
                        </button>
                      )}
                      {layer.type === 'vector' && (
                         <div className="flex items-center gap-1">
                           <button
                             onClick={(e) => {
                               e.stopPropagation();
                               if (isPixelsLayer(layer)) {
                                 handleSelectVector(null, layer as VectorLayer);
                               } else {
                                 const dl = layer as VectorLayer;
                                 if (dl.data && dl.data.features && dl.data.features.length > 0) {
                                   handleSelectVector(dl.data.features[0]);
                                 }
                               }
                             }}
                             className="p-1.5 hover:bg-orange-500/10 rounded-lg text-orange-500/60 hover:text-orange-500"
                             title={isPixelsLayer(layer) ? "Visualize Pixel Series" : "Feature Details"}
                           >
                             {isPixelsLayer(layer) ? <BarChart3 size={14} /> : <Info size={14} />}
                           </button>
                           <button
                             onClick={(e) => {
                               e.stopPropagation();
                               const dl = layer as VectorLayer;
                               if (!dl.data) return;
                               downloadGeoJson(dl.data, dl.name || "vector_layer");
                             }}
                             className="p-1.5 hover:bg-white/10 rounded-lg text-white/60 hover:text-white"
                             title="Download GeoJSON"
                           >
                             <Download size={14} />
                           </button>
                         </div>
                      )}
                      <button 
                        onClick={(e) => { e.stopPropagation(); toggleVisibility(layer.id); }}
                        className="p-1.5 hover:bg-white/10 rounded-lg text-white/60"
                      >
                        {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                      </button>
                      <button 
                        onClick={(e) => { e.stopPropagation(); removeLayer(layer.id); }}
                        className="p-1.5 hover:bg-red-500/10 rounded-lg text-red-500/60 hover:text-red-500"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Rendering Options Card (Only for Raster) */}
          {selectedLayer?.type === 'raster' && (
            <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-6">
                <Settings2 size={18} className="text-orange-500" />
                <h2 className="font-semibold text-sm uppercase tracking-wider text-white/60">Rendering: {selectedLayer.name}</h2>
              </div>

              <div className="space-y-6">
                {/* Mode Selection */}
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-3">Visualization Mode</p>
                  <div className="flex flex-wrap gap-2">
                    {(['rgb', 'single', 'index'] as const).map(mode => (
                      <button
                        key={mode}
                        onClick={() => updateLayerOptions(selectedLayer.id, { mode })}
                        className={cn(
                          "flex-1 py-2 text-[10px] font-medium rounded-lg border transition-all uppercase tracking-wider",
                          selectedLayer.options.mode === mode 
                            ? "bg-orange-500/20 border-orange-500/50 text-orange-500" 
                            : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
                        )}
                      >
                        {mode === 'rgb' ? 'RGB' : mode === 'single' ? 'Single' : 'Index'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Band Selection */}
                {selectedLayer.options.mode === 'rgb' && (
                  <div>
                    <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-3">Band Mapping (R, G, B)</p>
                    <div className="grid grid-cols-3 gap-2">
                      {([0, 1, 2] as const).map(i => {
                        const colors = ['Red', 'Green', 'Blue'];
                        const bandOptions = getBandOptions(selectedLayer as RasterLayer);
                        return (
                          <div key={i}>
                            <p className="text-[9px] text-white/40 uppercase mb-1">{colors[i]}</p>
                            <select
                              value={selectedLayer.options.bands[i]}
                              onChange={(e) => {
                                const newBands = [...selectedLayer.options.bands] as [number, number, number];
                                newBands[i] = parseInt(e.target.value) || 1;
                                updateLayerOptions(selectedLayer.id, { bands: newBands });
                              }}
                              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-xs font-mono focus:outline-none focus:border-orange-500/50 appearance-none"
                            >
                              {bandOptions.map(b => (
                                <option key={b} value={b} className="bg-gray-900">{getBandName(selectedLayer as RasterLayer, b)}</option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {selectedLayer.options.mode === 'single' && (
                  <div className="space-y-4">
                    <div>
                      <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-3">Select Band</p>
                      <select
                        value={selectedLayer.options.singleBand}
                        onChange={(e) => {
                          console.log('Band selector changed:', e.target.value);
                          updateLayerOptions(selectedLayer.id, { singleBand: parseInt(e.target.value) || 1 });
                        }}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-500/50 appearance-none"
                      >
                        {getBandOptions(selectedLayer as RasterLayer).map(b => (
                          <option key={b} value={b} className="bg-gray-900">{getBandName(selectedLayer as RasterLayer, b)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-3">Colormap</p>
                      <div className="grid grid-cols-2 gap-2">
                        {(['grayscale', 'viridis', 'magma', 'inferno'] as const).map(cmap => (
                          <button
                            key={cmap}
                            onClick={() => updateLayerOptions(selectedLayer.id, { colormap: cmap })}
                            className={cn(
                              "py-2 text-[10px] font-medium rounded-lg border transition-all capitalize",
                              selectedLayer.options.colormap === cmap 
                                ? "bg-orange-500/20 border-orange-500/50 text-orange-500" 
                                : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
                            )}
                          >
                            {cmap}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {selectedLayer.options.mode === 'index' && (
                  <div className="space-y-4">
                    <div>
                      <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-3">Vegetation Index</p>
                      <div className="flex flex-wrap gap-2">
                        {(['ndvi', 'evi', 'gndvi', 'savi'] as const).map(idx => (
                          <button
                            key={idx}
                            onClick={() => updateLayerOptions(selectedLayer.id, { indexType: idx })}
                            className={cn(
                              "flex-1 min-w-[60px] py-2 text-[10px] font-medium rounded-lg border transition-all uppercase tracking-wider",
                              selectedLayer.options.indexType === idx 
                                ? "bg-orange-500/20 border-orange-500/50 text-orange-500" 
                                : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
                            )}
                          >
                            {idx}
                          </button>
                        ))}
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2">NIR Band</p>
                        <select
                          value={selectedLayer.options.indexBands.nir}
                          onChange={(e) => updateIndexBand(selectedLayer.id, 'nir', parseInt(e.target.value) || 1)}
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-500/50 appearance-none"
                        >
                          {getBandOptions(selectedLayer as RasterLayer).map(b => (
                            <option key={b} value={b} className="bg-gray-900">{getBandName(selectedLayer as RasterLayer, b)}</option>
                          ))}
                        </select>
                      </div>
                      {selectedLayer.options.indexType === 'gndvi' ? (
                        <div>
                          <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2">Green Band</p>
                          <select
                            value={selectedLayer.options.indexBands.green}
                            onChange={(e) => updateIndexBand(selectedLayer.id, 'green', parseInt(e.target.value) || 1)}
                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-500/50 appearance-none"
                          >
                            {getBandOptions(selectedLayer as RasterLayer).map(b => (
                              <option key={b} value={b} className="bg-gray-900">{getBandName(selectedLayer as RasterLayer, b)}</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <div>
                          <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2">Red Band</p>
                          <select
                            value={selectedLayer.options.indexBands.red}
                            onChange={(e) => updateIndexBand(selectedLayer.id, 'red', parseInt(e.target.value) || 1)}
                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-500/50 appearance-none"
                          >
                            {getBandOptions(selectedLayer as RasterLayer).map(b => (
                              <option key={b} value={b} className="bg-gray-900">{getBandName(selectedLayer as RasterLayer, b)}</option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    {selectedLayer.options.indexType === 'evi' && (
                      <div>
                        <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2">Blue Band</p>
                        <select
                          value={selectedLayer.options.indexBands.blue}
                          onChange={(e) => updateIndexBand(selectedLayer.id, 'blue', parseInt(e.target.value) || 1)}
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-500/50 appearance-none"
                        >
                          {getBandOptions(selectedLayer as RasterLayer).map(b => (
                            <option key={b} value={b} className="bg-gray-900">{getBandName(selectedLayer as RasterLayer, b)}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div>
                      <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-3">Colormap</p>
                      <div className="grid grid-cols-2 gap-2">
                        {(['grayscale', 'viridis', 'magma', 'rdylgn'] as const).map(cmap => (
                          <button
                            key={cmap}
                            onClick={() => updateLayerOptions(selectedLayer.id, { colormap: cmap })}
                            className={cn(
                              "py-2 text-[10px] font-medium rounded-lg border transition-all capitalize",
                              selectedLayer.options.colormap === cmap 
                                ? "bg-orange-500/20 border-orange-500/50 text-orange-500" 
                                : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
                            )}
                          >
                            {cmap === 'rdylgn' ? 'Health (R-Y-G)' : cmap}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Index Formula Display */}
                {selectedLayer.options.mode === 'index' && (
                  <div className="p-3 bg-orange-500/5 border border-orange-500/20 rounded-xl">
                    <p className="text-[10px] text-orange-500/60 uppercase tracking-widest font-bold mb-1">Index Formula</p>
                    <p className="text-xs font-mono text-orange-500">
                      {INDEX_FORMULAS[selectedLayer.options.indexType]}
                    </p>
                  </div>
                )}

                {/* Stretch Mode */}
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-3">Contrast Stretch</p>
                  <div className="flex gap-2">
                    {(['percentile', 'minmax', 'none'] as const).map(mode => (
                      <button
                        key={mode}
                        onClick={() => updateLayerOptions(selectedLayer.id, { stretch: mode })}
                        className={cn(
                          "flex-1 py-2 text-xs font-medium rounded-lg border transition-all capitalize",
                          selectedLayer.options.stretch === mode 
                            ? "bg-orange-500/20 border-orange-500/50 text-orange-500" 
                            : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
                        )}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Percentiles */}
                {selectedLayer.options.stretch === 'percentile' && (
                  <div>
                    <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-3">Percentiles ({selectedLayer.options.percentiles[0]}% - {selectedLayer.options.percentiles[1]}%)</p>
                    <div className="flex items-center gap-4">
                      <input
                        type="range"
                        min="0"
                        max="10"
                        step="0.5"
                        value={selectedLayer.options.percentiles[0]}
                        onChange={(e) => updateLayerOptions(selectedLayer.id, { percentiles: [parseFloat(e.target.value), selectedLayer.options.percentiles[1]] })}
                        className="flex-1 accent-orange-500"
                      />
                      <input
                        type="range"
                        min="90"
                        max="100"
                        step="0.5"
                        value={selectedLayer.options.percentiles[1]}
                        onChange={(e) => updateLayerOptions(selectedLayer.id, { percentiles: [selectedLayer.options.percentiles[0], parseFloat(e.target.value)] })}
                        className="flex-1 accent-orange-500"
                      />
                    </div>
                  </div>
                )}

                {/* Opacity */}
                <div>
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-3">Layer Opacity ({Math.round(selectedLayer.opacity * 100)}%)</p>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={selectedLayer.opacity}
                    onChange={(e) => updateLayerOptions(selectedLayer.id, { opacity: parseFloat(e.target.value) })}
                    className="w-full accent-orange-500"
                  />
                </div>

                {/* Pixel Grid Toggle */}
                <div className="pt-4 border-t border-white/10">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Pixel Delimitation</p>
                      <p className="text-[10px] text-white/20">Show pixel grid lines</p>
                    </div>
                    <button
                      onClick={() => updateLayerOptions(selectedLayer.id, { showGrid: !selectedLayer.options.showGrid })}
                      className={cn(
                        "relative inline-flex h-5 w-10 items-center rounded-full transition-colors focus:outline-none",
                        selectedLayer.options.showGrid ? "bg-orange-500" : "bg-white/10"
                      )}
                    >
                      <span
                        className={cn(
                          "inline-block h-3 w-3 transform rounded-full bg-white transition-transform",
                          selectedLayer.options.showGrid ? "translate-x-6" : "translate-x-1"
                        )}
                      />
                    </button>
                  </div>
                  
                  {selectedLayer.options.showGrid && (
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold">Grid Spacing (Pixels)</p>
                        <span className="text-[10px] font-mono text-orange-500">{selectedLayer.options.gridSpacing}px</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="100"
                        step="1"
                        value={selectedLayer.options.gridSpacing}
                        onChange={(e) => updateLayerOptions(selectedLayer.id, { gridSpacing: parseInt(e.target.value) })}
                        className="w-full accent-orange-500"
                      />
                      
                      {selectedLayer.data?.metadata?.resolution ? (
                        <div className="p-2 bg-orange-500/5 border border-orange-500/10 rounded-lg">
                          <p className="text-[9px] text-orange-500/60 uppercase tracking-tighter">Detected Resolution</p>
                          <p className="text-[10px] font-mono text-orange-500">
                            {selectedLayer.data.metadata.resolution[0].toFixed(4)} × {selectedLayer.data.metadata.resolution[1].toFixed(4)} {selectedLayer.data.metadata.crs?.includes('4326') ? 'deg' : 'units'}/px
                          </p>
                          <p className="text-[9px] text-white/30 mt-1">Grid is set to 1 line per {selectedLayer.options.gridSpacing} pixel(s).</p>
                          <p className="text-[9px] text-orange-500/40 mt-1 italic">Note: Grid only visible at high zoom levels to maintain performance.</p>
                        </div>
                      ) : (
                        <div className="p-2 bg-yellow-500/5 border border-yellow-500/10 rounded-lg">
                          <p className="text-[9px] text-yellow-500/60 uppercase tracking-tighter">Resolution Not Found</p>
                          <p className="text-[10px] text-white/40">Could not detect pixel scale. Please select a manual grid spacing above.</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Band Explorer Card */}
          {selectedLayer?.type === 'raster' && (
            <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-6">
                <Sliders size={18} className="text-orange-500" />
                <h2 className="font-semibold text-sm uppercase tracking-wider text-white/60">Band Explorer</h2>
              </div>
              
              <div className="space-y-3">
                {selectedLayer.data?.bandData ? (
                  <>
                    <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2">Downloaded Bands</p>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.keys(selectedLayer.data.bandData).sort().map((bandKey, i) => (
                        <div key={i} className="flex flex-col p-2 rounded-lg bg-white/5 border border-white/5">
                          <span className="text-[10px] font-mono text-orange-500 uppercase tracking-tighter">{bandKey}</span>
                          <span className="text-xs font-bold text-white/80 truncate">{getBandName(selectedLayer as RasterLayer, parseInt(bandKey.replace('B0', '').replace('B', '')) || 0)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : selectedLayer.data?.metadata?.descriptions && selectedLayer.data.metadata.descriptions.length > 0 ? (
                  selectedLayer.data.metadata.descriptions.map((desc, i) => (
                    <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-white/5 border border-white/5">
                      <span className="text-xs font-mono text-orange-500">#{i + 1}</span>
                      <span className="text-xs text-white/60">{desc || `Band ${i + 1}`}</span>
                    </div>
                  ))
                ) : (
                  Array.from({ length: selectedLayer.data?.metadata?.bands || 0 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-white/5 border border-white/5">
                      <span className="text-xs font-mono text-orange-500">#{i + 1}</span>
                      <span className="text-xs text-white/60">Band {i + 1}</span>
                    </div>
                  ))
                )}
                <div className="mt-4 pt-4 border-t border-white/5">
                  <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-2">Common Sensors Guide</p>
                  <div className="space-y-2">
                    <div className="flex flex-col gap-1 text-[10px]">
                      <span className="text-white/40 font-bold">Sentinel-2:</span>
                      <span className="text-white/60">B2=Blue, B3=Green, B4=Red, B8=NIR</span>
                      <span className="text-white/60">B5, B6, B7, B8A = Red Edge / Narrow NIR</span>
                      <span className="text-white/60">B11, B12 = SWIR (Shortwave Infrared)</span>
                    </div>
                    <div className="flex flex-col gap-1 text-[10px] pt-2 border-t border-white/5">
                      <span className="text-white/40 font-bold">Landsat 8:</span>
                      <span className="text-white/60">B2=Blue, B3=Green, B4=Red, B5=NIR</span>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Metadata Card */}
          <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-6">
              <Info size={18} className="text-orange-500" />
              <h2 className="font-semibold text-sm uppercase tracking-wider text-white/60">Metadata</h2>
            </div>

            {selectedLayer ? (
              <div className="space-y-4">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-orange-500/10 rounded-xl">
                    {selectedLayer.type === 'raster' ? <FileText size={20} className="text-orange-500" /> : <Hexagon size={20} className="text-orange-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white/40 uppercase tracking-widest font-bold mb-1">Filename</p>
                    <p className="text-sm font-medium truncate">{selectedLayer.name}</p>
                  </div>
                </div>

                {selectedLayer.type === 'raster' && selectedLayer.stacItem && (
                  <button
                    onClick={() => {
                      const cropSize = calculateCropPixelSize(selectedLayer as RasterLayer);
                      if (cropSize) {
                        setDownloadOptions({ layers: [selectedLayer as RasterLayer], cropSize });
                      } else {
                        downloadLayers([selectedLayer as RasterLayer], 'full');
                      }
                    }}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-orange-500 hover:bg-orange-600 text-white rounded-xl font-semibold transition-all shadow-lg shadow-orange-500/20"
                  >
                    <Download size={18} />
                    Download Original Bands (ZIP)
                  </button>
                )}

                {selectedLayer.type === 'raster' && (
                  <button
                    onClick={() => toggleLayerCrop(selectedLayer.id)}
                    disabled={!searchBbox && !selectedLayer.clipBbox}
                    className={cn(
                      "w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold transition-all",
                      selectedLayer.clipBbox 
                        ? "bg-orange-500/20 border border-orange-500/50 text-orange-500" 
                        : "bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                    )}
                  >
                    <MapIcon size={18} />
                    {selectedLayer.clipBbox ? 'Clear Layer Crop' : 'Crop Layer to Selection'}
                  </button>
                )}

                <button 
                  onClick={() => removeLayer(selectedLayer.id)}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-xl font-semibold transition-all"
                >
                  <Trash2 size={18} />
                  Remove Layer
                </button>

                {selectedLayer.type === 'raster' ? (
                  <>
                    <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
                      <div>
                        <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-1">Dimensions</p>
                        <p className="text-sm font-mono">{selectedLayer.data?.metadata?.width || 0} × {selectedLayer.data?.metadata?.height || 0}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-1">Bands</p>
                        <p className="text-sm font-mono">{selectedLayer.data?.metadata?.bands || 0} Channels</p>
                      </div>
                    </div>

                    <div className="pt-4 border-t border-white/5">
                      <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-1">Native CRS</p>
                      <p className="text-sm font-mono break-all bg-white/5 p-2 rounded-lg mt-1">{selectedLayer.data?.metadata?.crs || 'N/A'}</p>
                    </div>
                  </>
                ) : (
                  <div className="pt-4 border-t border-white/5">
                    <p className="text-[10px] text-white/40 uppercase tracking-widest font-bold mb-1">Features</p>
                    <p className="text-sm font-mono">{selectedLayer.data?.features?.length || 0} Records</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-sm text-white/30 italic">Select a layer to see metadata</p>
              </div>
            )}
          </section>

          {/* Instructions Card */}
          <section className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-6">
              <Layers size={18} className="text-orange-500" />
              <h2 className="font-semibold text-sm uppercase tracking-wider text-white/60">Processing Pipeline</h2>
            </div>
            
            <ul className="space-y-4">
              {[
                { step: '01', title: 'Raster IO', desc: 'Reading raw binary bands using geotiff.js' },
                { step: '02', title: 'RGB Mapping', desc: 'Selecting primary bands for visualization' },
                { step: '03', title: 'Contrast Stretch', desc: '2-98% percentile normalization' },
                { step: '04', title: 'Reprojection', desc: 'Transforming bounds to WGS84 via proj4' },
              ].map((item) => (
                <li key={item.step} className="flex gap-4">
                  <span className="text-xs font-bold text-orange-500/40 mt-1">{item.step}</span>
                  <div>
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="text-xs text-white/40 mt-0.5">{item.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {error && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 flex flex-col gap-3"
            >
              <div className="flex gap-3 items-start">
                <X className="text-red-500 shrink-0 mt-0.5" size={16} />
                <p className="text-xs text-red-200/80 leading-relaxed font-medium">Error Encountered</p>
              </div>
              <p className="text-[11px] text-red-200/60 leading-relaxed break-all bg-black/20 p-2 rounded-lg font-mono">
                {error}
              </p>

              {(error.includes("Local Python Server") || error.includes("local Python server") || error.includes("local url") || error.includes("Local Engine")) && (
                <button
                  type="button"
                  onClick={() => {
                    setUseLocalServer(false);
                    setError(null);
                  }}
                  className="w-full text-center bg-orange-500 hover:bg-orange-600 active:scale-98 text-white rounded-xl text-xs font-semibold py-2 transition-all cursor-pointer shadow-lg shadow-orange-500/20"
                >
                  Switch to Standard Browser-Side Mode
                </button>
              )}

              {verboseLogs.length > 0 && (
                <div className="flex flex-col gap-2 border-t border-red-500/10 pt-2">
                  <button 
                    onClick={() => setShowVerboseLogsList(!showVerboseLogsList)}
                    className="flex justify-between items-center text-[10px] text-red-200/50 hover:text-red-200"
                  >
                    <span>{showVerboseLogsList ? "Hide Connection Details" : "Show Diagnostic Logs"} ({verboseLogs.length})</span>
                    <span>{showVerboseLogsList ? "▲" : "▼"}</span>
                  </button>
                  {showVerboseLogsList && (
                    <div className="max-h-48 overflow-y-auto bg-black/40 text-[9px] text-slate-300 font-mono p-2 rounded-lg space-y-1 scrollbar-thin scrollbar-thumb-white/10">
                      {verboseLogs.map((log, index) => {
                        const isErr = log.includes("[ERROR]");
                        const isWarn = log.includes("[Warning]");
                        return (
                          <div 
                            key={index} 
                            className={cn(
                              "leading-relaxed whitespace-pre-wrap break-all",
                              isErr ? "text-red-400 font-bold" : isWarn ? "text-yellow-400 font-bold" : "text-slate-300"
                            )}
                          >
                            {log}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <button 
                onClick={() => {
                  setError(null);
                  setVerboseLogs([]);
                }}
                className="text-[9px] text-red-500/60 hover:text-red-500 uppercase tracking-widest font-bold self-end"
              >
                Dismiss
              </button>
            </motion.div>
          )}
        </aside>

        {showResetConfirm && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-zinc-900 border border-white/10 p-6 rounded-2xl shadow-2xl max-w-sm w-full mx-4 flex flex-col gap-6">
              <div>
                <h3 className="text-lg font-bold text-white mb-2">Reset Workspace</h3>
                <p className="text-sm text-white/60">
                  Are you sure you want to reset everything? This will delete all layers and settings.
                </p>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white rounded-lg transition-colors text-sm font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    // Hide dialog
                    setShowResetConfirm(false);
                    
                    // Clear storage
                    import('idb-keyval').then(async ({ clear, set }) => {
                      await set('app_state', null);
                      await clear();
                    });
                    localStorage.removeItem('mpc_token');
                    sessionStorage.clear();
                    
                    // Reset React state in-place to avoid full page reloads that can break the iframe Map container
                    setLayers([]);
                    setSearchBbox(null);
                    setDrawingBbox(null);
                    setStartDate('');
                    setEndDate('');
                    setTargetCount(10);
                    setMaxCloudCover(10);
                    setSelectedLayerId(null);
                    setSelectedVectorFeature(null);
                    setMpcToken('');
                  }}
                  className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors text-sm font-medium"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}} />
    </div>
  );
}
