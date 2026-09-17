import { useMemo } from 'react';
import { Disclosure, Explain, InfoDot, Step, Spinner } from '../ui';
import { LayoutFields, LayoutSelect, SpeciesList, SELECT } from './controls';
import { ImportPanel } from './ImportPanel';
import { fmt } from '../util';
import { FIXED, RES_LADDER, SOURCES, TASK } from '../sensors';
import PcaSimVisual from '../PcaSimVisual';
import PcaSweep from '../PcaSweep';
import type { StepProps } from './props';

/**
 * Step 4 — the PCA over the field, and the same PCA across resolutions.
 *
 * Rendered as a child of `Step`, which unmounts collapsed children — so NOTHING
 * here may hold state. Everything it reads comes from hooks the page shell owns.
 */
export function PcaStep(p: StepProps) {
  const { activeStep, toggleStep, } = p;
  const { aoi } = p.area;
  const { sourceId, setSourceId, build, pickRes } = p.gridApi;
  const { pattern, setPattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation, cropA, setCropA, cropB, setCropB, presetA, setPresetA, presetB, setPresetB, magnitude, threshold, colB, cropAd, cropBd, blockDesign, setBlockDesign, speciesD, presetsActive, colors, names, setSpeciesAt, setPresetAt, importedDesign, varieties, importedPlan, importedAngle } = p.exp;
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
   * The two ladders compared size by size, as the percentage of each trial's
   * own pixels that are pure (both counted over the pixels overlapping their
   * own outline), only where both rungs are complete: a placeholder or a central
   * window is not the trial. Within one point is called a tie, about what
   * nudging the threshold by a tenth moves.
   */
  const comparison = (() => {
    if (!sweep || !sweepAligned) return null;
    const rows = sweepAligned.flatMap(al => {
      const own = sweep.find(s => Math.abs(s.res - al.res) < 1e-9);
      if (!own || own.current || own.partial || al.partial) return [];
      if (!Number.isFinite(own.purePct) || !Number.isFinite(al.purePct) || (own.purePct === 0 && al.purePct === 0)) return [];
      return [{ res: al.res, drawn: own.purePct, aligned: al.purePct }];
    });
    if (!rows.length) return null;
    return { first: rows[0], worse: rows.filter(x => x.aligned < x.drawn - 1).map(x => x.res) };
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
                  <Explain text={<>One PCA per pixel size (% = pure pixels); click a panel to show that size on the map.</>}><InfoDot /></Explain>
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                  {sweepBusy && <><Spinner className="h-3 w-3" /> <span className="text-sky-300">Updating…</span></>}
                </span>
              </div>
              {sweep ? (
                sweepAligned ? (
                  // One row per resolution: your design on the left, the same design
                  // with the rows along the pixels on the right — so 0.5 m sits next
                  // to 0.5 m, 1 m next to 1 m, and only the angle differs in a pair.
                  <div className="space-y-2">
                    <PcaSweep steps={sweep} pairWith={sweepAligned}
                      pairLabels={pairLabels}
                      species={speciesD} colors={colors} magnitude={magnitude} colorBy={pcaColorBy}
                      activeRes={build?.res} activeSim={activeSim} activePartial={pcaView?.subsampled} onPick={pickRes} />
                    {comparison ? (
                      <p className="text-[11px] leading-snug text-neutral-500">
                        Pure pixels at {comparison.first.res} m: <span className="font-mono text-sky-300">{comparison.first.drawn.toFixed(0)}%</span> at {angleLabel}°
                        vs <span className="font-mono text-neutral-300">{comparison.first.aligned.toFixed(0)}%</span> along the pixel rows.
                        {/* Said only as far as the numbers show it. */}
                        {comparison.worse.length === 0
                          ? ' Along the rows is at least as pure at every size compared.'
                          : ` Along the rows is less pure at ${comparison.worse.join(', ')} m.`}
                      </p>
                    ) : (
                      <p className="text-[11px] leading-snug text-neutral-500">Comparing the two ladders…</p>
                    )}
                  </div>
                ) : (
                  <PcaSweep steps={sweep} species={speciesD} colors={colors} magnitude={magnitude} colorBy={pcaColorBy}
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
        ) : (
          <p className="text-xs text-neutral-400">Build the pixel grid in step&nbsp;2 first.</p>
        )}
        </Step>
  );
}
