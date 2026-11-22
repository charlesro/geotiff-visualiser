import { useMemo } from 'react';
import { Chip, Disclosure, DocChip, Explain, Hero, InfoDot, Step } from '../ui';
import { Boundary } from '../Boundary';
import { fmt } from '../util';
import type { DocId } from '../docs';
import { bufferK, minPlotSideM } from '../resolving';
import { noteFigures } from '../note-model';
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
 * contains the detector) and the simulation adds nothing for it: it reads each
 * pixel through the spot alone (simulate.ts followsSpot). It is listed all the
 * same, greyed, with the sigma actually simulated on its own row, because a
 * blur typed in under a pixel's own footprint cannot be an end-to-end blur,
 * and the simulation then reads the pixel with the footprint's own width.
 *
 * Then the note's own figures for this sensor, worked out as its page works
 * them (note-model.ts): the minimum plot by the central pixel and by any
 * pixel, on a common 2 m grid, and for the design's plot the largest pixel
 * that could follow it and what random placements of the grid leave of it.
 */
function VarianceSources({ optX, optY, aniso, optFrom, geo, geoErrM, geoAuto, geoProvider, box, effX, effY, res,
  threshold, magnitude, catalog, angle, plotSideM }: {
  optX: number; optY: number; aniso: boolean;
  /** Where this sigma came from, which decides whether the pixel box is already in it. */
  optFrom: 'measured' | 'published' | 'typed';
  geo: number; geoErrM: number; geoAuto: boolean;
  /** True when the CE90 is the provider's own figure for this satellite. */
  geoProvider?: boolean;
  box: number;
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
  // The note's sweeps and draws: a tenth of a second at most, and only when one of these figures moves.
  const note = useMemo(
    () => noteFigures({ gsd: res, sigmaPsf: opt, sigmaGeo: geo, threshold: threshold / 100 }, plotSideM),
    [res, opt, geo, threshold, plotSideM]);
  const side = (v: number | null) => (v == null ? 'over 2 km' : `${v} m`);
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
  const Row = ({ name, tip, val, note, dim, warn, doc }: { name: React.ReactNode; tip: React.ReactNode; val: string; note?: string; dim?: boolean; warn?: boolean; doc?: DocId }) => (
    <div className={`flex items-baseline gap-2 ${dim ? 'text-neutral-600' : 'text-neutral-400'}`}>
      <span className="w-36 shrink-0"><Explain below text={tip} doc={doc}><span className={term}>{name}</span></Explain></span>
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
        <Row name={<>σ<sub>geo</sub></>} val={m(geo)} note={geoErrM > 0 ? `CE90 ${geoErrM} m${geoProvider ? ', as delivered' : geoAuto ? ', default' : ''}` : undefined}
          tip="Standard deviation of the geolocation error, per axis. From the provider's accuracy: σgeo = CE90 / 2.146." />
        <Row name={<>σ<sub>eff</sub></>} val={pair(effX, effY)}
          tip="Effective blur: the PSF combined with the geolocation error. σeff = √(σPSF² + σgeo²)." />
        <Row name="pixel footprint" val={m(box)} dim note="included in FWHM" doc="pixel-model"
          tip="Blur from integrating the signal over one pixel, GSD / √12. A measured FWHM already contains it: nothing is added for it." />
        <Row name="σ simulated" val={pair(Math.max(optX, box), Math.max(optY, box))} note={optX < box || optY < box ? 'the footprint: the blur typed is narrower' : 'the PSF alone'}
          doc="pixel-model"
          tip="The blur each pixel is read with: a Gaussian spot of σPSF centred on the pixel, never narrower than the pixel's own footprint." />
      </div>
      <Head><Explain below text="A pixel is pure when its contamination, the share of its signal that comes from other plots, is at most ε."><span className={term}>Threshold <span className="normal-case">ε</span> = {100 - threshold} %</span></Explain></Head>
      <div className="space-y-0.5">
        <Row name="k" val={k.toFixed(2)}
          tip="k = Q⁻¹(ε), where Q is the upper tail of the normal law: 1.28 at 10 %, 1.64 at 5 %." />
        <Row name={<>buffer b = k σ<sub>eff</sub></>} val={m(b)}
          tip="A pixel is pure only if its centre lies at least b inside the plot edge." />
        {core != null && <Row name="pure core L − 2b" val={core > 0 ? m(core) : 'none'} warn={core <= 0} note={`L = ${plotSideM} m`}
          tip="The zone of the plot where pure pixels can lie: the plot side L minus a buffer b along each edge." />}
        {lMin != null && <Row name="min. plot, any pixel" val={`${lMin.toFixed(1)} m`} warn={tooSmall} doc="budget"
          tip="The note's closed form for a square plot: the smallest side that keeps one pure pixel whatever the grid placement, L ≈ GSD + 2 z σeff." />}
      </div>
      <Head><Explain below doc="note-figures" text="The note's figures for this sensor, for a square plot: the smallest side at which a pixel stays pure in the worst of its 204 placements of the grid."><span className={term}>Minimum plot, by the note</span></Explain></Head>
      <div className="space-y-0.5">
        <Row name="central pixel" val={side(note.central)} warn={note.central != null && plotSideM != null && plotSideM < note.central}
          tip="The pixel the plot's coordinates name must stay pure, wherever the image lands within one pixel. The conservative figure, and the one the note sizes a tasked sensor by." />
        <Row name="registered to ½ px" val={side(note.centralRegistered)}
          tip="The same, with the images registered to each other within half a pixel: the note's realistic registration." />
        <Row name="any pixel, swept" val={side(note.anyPixel)}
          tip="At least one pixel, whichever it is, stays pure in every placement. The closed form above is its approximation; this is the sweep itself." />
        <Row name="on a 2 m grid" val={side(note.common2m)} doc="note-figures"
          tip="Central pixel, with this sensor's blur resampled onto 2 m pixels: what is left once every sensor has the same pixel size, the optics alone." />
        {plotSideM != null && note.ceilingGsd != null && <Row name="largest pixel for L" val={`${note.ceilingGsd.toFixed(1)} m`} warn={res > note.ceilingGsd} note={`L = ${plotSideM} m`}
          doc="note-figures"
          tip="The note's hard ceiling: the largest pixel at which a pixel exactly on the plot's centre is still pure, GSD = L / (2 c z), c = σeff / GSD." />}
        {plotSideM != null && note.centred != null && <Row name="centred pixel" val={`${(100 * note.centred).toFixed(1)} %`} warn={note.centred > 1 - threshold / 100}
          tip="Contamination of a pixel sitting exactly on the centre of a square plot of side L: the best a pixel of this plot can do." />}
        {plotSideM != null && note.draws && <Row name="random placements" val={`${note.draws.mean.toFixed(1)} px`} warn={note.draws.atLeastOne < 1}
          note={`${(100 * note.draws.atLeastOne).toFixed(0)} % keep one or more`}
          tip={`The grid dropped at random on a square plot of side L, ${note.draws.n} times: the mean number of pure pixels (from ${note.draws.min} to ${note.draws.max}), and how often at least one is left.`} />}
      </div>
      <Head>Grid placement</Head>
      <div className="space-y-0.5">
        <Row name="grid phase" val={catalog ? 'known' : 'unknown'} note={catalog ? 'counted at the best position' : 'counted at the worst position'}
          doc="grid-position"
          tip="Position of the pixel grid relative to the plots. Known for a fixed grid, counted at its best position; unknown for a tasked sensor, counted at its worst." />
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
                <Explain below text={<>{source.provider} has no fixed grid: each image comes on its own. This one is a grid to ask the provider for, or to resample onto, and the counts do not rely on getting it.</>}>
                  <Chip tone="amber">◇ grid to ask for</Chip>
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
const TERM = 'underline decoration-neutral-700 decoration-dotted underline-offset-2';

/** The blur's width at half its peak, in metres, as the folds print it. */
export function fwhmText({ psfFwhmXM, psfFwhmYM, psfAnisotropic }: StepProps['gridApi']): string {
  const one = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
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
          <Explain align="right" text={source.note} doc="satellites"><InfoDot /></Explain>
        </div>
        {/* What moves every count for this satellite, in a few words each: the
            documentation page says the rest. They were two paragraphs here. */}
        {(source.warn || source.kind !== 'catalog') && (
          <div className="flex flex-wrap items-center gap-1.5">
            {source.warn && <DocChip to="pansharpened" tone="amber">{source.warn}</DocChip>}
            {source.kind !== 'catalog' && <DocChip to="grid-position">Tasked: counted at the worst grid position</DocChip>}
          </div>
        )}

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
  const { source, sigmaX, setSigmaX, sigmaY, setSigmaY, geoErrM, setGeoErrM, geoAuto, setGeoAuto, geoProvider, setGeoProvider, build, pxSize, psfSigmaM, psfSigmaXM, psfSigmaYM,
          psfFwhmXM, psfFwhmYM, psfAnisotropic, placeFor, setPlaceFor } = p.gridApi;
  // Which of the three the CE90 is: the note's default, the provider's figure, or a figure typed.
  // A sensor of one's own has no provider to state one: "as delivered" leaves it on the default.
  const asDelivered = geoProvider && !!source.geo, byDefault = geoProvider ? !source.geo : geoAuto;
  const res = build?.res ?? pxSize;
  const fwhmTxt = fwhmText(p.gridApi);
  const p95 = (s: number) => (2 * 2.448 * s).toFixed(0); // width of the 95% spot, m
  const geo = source.geo;
  return (
          <div>
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[14px] text-neutral-500"><Explain below text="Standard deviation of the PSF, in pixels, along x and y. σPSF = FWHM / 2.355."><span className={TERM}>σ<sub>PSF</sub></span></Explain></span>
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
              <span className="w-14 shrink-0 text-[14px] text-neutral-500"><Explain below doc="geolocation" text="Geolocation accuracy as given by providers: the radius of the circle that contains 90 % of the errors. σgeo = CE90 / 2.146. 0 means no geolocation error."><span className={TERM}>CE90</span></Explain></span>
              <input type="number" min="0" max="50" step="0.5" value={geoErrM}
                onChange={e => setGeoErrM(Math.max(0, Math.min(50, parseFloat(e.target.value) || 0)))} className={NUM} />
              <span className="text-[14px] text-neutral-500">m</span>
              {/* The note's default, and the way back to it after typing a value. */}
              <button type="button" onClick={() => setGeoAuto(true)} disabled={geoAuto && !geoProvider}
                title="The note's default, a third of a pixel: σgeo = GSD / 3, so CE90 = 0.715 GSD. Type a value to use your own."
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[13px] ${byDefault ? 'border-sky-400/50 bg-sky-500/15 text-sky-300' : 'border-white/10 text-neutral-400 hover:text-neutral-200'}`}>
                Default
              </button>
            </div>
            {/* What the provider states for an image as delivered. Not the default
                (see sensors.ts `geo`): beside it, with its source, a click away. */}
            {geo && (
              <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[14px] leading-snug text-neutral-500">
                <span>As delivered, with no ground control:</span>
                <Explain below doc="geolocation" text={<>The provider&rsquo;s own figure: {geo.says}. As a CE90 that is {geo.ce90M} m, for one image read where it was delivered.</>}>
                  <span className={`font-mono text-neutral-300 ${TERM}`}>CE90 {geo.ce90M} m</span>
                </Explain>
                {geo.url
                  ? <a href={geo.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline decoration-dotted hover:text-sky-300">{geo.label} ↗</a>
                  : <span className="text-neutral-300">{geo.label}</span>}
                {/* A mode, not a figure typed in: each satellite then takes its OWN
                    provider's figure, in the table as here (sensors.ts sourceCe90). */}
                <button type="button" onClick={() => setGeoProvider(true)} disabled={asDelivered}
                  title="Hold every satellite against its own provider's figure, here and in the satellites table. Typing a value, or Default, leaves it."
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[13px] ${asDelivered ? 'border-sky-400/50 bg-sky-500/15 text-sky-300' : 'border-white/10 text-neutral-400 hover:text-neutral-200'}`}>
                  {asDelivered ? 'In use' : 'Use'}
                </button>
              </p>
            )}
            {/* What a trial is placed for, wherever the page chooses its position: the reader's
                choice, and it only means something against a geolocation error. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[14px]">
              <Explain below doc="place-for" text="Which position a search looks for: the most pixels that stay pure anywhere within the CE90, or the most pure pixels with the image exactly in place.">
                <span className={`text-neutral-500 ${TERM}`}>Place the trial for</span>
              </Explain>
              {([['held', 'pixels that hold'], ['pure', 'pure pixels']] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setPlaceFor(k)} disabled={!(geoErrM > 0)}
                  className={`rounded border px-1.5 py-0.5 text-[13px] ${placeFor === k && geoErrM > 0 ? 'border-sky-400/50 bg-sky-500/15 text-sky-300' : 'border-white/10 text-neutral-400 hover:text-neutral-200'} disabled:opacity-50`}>
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[14px] leading-snug text-neutral-500">
              {psfSigmaM > 0 ? (<>
                <Explain text={<>Width at half the peak; 95% of the signal falls in a spot {psfAnisotropic ? `${p95(psfSigmaXM)} × ${p95(psfSigmaYM)}` : p95(psfSigmaXM)} m across{source.psfSrc && <> (default σ {source.psfSrc.url
                  ? <>from <a href={source.psfSrc.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline decoration-dotted hover:text-sky-300">{source.psfSrc.label} ↗</a></>
                  : <span className="text-neutral-300">{source.psfSrc.label}</span>})</>}.</>}>
                  <span className="font-mono text-neutral-300">FWHM {fwhmTxt} m</span>
                </Explain>
                , r = FWHM/GSD = {(psfFwhmXM / res).toFixed(2)}
                {psfAnisotropic && <> × {(psfFwhmYM / res).toFixed(2)}</>}
                {source.psfSrc && <>, {source.psfMeasured ? 'measured' : 'from the published MTF'}</>}
              </>) : <>σ<sub>PSF</sub> = 0</>}
            </p>
            {p.budget !== false && <BlurBudget {...p} />}
          </div>
  );
}

/** Every variance source at the page's current setting (VarianceSources), or nothing where there is no blur to budget. */
export function BlurBudget(p: StepProps) {
  const { source, geoErrM, geoAuto, geoProvider, build, pxSize, psfSigmaM, psfSigmaXM, psfSigmaYM, psfAnisotropic,
          geoSigmaM, boxSigmaM, effSigmaXM, effSigmaYM } = p.gridApi;
  if (!(psfSigmaM > 0)) return null;
  return (
    <VarianceSources
      optX={psfSigmaXM} optY={psfSigmaYM} aniso={psfAnisotropic}
      optFrom={source.psfMeasured ? 'measured' : source.psfSrc ? 'published' : 'typed'}
      geo={geoSigmaM} geoErrM={geoErrM} geoAuto={geoProvider ? !source.geo : geoAuto} geoProvider={geoProvider && !!source.geo} box={boxSigmaM}
      effX={effSigmaXM} effY={effSigmaYM} res={build?.res ?? pxSize}
      threshold={p.exp.threshold} magnitude={p.exp.magnitude}
      catalog={source.kind === 'catalog'}
      angle={p.exp.pattern === 'imported' ? p.exp.importedAngle : p.exp.rotation}
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
