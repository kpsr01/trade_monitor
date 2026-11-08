import { aggregateCandles, findCisdLevel, sessionBounds, type ClosedCandle, type Direction, type FractalOptions, type SignalEvent } from './indicator';

export interface SimpleSetup {
  signalId: string; direction: Direction; c2At: number; formedAt: number;
  c2Extreme: number; cisdLevel: number | null; levelAt: number | null;
  status: 'forming' | 'confirmed_bullish' | 'confirmed_bearish' | 'invalidated';
  entry: number | null; stopLoss: number; target: number | null; confirmedAt: number | null;
  entryAt: number | null; reason: string;
}
export interface SimpleFractalResult {
  strategy: 'sweep-post-cisd-close-2r'; higherMinutes: number; lowerMinutes: number;
  status: SimpleSetup['status'] | 'no_setup'; direction: Direction | null;
  entry: number | null; stopLoss: number | null; target: number | null; riskReward: 2;
  confirmedAt: number | null; updatedAt: number; signalId: string | null;
  reason: string; phase: 'idle' | 'waiting' | 'confirmed' | 'invalidated';
  cisdLevel: number | null; c2Extreme: number | null; c2At: number | null; entryAt: number | null;
  lastCandleAt: number | null; events: SignalEvent[]; signals: SimpleSetup[];
  pendingCount: number; confirmedCount: number;
}
export type SimpleOptions = Pick<FractalOptions, 'candles' | 'higherMinutes' | 'lowerMinutes' | 'now' | 'instrument' | 'sessionOverrides' | 'includeAllEvents'>;
const M = 60_000;

/** Current user strategy. Reuses Pine's level finder, not its C3/C4 lifecycle.
 * Every closed HTF sweep freezes its own level and exact wick. Only later LTF
 * candles can confirm. Earlier reclaim flags are never imported. Pine's strict
 * close-beyond predicate is retained; it does not require a fresh crossover.
 * No expiry, replacement, pre-entry wick rejection or trade-selection filter.
 */
export function evaluateSimpleStrategy(options: SimpleOptions): SimpleFractalResult {
  const { higherMinutes, lowerMinutes, now, sessionOverrides = {} } = options;
  if (![[60, 5], [30, 3], [15, 1]].some(([h, l]) => h === higherMinutes && l === lowerMinutes)) throw new Error('Invalid fractal settings.');
  const lower = aggregateCandles(options.candles, lowerMinutes, now, sessionOverrides);
  const higher = aggregateCandles(options.candles, higherMinutes, now, sessionOverrides);
  const higherByTime = new Map(higher.map(c => [c.time, c]));
  const signals: SimpleSetup[] = [], pending = new Map<string, SimpleSetup>(), events: SignalEvent[] = [];
  let history: ClosedCandle[] = [], running: ClosedCandle | null = null, priorHigher: ClosedCandle | null = null, previous: ClosedCandle | null = null;
  let lastPeriod = -1;
  let levels: Record<Direction, { price: number; index: number } | null> = { bullish: null, bearish: null };
  const follows = (a: ClosedCandle, b: ClosedCandle) => b.time === a.closeTime ||
    (b.time > a.closeTime && a.closeTime === sessionBounds(a.time, sessionOverrides).close && b.time === sessionBounds(b.time, sessionOverrides).open);
  const emit = (s: SimpleSetup, type: SignalEvent['type'], time: number, price: number | null, reason: string) => {
    events.push({ id: `${s.signalId}:${type}`, signalId: s.signalId, type, direction: s.direction, time, availableAt: time, price, reason });
  };
  for (const row of lower) {
    if (previous && !follows(previous, row)) {
      for (const s of pending.values()) {
        s.status = 'invalidated'; s.reason = 'Missing candles: post-sweep confirmation cannot be established.';
        emit(s, 'invalidated', row.closeTime, null, s.reason);
      }
      pending.clear(); history = []; running = null; priorHigher = null; lastPeriod = -1;
      levels = { bullish: null, bearish: null };
    }
    const session = sessionBounds(row.time, sessionOverrides);
    const period = session.open + Math.floor((row.time - session.open) / (higherMinutes * M)) * higherMinutes * M;
    if (lastPeriod !== period) {
      priorHigher = running ? higherByTime.get(running.time) ?? null : null;
      running = { ...row, time: period };
      lastPeriod = period;
    } else {
      running = { ...running!, high: Math.max(running!.high, row.high), low: Math.min(running!.low, row.low), close: row.close, closeTime: row.closeTime };
    }
    history.push(row);
    const reference = priorHigher ?? history[0];
    for (const direction of ['bullish', 'bearish'] as const) {
      const bull = direction === 'bullish';
      if (bull ? row.low === running.low && row.low < reference.low : row.high === running.high && row.high > reference.high) {
        const level = findCisdLevel(history, bull);
        if (level) levels[direction] = level;
      }
    }
    // Process existing sweeps BEFORE forming this row's newly closed HTF sweep.
    // row.time >= formedAt means the whole confirming LTF candle is subsequent.
    for (const s of pending.values()) {
      if (row.time < s.formedAt || s.cisdLevel === null) continue;
      const bull = s.direction === 'bullish';
      if (!(bull ? row.close > s.cisdLevel : row.close < s.cisdLevel)) continue;
      const risk = bull ? row.close - s.stopLoss : s.stopLoss - row.close;
      if (risk <= 0) {
        s.status = 'invalidated'; s.reason = 'The confirming close has no positive risk against the fixed HTF stop.';
        emit(s, 'invalidated', row.closeTime, null, s.reason); pending.delete(s.signalId); continue;
      }
      s.status = bull ? 'confirmed_bullish' : 'confirmed_bearish';
      s.confirmedAt = row.closeTime; s.entryAt = row.closeTime; s.entry = row.close;
      s.target = s.entry + (bull ? 2 : -2) * risk;
      s.reason = 'Post-sweep CISD close. Entry at this close, exact HTF wick stop, target 2R.';
      emit(s, 'confirmed', row.closeTime, s.cisdLevel, 'A later LTF candle closed strictly beyond the frozen CISD level.');
      emit(s, 'entry', row.closeTime, s.entry, s.reason);
      pending.delete(s.signalId);
    }
    const completed = higherByTime.get(period);
    if (completed && row.closeTime === completed.closeTime && priorHigher && follows(priorHigher, completed)) {
      for (const direction of ['bullish', 'bearish'] as const) {
        const bull = direction === 'bullish';
        if (!(bull ? completed.low < priorHigher.low && completed.close > priorHigher.low : completed.high > priorHigher.high && completed.close < priorHigher.high)) continue;
        const level = levels[direction], extreme = bull ? completed.low : completed.high;
        const s: SimpleSetup = { signalId: `${options.instrument}:simple:${higherMinutes}-${lowerMinutes}:${completed.time}:${direction}`,
          direction, c2At: completed.time, formedAt: completed.closeTime, c2Extreme: extreme, cisdLevel: level?.price ?? null,
          levelAt: level ? history[level.index].time : null, status: 'forming', entry: null, stopLoss: extreme, target: null,
          confirmedAt: null, entryAt: null, reason: level ? 'HTF sweep closed. Waiting for a subsequent LTF CISD close.' : 'HTF sweep closed without a qualifying frozen CISD level.' };
        signals.push(s); pending.set(s.signalId, s); emit(s, 'formed', s.formedAt, extreme, s.reason);
      }
    }
    previous = row;
  }
  // A presentation summary only. Every signal remains available below and all
  // entry events are consumed by the backtest, independently of this selection.
  const selected = [...signals].sort((a, b) => (b.entryAt ?? b.formedAt) - (a.entryAt ?? a.formedAt) || b.formedAt - a.formedAt)[0];
  return { strategy: 'sweep-post-cisd-close-2r', higherMinutes, lowerMinutes, status: selected?.status ?? 'no_setup', direction: selected?.direction ?? null,
    entry: selected?.entry ?? null, stopLoss: selected?.stopLoss ?? null, target: selected?.target ?? null, riskReward: 2,
    confirmedAt: selected?.confirmedAt ?? null, updatedAt: now, signalId: selected?.signalId ?? null,
    reason: selected?.reason ?? 'Waiting for a closed HTF sweep.', phase: !selected ? 'idle' : selected.status === 'forming' ? 'waiting' : selected.status === 'invalidated' ? 'invalidated' : 'confirmed',
    cisdLevel: selected?.cisdLevel ?? null, c2Extreme: selected?.c2Extreme ?? null, c2At: selected?.c2At ?? null, entryAt: selected?.entryAt ?? null,
    lastCandleAt: lower.at(-1)?.closeTime ?? null, events: options.includeAllEvents ? events : events.slice(-60), signals,
    pendingCount: pending.size, confirmedCount: signals.filter(s => s.confirmedAt !== null).length };
}
