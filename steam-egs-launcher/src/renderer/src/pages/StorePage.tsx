import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useI18n } from '@app/shared';
import type { StoreHome, StoreItem, StoreSection, WishlistEntry, WishlistItem } from '../../../preload';
import { ctl, ItemCard, SectionBlock, useOwnership } from '../store/parts';
import { useScrollRestore } from '../hooks/useScrollRestore';

// In-app Steam store: front page (featured + specials + top sellers + new
// releases + coming soon + spotlights), wishlist with Steam-like filters, and
// live search (as-you-type, debounced). Sections link to full paginated pages.
//
// The wishlist renders incrementally (sentinel-driven pages) and hydrates
// name/price metadata lazily in batches. All storefront data is cached in the
// main process (LAUNCHER_STORE_CACHE_TTL, default 300 s); ↻ bypasses the cache.

type Tab = 'home' | 'wishlist';
type WlSort = 'rank' | 'date' | 'name' | 'price' | 'discount';

const WL_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_MIN_CHARS = 2;

// Sections that have a dedicated full page (matches sectionFilter in main).
const SECTION_PAGES = new Set(['specials', 'top_sellers', 'new_releases', 'coming_soon', 'under_budget']);

// UI state that survives navigating away and back (data itself is cached in
// the main process, so only the view state needs to live here).
interface StoreUiState {
  tab: Tab;
  query: string;
  results: StoreItem[] | null;
  visible: number;
  wlSort: WlSort;
  wlDiscountOnly: boolean;
  wlFilter: string;
}
let savedUi: StoreUiState | null = null;

// Sections created launcher-side (budget/genres) come with an empty name — the
// display name is resolved from i18n by section id.
function sectionFallbackName(id: string, tr: (k: string) => string): string {
  if (id === 'featured') return tr('store.featuredSection');
  if (id.startsWith('genre-')) return tr(`store.genre.${id.slice('genre-'.length)}`);
  return tr(`store.section.${id}`);
}

// Personalized rows carry the raw tag/game name in `name` — the full heading
// is localized here.
function personalTitle(s: StoreSection, tr: (k: string, vars?: Record<string, string>) => string): string {
  if (s.id === 'personal-discovery') return tr('store.personal.discovery');
  if (s.id.startsWith('personal-tag-')) return tr('store.personal.becauseTag', { tag: s.name });
  if (s.id.startsWith('personal-game-')) return tr('store.personal.becausePlayed', { game: s.name });
  return s.name;
}

const StorePage: React.FC = () => {
  const { t, lang } = useI18n();
  const own = useOwnership();

  const [tab, setTab] = useState<Tab>(savedUi?.tab ?? 'home');

  // Live search (overlays the current tab while a query result is shown).
  const [query, setQuery] = useState(savedUi?.query ?? '');
  const [results, setResults] = useState<StoreItem[] | null>(savedUi?.results ?? null);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  // Front page.
  const [home, setHome] = useState<StoreHome | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  // Personalized rows (empty when not signed in to Steam).
  const [personal, setPersonal] = useState<StoreSection[]>([]);

  // Wishlist: raw entries + lazily hydrated metadata + windowed rendering.
  const [entries, setEntries] = useState<WishlistEntry[] | null>(null);
  const [meta, setMeta] = useState<Record<number, StoreItem>>({});
  const [visible, setVisible] = useState(savedUi?.visible ?? WL_PAGE);
  const [wlError, setWlError] = useState<string | null>(null);
  const [wlSort, setWlSort] = useState<WlSort>(savedUi?.wlSort ?? 'rank');
  const [wlDiscountOnly, setWlDiscountOnly] = useState(savedUi?.wlDiscountOnly ?? false);
  const [wlFilter, setWlFilter] = useState(savedUi?.wlFilter ?? '');
  const inFlight = useRef<Set<number>>(new Set());
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Persist the view state for the next visit.
  useEffect(() => {
    savedUi = { tab, query, results, visible, wlSort, wlDiscountOnly, wlFilter };
  }, [tab, query, results, visible, wlSort, wlDiscountOnly, wlFilter]);

  // Scroll restoration: ready once the active view has rendered its content.
  const scrollReady = results !== null ? true : tab === 'home' ? home !== null : entries !== null;
  useScrollRestore('store', scrollReady);

  useEffect(() => {
    setHome(null);
    setHomeError(null);
    setMeta({}); // metadata is localized — refetch on language change
    window.launcher
      .storeHome(lang)
      .then(setHome)
      .catch((e) => setHomeError(e instanceof Error ? e.message : String(e)));
    window.launcher
      .storePersonal(lang)
      .then(setPersonal)
      .catch(() => setPersonal([]));
  }, [lang]);

  // Debounced as-you-type search. A sequence counter drops stale responses
  // (a slow earlier request must not overwrite a newer one).
  useEffect(() => {
    const term = query.trim();
    const seq = ++searchSeq.current;
    if (term.length < SEARCH_MIN_CHARS) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const items = await window.launcher.storeSearch(term, lang);
        if (searchSeq.current === seq) setResults(items);
      } catch {
        if (searchSeq.current === seq) setResults([]);
      } finally {
        if (searchSeq.current === seq) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, lang]);

  const clearSearch = () => setQuery('');

  const loadWishlist = useCallback(
    async (force = false) => {
      setEntries(null);
      setWlError(null);
      setVisible(WL_PAGE);
      if (force) setMeta({});
      try {
        const acc = await api.getSteamAccount();
        if (!acc.configured || !acc.steamId) {
          setWlError(t('store.needSteam'));
          return;
        }
        setEntries(await window.launcher.storeWishlist(acc.steamId, force));
      } catch (e) {
        setWlError(e instanceof Error ? e.message : String(e));
      }
    },
    [t]
  );

  useEffect(() => {
    if (tab === 'wishlist' && entries === null && !wlError) loadWishlist();
  }, [tab, entries, wlError, loadWishlist]);

  // Name/price/discount sorting and the discount filter need metadata for the
  // whole list; rank/date only need it for the rendered window.
  const needsFullMeta = wlDiscountOnly || wlSort === 'name' || wlSort === 'price' || wlSort === 'discount';

  const merged: WishlistItem[] = useMemo(
    () =>
      (entries ?? []).map((e) => ({
        ...(meta[e.appid] ?? { appid: e.appid, name: `App ${e.appid}`, image: null }),
        priority: e.priority,
        dateAdded: e.dateAdded,
      })),
    [entries, meta]
  );

  const wlShown = useMemo(() => {
    let arr = [...merged];
    if (wlDiscountOnly) arr = arr.filter((i) => (i.price?.discountPct ?? 0) > 0);
    if (wlFilter.trim()) {
      const q = wlFilter.trim().toLowerCase();
      arr = arr.filter((i) => i.name.toLowerCase().includes(q));
    }
    switch (wlSort) {
      case 'rank':
        arr.sort(
          (a, b) =>
            (a.priority || Number.MAX_SAFE_INTEGER) - (b.priority || Number.MAX_SAFE_INTEGER) ||
            b.dateAdded - a.dateAdded
        );
        break;
      case 'date':
        arr.sort((a, b) => b.dateAdded - a.dateAdded);
        break;
      case 'name':
        arr.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'price':
        arr.sort((a, b) => (a.price?.final ?? 0) - (b.price?.final ?? 0));
        break;
      case 'discount':
        arr.sort((a, b) => (b.price?.discountPct ?? 0) - (a.price?.discountPct ?? 0));
        break;
    }
    return arr;
  }, [merged, wlSort, wlDiscountOnly, wlFilter]);

  const shownSlice = wlShown.slice(0, visible);

  // Lazy hydration: fetch metadata for whatever needs it (the rendered window,
  // or everything when a meta-dependent sort/filter is active). The effect
  // re-runs as `meta` fills up, draining one batch at a time.
  useEffect(() => {
    if (tab !== 'wishlist' || !entries) return;
    const targets = needsFullMeta ? entries.map((e) => e.appid) : shownSlice.map((i) => i.appid);
    const missing = targets.filter((id) => !meta[id] && !inFlight.current.has(id)).slice(0, 100);
    if (!missing.length) return;

    missing.forEach((id) => inFlight.current.add(id));
    window.launcher
      .storeItemsMeta(missing, lang)
      .then((res) => setMeta((prev) => ({ ...prev, ...res })))
      .catch(() => undefined)
      .finally(() => missing.forEach((id) => inFlight.current.delete(id)));
  }, [tab, entries, shownSlice, meta, needsFullMeta, lang]);

  // Windowed rendering: grow the window when the sentinel scrolls into view.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es[0].isIntersecting) setVisible((v) => (v < wlShown.length ? v + WL_PAGE : v));
      },
      { rootMargin: '600px' }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [wlShown.length]);

  // Reset the window on filter changes — but not on mount, where a restored
  // `visible` must survive.
  const wlMounted = useRef(false);
  useEffect(() => {
    if (wlMounted.current) setVisible(WL_PAGE);
    else wlMounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wlSort, wlDiscountOnly, wlFilter]);

  const hydrating = needsFullMeta && entries ? entries.some((e) => !meta[e.appid]) : false;

  const sortOptions: { key: WlSort; label: string }[] = [
    { key: 'rank', label: t('store.wl.sort.rank') },
    { key: 'date', label: t('store.wl.sort.date') },
    { key: 'name', label: t('store.wl.sort.name') },
    { key: 'price', label: t('store.wl.sort.price') },
    { key: 'discount', label: t('store.wl.sort.discount') },
  ];

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      {/* Header row: tabs + live search */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
        {(['home', 'wishlist'] as Tab[]).map((k) => (
          <button
            key={k}
            onClick={() => {
              setTab(k);
              clearSearch();
            }}
            style={{
              ...ctl,
              background: tab === k && !results ? 'var(--accent)' : 'var(--panel)',
              color: tab === k && !results ? 'var(--on-accent)' : 'var(--text)',
            }}
          >
            {k === 'home' ? t('store.home') : t('store.wishlist')}
          </button>
        ))}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {searching && <span style={{ color: 'var(--muted)', fontSize: 13 }}>…</span>}
          <input
            placeholder={t('store.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ minWidth: 260 }}
          />
          {query && (
            <button style={ctl} onClick={clearSearch}>
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Search results override the tab content */}
      {results ? (
        <section>
          <h3 style={{ margin: '0 0 10px' }}>{t('store.results')}</h3>
          {results.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>{t('store.noResults')}</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {results.map((it, i) => (
                <ItemCard key={`${it.appid}-${i}`} item={it} own={own} />
              ))}
            </div>
          )}
        </section>
      ) : tab === 'home' ? (
        <>
          {homeError && <p style={{ color: '#ff6b6b' }}>{t('common.error')}: {homeError}</p>}
          {!home && !homeError && <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>}
          {/* Featured carousel first, then the personalized rows, then the rest */}
          {home?.sections
            .filter((s) => s.id === 'featured')
            .map((s) => (
              <SectionBlock
                key={s.id}
                name={s.name || sectionFallbackName(s.id, t as (k: string) => string)}
                banner={s.banner}
                items={s.items}
                own={own}
              />
            ))}
          {home &&
            personal.map((s) => (
              <SectionBlock
                key={s.id}
                name={personalTitle(s, t as (k: string, vars?: Record<string, string>) => string)}
                items={s.items}
                own={own}
              />
            ))}
          {home?.sections
            .filter((s) => s.id !== 'featured')
            .map((s) => (
              <SectionBlock
                key={s.id}
                name={s.name || sectionFallbackName(s.id, t as (k: string) => string)}
                banner={s.banner}
                items={s.items}
                own={own}
                moreTo={SECTION_PAGES.has(s.id) ? `/store/section/${s.id}` : undefined}
              />
            ))}
        </>
      ) : (
        <>
          {/* Wishlist filter bar */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              {t('store.wl.sort')}
              <select value={wlSort} onChange={(e) => setWlSort(e.target.value as WlSort)} style={ctl}>
                {sortOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={wlDiscountOnly}
                onChange={(e) => setWlDiscountOnly(e.target.checked)}
              />
              {t('store.wl.discountOnly')}
            </label>
            <input
              placeholder={t('store.wl.filter')}
              value={wlFilter}
              onChange={(e) => setWlFilter(e.target.value)}
              style={{ minWidth: 200 }}
            />
            <button style={ctl} onClick={() => loadWishlist(true)} title="↻">
              ↻
            </button>
            {hydrating && <span style={{ color: 'var(--muted)', fontSize: 13 }}>{t('lib.loading')}</span>}
          </div>

          {wlError && <p style={{ color: 'var(--muted)' }}>{wlError}</p>}
          {!entries && !wlError && <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>}
          {entries && entries.length === 0 && <p style={{ color: 'var(--muted)' }}>{t('store.wl.empty')}</p>}
          {entries && wlShown.length > 0 && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {shownSlice.map((it) => (
                  <ItemCard key={it.appid} item={it} own={own} />
                ))}
              </div>
              <div ref={sentinelRef} style={{ height: 1 }} />
            </>
          )}
        </>
      )}
    </div>
  );
};

export default StorePage;
