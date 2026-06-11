import React from 'react';
import { X, BookOpen, Layers, MousePointer2, Map as MapIcon, Image as ImageIcon, LineChart, Download } from 'lucide-react';

export function DocumentationModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6 overflow-y-auto">
      <div className="relative w-full max-w-4xl bg-[#0a0a0a] border border-orange-500/30 rounded-2xl shadow-[0_0_50px_rgba(249,115,22,0.1)] flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/5 bg-white/5 rounded-t-2xl shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-orange-500/20 rounded-xl flex items-center justify-center border border-orange-500/30">
              <BookOpen className="text-orange-500" size={20} />
            </div>
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-white">Application Documentation</h2>
              <p className="text-sm text-white/50">Comprehensive guide to GeoTIFF Visualizer features</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/5 hover:bg-white/10 text-white/50 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-8 space-y-12">
          
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-orange-500">
              <ImageIcon size={20} />
              <h3 className="text-lg font-medium">1. Data Ingestion & Timelines</h3>
            </div>
            <div className="pl-7 space-y-4 text-white/70 text-sm leading-relaxed">
              <p>The application supports importing high-resolution geospatial imagery and vector shapes through two primary workflows:</p>
              <ul className="list-disc pl-5 space-y-2">
                <li><strong>Local File Upload:</strong> You can upload individual <code>.tif</code> / <code>.tiff</code> files or complete folders. When multiple files are uploaded simultaneously (or via a folder upload), the application automatically groups them into a logical dataset, mapping out an independent timeline.</li>
                <li><strong>Sentinel-2 STAC Retrieval:</strong> Utilize the integrated SpatioTemporal Asset Catalog (STAC) client to query and fetch imagery dynamically. Use the bounding box tool to define a region of interest, set a timeframe, specify a cloud cover threshold, and click "Fetch Images".</li>
                <li><strong>Timeline Separation:</strong> Datasets retrieved via STAC and files provided via local upload remain strictly isolated. The system orchestrates multiple independent timelines, shifting rendering context and data representations seamlessly as you select layers from different series in the sidebar.</li>
              </ul>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 text-orange-500">
              <Layers size={20} />
              <h3 className="text-lg font-medium">2. Layer Management & Rendering Configuration</h3>
            </div>
            <div className="pl-7 space-y-4 text-white/70 text-sm leading-relaxed">
              <p>Each raster or vector layer contains granular rendering controls via the left-hand sidebar:</p>
              <ul className="list-disc pl-5 space-y-2">
                <li><strong>Rendering Modes:</strong> 
                  <ul className="list-[circle] pl-5 mt-1 space-y-1 text-white/60">
                    <li><em>RGB Composite:</em> Select 3 specific bands to compose natural or false-color imagery.</li>
                    <li><em>Single Band:</em> Render a single channel mapping scalar values through a selected colormap (e.g., magma, viridis, turbo).</li>
                    <li><em>Spectral Indices:</em> Compute on-the-fly indices such as <strong>NDVI</strong>, <strong>EVI</strong>, <strong>GNDVI</strong>, and <strong>SAVI</strong> by mapping the correct multispectral bands (Red, Green, Blue, NIR) according to the sensor geometry.</li>
                  </ul>
                </li>
                <li><strong>Dynamic Value Stretching:</strong> Adjust contrast stretches. Utilizing <em>Min/Max</em> enforces strict linear bounding, while <em>Percentile</em> applies statistical trimming (typically 2% - 98%) to discard extreme outliers, drastically improving image legibility.</li>
                <li><strong>Grid Overlay:</strong> Superimpose a pixel grid directly onto the raster to isolate and emphasize exact pixel boundaries relative to ground distance.</li>
              </ul>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 text-orange-500">
              <LineChart size={20} />
              <h3 className="text-lg font-medium">3. Deep Pixel Analysis & Temporal Context</h3>
            </div>
            <div className="pl-7 space-y-4 text-white/70 text-sm leading-relaxed">
              <p>Harness the "Pixel Analysis" toolset to extrapolate analytical values across the Z-axis of a timeline:</p>
              <ul className="list-disc pl-5 space-y-2">
                <li><strong>Spatial Interrogation:</strong> Toggle the crosshair mode (Pixel Analysis constraint) in the sidebar. Clicking on any geography will sample the intersection coordinate through all layers associated with the active timeline.</li>
                <li><strong>Dynamic Temporal Chart:</strong> A scalable graph overlays on the viewport detailing the value permutations across time. This operates synchronously with your currently configured Rendering Mode. If you are calculating NDVI, the chart computes NDVI for the pixel constraint through time. For RGB, it charts the individual intensities of the unmixed color channels.</li>
                <li><strong>Linked Navigational Scrubbing:</strong> The timeline graph is deeply linked with the underlying Leaflet instance. Clicking a singular node on the graph instantaneously hot-swaps the underlying active Raster to precisely match that epoch, accelerating comparative analysis.</li>
              </ul>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 text-orange-500">
              <MapIcon size={20} />
              <h3 className="text-lg font-medium">4. Drawing, Geometry, & Spatial Constraints</h3>
            </div>
            <div className="pl-7 space-y-4 text-white/70 text-sm leading-relaxed">
              <p>Vector capabilities rely heavily on geometrical constraints and clipping algorithms:</p>
              <ul className="list-disc pl-5 space-y-2">
                <li><strong>Bounding Box Designation:</strong> Utilize the rectangle tool native to the viewport to establish a spatial bounding constraint (BBox). This is predominantly leveraged for localized STAC querying.</li>
                <li><strong>Shapefile Intake:</strong> Upload zipped ESRI Shapefiles (<code>.zip</code> containing <code>.shp</code>, <code>.shx</code>, <code>.dbf</code>) which deserialize to standard spatial geometry elements rendering alongside your raster datasets without collision, allowing you to define rigid regional bounds.</li>
              </ul>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 text-orange-500">
              <Download size={20} />
              <h3 className="text-lg font-medium">5. Bulk Data Extraction & Cropping</h3>
            </div>
            <div className="pl-7 space-y-4 text-white/70 text-sm leading-relaxed">
              <p>Export modified layers without dependency lock-in:</p>
              <ul className="list-disc pl-5 space-y-2">
                <li><strong>BBox Cropping:</strong> Activate the bounding box tool, specify a localized area containing high variability, and click "Crop Layer to Selection" in the sidebar. This triggers a localized canvas constraint bounding visual elements to the spatial extent.</li>
                <li><strong>Series Downloading:</strong> Extract contiguous components utilizing the Download icon located directly within the bottom Timeline controller. If the rendering context is constrained through BBox Cropping, subsequent downloads dynamically truncate to the crop shape bounds recursively. They are ultimately synthesized into a <code>.zip</code> payload directly executable on the local system.</li>
              </ul>
            </div>
          </section>

        </div>

      </div>
    </div>
  );
}
