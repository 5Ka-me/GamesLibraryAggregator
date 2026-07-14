import { BrowserWindow } from 'electron';

// Small indirection so background services (e.g. legendary download progress)
// can push events to the renderer without holding a window reference themselves.

let target: BrowserWindow | null = null;

export function setEventTarget(win: BrowserWindow): void {
  target = win;
}

export function emit(channel: string, payload: unknown): void {
  if (target && !target.isDestroyed()) {
    target.webContents.send(channel, payload);
  }
}
