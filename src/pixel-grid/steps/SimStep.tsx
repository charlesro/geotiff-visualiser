import { Disclosure, Explain, InfoDot, Step } from '../ui';
import { Boundary } from '../Boundary';
import { BlockSummary, ImportedSummary, LayoutFields, LayoutSelect, SpeciesList, SELECT } from './controls';
import { ImportPanel } from './ImportPanel';
import { PlotSizeCard } from './PlotSize';
import { SuggestDesign } from './SuggestDesign';
import { BlurBudget, BlurGeo, SensorPick, fwhmText } from './GridStep';
import { Suspense, lazy } from 'react';
import { STEP_NO, type SimSection, type StepProps } from './props';
import { alignedWithin } from '../imported-rotate';
import { PATTERNS } from '../simulate';

/**
 * The season chart, fetched when the fold that holds it is first opened: it is
 * the only thing in this step drawn with the charting library, which is a
 * quarter of the page's script and has no business in its first download.
 */
const SeasonChart = lazy(() => import('./SeasonChart'));

/**
 * Step 3: lay out the planting pattern and see the season a mixed pixel records.
 *
 * Rendered as a child of `Step`, which unmounts collapsed children, so NOTHING
 * here may hold state. Everything it reads comes from hooks the page shell owns.
 */
function SimStepBody(p: StepProps) {
  const { activeStep, toggleStep, simSummary, simSection, setSimSection, blurOpen, setBlurOpen,
          compareAligned, setCompareAligned, setActiveStep } = p;
  const { aoi } = p.area;
  const { build, source, geoErrM, psfSigmaM, pxSize } = p.gridApi;
  const { pattern, setPattern, stripWidth, setStripWidth, spacing, setSpacing, rotation, setRotation, magnitude, setMagnitude, alpha, setAlpha, beta, setBeta, threshold, setThreshold, blockDesign, setBlockDesign, blockPlan, colors, names, speciesD, presetsActive, setSpeciesAt, setPresetAt, importedDesign, varieties, importedPlan, importedAngle, importedFileAngle, importedTurn } = p.exp;
  // The angle the controls show and edit: the trial's own for an imported one.
  const imported = pattern === 'imported';
  const angle = imported ? importedAngle : rotation;
  // An imported trial is compared with its best placement, at whatever angle
  // that is: there is no angle at which the comparison has nothing to say.
  const aligned = !imported && alignedWithin(angle, 0.05);
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

  const NUM = 'w-full rounded-md border border-white/10 bg-neutral-900 px-2 py-1.5 text-[15px] text-neutral-100 focus:border-sky-500 focus:outline-none';

  // The satellite everything below is counted for, by what sets its counts:
  // its pixel, how far an image may land from where it is meant to, its blur.
  // The pixel as it stands on the page: a tasked sensor's can be typed, and the label follows it.
  const satLabel = `Satellite · ${source.provider} ${source.kind === 'custom' ? `${build?.res ?? pxSize} m` : source.resLabel} · CE90 ${geoErrM} m · ${psfSigmaM > 0 ? `FWHM ${fwhmText(p.gridApi)} m` : 'no blur'}`;

  /**
   * The step is six folds, one open at a time and all shut to begin with,
   * each named by what it holds now: the design reads "4 species × 4 blocks ·
   * plots 10.5 × 10.5 m" when it is shut, so nothing has to be open to be
   * read. It was one column of everything, more than two screens of it.
   */
  const at = (id: SimSection) => simSection === id;
  const fold = (id: SimSection) => () => setSimSection(cur => (cur === id ? null : id));
  // The arrangement by its name without the ratio in brackets: "Alternating rows", "Randomised blocks".
  const layoutName = (PATTERNS.find(q => q.id === pattern)?.label ?? '').replace(/ \(.*\)$/, '');
  const designLabel = imported
    ? `Design · ${layoutName} · ${importedDesign ? importedDesign.fileName : 'no file yet'}`
    : pattern === 'block'
      ? `Design · ${layoutName} · ${blockDesign.nSpecies} species × ${blockDesign.nBlocks} · ${blockDesign.plotLength} × ${blockDesign.plotWidth} m`
      : `Design · ${layoutName} · ${stripWidth} m wide${spacing > 0 ? `, ${spacing} m alley` : ''} · ${rotation}°`;

  return (
        <Step n={STEP_NO.sim} title="Simulate experiment" summary={simSummary} open={activeStep === 'sim'} onClick={() => toggleStep('sim')} enabled>
          {/* The step is open to work in with no experiment area: a design can
              be typed, and a trial built, before any ground is drawn. Only what
              is simulated ON an area waits for one, and says so here. */}
          <div className="space-y-2">
            {!aoi && (
              <p className="text-[14px] leading-snug text-neutral-400">
                No experiment area yet. Draw one in step&nbsp;1, or build a trial under Suggest a design.
              </p>
            )}

            {/* The satellite, its blur and its geolocation error, with where each
                figure comes from. They were chosen in the pixel grid step, which
                is no longer shown: with it went the only place a CE90 could be
                typed and the only place that said what the counts assume. First
                here, since every count below is a count for this satellite. */}
            <Disclosure label={satLabel} open={at('sat')} onToggle={fold('sat')}>
              <SensorPick {...p} />
              <BlurGeo {...p} budget={false} />
              {psfSigmaM > 0 && (
                <Disclosure label="Every source of blur, and what is not simulated" open={blurOpen} onToggle={() => setBlurOpen(v => !v)}>
                  <BlurBudget {...p} />
                </Disclosure>
              )}
            </Disclosure>

            <Disclosure label={designLabel} open={at('design')} onToggle={fold('design')}>
            {/* The arrangement is part of the design and is chosen in its fold
                ("put the tab where we select the arrangement in the design
                subtab"); shut, the fold's title names it. */}
            <LayoutSelect pattern={pattern} setPattern={setPattern} selectClass={SELECT} />
            {/* An imported trial's geometry is the file's: what it has is the
                file, and the angle the whole trial is turned to. */}
            {imported && <ImportPanel design={importedDesign} varieties={varieties} {...p.importApi} />}
            {(!imported || importedPlan) && (
            <LayoutFields stripWidth={stripWidth} setStripWidth={setStripWidth}
              spacing={spacing} setSpacing={setSpacing}
              pattern={pattern} blockDesign={blockDesign} setBlockDesign={setBlockDesign}
              rotation={angle} setRotation={imported ? p.setAngleByHand : setRotation}
              // "Angle" alone: with "Trial" before it and the comparison button
              // after, the label broke onto two lines in a narrow panel.
              rotationLabel="Angle"
              rotationAction={<>
                {/* Back to the file's own angle, which is rarely a round number to retype. */}
                {imported && importedTurn !== 0 && (
                  <button type="button" onClick={() => p.setAngleByHand(importedFileAngle)}
                    title={`Back to the file's angle, ${importedFileAngle.toFixed(1)}°`}
                    className="ml-auto rounded px-1.5 py-0.5 text-[13px] font-normal normal-case tracking-normal text-neutral-500 transition-colors hover:text-neutral-300">
                    as in file
                  </button>
                )}
                <button type="button" disabled={aligned}
                  onClick={() => { setCompareAligned(true); setActiveStep('pca'); }}
                  title={aligned
                    ? 'Already aligned with the pixels'
                    : imported ? 'Compare with the angle and position that keep the most pure pixels at each pixel size' : 'Compare with strips aligned to the pixels'}
                  className={`${imported && importedTurn !== 0 ? '' : 'ml-auto'} rounded px-1.5 py-0.5 text-[13px] font-normal normal-case tracking-normal transition-colors disabled:opacity-30 ${compareAligned ? 'bg-sky-500/15 text-sky-300' : 'text-neutral-500 hover:text-neutral-300'}`}>
                  {imported ? 'vs best' : 'vs aligned'}
                </button>
              </>}
              spacingHint="Bare soil between strips, shown in brown."
              rotationHint={imported
                ? `The file draws the trial at ${importedFileAngle.toFixed(1)}°. Changing it turns the whole trial about its centre; 0° lines the plots up with the pixel rows.`
                : 'Angle from the pixel rows; 0° runs along them.'} />
            )}

            {pattern === 'block' && (
              <BlockSummary design={blockDesign} plan={blockPlan} res={build?.res} />
            )}

            {pattern === 'imported' && importedPlan && (
              <ImportedSummary plan={importedPlan} angle={importedAngle} res={build?.res} />
            )}
            </Disclosure>

            {/* The other way in: say what the trial has to hold, and have it built.
                For every layout the page lays out itself ("the suggest design
                should be available for every configuration"); a trial read
                from a file is the file's, and has nothing to suggest. */}
            {pattern !== 'imported' && (
              <Disclosure label="Suggest a design" open={at('suggest')} onToggle={fold('suggest')}>
                <SuggestDesign {...p} />
              </Disclosure>
            )}

            {/* What the sensor asks of these plots: the size that keeps pure pixels in them. */}
            <Disclosure label="Plot size required" open={at('size')} onToggle={fold('size')}>
              <PlotSizeCard {...p} />
            </Disclosure>

            {/* The crops and their season, folded for every layout. They are set
                once, by picking a crop, and then stood between the design and
                everything below it: two rows of editors and a chart on a panel
                whose subject is the plots. An imported trial had its own fold
                for the same reason, and the fold is the same one. */}
            {(pattern !== 'imported' || varieties.length > 0) && (
              <Disclosure
                label={pattern === 'imported'
                  ? `Growth curves · ${names.length} ${names.length === 1 ? 'variety' : 'varieties'}`
                  : `Growth curves · ${names.length > 3 ? `${names.length} species` : names.join(', ')}`}
                open={at('curves')} onToggle={fold('curves')}>
                <SpeciesList wrapperClass="grid grid-cols-2 gap-2"
                  species={speciesD} presets={presetsActive} colors={colors} names={names}
                  setSpeciesAt={setSpeciesAt} setPresetAt={setPresetAt} />
                {ndviSeries && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 text-[14px] text-neutral-400">NDVI season</span>
                      <Explain align="right" text={<>Dashed: what a mixed pixel records{magnitude > 0 ? '; grey band: noise (±σ)' : ''}.</>}><InfoDot /></Explain>
                    </div>
                    <div style={{ height: 150 }}>
                      <Suspense fallback={null}>
                        <SeasonChart series={ndviSeries} lines={curveLines} colors={colors} names={names} noise={magnitude > 0} />
                      </Suspense>
                    </div>
                  </div>
                )}
              </Disclosure>
            )}

            <Disclosure label={`Noise & purity threshold · ε = ${100 - threshold} %`} open={at('noise')} onToggle={fold('noise')}>
              <div className="grid grid-cols-3 gap-2">
                {([['mag', magnitude, setMagnitude, 0, 0.15, 0.005], ['α', alpha, setAlpha, 0.1, 10, 0.1], ['β', beta, setBeta, 0.1, 10, 0.1]] as const).map(([lbl, val, set, mn, mx, st]) => (
                  <div key={lbl}>
                    <span className="mb-0.5 block text-[14px] text-neutral-500">{lbl}</span>
                    <input type="number" min={mn} max={mx} step={st} value={val}
                      onChange={e => set(Math.max(mn, Math.min(mx, parseFloat(e.target.value) || 0)))} className={NUM} />
                  </div>
                ))}
              </div>
              <div>
                {/* 90 % is the PHENET note's pure pixel. 100 is not offered: a
                    Gaussian never reaches zero, so at 100 % the answer was set by
                    where the kernel is cut off, not by the trial. */}
                <span className="mb-1 block text-[14px] text-neutral-500">
                  <Explain text="A pixel is pure when its contamination, the share of its signal that comes from other plots, is at most ε. The note uses 10 %, and 5 % as a stricter case.">
                    <span className="underline decoration-neutral-700 decoration-dotted underline-offset-2">Threshold ε = {100 - threshold} %</span>
                  </Explain>{' '}(pure ≥ {threshold} %)
                </span>
                <input type="range" min="50" max="99" step="1" value={threshold}
                  onChange={e => setThreshold(parseInt(e.target.value))} className="w-full accent-sky-500" />
              </div>
            </Disclosure>
          </div>
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
export function SimStep(p: StepProps) {
  return <Boundary name="Simulate experiment"><SimStepBody {...p} /></Boundary>;
}
