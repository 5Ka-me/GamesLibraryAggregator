import React, { useCallback, useEffect, useState } from 'react';
import {
  api,
  Game,
  SteamRecentGame,
  useI18n,
  GameList,
  getOpenGameDetails,
  steamAppId,
  useLibraryActions,
} from '@app/shared';
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

// Module-level caches: navigating to a game page and back renders instantly.
let cachedGames: Game[] | null = null;
let cachedRecent: SteamRecentGame[] | null = null;

/** Steam-style "Recent" shelf: last-2-weeks games matched to the library. */
const RecentShelf: React.FC<{ recent: SteamRecentGame[]; games: Game[] }> = ({ recent, games }) => {
  const { t } = useI18n();
  const actions = useLibraryActions();
  const openDetails = getOpenGameDetails();

  // Match recent appids to library games (for navigation + install state).
  const byAppId = new Map<string, Game>();
  for (const g of games) {
    for (const e of g.entries) {
      const id = steamAppId(e);
      if (id) byAppId.set(id, g);
    }
  }

  const rows = recent
    .map((r) => ({ recent: r, game: byAppId.get(String(r.appId)) ?? null }))
    .slice(0, 3);
  if (rows.length === 0) return null;

  return (
    <div style={{ marginBottom: 26 }}>
      <div className="uc-header" style={{ marginBottom: 10 }}>
        {t('lib.recent')}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {rows.map(({ recent: r, game }) => {
          const steamEntry = game?.entries.find((e) => e.source === 'Steam');
          const installed = actions?.getSteamState(String(r.appId)).installed ?? false;
          const hours = Math.round(r.playtime2Weeks / 6) / 10;
          return (
            <div
              key={r.appId}
              className="shelf-card"
              onClick={() => game && openDetails?.(game)}
            >
              <img
                src={`https://cdn.cloudflare.steamstatic.com/steam/apps/${r.appId}/header.jpg`}
                alt={r.name}
                loading="lazy"
                style={{ width: '100%', height: 150, objectFit: 'cover', display: 'block' }}
              />
              <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: 15,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {r.name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {t('lib.recent2w', { h: hours })}
                  </div>
                </div>
                {installed && steamEntry?.launchUrl ? (
                  <button
                    className="btn-play"
                    onClick={(e) => {
                      e.stopPropagation();
                      void window.launcher.openDeepLink(steamEntry.launchUrl!);
                    }}
                  >
                    ▶ {t('card.play')}
                  </button>
                ) : steamEntry?.installUrl ? (
                  <button
                    style={iconBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      void window.launcher.openDeepLink(steamEntry.installUrl!);
                    }}
                  >
                    ⬇ {t('card.install')}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const LibraryPage: React.FC = () => {
  const { t } = useI18n();
  const [games, setGames] = useState<Game[]>(cachedGames ?? []);
  const [recent, setRecent] = useState<SteamRecentGame[]>(cachedRecent ?? []);
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
    // The shelf is a nice-to-have — its failure never blocks the library.
    api
      .getSteamRecent()
      .then((r) => {
        cachedRecent = r;
        setRecent(r);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    // Background autosync (main process) finished → pick up the fresh library.
    return window.launcher.onLibraryChanged(() => void load());
  }, [load]);

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 24px' }}>
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
        <>
          <RecentShelf recent={recent} games={games} />
          <GameList games={games} stateKey="library" />
        </>
      )}
    </div>
  );
};

export default LibraryPage;
