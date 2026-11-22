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
  const { ce90Shifts, ce90For } = await load('src/pixel-grid/resolving.ts');
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
  // The CE90 as the page holds it, to the centimetre (use-grid.ts geoErrM), and the sigma it comes from, exact.
  const CE = Math.round(ce90For(true, 0, GSD) * 100) / 100, SIG_GEO = GSD / 3, SIG_EFF = Math.hypot(SIG, SIG_GEO);
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
      g, `Sentinel-2. The pixel outlined lies wholly inside its plot, its edge on the border. Its blur spot does not: the dashed circle is the FWHM (${m(FWHM)} m), the dotted one holds 90 % of the signal. ${Math.round((1 - own) * 100)} % of what the pixel records comes from the neighbouring plot.`);
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
      p.svg, `A 40 m plot among other plots, its edges on the pixel edges. It holds ${inside.length} Sentinel-2 pixels; the number in each is its purity, in percent. Only the ${p.pure} central ones reach 90 % (outlined): a pixel on an edge keeps ${shares[1]} %, a pixel in a corner ${shares[2]} %.`);
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
      `The same 40 m plot and the same 10 m pixels at two positions of the grid. With no geolocation error they are the best position (${best.pure} pure pixels) and the worst (${worst.pure}): a fixed grid is counted at the first, since the trial can be planted on it, and a tasked grid at the second. With a geolocation error the order turns over: see the figure under <a href="#hold">Pixels that hold</a>.`);
  }

  // ---- With the geolocation error: pure, and holding.
  {
    const a = panel(10, 30, 3, 0, 0, { ce90: CE, ring: [0, 0] }), b = panel(280, 30, 3, GSD / 2, GSD / 2, { ce90: CE, ring: [GSD / 2, GSD / 2] });
    need(a.pure > b.pure && a.held < b.held && b.held === b.pure, 'the position with the most pure pixels is not the one where the most hold');
    parts.hold = figure(530, 280, 'Pure pixels and pixels that hold, at two positions of the grid',
      text(130, 20, `${a.pure} pure, ${a.held} ${a.held === 1 ? 'holds' : 'hold'}`, 't-strong', 'middle') + text(400, 20, `${b.pure} pure, ${b.held} hold`, 't-strong', 'middle') + a.svg + b.svg,
      `The same plot with Sentinel-2's default CE90 of ${m(CE)} m. The circle is where the image can land; a pixel is tried at its eight points. A solid outline holds, a broken one is pure only with the image exactly in place. Left, the position with the most pure pixels: ${a.pure}, of which ${a.held} ${a.held === 1 ? 'holds' : 'hold'}. Right, the position where the most hold: ${b.held} of ${b.pure}.`);
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
    need(SIG_EFF / SIG < 1.25, 'the default geolocation error adds less than a quarter to the blur');
    parts.sigmas = figure(570, 270, 'The blur, the geolocation error and the effective blur as rings of one sigma',
      g, `Sentinel-2 on its 10 m pixels, to scale, each ring one σ from the pixel's centre. The default geolocation error (CE90 ${m(CE)} m) adds little to the blur: the effective blur is ${Math.round((SIG_EFF / SIG - 1) * 100)} % wider than the PSF.`);
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
      g, `The blur spot (circle: the FWHM) against the pixel (square), each satellite drawn with its own pixel at the same size. Blue: a fixed grid. Orange: tasked. ${widest.provider.replace(' · ', ' ')} has ${widest.resLabel} pixels under a spot ${Math.round(widest.psf * 2.3548)} pixels wide.`);
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
      'The four layouts the designer lays out itself. The randomised blocks are drawn as the designer draws them: four species in four blocks, two blocks per row, with a plot alley and a block alley in brown.');
  }

  // ---- The worked example: four varieties, four repetitions, Sentinel-2.
  {
    const E0 = 619203.7, N0 = 5600764.3, epsg = 32631;
    const toLL = proj4('+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs', 'EPSG:4326');
    const world = (design, side, rot, geo = {}) => {
      const [w, so] = toLL.forward([E0, N0]), [e, n] = toLL.forward([E0 + side, N0 + side]);
      const aoi = [w, so, e, n], origin = aoiUtmOrigin(aoi, epsg), env = sim.utmEnvelope(aoi, epsg);
      const layout = { pattern: 'block', width: 2, spacing: 0, rotationDeg: rot, block: sim.buildBlockPlan(design, sim.blockPlacement(env, origin, rot, GSD, true)) };
      return { aoi, origin, env, ctx: { aoi, fieldRing: null, epsg, layout, threshold: THR * 100, blockDesign: design, importedAngle: 0, importedFileAngle: 0, importedBasePlan: undefined, geoAuto: true, geoManual: 0, placeFor: 'held', ...geo } };
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
    const microPure = microPan.map(q => {
      const t = tally(q.step), kept = t.plots - t.none;
      return `${nameOf(q)} has ${Math.round(q.step.resolvingPct)} % of the crop in pure pixels and holds ${kept === 0 ? 'none of them' : `a pixel in ${kept} of the ${t.plots} plots`}`;
    });

    // 2. What Sentinel-2 asks of a square plot, in the three readings.
    const wanted = [1, 4, 9];
    const cases = imageCases(SIG, CE, SIG_GEO);
    need(Math.round(pureScales({ a: GSD, b: GSD }, { gsd: GSD, sigma: SIG, shift: 0, threshold: THR, angleDeg: 0 }, [1])[0]) === 3, 'one pure Sentinel-2 pixel asks for a plot three pixels wide');
    const sizes = cases.map(q => pureScales({ a: GSD, b: GSD }, { gsd: GSD, sigma: q.sigma, shift: q.shift, threshold: THR, angleDeg: 0 }, wanted).map(sc => GSD * sc));
    need(cases.length === 3 && sizes.every(col => col.every((v, k) => v > 0 && (k === 0 || v > col[k - 1]))) && wanted.every((_, k) => sizes[0][k] < sizes[1][k] && sizes[1][k] < sizes[2][k]),
      'the three readings ask for more and more, and more pixels for a larger plot');

    // 3. The trial built for it.
    const ask = { nSpecies: 4, nBlocks: 4, pixels: 4, res: GSD, sigmaX: S2.psf, sigmaY: S2.psf, threshold: THR, anyPosition: false,
      placeHeldM: CE, ce90M: CE, plotAlley: 0, blockAlley: 0, field: null };
    const built = suggestBlockDesign(ask);
    need(built && built.held === 4 && built.design.plotLength === built.design.plotWidth && built.design.plotAlley === 0 && Math.ceil(built.design.nBlocks / built.design.blocksPerRow) === 1,
      'the suggestion for four pixels that hold is a square plot, plots touching, in one row of blocks');
    const d = built.design, side = d.plotLength;
    need(side < sizes[2][1] && side % GSD === 0, 'a plot laid on the fixed grid is smaller than the size asked of a grid that falls anywhere, and a whole number of pixels');
    const ha = (built.footprint[0] * built.footprint[1]) / 10000;
    need(side === L, 'the plot built is the 40 m plot of the figures');
    const atWorst = Math.min(...ce90Shifts(CE, 0).map(([dx, dy]) => ownShare(GSD / 2 + dx, GSD / 2 + dy, plot, SIG)));
    const OFF = 0.5, offHeld = pixelsOf(GSD / 2 + OFF, GSD / 2, CE).filter(q => q.held).length;
    need(atWorst >= THR && atWorst < THR + 0.01 && offHeld < built.held, 'a 40 m plot holds its four pixels with little to spare, and loses some of them half a metre off');

    // 4. The same trial, by every satellite; 5. turned; 6. with the images as delivered.
    const flat = world(d, built.footprint[0] + 120, 0), flatRows = rowsOf(flat, 0);
    const TURN = 20, turned = world(d, built.footprint[0] + 160, TURN), turnedRows = rowsOf(turned, TURN);
    const asDelivered = rowsOf(world(d, built.footprint[0] + 120, 0, { geoProvider: true }), 0);
    const s2 = rowOf(flatRows, 's2-10'), s2t = rowOf(turnedRows, 's2-10'), s2d = rowOf(asDelivered, 's2-10'), pld = rowOf(asDelivered, 'planet'), pl = rowOf(flatRows, 'planet');
    need(s2.geoRobustPure === s2.pureCount && tally(s2).min === 4 && tally(s2).none === 0, 'every plot of the trial keeps four Sentinel-2 pixels, and all its pure pixels hold');
    need(['s2-20', 's2-60', 'hls-30', 'ls-30'].every(id => rowOf(flatRows, id).pureCount === 0), 'the 20 m and coarser pixels keep nothing of a 40 m plot');
    need(['planet', 'pleiades', 'wv'].every(id => rowOf(flatRows, id).resolvingPct > s2.resolvingPct && tally(rowOf(flatRows, id)).min > tally(s2).min), 'the finer native satellites keep more of it');
    need(s2t.pureCount > s2.pureCount && s2t.geoRobustPure < s2.geoRobustPure && tally(s2t).min < tally(s2).min, 'turned, the trial keeps more pure pixels and fewer that hold');
    need(s2d.geoRobustPure === s2.geoRobustPure && pld.geoRobustPure === 0 && pld.pureCount > 0 && pl.geoRobustPure > 0, 'as delivered Sentinel-2 holds the same and PlanetScope holds nothing');
    const s2Delivered = sourceCe90('s2-10', GSD, { auto: true, manualM: 0, provider: true });
    need(Math.abs(s2Delivered - CE) < 1 && pl.resolvingPct > pl.geoRobust, 'the provider\'s figure for Sentinel-2 is within a metre of the default');

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
      `The sixteen plots on Sentinel-2's 10 m pixels, each plot in its variety's colour, the two panels at one scale. A solid outline is a pixel that holds within the CE90, a broken one a pixel pure only with the image exactly in place.`);

    const pct = v => (v == null ? 'n/a' : `${Math.round(v)} %`);
    const perPlot = st => { const t = st.partial ? null : tally(st); return !t ? '' : t.none > 0 ? `${t.none}/${t.plots} empty` : `min ${t.min}`; };
    const tableOf = rows => `<div class="scroll"><table class="narrow"><thead><tr><th>Satellite</th><th class="n">Pixel</th><th class="n">pure</th><th class="n">CE90</th><th class="n">per plot</th></tr></thead><tbody>${rows.map(({ rung, step }) =>
      `<tr><td>${rung.name}</td><td class="n">${rung.res} m${step.partial ? ' ◦' : ''}</td><td class="n">${pct(step.resolvingPct)}</td><td class="n">${step.geoRobust == null ? '' : pct(step.geoRobust)}</td><td class="n">${perPlot(step)}</td></tr>`).join('')}</tbody></table></div>`;
    const card = `<div class="scroll"><table class="narrow"><thead><tr><th>Pure pixels in the plot</th><th class="n">shift corrected</th><th class="n">average image</th><th class="n">9 images in 10</th></tr></thead><tbody>${wanted.map((n, k) =>
      `<tr><td>${n}</td>${sizes.map(col => `<td class="n">${col[k].toFixed(1)} m</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

    parts.example = [
      `<p>Four varieties, four repetitions, in randomised blocks. The trial is to be followed through the season with Sentinel-2's 10 m bands, whose images are free and frequent. How large must the plots be, and what would the other satellites make of the same trial?</p>`,
      `<h4>1. The usual micro-plots</h4>`,
      `<p>Start from the design the page opens with: micro-plots of ${micro.plotLength} × ${micro.plotWidth} m, ${micro.nSpecies} species in ${micro.nBlocks} blocks. Under <b>Across satellites</b>, no satellite keeps a single pure pixel of the ${micro.nSpecies * micro.nBlocks} plots, the pansharpened products apart: ${microPure.join('; ')}. A pansharpened row <a href="#pansharpened">flatters a trial read through an index</a>, and no other satellite sees these plots at all.</p>`,
      `<h4>2. What Sentinel-2 asks of a plot</h4>`,
      `<p><b>Plot size required</b>, for a square plot, gives the side that keeps a number of pure pixels wherever the pixel grid falls, in <a href="#plot-size">three readings</a> of the geolocation error (CE90 ${m(CE)} m).</p>`,
      card,
      `<p>One pure pixel already asks for a plot of ${sizes[0][0].toFixed(1)} m, three pixels wide, and a pixel that can be named by its coordinates for one of ${sizes[2][0].toFixed(1)} m.</p>`,
      `<h4>3. A trial built for it</h4>`,
      `<p>In <b>Suggest a design</b>: ${ask.nSpecies} species, ${ask.nBlocks} repetitions, ${ask.pixels} pixels per plot, Sentinel-2, with <i>Pixels must hold within the CE90</i> ticked. Build gives plots of <b>${m(d.plotLength)} × ${m(d.plotWidth)} m</b> (${built.pitchPx[0]} × ${built.pitchPx[1]} pixels, touching), one row of blocks, and a trial of ${m(built.footprint[0])} × ${m(built.footprint[1])} m, ${ha.toFixed(2)} ha. Each plot keeps ${built.held} pixels within the CE90.</p>`,
      `<p>That is less than the ${sizes[2][1].toFixed(1)} m of the table's last column for ${wanted[1]} pixels. The table is for a grid that falls anywhere. Sentinel-2's grid is fixed, so the plots are laid on it, their edges on pixel edges, where a ${m(side)} m plot holds the most pixels (the figure under <a href="#hold">Pixels that hold</a>).</p>`,
      `<p>It is the smallest plot of whole pixels that does, with little to spare: at the worst landing of the image its pixels keep ${(atWorst * 100).toFixed(1)} % of their signal, for 90 % asked. Staked ${OFF} m off along one side, a plot keeps ${offHeld} of its ${built.held} pixels. A larger plot, or images registered to each other, give the margin a field needs.</p>`,
      `<h4>4. The same trial, by every satellite</h4>`,
      tableOf(flatRows),
      `<p class="dim">◦: counted over the central part of the trial, which has too many pixels of that size to count them all, so with no count per plot.</p>`,
      `<p>Sentinel-2's 10 m bands keep ${int(s2.pureCount)} pure pixels, ${pct(s2.resolvingPct)} of the crop planted, ${tally(s2).min} in every plot, and all of them hold. Its 20 m and 60 m bands and Landsat keep none: a ${m(side)} m plot is too small for them. The finer satellites keep more, each counted at the worst position on its own grid: PlanetScope has ${pct(pl.resolvingPct)} of the crop in pure pixels and ${pct(pl.geoRobust)} in pixels that hold.</p>`,
      `<h4>5. Turned by ${TURN}°</h4>`,
      `<p>A field's rows rarely run along the pixel rows. Turned by ${TURN}°, the plots' edges can no longer lie on pixel edges, and the trial is counted where it sits. It keeps more pure Sentinel-2 pixels, ${int(s2t.pureCount)} against ${int(s2.pureCount)}, but only ${int(s2t.geoRobustPure)} of them hold: ${tally(s2t).min} in the worst plot, against ${tally(s2).min}.</p>`,
      trialFig,
      `<h4>6. Images as delivered</h4>`,
      `<p>With every satellite held against its own provider's figure (<b>Use</b>, in the Satellite fold), Sentinel-2 is held against ${m(s2Delivered)} m, close to the default, and the same ${int(s2d.geoRobustPure)} pixels hold. PlanetScope, at ${m(sourceCe90('planet', 3, { auto: true, manualM: 0, provider: true }))} m, keeps none that holds. Its ${int(pld.pureCount)} pure pixels cannot be named by their coordinates from one image to the next, unless the images are first registered to each other.</p>`,
      `<h4>What the example shows</h4>`,
      `<ul><li>A plot must be several pixels wide before one pixel of it is pure: ${m(side)} m for ${built.held} Sentinel-2 pixels that hold, and that with no margin.</li>`
      + `<li>On a fixed grid, make the plots a whole number of pixels, along the pixel rows, and let the designer place them on the grid.</li>`
      + `<li>A pure pixel is not always one that holds: read the CE90 column, not only the pure one.</li>`
      + `<li>A finer satellite is not a safer one by itself: its grid falls anywhere, and its images land metres away as delivered.</li></ul>`,
    ].join('\n          ');

    // ================================================================
    // More examples ("make an examples section where you showcase multiple
    // things", 2026-11-22). Each is a question, what the designer answers,
    // and a drawing of it; every figure is the engine's, and every sentence
    // is held by a need.
    // ================================================================
    const { suggestStrips, suggestChecker } = await load('src/pixel-grid/suggest-design.ts');
    const { resolveImportedPlan } = await load('src/pixel-grid/imported-plan.ts');
    const { varietiesOf } = await load('src/pixel-grid/design-import.ts');
    const { trialAngle, bestPlacement } = await load('src/pixel-grid/imported-rotate.ts');
    const { importedTrialExtent } = await load('src/pixel-grid/ladder.ts');
    const srcOf = id => SOURCES.find(z => z.id === id);
    const ceOf = id => Math.round(sourceCe90(id, srcOf(id).res, { auto: true, manualM: 0 }) * 100) / 100;
    const askFor = id => { const q = srcOf(id); return { res: q.res, sigmaX: q.psf, sigmaY: q.psf, threshold: THR, anyPosition: q.kind !== 'catalog', placeHeldM: ceOf(id), ce90M: ceOf(id) }; };
    const fullName = id => srcOf(id).provider.replace(' · ', ' ');

    // ---- Two crops in strips.
    {
      const WANT = 10, s2s = suggestStrips({ ...askFor('s2-10'), pattern: 'row', pixels: WANT, spacing: 0 }), pls = suggestStrips({ ...askFor('planet'), pattern: 'row', pixels: WANT, spacing: 0 });
      need(s2s && pls && s2s.width === 3 * GSD && s2s.held === 1 && pls.width < s2s.width, 'ten pixels per strip ask for 30 m strips under Sentinel-2, and thinner ones under PlanetScope');
      const W = s2s.width, strip = { a: W, b: Infinity };
      /** The pixel rows across a few strips, the grid shifted by `off`: pure for their strip, and holding. */
      const rowsAt = off => { const out = []; for (let y = off + GSD / 2; y < 4 * W; y += GSD) { const mid = (Math.floor(y / W) + 0.5) * W, dd = y - mid, share = ownShare(dd, 0, strip, SIG), pure = share >= THR; out.push({ y, share, pure, held: pure && [-CE, CE].every(dy => ownShare(dd + dy, 0, strip, SIG) >= THR) }); } return out; };
      const stripPanel = (X, off) => {
        const s = 1.75, hM = 4 * W, wM = 150, rws = rowsAt(off);
        let g = `<svg x="${c(X)}" y="30" width="${c(wM * s)}" height="${c(hM * s)}" viewBox="${c(X)} 30 ${c(wM * s)} ${c(hM * s)}">`;
        for (let k = 0; k < 4; k++) g += rect(X, 30 + k * W * s, wM * s, W * s, `fill="${k % 2 ? CB : CA}" opacity="0.5"`);
        for (let y = off; y <= hM; y += GSD) g += line(X, 30 + y * s, X + wM * s, 30 + y * s, 'grid');
        for (let x = 0; x <= wM; x += GSD) g += line(X + x * s, 30, X + x * s, 30 + hM * s, 'grid');
        for (const q of rws) if (q.pure) for (let x = 0; x < wM; x += GSD) g += rect(X + x * s + 1.2, 30 + (q.y - GSD / 2) * s + 1.2, GSD * s - 2.4, GSD * s - 2.4, `class="pure${q.held ? '' : ' dash'}"`);
        const per = k => rws.filter(q => q.y > W && q.y < 2 * W && q[k]).length;
        return { svg: g + '</svg>', pure: per('pure'), held: per('held'), w: wM * s, h: hM * s };
      };
      const a = stripPanel(10, 0), b = stripPanel(10 + a.w + 26, GSD / 2);
      need(a.pure === 1 && a.held === 1 && b.pure === 2 && b.held === 0, 'on its edges a 30 m strip keeps one row that holds; half a pixel off, two pure rows and none that holds');
      // How far from a two-pixel strip's middle a pixel can sit and still be pure: by halving.
      const narrow = { a: 2 * GSD, b: Infinity }, two = ownShare(0, 0, narrow, SIG);
      let lo = 0, hi = GSD / 2; while (hi - lo > 1e-4) { const mid = (lo + hi) / 2; if (ownShare(mid, 0, narrow, SIG) >= THR) lo = mid; else hi = mid; }
      need(two >= THR && two < THR + 0.02 && lo > 0.2 && lo < 2.5 && ownShare(CE, 0, narrow, SIG) < THR,
        'a strip two Sentinel-2 pixels wide has a pure row only with a pixel within a metre or two of its middle, and that row does not hold');
      need(pls.held >= 1 && pls.lengthM < s2s.lengthM, 'PlanetScope holds a pixel across its thinner strips, over a shorter length');
      const fig = figure(2 * a.w + 46, 30 + a.h + 6, 'Strips of two crops on Sentinel-2 pixels, at two positions of the grid',
        text(10 + a.w / 2, 20, `Edges on edges: ${a.pure} pure across, ${a.held} holds`, 't-strong', 'middle') + text(36 + a.w + a.w / 2, 20, `Half a pixel off: ${b.pure} pure, ${b.held} hold`, 't-strong', 'middle') + a.svg + b.svg,
        `Rows of ${m(W)} m of two crops under Sentinel-2, with its default CE90 of ${m(CE)} m. Left, where the designer places them when it places for the pixels that hold: one row of pixels per strip, and it holds. Right, where it places them for pure pixels: two rows per strip, neither of which holds.`);
      parts.exStrips = [
        `<p>Two crops in alternating rows, to be told apart by Sentinel-2. In the Design fold the layout is <b>Alternating rows</b>; in <b>Suggest a design</b>, ask for ${WANT} pixels per strip that hold within the CE90.</p>`,
        `<p>Build gives strips of <b>${m(s2s.width)} m</b>, ${s2s.pitchPx} pixels wide. A strip keeps ${s2s.held} pixel across that holds, so it needs ${m(s2s.lengthM)} m of length for its ${WANT} pixels: ${WANT} pixels, and the ends of a strip, which lose pixels as its sides do. The same request for PlanetScope gives strips of ${m(pls.width)} m, ${pls.pitchPx} pixels wide, over ${m(pls.lengthM)} m.</p>`,
        fig,
        `<p>Which of the two positions the designer takes is the choice of <a href="#place-for">Place the trial for</a>. Three pixels wide is the least that holds for Sentinel-2: a strip two pixels wide keeps a pure row only with a pixel within ${lo.toFixed(1)} m of its middle (${(two * 100).toFixed(1)} % at best), and that row does not hold.</p>`,
      ].join('\n          ');
    }

    // ---- Which satellite for which plot.
    {
      const ids = ['wv', 'pleiades', 'planet', 's2-10', 's2-20', 'hls-30'], wants = [1, 4, 9];
      const cell = (id, px) => suggestBlockDesign({ nSpecies: 4, nBlocks: 4, pixels: px, ...askFor(id), plotAlley: 0, blockAlley: 0, field: null });
      const grid = ids.map(id => wants.map(px => cell(id, px)));
      const area = b => b.footprint[0] * b.footprint[1];
      need(grid.every(row => row.every(Boolean)) && wants.every((_, col) => grid.every((row, k) => !k || area(row[col]) > area(grid[k - 1][col]))) && grid.every(row => area(row[0]) <= area(row[1]) && area(row[1]) <= area(row[2])),
        'a coarser satellite asks for a larger trial at every count, and more pixels for a larger one');
      const ha = b => (b.footprint[0] * b.footprint[1]) / 10000;
      const table = `<div class="scroll"><table class="narrow"><thead><tr><th>Satellite</th>${wants.map(px => `<th class="n">${px} px per plot</th>`).join('')}<th class="n">trial, 4 px</th></tr></thead><tbody>${ids.map((id, r) =>
        `<tr><td>${fullName(id)} ${srcOf(id).resLabel}</td>${grid[r].map(b => `<td class="n">${m(b.design.plotLength)} × ${m(b.design.plotWidth)} m</td>`).join('')}<td class="n">${ha(grid[r][1]) < 10 ? ha(grid[r][1]).toFixed(2) : ha(grid[r][1]).toFixed(1)} ha</td></tr>`).join('')}</tbody></table></div>`;
      const s2 = grid[ids.indexOf('s2-10')][1], hls = grid[ids.indexOf('hls-30')][1], wv = grid[ids.indexOf('wv')][1];
      parts.exSats = [
        `<p>The same trial, 4 species in 4 blocks, asked of six satellites in <b>Suggest a design</b>: the smallest plots that keep 1, 4 or 9 pixels that hold within each satellite's default CE90.</p>`,
        table,
        `<p>The plot grows with the pixel and with the blur. Four pixels per plot cost ${ha(wv).toFixed(2)} ha with ${fullName('wv')}, ${ha(s2).toFixed(2)} ha with Sentinel-2's 10 m bands and ${ha(hls).toFixed(1)} ha with Landsat (HLS). The figure under <a href="#suggest">Suggest a design</a> draws four of these trials at one scale.</p>`,
      ].join('\n          ');
    }

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
      const plan = resolveImportedPlan(design, varietiesOf(design), epsg), ang = trialAngle(plan);
      need(plan.plots.length === nB * nV && plan.plotIds && Math.abs(ang - ANG) < 0.01, 'the trial read is the one written: 24 plots at 17 degrees');
      const [w, so] = toUtm.inverse([plan.bbox[0] - 30, plan.bbox[1] - 30]), [e, n] = toUtm.inverse([plan.bbox[2] + 30, plan.bbox[3] + 30]);
      const ctx = { aoi: [w, so, e, n], fieldRing: null, epsg, layout: { pattern: 'imported', width: 2, spacing: 0, rotationDeg: ang, imported: plan }, threshold: THR * 100, blockDesign: d,
        importedAngle: ang, importedFileAngle: ang, importedBasePlan: plan, geoAuto: true, geoManual: 0, placeFor: 'held' };
      const shown = ['wv', 'pleiades', 'planet', 's2-10', 's2-20'].map(id => rungs.find(q => q.id === id));
      const rows = shown.map(rung => ({ rung, drawn: ladderStep(ctx, ang, rung, true), best: ladderStep(ctx, 0, rung, false) }));
      const s2r = rows.find(q => q.rung.id === 's2-10'), plr = rows.find(q => q.rung.id === 'planet');
      const full = st => { const t = tally(st); return t ? t.plots - t.none : null; };
      need(s2r.best.geoRobustPure >= 1.5 * s2r.drawn.geoRobustPure && tally(s2r.best).min > tally(s2r.drawn).min && full(s2r.best) === nB * nV,
        'for Sentinel-2 the best placement holds half as many pixels again as the trial as drawn, and more in its worst plot');
      need(Math.abs(plr.best.geoRobustPure - plr.drawn.geoRobustPure) < 0.05 * plr.drawn.geoRobustPure && tally(plr.drawn).none === 0, 'for PlanetScope the placement changes little, and every plot keeps pixels');
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
        `The ${nB * nV} plots on Sentinel-2's 10 m pixels, in their varieties' colours. A solid outline is a pixel that holds within the CE90, a broken one a pixel pure only with the image exactly in place.`);
      const cellOf = st => `${int(st.pureCount)} · ${st.geoRobustPure == null ? '' : int(st.geoRobustPure)}`;
      const sampled = rows.some(q => q.drawn.partial || q.best.partial);
      const table = `<div class="scroll"><table class="narrow"><thead><tr><th>Satellite</th><th class="n">Pixel</th><th class="n">as drawn</th><th class="n">plots</th><th class="n">best</th><th class="n">plots</th><th class="n">angle</th></tr></thead><tbody>${rows.map(({ rung, drawn: a, best: b }) =>
        `<tr><td>${rung.name}</td><td class="n">${rung.res} m${a.partial || b.partial ? ' ◦' : ''}</td><td class="n">${cellOf(a)}</td><td class="n">${full(a) ?? ''}${full(a) == null ? '' : ` of ${nB * nV}`}</td><td class="n">${cellOf(b)}</td><td class="n">${full(b) ?? ''}${full(b) == null ? '' : ` of ${nB * nV}`}</td><td class="n">${b.placement ? `${m(+b.placement.angle.toFixed(1))}°` : ''}</td></tr>`).join('')}</tbody></table></div>`;
      parts.exFile = [
        `<p>A trial that is already in the ground: ${nB * nV} plots of ${A} × ${Bw} m, ${nV} varieties in ${nB} repetitions, drawn at ${ANG}° to the pixel rows. Its plots are imported as a file (a made-up one here), with the <b>Variety</b> column as the variety, and <span class="f">vs best</span> compares the trial as drawn with its <a href="#imported">best placement</a> for each satellite.</p>`,
        table,
        `<p class="dim">as drawn, best: the pure pixels, then those that hold (the designer's own table gives them as shares). plots: the plots that keep a pixel that holds. angle: that of the best placement.${sampled ? ' ◦: counted over the central part of the trial, with no count per plot.' : ''}</p>`,
        `<p>For Sentinel-2 the placement matters most: as drawn ${int(s2r.drawn.geoRobustPure)} pixels hold, ${tally(s2r.drawn).min} in the worst plot; turned to ${m(+s2r.best.placement.angle.toFixed(1))}° and moved onto the grid, ${int(s2r.best.geoRobustPure)} hold, ${tally(s2r.best).min} in every plot. For PlanetScope the placement changes little, and every plot keeps at least ${tally(plr.drawn).min} pixels that hold.</p>`,
        fig,
        `<p>A trial that exists cannot be turned. The comparison says what its layout cost, and which satellites can still follow it as it is. The best placement is the best the search found: see <a href="#imported">Imported trial</a>.</p>`,
      ].join('\n          ');
    }

    // ---- How strict, and how sure: the threshold and the geolocation setting.
    {
      const ths = [80, 90, 95], geos = [['no error', { geoAuto: false, geoManual: 0 }], ['default', {}], ['as delivered', { geoProvider: true }]];
      const cellOf = (id, thr, geo) => { const wd = world(d, built.footprint[0] + 120, 0, { threshold: thr, ...geo }); const st = ladderStep(wd.ctx, 0, rungs.find(q => q.id === id), true); return { pure: st.pureCount, held: st.geoRobustPure }; };
      const grid = id => ths.map(thr => geos.map(([, geo]) => cellOf(id, thr, geo)));
      const s2g = grid('s2-10'), plg = grid('planet');
      const tableOf2 = (name, g) => `<tr class="group"><td colspan="4">${name}</td></tr>` + ths.map((thr, r) => `<tr><td>purity ${thr} %</td>${g[r].map(q => `<td class="n">${int(q.pure)}${q.held == null ? '' : ` · ${int(q.held)}`}</td>`).join('')}</tr>`).join('');
      need(s2g[1][1].held === 64 && s2g[2][1].held < s2g[1][1].held && plg[1][2].held === 0 && plg[1][1].held > 0 && s2g[0][0].held == null, 'the 40 m trial holds 64 Sentinel-2 pixels at 90 %, fewer at 95 %, and PlanetScope as delivered holds none');
      const more = s2g[2][1].pure > s2g[1][1].pure;
      need(more && s2g[2][1].held > 0, 'at 95 % Sentinel-2 counts more pure pixels than at 90 %, and still holds some');
      parts.exStrict = [
        `<p>The trial of the first example, ${m(d.plotLength)} × ${m(d.plotWidth)} m plots, under three purity thresholds and the three ways of setting the geolocation error. Each cell gives the pure pixels, then those that hold.</p>`,
        `<div class="scroll"><table class="narrow"><thead><tr><th></th>${geos.map(([name]) => `<th class="n">${name}</th>`).join('')}</tr></thead><tbody>${tableOf2('Sentinel-2, 10 m', s2g)}${tableOf2('PlanetScope, 3 m', plg)}</tbody></table></div>`,
        `<p>At 90 % and the default error Sentinel-2 holds ${int(s2g[1][1].held)} pixels; at 95 % it holds ${int(s2g[2][1].held)}. ${more ? `It counts more pure pixels at 95 % (${int(s2g[2][1].pure)}) than at 90 % (${int(s2g[1][1].pure)}): the trial is placed for the pixels that hold, and the position that holds the most at 95 % is another one. ` : ''}PlanetScope holds ${int(plg[1][1].held)} at the default error and ${int(plg[1][2].held)} as delivered; as delivered it holds next to nothing at any threshold.</p>`,
        `<p>A count means nothing without the two settings it was made under: say both when a design is reported.</p>`,
      ].join('\n          ');
      need(plg.every(row => row[2].held <= 4), 'as delivered PlanetScope holds next to nothing at any threshold');
    }

    // ---- A checkerboard.
    {
      const s2c = suggestChecker({ ...askFor('s2-10'), pixels: 4, spacing: 0 }), plc = suggestChecker({ ...askFor('planet'), pixels: 4, spacing: 0 });
      need(s2c && plc && s2c.width === 4 * GSD && s2c.held === 4 && plc.width < s2c.width, 'four pixels per cell ask for 40 m cells under Sentinel-2, and smaller ones under PlanetScope');
      const Wc = s2c.width, N = 4, sensor = { sigmaX: S2.psf, sigmaY: S2.psf, mixThreshold: THR, anyPosition: false, placeHeldM: CE };
      const v = pixelVerdicts({ res: GSD, utmBounds: [0, 0, N * Wc, N * Wc] }, [0, 0], { pattern: 'checker', width: Wc, spacing: 0, rotationDeg: 0 }, sensor, CE);
      const nx = (N * Wc) / GSD, inner = (i, j) => i >= Wc / GSD && i < nx - Wc / GSD && j >= Wc / GSD && j < nx - Wc / GSD;
      let held = 0, pure = 0; for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) if (inner(i, j)) { pure += v.pure[j * nx + i]; held += v.robust[j * nx + i]; }
      need(held === 4 * s2c.held && pure === 4 * s2c.pure, `the four inner cells drawn keep what the suggestion says a cell keeps (${pure}/${held})`);
      const s = 1.9, X = 10, Y = 10, size = N * Wc * s;
      let g = '';
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) g += rect(X + i * Wc * s, Y + (N - 1 - j) * Wc * s, Wc * s, Wc * s, `fill="${(i + j) % 2 ? CB : CA}" opacity="0.55"`);
      for (let k = 0; k <= nx; k++) g += line(X + k * GSD * s, Y, X + k * GSD * s, Y + size, 'grid') + line(X, Y + k * GSD * s, X + size, Y + k * GSD * s, 'grid');
      for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) if (v.pure[j * nx + i]) g += rect(X + i * GSD * s + 1.2, Y + (nx - 1 - j) * GSD * s + 1.2, GSD * s - 2.4, GSD * s - 2.4, `class="pure${v.robust[j * nx + i] ? '' : ' dash'}"`);
      const fig = figure(size + 20, size + 20, 'A checkerboard of two crops on Sentinel-2 pixels, with the pixels that hold',
        g, `A checkerboard of ${m(Wc)} m cells under Sentinel-2: every cell keeps ${s2c.held} pixels that hold, as a plot of a block trial of the same size does.`);
      parts.exChecker = [
        `<p>Two crops in a checkerboard, each cell a plot. With the layout <b>Checkerboard</b>, <b>Suggest a design</b> asked for 4 pixels per cell gives cells of <b>${m(s2c.width)} m</b> for Sentinel-2 and of ${m(plc.width)} m for PlanetScope.</p>`,
        fig,
        `<p>A cell touches cells of the other crop on its four sides, so it is read like a plot among other plots: each crop has as many repetitions as half the cells, and each cell must be as large as a plot.</p>`,
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
  const ce90Of = id => Math.round(sourceCe90(id, SOURCES.find(q => q.id === id).res, { auto: true, manualM: 0 }) * 100) / 100;

  // ---- The three steps, as a flow.
  {
    const box = (x, w, title, lines) => rect(x, 4, w, 132, 'class="card" rx="6"') + text(x + 12, 26, title, 't-strong') + lines.map((q, k) => text(x + 12, 48 + k * 17, q)).join('');
    const arrow = (x1, x2) => line(x1, 70, x2 - 7, 70, 'ink') + `<path d="M${c(x2)} 70l-8 -4.5v9z" class="solid"/>`;
    parts.flow = figure(660, 140, 'The three steps of the designer',
      box(4, 176, '1 · Experiment area', ['find a place', 'draw a box', 'or trace the field'])
      + arrow(184, 212) + box(214, 232, '2 · Simulate experiment', ['Satellite', 'Design · Suggest a design', 'Plot size required', 'Growth curves · Noise'])
      + arrow(450, 478) + box(480, 176, '3 · Pixel purity', ['the pixels as a chart', 'the trial by every satellite']),
      'The page reads from the top of its panel down: where the trial is, what it is and which satellite reads it, then what that satellite keeps of it.');
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
      g, 'A blur spot in profile. σ is its standard deviation, the FWHM its width at half the peak. Satellites are given by their FWHM; the designer works in σ.');
  }

  // ---- The pixel's own footprint as a blur: the floor of any blur.
  {
    const s0 = sim.FOOTPRINT_SIGMA;
    need(Math.abs(s0 - 1 / Math.sqrt(12)) < 1e-12, 'the footprint of a pixel is a blur of 1/sqrt(12) pixel');
    const fr = frame({ X: 34, Y: 14, W: 430, H: 140, x: [-1.5, 1.5], y: [0, 1.5], xt: [-1, -0.5, 0, 0.5, 1], xf: v => `${v} px` });
    const pts = []; for (let x = -1.5; x <= 1.5001; x += 0.02) pts.push([fr.px(x), fr.py(Math.exp(-x * x / (2 * s0 * s0)) / (s0 * Math.sqrt(2 * Math.PI)))]);
    let g = fr.g + rect(fr.px(-0.5), fr.py(1), fr.px(0.5) - fr.px(-0.5), fr.py(0) - fr.py(1), `fill="${CA}" opacity="0.45"`);
    g += path2([[fr.px(-1.5), fr.py(0)], [fr.px(-0.5), fr.py(0)], [fr.px(-0.5), fr.py(1)], [fr.px(0.5), fr.py(1)], [fr.px(0.5), fr.py(0)], [fr.px(1.5), fr.py(0)]], 'ink') + path2(pts, 'accent w2');
    g += text(fr.px(0.56), fr.py(0.86), 'one pixel, read evenly') + text(fr.px(0.34), fr.py(1.32), `a blur of σ = ${s0.toFixed(2)} px, as wide`);
    parts.footprint = figure(480, 190, 'A pixel read evenly over its square, and the Gaussian blur of the same width',
      g, `A pixel that read its square evenly, with no optics at all, would already blur the ground by σ = GSD / √12 = ${s0.toFixed(2)} pixel. No satellite's blur is narrower, so a blur typed in below that is simulated at that width (a blur of exactly 0 gives the plain square).`);
  }

  // ---- The threshold: the same plot at three purities.
  {
    const ths = [0.75, 0.9, 0.99], ps = ths.map((t, k) => panel(10 + k * 190, 30, 2.2, GSD / 2, GSD / 2, { thr: t }));
    need(ps[0].pure > ps[1].pure && ps[1].pure > ps[2].pure, 'a stricter threshold leaves fewer pure pixels');
    parts.threshold = figure(566, 214, 'The pure pixels of one plot at three thresholds',
      ths.map((t, k) => text(98 + k * 190, 20, `${Math.round(t * 100)} %: ${ps[k].pure} pure`, 't-strong', 'middle')).join('') + ps.map(q => q.svg).join(''),
      `The 40 m plot of the figure above at three thresholds. At ${Math.round(ths[0] * 100)} % its edge pixels count as pure (${ps[0].pure} pixels), at 90 % only the central ones (${ps[1].pure}), at ${Math.round(ths[2] * 100)} % none${ps[2].pure ? ` but ${ps[2].pure}` : ''}: the central pixels are at ${(ownShare(GSD / 2, GSD / 2, plot, SIG) * 100).toFixed(1)} %.`);
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
      g, `Where ${N} images would land around the place their coordinates name, for Sentinel-2's default error, on its 10 m pixels. The CE90 is the circle that holds nine in ten: here ${inside} of ${N}.`);
  }

  // ---- The CE90 of each satellite: the default against the provider's figure.
  {
    const X = 150, W = 330, rowH = 22, top = 30, max = 24, px = v => X + (v / max) * W;
    let g = '';
    for (const t of [0, 5, 10, 15, 20]) g += line(px(t), top - 4, px(t), top + sats.length * rowH, 'rule') + text(px(t), top - 9, `${t} m`, 't-tick', 'middle');
    sats.forEach((q, k) => {
      const y = top + k * rowH, def = sourceCe90(q.id, q.res, { auto: true, manualM: 0 }), del = q.geo.ce90M;
      g += text(X - 8, y + 14, `${q.short} ${q.resLabel}`, '', 'end') + rect(X, y + 3, px(def) - X, 7, 'class="accent-fill"') + rect(X, y + 11, px(del) - X, 7, 'class="solid"');
      g += text(px(Math.max(def, del)) + 6, y + 14, `${m(+def.toPrecision(3))} · ${m(del)}`, 't-tick');
    });
    g += key(X, top + sats.length * rowH + 18, [[rect(0, -4, 12, 7, 'class="accent-fill"'), 'default'], [rect(0, -4, 12, 7, 'class="solid"'), 'as delivered, by the provider']]);
    const worst = sats.reduce((a, q) => (q.geo.ce90M / sourceCe90(q.id, q.res, { auto: true, manualM: 0 }) > a.geo.ce90M / sourceCe90(a.id, a.res, { auto: true, manualM: 0 }) ? q : a));
    need(sats.filter(q => q.kind !== 'catalog').every(q => q.geo.ce90M > sourceCe90(q.id, q.res, { auto: true, manualM: 0 })), 'every tasked satellite is delivered further off than the default assumes');
    parts.ce90bars = figure(560, top + sats.length * rowH + 34, 'The default CE90 and the CE90 as delivered, for each satellite',
      g, `The geolocation error in force by default (a third of a pixel; a third of the 10 m pixel for every Sentinel-2 band), and the one each provider states for an image as delivered. For the fixed grids the two are close. For every tasked satellite the image as delivered lands much further than the default assumes: ${Math.round(worst.geo.ce90M / sourceCe90(worst.id, worst.res, { auto: true, manualM: 0 }))} times further for ${nameOf(worst)}.`);
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
    let g = fr.g + line(fr.px(CE), 22, fr.px(CE), 192, 'accent dash') + text(fr.px(CE) + 5, 34, `default, ${m(CE)} m`, 't-tick');
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
      g, `The pixels of one plot that hold for Sentinel-2, at the best position of the grid, as the geolocation error grows. A 40 m plot keeps four pixels up to a CE90 of ${m(last(40, 4))} m and ${best(40, last(40, 4) + 0.05)} just after: the default sits at that edge. A 50 m plot keeps four up to ${m(last(50, 4))} m.`);
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
      g, 'The pixel (square) and the blur (circle) of each satellite, in metres, on a scale where each step is about three times the last. The blur is always wider than the pixel, and it is the blur that decides what a pixel sees.');
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
      `Pléiades over the same ${2 * half} m of ground. The pansharpened pixels are fine, but the circle, the blur at half its peak, is what a pixel really sees. An index is computed on the native bands: its blur is the circle on the right.`);
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
      `The 40 m plot under Sentinel-2, for every shift of the grid by a metre east and north (0, 0: a pixel centred on the plot; 5, 5: pixel edges on its edges). Left, the pure pixels it keeps; right, those that hold within the CE90. The outlined cell is the best of each: they are not the same.`);
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
      g, `The fields of the Design fold on a trial of ${d.nSpecies} species in ${d.nBlocks} blocks: a plot is ${d.plotLength} m long and ${d.plotWidth} m wide, a block is one plot long and all its species wide, and the bare soil of the alleys is in brown.`);
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
      g, `The angle of a design is counted from the pixel rows, anticlockwise from east: 0 lays the trial along them, here it is turned by ${A}°.`);
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
      g, 'The same design under three seeds: four species in three blocks, in another order each time. The same seed always gives the same layout.');
  }

  // ---- The trial each satellite asks for, at one scale.
  {
    const ids = ['s2-10', 'planet', 'pleiades', 'wv'];
    const built = ids.map(id => { const q = SOURCES.find(z => z.id === id); return { q, b: suggestBlockDesign({ nSpecies: 4, nBlocks: 4, pixels: 4, res: q.res, sigmaX: q.psf, sigmaY: q.psf, threshold: THR, anyPosition: q.kind !== 'catalog', placeHeldM: ce90Of(id), ce90M: ce90Of(id), plotAlley: 0, blockAlley: 0, field: null }) }; });
    need(built.every(q => q.b && q.b.held >= 4) && built.every((q, k) => !k || q.b.footprint[0] * q.b.footprint[1] < built[k - 1].b.footprint[0] * built[k - 1].b.footprint[1]), 'a finer satellite asks for a smaller trial');
    const s = 1.35, base = 250; let X = 10, g = '';
    for (const { q, b } of built) {
      const w = b.footprint[0] * s, h = b.footprint[1] * s, d = b.design, perRow = d.blocksPerRow, rows = Math.ceil(d.nBlocks / perRow);
      const lw = Math.max(w, 96), bx = X + (lw - w) / 2;
      g += rect(bx, base - h, w, h, `fill="${q.kind === 'catalog' ? CB : CA}" opacity="0.35"`) + rect(bx, base - h, w, h, 'class="ink"');
      for (let i = 1; i < perRow; i++) g += line(bx + (i * w) / perRow, base - h, bx + (i * w) / perRow, base, 'ink');
      for (let j = 1; j < rows * d.nSpecies; j++) g += line(bx, base - (j * h) / (rows * d.nSpecies), bx + w, base - (j * h) / (rows * d.nSpecies), j % d.nSpecies ? 'grid' : 'ink');
      g += text(X + lw / 2, base + 16, `${q.short} ${q.resLabel}`, 't-strong', 'middle') + text(X + lw / 2, base + 32, `plots ${m(d.plotLength)} × ${m(d.plotWidth)} m`, 't-tick', 'middle') + text(X + lw / 2, base + 46, `${((b.footprint[0] * b.footprint[1]) / 10000).toFixed(2)} ha`, 't-tick', 'middle');
      X += lw + 22;
    }
    parts.suggested = figure(X, base + 54, 'The trial built for four pixels per plot, for four satellites, at one scale',
      g, `The smallest trial of 4 species in 4 blocks whose every plot keeps 4 pixels that hold, for four satellites, drawn at one scale. Sentinel-2 asks for ${((built[0].b.footprint[0] * built[0].b.footprint[1]) / 10000).toFixed(2)} ha, ${nameOf(built[3].q)} for ${((built[3].b.footprint[0] * built[3].b.footprint[1]) / 10000).toFixed(2)} ha.`);
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
      g, 'One Sentinel-2 pixel and the circle that holds 90 % of its signal, read three ways. Shift corrected: the blur alone. Average image: the blur widened by the geolocation error. 9 images in 10: the blur alone, but landing anywhere within the CE90 (small circle), so the ground it may see is larger still.');
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
      g, `Plot size required for Sentinel-2, for 1 to 12 pure pixels in a square plot, wherever the grid falls. The plot grows by steps: ${cols[0][3].toFixed(1)} m for 4 pixels with the shift corrected, ${cols[2][3].toFixed(1)} m for 4 that stay pure in 9 images out of 10.`);
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
      g, `The season of five of the crop presets. The broken line is what a pixel records when half its signal comes from wheat and half from maize: neither crop's curve. This is what a mixed pixel does to a time series, and why the trial is read through its pure pixels.`);
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
      g, `The noise added to each pixel's series, at mag = ${mag}: its peak is √mag = ${Math.sqrt(mag).toFixed(2)} NDVI. α and β say when it peaks: mid-season at 2 and 2, early at 2 and 5, late at 5 and 2.`);
  }

  // ---- alpha, the contrast kept at the pixel grid's own limit, against r.
  {
    const fr = frame({ X: 54, Y: 22, W: 410, H: 170, x: [0.8, 3.6], y: [1e-5, 1], xt: [1, 1.5, 2, 2.5, 3, 3.5], yt: [1e-5, 1e-4, 1e-3, 1e-2, 0.1, 1], yf: v => (v >= 0.1 ? String(v) : `10${String(Math.round(Math.log10(v))).replace('-', '⁻').replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d])}`), ylog: true, xl: 'r = FWHM / GSD', yl: 'α, contrast kept at the Nyquist frequency' });
    const alpha = r => Math.exp(-0.890 * r * r), pts = []; for (let r = 0.8; r <= 3.6001; r += 0.05) pts.push([fr.px(r), fr.py(alpha(r))]);
    let g = fr.g + rect(fr.px(0.8), fr.py(0.30), fr.px(3.6) - fr.px(0.8), fr.py(0.15) - fr.py(0.30), 'class="accent-fill" opacity="0.18"') + text(fr.px(3.58), fr.py(0.30) - 6, "Sentinel-2's specification, 0.15 to 0.30", 't-tick', 'end') + path2(pts, 'ink w2');
    const shown = ['wv', 'ls-30', 's2-10', 'pleiades', 'wv-ps', 'planet'].map(id => SOURCES.find(q => q.id === id));
    const at = { wv: [-2, -9, 'end'], 'ls-30': [-7, 17, 'end'], 's2-10': [16, 24, 'start'], pleiades: [-8, 14, 'end'], 'wv-ps': [9, -5, 'start'], planet: [-8, 15, 'end'] };
    shown.forEach(q => { const r = q.psf * K, [dx, dy, anchor] = at[q.id]; g += circle(fr.px(r), fr.py(alpha(r)), 3.5, `fill="${q.kind === 'catalog' ? CB : CA}"`) + text(fr.px(r) + dx, fr.py(alpha(r)) + dy, q.short, 't-tick', anchor); });
    const s2a = alpha(S2.psf * K);
    need(s2a > 0.15 && s2a < 0.30 && alpha(SOURCES.find(q => q.id === 'planet').psf * K) < 1e-3, "Sentinel-2's measured blur is within its specification, and PlanetScope keeps under a thousandth");
    parts.alpha = figure(480, 234, 'Alpha against the ratio of the blur to the pixel, with six satellites',
      g, `α = exp(−0.890 r²): the share of contrast a satellite keeps at the finest detail its pixel grid can carry. Sentinel-2's measured blur gives ${s2a.toFixed(2)}, inside its specification. A satellite far down the curve has pixels much finer than its optics resolve.`);
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
      g, `The note's buffer on the 40 m plot, for Sentinel-2: b = ${m(+b.toFixed(1))} m along each edge leaves a pure core ${m(+core.toFixed(1))} m wide. The closed form for one pure pixel wherever the grid falls asks for a plot of ${lMin.toFixed(1)} m.`);
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
    parts.placements = figure(560, Y + 3 * u + 14, 'The placements of the pixel grid on a plot that the note sweeps',
      g, `Each dot is one position of the plot's centre on the pixel grid (the squares are pixels; the one outlined is the pixel the plot's coordinates name): ${count} of them, each at four rotations of the grid, ${nm.placementCount()} placements in all. A minimum plot of the note is the smallest that keeps its pixel pure in the worst of them.`);
  }

  // ---- The note's minimum plots, for the six sensors it measured.
  {
    const ids = ['wv-ps', 'wv', 'pleiades-ps', 'pleiades', 'planet', 's2-10'], rows = ids.map(id => { const q = SOURCES.find(z => z.id === id); return { q, f: nm.noteFigures({ gsd: q.res, sigmaPsf: q.psf * q.res, sigmaGeo: q.res / 3, threshold: THR }) }; });
    const keys = [['central', 'central pixel'], ['centralRegistered', 'registered to ½ px'], ['anyPixel', 'any pixel'], ['common2m', 'on a 2 m grid']];
    const X = 150, W = 330, top = 22, bar = 8, rowH = keys.length * bar + 12, px = v => X + (v / 56) * W;
    let g = '';
    for (const t of [0, 10, 20, 30, 40, 50]) g += line(px(t), top, px(t), top + rows.length * rowH, 'rule') + text(px(t), top + rows.length * rowH + 14, `${t} m`, 't-tick', 'middle');
    rows.forEach(({ q, f }, r) => { const y = top + r * rowH + 4; g += text(X - 8, y + (keys.length * bar) / 2 + 4, `${q.short} ${q.resLabel}`, '', 'end'); keys.forEach(([id], k) => { g += rect(X, y + k * bar, px(f[id]) - X, bar - 1.5, `fill="${PALE[k]}"`); }); g += text(X + W + 60, y + 9, `${f.central} m`, 't-num', 'end'); });
    g += text(X + W + 60, top - 4, 'central pixel', 't-tick', 'end');
    g += key(X - 120, top + rows.length * rowH + 36, keys.map(([, label], k) => [rect(0, -5, 12, 8, `fill="${PALE[k]}"`), label]));
    const want = { 'wv-ps': 2.75, wv: 8, 'pleiades-ps': 5.75, pleiades: 12.75, planet: 21.75, 's2-10': 51.75 };
    need(rows.every(({ q, f }) => f.central === want[q.id]) && rows.every(({ f }) => f.central >= f.centralRegistered && f.centralRegistered >= f.anyPixel), "the central-pixel figures are the note's own: 2.75, 8, 5.75, 12.75, 21.75 and 51.75 m");
    const s2 = rows.find(z => z.q.id === 's2-10').f;
    parts.noteplots = figure(600, top + rows.length * rowH + 50, "The note's minimum plots for the six sensors it measured",
      g, `The note's four minimum plots for the six sensors whose blur it measured; the figure written is the first, the central pixel. Sentinel-2 asks for ${s2.central} m by that criterion and ${s2.anyPixel} m if any pixel will do. On a common 2 m grid, where only the optics differ, the sensors come much closer together.`);
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
      'Sketches, not computed: a blur that changes with the band, a real spot whose tails are heavier than a Gaussian\'s, two repetitions of a variety that do not grow alike, and the grid at another rotation than the one drawn. White: what is simulated. Blue: what is left out.');
  }

  // ---- What stays in the browser and what goes out.
  {
    const out = ['map tiles', 'place search', 'fonts', "a fixed grid's catalog"];
    let g = rect(4, 4, 250, 172, 'class="card" rx="6"') + text(16, 26, 'Your browser', 't-strong') + ['the field and the design', 'every setting', 'the trial file: read here,', 'never sent'].map((q, k) => text(16, 50 + k * 18, q)).join('');
    g += rect(16, 132, 150, 30, 'class="ink" rx="4"') + text(26, 151, 'a trial file');
    out.forEach((q, k) => { const y = 14 + k * 42; g += rect(420, y, 190, 30, 'class="card" rx="5"') + text(432, y + 19, q) + line(256, 40 + k * 22, 412, y + 15, 'ink') + `<path d="M${c(420)} ${c(y + 15)}l-8 -4v8z" class="solid"/>`; });
    g += line(168, 147, 300, 147, 'warn') + line(292, 139, 308, 155, 'warn') + line(308, 139, 292, 155, 'warn') + text(318, 151, 'stays', 't-tick');
    parts.storage = figure(616, 182, 'What the designer keeps in the browser and what it asks of outside services',
      g, 'The designer asks four things of the outside: the map\'s tiles, the place search, its fonts and, for a satellite with a fixed grid, the catalog the grid is read from. The field, the design, the settings and a trial file stay in the browser.');
  }

  // ---- The designer's own menus, as pictures of the page itself (scripts/docs-screenshots.mjs writes them, and their sizes).
  {
    const sizes = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs-img/shots.json'), 'utf8'));
    const shot = (name, alt, caption) => {
      const q = sizes[name];
      need(q && fs.existsSync(path.join(ROOT, 'docs-img', `${name}.png`)), `the picture ${name}.png is in docs-img, with its size`);
      return `<figure class="shot" style="--w: ${q.w}px"><img src="./docs-img/${name}.png" alt="${alt}" width="${q.w}" height="${q.h}" loading="lazy" decoding="async"><figcaption>${caption}</figcaption></figure>`;
    };
    const row = (...items) => `<div class="shots">${items.join('')}</div>`;
    parts.shotsOverview = shot('app', 'The designer: a map with a trial on the left, the panel with its three steps on the right',
      'The designer. Left, the map, with the trial of the first example and its pure pixels outlined. Right, the panel, step 2 open on its Satellite fold. The pictures of this page are taken with no background map under the trial.')
      + shot('step-area', 'Step 1, Experiment area', 'Step 1, Experiment area: the place search, Box and Shape to draw the area, Clear, and the button that pins the field.');
    parts.shotsMap = shot('layers-menu', 'The Layers menu', 'The Layers menu: the basemap, then the five switches. A switch that cannot be used is greyed.')
      + row(shot('layer-simulation', 'The map with every switch off', 'With every switch off: each pixel in the blend of what it sees.'),
        shot('layer-pure', 'The map with the Pure pixels layer', 'Pure pixels: those that hold outlined, the rest under a veil.'),
        shot('layer-real-field', 'The map with the Real field layer', 'Real field: the planting pattern under the pixel grid.'),
        shot('layer-sigmas', 'The map with the three sigma rings', 'σ PSF, geo, eff: the three rings and the two circles that hold 90 % of the signal, with their radii.'),
        shot('layer-signal', 'The map with the signal of a pixel as dots', 'Signal of a pixel: its dots, and the card of shares. The first line is the purity; the mark on the bar is the threshold.'));
    parts.shotsSatellite = shot('fold-satellite', 'The Satellite fold', 'The Satellite fold: the satellite, σ PSF along x and y in pixels, the CE90 with Default and Use, what the trial is placed for, and the FWHM with its ratio to the pixel.');
    parts.shotsBudget = shot('fold-budget', 'The list Every source of blur', 'Every source of blur, for Sentinel-2 and the 40 m plots of the first example.');
    parts.shotsDesigns = row(shot('fold-design', 'The Design fold for randomised blocks', 'The Design fold for randomised blocks, with the size of the trial under its fields.'),
      shot('fold-design-rows', 'The Design fold for alternating rows', 'The same fold for alternating rows.'));
    parts.shotsImported = row(shot('fold-import', 'The Design fold with a trial read from a file', 'A trial read from a file: its plots and varieties, the two columns, the attribute table open, and the angle.'),
      shot('map-import', 'The imported trial on the map', 'That trial on the map, on Sentinel-2 pixels: a pixel that holds has a solid outline.'));
    parts.shotsSuggest = shot('fold-suggest', 'Suggest a design, after Build', 'Suggest a design after Build, for the first example: what was asked, and the trial built.');
    parts.shotsPlotSize = shot('fold-plot-size', 'The Plot size required card', 'Plot size required for Sentinel-2. The row with a field is the count asked for; under it, the most this field allows, and what the design holds now.');
    parts.shotsCurves = row(shot('fold-curves', 'The Growth curves fold', 'Growth curves: a crop for each species, a button to edit its curve, and the season.'),
      shot('fold-noise', 'The Noise and purity threshold fold', 'Noise & purity threshold.'));
    parts.shotsChart = row(shot('chart-scatter', 'The chart, Scatter tab', 'Scatter.'), shot('chart-variance', 'The chart, Variance tab', 'Variance.'),
      shot('chart-loadings', 'The chart, Loadings tab', 'Loadings.'), shot('chart-purity', 'The chart, Purity tab', 'Purity.'));
    parts.shotsTable = row(shot('table', 'The table Across satellites', 'The table: one row per satellite, the one selected outlined.'),
      shot('table-compare', 'The table in a comparison', 'A comparison: the trial turned by 20° against the same trial along the pixel rows.'),
      shot('table-charts', 'The Charts view', 'The Charts view: one small PCA per satellite.'));
    need(Object.keys(sizes).every(name => Object.values(parts).some(h => h.includes(`./docs-img/${name}.png`))), 'every picture taken is shown on the page');
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
