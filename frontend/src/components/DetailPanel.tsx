import { useStore } from '../state/store'
import { useQuote } from '../state/hooks'
import { ChartPanel } from './chart/ChartPanel'

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--dim)]">{label}</div>
      <div className="tabular-nums">{value}</div>
    </div>
  )
}

export function DetailPanel() {
  const selected = useStore((s) => s.selected)
  const q = useQuote(selected ?? '')
  const openTicket = useStore((s) => s.openTicket)

  if (!selected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--dim)]">
        <div className="font-mono text-4xl tracking-[0.3em] opacity-30">OT</div>
        <div className="text-xs">Press Ctrl+K and type a ticker to begin</div>
      </div>
    )
  }

  const ticker = selected.split(':').slice(1).join(':')
  const pct = q?.change_pct ?? null
  const up = (pct ?? 0) >= 0
  const lo = q?.day_low ?? null
  const hi = q?.day_high ?? null
  const last = q?.last ?? null
  const pos =
    last !== null && lo !== null && hi !== null && hi > lo
      ? ((last - lo) / (hi - lo)) * 100
      : null

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg)]">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-[var(--border)] px-4 py-3">
        <div>
          <div className="text-lg font-bold tracking-wide">{ticker}</div>
          <div className="text-[11px] text-[var(--dim)]">{selected}</div>
        </div>
        <div className={`text-3xl font-semibold tabular-nums ${up ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>
          {fmt(last)}
        </div>
        <div className={`pb-1 tabular-nums ${up ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>
          {pct === null ? '' : `${up ? '+' : ''}${pct.toFixed(2)}%`}
        </div>
        <div className="ml-auto flex gap-1 pb-0.5">
          <button
            onClick={() => openTicket('buy')}
            className="rounded bg-[var(--up)] px-3 py-1 text-xs font-bold text-black hover:opacity-90"
          >
            B
          </button>
          <button
            onClick={() => openTicket('sell')}
            className="rounded bg-[var(--down)] px-3 py-1 text-xs font-bold text-black hover:opacity-90"
          >
            S
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-x-6 gap-y-2 border-b border-[var(--border)] px-4 py-2 text-sm md:grid-cols-6">
        <Stat label="Open" value={fmt(q?.open)} />
        <Stat label="High" value={fmt(q?.day_high)} />
        <Stat label="Low" value={fmt(q?.day_low)} />
        <Stat label="Prev Close" value={fmt(q?.prev_close)} />
        <Stat label="Volume" value={fmt(q?.volume, 0)} />
        <Stat label="Bid × Ask" value={`${fmt(q?.bid)} × ${fmt(q?.ask)}`} />
      </div>

      {pos !== null && (
        <div className="mx-4 mt-2">
          <div className="relative h-1 rounded bg-gradient-to-r from-[var(--down)]/40 via-[var(--amber)]/40 to-[var(--up)]/40">
            <div
              className="absolute -top-[3px] h-[7px] w-[7px] rounded-full border border-black bg-white"
              style={{ left: `calc(${Math.min(98, Math.max(0, pos))}% - 3px)` }}
            />
          </div>
          <div className="mt-0.5 flex justify-between text-[10px] text-[var(--dim)]">
            <span>{fmt(lo)}</span>
            <span>day range</span>
            <span>{fmt(hi)}</span>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 p-1">
        <ChartPanel />
      </div>
    </div>
  )
}
