import { describe, expect, it } from 'vitest';
import { evaluateFractal, type Candle, type FractalOptions } from '../src/lib/indicator';
import { comparableEvent, referenceSignals } from '../scripts/lib/pine-reference.mjs';

const M = 60_000, START = Date.parse('2025-01-06T09:15:00+05:30');
function generatedCandles(seed: number): Candle[] {
  let state = seed, price = 1000;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  return Array.from({ length: 3 * 375 }, (_, n) => {
    const open = Math.round(price + (random() - 0.5) * (n % 375 === 0 ? 40 : 5));
    const close = n % 11 === 0 ? open : Math.round(open + (random() - 0.5) * 16);
    price = close;
    return { time: START + Math.floor(n / 375) * 86400000 + n % 375 * M,
      open, high: Math.max(open, close) + Math.floor(random() * 6), low: Math.min(open, close) - Math.floor(random() * 6), close };
  });
}
const sorted = (events: ReturnType<typeof evaluateFractal>['events']) => events.map(e => ({ id: e.id, ...comparableEvent(e) })).sort((a, b) => a.id.localeCompare(b.id));

describe('deep review: independent Pine-series and per-C2 reference', () => {
  it.each([false, true])('retains the Pine level learned inside the initial warm-up HTF (bearish=%s)', bearish => {
    const bar = (n: number, open: number, high: number, low: number, close: number): Candle => ({ time: START + n * M, open, high, low, close });
    const rows = [bar(0, 105, 110, 100, 106), bar(1, 106, 108, 99, 102), bar(2, 102, 104, 95, 100),
      ...Array.from({ length: 12 }, (_, i) => bar(i + 3, 100, 105, 99, 104)),
      ...Array.from({ length: 15 }, (_, i) => bar(i + 15, 100, 105, 94, 104)), bar(30, 104, 108, 99, 107),
      ...Array.from({ length: 14 }, (_, i) => bar(i + 31, 107, 108, 99, 107))];
    const candles = bearish ? rows.map(r => ({ ...r, open: 220 - r.open, high: 220 - r.low, low: 220 - r.high, close: 220 - r.close })) : rows;
    const settings = { candles, higherMinutes: 15 as const, lowerMinutes: 1 as const, instrument: 'TEST' };
    const reference = referenceSignals(settings);
    const actual = evaluateFractal({ ...settings, now: candles.at(-1)!.time + M, includeAllEvents: true });
    expect(reference.signals[0].fixed.price).toBe(bearish ? 114 : 106);
    expect(actual.cisdLevel).toBe(bearish ? 114 : 106);
    expect(actual.entry).toBe(bearish ? 113 : 107);
    expect(sorted(actual.events)).toEqual(sorted(reference.events));
  });
  for (const [higherMinutes, lowerMinutes] of [[60, 5], [30, 3], [15, 1]] as const) {
    it.each([1, 7, 42, 103, 9001, 654321])(`matches every signal transition on seeded OHLC, ${higherMinutes}/${lowerMinutes}, seed %i`, seed => {
      const candles = generatedCandles(seed);
      const settings = { candles, higherMinutes, lowerMinutes, instrument: 'TEST' };
      const reference = referenceSignals(settings);
      const formations: Parameters<NonNullable<FractalOptions['onSetupFormation']>>[0][] = [];
      const actual = evaluateFractal({ ...settings, now: candles.at(-1)!.time + M, includeAllEvents: true, onSetupFormation: formation => formations.push(formation) });
      expect(reference.signals.length).toBeGreaterThan(0);
      expect(sorted(actual.events)).toEqual(sorted(reference.events));
      expect(formations).toEqual(reference.signals.map(signal => ({ signalId: signal.signalId, cisdLevel: signal.fixed.price,
        levelAt: signal.fixed.index === null ? null : reference.lower[signal.fixed.index].time, alreadyReclaimed: signal.fixed.reclaimed })));
    });
  }
});
