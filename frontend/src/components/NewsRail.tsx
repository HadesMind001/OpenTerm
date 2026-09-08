import { useState } from 'react'
import { ChevronDown, Newspaper } from 'lucide-react'
import { badge, score as sentimentScore } from '../lib/sentiment'
import { useStore } from '../state/store'
import { useNews } from '../state/hooks'

export function NewsRail() {
  const selected = useStore((s) => s.selected)
  const newsMap = useNews()
  const [open, setOpen] = useState(true)

  // The "MARKET" pseudo-key is the no-symbol bucket: applyFrame maps a
  // `news:` topic whose remainder is "" onto it (marketValtio.ts).
  // Under 3 symbol-specific items we pad with market noise — a short list
  // that looks curated beats a curated list that looks empty. 20 shown of
  // the 60-per-bucket cap held in valtio (slice(0, 60) in marketValtio):
  // the rail is an ambient strip, not a reader; the research page is that.
  const symbolNews = selected ? (newsMap[selected] ?? []) : []
  const marketNews = newsMap['MARKET'] ?? []
  const rows = symbolNews.length >= 3 ? symbolNews : [...symbolNews, ...marketNews]
  const shown = open ? rows.slice(0, 20) : []

  return (
    <div className="max-h-56 shrink-0 overflow-hidden border-t border-[var(--border)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)] hover:text-[var(--text)]"
      >
        <Newspaper size={12} /> News
        <span className="text-[var(--amber)]">{rows.length}</span>
        <ChevronDown
          size={12}
          className={`ml-auto transition-transform ${open ? '' : '-rotate-90'}`}
        />
      </button>
      <div className="max-h-44 overflow-y-auto">
        {shown.map((n: any, i) => {
          // Badge source, in order: server-scored n.sentiment (the backend's
          // own lexicon — see lib/sentiment.ts header for how the two drift),
          // and only when absent, the client keyword scorer. Neither is ML;
          // treat the arrow as "headline contained a dramatic word".
          const s = n.sentiment ?? sentimentScore(n.headline ?? '')
          const b = badge(s)
          return (
            <a
              key={`${n.url}-${i}`}
              href={n.url || '#'}
              target="_blank"
              rel="noreferrer"
              className="block border-t border-[var(--border)]/40 px-3 py-1.5 text-xs leading-snug hover:bg-[var(--panel2)]"
            >
              <span style={{ color: b.color }} className="mr-1.5">
                {b.icon}
              </span>
              <span className="mr-2 text-[10px] text-[var(--amber)]">
                {n.source || 'news'}
              </span>
              {n.headline}
            </a>
          )
        })}
        {!open || rows.length === 0 ? null : null}
      </div>
    </div>
  )
}
