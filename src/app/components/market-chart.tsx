'use client';

import { useEffect, useRef, useState } from 'react';
import { CandlestickChart, RotateCcw } from 'lucide-react';
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type Time,
  type ISeriesMarkersPluginApi, type AutoscaleInfo } from 'lightweight-charts';
import type { ClosedCandle } from '@/lib/indicator';

export const price = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function stamp(n: number | null | undefined, date = false) {
  return n == null ? '—' : new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ...(date ? { day: '2-digit', month: 'short' } as const : {}), hour: '2-digit', minute: '2-digit', hour12: false }).format(n);
}
export interface ChartSetup {
  entry: number | null; stopLoss: number | null; target: number | null;
  cisdLevel: number | null; entryAt: number | null;
}
const utc = (milliseconds: number) => milliseconds / 1000 as UTCTimestamp;

export function MarketChart({ candles, setup, showLevels, loading, theme, seriesKey, bars }: {
  candles: ClosedCandle[]; setup?: ChartSetup; showLevels: boolean; loading: boolean;
  theme: 'dark' | 'light'; seriesKey: string; bars: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const rows = useRef(candles);
  const levelValues = useRef<number[]>([]);
  const view = useRef('');
  const selectedBar = useRef<number | null>(null);
  const [hovered, setHovered] = useState<ClosedCandle | null>(null);
  const [keyboardReadout, setKeyboardReadout] = useState('');
  const [visibleWindow, setVisibleWindow] = useState<{ from: number; to: number } | null>(null);
  const [chartError, setChartError] = useState(false);
  const active = hovered ?? candles.at(-1);
  const outsideHistory = setup?.entryAt != null && candles.length > 0 &&
    (setup.entryAt < candles[0].time || setup.entryAt > candles.at(-1)!.closeTime);
  const outsideView = setup?.entryAt != null && visibleWindow != null &&
    (setup.entryAt < visibleWindow.from || setup.entryAt > visibleWindow.to);

  function resetView() {
    if (!chart.current || !rows.current.length) return;
    const count = rows.current.length;
    chart.current.priceScale('right').applyOptions({ autoScale: true });
    chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(-1, count - bars), to: count + 3 });
    chart.current.clearCrosshairPosition(); selectedBar.current = null; setHovered(null);
  }

  useEffect(() => {
    if (!container.current) return;
    try {
      const instance = createChart(container.current, {
        autoSize: true,
        layout: { attributionLogo: true, fontFamily: 'IBM Plex Sans Variable, sans-serif', fontSize: 11 },
        crosshair: { mode: CrosshairMode.Magnet },
        timeScale: { timeVisible: true, secondsVisible: false, borderVisible: false, rightOffset: 3, lockVisibleTimeRangeOnResize: true,
          tickMarkFormatter: (time: Time, tickType: number) => typeof time === 'number'
            ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ...(tickType < 3 ? { day: '2-digit', month: 'short' } as const : { hour: '2-digit', minute: '2-digit', hour12: false } as const) }).format(time * 1000) : null },
        rightPriceScale: { borderVisible: false, minimumWidth: 86, scaleMargins: { top: .12, bottom: .1 } },
        localization: { priceFormatter: price, timeFormatter: (time: Time) => typeof time === 'number' ? `${stamp(time * 1000, true)} IST` : String(time) },
        handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      });
      const candleSeries = instance.addSeries(CandlestickSeries, {
        priceFormat: { type: 'price', precision: 2, minMove: .01 },
        priceLineVisible: true, priceLineStyle: LineStyle.Dotted,
        autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
          const info = base();
          if (!info?.priceRange || !levelValues.current.length) return info;
          return { ...info, priceRange: { minValue: Math.min(info.priceRange.minValue, ...levelValues.current), maxValue: Math.max(info.priceRange.maxValue, ...levelValues.current) } };
        },
      });
      chart.current = instance; series.current = candleSeries;
      markers.current = createSeriesMarkers(candleSeries, []);
      instance.subscribeCrosshairMove(event => {
        const candle = event.time == null ? null : rows.current.find(c => utc(c.time) === event.time) ?? null;
        setHovered(candle);
      });
      instance.timeScale().subscribeVisibleTimeRangeChange(range => {
        if (!range || typeof range.from !== 'number' || typeof range.to !== 'number') { setVisibleWindow(null); return; }
        const lastVisible = rows.current.find(c => utc(c.time) === range.to);
        setVisibleWindow({ from: range.from * 1000, to: lastVisible?.closeTime ?? range.to * 1000 });
      });
      return () => { markers.current?.detach(); instance.remove(); chart.current = null; series.current = null; lines.current = []; view.current = ''; };
    } catch { setChartError(true); }
  }, []);

  useEffect(() => {
    if (!container.current || !chart.current || !series.current) return;
    const css = getComputedStyle(container.current);
    const color = (token: string) => css.getPropertyValue(token).trim();
    chart.current.applyOptions({
      layout: { background: { type: ColorType.Solid, color: color('--panel') }, textColor: color('--muted') },
      grid: { vertLines: { visible: false }, horzLines: { color: color('--grid') } },
      crosshair: { vertLine: { color: color('--muted'), labelBackgroundColor: color('--crosshair') }, horzLine: { color: color('--muted'), labelBackgroundColor: color('--crosshair') } },
    });
    series.current.applyOptions({ upColor: color('--panel'), downColor: color('--down'), borderUpColor: color('--up'), borderDownColor: color('--down'), wickUpColor: color('--up'), wickDownColor: color('--down') });
  }, [theme]);

  useEffect(() => {
    rows.current = candles;
    if (!series.current || !chart.current) return;
    series.current.setData(candles.map(c => ({ time: utc(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    const key = `${seriesKey}:${bars}`;
    // Polling preserves the viewport; switching timeframe or range resets it.
    if (view.current !== key && candles.length) {
      chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(-1, candles.length - bars), to: candles.length + 3 });
      chart.current.priceScale('right').applyOptions({ autoScale: true }); view.current = key;
    }
    selectedBar.current = null; setHovered(null);
  }, [candles, seriesKey, bars]);

  useEffect(() => {
    if (!series.current || !container.current) return;
    const instance = series.current;
    lines.current.forEach(line => instance.removePriceLine(line)); lines.current = [];
    const css = getComputedStyle(container.current);
    const levels = showLevels && setup ? [
      { title: 'ENTRY', value: setup.entry, token: '--accent' },
      { title: 'SL', value: setup.stopLoss, token: '--down' },
      { title: 'TP · 2R', value: setup.target, token: '--up' },
      ...(setup.entry == null ? [{ title: 'CISD', value: setup.cisdLevel, token: '--accent' }] : []),
    ].filter((l): l is { title: string; value: number; token: string } => l.value != null) : [];
    levelValues.current = levels.map(l => l.value);
    lines.current = levels.map(l => instance.createPriceLine({ price: l.value, title: l.title, color: css.getPropertyValue(l.token).trim(), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, axisLabelTextColor: css.getPropertyValue('--panel').trim() }));
    const entryCandle = candles.find(c => c.closeTime === setup?.entryAt);
    markers.current?.setMarkers(showLevels && entryCandle && setup?.entry != null
      ? [{ time: utc(entryCandle.time), position: 'belowBar', color: css.getPropertyValue('--accent').trim(), shape: 'circle', text: 'CISD' }] : []);
    instance.applyOptions({});
  }, [setup?.entry, setup?.stopLoss, setup?.target, setup?.cisdLevel, setup?.entryAt, showLevels, theme, candles]);

  return <div className="market-chart">
    <div className="ohlc-strip" aria-label="Candle values">
      <time>{stamp(active?.time, true)} <span>IST</span></time>
      <div>{(['open', 'high', 'low', 'close'] as const).map((key, i) => <span key={key}><small>{['O', 'H', 'L', 'C'][i]}</small><b>{price(active?.[key])}</b></span>)}</div>
      <button className="icon-button chart-reset" onClick={resetView} aria-label="Reset chart view" title="Reset chart view"><RotateCcw size={14} /></button>
    </div>
    <div className="chart-stage" tabIndex={0} role="group" aria-label="Interactive candlestick chart" aria-describedby="chart-instructions" onKeyDown={e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !candles.length) return;
      e.preventDefault();
      const previous = selectedBar.current ?? candles.length - 1;
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? candles.length - 1 : Math.max(0, Math.min(candles.length - 1, previous + (e.key === 'ArrowLeft' ? -1 : 1)));
      selectedBar.current = index; setHovered(candles[index]);
      const range = chart.current?.timeScale().getVisibleLogicalRange();
      if (range && (index < range.from || index > range.to)) {
        const span = range.to - range.from;
        const from = Math.max(-1, index < range.from ? index - 2 : index + 2 - span);
        chart.current?.timeScale().setVisibleLogicalRange({ from, to: from + span });
      }
      if (series.current) chart.current?.setCrosshairPosition(candles[index].close, utc(candles[index].time), series.current);
      const candle = candles[index];
      setKeyboardReadout(`${stamp(candle.time, true)} IST. Open ${price(candle.open)}, high ${price(candle.high)}, low ${price(candle.low)}, close ${price(candle.close)}.`);
    }}>
      <div ref={container} className="chart-canvas" />
      {(!candles.length || chartError) && <div className="chart-empty" role="status"><CandlestickChart size={28} strokeWidth={1.25} /><strong>{chartError ? 'Chart could not load' : loading ? 'Loading market data' : 'No candle data available'}</strong><span>{chartError ? 'Levels remain available in the setup panel.' : loading ? 'Fetching closed candles from Yahoo Finance' : 'Refresh the feed to try again.'}</span></div>}
      {(outsideHistory || outsideView) && showLevels && <div className="range-note">{outsideHistory ? 'Signal outside available chart history' : 'Signal outside visible range'}</div>}
    </div>
    <p className="sr-only" id="chart-instructions">Drag to pan. Scroll or pinch to zoom. Use left and right arrows to inspect candles; Home and End jump to the first and last candle. All timestamps are IST. Up candles are hollow; down candles are filled.</p>
    <span className="sr-only" role="status">{keyboardReadout}</span>
  </div>;
}
