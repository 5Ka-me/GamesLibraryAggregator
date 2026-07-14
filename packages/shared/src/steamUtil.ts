import { GameEntry } from './api/client';

// Steam deep links encode the appid: steam://rungameid/<id> and
// steam://install/<id>. Recover the appid to match against install-state.
export function steamAppId(entry: GameEntry): string | null {
  if (entry.source !== 'Steam') return null;
  const url = entry.launchUrl ?? entry.installUrl;
  const match = url?.match(/steam:\/\/(?:rungameid|install)\/(\d+)/);
  return match ? match[1] : null;
}
