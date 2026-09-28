import { useCallback, useEffect, useMemo, useState } from 'react';
import { epicAppName, steamAppId, type Game } from '@app/shared';
import type { CollectionRule, GameHandle, ResolvedCollection } from '../../../preload';
import { gameKey } from '../pages/LibraryPage';

// Collections as the renderer sees them: resolved member keys per collection,
// refreshed on every change (main emits collections:changed), on library
// syncs and when AI profiles land (dynamic rules may depend on them).

let cached: ResolvedCollection[] | null = null;
const listeners = new Set<(c: ResolvedCollection[]) => void>();
let subscribed = false;
let inflight: Promise<ResolvedCollection[]> | null = null;
let dirty = false;

/** One resolve at a time; a change that lands mid-flight schedules another pass instead of being lost. */
function load(): Promise<ResolvedCollection[]> {
  if (inflight) {
    dirty = true;
    return inflight;
  }
  inflight = window.launcher
    .collectionsResolve()
    .catch(() => cached ?? [])
    .then((c) => {
      cached = c;
      for (const l of listeners) l(c);
      inflight = null;
      if (dirty) {
        dirty = false;
        void load();
      }
      return c;
    });
  return inflight;
}

/** The store handles the main process needs to identify a game across syncs. */
export function gameHandle(g: Game): GameHandle {
  const refs: GameHandle['refs'] = [];
  for (const e of g.entries) {
    if (e.source === 'Steam') {
      const id = steamAppId(e);
      if (id) refs.push({ source: 'Steam', id });
    } else if (e.source === 'Epic') {
      const id = epicAppName(e);
      if (id) refs.push({ source: 'Epic', id });
    }
  }
  return { title: g.title, refs };
}

export interface CollectionsApi {
  collections: ResolvedCollection[];
  /** User collections (built-ins excluded), in display order. */
  custom: ResolvedCollection[];
  favoriteKeys: Set<string>;
  hiddenKeys: Set<string>;
  isFavorite: (g: Game) => boolean;
  isHidden: (g: Game) => boolean;
  /** Ids of the manual collections this game is in. */
  memberOf: (g: Game) => string[];
  toggle: (id: string, g: Game) => Promise<void>;
  create: (name: string, kind: 'manual' | 'dynamic', rule?: CollectionRule) => Promise<ResolvedCollection | null>;
  rename: (id: string, name: string) => Promise<void>;
  update: (id: string, patch: { name?: string; kind?: 'manual' | 'dynamic'; rule?: CollectionRule }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  resetSteam: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useCollections(): CollectionsApi {
  const [collections, setCollections] = useState<ResolvedCollection[]>(cached ?? []);
  useEffect(() => {
    listeners.add(setCollections);
    if (!cached) void load();
    if (!subscribed) {
      subscribed = true;
      window.launcher.onCollectionsChanged(() => void load());
      window.launcher.onLibraryChanged(() => void load());
      window.launcher.onEnrichProgress((p) => {
        if (!p.running) void load();
      });
    }
    return () => {
      listeners.delete(setCollections);
    };
  }, []);

  const favoriteKeys = useMemo(() => new Set(collections.find((c) => c.system === 'favorite')?.keys ?? []), [collections]);
  const hiddenKeys = useMemo(() => new Set(collections.find((c) => c.system === 'hidden')?.keys ?? []), [collections]);
  const custom = useMemo(() => collections.filter((c) => !c.system).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)), [collections]);
  const manualById = useMemo(() => new Map(collections.filter((c) => c.kind === 'manual').map((c) => [c.id, new Set(c.keys)])), [collections]);

  const refresh = useCallback(async () => {
    await load();
  }, []);

  return {
    collections,
    custom,
    favoriteKeys,
    hiddenKeys,
    isFavorite: (g) => favoriteKeys.has(gameKey(g)),
    isHidden: (g) => hiddenKeys.has(gameKey(g)),
    memberOf: (g) => {
      const k = gameKey(g);
      return [...manualById.entries()].filter(([, keys]) => keys.has(k)).map(([id]) => id);
    },
    toggle: async (id, g) => {
      const inIt = manualById.get(id)?.has(gameKey(g)) ?? false;
      await window.launcher.collectionsSetMembership(id, gameHandle(g), !inIt);
      await load();
    },
    create: async (name, kind, rule) => {
      const c = await window.launcher.collectionsCreate({ name, kind, rule });
      const list = await load();
      return list.find((x) => x.id === c.id) ?? null;
    },
    rename: async (id, name) => {
      await window.launcher.collectionsUpdate(id, { name });
      await load();
    },
    update: async (id, patch) => {
      await window.launcher.collectionsUpdate(id, patch);
      await load();
    },
    remove: async (id) => {
      await window.launcher.collectionsDelete(id);
      await load();
    },
    resetSteam: async (id) => {
      await window.launcher.collectionsResetSteam(id);
      await load();
    },
    refresh,
  };
}
