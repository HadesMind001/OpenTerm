import { useMemo, useState } from 'react'
import { Activity } from 'lucide-react'
import { useStore } from '../state/store'
import { useTrades } from '../state/hooks'
import type { TradeRow } from '../lib/types'

function fmt(n: number, d = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: d })
}

function timeOf(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ts?.slice(11, 19) ?? ''
  }
}

export function TapePanel() {
  const key = useStore((s) => s.selected)
  const trades = useTrades(key ?? '')
  const [minSize, setMinSize] = useState('')

  // Two caps, both load-bearing. 150: the in-memory ceiling marketValtio
  // enforces per symbol (trades.slice(-150)) — a DOM div per event at tick
  // rate on a busy tape melts the tab, so the buffer stops where scrolling
  // would stop anyway. 80 below: even 150 real nodes re-render on every
  // batch; the tape is glanceable, not scrollback. Raise one and you should
  // know the other exists.
  const rows = useMemo(() => {
    const min = parseFloat(minSize) || 0
    return [...(trades ?? [])].reverse().filter((t) => t.size >= min) // reverse: newest on top; the buffer appends
  }, [trades, minSize])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)]">
        <Activity size={12} /> Time &amp; Sales
        <input
          value={minSize}
          onChange={(e) => setMinSize(e.target.value)}
          placeholder="min size"
          spellCheck={false}
          className="ml-auto w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 text-[10px] normal-case outline-none focus:border-[var(--amber)]"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-[11px] tabular-nums">
        {rows.length === 0 && (
          <div className="p-3 text-center text-[10px] text-[var(--dim)]">
            waiting for trades…
          </div>
        )}
        {rows.slice(0, 80).map((t: TradeRow, i) => {
          // Default-to-buy is a choice, not an oversight: many feeds (most
          // crypto) omit aggressor side entirely; grey-on-missing would look
          // broken, green-on-missing only looks optimistic.
          const buy = t.side !== 'sell'
          return (
            <div
              // ts alone is NOT unique (same-ms prints); the i suffix means
              // keys churn as the window slides — with ≤80 rows that full
              // reconcile is cheaper than the bookkeeping to avoid it.
              key={`${t.ts}-${i}`}
              className={`flex items-center justify-between rounded px-1 py-[1px] ${
                buy ? 'bg-[var(--up)]/5' : 'bg-[var(--down)]/5'
              }`}
            >
              <span className="text-[var(--dim)]">{timeOf(t.ts)}</span>
              <span className={buy ? 'text-[var(--up)]' : 'text-[var(--down)]'}>
                {fmt(t.price)}
              </span>
              <span className="w-16 text-right text-[var(--dim)]">
                {t.size > 0 ? fmt(t.size, 4) : '—'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
