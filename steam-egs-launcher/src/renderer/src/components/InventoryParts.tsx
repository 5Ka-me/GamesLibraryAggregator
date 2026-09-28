import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { economyImage, isFoil, notableQuality, openExternal, qualityRank, rarityRank, stackKey, tagOf, useI18n } from '@app/shared';
import type { CardSetsState, InvAsset, InvClass, InvPrice } from '../../../preload';

// Building blocks of the Inventory page: stacks (identical items grouped),
// the tile and list row, the facet panel, the item drawer and the trading-card
// sets view. Everything is read-only; the only way out is a link that opens
// the Steam Market or the Steam inventory (in the Steam client when installed).

export type TradeState = 'tradable' | 'locked' | 'untradable';

export interface Stack {
  key: string;
  appid: number;
  game: string;
  cls: InvClass;
  assets: InvAsset[];
  qty: number;
  newest: number;
  rarity: number;
  quality: number;
  trade: TradeState;
  market: 'marketable' | 'unmarketable';
  tagKeys: Set<string>;
  search: string;
}

export const TAG_SEP = '\u0001';
export const priceKey = (s: Stack): string | null => (s.cls.hashName ? `${s.appid}|${s.cls.hashName}` : null);

export function makeStack(key: string, appid: number, game: string, cls: InvClass): Stack {
  return {
    key,
    appid,
    game,
    cls,
    assets: [],
    qty: 0,
    newest: 0,
    rarity: rarityRank(cls.tags),
    quality: qualityRank(cls.tags),
    trade: cls.tradable ? 'tradable' : cls.lock ? 'locked' : 'untradable',
    market: cls.marketable ? 'marketable' : 'unmarketable',
    tagKeys: new Set(cls.tags.map((t) => `${t.cat}${TAG_SEP}${t.internal}`)),
    search: [cls.name, cls.type, cls.hashName ?? '', game, ...cls.tags.map((t) => t.name), ...cls.lines.slice(0, 8).map((l) => l.text), ...cls.fraud]
      .join(' ')
      .toLowerCase(),
  };
}

/** Stack key that also separates trade states, so held copies never hide among tradable ones. */
export const stackKeyFor = (appid: number, cls: InvClass): string =>
  `${stackKey(appid, cls)}|${cls.tradable ? 't' : cls.lock ? 'l' : 'u'}`;

/** The colour that stands for the item: rarity tag, else Steam's name colour. */
export function itemColor(cls: InvClass): string | null {
  const rar = tagOf(cls.tags, 'Rarity') ?? tagOf(cls.tags, 'droprate');
  return rar?.color ?? cls.nameColor ?? null;
}

const artBackground = (cls: InvClass): string => {
  const c = itemColor(cls);
  const bg = cls.bgColor ? `#${cls.bgColor}` : '#1b2433';
  return c ? `radial-gradient(circle at 50% 38%, #${c}40 0%, ${bg} 72%)` : bg;
};

const dateTime = (iso: string, lang: string): string =>
  new Date(iso).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- tile + row ----------

/** Item art with a placeholder: Steam sends no icon for a few items, and a CDN miss must not leave a hole. */
const Art: React.FC<{ cls: InvClass; size: number }> = ({ cls, size }) => {
  const [broken, setBroken] = useState(false);
  const hash = size > 200 ? cls.iconLarge ?? cls.icon : cls.icon ?? cls.iconLarge;
  if (!hash || broken) return <span className="inv-noimg">{cls.name.slice(0, 1).toUpperCase()}</span>;
  return <img src={economyImage(hash, size)} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />;
};

export const Flags: React.FC<{ s: Stack }> = ({ s }) => {
  const { t } = useI18n();
  const q = notableQuality(s.cls.tags);
  return (
    <span className="inv-flags">
      {q && (
        <span className="inv-flag" style={q.color ? { color: `#${q.color}` } : undefined} title={q.name}>
          {q.name.length > 12 ? `${q.name.slice(0, 11)}…` : q.name}
        </span>
      )}
      {isFoil(s.cls.tags) && <span className="inv-flag" style={{ color: '#f5c451' }}>{t('inv.b.foil')}</span>}
      {s.trade === 'locked' && <span className="inv-flag" title={s.cls.lock ?? t('inv.b.locked')}>🔒</span>}
      {s.trade === 'untradable' && <span className="inv-flag dim" title={t('inv.b.untradable')}>⊘</span>}
    </span>
  );
};

export const ItemTile: React.FC<{ s: Stack; price?: InvPrice; onOpen: (s: Stack) => void }> = ({ s, price, onOpen }) => {
  const color = itemColor(s.cls);
  return (
    <button className="inv-tile" onClick={() => onOpen(s)} title={s.cls.name}>
      <div className="inv-art" style={{ background: artBackground(s.cls), borderBottomColor: color ? `#${color}` : undefined }}>
        <Art cls={s.cls} size={128} />
        {s.qty > 1 && <span className="inv-qty">×{s.qty.toLocaleString()}</span>}
        <Flags s={s} />
      </div>
      <div className="inv-name" style={{ color: s.cls.nameColor ? `#${s.cls.nameColor}` : undefined }}>{s.cls.name}</div>
      <div className="inv-sub">{price?.listed ? price.lowest ?? price.median : s.cls.type}</div>
    </button>
  );
};

export const ItemRow: React.FC<{ s: Stack; price?: InvPrice; showGame: boolean; onOpen: (s: Stack) => void }> = ({ s, price, showGame, onOpen }) => {
  const { t } = useI18n();
  const rar = tagOf(s.cls.tags, 'Rarity') ?? tagOf(s.cls.tags, 'droprate');
  return (
    <button className="inv-row" onClick={() => onOpen(s)} title={s.cls.name}>
      <span className="inv-row-img" style={{ background: artBackground(s.cls) }}>
        <Art cls={s.cls} size={64} />
      </span>
      <span className="inv-row-name" style={{ color: s.cls.nameColor ? `#${s.cls.nameColor}` : undefined }}>{s.cls.name}</span>
      {showGame && <span className="inv-row-cell muted">{s.game}</span>}
      <span className="inv-row-cell muted">{s.cls.type}</span>
      <span className="inv-row-cell" style={{ color: rar?.color ? `#${rar.color}` : undefined }}>{rar?.name ?? ''}</span>
      <span className="inv-row-num">{s.qty > 1 ? `×${s.qty.toLocaleString()}` : ''}</span>
      <span className="inv-row-status" title={s.trade === 'locked' ? s.cls.lock ?? '' : t(`inv.f.${s.trade}`)}>
        {s.trade === 'tradable' ? '⇄' : s.trade === 'locked' ? '🔒' : '⊘'}
      </span>
      <span className="inv-row-status" title={t(`inv.f.${s.market}`)}>{s.market === 'marketable' ? '✓' : '—'}</span>
      <span className="inv-row-price">{price?.listed ? price.lowest ?? price.median : ''}</span>
    </button>
  );
};

// ---------- facets ----------

export interface FacetValue {
  id: string;
  label: string;
  count: number;
  color: string | null;
}

export interface FacetGroup {
  id: string;
  title: string;
  values: FacetValue[];
}

const FACET_PREVIEW = 8;

export const FacetPanel: React.FC<{
  groups: FacetGroup[];
  selected: Record<string, string[]>;
  onToggle: (group: string, value: string) => void;
}> = ({ groups, selected, onToggle }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState<Record<string, boolean>>({});
  return (
    <>
      {groups.map((g) => {
        const sel = selected[g.id] ?? [];
        const collapsed = open[g.id] === false;
        const values = all[g.id] ? g.values : g.values.slice(0, FACET_PREVIEW).concat(g.values.slice(FACET_PREVIEW).filter((v) => sel.includes(v.id)));
        return (
          <div key={g.id} className="inv-facet-group">
            <button className="inv-facet-title" onClick={() => setOpen((p) => ({ ...p, [g.id]: collapsed }))}>
              <span>{collapsed ? '▸' : '▾'}</span>
              <span className="uc-header" style={{ fontSize: 10.5 }}>{g.title}</span>
              {sel.length > 0 && <span className="inv-facet-sel">{sel.length}</span>}
            </button>
            {!collapsed && (
              <>
                {values.map((v) => {
                  const on = sel.includes(v.id);
                  return (
                    <button key={v.id} className={`inv-facet${on ? ' on' : ''}${v.count === 0 && !on ? ' zero' : ''}`} onClick={() => onToggle(g.id, v.id)} title={v.label}>
                      <span className="box">{on ? '✓' : ''}</span>
                      {v.color && <span className="dot" style={{ background: `#${v.color}` }} />}
                      <span className="lbl">{v.label}</span>
                      <span className="cnt">{v.count.toLocaleString()}</span>
                    </button>
                  );
                })}
                {g.values.length > FACET_PREVIEW && (
                  <button className="inv-facet-more" onClick={() => setAll((p) => ({ ...p, [g.id]: !p[g.id] }))}>
                    {all[g.id] ? t('inv.showLess') : t('inv.showAll', { n: g.values.length })}
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );
};

// ---------- drawer ----------

const WEAR_BANDS: [number, number, string][] = [
  [0, 0.07, '#3fb950'],
  [0.07, 0.15, '#8bc34a'],
  [0.15, 0.38, '#d9c85a'],
  [0.38, 0.45, '#e08a3c'],
  [0.45, 1, '#d4574b'],
];

const WearBar: React.FC<{ wear: number }> = ({ wear }) => (
  <div className="inv-wear" title={wear.toFixed(6)}>
    {WEAR_BANDS.map(([a, b, c]) => (
      <span key={a} style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%`, background: c }} />
    ))}
    <i style={{ left: `calc(${Math.min(1, Math.max(0, wear)) * 100}% - 1px)` }} />
  </div>
);

const errorText = (code: string, t: (k: string) => string): string =>
  code.includes('INV_PRICE_RATE') ? t('inv.d.priceRate') : `${t('common.error')}: ${code.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;

export const ItemDrawer: React.FC<{
  s: Stack;
  steamId: string | null;
  price?: InvPrice;
  onPrice: (key: string, p: InvPrice) => void;
  onClose: () => void;
}> = ({ s, steamId, price, onPrice, onClose }) => {
  const { t, lang } = useI18n();
  const cls = s.cls;
  const key = priceKey(s);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadPrice = (force = false) => {
    if (!key || !cls.marketable || !cls.hashName) return;
    setBusy(true);
    setErr(null);
    window.launcher
      .inventoryPrice(s.appid, cls.hashName, force)
      .then((p) => onPrice(key, p))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // The price loads when the item is opened (cached for a day in main).
  useEffect(() => {
    setErr(null);
    if (!price) loadPrice(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.key]);

  const color = itemColor(cls);
  const first = s.assets[0];
  const exterior = tagOf(cls.tags, 'Exterior');
  const withWear = s.assets.filter((a) => a.wear !== undefined);
  const marketUrl = cls.marketable && cls.hashName ? `https://steamcommunity.com/market/listings/${s.appid}/${encodeURIComponent(cls.hashName)}` : null;
  const inventoryUrl = steamId && first ? `https://steamcommunity.com/profiles/${steamId}/inventory/#${s.appid}_${first.ctx}_${first.id}` : null;

  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer rise inv-drawer" role="dialog" aria-modal="true">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.25, color: cls.nameColor ? `#${cls.nameColor}` : undefined }}>{cls.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>{cls.type} · {s.game}</div>
          </div>
          <button className="pill" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onClose}>{t('viewer.close')}</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="inv-drawer-art" style={{ background: artBackground(cls), borderBottomColor: color ? `#${color}` : undefined }}>
            <Art cls={cls} size={360} />
            {s.qty > 1 && <span className="inv-qty" style={{ fontSize: 13 }}>×{s.qty.toLocaleString()}</span>}
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className={`inv-chip ${s.trade === 'tradable' ? 'ok' : 'no'}`}>{t(`inv.f.${s.trade}`)}</span>
            <span className={`inv-chip ${s.market === 'marketable' ? 'ok' : 'no'}`}>{t(`inv.f.${s.market}`)}</span>
            {isFoil(cls.tags) && <span className="inv-chip" style={{ color: '#f5c451' }}>{t('inv.b.foil')}</span>}
          </div>
          {cls.lock && <div className="inv-lock">🔒 {cls.lock}</div>}

          {/* Market price, on demand */}
          {cls.marketable && cls.hashName && (
            <div className="inv-box">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span className="uc-header" style={{ fontSize: 10.5 }}>{t('inv.d.price')}</span>
                <span style={{ flex: 1 }} />
                {price && !busy && (
                  <button className="inv-link" onClick={() => loadPrice(true)} title={t('inv.refresh')}>↻ {t('inv.d.priceAt', { t: dateTime(price.at, lang) })}</button>
                )}
              </div>
              {busy && !price ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 13 }}>
                  <span className="ai-dots"><span /><span /><span /></span>
                  {t('inv.d.priceLoading')}
                </div>
              ) : price && !price.listed ? (
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>{t('inv.d.noPrice')}</div>
              ) : price ? (
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <Fact label={t('inv.d.lowest')} value={price.lowest ?? '—'} />
                  <Fact label={t('inv.d.median')} value={price.median ?? '—'} />
                  <Fact label={t('inv.d.volume')} value={price.volume != null ? price.volume.toLocaleString() : '—'} />
                </div>
              ) : null}
              {err && <div style={{ color: '#ff9f9f', fontSize: 12.5, marginTop: 6 }}>{errorText(err, t)}</div>}
            </div>
          )}

          {/* CS2 wear and pattern */}
          {withWear.length > 0 && (
            <div className="inv-box">
              <div className="uc-header" style={{ fontSize: 10.5, marginBottom: 8 }}>{t('inv.d.wear')}{exterior ? ` · ${exterior.name}` : ''}</div>
              {withWear.slice(0, 12).map((a) => (
                <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 10px', alignItems: 'center', marginBottom: 8 }}>
                  <WearBar wear={a.wear!} />
                  <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                    {a.wear!.toFixed(6)}
                    {a.pattern !== undefined && <span style={{ color: 'var(--muted)' }}> · {t('inv.d.pattern')} {a.pattern}</span>}
                  </span>
                </div>
              ))}
              {withWear.length > 12 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('inv.d.more', { n: withWear.length - 12 })}</div>}
            </div>
          )}

          {cls.fraud.length > 0 && (
            <div className="inv-box">
              {cls.fraud.map((f) => (
                <div key={f} style={{ fontSize: 13, color: '#f0a35a' }}>{f}</div>
              ))}
            </div>
          )}

          {cls.lines.length > 0 && (
            <div className="inv-lines">
              {cls.lines.map((l, i) => (
                <div key={i} style={{ color: l.color ? `#${l.color}` : undefined }}>{l.text}</div>
              ))}
            </div>
          )}

          {cls.ownerLines.filter((l) => l.text !== cls.lock).length > 0 && (
            <div className="inv-lines">
              {cls.ownerLines
                .filter((l) => l.text !== cls.lock)
                .map((l, i) => (
                  <div key={i} style={{ color: l.color ? `#${l.color}` : '#f0a35a' }}>{l.text}</div>
                ))}
            </div>
          )}

          {cls.tags.length > 0 && (
            <div>
              <div className="uc-header" style={{ fontSize: 10.5, marginBottom: 6 }}>{t('inv.d.tags')}</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {cls.tags.map((tg) => (
                  <span key={`${tg.cat}:${tg.internal}`} className="inv-tag">
                    {tg.color && <span className="dot" style={{ background: `#${tg.color}` }} />}
                    <span style={{ color: 'var(--muted)' }}>{tg.catName}:</span> {tg.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {marketUrl && <button className="pill" onClick={() => openExternal(marketUrl)}>{t('inv.d.openMarket')}</button>}
            {inventoryUrl && <button className="pill" onClick={() => openExternal(inventoryUrl)}>{t('inv.d.openInventory')}</button>}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('inv.d.readOnly')}</div>
        </div>
      </aside>
    </div>,
    document.body
  );
};

const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
    <span style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</span>
    <span style={{ fontSize: 15, fontWeight: 700 }}>{value}</span>
  </span>
);

// ---------- trading cards ----------

interface CardGroup {
  game: number;
  name: string;
  normal: Stack[];
  foil: Stack[];
  ownedIcons: Set<string>;
}

interface TypeGroup {
  id: string;
  name: string;
  stacks: Stack[];
}

const itemClass = (s: Stack): string => s.cls.tags.find((t) => t.cat === 'item_class')?.internal ?? 'other';

export const CardSetsView: React.FC<{
  stacks: Stack[];
  sets: CardSetsState | null;
  prices: Record<string, InvPrice>;
  onOpen: (s: Stack) => void;
}> = ({ stacks, sets, prices, onOpen }) => {
  const { t } = useI18n();
  const [openGame, setOpenGame] = useState<number | null>(null);
  const [openType, setOpenType] = useState<Record<string, boolean>>({});

  const { games, others } = useMemo(() => {
    const byGame = new Map<number, CardGroup>();
    const byType = new Map<string, TypeGroup>();
    for (const s of stacks) {
      if (itemClass(s) === 'item_class_2') {
        const g = s.cls.tags.find((x) => x.cat === 'Game');
        const id = Number(g?.internal.match(/^app_(\d+)$/)?.[1] ?? 0);
        const grp = byGame.get(id) ?? { game: id, name: g?.name ?? '?', normal: [], foil: [], ownedIcons: new Set<string>() };
        if (isFoil(s.cls.tags)) {
          grp.foil.push(s);
        } else {
          grp.normal.push(s);
          if (s.cls.icon) grp.ownedIcons.add(s.cls.icon);
        }
        byGame.set(id, grp);
      } else {
        const typeTag = s.cls.tags.find((x) => x.cat === 'item_class');
        const id = typeTag?.internal ?? 'other';
        const grp = byType.get(id) ?? { id, name: typeTag?.name ?? t('inv.cards.other'), stacks: [] };
        grp.stacks.push(s);
        byType.set(id, grp);
      }
    }
    // Stable order that needs no set sizes (they arrive in the background): most distinct cards first.
    const distinct = (g: CardGroup): number => g.ownedIcons.size || new Set(g.normal.map((s) => s.cls.name)).size;
    const games = [...byGame.values()].sort((a, b) => distinct(b) - distinct(a) || a.name.localeCompare(b.name));
    const others = [...byType.values()].sort((a, b) => b.stacks.length - a.stacks.length);
    return { games, others };
  }, [stacks, t]);

  const known = sets ? Object.keys(sets.sets).length : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <span className="uc-header">{t('inv.cards.title')}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('inv.cards.games', { n: games.length })}</span>
          {sets && sets.pending > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
              <span className="ai-dots"><span /><span /><span /></span>
              {t('inv.cards.setLoading', { k: known, n: sets.total })}
            </span>
          )}
        </div>
        {games.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{t('inv.none')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {games.map((g) => {
              const set = sets?.sets[g.game];
              const size = set?.size ?? 0;
              const ownedDistinct = size ? set!.cards.filter((c) => c.icon && g.ownedIcons.has(c.icon)).length || new Set(g.normal.map((s) => s.cls.name)).size : new Set(g.normal.map((s) => s.cls.name)).size;
              const complete = size > 0 && ownedDistinct >= size;
              const missing = size ? set!.cards.filter((c) => !(c.icon && g.ownedIcons.has(c.icon))) : [];
              const expanded = openGame === g.game;
              const copies = g.normal.reduce((n, s) => n + s.qty, 0);
              return (
                <div key={g.game} className={`inv-set${expanded ? ' open' : ''}`}>
                  <button className="inv-set-head" onClick={() => setOpenGame(expanded ? null : g.game)}>
                    <span className="inv-set-name" title={g.name}>{g.name}</span>
                    <span className="inv-set-thumbs">
                      {g.normal.slice(0, 6).map((s) => (s.cls.icon ? <img key={s.key} src={economyImage(s.cls.icon, 64)} alt="" loading="lazy" draggable={false} /> : null))}
                    </span>
                    <span className="inv-set-bar">
                      <span className="inv-bar"><i style={{ width: `${size ? Math.min(100, (ownedDistinct / size) * 100) : 0}%`, background: complete ? 'var(--success)' : undefined }} /></span>
                    </span>
                    <span className="inv-set-num">{size ? t('inv.cards.progress', { k: ownedDistinct, n: size }) : `${ownedDistinct} · ${t('inv.cards.setUnknown')}`}</span>
                    <span className="inv-set-extra">
                      {copies > ownedDistinct && <span title={t('inv.cards.copies')}>×{copies}</span>}
                      {g.foil.length > 0 && <span style={{ color: '#f5c451' }}>{t('inv.cards.foil', { n: g.foil.reduce((n, s) => n + s.qty, 0) })}</span>}
                      {complete && <span style={{ color: 'var(--success)' }}>✓ {t('inv.cards.complete')}</span>}
                    </span>
                  </button>
                  {expanded && (
                    <div className="inv-set-body rise">
                      <div className="inv-grid">
                        {[...g.normal, ...g.foil].map((s) => (
                          <ItemTile key={s.key} s={s} price={priceKey(s) ? prices[priceKey(s)!] : undefined} onOpen={onOpen} />
                        ))}
                      </div>
                      {missing.length > 0 && (
                        <div style={{ marginTop: 10 }}>
                          <div className="uc-header" style={{ fontSize: 10.5, marginBottom: 6 }}>{t('inv.cards.missing')}</div>
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                            {missing.map((c, i) => (
                              <span key={`${c.name}-${i}`} className="inv-tag">{c.name || '?'}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {others.map((grp) => {
        const expanded = openType[grp.id] ?? grp.stacks.length <= 12;
        return (
          <div key={grp.id}>
            <button className="inv-facet-title" style={{ padding: '0 0 8px' }} onClick={() => setOpenType((p) => ({ ...p, [grp.id]: !expanded }))}>
              <span>{expanded ? '▾' : '▸'}</span>
              <span className="uc-header">{grp.name}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{grp.stacks.reduce((n, s) => n + s.assets.length, 0)}</span>
            </button>
            {expanded && (
              <div className="inv-grid">
                {grp.stacks.map((s) => (
                  <ItemTile key={s.key} s={s} price={priceKey(s) ? prices[priceKey(s)!] : undefined} onOpen={onOpen} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
