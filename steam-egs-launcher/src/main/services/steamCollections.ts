// Parser for the Steam client's library collections as stored on disk.
// No imports on purpose: this file is unit-tested with plain node.
//
// Steam keeps collections in Steam Cloud "namespace 1", mirrored locally as
//   <Steam>/userdata/<accountid>/config/cloudstorage/cloud-storage-namespace-1.json
// (an array of [key, record] pairs) plus a sibling
//   cloud-storage-namespace-1.modified.json
// with not-yet-synced local edits that override the base file. Records with
// key "user-collections.<id>" carry a JSON string value:
//   {"id":"uc-…","name":"…","added":[appid…],"removed":[appid…],"filterSpec":{…}?}
// "favorite" and "hidden" are the two built-in collections; a record with
// is_deleted:true is a tombstone.

export interface SteamCollection {
  id: string;
  name: string;
  /** Appids the user put in explicitly (for dynamic collections: manual additions on top of the filter). */
  added: number[];
  removed: number[];
  /** Steam-side dynamic collection (filter by tags/genres/…); only `added` can be reproduced here. */
  dynamic: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function records(raw: unknown): Map<string, any> {
  const out = new Map<string, any>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (Array.isArray(item) && typeof item[0] === 'string') out.set(item[0], item[1]);
    else if (item && typeof item === 'object' && typeof (item as any).key === 'string') out.set((item as any).key, item);
  }
  return out;
}

const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

/**
 * Parses the base file and (optionally) the .modified overlay. Tombstoned
 * collections are dropped; a modified record replaces the base one wholesale.
 */
export function parseSteamCollections(baseJson: string, modifiedJson?: string | null): SteamCollection[] {
  const merged = records(JSON.parse(baseJson));
  if (modifiedJson) {
    try {
      for (const [k, v] of records(JSON.parse(modifiedJson))) merged.set(k, v);
    } catch {
      /* a broken overlay must not hide the base file */
    }
  }
  const out: SteamCollection[] = [];
  for (const [key, rec] of merged) {
    if (!key.startsWith('user-collections.')) continue;
    if (!rec || typeof rec !== 'object' || rec.is_deleted) continue;
    let value: any = rec.value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    }
    if (!value || typeof value !== 'object') continue;
    const id = typeof value.id === 'string' && value.id ? value.id : key.slice('user-collections.'.length);
    const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id;
    out.push({ id, name, added: ids(value.added), removed: ids(value.removed), dynamic: !!value.filterSpec && typeof value.filterSpec === 'object' });
  }
  return out;
}

/** SteamID64 → the 32-bit account id used for the userdata folder name. */
export function accountIdFromSteamId64(steamId: string): string | null {
  if (!/^\d{17}$/.test(steamId)) return null;
  try {
    return (BigInt(steamId) - 76561197960265728n).toString();
  } catch {
    return null;
  }
}
