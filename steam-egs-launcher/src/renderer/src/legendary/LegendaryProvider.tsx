import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  LibraryActions,
  LibraryActionsProvider,
  GameInstallState,
} from '@app/shared';
import type { DownloadProgress } from '../../../preload';

// Renderer-side EGS download store. Tracks installed games and live progress,
// exposes a shared LibraryActions (consumed by GameCard) plus a launcher-local
// context (consumed by the Downloads page).

interface LegendaryContextValue {
  actions: LibraryActions;
  downloads: DownloadProgress[];
  available: boolean;
}

const LegendaryContext = createContext<LegendaryContextValue | null>(null);

export const LegendaryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [steamInstalled, setSteamInstalled] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [available, setAvailable] = useState(false);

  const refreshInstalled = useCallback(async () => {
    const list = await window.launcher.legendaryListInstalled().catch(() => []);
    setInstalled(new Set(list.map((g) => g.app_name)));
  }, []);

  const refreshSteam = useCallback(async () => {
    const ids = await window.launcher.steamListInstalled().catch(() => []);
    setSteamInstalled(new Set(ids));
  }, []);

  useEffect(() => {
    window.launcher.legendaryAvailable().then(setAvailable);
    refreshInstalled();
    refreshSteam();

    const off = window.launcher.onDownloadProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.appName]: p }));
      if (p.status === 'done') refreshInstalled();
    });

    // Re-scan install state when the user returns to the launcher (they may
    // have installed/removed a game in Steam/EGL in the meantime).
    const onFocus = () => {
      refreshInstalled();
      refreshSteam();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      off();
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshInstalled, refreshSteam]);

  const installEpic = useCallback((appName: string, title?: string) => {
    setProgress((prev) => ({ ...prev, [appName]: { appName, title, pct: 0, status: 'running' } }));
    window.launcher.legendaryInstall(appName, title).catch((e) => {
      setProgress((prev) => ({
        ...prev,
        [appName]: { appName, title, pct: 0, status: 'error', error: String(e) },
      }));
    });
  }, []);

  const cancelEpic = useCallback((appName: string) => {
    window.launcher.legendaryCancel(appName);
  }, []);

  const launchEpic = useCallback((appName: string) => {
    window.launcher.legendaryLaunch(appName);
  }, []);

  const uninstallEpic = useCallback(
    async (appName: string) => {
      await window.launcher.legendaryUninstall(appName).catch(() => undefined);
      await refreshInstalled();
    },
    [refreshInstalled]
  );

  const getEpicState = useCallback(
    (appName: string): GameInstallState => {
      const p = progress[appName];
      return {
        installed: installed.has(appName),
        installing: p?.status === 'running',
        progressPct: p?.pct,
      };
    },
    [installed, progress]
  );

  const getSteamState = useCallback(
    (appId: string): GameInstallState => ({
      installed: steamInstalled.has(appId),
      installing: false,
    }),
    [steamInstalled]
  );

  const actions: LibraryActions = useMemo(
    () => ({ getEpicState, installEpic, uninstallEpic, launchEpic, cancelEpic, getSteamState }),
    [getEpicState, installEpic, uninstallEpic, launchEpic, cancelEpic, getSteamState]
  );

  const downloads = useMemo(() => Object.values(progress), [progress]);

  const value = useMemo<LegendaryContextValue>(
    () => ({ actions, downloads, available }),
    [actions, downloads, available]
  );

  return (
    <LegendaryContext.Provider value={value}>
      <LibraryActionsProvider value={actions}>{children}</LibraryActionsProvider>
    </LegendaryContext.Provider>
  );
};

export function useLegendary(): LegendaryContextValue {
  const ctx = useContext(LegendaryContext);
  if (!ctx) throw new Error('useLegendary must be used within LegendaryProvider');
  return ctx;
}
