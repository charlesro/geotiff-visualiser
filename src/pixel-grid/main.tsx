import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PixelGridApp from './PixelGridApp.tsx';
// Leaflet's own stylesheet, bundled BEFORE the page's so that the page's rules
// still come after it, as they did when it was a <link> above them. It used to
// be fetched from unpkg, a third party the first paint had to wait for.
import 'leaflet/dist/leaflet.css';
import '../index.css';
import { prefetchLadderWorker } from './ladder-pool';
import { exampleFromSearch } from './examples';
import { openExampleStore } from './persist';

// A worked example of the documentation, opened by one of its "Open this
// example" links (?example=ID): the page starts from that example's settings,
// in a store of its own. It must happen before the page is drawn, since every
// setting is read from the store as its part of the page is first drawn.
const example = exampleFromSearch(window.location.search);
if (example) openExampleStore(example.id, example.seed);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PixelGridApp />
  </StrictMode>,
);

/**
 * Step 4's own files, fetched once the page has been up for a while: its chart,
 * the charting library and the script of the workers that build the satellites
 * table. They are not in the first download, which nothing should hold up; but
 * fetched only on the click, step 4 opened on a "Loading" for two seconds on a
 * 1.6 Mbit/s line and six on slow 3G. Fetched here, it opens at once for anyone
 * who has looked at the first three steps first. Not for a reader who asked
 * their browser to save data.
 */
const later = () => {
  const saving = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  if (saving) return;
  void import('./PcaSimVisual').catch(() => {});
  void import('./steps/SeasonChart').catch(() => {});
  prefetchLadderWorker();
};
window.setTimeout(later, 6000);
