import { describe, expect, it } from 'vitest';
import { evaluateFractal, type Candle } from '../src/lib/indicator';
import { runFullRuleBacktest } from '../src/lib/full-rule-backtest';
import { runSimpleBacktest } from '../src/lib/simple-backtest';
import { referenceSignals, comparableEvent } from '../scripts/lib/pine-reference.mjs';
const START = Date.parse('2025-01-06T09:15:00+05:30'), M = 60_000;
const bar = (n: number, open: number, high: number, low: number, close: number): Candle => ({ time: START + n * M, open, high, low, close });
const steady = (start: number, count: number, open: number, high: number, low: number, close: number) => Array.from({ length: count }, (_, i) => bar(start + i, open, high, low, close));
const base = (early = false) => [...steady(0, 15, 105, 110, 100, 106), bar(15, 106, 108, 99, 102), bar(16, 102, 104, 95, 100), ...steady(17, 13, 103, 108, 100, early ? 107 : 104)];
const opts = (candles: Candle[]) => ({ candles, higherMinutes: 15 as const, lowerMinutes: 1 as const, instrument: 'TEST' });
const mirror = (rows: Candle[]) => rows.map(r => ({ ...r, open: 220 - r.open, high: 220 - r.low, low: 220 - r.high, close: 220 - r.close }));
describe('restored source lifecycle with post-sweep-only CISD', () => {
  it.each([false, true])('rejects C2/early confirmation; confirms on a later LTF close (bear=%s)', bear => {
    const prefix = bear ? mirror(base(true)) : base(true);
    const before = runFullRuleBacktest(opts(prefix));
    expect(before.events.filter(e => e.type === 'confirmed')).toHaveLength(0);
    const rows = [...base(true), bar(30, 107, 109, 100, 108), bar(31, 108, 110, 100, 109)];
    const result = runFullRuleBacktest(opts(bear ? mirror(rows) : rows));
    expect(result.trades[0]).toMatchObject({ entryTime: START + 31 * M, entry: bear ? 112 : 108, stopLoss: bear ? 125 : 95, target: bear ? 86 : 134, confirmationPhase: 'C3' });
  });
  it('restores C3/C4 expiry instead of taking a later unlimited-wait entry', () => {
    const rows = [...base(), ...steady(30, 45, 104, 108, 100, 105), bar(75, 105, 109, 100, 107), bar(76, 107, 110, 100, 108)];
    expect(runSimpleBacktest(opts(rows)).trades).toHaveLength(1);
    const full = runFullRuleBacktest(opts(rows));
    expect(full.trades).toHaveLength(0);
    expect(full.events.some(e => e.type === 'finished')).toBe(true);
  });
  it('restores the strict pre-entry C2 wick-breach rejection', () => {
    const rows = [...base(), bar(30, 104, 109, 94, 107), bar(31, 107, 110, 100, 108)];
    expect(runSimpleBacktest(opts(rows)).trades).toHaveLength(1);
    expect(runFullRuleBacktest(opts(rows)).trades).toHaveLength(0);
  });
  it('executes the late C3-boundary entry only at its causally available C4 close', () => {
    const rows = [...base(), ...steady(30, 14, 104, 108, 100, 105), bar(44, 105, 108, 100, 107), bar(45, 107, 109, 104, 108), bar(46, 108, 110, 104, 109)];
    const full = runFullRuleBacktest(opts(rows));
    expect(full.trades[0]).toMatchObject({ confirmedAt: START + 45 * M, confirmationAvailableAt: START + 46 * M, entryTime: START + 46 * M, entry: 108, target: 134, confirmationPhase: 'C4' });
  });
  it.each([false, true])('exits a C4-only CISD after a later T-spot invalidation (bear=%s)', bear => {
    const rows = [...base(), ...steady(30, 15, 104, 108, 100, 105), bar(45, 105.5, 108, 104, 107), bar(46, 107, 108, 102, 103), bar(47, 102, 104, 101, 103), bar(48, 108, 132, 100, 130)];
    const candles = bear ? mirror(rows) : rows;
    const full = runFullRuleBacktest(opts(candles));
    expect(full.trades[0]).toMatchObject({ exitReason: 'invalidation', exitTime: START + 47 * M, exit: bear ? 118 : 102, confirmationPhase: 'C4' });
    expect(runSimpleBacktest(opts(candles)).trades[0].r).toBe(2);
  });
  it('does not reinstate the one-position cap when a new C2 replaces a setup', () => {
    const rows = [...base(), ...steady(30, 15, 107, 108, 100, 107), ...steady(45, 15, 107, 108, 99, 107), bar(60, 107, 109, 100, 108), bar(61, 108, 110, 100, 109)];
    const result = runFullRuleBacktest(opts(rows));
    expect(result.trades).toHaveLength(2); expect(result.maxConcurrentPositions).toBe(2);
    expect(result.trades.every(t => t.status === 'open')).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });
  it('records C1 and both T-spots without inventing entries for those drawings', () => {
    const rows = [...base(), ...steady(30, 15, 104, 108, 100, 105), ...steady(45, 15, 105.5, 108, 104, 107)];
    const result = runFullRuleBacktest(opts(rows));
    expect(result.signals[0]).toMatchObject({ c1: { time: START, high: 110, low: 100 }, c3Tspot: { top: 104, bottom: 101.5 }, c4Tspot: { top: 105.5, bottom: 104 } });
    expect(result.trades).toHaveLength(1); expect(result.trades[0].confirmationPhase).toBe('C4');
  });
  it.each([[60, 5], [30, 3], [15, 1]] as const)('matches a separate per-C2 source model on seeded %i/%i paths', (higherMinutes, lowerMinutes) => {
    let seed = 42, price = 1000;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const candles = Array.from({ length: 1125 }, (_, n) => {
      const open = Math.round(price + (random() - 0.5) * 5), close = Math.round(open + (random() - 0.5) * 16); price = close;
      return { time: START + Math.floor(n / 375) * 86400000 + n % 375 * M, open, high: Math.max(open, close) + Math.floor(random() * 6), low: Math.min(open, close) - Math.floor(random() * 6), close };
    });
    const settings = { candles, higherMinutes, lowerMinutes, instrument: 'TEST', postSweepOnly: true };
    const actual = evaluateFractal({ ...settings, now: candles.at(-1)!.time + M, includeAllEvents: true });
    const reference = referenceSignals(settings);
    const normalized = (events: typeof actual.events) => events.map(e => ({ id: e.id, ...comparableEvent(e) })).sort((a, b) => a.id.localeCompare(b.id));
    expect(normalized(actual.events)).toEqual(normalized(reference.events));
  });
});
