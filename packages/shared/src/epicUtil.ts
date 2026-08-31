import { GameEntry } from './api/client';

// EGS deep links are built as
//   com.epicgames.launcher://apps/{namespace}%3A{catalogItemId}%3A{appName}?action=...
// legendary identifies games by that trailing `appName` (the artifact id),
// which we recover here instead of carrying it as a separate field.
export function epicAppName(entry: GameEntry): string | null {
  if (entry.source !== 'Epic') return null;
  const url = entry.installUrl ?? entry.launchUrl;
  if (!url) return null;
  const match = url.match(/apps\/([^?]+)/);
  if (!match) return null;
  const parts = match[1].split('%3A');
  return parts[2] ? decodeURIComponent(parts[2]) : null;
}
