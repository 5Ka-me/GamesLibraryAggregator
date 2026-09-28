import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api,
  useI18n,
  GameList,
  steamAppId,
  epicAppName,
  normalizeTitle,
  openDeepLink,
  useLibraryActions,
  isInstalled,
  SOURCES,
  type Game,
  type Source,
  type SteamRecentGame,
} from '@app/shared';
import { GameView } from './GameDetailsPage';
import { HomeIcon, ChevronDownIcon, SearchIcon } from '../components/icons';
import { useScrollRestore } from '../hooks/useScrollRestore';
import { TAG_CHIPS, chipMatches, profileFor, useProfiles, type TagChip } from '../hooks/useProfiles';
import { useCollections } from '../hooks/useCollections';
import CollectionMenu, { type MenuAnchor } from '../components/CollectionMenu';
import CollectionEditor from '../components/CollectionEditor';
import type { ResolvedCollection } from '../../../preload';

// Library. Two views, chosen in Settings:
//   list (default) — Steam-like split: the game list on the left (search,
//     store filter, Installed / All sections), and on the right either the
//     Home pane (recent shelf, installed row, numbers) or the selected game's
//     page. The selected game's key art sits behind the whole area.
//   grid — the previous layout: recent shelf + cover grid, cards open the
//     full-page game view.
// The selection lives in the URL (/library/<key>) so back/forward work.

export type LibraryView = 'list' | 'grid';
export const LIBRARY_VIEW_KEY = 'library:view';
export function getLibraryView(): LibraryView {
  try {
    return localStorage.getItem(LIBRARY_VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

/** Stable URL key for a game: Steam appid, else Epic app name, else the title. */
export function gameKey(g: Game): string {
  const s = g.entries.map(steamAppId).find((x): x is string => !!x);
  if (s) return `s-${s}`;
  const e = g.entries.map(epicAppName).find((x): x is string => !!x);
  if (e) return `e-${encodeURIComponent(e)}`;
  return `t-${encodeURIComponent(normalizeTitle(g.title))}`;
}

const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const firstSteamId = (g: Game): string | null => g.entries.map(steamAppId).find((x): x is string => !!x) ?? null;

// Module-level caches: navigating to a game and back renders instantly.
let cachedGames: Game[] | null = null;
let cachedRecent: SteamRecentGame[] | null = null;

const hours = (min: number): string => (min / 60 >= 100 ? Math.round(min / 60).toString() : (min / 60).toFixed(1));

// ---------- pieces ----------

/** Image with an ordered fallback chain (first URL that loads wins). */
const Fallback: React.FC<{ srcs: (string | null | undefined)[]; className?: string; style?: React.CSSProperties; alt?: string }> = ({ srcs, className, style, alt = '' }) => {
  const list = useMemo(() => srcs.filter((s): s is string => !!s), [srcs]);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [list]);
  const src = list[i];
  if (!src) return <span className={className} style={style} aria-hidden />;
  return <img src={src} alt={alt} className={className} style={style} loading="lazy" draggable={false} onError={() => setI((n) => n + 1)} />;
};

/** Key art of the selected game behind the whole library area, crossfading on change. */
const Backdrop: React.FC<{ game: Game | null }> = ({ game }) => {
  const [layers, setLayers] = useState<{ id: number; game: Game }[]>([]);
  useEffect(() => {
    if (!game) {
      setLayers([]);
      return;
    }
    const id = Date.now();
    setLayers((prev) => [...prev.slice(-1), { id, game }]);
    const timer = window.setTimeout(() => setLayers((prev) => prev.filter((l) => l.id === id)), 500);
    return () => window.clearTimeout(timer);
  }, [game]);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {layers.map((l) => {
        const sid = firstSteamId(l.game);
        return <Fallback key={l.id} className="backdrop-img" srcs={sid ? [`${CDN}/${sid}/library_hero.jpg`, `${CDN}/${sid}/header.jpg`] : [l.game.iconUrl]} />;
      })}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(22,29,41,0.05) 0%, rgba(22,29,41,0.55) 34%, rgba(22,29,41,0.92) 58%, var(--bg) 78%)' }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(19,25,34,0.7) 0%, rgba(19,25,34,0) 30%)' }} />
    </div>
  );
};

const RowIcon: React.FC<{ game: Game }> = ({ game }) => {
  const sid = firstSteamId(game);
  const small = game.entries.map((e) => e.smallIconUrl).find((x): x is string => !!x);
  return <Fallback className="ico" srcs={[small, sid ? `${CDN}/${sid}/header.jpg` : null, game.iconUrl]} />;
};

const Section: React.FC<{ title: string; count: number; open: boolean; onToggle: () => void; badge?: React.ReactNode; onEdit?: () => void; children: React.ReactNode }> = ({ title, count, open, onToggle, badge, onEdit, children }) => (
  <div>
    <div className={`lib-section${open ? '' : ' closed'}`} style={{ padding: 0 }}>
      <button className="lib-section" style={{ flex: 1, minWidth: 0 }} onClick={onToggle}>
        <span style={{ color: 'var(--muted)', display: 'flex' }}>
          <ChevronDownIcon size={10} />
        </span>
        <span className="uc-header" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {badge}
        <span className="uc-header" style={{ color: '#55657d' }}>{count}</span>
      </button>
      {onEdit && (
        <button className="lib-section-edit" onClick={onEdit} title="…">⋯</button>
      )}
    </div>
    {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{children}</div>}
  </div>
);

const LibraryList: React.FC<{
  games: Game[];
  selectedKey: string | null;
  onSelect: (g: Game) => void;
  onHome: () => void;
}> = ({ games, selectedKey, onSelect, onHome }) => {
  const { t } = useI18n();
  const actions = useLibraryActions();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<Source | 'all'>('all');
  const [openInstalled, setOpenInstalled] = useState(true);
  const [openAll, setOpenAll] = useState(true);
  const [chips, setChips] = useState<TagChip[]>([]);
  const [showChips, setShowChips] = useState(false);
  const profiles = useProfiles();
  const hasProfiles = Object.keys(profiles).length > 0;
  const col = useCollections();
  const [menu, setMenu] = useState<{ game: Game; anchor: MenuAnchor } | null>(null);
  const [editor, setEditor] = useState<ResolvedCollection | 'new' | null>(null);
  // Collapsed collection sections (Favorites and user collections start open, Hidden starts closed).
  const [closed, setClosed] = useState<Set<string>>(() => new Set(['hidden']));
  const toggleClosed = (id: string) => setClosed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const installedSet = useMemo(() => (actions ? new Set(games.filter((g) => isInstalled(g, actions))) : new Set<Game>()), [games, actions]);
  // Search, store and chip filters apply to every section alike; hidden games only appear in their own section.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return games.filter(
      (g) =>
        (source === 'all' || g.sources.includes(source)) &&
        (!q || g.title.toLowerCase().includes(q)) &&
        (chips.length === 0 || chips.every((c) => chipMatches(c, profileFor(profiles, g))))
    );
  }, [games, query, source, chips, profiles]);
  const filtered = useMemo(() => visible.filter((g) => !col.hiddenKeys.has(gameKey(g))), [visible, col.hiddenKeys]);
  const hiddenGames = useMemo(() => visible.filter((g) => col.hiddenKeys.has(gameKey(g))), [visible, col.hiddenKeys]);
  const favorites = useMemo(() => filtered.filter((g) => col.favoriteKeys.has(gameKey(g))), [filtered, col.favoriteKeys]);
  const byKey = useMemo(() => new Map(filtered.map((g) => [gameKey(g), g])), [filtered]);
  const collectionGames = (c: ResolvedCollection): Game[] => c.keys.map((k) => byKey.get(k)).filter((g): g is Game => !!g);
  const installed = filtered.filter((g) => installedSet.has(g));

  // Keep the selected row in view when the selection comes from the URL
  // (Home shelf, back/forward) rather than from a click in the list.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.lib-row.sel');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  const row = (g: Game, inst: boolean) => {
    const key = gameKey(g);
    const src = g.sources.includes('Steam') ? 'var(--accent)' : 'var(--epic)';
    return (
      <button
        key={key}
        className={`lib-row${inst ? ' inst' : ''}${key === selectedKey ? ' sel' : ''}`}
        onClick={() => onSelect(g)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ game: g, anchor: { x: e.clientX, y: e.clientY } });
        }}
        title={g.title}
      >
        <RowIcon game={g} />
        <span className="ttl">{g.title}</span>
        {col.favoriteKeys.has(key) && <span className="lib-fav">★</span>}
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: src, flex: '0 0 auto' }} />
      </button>
    );
  };
  const collectionBadge = (c: ResolvedCollection) =>
    c.origin === 'steam' ? (
      <span className="col-badge" title={t(c.edited ? 'col.steamEditedHint' : 'col.steamHint')}>
        Steam{c.edited ? ` · ${t('col.edited')}` : ''}
      </span>
    ) : c.kind === 'dynamic' ? (
      <span className="col-badge" title={t('col.kind.dynamicHint')}>ƒ</span>
    ) : undefined;

  return (
    <aside
      style={{
        position: 'relative',
        zIndex: 2,
        width: 280,
        flex: '0 0 280px',
        background: 'rgba(19,25,34,0.86)',
        backdropFilter: 'blur(10px)',
        borderRight: '1px solid rgba(35,47,66,0.9)',
        display: 'flex',
        flexDirection: 'column',
        padding: '10px 8px 8px 8px',
        minHeight: 0,
      }}
    >
      <button className={`lib-row${selectedKey === null ? ' sel' : ' inst'}`} style={{ height: 34, marginBottom: 8 }} onClick={onHome}>
        <span style={{ display: 'flex' }}>
          <HomeIcon />
        </span>
        <span className="ttl" style={{ fontWeight: 600, letterSpacing: 0.3 }}>{t('lib.home')}</span>
      </button>
      <div className="field-wrap" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', borderRadius: 8, background: 'var(--input-bg)', border: '1px solid var(--border)', color: '#6f8098', margin: '0 2px 8px 2px' }}>
        <SearchIcon />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('lib.searchLibrary')} style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: 0, fontSize: 13 }} />
        {query && <button className="field-clear" onClick={() => setQuery('')} title={t('chat.clear')}>✕</button>}
      </div>
      <div style={{ display: 'flex', gap: 5, margin: '0 2px 8px 2px' }}>
        <button className={`pill${source === 'all' ? ' pill-active' : ''}`} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setSource('all')}>{t('filter.all')}</button>
        {SOURCES.map((s) => (
          <button key={s.id} className={`pill${source === s.id ? ' pill-active' : ''}`} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setSource(source === s.id ? 'all' : s.id)}>
            {s.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {hasProfiles && (
          <button className={`pill${chips.length ? ' pill-active' : ''}`} style={{ padding: '5px 9px', fontSize: 12 }} onClick={() => setShowChips((v) => !v)} title={t('tag.aiEstimate')}>
            {showChips ? '▾' : '▸'} {t('lib.filters')}{chips.length ? ` · ${chips.length}` : ''}
          </button>
        )}
        <button className="pill" style={{ padding: '5px 9px', fontSize: 12 }} onClick={() => setEditor('new')} title={t('col.newCollection')}>+</button>
      </div>
      {hasProfiles && showChips && (
        <div className="rise" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '0 2px 12px 2px' }} title={t('tag.aiEstimate')}>
          {TAG_CHIPS.map((c) => (
            <button key={c} className={`pill${chips.includes(c) ? ' pill-active' : ''}`} style={{ padding: '3px 8px', fontSize: 11.5 }} onClick={() => setChips((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))}>
              {t(`tag.chip.${c}`)}
            </button>
          ))}
        </div>
      )}

      <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {favorites.length > 0 && (
          <Section title={`★ ${t('col.favorites')}`} count={favorites.length} open={!closed.has('favorite')} onToggle={() => toggleClosed('favorite')}>
            {favorites.map((g) => row(g, installedSet.has(g)))}
          </Section>
        )}
        {col.custom.map((c) => {
          const list = collectionGames(c);
          if (list.length === 0 && query.trim()) return null;
          return (
            <Section key={c.id} title={c.name} count={list.length} open={!closed.has(c.id)} onToggle={() => toggleClosed(c.id)} badge={collectionBadge(c)} onEdit={() => setEditor(c)}>
              {list.length === 0 ? <p style={{ margin: '2px 10px 4px', fontSize: 12, color: 'var(--muted)' }}>{t(c.kind === 'dynamic' ? 'col.emptyDynamic' : 'col.emptyManual')}</p> : list.map((g) => row(g, installedSet.has(g)))}
            </Section>
          );
        })}
        {installed.length > 0 && (
          <Section title={t('lib.installedSection')} count={installed.length} open={openInstalled} onToggle={() => setOpenInstalled((v) => !v)}>
            {installed.map((g) => row(g, true))}
          </Section>
        )}
        <Section title={t('lib.allSection')} count={filtered.length} open={openAll} onToggle={() => setOpenAll((v) => !v)}>
          {filtered.map((g) => row(g, installedSet.has(g)))}
        </Section>
        {hiddenGames.length > 0 && (
          <Section title={t('col.hidden')} count={hiddenGames.length} open={!closed.has('hidden')} onToggle={() => toggleClosed('hidden')}>
            {hiddenGames.map((g) => row(g, installedSet.has(g)))}
          </Section>
        )}
      </div>
      {menu && <CollectionMenu game={menu.game} anchor={menu.anchor} onClose={() => setMenu(null)} />}
      {editor && <CollectionEditor existing={editor === 'new' ? null : editor} onClose={() => setEditor(null)} />}
    </aside>
  );
};

/** Steam-style "Recent" shelf: last-2-weeks games matched to the library. */
const RecentShelf: React.FC<{ recent: SteamRecentGame[]; games: Game[]; onOpen: (g: Game) => void; wide?: boolean }> = ({ recent, games, onOpen, wide }) => {
  const { t } = useI18n();
  const actions = useLibraryActions();
  const byAppId = useMemo(() => {
    const m = new Map<string, Game>();
    for (const g of games) for (const e of g.entries) {
      const id = steamAppId(e);
      if (id) m.set(id, g);
    }
    return m;
  }, [games]);
  const rows = recent.map((r) => ({ recent: r, game: byAppId.get(String(r.appId)) ?? null })).slice(0, wide ? 4 : 3);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <span className="uc-header">{t('lib.recent')}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('lib.recentNote')}</span>
      </div>
      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{t('lib.emptyRecent')}</p>
      ) : (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {rows.map(({ recent: r, game }) => {
            const steamEntry = game?.entries.find((e) => e.source === 'Steam');
            const installed = actions?.getSteamState(String(r.appId)).installed ?? false;
            return (
              <div key={r.appId} className="shelf-card" onClick={() => game && onOpen(game)}>
                <img src={`${CDN}/${r.appId}/header.jpg`} alt={r.name} loading="lazy" draggable={false} style={{ width: '100%', height: 150, objectFit: 'cover', display: 'block' }} />
                <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('lib.recent2w', { h: Math.round(r.playtime2Weeks / 6) / 10 })}</div>
                  </div>
                  {installed && steamEntry?.launchUrl ? (
                    <button className="btn-play" onClick={(e) => { e.stopPropagation(); openDeepLink(steamEntry.launchUrl!); }}>
                      ▶ {t('card.play')}
                    </button>
                  ) : steamEntry?.installUrl ? (
                    <button className="pill" onClick={(e) => { e.stopPropagation(); openDeepLink(steamEntry.installUrl!); }}>
                      ⬇ {t('card.install')}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const HomePane: React.FC<{ games: Game[]; recent: SteamRecentGame[]; onOpen: (g: Game) => void }> = ({ games, recent, onOpen }) => {
  const { t } = useI18n();
  const actions = useLibraryActions();
  const navigate = useNavigate();
  const installed = useMemo(() => (actions ? games.filter((g) => isInstalled(g, actions)) : []), [games, actions]);
  const stats = useMemo(() => {
    const minutes = games.reduce((s, g) => s + g.entries.reduce((x, e) => x + (e.playtimeMinutes ?? 0), 0), 0);
    const played = games.filter((g) => g.entries.some((e) => (e.playtimeMinutes ?? 0) > 0)).length;
    const steam = games.filter((g) => g.sources.includes('Steam')).length;
    const epic = games.filter((g) => g.sources.includes('Epic')).length;
    return { minutes, played, steam, epic, backlog: games.length - played };
  }, [games]);
  const tile = (label: string, value: string, sub?: string) => (
    <div style={{ flex: '1 1 140px', minWidth: 140, padding: '14px 16px', borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--border)' }}>
      <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ padding: '26px 36px', display: 'flex', flexDirection: 'column', gap: 26 }}>
      <div className="rise"><RecentShelf recent={recent} games={games} onOpen={onOpen} wide /></div>
      <div className="rise rise-2">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
          <span className="uc-header">{t('lib.installedSection')}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{installed.length}</span>
        </div>
        {installed.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{t('lib.noInstalled')}</p>
        ) : (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {installed.map((g) => {
              const sid = firstSteamId(g);
              return (
                <div key={gameKey(g)} className="mini-cap" onClick={() => onOpen(g)} title={g.title}>
                  <Fallback srcs={[sid ? `${CDN}/${sid}/header.jpg` : null, g.iconUrl]} />
                  <div className="cap">{g.title}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="rise rise-3">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
          <span className="uc-header">{t('lib.numbers')}</span>
          <a href="#/stats" onClick={(e) => { e.preventDefault(); navigate('/stats'); }} style={{ fontSize: 12, textDecoration: 'none' }}>{t('lib.allStats')}</a>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {tile(t('stats.games'), String(games.length), `${stats.steam} Steam · ${stats.epic} EGS`)}
          {tile(t('stats.hours'), hours(stats.minutes), stats.played ? t('stats.avgPerPlayed', { h: hours(stats.minutes / stats.played) }) : undefined)}
          {tile(t('stats.played'), String(stats.played), `${games.length ? Math.round((stats.played / games.length) * 100) : 0}%`)}
          {tile(t('stats.backlog'), String(stats.backlog), t('stats.backlogSub', { p: games.length ? Math.round((stats.backlog / games.length) * 100) : 0 }))}
        </div>
      </div>
    </div>
  );
};

// ---------- page ----------

const LibraryPage: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { key } = useParams<{ key: string }>();
  const [view] = useState<LibraryView>(getLibraryView);
  const [gridChips, setGridChips] = useState<TagChip[]>([]);
  const [showGridChips, setShowGridChips] = useState(false);
  const [gridCollection, setGridCollection] = useState<string>('');
  const profiles = useProfiles();
  const col = useCollections();
  const gridFilter = useMemo(() => {
    const selected = gridCollection ? col.collections.find((c) => c.id === gridCollection) : null;
    const keys = selected ? new Set(selected.keys) : null;
    const hidden = col.hiddenKeys;
    const showHidden = selected?.system === 'hidden';
    return (g: Game) => {
      const k = gameKey(g);
      if (!showHidden && hidden.has(k)) return false;
      if (keys && !keys.has(k)) return false;
      return gridChips.length === 0 || gridChips.every((c) => chipMatches(c, profileFor(profiles, g)));
    };
  }, [gridChips, profiles, gridCollection, col.collections, col.hiddenKeys]);
  const [games, setGames] = useState<Game[]>(cachedGames ?? []);
  const [recent, setRecent] = useState<SteamRecentGame[]>(cachedRecent ?? []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(cachedGames === null);

  useScrollRestore('library', view === 'grid' && !loading && games.length > 0);

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
    api
      .getSteamRecent()
      .then((r) => {
        cachedRecent = r;
        setRecent(r);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
    return window.launcher.onLibraryChanged(() => void load());
  }, [load]);

  const selected = useMemo(() => (key ? games.find((g) => gameKey(g) === key) ?? null : null), [games, key]);
  const open = (g: Game) => navigate(`/library/${gameKey(g)}`);

  const errorBox = error && (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#ff6b6b', background: 'var(--panel-2)', padding: '8px 10px', borderRadius: 6, margin: 16 }}>
      <span style={{ flex: 1 }}>{t('lib.error')}: {error}</span>
      <button className="pill" onClick={() => { setLoading(true); void load(); }}>↻</button>
    </div>
  );

  if (view === 'grid') {
    return (
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 24px' }}>
        {errorBox}
        {loading ? (
          <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>
        ) : (
          <>
            <div style={{ marginBottom: 26 }}>
              <RecentShelf recent={recent} games={games} onOpen={(g) => navigate('/game', { state: { game: g } })} />
            </div>
            <GameList
              games={games}
              stateKey="library"
              extraFilter={gridFilter}
              extraControls={
                <>
                  {col.collections.length > 0 && (
                    <select aria-label={t('col.collections')} value={gridCollection} onChange={(e) => setGridCollection(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)', fontWeight: 600 }}>
                      <option value="">{t('col.allGames')}</option>
                      {col.favoriteKeys.size > 0 && <option value="favorite">★ {t('col.favorites')}</option>}
                      {col.custom.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}{c.origin === 'steam' ? ' · Steam' : ''}</option>
                      ))}
                      {col.hiddenKeys.size > 0 && <option value="hidden">{t('col.hidden')}</option>}
                    </select>
                  )}
                {Object.keys(profiles).length > 0 && (
                  <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginLeft: 6, alignItems: 'center' }} title={t('tag.aiEstimate')}>
                    <button className={`pill${gridChips.length ? ' pill-active' : ''}`} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setShowGridChips((v) => !v)}>
                      {showGridChips ? '▾' : '▸'} {t('lib.filters')}{gridChips.length ? ` · ${gridChips.length}` : ''}
                    </button>
                    {showGridChips && TAG_CHIPS.map((c) => (
                      <button key={c} className={`pill${gridChips.includes(c) ? ' pill-active' : ''}`} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setGridChips((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))}>
                        {t(`tag.chip.${c}`)}
                      </button>
                    ))}
                  </span>
                )}
                </>
              }
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <Backdrop game={selected} />
      <LibraryList games={games} selectedKey={selected ? key ?? null : null} onSelect={open} onHome={() => navigate('/')} />
      <section style={{ position: 'relative', zIndex: 2, flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {errorBox}
        {loading ? (
          <p style={{ color: 'var(--muted)', padding: 24 }}>{t('lib.loading')}</p>
        ) : selected ? (
          <GameView key={key} appid={firstSteamId(selected) ? parseInt(firstSteamId(selected)!, 10) : null} game={selected} embedded />
        ) : (
          <HomePane games={games} recent={recent} onOpen={open} />
        )}
      </section>
    </div>
  );
};

export default LibraryPage;
