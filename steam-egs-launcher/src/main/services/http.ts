// One HTTP helper for every plain-fetch call in the main process, so timeouts
// and user agents are consistent (a missing timeout used to be able to wedge a
// sync until the app restarted).

const DEFAULT_TIMEOUT_MS = 15_000;

/** Chrome-ish UA — Steam's storefront endpoints reject unknown clients. */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

export interface HttpOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

/** GET/POST with a hard timeout; throws on a non-2xx response. */
export async function httpFetch(url: string, opts: HttpOptions = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: opts.method,
      body: opts.body,
      headers: opts.headers,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Request failed: HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Same, parsed as JSON. */
export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await httpFetch(url, opts);
  return (await res.json()) as T;
}
