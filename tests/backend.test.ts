import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicConfig } from "../src/lib/server/config";
import { aggregateCandles } from "../src/lib/indicator";
import { isDataStale } from "../src/lib/server/market-hours";
import { fetchMinuteCandles, parseYahooCandles } from "../src/lib/server/yahoo";
import { TEST_NOW, minute, yahooFixture } from "./yahoo-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(TEST_NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("free provider configuration", () => {
  it("works without credentials and uses an explicit server symbol allowlist", () => {
    expect(publicConfig()).toMatchObject({ instrument: { symbol: "^NSEI", name: "NIFTY 50" } });
    vi.stubEnv("INSTRUMENT_SYMBOL", "^NSEBANK");
    expect(publicConfig().instrument.name).toBe("NIFTY BANK");
    vi.stubEnv("INSTRUMENT_SYMBOL", "https://attacker.example");
    expect(() => publicConfig()).toThrow("INSTRUMENT_SYMBOL");
    vi.stubEnv("INSTRUMENT_SYMBOL", "toString");
    expect(() => publicConfig()).toThrow();
  });
  it("does not expose legacy buffer or tick-size configuration", () => {
    vi.stubEnv("TICK_SIZE", "100");
    vi.stubEnv("STOP_LOSS_BUFFER", "100");
    expect(publicConfig()).toEqual({ instrument: { symbol: "^NSEI", name: "NIFTY 50", exchange: "NSE" } });
  });
});

describe("Yahoo one-minute candle parsing", () => {
  it("excludes a delayed partial candle using provider quote time, despite an older wall timestamp", () => {
    const candles = parseYahooCandles(yahooFixture(), "^NSEI", TEST_NOW);
    expect(candles.map((c) => c.time)).toEqual([minute("11:43:00") * 1000, minute("11:44:00") * 1000]);
    expect(candles[0]).toMatchObject({ open: 100, high: 102, low: 99, close: 101, volume: 0 });
  });
  it("never accepts a candle whose close is in the wall-clock future", () => {
    const payload = yahooFixture([minute("11:59:00"), minute("12:00:00")], minute("12:05:00"));
    expect(parseYahooCandles(payload, "^NSEI", TEST_NOW).map((c) => c.time)).toEqual([minute("11:59:00") * 1000]);
  });
  it("drops pre-session rows and Yahoo's 15:30 quote-only sentinel", () => {
    const payload = yahooFixture([minute("09:14:00"), minute("09:15:00"), minute("15:29:00"), minute("15:30:00"), minute("15:31:22")], minute("15:31:22"));
    expect(parseYahooCandles(payload, "^NSEI", minute("16:00:00") * 1000).map((c) => c.time)).toEqual([minute("09:15:00") * 1000, minute("15:29:00") * 1000]);
  });
  it("leaves null/gapped minutes absent and sorts/deduplicates identical rows", () => {
    const payload = yahooFixture([minute("11:44:00"), minute("11:43:00"), minute("11:44:00"), minute("11:42:00")]);
    payload.chart.result[0].indicators.quote[0].close[3] = null;
    expect(parseYahooCandles(payload, "^NSEI", TEST_NOW).map((c) => c.time)).toEqual([minute("11:43:00") * 1000, minute("11:44:00") * 1000]);
  });
  it("does not allow a null minute to become a complete higher-timeframe candle", () => {
    const payload = yahooFixture(Array.from({ length: 15 }, (_, index) => minute("11:15:00") + index * 60));
    payload.chart.result[0].indicators.quote[0].close[7] = null;
    const candles = parseYahooCandles(payload, "^NSEI", TEST_NOW);
    expect(candles).toHaveLength(14);
    expect(aggregateCandles(candles, 15, TEST_NOW)).toEqual([]);
  });
  it("rejects conflicting duplicates, impossible OHLC, negative volume and non-minute intraday timestamps", () => {
    const duplicate = yahooFixture([minute("11:43:00"), minute("11:43:00")]);
    duplicate.chart.result[0].indicators.quote[0].open[1] = 101;
    expect(() => parseYahooCandles(duplicate, "^NSEI", TEST_NOW)).toThrow("duplicate");
    const impossible = yahooFixture(); impossible.chart.result[0].indicators.quote[0].high[0] = 98;
    expect(() => parseYahooCandles(impossible, "^NSEI", TEST_NOW)).toThrow();
    const volume = yahooFixture(); volume.chart.result[0].indicators.quote[0].volume[0] = -1;
    expect(() => parseYahooCandles(volume, "^NSEI", TEST_NOW)).toThrow();
    expect(() => parseYahooCandles(yahooFixture([minute("11:43:01")]), "^NSEI", TEST_NOW)).toThrow();
  });
  it("rejects a wrong instrument, interval, timezone, watermark or uneven arrays", () => {
    for (const [key, value] of [["symbol", "AAPL"], ["dataGranularity", "5m"], ["exchangeTimezoneName", "America/New_York"], ["regularMarketTime", null]] as const) {
      const payload = yahooFixture(); Object.assign(payload.chart.result[0].meta, { [key]: value });
      expect(() => parseYahooCandles(payload, "^NSEI", TEST_NOW)).toThrow();
    }
    const payload = yahooFixture(); payload.chart.result[0].indicators.quote[0].open.pop();
    expect(() => parseYahooCandles(payload, "^NSEI", TEST_NOW)).toThrow();
    expect(() => parseYahooCandles({ chart: { error: { code: "Not Found" } } }, "^NSEI", TEST_NOW)).toThrow();
  });
});

describe("Yahoo HTTP boundary", () => {
  it("only fetches a fixed read-only endpoint without authorization or credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(yahooFixture())); vi.stubGlobal("fetch", fetcher);
    expect(await fetchMinuteCandles("^NSEI")).toHaveLength(2);
    const [url, init] = fetcher.mock.calls[0];
    expect(url.origin).toBe("https://query1.finance.yahoo.com");
    expect(url.pathname).toBe("/v8/finance/chart/%5ENSEI");
    expect(url.searchParams.get("range")).toBe("5d"); expect(url.searchParams.get("interval")).toBe("1m");
    expect(init.headers.Authorization).toBeUndefined(); expect(init.headers.Cookie).toBeUndefined();
    expect(init.cache).toBe("no-store"); expect(init.redirect).toBe("error");
  });
  it("handles HTML rate-limit errors before parsing and honors Retry-After", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Slow down", { status: 429, headers: { "Retry-After": "120" } })));
    await expect(fetchMinuteCandles("^NSEI")).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429, retryAfterSeconds: 120 });
  });
  it.each([["999999999999", 86400], ["invalid", 60], ["10", 60]])("bounds malformed or excessive Retry-After %s", async (header, seconds) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Slow down", { status: 429, headers: { "Retry-After": String(header) } })));
    await expect(fetchMinuteCandles("^NSEI")).rejects.toMatchObject({ retryAfterSeconds: seconds });
  });
  it.each([403, 500])("handles upstream HTTP %s without exposing upstream content", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream debug", { status })));
    await expect(fetchMinuteCandles("^NSEI")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
  it("handles network failures, invalid JSON and empty data", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network internals")); vi.stubGlobal("fetch", fetcher);
    await expect(fetchMinuteCandles("^NSEI")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    fetcher.mockResolvedValue(new Response("bad json"));
    await expect(fetchMinuteCandles("^NSEI")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    fetcher.mockResolvedValue(Response.json(yahooFixture([])));
    await expect(fetchMinuteCandles("^NSEI")).rejects.toMatchObject({ code: "NO_DATA" });
  });
});

describe("delayed feed session freshness", () => {
  it("detects a missing Friday close on Sunday and a missing final bar after Friday's delay allowance", () => {
    const fridayClose = minute("15:30:00") * 1000;
    const sunday = Date.parse("2026-11-08T12:00:00+05:30");
    expect(isDataStale(fridayClose, sunday)).toBe(false);
    expect(isDataStale(fridayClose - 86_400_000, sunday)).toBe(true);
    expect(isDataStale(fridayClose - 60_000, minute("16:00:00") * 1000)).toBe(true);
    expect(isDataStale(fridayClose - 10 * 60_000, minute("15:35:00") * 1000)).toBe(false);
  });
  it("uses configured holidays for the expected last close", () => {
    vi.stubEnv("NSE_HOLIDAYS", "2026-11-06");
    const thursdayClose = Date.parse("2026-11-05T15:30:00+05:30");
    expect(isDataStale(thursdayClose, Date.parse("2026-11-08T12:00:00+05:30"))).toBe(false);
  });
});
