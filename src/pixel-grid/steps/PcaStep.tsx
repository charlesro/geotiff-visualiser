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
 * How far apart two purities have to be, in percentage POINTS, before the panel
 * will call one placement worse than the other.
 *
 * Two points, because that is the width of the measurement rather than a round
 * number. Over a large field a rung is simulated on a central window
 * (LADDER_MAX_CELLS), and shrinking that window from 40,000 pixels to 20,000
 * moved the gap between the two ladders by about half a point; staking and
 * rounding account for about as much again. A verdict inside that is a verdict
 * about the sample, not about the placement. The sentence prints this same
 * number, so what is said and what is ranked cannot drift apart.
 */
const TIE_POINTS = 2;

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
  // The angle the ladder compares: the trial's own for an imported one, or the
  // one it was turned FROM when the aligned placement was adopted from the
  // ladder, which is the side of the comparison the design is no longer at.
  const own = imported ? importedAngle : rotation;
  const angle = p.compareFrom ?? own;
  const angleLabel = Math.round(angle * 10) / 10;
  /** Which of the two placements is the one currently on the map. */
  const onMap: 0 | 1 = p.compareFrom === null ? 0 : 1;
  const aligned = Math.min(angle, 90 - angle) < 0.05;
  const { pcaBusy, pcaView, pcaSubsampled, pcaGrid, setSelectedPixels, sweep, sweepBusy } = p.pca;
  const { pcaRetuneOpen, setPcaRetuneOpen, compareAligned, setCompareAligned, pcaColorBy, setPcaColorBy, pcaShapeBy, setPcaShapeBy } = p;
  const { sweepAligned } = p.pca;
  // The big chart's simulation, for the thumbnail of the size it was computed at.
  // Right after a click the grid is already the new size while the chart still
  // shows the old one; until the new one lands that thumbnail draws its own rung.
  const activeSim = pcaView && build && Math.abs(pcaView.res - build.res) < 1e-9 ? pcaView.sim : null;
  /**
   * The big chart is only lent to the left-hand ladder while that ladder IS the
   * placement on the map.
   *
   * The panel at the displayed size borrows the big scatter's own simulation
   * rather than computing the size twice. That is only the same trial while the
   * design sits at the left ladder's angle: once the aligned placement is
   * adopted, the big chart is the RIGHT ladder's trial, and lending it to the
   * left made one cell of a ladder that must not move read 12% where its own
   * rung says 13%. Withheld rather than lent to the other side: the rung is then
   * filled by the idle pass, which is a moment of "..." instead of a number that
   * belongs to the other placement.
   */
  const lendable = onMap === 0 ? activeSim : null;
  /**
   * The two ladders compared size by size, on the SHARE of each trial's own
   * pixels that come out pure, only where both rungs are complete: a placeholder
   * or a central window is not the trial.
   *
   * The percentage is the quantity, and it is also the one ranked on, which is
   * the part that was wrong before. The verdict used to be decided on raw counts
   * while the sentence printed percentages, so the two could contradict each
   * other in one breath: 40 pure of 80 (50%) against 39 of 100 (39%) is one
   * pure pixel lost, read as a tie, printed beside two numbers eleven points
   * apart. Whatever is shown is what decides, so the reader can see why.
   *
   * The two placements cover the same ground but catch a different number of
   * edge pixels, so the denominators are not identical. Both totals are carried
   * through and printed, rather than leaving two bare percentages to imply they
   * were taken over the same thing.
   */
  const comparison = (() => {
    if (!sweep || !sweepAligned) return null;
    const rows = sweepAligned.flatMap(al => {
      const own = sweep.find(s => Math.abs(s.res - al.res) < 1e-9);
      if (!own || own.current || own.partial || al.partial) return [];
      if (!Number.isFinite(own.purePct) || !Number.isFinite(al.purePct) || (own.purePct === 0 && al.purePct === 0)) return [];
      return [{ res: al.res, drawn: own.purePct, aligned: al.purePct,
                drawnTotal: own.trialCount ?? NaN, alignedTotal: al.trialCount ?? NaN }];
    });
    if (!rows.length) return null;
    // `sizes` is how many pairs were actually judged, which is NOT every panel
    // on screen: a rung sampled over a central window is excluded, and those
    // panels still show their own percentages. Without saying how many were
    // compared, a verdict reading "at every size" sits above a 0.5 m pair nine
    // points apart and looks like it is contradicting them.
    return { first: rows[0], sizes: rows.length,
             worse: rows.filter(x => x.aligned < x.drawn - TIE_POINTS).map(x => x.res) };
  })();
  /**
   * Picking a rung of the ALIGNED ladder. Those panels are the design turned
   * along the pixel rows, so the click has to turn it: picking one used to set
   * the pixel size and leave the map showing the design at its own angle, which
   * is neither of the two things being compared. It is the same turn the "vs
   * aligned" ladder simulated, so what lands on the map is the panel clicked.
   */
  const pickAligned = (r: number) => {
    pickRes(r);
    // Remembered BEFORE the turn, so the comparison keeps showing the placement
    // this one was chosen over, and clicking back is one click.
    p.setCompareFrom(angle);
    if (imported) p.importApi.setAngle(0);
    else setRotation(0);
  };
  /**
   * Picking a rung of the left-hand ladder. It is the design at its own angle,
   * so this is also the way BACK from having adopted the aligned placement: the
   * panel is that placement, and clicking it puts it on the map again.
   */
  const pickOwn = (r: number) => {
    pickRes(r);
    if (p.compareFrom !== null) {
      if (imported) p.importApi.setAngle(p.compareFrom);
      else setRotation(p.compareFrom);
      p.setCompareFrom(null);
    }
  };
  // A fresh array every render would defeat PcaSweep's memo; keyed on the angle only.
  /**
   * Both placements are named by their angle, and the one actually on the map is
   * marked. Before, the left was flatly "your design": adopting the right-hand
   * placement then made that label a lie, on the one panel that had not changed.
   */
  const pairLabels = useMemo<[string, string]>(() => [
    `at ${angleLabel}° · your design${onMap === 0 ? ' · shown' : ''}`,
    `at 0° · on the pixel grid${onMap === 1 ? ' · shown' : ''}`,
  ], [angleLabel, onMap]);

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
                Computed on every {fmt(pcaGrid?.stride ?? 1)}th pixel across the whole field, {fmt(pcaView.sim.total)} in all, as it is too fine to draw every one.
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
                  <div className="space-y-2">
                    <PcaSweep steps={sweep} pairWith={sweepAligned}
                      pairLabels={pairLabels}
                      species={speciesD} colors={colors} magnitude={magnitude} threshold={threshold} colorBy={pcaColorBy}
                      activeRes={build?.res} activeSim={lendable}
                      onPick={pickOwn} onPickPair={pickAligned} />
                    {comparison ? (
                      <p className="text-[11px] leading-snug text-neutral-500">
                        Pure pixels at {comparison.first.res} m: <span className="font-mono text-sky-300">{comparison.first.drawn.toFixed(0)}%</span> at {angleLabel}°
                        vs <span className="font-mono text-neutral-300">{comparison.first.aligned.toFixed(0)}%</span> along the pixel rows.
                        {/* The two shares are taken over each placement's own trial pixels, and the
                            placements catch different numbers of edge pixels. Printed only when both
                            rungs reported a total, never one side alone: half a ratio reads as the other's. */}
                        {Number.isFinite(comparison.first.drawnTotal) && Number.isFinite(comparison.first.alignedTotal) && (
                          <> Of {fmt(comparison.first.drawnTotal)} and {fmt(comparison.first.alignedTotal)} trial pixels.</>
                        )}
                        {/* Said only as far as the numbers show it, in the figure they were ranked on. */}
                        {/* Said only as far as the numbers show it: never worse by more than
                            the tie band is the claim the ranking supports, not "as pure", and
                            the sizes it was checked over are the ones measured whole. */}
                        {comparison.worse.length === 0
                          ? ` Along the rows is never more than ${TIE_POINTS} points behind, over the ${comparison.sizes} ${comparison.sizes === 1 ? 'size' : 'sizes'} measured whole.`
                          : ` Along the rows is less pure at ${comparison.worse.join(', ')} m.`}
                      </p>
                    ) : (
                      <p className="text-[11px] leading-snug text-neutral-500">Comparing the two ladders…</p>
                    )}
                  </div>
                ) : (
                  <PcaSweep steps={sweep} species={speciesD} colors={colors} magnitude={magnitude} threshold={threshold} colorBy={pcaColorBy}
                    activeRes={build?.res} activeSim={activeSim} onPick={pickRes} />
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
                      rotation={angle} setRotation={p.setAngleByHand} rotationLabel="Trial angle"
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
