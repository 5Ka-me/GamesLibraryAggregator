import { app, safeStorage } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

// Secrets (currently the workspace token; EGS/Steam tokens land here in later
// milestones) are stored encrypted at rest via Electron safeStorage, which is
// backed by the OS keystore (DPAPI on Windows). If encryption is unavailable
// (rare), we fall back to plain JSON so the app still works.

const secretsFile = (): string => join(app.getPath('userData'), 'secrets.bin');

interface Secrets {
  workspaceToken?: string;
}

function readSecrets(): Secrets {
  try {
    if (!existsSync(secretsFile())) return {};
    const raw = readFileSync(secretsFile());
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    return JSON.parse(json) as Secrets;
  } catch {
    return {};
  }
}

function writeSecrets(secrets: Secrets): void {
  const json = JSON.stringify(secrets);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8');
  writeFileSync(secretsFile(), data);
}

export function getToken(): string | null {
  return readSecrets().workspaceToken ?? null;
}

export function setToken(token: string): void {
  const secrets = readSecrets();
  secrets.workspaceToken = token.trim();
  writeSecrets(secrets);
}

export function clearToken(): void {
  const secrets = readSecrets();
  delete secrets.workspaceToken;
  writeSecrets(secrets);
}
