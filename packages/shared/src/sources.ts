// Single registry of game sources. Adding a new store (e.g. GOG) to the UI:
//
//   1. Add its id to SOURCE_IDS and an entry to SOURCES below (label + color).
//   2. Define the CSS color variable in both index.css files (web + launcher).
//   3. Add an install-state resolver in installState.ts (if detectable locally).
//   4. Backend: extend the GameSource enum + add a sync service (see
//      EpicGamesService/SteamService for the pattern). DTO `sources` strings
//      must match the ids here.
//
// GameCard needs no changes for a deep-link-only source — unknown sources
// automatically fall back to the generic launch/install links branch.

export const SOURCE_IDS = ['Steam', 'Epic'] as const;

export type Source = (typeof SOURCE_IDS)[number];

export interface SourceMeta {
  id: Source;
  /** Display label (brand name — not translated). */
  label: string;
  /** Tag/badge background (CSS color or var). */
  color: string;
}

export const SOURCES: SourceMeta[] = [
  { id: 'Steam', label: 'Steam', color: 'var(--accent)' },
  { id: 'Epic', label: 'Epic', color: 'var(--epic)' },
];

/** Meta for a source id; tolerant of unknown ids (renders in muted color). */
export function sourceMeta(id: string): SourceMeta {
  return (
    SOURCES.find((s) => s.id === id) ?? { id: id as Source, label: id, color: 'var(--muted)' }
  );
}
