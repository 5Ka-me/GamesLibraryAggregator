import React, { useCallback, useEffect, useState } from 'react';
import { api, Game } from '../api/client';
import { useI18n } from '../i18n/I18nContext';
import Header from '../components/Header';
import GameList from '../components/GameList';

const LibraryPage: React.FC = () => {
  const { t } = useI18n();
  const [games, setGames] = useState<Game[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      setGames(await api.getCombinedLibrary());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
      <Header action="settings" />

      {error && (
        <p style={{ color: '#ff6b6b', background: 'var(--panel-2)', padding: '8px 10px', borderRadius: 6 }}>
          {t('lib.error')}: {error}
        </p>
      )}

      {loading ? <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p> : <GameList games={games} />}
    </div>
  );
};

export default LibraryPage;
