import React, { useState } from 'react';
import { api, Game, GameEntry, Source } from '../api/client';
import { useI18n } from '../i18n/I18nContext';
import { getOpenGameDetails, hasDeepLinkHandler, openDeepLink, openExternal } from '../platform';
import { LibraryActions, useLibraryActions } from '../libraryActions';
import { epicAppName } from '../epicUtil';
import { steamAppId } from '../steamUtil';
import { installedSources } from '../installState';
import { sourceMeta } from '../sources';

const pillBtn: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 5,
  border: '1px solid var(--border)',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  fontSize: 12,
  fontWeight: 600,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

const SourceTag: React.FC<{ source: Source; installed?: boolean }> = ({ source, installed }) => (
  <span
    title={installed ? `${source} — installed` : source}
    style={{
      padding: '1px 7px',
      borderRadius: 4,
      background: sourceMeta(source).color,
      color: 'var(--on-accent)',
      fontWeight: 700,
      fontSize: 11,
      // A leading check marks a source that's installed on this machine.
      boxShadow: installed ? '0 0 0 1.5px #2ea043' : undefined,
    }}
  >
    {installed ? '✓ ' : ''}
    {source}
  </span>
);

// Compact ownership badge for the capsule corner (ST / EGS), colored per store.
const SourceBadge: React.FC<{ source: Source; installed?: boolean }> = ({ source, installed }) => {
  const color = sourceMeta(source).color;
  return (
    <span
      title={installed ? `${source} — installed` : source}
      style={{
        background: 'rgba(13, 20, 31, 0.85)',
        border: `1px solid ${color}`,
        color,
        fontSize: 9.5,
        fontWeight: 800,
        borderRadius: 4,
        padding: '2px 5px',
        letterSpacing: 0.4,
      }}
    >
      {installed ? '✓ ' : ''}
      {source === 'Steam' ? 'ST' : source === 'Epic' ? 'EGS' : source}
    </span>
  );
};

// Protocol deep-link (steam:// / com.epicgames.launcher://) rendered as a small pill button.
// On the web it's a plain anchor; in the launcher we intercept the click and hand the URL to
// the main process so the OS protocol handler fires reliably.
// stopPropagation so it doesn't also trigger the card's store-open click.
const ActionLink: React.FC<{ href: string; title: string; children: React.ReactNode }> = ({
  href,
  title,
  children,
}) => (
  <a
    href={href}
    title={title}
    onClick={(e) => {
      e.stopPropagation();
      if (hasDeepLinkHandler()) {
        e.preventDefault();
        openDeepLink(href);
      }
    }}
    rel="noreferrer"
    style={{
      padding: '2px 8px',
      borderRadius: 5,
      border: '1px solid var(--border)',
      background: 'var(--panel-2)',
      color: 'var(--text)',
      textDecoration: 'none',
      fontSize: 12,
      fontWeight: 600,
      lineHeight: '18px',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </a>
);

// Managed EGS actions (install/download/launch/uninstall via legendary), shown
// only when the host injected a LibraryActions manager (i.e. in the launcher).
const EpicManagedActions: React.FC<{ actions: LibraryActions; appName: string; title: string }> = ({
  actions,
  appName,
  title,
}) => {
  const { t } = useI18n();
  const state = actions.getEpicState(appName);

  if (state.installing) {
    const pct = Math.round(state.progressPct ?? 0);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        <div
          title={`${pct}%`}
          style={{ position: 'relative', width: 70, height: 8, borderRadius: 4, background: 'var(--panel-2)' }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              width: `${pct}%`,
              background: 'var(--epic)',
              borderRadius: 4,
              transition: 'width 0.2s ease',
            }}
          />
        </div>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{pct}%</span>
        <button style={pillBtn} onClick={() => actions.cancelEpic(appName)}>
          ✕ {t('card.cancel')}
        </button>
      </div>
    );
  }

  if (state.installed) {
    return (
      <>
        <button style={pillBtn} onClick={() => actions.launchEpic(appName)}>
          ▶ {t('card.play')}
        </button>
        <button style={pillBtn} onClick={() => actions.uninstallEpic(appName)}>
          🗑 {t('card.uninstall')}
        </button>
      </>
    );
  }

  return (
    <button style={pillBtn} onClick={() => actions.installEpic(appName, title)}>
      ⬇ {t('card.install')}
    </button>
  );
};

// Steam actions stay as native deep links; install-state just decides whether
// to show Play (installed) or Install (not installed).
const SteamActions: React.FC<{ entry: GameEntry; actions: LibraryActions; appId: string }> = ({
  entry,
  actions,
  appId,
}) => {
  const { t } = useI18n();
  const installed = actions.getSteamState(appId).installed;

  if (installed && entry.launchUrl) {
    return (
      <ActionLink href={entry.launchUrl} title={`${t('card.play')} — Steam`}>
        ▶ {t('card.play')}
      </ActionLink>
    );
  }
  if (!installed && entry.installUrl) {
    return (
      <ActionLink href={entry.installUrl} title={`${t('card.install')} — Steam`}>
        ⬇ {t('card.install')}
      </ActionLink>
    );
  }
  return null;
};

// Renders the action row for a single source entry: managed EGS controls and
// Steam install-state when a manager is present (launcher), otherwise native
// deep links (the web). In `compact` mode (hosts with a game-details page)
// only a Play affordance for installed games is shown — install/uninstall and
// download progress live on the details page.
const EntryActions: React.FC<{
  entry: GameEntry;
  title: string;
  showLabel: boolean;
  compact: boolean;
}> = ({ entry, title, showLabel, compact }) => {
  const { t } = useI18n();
  const actions = useLibraryActions();
  const epicName = epicAppName(entry);
  const steamId = steamAppId(entry);

  if (compact) {
    if (entry.source === 'Epic' && actions && epicName) {
      if (!actions.getEpicState(epicName).installed) return null;
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          {showLabel && <SourceTag source={entry.source} />}
          <button
            style={pillBtn}
            onClick={(e) => {
              e.stopPropagation();
              actions.launchEpic(epicName);
            }}
          >
            ▶ {t('card.play')}
          </button>
        </div>
      );
    }
    if (entry.source === 'Steam' && actions && steamId) {
      if (!actions.getSteamState(steamId).installed || !entry.launchUrl) return null;
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          {showLabel && <SourceTag source={entry.source} />}
          <ActionLink href={entry.launchUrl} title={`${t('card.play')} — Steam`}>
            ▶ {t('card.play')}
          </ActionLink>
        </div>
      );
    }
    return null;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
      {showLabel && <SourceTag source={entry.source} />}
      {entry.source === 'Epic' && actions && epicName ? (
        <EpicManagedActions actions={actions} appName={epicName} title={title} />
      ) : entry.source === 'Steam' && actions && steamId ? (
        <SteamActions entry={entry} actions={actions} appId={steamId} />
      ) : (
        <>
          {entry.launchUrl && (
            <ActionLink href={entry.launchUrl} title={`${t('card.play')} — ${entry.source}`}>
              ▶ {t('card.play')}
            </ActionLink>
          )}
          {entry.installUrl && (
            <ActionLink href={entry.installUrl} title={`${t('card.install')} — ${entry.source}`}>
              ⬇ {t('card.install')}
            </ActionLink>
          )}
        </>
      )}
    </div>
  );
};

const GameCard: React.FC<{ game: Game }> = ({ game }) => {
  const { t } = useI18n();
  const actions = useLibraryActions();
  const openDetails = getOpenGameDetails();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  // Cover with graceful degradation: the stored art, then Steam's header.jpg
  // (for the rare app without library_600x900), then the "no image" placeholder.
  const steamArtId = (() => {
    const entry = game.entries.find((e) => e.source === 'Steam');
    return entry ? steamAppId(entry) : null;
  })();
  const covers = [
    game.iconUrl,
    steamArtId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamArtId}/header.jpg` : null,
  ].filter((u): u is string => !!u);
  const [coverIdx, setCoverIdx] = useState(0);
  const cover = covers[coverIdx] ?? null;

  const installedSrc = actions ? installedSources(game, actions) : [];

  // An EGS entry is clickable even without a ready link — resolved on click.
  const isLinkable = (e: GameEntry) => !!e.storeUrl || (e.source === 'Epic' && !!e.namespace);
  const linkable = game.entries.filter(isLinkable);

  const openEntry = (entry: GameEntry) => {
    if (entry.storeUrl) {
      openExternal(entry.storeUrl);
      return;
    }
    // The EGS link isn't known yet — resolve it, then open.
    if (hasDeepLinkHandler()) {
      // Launcher: no popup blocker — resolve then open in the external browser.
      api
        .resolveEpicStoreUrl(entry.namespace!, game.title)
        .then(({ url }) => openExternal(url))
        .catch(() => {
          /* ignore */
        });
      return;
    }
    // Web: open a blank tab immediately (otherwise the popup blocker fires),
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
    // Hosts with a details page (the launcher): the card opens it.
    if (openDetails) {
      openDetails(game);
      return;
    }
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

  const totalMinutes = game.entries.reduce((sum, e) => sum + (e.playtimeMinutes ?? 0), 0);
  const actionable = game.entries.filter((e) => e.launchUrl || e.installUrl);
  const showSourceLabel = game.sources.length > 1; // label per-source only when ambiguous

  const statusLine = [
    totalMinutes > 0 ? `${(totalMinutes / 60).toFixed(totalMinutes >= 600 ? 0 : 1)} ${t('card.hours')}` : null,
    installedSrc.length > 0 ? t('card.installed') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      {/* Steam-style capsule: cover art + corner ownership badges; title,
          playtime and actions live in the hover overlay. */}
      <div className="gcard" title={game.title} onClick={onClick}>
        {cover ? (
          <img
            className="gcard-cover"
            src={cover}
            alt={game.title}
            loading="lazy"
            decoding="async"
            onLoad={() => setImgLoaded(true)}
            onError={() => {
              setImgLoaded(false);
              setCoverIdx((i) => i + 1); // next fallback (or the placeholder)
            }}
            style={{ opacity: imgLoaded ? 1 : 0, transition: 'opacity 0.3s ease' }}
          />
        ) : (
          <div className="gcard-placeholder">{game.title}</div>
        )}

        <div className="gcard-badges">
          {game.sources.map((s) => (
            <SourceBadge key={s} source={s} installed={installedSrc.includes(s)} />
          ))}
        </div>

        <div className="gcard-overlay">
          <div style={{ fontWeight: 700, fontSize: 13, color: '#ffffff', lineHeight: 1.25 }}>
            {game.title}
          </div>
          {statusLine && (
            <div style={{ fontSize: 11, color: installedSrc.length ? 'var(--success, #9fd48e)' : '#b6c4d6' }}>
              {statusLine}
            </div>
          )}
          {actionable.length > 0 && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}
            >
              {actionable.map((e) => (
                <EntryActions
                  key={e.source}
                  entry={e}
                  title={game.title}
                  showLabel={showSourceLabel}
                  compact={!!openDetails}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Store-picker popover near the cursor */}
      {menu && (
        <div onClick={() => setMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000 }}>
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
            <div style={{ fontSize: 12, color: 'var(--muted)', padding: '2px 6px 6px' }}>{t('store.choose')}</div>
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
