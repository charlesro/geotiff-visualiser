import { RasterLayer } from '../types';
import buffer from '@turf/buffer';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import { projectToCrs, unprojectToWgs84 } from './geo';
import { computeIndexValue } from './spectral';
import { extractSpecies } from './species';

export interface PixelTimeseriesData {
  date: string;
  [pixelId: string]: any; // pixel_0_0: 0.5, etc
}

export interface PixelExtractionResult {
  timeseries: PixelTimeseriesData[];
  pixelPoints: any;
  excludedTimeseries?: PixelTimeseriesData[];
  excludedPixelPoints?: any;
}

function getPixelValue(bandData: any, offset: number, indexType: string): number | null {
  // Index formulas are shared with the rendering pipelines (see spectral.ts).
  // eviConstant is 10000 here because extraction operates on raw Sentinel-2
  // digital numbers (0-10000) rather than 0-1 reflectance.
  if (indexType === 'NDVI') {
    const nir = bandData['8'] || bandData['B08'];
    const red = bandData['4'] || bandData['B04'];
    if (nir && red) {
      return computeIndexValue('ndvi', red[offset] as number, undefined, undefined, nir[offset] as number, { nanToZero: false });
    }
  } else if (indexType === 'EVI') {
    const nir = bandData['8'] || bandData['B08'];
    const red = bandData['4'] || bandData['B04'];
    const blue = bandData['2'] || bandData['B02'];
    if (nir && red && blue) {
      return computeIndexValue('evi', red[offset] as number, undefined, blue[offset] as number, nir[offset] as number, { eviConstant: 10000, nanToZero: false });
    }
  } else {
     const bData = bandData[indexType] || bandData[indexType.replace('B', '')] || bandData[indexType.replace('B0', '')];
     if (bData) {
       return bData[offset] as number;
     }
  }
  return null;
}

export async function extractPixelTimeseriesOptions(
  feature: any,
  layers: RasterLayer[],
  bufferMeters: number,
  indexType: string
): Promise<PixelExtractionResult> {
  if (layers.length === 0) {
    return { 
      timeseries: [], 
      pixelPoints: { type: "FeatureCollection", features: [] },
      excludedTimeseries: [],
      excludedPixelPoints: { type: "FeatureCollection", features: [] }
    };
  }

  // Set up search and core boundaries based on buffer state
  let targetFeature = feature; // Outer search boundary
  let coreFeature = feature;    // Inner core boundary

  if (bufferMeters !== 0) {
    try {
      const buffered = buffer(feature, bufferMeters, { units: 'meters' });
      if (buffered) {
        if (bufferMeters > 0) {
          targetFeature = buffered; // Search boundary is buffered (larger)
          coreFeature = feature;     // Core is original (smaller)
        } else {
          targetFeature = feature;  // Search boundary is original (larger)
          coreFeature = buffered;   // Core is buffered (smaller)
        }
      } else {
        console.warn("Buffer returned undefined, falling back to original feature.");
      }
    } catch (e) {
      console.error("Failed to buffer feature:", e);
    }
  }

  if (!targetFeature) targetFeature = feature;
  if (!coreFeature) coreFeature = feature;

  const featureBbox = bbox(targetFeature);
  const [minLng, minLat, maxLng, maxLat] = featureBbox;

  // Deduplicate layers by date to avoid messy chart lines jumping back and forth
  const uniqueDateLayers = new Map<string, RasterLayer>();
  [...layers].forEach(l => {
    const d = l.datetime ? l.datetime.split('T')[0] : 'Unknown';
    const existing = uniqueDateLayers.get(d);
    if (!existing || (l.data && !existing.data)) {
      uniqueDateLayers.set(d, l);
    }
  });

  const sortedLayers = Array.from(uniqueDateLayers.values()).sort((a, b) => {
    const da = a.datetime ? new Date(a.datetime).getTime() : 0;
    const db = b.datetime ? new Date(b.datetime).getTime() : 0;
    return da - db;
  });

  const timeseries: PixelTimeseriesData[] = [];
  const excludedTimeseries: PixelTimeseriesData[] = [];
  const pointFeatures: any[] = [];
  const excludedPointFeatures: any[] = [];
  
  // Keep original buffer boundaries in both feature lists if applicable for styling
  if (bufferMeters !== 0) {
    const parentProps = feature?.properties || {};
    pointFeatures.push({
      type: "Feature",
      geometry: coreFeature.geometry || coreFeature,
      properties: { 
        ...parentProps,
        type: 'buffer_boundary' 
      }
    });
    excludedPointFeatures.push({
      type: "Feature",
      geometry: targetFeature.geometry || targetFeature,
      properties: {
        ...parentProps,
        type: 'buffer_boundary'
      }
    });
  }

  let validPixelsCache: { 
    signature: string; 
    pixels: {x: number, y: number, id: string, lng: number, lat: number}[];
    excludedPixels: {x: number, y: number, id: string, lng: number, lat: number}[];
  } | null = null;
  
  let pointsExtracted = false;

  for (const layer of sortedLayers) {
    if (!layer.data || !layer.data.bandData || !layer.data.metadata) continue;

    const { bandData, metadata } = layer.data;
    const { width, height, crs, originalBbox, originalWidth, originalHeight, windowOffsetX, windowOffsetY } = metadata;

    if (!originalBbox || !originalWidth || !originalHeight) continue;

    const signature = `${width}-${height}-${crs}-${originalBbox.join(',')}-${originalWidth}-${originalHeight}-${windowOffsetX}-${windowOffsetY}`;
    const dateStr = layer.datetime ? layer.datetime.split('T')[0] : 'Unknown';
    const rowData: PixelTimeseriesData = { date: dateStr };
    const excludedRowData: PixelTimeseriesData = { date: dateStr };

    if (validPixelsCache && validPixelsCache.signature === signature) {
      // Use cache for included
      for (const p of validPixelsCache.pixels) {
        const offset = p.y * width + p.x;
        const val = getPixelValue(bandData, offset, indexType);
        if (val !== null) {
          rowData[p.id] = val;
        }
      }
      timeseries.push(rowData);

      // Use cache for excluded
      for (const p of validPixelsCache.excludedPixels) {
        const offset = p.y * width + p.x;
        const val = getPixelValue(bandData, offset, indexType);
        if (val !== null) {
          excludedRowData[p.id] = val;
        }
      }
      excludedTimeseries.push(excludedRowData);
      continue;
    }

    // If no cache match, compute from scratch
    const resX = (originalBbox[2] - originalBbox[0]) / originalWidth;
    const resY = (originalBbox[3] - originalBbox[1]) / originalHeight;

    const nativeWidth = metadata.windowWidth || originalWidth;
    const nativeHeight = metadata.windowHeight || originalHeight;

    // Shared projection helper (see geo.ts)
    const unproject = (x: number, y: number): [number, number] => unprojectToWgs84(crs, x, y);

    let rowCounter = 0;
    const computedPixels: {x: number, y: number, id: string, lng: number, lat: number}[] = [];
    const computedExcludedPixels: {x: number, y: number, id: string, lng: number, lat: number}[] = [];

    // Restrict the scan to the pixels under the feature's bbox — scanning the
    // whole raster grid for every polygon makes extraction unusably slow on
    // large mosaics. Project the (padded) feature bbox into the raster CRS
    // and clamp the pixel loops to that window.
    const gridCrs = crs || 'EPSG:4326';
    const PAD = 0.0002;
    const corners = [
      projectToCrs(gridCrs, minLng - PAD, minLat - PAD),
      projectToCrs(gridCrs, minLng - PAD, maxLat + PAD),
      projectToCrs(gridCrs, maxLng + PAD, minLat - PAD),
      projectToCrs(gridCrs, maxLng + PAD, maxLat + PAD),
    ];
    const fMinX = Math.min(...corners.map(c => c[0]));
    const fMaxX = Math.max(...corners.map(c => c[0]));
    const fMinY = Math.min(...corners.map(c => c[1]));
    const fMaxY = Math.max(...corners.map(c => c[1]));
    const offX = windowOffsetX || 0;
    const offY = windowOffsetY || 0;
    const nyStart = Math.max(0, Math.floor((originalBbox[3] - fMaxY) / resY - 0.5) - offY - 1);
    const nyEnd = Math.min(nativeHeight, Math.ceil((originalBbox[3] - fMinY) / resY + 0.5) - offY + 1);
    const nxStart = Math.max(0, Math.floor((fMinX - originalBbox[0]) / resX - 0.5) - offX - 1);
    const nxEnd = Math.min(nativeWidth, Math.ceil((fMaxX - originalBbox[0]) / resX + 0.5) - offX + 1);

    for (let ny = nyStart; ny < nyEnd; ny++) {
      const absY = (windowOffsetY || 0) + ny;
      const nativeY = absY + 0.5;
      const crsY = originalBbox[3] - nativeY * resY;
    
      for (let nx = nxStart; nx < nxEnd; nx++) {
        rowCounter++;
        if (rowCounter % 5000 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }

        const absX = (windowOffsetX || 0) + nx;
        const nativeX = absX + 0.5;
        const crsX = originalBbox[0] + nativeX * resX;
      
        const [lng, lat] = unproject(crsX, crsY);
        
        // Fast bbox check with tolerance for pixel edges
        const tol = 0.0002;
        if (lng < minLng - tol || lng > maxLng + tol || lat < minLat - tol || lat > maxLat + tol) continue;

        let isInside = false;

        // Handle Point features differently than Polygon/MultiPolygon for search boundary
        if (targetFeature.geometry?.type === 'Point' || targetFeature.type === 'Point') {
          const coords = targetFeature.geometry?.coordinates || targetFeature.coordinates;
          if (coords) {
            const dist = Math.sqrt(Math.pow(lng - coords[0], 2) + Math.pow(lat - coords[1], 2));
            if (dist < 0.0001) isInside = true;
          }
        } else {
          // Classify by the pixel centre only. Corner sampling (any of the
          // 9 sub-points inside) let pixels up to half a pixel outside the
          // polygon slip in, which scatters dots beyond the boundary.
          isInside = booleanPointInPolygon([lng, lat], targetFeature);
        }

        if (isInside) {
          const ux = Math.min(width - 1, Math.floor((nx + 0.5) * (width / nativeWidth)));
          const uy = Math.min(height - 1, Math.floor((ny + 0.5) * (height / nativeHeight)));
          
          const pixelId = `p_${lng.toFixed(6)}_${lat.toFixed(6)}`.replace(/\./g, '_').replace(/-/g, 'm');
          const offset = uy * width + ux;
          const val = getPixelValue(bandData, offset, indexType);

          // Check if this pixel is inside the inner/core zone
          let isInsideCore = false;
          if (bufferMeters === 0) {
            isInsideCore = true;
          } else if (coreFeature.geometry?.type === 'Point' || coreFeature.type === 'Point') {
            const coords = coreFeature.geometry?.coordinates || coreFeature.coordinates;
            if (coords) {
              const dist = Math.sqrt(Math.pow(lng - coords[0], 2) + Math.pow(lat - coords[1], 2));
              if (dist < 0.0001) isInsideCore = true;
            }
          } else {
            isInsideCore = booleanPointInPolygon([lng, lat], coreFeature);
          }

          if (isInsideCore) {
            computedPixels.push({ x: ux, y: uy, id: pixelId, lng, lat });
            
            if (!pointsExtracted) {
              const parentProps = feature?.properties || {};
              const speciesVal = extractSpecies(parentProps);
              const originalId = feature?.id !== undefined ? feature.id : (parentProps.id !== undefined ? parentProps.id : (parentProps.ID !== undefined ? parentProps.ID : undefined));
              pointFeatures.push({
                type: "Feature",
                geometry: { type: "Point", coordinates: [lng, lat] },
                properties: { 
                  ...parentProps,
                  ...(originalId !== undefined ? { polygon_id: originalId } : {}),
                  id: pixelId,
                  ...(speciesVal ? { species: speciesVal } : {})
                }
              });
            }

            if (val !== null) {
              rowData[pixelId] = val;
            }
          } else {
            // Excluded/boundary pixels
            computedExcludedPixels.push({ x: ux, y: uy, id: pixelId, lng, lat });

            if (!pointsExtracted) {
              const parentProps = feature?.properties || {};
              const speciesVal = extractSpecies(parentProps);
              const originalId = feature?.id !== undefined ? feature.id : (parentProps.id !== undefined ? parentProps.id : (parentProps.ID !== undefined ? parentProps.ID : undefined));
              excludedPointFeatures.push({
                type: "Feature",
                geometry: { type: "Point", coordinates: [lng, lat] },
                properties: { 
                  ...parentProps,
                  ...(originalId !== undefined ? { polygon_id: originalId } : {}),
                  id: pixelId,
                  ...(speciesVal ? { species: speciesVal } : {})
                }
              });
            }

            if (val !== null) {
              excludedRowData[pixelId] = val;
            }
          }
        }
      }
    }
    
    // Save to cache
    validPixelsCache = { 
      signature, 
      pixels: computedPixels, 
      excludedPixels: computedExcludedPixels 
    };
    timeseries.push(rowData);
    excludedTimeseries.push(excludedRowData);
    pointsExtracted = true;
  }

  // Inject timeseries data into point features
  for (const pf of pointFeatures) {
    if (pf.properties && pf.properties.id && pf.properties.type !== 'buffer_boundary') {
      const pid = pf.properties.id;
      for (const row of timeseries) {
        if (row[pid] !== undefined && row.date !== 'Unknown') {
          pf.properties[`${indexType}_${row.date}`] = row[pid];
        }
      }
    }
  }

  // Inject timeseries data into excluded point features
  for (const pf of excludedPointFeatures) {
    if (pf.properties && pf.properties.id && pf.properties.type !== 'buffer_boundary') {
      const pid = pf.properties.id;
      for (const row of excludedTimeseries) {
        if (row[pid] !== undefined && row.date !== 'Unknown') {
          pf.properties[`${indexType}_${row.date}`] = row[pid];
        }
      }
    }
  }

  return {
    timeseries,
    pixelPoints: {
      type: "FeatureCollection",
      features: pointFeatures
    },
    excludedTimeseries,
    excludedPixelPoints: {
      type: "FeatureCollection",
      features: excludedPointFeatures
    }
  };
}
