import { GameEntry } from './api/client';

// The backend encodes the EGS deep link as
//   com.epicgames.launcher://apps/{namespace}%3A{catalogItemId}%3A{appName}?action=...
// legendary identifies games by that trailing `appName` (the artifact id), which
// we recover here without needing an extra backend field.
export function epicAppName(entry: GameEntry): string | null {
  if (entry.source !== 'Epic') return null;
  const url = entry.installUrl ?? entry.launchUrl;
  if (!url) return null;
  const match = url.match(/apps\/([^?]+)/);
  if (!match) return null;
  const parts = match[1].split('%3A');
  return parts[2] ? decodeURIComponent(parts[2]) : null;
}
