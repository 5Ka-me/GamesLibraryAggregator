import React, { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, useI18n } from '@app/shared';
import { ChevronDownIcon } from './icons';
import type { UpdateState } from '../../../preload';

// Steam-style title bar. It IS the window frame: the whole strip is a drag
// region (see titleBarStyle/titleBarOverlay in main), Windows paints the
// min/max/close buttons over its right end in our colours, and everything
// interactive opts out of dragging. Left: logo + section nav. Right: the
// auto-update chip (when there is one) and the profile, which opens Settings.

// App logo mark — the fanned-cards icon (same motif as the exe icon).
const LogoMark: React.FC = () => (
  <svg width="22" height="22" viewBox="0 0 28 28">
    <rect x="1" y="1" width="26" height="26" rx="7" fill="#1d2940" />
    <rect x="7" y="6.5" width="10" height="14" rx="2" fill="#dfe7f0" transform="rotate(-10 12 13.5)" />
    <rect x="11" y="8" width="10" height="14" rx="2" fill="var(--accent)" transform="rotate(7 16 15)" />
    <path d="M14.6 13.2 L18.4 15.3 L14.6 17.4 Z" fill="#10151d" />
  </svg>
);

const items = [
  { to: '/', labelKey: 'sidebar.library', end: false, match: (p: string) => p === '/' || p.startsWith('/library') || p === '/game' },
  { to: '/store', labelKey: 'sidebar.store', end: false, match: (p: string) => p.startsWith('/store') },
  { to: '/random', labelKey: 'sidebar.random', end: false, match: (p: string) => p.startsWith('/random') },
  { to: '/stats', labelKey: 'sidebar.stats', end: false, match: (p: string) => p.startsWith('/stats') },
];

// Profile card source of truth: Steam (name + avatar) when connected, else
// EGS (name only — Epic exposes no avatar to us), else dashes. Cached at
// module level and refreshed whenever the library changes (login, sync).
interface Who {
  name: string;
  avatarUrl: string | null;
  steam: boolean;
  epic: boolean;
}
let cachedWho: Who | null = null;

async function loadWho(): Promise<Who> {
  const [s, e] = await Promise.all([api.getSteamAccount().catch(() => null), api.getEpicAccount().catch(() => null)]);
  const steam = !!s?.configured;
  const epic = !!e?.connected;
  if (steam) return { name: s?.personaName?.trim() || '—', avatarUrl: s?.avatarUrl ?? null, steam, epic };
  if (epic) return { name: e?.displayName?.trim() || '—', avatarUrl: null, steam, epic };
  return { name: '—', avatarUrl: null, steam, epic };
}

/** Auto-update chip: download progress, then "restart" — never restarts on its own. */
const UpdateChip: React.FC = () => {
  const { t } = useI18n();
  const [state, setState] = useState<UpdateState>({ status: 'idle' });

  useEffect(() => {
    window.launcher.updateStatus().then(setState).catch(() => undefined);
    return window.launcher.onUpdateState(setState);
  }, []);

  if (state.status === 'downloading') {
    return (
      <span className="update-chip no-drag" style={{ cursor: 'default' }} title={t('update.downloading', { version: state.version, pct: state.pct })}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)' }} />
        {t('update.downloading', { version: state.version, pct: state.pct })}
      </span>
    );
  }
  if (state.status === 'ready') {
    return (
      <button className="update-chip no-drag" onClick={() => void window.launcher.updateInstall()} title={t('update.card.hint')}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--discount-text)', boxShadow: '0 0 8px var(--discount-text)' }} />
        {t('update.chip', { version: state.version })}
      </button>
    );
  }
  return null;
};

const TopBar: React.FC = () => {
  const { t } = useI18n();
  const tr = t as (k: string) => string;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [who, setWho] = useState<Who | null>(cachedWho);
  const [avatarBroken, setAvatarBroken] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      loadWho()
        .then((w) => {
          if (!alive) return;
          cachedWho = w;
          setWho(w);
          setAvatarBroken(false);
        })
        .catch(() => undefined);
    if (!cachedWho) void refresh();
    // A sign-in or sync changes the persona/avatar — refresh with the library.
    const off = window.launcher.onLibraryChanged(() => void refresh());
    return () => {
      alive = false;
      off();
    };
  }, []);

  const name = who?.name ?? '…';
  const initials =
    name === '—' || name === '…'
      ? name
      : name
          .split(/\s+/)
          .map((w) => w[0])
          .join('')
          .slice(0, 2)
          .toUpperCase();
  const avatar = who?.avatarUrl && !avatarBroken ? who.avatarUrl : null;

  return (
    <header
      className="titlebar"
      style={{
        height: 40,
        flex: '0 0 40px',
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--bg-chrome)',
        borderBottom: '1px solid #232f42',
        // Leave the right end to the native window controls (titleBarOverlay).
        paddingRight: 'calc(100vw - env(titlebar-area-width, 100vw))',
        position: 'relative',
        zIndex: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 14px 0 12px' }}>
        <LogoMark />
        <span style={{ fontWeight: 800, fontSize: 13.5, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>GL Aggregator</span>
      </div>

      <nav className="no-drag" style={{ display: 'flex', alignItems: 'stretch', gap: 22, marginLeft: 14 }}>
        {items.map(({ to, labelKey, match }) => (
          <NavLink key={to} to={to} className={`topnav${match(pathname) ? ' active' : ''}`} end={to === '/'}>
            {tr(labelKey)}
          </NavLink>
        ))}
      </nav>

      <div style={{ flex: 1 }} />

      <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 8 }}>
        <UpdateChip />
        <button className="profile-btn" onClick={() => navigate('/settings')} title={t('topbar.profile')}>
          <span style={{ textAlign: 'right', lineHeight: 1.1 }}>
            <span style={{ display: 'block', fontWeight: 600, fontSize: 12.5, maxWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {name}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: who?.steam ? 'var(--accent)' : '#3a4658', display: 'inline-block' }} />
              Steam
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: who?.epic ? 'var(--epic)' : '#3a4658', display: 'inline-block' }} />
              EGS
            </span>
          </span>
          {avatar ? (
            <img
              src={avatar}
              alt=""
              draggable={false}
              onError={() => setAvatarBroken(true)}
              style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', boxShadow: '0 0 0 1px rgba(87,184,240,.35)', flexShrink: 0 }}
            />
          ) : (
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #2b4a6b, #1d3049)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 11.5,
                color: 'var(--accent-bright)',
                boxShadow: '0 0 0 1px rgba(87,184,240,.35)',
                flexShrink: 0,
              }}
            >
              {initials}
            </span>
          )}
          <span style={{ color: '#94a6bd', display: 'flex' }}>
            <ChevronDownIcon />
          </span>
        </button>
      </div>
    </header>
  );
};

export default TopBar;
