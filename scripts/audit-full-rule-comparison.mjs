import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { referenceSignals, comparableEvent } from './lib/pine-reference.mjs';
const out = 'reports/backtest-2025-full-rules', data = 'reports/backtest-2025-comparison/data';
const rawReport = await readFile(`${out}/results.json`, 'utf8'), report = JSON.parse(rawReport);
const rawBaseline = await readFile('reports/backtest-2025-simple/results.json', 'utf8'), baseline = JSON.parse(rawBaseline);
const baselineAudit = JSON.parse(await readFile('reports/backtest-2025-simple/audit.json', 'utf8'));
const sha = v => createHash('sha256').update(v).digest('hex'), failures = [], audited = [];
const check = (ok, text) => { if (!ok) failures.push(text); }, near = (a, b) => a === b || Math.abs(a - b) < 1e-7;
const M = 60_000, D = 86400000, IST = 330 * M;
const sessionEnd = time => {
  const key = new Date(time + IST).toISOString().slice(0, 10);
  return Math.floor((time + IST) / D) * D - IST + (report.settings.sessionOverrides[key]?.closeMinutes ?? 930) * M;
};
check(baselineAudit.reportSha256 === sha(rawBaseline) && baselineAudit.failures.length === 0, 'Baseline audit is absent/stale/failed');
for (const [name, hash] of Object.entries(report.provenance.sourceHashes)) check(hash === sha(await readFile(`src/lib/${name}.ts`)), `Stale source ${name}`);
for (const [feed, file, hash] of [['Technovus', 'minute-candles.json', report.provenance.dataSha256], ['Kaggle v18', 'minute-candles-kaggle.json', report.provenance.alternateDataSha256]]) {
  const raw = await readFile(`${data}/${file}`, 'utf8'), rows = JSON.parse(raw); check(hash === sha(raw), `${feed}: data hash`);
  const indexAtClose = new Map(rows.map((r, i) => [r.time + M, i]));
  for (const [higherMinutes, lowerMinutes] of [[60, 5], [30, 3], [15, 1]]) {
    const reference = referenceSignals({ candles: rows, higherMinutes, lowerMinutes, instrument: '^NSEI', sessionOverrides: report.settings.sessionOverrides, postSweepOnly: true });
    const refById = new Map(reference.events.map(e => [e.id, e])), refGroups = new Map(reference.signals.map(s => [s.signalId, s]));
    const htfIndex = new Map(reference.higher.map((c, i) => [c.time, i]));
    for (const study of report.studies.filter(s => s.feed === feed && s.higherMinutes === higherMinutes)) {
      const label = `${feed}/${higherMinutes}/${study.variant}`, full = study.variant === 'new_full_rules';
      let expectedEvents, expectedSignals;
      if (full) {
        const actualEvents = new Map(study.events.map(e => [e.id, e]));
        check(actualEvents.size === refById.size && actualEvents.size === study.events.length, `${label}: event set cardinality`);
        for (const [id, e] of refById) check(actualEvents.has(id) && JSON.stringify(comparableEvent(actualEvents.get(id))) === JSON.stringify(comparableEvent(e)), `${label}/${id}: source lifecycle mismatch`);
        check(study.signals.length === reference.signals.length, `${label}: sweep count`);
        for (const s of study.signals) {
          const ref = refGroups.get(s.signalId), h = htfIndex.get(s.c2At), c1 = reference.higher[h - 1], c2 = reference.higher[h], c3 = reference.higher[h + 1];
          check(ref && ref.fixed.price === s.cisdLevel && (ref.fixed.index === null ? s.levelAt === null : reference.lower[ref.fixed.index].time === s.levelAt), `${label}/${s.signalId}: frozen CISD`);
          check(s.c1?.time === c1.time && s.c1.high === c1.high && s.c1.low === c1.low && s.formedAt === c2.closeTime && s.stopLoss === (s.direction === 'bullish' ? c2.low : c2.high), `${label}/${s.signalId}: C1/C2`);
          if (s.entryAt !== null) check(s.confirmedAt > s.formedAt && s.confirmationAvailableAt <= s.entryAt && s.confirmationPhase === (c3 && s.confirmationAvailableAt > c3.closeTime ? 'C4' : 'C3'), `${label}/${s.signalId}: post-sweep phase/timing`);
        }
        expectedEvents = reference.events;
        expectedSignals = reference.signals.map(s => {
          const formed = s.events.find(e => e.type === 'formed'), entry = s.events.find(e => e.type === 'entry'), confirmed = s.events.find(e => e.type === 'confirmed');
          return { signalId: s.signalId, direction: formed.direction, entryAt: entry?.time ?? null, entry: entry?.price ?? null, stopLoss: formed.price, confirmedAt: confirmed?.time ?? null, confirmationAvailableAt: confirmed?.availableAt ?? null };
        });
      } else {
        const saved = baseline.studies.find(s => s.feed === feed && s.higherMinutes === higherMinutes && s.mode === 'daily_exit');
        for (const key of ['trades', 'summary', 'signals', 'events', 'skipped']) check(JSON.stringify(study[key]) === JSON.stringify(saved[key]), `${label}: independently audited baseline changed (${key})`);
        expectedEvents = saved.events; expectedSignals = saved.signals.map(s => ({ ...s, confirmationAvailableAt: s.confirmedAt }));
      }
      const eligible = expectedSignals.filter(s => s.entryAt !== null && s.entryAt >= report.settings.testStart && s.entryAt < report.settings.testEnd && s.entryAt < sessionEnd(s.entryAt));
      const byId = new Map(study.trades.map(t => [t.signalId, t]));
      check(eligible.length === study.trades.length && byId.size === study.trades.length && eligible.every(s => byId.has(s.signalId)), `${label}: hidden/overlap/duplicate entry filter`);
      const invalidations = new Map();
      if (full) for (const e of expectedEvents) if (e.type === 'invalidated') invalidations.set(e.signalId, e.availableAt);
      for (const s of eligible) {
        const t = byId.get(s.signalId); if (!t) continue;
        const bull = s.direction === 'bullish', risk = bull ? s.entry - s.stopLoss : s.stopLoss - s.entry, target = s.entry + (bull ? 2 : -2) * risk;
        check(t.entry === s.entry && t.entryTime === s.entryAt && t.stopLoss === s.stopLoss && near(t.target, target) && near(t.risk, risk) && t.confirmedAt === s.confirmedAt && t.confirmationAvailableAt === s.confirmationAvailableAt, `${label}/${s.signalId}: execution levels/availability`);
        const start = indexAtClose.get(s.entryAt); let fill = null;
        for (let i = start + 1; i < rows.length && rows[i].time < report.settings.testEnd; i++) {
          const r = rows[i]; let price, time = r.time, reason, ambiguous = false;
          if (bull ? r.open <= s.stopLoss : r.open >= s.stopLoss) { price = r.open; reason = 'stop_gap'; }
          else if (bull ? r.open >= target : r.open <= target) { price = target; reason = 'target'; }
          else if ((invalidations.get(s.signalId) ?? Infinity) <= r.time) { price = r.open; reason = 'invalidation'; }
          else {
            time += M;
            const stop = bull ? r.low <= s.stopLoss : r.high >= s.stopLoss, hitTarget = bull ? r.high >= target : r.low <= target;
            if (stop) { price = s.stopLoss; reason = 'stop'; ambiguous = hitTarget; }
            else if (hitTarget) { price = target; reason = 'target'; }
            else if (time === sessionEnd(r.time)) { price = r.close; reason = 'session_close'; }
          }
          if (reason) { fill = { price, time, reason, ambiguous }; break; }
        }
        const pnl = fill ? (bull ? 1 : -1) * (fill.price - s.entry) : null;
        check(fill && t.status === 'closed' && t.exit === fill.price && t.exitTime === fill.time && t.exitReason === fill.reason && t.ambiguousBar === fill.ambiguous && near(t.r, pnl / risk) && near(t.grossPoints, pnl), `${label}/${s.signalId}: minute path/P&L`);
      }
      const byTime = new Map(); let total = 0, wins = 0, losses = 0, gain = 0, loss = 0, net = 0;
      for (const t of study.trades) {
        total += t.r; net += (t.grossPoints - 1) / t.risk; if (t.r > 1e-10) { wins++; gain += t.r; } else if (t.r < -1e-10) { losses++; loss -= t.r; }
        byTime.set(t.exitTime, (byTime.get(t.exitTime) ?? 0) + t.r);
      }
      let equity = 0, high = 0, dd = 0;
      for (const [, r] of [...byTime].sort((a, b) => a[0] - b[0])) { equity += r; high = Math.max(high, equity); dd = Math.max(dd, high - equity); }
      check(near(total, study.summary.totalR) && near(net, study.costSensitivity.totalR) && near(gain / loss, study.summary.profitFactorR) && wins === study.summary.wins && losses === study.summary.losses && near(dd, study.summary.maxDrawdownR), `${label}: summary`);
      if (full) check(study.phaseBreakdown.reduce((n, p) => n + p.closedTrades, 0) === study.trades.length && near(study.phaseBreakdown.reduce((n, p) => n + p.totalR, 0), total), `${label}: phase totals`);
      audited.push({ feed, pair: `${higherMinutes}/${lowerMinutes}`, variant: study.variant, sourceEventsChecked: full ? reference.events.length : 0, tradesChecked: study.trades.length, totalR: total });
    }
  }
}
const result = { generatedAt: new Date().toISOString(), reportSha256: sha(rawReport), baselineSha256: sha(rawBaseline), referenceSha256: sha(await readFile('scripts/lib/pine-reference.mjs')),
  method: 'Independent per-C2 Pine-series/lifecycle reference with post-sweep gate; complete event/frozen-level/entry sets; audited unchanged simple baseline; independent minute fills, invalidation exits, 2R, grouped-time drawdown and cost arithmetic. No production engine imports.', failures, audited };
await writeFile(`${out}/audit.json`, JSON.stringify(result, null, 2)); await copyFile('scripts/audit-full-rule-comparison.mjs', `${out}/code/audit-full-rule-comparison.mjs`);
await copyFile('scripts/lib/pine-reference.mjs', `${out}/code/pine-reference.mjs`);
console.log(JSON.stringify({ tradesChecked: audited.reduce((n, r) => n + r.tradesChecked, 0), failures: failures.length, firstFailures: failures.slice(0, 8) }));
if (failures.length) process.exitCode = 1;
