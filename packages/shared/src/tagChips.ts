// Quick filter chips built on the AI game profiles (library list, random
// reel, dynamic collections). Shared between the renderer and the launcher's
// main process so both evaluate a chip the same way.

/** The subset of a game profile the chips look at (structural, so main and renderer types both fit). */
export interface ProfileLike {
  known: boolean;
  endless: boolean;
  lengthHours: number | null;
  genres: string[];
  moods: string[];
  modes: string[];
  coopPlayers: number | null;
}

export type TagChip = 'short' | 'coop' | 'story' | 'cozy' | 'horror' | 'competitive';
export const TAG_CHIPS: TagChip[] = ['short', 'coop', 'story', 'cozy', 'horror', 'competitive'];

export function chipMatches(chip: TagChip, p: ProfileLike | null | undefined): boolean {
  if (!p || !p.known) return false;
  switch (chip) {
    case 'short':
      return !p.endless && p.lengthHours !== null && p.lengthHours <= 6;
    case 'coop':
      return (p.coopPlayers ?? 0) >= 2 || p.modes.includes('coop_local') || p.modes.includes('coop_online');
    case 'story':
      return p.moods.includes('story_rich') || p.genres.includes('narrative') || p.genres.includes('visual_novel');
    case 'cozy':
      // "relaxing" alone is too broad (Factorio is relaxing to some): cozy, or relaxing without any edge.
      return p.moods.includes('cozy') || (p.moods.includes('relaxing') && !p.moods.some((m) => m === 'challenging' || m === 'tense' || m === 'dark' || m === 'scary' || m === 'competitive'));
    case 'horror':
      return p.genres.includes('horror') || p.moods.includes('scary');
    case 'competitive':
      // PvP as a side mode doesn't make a game competitive; the mood or a PvP-first genre does.
      return p.moods.includes('competitive') || p.genres.some((g) => g === 'battle_royale' || g === 'fighting' || g === 'sports' || g === 'racing') || (p.modes.includes('pvp') && !p.modes.includes('single'));
    default:
      return false;
  }
}
