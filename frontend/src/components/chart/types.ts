export interface Pt {
  ts: number
  price: number
}

export interface HlinePayload {
  price: number
  label?: string
}

export interface TrendPayload {
  points: [Pt, Pt]
}

export interface FibPayload {
  levels?: number[]
  pivotHigh?: Pt
  pivotLow?: Pt
}

export interface DrawView {
  id?: number
  kind: 'hline' | 'trend' | 'fib' | 'fib-ext' | 'rect' | 'ellipse' | 'vline' | 'label'
  p1: Pt
  p2?: Pt
  payload?: HlinePayload | TrendPayload | FibPayload
}

export type Tool = 'hline' | 'trend' | 'fib' | 'rect' | 'ellipse' | 'vline' | 'select' | null

export type Oscillator = 'none' | 'rsi' | 'macd' | 'atr' | 'stoch'

export type ChartType = 'candles' | 'ha' | 'line' | 'area'

export type OverlayKey = 'ema20' | 'ema50' | 'sma200' | 'vwap' | 'bb'

export type DrawingKind = 'hline' | 'trend' | 'fib' | 'fib-ext' | 'rect' | 'ellipse' | 'vline' | 'label'
