import { aggregateCandles, evaluateFractal, sessionBounds, type Candle, type Direction, type FractalOptions, type SignalEvent } from './indicator';

const MINUTE = 60_000;
export type SkipReason = 'before_test' | 'after_test' | 'outside_execution_session' | 'entry_unavailable' | 'confirmation_unavailable' | 'formation_unavailable' | 'cancelled_before_entry' | 'hidden_or_ambiguous' | 'simultaneous_directions' | 'overlapping_position' | 'unresolved_position' | 'missing_entry_candle' | 'invalid_risk';
export type ExitReason = 'stop' | 'stop_gap' | 'target' | 'invalidation' | 'session_close' | 'missing_candle' | 'end_of_data';
export interface BacktestTrade {
  signalId: string; direction: Direction; status: 'closed' | 'unresolved';
  entryTime: number; entry: number; stopLoss: number; target: number; risk: number;
  confirmedAt: number; confirmationAvailableAt: number; entryRecordedAt: number;
  exitTime: number | null; exit: number | null; exitReason: ExitReason | null;
  grossPoints: number | null; points: number | null; grossR: number | null; r: number | null;
  ambiguousBar: boolean; roundTripCostPoints: number;
}
export interface BacktestSkip { signalId: string; time: number; reason: SkipReason }
export interface BacktestSummary {
  closedTrades: number; wins: number; losses: number; breakeven: number; winRate: number | null;
  totalR: number; averageR: number | null; profitFactorR: number | null; maxDrawdownR: number;
  totalPoints: number; unresolvedTrades: number; ambiguousTrades: number;
  skippedCounts: Partial<Record<SkipReason, number>>;
}
export interface BacktestOptions {
  candles: Candle[]; higherMinutes: FractalOptions['higherMinutes']; lowerMinutes: FractalOptions['lowerMinutes'];
  instrument?: string;
  /** Entry eligibility interval. History before testStart is retained for indicator warm-up. */
  testStart?: number; testEnd?: number; roundTripCostPoints?: number;
  /** IST minute-of-day forced exit; 915 means15:15 before the closing auction. */
  sessionExitMinutes?: number;
}
export interface BacktestResult {
  higherMinutes: number; lowerMinutes: number; events: SignalEvent[];
  trades: BacktestTrade[]; skipped: BacktestSkip[]; summary: BacktestSummary;
}
export interface EventSimulationOptions {
  candles: Candle[]; events: SignalEvent[];
  testStart?: number; testEnd?: number; roundTripCostPoints?: number;
  sessionExitMinutes?: number;
  /** An entry can be rejected if its signal was hidden by the dashboard's other slot. */
  visibleAtEntry?: (event: SignalEvent) => boolean;
}

function validSettings(options: Pick<EventSimulationOptions, 'testStart' | 'testEnd' | 'roundTripCostPoints' | 'sessionExitMinutes'>) {
  const cost = options.roundTripCostPoints ?? 0;
  const sessionExitMinutes = options.sessionExitMinutes ?? 930;
  if (!Number.isFinite(cost) || cost < 0 ||
      [options.testStart, options.testEnd].some(value => value !== undefined && (!Number.isFinite(value) || value % MINUTE !== 0)) ||
      !Number.isInteger(sessionExitMinutes) || sessionExitMinutes <= 555 || sessionExitMinutes > 930 ||
      (options.testStart !== undefined && options.testEnd !== undefined && options.testStart >= options.testEnd)) throw new Error('Invalid backtest settings.');
  return { cost, sessionExitMinutes };
}

/** Each trade risks one R independently. No account-size, compounding, or option-return claim. */
export function summarizeTrades(trades: BacktestTrade[], skipped: BacktestSkip[] = []): BacktestSummary {
  const closed = trades.filter(trade => trade.status === 'closed');
  let equity = 0, highWater = 0, maxDrawdownR = 0, positiveR = 0, negativeR = 0, totalPoints = 0;
  let wins = 0, losses = 0, breakeven = 0;
  for (const trade of [...closed].sort((a, b) => a.exitTime! - b.exitTime!)) {
    const r = trade.r!, points = trade.points!;
    if (r > 1e-10) { wins++; positiveR += r; } else if (r < -1e-10) { losses++; negativeR -= r; } else breakeven++;
    equity += r; totalPoints += points; highWater = Math.max(highWater, equity); maxDrawdownR = Math.max(maxDrawdownR, highWater - equity);
  }
  const skippedCounts: BacktestSummary['skippedCounts'] = {};
  for (const item of skipped) skippedCounts[item.reason] = (skippedCounts[item.reason] ?? 0) + 1;
  return {
    closedTrades: closed.length, wins, losses, breakeven, winRate: closed.length ? wins / closed.length : null,
    totalR: equity, averageR: closed.length ? equity / closed.length : null,
    profitFactorR: negativeR > 0 ? positiveR / negativeR : null,
    maxDrawdownR, totalPoints, unresolvedTrades: trades.length - closed.length,
    ambiguousTrades: closed.filter(trade => trade.ambiguousBar).length, skippedCounts,
  };
}

/**
 * Theoretical zero-feed-delay entry at the first closed LTF price where the
 * confirmation is causally available. Pine supplies a CISD line and confirmation,
 * not an execution price; this close-price fill is our explicit execution model.
 * Entry is admitted only after that minute's price path, so an earlier wick can
 * never stop or target a newly entered position. This does not simulate feed delay.
 * Setup expiry/replacement cancels waiting entries; entered positions retain their
 * bracket and exit on an explicit invalidation, a bracket, or the same-session close.
 */
export function simulateEvents(options: EventSimulationOptions) {
  const { cost, sessionExitMinutes } = validSettings(options);
  const executionClose = (time: number) => sessionBounds(time).open + (sessionExitMinutes - 555) * MINUTE;
  const now = Math.max(0, ...options.candles.map(candle => candle.time + MINUTE));
  const candles = aggregateCandles(options.candles, 1, now);
  const byCloseTime = new Map(candles.map(candle => [candle.closeTime, candle]));
  const testStart = options.testStart ?? candles[0]?.time ?? 0;
  const testEnd = options.testEnd ?? candles.at(-1)?.closeTime ?? 0;
  const events = [...new Map(options.events.map(event => [event.id, event])).values()];
  const bySignal = new Map<string, SignalEvent[]>();
  for (const event of events) {
    if (![event.time, event.availableAt].every(Number.isFinite)) throw new Error('Invalid backtest event time.');
    const group = bySignal.get(event.signalId) ?? []; group.push(event); bySignal.set(event.signalId, group);
  }
  const skipped: BacktestSkip[] = [], trades: BacktestTrade[] = [];
  const eligible = new Map<number, { event: SignalEvent; formed: SignalEvent; confirmation: SignalEvent }[]>();
  const skip = (event: SignalEvent, reason: SkipReason) => skipped.push({ signalId: event.signalId, time: event.time, reason });
  for (const event of events.filter(event => event.type === 'entry').sort((a, b) => a.time - b.time || a.signalId.localeCompare(b.signalId))) {
    if (event.time < testStart) { skip(event, 'before_test'); continue; }
    if (event.time >= testEnd) { skip(event, 'after_test'); continue; }
    if (event.time >= executionClose(event.time)) { skip(event, 'outside_execution_session'); continue; }
    if (event.availableAt > event.time) { skip(event, 'entry_unavailable'); continue; }
    const signal = bySignal.get(event.signalId)!;
    const formed = signal.find(item => item.type === 'formed');
    const confirmation = signal.find(item => item.type === 'confirmed');
    if (!formed || formed.price === null || formed.availableAt > event.time) { skip(event, 'formation_unavailable'); continue; }
    if (!confirmation || confirmation.availableAt > event.time || confirmation.time > event.time) { skip(event, 'confirmation_unavailable'); continue; }
    if (signal.some(item => (item.type === 'invalidated' || item.type === 'finished') && item.availableAt <= event.time)) { skip(event, 'cancelled_before_entry'); continue; }
    if (options.visibleAtEntry && !options.visibleAtEntry(event)) { skip(event, 'hidden_or_ambiguous'); continue; }
    if (!byCloseTime.has(event.time)) { skip(event, 'missing_entry_candle'); continue; }
    const group = eligible.get(event.time) ?? []; group.push({ event, formed, confirmation }); eligible.set(event.time, group);
  }
  let active: BacktestTrade | null = null, expectedNext: number | null = null, blockedUntil = 0;
  const unresolved = (reason: 'missing_candle' | 'end_of_data') => {
    if (!active) return;
    active.status = 'unresolved'; active.exitReason = reason;
    blockedUntil = executionClose(active.entryTime);
    active = null; expectedNext = null;
  };
  const close = (price: number, time: number, reason: ExitReason, ambiguousBar = false) => {
    if (!active) return;
    const grossPoints = (active.direction === 'bullish' ? 1 : -1) * (price - active.entry);
    Object.assign(active, { status: 'closed', exit: price, exitTime: time, exitReason: reason,
      grossPoints, points: grossPoints - cost, grossR: grossPoints / active.risk, r: (grossPoints - cost) / active.risk, ambiguousBar });
    active = null; expectedNext = null;
  };
  for (const row of candles) {
    // The warm-up minute ending at testStart can supply an eligible closing fill.
    if (row.closeTime < testStart || row.time >= testEnd || row.time >= executionClose(row.time)) continue;
    if (active && row.time !== expectedNext) unresolved('missing_candle');
    // Resting orders can fill at this open before a close-based market exit.
    if (active) {
      const bull = active.direction === 'bullish';
      if (bull ? row.open <= active.stopLoss : row.open >= active.stopLoss) close(row.open, row.time, 'stop_gap');
      else if (bull ? row.open >= active.target : row.open <= active.target) close(active.target, row.time, 'target');
      else {
        const invalidation = bySignal.get(active.signalId)?.find(event => event.type === 'invalidated' && event.availableAt <= row.time);
        if (invalidation) close(row.open, row.time, 'invalidation');
      }
    }
    if (active) {
      const bull = active.direction === 'bullish';
      const stopHit = bull ? row.low <= active.stopLoss : row.high >= active.stopLoss;
      const targetHit = bull ? row.high >= active.target : row.low <= active.target;
      // A minute has no tick ordering. Stop first is the declared conservative convention.
      if (stopHit) close(active.stopLoss, row.closeTime, 'stop', targetHit);
      else if (targetHit) close(active.target, row.closeTime, 'target');
      else if (row.closeTime === executionClose(row.time)) close(row.close, row.closeTime, 'session_close');
      else expectedNext = row.closeTime;
    }
    // A confirmed-close entry occurs after the preceding minute's entire path.
    const candidates = eligible.get(row.closeTime) ?? [];
    if (new Set(candidates.map(item => item.event.direction)).size > 1) for (const item of candidates) skip(item.event, 'simultaneous_directions');
    else for (const item of candidates) {
      if (active) { skip(item.event, 'overlapping_position'); continue; }
      if (row.closeTime < blockedUntil) { skip(item.event, 'unresolved_position'); continue; }
      const bull = item.event.direction === 'bullish', extreme = item.formed.price!;
      const stopLoss = extreme;
      const risk = bull ? row.close - stopLoss : stopLoss - row.close;
      if (!Number.isFinite(risk) || risk <= 0 || item.event.price === null || !Number.isFinite(item.event.price) || Math.abs(item.event.price - row.close) > 1e-8) { skip(item.event, 'invalid_risk'); continue; }
      active = {
        signalId: item.event.signalId, direction: item.event.direction, status: 'unresolved',
        entryTime: row.closeTime, entry: row.close, stopLoss, target: row.close + (bull ? 1 : -1) * 2 * risk, risk,
        confirmedAt: item.confirmation.time, confirmationAvailableAt: item.confirmation.availableAt, entryRecordedAt: item.event.availableAt,
        exitTime: null, exit: null, exitReason: null, grossPoints: null, points: null, grossR: null, r: null, ambiguousBar: false, roundTripCostPoints: cost,
      };
      trades.push(active);
      expectedNext = row.closeTime;
    }
  }
  if (active) unresolved('end_of_data');
  return { trades, skipped, summary: summarizeTrades(trades, skipped) };
}

export function runBacktest(options: BacktestOptions): BacktestResult {
  validSettings(options);
  const now = Math.max(0, ...options.candles.map(candle => candle.time + MINUTE));
  const engineOptions: FractalOptions = { ...options, now, instrument: options.instrument ?? '^NSEI' };
  const result = evaluateFractal({ ...engineOptions, includeAllEvents: true });
  const prefixCache = new Map<number, ReturnType<typeof evaluateFractal>>();
  const simulated = simulateEvents({ ...options, events: result.events, visibleAtEntry: event => {
    let prefix = prefixCache.get(event.time);
    if (!prefix) { prefix = evaluateFractal({ ...engineOptions, now: event.time }); prefixCache.set(event.time, prefix); }
    return prefix.signalId === event.signalId && prefix.status === (event.direction === 'bullish' ? 'confirmed_bullish' : 'confirmed_bearish');
  } });
  return { higherMinutes: options.higherMinutes, lowerMinutes: options.lowerMinutes, events: result.events, ...simulated };
}
