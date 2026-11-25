/**
 * Pictures of the designer's own menus, for the documentation page.
 *
 *   PLAYWRIGHT_FROM=<a folder whose node_modules holds playwright-core> node scripts/docs-screenshots.mjs [name ...]
 *
 * It builds the designer, opens it in a headless Chrome with every outside
 * request refused (so the map has no tiles under it: only what the designer
 * draws), seeds it with the trial of the documentation's first example, and
 * writes docs-img/NAME.svg with docs-img/shots.json, the size of each.
 *
 * SVG, not PNG (2026-11-25: "the screen shots look blurry when zooming can
 * you make them svg"): what is pictured is copied out of the page, each
 * element with the styles the browser computed for it, into an SVG
 * foreignObject (toSvg below), so its text, borders and drawings are redrawn
 * sharp at any zoom. A canvas, which is how the map draws its pixels, has no
 * shapes to copy: it goes in as its own image, taken at twice the resolution.
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

/**
 * IN THE PAGE: an element, or the rectangle `clip` of the page, as an SVG
 * document. The element is copied with the styles the browser computed for
 * each of its parts written on it (only those that differ from a bare element
 * of the same kind, or that an inherited one does not already give), inside a
 * foreignObject the size of what is pictured, on the background behind it.
 * A canvas becomes an image of itself; an image, an image held in the file.
 */
function toSvg(target, clip) {
  const SVG = 'http://www.w3.org/2000/svg';
  let root = target;
  if (!root) {
    // The smallest element that holds the rectangle.
    root = document.elementFromPoint(clip.x + clip.width / 2, clip.y + clip.height / 2);
    const holds = el => { const r = el.getBoundingClientRect(); return r.left <= clip.x + 0.5 && r.top <= clip.y + 0.5 && r.right >= clip.x + clip.width - 0.5 && r.bottom >= clip.y + clip.height - 0.5; };
    // Not a canvas, an image or a drawing, which can be larger than the picture and still be only one of its layers.
    const layer = el => /^(canvas|img|svg|video)$/.test(el.localName) || el.namespaceURI === 'http://www.w3.org/2000/svg';
    while (root && root !== document.body && (layer(root) || !holds(root))) root = root.parentElement;
    root = root ?? document.body;
    // And everything that shows in the rectangle, which may not be the map's: a panel laid over it, one that
    // lets the mouse through to the map, and so is found by where it is, not by what a click would reach.
    for (const el of document.body.querySelectorAll('*')) {
      if (root === document.body) break;
      if (root.contains(el) || el.contains(root)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right <= clip.x || r.left >= clip.x + clip.width || r.bottom <= clip.y || r.top >= clip.y + clip.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      while (root !== document.body && !root.contains(el)) root = root.parentElement;
    }
  }
  const rect = root.getBoundingClientRect();
  const box = clip ?? { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  const W = Math.round(box.width), H = Math.round(box.height);

  // What a bare element of each kind has, to leave out what is no more than that.
  const sandbox = document.createElement('iframe');
  sandbox.style.cssText = 'position:fixed;left:-10000px;top:0;width:300px;height:300px;border:0;visibility:hidden';
  document.body.appendChild(sandbox);
  const sdoc = sandbox.contentDocument;
  sdoc.open(); sdoc.write('<!doctype html><html><head></head><body><svg xmlns="http://www.w3.org/2000/svg"></svg></body></html>'); sdoc.close();
  const bare = new Map();
  // What the page's body gives a child that sets nothing: a property a bare element has otherwise is set by
  // the browser's own sheet (a button's font, a heading's size), and has to be written even where the page inherits it.
  const plain = (() => { const cs = sandbox.contentWindow.getComputedStyle(sdoc.body), out = {}; for (let i = 0; i < cs.length; i++) out[cs[i]] = cs.getPropertyValue(cs[i]); return out; })();
  const bareOf = el => {
    const key = `${el.namespaceURI}|${el.localName}|${el.getAttribute('type') ?? ''}`;
    if (bare.has(key)) return bare.get(key);
    const d = sdoc.createElementNS(el.namespaceURI, el.localName);
    if (el.getAttribute('type')) d.setAttribute('type', el.getAttribute('type'));
    (el.namespaceURI === SVG && el.localName !== 'svg' ? sdoc.querySelector('svg') : sdoc.body).appendChild(d);
    const cs = sandbox.contentWindow.getComputedStyle(d), out = {};
    for (let i = 0; i < cs.length; i++) out[cs[i]] = cs.getPropertyValue(cs[i]);
    d.remove();
    bare.set(key, out);
    return out;
  };
  // Properties a child takes from its parent: written only where they change.
  const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-feature-settings',
    'font-variation-settings', 'font-kerning', 'font-optical-sizing', 'font-synthesis', 'font-synthesis-weight', 'font-synthesis-style', 'font-synthesis-small-caps',
    'font-variant-ligatures', 'font-variant-numeric', 'font-variant-caps', 'font-variant-east-asian', 'font-variant-alternates', 'font-variant-position',
    'font-size-adjust', 'font-palette', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-align-last', 'text-indent', 'text-transform',
    'text-shadow', 'text-rendering', 'text-underline-position', 'text-decoration-skip-ink', 'text-size-adjust', '-webkit-text-size-adjust', 'white-space',
    'white-space-collapse', 'text-wrap', 'text-wrap-mode', 'text-wrap-style', 'word-break', 'overflow-wrap', 'hyphens', 'tab-size', 'direction',
    'writing-mode', 'visibility', 'list-style-type', 'list-style-position', 'list-style-image', 'quotes', 'fill', 'fill-opacity', 'fill-rule', 'stroke',
    'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'paint-order',
    'color-scheme', '-webkit-font-smoothing', 'border-collapse', 'border-spacing', 'caption-side', 'empty-cells', 'image-rendering', 'shape-rendering',
    'text-anchor', 'dominant-baseline', 'clip-rule', 'color-interpolation', 'color-interpolation-filters', 'marker-start', 'marker-mid', 'marker-end',
    '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width', 'accent-color', 'line-break', 'orphans', 'widows',
    'text-emphasis-color', 'text-emphasis-position', 'text-emphasis-style', 'text-orientation', 'hanging-punctuation', 'forced-color-adjust',
    'print-color-adjust', 'math-depth', 'math-style', 'ruby-position', 'text-combine-upright', 'hyphenate-character', 'hyphenate-limit-chars']);
  // What a still picture has no use for.
  const NEVER = /^(transition|animation|will-change|cursor|pointer-events|user-select|-webkit-user-|caret-color|view-transition|scroll-|overscroll-|touch-action|content-visibility|contain-intrinsic|interpolate-size|anchor-|position-try|-webkit-tap|-webkit-locale|-webkit-rtl|-webkit-highlight)/;
  // Logical properties: in a page written left to right, top to bottom, the physical ones say the same.
  const LOGICAL = /^(margin|padding|border|inset|scroll-margin|scroll-padding|overflow|contain-intrinsic)-(block|inline)|^(min-|max-)?(block|inline)-size$|^border-(start|end)-(start|end)-radius$/;
  // Elements the browser's own sheet gives a colour or a font of their own (a button's text, a link's blue),
  // even where that happens to equal the page's default: what they inherit on the page is always written.
  const OWN = new Set(['button', 'input', 'select', 'textarea', 'option', 'optgroup', 'legend', 'fieldset', 'meter', 'progress', 'a', 'mark', 'abbr',
    'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'code', 'pre', 'kbd', 'samp', 'small', 'sub', 'sup', 'summary', 'dialog']);
  const SIZES = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'flex-basis']);
  // An SVG shape's geometry is in its attributes: as styles, "auto" would undo them.
  const GEOMETRY = new Set(['x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'd']);
  const KEEP_HTML = new Set(['type', 'value', 'checked', 'selected', 'colspan', 'rowspan', 'src', 'alt', 'width', 'height', 'disabled', 'dir', 'open', 'id']);

  const styleOf = (el, cs, parentCs, pseudo) => {
    const svgShape = el.namespaceURI === SVG && el.localName !== 'svg' && !pseudo;
    const def = bareOf(el);
    let css = '';
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      // Variables are already resolved into the values that use them; logical sides repeat the physical ones.
      if (p.startsWith('--') || LOGICAL.test(p) || NEVER.test(p) || (svgShape && GEOMETRY.has(p))) continue;
      // A colour or style of a line that is not drawn.
      const side = /^border-(top|right|bottom|left)-(color|style)$/.exec(p);
      if (side && cs.getPropertyValue(`border-${side[1]}-width`) === '0px') continue;
      if (p === 'outline-color' && cs.getPropertyValue('outline-style') === 'none') continue;
      if (p === 'text-decoration-color' && cs.getPropertyValue('text-decoration-line') === 'none') continue;
      if (p === 'column-rule-color' && cs.getPropertyValue('column-rule-style') === 'none') continue;
      if (p === 'row-rule-color' && cs.getPropertyValue('row-rule-style') === 'none') continue;
      // Where a turn or a perspective would pivot, with none.
      if (p === 'transform-origin' && cs.getPropertyValue('transform') === 'none' && cs.getPropertyValue('rotate') === 'none' && cs.getPropertyValue('scale') === 'none') continue;
      if (p === 'perspective-origin' && cs.getPropertyValue('perspective') === 'none') continue;
      if ((p === '-webkit-text-fill-color' || p === '-webkit-text-stroke-color' || p === 'text-emphasis-color') && cs.getPropertyValue(p) === cs.getPropertyValue('color')) continue;
      let v = cs.getPropertyValue(p);
      // A size is given to the thousandth, and laid out to the 64th: rounded down, a box can come out a hair
      // narrower than its own text, which then wraps. A thousandth more stays within the same 64th.
      if (SIZES.has(p) && /^\d+\.\d+px$/.test(v)) v = `${(parseFloat(v) + 0.001).toFixed(3)}px`;
      if (INHERITED.has(p) && parentCs) { if (v === parentCs.getPropertyValue(p) && !OWN.has(el.localName) && (svgShape || def[p] === plain[p])) continue; }
      else if (v === def[p]) continue;
      css += `${p}:${v};`;
    }
    return css;
  };
  const pseudoOf = (el, which, cs) => {
    const ps = getComputedStyle(el, which), content = ps.getPropertyValue('content');
    if (!content || content === 'none' || content === 'normal') return null;
    const span = document.createElement('span');
    span.setAttribute('style', styleOf(el, ps, cs, true));
    span.textContent = content.replace(/^["']|["']$/g, '');
    return span;
  };
  const copy = (node, parentCs) => {
    if (node.nodeType === 3) return document.createTextNode(node.textContent);
    if (node.nodeType !== 1) return null;
    const el = node, cs = getComputedStyle(el);
    if (cs.display === 'none') return null;
    let out;
    if (el.localName === 'canvas') {
      out = document.createElement('img');
      // Only the part inside the picture: the rest left clear, which costs next to nothing to keep.
      try {
        const r = el.getBoundingClientRect(), sx = el.width / (r.width || 1), sy = el.height / (r.height || 1);
        const x0 = Math.max(0, Math.floor((box.x - r.left) * sx)), y0 = Math.max(0, Math.floor((box.y - r.top) * sy));
        const x1 = Math.min(el.width, Math.ceil((box.x + box.width - r.left) * sx)), y1 = Math.min(el.height, Math.ceil((box.y + box.height - r.top) * sy));
        const c = document.createElement('canvas');
        c.width = el.width; c.height = el.height;
        if (x1 > x0 && y1 > y0) c.getContext('2d').drawImage(el, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
        // WebP: a twentieth of the PNG for the map's coloured pixels, with no difference to see.
        out.setAttribute('src', c.toDataURL('image/webp', 0.9));
      } catch { /* a canvas tainted by another site: none here */ }
    } else if (el.localName === 'img' && el.src && !el.src.startsWith('data:')) {
      out = document.createElement('img');
      try { const c = document.createElement('canvas'); c.width = el.naturalWidth; c.height = el.naturalHeight; c.getContext('2d').drawImage(el, 0, 0); out.setAttribute('src', c.toDataURL('image/png')); } catch { /* left empty */ }
    } else {
      out = el.cloneNode(false);
      for (const a of [...out.attributes]) {
        if (a.name === 'class' || a.name === 'style' || a.name.startsWith('data-') || a.name.startsWith('aria-') || a.name.startsWith('on')) out.removeAttribute(a.name);
        else if (el.namespaceURI !== SVG && !KEEP_HTML.has(a.name)) out.removeAttribute(a.name);
      }
    }
    // No scrollbar: a picture is not scrolled, and a scrollbar that takes room on some computers would move what is beside it.
    out.setAttribute('style', styleOf(el, cs, parentCs, false) + (/auto|scroll/.test(cs.overflowX + cs.overflowY) ? 'scrollbar-width:none;' : ''));
    // What a field holds is its value, not its attribute.
    if (el.localName === 'input') {
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) out.setAttribute('checked', 'checked'); else out.removeAttribute('checked'); }
      else out.setAttribute('value', el.value);
    }
    if (el.localName === 'textarea') out.textContent = el.value;
    // A part wholly outside the picture keeps its box, so that the rest lies where it did, and nothing in it.
    const r = el.getBoundingClientRect();
    if (el !== root && r.width >= 1 && r.height >= 1 && (r.right <= box.x || r.left >= box.x + box.width || r.bottom <= box.y || r.top >= box.y + box.height)) return out;
    const before = el.namespaceURI === SVG ? null : pseudoOf(el, '::before', cs);
    if (before) out.appendChild(before);
    if (el.localName !== 'canvas' && el.localName !== 'textarea') for (const ch of el.childNodes) { const c = copy(ch, cs); if (c) out.appendChild(c); }
    const after = el.namespaceURI === SVG ? null : pseudoOf(el, '::after', cs);
    if (after) out.appendChild(after);
    if (el.localName === 'select') [...out.querySelectorAll('option')].forEach((o, i) => { if (i === el.selectedIndex) o.setAttribute('selected', 'selected'); else o.removeAttribute('selected'); });
    // A part scrolled inside is shown as it is scrolled.
    if ((el.scrollTop || el.scrollLeft) && out.firstElementChild) {
      const inner = out.firstElementChild;
      inner.setAttribute('style', `${inner.getAttribute('style')}translate:${-el.scrollLeft}px ${-el.scrollTop}px;`);
    }
    return out;
  };

  const body = copy(root, null);
  sandbox.remove();
  // Where it sits in the picture: the element's own place, less the corner of the rectangle.
  body.setAttribute('style', `${body.getAttribute('style')}position:absolute;left:${rect.left - box.x}px;top:${rect.top - box.y}px;margin:0;`);
  // The background behind it, as the page shows it.
  let under = root.parentElement, bg = 'rgba(0, 0, 0, 0)';
  while (under && /rgba\(.*,\s*0\)$|transparent/.test(bg)) { bg = getComputedStyle(under).backgroundColor; under = under.parentElement; }
  if (/rgba\(.*,\s*0\)$|transparent/.test(bg)) bg = getComputedStyle(document.body).backgroundColor;
  const wrap = document.createElement('div');
  wrap.setAttribute('style', `position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${bg};`);
  wrap.appendChild(body);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H)); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const fo = document.createElementNS(SVG, 'foreignObject');
  fo.setAttribute('x', '0'); fo.setAttribute('y', '0'); fo.setAttribute('width', String(W)); fo.setAttribute('height', String(H));
  fo.appendChild(wrap);
  svg.appendChild(fo);
  return { w: W, h: H, svg: new XMLSerializer().serializeToString(svg), from: `${root.localName}${root.id ? '#' + root.id : ''}` };
}

fs.mkdirSync(OUT, { recursive: true });
const sizes = fs.existsSync(path.join(OUT, 'shots.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'shots.json'), 'utf8')) : {};
let browser;
try { browser = await chromium.launch({ channel: 'chrome', headless: true }); } catch (err) { server.close(); throw err; }
const errors = [];

/** A page of the designer seeded with `seed`, in a window `width` by `height`. */
const open = async (seed, width, height, ready = 'text=Pixel Grid Designer') => {
  // English figures in the number fields, whatever the computer taking the pictures writes them like.
  // Twice the pixels: only a canvas keeps them (the map's), and it is the one part of a picture that is not redrawn sharp.
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'en-US' });
  await ctx.route(u => !u.href.startsWith(origin), r => r.abort());
  await ctx.addInitScript(`window.__toSvg = ${toSvg.toString()};`);
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
  const file = path.join(OUT, `${name}.svg`);
  // A number field is written in the browser's own language, which on a Mac is the computer's: a French one
  // showed 0,595 beside 7.15 m, and neither the page's language nor the browser's switches change that. For
  // the time of the picture the fields are plain text, which shows the value as the page holds it, 0.595.
  const pg = page ?? target.page();
  await pg.evaluate(() => document.querySelectorAll('input[type=number]').forEach(el => { el.setAttribute('data-number', ''); el.type = 'text'; }));
  let shot;
  try {
    if (target.screenshot) { await target.scrollIntoViewIfNeeded(); shot = await target.evaluate(el => window.__toSvg(el, null)); }
    else shot = await pg.evaluate(clip => window.__toSvg(null, clip), target);
  } finally {
    await pg.evaluate(() => document.querySelectorAll('input[data-number]').forEach(el => { el.type = 'number'; el.removeAttribute('data-number'); }));
  }
  fs.writeFileSync(file, shot.svg);
  // The picture it replaces, from before the pictures were SVG.
  fs.rmSync(path.join(OUT, `${name}.png`), { force: true });
  sizes[name] = { w: shot.w, h: shot.h };
  console.log(`  ${name}.svg  ${sizes[name].w} x ${sizes[name].h}  ${Math.round(shot.svg.length / 1024)} kB${target.screenshot ? '' : `, from ${shot.from}`}`);
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
const total = fs.readdirSync(OUT).filter(f => f.endsWith('.svg')).reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`${Object.keys(sizes).length} pictures in docs-img, ${Math.round(total / 1024)} kB in all${errors.length ? `; page errors: ${errors.slice(0, 3).join(' | ')}` : ''}`);
