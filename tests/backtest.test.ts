import { describe, expect, it } from 'vitest';
import { runBacktest, simulateEvents, summarizeTrades } from '../src/lib/backtest';
import { evaluateFractal, type Candle, type Direction, type SignalEvent } from '../src/lib/indicator';

const T = Date.parse('2026-11-06T09:15:00+05:30'), M = 60_000;
const candle = (minute: number, open = 100, high = 102, low = 98, close = 100): Candle => ({ time: T + minute * M, open, high, low, close });
function signal(id = 's1', minute = 1, direction: Direction = 'bullish', price = 100): SignalEvent[] {
  const time = T + minute * M;
  const base = { signalId: id, direction, reason: 'Test fixture' };
  return [
    { ...base, id: `${id}:formed`, type: 'formed', time: time - M, availableAt: time - M, price: direction === 'bullish' ? price - 4 : price + 4 },
    { ...base, id: `${id}:confirmed`, type: 'confirmed', time, availableAt: time, price: direction === 'bullish' ? price - 1 : price + 1 },
    { ...base, id: `${id}:entry`, type: 'entry', time, availableAt: time, price },
  ];
}
const terminal = (type: 'invalidated' | 'finished', minute: number, availableMinute = minute, id = 's1'): SignalEvent => ({
  id: `${id}:${type}`, signalId: id, type, time: T + minute * M, availableAt: T + availableMinute * M,
  direction: 'bullish', reason: 'Test fixture', price: null,
});

describe('confirmed-close backtest execution conventions', () => {
  it('enters at the confirmed close, uses exact C2 stop and exits at 2R', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1, 101, 109, 99, 108)], events: signal() });
    expect(result.trades[0]).toMatchObject({ entryTime: T + M, entryRecordedAt: T + M, entry: 100, stopLoss: 96, target: 108, risk: 4, exit: 108, exitReason: 'target', r: 2 });
    expect(result.summary).toMatchObject({ closedTrades: 1, wins: 1, totalR: 2, totalPoints: 8, winRate: 1, maxDrawdownR: 0 });
  });
  it('never applies the confirming candle earlier wick to the newly entered position', () => {
    const result = simulateEvents({ candles: [candle(0, 100, 112, 94, 100), candle(1, 100, 109, 99, 108)], events: signal() });
    expect(result.trades[0]).toMatchObject({ exitTime: T + 2 * M, exitReason: 'target', r: 2, ambiguousBar: false });
  });
  it('handles short targets and an adverse opening gap immediately after entry', () => {
    const short = simulateEvents({ candles: [candle(0), candle(1, 99, 101, 91, 92)], events: signal('s1', 1, 'bearish') });
    expect(short.trades[0]).toMatchObject({ stopLoss: 104, target: 92, exit: 92, r: 2 });
    const gap = simulateEvents({ candles: [candle(0), candle(1, 93, 96, 92, 94)], events: signal() });
    expect(gap.trades[0]).toMatchObject({ entry: 100, exit: 93, exitTime: T + M, exitReason: 'stop_gap', r: -1.75 });
  });
  it('fills target gaps conservatively at the limit, not the favorable opening price', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1, 115, 116, 114, 115)], events: signal() });
    expect(result.trades[0]).toMatchObject({ exit: 108, r: 2 });
  });
  it('uses stop-first for both boundaries in one later minute and counts ambiguity', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1, 100, 109, 95, 105)], events: signal() });
    expect(result.trades[0]).toMatchObject({ exit: 96, r: -1, ambiguousBar: true });
    expect(result.summary).toMatchObject({ ambiguousTrades: 1, maxDrawdownR: 1 });
  });
  it('rejects unavailable confirmation or entry events instead of backfilling prices', () => {
    const candles = [candle(0), candle(1, 100, 109, 99, 108)];
    const lateConfirmation = signal(); lateConfirmation[1].availableAt += M;
    expect(simulateEvents({ candles, events: lateConfirmation }).summary.skippedCounts.confirmation_unavailable).toBe(1);
    const lateEntry = signal(); lateEntry[2].availableAt += M;
    expect(simulateEvents({ candles, events: lateEntry }).summary.skippedCounts.entry_unavailable).toBe(1);
  });
  it('fills a late-discovered confirmation only at the close where it becomes available', () => {
    const events = signal();
    events[1].availableAt = T + 2 * M;
    Object.assign(events[2], { time: T + 2 * M, availableAt: T + 2 * M, price: 101 });
    const result = simulateEvents({ candles: [candle(0), candle(1, 100, 103, 98, 101), candle(2, 101, 112, 100, 111)], events });
    expect(result.trades[0]).toMatchObject({ confirmedAt: T + M, confirmationAvailableAt: T + 2 * M, entryTime: T + 2 * M, entry: 101, stopLoss: 96, target: 111, r: 2 });
  });
  it('cancels invalidated/finished signals before entry and rejects hidden slots', () => {
    const candles = [candle(0), candle(1, 100, 109, 99, 108)];
    for (const type of ['invalidated', 'finished'] as const) {
      const result = simulateEvents({ candles, events: [...signal(), terminal(type, 1)] });
      expect(result.summary.skippedCounts.cancelled_before_entry).toBe(1);
    }
    expect(simulateEvents({ candles, events: signal(), visibleAtEntry: () => false }).summary.skippedCounts.hidden_or_ambiguous).toBe(1);
  });
  it('exits invalidation at the next minute open before that minute later reaches target', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1), candle(2, 99, 109, 98, 108)], events: [...signal(), terminal('invalidated', 2)] });
    expect(result.trades[0]).toMatchObject({ exit: 99, exitTime: T + 2 * M, exitReason: 'invalidation', r: -0.25 });
  });
  it('allows already-resting stop gaps to execute before an invalidation market exit', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1), candle(2, 94, 99, 93, 98)], events: [...signal(), terminal('invalidated', 2)] });
    expect(result.trades[0]).toMatchObject({ exit: 94, exitReason: 'stop_gap' });
  });
  it('does not close an entered position merely because its monitoring window finishes', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1), candle(2, 101, 109, 100, 108)], events: [...signal(), terminal('finished', 2)] });
    expect(result.trades[0]).toMatchObject({ exitReason: 'target', r: 2 });
  });
  it('skips simultaneous opposing signals and overlapping later entries', () => {
    const candles = [candle(0), candle(1), candle(2, 101, 109, 100, 108)];
    const opposed = simulateEvents({ candles, events: [...signal(), ...signal('s2', 1, 'bearish')] });
    expect(opposed.trades).toHaveLength(0); expect(opposed.summary.skippedCounts.simultaneous_directions).toBe(2);
    const overlap = simulateEvents({ candles, events: [...signal(), ...signal('s2', 2)] });
    expect(overlap.trades).toHaveLength(1); expect(overlap.summary.skippedCounts.overlapping_position).toBe(1);
  });
  it('can enter at a close after the preceding position exits within that minute', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1, 100, 109, 99, 108), candle(2, 108, 117, 107, 116)], events: [...signal(), ...signal('s2', 2, 'bullish', 108)] });
    expect(result.trades).toHaveLength(2);
    expect(result.trades.map(trade => trade.r)).toEqual([2, 2]);
    expect(result.trades[0].exitTime).toBe(result.trades[1].entryTime);
  });
  it('does not use a following opening exit to free a position slot at the prior close', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1), candle(2, 110, 111, 109, 110)], events: [...signal(), ...signal('s2', 2)] });
    expect(result.trades).toHaveLength(1);
    expect(result.summary.skippedCounts.overlapping_position).toBe(1);
    expect(result.trades[0]).toMatchObject({ exitTime: T + 2 * M, exitReason: 'target' });
  });
  it('keeps a uniquely visible slot before testing same-time opposing ambiguity', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1, 100, 109, 99, 108)], events: [...signal('visible'), ...signal('hidden', 1, 'bearish')], visibleAtEntry: event => event.signalId === 'visible' });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].signalId).toBe('visible');
    expect(result.summary.skippedCounts.hidden_or_ambiguous).toBe(1);
    expect(result.summary.skippedCounts.simultaneous_directions).toBeUndefined();
  });
  it('requires the actual minute closing at entry and rejects a mismatched entry price', () => {
    const missing = simulateEvents({ candles: [candle(1), candle(2)], events: signal(), testStart: T });
    expect(missing.summary.skippedCounts.missing_entry_candle).toBe(1);
    const wrongPrice = simulateEvents({ candles: [candle(0, 100, 102, 98, 101), candle(1)], events: signal() });
    expect(wrongPrice.trades).toHaveLength(0);
    expect(wrongPrice.summary.skippedCounts.invalid_risk).toBe(1);
  });
  it('excludes a position with missing execution minutes instead of guessing its outcome', () => {
    const result = simulateEvents({ candles: [candle(0), candle(2, 100, 109, 95, 100), candle(3)], events: [...signal(), ...signal('s2', 3)] });
    expect(result.trades[0]).toMatchObject({ status: 'unresolved', exitReason: 'missing_candle', r: null, exit: null });
    expect(result.summary).toMatchObject({ closedTrades: 0, unresolvedTrades: 1, totalR: 0, winRate: null });
    expect(result.summary.skippedCounts.unresolved_position).toBe(1);
  });
  it('supports an explicit legacy session exit and keeps truncated positions open by default', () => {
    const end = simulateEvents({ candles: [candle(373), candle(374, 100, 106, 98, 105)], events: signal('s1', 374), sessionExitMinutes: 930 });
    expect(end.trades[0]).toMatchObject({ exitReason: 'session_close', exitTime: T + 375 * M, r: 1.25 });
    const truncated = simulateEvents({ candles: [candle(0), candle(1)], events: signal() });
    expect(truncated.trades[0]).toMatchObject({ status: 'open', exitReason: null, exit: null });
    expect(truncated.summary).toMatchObject({ openTrades: 1, unresolvedTrades: 0, closedTrades: 0, totalR: 0 });
  });
  it('exits before the closing auction, skips cutoff entries and ignores its later jump', () => {
    const result = simulateEvents({
      candles: [candle(358), candle(359, 100, 106, 98, 105), candle(360, 105, 140, 105, 140)],
      events: [...signal('s1', 359), ...signal('s2', 360, 'bullish', 105)], sessionExitMinutes: 915,
    });
    expect(result.trades[0]).toMatchObject({ exitReason: 'session_close', exitTime: T + 360 * M, exit: 105, r: 1.25 });
    expect(result.trades).toHaveLength(1);
    expect(result.summary.skippedCounts.outside_execution_session).toBe(1);
  });
  it('allows a fill exactly at testStart using the preceding candle and applies explicit cost', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1), candle(2, 100, 109, 99, 108)], events: [...signal(), ...signal('s2', 2)], testStart: T + 2 * M, roundTripCostPoints: 1 });
    expect(result.summary.skippedCounts.before_test).toBe(1);
    expect(result.trades[0]).toMatchObject({ entryTime: T + 2 * M, grossPoints: 8, points: 7, grossR: 2, r: 1.75 });
  });
  it('preserves the exact C2 precision without a buffer or tick rounding', () => {
    const events = signal(); events[0].price = 96.023456789;
    const result = simulateEvents({ candles: [candle(0), candle(1, 100, 109, 99, 108)], events });
    expect(result.trades[0].stopLoss).toBe(96.023456789);
    expect(result.trades[0].target).toBe(100 + 2 * (100 - 96.023456789));
    expect(result.trades[0].r).toBeCloseTo(2);
  });
  it('deduplicates replayed events and validates impossible settings', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1, 100, 109, 99, 108)], events: [...signal(), ...signal()] });
    expect(result.trades).toHaveLength(1);
    expect(() => simulateEvents({ candles: [], events: [], roundTripCostPoints: -1 })).toThrow();
    expect(() => simulateEvents({ candles: [], events: [], sessionExitMinutes: 1000 })).toThrow();
    expect(() => simulateEvents({ candles: [], events: [], executionEndMinutes: 555 })).toThrow();
    expect(() => simulateEvents({ candles: [], events: [], sessionExitMinutes: 930, executionEndMinutes: 915 })).toThrow();
    expect(() => simulateEvents({ candles: [], events: [], nonTradingDates: ['2026-02-31'] })).toThrow();
    expect(summarizeTrades([])).toMatchObject({ averageR: null, winRate: null, profitFactorR: null });
  });
});

const D = 1440 * M;
const onDay = (rows: Candle[], day: number) => rows.map(row => ({ ...row, time: row.time + day * D }));
const signalOnDay = (events: SignalEvent[], day: number) => events.map(event => ({ ...event, time: event.time + day * D, availableAt: event.availableAt + day * D }));

describe('position carry and strict execution continuity', () => {
  it('carries through an ordinary overnight boundary and fills a stop gap at the next open', () => {
    const result = simulateEvents({
      candles: [...onDay([candle(373), candle(374)], -1), candle(0, 93, 96, 92, 94)],
      events: signalOnDay(signal('s1', 374), -1),
    });
    expect(result.trades[0]).toMatchObject({ status: 'closed', exitTime: T, exit: 93, exitReason: 'stop_gap', r: -1.75 });
    expect(result.summary).toMatchObject({ openTrades: 0, unresolvedTrades: 0 });
  });
  it('fills an overnight target gap at 2R instead of the better opening price', () => {
    const result = simulateEvents({
      candles: [...onDay([candle(373), candle(374)], -1), candle(0, 115, 116, 114, 115)],
      events: signalOnDay(signal('s1', 374), -1),
    });
    expect(result.trades[0]).toMatchObject({ status: 'closed', exitTime: T, exit: 108, exitReason: 'target', r: 2 });
  });
  it('carries across a weekend without requiring closed-market candles', () => {
    const result = simulateEvents({
      candles: [candle(373), candle(374), ...onDay([candle(0, 93, 96, 92, 94)], 3)],
      events: signal('s1', 374),
    });
    expect(result.trades[0]).toMatchObject({ status: 'closed', exitTime: T + 3 * D, exitReason: 'stop_gap', r: -1.75 });
  });
  it('allows a verified weekday holiday and refuses to guess an unverified missing session', () => {
    const options = {
      candles: [...onDay([candle(373), candle(374)], -1), ...onDay([candle(0, 115, 116, 114, 115)], 3)],
      events: signalOnDay(signal('s1', 374), -1),
    };
    const verified = simulateEvents({ ...options, nonTradingDates: ['2026-11-06'] });
    expect(verified.trades[0]).toMatchObject({ status: 'closed', exitReason: 'target', r: 2 });
    const unknown = simulateEvents(options);
    expect(unknown.trades[0]).toMatchObject({ status: 'unresolved', exitReason: 'missing_candle', exit: null, r: null });
  });
  it('keeps the same bracket after setup expiry while carrying overnight', () => {
    const result = simulateEvents({
      candles: [candle(373), candle(374), ...onDay([candle(0, 100, 109, 99, 108)], 3)],
      events: [...signal('s1', 374), terminal('finished', 375)],
    });
    expect(result.trades[0]).toMatchObject({ status: 'closed', exitReason: 'target', stopLoss: 96, target: 108, r: 2 });
  });
  it('retains explicit invalidation across the closed-market boundary', () => {
    const result = simulateEvents({
      candles: [candle(373), candle(374), ...onDay([candle(0, 99, 109, 98, 108)], 3)],
      events: [...signal('s1', 374), terminal('invalidated', 375)],
    });
    expect(result.trades[0]).toMatchObject({ status: 'closed', exit: 99, exitTime: T + 3 * D, exitReason: 'invalidation', r: -0.25 });
  });
  it('does not mistake a missing final execution minute for an overnight boundary', () => {
    const result = simulateEvents({ candles: [candle(373), ...onDay([candle(0, 115, 116, 114, 115)], 3)], events: signal('s1', 374) });
    expect(result.trades[0]).toMatchObject({ status: 'unresolved', exitReason: 'missing_candle', r: null });
  });
  it('does not use a later price when the next session opening minute is missing', () => {
    const result = simulateEvents({ candles: [candle(373), candle(374), ...onDay([candle(1, 115, 116, 114, 115)], 3)], events: signal('s1', 374) });
    expect(result.trades[0]).toMatchObject({ status: 'unresolved', exitReason: 'missing_candle', exit: null });
  });
  it('blocks later entries across all sessions after a position crosses an unknown price path', () => {
    const result = simulateEvents({
      candles: [candle(0), candle(2), candle(3), ...onDay([candle(0), candle(1)], 3), ...onDay([candle(0), candle(1)], 4)],
      events: [...signal(), ...signal('s2', 3), ...signalOnDay(signal('s3'), 3), ...signalOnDay(signal('s4'), 4)],
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].status).toBe('unresolved');
    expect(result.summary.skippedCounts.unresolved_position).toBe(3);
  });
  it('keeps a position open at dataset end without including an unrealized return', () => {
    const result = simulateEvents({ candles: [candle(373), candle(374, 100, 106, 98, 105)], events: signal('s1', 374) });
    expect(result.trades[0]).toMatchObject({ status: 'open', exit: null, exitTime: null, exitReason: null, points: null, r: null });
    expect(result.summary).toMatchObject({ openTrades: 1, unresolvedTrades: 0, closedTrades: 0, totalR: 0, winRate: null });
  });
  it('right-censors at an explicit test end even if later data would hit a bracket', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1), candle(2, 100, 109, 99, 108)], events: signal(), testEnd: T + 2 * M });
    expect(result.trades[0]).toMatchObject({ status: 'open', exit: null, r: null });
    expect(result.summary.unresolvedTrades).toBe(0);
  });
  it('does not invent missing future candles when requested testEnd exceeds available data', () => {
    const result = simulateEvents({ candles: [candle(0), candle(1)], events: signal(), testEnd: T + 4 * D });
    expect(result.trades[0]).toMatchObject({ status: 'open', exitReason: null });
  });
  it('excludes the auction tail without forcing an exit and resumes the next session', () => {
    const result = simulateEvents({
      candles: [candle(358), candle(359), candle(360, 100, 140, 100, 140), ...onDay([candle(0, 94, 99, 93, 98)], 3)],
      events: [...signal('s1', 359), ...signal('s2', 361)], executionEndMinutes: 915,
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ status: 'closed', exit: 94, exitTime: T + 3 * D, exitReason: 'stop_gap', r: -1.5 });
    expect(result.summary.skippedCounts.outside_execution_session).toBe(1);
  });
  it('can enter at the last trusted close and carry it when forced exits are disabled', () => {
    const result = simulateEvents({
      candles: [candle(359), candle(360, 100, 140, 100, 140), ...onDay([candle(0, 115, 116, 114, 115)], 3)],
      events: signal('s1', 360), executionEndMinutes: 915,
    });
    expect(result.trades[0]).toMatchObject({ entryTime: T + 360 * M, status: 'closed', exitTime: T + 3 * D, exit: 108, r: 2 });
  });
  it('flags a missing execution-tail candle when later auction data proves the gap', () => {
    const result = simulateEvents({ candles: [candle(358), candle(360)], events: signal('s1', 359), executionEndMinutes: 915 });
    expect(result.trades[0]).toMatchObject({ status: 'unresolved', exitReason: 'missing_candle', r: null });
  });
});

function sourceFixture() {
  const steady = (start: number, count: number, open: number, high: number, low: number, close: number) => Array.from({ length: count }, (_, i) => candle(start + i, open, high, low, close));
  return [...steady(0, 15, 105, 110, 100, 106), candle(15, 106, 108, 99, 102), candle(16, 102, 104, 95, 100),
    ...steady(17, 13, 103, 108, 100, 107), candle(30, 108, 137, 100, 136)];
}
describe('integration with CantoLab C2/CISD predicates', () => {
  it('uses the source-derived confirmation close, exact wick stop and visible prefix', () => {
    const result = runBacktest({ candles: sourceFixture(), higherMinutes: 15, lowerMinutes: 1, instrument: 'TEST' });
    expect(result.trades[0]).toMatchObject({ entryTime: T + 30 * M, entry: 107, stopLoss: 95, target: 131, exit: 131, r: 2 });
    expect(result.summary.closedTrades).toBe(1);
  });
  it('uses the available close for a delayed C3/C4 boundary confirmation', () => {
    const rows = sourceFixture().slice(0, 30).map((row, index) => index >= 17 ? { ...row, close: 104 } : row);
    for (let i = 30; i < 44; i++) rows.push(candle(i, 104, 108, 100, 105));
    rows.push(candle(44, 105, 108, 100, 107), candle(45, 107, 109, 104, 108), candle(46, 108, 140, 104, 139));
    const result = runBacktest({ candles: rows, higherMinutes: 15, lowerMinutes: 1, instrument: 'TEST' });
    const confirmation = result.events.find(event => event.type === 'confirmed')!;
    const entry = result.events.find(event => event.type === 'entry')!;
    expect(confirmation.time).toBe(T + 45 * M);
    expect(confirmation.availableAt).toBe(T + 46 * M);
    expect(entry).toMatchObject({ time: T + 46 * M, availableAt: T + 46 * M, price: 108 });
    expect(result.trades[0]).toMatchObject({ entry: 108, stopLoss: 95, target: 134, r: 2 });
  });
  it('opt-in full events preserve the default bounded dashboard output and every prefix event', () => {
    const candles = Array.from({ length: 20 }, (_, day) => sourceFixture().map(row => ({ ...row, time: row.time + day * 86_400_000 }))).flat();
    const options = { candles, higherMinutes: 15 as const, lowerMinutes: 1 as const, now: candles.at(-1)!.time + M, instrument: 'TEST' };
    const all = evaluateFractal({ ...options, includeAllEvents: true });
    const bounded = evaluateFractal(options);
    expect(all.events.length).toBeGreaterThan(60);
    expect(bounded.events).toEqual(all.events.slice(-60));
    const prefix = evaluateFractal({ ...options, candles: sourceFixture(), now: T + 30 * M, includeAllEvents: true });
    for (const event of prefix.events) expect(all.events.find(item => item.id === event.id)).toEqual(event);
  });
});
