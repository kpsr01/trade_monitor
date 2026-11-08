import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_NOW, yahooFixture } from "./yahoo-fixture";

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(TEST_NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Yahoo cache and retry budget", () => {
  it("coalesces concurrent requests and refreshes at the 60-second boundary", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(yahooFixture())); vi.stubGlobal("fetch", fetcher);
    const { marketSnapshot } = await import("../src/lib/server/market-cache");
    const [a, b] = await Promise.all([marketSnapshot("^NSEI"), marketSnapshot("^NSEI")]);
    expect(a).toBe(b); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999); expect(await marketSnapshot("^NSEI")).toBe(a);
    await vi.advanceTimersByTimeAsync(1); await marketSnapshot("^NSEI");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("honors an upstream cooldown across repeated polling requests", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response("Slow down", { status: 429, headers: { "Retry-After": "120" } })); vi.stubGlobal("fetch", fetcher);
    const { marketSnapshot } = await import("../src/lib/server/market-cache");
    await expect(marketSnapshot("^NSEI")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(marketSnapshot("^NSEI")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(marketSnapshot("^NSEI")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("returns the original timestamp and an explicit failure when falling back, then recovers", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(yahooFixture())).mockResolvedValue(new Response("error", { status: 500 })); vi.stubGlobal("fetch", fetcher);
    const { marketSnapshot } = await import("../src/lib/server/market-cache");
    const first = await marketSnapshot("^NSEI");
    await vi.advanceTimersByTimeAsync(60_000);
    const cached = await marketSnapshot("^NSEI");
    expect(cached.candles).toBe(first.candles); expect(cached.fetchedAt).toBe(first.fetchedAt);
    expect(cached.error?.code).toBe("UPSTREAM_ERROR");
    expect((await marketSnapshot("^NSEI")).error?.code).toBe("UPSTREAM_ERROR"); expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async () => Response.json(yahooFixture()));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await marketSnapshot("^NSEI")).error).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("does not return a cached snapshot fetched more than a day ago after failure", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(yahooFixture())).mockResolvedValue(new Response("error", { status: 500 })); vi.stubGlobal("fetch", fetcher);
    const { marketSnapshot } = await import("../src/lib/server/market-cache");
    await marketSnapshot("^NSEI"); await vi.advanceTimersByTimeAsync(86_400_001);
    await expect(marketSnapshot("^NSEI")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});
