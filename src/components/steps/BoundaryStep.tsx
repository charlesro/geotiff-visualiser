import React from 'react';
import { LineChart } from 'lucide-react';
import { ZoneExtraction } from '../../lib/zones';
import { Button, PrereqNote } from '../ui';

/**
 * Step 6 — the boundary (edge-response) profile: how a metric behaves with
 * distance to the field edge, pooled over every boundary.
 */
export default function BoundaryStep({
  zones,
  onOpen,
}: {
  zones: ZoneExtraction | null;
  onOpen: () => void;
}) {
  return (
    <>
      {!zones && <PrereqNote message="Extract the pixel zones in step 3 first — the profile pools those pixels by distance to the boundary." />}
      <p className="text-xs leading-relaxed text-slate-500">
        Pools every pixel along the signed distance to its field edge (gap → boundary → interior) and plots the
        population edge-response curve, with the depth and magnitude of edge influence. Split it by pixel class or by
        date, and export the binned profile.
      </p>
      <Button onClick={onOpen} disabled={!zones} className="w-full">
        <LineChart className="h-3.5 w-3.5" />
        Open boundary profile
      </Button>
    </>
  );
}
