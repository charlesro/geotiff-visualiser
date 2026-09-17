import { Chip, Explain, Hero, InfoDot, Step } from '../ui';
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
  const { activeStep, toggleStep, gridSummary } = p;
  const { aoi } = p.area;
  const { sourceId, setSourceId, source, gsd, setGsd, customAnchor, setCustomAnchor, sigmaX, setSigmaX, sigmaY, setSigmaY, psfOffX, setPsfOffX, psfOffY, setPsfOffY, psfOffXM, psfOffYM, grids, gridState, selectedGridKey, setSelectedGridKey, selectedGrid, build, grid, pxSize, psfSigmaM, psfSigmaXM, psfSigmaYM, psfFwhmXM, psfFwhmYM, psfAnisotropic, dims, fieldAreaM2, maxAreaHa, fieldCellCount, gridNoun, nestsS2, onDownload } = p.gridApi;

  const fwhmTxt = psfAnisotropic
    ? `${psfFwhmXM < 10 ? psfFwhmXM.toFixed(1) : Math.round(psfFwhmXM)} × ${psfFwhmYM < 10 ? psfFwhmYM.toFixed(1) : Math.round(psfFwhmYM)}`
    : `${psfFwhmXM < 10 ? psfFwhmXM.toFixed(1) : Math.round(psfFwhmXM)}`;
  const p95 = (s: number) => (2 * 2.448 * s).toFixed(0); // width of the 95% spot, m
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
                  <option key={s.id} value={s.id}>{s.provider}{s.resLabel ? ` · ${s.resLabel}` : ''}</option>
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
            <div className="mt-1.5 flex items-center gap-2">
              <span className="w-10 shrink-0 text-[11px] text-neutral-500">Offset</span>
              <input type="number" min="-2" max="2" step="0.05" value={psfOffX}
                onChange={e => setPsfOffX(Math.max(-2, Math.min(2, parseFloat(e.target.value) || 0)))} className={NUM} />
              <span className="text-[11px] text-neutral-500">×</span>
              <input type="number" min="-2" max="2" step="0.05" value={psfOffY}
                onChange={e => setPsfOffY(Math.max(-2, Math.min(2, parseFloat(e.target.value) || 0)))} className={NUM} />
              <span className="text-[11px] text-neutral-500">px</span>
              <Explain align="right" text="Where the blur sits relative to the pixel centre. A sensor is never perfectly centred, and an off-centre blur pulls in crops from one side."><InfoDot /></Explain>
            </div>
            {(psfOffX !== 0 || psfOffY !== 0) && (
              <p className="mt-1 text-[11px] leading-snug text-amber-300/80">
                Blur centre {psfOffXM.toFixed(1)} m east, {psfOffYM.toFixed(1)} m north of the pixel centre.
              </p>
            )}
            <p className="mt-1 text-[11px] leading-snug text-neutral-500">
              {psfSigmaM > 0 ? (<>
                <Explain text={<>Width at half the peak; 95% of the signal falls in a spot {psfAnisotropic ? `${p95(psfSigmaXM)} × ${p95(psfSigmaYM)}` : p95(psfSigmaXM)} m across{source.psfSrc && <> (default σ from <a href={source.psfSrc.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline decoration-dotted hover:text-sky-300">{source.psfSrc.label} ↗</a>)</>}.</>}>
                  <span className="font-mono text-neutral-300">≈{fwhmTxt} m</span>
                </Explain>{' '}
                across a point, {(psfFwhmXM / build.res).toFixed(1)}× the {build.res} m pixel
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
                : <>Doesn&rsquo;t divide 10 m, so it won&rsquo;t align to Sentinel-2&rsquo;s grid.</>}
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
              ? 'Pixel edges fall on round multiples of the pixel size.'
              : 'The grid starts at the bottom-left corner of the box around your field.'}><InfoDot /></Explain>
          </div>
        </>)}

        {/* One result card: the answer, its provenance, and the export. */}
        <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-2.5">
          {source.kind === 'catalog' && gridState === 'loading' && (
            <p className="text-sm text-neutral-400">Identifying the {gridNoun} from the catalog…</p>
          )}

          {gridState === 'error' && !source.offlinePhase0 && source.kind === 'catalog' ? (
            <p className="text-[12px] leading-snug text-rose-300">
              Couldn&rsquo;t identify the {source.provider} grid. Its lattice is offset from Sentinel-2
              and must be read live from the catalog. Check your connection and redraw.
            </p>
          ) : build?.capped ? (<>
            <Hero value={fmt(build.cellCount)} unit="px" right={`${fmt(Math.round(fieldAreaM2))} m²`} tone="text-amber-300" />
            <p className="mt-1 text-[11px] leading-snug text-neutral-400">
              Too many to export. The grid is drawn on the map; zoom in to see individual pixels.{' '}
              Draw a smaller area (≤ {fmt(Math.round(maxAreaHa * 10_000))} m² at {pxSize} m) to export.
            </p>
          </>) : build && grid && dims ? (<>
            <Hero
              value={fmt(fieldCellCount ?? build.cellCount)}
              unit="px in field"
              right={`${fmt(Math.round(fieldAreaM2))} m²`} />

            {/* The ONE place the tile and the CRS are printed. */}
            <p className="mt-1 font-mono text-[11px] text-neutral-500">
              {source.provider} · {grid.res} m{grid.tile && <> · {grid.tile}</>} · EPSG:{grid.epsg} · {dims.nx} × {dims.ny} bbox{selectedGrid?.catalog && <> · read from {selectedGrid.catalog}</>}
            </p>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              {source.kind === 'custom' ? (
                <Explain below text={<>{source.provider} has no fixed grid, so order or resample images onto this one.</>}>
                  <Chip tone="amber">◇ grid you define</Chip>
                </Explain>
              ) : gridState === 'error' ? (
                <Explain below text={<>Computed without the catalog, from the standard lattice for this UTM zone.</>}>
                  <Chip tone="amber">⚠ offline grid</Chip>
                </Explain>
              ) : null}

              {grids && grids.length > 1 && (
                <Explain below align="right" text={<>This area spans {grids.length} {gridNoun}s with different grids; pick the one you&rsquo;ll download.</>}>
                  <Chip tone="amber">⚠ {grids.length} {gridNoun}s</Chip>
                </Explain>
              )}
            </div>

            {grids && grids.length > 1 && (
              <select value={selectedGridKey ?? ''} onChange={e => setSelectedGridKey(e.target.value)}
                className={`mt-2 ${SELECT}`}>
                {grids.map(g => (
                  <option key={g.label} value={g.label}>{g.label} · EPSG:{g.epsg} (zone {zoneFromEpsg(g.epsg)})</option>
                ))}
              </select>
            )}

            <button onClick={onDownload}
              className="mt-2.5 w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500">
              Download shapefile (.zip)
            </button>
          </>) : null}
        </div>

        </>)}
        </Step>
  );
}
