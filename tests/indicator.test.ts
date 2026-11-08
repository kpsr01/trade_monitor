import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { aggregateCandles, evaluateFractal, findCisdLevel, type Candle, type FractalOptions } from '../src/lib/indicator';

const START = Date.parse('2026-11-06T09:15:00+05:30');
const M = 60_000;
const candle = (index: number, open: number, high: number, low: number, close: number): Candle => ({ time: START + index * M, open, high, low, close });
const steady = (start: number, count: number, open: number, high: number, low: number, close: number) => Array.from({ length: count }, (_, i) => candle(start + i, open, high, low, close));
function bullish(early = true) {
  return [
    ...steady(0, 15, 105, 110, 100, 106), // C1 [100,110]
    candle(15, 106, 108, 99, 102), // down after up => fixed CISD 106
    candle(16, 102, 104, 95, 100), // lower wick, same directional-run open 106
    ...steady(17, 13, 103, 108, 100, early ? 107 : 104), // C2 sweep/reclaim
  ];
}
const options = (candles: Candle[], extra: Partial<FractalOptions> = {}): FractalOptions => ({ candles, higherMinutes: 15, lowerMinutes: 1, now: (candles.at(-1)?.time ?? START) + M, instrument: 'TEST', ...extra });
const evaluate = (candles: Candle[], extra: Partial<FractalOptions> = {}) => evaluateFractal(options(candles, extra));
function mirror(rows: Candle[]) { return rows.map(c => ({ ...c, open: 220 - c.open, high: 220 - c.low, low: 220 - c.high, close: 220 - c.close })); }

describe('source-derived C2 / CISD cases (Pine source, not a TradingView runtime)', () => {
  it('pins the exact reference snapshot and the original strict C2 predicates', () => {
    const source = readFileSync('reference/openSourceFractal.pine');
    const metadata = JSON.parse(readFileSync('reference/source.json', 'utf8'));
    expect(createHash('sha256').update(source).digest('hex')).toBe(metadata.sha256);
    expect(source.toString()).toContain('c2Buy         = currentL < prevL1 and currentC > prevL1');
    expect(source.toString()).toContain('c2Sell        = currentH > prevH1 and currentC < prevH1');
  });
  it('selects the open of a down run after an up candle, not the prior high', () => {
    expect(findCisdLevel([candle(0, 105, 110, 100, 106), candle(1, 106, 108, 99, 102)], true)).toEqual({ price: 106, index: 1 });
  });
  it('walks back a directional run and uses its highest bearish open', () => {
    const rows = [candle(0, 105, 110, 100, 106), candle(1, 106, 108, 99, 102), candle(2, 102, 104, 95, 100)];
    expect(findCisdLevel(rows, true)).toEqual({ price: 106, index: 1 });
    expect(findCisdLevel(mirror(rows), false)).toEqual({ price: 114, index: 1 });
  });
  it('handles dojis exactly: two adjacent dojis are not a fresh run', () => {
    expect(findCisdLevel([candle(0, 105, 110, 100, 105), candle(1, 105, 108, 99, 105)], true)).toBeNull();
    expect(findCisdLevel([candle(0, 105, 110, 100, 106), candle(1, 106, 108, 99, 106)], true)?.price).toBe(106);
  });
  it('will not search beyond the original ten-bar bound', () => {
    const rows = [candle(0, 109, 112, 100, 110), ...steady(1, 11, 109, 110, 99, 108)];
    expect(findCisdLevel(rows, true)).toBeNull();
  });
  it('requires a strict sweep and strict close reclaim', () => {
    const touch = [...steady(0, 15, 105, 110, 100, 106), ...steady(15, 15, 104, 108, 100, 105)];
    expect(evaluate(touch).status).toBe('no_setup');
    const equality = [...steady(0, 15, 105, 110, 100, 106), ...steady(15, 15, 104, 108, 95, 100)];
    expect(evaluate(equality).status).toBe('no_setup');
  });
  it('confirms early CISD only when C2 closes and enters at that available close', () => {
    const result = evaluate(bullish());
    expect(result.status).toBe('confirmed_bullish');
    expect(result.cisdLevel).toBe(106);
    expect(result.c2Extreme).toBe(95);
    expect(result.confirmedAt).toBe(START + 30 * M);
    expect(result.entry).toBe(107);
    expect(result.entryAt).toBe(START + 30 * M);
    expect(result.events.find(e => e.type === 'entry')?.availableAt).toBe(START + 30 * M);
    expect(result.events.filter(e => e.type === 'confirmed')).toHaveLength(1);
  });
  it('records the confirmation close, exact directional C2 stop, and exactly 2R', () => {
    const rows = [...bullish(), candle(30, 108, 109, 100, 108)];
    const result = evaluate(rows);
    expect(result.entry).toBe(107);
    expect(result.stopLoss).toBe(95);
    expect(result.target).toBe(131);
    expect(result.entryAt).toBe(START + 30 * M);
    const bear = evaluate(mirror(rows));
    expect(bear.status).toBe('confirmed_bearish');
    expect(bear.entry).toBe(113);
    expect(bear.stopLoss).toBe(125);
    expect(bear.target).toBe(89);
  });
  it('preserves the exact quoted C2 extreme without any buffer or tick rounding', () => {
    const rows = bullish();
    rows[16] = candle(16, 102, 104, 95.0137, 100);
    const result = evaluate(rows);
    expect(result.stopLoss).toBe(95.0137);
    expect(result.target).toBeCloseTo(130.9726, 8);
    expect(evaluate(mirror(rows)).stopLoss).toBe(220 - 95.0137);
  });
  it('does not confirm on a close equal to CISD', () => {
    const rows = [...bullish(false), candle(30, 104, 108, 100, 106)];
    expect(evaluate(rows).status).toBe('forming');
    const result = evaluate([...rows, candle(31, 106, 108, 100, 107)]);
    expect(result.status).toBe('confirmed_bullish');
    expect(result.confirmedAt).toBe(START + 32 * M);
    expect(result.entry).toBe(107);
    expect(result.entryAt).toBe(START + 32 * M);
    expect(result.events.find(e => e.type === 'confirmed')?.price).toBe(106);
    expect(result.events.find(e => e.type === 'entry')?.price).toBe(107);
  });
  it('retains confirmation and entry events when a later candle breaches C2', () => {
    const result = evaluate([...bullish(), candle(30, 108, 109, 94, 104)]);
    expect(result.status).toBe('invalidated');
    expect(result.events.map(e => e.type)).toEqual(['formed', 'confirmed', 'entry', 'invalidated']);
    expect(result.events.find(e => e.type === 'invalidated')?.time).toBe(START + 31 * M);
  });
  it('a wick equal to the C2 extreme does not invalidate', () => {
    expect(evaluate([...bullish(), candle(30, 108, 109, 95, 104)]).status).toBe('confirmed_bullish');
  });
  it('invalidates a gap through C2 without claiming an entry', () => {
    const result = evaluate([...bullish(false), candle(30, 94, 104, 93, 103)]);
    expect(result.status).toBe('invalidated');
    expect(result.events.some(e => e.type === 'entry')).toBe(false);
  });
  it('retains an earlier CISD after C4 box invalidation', () => {
    const rows = [...bullish(), ...steady(30, 15, 107, 108, 100, 105), candle(45, 105.5, 106, 102, 103)];
    const result = evaluate(rows);
    expect(result.phase).toBe('C4');
    expect(result.c4Invalid).toBe(true);
    expect(result.status).toBe('confirmed_bullish');
    expect(result.events.some(e => e.type === 'invalidated')).toBe(false);
  });
  it('invalidates the whole setup if CISD first confirms in C4, retaining history', () => {
    const rows = [...bullish(false), ...steady(30, 15, 104, 108, 100, 105), candle(45, 105.5, 108, 104, 107), candle(46, 107, 108, 104, 107), candle(47, 107, 108, 102, 103)];
    const result = evaluate(rows);
    expect(result.status).toBe('invalidated');
    expect(result.c4Invalid).toBe(true);
    expect(result.events.find(e => e.type === 'confirmed')?.time).toBe(START + 46 * M);
    expect(result.events.find(e => e.type === 'invalidated')?.reason).toContain('C4 T-spot');
  });
  it('finishes after C3 and C4 rather than showing an old signal forever', () => {
    const rows = [...bullish(), ...steady(30, 30, 107, 108, 100, 107)];
    expect(evaluate(rows).status).toBe('no_setup');
    expect(evaluate(rows).phase).toBe('finished');
  });
  it('does not backdate a final C3 close before the C4-open T-spot is known', () => {
    const rows = [...bullish(false), ...steady(30, 14, 104, 108, 100, 105), candle(44, 105, 108, 100, 107)];
    const prefix = evaluate(rows);
    expect(prefix.status).toBe('forming');
    const result = evaluate([...rows, candle(45, 107, 109, 104, 108)]);
    expect(result.phase).toBe('C4');
    expect(result.status).toBe('confirmed_bullish');
    expect(result.confirmedAt).toBe(START + 45 * M);
    expect(result.events.find(e => e.type === 'confirmed')?.availableAt).toBe(START + 46 * M);
    expect(result.entryAt).toBe(START + 46 * M);
    expect(result.entry).toBe(108);
    expect(result.events.find(e => e.type === 'entry')?.availableAt).toBe(START + 46 * M);
    for (const event of prefix.events) expect(result.events.find(e => e.id === event.id)).toEqual(event);
  });
  it.each([false, true])('rejects a close entry if its candle already breached C2 (bearish=%s)', bearish => {
    const rows = [...bullish(false), candle(30, 104, 109, 94, 107)];
    const result = evaluate(bearish ? mirror(rows) : rows);
    expect(result.status).toBe('invalidated');
    expect(result.events.some(e => e.type === 'entry')).toBe(false);
    expect(result.events.some(e => e.type === 'confirmed')).toBe(false);
  });
  it('allows a confirming candle to touch the exact C2 stop before its close entry', () => {
    const result = evaluate([...bullish(false), candle(30, 104, 109, 95, 107)]);
    expect(result.entry).toBe(107);
    expect(result.stopLoss).toBe(95);
    expect(result.entryAt).toBe(START + 31 * M);
  });
  it('rejects a delayed boundary entry when the first available candle breaches C2', () => {
    const rows = [...bullish(false), ...steady(30, 14, 104, 108, 100, 105), candle(44, 105, 108, 100, 107), candle(45, 107, 109, 94, 108)];
    const result = evaluate(rows);
    expect(result.status).toBe('invalidated');
    expect(result.events.some(e => e.type === 'confirmed')).toBe(false);
    expect(result.events.some(e => e.type === 'entry')).toBe(false);
  });
  it('rejects a delayed boundary entry if its first available close invalidates the C4 T-spot', () => {
    const rows = [...bullish(false), ...steady(30, 14, 104, 108, 100, 105), candle(44, 105, 108, 100, 107), candle(45, 107, 108, 102, 103)];
    const result = evaluate(rows);
    expect(result.status).toBe('invalidated');
    expect(result.events.find(e => e.type === 'invalidated')?.reason).toContain('C4 T-spot');
    expect(result.events.some(e => e.type === 'entry')).toBe(false);
  });
  it('keeps both directional setups when a higher candle sweeps both sides', () => {
    const rows = bullish(false);
    rows[20] = candle(20, 104, 115, 100, 104);
    const result = evaluate(rows);
    expect(result.events.filter(e => e.type === 'formed').map(e => e.direction).sort()).toEqual(['bearish', 'bullish']);
  });
  it.each([false, true])('preserves the source quirk: a pre-confirmation C4 flag does not block later CISD (bearish=%s)', bearish => {
    const rows = [...bullish(false), ...steady(30, 15, 104, 108, 100, 103), candle(45, 105.5, 108, 104, 107), candle(46, 107, 108, 102, 103)];
    const result = evaluate(bearish ? mirror(rows) : rows);
    expect(result.c4Invalid).toBe(true);
    expect(result.status).toBe(bearish ? 'confirmed_bearish' : 'confirmed_bullish');
    expect(result.entry).toBe(bearish ? 113 : 107);
    expect(result.events.some(e => e.type === 'invalidated')).toBe(false);
    expect(result.reason).toContain('after the C4 T-spot flag');
  });
});

describe('causality, candle availability, independent intervals', () => {
  it('ignores incomplete and future candles entirely', () => {
    const rows = [...bullish(), candle(30, 108, 109, 94, 104)];
    const now = START + 30 * M + 20_000;
    expect(evaluate(rows, { now })).toEqual(evaluate(rows.slice(0, 30), { now }));
  });
  it('stable IDs deduplicate replays and duplicate input rows', () => {
    const rows = [...bullish(), candle(30, 108, 109, 100, 108)];
    expect(evaluate([...rows, ...rows])).toEqual(evaluate(rows));
    expect(new Set(evaluate(rows).events.map(e => e.id)).size).toBe(evaluate(rows).events.length);
  });
  it('does not rewrite already emitted events when future candles arrive', () => {
    const prefix = bullish();
    const before = evaluate(prefix);
    const after = evaluate([...prefix, candle(30, 108, 109, 94, 104)]);
    for (const event of before.events) expect(after.events.find(e => e.id === event.id)).toEqual(event);
  });
  it('preserves each prefix event across C3/C4 boundaries and a later missing bar', () => {
    const rows = [...bullish(false), ...steady(30, 15, 104, 108, 100, 105), candle(45, 105.5, 108, 104, 107), candle(46, 107, 108, 104, 107), candle(47, 107, 108, 102, 103), candle(50, 107, 108, 100, 107)];
    const full = evaluate(rows);
    for (let length = 1; length <= rows.length; length++) {
      for (const event of evaluate(rows.slice(0, length)).events) expect(full.events.find(e => e.id === event.id)).toEqual(event);
    }
  });
  it('retains the session-end close entry across the expected overnight gap', () => {
    const rows = bullish().map(c => ({ ...c, time: c.time + 345 * M }));
    const prefix = evaluate(rows);
    const nextDay = { ...candle(0, 108, 109, 100, 108), time: START + 3 * 1440 * M }; // Friday -> Monday
    const result = evaluate([...rows, nextDay]);
    expect(result.entryAt).toBe(START + 375 * M);
    expect(result.events.find(e => e.type === 'entry')?.availableAt).toBe(START + 375 * M);
    for (const event of prefix.events) expect(result.events.find(e => e.id === event.id)).toEqual(event);
  });
  it('resets over a missing intraday candle, instead of creating false adjacent bars', () => {
    const rows = bullish(false);
    const result = evaluate([...rows, candle(32, 108, 109, 100, 108)]);
    expect(result.status).toBe('no_setup');
    expect(result.events.at(-1)?.reason).toContain('Missing candles');
    // The reset cannot be available before the first post-gap candle closes.
    expect(result.events.at(-1)?.availableAt).toBe(START + 33 * M);
    expect(result.events.some(e => e.type === 'entry')).toBe(false);
  });
  it('requires complete minute groups and clips the last hourly candle at 15:30 IST', () => {
    const day = steady(0, 375, 100, 101, 99, 100);
    const hourly = aggregateCandles(day, 60, START + 375 * M);
    expect(hourly).toHaveLength(7);
    expect(hourly.at(-1)?.time).toBe(START + 360 * M);
    expect(hourly.at(-1)?.closeTime).toBe(START + 375 * M);
    expect(aggregateCandles(day.filter((_, i) => i !== 61), 60, START + 375 * M)).toHaveLength(6);
  });
  it.each([[60, 5], [30, 3], [15, 1]] as const)('evaluates %i→%i without shared mutable state', (higherMinutes, lowerMinutes) => {
    const rows = steady(0, 375, 100, 101, 99, 100);
    const result = evaluate(rows, { higherMinutes, lowerMinutes });
    expect(result.status).toBe('no_setup');
    expect(result.higherMinutes).toBe(higherMinutes);
    expect(result.lowerMinutes).toBe(lowerMinutes);
    expect(evaluate(bullish()).status).toBe('confirmed_bullish');
  });
  it.each([[60, 5], [30, 3], [15, 1]] as const)('detects both directions with real aggregated %i→%i entry timing', (higherMinutes, lowerMinutes) => {
    const count = higherMinutes / lowerMinutes;
    const bars = [
      ...steady(0, count, 105, 110, 100, 106),
      candle(count, 106, 108, 99, 102), candle(count + 1, 102, 104, 95, 100),
      ...steady(count + 2, count - 2, 103, 108, 100, 107), candle(2 * count, 108, 109, 100, 108),
    ];
    const minutes = bars.flatMap((bar, index) => Array.from({ length: lowerMinutes }, (_, offset) => offset === 0
      ? { ...bar, time: START + (index * lowerMinutes + offset) * M }
      : candle(index * lowerMinutes + offset, bar.close, bar.close, bar.close, bar.close)));
    for (const bearish of [false, true]) {
      const result = evaluate(bearish ? mirror(minutes) : minutes, { higherMinutes, lowerMinutes });
      expect(result.status).toBe(bearish ? 'confirmed_bearish' : 'confirmed_bullish');
      expect(result.confirmedAt).toBe(START + 2 * higherMinutes * M);
      expect(result.entryAt).toBe(START + 2 * higherMinutes * M);
      expect(result.events.find(e => e.type === 'entry')?.availableAt).toBe(START + 2 * higherMinutes * M);
      expect(result.entry).toBe(bearish ? 113 : 107);
      expect(result.stopLoss).toBe(bearish ? 125 : 95);
      expect(result.target).toBe(bearish ? 89 : 131);
    }
  });
  it('rejects inconsistent duplicates and malformed prices', () => {
    expect(() => evaluate([candle(0, 100, 101, 99, 100), candle(0, 100, 102, 99, 100)])).toThrow('Conflicting');
    expect(() => evaluate([candle(0, 100, 99, 98, 100)])).toThrow('Malformed');
  });
});
