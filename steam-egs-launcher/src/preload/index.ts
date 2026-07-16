import { contextBridge, ipcRenderer } from 'electron';
import type { ApiRequestInit } from '../main/services/apiClient';
import type { InstalledGame } from '../main/services/legendary';
import type { EpicAuthResult } from '../main/services/epicAuth';
import type { SteamLoginResult } from '../main/services/steamAuth';
import type {
  GameDetails,
  SectionSort,
  StoreHome,
  StoreItem,
  StoreSection,
  StoreSectionPage,
  WishlistEntry,
  WishlistItem,
} from '../main/services/steamStore';

export type { SectionSort, StoreSection };
import type { EpicDetails } from '../main/services/epicStore';

export type { EpicDetails, GameDetails, StoreHome, StoreItem, StoreSectionPage, WishlistEntry, WishlistItem };

/** Progress event pushed from the main process during legendary installs. */
export interface DownloadProgress {
  appName: string;
  title?: string;
  pct: number;
  status: 'running' | 'done' | 'error';
  error?: string;
}

// The typed API exposed to the renderer as `window.launcher`. Keep it small and
// serializable — everything crosses the context bridge.
const launcher = {
  /** Proxy a call to the .NET API through the main process. */
  apiFetch: <T = unknown>(path: string, init?: ApiRequestInit): Promise<T> =>
    ipcRenderer.invoke('api:fetch', path, init) as Promise<T>,

  /** Open an http(s) URL in the user's default browser. */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('external:open', url),

  /** Open an OS protocol deep link (steam:// , com.epicgames.launcher://). */
  openDeepLink: (url: string): Promise<void> => ipcRenderer.invoke('deeplink:open', url),

  /** Quit the launcher. */
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),

  // Workspace token (stored encrypted in the OS keystore by the main process).
  getToken: (): Promise<string | null> => ipcRenderer.invoke('workspace:getToken'),
  setToken: (token: string): Promise<void> => ipcRenderer.invoke('workspace:setToken', token),
  clearToken: (): Promise<void> => ipcRenderer.invoke('workspace:clearToken'),

  // API base URL.
  getApiBase: (): Promise<string> => ipcRenderer.invoke('config:getApiBase'),
  setApiBase: (url: string): Promise<void> => ipcRenderer.invoke('config:setApiBase', url),

  // EGS install folder.
  getInstallPath: (): Promise<string> => ipcRenderer.invoke('config:getInstallPath'),
  setInstallPath: (path: string): Promise<void> => ipcRenderer.invoke('config:setInstallPath', path),

  // Steam install-state (appids installed on this machine).
  steamListInstalled: (): Promise<string[]> => ipcRenderer.invoke('steam:listInstalled'),

  // Steam storefront (in-app Store page).
  storeHome: (lang: string, force?: boolean): Promise<StoreHome> =>
    ipcRenderer.invoke('store:home', lang, force),
  storeSearch: (term: string, lang: string): Promise<StoreItem[]> =>
    ipcRenderer.invoke('store:search', term, lang),
  storeWishlist: (steamId: string, force?: boolean): Promise<WishlistEntry[]> =>
    ipcRenderer.invoke('store:wishlist', steamId, force),
  storeItemsMeta: (appids: number[], lang: string): Promise<Record<number, StoreItem>> =>
    ipcRenderer.invoke('store:itemsMeta', appids, lang),
  storeSection: (
    id: string,
    lang: string,
    start: number,
    count: number,
    sort?: SectionSort
  ): Promise<StoreSectionPage> => ipcRenderer.invoke('store:section', id, lang, start, count, sort),
  storeAppDetails: (appid: number, lang: string): Promise<GameDetails> =>
    ipcRenderer.invoke('store:appDetails', appid, lang),
  /** Personalized rows (Discovery Queue etc.); [] when not signed in to Steam. */
  storePersonal: (lang: string, force?: boolean): Promise<StoreSection[]> =>
    ipcRenderer.invoke('store:personal', lang, force),
  /** Epic offer details by namespace (library) or title search; null if not on EGS. */
  epicStoreDetails: (title: string, ns: string | null, lang: string): Promise<EpicDetails | null> =>
    ipcRenderer.invoke('epic:storeDetails', title, ns, lang),
  /** Steam appid by title (strict match); null if the game isn't on Steam. */
  storeFindAppId: (title: string, lang: string): Promise<number | null> =>
    ipcRenderer.invoke('store:findApp', title, lang),
  /** Open a game's store page in the Steam client (or browser if not installed). */
  storeOpenPage: (appid: number): Promise<void> => ipcRenderer.invoke('store:openPage', appid),

  /** Units of `currency` per 1 USD (daily rate), or null when unavailable. */
  fxUsdRate: (currency: string): Promise<number | null> => ipcRenderer.invoke('fx:usdRate', currency),

  // Steam web sign-in (no API key). remember → persisted session.
  steamLogin: (remember: boolean): Promise<SteamLoginResult> =>
    ipcRenderer.invoke('steam:login', remember),
  steamStatus: (): Promise<{ loggedIn: boolean; steamId?: string }> =>
    ipcRenderer.invoke('steam:status'),
  steamLogout: (): Promise<void> => ipcRenderer.invoke('steam:logout'),

  // EGS embedded OAuth (legendary auth + cloud library sync).
  epicLogin: (): Promise<EpicAuthResult> => ipcRenderer.invoke('epic:login'),

  // legendary (EGS download management).
  legendaryAvailable: (): Promise<boolean> => ipcRenderer.invoke('legendary:available'),
  legendaryListInstalled: (): Promise<InstalledGame[]> =>
    ipcRenderer.invoke('legendary:listInstalled'),
  legendaryInstall: (appName: string, title?: string): Promise<void> =>
    ipcRenderer.invoke('legendary:install', appName, title),
  legendaryCancel: (appName: string): Promise<void> => ipcRenderer.invoke('legendary:cancel', appName),
  legendaryUninstall: (appName: string): Promise<void> =>
    ipcRenderer.invoke('legendary:uninstall', appName),
  legendaryLaunch: (appName: string): Promise<void> => ipcRenderer.invoke('legendary:launch', appName),

  /** Subscribe to download progress. Returns an unsubscribe function. */
  onDownloadProgress: (cb: (p: DownloadProgress) => void): (() => void) => {
    const listener = (_e: unknown, payload: DownloadProgress) => cb(payload);
    ipcRenderer.on('legendary:progress', listener);
    return () => ipcRenderer.removeListener('legendary:progress', listener);
  },
};

contextBridge.exposeInMainWorld('launcher', launcher);

export type LauncherApi = typeof launcher;
