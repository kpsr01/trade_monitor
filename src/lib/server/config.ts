import "server-only";

export class ConfigurationError extends Error {}

export const INSTRUMENTS = {
  "^NSEI": { name: "NIFTY 50", symbol: "^NSEI", exchange: "NSE" },
  "^NSEBANK": { name: "NIFTY BANK", symbol: "^NSEBANK", exchange: "NSE" },
} as const;
export type IndexSymbol = keyof typeof INSTRUMENTS;

/** Server-selected symbols only. No caller-controlled host or symbol is fetched. */
export function publicConfig() {
  const symbol = process.env.INSTRUMENT_SYMBOL || "^NSEI";
  if (!Object.hasOwn(INSTRUMENTS, symbol)) {
    throw new ConfigurationError("INSTRUMENT_SYMBOL must be ^NSEI (NIFTY 50) or ^NSEBANK (NIFTY BANK).");
  }
  return {
    instrument: INSTRUMENTS[symbol as IndexSymbol],
  };
}
