import { Chip, Disclosure, Explain, Hero, InfoDot, Step } from '../ui';
import { Boundary } from '../Boundary';
import { fmt } from '../util';
import { bufferK, minPlotSideM } from '../resolving';
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
 * alpha (MTF at Nyquist), sigma_PSF, sigma_geo, sigma_eff, threshold epsilon,
 * buffer b = k sigma_eff, pure core L - 2b, minimum plot (any pixel).
 *
 * The pixel footprint is not a term of the note (a measured FWHM already
 * contains the detector), but the engine applies it, so it is listed, greyed
 * for every preset, with the sigma actually simulated on its own row.
 */
function VarianceSources({ optX, optY, aniso, optFrom, geo, geoErrM, geoAuto, box, boxDoubleCounts, effX, effY, res,
  threshold, magnitude, catalog, angle, plotSideM }: {
  optX: number; optY: number; aniso: boolean;
  /** Where this sigma came from, which decides whether the pixel box is already in it. */
  optFrom: 'measured' | 'published' | 'typed';
  geo: number; geoErrM: number; geoAuto: boolean; box: number; boxDoubleCounts: boolean;
  effX: number; effY: number; res: number;
  /** Purity threshold, percent (epsilon is its complement). */
  threshold: number;
  /** Peak variance of the per-pixel noise, in NDVI squared. */
  magnitude: number;
  /** True when the lattice is the real one read from a catalog. */
  catalog: boolean;
  angle: number;
  /** The design's short plot (or strip) side L, when it has one. */
  plotSideM?: number;
}) {
  const m = (v: number) => `${v.toFixed(2)} m`;
  const pair = (x: number, y: number) => (aniso ? `${x.toFixed(2)} × ${y.toFixed(2)} m` : m(x));
  const eff = Math.max(effX, effY), opt = Math.max(optX, optY);
  const r = (2.3548 * opt) / res;
  const k = bufferK(threshold / 100), b = k * eff;
  const lMin = minPlotSideM(res, eff, threshold / 100);
  const tooSmall = lMin != null && plotSideM != null && plotSideM < lMin;
  const core = plotSideM != null ? plotSideM - 2 * b : null;
  const term = 'underline decoration-neutral-700 decoration-dotted underline-offset-2';
  // Two decimals, except below 0.01 where that would print 0.00 for a value
  // that is not zero (PlanetScope's alpha is about 9 x 10^-5): then one
  // significant digit and a power of ten.
  const small = (v: number): string => {
    if (!(v > 0) || v >= 0.01) return v.toFixed(2);
    let e = Math.floor(Math.log10(v)), d = Math.round(v / 10 ** e);
    if (d === 10) { d = 1; e += 1; }
    return `${d} × 10${String(e).replace('-', '⁻').replace(/\d/g, c => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c])}`;
  };
  const Row = ({ name, tip, val, note, dim, warn }: { name: React.ReactNode; tip: React.ReactNode; val: string; note?: string; dim?: boolean; warn?: boolean }) => (
    <div className={`flex items-baseline gap-2 ${dim ? 'text-neutral-600' : 'text-neutral-400'}`}>
      <span className="w-36 shrink-0"><Explain below text={tip}><span className={term}>{name}</span></Explain></span>
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
        <Row name="GSD" val={`${res} m`}
          tip="Ground sampling distance: the size of a pixel on the ground." />
        <Row name="FWHM" val={pair(2.3548 * optX, 2.3548 * optY)}
          note={optFrom === 'measured' ? 'measured' : optFrom === 'published' ? 'published MTF' : undefined}
          tip={<>Full width at half maximum of the PSF: the distance between the two points where the blur spot drops to half of its peak. FWHM = 2.355 σ<sub>PSF</sub>.</>} />
        <Row name="r = FWHM/GSD" val={r.toFixed(2)}
          tip="The blur spot compared with the pixel. r = 1: the spot fits in one pixel. r > 1: it spills into the neighbouring pixels." />
        <Row name="α" val={small(Math.exp(-0.890 * r * r))} note="MTF at Nyquist"
          tip="Share of contrast kept at the Nyquist frequency of the pixel grid, α = exp(−0.890 r²). Sentinel-2 is specified at 0.15 to 0.30. A small α means the optics, not the pixel, limit the resolution." />
        <Row name={<>σ<sub>PSF</sub></>} val={pair(optX, optY)}
          tip="Standard deviation of the PSF, modelled as a Gaussian. σPSF = FWHM / 2.355." />
        <Row name={<>σ<sub>geo</sub></>} val={m(geo)} note={geoErrM > 0 ? `CE90 ${geoErrM} m${geoAuto ? ', GSD / 3' : ''}` : undefined}
          tip="Standard deviation of the geolocation error, per axis. From the provider's accuracy: σgeo = CE90 / 2.146." />
        <Row name={<>σ<sub>eff</sub></>} val={pair(effX, effY)}
          tip="Effective blur: the PSF combined with the geolocation error. σeff = √(σPSF² + σgeo²)." />
        <Row name="pixel footprint" val={m(box)} dim={boxDoubleCounts} note={boxDoubleCounts ? 'included in FWHM' : undefined}
          tip="Blur from integrating the signal over one pixel, GSD / √12. A FWHM measured on images already contains it, so it is not added to σeff." />
        <Row name="σ simulated" val={pair(Math.hypot(optX, box), Math.hypot(optY, box))} note="with pixel footprint"
          tip="The blur the simulation draws the map with: σPSF and the pixel footprint, √(σPSF² + GSD²/12). The geolocation error is not blurred in: it is read as the pixels that stay pure within the CE90." />
      </div>
      <Head><Explain below text="A pixel is pure when its contamination, the share of its signal that comes from other plots, is at most ε."><span className={term}>Threshold <span className="normal-case">ε</span> = {100 - threshold} %</span></Explain></Head>
      <div className="space-y-0.5">
        <Row name="k" val={k.toFixed(2)}
          tip="k = Q⁻¹(ε), where Q is the upper tail of the normal law: 1.28 at 10 %, 1.64 at 5 %." />
        <Row name={<>buffer b = k σ<sub>eff</sub></>} val={m(b)}
          tip="A pixel is pure only if its centre lies at least b inside the plot edge." />
        {core != null && <Row name="pure core L − 2b" val={core > 0 ? m(core) : 'none'} warn={core <= 0} note={`L = ${plotSideM} m`}
          tip="The zone of the plot where pure pixels can lie: the plot side L minus a buffer b along each edge." />}
        {lMin != null && <Row name="min. plot, any pixel" val={`${lMin.toFixed(1)} m`} warn={tooSmall}
          tip="The note's closed form for a square plot: the smallest side that keeps at least one pure pixel whatever the grid placement, L ≈ GSD + 2 z σeff, with z = Q⁻¹(1 − √(1 − ε)). It counts the nearest border on each side only. The card below counts the opposite border too, for any plot shape, and asks for a little more." />}
      </div>
      <Head>Grid placement</Head>
      <div className="space-y-0.5">
        <Row name="grid phase" val={catalog ? 'known' : 'unknown'}
          tip="Position of the pixel grid relative to the plots. Known for a fixed grid read from the catalog (Sentinel-2, Landsat). Unknown for a tasked sensor until the image is taken." />
        <Row name="grid rotation" val={`${angle.toFixed(1)}°`}
          tip="Angle between the plot rows and the pixel grid." />
      </div>
      <Head>Signal</Head>
      <div className="space-y-0.5">
        <Row name="noise" val={Math.sqrt(Math.max(0, magnitude)).toFixed(3)} note="NDVI, standard deviation"
          tip="Standard deviation of the noise added to the NDVI series of each pixel, at its peak." />
      </div>
      <Head>Not simulated</Head>
      <div className="text-[13px] text-neutral-600">
        <Explain below text="The FWHM differs between bands (PlanetScope: 9.7 to 12 m). One value is used for all bands."><span className={term}>per-band FWHM</span></Explain>,{' '}
        <Explain below text="A real PSF has heavier tails than a Gaussian (adjacency effect), which adds contamination far from an edge."><span className={term}>heavier tails (adjacency effect)</span></Explain>,{' '}
        <Explain below text="Two replicates of the same variety differ, by about 0.17 LAI at the peak at Toulouse. Here every plot of a variety has the same curve."><span className={term}>variance between replicates</span></Explain>,{' '}
        <Explain below align="right" text="The note keeps the worst case over four grid rotations. Only the rotation drawn is simulated."><span className={term}>other grid rotations</span></Explain>
      </div>
    </div>
  );
}

function GridStepBody(p: StepProps) {
  const { activeStep, toggleStep, gridSummary, blurOpen, setBlurOpen } = p;
  const { aoi } = p.area;
  const { sourceId, setSourceId, source, gsd, setGsd, sigmaX, setSigmaX, sigmaY, setSigmaY, geoErrM, setGeoErrM, geoAuto, setGeoAuto, grids, gridState, selectedGridKey, setSelectedGridKey, selectedGrid, build, grid, pxSize, psfSigmaM, psfSigmaXM, psfSigmaYM, psfFwhmXM, psfFwhmYM, psfAnisotropic,
          geoSigmaM, boxSigmaM, effSigmaXM, effSigmaYM, boxDoubleCounts, dims, fieldAreaM2, maxAreaHa, fieldCellCount, gridNoun, onDownload } = p.gridApi;

  const fwhmTxt = psfAnisotropic
    ? `${psfFwhmXM < 10 ? psfFwhmXM.toFixed(1) : Math.round(psfFwhmXM)} × ${psfFwhmYM < 10 ? psfFwhmYM.toFixed(1) : Math.round(psfFwhmYM)}`
    : `${psfFwhmXM < 10 ? psfFwhmXM.toFixed(1) : Math.round(psfFwhmXM)}`;
  const p95 = (s: number) => (2 * 2.448 * s).toFixed(0); // width of the 95% spot, m
  const SELECT = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-[15px] text-neutral-100 focus:border-sky-500 focus:outline-none';
  const NUM = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-[15px] text-neutral-100 focus:border-sky-500 focus:outline-none';
  const CAP = 'mb-1 block text-[14px] text-neutral-500';

  return (
        <Step n={STEP_NO.grid} title="Pixel grid & export" summary={gridSummary} open={activeStep === 'grid'} onClick={() => toggleStep('grid')} enabled={!!aoi}>
        {!aoi ? (
          <p className="text-[14px] text-neutral-400">Draw an experiment area in step&nbsp;1 first.</p>
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
          <div>
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[14px] text-neutral-500"><Explain below text="Standard deviation of the PSF, in pixels, along x and y. σPSF = FWHM / 2.355."><span className="underline decoration-neutral-700 decoration-dotted underline-offset-2">σ<sub>PSF</sub></span></Explain></span>
              {/* Clamped to the range the restore validator accepts (use-grid.ts),
                  because `max` on a number input is advisory: a pasted 500 gave the
                  PSF a window of 1,500 pixels per axis and hung the page, and would
                  have been thrown away on the next refresh anyway. */}
              <input type="number" min="0" max="5" step="0.1" value={sigmaX}
                onChange={e => setSigmaX(clampSigma(e.target.value))} className={NUM} />
              <span className="text-[14px] text-neutral-500">×</span>
              <input type="number" min="0" max="5" step="0.1" value={sigmaY}
                onChange={e => setSigmaY(clampSigma(e.target.value))} className={NUM} />
              <span className="text-[14px] text-neutral-500">px</span>
            </div>
            {/* A property of the imagery, not of the optics, so it sits with the
                source. What it changes is not the purity but the confidence in
                it: see the range on step 3's card. */}
            <div className="mt-1.5 flex items-center gap-2">
              <span className="w-14 shrink-0 text-[14px] text-neutral-500"><Explain below text="Geolocation accuracy as given by providers: the radius of the circle that contains 90 % of the errors. σgeo = CE90 / 2.146. 0 means no geolocation error."><span className="underline decoration-neutral-700 decoration-dotted underline-offset-2">CE90</span></Explain></span>
              <input type="number" min="0" max="50" step="0.5" value={geoErrM}
                onChange={e => setGeoErrM(Math.max(0, Math.min(50, parseFloat(e.target.value) || 0)))} className={NUM} />
              <span className="text-[14px] text-neutral-500">m</span>
              {/* The note's default, and the way back to it after typing a value. */}
              <button type="button" onClick={() => setGeoAuto(true)} disabled={geoAuto}
                title="σgeo = GSD / 3, the default when no accuracy is known: CE90 = 2.146 × GSD / 3. Type a value to use your own."
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[13px] ${geoAuto ? 'border-sky-400/50 bg-sky-500/15 text-sky-300' : 'border-white/10 text-neutral-400 hover:text-neutral-200'}`}>
                GSD/3
              </button>

            </div>
            <p className="mt-1 text-[14px] leading-snug text-neutral-500">
              {psfSigmaM > 0 ? (<>
                <Explain text={<>Width at half the peak; 95% of the signal falls in a spot {psfAnisotropic ? `${p95(psfSigmaXM)} × ${p95(psfSigmaYM)}` : p95(psfSigmaXM)} m across{source.psfSrc && <> (default σ {source.psfSrc.url
                  ? <>from <a href={source.psfSrc.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline decoration-dotted hover:text-sky-300">{source.psfSrc.label} ↗</a></>
                  : <span className="text-neutral-300">{source.psfSrc.label}</span>})</>}.</>}>
                  <span className="font-mono text-neutral-300">FWHM {fwhmTxt} m</span>
                </Explain>
                , r = FWHM/GSD = {(psfFwhmXM / build.res).toFixed(2)}
                {psfAnisotropic && <> × {(psfFwhmYM / build.res).toFixed(2)}</>}
              </>) : <>σ<sub>PSF</sub> = 0</>}
            </p>
            {psfSigmaM > 0 && <VarianceSources
              optX={psfSigmaXM} optY={psfSigmaYM} aniso={psfAnisotropic}
              optFrom={source.psfMeasured ? 'measured' : source.psfSrc ? 'published' : 'typed'}
              geo={geoSigmaM} geoErrM={geoErrM} geoAuto={geoAuto} box={boxSigmaM} boxDoubleCounts={boxDoubleCounts}
              effX={effSigmaXM} effY={effSigmaYM} res={build.res}
              threshold={p.exp.threshold} magnitude={p.exp.magnitude}
              catalog={source.kind === 'catalog'}
              angle={p.exp.pattern === 'imported' ? p.exp.importedAngle : p.exp.rotation}
              plotSideM={p.exp.pattern === 'block' ? Math.min(p.exp.blockDesign.plotLength, p.exp.blockDesign.plotWidth)
                : p.exp.pattern === 'imported' ? undefined : p.exp.stripWidth}
              />}
          </div>
          </Disclosure>
        )}

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
