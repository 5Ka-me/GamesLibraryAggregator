// Daily USD exchange rates for the approximate cross-currency price
// comparison (Steam UAH vs EGS KZT etc.). Source: open.er-api.com — free, no
// key, 160+ currencies, updated daily. Cached for 24 h (memory + disk via the
// unified cache; stale rates keep serving while a refresh runs in the
// background). On failure the rate is null and the UI hides the comparison.

import { cached, TTL_STATIC_MS } from './cache';

async function fetchRates(): Promise<Record<string, number>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctrl.signal });
    if (!res.ok) throw new Error(`FX request failed: HTTP ${res.status}`);
    const json = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (json?.result !== 'success' || !json.rates) throw new Error('FX response malformed');
    return json.rates;
  } finally {
    clearTimeout(timer);
  }
}

/** Units of `currency` per 1 USD, or null when unknown/unavailable. */
export async function usdRate(currency: string): Promise<number | null> {
  const cur = currency.trim().toUpperCase();
  if (!cur) return null;
  if (cur === 'USD') return 1;

  let rates: Record<string, number>;
  try {
    rates = await cached('fx', 'usd', TTL_STATIC_MS, fetchRates);
  } catch {
    return null; // no cache and no network — the UI hides the comparison
  }
  const rate = rates[cur];
  return typeof rate === 'number' && rate > 0 ? rate : null;
}
