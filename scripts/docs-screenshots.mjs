/**
 * Pictures of the designer's own menus, for the documentation page.
 *
 *   PLAYWRIGHT_FROM=<a folder whose node_modules holds playwright-core> node scripts/docs-screenshots.mjs [name ...]
 *
 * It builds the designer, opens it in a headless Chrome with every outside
 * request refused (so the map has no tiles under it: only what the designer
 * draws), seeds it with the trial of the documentation's first example, and
 * writes docs-img/NAME.png with docs-img/shots.json, the size of each.
 * scripts/docs-figures.mjs then puts them on the page. With names given, only
 * those pictures are taken again.
 *
 * Run it after a change to the panel. The tests do not: there is no browser
 * where the page is published. They only check that every picture the page
 * shows is there, at the size written.
 *
 * playwright-core is not one of this project's dependencies: say where one is
 * with PLAYWRIGHT_FROM. Nothing here reads or writes anything of the person
 * running it but the two outputs: the browser starts from an empty profile.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs-img');
const DIST = path.join(ROOT, 'node_modules/.docs-shots');
const only = process.argv.slice(2);
const want = name => !only.length || only.includes(name);

let chromium;
try { ({ chromium } = createRequire(path.join(process.env.PLAYWRIGHT_FROM ?? ROOT, 'x.js'))('playwright-core')); }
catch { console.error('playwright-core was not found: set PLAYWRIGHT_FROM to a folder whose node_modules holds it.'); process.exit(1); }

// The designer as it is published, into a folder of its own.
execFileSync('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir'], { cwd: ROOT, env: { ...process.env, PIXEL_GRID_ONLY: '1', VITE_STANDALONE: '1' }, stdio: 'ignore' });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(DIST, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/pixel-grid.html'));
  fs.readFile(p, (err, buf) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' }); res.end(buf); });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// The field and the trial of the first example (scripts/docs-figures.mjs): 40 m plots, 4 species in 4 blocks, Sentinel-2.
const E0 = 619203.7, N0 = 5600764.3, SIDE = 280;
const toLL = proj4('+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs', 'EPSG:4326');
const [w, s] = toLL.forward([E0, N0]), [e, n] = toLL.forward([E0 + SIDE, N0 + SIDE]);
const centre = toLL.forward([E0 + SIDE / 2, N0 + SIDE / 2]);
const SEED = {
  aoi: [w, s, e, n], view: { center: [centre[1], centre[0]], zoom: 17 }, basemap: 'dark', panelW: 430,
  activeStep: 'sim', simFold: 'sat', pattern: 'block', rotation: 0, threshold: 90, sourceId: 's2-10',
  blockDesign: { nSpecies: 4, nBlocks: 4, plotLength: 40, plotWidth: 40, plotAlley: 0, blockAlley: 0, blocksPerRow: 4, seed: 1 },
  showSim: true, showPure: true, showField: false, showPsf: false, showSigmas: false, showSources: false,
  // Four pixels per plot, as the first example asks: Suggest a design and Plot size required both read it.
  wantPure: 4,
};
/** A made-up trial as a file: 24 plots of 50 x 40 m, 6 varieties in 4 repetitions, at 17 degrees (the fourth example). */
const trialFile = () => {
  const names = ['Alba', 'Brio', 'Cora', 'Dune', 'Elan', 'Faro'], order = [[0, 1, 2, 3, 4, 5], [3, 5, 0, 2, 1, 4], [4, 2, 5, 1, 3, 0], [1, 4, 3, 0, 5, 2]];
  const t = (17 * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t), features = [];
  for (let b = 0; b < 4; b++) for (let k = 0; k < 6; k++) {
    const ring = [[b * 50, k * 40], [b * 50 + 50, k * 40], [b * 50 + 50, k * 40 + 40], [b * 50, k * 40 + 40], [b * 50, k * 40]].map(([u, v]) => toLL.forward([E0 + 100 + u * cos - v * sin, N0 + 100 + u * sin + v * cos]));
    features.push({ type: 'Feature', properties: { Plot: String(b * 6 + k + 1), Variety: names[order[b][k]] }, geometry: { type: 'Polygon', coordinates: [ring] } });
  }
  return { name: 'trial.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features })) };
};

fs.mkdirSync(OUT, { recursive: true });
const sizes = fs.existsSync(path.join(OUT, 'shots.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'shots.json'), 'utf8')) : {};
let browser;
try { browser = await chromium.launch({ channel: 'chrome', headless: true }); } catch (err) { server.close(); throw err; }
const errors = [];

/** A page of the designer seeded with `seed`, in a window `width` by `height`. */
const open = async (seed, width, height, ready = 'text=Pixel Grid Designer') => {
  // English figures in the number fields, whatever the computer taking the pictures writes them like.
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'en-US' });
  await ctx.route(u => !u.href.startsWith(origin), r => r.abort());
  await ctx.addInitScript(values => { if (localStorage.getItem('pgrid.v1.pattern')) return; for (const [k, v] of Object.entries(values)) localStorage.setItem('pgrid.v1.' + k, JSON.stringify(v)); }, { ...SEED, ...seed });
  const page = await ctx.newPage();
  page.on('pageerror', err => errors.push(String(err)));
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(ready, { timeout: 30000 });
  await page.waitForTimeout(2500);
  return { ctx, page, aside: page.locator('aside') };
};
/** Write one picture: an element, or a rectangle of the page. */
const save = async (name, target, page) => {
  if (!want(name)) return;
  const file = path.join(OUT, `${name}.png`);
  // A number field is written in the browser's own language, which on a Mac is the computer's: a French one
  // showed 0,595 beside 7.15 m, and neither the page's language nor the browser's switches change that. For
  // the time of the picture the fields are plain text, which shows the value as the page holds it, 0.595.
  const pg = page ?? target.page();
  await pg.evaluate(() => document.querySelectorAll('input[type=number]').forEach(el => { el.setAttribute('data-number', ''); el.type = 'text'; }));
  try {
    if (target.screenshot) await target.screenshot({ path: file }); else await pg.screenshot({ path: file, clip: target });
  } finally {
    await pg.evaluate(() => document.querySelectorAll('input[data-number]').forEach(el => { el.type = 'number'; el.removeAttribute('data-number'); }));
  }
  const buf = fs.readFileSync(file);
  sizes[name] = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  console.log(`  ${name}.png  ${sizes[name].w} x ${sizes[name].h}  ${Math.round(buf.length / 1024)} kB`);
};
/** A fold of step 2 by the start of its title: its row and what it holds. */
const fold = (aside, title) => aside.locator('button[aria-expanded]', { hasText: title }).first().locator('xpath=..');
const openFold = async (aside, title, wait = 900) => { const b = aside.locator('button[aria-expanded]', { hasText: title }).first(); if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click(); await aside.page().waitForTimeout(wait); return fold(aside, title); };
/** The middle of the map, `width` by `height`. */
const mapClip = async (page, width, height) => { const b = await page.locator('.leaflet-container').boundingBox(); return { x: Math.round(b.x + b.width / 2 - width / 2), y: Math.round(b.y + b.height / 2 - height / 2), width, height }; };
/** Set the switches of the Layers menu: the names given on, every other one off, where it can be switched. */
const layers = async (page, on) => {
  if (!(await page.locator('button[role=switch]').count())) await page.locator('button', { hasText: /^\s*Layers\s*$/ }).click();
  await page.waitForTimeout(300);
  for (const sw of await page.locator('button[role=switch]').all()) {
    const label = (await sw.innerText()).replace(/✓/g, '').trim();
    if ((await sw.isDisabled())) continue;
    if (((await sw.getAttribute('aria-checked')) === 'true') !== on.includes(label)) await sw.click();
  }
  await page.waitForTimeout(900);
};
const closeLayers = async page => { if (await page.locator('button[role=switch]').count()) await page.locator('button', { hasText: /^\s*Layers\s*$/ }).click(); await page.waitForTimeout(300); };

try {
  // ---- The whole page, and every fold of step 2.
  {
    const { ctx, page, aside } = await open({}, 1320, 820, 'text=Place the trial for');
    await save('app', { x: 0, y: 0, width: 1320, height: 820 }, page);
    await page.setViewportSize({ width: 1320, height: 1700 });
    await page.waitForTimeout(800);
    await save('fold-satellite', fold(aside, 'Satellite ·'));
    await save('fold-budget', await openFold(aside, 'Every source of blur'));
    await save('fold-design', await openFold(aside, 'Design ·'));
    const suggest = await openFold(aside, 'Suggest a design');
    await aside.locator('button', { hasText: 'Build this trial' }).click();
    await page.waitForTimeout(3500);
    await save('fold-suggest', suggest);
    await save('fold-plot-size', await openFold(aside, 'Plot size required', 1500));
    await save('fold-curves', await openFold(aside, 'Growth curves', 2500));
    await save('fold-noise', await openFold(aside, 'Noise'));
    await aside.locator('section > button', { hasText: 'Experiment area' }).click();
    await page.waitForTimeout(700);
    await save('step-area', aside.locator('section').first());
    await ctx.close();
  }
  // ---- Alternating rows, and a trial read from a file.
  {
    const rows = await open({ pattern: 'row', stripWidth: 30, simFold: 'design' }, 1320, 1200, 'text=Strip width');
    await save('fold-design-rows', fold(rows.aside, 'Design ·'));
    await rows.ctx.close();
    const file = await open({ pattern: 'imported', simFold: 'design' }, 1080, 1200, 'text=Drop your trial');
    await file.page.locator('input[type=file]').setInputFiles(trialFile());
    await file.page.waitForSelector('text=Variety column', { timeout: 30000 });
    await file.page.waitForTimeout(3500);
    await file.aside.locator('button', { hasText: 'Show attributes' }).click();
    await file.page.waitForTimeout(600);
    await save('fold-import', fold(file.aside, 'Design ·'));
    // The whole map, in a window small enough for the page to have fitted the trial in it.
    await file.page.setViewportSize({ width: 1080, height: 560 });
    await file.page.waitForTimeout(2500);
    const whole = await file.page.locator('.leaflet-container').boundingBox();
    await save('map-import', { x: Math.round(whole.x), y: Math.round(whole.y), width: Math.round(whole.width), height: Math.round(whole.height) }, file.page);
    await file.ctx.close();
  }
  // ---- The Layers menu, and the map under each of its switches.
  {
    const { ctx, page } = await open({}, 1320, 820, 'text=Place the trial for');
    await layers(page, ['Pure pixels']);
    const menu = page.locator('button[role=switch]').first().locator('xpath=..');
    await save('layers-menu', menu);
    for (const [name, on] of [['layer-simulation', []], ['layer-pure', ['Pure pixels']], ['layer-real-field', ['Real field']]]) {
      await layers(page, on); await closeLayers(page);
      await save(name, await mapClip(page, 560, 400), page);
    }
    await ctx.close();
    // Closer in, for what is drawn around one pixel.
    // The overlay sits on the pixel in the middle of the field and its card in the map's top left corner: both are in the picture.
    const near = await open({ view: { center: [centre[1], centre[0]], zoom: 18 } }, 1320, 600, 'text=Place the trial for');
    for (const [name, on] of [['layer-sigmas', ['σ PSF, geo, eff']], ['layer-signal', ['Signal of a pixel']]]) {
      await layers(near.page, on); await closeLayers(near.page);
      await save(name, { x: 50, y: 0, width: 700, height: 520 }, near.page);
    }
    await near.ctx.close();
  }
  // ---- Step 3: the chart's four tabs, the table, the small charts, a comparison.
  {
    const { ctx, page, aside } = await open({ activeStep: 'pca' }, 1320, 1500, 'text=Across satellites');
    await page.waitForFunction(() => !/…/.test(document.querySelector('aside')?.innerText ?? '…'), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const card = aside.locator('div.rounded-lg', { hasText: 'Across satellites' }).last();
    const tabs = aside.locator('button', { hasText: /^scatter$/i }).first().locator('xpath=..');
    for (const tab of ['scatter', 'variance', 'loadings', 'purity']) {
      await aside.locator('button', { hasText: new RegExp(`^${tab}$`, 'i') }).first().click();
      await page.waitForTimeout(1200);
      const a = await tabs.boundingBox(), b = await card.boundingBox();
      await save(`chart-${tab}`, { x: Math.round(a.x), y: Math.round(a.y), width: Math.round(a.width), height: Math.round(b.y - a.y - 10) }, page);
    }
    await aside.locator('button', { hasText: /^scatter$/i }).first().click();
    await save('table', card);
    await aside.locator('button', { hasText: /^charts$/i }).click();
    await page.waitForTimeout(6000);
    await save('table-charts', card);
    await ctx.close();
    // The field of the first example's turned trial (docs-figures.mjs: 40 m more each way), so that the table reads as the example does.
    const [e2, n2] = toLL.forward([E0 + SIDE + 40, N0 + SIDE + 40]), c2 = toLL.forward([E0 + (SIDE + 40) / 2, N0 + (SIDE + 40) / 2]);
    const turned = await open({ activeStep: 'pca', rotation: 20, compareAligned: true, ladderView: 'table', aoi: [w, s, e2, n2], view: { center: [c2[1], c2[0]], zoom: 17 } }, 1320, 1500, 'text=Across satellites');
    await turned.page.waitForTimeout(14000);
    await save('table-compare', turned.aside.locator('div.rounded-lg', { hasText: 'Across satellites' }).last());
    await turned.ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n');
const total = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`${Object.keys(sizes).length} pictures in docs-img, ${Math.round(total / 1024)} kB in all${errors.length ? `; page errors: ${errors.slice(0, 3).join(' | ')}` : ''}`);
