import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useI18n } from '@app/shared';
import type { SectionSort, StoreItem } from '../../../preload';
import { ctl, ItemCard, useOwnership } from '../store/parts';
import { useScrollRestore } from '../hooks/useScrollRestore';

// Full paginated view of one store section (specials / top sellers / new
// releases / coming soon). Pages of 50 load as the sentinel scrolls into view;
// each page is cached in the main process.
//
// The whole view state (loaded items, offset, sort) is persisted per section
// so navigating to a game page and back restores the exact list AND lets the
// scroll position land where it was (a fresh first page would be too short).

const PAGE = 50;

interface SectionState {
  items: StoreItem[];
  hasMore: boolean;
  nextStart: number;
  sort: SectionSort;
}
const savedStates = new Map<string, SectionState>();

// Keyed wrapper: switching /store/section/:id remounts the view so state
// initializers re-read the saved state of the new section.
const SectionPage: React.FC = () => {
  const { id = '' } = useParams();
  return <SectionView key={id} id={id} />;
};

const SectionView: React.FC<{ id: string }> = ({ id }) => {
  const location = useLocation() as { state?: { name?: string } };
  const { t, lang } = useI18n();
  const own = useOwnership();
  const tr = t as (k: string) => string;

  const saved = savedStates.get(id);
  const [items, setItems] = useState<StoreItem[]>(saved?.items ?? []);
  const [hasMore, setHasMore] = useState(saved?.hasMore ?? true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SectionSort>(saved?.sort ?? 'default');
  const loading = useRef(false);
  // Server offset is tracked separately from items.length: in-page dedupe can
  // shrink a page, and appended items are deduped against previous pages too.
  const nextStart = useRef(saved?.nextStart ?? 0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Section title: localized name passed from the home page, else i18n by id.
  const title = location.state?.name ?? tr(`store.section.${id}`);

  useScrollRestore(`store-section-${id}`, items.length > 0);

  // Persist the view state for the next visit.
  useEffect(() => {
    savedStates.set(id, { items, hasMore, nextStart: nextStart.current, sort });
  }, [id, items, hasMore, sort]);

  const loadMore = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const page = await window.launcher.storeSection(id, lang, nextStart.current, PAGE, sort);
      nextStart.current += PAGE;
      setItems((prev) => {
        const seen = new Set(prev.map((p) => `${p.appid}|${p.name}`));
        return [...prev, ...page.items.filter((it) => !seen.has(`${it.appid}|${it.name}`))];
      });
      setHasMore(page.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHasMore(false);
    } finally {
      loading.current = false;
    }
  }, [id, lang, sort]);

  // Reset when the language or sort order changes — but not on mount, where a
  // restored list must survive.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setItems([]);
    setHasMore(true);
    setError(null);
    nextStart.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, sort]);

  useEffect(() => {
    if (items.length === 0 && hasMore && !error) loadMore();
  }, [items.length, hasMore, error, loadMore]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es[0].isIntersecting && hasMore) loadMore();
      },
      { rootMargin: '600px' }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <Link to="/store" style={{ ...ctl, textDecoration: 'none' }}>
          ←
        </Link>
        <h2 style={{ margin: 0, flex: 1, minWidth: 0 }}>{title}</h2>
        {/* Server-side sorting — honest across the entire section. */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          {t('store.wl.sort')}
          <select value={sort} onChange={(e) => setSort(e.target.value as SectionSort)} style={ctl}>
            <option value="default">{t('store.sort.default')}</option>
            <option value="price_asc">{t('store.sort.priceAsc')}</option>
            <option value="price_desc">{t('store.sort.priceDesc')}</option>
            <option value="release">{t('store.sort.release')}</option>
            <option value="reviews">{t('store.sort.reviews')}</option>
            <option value="name">{t('store.sort.name')}</option>
          </select>
        </label>
      </div>

      {error && (
        <p style={{ color: '#ff6b6b' }}>
          {t('common.error')}: {error}
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {items.map((it, i) => (
          <ItemCard key={`${it.appid}-${it.name}-${i}`} item={it} own={own} />
        ))}
      </div>

      {items.length === 0 && !error && <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>}
      {hasMore && items.length > 0 && (
        <p style={{ color: 'var(--muted)', marginTop: 12 }}>{t('lib.loading')}</p>
      )}
      <div ref={sentinelRef} style={{ height: 1 }} />
    </div>
  );
};

export default SectionPage;
