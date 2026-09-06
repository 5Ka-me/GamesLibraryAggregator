import { normalizeTitle } from '@app/shared';
import { getEntries, type StoredEntry } from './localData';

// Read model of the merged library: entries from both stores grouped by
// normalized title (the shared matching key, so the UI's cross-store badges
// agree with this grouping). The shape is the GameDto the renderer, the web
// app and the bridge all consume.

export interface GameEntryDto {
  source: 'Steam' | 'Epic';
  iconUrl: string | null;
  storeUrl: string | null;
  namespace: string | null;
  playtimeMinutes: number | null;
  acquisitionDate: string | null;
  lastPlayedAt: string | null;
  playtime2WeeksMinutes: number | null;
  playtimeDeckMinutes: number | null;
  launchUrl: string | null;
  installUrl: string | null;
}

export interface GameDto {
  title: string;
  iconUrl: string | null;
  sources: string[];
  entries: GameEntryDto[];
}

// Deep-link format the renderer parses ids back out of (see shared
// steamUtil.ts / epicUtil.ts). Components are URL-encoded: they come from the
// stores' APIs and a stray `&`/`?` would rewrite the link's parameters.
function toDto(e: StoredEntry): GameEntryDto {
  const steam = e.source === 'Steam';
  const epicLink =
    !steam && e.namespace && e.appName
      ? (action: string) =>
          `com.epicgames.launcher://apps/${encodeURIComponent(e.namespace!)}%3A` +
          `${encodeURIComponent(e.externalId)}%3A${encodeURIComponent(e.appName!)}` +
          `?action=${action}&silent=true`
      : null;
  return {
    source: e.source,
    iconUrl: e.iconUrl ?? null,
    storeUrl: steam
      ? `https://store.steampowered.com/app/${encodeURIComponent(e.externalId)}`
      : e.storeUrl ?? null,
    namespace: e.namespace ?? null,
    playtimeMinutes: e.playtimeMinutes ?? null,
    acquisitionDate: e.acquisitionDate ?? null,
    lastPlayedAt: e.lastPlayedAt ?? null,
    playtime2WeeksMinutes: e.playtime2WeeksMinutes ?? null,
    playtimeDeckMinutes: e.playtimeDeckMinutes ?? null,
    launchUrl: steam
      ? `steam://rungameid/${encodeURIComponent(e.externalId)}`
      : epicLink?.('launch') ?? null,
    installUrl: steam
      ? `steam://install/${encodeURIComponent(e.externalId)}`
      : epicLink?.('install') ?? null,
  };
}

/** The combined library, grouped and ordered like the backend served it. */
export function buildLibrary(): GameDto[] {
  const groups = new Map<string, StoredEntry[]>();
  for (const e of getEntries()) {
    const key = normalizeTitle(e.title);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const games: GameDto[] = [];
  for (const list of groups.values()) {
    // Steam entries first (matches the backend's Source-enum ordering).
    list.sort((a, b) => (a.source === b.source ? 0 : a.source === 'Steam' ? -1 : 1));
    const entries = list.map(toDto);
    games.push({
      title: list[0].title,
      iconUrl: entries.find((e) => e.iconUrl)?.iconUrl ?? null,
      sources: [...new Set(list.map((e) => e.source))],
      entries,
    });
  }

  games.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return games;
}
