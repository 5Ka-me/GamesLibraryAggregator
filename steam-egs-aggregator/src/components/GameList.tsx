import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Game, Source } from '../api/client';
import { useI18n } from '../i18n/I18nContext';
import GameCard from './GameCard';

type Filter = 'all' | Source | 'both';

const PAGE = 60; // how many cards to add per batch

const GameList: React.FC<{ games: Game[] }> = ({ games }) => {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(PAGE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const counts = useMemo(
    () => ({
      all: games.length,
      Steam: games.filter((g) => g.sources.includes('Steam')).length,
      Epic: games.filter((g) => g.sources.includes('Epic')).length,
      both: games.filter((g) => g.sources.length > 1).length,
    }),
    [games]
  );

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return games.filter((g) => {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'both' ? g.sources.length > 1 : g.sources.includes(filter));
      return matchesFilter && g.title.toLowerCase().includes(q);
    });
  }, [games, filter, query]);

  // Reset the visible window when the filter/search changes.
  useEffect(() => setVisible(PAGE), [filter, query]);

  // Load the next batch when the sentinel enters the viewport.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisible((v) => (v < filtered.length ? v + PAGE : v));
        }
      },
      { rootMargin: '400px' }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [filtered.length]);

  const shown = filtered.slice(0, visible);

  const tabs: { key: Filter; label: string }[] = [
    { key: 'all', label: t('filter.all') },
    { key: 'Steam', label: t('filter.steam') },
    { key: 'Epic', label: t('filter.epic') },
    { key: 'both', label: t('filter.both') },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              cursor: 'pointer',
              background: filter === tab.key ? 'var(--accent)' : 'var(--panel)',
              color: filter === tab.key ? 'var(--on-accent)' : 'var(--text)',
              fontWeight: 600,
            }}
          >
            {tab.label} ({counts[tab.key]})
          </button>
        ))}

        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <input
            placeholder={t('filter.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ minWidth: 220, paddingRight: query ? 30 : 10 }}
          />
          {query && (
            <button
              aria-label={t('filter.clear')}
              title={t('filter.clear')}
              onClick={() => setQuery('')}
              style={{
                position: 'absolute',
                right: 6,
                top: '50%',
                transform: 'translateY(-50%)',
                border: 'none',
                background: 'transparent',
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                padding: 2,
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>{t('lib.empty')}</p>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {shown.map((g) => (
              <GameCard key={`${g.title}-${g.sources.join('-')}`} game={g} />
            ))}
          </div>
          <div ref={sentinelRef} style={{ height: 1 }} />
        </>
      )}
    </div>
  );
};

export default GameList;
