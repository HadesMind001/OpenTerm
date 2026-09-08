import type { BotInfo, BotLogEntry, BotExample } from '../state/store'
import type {
  AlertFire,
  AlertRule,
  Analytics,
  Bar,
  CalendarInfo,
  DesInfo,
  Drawing,
  FillRow,
  JournalEntry,
  MacroInfo,
  NewsRow,
  Order,
  Portfolio,
  ResolveResult,
  SettingsInfo,
  WatchItem,
} from './types'
import type { CorrResult, UniverseRow } from './types'
import type { KeybindingRow, LayoutRow, WorkspaceRow, ScriptResult } from './types'

async function j<T>(res: Response): Promise<T> {
  // Throws with the raw body text — server errors are sanitized one-liners
  // precisely so they are safe to toast (see routes.py _redact).
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

// `?name=${name}` with name undefined literally sent "name=undefined" to the
// backend, which dutifully filtered for a row named "undefined" and returned
// []. Optionals must be encoded optionals.
function nameQuery(name?: string): string {
  return name ? `?name=${encodeURIComponent(name)}` : ''
}

export const api = {
  /** Free-text symbol lookup (aliases, "TSLA US"). The ONE deliberately
   * non-throwing wrapper: it feeds keystroke hints, where "unknown" is an
   * answer, not an error. Do not swap in j(). */
  async resolve(q: string): Promise<ResolveResult | null> {
    try {
      const r = await fetch(`/api/symbols/resolve?q=${encodeURIComponent(q)}`)
      if (!r.ok) return null
      return (await r.json()) as ResolveResult
    } catch {
      return null
    }
  },
  watchlist: (): Promise<WatchItem[]> =>
    fetch('/api/watchlist').then((r) => j<WatchItem[]>(r)),
  /** POST body is {query} (WatchlistAdd) — alias/suffix normalization is the
   * server's job; the client parser is advisory only. */
  add(query: string): Promise<{ symbol_key: string }> {
    return fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }).then((r) => j(r))
  },
  remove(key: string): Promise<{ removed: boolean }> {
    return fetch(`/api/watchlist/${key}`, { method: 'DELETE' }).then((r) => j(r))
  },
  /** Bars are epoch-SECONDS (feeds UTCTimestamp). A ms slip here does not
   * throw — the chart just silently squashes the whole series to 1970. */
  bars(key: string, interval: string, limit = 300): Promise<Bar[]> {
    return fetch(`/api/bars/${key}?interval=${interval}&limit=${limit}`).then(
      (r) => j<Bar[]>(r),
    )
  },
  news(symbolKey?: string): Promise<NewsRow[]> {
    const p = symbolKey ? `?symbol_key=${encodeURIComponent(symbolKey)}` : ''
    return fetch(`/api/news${p}`).then((r) => j<NewsRow[]>(r))
  },
  /** Each row is {id, kind, payload} where payload embeds p1/p2 (+ optional
   * nested `payload`) — a DB column stored as a JSON string, hence the
   * payload.payload double-nesting callers must unwrap. See DrawingLayer. */
  drawings(symbolKey: string): Promise<Drawing[]> {
    return fetch(
      `/api/drawings?symbol_key=${encodeURIComponent(symbolKey)}`,
    ).then((r) => j<Drawing[]>(r))
  },
  /** Body mirrors DrawingAdd {symbol_key, kind, payload}; `payload` is
   * json.dumps'd verbatim server-side — inner shape is the client's only
   * contract, so a malformed p1 renders invisibly, it does not 400. */
  addDrawing(
    symbolKey: string,
    kind: Drawing['kind'],
    payload: Record<string, unknown>,
  ): Promise<{ id: number }> {
    return fetch('/api/drawings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol_key: symbolKey, kind, payload }),
    }).then((r) => j(r))
  },
  removeDrawing(id: number): Promise<{ removed: boolean }> {
    return fetch(`/api/drawings/${id}`, { method: 'DELETE' }).then((r) => j(r))
  },
  submitOrder(body: {
    symbol_key: string
    side: string
    type: string
    qty: number
    limit_price?: number | null
    stop_price?: number | null
    venue?: string
  }): Promise<Order> {
    return fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j<Order>(r))
  },
  orders(status?: string): Promise<Order[]> {
    const p = status ? `?status=${status}` : ''
    return fetch(`/api/orders${p}`).then((r) => j<Order[]>(r))
  },
  cancelOrder(id: number): Promise<{ canceled: boolean }> {
    return fetch(`/api/orders/${id}`, { method: 'DELETE' }).then((r) => j(r))
  },
  amendOrder(
    id: number,
    body: { qty?: number; limit_price?: number },
  ): Promise<Order> {
    return fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j(r))
  },
  portfolio: (): Promise<Portfolio> =>
    fetch('/api/portfolio').then((r) => j<Portfolio>(r)),
  fills(limit = 200): Promise<FillRow[]> {
    return fetch(`/api/fills?limit=${limit}`).then((r) => j<FillRow[]>(r))
  },
  analytics: (): Promise<Analytics> =>
    fetch('/api/analytics').then((r) => j<Analytics>(r)),
  addCash(amount: number): Promise<Portfolio> {
    return fetch('/api/cash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    }).then((r) => j(r))
  },
  journal(): Promise<JournalEntry[]> {
    return fetch('/api/journal').then((r) => j<JournalEntry[]>(r))
  },
  addJournal(symbolKey: string, text: string, tags: string): Promise<{ id: number }> {
    return fetch('/api/journal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol_key: symbolKey, text, tags }),
    }).then((r) => j(r))
  },
  removeJournal(id: number): Promise<{ removed: boolean }> {
    return fetch(`/api/journal/${id}`, { method: 'DELETE' }).then((r) => j(r))
  },
  universe: (): Promise<UniverseRow[]> =>
    fetch('/api/universe').then((r) => j<UniverseRow[]>(r)),
  correlation(
    symbols: string[],
    interval: string,
    lookback = 60,
  ): Promise<CorrResult> {
    const p = new URLSearchParams({
      symbols: symbols.join(','),
      interval,
      lookback: String(lookback),
    })
    return fetch(`/api/correlation?${p}`).then((r) => j<CorrResult>(r))
  },
  alerts(): Promise<AlertRule[]> {
    return fetch('/api/alerts').then((r) => j<AlertRule[]>(r))
  },
  /** kind ∈ server KINDS, LOWERCASE (above|below|pct_up|pct_dn|rsi_above|
   * rsi_below|vol_spike|trailing_stop|time_above|time_below) — AlertCreate
   * only type-checks str, the enum lives in the engine, so an uppercase
   * "ABOVE" sails past pydantic and dies at the engine, which the route
   * converts to a 400 carrying "unknown alert kind". */
  addAlert(body: {
    symbol_key: string
    kind: string
    threshold: number
    one_shot?: boolean
    cooldown?: number
    note?: string
  }): Promise<AlertRule> {
    return fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j(r))
  },
  removeAlert(id: number): Promise<{ removed: boolean }> {
    return fetch(`/api/alerts/${id}`, { method: 'DELETE' }).then((r) => j(r))
  },
  /** seconds is validated server-side by pydantic (ge=1, le=86400) — an
   * out-of-range snooze 422s, it does not clamp. */
  snoozeAlert(id: number, seconds: number): Promise<{ snoozed: boolean }> {
    return fetch(`/api/alerts/${id}/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds }),
    }).then((r) => j(r))
  },
  toggleAlert(id: number, active: boolean): Promise<{ toggled: boolean }> {
    return fetch(`/api/alerts/${id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    }).then((r) => j(r))
  },
  alertFires(limit = 100): Promise<AlertFire[]> {
    return fetch(`/api/alerts/fires?limit=${limit}`).then((r) =>
      j<AlertFire[]>(r),
    )
  },
  des(symbolKey: string): Promise<DesInfo> {
    return fetch(`/api/des/${symbolKey}`).then((r) => j<DesInfo>(r))
  },
  settings: (): Promise<SettingsInfo> =>
    fetch('/api/settings').then((r) => j<SettingsInfo>(r)),
  /** KeysUpdate semantics: omitted field = leave stored, "" = delete, value
   * = write. The response only ever carries counts + availability booleans;
   * a saved secret can never be read back through this API. See KeysModal. */
  saveKeys(body: {
    finnhub_key?: string
    fred_key?: string
    polygon_key?: string
    oanda_token?: string
    oanda_account?: string
    alpaca_key_id?: string
    alpaca_secret_key?: string
  }): Promise<{ saved: string[]; available: Record<string, boolean> }> {
    return fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j(r))
  },
  testKey(
    provider: string,
    body: { key?: string; oanda_account?: string; secret?: string } = {},
  ): Promise<{ ok: boolean; provider: string; error?: string }> {
    return fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, ...body }),
    }).then((r) => j(r))
  },
  calendar(days = 14): Promise<CalendarInfo> {
    return fetch(`/api/calendar?days=${days}`).then((r) => j<CalendarInfo>(r))
  },
  macro: (): Promise<MacroInfo> =>
    fetch('/api/macro').then((r) => j<MacroInfo>(r)),
  keybindings(name?: string): Promise<KeybindingRow[]> {
    return fetch(`/api/keybindings${nameQuery(name)}`).then((r) => j<KeybindingRow[]>(r))
  },

  // ── prefs CRUD (keybindings / layouts / workspaces) ──
  // `bindings`/`config` are stored and echoed back VERBATIM strings; the
  // server never parses them. All JSON validity is client-side — a corrupt
  // workspace saves happily and only explodes at applyWorkspace() parse time.
  addKeybinding(body: { name: string; bindings: string }): Promise<KeybindingRow> {
    return fetch('/api/keybindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j(r))
  },

  updateKeybinding(id: number, body: { name: string; bindings: string }): Promise<KeybindingRow> {
    return fetch(`/api/keybindings/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j(r))
  },

  removeKeybinding(id: number): Promise<{ removed: boolean }> {
    return fetch(`/api/keybindings/${id}`, { method: 'DELETE' }).then((r) => j(r))
  },

  layouts(name?: string): Promise<LayoutRow[]> {
    return fetch(`/api/layouts${nameQuery(name)}`).then((r) => j<LayoutRow[]>(r))
  },

  addLayout(body: { name: string; config: string }): Promise<LayoutRow> {
    return fetch('/api/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j(r))
  },

  updateLayout(id: number, body: { name: string; config: string }): Promise<LayoutRow> {
    return fetch(`/api/layouts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j(r))
  },

  removeLayout(id: number): Promise<{ removed: boolean }> {
    return fetch(`/api/layouts/${id}`, { method: 'DELETE' }).then((r) => j(r))
  },

  workspaces(name?: string): Promise<WorkspaceRow[]> {
    return fetch(`/api/workspaces${nameQuery(name)}`).then((r) => j<WorkspaceRow[]>(r))
  },

  addWorkspace(body: { name: string; config: string }): Promise<WorkspaceRow> {
    return fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j(r))
  },

  removeWorkspace(id: number): Promise<{ removed: boolean }> {
    return fetch(`/api/workspaces/${id}`, { method: 'DELETE' }).then((r) => j(r))
  },

  runScript(code: string): Promise<ScriptResult> {
    // JSON body, not a query string: multi-KB scripts in a URL would die at
    // some arbitrary header-size limit far below the backend's 200 KB cap,
    // and the "symbols" parameter never fed any data to the script anyway
    // (the backend feature was vaporware; it is gone).
    return fetch('/api/scripts/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }).then((r) => j<ScriptResult>(r))
  },

  async post(url: string, body: unknown): Promise<unknown> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    return res.json()
  },

  // ── bots ────────────────────────────────────────────────────────────
  bots: (): Promise<{ bots: BotInfo[] }> =>
    fetch('/api/bots').then((r) => j<{ bots: BotInfo[] }>(r)),
  deployBot(body: { source: string; name?: string; risk?: string }): Promise<BotInfo> {
    return fetch('/api/bots/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j<BotInfo>(r))
  },
  botExamples: (): Promise<{ examples: BotExample[] }> =>
    fetch('/api/bots/examples').then((r) => j<{ examples: BotExample[] }>(r)),
  deployExample(body: { example_id: string; risk?: string }): Promise<BotInfo> {
    return fetch('/api/bots/deploy-example', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j<BotInfo>(r))
  },
  startBot(botId: string): Promise<BotInfo> {
    return fetch(`/api/bots/${encodeURIComponent(botId)}/start`, { method: 'POST' }).then((r) =>
      j<BotInfo>(r),
    )
  },
  stopBot(botId: string): Promise<BotInfo> {
    return fetch(`/api/bots/${encodeURIComponent(botId)}/stop`, { method: 'POST' }).then((r) =>
      j<BotInfo>(r),
    )
  },
  restartBot(botId: string): Promise<BotInfo> {
    return fetch(`/api/bots/${encodeURIComponent(botId)}/restart`, { method: 'POST' }).then((r) =>
      j<BotInfo>(r),
    )
  },
  deleteBot(botId: string): Promise<{ status: string; bot_id: string }> {
    return fetch(`/api/bots/${encodeURIComponent(botId)}`, { method: 'DELETE' }).then((r) => j(r))
  },
  updateBotConfig(botId: string, config: Record<string, unknown>): Promise<{ status: string; bot_id: string }> {
    return fetch(`/api/bots/${encodeURIComponent(botId)}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    }).then((r) => j<{ status: string; bot_id: string }>(r))
  },
  botLogs(botId: string): Promise<{ logs: BotLogEntry[] }> {
    return fetch(`/api/bots/${encodeURIComponent(botId)}/logs`).then((r) =>
      j<{ logs: BotLogEntry[] }>(r),
    )
  },
}
