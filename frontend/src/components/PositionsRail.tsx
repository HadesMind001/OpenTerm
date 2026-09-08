import { useEffect, useState } from 'react'
import { Briefcase, ChevronDown } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../state/store'
import { useQuote } from '../state/hooks'
import type { Portfolio as PF } from '../lib/types'

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: d })
}

function PositionRow({
  position,
  select,
  openTicket,
}: {
  position: PF['positions'][0]
  select: (key: string) => void
  openTicket: (side: 'buy' | 'sell') => void
}) {
  const q = useQuote(position.symbol_key)
  const markNow = q?.last ?? position.mark
  const upnl =
    markNow !== null && markNow !== undefined
      ? (markNow - position.avg_cost) * position.qty
      : position.unrealized
  const posUp = (upnl ?? 0) >= 0

  return (
    <div
      key={position.symbol_key}
      className="mt-1 flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-[var(--panel2)]"
      onClick={() => select(position.symbol_key)}
    >
      <span className="min-w-0 flex-1 truncate font-semibold">
        {position.symbol_key.split(':').pop()}
      </span>
      <span className="tabular-nums text-[var(--dim)]">{position.qty}</span>
      <span
        className={`w-16 text-right tabular-nums ${
          posUp ? 'text-[var(--up)]' : 'text-[var(--down)]'
        }`}
      >
        {posUp ? '+' : ''}
        {fmt(upnl)}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          select(position.symbol_key)
          openTicket('sell')
        }}
        className="rounded border border-[var(--border)] px-1 text-[9px] uppercase text-[var(--down)] hover:border-[var(--down)]"
      >
        flat
      </button>
    </div>
  )
}

export function PositionsRail() {
  const [open, setOpen] = useState(true)
  const [pf, setPf] = useState<PF | null>(null)
  const fillTick = useStore((s) => s.fillTick)
  const openTicket = useStore((s) => s.openTicket)
  const select = useStore((s) => s.select)

  useEffect(() => {
    void api.portfolio().then(setPf).catch(() => undefined)
    const id = window.setInterval(
      () => void api.portfolio().then(setPf).catch(() => undefined),
      5000,
    )
    return () => window.clearInterval(id)
  }, [fillTick])

  if (!pf) return null

  return (
    <div className="max-h-64 shrink-0 overflow-hidden border-b border-[var(--border)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)] hover:text-[var(--text)]"
      >
        <Briefcase size={12} /> Account
        <span className="ml-2 normal-case text-[var(--amber)] tabular-nums">
          ${fmt(pf.equity)}
        </span>
        <ChevronDown
          size={12}
          className={`ml-auto transition-transform ${open ? '' : '-rotate-90'}`}
        />
      </button>
      {open && (
        <div className="px-3 pb-1.5">
          <div className="flex justify-between text-[10px] text-[var(--dim)] tabular-nums">
            <span>cash ${fmt(pf.cash)}</span>
            <span className={pf.unrealized >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>
              uP&L {pf.unrealized >= 0 ? '+' : ''}
              {fmt(pf.unrealized)}
            </span>
          </div>
          {pf.positions.map((p) => (
            <PositionRow key={p.symbol_key} position={p} select={select} openTicket={openTicket} />
          ))}
        </div>
      )}
    </div>
  )
}
