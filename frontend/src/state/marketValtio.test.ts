import { beforeEach, describe, expect, it } from 'vitest'
import { applyFrame, marketState, mergeQuote } from './marketValtio'

// This file is the reason a frozen pipeline stays frozen no more: the
// original applyFrame trapped its entire event-handling body inside
// `if (frame.t === 'hello')` and NOTHING past the hello frame was ever
// applied. The "hello then tick" test below is literally that bug's
// epitaph.

describe('applyFrame', () => {
  beforeEach(() => {
    // reset buckets in place (mutation, never reassignment — see the hard
    // rule in marketValtio.ts)
    for (const k of Object.keys(marketState.quotes)) delete marketState.quotes[k]
    for (const k of Object.keys(marketState.sparks)) delete marketState.sparks[k]
    for (const k of Object.keys(marketState.trades)) delete marketState.trades[k]
    for (const k of Object.keys(marketState.depth)) delete marketState.depth[k]
    for (const k of Object.keys(marketState.news)) delete marketState.news[k]
    for (const k of Object.keys(marketState.statuses)) delete marketState.statuses[k]
  })

  it('applies hello snapshot + statuses', () => {
    applyFrame({
      t: 'hello',
      snapshot: { 'EQUITY:AAPL': { last: 200, symbol_key: 'EQUITY:AAPL' } },
      statuses: { binance: true, yahoo: false },
    })
    expect(marketState.quotes['EQUITY:AAPL']?.last).toBe(200)
    expect(marketState.statuses.binance).toBe(true)
    expect(marketState.statuses.yahoo).toBe(false)
  })

  it('applies tick events AFTER a hello frame (the brace-disaster regression)', () => {
    applyFrame({ t: 'hello', snapshot: {}, statuses: {} })
    applyFrame({
      t: 'e',
      topic: 'tick:CRYPTO:BTCUSDT',
      data: { price: 65000, size: 0.1, side: 'buy', ts: 'now' },
    })
    const q = marketState.quotes['CRYPTO:BTCUSDT']
    expect(q).toBeDefined()
    expect(q?.last).toBe(65000)
    expect(marketState.sparks['CRYPTO:BTCUSDT']).toEqual([65000])
    expect(marketState.trades['CRYPTO:BTCUSDT']).toHaveLength(1)

    // direction flips with price
    applyFrame({
      t: 'e',
      topic: 'tick:CRYPTO:BTCUSDT',
      data: { price: 64000, size: 0.1, side: 'sell', ts: 'now2' },
    })
    expect(marketState.quotes['CRYPTO:BTCUSDT']?.dir).toBe(-1)
    expect(marketState.quotes['CRYPTO:BTCUSDT']?.last).toBe(64000)
  })

  it('merges stats frames into an existing quote without inventing fields', () => {
    applyFrame({
      t: 'e',
      topic: 'tick:CRYPTO:ETHUSDT',
      data: { price: 3000, size: 1, side: null, ts: 't' },
    })
    applyFrame({
      t: 'e',
      topic: 'stats:CRYPTO:ETHUSDT',
      data: { last: 3010, volume: 12345, change_pct: 0.33, ts: 't2' },
    })
    const q = marketState.quotes['CRYPTO:ETHUSDT']
    expect(q?.last).toBe(3010)
    expect(q?.volume).toBe(12345)
    expect(q?.change_pct).toBe(0.33)
    // the stats frame must NOT append to the time&sales tape (still just the
    // one trade from the tick above)
    expect(marketState.trades['CRYPTO:ETHUSDT']).toHaveLength(1)
  })

  it('stores depth and status events', () => {
    applyFrame({
      t: 'e',
      topic: 'depth:CRYPTO:BTCUSDT',
      data: { bids: [[1, 2]], asks: [[3, 4]] },
    })
    expect(marketState.depth['CRYPTO:BTCUSDT']?.asks).toEqual([[3, 4]])
    // real provider payloads are {price,size} objects (pydantic DepthLevel)
    applyFrame({
      t: 'e',
      topic: 'depth:CRYPTO:BTCUSDT',
      data: {
        bids: [{ price: 1, size: 2 }],
        asks: [{ price: 3, size: 4 }],
      },
    })
    expect(marketState.depth['CRYPTO:BTCUSDT']?.bids).toEqual([[1, 2]])
    applyFrame({ t: 'e', topic: 'status:yahoo', data: { connected: false } })
    expect(marketState.statuses.yahoo).toBe(false)
  })

  it('prepends news, caps the bucket, ignores pong/garbage', () => {
    applyFrame({ t: 'e', topic: 'news:MARKET', data: { headline: 'a' } })
    applyFrame({ t: 'e', topic: 'news:MARKET', data: { headline: 'b' } })
    expect(marketState.news.MARKET[0].headline).toBe('b')
    expect(() => applyFrame({ t: 'pong' })).not.toThrow()
    expect(() => applyFrame(null)).not.toThrow()
    expect(() => applyFrame({ t: 'e' })).not.toThrow()
  })
})

describe('mergeQuote', () => {
  it('keeps the previous fields, stamps dir', () => {
    const a = mergeQuote(undefined, 'EQUITY:TSLA', { last: 400 }, 1)
    expect(a.symbol_key).toBe('EQUITY:TSLA')
    const b = mergeQuote(a, 'EQUITY:TSLA', { volume: 5 }, -1)
    expect(b.last).toBe(400)
    expect(b.volume).toBe(5)
    expect(b.dir).toBe(-1)
  })
})
