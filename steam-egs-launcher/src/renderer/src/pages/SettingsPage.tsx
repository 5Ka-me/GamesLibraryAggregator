import React, { useCallback, useEffect, useState } from 'react';
import {
  api,
  EpicAccount,
  SteamAccount,
  useI18n,
  SteamPanel,
  EpicPanel,
  type Lang,
} from '@app/shared';
import { getLibraryView, LIBRARY_VIEW_KEY, type LibraryView } from './LibraryPage';
import { useLegendary } from '../legendary/LegendaryProvider';
import type { AiModelInfo, AiStatus, EnrichProgress, EnrichStatus, UpdateState } from '../../../preload';

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

// ---- Appearance: language only (the launcher is dark-only by design) ----
const AppearancePanel: React.FC = () => {
  const { t, lang, setLang } = useI18n();
  const [view, setView] = useState<LibraryView>(getLibraryView);
  const pickView = (v: LibraryView) => {
    setView(v);
    try {
      localStorage.setItem(LIBRARY_VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };
  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>{t('settings.appearance')}</h3>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
          {t('lang.label')}
          <select
            aria-label={t('lang.label')}
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
            style={{ ...btn, paddingRight: 8 }}
          >
            <option value="en">EN</option>
            <option value="ru">RU</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
          {t('settings.libraryView')}
          <select value={view} onChange={(e) => pickView(e.target.value as LibraryView)} style={{ ...btn, paddingRight: 8 }}>
            <option value="list">{t('settings.viewList')}</option>
            <option value="grid">{t('settings.viewGrid')}</option>
          </select>
        </label>
      </div>
    </div>
  );
};

// ---- AI search (chutes.ai): key, model, spend ----
const AiPanel: React.FC = () => {
  const { t } = useI18n();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  const [models, setModels] = useState<AiModelInfo[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => window.launcher.aiStatus().then(setStatus).catch(() => undefined), []);
  useEffect(() => {
    void refresh();
    window.launcher.aiListModels().then(setModels).catch(() => setModels([]));
  }, [refresh]);

  const act = async (fn: () => Promise<AiStatus>) => {
    setBusy(true);
    setMsg(null);
    try {
      setStatus(await fn());
      setMsg('✅');
    } catch (e) {
      setMsg(`${t('common.error')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const price = (m: AiModelInfo) =>
    m.promptPrice != null && m.completionPrice != null ? ` · $${m.promptPrice}/$${m.completionPrice} per 1M` : '';
  const roleLabel = (m: AiModelInfo) => t(`ai.role.${m.role}`);
  const current = status?.model ?? '';
  const known = models?.some((m) => m.id === current);

  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>{t('ai.title')}</h3>
      <p style={{ margin: '4px 0 12px', color: 'var(--muted)', fontSize: 13 }}>{t('ai.desc')}</p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={status?.configured ? t('ai.keySaved') : t('ai.keyPlaceholder')}
          autoComplete="off"
          style={{ width: 360 }}
        />
        <button style={syncBtn} disabled={busy || !key.trim()} onClick={() => void act(() => window.launcher.aiSetKey(key).then((s) => { setKey(''); return s; }))}>
          {t('ai.saveKey')}
        </button>
        {status?.configured && (
          <button style={btn} disabled={busy} onClick={() => void act(() => window.launcher.aiClearKey())}>
            {t('ai.clearKey')}
          </button>
        )}
        {msg && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{msg}</span>}
      </div>
      <p style={{ margin: '0 0 14px', color: 'var(--muted)', fontSize: 12 }}>
        {t('ai.keyHint')}{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); void window.launcher.openExternal('https://chutes.ai/'); }}>chutes.ai</a>
      </p>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--muted)', maxWidth: 520 }}>
        {t('ai.model')}
        <select
          value={known ? current : '__custom'}
          disabled={busy || !models}
          onChange={(e) => {
            if (e.target.value !== '__custom') void act(() => window.launcher.aiSetModel(e.target.value));
          }}
          style={{ ...btn, paddingRight: 8, maxWidth: 520 }}
        >
          {!known && current && <option value="__custom">{current}</option>}
          {(models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {roleLabel(m)} — {m.id}{price(m)}
            </option>
          ))}
        </select>
      </label>
      <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 12 }}>{t('ai.modelHint')}</p>

      {status && (
        <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
          {t('ai.usage', { r: status.usage.requests, i: status.usage.promptTokens.toLocaleString(), o: status.usage.completionTokens.toLocaleString() })}
        </p>
      )}
      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--muted)' }}>{t('ai.privacy')}</p>

      <EnrichmentBlock enabled={!!status?.configured} />
    </div>
  );
};

/** Shown wherever an AI feature is unusable because no chutes.ai key is saved. */
export const NoKeyNote: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: compact ? '6px 10px' : '8px 12px', borderRadius: 8, border: '1px solid rgba(87,184,240,0.35)', background: 'rgba(87,184,240,0.08)', fontSize: compact ? 12 : 12.5, color: 'var(--text)', margin: '0 0 10px' }}>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, padding: '1px 5px', borderRadius: 4, border: '1px solid rgba(185,203,224,0.5)', color: '#b9cbe0' }}>AI</span>
      <span>{t('ai.needKey')}</span>
    </div>
  );
};

/** One-off (then incremental) AI profiles for the whole library, with the cost up front. */
const EnrichmentBlock: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { t, lang } = useI18n();
  const [st, setSt] = useState<EnrichStatus | null>(null);
  const [progress, setProgress] = useState<EnrichProgress | null>(null);
  // Which run the warning is for: the missing games, or missing + profiles written in another language.
  const [confirm, setConfirm] = useState<'none' | 'missing' | 'lang'>('none');

  const refresh = useCallback(() => window.launcher.enrichStatus(lang).then(setSt).catch(() => undefined), [lang]);
  useEffect(() => {
    void refresh();
    return window.launcher.onEnrichProgress((p) => {
      setProgress(p);
      if (!p.running) void refresh();
    });
  }, [refresh]);

  const running = !!(progress?.running || st?.running);
  const est = confirm === 'lang' ? st?.estimateOtherLang : st?.estimate;
  const count = confirm === 'lang' ? (st?.missing ?? 0) + (st?.otherLang ?? 0) : st?.missing ?? 0;
  const usd = est?.usd;
  const cost = usd == null ? '' : usd < 0.01 ? '< $0.01' : `≈ $${usd.toFixed(2)}`;

  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{t('enrich.title')}</div>
      <p style={{ margin: '0 0 10px', color: 'var(--muted)', fontSize: 13 }}>{t('enrich.desc')}</p>
      {!enabled && <NoKeyNote />}
      {st && (
        <p style={{ margin: '0 0 10px', fontSize: 13 }}>
          {t('enrich.state', { p: st.profiles, g: st.games })}
          {st.lastRunAt && <span style={{ color: 'var(--muted)' }}> · {t('enrich.lastRun', { d: new Date(st.lastRunAt).toLocaleDateString() })}</span>}
        </p>
      )}

      {running && progress ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520 }}>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--panel-2)', overflow: 'hidden' }}>
            <div style={{ width: `${progress.total ? Math.round(((progress.done + progress.failed) / progress.total) * 100) : 0}%`, height: '100%', background: 'var(--accent)', borderRadius: 4, transition: 'width 0.4s ease' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12.5, color: 'var(--muted)' }}>
            <span>{t('enrich.progress', { d: progress.done + progress.failed, n: progress.total, tok: (progress.promptTokens + progress.completionTokens).toLocaleString() })}</span>
            <button style={btn} onClick={() => void window.launcher.enrichCancel()}>{t('enrich.cancel')}</button>
          </div>
        </div>
      ) : st && confirm !== 'none' && est ? (
        <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(87,184,240,0.45)', background: 'rgba(87,184,240,0.08)', maxWidth: 620 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>⚠ {t('enrich.warnTitle')}</div>
          <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.5 }}>
            {t('enrich.warnBody', { n: count, req: est.requests, tok: est.tokens.toLocaleString(), cost, min: est.minutes, model: est.model })}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={syncBtn} onClick={() => { const redo = confirm === 'lang'; setConfirm('none'); void window.launcher.enrichStart(lang, redo).then(setSt); }}>{t('enrich.confirm')}</button>
            <button style={btn} onClick={() => setConfirm('none')}>{t('enrich.back')}</button>
          </div>
        </div>
      ) : st ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          {st.missing > 0 ? (
            <button style={syncBtn} disabled={!enabled} onClick={() => setConfirm('missing')}>
              {t('enrich.button', { n: st.missing })}
            </button>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--success)' }}>✓ {t('enrich.complete')}</p>
          )}
          {st.otherLang > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
              <span style={{ color: 'var(--muted)' }}>{t('enrich.otherLang', { n: st.otherLang })}</span>
              <button style={btn} disabled={!enabled} onClick={() => setConfirm('lang')}>{t('enrich.redoLang')}</button>
            </div>
          )}
        </div>
      ) : null}

      {progress && !progress.running && progress.total > 0 && (
        <p style={{ margin: '10px 0 0', fontSize: 12.5, color: progress.error ? '#ff9f6b' : 'var(--muted)' }}>
          {progress.cancelled ? t('enrich.cancelled') : t('enrich.finished', { d: progress.done, f: progress.failed, tok: (progress.promptTokens + progress.completionTokens).toLocaleString() })}
          {progress.error ? ` · ${progress.error.slice(0, 160)}` : ''}
        </p>
      )}
      {st && st.profiles > 0 && !running && (
        <button style={{ ...btn, marginTop: 10, background: 'transparent', color: 'var(--muted)' }} onClick={() => { if (window.confirm(t('enrich.clearConfirm'))) void window.launcher.enrichClear(lang).then(setSt); }}>
          {t('enrich.clear')}
        </button>
      )}
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
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  useEffect(() => {
    let alive = true;
    window.launcher
      .getInstallPath()
      .then((p) => alive && setValue(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // The reset timer is cleared on unmount so it can't set state on a gone component.
  useEffect(() => {
    if (status === 'idle') return;
    const timer = setTimeout(() => setStatus('idle'), 1600);
    return () => clearTimeout(timer);
  }, [status]);

  const save = async () => {
    try {
      await window.launcher.setInstallPath(value.trim());
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  };

  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>{t('settings.installPath')}</h3>
      <p style={{ margin: '4px 0 10px', color: 'var(--muted)' }}>{t('settings.installPath.desc')}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('settings.installPath.placeholder')}
          style={{ flex: 1, minWidth: 260 }}
        />
        <button style={btn} onClick={save}>
          {status === 'saved' ? '✅' : status === 'error' ? `⚠️ ${t('common.error')}` : t('settings.installPath.save')}
        </button>
      </div>
    </div>
  );
};

// ---- Auto-update (GitHub Releases; inert in dev builds) ----
const UpdatesPanel: React.FC = () => {
  const { t } = useI18n();
  const [version, setVersion] = useState('');
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    window.launcher.appVersion().then(setVersion).catch(() => undefined);
    window.launcher.updateStatus().then(setState).catch(() => undefined);
    return window.launcher.onUpdateState(setState);
  }, []);

  const check = async () => {
    setChecked(true);
    try {
      setState(await window.launcher.updateCheck());
    } catch {
      /* state arrives via events */
    }
  };

  const statusLine = (): string | null => {
    switch (state.status) {
      case 'checking':
        return t('update.checking');
      case 'downloading':
        return t('update.downloading', { version: state.version, pct: state.pct });
      case 'ready':
        return t('update.ready', { version: state.version });
      case 'error':
        return checked ? `${t('common.error')}: ${state.message}` : null;
      default:
        return checked ? t('update.none') : null;
    }
  };

  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>{t('update.title')}</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>
          {t('update.version', { version: version || '—' })}
        </span>
        {state.status === 'ready' ? (
          <button style={syncBtn} onClick={() => void window.launcher.updateInstall()}>
            {t('update.restart')}
          </button>
        ) : (
          <button style={btn} disabled={state.status === 'checking'} onClick={check}>
            {t('update.check')}
          </button>
        )}
      </div>
      {statusLine() && (
        <p style={{ margin: '10px 0 0', color: 'var(--muted)', fontSize: 13 }}>{statusLine()}</p>
      )}
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
  const [rememberSteam, setRememberSteam] = useState(true);
  const [steamLoggedIn, setSteamLoggedIn] = useState(false);

  useEffect(() => {
    window.launcher
      .steamStatus()
      .then((s) => setSteamLoggedIn(s.loggedIn))
      .catch(() => setSteamLoggedIn(false));
  }, []);

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

  const steamWebLogin = async () => {
    setBusy('steamLogin');
    setMsg(null);
    try {
      const r = await window.launcher.steamLogin(rememberSteam);
      if (r.success) {
        setMsg(`✅ ${t('steam.signedInAs', { name: r.personaName ?? r.steamId ?? '', count: r.gameCount ?? 0 })}`);
        setSteamLoggedIn(true);
        await loadAccounts();
      } else {
        setMsg(`⚠️ ${r.message ?? t('common.error')}`);
      }
    } catch (e) {
      setMsg(`${t('common.error')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const steamWebLogout = async () => {
    setBusy('steamLogout');
    setMsg(null);
    try {
      await window.launcher.steamLogout();
      setSteamLoggedIn(false);
      setMsg(`✅ ${t('steam.signedOut')}`);
      // Signing out clears the stored account and library — reflect that here.
      await loadAccounts();
    } catch (e) {
      setMsg(`${t('common.error')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const epicSignOut = async () => {
    setBusy('epicLogout');
    setMsg(null);
    try {
      await api.logoutEpic();
      setMsg(`✅ ${t('epic.signedOut')}`);
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
      <AiPanel />
      <RegionsPanel steam={steam} epic={epic} onChanged={loadAccounts} />
      <InstallPathPanel />
      <UpdatesPanel />

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{t('settings.steam')}</h3>

        {/* Preferred: secure web sign-in — no API key, works for private profiles. */}
        <button style={syncBtn} disabled={busy !== null} onClick={steamWebLogin}>
          {busy === 'steamLogin' ? t('settings.syncing') : t('steam.webLogin')}
        </button>
        {steamLoggedIn && (
          <button style={{ ...btn, marginLeft: 8 }} disabled={busy !== null} onClick={steamWebLogout}>
            {t('steam.signOut')}
          </button>
        )}
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 13, cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            checked={rememberSteam}
            onChange={(e) => setRememberSteam(e.target.checked)}
          />
          {t('steam.remember')}
        </label>
        <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 13 }}>{t('steam.webLoginDesc')}</p>

        {/* Fallback: manual API key + SteamID (works without a Steam sign-in). */}
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>{t('steam.advanced')}</summary>
          <div style={{ marginTop: 10 }}>
            <SteamPanel initialSteamId={steam?.steamId} onChanged={loadAccounts} />
            <div style={{ marginTop: 14 }}>
              <button style={syncBtn} disabled={busy !== null} onClick={() => doSync('steam', api.syncSteam)}>
                {busy === 'steam' ? t('settings.syncing') : t('settings.syncSteam')}
              </button>
            </div>
          </div>
        </details>
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{t('settings.epic')}</h3>

        {!available && (
          <p style={{ margin: '4px 0 12px', color: '#e0a458' }}>⚠️ {t('epic.legendaryMissing')}</p>
        )}

        {/* Preferred: embedded OAuth (syncs the library + authorizes legendary). */}
        <button style={syncBtn} disabled={busy !== null} onClick={embeddedEpicLogin}>
          {busy === 'epicLogin' ? t('settings.syncing') : t('epic.embeddedLogin')}
        </button>
        {epic?.connected && (
          <button style={{ ...btn, marginLeft: 8 }} disabled={busy !== null} onClick={epicSignOut}>
            {t('epic.signOut')}
          </button>
        )}
        <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 13 }}>{t('epic.embeddedDesc')}</p>

        {/* Fallback: manual code paste (handled by the local API router). */}
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
