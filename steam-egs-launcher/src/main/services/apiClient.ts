import { getApiBase } from '../config';
import { clearToken, getToken, setToken } from './secretStore';

// Proxies renderer API calls to the .NET backend from the main process. This
// sidesteps CORS (the backend only allows the web origin) and keeps the
// workspace token in the OS keystore rather than in the renderer.

export interface ApiRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** Network-level failures get an actionable message instead of "fetch failed". */
function unreachable(base: string): Error {
  return new Error(
    `Backend API is unreachable at ${base}. Make sure the .NET API is running ` +
      `and the "Backend URL" in Settings points to it.`
  );
}

async function ensureToken(): Promise<string> {
  const existing = getToken();
  if (existing) return existing;

  const base = getApiBase();
  let res: Response;
  try {
    res = await fetch(`${base}/api/workspace`, { method: 'POST' });
  } catch {
    throw unreachable(base);
  }
  if (!res.ok) throw new Error(`workspace create failed: ${res.status}`);
  const data = (await res.json()) as { token: string };
  setToken(data.token);
  return data.token;
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = await res.text();
    try {
      detail = JSON.parse(detail).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(detail || `${res.status}`);
  }
  return (await res.json()) as T;
}

export async function apiFetch<T = unknown>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const run = async (retry: boolean): Promise<T> => {
    const token = await ensureToken();
    const headers = new Headers(init.headers);
    headers.set('X-Workspace-Token', token);

    const base = getApiBase();
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: init.method,
        body: init.body,
        headers,
      });
    } catch {
      throw unreachable(base);
    }
    if (res.status === 401 && retry) {
      clearToken();
      return run(false);
    }
    return parse<T>(res);
  };
  return run(true);
}
