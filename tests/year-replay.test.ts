import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregateCandles, evaluateFractal, sessionBounds, type Candle, type SignalEvent, type SessionOverrides } from '../src/lib/indicator';
import { runBacktest, simulateEvents } from '../src/lib/backtest';

const M = 60_000;
const at = (value: string) => Date.parse(`${value}+05:30`);
const special: SessionOverrides = {
  '2025-02-01': { openMinutes: 555, closeMinutes: 930 },
  '2025-10-21': { openMinutes: 825, closeMinutes: 885 },
};
const minute = (stamp: string, open = 100, high = 102, low = 98, close = 100): Candle => ({ time: at(stamp), open, high, low, close });
function signal(close: number, id = 'special'): SignalEvent[] {
  const common = { signalId: id, direction: 'bullish' as const, reason: 'Calendar fixture' };
  return [
    { ...common, id: `${id}:formed`, type: 'formed', time: close - M, availableAt: close - M, price: 96 },
    { ...common, id: `${id}:confirmed`, type: 'confirmed', time: close, availableAt: close, price: 99 },
    { ...common, id: `${id}:entry`, type: 'entry', time: close, availableAt: close, price: 100 },
  ];
}

describe('verified special NSE sessions', () => {
  it.each([60, 30, 15, 5, 3, 1])('anchors %i-minute Muhurat bars at its actual opening and clips at actual close', minutes => {
    const start = at('2025-10-21T13:45:00'), end = at('2025-10-21T14:45:00');
    const rows = Array.from({ length: 60 }, (_, i) => ({ time: start + i * M, open: 100, high: 101, low: 99, close: 100 }));
    const bars = aggregateCandles(rows, minutes, end, special);
    expect(bars).toHaveLength(60 / minutes);
    expect(bars[0].time).toBe(start);
    expect(bars.at(-1)?.closeTime).toBe(end);
    expect(sessionBounds(start, special)).toEqual({ open: start, close: end });
  });
  it('carries Friday positions into the real Saturday Budget open rather than skipping to Monday', () => {
    const result = simulateEvents({ sessionOverrides: special,
      candles: [minute('2025-01-31T15:29:00'), minute('2025-02-01T09:15:00', 94, 95, 93, 94)],
      events: signal(at('2025-01-31T15:30:00')) });
    expect(result.trades[0]).toMatchObject({ exitTime: at('2025-02-01T09:15:00'), exitReason: 'stop_gap', exit: 94, r: -1.5 });
  });
  it('carries into Muhurat at 13:45 with no fictitious missing morning minutes', () => {
    const result = simulateEvents({ sessionOverrides: special,
      candles: [minute('2025-10-20T15:29:00'), minute('2025-10-21T13:45:00', 110, 111, 109, 110)],
      events: signal(at('2025-10-20T15:30:00')) });
    expect(result.trades[0]).toMatchObject({ exitTime: at('2025-10-21T13:45:00'), exit: 108, r: 2 });
  });
  it('daily mode exits at the actual 14:45 special-session close', () => {
    const result = simulateEvents({ sessionOverrides: special, sessionExitMinutes: 930,
      candles: [minute('2025-10-21T14:43:00'), minute('2025-10-21T14:44:00', 100, 106, 98, 105)],
      events: signal(at('2025-10-21T14:44:00')) });
    expect(result.trades[0]).toMatchObject({ exitTime: at('2025-10-21T14:45:00'), exitReason: 'session_close', exit: 105, r: 1.25 });
  });
  it('carry mode crosses the special close and following holiday without an artificial exit', () => {
    const result = simulateEvents({ sessionOverrides: special, nonTradingDates: ['2025-10-22'],
      candles: [minute('2025-10-21T14:44:00'), minute('2025-10-23T09:15:00', 110, 111, 109, 110)],
      events: signal(at('2025-10-21T14:45:00')) });
    expect(result.trades[0]).toMatchObject({ exitTime: at('2025-10-23T09:15:00'), exitReason: 'target', r: 2 });
  });
  it('does not let a truncated special session masquerade as a complete session', () => {
    const result = simulateEvents({ sessionOverrides: special, nonTradingDates: ['2025-10-22'],
      candles: [minute('2025-10-21T14:43:00'), minute('2025-10-23T09:15:00', 110, 111, 109, 110)],
      events: signal(at('2025-10-21T14:44:00')) });
    expect(result.trades[0]).toMatchObject({ status: 'unresolved', exit: null });
  });
  it('rejects invalid dates and impossible session bounds', () => {
    const invalidCases: SessionOverrides[] = [{ '2025-02-30': { openMinutes: 555, closeMinutes: 930 } }, { '2025-10-21': { openMinutes: 885, closeMinutes: 825 } }];
    for (const overrides of invalidCases) {
      expect(() => aggregateCandles([], 1, Date.now(), overrides)).toThrow('special-session');
    }
  });
});

describe('reviewed replay preserves trade results with explicit event corrections', () => {
  const candles: Candle[] = JSON.parse(readFileSync('reports/backtest-2026-11-08/data/minute-candles.json', 'utf8'));
  const frozen = JSON.parse(readFileSync('reports/backtest-2026-11-08-carry/results.json', 'utf8'));
  it.each([[60, 5], [30, 3], [15, 1]] as const)('matches the saved %i/%i carry trade ledger and metrics exactly', (higherMinutes, lowerMinutes) => {
    const previous = frozen.continuousStudy.results.find((r: { higherMinutes: number }) => r.higherMinutes === higherMinutes);
    const current = runBacktest({ ...frozen.continuousStudy.settings, candles, higherMinutes, lowerMinutes });
    expect(current.trades).toEqual(previous.trades);
    expect(current.summary).toEqual(previous.summary);
    expect(current.skipped).toEqual(previous.skipped);
    // The archived engine emitted two non-actionable late-C3 confirmations
    // before discovering the first C4 candle had breached C2. Keep the archive
    // unchanged; assert only these reviewed deletions and gap-availability fixes.
    const removed = higherMinutes === 30 ? new Set([
      '^NSEI:30-3:1791796500000:bullish:confirmed',
      '^NSEI:30-3:1793265300000:bearish:confirmed',
    ]) : new Set<string>();
    expect(previous.events.filter((e: SignalEvent) => removed.has(e.id))).toHaveLength(removed.size);
    expect(current.events.some(e => removed.has(e.id))).toBe(false);
    const reviewedEvents: SignalEvent[] = previous.events.filter((e: SignalEvent) => !removed.has(e.id)).map((e: SignalEvent) =>
      e.reason === 'Missing candles: setup monitoring reset.' ? { ...e, availableAt: e.time + lowerMinutes * M } : e);
    const sorted = (events: SignalEvent[]) => [...events].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted(current.events)).toEqual(sorted(reviewedEvents));
  });
  it.each([[60, 5], [30, 3], [15, 1]] as const)('matches independent prefix visibility for every saved-data %i/%i entry', (higherMinutes, lowerMinutes) => {
    const decisions: { event: SignalEvent; visible: boolean }[] = [];
    evaluateFractal({ candles, higherMinutes, lowerMinutes, instrument: '^NSEI', now: candles.at(-1)!.time + M,
      onEntryVisibility: (event, visible) => decisions.push({ event, visible }) });
    expect(decisions.length).toBeGreaterThan(0);
    for (const { event, visible } of decisions) {
      const prefix = evaluateFractal({ candles: candles.filter(row => row.time + M <= event.time), higherMinutes, lowerMinutes, instrument: '^NSEI', now: event.time });
      expect(visible).toBe(prefix.signalId === event.signalId && prefix.status === `confirmed_${event.direction}`);
    }
  }, 30_000);
});
