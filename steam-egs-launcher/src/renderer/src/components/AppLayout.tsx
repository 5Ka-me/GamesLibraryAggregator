import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useI18n } from '@app/shared';
import Sidebar from './Sidebar';
import { useLegendary } from '../legendary/LegendaryProvider';
import type { UpdateState } from '../../../preload';

/**
 * Quiet auto-update banner: appears only when a new version has finished
 * downloading, and never restarts the app on its own.
 */
const UpdateBanner: React.FC = () => {
  const { t } = useI18n();
  const [state, setState] = useState<UpdateState>({ status: 'idle' });

  useEffect(() => {
    window.launcher.updateStatus().then(setState).catch(() => undefined);
    return window.launcher.onUpdateState(setState);
  }, []);

  if (state.status !== 'ready') return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        background: 'var(--accent)',
        color: 'var(--on-accent)',
        fontSize: 13,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        {t('update.ready', { version: state.version })}
      </span>
      <button
        onClick={() => void window.launcher.updateInstall()}
        style={{
          background: 'rgba(0,0,0,.25)',
          border: 'none',
          color: 'inherit',
          borderRadius: 6,
          padding: '4px 12px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {t('update.restart')}
      </button>
    </div>
  );
};

/**
 * App-wide banner for a failed EGS download. Downloads run in the background,
 * so a failure has no page of its own to report on — without this the card
 * would just quietly revert to "Install".
 */
const DownloadErrorBanner: React.FC = () => {
  const { t } = useI18n();
  const { lastError, dismissError } = useLegendary();
  if (!lastError) return null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        background: '#5b2222',
        color: '#fff',
        fontSize: 13,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        ⚠️ {lastError.title}: {lastError.error}
      </span>
      <button
        onClick={dismissError}
        style={{
          background: 'transparent',
          border: '1px solid rgba(255,255,255,.5)',
          color: '#fff',
          borderRadius: 6,
          padding: '2px 10px',
          cursor: 'pointer',
        }}
      >
        {t('viewer.close')}
      </button>
    </div>
  );
};

// Fixed, non-collapsible left sidebar + scrollable content area.
const AppLayout: React.FC = () => (
  <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
    <Sidebar />
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <UpdateBanner />
      <DownloadErrorBanner />
      {/* id is used by pages to save/restore their scroll position */}
      <main id="app-scroll" style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        <Outlet />
      </main>
    </div>
  </div>
);

export default AppLayout;
