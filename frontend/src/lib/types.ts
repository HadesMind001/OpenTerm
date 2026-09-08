export interface QuoteState {
  symbol_key: string
  last: number | null
  prev_close: number | null
  change_pct: number | null
  bid: number | null
  ask: number | null
  open: number | null
  day_high: number | null
  day_low: number | null
  volume: number | null
  updated: string | null
  dir?: 1 | -1 | 0
}

export interface WatchItem {
  symbol_key: string
  position: number
  asset_class: string
  ticker: string
  state: Partial<QuoteState>
}

export interface NewsRow {
  symbol_key: string
  feed: string
  headline: string
  url: string
  source: string
  summary: string
  published: string | null
  ts?: string
  sentiment?: number
  sentiment_label?: string
}

export type AlertKind =
  | 'above'
  | 'below'
  | 'pct_up'
  | 'pct_dn'
  | 'rsi_above'
  | 'rsi_below'
  | 'vol_spike'

export interface AlertRule {
  id: number
  symbol_key: string
  kind: AlertKind
  threshold: number
  ref_price: number | null
  active: number | boolean
  one_shot: number | boolean
  cooldown: number
  snooze_until: number
  last_fired: number | null
  created: number
  note: string
}

export interface AlertFire {
  id: number
  alert_id: number
  price: number
  ts: number
  symbol_key: string
  kind: string
  threshold: number
}

export interface DesInfo {
  symbol_key: string
  asset_class: string
  ticker: string
  state: Partial<QuoteState>
  extra: {
    exchange?: string
    currency?: string
    instrument_type?: string
    full_name?: string
    week52_high?: number
    week52_low?: number
    year_return_pct?: number
  }
  peers: string[]
  recent_fires: AlertFire[]
  journal: { id: number; text: string; created: number }[]
}

export interface Bar {
  ts: number
  o: number
  h: number
  l: number
  c: number
  v: number
  interval?: string
  closed?: boolean
}

export interface ResolveResult {
  symbol_key: string
  asset_class: string
  ticker: string
  display_name: string
}

export interface TradeRow {
  price: number
  size: number
  side: string
  ts: string
}

export interface DepthLevel {
  price: number
  size: number
}

export interface DepthSnapshot {
  bids: DepthLevel[]
  asks: DepthLevel[]
}

export interface Drawing {
  id?: number
  kind: 'hline' | 'trend' | 'fib' | 'fib-ext' | 'rect' | 'ellipse' | 'vline' | 'label'
  payload: Record<string, unknown>
}

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit'
export type OrderStatus = 'working' | 'filled' | 'canceled'

export interface Order {
  id: number
  symbol_key: string
  side: OrderSide
  otype: OrderType
  qty: number
  limit_price: number | null
  stop_price: number | null
  tif: string
  status: OrderStatus
  filled_qty: number
  avg_fill: number | null
  created: number
  updated: number | null
}

export interface Position {
  symbol_key: string
  qty: number
  avg_cost: number
  mark: number | null
  value: number | null
  unrealized: number | null
  unrealized_pct: number | null
  realized: number
}

export interface Portfolio {
  cash: number
  equity: number
  unrealized: number
  positions: Position[]
}

export interface FillRow {
  id: number
  order_id: number
  symbol_key: string
  side: string
  qty: number
  price: number
  fee: number
  ts: number
}

export interface ClosedTrade {
  symbol_key: string
  ts: number
  qty: number
  exit: number
  pnl: number
}

export interface Analytics {
  points: [number, number][]
  drawdowns?: [number, number][]
  max_dd_pct?: number
  total_return_pct?: number
  sharpe?: number | null
  trades: ClosedTrade[]
  win_rate?: number | null
  profit_factor?: number | null
}

export interface JournalEntry {
  id: number
  symbol_key: string
  text: string
  tags: string
  created: number
}

export interface Toast {
  id: number
  kind: 'fill' | 'error' | 'info'
  msg: string
}

export interface UniverseRow {
  symbol_key: string
  ticker: string
  asset_class: string
  sector: string | null
  industry: string | null
  market_cap_m: number | null
  last: number
  change_pct: number | null
  volume: number | null
  notional: number | null
  day_high: number | null
  day_low: number | null
}

export interface CorrResult {
  symbols: string[]
  matrix: number[][]
}

export interface SettingsInfo {
  available: Record<string, boolean>
  config_path: string
  note: string
}

export interface EarningsRow {
  symbol: string
  date: string
  epsEstimate?: number
  hour?: string
}

export interface CalendarInfo {
  available: boolean
  earnings: EarningsRow[]
}

export interface MacroSeries {
  label: string
  value: number
  date: string
  history: [string, number][]
}

export interface MacroInfo {
  available: boolean
  series: Record<string, MacroSeries>
}

export interface Frame {
  t: string
  topic?: string
  data?: Record<string, unknown>
  snapshot?: Record<string, QuoteState>
  statuses?: Record<string, boolean>
  news?: Record<string, NewsRow[]>
}

export interface KeybindingRow {
  id: number
  name: string
  bindings: string
  created: number
}

export interface LayoutRow {
  id: number
  name: string
  config: string
  created: number
}

export interface WorkspaceRow {
  id: number
  name: string
  config: string
  created: number
}

export interface ScriptResult {
  success: boolean
  output: string
  error: string | null
  exit_code: number
  variables: Record<string, string>
}

