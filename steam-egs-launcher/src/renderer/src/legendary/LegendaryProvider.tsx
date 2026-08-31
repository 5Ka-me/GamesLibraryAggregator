import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  LibraryActions,
  LibraryActionsProvider,
  GameInstallState,
} from '@app/shared';
import type { DownloadProgress } from '../../../preload';

// Renderer-side EGS download store. Tracks installed games and live progress,
// and exposes a shared LibraryActions (consumed by GameCard and the game page)
// plus the launcher-local availability flag used by Settings.

interface LegendaryContextValue {
  actions: LibraryActions;
  available: boolean;
  /** Last failed download, so a failure isn't silently swallowed. */
  lastError: { title: string; error: string } | null;
  dismissError: () => void;
}

const LegendaryContext = createContext<LegendaryContextValue | null>(null);

export const LegendaryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [steamInstalled, setSteamInstalled] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [available, setAvailable] = useState(false);
  const [lastError, setLastError] = useState<{ title: string; error: string } | null>(null);

  const refreshInstalled = useCallback(async () => {
    const list = await window.launcher.legendaryListInstalled().catch(() => []);
    setInstalled(new Set(list.map((g) => g.app_name)));
  }, []);

  const refreshSteam = useCallback(async () => {
    const ids = await window.launcher.steamListInstalled().catch(() => []);
    setSteamInstalled(new Set(ids));
  }, []);

  useEffect(() => {
    window.launcher.legendaryAvailable().then(setAvailable).catch(() => setAvailable(false));
    refreshInstalled();
    refreshSteam();

    const off = window.launcher.onDownloadProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.appName]: p }));
      if (p.status === 'done') refreshInstalled();
      // A failed install used to just revert the card to "Install" with no
      // explanation anywhere.
      if (p.status === 'error' && p.error) {
        setLastError({ title: p.title ?? p.appName, error: p.error });
      }
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
    window.launcher.legendaryInstall(appName, title).catch((e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      setProgress((prev) => ({
        ...prev,
        [appName]: { appName, title, pct: 0, status: 'error', error },
      }));
      setLastError({ title: title ?? appName, error });
    });
  }, []);

  const cancelEpic = useCallback((appName: string) => {
    void window.launcher.legendaryCancel(appName).catch(() => undefined);
  }, []);

  const launchEpic = useCallback((appName: string) => {
    void window.launcher.legendaryLaunch(appName).catch((e: unknown) => {
      setLastError({ title: appName, error: e instanceof Error ? e.message : String(e) });
    });
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

  const dismissError = useCallback(() => setLastError(null), []);

  const value = useMemo<LegendaryContextValue>(
    () => ({ actions, available, lastError, dismissError }),
    [actions, available, lastError, dismissError]
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
