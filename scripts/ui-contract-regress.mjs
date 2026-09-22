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
  check('the ladder computes a geolocation range for each rung', /geoLo, geoHi/.test(useSim2) && /shiftSamples\(geoErrM, r, GEO_LADDER_N\)/.test(useSim2));
  check('only when an uncertainty is set, so it costs nothing by default', /if \(geoErrM > 0 && resolvingPct != null\)/.test(useSim2));
  check('every sample goes through the SAME share rule as the rung it qualifies',
    (useSim2.match(/plantedShare\(/g) || []).length >= 2 && !/0\.8 \* geo/.test(useSim2));
  check('each panel prints the range, and says so when it does not move',
    /c\.geoLo\.toFixed\(0\)\}-\$\{c\.geoHi\.toFixed\(0\)\}% \$\{where\}/.test(sweepSrc) && /no change \$\{where\}/.test(sweepSrc));
  // Past half a pixel every sub-pixel position is reachable, so 5, 12.5 and 50 m
  // give one identical range at 10 m pixels. Naming the figure there reads as
  // the setting being ignored, which is what it looked like to the first person
  // who typed a big number in.
  check('and stops naming a figure once any phase is reachable',
    /const anyPhase = geoErrM >= c\.res \/ 2;/.test(sweepSrc) && /wherever it lands/.test(sweepSrc));
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

  // (2) Everything the rules read must be printed in the sentence beside them.
  // The rule is not WHICH quantity, it is that they are the same quantity.
  const para = src.slice(src.indexOf('Pure crop at {'));
  const sentence = para.slice(0, para.indexOf('</p>'));
  const ranked = [...new Set([...`${betterSrc} ${worseSrc}`.matchAll(/x\.(\w+)/g)].map(m => m[1]))];
  const shown = new Set([...sentence.matchAll(/comparison\.lead\.(\w+)/g)].map(m => m[1]));
  ok('every field the verdict ranks on is printed in the same sentence',
    ranked.length > 0 && ranked.every(f => shown.has(f)), `ranks on ${ranked.join(', ')}`);
  ok('and they are printed as the percentages the panels show',
    /comparison\.lead\.drawn\.toFixed\(0\)\}%/.test(sentence) &&
    /comparison\.lead\.aligned\.toFixed\(0\)\}%/.test(sentence), [...shown].join(', '));

  // (3) The sentence can actually SAY better, not only "behind".
  ok('the sentence has a branch that says the aligned placement gives more',
    /comparison\.better\.length > 0/.test(sentence) && /gives more/.test(sentence));

  // (4) The margin in the words is the margin in the rule.
  ok('the tie margin the panel prints comes from the constant it ranks with',
    /\$\{TIE_POINTS\}/.test(sentence) && !/\b3%/.test(sentence));

  // (5) The counts, both or neither, in the units the panels show. Trial-pixel
  // totals used to be printed here, a THIRD denominator beside shares over
  // planted crop, which is the currency mix this page has shipped twice.
  ok('both pure counts reach the sentence, and only together',
    shown.has('drawnPure') && shown.has('alignedPure') &&
    /Number\.isFinite\(comparison\.lead\.drawnPure\) && Number\.isFinite\(comparison\.lead\.alignedPure\)/.test(sentence));
  ok('and no trial-pixel total is quoted beside the shares', !/trial pixels/.test(sentence));

  // (6) It leads with the size where the placements differ most.
  ok('the headline pair is the one that differs most, not merely the first',
    /rows\.reduce\(\(a, b\) => \(Math\.abs\(b\.aligned - b\.drawn\) > Math\.abs\(a\.aligned - a\.drawn\)/.test(src));

  // (7) Sampled rungs are judged too. Excluding them, together with the rung on
  // the map, hid every informative size on a large field and left a 0% against
  // 0% pair as the whole verdict beneath panels reading 38% against 67%.
  ok('sampled rungs are not thrown out of the comparison',
    !/own\.partial \|\| al\.partial\) return \[\]/.test(src) && /sampled: !!\(own\.partial \|\| al\.partial\)/.test(src));
  ok('nor is the rung currently on the map', !/own\.current \|\|/.test(src));
  ok('and a sampled headline pair says it was sampled', /comparison\.lead\.sampled \?/.test(sentence));

  // (8) With a geolocation error set it judges the WORST cases. The nominal is
  // one draw, and for a staked placement it is the lucky draw by construction:
  // on a 50 m plot trial at 10 m the verdict called staking better on 182
  // against 225 pure pixels where the worst cases were 177 against 180.
  ok('with a geolocation error it ranks the worst cases, not the nominals',
    /const worstCase = geoErrM > 0;/.test(src) &&
    /if \(worstCase\) \{[\s\S]{0,200}drawn: own\.geoLo, aligned: al\.geoLo/.test(src));
  ok('and prints the worst-case pure counts, not the nominal ones',
    /drawnPure: own\.geoLoPure \?\? NaN, alignedPure: al\.geoLoPure \?\? NaN/.test(src));
  ok('a rung whose range is missing is left out, never judged on its nominal among worst cases',
    /if \(own\.geoLo == null \|\| al\.geoLo == null\) return \[\];/.test(src));
  ok('the sentence says which basis it compared on, and shows the best case beside it',
    /counting on the worst case \{geoErrM >= comparison\.lead\.res \/ 2/.test(sentence) && /at best \{comparison\.lead\.drawnBest/.test(sentence));
  ok('and when staking wins nothing it can count on, it says so',
    /staking onto the grid buys nothing you can count on/.test(sentence));

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


console.log(bad ? `\n${bad} UI-CONTRACT CHECK(S) FAILED` : '\nALL UI-CONTRACT CHECKS PASSED');
process.exit(bad ? 1 : 0);
