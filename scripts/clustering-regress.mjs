/**
 * Regression suite for src/lib/species-clusters.ts, run with `npm run test:clustering`.
 *
 * The thing under test is the split between the two date axes. k-means needs a
 * complete, well-covered matrix to decide who resembles whom; the curves that
 * get drawn and fitted must NOT be limited to that, or a partly-cloudy
 * acquisition, exactly the kind a user inserts to fill a hole, silently
 * fails to appear on the very curve it was fetched for.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/lib/species-clusters.ts'), 'utf8');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clus-')), 'species-clusters.mjs');
fs.writeFileSync(tmp, transformSync(src, { loader: 'ts', format: 'esm' }).code);
const { clusterBySpecies } = await import(tmp);

let bad = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

/**
 * Build an extraction: `nFields` fields of one species, one interior pixel
 * each, over `dates`. `seenOn[dateIndex]` is how many fields saw that date,
 * the rest carry no property for it at all, exactly as a partly-covered
 * acquisition comes out of the zone extraction.
 */
function extraction(dates, nFields, seenOn, valueFor) {
  const features = [];
  for (let f = 0; f < nFields; f++) {
    const props = { NewID: `F${f}`, crp_lbl: 'Maize', __pid: f };
    dates.forEach((d, di) => {
      if (f < seenOn[di]) props[`NDVI_${d}`] = valueFor(f, di);
    });
    features.push({ properties: props });
  }
  return {
    interior: { features },
    edge: { features: [] },
    dates,
    metric: 'NDVI',
  };
}

const DATES = ['2021-03-01', '2021-04-01', '2021-05-01', '2021-06-01', '2021-07-01', '2021-08-01'];

console.log('A. a sparsely-seen date still reaches the curve');
{
  // 20 fields; every date seen by all of them except 06-01, seen by only 3.
  const N = 20;
  const seen = [N, N, N, 3, N, N];
  const SPARSE = 3;
  // Two obvious growth scenarios so k=2 has something real to find.
  const value = (f, di) => (f % 2 === 0 ? [0.2, 0.3, 0.7, 0.8, 0.6, 0.25] : [0.2, 0.6, 0.8, 0.7, 0.35, 0.2])[di];
  const c = clusterBySpecies(extraction(DATES, N, seen, value), 2);

  ok('every extraction date is on the curve axis', c.dates.length === DATES.length, `${c.dates.length}/${DATES.length}`);
  ok('the sparse date is on it', c.dates.includes('2021-06-01'));
  ok('k-means did NOT partition on the sparse date',
    !c.clusteringDates.includes('2021-06-01') && c.clusteringDates.length === DATES.length - 1,
    c.clusteringDates.join(','));
  ok('no field was dropped for missing only the sparse date', c.droppedFields === 0, `dropped=${c.droppedFields}`);

  const di = c.dates.indexOf('2021-06-01');
  const g = c.groups[0];
  const finite = g.centroids.filter(row => Number.isFinite(row[di])).length;
  ok('at least one scenario has a real value on the sparse date', finite >= 1, `${finite} of ${g.centroids.length}`);
  ok('centroid rows span the full axis', g.centroids.every(r => r.length === DATES.length));
  ok('support is reported per point', g.support.every(r => r.length === DATES.length));

  const totalSupport = g.support.reduce((s, r) => s + r[di], 0);
  ok('support on the sparse date equals the fields that saw it', totalSupport === SPARSE, `${totalSupport}`);
  ok('support on a full date equals the cluster size',
    g.support.every((r, ci) => r[0] === g.sizes[ci]),
    g.support.map(r => r[0]).join(',') + ' vs ' + g.sizes.join(','));
}

console.log('\nB. the sparse point is the mean of the fields that saw it');
{
  const N = 10;
  const seen = [N, N, N, 2, N, N];
  // Every field identical, so there is one scenario and the mean is exact.
  const value = (f, di) => (di === 3 ? 0.5 + f * 0.1 : [0.2, 0.3, 0.7, 0, 0.6, 0.25][di]);
  const c = clusterBySpecies(extraction(DATES, N, seen, value), 1);
  const di = c.dates.indexOf('2021-06-01');
  const g = c.groups[0];
  // Fields 0 and 1 saw it, with 0.5 and 0.6.
  ok('the value is the mean over the fields present', Math.abs(g.centroids[0][di] - 0.55) < 1e-9, `${g.centroids[0][di]}`);
  ok('and its support is 2', g.support[0][di] === 2, `${g.support[0][di]}`);
}

console.log('\nC. a date no field in a scenario saw stays a hole, not a zero');
{
  const N = 12;
  const seen = [N, N, N, 0, N, N]; // nobody saw 06-01
  const value = (f, di) => [0.2, 0.3, 0.7, 0, 0.6, 0.25][di];
  const c = clusterBySpecies(extraction(DATES, N, seen, value), 1);
  const di = c.dates.indexOf('2021-06-01');
  ok('the centroid is NaN there, never 0', Number.isNaN(c.groups[0].centroids[0][di]), `${c.groups[0].centroids[0][di]}`);
  ok('support is 0 there', c.groups[0].support[0][di] === 0);
}

console.log('\nD. inserting a thin date does not disturb the partition');
{
  const N = 16;
  const value = (f, di) => (f % 2 === 0 ? [0.2, 0.3, 0.7, 0.8, 0.6, 0.25] : [0.2, 0.6, 0.8, 0.7, 0.35, 0.2])[di];
  const before = clusterBySpecies(extraction(DATES, N, DATES.map(() => N), value), 2);

  // The same series with one extra, barely-seen acquisition spliced in.
  const withNew = [...DATES.slice(0, 3), '2021-05-15', ...DATES.slice(3)];
  const seenNew = [N, N, N, 2, N, N, N];
  const valueNew = (f, di) => (di === 3 ? 0.75 : value(f, di > 3 ? di - 1 : di));
  const after = clusterBySpecies(extraction(withNew, N, seenNew, valueNew), 2);

  const members = c => c.groups[0].fields.slice().sort((a, b) => a.key.localeCompare(b.key)).map(f => f.cluster).join('');
  ok('the new date appears on the axis', after.dates.includes('2021-05-15'));
  ok('the curve gained a point', after.dates.length === before.dates.length + 1);
  ok('membership is unchanged', members(before) === members(after), `${members(before)} vs ${members(after)}`);
  ok('the new point carries a value',
    after.groups[0].centroids.some(r => Number.isFinite(r[after.dates.indexOf('2021-05-15')])));
}

console.log('\n' + (bad ? `${bad} FAILURE(S)` : 'ALL CLUSTERING CHECKS PASSED'));
process.exit(bad ? 1 : 0);
