import { aggregateCandles, evaluateFractal, type FractalOptions } from './indicator';
import { simulateSimpleSetups, type SimpleBacktestOptions } from './simple-backtest';
import type { SimpleSetup } from './simple-strategy';

export interface FullRuleSetup extends SimpleSetup {
  confirmationAvailableAt: number | null;
  confirmationPhase: 'C3' | 'C4' | null;
  c1: { time: number; high: number; low: number } | null;
  c3Tspot: { availableAt: number; top: number; bottom: number } | null;
  c4Tspot: { availableAt: number; top: number; bottom: number } | null;
}

/** Current comparison: restore Pine lifecycle, keep post-sweep CISD, independent
 * positions and daily exits. The C1 reference and T-spots are context/zones;
 * only a confirmed C2/CISD creates an entry. No visual creates extra orders.
 */
export function runFullRuleBacktest(options: SimpleBacktestOptions) {
  if (options.holdingMode === 'carry') throw new Error('This comparison requires daily exit.');
  let now = 0; for (const r of options.candles) now = Math.max(now, r.time + 60_000);
  const levels = new Map<string, Parameters<NonNullable<FractalOptions['onSetupFormation']>>[0]>();
  const indicator = evaluateFractal({ ...options, now, instrument: options.instrument ?? '^NSEI', includeAllEvents: true,
    postSweepOnly: true, onSetupFormation: s => levels.set(s.signalId, s) });
  const bySignal = new Map<string, typeof indicator.events>();
  for (const e of indicator.events) { const events = bySignal.get(e.signalId) ?? []; events.push(e); bySignal.set(e.signalId, events); }
  const higher = aggregateCandles(options.candles, options.higherMinutes, now, options.sessionOverrides);
  const lower = aggregateCandles(options.candles, options.lowerMinutes, now, options.sessionOverrides);
  const higherIndex = new Map(higher.map((r, i) => [r.time, i])), lowerAtOpen = new Map(lower.map(r => [r.time, r]));
  const signals: FullRuleSetup[] = [];
  for (const [signalId, events] of bySignal) {
    const formed = events.find(e => e.type === 'formed'); if (!formed) continue;
    const c2At = Number(signalId.split(':').at(-2)), h = higherIndex.get(c2At)!;
    const c1 = higher[h - 1], c2 = higher[h], c3 = higher[h + 1], c4 = higher[h + 2];
    const entry = events.find(e => e.type === 'entry'), confirmation = events.find(e => e.type === 'confirmed');
    const invalid = events.find(e => e.type === 'invalidated'), finished = events.find(e => e.type === 'finished');
    const bull = formed.direction === 'bullish', stop = formed.price!, price = entry?.price ?? null;
    const tspot = (previous: typeof c2, current: typeof c2 | undefined) => {
      const first = current ? lowerAtOpen.get(current.time) : null;
      return first ? { availableAt: first.closeTime, top: Math.max(first.open, (previous.high + previous.low) / 2), bottom: Math.min(first.open, (previous.high + previous.low) / 2) } : null;
    };
    signals.push({ signalId, direction: formed.direction, c2At, formedAt: formed.time, c2Extreme: stop, stopLoss: stop,
      cisdLevel: levels.get(signalId)?.cisdLevel ?? null, levelAt: levels.get(signalId)?.levelAt ?? null,
      entry: price, entryAt: entry?.time ?? null, confirmedAt: confirmation?.time ?? null,
      confirmationAvailableAt: confirmation?.availableAt ?? null,
      target: price === null ? null : price + (bull ? 2 : -2) * Math.abs(price - stop),
      status: invalid ? 'invalidated' : confirmation ? bull ? 'confirmed_bullish' : 'confirmed_bearish' : 'forming',
      reason: invalid?.reason ?? finished?.reason ?? entry?.reason ?? formed.reason,
      confirmationPhase: !confirmation ? null : c3 && confirmation.availableAt > c3.closeTime ? 'C4' : 'C3',
      c1: c1 ? { time: c1.time, high: c1.high, low: c1.low } : null,
      // Retrospective research metadata with explicit availability. These values
      // never feed execution; the source engine above computes zones causally.
      c3Tspot: tspot(c2, c3), c4Tspot: c3 ? tspot(c3, c4) : null });
  }
  const result = simulateSimpleSetups({ ...options, sessionExitMinutes: options.sessionExitMinutes ?? options.executionEndMinutes ?? 930,
    signals: signals.map(s => ({ ...s, confirmationAvailableAt: s.confirmationAvailableAt ?? undefined })), signalTiming: 'source_available_close', invalidationEvents: indicator.events });
  const phaseBySignal = new Map(signals.map(s => [s.signalId, s.confirmationPhase]));
  return { strategy: 'full-lifecycle-post-sweep', holdingMode: 'daily_exit', higherMinutes: options.higherMinutes, lowerMinutes: options.lowerMinutes,
    signals, events: indicator.events, ...result, trades: result.trades.map(t => ({ ...t, confirmationPhase: phaseBySignal.get(t.signalId) })) };
}
