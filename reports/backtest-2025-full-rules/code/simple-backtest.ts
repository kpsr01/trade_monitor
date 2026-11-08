import { aggregateCandles, sessionBounds, type SignalEvent } from './indicator';
import { summarizeTrades, type BacktestOptions, type BacktestTrade, type BacktestSkip, type ExitReason } from './backtest';
import { evaluateSimpleStrategy, type SimpleSetup } from './simple-strategy';
const M = 60_000, D = 1440 * M, IST = 330 * M;

export function summarizeIndependentTrades(trades: BacktestTrade[], skipped: BacktestSkip[] = []) {
  const summary = summarizeTrades(trades, skipped);
  const byTime = new Map<number, number>();
  for (const trade of trades) if (trade.status === 'closed') byTime.set(trade.exitTime!, (byTime.get(trade.exitTime!) ?? 0) + trade.r!);
  let equity = 0, peak = 0, drawdown = 0;
  for (const [, r] of [...byTime].sort((a, b) => a[0] - b[0])) { equity += r; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  return { ...summary, maxDrawdownR: drawdown };
}

/** Independent positions: no opposite-side, same-time, hidden or overlap filter. */
export interface IndependentExecutionOptions extends BacktestOptions {
  signals: (SimpleSetup & { confirmationAvailableAt?: number })[];
  /** The default retains the simple strategy's exact confirmation-close rule. */
  signalTiming?: 'simple_close' | 'source_available_close';
  /** Optional full-indicator lifecycle exits; omitted by the simple strategy. */
  invalidationEvents?: SignalEvent[];
}
export function simulateSimpleSetups(options: IndependentExecutionOptions) {
  const overrides = options.sessionOverrides ?? {}, holidays = new Set(options.nonTradingDates ?? []);
  const cost = options.roundTripCostPoints ?? 0, endMinute = options.executionEndMinutes ?? 930;
  const validMinute = (v: number) => Number.isInteger(v) && v > 555 && v <= 930;
  if (!Number.isFinite(cost) || cost < 0 || !validMinute(endMinute) || (options.sessionExitMinutes !== undefined && (!validMinute(options.sessionExitMinutes) || options.sessionExitMinutes > endMinute)) ||
    [options.testStart, options.testEnd].some(v => v !== undefined && (!Number.isFinite(v) || v % M !== 0)) ||
    (options.testStart !== undefined && options.testEnd !== undefined && options.testStart >= options.testEnd) ||
    [...holidays].some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d)) throw new Error('Invalid backtest settings.');
  const day = (t: number) => Math.floor((t + IST) / D) * D - IST;
  const end = (t: number) => Math.min(sessionBounds(t, overrides).close, day(t) + endMinute * M);
  const cutoff = (t: number) => Math.min(end(t), day(t) + (options.sessionExitMinutes ?? endMinute) * M);
  const next = (close: number) => {
    if (close < end(close)) return close;
    for (let t = day(close) + D; ; t += D) {
      const date = new Date(t + IST), key = date.toISOString().slice(0, 10);
      if (overrides[key] || (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !holidays.has(key))) return sessionBounds(t, overrides).open;
    }
  };
  let now = 0; for (const row of options.candles) now = Math.max(now, row.time + M);
  const rows = aggregateCandles(options.candles, 1, now, overrides).filter(r => r.time < end(r.time));
  const byClose = new Map(rows.map((r, i) => [r.closeTime, i]));
  const start = options.testStart ?? rows[0]?.time ?? 0, testEnd = options.testEnd ?? now;
  const trades: BacktestTrade[] = [], skipped: BacktestSkip[] = [], seen = new Set<string>();
  const invalidations = new Map<string, number>();
  for (const event of options.invalidationEvents ?? []) if (event.type === 'invalidated') {
    invalidations.set(event.signalId, Math.min(invalidations.get(event.signalId) ?? Infinity, event.availableAt));
  }
  for (const s of [...options.signals].sort((a, b) => (a.entryAt ?? Infinity) - (b.entryAt ?? Infinity) || a.signalId.localeCompare(b.signalId))) {
    if (s.entryAt === null || s.entry === null || s.confirmedAt === null || seen.has(s.signalId)) continue;
    seen.add(s.signalId);
    const skip = (reason: BacktestSkip['reason']) => skipped.push({ signalId: s.signalId, time: s.entryAt!, reason });
    if (s.entryAt < start) { skip('before_test'); continue; }
    if (s.entryAt >= testEnd) { skip('after_test'); continue; }
    if (options.sessionExitMinutes === undefined ? s.entryAt > cutoff(s.entryAt) : s.entryAt >= cutoff(s.entryAt)) { skip('outside_execution_session'); continue; }
    const confirmationAvailableAt = s.confirmationAvailableAt ?? s.confirmedAt;
    const validTiming = options.signalTiming === 'source_available_close'
      ? s.confirmedAt > s.formedAt && s.entryAt >= confirmationAvailableAt && confirmationAvailableAt >= s.confirmedAt
      : s.entryAt > s.formedAt && s.entryAt === s.confirmedAt && confirmationAvailableAt === s.confirmedAt;
    if (!validTiming) { skip('confirmation_unavailable'); continue; }
    if ((invalidations.get(s.signalId) ?? Infinity) <= s.entryAt) { skip('cancelled_before_entry'); continue; }
    const index = byClose.get(s.entryAt);
    if (index === undefined) { skip('missing_entry_candle'); continue; }
    const bull = s.direction === 'bullish', risk = bull ? s.entry - s.stopLoss : s.stopLoss - s.entry;
    if (!Number.isFinite(risk) || risk <= 0 || rows[index].close !== s.entry || s.stopLoss !== s.c2Extreme || s.target !== s.entry + (bull ? 2 : -2) * risk) { skip('invalid_risk'); continue; }
    const trade: BacktestTrade = { signalId: s.signalId, direction: s.direction, status: 'open', entryTime: s.entryAt, entry: s.entry, stopLoss: s.stopLoss, target: s.target, risk,
      confirmedAt: s.confirmedAt, confirmationAvailableAt, entryRecordedAt: s.entryAt, exitTime: null, exit: null, exitReason: null,
      grossPoints: null, points: null, grossR: null, r: null, ambiguousBar: false, roundTripCostPoints: cost };
    trades.push(trade);
    const close = (price: number, time: number, reason: ExitReason, ambiguous = false) => {
      const points = (bull ? 1 : -1) * (price - trade.entry);
      Object.assign(trade, { status: 'closed', exit: price, exitTime: time, exitReason: reason, grossPoints: points, points: points - cost, grossR: points / risk, r: (points - cost) / risk, ambiguousBar: ambiguous });
    };
    let expected = next(s.entryAt);
    for (let i = index + 1; i < rows.length && rows[i].time < testEnd; i++) {
      const row = rows[i];
      if (row.time !== expected) { trade.status = 'unresolved'; trade.exitReason = 'missing_candle'; break; }
      if (bull ? row.open <= trade.stopLoss : row.open >= trade.stopLoss) { close(row.open, row.time, 'stop_gap'); break; }
      if (bull ? row.open >= trade.target : row.open <= trade.target) { close(trade.target, row.time, 'target'); break; }
      if ((invalidations.get(s.signalId) ?? Infinity) <= row.time) { close(row.open, row.time, 'invalidation'); break; }
      const stop = bull ? row.low <= trade.stopLoss : row.high >= trade.stopLoss;
      const target = bull ? row.high >= trade.target : row.low <= trade.target;
      if (stop) { close(trade.stopLoss, row.closeTime, 'stop', target); break; }
      if (target) { close(trade.target, row.closeTime, 'target'); break; }
      if (options.sessionExitMinutes !== undefined && row.closeTime === cutoff(row.time)) { close(row.close, row.closeTime, 'session_close'); break; }
      expected = next(row.closeTime);
    }
    if (trade.status === 'open' && expected + M <= Math.min(now, testEnd)) { trade.status = 'unresolved'; trade.exitReason = 'missing_candle'; }
  }
  // Exposure is reported, not capped. Simultaneous closes release exposure
  // before new close entries; all same-time entry events remain independent.
  const changes = trades.flatMap(t => [{ time: t.entryTime, delta: 1 }, ...(t.exitTime === null ? [] : [{ time: t.exitTime, delta: -1 }])]).sort((a, b) => a.time - b.time || a.delta - b.delta);
  let exposure = 0, maxConcurrentPositions = 0;
  for (const c of changes) { exposure += c.delta; maxConcurrentPositions = Math.max(exposure, maxConcurrentPositions); }
  return { trades, skipped, summary: summarizeIndependentTrades(trades, skipped), maxConcurrentPositions };
}

export type SimpleBacktestOptions = BacktestOptions & { holdingMode?: 'daily_exit' | 'carry' };

/** Daily exit is the selected policy. Carry is retained only as an explicit research option. */
export function runSimpleBacktest(options: SimpleBacktestOptions) {
  const holdingMode = options.holdingMode ?? 'daily_exit';
  if (!['daily_exit', 'carry'].includes(holdingMode) || (holdingMode === 'carry' && options.sessionExitMinutes !== undefined)) throw new Error('Invalid holding-mode settings.');
  const execution = { ...options, sessionExitMinutes: holdingMode === 'carry' ? undefined : options.sessionExitMinutes ?? options.executionEndMinutes ?? 930 };
  let now = 0; for (const row of options.candles) now = Math.max(now, row.time + M);
  const result = evaluateSimpleStrategy({ ...options, instrument: options.instrument ?? '^NSEI', now, includeAllEvents: true });
  return { holdingMode, higherMinutes: options.higherMinutes, lowerMinutes: options.lowerMinutes, events: result.events, signals: result.signals,
    ...simulateSimpleSetups({ ...execution, signals: result.signals }) };
}
