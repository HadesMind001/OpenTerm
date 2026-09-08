import { useEffect, useRef, useState } from 'react'
import { ListPlus, X } from 'lucide-react'
import { useStore } from '../state/store'
import { useQuote, useSparks } from '../state/hooks'
import type { WatchItem } from '../lib/types'

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  if (Math.abs(n) >= 10000) return n.toLocaleString('en-US', { maximumFractionDigits: digits })
  return n.toFixed(digits)
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <svg width="72" height="20" />
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1 // flat feed → all y = 18: the line sits on the svg's BOTTOM edge, not mid-box
  const step = 72 / (points.length - 1)
  const path = points
    .map((p, i) => `${i * step},${18 - ((p - min) / span) * 16}`)
    .join(' ')
  const up = points[points.length - 1] >= points[0]
  return (
    <svg width="72" height="20" className="shrink-0">
      <polyline
        points={path}
        fill="none"
        stroke={up ? 'var(--up)' : 'var(--down)'}
        strokeWidth="1.2"
      />
    </svg>
  )
}

function Row({ item }: { item: WatchItem }) {
  const q = useQuote(item.symbol_key)
  const spark = useSparks(item.symbol_key)
  const isSelected = useStore((s) => s.selected === item.symbol_key)
  const select = useStore((s) => s.select)
  const removeSymbol = useStore((s) => s.removeSymbol)
  const prev = useRef<number | null>(null)
  const [flash, setFlash] = useState<'' | 'flash-up' | 'flash-down'>('')

  // Flash-on-tick, the honest version: direction compares the ROW's own
  // previous render, not the quote's server-side `dir` field — a remounted
  // row starts from null and the `old === null` bail keeps a page load from
  // strobing the whole list green. The 500 ms timer pairs with the 0.55 s
  // CSS animation in index.css (change one, change the other). Known wart:
  // two same-direction ticks inside one flash leave the class untouched, so
  // the animation does NOT restart — only direction flips re-trigger it.
  useEffect(() => {
    const last = q?.last ?? null
    const old = prev.current
    prev.current = last
    if (old === null || last === null || last === old) return
    setFlash(last > old ? 'flash-up' : 'flash-down')
    const t = setTimeout(() => setFlash(''), 500)
    return () => clearTimeout(t)
  }, [q?.last])

  const pct = q?.change_pct ?? null
  const up = (pct ?? 0) >= 0

  return (
    <div
      draggable
      // The only thing we can smuggle in an HTML5 DnD payload is a string —
      // we set 'text/symbol' to the full symbol_key ("yahoo:US.AAPL"), NOT
      // the ticker. effectAllowed 'copyMove': 'copy' = drop on a workspace
      // pane (WorkspaceArea.tsx PaneCard), 'move' = reorder. There is no
      // splice/index math anywhere in the drop handler — PaneCard.onDrop
      // does a pairwise swapPanes(from,to) on a FIXED 4-slot array (or sets
      // a symbol), so the classic "remove-then-insert-at-same-index"
      // off-by-one can't bite here. Watchlist ORDER itself is never
      // reorganized: the row is a drag SOURCE only — no drop target exists
      // on this list, so no splice, no index math, no reorder persistence.
      // The real trap is on the TARGET side: WorkspaceArea.tsx reads
      // getData('text/symbol') in onDragOver, but HTML5 DnD only exposes
      // custom-type DATA on the drop event — during dragover getData returns
      // '', so the drop hint falls through to 'move' for every drag. That's
      // a target bug, not a payload bug; this string is correct.
      onDragStart={(e) => {
        e.dataTransfer.setData('text/symbol', item.symbol_key)
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      onClick={() => select(item.symbol_key)}
      className={`group flex cursor-grab items-center gap-2 border-b border-[var(--border)]/50 px-3 py-1.5 hover:bg-[var(--panel2)] active:cursor-grabbing ${
        isSelected ? 'bg-[var(--panel2)] border-l-2 border-l-[var(--amber)]' : ''
      } ${flash}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{item.ticker}</div>
        <div className="text-[10px] text-[var(--dim)]">{item.asset_class}</div>
      </div>
      <Sparkline points={spark ?? []} />
      <div className="w-[74px] text-right tabular-nums">{fmt(q?.last)}</div>
      <div className={`w-[58px] text-right tabular-nums ${up ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>
        {pct === null ? '—' : `${up ? '+' : ''}${pct.toFixed(2)}%`}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation()
          void removeSymbol(item.symbol_key)
        }}
        className="opacity-0 transition-opacity group-hover:opacity-100 text-[var(--dim)] hover:text-[var(--down)]"
        title="remove"
      >
        <X size={13} />
      </button>
    </div>
  )
}

export function WatchlistPanel() {
  const watchlist = useStore((s) => s.watchlist)

  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--panel)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-wider text-[var(--dim)]">
        <ListPlus size={13} /> Watchlist · Main
      </div>
      <div className="overflow-y-auto flex-1">
        {watchlist.length === 0 && (
          <div className="p-4 text-center text-xs text-[var(--dim)]">
            Empty. Add symbols via the command bar above.
          </div>
        )}
        {watchlist.map((item) => (
          <Row key={item.symbol_key} item={item} />
        ))}
      </div>
    </div>
  )
}
