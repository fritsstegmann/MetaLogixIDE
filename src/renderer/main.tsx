import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootstrapFromQuery, installWindowMaterialSync } from './window-material-sync';
import './styles.css';
import 'katex/dist/katex.min.css';

bootstrapFromQuery(document.documentElement, location.search);
installWindowMaterialSync(window.api, document.documentElement, (cb) => requestAnimationFrame(cb));

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
);
