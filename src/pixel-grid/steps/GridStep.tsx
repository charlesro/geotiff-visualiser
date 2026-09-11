import { Chip, Disclosure, Explain, Hero, InfoDot, Step } from '../ui';
import { fmt } from '../util';
import { FIXED, GSD_PRESETS, SOURCES, TASK } from '../sensors';
import { zoneFromEpsg } from '../s2-grid';
import type { StepProps } from './props';

/**
 * Step 2 — pick the satellite, see where its pixels really fall, export them.
 *
 * Rendered as a child of `Step`, which unmounts collapsed children — so NOTHING
 * here may hold state. Everything it reads comes from hooks the page shell owns.
 */
export function GridStep(p: StepProps) {
  const { activeStep, toggleStep, gridSummary, recipeOpen, setRecipeOpen } = p;
  const { aoi, aoiPoly } = p.area;
  const { sourceId, setSourceId, source, gsd, setGsd, customAnchor, setCustomAnchor, sigmaX, setSigmaX, sigmaY, setSigmaY, grids, gridState, selectedGridKey, setSelectedGridKey, build, grid, pxSize, psfSigmaM, psfSigmaXM, psfFwhmXM, psfFwhmYM, psfAnisotropic, dims, fieldAreaM2, maxAreaHa, fieldCellCount, gridNoun, nestsS2, convergence, recipe, copyRecipe, onDownload } = p.gridApi;

  const fwhmTxt = psfAnisotropic
    ? `${psfFwhmXM < 10 ? psfFwhmXM.toFixed(1) : Math.round(psfFwhmXM)} × ${psfFwhmYM < 10 ? psfFwhmYM.toFixed(1) : Math.round(psfFwhmYM)}`
    : `${psfFwhmXM < 10 ? psfFwhmXM.toFixed(1) : Math.round(psfFwhmXM)}`;
  const SELECT = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none';
  const NUM = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none';
  const CAP = 'mb-1 block text-[11px] text-neutral-500';

  return (
        <Step n={2} title="Pixel grid & export" summary={gridSummary} open={activeStep === 'grid'} onClick={() => toggleStep('grid')} enabled={!!aoi}>
        {!aoi ? (
          <p className="text-xs text-neutral-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : (<>

        {/* Sensor — the select states its own value, so it needs no label. */}
        <div className="flex items-center gap-2">
          <select value={sourceId} onChange={e => setSourceId(e.target.value)} className={SELECT}>
            {[FIXED, TASK].map(g => (
              <optgroup key={g} label={g}>
                {SOURCES.filter(s => s.group === g).map(s => (
                  <option key={s.id} value={s.id}>{s.provider}{s.resLabel !== '—' ? ` · ${s.resLabel}` : ''}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <Explain align="right" text={source.note}><InfoDot /></Explain>
        </div>

        {/* Blur — σ stays visible; the derivation and the citation go on demand. */}
        {build && (
          <div>
            <div className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-[11px] text-neutral-500">Blur σ</span>
              <input type="number" min="0" max="5" step="0.1" value={sigmaX}
                onChange={e => setSigmaX(Math.max(0, parseFloat(e.target.value) || 0))} className={NUM} />
              <span className="text-[11px] text-neutral-500">×</span>
              <input type="number" min="0" max="5" step="0.1" value={sigmaY}
                onChange={e => setSigmaY(Math.max(0, parseFloat(e.target.value) || 0))} className={NUM} />
              <span className="text-[11px] text-neutral-500">px</span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-neutral-500">
              {psfSigmaM > 0 ? (<>
                <Explain text={<>Default <span className="font-mono">{source.psf.toFixed(2)}</span> px = {source.provider}&rsquo;s <span className="text-neutral-300">worst-case</span> blur — the blurriest end of its MTF-at-Nyquist range (conservative).{source.psfSrc && <> <a href={source.psfSrc.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline decoration-dotted hover:text-sky-300">{source.psfSrc.label} ↗</a></>} That width is measured where the blur has dropped to half its peak — and it holds only <span className="text-neutral-300">half</span> the signal. The rest lands further out, 95% of it within {(2 * 2.448 * psfSigmaXM).toFixed(0)} m. Turn on <span className="text-neutral-300">PSF blur</span> on the map to see both contours.</>}>
                  <span className="font-mono text-neutral-300">≈{fwhmTxt} m</span>
                </Explain>{' '}
                across a point — {(psfFwhmXM / build.res).toFixed(1)}× the {build.res} m pixel
                {psfAnisotropic && <> across, {(psfFwhmYM / build.res).toFixed(1)}× along the rows</>}.
              </>) : <>σ = 0 → perfectly sharp pixels.</>}
            </p>
          </div>
        )}

        {/* A grid you impose: GSD and origin are grid-defining, so they stay visible. */}
        {source.kind === 'custom' && (<>
          <div>
            <span className={CAP}>Pixel size (GSD)</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {GSD_PRESETS.map(g => (
                <button key={g} onClick={() => setGsd(g)}
                  className={`rounded-md border px-2 py-1 text-sm ${gsd === g ? 'border-sky-500 bg-sky-500/15 text-sky-300' : 'border-white/10 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'}`}>{g} m</button>
              ))}
              <input type="number" min="0.05" step="0.05" value={gsd}
                onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setGsd(v); }}
                className="w-16 rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" />
            </div>
            <p className="mt-1 text-[11px] leading-snug text-neutral-400">
              {nestsS2
                ? <>✓ nests in Sentinel-2&rsquo;s 10 m grid ({Math.round(10 / gsd)}×{Math.round(10 / gsd)} per S2 pixel).</>
                : <>Doesn&rsquo;t divide 10 m — won&rsquo;t align to Sentinel-2&rsquo;s grid.</>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-1 gap-1.5">
              {([['utm', 'UTM grid (× GSD)'], ['plot', 'Align to my plot']] as const).map(([v, lbl]) => (
                <button key={v} onClick={() => setCustomAnchor(v)}
                  className={`flex-1 rounded-md border px-2 py-1.5 text-xs ${customAnchor === v ? 'border-sky-500 bg-sky-500/15 text-sky-300' : 'border-white/10 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'}`}>{lbl}</button>
              ))}
            </div>
            <Explain align="right" text={customAnchor === 'utm'
              ? 'Pixel edges on multiples of the GSD — reproducible across every delivery (gdalwarp -tap).'
              : 'Grid starts at your drawn box corner, so pixels line up with the plot.'}><InfoDot /></Explain>
          </div>
        </>)}

        {/* One result card: the answer, its provenance, and the export. */}
        <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-2.5">
          {source.kind === 'catalog' && gridState === 'loading' && (
            <p className="text-sm text-neutral-400">Identifying the {gridNoun} from the catalog…</p>
          )}

          {gridState === 'error' && !source.offlinePhase0 && source.kind === 'catalog' ? (
            <p className="text-[12px] leading-snug text-rose-300">
              Couldn&rsquo;t identify the {source.provider} grid — its lattice is offset from Sentinel-2
              and must be read live from the catalog. Check your connection and redraw.
            </p>
          ) : build?.capped ? (<>
            <Hero value={fmt(build.cellCount)} unit="px" right={`${fmt(Math.round(fieldAreaM2))} m²`} tone="text-amber-300" />
            <p className="mt-1 text-[11px] leading-snug text-neutral-400">
              Too many to export. The grid is drawn on the map — zoom in to see individual pixels.{' '}
              {source.kind === 'custom'
                ? 'Export the whole field via the recipe below.'
                : <>Draw a smaller area (≤ {fmt(Math.round(maxAreaHa * 10_000))} m² at {pxSize} m) to export.</>}
            </p>
          </>) : build && grid && dims ? (<>
            <Hero
              value={fmt(aoiPoly ? (fieldCellCount ?? 0) : build.cellCount)}
              unit={aoiPoly ? 'px in field' : 'px'}
              right={`${fmt(Math.round(fieldAreaM2))} m²`} />

            {/* The ONE place the tile and the CRS are printed. */}
            <p className="mt-1 font-mono text-[11px] text-neutral-500">
              {source.provider} · {grid.res} m{grid.tile && <> · {grid.tile}</>} · EPSG:{grid.epsg} · {dims.nx} × {dims.ny}{aoiPoly ? ' bbox' : ''}
            </p>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              {source.kind === 'custom' ? (
                <Explain below text={<>This is a grid <span className="text-neutral-300">you define</span> — {source.provider} has no fixed grid, so imagery lands on it only if you order or resample onto it (recipe below). Exported in UTM (EPSG:{grid.epsg}) with a .prj, {customAnchor === 'utm' ? 'on multiples of the GSD' : 'aligned to your plot corner'}.</>}>
                  <Chip tone="amber">◇ grid you define</Chip>
                </Explain>
              ) : gridState === 'error' ? (
                <Explain below text={<>Couldn&rsquo;t reach the catalog, so the grid was computed from the standard zone rule rather than read from a product. This source&rsquo;s lattice origin is a multiple of the pixel size in the northern hemisphere, so it matches there — but not south of the equator at 30 m or 60 m.</>}>
                  <Chip tone="amber">⚠ offline grid</Chip>
                </Explain>
              ) : grid.anchored ? (
                <Explain below text={<>Aligned to the real product grid: polygons anchored to the actual <span className="font-mono">{grid.tile}</span> {source.provider} lattice in native UTM (EPSG:{grid.epsg}), with a .prj. Read from the product metadata, not guessed.</>}>
                  <Chip>● anchored to {grid.tile}</Chip>
                </Explain>
              ) : (
                <Explain below text={<>Polygons in native UTM (EPSG:{grid.epsg}) with a .prj — exact pixel squares for the standard zone.</>}>
                  <Chip>● standard-zone grid</Chip>
                </Explain>
              )}

              {convergence !== null && Math.abs(convergence) >= 0.05 && (
                <Explain below align="right" text={<>Pixels are {Math.abs(convergence).toFixed(2)}° {convergence > 0 ? 'clockwise (east)' : 'counter-clockwise (west)'} of true north — this is UTM grid convergence, fixed by where you are, not by the date. Set your RTK A–B line parallel to the UTM grid using the exported shapefile rather than steering to a compass bearing: magnetic declination is larger than this angle.</>}>
                  <Chip>↻ {Math.abs(convergence).toFixed(2)}° E of N</Chip>
                </Explain>
              )}

              {grids && grids.length > 1 && (
                <Explain below align="right" text={<>This area straddles {grids.length} {gridNoun}s with different grids. Pick the one whose product you&rsquo;ll actually download — they are different lattices on the ground.</>}>
                  <Chip tone="amber">⚠ {grids.length} {gridNoun}s</Chip>
                </Explain>
              )}
            </div>

            {grids && grids.length > 1 && (
              <select value={selectedGridKey ?? ''} onChange={e => setSelectedGridKey(e.target.value)}
                className={`mt-2 ${SELECT}`}>
                {grids.map(g => (
                  <option key={g.label} value={g.label}>{g.label} — EPSG:{g.epsg} (zone {zoneFromEpsg(g.epsg)})</option>
                ))}
              </select>
            )}

            <button onClick={onDownload}
              className="mt-2.5 w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500">
              Download shapefile (.zip)
            </button>
          </>) : null}
        </div>

        {/* The tasking recipe is reference material, not a decision — closed by default. */}
        {recipe && (
          <Disclosure label="Order / resample recipe" open={recipeOpen} onToggle={() => setRecipeOpen(v => !v)}>
            <div className="flex items-center justify-end">
              <button onClick={copyRecipe} className="rounded border border-white/10 bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-700">Copy</button>
            </div>
            <code className="block overflow-x-auto whitespace-pre rounded bg-black/40 p-2 text-[11px] leading-relaxed text-neutral-300">{recipe.gdalwarp}</code>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-neutral-400">
              <dt>CRS</dt><dd className="font-mono">EPSG:{recipe.epsg}</dd>
              <dt>GSD</dt><dd className="font-mono">{recipe.gsd} m</dd>
              <dt>Extent</dt><dd className="font-mono break-all">{recipe.extent.map(v => Math.round(v)).join(', ')}</dd>
            </dl>
            <p className="text-[11px] leading-snug text-neutral-500">
              Run this on every delivery so all images land on this grid. Planet&rsquo;s tile tool also
              takes the origin directly (origin_x / origin_y); CRS and GSD alone do not pin it.
            </p>
          </Disclosure>
        )}
        </>)}
        </Step>
  );
}
