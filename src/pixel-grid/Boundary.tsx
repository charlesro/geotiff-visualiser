import React from 'react';

/**
 * One panel failing must not take the page with it.
 *
 * React unmounts the whole tree on an uncaught render error, and everything
 * here is persisted (the field, the sensor, the layout, an imported trial), so
 * the reload reproduces it: a blank page with no way back. Each panel carries
 * its own boundary instead, so the others keep working and the header's Reset
 * stays reachable. The error is left in the console for a bug report, and shown
 * here in full rather than summarised: a message like "Cannot read properties
 * of undefined" is what tells you which panel to avoid.
 */
export class Boundary extends React.Component<
  { name: string; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`${this.props.name} failed`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-2.5 py-2 text-[11px] leading-snug text-rose-200">
        <div className="font-medium">{this.props.name} could not be drawn.</div>
        <div className="mt-1 break-words text-rose-300/80">{error.message || String(error)}</div>
        <div className="mt-1 text-neutral-400">
          The rest of the page still works. Change a setting to try again, or use Reset at the top to start from a clean state.
        </div>
        <button type="button" onClick={() => this.setState({ error: null })}
          className="mt-1.5 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:border-sky-500/60 hover:text-sky-200">
          Try again
        </button>
      </div>
    );
  }
}
