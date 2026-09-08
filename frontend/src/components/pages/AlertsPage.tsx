import { useEffect, useState } from 'react'
import { BellRing, Moon, Trash2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useStore } from '../../state/store'
import type { AlertFire, AlertKind, AlertRule } from '../../lib/types'

const KINDS: Array<[AlertKind, string]> = [
  ['above', 'price ≥'],
  ['below', 'price ≤'],
  ['pct_up', '% move up'],
  ['pct_dn', '% move down'],
  ['rsi_above', 'RSI ≥ (1m)'],
  ['rsi_below', 'RSI ≤ (1m)'],
  ['vol_spike', 'volume spike ×'],
]
const PCT_KINDS: AlertKind[] = ['pct_up', 'pct_dn']

function fmt(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: d })
}

export function AlertsPage() {
  const selected = useStore((s) => s.selected)
  const pushToast = useStore((s) => s.pushToast)
  const alertTick = useStore((s) => s.alertTick)
  const [rules, setRules] = useState<AlertRule[]>([])
  const [fires, setFires] = useState<AlertFire[]>([])
  const [symbol, setSymbol] = useState('')
  const [kind, setKind] = useState<AlertKind>('above')
  const [threshold, setThreshold] = useState('')
  const [oneShot, setOneShot] = useState(true)
  const [cooldown, setCooldown] = useState('300')

  useEffect(() => {
    if (selected && !symbol) setSymbol(selected.split(':').pop() ?? '')
  }, [selected])

  const reload = () => {
    void api.alerts().then(setRules)
    void api.alertFires().then(setFires)
  }
  useEffect(reload, [alertTick])

  const create = async () => {
    const thr = parseFloat(threshold)
    if (!symbol || !thr || isNaN(thr)) {
      pushToast('error', 'enter symbol + threshold')
      return
    }
    let key = symbol.toUpperCase()
    if (!key.includes(':')) {
      const res = await api.resolve(key)
      if (!res) {
        pushToast('error', `unknown symbol ${key}`)
        return
      }
      key = res.symbol_key
    }
    try {
      await api.addAlert({ symbol_key: key, kind, threshold: thr, one_shot: oneShot, cooldown: parseInt(cooldown) || 300 })
      pushToast('info', `alert armed — ${key} ${kind} ${thr}`)
      setThreshold('')
      reload()
    } catch (err) {
      pushToast('error', String(err).slice(0, 140))
    }
  }

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--dim)]">
        <BellRing size={13} /> Alert builder
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded border border-[var(--border)] bg-[var(--panel)] p-3 text-xs">
        <div>
          <label className="block text-[9px] uppercase text-[var(--dim)]">symbol</label>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="AAPL"
            className="w-20 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 uppercase outline-none focus:border-[var(--amber)]"
          />
        </div>
        <div>
          <label className="block text-[9px] uppercase text-[var(--dim)]">condition</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AlertKind)}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 outline-none"
          >
            {KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[9px] uppercase text-[var(--dim)]">
            threshold
          </label>
          <input
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="100"
            className="w-24 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 tabular-nums outline-none focus:border-[var(--amber)]"
          />
        </div>
        {PCT_KINDS.includes(kind) && (
          <span className="pb-1.5 text-[10px] text-[var(--dim)]">
            measured from price when armed
          </span>
        )}
        <label className="flex items-center gap-1 pb-1">
          <input type="checkbox" checked={oneShot} onChange={(e) => setOneShot(e.target.checked)} />
          <span className="text-[var(--dim)]">one-shot</span>
        </label>
        {!oneShot && (
          <div>
            <label className="block text-[9px] uppercase text-[var(--dim)]">
              cooldown s
            </label>
            <input
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
              className="w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 tabular-nums outline-none"
            />
          </div>
        )}
        <button
          onClick={() => void create()}
          className="rounded bg-[var(--amber)] px-3 py-1 font-bold text-black hover:opacity-90"
        >
          arm alert
        </button>
      </div>

      <div className="mb-1 mt-5 text-[10px] uppercase tracking-wider text-[var(--amber)]">
        Armed rules ({rules.length})
      </div>
      <table className="w-full text-xs tabular-nums">
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className="border-b border-[var(--border)]/30">
              <td className="py-1 pr-2 font-semibold">{r.symbol_key.split(':').pop()}</td>
              <td className="py-1 pr-2 uppercase text-[var(--dim)]">{r.kind}</td>
              <td className="py-1 pr-2">@{fmt(r.threshold)}</td>
              <td className="py-1 pr-2 text-[10px] text-[var(--dim)]">
                {r.ref_price ? `ref ${fmt(r.ref_price)}` : ''}
              </td>
              <td className="py-1 pr-2 text-[10px] text-[var(--dim)]">
                {r.one_shot ? 'one-shot' : `cd ${r.cooldown}s`}
                {r.snooze_until > Date.now() / 1000 ? ' · 💤' : ''}
              </td>
              <td className="py-1 pr-2 text-right">
                {!r.one_shot && (
                  <button
                    title="snooze 30m"
                    onClick={() => {
                      void api.snoozeAlert(r.id, 1800).then(reload)
                    }}
                    className="mr-1 text-[var(--dim)] hover:text-[var(--text)]"
                  >
                    <Moon size={12} />
                  </button>
                )}
                <button
                  onClick={() => void api.removeAlert(r.id).then(reload)}
                  className="opacity-40 hover:text-[var(--down)]"
                >
                  <Trash2 size={12} />
                </button>
              </td>
            </tr>
          ))}
          {!rules.length && (
            <tr>
              <td colSpan={6} className="py-3 text-center text-[var(--dim)]">
                no alerts armed
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="mb-1 mt-5 text-[10px] uppercase tracking-wider text-[var(--dim)]">
        Fire history
      </div>
      <table className="w-full text-xs tabular-nums opacity-80">
        <tbody>
          {fires.map((f) => (
            <tr key={f.id} className="border-b border-[var(--border)]/20">
              <td className="py-0.5 pr-2 text-[var(--dim)]">
                {new Date(f.ts * 1000).toLocaleTimeString()}
              </td>
              <td className="py-0.5 pr-2 font-semibold">{f.symbol_key.split(':').pop()}</td>
              <td className="py-0.5 pr-2 uppercase text-[var(--dim)]">{f.kind}</td>
              <td className={`py-0.5 ${f.kind.includes('below') || f.kind === 'pct_dn' ? 'text-[var(--down)]' : 'text-[var(--up)]'}`}>
                @ {fmt(f.price)}
              </td>
            </tr>
          ))}
          {!fires.length && (
            <tr>
              <td className="py-3 text-center text-[var(--dim)]">nothing fired yet</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
