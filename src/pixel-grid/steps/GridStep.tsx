import { Chip, Explain, Hero, InfoDot, Step } from '../ui';
import { Boundary } from '../Boundary';
import { fmt } from '../util';
import { bufferK, minPlotSideM, probit } from '../resolving';
import { FIXED, GSD_PRESETS, SOURCES, TASK } from '../sensors';
import { zoneFromEpsg } from '../s2-grid';
import type { StepProps } from './props';

/**
 * Step 2: pick the satellite, see where its pixels really fall, export them.
 *
 * Rendered as a child of `Step`, which unmounts collapsed children, so NOTHING
 * here may hold state. Everything it reads comes from hooks the page shell owns.
 */
/** The blur the sensor model accepts, and the range its saved value is validated against. */
const clampSigma = (raw: string) => Math.max(0, Math.min(5, parseFloat(raw) || 0));

/**
 * Every source of variance between the ground and a pixel's value, with its
 * number at the CURRENT setting, in one list.
 *
 * It exists because a single sigma hides which lever moves it, and because the
 * page used to leave the reader to assemble this from three steps. Four groups:
 * the blur (three independent spreads, totalled in quadrature because it is
 * variances that add, not widths), what that blur costs at the chosen
 * threshold, where the pixel grid and the image may sit, and the signal noise.
 * A last group names what is NOT simulated, so a clean number is never read as
 * a complete one.
 *
 * The pixel footprint is printed but greyed and left out of the total for every
 * preset: a fit on an image and a published MTF at Nyquist are both SYSTEM
 * figures that already contain the detector. The engine applies it anyway, so
 * the kernel it really convolves is its own row. Hiding that would make this
 * list disagree with the purity numbers beside it.
 */
function VarianceSources({ optX, optY, aniso, optFrom, geo, geoErrM, box, boxDoubleCounts, effX, effY, res,
  threshold, magnitude, catalog, angle, plotSideM, sensor }: {
  optX: number; optY: number; aniso: boolean;
  /** Where this sigma came from, which decides whether the pixel box is already in it. */
  optFrom: 'measured' | 'published' | 'typed';
  geo: number; geoErrM: number; box: number; boxDoubleCounts: boolean;
  effX: number; effY: number; res: number;
  /** Purity threshold, percent. */
  threshold: number;
  /** Peak variance of the per-pixel noise, in NDVI squared. */
  magnitude: number;
  /** True when the lattice is the real one read from a catalog. */
  catalog: boolean;
  angle: number;
  /** The design's short plot (or strip) side, when it has one. */
  plotSideM?: number;
  sensor: string;
}) {
  const m = (v: number) => `${v.toFixed(2)} m`;
  const pair = (x: number, y: number) => (aniso ? `${x.toFixed(2)} × ${y.toFixed(2)} m` : m(x));
  const eff = Math.max(effX, effY);
  const k = bufferK(threshold / 100);
  const lMin = minPlotSideM(res, eff, threshold / 100);
  const tooSmall = lMin != null && plotSideM != null && plotSideM < lMin;
  const Row = ({ name, val, why, dim, warn }: { name: string; val: string; why: React.ReactNode; dim?: boolean; warn?: boolean }) => (
    <div className={`flex items-baseline gap-2 ${dim ? 'text-neutral-600' : 'text-neutral-400'}`}>
      <span className="w-[5.6rem] shrink-0">{name}</span>
      <span className={`w-[5.2rem] shrink-0 text-right font-mono ${warn ? 'text-amber-300' : dim ? 'text-neutral-500' : 'text-neutral-300'}`}>{val}</span>
      <span className="min-w-0 text-[10px] leading-snug text-neutral-600">{why}</span>
    </div>
  );
  const Head = ({ children }: { children: React.ReactNode }) => (
    <div className="mb-0.5 mt-2 text-[9px] uppercase tracking-wide text-neutral-600 first:mt-0">{children}</div>
  );
  return (
    <div className="mt-1.5 rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-2 text-[11px]">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-neutral-500">
        Variance sources
        <span className="normal-case tracking-normal text-neutral-600">· {sensor}, {res} m, pure ≥ {threshold}%</span>
        <Explain text={<>Everything that stands between the ground and the value in a pixel, at the current setting. The three blurs are independent, so their <span className="text-neutral-100">variances</span> add, not their widths: the total is √(σ₁² + σ₂²), always less than σ₁ + σ₂.</>}><InfoDot /></Explain>
      </div>

      <Head>Blur, as a sigma</Head>
      <div className="space-y-0.5">
        <Row name="optics" val={pair(optX, optY)}
          why={optFrom === 'measured' ? 'measured on imagery'
            : optFrom === 'published' ? 'from a published MTF at Nyquist'
            : 'the σ you set'} />
        <Row name="pixel footprint" val={m(box)} dim={boxDoubleCounts}
          why={!boxDoubleCounts ? 'one pixel wide, σ = 1/√12'
            : optFrom === 'measured' ? 'already inside the measured FWHM'
            : 'already inside the published system MTF'} />
        <Row name="geolocation" val={m(geo)}
          why={geoErrM > 0 ? `CE90 of ${geoErrM} m ÷ 2.146` : 'Geoloc is 0: the image is assumed exact'} />
        <Row name="effective spot" val={pair(effX, effY)}
          why={`√(optics² + geolocation²), FWHM ${(2.3548 * eff).toFixed(1)} m, ${(2.3548 * eff / res).toFixed(1)}× the pixel`} />
        <Row name="engine kernel" val={pair(Math.hypot(effX, box), Math.hypot(effY, box))} warn={boxDoubleCounts}
          why={boxDoubleCounts ? 'what is really convolved: the footprint is counted twice. Conservative, not correct'
            : 'what is really convolved: the spot and the pixel footprint'} />
      </div>

      <Head>What it costs at {threshold}%</Head>
      <div className="space-y-0.5">
        <Row name="buffer" val={m(k * eff)} why={`${k.toFixed(2)} × effective σ: a pixel is pure only this far inside a plot edge`} />
        {lMin != null && (
          <Row name="smallest plot" val={`${lMin.toFixed(1)} m`} warn={tooSmall}
            why={<>pixel + 2 × {(-probit(1 - Math.sqrt(threshold / 100))).toFixed(2)} × effective σ keeps one pure pixel wherever the grid falls
              {plotSideM != null && <>. This design: <span className={tooSmall ? 'text-amber-300' : 'text-neutral-400'}>{plotSideM} m</span></>}</>} />
        )}
      </div>

      <Head>Placement</Head>
      <div className="space-y-0.5">
        <Row name="pixel grid" val={catalog ? 'fixed' : 'free'}
          why={catalog ? 'the real lattice, read from the catalog: its phase is known' : 'tasked sensor: the phase is only known once the image is taken'} />
        <Row name="image position" val={geoErrM > 0 ? `± ${geoErrM} m` : 'exact'}
          why={geoErrM > 0 ? 'CE90: 9 images in 10 land within it. Step 4 counts the pixels pure anywhere inside' : 'no geolocation error set'} />
        <Row name="trial angle" val={`${angle.toFixed(1)}°`} why="to the pixel rows, as drawn. Not swept" />
      </div>

      <Head>Signal</Head>
      <div className="space-y-0.5">
        <Row name="pixel noise" val={`${Math.sqrt(Math.max(0, magnitude)).toFixed(3)}`}
          why="NDVI, standard deviation at its peak. One draw per pixel, held all season" />
      </div>

      <Head>Not simulated</Head>
      <div className="space-y-0.5">
        <Row name="per-band blur" val="none" dim why="one σ for every band; PlanetScope measures 9.7 to 12 m by band" />
        <Row name="heavy tails" val="none" dim why="Gaussian cut at 3σ; the adjacency effect adds contamination far from an edge" />
        <Row name="plot to plot" val="none" dim why="every plot of a variety has the same curve; replicates differ by about 0.17 LAI at Toulouse" />
        <Row name="grid rotation" val="none" dim why="one angle, the one drawn; the note sweeps four" />
      </div>
    </div>
  );
}

function GridStepBody(p: StepProps) {
  const { activeStep, toggleStep, gridSummary } = p;
  const { aoi } = p.area;
  const { sourceId, setSourceId, source, gsd, setGsd, sigmaX, setSigmaX, sigmaY, setSigmaY, geoErrM, setGeoErrM, grids, gridState, selectedGridKey, setSelectedGridKey, selectedGrid, build, grid, pxSize, psfSigmaM, psfSigmaXM, psfSigmaYM, psfFwhmXM, psfFwhmYM, psfAnisotropic,
          geoSigmaM, boxSigmaM, effSigmaXM, effSigmaYM, boxDoubleCounts, dims, fieldAreaM2, maxAreaHa, fieldCellCount, gridNoun, onDownload } = p.gridApi;

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

        {/* Sensor: the select states its own value, so it needs no label. */}
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

        {/* Blur: σ stays visible; the derivation and the citation go on demand. */}
        {build && (
          <div>
            <div className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-[11px] text-neutral-500">Blur σ</span>
              {/* Clamped to the range the restore validator accepts (use-grid.ts),
                  because `max` on a number input is advisory: a pasted 500 gave the
                  PSF a window of 1,500 pixels per axis and hung the page, and would
                  have been thrown away on the next refresh anyway. */}
              <input type="number" min="0" max="5" step="0.1" value={sigmaX}
                onChange={e => setSigmaX(clampSigma(e.target.value))} className={NUM} />
              <span className="text-[11px] text-neutral-500">×</span>
              <input type="number" min="0" max="5" step="0.1" value={sigmaY}
                onChange={e => setSigmaY(clampSigma(e.target.value))} className={NUM} />
              <span className="text-[11px] text-neutral-500">px</span>
            </div>
            {/* A property of the imagery, not of the optics, so it sits with the
                source. What it changes is not the purity but the confidence in
                it: see the range on step 3's card. */}
            <div className="mt-1.5 flex items-center gap-2">
              <span className="w-10 shrink-0 text-[11px] text-neutral-500">Geoloc</span>
              <input type="number" min="0" max="50" step="0.5" value={geoErrM}
                onChange={e => setGeoErrM(Math.max(0, Math.min(50, parseFloat(e.target.value) || 0)))} className={NUM} />
              <span className="text-[11px] text-neutral-500">m</span>
              <Explain align="right" text={<>How far this product's pixels may sit from where their coordinates say. Sentinel-2 is specified to about 12.5 m and is usually a few metres since the reference-image refinement; Landsat is comparable. Nobody knows the offset when the trial is planted, so each panel of the step 4 ladder shows the range its purity can land in. 0 assumes the imagery is exactly where it says.</>}><InfoDot /></Explain>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-neutral-500">
              {psfSigmaM > 0 ? (<>
                <Explain text={<>Width at half the peak; 95% of the signal falls in a spot {psfAnisotropic ? `${p95(psfSigmaXM)} × ${p95(psfSigmaYM)}` : p95(psfSigmaXM)} m across{source.psfSrc && <> (default σ {source.psfSrc.url
                  ? <>from <a href={source.psfSrc.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline decoration-dotted hover:text-sky-300">{source.psfSrc.label} ↗</a></>
                  : <span className="text-neutral-300">{source.psfSrc.label}</span>})</>}.</>}>
                  <span className="font-mono text-neutral-300">≈{fwhmTxt} m</span>
                </Explain>{' '}
                across a point, {(psfFwhmXM / build.res).toFixed(1)}× the {build.res} m pixel
                {psfAnisotropic && <> across, {(psfFwhmYM / build.res).toFixed(1)}× along the rows</>}.
              </>) : <>σ = 0 → perfectly sharp pixels.</>}
            </p>
            {psfSigmaM > 0 && <VarianceSources
              optX={psfSigmaXM} optY={psfSigmaYM} aniso={psfAnisotropic}
              optFrom={source.psfMeasured ? 'measured' : source.psfSrc ? 'published' : 'typed'}
              geo={geoSigmaM} geoErrM={geoErrM} box={boxSigmaM} boxDoubleCounts={boxDoubleCounts}
              effX={effSigmaXM} effY={effSigmaYM} res={build.res}
              threshold={p.exp.threshold} magnitude={p.exp.magnitude}
              catalog={source.kind === 'catalog'}
              angle={p.exp.pattern === 'imported' ? p.exp.importedAngle : p.exp.rotation}
              plotSideM={p.exp.pattern === 'block' ? Math.min(p.exp.blockDesign.plotLength, p.exp.blockDesign.plotWidth)
                : p.exp.pattern === 'imported' ? undefined : p.exp.stripWidth}
              sensor={source.provider} />}
          </div>
        )}

        {/* A grid you impose: its pixel size is the one thing that defines it. */}
        {source.kind === 'custom' && (<>
          <div>
            <span className={CAP}>Pixel size (GSD)</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {GSD_PRESETS.map(g => (
                <button key={g} onClick={() => setGsd(g)}
                  className={`rounded-md border px-2 py-1 text-sm ${gsd === g ? 'border-sky-500 bg-sky-500/15 text-sky-300' : 'border-white/10 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'}`}>{g} m</button>
              ))}
              <input type="number" min="0.05" max="1000" step="0.05" value={gsd}
                onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setGsd(Math.max(0.01, Math.min(1000, v))); }}
                className="w-16 rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none" />
            </div>
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
