/**
 * Cooperative cancellation for the long-running workflow operations.
 *
 * Each operation receives a `CancelCheck` callback and polls it at safe
 * points (between scenes, between polygons, between network chunks). When
 * the user hits Stop, the check starts returning true and the operation
 * throws a CancelledError, which the App handlers swallow silently.
 */

export type CancelCheck = () => boolean;

export class CancelledError extends Error {
  constructor() {
    super('Operation stopped.');
    this.name = 'CancelledError';
  }
}

export function throwIfCancelled(check?: CancelCheck): void {
  if (check?.()) throw new CancelledError();
}

/** True for our own cancellations and for aborted fetches. */
export const isCancelledError = (e: unknown): boolean =>
  e instanceof CancelledError || (e instanceof Error && e.name === 'AbortError');
