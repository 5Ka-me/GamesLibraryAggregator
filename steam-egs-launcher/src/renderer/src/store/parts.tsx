import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, useI18n, normalizeTitle, openExternal, sourceMeta, steamAppId } from '@app/shared';
import type { StoreItem } from '../../../preload';

// Shared building blocks of the in-app Steam store (used by the front page,
// section pages and search results): ownership badges, price tags, capsule
// cards with graceful image fallback, and section grids.

// ---------- ownership (matches the combined library) ----------

export interface Ownership {
  steamIds: Set<string>;
  steamTitles: Set<string>;
  epicTitles: Set<string>;
  /** Steam appid → my playtime in minutes (from the combined library). */
  steamPlaytimeById: Map<string, number>;
}

export function useOwnership(): Ownership | null {
  const [own, setOwn] = useState<Ownership | null>(null);
  useEffect(() => {
    api
      .getCombinedLibrary()
      .then((games) => {
        const steamIds = new Set<string>();
        const steamTitles = new Set<string>();
        const epicTitles = new Set<string>();
        const steamPlaytimeById = new Map<string, number>();
        for (const g of games) {
          const norm = normalizeTitle(g.title);
          for (const e of g.entries) {
            if (e.source === 'Steam') {
              steamTitles.add(norm);
              const id = steamAppId(e);
              if (id) {
                steamIds.add(id);
                if (e.playtimeMinutes) steamPlaytimeById.set(id, e.playtimeMinutes);
              }
            } else if (e.source === 'Epic') {
              epicTitles.add(norm);
            }
          }
        }
        setOwn({ steamIds, steamTitles, epicTitles, steamPlaytimeById });
      })
      .catch(() => setOwn(null)); // no library — just skip badges
  }, []);
  return own;
}

function ownedIn(item: StoreItem, own: Ownership | null): { steam: boolean; epic: boolean } {
  if (!own) return { steam: false, epic: false };
  const norm = normalizeTitle(item.name);
  return {
    steam: (item.appid > 0 && own.steamIds.has(String(item.appid))) || own.steamTitles.has(norm),
    epic: own.epicTitles.has(norm),
  };
}

// ---------- small presentational bits ----------

export const ctl: React.CSSProperties = {
  padding: '7px 12px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  color: 'var(--text)',
  fontWeight: 600,
  cursor: 'pointer',
};

const badge = (bg: string): React.CSSProperties => ({
  padding: '1px 6px',
  borderRadius: 4,
  background: bg,
  color: 'var(--on-accent)',
  fontWeight: 700,
  fontSize: 10,
  whiteSpace: 'nowrap',
});

const OwnedBadges: React.FC<{ item: StoreItem; own: Ownership | null }> = ({ item, own }) => {
  const { t } = useI18n();
  const o = ownedIn(item, own);
  if (!o.steam && !o.epic) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {o.steam && (
        <span title={t('store.inLib.steam')} style={badge(sourceMeta('Steam').color)}>
          ✓ Steam
        </span>
      )}
      {o.epic && (
        <span title={t('store.inLib.epic')} style={badge(sourceMeta('Epic').color)}>
          ✓ EGS
        </span>
      )}
    </span>
  );
};

function formatCents(cents: number | null | undefined, currency?: string): string | null {
  if (cents == null) return null;
  return `${(cents / 100).toFixed(2)} ${currency ?? ''}`.trim();
}

const PriceTag: React.FC<{ item: StoreItem }> = ({ item }) => {
  const { t, lang } = useI18n();
  if (item.isFree) return <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('store.free')}</span>;
  const p = item.price;
  if (!p) {
    // Unreleased games have no price — show the release date instead of an
    // empty (and confusing) price slot.
    if (item.comingSoon || item.releaseUnix) {
      const date = item.releaseUnix
        ? new Date(item.releaseUnix * 1000).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US')
        : t('details.comingSoon');
      return (
        <span style={{ fontSize: 12, color: 'var(--muted)' }} title={t('details.comingSoon')}>
          📅 {date}
        </span>
      );
    }
    return null;
  }

  const final = p.formattedFinal ?? formatCents(p.final, p.currency);
  const original =
    (p.discountPct ?? 0) > 0 ? p.formattedOriginal ?? formatCents(p.initial, p.currency) : null;
  if (!final) return null;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      {(p.discountPct ?? 0) > 0 && <span style={badge('#4c6b22')}>-{p.discountPct}%</span>}
      {original && (
        <span style={{ color: 'var(--muted)', textDecoration: 'line-through' }}>{original}</span>
      )}
      <span style={{ fontWeight: 600 }}>{final}</span>
    </span>
  );
};

export function openItem(item: StoreItem): void {
  // Bundles/spotlights carry an explicit URL → browser. Games open in the
  // Steam client when it's installed, otherwise the browser (decided in main).
  if (item.url || item.appid <= 0) {
    openExternal(item.url ?? `https://store.steampowered.com/app/${item.appid}/`);
  } else {
    void window.launcher.storeOpenPage(item.appid);
  }
}

const headerFallback = (appid: number): string =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;

// Capsule image with graceful degradation: given image → header.jpg → hidden.
const CapsuleImage: React.FC<{ item: StoreItem; height: number }> = ({ item, height }) => {
  const [src, setSrc] = useState(item.image ?? null);
  useEffect(() => setSrc(item.image ?? null), [item.image]);

  const onError = () => {
    const fallback = item.appid > 0 ? headerFallback(item.appid) : null;
    setSrc((prev) => (fallback && prev !== fallback ? fallback : null));
  };

  return (
    <div style={{ height, background: 'var(--panel-2)' }}>
      {src && (
        <img
          src={src}
          alt={item.name}
          loading="lazy"
          onError={onError}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}
    </div>
  );
};

// Standard capsule card (231×87 image + name/price row). Games navigate to the
// in-app details page; bundles/spotlights (external url) open in the browser.
export const ItemCard: React.FC<{ item: StoreItem; own: Ownership | null }> = ({ item, own }) => {
  const navigate = useNavigate();
  const onClick = () => {
    if (item.appid > 0 && !item.url) navigate(`/store/app/${item.appid}`);
    else openItem(item);
  };
  return (
    <div
      onClick={onClick}
      title={item.name}
      style={{
        width: 231,
        cursor: 'pointer',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--panel)',
        border: '1px solid var(--border)',
      }}
    >
      <CapsuleImage item={item} height={87} />
      <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <PriceTag item={item} />
          <OwnedBadges item={item} own={own} />
        </div>
      </div>
    </div>
  );
};

// Wide banner card for spotlight sections: promo label as a badge over the
// image, game name as the caption. Game banners navigate to the in-app game
// page; sale-page banners open externally; linkless banners aren't clickable.
export const BannerCard: React.FC<{ item: StoreItem }> = ({ item }) => {
  const navigate = useNavigate();
  const clickable = item.appid > 0 || !!item.url;
  const onClick = () => {
    if (!clickable) return;
    if (item.appid > 0 && !item.url) navigate(`/store/app/${item.appid}`);
    else openItem(item);
  };
  return (
    <div
      onClick={onClick}
      title={item.name}
      style={{
        width: 340,
        cursor: clickable ? 'pointer' : 'default',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--panel)',
        border: '1px solid var(--border)',
      }}
    >
      <div style={{ position: 'relative' }}>
        <CapsuleImage item={item} height={110} />
        {item.badge && (
          <span
            style={{
              position: 'absolute',
              top: 6,
              left: 6,
              padding: '2px 8px',
              borderRadius: 4,
              background: 'var(--accent)',
              color: 'var(--on-accent)',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
            }}
          >
            {item.badge}
          </span>
        )}
      </div>
      <div style={{ padding: '6px 8px', fontSize: 13, fontWeight: 600 }}>{item.name}</div>
    </div>
  );
};

export const SectionBlock: React.FC<{
  name: string;
  banner?: boolean;
  items: StoreItem[];
  own: Ownership | null;
  /** Route of the full-section page; renders a "Show all" link when set. */
  moreTo?: string;
}> = ({ name, banner, items, own, moreTo }) => {
  const { t } = useI18n();
  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '0 0 10px' }}>
        <h3 style={{ margin: 0 }}>{name}</h3>
        {moreTo && (
          <Link to={moreTo} state={{ name }} style={{ fontSize: 13 }}>
            {t('store.showAll')}
          </Link>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {items.map((it, i) =>
          banner || it.banner ? (
            <BannerCard key={`${it.name}-${i}`} item={it} />
          ) : (
            <ItemCard key={`${it.appid}-${i}`} item={it} own={own} />
          )
        )}
      </div>
    </section>
  );
};
