import React, { useState } from 'react';
import { api, EpicAuthResult } from '../api/client';
import { useI18n } from '../i18n/I18nContext';

const btn: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  cursor: 'pointer',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  fontWeight: 600,
};

const EpicPanel: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const handleResult = (r: EpicAuthResult) => {
    if (r.success) {
      const name = r.displayName ? ` (${r.displayName})` : '';
      setStatus(`✅ ${t('epic.connectedAs', { name, count: r.gameCount })}`);
      onChanged?.();
    } else {
      setStatus(`⚠️ ${r.message ?? t('epic.requiresLogin')}`);
    }
  };

  const run = async (fn: () => Promise<EpicAuthResult>) => {
    setBusy(true);
    setStatus(null);
    try {
      handleResult(await fn());
    } catch (e) {
      setStatus(`${t('common.error')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const openLogin = async () => {
    try {
      const { loginUrl } = await api.getEpicLoginUrl();
      window.open(loginUrl, '_blank', 'noopener');
    } catch (e) {
      setStatus(`${t('common.error')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div>
      <p style={{ margin: '4px 0', color: 'var(--muted)' }}>
        <b>{t('epic.variantAuto')}</b> {t('epic.autoDesc')}
      </p>
      <button style={btn} disabled={busy} onClick={() => run(api.importEpicLauncher)}>
        {t('epic.importLauncher')}
      </button>

      <p style={{ margin: '16px 0 4px', color: 'var(--muted)' }}>
        <b>{t('epic.variantManual')}</b>{' '}
        {t('epic.manualDesc', { code: 'authorizationCode' })}
      </p>
      <button style={btn} onClick={openLogin}>
        {t('epic.openLogin')}
      </button>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <input
          placeholder={t('epic.pasteCode')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button
          style={{ ...btn, background: 'var(--epic)', color: 'var(--on-accent)', borderColor: 'transparent' }}
          disabled={busy || !code.trim()}
          onClick={() => run(() => api.authEpicWithCode(code.trim()))}
        >
          {t('epic.connect')}
        </button>
      </div>

      {status && (
        <p style={{ marginTop: 14, padding: '8px 10px', background: 'var(--panel-2)', borderRadius: 6 }}>
          {status}
        </p>
      )}
    </div>
  );
};

export default EpicPanel;
