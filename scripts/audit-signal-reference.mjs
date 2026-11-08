import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { referenceSignals, comparableEvent } from './lib/pine-reference.mjs';

const out = 'reports/deep-review-2026-11-08';
const before = process.argv.includes('--before');
const sourceFile = before ? `${out}/before/indicator.ts` : 'src/lib/indicator.ts';
const source = await readFile(sourceFile, 'utf8');
const compiled = path.resolve(`artifacts/deep-review-${before ? 'before' : 'after'}.mjs`);
await mkdir(path.dirname(compiled), { recursive: true });
await writeFile(compiled, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
const { evaluateFractal } = await import(pathToFileURL(compiled).href);
const year = 'reports/backtest-2025-comparison';
const dataAudit = JSON.parse(await readFile(`${year}/data/data-audit.json`, 'utf8'));
const results = [];
for (const [feed, file] of [['Technovus', 'minute-candles.json'], ['Kaggle v18', 'minute-candles-kaggle.json']]) {
  const raw = await readFile(`${year}/data/${file}`, 'utf8'), candles = JSON.parse(raw);
  for (const [higherMinutes, lowerMinutes] of [[60, 5], [30, 3], [15, 1]]) {
    const settings = { candles, higherMinutes, lowerMinutes, instrument: '^NSEI', sessionOverrides: dataAudit.sessionOverrides };
    const reference = referenceSignals(settings);
    const formations = new Map();
    const actual = evaluateFractal({ ...settings, now: candles.at(-1).time + 60_000, includeAllEvents: true,
      onSetupFormation: fact => formations.set(fact.signalId, fact) });
    const expectedMap = new Map(reference.events.map(e => [e.id, comparableEvent(e)]));
    const actualMap = new Map(actual.events.map(e => [e.id, comparableEvent(e)]));
    const differences = [];
    // Old code predates the diagnostic hook; only the corrected implementation
    // can compare frozen levels for unconfirmed as well as confirmed setups.
    if (!before) for (const signal of reference.signals) {
      const expected = { signalId: signal.signalId, cisdLevel: signal.fixed.price,
        levelAt: signal.fixed.index === null ? null : reference.lower[signal.fixed.index].time, alreadyReclaimed: signal.fixed.reclaimed };
      const found = formations.get(signal.signalId) ?? null;
      if (JSON.stringify(expected) !== JSON.stringify(found)) differences.push({ id: `${signal.signalId}:frozen-level`, expected, actual: found });
    }
    for (const id of new Set([...expectedMap.keys(), ...actualMap.keys()])) {
      const expected = expectedMap.get(id) ?? null, found = actualMap.get(id) ?? null;
      if (JSON.stringify(expected) !== JSON.stringify(found)) differences.push({ id, expected, actual: found });
    }
    const summary = { feed, higherMinutes, lowerMinutes, lowerBars: reference.lower.length, higherBars: reference.higher.length, c2Signals: reference.signals.length,
      frozenLevelsCompared: formations.size, expectedEvents: expectedMap.size, actualEvents: actualMap.size, dataSha256: createHash('sha256').update(raw).digest('hex'), differences };
    results.push(summary);
    console.log(JSON.stringify({ ...summary, differences: differences.length, firstDifferences: differences.slice(0, 3) }));
  }
}
const report = { generatedAt: new Date().toISOString(), sourceFile, sourceSha256: createHash('sha256').update(source).digest('hex'),
  method: 'Independent literal Pine run-level/reclaim series plus per-C2 causal C3/C4 lifecycle. No production imports in the reference model. Full event sets compared, including signals not traded. Not TradingView runtime parity.',
  referenceSha256: createHash('sha256').update(await readFile('scripts/lib/pine-reference.mjs')).digest('hex'),
  differences: results.reduce((n, r) => n + r.differences.length, 0), results };
await writeFile(`${out}/${before ? 'before' : 'after'}-signal-audit.json`, JSON.stringify(report, null, 2));
if (report.differences) process.exitCode = 1;
