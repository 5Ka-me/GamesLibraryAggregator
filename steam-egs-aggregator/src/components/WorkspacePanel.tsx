import React, { useState } from 'react';
import { workspace } from '../api/client';
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

const WorkspacePanel: React.FC = () => {
  const { t } = useI18n();
  const token = workspace.getToken() ?? '';
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [incoming, setIncoming] = useState('');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const apply = () => {
    const t2 = incoming.trim();
    if (!t2) return;
    workspace.setToken(t2);
    window.location.reload(); // reload to load the new workspace's data
  };

  const masked = token ? `${token.slice(0, 6)}${'•'.repeat(Math.max(0, token.length - 6))}` : '—';

  return (
    <div>
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

export default WorkspacePanel;
