import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, normalizeTitle, steamAppId, useI18n, type Game } from '@app/shared';
import type { ContextGame, StoreItem } from '../../../preload';

// Side drawer for the AI page: pick games from the library, the Steam
// wishlist or the Steam store; the selection becomes context for the chat
// ("find games like these"). Library and wishlist are searched locally, the
// store through Steam's title search.

export const CONTEXT_LIMIT = 20;
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

type Tab = 'library' | 'wishlist' | 'store';

interface Row {
  key: string;
  title: string;
  origin: ContextGame['origin'];
  appid: number | null;
  image: string | null;
  sub: string | null;
}

const rowKey = (g: ContextGame): string => (g.appid ? `a-${g.appid}` : `t-${normalizeTitle(g.title)}`);
export const contextKey = rowKey;

let wishlistCache: { items: StoreItem[] } | null = null;
let wishlistPromise: Promise<{ items: StoreItem[] } | 'nosteam'> | null = null;

/** Wishlist entries carry only appids; names and covers come from the store metadata. Loaded once per session. */
function loadWishlist(lang: string): Promise<{ items: StoreItem[] } | 'nosteam'> {
  if (wishlistCache) return Promise.resolve(wishlistCache);
  if (!wishlistPromise) {
    wishlistPromise = (async () => {
      const st = await window.launcher.steamStatus().catch(() => ({ loggedIn: false }) as { loggedIn: boolean; steamId?: string });
      if (!st.steamId) return 'nosteam' as const;
      const entries = await window.launcher.storeWishlist(st.steamId).catch(() => []);
      const ids = [...entries].sort((a, b) => a.priority - b.priority).map((e) => e.appid).slice(0, 300);
      const meta = await window.launcher.storeItemsMeta(ids, lang).catch(() => ({}) as Record<number, StoreItem>);
      wishlistCache = { items: ids.map((id) => meta[id]).filter((x): x is StoreItem => !!x) };
      return wishlistCache;
    })().finally(() => {
      wishlistPromise = null;
    });
  }
  return wishlistPromise;
}

export const GamePicker: React.FC<{ selected: ContextGame[]; onChange: (next: ContextGame[]) => void; onClose: () => void }> = ({ selected, onChange, onClose }) => {
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<Tab>('library');
  const [query, setQuery] = useState('');
  const [library, setLibrary] = useState<Game[]>([]);
  const [wishlist, setWishlist] = useState<StoreItem[] | null>(wishlistCache?.items ?? null);
  const [wishlistState, setWishlistState] = useState<'idle' | 'loading' | 'nosteam' | 'ready'>(wishlistCache ? 'ready' : 'idle');
  const [store, setStore] = useState<StoreItem[]>([]);
  const [storeBusy, setStoreBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api.getCombinedLibrary().then(setLibrary).catch(() => undefined);
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (tab !== 'wishlist' || wishlistState === 'ready' || wishlistState === 'nosteam') return;
    let alive = true;
    setWishlistState('loading');
    loadWishlist(lang).then((r) => {
      if (!alive) return;
      if (r === 'nosteam') setWishlistState('nosteam');
      else {
        setWishlist(r.items);
        setWishlistState('ready');
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, lang]);

  // Store: debounced title search.
  useEffect(() => {
    if (tab !== 'store') return;
    const q = query.trim();
    if (q.length < 2) {
      setStore([]);
      return;
    }
    let alive = true;
    setStoreBusy(true);
    const timer = setTimeout(() => {
      window.launcher
        .storeSearch(q, lang)
        .then(async (hits) => {
          const top = hits.slice(0, 20);
          const meta = await window.launcher.storeItemsMeta(top.map((h) => h.appid), lang).catch(() => ({}) as Record<number, StoreItem>);
          return top.map((h) => ({ ...h, ...(meta[h.appid] ?? {}) })).filter((it) => !it.kind || it.kind === 'game');
        })
        .then((items) => alive && setStore(items))
        .catch(() => alive && setStore([]))
        .finally(() => alive && setStoreBusy(false));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tab, query, lang]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    if (tab === 'library') {
      return library
        .filter((g) => !q || g.title.toLowerCase().includes(q))
        .slice(0, 60)
        .map((g) => {
          const sid = g.entries.map(steamAppId).find((x): x is string => !!x) ?? null;
          return { key: sid ? `a-${sid}` : `t-${normalizeTitle(g.title)}`, title: g.title, origin: 'library', appid: sid ? Number(sid) : null, image: sid ? `${CDN}/${sid}/header.jpg` : g.iconUrl ?? null, sub: g.sources.map((s) => (s === 'Epic' ? 'EGS' : s)).join(' · ') };
        });
    }
    const list = tab === 'wishlist' ? wishlist ?? [] : store;
    return list
      .filter((it) => tab === 'store' || !q || it.name.toLowerCase().includes(q))
      .slice(0, 60)
      .map((it) => ({
        key: `a-${it.appid}`,
        title: it.name,
        origin: tab as ContextGame['origin'],
        appid: it.appid,
        image: it.image ?? `${CDN}/${it.appid}/header.jpg`,
        sub: it.price?.formattedFinal ? `${it.price.formattedFinal}${it.price.discountPct ? ` · −${it.price.discountPct}%` : ''}` : it.isFree ? t('picker.free') : null,
      }));
  }, [tab, query, library, wishlist, store, t]);

  const selectedKeys = useMemo(() => new Set(selected.map(rowKey)), [selected]);
  const full = selected.length >= CONTEXT_LIMIT;
  const toggle = (r: Row) => {
    const g: ContextGame = { title: r.title, origin: r.origin, appid: r.appid };
    if (selectedKeys.has(r.key)) onChange(selected.filter((x) => rowKey(x) !== r.key));
    else if (!full) onChange([...selected, g]);
  };

  const tabBtn = (id: Tab, label: string) => (
    <button key={id} className={`pill${tab === id ? ' pill-active' : ''}`} style={{ padding: '5px 11px', fontSize: 12 }} onClick={() => setTab(id)}>
      {label}
    </button>
  );

  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer rise" role="dialog" aria-modal="true">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 16, flex: 1 }}>{t('picker.title')}</h3>
          <span style={{ fontSize: 12, color: full ? '#f0a35a' : 'var(--muted)' }}>{t('picker.count', { n: selected.length, max: CONTEXT_LIMIT })}</span>
          <button className="pill" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onClose}>{t('picker.done')}</button>
        </div>
        <div className="field-wrap" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 10px', borderRadius: 8, background: 'var(--input-bg)', border: '1px solid var(--border)', marginBottom: 10 }}>
          <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t(tab === 'store' ? 'picker.searchStore' : 'picker.search')} style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: 0, fontSize: 13 }} />
          {query && <button className="field-clear" onClick={() => setQuery('')} title={t('chat.clear')}>✕</button>}
        </div>
        <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
          {tabBtn('library', t('picker.tab.library'))}
          {tabBtn('wishlist', t('picker.tab.wishlist'))}
          {tabBtn('store', t('picker.tab.store'))}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {tab === 'wishlist' && wishlistState === 'loading' && <p className="picker-note">{t('lib.loading')}</p>}
          {tab === 'wishlist' && wishlistState === 'nosteam' && <p className="picker-note">{t('picker.noSteam')}</p>}
          {tab === 'store' && query.trim().length < 2 && <p className="picker-note">{t('picker.storeHint')}</p>}
          {tab === 'store' && storeBusy && <p className="picker-note">{t('lib.loading')}</p>}
          {rows.length === 0 && !(tab === 'store' && (storeBusy || query.trim().length < 2)) && !(tab === 'wishlist' && wishlistState !== 'ready') && <p className="picker-note">{t('picker.none')}</p>}
          {rows.map((r) => {
            const on = selectedKeys.has(r.key);
            return (
              <label key={r.key} className={`picker-row${on ? ' on' : ''}${!on && full ? ' off' : ''}`}>
                <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(r)} />
                {r.image ? <img src={r.image} alt="" loading="lazy" draggable={false} /> : <span className="picker-cover" />}
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span className="ttl" style={{ fontSize: 13, fontWeight: 600 }}>{r.title}</span>
                  {r.sub && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{r.sub}</span>}
                </span>
              </label>
            );
          })}
        </div>

        {selected.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap', maxHeight: 96, overflowY: 'auto' }}>
            {selected.map((g) => (
              <button key={rowKey(g)} className="rnd-chip" style={{ padding: '2px 8px', fontSize: 11.5 }} onClick={() => onChange(selected.filter((x) => rowKey(x) !== rowKey(g)))} title={t('picker.remove')}>
                {g.title} ✕
              </button>
            ))}
            <button className="pill" style={{ padding: '2px 8px', fontSize: 11.5, color: 'var(--muted)', background: 'transparent' }} onClick={() => onChange([])}>{t('picker.clearAll')}</button>
          </div>
        )}
      </aside>
    </div>,
    document.body
  );
};

export default GamePicker;
