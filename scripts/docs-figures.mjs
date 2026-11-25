/**
 * The figures and the worked example of the documentation page, computed by
 * the designer's own engine.
 *
 *   node scripts/docs-figures.mjs           rewrites the generated parts of pixel-grid-docs.html
 *   node scripts/docs-figures.mjs --check   says whether the page carries them, and changes nothing
 *
 * Each part stands between <!-- gen:NAME --> and <!-- /gen:NAME --> on the
 * page. The engine suite builds the same parts and fails when the page does
 * not carry them, so a figure or a number of the example cannot drift from
 * what the designer computes. Run this after a change to the engine that
 * moves one.
 *
 * Nothing here is drawn by hand: a purity printed in a pixel is ownShare's, a
 * count is the engine's, a row of the example's table is ladderStep's. What
 * the prose says of them is held by `need`: the build stops when a sentence
 * is no longer true.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import proj4 from 'proj4';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'pixel-grid-docs.html');

const need = (cond, what) => { if (!cond) throw new Error(`docs-figures: no longer true, ${what}`); };
/** A coordinate, to the tenth of a unit. */
const c = v => String(+v.toFixed(1));
const int = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** A length in metres as the page writes one: 40, 7.15, 29.6. */
const m = v => String(+v.toFixed(2));

/** One figure: the drawing, and what it shows in a sentence or two. */
const figure = (w, h, label, body, caption) =>
  `<figure class="fig" style="--w: ${c(w)}px"><svg viewBox="0 0 ${c(w)} ${c(h)}" role="img" aria-label="${label}">${body}</svg><figcaption>${caption}</figcaption></figure>`;
const rect = (x, y, w, h, attrs) => `<rect x="${c(x)}" y="${c(y)}" width="${c(w)}" height="${c(h)}" ${attrs}/>`;
const line = (x1, y1, x2, y2, cls) => `<line x1="${c(x1)}" y1="${c(y1)}" x2="${c(x2)}" y2="${c(y2)}" class="${cls}"/>`;
const circle = (x, y, r, attrs) => `<circle cx="${c(x)}" cy="${c(y)}" r="${c(r)}" ${attrs}/>`;
const text = (x, y, s, cls = '', anchor = 'start') => `<text x="${c(x)}" y="${c(y)}"${cls ? ` class="${cls}"` : ''}${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}>${s}</text>`;

const path2 = (pts, cls) => `<path d="${pts.map(([x, y], k) => `${k ? 'L' : 'M'}${c(x)} ${c(y)}`).join('')}" class="${cls}"/>`;
/** A double-headed measure between two points, with its label. */
const measure = (x1, y1, x2, y2, label, { side = 1, cls = 'dim' } = {}) => {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, nx = -uy * side, ny = ux * side;
  const head = (x, y, sgn) => `<path d="M${c(x)} ${c(y)}l${c(sgn * 5 * ux + 2.5 * nx)} ${c(sgn * 5 * uy + 2.5 * ny)}l${c(-5 * nx)} ${c(-5 * ny)}z" class="${cls}-fill"/>`;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  return line(x1, y1, x2, y2, cls) + head(x1, y1, 1) + head(x2, y2, -1)
    + (label ? text((x1 + x2) / 2 + (horizontal ? 0 : 8 * side), (y1 + y2) / 2 + (horizontal ? -6 * side + (side < 0 ? 8 : 0) : 4), label, '', horizontal ? 'middle' : side > 0 ? 'start' : 'end') : '');
};
/** A chart's frame: the axes, their ticks and labels, and the two scales. */
const frame = ({ X, Y, W, H, x: [x0, x1], y: [y0, y1], xt = [], yt = [], xl = '', yl = '', xf = String, yf = String, xlog = false, ylog = false }) => {
  const fx = v => (xlog ? Math.log10(v) : v), fy = v => (ylog ? Math.log10(v) : v);
  const px = v => X + ((fx(v) - fx(x0)) / (fx(x1) - fx(x0))) * W, py = v => Y + H - ((fy(v) - fy(y0)) / (fy(y1) - fy(y0))) * H;
  let g = '';
  for (const t of yt) g += line(X, py(t), X + W, py(t), 'rule') + text(X - 7, py(t) + 4, yf(t), 't-tick', 'end');
  for (const t of xt) g += line(px(t), Y + H, px(t), Y + H + 4, 'axis') + text(px(t), Y + H + 16, xf(t), 't-tick', 'middle');
  g += line(X, Y + H, X + W, Y + H, 'axis') + line(X, Y, X, Y + H, 'axis');
  if (xl) g += text(X + W / 2, Y + H + 33, xl, '', 'middle');
  if (yl) g += text(X - 4, Y - 9, yl);
  return { g, px, py };
};
/** A key: a swatch and its name, one after the other on a line. */
const key = (x, y, items) => items.map(([swatch, label], k) => `<g transform="translate(${c(x + items.slice(0, k).reduce((a, q) => a + 26 + q[1].length * 6.4, 0))} ${c(y)})">${swatch}${text(18, 4, label)}</g>`).join('');

/**
 * Every generated part of the page, by name. `load` imports one of the
 * designer's modules, transpiled (the suite hands in its own build).
 */
export async function docsParts(load) {
  const sim = await load('src/pixel-grid/simulate.ts');
  const { SOURCES, ladderRungs, sourceCe90 } = await load('src/pixel-grid/sensors.ts');
  const { normCdf, ownShare, imageCases, pureScales } = await load('src/pixel-grid/plot-size.ts');
  const { ce90Shifts, CE90_TO_SIGMA } = await load('src/pixel-grid/resolving.ts');
  const { suggestBlockDesign } = await load('src/pixel-grid/suggest-design.ts');
  const { ladderStep } = await load('src/pixel-grid/ladder-step.ts');
  const { pixelVerdicts } = await load('src/pixel-grid/pixel-verdicts.ts');
  const { trialExtent } = await load('src/pixel-grid/ladder.ts');
  const { seatedPlacement } = await load('src/pixel-grid/trial-seat.ts');
  const { aoiUtmOrigin } = await load('src/pixel-grid/s2-grid.ts');
  const [CA, CB, CC, CD] = sim.CROP_COLORS;

  // Sentinel-2's 10 m bands: the satellite every figure of the model is drawn for.
  const S2 = SOURCES.find(q => q.id === 's2-10');
  const GSD = S2.res, SIG = S2.psf * GSD, FWHM = SIG * 2.3548, THR = 0.9;
  // The CE90 of a satellite as the page holds it: its provider's figure for an image as delivered (sensors.ts sourceCe90).
  const DELIVERED = { auto: false, manualM: 0, provider: true };
  const ceFor = id => { const q = SOURCES.find(z => z.id === id); return Math.round(sourceCe90(id, q.res, DELIVERED) * 100) / 100; };
  const CE = ceFor(S2.id), SIG_GEO = CE / CE90_TO_SIGMA, SIG_EFF = Math.hypot(SIG, SIG_GEO);
  const parts = {};

  // ---- How a pixel is read: the spot of a pixel that lies inside its plot, 5 m from the border.
  {
    const s = 5, X0 = 220, top = 26, half = 20, hTop = 2 * half * s;       // 5 px to the metre, the border at x = 0
    const px = x => X0 + x * s, py = y => top + (half - y) * s;
    const cx = -GSD / 2, cy = GSD / 2;                                     // the pixel's centre
    const own = normCdf((0 - cx) / SIG);
    need(Math.round(own * 100) === 80, 'a Sentinel-2 pixel 5 m inside a border keeps 80 % of its signal');
    let g = '';
    g += rect(px(-40), py(half), 40 * s, hTop, `fill="${CA}" opacity="0.5"`) + rect(px(0), py(half), 40 * s, hTop, `fill="${CB}" opacity="0.5"`);
    for (let x = -40; x <= 40; x += GSD) g += line(px(x), py(half), px(x), py(-half), 'grid');
    for (let y = -half; y <= half; y += GSD) g += line(px(-40), py(y), px(40), py(y), 'grid');
    g += line(px(0), py(half), px(0), py(-half), 'ink w2');
    g += rect(px(cx - GSD / 2), py(cy + GSD / 2), GSD * s, GSD * s, 'class="ink w2"');
    g += circle(px(cx), py(cy), (FWHM / 2) * s, 'class="ink dash"') + circle(px(cx), py(cy), 2.146 * SIG * s, 'class="ink dot"');
    g += circle(px(cx), py(cy), 2, 'class="solid"');
    g += text(px(-38), top - 8, 'its own plot') + text(px(38), top - 8, 'the neighbouring plot', '', 'end');
    // The same spot in profile: the share of the signal on each side of the border is the area under the curve.
    const base = top + hTop + 104, amp = 78;
    const curve = (a, b) => { let d = ''; for (let x = a; x <= b + 1e-9; x += 1) d += `${d ? 'L' : 'M'}${c(px(x))} ${c(base - amp * Math.exp(-((x - cx) ** 2) / (2 * SIG * SIG)))}`; return d; };
    g += `<path d="${curve(-40, 0)}L${c(px(0))} ${c(base)}L${c(px(-40))} ${c(base)}Z" fill="${CA}" opacity="0.55"/>`;
    g += `<path d="${curve(0, 40)}L${c(px(40))} ${c(base)}L${c(px(0))} ${c(base)}Z" fill="${CB}" opacity="0.8"/>`;
    g += `<path d="${curve(-40, 40)}" class="ink"/>` + line(px(-40), base, px(40), base, 'grid') + line(px(0), base - amp - 8, px(0), base, 'ink w2');
    g += text(px(cx) - 34, base - 22, `${Math.round(own * 100)} %`, 't-strong', 'middle') + text(px(9), base - 22, `${Math.round((1 - own) * 100)} %`, 't-strong');
    g += text(px(-40), base + 16, 'weight of the ground in the pixel’s signal, across the border');
    parts.spot = figure(440, base + 24, 'A pixel inside its plot, and its blur spot reaching the neighbouring plot',
      g, `Sentinel-2. The outlined pixel is inside its plot, with one edge on the border. The dashed circle is the FWHM (${m(FWHM)} m) and the dotted one contains 90 % of the signal. ${Math.round((1 - own) * 100)} % of the pixel's signal comes from the neighbouring plot.`);
  }

  // ---- A 40 m plot among others, on Sentinel-2 pixels.
  const L = 40, plot = { a: L, b: L };
  /** The pixels of a grid whose centres are (ox, oy) from the plot's centre, with what each is for that plot. */
  const pixelsOf = (ox, oy, ce90 = 0, thr = THR, side = L) => {
    const lands = ce90 > 0 ? ce90Shifts(ce90, 0) : [], pl = { a: side, b: side }, reach = Math.max(40, side / 2 + 2 * GSD);
    const out = [], n = Math.ceil(reach / GSD) + 1;
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const x = ox + i * GSD, y = oy + j * GSD;
      if (Math.abs(x) > reach - GSD / 2 + 1e-9 || Math.abs(y) > reach - GSD / 2 + 1e-9) continue;
      const share = ownShare(x, y, pl, SIG), pure = share >= thr;
      out.push({ x, y, share, pure, held: pure && lands.every(([dx, dy]) => ownShare(x + dx, y + dy, pl, SIG) >= thr) });
    }
    return out;
  };
  /** One panel: the plot, its eight neighbours, the grid, and the pure pixels outlined. */
  const panel = (X, Y, s, ox, oy, { pct = false, ce90 = 0, ring = null, thr = THR } = {}) => {
    const px = x => X + (40 + x) * s, py = y => Y + (40 - y) * s, W = 80 * s;
    let g = `<svg x="${c(X)}" y="${c(Y)}" width="${c(W)}" height="${c(W)}" viewBox="${c(X)} ${c(Y)} ${c(W)} ${c(W)}">`;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const fill = a === 0 && b === 0 ? CA : a === 0 || b === 0 ? CB : CC;
      g += rect(px(a * L - L / 2), py(b * L + L / 2), L * s, L * s, `fill="${fill}" opacity="${a === 0 && b === 0 ? 0.6 : 0.28}"`);
    }
    for (let k = -5; k <= 5; k++) {
      const ex = ox + (k + 0.5) * GSD, ey = oy + (k + 0.5) * GSD;
      g += line(px(ex), Y, px(ex), Y + W, 'grid') + line(X, py(ey), X + W, py(ey), 'grid');
    }
    g += rect(px(-L / 2), py(L / 2), L * s, L * s, 'class="ink"');
    const pix = pixelsOf(ox, oy, ce90, thr);
    for (const p of pix) {
      if (pct && Math.abs(p.x) < L / 2 && Math.abs(p.y) < L / 2) g += text(px(p.x), py(p.y) + 4, (p.share * 100).toFixed(1), p.pure ? 't-num' : 't-num faint', 'middle');
      if (p.pure) g += rect(px(p.x - GSD / 2) + 1.5, py(p.y + GSD / 2) + 1.5, GSD * s - 3, GSD * s - 3, `class="pure${ce90 > 0 && !p.held ? ' dash' : ''}"`);
    }
    if (ring) {
      g += circle(px(ring[0]), py(ring[1]), ce90 * s, 'class="accent"');
      for (const [dx, dy] of ce90Shifts(ce90, 0)) g += circle(px(ring[0] + dx), py(ring[1] + dy), 2, 'class="accent-fill"');
    }
    return { svg: g + '</svg>', pure: pix.filter(p => p.pure).length, held: pix.filter(p => p.held).length };
  };
  {
    const p = panel(10, 10, 4, GSD / 2, GSD / 2, { pct: true });
    const inside = pixelsOf(GSD / 2, GSD / 2).filter(q => Math.abs(q.x) < L / 2 && Math.abs(q.y) < L / 2);
    const shares = [...new Set(inside.map(q => (q.share * 100).toFixed(1)))].sort((a, b) => b - a);
    need(inside.length === 16 && p.pure === 4 && shares.length === 3, 'a 40 m plot holds 16 Sentinel-2 pixels, 4 of them pure, at three purities');
    parts.plot = figure(340, 340, 'The purity of each Sentinel-2 pixel of a 40 m plot',
      p.svg, `A 40 m plot among other plots, with its edges on pixel edges. It contains ${inside.length} Sentinel-2 pixels, each labelled with its purity in percent. Only the ${p.pure} central ones reach 90 % (outlined). An edge pixel has ${shares[1]} % and a corner pixel ${shares[2]} %.`);
  }

  // ---- The same plot, the grid at its best and at its worst position (no geolocation error).
  {
    // Every position of the grid on the plot, to the half metre: which keeps the most pure pixels, and which the fewest.
    let most = 0, fewest = Infinity;
    for (let ox = 0; ox < GSD; ox += 0.5) for (let oy = 0; oy < GSD; oy += 0.5) {
      const n = pixelsOf(ox, oy).filter(q => q.pure).length;
      if (n > most) most = n;
      if (n < fewest) fewest = n;
    }
    const best = panel(10, 30, 3, 0, 0), worst = panel(280, 30, 3, GSD / 2, GSD / 2);
    need(best.pure === most && worst.pure === fewest && most > fewest, 'a grid centred on the plot keeps the most pure pixels and a grid on its edges the fewest');
    parts.position = figure(530, 280, 'The same plot with the pixel grid at two positions',
      text(130, 20, `Pixel centred on the plot: ${best.pure} pure`, 't-strong', 'middle') + text(400, 20, `Pixel edges on its edges: ${worst.pure} pure`, 't-strong', 'middle') + best.svg + worst.svg,
      `The same 40 m plot and 10 m pixels at two grid positions: the best (${best.pure} pure pixels) and the worst (${worst.pure}) when there is no geolocation error. A fixed grid is counted at the first and a tasked grid at the second. With a geolocation error the order is reversed (see the figure under <a href="#hold">Pixels that hold</a>).`);
  }

  // ---- With the geolocation error: pure, and holding.
  {
    const a = panel(10, 30, 3, 0, 0, { ce90: CE, ring: [0, 0] }), b = panel(280, 30, 3, GSD / 2, GSD / 2, { ce90: CE, ring: [GSD / 2, GSD / 2] });
    need(a.pure > b.pure && a.held < b.held && b.held === b.pure, 'the position with the most pure pixels is not the one where the most hold');
    parts.hold = figure(530, 280, 'Pure pixels and pixels that hold, at two positions of the grid',
      text(130, 20, `${a.pure} pure, ${a.held} ${a.held === 1 ? 'holds' : 'hold'}`, 't-strong', 'middle') + text(400, 20, `${b.pure} pure, ${b.held} hold`, 't-strong', 'middle') + a.svg + b.svg,
      `The same plot with Sentinel-2's CE90 as delivered, ${m(CE)} m. The circle shows where the image can land. Solid outline: holds. Dashed: pure only with the image exactly in place. Left: the position with the most pure pixels (${a.pure}, of which ${a.held} ${a.held === 1 ? 'holds' : 'hold'}). Right: the position where the most hold (${b.held} of ${b.pure}).`);
  }

  // ---- The three sigmas, to scale.
  {
    const s = 5, X = 10, Y = 10, W = 50 * s, cx = X + W / 2, cy = Y + W / 2;
    let g = rect(X, Y, W, W, `fill="${CA}" opacity="0.18"`);
    for (let k = 0; k <= 5; k++) g += line(X + k * GSD * s, Y, X + k * GSD * s, Y + W, 'grid') + line(X, Y + k * GSD * s, X + W, Y + k * GSD * s, 'grid');
    g += circle(cx, cy, SIG * s, 'class="ink"') + circle(cx, cy, SIG_GEO * s, 'class="ink dash"') + circle(cx, cy, SIG_EFF * s, 'class="accent w2"') + circle(cx, cy, 2, 'class="solid"');
    const lx = X + W + 22;
    g += line(lx, 60, lx + 26, 60, 'ink') + text(lx + 34, 64, `σ<tspan class="sub" dy="3">PSF</tspan><tspan dy="-3"> = ${m(SIG)} m, the blur</tspan>`);
    g += line(lx, 90, lx + 26, 90, 'ink dash') + text(lx + 34, 94, `σ<tspan class="sub" dy="3">geo</tspan><tspan dy="-3"> = ${m(SIG_GEO)} m, the geolocation error</tspan>`);
    g += line(lx, 120, lx + 26, 120, 'accent w2') + text(lx + 34, 124, `σ<tspan class="sub" dy="3">eff</tspan><tspan dy="-3"> = ${m(SIG_EFF)} m, the two combined</tspan>`);
    need(SIG_EFF / SIG < 1.25, "Sentinel-2's geolocation error adds less than a quarter to its blur");
    parts.sigmas = figure(570, 270, 'The blur, the geolocation error and the effective blur as rings of one sigma',
      g, `Sentinel-2 on its 10 m pixels, to scale. Each ring is one σ from the pixel's centre. With the CE90 as delivered (${m(CE)} m), σ<sub>eff</sub> is ${Math.round((SIG_EFF / SIG - 1) * 100)} % wider than σ<sub>PSF</sub>.`);
  }

  // ---- Every satellite: its blur spot against its pixel.
  {
    const sats = SOURCES.filter(q => q.id !== 'custom');
    const u = 12, cw = 98, ch = 140, perRow = 6;
    let g = '', widest = sats[0];
    sats.forEach((q, k) => {
      const r = q.psf * 2.3548, x = 6 + (k % perRow) * cw + cw / 2, y = 6 + Math.floor(k / perRow) * ch + 44;
      if (r > widest.psf * 2.3548) widest = q;
      g += rect(x - u / 2, y - u / 2, u, u, `fill="${q.kind === 'catalog' ? CB : CA}" opacity="0.85"`) + circle(x, y, (r * u) / 2, 'class="ink"');
      g += text(x, y + 56, q.short, '', 'middle') + text(x, y + 71, q.resLabel, 't-num', 'middle') + text(x, y + 86, `r = ${r.toFixed(2)}`, 't-num', 'middle');
    });
    need(widest.id === 'pleiades-ps' && Math.round(widest.psf * 2.3548) === 6, 'Pléiades pansharpened has the widest spot for its pixel, six pixels');
    parts.sats = figure(6 + perRow * cw + 6, 6 + Math.ceil(sats.length / perRow) * ch, 'The blur spot of each satellite against its pixel',
      g, `The blur spot (circle, the FWHM) and the pixel (square) of each satellite, with all pixels drawn at the same size. Blue: fixed grid. Orange: tasked. ${widest.provider.replace(' · ', ' ')} has ${widest.resLabel} pixels and a spot ${Math.round(widest.psf * 2.3548)} pixels wide.`);
  }

  // ---- The four layouts the designer lays out itself.
  {
    const tw = 130, th = 100, gap = 20;
    const frame = (k, body, label) => `<g transform="translate(${k * (tw + gap) + 4} 4)">${body}${rect(0, 0, tw, th, 'class="grid"')}${text(tw / 2, th + 17, label, '', 'middle')}</g>`;
    let rows = '', cols = '', chk = '';
    for (let k = 0; k < 10; k++) rows += rect(0, k * 10, tw, 10, `fill="${k % 2 ? CB : CA}" opacity="0.75"`);
    for (let k = 0; k < 13; k++) cols += rect(k * 10, 0, 10, th, `fill="${k % 2 ? CB : CA}" opacity="0.75"`);
    for (let i = 0; i < 13; i++) for (let j = 0; j < 10; j++) chk += rect(i * 10, j * 10, 10, 10, `fill="${(i + j) % 2 ? CB : CA}" opacity="0.75"`);
    // The randomised blocks are the engine's own draw, with its rule that keeps a species from standing beside itself in the next block.
    const plan = sim.buildBlockPlan({ nSpecies: 4, nBlocks: 4, plotLength: 12, plotWidth: 4, plotAlley: 0.6, blockAlley: 2, blocksPerRow: 2, seed: 1 }, { centerU: 0, centerV: 0 });
    const s = Math.min(tw / plan.totalU, th / plan.totalV) * 0.94, bx = (tw - plan.totalU * s) / 2, by = (th - plan.totalV * s) / 2;
    let blk = rect(0, 0, tw, th, 'fill="#8b5a2b" opacity="0.35"');
    for (const p of sim.blockPlots(plan)) blk += rect(bx + (p.u0 - plan.u0) * s, by + (p.v0 - plan.v0) * s, (p.u1 - p.u0) * s, (p.v1 - p.v0) * s, `fill="${sim.CROP_COLORS[p.species]}" opacity="0.85"`);
    need(sim.blockPlots(plan).length === 16, 'four species in four blocks make sixteen plots');
    parts.designs = figure(4 * tw + 3 * gap + 8, th + 30, 'The four layouts: rows, columns, checkerboard and randomised blocks',
      frame(0, rows, 'Alternating rows') + frame(1, cols, 'Alternating columns') + frame(2, chk, 'Checkerboard') + frame(3, blk, 'Randomised blocks'),
      'The four built-in layouts. Randomised blocks are shown with 4 species, 4 blocks, 2 blocks per row and alleys in brown.');
  }

  // ---- The worked example: four varieties, four repetitions, Sentinel-2.
  {
    const E0 = 619203.7, N0 = 5600764.3, epsg = 32631;
    // What each "Open this example" link opens (src/pixel-grid/examples.ts) is held against what its example is computed with.
    const EX = await load('src/pixel-grid/examples.ts');
    const seedOf = id => EX.DOC_EXAMPLES.find(q => q.id === id).seed;
    const sorted = v => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v);
    const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
    need(EX.EXAMPLE_E0 === E0 && EX.EXAMPLE_N0 === N0 && EX.EXAMPLE_EPSG === epsg && EX.DOC_EXAMPLES.map(q => q.id).join() === 'file,fit,varieties,reps', 'the designer opens the four examples, on the field they are computed on');
    const opensOn = (id, sat, thr) => { const q = seedOf(id), src = SOURCES.find(z => z.id === sat); return q.sourceId === sat && q.sigmaX === src.psf && q.sigmaY === src.psf && q.threshold === thr && q.geoTyped === false && q.placeFor === 'held' && q.rotation === 0; };
    const toLL = proj4('+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs', 'EPSG:4326');
    const world = (design, side, rot, geo = {}) => {
      const [w, so] = toLL.forward([E0, N0]), [e, n] = toLL.forward([E0 + side, N0 + side]);
      const aoi = [w, so, e, n], origin = aoiUtmOrigin(aoi, epsg), env = sim.utmEnvelope(aoi, epsg);
      const layout = { pattern: 'block', width: 2, spacing: 0, rotationDeg: rot, block: sim.buildBlockPlan(design, sim.blockPlacement(env, origin, rot, GSD, true)) };
      return { aoi, origin, env, ctx: { aoi, fieldRing: null, epsg, layout, threshold: THR * 100, blockDesign: design, importedAngle: 0, importedFileAngle: 0, importedBasePlan: undefined, geoAuto: false, geoManual: 0, geoProvider: true, placeFor: 'held', ...geo } };
    };
    const rungs = ladderRungs({ id: S2.id, res: GSD, sigmaX: S2.psf, sigmaY: S2.psf });
    const rowsOf = (wd, rot) => rungs.map(rung => ({ rung, step: ladderStep(wd.ctx, rot, rung, true) }));
    const tally = st => st.plotsRobust ?? st.plots;
    const rowOf = (rows, id) => rows.find(q => q.rung.id === id).step;

    // 1. The usual micro-plots.
    // The design the page opens with (use-simulation.ts blockDesign): the step asks nothing of the reader.
    const micro = { nSpecies: 4, nBlocks: 4, plotLength: 8, plotWidth: 2, plotAlley: 0.5, blockAlley: 1.5, blocksPerRow: 1, seed: 1 };
    const microRows = rowsOf(world(micro, 120, 0), 0);
    const isPan = q => /pansharpened/.test(SOURCES.find(z => z.id === q.rung.id).provider);
    const nameOf = q => SOURCES.find(z => z.id === q.rung.id).provider.replace(' · ', ' ');
    need(microRows.filter(q => !isPan(q)).every(q => q.step.pureCount === 0), 'no satellite but the pansharpened ones keeps a pure pixel of a micro-plot of 8 x 2 m');
    const microPan = microRows.filter(q => isPan(q) && q.step.pureCount > 0);
    need(microPan.length >= 1 && microPan.every(q => tally(q.step) && tally(q.step).none > 0), 'a pansharpened product counts pure pixels in a micro-plot, and none holds a pixel in every plot');
    const microPure = microPan.map((q, k) => {
      const t = tally(q.step), kept = t.plots - t.none;
      return `${nameOf(q)} ${Math.round(q.step.resolvingPct)} %${k ? '' : ' of the planted crop'}${kept === 0 ? '' : `, with a pixel that holds in ${kept} of the ${t.plots} plots`}`;
    });

    // 2. What Sentinel-2 asks of a square plot, in the three readings.
    const wanted = [1, 4, 9];
    const cases = imageCases(SIG, CE, SIG_GEO);
    need(Math.round(pureScales({ a: GSD, b: GSD }, { gsd: GSD, sigma: SIG, shift: 0, threshold: THR, angleDeg: 0 }, [1])[0]) === 3, 'one pure Sentinel-2 pixel asks for a plot three pixels wide');
    const sizes = cases.map(q => pureScales({ a: GSD, b: GSD }, { gsd: GSD, sigma: q.sigma, shift: q.shift, threshold: THR, angleDeg: 0 }, wanted).map(sc => GSD * sc));
    need(cases.length === 3 && sizes.every(col => col.every((v, k) => v > 0 && (k === 0 || v > col[k - 1]))) && wanted.every((_, k) => sizes[0][k] < sizes[1][k] && sizes[1][k] < sizes[2][k]),
      'the three readings ask for more and more, and more pixels for a larger plot');
    // As the card gives them for Sentinel-2, whose grid is fixed and known: a plot at its best place on it (PlotSize.tsx).
    const best = cases.map(q => pureScales({ a: GSD, b: GSD }, { gsd: GSD, sigma: q.sigma, shift: q.shift, threshold: THR, angleDeg: 0 }, wanted, 'best').map(sc => GSD * sc));
    need(best.every(col => col.every((v, k) => v > 0 && (k === 0 || v > col[k - 1]))) && wanted.every((_, k) => best[0][k] < best[1][k] && best[1][k] < best[2][k])
      && best.every((col, j) => col.every((v, k) => v < sizes[j][k])), 'at its best place on the grid a plot asks less in every reading, and still more for more pixels');

    // 3. The trial built for it.
    const ask = { nSpecies: 4, nBlocks: 4, pixels: 4, res: GSD, sigmaX: S2.psf, sigmaY: S2.psf, threshold: THR, anyPosition: false,
      placeHeldM: CE, ce90M: CE, plotAlley: 0, blockAlley: 0, field: null };
    const built = suggestBlockDesign(ask);
    need(built && built.held === 4 && built.design.plotLength === built.design.plotWidth && built.design.plotAlley === 0 && Math.ceil(built.design.nBlocks / built.design.blocksPerRow) === 1,
      'the suggestion for four pixels that hold is a square plot, plots touching, in one row of blocks');
    const d = built.design, side = d.plotLength;
    need(opensOn('varieties', S2.id, THR * 100) && same(seedOf('varieties').blockDesign, d) && seedOf('varieties').wantPure === ask.pixels && seedOf('varieties').pattern === 'block',
      'the link of the Sentinel-2 example opens the trial it describes: the same plots, satellite, threshold and CE90');
    need(side < sizes[2][1] && side % GSD === 0, 'a plot laid on the fixed grid is smaller than the size asked of a grid that falls anywhere, and a whole number of pixels');
    need(side >= best[2][1] && side - best[2][1] < GSD, 'the plot built is the card size for four pixels that hold, rounded up to whole pixels');
    const ha = (built.footprint[0] * built.footprint[1]) / 10000;
    need(side === L, 'the plot built is the 40 m plot of the figures');
    const atWorst = Math.min(...ce90Shifts(CE, 0).map(([dx, dy]) => ownShare(GSD / 2 + dx, GSD / 2 + dy, plot, SIG)));
    const OFF = 0.5, offHeld = pixelsOf(GSD / 2 + OFF, GSD / 2, CE).filter(q => q.held).length;
    need(atWorst >= THR && atWorst < THR + 0.01 && offHeld < built.held, 'a 40 m plot holds its four pixels with little to spare, and loses some of them half a metre off');

    // 4. The same trial, by every satellite; 5. turned; 6. with the images as delivered.
    const flat = world(d, built.footprint[0] + 120, 0), flatRows = rowsOf(flat, 0);
    need(same(seedOf('varieties').aoi, world(d, built.footprint[0] + 120, 0).aoi), 'and on the same field');
    const TURN = 20, turned = world(d, built.footprint[0] + 160, TURN), turnedRows = rowsOf(turned, TURN);
    // 6. A figure typed: the images registered to each other within a few metres, for every satellite alike.
    const TYPED = 2, typedRows = rowsOf(world(d, built.footprint[0] + 120, 0, { geoProvider: false, geoManual: TYPED }), 0);
    const s2 = rowOf(flatRows, 's2-10'), s2t = rowOf(turnedRows, 's2-10'), s2r = rowOf(typedRows, 's2-10'), pl = rowOf(flatRows, 'planet'), plr = rowOf(typedRows, 'planet');
    need(s2.geoRobustPure === s2.pureCount && tally(s2).min === 4 && tally(s2).none === 0, 'every plot of the trial keeps four Sentinel-2 pixels, and all its pure pixels hold');
    need(['s2-20', 's2-60', 'hls-30', 'ls-30'].every(id => rowOf(flatRows, id).pureCount === 0), 'the 20 m and coarser pixels keep nothing of a 40 m plot');
    const finer = ['wv', 'pleiades', 'planet'].map(id => ({ id, st: rowOf(flatRows, id) }));
    need(finer.every(q => q.st.resolvingPct > s2.resolvingPct) && pl.geoRobustPure === 0 && pl.pureCount > 0, 'the finer native satellites count more pure pixels, and PlanetScope as delivered holds none');
    need(s2t.pureCount > s2.pureCount && s2t.geoRobustPure < s2.geoRobustPure && tally(s2t).min < tally(s2).min, 'turned, the trial keeps more pure pixels and fewer that hold');
    need(plr.geoRobustPure > 0 && tally(plr).none === 0 && s2r.geoRobustPure >= s2.geoRobustPure, 'registered to 2 m, PlanetScope holds pixels in every plot and Sentinel-2 loses none');

    /** The trial of a row, pixel by pixel: the plan the row was counted on, redone here and held against the row's own counts. */
    const drawn = (wd, rot, row) => {
      const rung = rungs.find(q => q.id === S2.id);
      const sensor = { sigmaX: rung.sigmaX, sigmaY: rung.sigmaY, mixThreshold: THR, anyPosition: rung.anyPosition, placeHeldM: CE };
      const [minE, minN, maxE, maxN] = wd.env;
      const box = [Math.floor(minE / GSD) * GSD, Math.floor(minN / GSD) * GSD, Math.ceil(maxE / GSD) * GSD, Math.ceil(maxN / GSD) * GSD];
      const plan = sim.stakeBlockPlan(d, seatedPlacement(d, null, wd.aoi, epsg, box, wd.origin, rot, GSD, true), wd.origin, rot, GSD, sensor, box).plan;
      const layout = { ...wd.ctx.layout, rotationDeg: rot, block: plan };
      const ext = trialExtent(plan, wd.origin, rot, GSD, sensor, box);
      const v = pixelVerdicts({ res: GSD, utmBounds: ext }, wd.origin, layout, sensor, CE);
      const pure = v.pure.reduce((a, x) => a + x, 0), held = v.robust.reduce((a, x) => a + x, 0);
      need(pure === row.pureCount && held === row.geoRobustPure, `the trial drawn at ${rot} degrees is the one its row counted (${pure}/${held} against ${row.pureCount}/${row.geoRobustPure})`);
      return { plan, ext, v, origin: wd.origin, rot, pure, held };
    };
    /** A trial's plots as rings in the grid's metres, with the box around them. */
    const plotsOf = t => {
      const rad = (t.rot * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const en = (u, vv) => [t.origin[0] + u * cos - vv * sin, t.origin[1] + u * sin + vv * cos];
      const plots = sim.blockPlots(t.plan).map(p => ({ species: p.species, ring: [en(p.u0, p.v0), en(p.u1, p.v0), en(p.u1, p.v1), en(p.u0, p.v1)] }));
      const es = plots.flatMap(p => p.ring.map(q => q[0])), ns = plots.flatMap(p => p.ring.map(q => q[1]));
      return { plots, box: [Math.min(...es), Math.min(...ns), Math.max(...es), Math.max(...ns)] };
    };
    /**
     * That trial as a panel `span` metres across, centred on the trial: the
     * plots in their varieties' colours, the pixel grid where it really falls,
     * the pure pixels outlined.
     */
    const trialPanel = (X, Y, size, t, span) => {
      const { plots, box } = plotsOf(t);
      const mE = (box[0] + box[2]) / 2, mN = (box[1] + box[3]) / 2, s = size / span;
      const px = e => X + size / 2 + (e - mE) * s, py = n => Y + size / 2 - (n - mN) * s;
      let g = `<svg x="${c(X)}" y="${c(Y)}" width="${c(size)}" height="${c(size)}" viewBox="${c(X)} ${c(Y)} ${c(size)} ${c(size)}">`;
      for (const p of plots) g += `<polygon points="${p.ring.map(([e, n]) => `${c(px(e))},${c(py(n))}`).join(' ')}" fill="${sim.CROP_COLORS[p.species]}" opacity="0.6" class="plotline"/>`;
      const [e0, n0, e1, n1] = t.ext, nx = Math.round((e1 - e0) / GSD), ny = Math.round((n1 - n0) / GSD);
      for (let i = 0; i <= nx; i++) { const x = px(e0 + i * GSD); if (x >= X - 1 && x <= X + size + 1) g += line(x, Y, x, Y + size, 'grid'); }
      for (let j = 0; j <= ny; j++) { const y = py(n0 + j * GSD); if (y >= Y - 1 && y <= Y + size + 1) g += line(X, y, X + size, y, 'grid'); }
      const inside = (ring, e, n) => { let odd = false; for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) { const [xa, ya] = ring[a], [xb, yb] = ring[b]; if ((ya > n) !== (yb > n) && e < ((xb - xa) * (n - ya)) / (yb - ya) + xa) odd = !odd; } return odd; };
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!t.v.pure[k]) continue;
        const e = e0 + (i + 0.5) * GSD, n = n0 + (j + 0.5) * GSD;
        need(inside(plots[t.v.cover[k] - 1].ring, e, n), 'a pure pixel is drawn inside the plot it is pure for');
        g += rect(px(e - GSD / 2) + 1.2, py(n + GSD / 2) + 1.2, GSD * s - 2.4, GSD * s - 2.4, `class="pure${t.v.robust[k] ? '' : ' dash'}"`);
      }
      return g + '</svg>';
    };
    const tFlat = drawn(flat, 0, s2), tTurn = drawn(turned, TURN, s2t);
    // One scale for the two panels: the turned trial's box, and a pixel and a half around it.
    const span = Math.max(...[tFlat, tTurn].map(t => { const b = plotsOf(t).box; return Math.max(b[2] - b[0], b[3] - b[1]); })) + 3 * GSD;
    const trialFig = figure(640, 330, 'The trial on Sentinel-2 pixels, along the pixel rows and turned by 20 degrees',
      text(155, 20, `Along the pixel rows: ${tFlat.pure} pure, ${tFlat.held} hold`, 't-strong', 'middle') + text(485, 20, `Turned ${TURN}°: ${tTurn.pure} pure, ${tTurn.held} hold`, 't-strong', 'middle')
      + trialPanel(10, 30, 290, tFlat, span) + trialPanel(340, 30, 290, tTurn, span),
      `The sixteen plots on Sentinel-2's 10 m pixels, coloured by variety, both panels at the same scale. Solid outline: holds. Dashed: pure only with the image exactly in place.`);

    const pct = v => (v == null ? 'n/a' : `${Math.round(v)} %`);
    // The designer's table, column for column (the fewest pixels a plot keeps was removed from it on 2026-11-24).
    const tableOf = rows => `<div class="scroll"><table class="narrow"><thead><tr><th>Satellite</th><th class="n">Pixel</th><th class="n">pure</th><th class="n">CE90</th></tr></thead><tbody>${rows.map(({ rung, step }) =>
      `<tr><td>${rung.name}</td><td class="n">${rung.res} m${step.partial ? ' ◦' : ''}</td><td class="n">${pct(step.resolvingPct)}</td><td class="n">${step.geoRobust == null ? '' : pct(step.geoRobust)}</td></tr>`).join('')}</tbody></table></div>`;
    const card = `<div class="scroll"><table class="narrow"><thead><tr><th>Pure pixels in the plot</th><th class="n">shift corrected</th><th class="n">average image</th><th class="n">9 images in 10</th></tr></thead><tbody>${wanted.map((n, k) =>
      `<tr><td>${n}</td>${best.map(col => `<td class="n">${col[k].toFixed(1)} m</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

    parts.example = [
      `<p>Four varieties in four repetitions, in randomised blocks, to be followed over the season with Sentinel-2's 10 m bands.</p>`,
      `<h4>1. Micro-plots</h4>`,
      `<p>The page opens with micro-plots of ${micro.plotLength} × ${micro.plotWidth} m, ${micro.nSpecies} species in ${micro.nBlocks} blocks. Under <b>Across satellites</b>, only pansharpened products have pure pixels in the ${micro.nSpecies * micro.nBlocks} plots (${microPure.join('; ')})${microPan.every(q => tally(q.step).none === tally(q.step).plots) ? ', and none of them holds' : ''}. Pansharpened values <a href="#pansharpened">overestimate purity for an index</a>.</p>`,
      `<h4>2. Plot size for Sentinel-2</h4>`,
      `<p><a href="#plot-size">Plot size required</a> for a square plot (CE90 ${m(CE)} m):</p>`,
      card,
      `<p>One pure pixel requires a plot of ${best[0][0].toFixed(1)} m, and ${best[2][0].toFixed(1)} m if the pixel is selected by its coordinates. Sentinel-2's grid is fixed and known, so these are the sizes of a plot at its best place on the grid. On a grid that can fall anywhere, the same pixel would need ${sizes[0][0].toFixed(1)} m.</p>`,
      `<h4>3. Building the trial</h4>`,
      `<p>In <b>Suggest a design</b>: ${ask.nSpecies} species, ${ask.nBlocks} repetitions, ${ask.pixels} pixels per plot, Sentinel-2, with <i>Pixels must hold within the CE90</i> ticked. Build gives plots of <b>${m(d.plotLength)} × ${m(d.plotWidth)} m</b> (${built.pitchPx[0]} × ${built.pitchPx[1]} pixels, no alleys) in one row of blocks, for a trial of ${m(built.footprint[0])} × ${m(built.footprint[1])} m (${ha.toFixed(2)} ha). Each plot keeps ${built.held} pixels that hold.</p>`,
      `<p>The table's last column asks ${best[2][1].toFixed(1)} m for ${wanted[1]} pixels. Build rounds it up to whole pixels, so that every plot of the trial lies on the grid as the first one does, its edges on pixel edges (see the figure under <a href="#hold">Pixels that hold</a>).</p>`,
      `<p>It is the smallest whole-pixel plot that keeps ${built.held} pixels that hold, with little margin: purity falls to ${(atWorst * 100).toFixed(1)} % at the worst shift of the image (threshold 90 %), and a staking error of ${OFF} m along one side leaves ${offHeld} of the ${built.held} pixels.</p>`,
      `<h4>4. The same trial for every satellite</h4>`,
      tableOf(flatRows),
      `<p class="dim">pure, CE90: the share of the planted crop in pure pixels, and in pixels that hold within the CE90. ◦: counted over the central part of the trial.</p>`,
      `<p>Sentinel-2's 10 m bands have ${int(s2.pureCount)} pure pixels (${pct(s2.resolvingPct)} of the planted crop, ${tally(s2).min} per plot), and all hold. Its 20 m and 60 m bands and Landsat have none. The finer sensors have more pure pixels, even at the worst grid position, but their CE90 as delivered is several pixels, so fewer hold (pure, then holding): ${finer.map(q => `${SOURCES.find(z => z.id === q.id).provider.replace(' · ', ' ')} ${pct(q.st.resolvingPct)}, ${pct(q.st.geoRobust)}`).join('; ')}.</p>`,
      `<h4>5. Rotated by ${TURN}°</h4>`,
      `<p>At ${TURN}° the plot edges cannot lie on pixel edges, and the trial is counted where it is. It has more pure Sentinel-2 pixels (${int(s2t.pureCount)} against ${int(s2.pureCount)}) but only ${int(s2t.geoRobustPure)} of them hold, with ${tally(s2t).min} in the worst plot against ${tally(s2).min}.</p>`,
      trialFig,
      `<h4>6. Registered images</h4>`,
      `<p>With a typed CE90 of ${TYPED} m (images registered to each other), PlanetScope has ${int(plr.geoRobustPure)} pixels that hold, ${tally(plr).min} in its worst plot, instead of none. Sentinel-2 has ${int(s2r.geoRobustPure)}.</p>`,
    ].join('\n          ');

    // ================================================================
    // More examples ("make an examples section where you showcase multiple
    // things", 2026-11-22). Each is a question, what the designer answers,
    // and a drawing of it; every figure is the engine's, and every sentence
    // is held by a need.
    // ================================================================
    const { resolveImportedPlan } = await load('src/pixel-grid/imported-plan.ts');
    const { varietiesOf } = await load('src/pixel-grid/design-import.ts');
    const { trialAngle, bestPlacement } = await load('src/pixel-grid/imported-rotate.ts');
    const { importedTrialExtent } = await load('src/pixel-grid/ladder.ts');
    const srcOf = id => SOURCES.find(z => z.id === id);
    const ceOf = ceFor;
    const askFor = id => { const q = srcOf(id); return { res: q.res, sigmaX: q.psf, sigmaY: q.psf, threshold: THR, anyPosition: q.kind !== 'catalog', placeHeldM: ceOf(id), ce90M: ceOf(id) }; };
    const fullName = id => srcOf(id).provider.replace(' · ', ' ');

    // ---- A trial that already exists, read from a file.
    {
      const ANG = 17, A = 50, Bw = 40, nB = 4, nV = 6, names = ['Alba', 'Brio', 'Cora', 'Dune', 'Elan', 'Faro'];
      const order = [[0, 1, 2, 3, 4, 5], [3, 5, 0, 2, 1, 4], [4, 2, 5, 1, 3, 0], [1, 4, 3, 0, 5, 2]];
      const toUtm = proj4('EPSG:4326', '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs');
      const rad = (ANG * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad), F0 = [E0 + 100, N0 + 100];
      const design = { fileName: 'trial.geojson', columns: ['Plot', 'Variety'], varietyColumn: 'Variety', nameColumn: 'Plot', warnings: [], plots: [] };
      for (let b = 0; b < nB; b++) for (let k = 0; k < nV; k++) {
        const ring = [[b * A, k * Bw], [b * A + A, k * Bw], [b * A + A, k * Bw + Bw], [b * A, k * Bw + Bw]].map(([u, v]) => toUtm.inverse([F0[0] + u * cos - v * sin, F0[1] + u * sin + v * cos]));
        design.plots.push({ rings: [ring], props: { Plot: String(b * nV + k + 1), Variety: names[order[b][k]] } });
      }
      need(opensOn('file', 's2-10', THR * 100) && same(seedOf('file').importedDesign, design) && seedOf('file').pattern === 'imported' && seedOf('file').compareAligned === true && seedOf('file').importedTurn === 0,
        'the link of the file example opens the made-up trial it describes, compared with its best placement');
      const plan = resolveImportedPlan(design, varietiesOf(design), epsg), ang = trialAngle(plan);
      need(plan.plots.length === nB * nV && plan.plotIds && Math.abs(ang - ANG) < 0.01, 'the trial read is the one written: 24 plots at 17 degrees');
      const [w, so] = toUtm.inverse([plan.bbox[0] - 30, plan.bbox[1] - 30]), [e, n] = toUtm.inverse([plan.bbox[2] + 30, plan.bbox[3] + 30]);
      const ctx = { aoi: [w, so, e, n], fieldRing: null, epsg, layout: { pattern: 'imported', width: 2, spacing: 0, rotationDeg: ang, imported: plan }, threshold: THR * 100, blockDesign: d,
        importedAngle: ang, importedFileAngle: ang, importedBasePlan: plan, geoAuto: false, geoManual: 0, geoProvider: true, placeFor: 'held' };
      const shown = ['wv', 'pleiades', 'planet', 's2-10', 's2-20'].map(id => rungs.find(q => q.id === id));
      const rows = shown.map(rung => ({ rung, drawn: ladderStep(ctx, ang, rung, true), best: ladderStep(ctx, 0, rung, false) }));
      const s2r = rows.find(q => q.rung.id === 's2-10'), plr = rows.find(q => q.rung.id === 'planet');
      const full = st => { const t = tally(st); return t ? t.plots - t.none : null; };
      need(s2r.best.geoRobustPure >= 1.5 * s2r.drawn.geoRobustPure && tally(s2r.best).min > tally(s2r.drawn).min && full(s2r.best) === nB * nV,
        'for Sentinel-2 the best placement holds half as many pixels again as the trial as drawn, and more in its worst plot');
      need(plr.drawn.pureCount > 1000 && plr.drawn.geoRobustPure === 0 && plr.best.geoRobustPure === 0 && 2 * ceOf('planet') < Bw, 'for PlanetScope as delivered no pixel holds, as drawn or at any placement');
      // The two placements for Sentinel-2, pixel by pixel, each held against its row.
      const sensor = { sigmaX: S2.psf, sigmaY: S2.psf, mixThreshold: THR, anyPosition: false, placeHeldM: CE };
      const UNCLIPPED = [-Infinity, -Infinity, Infinity, Infinity];
      const seen = (pl, row) => {
        const ext = importedTrialExtent(pl, GSD, sensor, UNCLIPPED), v = pixelVerdicts({ res: GSD, utmBounds: ext }, [0, 0], { pattern: 'imported', width: 2, spacing: 0, rotationDeg: 0, imported: pl }, sensor, CE);
        const pure = v.pure.reduce((x, y) => x + y, 0), held = v.robust.reduce((x, y) => x + y, 0);
        need(pure === row.pureCount && held === row.geoRobustPure, `the imported trial drawn is the one its row counted (${pure}/${held} against ${row.pureCount}/${row.geoRobustPure})`);
        return { pl, ext, v, pure, held };
      };
      const placed = bestPlacement(plan, GSD, sensor, CE);
      const tA = seen(plan, s2r.drawn), tB = seen(placed.plan, s2r.best);
      const boxOf = pl => pl.bbox, span = Math.max(...[plan, placed.plan].map(pl => Math.max(pl.bbox[2] - pl.bbox[0], pl.bbox[3] - pl.bbox[1]))) + 3 * GSD;
      const filePanel = (X, Y, size, t) => {
        const b = boxOf(t.pl), mE = (b[0] + b[2]) / 2, mN = (b[1] + b[3]) / 2, s = size / span, px = v => X + size / 2 + (v - mE) * s, py = v => Y + size / 2 - (v - mN) * s;
        let g = `<svg x="${c(X)}" y="${c(Y)}" width="${c(size)}" height="${c(size)}" viewBox="${c(X)} ${c(Y)} ${c(size)} ${c(size)}">`;
        for (const p of t.pl.plots) g += `<polygon points="${p.rings[0].map(([x, y]) => `${c(px(x))},${c(py(y))}`).join(' ')}" fill="${sim.CROP_COLORS[p.species % sim.CROP_COLORS.length]}" opacity="0.6" class="plotline"/>`;
        const [e0, n0, e1, n1] = t.ext, nx = Math.round((e1 - e0) / GSD), ny = Math.round((n1 - n0) / GSD);
        for (let i = 0; i <= nx; i++) { const x = px(e0 + i * GSD); if (x >= X - 1 && x <= X + size + 1) g += line(x, Y, x, Y + size, 'grid'); }
        for (let j = 0; j <= ny; j++) { const y = py(n0 + j * GSD); if (y >= Y - 1 && y <= Y + size + 1) g += line(X, y, X + size, y, 'grid'); }
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i; if (t.v.pure[k]) g += rect(px(e0 + i * GSD) + 1.2, py(n0 + (j + 1) * GSD) + 1.2, GSD * s - 2.4, GSD * s - 2.4, `class="pure${t.v.robust[k] ? '' : ' dash'}"`); }
        return g + '</svg>';
      };
      const fig = figure(640, 330, 'A trial read from a file on Sentinel-2 pixels, as drawn and at its best placement',
        text(155, 20, `As the file draws it, ${m(+ang.toFixed(1))}°: ${tA.pure} pure, ${tA.held} hold`, 't-strong', 'middle') + text(485, 20, `Best placement, ${m(+placed.angle.toFixed(1))}°: ${tB.pure} pure, ${tB.held} hold`, 't-strong', 'middle')
        + filePanel(10, 30, 290, tA) + filePanel(340, 30, 290, tB),
        `The ${nB * nV} plots on Sentinel-2's 10 m pixels, coloured by variety. Solid outline: holds. Dashed: pure only with the image exactly in place.`);
      const cellOf = st => `${int(st.pureCount)} · ${st.geoRobustPure == null ? '' : int(st.geoRobustPure)}`;
      const sampled = rows.some(q => q.drawn.partial || q.best.partial);
      // No column of plots: the count per plot left the designer's table on 2026-11-24.
      const table = `<div class="scroll"><table class="narrow"><thead><tr><th>Satellite</th><th class="n">Pixel</th><th class="n">as drawn</th><th class="n">best</th><th class="n">angle</th></tr></thead><tbody>${rows.map(({ rung, drawn: a, best: b }) =>
        `<tr><td>${rung.name}</td><td class="n">${rung.res} m${a.partial || b.partial ? ' ◦' : ''}</td><td class="n">${cellOf(a)}</td><td class="n">${cellOf(b)}</td><td class="n">${b.placement ? `${m(+b.placement.angle.toFixed(1))}°` : ''}</td></tr>`).join('')}</tbody></table></div>`;
      parts.exFile = [
        `<p>An existing trial: ${nB * nV} plots of ${A} × ${Bw} m, ${nV} varieties in ${nB} repetitions, at ${ANG}° to the pixel rows. The plots are imported from a file (made up for this example), with the <b>Variety</b> column as the variety. The table is the <span class="f">vs best</span> comparison (see <a href="#imported">Best placement</a>).</p>`,
        table,
        `<p class="dim">as drawn, best: pure pixels, then those that hold (the designer's table gives shares). angle: angle of the best placement.${sampled ? ' ◦: counted over the central part of the trial.' : ''}</p>`,
        `<p>The placement has the largest effect for Sentinel-2: the pixels that hold go from ${int(s2r.drawn.geoRobustPure)} as drawn (${tally(s2r.drawn).min} in the worst plot) to ${int(s2r.best.geoRobustPure)} at ${m(+s2r.best.placement.angle.toFixed(1))}° on the grid (${tally(s2r.best).min} per plot). For PlanetScope, none of the ${int(plr.drawn.pureCount)} pure pixels holds at any placement, with a CE90 of ${m(ceOf('planet'))} m as delivered.</p>`,
        fig,
      ].join('\n          ');
    }

    // ---- The two examples that start from a field (2026-11-25), computed as Build computes them
    // (PixelGridApp.tsx buildSuggested): suggestBlockDesign on the field, held by the field's own
    // seat, on each satellite's own lattice, with its CE90 as delivered.
    const { fieldSeat } = await load('src/pixel-grid/trial-seat.ts');
    const { latticePhase } = await load('src/pixel-grid/sensors.ts');
    const suggestOn = (fieldUV, rung, reps) => {
      const ground = EX.exampleField(...fieldUV), [e0, n0, e1, n1] = sim.utmEnvelope(ground, epsg), F = { u: e1 - e0, v: n1 - n0 };
      const fitsField = (u, v) => { const seat = fieldSeat(null, ground, epsg, u, v, 0); return seat ? seat.clearance > rung.res : u + 2 * rung.res <= F.u + 1e-6 && v + 2 * rung.res <= F.v + 1e-6; };
      const r = rung.res, [pE, pN] = latticePhase(rung.id, r, epsg);
      const steps = sim.stakeMesh([Math.floor((e0 - pE) / r) * r + pE, Math.floor((n0 - pN) / r) * r + pN, Math.ceil((e1 - pE) / r) * r + pE, Math.ceil((n1 - pN) / r) * r + pN], r)?.steps;
      const ce = ceOf(rung.id);
      return suggestBlockDesign({ nSpecies: 4, nBlocks: reps, pixels: 4, res: r, sigmaX: rung.sigmaX, sigmaY: rung.sigmaY, threshold: THR, anyPosition: rung.anyPosition,
        placeHeldM: ce, ce90M: ce, plotAlley: 0, blockAlley: 0, field: F, fitsField, stakeSteps: steps, seed: 1, rotationDeg: 0 });
    };
    const fits = b => !!b && b.fits !== false;
    const size = b => `${m(Math.round(b.footprint[0]))} × ${m(Math.round(b.footprint[1]))} m`;
    const rowsOfBlocks = b => Math.ceil(b.design.nBlocks / b.design.blocksPerRow);

    // ---- A field and no satellite: the coarsest satellite whose trial fits.
    {
      const FF = EX.FIT_FIELD, q = seedOf('fit');
      need(opensOn('fit', 's2-10', THR * 100) && q.suggestAsk.sat === 'fit' && q.suggestAsk.hold === true && q.suggestAsk.species === 4 && q.suggestAsk.reps === 4 && q.wantPure === 4
        && q.pattern === 'block' && q.simFold === 'suggest' && same(q.aoi, EX.exampleField(...FF)), 'the link of the field example opens Suggest a design, set to find the coarsest satellite for that field');
      // As Build orders them: native multispectral products, the coarsest first (PixelGridApp.tsx fitOrder).
      const order = rungs.filter(g => g.id !== 'custom' && !/pansharpened/i.test(srcOf(g.id).provider)).sort((a, b) => b.res - a.res), tried = [];
      for (const g of order) { const b = suggestOn(FF, g, 4); tried.push({ g, b }); if (fits(b)) break; }
      const pick = tried[tried.length - 1], before = tried[tried.length - 2];
      need(fits(pick.b) && pick.g.id === 's2-10' && before && before.g.id === 's2-20' && before.b && !fits(before.b), 'in a field of 250 m the coarsest satellite that fits is Sentinel-2 at 10 m, its 20 m bands asking for more');
      const table = `<div class="scroll"><table class="narrow"><thead><tr><th>Satellite, coarsest first</th><th class="n">Pixel</th><th class="n">smallest trial</th><th class="n">fits</th></tr></thead><tbody>${tried.map(({ g, b }) =>
        `<tr><td>${g.name}</td><td class="n">${g.res} m</td><td class="n">${b ? size(b) : 'none'}</td><td class="n">${fits(b) ? 'yes' : 'no'}</td></tr>`).join('')}</tbody></table></div>`;
      const d4 = pick.b.design;
      parts.exFit = [
        `<p>A field of ${FF[0]} × ${FF[1]} m, four varieties in four repetitions, and every plot to keep ${4} pixels that hold. No satellite is chosen yet: in <b>Suggest a design</b> the satellite is <span class="f">Coarsest that fits the field</span>.</p>`,
        `<p>Build tries the satellites from the largest pixel down, each with its own blur and CE90 as delivered, and stops at the first whose smallest trial fits the field:</p>`,
        table,
        `<p>Sentinel-2's 20 m bands need a trial of ${size(before.b)}, larger than the field. Its 10 m bands need ${size(pick.b)}: plots of <b>${m(d4.plotLength)} × ${m(d4.plotWidth)} m</b> in ${rowsOfBlocks(pick.b) === 1 ? 'one row' : `${rowsOfBlocks(pick.b)} rows`} of blocks, which Build lays in the field and selects Sentinel-2 at 10 m. Finer satellites fit too, with smaller plots: the drawing under <a href="#suggest">Suggest a design</a> shows the trials four of them ask for.</p>`,
      ].join('\n          ');
    }

    // ---- A satellite and a field: the most repetitions that fit.
    {
      const RF = EX.REPS_FIELD, q = seedOf('reps'), s2rung = rungs.find(g => g.id === 's2-10');
      need(opensOn('reps', 's2-10', THR * 100) && q.suggestAsk.sat === 's2-10' && q.suggestAsk.repsMax === true && q.suggestAsk.hold === true && q.wantPure === 4
        && q.pattern === 'block' && q.simFold === 'suggest' && same(q.aoi, EX.exampleField(...RF)), 'the link of the repetitions example opens Suggest a design, set to find the most repetitions for Sentinel-2 in that field');
      const byReps = Array.from({ length: 21 }, (_, n) => (n ? suggestOn(RF, s2rung, n) : null));
      const most = [...Array(20).keys()].map(k => 20 - k).find(n => fits(byReps[n])) ?? 0, next = byReps[most + 1];
      need(most >= 2 && most < 20 && next && !fits(next) && rowsOfBlocks(byReps[most]) === 1 && rowsOfBlocks(next) === 2, 'in a field of 300 x 200 m Sentinel-2 fits one row of blocks, and one more repetition needs a second row');
      const shown = [most - 1, most, most + 1];
      const table = `<div class="scroll"><table class="narrow"><thead><tr><th>Repetitions</th><th class="n">rows of blocks</th><th class="n">smallest trial</th><th class="n">fits</th></tr></thead><tbody>${shown.map(n =>
        `<tr><td>${n}</td><td class="n">${rowsOfBlocks(byReps[n])}</td><td class="n">${size(byReps[n])}</td><td class="n">${fits(byReps[n]) ? 'yes' : 'no'}</td></tr>`).join('')}</tbody></table></div>`;
      const b = byReps[most];
      parts.exReps = [
        `<p>A field of ${RF[0]} × ${RF[1]} m, to be followed with Sentinel-2's 10 m bands: four varieties, every plot to keep 4 pixels that hold. How many repetitions fit? In <b>Suggest a design</b>, the satellite is Sentinel-2 · 10 m and <i>As many repetitions as fit the field</i> is ticked.</p>`,
        `<p>Build tries 1, 2, 3 and more repetitions, up to 20, and keeps the most whose smallest trial fits: <b>${most}</b>, in one row of blocks, a trial of ${size(b)} with plots of ${m(b.design.plotLength)} × ${m(b.design.plotWidth)} m. ${most + 1} repetitions need a second row of blocks, ${size(next)}, taller than the field.</p>`,
        table,
        `<p>The repetitions found are written in the Repetitions field. Typing another number there asks for that number again.</p>`,
      ].join('\n          ');
    }
  }

  // ======================================================================
  // One drawing per idea of the page ("every menu every concept should be
  // illustrated", 2026-11-22). The menus are pictures of the page itself
  // (scripts/docs-screenshots.mjs); the ideas are drawn here, from the engine.
  // ======================================================================
  const { bufferK, minPlotSideM } = await load('src/pixel-grid/resolving.ts');
  const nm = await load('src/pixel-grid/note-model.ts');
  const K = 2.3548, PALE = [CA, CB, CC, CD, '#56b4e9', '#d55e00'];
  const sats = SOURCES.filter(q => q.id !== 'custom');
  const fwhmOf = q => q.psf * K * q.res;
  const nameOf = q => q.provider.replace(' · ', ' ');
  const ce90Of = ceFor;

  // ---- The three steps, as a flow.
  {
    const box = (x, w, title, lines) => rect(x, 4, w, 132, 'class="card" rx="6"') + text(x + 12, 26, title, 't-strong') + lines.map((q, k) => text(x + 12, 48 + k * 17, q)).join('');
    const arrow = (x1, x2) => line(x1, 70, x2 - 7, 70, 'ink') + `<path d="M${c(x2)} 70l-8 -4.5v9z" class="solid"/>`;
    parts.flow = figure(660, 140, 'The three steps of the designer',
      box(4, 176, '1 · Experiment area', ['find a place', 'draw a box', 'or trace the field'])
      + arrow(184, 212) + box(214, 232, '2 · Simulate experiment', ['Satellite', 'Design · Suggest a design', 'Plot size required', 'Growth curves · Noise'])
      + arrow(450, 478) + box(480, 176, '3 · Pixel purity', ['the pixels as a chart', 'the trial by every satellite']),
      'The three steps of the panel.');
  }

  // ---- A blur spot in profile: sigma, the FWHM and the circle that holds 95 %.
  {
    need(Math.abs(2 * Math.sqrt(2 * Math.LN2) - K) < 1e-4 && Math.abs(Math.sqrt(-2 * Math.log(0.05)) - 2.448) < 1e-3, 'FWHM = 2.3548 sigma, and 95 % of a round spot lies within 2.448 sigma');
    const fr = frame({ X: 34, Y: 14, W: 430, H: 150, x: [-3.6, 3.6], y: [0, 1.08], xt: [-3, -2, -1, 0, 1, 2, 3], xf: v => (v === 0 ? '0' : `${v} σ`) });
    const pts = []; for (let x = -3.6; x <= 3.6001; x += 0.1) pts.push([fr.px(x), fr.py(Math.exp(-x * x / 2))]);
    let g = fr.g + path2(pts, 'ink w2');
    g += line(fr.px(-K / 2), fr.py(0.5), fr.px(K / 2), fr.py(0.5), 'accent w2') + text(fr.px(0), fr.py(0.5) + 16, 'FWHM = 2.3548 σ', 't-strong', 'middle');
    g += line(fr.px(0), fr.py(Math.exp(-0.5)), fr.px(1), fr.py(Math.exp(-0.5)), 'ink dash') + text(fr.px(0.5), fr.py(Math.exp(-0.5)) - 6, 'σ', 't-strong', 'middle') + line(fr.px(0), fr.py(1), fr.px(0), fr.py(0), 'rule');
    // A round spot holds 95 % of its signal within 2.448 sigma, where its profile is down to 5 % of the peak: the bar ends on the curve.
    need(Math.abs(Math.exp(-(2.448 ** 2) / 2) - 0.05) < 1e-3, 'at the radius that holds 95 % of a round spot its profile is at 5 % of the peak');
    g += line(fr.px(-2.448), fr.py(0.05), fr.px(2.448), fr.py(0.05), 'ink dot') + text(fr.px(0), 14 + 150 + 36, 'dotted: the width of the circle that holds 95 % of the signal, 4.9 σ', '', 'middle');
    parts.fwhm = figure(480, 210, 'A blur spot in profile, with sigma, the FWHM and the 95 % width',
      g, 'Profile of the PSF, with σ and the FWHM.');
  }

  // ---- The threshold: the same plot at three purities.
  {
    const ths = [0.75, 0.9, 0.99], ps = ths.map((t, k) => panel(10 + k * 190, 30, 2.2, GSD / 2, GSD / 2, { thr: t }));
    need(ps[0].pure > ps[1].pure && ps[1].pure > ps[2].pure, 'a stricter threshold leaves fewer pure pixels');
    parts.threshold = figure(566, 214, 'The pure pixels of one plot at three thresholds',
      ths.map((t, k) => text(98 + k * 190, 20, `${Math.round(t * 100)} %: ${ps[k].pure} pure`, 't-strong', 'middle')).join('') + ps.map(q => q.svg).join(''),
      `The same 40 m plot at three thresholds. At ${Math.round(ths[0] * 100)} % the edge pixels are pure too (${ps[0].pure} pixels), at 90 % only the central ones (${ps[1].pure}), and at ${Math.round(ths[2] * 100)} % none${ps[2].pure ? ` but ${ps[2].pure}` : ''}: the central pixels are at ${(ownShare(GSD / 2, GSD / 2, plot, SIG) * 100).toFixed(1)} %.`);
  }

  // ---- A CE90, as where three hundred images would land.
  {
    let seed = 20261122;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const N = 300, s = 9, X = 14, Y = 14, half = 14, cx = X + half * s, cy = Y + half * s;
    let g = rect(X, Y, 2 * half * s, 2 * half * s, 'class="card"'), inside = 0;
    for (const o of [-GSD / 2, GSD / 2]) g += line(cx + o * s, Y, cx + o * s, Y + 2 * half * s, 'grid') + line(X, cy + o * s, X + 2 * half * s, cy + o * s, 'grid');
    for (let k = 0; k < N; k++) {
      const u = Math.max(rnd(), 1e-12), v = rnd(), r = SIG_GEO * Math.sqrt(-2 * Math.log(u)), dx = r * Math.cos(2 * Math.PI * v), dy = r * Math.sin(2 * Math.PI * v);
      if (r <= CE) inside++;
      if (Math.abs(dx) < half && Math.abs(dy) < half) g += circle(cx + dx * s, cy - dy * s, 1.6, `class="${r <= CE ? 'accent-fill' : 'warn-fill'}"`);
    }
    g += circle(cx, cy, CE * s, 'class="ink w2"') + circle(cx, cy, SIG_GEO * s, 'class="ink dash"');
    const lx = X + 2 * half * s + 20;
    g += line(lx, 60, lx + 26, 60, 'ink w2') + text(lx + 34, 64, `CE90 = ${m(CE)} m`) + line(lx, 86, lx + 26, 86, 'ink dash') + text(lx + 34, 90, `σ<tspan class="sub" dy="3">geo</tspan><tspan dy="-3"> = ${m(SIG_GEO)} m</tspan>`);
    g += circle(lx + 13, 112, 3, 'class="accent-fill"') + text(lx + 34, 116, `${inside} landings inside`) + circle(lx + 13, 138, 3, 'class="warn-fill"') + text(lx + 34, 142, `${N - inside} outside`);
    need(Math.abs(inside / N - 0.9) < 0.04, 'about nine landings in ten fall within the CE90');
    parts.ce90 = figure(500, 2 * half * s + 28, 'Where three hundred images would land around a point, and the CE90 circle',
      g, `Where ${N} images would land around their nominal position, for Sentinel-2's CE90 as delivered, on its 10 m pixels. The CE90 circle contains 90 % of them on average (${inside} of ${N} in this draw).`);
  }

  // ---- The CE90 of each satellite as delivered: in metres, and in its own pixels.
  {
    const X = 150, W = 300, rowH = 20, top = 30, max = 20, px = v => X + (v / max) * W;
    let g = '';
    for (const t of [0, 5, 10, 15, 20]) g += line(px(t), top - 4, px(t), top + sats.length * rowH, 'rule') + text(px(t), top - 9, `${t} m`, 't-tick', 'middle');
    sats.forEach((q, k) => {
      const y = top + k * rowH, ce = q.geo.ce90M, inPx = ce / q.res;
      g += text(X - 8, y + 14, `${q.short} ${q.resLabel}`, '', 'end') + rect(X, y + 5, px(ce) - X, 10, `fill="${q.kind === 'catalog' ? CB : CA}"`);
      g += text(px(ce) + 6, y + 14, `${m(ce)} m · ${inPx >= 10 ? Math.round(inPx) : +inPx.toFixed(1)} px`, 't-tick');
    });
    const inPixels = q => q.geo.ce90M / q.res, worst = sats.reduce((a, q) => (inPixels(q) > inPixels(a) ? q : a));
    need(sats.filter(q => q.kind === 'catalog').every(q => inPixels(q) < 1) && sats.filter(q => q.kind !== 'catalog').every(q => inPixels(q) > 2), 'as delivered a fixed grid lands within a pixel and every tasked satellite more than two pixels away');
    parts.ce90bars = figure(560, top + sats.length * rowH + 8, 'The CE90 of each satellite as delivered, in metres and in its own pixels',
      g, `CE90 as delivered, in metres and in pixels: under 1 pixel for Sentinel-2 and Landsat, over 2 pixels for every tasked satellite (${Math.round(inPixels(worst))} for ${nameOf(worst)}).`);
  }

  // ---- How many pixels of a plot hold, as the CE90 grows.
  {
    const sides = [40, 50, 60], ces = []; for (let v = 0; v <= 16.0001; v += 0.25) ces.push(+v.toFixed(2));
    // The best of the positions the designer tries, 24 to a pixel each way (an eighth of them: the plot, the spot and the landings are symmetric about both axes and the diagonal).
    const best = (side, ce) => {
      const pl = { a: side, b: side }, lands = ce > 0 ? ce90Shifts(ce, 0) : [], n = Math.ceil(side / (2 * GSD)) + 1;
      let top = 0;
      for (let a = 0; a <= sim.SPOT_STAKE_N / 2; a++) for (let b = a; b <= sim.SPOT_STAKE_N / 2; b++) {
        const ox = (a * GSD) / sim.SPOT_STAKE_N, oy = (b * GSD) / sim.SPOT_STAKE_N;
        let kept = 0;
        for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
          const x = ox + i * GSD, y = oy + j * GSD;
          if (Math.abs(x) >= side / 2 || Math.abs(y) >= side / 2 || ownShare(x, y, pl, SIG) < THR) continue;
          if (lands.every(([dx, dy]) => ownShare(x + dx, y + dy, pl, SIG) >= THR)) kept++;
        }
        if (kept > top) top = kept;
      }
      return top;
    };
    const series = sides.map(side => ces.map(ce => best(side, ce)));
    const fr = frame({ X: 44, Y: 22, W: 420, H: 170, x: [0, 16], y: [0, Math.max(...series.flat()) + 1], xt: [0, 2, 4, 6, 8, 10, 12, 14, 16], yt: [0, 4, 9, 16, 25].filter(v => v <= Math.max(...series.flat())), xl: 'CE90, m', yl: 'pixels of the plot that hold' });
    let g = fr.g + line(fr.px(CE), 22, fr.px(CE), 192, 'accent dash') + text(fr.px(CE) + 5, 34, `Sentinel-2, ${m(CE)} m`, 't-tick');
    series.forEach((ys, k) => {
      const pts = []; ys.forEach((y, i) => { if (i) pts.push([fr.px(ces[i]), fr.py(ys[i - 1])]); pts.push([fr.px(ces[i]), fr.py(y)]); });
      g += `<path d="${pts.map(([x, y], i) => `${i ? 'L' : 'M'}${c(x)} ${c(y)}`).join('')}" fill="none" stroke="${PALE[k]}" stroke-width="2"/>`;
    });
    g += key(150, 236, sides.map((side, k) => [`<line x1="0" y1="0" x2="12" y2="0" stroke="${PALE[k]}" stroke-width="2"/>`, `${side} m plot`]));
    const at = (side, ce) => series[sides.indexOf(side)][ces.indexOf(ce)];
    /** The largest CE90 at which a plot still holds n pixels, to the centimetre: the chart's own step, then halved down. */
    const last = (side, n) => {
      let lo = Math.max(...ces.filter(ce => at(side, ce) >= n)), hi = lo + 0.25;
      while (hi - lo > 0.005) { const mid = (lo + hi) / 2; if (best(side, mid) >= n) lo = mid; else hi = mid; }
      return Math.floor(lo * 100) / 100;
    };
    need(at(40, 7) === 4 && last(40, 4) >= CE && last(40, 4) < 7.5 && last(50, 4) > last(40, 4) + 2, 'a 40 m plot holds four Sentinel-2 pixels up to a CE90 a little over 7 m, and a 50 m plot holds four well beyond');
    parts.holdcurve = figure(480, 248, 'The pixels of a plot that hold, against the CE90, for three plot sizes',
      g, `Pixels of one plot that hold for Sentinel-2, at the best grid position, against the CE90. A 40 m plot keeps 4 up to ${m(last(40, 4))} m (Sentinel-2 as delivered: ${m(CE)} m) and ${best(40, last(40, 4) + 0.05)} beyond. A 50 m plot keeps 4 up to ${m(last(50, 4))} m.`);
  }

  // ---- Every satellite: its pixel and its blur, in metres.
  {
    const X = 150, W = 360, rowH = 20, top = 26, fr = frame({ X, Y: top, W, H: sats.length * rowH, x: [0.3, 100], y: [0, 1], xt: [0.3, 1, 3, 10, 30, 100], xf: v => `${v} m`, xlog: true });
    let g = fr.g;
    sats.forEach((q, k) => {
      const y = top + k * rowH + rowH / 2, col = q.kind === 'catalog' ? CB : CA;
      g += text(X - 8, y + 4, `${q.short} ${q.resLabel}`, '', 'end') + line(fr.px(q.res), y, fr.px(fwhmOf(q)), y, 'dim') + rect(fr.px(q.res) - 4, y - 4, 8, 8, `fill="${col}"`) + circle(fr.px(fwhmOf(q)), y, 4.5, 'class="ink"');
    });
    g += key(X, top + sats.length * rowH + 44, [[rect(0, -5, 9, 9, `fill="${CB}"`), 'pixel, fixed grid'], [rect(0, -5, 9, 9, `fill="${CA}"`), 'pixel, tasked'], [circle(5, 0, 4.5, 'class="ink"'), 'FWHM of the blur']]);
    need(sats.every(q => fwhmOf(q) > q.res), 'every satellite blurs wider than its pixel');
    parts.satbars = figure(560, top + sats.length * rowH + 60, 'The pixel size and the blur of each satellite, in metres',
      g, 'Pixel size (square) and FWHM (circle) of each satellite, in metres, on a logarithmic scale. The FWHM exceeds the pixel for every satellite.');
  }

  // ---- A pansharpened product beside its native bands.
  {
    const pan = SOURCES.find(q => q.id === 'pleiades-ps'), nat = SOURCES.find(q => q.id === 'pleiades');
    const s = 22, half = 4, W = 2 * half * s;
    const one = (X, q) => {
      let g = `<svg x="${X}" y="34" width="${W}" height="${W}" viewBox="${X} 34 ${W} ${W}">` + rect(X, 34, W, W, `fill="${CA}" opacity="0.3"`);
      for (let v = -half; v <= half + 1e-9; v += q.res) g += line(X + (v + half) * s, 34, X + (v + half) * s, 34 + W, 'grid') + line(X, 34 + (v + half) * s, X + W, 34 + (v + half) * s, 'grid');
      return g + circle(X + W / 2, 34 + W / 2, (fwhmOf(q) / 2) * s, 'class="ink w2"') + circle(X + W / 2, 34 + W / 2, 2, 'class="solid"') + '</svg>';
    };
    need(fwhmOf(nat) > fwhmOf(pan) && pan.res < nat.res, 'the native bands are blurrier than the pansharpened product');
    parts.pan = figure(2 * W + 50, W + 44, 'A pansharpened product and its native bands over the same ground',
      text(10 + W / 2, 12, 'Pansharpened', 't-strong', 'middle') + text(10 + W / 2, 26, `${pan.resLabel} pixels, FWHM ${m(fwhmOf(pan))} m`, 't-tick', 'middle')
      + text(40 + W + W / 2, 12, 'Native bands', 't-strong', 'middle') + text(40 + W + W / 2, 26, `${nat.resLabel} pixels, FWHM ${m(fwhmOf(nat))} m`, 't-tick', 'middle')
      + one(10, pan) + one(40 + W, nat),
      `Pléiades over ${2 * half} m of ground. Left: the pansharpened pixels and their FWHM. Right: the native bands, whose FWHM applies to an index.`);
  }

  // ---- Every position of the grid on one plot: what it keeps, pure and holding.
  {
    const n = 10, cell = 21, grids = [[], []];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const pix = pixelsOf(i, j, CE); grids[0].push(pix.filter(q => q.pure).length); grids[1].push(pix.filter(q => q.held).length); }
    const map = (X, vals, title) => {
      const max = Math.max(...vals), top = vals.indexOf(max);
      let g = text(X + (n * cell) / 2, 18, title, 't-strong', 'middle');
      vals.forEach((v, k) => { const i = k % n, j = Math.floor(k / n), x = X + i * cell, y = 28 + (n - 1 - j) * cell; g += rect(x, y, cell, cell, `class="accent-fill" opacity="${c(0.08 + 0.72 * (max ? v / max : 0))}"`) + text(x + cell / 2, y + 14, String(v), 't-num', 'middle'); });
      g += rect(X + (top % n) * cell, 28 + (n - 1 - Math.floor(top / n)) * cell, cell, cell, 'class="pure"');
      for (const t of [0, 5]) g += text(X + t * cell + cell / 2, 28 + n * cell + 14, `${t} m`, 't-tick', 'middle') + text(X - 5, 28 + (n - 1 - t) * cell + 14, `${t}`, 't-tick', 'end');
      return { g, top, max };
    };
    const a = map(34, grids[0], 'pure pixels'), b = map(34 + n * cell + 56, grids[1], 'pixels that hold');
    need(a.top !== b.top && a.max > b.max, 'the position with the most pure pixels is not the one where the most hold');
    parts.offsets = figure(34 + 2 * n * cell + 70, 28 + n * cell + 38, 'Pure pixels and pixels that hold for every position of the grid on a plot',
      a.g + b.g + text(34 + n * cell + 28, 28 + n * cell + 32, 'shift of the grid east and north, m', '', 'middle'),
      `The 40 m plot under Sentinel-2, for every shift of the grid in steps of 1 m east and north (0, 0: a pixel centred on the plot; 5, 5: pixel edges on its edges). Left: the pure pixels. Right: those that hold within the CE90. The outlined cell is the best shift of each panel.`);
  }

  // ---- A block trial, with the name of each of its dimensions.
  {
    const d = { nSpecies: 3, nBlocks: 4, plotLength: 12, plotWidth: 5, plotAlley: 1.5, blockAlley: 4, blocksPerRow: 2, seed: 1 };
    const plan = sim.buildBlockPlan(d, { centerU: 0, centerV: 0 }), plots = sim.blockPlots(plan), s = 5.2, X = 150, Y = 40;
    const px = u => X + (u - plan.u0) * s, py = v => Y + (v - plan.v0) * s;
    let g = rect(px(plan.u0) - 6, py(plan.v0) - 6, plan.totalU * s + 12, plan.totalV * s + 12, 'fill="#8b5a2b" opacity="0.3"');
    for (const p of plots) g += rect(px(p.u0), py(p.v0), (p.u1 - p.u0) * s, (p.v1 - p.v0) * s, `fill="${sim.CROP_COLORS[p.species]}" opacity="0.85"`);
    const p0 = plots[0], p1 = plots[1], b1 = plots.find(q => q.block === 1), last = plots[plots.length - 1];
    g += measure(px(p0.u0), py(p0.v0) - 12, px(p0.u1), py(p0.v0) - 12, 'plot length');
    g += measure(px(p0.u1), py(p0.v0) - 12, px(b1.u0), py(p0.v0) - 12, '') + line((px(p0.u1) + px(b1.u0)) / 2, py(p0.v0) - 14, (px(p0.u1) + px(b1.u0)) / 2 + 26, py(p0.v0) - 28, 'dim') + text((px(p0.u1) + px(b1.u0)) / 2 + 30, py(p0.v0) - 26, 'block alley');
    g += measure(px(p0.u0) - 12, py(p0.v0), px(p0.u0) - 12, py(p0.v1), 'plot width', { side: -1 });
    g += measure(px(p0.u0) - 12, py(p0.v1), px(p0.u0) - 12, py(p1.v0), '', { side: -1 }) + text(px(p0.u0) - 20, (py(p0.v1) + py(p1.v0)) / 2 + 4, 'plot alley', '', 'end');
    const bx = px(b1.u1) + 14, by0 = py(b1.v0), by1 = py(plots.filter(q => q.block === 1).pop().v1);
    g += path2([[bx - 5, by0], [bx, by0], [bx, by1], [bx - 5, by1]], 'dim') + text(bx + 8, (by0 + by1) / 2 - 3, 'one block:') + text(bx + 8, (by0 + by1) / 2 + 12, 'each species once');
    g += measure(px(plan.u0), py(last.v1) + 16, px(plan.u0 + plan.totalU), py(last.v1) + 16, `${d.blocksPerRow} blocks per row`, { side: -1 });
    need(plots.length === d.nSpecies * d.nBlocks && plan.cols === d.blocksPerRow, 'the plan drawn is the design asked for');
    parts.blockdims = figure(480, Y + plan.totalV * s + 46, 'A randomised block trial with its dimensions named',
      g, `The dimensions of a design, for ${d.nSpecies} species in ${d.nBlocks} blocks (plots of ${d.plotLength} × ${d.plotWidth} m, alleys in brown).`);
  }

  // ---- The angle: counted from the pixel rows, anticlockwise from east.
  {
    const A = 25, X = 20, Y = 16, W = 300, H = 200, cx = X + 150, cy = Y + 112, rad = (A * Math.PI) / 180, w = 170, h = 90;
    let g = rect(X, Y, W, H, 'class="card"');
    for (let k = 0; k <= 10; k++) g += line(X + k * 30, Y, X + k * 30, Y + H, 'grid');
    for (let k = 0; k <= 6; k++) g += line(X, Y + k * 30 + 10, X + W, Y + k * 30 + 10, 'grid');
    const corner = (u, v, t) => [cx + u * Math.cos(t) + v * Math.sin(t), cy - u * Math.sin(t) + v * Math.cos(t)];
    const ring = t => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => corner(u, v, t));
    g += `<polygon points="${ring(0).map(q => `${c(q[0])},${c(q[1])}`).join(' ')}" class="ink dash"/>`;
    g += `<polygon points="${ring(rad).map(q => `${c(q[0])},${c(q[1])}`).join(' ')}" fill="${CA}" opacity="0.55" class="plotline"/>`;
    const r = 118, ex = cx + r, ax = cx + r * Math.cos(rad), ay = cy - r * Math.sin(rad);
    g += line(cx, cy, ex + 14, cy, 'ink') + line(cx, cy, ax + 14 * Math.cos(rad), ay - 14 * Math.sin(rad), 'accent w2') + `<path d="M${c(ex - 30)} ${c(cy)}A${r - 30} ${r - 30} 0 0 0 ${c(cx + (r - 30) * Math.cos(rad))} ${c(cy - (r - 30) * Math.sin(rad))}" class="accent"/>`;
    g += text(cx + r - 6, cy - 16, `${A}°`, 't-strong') + text(X + W + 14, 60, 'the pixel rows run east') + text(X + W + 14, 84, 'the angle turns the trial') + text(X + W + 14, 100, 'anticlockwise from them') + text(X + W + 14, 132, 'broken outline: 0°,') + text(X + W + 14, 148, 'along the pixel rows');
    parts.angle = figure(520, Y + H + 12, 'A trial turned by an angle from the pixel rows',
      g, `A trial at ${A}°.`);
  }

  // ---- The seed: three draws of the same design.
  {
    const base = { nSpecies: 4, nBlocks: 3, plotLength: 10, plotWidth: 4, plotAlley: 0, blockAlley: 2, blocksPerRow: 3 }, seeds = [1, 2, 3], s = 4.2;
    const drawn = seeds.map(seed => sim.buildBlockPlan({ ...base, seed }, { centerU: 0, centerV: 0 }));
    const W = drawn[0].totalU * s, H = drawn[0].totalV * s;
    let g = '';
    drawn.forEach((plan, k) => {
      const X = 10 + k * (W + 30);
      g += text(X + W / 2, 18, `seed ${seeds[k]}`, 't-strong', 'middle') + rect(X - 3, 27, W + 6, H + 6, 'fill="#8b5a2b" opacity="0.3"');
      for (const p of sim.blockPlots(plan)) g += rect(X + (p.u0 - plan.u0) * s, 30 + (p.v0 - plan.v0) * s, (p.u1 - p.u0) * s, (p.v1 - p.v0) * s - 0.6, `fill="${sim.CROP_COLORS[p.species]}" opacity="0.85"`);
    });
    const order = plan => Array.from(plan.plotSpecies).join('');
    need(new Set(drawn.map(order)).size === seeds.length && order(sim.buildBlockPlan({ ...base, seed: 1 }, { centerU: 0, centerV: 0 })) === order(drawn[0]), 'another seed draws another layout, and the same seed the same one');
    parts.seeds = figure(3 * W + 80, H + 44, 'Three draws of the same design, one per seed',
      g, 'Four species in three blocks, with three seeds.');
  }

  // ---- The trial each satellite asks for, at one scale.
  {
    const ids = ['planet', 's2-10', 'pleiades', 'wv'];
    const built = ids.map(id => { const q = SOURCES.find(z => z.id === id); return { q, b: suggestBlockDesign({ nSpecies: 4, nBlocks: 4, pixels: 4, res: q.res, sigmaX: q.psf, sigmaY: q.psf, threshold: THR, anyPosition: q.kind !== 'catalog', placeHeldM: ce90Of(id), ce90M: ce90Of(id), plotAlley: 0, blockAlley: 0, field: null }) }; });
    need(built.every(q => q.b && q.b.held >= 4) && built.every((q, k) => !k || q.b.footprint[0] * q.b.footprint[1] < built[k - 1].b.footprint[0] * built[k - 1].b.footprint[1]), 'the trial asked for shrinks from PlanetScope as delivered to Sentinel-2, Pléiades and WorldView-2');
    const s = 1, base = 16 + Math.max(...built.map(q => q.b.footprint[1])) * s, haOf = id => { const b = built[ids.indexOf(id)].b; return ((b.footprint[0] * b.footprint[1]) / 10000).toFixed(2); }; let X = 10, g = '';
    for (const { q, b } of built) {
      const w = b.footprint[0] * s, h = b.footprint[1] * s, d = b.design, perRow = d.blocksPerRow, rows = Math.ceil(d.nBlocks / perRow);
      const lw = Math.max(w, 96), bx = X + (lw - w) / 2;
      g += rect(bx, base - h, w, h, `fill="${q.kind === 'catalog' ? CB : CA}" opacity="0.35"`) + rect(bx, base - h, w, h, 'class="ink"');
      for (let i = 1; i < perRow; i++) g += line(bx + (i * w) / perRow, base - h, bx + (i * w) / perRow, base, 'ink');
      for (let j = 1; j < rows * d.nSpecies; j++) g += line(bx, base - (j * h) / (rows * d.nSpecies), bx + w, base - (j * h) / (rows * d.nSpecies), j % d.nSpecies ? 'grid' : 'ink');
      g += text(X + lw / 2, base + 16, `${q.short} ${q.resLabel}`, 't-strong', 'middle') + text(X + lw / 2, base + 32, `plots ${m(d.plotLength)} × ${m(d.plotWidth)} m`, 't-tick', 'middle') + text(X + lw / 2, base + 46, `${((b.footprint[0] * b.footprint[1]) / 10000).toFixed(2)} ha`, 't-tick', 'middle');
      X += lw + 16;
    }
    parts.suggested = figure(X, base + 54, 'The trial built for four pixels per plot, for four satellites, at one scale',
      g, `The smallest trials of 4 species in 4 blocks with 4 pixels that hold per plot (CE90 as delivered), at the same scale: ${built.map(({ q }) => `${nameOf(q)} ${haOf(q.id)} ha`).join(', ')}.`);
  }

  // ---- The three readings of a geolocation error.
  {
    const s = 3.5, W = 150, half = Math.ceil(W / (2 * s) / GSD) * GSD;
    const one = (k, title, sub, body) => {
      const X = 10 + k * (W + 20), cx = X + W / 2, cy = 46 + W / 2;
      let g = text(cx, 18, title, 't-strong', 'middle') + text(cx, 34, sub, 't-tick', 'middle') + `<svg x="${X}" y="46" width="${W}" height="${W}" viewBox="${X} 46 ${W} ${W}">` + rect(X, 46, W, W, `fill="${CA}" opacity="0.3"`);
      for (let v = -half; v <= half; v += GSD) { const o = (v + GSD / 2) * s; g += line(cx + o, 46, cx + o, 46 + W, 'grid') + line(X, cy + o, X + W, cy + o, 'grid'); }
      return g + rect(cx - (GSD / 2) * s, cy - (GSD / 2) * s, GSD * s, GSD * s, 'class="ink"') + body(cx, cy) + '</svg>';
    };
    const r90 = v => 2.146 * v * s;
    const g = one(0, 'Shift corrected', `σ PSF = ${m(SIG)} m`, (cx, cy) => circle(cx, cy, r90(SIG), 'class="ink w2"'))
      + one(1, 'Average image', `σ eff = ${m(SIG_EFF)} m`, (cx, cy) => circle(cx, cy, r90(SIG), 'class="ink dash"') + circle(cx, cy, r90(SIG_EFF), 'class="accent w2"'))
      + one(2, '9 images in 10', `σ PSF, anywhere within ${m(CE)} m`, (cx, cy) => circle(cx, cy, CE * s, 'class="accent"') + [[0, 0], [1, 0], [-0.5, 0.87], [-0.5, -0.87]].map(([a, b]) => circle(cx + a * CE * s, cy - b * CE * s, r90(SIG), `class="ink${a || b ? ' dash' : ' w2'}"`)).join(''));
    parts.readings = figure(3 * W + 60, W + 56, 'The three readings of a geolocation error: the blur alone, the blur widened, the blur moved',
      g, 'The circle containing 90 % of the signal of one Sentinel-2 pixel, for each of the three columns. The small circle is the CE90.');
  }

  // ---- The side a plot needs, by the number of pure pixels asked of it.
  {
    const ns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], cases = imageCases(SIG, CE, SIG_GEO);
    const cols = cases.map(q => pureScales({ a: GSD, b: GSD }, { gsd: GSD, sigma: q.sigma, shift: q.shift, threshold: THR, angleDeg: 0 }, ns).map(sc => GSD * sc));
    const fr = frame({ X: 44, Y: 22, W: 420, H: 180, x: [0.5, 12.5], y: [20, 70], xt: ns, yt: [20, 30, 40, 50, 60, 70], yf: v => `${v} m`, xl: 'pure pixels asked of the plot', yl: 'side of a square plot' });
    let g = fr.g;
    const names = ['shift corrected', 'average image', '9 images in 10'];
    cols.forEach((col, k) => { g += `<path d="${col.map((v, i) => `${i ? 'L' : 'M'}${c(fr.px(ns[i]))} ${c(fr.py(v))}`).join('')}" fill="none" stroke="${PALE[k]}" stroke-width="2"/>` + col.map((v, i) => circle(fr.px(ns[i]), fr.py(v), 2.4, `fill="${PALE[k]}"`)).join(''); });
    g += key(60, 250, names.map((q, k) => [`<line x1="0" y1="0" x2="12" y2="0" stroke="${PALE[k]}" stroke-width="2"/>`, q]));
    need(cols.every(col => col.every((v, i) => !i || v >= col[i - 1])) && cols[2].every((v, i) => v > cols[1][i] && cols[1][i] > cols[0][i]), 'more pixels ask for a larger plot, and each reading for more than the last');
    parts.sizecurve = figure(480, 262, 'The plot side Sentinel-2 asks for, against the pure pixels wanted, in the three readings',
      g, `Plot size required for Sentinel-2, for 1 to 12 pure pixels in a square plot, wherever the grid falls. The size increases in steps: ${cols[0][3].toFixed(1)} m for 4 pixels with the shift corrected, and ${cols[2][3].toFixed(1)} m for 4 pixels that stay pure in 9 images out of 10.`);
  }

  // ---- The growth curves of the crops, and what a mixed pixel records.
  {
    const crops = ['wheat', 'grass', 'beet', 'maize', 'soy'].map(id => sim.cropById(id)), T = sim.TMAX;
    const fr = frame({ X: 44, Y: 22, W: 580, H: 170, x: [0, 365], y: [0, 1], xt: [0, 60, 120, 180, 240, 300, 360], yt: [0, 0.25, 0.5, 0.75, 1], xl: 'day of the year', yl: 'NDVI' });
    const series = crops.map(q => sim.makeTruth(q.truth, T, sim.parsOf(q)));
    const poly = (a, attrs) => { let d = ''; for (let t = 0; t < T; t += 3) d += `${d ? 'L' : 'M'}${c(fr.px(t))} ${c(fr.py(a[t]))}`; return `<path d="${d}" fill="none" ${attrs}/>`; };
    let g = fr.g + series.map((a, k) => poly(a, `stroke="${crops[k].color}" stroke-width="2"`)).join('');
    const mix = Float64Array.from(series[0], (v, t) => 0.5 * v + 0.5 * series[3][t]);
    g += poly(mix, 'class="ink dash"') + key(48, 244, [...crops.map(q => [line(0, 0, 12, 0, '') .replace('class=""', `stroke="${q.color}" stroke-width="2"`), q.name]), [line(0, 0, 12, 0, 'ink dash'), 'half wheat, half maize']]);
    const peak = a => a.indexOf(Math.max(...a));
    need(peak(series[0]) < peak(series[3]) && mix.every((v, t) => v <= Math.max(series[0][t], series[3][t]) + 1e-12), 'winter wheat peaks before maize, and a mixed pixel lies between its two crops');
    parts.curves = figure(640, 256, 'The NDVI curves of five crops over the year, and that of a pixel that mixes two',
      g, `NDVI curves of five crop presets. Dashed: a pixel with half its signal from wheat and half from maize.`);
  }

  // ---- The noise through the season, for three settings of alpha and beta.
  {
    const T = sim.TMAX, sets = [[2, 2], [2, 5], [5, 2]], mag = 0.04;
    const fr = frame({ X: 44, Y: 22, W: 420, H: 130, x: [0, 365], y: [0, 0.22], xt: [0, 60, 120, 180, 240, 300, 360], yt: [0, 0.1, 0.2], xl: 'day of the year', yl: 'standard deviation of the noise, NDVI' });
    const series = sets.map(([a, b]) => Float64Array.from(sim.makeBetaSchedule(T, a, b, mag), v => Math.sqrt(Math.max(0, v))));
    let g = fr.g;
    series.forEach((a, k) => { let d = ''; for (let t = 0; t < T; t += 3) d += `${d ? 'L' : 'M'}${c(fr.px(t))} ${c(fr.py(a[t]))}`; const top = a.indexOf(Math.max(...a)); g += `<path d="${d}" fill="none" stroke="${PALE[k]}" stroke-width="2"/>` + text(fr.px(top), fr.py(a[top]) - 6, `α = ${sets[k][0]}, β = ${sets[k][1]}`, 't-tick', 'middle'); });
    const tops = series.map(a => a.indexOf(Math.max(...a)));
    need(Math.abs(tops[0] - T / 2) < 4 && tops[1] < tops[0] && tops[2] > tops[0] && series.every(a => Math.abs(Math.max(...a) - Math.sqrt(mag)) < 1e-9), 'alpha and beta move the peak of the noise, and mag sets its height');
    parts.noise = figure(480, 204, 'The noise over the season for three settings of alpha and beta',
      g, `Noise for mag = ${mag} (peak √mag = ${Math.sqrt(mag).toFixed(2)} NDVI): mid-season (α = 2, β = 2), early (2, 5), late (5, 2).`);
  }

  // ---- The buffer and the pure core of a plot.
  {
    const k = bufferK(THR), b = k * SIG_EFF, core = L - 2 * b, s = 5, X = 20, Y = 24, W = L * s, lMin = minPlotSideM(GSD, SIG_EFF, THR);
    let g = rect(X, Y, W, W, `fill="${CA}" opacity="0.3"`) + rect(X + b * s, Y + b * s, core * s, core * s, `fill="${CA}" opacity="0.75"`) + rect(X, Y, W, W, 'class="ink"') + rect(X + b * s, Y + b * s, core * s, core * s, 'class="ink dash"');
    g += measure(X, Y + W + 14, X + W, Y + W + 14, `L = ${L} m`, { side: -1 }) + measure(X, Y + 22, X + b * s, Y + 22, '') + text(X + (b * s) / 2, Y + 15, 'b', 't-strong', 'middle');
    g += measure(X + b * s, Y + W / 2 + 34, X + b * s + core * s, Y + W / 2 + 34, '') + text(X + W / 2, Y + W / 2 - 22, 'pure core', 't-strong', 'middle') + text(X + W / 2, Y + W / 2 - 4, `L − 2b = ${m(+core.toFixed(1))} m`, 't-strong', 'middle');
    const lx = X + W + 26;
    g += text(lx, 60, `k = ${k.toFixed(2)} at ε = ${Math.round((1 - THR) * 100)} %`) + text(lx, 82, `σ<tspan class="sub" dy="3">eff</tspan><tspan dy="-3"> = ${m(SIG_EFF)} m</tspan>`) + text(lx, 104, `b = k σ<tspan class="sub" dy="3">eff</tspan><tspan dy="-3"> = ${m(+b.toFixed(1))} m</tspan>`) + text(lx, 140, 'a pixel is pure only if its') + text(lx, 156, 'centre lies in the core');
    need(core > 0 && lMin > GSD && lMin < L, 'a 40 m plot has a pure core for Sentinel-2, and the closed form asks for less than 40 m');
    parts.buffer = figure(480, Y + W + 34, 'A plot with its buffer along each edge and its pure core',
      g, `The buffer on the 40 m plot, for Sentinel-2: b = ${m(+b.toFixed(1))} m along each edge leaves a pure core ${m(+core.toFixed(1))} m wide. The closed form for one pure pixel wherever the grid falls gives a plot of ${lMin.toFixed(1)} m.`);
  }

  // ---- The note's placements of the grid on a plot.
  {
    // The note's design, as note-model.ts walks it: its count is held against the module's own.
    const AMPS = [0, 1 / 3, 1 / 2, 3 / 4, 1], D = Math.SQRT1_2, DIRS = [[1, 0], [0, 1], [D, D], [D, -D]], PHASES = [[0, 0], [0.5, 0], [0.5, 0.5]], ROTS = [0, 15, 30, 45];
    const u = 74, X = 30, Y = 30, ox = X + u, oy = Y + 2 * u;
    let g = rect(X, Y, 3 * u, 3 * u, 'class="card"'), count = 0;
    // Pixel edges half a pixel from the origin: the plot's centre starts on the middle of a pixel, then on an edge, then on a corner.
    for (let k = 0; k < 3; k++) g += line(X + (k + 0.5) * u, Y, X + (k + 0.5) * u, Y + 3 * u, 'grid') + line(X, Y + (k + 0.5) * u, X + 3 * u, Y + (k + 0.5) * u, 'grid');
    g += rect(ox - u / 2, oy - u / 2, u, u, 'class="ink"');
    PHASES.forEach(([p, q], ph) => { for (const a of AMPS) for (const [dx, dy] of a === 0 ? [[0, 0]] : DIRS) { count++; g += circle(ox + (p + a * dx) * u, oy - (q + a * dy) * u, a === 0 ? 4.5 : 3, `fill="${PALE[ph]}"`); } });
    need(count * ROTS.length === nm.placementCount() && nm.placementCount() === 204, 'the note sweeps 204 placements: 51 shifts at four rotations');
    const lx = X + 3 * u + 24, names = ['a pixel centred on the plot', 'the plot centre on a pixel edge', 'the plot centre on a pixel corner'];
    g += text(lx, 44, 'Three starting positions:', 't-strong') + names.map((q, k) => circle(lx + 5, 62 + k * 18, 4.5, `fill="${PALE[k]}"`) + text(lx + 18, 66 + k * 18, q)).join('');
    g += text(lx, 132, 'From each, the image is shifted by') + text(lx, 148, '⅓, ½, ¾ or 1 pixel, four ways.') + text(lx, 182, 'And the grid is turned by', 't-strong');
    ROTS.forEach((a, k) => { const cx = lx + 18 + k * 50, cy = 216, t = (a * Math.PI) / 180, h = 13; g += `<polygon points="${[[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => `${c(cx + x * Math.cos(t) - y * Math.sin(t))},${c(cy + x * Math.sin(t) + y * Math.cos(t))}`).join(' ')}" class="ink"/>` + text(cx, cy + 32, `${a}°`, 't-tick', 'middle'); });
    parts.placements = figure(560, Y + 3 * u + 14, 'The 204 placements of the pixel grid on a plot',
      g, `Each dot is one position of the plot's centre on the pixel grid. The squares are pixels, and the outlined one is the pixel at the plot's coordinates. There are ${count} positions, each at four rotations of the grid, so ${nm.placementCount()} placements.`);
  }

  // ---- The minimum plots by the note's criteria, for the six sensors it measured, each with its CE90 as delivered (what the page shows).
  {
    const ids = ['wv-ps', 'wv', 'pleiades-ps', 'pleiades', 'planet', 's2-10'], rows = ids.map(id => { const q = SOURCES.find(z => z.id === id); return { q, f: nm.noteFigures({ gsd: q.res, sigmaPsf: q.psf * q.res, sigmaGeo: ceFor(q.id) / CE90_TO_SIGMA, threshold: THR }) }; });
    const keys = [['central', 'central pixel'], ['centralRegistered', 'registered to ½ px'], ['anyPixel', 'any pixel'], ['common2m', 'on a 2 m grid']];
    const X = 150, W = 330, top = 22, bar = 8, rowH = keys.length * bar + 12, px = v => X + (v / 66) * W;
    let g = '';
    for (const t of [0, 10, 20, 30, 40, 50, 60]) g += line(px(t), top, px(t), top + rows.length * rowH, 'rule') + text(px(t), top + rows.length * rowH + 14, `${t} m`, 't-tick', 'middle');
    rows.forEach(({ q, f }, r) => { const y = top + r * rowH + 4; g += text(X - 8, y + (keys.length * bar) / 2 + 4, `${q.short} ${q.resLabel}`, '', 'end'); keys.forEach(([id], k) => { g += rect(X, y + k * bar, px(f[id]) - X, bar - 1.5, `fill="${PALE[k]}"`); }); g += text(X + W + 60, y + 9, `${f.central} m`, 't-num', 'end'); });
    g += text(X + W + 60, top - 4, 'central pixel', 't-tick', 'end');
    g += key(X - 120, top + rows.length * rowH + 36, keys.map(([, label], k) => [rect(0, -5, 12, 8, `fill="${PALE[k]}"`), label]));
    const fOf = id => rows.find(z => z.q.id === id).f, s2 = fOf('s2-10'), nameOfQ = q => q.provider.replace(' · ', ' ');
    need(rows.every(({ f }) => Object.values(f).every(v => v == null || v <= 66)) && rows.every(({ f }) => f.central >= f.centralRegistered && f.centralRegistered >= f.anyPixel), 'every minimum plot fits the axis, and the central pixel asks for the most of the first three');
    const g2 = rows.map(({ q, f }) => ({ q, v: f.common2m })).sort((a, b) => b.v - a.v);
    need(g2[0].q.id === 'planet' && ['wv-ps', 'wv'].includes(g2[g2.length - 1].q.id) && rows.every(({ f }) => f.common2m <= f.central || f.common2m - f.central < 5),
      'on the 2 m grid, with the blur and the error kept in metres, PlanetScope asks for the most and WorldView-2 for the least');
    parts.minplots = figure(600, top + rows.length * rowH + 50, 'The four minimum plots for the six sensors with a measured blur',
      g, `The four minimum plots for the six sensors with a measured blur, with their CE90 as delivered. The number on the right is the central-pixel value. Sentinel-2 needs ${s2.central} m by that criterion and ${s2.anyPixel} m if any pixel is accepted. On the 2 m grid, where only the pixel size is the same, PlanetScope needs the most (${g2[0].v} m) and ${nameOfQ(g2[g2.length - 1].q)} the least (${g2[g2.length - 1].v} m).`);
  }

  // ---- What is not simulated, as four small pictures.
  {
    const w = 132, gap = 14, cell = (k, title, body) => `<g transform="translate(${4 + k * (w + gap)} 4)">${rect(0, 0, w, 96, 'class="card" rx="5"')}${body}${text(w / 2, 114, title, '', 'middle')}</g>`;
    const bell = (cx, base, amp, sd, tail = 0) => { const pts = []; for (let x = -56; x <= 56; x += 2) pts.push([cx + x, base - amp * ((1 - tail) * Math.exp(-(x * x) / (2 * sd * sd)) + tail / (1 + (x * x) / (sd * sd)))]); return pts; };
    const season = (shift, amp) => { const pts = []; for (let x = 8; x <= w - 8; x += 3) pts.push([x, 82 - amp / (1 + Math.exp(-(x - 40 - shift) / 7)) + amp / (1 + Math.exp(-(x - 92 - shift) / 7))]); return pts; };
    const sq = (cx, cy, h, deg) => { const t = (deg * Math.PI) / 180; let g = ''; for (let k = -2; k <= 2; k++) { const o = k * h / 2; g += line(cx + o * Math.cos(t) + h * Math.sin(t), cy + o * Math.sin(t) - h * Math.cos(t), cx + o * Math.cos(t) - h * Math.sin(t), cy + o * Math.sin(t) + h * Math.cos(t), deg ? 'accent' : 'ink') + line(cx - h * Math.cos(t) - o * Math.sin(t), cy - h * Math.sin(t) + o * Math.cos(t), cx + h * Math.cos(t) - o * Math.sin(t), cy + h * Math.sin(t) + o * Math.cos(t), deg ? 'accent' : 'ink'); } return g; };
    parts.notsim = figure(4 * w + 3 * gap + 8, 124, 'Four things the simulation leaves out, as sketches',
      cell(0, 'one FWHM for all bands', circle(w / 2, 40, 24, 'class="ink"') + circle(w / 2, 40, 30, 'class="accent dash"') + text(w / 2, 88, 'PlanetScope: 9.7 to 12 m', 't-tick', 'middle'))
      + cell(1, 'heavier tails', path2(bell(w / 2, 84, 62, 15), 'ink') + path2(bell(w / 2, 84, 62, 15, 0.3), 'accent dash'))
      + cell(2, 'replicates that differ', path2(season(0, 50), 'ink') + path2(season(4, 43), 'accent dash'))
      + cell(3, 'other grid rotations', sq(w / 2, 48, 30, 0) + sq(w / 2, 48, 30, 25)),
      'Sketches (not computed) of the four effects left out. White: simulated. Blue: left out.');
  }

  // ---- What stays in the browser and what goes out.
  {
    const out = ['map tiles', 'place search', 'fonts', "a fixed grid's catalog"];
    let g = rect(4, 4, 250, 172, 'class="card" rx="6"') + text(16, 26, 'Your browser', 't-strong') + ['the field and the design', 'every setting', 'the trial file: read here,', 'never sent'].map((q, k) => text(16, 50 + k * 18, q)).join('');
    g += rect(16, 132, 150, 30, 'class="ink" rx="4"') + text(26, 151, 'a trial file');
    out.forEach((q, k) => { const y = 14 + k * 42; g += rect(420, y, 190, 30, 'class="card" rx="5"') + text(432, y + 19, q) + line(256, 40 + k * 22, 412, y + 15, 'ink') + `<path d="M${c(420)} ${c(y + 15)}l-8 -4v8z" class="solid"/>`; });
    g += line(168, 147, 300, 147, 'warn') + line(292, 139, 308, 155, 'warn') + line(308, 139, 292, 155, 'warn') + text(318, 151, 'stays', 't-tick');
    parts.storage = figure(616, 182, 'What the designer keeps in the browser and what it asks of outside services',
      g, 'What leaves the browser, and what stays in it.');
  }

  // ---- The designer's own menus, as pictures of the page itself (scripts/docs-screenshots.mjs writes them, and their sizes).
  {
    const sizes = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs-img/shots.json'), 'utf8'));
    const shot = (name, alt, caption) => {
      const q = sizes[name];
      // SVG since 2026-11-25 ("the screen shots look blurry when zooming"): scripts/docs-screenshots.mjs.
      need(q && fs.existsSync(path.join(ROOT, 'docs-img', `${name}.svg`)), `the picture ${name}.svg is in docs-img, with its size`);
      return `<figure class="shot" style="--w: ${q.w}px"><img src="./docs-img/${name}.svg" alt="${alt}" width="${q.w}" height="${q.h}" loading="lazy" decoding="async"><figcaption>${caption}</figcaption></figure>`;
    };
    const row = (...items) => `<div class="shots">${items.join('')}</div>`;
    parts.shotsOverview = shot('app', 'The designer: a map with a trial on the left, the panel with its three steps on the right',
      'The designer, with the trial of example 3. The screenshots on this page have no background map.')
      + shot('step-area', 'Step 1, Experiment area', 'Step 1, Experiment area.');
    parts.shotsMap = shot('layers-menu', 'The Layers menu', 'The Layers menu.')
      + row(shot('layer-simulation', 'The map with every switch off', 'All switches off.'),
        shot('layer-pure', 'The map with the Pure pixels layer', 'Pure pixels.'),
        shot('layer-real-field', 'The map with the Real field layer', 'Real field.'),
        shot('layer-sigmas', 'The map with the three sigma rings', 'σ PSF, geo, eff.'),
        shot('layer-signal', 'The map with the signal of a pixel as dots', 'Signal of a pixel.'));
    parts.shotsSatellite = shot('fold-satellite', 'The Satellite section', 'The Satellite section.');
    parts.shotsBudget = shot('fold-budget', 'The list Every source of blur', 'Every source of blur, for the trial of example 3.');
    parts.shotsDesigns = row(shot('fold-design', 'The Design section for randomised blocks', 'Design, randomised blocks.'),
      shot('fold-design-rows', 'The Design section for alternating rows', 'Design, alternating rows.'));
    parts.shotsImported = row(shot('fold-import', 'The Design section with a trial read from a file', 'Design, an imported trial.'),
      shot('map-import', 'The imported trial on the map', 'The imported trial on Sentinel-2 pixels.'));
    parts.shotsSuggest = shot('fold-suggest', 'Suggest a design, after Build', 'Suggest a design after Build, for the trial of example 3.');
    parts.shotsPlotSize = shot('fold-plot-size', 'The Plot size required card', 'Plot size required, for Sentinel-2.');
    parts.shotsCurves = shot('fold-curves', 'The Growth curves section, with the noise', 'Growth curves and noise.');
    parts.shotsChart = row(shot('chart-scatter', 'The chart, Scatter tab', 'Scatter.'), shot('chart-variance', 'The chart, Variance tab', 'Variance.'),
      shot('chart-loadings', 'The chart, Loadings tab', 'Loadings.'), shot('chart-purity', 'The chart, Purity tab', 'Purity.'));
    parts.shotsTable = row(shot('table', 'The table Across satellites', 'The table.'),
      shot('table-compare', 'The table in a comparison', 'A comparison: the trial at 20° against the same trial at 0°.'),
      shot('table-charts', 'The Charts view', 'The Charts view.'));
    need(Object.keys(sizes).every(name => Object.values(parts).some(h => h.includes(`./docs-img/${name}.svg`))), 'every picture taken is shown on the page');
  }

  return parts;
}

/**
 * Whether two builds of a part are the same drawing and the same text: every
 * word and every figure that is READ alike, and every coordinate of a drawing
 * (a number inside a tag) within a tenth. The functions under a coordinate
 * (exp, cos, the projection) may differ in their last bit from one machine to
 * the next, and a coordinate that sits on a rounding edge would then print a
 * tenth apart on the owner's computer and on the one that publishes the page.
 * A count, a size or a share is text, and must be the same to the digit.
 */
export function sameParts(a, b) {
  if (a === b) return true;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Tags at the odd places, the text between them at the even ones.
  const x = a.split(/(<[^>]*>)/), y = b.split(/(<[^>]*>)/);
  if (x.length !== y.length) return false;
  const NUM = /-?\d+(?:\.\d+)?/g;
  for (let k = 0; k < x.length; k++) {
    if (x[k] === y[k]) continue;
    if (k % 2 === 0) return false;
    if (x[k].replace(NUM, '#') !== y[k].replace(NUM, '#')) return false;
    const p = x[k].match(NUM) ?? [], q = y[k].match(NUM) ?? [];
    if (p.length !== q.length || p.some((v, i) => Math.abs(+v - +q[i]) > 0.1000001)) return false;
  }
  return true;
}

/** The generated parts a page carries, by name. */
export function readParts(html) {
  const out = {};
  for (const mm of html.matchAll(/<!-- gen:([a-zA-Z0-9]+) -->([\s\S]*?)<!-- \/gen:\1 -->/g)) out[mm[1]] = mm[2];
  return out;
}

/** The page with every part put in its place; a part with no place on it is an error. */
export function applyParts(html, parts) {
  let out = html;
  for (const [name, body] of Object.entries(parts)) {
    const re = new RegExp(`(<!-- gen:${name} -->)[\\s\\S]*?(<!-- /gen:${name} -->)`);
    if (!re.test(out)) throw new Error(`docs-figures: the page has no place for "${name}"`);
    out = out.replace(re, (_, a, b) => a + body + b);
  }
  return out;
}

// Run as a script: make the designer's modules loadable, build the parts, write the page.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { transformSync } = await import('esbuild');
  const BUILD = path.join(ROOT, 'node_modules/.docs-figures');
  fs.rmSync(BUILD, { recursive: true, force: true });
  for (const dir of ['src/lib', 'src/pixel-grid']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue;
      const js = transformSync(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'), { loader: 'ts', format: 'esm' }).code
        .replace(/(from\s*['"])(\.\.?\/[^'"]+?)(['"])/g, (_, a, spec, z) => a + spec + '.mjs' + z);
      fs.mkdirSync(path.join(BUILD, dir), { recursive: true });
      fs.writeFileSync(path.join(BUILD, dir, f.replace(/\.ts$/, '.mjs')), js);
    }
  }
  const parts = await docsParts(rel => import(path.join(BUILD, rel.replace(/\.ts$/, '.mjs'))));
  const html = fs.readFileSync(PAGE, 'utf8'), next = applyParts(html, parts);
  if (process.argv.includes('--check')) {
    // As the suite compares them (sameParts), so that the two cannot disagree.
    const onPage = readParts(html), stale = Object.keys(parts).filter(k => !sameParts(onPage[k], parts[k]));
    console.log(stale.length ? `pixel-grid-docs.html is out of date (${stale.join(', ')}): run node scripts/docs-figures.mjs` : 'pixel-grid-docs.html carries every figure and every example as the engine gives them');
    process.exit(stale.length ? 1 : 0);
  }
  fs.writeFileSync(PAGE, next);
  console.log(`${Object.keys(parts).length} parts written to pixel-grid-docs.html: ${Object.keys(parts).join(', ')}`);
}
