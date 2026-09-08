export interface TreemapItem {
  key: string
  value: number
}

export interface TreemapRect {
  key: string
  x: number
  y: number
  w: number
  h: number
}

interface Node extends TreemapItem {
  area: number
}

/**
 * Squarified treemap (Bruls/Hunen/Wieringda). WHY the whole ceremony: plain
 * slice-and-dice treemaps degenerate into long skinny strips as values skew —
 * unreadable labels, unclickable tiles on a heatmap. This minimizes the WORST
 * aspect ratio instead.
 *
 * `worstRatio` measures, for a candidate row of areas laid against the strip
 * of length `side`: max(longest-tile-aspect, shortest-tile-aspect) under the
 * exact layout the row would get (the s2/(side²·min) term is the reciprocal
 * aspect of the smallest tile; both are ≥ 1 and equal only for perfect
 * squares). Adding a tile that stretches the strip pushes this number up —
 * that's the stop condition.
 */
function worstRatio(row: number[], side: number): number {
  if (!row.length) return Infinity // only reachable if a caller drops the `!row.length` short-circuit; defensive
  const s = row.reduce((a, b) => a + b, 0)
  const mx = Math.max(...row)
  const mn = Math.min(...row)
  const s2 = s * s
  return Math.max((side * side * mx) / s2, s2 / (side * side * mn))
}

export function treemap(items: TreemapItem[], W: number, H: number): TreemapRect[] {
  // Invariants the algorithm quietly REQUIRES: areas must be non-negative and
  // rows must be consumed in descending-area order (the sort below) — feed it
  // shuffled or negative values and "worst ratio" stops meaning anything.
  // total <= 0 / zero-dimension boxes return [] rather than divide by zero.
  const total = items.reduce((a, b) => a + b.value, 0)
  if (total <= 0 || W <= 0 || H <= 0) return []
  let remaining: Node[] = items
    .map((it) => ({ ...it, area: (it.value / total) * W * H }))
    .filter((n) => n.area > 0)
    .sort((a, b) => b.area - a.area)

  const rects: TreemapRect[] = []
  let x = 0
  let y = 0
  let w = W
  let h = H

  while (remaining.length && w > 0 && h > 0) {
    const side = Math.min(w, h)
    const row: Node[] = []
    // Greedy: keep appending tiles while the row's worst aspect ratio does
    // not get worse; the first tile always joins (empty-row short-circuit).
    // `<` instead of `<=` would close rows early on aspect ties — a visible
    // (if subtle) layout regression to debug.
    while (remaining.length) {
      const candidate = [...row, remaining[0]]
      if (
        !row.length ||
        worstRatio(candidate.map((n) => n.area), side) <=
          worstRatio(row.map((n) => n.area), side)
      ) {
        row.push(remaining.shift()!)
      } else break
    }
    const rowArea = row.reduce((a, r) => a + r.area, 0)
    // Loop-breaker, not decoration: a zero-area row yields th = 0, the strip
    // never shrinks, and remaining[] never empties → infinite loop. Areas are
    // normalized to exactly W*H, so with all guards active the tiles fill the
    // box with no rounding drift to sweep under the rug.
    if (rowArea <= 0 || side <= 0) break
    if (w >= h) {
      const th = rowArea / h
      let cy = y
      for (const r of row) {
        const rh = r.area / th
        rects.push({ key: r.key, x, y: cy, w: th, h: rh })
        cy += rh
      }
      x += th
      w -= th
    } else {
      const th = rowArea / w
      let cx = x
      for (const r of row) {
        const rw = r.area / th
        rects.push({ key: r.key, x: cx, y, w: rw, h: th })
        cx += rw
      }
      y += th
      h -= th
    }
  }
  return rects
}
