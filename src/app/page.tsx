'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronDown, Copy, ExternalLink, CandlestickChart, Layers3, Pause, Play, RefreshCw, SlidersHorizontal, X, Info, Sun, Moon, Keyboard, Maximize2, Minimize2, Clock3, Radio, ChevronRight } from 'lucide-react';
import type { DashboardData } from '@/lib/contracts';
import { MarketChart, price, stamp } from './components/market-chart';

const pairs = [{ higher: 60, lower: 5, label: '1H → 5M' }, { higher: 30, lower: 3, label: '30M → 3M' }, { higher: 15, lower: 1, label: '15M → 1M' }];
const statusLabels: Record<string, string> = { no_setup: 'No setup', forming: 'Forming', confirmed_bullish: 'Confirmed bullish', confirmed_bearish: 'Confirmed bearish', invalidated: 'Invalidated' };
const tone = (status?: string) => status === 'confirmed_bullish' ? 'bull' : status === 'confirmed_bearish' ? 'bear' : status === 'forming' ? 'forming' : 'neutral';
const tf = (minutes: number) => minutes === 60 ? '1H' : `${minutes}M`;

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [clock, setClock] = useState<number | null>(null);
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(1);
  const [signalId, setSignalId] = useState<string | null>(null);
  const [scope, setScope] = useState<'lower' | 'higher'>('lower');
  const [bars, setBars] = useState(80);
  const [showLevels, setShowLevels] = useState(true);
  const [filter, setFilter] = useState('all');
  const [visible, setVisible] = useState(8);
  const [copyState, setCopyState] = useState('Copy levels');
  const method = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const lastRequested = useRef(0);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const controller = new AbortController(); abort.current = controller;
    setLoading(true); lastRequested.current = Date.now(); setRequestedAt(lastRequested.current);
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch('/api/dashboard', { cache: 'no-store', signal: controller.signal });
      const body: DashboardData = await response.json();
      if (typeof body.connected !== 'boolean' || !Array.isArray(body.setups) || body.provider !== 'yahoo') throw new Error('Invalid dashboard response');
      if (controller.signal.aborted) return;
      setData(body); setNetworkError(null);
    } catch (error) {
      if (!controller.signal.aborted || abort.current === controller) setNetworkError(error instanceof Error && error.name === 'AbortError' ? 'Request timed out. Try refreshing.' : 'Connection unavailable. Try refreshing.');
    } finally {
      clearTimeout(timeout);
      if (abort.current === controller) { pending.current = false; setLoading(false); abort.current = null; }
    }
  }, []);
  useEffect(() => { void refresh(); return () => { const controller = abort.current; abort.current = null; pending.current = false; controller?.abort(); }; }, [refresh]);
  useEffect(() => {
    const poll = setInterval(() => {
      setClock(Date.now());
      if (!paused && document.visibilityState === 'visible' && Date.now() - lastRequested.current >= 60_000) void refresh();
    }, 1_000);
    const onVisible = () => { if (!paused && document.visibilityState === 'visible' && Date.now() - lastRequested.current >= 60_000) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(poll); document.removeEventListener('visibilitychange', onVisible); };
  }, [paused, refresh]);
  useEffect(() => { setCopyState('Copy levels'); }, [selected, signalId, data]);

  useEffect(() => {
    try { if (localStorage.getItem('c2-theme') === 'light') setTheme('light'); } catch { /* Storage is optional. */ }
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (event.ctrlKey || event.metaKey || event.altKey || element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || document.querySelector('dialog[open]')) return;
      if (['1', '2', '3'].includes(event.key)) { setSelected(Number(event.key) - 1); setSignalId(null); }
      else if (event.key.toLowerCase() === 'l') setShowLevels(value => !value);
      else if (event.key.toLowerCase() === 'r') void refresh();
      else if (event.key === '?') method.current?.showModal();
      else if (event.key === 'Escape') setExpanded(false);
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [refresh]);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next);
    try { localStorage.setItem('c2-theme', next); } catch { /* Theme still works without storage. */ }
  };

  const setups = data?.setups ?? [];
  const current = setups.find(s => s.higherMinutes === pairs[selected].higher);
  const active = signalId ? current?.signals.find(s => s.signalId === signalId) : current;
  const chartSeries = data?.charts?.find(s => s.higherMinutes === pairs[selected].higher);
  const candles = useMemo(() => chartSeries?.[scope] ?? [], [chartSeries, scope]);
  const aged = clock != null && ((data?.fetchedAt != null && clock - data.fetchedAt > 120_000) || (data?.marketOpen && data.dataAsOf != null && clock - data.dataAsOf > 1_200_000));
  const stale = Boolean(data?.stale || networkError || aged);
  const countdown = requestedAt && clock ? Math.max(0, 60 - Math.floor((clock - requestedAt) / 1000)) : 60;
  const error = networkError || data?.error?.message;
  const allSignals = setups.flatMap(s => s.signals.map(signal => ({ ...signal, pair: pairs.findIndex(p => p.higher === s.higherMinutes) }))).filter(s => s.pair >= 0).sort((a, b) => (b.confirmedAt ?? b.formedAt) - (a.confirmedAt ?? a.formedAt));
  const filtered = allSignals.filter(s => filter === 'all' || (filter === 'confirmed' ? s.status.startsWith('confirmed') : s.status === 'forming'));
  const quote = data?.quote;
  const change = quote?.sessionOpen ? (quote.price - quote.sessionOpen) / quote.sessionOpen * 100 : null;
  const risk = active?.entry != null && active.stopLoss != null ? Math.abs(active.entry - active.stopLoss) : null;
  const selectedStatus = active ? statusLabels[active.status] : loading ? 'Loading' : data?.connected ? 'No setup' : 'Data unavailable';
  const selectPair = (index: number) => { setSelected(index); setSignalId(null); };
  async function copyLevels() {
    if (active?.entry == null) return;
    const text = `${data?.instrument.name} · ${pairs[selected].label}\n${selectedStatus}\nEntry ${price(active.entry)}\nSL ${price(active.stopLoss)}\nTP ${price(active.target)} · 2R\nConfirmed ${stamp(active.confirmedAt, true)} IST\nDaily exit · delayed index reference, not an option quote.`;
    try { await navigator.clipboard.writeText(text); setCopyState('Copied'); } catch { setCopyState('Copy unavailable'); }
  }

  return <div className={`app-shell ${expanded ? 'focus-mode' : ''}`} data-theme={theme}>
    <a className="skip-link" href="#chart">Skip to chart</a>
    <header className="topbar">
      <a className="brand" href="#workspace" aria-label="C2 Fractal workspace"><span className="brand-mark"><CandlestickChart size={22} strokeWidth={1.8} /></span><b>C2<span>fractal</span></b></a>
      <nav aria-label="Main navigation"><a href="#workspace" className="nav-active">Workspace</a><a href="#signals">Signals <span>{allSignals.length}</span></a></nav>
      <div className="header-end"><span className="monitor-label"><Radio size={13} />Monitor only</span><span className="header-divider" /><button className="icon-button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button><button className="icon-button" aria-label="Strategy and keyboard shortcuts" title="Strategy & shortcuts (?)" aria-keyshortcuts="Shift+/" onClick={() => method.current?.showModal()}><Keyboard size={18} /></button></div>
    </header>
    <main id="workspace">
      <section className="market-heading" aria-label="Market overview">
        <div className="instrument"><span className="index-symbol">N</span><div><h1>{data?.instrument.name ?? 'NIFTY 50'}</h1><span>NSE <span className="middot">·</span> Index</span></div></div>
        <div className="market-price"><strong>{price(quote?.price)}</strong>{change !== null ? <span className={change >= 0 ? 'bull' : 'bear'}>{change >= 0 ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}{change >= 0 ? '+' : ''}{change.toFixed(2)}% <small>from open</small></span> : <span className="muted">Session change unavailable</span>}</div>
        <div className="session-meta"><span><Clock3 size={13} />{data?.marketOpen ? 'Session open' : data ? 'Session closed' : 'Connecting'}</span><span className="rule-chips"><b>C2 / CISD</b><b>2R target</b><b>Daily exit</b></span></div>
        <div className="market-controls"><div className="feed-status"><span className={`status-dot ${error || stale ? 'warn' : ''}`} />{loading && !data ? 'Connecting' : !data?.connected ? 'Offline' : stale ? 'Stale data' : 'Delayed feed'}<span className="feed-provider">Yahoo Finance</span></div><div className="refresh-controls"><span className="refresh-count">{paused ? 'Auto-refresh paused' : loading ? 'Refreshing…' : `Next update ${countdown}s`}</span><button className="icon-button" onClick={() => setPaused(p => !p)} aria-label={paused ? 'Resume polling' : 'Pause polling'} title={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}>{paused ? <Play size={14} /> : <Pause size={14} />}</button><button className="icon-button" aria-label="Refresh market data" aria-keyshortcuts="R" title="Refresh (R)" disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? 'spinning' : ''} /></button></div></div>
      </section>

      {(error || stale) && <div className="notice" role="status"><Info size={16} /><span>{error || 'Data is stale. These levels are historical references.'}</span><button onClick={() => void refresh()} disabled={loading}>Retry <ArrowRight size={14} /></button></div>}

      <div className="workspace-grid">
        <section className="chart-panel panel" id="chart" aria-label="Price chart">
          <div className="panel-toolbar"><div className="chart-title"><CandlestickChart size={16} /><h2>Price action</h2><span>{tf(pairs[selected].higher)} <ArrowRight size={12} /> {tf(pairs[selected].lower)}</span></div><div className="chart-actions"><button className={`text-button ${showLevels ? 'active' : ''}`} aria-pressed={showLevels} aria-keyshortcuts="L" title="Toggle levels (L)" onClick={() => setShowLevels(v => !v)}><SlidersHorizontal size={14} /><span>Levels</span></button><button className="icon-button" aria-label={expanded ? 'Exit chart focus' : 'Focus chart'} title={expanded ? 'Exit focus (Esc)' : 'Focus chart'} onClick={() => setExpanded(v => !v)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button></div></div>
          <div className="chart-tools"><div className="timeframe-tabs" aria-label="Chart timeframe">{(['lower', 'higher'] as const).map(value => <button key={value} aria-pressed={scope === value} className={scope === value ? 'active' : ''} onClick={() => setScope(value)}><b>{tf(pairs[selected][value])}</b><span>{value === 'lower' ? 'CISD' : 'Sweep'}</span></button>)}</div><div className="chart-meta"><span>Closed candles <span className="middot">·</span> IST</span><label className="range-select"><select aria-label="Visible chart candles" value={bars} onChange={e => setBars(Number(e.target.value))}><option value={40}>40 bars</option><option value={80}>80 bars</option><option value={120}>120 bars</option></select><ChevronDown size={12} /></label></div></div>
          <div className="mobile-pairs" aria-label="Select timeframe">{pairs.map((pair, index) => <button key={pair.higher} aria-pressed={selected === index} onClick={() => selectPair(index)}>{pair.label}</button>)}</div>
          <MarketChart candles={candles} setup={active} showLevels={showLevels} loading={loading} theme={theme} bars={bars} seriesKey={`${selected}:${scope}`} />
          <div className="chart-footer"><span><i className="legend-line entry" />Entry<i className="legend-line stop" />SL<i className="legend-line target" />2R</span><span>Drag to pan <span className="middot">·</span> Scroll to zoom</span><span className="chart-asof">As of {stamp(data?.dataAsOf, true)} IST</span></div>
        </section>

        <aside className="setup-sidebar" aria-label="Timeframe setups">
          <div className="sidebar-heading"><h2>Setup watch</h2><span>3 timeframes</span></div>
          <div className="setup-list">
            {pairs.map((pair, index) => {
              const result = setups.find(s => s.higherMinutes === pair.higher);
              return <button key={pair.higher} className={`setup-card ${selected === index ? 'selected' : ''}`} aria-pressed={selected === index} aria-label={`Select ${pair.label} setup`} aria-keyshortcuts={String(index + 1)} onClick={() => selectPair(index)}>
                <span className="card-top"><span className="pair-label">{tf(pair.higher)}<ArrowRight size={13} />{tf(pair.lower)}</span><kbd>{index + 1}</kbd><ChevronRight className="card-chevron" size={15} /></span>
                <span className={`signal-status ${tone(result?.status)}`}><span className="status-dot" />{result ? statusLabels[result.status] : loading ? 'Loading' : 'No data'}</span>
                <span className="card-levels"><span><small>Entry</small><b>{price(result?.entry)}</b></span><span><small>SL</small><b>{price(result?.stopLoss)}</b></span><span><small>TP <em>2R</em></small><b>{price(result?.target)}</b></span></span>
                <span className="card-time">{result?.confirmedAt ? `Confirmed ${stamp(result.confirmedAt, true)} IST` : 'Awaiting CISD close'}<span title={`Updated ${stamp(result?.updatedAt, true)} IST`}>Updated {stamp(result?.updatedAt)} IST</span></span>
              </button>;
            })}
          </div>
          <section className="trade-panel panel" aria-label="Selected setup levels">
            <div className="trade-heading"><span>SELECTED SETUP</span><span>{pairs[selected].label}</span></div>
            <h2 className={tone(active?.status)}>{active?.direction === 'bullish' ? <ArrowUpRight size={21} /> : active?.direction === 'bearish' ? <ArrowDownRight size={21} /> : <Layers3 size={20} />}{selectedStatus}</h2>
            <span className="reference-label">{active?.confirmedAt ? `${stamp(active.confirmedAt, true)} IST · historical` : 'Waiting for confirmation'}</span>
            <div className="trade-entry"><div><span>Entry</span><small>CISD close</small></div><strong>{price(active?.entry)}</strong></div>
            <div className="bracket-row"><span><i className="level-dot stop" />Stop loss</span><strong>{price(active?.stopLoss)}</strong></div>
            <div className="bracket-row"><span><i className="level-dot target" />Take profit <small>2R</small></span><strong>{price(active?.target)}</strong></div>
            <div className="risk-scale"><span>Risk <b>{price(risk)} pts</b></span><span>Reward <b>{price(risk == null ? null : risk * 2)} pts</b></span><div aria-label="Reward is twice the risk"><i /><i /></div></div>
            <div className="trade-policy"><span>Exact wick SL</span><span>Daily exit</span></div>
            <div className="trade-actions"><button className="primary-button" onClick={() => void copyLevels()} disabled={active?.entry == null}>{copyState === 'Copied' ? <Check size={15} /> : <Copy size={14} />}<span aria-live="polite">{copyState}</span></button><a className="secondary-button" href="https://www.nseindia.com/option-chain" target="_blank" rel="noopener noreferrer">NSE options <ExternalLink size={13} /></a></div>
            <span className="trade-note">Index levels · not option premiums</span>
            {signalId && <button className="back-latest" onClick={() => setSignalId(null)}>Return to latest setup <ArrowRight size={13} /></button>}
          </section>
        </aside>

        <section className="signals-panel panel" id="signals" aria-label="Signal history">
          <div className="signals-heading"><h2>Signal journal <span>{allSignals.length}</span></h2><div className="filters" aria-label="Filter signals">{['all', 'confirmed', 'forming'].map(value => <button key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => { setFilter(value); setVisible(8); }}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div></div>
          <div className="table-scroll"><table><caption className="sr-only">Historical C2 sweeps across all three timeframes. All times are IST; prices are index reference levels.</caption><thead><tr><th scope="col">Time · IST</th><th scope="col">Window</th><th scope="col">Signal</th><th scope="col" className="numeric">Entry</th><th scope="col" className="numeric optional-column">SL</th><th scope="col" className="numeric optional-column">TP · 2R</th><th scope="col"><span className="sr-only">View signal</span></th></tr></thead><tbody>{filtered.slice(0, visible).map(s => <tr key={s.signalId} className={s.signalId === active?.signalId ? 'selected-row' : ''}><td className="time-cell">{stamp(s.confirmedAt ?? s.formedAt, true)}</td><td className="window-cell">{pairs[s.pair].label}</td><td><span className={`signal-status ${tone(s.status)}`}><span className="status-dot" /><span className="full-status">{statusLabels[s.status]}</span><span className="short-status">{s.status === 'confirmed_bullish' ? 'Bullish' : s.status === 'confirmed_bearish' ? 'Bearish' : statusLabels[s.status]}</span></span></td><td className="numeric">{price(s.entry)}</td><td className="numeric optional-column">{price(s.stopLoss)}</td><td className="numeric optional-column">{price(s.target)}</td><td><button className="row-action" aria-label={`View ${pairs[s.pair].label} signal ${stamp(s.confirmedAt ?? s.formedAt, true)}`} onClick={() => { setSelected(s.pair); setSignalId(s.signalId); setScope('lower'); document.getElementById('chart')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}><ArrowUpRight size={15} /></button></td></tr>)}</tbody></table></div>
          {!filtered.length && <div className="empty-signals"><Layers3 size={20} /><span>{loading ? 'Loading signals…' : 'No signals in this view.'}</span></div>}
          <div className="table-footer"><span>{Math.min(visible, filtered.length)} / {filtered.length} <span className="middot">·</span> Historical signals</span>{visible < filtered.length && <button onClick={() => setVisible(v => v + 20)}>Show more <ChevronDown size={13} /></button>}</div>
        </section>
      </div>
      <footer><span><span className="status-dot" />Yahoo Finance <span className="middot">·</span> Delayed<span className="footer-fetched"> <span className="middot">·</span> Fetched {stamp(data?.fetchedAt)} IST</span></span><a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charts by TradingView</a><button onClick={() => method.current?.showModal()}>Method & data <ArrowUpRight size={12} /></button></footer>
    </main>
    <dialog ref={method} className="method-dialog" onClick={e => { if (e.target === method.current) method.current.close(); }}><div className="dialog-content"><div className="dialog-heading"><span className="eyebrow">METHOD & CONTROLS</span><button className="icon-button" onClick={() => method.current?.close()} aria-label="Close strategy information"><X size={18} /></button></div><h2>One sweep. One confirmation.</h2><ol><li><b>HTF sweep</b><span>Price sweeps the previous candle’s high or low and closes back inside that level.</span></li><li><b>CISD close</b><span>A later LTF candle closes beyond the frozen CantoLab CISD level. Entry and risk use this close.</span></li><li><b>Exact wick. 2R.</b><span>SL is the C2 extreme. Target is twice the initial risk. Daily exit is the selected backtest policy.</span></li></ol><p>All sweeps are independent; overlaps are allowed. No C3/C4 expiry or T-spot filter.</p><div className="shortcut-grid"><span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> Switch window</span><span><kbd>L</kbd> Toggle levels</span><span><kbd>R</kbd> Refresh feed</span><span><kbd>?</kbd> This guide</span></div><div className="dialog-disclosure"><b>Historical signals, not open positions.</b><p>Yahoo data is delayed and availability is not guaranteed. Charts use closed candles only; gaps are not filled. The rolling lookback may lose older pending sweeps. Levels are theoretical index prices, not executable quotes or options returns. Options prices open separately on NSE. This dashboard never places orders.</p></div><div className="dialog-links"><a href="https://github.com/cantolab/open-source-fractal" target="_blank" rel="noopener noreferrer">CantoLab source <ExternalLink size={13} /></a><a href="/chart-notice.txt" target="_blank" rel="noopener noreferrer">Chart attribution <ExternalLink size={13} /></a></div></div></dialog>
  </div>;
}
