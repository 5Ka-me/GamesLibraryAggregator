import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api,
  useI18n,
  sourceMeta,
  SOURCES,
  SOURCE_IDS,
  steamAppId,
  epicAppName,
  type Game,
  type Source,
  type SteamRecentGame,
  type SteamAchievementProgress,
  type PlaytimeHistory,
} from '@app/shared';

// Statistics — two tabs.
//   Overview: a Steam-Replay-like dashboard computed locally from data the
//     launcher already holds (library playtimes, last-launch dates, the batched
//     achievement progress, the daily playtime snapshots). Nothing here talks
//     to the stores directly — the page must stay cheap on the user's tokens.
//   All games: the whole library as Steam's profile "Games" page — capsule,
//     hours, last launch, achievement bar — rendered in batches of 60.
// Period is honest: Steam has no per-day history, so "this year" means games
// launched this year (lifetime hours), "2 weeks" uses Steam's exact figure.

type Period = 'all' | 'year' | '2w';
type Tab = 'overview' | 'games';
type GamesSort = 'hours' | 'name' | 'lastPlayed' | 'ach';

const ALL: Source[] = [...SOURCE_IDS];
const PAGE = 60;
const FORGOTTEN_DAYS = 180;
const CHART: Record<Source, string> = { Steam: 'var(--chart-steam)', Epic: 'var(--chart-epic)' };

// ---------- module caches (navigation back = instant) ----------
let cachedGames: Game[] | null = null;
let cachedRecent: SteamRecentGame[] | null = null;
let cachedProgress: { key: string; map: Map<number, SteamAchievementProgress> } | null = null;
let cachedHistory: PlaytimeHistory | null = null;

// ---------- rows ----------

interface Row {
  game: Game;
  title: string;
  steamId: string | null;
  epicName: string | null;
  cover: string | null;
  header: string | null;
  sources: Source[];
  minutes: number;
  bySource: { source: Source; minutes: number }[];
  lastPlayedAt: string | null;
  min2w: number;
  deckMinutes: number;
  progress: SteamAchievementProgress | null;
}

function buildRows(
  games: Game[],
  sel: Source[],
  recent: Map<number, number>,
  progress: Map<number, SteamAchievementProgress>
): Row[] {
  const rows: Row[] = [];
  for (const g of games) {
    const entries = g.entries.filter((e) => sel.includes(e.source));
    if (!entries.length) continue;
    const steamEntry = entries.find((e) => e.source === 'Steam') ?? null;
    const steamId = steamEntry ? steamAppId(steamEntry) : null;
    const epicEntry = entries.find((e) => e.source === 'Epic') ?? null;
    const bySource = entries
      .filter((e) => (e.playtimeMinutes ?? 0) > 0)
      .map((e) => ({ source: e.source, minutes: e.playtimeMinutes! }));
    const minutes = bySource.reduce((s, e) => s + e.minutes, 0);
    const lastPlayedAt =
      entries.map((e) => e.lastPlayedAt).filter((x): x is string => !!x).sort().pop() ?? null;
    const appid = steamId ? parseInt(steamId, 10) : NaN;
    rows.push({
      game: g,
      title: g.title,
      steamId,
      epicName: epicEntry ? epicAppName(epicEntry) : null,
      cover: g.iconUrl ?? null,
      header: steamId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamId}/header.jpg` : g.iconUrl ?? null,
      sources: [...new Set(entries.map((e) => e.source))],
      minutes,
      bySource,
      lastPlayedAt,
      min2w: (steamEntry?.playtime2WeeksMinutes ?? 0) || (Number.isFinite(appid) ? recent.get(appid) ?? 0 : 0),
      deckMinutes: steamEntry?.playtimeDeckMinutes ?? 0,
      progress: Number.isFinite(appid) ? progress.get(appid) ?? null : null,
    });
  }
  return rows;
}

const hours = (min: number): string => {
  const h = min / 60;
  return h >= 100 ? Math.round(h).toString() : h >= 10 ? h.toFixed(1) : h.toFixed(1);
};
const pct = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 100) : 0);

function useRelativeDate(lang: string): (iso: string | null) => string {
  const { t } = useI18n();
  return useCallback(
    (iso) => {
      if (!iso) return t('stats.never');
      const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
      const rtf = new Intl.RelativeTimeFormat(lang === 'ru' ? 'ru' : 'en', { numeric: 'auto' });
      if (days < 1) return rtf.format(0, 'day');
      if (days < 30) return rtf.format(-days, 'day');
      if (days < 365) return rtf.format(-Math.round(days / 30), 'month');
      return rtf.format(-Math.round(days / 365), 'year');
    },
    [lang, t]
  );
}

// ---------- small building blocks ----------

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 18,
  background: 'var(--panel-grad)',
  marginBottom: 16,
};

const Card: React.FC<{ title: string; note?: string; children: React.ReactNode }> = ({ title, note, children }) => (
  <section style={card}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
      <div className="uc-header">{title}</div>
      {note && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{note}</span>}
    </div>
    {children}
  </section>
);

const Tile: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div
    style={{
      flex: '1 1 140px',
      minWidth: 140,
      padding: '14px 16px',
      borderRadius: 10,
      background: 'var(--panel)',
      border: '1px solid var(--border)',
    }}
  >
    <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
  </div>
);

/** Thin horizontal bar with a label column and a direct value label. */
const BarRow: React.FC<{
  label: React.ReactNode;
  value: number;
  max: number;
  valueLabel: string;
  color?: string;
  onClick?: () => void;
}> = ({ label, value, max, valueLabel, color = 'var(--chart-steam)', onClick }) => (
  <div
    onClick={onClick}
    style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 180px) 1fr auto', gap: 10, alignItems: 'center', marginBottom: 8, cursor: onClick ? 'pointer' : 'default' }}
  >
    <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
    <div style={{ height: 10, borderRadius: 5, background: 'var(--panel-2)', overflow: 'hidden' }} title={valueLabel}>
      <div style={{ width: `${max > 0 ? (value / max) * 100 : 0}%`, height: '100%', background: color, borderRadius: 5, minWidth: value > 0 ? 4 : 0 }} />
    </div>
    <div style={{ fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'nowrap', minWidth: 54, textAlign: 'right' }}>{valueLabel}</div>
  </div>
);

const Pills: React.FC<{ items: { id: string; label: string }[]; active: string | string[]; onPick: (id: string) => void }> = ({ items, active, onPick }) => (
  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
    {items.map((it) => {
      const on = Array.isArray(active) ? active.includes(it.id) : active === it.id;
      return (
        <button key={it.id} className={`pill${on ? ' pill-active' : ''}`} onClick={() => onPick(it.id)}>
          {it.label}
        </button>
      );
    })}
  </div>
);

/** Wide capsule: Steam header → tall cover → title placeholder (delisted apps have neither). */
const Capsule: React.FC<{ row: Row; width?: number }> = ({ row, width = 120 }) => {
  const [failed, setFailed] = useState(0);
  const candidates = [row.header, row.cover].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
  const src = candidates[failed] ?? null;
  const box: React.CSSProperties = { width, height: Math.round(width * 0.375), borderRadius: 4, background: 'var(--panel-2)', flex: '0 0 auto' };
  return src ? (
    <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed((n) => n + 1)} style={{ ...box, objectFit: 'cover', display: 'block' }} />
  ) : (
    <div style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 4, fontSize: Math.max(9, Math.round(width / 14)), fontWeight: 700, color: 'var(--muted)', textAlign: 'center', overflow: 'hidden' }}>
      {row.title}
    </div>
  );
};

const SourceDots: React.FC<{ sources: Source[] }> = ({ sources }) => (
  <span style={{ display: 'inline-flex', gap: 4 }}>
    {sources.map((s) => (
      <span
        key={s}
        title={sourceMeta(s).label}
        style={{ padding: '1px 6px', borderRadius: 4, fontSize: 10.5, fontWeight: 700, border: `1px solid ${sourceMeta(s).color}`, color: sourceMeta(s).color }}
      >
        {s === 'Epic' ? 'EGS' : s}
      </span>
    ))}
  </span>
);

const AchBar: React.FC<{ p: SteamAchievementProgress | null; width?: number }> = ({ p, width = 140 }) => {
  const { t } = useI18n();
  if (!p || p.total === 0) return <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span>;
  const percent = Math.round(p.percentage);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={t('stats.achOf', { u: p.unlocked, n: p.total })}>
      <div style={{ width, height: 8, borderRadius: 4, background: 'var(--panel-2)', overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: p.allUnlocked ? 'var(--discount-text)' : 'var(--accent)', borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 12, color: p.allUnlocked ? 'var(--discount-text)' : 'var(--muted)', whiteSpace: 'nowrap', minWidth: 74 }}>
        {p.unlocked}/{p.total} · {percent}%
      </span>
    </div>
  );
};

// ---------- data hooks ----------

function useProgress(games: Game[] | null): Map<number, SteamAchievementProgress> {
  const [map, setMap] = useState<Map<number, SteamAchievementProgress>>(cachedProgress?.map ?? new Map());
  useEffect(() => {
    if (!games) return;
    const ids = games.flatMap((g) => g.entries.map(steamAppId)).filter((x): x is string => !!x).map(Number);
    const key = `${ids.length}:${ids[0]}:${ids[ids.length - 1]}`;
    if (cachedProgress?.key === key) {
      setMap(cachedProgress.map);
      return;
    }
    let alive = true;
    api
      .getSteamAchievementsProgress(ids)
      .then((rows) => {
        if (!alive) return;
        const m = new Map(rows.map((r) => [r.appId, r]));
        cachedProgress = { key, map: m };
        setMap(m);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [games]);
  return map;
}

// ---------- page ----------

const StatsPage: React.FC = () => {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const rel = useRelativeDate(lang);

  const [tab, setTab] = useState<Tab>('overview');
  const [period, setPeriod] = useState<Period>('all');
  const [sel, setSel] = useState<Source[]>(ALL);
  const [games, setGames] = useState<Game[] | null>(cachedGames);
  const [recent, setRecent] = useState<SteamRecentGame[] | null>(cachedRecent);
  const [history, setHistory] = useState<PlaytimeHistory | null>(cachedHistory);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getCombinedLibrary()
      .then((g) => {
        cachedGames = g;
        setGames(g);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api
      .getSteamRecent()
      .then((r) => {
        cachedRecent = r;
        setRecent(r);
      })
      .catch(() => undefined);
    api
      .getPlaytimeHistory()
      .then((h) => {
        cachedHistory = h;
        setHistory(h);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    return window.launcher.onLibraryChanged(load);
  }, [load]);

  const progress = useProgress(games);

  const recentMap = useMemo(() => new Map((recent ?? []).map((r) => [r.appId, r.playtime2Weeks])), [recent]);
  const rows = useMemo(() => (games ? buildRows(games, sel, recentMap, progress) : []), [games, sel, recentMap, progress]);

  // ----- period scope -----
  const year = new Date().getFullYear();
  const scoped = useMemo<Row[]>(() => {
    if (period === '2w') return rows.filter((r) => r.min2w > 0).map((r) => ({ ...r, minutes: r.min2w, bySource: [{ source: 'Steam' as Source, minutes: r.min2w }] }));
    if (period === 'year') return rows.filter((r) => (r.lastPlayedAt && new Date(r.lastPlayedAt).getFullYear() === year) || r.min2w > 0);
    return rows;
  }, [rows, period, year]);

  const top = useMemo(() => [...scoped].filter((r) => r.minutes > 0).sort((a, b) => b.minutes - a.minutes), [scoped]);

  const toggleSource = (s: string) =>
    setSel((prev) => {
      const src = s as Source;
      const next = prev.includes(src) ? prev.filter((x) => x !== src) : [...prev, src];
      return next.length === 0 ? ALL : next;
    });

  // ----- overview numbers -----
  const ov = useMemo(() => {
    const total = scoped.length;
    const minutes = scoped.reduce((s, r) => s + r.minutes, 0);
    const played = scoped.filter((r) => r.minutes > 0).length;
    const backlog = rows.filter((r) => r.minutes === 0).length;
    const buckets = [
      { id: 'never', n: scoped.filter((r) => r.minutes === 0).length },
      { id: 'lt1', n: scoped.filter((r) => r.minutes > 0 && r.minutes < 60).length },
      { id: '1to10', n: scoped.filter((r) => r.minutes >= 60 && r.minutes < 600).length },
      { id: '10to50', n: scoped.filter((r) => r.minutes >= 600 && r.minutes < 3000).length },
      { id: 'gt50', n: scoped.filter((r) => r.minutes >= 3000).length },
    ];
    const bySrc = SOURCE_IDS.map((s) => ({
      source: s,
      games: scoped.filter((r) => r.sources.includes(s)).length,
      minutes: scoped.reduce((sum, r) => sum + (r.bySource.find((b) => b.source === s)?.minutes ?? 0), 0),
    }));
    const withAch = scoped.filter((r) => r.progress && r.progress.total > 0);
    const achUnlocked = withAch.reduce((s, r) => s + r.progress!.unlocked, 0);
    const achTotal = withAch.reduce((s, r) => s + r.progress!.total, 0);
    const avgPct = withAch.length ? Math.round(withAch.reduce((s, r) => s + r.progress!.percentage, 0) / withAch.length) : 0;
    const perfect = withAch.filter((r) => r.progress!.allUnlocked).sort((a, b) => b.progress!.total - a.progress!.total);
    const almost = withAch.filter((r) => !r.progress!.allUnlocked && r.progress!.percentage >= 80).sort((a, b) => b.progress!.percentage - a.progress!.percentage);
    // Last launch per month, past 12 months.
    const months: { key: string; label: string; n: number }[] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleString(lang === 'ru' ? 'ru' : 'en', { month: 'short' }), n: 0 });
    }
    const mIdx = new Map(months.map((m, i) => [m.key, i]));
    for (const r of scoped) {
      if (!r.lastPlayedAt) continue;
      const d = new Date(r.lastPlayedAt);
      const i = mIdx.get(`${d.getFullYear()}-${d.getMonth()}`);
      if (i != null) months[i].n++;
    }
    const cutoff = Date.now() - FORGOTTEN_DAYS * 86_400_000;
    const forgotten = rows
      .filter((r) => r.minutes >= 300 && r.steamId && r.lastPlayedAt && new Date(r.lastPlayedAt).getTime() < cutoff)
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 5);
    const deck = scoped.reduce((s, r) => s + r.deckMinutes, 0);
    const steamMinutes = bySrc.find((b) => b.source === 'Steam')?.minutes ?? 0;
    // EGS games by year added — Epic reports real acquisition dates (Steam's
    // "acquisition" is only the first sync, so it is deliberately left out).
    const egsYears = new Map<number, { got: number; played: number }>();
    if (sel.includes('Epic')) {
      for (const r of rows) {
        const e = r.game.entries.find((x) => x.source === 'Epic');
        if (!e?.acquisitionDate) continue;
        const y = new Date(e.acquisitionDate).getFullYear();
        if (!Number.isFinite(y)) continue;
        const cur = egsYears.get(y) ?? { got: 0, played: 0 };
        cur.got++;
        if ((e.playtimeMinutes ?? 0) > 0) cur.played++;
        egsYears.set(y, cur);
      }
    }
    const egsByYear = [...egsYears.entries()].sort((a, b) => a[0] - b[0]).map(([y, v]) => ({ year: y, ...v }));
    // Completion vs hours: average achievement % per playtime band.
    const bands = [
      { id: 'lt1', min: 1, max: 60 },
      { id: '1to10', min: 60, max: 600 },
      { id: '10to50', min: 600, max: 3000 },
      { id: 'gt50', min: 3000, max: Infinity },
    ];
    const completion = bands.map((b) => {
      const rs = withAch.filter((r) => r.minutes >= b.min && r.minutes < b.max);
      return {
        id: b.id,
        n: rs.length,
        avg: rs.length ? Math.round(rs.reduce((sum, r) => sum + r.progress!.percentage, 0) / rs.length) : 0,
      };
    });
    return { total, minutes, played, backlog, buckets, bySrc, withAch: withAch.length, achUnlocked, achTotal, avgPct, perfect, almost, months, forgotten, deck, steamMinutes, egsByYear, completion };
  }, [scoped, rows, sel, lang]);

  // ----- history deltas -----
  const hist = useMemo(() => {
    if (!history) return null;
    const days = Object.keys(history.days).sort();
    if (days.length === 0) return null;
    const first = days[0];
    const last = days[days.length - 1];
    if (first === last) return { since: first, hours: null as number | null, gainers: [] as { row: Row; minutes: number }[] };
    const baselineDay = period === 'year' ? days.find((d) => d >= `${year}-01-01`) ?? first : period === '2w' ? days.find((d) => d >= new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)) ?? first : first;
    const base = history.days[baselineDay];
    const cur = history.days[last];
    const byKey = new Map<string, Row>();
    for (const r of rows) {
      if (r.steamId) byKey.set(`S:${r.steamId}`, r);
      if (r.epicName) byKey.set(`E:${r.epicName}`, r);
    }
    let total = 0;
    const gainers: { row: Row; minutes: number }[] = [];
    for (const [k, v] of Object.entries(cur)) {
      const d = v - (base[k] ?? 0);
      if (d <= 0) continue;
      const row = byKey.get(k);
      if (!row || !sel.some((s) => row.sources.includes(s))) continue;
      total += d;
      gainers.push({ row, minutes: d });
    }
    gainers.sort((a, b) => b.minutes - a.minutes);
    return { since: baselineDay, hours: total / 60, gainers: gainers.slice(0, 3) };
  }, [history, rows, sel, period, year]);

  // ----- all-games tab -----
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<GamesSort>('hours');
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => r.title.toLowerCase().includes(q)) : rows.slice();
    const cmp: Record<GamesSort, (a: Row, b: Row) => number> = {
      hours: (a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title),
      name: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      lastPlayed: (a, b) => (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? '') || b.minutes - a.minutes,
      ach: (a, b) => (b.progress?.total ? b.progress.percentage : -1) - (a.progress?.total ? a.progress.percentage : -1) || b.minutes - a.minutes,
    };
    return filtered.sort(cmp[sort]);
  }, [rows, query, sort]);

  useEffect(() => setShown(PAGE), [query, sort, sel]);

  useEffect(() => {
    if (tab !== 'games' || !sentinel.current) return;
    const el = sentinel.current;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(n + PAGE, list.length));
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [tab, list.length]);

  const openGame = (row: Row) => navigate('/game', { state: { game: row.game } });

  // ----- render -----
  const maxBucket = Math.max(1, ...ov.buckets.map((b) => b.n));
  const maxTop = top[0]?.minutes ?? 0;
  const maxMonth = Math.max(1, ...ov.months.map((m) => m.n));
  const maxEgsYear = Math.max(1, ...ov.egsByYear.map((y) => y.got));
  const maxSrcMin = Math.max(1, ...ov.bySrc.map((b) => b.minutes));
  const maxSrcGames = Math.max(1, ...ov.bySrc.map((b) => b.games));
  const H = t('details.hours');

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '20px 20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, marginRight: 8 }}>{t('stats.title')}</h1>
        <Pills
          items={[
            { id: 'overview', label: t('stats.tabOverview') },
            { id: 'games', label: `${t('stats.tabGames')} · ${rows.length}` },
          ]}
          active={tab}
          onPick={(id) => setTab(id as Tab)}
        />
        <div style={{ flex: 1 }} />
        <Pills items={SOURCES.map((s) => ({ id: s.id, label: s.label }))} active={sel} onPick={toggleSource} />
      </div>

      {error && <p style={{ color: '#ff6b6b' }}>{t('common.error')}: {error}</p>}
      {!games && !error && <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>}
      {games && games.length === 0 && <p style={{ color: 'var(--muted)' }}>{t('stats.noData')}</p>}

      {games && games.length > 0 && tab === 'overview' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <Pills
              items={[
                { id: 'all', label: t('stats.periodAll') },
                { id: 'year', label: t('stats.periodYear', { y: year }) },
                { id: '2w', label: t('stats.period2w') },
              ]}
              active={period}
              onPick={(id) => setPeriod(id as Period)}
            />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {period === 'year' ? t('stats.periodYearNote') : period === '2w' ? t('stats.period2wNote') : ''}
            </span>
          </div>

          {/* ===== Headline tiles ===== */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            <Tile label={t('stats.games')} value={String(ov.total)} />
            <Tile label={t('stats.hours')} value={hours(ov.minutes)} sub={ov.played > 0 ? t('stats.avgPerPlayed', { h: hours(ov.minutes / ov.played) }) : undefined} />
            <Tile label={t('stats.played')} value={String(ov.played)} sub={`${pct(ov.played, ov.total)}%`} />
            {period === 'all' && <Tile label={t('stats.backlog')} value={String(ov.backlog)} sub={t('stats.backlogSub', { p: pct(ov.backlog, rows.length) })} />}
            <Tile label={t('stats.achUnlocked')} value={String(ov.achUnlocked)} sub={ov.achTotal ? t('stats.achOfTotal', { n: ov.achTotal, p: ov.avgPct }) : undefined} />
            <Tile label={t('stats.perfect')} value={String(ov.perfect.length)} sub={t('stats.perfectSub')} />
            {hist && hist.hours != null && <Tile label={t('stats.since', { d: hist.since })} value={`+${hours(hist.hours * 60)} ${H}`} sub={hist.gainers[0] ? `${hist.gainers[0].row.title} +${hours(hist.gainers[0].minutes)} ${H}` : undefined} />}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16 }}>
            {/* ===== Distribution ===== */}
            <Card title={t('stats.distribution')}>
              {ov.buckets.map((b) => (
                <BarRow key={b.id} label={t(`stats.bucket.${b.id}`)} value={b.n} max={maxBucket} valueLabel={`${b.n} · ${pct(b.n, ov.total)}%`} />
              ))}
            </Card>

            {/* ===== Platforms ===== */}
            <Card title={t('stats.platforms')}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{t('stats.hours')}</div>
              {ov.bySrc.map((b) => (
                <BarRow key={b.source} label={<span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: CHART[b.source], marginRight: 6 }} />{sourceMeta(b.source).label}</span>} value={b.minutes} max={maxSrcMin} valueLabel={`${hours(b.minutes)} ${H}`} color={CHART[b.source]} />
              ))}
              <div style={{ fontSize: 12, color: 'var(--muted)', margin: '12px 0 6px' }}>{t('stats.games')}</div>
              {ov.bySrc.map((b) => (
                <BarRow key={b.source} label={<span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: CHART[b.source], marginRight: 6 }} />{sourceMeta(b.source).label}</span>} value={b.games} max={maxSrcGames} valueLabel={String(b.games)} color={CHART[b.source]} />
              ))}
              {ov.deck > 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 12 }}>
                  {t('stats.deckShare', { h: hours(ov.deck), p: ov.steamMinutes > 0 && ov.deck / ov.steamMinutes < 0.01 ? '<1' : pct(ov.deck, ov.steamMinutes) })}
                </div>
              )}
            </Card>

            {/* ===== Activity ===== */}
            <Card title={t('stats.activity')} note={t('stats.activityNote')}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 110, padding: '0 2px' }}>
                {ov.months.map((m) => (
                  <div key={m.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }} title={`${m.label}: ${m.n}`}>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{m.n || ''}</span>
                    <div style={{ width: '100%', maxWidth: 28, height: `${Math.max(m.n > 0 ? 4 : 0, (m.n / maxMonth) * 70)}px`, background: 'var(--chart-steam)', borderRadius: '4px 4px 0 0' }} />
                    <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{m.label}</span>
                  </div>
                ))}
              </div>
              {ov.forgotten.length > 0 && (
                <>
                  <div style={{ fontSize: 12, color: 'var(--muted)', margin: '14px 0 8px' }}>{t('stats.forgotten')}</div>
                  {ov.forgotten.map((r) => (
                    <div key={r.title} onClick={() => openGame(r)} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, cursor: 'pointer' }}>
                      <Capsule row={r} width={64} />
                      <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{hours(r.minutes)} {H} · {rel(r.lastPlayedAt)}</span>
                    </div>
                  ))}
                </>
              )}
            </Card>

            {/* ===== Achievements ===== */}
            <Card title={t('details.achievements')} note={t('stats.achNote', { n: ov.withAch })}>
              {ov.perfect.length > 0 && (
                <>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{t('stats.perfectList')}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                    {ov.perfect.slice(0, 8).map((r) => (
                      <div key={r.title} onClick={() => openGame(r)} title={`${r.title} · ${r.progress!.total}`} style={{ cursor: 'pointer' }}>
                        <Capsule row={r} width={96} />
                      </div>
                    ))}
                  </div>
                </>
              )}
              {ov.almost.length > 0 && (
                <>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{t('stats.almost')}</div>
                  {ov.almost.slice(0, 5).map((r) => (
                    <div key={r.title} onClick={() => openGame(r)} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, cursor: 'pointer' }}>
                      <Capsule row={r} width={64} />
                      <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                      <AchBar p={r.progress} width={110} />
                    </div>
                  ))}
                </>
              )}
              {ov.withAch === 0 && <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{t('stats.achNone')}</p>}
            </Card>

            {/* ===== Completion vs hours ===== */}
            <Card title={t('stats.completion')} note={t('stats.completionNote')}>
              {ov.withAch === 0 ? (
                <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{t('stats.achNone')}</p>
              ) : (
                ov.completion.map((b) => (
                  <BarRow
                    key={b.id}
                    label={t(`stats.bucket.${b.id}`)}
                    value={b.avg}
                    max={100}
                    valueLabel={b.n ? t('stats.completionVal', { p: b.avg, n: b.n }) : '—'}
                  />
                ))
              )}
            </Card>

            {/* ===== EGS games by year added ===== */}
            {ov.egsByYear.length > 0 && (
              <Card title={t('stats.egsYears')} note={t('stats.egsYearsNote')}>
                {ov.egsByYear.map((y) => (
                  <BarRow
                    key={y.year}
                    label={String(y.year)}
                    value={y.got}
                    max={maxEgsYear}
                    valueLabel={`${y.got} · ${t('stats.launched', { n: y.played })}`}
                    color={CHART.Epic}
                  />
                ))}
              </Card>
            )}

            {/* ===== Top by playtime ===== */}
            <Card title={t('stats.topByPlaytime')}>
              {top.length === 0 ? (
                <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{t('stats.noPlaytime')}</p>
              ) : (
                top.slice(0, 10).map((r) => (
                  <div key={r.title} onClick={() => openGame(r)} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, cursor: 'pointer' }}>
                    <Capsule row={r} width={80} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                        <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap', marginLeft: 10 }}>{hours(r.minutes)} {H}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 2, height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--panel-2)' }}>
                        {r.bySource.map((seg) => (
                          <div key={seg.source} title={`${seg.source}: ${hours(seg.minutes)} ${H}`} style={{ width: `${maxTop > 0 ? (seg.minutes / maxTop) * 100 : 0}%`, background: CHART[seg.source] }} />
                        ))}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </Card>
          </div>

          {hist && hist.hours == null && (
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{t('stats.historyStarted', { d: hist.since })}</p>
          )}
        </>
      )}

      {games && games.length > 0 && tab === 'games' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('filter.search')} style={{ width: 260 }} />
            <select value={sort} onChange={(e) => setSort(e.target.value as GamesSort)} style={{ background: 'var(--input-bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
              <option value="hours">{t('stats.sortHours')}</option>
              <option value="name">{t('stats.sortName')}</option>
              <option value="lastPlayed">{t('stats.sortLastPlayed')}</option>
              <option value="ach">{t('stats.sortAch')}</option>
            </select>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{t('stats.shownOf', { n: Math.min(shown, list.length), total: list.length })}</span>
          </div>

          <div style={{ ...card, padding: '6px 10px' }}>
            {list.slice(0, shown).map((r) => (
              <div
                key={r.title}
                onClick={() => openGame(r)}
                style={{ display: 'grid', gridTemplateColumns: '184px minmax(0, 1fr) 110px 150px 240px', gap: 14, alignItems: 'center', padding: '8px 6px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
              >
                <Capsule row={r} width={184} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                  <div style={{ marginTop: 4 }}><SourceDots sources={r.sources} /></div>
                </div>
                <div style={{ fontSize: 13, textAlign: 'right' }}>
                  {r.minutes > 0 ? <><b>{hours(r.minutes)}</b> <span style={{ color: 'var(--muted)' }}>{H}</span></> : <span style={{ color: 'var(--muted)' }}>{t('stats.never')}</span>}
                  {r.min2w > 0 && <div style={{ fontSize: 11.5, color: 'var(--accent-bright)' }}>{t('lib.recent2w', { h: hours(r.min2w) })}</div>}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('stats.lastPlayed')}</div>
                  {r.lastPlayedAt ? rel(r.lastPlayedAt) : '—'}
                </div>
                <AchBar p={r.progress} />
              </div>
            ))}
            <div ref={sentinel} style={{ height: 1 }} />
            {shown < list.length && <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--muted)', margin: '10px 0' }}>{t('lib.loading')}</p>}
          </div>
        </>
      )}
    </div>
  );
};

export default StatsPage;
