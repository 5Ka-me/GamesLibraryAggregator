import React, { useCallback, useEffect, useState } from 'react';
import { api, EpicAccount, SteamAccount } from '../api/client';
import { useI18n } from '../i18n/I18nContext';
import Header from '../components/Header';
import SteamPanel from '../components/SteamPanel';
import EpicPanel from '../components/EpicPanel';
import WorkspacePanel from '../components/WorkspacePanel';

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 18,
  background: 'var(--panel)',
  marginBottom: 20,
};

const syncBtn: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  cursor: 'pointer',
  background: 'var(--accent)',
  color: 'var(--on-accent)',
  fontWeight: 600,
};

const SettingsPage: React.FC = () => {
  const { t } = useI18n();
  const [steam, setSteam] = useState<SteamAccount | null>(null);
  const [epic, setEpic] = useState<EpicAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    const [s, e] = await Promise.all([
      api.getSteamAccount().catch(() => null),
      api.getEpicAccount().catch(() => null),
    ]);
    setSteam(s);
    setEpic(e);
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const doSync = async (what: 'steam' | 'epic', fn: () => Promise<unknown>) => {
    setBusy(what);
    setMsg(null);
    try {
      await fn();
      setMsg(`✅ ${t('settings.syncDone', { what })}`);
      await loadAccounts();
    } catch (e) {
      setMsg(`${t('common.error')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
      <Header action="back" />

      {/* Accounts */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>{t('settings.account.steam')}</div>
          <div style={{ fontWeight: 600 }}>
            {steam?.personaName ?? (steam?.configured ? steam.steamId : t('settings.notConfigured'))}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>{t('settings.account.epic')}</div>
          <div style={{ fontWeight: 600 }}>
            {epic?.connected ? epic.displayName ?? t('settings.connected') : t('settings.notConnected')}
          </div>
        </div>
      </div>

      {msg && <p style={{ padding: '8px 10px', background: 'var(--panel-2)', borderRadius: 6 }}>{msg}</p>}

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{t('ws.title')}</h3>
        <WorkspacePanel />
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{t('settings.steam')}</h3>
        <SteamPanel initialSteamId={steam?.steamId} onChanged={loadAccounts} />
        <div style={{ marginTop: 14 }}>
          <button style={syncBtn} disabled={busy !== null} onClick={() => doSync('steam', api.syncSteam)}>
            {busy === 'steam' ? t('settings.syncing') : t('settings.syncSteam')}
          </button>
        </div>
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{t('settings.epic')}</h3>
        <EpicPanel onChanged={loadAccounts} />
        <div style={{ marginTop: 14 }}>
          <button style={syncBtn} disabled={busy !== null} onClick={() => doSync('epic', api.syncEpic)}>
            {busy === 'epic' ? t('settings.syncing') : t('settings.syncEpic')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
