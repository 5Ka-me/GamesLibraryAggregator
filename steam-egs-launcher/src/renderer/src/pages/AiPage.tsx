import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { normalizeTitle, useI18n, useLibraryActions } from '@app/shared';
import type { AiStatus, AssistantGame, AssistantProgress, AssistantReply, StoreItem } from '../../../preload';
import { ItemCard, useOwnership } from '../store/parts';
import { excludeFromReel, isExcludedFromReel } from './RandomPage';

// The "AI" page: one multi-turn chat that searches the library, advises what to
// play / finish / buy and answers questions about the statistics. The model
// works through local tools (main/services/assistant.ts); this page only
// renders what came back and resolves game names into real cards with actions.

const CHAT_KEY = 'ai:chat';
const CHAT_MAX = 30;
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reply?: AssistantReply;
  error?: string;
}

function loadChat(): Msg[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((m): m is Msg => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant')).slice(-CHAT_MAX) : [];
  } catch {
    return [];
  }
}
function saveChat(list: Msg[]): void {
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(list.filter((m) => !m.error).slice(-CHAT_MAX)));
  } catch {
    /* ignore */
  }
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const gameRoute = (g: AssistantGame): string => (g.appid ? `/library/s-${g.appid}` : g.epicAppName ? `/library/e-${encodeURIComponent(g.epicAppName)}` : `/library/t-${encodeURIComponent(normalizeTitle(g.title))}`);

/** Tiny markdown: paragraphs, "- " bullets, **bold**. Enough for the model's answers, no HTML injection. */
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: { kind: 'p' | 'ul'; lines: string[] }[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const bullet = /^([-*•]|\d+[.)])\s+/.test(line);
      const last = out[out.length - 1];
      if (bullet) {
        const item = line.replace(/^([-*•]|\d+[.)])\s+/, '');
        if (last?.kind === 'ul') last.lines.push(item);
        else out.push({ kind: 'ul', lines: [item] });
      } else out.push({ kind: 'p', lines: [line.replace(/^#+\s*/, '')] });
    }
    return out;
  }, [text]);
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <React.Fragment key={i}>{part}</React.Fragment>));
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'ul' ? (
          <ul key={i} style={{ margin: '6px 0', paddingLeft: 20 }}>
            {b.lines.map((l, j) => <li key={j} style={{ margin: '3px 0' }}>{inline(l)}</li>)}
          </ul>
        ) : (
          <p key={i} style={{ margin: '6px 0' }}>{inline(b.lines[0])}</p>
        )
      )}
    </>
  );
}

/** An owned game named by the model: cover, note, and the actions the user would otherwise click through to. */
const Cover: React.FC<{ g: AssistantGame; w: number; h: number }> = ({ g, w, h }) => {
  const src = g.appid ? `${CDN}/${g.appid}/header.jpg` : g.iconUrl ?? null;
  const box: React.CSSProperties = { width: w, height: h, borderRadius: 4, background: 'var(--panel-2)', flex: '0 0 auto', objectFit: 'cover' };
  return src ? <img src={src} alt="" loading="lazy" draggable={false} style={box} /> : <span style={{ ...box, display: 'inline-block' }} />;
};

const OwnedRow: React.FC<{ g: AssistantGame }> = ({ g }) => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const actions = useLibraryActions();
  const [excluded, setExcluded] = useState(() => isExcludedFromReel(g.title));
  const launch = () => {
    if (g.appid) void window.launcher.openDeepLink(`steam://rungameid/${g.appid}`);
    else if (g.epicAppName && actions) actions.launchEpic(g.epicAppName);
  };
  return (
    <div className="lib-row inst" style={{ height: 'auto', minHeight: 56, padding: '6px 10px', cursor: 'default', alignItems: 'center' }}>
      <Cover g={g} w={92} h={43} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button className="ttl" style={{ fontWeight: 600, background: 'none', border: 'none', padding: 0, textAlign: 'left', color: 'var(--text)', cursor: 'pointer', fontSize: 13.5 }} onClick={() => navigate(gameRoute(g))}>
          {g.title}
        </button>
        {g.note && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{g.note}</span>}
      </span>
      <span style={{ display: 'flex', gap: 5, flex: '0 0 auto' }}>
        {g.installed && (g.appid || (g.epicAppName && actions)) && (
          <button className="pill pill-active" style={{ padding: '4px 10px', fontSize: 12 }} onClick={launch}>▶ {t('chat.launch')}</button>
        )}
        <button className="pill" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => navigate(gameRoute(g))}>{t('chat.open')}</button>
        <button className="pill" style={{ padding: '4px 10px', fontSize: 12, opacity: excluded ? 0.7 : 1 }} disabled={excluded} onClick={() => { excludeFromReel(g.title); setExcluded(true); }} title={t('chat.excludeHint')}>
          {excluded ? `✓ ${t('chat.excluded')}` : `✕ ${t('chat.exclude')}`}
        </button>
      </span>
    </div>
  );
};

const Thinking: React.FC<{ progress: AssistantProgress | null }> = ({ progress }) => {
  const { t } = useI18n();
  const text =
    progress?.phase === 'tools' && progress.tools.length
      ? t('chat.tools', { t: progress.tools.map((x) => t(`chat.tool.${x}`)).join(', ') })
      : progress?.phase === 'answer'
        ? t('chat.answering')
        : t('chat.thinking');
  return (
    <div className="rise" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--muted)', padding: '4px 0' }}>
      <span className="ai-dots"><span /><span /><span /></span>
      {text}
    </div>
  );
};

const AiPage: React.FC = () => {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const own = useOwnership();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const [status, setStatus] = useState<AiStatus | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>(loadChat);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AssistantProgress | null>(null);
  const [storeMeta, setStoreMeta] = useState<Record<number, StoreItem>>({});
  const [openAll, setOpenAll] = useState<Record<string, boolean>>({});

  useEffect(() => {
    window.launcher.aiStatus().then(setStatus).catch(() => setStatus({ configured: false, model: '', usage: { requests: 0, promptTokens: 0, completionTokens: 0 } }));
    inputRef.current?.focus();
    return window.launcher.onAiProgress(setProgress);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length, busy]);

  // Store cards for unowned games the model named and for store tool results.
  useEffect(() => {
    const ids = new Set<number>();
    for (const m of msgs) {
      if (!m.reply) continue;
      for (const g of m.reply.games) if (!g.owned && g.appid) ids.add(g.appid);
      for (const id of m.reply.storeResults) ids.add(id);
    }
    const missing = [...ids].filter((id) => !storeMeta[id]);
    if (!missing.length) return;
    window.launcher
      .storeItemsMeta(missing, lang)
      .then((meta) => setStoreMeta((prev) => ({ ...prev, ...meta })))
      .catch(() => undefined);
  }, [msgs, lang, storeMeta]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      const user: Msg = { id: uid(), role: 'user', content: q };
      const base = [...msgs.filter((m) => !m.error), user];
      setMsgs(base);
      saveChat(base);
      setInput('');
      setBusy(true);
      setProgress({ phase: 'thinking', tools: [], round: 0 });
      try {
        const reply = await window.launcher.aiChat(base.map((m) => ({ role: m.role, content: m.content })), lang);
        const next = [...base, { id: uid(), role: 'assistant' as const, content: reply.answer, reply }];
        setMsgs(next);
        saveChat(next);
      } catch (e) {
        setMsgs([...base, { id: uid(), role: 'assistant', content: '', error: e instanceof Error ? e.message : String(e) }]);
      } finally {
        setBusy(false);
        setProgress(null);
        inputRef.current?.focus();
      }
    },
    [busy, msgs, lang]
  );

  const errorText = (code: string): string => {
    if (code.includes('AI_NO_KEY')) return t('search.err.noKey');
    if (code.includes('AI_AUTH')) return t('search.err.auth');
    if (code.includes('AI_BALANCE')) return t('search.err.balance');
    if (code.includes('AI_RATE')) return t('search.err.rate');
    return `${t('common.error')}: ${code.replace(/^Error invoking remote method '[^']+': Error: /, '')}`;
  };

  const examples = [t('chat.ex1'), t('chat.ex2'), t('chat.ex3'), t('chat.ex4'), t('chat.ex5'), t('chat.ex6')];
  /** Quick actions and examples only fill the field — the user edits and sends; nothing is spent by a stray click. */
  const insert = (text: string) => {
    setInput(text);
    inputRef.current?.focus();
  };
  const bubble: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 14, padding: '12px 16px', background: 'var(--panel-grad)', fontSize: 14, lineHeight: 1.55 };
  const canSend = !!status?.configured && !busy;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', maxWidth: 980, margin: '0 auto', padding: '20px 20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{t('chat.title')}</h1>
        <span style={{ flex: 1 }} />
        {msgs.length > 0 && (
          <button className="pill" style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={() => { setMsgs([]); saveChat([]); inputRef.current?.focus(); }}>
            ✎ {t('chat.newChat')}
          </button>
        )}
      </div>
      <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 14 }}>{t('chat.subtitle')}</p>

      {status && !status.configured && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--border)', marginBottom: 16, fontSize: 13 }}>
          <span style={{ flex: 1 }}>{t('search.noKey')}</span>
          <button className="pill pill-active" onClick={() => navigate('/settings')}>{t('search.openSettings')}</button>
        </div>
      )}

      {/* ===== Thread ===== */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {msgs.length === 0 && !busy && (
          <div className="rise" style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 0 4px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <span className="uc-header" style={{ fontSize: 11 }}>{t('chat.skills')}</span>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('chat.skillsHint')}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="pill" style={{ padding: '6px 12px' }} disabled={!status?.configured} onClick={() => insert(t('chat.skill.buy'))}>🛒 {t('chat.skill.buy')}</button>
                <button className="pill" style={{ padding: '6px 12px' }} disabled={!status?.configured} onClick={() => insert(t('chat.skill.tonight'))}>🎮 {t('chat.skill.tonight')}</button>
                <button className="pill" style={{ padding: '6px 12px' }} disabled={!status?.configured} onClick={() => insert(t('chat.skill.backlog'))}>📚 {t('chat.skill.backlog')}</button>
                <button className="pill" style={{ padding: '6px 12px' }} disabled={!status?.configured} onClick={() => insert(t('chat.skill.wishlist'))}>💸 {t('chat.skill.wishlist')}</button>
              </div>
            </div>
            <div>
              <div className="uc-header" style={{ fontSize: 11, marginBottom: 8 }}>{t('chat.examples')}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {examples.map((ex) => (
                  <button key={ex} className="pill" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!status?.configured} onClick={() => insert(ex)}>{ex}</button>
                ))}
              </div>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted)' }}>{t('chat.privacy')}</p>
          </div>
        )}

        {msgs.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} style={{ alignSelf: 'flex-end', maxWidth: '78%', ...bubble, background: 'rgba(87,184,240,0.14)', borderColor: 'rgba(87,184,240,0.35)' }}>
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="rise" style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {m.error ? (
                <div style={{ ...bubble, borderColor: 'rgba(255,107,107,0.4)', color: '#ff9f9f', fontSize: 13 }}>{errorText(m.error)}</div>
              ) : (
                <div style={bubble}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, padding: '1px 5px', borderRadius: 4, border: '1px solid rgba(185,203,224,0.5)', color: '#b9cbe0' }}>AI</span>
                  </div>
                  <Markdown text={m.content || '…'} />

                  {m.reply && m.reply.games.length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 8, marginTop: 12 }}>
                      {m.reply.games.map((g) =>
                        g.owned ? (
                          <OwnedRow key={`${g.title}-${g.appid ?? g.epicAppName ?? ''}`} g={g} />
                        ) : g.appid && storeMeta[g.appid] ? (
                          <div key={g.title} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            <ItemCard item={storeMeta[g.appid]} own={own} />
                            {g.note && <span style={{ fontSize: 12, color: 'var(--muted)', paddingTop: 6 }}>{g.note}</span>}
                          </div>
                        ) : (
                          <div key={g.title} className="lib-row" style={{ height: 'auto', minHeight: 48, padding: '6px 10px', cursor: g.appid ? 'pointer' : 'default' }} onClick={() => g.appid && navigate(`/store/app/${g.appid}`)}>
                            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span className="ttl" style={{ fontWeight: 600 }}>{g.title}</span>
                              {g.note && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{g.note}</span>}
                            </span>
                            {g.appid && <span className="pill" style={{ padding: '4px 10px', fontSize: 12 }}>{t('chat.store')} →</span>}
                          </div>
                        )
                      )}
                    </div>
                  )}

                  {m.reply && (m.reply.libraryResults.length > m.reply.games.filter((g) => g.owned).length || m.reply.storeResults.length > 0) && (
                    <div style={{ marginTop: 12 }}>
                      <button className="pill" style={{ padding: '3px 9px', fontSize: 11.5, color: 'var(--muted)' }} onClick={() => setOpenAll((p) => ({ ...p, [m.id]: !p[m.id] }))}>
                        {openAll[m.id] ? '▾' : '▸'} {t('chat.allResults', { n: m.reply.libraryResults.length + m.reply.storeResults.length })}
                      </button>
                      {openAll[m.id] && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                          {m.reply.libraryResults.length > 0 && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 6 }}>
                              {m.reply.libraryResults.map((g) => (
                                <button key={`${g.title}-${g.appid ?? ''}`} className={`lib-row${g.installed ? ' inst' : ''}`} style={{ height: 44, padding: '0 8px' }} onClick={() => navigate(gameRoute(g))} title={g.title}>
                                  <Cover g={g} w={70} h={33} />
                                  <span className="ttl" style={{ fontSize: 12.5 }}>{g.title}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          {m.reply.storeResults.length > 0 && (
                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                              {m.reply.storeResults.map((id) => storeMeta[id] && <ItemCard key={id} item={storeMeta[id]} own={own} />)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {m.reply && m.reply.suggestions.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                      {m.reply.suggestions.map((s) => (
                        <button key={s} className="pill" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!canSend} onClick={() => void send(s)}>{s} →</button>
                      ))}
                    </div>
                  )}

                  {m.reply && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10 }}>
                      {m.reply.model} · {t('search.tokens', { n: m.reply.usage.promptTokens + m.reply.usage.completionTokens })}
                      {m.reply.toolsUsed.length > 0 && ` · ${t('chat.toolsUsed', { t: m.reply.toolsUsed.map((x) => t(`chat.tool.${x}`)).join(', ') })}`}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        )}

        {busy && <Thinking progress={progress} />}
        <div ref={endRef} />
      </div>

      {/* ===== Composer (sticky) ===== */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        style={{ position: 'sticky', bottom: 0, display: 'flex', gap: 10, padding: '14px 0 18px', background: 'linear-gradient(180deg, rgba(19,25,34,0) 0%, var(--bg) 30%)' }}
      >
        <div className="field-wrap" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, height: 46, padding: '0 14px', borderRadius: 12, background: 'var(--input-bg)', border: `1px solid ${busy ? 'rgba(87,184,240,0.5)' : 'var(--border)'}`, transition: 'border-color 0.2s ease' }}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('chat.placeholder')}
            maxLength={800}
            disabled={busy}
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: 0, fontSize: 15 }}
          />
          {input && !busy && <button type="button" className="field-clear" onClick={() => insert('')} title={t('chat.clear')}>✕</button>}
        </div>
        <button
          type="submit"
          disabled={!canSend || !input.trim()}
          style={{ padding: '0 22px', minWidth: 110, borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 14, color: 'var(--on-accent)', background: 'linear-gradient(180deg, #6cc4f6 0%, #2f8fd0 100%)', boxShadow: '0 6px 20px rgba(87,184,240,0.3)' }}
        >
          {busy ? t('chat.thinkingShort') : t('chat.send')}
        </button>
      </form>
    </div>
  );
};

export default AiPage;
