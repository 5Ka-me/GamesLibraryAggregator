import React, { useCallback, useEffect, useState } from 'react';
import {
  api,
  EpicAccount,
  SteamAccount,
  useI18n,
  useTheme,
  SteamPanel,
  EpicPanel,
  type Lang,
} from '@app/shared';
import { useLegendary } from '../legendary/LegendaryProvider';

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

const syncBtn: React.CSSProperties = {
  ...btn,
  background: 'var(--accent)',
  color: 'var(--on-accent)',
  borderColor: 'transparent',
};

// ---- Backend URL (launcher-specific: persisted in the main process) ----
const ApiBasePanel: React.FC = () => {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.launcher.getApiBase().then(setValue);
  }, []);

  const save = async () => {
    await window.launcher.setApiBase(value.trim());
    setSaved(true);
    setTimeout(() => window.location.reload(), 600); // reload to talk to the new backend
  };

  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>Backend URL</h3>
      <p style={{ margin: '4px 0 10px', color: 'var(--muted)' }}>
        Address of the aggregator API this launcher talks to.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="http://localhost:5080"
          style={{ flex: 1, minWidth: 260 }}
        />
        <button style={btn} onClick={save} disabled={!value.trim()}>
          {saved ? '✅' : 'Save'}
        </button>
      </div>
    </div>
  );
};

// ---- Appearance: theme + language (moved off the old header) ----
const AppearancePanel: React.FC = () => {
  const { t, lang, setLang } = useI18n();
  const { theme, toggle } = useTheme();
  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>{t('settings.appearance')}</h3>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={btn} onClick={toggle}>
          {theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
        </button>
        <select
          aria-label={t('lang.label')}
          value={lang}
          onChange={(e) => setLang(e.target.value as Lang)}
          style={{ ...btn, paddingRight: 8 }}
        >
          <option value="en">EN</option>
          <option value="ru">RU</option>
        </select>
      </div>
    </div>
  );
};

// ---- Store regions (currency of prices; auto-detected, user-overridable) ----
const RegionsPanel: React.FC<{
  steam: SteamAccount | null;
  epic: EpicAccount | null;
  onChanged: () => void;
}> = ({ steam, epic, onChanged }) => {
  const { t } = useI18n();
  const [steamCc, setSteamCc] = useState('');
  const [epicCc, setEpicCc] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => setSteamCc(steam?.country ?? ''), [steam?.country]);
  useEffect(() => setEpicCc(epic?.country ?? ''), [epic?.country]);

  const save = async (fn: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await fn();
      setMsg('✅');
      onChanged();
    } catch (e) {
      setMsg(`${t('common.error')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const row = (
    label: string,
    value: string,
    setValue: (v: string) => void,
    onSave: () => void,
    disabled: boolean
  ) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
      <span style={{ minWidth: 60, fontSize: 13 }}>{label}</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase().slice(0, 2))}
        placeholder="US"
        maxLength={2}
        style={{ width: 64, textTransform: 'uppercase' }}
        disabled={disabled}
      />
      <button style={btn} onClick={onSave} disabled={disabled || value.trim().length !== 2}>
        Save
      </button>
    </div>
  );

  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>{t('settings.regions')}</h3>
      <p style={{ margin: '4px 0 10px', color: 'var(--muted)', fontSize: 13 }}>{t('settings.regions.desc')}</p>
      {row('Steam', steamCc, setSteamCc, () => save(() => api.setSteamRegion(steamCc)), !steam?.configured)}
      {row('Epic', epicCc, setEpicCc, () => save(() => api.setEpicRegion(epicCc)), !epic?.connected)}
      {msg && <p style={{ padding: '6px 8px', background: 'var(--panel-2)', borderRadius: 6 }}>{msg}</p>}
    </div>
  );
};

// ---- EGS install folder (passed to legendary as --base-path) ----
const InstallPathPanel: React.FC = () => {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.launcher.getInstallPath().then(setValue);
  }, []);

  const save = async () => {
    await window.launcher.setInstallPath(value.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>EGS install folder</h3>
      <p style={{ margin: '4px 0 10px', color: 'var(--muted)' }}>
        Where legendary installs Epic games. Leave empty for legendary's default.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. D:\\Games\\Epic"
          style={{ flex: 1, minWidth: 260 }}
        />
        <button style={btn} onClick={save}>
          {saved ? '✅' : 'Save'}
        </button>
      </div>
    </div>
  );
};

// ---- Workspace token (launcher-specific: stored in the OS keystore) ----
const WorkspaceTokenPanel: React.FC = () => {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [incoming, setIncoming] = useState('');

  useEffect(() => {
    window.launcher.getToken().then((tk) => setToken(tk ?? ''));
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const apply = async () => {
    const value = incoming.trim();
    if (!value) return;
    await window.launcher.setToken(value);
    window.location.reload(); // reload to load the new workspace's data
  };

  const masked = token ? `${token.slice(0, 6)}${'•'.repeat(Math.max(0, token.length - 6))}` : '—';

  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>{t('ws.title')}</h3>
      <p style={{ margin: '4px 0 10px', color: 'var(--muted)' }}>{t('ws.desc')}</p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <code
          style={{
            flex: 1,
            minWidth: 240,
            wordBreak: 'break-all',
            background: 'var(--panel-2)',
            padding: '8px 10px',
            borderRadius: 6,
          }}
        >
          {shown ? token || '—' : masked}
        </code>
        <button style={btn} onClick={() => setShown((s) => !s)}>
          {shown ? t('ws.hide') : t('ws.show')}
        </button>
        <button style={btn} onClick={copy} disabled={!token}>
          {copied ? t('ws.copied') : t('ws.copy')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <input
          placeholder={t('ws.useExisting')}
          value={incoming}
          onChange={(e) => setIncoming(e.target.value)}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button style={btn} onClick={apply} disabled={!incoming.trim()}>
          {t('ws.apply')}
        </button>
      </div>
    </div>
  );
};

const SettingsPage: React.FC = () => {
  const { t } = useI18n();
  const { available } = useLegendary();
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

  const embeddedEpicLogin = async () => {
    setBusy('epicLogin');
    setMsg(null);
    try {
      const r = await window.launcher.epicLogin();
      setMsg(
        r.success
          ? `✅ ${t('epic.connectedAs', { name: r.displayName ? ` (${r.displayName})` : '', count: r.gameCount })}`
          : `⚠️ ${r.message ?? t('epic.requiresLogin')}`
      );
      await loadAccounts();
    } catch (e) {
      setMsg(`${t('common.error')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>
      <h2 style={{ marginTop: 0 }}>{t('sidebar.settings')}</h2>

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

      <AppearancePanel />
      <RegionsPanel steam={steam} epic={epic} onChanged={loadAccounts} />
      <ApiBasePanel />
      <InstallPathPanel />
      <WorkspaceTokenPanel />

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

        {!available && (
          <p style={{ margin: '4px 0 12px', color: '#e0a458' }}>⚠️ {t('epic.legendaryMissing')}</p>
        )}

        {/* Preferred: embedded OAuth (authorizes legendary + syncs the library). */}
        <button style={syncBtn} disabled={busy !== null} onClick={embeddedEpicLogin}>
          {busy === 'epicLogin' ? t('settings.syncing') : t('epic.embeddedLogin')}
        </button>
        <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 13 }}>{t('epic.embeddedDesc')}</p>

        {/* Fallback: manual code paste (routed to the cloud API). */}
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>{t('epic.variantManual')}</summary>
          <div style={{ marginTop: 10 }}>
            <EpicPanel onChanged={loadAccounts} />
          </div>
        </details>

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
