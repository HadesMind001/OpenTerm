/**
 * Dumb keyword counting, NOT machine learning. It never was and the UI must
 * never pretend it is: the news badges are decoration over a coin flip with
 * a vocabulary. The word lists were hand-picked for financial headline verbs
 * ("plunge", "upgrade", …); anything else scores 0.
 *
 * Known cracks, kept honest:
 * - the 'record high' entry in POS is dead code: score() matches single
 *   whitespace-split tokens, so the two-word key can never hit;
 * - hyphens become spaces, so "profit-taking" counts as "profit" (POS) —
 *   no negation handling ("no growth" reads bullish);
 * - no ticker awareness: "AAPL beats estimates, EPS misses" nets ~0.
 *
 * backend/openterm/services/sentiment.py is a SIBLING, not a copy: it matches
 * multi-word phrases ("record high" actually scores there) and weights
 * negative phrases double, so this file and the server drift apart on
 * real headlines. Server-provided n.sentiment wins wherever both exist
 * (see NewsRail); the client scorer is fallback decoration only.
 */
const POS = new Set([
  'beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'rally', 'rallies',
  'gain', 'gains', 'jump', 'jumps', 'climb', 'climbs', 'upgrade', 'upgraded',
  'outperform', 'bullish', 'optimism', 'strong', 'growth', 'profit',
  'profits', 'boost', 'boosts', 'rise', 'rises', 'recover', 'rebounds',
  'wins', 'approval', 'breakthrough', 'expands', 'dividend', 'buyback',
  'uptrend', 'higher', 'tops', 'record high',
])

const NEG = new Set([
  'miss', 'misses', 'plunge', 'plunges', 'slump', 'slumps', 'crash',
  'crashes', 'drop', 'drops', 'fall', 'falls', 'sink', 'sinks', 'tumble',
  'downgrade', 'downgraded', 'underperform', 'bearish', 'fear', 'fears',
  'weak', 'loss', 'losses', 'recession', 'layoffs', 'lawsuit', 'probe',
  'fraud', 'warning', 'warns', 'cuts', 'halted', 'bankruptcy', 'default',
  'selloff', 'downtrend', 'lower', 'decline', 'crisis',
])

export function score(headline: string): number {
  const words = headline.toLowerCase().replace(/-/g, ' ').split(/\s+/)
  let pos = 0
  let neg = 0
  for (const raw of words) {
    const w = raw.replace(/[.,:;!?"'()]/g, '')
    if (POS.has(w)) pos++
    if (NEG.has(w)) neg++
  }
  const total = pos + neg
  return total === 0 ? 0 : Math.round(((pos - neg) / total) * 1000) / 1000
}

// ±0.25 is a judgement call, not math: one matched word on a two-word hit is
// ±0.5 and labels bull/bear. Keep badge()'s thresholds in sync with label().
export function label(v: number): 'bull' | 'bear' | 'neutral' {
  return v >= 0.25 ? 'bull' : v <= -0.25 ? 'bear' : 'neutral'
}

export function badge(v?: number): { icon: string; color: string } {
  if (v === undefined)
    return { icon: '', color: '' }
  if (v >= 0.25) return { icon: '▲', color: 'var(--up)' }
  if (v <= -0.25) return { icon: '▼', color: 'var(--down)' }
  return { icon: '=', color: 'var(--dim)' }
}
