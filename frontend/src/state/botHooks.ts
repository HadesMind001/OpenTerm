import { useStore } from './store'
import type { BotLogEntry } from './store'

/**
 * Bot state hooks - reactive reads from the Zustand store.
 * State is updated by REST actions (optimistic) and WS events (authoritative).
 */

const EMPTY_LOGS: BotLogEntry[] = []

export function useBots() {
  return useStore((s) => s.bots)
}

export function useBot(botId: string | null) {
  return useStore((s) => (botId ? s.bots.find((b) => b.bot_id === botId) : undefined))
}

export function useBotLogs(botId: string | null) {
  return useStore((s) => (botId ? s.botLogs[botId] ?? EMPTY_LOGS : EMPTY_LOGS))
}

export function useBotStats(botId: string | null) {
  return useStore((s) => (botId ? s.bots.find((b) => b.bot_id === botId)?.stats : undefined))
}
