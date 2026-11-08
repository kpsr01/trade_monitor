import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
const out = 'reports/backtest-2025-simple', data = 'reports/backtest-2025-comparison/data';
const compiled = path.resolve('artifacts/simple-year-build');
await mkdir(compiled, { recursive: true }); await mkdir(`${out}/code`, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex'), sourceHashes = {};
for (const name of ['indicator', 'backtest', 'simple-strategy', 'simple-backtest']) {
  const source = await readFile(`src/lib/${name}.ts`, 'utf8'); sourceHashes[name] = sha(source);
  await writeFile(`${compiled}/${name}.mjs`, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/from ['"]\.\/([^'"]+)['"]/g, "from './$1.mjs'"));
  await copyFile(`src/lib/${name}.ts`, `${out}/code/${name}.ts`);
}
const { runSimpleBacktest, summarizeIndependentTrades } = await import(pathToFileURL(`${compiled}/simple-backtest.mjs`).href);
const audit = JSON.parse(await readFile(`${data}/data-audit.json`, 'utf8'));
const settings = { instrument: '^NSEI', testStart: Date.parse('2025-01-01T09:15:00+05:30'), testEnd: Date.parse('2026-01-01T00:00:00+05:30'), executionEndMinutes: 930,
  nonTradingDates: audit.nonTradingDates, sessionOverrides: audit.sessionOverrides, roundTripCostPoints: 0 };
const ist = t => t === null ? '' : new Date(t + 330 * 60_000).toISOString().replace('T', ' ').replace('.000Z', ' IST');
const studies = [];
for (const [feed, file, hash] of [['Technovus', 'minute-candles.json', audit.dataSha256], ['Kaggle v18', 'minute-candles-kaggle.json', audit.mirrorCheck.alternateDataSha256]]) {
  const raw = await readFile(`${data}/${file}`, 'utf8'); if (sha(raw) !== hash) throw new Error('Frozen data changed.');
  const candles = JSON.parse(raw);
  for (const [higherMinutes, lowerMinutes] of [[60, 5], [30, 3], [15, 1]]) for (const mode of ['daily_exit', 'carry']) {
    const result = runSimpleBacktest({ ...settings, candles, higherMinutes, lowerMinutes, holdingMode: mode });
    const monthly = Array.from({ length: 12 }, (_, n) => { const month = `2025-${String(n + 1).padStart(2, '0')}`; return { month, ...summarizeIndependentTrades(result.trades.filter(t => t.status === 'closed' && ist(t.exitTime).startsWith(month))) }; });
    const costSensitivity = summarizeIndependentTrades(result.trades.map(t => t.status === 'closed' ? { ...t, points: t.grossPoints - 1, r: (t.grossPoints - 1) / t.risk } : t));
    const exitCounts = result.trades.reduce((a, t) => { const key = t.exitReason ?? t.status; a[key] = (a[key] ?? 0) + 1; return a; }, {});
    if (result.summary.unresolvedTrades || exitCounts.invalidation) throw new Error('Unexpected gap or strategy invalidation exit.');
    if (mode === 'carry' && exitCounts.session_close) throw new Error('Forced exit in carry mode.');
    if (mode === 'daily_exit' && result.trades.some(t => t.status !== 'closed' || ist(t.entryTime).slice(0, 10) !== ist(t.exitTime).slice(0, 10))) throw new Error('Daily mode carried.');
    if (Object.keys(result.summary.skippedCounts).some(k => !['before_test', 'after_test', 'outside_execution_session'].includes(k))) throw new Error('Unexpected entry filter.');
    const study = { feed, mode, ...result, monthly, costSensitivity, exitCounts }; studies.push(study);
    console.log(JSON.stringify({ feed, pair: `${higherMinutes}/${lowerMinutes}`, mode, ...result.summary, maxConcurrentPositions: result.maxConcurrentPositions, exitCounts }));
  }
}
const assumptions = [
  'HTF strictly sweeps the previous HTF high and closes below it for bearish; strictly sweeps the low and closes above it for bullish. All HTFs must be closed and complete.',
  'Freeze the same CantoLab directional-run CISD level at the sweep close. Ignore all earlier reclaim flags. Only LTF candles starting at or after that HTF close may confirm, using a strict close beyond the frozen level. This is a close-beyond predicate, not a new crossover requirement.',
  'Entry and R both use the later CISD confirming close, as explicitly selected by the user. SL is the exact sweep high/low. TP is entry plus/minus twice the entry-to-stop distance. Non-positive risk cannot be traded.',
  'No C3/C4 expiry, T-spot invalidation, same-direction replacement, pre-entry wick rejection, or strategy invalidation exit. Pending sweeps wait without a time limit. One entry per sweep; no repeated entries from the same sweep.',
  'Every qualifying sweep trades independently. Simultaneous opposite positions, overlapping positions and multiple sweeps confirmed by the same candle are all included. The card display does not select trades.',
  'Both modes start flat on 1 January 2025; December 16-31, 2024 warms the indicator, so unconfirmed December sweeps can still confirm in January. Carry exits only at SL/TP. Daily mode additionally exits at the actual session close (normally 15:30, Muhurat 14:45), with no new entry at that closing instant.',
  'Evaluate SL/TP only after entry. Stop gaps fill at the subsequent open; target gaps at the target. Same-minute double hits use stop first. Stops can lose more than 1R across gaps. Open horizon positions have no realized P&L.',
  'Realized R is summed per independent trade. Simultaneous exit timestamps are grouped for drawdown. This is not account percentage return; concurrent trades require concurrent risk exposure. No capital, margin, netting or compounding constraints are imposed.',
  'Both frozen public archives cover 249 sessions and 93,060 minute candles in 2025. Verified holidays, Budget Saturday and Muhurat hours are included. The archives differ on 6,847 OHLC rows (7.36%). No minute data is invented or forward-filled.',
  'A missing data path would leave its exposed position unresolved; it would not block unrelated later trades. Missing LTF data resets pending confirmation state because an intervening CISD cannot be determined.',
  'Gross theoretical index results assume immediate close-price information. Delayed Yahoo cannot be assumed to obtain these fills. Options premiums, strikes, expiries, spreads and Greeks are not modelled. One-index-point cost sensitivity is illustrative only.',
  'The CISD level code is source-derived. The simplified lifecycle is deliberately different from the full Pine indicator, and has not been executed in TradingView Pine runtime.',
];
const report = { generatedAt: new Date().toISOString(), title: '2025 NIFTY: simplified post-sweep CISD close / exact stop / 2R', strategy: 'sweep-post-cisd-close-2r', settings,
  yearSessions: audit.yearSessions, yearCandles: audit.yearCandles, provenance: { sourceHashes, dataSha256: audit.dataSha256, alternateDataSha256: audit.mirrorCheck.alternateDataSha256, pineCommit: '1bb53262deba9456f2b1a85d15c6ac5a5e880cf7' }, assumptions, studies };
await writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await copyFile('scripts/run-simple-year-backtest.mjs', `${out}/code/run-simple-year-backtest.mjs`);
const e = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n, digits = 2) => n === null ? 'N/A' : Number(n).toFixed(digits), signed = n => `${n >= 0 ? '+' : ''}${fmt(n)}`;
const pair = s => `${s.higherMinutes === 60 ? '1H' : s.higherMinutes + 'M'} → ${s.lowerMinutes}M`, mode = s => s.mode === 'carry' ? 'Carry' : 'Daily exit';
const table = rows => `<div class="scroll"><table><thead><tr><th>Window</th><th>Mode</th><th>Closed</th><th>Wins / losses</th><th>Win rate</th><th>Total R</th><th>PF</th><th>Realized DD</th><th>Open</th><th>Peak concurrent</th><th>After 1pt cost</th></tr></thead><tbody>${rows.map(s => `<tr><th>${pair(s)}</th><td>${mode(s)}</td><td>${s.summary.closedTrades}</td><td>${s.summary.wins} / ${s.summary.losses}</td><td>${fmt(100 * s.summary.winRate, 1)}%</td><td>${signed(s.summary.totalR)}R</td><td>${fmt(s.summary.profitFactorR)}</td><td>${fmt(s.summary.maxDrawdownR)}R</td><td>${s.summary.openTrades}</td><td>${s.maxConcurrentPositions}</td><td>${signed(s.costSensitivity.totalR)}R</td></tr>`).join('')}</tbody></table></div>`;
const primary = studies.filter(s => s.feed === 'Technovus');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simple C2/CISD 2R · 2025</title><style>body{margin:0;background:#f5f6f1;color:#17231e;font:16px/1.6 system-ui,sans-serif}main{max-width:1400px;margin:auto;padding:36px 24px}h1{font-size:34px;line-height:1.2}h2{margin-top:38px}.notice{padding:18px;background:#e7eee3;border-left:4px solid #427353}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;background:white;font-size:14px;margin:18px 0}th,td{padding:10px;text-align:left;border-bottom:1px solid #dce1d7;white-space:nowrap}thead{background:#e4eadf}li{margin:12px 0}a{color:#285f40}details{padding:12px;border:1px solid #dce1d7;margin:12px 0}summary{cursor:pointer;font-weight:600}small{color:#5f6b63}code{overflow-wrap:anywhere}</style></head><body><main><small>SIMPLIFIED STRATEGY / FULL CALENDAR YEAR 2025</small><h1>HTF sweep → later LTF CISD close → 2R</h1><p>1 January–31 December 2025 · 249 sessions · 93,060 minute candles per archive · all three windows.</p><p class="notice"><strong>Entry and R both use the CISD close.</strong> No C3/C4 rules, replacement, overlap restriction or visibility filter. Every sweep gets an independent opportunity. Results are gross index R, not options profits or account returns.</p><h2>Primary archive: Technovus</h2>${table(primary)}<h2>Second archive: Kaggle v18</h2>${table(studies.filter(s => s.feed !== 'Technovus'))}<p>Both inputs are complete but disagree on 7.36% of yearly OHLC rows. Peak concurrent positions shows the added risk exposure from removing overlap restrictions. Realized drawdown excludes unrealized P&L.</p><h2>Monthly realized R — primary archive</h2><div class="scroll"><table><thead><tr><th>Exit month</th>${primary.map(s => `<th>${pair(s)} / ${mode(s)}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: 12 }, (_, n) => `<tr><th>2025-${String(n + 1).padStart(2, '0')}</th>${primary.map(s => `<td>${signed(s.monthly[n].totalR)}R</td>`).join('')}</tr>`).join('')}</tbody></table></div><h2>Exact rules and assumptions</h2><ol>${assumptions.map(a => `<li>${e(a)}</li>`).join('')}</ol><h2>Primary trade ledgers</h2>${primary.map(s => `<details><summary>${pair(s)} / ${mode(s)} / ${s.trades.length} positions</summary><p>Exit counts: ${e(JSON.stringify(s.exitCounts))}</p><div class="scroll"><table><thead><tr><th>Entry IST</th><th>Side</th><th>Entry</th><th>SL</th><th>TP</th><th>Exit IST</th><th>Exit</th><th>Reason</th><th>R</th></tr></thead><tbody>${s.trades.map(t => `<tr><td>${ist(t.entryTime)}</td><td>${t.direction}</td><td>${fmt(t.entry)}</td><td>${fmt(t.stopLoss)}</td><td>${fmt(t.target)}</td><td>${t.exitTime === null ? t.status : ist(t.exitTime)}</td><td>${fmt(t.exit)}</td><td>${t.exitReason ?? t.status}</td><td>${t.r === null ? t.status : signed(t.r)}</td></tr>`).join('')}</tbody></table></div></details>`).join('')}<h2>Evidence and reproduction</h2><p><a href="results.json">Full results, signals and ledgers</a> · <a href="audit.json">Independent source/entry/fill audit</a> · <a href="../backtest-2025-comparison/data/data-audit.json">Frozen data provenance</a> · <a href="../backtest-2025-comparison/report.html">Previous strategy, preserved separately</a></p><p><code>node scripts/run-simple-year-backtest.mjs</code><br><code>node scripts/audit-simple-year.mjs</code><br><code>npm test</code></p><small>Generated ${report.generatedAt}. Source snapshots and hashes are retained. No order execution.</small></main></body></html>`;
await writeFile(`${out}/report.html`, html);
console.log(`Saved ${out}/report.html`);
