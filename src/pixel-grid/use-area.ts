import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { polyBbox, type Poly } from './geometry';
import type { LngLatBounds } from './s2-grid';
import { isLngLat, isNum, readSaved, removeSaved, shape, usePersistentState, writeSaved } from './persist';

/**
 * Step 1: which field are we looking at, and how did the user say so.
 *
 * Two independent concerns, deliberately two hooks: the AOI itself (drawn,
 * traced, or restored from the pinned default) and the place search that moves
 * the map to go find it. Neither knows anything about the pixel grid.
 *
 * BOTH are called by the page SHELL, never from inside a `<Step>` child: `Step`
 * unmounts collapsed children, so a half-typed query or a pinned-default badge
 * would be wiped the moment the step closed.
 */

/** A field near Lonzée (Gembloux), so the tool opens with a grid already drawn. */
const DEFAULT_AOI: LngLatBounds = [4.6882, 50.5489, 4.6918, 50.5511];

/** A user-pinned default field, persisted in the browser so it survives reloads. */
const FIELD_KEY = 'pixelGrid.defaultField';
const loadDefaultField = (): { aoi: LngLatBounds; aoiPoly: [number, number][] | null } | null => {
  try {
    const f = JSON.parse(localStorage.getItem(FIELD_KEY) || 'null');
    if (Array.isArray(f?.aoi) && f.aoi.length === 4 && f.aoi.every((n: any) => typeof n === 'number'))
      return { aoi: f.aoi, aoiPoly: Array.isArray(f.aoiPoly) ? f.aoiPoly : null };
  } catch { /* corrupt or unavailable: ignore */ }
  return null;
};

/** The two halves of a field, validated the same way wherever they are read. */
const isAoi = (v: unknown) => v === null || (Array.isArray(v) && v.length === 4 && v.every(isNum));
const isRing = (v: unknown) => v === null || (Array.isArray(v) && v.length >= 3 && v.every(isLngLat));

/**
 * The field as the USER last set it, kept while something else is driving it.
 *
 * An imported trial takes the field over: the field becomes the trial's own
 * outline, so the pixel count, the purity, the PCA and the export describe the
 * trial's pixels, and it moves again every time the trial is turned. Both `aoi`
 * and `aoiPoly` are persisted, so before this the traced shape was simply gone
 * the moment a file was dropped, refresh included, with no way back.
 *
 * Written ONCE, when the field is first taken over, and forgotten as soon as the
 * user says what the field is again (a new drawing, or clearing it): after that
 * there is nothing older to go back to.
 */
const PRE_TRIAL = 'fieldBeforeTrial';
const isSavedField = shape({ aoi: isAoi, aoiPoly: isRing });

interface Suggestion {
  label: string;
  lat: number;
  lon: number;
  /** [west, south, east, north] when the place has an extent. */
  bbox?: [number, number, number, number];
}

/** The experiment area: drawing it, tracing it, clearing it, pinning it. */
export function useAoiField(onDrawComplete: (step: 'grid') => void) {
  const [drawKind, setDrawKind] = useState<null | 'rect' | 'poly'>(null);
  const drawMode = drawKind !== null;
  // The CURRENT field comes back on refresh. The pinned default (★) is what a
  // brand-new browser, or Reset, opens on, and the demo field near Lonzee is
  // the last resort. `null` is a real saved value: the user cleared the field.
  const [boxAoi, setAoi] = usePersistentState<LngLatBounds | null>('aoi', () => loadDefaultField()?.aoi ?? DEFAULT_AOI, isAoi);
  // field shape (null = plain rectangle = aoi)
  const [aoiPoly, setAoiPoly] = usePersistentState<Poly | null>('aoiPoly', () => loadDefaultField()?.aoiPoly ?? null, isRing);
  /**
   * The field's box. DERIVED from the ring whenever there is one, never read
   * back from its own save.
   *
   * Every writer below sets the two together, `setAoi(polyBbox(pts))` beside
   * `setAoiPoly(pts)`, so the box is the ring's bounding box wherever a ring
   * exists at all: it is not independent information. They were two saved keys
   * though, restored by two `usePersistentState` calls that each fall back to
   * their own default on their own, and one reload came back with the traced
   * ring next to a box that had reverted to the demo field, 811 km away.
   *
   * Nothing downstream noticed, because each part reads whichever one it wants:
   * the grid is built over the BOX and the field test uses the RING, so every
   * pixel failed it. Step 1 said "10,965 m2 field", step 2 said "0 px", the PCA
   * said 16,506 px, and the map drew no grid. Deriving it makes that state
   * unrepresentable rather than merely unlikely, and repairs a split already
   * saved in a browser the next time the page opens.
   */
  const aoi = useMemo(() => (aoiPoly ? polyBbox(aoiPoly) : boxAoi), [aoiPoly, boxAoi]);
  const [defaultSaved, setDefaultSaved] = useState<boolean>(() => !!loadDefaultField());
  // Map opens centred on the restored field (only read once, at mount).
  const initialCenter = useMemo<[number, number]>(() => {
    const f = aoi ?? DEFAULT_AOI; // the restored field, as of the first render
    return [(f[1] + f[3]) / 2, (f[0] + f[2]) / 2];
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The field as it stands, for the take-over below. A REF written in an effect,
   * never state: the two setters must stay stable (the drawers list them in
   * effect deps), and nothing here may write state on mount, where `aoi` has
   * just been restored.
   */
  const fieldNow = useRef({ aoi, aoiPoly });
  useEffect(() => { fieldNow.current = { aoi, aoiPoly }; }, [aoi, aoiPoly]);
  /** Only the FIRST take-over is remembered, even when that save failed (see PRE_TRIAL). */
  const tookOver = useRef(false);
  /** The user has just said what the field is: there is nothing older to go back to. */
  const forgetPreTrial = useCallback(() => { removeSaved(PRE_TRIAL); tookOver.current = false; }, []);

  // `onDrawComplete` MUST have a stable identity (the shell passes setActiveStep
  // itself, never an inline arrow): RectDrawer and PolyDrawer list `onDone` in
  // their effect deps and reset the in-progress geometry on cleanup, so a fresh
  // identity mid-trace erases the vertices the user has already dropped.
  const onDrawDone = useCallback((b: LngLatBounds) => {
    setAoi(b);
    setAoiPoly(null);
    setDrawKind(null);
    forgetPreTrial();
    onDrawComplete('grid');
  }, []);
  const onPolyDone = useCallback((pts: Poly) => {
    setAoi(polyBbox(pts));
    setAoiPoly(pts);
    setDrawKind(null);
    forgetPreTrial();
    onDrawComplete('grid');
  }, []);

  const startDraw = (kind: 'rect' | 'poly') => setDrawKind(kind);
  const cancelDraw = () => setDrawKind(null);
  const clearAoi = () => { setAoi(null); setAoiPoly(null); setDrawKind(null); forgetPreTrial(); };

  /**
   * Let something else set the field from its own geometry (an imported trial's
   * outline), remembering the user's field so `restoreFieldBeforeTrial` can put
   * it back. Every later call - turning the trial moves its outline - overwrites
   * the field but never the memory of what was there first.
   */
  const setFieldFromTrial = useCallback((ring: Poly) => {
    if (!tookOver.current && readSaved(PRE_TRIAL, isSavedField) === undefined) writeSaved(PRE_TRIAL, fieldNow.current);
    tookOver.current = true;
    setAoiPoly(ring);
    setAoi(polyBbox(ring));
  }, []);
  /** Put the user's own field back when the trial is removed. False when there is none. */
  const restoreFieldBeforeTrial = useCallback((): boolean => {
    const prev = readSaved<{ aoi: LngLatBounds | null; aoiPoly: Poly | null }>(PRE_TRIAL, isSavedField);
    forgetPreTrial();
    if (!prev) return false;
    setAoi(prev.aoi);
    setAoiPoly(prev.aoiPoly);
    return true;
  }, []);
  const saveDefaultField = () => {
    if (!aoi) return;
    try { localStorage.setItem(FIELD_KEY, JSON.stringify({ aoi, aoiPoly })); setDefaultSaved(true); } catch { /* storage full/blocked */ }
  };
  const clearDefaultField = () => { try { localStorage.removeItem(FIELD_KEY); } catch { /* ignore */ } setDefaultSaved(false); };

  // Esc backs out of draw mode if it was started by mistake.
  useEffect(() => {
    if (!drawMode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawKind(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawMode]);

  /**
   * The field as a closed ring, however it was drawn: the traced polygon, or the
   * box's own four corners.
   *
   * Anything generated in a ROTATED frame (the crop-strip pattern) covers the
   * bounding box of the rotated corners, which is strictly larger than the field
   * whenever the rotation is non-zero. Clipping needs a ring to clip against, and
   * before this a plain box AOI supplied none, so the strips spilled outside it.
   * Memoised because TruthOverlay lists it in an effect dependency array.
   */
  const fieldRing = useMemo<Poly | null>(() => {
    if (aoiPoly) return aoiPoly;
    if (!aoi) return null;
    const [w, s, e, n] = aoi;
    return [[w, s], [e, s], [e, n], [w, n]];
  }, [aoi, aoiPoly]);

  return { aoi, setAoi, aoiPoly, setAoiPoly, fieldRing, drawKind, drawMode, defaultSaved, initialCenter,
           onDrawDone, onPolyDone, startDraw, cancelDraw, clearAoi, saveDefaultField, clearDefaultField,
           setFieldFromTrial, restoreFieldBeforeTrial };
}

/** Type-ahead place lookup. `flyTo` comes from the shell, which owns the map ref. */
export function usePlaceSearch(flyTo: (lat: number, lon: number, bbox?: [number, number, number, number]) => void) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const lastPicked = useRef('');

  // Debounced place autocomplete via Photon (an OSM geocoder built for type-ahead).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || q === lastPicked.current) { setSuggestions([]); setShowSuggestions(false); return; }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`;
        const r = await fetch(url, { signal: ctrl.signal });
        const data = await r.json();
        const list: Suggestion[] = (data.features ?? [])
          .map((f: any) => {
            const p = f.properties ?? {};
            const [lon, lat] = f.geometry?.coordinates ?? [];
            const parts = [p.name, p.city || p.county, p.state, p.country].filter(Boolean);
            const label = parts.filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(', ');
            const e = p.extent; // [west, north, east, south]
            const bbox = Array.isArray(e) ? ([e[0], e[3], e[2], e[1]] as [number, number, number, number]) : undefined;
            return { label, lat, lon, bbox } as Suggestion;
          })
          .filter((s: Suggestion) => s.label && Number.isFinite(s.lat) && Number.isFinite(s.lon));
        const seen = new Set<string>();
        const deduped = list.filter(s => (seen.has(s.label) ? false : (seen.add(s.label), true)));
        setSuggestions(deduped);
        setShowSuggestions(true);
        setActiveSuggestion(-1);
      } catch { /* aborted or offline: leave current suggestions */ }
    }, 300);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [query]);

  const pickSuggestion = (s: Suggestion) => {
    lastPicked.current = s.label;
    setQuery(s.label);
    setSuggestions([]);
    setShowSuggestions(false);
    setActiveSuggestion(-1);
    flyTo(s.lat, s.lon, s.bbox);
  };

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (suggestions.length) {
      pickSuggestion(suggestions[activeSuggestion >= 0 ? activeSuggestion : 0]);
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || !suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveSuggestion(i => Math.min(suggestions.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveSuggestion(i => Math.max(0, i - 1)); }
    else if (e.key === 'Escape') { setShowSuggestions(false); }
  };

  return { query, setQuery, suggestions, showSuggestions, setShowSuggestions,
           activeSuggestion, setActiveSuggestion, pickSuggestion, onSearch, onSearchKeyDown };
}

export type { Suggestion };
