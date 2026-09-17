import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * The PCA scatter, drawn on a <canvas>.
 *
 * It used to be a recharts ScatterChart with one <Symbols> per pixel. A field of
 * 22,000 pixels put about 87,000 SVG nodes in the page, and ANY change (clicking
 * a point, clearing the selection, switching the colour mode) made React
 * reconcile all of them: 5 to 8 seconds of frozen page per click. The ladder's
 * mini charts already went to canvas for the same reason.
 *
 * Here the points are one canvas, redrawn in tens of milliseconds, and only the
 * axes, grid and labels stay SVG (a few dozen nodes). Hover and click use a
 * bucketed screen-space index, so finding the point under the cursor never
 * scans the whole set.
 */

import type { SymbolType } from './pca-field';
export type { SymbolType };

export interface ScatterPoint {
  x: number;
  y: number;
  color: string;
  sym: SymbolType;
  /** Pixel index: what a click or lasso reports. */
  k: number;
  /** A light rim, for points too dark to see against the chart background. */
  rim?: boolean;
}

/** Room for the axes, matching the recharts layout this replaces. */
const M = { top: 10, right: 12, bottom: 42, left: 42 };
/** Symbol AREA in px², as recharts' <Symbols size>. */
const AREA = 34;
/** Hit radius for hover and click, in CSS px. */
const HIT_R = 7;
/** Bucket size of the hit index. At least HIT_R, so a 3 × 3 neighbourhood covers it. */
const CELL = 8;

/** A "nice" axis over [min, max]: rounded bounds and about `count` evenly spaced ticks. */
function niceAxis(min: number, max: number, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: -1, hi: 1, ticks: [-1, 0, 1] };
  if (max - min < 1e-12) { min -= 1; max += 1; }
  const raw = (max - min) / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { lo, hi, ticks };
}

/**
 * Trace one symbol as a path centred on (x, y), sized by AREA like d3's symbol
 * generators that recharts uses, so shapes keep the size they had.
 */
function tracePath(ctx: CanvasRenderingContext2D, type: SymbolType, x: number, y: number) {
  ctx.beginPath();
  switch (type) {
    case 'circle': {
      ctx.arc(x, y, Math.sqrt(AREA / Math.PI), 0, Math.PI * 2);
      break;
    }
    case 'square': {
      const w = Math.sqrt(AREA);
      ctx.rect(x - w / 2, y - w / 2, w, w);
      break;
    }
    case 'triangle': {
      const s = Math.sqrt(AREA / (3 * Math.sqrt(3)));
      ctx.moveTo(x, y - 2 * s);
      ctx.lineTo(x + Math.sqrt(3) * s, y + s);
      ctx.lineTo(x - Math.sqrt(3) * s, y + s);
      ctx.closePath();
      break;
    }
    case 'diamond': {
      const tan30 = Math.sqrt(1 / 3);
      const dy = Math.sqrt(AREA / (2 * tan30)), dx = dy * tan30;
      ctx.moveTo(x, y - dy); ctx.lineTo(x + dx, y); ctx.lineTo(x, y + dy); ctx.lineTo(x - dx, y);
      ctx.closePath();
      break;
    }
    case 'cross': {
      const r = Math.sqrt(AREA / 5) / 2;
      ctx.moveTo(x - 3 * r, y - r); ctx.lineTo(x - r, y - r); ctx.lineTo(x - r, y - 3 * r);
      ctx.lineTo(x + r, y - 3 * r); ctx.lineTo(x + r, y - r); ctx.lineTo(x + 3 * r, y - r);
      ctx.lineTo(x + 3 * r, y + r); ctx.lineTo(x + r, y + r); ctx.lineTo(x + r, y + 3 * r);
      ctx.lineTo(x - r, y + 3 * r); ctx.lineTo(x - r, y + r); ctx.lineTo(x - 3 * r, y + r);
      ctx.closePath();
      break;
    }
    case 'star': {
      const ka = 0.8908130915292852, kr = Math.sin(Math.PI / 10) / Math.sin((7 * Math.PI) / 10);
      const r = Math.sqrt(AREA * ka), inner = kr * r;
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i - Math.PI / 2, rad = i % 2 ? inner : r;
        const px = x + rad * Math.cos(a), py = y + rad * Math.sin(a);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'wye': {
      const k = 1 / Math.sqrt(12), a = (k / 2 + 1) * 3;
      const r = Math.sqrt(AREA / a), x0 = r / 2, y0 = r * k, y1 = r * k + r;
      const c = -0.5, s = Math.sqrt(3) / 2;
      const pts: [number, number][] = [[x0, y0], [x0, y1], [-x0, y1]];
      const out: [number, number][] = [];
      for (const [px, py] of pts) out.push([px, py]);
      for (const [px, py] of pts) out.push([c * px - s * py, s * px + c * py]);
      for (const [px, py] of pts) out.push([c * px + s * py, -s * px + c * py]);
      // d3 traces this in SVG coordinates, where y already grows downward like a
      // canvas: adding py keeps the stem pointing down, as recharts drew it.
      out.forEach(([px, py], i) => (i ? ctx.lineTo(x + px, y + py) : ctx.moveTo(x + px, y + py)));
      ctx.closePath();
      break;
    }
  }
}

const pointInPolygon = (px: number, py: number, poly: { x: number; y: number }[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
};

export function PcaScatterCanvas<T extends ScatterPoint>({ points, selected, xLabel, yLabel, height, lassoOn, onPick, renderTooltip }: {
  points: T[];
  /** Pixel indices (ScatterPoint.k) currently selected. */
  selected: Set<number>;
  xLabel: string;
  yLabel: string;
  height: number;
  lassoOn: boolean;
  onPick: (ks: number[]) => void;
  renderTooltip: (p: T) => ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  // Bumped when devicePixelRatio changes (window dragged to a Retina screen,
  // browser zoom). The CSS size does not move then, so nothing else would
  // redraw and the backing store would stay at the old density, blurry.
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [dpr]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const axes = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    return { x: niceAxis(x0, x1), y: niceAxis(y0, y1) };
  }, [points]);

  const plotW = Math.max(1, width - M.left - M.right);
  const plotH = Math.max(1, height - M.top - M.bottom);
  const sx = (v: number) => M.left + ((v - axes.x.lo) / (axes.x.hi - axes.x.lo)) * plotW;
  const sy = (v: number) => M.top + plotH - ((v - axes.y.lo) / (axes.y.hi - axes.y.lo)) * plotH;

  // Screen positions and a bucketed hit index. Rebuilt only when the data or the
  // size changes, never on selection or hover.
  const layout = useMemo(() => {
    const n = points.length;
    const px = new Float32Array(n), py = new Float32Array(n);
    const cols = Math.ceil((width + 1) / CELL) + 2;
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      px[i] = sx(points[i].x); py[i] = sy(points[i].y);
      const key = Math.floor(py[i] / CELL) * cols + Math.floor(px[i] / CELL);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(i);
    }
    return { px, py, cols, buckets };
  }, [points, axes, width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !width) return;
    cv.width = Math.round(width * dpr); cv.height = Math.round(height * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.beginPath(); ctx.rect(M.left, M.top, plotW, plotH); ctx.clip();
    const hasSel = selected.size > 0;
    const { px, py } = layout;
    // Unselected first (dimmed when there is a selection), selected on top.
    for (let pass = 0; pass < (hasSel ? 2 : 1); pass++) {
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const isSel = hasSel && selected.has(p.k);
        if ((pass === 0) === isSel) continue;
        tracePath(ctx, p.sym, px[i], py[i]);
        ctx.globalAlpha = hasSel && !isSel ? 0.2 : 0.85;
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = isSel ? '#fde047' : p.rim ? '#94a3b8' : '#0b0e11';
        ctx.lineWidth = isSel ? 1 : p.rim ? 0.8 : 0.5;
        ctx.stroke();
        if (isSel) {
          ctx.beginPath(); ctx.arc(px[i], py[i], 7, 0, Math.PI * 2);
          ctx.strokeStyle = '#fde047'; ctx.lineWidth = 2; ctx.stroke();
        }
      }
    }
    ctx.restore();
  }, [layout, selected, width, height, dpr]); // eslint-disable-line react-hooks/exhaustive-deps

  const nearest = (mx: number, my: number) => {
    const { px, py, cols, buckets } = layout;
    const cx0 = Math.floor(mx / CELL), cy0 = Math.floor(my / CELL);
    let best = -1, bd = HIT_R * HIT_R;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const b = buckets.get((cy0 + dy) * cols + (cx0 + dx));
      if (!b) continue;
      // Later points are drawn on top, so on a tie the later one wins.
      for (const i of b) { const d = (px[i] - mx) ** 2 + (py[i] - my) ** 2; if (d <= bd) { bd = d; best = i; } }
    }
    return best;
  };
  const local = (e: React.MouseEvent | React.PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const onMove = (e: React.MouseEvent) => {
    if (lassoOn) return;
    const q = local(e), i = nearest(q.x, q.y);
    if (i < 0) { if (hover) setHover(null); return; }
    if (!hover || hover.i !== i) setHover({ i, x: q.x, y: q.y });
  };
  const onClick = (e: React.MouseEvent) => {
    if (lassoOn) return;
    const q = local(e), i = nearest(q.x, q.y);
    if (i >= 0) onPick([points[i].k]);
  };

  // ----- lasso ---------------------------------------------------------------
  const [lassoPath, setLassoPath] = useState<{ x: number; y: number }[]>([]);
  const drawing = useRef(false);
  const pathRef = useRef<{ x: number; y: number }[]>([]);
  const lassoDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!lassoOn) return;
    e.preventDefault();
    // Capture can throw for a pointer the browser is not tracking (a pen lifted
    // mid-gesture, a synthetic event); the lasso still works without it.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    drawing.current = true;
    pathRef.current = [local(e)]; setLassoPath(pathRef.current);
  };
  const lassoMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const q = local(e), prev = pathRef.current;
    if (prev.length && Math.hypot(prev[prev.length - 1].x - q.x, prev[prev.length - 1].y - q.y) < 2) return;
    pathRef.current = [...prev, q]; setLassoPath(pathRef.current);
  };
  const lassoUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const path = pathRef.current;
    if (path.length >= 3) {
      const { px, py } = layout;
      const ks: number[] = [];
      for (let i = 0; i < points.length; i++) if (pointInPolygon(px[i], py[i], path)) ks.push(points[i].k);
      onPick(ks);
    }
    pathRef.current = []; setLassoPath([]);
  };

  const hovered = hover && !lassoOn && hover.i < points.length ? points[hover.i] : null;
  // Placed from the tooltip's MEASURED size, the way recharts did: right of the
  // cursor when it fits, otherwise left of it, and never past either edge. A
  // fixed guess clipped the smallest share off wider compositions.
  const tipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !hover) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = hover.x + 12;
    if (left + w > width) left = hover.x - 12 - w;
    left = Math.max(0, Math.min(left, width - w));
    let top = hover.y - h - 8;
    if (top < 0) top = hover.y + 12;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(0, Math.min(top, height - h))}px`;
    el.style.visibility = 'visible';
  });

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height, cursor: !lassoOn && hover ? 'pointer' : 'default' }}
      onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={onClick}>
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        {axes.x.ticks.map(t => (
          <line key={`gx${t}`} x1={sx(t)} x2={sx(t)} y1={M.top} y2={M.top + plotH} stroke="#ffffff0a" strokeDasharray="3 6" />
        ))}
        {axes.y.ticks.map(t => (
          <line key={`gy${t}`} x1={M.left} x2={M.left + plotW} y1={sy(t)} y2={sy(t)} stroke="#ffffff0a" strokeDasharray="3 6" />
        ))}
        <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} stroke="#ffffff14" />
        <line x1={M.left} x2={M.left} y1={M.top} y2={M.top + plotH} stroke="#ffffff14" />
        {axes.x.ticks.map(t => (
          <text key={`tx${t}`} x={sx(t)} y={M.top + plotH + 14} textAnchor="middle" fill="#64748b" fontSize={10}>{t.toFixed(2)}</text>
        ))}
        {axes.y.ticks.map(t => (
          <text key={`ty${t}`} x={M.left - 5} y={sy(t) + 3} textAnchor="end" fill="#64748b" fontSize={10}>{t.toFixed(2)}</text>
        ))}
        {hovered && hover && (
          <>
            <line x1={layout.px[hover.i]} x2={layout.px[hover.i]} y1={M.top} y2={M.top + plotH} stroke="#475569" strokeDasharray="3 3" />
            <line x1={M.left} x2={M.left + plotW} y1={layout.py[hover.i]} y2={layout.py[hover.i]} stroke="#475569" strokeDasharray="3 3" />
          </>
        )}
        <text x={M.left + plotW / 2} y={height - 6} textAnchor="middle" fill="#94a3b8" fontSize={11}>{xLabel}</text>
        <text transform={`translate(11 ${M.top + plotH / 2}) rotate(-90)`} textAnchor="middle" fill="#94a3b8" fontSize={11}>{yLabel}</text>
      </svg>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" style={{ width: '100%', height }} />
      {hovered && (
        <div ref={tipRef} className="pointer-events-none absolute z-10 max-w-full whitespace-nowrap rounded-md border border-white/10 bg-[#11151a] px-2 py-1 text-[11px] text-slate-300 shadow-lg"
          style={{ left: 0, top: 0, visibility: 'hidden' }}>
          {renderTooltip(hovered)}
        </div>
      )}
      {/* Lasso overlay: takes pointer events only while the lasso is armed. */}
      <svg className="absolute inset-0 h-full w-full"
        style={{ pointerEvents: lassoOn ? 'auto' : 'none', cursor: lassoOn ? 'crosshair' : 'default', touchAction: 'none' }}
        onPointerDown={lassoDown} onPointerMove={lassoMove} onPointerUp={lassoUp} onPointerCancel={lassoUp}>
        {lassoPath.length > 1 && (
          <polygon points={lassoPath.map(p => `${p.x},${p.y}`).join(' ')} fill="#38bdf822" stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="4 3" />
        )}
      </svg>
    </div>
  );
}

/** One legend icon, drawn with the chart's own symbol paths so the key cannot disagree with the dots. */
export function SymbolIcon({ type, color }: { type: SymbolType; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1, size = 12;
    cv.width = size * dpr; cv.height = size * dpr;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    tracePath(ctx, type, size / 2, size / 2);
    ctx.fillStyle = color; ctx.globalAlpha = 0.9; ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = '#0b0e11'; ctx.lineWidth = 0.5; ctx.stroke();
  }, [type, color]);
  return <canvas ref={ref} style={{ width: 12, height: 12 }} className="inline-block shrink-0" />;
}
