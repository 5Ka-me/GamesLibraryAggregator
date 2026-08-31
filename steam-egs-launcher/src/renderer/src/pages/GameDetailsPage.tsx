import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  useI18n,
  useLibraryActions,
  openExternal,
  openDeepLink,
  normalizeTitle,
  epicAppName,
  steamAppId,
  sourceMeta,
  type Game,
  type GameEntry,
  type SteamGameAchievements,
} from '@app/shared';
import type { EpicDetails, GameDetails } from '../../../preload';
import { ctl, formatCents } from '../store/parts';
import ScreenshotViewer, { type ViewerShot } from '../components/ScreenshotViewer';

// Unified game page. Reached from the store (/store/app/:appid) or from a
// library card (/game with the Game in route state; works for Epic-only games).
//
// Layout: header (title + buy/open buttons) → platform tabs (Steam/Epic pick
// which storefront the info below comes from) → info card with a price
// comparison against the other platform → "Launch & install" → media →
// achievements (Steam tab only).

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 16,
  background: 'var(--panel)',
  marginBottom: 16,
};

const chip: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 5,
  background: 'var(--panel-2)',
  fontSize: 12,
  whiteSpace: 'nowrap',
};

const srcTag = (source: string): React.CSSProperties => ({
  padding: '1px 7px',
  borderRadius: 4,
  background: sourceMeta(source).color,
  color: 'var(--on-accent)',
  fontWeight: 700,
  fontSize: 11,
  whiteSpace: 'nowrap',
});


const MetaRow: React.FC<{ label: string; value?: string | null }> = ({ label, value }) =>
  value ? (
    <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
      <span style={{ color: 'var(--muted)', minWidth: 110 }}>{label}</span>
      <span>{value}</span>
    </div>
  ) : null;

// ---------- price comparison ----------

interface ComparablePrice {
  cents: number | null;
  currency?: string;
}

// Renderer-side memo of the main process's daily USD rates.
const fxMemo = new Map<string, Promise<number | null>>();
function usdRate(currency: string): Promise<number | null> {
  let p = fxMemo.get(currency);
  if (!p) {
    p = window.launcher.fxUsdRate(currency).catch(() => null);
    fxMemo.set(currency, p);
  }
  return p;
}

/**
 * Price difference vs the other platform. Same currency → exact, shown in that
 * currency. Different currencies (e.g. Steam UAH vs EGS KZT) → both converted
 * by the daily USD rate and shown as an approximate "≈ $X" (hidden when rates
 * are unavailable).
 */
const PriceDiff: React.FC<{
  current: ComparablePrice | null;
  other: ComparablePrice | null;
  otherLabel: string;
}> = ({ current, other, otherLabel }) => {
  const { t } = useI18n();
  const [usdDiffCents, setUsdDiffCents] = useState<number | null>(null);

  const comparable = current?.cents != null && other?.cents != null;
  const crossCurrency =
    comparable && !!current!.currency && !!other!.currency && current!.currency !== other!.currency;

  useEffect(() => {
    setUsdDiffCents(null);
    if (!crossCurrency) return;
    let alive = true;
    Promise.all([usdRate(current!.currency!), usdRate(other!.currency!)]).then(([ra, rb]) => {
      if (!alive || ra == null || rb == null) return;
      setUsdDiffCents(other!.cents! / rb - current!.cents! / ra);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossCurrency, current?.cents, current?.currency, other?.cents, other?.currency]);

  if (!comparable) return null;

  let diff: number;
  let amount: string;
  let approx = false;
  if (crossCurrency) {
    if (usdDiffCents == null) return null; // rates loading/unavailable
    diff = usdDiffCents;
    amount = `$${(Math.abs(diff) / 100).toFixed(2)}`;
    approx = true;
  } else {
    diff = other!.cents! - current!.cents!;
    amount = formatCents(Math.abs(diff), current!.currency ?? other!.currency) ?? '';
  }

  const tip = approx ? t('details.approxFx') : undefined;
  const prefix = approx ? '≈ ' : '';

  if (Math.abs(diff) < 1) {
    return (
      <span style={{ ...chip, color: 'var(--muted)' }} title={tip}>
        {prefix}= {t('details.samePrice', { p: otherLabel })}
      </span>
    );
  }
  return diff > 0 ? (
    <span style={{ ...chip, color: '#2ea043', fontWeight: 700 }} title={tip}>
      {prefix}↓ {t('details.cheaper', { d: amount, p: otherLabel })}
    </span>
  ) : (
    <span style={{ ...chip, color: '#ff6b6b', fontWeight: 700 }} title={tip}>
      {prefix}↑ {t('details.dearer', { d: amount, p: otherLabel })}
    </span>
  );
};

// Renders price chips (discount / struck original / final) for either platform.
// Unreleased games without a price show the release date instead.
const PriceChips: React.FC<{
  isFree?: boolean;
  discountPct?: number;
  formattedOriginal?: string | null;
  originalCents?: number | null;
  formattedFinal?: string | null;
  finalCents?: number | null;
  currency?: string;
  comingSoon?: boolean;
  releaseDate?: string | null;
}> = ({
  isFree,
  discountPct,
  formattedOriginal,
  originalCents,
  formattedFinal,
  finalCents,
  currency,
  comingSoon,
  releaseDate,
}) => {
  const { t } = useI18n();
  if (isFree) return <span style={chip}>{t('store.free')}</span>;
  const final = formattedFinal ?? formatCents(finalCents, currency);
  if (!final) {
    if (comingSoon || releaseDate) {
      return (
        <span style={{ ...chip, color: 'var(--muted)' }} title={t('details.comingSoon')}>
          📅 {releaseDate ?? t('details.comingSoon')}
        </span>
      );
    }
    return null;
  }
  return (
    <>
      {(discountPct ?? 0) > 0 && (
        <span style={{ ...chip, background: '#4c6b22', color: '#fff', fontWeight: 700 }}>-{discountPct}%</span>
      )}
      {(discountPct ?? 0) > 0 && (
        <span style={{ color: 'var(--muted)', textDecoration: 'line-through', fontSize: 13 }}>
          {formattedOriginal ?? formatCents(originalCents, currency)}
        </span>
      )}
      <span style={{ fontWeight: 700 }}>{final}</span>
    </>
  );
};

// ---------- per-platform launch/install actions ----------

const SteamEntryActions: React.FC<{ entry: GameEntry }> = ({ entry }) => {
  const { t } = useI18n();
  const actions = useLibraryActions();
  const id = steamAppId(entry);
  const installed = id ? actions?.getSteamState(id).installed ?? false : false;
  return (
    <>
      {installed && entry.launchUrl && (
        <button style={ctl} onClick={() => openDeepLink(entry.launchUrl!)}>
          ▶ {t('card.play')}
        </button>
      )}
      {!installed && entry.installUrl && (
        <button style={ctl} onClick={() => openDeepLink(entry.installUrl!)}>
          ⬇ {t('card.install')}
        </button>
      )}
    </>
  );
};

const EpicEntryActions: React.FC<{ entry: GameEntry; title: string }> = ({ entry, title }) => {
  const { t } = useI18n();
  const actions = useLibraryActions();
  const appName = epicAppName(entry);
  if (!actions || !appName) return null;
  const state = actions.getEpicState(appName);

  if (state.installing) {
    const pct = Math.round(state.progressPct ?? 0);
    return (
      <>
        <div
          title={`${pct}%`}
          style={{ position: 'relative', width: 120, height: 8, borderRadius: 4, background: 'var(--panel-2)' }}
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
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{pct}%</span>
        <button style={ctl} onClick={() => actions.cancelEpic(appName)}>
          ✕ {t('card.cancel')}
        </button>
      </>
    );
  }
  if (state.installed) {
    return (
      <>
        <button style={ctl} onClick={() => actions.launchEpic(appName)}>
          ▶ {t('card.play')}
        </button>
        <button style={ctl} onClick={() => actions.uninstallEpic(appName)}>
          🗑 {t('card.uninstall')}
        </button>
      </>
    );
  }
  return (
    <button style={ctl} onClick={() => actions.installEpic(appName, title)}>
      ⬇ {t('card.install')}
    </button>
  );
};

/**
 * Unified per-platform section, shown for every game. Laid out as a grid
 * (tag | actions | price/hours + diff) so rows line up:
 *   owned          → Install / Play, hours in the meta column;
 *   not owned      → Buy (platform store page), price + diff vs the other one;
 *   not on platform → muted note.
 */
const LaunchInstallSection: React.FC<{
  title: string;
  appid: number | null;
  details: GameDetails | null;
  epic: EpicDetails | null;
  steamEntry: GameEntry | null;
  epicEntry: GameEntry | null;
  steamPrice: ComparablePrice | null;
  epicPrice: ComparablePrice | null;
  steamPending: boolean;
  epicPending: boolean;
}> = ({ title, appid, details, epic, steamEntry, epicEntry, steamPrice, epicPrice, steamPending, epicPending }) => {
  const { t } = useI18n();

  const tagCell: React.CSSProperties = { display: 'flex', alignItems: 'center' };
  const actionsCell: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
  const metaCell: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    fontSize: 13,
  };
  const absentCell: React.CSSProperties = {
    gridColumn: '2 / -1',
    color: 'var(--muted)',
    fontSize: 13,
  };

  const hours = (entry: GameEntry | null) =>
    (entry?.playtimeMinutes ?? 0) > 0 ? (
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
        ⏱ {((entry!.playtimeMinutes ?? 0) / 60).toFixed(1)} {t('details.hours')}
      </span>
    ) : null;

  // One grid row per platform. `null` cells collapse into an absence note.
  const row = (
    platform: PlatformTab,
    pending: boolean,
    available: boolean,
    actions: React.ReactNode,
    meta: React.ReactNode
  ) => (
    <React.Fragment key={platform}>
      <span style={tagCell}>
        <span style={srcTag(platform)}>{platform}</span>
      </span>
      {pending ? (
        <div style={absentCell}>…</div>
      ) : !available ? (
        <div style={absentCell}>✕ {t('details.notOnPlatform')}</div>
      ) : (
        <>
          <div style={actionsCell}>{actions}</div>
          <div style={metaCell}>{meta}</div>
        </>
      )}
    </React.Fragment>
  );

  return (
    <div style={card}>
      <h3 style={{ marginTop: 0 }}>{t('details.actions')}</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '64px minmax(150px, max-content) 1fr',
          gap: '12px 16px',
          alignItems: 'center',
        }}
      >
        {row(
          'Steam',
          steamPending,
          appid != null || steamEntry != null,
          steamEntry ? (
            <SteamEntryActions entry={steamEntry} />
          ) : (
            <button
              style={{ ...ctl, background: 'var(--accent)', color: 'var(--on-accent)' }}
              onClick={() => appid != null && window.launcher.storeOpenPage(appid)}
            >
              🛒 {t('details.buy')}
            </button>
          ),
          steamEntry ? (
            hours(steamEntry)
          ) : (
            <>
              <PriceChips
                isFree={details?.isFree}
                discountPct={details?.price?.discountPct}
                formattedOriginal={details?.price?.formattedOriginal}
                originalCents={details?.price?.initial}
                formattedFinal={details?.price?.formattedFinal}
                finalCents={details?.price?.final}
                currency={details?.price?.currency}
                comingSoon={details?.comingSoon}
                releaseDate={details?.releaseDate}
              />
              <PriceDiff current={steamPrice} other={epicPrice} otherLabel="Epic" />
            </>
          )
        )}
        {row(
          'Epic',
          epicPending,
          epic != null || epicEntry != null,
          epicEntry ? (
            <EpicEntryActions entry={epicEntry} title={title} />
          ) : (
            <button
              style={{ ...ctl, background: 'var(--epic)', color: 'var(--on-accent)' }}
              onClick={() => epic?.storeUrl && openExternal(epic.storeUrl)}
            >
              🛒 {t('details.buy')}
            </button>
          ),
          epicEntry ? (
            hours(epicEntry)
          ) : (
            <>
              <PriceChips
                isFree={epic?.isFree}
                discountPct={epic?.price?.discountPct}
                formattedOriginal={epic?.price?.formattedOriginal}
                originalCents={epic?.price?.initial}
                formattedFinal={epic?.price?.formattedFinal}
                finalCents={epic?.price?.final}
                currency={epic?.price?.currency}
                releaseDate={epic?.releaseDate}
              />
              <PriceDiff current={epicPrice} other={steamPrice} otherLabel="Steam" />
            </>
          )
        )}
      </div>
    </div>
  );
};

// ---------- Steam achievements ----------

const AchievementsBlock: React.FC<{ appid: number }> = ({ appid }) => {
  const { t, lang } = useI18n();
  const [data, setData] = useState<SteamGameAchievements | null>(null);
  const [failed, setFailed] = useState(false);
  // Hidden achievements revealed by the user (per game visit, like Steam).
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Reset first: without it the previous game's achievements stay on screen
    // while the new ones load, and one failure would stick forever.
    let alive = true;
    setData(null);
    setFailed(false);
    setRevealed(new Set());
    api
      .getSteamAchievements(appid, lang)
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [appid, lang]);

  if (failed || (data && !data.available)) {
    return <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('details.achUnavailable')}</p>;
  }
  if (!data) return <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>;

  const pct = data.total > 0 ? Math.round((data.unlocked / data.total) * 100) : 0;
  const sorted = [...data.achievements].sort((a, b) => {
    if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
    if (a.unlocked) return (b.unlockTime ?? '').localeCompare(a.unlockTime ?? '');
    return (b.globalPct ?? 0) - (a.globalPct ?? 0);
  });

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--panel-2)', position: 'relative' }}>
          <div
            style={{ position: 'absolute', inset: 0, width: `${pct}%`, borderRadius: 4, background: 'var(--accent)' }}
          />
        </div>
        <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
          {t('details.achProgress', { u: data.unlocked, t: data.total })}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {sorted.map((a) => {
          // Hidden + locked achievements are masked (like Steam): a "?" tile
          // that reveals icon/name/description on click.
          const masked = !!a.hidden && !a.unlocked && !revealed.has(a.name);
          if (masked) {
            return (
              <div
                key={a.name}
                title={t('details.hiddenAch')}
                onClick={() => setRevealed((prev) => new Set(prev).add(a.name))}
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 4,
                  background: 'var(--panel-2)',
                  border: '1px dashed var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--muted)',
                  fontSize: 20,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                ?
              </div>
            );
          }

          const icon = a.unlocked ? a.icon : a.iconGray ?? a.icon;
          const tip = `${a.displayName ?? a.name}${a.description ? ` — ${a.description}` : ''}${
            a.globalPct != null ? ` (${a.globalPct.toFixed(1)}%)` : ''
          }`;
          return (
            <div key={a.name} title={tip} style={{ opacity: a.unlocked ? 1 : 0.45 }}>
              {icon ? (
                <img
                  src={icon}
                  alt={a.displayName ?? a.name}
                  width={48}
                  height={48}
                  style={{ borderRadius: 4, display: 'block' }}
                />
              ) : (
                <div style={{ width: 48, height: 48, borderRadius: 4, background: 'var(--panel-2)' }} />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
};

// ---------- page ----------

type PlatformTab = 'Steam' | 'Epic';

const GameDetailsPage: React.FC = () => {
  const params = useParams();
  const location = useLocation() as { state?: { game?: Game } };
  const navigate = useNavigate();
  const { t, lang } = useI18n();

  const stateGame = location.state?.game ?? null;

  // Steam appid: from the URL (store visits) or the library game's entry; for
  // games known only from EGS it is resolved by a title search below.
  const paramAppid = params.appid ? parseInt(params.appid, 10) : null;
  const stateSteamId = stateGame
    ? stateGame.entries.map(steamAppId).find((x): x is string => !!x) ?? null
    : null;
  const knownAppid = paramAppid ?? (stateSteamId ? parseInt(stateSteamId, 10) : null);

  const [foundAppid, setFoundAppid] = useState<number | null>(null);
  const [steamLookupDone, setSteamLookupDone] = useState(knownAppid != null);
  const appid = knownAppid ?? foundAppid;

  const [details, setDetails] = useState<GameDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epic, setEpic] = useState<EpicDetails | null>(null);
  const [epicLoaded, setEpicLoaded] = useState(false);
  const [library, setLibrary] = useState<Game[] | null>(null);
  const [tab, setTab] = useState<PlatformTab>(knownAppid != null ? 'Steam' : 'Epic');
  // In-app screenshot lightbox (set = open at that index of those shots).
  const [viewer, setViewer] = useState<{ shots: ViewerShot[]; index: number } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getCombinedLibrary()
      .then((l) => alive && setLibrary(l))
      .catch(() => alive && setLibrary([]));
    return () => {
      alive = false;
    };
  }, []);

  // Each async lookup below guards with `alive` so a slower earlier response
  // can't overwrite the state of the game the user is looking at now.
  useEffect(() => {
    let alive = true;
    setDetails(null);
    setError(null);
    if (appid != null) {
      window.launcher
        .storeAppDetails(appid, lang)
        .then((d) => alive && setDetails(d))
        .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    }
    return () => {
      alive = false;
    };
  }, [appid, lang]);

  // The library game backing this page (for actions & the Epic namespace).
  const libGame =
    stateGame ??
    (library
      ? library.find(
          (g) => appid != null && g.entries.some((e) => steamAppId(e) === String(appid))
        ) ??
        (details ? library.find((g) => normalizeTitle(g.title) === normalizeTitle(details.name)) : null) ??
        null
      : null);

  const title = details?.name ?? libGame?.title ?? null;
  const epicEntry = libGame?.entries.find((e) => e.source === 'Epic') ?? null;
  const steamEntry = libGame?.entries.find((e) => e.source === 'Steam') ?? null;

  // Games known only from EGS: try to find their Steam version by title so the
  // Steam tab / price comparison work for them too (strict title matching).
  useEffect(() => {
    if (knownAppid != null) return;
    // No title yet (library still loading, or it failed) → nothing to look up,
    // but the lookup must be marked done or the tab would spin forever.
    if (!title) {
      setSteamLookupDone(library !== null);
      return;
    }
    let alive = true;
    setSteamLookupDone(false);
    window.launcher
      .storeFindAppId(title, lang)
      .then((id) => alive && setFoundAppid(id))
      .catch(() => alive && setFoundAppid(null))
      .finally(() => alive && setSteamLookupDone(true));
    return () => {
      alive = false;
    };
  }, [knownAppid, title, lang, library]);

  // Epic offer lookup: by namespace for library games, by title otherwise.
  // Runs once the title is known (works for not-owned games too).
  useEffect(() => {
    if (!title) {
      setEpicLoaded(library !== null);
      return;
    }
    let alive = true;
    setEpic(null);
    setEpicLoaded(false);
    window.launcher
      .epicStoreDetails(title, epicEntry?.namespace ?? null, lang)
      .then((d) => alive && setEpic(d))
      .catch(() => alive && setEpic(null))
      .finally(() => alive && setEpicLoaded(true));
    return () => {
      alive = false;
    };
  }, [title, epicEntry?.namespace, lang, library]);

  // Per-platform availability for the tab switcher. Both tabs are always
  // rendered; a platform where the game genuinely doesn't exist is disabled
  // with a "not on this platform" mark. `pending` = lookup still running.
  const platformState: Record<PlatformTab, { pending: boolean; available: boolean }> = {
    Steam: { pending: !steamLookupDone, available: appid != null },
    Epic: { pending: !epicLoaded, available: !!(epic || epicEntry) },
  };

  const availableTabs = useMemo(() => {
    const list: PlatformTab[] = [];
    if (platformState.Steam.available) list.push('Steam');
    if (platformState.Epic.available) list.push('Epic');
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformState.Steam.available, platformState.Epic.available]);

  useEffect(() => {
    if (availableTabs.length && !availableTabs.includes(tab)) setTab(availableTabs[0]);
  }, [availableTabs, tab]);

  // Comparable prices (cents + currency) per platform for the diff badge.
  const steamPrice: ComparablePrice | null = details
    ? details.isFree
      ? { cents: 0, currency: details.price?.currency }
      : details.price?.final != null
        ? { cents: details.price.final, currency: details.price.currency }
        : null
    : null;
  const epicPrice: ComparablePrice | null = epic?.price
    ? { cents: epic.price.final, currency: epic.price.currency }
    : null;

  const openEpicStore = () => {
    if (epic?.storeUrl) {
      openExternal(epic.storeUrl);
      return;
    }
    if (epicEntry?.namespace && libGame) {
      api
        .resolveEpicStoreUrl(epicEntry.namespace, libGame.title)
        .then(({ url }) => openExternal(url))
        .catch(() => undefined);
    }
  };

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 20px' }}>
      {/* Header: back, title, per-platform store buttons (buy / open) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <button style={ctl} onClick={() => navigate(-1)}>
          ←
        </button>
        <h2 style={{ margin: 0, flex: 1, minWidth: 0 }}>{title ?? '…'}</h2>
        {appid != null && (
          <button
            style={{ ...ctl, background: 'var(--accent)', color: 'var(--on-accent)' }}
            onClick={() => window.launcher.storeOpenPage(appid)}
          >
            {t('details.openInSteam')}
          </button>
        )}
        {(epic?.storeUrl || epicEntry?.namespace) && (
          <button
            style={{ ...ctl, background: 'var(--epic)', color: 'var(--on-accent)' }}
            onClick={openEpicStore}
          >
            {t('details.openInEpic')}
          </button>
        )}
      </div>

      {/* Platform switcher: both tabs always visible; a platform the game
          doesn't exist on is disabled and marked. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {(['Steam', 'Epic'] as PlatformTab[]).map((p) => {
          const st = platformState[p];
          const absent = !st.pending && !st.available;
          return (
            <button
              key={p}
              onClick={() => st.available && setTab(p)}
              disabled={!st.available}
              title={absent ? t('details.notOnPlatform') : p}
              style={{
                ...ctl,
                background: tab === p && st.available ? sourceMeta(p).color : 'var(--panel)',
                color: tab === p && st.available ? 'var(--on-accent)' : 'var(--text)',
                opacity: absent ? 0.55 : 1,
                cursor: st.available ? 'pointer' : 'default',
              }}
            >
              {p}
              {st.pending ? ' …' : absent ? ` — ${t('details.notOnPlatform')}` : ''}
            </button>
          );
        })}
      </div>

      {error && tab === 'Steam' && (
        <p style={{ color: '#ff6b6b' }}>
          {t('common.error')}: {error}
        </p>
      )}

      {/* ===== Info card (per selected platform) ===== */}
      {tab === 'Steam' && appid != null && !details && !error && (
        <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>
      )}

      {tab === 'Steam' && details && (
        <div style={{ ...card, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {(details.headerImage ?? libGame?.iconUrl) && (
            <img
              src={details.headerImage ?? libGame?.iconUrl ?? undefined}
              alt={details.name}
              style={{ width: 380, maxWidth: '100%', borderRadius: 8, alignSelf: 'flex-start' }}
            />
          )}
          <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {details.shortDescription && (
              <p style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--muted)' }}>{details.shortDescription}</p>
            )}
            <MetaRow
              label={t('details.release')}
              value={details.comingSoon ? `${t('details.comingSoon')} — ${details.releaseDate ?? ''}` : details.releaseDate}
            />
            <MetaRow label={t('details.developer')} value={details.developers.join(', ') || null} />
            <MetaRow label={t('details.publisher')} value={details.publishers.join(', ') || null} />
            <MetaRow label={t('details.genres')} value={details.genres.join(', ') || null} />
            <MetaRow label={t('details.tags')} value={details.tags.join(', ') || null} />
            <MetaRow label={t('details.platforms')} value={details.platforms.join(', ') || null} />
            {details.metacritic != null && <MetaRow label={t('details.metacritic')} value={String(details.metacritic)} />}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <PriceChips
                isFree={details.isFree}
                discountPct={details.price?.discountPct}
                formattedOriginal={details.price?.formattedOriginal}
                originalCents={details.price?.initial}
                formattedFinal={details.price?.formattedFinal}
                finalCents={details.price?.final}
                currency={details.price?.currency}
                comingSoon={details.comingSoon}
                releaseDate={details.releaseDate}
              />
              <PriceDiff current={steamPrice} other={epicPrice} otherLabel="Epic" />
              {details.reviewScoreDesc && (
                <span style={chip} title={`${details.reviewTotalPositive ?? '?'} / ${details.reviewTotal ?? '?'}`}>
                  {t('details.reviews')}: {details.reviewScoreDesc}
                </span>
              )}
              {details.currentPlayers != null && (
                <span style={chip}>
                  👥 {details.currentPlayers.toLocaleString()} {t('details.playersNow')}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'Epic' && !epicLoaded && <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>}

      {tab === 'Epic' && epicLoaded && (
        <div style={{ ...card, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {(epic?.image ?? libGame?.iconUrl) && (
            <img
              src={epic?.image ?? libGame?.iconUrl ?? undefined}
              alt={title ?? ''}
              style={{ width: 380, maxWidth: '100%', borderRadius: 8, alignSelf: 'flex-start' }}
            />
          )}
          <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {epic?.description && (
              <p style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--muted)' }}>{epic.description}</p>
            )}
            {epic ? (
              <>
                <MetaRow label={t('details.release')} value={epic.releaseDate} />
                <MetaRow label={t('details.developer')} value={epic.developer ?? null} />
                <MetaRow label={t('details.publisher')} value={epic.publisher ?? null} />
                <MetaRow label={t('details.genres')} value={epic.genres.join(', ') || null} />
                <MetaRow label={t('details.platforms')} value={epic.platforms.join(', ') || null} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                  <PriceChips
                    isFree={epic.isFree}
                    discountPct={epic.price?.discountPct}
                    formattedOriginal={epic.price?.formattedOriginal}
                    originalCents={epic.price?.initial}
                    formattedFinal={epic.price?.formattedFinal}
                    finalCents={epic.price?.final}
                    currency={epic.price?.currency}
                    releaseDate={epic.releaseDate}
                  />
                  <PriceDiff current={epicPrice} other={steamPrice} otherLabel="Steam" />
                  {epic.rating != null && (
                    <span style={chip} title={t('details.rating')}>
                      ★ {epic.rating.toFixed(1)} / 5
                    </span>
                  )}
                </div>
              </>
            ) : (
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('details.epicNoData')}</p>
            )}
          </div>
        </div>
      )}

      {/* ===== Launch & install (below the description, all games) ===== */}
      <LaunchInstallSection
        title={title ?? ''}
        appid={appid}
        details={details}
        epic={epic}
        steamEntry={steamEntry}
        epicEntry={epicEntry}
        steamPrice={steamPrice}
        epicPrice={epicPrice}
        steamPending={platformState.Steam.pending}
        epicPending={platformState.Epic.pending}
      />

      {/* ===== Media (per selected platform) ===== */}
      {tab === 'Steam' && details?.movieWebm && (
        <div style={card}>
          <video
            controls
            preload="none"
            poster={details.moviePoster ?? undefined}
            src={details.movieWebm}
            style={{ width: '100%', maxHeight: 420, borderRadius: 8, background: '#000' }}
          />
        </div>
      )}

      {tab === 'Steam' && details && details.screenshots.length > 0 && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>{t('details.screenshots')}</h3>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 }}>
            {details.screenshots.map((s, i) => (
              <img
                key={i}
                src={s.thumb}
                alt={`${details.name} ${i + 1}`}
                loading="lazy"
                onClick={() =>
                  setViewer({
                    shots: details.screenshots.map((x) => ({ thumb: x.thumb, full: x.full })),
                    index: i,
                  })
                }
                style={{ height: 110, borderRadius: 6, cursor: 'pointer', flex: '0 0 auto' }}
              />
            ))}
          </div>
        </div>
      )}

      {tab === 'Epic' && epic && epic.images.length > 0 && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>{t('details.screenshots')}</h3>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 }}>
            {epic.images.map((url, i) => (
              <img
                key={i}
                src={url}
                alt={`${title} ${i + 1}`}
                loading="lazy"
                onClick={() =>
                  setViewer({ shots: epic.images.map((u) => ({ thumb: u, full: u })), index: i })
                }
                style={{ height: 110, borderRadius: 6, cursor: 'pointer', flex: '0 0 auto' }}
              />
            ))}
          </div>
        </div>
      )}

      {/* ===== Achievements (Steam data only) ===== */}
      {tab === 'Steam' && appid != null && (details?.achievementsTotal ?? 0) > 0 && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>{t('details.achievements')}</h3>
          <AchievementsBlock appid={appid} />
        </div>
      )}

      {/* In-app screenshot lightbox */}
      {viewer && (
        <ScreenshotViewer
          shots={viewer.shots}
          initialIndex={viewer.index}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
};

export default GameDetailsPage;
