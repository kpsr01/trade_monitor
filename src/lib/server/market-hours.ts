import "server-only";

/** Scheduled NSE hours only; supply NSE_HOLIDAYS for known full-day closures. */
export function isMarketHours(now: number) {
  const date = new Date(now + 330 * 60_000);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const holiday = (process.env.NSE_HOLIDAYS ?? "").split(",").map((v) => v.trim()).includes(date.toISOString().slice(0, 10));
  return !holiday && date.getUTCDay() > 0 && date.getUTCDay() < 6 && minutes >= 555 && minutes < 930;
}

/** A conservative delayed-feed check against the regular weekday session calendar. */
export function isDataStale(dataAsOf: number | null, now: number) {
  if (dataAsOf === null) return true;
  const tolerance = 20 * 60_000;
  if (isMarketHours(now)) return dataAsOf < now - tolerance;
  const day = 86_400_000;
  const ist = 330 * 60_000;
  const today = Math.floor((now + ist) / day) * day - ist;
  const holidays = new Set((process.env.NSE_HOLIDAYS ?? "").split(",").map((value) => value.trim()));
  for (let offset = 0; offset < 370; offset++) {
    const start = today - offset * day;
    const close = start + 930 * 60_000;
    const local = new Date(start + ist);
    if (close > now || local.getUTCDay() === 0 || local.getUTCDay() === 6 || holidays.has(local.toISOString().slice(0, 10))) continue;
    // Immediately after close, the final delayed minutes may not have arrived yet.
    return dataAsOf < Math.min(close, now - tolerance);
  }
  return true;
}
