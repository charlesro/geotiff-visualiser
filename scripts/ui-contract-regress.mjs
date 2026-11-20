/**
 * The UI layer's contracts: what node cannot execute, but can read or fake.
 *
 * The other three suites drive the engine, which is plain TypeScript and runs
 * under node as it ships. The rules here live inside React components and a
 * timer, so there is nothing to call: the ORDER three setters are applied in,
 * the fact that one expression's fallback is unreachable, whether the number a
 * sentence prints is the number it ranked on. Each of them was a real defect
 * that typechecked, passed every other suite, and shipped.
 *
 * So two kinds of check live here. Source assertions, in the spirit of the house
 * style check in design-import-regress: read the file and assert the shape the
 * reasoning depends on. And behaviour against fakes, for persist.ts, which does
 * have callable functions but only against a localStorage.
 *
 * A source assertion is a blunt instrument and will false-alarm on an innocent
 * refactor. That is the trade: it points at the file and says what the rule was,
 * which is better than the silence these three defects shipped under.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.resolve(ROOT, f), 'utf8');
const BUILD = path.join(ROOT, 'node_modules/.persist-regress');

let bad = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const check = ok;

// persist.ts imports react for usePersistentState, so it is transpiled under
// node_modules for that bare specifier to resolve, exactly as the other suites do.
fs.rmSync(BUILD, { recursive: true, force: true });
{
  const rel = 'src/pixel-grid/persist.ts';
  const js = transformSync(read(rel), { loader: 'ts', format: 'esm' }).code;
  const dest = path.join(BUILD, rel.replace(/\.ts$/, '.mjs'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, js);
}
const { writeSaved, readSaved, saveRefusal } = await import(path.join(BUILD, 'src/pixel-grid/persist.mjs'));

console.log('\nU1. persist.ts tells a full store from a store that keeps nothing');
/** A localStorage that refuses any value longer than `limit` characters. */
const store = (limit = Infinity) => {
  const m = new Map();
  return {
    m,
    get length() { return m.size; },
    key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null),
    removeItem: k => { m.delete(k); },
    setItem: (k, v) => {
      if (String(v).length > limit) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      m.set(k, String(v));
    },
  };
};
const use = value => Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });

{
  /**
   * The bug: writeSaved returns false for every rejection, and the import panel
   * turned that one false into "this trial is too large". In a private window
   * that sentence is wrong and unactionable: a three-plot file is refused just
   * as a 5,000-plot one is, and every other setting is equally unsaved.
   */
  const big = { plots: Array.from({ length: 40 }, (_, i) => ({ id: i })) };

  // A store with a real quota: the big value is refused, a small one is not.
  use(store(120));
  ok('a value over the quota is refused', writeSaved('importedDesign', big) === false);
  ok('... and the refusal is about THIS value', saveRefusal() === 'value-too-big');
  ok('... while a small companion key still saves', writeSaved('threshold', 85) === true);
  ok('... and the refused key is forgotten, not left stale', readSaved('importedDesign', () => true) === undefined);
  ok('... and the probe leaves nothing behind', ![...localStorage.m.keys()].some(k => k.includes('probe')),
    [...localStorage.m.keys()].join(' '));

  // A store that refuses everything (a private window, storage off by policy).
  use(store(0));
  ok('a one-element design is refused too', writeSaved('importedDesign', { plots: [1] }) === false);
  ok('... but the refusal is about the BROWSER, not the file', saveRefusal() === 'no-storage');
  ok('... which is also true of a two-character setting', writeSaved('threshold', 85) === false && saveRefusal() === 'no-storage');

  // A store that throws on plain access (some SecurityError policies).
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { const e = new Error('blocked'); e.name = 'SecurityError'; throw e; },
  });
  ok('storage that throws on access is refused, and softly', writeSaved('threshold', 85) === false);
  ok('... and reads the same way', saveRefusal() === 'no-storage');
  ok('... and readSaved still returns undefined rather than throwing', readSaved('threshold', () => true) === undefined);

  // The point of the whole fix: the two situations are distinguishable.
  use(store(120));
  const quota = saveRefusal();
  use(store(0));
  ok('the two refusals are told apart', quota !== saveRefusal(), `${quota} vs ${saveRefusal()}`);
}

console.log('\nU1b. a trial angle applies its turn, shift and field together (PixelGridApp.tsx)');
{
  /**
   * The bug: setAngle set the turn synchronously and deferred the shift and the
   * field behind a 250 ms debounce. All three are separate persisted keys, so a
   * reload inside that window came back with the new turn, the old angle's
   * shift and the old footprint, and nothing re-stakes on load.
   *
   * Not runnable from node (a React component plus a timer), so the fix is
   * pinned where it lives: the three setters must all sit inside the scheduled
   * job, after everything in it that can throw.
   */
  const src = fs.readFileSync(path.join(ROOT, 'src/pixel-grid/PixelGridApp.tsx'), 'utf8');
  const start = src.indexOf('setAngle: (deg: number) => {');
  const body = start < 0 ? '' : src.slice(start, src.indexOf('\n    },', start));
  ok('setAngle is where it was', body.length > 0);

  const cut = body.indexOf('scheduleStake(');
  const head = body.slice(0, cut), job = body.slice(cut);
  ok('the stake is still deferred', cut > 0);
  // The one synchronous branch left is the early return for "no plan, no grid",
  // where there is nothing to stake and nothing to set a field from.
  const headSetters = head.split('\n').filter(l => /set(ImportedTurn|ImportedShift|FieldFromTrial)\(/.test(l));
  ok('nothing is applied before the stake except the no-plan early return',
    headSetters.every(l => l.includes('return;')), headSetters.join(' | '));

  const at = s => job.indexOf(s);
  ok('the turn is applied inside the job', at('setImportedTurn(turn)') > 0);
  ok('... after the projection that can throw', at('toLngLat.forward') > 0 && at('toLngLat.forward') < at('setImportedTurn(turn)'));
  ok('... after the stake that decides the shift', at('stakeOnGrid(') > 0 && at('stakeOnGrid(') < at('setImportedTurn(turn)'));
  ok('the shift follows it immediately', at('setImportedShift(shift)') > at('setImportedTurn(turn)'));
  ok('and the field follows that', at('setFieldFromTrial(') > at('setImportedShift(shift)'));
  // Nothing between the first and the last setter may compute anything: a throw
  // there is what leaves two of the three keys saved and the third stale.
  const landing = job.slice(at('setImportedTurn(turn)'), at('setFieldFromTrial(') + 40);
  ok('nothing computes between them', !/(proj4|stakeOnGrid|rotateImportedPlan|\.map\(|throw )/.test(landing), landing.replace(/\s+/g, ' '));
  // A throw from the timer reaches no error boundary, so the job catches its own.
  ok('the job reports a failure instead of throwing out of the timer',
    /catch \(e\)/.test(job) && /setImportError\(/.test(job));
}

console.log('\nU2. step 3 states NO purity: it lives in one place, the step-4 ladder');
const simStep = read('src/pixel-grid/steps/SimStep.tsx');
const controls = read('src/pixel-grid/steps/controls.tsx');
const useSim = read('src/pixel-grid/use-simulation.ts');

// The step-3 card used to carry its own purity headline, count and advisory
// notes. That was a SECOND place the number lived, and every time the ladder's
// definition moved the card had to be moved with it or the page said two
// things: 62% on the ladder beside 47% on the Purity tab for the same pure
// pixels. The card now describes the trial and nothing else. These checks fail
// if a purity line, its notes or the plumbing that fed them come back.
const summaries = controls.slice(controls.indexOf('export function BlockSummary('),
  controls.indexOf('/**', controls.indexOf('export function ImportedSummary(') + 10));
check('neither summary card renders a purity headline', !/<Resolving\b/.test(summaries) && !/function Resolving\b/.test(controls));
check('nor the advisory notes that explained it',
  !/const note =/.test(summaries) && !/narrower than one pixel/.test(summaries) && !/Lowering the purity threshold/.test(summaries));
check('nor takes the props that fed them',
  !/\bpurePct\b/.test(summaries) && !/\bresolving\b/.test(summaries) && !/\bthreshold\b/.test(summaries));
check('step 3 passes none of them down',
  !/resolving=\{/.test(simStep) && !/purePct=\{/.test(simStep) && !/const fieldSim =/.test(simStep));
check('and no capped-grid line apologises for a purity the card never states',
  !/no trial-wide purity to state here/.test(simStep));
check('and the hook no longer computes a card-only purity', !/const resolving = useMemo/.test(useSim));

console.log('\nU2b. one sampling-position control, not two, and its effect is where purity lives');
{
  const grid = read('src/pixel-grid/use-grid.ts');
  const gridStep = read('src/pixel-grid/steps/GridStep.tsx');
  const sweepSrc = read('src/pixel-grid/PcaSweep.tsx');
  const pcaStep = read('src/pixel-grid/steps/PcaStep.tsx');
  const useSim2 = read('src/pixel-grid/use-simulation.ts');
  // A rung of the ladder is computed in ladder-step.ts, on the page or in a worker.
  const rungSrc = read('src/pixel-grid/ladder-step.ts');

  // The PSF offset duplicated the geolocation error and moved nothing: a KNOWN
  // uniform shift is cancelled by the placement search sliding the trial, and
  // the UNKNOWN part is exactly what geoErrM describes. Its saved value must not
  // be read either, or an old offset with no control left keeps shifting every
  // simulation unseen.
  check('there is no PSF offset control', !/psfOff/.test(gridStep) && !/>Offset</.test(gridStep));
  check('and its saved value is no longer read', !/usePersistentState\('psfOff/.test(grid));
  check('and no simulation is fed a user offset', !/offX: psfOff|offY: psfOff/.test(useSim2));

  // Geolocation error used to show only in the step 3 card, which exists only
  // for block and imported trials: on a strip design it moved nothing at all.
  // It now shows on every ladder panel, for every layout.
  // What a rung reports under a geolocation error is the SET that survives it,
  // not a range of counts: on a 15 m plot at a 3.5 m CE90 the count stays 64 to
  // 77 at every placement while only 16 of the 64 nominal pixels are pure at
  // all of them. The shifts go out to the CE90 and are NOT clamped to half a
  // pixel, because a pixel chosen by its coordinates is not periodic.
  check('the ladder computes the robust set for each rung, out to the CE90',
    /const lands = ce90Shifts\(ce90\);/.test(rungSrc) && /heldMask\(mixed, lands\.length, /.test(rungSrc)
    && !/shiftSamples\(geoErrM/.test(useSim2) && !/shiftSamples\(/.test(rungSrc));
  // heldMask is robustMask asked a placement at a time, each one only about the
  // pixels still standing: the same set, without simulating what cannot matter.
  check('each placement is asked only about the pixels still pure at every one before it',
    /for \(let s = 0; s < placements && hold\.left\(\) > 0; s\+\+\) hold\.take\(verdictAt\(s, hold\.alive\)\);/.test(read('src/pixel-grid/resolving.ts'))
    && /if \(alive\[k\] && verdict\[k\] !== nominal\[k\]\) \{ alive\[k\] = 0; left--; \}/.test(read('src/pixel-grid/resolving.ts')));
  // The note's own number: one effective spot, sigma_eff in quadrature.
  check('and the across-image mean under sigma_eff, as the note does',
    /Math\.hypot\(rung\.sigmaX, sigGeoM \/ r\)/.test(rungSrc) && /sigGeoM = ce90 > 0 \? ce90 \/ CE90_TO_SIGMA : 0/.test(rungSrc));
  check('skipped past the widest kernel the engine is allowed elsewhere', /Math\.max\(effX, effY\) <= 5/.test(rungSrc));
  check('only when the CE90 is above zero', /if \(ce90 > 0 && resolvingPct != null\)/.test(rungSrc));
  // The note takes sigma_geo = GSD / 3 when no accuracy is known. The CE90 was
  // a flat 0 by default, so no geolocation error was applied unless the reader
  // knew to add one. It follows GSD / 3 until a value is typed, and because it
  // follows the pixel size each rung of the ladder computes its own.
  {
    const g = read('src/pixel-grid/use-grid.ts');
    check('the CE90 defaults to the note\'s GSD / 3, not to 0',
      /usePersistentState\('geoAuto', true, isBool\)/.test(g) && /ce90For\(geoAuto, geoManual, res\)/.test(g)
      && /ce90For = \(auto: boolean, manualM: number, res: number\): number => \(auto \? \(CE90_TO_SIGMA \* res\) \/ 3 : manualM\);/.test(read('src/pixel-grid/resolving.ts')));
    check('typing a value is what turns the default off', /setGeoErrM = useCallback\(\(v: number\) => \{ setGeoAuto\(false\); setGeoManual\(v\); \}/.test(g));
    check('each rung uses the CE90 of its own pixel size', /const ce90 = Math\.round\(ce90At\(r\) \* 100\) \/ 100;/.test(rungSrc)
      && /const ce90At = \(res: number\) => ce90For\(ctx\.geoAuto, ctx\.geoManual, res\);/.test(rungSrc)
      && /ce90M: ce90 > 0 \? ce90 : undefined/.test(rungSrc));
    check('and the input offers the way back to the default', /onClick=\{\(\) => setGeoAuto\(true\)\} disabled=\{geoAuto\}/.test(read('src/pixel-grid/steps/GridStep.tsx')));
  }
  check('every sample goes through the SAME share rule as the rung it qualifies',
    (rungSrc.match(/plantedShare\(/g) || []).length >= 2 && !/0\.8 \* geo/.test(rungSrc));
  check('each panel prints what stays pure within the CE90, never a bare 0%',
    /within CE90 <span[^>]*>\{pct0\(c\.geoRobust\)\}<\/span>/.test(sweepSrc) && !/geoLo|geoHi/.test(sweepSrc));
  check('and its tooltip gives the count and the note\'s across-image mean',
    /for any geolocation error within the CE90 \(\$\{c\.ce90M \?\? geoErrM\} m\)/.test(sweepSrc) && /pct0\(c\.geoMean\)/.test(sweepSrc));
  // The plot is what a variety trial is read by: a fine share can still leave
  // whole plots with nothing to follow.
  // One figure on the panel: the fewest pure pixels any plot holds, or how
  // many plots hold none. The median and the rest are in the tooltip.
  check('each panel says how the pure pixels are spread over the plots',
    /min <span className="text-neutral-300">\{t\.min\}<\/span> px \/ plot/.test(sweepSrc) && /\{t\.none\}\/\{t\.plots\} plots empty/.test(sweepSrc)
    && /minimum \$\{t\.min\}, median \$\{t\.median\}/.test(sweepSrc));
  check('counted over the robust set once a geolocation error is set',
    /const t = c\.plotsRobust \?\? c\.plots;/.test(sweepSrc));
  // The closed form left the panel for its tooltip when the plot-size card
  // arrived: it was one more line on each of nine panels, and the card gives
  // the size a design needs. A design under it still shows, in amber.
  check('and keeps the note\'s closed-form smallest plot one hover away, flagging a design under it',
    /at least \$\{c\.minPlotM\.toFixed\(1\)\} m at this pixel size/.test(sweepSrc) && /c\.plotSideM < c\.minPlotM/.test(sweepSrc)
    && /small && t\.none === 0 \? 'text-amber-300\/80'/.test(sweepSrc));
  // Six or seven lines of caption stood over each small chart.
  check('a panel\'s caption is two short lines that never wrap',
    (sweepSrc.match(/whitespace-nowrap px-0\.5 font-mono text-\[12px\] leading-tight tracking-tight/g) || []).length === 2);
  // 90 % is the note's pure pixel. At 100 % a Gaussian never clears, so the
  // answer was set by where the kernel is cut off: 0 pure pixels on Pleiades
  // where the note counts 20.
  check('the threshold defaults to the note\'s 90 % and 100 is not offered',
    /usePersistentState\('threshold', 90, inRange\(50, 99\)\)/.test(useSim2)
    && /min="50" max="99" step="1"/.test(read('src/pixel-grid/steps/SimStep.tsx')));
  check('and step 4 hands the panels the error to label it with', (pcaStep.match(/geoErrM=\{geoErrM\}/g) || []).length >= 2);
  check('and step 3 no longer carries a second range', !/GeoSpread/.test(read('src/pixel-grid/steps/controls.tsx')) && !/geoSpread/.test(useSim2));
}

console.log('\nU2c. the trial angle accepts negative values, and nothing hand-rolls the axis test');
{
  const useSim3 = read('src/pixel-grid/use-simulation.ts');
  const controls3 = read('src/pixel-grid/steps/controls.tsx');
  check('the saved angle admits the anticlockwise half', /usePersistentState\('rotation', 0, inRange\(-90, 90\)\)/.test(useSim3));
  check('and so does the control', /min=\{-90\} max=\{90\}/.test(controls3));
  // One mod-90 helper, not a copy per file: the hand-written form reads -3.6 as
  // aligned, which switched the whole comparison off for a trial that was not.
  for (const f of ['src/pixel-grid/steps/PcaStep.tsx', 'src/pixel-grid/steps/SimStep.tsx', 'src/pixel-grid/use-simulation.ts']) {
    check(`${f.split('/').pop()} asks the shared helper instead of hand-rolling it`,
      /alignedWithin\(/.test(read(f)) && !/Math\.min\(angle, 90 - angle\)/.test(read(f)));
  }
}

console.log('\nU3. the aligned-vs-drawn verdict reads the number it prints, both ways');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/pixel-grid/steps/PcaStep.tsx'), 'utf8');

  // (1) The ranking rules, lifted from the source and run, not reimplemented.
  // BOTH directions: the verdict used to compute only `worse`, so it had no
  // word for better and the kindest thing it could say about the aligned
  // placement was "never more than 2 points behind", even where it won by 29.
  const tie = Number(src.match(/const TIE_POINTS = ([\d.]+)\s*;/)[1]);
  const predOf = name => src.match(new RegExp(`const ${name} = rows\\.filter\\((x => [^)]*?)\\)\\.map`))?.[1];
  const betterSrc = predOf('better'), worseSrc = predOf('worse');
  ok('the verdict ranks in BOTH directions', !!betterSrc && !!worseSrc, `better: ${betterSrc} | worse: ${worseSrc}`);
  const better = new Function('TIE_POINTS', `return (${betterSrc});`)(tie);
  const worse = new Function('TIE_POINTS', `return (${worseSrc});`)(tie);
  ok('a point of purity is a tie in either direction',
    better({ drawn: 50, aligned: 50.5 }) === false && worse({ drawn: 50, aligned: 49.5 }) === false, `TIE_POINTS=${tie}`);
  ok('a real gain is called better, and a real drop worse',
    better({ drawn: 38, aligned: 67 }) === true && worse({ drawn: 50, aligned: 39 }) === true);
  ok('and one pair is never both', !(better({ drawn: 38, aligned: 67 }) && worse({ drawn: 38, aligned: 67 })));

  // (2) Everything the rules read must be printed beside them. The rule is not
  // WHICH quantity, it is that they are the same quantity. They used to be
  // repeated in a sentence under eighteen small charts; the ladder is a table
  // now, with both placements' figures in every row, and the sentence under it
  // is the verdict alone. So the rule is checked against the table: what the
  // verdict ranks on (the share, or what holds within the CE90) is a column of
  // it, for each placement, at every size.
  const table = fs.readFileSync(path.join(ROOT, 'src/pixel-grid/ResTable.tsx'), 'utf8');
  const para = src.slice(src.indexOf('{/* The verdict of the comparison, in one sentence.'));
  const sentence = para.slice(0, para.indexOf('</p>'));
  const ranked = [...new Set([...`${betterSrc} ${worseSrc}`.matchAll(/x\.(\w+)/g)].map(m => m[1]))];
  ok('the verdict ranks on the two placements\' own figures', ranked.length === 2 && ranked.includes('drawn') && ranked.includes('aligned'), `ranks on ${ranked.join(', ')}`);
  ok('and both are printed, for both placements, in every row of the table above it',
    /<span>\{share\(s\)\}<\/span>\s*\{anyHeld && <span>\{held\(s\)\}<\/span>\}/.test(table)
    && /\{group\(s, 0, onPick\)\}\s*\{group\(pairWith\[k\], 1, onPickPair\)\}/.test(table)
    && src.indexOf('<ResTable') < src.indexOf('{/* The verdict of the comparison, in one sentence.'));
  ok('as the percentages a rung holds, never a figure borrowed from elsewhere',
    /s\.resolvingPct\.toFixed\(0\)\}%/.test(table) && /\{pct0\(s\.geoRobust\)\}/.test(table) && /it computes nothing/.test(table));

  // (3) The sentence can actually SAY better, not only "behind".
  ok('the sentence has a branch that says the other placement gives more',
    /comparison\.better\.length > 0/.test(sentence) && /\$\{other\} more/.test(sentence)
    && /const other = imported \? 'best placement gives' : 'pixel rows give';/.test(src));

  // (4) The margin in the words is the margin in the rule.
  ok('the tie margin the panel prints comes from the constant it ranks with',
    /\$\{TIE_POINTS\}/.test(sentence) && !/\b3%/.test(sentence));

  // (5) The counts, both or neither, in the units the panels show. Trial-pixel
  // totals used to be printed here, a THIRD denominator beside shares over
  // planted crop, which is the currency mix this page has shipped twice.
  ok('each placement\'s pure counts are one hover away on its own cell, never one side\'s alone under both',
    /title=\{about\(s, geoErrM, threshold\)\}/.test(table) && /pure of the \$\{fmt\(s\.plantCount \?\? NaN\)\} pixels of crop this design plants/.test(table)
    && /px stay pure, for the same plot, for any geolocation error within the CE90/.test(table) && !/Pure/.test(sentence.replace(/pure crop/g, '')));
  ok('and no trial-pixel total is quoted beside the shares', !/trial pixels/.test(sentence) && !/trial pixels/.test(table));

  // (6) It leads with the size where the placements differ most.
  ok('the headline pair is the one that differs most, not merely the first',
    /rows\.reduce\(\(a, b\) => \(Math\.abs\(b\.aligned - b\.drawn\) > Math\.abs\(a\.aligned - a\.drawn\)/.test(src));

  // (7) Sampled rungs are judged too. Excluding them, together with the rung on
  // the map, hid every informative size on a large field and left a 0% against
  // 0% pair as the whole verdict beneath panels reading 38% against 67%.
  ok('sampled rungs are not thrown out of the comparison',
    !/own\.partial \|\| al\.partial\) return \[\]/.test(src) && /sampled: !!\(own\.partial \|\| al\.partial\)/.test(src));
  ok('nor is the rung currently on the map', !/own\.current \|\|/.test(src));
  ok('and a sampled rung says it was sampled, on its own row',
    /s\.partial \? <span title="Sampled over the central part of a large field"> ◦<\/span>/.test(table));

  // (8) With a geolocation error set it judges the WORST cases. The nominal is
  // one draw, and for a staked placement it is the lucky draw by construction:
  // on a 50 m plot trial at 10 m the verdict called staking better on 182
  // against 225 pure pixels where the worst cases were 177 against 180.
  ok('with a geolocation error it ranks what survives it, not the nominals',
    /const worstCase = geoErrM > 0;/.test(src) &&
    /if \(worstCase\) \{[\s\S]{0,200}drawn: own\.geoRobust, aligned: al\.geoRobust/.test(src));
  ok('and prints the robust pure counts, not the nominal ones',
    /drawnPure: own\.geoRobustPure \?\? NaN, alignedPure: al\.geoRobustPure \?\? NaN/.test(src));
  ok('a rung whose robust share is missing is left out, never judged on its nominal beside robust ones',
    /if \(own\.geoRobust == null \|\| al\.geoRobust == null\) return \[\];/.test(src));
  ok('the sentence says which basis it compared on, and the nominal stands beside it in the table',
    /\{worstCase \? 'On the pixels that hold within the CE90, ' : ''\}/.test(sentence)
    && /<span className=\{TERM\}>pure<\/span>/.test(table) && /<span className=\{TERM\}>CE90<\/span>/.test(table));
  ok('a tie is stated plainly, with the tolerance it was judged at',
    /two placements are within \$\{TIE_POINTS\} points for every one of/.test(sentence));

  const sweepSrc = fs.readFileSync(path.join(ROOT, 'src/pixel-grid/PcaSweep.tsx'), 'utf8');
  ok('and the ladder panels are labelled with the same quantity, a percentage',
    /c\.resolvingPct\.toFixed\(0\)\}%/.test(sweepSrc));
  ok('and the pure-pixel count is printed beside it, never the share alone',
    /fmt\(c\.pureCount\)\}px/.test(sweepSrc));
  ok('and an unmeasurable rung is named, not rounded to 0%',
    /resolvingPct === null \? 'n\/a'/.test(sweepSrc));
}


console.log('\nU4. a ladder panel reports its OWN rung, never the chart it borrows');
{
  const src = read('src/pixel-grid/PcaSweep.tsx');
  const body = src.slice(src.indexOf('const toCharts'), src.indexOf('const charts = useMemo'));
  const ret = body.slice(body.lastIndexOf('return {'));

  // The big chart IS lent to the panel at the displayed size, on purpose: the
  // picture must not change when a thumbnail is picked. What must not be
  // borrowed is any NUMBER, because it is a different measurement (the whole
  // field, sometimes subsampled, against the rung's own trial extent). A panel
  // worth 49% read 50% for exactly as long as it was the size on screen, so
  // clicking along the ladder moved the figures it was being read for.
  ok('the drawing may still come from the big chart', /isActive \? activeSim! : s/.test(body));
  for (const field of ['purePct', 'pureCount', 'trialCount', 'partial']) {
    const m = ret.match(new RegExp(field + ':\\s*([^,\\n]+)'));
    ok(`${field} is read off the rung, not the borrowed chart`,
      !!m && !/activeSim|isActive/.test(m[1]), m ? m[1].trim() : 'not returned');
  }
  // And the stub for the size the big chart is drawing carries no number at all,
  // rather than the chart's: it gets its own once the idle pass has built it.
  ok('the not-yet-built rung shows no number rather than the chart\'s',
    /purePct: NaN, pureCount: NaN, trialCount: NaN/.test(body));
}


console.log('\nU5. a number field is typed into, not fought with');
{
  const src = read('src/pixel-grid/steps/controls.tsx');
  const fn = src.slice(src.indexOf('function NumField'), src.indexOf('function NumField') + 3000);
  const input = fn.slice(fn.indexOf('<input type="number"'), fn.indexOf('className={FIELD}'));

  // The box shows the DRAFT while one is being typed. Rendering the committed
  // number straight back is what made the field impossible to empty: clearing
  // it parses to NaN, nothing is reported, and React puts the old number back.
  ok('the box renders the draft, falling back to the number the page holds',
    /value=\{draft \?\? String\(value\)\}/.test(input));

  // Typing must not commit. It used to call onChange on every keystroke, so
  // "23.5" re-ran the simulation four times, and a design takes several fields.
  const onChange = input.slice(input.indexOf('onChange='), input.indexOf('onBlur='));
  ok('typing sets the draft and never calls onChange straight through',
    /setDraft\(raw\)/.test(onChange) && !/onChange\(/.test(onChange), 'onChange handler');

  // Clamping belongs on commit. Applied per keystroke it rewrote half-typed
  // numbers: a field with a minimum of 5 turned a leading "2" into "5".
  const commit = fn.slice(fn.indexOf('const commit ='), fn.indexOf('return ('));
  ok('the clamp lives in commit, not in the keystroke handler',
    /Math\.max\(min, Math\.min\(max, v\)\)/.test(commit) && !/Math\.min\(max/.test(onChange));
  ok('an unparseable or empty draft commits nothing and falls back',
    /if \(!Number\.isFinite\(v\)\) return;/.test(commit));

  // The three ways an edit finishes, and the one that abandons it.
  ok('blur commits', /onBlur=\{e => commit\(e\.target\.value\)\}/.test(input));
  ok('Enter commits', /'Enter'[\s\S]{0,80}commit\(/.test(input));
  ok('Escape drops the draft without committing',
    /'Escape'[\s\S]{0,80}setDraft\(null\)/.test(input) &&
    !/'Escape'[\s\S]{0,80}commit\(/.test(input));
  ok('a pause commits too, so the spinner arrows act without being tabbed out of',
    /setTimeout\(\(\) => commit\(raw\), NUM_COMMIT_DELAY\)/.test(onChange));
  ok('and the pending timer is dropped when the panel goes away',
    /useEffect\(\(\) => stop, \[\]\)/.test(fn));
}


console.log('\nU6. a measured PSF reproduces the FWHM it was measured at');
{
  const src = read('src/pixel-grid/sensors.ts');
  // psf is a sigma in PIXELS, so the metres it claims are psf * 2.355 * res.
  // These six were fitted on the PHENET images themselves; a published MTF
  // describes the instrument, this describes the product, and for the tasked
  // sensors the two differ by a factor of two to four. Pinned so a later edit
  // cannot quietly put the flattering spec figures back.
  const MEASURED = [
    ['s2-10', 10, 14.0], ['planet', 3, 9.7], ['wv', 1.6, 1.9],
    ['wv-ps', 0.4, 1.1], ['pleiades', 2, 5.0], ['pleiades-ps', 0.5, 3.0],
  ];
  for (const [id, res, fwhm] of MEASURED) {
    const row = new RegExp(`\\{ id: '${id}',[^}]*?res: ([0-9.]+),[^}]*?psf: ([0-9.]+),`).exec(src);
    if (!row) { check(`${id} is still a source`, false); continue; }
    const gotRes = parseFloat(row[1]), got = parseFloat(row[2]) * 2.355 * gotRes;
    check(`${id} at ${res} m carries the measured ${fwhm} m FWHM`,
      gotRes === res && Math.abs(got - fwhm) < 0.05 * fwhm, `${gotRes} m, ${got.toFixed(2)} m`);
  }
  // A link would be a fabrication: the note is not published.
  check('and says it was measured rather than linking somewhere it is not',
    /const SRC_PHENET = \{ label: 'measured on PHENET images at Mauguio and Toulouse' \};/.test(src) && !/SRC_PHENET = \{ url/.test(src));
  check('so the panel renders a plain label when there is no url',
    /source\.psfSrc\.url\s*\?/.test(read('src/pixel-grid/steps/GridStep.tsx')));
  // Pansharpened sharpness is spatial, borrowed from the panchromatic band.
  check('and the native MS row is the one offered first',
    src.indexOf("id: 'wv'") < src.indexOf("id: 'wv-ps'")
    && src.indexOf("id: 'pleiades'") < src.indexOf("id: 'pleiades-ps'"));
}

console.log('\nU7. the blur budget adds variances, and owns up to the box');
{
  const grid = read('src/pixel-grid/use-grid.ts');
  const step = read('src/pixel-grid/steps/GridStep.tsx');

  // Independent spreads add in VARIANCE, not in width. Summing the widths would
  // overstate every total, because a spread one way as often meets a shift the
  // other way as the same way.
  check('the effective spot is a quadrature sum, never a sum of widths',
    /effSigmaXM = Math\.hypot\(psfSigmaXM, geoSigmaM\)/.test(grid)
    && /effSigmaYM = Math\.hypot\(psfSigmaYM, geoSigmaM\)/.test(grid));
  // Providers publish CE90, the radius holding 90 % of a Rayleigh radial miss.
  check('and the geolocation figure is read as a CE90, not as a sigma',
    /export const CE90_TO_SIGMA = 2\.1460;/.test(read('src/pixel-grid/resolving.ts')) && /geoErrM \/ CE90_TO_SIGMA/.test(grid)
    // ONE constant: the budget and the ladder must not each carry their own.
    && !/const CE90_TO_SIGMA/.test(grid));
  check('a pixel integrates over its footprint, so the box is 1\/sqrt(12)',
    /boxSigmaM = pxSize \/ Math\.sqrt\(12\)/.test(grid));

  // Both a measured FWHM and a published MTF at Nyquist are SYSTEM figures that
  // already contain the detector, so the box is a second helping of it. Only a
  // typed sigma may legitimately be lens-only.
  check('the box double-counts for every preset, not only the measured ones',
    /const boxDoubleCounts = !!source\.psfSrc;/.test(grid));
  check('and the panel says which of the three the sigma came from',
    /'measured' \| 'published' \| 'typed'/.test(step)
    && /source\.psfMeasured \? 'measured' : source\.psfSrc \? 'published' : 'typed'/.test(step));

  // simulate.ts applies the box whatever the budget says. A panel that printed
  // only the clean total would disagree with the purity numbers beside it.
  // The engine convolves the optics and the pixel box, never the geolocation
  // error: the row printed sigma_eff with the box, a blur no simulation applies.
  check('the list always states the sigma the engine really simulates',
    /name="σ simulated" val=\{pair\(Math\.hypot\(optX, box\), Math\.hypot\(optY, box\)\)\}/.test(step)
    && /The geolocation error is not blurred in/.test(step));
  check('and marks the pixel footprint as already inside the FWHM rather than adding it',
    /name="pixel footprint" val=\{m\(box\)\} dim=\{boxDoubleCounts\} note=\{boxDoubleCounts \? 'included in FWHM'/.test(step));
  // One list, every source, at the current setting: blur, what it costs, where
  // the grid and the image sit, the signal noise, and what is NOT simulated.
  // In the PHENET note's own terms and symbols, so a figure here can be read
  // straight against the note: GSD, FWHM, r, alpha, the three sigmas, epsilon,
  // the buffer b, the pure core L - 2b and the any-pixel minimum plot.
  check('the list uses the note\'s terms and symbols',
    ['"GSD"', '"FWHM"', '"r = FWHM/GSD"', '"α"', '"pure core L − 2b"', '"min. plot, any pixel"', '"grid phase"', '"grid rotation"']
      .every(n => step.includes(`name=${n}`))
    && ['σ<sub>PSF</sub>', 'σ<sub>geo</sub>', 'σ<sub>eff</sub>', 'buffer b = k σ<sub>eff</sub>'].every(n => step.includes(n))
    && /Threshold <span className="normal-case">ε<\/span> = \{100 - threshold\} %/.test(step) && step.includes('<Head>Not simulated</Head>'));
  check('alpha is the MTF at Nyquist, exp(-0.890 r^2)', /Math\.exp\(-0\.890 \* r \* r\)/.test(step));
  // PlanetScope's alpha is about 9 x 10^-5. Two decimals printed it as 0.00.
  check('and a small alpha is never printed as 0.00', /val=\{small\(Math\.exp\(-0\.890 \* r \* r\)\)\}/.test(step)
    && /if \(!\(v > 0\) \|\| v >= 0\.01\) return v\.toFixed\(2\);/.test(step));
  // Every term in the list carries its definition on hover: `tip` is a
  // REQUIRED prop of Row, so a row added without one does not compile, and the
  // counts below catch one removed by hand.
  {
    const list = step.slice(step.indexOf('function VarianceSources'), step.indexOf('function GridStepBody'));
    const rows = (list.match(/<Row name=/g) || []).length, tips = (list.match(/\btip=/g) || []).length;
    check('every row of the list has an explanation on hover', rows >= 15 && tips === rows, `${rows} rows, ${tips} tips`);
    check('the definition is required by the row itself', /tip: React\.ReactNode; val: string/.test(list));
    check('and so do the threshold and the four things not simulated',
      (list.match(/<Explain below/g) || []).length >= 6);
  }
  check('and names each source the simulation leaves out',
    ['per-band FWHM', 'heavier tails (adjacency effect)', 'variance between replicates', 'other grid rotations']
      .every(t => step.includes(`<span className={term}>${t}</span>`)));
  // A table of labels and numbers. It was a column of explanatory sentences,
  // which read as generated text rather than as an instrument.
  check('as a table of numbers, with no sentence in it',
    !/Conservative, not correct|what is really convolved|wherever the grid falls/.test(step));
  check('the buffer and the smallest plot follow the threshold in force',
    /bufferK\(threshold \/ 100\)/.test(step) && /minPlotSideM\(res, eff, threshold \/ 100\)/.test(step));

  // The export carried geometry only, so the pixels worth trusting never left
  // the screen.
  const shell = read('src/pixel-grid/PixelGridApp.tsx');
  check('the shapefile carries the verdict per pixel, the robust set included',
    /name: 'PURE', values: v\.pure/.test(shell) && /name: 'PURE_CE90', values: v\.robust/.test(shell)
    && /exportAttrsRef\.current\?\.\(grid\)/.test(grid));
  check('cut down by the same mask as the cells it describes',
    /values: kept \? kept\.map\(k => f\.values\[k\]\) : f\.values/.test(grid));
}

// The plot size a trial needs. The page could say whether the design's plots
// held pure pixels, and the note's closed form for one pixel in a square plot;
// it could not say what size a given design had to be.
{
  const card = read('src/pixel-grid/steps/PlotSize.tsx');
  const shell = read('src/pixel-grid/PixelGridApp.tsx');
  const model = read('src/pixel-grid/plot-size.ts');
  // Once, where the plots are sized. It stood in step 2 as well, a second
  // copy of a ten-line table on a panel about the satellite.
  check('the plot-size card is shown beside the plot dimensions, and only there',
    !/PlotSizeCard/.test(read('src/pixel-grid/steps/GridStep.tsx')) && /<PlotSizeCard \{\.\.\.p\} \/>/.test(read('src/pixel-grid/steps/SimStep.tsx')));
  check('with one column per reading of the geolocation error',
    ['corrected', 'average', 'robust'].every(id => new RegExp(`\\b${id}: \\{`).test(card)) && /imageCases\(d\.sigma, d\.geoErrM\)/.test(card));
  check('each reading says what it is on hover', (card.match(/tip: /g) || []).length >= 4 && /co-registration/.test(card) && /9 images out of 10/.test(card));
  check('sized for the design\'s own plot, whatever the layout',
    ["pattern === 'block'", "pattern === 'imported'", "pattern === 'checker'"].every(t => card.includes(t)) && /b: Infinity/.test(card)
    && /importedPlotBoxes\(importedPlan, importedAngle\)/.test(card));
  check('at the sensor and threshold in force', /gsd: d\.res, sigma: c\.sigma, shift: c\.shift, threshold: d\.threshold \/ 100, angleDeg: d\.angle/.test(card));
  check('it also says what the plots hold now, and how far the purest pixel is from pure',
    /fewestPure\(plot, v\)/.test(card) && /purestShare\(plot, v\)/.test(card) && /purest pixel, from outside/.test(card));
  check('a size can be given to the design, except for a trial read from a file',
    /onClick=\{\(\) => design\.apply!\(s\)\}/.test(card) && /setBlockDesign\(d => \(\{ \.\.\.d, plotLength: fieldSize\(a \* s\), plotWidth: fieldSize\(b \* s\) \}\)\)/.test(card));
  // Step unmounts a collapsed panel, and the card is shown in two of them.
  check('the count it is asked for lives in the shell, saved and validated',
    /usePersistentState\('wantPure', 16, v => Number\.isInteger\(v\)/.test(shell) && /wantPure, setWantPure \}/.test(shell)
    && !/useState\(/.test(card) && /const \{ wantPure, setWantPure \} = p;/.test(card));
  check('the numbers follow the inputs without holding up the field being typed in', /useDeferredValue\(inputs, null\)/.test(card));
  check('the model counts every side, and knows nothing of the engine',
    /between\(plot\.a, x, sigma\) \* between\(plot\.b, y, sigma\)/.test(model) && !/from '\.\/simulate'/.test(model));
  check('and its margin is a measured one', /const MARGIN = 1\.006;/.test(model) && /300\s+\* random designs|300\n \* random designs/.test(model));
}

// The pixel under the pointer says its purity. The map drew what each pixel was
// made of and nothing gave the figure itself.
{
  const layers = read('src/pixel-grid/map-layers.tsx');
  const map = read('src/pixel-grid/FieldMap.tsx');
  const engine = read('src/pixel-grid/simulate.ts');
  const hover = layers.slice(layers.indexOf('function PixelHover'), layers.indexOf('export { BASEMAPS'));
  check('the engine keeps the share it compares with the threshold',
    /cropMapPurity\[idx\] = totalCropWeight > 0 \? maxWeight \/ totalCropWeight : 0;/.test(engine)
    && /purity: agg\.cropMapPurity, dominant: agg\.cropMapMajority,/.test(engine));
  check('the map reads it for the pixel under the pointer, off the simulation that is drawn',
    /<PixelHover grid=\{renderGrid\} sim=\{sim\.sim\} layout=\{layout\} names=\{names\}/.test(map)
    && /simOn && sim\.sim && renderGrid && !drawMode/.test(map));
  // One listener and two divisions, not a handler on each of tens of thousands of cells.
  check('with one listener on the map, the pixel found from the pointer\'s coordinates',
    /map\.on\('mousemove', move\)/.test(hover) && /Math\.floor\(\(E - e0\) \/ r\)/.test(hover) && /j \* nx \+ i/.test(hover)
    && !/onEachFeature|interactive: true/.test(hover));
  check('only for pixels of the field, and never on a sampled grid',
    /\(!mask \|\| mask\[at\]\)/.test(hover) && /!\(grid\.stride && grid\.stride > 1\)/.test(hover)
    && /mask=\{inField && inField\.grid === renderGrid \? inField\.mask : null\}/.test(map));
  // A state change per mouse move would re-render the map tree and rule the grid again.
  check('the readout is moved by its transform, in the map\'s own container',
    /el\.style\.transform = `translate\(/.test(hover) && /createPortal\(/.test(hover) && /map\.getContainer\(\)/.test(hover));
  // One namer for the readout and for the lines of the Signal of a pixel card.
  const namer = read('src/pixel-grid/signal-sources.ts');
  check('it names what the pixel is mostly made of, and the verdict',
    /'outside the trial'/.test(namer) && /'bare soil'/.test(namer) && /`, plot \$\{d \+ 1\}`/.test(namer) && /pure \? 'pure' : 'mixed'/.test(hover)
    && /const nameOf = useMemo\(\(\) => coverNamer\(layout, names\), \[layout, names\]\);/.test(hover)
    && /what = v === OFF_TRIAL\.id \? nameOf\(OFF_TRIAL\.id\) : nameOf\(d\);/.test(hover));
  check('a purity a hair under the threshold is cut, not rounded up to it', /Math\.floor\(p \* 1000\) \/ 10/.test(layers));
  check('the hovered pixel is outlined above the overlay, in the selection pane',
    map.indexOf('<PixelHover') > map.indexOf('<Pane name="selection"')
    && map.indexOf('<PixelHover') < map.indexOf('</Pane>', map.indexOf('<Pane name="selection"')));
  // Leaflet's own mouseout does not fire when the pointer leaves the window.
  check('and the readout goes when the pointer leaves the map, the window included',
    /box\.addEventListener\('mouseleave', out\)/.test(hover) && /box\.removeEventListener\('mouseleave', out\)/.test(hover));
}

// A switch on the map picks the pure pixels out. The overlay coloured every
// pixel by what it was made of, and which ones were pure had to be guessed
// from how saturated a square looked.
{
  const map = read('src/pixel-grid/FieldMap.tsx');
  const hook = read('src/pixel-grid/use-simulation.ts');
  const shell = read('src/pixel-grid/PixelGridApp.tsx');
  check('the map has a Pure pixels switch, saved like the others',
    /\{ label: 'Pure pixels', on: showPure && simOn, flip: \(\) => setShowPure\(v => !v\), off: !build \|\| !simOn,/.test(map) && /usePersistentState\('showPure', false, isBool\)/.test(shell)
    && /showPure=\{showPure\} setShowPure=\{setShowPure\}/.test(shell));
  check('it needs the simulation, and says so when there is none',
    /off: !build \|\| !simOn,\s*title: simOn \? 'Outline the pure pixels and dim the others' : 'Turn the simulation on to use this'/.test(map));
  // One verdict for the whole page: the count, the ladder, the export and the map.
  check('the pixels it picks are the engine\'s own pure-for-a-crop verdict',
    /const pure = sim\.mixed\[k\] > MAX_COVER \? 0 : pureHeld && !pureHeld\[k\] \? 1 : 2;/.test(hook) && /if \(!showPure \|\| !sim \|\| !renderGrid\) return null;/.test(hook));
  check('only the field\'s pixels, by the mask everything else uses',
    /const pureGeojson = useMemo\(\(\) => \{[\s\S]{0,200}inField && inField\.grid === renderGrid \? inField\.mask : null/.test(hook));
  check('pure pixels are outlined and the others dimmed, never recoloured',
    /f\?\.properties\?\.pure === 2\s*\? \{ color: '#ffffff', weight: 1\.6, opacity: 0\.95, fill: false, interactive: false \}/.test(map)
    && /: \{ stroke: false, fillColor: '#000000', fillOpacity: 0\.6, interactive: false \}/.test(map));
  // react-leaflet repaints a GeoJSON only when its key moves.
  check('the layer is repainted with the overlay, in a pane between it and the selection',
    /key=\{`\$\{geoKey\}-pure-\$\{pureHeld \? geoErrM : 'nominal'\}`\}/.test(map) && /<Pane name="pure" style=\{\{ zIndex: 440 \}\}>/.test(map)
    && map.indexOf('<Pane name="pure"') < map.indexOf('<Pane name="selection"'));
  check('and the legend says what the outline means', /pure pixel, the others dimmed/.test(map));
  // Six buttons stood in a column over the map's corner, on a map 340 px wide.
  check('the basemap and the five switches open from one Layers button',
    ['Real field', 'In field only', 'PSF blur', 'Simulation', 'Pure pixels'].every(l => map.includes(`{ label: '${l}', on: `))
    && /\(Object\.keys\(BASEMAPS\) as BasemapKey\[\]\)\.map\(key => \(\s*<button key=\{key\} type="button" onClick=\{\(\) => setBasemap\(key\)\}/.test(map)
    && (map.match(/absolute right-3 top-/g) || []).length === 1);
  check('each switch keeps the rule it had as a button, and says why when it cannot act',
    /off: !build \|\| !fieldGeojson \|\| simTrimmed,/.test(map) && /off: !build \|\| psfSigmaM <= 0,/.test(map) && /off: !build \|\| simLocked,/.test(map)
    && /role="switch" aria-checked=\{sw\.on\} disabled=\{sw\.off\} title=\{sw\.title\} onClick=\{sw\.flip\}/.test(map));
  check('the panel closes on a click anywhere else, and on Escape',
    /if \(!layersBox\.current\?\.contains\(e\.target as Node\)\) setLayersOpen\(false\);/.test(map) && /if \(e\.key === 'Escape'\) setLayersOpen\(false\);/.test(map));
  check('the legend is folded behind its own button, and a refresh remembers it',
    /usePersistentState\('showLegend', false, isBool\)/.test(map) && /simOn && simGeojson && !showLegend && \(/.test(map) && /onClick=\{\(\) => setShowLegend\(false\)\}/.test(map));
}

// The switch also tells apart the pure pixels that stay pure within the CE90.
// "Pure within CE90" was a percentage on a ladder panel and a column of the
// export; nothing showed WHICH pixels it was.
{
  const map = read('src/pixel-grid/FieldMap.tsx');
  const hook = read('src/pixel-grid/use-simulation.ts');
  const verdicts = read('src/pixel-grid/pixel-verdicts.ts');
  const layers = read('src/pixel-grid/map-layers.tsx');
  check('a pure pixel that does not hold within the CE90 is drawn apart: half the veil, a broken outline',
    /\? \{ color: '#ffffff', weight: 1, opacity: 0\.7, dashArray: '3 3', fill: false, interactive: false \}\s*: \{ stroke: false, fillColor: '#000000', fillOpacity: 0\.3, interactive: false \}\)/.test(map));
  // One set for the page: the export's PURE_CE90 column and the map.
  check('by the same placements and the same rule as the export\'s PURE_CE90 column',
    /const shifts = ce90Shifts\(ce90M\);/.test(verdicts)
    && /heldMask\(nominal, shifts\.length, \(s, need\) => shiftedVerdict\(grid, origin, layout, sensor, shifts\[s\], need\)\)/.test(verdicts)
    && /const shifts = ce90Shifts\(geoErrM\), hold = holdTracker\(sim\.mixed\);/.test(hook)
    && /hold\.take\(shiftedVerdict\(renderGrid, origin, layout, sensor, shifts\[done\+\+\], hold\.alive\)\);/.test(hook)
    && /setHeld\(\{ sim, ce90: geoErrM, mask: hold\.alive \}\)/.test(hook));
  // Eight more simulations of the field: inside the render they held the page.
  check('worked out after the click, one placement per tick, and only while the switch is on',
    /if \(!showPure \|\| !sim \|\| !renderGrid \|\| !origin \|\| !\(geoErrM > 0\)\) \{ setHeld\(null\); setHeldBusy\(false\); return; \}/.test(hook)
    && /timer = window\.setTimeout\(next, 0\);/.test(hook) && /return \(\) => \{ stopped = true; clearTimeout\(timer\); \};/.test(hook));
  // Changing the CE90 repainted the map at once with the previous set, under a
  // key the right set then arrived with: 6 m in the legend, the pixels of 2.15 m.
  check('a run that is overtaken writes nothing, and a mask is only read for its own simulation and CE90',
    /if \(stopped\) return;/.test(hook) && /const pureHeld = held && held\.sim === sim && held\.ce90 === geoErrM \? held\.mask : null;/.test(hook));
  check('the legend names both levels and the CE90 they are for, and says when it is still being worked out',
    /pure within CE90 \(\{geoErrM\} m\)/.test(map) && /pure, not within CE90/.test(map) && /\{heldBusy && <span className="text-slate-500">· CE90…<\/span>\}/.test(map));
  check('the readout says it too, for a pixel that is pure',
    /held=\{showPure \? pureHeld : null\}/.test(map)
    && /v <= MAX_COVER\) holds = held\[k\] \? 'stays pure within the CE90' : 'not pure within the CE90';/.test(layers));
}

// Each step opens on what it is for. The panels had grown by addition: a blur
// table and a plot-size table on the satellite's panel, crop editors and a chart
// between a design and its verdict, five selects between a chart and its ladder.
{
  const gridStep = read('src/pixel-grid/steps/GridStep.tsx');
  const simStep2 = read('src/pixel-grid/steps/SimStep.tsx');
  const visual = read('src/pixel-grid/PcaSimVisual.tsx');
  const shell = read('src/pixel-grid/PixelGridApp.tsx');
  const body = gridStep.slice(gridStep.indexOf('function GridStepBody'));
  check('step 2 opens on the satellite, the pixel count and the file',
    body.indexOf('<select value={sourceId}') < body.indexOf('Download shapefile (.zip)')
    && body.indexOf('Download shapefile (.zip)') < body.indexOf('Blur and geolocation'));
  check('its blur and geolocation are folded, with the two figures that set them on the fold',
    /label=\{`Blur and geolocation · \$\{psfSigmaM > 0 \? `FWHM \$\{fwhmTxt\} m` : 'no blur'\} · CE90 \$\{geoErrM\} m`\}/.test(body)
    && /open=\{blurOpen\} onToggle=\{\(\) => setBlurOpen\(v => !v\)\}/.test(body)
    && body.indexOf('Blur and geolocation') < body.indexOf('<VarianceSources'));
  // Step unmounts a collapsed panel, so the fold's state is the shell's.
  check('and the fold is remembered', /usePersistentState\('blurOpen', false, isBool\)/.test(shell) && /blurOpen, setBlurOpen,/.test(shell));
  check('step 3 folds the crops and their season for every layout, as it did for an imported trial',
    /\(pattern !== 'imported' \|\| varieties\.length > 0\) && \(\s*<Disclosure/.test(simStep2)
    && simStep2.indexOf('Growth curves ·') < simStep2.indexOf('<SpeciesList') && simStep2.indexOf('<SpeciesList') < simStep2.indexOf('NDVI season')
    && simStep2.indexOf('NDVI season') < simStep2.indexOf('label="Noise & purity threshold"')
    && (simStep2.match(/<SpeciesList/g) || []).length === 1);
  check('so the plot-size card follows the design directly', simStep2.indexOf('<PlotSizeCard') < simStep2.indexOf('Growth curves ·'));
  check('step 4 folds the chart\'s five selects, naming what is drawn on the fold',
    /label=\{`Chart settings · \$\{DR_METHODS\.find\(m => m\.id === method\)\?\.label \?\? method\} · \$\{ax\(cx\)\} × \$\{ax\(cy\)\}`\}/.test(visual)
    && /usePersistentState\('pcaControlsOpen', false, isBool\)/.test(visual));
  check('the way back to the other app is in the header once, not at the foot of the panel as well',
    (shell.match(/Polygon Time-Series PCA/g) || []).length <= 1 && /Back to the Polygon Time-Series PCA app/.test(shell));
}

// Step 4 read at the width it is used at. In a 320 px panel the chart was
// pinned over the ladder, the ladder was eighteen small plots under wrapped
// captions, and comparing two sizes meant scrolling between them.
{
  const pcaStep = read('src/pixel-grid/steps/PcaStep.tsx');
  const visual = read('src/pixel-grid/PcaSimVisual.tsx');
  const table = read('src/pixel-grid/ResTable.tsx');
  const shell = read('src/pixel-grid/PixelGridApp.tsx');
  check('the resolution ladder is a table by default, the small plots one click away',
    /usePersistentState<'table' \| 'charts'>\('ladderView', 'table', oneOf\('table', 'charts'\)\)/.test(shell)
    && /ladderView === 'table' \? \(\s*<ResTable steps=\{sweep\} pairWith=\{sweepAligned\}/.test(pcaStep)
    && /\(\['table', 'charts'\] as const\)\.map\(v => \(\s*<button key=\{v\} type="button" onClick=\{\(\) => setLadderView\(v\)\}/.test(pcaStep)
    && (pcaStep.match(/<PcaSweep /g) || []).length === 2);
  check('a row puts its satellite on the map, and in a comparison each placement its own',
    /onPick=\{sweepAligned \? pickOwn : pickSat\} onPickPair=\{pickAligned\}/.test(pcaStep)
    && /onClick=\{\(\) => onPick\?\.\(s\.id\)\}/.test(table) && /onClick=\{\(\) => pick\?\.\(s\.id\)\}/.test(table));
  check('the row on the map is marked, and in a comparison the placement that is on it',
    /const on = isActive\(s\.id\) && shown === which;/.test(table) && /shown=\{onMap\}/.test(pcaStep));
  check('a rung still being worked out shows that, never another rung\'s figure',
    /s\.current \|\| s\.resolvingPct === undefined \? <span className="text-neutral-600">…<\/span>/.test(table)
    && /s\.current \|\| s\.geoRobust === undefined \? <span className="text-neutral-600">…<\/span>/.test(table));
  // A class name put together at run time is one Tailwind never generates.
  check('the table\'s columns are set as a style, not as a class built at run time',
    (table.match(/gridTemplateColumns:/g) || []).length === 2 && !/grid-cols-\[[^\]]*\$\{/.test(table));
  check('the chart is not pinned over what follows it', !/sticky top-0/.test(visual));
  check('its tabs have their row to themselves, the count and the lasso one line under the chart',
    /className=\{`flex-1 px-1 py-1 text-center capitalize/.test(visual)
    && visual.indexOf('<PcaScatterCanvas') < visual.indexOf("{lassoOn ? '✓ Lasso' : 'Lasso'}")
    && visual.indexOf("{lassoOn ? '✓ Lasso' : 'Lasso'}") < visual.indexOf('One entry per species'));
  check('the comparison is one sentence of verdict under the table', /text-\[13px\] leading-snug text-neutral-500/.test(pcaStep) && !/Pure crop at \{comparison\.lead\.res\}/.test(pcaStep));
}

// The three sigmas of the blur budget, drawn to scale on the map. They were
// three rows of a table in step 2; how large each is beside a pixel and a plot
// is a picture.
{
  const map = read('src/pixel-grid/FieldMap.tsx');
  const layers = read('src/pixel-grid/map-layers.tsx');
  const shell = read('src/pixel-grid/PixelGridApp.tsx');
  const rings = layers.slice(layers.indexOf('function SigmaRings'), layers.indexOf('function SignalDots'));
  check('Layers has a switch for the three sigmas, saved like the others',
    /\{ label: 'σ PSF, geo, eff', on: showSigmas, flip: \(\) => setShowSigmas\(v => !v\), off: !build \|\| psfSigmaM <= 0,/.test(map)
    && /usePersistentState\('showSigmas', false, isBool\)/.test(shell) && /showSigmas=\{showSigmas\} setShowSigmas=\{setShowSigmas\}/.test(shell));
  check('each is a ring of one sigma around the same pixel, from the budget\'s own figures',
    /<SigmaRings center=\{psfCenter\} psfXM=\{psfSigmaXM\} psfYM=\{psfSigmaYM\} geoM=\{geoSigmaM\}/.test(map)
    && /ring\(psfXM, psfYM\)/.test(rings) && /ring\(geoM, geoM\)/.test(rings) && /ring\(effXM, effYM\)/.test(rings));
  check('the combined one is the quadrature sum, per axis', /const effXM = Math\.hypot\(psfXM, geoM\), effYM = Math\.hypot\(psfYM, geoM\);/.test(rings));
  // A name on each ring sat on the other two whenever the rings were closer than a label is wide.
  check('one label beside the rings names each sigma in its ring\'s colour, with its value in metres',
    /row\(text\.psf, 'PSF', m\(psfXM, psfYM\)\)/.test(rings) && /row\(text\.geo, 'geo', `\$\{geoM\.toFixed\(2\)\} m`\)/.test(rings)
    && /row\(text\.eff, 'eff', geoM > 0 \? m\(effXM, effYM\) : '= PSF'\)/.test(rings)
    && (rings.match(/<LTooltip /g) || []).length === 1 && /<LTooltip permanent direction="left"/.test(rings));
  check('with no geolocation error there is one ring, and it says the two are the same',
    /\{geoM > 0 && <Polygon positions=\{ring\(geoM, geoM\)\}/.test(rings) && /geoM > 0 \? row\(text\.geo, 'geo'/.test(rings));
  // Leaflet thins a path as it gets small on screen: a ring a few pixels across came out an octagon.
  check('the rings are drawn as traced, never thinned to a polygon, every one of the five',
    (rings.match(/smoothFactor=\{0\}/g) || []).length === 5 && (rings.match(/<Polygon /g) || []).length === 5);
  // The Pure pixels veil is at 440: under it the rings were dimmed with the pixels.
  check('they are drawn above the overlay, the pure-pixel veil and the selection',
    /<Pane name="sigmas" style=\{\{ zIndex: 470 \}\}>/.test(map));
}

// The blur overlays go to the pixel that is clicked. They sat on the pixel
// nearest the middle of the field, which is rarely the one being looked at.
{
  const map = read('src/pixel-grid/FieldMap.tsx');
  const layers = read('src/pixel-grid/map-layers.tsx');
  const gridHook = read('src/pixel-grid/use-grid.ts');
  check('a click on the map is picked up only while an overlay that sits on one pixel is on, and never while drawing',
    /const blurOn = \(showPsf \|\| showSigmas\) && !!build && psfSigmaM > 0;/.test(map)
    && /const pickOn = blurOn \|\| srcOn;/.test(map)
    && /\{pickOn && !drawMode && <PixelPicker onPick=\{pickPixel\} \/>\}/.test(map)
    && /useMapEvents\(\{ click: e => onPick\(\[e\.latlng\.lat, e\.latlng\.lng\]\) \}\)/.test(layers));
  check('both overlays follow it, because they share the one centre',
    /<PsfOverlay center=\{psfCenter\}/.test(map) && /<SigmaRings center=\{psfCenter\}/.test(map)
    && /const picked = pickedPoint && pixelCentreAt\(pickedPoint\[1\], pickedPoint\[0\], build\.epsg, build\.utmBounds, build\.res\);\s*if \(picked\) return picked;/.test(gridHook));
  // A centre remembered from one lattice sits between two pixels of another.
  check('what is kept is the point clicked, read again against the grid in force',
    /const \[pickedPoint, pickPixel\] = useState<\[number, number\] \| null>\(null\);/.test(gridHook)
    && /\}, \[aoi, build\?\.utmBounds, build\?\.epsg, build\?\.res, pickedPoint\]\);/.test(gridHook));
  check('with every such overlay off the pick is forgotten, so the next one starts from the middle of the field',
    /useEffect\(\(\) => \{ if \(!pickOn\) pickPixel\(null\); \}, \[pickOn, pickPixel\]\);/.test(map));
  check('the pointer says a pixel can be picked, and the switches say what a click does',
    /box\.style\.cursor = 'crosshair';/.test(layers) && /return \(\) => \{ box\.style\.cursor = was; \};/.test(layers)
    && (map.match(/click a pixel to move (it|them) there/g) || []).length === 3);
}

// Where a pixel's purity comes from, as a picture. The circle that holds 90 %
// of a pixel's signal was read as the whole signal, so a circle that stuck out
// of its plot looked like it contradicted a purity of 90 %: the tenth beyond
// the circle is thin, spread wide, and on a pixel near a border much of it is
// still on its own plot. The dots give every part of the signal the same
// weight, in the colour of what it lands on, and a card lists the shares.
{
  const map = read('src/pixel-grid/FieldMap.tsx');
  const layers = read('src/pixel-grid/map-layers.tsx');
  const shell = read('src/pixel-grid/PixelGridApp.tsx');
  const engine = read('src/pixel-grid/simulate.ts');
  const src = read('src/pixel-grid/signal-sources.ts');
  const dots = layers.slice(layers.indexOf('function SignalDots'), layers.indexOf('function PixelPicker'));
  const card = map.slice(map.indexOf('function SourcesCard'), map.indexOf('export function FieldMap'));
  check('Layers has a switch for it, saved like the others, that needs the simulation it explains',
    /\{ label: 'Signal of a pixel', on: showSources && simOn, flip: \(\) => setShowSources\(v => !v\), off: !build \|\| !simOn,/.test(map)
    && /usePersistentState\('showSources', false, isBool\)/.test(shell) && /showSources=\{showSources\} setShowSources=\{setShowSources\}/.test(shell)
    && /const srcOn = showSources && simOn && !!renderGrid && !!patternOrigin && !\(renderGrid\.stride && renderGrid\.stride > 1\);/.test(map));
  // A second way of working the shares out would sooner or later print another figure than the pointer's.
  check('the shares are the engine\'s own, for the pixel the other overlays sit on',
    /pixelSources\(renderGrid, origin, layout, sensor, at\.i, at\.j, SOURCE_DOTS\)/.test(map)
    && /const at = pixelIndexAt\(renderGrid, psfCenter\[0\], psfCenter\[1\]\);/.test(map)
    && /export function pixelSources\(/.test(engine) && /importedPixelCovers\(imported, wE, wN, wx, wy, res\)/.test(engine)
    && /buildCropMap\(wE, wN, wy \* g, cols, res \/ g, patternOrigin\[0\], patternOrigin\[1\], layout\)/.test(engine));
  check('a thousand dots, so that one dot is a tenth of a percent, and the card says so',
    /export const SOURCE_DOTS = 1000;/.test(src) && /One dot is \{100 \/ SOURCE_DOTS\} % of the signal\./.test(card));
  check('the dots are canvas markers added by hand, never one React element each',
    /L\.circleMarker\(\[lat, lng\], \{ \.\.\.first, pane, fillColor: colorOf\[sources\.dotCover\[m\]\], fillOpacity: 1, interactive: false \}\)\.addTo\(group\)/.test(dots)
    && !/<CircleMarker/.test(dots) && /return \(\) => \{ map\.off\('zoomend', resize\); group\.remove\(\); \};/.test(dots));
  check('their size follows the zoom, from the ground between two dots where they are densest',
    /0\.36 \* sources\.spacingM \* pxPerM/.test(dots) && /map\.on\('zoomend', resize\)/.test(dots));
  check('they sit over the overlay and the haze, under the rings, and not while a field is drawn',
    /<Pane name="sources" style=\{\{ zIndex: 465 \}\}>/.test(map) && /\{signal && !drawMode && \(\s*<SignalDots /.test(map)
    && /\{signal && !drawMode && \(\(\) => \{/.test(map) && /<SourcesCard rows=\{signal\.rows\} threshold=\{threshold\} low=\{!!at && at\.x < 330 && at\.y < 250\} \/>/.test(map));
  check('the cover the purity is counted on is one colour whatever it is, and no dot is a crop colour',
    /const color = q === 0 \? SOURCE_COLORS\.own/.test(src) && /id === BARE\.id \? SOURCE_COLORS\.bare/.test(src) && /id === OFF_TRIAL\.id \? SOURCE_COLORS\.off/.test(src)
    && !/CROP_COLORS/.test(src));
  // 90.39 % under the pointer and 90.4 % on the card would be two purities for one pixel.
  check('the first line is the purity, cut as the figure under the pointer is',
    /q === 0 \? purityText\(Math\.fround\(r\.share\)\) : shareText\(r\.share\)/.test(card) && /The first line is the purity, the mark the \{threshold\} % it must reach\./.test(card));
  check('the bar carries a mark at the threshold, so pure or not is read off it',
    /style=\{\{ left: `\$\{threshold\}%` \}\}/.test(card));
  // Fixed in a corner, the card sat on the dots of any pixel picked there.
  check('the card lets the pointer through, and leaves its corner when the pixel is in it',
    /<div className=\{`pointer-events-none absolute z-\[1000\] /.test(card) && /\$\{low \? 'bottom-8 right-2' : 'left-14 top-3'\}/.test(card)
    && /mapRef\.current\.latLngToContainerPoint\(psfCenter\)/.test(map));
  check('past six covers the smallest are one line, and their dots take its colour',
    /const alone = covers\.length > maxRows \? Math\.max\(1, maxRows - 1\) : covers\.length;/.test(src)
    && /const colorOf: string\[\] = new Array\(256\)\.fill\(SOURCE_COLORS\.rest\);/.test(src));
}

// Broken rings with the three sigmas: where 90 % of the signal comes from.
// One sigma holds 39 % of a round spot, so the solid rings alone read as a much
// tighter footprint than a pixel has. Each is a plain Gaussian's own 90 %
// distance, 2.146 of its sigma, so that it is checked by hand: one WITHOUT the
// CE90 (sigma_PSF, what the sensor receives pointing at the pixel's centre, and
// what the purity goes with) and one WITH it (sigma_eff, over many images).
{
  const map = read('src/pixel-grid/FieldMap.tsx');
  const layers = read('src/pixel-grid/map-layers.tsx');
  const rings = layers.slice(layers.indexOf('function SigmaRings'), layers.indexOf('function SignalDots'));
  check('the 90 % ring without the CE90 is the Gaussian\'s: sqrt(2 ln 10) sigma_PSF on each axis',
    /const K90 = Math\.sqrt\(-2 \* Math\.log\(0\.1\)\);\s*const r90X = K90 \* psfXM, r90Y = K90 \* psfYM;/.test(rings));
  check('the one with the CE90 is the same of sigma_eff',
    /const e90X = K90 \* Math\.hypot\(psfXM, geoM\), e90Y = K90 \* Math\.hypot\(psfYM, geoM\);/.test(rings));
  check('the pixel footprint is in neither', !/signalRadius/.test(layers) && !/pixelM/.test(rings) && !/pixelM=/.test(map));
  check('both are drawn broken so that neither is read as a sigma, the one with the CE90 in the colour of sigma_eff',
    /<Polygon positions=\{ring\(r90X, r90Y\)\} smoothFactor=\{0\}\s*pathOptions=\{\{ color: light \? '#0f172a' : '#f8fafc', weight: 2, dashArray: '7 6'/.test(rings)
    && /\{geoM > 0 && <Polygon positions=\{ring\(e90X, e90Y\)\} smoothFactor=\{0\}\s*pathOptions=\{\{ color: line\.eff, weight: 2, dashArray: '7 6'/.test(rings));
  check('each is named in the label, with or without the CE90, and its radius in metres',
    /90 % of signal\{geoM > 0 \? ', without CE90:' : ' within'\} \{m\(r90X, r90Y\)\}/.test(rings)
    && /\{geoM > 0 \? <div style=\{\{ color: text\.eff \}\}>90 % of signal, with CE90: \{m\(e90X, e90Y\)\}<\/div> : null\}/.test(rings));
  // The label hung off the sigma_eff ring, which the wider rings now cross.
  check('the label hangs off the outermost ring', /<CircleMarker center=\{at\(-e90X, 0\)\}/.test(rings));
}

// The angle a design had before the aligned placement was adopted from the
// ladder. It was kept in memory only while the turn itself was saved, so a
// refresh brought back a trial turned to the pixel rows with one ladder, "vs
// aligned" greyed out, and nothing left of the angle it had been turned from.
{
  const shell = read('src/pixel-grid/PixelGridApp.tsx');
  const pca = read('src/pixel-grid/steps/PcaStep.tsx');
  check('the angle a design was turned from is saved, with the kind of design it was and the angle it was turned to',
    /usePersistentState<\{ deg: number; imported: boolean; to\?: number \} \| null>\('compareFrom', null,/.test(shell)
    && !/const \[compareFrom, setCompareFrom\] = useState/.test(shell));
  check('it counts only while that kind of design still sits at that angle, read from the angle on screen',
    /const angleShown = importedNow \? \(pendingAngle \?\? exp\.importedAngle\) : exp\.rotation;/.test(shell)
    && /const compareFrom = turnedFrom && sameAngle\(angleShown, turnedFrom\.to\) && !sameAngle\(turnedFrom\.deg, turnedFrom\.to\) \? turnedFrom\.deg : null;/.test(shell)
    && /const sameAngle = \(p: number, q: number\) => alignedWithin\(p - q, 0\.05\);/.test(shell));
  // The file's own angle needs no remembering: a trial aligned before the angle was kept still has one.
  check('an imported trial found along the pixel rows is compared with the file\'s angle when nothing was remembered',
    /const fileFrom = importedNow && exp\.importedTurn !== 0 \? \{ deg: exp\.importedFileAngle, to: 0 \} : null;/.test(shell)
    && /const turnedFrom = adopted && adopted\.imported === importedNow \? \{ deg: adopted\.deg, to: adopted\.to \?\? 0 \} : fileFrom;/.test(shell));
  check('another trial, or none, forgets it: it was the angle of the one before',
    (shell.match(/setAdopted\(null\);/g) || []).length === 2
    && /const setAngleByHand = \(deg: number\) => \{ setCompareFrom\(null\); importApi\.setAngle\(deg\); \};/.test(shell));
  check('the step that turns the trial also offers the way back to the file\'s angle',
    /const turned = imported && importedTurn !== 0;/.test(pca)
    && /\{turned && \(\s*<button type="button" onClick=\{\(\) => p\.setAngleByHand\(importedFileAngle\)\}/.test(pca) && /as in file/.test(pca));
}

// An imported trial is compared with its BEST placement, not with itself
// along the pixel rows. Lying along them is one placement among others: a
// real trial of 14.2 by 15.5 m plots on 2 m pixels keeps 627 pure pixels
// along the rows, 648 as drawn and 698 at 45 degrees.
{
  const shell = read('src/pixel-grid/PixelGridApp.tsx');
  const pca = read('src/pixel-grid/steps/PcaStep.tsx');
  const sim = read('src/pixel-grid/steps/SimStep.tsx');
  const hook = read('src/pixel-grid/use-simulation.ts');
  const rung = read('src/pixel-grid/ladder-step.ts');
  const turn = read('src/pixel-grid/imported-rotate.ts');
  const table = read('src/pixel-grid/ResTable.tsx');
  check('the right-hand ladder of an imported trial is the best placement at each size, found by the search',
    /if \(!asDrawn && importedBasePlan\) \{/.test(rung) && /const best = search\.found!;/.test(rung)
    && /placement = \{ turn: best\.turn, shift: best\.shift, angle: best\.angle, searched: best\.searched \};/.test(rung));
  // With a geolocation error the page judges a placement on the pixels that hold within the CE90.
  check('searched on the figure the ladder leads with: the CE90 of that size, when one is set',
    /placementSearch\(ctx\.importedBasePlan, rung\.res, \{ sigmaX: rung\.sigmaX, sigmaY: rung\.sigmaY, mixThreshold: ctx\.threshold \/ 100 \},\s*Math\.round\(ce90For\(ctx\.geoAuto, ctx\.geoManual, rung\.res\) \* 100\) \/ 100\)/.test(rung)
    && /lands\.length\s*\? heldPixels\(plan, r, sensor, ce90\)/.test(turn));
  check('the engine has the last word, and the trial as drawn is always one of the placements it is asked about',
    /const asked: \{ turn: number; shift: \[number, number\] \}\[\] = \[\{ turn: 0, shift: \[0, 0\] \}\];/.test(turn)
    && /const pure = score\(plan\);\s*if \(!won \|\| pure > won\.pure\)/.test(turn));
  // The whole search is seconds at the finest sizes: never in one piece.
  check('the sweep runs the search a slice per task, and the rung only reads its answer',
    /if \(search && !search\.step\(\)\) \{ i--; worked = true; continue; \}/.test(hook) && /function\* searchSteps\(/.test(turn));
  check('it is offered at any angle, the pixel rows\' included',
    /const wantAligned = compareAligned && \(layout\.pattern === 'imported' \? !!importedBasePlan : !alignedWithin\(angle, 0\.05\)\);/.test(hook)
    && /const aligned = !imported && alignedWithin\(angle, 0\.05\);/.test(pca) && /const aligned = !imported && alignedWithin\(angle, 0\.05\);/.test(sim)
    && /\{imported \? 'vs best' : 'vs aligned'\}/.test(pca) && /\{imported \? 'vs best' : 'vs aligned'\}/.test(sim));
  // Searching again on the click could land somewhere the rung never measured.
  check('a click on a rung puts the trial exactly where that rung measured it, with nothing searched again',
    /const place = sweepAligned\?\.find\(s => s\.id === id\)\?\.placement;/.test(pca)
    && /p\.setCompareFrom\(angle, place\.angle\);\s*p\.importApi\.setPlacement\(place\.turn, place\.shift\);/.test(pca)
    && /setPlacement: \(turn: number, shift: \[number, number\]\) => \{/.test(shell)
    && /const plan = shiftImportedPlan\(rotateImportedPlan\(base, turn\), shift\[0\], shift\[1\]\);/.test(shell));
  // A best placement is per size: a trial placed for 2 m and shown on 1 m is on neither ladder.
  check('the ladder marks the placement on the map only when it is one of its own',
    /const onMap: 0 \| 1 \| null = p\.compareFrom === null \? 0/.test(pca) && /placed\(sweepAligned\?\.find\(s => s\.id === sourceId\)\) \? 1 : null;/.test(pca)
    && /shown\?: 0 \| 1 \| null;/.test(table));
  check('each rung says at which angle its placement is, and whether one was searched for at all',
    /const anyPlace = pairWith\.some\(s => s\.placement\);/.test(table) && /place\.searched \? deg\(Math\.round\(place\.angle \* 10\) \/ 10\) : '·'/.test(table)
    && /not searched at this size/.test(table));
}

// The ladder's rows are satellites. They were nine pixel sizes, all under the
// blur of whichever sensor was selected: a 3 m row was PlanetScope's pixel
// under Sentinel-2's optics, or the reverse, which nobody can task.
{
  const sensors = read('src/pixel-grid/sensors.ts');
  const hook = read('src/pixel-grid/use-simulation.ts');
  const pca = read('src/pixel-grid/steps/PcaStep.tsx');
  const table = read('src/pixel-grid/ResTable.tsx');
  const sweepView = read('src/pixel-grid/PcaSweep.tsx');
  check('one row per satellite of the list, finest pixels first, a custom sensor only while it is in use',
    /function ladderRungs\(current: \{ id: string; res: number; sigmaX: number; sigmaY: number \}\): Rung\[\]/.test(sensors)
    && /if \(src\.id === 'custom' && !here\) continue;/.test(sensors) && /sort\(\(a, b\) => a\.r\.res - b\.r\.res \|\| a\.k - b\.k\)/.test(sensors));
  check('each at its own pixel size and blur, the one selected as it stands on the page',
    /\{ id: src\.id, name: src\.short, res: current\.res, sigmaX: current\.sigmaX, sigmaY: current\.sigmaY \}/.test(sensors)
    && /\{ id: src\.id, name: src\.short, res: src\.res, sigmaX: src\.psf, sigmaY: src\.psf \}/.test(sensors)
    && /ladderRungs\(\{ id: gridApi\.sourceId, res: build\?\.res \?\? gridApi\.pxSize, sigmaX, sigmaY \}\)/.test(hook));
  // A click selects another satellite. Were a rung computed from the sensor selected, every click would rebuild the ladder.
  check('a rung is computed from its own satellite, never from the sensor selected, so a click rebuilds nothing',
    /const sensorL: SensorParams = \{ sigmaX: rung\.sigmaX, sigmaY: rung\.sigmaY, mixThreshold: threshold \/ 100 \};/.test(read('src/pixel-grid/ladder-step.ts'))
    && /\[aoi, fieldRing, build\?\.epsg, ladderSig, threshold, ce90At\]\);/.test(hook)
    && /\(ladderCtx \? ladderStep\(ladderCtx, rotationDeg, rung, asDrawn\) : null\), \[ladderCtx\]\);/.test(hook)
    && /const rungKey = \(g: Rung\) => `\$\{g\.id\}\|\$\{g\.res\}\|\$\{g\.sigmaX\}\|\$\{g\.sigmaY\}`;/.test(hook)
    && /const key = `\$\{rot\}\|\$\{which\}\|\$\{rungKey\(g\)\}`;/.test(hook));
  check('a click on a row selects its satellite, pixel size and blur with it',
    /const pickSat = \(id: string\) => \{ if \(id !== sourceId\) setSourceId\(id\); \};/.test(pca));
  check('rows are told apart by satellite, never by pixel size: two satellites share 0.5 m, two share 30 m',
    !/Math\.abs\(s\.res - /.test(pca) && !/Math\.abs\(activeRes/.test(table) && !/activeRes/.test(sweepView)
    && /const twin = pairCharts\.find\(p => p\.id === c\.id\);/.test(sweepView) && /<React\.Fragment key=\{s\.id\}>/.test(table));
  check('a row names its satellite and the pixel size it was computed at',
    /\{s\.name\}<\/span>/.test(table) && /\{s\.res\} m\{s\.partial \?/.test(table) && /Across satellites/.test(pca));
}

console.log('\nU-speed. what keeps the page fast on a slow computer');
// Measured with the CPU slowed four times. Building the satellites table held
// the page for 23 s in slices of up to 2 s on a real trial; typing a plot size
// held it 2.4 s; a pan restyled and redrew every pixel. Each rule below is one
// of the reasons it no longer does, and none of them shows in a type check.
{
  const hook = read('src/pixel-grid/use-simulation.ts');
  const pool = read('src/pixel-grid/ladder-pool.ts');
  const worker = read('src/pixel-grid/ladder.worker.ts');
  const rung = read('src/pixel-grid/ladder-step.ts');
  const map = read('src/pixel-grid/FieldMap.tsx');
  const layers = read('src/pixel-grid/map-layers.tsx');
  const grid = read('src/pixel-grid/use-grid.ts');
  const lattice = read('src/pixel-grid/s2-grid.ts');
  const engine = read('src/pixel-grid/simulate.ts');
  const turn = read('src/pixel-grid/imported-rotate.ts');
  const card = read('src/pixel-grid/steps/PlotSize.tsx');
  const sim = read('src/pixel-grid/steps/SimStep.tsx');
  const pca = read('src/pixel-grid/steps/PcaStep.tsx');
  // The table is built away from the page, and on the page only where there are no workers.
  check('the satellites table is built in workers, and on the page only for a browser without them',
    /const pool = ladderCtx \? ladderPool\(\) : null;/.test(hook) && /if \(pool && !pool\.failed && ladderCtx\) \{/.test(hook)
    && /if \(gen === sweepGen\.current && pool\.failed\) setTimeout\(next, 0\);/.test(hook));
  check('a worker computes a rung with the function the page would run',
    /const step = ladderStep\(ctx, m\.rot, m\.rung, m\.asDrawn\);/.test(worker) && /export function ladderStep\(ctx: LadderContext, rotationDeg: number, rung: Rung, asDrawn = true\): SweepStep \{/.test(rung));
  check('one rung per worker at a time, so a design that moves on drops what was still waiting',
    /if \(slot\.job\) continue;/.test(pool) && /for \(const j of queue\.splice\(0\)\) j\.reject\(new Error\('stale'\)\);/.test(pool));
  check('a ladder that was overtaken commits nothing', /steps => \{ if \(gen === sweepGen\.current\) commit\(/.test(hook));
  check('the hook file does not reach the worker: a rung imports no React', !/from 'react'/.test(rung) && !/from '\.\/use-simulation'/.test(rung) && !/from '\.\/use-simulation'/.test(worker));
  // Counting needs verdicts only, and a pixel that cannot matter is not simulated.
  check('a placement search counts on the verdicts alone',
    /pureVerdictCount\(fieldVerdicts\(box, origin, \{ pattern: 'block'/.test(engine) && /pureVerdictCount\(fieldVerdicts\(box, \[ox0 \+ du, oy0 \+ dv\], layout, sensor\)\)/.test(engine)
    && /const verdicts = fieldVerdicts\(\{ res: r, utmBounds: \[e0, n0, e1, n1\] \} as unknown as S2Grid, \[0, 0\], layout, sensor, keep\);/.test(turn));
  check('the driver has its own path through the engine, and aggregate is still what it must equal',
    /const lean = leanAggregate\(grid, patternOrigin, layout, sensor, null, false\);\s*if \(!lean\) return simulateFieldReference\(/.test(engine)
    && /export function simulateFieldReference\(/.test(engine) && /export function aggregate\(/.test(engine));
  // The map: one identity per style, one feature per look.
  check('no overlay style is a function made in a render',
    !/<GeoJSON[^>]*style=\{\([^)]*\) =>/.test(map) && !/<GeoJSON[^>]*style=\{\([^)]*\) =>/.test(layers)
    && /style=\{pureStyle\}/.test(map) && /style=\{selectionStyle\}/.test(map) && /style=\{simSetStyle\}/.test(map) && /style=\{fieldOutlineStyle\}/.test(map));
  check('pixels that share a look are one feature, drawn in one stroke',
    /geometry: \{ type: 'MultiLineString', coordinates: rings \}/.test(lattice)
    && /gridOutline\(renderGrid\)/.test(grid) && /gridOutline\(renderGrid, inField\.mask\)/.test(grid)
    && /const lines = cellLines\(\{ lines: true as const \}, all\);/.test(hook)
    && /for \(const \[fill, rings\] of byColor\) fills\.push\(\.\.\.cellFills\(\{ fill \}, rings\)\);/.test(hook));
  // closePath slows with every sub-path already in the path: one polygon of
  // 15,000 squares held a pan for three seconds in that call alone.
  check('outlines are lines, never one polygon of thousands of rings, and fills come in small sets',
    /export const CELLS_PER_FILL = 64;/.test(lattice) && /rings\.slice\(i, i \+ CELLS_PER_FILL\)\.map\(ring => \[ring\]\)/.test(lattice)
    && !/type: 'MultiPolygon', coordinates: rings\.map/.test(lattice));
  check('Real field mode draws the simulation\'s own pixels, as one set', /const d = \(shownSim \? simCells : null\) \?\? \(fieldOnly \? fieldGeojson : null\) \?\? geojson;/.test(map));
  // The first paint waits for nothing it does not show.
  check('the plot-size card computes nothing in the render that first shows it', /const d = useDeferredValue\(inputs, null\);/.test(card) && /if \(!d \|\| !\(d\.a > 0\)/.test(card));
  check('the charting library is fetched when a chart is first shown, not with the page',
    /const SeasonChart = lazy\(\(\) => import\('\.\/SeasonChart'\)\);/.test(sim) && !/from 'recharts'/.test(sim)
    && /const PcaSimVisual = lazy\(\(\) => import\('\.\.\/PcaSimVisual'\)\);/.test(pca) && !/from 'recharts'/.test(pca));
  // On a slow line. Measured on DevTools' Slow 3G: ten seconds of an empty
  // page, and a stylesheet that could not be applied before Google's fonts and
  // unpkg had both answered.
  {
    const html = read('pixel-grid.html');
    const entry = read('src/pixel-grid/main.tsx');
    const css = read('src/index.css');
    check('the page says it is loading before its script has arrived',
      /<div id="root"><div class="boot"><b>Pixel Grid Designer<\/b><span>Loading<\/span><\/div><\/div>/.test(html) && /\.boot \{/.test(html));
    check('no third party stands before the first paint: Leaflet\'s stylesheet is bundled, ahead of the page\'s own',
      !/unpkg\.com/.test(html) && /import 'leaflet\/dist\/leaflet\.css';\s*import '\.\.\/index\.css';/.test(entry));
    check('and the fonts are fetched without holding the page',
      !/@import url\(/.test(css) && /fonts\.googleapis\.com\/css2[^"]*display=swap" media="print" onload="this\.media='all'"/.test(html)
      && /fonts\.googleapis\.com\/css2[^"]*display=swap" media="print" onload="this\.media='all'"/.test(read('index.html')));
    check('step 4\'s files are fetched once the page is up, so that it does not open on the network',
      /void import\('\.\/PcaSimVisual'\)/.test(entry) && /prefetchLadderWorker\(\);/.test(entry) && /window\.setTimeout\(later, 6000\);/.test(entry)
      && /new Worker\(ladderWorkerUrl, \{ type: 'module' \}\)/.test(pool) && /import ladderWorkerUrl from '\.\/ladder\.worker\?worker&url';/.test(pool));
    check('unless the reader asked their browser to save data', /if \(saving\) return;/.test(entry));
  }
  check('a season is built once per species for the chart, not once per day', /const seasons = speciesD\.map\(s => makeTruth\(s\.truth, TMAX, parsOf\(s\)\)\);/.test(hook) && !/truthAt\(/.test(hook));
}

console.log(bad ? `\n${bad} UI-CONTRACT CHECK(S) FAILED` : '\nALL UI-CONTRACT CHECKS PASSED');
process.exit(bad ? 1 : 0);
