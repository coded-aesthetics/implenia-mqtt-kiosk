import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import { App } from './App';
import { reloadWhenWorkerTakesOver } from './sw-update';

// Before the render: a stale page should not finish painting only to reload.
reloadWhenWorkerTakesOver();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
