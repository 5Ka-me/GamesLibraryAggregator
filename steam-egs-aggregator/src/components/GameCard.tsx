import React, { useState } from 'react';
import { api, Game, GameEntry, Source } from '../api/client';
import { useI18n } from '../i18n/I18nContext';

const tagBg: Record<Source, string> = {
  Steam: 'var(--accent)',
  Epic: 'var(--epic)',
};

const SourceTag: React.FC<{ source: Source }> = ({ source }) => (
  <span
    style={{
      padding: '1px 7px',
      borderRadius: 4,
      background: tagBg[source],
      color: 'var(--on-accent)',
      fontWeight: 700,
      fontSize: 11,
    }}
  >
    {source}
  </span>
);

const GameCard: React.FC<{ game: Game }> = ({ game }) => {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  // An EGS entry is clickable even without a ready link — resolved on click.
  const isLinkable = (e: GameEntry) => !!e.storeUrl || (e.source === 'Epic' && !!e.namespace);
  const linkable = game.entries.filter(isLinkable);

  const openEntry = (entry: GameEntry) => {
    if (entry.storeUrl) {
      window.open(entry.storeUrl, '_blank', 'noopener');
      return;
    }
    // The link isn't known yet — open a blank tab immediately (otherwise the popup blocker fires),
    // then set the exact URL once resolved.
    const w = window.open('', '_blank');
    api
      .resolveEpicStoreUrl(entry.namespace!, game.title)
      .then(({ url }) => {
        if (w) w.location.href = url;
      })
      .catch(() => w?.close());
  };

  const onClick = (e: React.MouseEvent) => {
    if (linkable.length === 0) return;
    if (linkable.length === 1) {
      openEntry(linkable[0]);
      return;
    }
    setMenu({ x: e.clientX, y: e.clientY }); // multiple stores — pick at the cursor
  };

  const choose = (entry: GameEntry) => {
    openEntry(entry);
    setMenu(null);
  };

  return (
    <>
      <div
        onClick={onClick}
        title={game.title}
        style={{
          width: 180,
          borderRadius: 8,
          overflow: 'hidden',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          boxShadow: '0 2px 8px var(--shadow)',
          display: 'flex',
          flexDirection: 'column',
          cursor: linkable.length ? 'pointer' : 'default',
        }}
      >
        <div
          style={{
            height: 100,
            background: 'var(--panel-2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {game.iconUrl ? (
            <img
              src={game.iconUrl}
              alt={game.title}
              loading="lazy"
              decoding="async"
              onLoad={() => setImgLoaded(true)}
              style={{
                maxHeight: '100%',
                maxWidth: '100%',
                objectFit: 'contain',
                opacity: imgLoaded ? 1 : 0,
                transition: 'opacity 0.3s ease',
              }}
            />
          ) : (
            <span style={{ opacity: 0.5, fontSize: 12 }}>{t('card.noImage')}</span>
          )}
        </div>

        <div style={{ padding: '8px 10px', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.2 }}>{game.title}</div>

          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {game.sources.map((s) => (
              <SourceTag key={s} source={s} />
            ))}
          </div>

          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {game.entries
              .filter((e) => e.playtimeMinutes != null && e.playtimeMinutes > 0)
              .map((e) => (
                <div key={e.source}>
                  {e.source}: {(e.playtimeMinutes! / 60).toFixed(1)} {t('card.hours')}
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Store-picker popover near the cursor */}
      {menu && (
        <div
          onClick={() => setMenu(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(menu.x, window.innerWidth - 180),
              top: Math.min(menu.y, window.innerHeight - 120),
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 4px 16px var(--shadow)',
              padding: 8,
              minWidth: 150,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--muted)', padding: '2px 6px 6px' }}>
              {t('store.choose')}
            </div>
            {linkable.map((e) => (
              <button
                key={e.source}
                onClick={() => choose(e)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  background: 'transparent',
                  color: 'var(--text)',
                  fontWeight: 600,
                }}
              >
                <SourceTag source={e.source} />
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
};

export default GameCard;
