
export interface STACItem {
  id: string;
  collection: string;
  geometry: any;
  bbox: number[];
  properties: {
    datetime: string;
    'eo:cloud_cover': number;
    [key: string]: any;
  };
  assets: {
    [key: string]: {
      href: string;
      title?: string;
      type?: string;
      roles?: string[];
    };
  };
  groupItems?: STACItem[];
}

export interface STACSearchResponse {
  type: string;
  features: STACItem[];
  links: any[];
}

const MPC_STAC_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';

export async function searchSentinel2(
  bbox: [number, number, number, number],
  startDate: string,
  endDate: string,
  maxCloudCover: number = 10,
  token?: string,
  limit: number = 10
): Promise<STACItem[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Ocp-Apim-Subscription-Key'] = token;
  }

  const startStr = startDate.includes('T') ? startDate : `${startDate}T00:00:00Z`;
  const endStr = endDate.includes('T') ? endDate : `${endDate}T23:59:59Z`;

  const body: any = {
    collections: ['sentinel-2-l2a'],
    bbox: bbox,
    datetime: `${startStr}/${endStr}`,
    limit: limit,
    sortby: [
      {
        field: 'properties.datetime',
        direction: 'desc',
      },
    ],
  };

  if (maxCloudCover < 100) {
    body.query = {
      'eo:cloud_cover': {
        lte: maxCloudCover,
      },
    };
  }

  const response = await fetch(MPC_STAC_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error('Failed to search STAC API');
  }

  const data: STACSearchResponse = await response.json();
  return data.features;
}

/**
 * Shared search pipeline.
 *
 * "Search Images" and "Fetch time series" previously each copy-pasted the
 * same chunked-search -> dedupe -> group-by-date -> evenly-spaced-selection
 * pipeline inside App.tsx. It now lives here, once.
 */

export interface ChunkedSearchOptions {
  numChunks?: number;
  limit?: number;
  onChunkStart?: (index: number, total: number, intervalStart: string, intervalEnd: string) => void;
  onChunkResult?: (index: number, total: number, count: number) => void;
  onChunkError?: (index: number, err: any) => void;
}

/**
 * Search a date range in N sub-intervals (rate-limit friendly) and
 * deduplicate results by STAC item id.
 */
export async function searchSentinel2Chunked(
  bbox: [number, number, number, number],
  startDate: string,
  endDate: string,
  maxCloudCover: number,
  token?: string,
  options: ChunkedSearchOptions = {}
): Promise<STACItem[]> {
  const startStr = startDate.includes('T') ? startDate : `${startDate}T00:00:00Z`;
  const endStr = endDate.includes('T') ? endDate : `${endDate}T23:59:59Z`;
  const startMs = new Date(startStr).getTime();
  const endMs = new Date(endStr).getTime();

  if (isNaN(startMs) || isNaN(endMs)) {
    throw new Error('Invalid date format provided.');
  }

  const numChunks = options.numChunks ?? 6;
  const intervalMs = (endMs - startMs) / numChunks;

  const allResults: STACItem[] = [];
  for (let i = 0; i < numChunks; i++) {
    const intervalStart = new Date(startMs + i * intervalMs).toISOString();
    const intervalEnd = new Date(startMs + (i + 1) * intervalMs).toISOString();

    try {
      options.onChunkStart?.(i, numChunks, intervalStart, intervalEnd);
      const chunkResults = await searchSentinel2(bbox, intervalStart, intervalEnd, maxCloudCover, token, options.limit ?? 500);
      options.onChunkResult?.(i, numChunks, chunkResults.length);
      allResults.push(...chunkResults);
    } catch (err) {
      console.error(`Error fetching interval ${i}:`, err);
      options.onChunkError?.(i, err);
    }
  }

  // Deduplicate by STAC Item ID
  const uniqueItemsMap = new Map<string, STACItem>();
  allResults.forEach(item => {
    uniqueItemsMap.set(item.id, item);
  });
  return Array.from(uniqueItemsMap.values());
}

/**
 * Group items by acquisition date so a single overpass split across adjacent
 * tiles becomes one logical item (all tiles kept in `groupItems`, the least
 * cloudy one acting as the representative). Sorted newest first.
 */
export function groupItemsByDate(items: STACItem[]): (STACItem & { groupItems?: STACItem[] })[] {
  const uniqueDates = new Map<string, STACItem & { groupItems?: STACItem[] }>();
  items.forEach(item => {
    const date = item.properties.datetime.split('T')[0];
    if (!uniqueDates.has(date)) {
      const newItem = { ...item, groupItems: [item] };
      uniqueDates.set(date, newItem);
    } else {
      const existing = uniqueDates.get(date)!;
      existing.groupItems = existing.groupItems || [];
      existing.groupItems.push(item);
      if (item.properties['eo:cloud_cover'] < existing.properties['eo:cloud_cover']) {
        const group = existing.groupItems;
        Object.assign(existing, item);
        existing.groupItems = group;
      }
    }
  });

  return Array.from(uniqueDates.values())
    .sort((a, b) => new Date(b.properties.datetime).getTime() - new Date(a.properties.datetime).getTime());
}

/** Pick n entries evenly spaced across an ordered array. */
export function selectEvenlySpaced<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  const selected: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    selected.push(arr[Math.round(i * step)]);
  }
  return selected;
}

const tokenCache: Record<string, { token: string, expiresAt: number }> = {};

export async function signUrl(url: string, token?: string): Promise<string> {
  // Only sign blob storage URLs
  if (!url.includes('blob.core.windows.net')) {
    return url;
  }
  
  // Strip existing SAS token if present to ensure we get a fresh one
  const baseUrl = url.split('?')[0];
  
  let attempts = 0;
  while (attempts < 3) {
    try {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Ocp-Apim-Subscription-Key'] = token;
      }

      // Fallback: Try the token endpoint first as it's more reliable and efficient
      // URL format: https://<account>.blob.core.windows.net/<container>/<path>
      const match = baseUrl.match(/https:\/\/([^.]+)\.blob\.core\.windows\.net\/([^/]+)\//);
      if (match) {
        const account = match[1];
        const container = match[2];
        const cacheKey = `${account}/${container}`;

        // Check cache (tokens usually valid for at least an hour, let's cache for 45 mins)
        if (tokenCache[cacheKey] && tokenCache[cacheKey].expiresAt > Date.now()) {
          return `${baseUrl}?${tokenCache[cacheKey].token}`;
        }

        const tokenEndpoint = `https://planetarycomputer.microsoft.com/api/sas/v1/token/${account}/${container}`;
        
        console.log(`Attempting to sign via token endpoint for ${account}/${container}...`);
        const tokenResponse = await fetch(tokenEndpoint, { headers });
        
        if (tokenResponse.ok) {
          const tokenData = await tokenResponse.json();
          if (tokenData.token) {
            tokenCache[cacheKey] = {
              token: tokenData.token,
              expiresAt: Date.now() + 45 * 60 * 1000 // 45 minutes
            };
            const signedUrl = `${baseUrl}?${tokenData.token}`;
            console.log(`Successfully signed URL via /token.`);
            return signedUrl;
          }
        }
      }

      // Secondary: Try the standard sign endpoint (expects 'href' parameter)
      let signEndpoint = `https://planetarycomputer.microsoft.com/api/sas/v1/sign?href=${encodeURIComponent(baseUrl)}`;
      
      console.log(`Attempting to sign URL via /sign: ${baseUrl.substring(0, 60)}...`);
      let response = await fetch(signEndpoint, { headers });
      
      if (response.ok) {
        const data = await response.json();
        if (data.href && data.href.includes('?')) {
          console.log(`Successfully signed URL via /sign.`);
          return data.href;
        }
      }
      
      const errorText = await response.text();
      throw new Error(`All signing methods failed for ${baseUrl}. Status: ${response.status} ${errorText}`);
    } catch (e) {
      console.warn(`Error signing URL ${baseUrl} (Attempt ${attempts + 1}):`, e);
    }
    
    attempts++;
    if (attempts < 3) {
      await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
    }
  }
  throw new Error(`All signing methods failed after 3 attempts for ${baseUrl}`);
}

export async function signSTACItem(item: STACItem, token?: string): Promise<STACItem> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Ocp-Apim-Subscription-Key'] = token;
  }

  let attempts = 0;
  while (attempts < 3) {
    try {
      console.log(`Attempting bulk signing for item: ${item.id} (Attempt ${attempts + 1})`);
      const response = await fetch('https://planetarycomputer.microsoft.com/api/sas/v1/sign', {
        method: 'POST',
        headers,
        body: JSON.stringify(item),
      });

      if (response.ok) {
        const signedItem = await response.json();
        const isSigned = Object.values(signedItem.assets).some((a: any) => a.href.includes('?'));
        if (isSigned) {
          console.log(`Bulk signing successful for item: ${item.id}`);
          return signedItem;
        }
        console.warn(`Bulk signing returned unsigned URLs. Breaking immediately to fallback.`);
        break; // If unsigned due to rate limit, fallback is faster than retrying
      } else {
        const errorText = await response.text();
        console.warn(`Bulk signing failed (Status ${response.status}): ${errorText}`);
      }
    } catch (e) {
      console.warn(`Bulk signing network error:`, e);
    }
    
    attempts++;
    if (attempts < 3) {
      await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
    }
  }

  console.warn(`Bulk signing completely failed for: ${item.id}. Falling back to individual signing...`);
  const signedItem = JSON.parse(JSON.stringify(item));
  const assetKeys = Object.keys(signedItem.assets);
  
  // Apply tokens to assets using signUrl (which now has a global cache)
  for (const key of assetKeys) {
    const asset = signedItem.assets[key];
    if (asset.href.includes('blob.core.windows.net')) {
      try {
        asset.href = await signUrl(asset.href, token);
      } catch (e) {
        console.warn(`Final individual signing failed for ${key}:`, e);
      }
    }
  }

  return signedItem;
}
