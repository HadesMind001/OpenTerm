import { useEffect, useState } from 'react'
import { Building2, Landmark } from 'lucide-react'
import { api } from '../../lib/api'
import { useStore } from '../../state/store'
import { badge } from '../../lib/sentiment'
import type { DesInfo, NewsRow } from '../../lib/types'

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: d })
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-[var(--dim)]">{label}</div>
      <div className="text-sm tabular-nums">{value}</div>
    </div>
  )
}

export function ResearchPage() {
  const selected = useStore((s) => s.selected)
  const select = useStore((s) => s.select)
  const [des, setDes] = useState<DesInfo | null>(null)
  const [news, setNews] = useState<NewsRow[]>([])

  useEffect(() => {
    if (!selected) {
      setDes(null)
      return
    }
    let alive = true
    void api.des(selected).then(setDes).catch(() => undefined)
    const loadNews = () =>
      void api
        .news(selected)
        .then((rows) => alive && setNews(rows))
        .catch(() => undefined)
    loadNews()
    const id = window.setInterval(loadNews, 30000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [selected])

  if (!selected || !des) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--dim)]">
        select a symbol to view its research page (verb: DES)
      </div>
    )
  }

  const st = des.state
  const ex = des.extra ?? {}
  const funda = (ex as Record<string, unknown>).fundamentals as
    | Record<string, number>
    | undefined
  const profile = (ex as Record<string, unknown>).finnhub_profile as
    | Record<string, string | number>
    | undefined
  const lo52 = ex.week52_low
  const hi52 = ex.week52_high
  const last = st.last ?? null
  const pos =
    last !== null && lo52 && hi52 && hi52 > lo52
      ? ((last - lo52) / (hi52 - lo52)) * 100
      : null

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-4">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-1">
        <Building2 size={22} className="mb-1 text-[var(--amber)]" />
        <div>
          <div className="text-xl font-bold">
            {des.ticker}
            <span className="ml-2 text-xs font-normal text-[var(--dim)]">
              {ex.full_name ?? ''}
            </span>
          </div>
          <div className="text-[10px] text-[var(--dim)]">
            {[des.asset_class, ex.exchange, ex.currency].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className={`ml-auto text-2xl font-semibold tabular-nums ${((st.change_pct ?? 0) >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}`}>
          {fmt(last)}
          {st.change_pct !== null && st.change_pct !== undefined && (
            <span className="ml-2 text-sm">
              {st.change_pct >= 0 ? '+' : ''}
              {st.change_pct.toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3 rounded border border-[var(--border)] bg-[var(--panel)] p-3 md:grid-cols-5">
        <Cell label="day high" value={fmt(st.day_high)} />
        <Cell label="day low" value={fmt(st.day_low)} />
        <Cell label="prev close" value={fmt(st.prev_close)} />
        <Cell label="volume" value={fmt(st.volume, 0)} />
        <Cell label="year return" value={ex.year_return_pct != null ? `${ex.year_return_pct}%` : '—'} />
      </div>

      {pos !== null && hi52 && lo52 && (
        <div className="mt-3">
          <div className="relative h-1.5 rounded bg-gradient-to-r from-[var(--down)]/40 via-[var(--amber)]/30 to-[var(--up)]/40">
            <div
              className="absolute -top-[4px] h-[9px] w-[9px] rounded-full border border-black bg-white"
              style={{ left: `calc(${Math.min(99, Math.max(0, pos))}% - 4px)` }}
            />
          </div>
          <div className="mt-0.5 flex justify-between text-[10px] text-[var(--dim)] tabular-nums">
            <span>52w low {fmt(lo52)}</span>
            <span>{pos.toFixed(0)}% of range</span>
            <span>52w high {fmt(hi52)}</span>
          </div>
        </div>
      )}

      {(funda || profile) && (
        <div className="mt-3 rounded border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--dim)]">
            Fundamentals {profile ? '· Finnhub' : ''}
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-xs tabular-nums md:grid-cols-5">
            {funda &&
              Object.entries({
                'P/E': funda.pe,
                'EPS TTM': funda.eps_ttm,
                Beta: funda.beta,
                'Div yield %': funda.div_yield,
                'Mkt cap $M': funda.market_cap_m,
                '52w high': funda.week52_high,
                '52w low': funda.week52_low,
                'Target avg': funda.target_avg,
              })
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => (
                  <div key={k}>
                    <span className="text-[9px] uppercase text-[var(--dim)]">{k}</span>
                    <div>{fmt(v as number)}</div>
                  </div>
                ))}
            {profile && typeof profile.country === 'string' && (
              <div>
                <span className="text-[9px] uppercase text-[var(--dim)]">country</span>
                <div>{profile.country}</div>
              </div>
            )}
            {profile && typeof profile.ipo === 'string' && (
              <div>
                <span className="text-[9px] uppercase text-[var(--dim)]">IPO</span>
                <div>{profile.ipo}</div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <Landmark size={12} className="text-[var(--dim)]" />
        <span className="mr-1 text-[10px] uppercase tracking-wider text-[var(--dim)]">peers</span>
        {des.peers.map((p) => (
          <button
            key={p}
            onClick={() => {
              void api.resolve(p).then((r) => r && select(r.symbol_key))
            }}
            className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--dim)] hover:border-[var(--amber)] hover:text-[var(--text)]"
          >
            {p}
          </button>
        ))}
      </div>

      {(des.journal.length > 0 || des.recent_fires.length > 0) && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {des.journal.length > 0 && (
            <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-2">
              <div className="mb-1 text-[9px] uppercase tracking-wider text-[var(--dim)]">journal</div>
              {des.journal.map((j) => (
                <div key={j.id} className="py-0.5 text-xs">
                  • {j.text}
                </div>
              ))}
            </div>
          )}
          {des.recent_fires.length > 0 && (
            <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-2">
              <div className="mb-1 text-[9px] uppercase tracking-wider text-[var(--dim)]">recent alert fires</div>
              {des.recent_fires.map((f) => (
                <div key={f.id} className="flex justify-between py-0.5 text-xs tabular-nums">
                  <span className="uppercase text-[var(--dim)]">{f.kind}</span>
                  <span>@ {fmt(f.price)}</span>
                  <span className="text-[var(--dim)]">
                    {new Date(f.ts * 1000).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mb-1 mt-5 text-[10px] uppercase tracking-wider text-[var(--dim)]">
        News — sentiment tagged
      </div>
      <div className="space-y-1">
        {news.map((n, i) => {
          const b = badge(n.sentiment)
          return (
            <a
              key={i}
              href={n.url || '#'}
              target="_blank"
              rel="noreferrer"
              className="block rounded border border-[var(--border)]/40 px-3 py-1.5 text-xs leading-snug hover:bg-[var(--panel2)]"
            >
              <span style={{ color: b.color }} className="mr-2">
                {b.icon}
              </span>
              <span className="mr-2 text-[10px] text-[var(--amber)]">
                {n.source || 'news'}
              </span>
              {n.headline}
            </a>
          )
        })}
        {!news.length && (
          <div className="py-3 text-center text-xs text-[var(--dim)]">no headlines yet</div>
        )}
      </div>
    </div>
  )
}
