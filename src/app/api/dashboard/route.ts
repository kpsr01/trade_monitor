import { NextRequest, NextResponse } from "next/server";
import type { DashboardData } from "@/lib/contracts";
import { evaluateSimpleStrategy } from "@/lib/simple-strategy";
import { aggregateCandles, sessionBounds } from "@/lib/indicator";
import { ConfigurationError, publicConfig } from "@/lib/server/config";
import { MarketDataError } from "@/lib/server/yahoo";
import { marketSnapshot } from "@/lib/server/market-cache";
import { isDataStale, isMarketHours } from "@/lib/server/market-hours";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(_request: NextRequest) {
  const now = Date.now();
  let data: DashboardData = {
    connected: false, configured: false, instrument: { name: "NIFTY 50", symbol: "^NSEI", exchange: "NSE" },
    setups: [], charts: [], quote: null, fetchedAt: null, lastCandleAt: null, marketOpen: isMarketHours(now),
    provider: "yahoo", delayed: true, dataAsOf: null, dataAgeSeconds: null,
    stale: true,
  };
  const reply = (status = 200, retry = 60) => NextResponse.json(data, { status, headers: {
    "Cache-Control": "private, no-store, max-age=0",
    ...(status === 429 || data.error?.code === "RATE_LIMITED" ? { "Retry-After": String(retry) } : {}),
  } });
  try {
    const config = publicConfig();
    data = { ...data, ...config, configured: true };
    const snapshot = await marketSnapshot(config.instrument.symbol);
    data.fetchedAt = snapshot.fetchedAt;
    const closed = snapshot.candles.filter((candle) => candle.time + 60_000 <= now);
    data.lastCandleAt = closed.at(-1)?.time ?? null;
    data.dataAsOf = data.lastCandleAt === null ? null : data.lastCandleAt + 60_000;
    data.dataAgeSeconds = data.dataAsOf === null ? null : Math.max(0, Math.floor((now - data.dataAsOf) / 1000));
    data.connected = closed.length > 0;
    // Expected delay is labelled separately; also detect a missing final session.
    data.stale = Boolean(snapshot.error) || isDataStale(data.dataAsOf, now);
    if (data.dataAsOf !== null) data.setups = ([[60, 5], [30, 3], [15, 1]] as const).map(([higherMinutes, lowerMinutes]) => evaluateSimpleStrategy({
      candles: closed, higherMinutes, lowerMinutes, now: data.dataAsOf!, instrument: config.instrument.symbol,
    }));
    if (data.dataAsOf !== null) {
      // Reuse the signal engine's gap-aware, closed-candle aggregation. Bounded
      // chart payloads do not change the full lookback used to compute signals.
      data.charts = ([[60, 5], [30, 3], [15, 1]] as const).map(([higherMinutes, lowerMinutes]) => ({
        higherMinutes, lowerMinutes,
        higher: aggregateCandles(closed, higherMinutes, data.dataAsOf!).slice(-120),
        lower: aggregateCandles(closed, lowerMinutes, data.dataAsOf!).slice(-120),
      }));
      const last = closed.at(-1)!;
      data.quote = { price: last.close, sessionOpen: closed.find(c => c.time === sessionBounds(last.time).open)?.open ?? null };
    }
    if (snapshot.error) data.error = { code: snapshot.error.code, message: `${snapshot.error.message} Showing the last successful snapshot.` };
    return reply(200, snapshot.error?.retryAfterSeconds);
  } catch (error) {
    data.stale = true;
    data.setups = [];
    data.charts = [];
    data.quote = null;
    if (error instanceof ConfigurationError) {
      data.configured = false;
      data.error = { code: "NOT_CONFIGURED", message: error.message };
      return reply(500);
    }
    const failure = error instanceof MarketDataError ? error : new MarketDataError("UPSTREAM_ERROR", "Market data is temporarily unavailable. Monitoring will retry in 60 seconds.");
    data.error = { code: failure.code, message: failure.message };
    return reply(failure.status, failure.retryAfterSeconds);
  }
}
