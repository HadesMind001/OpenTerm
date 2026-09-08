import { useEffect, useState } from 'react'
import { Settings } from 'lucide-react'
import { api } from '../../lib/api'
import { useStore } from '../../state/store'
import { KeybindingsPanel } from '../../components/KeybindingsPanel'
import { ScriptsConsole } from '../../components/ScriptsConsole'

interface SettingsPageProps {
  isActive?: boolean
}

export function SettingsPage({ isActive = true }: SettingsPageProps) {
  const workspaces = useStore((s) => s.workspaces)
  const pushToast = useStore((s) => s.pushToast)
  const reloadPrefs = useStore((s) => s.reloadPrefs)
  const applyWorkspace = useStore((s) => s.applyWorkspace)
  const saveWorkspace = useStore((s) => s.saveWorkspace)
  const [activeTab, setActiveTab] = useState<'keybindings' | 'workspaces' | 'scripts'>('keybindings')
  const [newWsName, setNewWsName] = useState('')

  // Load data on mount. The old code called the three APIs and threw the
  // results away — the store arrays stayed empty and every panel that reads
  // them looked like a broken feature. reloadPrefs() is the whole point.
  useEffect(() => {
    void reloadPrefs()
  }, [reloadPrefs])

  const handleTab = (tab: typeof activeTab) => setActiveTab(tab)

  if (!isActive) return null

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--panel)]">
      <div className="flex h-14 items-center border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-wider text-[var(--dim)]">
        <Settings size={13} /> Settings
        <span className="ml-auto text-sm font-medium text-[var(--text)]">
          OpenTerm
        </span>
      </div>

      <div className="flex border-b border-[var(--border)] bg-[var(--panel2)]">
        <button
          onClick={() => handleTab('keybindings')}
          className={activeTab === 'keybindings'
            ? 'flex-1 rounded-t-md border-b-2 border-[var(--amber)] bg-[var(--panel)] text-[var(--amber)]'
            : 'flex-1 rounded-t-md hover:bg-[var(--panel)] text-[var(--dim)]'}
        >
          Keybindings
        </button>
        <button
          onClick={() => handleTab('workspaces')}
          className={activeTab === 'workspaces'
            ? 'flex-1 rounded-t-md border-b-2 border-[var(--amber)] bg-[var(--panel)] text-[var(--amber)]'
            : 'flex-1 rounded-t-md hover:bg-[var(--panel)] text-[var(--dim)]'}
        >
          Workspaces
        </button>
        <button
          onClick={() => handleTab('scripts')}
          className={activeTab === 'scripts'
            ? 'flex-1 rounded-t-md border-b-2 border-[var(--amber)] bg-[var(--panel)] text-[var(--amber)]'
            : 'flex-1 rounded-t-md hover:bg-[var(--panel)] text-[var(--dim)]'}
        >
          Scripts
        </button>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col">
        <div style={{ display: activeTab === 'keybindings' ? 'flex' : 'none' }}>
          <KeybindingsPanel />
        </div>
        <div style={{ display: activeTab === 'workspaces' ? 'flex' : 'none' }} className="p-4 flex flex-col">
          <h2 className="text-xs uppercase tracking-wider text-[var(--dim)] mb-3">Workspaces</h2>
          {workspaces.length === 0 && (
            <div className="text-sm text-[var(--dim)]">
              No workspaces saved yet. Snapshot the current page/layout/panes below.
            </div>
          )}
          <div className="mb-4 flex gap-2">
            <input
              value={newWsName}
              onChange={(e) => setNewWsName(e.target.value)}
              placeholder="name current layout…"
              className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs outline-none"
            />
            <button
              onClick={async () => {
                const name = newWsName.trim()
                if (!name) {
                  pushToast('error', 'give the workspace a name first')
                  return
                }
                try {
                  await saveWorkspace(name)
                  setNewWsName('')
                  pushToast('info', `workspace "${name}" saved`)
                } catch (e) {
                  pushToast('error', e instanceof Error ? e.message : 'save failed')
                }
              }}
              className="rounded bg-[var(--amber)] px-3 py-1 text-xs font-medium text-black hover:opacity-90"
            >
              Save current
            </button>
          </div>
          <div className="space-y-2">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className="rounded border border-[var(--border)] bg-[var(--panel)] p-3"
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="font-medium truncate">{ws.name}</span>
                  <button
                    onClick={() => {
                      // Actually apply the stored {page, layout, panes}; the
                      // old button called the keybindings endpoint (wrong API)
                      // and toasted "loaded" without loading anything.
                      if (applyWorkspace(ws.config)) {
                        pushToast('info', `workspace "${ws.name}" applied`)
                      } else {
                        pushToast('error', `workspace "${ws.name}" is corrupt`)
                      }
                    }}
                    className="text-[var(--dim)] hover:text-[var(--text)] text-xs"
                  >
                    ▶
                  </button>
                </div>
                <div className="text-xs text-[var(--dim)] whitespace-break-all">
                  {ws.config.slice(0, 100)}{ws.config.length > 100 && '…'}
                </div>
                <button
                  onClick={async () => {
                    try {
                      await api.removeWorkspace(ws.id)
                      await reloadPrefs()
                      pushToast('info', `workspace "${ws.name}" deleted`)
                    } catch (e) {
                      pushToast('error', e instanceof Error ? e.message : 'delete failed')
                    }
                  }}
                  className="mt-1 text-[10px] uppercase tracking-wider text-[var(--dim)] hover:text-[var(--down)]"
                >
                  delete
                </button>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: activeTab === 'scripts' ? 'flex' : 'none' }}>
          <ScriptsConsole />
        </div>
      </div>
    </div>
  )
}