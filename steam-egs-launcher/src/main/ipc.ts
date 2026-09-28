import { app, ipcMain, shell } from 'electron';
import { apiFetch, ApiRequestInit } from './services/apiClient';
import { getBridgeEnabled, setBridgeEnabled, getInstallBasePath, setInstallBasePath } from './config';
import { bridgeStatus, revokeBridgeOrigin, startBridge, stopBridge } from './services/bridge';
import { openDeepLink, openSteamStorePage, openWebUrl } from './services/steamLauncher';
import { inventoryApp, inventoryCardSets, inventoryOverview, inventoryPrice, inventoryPrices } from './services/inventory';
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
import { aiListModels, aiStatus } from './services/aiClient';
import { CONTEXT_LIMIT, assistantChat, gameVerdict, type ChatTurn, type ContextGame } from './services/assistant';
import { cancelEnrichment, clearProfiles, enrichStatus, getProfiles, startEnrichment } from './services/enrichment';
import {
  createCollection,
  deleteCollection,
  importSteamCollections,
  listCollections,
  membershipOf,
  previewRule,
  reorderCollections,
  resetToSteam,
  resolveCollections,
  setMembership,
  updateCollection,
  type GameHandle,
} from './services/collections';
import { clearChutesApiKey, setChutesApiKey } from './services/secretStore';
import { setAiModel } from './config';
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
  // Web links: Steam pages open in the Steam client and Epic store pages in the
  // Epic Games Launcher when those are installed, everything else in the browser.
  ipcMain.handle('external:open', (_e, url: string) => {
    if (!isWebUrl(url)) throw new Error(`Refusing to open a non-web URL: ${String(url)}`);
    return openWebUrl(url);
  });

  // Steam inventory — read-only.
  const uiLang = (v: unknown): string => (v === 'ru' ? 'ru' : 'en');
  ipcMain.handle('inventory:overview', (_e, lang: unknown, force: unknown) => inventoryOverview(uiLang(lang), force === true));
  ipcMain.handle('inventory:app', (_e, appid: unknown, lang: unknown) => inventoryApp(requireAppId(appid), uiLang(lang)));
  ipcMain.handle('inventory:price', (_e, appid: unknown, hashName: unknown, force: unknown) => {
    if (typeof hashName !== 'string' || !hashName.trim() || hashName.length > 300) throw new Error('Invalid market item');
    return inventoryPrice(requireAppId(appid), hashName, force === true);
  });
  ipcMain.handle('inventory:prices', () => inventoryPrices());
  ipcMain.handle('inventory:cardSets', (_e, lang: unknown) => inventoryCardSets(uiLang(lang)));
  ipcMain.handle('deeplink:open', (_e, url: string) => openDeepLink(url));

  // Quit the app (sidebar close button).
  ipcMain.handle('app:quit', () => app.quit());

  // Auto-update (GitHub Releases; no-ops in dev).
  ipcMain.handle('app:version', () => appVersion());

  // ----- AI search (chutes.ai) -----
  ipcMain.handle('ai:status', () => aiStatus());
  ipcMain.handle('ai:setKey', (_e, key: unknown) => {
    if (typeof key !== 'string' || !/^\S{8,300}$/.test(key.trim())) throw new Error('Invalid API key.');
    setChutesApiKey(key);
    return aiStatus();
  });
  ipcMain.handle('ai:clearKey', () => {
    clearChutesApiKey();
    return aiStatus();
  });
  ipcMain.handle('ai:setModel', (_e, model: unknown) => {
    if (typeof model !== 'string' || !/^[\w./:@+-]{0,160}$/.test(model.trim())) throw new Error('Invalid model id.');
    setAiModel(model);
    return aiStatus();
  });
  ipcMain.handle('ai:models', () => aiListModels());

  // ----- library enrichment (AI game profiles) -----
  ipcMain.handle('enrich:status', (_e, lang: unknown) => enrichStatus(lang === 'ru' ? 'ru' : 'en'));
  ipcMain.handle('enrich:get', () => getProfiles());
  ipcMain.handle('enrich:start', (_e, lang: unknown, redo: unknown) => startEnrichment(lang === 'ru' ? 'ru' : 'en', redo === true));
  ipcMain.handle('enrich:cancel', () => cancelEnrichment());
  ipcMain.handle('enrich:clear', (_e, lang: unknown) => {
    clearProfiles();
    return enrichStatus(lang === 'ru' ? 'ru' : 'en');
  });

  // ----- collections -----
  const requireId = (v: unknown): string => {
    if (typeof v !== 'string' || !/^[\w-]{1,40}$/.test(v)) throw new Error('Invalid collection id');
    return v;
  };
  const requireHandle = (v: unknown): GameHandle => {
    const h = v as Partial<GameHandle> | null;
    if (!h || typeof h !== 'object' || typeof h.title !== 'string' || !Array.isArray(h.refs)) throw new Error('Invalid game handle');
    return { title: h.title.slice(0, 300), refs: h.refs.slice(0, 8) };
  };
  ipcMain.handle('collections:list', () => listCollections());
  ipcMain.handle('collections:resolve', () => resolveCollections());
  ipcMain.handle('collections:preview', (_e, rule: unknown) => previewRule(rule && typeof rule === 'object' ? (rule as object) : {}));
  ipcMain.handle('collections:create', (_e, input: unknown) => {
    const i = (input && typeof input === 'object' ? input : {}) as { name?: unknown; kind?: unknown; rule?: unknown };
    return createCollection({ name: i.name, kind: i.kind, rule: i.rule });
  });
  ipcMain.handle('collections:update', (_e, id: unknown, patch: unknown) => updateCollection(requireId(id), (patch && typeof patch === 'object' ? patch : {}) as object));
  ipcMain.handle('collections:delete', (_e, id: unknown) => deleteCollection(requireId(id)));
  ipcMain.handle('collections:reorder', (_e, ids: unknown) => reorderCollections(ids));
  ipcMain.handle('collections:setMembership', (_e, id: unknown, handle: unknown, member: unknown) => setMembership(requireId(id), requireHandle(handle), member === true));
  ipcMain.handle('collections:membership', (_e, handle: unknown) => membershipOf(requireHandle(handle)));
  ipcMain.handle('collections:importSteam', () => importSteamCollections());
  ipcMain.handle('collections:resetSteam', (_e, id: unknown) => resetToSteam(requireId(id)));
  ipcMain.handle('ai:chat', (_e, history: unknown, lang: unknown, context: unknown) => {
    const ctx: ContextGame[] = Array.isArray(context)
      ? context.slice(0, CONTEXT_LIMIT).map((g: unknown) => {
          const x = g as { title?: unknown; origin?: unknown; appid?: unknown };
          if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 200) throw new Error('Invalid context game');
          if (x.origin !== 'library' && x.origin !== 'wishlist' && x.origin !== 'store') throw new Error('Invalid context origin');
          return { title: x.title.trim(), origin: x.origin, appid: typeof x.appid === 'number' && Number.isInteger(x.appid) && x.appid > 0 ? x.appid : null };
        })
      : [];
    if (!Array.isArray(history) || history.length === 0 || history.length > 60) throw new Error('Invalid chat history');
    const turns: ChatTurn[] = history.map((t: unknown) => {
      const x = t as { role?: unknown; content?: unknown };
      if ((x.role !== 'user' && x.role !== 'assistant') || typeof x.content !== 'string' || x.content.length > 4000) throw new Error('Invalid chat turn');
      return { role: x.role, content: x.content };
    });
    return assistantChat(turns, lang === 'ru' ? 'ru' : 'en', ctx);
  });
  ipcMain.handle('ai:verdict', (_e, appid: unknown, lang: unknown, force: unknown) => gameVerdict(requireAppId(appid), lang === 'ru' ? 'ru' : 'en', force === true));
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
