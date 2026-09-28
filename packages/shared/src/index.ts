// Public surface of @app/shared — consumed by the web app and the Electron
// launcher. Uses explicit re-exports (not `export *`) so the compiled CommonJS
// keeps statically-detectable named exports for Rollup/webpack.

export { api, steamLoginUrl, configureTransport } from './api/client';
export type {
  Source,
  GameEntry,
  Game,
  Me,
  EpicAuthResult,
  SteamAccount,
  EpicAccount,
  SteamRecentGame,
  SteamAchievement,
  SteamGameAchievements,
  ApiRequestInit,
  ApiTransport,
  SteamAchievementProgress,
  PlaytimeHistory,
} from './api/client';

export {
  configurePlatform,
  openExternal,
  hasDeepLinkHandler,
  openDeepLink,
  getOpenGameDetails,
} from './platform';

export { I18nProvider, useI18n } from './i18n/I18nContext';
export type { Lang } from './i18n/I18nContext';

export { ThemeProvider, useTheme } from './theme/ThemeContext';

export { LibraryActionsProvider, useLibraryActions } from './libraryActions';
export type { LibraryActions, GameInstallState } from './libraryActions';
export { epicAppName } from './epicUtil';
export { steamAppId } from './steamUtil';
export { normalizeTitle } from './matching';
export { TAG_CHIPS, chipMatches } from './tagChips';
export type { TagChip, ProfileLike } from './tagChips';
export { economyImage, isFoil, notableQuality, parseMoney, qualityRank, rarityRank, stackKey, tagOf } from './inventoryUtil';
export type { InvTagLike } from './inventoryUtil';

export { SOURCES, SOURCE_IDS, sourceMeta } from './sources';
export type { SourceMeta } from './sources';
export { installedSources, isInstalled } from './installState';

export { default as GameCard } from './components/GameCard';
export { default as GameList } from './components/GameList';
export { default as Header } from './components/Header';
export { default as SteamPanel } from './components/SteamPanel';
export { default as EpicPanel } from './components/EpicPanel';
