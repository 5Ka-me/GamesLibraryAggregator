import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useI18n } from '@app/shared';
import type { StoreItem } from '../../../preload';
import { ctl, ItemCard, useOwnership } from '../store/parts';
import { useScrollRestore } from '../hooks/useScrollRestore';

// Full paginated view of one store section (specials / top sellers / new
// releases / coming soon). Pages of 50 load as the sentinel scrolls into view;
// each page is cached in the main process.

const PAGE = 50;

const SectionPage: React.FC = () => {
  const { id = '' } = useParams();
  const location = useLocation() as { state?: { name?: string } };
  const { t, lang } = useI18n();
  const own = useOwnership();
  const tr = t as (k: string) => string;

  const [items, setItems] = useState<StoreItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loading = useRef(false);
  // Server offset is tracked separately from items.length: in-page dedupe can
  // shrink a page, and appended items are deduped against previous pages too.
  const nextStart = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Section title: localized name passed from the home page, else i18n by id.
  const title = location.state?.name ?? tr(`store.section.${id}`);

  useScrollRestore(`store-section-${id}`, items.length > 0);

  const loadMore = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const page = await window.launcher.storeSection(id, lang, nextStart.current, PAGE);
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
  }, [id, lang]);

  // Reset when the section or language changes.
  useEffect(() => {
    setItems([]);
    setHasMore(true);
    setError(null);
    nextStart.current = 0;
  }, [id, lang]);

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <Link to="/store" style={{ ...ctl, textDecoration: 'none' }}>
          ←
        </Link>
        <h2 style={{ margin: 0 }}>{title}</h2>
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
