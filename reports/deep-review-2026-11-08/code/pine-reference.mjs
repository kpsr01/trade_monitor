/** Independent review model, derived directly from the pinned Pine source.
 * No production imports. Not a Pine runtime. Level selection is a literal
 * historical series translation; lifecycle is a per-C2 walk of its C3/C4 bars,
 * with the explicitly documented closed-candle timing adaptations.
 */
const M = 60_000, IST = 330 * M, DAY = 1440 * M;
export function referenceGroups(minutes, width, overrides = {}) {
  const groups = new Map();
  for (const row of minutes) {
    const day = Math.floor((row.time + IST) / DAY) * DAY - IST;
    const hours = overrides[new Date(day + IST).toISOString().slice(0, 10)];
    const open = day + (hours?.openMinutes ?? 555) * M;
    const close = day + (hours?.closeMinutes ?? 930) * M;
    if (row.time < open || row.time >= close) continue;
    const start = open + Math.floor((row.time - open) / (width * M)) * width * M;
    const existing = groups.get(start);
    if (existing) existing.rows.push(row);
    else groups.set(start, { time: start, closeTime: Math.min(start + width * M, close), rows: [row] });
  }
  return [...groups.values()].sort((a, b) => a.time - b.time).map(group => {
    if (group.rows.length !== (group.closeTime - group.time) / M || group.rows.some((r, i) => r.time !== group.time + i * M)) throw new Error('Reference requires complete ordered groups.');
    return { time: group.time, closeTime: group.closeTime, open: group.rows[0].open,
      high: Math.max(...group.rows.map(r => r.high)), low: Math.min(...group.rows.map(r => r.low)), close: group.rows.at(-1).close };
  });
}

/** Pine 681-777: explicit bull/bear paths and prior-bar series values. */
export function referenceLevels(lower, higher) {
  const levels = [];
  let h0 = lower[0]?.high, l0 = lower[0]?.low, h1 = h0, l1 = l0, period = 0;
  let bullPrice = null, bullIndex = null, bearPrice = null, bearIndex = null;
  let bullReclaimed = false, bearReclaimed = false;
  const up = n => n >= 0 && lower[n].close > lower[n].open;
  const down = n => n >= 0 && lower[n].close < lower[n].open;
  const equal = n => n >= 0 && lower[n].close === lower[n].open;
  for (let n = 0; n < lower.length; n++) {
    const row = lower[n];
    if (row.time >= higher[period].closeTime) {
      period++; h1 = h0; l1 = l0; h0 = row.high; l0 = row.low;
    }
    h0 = Math.max(h0, row.high); l0 = Math.min(l0, row.low);
    const previousBullIndex = bullIndex, previousBearIndex = bearIndex;
    if (row.low === l0 && row.low < l1) {
      if ((down(n) || equal(n)) && (up(n - 1) || equal(n - 1)) && !(equal(n) && equal(n - 1))) {
        bullPrice = row.open; bullIndex = n;
      } else for (let i = 2; i <= 10; i++) {
        if (n - i < 0) continue; // Pine's na comparisons cannot match.
        if (lower[n - i].low < row.low) break;
        if ((up(n - i) || equal(n - i)) && down(n - i + 1)) {
          const b = i - 1;
          bullPrice = lower[n - b].open; bullIndex = n - b;
          for (let j = b; j >= 0; j--) if (lower[n - j].open > bullPrice && down(n - j)) {
            bullPrice = lower[n - j].open; bullIndex = n - j;
          }
          if (bullPrice < row.open) { bullPrice = up(n) ? row.high : row.open; bullIndex = n; }
          break;
        }
      }
    }
    if (row.high === h0 && row.high > h1) {
      if ((up(n) || equal(n)) && (down(n - 1) || equal(n - 1)) && !(equal(n) && equal(n - 1))) {
        bearPrice = row.open; bearIndex = n;
      } else for (let i = 2; i <= 10; i++) {
        if (n - i < 0) continue;
        if (lower[n - i].high > row.high) break;
        if ((down(n - i) || equal(n - i)) && up(n - i + 1)) {
          const b = i - 1;
          bearPrice = lower[n - b].open; bearIndex = n - b;
          for (let j = b; j >= 0; j--) if (lower[n - j].open < bearPrice && up(n - j)) {
            bearPrice = lower[n - j].open; bearIndex = n - j;
          }
          if (bearPrice > row.open) { bearPrice = down(n) ? row.low : row.open; bearIndex = n; }
          break;
        }
      }
    }
    if (bullIndex !== null && bullIndex !== previousBullIndex) bullReclaimed = false;
    if (bearIndex !== null && bearIndex !== previousBearIndex) bearReclaimed = false;
    if (bullPrice !== null && n > 0 && lower[n - 1].close > bullPrice) bullReclaimed = true;
    if (bearPrice !== null && n > 0 && lower[n - 1].close < bearPrice) bearReclaimed = true;
    levels.push({ bullish: { price: bullPrice, index: bullIndex, reclaimed: bullReclaimed }, bearish: { price: bearPrice, index: bearIndex, reclaimed: bearReclaimed } });
  }
  return levels;
}

/** Independent per-setup lifecycle, rather than the production two-slot loop. */
export function referenceSignals({ candles, higherMinutes, lowerMinutes, instrument = '^NSEI', sessionOverrides = {} }) {
  const higher = referenceGroups(candles, higherMinutes, sessionOverrides);
  const lower = referenceGroups(candles, lowerMinutes, sessionOverrides);
  const levels = referenceLevels(lower, higher);
  const indexAtClose = new Map(lower.map((r, i) => [r.closeTime, i]));
  const isC2 = (i, bull) => i > 0 && (bull ? higher[i].low < higher[i - 1].low && higher[i].close > higher[i - 1].low : higher[i].high > higher[i - 1].high && higher[i].close < higher[i - 1].high);
  const signals = [], events = [];
  for (let c = 1; c < higher.length; c++) for (const bull of [true, false]) {
    if (!isC2(c, bull)) continue;
    const c2 = higher[c], direction = bull ? 'bullish' : 'bearish';
    const last = indexAtClose.get(c2.closeTime), fixed = levels[last][direction];
    const extreme = bull ? c2.low : c2.high;
    const signalId = `${instrument}:${higherMinutes}-${lowerMinutes}:${c2.time}:${direction}`;
    const local = [], state = { phase: 'C3', dead: false, confirmed: false, c4Invalid: false, confirmedInC4: false, entered: false, top: null, bottom: null };
    const emit = (type, time, price = null, availableAt = time, reason = '') => {
      const event = { id: `${signalId}:${type}`, signalId, type, direction, time, availableAt, price, reason };
      events.push(event); local.push(event);
    };
    const stop = (time, reason) => { state.dead = true; emit('invalidated', time, null, time, reason); };
    const beyond = close => fixed.price !== null && (bull ? close > fixed.price : close < fixed.price);
    const confirm = (time, availableAt = time) => {
      if (state.confirmed || state.dead || fixed.price === null) return;
      state.confirmed = true; state.confirmedInC4 = state.phase === 'C4';
      emit('confirmed', time, fixed.price, availableAt);
    };
    const checkClose = (row, availability = row.closeTime) => {
      if (state.dead) return;
      if (state.phase === 'C4' && !state.c4Invalid && (bull ? row.close < state.bottom : row.close > state.top)) {
        state.c4Invalid = true;
        if (state.confirmedInC4) { stop(availability, 'c4'); return; }
      }
      if (beyond(row.close)) confirm(row.closeTime, availability);
    };
    const entry = row => {
      if (state.dead || !state.confirmed || state.entered) return;
      if ((bull ? row.close - extreme : extreme - row.close) <= 0) { stop(row.closeTime, 'risk'); return; }
      state.entered = true; emit('entry', row.closeTime, row.close);
    };
    emit('formed', c2.closeTime, extreme);
    if (fixed.reclaimed || beyond(c2.close)) confirm(c2.closeTime);
    entry(lower[last]);
    for (let n = last + 1; n < lower.length; n++) {
      const row = lower[n], c3 = higher[c + 1], c4 = higher[c + 2];
      if (!c3 || row.time >= (c4?.closeTime ?? c3.closeTime)) break;
      const firstC4 = c4 && row.time === c4.time;
      if (firstC4) {
        state.phase = 'C4';
        const midpoint = (c3.high + c3.low) / 2;
        state.top = Math.max(row.open, midpoint); state.bottom = Math.min(row.open, midpoint);
      }
      // Pine 835-842: current wick before previous-close C4/CISD checks.
      if (bull ? row.low < extreme : row.high > extreme) { stop(row.closeTime, 'wick'); break; }
      if (firstC4) checkClose(lower[n - 1], row.closeTime);
      if (state.dead) break;
      const ending = row.closeTime === (state.phase === 'C3' ? c3.closeTime : c4.closeTime);
      if (ending && (isC2(state.phase === 'C3' ? c + 1 : c + 2, bull) || state.phase === 'C4')) {
        emit('finished', row.closeTime, null, row.closeTime, 'finished'); break;
      }
      if (!ending) checkClose(row);
      entry(row);
      if (state.dead) break;
    }
    signals.push({ signalId, fixed, events: local });
  }
  return { higher, lower, levels, signals, events };
}

export function comparableEvent(event) {
  const reason = event.type === 'invalidated' ? (/wick/.test(event.reason) ? 'wick' : /T-spot/.test(event.reason) ? 'c4' : /risk/.test(event.reason) ? 'risk' : event.reason) : '';
  return { type: event.type, direction: event.direction, time: event.time, availableAt: event.availableAt, price: event.price, reason };
}
