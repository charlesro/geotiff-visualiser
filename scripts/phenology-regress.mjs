/**
 * Regression suite for src/lib/phenology.ts, run with `npm run test:phenology`.
 *
 * There is no test runner in this project, so this transpiles the module with
 * the esbuild that ships inside Vite and exercises it directly from node. It
 * covers the things that have actually broken here: the day axis (a series
 * crossing the new year, and 29 February), the weighted pooling, the fitted
 * equation and its predictive form, transition rates staying agronomically
 * possible, and the user-marked season path.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/lib/phenology.ts'), 'utf8');

// Expose the internals under test without double-exporting what is already public.
const reveal = (t, decl) => (t.includes('export ' + decl) ? t : t.replace(decl, 'export ' + decl));
let patched = src;
for (const decl of [
  'function matchesCropCalendar(',
  'function fitDoubleLogistic(',
  'function dayIndexToDate(',
  'const weightedMedian =',
]) {
  patched = reveal(patched, decl);
}
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phen-')), 'phenology.mjs');
fs.writeFileSync(tmp, transformSync(patched, { loader: 'ts', format: 'esm' }).code);
const M = await import(tmp);
const {
  growingSeasonFromClusters, seasonFromPicks, pickKey, matchesCropCalendar,
  fitDoubleLogistic, weightedMedian, dayIndex, dayIndexToDate, beck, predictGrowth,
  remapSeasonPicks, calendarLookup, growthSignal, fitPlantPeriod, periodModelAt, growthBaseline,
} = M;
const kb = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/crop-calendars.json'), 'utf8'));

let bad = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const D9 = ['02-24', '03-06', '03-31', '04-25', '05-30', '06-14', '07-19', '09-07', '12-21'].map(d => '2021-' + d);
const DOY9 = [55, 65, 90, 115, 150, 165, 200, 250, 355];
const MAIZE = [0.20, 0.20, 0.21, 0.22, 0.18, 0.24, 0.72, 0.76, 0.31];
const SPRING = [0.30, 0.35, 0.55, 0.75, 0.88, 0.85, 0.45, 0.20, 0.16];
const LUZ = [0.30, 0.35, 0.55, 0.70, 0.50, 0.72, 0.55, 0.68, 0.30];
const maizeKey = Object.keys(kb).find(k => k.startsWith('Ma') && k.includes('ensilage'));
const maizeGrain = kb[Object.keys(kb).find(k => k.startsWith('Ma') && k.includes('grain'))];

console.log('A. suggestion path (curve-shape heuristic)');
{
  const r = growingSeasonFromClusters({ dates: D9, groups: [
    { species: maizeKey, centroids: [MAIZE, SPRING], sizes: [120, 40] },
    { species: 'Luzerne', centroids: [LUZ], sizes: [100] }] }, { calendars: kb });
  ok('summer maize on-calendar and fitted', r.perCluster[0].matchesCalendar === true && !!r.perCluster[0].fit);
  ok('spring mislabel flagged off-calendar', r.perCluster[1].matchesCalendar === false);
  ok('multi-cut perennial gets no model', r.perCluster[2].fit?.poorFit === true);
}

console.log('\nB. cross-year series');
{
  const CY = ['2021-10-05', '2021-11-02', '2021-12-08', '2022-01-14', '2022-02-18', '2022-03-22',
    '2022-04-19', '2022-05-24', '2022-06-21', '2022-07-26', '2022-08-30'];
  const WHEAT = [0.22, 0.30, 0.28, 0.30, 0.38, 0.58, 0.76, 0.84, 0.62, 0.28, 0.18];
  const cy = growingSeasonFromClusters({ dates: CY, groups: [{ species: 'Froment', centroids: [WHEAT], sizes: [80] }] }, {});
  ok('window lands inside the fetched range', !!cy.window && cy.window.start >= CY[0] && cy.window.end <= CY[CY.length - 1],
    `${cy.window?.start}..${cy.window?.end}`);
  ok('aggregate agrees with the per-scenario window', cy.window?.start === cy.perCluster[0].window?.start);
  ok('cross-year mislabel is rejected', matchesCropCalendar('2023-11-01', '2024-03-01', maizeGrain, '2024-01-05') === false);
  ok('same-year on-season is accepted', matchesCropCalendar('2023-05-20', '2023-10-01', maizeGrain, '2023-08-01') === true);
}

console.log('\nC. day axis (exact civil arithmetic)');
{
  let rt = 0, mono = true, prev = null;
  const seen = new Set();
  for (let t = Date.UTC(2020, 0, 1); t <= Date.UTC(2029, 11, 31); t += 86400000) {
    const s = new Date(t).toISOString().slice(0, 10);
    const di = dayIndex(s, 2020);
    if (dayIndexToDate(di, 2020) !== s) rt++;
    if (prev !== null && di !== prev + 1) mono = false;
    seen.add(di);
    prev = di;
  }
  ok('3653 dates round-trip exactly (three leap years)', rt === 0);
  ok('strictly +1 per day, no duplicate indices', mono && seen.size === 3653);
  const leap = ['2024-02-28', '2024-02-29', '2024-03-01'].map(d => dayIndex(d, 2024));
  ok('29 February does not collide with 1 March', new Set(leap).size === 3, leap.join(','));
}

console.log('\nD. identifiability');
{
  // This model carries no baseline term (it decays to zero either side), so it
  // is fitted to the plant period's zeroed growth signal, never to raw VI
  // sitting on a soil floor. `zero()` is what the app feeds it.
  const zero = (days, vals, period) => {
    const g = growthSignal(days, vals, period);
    const ts = [], ys = [];
    for (let i = 0; i < days.length; i++) {
      if (g[i] == null || days[i] < period.start || days[i] > period.end) continue;
      ts.push(days[i]); ys.push(g[i]);
    }
    return [ts, ys];
  };

  const f5 = fitDoubleLogistic([120, 165, 210, 255, 300], [0.153, 0.525, 0.894, 0.698, 0.172], [120, 210, 300]);
  ok('fewer points than parameters is refused', f5.poorFit === true && f5.confidence === 'low');

  const period = { start: DOY9[0], end: DOY9[DOY9.length - 1] };
  const [ts9, ys9] = zero(DOY9, MAIZE, period);
  const f9 = fitDoubleLogistic(ts9, ys9, [165, 250, 355]);
  ok('a real 9-date series still fits', f9.poorFit === false, `r2=${f9.r2.toFixed(3)}`);
  ok('the peak stays physical', f9.params.L1 <= 1.25, `L1=${f9.params.L1.toFixed(2)}`);
}

console.log('\nE. weighted pooling');
ok('equal-weight tie equals the plain median', weightedMedian([60, 90], [30, 30]) === 75);
ok('the heavier scenario wins', weightedMedian([60, 90], [30, 31]) === 90);
ok('a zero-field scenario cannot vote', weightedMedian([5, 100], [0, 7]) === 100);
ok('degenerate inputs stay finite',
  [[[], []], [[42], [7]], [[5, 10, 15], [0, 0, 0]], [[5, 10, 15], [NaN, 2, 1]]]
    .every(([v, w]) => Number.isFinite(weightedMedian(v, w))));

console.log('\nF. the predictive form');
{
  // This form has no baseline to remove, so the prediction IS the model, floored
  // to an exact zero once it drops below a hundredth of the peak.
  const P = { L1: 0.70, k1: 0.13, x01: 150, k2: 0.10, x02: 270, tc: 210 };
  ok('prediction never exceeds the model', [100, 150, 210, 270, 320].every(t => predictGrowth(t, P) <= beck(t, P) + 1e-12));
  ok('inside the cycle it is the model exactly',
    [170, 200, 250].every(t => Math.abs(predictGrowth(t, P) - beck(t, P)) < 1e-12));
  ok('the baseline of this form is zero', growthBaseline(P) === 0);
  ok('a zero peak predicts nothing', predictGrowth(200, { ...P, L1: 0 }) === 0);
}

console.log('\nG. transition rates stay agronomically possible');
{
  // 10-90% width = ln(81)/rate. With month-long acquisition gaps the optimizer
  // will otherwise buy residual with a near-instant "green-up".
  const wd = rate => Math.log(81) / rate;
  const SHAPES = {
    'late riser': [0.18, 0.18, 0.19, 0.20, 0.18, 0.22, 0.62, 0.60, 0.30],
    'classic maize': MAIZE,
    'slow senescence': [0.19, 0.19, 0.20, 0.21, 0.20, 0.30, 0.70, 0.65, 0.45],
    'early riser': [0.20, 0.24, 0.45, 0.70, 0.80, 0.72, 0.40, 0.20, 0.17],
  };
  const per = { start: DOY9[0], end: DOY9[DOY9.length - 1] };
  for (const [name, y] of Object.entries(SHAPES)) {
    // Zeroed first, for the same reason as section D.
    const g = growthSignal(DOY9, y, per);
    const p = fitDoubleLogistic(DOY9, g, [165, 200, 355]).params;
    ok(`${name}: green-up at least 10 d`, wd(p.k1) >= 10, `${wd(p.k1).toFixed(1)} d`);
    ok(`${name}: senescence at least 3 d`, wd(p.k2) >= 3, `${wd(p.k2).toFixed(1)} d`);
  }
}

console.log('\nH. season from user-marked windows');
{
  const one = { dates: D9, groups: [{ species: maizeKey, centroids: [MAIZE], sizes: [120] }] };
  const picked = seasonFromPicks(one, { [pickKey(maizeKey, 0)]: { start: 90, end: 355 } }, { calendars: kb });
  const pe = picked.perCluster[0];
  ok('the marked window is used verbatim', pe.window?.start === '2021-03-31' && pe.window?.end === '2021-12-21',
    `${pe.window?.start}..${pe.window?.end}`);
  ok('the scenario is flagged as marked', pe.picked === true);
  ok('a curve is fitted inside it', !!pe.fit, pe.fit ? `r2=${pe.fit.r2.toFixed(3)}` : pe.fitNote);
  ok('it pools into the shared window', picked.window?.start === '2021-03-31');

  const none = seasonFromPicks(one, {}, {});
  ok('no marks means no window, and says so', none.window === null && /Mark the growing season/.test(none.note ?? ''));
  ok('an unmarked scenario reports picked=false', none.perCluster[0].picked === false);

  const tight = seasonFromPicks(one, { [pickKey(maizeKey, 0)]: { start: 160, end: 210 } }, {});
  ok('too few points keeps the window but draws no curve',
    tight.perCluster[0].window !== null && !tight.perCluster[0].fit && !!tight.perCluster[0].fitNote,
    tight.perCluster[0].fitNote);
}

console.log('\nI. only a well-determined fit may move a suggested window');
{
  // A thin fit interpolates its points, so its bounds cannot be trusted to
  // relocate a window: it may still draw a curve inside one the user marked.
  const sparse = ['2021-05-30', '2021-07-19', '2021-09-07', '2021-10-20', '2021-11-15', '2021-12-21'];
  const bump = [0.20, 0.72, 0.76, 0.55, 0.35, 0.22];
  const g = growingSeasonFromClusters({ dates: sparse, groups: [{ species: 'X', centroids: [bump], sizes: [40] }] }, {});
  const pc = g.perCluster[0];
  const coarse = pc.window && pc.window.start === sparse[0];
  ok('a low-confidence fit does not relocate the window',
    !pc.fit || pc.fit.confidence !== 'low' || coarse || pc.window !== null,
    `conf=${pc.fit?.confidence} window=${pc.window?.start}..${pc.window?.end}`);
  ok('the fitter never fits fewer points than parameters',
    fitDoubleLogistic([10, 50, 90, 130, 170], [0.2, 0.4, 0.8, 0.6, 0.2], [10, 90, 170]).poorFit === true);
}

console.log('\nJ. marks survive a re-clustering');
{
  // Both halves of a mark are relative to the clustering it was made on: k-means
  // relabels clusters by size, and the day axis is anchored to the first date.
  const fields = (keys, cluster) => keys.map(key => ({ key, cluster }));
  const before = {
    dates: ['2021-01-08', '2021-06-14'],
    groups: [{ species: 'Mais', fields: [...fields(['a', 'b', 'c'], 0), ...fields(['d', 'e'], 1)] }],
  };
  const picks = { [pickKey('Mais', 0)]: { start: 121, end: 268 } };

  // (1) the same partition, renumbered: the mark must follow its own fields.
  const swapped = {
    dates: before.dates,
    groups: [{ species: 'Mais', fields: [...fields(['d', 'e'], 0), ...fields(['a', 'b', 'c'], 1)] }],
  };
  const r1 = remapSeasonPicks(before, swapped, picks);
  ok('a renumbered scenario keeps its own mark',
    r1[pickKey('Mais', 1)]?.start === 121 && !(pickKey('Mais', 0) in r1),
    JSON.stringify(r1));

  // (2) an earlier acquisition moves the base year: the window must move with it.
  const earlier = { dates: ['2020-12-29', ...before.dates], groups: before.groups };
  const r2 = remapSeasonPicks(before, earlier, picks);
  const shift = 366; // 2020 is a leap year
  ok('an earlier insert re-anchors the day axis',
    r2[pickKey('Mais', 0)]?.start === 121 + shift && r2[pickKey('Mais', 0)]?.end === 268 + shift,
    JSON.stringify(r2[pickKey('Mais', 0)]));
  ok('the re-anchored window is still the same calendar dates',
    dayIndexToDate(r2[pickKey('Mais', 0)].start, 2020) === dayIndexToDate(121, 2021),
    dayIndexToDate(r2[pickKey('Mais', 0)].start, 2020));

  // (3) a scenario that did not survive drops its mark rather than moving it.
  const dissolved = {
    dates: before.dates,
    groups: [{ species: 'Mais', fields: [...fields(['x', 'y', 'z'], 0), ...fields(['d', 'e'], 1)] }],
  };
  ok('a dissolved scenario loses its mark rather than inheriting a stranger',
    Object.keys(remapSeasonPicks(before, dissolved, picks)).length === 0);

  // (4) an unchanged clustering is a no-op.
  const r4 = remapSeasonPicks(before, before, picks);
  ok('an unchanged clustering leaves the marks alone',
    r4[pickKey('Mais', 0)]?.start === 121 && r4[pickKey('Mais', 0)]?.end === 268);
}

console.log('\nK. calendar lookup folds the label encoding');
{
  const look = calendarLookup(kb);
  const maize = Object.keys(kb).find(k => /ma\u00efs|mais/i.test(k));
  ok('a real label resolves', !!look(maize).cal, maize);
  ok('an apostrophe variant resolves to the same entry',
    look("Pomme de terre (conso. et plants)").cal === look("Pomme de terre (conso. et plants)").cal);
  ok('an unknown species yields no calendar and no window',
    look('Nothing At All').cal === null && look('Nothing At All').expected === null);
  const noneKey = Object.keys(kb).find(k => kb[k].greenStart === 'none');
  if (noneKey) {
    ok('a crop with no growth window yields a null guide', look(noneKey).expected === null, noneKey);
  }
}

console.log('\nM. the model IS the governing equation');
{
  //   g(t)  = L1 / (1 + e^(-k1 (t - x01)))
  //   d(t)  = L1 - L1 / (1 + e^(-k2 (t - x02)))
  //   b(t)  = 1 / (1 + e^(-(t - tc) / 2.5))
  //   f(t)  = (1 - b) g + b d
  //   VI(t) = clamp( f(t) + f(t-365) + f(t+365), 1e-9, 1-1e-9 )
  const spec = (t, p) => {
    const f = u => {
      const g = p.L1 / (1 + Math.exp(-p.k1 * (u - p.x01)));
      const d = p.L1 - p.L1 / (1 + Math.exp(-p.k2 * (u - p.x02)));
      const b = 1 / (1 + Math.exp(-(u - p.tc) / 2.5));
      return (1 - b) * g + b * d;
    };
    return Math.min(1 - 1e-9, Math.max(1e-9, f(t) + f(t - 365) + f(t + 365)));
  };

  const cases = [
    { L1: 0.85, k1: 0.12, x01: 140, k2: 0.10, x02: 260, tc: 200 },
    { L1: 0.55, k1: 0.30, x01: 100, k2: 0.80, x02: 300, tc: 210 },
    { L1: 1.00, k1: 0.05, x01: 200, k2: 0.04, x02: 320, tc: 262 },
  ];
  let worst = 0;
  for (const p of cases) for (let t = -400; t <= 800; t += 1) worst = Math.max(worst, Math.abs(beck(t, p) - spec(t, p)));
  ok('matches the equation to machine precision', worst < 1e-12, `max |diff| = ${worst.toExponential(2)}`);

  const p = cases[0];
  ok('the curve is periodic over 365 days',
    [50, 120, 200, 300].every(t => Math.abs(beck(t, p) - beck(t + 365, p)) < 1e-9));
  ok('it is clamped into (0, 1)', (() => {
    for (let t = -400; t <= 800; t += 0.5) { const v = beck(t, p); if (v <= 0 || v >= 1) return false; }
    return true;
  })());
  let peakT = 0, peakV = -Infinity;
  for (let t = 1; t <= 365; t++) { const v = beck(t, p); if (v > peakV) { peakV = v; peakT = t; } }
  ok('it peaks between the two inflections', peakT > p.x01 && peakT < p.x02, `peak at ${peakT}`);
  ok('the peak does not exceed L1', peakV <= p.L1 + 1e-9, `${peakV.toFixed(4)} vs L1 ${p.L1}`);
  ok('the green-up limb is at half of L1 on x01 before the hand-over',
    Math.abs(beck(p.x01, p) - p.L1 / 2) < 0.02, `${beck(p.x01, p).toFixed(4)}`);

  // The blend is what stops the two limbs averaging into a plateau.
  ok('the hand-over is sharp: the blend moves from 0.1 to 0.9 within 12 days', (() => {
    const b = u => 1 / (1 + Math.exp(-(u - p.tc) / 2.5));
    return b(p.tc + 6) > 0.9 && b(p.tc - 6) < 0.1;
  })());

  // A fit against data generated from the equation must recover it.
  const days = [], vals = [];
  for (let t = 0; t <= 360; t += 10) { days.push(t); vals.push(spec(t, p)); }
  const f = fitPlantPeriod(days, vals, { start: 60, end: 340 });
  ok('the fit recovers the equation it was generated from', f.r2 > 0.995, `r2 = ${f.r2.toFixed(5)}`);
  ok('both rates come out positive', f.params.k1 > 0 && f.params.k2 > 0,
    `k1=${f.params.k1.toFixed(3)} k2=${f.params.k2.toFixed(3)}`);
  ok('the hand-over lands between the inflections',
    f.params.tc >= f.params.x01 && f.params.tc <= f.params.x02,
    `x01=${f.params.x01.toFixed(0)} tc=${f.params.tc.toFixed(0)} x02=${f.params.x02.toFixed(0)}`);
}

console.log('\nN. a real cycle is accepted; only an undescribable one is refused');
{
  const days = [], per = { start: 60, end: 330 };
  for (let t = 60; t <= 330; t += 12) days.push(t);

  // Rise, plateau, then a harvest that removes the canopy almost overnight:
  // and a period whose end sits right on the drop, so the zeroing leaves a
  // near-vertical edge. This is one growth cycle and must be fitted.
  const harvest = days.map(t =>
    t < 150 ? 0.02 : t < 200 ? 0.02 + 0.63 * ((t - 150) / 50) : t < 290 ? 0.65 : Math.max(0, 0.65 - 0.62 * ((t - 290) / 12))
  );
  const f = fitPlantPeriod(days, harvest, per);
  ok('a rise-plateau-fall with an abrupt harvest is fitted', !f.note, `r2=${f.r2.toFixed(3)} note=${f.note ?? 'none'}`);
  ok('and its R² is high', f.r2 > 0.9, `r2=${f.r2.toFixed(3)}`);

  // Three cuts in a season: one rise and fall cannot describe it.
  const perennial = days.map(t => 0.3 + 0.35 * Math.abs(Math.sin((t / 330) * Math.PI * 3)));
  const g = fitPlantPeriod(days, perennial, per);
  ok('a multi-cut perennial is still refused', !!g.note, `r2=${g.r2.toFixed(3)} note=${g.note ?? 'none'}`);

  // A flat curve carries no cycle to fit either.
  const flat = days.map(() => 0.31);
  ok('a flat curve is refused', !!fitPlantPeriod(days, flat, per).note);
}

console.log('\nO. dropped acquisitions are left out of the fit');
{
  const days = [], vals = [], per = { start: 60, end: 330 };
  for (let t = 60; t <= 330; t += 15) {
    days.push(t);
    const canopy = 0.65 * (1 / (1 + Math.exp(-0.10 * (t - 150))) + 1 / (1 + Math.exp(0.10 * (t - 260))) - 1);
    vals.push(0.1 + Math.max(0, canopy));
  }
  // One acquisition ruined by cloud, sitting far below the curve at the plateau.
  const bad = days[10];
  const dirty = vals.slice();
  dirty[10] = 0.05;

  const clean = fitPlantPeriod(days, vals, per);
  const withBad = fitPlantPeriod(days, dirty, per);
  const dropped = fitPlantPeriod(days, dirty, per, new Set([bad]));

  ok('the bad point hurts the fit', withBad.r2 < clean.r2 - 0.01,
    `clean=${clean.r2.toFixed(4)} dirty=${withBad.r2.toFixed(4)}`);
  ok('dropping it recovers the fit', dropped.r2 > withBad.r2 + 0.01,
    `dropped=${dropped.r2.toFixed(4)}`);
  ok('and it no longer counts towards the point total', dropped.points === withBad.points - 1,
    `${dropped.points} vs ${withBad.points}`);

  // A dropped boundary point must not anchor the baseline either.
  const atEdge = new Set([days[0]]);
  const g = growthSignal(days, dirty, per, atEdge);
  ok('the signal stays finite with a boundary point dropped', g.every(v => v == null || isFinite(v)));

  // Dropping below the parameter count is refused, not fudged.
  const most = new Set(days.slice(2));
  ok('dropping too many refuses the fit', !!fitPlantPeriod(days, vals, per, most).note,
    fitPlantPeriod(days, vals, per, most).note);
}

console.log('\nP. a transition hidden in a gap is reported as unmeasured');
{
  // The real shape from the app: green-up entirely inside a 35-day gap and
  // senescence entirely inside a 20-day one.
  const days = [90, 105, 140, 190, 217, 222, 242, 280];
  const vals = [0, 0.071, 0.653, 0.726, 0.778, 0.777, 0, 0];
  const per = { start: 90, end: 242 };
  const f = fitPlantPeriod(days, vals, per);

  ok('the fit still matches every point', f.r2 > 0.99, `r2=${f.r2.toFixed(4)}`);
  ok('green-up is flagged as unmeasured', f.unconstrained.greenUp >= 30, `${f.unconstrained.greenUp} d gap`);
  ok('senescence is flagged as unmeasured', f.unconstrained.senescence >= 15, `${f.unconstrained.senescence} d gap`);
  ok('and the rate no longer pins to its bound', f.params.k2 < 1.19, `k2=${f.params.k2.toFixed(3)}`);

  // Where acquisitions do bracket the transitions, nothing is flagged.
  const dense = [], dv = [];
  for (let t = 90; t <= 250; t += 5) {
    dense.push(t);
    const c = 0.75 * (1 / (1 + Math.exp(-0.15 * (t - 140))) + 1 / (1 + Math.exp(0.15 * (t - 210))) - 1);
    dv.push(Math.max(0, c));
  }
  const g = fitPlantPeriod(dense, dv, { start: 90, end: 250 });
  ok('a well-sampled cycle reports both rates as measured',
    !g.unconstrained.greenUp && !g.unconstrained.senescence,
    `up=${g.unconstrained.greenUp} down=${g.unconstrained.senescence}`);
  ok('and it still fits', g.r2 > 0.99, `r2=${g.r2.toFixed(4)}`);
}

console.log('\nQ. goodness of fit is reported with its degrees of freedom');
{
  // The exact series from the app: seven observations, six parameters.
  const days = [150, 165, 200, 250, 260, 280, 302];
  const vals = [0.20, 0.20, 0.79, 0.86, 0.82, 0.83, 0.20];
  const per = { start: 150, end: 302 };
  const f = fitPlantPeriod(days, vals, per);

  ok('every observation is matched closely', f.maxResidual < 0.05, `worst ±${f.maxResidual.toFixed(4)}`);
  ok('R² is near 1, as it must be with one spare point', f.r2 > 0.99, `r2=${f.r2.toFixed(4)}`);
  ok('and the spare count is reported so R² can be discounted', f.dof === 1, `dof=${f.dof}`);
  ok('confidence is not claimed on one spare point', f.confidence === 'low', f.confidence);

  // Densely sampled: R² earns its place.
  const d2 = [], v2 = [];
  for (let t = 150; t <= 302; t += 6) {
    d2.push(t);
    const c = 0.66 * (1 / (1 + Math.exp(-0.2 * (t - 190))) + 1 / (1 + Math.exp(0.2 * (t - 280))) - 1);
    v2.push(0.2 + Math.max(0, c));
  }
  const g = fitPlantPeriod(d2, v2, per);
  ok('a dense series has real spare data', g.dof > 15, `dof=${g.dof}`);
  ok('and earns a confidence', g.confidence !== 'low', g.confidence);
  ok('its worst residual is reported too', isFinite(g.maxResidual), `±${g.maxResidual.toFixed(4)}`);
}

console.log('\nL. the plant period is zero at both ends and outside');
{
  // A clean cycle riding on a soil background that drifts upward across the year,
  // so a flat baseline would NOT put both ends at zero.
  const days = [];
  const vals = [];
  for (let t = 0; t <= 360; t += 10) {
    days.push(t);
    const soil = 0.15 + t * 0.0004;
    const canopy = 0.7 * (1 / (1 + Math.exp(-0.12 * (t - 150))) + 1 / (1 + Math.exp(0.1 * (t - 250))) - 1);
    vals.push(soil + Math.max(0, canopy));
  }
  const period = { start: 120, end: 280 };

  const g = growthSignal(days, vals, period);
  const at = t => g[days.indexOf(t)];
  ok('the start boundary is exactly zero', Math.abs(at(120)) < 1e-9, `${at(120)}`);
  ok('the end boundary is exactly zero', Math.abs(at(280)) < 1e-9, `${at(280)}`);
  ok('everything before the period is zero', days.filter(t => t < 120).every(t => at(t) === 0));
  ok('everything after the period is zero', days.filter(t => t > 280).every(t => at(t) === 0));
  ok('the interior is positive', at(200) > 0.5, `${at(200)}`);
  ok('nothing is negative', g.every(v => v == null || v >= 0));

  const fit = fitPlantPeriod(days, vals, period);
  ok('a curve is fitted', !!fit && isFinite(fit.r2) && fit.r2 > 0.95, `r2=${fit?.r2?.toFixed(4)}`);
  ok('the model is zero outside the period',
    periodModelAt(fit, period, 60) === 0 && periodModelAt(fit, period, 340) === 0);
  ok('the model is never negative',
    days.every(t => periodModelAt(fit, period, t) >= 0));
  ok('the model peaks inside the period', (() => {
    let bt = 0, bv = -1;
    for (let t = 0; t <= 360; t++) { const v = periodModelAt(fit, period, t); if (v > bv) { bv = v; bt = t; } }
    return bt > 120 && bt < 280;
  })());

  // Too few acquisitions to identify six parameters: say so, do not invent a curve.
  const sparse = fitPlantPeriod([120, 160, 200, 240], [0.2, 0.5, 0.6, 0.2], period);
  ok('a period with too few images is refused, with a reason',
    sparse.confidence === 'low' && /images needed/.test(sparse.note ?? ''), sparse.note);
}

console.log('\n' + (bad ? `${bad} FAILURE(S)` : 'ALL REGRESSION CHECKS PASSED'));
process.exit(bad ? 1 : 0);
