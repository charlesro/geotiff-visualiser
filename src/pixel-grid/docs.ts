/**
 * The documentation page (pixel-grid-docs.html, at the site's root) and the
 * sections of it the panel points at.
 *
 * The panel says a thing in a few words and links here for the rest ("remove
 * all long text like this and create a documentation page", 2026-11-22). Each
 * id is an `id="..."` of that page: the UI suite checks every one is there.
 *
 * Document-relative, like every other path of the page: the site lives under
 * a sub-path.
 */
export const DOC_IDS = [
  'overview', 'map', 'pixel-model', 'purity', 'geolocation', 'hold', 'satellites', 'pansharpened',
  'grid-position', 'place-for', 'designs', 'imported', 'suggest', 'plot-size', 'curves-noise',
  'budget', 'note-figures', 'not-simulated', 'pca', 'satellites-table', 'storage', 'sources',
] as const;
export type DocId = (typeof DOC_IDS)[number];

export const DOCS_PAGE = './pixel-grid-docs.html';
export const docHref = (id?: DocId): string => (id ? `${DOCS_PAGE}#${id}` : DOCS_PAGE);
