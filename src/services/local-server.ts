/**
 * Client for the optional local Python engine.
 *
 * App.tsx and LocalPythonServerModal.tsx previously each had their own URL
 * normalisation and tunnel-bypass headers on every fetch call. All
 * communication with the local server now goes through this module.
 */

/** Headers required to pass through ngrok/localtunnel style proxies. */
export const LOCAL_SERVER_HEADERS: Record<string, string> = {
  'Bypass-Tunnel-Reminder': 'true',
  'ngrok-skip-browser-warning': 'true'
};

/**
 * Upgrade http -> https when the app itself is served over https
 * (mixed content would be blocked), except for localhost.
 */
export function normalizeLocalUrl(urlStr: string): string {
  if (!urlStr) return urlStr;
  if (window.location.protocol === 'https:' && urlStr.startsWith('http://')) {
    const isLocalhost = urlStr.includes('localhost') || urlStr.includes('127.0.0.1');
    if (!isLocalhost) {
      return urlStr.replace(/^http:\/\//i, 'https://');
    }
  }
  return urlStr;
}

/**
 * Fetch an absolute URL, adding the tunnel-bypass headers only for
 * non-localhost servers. On localhost the extra headers would just trigger a
 * CORS preflight the engine may reject.
 */
export function fetchWithLocalHeaders(url: string, init: RequestInit = {}): Promise<Response> {
  const normalized = normalizeLocalUrl(url);
  const isLocalhost = normalized.includes('localhost') || normalized.includes('127.0.0.1');
  return fetch(normalized, {
    ...init,
    headers: { ...(isLocalhost ? {} : LOCAL_SERVER_HEADERS), ...(init.headers || {}) }
  });
}

/** Fetch a path relative to the configured local server base URL. */
export function fetchLocalServer(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithLocalHeaders(`${normalizeLocalUrl(baseUrl)}${path}`, init);
}

/** GET /api/status — throws when the server is unreachable or unhealthy. */
export async function checkLocalServerStatus(baseUrl: string): Promise<any> {
  const ping = await fetchLocalServer(baseUrl, '/api/status');
  if (!ping.ok) {
    throw new Error(`Local Python Engine status check returned HTTP ${ping.status} (${ping.statusText || 'Not OK'}).`);
  }
  return ping.json();
}

/** GET /files — list GeoTIFF/parquet files served from the server's DATA_DIR. */
export async function listLocalFiles(baseUrl: string): Promise<string[]> {
  const response = await fetchLocalServer(baseUrl, '/files');
  if (!response.ok) throw new Error('Failed to fetch files');
  return response.json();
}

/** POST /query — run a DuckDB SQL query. */
export async function runLocalQuery(baseUrl: string, query: string, signal?: AbortSignal): Promise<any> {
  const response = await fetchLocalServer(baseUrl, '/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal
  });
  const data = await response.json();
  if (!response.ok || data.status === 'error') {
    throw new Error(data.message || 'Error executing query');
  }
  return data;
}

/** Absolute URL for a file served by the local server. */
export const localFileUrl = (baseUrl: string, filename: string): string =>
  `${normalizeLocalUrl(baseUrl)}/files/${filename}`;
