import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n, type Game } from '@app/shared';
import { gameHandle, useCollections } from '../hooks/useCollections';

// Context menu for one game: favourite, hide, and a checklist of manual
// collections (plus "new collection" inline). Opened by right-click on a
// library row or from the game page's "Add to collection" button.

export interface MenuAnchor {
  x: number;
  y: number;
}

export const CollectionMenu: React.FC<{ game: Game; anchor: MenuAnchor; onClose: () => void }> = ({ game, anchor, onClose }) => {
  const { t } = useI18n();
  const col = useCollections();
  const ref = useRef<HTMLDivElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Keep the menu on screen.
  const [pos, setPos] = useState(anchor);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(anchor.x, window.innerWidth - r.width - 8), y: Math.min(anchor.y, window.innerHeight - r.height - 8) });
  }, [anchor]);

  const memberOf = new Set(col.memberOf(game));
  const fav = col.isFavorite(game);
  const hidden = col.isHidden(game);
  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  const createAndAdd = async () => {
    const n = name.trim();
    if (!n) return;
    await run('new', async () => {
      const c = await col.create(n, 'manual');
      if (c) await window.launcher.collectionsSetMembership(c.id, gameHandle(game), true);
      await col.refresh();
    });
    setName('');
    setCreating(false);
  };

  const item = (key: string, label: React.ReactNode, checked: boolean | null, onClick: () => void, extra?: React.ReactNode) => (
    <button key={key} className="ctx-item" disabled={busy !== null} onClick={onClick}>
      <span className="ctx-check">{checked === null ? '' : checked ? '✓' : ''}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {extra}
    </button>
  );

  // Portal: the library aside and the game pane are their own stacking contexts, so a fixed menu inside them would be covered.
  return createPortal(
    <div ref={ref} className="ctx-menu rise" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title" title={game.title}>{game.title}</div>
      {item('fav', `${fav ? '★' : '☆'} ${t(fav ? 'col.unfavorite' : 'col.favorite')}`, null, () => void run('favorite', () => col.toggle('favorite', game)))}
      {item('hide', t(hidden ? 'col.unhide' : 'col.hide'), null, () => void run('hidden', () => col.toggle('hidden', game)))}
      <div className="ctx-sep" />
      <div className="ctx-label">{t('col.addTo')}</div>
      {col.custom.filter((c) => c.kind === 'manual').length === 0 && !creating && <div className="ctx-empty">{t('col.none')}</div>}
      {col.custom
        .filter((c) => c.kind === 'manual')
        .map((c) =>
          item(
            c.id,
            c.name,
            memberOf.has(c.id),
            () => void run(c.id, () => col.toggle(c.id, game)),
            c.origin === 'steam' ? <span className="ctx-badge">Steam</span> : undefined
          )
        )}
      {col.custom.filter((c) => c.kind === 'dynamic').length > 0 && (
        <div className="ctx-empty">{t('col.dynamicNote', { n: col.custom.filter((c) => c.kind === 'dynamic').length })}</div>
      )}
      <div className="ctx-sep" />
      {creating ? (
        <form
          className="ctx-new"
          onSubmit={(e) => {
            e.preventDefault();
            void createAndAdd();
          }}
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('col.namePlaceholder')} maxLength={60} />
          <button type="submit" className="pill pill-active" disabled={!name.trim() || busy !== null}>{t('col.create')}</button>
        </form>
      ) : (
        item('new', `+ ${t('col.newCollection')}`, null, () => setCreating(true))
      )}
    </div>,
    document.body
  );
};

export default CollectionMenu;
