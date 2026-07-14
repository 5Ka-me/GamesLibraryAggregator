import React, { useCallback, useEffect, useState } from 'react';
import { api, Game, useI18n, GameList } from '@app/shared';
import { useScrollRestore } from '../hooks/useScrollRestore';

const iconBtn: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  color: 'var(--text)',
  fontWeight: 600,
  cursor: 'pointer',
};

// Module-level games cache: survives navigating to a game page and back — the
// list renders instantly; filters live in GameList (stateKey) and the scroll
// position is handled by useScrollRestore.
let cachedGames: Game[] | null = null;

const LibraryPage: React.FC = () => {
  const { t } = useI18n();
  const [games, setGames] = useState<Game[]>(cachedGames ?? []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(cachedGames === null);

  useScrollRestore('library', !loading && games.length > 0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.getCombinedLibrary();
      cachedGames = list;
      setGames(list);
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
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      <h2 style={{ marginTop: 0 }}>{t('sidebar.library')}</h2>

      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            color: '#ff6b6b',
            background: 'var(--panel-2)',
            padding: '8px 10px',
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          <span style={{ flex: 1 }}>
            {t('lib.error')}: {error}
          </span>
          <button
            style={iconBtn}
            onClick={() => {
              setLoading(true);
              load();
            }}
          >
            ↻
          </button>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>
      ) : (
        <GameList games={games} stateKey="library" />
      )}
    </div>
  );
};

export default LibraryPage;
