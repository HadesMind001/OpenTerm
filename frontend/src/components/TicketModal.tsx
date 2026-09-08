import { useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../state/store'
import { useQuote } from '../state/hooks'
import type { OrderType } from '../lib/types'

const TYPES: OrderType[] = ['market', 'limit', 'stop', 'stop_limit']

export function TicketModal() {
  const open = useStore((s) => s.ticketOpen)
  const closeTicket = useStore((s) => s.closeTicket)
  const pushToast = useStore((s) => s.pushToast)
  const selected = useStore((s) => s.selected)
  const q = useQuote(selected ?? '')

  const [qty, setQty] = useState('1')
  const [type, setType] = useState<OrderType>('market')
  const [limitPrice, setLimitPrice] = useState('')
  const [stopPrice, setStopPrice] = useState('')
  const alpacaReady = useStore((s) => s.alpacaReady)
  const [venue, setVenue] = useState<'paper' | 'alpaca'>('paper')
  const isEquity = selected?.startsWith('EQUITY:') ?? false

  if (!open || !selected) return null
  const side = open
  const effectiveVenue = isEquity && venue === 'alpaca' ? 'alpaca' : 'paper'

  const submit = async () => {
    try {
      const body = {
        symbol_key: selected,
        side,
        type,
        qty: parseFloat(qty),
        ...(type === 'limit' || type === 'stop_limit'
          ? { limit_price: parseFloat(limitPrice) }
          : {}),
        ...(type === 'stop' || type === 'stop_limit'
          ? { stop_price: parseFloat(stopPrice) }
          : {}),
        venue,
      }
      const res = await api.submitOrder({ ...body, venue: effectiveVenue })
      pushToast(
        'info',
        res.status === 'filled'
          ? `${side} ${qty} filled @ ${res.avg_fill?.toFixed(2)}`
          : `${side} order working (${type})`,
      )
      closeTicket()
    } catch (err) {
      pushToast('error', String(err instanceof Error ? err.message : err).slice(0, 120))
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={closeTicket}
    >
      <div
        className="w-80 rounded border border-[var(--border)] bg-[var(--panel)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="font-bold">
            <span className={side === 'buy' ? 'text-[var(--up)]' : 'text-[var(--down)]'}>
              {side.toUpperCase()}
            </span>{' '}
            {selected.split(':').pop()}
          </span>
          <span className="tabular-nums text-[var(--dim)]">
            last {q?.last?.toFixed(2) ?? '—'}
          </span>
          <button onClick={closeTicket} className="text-[var(--dim)] hover:text-[var(--text)]">
            <X size={14} />
          </button>
        </div>
        <label className="block text-[10px] uppercase text-[var(--dim)]">Quantity</label>
        <input
          autoFocus
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="mb-2 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 tabular-nums outline-none focus:border-[var(--amber)]"
        />
        <label className="block text-[10px] uppercase text-[var(--dim)]">Type</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as OrderType)}
          className="mb-2 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 outline-none"
        >
          {TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        {(type === 'limit' || type === 'stop_limit') && (
          <>
            <label className="block text-[10px] uppercase text-[var(--dim)]">Limit price</label>
            <input
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder={(q?.last ?? 0).toFixed(2)}
              className="mb-2 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 tabular-nums outline-none focus:border-[var(--amber)]"
            />
          </>
        )}
        {(type === 'stop' || type === 'stop_limit') && (
          <>
            <label className="block text-[10px] uppercase text-[var(--dim)]">Stop price</label>
            <input
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
              placeholder={(q?.last ?? 0).toFixed(2)}
              className="mb-2 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 tabular-nums outline-none focus:border-[var(--amber)]"
            />
          </>
        )}
        {isEquity && alpacaReady && (
          <div className="mb-2 flex items-center gap-1.5">
            {(['paper', 'alpaca'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setVenue(v)}
                className={`flex-1 rounded border py-1 text-[9px] font-bold uppercase tracking-wider ${
                  effectiveVenue === v
                    ? 'border-[var(--amber)] text-[var(--amber)]'
                    : 'border-[var(--border)] text-[var(--dim)]'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => void submit()}
          className={`mt-1 w-full rounded py-1.5 font-bold ${
            side === 'buy'
              ? 'bg-[var(--up)] text-black'
              : 'bg-[var(--down)] text-black'
          }`}
        >
          Submit {side.toUpperCase()}
        </button>
        <div className="mt-2 text-center text-[10px] text-[var(--dim)]">
          {effectiveVenue === 'alpaca'
            ? 'alpaca paper account · real market fills'
            : 'paper account · slippage + commission applied'}
        </div>
      </div>
    </div>
  )
}
