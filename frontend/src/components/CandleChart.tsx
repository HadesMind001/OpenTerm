import type { Bar } from '../lib/types'

// Hand-rolled SVG candle fallback — zero dependencies, zero lifecycle, and
// currently imported by NOTHING: the live chart is components/chart/ChartPanel
// (lightweight-charts v5). It is kept as the answer to "what if the vendor
// lib breaks", not as dead-code-bait; if you ever wire it up, note that it
// re-renders O(bars) DOM nodes per paint — fine for one sparkline-ish panel,
// not for four quad-pane charts at tick rate. No v5 gotchas apply here
// because nothing here touches v5.

const W = 900
const H = 320
const PAD_R = 56
const PAD_B = 22

export function CandleChart({ bars }: { bars: Bar[] }) {
  if (!bars.length) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--dim)]">
        no bars yet — waiting for history…
      </div>
    )
  }
  const hi = Math.max(...bars.map((b) => b.h))
  const lo = Math.min(...bars.map((b) => b.l))
  const span = hi - lo || 1 // flat chart: 1 avoids 0/0, candles pile at mid
  const maxVol = Math.max(...bars.map((b) => b.v), 1)
  const plotH = H - PAD_B
  const volH = plotH * 0.18
  const priceTop = 8
  const priceH = plotH - priceTop - volH - 6
  const cw = (W - PAD_R) / bars.length
  // Inverted on purpose: SVG y grows DOWN, price grows UP. Every consumer of
  // y() (rect tops, wick ends) must pass the MAX price first.
  const y = (p: number) => priceTop + (1 - (p - lo) / span) * priceH

  const gridLines = 5
  const ticks = Array.from({ length: gridLines }, (_, i) => lo + (span * i) / (gridLines - 1))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={0} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="0.5" />
          <text x={W - PAD_R + 6} y={y(t) + 3.5} fontSize="10" fill="var(--dim)">
            {t.toFixed(span > 100 ? 0 : span > 10 ? 1 : 2)}
          </text>
        </g>
      ))}
      {bars.map((b, i) => {
        const x = i * cw
        const up = b.c >= b.o
        const color = up ? 'var(--up)' : 'var(--down)'
        const bw = Math.max(cw * 0.62, 1)
        const bodyTop = y(Math.max(b.o, b.c))
        const bodyBot = y(Math.min(b.o, b.c))
        return (
          <g key={b.ts}>
            <line
              x1={x + bw / 2}
              x2={x + bw / 2}
              y1={y(b.h)}
              y2={y(b.l)}
              stroke={color}
              strokeWidth="1"
            />
            <rect
              x={x + (cw - bw) / 2}
              y={bodyTop}
              width={bw}
              height={Math.max(bodyBot - bodyTop, 1)}
              fill={color}
            />
            <rect
              x={x + (cw - bw) / 2}
              y={plotH - (b.v / maxVol) * volH}
              width={bw}
              height={(b.v / maxVol) * volH}
              fill={color}
              opacity="0.35"
            />
          </g>
        )
      })}
    </svg>
  )
}
