import { RasterLayer } from '../types';
import { GeoTIFFData } from './geotiff-utils';

/**
 * IndexedDB cache so the workflow survives page reloads (refresh, dev
 * updates): the loaded polygons, the selection and the fetched Sentinel-2
 * series are saved as they change and restored on startup. Typed arrays
 * (band data) clone natively into IndexedDB; canvases do not, so scenes are
 * stripped of their `image` canvas on save (the map uses the derived
 * `dataUrl` string, the analysis uses `bandData`) and get a 1×1 placeholder
 * back on restore.
 */

const DB_NAME = 'ppca-cache';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export async function cacheSet(key: string, value: any): Promise<void> {
  try {
    await withStore('readwrite', s => s.put(value, key));
  } catch (e) {
    // Quota or clone failure — the app still works, it just won't survive a
    // reload. Don't break the workflow over it.
    console.warn(`Cache write failed for "${key}":`, e);
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const v = await withStore<T>('readonly', s => s.get(key) as IDBRequest<T>);
    return v ?? null;
  } catch (e) {
    console.warn(`Cache read failed for "${key}":`, e);
    return null;
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    await withStore('readwrite', s => s.delete(key));
  } catch {
    /* ignore */
  }
}

export async function cacheClear(): Promise<void> {
  try {
    await withStore('readwrite', s => s.clear());
  } catch {
    /* ignore */
  }
}

// ----- Scene (de)serialization ------------------------------------------------

const stripGrid = (g: GeoTIFFData): any => ({ ...g, image: null });

const placeholderCanvas = (): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  return c;
};

/** Shallow copies without the canvases — cheap, band arrays are shared. */
export function serializeScenes(scenes: RasterLayer[]): any[] {
  return scenes.map(s => ({
    ...s,
    data: stripGrid(s.data),
    analysisGrids: s.analysisGrids?.map(stripGrid),
  }));
}

export function reviveScenes(raw: any[]): RasterLayer[] {
  return raw.map(s => ({
    ...s,
    data: { ...s.data, image: placeholderCanvas() },
    analysisGrids: s.analysisGrids?.map((g: any) => ({ ...g, image: placeholderCanvas() })),
  }));
}
