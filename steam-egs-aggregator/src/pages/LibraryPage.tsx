import React, { useCallback, useEffect, useState } from 'react';
import { api, Game, Me, steamLoginUrl, useI18n, Header, GameList } from '@app/shared';
import { bridgeAvailable, bridgeLibrary, bridgePair, bridgeToken } from '../bridge';

// The web library. Two data sources, best one wins:
//   - the desktop launcher's local bridge (full merged Steam+EGS library) when
//     the launcher runs on this machine and the site is paired;
//   - otherwise the web backend (Steam-only, via "Sign in through Steam").
// With neither, a landing with the sign-in button is shown.

const btn: React.CSSProperties = {
  padding: '10px 18px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  cursor: 'pointer',
  background: 'var(--accent)',
  color: 'var(--on-accent)',
  fontWeight: 700,
  fontSize: 15,
};

type BridgeState = 'checking' | 'absent' | 'available' | 'connected';

const LibraryPage: React.FC = () => {
  const { t } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [games, setGames] = useState<Game[] | null>(null);
  const [bridge, setBridge] = useState<BridgeState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);

  const load = useCallback(async () => {
    // The backend redirects here with ?login=failed when Steam's assertion
    // didn't verify — otherwise the user would land back on the landing page
    // with no idea the sign-in failed.
    if (new URLSearchParams(window.location.search).get('login') === 'failed') {
      setError(t('web.loginFailed'));
      window.history.replaceState({}, '', window.location.pathname);
    } else {
      setError(null);
    }

    const [meRes, available] = await Promise.all([
      api.getMe().catch((): Me => ({ authenticated: false })),
      bridgeAvailable(),
    ]);
    setMe(meRes);

    // Launcher first — its library is the full picture (both stores).
    if (available && bridgeToken()) {
      try {
        setGames(await bridgeLibrary());
        setBridge('connected');
        return;
      } catch {
        /* stale pairing — fall through to the web source */
      }
    }
    setBridge(available ? 'available' : 'absent');

    if (meRes.authenticated) {
      try {
        setGames(await api.getCombinedLibrary());
      } catch (e) {
        setGames([]);
        setError(`${t('lib.error')}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      setGames([]);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const connectBridge = async () => {
    setPairing(true);
    try {
      if (await bridgePair()) await load();
      else setError(t('web.bridge.denied'));
    } finally {
      setPairing(false);
    }
  };

  const loading = me === null || games === null;
  const signedIn = me?.authenticated ?? false;
  const showLanding = !loading && !signedIn && bridge !== 'connected';

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
      <Header action="settings" />

      {error && (
        <p style={{ color: '#ff6b6b', background: 'var(--panel-2)', padding: '8px 10px', borderRadius: 6 }}>
          {error}
        </p>
      )}

      {loading && <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>}

      {showLanding && (
        <div style={{ textAlign: 'center', padding: '64px 16px' }}>
          <h2 style={{ marginTop: 0 }}>{t('web.landing.title')}</h2>
          <p style={{ color: 'var(--muted)', maxWidth: 520, margin: '0 auto 24px' }}>
            {t('web.landing.desc')}
          </p>
          <button style={btn} onClick={() => (window.location.href = steamLoginUrl())}>
            {t('web.signIn')}
          </button>
          {bridge === 'available' && (
            <p style={{ marginTop: 24 }}>
              <span style={{ color: 'var(--muted)' }}>{t('web.bridge.available')} </span>
              <button
                style={{ ...btn, padding: '6px 12px', fontSize: 13 }}
                disabled={pairing}
                onClick={connectBridge}
              >
                {pairing ? '…' : t('web.bridge.connect')}
              </button>
            </p>
          )}
        </div>
      )}

      {!loading && !showLanding && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              margin: '0 0 14px',
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
            <span>
              {bridge === 'connected' ? `🖥️ ${t('web.bridge.connected')}` : `☁️ ${t('web.source.steamOnly')}`}
            </span>
            {bridge === 'available' && (
              <button
                style={{ ...btn, padding: '4px 10px', fontSize: 12 }}
                disabled={pairing}
                onClick={connectBridge}
              >
                {pairing ? '…' : t('web.bridge.connect')}
              </button>
            )}
          </div>
          <GameList games={games ?? []} stateKey="web-library" />
        </>
      )}
    </div>
  );
};

export default LibraryPage;
