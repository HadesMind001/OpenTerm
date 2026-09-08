import { useEffect, useMemo, useState, useRef } from 'react'
import { Boxes, Flame, Grid3x3, Layers, LineChart, Save, Table2, X } from 'lucide-react'
import { api } from '../../lib/api'
import { treemap } from '../../lib/squarify'
import type { TreemapRect } from '../../lib/squarify'
import { useStore } from '../../state/store'
import type { UniverseRow } from '../../lib/types'

const PALETTE = ['#ffb000', '#38bdf8', '#34d399', '#f87171', '#c084fc', '#a3e635', '#fb923c']

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: d })
}

function fmtBig(n: number | null | undefined): string {
  if (!n) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toFixed(0)
}

type SortKey = 'ticker' | 'last' | 'change_pct' | 'notional'

interface Filters {
  search: string
  assetClass: 'ALL' | 'CRYPTO' | 'EQUITY'
  minChg: string
  maxChg: string
}

const DEFAULT_FILTERS: Filters = { search: '', assetClass: 'ALL', minChg: '', maxChg: '' }

interface Preset {
  name: string
  filters: Filters
}

function loadPresets(): Preset[] {
  try {
    return JSON.parse(localStorage.getItem('ot-screen-presets') ?? '[]') as Preset[]
  } catch {
    return []
  }
}

export function ScreenPage() {
  const [rows, setRows] = useState<UniverseRow[]>([])
  const [view, setView] = useState<'table' | 'heatmap'>('table')
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [sortKey, setSortKey] = useState<SortKey>('change_pct')
  const [sortDir, setSortDir] = useState<1 | -1>(-1)
  const [presets, setPresets] = useState<Preset[]>(loadPresets)

  useEffect(() => {
    const load = () => void api.universe().then(setRows).catch(() => undefined)
    load()
    const id = window.setInterval(load, 5000)
    return () => window.clearInterval(id)
  }, [])

  const filtered = useMemo(() => {
    const minC = parseFloat(filters.minChg)
    const maxC = parseFloat(filters.maxChg)
    return rows
      .filter((r) => filters.assetClass === 'ALL' || r.asset_class === filters.assetClass)
      .filter((r) => !filters.search || r.ticker.includes(filters.search.toUpperCase()))
      .filter((r) => r.change_pct !== null || r.last !== undefined)
      .filter(
        (r) =>
          isNaN(minC) ||
          (r.change_pct !== null && r.change_pct >= minC),
      )
      .filter(
        (r) =>
          isNaN(maxC) ||
          (r.change_pct !== null && r.change_pct <= maxC),
      )
  }, [rows, filters])

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        const va = a[sortKey] ?? ''
        const vb = b[sortKey] ?? ''
        if (typeof va === 'string' && typeof vb === 'string')
          return sortDir * va.localeCompare(vb)
        return sortDir * ((va as number) - (vb as number))
      }),
    [filtered, sortKey, sortDir],
  )

  const gainers = useMemo(
    () =>
      [...rows]
        .filter((r) => r.change_pct !== null)
        .sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0))
        .slice(0, 5),
    [rows],
  )
  const losers = useMemo(
    () =>
      [...rows]
        .filter((r) => r.change_pct !== null)
        .sort((a, b) => (a.change_pct ?? 0) - (b.change_pct ?? 0))
        .slice(0, 5),
    [rows],
  )

  const savePreset = () => {
    const name = window.prompt('preset name?')
    if (!name) return
    const next = [...loadPresets(), { name, filters }]
    localStorage.setItem('ot-screen-presets', JSON.stringify(next))
    setPresets(next)
  }

  const select = useStore((s) => s.select)

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 grid gap-2 md:grid-cols-2">
        <MoverCard title="Top gainers" rows={gainers} up />
        <MoverCard title="Top losers" rows={losers} />
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="flex items-center gap-1 uppercase tracking-wider text-[var(--dim)]">
          <Table2 size={12} /> Screener
        </span>
        <button
          onClick={() => setView(view === 'table' ? 'heatmap' : 'table')}
          className="ml-auto flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 hover:border-[var(--amber)]"
        >
          {view === 'table' ? (
            <>
              <Flame size={11} /> heatmap
            </>
          ) : (
            <>
              <Grid3x3 size={11} /> table
            </>
          )}
        </button>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <input
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          placeholder="search…"
          className="w-24 rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 outline-none focus:border-[var(--amber)]"
        />
        <select
          value={filters.assetClass}
          onChange={(e) =>
            setFilters({ ...filters, assetClass: e.target.value as Filters['assetClass'] })
          }
          className="rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5 outline-none"
        >
          <option>ALL</option>
          <option>CRYPTO</option>
          <option>EQUITY</option>
        </select>
        <label className="text-[var(--dim)]">chg ≥</label>
        <input
          value={filters.minChg}
          onChange={(e) => setFilters({ ...filters, minChg: e.target.value })}
          placeholder="%"
          className="w-12 rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5 tabular-nums outline-none focus:border-[var(--amber)]"
        />
        <label className="text-[var(--dim)]">≤</label>
        <input
          value={filters.maxChg}
          onChange={(e) => setFilters({ ...filters, maxChg: e.target.value })}
          placeholder="%"
          className="w-12 rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5 tabular-nums outline-none focus:border-[var(--amber)]"
        />
        <select
          value=""
          onChange={(e) => {
            const p = presets.find((x) => x.name === e.target.value)
            if (p) setFilters(p.filters)
          }}
          className="rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5 outline-none"
        >
          <option value="">presets…</option>
          {presets.map((p) => (
            <option key={p.name}>{p.name}</option>
          ))}
        </select>
        <button
          onClick={savePreset}
          className="flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 hover:border-[var(--amber)]"
        >
          <Save size={10} /> save
        </button>
        <span className="text-[var(--dim)]">{sorted.length} of {rows.length}</span>
      </div>

      {view === 'table' ? (
        <ScreenerTable
          rows={sorted}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={(k) => {
            if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1))
            else {
              setSortKey(k)
              setSortDir(-1)
            }
          }}
          onSelect={select}
        />
      ) : (
        <Heatmap rows={filtered} onSelect={select} />
      )}

      <CorrelateSection universe={rows} />
    </div>
  )
}

function MoverCard({
  title,
  rows,
  up = false,
}: {
  title: string
  rows: UniverseRow[]
  up?: boolean
}) {
  const select = useStore((s) => s.select)
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-2">
      <div className={`mb-1 text-[10px] uppercase tracking-wider ${up ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>
        ▲ {title}
      </div>
      {rows.map((r) => (
        <div
          key={r.symbol_key}
          onClick={() => select(r.symbol_key)}
          className="flex cursor-pointer items-center justify-between rounded px-1 py-0.5 text-xs hover:bg-[var(--panel2)]"
        >
          <span className="font-semibold">{r.ticker}</span>
          <span className="tabular-nums text-[var(--dim)]">{fmt(r.last)}</span>
          <span
            className={`w-16 text-right tabular-nums ${
              (r.change_pct ?? 0) >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'
            }`}
          >
            {(r.change_pct ?? 0) >= 0 ? '+' : ''}
            {(r.change_pct ?? 0).toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  )
}

function ScreenerTable({
  rows,
  sortKey,
  sortDir,
  onSort,
  onSelect,
}: {
  rows: UniverseRow[]
  sortKey: SortKey
  sortDir: 1 | -1
  onSort: (k: SortKey) => void
  onSelect: (key: string) => void
}) {
  const H = ({ k, label }: { k: SortKey; label: string }) => (
    <th
      onClick={() => onSort(k)}
      className={`cursor-pointer px-2 py-1 text-left font-normal hover:text-[var(--text)] ${
        k === sortKey ? 'text-[var(--amber)]' : ''
      }`}
    >
      {label} {k === sortKey ? (sortDir === -1 ? '▼' : '▲') : ''}
    </th>
  )
  return (
    <table className="w-full text-xs tabular-nums">
      <thead className="text-[10px] uppercase tracking-wider text-[var(--dim)]">
        <tr>
          <H k="ticker" label="symbol" />
          <H k="last" label="last" />
          <H k="change_pct" label="chg %" />
          <H k="notional" label="volume $" />
          <th className="px-2 py-1 text-left font-normal">day pos</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const pct =
            r.day_high && r.day_low && r.day_high > r.day_low
              ? ((r.last - r.day_low) / (r.day_high - r.day_low)) * 100
              : null
          const up = (r.change_pct ?? 0) >= 0
          return (
            <tr
              key={r.symbol_key}
              onClick={() => onSelect(r.symbol_key)}
              className="cursor-pointer border-b border-[var(--border)]/30 hover:bg-[var(--panel2)]"
            >
              <td className="px-2 py-1 font-semibold">
                {r.ticker}
                <span className="ml-1.5 text-[9px] text-[var(--dim)]">{r.asset_class}</span>
              </td>
              <td className="px-2 py-1">{fmt(r.last)}</td>
              <td className={`px-2 py-1 ${up ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>
                {up ? '+' : ''}
                {(r.change_pct ?? 0).toFixed(2)}%
              </td>
              <td className="px-2 py-1 text-[var(--dim)]">{fmtBig(r.notional)}</td>
              <td className="w-28 px-2 py-1">
                <div className="h-1 rounded bg-[var(--border)]">
                  <div
                    className="h-1 rounded bg-[var(--amber)]"
                    style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
                  />
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------------------
// Heatmap — Bloomberg / Finviz-style squarified treemap
// size = dollar volume | shares volume | |% move|
// color = % change diverging ±5% → red → slate → green
// group = flat vs split by asset_class
// ---------------------------------------------------------------------------

type SizeBy = 'notional' | 'volume' | 'abs_change'
type GroupBy = 'none' | 'asset_class'

function heatFill(pct: number | null): string {
  const v = pct ?? 0
  const c = Math.max(-5, Math.min(5, v))
  // discrete finviz-like stops for readability
  if (c <= -3) return '#991b1b' // deep red
  if (c <= -1.5) return '#dc2626'
  if (c <= -0.5) return '#f87171'
  if (c < 0.5) return '#334155' // slate neutral around 0
  if (c < 1.5) return '#4ade80'
  if (c < 3) return '#16a34a'
  return '#14532d' // deep green, keep text white
}

function heatTextColor(pct: number | null): string {
  const v = pct ?? 0
  const c = Math.max(-5, Math.min(5, v))
  if (c <= -1.5) return '#ffffff'
  if (c >= 1.5) return '#ffffff'
  if (Math.abs(c) < 0.5) return '#d7dde8'
  return '#0b0e11'
}

function valueFor(row: UniverseRow, sizeBy: SizeBy): number {
  if (sizeBy === 'volume') return Math.max(row.volume ?? 1, 1)
  if (sizeBy === 'abs_change') return Math.max(Math.abs(row.change_pct ?? 0) + 0.4, 0.4)
  return Math.max(row.notional ?? 1, 1)
}

function Heatmap({
  rows,
  onSelect,
}: {
  rows: UniverseRow[]
  onSelect: (key: string) => void
}) {
  const [hover, setHover] = useState<string | null>(null)
  const [sizeBy, setSizeBy] = useState<SizeBy>('notional')
  const [groupBy, setGroupBy] = useState<GroupBy>('asset_class')
  const wrapRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 920, h: 420 })

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.max(320, Math.floor(e.contentRect.width))
        // height: aim for 42% of width, clamped 300-520, keeps treemap readable
        const h = Math.min(520, Math.max(300, Math.round(w * 0.46)))
        setDims({ w, h })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const byKey = useMemo(() => Object.fromEntries(rows.map((r) => [r.symbol_key, r])), [rows])

  // build rects with optional grouping
  const { rects, groupsMeta } = useMemo(() => {
    if (!rows.length) return { rects: [] as (TreemapRect & { group?: string })[], groupsMeta: [] as { label: string; x: number; y: number; w: number; h: number }[] }
    const W = dims.w
    const H = dims.h
    if (groupBy === 'none') {
      const items = rows.map((r) => ({ key: r.symbol_key, value: valueFor(r, sizeBy) }))
      return { rects: treemap(items, W, H).map((rc) => ({ ...rc, group: undefined })), groupsMeta: [] }
    }
    // grouped by asset_class
    const order: string[] = ['EQUITY', 'CRYPTO']
    const buckets = new Map<string, UniverseRow[]>()
    for (const r of rows) {
      const k = r.asset_class || 'OTHER'
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k)!.push(r)
    }
    // sort groups by total size desc, but keep EQUITY first if close for visual stability
    const totals = [...buckets.entries()].map(([k, vs]) => ({
      k,
      total: vs.reduce((a, r) => a + valueFor(r, sizeBy), 0),
    }))
    totals.sort((a, b) => {
      // keep defined order as tiebreak
      const ia = order.indexOf(a.k)
      const ib = order.indexOf(b.k)
      if (Math.abs(a.total - b.total) / Math.max(a.total, b.total) < 0.08 && ia !== -1 && ib !== -1) return ia - ib
      return b.total - a.total
    })
    const grand = totals.reduce((a, t) => a + t.total, 0) || 1
    const rects: (TreemapRect & { group?: string })[] = []
    const groupsMeta: { label: string; x: number; y: number; w: number; h: number }[] = []
    let gx = 0
    let gy = 0
    let rw = W
    let rh = H
    const horizontal = W >= H
    for (const { k, total } of totals) {
      const list = buckets.get(k)!
      const frac = total / grand
      let gw: number, gh: number, nx: number, ny: number
      if (horizontal) {
        gw = Math.max(60, Math.floor(rw * frac))
        // last group takes remainder to avoid rounding gap
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
      groupsMeta.push({ label: k, x: gx, y: gy, w: gw, h: gh })
      const items = list.map((r) => ({ key: r.symbol_key, value: valueFor(r, sizeBy) }))
      const sub = treemap(items, Math.max(0, gw - 2), Math.max(0, gh - 18))
      for (const rc of sub) {
        rects.push({ ...rc, x: rc.x + gx + 1, y: rc.y + gy + 16, w: rc.w, h: rc.h, group: k })
      }
      gx = nx
      gy = ny
      if (horizontal) rw = W - gx
      else rh = H - gy
    }
    return { rects, groupsMeta }
  }, [rows, dims.w, dims.h, sizeBy, groupBy])

  const hovered = hover ? byKey[hover] : null

  if (!rows.length) {
    return (
      <div className="rounded border border-dashed border-[var(--border)] bg-[var(--panel)] p-8 text-center text-sm text-[var(--dim)]">
        no symbols match current filters
      </div>
    )
  }

  const W = dims.w
  const H = dims.h

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-2">
      {/* toolbar */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="flex items-center gap-1 font-semibold uppercase tracking-wider text-[var(--dim)]">
          <Boxes size={12} /> Heatmap
          <span className="ml-1 rounded bg-[var(--panel2)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--text)]">
            {rows.length}
          </span>
        </span>

        <span className="ml-2 hidden items-center gap-1 text-[var(--dim)] sm:flex">
          <Layers size={11} /> size
        </span>
        <select
          value={sizeBy}
          onChange={(e) => setSizeBy(e.target.value as SizeBy)}
          className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] outline-none focus:border-[var(--amber)]"
          title="what determines tile area"
        >
          <option value="notional">$ volume</option>
          <option value="volume">shares vol</option>
          <option value="abs_change">|% change|</option>
        </select>

        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[11px] outline-none focus:border-[var(--amber)]"
          title="group tiles"
        >
          <option value="asset_class">group: asset class</option>
          <option value="none">group: none</option>
        </select>

        {/* legend */}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="hidden text-[10px] uppercase tracking-wider text-[var(--dim)] sm:inline">chg%</span>
          <div className="flex h-3 w-28 overflow-hidden rounded border border-[var(--border)] text-[8px] font-bold leading-none">
            <span className="flex flex-1 items-center justify-center bg-[#991b1b] text-white">≤-3</span>
            <span className="flex flex-1 items-center justify-center bg-[#dc2626] text-white">-1.5</span>
            <span className="flex flex-1 items-center justify-center bg-[#f87171] text-[#0b0e11]">-0.5</span>
            <span className="flex flex-1 items-center justify-center bg-[#334155] text-[var(--text)]">0</span>
            <span className="flex flex-1 items-center justify-center bg-[#4ade80] text-[#0b0e11]">+0.5</span>
            <span className="flex flex-1 items-center justify-center bg-[#16a34a] text-white">+1.5</span>
            <span className="flex flex-1 items-center justify-center bg-[#14532d] text-white">≥+3</span>
          </div>
        </div>
      </div>

      {/* treemap */}
      <div ref={wrapRef} className="w-full">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" role="img" aria-label="screener heatmap">
          {/* group headers */}
          {groupsMeta.map((g) => (
            <g key={`g-${g.label}`}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h} fill="transparent" stroke="var(--border)" strokeWidth="1" rx="4" />
              <rect x={g.x} y={g.y} width={g.w} height={16} fill="var(--panel2)" rx="2" />
              <text x={g.x + 6} y={g.y + 11} fontSize="9" fontWeight="700" letterSpacing="0.6" fill="var(--dim)">
                {g.label} · {rows.filter((r) => r.asset_class === g.label).length}
              </text>
            </g>
          ))}

          {rects.map((rc) => {
            const r = byKey[rc.key]
            if (!r) return null
            const pct = r.change_pct ?? 0
            const fill = heatFill(pct)
            const textColor = heatTextColor(pct)
            const isHover = hover === rc.key
            const showTicker = rc.w >= 44 && rc.h >= 20
            const showDetail = rc.w >= 72 && rc.h >= 32
            const isTiny = rc.w < 28 || rc.h < 16
            if (isTiny) {
              return (
                <g
                  key={rc.key}
                  onClick={() => onSelect(rc.key)}
                  onMouseEnter={() => setHover(rc.key)}
                  onMouseLeave={() => setHover(null)}
                  className="cursor-pointer"
                >
                  <rect
                    x={rc.x}
                    y={rc.y}
                    width={rc.w - 1}
                    height={rc.h - 1}
                    rx={2}
                    fill={fill}
                    stroke={isHover ? 'var(--amber)' : 'var(--bg)'}
                    strokeWidth={isHover ? 1.8 : 1}
                    opacity={0.95}
                  />
                </g>
              )
            }
            return (
              <g
                key={rc.key}
                onClick={() => onSelect(rc.key)}
                onMouseEnter={() => setHover(rc.key)}
                onMouseLeave={() => setHover(null)}
                className="cursor-pointer"
              >
                <rect
                  x={rc.x}
                  y={rc.y}
                  width={rc.w - 1}
                  height={rc.h - 1}
                  rx={2}
                  fill={fill}
                  stroke={isHover ? 'var(--amber)' : 'var(--bg)'}
                  strokeWidth={isHover ? 1.8 : 1}
                  opacity={isHover ? 1 : 0.96}
                />
                {showTicker && (
                  <>
                    <text
                      x={rc.x + 5}
                      y={rc.y + 14}
                      fontSize={rc.w < 90 ? '11' : '12'}
                      fontWeight="800"
                      fill={textColor}
                      style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.22)', strokeWidth: 0.6 }}
                    >
                      {r.ticker}
                    </text>
                    {showDetail && (
                      <text x={rc.x + 5} y={rc.y + 26} fontSize="10" fontWeight="600" fill={textColor} opacity={0.92}>
                        {pct >= 0 ? '+' : ''}
                        {pct.toFixed(2)}%
                      </text>
                    )}
                    {showDetail && rc.h >= 42 && (
                      <text x={rc.x + 5} y={rc.y + 37} fontSize="9" fill={textColor} opacity={0.78}>
                        {sizeBy === 'notional' ? fmtBig(r.notional) : sizeBy === 'volume' ? fmtBig(r.volume) : `${Math.abs(pct).toFixed(1)}%`}
                      </text>
                    )}
                  </>
                )}
                {!showDetail && showTicker && rc.w < 72 && (
                  <text x={rc.x + 4} y={rc.y + 12} fontSize="9" fontWeight="700" fill={textColor}>
                    {r.ticker.slice(0, 4)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {/* hover footer / tooltip */}
      <div className="mt-1.5 flex min-h-[18px] flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="tabular-nums text-[var(--dim)]">
          {hovered ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-[var(--text)]">{hovered.symbol_key}</span>
              <span>{fmt(hovered.last)}</span>
              <span className={(hovered.change_pct ?? 0) >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>
                {(hovered.change_pct ?? 0) >= 0 ? '+' : ''}
                {(hovered.change_pct ?? 0).toFixed(2)}%
              </span>
              <span className="text-[var(--dim)]">vol ${fmtBig(hovered.notional)} · {fmtBig(hovered.volume)} sh</span>
              <span className="rounded bg-[var(--amber)]/15 px-1.5 py-0.5 text-[10px] text-[var(--amber)]">click to open →</span>
            </span>
          ) : (
            <span>
              size = {sizeBy === 'notional' ? '$ volume' : sizeBy === 'volume' ? 'share volume' : '|% change|'} · color = % change (clamped ±5%) · hover for details
            </span>
          )}
        </span>
        <span className="text-[10px] text-[var(--dim)]">{W}×{H} · {rects.length} tiles</span>
      </div>
    </div>
  )
}

function CorrelateSection({ universe }: { universe: UniverseRow[] }) {
  const [picked, setPicked] = useState<string[]>([])
  const [interval, setInterval_] = useState('1d')
  const [result, setResult] = useState<{ symbols: string[]; matrix: number[][] } | null>(null)
  const [busy, setBusy] = useState(false)

  const toggle = (key: string) =>
    setPicked((prev) =>
      prev.includes(key)
        ? prev.filter((k) => k !== key)
        : prev.length >= 8
          ? prev
          : [...prev, key],
    )

  const run = async () => {
    if (picked.length < 2) return
    setBusy(true)
    try {
      setResult(await api.correlation(picked, interval, 60))
    } finally {
      setBusy(false)
    }
  }

  const cellColor = (v: number) => {
    const a = Math.abs(v)
    return v >= 0
      ? `rgba(52,211,153,${0.08 + a * 0.55})`
      : `rgba(248,113,113,${0.08 + a * 0.55})`
  }

  return (
    <div className="mt-5 rounded border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)]">
        <LineChart size={12} /> Correlation &amp; compare
        <select
          value={interval}
          onChange={(e) => setInterval_(e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 outline-none"
        >
          {['1h', '1d'].map((i) => (
            <option key={i}>{i}</option>
          ))}
        </select>
        <button
          onClick={() => void run()}
          disabled={picked.length < 2 || busy}
          className="rounded bg-[var(--amber)] px-2 py-0.5 font-bold text-black disabled:opacity-40"
        >
          {busy ? '…' : `run (${picked.length})`}
        </button>
        {result && (
          <button
            onClick={() => setResult(null)}
            className="ml-auto flex items-center gap-1 hover:text-[var(--text)]"
          >
            <X size={11} /> clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {universe.map((r) => (
          <button
            key={r.symbol_key}
            onClick={() => toggle(r.symbol_key)}
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              picked.includes(r.symbol_key)
                ? 'bg-[var(--amber)] font-bold text-black'
                : 'border border-[var(--border)] text-[var(--dim)] hover:text-[var(--text)]'
            }`}
          >
            {r.ticker}
          </button>
        ))}
        {!universe.length && <span className="text-xs">waiting for universe data…</span>}
      </div>

      {result && result.symbols.length >= 2 && (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="overflow-x-auto">
            <table className="text-[10px] tabular-nums">
              <thead>
                <tr>
                  <th />
                  {result.symbols.map((s) => (
                    <th key={s} className="px-1.5 pb-1 font-normal text-[var(--dim)]">
                      {s.split(':').pop()}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.matrix.map((row, i) => (
                  <tr key={i}>
                    <td className="pr-1.5 text-right text-[var(--dim)]">
                      {result.symbols[i].split(':').pop()}
                    </td>
                    {row.map((v, j) => (
                      <td
                        key={j}
                        className="h-7 w-11 text-center"
                        style={{ background: i === j ? 'var(--border)' : cellColor(v) }}
                        title={`${result.symbols[i]} ↔ ${result.symbols[j]}: ${v.toFixed(3)}`}
                      >
                        {v.toFixed(2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CompareChart symbols={result.symbols} interval={interval} />
        </div>
      )}
    </div>
  )
}

function CompareChart({ symbols, interval }: { symbols: string[]; interval: string }) {
  const [series, setSeries] = useState<{ key: string; vals: number[] }[]>([])

  useEffect(() => {
    let alive = true
    Promise.all(
      symbols.map(async (key) => {
        const bars = await api.bars(key, interval, 120)
        const base = bars[0]?.c
        if (!base) return { key, vals: [] }
        return { key, vals: bars.map((b) => (b.c / base) * 100) }
      }),
    ).then((rs) => {
      if (alive) setSeries(rs.filter((r) => r.vals.length > 1))
    })
    return () => {
      alive = false
    }
  }, [symbols.join(','), interval])

  if (!series.length) return <div className="text-xs text-[var(--dim)]">loading compare…</div>

  const W = 420
  const H = 200
  const allVals = series.flatMap((s) => s.vals)
  const lo = Math.min(...allVals)
  const hi = Math.max(...allVals)
  const span = hi - lo || 1
  const maxLen = Math.max(...series.map((s) => s.vals.length))

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={0} x2={W} y1={H - ((100 - lo) / span) * (H - 20) - 10} y2={H - ((100 - lo) / span) * (H - 20) - 10} stroke="var(--border)" strokeDasharray="3 3" />
        {series.map((s, i) => {
          const step = W / (maxLen - 1)
          const path = s.vals
            .map(
              (v, j) =>
                `${j ? 'L' : 'M'}${j * step} ${H - 10 - ((v - lo) / span) * (H - 20)}`,
            )
            .join(' ')
          return (
            <path
              key={s.key}
              d={path}
              fill="none"
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth="1.5"
            />
          )
        })}
      </svg>
      <div className="flex flex-wrap gap-2 text-[10px]">
        {series.map((s, i) => (
          <span key={s.key} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: PALETTE[i % PALETTE.length] }}
            />
            {s.key.split(':').pop()} {s.vals[s.vals.length - 1].toFixed(1)}
          </span>
        ))}
      </div>
    </div>
  )
}
