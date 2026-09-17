import { useCallback, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Rectangle, Polygon, GeoJSON, Pane, ScaleControl } from 'react-leaflet';
import L from 'leaflet';
import { AOI_STYLE, BASEMAPS, GridLines, PolyDrawer, PsfOverlay, RectDrawer, TruthOverlay, ViewTracker, type BasemapKey } from './map-layers';
import { BARE, OFF_TRIAL } from './simulate';
import type { useAoiField } from './use-area';
import type { useFieldGrid } from './use-grid';
import type { Experiment, useSimulation, usePcaSim } from './use-simulation';

/** Most species keys the map legend lists before summarising the rest. */
const LEGEND_MAX = 12;

/**
 * The map half of the page: basemap, the drawn field, the pixel the
 * simulation overlay, the PSF footprint, and the two draw tools.
 *
 * It takes the hook objects whole rather than 30-odd scalars — the alternative
 * is a prop list nobody can read. `geoKey` is the exception and arrives as an
 * opaque string: it is assembled in the SHELL because that is the only scope
 * where all thirteen of its inputs are live, and it exists because react-leaflet
 * will not restyle a <GeoJSON> on a prop change. Remounting on a changed key is
 * the ONLY thing that repaints the overlay, so a dropped segment shows up as a
 * stale map with no type error and no test failure.
 *
 * Do not wrap this in React.memo, and do not memoize what it passes down:
 * GridLines reads the map's centre and zoom during render and has no event
 * subscription of its own, so it only refreshes because ViewTracker re-renders
 * this whole tree.
 */
export function FieldMap({
  mapRef, initialCenter, initialZoom, onView, basemap, setBasemap, showField, setShowField, showPsf, setShowPsf,
  fieldOnly, setFieldOnly, simOn, geoKey, area, gridApi, exp, sim, pca,
}: {
  mapRef: React.MutableRefObject<L.Map | null>;
  initialCenter: [number, number];
  initialZoom: number;
  onView: (center: [number, number], zoom: number) => void;
  basemap: BasemapKey; setBasemap: (b: BasemapKey) => void;
  showField: boolean; setShowField: (v: boolean | ((p: boolean) => boolean)) => void;
  showPsf: boolean; setShowPsf: (v: boolean | ((p: boolean) => boolean)) => void;
  fieldOnly: boolean; setFieldOnly: (v: boolean | ((p: boolean) => boolean)) => void;
  simOn: boolean; geoKey: string;
  area: ReturnType<typeof useAoiField>;
  gridApi: ReturnType<typeof useFieldGrid>;
  exp: Experiment;
  sim: ReturnType<typeof useSimulation>;
  pca: ReturnType<typeof usePcaSim>;
}) {
  const { aoi, aoiPoly, fieldRing, drawKind, drawMode, onDrawDone, onPolyDone } = area;
  const { build, geojson, fieldGeojson, lineBox, psfCenter, psfSigmaM, psfSigmaXM, psfSigmaYM, psfFwhmXM, psfFwhmYM, setViewBounds } = gridApi;
  const { layout, layoutSig, spacing, colors, names } = exp;
  const { patternOrigin, simGeojson, simStyle, fieldOutlineStyle } = sim;
  // Metres between the ruled lines when the grid is too fine to rule every pixel
  // edge (0 when every edge is drawn). Named on the map so a coarse mesh is never
  // read as the pixel grid itself.
  const [lineStepM, setLineStepM] = useState(0);
  const onGridStep = useCallback((m: number) => setLineStepM(m), []);
  const { selectedPixels, selectionGeojson } = pca;
  /**
   * The simulation overlay with "In field only" applied. Both simulation views
   * used to draw simGeojson straight through, so while step 3 or 4 was open the
   * toggle changed nothing on screen. Filtered by the same col/row key as the
   * in-field pixel list, so the two can never disagree about which pixels count.
   */
  const shownSim = useMemo(() => {
    if (!fieldOnly || !fieldGeojson || !simGeojson) return simGeojson;
    const keep = new Set((fieldGeojson.features as any[]).map(f => `${f.properties.col},${f.properties.row}`));
    return { ...simGeojson, features: simGeojson.features.filter(f => keep.has(`${f.properties.col},${f.properties.row}`)) };
  }, [fieldOnly, fieldGeojson, simGeojson]);
  // react-leaflet never redraws a <GeoJSON> when its data changes, so the key
  // has to move with the toggle or the filtered overlay would not appear.
  const fieldKey = fieldOnly ? '-in' : '';

  return (
      <div className="relative flex-1">
        <MapContainer
          ref={mapRef}
          center={initialCenter}
          zoom={initialZoom}
          maxZoom={23}
          preferCanvas
          style={{ height: '100%', width: '100%' }}
          attributionControl
        >
          <TileLayer
            key={basemap}
            url={BASEMAPS[basemap].url}
            attribution={BASEMAPS[basemap].attribution}
            maxZoom={23}
            // Past its native zoom Leaflet stretches the last real tile rather than
            // requesting ones that do not exist (Esri's dark canvas ends at 16).
            maxNativeZoom={basemap === 'satellite' ? 18 : basemap === 'dark' ? 16 : 19}
          />
          <ScaleControl position="bottomleft" />
          <ViewTracker onChange={setViewBounds} onView={onView} />
          <RectDrawer active={drawKind === 'rect'} onDone={onDrawDone} />
          <PolyDrawer active={drawKind === 'poly'} onDone={onPolyDone} />
          {aoi && !drawMode && (
            aoiPoly
              ? <Polygon positions={aoiPoly.map(([lng, lat]) => [lat, lng]) as [number, number][]} pathOptions={AOI_STYLE} />
              : <Rectangle bounds={[[aoi[1], aoi[0]], [aoi[3], aoi[2]]]} pathOptions={AOI_STYLE} />
          )}
          {showField && lineBox && build && aoi && patternOrigin && (
            <TruthOverlay extent={lineBox} epsg={build.epsg} layout={layout} layoutSig={layoutSig} origin={patternOrigin.origin} colors={colors} clipPoly={fieldRing ?? undefined} />
          )}
          {showPsf && psfCenter && psfSigmaM > 0 && (
            <PsfOverlay center={psfCenter} sigmaXM={psfSigmaXM} sigmaYM={psfSigmaYM} fwhmXM={psfFwhmXM} fwhmYM={psfFwhmYM} light={BASEMAPS[basemap].light} />
          )}
          {/* The PCA selection lives in its OWN pane above the overlay pane. On the
              shared canvas, layers paint in the order they were added, so anything
              that remounted the simulation layer (a basemap switch, the In field
              only toggle) repainted it over the yellow highlight and hid it. */}
          <Pane name="selection" style={{ zIndex: 450 }}>
            {selectionGeojson && (
              <GeoJSON key={`sel-${selectedPixels.length}-${selectedPixels[0] ?? ''}`} data={selectionGeojson}
                style={() => ({ color: '#fde047', weight: 2, fillColor: '#fde047', fillOpacity: 0.35, interactive: false }) as L.PathOptions} />
            )}
          </Pane>
          {(() => {
            const gridLines = lineBox && build
              ? <GridLines box={lineBox} res={build.res} epsg={build.epsg} color={BASEMAPS[basemap].light ? '#0f172a' : '#f1f5f9'} weight={0.6} onStep={onGridStep} />
              : null;
            if (showField) {
              // Per-cell outlines (with not-pure rings) when cells are available;
              // otherwise just the pixel-grid lines, so a thin grid never vanishes.
              const d = shownSim ?? (fieldOnly ? fieldGeojson : null) ?? geojson;
              return d
                ? <GeoJSON key={geoKey + '-field' + fieldKey} data={d as any} style={fieldOutlineStyle} />
                : gridLines;
            }
            if (simOn && shownSim) return <GeoJSON key={geoKey + fieldKey} data={shownSim} style={(f: any) => simStyle(f?.properties?.f ?? 0, f?.properties?.b ?? 0, f?.properties?.mx ?? 0, f?.properties?.sp, f?.properties?.off ?? 0)} />;
            // "In field only": draw the kept cells as squares instead of ruling
            // lines across the whole bounding box. Same colour as the lines so it
            // reads as the same grid, just trimmed.
            if (fieldOnly && fieldGeojson) {
              const col = BASEMAPS[basemap].light ? '#0f172a' : '#f1f5f9';
              return <GeoJSON key={geoKey + '-inField'} data={fieldGeojson as any}
                style={() => ({ color: col, weight: 0.6, opacity: 0.85, fill: false, interactive: false }) as L.PathOptions} />;
            }
            return gridLines;
          })()}
        </MapContainer>

        {/* Basemap switcher */}
        <div className="absolute right-3 top-3 z-[1000] flex overflow-hidden rounded-md border border-white/10 bg-[#11151acc] text-xs backdrop-blur">
          {(Object.keys(BASEMAPS) as BasemapKey[]).map(key => (
            <button
              key={key}
              onClick={() => setBasemap(key)}
              className={`px-3 py-1.5 transition-colors ${
                basemap === key ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {BASEMAPS[key].label}
            </button>
          ))}
        </div>

        {/* The three map toggles.
            Their ACTIVE state keeps the same dark plate as the inactive one and
            signals itself with the border and text colour instead. The old active
            style swapped the plate for bg-sky-500/20, which on a pale basemap
            (topo, streets) left light-blue text sitting on near-white. */}
        {/* Real-field (true planting pattern) toggle */}
        <button
          onClick={() => setShowField(v => !v)}
          disabled={!build}
          title="Show the planting pattern under the grid"
          className={`absolute right-3 top-12 z-[1000] rounded-md border px-3 py-1.5 text-xs backdrop-blur transition-colors disabled:opacity-40 ${
            showField ? 'border-sky-400/70 bg-[#11151acc] text-sky-300' : 'border-white/10 bg-[#11151acc] text-slate-300 hover:text-slate-100'
          }`}
        >
          {showField ? '✓ Real field' : 'Real field'}
        </button>

        {/* Trim the grid to the traced field */}
        <button
          onClick={() => setFieldOnly(v => !v)}
          disabled={!build || !fieldGeojson}
          title={!fieldGeojson
            ? (aoi ? 'Zoom in until the pixels are drawn to use this' : 'Draw a field in step 1 to use this')
            : 'Show only the exported pixels (centred inside the field)'}
          className={`absolute right-3 top-[5.25rem] z-[1000] rounded-md border px-3 py-1.5 text-xs backdrop-blur transition-colors disabled:opacity-40 ${
            fieldOnly ? 'border-sky-400/70 bg-[#11151acc] text-sky-300' : 'border-white/10 bg-[#11151acc] text-slate-300 hover:text-slate-100'
          }`}
        >
          {fieldOnly ? '✓ In field only' : 'In field only'}
        </button>

        {/* Sensor PSF footprint toggle */}
        <button
          onClick={() => setShowPsf(v => !v)}
          disabled={!build || psfSigmaM <= 0}
          title="Show the sensor's blur footprint to scale"
          className={`absolute right-3 top-[7.5rem] z-[1000] rounded-md border px-3 py-1.5 text-xs backdrop-blur transition-colors disabled:opacity-40 ${
            showPsf ? 'border-sky-400/70 bg-[#11151acc] text-sky-300' : 'border-white/10 bg-[#11151acc] text-slate-300 hover:text-slate-100'
          }`}
        >
          {showPsf ? '✓ PSF blur' : 'PSF blur'}
        </button>

        {drawMode && (
          <div className="pointer-events-none absolute left-1/2 top-4 z-[1000] -translate-x-1/2 rounded-full bg-sky-500/90 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
            {drawKind === 'poly'
              ? 'Click to add corners · click the first point (or double-click) to close · Esc to cancel'
              : 'Click and drag to draw a box · press Esc to cancel'}
          </div>
        )}

        {/* Map legend (simulation overlay colours) */}
        {simOn && simGeojson && (
          <div className="pointer-events-none absolute bottom-7 left-2 z-[1000] rounded-md border border-white/10 bg-[#11151a]/85 px-2.5 py-2 text-[11px] text-slate-200 backdrop-blur">
            <div className="mb-1 font-medium text-slate-300">Mixture</div>
            <div className="space-y-1">
              {/* Two species still read best as one gradient (a pixel is some
                  blend of exactly those two). Past two there is no single axis
                  to run along, so the legend becomes a swatch list. */}
              {colors.length === 2 ? (
                <>
                  <div className="h-2.5 w-44 rounded-sm" style={{ background: `linear-gradient(to right, ${colors[1]}, ${colors[0]})` }} />
                  <div className="flex w-44 items-baseline justify-between gap-1 text-[10px] text-slate-400">
                    <span className="truncate">all {names[1]}</span>
                    <span className="shrink-0 text-slate-500">50/50</span>
                    <span className="truncate text-right">all {names[0]}</span>
                  </div>
                </>
              ) : (
                <div className="grid w-44 grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-slate-400">
                  {/* An imported trial can carry dozens of varieties; past a
                      dozen the key would cover the map it explains. The full
                      list, with counts, is the PCA's Purity tab. */}
                  {names.slice(0, names.length > LEGEND_MAX ? LEGEND_MAX - 1 : LEGEND_MAX).map((n, i) => (
                    <span key={i} className="flex items-center gap-1 truncate">
                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colors[i] }} />
                      <span className="truncate">{n}</span>
                    </span>
                  ))}
                  {names.length > LEGEND_MAX && (
                    <span className="col-span-2 text-slate-500">+ {names.length - (LEGEND_MAX - 1)} more varieties</span>
                  )}
                </div>
              )}
              {(spacing > 0 || layout.pattern === 'block' || layout.pattern === 'imported') && (
                <div className="flex items-center gap-1 text-[10px] text-slate-400">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BARE.color }} /> bare-soil alley
                </div>
              )}
              {(layout.pattern === 'block' || layout.pattern === 'imported') && (
                <div className="flex items-center gap-1 text-[10px] text-slate-400">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: OFF_TRIAL.color }} /> outside the trial
                </div>
              )}
            </div>
          </div>
        )}

        {lineStepM > 0 && (
          <div className={`pointer-events-none absolute left-2 z-[1000] rounded-md border border-white/10 bg-[#11151a]/85 px-2 py-1 text-[10px] text-slate-300 backdrop-blur ${simOn && simGeojson ? 'bottom-[7.5rem]' : 'bottom-7'}`}>
            grid ruled every {lineStepM >= 1000 ? `${+(lineStepM / 1000).toFixed(1)} km` : lineStepM < 10 ? `${+lineStepM.toFixed(2)} m` : `${Math.round(lineStepM)} m`}, not every pixel
          </div>
        )}
      </div>
  );
}
