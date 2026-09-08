import { useEffect, useMemo, useRef, useState } from 'react'
import { Boxes, ChevronLeft, Layers, Settings } from 'lucide-react'
import { api } from '../../lib/api'
import { treemap } from '../../lib/squarify'
import type { TreemapRect } from '../../lib/squarify'
import { useStore } from '../../state/store'
import { readQuote, useQuotesVersion } from '../../state/hooks'
import type { UniverseRow } from '../../lib/types'
import { logoUrl } from '../../lib/logos'

const MAX_PCT = 5

const RED: [number, number, number] = [239, 68, 68]
const NEUTRAL: [number, number, number] = [51, 65, 85]
const GREEN: [number, number, number] = [34, 197, 94]

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}
function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  return `rgb(${lerp(a[0], b[0], t)},${lerp(a[1], b[1], t)},${lerp(a[2], b[2], t)})`
}
function changeColor(pct: number | null): string {
  const c = Math.max(-MAX_PCT, Math.min(MAX_PCT, pct ?? 0))
  const t = (c + MAX_PCT) / (2 * MAX_PCT)
  if (t <= 0.5) return mix(RED, NEUTRAL, t * 2)
  return mix(NEUTRAL, GREEN, (t - 0.5) * 2)
}
function textColorOn(pct: number | null): string {
  return Math.abs(pct ?? 0) > 2.2 ? '#ffffff' : '#d7dde8'
}

function fmtBig(n: number | null | undefined): string {
  if (!n) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toFixed(0)
}

type SizeBy = 'market_cap' | 'volume'

const SECTOR_HUES = [
  '#f59e0b', '#0ea5e9', '#10b981', '#ef4444', '#8b5cf6',
  '#84cc16', '#f97316', '#14b8a6', '#e11d48', '#6366f1',
]
function hueFor(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0
  return SECTOR_HUES[h % SECTOR_HUES.length]
}

interface Tile extends TreemapRect {
  group: string
  flash: 1 | -1 | 0
}
interface GroupMeta {
  label: string
  x: number
  y: number
  w: number
  h: number
  count: number
}

export function HeatmapPage() {
  const select = useStore((s) => s.select)
  const setKeysOpen = useStore((s) => s.setKeysOpen)

  const [rows, setRows] = useState<UniverseRow[]>([])
  const [hover, setHover] = useState<string | null>(null)
  const [sizeBy, setSizeBy] = useState<SizeBy>('market_cap')
  const [groupKey, setGroupKey] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 1100, h: 620 })

  useEffect(() => {
    const load = () => void api.universe().then(setRows).catch(() => undefined)
    load()
    const id = window.setInterval(load, 8000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setDims({
          w: Math.max(360, Math.floor(e.contentRect.width)),
          h: Math.max(280, Math.floor(e.contentRect.height)),
        })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // NOT useQuote-in-a-loop: calling a hook inside useMemo/filter/map breaks
  // the Rules of Hooks and React throws "rendered more hooks than during the
  // previous render" the moment the universe size changes (i.e. every 8 s
  // poll). Grid pages take a single whole-bucket version + plain proxy reads.
  const quotesVersion = useQuotesVersion()
  const live = useMemo(
    () =>
      rows
        .map((r) => {
          const q = readQuote(r.symbol_key)
          const last = q?.last ?? r.last
          return {
            ...r,
            last,
            change_pct: q?.change_pct ?? r.change_pct,
            volume: q?.volume ?? r.volume,
            _flash: q?.dir ?? ((r.change_pct ?? 0) >= 0 ? 1 : -1),
          }
        })
        .filter((r) => r.last != null && r.change_pct !== null),
    [rows, quotesVersion],
  )

  const hasSector = live.some((r) => !!r.sector)
  const hasCap = live.some((r) => !!r.market_cap_m)
  const groupMode: 'sector' | 'asset_class' =
    hasSector && !groupKey ? 'sector' : groupKey ? 'sector' : 'asset_class'

  const dataMode =
    hasCap && hasSector ? 'finnhub' : hasSector || hasCap ? 'partial' : 'fallback'

  const sizeValue = (r: (typeof live)[number]): number => {
    if (sizeBy === 'market_cap' && hasCap)
      return Math.max(r.market_cap_m ?? r.notional ?? 1, 1)
    return Math.max(r.notional ?? 1, 1)
  }
  const groupOf = (r: (typeof live)[number]): string => {
    return (groupMode === 'sector' ? r.sector : r.asset_class) || 'Other'
  }

  const { tiles, groups } = useMemo(() => {
    if (!live.length)
      return { tiles: [] as Tile[], groups: [] as GroupMeta[] }
    const W = dims.w
    const H = dims.h
    const items = groupKey ? live.filter((r) => groupOf(r) === groupKey) : live
    const buckets = new Map<string, (typeof live)[number][]>()
    for (const r of items) {
      const k = groupOf(r)
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k)!.push(r)
    }
    const totals = [...buckets.entries()]
      .map(([k, vs]) => ({ k, total: vs.reduce((a, r) => a + sizeValue(r), 0) }))
      .sort((a, b) => b.total - a.total)
    const grand = totals.reduce((a, t) => a + t.total, 0) || 1

    const tiles: Tile[] = []
    const groups: GroupMeta[] = []
    let gx = 0
    let gy = 0
    let rw = W
    let rh = H
    const horizontal = W >= H
    const headerH = groupKey ? 0 : 20
    for (const { k, total } of totals) {
      const list = buckets.get(k)!
      const frac = total / grand
      let gw: number, gh: number, nx: number, ny: number
      if (horizontal) {
        gw = Math.max(60, Math.floor(rw * frac))
        if (k === totals[totals.length - 1].k) gw = W - gx
        gh = H
        nx = gx + gw
        ny = gy
      } else {
        gw = W
        gh = Math.max(60, Math.floor(rh * frac))
        if (k === totals[totals.length - 1].k) gh = H - gy
        nx = gx
        ny = gy + gh
      }
      groups.push({ label: k, x: gx, y: gy, w: gw, h: gh, count: list.length })
      const sub = treemap(
        list.map((r) => ({ key: r.symbol_key, value: sizeValue(r) })),
        Math.max(0, gw - 3),
        Math.max(0, gh - headerH - 3),
      )
      for (const rc of sub) {
        tiles.push({
          ...rc,
          x: rc.x + gx + 1,
          y: rc.y + gy + headerH,
          w: rc.w,
          h: rc.h,
          group: k,
          flash: (list.find((r) => r.symbol_key === rc.key) as {
            _flash: 1 | -1 | 0
          })._flash,
        })
      }
      gx = nx
      gy = ny
      if (horizontal) rw = W - gx
      else rh = H - gy
    }
    tiles.sort((a, b) => b.w * b.h - a.w * a.h)
    return { tiles, groups }
  }, [live, dims.w, dims.h, groupKey, groupMode, sizeBy, hasCap])

  const byKey = useMemo(
    () => Object.fromEntries(live.map((r) => [r.symbol_key, r])),
    [live],
  )
  const hovered = hover ? byKey[hover] : null

  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      {/* header */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="flex items-center gap-1.5 font-bold uppercase tracking-widest text-[var(--text)]">
          <Boxes size={13} className="text-[var(--amber)]" /> Market heatmap
        </span>
        {groupKey && (
          <button
            onClick={() => {
              setGroupKey(null)
              setHover(null)
            }}
            className="flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--dim)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
          >
            <ChevronLeft size={11} /> all sectors
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="hidden items-center gap-1 text-[var(--dim)] sm:flex">
            <Layers size={11} /> size
          </span>
          <select
            value={sizeBy}
            onChange={(e) => setSizeBy(e.target.value as SizeBy)}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 outline-none focus:border-[var(--amber)]"
          >
            <option value="market_cap">market cap</option>
            <option value="volume">$ volume</option>
          </select>
          <button
            onClick={() => setKeysOpen(true)}
            title="settings — add a Finnhub key for sectors & market caps"
            className="flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--dim)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
          >
            <Settings size={11} /> data
          </button>
        </div>
      </div>

      {/* data source pill */}
      <div className="mb-2">
        {dataMode === 'finnhub' ? (
          <span className="inline-flex items-center gap-1.5 rounded bg-[var(--up)]/10 px-2 py-0.5 text-[10px] text-[var(--up)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--up)]" />
            Finnhub live — size market cap · group sector
          </span>
        ) : dataMode === 'partial' ? (
          <span className="inline-flex items-center gap-1.5 rounded bg-[var(--amber)]/10 px-2 py-0.5 text-[10px] text-[var(--amber)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--amber)]" />
            partial fundamentals
          </span>
        ) : (
          <button
            onClick={() => setKeysOpen(true)}
            className="inline-flex items-center gap-1.5 rounded border border-dashed border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--dim)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
          >
            no Finnhub key — size by volume, group by asset class · add key for market caps & sectors ↗
          </button>
        )}
      </div>

      {/* treemap */}
      {!live.length ? (
        <div className="flex flex-1 items-center justify-center rounded border border-dashed border-[var(--border)] bg-[var(--panel)] text-sm text-[var(--dim)]">
          loading universe…
        </div>
      ) : (
        <div
          ref={wrapRef}
          className="min-h-0 flex-1 overflow-hidden rounded border border-[var(--border)] bg-[var(--panel)] p-1"
        >
          <svg
            viewBox={`0 0 ${dims.w} ${dims.h}`}
            className="h-full w-full select-none"
            role="img"
            aria-label="market heatmap"
          >
            {/* sector group borders + headers */}
            {groups.map((g) => {
              const clickable = !groupKey
              return (
                <g
                  key={`g-${g.label}`}
                  onClick={clickable ? () => onDrill(g.label, setGroupKey, setHover) : undefined}
                  className={clickable ? 'cursor-pointer' : ''}
                >
                  <rect
                    x={g.x + 0.5}
                    y={g.y + 0.5}
                    width={g.w - 1}
                    height={g.h - 1}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth="1"
                    rx="4"
                  />
                  {!groupKey && (
                    <>
                      <rect
                        x={g.x}
                        y={g.y}
                        width={g.w}
                        height={20}
                        fill="var(--panel2)"
                        rx="4"
                      />
                      <circle cx={g.x + 10} cy={g.y + 10} r={3} fill={hueFor(g.label)} />
                      <text
                        x={g.x + 18}
                        y={g.y + 13}
                        fontSize="10"
                        fontWeight="700"
                        letterSpacing="0.5"
                        fill="var(--text)"
                      >
                        {g.label}
                      </text>
                      <text
                        x={g.x + g.w - 8}
                        y={g.y + 13}
                        fontSize="9"
                        textAnchor="end"
                        fill="var(--dim)"
                      >
                        {g.count}
                      </text>
                    </>
                  )}
                </g>
              )
            })}

            {/* tiles */}
            {tiles.map((t) => {
              const r = byKey[t.key]
              if (!r) return null
              return (
                <g
                  key={t.key}
                  onClick={() => select(t.key)}
                  onMouseEnter={() => setHover(t.key)}
                  onMouseLeave={() => setHover(null)}
                  className="cursor-pointer"
                >
                  <rect
                    x={t.x}
                    y={t.y}
                    width={t.w - 1}
                    height={t.h - 1}
                    rx={2}
                    fill={changeColor(r.change_pct)}
                    stroke={hover === t.key ? 'var(--amber)' : 'var(--bg)'}
                    strokeWidth={hover === t.key ? 2 : 1}
                    className={t.flash === 1 ? 'flash-rect-up' : t.flash === -1 ? 'flash-rect-down' : ''}
                  />
                  {t.w >= 84 && t.h >= 46 && (
                    <LogoMark
                      x={t.x + t.w - 8}
                      y={t.y + 8}
                      anchor="end"
                      ticker={r.ticker}
                      row={r}
                    />
                  )}
                  {t.w >= 44 && t.h >= 20 && (
                    <text
                      x={t.x + 5}
                      y={t.y + 13}
                      fontSize={t.w < 90 ? 11 : 12}
                      fontWeight={800}
                      fill={textColorOn(r.change_pct)}
                      style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.25)', strokeWidth: 0.6 }}
                    >
                      {r.ticker}
                    </text>
                  )}
                  {t.w >= 72 && t.h >= 32 && (
                    <text
                      x={t.x + 5}
                      y={t.y + 25}
                      fontSize={10}
                      fontWeight={600}
                      fill={textColorOn(r.change_pct)}
                      opacity={0.92}
                    >
                      {(r.change_pct ?? 0) >= 0 ? '+' : ''}
                      {(r.change_pct ?? 0).toFixed(2)}%
                    </text>
                  )}
                  {t.w >= 72 && t.h >= 44 && r.market_cap_m && (
                    <text
                      x={t.x + 5}
                      y={t.y + 36}
                      fontSize={9}
                      fill={textColorOn(r.change_pct)}
                      opacity={0.8}
                    >
                      ${fmtBig(r.market_cap_m * 1e6)}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      )}

      {/* legend + footer */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--dim)]">
        <div className="flex items-center gap-2">
          <span className="uppercase tracking-wider">change %</span>
          <div className="flex h-2.5 w-44 overflow-hidden rounded-full border border-[var(--border)]">
            {Array.from({ length: 21 }, (_, i) =>
              changeColor(-MAX_PCT + (2 * MAX_PCT * i) / 20),
            ).map((s, i) => (
              <span key={i} className="flex-1" style={{ background: s }} />
            ))}
          </div>
          <span>{MAX_PCT}%</span>
        </div>
        <div className="flex items-center gap-3">
          <span>
            tile = {sizeBy === 'market_cap' && hasCap ? 'market cap' : 'dollar volume'}
          </span>
          <span>· {tiles.length} symbols</span>
        </div>
      </div>

      {/* hover footer */}
      <div className="mt-1 flex min-h-[16px] items-center text-[11px]">
        {hovered ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-[var(--text)]">{hovered.ticker}</span>
            <span className="tabular-nums">{Number(hovered.last).toFixed(2)}</span>
            <span className={(hovered.change_pct ?? 0) >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>
              {(hovered.change_pct ?? 0) >= 0 ? '+' : ''}
              {(hovered.change_pct ?? 0).toFixed(2)}%
            </span>
            {hovered.sector && <span className="text-[var(--dim)]">{hovered.sector}</span>}
            {hovered.market_cap_m && (
              <span className="text-[var(--dim)]">cap ${fmtBig(hovered.market_cap_m * 1e6)}</span>
            )}
            <span className="text-[var(--dim)]">vol ${fmtBig(hovered.notional)}</span>
            {!groupKey && (
              <span className="rounded bg-[var(--amber)]/15 px-1.5 py-0.5 text-[var(--amber)]">
                click tile = chart · click header = drill into sector
              </span>
            )}
          </span>
        ) : (
          <span>
            hover for details · click a tile to open its chart
            {!groupKey && ' · click a sector header to drill down'}
          </span>
        )}
      </div>
    </div>
  )
}

function onDrill(
  label: string,
  setGroupKey: (k: string) => void,
  setHover: (k: string | null) => void,
) {
  setGroupKey(label)
  setHover(null)
}

function LogoMark({
  x,
  y,
  anchor,
  ticker,
  row,
}: {
  x: number
  y: number
  anchor: 'start' | 'end'
  ticker: string
  row: UniverseRow
}) {
  const [err, setErr] = useState(false)
  const url = logoUrl(row)
  const R = 9
  const cx = anchor === 'end' ? x - R : x + R
  if (!url || err) {
    return (
      <g>
        <circle cx={cx} cy={y} r={R} fill="rgba(0,0,0,0.3)" stroke="rgba(255,255,255,0.35)" strokeWidth={0.8} />
        <text x={cx} y={y + 3.5} textAnchor="middle" fontSize={10} fontWeight={800} fill="rgba(255,255,255,0.95)">
          {ticker.slice(0, 1)}
        </text>
      </g>
    )
  }
  return (
    <g>
      <rect x={cx - R} y={y - R} width={R * 2} height={R * 2} rx={3} fill="rgba(255,255,255,0.92)" />
      <clipPath id={`clip-${ticker}`}>
        <rect x={cx - R} y={y - R} width={R * 2} height={R * 2} rx={3} />
      </clipPath>
      <image
        href={url}
        x={cx - R + 2}
        y={y - R + 2}
        width={R * 2 - 4}
        height={R * 2 - 4}
        clipPath={`url(#clip-${ticker})`}
        onError={() => setErr(true)}
        style={{ pointerEvents: 'none' }}
      />
    </g>
  )
}
