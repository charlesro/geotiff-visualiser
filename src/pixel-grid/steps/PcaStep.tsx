import { useMemo } from 'react';
import { Boundary } from '../Boundary';
import { Disclosure, Explain, InfoDot, Step, Spinner } from '../ui';
import { LayoutFields, LayoutSelect, SpeciesList, SELECT } from './controls';
import { ImportPanel } from './ImportPanel';
import { fmt } from '../util';
import { FIXED, RES_LADDER, SOURCES, TASK } from '../sensors';
import PcaSimVisual from '../PcaSimVisual';
import PcaSweep from '../PcaSweep';
import type { StepProps } from './props';

/**
 * How close two pure pixel counts have to be to be called a tie, as a fraction.
 * How the comparison is staked and measured moves a count by about a percent on
 * its own: the same trial has read 1660 against 1679 at 2 m, and a real file
 * 1650 against 1657 (the ladder section of the pixel-grid suite). A gap under
 * this one says nothing about the placement. The sentence prints the figure from
 * this constant, so the words and the ranking cannot drift apart.
 */
const TIE = 0.97;
const TIE_PCT = Math.round(TIE * 100);

/**
 * Step 4: the PCA over the field, and the same PCA across resolutions.
 *
 * Rendered as a child of `Step`, which unmounts collapsed children, so NOTHING
 * here may hold state. Everything it reads comes from hooks the page shell owns.
 */
function PcaStepBody(p: StepProps) {
  const { activeStep, toggleStep, } = p;
  const { aoi } = p.area;
  const { sourceId, setSourceId, build, pickRes } = p.gridApi;
  const { pattern, setPattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation, magnitude, threshold, blockDesign, setBlockDesign, speciesD, presetsActive, colors, names, setSpeciesAt, setPresetAt, importedDesign, varieties, importedPlan, importedAngle } = p.exp;
  const imported = pattern === 'imported';
  // The angle the ladder compares: the trial's own for an imported one.
  const angle = imported ? importedAngle : rotation;
  const angleLabel = Math.round(angle * 10) / 10;
  const aligned = Math.min(angle, 90 - angle) < 0.05;
  const { pcaBusy, pcaView, pcaSubsampled, setSelectedPixels, sweep, sweepBusy } = p.pca;
  const { pcaRetuneOpen, setPcaRetuneOpen, compareAligned, setCompareAligned, pcaColorBy, setPcaColorBy, pcaShapeBy, setPcaShapeBy } = p;
  const { sweepAligned } = p.pca;
  // The big chart's simulation, for the thumbnail of the size it was computed at.
  // Right after a click the grid is already the new size while the chart still
  // shows the old one; until the new one lands that thumbnail draws its own rung.
  const activeSim = pcaView && build && Math.abs(pcaView.res - build.res) < 1e-9 ? pcaView.sim : null;
  /**
   * The two ladders compared size by size, on the number of each trial's own
   * pixels that come out pure (both counted over the pixels overlapping their
   * own outline), only where both rungs are complete: a placeholder or a central
   * window is not the trial.
   *
   * Counts, not percentages, and the panel prints what is ranked here. The two
   * placements cover the same ground but not the same number of edge pixels, so
   * each rung's percentage is taken over its own total and a pair can rank
   * backwards: 40 pure of 80 trial pixels (50%) against 39 of 100 (39%) is one
   * pure pixel lost, not eleven points, and the sentence used to call that a tie
   * while printing the two percentages that contradicted it.
   *
   * The count is also the decision: more pure pixels is more usable data off the
   * same ground, and that is what the reader is choosing between. A placement
   * can hold a HIGHER rate over a smaller total and still hand back fewer pixels
   * to analyse, so both totals are carried through and printed beside the counts
   * rather than hidden, and the denominators are visibly not the same. (An
   * imported trial is staked by maximising this same count, purePixels; a
   * periodic layout's phase search maximises mean coverage instead, so do not
   * read this as "the verdict reads whatever the search optimised".)
   */
  const comparison = (() => {
    if (!sweep || !sweepAligned) return null;
    const rows = sweepAligned.flatMap(al => {
      const own = sweep.find(s => Math.abs(s.res - al.res) < 1e-9);
      if (!own || own.current || own.partial || al.partial) return [];
      const d = own.pureCount ?? NaN, a = al.pureCount ?? NaN;
      if (!Number.isFinite(d) || !Number.isFinite(a) || (d === 0 && a === 0)) return [];
      return [{ res: al.res, drawnCount: d, alignedCount: a,
                drawnTotal: own.trialCount ?? NaN, alignedTotal: al.trialCount ?? NaN }];
    });
    if (!rows.length) return null;
    return { first: rows[0], worse: rows.filter(x => x.alignedCount < x.drawnCount * TIE).map(x => x.res) };
  })();
  // A fresh array every render would defeat PcaSweep's memo; keyed on the angle only.
  const pairLabels = useMemo<[string, string]>(() => [`at ${angleLabel}° · your design`, 'at 0° · on the pixel grid'], [angleLabel]);

  const compareBtn = (
    <button type="button" onClick={() => setCompareAligned(v => !v)} disabled={aligned}
      title={aligned
        ? 'Already aligned with the pixels'
        : 'Compare with rows aligned to the pixels'}
      className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal transition-colors disabled:opacity-30 ${compareAligned ? 'bg-sky-500/15 text-sky-300' : 'text-neutral-500 hover:text-neutral-300'}`}>
      vs aligned
    </button>
  );

  return (
        <Step n={4} title="PCA simulation" summary={`${pattern === 'imported' ? `${names.length} ${names.length === 1 ? 'variety' : 'varieties'}` : names.length > 4 ? `${names.length} species` : names.join(' × ')} → PCA`} open={activeStep === 'pca'} onClick={() => toggleStep('pca')} enabled={!!aoi}>
        {!aoi ? (
          <p className="text-xs text-neutral-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : pcaView ? (
          <div className="space-y-3">
            <PcaSimVisual sim={pcaView.sim} species={speciesD} colors={colors} names={names} magnitude={magnitude} threshold={threshold}
              colorBy={pcaColorBy} setColorBy={setPcaColorBy} shapeBy={pcaShapeBy} setShapeBy={setPcaShapeBy}
              onSelect={setSelectedPixels} busy={pcaBusy} />
            {pcaSubsampled && (
              <p className="text-[11px] leading-snug text-neutral-500">
                Computed on a representative {fmt(pcaView.sim.total)}-pixel central subsample, as the field is too fine to draw in full.
              </p>
            )}

            <div className="rounded-lg border border-white/10 bg-black/20 p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] text-neutral-400">
                  Across resolutions
                  {/* While comparing, the panels are labelled with counts, and the legend has to say so. */}
                  <Explain text={sweepAligned
                    ? <>One PCA per pixel size, twice: your design and the same design along the pixel rows (px = pure pixels). The two placements catch different numbers of edge pixels, so their totals differ and only the counts compare. Click a panel to show that size on the map.</>
                    : <>One PCA per pixel size (% = pure pixels); click a panel to show that size on the map.</>}><InfoDot /></Explain>
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                  {sweepBusy && <><Spinner className="h-3 w-3" /> <span className="text-sky-300">Updating…</span></>}
                </span>
              </div>
              {sweep ? (
                sweepAligned ? (
                  // One row per resolution: your design on the left, the same design
                  // with the rows along the pixels on the right, so 0.5 m sits next
                  // to 0.5 m, 1 m next to 1 m, and only the angle differs in a pair.
                  // Labelled with counts, the quantity the two placements share.
                  <div className="space-y-2">
                    <PcaSweep steps={sweep} pairWith={sweepAligned}
                      pairLabels={pairLabels} showCounts
                      species={speciesD} colors={colors} magnitude={magnitude} threshold={threshold} colorBy={pcaColorBy}
                      activeRes={build?.res} activeSim={activeSim} activePartial={pcaView?.subsampled} onPick={pickRes} />
                    {comparison ? (
                      <p className="text-[11px] leading-snug text-neutral-500">
                        Pure pixels at {comparison.first.res} m: <span className="font-mono text-sky-300">{fmt(comparison.first.drawnCount)}</span>
                        {/* The totals are printed only when both rungs reported one, never one side alone: half a ratio would read as the other's. */}
                        {Number.isFinite(comparison.first.drawnTotal) && Number.isFinite(comparison.first.alignedTotal)
                          ? <> of {fmt(comparison.first.drawnTotal)} trial pixels at {angleLabel}° vs <span className="font-mono text-neutral-300">{fmt(comparison.first.alignedCount)}</span> of {fmt(comparison.first.alignedTotal)} along the pixel rows.</>
                          : <> at {angleLabel}° vs <span className="font-mono text-neutral-300">{fmt(comparison.first.alignedCount)}</span> along the pixel rows.</>}
                        {/* Said only as far as the numbers show it, in the figure they were ranked on. */}
                        {comparison.worse.length === 0
                          ? ` Along the rows keeps at least ${TIE_PCT}% of your design's pure pixels at every size compared.`
                          : ` Along the rows keeps under ${TIE_PCT}% of your design's pure pixels at ${comparison.worse.join(', ')} m.`}
                      </p>
                    ) : (
                      <p className="text-[11px] leading-snug text-neutral-500">Comparing the two ladders…</p>
                    )}
                  </div>
                ) : (
                  <PcaSweep steps={sweep} species={speciesD} colors={colors} magnitude={magnitude} threshold={threshold} colorBy={pcaColorBy}
                    activeRes={build?.res} activeSim={activeSim} activePartial={pcaView?.subsampled} onPick={pickRes} />
                )
              ) : <p className="text-[11px] leading-snug text-neutral-500">Computing the PCA at {RES_LADDER[0]}–{RES_LADDER[RES_LADDER.length - 1]} m…</p>}
            </div>

            <Disclosure
              label={pattern === 'imported'
                ? `Retune design: ${names.length} ${names.length === 1 ? 'variety' : 'varieties'} · ${importedDesign ? `${angleLabel}°` : 'no file yet'}`
                : pattern === 'block'
                ? `Retune design: ${names.length} species · ${blockDesign.nBlocks} blocks · ${rotation}°`
                : `Retune design: ${names.join(' × ')} · ${stripWidth} m strips · ${rotation}°`}
              open={pcaRetuneOpen} onToggle={() => setPcaRetuneOpen(v => !v)}>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-neutral-500">Resolution · grid</label>
                  <select value={sourceId} onChange={e => setSourceId(e.target.value)} className={SELECT}>
                    {[FIXED, TASK].map(g => (
                      <optgroup key={g} label={g}>
                        {SOURCES.filter(s => s.group === g).map(s => (
                          <option key={s.id} value={s.id}>{s.provider}{s.resLabel ? ` · ${s.resLabel}` : ''}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <LayoutSelect pattern={pattern} setPattern={setPattern} selectClass={SELECT} />
              </div>
              {pattern === 'imported' ? (
                <>
                  <ImportPanel design={importedDesign} varieties={varieties} {...p.importApi} />
                  {importedPlan && (
                    <LayoutFields stripWidth={stripWidth} setStripWidth={setStripWidth}
                      spacing={spacing} setSpacing={setSpacing} pattern={pattern}
                      rotation={angle} setRotation={p.importApi.setAngle} rotationLabel="Trial angle"
                      rotationAction={compareBtn} />
                  )}
                  {varieties.length > 0 && (
                    <Disclosure label={`Growth curves · ${names.length} ${names.length === 1 ? 'variety' : 'varieties'}`}
                      open={p.curvesOpen} onToggle={() => p.setCurvesOpen(v => !v)}>
                      <SpeciesList wrapperClass="grid grid-cols-2 gap-2"
                        species={speciesD} presets={presetsActive} colors={colors} names={names}
                        setSpeciesAt={setSpeciesAt} setPresetAt={setPresetAt} />
                    </Disclosure>
                  )}
                </>
              ) : (
                <>
                  <LayoutFields stripWidth={stripWidth} setStripWidth={setStripWidth}
                    spacing={spacing} setSpacing={setSpacing}
                    pattern={pattern} blockDesign={blockDesign} setBlockDesign={setBlockDesign}
                    rotation={rotation} setRotation={setRotation} rotationLabel="Field rotation"
                    rotationAction={compareBtn} />
                  <SpeciesList wrapperClass="grid grid-cols-2 gap-2"
                    species={speciesD} presets={presetsActive} colors={colors} names={names}
                    setSpeciesAt={setSpeciesAt} setPresetAt={setPresetAt} />
                </>
              )}
            </Disclosure>
          </div>
        ) : pcaBusy ? (
          // Between opening this step and the deferred run landing there is no view
          // yet, and the panel used to blame the grid for it.
          <p className="flex items-center gap-1.5 text-xs text-neutral-400"><Spinner className="h-3 w-3" /> Running the PCA over the field…</p>
        ) : (
          <p className="text-xs text-neutral-400">Build the pixel grid in step&nbsp;2 first.</p>
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
export function PcaStep(p: StepProps) {
  return <Boundary name="PCA simulation"><PcaStepBody {...p} /></Boundary>;
}
