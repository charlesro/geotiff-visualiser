
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
