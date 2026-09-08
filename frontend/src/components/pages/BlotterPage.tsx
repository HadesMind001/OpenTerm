import React from "react"
import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ClipboardList,
  Clock,
  Inbox,
  Pencil,
  Receipt,
  Search,
  X,
} from 'lucide-react'
import { api } from '../../lib/api'
import { useStore } from '../../state/store'
import type { FillRow, Order } from '../../lib/types'

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: d })
}

function clock(unix: number | null | undefined): string {
  return unix
    ? new Date(unix * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—'
}

function ago(unix: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function tickerOf(key: string): string {
  return key.split(':').pop() ?? key
}

function StatCard({
  icon,
  label,
  value,
  color = 'var(--text)',
}: {
  icon: React.ReactNode
  label: string
  value: string
  color?: string
}) {
  return (
    <div className="flex items-center gap-3 rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2.5">
      <span className="rounded bg-[var(--panel2)] p-1.5 text-[var(--amber)]">{icon}</span>
      <div className="min-w-0">
        <div className="text-[9px] uppercase tracking-wider text-[var(--dim)]">{label}</div>
        <div className="truncate text-lg font-semibold tabular-nums" style={{ color }}>
          {value}
        </div>
      </div>
    </div>
  )
}

function SidePill({ side }: { side: string }) {
  const buy = side === 'buy'
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
        buy ? 'bg-[var(--up)]/15 text-[var(--up)]' : 'bg-[var(--down)]/15 text-[var(--down)]'
      }`}
    >
      {buy ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
      {side}
    </span>
  )
}


export function BlotterPage() {
  const fillTick = useStore((s) => s.fillTick)
  const pushToast = useStore((s) => s.pushToast)
  const openTicket = useStore((s) => s.openTicket)

  const [working, setWorking] = useState<Order[]>([])
  const [history, setHistory] = useState<Order[]>([])
  const [fills, setFills] = useState<FillRow[]>([])
  const [search, setSearch] = useState('')
  const [sideFilter, setSideFilter] = useState<'ALL' | 'buy' | 'sell'>('ALL')
  const [amendingId, setAmendingId] = useState<number | null>(null)
  const [draftQty, setDraftQty] = useState('')
  const [draftLmt, setDraftLmt] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    const reload = () => {
      void api.orders('working').then(setWorking).catch(() => undefined)
      void api
        .orders()
        .then((rows) =>
          setHistory(rows.filter((r) => r.status !== 'working')),
        )
        .catch(() => undefined)
      void api.fills(150).then(setFills).catch(() => undefined)
    }
    reload()
    const id = window.setInterval(reload, 5000)
    return () => window.clearInterval(id)
  }, [fillTick])

  const matches = (key: string, side: string) =>
    (!search || tickerOf(key).toUpperCase().includes(search.toUpperCase())) &&
    (sideFilter === 'ALL' || side === sideFilter)

  const workingRows = useMemo(
    () => working.filter((o) => matches(o.symbol_key, o.side)),
    [working, search, sideFilter],
  )
  const fillRows = useMemo(
    () => fills.filter((f) => matches(f.symbol_key, f.side)),
    [fills, search, sideFilter],
  )

  const stats = useMemo(() => {
    const filled = history.filter((o) => o.status === 'filled').length
    const canceled = history.filter((o) => o.status === 'canceled').length
    const notional = fills.reduce((a, f) => a + f.qty * f.price, 0)
    const fees = fills.reduce((a, f) => a + f.fee, 0)
    return { filled, canceled, notional, fees }
  }, [history, fills])

  const startAmend = (o: Order) => {
    setAmendingId(o.id)
    setDraftQty(String(o.qty))
    setDraftLmt(o.limit_price?.toString() ?? '')
  }

  const cancelAmend = () => setAmendingId(null)

  const saveAmend = async (o: Order) => {
    setBusyId(o.id)
    try {
      await api.amendOrder(o.id, {
        ...(parseFloat(draftQty) && parseFloat(draftQty) !== o.qty
          ? { qty: parseFloat(draftQty) }
          : {}),
        ...(parseFloat(draftLmt) && parseFloat(draftLmt) !== o.limit_price
          ? { limit_price: parseFloat(draftLmt) }
          : {}),
      })
      pushToast('info', `order #${o.id} amended`)
      setAmendingId(null)
    } catch (err) {
      pushToast('error', String(err instanceof Error ? err.message : err).slice(0, 120))
    } finally {
      setBusyId(null)
    }
  }

  const kill = async (o: Order) => {
    setBusyId(o.id)
    try {
      await api.cancelOrder(o.id)
      pushToast('info', `order #${o.id} canceled`)
    } catch (err) {
      pushToast('error', String(err instanceof Error ? err.message : err).slice(0, 120))
    } finally {
      setBusyId(null)
    }
  }

  const TH = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th
      className={`px-2 py-1.5 font-normal ${right ? 'text-right' : 'text-left'} text-[9px] uppercase tracking-wider text-[var(--dim)]`}
    >
      {children}
    </th>
  )

  return (
    <div className="mx-auto h-full max-w-6xl overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ClipboardList size={16} className="text-[var(--amber)]" />
        <h2 className="text-sm font-bold uppercase tracking-widest">Blotter</h2>
        <button
          onClick={() => openTicket('buy')}
          className="ml-auto rounded border border-[var(--border)] px-2.5 py-1 text-[11px] uppercase tracking-wider text-[var(--dim)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
        >
          + new order
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard
          icon={<Clock size={14} />}
          label="Working"
          value={String(working.length)}
          color="var(--amber)"
        />
        <StatCard
          icon={<CheckCircle2 size={14} />}
          label="Filled"
          value={String(stats.filled)}
          color="var(--up)"
        />
        <StatCard
          icon={<Ban size={14} />}
          label="Canceled"
          value={String(stats.canceled)}
          color="var(--dim)"
        />
        <StatCard
          icon={<Receipt size={14} />}
          label="Traded · fees"
          value={`$${fmt(stats.notional, 0)} · $${fmt(stats.fees)}`}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs">
        <Search size={13} className="text-[var(--dim)]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="filter symbol…"
          className="w-32 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 outline-none placeholder:text-[var(--dim)] focus:border-[var(--amber)]"
        />
        <div className="flex overflow-hidden rounded border border-[var(--border)]">
          {(['ALL', 'buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSideFilter(s)}
              className={`px-2.5 py-1 uppercase text-[11px] ${
                sideFilter === s
                  ? 'bg-[var(--amber)] font-bold text-black'
                  : 'text-[var(--dim)] hover:text-[var(--text)]'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        {(search || sideFilter !== 'ALL') && (
          <button
            onClick={() => {
              setSearch('')
              setSideFilter('ALL')
            }}
            className="flex items-center gap-1 text-[11px] text-[var(--dim)] hover:text-[var(--down)]"
          >
            <X size={11} /> clear
          </button>
        )}
        <span className="ml-auto text-[10px] text-[var(--dim)]">
          auto-refreshes on every fill
        </span>
      </div>

      <section className="mb-5">
        <h3 className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--amber)]">
          Working orders
          <span className="rounded-full bg-[var(--amber)]/15 px-1.5 text-[var(--amber)]">
            {workingRows.length}
          </span>
        </h3>
        <div className="overflow-x-auto rounded border border-[var(--border)] bg-[var(--panel)]">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <TH>#</TH>
                <TH>symbol</TH>
                <TH>side</TH>
                <TH>type</TH>
                <TH right>qty</TH>
                <TH right>limit</TH>
                <TH right>stop</TH>
                <TH>tif</TH>
                <TH>placed</TH>
                <TH right>actions</TH>
              </tr>
            </thead>
            <tbody>
              {workingRows.map((o) => (
                <tr key={o.id} className="border-b border-[var(--border)]/40 hover:bg-[var(--panel2)]">
                  <td className="px-2 py-1.5 text-[var(--dim)]">#{o.id}</td>
                  <td className="px-2 py-1.5 font-semibold">{tickerOf(o.symbol_key)}</td>
                  <td className="px-2 py-1.5">
                    <SidePill side={o.side} />
                  </td>
                  <td className="px-2 py-1.5 uppercase text-[var(--dim)]">{o.otype.replace('_', '-')}</td>
                  {amendingId === o.id ? (
                    <>
                      <td className="px-2 py-1.5 text-right">
                        <input
                          autoFocus
                          value={draftQty}
                          onChange={(e) => setDraftQty(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && void saveAmend(o)}
                          className="w-16 rounded border border-[var(--amber)] bg-[var(--bg)] px-1 py-0.5 text-right outline-none"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <input
                          value={draftLmt}
                          onChange={(e) => setDraftLmt(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && void saveAmend(o)}
                          placeholder="—"
                          className="w-20 rounded border border-[var(--amber)] bg-[var(--bg)] px-1 py-0.5 text-right outline-none"
                        />
                      </td>
                      <td colSpan={5} className="px-2 py-1.5 text-right">
                        <button
                          onClick={() => void saveAmend(o)}
                          disabled={busyId === o.id}
                          className="mr-1 rounded bg-[var(--amber)] px-2 py-0.5 text-[10px] font-bold text-black"
                        >
                          {busyId === o.id ? '…' : 'save'}
                        </button>
                        <button
                          onClick={cancelAmend}
                          className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px]"
                        >
                          esc
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-2 py-1.5 text-right">{fmt(o.qty)}</td>
                      <td className="px-2 py-1.5 text-right text-[#38bdf8]">
                        {fmt(o.limit_price)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-[#fb923c]">
                        {fmt(o.stop_price)}
                      </td>
                      <td className="px-2 py-1.5 uppercase text-[var(--dim)]">{o.tif}</td>
                      <td className="px-2 py-1.5 text-[var(--dim)]" title={clock(o.created)}>
                        {ago(o.created)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">
                        <button
                          onClick={() => startAmend(o)}
                          title="amend"
                          className="mr-1 rounded border border-[var(--border)] p-1 text-[var(--dim)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={() => void kill(o)}
                          disabled={busyId === o.id}
                          title="cancel order"
                          className="rounded border border-[var(--border)] p-1 text-[var(--dim)] hover:border-[var(--down)] hover:text-[var(--down)] disabled:opacity-30"
                        >
                          <X size={11} />
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {!workingRows.length && (
                <tr>
                  <td colSpan={10} className="py-6 text-center text-[var(--dim)]">
                    no working orders{search || sideFilter !== 'ALL' ? ' match the filter' : ''}
                    {' — '}
                    <span className="text-[var(--amber)]">Ctrl+K → ticker, or B/S on a chart</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--dim)]">
          <Receipt size={11} /> Fill history
          <span className="rounded-full bg-[var(--border)]/40 px-1.5">{fillRows.length}</span>
        </h3>
        <div className="max-h-[420px] overflow-y-auto rounded border border-[var(--border)] bg-[var(--panel)]">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 bg-[var(--panel)]">
              <tr className="border-b border-[var(--border)]">
                <TH>time</TH>
                <TH>symbol</TH>
                <TH>side</TH>
                <TH right>qty</TH>
                <TH right>price</TH>
                <TH right>notional</TH>
                <TH right>fee</TH>
                <TH right>order</TH>
              </tr>
            </thead>
            <tbody>
              {fillRows.map((f) => (
                <tr key={f.id} className="border-b border-[var(--border)]/30 hover:bg-[var(--panel2)]">
                  <td className="px-2 py-1 text-[var(--dim)]" title={ago(f.ts)}>
                    {clock(f.ts)}
                  </td>
                  <td className="px-2 py-1 font-semibold">{tickerOf(f.symbol_key)}</td>
                  <td className="px-2 py-1">
                    <SidePill side={f.side} />
                  </td>
                  <td className="px-2 py-1 text-right">{fmt(f.qty)}</td>
                  <td className={`px-2 py-1 text-right ${f.side === 'buy' ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>
                    {fmt(f.price)}
                  </td>
                  <td className="px-2 py-1 text-right text-[var(--dim)]">
                    ${fmt(f.qty * f.price, 0)}
                  </td>
                  <td className="px-2 py-1 text-right text-[var(--dim)]">${fmt(f.fee)}</td>
                  <td className="px-2 py-1 text-right text-[var(--dim)]">#{f.order_id}</td>
                </tr>
              ))}
              {!fillRows.length && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-[var(--dim)]">
                    <Inbox size={16} className="mx-auto mb-1 opacity-50" /> no fills yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
