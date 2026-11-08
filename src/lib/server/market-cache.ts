import "server-only";
import type { Candle } from "../indicator";
import type { IndexSymbol } from "./config";
import { fetchMinuteCandles, MarketDataError } from "./yahoo";

export type Snapshot = { candles: Candle[]; fetchedAt: number; error?: MarketDataError };
type Entry = { snapshot?: Snapshot; pending?: Promise<Snapshot>; retryAfter: number; error?: MarketDataError };
const entries = new Map<IndexSymbol, Entry>();
const CACHE_MS = 60_000;
const MAX_FALLBACK_AGE = 24 * 60 * 60_000;

function fallback(entry: Entry, error: MarketDataError): Snapshot {
  if (entry.snapshot && Date.now() - entry.snapshot.fetchedAt <= MAX_FALLBACK_AGE) return { ...entry.snapshot, error };
  throw error;
}

/** Warm-instance cache/coalescing only; serverless instances do not share a lock. */
export function marketSnapshot(symbol: IndexSymbol): Promise<Snapshot> {
  const now = Date.now();
  let entry = entries.get(symbol);
  if (!entry) { entry = { retryAfter: 0 }; entries.set(symbol, entry); }
  if (entry.snapshot && now - entry.snapshot.fetchedAt < CACHE_MS) return Promise.resolve(entry.snapshot);
  if (entry.pending) return entry.pending;
  if (entry.retryAfter > now && entry.error) {
    try { return Promise.resolve(fallback(entry, entry.error)); } catch (error) { return Promise.reject(error); }
  }
  const current = entry;
  const request = Promise.resolve().then(async () => {
    try {
      const candles = await fetchMinuteCandles(symbol);
      const snapshot = { candles, fetchedAt: Date.now() };
      current.snapshot = snapshot; current.error = undefined; current.retryAfter = 0;
      return snapshot;
    } catch (error) {
      const failure = error instanceof MarketDataError ? error : new MarketDataError("UPSTREAM_ERROR", "Market data is unavailable. Monitoring will retry in 60 seconds.");
      current.error = failure;
      current.retryAfter = Date.now() + failure.retryAfterSeconds * 1000;
      return fallback(current, failure);
    } finally { current.pending = undefined; }
  });
  current.pending = request;
  return request;
}
