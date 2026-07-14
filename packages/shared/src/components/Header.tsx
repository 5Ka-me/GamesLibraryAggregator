import React from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../theme/ThemeContext';
import { useI18n, Lang } from '../i18n/I18nContext';

const ctrl: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  color: 'var(--text)',
  textDecoration: 'none',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

const Header: React.FC<{ action: 'settings' | 'back' }> = ({ action }) => {
  const { theme, toggle } = useTheme();
  const { t, lang, setLang } = useI18n();

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 24,
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <h1 style={{ fontSize: 24, margin: 0 }}>
        <Link to="/" style={{ color: 'var(--text)', textDecoration: 'none' }}>
          {t('app.title')}
        </Link>{' '}
        <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 18 }}>
          {t('app.by')}{' '}
          <a href="https://t.me/I_am_5Ka" target="_blank" rel="noopener noreferrer">
            5Ka
          </a>
        </span>
      </h1>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select
          aria-label={t('lang.label')}
          value={lang}
          onChange={(e) => setLang(e.target.value as Lang)}
          style={{ ...ctrl, paddingRight: 8 }}
        >
          <option value="en">EN</option>
          <option value="ru">RU</option>
        </select>

        <button style={ctrl} onClick={toggle}>
          {theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
        </button>

        <Link to={action === 'settings' ? '/settings' : '/'} style={ctrl}>
          {action === 'settings' ? t('header.settings') : t('header.back')}
        </Link>
      </div>
    </header>
  );
};

export default Header;
