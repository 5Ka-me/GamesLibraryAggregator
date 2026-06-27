import React, { useState } from 'react';
import { api } from '../api/client';
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

const SteamPanel: React.FC<{ initialSteamId?: string | null; onChanged?: () => void }> = ({
  initialSteamId,
  onChanged,
}) => {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState('');
  const [steamId, setSteamId] = useState(initialSteamId ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const acc = await api.saveSteamCredentials(apiKey.trim(), steamId.trim());
      setStatus(`✅ ${t('steam.saved')}${acc.personaName ? ` (${acc.personaName})` : ''}.`);
      setApiKey('');
      onChanged?.();
    } catch (e) {
      setStatus(`${t('common.error')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p style={{ margin: '4px 0', color: 'var(--muted)' }}>
        {t('steam.help')}{' '}
        <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer">
          steamcommunity.com/dev/apikey
        </a>
        {t('steam.publicProfile')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
        <input placeholder={t('steam.apiKey')} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        <input placeholder={t('steam.steamId')} value={steamId} onChange={(e) => setSteamId(e.target.value)} />
        <button style={btn} disabled={busy || !apiKey.trim() || !steamId.trim()} onClick={save}>
          {t('steam.save')}
        </button>
      </div>

      {status && (
        <p style={{ marginTop: 12, padding: '8px 10px', background: 'var(--panel-2)', borderRadius: 6 }}>
          {status}
        </p>
      )}
    </div>
  );
};

export default SteamPanel;
