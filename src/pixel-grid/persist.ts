import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * What the page remembers between visits.
 *
 * Every setting that should survive a refresh goes through `usePersistentState`,
 * under one key prefix, so Reset can forget all of it in one pass. The version
 * segment (v1) lets a later change of shape invalidate old saves instead of
 * feeding them to code that no longer expects them.
 *
 * Every restored value is VALIDATED before use. Code downstream assumes, for
 * instance, that the saved satellite id exists (`SOURCES.find(...)!`), so a stale
 * or hand-edited value would otherwise crash the page on load. Anything that
 * fails validation is quietly replaced by the default.
 *
 * The pinned default field ("★ Set as default field", key pixelGrid.defaultField)
 * is deliberately OUTSIDE the prefix: Reset returns to it rather than erasing it.
 */
const PREFIX = 'pgrid.v1.';
/** Saved before this module existed; Reset clears it too. */
const LEGACY_KEYS = ['pgrid_panel_w'];

export function readSaved<T>(name: string, isValid: (v: unknown) => boolean): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    if (raw === null) return undefined;
    const v: unknown = JSON.parse(raw);
    return isValid(v) ? (v as T) : undefined;
  } catch {
    return undefined; // corrupt JSON, or storage blocked
  }
}

/**
 * Save one setting. Returns whether it is now stored.
 *
 * A failed write does NOT leave the previous save in place. Storage can be full
 * or blocked, and one value here is the whole geometry of an imported trial,
 * big enough to pass the quota on its own. Whatever is still under the key is
 * then a state the page has moved on from: the older trial would come back on a
 * refresh, under the NEW trial's field, turn and shift, with nothing saying so.
 * So a failed save forgets the key, and the caller is told, rather than the page
 * assuming a save that never happened.
 *
 * WHY it was refused is a separate question, and `saveRefusal` answers it: the
 * two reasons need different things said to the user.
 */
export function writeSaved(name: string, value: unknown): boolean {
  const key = PREFIX + name;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    removeSaved(name);
    return false;
  }
}

/**
 * Why a save was refused, asked after `writeSaved` returned false.
 *
 * The exception cannot be trusted to say. Safari's private windows reject a
 * one-byte write as QuotaExceededError, Firefox threw its own legacy name for
 * years, and a store disabled by policy can throw on plain access. So this asks
 * the store instead, with a write too small for anything but a store that is
 * refusing everything to refuse.
 *
 * The answers are not interchangeable: "no-storage" means nothing the page
 * remembers is being remembered, where trimming the file changes nothing, and
 * telling that user their trial is too large sends them to fix a file that is
 * not the problem.
 */
export function saveRefusal(): 'value-too-big' | 'no-storage' {
  const probe = PREFIX + 'probe';
  try {
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return 'value-too-big';
  } catch {
    return 'no-storage';
  }
}

/** Forget one setting, so a refresh takes its default rather than a stale save. */
export function removeSaved(name: string): void {
  try {
    localStorage.removeItem(PREFIX + name);
  } catch {
    /* storage blocked: nothing was ever stored either */
  }
}

/**
 * useState that restores its last value on load and saves every change.
 *
 * The third element is whether the value on screen is the one a refresh would
 * restore. It is false only when the browser refused the save (see writeSaved),
 * which for a value the page cannot recompute is worth telling the user about;
 * `saveRefusal` says which refusal it was, and so what there is to tell.
 */
export function usePersistentState<T>(
  name: string,
  initial: T | (() => T),
  isValid: (v: unknown) => boolean,
): [T, Dispatch<SetStateAction<T>>, boolean] {
  const [value, setValue] = useState<T>(() => {
    const saved = readSaved<T>(name, isValid);
    if (saved !== undefined) return saved;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    setSaved(writeSaved(name, value));
  }, [name, value]);
  return [value, setValue, saved];
}

/**
 * Forget every saved setting (but not the pinned default field) and reload,
 * so every piece of state, including chart settings kept inside individual
 * panels, comes back at its default without being reset one by one.
 */
export function resetSavedState(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(PREFIX) || LEGACY_KEYS.includes(k))) doomed.push(k);
    }
    doomed.forEach(k => localStorage.removeItem(k));
  } catch {
    /* storage blocked: nothing was saved either */
  }
  window.location.reload();
}

// ---- validators -------------------------------------------------------------

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const inRange = (lo: number, hi: number) => (v: unknown) => isNum(v) && v >= lo && v <= hi;
export const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
export const oneOf = (...xs: readonly unknown[]) => (v: unknown) => xs.includes(v);
export const isLngLat = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(isNum);

/**
 * Every field of an object must pass its own validator, and no field may be
 * missing. For saved values that are a RECORD rather than a scalar: a block
 * design is eight numbers, and a stale or hand-edited one must fall back to the
 * default rather than reach the geometry, where a NaN plot width would silently
 * produce a trial with no plots in it.
 */
export const shape = (spec: Record<string, (v: unknown) => boolean>) => (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return Object.entries(spec).every(([k, ok]) => k in o && ok(o[k]));
};

/** An array whose every item passes, with a length between min and max. */
export const arrayOf = (item: (v: unknown) => boolean, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  (v: unknown) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(item);
