/** Causal port of CantoLab's MIT-licensed openSourceFractal.pine.
 * Source, line mapping, and deliberate non-repainting changes: docs/indicator.md. */
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume?: number }
export interface ClosedCandle extends Candle { closeTime: number }
export type SessionOverrides = Record<string, { openMinutes: number; closeMinutes: number }>;
export type Direction = 'bullish' | 'bearish';
export type SetupStatus = 'no_setup' | 'forming' | 'confirmed_bullish' | 'confirmed_bearish' | 'invalidated';
export interface SignalEvent {
  id: string; signalId: string; type: 'formed' | 'confirmed' | 'entry' | 'invalidated' | 'finished';
  time: number; availableAt: number; direction: Direction; reason: string; price: number | null;
}
export interface FractalResult {
  status: SetupStatus; direction: Direction | null; entry: number | null; stopLoss: number | null;
  target: number | null; riskReward: 2; confirmedAt: number | null; updatedAt: number;
  signalId: string | null; reason: string; phase: 'idle' | 'C3' | 'C4' | 'finished';
  cisdLevel: number | null; c2Extreme: number | null; c2At: number | null; entryAt: number | null;
  lastCandleAt: number | null; c4Invalid: boolean; events: SignalEvent[];
  higherMinutes: number; lowerMinutes: number;
}
export interface FractalOptions {
  candles: Candle[]; higherMinutes: 60 | 30 | 15; lowerMinutes: 5 | 3 | 1;
  now: number; instrument: string;
  /** Verified special trading sessions; keys are IST YYYY-MM-DD dates. */
  sessionOverrides?: SessionOverrides;
  /** Research/replay only. The dashboard keeps its bounded 60-event response by default. */
  includeAllEvents?: boolean;
  /** Research variant: require the confirming LTF close strictly after C2 closes. */
  postSweepOnly?: boolean;
  /** Research only: visibility after all mutations at the entry's causal close. */
  onEntryVisibility?: (event: SignalEvent, visible: boolean) => void;
  /** Research only: immutable frozen-level facts for source-parity audits. */
  onSetupFormation?: (formation: { signalId: string; cisdLevel: number | null; levelAt: number | null; alreadyReclaimed: boolean }) => void;
}
const MINUTE = 60_000;
const IST = 330 * MINUTE;
const DAY = 1440 * MINUTE;
const SESSION_START = 555 * MINUTE;
const SESSION_END = 930 * MINUTE;
function dayStart(time: number) { return Math.floor((time + IST) / DAY) * DAY - IST; }
export function sessionBounds(time: number, overrides: SessionOverrides = {}) {
  const day = dayStart(time);
  const special = overrides[new Date(day + IST).toISOString().slice(0, 10)];
  return { open: day + (special ? special.openMinutes * MINUTE : SESSION_START), close: day + (special ? special.closeMinutes * MINUTE : SESSION_END) };
}
function bucket(time: number, minutes: number, overrides: SessionOverrides = {}) {
  const session = sessionBounds(time, overrides);
  return session.open + Math.floor((time - session.open) / (minutes * MINUTE)) * minutes * MINUTE;
}
function follows(previous: ClosedCandle, next: ClosedCandle, overrides: SessionOverrides = {}): boolean {
  return next.time === previous.closeTime ||
    (dayStart(next.time) > dayStart(previous.time) && previous.closeTime === sessionBounds(previous.time, overrides).close && next.time === sessionBounds(next.time, overrides).open);
}

/** NSE cash session bars. Incomplete or gapped groups are never returned. */
export function aggregateCandles(input: Candle[], minutes: number, now: number, overrides: SessionOverrides = {}): ClosedCandle[] {
  if (![1, 3, 5, 15, 30, 60].includes(minutes) || !Number.isFinite(now)) throw new Error('Invalid candle aggregation settings.');
  for (const [date, hours] of Object.entries(overrides)) {
    const stamp = Date.parse(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date ||
        !Number.isInteger(hours.openMinutes) || !Number.isInteger(hours.closeMinutes) || hours.openMinutes < 0 || hours.closeMinutes > 1440 || hours.openMinutes >= hours.closeMinutes) throw new Error('Invalid special-session settings.');
  }
  const unique = new Map<number, Candle>();
  for (const row of input) {
    if (![row.time, row.open, row.high, row.low, row.close].every(Number.isFinite) || row.time % MINUTE !== 0 || row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) || row.low > row.high) throw new Error('Malformed OHLC candle.');
    const old = unique.get(row.time);
    if (old && ['open', 'high', 'low', 'close'].some(k => old[k as keyof Candle] !== row[k as keyof Candle])) throw new Error('Conflicting duplicate candle.');
    unique.set(row.time, row);
  }
  const out: ClosedCandle[] = [];
  let group: ClosedCandle | null = null, count = 0, contiguous = true;
  const flush = () => {
    if (group && group.closeTime <= now && contiguous && count === (group.closeTime - group.time) / MINUTE) out.push(group);
  };
  for (const row of [...unique.values()].sort((a, b) => a.time - b.time)) {
    const session = sessionBounds(row.time, overrides);
    if (row.time < session.open || row.time >= session.close || row.time + MINUTE > now) continue;
    const start = bucket(row.time, minutes, overrides);
    if (!group || group.time !== start) {
      flush();
      group = { time: start, closeTime: Math.min(start + minutes * MINUTE, session.close), open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume ?? 0 };
      count = 1; contiguous = row.time === start;
    } else {
      contiguous = contiguous && row.time === start + count * MINUTE;
      group.high = Math.max(group.high, row.high); group.low = Math.min(group.low, row.low);
      group.close = row.close; group.volume! += row.volume ?? 0; count++;
    }
  }
  flush();
  return out;
}

interface Level { price: number | null; index: number | null; reclaimed: boolean }
interface Setup {
  id: string; direction: Direction; extreme: number; c2At: number; formedAt: number;
  level: number | null; phase: 'C3' | 'C4' | 'finished'; dead: boolean; c4Invalid: boolean;
  c4Top: number | null; c4Bottom: number | null; confirmedInC4: boolean;
  confirmedAt: number | null; confirmationAvailableAt: number | null;
  entry: number | null; entryAt: number | null;
  stop: number | null; target: number | null; reason: string;
}
const emptyLevel = (): Level => ({ price: null, index: null, reclaimed: false });
const isUp = (c: Candle) => c.close > c.open;
const isDown = (c: Candle) => c.close < c.open;
const isEqual = (c: Candle) => c.close === c.open;

/** Shared by the dashboard result and the entry-close visibility snapshot. */
function selectSetup(slots: Partial<Record<Direction, Setup>>) {
  const candidates = Object.values(slots).sort((a, b) => b.formedAt - a.formedAt || (b.confirmedAt ?? 0) - (a.confirmedAt ?? 0));
  const active = candidates.filter(s => !s.dead && s.phase !== 'finished');
  const selected = active[0] ?? candidates[0];
  const ambiguous = active.length > 1 && active[0].formedAt === active[1].formedAt && active[0].confirmedAt === active[1].confirmedAt;
  let status: SetupStatus = 'no_setup';
  if (selected) status = selected.dead ? 'invalidated' : selected.phase === 'finished' ? 'no_setup' : selected.confirmedAt !== null ? (selected.direction === 'bullish' ? 'confirmed_bullish' : 'confirmed_bearish') : 'forming';
  if (ambiguous) status = 'forming';
  const visible = selected && selected.phase !== 'finished' && !ambiguous;
  return { selected, ambiguous, status, visible };
}

/** Directional-run selection, Pine lines 709–749. Index is segment-local. */
export function findCisdLevel(history: Candle[], bullish: boolean): { price: number; index: number } | null {
  const index = history.length - 1, current = history[index], previous = history[index - 1];
  if (!current || !previous) return null;
  const driving = bullish ? isDown : isUp;
  const opposite = bullish ? isUp : isDown;
  if ((driving(current) || isEqual(current)) && (opposite(previous) || isEqual(previous)) && !(isEqual(current) && isEqual(previous))) return { price: current.open, index };
  for (let offset = 2; offset <= 10; offset++) {
    const older = history[index - offset], newer = history[index - offset + 1];
    if (!older || !newer) break;
    if (bullish ? older.low < current.low : older.high > current.high) break;
    if ((opposite(older) || isEqual(older)) && driving(newer)) {
      let selected = { price: newer.open, index: index - offset + 1 };
      for (let j = offset - 1; j >= 0; j--) {
        const candidate = history[index - j];
        if (driving(candidate) && (bullish ? candidate.open > selected.price : candidate.open < selected.price)) selected = { price: candidate.open, index: index - j };
      }
      if (bullish ? selected.price < current.open : selected.price > current.open) selected = { price: bullish ? (isUp(current) ? current.high : current.open) : (isDown(current) ? current.low : current.open), index };
      return selected;
    }
  }
  return null;
}

export function evaluateFractal(options: FractalOptions): FractalResult {
  const { now, higherMinutes, lowerMinutes, instrument, sessionOverrides = {} } = options;
  if (!((higherMinutes === 60 && lowerMinutes === 5) || (higherMinutes === 30 && lowerMinutes === 3) || (higherMinutes === 15 && lowerMinutes === 1))) throw new Error('Invalid fractal settings.');
  const lower = aggregateCandles(options.candles, lowerMinutes, now, sessionOverrides);
  const higher = aggregateCandles(options.candles, higherMinutes, now, sessionOverrides);
  const higherByTime = new Map(higher.map(c => [c.time, c]));
  const events: SignalEvent[] = [];
  const eventIds = new Set<string>();
  const slots: Partial<Record<Direction, Setup>> = {};
  let history: ClosedCandle[] = [], bullLevel = emptyLevel(), bearLevel = emptyLevel();
  let running: ClosedCandle | null = null, previousHigher: ClosedCandle | null = null;
  let previous: ClosedCandle | null = null;
  let lastPeriod = -1;
  const emit = (s: Setup, type: SignalEvent['type'], time: number, reason: string, price: number | null = null, availableAt = time) => {
    const id = `${s.id}:${type}`;
    if (!eventIds.has(id)) {
      eventIds.add(id);
      events.push({ id, signalId: s.id, type, time, availableAt, direction: s.direction, reason, price });
    }
  };
  const invalidate = (s: Setup, time: number, reason: string, availableAt = time) => {
    s.dead = true; s.phase = 'finished'; s.reason = reason;
    emit(s, 'invalidated', time, reason, null, availableAt);
  };
  const confirm = (s: Setup, time: number, availableAt = time) => {
    if (s.confirmedAt !== null || s.dead || s.phase === 'finished' || s.level === null) return;
    if (options.postSweepOnly && time <= s.formedAt) return;
    s.confirmedAt = Math.max(time, s.formedAt);
    s.confirmationAvailableAt = Math.max(time, availableAt, s.formedAt);
    s.confirmedInC4 = s.phase === 'C4';
    s.reason = 'CISD close confirmed. Entry uses the first causally available closed price.';
    emit(s, 'confirmed', s.confirmedAt, 'Closed lower-timeframe candle reclaimed the CISD level.', s.level, s.confirmationAvailableAt);
  };
  const create = (direction: Direction, c2: ClosedCandle, time: number) => {
    const level = direction === 'bullish' ? bullLevel : bearLevel;
    const old = slots[direction];
    if (old && !old.dead && old.phase !== 'finished') { old.phase = 'finished'; emit(old, 'finished', time, 'Replaced by a newer same-direction C2.'); }
    const s: Setup = { id: `${instrument}:${higherMinutes}-${lowerMinutes}:${c2.time}:${direction}`, direction, extreme: direction === 'bullish' ? c2.low : c2.high, c2At: c2.time, formedAt: time, level: level.price, phase: 'C3', dead: false, c4Invalid: false, c4Top: null, c4Bottom: null, confirmedInC4: false, confirmedAt: null, confirmationAvailableAt: null, entry: null, entryAt: null, stop: null, target: null, reason: level.price === null ? 'C2 sweep closed. No qualifying CISD level was found.' : 'C2 sweep closed. Waiting for a CISD reclaim.' };
    slots[direction] = s;
    options.onSetupFormation?.({ signalId: s.id, cisdLevel: level.price, levelAt: level.index === null ? null : history[level.index].time, alreadyReclaimed: level.reclaimed });
    emit(s, 'formed', time, 'Higher-timeframe sweep and reclaim closed.', s.extreme);
    if (level.reclaimed) confirm(s, time); // Never backdate an early-CISD entry into C2.
    return s;
  };
  const crosses = (s: Setup, close: number) => s.level !== null && (s.direction === 'bullish' ? close > s.level : close < s.level);
  const checkPreviousClose = (s: Setup, prior: ClosedCandle, time: number, availableAt = time) => {
    if (s.dead || s.phase === 'finished') return;
    if (s.phase === 'C4' && !s.c4Invalid && s.c4Bottom !== null && s.c4Top !== null && (s.direction === 'bullish' ? prior.close < s.c4Bottom : prior.close > s.c4Top)) {
      s.c4Invalid = true;
      if (s.confirmedInC4) { invalidate(s, time, 'C4 T-spot close invalidated a CISD first confirmed in C4.', availableAt); return; }
      s.reason = s.confirmedAt !== null ? 'C4 T-spot invalidated; the earlier CISD confirmation is retained.' : 'C4 T-spot invalidated before CISD. The source rules still allow a later confirmation.';
    }
    if (crosses(s, prior.close)) confirm(s, prior.closeTime, availableAt);
  };
  const recordEntry = (s: Setup, row: ClosedCandle) => {
    if (s.dead || s.phase === 'finished' || s.confirmationAvailableAt === null || s.entry !== null || row.closeTime < s.confirmationAvailableAt) return;
    const bullish = s.direction === 'bullish';
    // Pine defines the CISD trigger, not an order fill. Our reference entry is the
    // first available close, after all invalidations known at that close.
    const stop = s.extreme;
    const risk = bullish ? row.close - stop : stop - row.close;
    if (risk <= 0) { invalidate(s, row.closeTime, 'CISD close entry has non-positive risk against the C2 extreme.'); return; }
    s.entry = row.close; s.entryAt = row.closeTime; s.stop = stop;
    s.target = row.close + (bullish ? 1 : -1) * 2 * risk;
    s.reason = s.c4Invalid ? (s.confirmedInC4 ? 'CISD confirmed after the C4 T-spot flag. The source rules retain this setup.' : 'C4 T-spot invalidated; earlier CISD retained.') : 'CISD close entry recorded. Stop at the exact C2 extreme; target 2R. Reference levels only; no order is placed.';
    emit(s, 'entry', row.closeTime, 'First causally available lower-timeframe close after CISD confirmation.', row.close, row.closeTime);
  };

  for (const row of lower) {
    const period = bucket(row.time, higherMinutes, sessionOverrides);
    if (previous && !follows(previous, row, sessionOverrides)) {
      for (const s of Object.values(slots)) if (!s.dead && s.phase !== 'finished') invalidate(s, row.time, 'Missing candles: setup monitoring reset.', row.closeTime);
      delete slots.bullish; delete slots.bearish;
      history = []; bullLevel = emptyLevel(); bearLevel = emptyLevel();
      running = null; previousHigher = null; previous = null; lastPeriod = -1;
    }
    if (period !== lastPeriod) {
      const completed = running ? higherByTime.get(running.time) : undefined;
      const comparable = completed && previousHigher && follows(previousHigher, completed, sessionOverrides);
      for (const direction of ['bullish', 'bearish'] as const) {
        const trigger = comparable && (direction === 'bullish' ? completed.low < previousHigher!.low && completed.close > previousHigher!.low : completed.high > previousHigher!.high && completed.close < previousHigher!.high);
        if (trigger) {
          if (slots[direction]?.c2At !== completed!.time) create(direction, completed!, completed!.closeTime);
        }
        else {
          const s = slots[direction];
          if (s && !s.dead && s.phase !== 'finished') {
            if (s.phase === 'C3' && completed) {
              const midpoint = (completed.high + completed.low) / 2;
              s.phase = 'C4'; s.c4Top = Math.max(row.open, midpoint); s.c4Bottom = Math.min(row.open, midpoint); s.c4Invalid = false;
            } else { s.phase = 'finished'; s.reason = 'C3/C4 monitoring window completed.'; emit(s, 'finished', row.time, s.reason); }
          }
        }
      }
      previousHigher = completed ?? null;
      running = { ...row };
      lastPeriod = period;
    }
    // Pine 835-842 checks the current wick before previous-close CISD/C4.
    // This matters when a final-C3 confirmation is deferred to the first C4 bar:
    // if that bar breaches C2, no new confirmation may be emitted at its close.
    for (const s of Object.values(slots)) if (!s.dead && s.phase !== 'finished' && (s.direction === 'bullish' ? row.low < s.extreme : row.high > s.extreme)) invalidate(s, row.closeTime, 'Closed candle breached the C2 wick extreme.');
    for (const s of Object.values(slots)) {
      if (previous) checkPreviousClose(s, previous, row.time, row.closeTime);
    }
    running = { ...running!, high: Math.max(running!.high, row.high), low: Math.min(running!.low, row.low), close: row.close, closeTime: row.closeTime };
    history.push(row);
    for (const bullish of [true, false]) {
      const level = bullish ? bullLevel : bearLevel;
      // Pine seeds h1/l1 with the first LTF bar (681-685). Its initial HTF
      // cannot form C2, but can establish a fixed level inherited by later C2s.
      const sweepReference = previousHigher ?? history[0];
      const atSweep = bullish ? row.low === running.low && row.low < sweepReference.low : row.high === running.high && row.high > sweepReference.high;
      if (atSweep) {
        const selected = findCisdLevel(history, bullish);
        if (selected) {
          if (selected.index !== level.index) level.reclaimed = false;
          level.price = selected.price; level.index = selected.index;
        }
      }
      // Pine compares close[1], including after a fixed-level revision.
      if (level.price !== null && !level.reclaimed && previous && (bullish ? previous.close > level.price : previous.close < level.price)) level.reclaimed = true;
    }
    const endOfHigher = row.closeTime === Math.min(lastPeriod + higherMinutes * MINUTE, sessionBounds(row.time, sessionOverrides).close);
    const completed = higherByTime.get(lastPeriod);
    if (endOfHigher && completed && previousHigher && follows(previousHigher, completed, sessionOverrides)) {
      for (const direction of ['bullish', 'bearish'] as const) {
        const trigger = direction === 'bullish' ? completed.low < previousHigher.low && completed.close > previousHigher.low : completed.high > previousHigher.high && completed.close < previousHigher.high;
        if (trigger) { const s = create(direction, completed, row.closeTime); if (crosses(s, row.close)) confirm(s, row.closeTime); }
        else {
          const s = slots[direction];
          if (s && !s.dead && s.phase === 'C4') { s.phase = 'finished'; s.reason = 'C3/C4 monitoring window completed.'; emit(s, 'finished', row.closeTime, s.reason); }
        }
        // C3 -> C4 needs the next HTF open for its T-spot, so defer that rollover.
      }
    } else if (!endOfHigher) {
      for (const s of Object.values(slots)) checkPreviousClose(s, row, row.closeTime);
    }
    const entryStart = events.length;
    for (const s of Object.values(slots)) recordEntry(s, row);
    if (options.onEntryVisibility && events.length > entryStart) {
      const snapshot = selectSetup(slots);
      for (let i = entryStart; i < events.length; i++) {
        const event = events[i];
        if (event.type === 'entry') options.onEntryVisibility(event, snapshot.selected?.id === event.signalId && snapshot.status === (event.direction === 'bullish' ? 'confirmed_bullish' : 'confirmed_bearish'));
      }
    }
    previous = row;
  }
  const { selected, ambiguous, status, visible } = selectSetup(slots);
  return { status, direction: ambiguous ? null : selected?.direction ?? null, entry: visible ? selected.entry : null, stopLoss: visible ? selected.stop : null, target: visible ? selected.target : null, riskReward: 2, confirmedAt: selected?.confirmedAt ?? null, updatedAt: now, signalId: selected?.id ?? null, reason: ambiguous ? 'Both directions qualify simultaneously. Waiting for an unambiguous setup.' : selected?.reason ?? 'Waiting for a closed higher-timeframe liquidity sweep.', phase: selected?.phase ?? 'idle', cisdLevel: selected?.level ?? null, c2Extreme: selected?.extreme ?? null, c2At: selected?.c2At ?? null, entryAt: visible ? selected.entryAt : null, lastCandleAt: lower.at(-1)?.closeTime ?? null, c4Invalid: selected?.c4Invalid ?? false, events: options.includeAllEvents ? events : events.slice(-60), higherMinutes, lowerMinutes };
}
