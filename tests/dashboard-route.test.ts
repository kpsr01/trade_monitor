import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { TEST_NOW, minute, yahooFixture } from "./yahoo-fixture";

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(TEST_NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const request = (query = "") => new NextRequest(`https://example.com/api/dashboard${query}`);

describe("free dashboard route", () => {
  it("returns three index calculations with no login and uses the last closed provider minute", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(yahooFixture())); vi.stubGlobal("fetch", fetcher);
    const { GET } = await import("../src/app/api/dashboard/route");
    const response = await GET(request()); const body = await response.json();
    expect(response.status).toBe(200); expect(body.connected).toBe(true); expect(body.configured).toBe(true);
    expect(body.setups).toHaveLength(3); expect(body.delayed).toBe(true);
    expect(body.setups.every((setup: { strategy: string; signals: unknown[]; phase: string }) => setup.strategy === 'sweep-post-cisd-close-2r' && Array.isArray(setup.signals) && !['C3', 'C4'].includes(setup.phase))).toBe(true);
    expect(body.lastCandleAt).toBe(minute("11:44:00") * 1000); expect(body.dataAsOf).toBe(minute("11:45:00") * 1000);
    expect(body.dataAgeSeconds).toBe(15 * 60); expect(body.stale).toBe(false);
    expect(body.quote).toEqual({ price: 101, sessionOpen: null });
    expect(body.setups.every((setup: { updatedAt: number }) => setup.updatedAt === body.dataAsOf)).toBe(true);
    expect(response.headers.get("set-cookie")).toBeNull(); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify(body)).not.toMatch(/apiKey|apiSecret|accessToken|sessionExpiresAt/);
    await GET(request()); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("marks an excessively delayed open-market feed stale", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(yahooFixture([minute("11:30:00")], minute("11:31:00")))));
    const { GET } = await import("../src/app/api/dashboard/route");
    expect(await (await GET(request())).json()).toMatchObject({ stale: true, dataAgeSeconds: 29 * 60, marketOpen: true });
  });
  it("charts use bounded closed candles, omit incomplete or gapped aggregates, and share the existing fetch", async () => {
    const timestamps = Array.from({ length: 151 }, (_, i) => minute("09:15:00") + i * 60).filter(t => t !== minute("10:31:00"));
    const fetcher = vi.fn().mockResolvedValue(Response.json(yahooFixture(timestamps, minute("11:45:30"))));
    vi.stubGlobal("fetch", fetcher);
    const { GET } = await import("../src/app/api/dashboard/route");
    const body = await (await GET(request())).json();
    expect(body.charts).toHaveLength(3);
    expect(body.quote).toEqual({ price: 101, sessionOpen: 100 });
    const hour = body.charts.find((s: { higherMinutes: number }) => s.higherMinutes === 60);
    expect(hour.higher.map((c: { time: number }) => c.time)).toEqual([minute("09:15:00") * 1000]);
    const three = body.charts.find((s: { lowerMinutes: number }) => s.lowerMinutes === 3);
    expect(three.lower.some((c: { time: number }) => c.time === minute("10:30:00") * 1000)).toBe(false);
    for (const series of body.charts) for (const rows of [series.higher, series.lower]) {
      expect(rows.length).toBeLessThanOrEqual(120);
      expect(rows.every((c: { closeTime: number }) => c.closeTime <= body.dataAsOf)).toBe(true);
    }
    expect(body.charts[2].lower).toHaveLength(120);
    await GET(request()); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reports historical timestamps on a closed market without calling it current data", async () => {
    vi.setSystemTime(Date.parse("2026-11-08T12:00:00+05:30"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(yahooFixture([minute("15:29:00"), minute("15:30:00")], minute("15:31:22")))));
    const { GET } = await import("../src/app/api/dashboard/route");
    const body = await (await GET(request())).json();
    expect(body.marketOpen).toBe(false); expect(body.delayed).toBe(true); expect(body.dataAsOf).toBe(minute("15:30:00") * 1000);
    expect(body.dataAgeSeconds).toBeGreaterThan(24 * 60 * 60);
  });
  it("returns stale fallback data with the upstream error instead of a false fresh status", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(yahooFixture())).mockResolvedValue(new Response("error", { status: 503 })); vi.stubGlobal("fetch", fetcher);
    const { GET } = await import("../src/app/api/dashboard/route");
    const first = await (await GET(request())).json(); await vi.advanceTimersByTimeAsync(60_000);
    const body = await (await GET(request())).json();
    expect(body).toMatchObject({ connected: true, stale: true, fetchedAt: first.fetchedAt, dataAsOf: first.dataAsOf, error: { code: "UPSTREAM_ERROR" } });
  });
  it("returns a readable rate-limit failure and Retry-After without any invented signals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status: 429 })));
    const { GET } = await import("../src/app/api/dashboard/route");
    const response = await GET(request());
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({ connected: false, stale: true, setups: [], charts: [], quote: null, error: { code: "RATE_LIMITED" } });
  });
  it("ignores legacy buffer overrides and caller-provided symbols/URLs", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(yahooFixture())); vi.stubGlobal("fetch", fetcher);
    const { GET } = await import("../src/app/api/dashboard/route");
    const baseline = await (await GET(request())).json();
    const body = await (await GET(request("?buffer=100&symbol=AAPL&url=https://attacker.example"))).json();
    expect(body).toEqual(baseline); expect(body.buffer).toBeUndefined(); expect(body.tickSize).toBeUndefined();
    expect(body.instrument.symbol).toBe("^NSEI"); expect(fetcher.mock.calls[0][0].host).toBe("query1.finance.yahoo.com");
  });
});
