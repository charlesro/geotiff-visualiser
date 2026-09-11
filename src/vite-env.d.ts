/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * '1' when the Pixel Grid Designer is built on its own — the public GitHub Pages
   * site, which does not carry the PCA app. The page then leaves out its links
   * back to the PCA app, since there is nothing there to link to. Unset locally.
   */
  readonly VITE_STANDALONE?: string;
}
