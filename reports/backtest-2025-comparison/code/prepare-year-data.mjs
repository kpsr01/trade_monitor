import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Read-only, pinned public data acquisition. No credentials or trading API.
const out = 'reports/backtest-2025-comparison/data';
await mkdir(out, { recursive: true });
const commit = '6eb58d96bd2c963445b8ce0840b1d1a37f8ecff3';
const sha = value => createHash('sha256').update(value).digest('hex');
const M = 60_000, D = 1440 * M, IST = 330 * M;
const date = time => new Date(time + IST).toISOString().slice(0, 10);
const sources = [];
async function source(file, url) {
  let raw;
  try { raw = await readFile(`${out}/${file}`, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot acquire ${file}: HTTP ${response.status}`);
    raw = await response.text();
    await writeFile(`${out}/${file}`, raw);
  }
  sources.push({ file, url, bytes: Buffer.byteLength(raw), sha256: sha(raw) });
  return raw;
}
const base = `https://raw.githubusercontent.com/technovusin/nifty50-historical-data/${commit}`;
function parse(raw) {
  const lines = raw.trim().split(/\r?\n/);
  if (lines.shift() !== 'Epoch,Timestamp,Open,High,Low,Close') throw new Error('Unexpected archive columns.');
  const seen = new Set();
  return lines.map(line => {
    const columns = line.split(',');
    if (columns.length !== 6) throw new Error('Unexpected CSV row shape.');
    const [epoch, timestamp, ...prices] = columns;
    const time = Number(epoch) * 1000;
    const [open, high, low, close] = prices.map(Number);
    if (time !== Date.parse(`${timestamp}+05:30`) || time % M ||
        ![open, high, low, close].every(Number.isFinite) || low <= 0 ||
        low > Math.min(open, close) || high < Math.max(open, close) || seen.has(time)) throw new Error(`Invalid or duplicate row: ${timestamp}`);
    seen.add(time);
    return { time, open, high, low, close };
  });
}
const year = parse(await source('NIFTY50_1min_2025.csv', `${base}/1min/2025/NIFTY50_1min_2025.csv`));
const previous = parse(await source('NIFTY50_1min_2024.csv', `${base}/1min/2024/NIFTY50_1min_2024.csv`));
await source('README.md', `${base}/README.md`);
await source('LICENSE', `${base}/LICENSE`);
const warmup = previous.filter(row => date(row.time) >= '2024-12-16');
const candles = [...warmup, ...year];
if (candles.some((row, i) => i && row.time <= candles[i - 1].time)) throw new Error('Unordered input.');
const nonTradingDates = ['2024-12-25', ...['02-26', '03-14', '03-31', '04-10', '04-14', '04-18', '05-01', '08-15', '08-27', '10-02', '10-22', '11-05', '12-25'].map(d => `2025-${d}`)];
const sessionOverrides = { '2025-02-01': { openMinutes: 555, closeMinutes: 930 }, '2025-10-21': { openMinutes: 825, closeMinutes: 885 } };
const dayRows = new Map();
for (const row of candles) { const day = date(row.time); const rows = dayRows.get(day) ?? []; rows.push(row); dayRows.set(day, rows); }
const sessions = [...dayRows].map(([day, rows]) => {
  const hours = sessionOverrides[day] ?? { openMinutes: 555, closeMinutes: 930 };
  const midnight = Date.parse(`${day}T00:00:00+05:30`);
  const expected = Array.from({ length: hours.closeMinutes - hours.openMinutes }, (_, i) => midnight + (hours.openMinutes + i) * M);
  const actual = new Set(rows.map(row => row.time));
  const missing = expected.filter(time => !actual.has(time));
  const unexpected = rows.filter(row => !expected.includes(row.time)).map(row => row.time);
  let longestFlat = 0, flat = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    flat = row.high === row.low ? (i && rows[i - 1].close === row.close ? flat + 1 : 1) : 0;
    longestFlat = Math.max(longestFlat, flat);
  }
  return { day, count: rows.length, ...hours, missing, unexpected, longestFlat,
    open: rows[0].open, high: Math.max(...rows.map(r => r.high)), low: Math.min(...rows.map(r => r.low)), close: rows.at(-1).close };
});
const expectedDays = [];
for (let t = Date.parse('2025-01-01T00:00:00+05:30'); t < Date.parse('2026-01-01T00:00:00+05:30'); t += D) {
  const day = date(t), weekday = new Date(t + IST).getUTCDay();
  if (sessionOverrides[day] || (weekday !== 0 && weekday !== 6 && !nonTradingDates.includes(day))) expectedDays.push(day);
}
const missingDays = expectedDays.filter(day => !dayRows.has(day));
const extraDays = sessions.filter(s => s.day.startsWith('2025') && !expectedDays.includes(s.day)).map(s => s.day);
if (missingDays.length || extraDays.length || sessions.some(s => s.missing.length || s.unexpected.length)) throw new Error('Calendar/candle completeness failed; inspect data before replay.');

const dailyRaw = await source('yahoo-daily-2025.json', 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&period1=1735669800&period2=1767292200');
const chart = JSON.parse(dailyRaw).chart.result[0];
if (chart.meta.symbol !== '^NSEI' || chart.meta.exchangeTimezoneName !== 'Asia/Kolkata') throw new Error('Wrong daily crosscheck instrument/timezone.');
const q = chart.indicators.quote[0];
const dailyChecks = chart.timestamp.map((stamp, i) => {
  const session = sessions.find(s => s.day === date(stamp * 1000));
  if (!session || !session.day.startsWith('2025')) return null;
  const daily = Object.fromEntries(['open', 'high', 'low', 'close'].map(f => [f, q[f][i]]));
  return { day: session.day, daily, delta: Object.fromEntries(Object.keys(daily).map(f => [f, session[f] - daily[f]])) };
}).filter(Boolean);
const exchangeChecks = [];
for (const [fileDate, day] of [['01012025', '2025-01-01'], ['07042025', '2025-04-07'], ['31122025', '2025-12-31']]) {
  const raw = await source(`nse-index-${fileDate}.csv`, `https://nsearchives.nseindia.com/content/indices/ind_close_all_${fileDate}.csv`);
  const row = raw.split(/\r?\n/).find(line => /^Nifty 50,/i.test(line));
  if (!row) throw new Error(`Nifty 50 missing from official ${day} file.`);
  const cells = row.split(','), session = sessions.find(s => s.day === day);
  const daily = Object.fromEntries(['open', 'high', 'low', 'close'].map((f, i) => [f, Number(cells[i + 2])]));
  exchangeChecks.push({ day, daily, delta: Object.fromEntries(Object.keys(daily).map(f => [f, session[f] - daily[f]])) });
}
let mirrorCheck = null;
try {
  // This agreement is corroboration only: a shared upstream broker may supply both archives.
  const mirror = await readFile('artifacts/kaggle-candidate/nifty50-2025.csv', 'utf8');
  await writeFile(`${out}/kaggle-2025-crosscheck.csv`, mirror);
  const rows = mirror.trim().split(/\r?\n/).slice(1).map(line => line.split(','));
  const reference = new Map(rows.map(c => [Date.parse(c[0].replace(' ', 'T') + '+05:30'), c.slice(1, 5).map(Number)]));
  let differences = 0, maxDifference = 0, overOnePoint = 0;
  for (const row of year) {
    const other = reference.get(row.time);
    if (!other) throw new Error('Secondary archive has a missing timestamp.');
    const difference = Math.max(...['open', 'high', 'low', 'close'].map((f, i) => Math.abs(row[f] - other[i])));
    if (difference > 0) differences++;
    if (difference > 1) overOnePoint++;
    maxDifference = Math.max(maxDifference, difference);
  }
  const full = await readFile('artifacts/kaggle-candidate/nifty50-minute-v18.csv', 'utf8');
  const alternative = full.trim().split(/\r?\n/).slice(1).filter(line => line.slice(0, 10) >= '2024-12-16' && line.slice(0, 10) <= '2025-12-31').map(line => {
    const [stamp, ...prices] = line.split(',');
    const [open, high, low, close] = prices.map(Number);
    const time = Date.parse(stamp.replace(' ', 'T') + '+05:30');
    if (!Number.isFinite(time) || time % M || ![open, high, low, close].every(Number.isFinite) || low <= 0 || low > Math.min(open, close) || high < Math.max(open, close)) throw new Error('Malformed secondary archive candle.');
    return { time, open, high, low, close };
  });
  if (alternative.length !== candles.length || alternative.some((row, i) => row.time !== candles[i].time)) throw new Error('Secondary archive calendar differs.');
  const alternateRaw = JSON.stringify(alternative);
  await writeFile(`${out}/minute-candles-kaggle.json`, alternateRaw);
  await copyFile('artifacts/kaggle-candidate/metadata-v18.json', `${out}/kaggle-metadata-v18.json`);
  mirrorCheck = { dataset: 'https://www.kaggle.com/datasets/debashis74017/nifty-50-minute-data', version: 18, file: 'kaggle-2025-crosscheck.csv', sha256: sha(mirror), originalFullFileSha256: sha(full), rows: rows.length, compared: year.length, differences, maxDifference, overOnePoint, independentFeedConfirmed: false, alternateDataFile: 'minute-candles-kaggle.json', alternateDataSha256: sha(alternateRaw), alternateCandlesIncludingWarmup: alternative.length };
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const serialized = JSON.stringify(candles);
await writeFile(`${out}/minute-candles.json`, serialized);
const audit = { generatedAt: new Date().toISOString(), symbol: '^NSEI', sourceCommit: commit, sources,
  dataSha256: sha(serialized), year: 2025, yearCandles: year.length, yearSessions: expectedDays.length,
  warmupFrom: date(warmup[0].time), warmupTo: date(warmup.at(-1).time), warmupCandles: warmup.length,
  nonTradingDates, sessionOverrides, sessions, missingDays, extraDays, dailyChecks, exchangeChecks, mirrorCheck,
  calendarSources: ['https://nsearchives.nseindia.com/content/circulars/CMTR65587.pdf', 'https://nsearchives.nseindia.com/content/circulars/CMTR65729.pdf', 'https://nsearchives.nseindia.com/content/circulars/CMTR70319.pdf'],
  provenanceNote: 'Community archive. Owner says unnamed broker API, no interpolation; not exchange-certified. https://github.com/technovusin/nifty50-historical-data/issues/2#issuecomment-6462834472',
  notes: ['Epoch and IST label agree for every row. All year/session minutes present; no duplicates or malformed OHLC.', 'No rows filled, interpolated, adjusted, or generated by this application. Uploader cleaning is documented in the saved README.', 'Daily high/low/open comparisons test broad consistency, not every minute. Daily settlement close can differ from the final minute.', '2025 uses 09:15-15:30 normal sessions, before the 2026 closing-auction change. Feb1 and Oct21 special sessions are included.'] };
await writeFile(`${out}/data-audit.json`, JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ yearCandles: year.length, sessions: expectedDays.length, warmupCandles: warmup.length,
  dailyCompared: dailyChecks.length, maxDailyDelta: Object.fromEntries(['open', 'high', 'low', 'close'].map(f => [f, Math.max(...dailyChecks.map(c => Math.abs(c.delta[f])))])), exchangeChecks, mirrorCheck,
  maxFlat: Math.max(...sessions.map(s => s.longestFlat)), missingDays, extraDays }));
