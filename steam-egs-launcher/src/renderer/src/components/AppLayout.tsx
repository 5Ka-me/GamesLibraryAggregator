import React from 'react';
import { Outlet } from 'react-router-dom';
import { useI18n } from '@app/shared';
import TopBar from './TopBar';
import { useLegendary } from '../legendary/LegendaryProvider';

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

// Steam-style shell: the title bar (nav + profile, doubles as the window
// frame) on top, the page below. The library's split view manages its own
// scrolling; every other page scrolls inside #app-scroll.
const AppLayout: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
    <TopBar />
    <DownloadErrorBanner />
    {/* id is used by pages to save/restore their scroll position */}
    <main id="app-scroll" style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Outlet />
      </div>
    </main>
  </div>
);

export default AppLayout;
