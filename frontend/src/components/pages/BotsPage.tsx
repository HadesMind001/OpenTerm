import React, { useCallback, useEffect, useState } from 'react'
import {
  Plus,
  Play,
  Square,
  RefreshCw,
  Terminal,
  X,
  Loader2,
  FileText,
  Trash2,
  Upload,
  SlidersHorizontal,
  Save,
  RotateCw,
  Sparkles,
  Rocket,
} from 'lucide-react'
import { api } from '../../lib/api'
import { useBots, useBotLogs, useBotStats } from '../../state/botHooks'
import { useStore } from '../../state/store'
import type { BotInfo, BotState, BotExample } from '../../state/store'

function fmt(n: number | undefined | null): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return String(n)
}

function StateBadge({ state }: { state: BotState }) {
  const colors: Record<BotState, string> = {
    running: 'bg-[var(--up)]/20 text-[var(--up)]',
    starting: 'bg-[var(--amber)]/20 text-[var(--amber)]',
    stopped: 'bg-[var(--dim)]/20 text-[var(--dim)]',
    stopping: 'bg-[var(--amber)]/20 text-[var(--amber)]',
    error: 'bg-[var(--down)]/20 text-[var(--down)]',
    killed: 'bg-[var(--down)]/20 text-[var(--down)]',
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${colors[state] ?? colors.stopped}`}
    >
      {state.charAt(0).toUpperCase() + state.slice(1)}
    </span>
  )
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return ts?.slice(11, 19) ?? ''
  }
}

function logLevelClass(level: string): string {
  if (level === 'warn') return 'text-[var(--amber)]'
  if (level === 'error') return 'text-[var(--down)]'
  if (level === 'debug') return 'text-[var(--up)]'
  return 'text-[var(--dim)]'
}

type StatsRecord = Record<string, any>

const STAT_ROWS: Array<[string, string]> = [
  ['Callbacks', 'callbacks_executed'],
  ['Orders', 'orders_placed'],
  ['Filled', 'orders_filled'],
  ['Signals', 'signals_emitted'],
  ['Fuel', 'fuel_consumed'],
  ['Peak Mem', 'peak_memory_mb'],
]

type ConfigRow = { key: string; value: string }

function rowsFromConfig(config: Record<string, any> | undefined): ConfigRow[] {
  return Object.entries(config ?? {}).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }))
}

function parseConfigValue(raw: string): unknown {
  const t = raw.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t)
  try {
    return JSON.parse(t)
  } catch {
    return raw
  }
}

function ConfigPanel({
  bot,
  busy,
  setBusy,
}: {
  bot: BotInfo
  busy: boolean
  setBusy: (b: boolean) => void
}) {
  const updateBot = useStore((s) => s.updateBot)
  const pushToast = useStore((s) => s.pushToast)
  const [rows, setRows] = useState<ConfigRow[]>(() => rowsFromConfig(bot.config))

  useEffect(() => {
    setRows(rowsFromConfig(bot.config))
  }, [bot.bot_id, bot.config])

  const baseRows = rowsFromConfig(bot.config)
  const dirty = JSON.stringify(rows) !== JSON.stringify(baseRows)
  const namedRows = rows.filter((r) => r.key.trim() !== '')
  const dupKeys = new Set(namedRows.map((r) => r.key.trim())).size !== namedRows.length

  const save = async (restart: boolean) => {
    setBusy(true)
    try {
      const config: Record<string, unknown> = {}
      for (const r of namedRows) config[r.key.trim()] = parseConfigValue(r.value)
      await api.updateBotConfig(bot.bot_id, config)
      updateBot({ ...bot, config })
      if (restart) updateBot(await api.restartBot(bot.bot_id))
      pushToast('info', restart ? 'Config saved — bot restarted' : 'Config saved')
    } catch (e: any) {
      pushToast('error', `config: ${String(e?.message ?? e).slice(0, 140)}`)
    } finally {
      setBusy(false)
    }
  }

  const running = bot.state === 'running' || bot.state === 'starting'

  return (
    <div className="mt-4">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)] mb-2">
        <SlidersHorizontal size={11} /> Config
      </div>
      <div className="space-y-1">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              value={row.key}
              onChange={(e) =>
                setRows((rs) => rs.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
              }
              placeholder="param"
              spellCheck={false}
              className="w-[40%] min-w-0 px-1.5 py-1 text-[10px] font-mono rounded border border-[var(--border)] bg-[var(--bg)] outline-none focus:border-[var(--amber)]"
            />
            <input
              value={row.value}
              onChange={(e) =>
                setRows((rs) => rs.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
              }
              placeholder="value"
              spellCheck={false}
              className="flex-1 min-w-0 px-1.5 py-1 text-[10px] font-mono rounded border border-[var(--border)] bg-[var(--bg)] outline-none focus:border-[var(--amber)]"
            />
            <button
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              className="p-1 rounded text-[var(--dim)] hover:text-[var(--down)] hover:bg-[var(--panel2)] shrink-0"
              title="Remove parameter"
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button
          onClick={() => setRows((rs) => [...rs, { key: '', value: '' }])}
          className="w-full px-1.5 py-1 rounded border border-dashed border-[var(--border)] text-[10px] text-[var(--dim)] hover:border-[var(--amber)] hover:text-[var(--amber)] transition-colors"
        >
          <Plus size={10} className="mr-1 inline" /> Add parameter
        </button>
        {dupKeys && (
          <div className="text-[10px] text-[var(--down)]">Duplicate parameter keys.</div>
        )}
        <div className="flex gap-1 pt-1">
          <button
            onClick={() => void save(false)}
            disabled={!dirty || dupKeys || busy}
            className="flex-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[10px] font-medium uppercase tracking-wider hover:border-[var(--amber)] hover:text-[var(--amber)] transition-colors disabled:opacity-50"
          >
            <Save size={11} className="mr-1 inline" /> Save
          </button>
          {running && (
            <button
              onClick={() => void save(true)}
              disabled={!dirty || dupKeys || busy}
              className="flex-1 px-2 py-1 rounded border border-[var(--amber)] bg-[var(--amber)]/10 text-[10px] font-medium uppercase tracking-wider text-[var(--amber)] hover:bg-[var(--amber)]/20 transition-colors disabled:opacity-50"
              title="Save config and restart the bot"
            >
              <RotateCw size={11} className="mr-1 inline" /> Save &amp; Restart
            </button>
          )}
        </div>
        {!running && dirty && (
          <div className="text-[9px] text-[var(--dim)]">
            Saved config applies on next start.
          </div>
        )}
      </div>
    </div>
  )
}

export function BotsPage() {
  const bots = useBots()
  const setBots = useStore((s) => s.setBots)
  const updateBot = useStore((s) => s.updateBot)
  const addBot = useStore((s) => s.addBot)
  const removeBot = useStore((s) => s.removeBot)
  const setBotLogs = useStore((s) => s.setBotLogs)
  const pushToast = useStore((s) => s.pushToast)

  const [selectedBotId, setSelectedBotId] = useState<string | null>(null)
  const [deployOpen, setDeployOpen] = useState(false)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const selectedBot = bots.find((b) => b.bot_id === selectedBotId) ?? null
  const botLogs = useBotLogs(selectedBotId)
  const botStats = useBotStats(selectedBotId)

  const loadBots = useCallback(async () => {
    try {
      const res = await api.bots()
      setBots(res.bots)
    } catch {
      /* keep whatever we have */
    }
  }, [setBots])

  useEffect(() => {
    void loadBots()
  }, [loadBots])

  // Pull log history when a bot is selected (live logs arrive via WS)
  useEffect(() => {
    if (!selectedBotId) return
    let cancelled = false
    void api
      .botLogs(selectedBotId)
      .then((res) => {
        if (!cancelled) setBotLogs(selectedBotId, res.logs)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [selectedBotId, setBotLogs])

  const guard = (label: string) => (fn: () => Promise<void>) => async () => {
    setBusy(true)
    try {
      await fn()
    } catch (e: any) {
      pushToast('error', `${label}: ${String(e?.message ?? e).slice(0, 140)}`)
    } finally {
      setBusy(false)
    }
  }

  const onStart = guard('start')(() =>
    selectedBot
      ? api.startBot(selectedBot.bot_id).then((b) => updateBot(b))
      : Promise.resolve(),
  )
  const onStop = guard('stop')(() =>
    selectedBot
      ? api.stopBot(selectedBot.bot_id).then((b) => updateBot(b))
      : Promise.resolve(),
  )
  const onDelete = guard('delete')(() =>
    selectedBot
      ? api.deleteBot(selectedBot.bot_id).then(() => {
          removeBot(selectedBot.bot_id)
          setSelectedBotId(null)
        })
      : Promise.resolve(),
  )

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--panel)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-[var(--amber)]" />
          <span className="text-[11px] uppercase tracking-wider text-[var(--dim)]">Bots</span>
          <span className="text-[10px] text-[var(--dim)]">{bots.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void loadBots()}
            disabled={busy}
            className="p-1.5 rounded border border-[var(--border)] bg-[var(--bg)] hover:border-[var(--amber)] hover:text-[var(--amber)] transition-colors"
            title="Refresh"
          >
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setExamplesOpen(true)}
            className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[10px] font-medium uppercase tracking-wider hover:border-[var(--amber)] hover:text-[var(--amber)] transition-colors"
            title="Deploy a bundled example bot"
          >
            <Sparkles size={12} className="mr-1 inline" /> Examples
          </button>
          <button
            onClick={() => setDeployOpen(true)}
            className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[10px] font-medium uppercase tracking-wider hover:border-[var(--amber)] hover:text-[var(--amber)] transition-colors"
          >
            <Plus size={12} className="mr-1 inline" /> Deploy
          </button>
        </div>
      </div>

      {/* EXPERIMENTAL honesty banner. No bot code ever executes: the backend
          registry records deploys and flips state, the WASM runtime in
          bot-runtime/ is scaffolding. Saying so here beats you discovering it
          in an empty log pane an hour later. */}
      <div className="border-b border-[var(--border)] bg-[var(--down)]/10 px-3 py-1.5 text-[10px] text-[var(--dim)]">
        <span className="text-[var(--down)] font-semibold uppercase tracking-wider">Experimental</span>
        {' — '}bots are a registry only: deploy/state/logs persist, but no strategy executes yet.
        See <span className="font-mono">bot-runtime/README.md</span> for the (unfinished) runtime.
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex min-h-0">
        {/* Fleet list */}
        <div className="w-64 min-w-52 max-w-[300px] border-r border-[var(--border)] overflow-y-auto bg-[var(--panel2)]/50 shrink-0">
          {bots.length === 0 ? (
            <div className="p-4 text-center text-xs text-[var(--dim)]">
              No bots deployed yet.
              <br />
              <button
                onClick={() => setExamplesOpen(true)}
                className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[10px] font-medium uppercase tracking-wider hover:border-[var(--amber)] hover:text-[var(--amber)] transition-colors"
              >
                <Sparkles size={11} /> One-click examples
              </button>
              <br />
              <span className="text-[10px]">or click Deploy to add a strategy.</span>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {bots.map((bot) => (
                <button
                  key={bot.bot_id}
                  onClick={() => setSelectedBotId(bot.bot_id)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[11px] text-left hover:bg-[var(--panel)] transition-colors ${
                    selectedBotId === bot.bot_id
                      ? 'bg-[var(--panel)] border-l-2 border-l-[var(--amber)]'
                      : ''
                  }`}
                >
                  <StateBadge state={bot.state} />
                  <div className="flex-1 min-w-0 truncate">
                    <div className="font-medium truncate">{bot.name}</div>
                    <div className="text-[10px] text-[var(--dim)] truncate">{bot.bot_id}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Detail */}
        {selectedBot ? (
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 bg-[var(--panel)] shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <StateBadge state={selectedBot.state} />
                <div className="min-w-0">
                  <div className="font-medium truncate">{selectedBot.name}</div>
                  <div className="text-[10px] text-[var(--dim)]">{selectedBot.bot_id}</div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {selectedBot.state !== 'running' && selectedBot.state !== 'starting' && (
                  <button
                    onClick={onStart}
                    disabled={busy}
                    className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[10px] font-medium uppercase tracking-wider hover:border-[var(--up)] hover:text-[var(--up)] transition-colors disabled:opacity-50"
                  >
                    <Play size={12} className="mr-1 inline" /> Start
                  </button>
                )}
                {(selectedBot.state === 'running' || selectedBot.state === 'starting') && (
                  <button
                    onClick={onStop}
                    disabled={busy}
                    className="px-2 py-1 rounded border border-[var(--down)] bg-[var(--down)]/10 text-[10px] font-medium uppercase tracking-wider hover:bg-[var(--down)]/20 transition-colors disabled:opacity-50"
                  >
                    <Square size={12} className="mr-1 inline" /> Stop
                  </button>
                )}
                <button
                  onClick={onDelete}
                  disabled={busy}
                  className="p-1.5 rounded border border-[var(--border)] bg-[var(--bg)] hover:border-[var(--down)] hover:text-[var(--down)] transition-colors disabled:opacity-50"
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
                <button
                  onClick={() => setSelectedBotId(null)}
                  className="p-1.5 rounded border border-[var(--border)] bg-[var(--bg)] hover:border-[var(--dim)] transition-colors"
                  title="Close"
                >
                  <X size={13} />
                </button>
              </div>
            </div>

            <div className="flex-1 flex min-h-0 overflow-hidden">
              {/* Stats */}
              <div className="w-64 min-w-[200px] max-w-[260px] border-r border-[var(--border)] overflow-y-auto bg-[var(--panel)] p-2 shrink-0">
                <div className="text-[10px] uppercase tracking-wider text-[var(--dim)] mb-2">
                  Statistics
                </div>
                <div className="space-y-1.5 text-[11px]">
                  {STAT_ROWS.map(([label, key]) => (
                    <div key={key} className="flex justify-between text-[var(--dim)]">
                      <span>{label}</span>
                      <span className="font-mono tabular-nums">
                        {fmt((botStats as StatsRecord | undefined)?.[key])}
                        {key === 'peak_memory_mb' && botStats?.[key] != null ? ' MB' : ''}
                      </span>
                    </div>
                  ))}
                  {botStats?.last_error && (
                    <div className="text-[var(--down)] text-[10px] p-1 rounded bg-[var(--down)]/10 break-words">
                      {String(botStats.last_error)}
                    </div>
                  )}
                  {!botStats && (
                    <div className="text-[var(--dim)] text-[10px]">No stats yet.</div>
                  )}
                </div>
                <ConfigPanel bot={selectedBot} busy={busy} setBusy={setBusy} />
              </div>

              {/* Logs */}
              <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
                <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)] shrink-0">
                  <span>Logs</span>
                  <span className="text-[var(--amber)]">{botLogs.length}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px]">
                  {botLogs.length === 0 ? (
                    <div className="p-4 text-center text-[var(--dim)]">
                      No logs yet. Start the bot to see activity.
                    </div>
                  ) : (
                    [...botLogs].reverse().map((log, i) => (
                      <div
                        key={`${log.timestamp}-${i}`}
                        className="flex gap-2 px-2 py-1 border-b border-[var(--border)]/40 hover:bg-[var(--panel2)]"
                      >
                        <span className="text-[var(--dim)] w-20 shrink-0">
                          {formatTime(log.timestamp)}
                        </span>
                        <span className={`w-12 shrink-0 ${logLevelClass(log.level)}`}>
                          {log.level.toUpperCase()}
                        </span>
                        <span className="flex-1 truncate" title={log.message}>
                          {log.message}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center flex-col gap-3 text-center text-[var(--dim)] bg-[var(--panel)]">
            <FileText size={40} className="opacity-30" />
            <div className="font-medium text-[var(--text)] opacity-60">No bot selected</div>
            <div className="text-xs">Deploy a strategy or select a bot from the list</div>
          </div>
        )}
      </div>

      {deployOpen && (
        <DeployDialog
          onClose={() => setDeployOpen(false)}
          onDeployed={(info) => {
            addBot(info)
            setSelectedBotId(info.bot_id)
            setDeployOpen(false)
          }}
        />
      )}

      {examplesOpen && (
        <ExamplesDialog
          onClose={() => setExamplesOpen(false)}
          onDeployed={(info) => {
            addBot(info)
            setSelectedBotId(info.bot_id)
            setExamplesOpen(false)
          }}
        />
      )}
    </div>
  )
}

function DeployDialog({
  onClose,
  onDeployed,
}: {
  onClose: () => void
  onDeployed: (info: BotInfo) => void
}) {
  const [source, setSource] = useState('')
  const [name, setName] = useState('')
  const [risk, setRisk] = useState('moderate')
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setSource(String(reader.result ?? ''))
      if (!name) setName(file.name.replace(/\.[^/.]+$/, ''))
    }
    reader.onerror = () => setError('Could not read file')
    reader.readAsText(file)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!source.trim()) return
    setDeploying(true)
    setError(null)
    try {
      const info = await api.deployBot({ source, name: name || undefined, risk })
      onDeployed(info)
    } catch (err: any) {
      setError(String(err?.message ?? err).slice(0, 200))
    } finally {
      setDeploying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-[var(--panel)] rounded-lg border border-[var(--border)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h3 className="font-medium text-[13px]">Deploy New Bot</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--panel2)] transition-colors">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={submit} className="p-4 space-y-3">
          <div>
            <label className="block text-[11px] text-[var(--dim)] mb-1">Strategy source</label>
            <div className="flex items-center gap-2 mb-1">
              <label className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[10px] font-medium uppercase tracking-wider hover:border-[var(--amber)] hover:text-[var(--amber)] transition-colors cursor-pointer">
                <Upload size={11} className="mr-1 inline" /> Load file
                <input
                  type="file"
                  accept=".py,.js,.ts,.rs"
                  onChange={pickFile}
                  className="hidden"
                />
              </label>
              {source && (
                <button
                  type="button"
                  onClick={() => {
                    setSource('')
                  }}
                  className="text-[10px] text-[var(--dim)] hover:text-[var(--down)]"
                >
                  clear
                </button>
              )}
            </div>
            <textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="# paste strategy source (Python/JS/Rust)…"
              spellCheck={false}
              rows={8}
              className="w-full px-2 py-1.5 text-[11px] font-mono rounded border border-[var(--border)] bg-[var(--bg)] resize-y outline-none focus:border-[var(--amber)]"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-[11px] text-[var(--dim)] mb-1">Bot name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="auto from file name"
                className="w-full px-2 py-1.5 text-[11px] rounded border border-[var(--border)] bg-[var(--bg)] outline-none focus:border-[var(--amber)]"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] text-[var(--dim)] mb-1">Risk profile</label>
              <select
                value={risk}
                onChange={(e) => setRisk(e.target.value)}
                className="w-full px-2 py-1.5 text-[11px] rounded border border-[var(--border)] bg-[var(--bg)] outline-none focus:border-[var(--amber)]"
              >
                <option value="conservative">Conservative</option>
                <option value="moderate">Moderate</option>
                <option value="aggressive">Aggressive</option>
              </select>
            </div>
          </div>
          {error && (
            <div className="text-[10px] text-[var(--down)] bg-[var(--down)]/10 rounded p-2 font-mono">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-[11px] rounded border border-[var(--border)] bg-[var(--bg)] hover:border-[var(--dim)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!source.trim() || deploying}
              className="px-3 py-1.5 text-[11px] font-medium rounded bg-[var(--up)] text-black hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {deploying ? <Loader2 size={12} className="mr-1 animate-spin inline" /> : null}
              Deploy
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const EXAMPLE_RISKS: Array<[string, string]> = [
  ['conservative', 'Conservative'],
  ['moderate', 'Moderate'],
  ['aggressive', 'Aggressive'],
]

function ExamplesDialog({
  onClose,
  onDeployed,
}: {
  onClose: () => void
  onDeployed: (info: BotInfo) => void
}) {
  const pushToast = useStore((s) => s.pushToast)
  const [examples, setExamples] = useState<BotExample[] | null>(null)
  const [deployingId, setDeployingId] = useState<string | null>(null)
  const [risk, setRisk] = useState('moderate')

  useEffect(() => {
    let cancelled = false
    void api
      .botExamples()
      .then((res) => {
        if (!cancelled) setExamples(res.examples)
      })
      .catch(() => {
        if (!cancelled) setExamples([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const deploy = async (ex: BotExample) => {
    setDeployingId(ex.id)
    try {
      const info = await api.deployExample({ example_id: ex.id, risk })
      pushToast('info', `Deployed '${info.name}' — Start it when ready`)
      onDeployed(info)
    } catch (e: any) {
      pushToast('error', `deploy: ${String(e?.message ?? e).slice(0, 140)}`)
    } finally {
      setDeployingId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[var(--panel)] rounded-lg border border-[var(--border)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h3 className="flex items-center gap-1.5 font-medium text-[13px]">
            <Sparkles size={13} className="text-[var(--amber)]" /> Example strategies
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--panel2)] transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--dim)]">Risk profile</span>
            <select
              value={risk}
              onChange={(e) => setRisk(e.target.value)}
              className="flex-1 px-2 py-1 text-[11px] rounded border border-[var(--border)] bg-[var(--bg)] outline-none focus:border-[var(--amber)]"
            >
              {EXAMPLE_RISKS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>

          {examples === null ? (
            <div className="py-6 text-center text-xs text-[var(--dim)]">
              <Loader2 size={14} className="mr-1 inline animate-spin" /> Loading examples…
            </div>
          ) : examples.length === 0 ? (
            <div className="py-6 text-center text-xs text-[var(--dim)]">
              No bundled examples found in examples/bots/.
            </div>
          ) : (
            examples.map((ex) => (
              <div
                key={ex.id}
                className="flex items-center gap-3 rounded border border-[var(--border)] bg-[var(--bg)] p-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium truncate">{ex.name}</div>
                  {ex.description && (
                    <div className="text-[10px] leading-snug text-[var(--dim)]">{ex.description}</div>
                  )}
                  <div className="mt-0.5 text-[9px] uppercase tracking-wider text-[var(--dim)]">
                    {ex.language}
                  </div>
                </div>
                <button
                  onClick={() => void deploy(ex)}
                  disabled={deployingId !== null}
                  className="shrink-0 px-2.5 py-1.5 rounded bg-[var(--up)] text-[10px] font-medium uppercase tracking-wider text-black hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                >
                  {deployingId === ex.id ? (
                    <Loader2 size={11} className="mr-1 inline animate-spin" />
                  ) : (
                    <Rocket size={11} className="mr-1 inline" />
                  )}
                  Deploy
                </button>
              </div>
            ))
          )}
          <div className="text-[10px] text-[var(--dim)] pt-1 text-center">
            Deployed stopped — tune parameters in the Config panel, then Start.
          </div>
        </div>
      </div>
    </div>
  )
}
