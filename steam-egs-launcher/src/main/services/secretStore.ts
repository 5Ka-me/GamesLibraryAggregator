import { app, safeStorage } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';

// Secrets — the Epic OAuth session, the optional Steam API key and the local
// bridge's pairing tokens — encrypted at rest via Electron safeStorage (DPAPI
// on Windows).
//
// The file starts with a one-byte format marker so an encrypted blob is never
// mistaken for plaintext (or vice versa) after safeStorage availability
// changes: without it, a single unreadable read would silently return "no
// secrets" and the next write would overwrite them for good. Writes are atomic
// (temp file + rename) for the same reason.

const MARKER_ENCRYPTED = 0x01;
const MARKER_PLAIN = 0x00;

const secretsFile = (): string => join(app.getPath('userData'), 'secrets.bin');

/** Epic OAuth session (tokens at rest only inside the encrypted blob). */
export interface EpicSessionSecret {
  accountId: string;
  displayName?: string | null;
  accessToken: string;
  refreshToken: string;
  /** ISO timestamps. */
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

interface Secrets {
  steamApiKey?: string;
  epicSession?: EpicSessionSecret;
  /** Local-bridge pairing tokens, keyed by web origin. */
  bridgePairings?: Record<string, string>;
}

/** Thrown instead of silently returning {} when secrets exist but are unreadable. */
export class SecretsUnreadableError extends Error {
  constructor(cause: unknown) {
    super(
      'The stored secrets could not be decrypted. Sign in to Steam/Epic again to recreate them. ' +
        `(${cause instanceof Error ? cause.message : String(cause)})`
    );
    this.name = 'SecretsUnreadableError';
  }
}

let cache: Secrets | null = null;

function readSecrets(): Secrets {
  if (cache) return cache;
  if (!existsSync(secretsFile())) {
    cache = {};
    return cache;
  }
  const raw = readFileSync(secretsFile());
  try {
    let json: string;
    if (raw[0] === MARKER_ENCRYPTED) {
      json = safeStorage.decryptString(raw.subarray(1));
    } else if (raw[0] === MARKER_PLAIN) {
      json = raw.subarray(1).toString('utf8');
    } else {
      // Pre-marker file: encrypted iff safeStorage can read it.
      json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf8');
    }
    cache = JSON.parse(json) as Secrets;
    return cache;
  } catch (e) {
    // Don't cache and don't pretend the store is empty — an empty result would
    // be written back over the real secrets on the next save.
    throw new SecretsUnreadableError(e);
  }
}

function writeSecrets(secrets: Secrets): void {
  const json = JSON.stringify(secrets);
  const encrypt = safeStorage.isEncryptionAvailable();
  const payload = encrypt ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
  if (!encrypt) {
    console.warn('[secrets] OS encryption unavailable — secrets are stored unencrypted.');
  }
  const data = Buffer.concat([Buffer.from([encrypt ? MARKER_ENCRYPTED : MARKER_PLAIN]), payload]);

  const file = secretsFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
  cache = secrets;
}

/** Read-modify-write of the single secrets blob. */
function update(mutate: (secrets: Secrets) => void): void {
  const secrets = { ...readSecrets() };
  mutate(secrets);
  writeSecrets(secrets);
}

// ---------- Steam API key (Advanced fallback path) ----------

export function getSteamApiKey(): string | null {
  return readSecrets().steamApiKey ?? null;
}

export function setSteamApiKey(key: string): void {
  update((s) => {
    s.steamApiKey = key.trim();
  });
}

export function clearSteamApiKey(): void {
  update((s) => {
    delete s.steamApiKey;
  });
}

// ---------- Epic session ----------

export function getEpicSession(): EpicSessionSecret | null {
  return readSecrets().epicSession ?? null;
}

export function setEpicSession(session: EpicSessionSecret): void {
  update((s) => {
    s.epicSession = session;
  });
}

export function clearEpicSession(): void {
  update((s) => {
    delete s.epicSession;
  });
}

// ---------- local-bridge pairings (origin → token) ----------

export function getBridgePairings(): Record<string, string> {
  return { ...(readSecrets().bridgePairings ?? {}) };
}

export function setBridgePairing(origin: string, token: string): void {
  update((s) => {
    s.bridgePairings = { ...s.bridgePairings, [origin]: token };
  });
}

export function removeBridgePairing(origin: string): void {
  update((s) => {
    if (s.bridgePairings) {
      const next = { ...s.bridgePairings };
      delete next[origin];
      s.bridgePairings = next;
    }
  });
}
