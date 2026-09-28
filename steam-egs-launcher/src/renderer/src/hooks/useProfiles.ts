import { useEffect, useState } from 'react';
import { normalizeTitle, type Game } from '@app/shared';
import type { GameProfile } from '../../../preload';

// Local AI game profiles (see main/services/enrichment.ts): loaded once,
// refreshed whenever an enrichment run reports progress. Everything derived
// from them in the UI is labelled as an estimate.

let cached: Record<string, GameProfile> | null = null;
const listeners = new Set<(p: Record<string, GameProfile>) => void>();
let subscribed = false;

async function load(): Promise<Record<string, GameProfile>> {
  const p = await window.launcher.enrichGet().catch(() => ({} as Record<string, GameProfile>));
  cached = p;
  for (const l of listeners) l(p);
  return p;
}

export function useProfiles(): Record<string, GameProfile> {
  const [profiles, setProfiles] = useState<Record<string, GameProfile>>(cached ?? {});
  useEffect(() => {
    listeners.add(setProfiles);
    if (!cached) void load();
    if (!subscribed) {
      subscribed = true;
      // A run stores profiles batch by batch — pick them up as they land.
      window.launcher.onEnrichProgress(() => void load());
    }
    return () => {
      listeners.delete(setProfiles);
    };
  }, []);
  return profiles;
}

export const profileFor = (profiles: Record<string, GameProfile>, game: Game | string): GameProfile | null =>
  profiles[normalizeTitle(typeof game === 'string' ? game : game.title)] ?? null;

// Quick filter chips live in @app/shared (tagChips.ts) so the main process evaluates them the same way.
export { TAG_CHIPS, chipMatches } from '@app/shared';
export type { TagChip } from '@app/shared';

/** Compact one-line profile: "≈ 12 h · Roguelike, Action · co-op ×2". */
export function profileLine(p: GameProfile, t: (k: string, v?: Record<string, string | number>) => string): string[] {
  const parts: string[] = [];
  if (p.endless) parts.push(t('tag.endless'));
  else if (p.lengthHours !== null) parts.push(t('tag.length', { h: p.lengthHours }));
  if (p.genres.length) parts.push(p.genres.slice(0, 3).map((g) => t(`tag.genre.${g}`)).join(', '));
  if (p.coopPlayers && p.coopPlayers <= 16) parts.push(t('tag.coop', { n: p.coopPlayers }));
  else if (p.coopPlayers || p.modes.includes('coop_online')) parts.push(t('tag.mode.coop_online'));
  else if (p.modes.includes('pvp') && !p.modes.includes('single')) parts.push(t('tag.mode.pvp'));
  return parts;
}
