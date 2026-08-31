import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useI18n } from '@app/shared';
import type { StoreHome, StoreItem, StoreSection, WishlistEntry, WishlistItem } from '../../../preload';
import {
  applyOwnedFilter,
  ctl,
  hideOwnedStore,
  ItemCard,
  PriceTag,
  SectionBlock,
  useOwnership,
} from '../store/parts';
import { useScrollRestore } from '../hooks/useScrollRestore';

// In-app Steam store: front page (featured + specials + top sellers + new
// releases + coming soon + spotlights), wishlist with Steam-like filters, and
// live search (as-you-type, debounced). Sections link to full paginated pages.
//
// The wishlist renders incrementally (sentinel-driven pages) and hydrates
// name/price metadata lazily in batches. All storefront data is cached in the
// main process (LAUNCHER_STORE_CACHE_TTL, default 1 h, SWR); ↻ bypasses the cache.

type Tab = 'home' | 'wishlist' | 'discovery';
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
  if (s.id === 'personal-popular-new') return tr('store.personal.popularNew');
  if (s.id.startsWith('personal-tag-')) return tr('store.personal.becauseTag', { tag: s.name });
  if (s.id.startsWith('personal-game-')) return tr('store.personal.becausePlayed', { game: s.name });
  return s.name;
}

// ---------- Discovery Queue (one game at a time, Steam-style) ----------

// Survives tab switches / navigation; a queue is generated ONLY when the user
// clicks the button (each generation consumes a queue on the Steam side).
let savedDq: { items: StoreItem[]; index: number; added: number[] } = {
  items: [],
  index: 0,
  added: [],
};

const DqImage: React.FC<{ item: StoreItem }> = ({ item }) => {
  const header = `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appid}/header.jpg`;
  const [src, setSrc] = useState(header);
  useEffect(() => setSrc(header), [header]);
  return (
    <img
      src={src}
      alt={item.name}
      onError={() => item.image && src !== item.image && setSrc(item.image)}
      style={{ width: '100%', maxWidth: 640, borderRadius: 10, display: 'block' }}
    />
  );
};

const DiscoveryView: React.FC = () => {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [items, setItems] = useState<StoreItem[]>(savedDq.items);
  const [index, setIndex] = useState(savedDq.index);
  const [added, setAdded] = useState<Set<number>>(new Set(savedDq.added));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    savedDq = { items, index, added: [...added] };
  }, [items, index, added]);

  const generate = async () => {
    setBusy(true);
    setNote(null);
    try {
      const queue = await window.launcher.steamDiscoveryQueue(lang);
      if (!queue.length) setNote(t('store.dq.needLogin'));
      else {
        setItems(queue);
        setIndex(0);
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const wishlist = async (appid: number) => {
    setBusy(true);
    setNote(null);
    const ok = await window.launcher.steamAddToWishlist(appid).catch(() => false);
    setBusy(false);
    if (ok) setAdded((prev) => new Set(prev).add(appid));
    else setNote(t('store.dq.wishlistFail'));
  };

  const generateBtn = (
    <button
      style={{ ...ctl, background: 'var(--accent)', color: 'var(--on-accent)' }}
      disabled={busy}
      onClick={generate}
    >
      {busy ? '…' : t('store.dq.start')}
    </button>
  );

  const current = items[index];

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      {items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <p style={{ color: 'var(--muted)', marginBottom: 16 }}>{t('store.dq.empty')}</p>
          {generateBtn}
        </div>
      ) : !current ? (
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <p style={{ color: 'var(--muted)', marginBottom: 16 }}>{t('store.dq.finished')}</p>
          {generateBtn}
        </div>
      ) : (
        <>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 10 }}>
            {index + 1} / {items.length}
          </div>
          <DqImage item={current} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 14 }}>
            <h3 style={{ margin: 0, flex: 1, minWidth: 0 }}>{current.name}</h3>
            <PriceTag item={current} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            {added.has(current.appid) ? (
              <button style={{ ...ctl, opacity: 0.7 }} disabled>
                ✓ {t('store.dq.inWishlist')}
              </button>
            ) : (
              <button style={ctl} disabled={busy} onClick={() => wishlist(current.appid)}>
                ＋ {t('store.dq.addWishlist')}
              </button>
            )}
            <button style={ctl} onClick={() => navigate(`/store/app/${current.appid}`)}>
              {t('store.dq.details')}
            </button>
            <button
              style={{ ...ctl, background: 'var(--accent)', color: 'var(--on-accent)', marginLeft: 'auto' }}
              onClick={() => setIndex((i) => i + 1)}
            >
              {t('store.dq.next')} →
            </button>
          </div>
        </>
      )}
      {note && <p style={{ color: 'var(--muted)', marginTop: 14 }}>{note}</p>}
    </div>
  );
};

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
  const [hideOwned, setHideOwned] = useState(hideOwnedStore.get());

  // Wishlist: raw entries + lazily hydrated metadata + windowed rendering.
  const [entries, setEntries] = useState<WishlistEntry[] | null>(null);
  const [meta, setMeta] = useState<Record<number, StoreItem>>({});
  const [visible, setVisible] = useState(savedUi?.visible ?? WL_PAGE);
  const [wlError, setWlError] = useState<string | null>(null);
  const [wlSort, setWlSort] = useState<WlSort>(savedUi?.wlSort ?? 'rank');
  const [wlDiscountOnly, setWlDiscountOnly] = useState(savedUi?.wlDiscountOnly ?? false);
  const [wlFilter, setWlFilter] = useState(savedUi?.wlFilter ?? '');
  /** Appids already requested — including ones Steam couldn't resolve. */
  const attemptedMeta = useRef<Set<number>>(new Set());
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Persist the view state for the next visit.
  useEffect(() => {
    savedUi = { tab, query, results, visible, wlSort, wlDiscountOnly, wlFilter };
  }, [tab, query, results, visible, wlSort, wlDiscountOnly, wlFilter]);

  // Scroll restoration: ready once the active view has rendered its content.
  const scrollReady =
    results !== null
      ? true
      : tab === 'home'
        ? home !== null
        : tab === 'wishlist'
          ? entries !== null
          : true; // discovery renders immediately
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

  // A load in flight; also what keeps the auto-load effect from firing a
  // second, non-forced request while ↻ is running (they used to race, and the
  // cached response could win).
  const wlLoading = useRef(false);
  const [wlMsg, setWlMsg] = useState<string | null>(null);

  const removeFromWishlist = useCallback(
    async (appid: number) => {
      setWlMsg(null);
      const ok = await window.launcher.steamRemoveFromWishlist(appid).catch(() => false);
      if (ok) setEntries((prev) => prev?.filter((e) => e.appid !== appid) ?? prev);
      else setWlMsg(t('store.wl.removeFail'));
    },
    [t]
  );

  const loadWishlist = useCallback(
    async (force = false) => {
      if (wlLoading.current) return;
      wlLoading.current = true;
      setEntries(null);
      setWlError(null);
      setVisible(WL_PAGE);
      if (force) {
        setMeta({});
        attemptedMeta.current.clear();
      }
      try {
        const acc = await api.getSteamAccount();
        if (!acc.configured || !acc.steamId) {
          setWlError(t('store.needSteam'));
          return;
        }
        setEntries(await window.launcher.storeWishlist(acc.steamId, force));
      } catch (e) {
        setWlError(e instanceof Error ? e.message : String(e));
      } finally {
        wlLoading.current = false;
      }
    },
    [t]
  );

  useEffect(() => {
    if (tab === 'wishlist' && entries === null && !wlError && !wlLoading.current) void loadWishlist();
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
    // `attemptedMeta` (not just `meta`) is the stop condition: Steam omits
    // delisted appids from its response, so they never land in `meta` and
    // would otherwise be re-requested on every render, forever.
    const missing = targets
      .filter((id) => !meta[id] && !attemptedMeta.current.has(id))
      .slice(0, 100);
    if (!missing.length) return;

    missing.forEach((id) => attemptedMeta.current.add(id));
    window.launcher
      .storeItemsMeta(missing, lang)
      .then((res) => setMeta((prev) => ({ ...prev, ...res })))
      .catch(() => {
        // Transient failure — allow a retry on the next pass.
        missing.forEach((id) => attemptedMeta.current.delete(id));
      });
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
        {/* Steam-style segmented tab group */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            background: 'var(--input-bg)',
            border: '1px solid var(--border)',
            borderRadius: 9,
            padding: 4,
          }}
        >
          {(['home', 'wishlist', 'discovery'] as Tab[]).map((k) => {
            const active = tab === k && !results;
            return (
              <button
                key={k}
                onClick={() => {
                  setTab(k);
                  clearSearch();
                }}
                style={{
                  padding: '7px 18px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13.5,
                  fontWeight: active ? 700 : 600,
                  background: active ? 'linear-gradient(180deg, #2b3d59, #24344c)' : 'transparent',
                  color: active ? '#ffffff' : '#8ea0b8',
                }}
              >
                {k === 'home' ? t('store.home') : k === 'wishlist' ? t('store.wishlist') : t('store.dq.tab')}
              </button>
            );
          })}
        </div>

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

      {/* "Hide owned" — applies to the home feed and search results */}
      {(tab === 'home' || results) && (
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 16, cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            checked={hideOwned}
            onChange={(e) => {
              setHideOwned(e.target.checked);
              hideOwnedStore.set(e.target.checked);
            }}
          />
          {t('store.hideOwned')}
        </label>
      )}

      {/* Search results override the tab content */}
      {results ? (
        (() => {
          const shown = applyOwnedFilter(results, own, hideOwned);
          return (
            <section>
              <h3 style={{ margin: '0 0 10px' }}>{t('store.results')}</h3>
              {shown.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>{t('store.noResults')}</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {shown.map((it, i) => (
                    <ItemCard key={`${it.appid}-${i}`} item={it} own={own} />
                  ))}
                </div>
              )}
            </section>
          );
        })()
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
                hideOwned={hideOwned}
              />
            ))}
          {home &&
            personal.map((s) => (
              <SectionBlock
                key={s.id}
                name={personalTitle(s, t as (k: string, vars?: Record<string, string>) => string)}
                items={s.items}
                own={own}
                hideOwned={hideOwned}
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
                hideOwned={hideOwned}
                moreTo={SECTION_PAGES.has(s.id) ? `/store/section/${s.id}` : undefined}
              />
            ))}
        </>
      ) : tab === 'discovery' ? (
        <DiscoveryView />
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
          {wlMsg && <p style={{ color: '#e0a458' }}>{wlMsg}</p>}
          {!entries && !wlError && <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>}
          {entries && entries.length === 0 && <p style={{ color: 'var(--muted)' }}>{t('store.wl.empty')}</p>}
          {entries && wlShown.length > 0 && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {shownSlice.map((it) => (
                  <div key={it.appid} style={{ position: 'relative' }}>
                    <ItemCard item={it} own={own} />
                    <button
                      aria-label={t('store.wl.remove')}
                      title={t('store.wl.remove')}
                      onClick={() => void removeFromWishlist(it.appid)}
                      style={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        border: 'none',
                        background: 'rgba(0,0,0,.55)',
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: 12,
                        lineHeight: 1,
                      }}
                    >
                      ✕
                    </button>
                  </div>
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
