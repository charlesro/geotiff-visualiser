import { Chip, Disclosure, Hero, Step } from '../ui';
import { Boundary } from '../Boundary';
import { fmt } from '../util';
import { bufferK } from '../resolving';
import { FIXED, GSD_PRESETS, SOURCES, TASK } from '../sensors';
import { zoneFromEpsg } from '../s2-grid';
import { STEP_NO, type StepProps } from './props';

/**
 * Step 2: pick the satellite, see where its pixels really fall, export them.
 *
 * Rendered as a child of `Step`, which unmounts collapsed children, so NOTHING
 * here may hold state. Everything it reads comes from hooks the page shell owns.
 */
/** The blur the sensor model accepts, and the range its saved value is validated against. */
const clampSigma = (raw: string) => Math.max(0, Math.min(5, parseFloat(raw) || 0));

/**
 * Every variance source with its number at the current setting, as a plain
 * table in the PHENET note's own terms and symbols: GSD, FWHM, r = FWHM/GSD,
 * sigma_PSF, sigma_geo, sigma_eff, threshold epsilon,
 * buffer b (k sigma_eff, with no row for k), pure core L - 2b.
 *
 * Nothing is listed for the pixel's own square: a measured FWHM already
 * contains the detector, and the simulation reads each pixel through the spot
 * alone (simulate.ts followsSpot). Its row and the "sigma simulated" row were
 * removed on request on 2026-11-24. The CE90 has a row of its own above
 * sigma_geo, which is worked out from it.
 *
 * The minimum plots (the closed form's "min. plot, any pixel" and the whole
 * "Minimum plot, worst placement" block of note-model.ts figures) were removed
 * from the panel on request on 2026-11-24. They stay on the documentation
 * page, which note-model.ts still computes them for. So were the grid
 * placement (phase, rotation) and signal (noise) blocks, the same day.
 *
 * A name and a figure per row, and nothing on hover: what each term is, and
 * what the simulation leaves out, are on the documentation page.
 */
function VarianceSources({ optX, optY, aniso, optFrom, geo, geoErrM, delivered, effX, effY, res,
  threshold, plotSideM }: {
  optX: number; optY: number; aniso: boolean;
  /** Where this sigma came from. */
  optFrom: 'measured' | 'published' | 'assumed' | 'typed';
  geo: number; geoErrM: number;
  /** True when the CE90 is the provider's own figure for this satellite, not one typed. */
  delivered: boolean;
  effX: number; effY: number; res: number;
  /** Purity threshold, percent (epsilon is its complement). */
  threshold: number;
  /** The design's short plot (or strip) side L, when it has one. */
  plotSideM?: number;
}) {
  const m = (v: number) => `${v.toFixed(2)} m`;
  const pair = (x: number, y: number) => (aniso ? `${x.toFixed(2)} × ${y.toFixed(2)} m` : m(x));
  const eff = Math.max(effX, effY), opt = Math.max(optX, optY);
  const r = (2.3548 * opt) / res;
  const k = bufferK(threshold / 100), b = k * eff;
  const core = plotSideM != null ? plotSideM - 2 * b : null;
  const Row = ({ name, val, note, dim, warn }: { name: React.ReactNode; val: string; note?: string; dim?: boolean; warn?: boolean }) => (
    <div className={`flex items-baseline gap-2 ${dim ? 'text-neutral-600' : 'text-neutral-400'}`}>
      <span className="w-36 shrink-0">{name}</span>
      <span className={`w-24 shrink-0 text-right font-mono ${warn ? 'text-amber-300' : dim ? 'text-neutral-500' : 'text-neutral-200'}`}>{val}</span>
      {note && <span className="min-w-0 text-[13px] text-neutral-600">{note}</span>}
    </div>
  );
  const Head = ({ children }: { children: React.ReactNode }) => (
    <div className="mb-0.5 mt-2 border-t border-white/5 pt-1.5 text-[12px] uppercase tracking-wide text-neutral-600">{children}</div>
  );
  return (
    <div className="mt-1.5 rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[14px]">
      <div className="mb-1 text-[13px] uppercase tracking-wide text-neutral-500">Variance sources</div>
      <div className="space-y-0.5">
        <Row name="GSD" val={`${res} m`} />
        <Row name="FWHM" val={pair(2.3548 * optX, 2.3548 * optY)}
          note={optFrom === 'measured' ? 'measured' : optFrom === 'published' ? 'published MTF' : optFrom === 'assumed' ? 'assumed MTF' : undefined} />
        <Row name="r = FWHM/GSD" val={r.toFixed(2)} />
        <Row name={<>σ<sub>PSF</sub></>} val={pair(optX, optY)} />
        <Row name="CE90" val={geoErrM > 0 ? m(geoErrM) : 'none'} note={geoErrM > 0 ? (delivered ? 'as delivered' : 'typed') : undefined} />
        <Row name={<>σ<sub>geo</sub></>} val={m(geo)} />
        <Row name={<>σ<sub>eff</sub></>} val={pair(effX, effY)} />
      </div>
      <Head>Threshold <span className="normal-case">ε</span> = {100 - threshold} %</Head>
      <div className="space-y-0.5">
        {/* k = Q^-1(epsilon) has no row since 2026-11-24, on request: it stays on the documentation page, and in b. */}
        <Row name="buffer b" val={m(b)} />
        {core != null && <Row name="pure core L − 2b" val={core > 0 ? m(core) : 'none'} warn={core <= 0} note={`L = ${plotSideM} m`} />}
      </div>
    </div>
  );
}

function GridStepBody(p: StepProps) {
  const { activeStep, toggleStep, gridSummary, blurOpen, setBlurOpen } = p;
  const { aoi } = p.area;
  const { source, geoErrM, grids, gridState, selectedGridKey, setSelectedGridKey, selectedGrid, build, grid, pxSize, psfSigmaM,
          dims, fieldAreaM2, maxAreaHa, fieldCellCount, gridNoun, onDownload } = p.gridApi;
  const fwhmTxt = fwhmText(p.gridApi);

  return (
        <Step n={STEP_NO.grid} title="Pixel grid & export" summary={gridSummary} open={activeStep === 'grid'} onClick={() => toggleStep('grid')} enabled={!!aoi}>
        {!aoi ? (
          <p className="text-[14px] text-neutral-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : (<>

        <SensorPick {...p} />

        {/* One result card: the answer, its provenance, and the export. */}
        <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-2.5">
          {source.kind === 'catalog' && gridState === 'loading' && (
            <p className="text-[15px] text-neutral-400">Identifying the {gridNoun} from the catalog…</p>
          )}

          {gridState === 'error' && !source.offlinePhase0 && source.kind === 'catalog' ? (
            <p className="text-[14px] leading-snug text-rose-300">
              Couldn&rsquo;t identify the {source.provider} grid. Its lattice is offset from Sentinel-2
              and must be read live from the catalog. Check your connection and redraw.
            </p>
          ) : build?.capped ? (<>
            <Hero value={fmt(build.cellCount)} unit="px" right={`${fmt(Math.round(fieldAreaM2))} m²`} tone="text-amber-300" />
            <p className="mt-1 text-[14px] leading-snug text-neutral-400">
              Too many to export. The grid is drawn on the map; zoom in to see individual pixels.{' '}
              Draw a smaller area (≤ {fmt(Math.round(maxAreaHa * 10_000))} m² at {pxSize} m) to export.
            </p>
          </>) : build && grid && dims ? (<>
            <Hero
              value={fmt(fieldCellCount ?? build.cellCount)}
              unit="px in field"
              right={`${fmt(Math.round(fieldAreaM2))} m²`} />

            {/* The ONE place the tile and the CRS are printed. */}
            <p className="mt-1 font-mono text-[14px] text-neutral-500">
              {source.provider} · {grid.res} m{grid.tile && <> · {grid.tile}</>} · EPSG:{grid.epsg} · {dims.nx} × {dims.ny} bbox{selectedGrid?.catalog && <> · read from {selectedGrid.catalog}</>}
            </p>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[14px]">
              {source.kind === 'custom' ? (
                <span title={`${source.provider} has no fixed grid: each image comes on its own.`}><Chip tone="amber">◇ grid to ask for</Chip></span>
              ) : gridState === 'error' ? (
                <span title="Computed without the catalog, from the standard lattice for this UTM zone."><Chip tone="amber">⚠ offline grid</Chip></span>
              ) : null}

              {grids && grids.length > 1 && (
                <span title={`This area spans ${grids.length} ${gridNoun}s with different grids; pick the one to download.`}><Chip tone="amber">⚠ {grids.length} {gridNoun}s</Chip></span>
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
              className="mt-2.5 w-full rounded-md bg-emerald-600 px-3 py-2 text-[15px] font-medium text-white transition-colors hover:bg-emerald-500">
              Download shapefile (.zip)
            </button>
          </>) : null}
        </div>

        {/* Blur and geolocation, folded. The step opens on what it is for: which
            satellite, how many pixels, the file. The two figures that set the
            blur are named on the fold itself, so they are read without opening
            it, and the inputs and the whole budget are one click away. */}
        {build && (
          <Disclosure
            label={`Blur and geolocation · ${psfSigmaM > 0 ? `FWHM ${fwhmTxt} m` : 'no blur'} · CE90 ${geoErrM} m`}
            open={blurOpen} onToggle={() => setBlurOpen(v => !v)}>
          <BlurGeo {...p} />
          </Disclosure>
        )}

        </>)}
        </Step>
  );
}

const SELECT = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-[15px] text-neutral-100 focus:border-sky-500 focus:outline-none';
const NUM = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-[15px] text-neutral-100 focus:border-sky-500 focus:outline-none';
const CAP = 'mb-1 block text-[14px] text-neutral-500';

/**
 * Whether the blur in force is the satellite's own figure. Typed over, it is
 * the reader's: the panel went on calling it "measured" (found by an outside
 * review, 2026-11-22).
 */
const ownBlur = ({ sigmaX, sigmaY, source }: StepProps['gridApi']): boolean =>
  Math.abs(sigmaX - source.psf) < 1e-6 && Math.abs(sigmaY - source.psf) < 1e-6;

/** The blur's width at half its peak, in metres, as the folds print it. */
export function fwhmText({ psfFwhmXM, psfFwhmYM, psfAnisotropic }: StepProps['gridApi']): string {
  // A tenth of a metre, except a whole number past 10 m: Sentinel-2's 14 stays 14, PlanetScope's 11.8 is not rounded to 12.
  const one = (v: number) => (v >= 10 && Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
  return psfAnisotropic ? `${one(psfFwhmXM)} × ${one(psfFwhmYM)}` : one(psfFwhmXM);
}

/**
 * Which satellite, and for a grid you impose, its pixel size.
 *
 * Shared by this step and by step 2's Satellite fold, which is where it is
 * reached while this step is not shown: the satellite, its blur, the CE90 and
 * where each figure comes from were only ever here, and hiding the step hid
 * every assumption the counts rest on (found by an outside review, 2026-11-22).
 */
export function SensorPick(p: StepProps) {
  const { sourceId, setSourceId, source, gsd, setGsd } = p.gridApi;
  return (<>
        {/* Sensor: the select states its own value, so it needs no label. What a
            satellite is, what a pansharpened row flatters and how a tasked grid
            is counted are on the documentation page, and nowhere here. */}
        <select value={sourceId} onChange={e => setSourceId(e.target.value)} className={SELECT}>
          {[FIXED, TASK].map(g => (
            <optgroup key={g} label={g}>
              {SOURCES.filter(s => s.group === g).map(s => (
                <option key={s.id} value={s.id}>{s.provider}{s.resLabel ? ` · ${s.resLabel}` : ''}</option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* A grid you impose: its pixel size is the one thing that defines it. */}
        {source.kind === 'custom' && (<>
          <div>
            <span className={CAP}>Pixel size (GSD)</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {GSD_PRESETS.map(g => (
                <button key={g} onClick={() => setGsd(g)}
                  className={`rounded-md border px-2 py-1 text-[15px] ${gsd === g ? 'border-sky-500 bg-sky-500/15 text-sky-300' : 'border-white/10 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'}`}>{g} m</button>
              ))}
              <input type="number" min="0.05" max="1000" step="0.05" value={gsd}
                onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setGsd(Math.max(0.01, Math.min(1000, v))); }}
                className="w-16 rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-[15px] text-neutral-100 focus:border-sky-500 focus:outline-none" />
            </div>
          </div>
        </>)}
  </>);
}

/**
 * Blur and geolocation: the two figures that can be typed, where each default
 * comes from, and the whole budget. Shared like SensorPick.
 *
 * `budget` says whether the full list of variance sources is shown; step 2's
 * fold keeps it behind a fold of its own, the panel being short.
 */
export function BlurGeo(p: StepProps & { budget?: boolean }) {
  const { source, sigmaX, setSigmaX, sigmaY, setSigmaY, geoErrM, setGeoErrM, geoTyped, setGeoDelivered, placeFor, setPlaceFor } = p.gridApi;
  return (
          <div>
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[14px] text-neutral-500">σ<sub>PSF</sub></span>
              {/* Clamped to the range the restore validator accepts (use-grid.ts),
                  because `max` on a number input is advisory: a pasted 500 gave the
                  PSF a window of 1,500 pixels per axis and hung the page, and would
                  have been thrown away on the next refresh anyway. */}
              {/* Shown to three decimals: a satellite's own figure is its FWHM over 2.3548, sixteen digits of it. What is kept is exact. */}
              <input type="number" min="0" max="5" step="0.1" value={+sigmaX.toFixed(3)}
                onChange={e => setSigmaX(clampSigma(e.target.value))} className={NUM} />
              <span className="text-[14px] text-neutral-500">×</span>
              <input type="number" min="0" max="5" step="0.1" value={+sigmaY.toFixed(3)}
                onChange={e => setSigmaY(clampSigma(e.target.value))} className={NUM} />
              <span className="text-[14px] text-neutral-500">px</span>
            </div>
            {/* A property of the imagery, not of the optics, so it sits with the
                source. What it changes is not the purity but the confidence in
                it: see the range on step 3's card. */}
            <div className="mt-1.5 flex items-center gap-2">
              <span className="w-14 shrink-0 text-[14px] text-neutral-500">CE90</span>
              <input type="number" min="0" max="50" step="0.5" value={geoErrM}
                onChange={e => setGeoErrM(Math.max(0, Math.min(50, parseFloat(e.target.value) || 0)))} className={NUM} />
              <span className="text-[14px] text-neutral-500">m</span>
              {/* The CE90 is each satellite's own figure as delivered until one is typed, and this
                  is the way back. A mode, not a figure: every satellite then takes its OWN
                  provider's figure, in the table as here (sensors.ts sourceCe90). A sensor of
                  one's own has no provider: nothing to go back to. */}
              <button type="button" onClick={setGeoDelivered} disabled={!geoTyped || !source.geo} title="Every satellite at its own provider's figure"
                className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[13px] ${!geoTyped && source.geo ? 'border-sky-400/50 bg-sky-500/15 text-sky-300' : 'border-white/10 text-neutral-400 hover:text-neutral-200'}`}>
                As delivered
              </button>
            </div>
            {/* What a trial is placed for, wherever the page chooses its position: the reader's
                choice, and it only means something against a geolocation error. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[14px]">
              <span className="text-neutral-500">Place the trial for</span>
              {([['held', 'pixels that hold'], ['pure', 'pure pixels']] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setPlaceFor(k)} disabled={!(geoErrM > 0)}
                  className={`rounded border px-1.5 py-0.5 text-[13px] ${placeFor === k && geoErrM > 0 ? 'border-sky-400/50 bg-sky-500/15 text-sky-300' : 'border-white/10 text-neutral-400 hover:text-neutral-200'} disabled:opacity-50`}>
                  {label}
                </button>
              ))}
            </div>
            {/* The line "FWHM 14 m, r = FWHM/GSD = 1.40, measured" stood here; it repeated the
                FWHM and r rows of Every source of blur and was removed on request on 2026-11-24. */}
            {p.budget !== false && <BlurBudget {...p} />}
          </div>
  );
}

/** Every variance source at the page's current setting (VarianceSources), or nothing where there is no blur to budget. */
export function BlurBudget(p: StepProps) {
  const { source, geoErrM, geoTyped, build, pxSize, psfSigmaM, psfSigmaXM, psfSigmaYM, psfAnisotropic,
          geoSigmaM, effSigmaXM, effSigmaYM } = p.gridApi;
  if (!(psfSigmaM > 0)) return null;
  return (
    <VarianceSources
      optX={psfSigmaXM} optY={psfSigmaYM} aniso={psfAnisotropic}
      optFrom={!ownBlur(p.gridApi) ? 'typed' : source.psfMeasured ? 'measured' : source.psfAssumed ? 'assumed' : source.psfSrc ? 'published' : 'typed'}
      geo={geoSigmaM} geoErrM={geoErrM} delivered={!geoTyped && !!source.geo}
      effX={effSigmaXM} effY={effSigmaYM} res={build?.res ?? pxSize}
      threshold={p.exp.threshold}
      plotSideM={p.exp.pattern === 'block' ? Math.min(p.exp.blockDesign.plotLength, p.exp.blockDesign.plotWidth)
        : p.exp.pattern === 'imported' ? undefined : p.exp.stripWidth}
      />
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
export function GridStep(p: StepProps) {
  return <Boundary name="Pixel grid and export"><GridStepBody {...p} /></Boundary>;
}
