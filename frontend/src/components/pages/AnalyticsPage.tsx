import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../state/store'
import type { Analytics } from '../../lib/types'

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: d })
}

function EquityCurve({ points, dds }: { points: [number, number][]; dds: [number, number][] }) {
  if (points.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-[var(--dim)]">
        collecting equity samples… (every 30s)
      </div>
    )
  }
  const W = 800
  const H = 180
  const DDH = 70
  const lo = Math.min(...points.map((p) => p[1]))
  const hi = Math.max(...points.map((p) => p[1]))
  const span = hi - lo || 1
  const x = (i: number, len: number) => (i / Math.max(1, len - 1)) * W
  const y = (v: number) => H - 8 - ((v - lo) / span) * (H - 20)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i, points.length)} ${y(p[1])}`).join(' ')
  const area = `${path} L${W} ${H} L0 ${H} Z`
  const minDD = Math.min(-1e-9, ...dds.map((d) => d[1]))
  const dy = (d: number) => 10 + (d / minDD) * (DDH - 18)
  const ddPath = dds
    .map((p, i) => `${i ? 'L' : 'M'}${x(i, dds.length)} ${dy(p[1])}`)
    .join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H + DDH}`} className="w-full">
      <path d={area} fill="var(--amber)" opacity="0.08" />
      <path d={path} fill="none" stroke="var(--amber)" strokeWidth="1.5" />
      <text x={4} y={12} fontSize="10" fill="var(--dim)">
        {fmt(lo)} — {fmt(hi)}
      </text>
      <g transform={`translate(0 ${H})`}>
        <path d={ddPath} fill="none" stroke="var(--down)" strokeWidth="1" opacity="0.7" />
        <rect x={0} y={0} width={W} height={DDH} fill="var(--down)" opacity="0.03" />
        <text x={4} y={DDH - 4} fontSize="9" fill="var(--down)" opacity="0.7">
          drawdown {Math.abs(minDD).toFixed(2)}%
        </text>
      </g>
    </svg>
  )
}

const DONUT_COLORS = ['#ffb000', '#38bdf8', '#34d399', '#f87171', '#c084fc', '#a3e635', '#fb923c']

function Donut({ positions }: { positions: { symbol_key: string; value: number | null }[] }) {
  const rows = positions
    .map((p) => ({ name: p.symbol_key.split(':').pop()!, v: p.value ?? 0 }))
    .filter((r) => r.v > 0)
    .slice(0, 6)
  const total = rows.reduce((a, r) => a + r.v, 0)
  let acc = 0
  const R = 52
  const C = 2 * Math.PI * R

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 140 140" className="h-32 w-32 shrink-0">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--border)" strokeWidth="16" />
        {rows.map((r, i) => {
          const frac = total > 0 ? r.v / total : 0
          const dash = `${frac * C} ${C}`
          const offset = -acc * C
          acc += frac
          return (
            <circle
              key={r.name}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
              strokeWidth="16"
              strokeDasharray={dash}
              strokeDashoffset={offset}
              transform="rotate(-90 70 70)"
            />
          )
        })}
        <text x="70" y="74" textAnchor="middle" fontSize="11" fill="var(--text)">
          {rows.length ? '' : 'all cash'}
        </text>
      </svg>
      <div className="space-y-1 text-[11px]">
        {rows.map((r, i) => (
          <div key={r.name} className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}
            />
            <span>{r.name}</span>
            <span className="tabular-nums text-[var(--dim)]">
              {total > 0 ? ((r.v / total) * 100).toFixed(1) : 0}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function AnalyticsPage() {
  const fillTick = useStore((s) => s.fillTick)
  const [a, setA] = useState<Analytics | null>(null)

  useEffect(() => {
    void api.analytics().then(setA).catch(() => undefined)
    const id = window.setInterval(
      () => void api.analytics().then(setA).catch(() => undefined),
      10000,
    )
    return () => window.clearInterval(id)
  }, [fillTick])

  if (!a) return <div className="p-4 text-xs text-[var(--dim)]">loading…</div>

  const cards: Array<[string, string]> = [
    ['total return', a.total_return_pct != null ? `${a.total_return_pct}%` : '—'],
    ['sharpe (ann.)', fmt(a.sharpe)],
    ['max drawdown', a.max_dd_pct != null ? `${Math.abs(a.max_dd_pct)}%` : '—'],
    ['win rate', a.win_rate != null ? `${a.win_rate}%` : '—'],
    ['profit factor', fmt(a.profit_factor)],
    ['closed trades', String(a.trades.length)],
  ]

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
        {cards.map(([label, val]) => (
          <div key={label} className="rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-[var(--dim)]">{label}</div>
            <div className="text-lg font-semibold tabular-nums">{val}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 rounded border border-[var(--border)] bg-[var(--panel)] p-2">
        <EquityCurve points={a.points} dds={a.drawdowns ?? []} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--dim)]">Allocation</div>
          <AllocationData />
        </div>
        <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--dim)]">
            Closed trades
          </div>
          <table className="w-full text-xs tabular-nums">
            <tbody>
              {a.trades.slice(0, 15).map((t, i) => (
                <tr key={i} className="border-b border-[var(--border)]/30">
                  <td className="py-0.5 pr-2">{t.symbol_key.split(':').pop()}</td>
                  <td className="py-0.5 pr-2 text-[var(--dim)]">@{fmt(t.exit)}</td>
                  <td className={`py-0.5 text-right ${t.pnl >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>
                    {t.pnl >= 0 ? '+' : ''}
                    {fmt(t.pnl)}
                  </td>
                </tr>
              ))}
              {!a.trades.length && (
                <tr>
                  <td className="py-3 text-center text-[var(--dim)]">no closed trades yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function AllocationData() {
  const [rows, setRows] = useState<{ symbol_key: string; value: number | null }[]>([])
  useEffect(() => {
    void api.portfolio().then((pf) => setRows(pf.positions))
  }, [])
  return <Donut positions={rows} />
}
