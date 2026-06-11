/**
 * The time-series property convention shared by every feature.
 *
 * Pixel extraction writes values onto GeoJSON feature properties as
 * `<metric>_<YYYY-MM-DD>` (e.g. "NDVI_2024-05-01"). The feature panel chart,
 * the PCA modal, the SQL result table and App's date-removal logic all read
 * that convention back. This module is the single definition of it —
 * previously each of those features had its own private regex.
 */

export const TS_COLUMN_REGEX = /^(.*?)_{1,2}(\d{4}-\d{2}-\d{2})$/;

/** True if a property key follows the `<metric>_<date>` convention. */
export const isTsColumn = (c: string): boolean => /_{1,2}(\d{4}-\d{2}-\d{2})$/.test(c);

/** Split a time-series property key into its metric and date parts. */
export const parseTsColumn = (c: string): { metric: string; date: string } | null => {
  const match = c.match(TS_COLUMN_REGEX);
  if (match) return { metric: match[1], date: match[2] };
  return null;
};

export const getTsDate = (c: string): string | null => parseTsColumn(c)?.date || null;
export const getTsMetric = (c: string): string | null => parseTsColumn(c)?.metric || null;

/** Distinct metrics present in a list of property keys. */
export const getTsMetrics = (cols: string[]): string[] => {
  const metrics = new Set<string>();
  for (const c of cols) {
    const parsed = parseTsColumn(c);
    if (parsed) metrics.add(parsed.metric);
  }
  return Array.from(metrics);
};

/** True if a vector layer carries at least one time-series property. */
export const vectorLayerHasTimeSeries = (layer: any): boolean => {
  if (layer.type !== 'vector' || !layer.data || !layer.data.features || layer.data.features.length === 0) return false;
  return layer.data.features.some((f: any) => {
    if (!f.properties) return false;
    return Object.keys(f.properties).some(isTsColumn);
  });
};

/**
 * Remove every `<metric>_<date>` property for the given date from a list of
 * GeoJSON features. Untouched features are returned by reference so React
 * state diffs stay cheap.
 */
export const removeDateProperties = (features: any[], dateToRemove: string): any[] =>
  features.map((f: any) => {
    if (!f.properties) return f;
    const newProps = { ...f.properties };
    let changed = false;
    Object.keys(newProps).forEach(k => {
      const parsed = parseTsColumn(k);
      if (parsed && parsed.date === dateToRemove) {
        delete newProps[k];
        changed = true;
      }
    });
    return changed ? { ...f, properties: newProps } : f;
  });

/** Extract an ISO datetime from a filename (YYYYMMDD-HHMMSS, YYYYMMDD or YYYY-MM-DD). */
export const extractDateFromFilename = (filename: string): string | undefined => {
  // Match YYYYMMDD-HHMMSS or YYYYMMDDTHHMMSS
  const match1 = filename.match(/(\d{4})(\d{2})(\d{2})[-T](\d{2})(\d{2})(\d{2})/);
  if (match1) {
    const [_, year, month, day, hour, minute, second] = match1;
    const parsed = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
    if (!isNaN(new Date(parsed).getTime())) return parsed;
  }

  // Match YYYYMMDD
  const match2 = filename.match(/(\d{4})(\d{2})(\d{2})/);
  if (match2) {
    const [_, year, month, day] = match2;
    if (parseInt(month) >= 1 && parseInt(month) <= 12 && parseInt(day) >= 1 && parseInt(day) <= 31) {
      const parsed = `${year}-${month}-${day}T00:00:00Z`;
      if (!isNaN(new Date(parsed).getTime())) return parsed;
    }
  }

  // Match YYYY-MM-DD
  const match3 = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match3) {
    const parsed = `${match3[0]}T00:00:00Z`;
    if (!isNaN(new Date(parsed).getTime())) return parsed;
  }

  return undefined;
};
