import { describe, expect, it } from 'vitest';
import { evaluateSimpleStrategy, type SimpleSetup } from '../src/lib/simple-strategy';
import { runSimpleBacktest, simulateSimpleSetups, summarizeIndependentTrades } from '../src/lib/simple-backtest';
import type { Candle } from '../src/lib/indicator';
const START = Date.parse('2025-01-06T09:15:00+05:30'), M = 60_000;
const bar = (n: number, open: number, high: number, low: number, close: number): Candle => ({ time: START + n * M, open, high, low, close });
const steady = (start: number, count: number, open: number, high: number, low: number, close: number) => Array.from({ length: count }, (_, i) => bar(start + i, open, high, low, close));
const base = (early = false) => [...steady(0, 15, 105, 110, 100, 106), bar(15, 106, 108, 99, 102), bar(16, 102, 104, 95, 100), ...steady(17, 13, 103, 108, 100, early ? 107 : 104)];
const evaluate = (candles: Candle[]) => evaluateSimpleStrategy({ candles, higherMinutes: 15, lowerMinutes: 1, instrument: 'TEST', now: candles.at(-1)!.time + M, includeAllEvents: true });
const mirrored = (rows: Candle[]) => rows.map(r => ({ ...r, open: 220 - r.open, high: 220 - r.low, low: 220 - r.high, close: 220 - r.close }));

describe('current simplified strategy', () => {
  it.each([false, true])('ignores early CISD and requires a later closed candle (bearish=%s)', bear => {
    const prefix = bear ? mirrored(base(true)) : base(true);
    expect(evaluate(prefix).events.map(e => e.type)).toEqual(['formed']);
    const rows = [...base(true), bar(30, 107, 109, 100, 108)];
    const result = evaluate(bear ? mirrored(rows) : rows);
    expect(result.signals[0]).toMatchObject({ formedAt: START + 30 * M, confirmedAt: START + 31 * M, entry: bear ? 112 : 108, stopLoss: bear ? 125 : 95, target: bear ? 86 : 134 });
  });
  it('uses strict close-beyond, not an intrabar touch or equality', () => {
    const rows = [...base(), bar(30, 104, 109, 100, 106), bar(31, 106, 109, 100, 107)];
    expect(evaluate(rows.slice(0, -1)).entry).toBeNull();
    expect(evaluate(rows).entryAt).toBe(START + 32 * M);
  });
  it('has no C3/C4 time limit, and replacement does not cancel older sweeps', () => {
    const rows = [...base(), ...steady(30, 45, 104, 108, 100, 105), bar(75, 105, 109, 100, 107)];
    const result = evaluate(rows);
    expect(result.signals[0].entryAt).toBe(START + 76 * M);
    expect(result.events.some(e => e.type === 'finished')).toBe(false);
  });
  it('retains two same-direction pending sweeps and confirms both independently', () => {
    const rows = [...base(), ...steady(30, 15, 104, 108, 94, 105), bar(45, 105, 109, 100, 107)];
    const result = evaluate(rows);
    const entries = result.signals.filter(s => s.entryAt !== null);
    expect(entries).toHaveLength(2);
    expect(entries.map(s => s.stopLoss)).toEqual([95, 94]);
    expect(entries.every(s => s.entryAt === START + 46 * M)).toBe(true);
  });
  it('does not apply a pre-entry wick invalidation or use its earlier wick as a trade exit', () => {
    const result = evaluate([...base(), bar(30, 104, 109, 90, 107)]);
    expect(result.entry).toBe(107); expect(result.stopLoss).toBe(95);
    expect(result.events.some(e => e.type === 'invalidated')).toBe(false);
  });
  it('gap handling resets unknown pending signals with causal availability', () => {
    const result = evaluate([...base(), bar(32, 104, 109, 100, 107)]);
    expect(result.signals[0].entry).toBeNull();
    expect(result.events.find(e => e.type === 'invalidated')?.availableAt).toBe(START + 33 * M);
  });
  it('keeps event prefixes stable and ignores future/unclosed candles', () => {
    const rows = [...base(), bar(30, 104, 109, 100, 107), ...steady(31, 50, 107, 109, 99, 105)];
    const full = evaluate(rows);
    for (let n = 30; n <= rows.length; n++) for (const e of evaluate(rows.slice(0, n)).events) expect(full.events.find(f => f.id === e.id)).toEqual(e);
    expect(evaluateSimpleStrategy({ candles: rows, higherMinutes: 15, lowerMinutes: 1, now: START + 30 * M, instrument: 'TEST', includeAllEvents: true }).events).toEqual(evaluate(base()).events);
  });
  it.each([[60, 5], [30, 3], [15, 1]] as const)('confirms only after HTF closure for %i/%i', (higherMinutes, lowerMinutes) => {
    const count = higherMinutes / lowerMinutes;
    const lower = [...steady(0, count, 105, 110, 100, 106), bar(count, 106, 108, 99, 102), bar(count + 1, 102, 104, 95, 100), ...steady(count + 2, count - 2, 103, 108, 100, 107), bar(count * 2, 107, 109, 100, 108)];
    const candles = lower.flatMap((r, i) => Array.from({ length: lowerMinutes }, (_, j) => ({ ...r, time: START + (i * lowerMinutes + j) * M })));
    const result = evaluateSimpleStrategy({ candles, higherMinutes, lowerMinutes, instrument: 'TEST', now: candles.at(-1)!.time + M });
    expect(result.entryAt).toBe(START + (2 * higherMinutes + lowerMinutes) * M);
  });
});

function signal(id = 'a', bull = true, entryAt = START + M): SimpleSetup {
  return { signalId: id, direction: bull ? 'bullish' : 'bearish', status: bull ? 'confirmed_bullish' : 'confirmed_bearish', c2At: START - 30 * M, formedAt: START - 15 * M,
    c2Extreme: bull ? 96 : 104, stopLoss: bull ? 96 : 104, cisdLevel: bull ? 99 : 101, levelAt: START - 20 * M,
    entry: 100, target: bull ? 108 : 92, confirmedAt: entryAt, entryAt, reason: 'fixture' };
}
const simulate = (candles: Candle[], signals: SimpleSetup[], extra = {}) => simulateSimpleSetups({ candles, signals, higherMinutes: 15, lowerMinutes: 1, ...extra });
describe('independent 2R position execution', () => {
  it('defaults to daily exit; overnight carry must be requested explicitly', () => {
    const candles = [...base(true), ...steady(30, 345, 107, 108, 100, 107), { ...bar(0, 90, 94, 89, 91), time: START + 86400000 }];
    const options = { candles, higherMinutes: 15 as const, lowerMinutes: 1 as const };
    const daily = runSimpleBacktest(options), carry = runSimpleBacktest({ ...options, holdingMode: 'carry' });
    expect(daily.holdingMode).toBe('daily_exit');
    expect(daily.trades[0]).toMatchObject({ exitTime: START + 375 * M, exitReason: 'session_close', r: 0 });
    expect(carry.trades[0]).toMatchObject({ exitTime: START + 86400000, exitReason: 'stop_gap', exit: 90 });
  });
  it('rejects contradictory carry and daily-exit settings', () => {
    expect(() => runSimpleBacktest({ candles: [], higherMinutes: 15, lowerMinutes: 1, holdingMode: 'carry', sessionExitMinutes: 930 })).toThrow('holding-mode');
  });
  it('allows simultaneous opposite and overlapping same-direction entries', () => {
    const result = simulate([bar(0, 100, 102, 98, 100), bar(1, 100, 102, 98, 100), bar(2, 100, 110, 98, 109)], [signal('a'), signal('b', false), signal('c', true, START + 2 * M)]);
    expect(result.trades).toHaveLength(3); expect(result.skipped).toHaveLength(0);
    expect(result.maxConcurrentPositions).toBe(3);
    expect(result.trades.map(t => t.r)).toEqual([2, -1, 2]);
  });
  it('deduplicates a signal but does not deduplicate distinct sweeps at the same time', () => {
    const result = simulate([bar(0, 100, 102, 98, 100), bar(1, 100, 110, 98, 109)], [signal('a'), signal('a'), signal('b')]);
    expect(result.trades).toHaveLength(2);
  });
  it('ignores the entry candle path and uses stop first for later intraminute ambiguity', () => {
    const result = simulate([bar(0, 100, 120, 90, 100), bar(1, 100, 110, 94, 100)], [signal()]);
    expect(result.trades[0]).toMatchObject({ r: -1, exitTime: START + 2 * M, ambiguousBar: true });
  });
  it('carries overnight with an adverse opening gap greater than 1R', () => {
    const last = START + 375 * M;
    const rows = [{ ...bar(0, 100, 102, 98, 100), time: last - M }, { ...bar(0, 90, 94, 89, 91), time: START + 86400000 }];
    expect(simulate(rows, [signal('a', true, last)]).trades[0]).toMatchObject({ exit: 90, exitReason: 'stop_gap', r: -2.5 });
  });
  it('daily mode exits at session close and rejects new close entries there', () => {
    const end = START + 375 * M;
    const rows = [{ ...bar(0, 100, 102, 98, 100), time: end - 2 * M }, { ...bar(0, 100, 106, 98, 105), time: end - M }];
    const result = simulate(rows, [signal('a', true, end - M), { ...signal('b', true, end), entry: 105, target: 123 }], { sessionExitMinutes: 930, testEnd: end + M });
    expect(result.trades[0]).toMatchObject({ exitReason: 'session_close', exit: 105, r: 1.25 });
    expect(result.skipped[0].reason).toBe('outside_execution_session');
  });
  it('a missing path leaves only that position unresolved; later independent signals may trade', () => {
    const result = simulate([bar(0, 100, 102, 98, 100), bar(2, 100, 102, 98, 100), bar(3, 100, 109, 98, 108)], [signal(), signal('b', true, START + 3 * M)]);
    expect(result.trades.map(t => t.status)).toEqual(['unresolved', 'closed']);
    expect(result.trades[1].r).toBe(2);
  });
  it('retains a year-end open trade without invented realized P&L', () => {
    const result = simulate([bar(0, 100, 102, 98, 100), bar(1, 100, 102, 98, 101)], [signal()]);
    expect(result.trades[0]).toMatchObject({ status: 'open', r: null, exit: null });
  });
  it('groups simultaneous exits for realized drawdown instead of arbitrary signal ordering', () => {
    const result = simulate([bar(0, 100, 102, 98, 100), bar(1, 100, 110, 98, 109)], [signal('a'), signal('b', false)]);
    expect(summarizeIndependentTrades(result.trades).maxDrawdownR).toBe(0);
  });
});
