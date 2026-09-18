import { Step } from '../ui';
import { Boundary } from '../Boundary';
import type { StepProps } from './props';

/**
 * Step 1 — draw or trace the experiment or search for it.
 *
 * Rendered as a child of `Step`, which unmounts collapsed children — so NOTHING
 * here may hold state. Everything it reads comes from hooks the page shell owns.
 */
function AreaStepBody(p: StepProps) {
  const { activeStep, toggleStep, areaSummary } = p;
  const { aoi, drawMode, defaultSaved, startDraw, cancelDraw, clearAoi, saveDefaultField, clearDefaultField } = p.area;
  const { query, setQuery, suggestions, showSuggestions, setShowSuggestions, activeSuggestion, setActiveSuggestion, pickSuggestion, onSearch, onSearchKeyDown } = p.search;

  return (
        <Step n={1} title="Experiment area" summary={areaSummary} open={activeStep === 'area'} onClick={() => toggleStep('area')}>
        {/* What this page is for. It used to be written only under the drawing
            buttons, shown when there was no field, and a first visit always opens
            on the demo field, so nobody arriving cold ever read it. */}
        <p className="text-[11px] leading-relaxed text-neutral-400">
          See where a satellite's pixels fall on your trial, and whether that sensor could tell your treatments apart.
          Draw or upload the field, pick the sensor, lay out the experiment, and export the pixel footprints.
        </p>

        {/* Search with autocomplete */}
        <form onSubmit={onSearch} className="relative flex gap-2">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            onFocus={() => { if (suggestions.length) setShowSuggestions(true); }}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            placeholder="Find a place…"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-sky-500 focus:outline-none"
          />
          <button type="submit" className="rounded-md border border-white/10 bg-neutral-800 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-700">
            Go
          </button>
          {showSuggestions && suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-[1100] mt-1 max-h-64 overflow-auto rounded-md border border-white/10 bg-neutral-900 py-1 shadow-xl">
              {suggestions.map((s, i) => (
                <li key={`${s.label}-${i}`}>
                  <button
                    type="button"
                    onMouseDown={e => { e.preventDefault(); pickSuggestion(s); }}
                    onMouseEnter={() => setActiveSuggestion(i)}
                    className={`block w-full px-3 py-2 text-left text-sm ${
                      i === activeSuggestion ? 'bg-sky-500/15 text-sky-200' : 'text-neutral-300 hover:bg-neutral-800'
                    }`}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>

        {/* Draw rectangle / polygon · cancel · clear */}
        <div className="flex gap-2">
          {drawMode ? (
            <button
              onClick={cancelDraw}
              className="flex-1 rounded-md border border-white/15 bg-neutral-800 px-3 py-2 text-sm font-medium text-neutral-200 hover:bg-neutral-700"
            >
              Cancel drawing
            </button>
          ) : (
            <>
              <button
                onClick={() => startDraw('rect')}
                className="flex-1 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400"
              >
                {aoi ? 'Box' : 'Draw a box'}
              </button>
              <button
                onClick={() => startDraw('poly')}
                className="flex-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-300 hover:bg-sky-500/20"
              >
                {aoi ? 'Shape' : 'Trace field shape'}
              </button>
              {aoi && (
                <button onClick={clearAoi} className="rounded-md border border-white/10 bg-neutral-800 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-700">
                  Clear
                </button>
              )}
            </>
          )}
        </div>

        {aoi && !drawMode && (
          <div className="flex items-center gap-2 text-[11px]">
            <button
              onClick={saveDefaultField}
              className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 font-medium text-sky-300 transition-colors hover:bg-sky-500/20"
            >
              ★ Set as default field
            </button>
            {defaultSaved && (
              <>
                <span className="text-neutral-400/90">pinned · Reset returns here</span>
                <button onClick={clearDefaultField} className="text-neutral-500 underline decoration-dotted hover:text-neutral-300">clear</button>
              </>
            )}
          </div>
        )}

        {!aoi && (
          <p className="text-[11px] leading-relaxed text-neutral-400">
            Find your area in <span className="text-neutral-200">Satellite</span> view (top-right), then
            <span className="text-neutral-200"> Draw a box</span> for a quick rectangle, or
            <span className="text-neutral-200"> Trace field shape</span> to click around an irregular field.
          </p>
        )}
        </Step>
  );
}

/**
 * The panel, inside its own failure boundary.
 *
 * The boundary has to wrap the COMPONENT, not the tree it returns: a throw in
 * this step's own body (a memo over the geometry, a bad restored value) happens
 * before anything it returned exists, and React then unmounts the whole page.
 * Wrapped here, the other steps, the map and the header's Reset survive it.
 */
export function AreaStep(p: StepProps) {
  return <Boundary name="Experiment area"><AreaStepBody {...p} /></Boundary>;
}
