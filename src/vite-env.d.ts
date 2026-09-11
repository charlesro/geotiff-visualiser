/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the pixel-grid page's "back to the PCA app" links point. Unset locally,
   * where index.html IS the PCA app, so they fall back to './'. The GitHub Pages
   * workflow sets it to './pca.html', because there the pixel grid designer is
   * the landing page and the PCA app is moved aside to pca.html.
   */
  readonly VITE_PCA_HREF?: string;
}
