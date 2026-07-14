import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  useI18n,
  sourceMeta,
  SOURCES,
  SOURCE_IDS,
  type Game,
  type Source,
  type SteamRecentGame,
} from '@app/shared';

// Account-level statistics computed from the combined library (both platforms
// have playtime after sync: Steam via Web API, EGS via Epic's playtime
// endpoint). The source filter works like the library's: Steam/Epic toggle,
// unchecking the last one snaps back to all.

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 16,
  background: 'var(--panel)',
  marginBottom: 16,
};

const ALL: Source[] = [...SOURCE_IDS];

const filterBtn = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  cursor: 'pointer',
  background: active ? 'var(--accent)' : 'var(--panel)',
  color: active ? 'var(--on-accent)' : 'var(--text)',
  fontWeight: 600,
});

const StatCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ ...card, marginBottom: 0, flex: 1, minWidth: 150 }}>
    <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>
  </div>
);

const StatsPage: React.FC = () => {
  const { t } = useI18n();
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Source[]>(ALL);
  const [recent, setRecent] = useState<SteamRecentGame[] | null>(null);

  useEffect(() => {
    api
      .getCombinedLibrary()
      .then(setGames)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api
      .getSteamRecent()
      .then(setRecent)
      .catch(() => setRecent(null)); // Steam not configured — hide the block
  }, []);

  const toggle = (s: Source) =>
    setSel((prev) => {
      const next = prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s];
      return next.length === 0 ? ALL : next;
    });

  const stats = useMemo(() => {
    if (!games) return null;
    // Per game: entries belonging to the selected sources.
    let count = 0;
    let minutes = 0;
    let played = 0;
    const top: { title: string; bySource: { source: Source; minutes: number }[]; total: number }[] = [];

    for (const g of games) {
      const entries = g.entries.filter((e) => sel.includes(e.source));
      if (!entries.length) continue;
      count++;
      const bySource = entries
        .filter((e) => (e.playtimeMinutes ?? 0) > 0)
        .map((e) => ({ source: e.source, minutes: e.playtimeMinutes! }));
      const total = bySource.reduce((sum, e) => sum + e.minutes, 0);
      minutes += total;
      if (total > 0) {
        played++;
        top.push({ title: g.title, bySource, total });
      }
    }
    top.sort((a, b) => b.total - a.total);
    return { count, hours: minutes / 60, played, top: top.slice(0, 10) };
  }, [games, sel]);

  const maxTop = stats?.top[0]?.total ?? 0;
  const showRecent = sel.includes('Steam') && recent && recent.length > 0;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>
      <h2 style={{ marginTop: 0 }}>{t('stats.title')}</h2>

      {/* Source filter (same semantics as the library) */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button style={filterBtn(sel.length === ALL.length)} onClick={() => setSel(ALL)}>
          {t('filter.all')}
        </button>
        {SOURCES.map((sm) => (
          <button key={sm.id} style={filterBtn(sel.includes(sm.id))} onClick={() => toggle(sm.id)}>
            {sm.label}
          </button>
        ))}
      </div>

      {error && <p style={{ color: '#ff6b6b' }}>{t('common.error')}: {error}</p>}
      {!games && !error && <p style={{ color: 'var(--muted)' }}>{t('lib.loading')}</p>}
      {games && games.length === 0 && <p style={{ color: 'var(--muted)' }}>{t('stats.noData')}</p>}

      {stats && games && games.length > 0 && (
        <>
          {/* Headline numbers */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label={t('stats.games')} value={String(stats.count)} />
            <StatCard label={t('stats.hours')} value={stats.hours.toFixed(1)} />
            <StatCard label={t('stats.played')} value={String(stats.played)} />
          </div>

          {/* Top by playtime */}
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t('stats.topByPlaytime')}</h3>
            {stats.top.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>{t('stats.noPlaytime')}</p>
            ) : (
              stats.top.map((row) => (
                <div key={row.title} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.title}
                    </span>
                    <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap', marginLeft: 10 }}>
                      {(row.total / 60).toFixed(1)} {t('details.hours')}
                    </span>
                  </div>
                  {/* Stacked per-source bar */}
                  <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--panel-2)' }}>
                    {row.bySource.map((seg) => (
                      <div
                        key={seg.source}
                        title={`${seg.source}: ${(seg.minutes / 60).toFixed(1)} ${t('details.hours')}`}
                        style={{
                          width: `${maxTop > 0 ? (seg.minutes / maxTop) * 100 : 0}%`,
                          background: sourceMeta(seg.source).color,
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Steam: last 2 weeks */}
          {showRecent && (
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>{t('stats.recent2w')}</h3>
              {recent!.map((g) => (
                <div key={g.appId} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  {g.iconUrl ? (
                    <img src={g.iconUrl} alt="" width={28} height={28} style={{ borderRadius: 4 }} />
                  ) : (
                    <div style={{ width: 28, height: 28, borderRadius: 4, background: 'var(--panel-2)' }} />
                  )}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {g.name}
                  </span>
                  <span style={{ color: 'var(--muted)', fontSize: 13, whiteSpace: 'nowrap' }}>
                    {(g.playtime2Weeks / 60).toFixed(1)} {t('details.hours')} /{' '}
                    {(g.playtimeForever / 60).toFixed(1)} {t('details.hours')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default StatsPage;
