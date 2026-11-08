# C2 Fractal — free delayed index monitor

A read-only Next.js, TypeScript, and Tailwind dashboard for **1H → 5M**, **30M → 3M**, and **15M → 1M** C2/CISD setups. It fetches Yahoo Finance index candles on the server and links to the official NSE options chain for manual contract selection.

**No brokerage account, payment, credit card, API key, or daily login is needed to run locally.** There are no order-placement routes or broker connections. Options prices are **not integrated**: NSE's chain opens in a separate tab. Entry, stop, target, and 2R are **index levels**, not option premiums or an options payoff guarantee.

This is an experimental personal-use delayed-data monitor. Yahoo's public chart endpoint is unofficial for this integration, has no guaranteed availability or fixed delay, and can rate-limit cloud hosting. The UI labels the feed delayed and separates candle time from fetch time. A successful fetch does not mean prices are current. See [Yahoo's index page](https://finance.yahoo.com/quote/%5ENSEI/), [yfinance's description of public Yahoo access](https://ranaroussi.github.io/yfinance/), and the [NSE options chain](https://www.nseindia.com/option-chain).

## Run locally

Install Node.js 22 or newer, open a terminal in this folder, and run:

```powershell
npm install
npm run dev
```

Open **http://localhost:3000**. NIFTY 50 is selected by default and data loads automatically. Existing dependencies can be reused; installation is only needed on a fresh checkout or after dependency changes.

No environment file is required for the defaults. To customize, copy `.env.example` to `.env.local`, edit it, and restart:

```powershell
Copy-Item .env.example .env.local
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `INSTRUMENT_SYMBOL` | `^NSEI` | Allowed: `^NSEI` (NIFTY 50), `^NSEBANK` (NIFTY BANK). |
| `NSE_HOLIDAYS` | empty | Optional comma-separated full-day closures: `YYYY-MM-DD`. |

The display name is derived from the symbol. The supported regular session is **09:15–15:30 Asia/Kolkata**. Other exchanges, overnight products, and special sessions need different aggregation logic. The market-hours label is a weekday/session estimate, not a complete exchange calendar.

## Using the dashboard

1. Leave it open. Polling runs every 60 seconds while visible; pause/resume and manual refresh are available.
2. Check **data as of**, feed age, and stale/error notices. Outside scheduled hours, the screen shows the latest available session.
3. Select a timeframe card to open its chart and setup levels. Switch between the LTF CISD and HTF sweep charts, choose 40/80/120 candles, and toggle entry/SL/target overlays. Hover or use left/right arrows on the focused chart to inspect OHLC. Charts contain real closed candles from the same server snapshot; missing aggregates are omitted without creating synthetic candles. The time axis compresses gaps; crosshair dates are always IST. Drag to pan, scroll/pinch to zoom, or use the reset control to return to the latest range. A selected historical entry outside the chart range is labelled.
4. Each pair independently reports No Setup, Forming, Confirmed Bullish, Confirmed Bearish, or Invalidated. Entry uses a CISD confirming close strictly after the HTF sweep candle, SL is that sweep's exact low/high without a buffer, and target is 2R. Entry and target stay blank before confirmation. **Signal journal** retains every independently tracked setup; filter the list and select the row?s arrow to inspect any signal. Confirmed signals are historical references, not open-position status.
5. Use **Copy levels** to copy the selected index setup or **NSE options** to inspect expiries, strikes, and CE/PE prices manually on NSE. Check its timestamp too: the two views are not synchronized. Strategy details and data limitations are available under **Method & data**.
6. Switch between dark/light themes with the sun/moon button; the preference is stored locally. Keyboard shortcuts: **1/2/3** select a timeframe, **L** toggles levels, **R** refreshes, and **?** opens the guide. The chart supports arrow keys and Home/End with spoken candle values. Focus mode expands the chart; **Esc** restores the workspace. Polling preserves chart pan/zoom; switching timeframe or range resets it.

CantoLab defines a CISD trigger and closed-candle confirmation, but no trade fill. The current simplified strategy uses **entry and R from the CISD confirming close**, as selected by the user. Earlier confirmation flags are ignored: the confirming LTF candle must start at or after the HTF sweep close. The indicator's strict close-beyond predicate is retained; no fresh crossover is required. Each sweep freezes its own CISD level and stop. There is no C3/C4 expiry, T-spot invalidation, replacement, pre-entry wick rejection, hidden-signal filter, opposite-side filter or overlap restriction. Each sweep can enter once. Pending setups have no time limit within available history; data gaps reset uncertain pending state. Provider delay and polling mean these are historical reference prices, not executable quotes. The app does not select contracts, calculate option-premium stops, or place trades.

## Data handling

- The server requests Yahoo's `range=5d&interval=1m` chart feed. All six intervals are derived from the same minute stream.
- The latest delayed bar can still be partial. Closure is bounded by provider quote time and wall-clock time. The engine evaluates through the latest accepted minute close.
- Null rows remain gaps. Off-session quote markers are excluded. Malformed OHLC, contradictory duplicates, unexpected symbols, and invalid metadata are rejected.
- Aggregation requires every constituent minute, anchors at 09:15 IST, and clips the final hourly bar at 15:30. Intraday gaps reset affected state.
- A 60-second in-memory cache shares concurrent requests. Failures back off; an available older snapshot is marked stale with an error. The cache resets on restarts and does not coordinate separate Vercel instances.
- During scheduled hours, data over 20 minutes behind is marked stale. Outside those hours, freshness is checked against the latest expected weekday session close, accounting for configured holidays and allowing delay just after the close. An error fallback is retained for at most 24 hours after its successful fetch.
- The free endpoint has no promised rate limit or service-level agreement. HTTP 429 is respected; there is no proxy rotation, authentication workaround, or scraper fallback. Keep this a personal monitor, not a public redistribution service.
- Event IDs are deterministic. Polling replaces reconstructed history rather than appending duplicate alerts. History is bounded by the fetched lookback; provider candle corrections can change replay results.

## Indicator reference and tests

The original MIT-licensed Pine Script is pinned at commit `1bb53262deba9456f2b1a85d15c6ac5a5e880cf7` in [reference/](reference/). The current engine is [simple-strategy.ts](src/lib/simple-strategy.ts), with independent-position execution in [simple-backtest.ts](src/lib/simple-backtest.ts). It retains strict sweep predicates and directional-run CISD level selection, and implements the user's simplified lifecycle. The earlier full-indicator engine remains in `indicator.ts` for historical replay and shared candle/level helpers; its C3/C4 rules are not called by the dashboard.

Read [docs/indicator.md](docs/indicator.md) for source-line mappings, intentional differences, and a manual parity procedure. Tests use source-derived expected fixtures and verify the pinned source hash. **They do not execute TradingView's Pine runtime or certify all-history feed parity.**

```powershell
npm test
npm run typecheck
npm run build
```

Backend tests cover delayed-bar closure, gaps and malformed data, caching, failure/backoff behavior, and API responses without credentials. For a live smoke check, load all three cards, compare signal and entry-close timestamps, pause/resume, and open NSE's chain. An exchange-closed-day check cannot establish intraday latency.

## Historical backtest

**Selected strategy: simplified C2/CISD with daily exit.** This is the version whose 2025 primary-archive gross results are **+14.61R (1H → 5M), +50.89R (30M → 3M), and +10.10R (15M → 1M)**. Entry and risk use the post-sweep CISD close, SL is the exact C2 wick, TP is 2R, and overlapping positions are allowed. `runSimpleBacktest` defaults to closing at the actual session end. Overnight carry requires an explicit `holdingMode: 'carry'`; the year-comparison script requests each mode explicitly. The dashboard remains monitoring-only and never submits an exit order.

### Archived experiment: simplified vs restored full rules

The [full-rule comparison](reports/backtest-2025-full-rules/report.html) reruns the current simplified strategy against CantoLab's C3/C4 monitoring window, C2 wick invalidation, C4 T-spot invalidation and same-direction setup replacement. Both retain **post-sweep-only CISD, daily exits, exact-wick 2R and overlapping positions**. C1 is the reference candle; C3/C4 are confirmation phases; T-spots are zones. They are not separate entry strategies. Early CISD remains excluded at the user's request. The report includes actual C3/C4 entry counts and explains the source's delayed final-C3 confirmation boundary.

`src/lib/full-rule-backtest.ts` is retained only for reproducing this archived experiment. The restored full-rule variant is not selected. The dashboard uses the simplified strategy, and its backtest defaults to daily exit. Existing reports remain separately available; the fresh simplified baseline is checked against its saved trade ledger exactly. No order execution is added.

```powershell
node scripts/run-full-rule-comparison.mjs
node scripts/audit-full-rule-comparison.mjs
```

### Simplified strategy study

The current [simplified-strategy year report](reports/backtest-2025-simple/report.html) covers **1 January–31 December 2025: 249 sessions and 93,060 minute candles** per archive. Every eligible sweep trades independently, including simultaneous and overlapping positions. Carry positions exit only at SL/TP; daily exit adds an exit at actual session close (normally 15:30, Muhurat 14:45). Closed-price entries and exact-wick stops determine 2R. December data warms the indicator; unconfirmed December sweeps can qualify in January. Open year-end positions have no realized P&L. R totals are per-trade units, not account returns; peak concurrent positions and grouped-time realized drawdown are reported.

```powershell
node scripts/run-simple-year-backtest.mjs
node scripts/audit-simple-year.mjs
```

The independent audit reconstructs every frozen level, post-sweep confirmation, eligible entry, subsequent minute fill and summary from both archived minute feeds. It imports no production engine functions. The report records all execution assumptions, costs sensitivity and source hashes. Missing execution paths leave only their exposed positions unresolved; later independent entries are not suppressed.

### Preserved earlier strategies

The [previous full-indicator year comparison](reports/backtest-2025-comparison/report.html) used C3/C4 lifecycle rules and one position per pair. Its results are preserved separately and do not describe the current strategy. Both modes ran on the same complete calendar, with exact C2 stops and 2R targets. The Budget Saturday and shortened Muhurat session have explicit calendar overrides.

The [personal deep review](reports/deep-review-2026-11-08/report.html) records corrections to deferred CISD event ordering, initial warm-up levels, and missing-data availability timestamps. A separate source-derived reference now checks all frozen CISD levels and every signal transition. All twelve year-study ledgers and statistics remain unchanged after the corrections. These checks do not constitute a TradingView runtime parity test or an options-return backtest.

```powershell
node scripts/run-year-backtest.mjs
node scripts/audit-year-backtest.mjs
```

The main dataset is a pinned, MIT-licensed public archive from [Technovus](https://github.com/technovusin/nifty50-historical-data). It is community data from an unnamed broker, not exchange-certified minute data. A second full-year Kaggle archive is also tested: the archives differ on 6,847 OHLC rows, so both sets of results are shown. The [data audit](reports/backtest-2025-comparison/data/data-audit.json) records timestamp and calendar completeness, source hashes, all-year daily comparisons and three direct NSE daily-range checks. The [implementation audit](reports/backtest-2025-comparison/implementation-audit.json) independently recomputes every trade's price path and metrics from raw candles without importing the simulator. Neither audit certifies TradingView runtime equivalence or actual options profitability.

`scripts/prepare-year-data.mjs` validates the frozen acquisition and prepares normalized inputs. The saved normalized files and hashes are sufficient to reproduce the study. Its optional second-archive preparation also uses the downloaded Kaggle v18 acquisition in `artifacts/kaggle-candidate/`; the final normalized second-archive data is retained with the report.

The earlier 2026 carry study is in [reports/backtest-2026-11-08-carry/report.html](reports/backtest-2026-11-08-carry/report.html), with its full ledger in [results.json](reports/backtest-2026-11-08-carry/results.json). The full replay starts on 13 October and ends on 6 November 2026, with 12 October as warm-up. A separate uninterrupted-data study starts flat on 16 October, after the known missing-data session, and uses earlier candles only for indicator warm-up. These are separate portfolios, never stitched together. Run both without downloading new data:

```powershell
node scripts/run-backtest.mjs
```

The model uses theoretical CISD confirmation-close entries, exact C2 low/high stops, a 2R target, and one position per combination. **There is no timed or end-of-day exit.** Positions carry overnight and over holidays until SL, target, or explicit strategy invalidation. Setup expiry/replacement alone does not close a position. Stops and targets can execute only after entry; next-session stop gaps fill at the opening price and target gaps at the target. An overnight stop loss can therefore exceed 1R.

Execution uses the trusted 09:15–15:14 minute bars, including a new entry at the final candle's 15:15 close. It resumes at the next regular-session open without liquidating the position. Auction/finalization prints remain in indicator history but are excluded from execution. This is an index-data modelling assumption, not an options-market closing time; excluding that period can miss threshold crossings. See [SEBI's closing-auction circular](https://www.sebi.gov.in/sebi_data/attachdocs/jan-2026/1768576287344.pdf). The absent 20 October session is a verified [Dussehra holiday](https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf).

Missing execution minutes make exposed trades **unresolved** and block later entries for that timeframe for the rest of that replay, because position occupancy is unknown. Trades still active at the dataset boundary remain **open**, with no invented exit or realized P&L. The report separates these states and provides the independent 16 October onward study on uninterrupted data. Results are gross index reference returns, not option-premium returns or fills achievable from the delayed dashboard. The Pine indicator itself does not specify trade execution.

The [previous confirmation-close study with forced 15:15 exits](reports/backtest-2026-11-08-cisd/report.html) is preserved; `node scripts/run-cisd-intraday-backtest.mjs` uses its archived engine to reproduce it.

The [original next-open / 1-point-buffer report](reports/backtest-2026-11-08/report.html) is preserved for comparison. Its engine sources are archived under that report's `code/` directory; `node scripts/run-legacy-backtest.mjs` reproduces the old model. No parameters were selected by their performance.

`scripts/fetch-backtest-data.mjs` documents acquisition of this dated snapshot and retains raw response hashes. Rerunning that acquisition later may fail as Yahoo's minute-history window rolls forward; the frozen files are required for exact reproduction.

## Deploy to Vercel Hobby

1. Push the project to a Git repository and import it into Vercel as **Next.js**.
2. Choose the free **Hobby** plan for personal use, Node.js 22 or newer, and the default `npm run build` command.
3. Environment variables are optional; set them only to change defaults.
4. Deploy and check `/api/dashboard` for a successful real feed response from Vercel's network.

No database, worker, cron, OAuth callback, session secret, or paid data subscription is required. A Vercel account is needed only for hosting. [Hobby has usage limits and is intended for personal, non-commercial projects](https://vercel.com/docs/plans/hobby). If Yahoo blocks the deployment's IP, the app will show the failure. Local success is not proof of hosted feed access.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Rate limited | Wait for the cooldown; avoid duplicate tabs or deployments. |
| Provider unavailable | Wait and refresh. Yahoo can change or restrict this unofficial endpoint. |
| No complete candles | Check provider timestamps, recent sessions, and instrument configuration. |
| Old date / last session | Expected when the exchange is closed; the data date remains visible. |
| Stale during the session | Treat displayed levels as historical; wait for the source to catch up. |
| Entry pending | C2/CISD is not yet causally confirmed, or no valid positive-risk entry is available. |
| Options prices missing | Expected: this version links to NSE's external chain. |

## Project layout

```text
src/app/                 Dashboard and read-only server route
src/lib/indicator.ts     Pure causal indicator engine
src/lib/server/          Yahoo client, configuration, freshness, cache
tests/                   Indicator and backend tests
reference/               Pinned Pine Script and MIT license
docs/indicator.md        Source mapping and parity limitations
```


## Interface design references

The November 2026 redesign uses three narrowly selected agent skills, reviewed before installation:

- [Financial UI Patterns](https://github.com/rgourley/financial-ui-suite/tree/f060c1aa081606ceb345eb2ced369fc7faf63d69/skills/financial-ui-patterns): financial number alignment, delayed-feed disclosure, chart interactions, and accessible semantic states.
- [Financial UI Styles](https://github.com/rgourley/financial-ui-suite/tree/f060c1aa081606ceb345eb2ced369fc7faf63d69/skills/financial-ui-styles): the modern-pro-dark style, translated into complete dark and light token sets.
- [Design Elevation](https://github.com/cuellarfr/design-skills/tree/7e25e66e87f64f9d3dea22198f9e29937e7c48f5/skills/design-elevation): chart-first hierarchy, information density, spacing, and the reduction pass.

Both source repositories are MIT-licensed. The selection record, pinned revisions and alternatives are in `artifacts/ui-skill-research.json`. These are development instructions, not runtime dependencies. Chart rendering uses TradingView Lightweight Charts (Apache-2.0), with a visible creator link and `public/chart-notice.txt`. IBM Plex fonts are bundled locally; no font CDN is used. This redesign changes presentation and interactions only; the strategy engine and data routes are unchanged.
