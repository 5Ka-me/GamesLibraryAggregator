import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { TAG_CHIPS, useI18n, type TagChip } from '@app/shared';
import type { CollectionRule, ResolvedCollection } from '../../../preload';
import { useCollections } from '../hooks/useCollections';

// Create / edit dialog for a collection. Manual collections only need a name;
// dynamic ones get a rule built from the same filters the assistant's
// library tool uses, with a live "N games match" preview.

const PLAYED = ['never', '<1h', '1-10h', '10-50h', '50h+', 'any_played'] as const;
const ACH = ['none', 'started', 'half', 'almost', 'perfect', 'has_any'] as const;
const LAST = ['last_2_weeks', 'last_90_days', 'over_180_days_ago', 'never'] as const;

export const CollectionEditor: React.FC<{ existing: ResolvedCollection | null; onClose: () => void }> = ({ existing, onClose }) => {
  const { t } = useI18n();
  const col = useCollections();
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<'manual' | 'dynamic'>(existing?.kind ?? 'manual');
  const [rule, setRule] = useState<CollectionRule>(existing?.rule ?? {});
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSteam = existing?.origin === 'steam';

  useEffect(() => {
    if (kind !== 'dynamic') return;
    let alive = true;
    const timer = setTimeout(() => {
      window.launcher
        .collectionsPreview(rule)
        .then((n) => alive && setPreview(n))
        .catch(() => alive && setPreview(null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [kind, rule]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof CollectionRule>(k: K, v: CollectionRule[K] | undefined) =>
    setRule((r) => {
      const next = { ...r };
      if (v === undefined || (Array.isArray(v) && v.length === 0) || v === '') delete next[k];
      else next[k] = v;
      return next;
    });
  const toggleIn = <T extends string>(list: T[] | undefined, v: T): T[] => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (existing) await col.update(existing.id, { name, ...(existing.system ? {} : { kind, rule: kind === 'dynamic' ? rule : undefined }) });
      else await col.create(name, kind, kind === 'dynamic' ? rule : undefined);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!existing || !window.confirm(t('col.deleteConfirm', { n: existing.name }))) return;
    setBusy(true);
    try {
      await col.remove(existing.id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const select = (label: string, value: string | undefined, options: readonly string[], prefix: string, onChange: (v: string | undefined) => void) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)', minWidth: 150 }}>
      {label}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} style={{ padding: '6px 8px', borderRadius: 6, background: 'var(--input-bg)', color: 'var(--text)', border: '1px solid var(--border)' }}>
        <option value="">{t('col.any')}</option>
        {options.map((o) => (
          <option key={o} value={o}>{t(`${prefix}.${o}`)}</option>
        ))}
      </select>
    </label>
  );

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal rise" role="dialog" aria-modal="true">
        <h3 style={{ margin: '0 0 12px', fontSize: 18 }}>{existing ? t('col.edit') : t('col.newCollection')}</h3>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
          {t('col.name')}
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t('col.namePlaceholder')} disabled={!!existing?.system} />
        </label>
        {isSteam && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--muted)' }}>{t('col.steamOriginNote')}</p>}

        {!existing?.system && !isSteam && (
          <div style={{ display: 'flex', gap: 6, margin: '14px 0 4px' }}>
            <button className={`pill${kind === 'manual' ? ' pill-active' : ''}`} onClick={() => setKind('manual')}>{t('col.kind.manual')}</button>
            <button className={`pill${kind === 'dynamic' ? ' pill-active' : ''}`} onClick={() => setKind('dynamic')}>{t('col.kind.dynamic')}</button>
          </div>
        )}
        <p style={{ margin: '4px 0 12px', fontSize: 12, color: 'var(--muted)' }}>{t(kind === 'dynamic' ? 'col.kind.dynamicHint' : 'col.kind.manualHint')}</p>

        {kind === 'dynamic' && !isSteam && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 90 }}>{t('col.rule.sources')}</span>
              {(['Steam', 'Epic'] as const).map((s) => (
                <button key={s} className={`pill${rule.sources?.includes(s) ? ' pill-active' : ''}`} style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => set('sources', toggleIn(rule.sources, s))}>
                  {s === 'Epic' ? 'EGS' : s}
                </button>
              ))}
              <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 12 }}>{t('col.rule.installed')}</span>
              <button className={`pill${rule.installed === true ? ' pill-active' : ''}`} style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => set('installed', rule.installed === true ? undefined : true)}>{t('col.yes')}</button>
              <button className={`pill${rule.installed === false ? ' pill-active' : ''}`} style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => set('installed', rule.installed === false ? undefined : false)}>{t('col.no')}</button>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {select(t('col.rule.played'), rule.played, PLAYED, 'col.played', (v) => set('played', v as CollectionRule['played']))}
              {select(t('col.rule.achievements'), rule.achievements, ACH, 'col.ach', (v) => set('achievements', v as CollectionRule['achievements']))}
              {select(t('col.rule.lastPlayed'), rule.lastPlayed, LAST, 'col.last', (v) => set('lastPlayed', v as CollectionRule['lastPlayed']))}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 90 }}>{t('col.rule.chips')}</span>
              {TAG_CHIPS.map((c: TagChip) => (
                <button key={c} className={`pill${rule.chips?.includes(c) ? ' pill-active' : ''}`} style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => set('chips', toggleIn(rule.chips, c))}>
                  {t(`tag.chip.${c}`)}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
                {t('col.rule.titleContains')}
                <input value={rule.titleContains ?? ''} onChange={(e) => set('titleContains', e.target.value || undefined)} maxLength={80} />
              </label>
              <label style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }} title={t('col.rule.steamTagsHint')}>
                {t('col.rule.steamTags')}
                <input value={rule.steamTags?.join(', ') ?? ''} onChange={(e) => set('steamTags', e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6))} placeholder="VR, Roguelike" maxLength={120} />
              </label>
            </div>
            <div style={{ fontSize: 13, color: preview === 0 ? '#f0a35a' : 'var(--text)' }}>
              {preview === null ? '…' : t('col.preview', { n: preview })}
            </div>
          </div>
        )}

        {error && <p style={{ color: '#ff9f9f', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 18, alignItems: 'center' }}>
          <button className="pill pill-active" style={{ padding: '7px 16px' }} disabled={busy || !name.trim()} onClick={() => void save()}>{t('col.save')}</button>
          <button className="pill" style={{ padding: '7px 14px' }} disabled={busy} onClick={onClose}>{t('col.cancel')}</button>
          <span style={{ flex: 1 }} />
          {existing && isSteam && existing.edited && (
            <button className="pill" style={{ padding: '7px 14px' }} disabled={busy} title={t('col.resetSteamHint')} onClick={() => void (async () => { setBusy(true); try { await col.resetSteam(existing.id); onClose(); } finally { setBusy(false); } })()}>
              ↺ {t('col.resetSteam')}
            </button>
          )}
          {existing && !existing.system && (
            <button className="pill" style={{ padding: '7px 14px', color: '#ff9f9f' }} disabled={busy} onClick={() => void remove()}>{t('col.delete')}</button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default CollectionEditor;
