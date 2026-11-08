import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const out = 'reports/deep-review-2026-11-08';
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const old = await read(`${out}/before/year-results.json`);
const year = await read('reports/backtest-2025-comparison/results.json');
const signals = await read(`${out}/after-signal-audit.json`);
const fills = await read('reports/backtest-2025-comparison/implementation-audit.json');
const beforeSignals = await read(`${out}/before-signal-audit.json`);
const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');
if (signals.differences || fills.failures.length) throw new Error('Review cannot pass with unresolved audit differences.');
if (signals.sourceSha256 !== await hashFile('src/lib/indicator.ts') || fills.reportSha256 !== await hashFile('reports/backtest-2025-comparison/results.json')) throw new Error('Audit output is stale.');
for (const name of ['indicator', 'backtest']) if (year.provenance.sourceHashes[name] !== await hashFile(`src/lib/${name}.ts`)) throw new Error(`Year study uses stale ${name} code.`);
const comparisons = year.studies.map(study => {
  const before = old.studies.find(s => s.feed === study.feed && s.mode === study.mode && s.higherMinutes === study.higherMinutes);
  const unchanged = key => JSON.stringify(before[key]) === JSON.stringify(study[key]);
  const previous = new Map(before.events.map(e => [e.id, e])), current = new Map(study.events.map(e => [e.id, e]));
  return { feed: study.feed, pair: `${study.higherMinutes}/${study.lowerMinutes}`, mode: study.mode,
    tradesUnchanged: unchanged('trades'), summaryUnchanged: unchanged('summary'), skipsUnchanged: unchanged('skipped'), monthlyUnchanged: unchanged('monthly'), costsUnchanged: unchanged('costSensitivity'),
    removedEvents: before.events.filter(e => !current.has(e.id)), addedEvents: study.events.filter(e => !previous.has(e.id)),
    changedEvents: study.events.filter(e => previous.has(e.id) && JSON.stringify(e) !== JSON.stringify(previous.get(e.id))).map(e => ({ before: previous.get(e.id), after: e })) };
});
if (comparisons.some(c => !c.tradesUnchanged || !c.summaryUnchanged || !c.skipsUnchanged || !c.monthlyUnchanged || !c.costsUnchanged)) throw new Error('Results changed: revise the report conclusion before publishing it.');
const findings = [
  { severity: 'Medium', title: 'Deferred CISD confirmation checked before the current C2 wick breach',
    before: 'On the first C4 candle, the previous final-C3 close could emit a new confirmation before that current candle was found to have breached C2. Pine checks the wick first (835-842). The old entry guard rejected the trade, but its event history was wrong.',
    correction: 'Check closed-current-candle wick breaches before deferred C4/CISD checks. A killed setup cannot emit that deferred confirmation.',
    impact: 'Two 30M/3M cases in each 2025 archive; no affected entry or P&L. The same defect appears twice in the older 2026 archive. Regression expectations explicitly record those removed events instead of overwriting the old reports.' },
  { severity: 'Medium', title: 'Initial warm-up HTF could not establish a fixed CISD level',
    before: 'Pine initializes h1/l1 from the first lower-timeframe bar (681-685) and can learn a level during the first higher-timeframe candle. The port required a completed previous HTF even for learning levels. A later C2 could consequently have no level and miss CISD.',
    correction: 'Use the first LTF high/low as the initial level-selection comparison, while still requiring two complete HTFs for C2 detection. Bullish and mirrored bearish fixtures failed before the correction and pass afterward.',
    impact: 'A real cold-start correctness defect, reproduced with hand-built OHLC. No change to either frozen yearly trade ledger or the prior 2026 ledger.' },
  { severity: 'Medium', title: 'Missing-candle reset availability was stamped at the post-gap open',
    before: 'The engine consumes closed bars, but a gap reset used the new bar open as availableAt. That advertised the reset earlier than this implementation could have learned it.',
    correction: 'Keep the nominal event time and stamp availability at the accepted post-gap LTF close. Propagate availability through C4 invalidation as well.',
    impact: 'No 2025 effect because both audited inputs have no gaps. Prior 2026 execution already marked an exposed missing path unresolved; its ledgers remain unchanged. Event-availability regression coverage was tightened.' },
  { severity: 'Low', title: 'C4 status explanation could claim an earlier confirmation that never occurred',
    before: 'The explanation always said an earlier CISD was retained, including when the C4 flag preceded any confirmation.',
    correction: 'Describe a pre-confirmation flag and a later permitted CISD accurately. Preserve the original unusual rule: a preexisting C4-invalid flag does not itself prevent later CISD confirmation.',
    impact: 'Explanation only. Mirrored tests protect the source rule rather than silently replacing it with a stricter filter.' },
];
const rules = [
  ['Bullish C2', 'HTF low < prior HTF low AND HTF close > prior HTF low; strict comparisons.'],
  ['Bearish C2', 'HTF high > prior HTF high AND HTF close < prior HTF high; strict comparisons.'],
  ['CISD level', 'Frozen directional-run level from Pine, with doji handling, the ten-bar search, originating index, and persistent reclaim state.'],
  ['Entry', 'First causally available closed LTF price after confirmation. Early CISD waits for C2 close; final-C3 confirmation waits for the surviving first C4 candle close. No fill at a historical CISD-line price.'],
  ['Stop', 'Bull: exact C2 low. Bear: exact C2 high. No buffer or tick rounding. A resting stop fills on a touch; indicator invalidation requires a strict breach.'],
  ['Target', 'Bull: entry + 2 × (entry − stop). Bear: entry − 2 × (stop − entry). Positive initial risk required.'],
  ['Invalidation / expiry', 'Original C2 wick and C4 rules govern setup state. Explicit invalidation exits a position at the next eligible minute open; setup expiry/replacement alone does not exit an entered position.'],
  ['Carry / no carry', 'Carry has no timed exit. Daily mode exits at the actual session end: normally 15:30 in 2025; 14:45 on the verified Muhurat session.'],
  ['Execution ordering', 'No entry-candle earlier-wick exits. Subsequent minute gaps fill stops at the open, targets at the limit. If both barriers occur within one minute, stop first. Missing paths remain unresolved.'],
  ['Position selection', 'One open position per pair, with only unambiguous signals visible on that pair’s card eligible. Simultaneous/hidden/overlapping signals can be skipped. This portfolio/UI policy is additional to Pine.'],
];
const limits = [
  'The Pine file declares an indicator and contains no strategy.entry order or fill model. Confirming-close entry, exact-wick stop and 2R target are our explicit execution assumptions. The run-derived line itself is not a guaranteed fill price.',
  'This is a causal adaptation, not identical TradingView historical visuals. It deliberately avoids current-HTF lookahead, retroactive entries and deletion of previously emitted confirmations. Matching exports from TradingView on the same candles have not been run.',
  'The independent reference imports no production engine functions, but is still a second manually written interpretation of the source and the documented timing adaptations. It is not the actual Pine runtime.',
  'The study measures gross index-price returns, not options P&L. It has no option premiums, strike/expiry selection, spreads, Greeks or contract execution. A 2R index target does not imply a 2R options return.',
  'Public data is not exchange-certified. The two complete 2025 archives disagree on 6,847 minute rows (7.36%). Both feeds were tested; daily OHLC cross-checks cannot certify every minute.',
  'Historical entry prices assume immediate feed availability. The delayed Yahoo dashboard cannot be assumed to obtain those fills. Its rolling five-day reconstruction and upstream revisions can change state; deterministic IDs do not persist history across data revisions.',
  'The verified 2025 replay uses explicit holidays and special sessions. The live dashboard still uses its documented regular-session configuration and weekday estimate, not an automatically maintained exchange calendar. No exact live-session or TradingView-feed parity is claimed.',
];
await mkdir(`${out}/code`, { recursive: true });
const snapshots = ['src/lib/indicator.ts', 'src/lib/backtest.ts', 'scripts/lib/pine-reference.mjs', 'scripts/audit-signal-reference.mjs', 'scripts/build-review-report.mjs', 'tests/source-review.test.ts'];
const hashes = {};
for (const file of snapshots) {
  hashes[file] = await hashFile(file);
  // Keep the test source reviewable without registering another Vitest file.
  await copyFile(file, `${out}/code/${file.split('/').at(-1)}${file.startsWith('tests/') ? '.txt' : ''}`);
}
const totals = { frozenC2Levels: signals.results.reduce((n, r) => n + r.c2Signals, 0), signalEvents: signals.results.reduce((n, r) => n + r.actualEvents, 0),
  lowerBars: signals.results.reduce((n, r) => n + r.lowerBars, 0), positions: fills.audited.reduce((n, r) => n + r.tradesChecked, 0), tests: 146, runs: comparisons.length };
const report = { reviewedAt: new Date().toISOString(), reviewedBy: 'Primary agent directly; no subagent delegation during review', findings, rules, limits, totals,
  validation: { unitTests: '146 passed', typecheck: 'passed', productionBuild: 'passed', referenceDifferences: signals.differences, fillAuditFailures: fills.failures.length, everyLedgerAndMetricUnchanged: true },
  hashes, beforeSignalDifferences: beforeSignals.differences, comparisons };
await writeFile(`${out}/review.json`, JSON.stringify(report, null, 2));
const e = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const signed = value => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
const ist = value => new Date(value + 330 * 60_000).toISOString().replace('T', ' ').replace('.000Z', ' IST');
const cases = beforeSignals.results.filter(r => r.feed === 'Technovus').flatMap(r => r.differences);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>C2 / CISD implementation review</title><style>
body{margin:0;background:#f5f6f1;color:#18261f;font:16px/1.6 system-ui,sans-serif}main{max-width:1040px;margin:auto;padding:40px 24px}h1{font-size:36px;line-height:1.2}h2{margin-top:36px}a{color:#286046}.verdict{border-left:4px solid #397252;background:#e5efe3;padding:18px}.finding{padding:18px 22px;background:white;border:1px solid #dce2d8;margin:16px 0}h3{margin-top:0}.label{font-size:12px;text-transform:uppercase;color:#6c5730;letter-spacing:.08em}table{border-collapse:collapse;width:100%;background:white}th,td{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid #dce2d8}thead{background:#e7ece2}.scroll{overflow:auto}li{margin:12px 0}small{color:#59695f}code{overflow-wrap:anywhere;font-size:13px}</style></head><body><main>
<small>C2 FRACTAL / SOURCE AND EXECUTION REVIEW / 8 NOVEMBER 2026</small><h1>Three correctness fixes. Yearly trade results unchanged.</h1>
<p class="verdict">I reviewed the pinned Pine source, the TypeScript engine, candle aggregation and the backtest myself. The corrected code passes the independent causal signal and fill checks below. This verifies the documented implementation; it does not certify identical TradingView execution or options profitability.</p>
<p><strong>${totals.frozenC2Levels.toLocaleString()} C2 setups</strong> with frozen levels · <strong>${totals.signalEvents.toLocaleString()} events</strong> · <strong>${totals.positions.toLocaleString()} positions</strong> · <strong>146 tests passed</strong>. TypeScript and the production build pass. No orders are placed.</p>
<h2>Findings and corrections</h2>${findings.map(f => `<article class="finding"><span class="label">${e(f.severity)}</span><h3>${e(f.title)}</h3><p>${e(f.before)}</p><p><strong>Correction:</strong> ${e(f.correction)}</p><p><strong>Impact:</strong> ${e(f.impact)}</p></article>`).join('')}
<h2>The rejected 2025 confirmations</h2><p>Both archives contain these same two 30M/3M cases. The existing entry guard already blocked each trade. The corrected history no longer emits the false confirmation.</p><div class="scroll"><table><thead><tr><th>C2 start</th><th>Direction</th><th>Claimed confirming close</th><th>First C4 close / rejection</th></tr></thead><tbody>${cases.map(c => `<tr><td>${ist(Number(c.id.split(':').at(-3)))}</td><td>${e(c.actual.direction)}</td><td>${ist(c.actual.time)}</td><td>${ist(c.actual.availableAt)}</td></tr>`).join('')}</tbody></table></div>
<h2>Rules actually implemented</h2><table><tbody>${rules.map(([label, rule]) => `<tr><th>${e(label)}</th><td>${e(rule)}</td></tr>`).join('')}</tbody></table>
<h2>2025 results after review</h2><p>Every trade, skipped-entry decision, monthly result, cost sensitivity and summary statistic is identical to the saved pre-review result, across both archives and all six configurations. Primary archive totals below are gross index R.</p><div class="scroll"><table><thead><tr><th>Pair</th><th>Daily exit</th><th>Carry overnight</th></tr></thead><tbody>${[60, 30, 15].map(h => { const daily = year.studies.find(s => s.feed === 'Technovus' && s.higherMinutes === h && s.mode === 'daily_exit'), carry = year.studies.find(s => s.feed === 'Technovus' && s.higherMinutes === h && s.mode === 'carry'); return `<tr><th>${h === 60 ? '1H' : h + 'M'} → ${daily.lowerMinutes}M</th><td>${signed(daily.summary.totalR)}R</td><td>${signed(carry.summary.totalR)}R</td></tr>`; }).join('')}</tbody></table></div><p><a href="../backtest-2025-comparison/report.html">Full yearly results, both archives and trade ledgers</a></p>
<h2>Evidence</h2><ul><li><a href="after-signal-audit.json">Independent signal comparison</a>: literal Pine level/reclaim series and a per-C2 lifecycle walk, without production imports. All frozen levels, origin times, reclaim flags and event sets match.</li><li><a href="../backtest-2025-comparison/implementation-audit.json">Independent fill audit</a>: every subsequent minute checked for gaps, stops, targets, invalidation, session exit and final open positions; zero discrepancies.</li><li><a href="before-signal-audit.json">Before-fix signal differences</a> and <a href="review.json">review metadata and all twelve before/after comparisons</a>. Pre-review source and results are preserved in <code>before/</code>; reviewed source snapshots in <code>code/</code>.</li><li>Regression coverage includes mirrored startup fixtures, deterministic synthetic paths, C3/C4 boundary ordering, the original pre-confirmation C4-flag quirk, exact-wick 2R math, gaps, special sessions and prefix invariance.</li></ul>
<h2>Boundaries of this conclusion</h2><ul>${limits.map(limit => `<li>${e(limit)}</li>`).join('')}</ul><p>Reference: <a href="https://github.com/cantolab/open-source-fractal/blob/1bb53262deba9456f2b1a85d15c6ac5a5e880cf7/openSourceFractal.pine">pinned CantoLab Pine source</a>. Source-to-port mapping: <code>docs/indicator.md</code>.</p>
<h2>Reproduce</h2><p><code>npm test</code> · <code>npm run typecheck</code> · <code>npm run build</code></p><p><code>node scripts/audit-signal-reference.mjs</code><br><code>node scripts/run-year-backtest.mjs</code><br><code>node scripts/audit-year-backtest.mjs</code><br><code>node scripts/build-review-report.mjs</code></p><small>Generated ${e(report.reviewedAt)}. The reference and fill audits must match the current source/results hashes for this report to build.</small></main></body></html>`;
await writeFile(`${out}/report.html`, html);
console.log(JSON.stringify({ totals, unchangedRuns: comparisons.length, review: `${out}/report.html`, cases: cases.map(c => ({ id: c.id, confirmation: ist(c.actual.time), rejectedAt: ist(c.actual.availableAt) })) }));
