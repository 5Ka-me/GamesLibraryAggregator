import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api,
  useI18n,
  useLibraryActions,
  openDeepLink,
  epicAppName,
  steamAppId,
  sourceMeta,
  isInstalled,
  type Game,
} from '@app/shared';
import { ctl } from '../store/parts';

// "What to play?" — a slot-machine reel that picks a random library game.
//
// The reel is a CSS-3D prism: FACES flat faces placed around a horizontal
// axis (rotateX(i·STEP) translateZ(RADIUS)), spun by animating the parent's
// rotateX with a long ease-out. The winner is chosen up front; its art is put
// on the face the reel will stop at, the other faces get random pool games.

// ---------- drum geometry ----------

const FACES = 12;
const FACE_W = 260;
const FACE_H = 140;
const PERSPECTIVE = 1100;
const STEP = 360 / FACES;
/** Apothem: with this radius neighbouring faces meet edge to edge. */
const RADIUS = FACE_H / 2 / Math.tan(Math.PI / FACES);
/** How much bigger the front face looks after perspective projection. */
const FRONT_SCALE = PERSPECTIVE / (PERSPECTIVE - RADIUS);
const WINDOW_W = 400;
const WINDOW_H = 420;
const SPIN_MS = 4200;
/** Long ease-out with a slight overshoot — the reel "settles" on the winner. */
const SPIN_EASING = 'cubic-bezier(0.12, 0.82, 0.25, 1.06)';

// ---------- session state (module-level: survives navigation, resets with the app) ----------

let cachedGames: Game[] | null = null;
let sessionExcluded: string[] = [];
/**
 * The reel as last seen: coming back to the page shows the very same faces
 * and result instantly (their art is already in the HTTP cache) instead of
 * re-rolling a fresh set of covers that all have to download again.
 */
const sessionReel: { faces: (Game | null)[]; angle: number; frontIdx: number; result: Game | null } = {
  faces: Array<Game | null>(FACES).fill(null),
  angle: 0,
  frontIdx: 0,
  result: null,
};
/** The mounted page (if any) — a spin finishing after navigation reports here. */
let announceResult: ((g: Game) => void) | null = null;
/** Max wait for the next spin's covers before the reel starts moving anyway. */
const PRELOAD_CAP_MS = 700;

const INSTALLED_ONLY_KEY = 'random:installedOnly';

function shuffle<T>(list: T[]): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function firstSteamId(game: Game): string | null {
  return game.entries.map(steamAppId).find((x): x is string => !!x) ?? null;
}

/** Cover a reel face will show for the game (wide Steam header, else tall cover). */
function faceArtUrl(game: Game): string | null {
  const steamId = firstSteamId(game);
  return steamId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamId}/header.jpg` : game.iconUrl ?? null;
}

/** Warms the image cache for `urls`; resolves when all are in or after `capMs`. */
function preloadImages(urls: string[], capMs: number): Promise<void> {
  const unique = Array.from(new Set(urls.filter((u): u is string => !!u)));
  if (unique.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let pending = unique.length;
    const done = () => {
      if (--pending === 0) resolve();
    };
    for (const url of unique) {
      const img = new Image();
      img.onload = done;
      img.onerror = done;
      img.src = url;
    }
    window.setTimeout(resolve, capMs);
  });
}

function totalHours(game: Game): number {
  const min = game.entries.reduce((s, e) => s + (e.playtimeMinutes ?? 0), 0);
  return Math.round(min / 6) / 10;
}

// ---------- reel face ----------

/**
 * Steam games get the wide header.jpg (fills the face); everything else shows
 * the tall library cover centered over a blurred copy of itself.
 */
const Face: React.FC<{ game: Game | null; index: number }> = ({ game, index }) => {
  const [wideBroken, setWideBroken] = useState(false);
  useEffect(() => setWideBroken(false), [game]);

  const steamId = game ? firstSteamId(game) : null;
  const wide = steamId && !wideBroken ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamId}/header.jpg` : null;
  const tall = game?.iconUrl ?? null;

  return (
    <div
      className="drum-face"
      style={{ transform: `rotateX(${index * STEP}deg) translateZ(${RADIUS}px)` }}
    >
      {wide ? (
        <img className="fill" src={wide} alt="" draggable={false} onError={() => setWideBroken(true)} />
      ) : tall ? (
        <>
          <img className="blur" src={tall} alt="" aria-hidden draggable={false} />
          <img className="contain" src={tall} alt="" draggable={false} />
        </>
      ) : (
        <div className="name">{game?.title ?? ''}</div>
      )}
    </div>
  );
};

// ---------- result: play / install ----------

const PlayOrInstall: React.FC<{ game: Game }> = ({ game }) => {
  const { t } = useI18n();
  const actions = useLibraryActions();
  const steam = game.entries.find((e) => e.source === 'Steam') ?? null;
  const epic = game.entries.find((e) => e.source === 'Epic') ?? null;
  const steamId = steam ? steamAppId(steam) : null;
  const epicName = epic ? epicAppName(epic) : null;
  const steamInstalled = !!steamId && !!actions?.getSteamState(steamId).installed;
  const epicState = epicName && actions ? actions.getEpicState(epicName) : null;

  if (steamInstalled && steam?.launchUrl) {
    return (
      <button className="btn-play" onClick={() => openDeepLink(steam.launchUrl!)}>
        ▶ {t('card.play')}
      </button>
    );
  }
  if (epicState?.installed && actions && epicName) {
    return (
      <button className="btn-play" onClick={() => actions.launchEpic(epicName)}>
        ▶ {t('card.play')}
      </button>
    );
  }
  if (epicState?.installing) {
    return (
      <span style={{ fontSize: 13, color: 'var(--muted)', alignSelf: 'center' }}>
        ⬇ {Math.round(epicState.progressPct ?? 0)}%
      </span>
    );
  }
  if (steam?.installUrl) {
    return (
      <button style={ctl} onClick={() => openDeepLink(steam.installUrl!)}>
        ⬇ {t('card.install')}
      </button>
    );
  }
  if (actions && epicName) {
    return (
      <button style={ctl} onClick={() => actions.installEpic(epicName, game.title)}>
        ⬇ {t('card.install')}
      </button>
    );
  }
  return null;
};

// ---------- result: store blurb ----------

interface Blurb {
  description: string | null;
  genres: string[];
  developer: string | null;
  /** Review summary (Steam) or "★ 4.6" (EGS). */
  score: string | null;
  releaseDate: string | null;
}

function useBlurb(game: Game | null, lang: string): { blurb: Blurb | null; loading: boolean } {
  const [blurb, setBlurb] = useState<Blurb | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setBlurb(null);
    if (!game) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const steamId = firstSteamId(game);
    const epicEntry = game.entries.find((e) => e.source === 'Epic') ?? null;
    const request: Promise<Blurb | null> = steamId
      ? window.launcher.storeAppDetails(parseInt(steamId, 10), lang).then((d) => ({
          description: d.shortDescription ?? null,
          genres: d.genres,
          developer: d.developers[0] ?? null,
          score: d.reviewScoreDesc ?? null,
          releaseDate: d.releaseDate ?? null,
        }))
      : window.launcher.epicStoreDetails(game.title, epicEntry?.namespace ?? null, lang).then((d) =>
          d
            ? {
                description: d.description ?? null,
                genres: d.genres,
                developer: d.developer ?? null,
                score: d.rating != null ? `★ ${d.rating.toFixed(1)}` : null,
                releaseDate: d.releaseDate ?? null,
              }
            : null
        );
    request
      .then((b) => alive && setBlurb(b))
      .catch(() => alive && setBlurb(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [game, lang]);

  return { blurb, loading };
}

// ---------- page ----------

const RandomPage: React.FC = () => {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const actions = useLibraryActions();

  const [games, setGames] = useState<Game[]>(cachedGames ?? []);
  const [loaded, setLoaded] = useState(cachedGames !== null);
  const [installedOnly, setInstalledOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem(INSTALLED_ONLY_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [excluded, setExcluded] = useState<string[]>(sessionExcluded);

  const [faces, setFaces] = useState<(Game | null)[]>(sessionReel.faces);
  const [angle, setAngle] = useState(sessionReel.angle);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<Game | null>(sessionReel.result);
  /** Index of the face currently facing the viewer. */
  const frontIdx = useRef(sessionReel.frontIdx);
  const alive = useRef(true);

  const { blurb, loading: blurbLoading } = useBlurb(result, lang);

  useEffect(() => {
    let live = true;
    api
      .getCombinedLibrary()
      .then((list) => {
        cachedGames = list;
        if (live) setGames(list);
      })
      .catch(() => undefined)
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    alive.current = true;
    // A spin started on a previous visit may still be running: its outcome
    // lands here so coming back mid-spin still ends with the result card.
    announceResult = (g) => {
      setSpinning(false);
      setResult(g);
    };
    return () => {
      alive.current = false;
      announceResult = null;
    };
  }, []);

  useEffect(() => {
    sessionReel.faces = faces;
    sessionReel.angle = angle;
    sessionReel.result = result;
  }, [faces, angle, result]);

  useEffect(() => {
    sessionExcluded = excluded;
  }, [excluded]);

  useEffect(() => {
    try {
      localStorage.setItem(INSTALLED_ONLY_KEY, installedOnly ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [installedOnly]);

  const pool = useMemo(() => {
    const out = new Set(excluded);
    return games.filter((g) => !out.has(g.title) && (!installedOnly || !actions || isInstalled(g, actions)));
  }, [games, excluded, installedOnly, actions]);

  // Dress the idle reel as soon as the library arrives so it never shows blank faces.
  useEffect(() => {
    if (spinning || pool.length === 0 || faces.some((f) => f !== null)) return;
    const pick = shuffle(pool);
    setFaces(Array.from({ length: FACES }, (_, i) => pick[i % pick.length]));
  }, [pool, faces, spinning]);

  const spin = async () => {
    if (spinning || pool.length === 0) return;
    setSpinning(true);
    setResult(null);
    const winner = pool[Math.floor(Math.random() * pool.length)];

    // Stop on any face but the current front one, so the reel always travels.
    let k = Math.floor(Math.random() * FACES);
    if (k === frontIdx.current) k = (k + 1 + Math.floor(Math.random() * (FACES - 1))) % FACES;

    // Refill every face except the one in view (it would visibly pop before
    // the reel starts moving); the winner goes on the landing face.
    const others = shuffle(pool.filter((g) => g !== winner));
    const next = faces.slice();
    let j = 0;
    for (let i = 0; i < FACES; i++) {
      if (i === k) next[i] = winner;
      else if (i !== frontIdx.current) next[i] = others.length ? others[j++ % others.length] : winner;
    }
    // Warm the cache for the new faces (and the winner's tall cover for the
    // result card) so nothing pops in blank while the reel is moving.
    await preloadImages(
      [...next.filter((g): g is Game => !!g).map(faceArtUrl), winner.iconUrl ?? null].filter(
        (u): u is string => !!u
      ),
      PRELOAD_CAP_MS
    );
    if (!alive.current) return;
    setFaces(next);

    // Face i faces the viewer when angle + i·STEP ≡ 0 (mod 360); spin forward
    // a few full turns plus the remaining arc to that face.
    const arc = (((-k * STEP - angle) % 360) + 360) % 360;
    const turns = 4 + Math.floor(Math.random() * 2);
    setAngle(angle + turns * 360 + arc);
    frontIdx.current = k;
    sessionReel.frontIdx = k;

    window.setTimeout(() => {
      // Recorded even if the user has left the page; whichever instance is
      // mounted now shows it.
      sessionReel.result = winner;
      announceResult?.(winner);
    }, SPIN_MS);
  };

  const exclude = (game: Game) => {
    if (!excluded.includes(game.title)) setExcluded([...excluded, game.title]);
  };
  const restore = (title: string) => setExcluded(excluded.filter((x) => x !== title));

  const resultExcluded = !!result && excluded.includes(result.title);
  const markerH = Math.round(FACE_H * FRONT_SCALE) + 8;

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '20px 20px 24px' }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 28, fontWeight: 800 }}>{t('rnd.title')}</h1>
      <p style={{ margin: '0 0 18px', color: 'var(--muted)', fontSize: 14 }}>{t('rnd.subtitle')}</p>

      {/* ===== Controls ===== */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18, flexWrap: 'wrap', minHeight: 38 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
          <input
            type="checkbox"
            checked={installedOnly}
            onChange={(e) => setInstalledOnly(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
          />
          {t('rnd.installedOnly')}
        </label>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {t('rnd.pool', { n: pool.length, total: games.length })}
        </span>
        <div style={{ flex: 1 }} />
        {excluded.length > 0 && (
          <button style={ctl} onClick={() => setExcluded([])}>
            ↺ {t('rnd.reset')} ({excluded.length})
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 26, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* ===== Reel ===== */}
        <div style={{ width: WINDOW_W, flex: `0 0 ${WINDOW_W}px` }}>
          <div className="drum-window" style={{ width: WINDOW_W, height: WINDOW_H, perspective: PERSPECTIVE }}>
            <div
              className="drum"
              style={{
                width: FACE_W,
                height: FACE_H,
                marginLeft: -FACE_W / 2,
                marginTop: -FACE_H / 2,
                transform: `rotateX(${angle}deg)`,
                transition: `transform ${SPIN_MS}ms ${SPIN_EASING}`,
              }}
            >
              {faces.map((g, i) => (
                <Face key={i} game={g} index={i} />
              ))}
            </div>
            <div className="drum-shade" />
            <div
              className={`drum-marker${result && !spinning ? ' on' : ''}`}
              style={{ height: markerH, marginTop: -markerH / 2 }}
            />
          </div>

          <button
            onClick={() => void spin()}
            disabled={spinning || pool.length === 0}
            style={{
              marginTop: 14,
              width: '100%',
              padding: '13px 0',
              borderRadius: 10,
              border: 'none',
              cursor: 'pointer',
              fontSize: 16,
              fontWeight: 800,
              letterSpacing: 0.4,
              color: 'var(--on-accent)',
              background: 'linear-gradient(180deg, #6cc4f6 0%, #2f8fd0 100%)',
              boxShadow: '0 6px 20px rgba(87, 184, 240, 0.3)',
            }}
          >
            {spinning ? t('rnd.spinning') : result ? `↻ ${t('rnd.spinAgain')}` : `🎲 ${t('rnd.spin')}`}
          </button>

          {loaded && games.length === 0 && (
            <p style={{ marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>{t('rnd.noLibrary')}</p>
          )}
          {loaded && games.length > 0 && pool.length === 0 && (
            <p style={{ marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>{t('rnd.empty')}</p>
          )}
        </div>

        {/* ===== Result ===== */}
        <div
          style={{
            flex: '1 1 380px',
            minWidth: 0,
            minHeight: WINDOW_H,
            borderRadius: 14,
            border: '1px solid var(--border)',
            background: 'var(--panel-grad)',
            padding: 20,
            display: 'flex',
          }}
        >
          {result && !spinning ? (
            <div className="rnd-result" style={{ display: 'flex', gap: 18, width: '100%' }}>
              {result.iconUrl && (
                <img
                  src={result.iconUrl}
                  alt=""
                  draggable={false}
                  style={{
                    width: 150,
                    height: 225,
                    objectFit: 'cover',
                    borderRadius: 8,
                    flex: '0 0 auto',
                    boxShadow: '0 10px 30px rgba(0,0,0,.5)',
                  }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.2 }}>{result.title}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {result.sources.map((s) => {
                      const m = sourceMeta(s);
                      return (
                        <span
                          key={s}
                          style={{
                            padding: '2px 8px',
                            borderRadius: 5,
                            fontSize: 11.5,
                            fontWeight: 700,
                            border: `1px solid ${m.color}`,
                            color: m.color,
                          }}
                        >
                          {m.label}
                        </span>
                      );
                    })}
                    {actions && isInstalled(result, actions) && (
                      <span style={{ fontSize: 12, color: 'var(--success)', fontWeight: 600 }}>
                        ✓ {t('card.installed')}
                      </span>
                    )}
                    <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                      {totalHours(result) > 0 ? t('rnd.hours', { h: totalHours(result) }) : t('rnd.neverPlayed')}
                    </span>
                  </div>
                </div>

                {blurbLoading && <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('rnd.loadingInfo')}</div>}
                {blurb && (
                  <>
                    {(blurb.genres.length > 0 || blurb.score) && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {blurb.genres.slice(0, 5).map((g) => (
                          <span
                            key={g}
                            style={{
                              padding: '2px 8px',
                              borderRadius: 5,
                              background: 'var(--panel-2)',
                              fontSize: 12,
                              color: 'var(--text)',
                            }}
                          >
                            {g}
                          </span>
                        ))}
                        {blurb.score && (
                          <span style={{ fontSize: 12, color: 'var(--accent-bright)', fontWeight: 600 }}>{blurb.score}</span>
                        )}
                      </div>
                    )}
                    {blurb.description && (
                      <p className="rnd-desc" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: 'var(--muted)' }}>
                        {blurb.description}
                      </p>
                    )}
                    {(blurb.developer || blurb.releaseDate) && (
                      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                        {[blurb.developer, blurb.releaseDate].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </>
                )}

                <div style={{ marginTop: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 8 }}>
                  <PlayOrInstall game={result} />
                  <button style={ctl} onClick={() => navigate('/game', { state: { game: result } })}>
                    {t('rnd.open')} →
                  </button>
                  <button
                    style={{ ...ctl, ...(resultExcluded ? { color: 'var(--muted)' } : {}) }}
                    onClick={() => exclude(result)}
                    disabled={resultExcluded}
                  >
                    {resultExcluded ? `✓ ${t('rnd.excluded')}` : `✕ ${t('rnd.exclude')}`}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div
              style={{
                margin: 'auto',
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 14,
                maxWidth: 280,
                lineHeight: 1.5,
              }}
            >
              {spinning ? t('rnd.spinning') : t('rnd.placeholder')}
            </div>
          )}
        </div>
      </div>

      {/* ===== Removed games (session only) ===== */}
      {excluded.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div className="uc-header" style={{ marginBottom: 10 }}>
            {t('rnd.excludedList')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {excluded.map((title) => (
              <span key={title} className="rnd-chip">
                {title}
                <button title={t('rnd.restore')} onClick={() => restore(title)}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default RandomPage;
