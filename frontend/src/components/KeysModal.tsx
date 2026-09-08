import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Save,
  X,
  XCircle,
} from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../state/store'
import type { SettingsInfo } from '../lib/types'

// WHOSE key goes WHERE. The Field.key strings below are the wire format:
// they must match the KeysUpdate pydantic model in
// backend/openterm/api/routes.py character-for-character, because that is
// also the JSON key written into ~/.config/openterm/config.json (saved 0600
// via a private temp file + rename — the old write-then-chmod had a
// world-readable window with live keys in it; do not "simplify" the server
// side). The json-key ↔ env-name pairs, per core/config.py pick():
//   finnhub_key/FINNHUB_API_KEY · fred_key/FRED_API_KEY ·
//   polygon_key/POLYGON_API_KEY · oanda_token/OANDA_TOKEN ·
//   oanda_account/OANDA_ACCOUNT_ID · alpaca_key_id/APCA_API_KEY_ID ·
//   alpaca_secret_key/APCA_API_SECRET_KEY — env WINS over config.json, so a
//   field here can look unset-able while the provider dot stays green.
//   (Alpaca needs BOTH halves; bool(key_id and secret) gates its availability.)
//
// Nothing here ever sees a stored value: GET /api/settings returns
// availability BOOLEANS only, which is why every input starts empty and the
// "••••••••" is a placeholder, not masked data. Consequences baked into the
// state below: typing into a set field = OVERWRITE (not append), and the
// `cleared` set is the only way to express "delete this key" — omitted
// fields mean "leave alone", explicit '' means "remove". Getting that
// omission-vs-empty distinction wrong silently resurrects deleted keys.
interface Field {
  key:
    | 'finnhub_key'
    | 'fred_key'
    | 'polygon_key'
    | 'oanda_token'
    | 'oanda_account'
    | 'alpaca_key_id'
    | 'alpaca_secret_key'
  label: string
  placeholder?: string
}

interface Provider {
  id: 'finnhub' | 'fred' | 'polygon' | 'oanda' | 'alpaca'
  name: string
  desc: string
  unlock: string
  get: string
  fields: Field[]
}

const PROVIDERS: Provider[] = [
  {
    id: 'finnhub',
    name: 'Finnhub',
    desc: 'Fundamentals & market data',
    unlock: 'Heatmap market caps + sectors, earnings calendar, company profiles.',
    get: 'https://finnhub.io/register',
    fields: [{ key: 'finnhub_key', label: 'API key' }],
  },
  {
    id: 'polygon',
    name: 'Polygon.io',
    desc: 'Deep equity history',
    unlock: 'Extended intra-day backfill for equities beyond Yahoo.',
    get: 'https://polygon.io/dashboard/signup',
    fields: [{ key: 'polygon_key', label: 'API key' }],
  },
  {
    id: 'alpaca',
    name: 'Alpaca',
    desc: 'Paper trading (US equities)',
    unlock: 'Route orders to your Alpaca paper account — real fills, zero risk.',
    get: 'https://app.alpaca.markets/signup',
    fields: [
      { key: 'alpaca_key_id', label: 'Key ID' },
      { key: 'alpaca_secret_key', label: 'Secret key' },
    ],
  },
  {
    id: 'fred',
    name: 'FRED',
    desc: 'Macro data (CPI, rates)',
    unlock: 'Macro dashboard panels: CPI, Fed funds, unemployment, yield curve.',
    get: 'https://fred.stlouisfed.org/docs/api/api_key.html',
    fields: [{ key: 'fred_key', label: 'API key' }],
  },
  {
    id: 'oanda',
    name: 'OANDA',
    desc: 'Live FX prices (practice)',
    unlock: 'Streaming forex quotes and trading on a practice account.',
    get: 'https://www.oanda.com/demo-account/',
    fields: [
      { key: 'oanda_token', label: 'Practice token' },
      { key: 'oanda_account', label: 'Account ID' },
    ],
  },
]

export function KeysModal() {
  const open = useStore((s) => s.keysOpen)
  const setOpen = useStore((s) => s.setKeysOpen)
  const pushToast = useStore((s) => s.pushToast)
  const [info, setInfo] = useState<SettingsInfo | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [cleared, setCleared] = useState<Set<string>>(new Set())
  const [show, setShow] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, { ok: boolean; error?: string }>>({})

  useEffect(() => {
    if (open) void api.settings().then(setInfo).catch(() => undefined)
  }, [open])

  if (!open) return null

  const setVal = (key: string, v: string) => {
    setValues((prev) => ({ ...prev, [key]: v }))
    if (v !== '') setCleared((prev) => new Set([...prev].filter((k) => k !== key)))
  }

  const markClear = (key: string) => {
    setValues((prev) => ({ ...prev, [key]: '' }))
    setCleared((prev) => new Set(prev).add(key))
  }

  const test = async (p: Provider) => {
    const key = p.fields[0].key
    setTesting((prev) => ({ ...prev, [p.id]: '…' }))
    setResults((prev) => {
      const next = { ...prev }
      delete next[p.id]
      return next
    })
    try {
      // testKey tests CANDIDATES, unsaved: field 0 rides as `key`, plus the
      // second credential for the two-part providers (oanda needs the account
      // for its URL; alpaca needs the secret alongside the key id). Blank
      // candidate fields are omitted so the server falls back to stored
      // values for that provider — hence "not saved ≠ untested".
      const body: { key?: string; oanda_account?: string; secret?: string } = {}
      const val = (values[key] ?? '').trim()
      if (val) body.key = val
      if (p.id === 'oanda') {
        const acct = (values.oanda_account ?? '').trim()
        if (acct) body.oanda_account = acct
      }
      if (p.id === 'alpaca') {
        const secret = (values.alpaca_secret_key ?? '').trim()
        if (secret) body.secret = secret
      }
      const res = await api.testKey(p.id, body)
      setResults((prev) => ({ ...prev, [p.id]: res }))
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [p.id]: { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 120) },
      }))
    } finally {
      setTesting((prev) => {
        const next = { ...prev }
        delete next[p.id]
        return next
      })
    }
  }

  const save = async () => {
    const body: Record<string, string> = {}
    for (const f of PROVIDERS.flatMap((p) => p.fields)) {
      const v = (values[f.key] ?? '').trim()
      if (v) body[f.key] = v
      else if (cleared.has(f.key)) body[f.key] = ''
    }
    if (!Object.keys(body).length) {
      pushToast('info', 'nothing changed')
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      const res = await api.saveKeys(body)
      if (typeof res.available?.alpaca === 'boolean') {
        useStore.getState().setAlpacaReady(res.available.alpaca)
      }
      pushToast(
        'info',
        `keys saved (${res.saved.length}) — applied live`,
      )
      setValues({})
      setCleared(new Set())
      setResults({})
      setInfo(await api.settings())
    } catch (err) {
      pushToast('error', String(err instanceof Error ? err.message : err).slice(0, 140))
    } finally {
      setBusy(false)
    }
  }

  // The old predicate ignored its parameter entirely (some((f) => <bool of p>))
  // — which just means "any fields AND provider marked available". Stated
  // directly now, with the accidental closure gone.
  const isSet = (p: Provider) => Boolean(info?.available[p.id])
  const dot = (p: Provider) =>
    isSet(p)
      ? 'bg-[var(--up)]'
      : 'bg-[var(--border)]'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => setOpen(false)}
    >
      <div
        className="max-h-[88vh] w-[520px] overflow-y-auto rounded border border-[var(--border)] bg-[var(--panel)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <KeyRound size={16} className="text-[var(--amber)]" />
          <span className="font-bold uppercase tracking-widest">Settings · API keys</span>
          <button onClick={() => setOpen(false)} className="ml-auto text-[var(--dim)] hover:text-[var(--text)]">
            <X size={15} />
          </button>
        </div>

        <div className="mb-3 rounded border border-[var(--border)] bg-[var(--bg)]/50 p-2 text-[10px] leading-snug text-[var(--dim)]">
          Keys unlock the extras — add one to light up its provider. All keys stay local
          (<code>{info?.config_path ?? '~/.config/openterm/config.json'}</code>, chmod 600)
          and apply live, no restart needed.
        </div>

        <div className="space-y-3">
          {PROVIDERS.map((p) => {
            const set = isSet(p)
            const testingState = testing[p.id]
            const res = results[p.id]
            return (
              <div
                key={p.id}
                className="rounded border border-[var(--border)] p-2.5"
              >
                <div className="flex items-start gap-2">
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot(p)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold">{p.name}</span>
                      <span className="text-[9px] uppercase tracking-wider text-[var(--dim)]">
                        {p.desc}
                      </span>
                      {set && (
                        <span className="flex items-center gap-0.5 text-[9px] uppercase text-[var(--up)]">
                          <CheckCircle2 size={10} /> saved
                        </span>
                      )}
                      <a
                        href={p.get}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto flex items-center gap-0.5 text-[9px] uppercase text-[var(--amber)] hover:underline"
                      >
                        get key <ExternalLink size={9} />
                      </a>
                    </div>
                    <p className="mt-0.5 text-[10px] leading-snug text-[var(--dim)]">
                      {p.unlock}
                    </p>
                  </div>
                </div>

                <div className="mt-2 space-y-1.5 pl-3.5">
                  {p.fields.map((f) => {
                    const visible = show.has(f.key)
                    const isSetField = set && !cleared.has(f.key)
                    return (
                      <div key={f.key} className="flex items-center gap-1.5">
                        <input
                          type={visible ? 'text' : 'password'}
                          value={values[f.key] ?? ''}
                          onChange={(e) => setVal(f.key, e.target.value)}
                          placeholder={isSetField ? '••••••••' : f.placeholder ?? 'not set'}
                          spellCheck={false}
                          autoComplete="off"
                          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-xs outline-none placeholder:text-[var(--dim)]/60 focus:border-[var(--amber)]"
                        />
                        <button
                          onClick={() =>
                            setShow((prev) => {
                              const next = new Set(prev)
                              if (next.has(f.key)) next.delete(f.key)
                              else next.add(f.key)
                              return next
                            })
                          }
                          className="p-1 text-[var(--dim)] hover:text-[var(--text)]"
                          title={visible ? 'hide' : 'show'}
                        >
                          {visible ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                        {isSetField && (
                          <button
                            onClick={() => markClear(f.key)}
                            className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[9px] uppercase text-[var(--dim)] hover:border-[var(--down)] hover:text-[var(--down)]"
                            title="remove this key"
                          >
                            clear
                          </button>
                        )}
                        {!isSetField && cleared.has(f.key) && (
                          <button
                            onClick={() =>
                              setCleared((prev) => {
                                const next = new Set(prev)
                                next.delete(f.key)
                                return next
                              })
                            }
                            className="text-[9px] uppercase text-[var(--down)]"
                          >
                            undo
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="mt-2 flex items-center gap-2 pl-3.5">
                  <button
                    onClick={() => void test(p)}
                    disabled={!!testingState}
                    className="flex items-center gap-1.5 rounded border border-[var(--border)] px-2 py-0.5 text-[9px] uppercase text-[var(--dim)] hover:border-[var(--amber)] hover:text-[var(--amber)] disabled:opacity-40"
                  >
                    {testingState ? (
                      <>
                        <Loader2 size={10} className="animate-spin" /> testing {testingState}
                      </>
                    ) : (
                      'test connection'
                    )}
                  </button>
                  {res &&
                    (res.ok ? (
                      <span className="flex items-center gap-1 text-[9px] uppercase text-[var(--up)]">
                        <CheckCircle2 size={10} /> connected
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[9px] uppercase text-[var(--down)]">
                        <XCircle size={10} /> {res.error ?? 'failed'}
                      </span>
                    ))}
                </div>
              </div>
            )
          })}
        </div>

        <button
          onClick={() => void save()}
          disabled={busy}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded bg-[var(--amber)] py-1.5 font-bold text-black hover:opacity-90 disabled:opacity-40"
        >
          <Save size={13} /> {busy ? 'saving…' : 'save & apply'}
        </button>
      </div>
    </div>
  )
}
