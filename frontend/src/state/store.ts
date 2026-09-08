import { create } from 'zustand'
import { api } from '../lib/api'
import { connectWS, onFrame } from '../lib/ws'
import type {
  Frame,
  KeybindingRow,
  LayoutRow,
  QuoteState,
  Toast,
  WatchItem,
  WorkspaceRow,
} from '../lib/types'
import {
  marketState as valtioMarketState,
  applyFrame as valtioApplyFrame,
} from './marketValtio'

// Bot types
export interface BotInfo {
  bot_id: string
  name: string
  state: BotState
  started_at?: string | null
  stats?: Record<string, any>
  config?: Record<string, any>
}

export type BotState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'killed'

export interface BotLogEntry {
  timestamp: string
  level: string
  message: string
}

export interface BotExample {
  id: string
  name: string
  description: string
  language: string
  source: string
}



export type LayoutMode = 'single' | 'double' | 'quad'
// KeybindingRow/LayoutRow/WorkspaceRow live in lib/types.ts — they used to be
// declared here, in lib/types.ts AND in KeybindingsPanel.tsx, three diverging
// copies of the same four fields. One source of truth now.
export interface Pane {
  type: Page
  symbol?: string
}
export type Page =
  | 'pulse'
  | 'chart'
  | 'screen'
  | 'heatmap'
  | 'alerts'
  | 'research'
  | 'blotter'
  | 'analytics'
  | 'journal'
  | 'settings'
  | 'bots'

let toastSeq = 1

// Desktop-notification flag. Lives in the store (persisted) and is mirrored
// into this module var so desktopNotif() — called from the synchronous frame
// path — doesn't have to getState() on every fill. The StatusBar used to keep
// its OWN copy of this boolean in local component state, which reset to
// false on every remount while the module var kept saying true: a toggle in
// the UI that did nothing visible, in both directions.
let desktopNotifs = (() => {
  try {
    return localStorage.getItem('ot-desktop-notifs') === '1'
  } catch {
    return false
  }
})()

function defaultPanes(): Pane[] {
  return Array.from({ length: 4 }, () => ({ type: 'chart' as Page, symbol: '' }))
}

function loadPanes(): Pane[] {
  try {
    const raw = JSON.parse(localStorage.getItem('ot-panes') ?? 'null') as unknown
    if (Array.isArray(raw) && raw.length === 4) {
      const panes = raw.map((p, i) => {
        if (typeof p === 'string') {
          const slot = i === 0
            ? { type: 'chart' as Page, symbol: p }
            : { type: 'chart' as Page, symbol: p || '' }
          return slot
        }
        const o = (p ?? {}) as Record<string, unknown>
        return {
          type: (typeof o.type === 'string' ? o.type : 'chart') as Page,
          symbol: typeof o.symbol === 'string' ? o.symbol : '',
        }
      })
      return panes
    }
  } catch {
    /* fresh */
  }
  try {
    const old = JSON.parse(localStorage.getItem('ot-quad-slots') ?? 'null') as unknown
    if (Array.isArray(old) && old.length === 4) {
      return old.map((s) => ({ type: 'chart' as Page, symbol: typeof s === 'string' ? s : '' }))
    }
  } catch {
    /* fresh */
  }
  return defaultPanes()
}

export function savePanes(panes: Pane[]) {
  localStorage.setItem('ot-panes', JSON.stringify(panes))
}

function persistDesktopNotifs(on: boolean) {
  desktopNotifs = on
  try {
    localStorage.setItem('ot-desktop-notifs', on ? '1' : '0')
  } catch {
    /* private mode; the flag still works for this session */
  }
}

export function desktopNotif(title: string, body: string) {
  if (!desktopNotifs) return
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body })
    }
  } catch {
    /* unavailable */
  }
}

interface OTState {
  connected: boolean
  watchlist: WatchItem[]
  selected: string | null
  keybindings: KeybindingRow[]
  layouts: LayoutRow[]
  workspaces: WorkspaceRow[]
  layout: LayoutMode
  page: Page
  toasts: Toast[]
  fillTick: number
  alertTick: number
  ticketOpen: false | 'buy' | 'sell'
  panes: Pane[]
  keysOpen: boolean
  /** Alpaca paper-trading keys configured (from /api/settings availability). */
  alpacaReady: boolean
  setAlpacaReady: (ready: boolean) => void
  desktopNotifs: boolean
  setDesktopNotifs: (on: boolean) => void
  setKeybindings: (rows: KeybindingRow[]) => void
  setLayouts: (rows: LayoutRow[]) => void
  setWorkspaces: (rows: WorkspaceRow[]) => void
  reloadPrefs: () => Promise<void>
  applyWorkspace: (configJson: string) => boolean
  saveWorkspace: (name: string) => Promise<void>
  setLayout: (m: LayoutMode) => void
  setPage: (p: Page) => void
  setKeysOpen: (open: boolean) => void
  setPane: (index: number, pane: Pane) => void
  setPaneType: (index: number, type: Page) => void
  setPaneSymbol: (index: number, key: string) => void
  swapPanes: (from: number, to: number) => void
  openTicket: (side: 'buy' | 'sell') => void
  closeTicket: () => void
  pushToast: (kind: Toast['kind'], msg: string) => void
  dismissToast: (id: number) => void
  setConnected: (up: boolean) => void
  applyFrame: (f: Frame) => void
  loadWatchlist: () => Promise<void>
  addSymbol: (query: string) => Promise<string | null>
  removeSymbol: (key: string) => Promise<void>
  select: (key: string | null) => void
  // Bot state
  bots: BotInfo[]
  botLogs: Record<string, BotLogEntry[]>
  selectedBot: string | null
  setBots: (bots: BotInfo[]) => void
  addBot: (bot: BotInfo) => void
  updateBot: (bot: BotInfo) => void
  removeBot: (bot_id: string) => void
  setSelectedBot: (bot_id: string | null) => void
  addBotLog: (bot_id: string, log: BotLogEntry) => void
  setBotLogs: (bot_id: string, logs: BotLogEntry[]) => void
  clearBotLogs: (bot_id: string) => void
}

export const useStore = create<OTState>((set, get) => ({
  connected: false,
  watchlist: [],
  selected: null,
  keybindings: [],
  layouts: [],
  workspaces: [],
  layout: 'single',
  page: 'pulse',
  toasts: [],
  fillTick: 0,
  alertTick: 0,
  ticketOpen: false,
  panes: loadPanes(),
  keysOpen: false,
  alpacaReady: false,
  setAlpacaReady: (ready) => set({ alpacaReady: ready }),
  desktopNotifs,
  setDesktopNotifs: (on) => {
    persistDesktopNotifs(on)
    set({ desktopNotifs: on })
  },
  setKeybindings: (rows) => set({ keybindings: rows }),
  setLayouts: (rows) => set({ layouts: rows }),
  setWorkspaces: (rows) => set({ workspaces: rows }),
  reloadPrefs: async () => {
    // The Settings page used to fire these three GETs and void()-discard the
    // results, so the store arrays stayed [] and every panel that reads them
    // looked empty forever. Now the loader actually loads.
    const [k, l, w] = await Promise.all([
      api.keybindings().catch(() => [] as KeybindingRow[]),
      api.layouts().catch(() => [] as LayoutRow[]),
      api.workspaces().catch(() => [] as WorkspaceRow[]),
    ])
    set({ keybindings: k, layouts: l, workspaces: w })
  },
  applyWorkspace: (configJson) => {
    try {
      const cfg = JSON.parse(configJson) as {
        page?: Page
        layout?: LayoutMode
        panes?: Pane[]
      }
      if (cfg.layout) set({ layout: cfg.layout })
      if (cfg.page) set({ page: cfg.page })
      if (Array.isArray(cfg.panes) && cfg.panes.length === 4) {
        const panes = cfg.panes.map((pt) => ({
          type: typeof pt?.type === 'string' ? pt.type : ('chart' as Page),
          symbol: typeof pt?.symbol === 'string' ? pt.symbol : '',
        }))
        savePanes(panes)
        set({ panes })
      }
      return true
    } catch {
      return false
    }
  },
  saveWorkspace: async (name) => {
    const { page, layout, panes } = get()
    await api.addWorkspace({
      name,
      config: JSON.stringify({ page, layout, panes }),
    })
    await get().reloadPrefs()
  },
  // Bot state
  bots: [],
  botLogs: {},
  selectedBot: null,

  setLayout: (m) => set({ layout: m }),
  setPage: (p) => set({ page: p }),
  setKeysOpen: (open) => set({ keysOpen: open }),
  setPane: (index, pane) => {
    if (index < 0 || index > 3) return
    const panes = [...get().panes]
    panes[index] = pane
    savePanes(panes)
    set({ panes })
  },
  setPaneType: (index, type) => {
    if (index < 0 || index > 3) return
    const panes = [...get().panes]
    panes[index] = { type, symbol: panes[index]?.symbol ?? '' }
    savePanes(panes)
    set({ panes })
  },
  setPaneSymbol: (index, key) => {
    if (index < 0 || index > 3) return
    const panes = [...get().panes]
    panes[index] = { type: panes[index]?.type ?? 'chart', symbol: key }
    savePanes(panes)
    set({ panes })
  },
  swapPanes: (from, to) => {
    if (from === to || from < 0 || from > 3 || to < 0 || to > 3) return
    const panes = [...get().panes]
    ;[panes[from], panes[to]] = [panes[to], panes[from]]
    savePanes(panes)
    set({ panes })
  },
  openTicket: (side) => set({ ticketOpen: side }),
  closeTicket: () => set({ ticketOpen: false }),
  // (removeKeybinding/optimistic delete was removed: KeybindingsPanel awaits
  // the API and reloads. A store mutation the server can veto is a lie.)
  pushToast: (kind, msg) => {
    const t: Toast = { id: toastSeq++, kind, msg }
    set({ toasts: [...get().toasts.slice(-4), t] })
    window.setTimeout(() => get().dismissToast(t.id), 6000)
    return t.id
  },
  dismissToast: (id) =>
    set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  setConnected: (up) => {
    set({ connected: up })
    valtioMarketState.connected = up
  },

  // Bot actions
  setBots: (bots: BotInfo[]) => set({ bots }),
  addBot: (bot: BotInfo) => set((state) => ({ 
    bots: [...state.bots.filter(b => b.bot_id !== bot.bot_id), bot] 
  })),
  updateBot: (bot: BotInfo) => set((state) => ({ 
    bots: state.bots.map(b => b.bot_id === bot.bot_id ? bot : b) 
  })),
  removeBot: (bot_id: string) => set((state) => ({ 
    bots: state.bots.filter(b => b.bot_id !== bot_id) 
  })),
  setSelectedBot: (bot_id: string | null) => set({ selectedBot: bot_id }),
  addBotLog: (bot_id: string, log: BotLogEntry) => set((state) => ({
    botLogs: {
      ...state.botLogs,
      [bot_id]: [...(state.botLogs[bot_id] || []), log].slice(-500)
    }
  })),
  setBotLogs: (bot_id: string, logs: BotLogEntry[]) =>
    set((state) => ({ botLogs: { ...state.botLogs, [bot_id]: logs.slice(-500) } })),
  clearBotLogs: (bot_id: string) => set((state) => {
    const { [bot_id]: _, ...rest } = state.botLogs
    return { botLogs: rest }
  }),

  applyFrame: (f) => {
    // Paper fills and alert fires drive the auto-refresh ticks + toasts here
    // (NOT in marketValtio: that module must not import this one — circular).
    // These effects previously existed in every consumer page but nothing
    // ever incremented the ticks, so blotters/positions/alerts only refreshed
    // on mount. "fills toast live" was a README promise, not code.
    if (f.t === 'e' && f.topic?.startsWith('fill:')) {
      const d = (f.data ?? {}) as Record<string, any>
      const sym = String(d.symbol_key ?? f.topic.slice(5)).split(':').pop() ?? ''
      const px = typeof d.price === 'number' ? d.price.toFixed(2) : '?'
      const qty = typeof d.qty === 'number' ? d.qty : '?'
      get().pushToast('fill', `${String(d.side ?? '').toUpperCase()} ${qty} ${sym} @ ${px}`)
      desktopNotif('OpenTerm fill', `${d.side} ${qty} ${sym} @ ${px}`)
      set({ fillTick: get().fillTick + 1 })
      return
    }
    if (f.t === 'e' && f.topic?.startsWith('alert:')) {
      const d = (f.data ?? {}) as Record<string, any>
      if (d.message) {
        get().pushToast('info', String(d.message))
        desktopNotif('OpenTerm alert', String(d.message))
      }
      set({ alertTick: get().alertTick + 1 })
      return
    }
    if (f.t === 'e' && f.topic?.startsWith('bot.')) {
      const evt = (f.data ?? {}) as { event?: string; data?: Record<string, any> }
      const payload = evt.data ?? {}
      const botId = payload.bot_id as string | undefined
      if (!botId) return
      switch (evt.event) {
        case 'BotDeployed':
          set((state) => ({
            bots: [
              ...state.bots.filter((b) => b.bot_id !== botId),
              { bot_id: botId, name: (payload.name as string) ?? botId, state: 'stopped' as const },
            ],
          }))
          break
        case 'BotStarted':
          set((state) => ({
            bots: state.bots.map((b) => (b.bot_id === botId ? { ...b, state: 'running' as const } : b)),
          }))
          break
        case 'BotStopped':
          set((state) => ({
            bots: state.bots.map((b) => (b.bot_id === botId ? { ...b, state: 'stopped' as const } : b)),
          }))
          break
        case 'BotError':
          set((state) => ({
            bots: state.bots.map((b) =>
              b.bot_id === botId ? { ...b, state: 'error' as const } : b,
            ),
          }))
          break
        case 'BotKilled':
          set((state) => ({
            bots: state.bots.map((b) =>
              b.bot_id === botId ? { ...b, state: 'killed' as const } : b,
            ),
          }))
          break
        case 'ConfigChanged':
          set((state) => ({
            bots: state.bots.map((b) =>
              b.bot_id === botId ? { ...b, config: payload.config as Record<string, any> } : b,
            ),
          }))
          break
        case 'LogEntry': {
          const entry = payload.entry as BotLogEntry | undefined
          if (entry) get().addBotLog(botId, entry)
          break
        }
        case 'Heartbeat':
          set((state) => ({
            bots: state.bots.map((b) =>
              b.bot_id === botId ? { ...b, stats: payload.stats as Record<string, any> } : b,
            ),
          }))
          break
      }
      return
    }
    valtioApplyFrame(f)
  },

  loadWatchlist: async () => {
    const items = await api.watchlist()
    for (const it of items) {
      if (it.state && Object.keys(it.state).length) {
        const state = it.state as Record<string, any>
        // Per-key mutation, NOT container replacement: `marketState.quotes = {...}`
        // would orphan the nested proxy that subscribeQuotes listens to and
        // every quote hook would freeze on stale data. (This used to do
        // exactly that. valtio does not warn. History repeats; the comment
        // is the warning.)
        valtioMarketState.quotes[it.symbol_key] = {
          ...valtioMarketState.quotes[it.symbol_key],
          ...state,
          dir: 0,
          updated: state.updated ? String(state.updated) : null,
        } as QuoteState
      }
    }
    set({ watchlist: items })
  },

  addSymbol: async (query) => {
    try {
      const res = await api.add(query)
      await get().loadWatchlist()
      set({ selected: res.symbol_key })
      return res.symbol_key
    } catch {
      return null
    }
  },

  removeSymbol: async (key) => {
    await api.remove(key)
    const { watchlist, selected } = get()
    if (selected === key) set({ selected: null })
    set({ watchlist: watchlist.filter((w) => w.symbol_key !== key) })
  },

  select: (key) => set({ selected: key }),
}))

let unsubFrame: (() => void) | null = null

export function bootstrapStore() {
  const st = useStore.getState()
  if (unsubFrame) unsubFrame()
  unsubFrame = onFrame((f) => useStore.getState().applyFrame(f))
  void st.loadWatchlist()
  // Detect Alpaca key availability once at boot for the ticket venue toggle.
  void api
    .settings()
    .then((info) => useStore.getState().setAlpacaReady(!!info.available?.alpaca))
    .catch(() => undefined)
  return connectWS((up) => useStore.getState().setConnected(up))
}