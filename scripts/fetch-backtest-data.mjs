import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Read-only historical acquisition. No credentials, orders, or fabricated candles.
const OUT = path.resolve('reports/backtest-2026-11-08/data');
const MINUTE = 60_000, DAY = 86_400_000, IST = 330 * MINUTE;
const symbol = '^NSEI';
const start = Date.parse('2026-10-10T00:00:00+05:30');
const end = Date.parse('2026-11-07T00:00:00+05:30');
const fetches = [], skipped = [], conflicts = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const date = time => new Date(time + IST).toISOString().slice(0, 10);
const at = time => new Date(time + IST).toISOString().replace('Z', '+05:30');
const fields = ['open', 'high', 'low', 'close'];
await mkdir(OUT, { recursive: true });

async function chart(interval, from, to, label) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.search = new URLSearchParams({ interval, period1: String(Math.floor(from / 1000)), period2: String(Math.floor(to / 1000)), includePrePost: 'false' }).toString();
  const request = { label, url: url.href, interval, requestedFrom: new Date(from).toISOString(), requestedToExclusive: new Date(to).toISOString(), retrievedAt: new Date().toISOString() };
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'C2FractalDashboard/1.0' }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    const body = await response.text();
    Object.assign(request, { status: response.status, sha256: sha(body), bytes: Buffer.byteLength(body), rawFile: `${label}.json`, retryAfter: response.headers.get('retry-after') });
    await writeFile(path.join(OUT, request.rawFile), body);
    if (response.status === 429) throw new Error('HTTP 429; acquisition stops without bypass or retry storm.');
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
    const parsed = JSON.parse(body);
    if (parsed.chart?.error) throw new Error(JSON.stringify(parsed.chart.error));
    const result = parsed.chart?.result?.[0];
    if (!result || result.meta?.symbol !== symbol || result.meta?.dataGranularity !== interval || result.meta?.exchangeTimezoneName !== 'Asia/Kolkata') throw new Error('Unexpected chart metadata');
    request.responseRows = result.timestamp?.length ?? 0;
    request.providerQuoteTime = result.meta.regularMarketTime;
    fetches.push(request);
    console.log(`${label}: HTTP ${response.status}, ${request.responseRows} raw rows`);
    return { result, from, to, label };
  } catch (error) {
    request.error = String(error);
    fetches.push(request);
    console.error(`${label}: ${request.error}`);
    if (request.status === 429) throw error;
    return null;
  }
}

function normalize(response, intervalMinutes = 1) {
  if (!response) return [];
  const { result, from, to, label } = response;
  const q = result.indicators?.quote?.[0];
  if (!q || !Array.isArray(result.timestamp) || fields.some(f => !Array.isArray(q[f]) || q[f].length !== result.timestamp.length)) throw new Error(`${label}: inconsistent column lengths`);
  const watermark = Math.min(Date.now(), result.meta.regularMarketTime * 1000);
  const rows = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const time = result.timestamp[i] * 1000;
    const issue = reason => skipped.push({ source: label, time, reason });
    if (!Number.isSafeInteger(time)) { issue('invalid_timestamp'); continue; }
    if (time < from || time >= to) { issue('outside_requested_range'); continue; }
    const local = new Date(time + IST), minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (local.getUTCDay() === 0 || local.getUTCDay() === 6 || minutes < 555 || minutes >= 930) { issue('outside_regular_weekday_session'); continue; }
    if (time % MINUTE || (minutes - 555) % intervalMinutes) { issue('unaligned_timestamp'); continue; }
    const closeTime = Math.min(time + intervalMinutes * MINUTE, Math.floor((time + IST) / DAY) * DAY - IST + 930 * MINUTE);
    if (closeTime > watermark) { issue('not_closed_at_provider_watermark'); continue; }
    const values = fields.map(f => q[f][i]);
    if (values.some(v => v === null)) { issue('null_ohlc'); continue; }
    if (values.some(v => typeof v !== 'number' || !Number.isFinite(v))) { issue('invalid_ohlc_type'); continue; }
    const [open, high, low, close] = values;
    if (low <= 0 || high < low || low > Math.min(open, close) || high < Math.max(open, close)) { issue('inconsistent_ohlc'); continue; }
    rows.push({ time, open, high, low, close, ...(Number.isFinite(q.volume?.[i]) && q.volume[i] >= 0 ? { volume: q.volume[i] } : {}) });
  }
  return rows;
}

const all = new Map();
let rateLimited = false;
for (let from = start, index = 0; from < end; from += 7 * DAY, index++) {
  if (index) await new Promise(resolve => setTimeout(resolve, 1500));
  try {
    const response = await chart('1m', from, Math.min(end, from + 7 * DAY), `minute-${date(from)}`);
    for (const row of normalize(response)) {
      const previous = all.get(row.time);
      if (previous && fields.some(f => previous[f] !== row[f])) conflicts.push({ time: row.time, previous, incoming: row });
      else all.set(row.time, row);
    }
  } catch (error) { rateLimited = true; console.error(String(error)); break; }
}
const candles = [...all.values()].sort((a, b) => a.time - b.time);
let daily = null, five = null;
if (!rateLimited) {
  await new Promise(resolve => setTimeout(resolve, 1500));
  daily = await chart('1d', start, end, 'daily-crosscheck');
  await new Promise(resolve => setTimeout(resolve, 1500));
  five = await chart('5m', start, end, 'five-minute-crosscheck');
}

const days = new Map();
for (const candle of candles) { const key = date(candle.time); if (!days.has(key)) days.set(key, []); days.get(key).push(candle); }
const sessions = [...days].map(([day, rows]) => {
  const sessionStart = Date.parse(`${day}T09:15:00+05:30`);
  const seen = new Set(rows.map(r => r.time));
  const missing = Array.from({ length: 375 }, (_, i) => sessionStart + i * MINUTE).filter(t => !seen.has(t));
  let maxFlatRun = 0, run = 0, previous;
  const flatRuns = [];
  let runStart = null;
  for (const row of rows) {
    const flat = row.open === row.high && row.high === row.low && row.low === row.close;
    const continuing = flat && run > 0 && previous?.time + MINUTE === row.time && previous.close === row.close;
    if (continuing) run++;
    else {
      if (run >= 10) flatRuns.push({ from: at(runStart), toInclusive: at(previous.time), minutes: run, price: previous.close });
      run = flat ? 1 : 0; runStart = flat ? row.time : null;
    }
    maxFlatRun = Math.max(maxFlatRun, run); previous = row;
  }
  if (run >= 10) flatRuns.push({ from: at(runStart), toInclusive: at(previous.time), minutes: run, price: previous.close });
  return { day, bars: rows.length, complete: missing.length === 0, missingMinutes: missing.map(at), open: rows[0].open, high: Math.max(...rows.map(r => r.high)), low: Math.min(...rows.map(r => r.low)), close: rows.at(-1).close, uniqueOhlc: new Set(rows.map(r => fields.map(f => r[f]).join('|'))).size, zeroRangeBars: rows.filter(r => r.high === r.low).length, longestUnchangedZeroRangeRun: maxFlatRun, longFlatRuns: flatRuns, lastMinute: rows.at(-1) };
});
const dailyComparisons = [];
if (daily) {
  const q = daily.result.indicators.quote[0];
  for (let i = 0; i < daily.result.timestamp.length; i++) {
    const day = date(daily.result.timestamp[i] * 1000), minute = sessions.find(s => s.day === day);
    if (!minute) continue;
    const source = Object.fromEntries(fields.map(f => [f, q[f][i]]));
    dailyComparisons.push({ day, minute: Object.fromEntries(fields.map(f => [f, minute[f]])), daily: source, deltaMinuteMinusDaily: Object.fromEntries(fields.map(f => [f, minute[f] - source[f]])) });
  }
}
const fiveComparisons = [];
for (const bar of normalize(five, 5)) {
  const rows = Array.from({ length: 5 }, (_, i) => all.get(bar.time + i * MINUTE));
  if (rows.some(r => !r)) continue;
  const aggregate = { open: rows[0].open, high: Math.max(...rows.map(r => r.high)), low: Math.min(...rows.map(r => r.low)), close: rows.at(-1).close };
  const deltas = Object.fromEntries(fields.map(f => [f, aggregate[f] - bar[f]]));
  fiveComparisons.push({ time: bar.time, ...Object.fromEntries(fields.map(f => [f, deltas[f]])), maxAbsoluteDifference: Math.max(...Object.values(deltas).map(Math.abs)) });
}
const weekdayDatesWithoutData = [];
for (let t = start; t < end; t += DAY) { const d = new Date(t + IST); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !days.has(date(t))) weekdayDatesWithoutData.push(date(t)); }
const flags = [];
if (conflicts.length) flags.push('Conflicting duplicate OHLC found; investigate before use.');
if (sessions.some(s => s.longestUnchangedZeroRangeRun >= 10)) flags.push('Systematic terminal plateaus at/after 15:15 IST: do not treat auction/finalization observations as a continuous minute-by-minute tradable path. This does not by itself establish corruption.');
if (fiveComparisons.some(r => r.maxAbsoluteDifference > 0.1)) flags.push('Some 1-minute aggregates disagree with Yahoo 5-minute OHLC by >0.1 index points.');
if (sessions.some(s => !s.complete)) flags.push('Partial sessions exist; preserve gaps or exclude sessions, never fill.');
if (weekdayDatesWithoutData.length) flags.push('Some weekdays have no minute data; may be holidays or unavailable history.');
const serialized = JSON.stringify(candles);
await writeFile(path.join(OUT, 'minute-candles.json'), serialized);
const audit = { generatedAt: new Date().toISOString(), instrument: symbol, intendedRange: { from: at(start), toExclusive: at(end) }, dataFile: 'minute-candles.json', dataSha256: sha(serialized), count: candles.length, first: candles[0] ? at(candles[0].time) : null, last: candles.at(-1) ? at(candles.at(-1).time) : null, sessionCount: sessions.length, completeSessionCount: sessions.filter(s => s.complete).length, qualityFlags: flags, weekdayDatesWithoutData, sessions, fetches, skippedCounts: Object.fromEntries([...new Set(skipped.map(s => s.reason))].map(reason => [reason, skipped.filter(s => s.reason === reason).length])), skipped, conflicts, dailyComparisons, fiveMinuteCrosscheck: { comparedBars: fiveComparisons.length, mismatchedOverTenthPoint: fiveComparisons.filter(r => r.maxAbsoluteDifference > 0.1).length, maximumDifference: Math.max(0, ...fiveComparisons.map(r => r.maxAbsoluteDifference)), comparisons: fiveComparisons }, executionSessionContext: { source: 'https://www.nseindia.com/market-data/closing-auction-session', verifiedBy: 'parent research', note: 'NSE closing-auction context explains why post-15:15 observations may be auction/finalization marks rather than continuous trading. Parent verified current rules separately. The acquisition retains the original 09:15–15:30 input convention and labels execution decisions separately.', suggestedLastContinuousCandleStart: '15:14 IST', suggestedFlattenAt: '15:15 IST using 15:14 candle close' }, notes: ['Raw responses are retained unmodified with SHA-256 and exact URLs.', 'A quote outside the requested time window is excluded even if Yahoo appended it.', 'Daily official close may differ from final intraday observation; daily comparison is diagnostic, not automatic rejection.', 'Zero index volume is not considered missing data.', 'No artificial minute bars or forward fills were created.', 'Completeness counts use the existing configured 09:15–15:30 session, not an assertion of continuous tradability after 15:15.', 'Same-source 5-minute agreement is not independent market-data validation.'] };
await writeFile(path.join(OUT, 'data-audit.json'), JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ count: audit.count, first: audit.first, last: audit.last, sessions: audit.sessionCount, complete: audit.completeSessionCount, qualityFlags: flags, absentWeekdays: weekdayDatesWithoutData, fiveMinuteComparison: { compared: fiveComparisons.length, mismatches: audit.fiveMinuteCrosscheck.mismatchedOverTenthPoint, max: audit.fiveMinuteCrosscheck.maximumDifference } }, null, 2));
