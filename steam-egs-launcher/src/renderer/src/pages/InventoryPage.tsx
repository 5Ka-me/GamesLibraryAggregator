import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '@app/shared';
import type { CardSetsState, InvAppData, InvOverview, InvPrice } from '../../../preload';
import { CardSetsView, FacetPanel, ItemDrawer, ItemRow, ItemTile, TAG_SEP, makeStack, priceKey, stackKeyFor, type FacetGroup, type Stack } from '../components/InventoryParts';

// Steam inventory, view only. The main process serves a disk copy at once and
// refreshes it in the background (Web API with the Steam sign-in, all games in
// seconds); this page stacks identical items, builds facets from Steam's own
// tags and sorts/filters locally. Prices load per item when it is opened.

type Scope = number | 'all';
type View = 'grid' | 'list' | 'cards';
type SortKey = 'newest' | 'name' | 'rarity' | 'quality' | 'qty' | 'price' | 'game';

const STEAM_APP = 753;
const PAGE_STEP = 240;

// Module caches: returning to the page is instant.
let cachedOverview: InvOverview | null = null;
const cachedApps = new Map<number, InvAppData>();
let cachedPrices: Record<string, InvPrice> = {};
let lastScope: Scope | null = null;
let lastView: Partial<Record<string, View>> = {};

const SPECIAL = { trade: '__trade', market: '__market', game: '__game' } as const;

function stackHas(s: Stack, group: string, value: string): boolean {
  if (group === SPECIAL.trade) return s.trade === value;
  if (group === SPECIAL.market) return s.market === value;
  if (group === SPECIAL.game) return String(s.appid) === value;
  return s.tagKeys.has(`${group}${TAG_SEP}${value}`);
}

function passes(s: Stack, sel: Record<string, string[]>, except?: string): boolean {
  for (const [g, vals] of Object.entries(sel)) {
    if (g === except || !vals.length) continue;
    if (!vals.some((v) => stackHas(s, g, v))) return false;
  }
  return true;
}

const errKey = (code: string | null | undefined): string | null => {
  if (!code) return null;
  if (code.includes('INV_PRIVATE')) return 'inv.err.private';
  if (code.includes('INV_RATE')) return 'inv.err.rate';
  if (code.includes('INV_LIST')) return 'inv.err.list';
  return 'inv.err.generic';
};

const InventoryPage: React.FC = () => {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [overview, setOverview] = useState<InvOverview | null>(cachedOverview);
  const [apps, setApps] = useState<Map<number, InvAppData>>(() => new Map(cachedApps));
  const [scope, setScopeState] = useState<Scope | null>(lastScope);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [reverse, setReverse] = useState(false);
  const [viewByScope, setViewByScope] = useState<Partial<Record<string, View>>>(lastView);
  const [stackOn, setStackOn] = useState(true);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [prices, setPrices] = useState<Record<string, InvPrice>>(cachedPrices);
  const [open, setOpen] = useState<Stack | null>(null);
  const [sets, setSets] = useState<CardSetsState | null>(null);
  const [limit, setLimit] = useState(PAGE_STEP);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const setScope = (s: Scope) => {
    lastScope = s;
    setScopeState(s);
    setSel({});
    setLimit(PAGE_STEP);
    setOpen(null);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const view: View = (scope !== null && viewByScope[String(scope)]) || (scope === STEAM_APP ? 'cards' : 'grid');
  const setView = (v: View) => {
    const next = { ...viewByScope, [String(scope)]: v };
    lastView = next;
    setViewByScope(next);
  };

  // ---------- data ----------

  const loadOverview = useCallback(
    (force = false) =>
      window.launcher
        .inventoryOverview(lang, force)
        .then((o) => {
          cachedOverview = o;
          setOverview(o);
          return o;
        })
        .catch(() => null),
    [lang]
  );

  const loadApp = useCallback(
    (appid: number) =>
      window.launcher
        .inventoryApp(appid, lang)
        .then((st) => {
          if (st.data) {
            cachedApps.set(appid, st.data);
            setApps(new Map(cachedApps));
          }
        })
        .catch(() => undefined),
    [lang]
  );

  useEffect(() => {
    void loadOverview();
    window.launcher.inventoryPrices().then((p) => {
      cachedPrices = { ...cachedPrices, ...p };
      setPrices(cachedPrices);
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.launcher.onInventoryChanged((e) => {
      if (e.appid != null) void loadApp(e.appid);
      if (e.cards) void window.launcher.inventoryCardSets(lang).then(setSets).catch(() => undefined);
      // Loading state lives in the overview; coalesce the burst of events a refresh produces.
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          void loadOverview();
        }, 400);
      }
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [lang, loadOverview, loadApp]);

  // Default scope: the game with the most items.
  useEffect(() => {
    if (scope === null && overview?.apps.length) setScope(overview.apps[0].appid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, scope]);

  // Items of what is on screen (all games for "All").
  useEffect(() => {
    if (scope === null || !overview) return;
    const ids = scope === 'all' ? overview.apps.map((a) => a.appid) : [scope];
    for (const id of ids) void loadApp(id);
  }, [scope, overview?.apps, loadApp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trading-card set sizes for the Steam items view.
  useEffect(() => {
    if (scope !== STEAM_APP || view !== 'cards' || !apps.get(STEAM_APP)) return;
    void window.launcher.inventoryCardSets(lang).then(setSets).catch(() => undefined);
  }, [scope, view, apps, lang]);

  // Keeps what is on screen while everything reloads; tiles update as each game arrives.
  const refresh = () => void loadOverview(true);

  // ---------- derived ----------

  const appNames = useMemo(() => new Map((overview?.apps ?? []).map((a) => [a.appid, a.name])), [overview?.apps]);

  const stacks = useMemo<Stack[]>(() => {
    if (scope === null || !overview) return [];
    const ids = scope === 'all' ? overview.apps.map((a) => a.appid) : [scope];
    const byKey = new Map<string, Stack>();
    const list: Stack[] = [];
    for (const appid of ids) {
      const d = apps.get(appid);
      if (!d) continue;
      for (const asset of d.assets) {
        const cls = d.classes[asset.cls];
        if (!cls) continue;
        const key = stackOn ? stackKeyFor(appid, cls) : `${appid}|${asset.ctx}|${asset.id}`;
        let s = byKey.get(key);
        if (!s) {
          s = makeStack(key, appid, appNames.get(appid) ?? String(appid), cls);
          byKey.set(key, s);
          list.push(s);
        }
        s.assets.push(asset);
        s.qty += asset.amount;
        s.newest = Math.max(s.newest, Number(asset.id) || 0);
      }
    }
    return list;
  }, [scope, overview, apps, stackOn, appNames]);

  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const searched = useMemo(() => (words.length ? stacks.filter((s) => words.every((w) => s.search.includes(w))) : stacks), [stacks, words]);

  const facetGroups = useMemo<FacetGroup[]>(() => {
    const groups: FacetGroup[] = [];
    const addGroup = (id: string, title: string, values: { id: string; label: string; color: string | null }[]) => {
      const base = searched.filter((s) => passes(s, sel, id));
      const counted = values.map((v) => ({ ...v, count: base.filter((s) => stackHas(s, id, v.id)).reduce((n, s) => n + s.assets.length, 0) }));
      groups.push({ id, title, values: counted.sort((a, b) => b.count - a.count) });
    };
    if (scope === 'all') {
      addGroup(SPECIAL.game, t('inv.f.game'), (overview?.apps ?? []).map((a) => ({ id: String(a.appid), label: a.name, color: null })));
    } else {
      // Steam's own tag categories, in the order Steam lists them.
      const cats = new Map<string, { title: string; values: Map<string, { label: string; color: string | null }> }>();
      for (const s of stacks) {
        for (const tg of s.cls.tags) {
          const c = cats.get(tg.cat) ?? { title: tg.catName, values: new Map() };
          if (!c.values.has(tg.internal)) c.values.set(tg.internal, { label: tg.name, color: tg.color });
          cats.set(tg.cat, c);
        }
      }
      for (const [cat, c] of cats) {
        if (c.values.size < 2) continue;
        addGroup(cat, c.title, [...c.values.entries()].map(([id, v]) => ({ id, ...v })));
      }
    }
    addGroup(SPECIAL.trade, t('inv.f.trade'), ['tradable', 'locked', 'untradable'].map((id) => ({ id, label: t(`inv.f.${id}`), color: null })));
    addGroup(SPECIAL.market, t('inv.f.market'), ['marketable', 'unmarketable'].map((id) => ({ id, label: t(`inv.f.${id}`), color: null })));
    return groups.map((g) => ({ ...g, values: g.values.filter((v) => v.count > 0 || (sel[g.id] ?? []).includes(v.id)) })).filter((g) => g.values.length > 0);
  }, [stacks, searched, sel, scope, overview?.apps, t]);

  const filtered = useMemo(() => searched.filter((s) => passes(s, sel)), [searched, sel]);

  const sorted = useMemo(() => {
    const priceOf = (s: Stack) => {
      const k = priceKey(s);
      return k ? prices[k]?.value ?? null : null;
    };
    const cmp: Record<SortKey, (a: Stack, b: Stack) => number> = {
      newest: (a, b) => b.newest - a.newest,
      name: (a, b) => a.cls.name.localeCompare(b.cls.name),
      rarity: (a, b) => b.rarity - a.rarity || b.quality - a.quality || a.cls.name.localeCompare(b.cls.name),
      quality: (a, b) => b.quality - a.quality || b.rarity - a.rarity || a.cls.name.localeCompare(b.cls.name),
      qty: (a, b) => b.qty - a.qty || a.cls.name.localeCompare(b.cls.name),
      price: (a, b) => (priceOf(b) ?? -1) - (priceOf(a) ?? -1),
      game: (a, b) => a.game.localeCompare(b.game) || b.rarity - a.rarity,
    };
    const list = [...filtered].sort(cmp[sort]);
    if (!reverse) return list;
    // Reversed price keeps unpriced items last.
    if (sort === 'price') {
      const known = list.filter((s) => priceOf(s) !== null).reverse();
      return [...known, ...list.filter((s) => priceOf(s) === null)];
    }
    return list.reverse();
  }, [filtered, sort, reverse, prices]);

  const summary = useMemo(() => {
    let items = 0;
    let tradable = 0;
    let marketable = 0;
    const unique = new Set<string>();
    for (const s of stacks) {
      items += s.assets.length;
      if (s.trade === 'tradable') tradable += s.assets.length;
      if (s.market === 'marketable') marketable += s.assets.length;
      unique.add(`${s.appid}|${s.cls.hashName ?? `${s.cls.name}|${s.cls.type}`}`);
    }
    return { items, unique: unique.size, tradable, marketable };
  }, [stacks]);

  // Reveal more as the grid scrolls.
  useEffect(() => setLimit(PAGE_STEP), [query, sel, sort, reverse, stackOn]);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setLimit((n) => n + PAGE_STEP), { root: scrollRef.current, rootMargin: '600px' });
    io.observe(node);
    return () => io.disconnect();
  }, [sorted.length, view]);

  const toggleFacet = (group: string, value: string) =>
    setSel((prev) => {
      const cur = prev[group] ?? [];
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      return { ...prev, [group]: next };
    });
  const activeChips = facetGroups.flatMap((g) => (sel[g.id] ?? []).map((v) => ({ g: g.id, v, label: g.values.find((x) => x.id === v)?.label ?? v })));

  const onPrice = (key: string, p: InvPrice) => {
    cachedPrices = { ...cachedPrices, [key]: p };
    setPrices(cachedPrices);
  };

  // ---------- render ----------

  const loadingSet = new Set(overview?.loading ?? []);
  const anyLoading = loadingSet.size > 0;
  const scopeLoading = scope === 'all' ? anyLoading : scope !== null && loadingSet.has(scope);
  const scopeHasData = scope === 'all' ? stacks.length > 0 : scope !== null && apps.has(scope);
  const scopeError = scope !== null && scope !== 'all' ? errKey(overview?.errors[scope]) : null;
  const updatedAt = scope !== null && scope !== 'all' ? apps.get(scope)?.fetchedAt : overview?.listAt;

  if (overview && !overview.steamId) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px' }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 28 }}>{t('inv.title')}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>{t('inv.noSteam')}</p>
        <button className="pill pill-active" onClick={() => navigate('/settings')}>{t('search.openSettings')}</button>
      </div>
    );
  }

  const tile = (s: Stack) => <ItemTile key={s.key} s={s} price={priceKey(s) ? prices[priceKey(s)!] : undefined} onOpen={setOpen} />;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* ===== Facets ===== */}
      <aside className="inv-aside">
        <div className="field-wrap inv-search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('inv.search')} />
          {query && <button className="field-clear" onClick={() => setQuery('')} title={t('chat.clear')}>✕</button>}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 }}>
          <FacetPanel groups={facetGroups} selected={sel} onToggle={toggleFacet} />
        </div>
      </aside>

      {/* ===== Main ===== */}
      <section ref={scrollRef} style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '16px 22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>{t('inv.title')}</h1>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('inv.subtitle')}</span>
          <span style={{ flex: 1 }} />
          {updatedAt && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('inv.updated', { t: new Date(updatedAt).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US') })}</span>}
          <button className="pill" style={{ padding: '5px 12px', fontSize: 12 }} disabled={anyLoading} onClick={refresh}>
            {anyLoading ? <span className="ai-dots"><span /><span /><span /></span> : '↻'} {t('inv.refresh')}
          </button>
        </div>

        {overview && !overview.signedIn && <div className="inv-note">{t('inv.publicOnly')}</div>}
        {overview?.listError && !overview.apps.length && (
          <div className="inv-note err">
            {t(errKey(overview.listError) ?? 'inv.err.generic', { e: overview.listError })}{' '}
            <button className="inv-link" onClick={() => void loadOverview(true)}>{t('inv.retry')}</button>
          </div>
        )}

        {/* Games */}
        {!overview ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: 13, padding: '8px 0 14px' }}>
            <span className="ai-dots"><span /><span /><span /></span> {t('inv.loading')}
          </div>
        ) : (
          overview.apps.length > 0 && (
            <div className="inv-games">
              <button className={`inv-game${scope === 'all' ? ' on' : ''}`} onClick={() => setScope('all')}>
                {t('inv.allGames')} <span className="n">{overview.apps.reduce((n, a) => n + a.count, 0).toLocaleString()}</span>
              </button>
              {overview.apps.map((a) => (
                <button key={a.appid} className={`inv-game${scope === a.appid ? ' on' : ''}`} onClick={() => setScope(a.appid)} title={a.name}>
                  {a.icon && <img src={a.icon} alt="" draggable={false} />}
                  <span className="nm">{a.name}</span>
                  <span className="n">{a.count.toLocaleString()}</span>
                  {loadingSet.has(a.appid) && <span className="inv-spin" />}
                  {overview.errors[a.appid] && !loadingSet.has(a.appid) && <span className="inv-err" title={overview.errors[a.appid]}>!</span>}
                </button>
              ))}
            </div>
          )
        )}

        {/* Summary */}
        {scopeHasData && (
          <div className="inv-summary">
            <span><b>{summary.items.toLocaleString()}</b> {t('inv.stat.items')}</span>
            <span><b>{summary.unique.toLocaleString()}</b> {t('inv.stat.unique')}</span>
            <span><b>{summary.tradable.toLocaleString()}</b> {t('inv.stat.tradable')}</span>
            <span><b>{summary.marketable.toLocaleString()}</b> {t('inv.stat.marketable')}</span>
          </div>
        )}

        {/* Toolbar */}
        {scopeHasData && (
          <div className="inv-toolbar">
            <label className="inv-select">
              {t('inv.sort')}
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {(['newest', 'name', 'rarity', 'quality', 'qty', 'price', ...(scope === 'all' ? (['game'] as const) : [])] as SortKey[]).map((k) => (
                  <option key={k} value={k}>{t(`inv.sort.${k}`)}</option>
                ))}
              </select>
            </label>
            <button className={`pill${reverse ? ' pill-active' : ''}`} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setReverse((v) => !v)} title={t('inv.reverse')}>⇅</button>
            <span style={{ width: 8 }} />
            <button className={`pill${view === 'grid' ? ' pill-active' : ''}`} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setView('grid')}>{t('inv.view.grid')}</button>
            <button className={`pill${view === 'list' ? ' pill-active' : ''}`} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setView('list')}>{t('inv.view.list')}</button>
            {scope === STEAM_APP && (
              <button className={`pill${view === 'cards' ? ' pill-active' : ''}`} style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setView('cards')}>{t('inv.view.cards')}</button>
            )}
            <span style={{ flex: 1 }} />
            <label className="inv-check">
              <input type="checkbox" checked={stackOn} onChange={(e) => setStackOn(e.target.checked)} />
              {t('inv.stack')}
            </label>
          </div>
        )}

        {activeChips.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            {activeChips.map((c) => (
              <button key={`${c.g}:${c.v}`} className="rnd-chip" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => toggleFacet(c.g, c.v)}>
                {c.label} ✕
              </button>
            ))}
            <button className="inv-link" onClick={() => setSel({})}>{t('inv.reset')}</button>
          </div>
        )}

        {/* Content */}
        {scopeError && !scopeHasData ? (
          <div className="inv-note err">{t(scopeError, { e: overview?.errors[scope as number] ?? '' })}</div>
        ) : !scopeHasData ? (
          scopeLoading || !overview ? (
            <div className="inv-grid">
              {Array.from({ length: 18 }, (_, i) => (
                <div key={i} className="skel" style={{ aspectRatio: '1 / 1.32', borderRadius: 8, animationDelay: `${i * 0.05}s` }} />
              ))}
            </div>
          ) : (
            overview.apps.length > 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('inv.empty')}</p>
          )
        ) : sorted.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('inv.none')}</p>
        ) : view === 'cards' && scope === STEAM_APP ? (
          <CardSetsView stacks={sorted} sets={sets} prices={prices} onOpen={setOpen} />
        ) : view === 'list' ? (
          <div className="inv-table">
            <div className="inv-row head">
              <span className="inv-row-img" />
              <span className="inv-row-name">{t('inv.col.name')}</span>
              {scope === 'all' && <span className="inv-row-cell">{t('inv.col.game')}</span>}
              <span className="inv-row-cell">{t('inv.col.type')}</span>
              <span className="inv-row-cell">{t('inv.col.rarity')}</span>
              <span className="inv-row-num">{t('inv.col.qty')}</span>
              <span className="inv-row-status">{t('inv.col.trade')}</span>
              <span className="inv-row-status">{t('inv.col.market')}</span>
              <span className="inv-row-price">{t('inv.col.price')}</span>
            </div>
            {sorted.slice(0, limit).map((s) => (
              <ItemRow key={s.key} s={s} price={priceKey(s) ? prices[priceKey(s)!] : undefined} showGame={scope === 'all'} onOpen={setOpen} />
            ))}
          </div>
        ) : (
          <div className="inv-grid">{sorted.slice(0, limit).map(tile)}</div>
        )}
        {view !== 'cards' && sorted.length > limit && (
          <div ref={sentinelRef} style={{ padding: 16, textAlign: 'center', fontSize: 12, color: 'var(--muted)' }}>
            {t('inv.more', { n: Math.min(limit, sorted.length), total: sorted.length })}
          </div>
        )}
      </section>

      {open && <ItemDrawer s={open} steamId={overview?.steamId ?? null} price={priceKey(open) ? prices[priceKey(open)!] : undefined} onPrice={onPrice} onClose={() => setOpen(null)} />}
    </div>
  );
};

export default InventoryPage;
