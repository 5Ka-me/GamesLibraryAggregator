import React, { useCallback, useEffect, useState } from 'react';
import { api, Me, steamLoginUrl, useI18n, Header } from '@app/shared';
import { bridgeAvailable, bridgeDisconnect, bridgePair, bridgeToken } from '../bridge';

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 18,
  background: 'var(--panel)',
  marginBottom: 20,
};

const btn: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  cursor: 'pointer',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  fontWeight: 600,
};

const accentBtn: React.CSSProperties = {
  ...btn,
  background: 'var(--accent)',
  color: 'var(--on-accent)',
  borderColor: 'transparent',
};

const SettingsPage: React.FC = () => {
  const { t } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [bridgeUp, setBridgeUp] = useState(false);
  const [paired, setPaired] = useState(!!bridgeToken());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [meRes, up] = await Promise.all([
      api.getMe().catch((): Me => ({ authenticated: false })),
      bridgeAvailable(),
    ]);
    setMe(meRes);
    setBridgeUp(up);
    setPaired(!!bridgeToken());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = async () => {
    setBusy(true);
    try {
      await api.logout();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // A denial (or a dismissed dialog) must say so — it used to look
      // identical to "nothing happened".
      if (!(await bridgePair())) setMsg(t('web.bridge.denied'));
      setPaired(!!bridgeToken());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
      <Header action="back" />

      {msg && <p style={{ padding: '8px 10px', background: 'var(--panel-2)', borderRadius: 6 }}>{msg}</p>}

      {/* Steam account (web session) */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{t('settings.account.steam')}</h3>
        {me === null ? (
          <p style={{ margin: 0, color: 'var(--muted)' }}>{t('lib.loading')}</p>
        ) : me.authenticated ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>{me.personaName || me.steamId}</span>
            <button style={btn} disabled={busy} onClick={logout}>
              {t('web.logout')}
            </button>
          </div>
        ) : (
          <button
            style={accentBtn}
            onClick={() => (window.location.href = steamLoginUrl())}
          >
            {t('web.signIn')}
          </button>
        )}
        <p style={{ margin: '10px 0 0', color: 'var(--muted)', fontSize: 13 }}>{t('web.account.desc')}</p>
      </div>

      {/* Desktop launcher bridge */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{t('bridge.title')}</h3>
        <p style={{ margin: '4px 0 10px', color: 'var(--muted)', fontSize: 13 }}>{t('web.bridge.desc')}</p>
        {!bridgeUp && <p style={{ margin: 0, color: 'var(--muted)' }}>{t('web.bridge.notFound')}</p>}
        {bridgeUp && !paired && (
          <button style={accentBtn} disabled={busy} onClick={connect}>
            {t('web.bridge.connect')}
          </button>
        )}
        {bridgeUp && paired && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--ok, #2e7d32)', fontWeight: 600 }}>✓ {t('web.bridge.connected')}</span>
            <button
              style={btn}
              onClick={() => {
                bridgeDisconnect();
                setPaired(false);
              }}
            >
              {t('web.bridge.disconnect')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsPage;
