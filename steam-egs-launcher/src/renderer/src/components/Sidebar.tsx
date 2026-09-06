import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api, useI18n } from '@app/shared';
import { LibraryIcon, StoreIcon, StatsIcon, SettingsIcon, PowerIcon, DiceIcon } from './icons';
import type { UpdateState } from '../../../preload';

/**
 * Auto-update card, shown above the profile block from the moment a new
 * version is found: download progress first, then "restart to update". The
 * app never restarts on its own; the button installs silently and relaunches.
 */
const UpdateCard: React.FC = () => {
  const { t } = useI18n();
  const [state, setState] = useState<UpdateState>({ status: 'idle' });

  useEffect(() => {
    window.launcher.updateStatus().then(setState).catch(() => undefined);
    return window.launcher.onUpdateState(setState);
  }, []);

  if (state.status !== 'downloading' && state.status !== 'ready') return null;
  const ready = state.status === 'ready';
  return (
    <div
      role="status"
      style={{
        margin: '0 0 10px 0',
        padding: '10px 12px',
        borderRadius: 10,
        background: 'linear-gradient(180deg, #1f3550 0%, #182a40 100%)',
        border: '1px solid rgba(87, 184, 240, 0.35)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(255,255,255,0.03)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: ready ? 'var(--discount-text)' : 'var(--accent)',
            boxShadow: ready ? '0 0 8px var(--discount-text)' : '0 0 8px var(--accent)',
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2 }}>
          {ready ? t('update.card.ready', { version: state.version }) : t('update.card.downloading', { version: state.version })}
        </span>
      </div>
      {ready ? (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.35, marginBottom: 8 }}>{t('update.card.hint')}</div>
          <button
            type="button"
            onClick={() => void window.launcher.updateInstall()}
            style={{
              width: '100%',
              padding: '7px 0',
              borderRadius: 7,
              border: 'none',
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: 12.5,
              color: 'var(--on-accent)',
              background: 'linear-gradient(180deg, #6cc4f6 0%, #2f8fd0 100%)',
            }}
          >
            ↻ {t('update.card.restart')}
          </button>
        </>
      ) : (
        <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
          <div style={{ width: `${Math.max(2, state.pct)}%`, height: '100%', background: 'var(--accent)', borderRadius: 2, transition: 'width 0.3s ease' }} />
        </div>
      )}
    </div>
  );
};

// App logo mark — the fanned-cards icon (same motif as the exe icon).
const LogoMark: React.FC = () => (
  <svg width="28" height="28" viewBox="0 0 28 28">
    <rect x="1" y="1" width="26" height="26" rx="7" fill="#1d2940" />
    <rect x="7" y="6.5" width="10" height="14" rx="2" fill="#dfe7f0" transform="rotate(-10 12 13.5)" />
    <rect x="11" y="8" width="10" height="14" rx="2" fill="var(--accent)" transform="rotate(7 16 15)" />
    <path d="M14.6 13.2 L18.4 15.3 L14.6 17.4 Z" fill="#10151d" />
  </svg>
);

const rowBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  padding: '10px 12px',
  borderRadius: 8,
  color: '#94a6bd',
  textDecoration: 'none',
  fontWeight: 500,
  fontSize: 14.5,
  cursor: 'pointer',
  border: 'none',
  background: 'transparent',
  width: '100%',
  textAlign: 'left',
};

const items = [
  { to: '/', labelKey: 'sidebar.library', Icon: LibraryIcon, end: true },
  { to: '/store', labelKey: 'sidebar.store', Icon: StoreIcon, end: false },
  { to: '/random', labelKey: 'sidebar.random', Icon: DiceIcon, end: false },
  { to: '/stats', labelKey: 'sidebar.stats', Icon: StatsIcon, end: false },
  { to: '/settings', labelKey: 'sidebar.settings', Icon: SettingsIcon, end: false },
];

// Account summary cached at module level: the sidebar remounts never, but the
// fetch shouldn't rerun on hot reloads either.
let cachedWho: { name: string; steam: boolean; epic: boolean } | null = null;

const Sidebar: React.FC = () => {
  const { t } = useI18n();
  const tr = t as (k: string) => string;
  const [who, setWho] = useState(cachedWho);

  useEffect(() => {
    if (cachedWho) return;
    let alive = true;
    Promise.all([api.getSteamAccount().catch(() => null), api.getEpicAccount().catch(() => null)])
      .then(([s, e]) => {
        if (!alive) return;
        cachedWho = {
          name: s?.personaName ?? e?.displayName ?? '—',
          steam: !!s?.configured,
          epic: !!e?.connected,
        };
        setWho(cachedWho);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const initials = (who?.name ?? '·')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <aside
      style={{
        width: 224,
        flex: '0 0 224px',
        height: '100%',
        background: 'linear-gradient(180deg, var(--bg-chrome) 0%, #10151d 100%)',
        borderRight: '1px solid #232f42',
        display: 'flex',
        flexDirection: 'column',
        padding: '18px 12px 12px 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px 18px 8px' }}>
        <LogoMark />
        <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>
          GL Aggregator
        </span>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {items.map(({ to, labelKey, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            style={({ isActive }) => ({
              ...rowBase,
              ...(isActive
                ? {
                    background: 'linear-gradient(90deg, #22324a 0%, #1d2a3e 100%)',
                    color: 'var(--accent-bright)',
                    fontWeight: 600,
                  }
                : {}),
            })}
          >
            <Icon />
            <span>{tr(labelKey)}</span>
          </NavLink>
        ))}
      </nav>

      <div style={{ marginTop: 'auto' }}>
        <UpdateCard />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 8px 2px 8px',
            borderTop: '1px solid #1f2a3c',
          }}
        >
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #2b4a6b, #1d3049)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: 13,
              color: 'var(--accent-bright)',
              flexShrink: 0,
            }}
          >
            {initials}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: 13.5,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {who?.name ?? '…'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--muted)' }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: who?.steam ? 'var(--accent)' : '#3a4658',
                  display: 'inline-block',
                }}
              />
              Steam
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: who?.epic ? 'var(--epic)' : '#3a4658',
                  display: 'inline-block',
                }}
              />
              EGS
            </div>
          </div>
          <button
            type="button"
            onClick={() => window.launcher.quit()}
            title={t('sidebar.quit')}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--muted)',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 6,
              display: 'flex',
            }}
          >
            <PowerIcon />
          </button>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
