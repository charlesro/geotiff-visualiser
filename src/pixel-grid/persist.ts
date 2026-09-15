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

export function writeSaved(name: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + name, JSON.stringify(value));
  } catch {
    /* full or blocked: the setting simply won't survive a refresh */
  }
}

/** useState that restores its last value on load and saves every change. */
export function usePersistentState<T>(
  name: string,
  initial: T | (() => T),
  isValid: (v: unknown) => boolean,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const saved = readSaved<T>(name, isValid);
    if (saved !== undefined) return saved;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    writeSaved(name, value);
  }, [name, value]);
  return [value, setValue];
}

/**
 * Forget every saved setting — but not the pinned default field — and reload,
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
