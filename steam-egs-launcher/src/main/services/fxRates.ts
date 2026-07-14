// Daily USD exchange rates for the approximate cross-currency price
// comparison (Steam UAH vs EGS KZT etc.). Source: open.er-api.com — free, no
// key, 160+ currencies, updated daily. Cached for 24 h; on failure the rate is
// null and the UI simply hides the comparison.

let cache: { at: number; rates: Record<string, number> } | null = null;
const TTL_MS = 24 * 60 * 60 * 1000;

/** Units of `currency` per 1 USD, or null when unknown/unavailable. */
export async function usdRate(currency: string): Promise<number | null> {
  const cur = currency.trim().toUpperCase();
  if (!cur) return null;
  if (cur === 'USD') return 1;

  if (!cache || Date.now() - cache.at > TTL_MS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctrl.signal });
        if (res.ok) {
          const json = (await res.json()) as { result?: string; rates?: Record<string, number> };
          if (json?.result === 'success' && json.rates) {
            cache = { at: Date.now(), rates: json.rates };
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* keep stale cache if present */
    }
  }

  const rate = cache?.rates?.[cur];
  return typeof rate === 'number' && rate > 0 ? rate : null;
}
