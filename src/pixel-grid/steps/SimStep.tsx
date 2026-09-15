import { Disclosure, Explain, InfoDot, Step } from '../ui';
import { CropPair, LayoutFields, LayoutSelect, SELECT } from './controls';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
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
  const { pattern, setPattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation, cropA, setCropA, cropB, setCropB, presetA, setPresetA, presetB, setPresetB, magnitude, setMagnitude, alpha, setAlpha, beta, setBeta, threshold, setThreshold, dupSpecies, colB, day, simView } = p.exp;
  const { ndviSeries } = p.sim;

  const NUM = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-sky-500 focus:outline-none';

  return (
        <Step n={3} title="Simulate experiment" summary={simSummary} open={activeStep === 'sim'} onClick={() => toggleStep('sim')} enabled={!!aoi}>
        {!aoi ? (
          <p className="text-xs text-neutral-400">Draw an experiment area in step&nbsp;1 first.</p>
        ) : (
          <div className="space-y-3">

            <LayoutSelect pattern={pattern} setPattern={setPattern} selectClass={SELECT} />
            <LayoutFields stripWidth={stripWidth} setStripWidth={setStripWidth}
              spacing={spacing} setSpacing={setSpacing}
              rotation={rotation} setRotation={setRotation} rotationLabel="Strip angle"
              rotationAction={
                <button type="button" disabled={rotation === 0}
                  onClick={() => { setCompareAligned(true); setActiveStep('pca'); }}
                  title={rotation === 0
                    ? 'Already aligned with the pixels'
                    : 'Compare with strips aligned to the pixels'}
                  className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal transition-colors disabled:opacity-30 ${compareAligned ? 'bg-sky-500/15 text-sky-300' : 'text-neutral-500 hover:text-neutral-300'}`}>
                  vs aligned
                </button>
              }
              spacingHint="Bare soil between strips, shown in brown."
              rotationHint="Angle from the pixel rows; 0° runs along them." />

            <CropPair wrapperClass="grid grid-cols-2 gap-2"
              cropA={cropA} setCropA={setCropA} presetA={presetA} setPresetA={setPresetA}
              cropB={cropB} setCropB={setCropB} presetB={presetB} setPresetB={setPresetB} colB={colB} />

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
                      <Line type="monotone" dataKey="A" stroke={cropA.color} dot={false} strokeWidth={1.5} name={cropA.name} />
                      <Line type="monotone" dataKey="B" stroke={colB} dot={false} strokeWidth={1.5} name={dupSpecies ? `${cropB.name} (B)` : cropB.name} />
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
