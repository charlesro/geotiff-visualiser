import React from 'react';
import { Radar } from 'lucide-react';
import { BoundaryPrediction, PredictMethod } from '../../lib/boundary-detect';
import { Button, ErrorNote, Field, PrereqNote, Stat } from '../ui';
import { cn } from '../../lib/utils';

/**
 * Step 7 — predict field boundaries from the spectral mixing and score the
 * prediction against the loaded polygons.
 */

interface Props {
  zones: any | null;
  sceneCount: number;
  prediction: BoundaryPrediction | null;
  busy: boolean;
  error: string | null;
  method: PredictMethod | 'off';
  onMethod: (m: PredictMethod | 'off') => void;
  threshold: number;
  onThreshold: (t: number) => void;
  onRun: () => void;
}

const METHOD_LABEL: Record<PredictMethod, string> = {
  pca: 'PCA',
  gradient: 'Gradient',
  impurity: 'Impurity',
};

export default function BoundaryPredictStep(props: Props) {
  const pcaAvailable = props.prediction?.metrics.pca.available ?? false;
  const impurityAvailable = props.prediction?.metrics.impurity.available ?? false;

  return (
    <>
      {props.sceneCount < 2 && (
        <PrereqNote message="Fetch at least two dates of imagery in step 2 — boundary prediction reads the multitemporal signal." />
      )}
      <p className="text-xs leading-relaxed text-slate-500">
        Pure fields cluster in PCA space; a pixel midway between two pure clusters is a 50/50 mixture — a boundary.
        The <em>PCA</em> score is its distance to the nearest pure cluster (needs the NDVI zones from step 3);{' '}
        <em>impurity</em> is the same in raw NDVI space; <em>gradient</em> is a plain spatial edge detector. Only pixels{' '}
        <em>inside the fields</em> are scored, and all three are checked against the loaded polygon outlines.
      </p>

      <Button onClick={props.onRun} busy={props.busy} disabled={props.sceneCount < 2} className="w-full">
        <Radar className="h-3.5 w-3.5" />
        Predict boundaries
      </Button>
      <ErrorNote message={props.error} />

      {props.prediction && (
        <div className="space-y-3">
          {/* agreement with the ground-truth polygons */}
          <div className="grid grid-cols-3 gap-2">
            <Stat label="PCA · AUC" value={pcaAvailable ? fmt(props.prediction.metrics.pca.auc) : 'n/a'} accent={pcaAvailable ? '#de4940' : undefined} />
            <Stat label="Gradient · AUC" value={fmt(props.prediction.metrics.gradient.auc)} accent="#de4940" />
            <Stat label="Impurity · AUC" value={impurityAvailable ? fmt(props.prediction.metrics.impurity.auc) : 'n/a'} accent={impurityAvailable ? '#de4940' : undefined} />
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500">
            AUC = chance a true-boundary pixel scores above an interior one (0.5 = random, 1 = perfect), against{' '}
            {props.prediction.truePositivePixels.toLocaleString()} boundary px in{' '}
            {props.prediction.evaluatedPixels.toLocaleString()} evaluated.{' '}
            {pcaAvailable
              ? `PCA uses ${props.prediction.pcaClusters} pure clusters.`
              : 'Extract NDVI zones in step 3 to enable the PCA and impurity scores.'}
          </p>

          {/* what to draw on the map */}
          <Field label="Show on map">
            <div className="flex overflow-hidden rounded-md border border-white/10 text-[11px]">
              {(['pca', 'gradient', 'impurity', 'off'] as const).map(m => {
                const disabled = (m === 'impurity' && !impurityAvailable) || (m === 'pca' && !pcaAvailable);
                return (
                  <button
                    key={m}
                    disabled={disabled}
                    onClick={() => props.onMethod(m)}
                    className={cn(
                      'flex-1 px-2 py-1 transition-colors',
                      props.method === m ? 'bg-sky-500/20 text-sky-300' : 'text-slate-500 hover:text-slate-300',
                      disabled && 'cursor-not-allowed opacity-40'
                    )}
                  >
                    {m === 'off' ? 'off' : METHOD_LABEL[m]}
                  </button>
                );
              })}
            </div>
          </Field>

          {props.method !== 'off' && (
            <Field label={`Threshold · ${props.threshold.toFixed(2)}`} hint="Hide pixels below this boundary score.">
              <input
                type="range"
                min={0}
                max={0.9}
                step={0.05}
                value={props.threshold}
                onChange={e => props.onThreshold(Number(e.target.value))}
                className="w-full accent-sky-500"
              />
            </Field>
          )}
        </div>
      )}
    </>
  );
}

const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');
