import {
  marketState as valtioMarketState,
  getQuotesVersion,
  subscribeQuotes,
  subscribeSparks,
  subscribeTrades,
  subscribeDepth,
  subscribeNews,
  subscribeStatuses,
} from './marketValtio'
import { useSyncExternalStore } from 'react'
import type { QuoteState } from '../lib/types'

/**
 * The ONLY components-side door into valtio market state.
 *
 * Pattern: useSyncExternalStore + a bucket-scoped valtio subscription +
 * getSnapshot returning the nested proxy object reference (stable until the
 * key is replaced, which is exactly when we want a re-render). This gives
 * real per-bucket granularity; the previous implementation subscribed every
 * helper to the root proxy and re-fired everyone on every tick.
 *
 * Components read fields off the proxy directly. Do NOT store these proxies
 * in state or mutate them during render — read-only, like a snapshot that
 * happens to update itself.
 */

export function useQuote(symbolKey: string): QuoteState | undefined {
  return useSyncExternalStore(
    subscribeQuotes,
    () => valtioMarketState.quotes[symbolKey],
    () => valtioMarketState.quotes[symbolKey],
  )
}

export function useSparks(symbolKey: string): number[] | undefined {
  return useSyncExternalStore(
    subscribeSparks,
    () => valtioMarketState.sparks[symbolKey],
    () => valtioMarketState.sparks[symbolKey],
  )
}

export function useTrades(symbolKey: string) {
  return useSyncExternalStore(
    subscribeTrades,
    () => valtioMarketState.trades[symbolKey],
    () => valtioMarketState.trades[symbolKey],
  )
}

export function useDepth(symbolKey: string) {
  return useSyncExternalStore(
    subscribeDepth,
    () => valtioMarketState.depth[symbolKey],
    () => valtioMarketState.depth[symbolKey],
  )
}

export function useNews(): Record<string, any[]> {
  return useSyncExternalStore(
    subscribeNews,
    () => valtioMarketState.news,
    () => valtioMarketState.news,
  )
}

export function useStatuses(): Record<string, boolean> {
  return useSyncExternalStore(
    subscribeStatuses,
    () => valtioMarketState.statuses,
    () => valtioMarketState.statuses,
  )
}

/**
 * Re-render trigger that fires whenever ANY quote value changed. Grid pages
 * (heatmap/screener) need the whole bucket; per-symbol components should use
 * useQuote() so React keeps their re-renders minimal. The counter lives in
 * marketValtio because a key-count snapshot would NOT change on a price tick
 * — that version would have been a very convincing no-op.
 */
export function useQuotesVersion(): number {
  return useSyncExternalStore(
    (cb) => subscribeQuotes(cb),
    getQuotesVersion,
    getQuotesVersion,
  )
}

/** Live read of one quote outside the hook rules (for grid rendering loops).
 * Direct proxy read — always fresh, never a stale snapshot; do NOT mutate. */
export function readQuote(symbolKey: string) {
  return valtioMarketState.quotes[symbolKey]
}
