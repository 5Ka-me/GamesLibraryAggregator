import { Game, GameEntry, Source } from './api/client';
import { LibraryActions } from './libraryActions';
import { epicAppName } from './epicUtil';
import { steamAppId } from './steamUtil';

// Per-source install-state resolvers. Adding a new source with local install
// detection = one entry here (see sources.ts for the full checklist); sources
// without a resolver simply never count as installed.
type InstallResolver = (entry: GameEntry, actions: LibraryActions) => boolean;

const resolvers: Partial<Record<Source, InstallResolver>> = {
  Steam: (entry, actions) => {
    const id = steamAppId(entry);
    return !!id && actions.getSteamState(id).installed;
  },
  Epic: (entry, actions) => {
    const name = epicAppName(entry);
    return !!name && actions.getEpicState(name).installed;
  },
};

/**
 * Given the injected manager (launcher only), report which of a game's sources
 * are currently installed on this machine. Used for the installed tag on cards
 * and the Installed filter.
 */
export function installedSources(game: Game, actions: LibraryActions): Source[] {
  const result: Source[] = [];
  for (const entry of game.entries) {
    const resolver = resolvers[entry.source];
    if (resolver && resolver(entry, actions) && !result.includes(entry.source)) {
      result.push(entry.source);
    }
  }
  return result;
}

export function isInstalled(game: Game, actions: LibraryActions): boolean {
  return installedSources(game, actions).length > 0;
}
