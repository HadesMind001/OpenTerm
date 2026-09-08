import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

// main.tsx is just the mount point. No startup ordering lives here — the
// real sequence is App.tsx's bootstrapStore() (state/store.ts): it wires the
// onFrame listener BEFORE connectWS opens, and fires the watchlist/settings
// REST calls without awaiting them. Order matters in exactly one direction
// (subscribe, then connect, or hello-snapshot frames hit zero listeners);
// REST-vs-WS ordering does not, because hello carries a full snapshot and
// the store merges — whichever bootstrap finishes first wins honestly.
// StrictMode's dev double-mount is the reason bootstrapStore guards its
// module-global unsubFrame instead of assuming a clean first run.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
