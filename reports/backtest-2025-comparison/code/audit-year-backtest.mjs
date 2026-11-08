import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Independent arithmetic/path audit. Does not import the indicator or simulator.
const out = 'reports/backtest-2025-comparison';
const rawReport = await readFile(`${out}/results.json`, 'utf8');
const report = JSON.parse(rawReport);
const M = 60_000, IST = 330 * M, D = 1440 * M;
const localDay = time => new Date(time + IST).toISOString().slice(0, 10);
const limits = time => {
  const day = Math.floor((time + IST) / D) * D - IST;
  const special = report.settings.sessionOverrides[localDay(time)];
  return { open: day + (special?.openMinutes ?? 555) * M, close: day + (special?.closeMinutes ?? 930) * M };
};
const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
const closeEnough = (a, b) => Math.abs(a - b) < 1e-8;
function groups(rows, minutes) {
  const grouped = new Map();
  for (const row of rows) {
    const session = limits(row.time);
    const time = session.open + Math.floor((row.time - session.open) / (minutes * M)) * minutes * M;
    const g = grouped.get(time);
    if (g) { g.high = Math.max(g.high, row.high); g.low = Math.min(g.low, row.low); g.close = row.close; g.count++; }
    else grouped.set(time, { time, end: Math.min(time + minutes * M, session.close), open: row.open, high: row.high, low: row.low, close: row.close, count: 1 });
  }
  for (const g of grouped.values()) check(g.count === (g.end - g.time) / M, `Incomplete audit aggregate ${g.time}/${minutes}`);
  return [...grouped.values()];
}
const audited = [];
for (const [feed, file] of [['Technovus', 'minute-candles.json'], ['Kaggle v18', 'minute-candles-kaggle.json']]) {
  const raw = await readFile(`${out}/data/${file}`, 'utf8'), rows = JSON.parse(raw);
  const inputHash = createHash('sha256').update(raw).digest('hex');
  check(inputHash === (feed === 'Technovus' ? report.provenance.dataSha256 : report.provenance.alternateDataSha256), `${feed}: input hash`);
  const byTime = new Map(rows.map((row, index) => [row.time, index]));
  for (const study of report.studies.filter(s => s.feed === feed)) {
    const label = `${feed}/${study.higherMinutes}/${study.mode}`;
    const htfs = groups(rows, study.higherMinutes), htfsByTime = new Map(htfs.map((row, i) => [row.time, i]));
    const ltfs = groups(rows, study.lowerMinutes), ltfByClose = new Map(ltfs.map(row => [row.end, row]));
    const bySignal = new Map();
    for (const event of study.events) { const values = bySignal.get(event.signalId) ?? []; values.push(event); bySignal.set(event.signalId, values); }
    const expectedFormed = new Set();
    for (let i = 1; i < htfs.length; i++) {
      const prior = htfs[i - 1], c2 = htfs[i];
      if (c2.low < prior.low && c2.close > prior.low) expectedFormed.add(`^NSEI:${study.higherMinutes}-${study.lowerMinutes}:${c2.time}:bullish`);
      if (c2.high > prior.high && c2.close < prior.high) expectedFormed.add(`^NSEI:${study.higherMinutes}-${study.lowerMinutes}:${c2.time}:bearish`);
    }
    const actualFormed = new Set(study.events.filter(e => e.type === 'formed').map(e => e.signalId));
    check(expectedFormed.size === actualFormed.size && [...expectedFormed].every(id => actualFormed.has(id)), `${label}: raw C2 sweep set differs`);
    const seen = new Set();
    let previous = null;
    for (const trade of study.trades) {
      const prefix = `${label}/${trade.signalId}`;
      check(!seen.has(trade.signalId), `${prefix}: duplicate trade`); seen.add(trade.signalId);
      check(!previous || (previous.status === 'closed' && previous.exitTime <= trade.entryTime), `${prefix}: overlapping or unknown prior position`);
      previous = trade;
      const signal = bySignal.get(trade.signalId);
      const confirmation = signal?.find(e => e.type === 'confirmed'), formed = signal?.find(e => e.type === 'formed');
      const entryEvent = signal?.find(e => e.type === 'entry');
      const c2Time = Number(trade.signalId.split(':').at(-2)), c2 = htfs[htfsByTime.get(c2Time)];
      const bull = trade.direction === 'bullish';
      check(c2 && trade.stopLoss === (bull ? c2.low : c2.high), `${prefix}: wrong exact C2 stop`);
      check(formed?.time === c2?.end, `${prefix}: incomplete C2 used`);
      const index = byTime.get(trade.entryTime - M), entryCandle = rows[index];
      check(entryCandle?.close === trade.entry && entryEvent?.price === trade.entry, `${prefix}: wrong confirming-close fill`);
      check(entryEvent?.availableAt === trade.entryTime && confirmation?.availableAt <= trade.entryTime && formed?.availableAt <= trade.entryTime, `${prefix}: future entry information`);
      const entryLtf = ltfByClose.get(trade.entryTime);
      check(entryLtf && (bull ? entryLtf.low >= trade.stopLoss : entryLtf.high <= trade.stopLoss), `${prefix}: entry candle already breached C2`);
      if (confirmation?.time > formed?.time) {
        const confirmedCandle = rows[byTime.get(confirmation.time - M)];
        check(confirmedCandle && (bull ? confirmedCandle.close > confirmation.price : confirmedCandle.close < confirmation.price), `${prefix}: non-strict CISD confirmation`);
      }
      check(trade.risk > 0 && closeEnough(trade.risk, Math.abs(trade.entry - trade.stopLoss)) && closeEnough(trade.target, trade.entry + (bull ? 2 : -2) * trade.risk), `${prefix}: risk/target arithmetic`);
      check(!signal.some(e => ['invalidated', 'finished'].includes(e.type) && e.availableAt <= trade.entryTime), `${prefix}: terminal before entry`);
      let result = null;
      for (let i = index + 1; i < rows.length && rows[i].time < report.settings.testEnd; i++) {
        const row = rows[i];
        let price, reason, time = row.time, ambiguous = false;
        if (bull ? row.open <= trade.stopLoss : row.open >= trade.stopLoss) { price = row.open; reason = 'stop_gap'; }
        else if (bull ? row.open >= trade.target : row.open <= trade.target) { price = trade.target; reason = 'target'; }
        else if (signal.some(e => e.type === 'invalidated' && e.availableAt <= row.time)) { price = row.open; reason = 'invalidation'; }
        else {
          const stopHit = bull ? row.low <= trade.stopLoss : row.high >= trade.stopLoss;
          const targetHit = bull ? row.high >= trade.target : row.low <= trade.target;
          time += M;
          if (stopHit) { price = trade.stopLoss; reason = 'stop'; ambiguous = targetHit; }
          else if (targetHit) { price = trade.target; reason = 'target'; }
          else if (study.mode === 'daily_exit' && time === limits(row.time).close) { price = row.close; reason = 'session_close'; }
        }
        if (reason) { result = { price, reason, time, ambiguous }; break; }
      }
      if (result) {
        check(trade.status === 'closed' && trade.exit === result.price && trade.exitTime === result.time && trade.exitReason === result.reason && trade.ambiguousBar === result.ambiguous, `${prefix}: exit path mismatch`);
        const points = (bull ? 1 : -1) * (result.price - trade.entry);
        check(closeEnough(trade.grossPoints, points) && closeEnough(trade.r, points / trade.risk), `${prefix}: P&L arithmetic`);
      } else check(trade.status === 'open' && trade.exit === null && trade.r === null, `${prefix}: invented year-end exit`);
      if (study.mode === 'daily_exit') check(localDay(trade.entryTime) === localDay(trade.exitTime), `${prefix}: daily mode overnight exposure`);
    }
    const closed = study.trades.filter(t => t.status === 'closed').sort((a, b) => a.exitTime - b.exitTime);
    let equity = 0, peak = 0, dd = 0, wins = 0, losses = 0, flat = 0, gains = 0, lossR = 0;
    for (const t of closed) {
      const r = (t.direction === 'bullish' ? t.exit - t.entry : t.entry - t.exit) / t.risk;
      equity += r; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity);
      if (r > 1e-10) { wins++; gains += r; } else if (r < -1e-10) { losses++; lossR -= r; } else flat++;
    }
    check(closed.length === study.summary.closedTrades && wins === study.summary.wins && losses === study.summary.losses && flat === study.summary.breakeven && closeEnough(equity, study.summary.totalR) && closeEnough(dd, study.summary.maxDrawdownR) && closeEnough(gains / lossR, study.summary.profitFactorR), `${label}: summary mismatch`);
    audited.push({ feed, mode: study.mode, pair: `${study.higherMinutes}/${study.lowerMinutes}`, c2SignalsChecked: actualFormed.size, tradesChecked: study.trades.length, closed: closed.length, open: study.trades.length - closed.length, totalR: equity, maxDrawdownR: dd });
  }
}
const audit = { generatedAt: new Date().toISOString(), method: 'Root agent audit: independent raw-candle aggregation, complete C2 sweep-set reconciliation, exact stops, causal close/availability, every post-entry minute price path, gap fills, session exits, overlap, year-end open states and summary arithmetic. No indicator/simulator imports.', reportSha256: createHash('sha256').update(rawReport).digest('hex'), failures, audited };
await writeFile(`${out}/implementation-audit.json`, JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ tradesChecked: audited.reduce((n, s) => n + s.tradesChecked, 0), failures: failures.length, firstFailures: failures.slice(0, 10) }));
if (failures.length) process.exitCode = 1;
