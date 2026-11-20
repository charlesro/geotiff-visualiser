import { Suspense, lazy, useMemo } from 'react';
import { Boundary } from '../Boundary';
import { Disclosure, Explain, InfoDot, Step, Spinner } from '../ui';
import { LayoutFields, LayoutSelect, SpeciesList, SELECT } from './controls';
import { ImportPanel } from './ImportPanel';
import { ResTable } from '../ResTable';
import { fmt } from '../util';
import { FIXED, SOURCES, TASK } from '../sensors';
import PcaSweep from '../PcaSweep';
import type { StepProps } from './props';
import { alignedWithin } from '../imported-rotate';

/**
 * The big chart and its tabs, fetched when step 4 is first opened: its variance
 * and loadings tabs are drawn with the charting library, a quarter of the
 * page's script, which the first three steps never use.
 */
const PcaSimVisual = lazy(() => import('../PcaSimVisual'));

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

/** "every 2nd pixel", "every 3rd", "every 11th": the ordinal English wants. */
function sampleWord(stride: number): string {
  if (stride <= 1) return 'every pixel';
  const t = stride % 10, h = stride % 100;
  const suffix = t === 1 && h !== 11 ? 'st' : t === 2 && h !== 12 ? 'nd' : t === 3 && h !== 13 ? 'rd' : 'th';
  return `every ${stride}${suffix} pixel`;
}

/**
 * Step 4: the PCA over the field, and the same PCA across resolutions.
 *
 * Rendered as a child of `Step`, which unmounts collapsed children, so NOTHING
 * here may hold state. Everything it reads comes from hooks the page shell owns.
 */
function PcaStepBody(p: StepProps) {
  const { activeStep, toggleStep, } = p;
  const { aoi } = p.area;
  const { sourceId, setSourceId, build, geoErrM } = p.gridApi;
  const { pattern, setPattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation, magnitude, threshold, blockDesign, setBlockDesign, speciesD, presetsActive, colors, names, setSpeciesAt, setPresetAt, importedDesign, varieties, importedPlan, importedAngle, importedTurn, importedShift, importedFileAngle } = p.exp;
  const imported = pattern === 'imported';
  // The angle the ladder compares: the trial's own for an imported one, or the
  // one it was turned FROM when the aligned placement was adopted from the
  // ladder, which is the side of the comparison the design is no longer at.
  const own = imported ? importedAngle : rotation;
  const angle = p.compareFrom ?? own;
  const angleLabel = Math.round(angle * 10) / 10;
  // Strips and block trials are compared with themselves along the pixel
  // rows, which is pointless once they lie along them. An imported trial is
  // compared with its best placement, whatever angle that is at.
  const aligned = !imported && alignedWithin(angle, 0.05);
  const { pcaBusy, pcaView, pcaSubsampled, pcaGrid, setSelectedPixels, sweep, sweepBusy } = p.pca;
  const { pcaRetuneOpen, setPcaRetuneOpen, compareAligned, setCompareAligned, pcaColorBy, setPcaColorBy, pcaShapeBy, setPcaShapeBy, ladderView, setLadderView } = p;
  const { sweepAligned } = p.pca;
  /**
   * Which of the two placements is the one on the map, if either.
   *
   * The left one while the design sits at its own angle. Once it has been
   * turned away from that: the right one when the rung of the size shown puts
   * the trial exactly where it is now, and NEITHER otherwise. A best placement
   * is found per satellite, so a trial placed for Pléiades and then looked at
   * through PlanetScope is on neither ladder; so is a trial left along the pixel rows
   * by an earlier version of the page. The other layouts have one placement
   * on the right, the pixel rows, and are on it whenever they were turned.
   */
  const placed = (s: { placement?: { turn: number; shift: [number, number] } } | undefined) => !!s?.placement
    && Math.abs(s.placement.turn - importedTurn) < 1e-6
    && Math.abs(s.placement.shift[0] - importedShift[0]) < 1e-6 && Math.abs(s.placement.shift[1] - importedShift[1]) < 1e-6;
  const onMap: 0 | 1 | null = p.compareFrom === null ? 0
    : !imported ? 1
    : placed(sweepAligned?.find(s => s.id === sourceId)) ? 1 : null;
  // The big chart's simulation, for the thumbnail of the size it was computed at.
  // Right after a click the grid is already the new size while the chart still
  // shows the old one; until the new one lands that thumbnail draws its own rung.
  const activeSim = pcaView && build && Math.abs(pcaView.res - build.res) < 1e-9 ? pcaView.sim : null;
  /**
   * What the sample covers, said accurately. The grid is clipped to the trial
   * whenever the trial is not the whole field, and a field is mostly not the
   * trial: saying "across the whole field" there is both wrong and the opposite
   * of reassuring, since spending the sample on the field is exactly the bug
   * this clipping fixed.
   */
  const sampledArea = pcaGrid && build && pcaGrid.utmBounds.join() !== build.utmBounds.join()
    ? 'the trial' : 'the whole field';
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
  const worstCase = geoErrM > 0;
  /** The right-hand ladder, as the verdict's subject and verb. */
  const other = imported ? 'best placement gives' : 'pixel rows give';
  const comparison = (() => {
    if (!sweep || !sweepAligned) return null;
    const rows = sweepAligned.flatMap(al => {
      const own = sweep.find(s => s.id === al.id);
      // A pair is judged whenever it has a number on BOTH sides. The rung on
      // the map is a placeholder until the idle pass fills it, and has none
      // until then.
      //
      // Sampled rungs (the ◦ panels) ARE judged, on their shares. Two rules used
      // to exclude them and the rung on the map, and between them they hid
      // every informative size there was: on a large field every fine rung is
      // sampled, so a strip design left 3 m, a 0% against 0% pair, as the
      // whole verdict while the panels above it read 38% against 67% at 2 m.
      // The ranked quantity is the SHARE, normalised within each window, which
      // is what the panels print side by side and the reader compares anyway.
      if (!own) return [];
      if (own.resolvingPct == null || al.resolvingPct == null) return [];
      if (!Number.isFinite(own.resolvingPct) || !Number.isFinite(al.resolvingPct)) return [];
      /**
       * With a geolocation error set, the pair is judged on what SURVIVES it.
       *
       * The nominal share is one draw: where the imagery happens to land. For a
       * placement staked onto the grid it is the lucky draw by construction,
       * so comparing nominals credited staking with luck. The figure ranked is
       * the robust share: the pixels pure for the same plot wherever the image
       * lands within its CE90, which is what a pixel list chosen by coordinates
       * can rely on. `drawn` and `aligned` hold whichever figures are being
       * compared, so the ranking rule below and the sentence that prints them
       * can never disagree about what they compare. A rung whose robust share
       * is not in yet is left out rather than judged on its nominal beside
       * others' robust ones. The nominal rides along as the "at best".
       */
      if (worstCase) {
        if (own.geoRobust == null || al.geoRobust == null) return [];
        return [{ res: al.res, who: `${al.name} ${al.res} m`, ce90: own.ce90M, drawn: own.geoRobust, aligned: al.geoRobust,
                  drawnPure: own.geoRobustPure ?? NaN, alignedPure: al.geoRobustPure ?? NaN,
                  drawnBest: own.resolvingPct, alignedBest: al.resolvingPct,
                  sampled: !!(own.partial || al.partial) }];
      }
      return [{ res: al.res, who: `${al.name} ${al.res} m`, ce90: undefined as number | undefined, drawn: own.resolvingPct, aligned: al.resolvingPct,
                drawnPure: own.pureCount ?? NaN, alignedPure: al.pureCount ?? NaN,
                drawnBest: NaN, alignedBest: NaN,
                sampled: !!(own.partial || al.partial) }];
    });
    if (!rows.length) return null;
    /**
     * BOTH directions, ranked on the share the panels print. The verdict used
     * to compute only `worse`, so its vocabulary had no word for better: the
     * kindest thing it could say about turning the trial onto the pixel rows
     * was that it was "never more than 2 points behind", even where it won by
     * 29. A reader told only how far behind something is concludes it is
     * behind.
     */
    const better = rows.filter(x => x.aligned > x.drawn + TIE_POINTS).map(x => x.who);
    const worse = rows.filter(x => x.aligned < x.drawn - TIE_POINTS).map(x => x.who);
    // Lead with the size where the placements differ MOST. The first size
    // measured whole is often the least informative one there is.
    const lead = rows.reduce((a, b) => (Math.abs(b.aligned - b.drawn) > Math.abs(a.aligned - a.drawn) ? b : a));
    return { lead, sizes: rows.length, better, worse };
  })();
  /**
   * A click on a row selects its satellite, which brings its pixel size and
   * its blur: the row was computed with both, and the map has to show what
   * the row measured. The row of the satellite already selected is the one
   * on the map, and a click on it changes nothing.
   */
  const pickSat = (id: string) => { if (id !== sourceId) setSourceId(id); };
  /**
   * Picking a rung of the ALIGNED ladder. Those panels are the design turned
   * along the pixel rows, so the click has to turn it: picking one used to set
   * the pixel size and leave the map showing the design at its own angle, which
   * is neither of the two things being compared. It is the same turn the "vs
   * aligned" ladder simulated, so what lands on the map is the panel clicked.
   */
  const pickAligned = (id: string) => {
    if (imported) {
      // The rung's own placement, as it was measured: nothing is searched again.
      const place = sweepAligned?.find(s => s.id === id)?.placement;
      if (!place) return;
      pickSat(id);
      p.setCompareFrom(angle, place.angle);
      p.importApi.setPlacement(place.turn, place.shift);
      return;
    }
    pickSat(id);
    // Remembered BEFORE the turn, so the comparison keeps showing the placement
    // this one was chosen over, and clicking back is one click.
    p.setCompareFrom(angle);
    setRotation(0);
  };
  /**
   * Picking a rung of the left-hand ladder. It is the design at its own angle,
   * so this is also the way BACK from having adopted the aligned placement: the
   * panel is that placement, and clicking it puts it on the map again.
   */
  const pickOwn = (id: string) => {
    pickSat(id);
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
    `${imported ? 'best placement' : 'at 0° · on the pixel grid'}${onMap === 1 ? ' · shown' : ''}`,
  ], [angleLabel, onMap, imported]);

  // Back to the file's own angle, as step 3 offers it: this is the step where
  // the trial gets turned, by a click on the aligned ladder.
  const turned = imported && importedTurn !== 0;
  const compareBtn = (
    <>
      {turned && (
        <button type="button" onClick={() => p.setAngleByHand(importedFileAngle)}
          title={`Back to the file's angle, ${importedFileAngle.toFixed(1)}°`}
          className="ml-auto rounded px-1.5 py-0.5 text-[13px] font-normal normal-case tracking-normal text-neutral-500 transition-colors hover:text-neutral-300">
          as in file
        </button>
      )}
      <button type="button" onClick={() => setCompareAligned(v => !v)} disabled={aligned}
        title={aligned
          ? 'Already aligned with the pixels'
          : imported ? 'Compare with the angle and position that keep the most pure pixels at each pixel size' : 'Compare with rows aligned to the pixels'}
        className={`${turned ? '' : 'ml-auto'} rounded px-1.5 py-0.5 text-[13px] font-normal normal-case tracking-normal transition-colors disabled:opacity-30 ${compareAligned ? 'bg-sky-500/15 text-sky-300' : 'text-neutral-500 hover:text-neutral-300'}`}>
        {imported ? 'vs best' : 'vs aligned'}
      </button>
    </>
  );

  return (
        <Step n={4} title="PCA simulation" summary={`${pattern === 'imported' ? `${names.length} ${names.length === 1 ? 'variety' : 'varieties'}` : names.length > 4 ? `${names.length} species` : names.join(' × ')} → PCA`} open={activeStep === 'pca'} onClick={() => toggleStep('pca')} enabled={!!aoi}>
        {!aoi ? (
          <p className="text-[14px] text-neutral-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : pcaView ? (
          <div className="space-y-3">
            {/* The planted area this chart's own grid implies, so the purity
                tab reconciles with the headline instead of quoting a second,
                unexplained percentage of the same pure pixels. */}
            <Suspense fallback={<p className="flex items-center gap-2 text-[14px] text-neutral-500"><Spinner className="h-3 w-3" /> Loading the chart</p>}>
              <PcaSimVisual sim={pcaView.sim} species={speciesD} colors={colors} names={names} magnitude={magnitude} threshold={threshold}
                planted={p.pca.pcaPlanted}
                colorBy={pcaColorBy} setColorBy={setPcaColorBy} shapeBy={pcaShapeBy} setShapeBy={setPcaShapeBy}
                onSelect={setSelectedPixels} busy={pcaBusy} />
            </Suspense>
            {pcaSubsampled && (
              <p className="text-[14px] leading-snug text-neutral-500">
                Computed on {sampleWord(pcaGrid?.stride ?? 1)} across {sampledArea}, {fmt(pcaView.sim.total)} trial pixels in all, as it is too fine to draw every one.
              </p>
            )}

            <div className="rounded-lg border border-white/10 bg-black/20 p-2">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-[14px] text-neutral-400">
                  Across satellites
                  {/* While comparing, the panels are labelled with counts, and the legend has to say so. */}
                  <Explain text={sweepAligned
                    ? imported
                      ? <>One PCA per satellite, at its own pixel size and blur, twice: your trial, and the same trial at the angle and position that keep the most pure pixels for that satellite{worstCase ? ' wherever the image lands within the CE90' : ''} (px = pure pixels). The best placement is searched for each satellite, so its angle changes from one row to the next. Click a row to select that satellite and put the trial at that placement on the map.</>
                      : <>One PCA per satellite, at its own pixel size and blur, twice: your design and the same design along the pixel rows (px = pure pixels). The two placements catch different numbers of edge pixels, so their totals differ and only the counts compare. Click a row to select that satellite.</>
                    : <>One PCA per satellite, at its own pixel size and blur (% = pure pixels). The satellite selected is taken as it stands in step 2. Click a row to select that satellite.</>}><InfoDot /></Explain>
                </span>
                {sweepBusy && <Spinner className="h-3 w-3" />}
                {/* The same rungs, as a table of their figures or as the small
                    scatter plots: the table is what fits a narrow panel. */}
                <span className="ml-auto flex overflow-hidden rounded border border-white/10 text-[12px]">
                  {(['table', 'charts'] as const).map(v => (
                    <button key={v} type="button" onClick={() => setLadderView(v)}
                      title={v === 'table' ? 'The figures of every size, side by side' : 'One small PCA per size'}
                      className={`px-1.5 py-0.5 capitalize transition-colors ${ladderView === v ? 'bg-sky-500/15 text-sky-300' : 'text-neutral-500 hover:text-neutral-300'}`}>
                      {v}
                    </button>
                  ))}
                </span>
              </div>
              {sweep ? (
                <div className="space-y-2">
                  {ladderView === 'table' ? (
                    <ResTable steps={sweep} pairWith={sweepAligned}
                      pairLabels={[`${angleLabel}° as drawn`, imported ? 'best placement' : '0° on the grid']} shown={onMap}
                      activeId={sourceId} onPick={sweepAligned ? pickOwn : pickSat} onPickPair={pickAligned}
                      geoErrM={geoErrM} threshold={threshold} />
                  ) : sweepAligned ? (
                    // One row per resolution: your design on the left, the same design
                    // with the rows along the pixels on the right, so 0.5 m sits next
                    // to 0.5 m, 1 m next to 1 m, and only the angle differs in a pair.
                    <PcaSweep steps={sweep} pairWith={sweepAligned}
                      pairLabels={pairLabels}
                      species={speciesD} colors={colors} magnitude={magnitude} threshold={threshold} colorBy={pcaColorBy}
                      activeId={sourceId} activeSim={lendable}
                      onPick={pickOwn} onPickPair={pickAligned} geoErrM={geoErrM} />
                  ) : (
                  <PcaSweep steps={sweep} species={speciesD} colors={colors} magnitude={magnitude} threshold={threshold} colorBy={pcaColorBy}
                    activeId={sourceId} activeSim={activeSim} onPick={pickSat} geoErrM={geoErrM} />
                  )}
                  {/* The verdict of the comparison, in one sentence. The figures it
                      used to lead with are the table's own rows now; said again
                      under it they were a paragraph to read after the numbers. */}
                  {sweepAligned && (
                    <p className="text-[13px] leading-snug text-neutral-500">
                      {comparison ? (
                        <>
                          {worstCase ? 'On the pixels that hold within the CE90, ' : ''}
                          {comparison.better.length > 0 && comparison.worse.length === 0
                            ? `${worstCase ? 'the' : 'The'} ${other} more pure crop for ${comparison.better.join(', ')}, and ${imported ? 'is' : 'are'} never more than ${TIE_POINTS} points behind for any of the ${comparison.sizes} ${comparison.sizes === 1 ? 'satellite' : 'satellites'}.`
                            : comparison.better.length > 0
                              ? `${worstCase ? 'the' : 'The'} ${other} more for ${comparison.better.join(', ')} and less for ${comparison.worse.join(', ')}.`
                              : comparison.worse.length > 0
                                ? `${worstCase ? 'the' : 'The'} ${other} less for ${comparison.worse.join(', ')}.`
                                : `${worstCase ? 'the' : 'The'} two placements are within ${TIE_POINTS} points for every one of the ${comparison.sizes} ${comparison.sizes === 1 ? 'satellite' : 'satellites'}.`}
                        </>
                      ) : 'Comparing the two placements…'}
                    </p>
                  )}
                </div>
              ) : <p className="text-[14px] leading-snug text-neutral-500">Computing the PCA for each satellite…</p>}
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
                  <label className="mb-1 block text-[14px] text-neutral-500">Resolution · grid</label>
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
          <p className="flex items-center gap-1.5 text-[14px] text-neutral-400"><Spinner className="h-3 w-3" /> Running the PCA over the field…</p>
        ) : (
          <p className="text-[14px] text-neutral-400">Build the pixel grid in step&nbsp;2 first.</p>
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
