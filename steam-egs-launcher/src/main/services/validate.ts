// Input validation shared by the IPC boundary, the local bridge and the
// services. Everything crossing a trust boundary — renderer arguments, remote
// store payloads, web origins — is checked here rather than ad hoc per call
// site, so the rules stay in one auditable place.

/** True for http(s) URLs only — the sole schemes we hand to the OS browser. */
export function isWebUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** A browser origin that may be granted bridge access (no opaque/file/extension origins). */
export function isPairableOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string' || !origin || origin === 'null') return false;
  try {
    const url = new URL(origin);
    // An origin is scheme://host[:port] and nothing else.
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !!url.hostname &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      origin === url.origin
    );
  } catch {
    return false;
  }
}

/** A Steam appid from the renderer; throws rather than reaching Steam malformed. */
export function requireAppId(value: unknown): number {
  const appid = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(appid) || appid <= 0 || appid > 2 ** 31) {
    throw new Error(`Invalid Steam appid: ${String(value)}`);
  }
  return appid;
}

/**
 * An Epic artifact id (legendary's app name). Passed to a spawned CLI as an
 * argument, so a leading dash — which the CLI would parse as a flag — and any
 * character outside the id alphabet are rejected.
 */
export function requireEpicAppName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid Epic app name: ${String(value)}`);
  }
  return name;
}

/** ISO alpha-2 store region, uppercased. */
export function normalizeCountry(value: unknown): string {
  const cc = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(cc)) {
    throw new Error('Country must be a 2-letter ISO code (e.g. UA, KZ, US).');
  }
  return cc;
}

/** A SteamID64 as Steam formats it. */
export const isSteamId = (value: unknown): value is string =>
  typeof value === 'string' && /^7656\d{13}$/.test(value);
