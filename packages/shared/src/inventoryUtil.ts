// Helpers for Steam inventory items, shared by the launcher's main process
// (the assistant's inventory tool) and its renderer (the Inventory page), so
// rarity order, stacking and price parsing agree everywhere. Dependency-free.

/** The subset of an inventory tag these helpers read. */
export interface InvTagLike {
  /** Steam's tag category id ("Rarity", "Quality", "Type", "Game", "cardborder", "droprate", …). */
  cat: string;
  /** Steam's internal value id ("Rarity_Ancient_Weapon", "strange", "cardborder_1", …). */
  internal: string;
  /** Localized value name. */
  name: string;
  color?: string | null;
}

// Ordered: the first pattern that matches the internal name wins, so
// "uncommon" is tested before "common" and drop-rate ids before words.
const RARITY_RANKS: [RegExp, number][] = [
  [/droprate_2/i, 4],
  [/droprate_1/i, 3],
  [/droprate_0/i, 2],
  [/arcana|contraband/i, 9],
  [/immortal/i, 8],
  [/ancient|covert|extraordinary/i, 7],
  [/legendary|classified|exotic/i, 6],
  [/mythical|restricted|remarkable/i, 5],
  [/uncommon|industrial/i, 3],
  [/seasonal/i, 3],
  [/rare|mil-?spec|high/i, 4],
  [/common|consumer|base/i, 2],
];

const QUALITY_RANKS: [RegExp, number][] = [
  [/unusual/i, 7],
  [/collector|selfmade|community|valve/i, 6],
  [/strange|tournament|autographed|exalted|corrupted|frozen|cursed|infused/i, 5],
  [/haunted|genuine|vintage|inscribed|heroic|glitter|gold|holo/i, 4],
  [/unique|standard|normal|base/i, 1],
];

const rankOf = (value: string, table: [RegExp, number][]): number => table.find(([re]) => re.test(value))?.[1] ?? 0;

/** Rarity rank, 0 when the item has no rarity tag. Higher is rarer. */
export function rarityRank(tags: InvTagLike[]): number {
  const t = tags.find((x) => /^(rarity|droprate)$/i.test(x.cat));
  return t ? rankOf(t.internal, RARITY_RANKS) || 1 : 0;
}

/** Quality rank (StatTrak, Genuine, Unusual, …), 0 when none. */
export function qualityRank(tags: InvTagLike[]): number {
  const t = tags.find((x) => /^quality$/i.test(x.cat));
  return t ? rankOf(t.internal, QUALITY_RANKS) || 1 : 0;
}

/** The tag of one category, if present. */
export const tagOf = (tags: InvTagLike[], cat: string): InvTagLike | undefined => tags.find((x) => x.cat.toLowerCase() === cat.toLowerCase());

/** A quality worth a badge on the tile (StatTrak™, Souvenir, Genuine, Unusual…); null for plain items. */
export function notableQuality(tags: InvTagLike[]): InvTagLike | null {
  const t = tagOf(tags, 'Quality');
  return t && qualityRank(tags) > 1 ? t : null;
}

/** Foil trading cards carry cardborder_1. */
export const isFoil = (tags: InvTagLike[]): boolean => tags.some((x) => x.cat.toLowerCase() === 'cardborder' && x.internal === 'cardborder_1');

/** Items that are the same thing for a person: same market name, or same name and type when not marketable. */
export const stackKey = (appid: number, item: { hashName: string | null; name: string; type: string }): string =>
  `${appid}|${item.hashName ?? `${item.name}|${item.type}`}`;

/** Steam economy image URL for an icon hash at a square size. */
export const economyImage = (hash: string, size = 128): string =>
  `https://community.fastly.steamstatic.com/economy/image/${hash}/${size}fx${size}f`;

/**
 * Parses a Steam Market price string ("6₴", "3,90₴", "$0.09", "1 234,56 zł",
 * "1,234.56") into a number. A separator followed by one or two digits at the
 * end is the decimal point; any other separator groups thousands.
 */
export function parseMoney(text: string | null | undefined): number | null {
  if (!text) return null;
  const s = text.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let dec = -1;
  if (lastComma >= 0 && lastDot >= 0) dec = Math.max(lastComma, lastDot);
  else {
    const i = Math.max(lastComma, lastDot);
    if (i >= 0 && s.length - i - 1 >= 1 && s.length - i - 1 <= 2) dec = i;
  }
  const whole = (dec >= 0 ? s.slice(0, dec) : s).replace(/[.,]/g, '');
  const frac = dec >= 0 ? s.slice(dec + 1).replace(/[.,]/g, '') : '';
  const n = Number(`${whole || '0'}.${frac || '0'}`);
  return Number.isFinite(n) ? n : null;
}
