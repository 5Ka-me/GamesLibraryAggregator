import React from 'react';
import { NavLink } from 'react-router-dom';
import { useI18n } from '@app/shared';
import { LibraryIcon, StoreIcon, StatsIcon, SettingsIcon, PowerIcon } from './icons';

const rowBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 12px',
  borderRadius: 8,
  color: 'var(--text)',
  textDecoration: 'none',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
  border: 'none',
  background: 'transparent',
  width: '100%',
  textAlign: 'left',
};

const items = [
  { to: '/', labelKey: 'sidebar.library', Icon: LibraryIcon, end: true },
  { to: '/store', labelKey: 'sidebar.store', Icon: StoreIcon, end: false },
  { to: '/stats', labelKey: 'sidebar.stats', Icon: StatsIcon, end: false },
  { to: '/settings', labelKey: 'sidebar.settings', Icon: SettingsIcon, end: false },
];

const Sidebar: React.FC = () => {
  const { t } = useI18n();
  const tr = t as (k: string) => string;

  return (
    <aside
      style={{
        width: 210,
        flex: '0 0 210px',
        height: '100%',
        boxSizing: 'border-box',
        background: 'var(--panel)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        padding: 12,
      }}
    >
      <div style={{ padding: '8px 10px 16px', fontWeight: 800, fontSize: 16, whiteSpace: 'nowrap' }}>
        🎮 GL Aggregator
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map(({ to, labelKey, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            style={({ isActive }) => ({
              ...rowBase,
              background: isActive ? 'var(--accent)' : 'transparent',
              color: isActive ? 'var(--on-accent)' : 'var(--text)',
            })}
          >
            <Icon />
            <span>{tr(labelKey)}</span>
          </NavLink>
        ))}
      </nav>

      <button
        type="button"
        onClick={() => window.launcher.quit()}
        style={{ ...rowBase, marginTop: 'auto' }}
        title={t('sidebar.quit')}
      >
        <PowerIcon />
        <span>{t('sidebar.quit')}</span>
      </button>
    </aside>
  );
};

export default Sidebar;
