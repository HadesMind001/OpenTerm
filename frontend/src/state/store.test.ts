import { describe, expect, it } from 'vitest'
import { useStore } from './store'

// fill:/alert: frames used to fall through the pipeline unhandled: pages
// watched `fillTick`/`alertTick` religiously, but NOTHING ever incremented
// them, so "blotters refresh on fills" was a spec written against a feature
// that didn't exist. store.applyFrame now owns that wiring — this pins it.

describe('store.applyFrame fill/alert wiring', () => {
  it('increments fillTick and queues a toast on fill frames', () => {
    const before = useStore.getState().fillTick
    useStore.getState().applyFrame({
      t: 'e',
      topic: 'fill:EQUITY:AAPL',
      data: { symbol_key: 'EQUITY:AAPL', side: 'buy', qty: 2, price: 201.23, fee: 0.1 },
    } as never)
    const after = useStore.getState()
    expect(after.fillTick).toBe(before + 1)
    expect(after.toasts.some((t) => t.msg.includes('AAPL'))).toBe(true)
  })

  it('increments alertTick on alert frames', () => {
    const before = useStore.getState().alertTick
    useStore.getState().applyFrame({
      t: 'e',
      topic: 'alert:7',
      data: { symbol_key: 'CRYPTO:BTCUSDT', kind: 'above', threshold: 70000, message: 'BTC above 70000' },
    } as never)
    expect(useStore.getState().alertTick).toBe(before + 1)
  })

  it('routes market events to valtio (applyFrame delegation)', () => {
    useStore.getState().applyFrame({
      t: 'e',
      topic: 'tick:CRYPTO:SOLUSDT',
      data: { price: 150, size: 1, side: 'buy', ts: 'x' },
    } as never)
    // lazy import to avoid hoisting-order concerns; same module instance
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return import('./marketValtio').then(({ marketState }) => {
      expect(marketState.quotes['CRYPTO:SOLUSDT']?.last).toBe(150)
    })
  })
})
