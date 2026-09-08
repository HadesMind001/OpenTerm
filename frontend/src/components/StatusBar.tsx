import { useEffect, useState } from 'react'
import { Bell, BellOff, Settings } from 'lucide-react'
import { useStore } from '../state/store'
import { useStatuses } from '../state/hooks'

export function StatusBar() {
  const statuses = useStatuses()
  const connected = useStore((s) => s.connected)
  const setKeysOpen = useStore((s) => s.setKeysOpen)
  const desktopNotifs = useStore((s) => s.desktopNotifs)
  const setDesktopNotifs = useStore((s) => s.setDesktopNotifs)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const toggleBell = async () => {
    if (!desktopNotifs && typeof Notification !== 'undefined') {
      if (Notification.permission !== 'granted') {
        try {
          await Notification.requestPermission()
        } catch {
          /* denied */
        }
      }
    }
    // Single source of truth in the zustand store (persisted). The old local
    // `bell` state reset on every remount while the module flag stayed set —
    // the icon and reality disagreed.
    setDesktopNotifs(!desktopNotifs)
  }

  return (
    <div className="flex items-center gap-4 border-t border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-[11px] text-[var(--dim)]">
      <span className={connected ? 'text-[var(--up)]' : 'text-[var(--down)]'}>
        ● {connected ? 'LIVE' : 'OFFLINE'}
      </span>
      {Object.entries(statuses).map(([name, up]) => (
        <span key={name} className="flex items-center gap-1">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              up ? 'bg-[var(--up)]' : 'bg-[var(--down)]'
            }`}
          />
          {name}
        </span>
      ))}
      <button
        onClick={() => void toggleBell()}
        title="desktop notifications"
        className={desktopNotifs ? 'text-[var(--amber)]' : 'hover:text-[var(--text)]'}
      >
        {desktopNotifs ? <Bell size={12} /> : <BellOff size={12} />}
      </button>
      <button
        onClick={() => setKeysOpen(true)}
        title="settings — API keys & providers"
        className="hover:text-[var(--amber)]"
      >
        <Settings size={12} />
      </button>
      <span className="ml-auto tabular-nums">{now.toISOString().slice(11, 19)} UTC</span>
    </div>
  )
}
