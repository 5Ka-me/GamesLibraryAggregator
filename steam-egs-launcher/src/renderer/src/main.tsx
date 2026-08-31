import React from 'react';
import ReactDOM from 'react-dom/client';
import { configurePlatform, configureTransport, type ApiRequestInit } from '@app/shared';
import App from './App';
import './index.css';

// Route API calls through the main process: it implements the whole `/api/*`
// contract locally (library, accounts, syncs) and owns every secret.
configureTransport(<T,>(path: string, init?: ApiRequestInit) =>
  window.launcher.apiFetch<T>(path, init)
);

// Store pages open in the real browser; steam:// / com.epicgames.launcher://
// deep links are handed to the OS via the main process.
configurePlatform({
  openExternal: (url) => {
    void window.launcher.openExternal(url);
  },
  openDeepLink: (url) => {
    void window.launcher.openDeepLink(url);
  },
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
