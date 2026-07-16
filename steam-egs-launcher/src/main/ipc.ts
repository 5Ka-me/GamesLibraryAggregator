import { app, ipcMain, shell } from 'electron';
import { apiFetch, ApiRequestInit } from './services/apiClient';
import { clearToken, getToken, setToken } from './services/secretStore';
import {
  getApiBase,
  setApiBase,
  getInstallBasePath,
  setInstallBasePath,
} from './config';
import { openDeepLink, openSteamStorePage } from './services/steamLauncher';
import * as legendary from './services/legendary';
import { login as epicLogin } from './services/epicAuth';
import { epicStoreDetails } from './services/epicStore';
import { usdRate } from './services/fxRates';
import { steamLogin, steamStatus, steamLogout } from './services/steamAuth';
import { personalSections } from './services/steamPersonal';
import { scanInstalledSteamAppIds } from './services/steamScan';
import {
  storeHome,
  storeSearch,
  storeSection,
  wishlistEntries,
  itemsMeta,
  appDetails,
  findSteamAppId,
} from './services/steamStore';

/** Registers all IPC handlers. Called once after the app is ready. */
export function registerIpc(): void {
  // Backend API proxy (main process owns the token; no CORS).
  ipcMain.handle('api:fetch', (_e, path: string, init?: ApiRequestInit) => apiFetch(path, init));

  // Opening links.
  ipcMain.handle('external:open', (_e, url: string) => shell.openExternal(url));
  ipcMain.handle('deeplink:open', (_e, url: string) => openDeepLink(url));

  // Quit the app (sidebar close button).
  ipcMain.handle('app:quit', () => app.quit());

  // Workspace token (OS keystore).
  ipcMain.handle('workspace:getToken', () => getToken());
  ipcMain.handle('workspace:setToken', (_e, token: string) => setToken(token));
  ipcMain.handle('workspace:clearToken', () => clearToken());

  // API base URL config.
  ipcMain.handle('config:getApiBase', () => getApiBase());
  ipcMain.handle('config:setApiBase', (_e, url: string) => setApiBase(url));

  // EGS install folder (legendary --base-path).
  ipcMain.handle('config:getInstallPath', () => getInstallBasePath());
  ipcMain.handle('config:setInstallPath', (_e, path: string) => setInstallBasePath(path));

  // Steam install-state (read from Steam's appmanifest files).
  ipcMain.handle('steam:listInstalled', () => scanInstalledSteamAppIds());

  // Steam storefront (in-app Store page).
  ipcMain.handle('store:home', (_e, lang: string, force?: boolean) => storeHome(lang, !!force));
  ipcMain.handle('store:search', (_e, term: string, lang: string) => storeSearch(term, lang));
  ipcMain.handle('store:wishlist', (_e, steamId: string, force?: boolean) =>
    wishlistEntries(steamId, !!force)
  );
  ipcMain.handle('store:itemsMeta', (_e, appids: number[], lang: string) =>
    itemsMeta(appids, lang)
  );
  ipcMain.handle(
    'store:section',
    (_e, id: string, lang: string, start: number, count: number, sort?: string) =>
      storeSection(id, lang, start, count, (sort as never) ?? 'default')
  );
  ipcMain.handle('store:appDetails', (_e, appid: number, lang: string) => appDetails(appid, lang));
  ipcMain.handle('store:personal', (_e, lang: string, force?: boolean) =>
    personalSections(lang, !!force)
  );
  ipcMain.handle('store:findApp', (_e, title: string, lang: string) => findSteamAppId(title, lang));
  ipcMain.handle('epic:storeDetails', (_e, title: string, ns: string | null, lang: string) =>
    epicStoreDetails(title, ns, lang)
  );
  ipcMain.handle('store:openPage', (_e, appid: number) => openSteamStorePage(appid));

  // Daily USD exchange rate (approximate cross-currency price comparison).
  ipcMain.handle('fx:usdRate', (_e, currency: string) => usdRate(currency));

  // Steam web sign-in (no API key; token stays in main memory).
  ipcMain.handle('steam:login', (_e, remember: boolean) => steamLogin(!!remember));
  ipcMain.handle('steam:status', () => steamStatus());
  ipcMain.handle('steam:logout', () => steamLogout());

  // EGS embedded OAuth (authenticates legendary + syncs the cloud library).
  ipcMain.handle('epic:login', () => epicLogin());

  // legendary (EGS download management).
  ipcMain.handle('legendary:available', () => legendary.isLegendaryAvailable());
  ipcMain.handle('legendary:listInstalled', () => legendary.listInstalled());
  ipcMain.handle('legendary:install', (_e, appName: string, title?: string) =>
    legendary.install(appName, title)
  );
  ipcMain.handle('legendary:cancel', (_e, appName: string) => legendary.cancelInstall(appName));
  ipcMain.handle('legendary:uninstall', (_e, appName: string) => legendary.uninstall(appName));
  ipcMain.handle('legendary:launch', (_e, appName: string) => legendary.launch(appName));
}
