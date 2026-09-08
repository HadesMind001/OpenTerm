import { useState } from 'react'
import { BrainIcon } from 'lucide-react'
import { useStore } from '../state/store'
import { api } from '../lib/api'
import type { ScriptResult } from '../lib/types'

export type { ScriptResult }

// ── Scripts console ────────────────────────────────────────────────────
//
// Runs Python in a resource-limited SUBPROCESS as your user (backend
// services/scripting.py). It is NOT a security sandbox — the panel used to
// advertise "Sandboxed Python" while the "sandbox" had two NameErrors (so
// nothing ever ran) and a str.replace() "filter" a rubber duck could escape.
// The naming here now matches reality: local convenience, local trust.
//
// Previous versions also had: no text input at all (the "code" area was a
// select-none div), example snippets whose \n were literal backslash-n (so
// every example was a guaranteed SyntaxError in Python), and an "output"
// area with broken JSX precedence ({error || output && (...)}) that rendered
// raw error strings as bare children. All gone; don't resurrect them.

interface Example {
  title: string
  code: string
}

// NOTE the actual newlines. The old snippets used '\\n' inside single quotes
// — a literal backslash-n sent straight into Python as a SyntaxError, which
// was then blamed on "the sandbox being broken". It was and it wasn't.
const EXAMPLES: Example[] = [
  {
    title: 'stats basics',
    code: [
      'from statistics import mean, pstdev',
      'closes = [100, 102, 101, 105, 103, 108, 110, 107, 109, 112]',
      'sma = mean(closes)',
      'vol = pstdev(closes) / mean(closes) * 100',
      'print(f"mean {sma:.2f}  cvol {vol:.2f}%")',
    ].join('\n'),
  },
  {
    title: 'sma crossover sim',
    code: [
      'closes = [float(x) for x in range(100, 140)]',
      'def sma(series, n):',
      '    out = []',
      '    for i in range(n - 1, len(series)):',
      '        out.append(sum(series[i - n + 1:i + 1]) / n)',
      '    return out',
      'fast, slow = sma(closes, 3), sma(closes, 7)',
      'signals = sum(1 for a, b in zip(fast[4:], slow) if a > b)',
      'print(f"{signals} fast-above-slow windows")',
    ].join('\n'),
  },
  {
    title: 'query the local api',
    code: [
      '# the backend is a normal HTTP server — stdlib urllib can hit it:',
      'import json, urllib.request',
      'rows = json.load(urllib.request.urlopen("http://127.0.0.1:8000/api/universe"))',
      'top = sorted(rows, key=lambda r: r.get("change_pct") or 0)[-5:]',
      'for r in top:',
      '    print(f"{r[\'ticker\']:<10} {r.get(\'change_pct\')}%")',
    ].join('\n'),
  },
]

export function ScriptsConsole() {
  const [code, setCode] = useState(EXAMPLES[0].code)
  const [output, setOutput] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [vars, setVars] = useState<Record<string, string>>({})
  const pushToast = useStore((s) => s.pushToast)

  const handleRun = async () => {
    if (!code.trim()) {
      pushToast('error', 'enter script code first')
      return
    }
    setRunning(true)
    setOutput('')
    setError(null)
    setVars({})
    try {
      const result = await api.runScript(code)
      setOutput(result.output || '')
      setError(result.error || null)
      setVars(result.variables || {})
      if (!result.success) {
        pushToast('error', result.error || 'script failed')
      } else {
        pushToast('info', 'script executed')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'script execution failed'
      setError(msg)
      pushToast('error', msg)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--panel)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-wider text-[var(--dim)]">
        <BrainIcon size={13} /> Scripts
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel2)] px-2 py-1">
        <select
          aria-label="load example"
          onChange={(e) => {
            const ex = EXAMPLES.find((x) => x.title === e.target.value)
            if (ex) setCode(ex.code)
            e.target.value = ''
          }}
          defaultValue=""
          className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-xs outline-none"
        >
          <option value="" disabled>
            load example…
          </option>
          {EXAMPLES.map((ex) => (
            <option key={ex.title} value={ex.title}>
              {ex.title}
            </option>
          ))}
        </select>
        <button
          onClick={handleRun}
          disabled={running}
          className={`flex-1 rounded-md bg-[var(--amber)] py-1.5 font-medium text-black transition-colors hover:opacity-90 disabled:opacity-40 ${running ? 'animate-pulse' : ''}`}
        >
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        spellCheck={false}
        className="h-2/5 min-h-24 w-full resize-none bg-[var(--bg)] px-2 py-1 font-mono text-xs text-[var(--text)] outline-none"
        placeholder="# local python, runs as YOUR user — not a sandbox"
      />

      <div className="flex-1 overflow-auto px-2 py-1 font-mono text-xs">
        {error ? (
          <pre className="mb-2 whitespace-pre-wrap text-[var(--down)]">
            <strong>error</strong>{'\n'}
            {error}
          </pre>
        ) : null}
        {output ? (
          <pre className="mb-2 whitespace-pre-wrap text-[var(--text)]">{output}</pre>
        ) : null}
        {Object.entries(vars).map(([k, v]) => (
          <div key={k} className="text-[var(--dim)]">
            <span className="text-[var(--text)]">{k}</span> = {v}
          </div>
        ))}
        {!output && !error && !running && (
          <p className="text-[var(--dim)]">output will appear here</p>
        )}
      </div>
    </div>
  )
}
