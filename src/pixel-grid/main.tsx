import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PixelGridApp from './PixelGridApp.tsx';
import '../index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PixelGridApp />
  </StrictMode>,
);
