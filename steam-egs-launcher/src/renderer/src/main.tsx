import React from 'react';
import ReactDOM from 'react-dom/client';
import { configurePlatform, configureTransport, type ApiRequestInit } from '@app/shared';
import App from './App';
import './index.css';

// Route all backend calls through the main process: it owns the workspace token
// (in the OS keystore) and talks to the .NET API without CORS restrictions.
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
