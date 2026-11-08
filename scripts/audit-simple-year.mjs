import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { referenceGroups, referenceLevels } from './lib/pine-reference.mjs';

// No production indicator/backtest imports. Source-series translation and
// independent raw-minute reconstruction of every signal and position.
const out = 'reports/backtest-2025-simple', data = 'reports/backtest-2025-comparison/data';
const rawReport = await readFile(`${out}/results.json`, 'utf8'), report = JSON.parse(rawReport);
const sha = value => createHash('sha256').update(value).digest('hex');
const failures = [], results = [], M = 60_000, DAY = 86400000, IST = 330 * M;
const check = (condition, message) => { if (!condition) failures.push(message); };
const same = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-7);
const sessionClose = time => {
  const date = new Date(time + IST).toISOString().slice(0, 10);
  return Math.floor((time + IST) / DAY) * DAY - IST + (report.settings.sessionOverrides[date]?.closeMinutes ?? 930) * M;
};
for (const [name, hash] of Object.entries(report.provenance.sourceHashes)) check(sha(await readFile(`src/lib/${name}.ts`)) === hash, `Stale code: ${name}`);
for (const [feed, file, hash] of [['Technovus', 'minute-candles.json', report.provenance.dataSha256], ['Kaggle v18', 'minute-candles-kaggle.json', report.provenance.alternateDataSha256]]) {
  const raw = await readFile(`${data}/${file}`, 'utf8'), rows = JSON.parse(raw); check(sha(raw) === hash, `${feed}: data hash`);
  const indexAtTime = new Map(rows.map((r, i) => [r.time, i]));
  for (const higherMinutes of [60, 30, 15]) {
    const lowerMinutes = higherMinutes === 60 ? 5 : higherMinutes === 30 ? 3 : 1;
    const htfs = referenceGroups(rows, higherMinutes, report.settings.sessionOverrides), ltfs = referenceGroups(rows, lowerMinutes, report.settings.sessionOverrides);
    const levels = referenceLevels(ltfs, htfs), indexAtClose = new Map(ltfs.map((r, i) => [r.closeTime, i]));
    const expected = [];
    for (let h = 1; h < htfs.length; h++) for (const bull of [true, false]) {
      const c2 = htfs[h], prior = htfs[h - 1];
      if (!(bull ? c2.low < prior.low && c2.close > prior.low : c2.high > prior.high && c2.close < prior.high)) continue;
      const direction = bull ? 'bullish' : 'bearish', n = indexAtClose.get(c2.closeTime), fixed = levels[n][direction];
      const extreme = bull ? c2.low : c2.high;
      let entry = null, entryAt = null, target = null, invalid = false;
      if (fixed.price !== null) for (let j = n + 1; j < ltfs.length; j++) {
        const c = ltfs[j]; if (!(bull ? c.close > fixed.price : c.close < fixed.price)) continue;
        const risk = bull ? c.close - extreme : extreme - c.close;
        if (risk <= 0) invalid = true;
        else { entry = c.close; entryAt = c.closeTime; target = entry + (bull ? 2 : -2) * risk; }
        break;
      }
      expected.push({ signalId: `^NSEI:simple:${higherMinutes}-${lowerMinutes}:${c2.time}:${direction}`, direction, c2At: c2.time, formedAt: c2.closeTime,
        c2Extreme: extreme, stopLoss: extreme, cisdLevel: fixed.price, levelAt: fixed.index === null ? null : ltfs[fixed.index].time,
        entry, entryAt, confirmedAt: entryAt, target, status: invalid ? 'invalidated' : entryAt === null ? 'forming' : bull ? 'confirmed_bullish' : 'confirmed_bearish' });
    }
    for (const study of report.studies.filter(s => s.feed === feed && s.higherMinutes === higherMinutes)) {
      const prefix = `${feed}/${higherMinutes}/${study.mode}`, found = new Map(study.signals.map(s => [s.signalId, s]));
      check(found.size === expected.length && study.signals.length === expected.length, `${prefix}: complete C2 set`);
      const eventIds = new Set(study.events.map(e => e.id)); check(eventIds.size === study.events.length, `${prefix}: duplicate events`);
      for (const s of expected) {
        const actual = found.get(s.signalId);
        check(actual && Object.entries(s).every(([k, v]) => same(v, actual[k])), `${prefix}/${s.signalId}: frozen level / later confirmation / 2R mismatch`);
        const events = study.events.filter(e => e.signalId === s.signalId);
        check(events.filter(e => e.type === 'formed').length === 1 && !events.some(e => e.type === 'finished'), `${prefix}/${s.signalId}: formation/expiry`);
        const entry = events.find(e => e.type === 'entry'), confirmation = events.find(e => e.type === 'confirmed');
        check(s.entryAt === null ? !entry && !confirmation : entry?.time === s.entryAt && entry.availableAt === s.entryAt && entry.price === s.entry && confirmation?.time === s.entryAt && confirmation.price === s.cisdLevel, `${prefix}/${s.signalId}: event timing`);
      }
      const eligible = expected.filter(s => s.entryAt !== null && s.entryAt >= report.settings.testStart && s.entryAt < report.settings.testEnd && (study.mode === 'carry' || s.entryAt < sessionClose(s.entryAt)));
      const actualTrades = new Map(study.trades.map(t => [t.signalId, t]));
      check(actualTrades.size === eligible.length && actualTrades.size === study.trades.length && eligible.every(s => actualTrades.has(s.signalId)), `${prefix}: missing/filtered/duplicate entries`);
      for (const s of eligible) {
        const t = actualTrades.get(s.signalId); if (!t) continue;
        const bull = s.direction === 'bullish', risk = Math.abs(s.entry - s.stopLoss), start = indexAtTime.get(s.entryAt - M);
        check(t.entry === s.entry && t.stopLoss === s.stopLoss && same(t.target, s.target) && t.entryTime === s.entryAt && t.confirmedAt === s.entryAt && same(t.risk, risk), `${prefix}/${s.signalId}: trade levels`);
        let fill = null;
        for (let i = start + 1; i < rows.length && rows[i].time < report.settings.testEnd; i++) {
          const row = rows[i]; let price, reason, time = row.time, ambiguous = false;
          if (bull ? row.open <= s.stopLoss : row.open >= s.stopLoss) { price = row.open; reason = 'stop_gap'; }
          else if (bull ? row.open >= s.target : row.open <= s.target) { price = s.target; reason = 'target'; }
          else {
            time += M;
            const stop = bull ? row.low <= s.stopLoss : row.high >= s.stopLoss, target = bull ? row.high >= s.target : row.low <= s.target;
            if (stop) { price = s.stopLoss; reason = 'stop'; ambiguous = target; }
            else if (target) { price = s.target; reason = 'target'; }
            else if (study.mode === 'daily_exit' && time === sessionClose(row.time)) { price = row.close; reason = 'session_close'; }
          }
          if (reason) { fill = { price, reason, time, ambiguous }; break; }
        }
        if (fill) {
          const points = (bull ? 1 : -1) * (fill.price - s.entry);
          check(t.status === 'closed' && t.exit === fill.price && t.exitTime === fill.time && t.exitReason === fill.reason && t.ambiguousBar === fill.ambiguous && same(t.r, points / risk) && same(t.points, points), `${prefix}/${s.signalId}: fill/P&L`);
        } else check(t.status === 'open' && t.exit === null && t.r === null, `${prefix}/${s.signalId}: horizon position`);
      }
      const closed = study.trades.filter(t => t.status === 'closed'), byTime = new Map();
      let total = 0, positive = 0, negative = 0, wins = 0, losses = 0;
      for (const t of closed) {
        const r = (t.direction === 'bullish' ? t.exit - t.entry : t.entry - t.exit) / Math.abs(t.entry - t.stopLoss);
        total += r; if (r > 1e-10) { wins++; positive += r; } else if (r < -1e-10) { losses++; negative -= r; }
        byTime.set(t.exitTime, (byTime.get(t.exitTime) ?? 0) + r);
      }
      let eq = 0, peak = 0, dd = 0;
      for (const [, r] of [...byTime].sort((a, b) => a[0] - b[0])) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
      check(study.summary.closedTrades === closed.length && study.summary.wins === wins && study.summary.losses === losses && same(total, study.summary.totalR) && same(positive / negative, study.summary.profitFactorR) && same(dd, study.summary.maxDrawdownR), `${prefix}: aggregate metrics`);
      results.push({ feed, pair: `${higherMinutes}/${lowerMinutes}`, mode: study.mode, c2SignalsChecked: expected.length, tradesChecked: study.trades.length, totalR: total });
    }
  }
}
const audit = { generatedAt: new Date().toISOString(), method: 'Independent Pine-level series, per-sweep first subsequent LTF close, complete eligible-entry set, every post-entry minute path, exact SL/2R and P&L. No production engine imports.', reportSha256: sha(rawReport), failures, results };
await writeFile(`${out}/audit.json`, JSON.stringify(audit, null, 2));
await copyFile('scripts/audit-simple-year.mjs', `${out}/code/audit-simple-year.mjs`);
console.log(JSON.stringify({ tradesChecked: results.reduce((n, r) => n + r.tradesChecked, 0), failures: failures.length, firstFailures: failures.slice(0, 8) }));
if (failures.length) process.exitCode = 1;
