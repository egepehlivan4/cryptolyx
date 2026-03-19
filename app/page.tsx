'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickData,
  IChartApi,
  ISeriesApi,
  LineData,
  LineStyle,
  SeriesMarker,
  Time,
} from 'lightweight-charts';

// --- TİPLER VE YARDIMCI FONKSİYONLAR ---
type IndicatorType = 'none' | 'sma' | 'ema';
type ChartPattern = 'none' | 'support_resistance' | 'zigzag';
type SymbolType = 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT' | 'AVAXUSDT' | 'BNBUSDT';

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type LinePoint = { time: number; value: number };

function calculateSMA(candles: Candle[], period: number = 20): LinePoint[] {
  if (period <= 0 || candles.length < period) return [];
  const result: LinePoint[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  result.push({ time: candles[period - 1].time, value: sum / period });
  for (let i = period; i < candles.length; i++) {
    sum = sum - candles[i - period].close + candles[i].close;
    result.push({ time: candles[i].time, value: sum / period });
  }
  return result;
}

function calculateEMA(candles: Candle[], period: number = 20): LinePoint[] {
  if (period <= 0 || candles.length < period) return [];
  const result: LinePoint[] = [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  let prevEma = sum / period;
  result.push({ time: candles[period - 1].time, value: prevEma });
  for (let i = period; i < candles.length; i++) {
    const ema = candles[i].close * k + prevEma * (1 - k);
    prevEma = ema;
    result.push({ time: candles[i].time, value: ema });
  }
  return result;
}

function calculateRSI(candles: Candle[], period: number = 14): LinePoint[] {
  if (period <= 0 || candles.length <= period) return [];
  const closes = candles.map((c) => c.close);
  const result: LinePoint[] = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  let rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  let rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  result.push({ time: candles[period].time, value: rsi });
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
    rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
    result.push({ time: candles[i].time, value: rsi });
  }
  return result;
}

type CrossSignal = 'golden' | 'death';
type CrossMarkerInput = { time: number; signal: CrossSignal; price: number };

function detectCrossSignals(
  shortMA: LinePoint[],
  longMA: LinePoint[],
  candles: Candle[]
): CrossMarkerInput[] {
  if (shortMA.length === 0 || longMA.length === 0) return [];
  const shortMap = new Map<number, number>();
  const longMap = new Map<number, number>();
  for (const p of shortMA) shortMap.set(p.time, p.value);
  for (const p of longMA) longMap.set(p.time, p.value);

  const signals: CrossMarkerInput[] = [];
  let prevDiff: number | undefined = undefined;

  for (const candle of candles) {
    const t = candle.time;
    const s = shortMap.get(t);
    const l = longMap.get(t);
    if (s === undefined || l === undefined) continue;
    const diff = s - l;
    if (prevDiff !== undefined) {
      if (prevDiff < 0 && diff > 0) signals.push({ time: t, signal: 'golden', price: candle.close });
      else if (prevDiff > 0 && diff < 0) signals.push({ time: t, signal: 'death', price: candle.close });
    }
    prevDiff = diff;
  }
  return signals;
}

function calculateZigZagPoints(candles: Candle[], deviationPercent: number = 0.05): LinePoint[] {
  if (candles.length < 3 || deviationPercent <= 0) return [];
  const dev = deviationPercent;
  type Pivot = { time: number; value: number; index: number };
  const points: Pivot[] = [];

  let lastPivotType: 'low' | 'high' = 'low';
  let lastPivotPrice = candles[0].low;
  points.push({ time: candles[0].time, value: lastPivotPrice, index: 0 });

  let extremeHigh = candles[0].high, extremeHighIndex = 0;
  let extremeLow = candles[0].low, extremeLowIndex = 0;
  let seekingUpStarted = false, seekingDownStarted = false;

  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    if (lastPivotType === 'low') {
      if (high > extremeHigh) { extremeHigh = high; extremeHighIndex = i; }
      if (!seekingUpStarted && extremeHigh >= lastPivotPrice * (1 + dev)) seekingUpStarted = true;
      if (seekingUpStarted && low <= extremeHigh * (1 - dev)) {
        if (points[points.length - 1].index !== extremeHighIndex) {
          points.push({ time: candles[extremeHighIndex].time, value: extremeHigh, index: extremeHighIndex });
        }
        lastPivotType = 'high'; lastPivotPrice = extremeHigh;
        extremeLow = low; extremeLowIndex = i; seekingUpStarted = false;
      }
    } else {
      if (low < extremeLow) { extremeLow = low; extremeLowIndex = i; }
      if (!seekingDownStarted && extremeLow <= lastPivotPrice * (1 - dev)) seekingDownStarted = true;
      if (seekingDownStarted && high >= extremeLow * (1 + dev)) {
        if (points[points.length - 1].index !== extremeLowIndex) {
          points.push({ time: candles[extremeLowIndex].time, value: extremeLow, index: extremeLowIndex });
        }
        lastPivotType = 'low'; lastPivotPrice = extremeLow;
        extremeHigh = high; extremeHighIndex = i; seekingDownStarted = false;
      }
    }
  }

  const lastPoint = points[points.length - 1];
  if (lastPivotType === 'low' && seekingUpStarted && lastPoint.index !== extremeHighIndex) {
    points.push({ time: candles[extremeHighIndex].time, value: extremeHigh, index: extremeHighIndex });
  }
  if (lastPivotType === 'high' && seekingDownStarted && lastPoint.index !== extremeLowIndex) {
    points.push({ time: candles[extremeLowIndex].time, value: extremeLow, index: extremeLowIndex });
  }

  if (points.length < 2) return [];

  const curved: LinePoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i], p1 = points[i + 1];
    curved.push({ time: p0.time, value: p0.value });
    const stepCount = p1.index - p0.index;
    if (stepCount > 1) {
      for (let j = 1; j < stepCount; j++) {
        const currentIdx = p0.index + j;
        const t = j / stepCount;
        const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
        curved.push({ time: candles[currentIdx].time, value: p0.value + (p1.value - p0.value) * eased });
      }
    }
  }
  curved.push({ time: points[points.length - 1].time, value: points[points.length - 1].value });
  return curved;
}

// --- GRAFİK BİLEŞENİ (PROFESYONEL TEMA) ---
function CandlestickChart(props: {
  candles: Candle[];
  shortMA?: LinePoint[] | null;
  longMA?: LinePoint[] | null;
  rsiData?: LinePoint[] | null;
  markers?: SeriesMarker<Time>[];
  selectedPattern: ChartPattern;
  zigzagDeviationPercent: number;
}) {
  const { candles, shortMA, longMA, rsiData, markers, selectedPattern, zigzagDeviationPercent } = props;

  const mainContainerRef = useRef<HTMLDivElement | null>(null);
  const rsiContainerRef = useRef<HTMLDivElement | null>(null);

  const mainChartRef = useRef<IChartApi | null>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const shortMASeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const longMASeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const supportSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const resistanceSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const zigzagSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const rsiValueByTimeRef = useRef<Map<number, number>>(new Map());
  const closeValueByTimeRef = useRef<Map<number, number>>(new Map());

  // --- ZOOM KONTROLLERİ ---
  const handleZoomIn = () => {
    if (!mainChartRef.current) return;
    const timeScale = mainChartRef.current.timeScale();
    const currentRange = timeScale.getVisibleLogicalRange();
    if (currentRange) {
      const delta = (currentRange.to - currentRange.from) * 0.15;
      timeScale.setVisibleLogicalRange({
        from: currentRange.from + delta,
        to: currentRange.to - delta,
      });
    }
  };

  const handleZoomOut = () => {
    if (!mainChartRef.current) return;
    const timeScale = mainChartRef.current.timeScale();
    const currentRange = timeScale.getVisibleLogicalRange();
    if (currentRange) {
      const delta = (currentRange.to - currentRange.from) * 0.15;
      timeScale.setVisibleLogicalRange({
        from: currentRange.from - delta,
        to: currentRange.to + delta,
      });
    }
  };

  const handleResetZoom = () => {
    if (!mainChartRef.current) return;
    mainChartRef.current.timeScale().fitContent();
  };
  // -------------------------

  useEffect(() => {
    rsiValueByTimeRef.current = new Map((rsiData ?? []).map((p) => [p.time, p.value] as const));
  }, [rsiData]);

  useEffect(() => {
    closeValueByTimeRef.current = new Map(candles.map((c) => [c.time, c.close] as const));
  }, [candles]);

  useEffect(() => {
    if (!mainContainerRef.current || !rsiContainerRef.current) return;
    if (mainChartRef.current || rsiChartRef.current) return;

    // Kurumsal Tema Renkleri
    const bgColor = '#131722';
    const textColor = '#D1D4DC';
    const gridColor = '#2A2E39';
    const upColor = '#089981';
    const downColor = '#F23645';

    const mainChart = createChart(mainContainerRef.current, {
      layout: { background: { color: bgColor }, textColor: textColor, fontFamily: 'Inter, sans-serif' },
      grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
      rightPriceScale: { borderColor: gridColor, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: gridColor, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: 0, vertLine: { color: '#787B86', labelBackgroundColor: '#2962FF' }, horzLine: { color: '#787B86', labelBackgroundColor: '#2962FF' } },
    });
    mainChartRef.current = mainChart;

    candleSeriesRef.current = mainChart.addCandlestickSeries({
      upColor: upColor, downColor: downColor,
      wickUpColor: upColor, wickDownColor: downColor, borderVisible: false,
    });

    const rsiChart = createChart(rsiContainerRef.current, {
      layout: { background: { color: bgColor }, textColor: textColor, fontFamily: 'Inter, sans-serif' },
      grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
      rightPriceScale: { borderColor: gridColor },
      timeScale: { borderColor: gridColor, fixLeftEdge: false, fixRightEdge: false },
      crosshair: { mode: 0, vertLine: { color: '#787B86', labelBackgroundColor: '#2962FF' }, horzLine: { color: '#787B86', labelBackgroundColor: '#2962FF' } },
    });
    rsiChartRef.current = rsiChart;

    const rsiSeries = rsiChart.addLineSeries({ color: '#9C27B0', lineWidth: 2 });
    rsiSeriesRef.current = rsiSeries;

    rsiSeries.createPriceLine({ price: 30, color: '#787B86', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: '30' });
    rsiSeries.createPriceLine({ price: 70, color: '#787B86', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: '70' });

    const resizeObserver = new ResizeObserver(() => {
      const mainRect = mainContainerRef.current?.getBoundingClientRect();
      const rsiRect = rsiContainerRef.current?.getBoundingClientRect();
      if (mainRect && mainChartRef.current) mainChartRef.current.resize(mainRect.width, mainRect.height);
      if (rsiRect && rsiChartRef.current) rsiChartRef.current.resize(rsiRect.width, rsiRect.height);
    });
    resizeObserver.observe(mainContainerRef.current);
    resizeObserver.observe(rsiContainerRef.current);

    const isSyncingFromMainRef = { current: false };
    const isSyncingFromRsiRef = { current: false };

    mainChart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (!range || !rsiChartRef.current || isSyncingFromRsiRef.current) return;
      try { 
        isSyncingFromMainRef.current = true; 
        rsiChartRef.current.timeScale().setVisibleRange(range); 
      } catch (e) {} finally { 
        isSyncingFromMainRef.current = false; 
      }
    });

    rsiChart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (!range || !mainChartRef.current || isSyncingFromMainRef.current) return;
      try { 
        isSyncingFromRsiRef.current = true; 
        mainChartRef.current.timeScale().setVisibleRange(range); 
      } catch (e) {} finally { 
        isSyncingFromRsiRef.current = false; 
      }
    });

    mainChart.subscribeCrosshairMove((param) => {
      if (!param.time || !rsiChartRef.current || !rsiSeriesRef.current) return;
      const t = param.time as Time;
      const rsiPrice = rsiValueByTimeRef.current.get(t as number) ?? 50;
      try { rsiChartRef.current.setCrosshairPosition(rsiPrice, t, rsiSeriesRef.current); } catch (e) {}
    });

    rsiChart.subscribeCrosshairMove((param) => {
      if (!param.time || !mainChartRef.current || !candleSeriesRef.current) return;
      const t = param.time as Time;
      const candlePrice = closeValueByTimeRef.current.get(t as number) ?? 0;
      try { mainChartRef.current.setCrosshairPosition(candlePrice, t, candleSeriesRef.current); } catch (e) {}
    });

    return () => {
      resizeObserver.disconnect();
      mainChart.remove(); rsiChart.remove();
      mainChartRef.current = null; rsiChartRef.current = null;
      candleSeriesRef.current = null;
      shortMASeriesRef.current = null;
      longMASeriesRef.current = null;
      rsiSeriesRef.current = null;
      supportSeriesRef.current = null;
      resistanceSeriesRef.current = null;
      zigzagSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || candles.length === 0) return;
    const data: CandlestickData[] = candles.map((c) => ({
      time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    candleSeriesRef.current.setData(data);
    candleSeriesRef.current.setMarkers(markers && markers.length ? markers : []);
    mainChartRef.current?.timeScale().fitContent();
  }, [candles, markers]);

  useEffect(() => {
    if (!mainChartRef.current) return;
    if (shortMA && shortMA.length > 0) {
      if (!shortMASeriesRef.current) shortMASeriesRef.current = mainChartRef.current.addLineSeries({ color: '#2962FF', lineWidth: 2 }); // Kurumsal Mavi
      shortMASeriesRef.current.setData(shortMA.map((p) => ({ time: p.time as Time, value: p.value })));
    } else if (shortMASeriesRef.current) {
      mainChartRef.current.removeSeries(shortMASeriesRef.current);
      shortMASeriesRef.current = null;
    }
  }, [shortMA]);

  useEffect(() => {
    if (!mainChartRef.current) return;
    if (longMA && longMA.length > 0) {
      if (!longMASeriesRef.current) longMASeriesRef.current = mainChartRef.current.addLineSeries({ color: '#FF9800', lineWidth: 2 }); // Kurumsal Turuncu
      longMASeriesRef.current.setData(longMA.map((p) => ({ time: p.time as Time, value: p.value })));
    } else if (longMASeriesRef.current) {
      mainChartRef.current.removeSeries(longMASeriesRef.current);
      longMASeriesRef.current = null;
    }
  }, [longMA]);

  useEffect(() => {
    if (!rsiSeriesRef.current || !rsiChartRef.current) return;
    if (rsiData && rsiData.length > 0) {
      rsiSeriesRef.current.setData(rsiData.map((p) => ({ time: p.time as Time, value: p.value })));
    } else {
      rsiSeriesRef.current.setData([]);
    }
  }, [rsiData]);

  useEffect(() => {
    const chart = mainChartRef.current;
    if (!chart) return;
    try {
      if (supportSeriesRef.current) chart.removeSeries(supportSeriesRef.current);
      if (resistanceSeriesRef.current) chart.removeSeries(resistanceSeriesRef.current);
      if (zigzagSeriesRef.current) chart.removeSeries(zigzagSeriesRef.current);
    } catch (e) {} finally {
      supportSeriesRef.current = null; resistanceSeriesRef.current = null; zigzagSeriesRef.current = null;
    }

    if (selectedPattern === 'none' || candles.length === 0 || !candleSeriesRef.current) return;

    const firstTime = candles[0].time as Time;
    const lastTime = candles[candles.length - 1].time as Time;

    if (selectedPattern === 'support_resistance') {
      let resistance = -Infinity, support = Infinity;
      for (const c of candles) { if (c.high > resistance) resistance = c.high; if (c.low < support) support = c.low; }
      resistanceSeriesRef.current = chart.addLineSeries({ color: '#F23645', lineWidth: 1, lineStyle: LineStyle.Dashed });
      resistanceSeriesRef.current.setData([{ time: firstTime, value: resistance }, { time: lastTime, value: resistance }]);
      supportSeriesRef.current = chart.addLineSeries({ color: '#089981', lineWidth: 1, lineStyle: LineStyle.Dashed });
      supportSeriesRef.current.setData([{ time: firstTime, value: support }, { time: lastTime, value: support }]);
    }

    if (selectedPattern === 'zigzag') {
      const deviation = zigzagDeviationPercent / 100;
      const zigzagPoints = calculateZigZagPoints(candles, deviation);
      if (zigzagPoints.length >= 2) {
        zigzagSeriesRef.current = chart.addLineSeries({ 
          color: 'rgba(209, 212, 220, 0.4)', // Profesyonel mat gri/beyaz
          lineWidth: 2, 
          lineStyle: LineStyle.Solid 
        });
        zigzagSeriesRef.current.setData(zigzagPoints.map((p) => ({ time: p.time as Time, value: p.value })));
      }
    }
  }, [selectedPattern, candles, zigzagDeviationPercent]);

  return (
    <div className="flex h-full flex-col gap-[1px] bg-[#2A2E39]">
      <div className="flex w-full shrink-0 justify-end gap-1 p-2 bg-[#131722]">
        <button 
          onClick={handleZoomIn} 
          className="flex h-7 w-7 items-center justify-center rounded bg-[#1E222D] border border-[#2A2E39] text-[#787B86] hover:bg-[#2A2E39] hover:text-[#D1D4DC] transition-all" 
          title="Yakınlaştır"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
        </button>
        <button 
          onClick={handleZoomOut} 
          className="flex h-7 w-7 items-center justify-center rounded bg-[#1E222D] border border-[#2A2E39] text-[#787B86] hover:bg-[#2A2E39] hover:text-[#D1D4DC] transition-all" 
          title="Uzaklaştır"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
        </button>
        <button 
          onClick={handleResetZoom} 
          className="flex h-7 w-7 items-center justify-center rounded bg-[#1E222D] border border-[#2A2E39] text-[#787B86] hover:bg-[#2A2E39] hover:text-[#D1D4DC] transition-all" 
          title="Görünümü Sıfırla"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="5 9 2 6 5 3"></polyline><line x1="2" y1="6" x2="22" y2="6"></line><polyline points="19 15 22 18 19 21"></polyline><line x1="2" y1="18" x2="22" y2="18"></line></svg>
        </button>
      </div>

      <div ref={mainContainerRef} style={{ flex: 7 }} className="w-full relative z-0" />
      <div ref={rsiContainerRef} style={{ flex: 3 }} className="w-full relative z-0" />
    </div>
  );
}

// --- ANA SAYFA ---
export default function HomePage() {
  const [symbol, setSymbol] = useState<SymbolType>('BTCUSDT');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  
  const [indicator, setIndicator] = useState<IndicatorType>('sma');
  const [selectedPattern, setSelectedPattern] = useState<ChartPattern>('none');
  const [zigzagDeviationPercent, setZigzagDeviationPercent] = useState<number>(5);
  const [shortPeriod, setShortPeriod] = useState<number>(50);
  const [longPeriod, setLongPeriod] = useState<number>(200);
  
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [targetAlert, setTargetAlert] = useState<string>('');
  const [activeAlerts, setActiveAlerts] = useState<number[]>([]);
  const activeAlertsRef = useRef<number[]>([]);
  const lastPriceRef = useRef<number | null>(null);
  
  const [backtestResult, setBacktestResult] = useState<{ pnl: number; trades: number } | null>(null);

  useEffect(() => {
    activeAlertsRef.current = activeAlerts;
  }, [activeAlerts]);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true); setError(null);
      try {
        const url = new URL('https://api.binance.com/api/v3/klines');
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('interval', '1d');
        url.searchParams.set('limit', '1000'); 

        const res = await fetch(url.toString());
        if (!res.ok) throw new Error('API Hatası');
        const data = await res.json();
        
        const fetchedCandles: Candle[] = data.map((kline: any) => ({
          time: Math.floor(Number(kline[0]) / 1000),
          open: Number(kline[1]), high: Number(kline[2]),
          low: Number(kline[3]), close: Number(kline[4]),
        })).filter((c: Candle) => Number.isFinite(c.time));

        setCandles(fetchedCandles);
        setBacktestResult(null); 
      } catch (err) {
        setError('Veri çekilemedi.');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [symbol]);

  useEffect(() => {
    if (!symbol) return;
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_1d`);
    
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const k = message.k;
      const currentPrice = Number(k.c);

      const newCandle: Candle = {
        time: Math.floor(k.t / 1000),
        open: Number(k.o), high: Number(k.h),
        low: Number(k.l), close: currentPrice,
      };
      setLiveCandle(newCandle);

      if (lastPriceRef.current !== null) {
        const lastPrice = lastPriceRef.current;
        const alertsToTrigger: number[] = [];

        activeAlertsRef.current.forEach(alertPrice => {
          const crossedUp = lastPrice < alertPrice && currentPrice >= alertPrice;
          const crossedDown = lastPrice > alertPrice && currentPrice <= alertPrice;

          if (crossedUp || crossedDown) {
            alertsToTrigger.push(alertPrice);
          }
        });

        if (alertsToTrigger.length > 0) {
          activeAlertsRef.current = activeAlertsRef.current.filter(p => !alertsToTrigger.includes(p));
          setActiveAlerts(prev => prev.filter(p => !alertsToTrigger.includes(p)));
          alertsToTrigger.forEach(price => {
            setTimeout(() => alert(`🔔 ALARM: ${symbol} hedef fiyatı vurdu! (${price}$)`), 50);
          });
        }
      }

      lastPriceRef.current = currentPrice;
    };

    return () => ws.close();
  }, [symbol]);

  const displayCandles = useMemo(() => {
    if (candles.length === 0) return [];
    if (!liveCandle) return candles;
    const lastHistorical = candles[candles.length - 1];
    
    if (liveCandle.time === lastHistorical.time) {
      return [...candles.slice(0, -1), liveCandle];
    }
    if (liveCandle.time > lastHistorical.time) {
      return [...candles, liveCandle];
    }
    return candles;
  }, [candles, liveCandle]);

  const rsiData = useMemo(() => calculateRSI(displayCandles, 14), [displayCandles]);
  const { shortMA, longMA } = useMemo(() => {
    if (indicator === 'none') return { shortMA: null, longMA: null };
    if (indicator === 'sma') return { shortMA: calculateSMA(displayCandles, shortPeriod), longMA: calculateSMA(displayCandles, longPeriod) };
    return { shortMA: calculateEMA(displayCandles, shortPeriod), longMA: calculateEMA(displayCandles, longPeriod) };
  }, [displayCandles, indicator, shortPeriod, longPeriod]);

  const signals = useMemo(() => detectCrossSignals(shortMA ?? [], longMA ?? [], displayCandles), [shortMA, longMA, displayCandles]);

  const markers: SeriesMarker<Time>[] = useMemo(() => {
    return signals.map((s) => ({
      time: s.time as Time,
      position: s.signal === 'golden' ? 'belowBar' : 'aboveBar',
      color: s.signal === 'golden' ? '#2962FF' : '#F23645',
      shape: s.signal === 'golden' ? 'arrowUp' : 'arrowDown',
      text: s.signal === 'golden' ? 'AL' : 'SAT',
    }));
  }, [signals]);

  const runBacktest = () => {
    if (signals.length === 0) {
      alert("Test için yeterli kesişim sinyali (AL/SAT) yok. Periyotları küçültmeyi deneyin.");
      return;
    }
    let balance = 1000;
    let cryptoAmt = 0;
    let trades = 0;

    signals.forEach((sig) => {
      if (sig.signal === 'golden' && balance > 0) {
        cryptoAmt = balance / sig.price;
        balance = 0;
        trades++;
      } else if (sig.signal === 'death' && cryptoAmt > 0) {
        balance = cryptoAmt * sig.price;
        cryptoAmt = 0;
        trades++;
      }
    });

    if (cryptoAmt > 0) {
      balance = cryptoAmt * displayCandles[displayCandles.length - 1].close;
    }

    setBacktestResult({ pnl: balance - 1000, trades });
  };

  const aiCommentary = useMemo(() => {
    if (displayCandles.length === 0 || !rsiData.length) return "Piyasa analizi için veri bekleniyor...";
    const currentPrice = displayCandles[displayCandles.length - 1].close;
    const currentRsi = rsiData[rsiData.length - 1].value;
    
    let comment = `🤖 ${symbol} şu an ${currentPrice.toLocaleString(undefined, {minimumFractionDigits: 2})}$ seviyesinde işlem görüyor. `;
    
    if (currentRsi > 70) comment += `RSI değeri (${currentRsi.toFixed(1)}) aşırı alım bölgesinde, bu bir olası kâr satışı (düzeltme) habercisi olabilir. `;
    else if (currentRsi < 30) comment += `RSI değeri (${currentRsi.toFixed(1)}) aşırı satış bölgesinde, diplerden bir tepki yükselişi gelme ihtimali yüksek. `;
    else comment += `RSI değeri (${currentRsi.toFixed(1)}) nötr bölgede, yatay veya dengeli bir seyir hakim. `;

    if (shortMA && longMA && shortMA.length > 0 && longMA.length > 0) {
      const lastShort = shortMA[shortMA.length - 1].value;
      const lastLong = longMA[longMA.length - 1].value;
      if (lastShort > lastLong) comment += `Kısa vadeli ortalama, uzun vadenin üzerinde. Ana trend YÜKSELİŞ yönünde. `;
      else comment += `Kısa vadeli ortalama, uzun vadenin altında. Ana trend DÜŞÜŞ yönünde, risklerinizi yönetin. `;
    }

    return comment;
  }, [displayCandles, rsiData, shortMA, longMA, symbol]);

  return (
    <main className="flex min-h-screen flex-col bg-[#0B0E14] font-sans text-[#D1D4DC]">
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6">
        
        {/* ÜST BAR */}
        <div className="mb-4 flex flex-col md:flex-row items-center justify-between rounded-lg border border-[#2A2E39] bg-[#131722] px-5 py-4 shadow-sm">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-semibold tracking-tight text-white">CRYPTOLYX</h1>
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value as SymbolType)}
              className="rounded bg-[#1E222D] border border-[#2A2E39] px-3 py-1.5 text-sm text-[#D1D4DC] outline-none focus:border-[#2962FF] transition-colors cursor-pointer"
            >
              <option value="BTCUSDT">Bitcoin (BTC)</option>
              <option value="ETHUSDT">Ethereum (ETH)</option>
              <option value="SOLUSDT">Solana (SOL)</option>
              <option value="BNBUSDT">Binance Coin (BNB)</option>
              <option value="AVAXUSDT">Avalanche (AVAX)</option>
            </select>
          </div>
          <div className="flex items-center gap-3 mt-4 md:mt-0 font-mono">
            <span className="text-sm text-[#787B86]">Son Fiyat:</span>
            <span className={`text-xl font-medium tracking-tight ${liveCandle && displayCandles.length > 1 && liveCandle.close > displayCandles[displayCandles.length - 2].close ? 'text-[#089981]' : 'text-[#F23645]'}`}>
              {liveCandle ? `$${liveCandle.close.toLocaleString(undefined, {minimumFractionDigits: 2})}` : '...'}
            </span>
          </div>
        </div>

        {/* KONTROL PANELİ */}
        <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col gap-4 rounded-lg border border-[#2A2E39] bg-[#131722] px-5 py-4 shadow-sm">
             <div className="flex items-center justify-between">
                <label className="text-sm text-[#787B86] font-medium">Hareketli Ortalama (MA):</label>
                <select value={indicator} onChange={(e) => setIndicator(e.target.value as IndicatorType)} className="rounded bg-[#1E222D] border border-[#2A2E39] px-3 py-1.5 text-sm text-[#D1D4DC] outline-none focus:border-[#2962FF] cursor-pointer">
                  <option value="none">Kapalı</option><option value="sma">Basit (SMA)</option><option value="ema">Üstel (EMA)</option>
                </select>
             </div>
             <div className="flex justify-between gap-4 border-t border-[#2A2E39] pt-4">
               <div className="flex items-center gap-3">
                 <label className="text-sm text-[#787B86]">Kısa Periyot:</label>
                 <select value={shortPeriod} onChange={(e) => setShortPeriod(Number(e.target.value))} className="rounded bg-[#1E222D] border border-[#2A2E39] px-3 py-1.5 text-sm font-mono cursor-pointer focus:border-[#2962FF] outline-none">
                    {[5, 10, 14, 20, 50].map((v) => <option key={v} value={v}>{v}</option>)}
                 </select>
               </div>
               <div className="flex items-center gap-3">
                 <label className="text-sm text-[#787B86]">Uzun Periyot:</label>
                 <select value={longPeriod} onChange={(e) => setLongPeriod(Number(e.target.value))} className="rounded bg-[#1E222D] border border-[#2A2E39] px-3 py-1.5 text-sm font-mono cursor-pointer focus:border-[#2962FF] outline-none">
                    {[50, 100, 200, 365].map((v) => <option key={v} value={v}>{v}</option>)}
                 </select>
               </div>
             </div>
          </div>

          <div className="flex flex-col gap-4 rounded-lg border border-[#2A2E39] bg-[#131722] px-5 py-4 shadow-sm">
            <div className="text-sm text-[#787B86] font-medium">Grafik Araçları:</div>
            <div className="inline-flex w-full overflow-hidden rounded border border-[#2A2E39] bg-[#1E222D]">
              {(Object.entries({ none: 'Temiz', support_resistance: 'Destek/Direnç', zigzag: 'ZigZag' })).map(([val, lbl]) => (
                  <button key={val} onClick={() => setSelectedPattern(val as ChartPattern)} className={`flex-1 px-3 py-2 text-sm transition-colors font-medium border-r border-[#2A2E39] last:border-r-0 ${selectedPattern === val ? 'bg-[#2962FF] text-white' : 'text-[#D1D4DC] hover:bg-[#2A2E39]'}`}>
                    {lbl}
                  </button>
              ))}
            </div>
            {selectedPattern === 'zigzag' && (
              <div className="flex items-center justify-between border-t border-[#2A2E39] pt-4 mt-auto">
                <label className="text-sm text-[#787B86]">Sapma (Deviation):</label>
                <select value={zigzagDeviationPercent} onChange={(e) => setZigzagDeviationPercent(Number(e.target.value))} className="rounded bg-[#1E222D] border border-[#2A2E39] px-3 py-1.5 text-sm font-mono cursor-pointer focus:border-[#2962FF] outline-none">
                  {Array.from({ length: 15 }, (_, i) => i + 1).map((p) => <option key={p} value={p}>%{p}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* GRAFİK EKRANI */}
        <div className="flex-1 rounded-lg border border-[#2A2E39] bg-[#131722] p-1 shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex h-[60vh] flex-col items-center justify-center gap-4">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#2962FF] border-t-transparent" />
              <span className="text-sm text-[#787B86] font-medium">Piyasa verileri yükleniyor...</span>
            </div>
          ) : error ? (
            <div className="flex h-[60vh] items-center justify-center text-[#F23645]">{error}</div>
          ) : displayCandles.length === 0 ? (
            <div className="flex h-[60vh] items-center justify-center text-[#787B86]">Veri bulunamadı.</div>
          ) : (
            <div className="h-[60vh] flex flex-col">
               <CandlestickChart 
                 candles={displayCandles} 
                 shortMA={shortMA ?? undefined} 
                 longMA={longMA ?? undefined} 
                 rsiData={rsiData ?? undefined} 
                 markers={markers} 
                 selectedPattern={selectedPattern} 
                 zigzagDeviationPercent={zigzagDeviationPercent} 
               />
            </div>
          )}
        </div>

        {/* ALT PANELLER */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          
          <div className="rounded-lg border border-[#2A2E39] bg-[#131722] px-5 py-5 shadow-sm border-l-4 border-l-[#2962FF]">
             <h3 className="text-sm font-semibold text-white mb-3">AI Algoritma Özeti</h3>
             <p className="text-sm text-[#D1D4DC] leading-relaxed">{aiCommentary}</p>
          </div>

          <div className="rounded-lg border border-[#2A2E39] bg-[#131722] px-5 py-5 shadow-sm flex flex-col justify-between border-l-4 border-l-[#089981]">
             <div>
               <h3 className="text-sm font-semibold text-white mb-2">Backtest Modülü</h3>
               <p className="text-xs text-[#787B86] mb-4">1000$ başlangıç bakiyesi ile son 1000 günlük MA Kesişim performansını analiz edin.</p>
             </div>
             {backtestResult ? (
               <div className="bg-[#1E222D] p-3 rounded border border-[#2A2E39] flex items-center justify-between">
                 <div>
                   <div className="text-xs text-[#787B86] mb-1">Net Kâr / Zarar</div>
                   <div className={`text-lg font-mono font-bold ${backtestResult.pnl >= 0 ? 'text-[#089981]' : 'text-[#F23645]'}`}>
                     {backtestResult.pnl >= 0 ? '+' : ''}{backtestResult.pnl.toFixed(2)}$
                   </div>
                 </div>
                 <div className="text-right">
                   <div className="text-xs text-[#787B86] mb-1">İşlem Sayısı</div>
                   <div className="text-lg font-mono font-medium text-white">{backtestResult.trades}</div>
                 </div>
               </div>
             ) : (
               <button onClick={runBacktest} className="w-full rounded bg-[#2962FF] text-white font-medium py-2.5 text-sm hover:bg-[#1E4BD8] transition">Simülasyonu Başlat</button>
             )}
          </div>

          <div className="rounded-lg border border-[#2A2E39] bg-[#131722] px-5 py-5 shadow-sm border-l-4 border-l-[#FF9800]">
             <h3 className="text-sm font-semibold text-white mb-2">Fiyat İzleyici (Alarm)</h3>
             <p className="text-xs text-[#787B86] mb-4">Hedef fiyata ulaşıldığında anlık tarayıcı uyarısı alın.</p>
             <div className="flex gap-2 mb-4">
               <input type="number" placeholder="Fiyat girin" value={targetAlert} onChange={(e)=>setTargetAlert(e.target.value)} className="w-full rounded border border-[#2A2E39] bg-[#1E222D] px-3 py-2 text-sm outline-none focus:border-[#FF9800] font-mono text-[#D1D4DC] placeholder:text-[#787B86]" />
               <button onClick={() => { if(targetAlert && !activeAlerts.includes(Number(targetAlert))) { setActiveAlerts([...activeAlerts, Number(targetAlert)]); setTargetAlert(''); } }} className="rounded bg-[#1E222D] border border-[#2A2E39] px-4 text-sm font-medium text-white hover:bg-[#2A2E39] transition">Ekle</button>
             </div>
             <div className="flex flex-wrap gap-2">
               {activeAlerts.map(alert => (
                 <span key={alert} className="inline-flex items-center gap-1.5 bg-[#1E222D] px-2.5 py-1 rounded text-xs font-mono text-[#D1D4DC] border border-[#2A2E39]">
                   {alert}$ <button onClick={()=>setActiveAlerts(activeAlerts.filter(a => a !== alert))} className="text-[#787B86] hover:text-[#F23645]">×</button>
                 </span>
               ))}
             </div>
          </div>

        </div>

      </div>
    </main>
  );
}