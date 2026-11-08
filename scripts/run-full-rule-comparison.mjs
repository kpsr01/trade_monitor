import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
const out = 'reports/backtest-2025-full-rules', data = 'reports/backtest-2025-comparison/data';
const compiled = path.resolve('artifacts/full-rule-build');
await mkdir(compiled, { recursive: true }); await mkdir(`${out}/code`, { recursive: true });
const sha = v => createHash('sha256').update(v).digest('hex'), sourceHashes = {};
for (const name of ['indicator', 'backtest', 'simple-strategy', 'simple-backtest', 'full-rule-backtest']) {
  const source = await readFile(`src/lib/${name}.ts`, 'utf8'); sourceHashes[name] = sha(source);
  await writeFile(`${compiled}/${name}.mjs`, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/from ['"]\.\/([^'"]+)['"]/g, "from './$1.mjs'"));
  await copyFile(`src/lib/${name}.ts`, `${out}/code/${name}.ts`);
}
const { runSimpleBacktest, summarizeIndependentTrades } = await import(pathToFileURL(`${compiled}/simple-backtest.mjs`).href);
const { runFullRuleBacktest } = await import(pathToFileURL(`${compiled}/full-rule-backtest.mjs`).href);
const audit = JSON.parse(await readFile(`${data}/data-audit.json`, 'utf8'));
const priorSimple = JSON.parse(await readFile('reports/backtest-2025-simple/results.json', 'utf8'));
const settings = { instrument: '^NSEI', testStart: Date.parse('2025-01-01T09:15:00+05:30'), testEnd: Date.parse('2026-01-01T00:00:00+05:30'), executionEndMinutes: 930,
  holdingMode: 'daily_exit', nonTradingDates: audit.nonTradingDates, sessionOverrides: audit.sessionOverrides, roundTripCostPoints: 0 };
const ist = t => t === null ? '' : new Date(t + 330 * 60_000).toISOString().replace('T', ' ').replace('.000Z', ' IST');
const studies = [];
for (const [feed, file, hash] of [['Technovus', 'minute-candles.json', audit.dataSha256], ['Kaggle v18', 'minute-candles-kaggle.json', audit.mirrorCheck.alternateDataSha256]]) {
  const raw = await readFile(`${data}/${file}`, 'utf8'); if (sha(raw) !== hash) throw new Error('Frozen data hash mismatch.');
  const candles = JSON.parse(raw);
  for (const [higherMinutes, lowerMinutes] of [[60, 5], [30, 3], [15, 1]]) for (const variant of ['previous_simple', 'new_full_rules']) {
    const result = (variant === 'previous_simple' ? runSimpleBacktest : runFullRuleBacktest)({ ...settings, candles, higherMinutes, lowerMinutes });
    if (variant === 'previous_simple') {
      const saved = priorSimple.studies.find(s => s.feed === feed && s.higherMinutes === higherMinutes && s.mode === 'daily_exit');
      for (const key of ['trades', 'summary', 'skipped']) if (JSON.stringify(saved[key]) !== JSON.stringify(result[key])) throw new Error(`Baseline changed: ${feed}/${higherMinutes}/${key}`);
    }
    if (result.summary.openTrades || result.summary.unresolvedTrades || result.trades.some(t => ist(t.entryTime).slice(0, 10) !== ist(t.exitTime).slice(0, 10))) throw new Error('Daily replay has overnight/unknown positions.');
    if (Object.keys(result.summary.skippedCounts).some(k => !['before_test', 'after_test', 'outside_execution_session'].includes(k))) throw new Error('Unexpected execution filter.');
    const monthly = Array.from({ length: 12 }, (_, n) => { const month = `2025-${String(n + 1).padStart(2, '0')}`; return { month, ...summarizeIndependentTrades(result.trades.filter(t => ist(t.exitTime).startsWith(month))) }; });
    const costSensitivity = summarizeIndependentTrades(result.trades.map(t => ({ ...t, points: t.grossPoints - 1, r: (t.grossPoints - 1) / t.risk })));
    const phaseBreakdown = variant === 'new_full_rules' ? ['C3', 'C4'].map(phase => ({ phase, ...summarizeIndependentTrades(result.trades.filter(t => t.confirmationPhase === phase)) })) : [];
    const exitCounts = result.trades.reduce((counts, t) => { counts[t.exitReason] = (counts[t.exitReason] ?? 0) + 1; return counts; }, {});
    const study = { feed, variant, ...result, monthly, costSensitivity, phaseBreakdown, exitCounts }; studies.push(study);
    console.log(JSON.stringify({ feed, pair: `${higherMinutes}/${lowerMinutes}`, variant, ...result.summary, costR: costSensitivity.totalR, maxConcurrent: result.maxConcurrentPositions, exitCounts, phases: phaseBreakdown.map(p => ({ phase: p.phase, trades: p.closedTrades, totalR: p.totalR })) }));
  }
}
const featureInventory = [
  { feature: 'C1', sourceLines: '478-479, 829-830', role: 'Previous HTF high/low swept by C2. Already present in both versions. No separate C1 entry.' },
  { feature: 'C2', sourceLines: '478-479, 525-545, 583-614', role: 'Strict HTF sweep/reclaim and exact wick. New variant restores pre-entry wick invalidation; entered trades retain the exact-wick bracket.' },
  { feature: 'C3', sourceLines: '525-545, 660-665', role: 'First HTF monitoring phase after C2. Its CISD-confirmed trades are included; its T-spot is visual context, not an independent touch entry.' },
  { feature: 'C4', sourceLines: '548-570, 619-665', role: 'Second monitoring phase. Include valid CISD entries; expire the setup after C4. Restore same-direction replacement of the monitored setup.' },
  { feature: 'T-spot', sourceLines: '484-500, 619-647', role: 'Zone between current HTF open and prior HTF midpoint. C4 invalidation can kill C4-only confirmations; prior-C3 confirmations survive that T-spot rule. A pre-confirmation invalid flag does not prevent later CISD, preserving the source quirk.' },
  { feature: 'CISD', sourceLines: '649-658, 709-777', role: 'Run-derived frozen level and strict closing-price confirmation. User requires the confirming candle after C2 closes, so early flags and C2-close confirmations are excluded in both variants.' },
  { feature: 'Early CISD', sourceLines: '344-354, 759-777', role: 'The source draws/alerts this during an HTF sweep. Excluded by the user’s post-sweep-only choice. No entry using a future final HTF wick.' },
  { feature: 'Equilibrium, deviation projections, HTF preview, sweep lines', sourceLines: '380-425, 490-500, 857-915', role: 'Drawings and projected price levels, not additional order-entry rules. User’s exact-wick 2R target remains fixed; no invented entries on touching a drawing.' },
];
const assumptions = [
  'Previous means the immediately preceding simplified post-sweep CISD strategy, not the older one-position full-indicator study. Both sides are rerun on identical 2025 data and calendars.',
  'Both variants: daily exit, strict post-sweep CISD, close-based entry and risk, exact C2 wick stop, 2R target, all visible/hidden/simultaneous/opposite qualifying entries, and no position cap. One entry per setup.',
  'New variant restores the source C3/C4 lifecycle, current-wick invalidation, T-spot invalidation and same-direction setup replacement. Replacement/expiry stop future setup monitoring; they do not liquidate an entered position.',
  'Explicit source invalidation exits an entered position at the next eligible minute open, after resting gap orders. Otherwise exits are SL, TP or actual daily close. This maps indicator invalidation to a trading exit; Pine itself places no orders.',
  'The final-C3 close is evaluated after C4 begins in the source. A late confirmation therefore enters at the first available closed C4 candle if it survives. The report preserves that causal timing instead of backfilling an earlier price; final-C4 closes cannot initiate a new entry.',
  'Original lookahead, retroactive labels and deletion of historical confirmations are not reproduced. The source is an indicator, not an executable trading strategy. Neutral bias is used.',
  'One year: 249 sessions, 93,060 minute bars per archive; December 16-31 warm-up. Verified Budget Saturday, Muhurat session and holidays. Normal 2025 session exit is 15:30; Muhurat 14:45.',
  'Stop touch fills; strict wick breach invalidates a setup. Entry-candle earlier wicks cannot exit a newly opened trade. Stop gaps fill at open; target gaps at target; within-minute double hits use stop first.',
  'Each R is the initial risk of an independent trade, not account return. Simultaneous exits are grouped for realized drawdown. Peak concurrent exposure is reported, not capped. No capital or margin model.',
  'Gross results exclude fees and slippage. One index point per trade is an illustrative sensitivity, not options execution costs. Theoretical index-close fills are not attainable merely because a delayed dashboard shows them.',
  'Both community archives are retained; their yearly OHLC disagrees on 6,847 rows. No minute data is fabricated or certified as exchange-perfect. Options prices, strikes and expiries are not simulated.',
];
const report = { generatedAt: new Date().toISOString(), title: 'Simple vs restored CantoLab lifecycle — daily exit, post-sweep CISD', settings, featureInventory, assumptions,
  provenance: { sourceHashes, pineCommit: '1bb53262deba9456f2b1a85d15c6ac5a5e880cf7', dataSha256: audit.dataSha256, alternateDataSha256: audit.mirrorCheck.alternateDataSha256 }, studies };
await writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await copyFile('scripts/run-full-rule-comparison.mjs', `${out}/code/run-full-rule-comparison.mjs`);
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v, n = 2) => v === null ? 'N/A' : Number(v).toFixed(n), sign = v => `${v >= 0 ? '+' : ''}${fmt(v)}`;
const pair = s => `${s.higherMinutes === 60 ? '1H' : s.higherMinutes + 'M'} → ${s.lowerMinutes}M`, name = s => s.variant === 'previous_simple' ? 'Previous: simple' : 'New: full rules';
const table = rows => `<div class="scroll"><table><thead><tr><th>Window</th><th>Variant</th><th>Closed</th><th>Win rate</th><th>Gross R</th><th>After 1pt cost</th><th>PF</th><th>Realized DD</th><th>Peak concurrent</th></tr></thead><tbody>${rows.map(s => `<tr><th>${pair(s)}</th><td>${name(s)}</td><td>${s.summary.closedTrades}</td><td>${fmt(s.summary.winRate * 100, 1)}%</td><td>${sign(s.summary.totalR)}R</td><td>${sign(s.costSensitivity.totalR)}R</td><td>${fmt(s.summary.profitFactorR)}</td><td>${fmt(s.summary.maxDrawdownR)}R</td><td>${s.maxConcurrentPositions}</td></tr>`).join('')}</tbody></table></div>`;
const primary = studies.filter(s => s.feed === 'Technovus'), full = primary.filter(s => s.variant === 'new_full_rules');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simple vs full indicator rules · 2025</title><style>body{margin:0;background:#f5f6f1;color:#18271e;font:16px/1.6 system-ui,sans-serif}main{max-width:1380px;margin:auto;padding:36px 24px}h1{font-size:34px;line-height:1.2}h2{margin-top:38px}.notice{padding:18px;border-left:4px solid #3d7150;background:#e4eddf}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;background:white;font-size:14px;margin:18px 0}th,td{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid #d9e0d5}thead{background:#e4eadf}.scroll th,.scroll td{white-space:nowrap}li{margin:10px 0}details{padding:14px;border:1px solid #d9e0d5;margin:12px 0}summary{cursor:pointer;font-weight:600}a{color:#285f40}small{color:#59695e}code{overflow-wrap:anywhere}</style></head><body><main><small>NIFTY / 2025 / MATCHED EXECUTION ASSUMPTIONS</small><h1>Simple rules vs restored CantoLab lifecycle</h1><p>1 January–31 December 2025 · 249 sessions · daily exit · CISD strictly after HTF sweep close · both archives · no one-position cap.</p><p class="notice"><strong>C1, C3, C4 and T-spots are parts of one model.</strong> The new variant restores their actual source roles and valid C3/C4 CISD entries. It does not invent independent trades from a C1 label or a T-spot touch. Entry uses a causally available close, SL the exact C2 wick, and TP 2R.</p><h2>Primary archive: Technovus</h2>${table(primary)}<h2>Second archive: Kaggle v18</h2>${table(studies.filter(s => s.feed !== 'Technovus'))}<p>Both sides use the same trade-execution rules and permit overlapping positions. The older full-indicator result with a one-position cap is a different strategy. R totals are index trade-risk units, not account percentages or options profits.</p><h2>Which new trades came from C3 and C4?</h2><div class="scroll"><table><thead><tr><th>Window</th><th>Confirmation phase</th><th>Trades</th><th>Win rate</th><th>Gross R</th></tr></thead><tbody>${full.flatMap(s => s.phaseBreakdown.map(p => `<tr><th>${pair(s)}</th><td>${p.phase}</td><td>${p.closedTrades}</td><td>${fmt(p.winRate * 100, 1)}%</td><td>${sign(p.totalR)}R</td></tr>`)).join('')}</tbody></table></div><h2>Source feature inventory</h2><table><thead><tr><th>Feature</th><th>Pine lines</th><th>Actual role in this comparison</th></tr></thead><tbody>${featureInventory.map(f => `<tr><th>${esc(f.feature)}</th><td>${f.sourceLines}</td><td>${esc(f.role)}</td></tr>`).join('')}</tbody></table><h2>Assumptions and limits</h2><ol>${assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ol><h2>New-variant primary trade ledgers</h2>${full.map(s => `<details><summary>${pair(s)} · ${s.trades.length} positions</summary><p>Exits: ${esc(JSON.stringify(s.exitCounts))}</p><div class="scroll"><table><thead><tr><th>Entry IST</th><th>Direction</th><th>Phase</th><th>Entry</th><th>SL</th><th>TP</th><th>Exit IST</th><th>Exit reason</th><th>R</th></tr></thead><tbody>${s.trades.map(t => `<tr><td>${ist(t.entryTime)}</td><td>${t.direction}</td><td>${t.confirmationPhase}</td><td>${fmt(t.entry)}</td><td>${fmt(t.stopLoss)}</td><td>${fmt(t.target)}</td><td>${ist(t.exitTime)}</td><td>${t.exitReason}</td><td>${sign(t.r)}</td></tr>`).join('')}</tbody></table></div></details>`).join('')}<h2>Evidence and reproduction</h2><p><a href="results.json">All twelve runs, signals, monthly figures and trades</a> · <a href="audit.json">Independent source and fill audit</a> · <a href="../backtest-2025-simple/report.html">Previous simplified study</a> · <a href="https://github.com/cantolab/open-source-fractal/blob/1bb53262deba9456f2b1a85d15c6ac5a5e880cf7/openSourceFractal.pine">Pinned Pine source</a></p><p><code>node scripts/run-full-rule-comparison.mjs</code><br><code>node scripts/audit-full-rule-comparison.mjs</code><br><code>npm test</code></p><small>Generated ${report.generatedAt}. Snapshot code is preserved under code/. No orders are placed; no TradingView runtime parity is claimed.</small></main></body></html>`;
await writeFile(`${out}/report.html`, html); console.log(`Saved ${out}/report.html`);
