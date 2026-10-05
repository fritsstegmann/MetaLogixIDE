import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FontSettingsProvider } from './fonts/font-settings-context';
import './styles.css';
import 'katex/dist/katex.min.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('renderer root element is missing');

createRoot(rootElement).render(
  <StrictMode>
    <FontSettingsProvider>
      <App />
    </FontSettingsProvider>
  </StrictMode>,
);
