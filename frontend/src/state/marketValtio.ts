import { getVersion, proxy, subscribe } from 'valtio'
import { devtools } from 'valtio/utils'
import type { QuoteState } from '../lib/types'

export type { QuoteState }
export type { QuoteState as QuoteStateValtio }

// ── Valtio market state — the second reactive system, on purpose ─────────
//
// Yes, this repo runs BOTH zustand and valtio. It is a half-finished
// migration and merging them back is a rewrite we are deliberately not doing
// today. The honest split:
//   * zustand (state/store.ts)  — UI/app state: watchlist, panes, pages,
//     toasts, bots, tickets. Low-frequency, benefits from actions.
//   * valtio (this file)        — market data: quotes/sparks/trades/depth/
//     news/statuses. High-frequency: every tick replaces an object, and we
//     want per-bucket subscribe granularity without hand-rolled caching.
// Consumers reach market data ONLY through state/hooks.ts. Do not sprinkle
// `useSnapshot` across components; that is how the migration got confusing
// the first time.

export interface MarketStateValtio {
  quotes: Record<string, QuoteState>
  sparks: Record<string, number[]>
  trades: Record<string, Array<{ price: number; size: number; side: string; ts: string }>>
  depth: Record<string, { bids: Array<[number, number]>; asks: Array<[number, number]> }>
  news: Record<string, Array<any>>
  statuses: Record<string, boolean>
  connected: boolean
}

// Create reactive state
const marketState = proxy<MarketStateValtio>({
  quotes: {},
  sparks: {},
  trades: {},
  depth: {},
  news: {},
  statuses: {},
  connected: false,
})

// Enable devtools in development
if (import.meta.env.DEV) {
  devtools(marketState, { name: 'OpenTerm Market' })
}

// ── Subscriptions ----------------------------------------------------------
//
// How to get per-bucket granularity in valtio v2:
//   subscribe(marketState.quotes, cb) fires for mutations of the nested
//   proxy. The naive alternative — subscribe(whole proxy) — fires for
//   EVERYTHING, and the old helpers did exactly that, so "granular
//   reactivity" was fiction: a BTC tick re-fired AAPL subscribers.
//
// HARD RULE enforced by this module: top-level bucket containers are
// MUTATED, NEVER REASSIGNED. `marketState.statuses = {...}` swaps in a plain
// object, the nested proxy subscribers keep listening to the OLD dead proxy
// and the UI silently freezes for that bucket — valtio will not warn you.
// (loadWatchlist in store.ts used to break exactly this rule. It no longer
// does. Keep it that way.)

// valtio's own per-proxy version: bumps on every notification of the quotes
// bucket, from ANY writer (applyFrame, loadWatchlist, devtools). A hand-rolled
// counter would drift the moment someone mutates marketState.quotes elsewhere
// — which store.ts absolutely does. Use the library's.
export function getQuotesVersion(): number {
  return getVersion(marketState.quotes) ?? 0
}

export const subscribeQuotes = (cb: () => void) => subscribe(marketState.quotes, cb)
export const subscribeSparks = (cb: () => void) => subscribe(marketState.sparks, cb)
export const subscribeTrades = (cb: () => void) => subscribe(marketState.trades, cb)
export const subscribeDepth = (cb: () => void) => subscribe(marketState.depth, cb)
export const subscribeNews = (cb: () => void) => subscribe(marketState.news, cb)
export const subscribeStatuses = (cb: () => void) => subscribe(marketState.statuses, cb)
export const subscribeConnectedKey = (cb: () => void) => subscribe(marketState, cb)

// ── Mutation helpers -------------------------------------------------------

export function setConnected(up: boolean) {
  marketState.connected = up
}

function emptyQuote(key: string): QuoteState {
  return {
    symbol_key: key,
    last: null,
    prev_close: null,
    change_pct: null,
    bid: null,
    ask: null,
    open: null,
    day_high: null,
    day_low: null,
    volume: null,
    updated: null,
    dir: 0,
  }
}

export function mergeQuote(
  prev: QuoteState | undefined,
  key: string,
  patch: Partial<QuoteState>,
  dir: 1 | -1 | 0,
): QuoteState {
  const base: QuoteState = prev ?? emptyQuote(key)
  return { ...base, ...patch, symbol_key: key, dir }
}

/**
 * Apply one server frame (hello / event / pong) to the market proxy.
 *
 * HISTORICAL WARNING — the single worst bug in this repo lived HERE:
 * the entire event-handling body was indented *inside* `if (frame.t ===
 * 'hello') { ... }`, and the guard `if (frame.t !== 'e') return` inside that
 * block made lines for ticks/depth/news/status unreachable for EVERY frame.
 * The terminal received the initial snapshot and then showed a frozen market
 * forever, with zero console errors. If you "just wrap one more thing in a
 * branch here", write the vitest case in state/marketValtio.test.ts first.
 */
export function applyFrame(frame: any) {
  if (!frame || typeof frame !== 'object') return

  if (frame.t === 'hello') {
    if (frame.snapshot) {
      for (const [key, quote] of Object.entries(frame.snapshot)) {
        if (quote && typeof quote === 'object' && Object.keys(quote).length > 0) {
          marketState.quotes[key] = { ...marketState.quotes[key], ...(quote as object), dir: 0 }
        }
      }
    }
    if (frame.statuses) {
      // MUTATE in place — see "HARD RULE" above: reassigning the bucket orphans
      // every statuses subscriber.
      Object.assign(marketState.statuses, frame.statuses)
    }
    if (frame.news) {
      for (const [key, items] of Object.entries(frame.news)) {
        if (Array.isArray(items)) {
          marketState.news[key] = [...(items as any[]), ...(marketState.news[key] || [])].slice(0, 60)
        }
      }
    }
    return
  }

  if (frame.t === 'pong') return
  if (frame.t !== 'e' || !frame.topic) return

  const topic: string = frame.topic
  const data: Record<string, any> = frame.data ?? {}

  // Tick or stats → quote merge (+ spark/tape for ticks)
  if (topic.startsWith('tick:') || topic.startsWith('stats:')) {
    const isTick = topic.startsWith('tick:')
    const key = topic.slice(topic.indexOf(':') + 1)
    const prev = marketState.quotes[key]

    const patch: Partial<QuoteState> = {}
    // Ticks carry `price`, stats frames carry `last` — normalize both into
    // patch.last. (Forgetting the price case is how quotes would sit at null
    // forever despite a lively tape; do not "simplify" this back to one key.)
    const price = typeof data.price === 'number' ? (data.price as number) : undefined
    if (price !== undefined) patch.last = price
    for (const k of [
      'last', 'prev_close', 'change_pct', 'day_high', 'day_low',
      'volume', 'open', 'bid', 'ask',
    ] as const) {
      const v = data[k]
      if (typeof v === 'number') patch[k] = v
    }

    const oldLast = prev?.last ?? null
    const newLast = patch.last ?? oldLast
    const dir: 1 | -1 | 0 =
      oldLast !== null && newLast !== null && newLast !== oldLast
        ? newLast > oldLast
          ? 1
          : -1
        : 0

    marketState.quotes[key] = mergeQuote(prev, key, patch, dir)

    if (isTick && typeof data.price === 'number') {
      const spark = marketState.sparks[key] || []
      marketState.sparks[key] = [...spark, data.price as number].slice(-80)

      const existing = marketState.trades[key] || []
      marketState.trades[key] = [
        ...existing,
        {
          price: (data.price as number) ?? 0,
          size: (data.size as number) ?? 0,
          side: (data.side as string) ?? '',
          ts: (data.ts as string) ?? '',
        },
      ].slice(-150)
    }
    return
  }

  // Depth. NOTE: the backend compresses any event > 1 KiB into
  // FRAME_COMPRESSED_EVENT and the WS layer (lib/ws.ts) decompresses before
  // calling us — depth frames are always above that threshold, which is why
  // the L2 book historically looked "empty" while a bug sat in the transport.
  if (topic.startsWith('depth:')) {
    const key = topic.slice(6)
    const bids = (data.bids ?? []) as Array<[number, number]>
    const asks = (data.asks ?? []) as Array<[number, number]>
    marketState.depth[key] = { bids, asks }
    return
  }

  // Status updates ("status:binance" → provider name)
  if (topic.startsWith('status:')) {
    const name = topic.slice(7)
    marketState.statuses[name] = !!data.connected
    return
  }

  // News items; fills/alerts/bars are consumed elsewhere (store.ts handles
  // fill:/alert: ticks and bot.* events; ChartPanel subscribes to bar: via
  // the same applyFrame pipeline once charts move here).
  if (topic.startsWith('news:')) {
    const key = topic.slice(5) || 'MARKET'
    const bucket = marketState.news[key] || []
    marketState.news[key] = [data, ...bucket].slice(0, 60)
  }
}

export { marketState }
