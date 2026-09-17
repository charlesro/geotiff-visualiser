import { Disclosure, Explain, InfoDot, Step } from '../ui';
import { BlockSummary, ImportedSummary, LayoutFields, LayoutSelect, SpeciesList, SELECT } from './controls';
import { ImportPanel } from './ImportPanel';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import { BARE } from '../simulate';
import type { StepProps } from './props';

/**
 * Step 3: lay out the planting pattern and see the season a mixed pixel records.
 *
 * Rendered as a child of `Step`, which unmounts collapsed children, so NOTHING
 * here may hold state. Everything it reads comes from hooks the page shell owns.
 */
export function SimStep(p: StepProps) {
  const { activeStep, toggleStep, simSummary, simAdvOpen, setSimAdvOpen,
          compareAligned, setCompareAligned, setActiveStep } = p;
  const { aoi } = p.area;
  const { build } = p.gridApi;
  /**
   * The purity the engine MEASURED, never an estimate.
   *
   * Prefer the map's own simulation. When the grid is too fine to render (a
   * 0.3 m sensor over a hectare is past the cell cap) that one is null, but the
   * PCA runs on the FIELD rather than the viewport and has measured the same
   * design already, so fall back to it. Both are real measurements; if neither
   * exists the card shows geometry and states no percentage at all.
   */
  const fieldSim = p.sim.sim ?? p.pca.pcaView?.sim ?? null;
  const { pattern, setPattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation, cropA, setCropA, cropB, setCropB, presetA, setPresetA, presetB, setPresetB, magnitude, setMagnitude, alpha, setAlpha, beta, setBeta, threshold, setThreshold, dupSpecies, colB, day, simView, blockDesign, setBlockDesign, blockPlan, colors, names, speciesD, presetsActive, setSpeciesAt, setPresetAt, importedDesign, varieties, importedPlan, importedAngle, importedFileAngle, importedTurn } = p.exp;
  // The angle the controls show and edit: the trial's own for an imported one.
  const imported = pattern === 'imported';
  const angle = imported ? importedAngle : rotation;
  const aligned = Math.min(angle, 90 - angle) < 0.05;
  const { ndviSeries } = p.sim;
  /**
   * One line per distinct growth CURVE, not per species. An imported trial can
   * carry dozens of varieties on one crop's curve, and forty identical wheat
   * lines drew as one line under a legend of forty. Each line is named by its
   * first species, with how many more share it.
   */
  const curveLines = (() => {
    const groups = new Map<string, { i: number; n: number }>();
    speciesD.forEach((s, i) => {
      const k = `${s.truth}_${s.L1}_${s.k1}_${s.x01}_${s.k2}_${s.x02}_${s.tc}`;
      const g = groups.get(k);
      if (g) g.n++; else groups.set(k, { i, n: 1 });
    });
    return [...groups.values()];
  })();

  const NUM = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none';

  return (
        <Step n={3} title="Simulate experiment" summary={simSummary} open={activeStep === 'sim'} onClick={() => toggleStep('sim')} enabled={!!aoi}>
        {!aoi ? (
          <p className="text-xs text-neutral-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : (
          <div className="space-y-3">

            <LayoutSelect pattern={pattern} setPattern={setPattern} selectClass={SELECT} />
            {/* An imported trial's geometry is the file's: what it has is the
                file, and the angle the whole trial is turned to. */}
            {imported && <ImportPanel design={importedDesign} varieties={varieties} {...p.importApi} />}
            {(!imported || importedPlan) && (
            <LayoutFields stripWidth={stripWidth} setStripWidth={setStripWidth}
              spacing={spacing} setSpacing={setSpacing}
              pattern={pattern} blockDesign={blockDesign} setBlockDesign={setBlockDesign}
              rotation={angle} setRotation={imported ? p.importApi.setAngle : setRotation}
              rotationLabel={pattern === 'block' || imported ? 'Trial angle' : 'Strip angle'}
              rotationAction={<>
                {/* Back to the file's own angle, which is rarely a round number to retype. */}
                {imported && importedTurn !== 0 && (
                  <button type="button" onClick={() => p.importApi.setAngle(importedFileAngle)}
                    title={`Back to the file's angle, ${importedFileAngle.toFixed(1)}°`}
                    className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-neutral-500 transition-colors hover:text-neutral-300">
                    as in file
                  </button>
                )}
                <button type="button" disabled={aligned}
                  onClick={() => { setCompareAligned(true); setActiveStep('pca'); }}
                  title={aligned
                    ? 'Already aligned with the pixels'
                    : imported ? 'Compare with the trial turned to the pixel rows' : 'Compare with strips aligned to the pixels'}
                  className={`${imported && importedTurn !== 0 ? '' : 'ml-auto'} rounded px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal transition-colors disabled:opacity-30 ${compareAligned ? 'bg-sky-500/15 text-sky-300' : 'text-neutral-500 hover:text-neutral-300'}`}>
                  vs aligned
                </button>
              </>}
              spacingHint="Bare soil between strips, shown in brown."
              rotationHint={imported
                ? `The file draws the trial at ${importedFileAngle.toFixed(1)}°. Changing it turns the whole trial about its centre; 0° lines the plots up with the pixel rows.`
                : 'Angle from the pixel rows; 0° runs along them.'} />
            )}

            {pattern === 'block' && (
              <BlockSummary design={blockDesign} plan={blockPlan} res={build?.res}
                threshold={threshold} purePct={fieldSim?.purePct} />
            )}

            {pattern === 'imported' && importedPlan && (
              <ImportedSummary plan={importedPlan} res={build?.res} threshold={threshold} purePct={fieldSim?.purePct} />
            )}

            {/* Dozens of varieties would bury the rest of the step, so an imported
                trial folds its curve editors away; they open on demand. */}
            {pattern === 'imported' ? (
              varieties.length > 0 && (
                <Disclosure label={`Growth curves · ${names.length} ${names.length === 1 ? 'variety' : 'varieties'}`}
                  open={p.curvesOpen} onToggle={() => p.setCurvesOpen(v => !v)}>
                  <SpeciesList wrapperClass="grid grid-cols-2 gap-2"
                    species={speciesD} presets={presetsActive} colors={colors} names={names}
                    setSpeciesAt={setSpeciesAt} setPresetAt={setPresetAt} />
                </Disclosure>
              )
            ) : (
              <SpeciesList wrapperClass="grid grid-cols-2 gap-2"
                species={speciesD} presets={presetsActive} colors={colors} names={names}
                setSpeciesAt={setSpeciesAt} setPresetAt={setPresetAt} />
            )}

            {ndviSeries && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[11px] text-neutral-400">NDVI season</span>
                  <Explain align="right" text={<>Dashed: what a mixed pixel records{magnitude > 0 ? '; grey band: noise (±σ)' : ''}.</>}><InfoDot /></Explain>
                </div>
                <div style={{ height: 150 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={ndviSeries} margin={{ top: 5, right: 6, bottom: 0, left: -24 }}>
                      <XAxis dataKey="day" tick={{ fontSize: 9, fill: '#888' }} ticks={[0, 90, 180, 270, 365]} />
                      <YAxis domain={[0, 1]} tick={{ fontSize: 9, fill: '#888' }} />
                      <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 11 }} labelFormatter={d => `day ${d}`} />
                      {simView === 'ndvi' && <ReferenceLine x={day} stroke="#666" strokeDasharray="3 3" />}
                      {magnitude > 0 && <Line type="monotone" dataKey="hi" stroke="#64748b" dot={false} strokeWidth={0.75} name="noise +σ" />}
                      {magnitude > 0 && <Line type="monotone" dataKey="lo" stroke="#64748b" dot={false} strokeWidth={0.75} name="noise −σ" />}
                      {/* One line per species. Two hardcoded series plotted
                          maize and wheat for a four-species trial and simply
                          omitted the rest, with nothing to show it had. */}
                      {curveLines.map(({ i, n }) => (
                        <Line key={i} type="monotone" dataKey={`s${i}`} stroke={colors[i]}
                          dot={false} strokeWidth={1.5} name={n > 1 ? `${names[i]} and ${n - 1} more` : names[i]} />
                      ))}
                      {/* Bare soil drawn like a crop: its own season, flat because
                          soil has no phenology. It is a real part of every pixel
                          that touches an alley, and the mixed curve weights it in. */}
                      <Line type="monotone" dataKey="soil" stroke={BARE.color} dot={false} strokeWidth={1.5} name="Bare soil" />
                      <Line type="monotone" dataKey="mix" stroke="#e5e7eb" strokeDasharray="4 3" dot={false} strokeWidth={1.5} name="Mixed pixel" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <Disclosure label="Noise & purity threshold" open={simAdvOpen} onToggle={() => setSimAdvOpen(v => !v)}>
              <div className="grid grid-cols-3 gap-2">
                {([['mag', magnitude, setMagnitude, 0, 0.15, 0.005], ['α', alpha, setAlpha, 0.1, 10, 0.1], ['β', beta, setBeta, 0.1, 10, 0.1]] as const).map(([lbl, val, set, mn, mx, st]) => (
                  <div key={lbl}>
                    <span className="mb-0.5 block text-[11px] text-neutral-500">{lbl}</span>
                    <input type="number" min={mn} max={mx} step={st} value={val}
                      onChange={e => set(Math.max(mn, Math.min(mx, parseFloat(e.target.value) || 0)))} className={NUM} />
                  </div>
                ))}
              </div>
              <div>
                <span className="mb-1 block text-[11px] text-neutral-500">Pure ≥ {threshold}% one crop</span>
                <input type="range" min="50" max="100" step="5" value={threshold}
                  onChange={e => setThreshold(parseInt(e.target.value))} className="w-full accent-sky-500" />
              </div>
            </Disclosure>
          </div>
        )}
        </Step>
  );
}
