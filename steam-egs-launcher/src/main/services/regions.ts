import { getEpicAccount, getSteamAccount } from './localData';

// Per-platform store regions (auto-detected at auth time, user-overridable in
// Settings), read straight from the local account data. Fallback: US.

interface Regions {
  steamCc: string;
  epicCc: string;
}

const isCc = (c: unknown): c is string => typeof c === 'string' && /^[A-Za-z]{2}$/.test(c);

export function getRegions(): Regions {
  const steam = getSteamAccount().country;
  const epic = getEpicAccount().country;
  return {
    steamCc: isCc(steam) ? steam.toUpperCase() : 'US',
    epicCc: isCc(epic) ? epic.toUpperCase() : 'US',
  };
}
