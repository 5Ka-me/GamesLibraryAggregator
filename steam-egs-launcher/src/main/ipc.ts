import { app, ipcMain, shell } from 'electron';
import { apiFetch, ApiRequestInit } from './services/apiClient';
import { getBridgeEnabled, setBridgeEnabled, getInstallBasePath, setInstallBasePath } from './config';
import { bridgeStatus, revokeBridgeOrigin, startBridge, stopBridge } from './services/bridge';
import { openDeepLink, openSteamStorePage } from './services/steamLauncher';
import * as legendary from './services/legendary';
import { login as epicLogin } from './services/epicAuth';
import { epicStoreDetails } from './services/epicStore';
import { usdRate } from './services/fxRates';
import { steamLogin, steamStatus, steamLogout } from './services/steamAuth';
import {
  personalSections,
  generateDiscoveryQueue,
  addToWishlist,
  removeFromWishlist,
} from './services/steamPersonal';
import { scanInstalledSteamAppIds } from './services/steamScan';
import { appVersion, checkForUpdates, installUpdate, updateState } from './services/updater';
import { isWebUrl, requireAppId, requireEpicAppName } from './services/validate';
import {
  storeHome,
  storeSearch,
  storeSection,
  wishlistEntries,
  itemsMeta,
  appDetails,
  findSteamAppId,
} from './services/steamStore';

// IPC surface exposed to the renderer through the preload bridge. Arguments
// arrive as plain values — TypeScript types are erased at runtime — so
// anything that reaches a shell command, an authenticated Steam request or the
// OS shell is validated here (see services/validate.ts).

/** Registers all IPC handlers. Called once after the app is ready. */
export function registerIpc(): void {
  // Local API (library, accounts, syncs) — same /api/* contract the backend
  // used to serve, now implemented in-process.
  ipcMain.handle('api:fetch', (_e, path: string, init?: ApiRequestInit) => apiFetch(path, init));

  // Opening links. Only http(s) reaches the OS browser: shell.openExternal
  // would otherwise happily launch file://, UNC paths or protocol handlers,
  // and store payloads (spotlight banners, EGS slugs) are remote data.
  ipcMain.handle('external:open', (_e, url: string) => {
    if (!isWebUrl(url)) throw new Error(`Refusing to open a non-web URL: ${String(url)}`);
    return shell.openExternal(url);
  });
  ipcMain.handle('deeplink:open', (_e, url: string) => openDeepLink(url));

  // Quit the app (sidebar close button).
  ipcMain.handle('app:quit', () => app.quit());

  // Auto-update (GitHub Releases; no-ops in dev).
  ipcMain.handle('app:version', () => appVersion());
  ipcMain.handle('update:state', () => updateState());
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('update:install', () => installUpdate());

  // EGS install folder (legendary --base-path).
  ipcMain.handle('config:getInstallPath', () => getInstallBasePath());
  ipcMain.handle('config:setInstallPath', (_e, path: string) => setInstallBasePath(path));

  // Local web bridge (Settings panel).
  ipcMain.handle('bridge:status', () => bridgeStatus(getBridgeEnabled()));
  ipcMain.handle('bridge:setEnabled', async (_e, enabled: boolean) => {
    const on = !!enabled;
    setBridgeEnabled(on);
    if (on) await startBridge();
    else await stopBridge();
    return bridgeStatus(on);
  });
  ipcMain.handle('bridge:revoke', (_e, origin: string) => {
    revokeBridgeOrigin(String(origin));
    return bridgeStatus(getBridgeEnabled());
  });

  // Steam install-state (read from Steam's appmanifest files).
  ipcMain.handle('steam:listInstalled', () => scanInstalledSteamAppIds());

  // Steam storefront (in-app Store page).
  ipcMain.handle('store:home', (_e, lang: string, force?: boolean) => storeHome(lang, !!force));
  ipcMain.handle('store:search', (_e, term: string, lang: string) => storeSearch(term, lang));
  ipcMain.handle('store:wishlist', (_e, steamId: string, force?: boolean) =>
    wishlistEntries(steamId, !!force)
  );
  ipcMain.handle('store:itemsMeta', (_e, appids: number[], lang: string) =>
    itemsMeta((appids ?? []).map(requireAppId), lang)
  );
  ipcMain.handle(
    'store:section',
    (_e, id: string, lang: string, start: number, count: number, sort?: string) =>
      storeSection(id, lang, start, count, (sort as never) ?? 'default')
  );
  ipcMain.handle('store:appDetails', (_e, appid: number, lang: string) =>
    appDetails(requireAppId(appid), lang)
  );
  ipcMain.handle('store:personal', (_e, lang: string, force?: boolean) =>
    personalSections(lang, !!force)
  );
  ipcMain.handle('steam:discoveryQueue', (_e, lang: string) => generateDiscoveryQueue(lang));
  ipcMain.handle('steam:addToWishlist', (_e, appid: number) => addToWishlist(requireAppId(appid)));
  ipcMain.handle('steam:removeFromWishlist', (_e, appid: number) =>
    removeFromWishlist(requireAppId(appid))
  );
  ipcMain.handle('store:findApp', (_e, title: string, lang: string) => findSteamAppId(title, lang));
  ipcMain.handle('epic:storeDetails', (_e, title: string, ns: string | null, lang: string) =>
    epicStoreDetails(title, ns, lang)
  );
  ipcMain.handle('store:openPage', (_e, appid: number) => openSteamStorePage(requireAppId(appid)));

  // Daily USD exchange rate (approximate cross-currency price comparison).
  ipcMain.handle('fx:usdRate', (_e, currency: string) => usdRate(currency));

  // Steam web sign-in (no API key; token stays in main memory).
  ipcMain.handle('steam:login', (_e, remember: boolean) => steamLogin(!!remember));
  ipcMain.handle('steam:status', () => steamStatus());
  ipcMain.handle('steam:logout', () => steamLogout());

  // EGS embedded OAuth (authenticates legendary + syncs the library).
  ipcMain.handle('epic:login', () => epicLogin());

  // legendary (EGS download management). appName goes to a spawned CLI as an
  // argument — validated so it can't be read as a flag.
  ipcMain.handle('legendary:available', () => legendary.isLegendaryAvailable());
  ipcMain.handle('legendary:listInstalled', () => legendary.listInstalled());
  ipcMain.handle('legendary:install', (_e, appName: string, title?: string) =>
    legendary.install(requireEpicAppName(appName), title)
  );
  ipcMain.handle('legendary:cancel', (_e, appName: string) =>
    legendary.cancelInstall(requireEpicAppName(appName))
  );
  ipcMain.handle('legendary:uninstall', (_e, appName: string) =>
    legendary.uninstall(requireEpicAppName(appName))
  );
  ipcMain.handle('legendary:launch', (_e, appName: string) =>
    legendary.launch(requireEpicAppName(appName))
  );
}
