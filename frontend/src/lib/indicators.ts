import type { Bar } from './types'

type Opt = number | null

// Hand-rolled formulas. The division hazards for each live in a specific
// place — see the per-function notes. None of these guard period <= 0
// (silent NaN, not an error); callers pass constants.

export function sma(values: number[], period: number): Opt[] {
  const out: Opt[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function ema(values: number[], period: number): Opt[] {
  // Seed = SMA of the first `period` values (classic choice; means the line
  // starts at period-1, not 0). 2/(period+1) divides safely: period >= 1.
  const out: Opt[] = new Array(values.length).fill(null)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export function bollinger(
  values: number[],
  period = 20,
  mult = 2,
): { mid: Opt[]; upper: Opt[]; lower: Opt[] } {
  // Population variance (÷period), not sample — bands sit slightly tighter
  // than the Excel-style "STDEV" most TA references quote. A zero stdev
  // (flat window) needs no guard: upper = lower = mid, nothing divides by sd.
  const mid = sma(values, period)
  const upper: Opt[] = new Array(values.length).fill(null)
  const lower: Opt[] = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1)
    const m = mid[i]
    if (m === null) continue
    const variance = slice.reduce((a, b) => a + (b - m) ** 2, 0) / period
    const sd = Math.sqrt(variance)
    upper[i] = m + mult * sd
    lower[i] = m - mult * sd
  }
  return { mid, upper, lower }
}

export function rsi(values: number[], period = 14): Opt[] {
  // The divide-by-zero edge is loss === 0 (pure-up window → gain/loss = ∞).
  // It is guarded with a literal 100 at BOTH the seed (line below) and every
  // Wilder-smoothing step — the mirror case gain === 0 self-solves
  // (100 - 100/(1+0) = 0) and needs no special-casing. If you touch the
  // smoothing, keep both guards; losing the second one is a silent
  // Infinity leaking into the chart's price scale.
  const out: Opt[] = new Array(values.length).fill(null)
  if (values.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { line: Opt[]; signal: Opt[]; hist: Opt[] } {
  // The signal window is the trap here: `line` starts null for slow-1 bars,
  // and ema() on the raw array would let JS coerce those nulls to 0 inside
  // the SMA seed — a plausible-looking signal line that is silently WRONG,
  // not NaN, so nothing would ever scream. Instead the nulls are compacted
  // away, the 9-EMA runs on the numeric suffix only, and results are
  // re-aligned to original indices via `offset`. Do not "simplify" to
  // ema(line, 9).
  const emaFast = ema(values, fast)
  const emaSlow = ema(values, slow)
  const line: Opt[] = values.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null
      ? (emaFast[i] as number) - (emaSlow[i] as number)
      : null,
  )
  const compact = line.filter((v): v is number => v !== null)
  const sigCompact = ema(compact, signalPeriod)
  const offset = line.findIndex((v) => v !== null)
  const signal: Opt[] = new Array(values.length).fill(null)
  const hist: Opt[] = new Array(values.length).fill(null)
  if (offset >= 0) {
    for (let i = 0; i < sigCompact.length; i++) {
      const s = sigCompact[i]
      if (s === null) continue
      signal[offset + i] = s
      hist[offset + i] = (line[offset + i] as number) - s
    }
  }
  return { line, signal, hist }
}

export function atr(bars: Bar[], period = 14): Opt[] {
  // True range can be ZERO (flat bar: h === l === prev close) but that is
  // harmless here — nothing divides by tr; ATR is just an EMA of it. Bar 0
  // has no previous close, so its TR degrades to the bar's own range.
  const tr: number[] = bars.map((b, i) => {
    if (i === 0) return b.h - b.l
    const pc = bars[i - 1].c
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc))
  })
  return ema(tr, period)
}

export function stochastic(
  bars: Bar[],
  kPeriod = 14,
  dPeriod = 3,
): { k: Opt[]; d: Opt[] } {
  const k: Opt[] = new Array(bars.length).fill(null)
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const slice = bars.slice(i - kPeriod + 1, i + 1)
    const hi = Math.max(...slice.map((b) => b.h))
    const lo = Math.min(...slice.map((b) => b.l))
    const span = hi - lo || 1
    // The `|| 1` guards the flat-window divide-by-zero (hi === lo). Note the
    // honest consequence: c === lo === hi, so a flat window scores %K = 0,
    // not the 50 some libraries choose. Consistent, just not "neutral".
    k[i] = ((bars[i].c - lo) / span) * 100
  }
  const kCompactIdx = k.map((v, i) => [v, i] as const).filter(([v]) => v !== null)
  const kVals = kCompactIdx.map(([v]) => v as number)
  const dVals = sma(kVals, dPeriod)
  const d: Opt[] = new Array(bars.length).fill(null)
  kCompactIdx.forEach(([, i], j) => {
    if (dVals[j] !== null) d[i] = dVals[j]
  })
  return { k, d }
}

export function vwap(bars: Bar[]): Opt[] {
  // Volume-missing feeds (b.v undefined/0) would make cumV 0 → 0/0. The
  // cumV > 0 check emits null instead, which the chart filters out — a
  // hidden guard, not a skipped bar, so VWAP "disappearing" means the feed
  // carries no volume, not that this broke. Second honesty: it accumulates
  // over the whole input window, no session reset — on the 1d interval this
  // is "VWAP of the last N bars", not the day-anchored number traders quote.
  let cumPV = 0
  let cumV = 0
  return bars.map((b) => {
    const typical = (b.h + b.l + b.c) / 3
    cumPV += typical * (b.v || 0)
    cumV += b.v || 0
    return cumV > 0 ? cumPV / cumV : null
  })
}

export type ChartType = 'candles' | 'ha' | 'line' | 'area'

export function heikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = []
  let prevO = bars[0]?.o ?? 0
  let prevC = bars[0]?.c ?? 0
  for (const b of bars) {
    const close = (b.o + b.h + b.l + b.c) / 4
    const open = out.length === 0 ? (b.o + b.c) / 2 : (prevO + prevC) / 2
    out.push({
      ...b,
      o: open,
      c: close,
      h: Math.max(b.h, open, close),
      l: Math.min(b.l, open, close),
    })
    prevO = open
    prevC = close
  }
  return out
}
