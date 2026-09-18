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

console.log('\nU2. step 3 states a purity only when the whole field was measured');
const simStep = read('src/pixel-grid/steps/SimStep.tsx');
const useSim = read('src/pixel-grid/use-simulation.ts');
const ui = read('src/pixel-grid/ui.tsx');

// 1. The card's number comes from the whole-grid simulation, and from nothing else.
const fieldSimLine = (simStep.match(/^\s*const fieldSim =.*$/m) || [''])[0];
check('step 3 measures purity only when the WHOLE grid is simulated',
  /gridApi\.grid\s*\?\s*p?\.?sim\.sim\s*:\s*null/.test(fieldSimLine.replace(/\s+/g, ' ')),
  fieldSimLine.trim());
check('and takes no fallback from the PCA, which is unmounted while step 3 is open',
  fieldSimLine !== '' && !/pca/i.test(fieldSimLine),
  fieldSimLine.trim());

// 2. The premises that make such a fallback dead. If either changes, revisit 1.
const runEffect = useSim.slice(useSim.indexOf("if (activeStep !== 'pca'"));
check('usePcaSim drops its run as soon as the active step is not the PCA',
  /^if \(activeStep !== 'pca'[^\n]*setPcaRun\(null\)/.test(runEffect.split('\n')[0]));
check('pcaView is null without a run', /if \(!pcaRun\) return null;/.test(useSim));
check('Step unmounts a collapsed panel, so step 3 exists only while it is open',
  /\{open && <div/.test(ui));

// 3. Past the cap the card is silent, and the step says why rather than
//    dropping the row with no explanation.
const note = simStep.match(/\{build\?\.capped &&[\s\S]{0,600}?<\/p>\s*\)\}/);
check('a capped grid gets a line explaining the missing purity', !!note);
check('that line offers the two real ways out (step 4, a coarser sensor)',
  !!note && /Step&nbsp;4/.test(note[0]) && /coarser sensor/.test(note[0]));

// 4. The doc above fieldSim must not promise a fallback it does not take.
const doc = simStep.slice(0, simStep.indexOf('const fieldSim'));
check('the comment does not promise a PCA fallback',
  !/PCA runs on the field itself, so it is the fallback/.test(doc));

console.log('\nU3. the aligned-vs-drawn verdict reads the number it prints');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/pixel-grid/steps/PcaStep.tsx'), 'utf8');

  // (1) The ranking rule, lifted from the source and run, not reimplemented.
  const tie = Number(src.match(/const TIE_POINTS = ([\d.]+)\s*;/)[1]);
  const pred = src.match(/rows\.filter\((x => [^)]*?)\)\.map/)[1];
  const worse = new Function('TIE_POINTS', `return (${pred});`)(tie);
  ok('a point of purity is a tie, not a verdict',
    worse({ drawn: 50, aligned: 49.5 }) === false, `TIE_POINTS=${tie}`);
  ok('and a real drop is called worse', worse({ drawn: 50, aligned: 39 }) === true);

  // (2) Everything the rule reads must be printed in the sentence beside it.
  // This is the assertion that fails on the shipped bug, where the filter read
  // counts while the paragraph printed percentages, and on its first fix, where
  // it read counts and printed counts but the reader had asked for percentages.
  // The rule is not WHICH quantity, it is that they are the same quantity.
  const para = src.slice(src.indexOf('Pure pixels at {'));
  const sentence = para.slice(0, para.indexOf('</p>'));
  const ranked = [...new Set([...pred.matchAll(/x\.(\w+)/g)].map(m => m[1]))];
  const shown = new Set([...sentence.matchAll(/comparison\.first\.(\w+)/g)].map(m => m[1]));
  ok('every field the verdict ranks on is printed in the same sentence',
    ranked.length > 0 && ranked.every(f => shown.has(f)), `ranks on ${ranked.join(', ')}`);
  ok('and the panel shows those as percentages, which is what was asked for',
    /comparison\.first\.drawn\.toFixed\(0\)\}%/.test(sentence) &&
    /comparison\.first\.aligned\.toFixed\(0\)\}%/.test(sentence), [...shown].join(', '));

  // (3) The margin in the words is the margin in the rule. A hand-typed figure is
  // how the doc comment came to describe a rule that had already been replaced.
  ok('the tie margin the panel prints comes from the constant it ranks with',
    /\$\{TIE_POINTS\}/.test(sentence) && !/\b3%/.test(sentence));

  // (4) Two shares over two different totals: the reader can only see why they
  // are not strictly comparable if both denominators are on screen.
  ok('both trial totals reach the sentence, and only together',
    shown.has('drawnTotal') && shown.has('alignedTotal') &&
    /Number\.isFinite\(comparison\.first\.drawnTotal\) && Number\.isFinite\(comparison\.first\.alignedTotal\)/.test(sentence));
  ok('and the ladder panels are labelled with the same quantity, a percentage',
    /c\.purePct\.toFixed\(0\)\}%/.test(fs.readFileSync(path.join(ROOT, 'src/pixel-grid/PcaSweep.tsx'), 'utf8')));
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


console.log(bad ? `\n${bad} UI-CONTRACT CHECK(S) FAILED` : '\nALL UI-CONTRACT CHECKS PASSED');
process.exit(bad ? 1 : 0);
