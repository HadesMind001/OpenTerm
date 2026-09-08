import { useMemo } from 'react'
import { Layers } from 'lucide-react'
import { useStore } from '../state/store'
import { useDepth } from '../state/hooks'

function fmt(n: number, d = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: d })
}

export function DepthPanel() {
  const key = useStore((s) => s.selected)
  const depth = useDepth(key ?? '')

  const { bidRows, askRows, imbalance, spread } = useMemo(() => {
    if (!depth) {
      // 0.5 imbalance / null spread = the NEUTRAL placeholder, not a
      // measurement. Do not read a flat 50/50 bar as "balanced book" — it
      // means "no book yet".
      return { bidRows: [], askRows: [], imbalance: 0.5, spread: null as number | null }
    }
    // 12 levels/side is the whole point: L2 snapshots carry hundreds of
    // price levels, cumulative-size bars would compress into noise, and the
    // depth re-renders on every book update (see the 150-cap note in
    // TapePanel for the same bounded-DOM discipline at a brutal refresh rate).
    // Slice BEFORE computing cum so the bar scale matches what's shown.
    let cum = 0
    const bids = depth.bids.slice(0, 12).map(([price, size]) => ({
      price,
      size,
      cum: (cum += size),
    }))
    cum = 0
    const asks = depth.asks.slice(0, 12).map(([price, size]) => ({
      price,
      size,
      cum: (cum += size),
    }))
    const totB = bids.reduce((a, b) => a + b.size, 0)
    const totA = asks.reduce((a, b) => a + b.size, 0)
    const imb = totB + totA > 0 ? totB / (totB + totA) : 0.5
    const sp =
      bids.length && asks.length ? asks[0].price - bids[0].price : null
    // asks cumulate best→worst but must RENDER worst-on-top (ladder toward
    // the spread divider), hence the reverse after the numbers are built —
    // flip it and the cumulative bars measure away from the spread.
    return { bidRows: bids, askRows: asks.reverse(), imbalance: imb, spread: sp }
  }, [depth])

  const maxCum = Math.max(
    1,
    ...bidRows.map((r) => r.cum),
    ...askRows.map((r) => r.cum),
  )
  const maxSize = Math.max(1, ...bidRows.map((r) => r.size), ...askRows.map((r) => r.size))
  const pct = Math.round(imbalance * 100)

  return (
    <div className="flex min-h-0 flex-1 flex-col border-b border-[var(--border)]">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)]">
        <Layers size={12} /> Order Book
        {spread !== null && (
          <span className="ml-auto normal-case text-[var(--amber)]">
            spread {fmt(spread, 2)}
          </span>
        )}
      </div>
      <div className="px-3 pb-1">
        <div className="flex h-1.5 overflow-hidden rounded bg-[var(--down)]/60">
          <div className="h-full bg-[var(--up)]" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-0.5 flex justify-between text-[9px] text-[var(--dim)]">
          <span>bid {pct}%</span>
          <span>imbalance</span>
          <span>{100 - pct}% ask</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1 text-[11px] tabular-nums">
        {askRows.length === 0 && (
          <div className="p-3 text-center text-[10px] text-[var(--dim)]">
            no depth data (crypto streams L2)
          </div>
        )}
        {askRows.map((r) => (
          <Row key={`a${r.price}`} price={r.price} size={r.size} cum={r.cum} side="ask" maxCum={maxCum} maxSize={maxSize} />
        ))}
        <div className="my-0.5 flex items-center gap-2 border-y border-[var(--border)] py-0.5 text-center text-[9px] uppercase text-[var(--dim)]">
          <span className="flex-1">price</span>
          <span className="w-16">size</span>
          <span className="w-16">total</span>
        </div>
        {bidRows.map((r) => (
          <Row key={`b${r.price}`} price={r.price} size={r.size} cum={r.cum} side="bid" maxCum={maxCum} maxSize={maxSize} />
        ))}
      </div>
    </div>
  )
}

function Row({
  price,
  size,
  cum,
  side,
  maxCum,
  maxSize,
}: {
  price: number
  size: number
  cum: number
  side: 'bid' | 'ask'
  maxCum: number
  maxSize: number
}) {
  const color = side === 'bid' ? 'var(--up)' : 'var(--down)'
  return (
    <div className="relative flex cursor-default items-center px-2 py-[1px] hover:bg-[var(--panel2)]">
      <div
        className="absolute inset-y-0 right-0 opacity-20"
        style={{ width: `${(cum / maxCum) * 100}%`, background: color }}
      />
      <div
        className="absolute inset-y-0 left-0 opacity-10"
        style={{ width: `${(size / maxSize) * 100}%`, background: color }}
      />
      <span className="relative flex-1" style={{ color }}>
        {fmt(price)}
      </span>
      <span className="relative w-16 text-right">{fmt(size, 4)}</span>
      <span className="relative w-16 text-right text-[var(--dim)]">{fmt(cum, 3)}</span>
    </div>
  )
}
