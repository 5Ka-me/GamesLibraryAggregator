import { apiFetch } from './apiClient';

// Per-platform store regions, resolved from the cloud API's account data
// (auto-detected at auth time, user-overridable in Settings). Fallback: US.
// Cached briefly so every storefront request doesn't hit the backend.

interface Regions {
  steamCc: string;
  epicCc: string;
}

let cache: { at: number; value: Regions } | null = null;
const TTL_MS = 60_000;

const isCc = (c: unknown): c is string => typeof c === 'string' && /^[A-Za-z]{2}$/.test(c);

export async function getRegions(): Promise<Regions> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  let steamCc = 'US';
  let epicCc = 'US';
  try {
    const acc = await apiFetch<{ country?: string | null }>('/api/steam/account');
    if (isCc(acc.country)) steamCc = acc.country.toUpperCase();
  } catch {
    /* backend unreachable — fallback */
  }
  try {
    const acc = await apiFetch<{ country?: string | null }>('/api/epic/account');
    if (isCc(acc.country)) epicCc = acc.country.toUpperCase();
  } catch {
    /* fallback */
  }

  cache = { at: Date.now(), value: { steamCc, epicCc } };
  return cache.value;
}
