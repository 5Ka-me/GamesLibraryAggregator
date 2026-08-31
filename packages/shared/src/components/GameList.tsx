import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Game, Source } from '../api/client';
import { useI18n } from '../i18n/I18nContext';
import { useLibraryActions } from '../libraryActions';
import { isInstalled } from '../installState';
import { SOURCES, SOURCE_IDS } from '../sources';
import GameCard from './GameCard';

const PAGE = 60; // how many cards to add per batch

export type LibrarySort = 'name' | 'playtime';

interface ListState {
  sources: Source[];
  installedOnly: boolean;
  query: string;
  visible: number;
  sort: LibrarySort;
}

// Survives unmount/remount within the session (e.g. navigating to a game page
// and back) — keyed by the host-provided stateKey.
const savedListStates = new Map<string, ListState>();

const GameList: React.FC<{ games: Game[]; stateKey?: string }> = ({ games, stateKey }) => {
  const { t } = useI18n();
  const actions = useLibraryActions();
  const saved = stateKey ? savedListStates.get(stateKey) : undefined;

  // Source filters are AND-conditions: one selected → games available on that
  // platform; both selected → games present in BOTH libraries; none selected
  // ("All") → everything. "Installed" is an independent toggle on top.
  const [sources, setSources] = useState<Source[]>(saved?.sources ?? []);
  const [installedOnly, setInstalledOnly] = useState(saved?.installedOnly ?? false);
  const [query, setQuery] = useState(saved?.query ?? '');
  const [visible, setVisible] = useState(saved?.visible ?? PAGE);
  const [sort, setSort] = useState<LibrarySort>(saved?.sort ?? 'name');
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (stateKey) savedListStates.set(stateKey, { sources, installedOnly, query, visible, sort });
  }, [stateKey, sources, installedOnly, query, visible, sort]);

  const toggleSource = (s: Source) =>
    setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  // Install-state is only known when a manager is injected (the launcher).
  const installedSet = useMemo(
    () => (actions ? new Set(games.filter((g) => isInstalled(g, actions))) : new Set<Game>()),
    [games, actions]
  );

  const counts = useMemo(
    () => ({
      all: games.length,
      installed: installedSet.size,
      bySource: Object.fromEntries(
        SOURCES.map((sm) => [sm.id, games.filter((g) => g.sources.includes(sm.id)).length])
      ) as Record<Source, number>,
    }),
    [games, installedSet]
  );

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const list = games.filter((g) => {
      // AND semantics: the game must be on EVERY selected platform.
      if (sources.length > 0 && !sources.every((s) => g.sources.includes(s))) return false;
      if (installedOnly && !installedSet.has(g)) return false;
      return g.title.toLowerCase().includes(q);
    });
    if (sort === 'playtime') {
      // Total across stores, most played first; untouched games at the end
      // fall back to the alphabetical order the API already provides.
      const minutes = (g: Game) =>
        g.entries.reduce((sum, e) => sum + (e.playtimeMinutes ?? 0), 0);
      list.sort((a, b) => minutes(b) - minutes(a) || a.title.localeCompare(b.title));
    }
    return list;
  }, [games, sources, installedOnly, query, installedSet, sort]);

  // Reset the visible window when the filter/search changes (but not on the
  // initial mount — a restored `visible` must survive coming back to the list).
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) setVisible(PAGE);
    else mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, installedOnly, query, sort]);

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

  const filterBtn = (active: boolean): React.CSSProperties => ({
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    cursor: 'pointer',
    background: active ? 'var(--accent)' : 'var(--panel)',
    color: active ? 'var(--on-accent)' : 'var(--text)',
    fontWeight: 600,
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        {/* "All" = no source conditions; highlighted when nothing is selected. */}
        <button onClick={() => setSources([])} style={filterBtn(sources.length === 0)}>
          {t('filter.all')} ({counts.all})
        </button>
        {SOURCES.map((sm) => (
          <button key={sm.id} onClick={() => toggleSource(sm.id)} style={filterBtn(sources.includes(sm.id))}>
            {sm.label} ({counts.bySource[sm.id] ?? 0})
          </button>
        ))}
        {/* "Installed" only makes sense where install-state is known (the launcher). */}
        {actions && (
          <button onClick={() => setInstalledOnly((v) => !v)} style={filterBtn(installedOnly)}>
            {t('filter.installed')} ({counts.installed})
          </button>
        )}

        <select
          aria-label={t('lib.sort')}
          value={sort}
          onChange={(e) => setSort(e.target.value as LibrarySort)}
          style={{ ...filterBtn(false), paddingRight: 8 }}
        >
          <option value="name">{t('lib.sort.name')}</option>
          <option value="playtime">{t('lib.sort.playtime')}</option>
        </select>

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
