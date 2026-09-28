// The dependency-free slice of @app/shared for the launcher's main process.
// electron.vite.config.ts aliases '@app/shared' to this file in the main
// bundle, so main never pulls React or the API client in. Add here only what
// runs without a DOM.
export { normalizeTitle } from './matching';
export { TAG_CHIPS, chipMatches } from './tagChips';
export type { TagChip, ProfileLike } from './tagChips';
export { economyImage, isFoil, notableQuality, parseMoney, qualityRank, rarityRank, stackKey, tagOf } from './inventoryUtil';
export type { InvTagLike } from './inventoryUtil';
