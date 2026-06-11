import { PCA } from 'ml-pca';
import { RasterLayer } from '../types';

export async function computeNDVIPCA(layers: RasterLayer[]): Promise<string> {
  if (layers.length === 0) throw new Error('No layers provided for PCA.');
  if (layers.length < 3) throw new Error('Need at least 3 layers for a 3-component PCA. Please fetch more images.');

  const width = layers[0].data.metadata.width;
  const height = layers[0].data.metadata.height;
  const pixelCount = width * height;

  // Verify all layers have same dimensions
  for (const layer of layers) {
    if (layer.data.metadata.width !== width || layer.data.metadata.height !== height) {
      throw new Error(`Layer dimensions mismatch: expected ${width}x${height}, got ${layer.data.metadata.width}x${layer.data.metadata.height}. Please select a consistent area before fetching.`);
    }
  }

  // matrix rows = pixels, cols = time step
  const dataset: number[][] = [];
  const validPixelIndices: number[] = [];

  for (let i = 0; i < pixelCount; i++) {
    let isValid = true;
    const row: number[] = [];

    // Check this pixel across all time steps
    for (const layer of layers) {
      const bandDataRecord = layer.data.bandData;
      if (!bandDataRecord) {
        isValid = false; break;
      }
      
      const b4Array = bandDataRecord['B04'];
      const b8Array = bandDataRecord['B08'];

      if (!b4Array || !b8Array || b4Array[i] === undefined || b8Array[i] === undefined) {
          isValid = false; break;
      }
      
      const red = b4Array[i];
      const nir = b8Array[i];

      if (red + nir === 0 || isNaN(red) || isNaN(nir)) {
        isValid = false;
        break;
      }

      const ndvi = (nir - red) / (nir + red);
      row.push(ndvi);
    }

    if (isValid) {
      dataset.push(row);
      validPixelIndices.push(i);
    }
  }

  if (dataset.length < 3) {
    throw new Error('Not enough valid pixels (no clouds/nodata) across the ENTIRE time series to perform PCA. Try selecting fewer images or an area with less cloud cover.');
  }

  const pca = new PCA(dataset);
  const projected = pca.predict(dataset, { nComponents: 3 });
  const pcArray = projected.to2DArray();
  
  const minVals = [Infinity, Infinity, Infinity];
  const maxVals = [-Infinity, -Infinity, -Infinity];

  for (let r = 0; r < pcArray.length; r++) {
    for (let c = 0; c < 3; c++) {
      let val = pcArray[r][c];
      if (val === undefined) val = 0; 
      if (val < minVals[c]) minVals[c] = val;
      if (val > maxVals[c]) maxVals[c] = val;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2d context for PCA output');
  
  const imgData = ctx.createImageData(width, height);
  for (let i = 0; i < pixelCount * 4; i+=4) {
    imgData.data[i] = 0;
    imgData.data[i+1] = 0;
    imgData.data[i+2] = 0;
    imgData.data[i+3] = 0;
  }

  for (let i = 0; i < dataset.length; i++) {
    const pixelIndex = validPixelIndices[i];
    const rIdx = pixelIndex * 4;
    
    const pc1 = pcArray[i][0] || 0;
    const pc2 = pcArray[i][1] || 0;
    const pc3 = pcArray[i][2] || 0;

    const r = ((pc1 - minVals[0]) / (maxVals[0] - minVals[0])) * 255;
    const g = ((pc2 - minVals[1]) / (maxVals[1] - minVals[1])) * 255;
    const b = ((pc3 - minVals[2]) / (maxVals[2] - minVals[2])) * 255;

    // Use a small stretch or just direct mapping
    imgData.data[rIdx] = Math.round(r);
    imgData.data[rIdx + 1] = Math.round(g);
    imgData.data[rIdx + 2] = Math.round(b);
    imgData.data[rIdx + 3] = 255; 
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL();
}
