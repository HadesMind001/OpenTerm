import { useEffect, useRef, useState } from 'react'
import type { DrawView } from './types'

/**
 * A pure SVG overlay parked on top of the chart canvas (zIndex 5). It owns
 * ZERO coordinate knowledge: every geometry question goes through the
 * timeToX/priceToY callbacks (ChartPanel wraps the library's
 * timeToCoordinate/priceToCoordinate — logical-vs-pixel care lives THERE,
 * not here). This component is stateless with respect to the chart: on any
 * re-render it recomputes all paths from current props, so pan/zoom can only
 * ever be correct if someone bumps redrawSignal or resizes the box (see the
 * two force() effects). Miss a signal and drawings slide off their anchors —
 * the canvas repaints itself for free, this SVG does not.
 *
 * Persistence contract with the REST layer (/api/drawings):
 * - the server stores rows {id, kind, payload} where payload is OPAQUE JSON:
 *   {p1: {ts, price}, p2?: same, payload?: kind-specific extras}. The double
 *   nesting (r.payload.payload) is real, not a typo.
 * - there is no server-side schema for the inner shape and no version field
 *   → version skew is handled by graceful silence: pathsFor()'s fallthrough
 *   renders an unknown kind as nothing instead of crashing.
 * - ts is epoch SECONDS (chart convention), prices plain numbers.
 * - only p1 gets a delete hit-circle; two-point tools must be double-clicked
 *   AT THE FIRST anchor.
 */
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.382, 1.5, 1.618, 2.0, 2.618]
const FIB_EXT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.382, 1.5, 1.618, 2.0, 2.618, 3.0, 3.618, 4.236]

function isFib(kind: DrawView['kind']): kind is 'fib' | 'fib-ext' {
  return kind === 'fib' || kind === 'fib-ext'
}

function pathsFor(
  d: DrawView,
  timeToX: (ts: number) => number | null,
  priceToY: (price: number) => number | null,
): { d: string; major: boolean; fill?: string }[] {
  const x1 = timeToX(d.p1.ts)
  const y1 = priceToY(d.p1.price)
  const out: { d: string; major: boolean; fill?: string }[] = []

  if (d.kind === 'hline') {
    // 99999 instead of a real width: the SVG's default overflow:hidden does
    // the clipping, so an absurd endpoint beats re-measuring the container.
    if (y1 !== null) out.push({ d: `M0 ${y1} L99999 ${y1}`, major: true })
    return out
  }

  if (!d.p2 || x1 === null || y1 === null) return out

  const x2 = timeToX(d.p2.ts)
  const y2 = priceToY(d.p2.price)
  if (x2 === null || y2 === null) return out

  if (d.kind === 'trend') {
    out.push({ d: `M${x1} ${y1} L${x2} ${y2}`, major: true })
    return out
  }

  if (d.kind === 'fib' || d.kind === 'fib-ext') {
    const left = Math.min(x1, x2)
    const right = Math.max(x1, x2)
    // The names here lie: screen y grows DOWN, so Math.max picks the pixel
    // LOWER on screen = the price LOW point (and vice versa). Result:
    // level 0 lands at the top pixel (high anchor), higher levels march
    // downward — and nothing normalizes by swing direction, so dragging
    // low→high vs high→low mirrors the ladder. Looks plausible either way —
    // verify against a real chart before changing anything here.
    const priceTop = Math.max(y1, y2)
    const priceBottom = Math.min(y1, y2)
    const levels = isFib(d.kind) ? FIB_EXT_LEVELS : FIB_LEVELS
    levels.forEach((lvl, i) => {
      const py = priceBottom + (priceTop - priceBottom) * lvl
      // "major" indexes into FIB_LEVELS regardless of which array is in play;
      // it's only correct because FIB_EXT_LEVELS extends FIB_LEVELS as a
      // prefix. Reorder either list and the highlighted lines go wrong
      // silently.
      const major = i === FIB_LEVELS.indexOf(0.5) || i === 0
      out.push({
        d: `M${left} ${py} L${right} ${py}`,
        major,
        fill: lvl === 0.5 ? 'var(--panel2)' : undefined,
      })
    })
    return out
  }

  if (d.kind === 'rect') {
    const x1v = timeToX(d.p1.ts)
    const y1v = priceToY(d.p1.price)
    const x2v = timeToX(d.p2!.ts)
    const y2v = priceToY(d.p2!.price)
    if (x1v === null || y1v === null || x2v === null || y2v === null) return out
    const x = Math.min(x1v, x2v)
    const y = Math.min(y1v, y2v)
    const w = Math.abs(x2v - x1v)
    const h = Math.abs(y2v - y1v)
    out.push({ d: `M${x} ${y} h${w} v${h} h${-w} Z`, major: true, fill: 'var(--panel2)' })
    return out
  }

  if (d.kind === 'ellipse') {
    // ka is the magic constant turning a quarter-circle into one cubic
    // Bézier — so an honest ellipse needs 4 clean C segments. This string
    // has 5 coordinate pairs after its first C before the next command
    // (multiples of 3 required), so the parser dies after the first curve
    // and everything from the error on is ignored: you get a squiggle
    // starting at the box's top-left, not an ellipse. Documented, not
    // "fixed", so nobody mistakes the stub for intentional art.
    const x1v = timeToX(d.p1.ts)
    const y1v = priceToY(d.p1.price)
    const x2v = timeToX(d.p2!.ts)
    const y2v = priceToY(d.p2!.price)
    if (x1v === null || y1v === null || x2v === null || y2v === null) return out
    const cx = (x1v + x2v) / 2
    const cy = (y1v + y2v) / 2
    const rx = Math.abs(x2v - x1v) / 2
    const ry = Math.abs(y2v - y1v) / 2
    const ka = 0.5522847498307933
    const ox = rx * ka
    const oy = ry * ka
    const xStart = cx - rx
    const yStart = cy - ry
    out.push({
      d: `M${xStart} ${yStart}
        C${xStart + ox} ${yStart},
        ${xStart + rx} ${yStart - oy},
        ${xStart + rx} ${yStart + ry},
        ${xStart + ox} ${yStart + ry},
        ${xStart} ${yStart + ry},
        C${xStart - ox} ${yStart + ry},
        ${xStart - rx} ${yStart},
        ${xStart - rx} ${yStart - oy},
        ${xStart - rx} ${yStart + ry},
        ${xStart - ox} ${yStart + ry},
        ${xStart} ${yStart}`,
      major: true,
      fill: 'var(--panel2)',
    })
    return out
  }

  if (d.kind === 'vline') {
    // KNOWN BUG, kept honest: '%' is not valid path data (paths take user
    // units), so the L command after the M never parses — vlines render as
    // nothing. The hline trick above (giant literal, clipped by the SVG
    // viewport) is the fix if this tool ever gets used.
    if (x1 !== null) out.push({ d: `M${x1} 0 L${x1} 100%`, major: true })
    return out
  }

  return out
}

export function DrawingLayer({
  timeToX,
  priceToY,
  interactive,
  drawings,
  pending,
  onClickAt,
  onDelete,
  redrawSignal,
}: {
  timeToX: (ts: number) => number | null
  priceToY: (price: number) => number | null
  interactive: boolean
  drawings: DrawView[]
  pending: DrawView | null
  onClickAt: (x: number, y: number) => void
  onDelete: (id: number) => void
  redrawSignal: number
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  // No viewBox on this <svg>: 1 unit = 1 CSS px, matching what the
  // ChartPanel callbacks return. A ResizeObserver (not the chart's range
  // subscription) covers the resize case — pan/zoom emits a range change,
  // container resize emits nothing, and stale pixel anchors survive until
  // some re-render recomputes them.
  const [, force] = useState(0)

  useEffect(() => {
    const el = svgRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => force((n) => n + 1))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    force((n) => n + 1)
  }, [redrawSignal])

  const colorOf = (kind: DrawView['kind']) => {
    if (kind === 'hline') return 'var(--amber)'
    if (kind === 'trend') return '#22d3ee'
    if (kind === 'fib' || kind === 'fib-ext') return '#c084fc'
    if (kind === 'rect') return 'var(--amber)'
    if (kind === 'ellipse') return 'var(--amber)'
    if (kind === 'vline') return 'var(--amber)'
    return '#64748b'
  }

  return (
    <svg
      ref={svgRef}
      className={`absolute inset-0 h-full w-full ${
        interactive ? 'cursor-crosshair' : 'pointer-events-none'
      }`}
      style={{ zIndex: 5 }}
      onMouseDown={(e) => {
        if (!interactive) return
        e.stopPropagation()
        const rect = svgRef.current!.getBoundingClientRect()
        onClickAt(e.clientX - rect.left, e.clientY - rect.top)
      }}
    >
      {interactive && (
        <rect width="100%" height="100%" fill="transparent" pointerEvents="all" />
      )}
      {[...(pending ? [pending] : []), ...drawings].map((d, idx) =>
        pathsFor(d, timeToX, priceToY).map((p, j) => (
          <path
            key={`${idx}-${j}`}
            d={p.d}
            stroke={colorOf(d.kind)}
            strokeWidth={p.major ? 1.4 : 0.8}
            strokeDasharray={d.kind === 'fib' && !p.major ? '4 4' : undefined}
            fill={p.fill}
            opacity={pending && idx === 0 ? 0.6 : 0.95}
          />
        )),
      )}
      {drawings.map((d, i) => {
        // Deletion targets the p1 anchor ONLY (small transparent circle).
        // pointer-events-none on the svg is overridden here per-element, so
        // the layer stays click-through to the chart everywhere else. Draw
        // outside the tool mode: dbl-click must land within 8px of p1 —
        // rects/fibs are grabbable nowhere else by design-debt.
        const cx = timeToX(d.p1.ts)
        const cy = priceToY(d.p1.price)
        if (cx === null || cy === null || d.id === undefined) return null
        return (
          <circle
            key={`hit-${i}`}
            cx={cx}
            cy={cy}
            r={8}
            fill="transparent"
            style={{ pointerEvents: 'all', cursor: 'pointer' }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onDelete(d.id!)
            }}
          />
        )
      })}
    </svg>
  )
}