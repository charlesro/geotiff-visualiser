import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, X } from 'lucide-react';
import { Boundary } from './Boundary';
import { isBool, usePersistentState } from './persist';
import { MapContainer, TileLayer, Rectangle, Polygon, GeoJSON, Pane, ScaleControl } from 'react-leaflet';
import L from 'leaflet';
import { AOI_STYLE, BASEMAPS, GridLines, KeepSized, PixelHover, PixelPicker, PolyDrawer, RectDrawer, SigmaRings, SignalDots, TruthOverlay, ViewTracker, purityText, type BasemapKey } from './map-layers';
import { BARE, OFF_TRIAL, pixelSources } from './simulate';
import { SOURCE_DOTS, coverNamer, pixelIndexAt, shareText, sourceRows, type SourceRow } from './signal-sources';
import type { useAoiField } from './use-area';
import type { useFieldGrid } from './use-grid';
import type { Experiment, useSimulation, usePcaSim } from './use-simulation';

/** Most species keys the map legend lists before summarising the rest. */
const LEGEND_MAX = 12;

/**
 * The styles of the cell overlays, each ONE function for the life of the page.
 * react-leaflet restyles every cell of a <GeoJSON> whenever its `style` prop is
 * another function, and this tree is rendered again after every pan and zoom:
 * written inline they were new on each render, so each render restyled and
 * redrew every pixel on the map.
 */
/**
 * The Pure pixels layer (use-simulation `pureGeojson`): 2 holds within the CE90
 * (or is pure, with none set) and is an outline; 1 is pure but does not hold,
 * half the veil and a broken outline; 0 is not pure, the whole veil. A level's
 * fills and its outline are separate features (`lines`), see s2-grid cellLines.
 */
const pureStyle = (f: any) => (f?.properties?.pure === 2
  ? { color: '#ffffff', weight: 1.6, opacity: 0.95, fill: false, interactive: false }
  : f?.properties?.pure === 1
    ? (f.properties.lines
        ? { color: '#ffffff', weight: 1, opacity: 0.7, dashArray: '3 3', fill: false, interactive: false }
        : { stroke: false, fillColor: '#000000', fillOpacity: 0.3, interactive: false })
    : { stroke: false, fillColor: '#000000', fillOpacity: 0.6, interactive: false }) as L.PathOptions;
/**
 * The simulation overlay (use-simulation `simGeojson`): the pixels of one
 * colour filled together, and every pixel's outline as one more feature, stroked
 * once over them. A pixel used to be filled and stroked on its own, and its
 * neighbour then painted over half of that line before drawing its own: the
 * one stroke stands for the two.
 */
const SIM_LINES: L.PathOptions = { stroke: true, color: '#000', weight: 0.6, opacity: 0.7, fill: false, interactive: false };
const simSetStyle = (f: any) => (f?.properties?.lines
  ? SIM_LINES
  : { stroke: false, fillColor: f?.properties?.fill, fillOpacity: 0.8, interactive: false }) as L.PathOptions;
/**
 * "Real field" mode: transparent pixels (the true pattern shows through) with
 * just the grid outline, every square in one stroke. Each pixel used to stroke
 * its own, so a line between two pixels was drawn twice at 0.9: the opacity
 * here is what two such strokes come to.
 */
const fieldOutlineStyle = () =>
  ({ stroke: true, color: '#0b0e11', weight: 1.6, opacity: 0.99, fill: false, interactive: false }) as L.PathOptions;
/** The pixels picked in the PCA scatter: filled, and outlined in one stroke. */
const selectionStyle = (f: any) => (f?.properties?.lines
  ? { color: '#fde047', weight: 2, fill: false, interactive: false }
  : { stroke: false, fillColor: '#fde047', fillOpacity: 0.35, interactive: false }) as L.PathOptions;
/**
 * "In field only": the kept pixels as squares, in the colour the grid lines
 * have on this basemap, all in one stroke. Each pixel used to stroke its own
 * square at 0.6 px and 0.85, so every line between two pixels was drawn twice;
 * 0.8 px at 0.9 is what measured closest to that, drawn once.
 */
const inFieldStyle = {
  light: () => ({ color: '#0f172a', weight: 0.8, opacity: 0.9, fill: false, interactive: false }) as L.PathOptions,
  dark: () => ({ color: '#f1f5f9', weight: 0.8, opacity: 0.9, fill: false, interactive: false }) as L.PathOptions,
};

/**
 * The map half of the page: basemap, the drawn field, the pixel the
 * simulation overlay, the PSF footprint, and the two draw tools.
 *
 * It takes the hook objects whole rather than 30-odd scalars: the alternative
 * is a prop list nobody can read. `geoKey` is the exception and arrives as an
 * opaque string: it is assembled in the SHELL because that is the only scope
 * where all of its inputs are live, and it exists because react-leaflet
 * will not restyle a <GeoJSON> on a prop change. Remounting on a changed key is
 * the ONLY thing that repaints the overlay, so a dropped segment shows up as a
 * stale map with no type error and no test failure.
 *
 * Do not wrap this in React.memo, and do not memoize what it passes down:
 * GridLines reads the map's centre and zoom during render and has no event
 * subscription of its own, so it only refreshes because ViewTracker re-renders
 * this whole tree.
 */
function FieldMapBody({
  mapRef, initialCenter, initialZoom, onView, basemap, setBasemap, showField, setShowField, showSigmas, setShowSigmas,
  showSources, setShowSources,
  fieldOnly, setFieldOnly, showPure, setShowPure, geoKey, area, gridApi, exp, sim, pca,
}: {
  mapRef: React.MutableRefObject<L.Map | null>;
  initialCenter: [number, number];
  initialZoom: number;
  onView: (center: [number, number], zoom: number) => void;
  basemap: BasemapKey; setBasemap: (b: BasemapKey) => void;
  showField: boolean; setShowField: (v: boolean | ((p: boolean) => boolean)) => void;
  /** The three sigmas of the blur budget, drawn to scale as rings. */
  showSigmas: boolean; setShowSigmas: (v: boolean | ((p: boolean) => boolean)) => void;
  /** One pixel's signal as dots, each in the colour of what it lands on, with the share of each cover. */
  showSources: boolean; setShowSources: (v: boolean | ((p: boolean) => boolean)) => void;
  fieldOnly: boolean; setFieldOnly: (v: boolean | ((p: boolean) => boolean)) => void;
  /** Outline the simulation's pure pixels and dim the others. */
  showPure: boolean; setShowPure: (v: boolean | ((p: boolean) => boolean)) => void;
  geoKey: string;
  area: ReturnType<typeof useAoiField>;
  gridApi: ReturnType<typeof useFieldGrid>;
  exp: Experiment;
  sim: ReturnType<typeof useSimulation>;
  pca: ReturnType<typeof usePcaSim>;
}) {
  const { aoi, aoiPoly, fieldRing, drawKind, drawMode, onDrawDone, onPolyDone } = area;
  const { build, geojson, fieldGeojson, lineBox, psfCenter, pickPixel, psfSigmaM, psfSigmaXM, psfSigmaYM, setViewBounds, renderGrid, inField, geoErrM, geoSigmaM } = gridApi;
  /**
   * The three sigma rings sit on the pixel nearest the middle of the field
   * until a pixel is clicked, and then on that one. Switched off there is
   * nothing to move, and the next time they start from the middle again.
   * (They were two overlays: the PSF haze drew the same blur alone, and went.)
   */
  const blurOn = showSigmas && !!build && psfSigmaM > 0;
  const { layout, layoutSig, spacing, colors, names, sensor, sensorSig, threshold } = exp;
  const { patternOrigin, simGeojson, simCells, pureGeojson, pureHeld, heldBusy } = sim;
  /**
   * The signal of that same pixel, cover by cover: where its purity comes
   * from. It needs the simulation, whose pixels it explains, and a grid that
   * is every pixel of its extent, as the readout under the pointer does. No
   * blur is needed: a sharp sensor's signal is the pixel's own square.
   */
  const srcOn = showSources && !!renderGrid && !!patternOrigin && !(renderGrid.stride && renderGrid.stride > 1);
  // A click picks a pixel while anything that sits on one is shown.
  const pickOn = blurOn || srcOn;
  useEffect(() => { if (!pickOn) pickPixel(null); }, [pickOn, pickPixel]);
  const origin = patternOrigin?.origin;
  const signal = useMemo(() => {
    if (!srcOn || !psfCenter || !renderGrid || !origin) return null;
    const at = pixelIndexAt(renderGrid, psfCenter[0], psfCenter[1]);
    const sources = at && pixelSources(renderGrid, origin, layout, sensor, at.i, at.j, SOURCE_DOTS);
    if (!at || !sources) return null;
    const { rows, colorOf } = sourceRows(sources.covers, coverNamer(layout, names));
    const ring = renderGrid.cells[at.k]?.ring.map(([lng, lat]) => [lat, lng] as [number, number]) ?? null;
    return { sources, rows, colorOf, ring, epsg: renderGrid.epsg };
    // layoutSig and sensorSig stand for `layout` and `sensor`, fresh objects on every render.
  }, [srcOn, psfCenter?.[0], psfCenter?.[1], renderGrid, origin?.[0], origin?.[1], layoutSig, sensorSig, names.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  // Metres between the ruled lines when the grid is too fine to rule every pixel
  // edge (0 when every edge is drawn). Named on the map so a coarse mesh is never
  // read as the pixel grid itself.
  const [lineStepM, setLineStepM] = useState(0);
  const onGridStep = useCallback((m: number) => setLineStepM(m), []);
  /**
   * The map's own controls, folded. Six buttons stood in a column over the
   * map's corner and a legend over another, on a map that is 340 px wide in a
   * small window: the field was what they hid. The basemap and the five
   * switches now open from one button and close on a click anywhere else, and
   * the legend opens from its own, which a refresh remembers.
   */
  const [layersOpen, setLayersOpen] = useState(false);
  const layersBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!layersOpen) return;
    const away = (e: MouseEvent) => { if (!layersBox.current?.contains(e.target as Node)) setLayersOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setLayersOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [layersOpen]);
  const [showLegend, setShowLegend] = usePersistentState('showLegend', false, isBool);
  const { selectedPixels, selectionGeojson } = pca;
  /**
   * The simulation overlay is ALWAYS the field's pixels: useSimulation builds it
   * from the same membership rule the export and the pixel count use, so there is
   * nothing left for "In field only" to trim here. It used to be filtered a
   * second time against the in-field list, which could only ever remove nothing,
   * over every cell on every update. The toggle still rules the plain grid,
   * where out-of-field pixels really are drawn, and says so when it cannot act.
   */
  const shownSim = simGeojson;
  const simTrimmed = !!simGeojson;
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
          {/* Metres only. With the feet line under it the Legend button sat on
              the metres and the map's scale read "300 ft" alone. */}
          <ScaleControl position="bottomleft" imperial={false} />
          <ViewTracker onChange={setViewBounds} onView={onView} />
          <KeepSized />
          {pickOn && !drawMode && <PixelPicker onPick={pickPixel} />}
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
          {/* The PCA selection lives in its OWN pane above the overlay pane. On the
              shared canvas, layers paint in the order they were added, so anything
              that remounted the simulation layer (a basemap switch, the In field
              only toggle) repainted it over the yellow highlight and hid it. */}
          {/* The dots of one pixel's signal: over the overlay, the veil and the
              PSF haze, under the rings, which are lines and hide none of them. */}
          <Pane name="sources" style={{ zIndex: 465 }}>
            {signal && !drawMode && (
              <SignalDots sources={signal.sources} colorOf={signal.colorOf} epsg={signal.epsg} ring={signal.ring} pane="sources" />
            )}
          </Pane>
          {/* The three sigmas, above everything else that is drawn: the veil of
              the Pure pixels layer would otherwise dim them with the pixels. */}
          <Pane name="sigmas" style={{ zIndex: 470 }}>
            {showSigmas && psfCenter && psfSigmaM > 0 && (
              <SigmaRings center={psfCenter} psfXM={psfSigmaXM} psfYM={psfSigmaYM} geoM={geoSigmaM}
                light={BASEMAPS[basemap].light} />
            )}
          </Pane>
          {/* The pure pixels, in a pane of their own between the overlay and the
              selection: outlined, with every other pixel of the field under a
              dark veil. A veil rather than a colour, so that it reads over any
              crop colour and over the planting pattern in Real field mode.
              Three levels once the CE90 is worked out: a pixel that stays pure
              wherever the image lands is left bright under a solid outline, one
              that is pure only where the image is meant to be gets half the veil
              and a broken outline, the rest the whole veil.
              The key carries the CE90 because react-leaflet repaints a GeoJSON
              only when its key moves, and the CE90 is in none of geoKey's parts. */}
          <Pane name="pure" style={{ zIndex: 440 }}>
            {showPure && pureGeojson && (
              <GeoJSON key={`${geoKey}-pure-${pureHeld ? geoErrM : 'nominal'}`} data={pureGeojson as any} style={pureStyle} />
            )}
          </Pane>
          <Pane name="selection" style={{ zIndex: 450 }}>
            {selectionGeojson && (
              <GeoJSON key={`sel-${selectedPixels.length}-${selectedPixels[0] ?? ''}`} data={selectionGeojson} style={selectionStyle} />
            )}
            {/* The pixel under the pointer, read off the simulation that is on the
                map. Not while a field is being drawn: the pointer is the pen then. */}
            {sim.sim && renderGrid && !drawMode && (
              <PixelHover grid={renderGrid} sim={sim.sim} layout={layout} names={names}
                mask={inField && inField.grid === renderGrid ? inField.mask : null}
                held={showPure ? pureHeld : null} />
            )}
          </Pane>
          {(() => {
            const gridLines = lineBox && build
              ? <GridLines box={lineBox} res={build.res} epsg={build.epsg} color={BASEMAPS[basemap].light ? '#0f172a' : '#f1f5f9'} weight={0.6} onStep={onGridStep} />
              : null;
            if (showField) {
              // Per-cell outlines (with not-pure rings) when cells are available;
              // otherwise just the pixel-grid lines, so a thin grid never vanishes.
              const d = (shownSim ? simCells : null) ?? (fieldOnly ? fieldGeojson : null) ?? geojson;
              return d
                ? <GeoJSON key={geoKey + '-field' + fieldKey} data={d as any} style={fieldOutlineStyle} />
                : gridLines;
            }
            if (shownSim) return <GeoJSON key={geoKey + fieldKey} data={shownSim} style={simSetStyle} />;
            // "In field only": draw the kept cells as squares instead of ruling
            // lines across the whole bounding box. Same colour as the lines so it
            // reads as the same grid, just trimmed.
            if (fieldOnly && fieldGeojson) {
              return <GeoJSON key={geoKey + '-inField'} data={fieldGeojson as any}
                style={BASEMAPS[basemap].light ? inFieldStyle.light : inFieldStyle.dark} />;
            }
            return gridLines;
          })()}
        </MapContainer>

        {/* Layers: the basemap and the five switches, behind one button.
            Each switch keeps the rule it had as a button: what it needs before
            it can act, and the sentence that says so. */}
        <div ref={layersBox} className="absolute right-3 top-3 z-[1000]">
          <button type="button" onClick={() => setLayersOpen(v => !v)} aria-expanded={layersOpen}
            className={`ml-auto flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[14px] backdrop-blur transition-colors ${
              layersOpen ? 'border-sky-400/70 bg-[#11151acc] text-sky-300' : 'border-white/10 bg-[#11151acc] text-slate-200 hover:text-white'
            }`}>
            <Layers className="h-3.5 w-3.5" /> Layers
          </button>
          {layersOpen && (
            <div className="absolute right-0 mt-1.5 w-60 rounded-md border border-white/10 bg-[#11151a]/95 p-2 text-[14px] text-slate-200 shadow-xl backdrop-blur">
              <div className="mb-2 grid grid-cols-4 overflow-hidden rounded border border-white/10 text-[13px]">
                {(Object.keys(BASEMAPS) as BasemapKey[]).map(key => (
                  <button key={key} type="button" onClick={() => setBasemap(key)}
                    className={`px-1 py-1 transition-colors ${basemap === key ? 'bg-sky-500/20 text-sky-300' : 'text-slate-400 hover:text-slate-200'}`}>
                    {BASEMAPS[key].label}
                  </button>
                ))}
              </div>
              {([
                { label: 'Real field', on: showField, flip: () => setShowField(v => !v), off: !build,
                  title: 'Show the planting pattern under the grid' },
                { label: 'In field only', on: fieldOnly, flip: () => setFieldOnly(v => !v), off: !build || !fieldGeojson || simTrimmed,
                  title: !fieldGeojson
                    ? (aoi ? 'Zoom in until the pixels are drawn to use this' : 'Draw a field in step 1 to use this')
                    : simTrimmed
                      ? 'The simulation already draws only the pixels that overlap the field'
                      : 'Show only the exported pixels (the ones that overlap the field)' },
                { label: 'σ PSF, geo, eff', on: showSigmas, flip: () => setShowSigmas(v => !v), off: !build || psfSigmaM <= 0,
                  title: 'Draw the blur, the geolocation error and the two combined as rings of one σ; click a pixel to move them there' },
                { label: 'Signal of a pixel', on: showSources, flip: () => setShowSources(v => !v), off: !build,
                  title: "Draw a pixel's signal as 1000 dots, coloured by whose ground each lands on, and list the share of each plot: the first is the purity; click a pixel to move them there" },
                { label: 'Pure pixels', on: showPure, flip: () => setShowPure(v => !v), off: !build,
                  title: 'Outline the pure pixels and dim the others' },
              ]).map(sw => (
                <button key={sw.label} type="button" role="switch" aria-checked={sw.on} disabled={sw.off} title={sw.title} onClick={sw.flip}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent">
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[11px] leading-none ${sw.on ? 'border-sky-400 bg-sky-500/20 text-sky-300' : 'border-white/25'}`}>
                    {sw.on ? '✓' : ''}
                  </span>
                  {sw.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {signal && !drawMode && (() => {
          // In the corner by the zoom buttons, unless that is where the pixel
          // is: the card then goes to the opposite corner, off its own dots.
          // (This tree is rendered again after every pan and zoom.)
          const at = psfCenter && mapRef.current ? mapRef.current.latLngToContainerPoint(psfCenter) : null;
          return <SourcesCard rows={signal.rows} threshold={threshold} low={!!at && at.x < 330 && at.y < 250} />;
        })()}

        {drawMode && (
          <div className="pointer-events-none absolute left-1/2 top-4 z-[1000] -translate-x-1/2 rounded-full bg-sky-500/90 px-4 py-1.5 text-[15px] font-medium text-white shadow-lg">
            {drawKind === 'poly'
              ? 'Click to add corners · click the first point (or double-click) to close · Esc to cancel'
              : 'Click and drag to draw a box · press Esc to cancel'}
          </div>
        )}

        {/* Map legend (simulation overlay colours), folded until asked for */}
        {simGeojson && !showLegend && (
          <button type="button" onClick={() => setShowLegend(true)}
            className="absolute bottom-7 left-2 z-[1000] rounded-md border border-white/10 bg-[#11151acc] px-2.5 py-1 text-[13px] text-slate-300 backdrop-blur transition-colors hover:text-white">
            Legend
          </button>
        )}
        {simGeojson && showLegend && (
          <div className="absolute bottom-7 left-2 z-[1000] rounded-md border border-white/10 bg-[#11151a]/85 px-2.5 py-2 text-[14px] text-slate-200 backdrop-blur">
            <div className="mb-1 flex items-center justify-between gap-3 font-medium text-slate-300">
              Mixture
              <button type="button" onClick={() => setShowLegend(false)} title="Hide the legend" aria-label="Hide the legend"
                className="rounded text-slate-500 transition-colors hover:text-slate-200"><X className="h-3.5 w-3.5" /></button>
            </div>
            <div className="space-y-1">
              {/* Two species still read best as one gradient (a pixel is some
                  blend of exactly those two). Past two there is no single axis
                  to run along, so the legend becomes a swatch list. */}
              {colors.length === 2 ? (
                <>
                  <div className="h-2.5 w-44 rounded-sm" style={{ background: `linear-gradient(to right, ${colors[1]}, ${colors[0]})` }} />
                  <div className="flex w-44 items-baseline justify-between gap-1 text-[13px] text-slate-400">
                    <span className="truncate">all {names[1]}</span>
                    <span className="shrink-0 text-slate-500">50/50</span>
                    <span className="truncate text-right">all {names[0]}</span>
                  </div>
                </>
              ) : (
                <div className="grid w-44 grid-cols-2 gap-x-2 gap-y-0.5 text-[13px] text-slate-400">
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
                <div className="flex items-center gap-1 text-[13px] text-slate-400">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BARE.color }} /> bare-soil alley
                </div>
              )}
              {(layout.pattern === 'block' || layout.pattern === 'imported') && (
                <div className="flex items-center gap-1 text-[13px] text-slate-400">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: OFF_TRIAL.color }} /> outside the trial
                </div>
              )}
              {showPure && pureGeojson && (pureHeld ? (
                <>
                  <div className="flex items-center gap-1 text-[13px] text-slate-400">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-white" /> pure within CE90 ({geoErrM} m)
                  </div>
                  <div className="flex items-center gap-1 text-[13px] text-slate-400">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-dashed border-white/70 bg-black/30" /> pure, not within CE90
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-1 text-[13px] text-slate-400">
                  <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-white" /> pure pixel, the others dimmed
                  {heldBusy && <span className="text-slate-500">· CE90…</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {lineStepM > 0 && (
          <div className={`pointer-events-none absolute left-2 z-[1000] rounded-md border border-white/10 bg-[#11151a]/85 px-2 py-1 text-[13px] text-slate-300 backdrop-blur ${simGeojson ? (showLegend ? 'bottom-[7.5rem]' : 'bottom-16') : 'bottom-7'}`}>
            grid ruled every {lineStepM >= 1000 ? `${+(lineStepM / 1000).toFixed(1)} km` : lineStepM < 10 ? `${+lineStepM.toFixed(2)} m` : `${Math.round(lineStepM)} m`}, not every pixel
          </div>
        )}
      </div>
  );
}

/**
 * Where the picked pixel's signal lands, as one bar and a line per cover.
 *
 * The bar is the whole signal and the first segment is the purity, so the
 * mark at the threshold says at once whether the pixel is pure: the first
 * colour reaches it or it does not. The lines give the figures, the first by
 * the purity's own rule so that it reads as the figure under the pointer.
 *
 * Beside the zoom buttons, the one corner of the map nothing else uses, or
 * above the attribution when the pixel itself is in that corner (`low`). It
 * lets the pointer through: it sits over pixels that can be clicked.
 */
function SourcesCard({ rows, threshold, low }: { rows: SourceRow[]; threshold: number; low: boolean }) {
  return (
    <div className={`pointer-events-none absolute z-[1000] w-56 max-w-[calc(100%-4.5rem)] rounded-md border border-white/10 bg-[#11151a]/90 px-2.5 py-2 text-[13px] leading-snug text-slate-200 backdrop-blur ${low ? 'bottom-8 right-2' : 'left-14 top-3'}`}>
      <div className="mb-1.5 font-medium text-slate-300">Where this pixel's signal lands</div>
      <div className="relative mb-2 h-3">
        <div className="flex h-full overflow-hidden rounded-sm">
          {rows.map(r => <div key={r.key} style={{ width: `${100 * r.share}%`, background: r.color }} />)}
        </div>
        <div className="absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_#0b0e11]" style={{ left: `${threshold}%` }} />
      </div>
      {rows.map((r, q) => (
        <div key={r.key} className={`flex items-baseline gap-1.5 ${q === 0 ? 'font-semibold text-white' : 'text-slate-300'}`}>
          <span className="inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full" style={{ background: r.color }} />
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
          {/* Through 32 bits, as the simulation keeps the purity: the two figures are cut at the same place. */}
          <span className="shrink-0 font-mono">{q === 0 ? purityText(Math.fround(r.share)) : shareText(r.share)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The map, inside its own failure boundary. A bad ring, a Leaflet error or a
 * projection that throws must not take the sidebar with it: the sidebar is
 * where every control and Reset live.
 */
export function FieldMap(p: Parameters<typeof FieldMapBody>[0]) {
  return <Boundary name="The map"><FieldMapBody {...p} /></Boundary>;
}
