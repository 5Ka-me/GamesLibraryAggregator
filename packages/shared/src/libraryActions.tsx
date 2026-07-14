import React, { createContext, useContext } from 'react';

// Optional "local library manager" injected by the host (the Electron launcher).
// When present, shared UI (GameCard) renders real install/launch/uninstall
// controls for EGS games. On the web it is absent, so cards fall back to
// deep links / store pages.

export interface GameInstallState {
  installed: boolean;
  installing: boolean;
  /** 0–100 while installing. */
  progressPct?: number;
}

export interface LibraryActions {
  getEpicState(appName: string): GameInstallState;
  installEpic(appName: string, title?: string): void;
  uninstallEpic(appName: string): void;
  launchEpic(appName: string): void;
  cancelEpic(appName: string): void;

  /**
   * Install-state of a Steam game by appid. Steam launch/install stay as native
   * deep links (we don't manage Steam downloads), so this is informational —
   * it lets the card show Play vs Install. `installing` is always false.
   */
  getSteamState(appId: string): GameInstallState;
}

const LibraryActionsContext = createContext<LibraryActions | null>(null);

export const LibraryActionsProvider: React.FC<{
  value: LibraryActions;
  children: React.ReactNode;
}> = ({ value, children }) => (
  <LibraryActionsContext.Provider value={value}>{children}</LibraryActionsContext.Provider>
);

/** Returns the injected manager, or null on hosts without one (the web). */
export function useLibraryActions(): LibraryActions | null {
  return useContext(LibraryActionsContext);
}
