import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { Camera, Crosshair, Pause, Play, StepForward, Trash2, X } from 'lucide-react'
import { api } from '../../lib/api'
import { onFrame } from '../../lib/ws'
import { useStore } from '../../state/store'
import {
  atr,
  bollinger,
  ema,
  heikinAshi,
  macd,
  rsi,
  sma,
  stochastic,
  vwap,
} from '../../lib/indicators'
import type { Bar } from '../../lib/types'
import type {
  ChartType,
  DrawView,
  Oscillator,
  OverlayKey,
  Tool,
} from './types'
import { DrawingLayer } from './DrawingLayer'

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'] as const
type Interval = (typeof INTERVALS)[number]
const SCALES = ['norm', 'log', '%'] as const
type ScaleMode = (typeof SCALES)[number]
const OSCILLATORS: Oscillator[] = ['none', 'rsi', 'macd', 'atr', 'stoch']
const OVERLAYS: OverlayKey[] = ['ema20', 'ema50', 'sma200', 'vwap', 'bb']
const REPLAY_MS: Record<string, number> = { '1x': 800, '2x': 400, '4x': 200 }

function cssVar(name: string): string {
  // Callers append alpha as raw hex (`${cssVar('--up')}55`), which ONLY works
  // because every color var in index.css is a 6-digit #rrggbb. Swap the theme
  // to oklch()/hsl() and every series color silently becomes garbage.
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}

interface Props {
  standalone?: boolean
  initialSymbol?: string
  compact?: boolean
  slotIndex?: number
}

export function ChartPanel({ standalone = false, initialSymbol = '', compact = false, slotIndex }: Props) {
  const globalSelected = useStore((s) => s.selected)
  const [localSymbol, setLocalSymbol] = useState(initialSymbol)
  const symbolInputRef = useRef<HTMLInputElement>(null)
  const rawSymbol = standalone ? localSymbol : (globalSelected ?? '')
  const key = rawSymbol

  const [interval, setInterval_] = useState<Interval>('1m')
  const [chartType, setChartType] = useState<ChartType>('candles')
  // Log/% scale modes are computed below but never toggled in the UI yet —
  // the setter stayed dead and tsc rightly killed it. Keep the value honest.
  const [scaleMode] = useState<ScaleMode>('norm')
  const [overlays, setOverlays] = useState<Set<OverlayKey>>(new Set(['ema20']))
  const [osc, setOsc] = useState<Oscillator>('none')
  const [bars, setBars] = useState<Bar[]>([])
  const [tool, setTool] = useState<Tool>(null)
  const [drawings, setDrawings] = useState<DrawView[]>([])
  const [pending, setPending] = useState<DrawView | null>(null)
  const [redrawSignal, setRedrawSignal] = useState(0)

  const [replayOn, setReplayOn] = useState(false)
  const [replayBack] = useState(120)
  const [replayPos, setReplayPos] = useState(0)
  const [replaySpeed, setReplaySpeed] = useState<'1x' | '2x' | '4x'>('2x')
  const [playing, setPlaying] = useState(false)

  const [selectedOverlay, setSelectedOverlay] = useState<OverlayKey | null>(null)
  const [selectedOsc, setSelectedOsc] = useState<Oscillator | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const mainRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const lineRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  const oscRefs = useRef<Map<string, ISeriesApi<'Line' | 'Histogram'>>>(new Map())
  const barsRef = useRef<Bar[]>([])
  barsRef.current = bars

  useEffect(() => {
    if (!key) return
    let alive = true
    const load = async () => {
      try {
        const rows = await api.bars(key, interval, 300)
        if (alive) setBars(rows)
      } catch {
        /* keep last */
      }
    }
    void load()
    if (!replayOn) {
      // The 5s poll is a belt for the WS suspenders: missed frames, backend
      // restarts and dropped subscriptions all heal within one cycle. Full
      // replace is safe because setData is idempotent and flush is debounced.
      const id = window.setInterval(load, 5000)
      return () => {
        alive = false
        window.clearInterval(id)
      }
    }
    return () => {
      alive = false
    }
  }, [key, interval, replayOn])

  useEffect(() => {
    // NOTE: this effect and the near-identical drawings-refetch effect below
    // BOTH key on [key] and both GET api.drawings(key). On a normal symbol
    // change that's two identical fetches (the second is the replayOn guard).
    // Redundant, not incorrect — flagging so nobody "fixes" only one of them
    // and breaks the replay case.
    setDrawings([])
    setPending(null)
    if (!key) return
    let alive = true
    api
      .drawings(key)
      .then((rows) => {
        if (!alive) return
        setDrawings(
          rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            p1: (r.payload.p1 ?? { ts: 0, price: 0 }) as DrawView['p1'],
            p2: r.payload.p2 as DrawView['p2'] | undefined,
            payload: r.payload.payload as DrawView["payload"],
          })),
        )
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [key])

  useEffect(() => {
    if (!key || replayOn) return
    let alive = true
    api
      .drawings(key)
      .then((rows) => {
        if (!alive) return
        setDrawings(
          rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            p1: (r.payload.p1 ?? { ts: 0, price: 0 }) as DrawView['p1'],
            p2: r.payload.p2 as DrawView['p2'] | undefined,
            payload: r.payload.payload as DrawView["payload"],
          })),
        )
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [key])

  useEffect(() => {
    if (!key || replayOn) return
    // onFrame returns its own unsubscribe (handled in the cleanup below);
    // a hand-rolled `alive` flag used to sit here unread — belt insurance
    // nobody ever fastened.
    const unsub = onFrame((f) => {
      if (f.t !== 'e' || !f.topic) return
      if (f.topic !== `bar:${key}:${interval}`) return
      const d = f.data as unknown as Bar
      setBars((prev) => {
        if (!prev.length) return prev
        const last = prev[prev.length - 1]
        if (d.ts === last.ts) {
          // Same ts = live update of the forming bar (replace, never push).
          const copy = prev.slice()
          copy[copy.length - 1] = d
          return copy
        }
        // slice(-400): a hard window cap. 300 bars load + unbounded push
        // would turn a day of 1m ticks into a setData of thousands of bars
        // per burst — indicators recompute over the whole array each flush.
        if (d.ts > last.ts) return [...prev.slice(-400), d]
        return prev
      })
    })
    return () => {
      unsub()
    }
  }, [key, interval, replayOn])

  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(
      () =>
        setReplayPos((p) => {
          const maxIdx = Math.min(replayBack, barsRef.current.length - 1)
          if (p >= maxIdx - 1) return p
          return p + 1
        }),
      REPLAY_MS[replaySpeed],
    )
    return () => window.clearInterval(id)
  }, [playing, replaySpeed, replayBack])

  const displayBars = useMemo<Bar[]>(() => {
    if (!replayOn) return bars
    const start = Math.max(0, bars.length - replayBack)
    return bars.slice(0, Math.min(bars.length, start + replayPos + 1))
  }, [bars, replayOn, replayBack, replayPos])

  const displayBarsRef = useRef(displayBars)
  displayBarsRef.current = displayBars

  // Full recompute of every visible series. setData() replaces the entire
  // dataset instead of per-bar update() because a tick re-derives ALL
  // indicator arrays anyway — there is no incremental path worth keeping.
  // Caller is debounced (flushRef below); series composition itself is NOT
  // updated here — overlays/oscillators rebuild the whole chart (see the
  // createChart effect).
  const buildAllData = useCallback(
    (data: Bar[]) => {
      const chart = chartRef.current
      const main = mainRef.current
      if (!chart || !main || !data.length) return

      const src = chartType === 'ha' ? heikinAshi(data) : data
      const times = src.map((b) => b.ts as UTCTimestamp)

      if (chartType === 'candles' || chartType === 'ha') {
        ;(main as ISeriesApi<'Candlestick'>).setData(
          src.map((b, i) => ({
            time: times[i],
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
          })),
        )
      } else if (chartType === 'line') {
        ;(main as ISeriesApi<'Line'>).setData(
          src.map((b, i) => ({ time: times[i], value: b.c })),
        )
      } else {
        ;(main as ISeriesApi<'Area'>).setData(
          src.map((b, i) => ({ time: times[i], value: b.c })),
        )
      }

      if (volRef.current) {
        volRef.current.setData(
          data.map((b, i) => ({
            time: times[i],
            value: b.v,
            color: b.c >= b.o ? `${cssVar('--up')}55` : `${cssVar('--down')}55`,
          })),
        )
      }

      const closes = data.map((b) => b.c)
      const overlayLines: Array<[OverlayKey, ReturnType<typeof ema>]> = [
        ['ema20', ema(closes, 20)],
        ['ema50', ema(closes, 50)],
        ['sma200', sma(closes, 200)],
      ]
      for (const [name, vals] of overlayLines) {
        const s = lineRefs.current.get(name)
        if (!s) continue
        s.setData(
          vals
            .map((v, i) => ({ time: times[i], value: v }))
            .filter((p) => p.value !== null) as { time: UTCTimestamp; value: number }[],
        )
      }
      const vw = lineRefs.current.get('vwap')
      if (vw) {
        const vals = vwap(data)
        vw.setData(
          vals
            .map((v, i) => ({ time: times[i], value: v }))
            .filter((p) => p.value !== null) as { time: UTCTimestamp; value: number }[],
        )
      }
      const bb = overlays.has('bb') ? bollinger(closes) : null
      ;(['bbU', 'bbM', 'bbL'] as const).forEach((name, idx) => {
        const s = lineRefs.current.get(name)
        if (!s) return
        const vals = bb ? [bb.upper, bb.mid, bb.lower][idx] : []
        s.setData(
          (vals ?? [])
            .map((v, i) => ({ time: times[i], value: v }))
            .filter((p) => p.value !== null) as { time: UTCTimestamp; value: number }[],
        )
      })

      for (const [, s] of oscRefs.current) s.setData([])
      const oscKey = osc
      if (oscKey === 'rsi') {
        const vals = rsi(closes)
        oscRefs.current.get('rsi')?.setData(
          vals
            .map((v, i) => ({ time: times[i], value: v }))
            .filter((p) => p.value !== null) as { time: UTCTimestamp; value: number }[],
        )
      } else if (oscKey === 'macd') {
        const m = macd(closes)
        const hist = oscRefs.current.get('macdHist') as
          | ISeriesApi<'Histogram'>
          | undefined
        hist?.setData(
          m.hist
            .map((v, i) => ({
              time: times[i],
              value: v,
              color:
                v === null || v >= 0 ? `${cssVar('--up')}88` : `${cssVar('--down')}88`,
            }))
            .filter((p) => p.value !== null),
        )
        for (const [name, arr] of [
          ['macd', m.line],
          ['macdSig', m.signal],
        ] as const) {
          const s = oscRefs.current.get(name)
          s?.setData(
            arr
              .map((v, i) => ({ time: times[i], value: v }))
              .filter((p) => p.value !== null) as { time: UTCTimestamp; value: number }[],
          )
        }
      } else if (oscKey === 'atr') {
        const vals = atr(data)
        oscRefs.current.get('atr')?.setData(
          vals
            .map((v, i) => ({ time: times[i], value: v }))
            .filter((p) => p.value !== null) as { time: UTCTimestamp; value: number }[],
        )
      } else if (oscKey === 'stoch') {
        const st = stochastic(data)
        for (const [name, arr] of [
          ['stochK', st.k],
          ['stochD', st.d],
        ] as const) {
          const s = oscRefs.current.get(name)
          s?.setData(
            arr
              .map((v, i) => ({ time: times[i], value: v }))
              .filter((p) => p.value !== null) as { time: UTCTimestamp; value: number }[],
          )
        }
      }

    },
    [chartType, overlays, osc],
  )

  const flushRef = useRef<number | undefined>(undefined)
  // Coalescer, not politeness: a burst of ticks (or the 5s poll landing
  // mid-stream) would otherwise trigger one full setData of 400 bars × every
  // indicator per frame. 60 ms ≈ 16 repaints merged into one.
  // Deliberately NOT cleared on unmount — the stale timeout fires into
  // buildAllData, which no-ops because the series refs are null by then.
  useEffect(() => {
    window.clearTimeout(flushRef.current)
    flushRef.current = window.setTimeout(() => buildAllData(displayBars), 60)
  }, [displayBars, buildAllData])

  useEffect(() => {
    // ── The v5 rebuild-everything effect. Read before touching ──
    // lightweight-charts v5 series are typed-on-birth: a CandlestickSeries
    // can never become a LineSeries, and pane occupancy (vol=pane 1,
    // oscillator=pane 2) is fixed by the paneIndex argument. Since chartType/
    // overlays/osc are all in the deps below, ANY toggle tears the chart down
    // and re-adds every series from scratch. That is heavy-handed ON PURPOSE:
    // chart.remove() is the one disposal that provably takes all series
    // handles, canvases and internal listeners with it. The alternative —
    // keeping the chart alive and calling removeSeries per handle — is the
    // version where forgetting a single handle leaks it onto a dead chart and
    // the lineRefs/oscRefs Maps start handing corpses to buildAllData. The
    // Maps are cleared in cleanup for exactly that reason; do not "optimize"
    // the rebuild into selective add/removeSeries without owning every
    // handle leak.
    // Cleanup ordering also matters: unsubscribe BEFORE chart.remove(), so a
    // throw can't skip remove() and leak the canvas + all its series.
    const el = containerRef.current
    if (!el || !key) return

    const up = cssVar('--up')
    const down = cssVar('--down')
    const amber = cssVar('--amber')

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: cssVar('--bg') },
        textColor: cssVar('--dim'),
        fontSize: 10,
        panes: { separatorColor: cssVar('--border'), separatorHoverColor: amber },
      },
      grid: {
        vertLines: { color: `${cssVar('--border')}66` },
        horzLines: { color: `${cssVar('--border')}66` },
      },
      rightPriceScale: {
        // scaleMargins are fractions of the PANE's height, not pixels:
        // 0.08/0.08 leaves head/foot room so candles and drawing anchors
        // never sit on the very edge. The vol series below gets its OWN
        // scale ('vol') with top:0.8 — same knob, used as "occupy only the
        // bottom 20%".
        mode: scaleMode === 'log' ? 1 : scaleMode === '%' ? 2 : 0,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: cssVar('--border'),
        secondsVisible: false,
      },
      crosshair: {
        mode: 0,
        vertLine: { color: `${amber}88`, labelBackgroundColor: amber },
        horzLine: { color: `${amber}88`, labelBackgroundColor: amber },
      },
    })
    chartRef.current = chart

    let main: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'>
    if (chartType === 'candles' || chartType === 'ha') {
      main = chart.addSeries(CandlestickSeries, {
        upColor: up,
        downColor: down,
        borderUpColor: up,
        borderDownColor: down,
        wickUpColor: up,
        wickDownColor: down,
      })
    } else if (chartType === 'line') {
      main = chart.addSeries(LineSeries, { color: amber, lineWidth: 2 })
    } else {
      main = chart.addSeries(AreaSeries, {
        lineColor: amber,
        topColor: `${amber}44`,
        bottomColor: `${amber}05`,
        lineWidth: 2,
      })
    }
    mainRef.current = main

    // The 3rd addSeries arg is paneIndex — v5 real panes (v4 needed the
    // priceScaleId+scaleMargins overlay hack to fake a subpane). Volume gets
    // pane 1, the oscillator pane 2. The 'vol' scaleMargins top:0.8 reads
    // like a leftover of that v4 trick: inside its own pane it squashes the
    // bars into the bottom fifth of an already-short strip. Harmless, but
    // know which knob you're turning before "tidying" it.
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol' }, 1)
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    volRef.current = vol

    lineRefs.current.clear()
    const addOverlay = (name: string, color: string, width: 1 | 2 = 1) => {
      lineRefs.current.set(
        name,
        chart.addSeries(LineSeries, {
          color,
          lineWidth: width,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }),
      )
    }
    if (overlays.has('ema20')) addOverlay('ema20', '#38bdf8')
    if (overlays.has('ema50')) addOverlay('ema50', '#fb923c')
    if (overlays.has('sma200')) addOverlay('sma200', '#e879f9')
    if (overlays.has('vwap')) addOverlay('vwap', '#a3e635')
    if (overlays.has('bb')) {
      addOverlay('bbU', '#64748b')
      addOverlay('bbM', '#94a3b8', 1)
      addOverlay('bbL', '#64748b')
    }

    oscRefs.current.clear()
    if (osc === 'rsi') {
      const s = chart.addSeries(LineSeries, { color: '#38bdf8' }, 2)
      s.createPriceLine({
        price: 70,
        color: `${down}88`,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        title: '',
      })
      s.createPriceLine({
        price: 30,
        color: `${up}88`,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        title: '',
      })
      oscRefs.current.set('rsi', s)
    } else if (osc === 'macd') {
      oscRefs.current.set('macdHist', chart.addSeries(HistogramSeries, {}, 2))
      oscRefs.current.set('macd', chart.addSeries(LineSeries, { color: amber }, 2))
      oscRefs.current.set(
        'macdSig',
        chart.addSeries(LineSeries, { color: '#38bdf8' }, 2),
      )
    } else if (osc === 'atr') {
      oscRefs.current.set('atr', chart.addSeries(LineSeries, { color: '#fb923c' }, 2))
    } else if (osc === 'stoch') {
      oscRefs.current.set('stochK', chart.addSeries(LineSeries, { color: '#38bdf8' }, 2))
      oscRefs.current.set('stochD', chart.addSeries(LineSeries, { color: '#fb923c' }, 2))
    }

    try {
      const panes = chart.panes()
      if (panes[1]) panes[1].setHeight(compact ? 46 : 70)
      if (panes[2]) panes[2].setHeight(compact ? 56 : 90)
    } catch {
      /* pane sizing optional */
    }

    // NOTE: a crosshair-driven OHLC legend was wired here once and its
    // rendering removed; the setState-without-read loop lived on for months,
    // updating state React never displayed. Gone. Re-add BOTH ends together.

    // The only subscription in this file is visible-logical-range — there is
    // NO subscribeCrosshairMove here (verify before adding "the usual"
    // crosshair-unsubscribe boilerplate comment about it). Its job: nudge
    // redrawSignal so the SVG DrawingLayer re-anchors its paths whenever the
    // library pans/zooms under us; the drawing layer lives OUTSIDE the canvas
    // and gets no free repaints.
    const onRange = () => setRedrawSignal((n) => n + 1)
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    buildAllData(displayBarsRef.current)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.remove()
      chartRef.current = null
      mainRef.current = null
      volRef.current = null
      lineRefs.current.clear()
      oscRefs.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, chartType, osc, scaleMode, interval, overlays, compact])

  // ChartPanel ↔ DrawingLayer contract: pixels are container-relative CSS px,
  // times are EPOCH SECONDS (v5's UTCTimestamp), prices are plain values.
  // priceToCoordinate can return null for a price outside the visible scale —
  // consumers must handle null, not assume a number. coordinateToTime can
  // return a BusinessDay object if a chart ever mixes time formats; every
  // series here uses numeric seconds, so Number(t) is safe — it would be NaN
  // the day someone feeds the chart {year,month,day} bars.
  const timeToX = useCallback((ts: number): number | null => {
    const chart = chartRef.current
    if (!chart) return null
    const coord = chart.timeScale().timeToCoordinate(ts as UTCTimestamp)
    return coord ?? null
  }, [])

  const priceToY = useCallback((price: number): number | null => {
    const main = mainRef.current
    if (!main) return null
    return main.priceToCoordinate(price)
  }, [])

  const xToTime = useCallback((x: number): number | null => {
    const chart = chartRef.current
    if (!chart) return null
    const t = chart.timeScale().coordinateToTime(x)
    return t === null ? null : Number(t)
  }, [])

  const yToPrice = useCallback((y: number): number | null => {
    const main = mainRef.current
    if (!main) return null
    return main.coordinateToPrice(y)
  }, [])

  const onCanvasClick = (x: number, y: number) => {
    if (!tool) return
    const price = yToPrice(y)
    // Click left of the first bar (or before data loads) has no real time
    // under the cursor; we stamp NOW (seconds — the same epoch-seconds unit
    // as bar.ts, feeding a Date.now() ms here would anchor the drawing to
    // the year 172k). The drawing will slide as the user scrolls to it.
    const ts = xToTime(x) ?? Date.now() / 1000
    if (price === null) return
    const pt = { ts, price }
    if (tool === 'hline') {
      commit({ kind: 'hline', p1: pt })
      setTool(null)
      return
    }
    if (!pending) {
      setPending({ kind: tool as DrawView['kind'], p1: pt })
      return
    }
    commit({ kind: pending.kind, p1: pending.p1, p2: pt })
    setPending(null)
    setTool(null)
  }

  const commit = async (d: DrawView) => {
    if (!key) return
    // Optimistic: the local copy has no id until the server answers. If the
    // POST fails the catch swallows it and the id-less ghost lives on screen
    // — it is un-deletable (hit-circles need an id) and evaporates on the
    // next symbol change. "offline ok" is a decision, not an accident.
    setDrawings((prev) => [...prev, d])
    try {
      const res = await api.addDrawing(key, d.kind, {
        p1: d.p1,
        ...(d.p2 ? { p2: d.p2 } : {}),
        ...(d.payload ? { payload: d.payload } : {}),
      })
      setDrawings((prev) =>
        prev.map((x) => (x === d ? { ...x, id: res.id } : x)),
      )
    } catch {
      /* offline ok */
    }
  }

  const removeDrawing = async (id: number) => {
    setDrawings((prev) => prev.filter((d) => d.id !== id))
    try {
      await api.removeDrawing(id)
    } catch {
      /* ignore */
    }
  }

  const screenshot = () => {
    const chart = chartRef.current
    if (!chart) return
    const canvas = chart.takeScreenshot()
    const format = 'image/png'
    const a = document.createElement('a')
    a.href = canvas.toDataURL(format)
    a.download = `${(key.split(':').pop() ?? 'chart')}_${interval}.png`
    a.click()
  }

  const toggleOverlayPreset = (k: OverlayKey) => {
    setOverlays((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
    setSelectedOverlay(null)
  }

  const toggleOscillatorPreset = (k: Oscillator) => {
    setOsc((prev) => (prev === k ? 'none' : k))
    setSelectedOsc(null)
  }

  if (!key) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--dim)]">
        Ctrl+K → ticker to open a chart
      </div>
    )
  }

  const ticker = key.split(':').slice(1).join(':')

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1 text-[11px]">
        {standalone && (
          <>
            <span
              draggable={slotIndex !== undefined}
              onDragStart={(e) => {
                if (slotIndex === undefined) return
                e.dataTransfer.setData('text/pane-index', String(slotIndex))
                e.dataTransfer.setData('text/pane-type', 'chart')
                e.dataTransfer.effectAllowed = 'move'
              }}
              title="drag to another slot"
              className={`mr-1 select-none text-[var(--dim)] ${slotIndex !== undefined ? 'cursor-grab hover:text-[var(--amber)]' : ''}`}
            >
              ⣿
            </span>
            <input
              ref={symbolInputRef}
              defaultValue={ticker}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void api.resolve(symbolInputRef.current?.value ?? '').then((r) => {
                    if (r) setLocalSymbol(r.symbol_key)
                  })
                }
              }}
              className="w-20 rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 font-bold uppercase"
            />
          </>
        )}
        {!standalone && (
          <span className="mr-1 font-bold text-[var(--amber)]">{ticker}</span>
        )}
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => setInterval_(iv)}
            className={`rounded px-1.5 py-0.5 ${
              iv === interval
                ? 'bg-[var(--amber)] font-bold text-black'
                : 'text-[var(--dim)] hover:text-[var(--text)]'
            }`}
          >
            {iv}
          </button>
        ))}
        <span className="mx-1 h-3 w-px bg-[var(--border)]" />
        {(['candles', 'ha', 'line', 'area'] as ChartType[]).map((t) => (
          <button
            key={t}
            onClick={() => setChartType(t)}
            className={`rounded px-1.5 py-0.5 uppercase ${
              t === chartType ? 'bg-[var(--panel2)] font-bold text-[var(--amber)]' : 'text-[var(--dim)] hover:text-[var(--text)]'
            }`}
          >
            {t}
          </button>
        ))}
        <span className="mx-1 h-3 w-px bg-[var(--border)]" />
        {OVERLAYS.map((o) => (
          <button
            key={o}
            onClick={() => toggleOverlayPreset(o)}
            className={`rounded px-1.5 py-0.5 uppercase ${
              overlays.has(o) ? 'bg-[var(--panel2)] font-bold text-[#38bdf8]' : 'text-[var(--dim)] hover:text-[var(--text)]'
            }`}
            title={`Toggle ${o}`}
          >
            {o}
          </button>
        ))}
        <span className="mx-1 h-3 w-px bg-[var(--border)]" />
        {OSCILLATORS.map((o) => (
          <button
            key={o}
            onClick={() => toggleOscillatorPreset(o)}
            className={`rounded px-1.5 py-0.5 uppercase ${
              selectedOsc === o ? 'bg-[var(--panel2)] font-bold text-[var(--up)]' : 'text-[var(--dim)] hover:text-[var(--text)]'
            }`}
            title={`Toggle ${o}`}
          >
            {o}
          </button>
        ))}
        <span className="mx-1 h-3 w-px bg-[var(--border)]" />
        {(['hline', 'trend', 'fib', 'rect', 'ellipse', 'vline', 'label'] as Tool[]).map((t) => (
          <button
            key={t!}
            title={t!}
            onClick={() => {
              setTool(tool === t ? null : t)
              setPending(null)
            }}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 uppercase ${
              tool === t ? 'bg-[var(--amber)] font-bold text-black' : 'text-[var(--dim)] hover:text-[var(--text)]'
            }`}
          >
            <Crosshair size={10} /> {t}
          </button>
        ))}
        <span className="mx-1 h-3 w-px bg-[var(--border)]" />
        {drawings.length > 0 && (
          <button
            title="clear drawings (dbl-click one to delete single)"
            onClick={() => drawings.forEach((d) => d.id && removeDrawing(d.id))}
            className="rounded px-1 py-0.5 text-[var(--dim)] hover:text-[var(--down)]"
          >
            <Trash2 size={11} />
          </button>
        )}
        <span className="mx-1 h-3 w-px bg-[var(--border)]" />
        {!replayOn ? (
          <button
            onClick={() => {
              setReplayOn(true)
              setReplayPos(0)
              setPlaying(false)
            }}
            className="rounded px-1.5 py-0.5 text-[var(--dim)] hover:text-[var(--amber)]"
          >
            ⟲ replay
          </button>
        ) : (
          <span className="flex items-center gap-1">
            <button
              onClick={() => setPlaying(!playing)}
              className="rounded px-1.5 py-0.5 text-[var(--amber)]"
            >
              {playing ? <Pause size={11} /> : <Play size={11} />}
            </button>
            <button
              onClick={() => setReplayPos((p) => Math.min(p + 1, Math.min(replayBack, bars.length - 1) - 1))}
              className="rounded px-1 py-0.5 text-[var(--dim)] hover:text-[var(--text)]"
            >
              <StepForward size={11} />
            </button>
            <select
              value={replaySpeed}
              onChange={(e) => setReplaySpeed(e.target.value as '1x' | '2x' | '4x')}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-0.5"
            >
              {Object.keys(REPLAY_MS).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.min(replayBack, bars.length - 1) - 1)}
              value={replayPos}
              onChange={(e) => {
                setPlaying(false)
                setReplayPos(Number(e.target.value))
              }}
              className="w-24 accent-[var(--amber)]"
            />
            <button
              onClick={() => {
                setReplayOn(false)
                setPlaying(false)
              }}
              className="rounded px-1 py-0.5 text-[var(--dim)] hover:text-[var(--down)]"
            >
              <X size={11} />
            </button>
          </span>
        )}
        <button onClick={screenshot} className="ml-auto rounded px-1.5 py-0.5 text-[var(--dim)] hover:text-[var(--amber)]" title="export PNG">
          <Camera size={11} />
        </button>
      </div>

      <div className="flex gap-2 px-2 pt-0.5 text-[10px] capitalize">
        {selectedOverlay && (
          <div className="mb-1">
            <span className="font-medium text-[var(--amber)]">{selectedOverlay}</span>
            <div className="flex gap-1 pt-0.5">
              {OVERLAYS.map((o) => (
                <button
                  key={o}
                  onClick={() => {
                    if (overlays.has(o)) {
                      setOverlays((prev) => {
                        const next = new Set(prev)
                        next.delete(o)
                        return next
                      })
                    } else {
                      setOverlays((prev) => {
                        const next = new Set(prev)
                        next.add(o)
                        return next
                      })
                    }
                    setSelectedOverlay(null)
                  }}
                  className={`rounded px-1 py-0.5 ${
                    overlays.has(o) ? 'bg-[var(--panel2)] text-[#38bdf8]' : 'text-[var(--dim)]'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
        )}
        {selectedOsc && (
          <div className="mb-1">
            <span className="font-medium text-[var(--amber)]">{selectedOsc}</span>
            <div className="flex gap-1 pt-0.5">
              {OSCILLATORS.map((o) => (
                <button
                  key={o}
                  onClick={() => {
                    if (osc === o) {
                      setOsc('none')
                    } else {
                      setOsc(o)
                    }
                    setSelectedOsc(null)
                  }}
                  className={`rounded px-1 py-0.5 ${
                    osc === o ? 'bg-[var(--panel2)] text-[var(--up)]' : 'text-[var(--dim)]'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        <DrawingLayer
          timeToX={timeToX}
          priceToY={priceToY}
          interactive={tool !== null}
          drawings={drawings}
          pending={pending}
          onClickAt={onCanvasClick}
          onDelete={(id) => void removeDrawing(id)}
          redrawSignal={redrawSignal}
        />
      </div>
    </div>
  )
}