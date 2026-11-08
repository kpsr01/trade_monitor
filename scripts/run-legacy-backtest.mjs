import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

// Reproducible analysis of the frozen data snapshot; no network or order calls.
const out = path.resolve('reports/backtest-2026-11-08');
const compiled = path.resolve('artifacts/legacy-backtest-build');
await mkdir(compiled, { recursive: true });
const sha = text => createHash('sha256').update(text).digest('hex');
const sourceHashes = {};
for (const name of ['indicator', 'backtest']) {
  const source = await readFile(`reports/backtest-2026-11-08/code/${name}.ts`, 'utf8');
  sourceHashes[name] = sha(source);
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  await writeFile(path.join(compiled, `${name}.mjs`), result.outputText.replace(/from ['"]\.\/indicator['"]/g, "from './indicator.mjs'"));
}
const { runBacktest, summarizeTrades } = await import(pathToFileURL(path.join(compiled, 'backtest.mjs')).href);
const rawData = await readFile(path.join(out, 'data/minute-candles.json'), 'utf8');
const candles = JSON.parse(rawData);
const audit = JSON.parse(await readFile(path.join(out, 'data/data-audit.json'), 'utf8'));
if (sha(rawData) !== audit.dataSha256) throw new Error('Frozen candle hash differs from the acquisition audit.');
const date = time => new Date(time + 330 * 60_000).toISOString().slice(0, 10);
const ist = time => time === null ? 'Unresolved' : new Date(time + 330 * 60_000).toISOString().replace('T', ' ').replace('.000Z', ' IST');
const sessions = [...new Set(candles.map(candle => date(candle.time)))];
const warmup = sessions[0];
if (!audit.sessions.find(session => session.day === warmup)?.complete) throw new Error('First warm-up session is incomplete.');
const testStart = Date.parse(`${sessions[1]}T09:15:00+05:30`);
const testEnd = Date.parse(`${sessions.at(-1)}T15:30:00+05:30`);
const settings = { instrument: '^NSEI', buffer: 1, tickSize: 0.05, testStart, testEnd, roundTripCostPoints: 0, sessionExitMinutes: 915 };
const assumptions = [
  'Theoretical NIFTY spot-index reference trades, not an executable index instrument or options-premium P&L.',
  'Identical frozen one-minute input and test period for all three timeframe combinations. First full session is warm-up only. No parameter tuning.',
  'C2 and CISD use the existing causal TypeScript port. A prefix evaluation at each entry must show the same confirmed signal; hidden/ambiguous signals are skipped.',
  'Entry is the next lower-timeframe open only if the confirmation was causally available by then. Late C3/C4 confirmations cannot receive retrospective fills.',
  'One position per combination at a time; overlapping signals are skipped. Results are independent and are not a combined portfolio.',
  'Stop beyond C2 wick by 1 index point, rounded outward to 0.05. Target is 2 times initial risk. Each trade contributes its own R without compounding.',
  'Resting stops/targets are checked on minute OHLC. If both are touched in one minute, stop is assumed first. Stop gaps fill at the adverse open; targets fill at the target.',
  'A post-entry indicator invalidation exits at the next minute open at or after causal availability, unless a resting bracket fills first. Setup expiry/replacement alone does not close an entered position.',
  'No new entry at/after 15:15 IST. Remaining positions close at the 15:14 minute candle close (15:15), before the closing-auction tail. Raw auction-period bars remain in indicator history for subsequent sessions.',
  'Missing execution minutes make exposed trades unresolved; these are disclosed and excluded from resolved P&L, not guessed. No overnight position or re-entry for the same signal.',
  'Gross baseline excludes fees, spread and slippage. A separate flat 1-index-point round-trip deduction is only an illustrative cost sensitivity, not an estimate of options costs.',
  'This is zero-feed-delay theoretical execution. The delayed Yahoo dashboard cannot obtain these historical next-open fills. Its rolling five-session history also differs from this continuous historical replay.',
  'Small single-month sample with Yahoo data-quality limitations; no claim of future returns, statistical significance, independent exchange-data parity or Pine-runtime certification.',
];
const results = [];
const partialDates = new Set(audit.sessions.filter(session => !session.complete).map(session => session.day));
for (const [higherMinutes, lowerMinutes] of [[60, 5], [30, 3], [15, 1]]) {
  const result = runBacktest({ ...settings, candles, higherMinutes, lowerMinutes });
  const costTrades = result.trades.map(trade => trade.status === 'closed' ? { ...trade, points: trade.grossPoints - 1, r: (trade.grossPoints - 1) / trade.risk, roundTripCostPoints: 1 } : trade);
  const costSensitivity = summarizeTrades(costTrades, result.skipped);
  // Separate sensitivity only: the primary keeps the predeclared full-period policy.
  const completeSessionSensitivity = summarizeTrades(result.trades.filter(trade => !partialDates.has(date(trade.entryTime))));
  const exitCounts = {};
  for (const trade of result.trades) exitCounts[trade.exitReason] = (exitCounts[trade.exitReason] ?? 0) + 1;
  const perDay = sessions.slice(1).map(day => ({ day, ...summarizeTrades(result.trades.filter(trade => date(trade.entryTime) === day)) }));
  results.push({ ...result, costSensitivity, completeSessionSensitivity, exitCounts, perDay });
  console.log(JSON.stringify({ pair: `${higherMinutes}/${lowerMinutes}`, ...result.summary, cost1PointTotalR: costSensitivity.totalR, exitCounts }));
}
const report = {
  generatedAt: new Date().toISOString(), title: 'C2 Fractal NIFTY index backtest', settings,
  coverage: { rawFrom: sessions[0], rawTo: sessions.at(-1), warmup, testFrom: sessions[1], testTo: sessions.at(-1), sessions: sessions.length - 1, rawMinuteCount: candles.length, partialSessions: audit.sessions.filter(session => !session.complete).map(session => ({ day: session.day, bars: session.bars, missingMinutes: session.missingMinutes })) },
  provenance: { candleSha256: sha(rawData), sourceHashes, auditFile: 'data/data-audit.json', pineCommit: '1bb53262deba9456f2b1a85d15c6ac5a5e880cf7' },
  assumptions, qualityFlags: audit.qualityFlags, results,
};
await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
const fmt = (value, digits = 2) => value === null ? 'N/A' : Number(value).toFixed(digits);
const signed = value => `${value >= 0 ? '+' : ''}${fmt(value)}`;
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const pair = result => `${result.higherMinutes === 60 ? '1H' : result.higherMinutes + 'M'} → ${result.lowerMinutes}M`;
const summaryRows = results.map(result => {
  const s = result.summary;
  return `<tr><th>${pair(result)}</th><td>${s.closedTrades}</td><td>${s.wins} / ${s.losses} / ${s.breakeven}</td><td>${s.winRate === null ? 'N/A' : fmt(s.winRate * 100, 1) + '%'}</td><td class="${s.totalR >= 0 ? 'positive' : 'negative'}">${signed(s.totalR)}R</td><td>${signed(s.averageR ?? 0)}R</td><td>${s.profitFactorR === null && s.wins > 0 ? '∞' : fmt(s.profitFactorR)}</td><td>${fmt(s.maxDrawdownR)}R</td><td>${s.unresolvedTrades}</td></tr>`;
}).join('');
const tradeSections = results.map(result => `<section><h2>${pair(result)} — trade ledger</h2><p>Exit counts: ${escape(JSON.stringify(result.exitCounts))}. Skipped entries: ${escape(JSON.stringify(result.summary.skippedCounts))}. Ambiguous stop/target candles: ${result.summary.ambiguousTrades}.</p><div class="scroll"><table><thead><tr><th>Entry · IST</th><th>Direction</th><th>Entry</th><th>Stop</th><th>Target</th><th>Exit · IST</th><th>Exit</th><th>Reason</th><th>Result</th></tr></thead><tbody>${result.trades.map(trade => `<tr><td>${ist(trade.entryTime)}</td><td>${trade.direction}</td><td>${fmt(trade.entry)}</td><td>${fmt(trade.stopLoss)}</td><td>${fmt(trade.target)}</td><td>${ist(trade.exitTime)}</td><td>${fmt(trade.exit)}</td><td>${trade.exitReason}</td><td>${trade.r === null ? 'Unresolved' : signed(trade.r) + 'R'}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>C2 Fractal — NIFTY backtest</title><style>
body{font:16px/1.6 system-ui,sans-serif;color:#17231e;background:#f5f6f1;margin:0}main{max-width:1250px;margin:0 auto;padding:40px 24px}h1{font-size:36px;line-height:1.2}h2{margin-top:36px}small,.muted{color:#5d6860}.notice{padding:18px;border-left:4px solid #9c792e;background:#fff5dc}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:18px 0;background:white}th,td{padding:12px;border-bottom:1px solid #dce1d7;text-align:left;white-space:nowrap}thead{background:#e5ebdf}.positive{color:#237343;font-weight:bold}.negative{color:#ae3b36;font-weight:bold}a{color:#245b3b}li{margin:8px 0}code{overflow-wrap:anywhere;font-size:12px}@media print{body{background:white}main{max-width:none;padding:0}table{font-size:10px}th,td{padding:5px}section{break-inside:avoid}}</style></head><body><main>
<small>C2 FRACTAL / RESEARCH RESULT / 08 NOVEMBER 2026</small><h1>NIFTY index backtest</h1><p><strong>${report.coverage.testFrom} to ${report.coverage.testTo}</strong> · ${report.coverage.sessions} available sessions · ${warmup} warm-up · 1-point buffer · 2R target · 15:15 exit cutoff.</p>
<p class="notice"><strong>Theoretical gross index results, not options profits.</strong> These fills assume confirmation data is available immediately. The delayed dashboard cannot reproduce them. No fees, spreads or slippage are included in the main table.</p>
<div class="scroll"><table><thead><tr><th>Window</th><th>Closed trades</th><th>Wins / losses / flat</th><th>Win rate</th><th>Total</th><th>Average</th><th>Profit factor (R)</th><th>Max drawdown</th><th>Unresolved</th></tr></thead><tbody>${summaryRows}</tbody></table></div><p><strong>1R</strong> is one trade's initial entry-to-stop risk. Win rate counts any positive exit, including early invalidation/session exits. It is not the percentage reaching 2R. Drawdown is based on realized closed-trade R, not mark-to-market equity.</p>
<h2>Illustrative cost sensitivity</h2><p>Deducting one index point from each completed trade gives: ${results.map(result => `${pair(result)} <strong>${signed(result.costSensitivity.totalR)}R</strong>`).join(' · ')}. This is not an estimate of actual options trading costs.</p>
<h2>Data and limitations</h2><p>${candles.length.toLocaleString()} raw minute candles across ${sessions.length} sessions. ${audit.completeSessionCount} full sessions; 15 October has a 12-minute gap (11:45–11:56 IST), and 20 October has no data. The gap is not filled. Yahoo's five-minute data agrees with the minute aggregation for 1,422 complete buckets; both are the same source.</p><p>Repeated flat prices after 15:15 and a final closing-price jump are consistent with closing-auction/finalization behavior. Execution ends before this tail. Auction bars remain available to the indicator on subsequent days. See <a href="https://www.nseindia.com/market-data/closing-auction-session">NSE closing-auction information</a>.</p>
<p><strong>The 15M → 1M total excludes one unresolved trade exposed to the missing minutes; its full-period return is therefore not completely known.</strong> As a separate data-completeness sensitivity, excluding all entries on the partial session (15 October) from every window gives: ${results.map(result => `${pair(result)} <strong>${signed(result.completeSessionSensitivity.totalR)}R</strong> (${result.completeSessionSensitivity.closedTrades} closed trades)`).join(' · ')}. This does not replace the primary full-period policy or select dates based on profitability.</p>
<h2>Rules used</h2><ol>${assumptions.map(item => `<li>${escape(item)}</li>`).join('')}</ol>
${tradeSections}<h2>Reproduce and audit</h2><p>Run <code>node scripts/run-legacy-backtest.mjs</code> against the frozen dataset. <a href="results.json">Full results and event logs (JSON)</a> · <a href="data/data-audit.json">Data provenance and quality audit</a> · <a href="data/minute-candles.json">Frozen candles</a>.</p><p>Data SHA-256: <code>${report.provenance.candleSha256}</code></p><p class="muted">Generated ${escape(report.generatedAt)}. The port's documented causal differences from Pine remain applicable. No parameter search or performance-based selection was performed.</p></main></body></html>`;
await writeFile(path.join(out, 'report.html'), html);
console.log(`Saved ${path.join(out, 'report.html')}`);
