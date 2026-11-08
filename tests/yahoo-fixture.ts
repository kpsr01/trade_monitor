export const TEST_NOW = Date.parse("2026-11-06T12:00:00+05:30");
export const minute = (time: string) => Date.parse(`2026-11-06T${time}+05:30`) / 1000;

/** Representative Yahoo chart response; prices are synthetic, not trading advice. */
export function yahooFixture(timestamps = [minute("11:43:00"), minute("11:44:00"), minute("11:45:00")], quoteTime = minute("11:45:30")) {
  return { chart: { error: null, result: [{
    meta: { symbol: "^NSEI", dataGranularity: "1m", exchangeTimezoneName: "Asia/Kolkata", regularMarketTime: quoteTime },
    timestamp: timestamps,
    indicators: { quote: [{
      open: timestamps.map(() => 100 as number | null), high: timestamps.map(() => 102 as number | null),
      low: timestamps.map(() => 99 as number | null), close: timestamps.map(() => 101 as number | null),
      volume: timestamps.map(() => 0 as number | null),
    }] },
  }] } };
}
