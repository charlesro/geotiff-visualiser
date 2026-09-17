import proj4 from 'proj4';
import { crsToProj4Def } from '../lib/geo';
import { fieldOverlapTest, type Poly } from './geometry';

/**
 * "Is this pixel in the field?", asked of a grid's cells: true when the cell's
 * square shares area with the field (geometry.ts fieldOverlapTest), tested in
 * the grid's own UTM metres against the exact lattice square, not the cell's
 * reprojected WGS84 corners. One test for every place that asks: the map's
 * in-field view and simulation overlay, the pixel count, the export and the
 * PCA. Null when there is no field ring (everything is in).
 */
export function cellInFieldTest(field: Poly | null, epsg: number, res: number): ((cell: { east: number; north: number }) => boolean) | null {
  if (!field || field.length < 3) return null;
  const to = proj4('EPSG:4326', crsToProj4Def(`EPSG:${epsg}`));
  const overlaps = fieldOverlapTest(field.map(p => to.forward(p) as [number, number]));
  return cell => overlaps(cell.east, cell.north, res);
}
