// Platform hooks let shared UI components perform host-specific actions.
//
// - Web: opening a URL uses window.open; store/deep links are plain anchors.
// - Launcher (Electron): opening a URL and OS deep links (steam:// ,
//   com.epicgames.launcher://) are routed to the main process via IPC so the OS
//   protocol handler fires and http links open in the user's real browser.

import type { Game } from './api/client';

type OpenFn = (url: string) => void;

const defaultOpenExternal: OpenFn = (url) => {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
};

let _openExternal: OpenFn = defaultOpenExternal;
let _openDeepLink: OpenFn | null = null;
let _openGameDetails: ((game: Game) => void) | null = null;

export function configurePlatform(opts: {
  openExternal?: OpenFn;
  /** Pass a function to enable native deep-link handling; pass null to disable. */
  openDeepLink?: OpenFn | null;
  /**
   * When set (the launcher), clicking a library card opens the in-app game
   * details page instead of a store page, and cards render compact actions
   * (Play only — install/uninstall live on the details page).
   */
  openGameDetails?: ((game: Game) => void) | null;
}): void {
  if (opts.openExternal) _openExternal = opts.openExternal;
  if (opts.openDeepLink !== undefined) _openDeepLink = opts.openDeepLink;
  if (opts.openGameDetails !== undefined) _openGameDetails = opts.openGameDetails;
}

/** The in-app game-details navigator, or null on hosts without one (the web). */
export function getOpenGameDetails(): ((game: Game) => void) | null {
  return _openGameDetails;
}

/** Open an http(s) URL (store page, external site). */
export function openExternal(url: string): void {
  _openExternal(url);
}

/** True when a native deep-link handler is configured (i.e. running in the launcher). */
export function hasDeepLinkHandler(): boolean {
  return _openDeepLink != null;
}

/** Open an OS protocol deep link (falls back to openExternal on the web). */
export function openDeepLink(url: string): void {
  (_openDeepLink ?? _openExternal)(url);
}
