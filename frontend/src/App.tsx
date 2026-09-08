import { useEffect } from 'react'
import { CommandBar } from './components/CommandBar'
import { DepthPanel } from './components/DepthPanel'
import { NewsRail } from './components/NewsRail'
import { PositionsRail } from './components/PositionsRail'
import { StatusBar } from './components/StatusBar'
import { TapePanel } from './components/TapePanel'
import { KeysModal } from './components/KeysModal'
import { TicketModal } from './components/TicketModal'
import { WatchlistPanel } from './components/WatchlistPanel'
import { WorkspaceArea } from './components/WorkspaceArea'
import { SettingsPage } from './components/pages/SettingsPage'
import { bootstrapStore, useStore } from './state/store'

export default function App() {
  const connected = useStore((s) => s.connected)
  const page = useStore((s) => s.page)
  const toasts = useStore((s) => s.toasts)
  const dismissToast = useStore((s) => s.dismissToast)

  useEffect(() => {
    const disconnect = bootstrapStore()
    return () => disconnect()
  }, [])

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] overflow-hidden">
      <CommandBar />
      <div className="grid min-h-0 grid-cols-[300px_1fr_300px]">
        <WatchlistPanel />
        <WorkspaceArea />
        <div className="flex min-h-0 flex-col border-l border-[var(--border)] bg-[var(--panel)]">
          <PositionsRail />
          <DepthPanel />
          <TapePanel />
          <NewsRail />
        </div>
      </div>
      <StatusBar />
      <TicketModal />
      <KeysModal />
      <SettingsPage isActive={page === "settings"} />
      <div className="pointer-events-none fixed bottom-10 right-4 z-[60] space-y-1.5">
        {toasts.map((t) => (
          <div
            key={t.id}
            onClick={() => dismissToast(t.id)}
            className={`pointer-events-auto cursor-pointer rounded border px-3 py-2 text-xs shadow-lg ${
              t.kind === 'fill'
                ? 'border-[var(--up)] bg-[var(--panel)] text-[var(--up)]'
                : t.kind === 'error'
                  ? 'border-[var(--down)] bg-[var(--panel)] text-[var(--down)]'
                  : 'border-[var(--amber)] bg-[var(--panel)] text-[var(--amber)]'
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
      {!connected && (
        <div className="pointer-events-none fixed bottom-8 left-1/2 -translate-x-1/2 rounded border border-[var(--down)] bg-[var(--panel)] px-4 py-1.5 text-xs text-[var(--down)] shadow-lg">
          stream disconnected — reconnecting…
        </div>
      )}
    </div>
  )
}
