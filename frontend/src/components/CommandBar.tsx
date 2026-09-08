import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { api } from '../lib/api'
import { useStore, type Page } from '../state/store'
import type { ResolveResult } from '../lib/types'

// Grammar, evaluated top-to-bottom after uppercasing + whitespace split:
//
//   0. HELP | "?"          → help overlay (handled in submit; parse says null)
//   1. ALERT <SYM> <KIND> <N...>  (≥4 tokens; extra tokens ignored)
//   2. <X> alone, X in PAGE_VERBS → pure page jump (SETTINGS, PORTF, HEAT, …)
//   3. <X> <SYM>, X in SYMBOL_FIRST → symbol + destination page
//      (GP/TAPE/BOOK → chart, DES/HP/NEWS → research)
//   4. "NEWS" alone        → research page
//   5. default             → first token is a symbol, current page untouched
//
// DES and HP live in BOTH maps; precedence above makes "DES" alone a page
// jump and "DES BTC" a symbol open. Reordering rules 2/3 breaks that.
// The "settings" arm of the Parsed union is vestigial: parse() never
// constructs it, rule 2 routes SETTINGS via PAGE_VERBS.

const PAGE_VERBS: Record<string, Page> = {
  SETTINGS: 'settings',
  PORTF: 'analytics',
  BLT: 'blotter',
  SCREEN: 'screen',
  HEAT: 'heatmap',
  HEATMAP: 'heatmap',
  ALERT: 'alerts',
  ALERTS: 'alerts',
  DES: 'research',
  HP: 'research',
  JOUR: 'journal',
}

const SYMBOL_FIRST: Record<string, string> = {
  GP: 'chart',
  DES: 'research',
  NEWS: 'research',
  HP: 'research',
  TAPE: 'chart',
  BOOK: 'chart',
}

interface HelpRow {
  cmd: string
  desc: string
}

const HELP: HelpRow[] = [
  { cmd: '<TICKER>', desc: 'add to watchlist + open (AAPL · BTC · TSLA US)' },
  { cmd: 'AAPL / APPLE', desc: 'aliases work — company names map to tickers' },
  { cmd: '<SYM> GP', desc: 'open chart view' },
  { cmd: '<SYM> DES', desc: 'open research page (52w, peers, news)' },
  { cmd: 'NEWS <SYM>', desc: 'sentiment-tagged headlines for a symbol' },
  { cmd: 'ALERT', desc: 'alerts builder — or ALERT AAPL above 200' },
  { cmd: 'SCREEN', desc: 'screener, movers, heatmap, correlation' },
  { cmd: 'HEAT', desc: 'market heatmap — size by market cap, group by sector' },
  { cmd: 'PORTF', desc: 'portfolio analytics' },
  { cmd: 'BLT', desc: 'order blotter' },
  { cmd: 'JOUR', desc: 'trade journal' },
  { cmd: 'SETTINGS', desc: 'open settings (keybindings, workspaces, scripting)' },
]

export function CommandBar() {
  const [q, setQ] = useState('')
  const [hint, setHint] = useState<ResolveResult | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const addSymbol = useStore((s) => s.addSymbol)
  const setPage = useStore((s) => s.setPage)
  const connected = useStore((s) => s.connected)
  const inputRef = useRef<HTMLInputElement>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      } else if (e.key === '/' && !typing) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', focus)
    return () => window.removeEventListener('keydown', focus)
  }, [])

  interface Parsed {
    action:
      | { t: 'symbol'; sym: string; page?: Page }
      | { t: 'page'; page: Page }
      | { t: 'alert'; sym: string; kind: string; threshold: number }
      | { t: 'settings' }
      | null
  }

  function parse(raw: string): Parsed {
    // One uppercase for the whole line — the verbs and suffix matching below
    // depend on it. But the ALERT kind token is SERVER-side enum (lowercase
    // above/below/pct_up/…/time_below): a "fix" that ships tokens[2] verbatim
    // made `ALERT ETH above 3000` — HELP's own example — arm as "ABOVE" and
    // 400. The submit path lowercases it again; do not remove either half.
    const parts = raw.trim().toUpperCase().split(/\s+/).filter(Boolean)
    if (!parts.length) return { action: null }
    let tokens = parts
    // Yahoo-style "TSLA US EQUITY": drop the exchange suffixes. The rule is
    // "both US AND EQUITY appear ANYWHERE after token 0, then keep token 0
    // only" — so "TSLA US EQUITY FOO" silently eats FOO, and "DES US EQUITY"
    // (ticker literally US!) loses the symbol and becomes a bare research
    // jump. Single "TSLA US" is NOT stripped (needs both words) and survives
    // as the raw query instead — server-side resolve is the one normalizing
    // suffixes there.
    if (
      tokens.length > 1 &&
      ['US', 'EQUITY'].every((s) => tokens.slice(1).includes(s))
    ) {
      tokens = [tokens[0]]
    }

    if (tokens[0] === 'HELP' || raw === '?') return { action: null }

    if (tokens[0] === 'ALERT' && tokens.length >= 4) {
      // Non-numeric threshold does NOT error — it falls out of this branch
      // and the whole line becomes a symbol lookup for "ALERT". Ux bug, not
      // a correctness one; the resolve just fails.
      const kw = tokens[2]
      const thr = parseFloat(tokens[3])
      if (!isNaN(thr)) {
        return { action: { t: 'alert', sym: tokens[1], kind: kw, threshold: thr } }
      }
    }
    if (tokens.length === 1 && tokens[0] in PAGE_VERBS) {
      return { action: { t: 'page', page: PAGE_VERBS[tokens[0]] as Page } }
    }
    if (tokens.length >= 2 && tokens[0] in SYMBOL_FIRST) {
      return { action: { t: 'symbol', sym: tokens[1], page: SYMBOL_FIRST[tokens[0]] as Page } }
    }
    if (tokens.length === 1 && tokens[0] === 'NEWS') {
      return { action: { t: 'page', page: 'research' } }
    }
    return { action: { t: 'symbol', sym: tokens[0] } }
  }

  useEffect(() => {
    window.clearTimeout(timer.current)
    const parsed = parse(q)
    setHint(null)
    setMsg('')
    if (parsed.action?.t !== 'symbol') return
    const sym = parsed.action.sym
    if (!sym) return
    // Debounce exists because the input is keystroke-fed; 180 ms is "type a
    // word" speed, not a tuned number. Invariant to know: the HINT resolves
    // parse()'s first token while submit() sends the RAW line to the server
    // (see addSymbol below) — suffix-y queries can resolve to different
    // things in hint vs reality.
    timer.current = window.setTimeout(async () => {
      setHint(await api.resolve(sym))
    }, 180)
    return () => window.clearTimeout(timer.current)
  }, [q])

  const submit = async () => {
    const raw = q.trim()
    if (!raw) return
    if (raw.toUpperCase() === 'HELP' || raw === '?') {
      setHelpOpen(true)
      setQ('')
      return
    }
    const parsed = parse(raw)

    try {
      if (parsed.action?.t === 'page') {
        setPage(parsed.action.page)
        setQ('')
        return
      }
      if (parsed.action?.t === 'alert') {
        const a = parsed.action
        const res = await api.resolve(a.sym)
        if (!res) {
          setMsg(`unknown symbol ${a.sym}`)
          return
        }
        await api.addAlert({
          symbol_key: res.symbol_key,
          // see parse(): the line was uppercased, the enum is lowercase
          kind: a.kind.toLowerCase(),
          threshold: a.threshold,
        })
        setPage('alerts')
        setQ('')
        setMsg(`armed ${res.ticker} ${a.kind} ${a.threshold}`)
        window.setTimeout(() => setMsg(''), 2500)
        return
      }
      if (parsed.action?.t === 'settings') {
        const page: Page = 'settings'
        setPage(page)
        setQ('')
        return
      }
      if (parsed.action?.t === 'symbol') {
        // Deliberately the RAW line, not parsed.action.sym: the server's
        // resolver knows aliases ("APPLE") and suffixes ("TSLA US") that the
        // local parser is not allowed to duplicate.
        const key = await addSymbol(q.trim())
        if (key) {
          if (parsed.action.page && parsed.action.page !== 'chart') {
            setPage(parsed.action.page)
          }
          setQ('')
          setHint(null)
        }
      }
    } catch (err) {
      setMsg(String(err instanceof Error ? err.message : err).slice(0, 100))
      window.setTimeout(() => setMsg(''), 3000)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-2">
        <span className="select-none font-bold tracking-widest text-[var(--amber)]">
          OPEN<span className="text-[var(--text)]">TERM</span>
        </span>
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-2 text-[var(--dim)]" />
          <input
            id="cmd-input"
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') {
                setQ('')
                setHelpOpen(false)
                inputRef.current?.blur()
              }
            }}
            placeholder="Command…  AAPL · APPLE · GP TSLA · DES BTC · ALERT ETH above 3000 · HELP   (Ctrl+K)"
            spellCheck={false}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] py-1.5 pl-8 pr-28 outline-none placeholder:text-[var(--dim)]/60 focus:border-[var(--amber)]"
          />
          {msg && (
            <div className="pointer-events-none absolute right-2 top-1.5 text-[11px] text-[var(--down)]">
              {msg}
            </div>
          )}
          {!msg && hint && (
            <div className="pointer-events-none absolute right-2 top-1.5 flex items-center gap-1.5 text-[11px]">
              <span className="rounded-sm bg-[var(--panel2)] px-1.5 py-0.5 text-[var(--dim)]">
                {hint.asset_class}
              </span>
              <span className="text-[var(--amber)]">{hint.symbol_key}</span>
              <span className="text-[var(--dim)]">↵</span>
            </div>
          )}
        </div>
        <button
          onClick={() => setHelpOpen(true)}
          title="help"
          className="rounded border border-[var(--border)] px-2 py-1 text-[10px] uppercase text-[var(--dim)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
        >
          ?
        </button>
        <span
          className={`h-2 w-2 rounded-full ${connected ? 'bg-[var(--up)]' : 'bg-[var(--down)]'}`}
          title={connected ? 'stream connected' : 'disconnected'}
        />
      </div>
      {helpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="w-[520px] rounded border border-[var(--border)] bg-[var(--panel)] p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="font-bold tracking-widest text-[var(--amber)]">
                COMMAND REFERENCE
              </span>
              <button
                onClick={() => setHelpOpen(false)}
                className="text-[var(--dim)] hover:text-[var(--text)]"
              >
                esc
              </button>
            </div>
            <table className="w-full text-xs">
              <tbody>
                {HELP.map((h) => (
                  <tr key={h.cmd} className="border-b border-[var(--border)]/30">
                    <td className="w-40 py-1.5 pr-3 font-mono font-bold text-[var(--amber)]">
                      {h.cmd}
                    </td>
                    <td className="py-1.5 text-[var(--dim)]">{h.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 text-[10px] text-[var(--dim)]">
              Ctrl+K or / focuses the command line · Esc clears
            </div>
          </div>
        </div>
      )}
    </>
  )
}
