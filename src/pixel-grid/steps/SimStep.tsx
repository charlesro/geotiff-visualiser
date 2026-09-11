import { Disclosure, Explain, Hero, InfoDot, Step, Tabs } from '../ui';
import { CropPair, LayoutFields, LayoutSelect, SELECT } from './controls';
import { fmt } from '../util';
import SimVisual from '../SimVisual';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import type { StepProps } from './props';

/**
 * Step 3 — lay out the planting pattern and see what each sensor resolves.
 *
 * Rendered as a child of `Step`, which unmounts collapsed children — so NOTHING
 * here may hold state. Everything it reads comes from hooks the page shell owns.
 */
export function SimStep(p: StepProps) {
  const { activeStep, toggleStep, simSummary, simTab, setSimTab, simAdvOpen, setSimAdvOpen,
          compareAligned, setCompareAligned, setActiveStep } = p;
  const { aoi } = p.area;
  const { build, renderGrid, clippedView, convergence } = p.gridApi;
  const { pattern, setPattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation, optimizePlacement, setOptimizePlacement, cropA, setCropA, cropB, setCropB, presetA, setPresetA, presetB, setPresetB, magnitude, setMagnitude, alpha, setAlpha, beta, setBeta, threshold, setThreshold, layout, sensor, dupSpecies, colB, day, simView } = p.exp;
  const { patternOrigin, placementShift, sim, ndviSeries } = p.sim;

  const NUM = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none';
  const heroTone = !sim ? 'text-neutral-50'
    : sim.purePct >= 70 ? 'text-emerald-400' : sim.purePct >= 40 ? 'text-amber-400' : 'text-rose-400';

  return (
        <Step n={3} title="Simulate experiment" summary={simSummary} open={activeStep === 'sim'} onClick={() => toggleStep('sim')} enabled={!!aoi}>
        {!aoi ? (
          <p className="text-xs text-neutral-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : (
          <div className="space-y-3">

            {/* The number the step exists to produce, first. */}
            {sim && renderGrid && (
              <div>
                <Hero value={`${sim.purePct.toFixed(0)}%`} tone={heroTone}
                  right={`@ ${renderGrid.res} m${clippedView ? ' (in view)' : ''}`} />
                <p className="mt-1 font-mono text-[11px] text-neutral-500">
                  {fmt(sim.pureA + sim.pureB)} / {fmt(sim.total)} px ≥{threshold}% one crop · A {fmt(sim.pureA)} · B {fmt(sim.pureB)}{spacing > 0 ? ` · bare ${fmt(sim.pureBare)}` : ''}
                </p>
              </div>
            )}

            <LayoutSelect pattern={pattern} setPattern={setPattern} selectClass={SELECT} />
            <LayoutFields stripWidth={stripWidth} setStripWidth={setStripWidth}
              spacing={spacing} setSpacing={setSpacing}
              rotation={rotation} setRotation={setRotation} rotationLabel="Strip angle"
              rotationAction={
                <button type="button" disabled={rotation === 0}
                  onClick={() => { setCompareAligned(true); setActiveStep('pca'); }}
                  title={rotation === 0
                    ? 'Strips already run along the pixels — there is nothing to compare'
                    : 'Compare this angle against strips laid along the pixels, across every resolution'}
                  className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal transition-colors disabled:opacity-30 ${compareAligned ? 'bg-sky-500/15 text-sky-300' : 'text-neutral-500 hover:text-neutral-300'}`}>
                  vs aligned
                </button>
              }
              spacingHint="Row spacing inserts a bare-soil alley between strips (shown in brown)."
              rotationHint={`0° = strips run along the pixel rows. This angle is relative to the pixel grid — the grid itself sits ${convergence !== null ? Math.abs(convergence).toFixed(2) : '~1'}° off true north (grid convergence), visible on the map.`} />

            {/* One line, no box: the checkbox, the resulting offset, the why. */}
            <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-200">
              <input type="checkbox" checked={optimizePlacement} onChange={e => setOptimizePlacement(e.target.checked)} className="accent-sky-500" />
              Align plants to pixels
              <span className="ml-auto font-mono text-[11px] text-neutral-400">{placementShift ?? '0 cm'}</span>
              <Explain align="right" text={optimizePlacement
                ? <>Offsets the planting from the field&rsquo;s SW corner so strip edges land on pixel edges — maximises pure pixels. Round it to the nearest 10 cm in the field; the centimetres are far finer than the grid&rsquo;s own positional uncertainty.</>
                : <>Plants start exactly at the field edge, so strips may straddle pixel boundaries.</>}><InfoDot /></Explain>
            </label>

            <CropPair wrapperClass="grid grid-cols-2 gap-2"
              cropA={cropA} setCropA={setCropA} presetA={presetA} setPresetA={setPresetA}
              cropB={cropB} setCropB={setCropB} presetB={presetB} setPresetB={setPresetB} colB={colB} />

            {/* Two figures, one at a time. */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Tabs value={simTab} onChange={setSimTab}
                    tabs={[{ id: 'ladder' as const, label: 'Resolution ladder' }, { id: 'ndvi' as const, label: 'NDVI season' }]} />
                </div>
                <Explain align="right" text={simTab === 'ladder'
                  ? <>Your planting pattern as each sensor would record it. Vivid = a pure pixel (one crop), washed = mixed. Pick the coarsest sensor that stays mostly vivid.</>
                  : <>Dashed = the mixed pixel a sensor actually measures — it tracks neither crop{magnitude > 0 ? '; the grey band is the Beta-scheduled noise (±σ)' : ''}.</>}><InfoDot /></Explain>
              </div>

              {simTab === 'ladder' && build?.epsg && (
                <SimVisual aoi={aoi} epsg={build.epsg} origin={patternOrigin?.origin ?? null} layout={layout} sensor={sensor} colorA={cropA.color} colorB={colB} />
              )}

              {simTab === 'ndvi' && ndviSeries && (
                <div style={{ height: 150 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={ndviSeries} margin={{ top: 5, right: 6, bottom: 0, left: -24 }}>
                      <XAxis dataKey="day" tick={{ fontSize: 9, fill: '#888' }} ticks={[0, 90, 180, 270, 365]} />
                      <YAxis domain={[0, 1]} tick={{ fontSize: 9, fill: '#888' }} />
                      <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 11 }} labelFormatter={d => `day ${d}`} />
                      {simView === 'ndvi' && <ReferenceLine x={day} stroke="#666" strokeDasharray="3 3" />}
                      {magnitude > 0 && <Line type="monotone" dataKey="hi" stroke="#64748b" dot={false} strokeWidth={0.75} name="noise +σ" />}
                      {magnitude > 0 && <Line type="monotone" dataKey="lo" stroke="#64748b" dot={false} strokeWidth={0.75} name="noise −σ" />}
                      <Line type="monotone" dataKey="A" stroke={cropA.color} dot={false} strokeWidth={1.5} name={cropA.name} />
                      <Line type="monotone" dataKey="B" stroke={colB} dot={false} strokeWidth={1.5} name={dupSpecies ? `${cropB.name} (B)` : cropB.name} />
                      <Line type="monotone" dataKey="mix" stroke="#e5e7eb" strokeDasharray="4 3" dot={false} strokeWidth={1.5} name="Mixed pixel" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

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
