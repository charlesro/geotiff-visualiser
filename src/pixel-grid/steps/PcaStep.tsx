import { useMemo } from 'react';
import { Disclosure, Explain, InfoDot, Step, Spinner } from '../ui';
import { CropPair, LayoutFields, LayoutSelect, SELECT } from './controls';
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
  const { pattern, setPattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation, cropA, setCropA, cropB, setCropB, presetA, setPresetA, presetB, setPresetB, magnitude, colB, cropAd, cropBd } = p.exp;
  const { pcaBusy, pcaView, pcaSubsampled, setSelectedPixels, sweep, sweepBusy } = p.pca;
  const { pcaRetuneOpen, setPcaRetuneOpen, compareAligned, setCompareAligned } = p;
  const { sweepAligned } = p.pca;
  // A fresh array every render would defeat PcaSweep's memo; keyed on the angle only.
  const pairLabels = useMemo<[string, string]>(() => [`at ${rotation}° · your design`, 'at 0° · rows along the pixels'], [rotation]);

  const compareBtn = (
    <button type="button" onClick={() => setCompareAligned(v => !v)} disabled={rotation === 0}
      title={rotation === 0
        ? 'Already aligned with the pixels'
        : 'Compare with rows aligned to the pixels'}
      className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal transition-colors disabled:opacity-30 ${compareAligned ? 'bg-sky-500/15 text-sky-300' : 'text-neutral-500 hover:text-neutral-300'}`}>
      vs aligned
    </button>
  );

  return (
        <Step n={4} title="PCA simulation" summary={`${cropA.name} × ${cropB.name} → PCA`} open={activeStep === 'pca'} onClick={() => toggleStep('pca')} enabled={!!aoi}>
        {!aoi ? (
          <p className="text-xs text-neutral-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : pcaView ? (
          <div className="space-y-3">
            <PcaSimVisual sim={pcaView.sim} cropA={cropAd} cropB={cropBd} magnitude={magnitude}
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
                      cropA={cropAd} cropB={cropBd} magnitude={magnitude} activeRes={build?.res} onPick={pickRes} />
                    <p className="text-[11px] leading-snug text-neutral-500">
                      Pure pixels at {RES_LADDER[0]} m: <span className="font-mono text-sky-300">{sweep[0].purePct.toFixed(0)}%</span> rotated
                      vs <span className="font-mono text-neutral-300">{sweepAligned[0].purePct.toFixed(0)}%</span> aligned.
                      Rotating away from the pixel rows costs purity at every size. This is how much.
                    </p>
                  </div>
                ) : (
                  <PcaSweep steps={sweep} cropA={cropAd} cropB={cropBd} magnitude={magnitude} activeRes={build?.res} onPick={pickRes} />
                )
              ) : <p className="text-[11px] leading-snug text-neutral-500">Computing the PCA at {RES_LADDER[0]}–{RES_LADDER[RES_LADDER.length - 1]} m…</p>}
            </div>

            <Disclosure
              label={`Retune design: ${cropA.name} × ${cropB.name} · ${stripWidth} m strips · ${rotation}°`}
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
              <LayoutFields stripWidth={stripWidth} setStripWidth={setStripWidth}
                spacing={spacing} setSpacing={setSpacing}
                rotation={rotation} setRotation={setRotation} rotationLabel="Field rotation"
                rotationAction={compareBtn} />
              <CropPair wrapperClass="grid grid-cols-2 gap-2"
                cropA={cropA} setCropA={setCropA} presetA={presetA} setPresetA={setPresetA}
                cropB={cropB} setCropB={setCropB} presetB={presetB} setPresetB={setPresetB} colB={colB} />
            </Disclosure>
          </div>
        ) : (
          <p className="text-xs text-neutral-400">Build the pixel grid in step&nbsp;2 first.</p>
        )}
        </Step>
  );
}
