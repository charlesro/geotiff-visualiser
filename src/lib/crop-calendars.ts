/**
 * Wallonia crop cultural-calendar knowledge base.
 *
 * `public/crop-calendars.json` holds, per crp_lbl, the crop's known green-canopy
 * window (greenStart..greenEnd, MM-DD) in Wallonia — the period Sentinel-2 NDVI
 * should show growth. 56 of the 81 entries were web-researched from Belgian
 * agronomic sources (CRA-W Livre Blanc Céréales, CIPF, Fiwap/CARAH, IRBAB,
 * agriculture.wallonie.be, …; `source: "researched"` with `sources` URLs); the
 * remaining 25 low-frequency crops are filled from established NW-European
 * agronomy (`source: "agronomic-knowledge"`, lower confidence).
 *
 * The window is used to filter growth SCENARIOS: a cluster whose detected NDVI
 * window falls off the crop's known calendar is likely a mislabel or a different
 * actual crop, so it can be dropped from the analysis (see phenology.ts
 * `matchesCropCalendar` / `seasonFromPicks({ matchOnly: true })`).
 */

/**
 * The richer on-disk shape: a structural superset of phenology.ts's
 * `CropCalendar`, so a book can be passed straight to the season detector.
 *
 * Only the window fields are read by the app. The rest is provenance carried in
 * the JSON so an entry can be traced back and revised — it is part of the file's
 * schema, and is typed here so that file stays checkable.
 */
export interface CropCalendarEntry {
  regime: string;
  greenStart: string;
  greenEnd: string;
  peakStart?: string;
  peakEnd?: string;
  practice?: string;
  confidence?: 'high' | 'medium' | 'low';
  source?: 'researched' | 'agronomic-knowledge';
  sources?: string[];
}
export type CropCalendarBook = Record<string, CropCalendarEntry>;

let cache: Promise<CropCalendarBook> | null = null;

/** Fetch the calendar book once; subsequent calls reuse the same promise. */
export function loadCropCalendars(): Promise<CropCalendarBook> {
  if (!cache) {
    cache = fetch('./crop-calendars.json')
      .then(r => {
        if (!r.ok) throw new Error(`crop-calendars.json: ${r.status}`);
        return r.json() as Promise<CropCalendarBook>;
      })
      .catch(err => {
        cache = null; // don't cache a failure — let the next call retry
        throw err;
      });
  }
  return cache;
}
