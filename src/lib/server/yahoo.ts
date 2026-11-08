import "server-only";
import { sessionBounds, type Candle } from "../indicator";
import { INSTRUMENTS, type IndexSymbol } from "./config";

export class MarketDataError extends Error {
  constructor(
    public code: "RATE_LIMITED" | "UPSTREAM_ERROR" | "INVALID_DATA" | "NO_DATA",
    message: string,
    public status = 502,
    public retryAfterSeconds = 60,
  ) { super(message); }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function invalid(message = "Yahoo returned inconsistent candle data. Monitoring will retry shortly."): never {
  throw new MarketDataError("INVALID_DATA", message);
}

/** Parse Yahoo's chart format; never turn nulls, gaps or quote-only rows into bars. */
export function parseYahooCandles(value: unknown, symbol: IndexSymbol, now = Date.now()): Candle[] {
  const chart = object(object(value)?.chart);
  if (!chart || chart.error != null) invalid("Yahoo could not provide candles for this index.");
  const result = Array.isArray(chart.result) && chart.result.length === 1 ? object(chart.result[0]) : null;
  const meta = object(result?.meta);
  if (!result || !meta || meta.symbol !== symbol || meta.dataGranularity !== "1m" || meta.exchangeTimezoneName !== "Asia/Kolkata") invalid();
  const quoteTime = meta.regularMarketTime;
  if (typeof quoteTime !== "number" || !Number.isFinite(quoteTime) || quoteTime <= 0) invalid();
  // A delayed current minute may be old in wall-clock time and still be forming.
  const watermark = Math.min(now, quoteTime * 1000);
  const timestamps = result.timestamp;
  const quotes = object(result.indicators)?.quote;
  const quote = Array.isArray(quotes) && quotes.length === 1 ? object(quotes[0]) : null;
  if (!Array.isArray(timestamps) || !quote) invalid();
  const fields = ["open", "high", "low", "close"] as const;
  if (fields.some((field) => !Array.isArray(quote[field]) || quote[field].length !== timestamps.length)) invalid();
  if (quote.volume !== undefined && (!Array.isArray(quote.volume) || quote.volume.length !== timestamps.length)) invalid();
  const rows = new Map<number, Candle>();
  for (let index = 0; index < timestamps.length; index++) {
    const epoch = timestamps[index];
    if (typeof epoch !== "number" || !Number.isFinite(epoch) || !Number.isInteger(epoch)) invalid();
    const time = epoch * 1000;
    const session = sessionBounds(time);
    // Yahoo appends a last quote at 15:30 or a non-minute timestamp, not an OHLC minute.
    if (time < session.open || time >= session.close || time + 60_000 > watermark) continue;
    if (time % 60_000 !== 0) invalid();
    const values = fields.map((field) => (quote[field] as unknown[])[index]);
    if (values.some((number) => number === null)) continue;
    if (values.some((number) => typeof number !== "number" || !Number.isFinite(number))) invalid();
    const [open, high, low, close] = values as number[];
    if (low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || high < low) invalid();
    const volume = (quote.volume as unknown[] | undefined)?.[index];
    if (volume != null && (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0)) invalid();
    const candle: Candle = { time, open, high, low, close, ...(typeof volume === "number" ? { volume } : {}) };
    const previous = rows.get(time);
    if (previous && JSON.stringify(previous) !== JSON.stringify(candle)) invalid("Yahoo returned conflicting duplicate candles.");
    rows.set(time, candle);
  }
  return [...rows.values()].sort((a, b) => a.time - b.time);
}

/** Unofficial, best-effort personal-use endpoint. No login, keys or paid fallback. */
export async function fetchMinuteCandles(symbol: IndexSymbol): Promise<Candle[]> {
  if (!Object.hasOwn(INSTRUMENTS, symbol)) invalid();
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.search = new URLSearchParams({ range: "5d", interval: "1m", includePrePost: "false" }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "C2FractalDashboard/1.0" },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MarketDataError("UPSTREAM_ERROR", "Yahoo is currently unreachable. Monitoring will retry in 60 seconds.");
  }
  if (response.status === 429) {
    const raw = response.headers.get("retry-after");
    const retry = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? Math.ceil((Date.parse(raw) - Date.now()) / 1000) : 60;
    throw new MarketDataError("RATE_LIMITED", "Yahoo has limited data requests. Waiting before retrying.", 429, Number.isFinite(retry) ? Math.min(86_400, Math.max(60, retry)) : 60);
  }
  if (!response.ok) throw new MarketDataError("UPSTREAM_ERROR", "Yahoo market data is temporarily unavailable. Monitoring will retry in 60 seconds.");
  let body: unknown;
  try { body = await response.json(); } catch { throw new MarketDataError("UPSTREAM_ERROR", "Yahoo returned an unreadable response. Monitoring will retry in 60 seconds."); }
  const candles = parseYahooCandles(body, symbol);
  if (!candles.length) throw new MarketDataError("NO_DATA", "Yahoo returned no complete minute candles. Waiting for available index data.");
  return candles;
}
