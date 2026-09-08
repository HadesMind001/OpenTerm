import { useEffect, useMemo, useState } from 'react'
import { Activity, CalendarDays, Gauge as GaugeIcon, Globe, Landmark } from 'lucide-react'
import { api } from '../../lib/api'
import { useStore } from '../../state/store'
import type {
  CalendarInfo,
  MacroInfo,
  SettingsInfo,
  UniverseRow,
} from '../../lib/types'

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: d })
}

function fmtBig(n: number | null | undefined): string {
  if (!n) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  return n.toFixed(0)
}

const INDEX_ROWS = ['SPY', 'QQQ', 'DIA', 'GLD', 'TLT']

function zoneOf(score: number): [string, string] {
  if (score < 20) return ['extreme fear', 'var(--down)']
  if (score < 40) return ['fear', '#fb923c']
  if (score < 60) return ['neutral', 'var(--dim)']
  if (score < 80) return ['greed', '#a3e635']
  return ['extreme greed', 'var(--up)']
}

function PulseGauge({ score }: { score: number }) {
  const angle = Math.PI * (1 - score / 100)
  const cx = 110
  const cy = 100
  const r = 78
  const nx = cx + Math.cos(angle) * (r - 12)
  const ny = cy - Math.sin(angle) * (r - 12)
  const arc = (from: number, to: number, color: string) => {
    const a1 = Math.PI * (1 - from / 100)
    const a2 = Math.PI * (1 - to / 100)
    const x1 = cx + Math.cos(a1) * r
    const y1 = cy - Math.sin(a1) * r
    const x2 = cx + Math.cos(a2) * r
    const y2 = cy - Math.sin(a2) * r
    return (
      <path
        key={`${from}-${to}`}
        d={`M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}`}
        stroke={color}
        strokeWidth="14"
        fill="none"
        opacity="0.85"
      />
    )
  }
  return (
    <svg viewBox="0 0 220 118" className="w-52">
      {arc(0, 20, 'var(--down)')}
      {arc(20, 40, '#fb923c')}
      {arc(40, 60, '#64748b')}
      {arc(60, 80, '#a3e635')}
      {arc(80, 100, 'var(--up)')}
      <line
        x1={cx}
        y1={cy}
        x2={nx}
        y2={ny}
        stroke="var(--text)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx={cx} cy={cy} r="5" fill="var(--amber)" />
      <text x={cx} y={cy - 26} textAnchor="middle" fontSize="26" fontWeight="bold" fill="var(--text)">
        {score.toFixed(0)}
      </text>
    </svg>
  )
}

export function PulsePage() {
  const select = useStore((s) => s.select)
  const setPage = useStore((s) => s.setPage)
  const [rows, setRows] = useState<UniverseRow[]>([])
  const [settings, setSettings] = useState<SettingsInfo | null>(null)
  const [macro, setMacro] = useState<MacroInfo | null>(null)
  const [calendar, setCalendar] = useState<CalendarInfo | null>(null)

  useEffect(() => {
    const load = () => void api.universe().then(setRows).catch(() => undefined)
    load()
    void api.settings().then(setSettings).catch(() => undefined)
    void api.macro().then(setMacro).catch(() => undefined)
    void api.calendar().then(setCalendar).catch(() => undefined)
    const id = window.setInterval(load, 5000)
    return () => window.clearInterval(id)
  }, [])

  const stats = useMemo(() => {
    const withChg = rows.filter((r) => r.change_pct !== null && !INDEX_ROWS.includes(r.ticker))
    const breadth =
      withChg.length > 0
        ? withChg.filter((r) => (r.change_pct ?? 0) > 0).length / withChg.length
        : 0.5
    const momentum =
      withChg.length > 0
        ? withChg.reduce((a, r) => a + (r.change_pct ?? 0), 0) / withChg.length
        : 0
    const score = Math.max(
      0,
      Math.min(100, 50 + momentum * 10 + (breadth - 0.5) * 40),
    )
    const crypto = rows.filter((r) => r.asset_class === 'CRYPTO')
    const btcNotional =
      crypto.find((r) => r.ticker === 'BTCUSDT')?.notional ?? 0
    const cryptoTotal = crypto.reduce((a, r) => a + (r.notional ?? 0), 0)
    const dominance = cryptoTotal > 0 ? (btcNotional / cryptoTotal) * 100 : null
    const gainers = [...withChg]
      .sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0))
      .slice(0, 4)
    const losers = [...withChg]
      .sort((a, b) => (a.change_pct ?? 0) - (b.change_pct ?? 0))
      .slice(0, 4)
    return { breadth, momentum, score, dominance, gainers, losers }
  }, [rows])

  const indices = rows.filter((r) => INDEX_ROWS.includes(r.ticker))
  const [zoneLabel, zoneColor] = zoneOf(stats.score)

  const open = async (ticker: string) => {
    const res = await api.resolve(ticker)
    if (res) select(res.symbol_key)
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-widest text-[var(--amber)]">
        <GaugeIcon size={14} /> Market Pulse
      </div>

      <div className="grid gap-3 lg:grid-cols-[auto_1fr_1fr]">
        <div className="flex flex-col items-center rounded border border-[var(--border)] bg-[var(--panel)] p-3">
          <PulseGauge score={stats.score} />
          <div className="text-sm font-bold uppercase tracking-wider" style={{ color: zoneColor }}>
            {zoneLabel}
          </div>
          <div className="mt-1 text-center text-[10px] leading-tight text-[var(--dim)]">
            computed from universe breadth ({(stats.breadth * 100).toFixed(0)}% up)
            <br />
            and average momentum ({stats.momentum >= 0 ? '+' : ''}
            {stats.momentum.toFixed(2)}%)
          </div>
        </div>

        <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)]">
            <Globe size={11} /> Indices &amp; macro proxies
          </div>
          {indices.map((r) => (
            <button
              key={r.symbol_key}
              onClick={() => void open(r.ticker)}
              className="flex w-full items-center justify-between rounded px-1 py-1 text-xs hover:bg-[var(--panel2)]"
            >
              <span className="font-semibold">{r.ticker}</span>
              <span className="tabular-nums">{fmt(r.last)}</span>
              <span
                className={`w-16 text-right tabular-nums ${
                  (r.change_pct ?? 0) >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'
                }`}
              >
                {(r.change_pct ?? 0) >= 0 ? '+' : ''}
                {(r.change_pct ?? 0).toFixed(2)}%
              </span>
            </button>
          ))}
          {!indices.length && (
            <div className="py-3 text-center text-xs text-[var(--dim)]">
              waiting for quotes…
            </div>
          )}
          {stats.dominance !== null && (
            <div className="mt-3 border-t border-[var(--border)] pt-2">
              <div className="mb-1 flex justify-between text-[10px] text-[var(--dim)]">
                <span>BTC dominance (volume proxy)</span>
                <span className="tabular-nums text-[var(--amber)]">
                  {stats.dominance.toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-[var(--border)]">
                <div
                  className="h-full bg-[var(--amber)]"
                  style={{ width: `${stats.dominance}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)]">
            <Activity size={11} /> Movers
          </div>
          {[...stats.gainers, ...stats.losers].map((r) => (
            <button
              key={r.symbol_key}
              onClick={() => void open(r.ticker)}
              className="flex w-full items-center justify-between rounded px-1 py-0.5 text-xs hover:bg-[var(--panel2)]"
            >
              <span className="font-semibold">{r.ticker}</span>
              <span className="tabular-nums text-[var(--dim)]">
                vol ${fmtBig(r.notional)}
              </span>
              <span
                className={`w-16 text-right tabular-nums ${
                  (r.change_pct ?? 0) >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'
                }`}
              >
                {(r.change_pct ?? 0) >= 0 ? '+' : ''}
                {(r.change_pct ?? 0).toFixed(2)}%
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {macro?.available && Object.keys(macro.series).length > 0 && (
          <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)]">
              <Landmark size={11} /> Macro (FRED)
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {Object.entries(macro.series).map(([sid, s]) => {
                const hist = s.history.map((h) => h[1])
                const lo = Math.min(...hist)
                const hi = Math.max(...hist)
                const span = hi - lo || 1
                const pts = hist
                  .map(
                    (v, i) =>
                      `${(i / Math.max(1, hist.length - 1)) * 90},${
                        22 - ((v - lo) / span) * 18
                      }`,
                  )
                  .join(' ')
                return (
                  <div key={sid} className="rounded border border-[var(--border)] p-2">
                    <div className="truncate text-[9px] uppercase text-[var(--dim)]">
                      {s.label}
                    </div>
                    <div className="text-base font-semibold tabular-nums">
                      {fmt(s.value)}
                    </div>
                    <svg viewBox="0 0 90 24" className="mt-0.5 w-full">
                      <polyline points={pts} fill="none" stroke="var(--amber)" strokeWidth="1.5" />
                    </svg>
                    <div className="text-[9px] text-[var(--dim)]">{s.date}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {calendar?.available && calendar.earnings.length > 0 && (
          <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)]">
              <CalendarDays size={11} /> Earnings ahead (Finnhub)
            </div>
            <table className="w-full text-xs tabular-nums">
              <tbody>
                {calendar.earnings.slice(0, 8).map((e, i) => (
                  <tr key={i} className="border-b border-[var(--border)]/30">
                    <td className="py-0.5 pr-3 font-semibold">{e.symbol}</td>
                    <td className="py-0.5 pr-3 text-[var(--dim)]">{e.date}</td>
                    <td className="py-0.5 text-right">
                      eps est {e.epsEstimate != null ? fmt(e.epsEstimate) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-3 rounded border border-[var(--border)] bg-[var(--panel)] p-3 text-[11px]">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="uppercase tracking-wider text-[var(--dim)]">
            Data sources
          </span>
          <button
            onClick={() => setPage('screen')}
            className="text-[var(--amber)] hover:underline"
          >
            explore screener →
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {['binance', 'yahoo', 'gnews'].map((n) => (
            <span
              key={n}
              className="rounded bg-[var(--up)]/15 px-2 py-0.5 font-bold text-[var(--up)]"
            >
              {n} ✓
            </span>
          ))}
          {settings &&
            Object.entries(settings.available).map(([name, on]) => (
              <span
                key={name}
                title={on ? '' : settings.note}
                className={`rounded px-2 py-0.5 ${
                  on
                    ? 'bg-[var(--up)]/15 font-bold text-[var(--up)]'
                    : 'bg-[var(--border)]/40 text-[var(--dim)]'
                }`}
              >
                {name} {on ? '✓' : '— no key'}
              </span>
            ))}
        </div>
        {settings && (
          <div className="mt-1.5 text-[10px] text-[var(--dim)]">
            add keys via env vars or {settings.config_path} then restart — unlocks
            fundamentals, earnings, macro, FX streaming &amp; deeper history
          </div>
        )}
      </div>
    </div>
  )
}
