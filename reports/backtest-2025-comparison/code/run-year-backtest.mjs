import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const out = 'reports/backtest-2025-comparison';
const compiled = path.resolve('artifacts/year-backtest-build');
await mkdir(compiled, { recursive: true });
await mkdir(`${out}/code`, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceHashes = {};
for (const name of ['indicator', 'backtest']) {
  const source = await readFile(`src/lib/${name}.ts`, 'utf8');
  sourceHashes[name] = sha(source);
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  await writeFile(`${compiled}/${name}.mjs`, code.replace(/from ['"]\.\/indicator['"]/g, "from './indicator.mjs'"));
  await copyFile(`src/lib/${name}.ts`, `${out}/code/${name}.ts`);
}
const { runBacktest, summarizeTrades } = await import(pathToFileURL(`${compiled}/backtest.mjs`).href);
const audit = JSON.parse(await readFile(`${out}/data/data-audit.json`, 'utf8'));
const settings = { instrument: '^NSEI', testStart: Date.parse('2025-01-01T09:15:00+05:30'), testEnd: Date.parse('2026-01-01T00:00:00+05:30'), executionEndMinutes: 930, nonTradingDates: audit.nonTradingDates, sessionOverrides: audit.sessionOverrides, roundTripCostPoints: 0 };
const ist = time => time === null ? '' : new Date(time + 330 * 60_000).toISOString().replace('T', ' ').replace('.000Z', ' IST');
const month = time => ist(time).slice(0, 7);
const studies = [];
for (const [feed, file, hash] of [['Technovus', 'minute-candles.json', audit.dataSha256], ['Kaggle v18', 'minute-candles-kaggle.json', audit.mirrorCheck.alternateDataSha256]]) {
  const raw = await readFile(`${out}/data/${file}`, 'utf8');
  if (sha(raw) !== hash) throw new Error(`Frozen data hash mismatch: ${feed}`);
  const candles = JSON.parse(raw);
  for (const [higherMinutes, lowerMinutes] of [[60, 5], [30, 3], [15, 1]]) {
    for (const mode of ['daily_exit', 'carry']) {
      const start = performance.now();
      const result = runBacktest({ ...settings, candles, higherMinutes, lowerMinutes, ...(mode === 'daily_exit' ? { sessionExitMinutes: 930 } : {}) });
      const closed = result.trades.filter(t => t.status === 'closed');
      const monthly = Array.from({ length: 12 }, (_, i) => { const m = `2025-${String(i + 1).padStart(2, '0')}`; return { month: m, ...summarizeTrades(closed.filter(t => month(t.exitTime) === m)) }; });
      const costSensitivity = summarizeTrades(result.trades.map(t => t.status === 'closed' ? { ...t, points: t.grossPoints - 1, r: (t.grossPoints - 1) / t.risk } : t));
      const exitCounts = result.trades.reduce((counts, t) => { const key = t.exitReason ?? t.status; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});
      const study = { feed, mode, ...result, costSensitivity, exitCounts, monthly,
        overnightClosed: closed.filter(t => ist(t.entryTime).slice(0, 10) !== ist(t.exitTime).slice(0, 10)).length,
        worstTradeR: closed.length ? Math.min(...closed.map(t => t.r)) : null };
      if (result.summary.unresolvedTrades) throw new Error(`Unexpected missing-data position in complete-year replay: ${feed}/${higherMinutes}/${mode}`);
      if (mode === 'daily_exit' && (study.overnightClosed || result.summary.openTrades)) throw new Error('Daily-exit mode carried a position.');
      if (mode === 'carry' && exitCounts.session_close) throw new Error('Carry mode contains a forced session exit.');
      studies.push(study);
      console.log(JSON.stringify({ feed, pair: `${higherMinutes}/${lowerMinutes}`, mode, seconds: Number(((performance.now() - start) / 1000).toFixed(2)), ...result.summary, exitCounts }));
    }
  }
}
const assumptions = [
  'Full calendar year 2025. Both modes start flat on January 1; December 16-31, 2024 supplies indicator warm-up only. One position per timeframe pair; pairs are independent, not a combined portfolio.',
  'Same CantoLab-derived closed-candle C2 sweep, run-open CISD level and C3/C4 invalidations. Entry is the first causally available CISD confirming close; early CISD waits for C2 close. Late C3 boundary confirmation waits for the later available close. No backfilled CISD-line fill.',
  'Pine is an indicator, not an order strategy. The close-price fill and exact C2 stop/2R target are explicit trading assumptions. Original lookahead, retrospective drawings and deletion of past confirmations are deliberately not reproduced.',
  'Bullish SL equals exact C2 low; bearish SL equals exact C2 high, without buffer or tick rounding. TP is exactly 2R. Only candles after entry can hit the bracket. Same-minute SL/TP ambiguity uses stop first.',
  'Daily exit: close any remaining position at the actual session close, normally 15:30 IST, and 14:45 for Muhurat. Do not enter at that closing instant. Carry: retain positions overnight until SL, TP, or explicit invalidation; the final session close can initiate a position. An open position at the year boundary stays open, with no realized P&L.',
  'Stop gaps fill at the next available opening price and can lose more than 1R. Target gaps fill at the target. Explicit invalidation exits at the next eligible minute open, after resting gap orders. Setup expiry/replacement does not liquidate an entered position.',
  '2025 normal continuous sessions end at 15:30, before the 2026 closing-auction change. Saturday February 1 Budget trading and October 21 13:45-14:45 Muhurat trading are included. Bars anchor at each actual session open.',
  'No fabricated, interpolated or forward-filled bars. Unexpected missing execution data would leave a position unresolved and block later entries; no such gap exists in either checked 2025 input.',
  'Totals sum each trade in initial-risk units (R), without compounding or a capital assumption. Max drawdown uses realized R, not intratrade mark-to-market. Monthly results are assigned by exit month.',
  'Gross results exclude spread, fees and slippage. A separate flat one-index-point cost sensitivity is illustrative, not a model of options execution costs. No options premiums, strike selection, expiry or Greeks are simulated.',
  'This is a zero-feed-delay theoretical index-price study. Delayed dashboard quotes cannot achieve these historical fills. The public archives are community data, not independently certified exchange minute feeds.',
  'The two archives disagree on 6,847 of 93,060 yearly OHLC rows (largest field difference 8.5 points). Source sensitivity reruns all six configurations without choosing a feed or parameter by its profitability. Matching daily ranges do not validate every minute.',
];
const report = { generatedAt: new Date().toISOString(), title: '2025 NIFTY: carry-over versus daily exit', settings, yearSessions: audit.yearSessions, yearCandles: audit.yearCandles, warmupFrom: audit.warmupFrom,
  provenance: { sourceHashes, dataSha256: audit.dataSha256, alternateDataSha256: audit.mirrorCheck.alternateDataSha256, sourceCommit: audit.sourceCommit, pineCommit: '1bb53262deba9456f2b1a85d15c6ac5a5e880cf7' }, assumptions, studies };
await writeFile(`${out}/results.json`, JSON.stringify(report, null, 2));
await copyFile('scripts/run-year-backtest.mjs', `${out}/code/run-year-backtest.mjs`);
await copyFile('scripts/prepare-year-data.mjs', `${out}/code/prepare-year-data.mjs`);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v, n = 2) => v === null ? 'N/A' : Number(v).toFixed(n);
const signed = v => `${v >= 0 ? '+' : ''}${fmt(v)}`;
const pair = s => `${s.higherMinutes === 60 ? '1H' : s.higherMinutes + 'M'} → ${s.lowerMinutes}M`;
const mode = s => s.mode === 'carry' ? 'Carry overnight' : 'Daily exit';
const primary = studies.filter(s => s.feed === 'Technovus');
const alternate = studies.filter(s => s.feed !== 'Technovus');
const summary = rows => rows.map(s => `<tr><th>${pair(s)}</th><td>${mode(s)}</td><td>${s.summary.closedTrades}</td><td>${s.summary.wins} / ${s.summary.losses} / ${s.summary.breakeven}</td><td>${fmt(s.summary.winRate * 100, 1)}%</td><td class="${s.summary.totalR >= 0 ? 'positive' : 'negative'}">${signed(s.summary.totalR)}R</td><td>${fmt(s.summary.profitFactorR)}</td><td>${fmt(s.summary.maxDrawdownR)}R</td><td>${s.summary.openTrades}</td><td>${signed(s.costSensitivity.totalR)}R</td></tr>`).join('');
const header = '<tr><th>Window</th><th>Holding rule</th><th>Closed</th><th>Wins / losses / flat</th><th>Win rate</th><th>Realized total</th><th>Profit factor</th><th>Max drawdown</th><th>Open</th><th>After 1pt cost</th></tr>';
const table = rows => `<div class="scroll"><table><thead>${header}</thead><tbody>${summary(rows)}</tbody></table></div>`;
const ledger = s => `<details><summary>${pair(s)} · ${mode(s)} · ${s.trades.length} positions</summary><p>Exit counts: ${escape(JSON.stringify(s.exitCounts))}. Overnight closed trades: ${s.overnightClosed}. Worst trade: ${fmt(s.worstTradeR)}R. Ambiguous bars: ${s.summary.ambiguousTrades}.</p><div class="scroll"><table><thead><tr><th>Entry IST</th><th>Direction</th><th>Entry</th><th>SL</th><th>TP</th><th>Exit IST</th><th>Exit</th><th>Reason</th><th>Result</th></tr></thead><tbody>${s.trades.map(t => `<tr><td>${ist(t.entryTime)}</td><td>${t.direction}</td><td>${fmt(t.entry)}</td><td>${fmt(t.stopLoss)}</td><td>${fmt(t.target)}</td><td>${t.exitTime === null ? t.status : ist(t.exitTime)}</td><td>${fmt(t.exit)}</td><td>${t.exitReason ?? t.status}</td><td>${t.r === null ? t.status : signed(t.r) + 'R'}</td></tr>`).join('')}</tbody></table></div></details>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>2025 NIFTY · carry vs daily exit</title><style>
body{font:16px/1.6 system-ui,sans-serif;background:#f5f6f1;color:#17231e;margin:0}main{max-width:1320px;margin:auto;padding:38px 24px}h1{font-size:34px;line-height:1.2}h2{margin-top:38px}small,.muted{color:#5d6860}.notice{background:#fff5dc;border-left:4px solid #9c792e;padding:18px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;background:white;font-size:14px;margin:18px 0}th,td{padding:10px;border-bottom:1px solid #dce1d7;text-align:left;white-space:nowrap}thead{background:#e5ebdf}.positive{color:#237343;font-weight:bold}.negative{color:#ae3b36;font-weight:bold}details{border:1px solid #dce1d7;padding:14px;margin:12px 0}summary{cursor:pointer;font-weight:600}li{margin:10px 0}a{color:#245b3b}code{font-size:12px;overflow-wrap:anywhere}</style></head><body><main>
<small>C2 FRACTAL / FULL-YEAR RESEARCH / 2025</small><h1>NIFTY: carry-over versus daily exit</h1><p><strong>1 January–31 December 2025</strong> · ${audit.yearSessions} sessions · ${audit.yearCandles.toLocaleString()} minute candles · December warm-up · all three pairs use identical dates.</p>
<p class="notice"><strong>Theoretical index results, before costs—not options profits.</strong> SL and 2R are measured on the index. Entries assume immediate candle-close information. Data and timing limitations remain material; the second archive's results are shown below rather than treating a public feed as certified truth.</p>
<h2>Primary archive: Technovus</h2><p>Daily exit closes at the actual session end (normally 15:30 IST in 2025). Carry retains positions overnight. Both use CISD confirmation-close entry, exact C2 low/high stop, 2R target, and the same source-derived invalidation rules.</p>${table(primary)}
<p>1R is the entry-to-stop risk of each trade. Totals are not percentage account returns. Open year-end positions contribute no realized P&amp;L. Drawdown is based on closed trades. The cost column deducts one index point per completed trade; it does not estimate options costs.</p>
<h2>Data-source sensitivity: Kaggle v18</h2><p>Both archives cover every expected minute. However, ${audit.mirrorCheck.differences.toLocaleString()} rows (${fmt(audit.mirrorCheck.differences / audit.yearCandles * 100, 2)}%) differ, with a maximum OHLC-field difference of ${audit.mirrorCheck.maxDifference} points. Those differences can affect exact CISD crossings. The same strategy is rerun unchanged on the second archive, including its own December warm-up. A shared upstream supplier cannot be ruled out.</p>${table(alternate)}
<h2>Monthly realized R — primary archive</h2><div class="scroll"><table><thead><tr><th>Exit month</th>${primary.map(s => `<th>${pair(s)}<br>${mode(s)}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: 12 }, (_, i) => `<tr><th>2025-${String(i + 1).padStart(2, '0')}</th>${primary.map(s => `<td>${signed(s.monthly[i].totalR)}R</td>`).join('')}</tr>`).join('')}</tbody></table></div>
<h2>Checks and limits</h2><ul><li>No missing minute, duplicate timestamp, invalid OHLC, or timestamp/epoch mismatch in the primary 2025 data. Both inputs share the same complete calendar.</li><li>Checked <a href="https://nsearchives.nseindia.com/content/circulars/CMTR65587.pdf">NSE holidays</a>, <a href="https://nsearchives.nseindia.com/content/circulars/CMTR65729.pdf">February 1 Budget trading</a>, and <a href="https://nsearchives.nseindia.com/content/circulars/CMTR70319.pdf">October 21 Muhurat hours</a>. No false overnight gaps or normal-session buckets are imposed on the shortened session.</li><li>Compared all 249 daily ranges with Yahoo and three dates directly with NSE files, including April 7. The three official open/high/low checks match exactly. Daily settlement closes differ from final intraday closes and are not substituted.</li><li>The <a href="https://github.com/technovusin/nifty50-historical-data/issues/2#issuecomment-6462834472">uploader identifies an unnamed broker API</a>. Every minute is not independently exchange-verified. Original files, hashes, license, cleaning notes, and differences are retained in the <a href="data/data-audit.json">data audit</a>.</li><li>The source-rule fixtures and replay audits do not run TradingView's Pine runtime. The port's causal differences from the original indicator remain explicit.</li></ul>
<h2>Execution rules</h2><ol>${assumptions.map(a => `<li>${escape(a)}</li>`).join('')}</ol>
<h2>Primary trade ledgers</h2>${primary.map(ledger).join('')}
<h2>Reproduce</h2><p>Run <code>node scripts/run-year-backtest.mjs</code>, then <code>node scripts/audit-year-backtest.mjs</code>. <a href="results.json">Full results, both feeds and event logs</a> · <a href="data/data-audit.json">Data audit</a> / <a href="implementation-audit.json">Raw-candle execution audit</a>. Saved source snapshots are in <code>code/</code>. No order endpoint exists.</p><p class="muted">Generated ${report.generatedAt}. No parameter optimization or profitable-date selection. Primary data SHA-256: <code>${audit.dataSha256}</code></p></main></body></html>`;
await writeFile(`${out}/report.html`, html);
console.log(`Saved ${out}/report.html`);
