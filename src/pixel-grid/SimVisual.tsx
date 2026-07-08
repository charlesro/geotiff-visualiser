import { useEffect, useRef } from 'react';
import { BARE, cultureAt, simulatePatch, utmEnvelope, type SimLayout, type SensorParams } from './simulate';
import type { LngLatBounds } from './s2-grid';

const hexRgb = (h: string): [number, number, number] => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

const LADDER = [10, 3, 0.5];

/**
 * The simulation "before / after": your planting design (crisp, fine) versus
 * what each satellite resolution actually sees (blocky, PSF-blurred, mixed).
 * Pure pixels keep the crop colour; mixed pixels are washed out — the loss is
 * the whole point. Everything is computed by the repo engine over a real UTM
 * patch of the drawn field.
 */
export default function SimVisual({ aoi, epsg, origin, layout, sensor, colorA, colorB }: {
  aoi: LngLatBounds; epsg: number; origin: [number, number] | null; layout: SimLayout; sensor: SensorParams; colorA: string; colorB: string;
}) {
  const truthRef = useRef<HTMLCanvasElement>(null);
  const ladderRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  // Geometry: a representative square patch centred on the field.
  const [minE, minN, maxE, maxN] = utmEnvelope(aoi, epsg);
  const cx = (minE + maxE) / 2, cy = (minN + maxN) / 2;
  const fieldMin = Math.min(maxE - minE, maxN - minN);
  const patch = Math.max(16, Math.min(fieldMin, Math.max(layout.width * 8, 30), 90));
  const pMinE = cx - patch / 2, pMinN = cy - patch / 2;
  const [ox, oy] = origin ?? [minE, minN]; // pattern phase (purity-optimised, or field corner)

  const [aR, aG, aB] = hexRgb(colorA);
  const [bR, bG, bB] = hexRgb(colorB);
  const [sR, sG, sB] = hexRgb(BARE.color); // bare-soil gap colour
  const classRgb = (cls: number): [number, number, number] => (cls === 0 ? [aR, aG, aB] : cls === 1 ? [bR, bG, bB] : [sR, sG, sB]);

  // Ground truth — crisp pattern, per-canvas-pixel.
  useEffect(() => {
    const cv = truthRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const cw = cv.width, ch = cv.height;
    const img = ctx.createImageData(cw, ch);
    for (let py = 0; py < ch; py++) {
      const N = pMinN + (1 - (py + 0.5) / ch) * patch;
      for (let px = 0; px < cw; px++) {
        const E = pMinE + ((px + 0.5) / cw) * patch;
        const [cr, cg, cb] = classRgb(cultureAt(E, N, layout, ox, oy));
        const o = (py * cw + px) * 4;
        img.data[o] = cr;
        img.data[o + 1] = cg;
        img.data[o + 2] = cb;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [pMinE, pMinN, patch, ox, oy, layout.pattern, layout.width, layout.spacing, layout.rotationDeg, colorA, colorB]);

  // Resolution ladder — each GSD's sensor view as blocks.
  useEffect(() => {
    LADDER.forEach((gsd, i) => {
      const cv = ladderRefs.current[i];
      if (!cv) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const cw = cv.width, ch = cv.height;
      ctx.clearRect(0, 0, cw, ch);
      const { proportionA, proportionBare, mixed, nx, ny } = simulatePatch(pMinE, pMinN, patch, gsd, ox, oy, layout, sensor);
      const cwpx = cw / nx, chpx = ch / ny;
      const outline = cwpx >= 3.5 && chpx >= 3.5; // black pixel borders when readable
      for (let gr = 0; gr < ny; gr++) {
        for (let gc = 0; gc < nx; gc++) {
          const k = gr * nx + gc;
          const pA = proportionA[k], pBare = proportionBare[k], pB = Math.max(0, 1 - pA - pBare);
          const pure = mixed[k] !== 255;
          let r: number, g: number, b: number;
          if (pure) {
            [r, g, b] = classRgb(mixed[k]); // 0=A, 1=B, 2=bare
          } else {
            const w = pA + pB + pBare || 1;
            r = Math.round((pA * aR + pB * bR + pBare * sR) / w);
            g = Math.round((pA * aG + pB * bG + pBare * sG) / w);
            b = Math.round((pA * aB + pB * bB + pBare * sB) / w);
          }
          const x = gc * cwpx, y = (ny - 1 - gr) * chpx;
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x, y, Math.ceil(cwpx) + 1, Math.ceil(chpx) + 1);
          if (!pure) { ctx.fillStyle = 'rgba(140,150,165,0.4)'; ctx.fillRect(x, y, Math.ceil(cwpx) + 1, Math.ceil(chpx) + 1); }
          if (outline) {
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(cwpx), Math.round(chpx));
          }
        }
      }
      // crisp black frame around the whole thumbnail
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, cw - 1, ch - 1);
    });
  }, [pMinE, pMinN, patch, ox, oy, layout.pattern, layout.width, layout.spacing, layout.rotationDeg, sensor.sigmaX, sensor.sigmaY, sensor.mixThreshold, colorA, colorB]);

  const purities = LADDER.map(gsd => simulatePatch(pMinE, pMinN, patch, gsd, ox, oy, layout, sensor).purePct);

  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-400">
          <span className="font-medium uppercase tracking-wide">Your design</span>
          <span className="text-neutral-500">{patch.toFixed(0)} m across</span>
        </div>
        <canvas ref={truthRef} width={320} height={96} className="block w-full rounded-md" style={{ imageRendering: 'pixelated', aspectRatio: '320 / 96' }} />
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">What each satellite sees</div>
        <div className="grid grid-cols-3 gap-1.5">
          {LADDER.map((gsd, i) => (
            <div key={gsd} className="text-center">
              <canvas
                ref={el => { ladderRefs.current[i] = el; }}
                width={104} height={104}
                className="block w-full rounded-md"
                style={{ imageRendering: 'pixelated', aspectRatio: '1 / 1' }}
              />
              <div className="mt-0.5 text-[11px] leading-tight">
                <span className="font-mono text-neutral-300">{gsd} m</span>{' '}
                <span className={purities[i] >= 70 ? 'text-emerald-400' : purities[i] >= 40 ? 'text-amber-400' : 'text-rose-400'}>
                  {purities[i].toFixed(0)}%
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[11px] leading-snug text-neutral-500">
          Vivid = pure pixel (one crop) · washed = mixed. Pick the coarsest sensor that stays mostly vivid.
        </p>
      </div>
    </div>
  );
}
